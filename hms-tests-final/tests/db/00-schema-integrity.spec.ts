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
        expect(id).toMatch(/^Q\d{3}$/);
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
