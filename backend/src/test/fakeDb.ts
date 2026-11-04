// Test double for ../db/index.js, shared by the route tests (src/test/routeHarness.ts has the HTTP half).
//
// It records every statement the code under test issues (text with its whitespace collapsed, plus the bound params) and
// answers from replies the test programmed. It never connects to anything: a route test that forgets to mock the db
// module would otherwise try to reach a real Postgres, so the tests mock '../db/index.js' with `dbModule()` and read the
// log back from `fakeDb`.
//
//   vi.mock('../db/index.js', async () => (await import('../test/fakeDb.js')).dbModule());
//   import { fakeDb } from '../test/fakeDb.js';
//
//   fakeDb.whenOne(/^SELECT \* FROM roles WHERE id = \$1/, { id: 'R9001', status: 'Draft' });
//   ...
//   expect(fakeDb.writes()).toEqual([]);            // a refusal must not have written anything
//
// A reply is a list of rows. `query` returns it, `queryOne` returns its first row (or null), and a statement issued on a
// transaction client returns it as { rows, rowCount }. A statement nothing was programmed for answers with no rows.

export interface RecordedCall {
  /** Which entry point the code used. */
  via: 'query' | 'queryOne' | 'client' | 'pool';
  /** The statement with every run of whitespace collapsed to one space and the ends trimmed. */
  sql: string;
  params: unknown[];
  /** True when the statement ran on the client handed to a `transaction(fn)` callback. */
  inTransaction: boolean;
}

export type Rows = unknown[];
export type Reply = Rows | ((params: unknown[], sql: string) => Rows | Promise<Rows>);

interface Handler {
  pattern: RegExp;
  reply: Reply;
  once: boolean;
}

const collapse = (sql: string) => String(sql).replace(/\s+/g, ' ').trim();
const ACCESS_SQL = 'SELECT is_active FROM users WHERE id=$1';
const WRITE_RE = /^(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i;

export class FakeDb {
  calls: RecordedCall[] = [];
  /** `transaction(fn)` calls that began, that fn completed, and that fn threw out of. */
  tx = { started: 0, committed: 0, rolledBack: 0 };
  private handlers: Handler[] = [];

  reset(): void {
    this.calls = [];
    this.handlers = [];
    this.accessLookups = 0;
    this.userAccess.clear();
    this.tx = { started: 0, committed: 0, rolledBack: 0 };
  }

  /** Answer every statement whose collapsed text matches `pattern` with `reply` (the latest registration wins). */
  when(pattern: RegExp, reply: Reply): this {
    this.handlers.push({ pattern, reply, once: false });
    return this;
  }

  /** `when` for a statement that returns one row (or none: pass null). */
  whenOne(pattern: RegExp, row: unknown | null): this {
    return this.when(pattern, row == null ? [] : [row]);
  }

  /** Answer only the next matching statement, then fall back to whatever was registered before. */
  whenOnce(pattern: RegExp, reply: Reply): this {
    this.handlers.push({ pattern, reply, once: true });
    return this;
  }

  /** Make the next statement that matches fail the way a database error does. */
  failing(pattern: RegExp, message = 'simulated database failure'): this {
    return this.when(pattern, () => { throw new Error(message); });
  }

  /**
   * What authenticate()'s live account check (`SELECT is_active FROM users WHERE id=$1`) sees. By default every user is active.
   * That lookup is answered here BEFORE the call log and the programmed replies, so it never shows up in `calls` /
   * `untouched()` / `statements()` and never consumes a `whenOnce` reply — tests written before the check keep proving what
   * they proved. Override per user with `setUserAccess`; `accessLookups` counts them. (authenticate() caches the answer for
   * 15 s: call `invalidateUserAccess()` after changing it mid-file.)
   */
  accessLookups = 0;
  private userAccess = new Map<string, 'active' | 'inactive' | 'missing' | 'error'>();
  setUserAccess(userId: string, state: 'active' | 'inactive' | 'missing' | 'error'): this { this.userAccess.set(userId, state); return this; }

  private async run(via: RecordedCall['via'], text: string, params: unknown[] | undefined, inTransaction: boolean): Promise<Rows> {
    const sql = collapse(text);
    const bound = params ?? [];
    if (sql === ACCESS_SQL) {
      this.accessLookups++;
      const state = this.userAccess.get(String(bound[0])) ?? 'active';
      if (state === 'error') throw new Error('simulated database failure');
      if (state === 'missing') return [];
      return [{ is_active: state === 'active' }];
    }
    this.calls.push({ via, sql, params: bound, inTransaction });
    for (let i = this.handlers.length - 1; i >= 0; i--) {
      const h = this.handlers[i];
      if (!h.pattern.test(sql)) continue;
      if (h.once) this.handlers.splice(i, 1);
      return typeof h.reply === 'function' ? await h.reply(bound, sql) : h.reply;
    }
    return [];
  }

  // ── what the mocked module hands to the code under test ──────────────────────────────────────────────────────
  query = async (text: string, params?: unknown[]): Promise<Rows> => this.run('query', text, params, false);

  queryOne = async (text: string, params?: unknown[]): Promise<unknown | null> => {
    const rows = await this.run('queryOne', text, params, false);
    return rows[0] ?? null;
  };

  transaction = async <T>(fn: (client: FakeClient) => Promise<T>): Promise<T> => {
    this.tx.started++;
    const client: FakeClient = {
      query: async (text: string, params?: unknown[]) => {
        const rows = await this.run('client', text, params, true);
        return { rows, rowCount: rows.length };
      },
      release: () => undefined,
    };
    try {
      const result = await fn(client);
      this.tx.committed++;
      return result;
    } catch (err) {
      this.tx.rolledBack++;
      throw err;
    }
  };

  pool = {
    query: async (text: string, params?: unknown[]) => {
      const rows = await this.run('pool', text, params, false);
      return { rows, rowCount: rows.length };
    },
    connect: async (): Promise<FakeClient> => ({
      query: async (text: string, params?: unknown[]) => {
        const rows = await this.run('client', text, params, true);
        return { rows, rowCount: rows.length };
      },
      release: () => undefined,
    }),
    on: () => undefined,
  };

  // ── reading the log back ─────────────────────────────────────────────────────────────────────────────────────
  /** Every statement issued, in order, as collapsed text. */
  statements(): string[] { return this.calls.map(c => c.sql); }

  /** The calls whose collapsed text matches. */
  find(pattern: RegExp): RecordedCall[] { return this.calls.filter(c => pattern.test(c.sql)); }

  /** The single call that matches; throws (with the whole log) when there are none or several, so a test cannot pass on the wrong statement. */
  one(pattern: RegExp): RecordedCall {
    const hits = this.find(pattern);
    if (hits.length !== 1) {
      throw new Error(`expected exactly one statement matching ${pattern}, found ${hits.length}. Log:\n  ${this.statements().join('\n  ')}`);
    }
    return hits[0];
  }

  /** Statements that change data (INSERT / UPDATE / DELETE / DDL). A request that was refused must have none. */
  writes(): RecordedCall[] { return this.calls.filter(c => WRITE_RE.test(c.sql)); }

  /** True when no statement of any kind was issued. */
  untouched(): boolean { return this.calls.length === 0 && this.tx.started === 0; }
}

export interface FakeClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Rows; rowCount: number }>;
  release: () => void;
}

/** The one instance every route test shares (each test file has its own module graph, so files never see each other's log). */
export const fakeDb = new FakeDb();

/** The shape of ../db/index.js, backed by `fakeDb`. Use as the factory of `vi.mock('../db/index.js', …)`. */
export function dbModule() {
  return {
    query: fakeDb.query,
    queryOne: fakeDb.queryOne,
    transaction: fakeDb.transaction,
    pool: fakeDb.pool,
  };
}
