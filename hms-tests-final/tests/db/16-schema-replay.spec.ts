// ─────────────────────────────────────────────────────────────────────────────
// Schema replay and three-place drift.
//
// CLAUDE.md: "There are three representations of the schema, and they must always match: Supabase, the local Docker Postgres and
// backend/src/db/schema.sql". The rule has been broken before (a CHECK that never reached the file, a sequence that was never advanced, an id
// default that truncated), and no other spec looks at the FILE itself: they all run against a database somebody already built.
//
// This spec builds a brand-new database on the same Postgres server (a throw-away `dp_hms_replay_*`, dropped in afterAll; a leftover from a
// killed run is dropped in beforeAll), applies schema.sql and then seed.sql to it exactly as docker-compose's init and `npm run db:reset` do, and
// asserts what the rest of the system relies on: the tables, the row-level-security flags, the nine id sequences and format_seq_id, the CHECK
// constraints for the application status, the portfolio statuses and review kinds, the key indexes and delete rules, the seed counts, and that no
// sequence is behind its table. It then applies schema.sql a SECOND time and compares the live test database with the replay.
//
// PINNED AS "TODAY" (what the files do now, reported as product issues rather than fixed here — schema.sql and seed.sql are not edited):
//   * schema.sql is NOT safe to run twice, although its patch section is headed "Safe to run multiple times (all IF NOT EXISTS)": the original
//     block uses plain CREATE TABLE (42P07 on the first statement) and two patches fail when repeated: `ALTER TABLE roles ALTER COLUMN vacancy_reason TYPE
//     TEXT[] USING ... string_to_array(vacancy_reason, ...)` (the column is already text[], 42883) and `ALTER TABLE candidates ADD COLUMN gender` (no IF NOT EXISTS);
//   * seed.sql stops with `setval: value 0 is out of bounds` at its closing block on an empty database (the stack script and the CI job both
//     tolerate exactly that one error);
//   * after schema.sql + seed.sql, seq_eval_question and seq_comp_benchmark are BEHIND their tables (the seeded ids Q001-Q013 / BEN001-BEN012 are
//     explicit, and the `START 14` / `START 13` lines of the patch are no-ops after the first CREATE SEQUENCE ... START 1), so the first insert that
//     relies on the default id collides on the primary key — the stack and CI advance them by hand;
//   * pending_actions has no index on application_id / role_id (tests/helpers/sourcing-db.ts exists because of it).
//
// INTENTIONALLY LOCAL-ONLY, like the other tests/db specs: it creates and drops databases (the connection comes from helpers/db.ts, which refuses
// a non-local host) and needs a role with CREATEDB — the superuser the Docker image and the CI service give.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import type { Client } from 'pg';
import { newClient } from '../helpers/db';
import {
  schemaSql, seedSql, splitSqlStatements, splitSchemaSql, runStatements, runAsOneQuery,
  schemaFingerprint, diffFingerprints, createReplayDatabase, dropReplayDatabase, dropReplayDatabases, connectTo,
  healSourcingPlansTable, healSharedState, snapshotSourcingSettings, restoreSourcingSettings, setSourcingSetting, purgeByTitlePrefix,
  REPLAY_DB_PREFIX, SETTINGS_BACKUP_KEY,
} from '../helpers/db-specs';

// What the stack script and the CI job apply after seed.sql (see the TODAY note above). Same two statements.
const SEQUENCE_WORKAROUND = [
  `SELECT setval('seq_eval_question',  (SELECT MAX(substring(id from '[0-9]+')::int) FROM eval_questions))`,
  `SELECT setval('seq_comp_benchmark', (SELECT MAX(substring(id from '[0-9]+')::int) FROM comp_benchmarks))`,
];

const ID_COLUMNS = [
  { table: 'roles',            seq: 'seq_role',           prefix: 'R',   pad: 4 },
  { table: 'candidates',       seq: 'seq_candidate',      prefix: 'C',   pad: 4 },
  { table: 'applications',     seq: 'seq_application',    prefix: 'A',   pad: 4 },
  { table: 'interview_rounds', seq: 'seq_interview',      prefix: 'IR',  pad: 4 },
  { table: 'agencies',         seq: 'seq_agency',         prefix: 'AGN', pad: 3 },
  { table: 'assignment_repo',  seq: 'seq_assignment',     prefix: 'ASN', pad: 3 },
  { table: 'ref_checks',       seq: 'seq_refcheck',       prefix: 'RC',  pad: 3 },
  { table: 'eval_questions',   seq: 'seq_eval_question',  prefix: 'Q',   pad: 3 },
  { table: 'comp_benchmarks',  seq: 'seq_comp_benchmark', prefix: 'BEN', pad: 3 },
] as const;

const SOURCING_TABLES = [
  'sourcing_advice', 'sourcing_channel_weeks', 'sourcing_commitment_log', 'sourcing_commitments', 'sourcing_evidence',
  'sourcing_exceptions', 'sourcing_plan_changes', 'sourcing_plan_channels', 'sourcing_plans', 'sourcing_settings',
];
const OTHER_TABLES = [
  'activity_log', 'agencies', 'agency_edit_log', 'applications', 'assignment_repo', 'candidate_edit_log', 'candidates', 'comp_benchmarks',
  'eval_questions', 'interview_rounds', 'notification_log', 'pending_actions', 'portfolio_analyses', 'ref_checks', 'role_edit_log', 'roles', 'users',
];

/** The quoted values of a CHECK (x IN (...)) definition, sorted. */
const allowedValues = (def: string) => [...def.matchAll(/'([^']*)'::text/g)].map(m => m[1]).sort();

// ═══════════════════════════════════════════════════════════════════════════
test.describe('the statement splitter the replay depends on', () => {
  test('splits on a semicolon only outside strings, quoted identifiers, dollar-quoted bodies and comments', () => {
    const sql = [
      `-- a comment; with a semicolon`,
      `CREATE TABLE a (x TEXT DEFAULT 'it''s; fine', "we;ird" INT);   /* block; comment /* nested; */ still comment */`,
      `CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;`,
      `CREATE FUNCTION g() RETURNS int AS $body$ SELECT 'a;b'; $body$ LANGUAGE sql;`,
      `SELECT $1; -- $1 is a parameter, not a dollar quote`,
      `SELECT 1`,
    ].join('\n');
    expect(splitSqlStatements(sql)).toEqual([
      `CREATE TABLE a (x TEXT DEFAULT 'it''s; fine', "we;ird" INT)`,
      `CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql`,
      `CREATE FUNCTION g() RETURNS int AS $body$ SELECT 'a;b'; $body$ LANGUAGE sql`,
      `SELECT $1`,
      `SELECT 1`,
    ]);
    expect(() => splitSqlStatements(`SELECT 'never closed`)).toThrow(/unterminated/);
    expect(() => splitSqlStatements(`SELECT $$ never closed`)).toThrow(/unterminated/);
  });

  test('schema.sql splits into the original BEGIN ... COMMIT block and the patch history after it', () => {
    const { base, tail } = splitSchemaSql(schemaSql());
    expect(base[0]).toBe('BEGIN');
    expect(base[base.length - 1]).toBe('COMMIT');
    expect(base.filter(s => /^CREATE TABLE /.test(s))).toHaveLength(16);                      // the 16 original tables (portfolio_analyses and the sourcing tables come later)
    expect(tail.length).toBeGreaterThan(80);
    expect(tail[0]).toMatch(/^ALTER TABLE candidates\s+ADD COLUMN IF NOT EXISTS current_ctc_fixed/);        // the patch history starts right after the original block
    expect(tail[tail.length - 1]).toMatch(/^ALTER TABLE applications ADD CONSTRAINT applications_portfolio_status_check[\s\S]*'unreviewable'\)\)$/);   // and ends with the widest status list
    expect(tail.some(s => /^CREATE OR REPLACE FUNCTION format_seq_id/.test(s) && s.includes('$$ LANGUAGE SQL'))).toBe(true);   // a function body stays ONE statement
    expect(tail.every(s => !s.startsWith('--') && s.length > 0)).toBe(true);
    const seed = splitSqlStatements(seedSql());
    expect(seed[0]).toBe('BEGIN');
    expect(seed.filter(s => /^SELECT setval\(/.test(s))).toHaveLength(7);
  });
});

test.describe('Schema replay: schema.sql + seed.sql on an empty database', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  let admin: Client;                 // on the database under test (CREATE / DROP DATABASE only)
  let db: Client;                    // on the replay database
  const created: string[] = [];      // every database this run made — all dropped in afterAll
  let replayName = '';
  let seedStoppedAt = -1;            // index of the seed.sql statement that raised the tolerated error
  let seedStatements: string[] = [];
  let firstPass: Awaited<ReturnType<typeof schemaFingerprint>>;

  const scalar = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as Record<string, any>;
  const count = async (table: string) => Number((await scalar(`SELECT count(*) AS n FROM ${table}`)).n);

  /** The id the next default insert on `table` would get must be higher than every id already in it. */
  async function sequencesBehind(): Promise<string[]> {
    const behind: string[] = [];
    for (const { table, seq } of ID_COLUMNS) {
      const s = await scalar(`SELECT last_value, is_called FROM ${seq}`);
      const next = s.is_called ? Number(s.last_value) + 1 : Number(s.last_value);
      const max = Number((await scalar(`SELECT COALESCE(MAX(substring(id from '[0-9]+')::int), 0) AS m FROM ${table}`)).m);
      if (next <= max) behind.push(`${seq} (next ${next}, ${table} holds up to ${max})`);
    }
    return behind;
  }

  test.beforeAll(async () => {
    admin = newClient();
    await admin.connect();
    const who = (await admin.query(`SELECT rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user`)).rows[0];
    if (!who.rolsuper && !who.rolcreatedb) {
      throw new Error('The database role of TEST_DB_URL cannot CREATE DATABASE (needs CREATEDB or superuser, as in the Docker image and the CI service); the replay needs a throw-away database.');
    }
    await dropReplayDatabases(admin);                      // self-heal: leftovers of a run that was killed before its afterAll
    const replay = await createReplayDatabase(admin);
    created.push(replay.name);
    replayName = replay.name;
    db = await connectTo(replay.url);
  });

  test.afterAll(async () => {
    await db?.end().catch(() => { /* closed */ });
    for (const name of created) await dropReplayDatabase(admin, name).catch(err => console.warn(`[16-schema-replay] could not drop ${name}: ${err}`));
    await admin?.end().catch(() => { /* closed */ });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('applying the files to an empty database', () => {
    test('schema.sql applies in one go, as docker-compose and db:reset apply it', async () => {
      const err = await runAsOneQuery(db, schemaSql());
      expect(err, err?.message).toBeNull();
      firstPass = await schemaFingerprint(db);
      expect(firstPass.tables.length).toBeGreaterThan(0);
    });

    test('applied statement by statement into a second database it gives the identical structure (the splitter changes nothing)', async () => {
      const other = await createReplayDatabase(admin);
      created.push(other.name);
      const otherDb = await connectTo(other.url);
      try {
        const { base, tail } = splitSchemaSql(schemaSql());
        const { errors } = await runStatements(otherDb, [...base, ...tail], { stopOnError: true });
        expect(errors, JSON.stringify(errors[0])).toEqual([]);
        expect(diffFingerprints(firstPass, await schemaFingerprint(otherDb), ['one go', 'statement by statement'])).toEqual([]);
      } finally {
        await otherDb.end();
        await dropReplayDatabase(admin, other.name);
        created.splice(created.indexOf(other.name), 1);
      }
    });

    test('the database has exactly the 27 tables: the 17 original ones and the 10 sourcing ones', async () => {
      expect(firstPass.tables).toEqual([...OTHER_TABLES, ...SOURCING_TABLES].sort());
    });

    test('every sourcing_* table has row level security ON and no policy; the 17 original tables have it OFF (TODAY: known and accepted, CLAUDE.md)', async () => {
      const rls = Object.fromEntries(firstPass.rowSecurity.map(l => l.split(' rls=')).map(([t, v]) => [t, v === 'true']));
      for (const t of SOURCING_TABLES) expect(rls[t], `${t} must have RLS on`).toBe(true);
      for (const t of OTHER_TABLES) expect(rls[t], `${t}: RLS is off on the original tables today`).toBe(false);
      expect(firstPass.policies).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('ids: nine dedicated sequences and format_seq_id', () => {
    test('every prefixed id column defaults to format_seq_id(<its own sequence>, prefix, pad width), and no two tables share a sequence', async () => {
      const { rows } = await db.query(
        `SELECT c.relname AS t, pg_get_expr(d.adbin, d.adrelid) AS def
           FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum JOIN pg_class c ON c.oid = d.adrelid
          WHERE a.attname = 'id' AND pg_get_expr(d.adbin, d.adrelid) LIKE '%format_seq_id%'`);
      const defs = Object.fromEntries(rows.map(r => [r.t, r.def]));
      expect(Object.keys(defs).sort()).toEqual(ID_COLUMNS.map(c => c.table).sort());
      for (const { table, seq, prefix, pad } of ID_COLUMNS) {
        expect(defs[table], table).toBe(`format_seq_id('${seq}'::regclass, '${prefix}'::text, ${pad})`);
      }
      expect(new Set(ID_COLUMNS.map(c => c.seq)).size).toBe(9);                                 // never two tables on one sequence
      const seqs = (await db.query(`SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' AND sequencename LIKE 'seq\\_%' ORDER BY 1`)).rows.map(r => r.sequencename);
      expect(seqs).toEqual(ID_COLUMNS.map(c => c.seq).sort());
    });

    test('format_seq_id pads a short number, leaves a long one whole, and never truncates (the LPAD collision that hit every id series)', async () => {
      await db.query(`CREATE SEQUENCE pw_probe_seq START 9998`);
      try {
        const ids: string[] = [];
        for (let i = 0; i < 4; i++) ids.push((await scalar(`SELECT format_seq_id('pw_probe_seq', 'X', 4) AS id`)).id);
        expect(ids).toEqual(['X9998', 'X9999', 'X10000', 'X10001']);                            // 10000 and 10001 stay distinct
        // the control: what the old default produced once the number was as wide as the pad (it kept only the first 4 characters)
        expect((await scalar(`SELECT LPAD('10000', 4, '0') AS a, LPAD('10001', 4, '0') AS b`))).toEqual({ a: '1000', b: '1000' });
      } finally {
        await db.query(`DROP SEQUENCE pw_probe_seq`);
      }
      await db.query(`CREATE SEQUENCE pw_probe_pad START 7`);
      try {
        expect((await scalar(`SELECT format_seq_id('pw_probe_pad', 'X', 4) AS id`)).id).toBe('X0007');
        expect((await scalar(`SELECT format_seq_id('pw_probe_pad', 'Y', 3) AS id`)).id).toBe('Y008');
        expect((await scalar(`SELECT format_seq_id('pw_probe_pad', 'Z', 1) AS id`)).id).toBe('Z9');   // wider than the pad: as is
      } finally {
        await db.query(`DROP SEQUENCE pw_probe_pad`);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('CHECK constraints', () => {
    const checks: Array<{ name: string; table: string; values: string[] }> = [
      { name: 'applications_status_check', table: 'applications', values: ['Active', 'Closed', 'Hold for Future', 'Joined', 'Rejected', 'Withdrawn'] },
      { name: 'applications_portfolio_status_check', table: 'applications', values: ['completed', 'failed', 'inaccessible', 'no_portfolio', 'pending', 'running', 'unreviewable'] },
      { name: 'roles_portfolio_review_kind_check', table: 'roles', values: ['design_portfolio', 'marketing_work'] },
      { name: 'roles_status_check', table: 'roles', values: ['Approved', 'Closed – Cancelled', 'Closed – Filled', 'Draft', 'Live – Sourcing', 'On Hold', 'Under Review'] },
      { name: 'roles_jd_source_check', table: 'roles', values: ['generated', 'manual'] },
      { name: 'users_persona_check', table: 'users', values: ['hiring_manager', 'hr_recruiter', 'leadership', 'super_admin'] },
      { name: 'users_auth_provider_check', table: 'users', values: ['both', 'email', 'google'] },
    ];

    for (const c of checks) {
      test(`${c.name} allows exactly: ${c.values.join(', ')}`, async () => {
        const { rows } = await db.query(
          `SELECT pg_get_constraintdef(con.oid) AS def FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid
            WHERE con.conname = $1 AND t.relname = $2 AND con.contype = 'c'`, [c.name, c.table]);
        expect(rows, `${c.name} must exist exactly once on ${c.table}`).toHaveLength(1);
        expect(allowedValues(rows[0].def)).toEqual(c.values);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('indexes, uniqueness and delete rules', () => {
    test('the key unique indexes are partial exactly where the code relies on it', async () => {
      const idx = Object.fromEntries(firstPass.indexes.map(l => l.split(' :: ')).map(([n, d]) => [n, d]));
      expect(idx['idx_candidates_email']).toMatch(/CREATE UNIQUE INDEX idx_candidates_email ON public\.candidates USING btree \(email\) WHERE \(email IS NOT NULL\)/);
      expect(idx['uq_sourcing_exceptions_live']).toMatch(/CREATE UNIQUE INDEX uq_sourcing_exceptions_live ON public\.sourcing_exceptions USING btree \(plan_id, channel, type, subject_key\) WHERE \(status = ANY \(ARRAY\['open'::text, 'snoozed'::text, 'blocked'::text\]\)\)/);
      expect(idx['idx_activity_log_role']).toBeTruthy();
      for (const gin of ['idx_candidates_skills', 'idx_candidates_industries', 'idx_candidates_tags', 'idx_applications_hr_tags', 'idx_applications_score_red_flags']) {
        expect(idx[gin], gin).toMatch(/USING gin/);
      }
      const constraints = firstPass.constraints;
      expect(constraints).toContain('applications.applications_candidate_id_role_id_key UNIQUE (candidate_id, role_id)');
      expect(constraints).toContain('users.users_email_key UNIQUE (email)');
      expect(constraints).toContain('sourcing_plans.sourcing_plans_role_id_key UNIQUE (role_id)');
    });

    test('the foreign keys the application depends on carry these delete rules', async () => {
      const { rows } = await db.query(
        `SELECT c.relname AS t, a.attname AS col, r.relname AS ref, con.confdeltype AS rule
           FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_class r ON r.oid = con.confrelid
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
          WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1`);
      const rule: Record<string, string> = Object.fromEntries(rows.map(r => [`${r.t}.${r.col}->${r.ref}`, r.rule]));
      // a = NO ACTION (refuses the delete)  c = CASCADE  n = SET NULL
      const expected: Record<string, string> = {
        'applications.candidate_id->candidates': 'a', 'applications.role_id->roles': 'a',
        'interview_rounds.application_id->applications': 'c', 'ref_checks.application_id->applications': 'c',
        'pending_actions.application_id->applications': 'c', 'portfolio_analyses.application_id->applications': 'c',
        'pending_actions.role_id->roles': 'n', 'notification_log.application_id->applications': 'n',
        'activity_log.application_id->applications': 'n', 'activity_log.candidate_id->candidates': 'n', 'activity_log.role_id->roles': 'n',
        'role_edit_log.role_id->roles': 'c', 'candidate_edit_log.candidate_id->candidates': 'c', 'agency_edit_log.agency_id->agencies': 'c',
        'sourcing_plans.role_id->roles': 'c', 'sourcing_plan_channels.plan_id->sourcing_plans': 'c', 'sourcing_commitments.plan_channel_id->sourcing_plan_channels': 'c',
        'sourcing_exceptions.plan_id->sourcing_plans': 'c', 'sourcing_advice.plan_id->sourcing_plans': 'c',
      };
      for (const [k, v] of Object.entries(expected)) expect(rule[k], k).toBe(v);
    });

    test('TODAY: pending_actions has no index on application_id or role_id (every row delete scans it; purgeRolesFast exists because of that)', async () => {
      const idx = firstPass.indexes.filter(l => l.includes(' ON public.pending_actions ')).map(l => l.split(' :: ')[0]).sort();
      expect(idx).toEqual(['idx_pending_actions_owner', 'idx_pending_actions_resolved', 'pending_actions_pkey']);
    });

    test('the triggers: updated_at on four tables, and the CTC-change flag uses the patched function (it records role_id)', async () => {
      const names = firstPass.triggers.map(l => l.split(' :: ')[0]);
      for (const t of ['roles.roles_updated_at', 'applications.applications_updated_at', 'candidates.candidates_updated_at', 'interview_rounds.interview_rounds_updated_at', 'roles.roles_ctc_change']) {
        expect(names, t).toContain(t);
      }
      await db.query('BEGIN');
      try {
        const r = await scalar(`INSERT INTO roles (title, priority, ctc_band) VALUES ('Trigger probe', 'P2', '10-12 LPA') RETURNING id, updated_at`);
        await db.query(`UPDATE roles SET ctc_band = '12-14 LPA' WHERE id = $1`, [r.id]);
        const pa = await scalar(`SELECT action_type, role_id, role_title FROM pending_actions WHERE role_title = 'Trigger probe'`);
        expect(pa).toEqual({ action_type: 'Compensation change flag', role_id: r.id, role_title: 'Trigger probe' });   // role_id comes from the SECOND definition in the patch section
        expect(new Date((await scalar(`SELECT updated_at FROM roles WHERE id = $1`, [r.id])).updated_at).getTime()).toBeGreaterThanOrEqual(new Date(r.updated_at).getTime());
      } finally {
        await db.query('ROLLBACK');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('seed.sql', () => {
    test("TODAY: seed.sql applied the way `psql -v ON_ERROR_STOP=1` does stops at exactly ONE error — setval(seq_candidate, 0) in its closing block — after every INSERT has committed", async () => {
      seedStatements = splitSqlStatements(seedSql());
      const { errors, executed } = await runStatements(db, seedStatements, { stopOnError: true });
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('22003');                                                      // numeric_value_out_of_range
      expect(errors[0].message).toMatch(/setval: value 0 is out of bounds for sequence "seq_candidate"/);
      expect(errors[0].statement).toContain(`setval('seq_candidate'`);
      seedStoppedAt = errors[0].index;
      expect(executed).toBe(seedStoppedAt);
      // everything before it, including the COMMIT of the data block and the setval of seq_role, ran
      expect(seedStatements.slice(0, seedStoppedAt).some(s => s === 'COMMIT')).toBe(true);
      expect(seedStatements.slice(seedStoppedAt + 1).filter(s => /^SELECT setval\(/.test(s))).toHaveLength(5);   // application, interview, agency, assignment, refcheck: never reached
    });

    test('the seed holds 9 users (2 HR, 4 Hiring Managers, 2 Leadership, 1 super_admin), 7 roles, 15 agencies, 12 benchmarks, 13 eval questions, 4 assignments and nothing else', async () => {
      expect(await count('users')).toBe(9);
      expect((await db.query(`SELECT persona, count(*)::int AS n FROM users GROUP BY 1 ORDER BY 1`)).rows)
        .toEqual([{ persona: 'hiring_manager', n: 4 }, { persona: 'hr_recruiter', n: 2 }, { persona: 'leadership', n: 2 }, { persona: 'super_admin', n: 1 }]);
      expect((await scalar(`SELECT count(*)::int AS n FROM users WHERE persona = 'super_admin' AND email = 'superadmin@digitalpaani.com'`)).n).toBe(1);
      expect((await db.query(`SELECT id FROM roles ORDER BY id`)).rows.map(r => r.id)).toEqual(['R001', 'R002', 'R003', 'R004', 'R005', 'R006', 'R007']);
      expect((await db.query(`SELECT DISTINCT status FROM roles`)).rows.map(r => r.status)).toEqual(['Live – Sourcing']);
      expect(await count('agencies')).toBe(15);
      expect(await count('comp_benchmarks')).toBe(12);
      expect(await count('eval_questions')).toBe(13);
      expect(await count('assignment_repo')).toBe(4);
      for (const t of ['candidates', 'applications', 'interview_rounds', 'ref_checks', 'activity_log', 'pending_actions', 'sourcing_plans', 'sourcing_settings', 'portfolio_analyses']) {
        expect(await count(t), t).toBe(0);
      }
      expect((await scalar(`SELECT count(*)::int AS n FROM roles WHERE portfolio_analysis_enabled`)).n).toBe(0);
    });

    test('TODAY: continuing past the first error, the other three COALESCE(.., 0) setvals fail the same way and the agency and assignment ones succeed', async () => {
      const rest = seedStatements.slice(seedStoppedAt + 1);
      const { errors } = await runStatements(db, rest);
      expect(errors.map(e => (/sequence "(\w+)"/.exec(e.message) ?? [])[1]).sort()).toEqual(['seq_application', 'seq_interview', 'seq_refcheck']);
      for (const e of errors) expect(e.message).toMatch(/setval: value 0 is out of bounds/);
      expect(Number((await scalar(`SELECT last_value FROM seq_agency`)).last_value)).toBe(15);
      expect(Number((await scalar(`SELECT last_value FROM seq_assignment`)).last_value)).toBe(4);
    });

    test('TODAY: seq_eval_question and seq_comp_benchmark are created START 1 (the later START 14 / START 13 lines are no-ops) and are BEHIND their tables; every other sequence is fine', async () => {
      const start = Object.fromEntries((await db.query(`SELECT sequencename, start_value FROM pg_sequences WHERE schemaname = 'public' AND sequencename IN ('seq_eval_question', 'seq_comp_benchmark', 'seq_role', 'seq_agency', 'seq_assignment')`))
        .rows.map(r => [r.sequencename, Number(r.start_value)]));
      expect(start).toEqual({ seq_eval_question: 1, seq_comp_benchmark: 1, seq_role: 8, seq_agency: 16, seq_assignment: 5 });
      expect(await sequencesBehind()).toEqual([
        'seq_eval_question (next 1, eval_questions holds up to 13)',
        'seq_comp_benchmark (next 1, comp_benchmarks holds up to 12)',
      ]);
    });

    test('TODAY: so the first INSERT that relies on the default id collides on the primary key', async () => {
      await expect(db.query(`INSERT INTO eval_questions (evaluation_area, question_text) VALUES ('Probe', 'Probe')`)).rejects.toThrow(/eval_questions_pkey/);
      await expect(db.query(`INSERT INTO comp_benchmarks (role_category, experience_range) VALUES ('Probe', '0-1')`)).rejects.toThrow(/comp_benchmarks_pkey/);
    });

    test('with the two setvals the stack and CI apply, no sequence is behind its table and the next default ids are Q014 and BEN013', async () => {
      for (const sql of SEQUENCE_WORKAROUND) await db.query(sql);
      expect(await sequencesBehind()).toEqual([]);
      await db.query('BEGIN');
      try {
        expect((await scalar(`INSERT INTO eval_questions (evaluation_area, question_text) VALUES ('Probe', 'Probe') RETURNING id`)).id).toBe('Q014');
        expect((await scalar(`INSERT INTO comp_benchmarks (role_category, experience_range) VALUES ('Probe', '0-1') RETURNING id`)).id).toBe('BEN013');
        expect((await scalar(`INSERT INTO roles (title, priority) VALUES ('Probe', 'P2') RETURNING id`)).id).toBe('R0008');
        expect((await scalar(`INSERT INTO agencies (name) VALUES ('Probe') RETURNING id`)).id).toBe('AGN016');
        expect((await scalar(`INSERT INTO assignment_repo (name) VALUES ('Probe') RETURNING id`)).id).toBe('ASN005');
        expect((await scalar(`INSERT INTO candidates (full_name) VALUES ('Probe') RETURNING id`)).id).toBe('C0001');
      } finally {
        await db.query('ROLLBACK');                                                              // the sequences keep the numbers they handed out
      }
    });

    test('re-running seed.sql on a database that already holds data (npm run db:reset without a volume wipe) never moves a sequence backwards', async () => {
      // real rows on every series that seed.sql does not insert itself
      const cands: string[] = [];
      for (let i = 0; i < 3; i++) cands.push((await scalar(`INSERT INTO candidates (full_name) VALUES ($1) RETURNING id`, [`Replay Candidate ${i}`])).id);
      const apps: string[] = [];
      for (const c of cands.slice(0, 2)) apps.push((await scalar(`INSERT INTO applications (candidate_id, role_id) VALUES ($1, 'R001') RETURNING id`, [c])).id);
      await db.query(`INSERT INTO interview_rounds (application_id, round_name) VALUES ($1, 'Round 1')`, [apps[0]]);
      await db.query(`INSERT INTO ref_checks (application_id, reference_name, reference_number, relationship, feedback) VALUES ($1, 'Ref', '000', 'Teammate', 'Good')`, [apps[0]]);
      expect(cands).toEqual(['C0002', 'C0003', 'C0004']);                                        // C0001 went to the rolled-back probe above

      const before = { users: await count('users'), roles: await count('roles'), agencies: await count('agencies') };
      // psql without ON_ERROR_STOP (what db:reset runs): the data block fails on its first duplicate and rolls back, the closing setvals still run
      const { errors } = await runStatements(db, seedStatements);
      expect(errors.filter(e => e.code === '23505').map(e => e.message)).toEqual([expect.stringMatching(/roles_pkey/)]);
      expect(errors.every(e => e.code === '23505' || e.code === '25P02'), JSON.stringify(errors.map(e => e.code))).toBe(true);   // the duplicate, then "transaction is aborted" until COMMIT
      expect({ users: await count('users'), roles: await count('roles'), agencies: await count('agencies') }).toEqual(before);   // the data block did not half-apply

      expect(await sequencesBehind()).toEqual([]);                                               // MAX(...)-based setvals: nothing reset to 1
      expect((await scalar(`SELECT format_seq_id('seq_candidate', 'C', 4) AS id`)).id).toBe('C0005');
      expect((await scalar(`SELECT format_seq_id('seq_application', 'A', 4) AS id`)).id).toBe('A0003');
      expect((await scalar(`SELECT format_seq_id('seq_interview', 'IR', 4) AS id`)).id).toBe('IR0002');
      expect((await scalar(`SELECT format_seq_id('seq_refcheck', 'RC', 3) AS id`)).id).toBe('RC002');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('applying schema.sql a second time', () => {
    let before: Awaited<ReturnType<typeof schemaFingerprint>>;
    let rowsBefore: Record<string, number>;

    const rowCounts = async () => {
      const counts: Record<string, number> = {};
      for (const t of [...OTHER_TABLES, ...SOURCING_TABLES]) counts[t] = await count(t);       // one at a time: a pg client runs one query at a time
      return counts;
    };

    test.beforeAll(async () => { before = await schemaFingerprint(db); rowsBefore = await rowCounts(); });

    test('TODAY: the original block is NOT idempotent — its first CREATE TABLE fails (42P07) and the whole BEGIN ... COMMIT rolls back, changing nothing', async () => {
      const { base } = splitSchemaSql(schemaSql());
      const err = await runAsOneQuery(db, `${base.join(';\n')};`);
      expect(err?.code).toBe('42P07');
      expect(err?.message).toMatch(/relation "users" already exists/);
      expect(diffFingerprints(before, await schemaFingerprint(db), ['before', 'after'])).toEqual([]);
      expect(await rowCounts()).toEqual(rowsBefore);
    });

    test('TODAY: of the patch section exactly two statements fail when it is run again — the vacancy_reason type change (42883) and `ADD COLUMN gender` (42701) — every other statement is a true no-op', async () => {
      const { tail } = splitSchemaSql(schemaSql());
      const { errors, executed } = await runStatements(db, tail);
      expect(errors).toHaveLength(2);
      expect(errors.map(e => e.code)).toEqual(['42883', '42701']);
      expect(errors[0].statement.replace(/\s+/g, ' ')).toMatch(/^ALTER TABLE roles ALTER COLUMN vacancy_reason TYPE TEXT\[\] USING /);
      expect(errors[1].statement).toMatch(/^ALTER TABLE candidates ADD COLUMN gender TEXT CHECK \(gender IN \('M','F'\)\)$/);
      expect(errors[0].message).toBe('function string_to_array(text[], unknown) does not exist');
      expect(errors[1].message).toBe('column "gender" of relation "candidates" already exists');
      expect(executed).toBe(tail.length - 2);
      expect(diffFingerprints(before, await schemaFingerprint(db), ['before', 'after'])).toEqual([]);   // idempotent in effect: the structure is exactly what it was
      expect(await rowCounts()).toEqual(rowsBefore);                                              // and the data migration at the end of the file touched no row
    });

    test('the same two scripts, in the order db:reset runs them, leave a seeded database usable (a candidate can still be added, with the next id)', async () => {
      const id = (await scalar(`INSERT INTO candidates (full_name) VALUES ('After second apply') RETURNING id`)).id;
      expect(id).toBe('C0006');                                                                  // C0005 was handed out by the re-seed test's format_seq_id probe
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Last on purpose: these inserts take numbers from the id sequences (a rollback does not give them back), which the id assertions above count.
  test.describe('what the constraints reject', () => {
    test("the status CHECKs really reject what they do not list: 'On Hold' (retired, folded into 'Hold for Future'), a retired persona, the old auth provider", async () => {
      await db.query('BEGIN');
      try {
        const u = await scalar(`INSERT INTO users (name, email, persona) VALUES ('Probe', 'probe@example.com', 'hr_recruiter') RETURNING id`);
        const r = await scalar(`INSERT INTO roles (title, priority) VALUES ('Probe role', 'P2') RETURNING id`);
        const c = await scalar(`INSERT INTO candidates (full_name) VALUES ('Probe Candidate') RETURNING id`);
        const a = await scalar(`INSERT INTO applications (candidate_id, role_id) VALUES ($1, $2) RETURNING id, status, stage`, [c.id, r.id]);
        expect(a.status).toBe('Active');
        expect(a.stage).toBe('Applied and Screened');                                          // the column default was moved with the stage rename
        for (const [sql, constraint] of [
          [`UPDATE applications SET status = 'On Hold' WHERE id = '${a.id}'`, 'applications_status_check'],
          [`UPDATE applications SET portfolio_analysis_status = 'banana' WHERE id = '${a.id}'`, 'applications_portfolio_status_check'],
          [`UPDATE users SET persona = 'interviewer' WHERE id = '${u.id}'`, 'users_persona_check'],
          [`UPDATE users SET auth_provider = 'password' WHERE id = '${u.id}'`, 'users_auth_provider_check'],
          [`UPDATE roles SET portfolio_review_kind = 'astrology' WHERE id = '${r.id}'`, 'roles_portfolio_review_kind_check'],
        ]) {
          await db.query('SAVEPOINT s');
          await expect(db.query(sql), sql).rejects.toThrow(new RegExp(constraint));
          await db.query('ROLLBACK TO SAVEPOINT s');
        }
        expect((await scalar(`SELECT auth_provider FROM users WHERE id = $1`, [u.id])).auth_provider).toBe('email');   // the default after the correction
      } finally {
        await db.query('ROLLBACK');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // The helpers the OTHER db specs use to clean up after themselves and to undo what a killed run left behind (the renamed sourcing_plans table,
  // a pinned sourcing_settings, leftover replay databases, a spec's own roles). They are proven here on the throw-away database, where breaking
  // things on purpose costs nothing, so that no spec has to damage the shared database to show that the repair works.
  test.describe('the self-healing helpers (run on this replay database, never on the shared one)', () => {
    const settingRows = async () => (await db.query(`SELECT key, value FROM sourcing_settings ORDER BY key`)).rows;

    test('healSourcingPlansTable puts a renamed sourcing_plans back with its rows and foreign keys, and leaves a healthy or ambiguous state alone', async () => {
      expect(await healSourcingPlansTable(db)).toBe(false);                                      // healthy: nothing to do
      const role = await scalar(`INSERT INTO roles (title, priority) VALUES ('Heal probe', 'P2') RETURNING id`);
      const plan = await scalar(`INSERT INTO sourcing_plans (role_id) VALUES ($1) RETURNING id`, [role.id]);
      await db.query(`INSERT INTO sourcing_plan_channels (plan_id, channel) VALUES ($1, 'LinkedIn')`, [plan.id]);

      await db.query(`ALTER TABLE sourcing_plans RENAME TO sourcing_plans_tmp`);                 // what a killed db/13 leaves
      expect((await scalar(`SELECT to_regclass('public.sourcing_plans') AS t`)).t).toBeNull();
      expect(await healSourcingPlansTable(db)).toBe(true);
      expect((await scalar(`SELECT to_regclass('public.sourcing_plans_tmp') AS t`)).t).toBeNull();
      expect((await scalar(`SELECT count(*)::int AS n FROM sourcing_plans WHERE role_id = $1`, [role.id])).n).toBe(1);
      expect((await scalar(`SELECT count(*)::int AS n FROM sourcing_plan_channels WHERE plan_id = $1`, [plan.id])).n).toBe(1);
      await expect(db.query(`INSERT INTO sourcing_plan_channels (plan_id, channel) VALUES (999999, 'x')`)).rejects.toThrow(/foreign key/);   // the FK followed the table

      // both names present: ambiguous, so it must not touch either (a rename would fail or hide data)
      await db.query(`CREATE TABLE sourcing_plans_tmp (x int)`);
      expect(await healSourcingPlansTable(db)).toBe(false);
      expect((await scalar(`SELECT to_regclass('public.sourcing_plans') AS a, to_regclass('public.sourcing_plans_tmp') AS b`))).toEqual({ a: 'sourcing_plans', b: 'sourcing_plans_tmp' });
      await db.query(`DROP TABLE sourcing_plans_tmp`);

      await db.query(`DELETE FROM sourcing_plan_channels WHERE plan_id = $1`, [plan.id]);
      await db.query(`DELETE FROM sourcing_plans WHERE id = $1`, [plan.id]);
      await db.query(`DELETE FROM roles WHERE id = $1`, [role.id]);
    });

    test('snapshot / restore put sourcing_settings back EXACTLY: changed rows reset, added rows removed, removed rows returned, the snapshot row gone', async () => {
      await db.query(`DELETE FROM sourcing_settings`);
      await db.query(`INSERT INTO sourcing_settings (key, value) VALUES ('go_live_date', '"2026-01-01"'), ('qualified_rule', '"either"'), ('volume_min_qualified', '5')`);
      const original = await settingRows();

      await snapshotSourcingSettings(db);
      expect((await scalar(`SELECT count(*)::int AS n FROM sourcing_settings WHERE key = $1`, [SETTINGS_BACKUP_KEY])).n).toBe(1);
      await setSourcingSetting(db, 'go_live_date', '2099-12-31');                                // pinned a long way ahead
      await setSourcingSetting(db, 'qualified_rule', 'shortlisted');                             // changed
      await db.query(`DELETE FROM sourcing_settings WHERE key = 'volume_min_qualified'`);        // removed
      await db.query(`INSERT INTO sourcing_settings (key, value) VALUES ('digest_recipients', '["a@digitalpaani.com"]')`);   // added

      expect(await restoreSourcingSettings(db)).toBe(true);
      expect(await settingRows()).toEqual(original);
      expect(await restoreSourcingSettings(db)).toBe(false);                                     // nothing left to restore
    });

    test('a snapshot taken after a killed run (pin still in place) first restores the real state and snapshots THAT, never the pin', async () => {
      await db.query(`DELETE FROM sourcing_settings`);
      await db.query(`INSERT INTO sourcing_settings (key, value) VALUES ('go_live_date', '"2026-01-01"')`);
      const original = await settingRows();

      await snapshotSourcingSettings(db);                                                        // run 1 ...
      await setSourcingSetting(db, 'go_live_date', '2099-12-31');                                // ... is killed here, before its afterAll
      await snapshotSourcingSettings(db);                                                        // run 2 starts
      expect((await scalar(`SELECT value->'rows' AS rows FROM sourcing_settings WHERE key = $1`, [SETTINGS_BACKUP_KEY])).rows)
        .toEqual([expect.objectContaining({ key: 'go_live_date', value: '2026-01-01' })]);       // the real value, not 2099-12-31
      await setSourcingSetting(db, 'go_live_date', '2099-12-31');
      expect(await restoreSourcingSettings(db)).toBe(true);
      expect(await settingRows()).toEqual(original);
    });

    test('an EMPTY sourcing_settings (a fresh database) is restored to empty — the engine stamps its own go-live date again later', async () => {
      await db.query(`DELETE FROM sourcing_settings`);
      await snapshotSourcingSettings(db);
      await setSourcingSetting(db, 'go_live_date', '2099-12-31');
      await setSourcingSetting(db, 'shadow_until', '2099-12-31');
      expect(await restoreSourcingSettings(db)).toBe(true);
      expect(await settingRows()).toEqual([]);
    });

    test('the snapshot row is an unknown key to the backend (mergeSettings has no case for it), so loading the settings never sees it', async () => {
      const known = ['go_live_date', 'shadow_until', 'digest_recipients', 'daily_digest_enabled', 'qualified_rule', 'portal_expiry_days', 'renew_lead_days',
        'agency_followup_days', 'referral_repost_days', 'weekly_baseline_weeks', 'volume_min_qualified', 'volume_window_days', 'volume_gap_working_days', 'referral_audience_email'];
      expect(known).not.toContain(SETTINGS_BACKUP_KEY);
      expect(SETTINGS_BACKUP_KEY).toMatch(/^zz_pw_/);
    });

    test('healSharedState repairs both at once and reports each repair; with nothing wrong it reports nothing', async () => {
      expect(await healSharedState(db)).toEqual([]);
      await db.query(`DELETE FROM sourcing_settings`);
      await snapshotSourcingSettings(db);
      await setSourcingSetting(db, 'go_live_date', '2099-12-31');
      await db.query(`ALTER TABLE sourcing_plans RENAME TO sourcing_plans_tmp`);
      expect(await healSharedState(db)).toEqual([
        'renamed sourcing_plans_tmp back to sourcing_plans',
        'restored sourcing_settings from the snapshot a killed run left',
      ]);
      expect(await settingRows()).toEqual([]);
      expect((await scalar(`SELECT to_regclass('public.sourcing_plans') AS t`)).t).toBe('sourcing_plans');
      expect(await healSharedState(db)).toEqual([]);
    });

    test('dropReplayDatabases drops a leftover replay database nobody uses and leaves one that is in use alone', async () => {
      const leftover = await createReplayDatabase(admin);                                        // a run that was killed before its afterAll: no connection to it
      created.push(leftover.name);
      const inUse = await createReplayDatabase(admin);
      created.push(inUse.name);
      const holder = await connectTo(inUse.url);                                                 // a live run keeps its connection open
      try {
        const dropped = await dropReplayDatabases(admin);
        expect(dropped).toContain(leftover.name);
        expect(dropped).not.toContain(inUse.name);
        expect(dropped).not.toContain(replayName);                                               // this spec's own database is connected, so it is safe too
        const left = (await admin.query(`SELECT datname FROM pg_database WHERE datname LIKE $1`, [`${REPLAY_DB_PREFIX}%`])).rows.map(r => r.datname);
        expect(left).toEqual(expect.arrayContaining([inUse.name, replayName]));
        expect(left).not.toContain(leftover.name);
      } finally {
        await holder.end();
        await dropReplayDatabase(admin, inUse.name);
        created.splice(created.indexOf(inUse.name), 1);
        created.splice(created.indexOf(leftover.name), 1);
      }
      await expect(dropReplayDatabase(admin, 'dp_hms')).rejects.toThrow(/not a replay database/);   // the guard: only replay databases can ever be dropped
    });

    test('purgeByTitlePrefix removes the roles with that prefix and everything hanging off them, plus the matching candidates — and nothing else (LIKE wildcards are literal)', async () => {
      const mk = async (title: string, email: string) => {
        const role = await scalar(`INSERT INTO roles (title, priority) VALUES ($1, 'P2') RETURNING id`, [title]);
        const cand = await scalar(`INSERT INTO candidates (full_name, email) VALUES ($1, $2) RETURNING id`, [`Purge ${title}`, email]);
        const app = await scalar(`INSERT INTO applications (candidate_id, role_id) VALUES ($1, $2) RETURNING id`, [cand.id, role.id]);
        await db.query(`INSERT INTO pending_actions (owner_type, action_type, description, application_id, role_id) VALUES ('HR', 'x', 'x', $1, $2)`, [app.id, role.id]);
        await db.query(`INSERT INTO activity_log (application_id, candidate_id, role_id, event_type) VALUES ($1, $2, $3, 'Probe')`, [app.id, cand.id, role.id]);
        return { role: role.id, cand: cand.id, app: app.id };
      };
      const mine1 = await mk('PWPURGE_100% role one', 'purge1@example.com');
      const mine2 = await mk('PWPURGE_100% role two', 'purge2@example.com');
      const lookalike = await mk('PWPURGEX100Y not mine', 'purge3@example.com');                // matches only if '_' / '%' were wildcards
      const other = await mk('Somebody else', 'someone@example.com');

      const removed = await purgeByTitlePrefix(db, 'PWPURGE_100%', ['purge1@example.com']);
      expect(removed).toBe(2);
      const left = async (t: string, col: string, ids: string[]) => (await scalar(`SELECT count(*)::int AS n FROM ${t} WHERE ${col} = ANY($1::text[])`, [ids])).n;
      for (const m of [mine1, mine2]) {
        expect(await left('roles', 'id', [m.role])).toBe(0);
        expect(await left('applications', 'id', [m.app])).toBe(0);
        expect(await left('pending_actions', 'application_id', [m.app])).toBe(0);
        expect(await left('activity_log', 'application_id', [m.app])).toBe(0);
      }
      expect(await left('candidates', 'id', [mine1.cand])).toBe(0);                              // matched by its address
      expect(await left('candidates', 'id', [mine2.cand])).toBe(1);                              // no address pattern given for it: kept (its application is gone)
      for (const m of [lookalike, other]) {
        expect(await left('roles', 'id', [m.role])).toBe(1);
        expect(await left('applications', 'id', [m.app])).toBe(1);
        expect(await left('pending_actions', 'application_id', [m.app])).toBe(1);
        expect(await left('candidates', 'id', [m.cand])).toBe(1);
      }
      expect(await purgeByTitlePrefix(db, 'PWPURGE_100%')).toBe(0);                              // idempotent
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // The drift test below is only worth anything if the comparison can SEE a difference. Each kind of structural change is made in a transaction on
  // the replay (DDL rolls back), must show up under its own heading, and must be gone again afterwards; data changes must not show up at all.
  test.describe('the structure comparison notices what differs (and ignores data)', () => {
    const cases: Array<{ heading: string; ddl: string; expectLine: RegExp }> = [
      { heading: 'tables',      ddl: `CREATE TABLE pw_probe_table (x int)`,                               expectLine: /^\[tables\] only in changed: pw_probe_table$/ },
      { heading: 'columns',     ddl: `ALTER TABLE roles ADD COLUMN pw_probe int`,                         expectLine: /^\[columns\] only in changed: roles\.pw_probe integer$/ },
      { heading: 'columns',     ddl: `ALTER TABLE roles ALTER COLUMN priority SET DEFAULT 'P0'`,          expectLine: /^\[columns\] only in (changed|baseline): roles\.priority text NOT NULL DEFAULT 'P[01]'::text$/ },
      { heading: 'columns',     ddl: `ALTER TABLE roles ALTER COLUMN title DROP NOT NULL`,                expectLine: /^\[columns\] only in (changed|baseline): roles\.title text( NOT NULL)?$/ },
      { heading: 'constraints', ddl: `ALTER TABLE applications DROP CONSTRAINT applications_status_check`, expectLine: /^\[constraints\] only in baseline: applications\.applications_status_check CHECK/ },
      { heading: 'indexes',     ddl: `CREATE INDEX pw_probe_idx ON roles (title)`,                        expectLine: /^\[indexes\] only in changed: pw_probe_idx :: CREATE INDEX pw_probe_idx ON public\.roles/ },
      { heading: 'indexes',     ddl: `DROP INDEX idx_roles_status`,                                       expectLine: /^\[indexes\] only in baseline: idx_roles_status :: / },
      { heading: 'functions',   ddl: `CREATE OR REPLACE FUNCTION format_seq_id(seq regclass, prefix TEXT, pad_width INT) RETURNS TEXT AS $$ SELECT prefix || LPAD(nextval(seq)::TEXT, pad_width, '0') $$ LANGUAGE SQL`, expectLine: /^\[functions\] only in (changed|baseline): format_seq_id\(seq regclass, prefix text, pad_width integer\) md5:[0-9a-f]{32}$/ },
      { heading: 'triggers',    ddl: `DROP TRIGGER roles_updated_at ON roles`,                            expectLine: /^\[triggers\] only in baseline: roles\.roles_updated_at :: / },
      { heading: 'sequences',   ddl: `ALTER SEQUENCE seq_role INCREMENT BY 2`,                            expectLine: /^\[sequences\] only in (changed|baseline): seq_role start=8 inc=[12] / },
      { heading: 'rowSecurity', ddl: `ALTER TABLE sourcing_plans DISABLE ROW LEVEL SECURITY`,             expectLine: /^\[rowSecurity\] only in (changed|baseline): sourcing_plans rls=(true|false)$/ },
      { heading: 'policies',    ddl: `CREATE POLICY pw_probe ON roles USING (true)`,                      expectLine: /^\[policies\] only in changed: roles\.pw_probe$/ },
    ];

    for (const c of cases) {
      test(`a ${c.heading} change is reported: ${c.ddl.slice(0, 70)}`, async () => {
        const baseline = await schemaFingerprint(db);
        await db.query('BEGIN');
        let changed: Awaited<ReturnType<typeof schemaFingerprint>>;
        try {
          await db.query(c.ddl);
          changed = await schemaFingerprint(db);
        } finally {
          await db.query('ROLLBACK');
        }
        const diff = diffFingerprints(baseline, changed, ['baseline', 'changed']);
        expect(diff.length, diff.join('\n')).toBeGreaterThanOrEqual(1);
        expect(diff.some(l => c.expectLine.test(l)), `expected a line like ${c.expectLine} in:\n${diff.join('\n')}`).toBe(true);
        const allowed = c.heading === 'tables' ? ['tables', 'columns', 'rowSecurity'] : [c.heading];      // a new table brings its columns and its RLS flag
        expect(diff.every(l => allowed.some(h => l.startsWith(`[${h}]`))), `only ${allowed.join(', ')} may differ:\n${diff.join('\n')}`).toBe(true);
        expect(diffFingerprints(baseline, await schemaFingerprint(db), ['baseline', 'after rollback'])).toEqual([]);
      });
    }

    test('rows and sequence positions are NOT structure: inserting data and moving a sequence changes nothing in the fingerprint', async () => {
      const baseline = await schemaFingerprint(db);
      await db.query('BEGIN');
      try {
        await db.query(`INSERT INTO agencies (name) VALUES ('Fingerprint probe')`);
        await db.query(`SELECT setval('seq_agency', (SELECT last_value FROM seq_agency) + 5)`);
        expect(diffFingerprints(baseline, await schemaFingerprint(db))).toEqual([]);
      } finally {
        await db.query('ROLLBACK');
      }
    });

    test('diffFingerprints names which side has the line, in the order the labels were given, and is empty for identical input', async () => {
      const a = await schemaFingerprint(db);
      const b = { ...a, columns: [...a.columns, 'zzz.extra integer'], tables: a.tables.filter(t => t !== 'users') };
      expect(diffFingerprints(a, a)).toEqual([]);
      expect(diffFingerprints(a, b, ['left', 'right'])).toEqual(['[tables] only in left: users', '[columns] only in right: zzz.extra integer']);
      expect(diffFingerprints(b, a, ['x', 'y'])).toEqual(['[tables] only in y: users', '[columns] only in x: zzz.extra integer']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('three-place drift: the database under test against the replay', () => {
    test('the structure of the live test database equals the structure schema.sql produces (columns, constraints, indexes, functions, triggers, sequences, RLS)', async () => {
      const live = await schemaFingerprint(admin);
      const replayed = await schemaFingerprint(db);
      const diff = diffFingerprints(live, replayed, ['live database', `replay (${replayName})`]);
      expect(diff, `The database under test has drifted from backend/src/db/schema.sql (or the file from the database):\n${diff.join('\n')}`).toEqual([]);
    });

    test('no replay database is left behind by this spec except the one it is still using', async () => {
      const { rows } = await admin.query(`SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY 1`, [`${REPLAY_DB_PREFIX}%`]);
      expect(rows.map(r => r.datname)).toEqual([replayName]);
    });
  });
});
