import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// db/index.ts with `pg` faked (no connection is ever opened): the pool configuration that depends on the environment (SSL only in production; 5 connections
// and no idle timeout on Vercel's serverless runtime, 10 and 30 s locally), the thin query helpers, and transaction(), whose contract is BEGIN, then COMMIT, or
// ROLLBACK and re-throw on any failure, and the client is ALWAYS released. The module reads the environment at import time, so each test imports a fresh copy.
const pg = vi.hoisted(() => ({
  poolOptions: [] as Array<Record<string, unknown>>,
  pools: [] as Array<{ query: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }>,
  log: [] as string[],
  client: { query: vi.fn(), release: vi.fn() },
}));
vi.mock('pg', () => {
  class Pool {
    query = vi.fn(); connect = vi.fn(); on = vi.fn();
    constructor(o: Record<string, unknown>) { pg.poolOptions.push(o); pg.pools.push(this); }
  }
  return { default: { Pool }, Pool };
});

type Db = typeof import('./index.js');
async function load(env: Record<string, string | undefined> = {}): Promise<Db> {
  vi.resetModules();
  pg.poolOptions.length = 0; pg.pools.length = 0;
  // stubEnv remembers the original value, so unstubAllEnvs restores it even for a variable deleted here.
  const set = (k: string, v: string | undefined) => { vi.stubEnv(k, v ?? 'placeholder'); if (v === undefined) delete process.env[k]; };
  set('NODE_ENV', env.NODE_ENV ?? 'test');
  set('VERCEL', env.VERCEL);
  set('DATABASE_URL', env.DATABASE_URL);
  return import('./index.js');
}

beforeEach(() => {
  pg.log.length = 0;
  pg.client.query.mockReset().mockImplementation(async (sql: string) => { pg.log.push(sql); return { rows: [] }; });
  pg.client.release.mockReset().mockImplementation(() => { pg.log.push('RELEASE'); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('pool configuration', () => {
  it('local development: the connection string from DATABASE_URL, no SSL, 10 connections, 30 s idle timeout, 5 s connect timeout', async () => {
    await load({ DATABASE_URL: 'postgres://synthetic.invalid/db' });
    expect(pg.poolOptions).toEqual([{
      connectionString: 'postgres://synthetic.invalid/db', ssl: false, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
    }]);
  });

  it('production: SSL on (rejectUnauthorized false, as the Supabase pooler requires)', async () => {
    await load({ NODE_ENV: 'production', DATABASE_URL: 'postgres://synthetic.invalid/db' });
    expect(pg.poolOptions[0].ssl).toEqual({ rejectUnauthorized: false });
  });

  it.each(['development', 'test', ''])('NODE_ENV=%j: SSL is off', async nodeEnv => {
    await load({ NODE_ENV: nodeEnv });
    expect(pg.poolOptions[0].ssl).toBe(false);
  });

  it('on Vercel: 5 connections and no idle timeout (serverless; the pooler multiplexes them)', async () => {
    await load({ VERCEL: '1' });
    expect(pg.poolOptions[0].max).toBe(5);
    expect(pg.poolOptions[0].idleTimeoutMillis).toBe(0);
  });

  it('any non-empty VERCEL value counts as Vercel (even "0"); an empty one does not', async () => {
    await load({ VERCEL: '0' });
    expect(pg.poolOptions[0].max).toBe(5);
    await load({ VERCEL: '' });
    expect(pg.poolOptions[0].max).toBe(10);
  });

  it('off Vercel: 10 connections and a 30 s idle timeout', async () => {
    await load({});
    expect(pg.poolOptions[0].max).toBe(10);
    expect(pg.poolOptions[0].idleTimeoutMillis).toBe(30000);
  });

  it('exactly one pool is created, and it is the one that is exported', async () => {
    const db = await load({});
    expect(pg.pools).toHaveLength(1);
    expect(db.pool).toBe(pg.pools[0]);
  });

  it('an unexpected pool error is logged, never thrown (an idle client dropping must not crash the process)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await load({});
    const [event, handler] = pg.pools[0].on.mock.calls[0];
    expect(event).toBe('error');
    expect(() => handler(new Error('synthetic idle client failure'))).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('[db]');
  });
});

describe('query and queryOne', () => {
  it('query returns the rows array and passes the text and parameters to the pool unchanged', async () => {
    const db = await load({});
    pg.pools[0].query.mockResolvedValue({ rows: [{ a: 1 }, { a: 2 }] });
    expect(await db.query('SELECT $1', ['x'])).toEqual([{ a: 1 }, { a: 2 }]);
    expect(pg.pools[0].query).toHaveBeenCalledWith('SELECT $1', ['x']);
  });

  it('query on no rows returns an empty array', async () => {
    const db = await load({});
    pg.pools[0].query.mockResolvedValue({ rows: [] });
    expect(await db.query('SELECT 1')).toEqual([]);
  });

  it('queryOne returns the FIRST row, or null when there is none', async () => {
    const db = await load({});
    pg.pools[0].query.mockResolvedValue({ rows: [{ a: 1 }, { a: 2 }] });
    expect(await db.queryOne('SELECT 1')).toEqual({ a: 1 });
    pg.pools[0].query.mockResolvedValue({ rows: [] });
    expect(await db.queryOne('SELECT 1')).toBeNull();
  });

  it('a falsy first row is still returned (only a missing row is null)', async () => {
    const db = await load({});
    pg.pools[0].query.mockResolvedValue({ rows: [0] });
    expect(await db.queryOne('SELECT 1')).toBe(0);
  });

  it('database errors propagate from both helpers', async () => {
    const db = await load({});
    pg.pools[0].query.mockRejectedValue(new Error('synthetic query failure'));
    await expect(db.query('SELECT 1')).rejects.toThrow('synthetic query failure');
    await expect(db.queryOne('SELECT 1')).rejects.toThrow('synthetic query failure');
  });
});

describe('transaction', () => {
  async function setup() {
    const db = await load({});
    pg.pools[0].connect.mockResolvedValue(pg.client);
    return db;
  }

  it('runs BEGIN, then the callback on the pooled client, then COMMIT, then releases; returns the callback\'s value', async () => {
    const db = await setup();
    const result = await db.transaction(async client => {
      expect(client).toBe(pg.client);
      await client.query('INSERT 1');
      pg.log.push('CALLBACK DONE');
      return { ok: 42 };
    });
    expect(result).toEqual({ ok: 42 });
    expect(pg.log).toEqual(['BEGIN', 'INSERT 1', 'CALLBACK DONE', 'COMMIT', 'RELEASE']);
  });

  it('a callback that throws: ROLLBACK (never COMMIT), the SAME error is re-thrown, and the client is released', async () => {
    const db = await setup();
    const boom = new Error('synthetic callback failure');
    await expect(db.transaction(async client => { await client.query('INSERT 1'); throw boom; })).rejects.toBe(boom);
    expect(pg.log).toEqual(['BEGIN', 'INSERT 1', 'ROLLBACK', 'RELEASE']);
    expect(pg.log).not.toContain('COMMIT');
  });

  it('a failing COMMIT is rolled back and its error propagates (the client is still released)', async () => {
    const db = await setup();
    const commitErr = new Error('synthetic commit failure');
    pg.client.query.mockImplementation(async (sql: string) => { pg.log.push(sql); if (sql === 'COMMIT') throw commitErr; return { rows: [] }; });
    await expect(db.transaction(async () => 'x')).rejects.toBe(commitErr);
    expect(pg.log).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK', 'RELEASE']);
  });

  it('a failing BEGIN skips the callback, tries a ROLLBACK, propagates and releases', async () => {
    const db = await setup();
    const beginErr = new Error('synthetic begin failure');
    pg.client.query.mockImplementation(async (sql: string) => { pg.log.push(sql); if (sql === 'BEGIN') throw beginErr; return { rows: [] }; });
    const cb = vi.fn();
    await expect(db.transaction(cb)).rejects.toBe(beginErr);
    expect(cb).not.toHaveBeenCalled();
    expect(pg.log).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE']);
  });

  it('if the ROLLBACK itself fails, that error replaces the original, and the client is STILL released', async () => {
    const db = await setup();
    const rollbackErr = new Error('synthetic rollback failure');
    pg.client.query.mockImplementation(async (sql: string) => { pg.log.push(sql); if (sql === 'ROLLBACK') throw rollbackErr; return { rows: [] }; });
    await expect(db.transaction(async () => { throw new Error('original'); })).rejects.toBe(rollbackErr);
    expect(pg.log).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE']);
  });

  it('the client is released exactly once on success and exactly once on failure', async () => {
    const db = await setup();
    await db.transaction(async () => undefined);
    expect(pg.client.release).toHaveBeenCalledTimes(1);
    await expect(db.transaction(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(pg.client.release).toHaveBeenCalledTimes(2);
  });

  it('a pool that cannot give a client fails the call: no query runs and there is nothing to release', async () => {
    const db = await load({});
    pg.pools[0].connect.mockRejectedValue(new Error('synthetic pool exhausted'));
    await expect(db.transaction(async () => 'x')).rejects.toThrow('synthetic pool exhausted');
    expect(pg.client.query).not.toHaveBeenCalled();
    expect(pg.client.release).not.toHaveBeenCalled();
  });

  it('each call takes its own client from the pool (two transactions are two connects)', async () => {
    const db = await setup();
    await db.transaction(async () => 1);
    await db.transaction(async () => 2);
    expect(pg.pools[0].connect).toHaveBeenCalledTimes(2);
  });

  it('a callback that returns undefined commits and resolves undefined', async () => {
    const db = await setup();
    await expect(db.transaction(async () => undefined)).resolves.toBeUndefined();
    expect(pg.log).toEqual(['BEGIN', 'COMMIT', 'RELEASE']);
  });
});
