/**
 * Database connection.
 *
 * For local development: connects to Docker PostgreSQL.
 * For Vercel/Supabase: uses the POOLER connection string from Supabase dashboard.
 *
 * Important for Supabase Transaction Pooler:
 *  - max: 5 per serverless invocation (Supavisor's transaction-mode pooler
 *    multiplexes many clients onto few real backend connections, so this
 *    only grows the pooler's own client table, not the real Postgres
 *    connection count — it's what lets routes like dashboard.ts's
 *    Promise.all/Promise.allSettled fans achieve real DB-level concurrency
 *    instead of serializing every "concurrent" query one at a time onto a
 *    single connection. Was 1 — routes.ts/dashboard.ts's own already-
 *    correct concurrent query structuring was getting no benefit from it)
 *  - SSL required for production
 *  - Statement cache disabled (Supavisor transaction mode doesn't support it)
 */
import pg from 'pg';
const { Pool } = pg;

const isProduction = process.env.NODE_ENV === 'production';
const isVercel     = Boolean(process.env.VERCEL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // Supabase transaction pooler requires SSL in production
  ssl: isProduction ? { rejectUnauthorized: false } : false,

  // Serverless: a few connections per function invocation — see the
  // Supavisor note above. Local Docker: 10 is fine.
  max: isVercel ? 5 : 10,

  // Avoid idle connections sitting open between serverless invocations
  idleTimeoutMillis:    isVercel ? 0    : 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error', err);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const res = await pool.query<T>(text, params);
  return res.rows[0] ?? null;
}

export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export { pool };
