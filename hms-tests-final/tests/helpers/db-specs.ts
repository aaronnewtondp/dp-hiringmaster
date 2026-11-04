/**
 * Helpers shared by the db specs that go beyond a plain connection (db.ts, owned by the foundation, only knows how to connect):
 *
 *   splitSqlStatements / runStatements / runAsOneQuery   apply backend/src/db/schema.sql and seed.sql statement by statement, collecting errors
 *   schemaFingerprint / diffFingerprints                 a comparable description of a database's structure (db/16 replays schema.sql and compares)
 *   createReplayDatabase / dropReplayDatabases           throw-away databases on the SAME Postgres server (never the one under test)
 *   healSourcingPlansTable / healSharedState             undo the one table rename db/13 performs (and every other leftover), if a killed run left it behind
 *   snapshotSourcingSettings / restoreSourcingSettings   put sourcing_settings back EXACTLY as it was, even after a killed run
 *   setBaseScores                                        the eight base ResumeIQ scores + average, set by SQL (no model call)
 *   purgeByTitlePrefix                                   remove every role (and what hangs off it) whose title starts with a spec's own prefix
 *
 * Everything here is LOCAL-ONLY, like the specs that use it: the connection comes from helpers/db.ts, which refuses a non-local host.
 */
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import type { Client as PgClient } from 'pg';
import { TEST_DB_URL } from './db';
import { purgeRolesFast } from './sourcing-db';

// ─── repo files ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A file of this repository (tests run with cwd = hms-tests-final, like helpers/sourcing-db.ts assumes). */
export function readRepoFile(...segments: string[]): string {
  return fs.readFileSync(path.join(process.cwd(), '..', ...segments), 'utf8');
}
export const schemaSql = () => readRepoFile('backend', 'src', 'db', 'schema.sql');
export const seedSql   = () => readRepoFile('backend', 'src', 'db', 'seed.sql');

// ─── SQL statements ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Splits a SQL script into its statements the way psql does: on a `;` that is outside a string, a quoted identifier, a dollar-quoted body
 * ($$ ... $$ or $tag$ ... $tag$) and a comment. Comments are dropped (they carry no behaviour); every other character is kept verbatim.
 * Enough for schema.sql and seed.sql — NOT a general SQL parser (no E'..' backslash escapes, no psql meta-commands).
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  const flush = () => {
    const s = cur.trim();
    if (s) out.push(s);
    cur = '';
  };
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '-' && d === '-') {                       // line comment: skip to the newline (the newline itself is kept)
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {                       // block comment (they nest in PostgreSQL)
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {                       // string literal / quoted identifier; a doubled quote is an escaped quote
      cur += c;
      i++;
      for (;;) {
        if (i >= n) throw new Error(`splitSqlStatements: unterminated ${c} quote`);
        cur += sql[i];
        if (sql[i] === c) {
          if (sql[i + 1] === c) { cur += sql[i + 1]; i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '$') {                                    // $$ or $tag$ dollar quoting ($1 is a parameter, not a tag: the tag cannot start with a digit)
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        if (end < 0) throw new Error(`splitSqlStatements: unterminated dollar quote ${m[0]}`);
        cur += sql.slice(i, end + m[0].length);
        i = end + m[0].length;
        continue;
      }
    }
    if (c === ';') { flush(); i++; continue; }
    cur += c;
    i++;
  }
  flush();
  return out;
}

export interface StatementError { index: number; statement: string; code: string | undefined; message: string }

/**
 * Runs the statements one by one on `client`, each as its own query (so, outside an explicit BEGIN, each is its own transaction — exactly what
 * `psql -f` does). `stopOnError` = psql's ON_ERROR_STOP=1; without it every statement is attempted and every failure is collected.
 */
export async function runStatements(
  client: PgClient, statements: string[], { stopOnError = false }: { stopOnError?: boolean } = {},
): Promise<{ executed: number; errors: StatementError[] }> {
  const errors: StatementError[] = [];
  let executed = 0;
  for (let index = 0; index < statements.length; index++) {
    try {
      await client.query(statements[index]);
      executed++;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      errors.push({ index, statement: statements[index], code: e.code, message: String(e.message ?? err) });
      if (stopOnError) break;
    }
  }
  return { executed, errors };
}

/**
 * Sends `sql` as ONE simple query (so a script with BEGIN ... COMMIT is atomic and anything else is one implicit transaction) and returns the
 * error, if any. A failed explicit transaction is rolled back so the connection stays usable.
 */
export async function runAsOneQuery(client: PgClient, sql: string): Promise<{ code?: string; message: string } | null> {
  try {
    await client.query(sql);
    return null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* nothing to roll back */ });
    const e = err as { code?: string; message?: string };
    return { code: e.code, message: String(e.message ?? err) };
  }
}

/**
 * schema.sql is two scripts in one file: the original create-from-scratch block (BEGIN ... COMMIT, plain CREATE TABLE) and the patch history
 * appended after it. The split is at the first COMMIT.
 */
export function splitSchemaSql(sql: string): { base: string[]; tail: string[] } {
  const statements = splitSqlStatements(sql);
  const commit = statements.findIndex(s => /^COMMIT$/i.test(s));
  if (commit < 0) throw new Error('schema.sql has no COMMIT any more — update helpers/db-specs.ts splitSchemaSql and the schema replay spec');
  return { base: statements.slice(0, commit + 1), tail: statements.slice(commit + 1) };
}

// ─── structure fingerprint ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SchemaFingerprint {
  tables: string[]; columns: string[]; constraints: string[]; indexes: string[]; functions: string[];
  triggers: string[]; sequences: string[]; rowSecurity: string[]; policies: string[];
}

const FINGERPRINT_QUERIES: Record<keyof SchemaFingerprint, string> = {
  tables: `SELECT c.relname AS s FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
  columns: `SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                   || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
                   || COALESCE(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') AS s
              FROM pg_attribute a
              JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`,
  constraints: `SELECT c.relname || '.' || con.conname || ' ' || pg_get_constraintdef(con.oid) AS s
                  FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' ORDER BY 1`,
  indexes: `SELECT indexname || ' :: ' || indexdef AS s FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
  // user functions only: the ones an extension (pgcrypto) installs into public are the same on every database and only add noise
  functions: `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') md5:' || md5(pg_get_functiondef(p.oid)) AS s
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public'
                 AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY 1`,
  triggers: `SELECT c.relname || '.' || t.tgname || ' :: ' || pg_get_triggerdef(t.oid) AS s
               FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE NOT t.tgisinternal AND n.nspname = 'public' ORDER BY 1`,
  sequences: `SELECT sequencename || ' start=' || start_value || ' inc=' || increment_by || ' min=' || min_value || ' max=' || max_value || ' cycle=' || cycle AS s
                FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`,
  rowSecurity: `SELECT c.relname || ' rls=' || c.relrowsecurity AS s FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
  policies: `SELECT tablename || '.' || policyname AS s FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`,
};

/** The structure of the public schema as sorted, comparable strings. Data (rows, sequence positions) is deliberately not part of it. */
export async function schemaFingerprint(client: PgClient): Promise<SchemaFingerprint> {
  const out = {} as SchemaFingerprint;
  for (const key of Object.keys(FINGERPRINT_QUERIES) as Array<keyof SchemaFingerprint>) {
    out[key] = (await client.query(FINGERPRINT_QUERIES[key])).rows.map(r => String(r.s));
  }
  return out;
}

/** What differs between two fingerprints, one readable line each ("[columns] only in A: ..."). Empty = identical. */
export function diffFingerprints(a: SchemaFingerprint, b: SchemaFingerprint, labels: [string, string] = ['A', 'B']): string[] {
  const lines: string[] = [];
  for (const key of Object.keys(a) as Array<keyof SchemaFingerprint>) {
    const inA = new Set(a[key]);
    const inB = new Set(b[key]);
    for (const s of a[key]) if (!inB.has(s)) lines.push(`[${key}] only in ${labels[0]}: ${s}`);
    for (const s of b[key]) if (!inA.has(s)) lines.push(`[${key}] only in ${labels[1]}: ${s}`);
  }
  return lines;
}

// ─── throw-away databases on the same server ────────────────────────────────────────────────────────────────────────────────────

export const REPLAY_DB_PREFIX = 'dp_hms_replay_';

/** `url` with its database name replaced. */
export function urlForDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** The name of the database in `url`. */
export function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/**
 * Drops every `dp_hms_replay_*` database nobody is connected to — the leftovers of a run that was killed before its afterAll. A database a live
 * run is still using has connections, so Postgres refuses to drop it (55006) and it is left alone. Returns the names it dropped.
 */
export async function dropReplayDatabases(admin: PgClient): Promise<string[]> {
  const { rows } = await admin.query(`SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY 1`, [`${REPLAY_DB_PREFIX}%`]);
  const dropped: string[] = [];
  for (const { datname } of rows as Array<{ datname: string }>) {
    const { rowCount } = await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [datname]);
    if (rowCount) continue;
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${datname}"`);
      dropped.push(datname);
    } catch (err) {
      if ((err as { code?: string }).code !== '55006') throw err;   // 55006 = in use by somebody who connected in the meantime
    }
  }
  return dropped;
}

/** Creates an empty database next to the one under test and returns its name and connection string. */
export async function createReplayDatabase(admin: PgClient): Promise<{ name: string; url: string }> {
  const name = `${REPLAY_DB_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  return { name, url: urlForDatabase(TEST_DB_URL, name) };
}

/** Drops one throw-away database (its own connections are closed first). Never throws for a database that is already gone. */
export async function dropReplayDatabase(admin: PgClient, name: string): Promise<void> {
  if (!name.startsWith(REPLAY_DB_PREFIX)) throw new Error(`refusing to drop "${name}": not a replay database`);
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

/** A connected client on `url` (the caller ends it). */
export async function connectTo(url: string): Promise<PgClient> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

// ─── self-healing the shared database ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * db/13 renames the real sourcing_plans table for the length of one request, to prove a role save survives a missing sourcing table. A run
 * killed inside that window leaves `sourcing_plans_tmp` and NO `sourcing_plans`: every later sourcing call would then fail. This puts it back.
 * True when it repaired something.
 */
export async function healSourcingPlansTable(client: PgClient): Promise<boolean> {
  const { rows } = await client.query(`SELECT to_regclass('public.sourcing_plans') AS live, to_regclass('public.sourcing_plans_tmp') AS tmp`);
  if (rows[0].live === null && rows[0].tmp !== null) {
    await client.query(`ALTER TABLE sourcing_plans_tmp RENAME TO sourcing_plans`);
    return true;
  }
  return false;
}

/**
 * The specs that pin sourcing_settings (go_live_date a long way ahead, so no throw-away draft role raises PLAN_NOT_ACTIVATED) keep a copy of the
 * WHOLE table in one extra row of the table itself. The backend ignores unknown keys (mergeSettings), so the row is invisible to it, and unlike a
 * variable in the spec's memory it survives a killed run: the next run's snapshot restores it first and only then takes its own.
 */
export const SETTINGS_BACKUP_KEY = 'zz_pw_settings_backup';

interface SavedSetting { key: string; value: unknown; updated_by: string | null }

/** Puts sourcing_settings back exactly as the last snapshot says (rows added since are removed, changed rows are reset). False when there is no snapshot. */
export async function restoreSourcingSettings(client: PgClient): Promise<boolean> {
  const backup = await client.query(`SELECT value FROM sourcing_settings WHERE key = $1`, [SETTINGS_BACKUP_KEY]);
  if (!backup.rowCount) return false;
  const saved = (backup.rows[0].value as { rows: SavedSetting[] }).rows;
  await client.query('BEGIN');
  try {
    await client.query(`DELETE FROM sourcing_settings WHERE key <> $1 AND NOT (key = ANY($2::text[]))`, [SETTINGS_BACKUP_KEY, saved.map(s => s.key)]);
    for (const s of saved) {
      await client.query(
        `INSERT INTO sourcing_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
        [s.key, JSON.stringify(s.value), s.updated_by]);
    }
    await client.query(`DELETE FROM sourcing_settings WHERE key = $1`, [SETTINGS_BACKUP_KEY]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* ignore */ });
    throw err;
  }
  return true;
}

/** Records the current sourcing_settings (after undoing any pin a killed run left, so the snapshot is always the real state). */
export async function snapshotSourcingSettings(client: PgClient): Promise<void> {
  await restoreSourcingSettings(client);
  const rows = (await client.query(`SELECT key, value, updated_by FROM sourcing_settings`)).rows as SavedSetting[];
  await client.query(`INSERT INTO sourcing_settings (key, value) VALUES ($1, $2::jsonb)`, [SETTINGS_BACKUP_KEY, JSON.stringify({ rows })]);
}

/** Upserts one setting (the caller has taken a snapshot first). */
export async function setSourcingSetting(client: PgClient, key: string, value: unknown): Promise<void> {
  await client.query(
    `INSERT INTO sourcing_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]);
}

/**
 * Everything a killed run can leave behind in the shared database, undone in one call: the renamed sourcing_plans table, a pinned
 * sourcing_settings (restored from the snapshot row) and leftover replay databases. Safe to call at any time (a no-op when nothing is wrong).
 * Returns what it repaired, one line each. The first db spec (00) calls it; a globalSetup that did the same would cover every project.
 */
export async function healSharedState(client: PgClient): Promise<string[]> {
  const healed: string[] = [];
  if (await healSourcingPlansTable(client)) healed.push('renamed sourcing_plans_tmp back to sourcing_plans');
  const { rows } = await client.query(`SELECT to_regclass('public.sourcing_settings') AS t`);
  if (rows[0].t !== null && await restoreSourcingSettings(client)) healed.push('restored sourcing_settings from the snapshot a killed run left');
  const dropped = await dropReplayDatabases(client);
  if (dropped.length) healed.push(`dropped replay databases: ${dropped.join(', ')}`);
  return healed;
}

// ─── ResumeIQ base scores without the model ─────────────────────────────────────────────────────────────────────────────────────────

/** Eight different dimension scores whose mean is exactly 6.0 (sum 48): a plain, checkable 8-dimension average. */
export const BASE_SCORES = [7, 6, 8, 5, 6, 7, 5, 4] as const;
export const BASE_SCORE_AVG = 6.0;

/**
 * What a finished base ResumeIQ run leaves on an application, written by SQL: the eight dimension scores, their average (score_avg = ai_fit_score / 10),
 * bucket, summary and SLA — the way db/15 builds its applications — so a spec that needs "a scored application" never calls the model.
 */
export async function setBaseScores(client: PgClient, applicationId: string): Promise<void> {
  const [t, e, i, c, r, tr, l, cm] = BASE_SCORES;
  const { rowCount } = await client.query(
    `UPDATE applications SET
       score_technical=$1, score_experience=$2, score_industry_fit=$3, score_culture_fit=$4,
       score_role_alignment=$5, score_trajectory=$6, score_leadership=$7, score_communication=$8,
       score_avg=$9, ai_fit_score=$10, ai_priority_bucket='Review', score_summary='Base summary (set by SQL).',
       score_red_flags=ARRAY['Base red flag']::text[], score_recommendation='Maybe', score_resume_read=false,
       score_computed_at=NOW(), sla_hours=48
     WHERE id=$11`,
    [t, e, i, c, r, tr, l, cm, BASE_SCORE_AVG, Math.round(BASE_SCORE_AVG * 10), applicationId]);
  if (rowCount !== 1) throw new Error(`setBaseScores: application ${applicationId} not found`);
}

// ─── clean-up by a spec's own prefix ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Removes every role whose title starts with `prefix` (plus their applications and everything else hanging off them) and every candidate whose
 * e-mail matches one of `emailLikes`. Keyed by the spec's own prefix instead of ids kept in memory, so a worker that was restarted after a failure
 * — or a run that was killed — still has its leftovers removed by the next run's beforeAll.
 */
export async function purgeByTitlePrefix(client: PgClient, prefix: string, emailLikes: string[] = []): Promise<number> {
  const { rows } = await client.query(`SELECT id FROM roles WHERE title LIKE $1`, [`${prefix.replace(/[\\%_]/g, '\\$&')}%`]);
  const ids = rows.map(r => r.id as string);
  await purgeRolesFast(client, ids, emailLikes);
  return ids.length;
}
