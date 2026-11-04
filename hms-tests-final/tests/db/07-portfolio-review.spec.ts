// ─────────────────────────────────────────────────────────────────────────────
// Portfolio review — the 9th ResumeIQ dimension for portfolio-enabled roles
// (roles.portfolio_analysis_enabled; Senior UX/Product Designer in production).
//
// What this file covers: the schema, the route gating (who may re-run a review,
// which roles/applications qualify), the machine-facing backfill route's
// secret check, and what the re-run does when there is NO resume to read.
// What it deliberately does NOT do: open a browser or call the
// vision model — that path (backend/src/services/portfolio/run.ts) is covered
// by the Vitest unit suites for its pure parts and was verified end to end
// against real portfolios by hand; putting live third-party sites and paid
// model calls into an automated suite would make it slow, flaky and costly.
//
// NO CREDENTIALS NEEDED. A review is only allowed once the base ResumeIQ score exists (score_avg is set), and
// producing that score calls the model. Every test that needs "a scored application" therefore writes the eight base
// scores and their average by SQL (helpers/db-specs.ts setBaseScores — the way db/15 builds its applications), so the
// whole file runs with no Anthropic key. The ONE thing that does need the model is the creation-time hook itself
// (runResumeIQScoring -> preparePortfolioReview): it has a twin tagged @live below, skipped unless TEST_LIVE=1.
//
// INTENTIONALLY LOCAL-ONLY: opens a direct Postgres connection to flip the
// role flag (no API sets it — it is an admin-only switch by design).
//
// Clean-up: every role this file flags is titled with ROLE_PREFIX and every candidate it makes has an address like
// pw07+<id>@example.com, so afterAll — and the start of the next run, after a killed one — removes them all by that
// prefix (a role must never stay behind with portfolio_analysis_enabled = true).
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import type { Client } from 'pg';
import { getToken, authed, uid, BASE, ROLE_INGEST_SECRET } from '../helpers/api';
import { newClient } from '../helpers/db';
import { purgeByTitlePrefix, setBaseScores, BASE_SCORE_AVG } from '../helpers/db-specs';

const ROLE_PREFIX = 'PW db07 Portfolio Role';
const EMAIL_LIKE = 'pw07+%@example.com';
const email = () => `pw07+${uid()}@example.com`;

// The seven states of applications_portfolio_status_check ('unreviewable', the seventh, came with the marketing work-sample review).
const STATUSES = ['pending', 'running', 'completed', 'failed', 'no_portfolio', 'inaccessible', 'unreviewable'];

test.describe('Portfolio review (local Postgres + API)', () => {
  let db: Client;
  test.beforeAll(async () => {
    db = newClient();
    await db.connect();
    await purgeByTitlePrefix(db, ROLE_PREFIX, [EMAIL_LIKE]);        // leftovers of a run that was killed
  });
  test.afterAll(async () => {
    test.setTimeout(120_000);
    try { await purgeByTitlePrefix(db, ROLE_PREFIX, [EMAIL_LIKE]); } finally { await db.end(); }
  });

  test.describe('schema', () => {
    test('the roles flag, application columns and analyses table exist', async () => {
      const cols = await db.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema='public' AND (
           (table_name='roles' AND column_name='portfolio_analysis_enabled') OR
           (table_name='applications' AND column_name IN
             ('portfolio_urls','portfolio_analysis_status','portfolio_analysis_error','portfolio_started_at','portfolio_analyzed_at','score_portfolio','score_portfolio_note')) OR
           (table_name='portfolio_analyses' AND column_name IN ('application_id','analysis')))`);
      expect(cols.rowCount).toBe(1 + 7 + 2);
    });

    test('portfolio_analysis_status only accepts the seven defined states (and NULL)', async () => {
      // an application of its own: a fresh database has none, and the CHECK is tested on a real row
      await db.query('BEGIN');
      try {
        const cand = await db.query(`INSERT INTO candidates (full_name, email) VALUES ('PW07 status probe', $1) RETURNING id`, [email()]);
        const app = await db.query(`INSERT INTO applications (candidate_id, role_id) VALUES ($1, 'R006') RETURNING id`, [cand.rows[0].id]);
        const id = app.rows[0].id as string;
        for (const bad of ['banana', 'Completed', '', ' pending', 'done']) {
          await db.query('SAVEPOINT s');
          await expect(db.query(`UPDATE applications SET portfolio_analysis_status=$1 WHERE id=$2`, [bad, id]), JSON.stringify(bad)).rejects.toThrow(/portfolio_status_check/);
          await db.query('ROLLBACK TO SAVEPOINT s');
        }
        for (const ok of STATUSES) {
          await db.query(`UPDATE applications SET portfolio_analysis_status=$1 WHERE id=$2`, [ok, id]);
        }
        await db.query(`UPDATE applications SET portfolio_analysis_status=NULL WHERE id=$1`, [id]);
      } finally {
        await db.query('ROLLBACK');
      }
    });

    test('roles default to portfolio review OFF', async () => {
      const { rows } = await db.query(`SELECT count(*) FILTER (WHERE portfolio_analysis_enabled IS NOT TRUE) AS off, count(*) AS total FROM roles WHERE id IN ('R001','R002','R003','R004','R005','R006')`);
      expect(Number(rows[0].total)).toBe(6);
      expect(Number(rows[0].off)).toBe(6);
    });
  });

  test.describe('routes', () => {
    test('GET review for an unknown application is a 404', async ({ request }) => {
      const token = await getToken(request, 'hr');
      expect((await authed(request, token).get('/api/applications/A_DOES_NOT_EXIST/portfolio-analysis')).status()).toBe(404);
    });

    test('GET and POST require authentication', async ({ request }) => {
      expect((await request.get(`${BASE}/api/applications/A0001/portfolio-analysis`)).status()).toBe(401);
      expect((await request.post(`${BASE}/api/applications/A0001/portfolio-analysis`, { data: {} })).status()).toBe(401);
    });

    test('an application on a role WITHOUT portfolio review has no review and cannot be re-run', async ({ request }) => {
      const hr = await getToken(request, 'hr');
      const created = await authed(request, hr).post('/api/candidates', { full_name: `Plain Role ${uid()}`, email: email(), role_id: 'R006' });
      const appId = (await created.json()).application.id;

      const get = await authed(request, hr).get(`/api/applications/${appId}/portfolio-analysis`);
      expect(get.status()).toBe(200);
      const body = await get.json();
      expect(body.status).toBeNull();
      expect(body.analysis).toBeNull();

      const rerun = await authed(request, hr).post(`/api/applications/${appId}/portfolio-analysis`, {});
      expect(rerun.status()).toBe(400);
      expect((await rerun.json()).error).toMatch(/not enabled/i);
    });

    test('the batch backfill route rejects a missing or wrong secret', async ({ request }) => {
      const noSecret = await request.post(`${BASE}/api/applications/portfolio-backfill`, { data: { role_id: 'R007', dry_run: true } });
      expect(noSecret.status()).toBe(401);
      const wrong = await request.post(`${BASE}/api/applications/portfolio-backfill`, { data: { role_id: 'R007', dry_run: true }, headers: { 'x-ingest-secret': 'nope' } });
      expect(wrong.status()).toBe(401);
    });
  });

  test.describe('re-run and creation on a portfolio-enabled role', () => {
    let roleId: string;

    /** A candidate with NO resume on file, applied to the flagged role through the real API. Unscored until a test scores it. */
    async function newApp(request: import('@playwright/test').APIRequestContext, label: string) {
      const hr = await getToken(request, 'hr');
      const created = await authed(request, hr).post('/api/candidates', { full_name: `${label} ${uid()}`, email: email(), role_id: roleId });
      expect(created.status()).toBe(201);
      const body = await created.json();
      return { hr, appId: body.application.id as string, resumeiq: body.resumeiq as { scored: boolean } | undefined };
    }

    const state = async (appId: string) =>
      (await db.query(
        `SELECT score_avg, score_portfolio, portfolio_analysis_status AS status, portfolio_analysis_error AS error, portfolio_started_at,
                (score_technical + score_experience + score_industry_fit + score_culture_fit + score_role_alignment + score_trajectory + score_leadership + score_communication) AS sum8
           FROM applications WHERE id=$1`, [appId])).rows[0];

    test.beforeAll(async ({ request }) => {
      const hr = await getToken(request, 'hr');
      const res = await authed(request, hr).post('/api/roles', { title: `${ROLE_PREFIX} ${uid()}`, priority: 'P2' });
      roleId = (await res.json()).role.id;
      await db.query(`UPDATE roles SET portfolio_analysis_enabled=true WHERE id=$1`, [roleId]);
    });

    test('the batch backfill route dry-run reports eligible applications without changing anything', async ({ request }) => {
      const res = await request.post(`${BASE}/api/applications/portfolio-backfill`, {
        data: { role_id: roleId, statuses: ['Active'], limit: 3, dry_run: true },
        headers: { 'x-ingest-secret': ROLE_INGEST_SECRET },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.dry_run).toBe(true);
      expect(body.processed).toBe(0);
      expect(body.results).toEqual([]);
    });

    test('creation WITHOUT a working model leaves the application unscored: no portfolio status, no score, nothing queued — never a penalty', async ({ request }) => {
      const { appId, resumeiq } = await newApp(request, 'No model');
      test.skip(resumeiq?.scored === true, 'a model key is configured here, so the creation-time hook scored the application: see the @live twin below');
      expect(resumeiq?.scored).toBe(false);
      const r = await state(appId);
      expect(r.score_avg).toBeNull();                        // base ResumeIQ did not run, so the 9th dimension has nothing to attach to
      expect(r.status).toBeNull();
      expect(r.score_portfolio).toBeNull();
      expect(r.error).toBeNull();
      expect(r.portfolio_started_at).toBeNull();
    });

    test('a re-run of an application whose base score has not completed is refused with 409 and changes nothing', async ({ request }) => {
      const { hr, appId, resumeiq } = await newApp(request, 'Unscored');
      test.skip(resumeiq?.scored === true, 'a model key is configured here, so the application was scored on creation');
      const rerun = await authed(request, hr).post(`/api/applications/${appId}/portfolio-analysis`, {});
      expect(rerun.status()).toBe(409);
      expect((await rerun.json()).error).toMatch(/Resume scoring has not completed/i);
      const r = await state(appId);
      expect(r.status).toBeNull();
      expect(r.score_avg).toBeNull();
    });

    test('a scored application with NO readable resume: the re-run settles no_portfolio, scores no portfolio dimension, and leaves the 8-dimension average untouched', async ({ request }) => {
      const { hr, appId } = await newApp(request, 'No resume');
      await setBaseScores(db, appId);
      const before = await state(appId);
      expect(Number(before.score_avg)).toBe(BASE_SCORE_AVG);

      const rerun = await authed(request, hr).post(`/api/applications/${appId}/portfolio-analysis`, {});
      expect(rerun.status()).toBe(202);
      expect(await rerun.json()).toEqual({ status: 'no_portfolio', links: 0, queued: false });

      const r = await state(appId);
      // An unreadable resume says nothing about whether a portfolio exists, so the
      // 9th dimension is simply not applied — the average is still the plain 8-dimension mean.
      expect(r.status).toBe('no_portfolio');
      expect(r.score_portfolio).toBeNull();
      expect(r.error).toMatch(/could not be read/i);
      expect(Number(r.score_avg)).toBeCloseTo(Math.round((Number(r.sum8) / 8) * 10) / 10, 1);
      expect(Number(r.score_avg)).toBe(Number(before.score_avg));
    });

    test('a candidate with NO readable resume gets the base score untouched and no portfolio penalty (the creation-time hook, with a real model) @live', async ({ request }) => {
      const { appId } = await newApp(request, 'No resume live');
      const r = await state(appId);
      // The hook (runResumeIQScoring -> preparePortfolioReview) needs the real model for the base score; only then does it settle the review.
      expect(r.status).toBe('no_portfolio');
      expect(r.score_portfolio).toBeNull();
      expect(r.error).toMatch(/could not be read/i);
      expect(Number(r.score_avg)).toBeCloseTo(Math.round((Number(r.sum8) / 8) * 10) / 10, 1);
    });

    test('an HR re-run on a scored application re-checks the resume and answers 202', async ({ request }) => {
      const { hr, appId } = await newApp(request, 'Rerun');
      await setBaseScores(db, appId);
      const rerun = await authed(request, hr).post(`/api/applications/${appId}/portfolio-analysis`, {});
      expect(rerun.status()).toBe(202);
      expect((await rerun.json()).status).toBe('no_portfolio');
      expect((await state(appId)).status).toBe('no_portfolio');
    });

    test('a hiring manager can read the review but cannot re-run it', async ({ request }) => {
      const hm = await getToken(request, 'hm_alex');
      const { appId } = await newApp(request, 'HM Gate');
      await setBaseScores(db, appId);
      expect((await authed(request, hm).get(`/api/applications/${appId}/portfolio-analysis`)).status()).toBe(200);
      expect((await authed(request, hm).post(`/api/applications/${appId}/portfolio-analysis`, {})).status()).toBe(403);
      expect((await state(appId)).status).toBeNull();                                        // the refused re-run changed nothing
    });

    test('re-run is refused while a review is genuinely running', async ({ request }) => {
      const { hr, appId } = await newApp(request, 'Busy');
      await setBaseScores(db, appId);                                                        // scored, so the 409 below can only come from the running guard
      await db.query(`UPDATE applications SET portfolio_analysis_status='running', portfolio_started_at=NOW() WHERE id=$1`, [appId]);
      const rerun = await authed(request, hr).post(`/api/applications/${appId}/portfolio-analysis`, {});
      expect(rerun.status()).toBe(409);
      expect((await rerun.json()).error).toMatch(/already running/i);
      // ...and it changed nothing: a live job's state must never be stomped on.
      const { rows } = await db.query(`SELECT portfolio_analysis_status FROM applications WHERE id=$1`, [appId]);
      expect(rows[0].portfolio_analysis_status).toBe('running');
    });

    test('a review stuck in "running" past the function limit (killed job) can be re-run', async ({ request }) => {
      const { hr, appId } = await newApp(request, 'Dead job');
      await setBaseScores(db, appId);
      // A worker killed by a timeout/OOM never runs its `finally`, so the row would
      // otherwise say "running" forever and refuse every retry.
      await db.query(`UPDATE applications SET portfolio_analysis_status='running', portfolio_started_at=NOW() - INTERVAL '11 minutes' WHERE id=$1`, [appId]);
      const rerun = await authed(request, hr).post(`/api/applications/${appId}/portfolio-analysis`, {});
      expect(rerun.status()).toBe(202);
      const { rows } = await db.query(`SELECT portfolio_analysis_status FROM applications WHERE id=$1`, [appId]);
      expect(rows[0].portfolio_analysis_status).not.toBe('running');
      expect(rows[0].portfolio_analysis_status).toBe('no_portfolio');                        // no resume: settled at once, not left pending
    });
  });

  test.describe('backfill route guards', () => {
    test('rejects a role that does not exist or has portfolio review switched off', async ({ request }) => {
      const headers = { 'x-ingest-secret': ROLE_INGEST_SECRET };
      const unknown = await request.post(`${BASE}/api/applications/portfolio-backfill`, { data: { role_id: 'R_NOPE' }, headers });
      expect(unknown.status()).toBe(404);
      const off = await request.post(`${BASE}/api/applications/portfolio-backfill`, { data: { role_id: 'R006', dry_run: true }, headers });
      expect(off.status()).toBe(400);
      expect((await off.json()).error).toMatch(/not enabled/i);
    });

    test('requires a role_id', async ({ request }) => {
      const res = await request.post(`${BASE}/api/applications/portfolio-backfill`, { data: {}, headers: { 'x-ingest-secret': ROLE_INGEST_SECRET } });
      expect(res.status()).toBe(400);
    });
  });
});
