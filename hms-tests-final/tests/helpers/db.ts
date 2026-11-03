/**
 * The ONE definition of the database every DB-touching spec connects to.
 *
 *   TEST_DB_URL  (env)  default  postgresql://hms_user:hms_password@localhost:5432/dp_hms   (docker-compose's Postgres, and CI's service)
 *
 * An isolated stack (scripts/test-stack.sh) publishes its own Postgres on 55440+N and prints `export TEST_DB_URL=...`; the specs never
 * hard-code a port. Two guards, because these specs DELETE rows, rename tables and rewrite settings:
 *   1. the host must be local — a spec can never be pointed at Supabase or any other remote database;
 *   2. an API on a stack port (4110-4119) with no TEST_DB_URL is refused, because the default (:5432) would then be the DEVELOPER's database
 *      while the API under test uses the stack's own — the specs would mutate data the API never sees and the developer's data would be hit.
 */
import { Client } from 'pg';

export const DEFAULT_TEST_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';
export const TEST_DB_URL = process.env.TEST_DB_URL || DEFAULT_TEST_DB_URL;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}
function portOf(url: string): number {
  try { return Number(new URL(url).port) || 0; } catch { return 0; }
}

const host = hostOf(TEST_DB_URL);
if (host === null || !LOCAL_HOSTS.has(host)) {
  throw new Error(`TEST_DB_URL must point at a LOCAL database (localhost / 127.0.0.1); got host "${host ?? 'unparseable URL'}". The db specs delete rows and rewrite settings.`);
}
const apiPort = portOf(process.env.TEST_API_URL || 'http://localhost:4000');
if (!process.env.TEST_DB_URL && apiPort >= 4110 && apiPort <= 4119) {
  throw new Error(
    `TEST_API_URL is on stack port ${apiPort} but TEST_DB_URL is not set, so the db specs would connect to ${DEFAULT_TEST_DB_URL} (the developer's own database) ` +
    `instead of the stack's. Run: eval "$(bash scripts/test-stack.sh env <N>)"`);
}

/** A new, UNCONNECTED client on the test database (the caller connects and ends it). */
export function newClient(): Client {
  return new Client({ connectionString: TEST_DB_URL });
}

/** Connect, run `fn`, always close — for specs that only need the database for one block. */
export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = newClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => { /* already closed */ });
  }
}
