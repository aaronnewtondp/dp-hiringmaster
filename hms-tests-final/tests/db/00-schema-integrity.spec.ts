// ─────────────────────────────────────────────────────────────────────────────
// Schema integrity — regression tests for two "Security — Immediate" fixes
// from ROADMAP.md:
//   1. eval_questions / comp_benchmarks used to share ONE sequence
//      (seq_refcheck), which caused duplicate-key crashes in production.
//      Each now has its own dedicated sequence (seq_eval_question,
//      seq_comp_benchmark) — verified here both at the raw-SQL level and via
//      a concurrent-POST application-level regression test.
//   2. GIN indexes on array columns used for candidate/application filtering
//      (parsed_skills, parsed_industries, hr_tags, AI scoring arrays) exist.
//
// INTENTIONALLY LOCAL-ONLY: this file opens a direct Postgres connection to
// the local Docker Postgres instance using hardcoded local-dev credentials
// (see docker-compose.yml). It must never be pointed at a production
// database and is deliberately excluded from `test:prod` (that script only
// runs tests/smoke, which is read-only and API-only — no direct DB access,
// ever, against production).
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed, uid } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';

test.describe('Schema integrity (local Postgres, direct connection)', () => {
  let client: Client;

  test.beforeAll(async () => {
    client = new Client({ connectionString: LOCAL_DB_URL });
    await client.connect();
  });

  test.afterAll(async () => {
    await client.end();
  });

  test.describe('Dedicated sequences — seq_eval_question / seq_comp_benchmark', () => {

    test('both dedicated sequences exist as separate DB objects', async () => {
      const res = await client.query(
        `SELECT COUNT(*) FROM pg_class
         WHERE relkind='S' AND relname IN ('seq_eval_question','seq_comp_benchmark')`
      );
      expect(Number(res.rows[0].count)).toBe(2);
    });

    test('sequences are independently queryable without collision', async () => {
      // Note: nextval() advances are NOT transactional in Postgres — a
      // surrounding BEGIN/ROLLBACK would NOT undo these increments (this is
      // intentional Postgres behavior: sequences never block concurrent
      // transactions on each other). So this permanently consumes a couple of
      // values from each sequence, same as any real INSERT would — that's
      // fine, IDs are cheap and this table's ID space isn't meaningfully
      // scarce.
      const res = await client.query(
        `SELECT nextval('seq_eval_question') AS eval_val, nextval('seq_comp_benchmark') AS comp_val`
      );
      const { eval_val, comp_val } = res.rows[0];
      // The real point: both sequences exist and can be advanced independently
      // in the same statement without any duplicate-key style collision (the
      // old shared-sequence bug). They need not be equal or adjacent.
      expect(eval_val).toBeTruthy();
      expect(comp_val).toBeTruthy();

      // Confirm they really are two independent counters, not the same
      // sequence aliased twice: advancing one again must not perturb the
      // other's next value in lockstep off of the first pair.
      const res2 = await client.query(
        `SELECT nextval('seq_eval_question') AS eval_val2, nextval('seq_comp_benchmark') AS comp_val2`
      );
      const { eval_val2, comp_val2 } = res2.rows[0];
      expect(Number(eval_val2)).toBe(Number(eval_val) + 1);
      expect(Number(comp_val2)).toBe(Number(comp_val) + 1);
    });
  });

  test.describe('Application-level regression: concurrent POST /api/eval-questions', () => {

    test('~15 concurrent creates all succeed with unique Q-series IDs (no 500s, no duplicate IDs)', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);

      const CONCURRENCY = 15;
      const requests = Array.from({ length: CONCURRENCY }, (_, i) =>
        api.post('/api/eval-questions', {
          evaluation_area: 'Technical',
          question_text:   `Concurrent regression test question ${uid()} #${i}`,
        })
      );
      const responses = await Promise.all(requests);

      for (const res of responses) {
        expect(res.status()).toBe(201);
      }

      const bodies = await Promise.all(responses.map(res => res.json()));
      const ids = bodies.map(b => b.question.id);

      for (const id of ids) {
        // At least 3 digits, not exactly 3 — ids grow past their pad width
        // rather than truncating once the sequence crosses it (schema.sql's
        // format_seq_id(), 2026-09-05).
        expect(id).toMatch(/^Q\d{3,}$/);
      }

      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(CONCURRENCY);
    });
  });

  test.describe('GIN indexes on array columns', () => {

    test('expected GIN indexes exist on candidates and applications', async () => {
      const res = await client.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE indexdef ILIKE '%gin%'`
      );
      const indexNames = res.rows.map(r => r.indexname);

      const expected = [
        'idx_candidates_skills',              // candidates.parsed_skills
        'idx_candidates_industries',          // candidates.parsed_industries
        'idx_candidates_tags',                // candidates.hr_tags
        'idx_applications_ai_skills_matched', // applications.ai_skills_matched
        'idx_applications_score_red_flags',   // applications.score_red_flags
      ];

      for (const name of expected) {
        expect(indexNames).toContain(name);
      }
    });
  });
});

// ─── Sourcing module schema (docs/SourcingModule_PRD_v2.md) ──────────────────────
// The module's correctness rests on the database, not on the engine's in-process throttle: a partial unique index over EVERY
// non-terminal exception status stops two concurrent engine runs (or a run racing a person's snooze) from creating a
// duplicate, and RLS (no policies) keeps PostgREST/anon access out of tables that hold plan notes and reasons.
test.describe('Sourcing module schema (local Postgres, direct connection)', () => {
  let client: Client;
  const TABLES = ['sourcing_settings', 'sourcing_plans', 'sourcing_plan_channels', 'sourcing_commitments', 'sourcing_commitment_log',
                  'sourcing_evidence', 'sourcing_exceptions', 'sourcing_plan_changes'];

  test.beforeAll(async () => { client = new Client({ connectionString: LOCAL_DB_URL }); await client.connect(); });
  test.afterAll(async () => { await client.end(); });

  test('all eight tables exist and every one has row level security enabled', async () => {
    const { rows } = await client.query(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relkind = 'r' AND relname = ANY($1) ORDER BY relname`, [TABLES]);
    expect(rows.map(r => r.relname)).toEqual([...TABLES].sort());
    expect(rows.every(r => r.relrowsecurity === true)).toBe(true);
  });

  test('live-exception uniqueness is a partial index over open, snoozed AND blocked', async () => {
    const { rows } = await client.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_sourcing_exceptions_live'`);
    expect(rows).toHaveLength(1);
    const def = rows[0].indexdef as string;
    expect(def).toContain('UNIQUE');
    for (const s of ['open', 'snoozed', 'blocked']) expect(def).toContain(`'${s}'`);
    expect(def).not.toContain(`'resolved'`);
  });

  test('the database itself refuses a duplicate live exception, but a resolved one frees the slot', async () => {
    await client.query('BEGIN');
    try {
      const plan = (await client.query(
        `INSERT INTO sourcing_plans (role_id) SELECT id FROM roles ORDER BY id LIMIT 1
         ON CONFLICT (role_id) DO UPDATE SET role_id = EXCLUDED.role_id RETURNING id`)).rows[0].id;
      const ins = (status: string) => client.query(
        `INSERT INTO sourcing_exceptions (plan_id, channel, type, subject_key, status) VALUES ($1, 'LinkedIn', 'CHANNEL_NOT_ACTIVATED', '', $2) RETURNING id`, [plan, status]);
      const attempt = async (status: string) => {
        await client.query('SAVEPOINT s');
        try { const r = await ins(status); await client.query('RELEASE SAVEPOINT s'); return { ok: true as const, id: r.rows[0].id }; }
        catch (e) { await client.query('ROLLBACK TO SAVEPOINT s'); return { ok: false as const, code: (e as { code?: string }).code }; }
      };

      const first = await attempt('open');
      expect(first.ok).toBe(true);
      for (const s of ['open', 'snoozed', 'blocked']) expect(await attempt(s)).toEqual({ ok: false, code: '23505' });   // unique_violation
      await client.query(`UPDATE sourcing_exceptions SET status = 'resolved', resolved_at = NOW() WHERE id = $1`, [(first as { id: string }).id]);
      expect((await attempt('open')).ok).toBe(true);                                                                    // resolved no longer holds the slot
    } finally {
      await client.query('ROLLBACK');
    }
  });

  test('a plan row is deleted with its role (ON DELETE CASCADE) and one role has at most one plan', async () => {
    const { rows } = await client.query(
      `SELECT confdeltype FROM pg_constraint WHERE conrelid = 'sourcing_plans'::regclass AND contype = 'f' AND confrelid = 'roles'::regclass`);
    expect(rows[0].confdeltype).toBe('c');
    const uniq = await client.query(`SELECT 1 FROM pg_constraint WHERE conrelid = 'sourcing_plans'::regclass AND contype = 'u'`);
    expect(uniq.rowCount).toBeGreaterThan(0);
  });
});
