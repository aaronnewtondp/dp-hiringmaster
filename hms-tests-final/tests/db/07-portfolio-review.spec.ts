// ─────────────────────────────────────────────────────────────────────────────
// Portfolio review — the 9th ResumeIQ dimension for portfolio-enabled roles
// (roles.portfolio_analysis_enabled; Senior UX/Product Designer in production).
//
// What this file covers: the schema, the route gating (who may re-run a review,
// which roles/applications qualify), the machine-facing backfill route's
// secret check, and the creation-time hook's behaviour when there is NO
// resume to read. What it deliberately does NOT do: open a browser or call the
// vision model — that path (backend/src/services/portfolio/run.ts) is covered
// by the Vitest unit suites for its pure parts and was verified end to end
// against real portfolios by hand; putting live third-party sites and paid
// model calls into an automated suite would make it slow, flaky and costly.
//
// INTENTIONALLY LOCAL-ONLY: opens a direct Postgres connection to flip the
// role flag (no API sets it — it is an admin-only switch by design).
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed, uid, BASE, ROLE_INGEST_SECRET } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';

test.describe('Portfolio review (local Postgres + API)', () => {
  let db: Client;
  test.beforeAll(async () => { db = new Client({ connectionString: LOCAL_DB_URL }); await db.connect(); });
  test.afterAll(async () => { await db.end(); });

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

    test('portfolio_analysis_status only accepts the six defined states', async () => {
      const { rows } = await db.query(`SELECT id FROM applications LIMIT 1`);
      await expect(db.query(`UPDATE applications SET portfolio_analysis_status='banana' WHERE id=$1`, [rows[0].id])).rejects.toThrow(/portfolio_status_check/);
      for (const ok of ['pending', 'running', 'completed', 'failed', 'no_portfolio', 'inaccessible']) {
        await db.query('BEGIN');
        await db.query(`UPDATE applications SET portfolio_analysis_status=$1 WHERE id=$2`, [ok, rows[0].id]);
        await db.query('ROLLBACK');
      }
    });

    test('roles default to portfolio review OFF', async () => {
      const { rows } = await db.query(`SELECT count(*) FILTER (WHERE portfolio_analysis_enabled IS NOT TRUE) AS off, count(*) AS total FROM roles WHERE id IN ('R001','R002','R003','R004','R005','R006')`);
      expect(Number(rows[0].off)).toBe(Number(rows[0].total));
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
      const created = await authed(request, hr).post('/api/candidates', { full_name: `Plain Role ${uid()}`, email: `pf+${uid()}@example.com`, role_id: 'R006' });
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

  test.describe('creation-time hook on a portfolio-enabled role', () => {
    let roleId: string;

    test.beforeAll(async ({ request }) => {
      const hr = await getToken(request, 'hr');
      const res = await authed(request, hr).post('/api/roles', { title: `Portfolio Role ${uid()}`, priority: 'P2' });
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

    test('a candidate with NO readable resume gets the base score untouched and no portfolio penalty', async ({ request }) => {
      const hr = await getToken(request, 'hr');
      const created = await authed(request, hr).post('/api/candidates', { full_name: `No Resume ${uid()}`, email: `pf+${uid()}@example.com`, role_id: roleId });
      expect(created.status()).toBe(201);
      const appId = (await created.json()).application.id;

      const { rows } = await db.query(
        `SELECT score_avg, score_portfolio, portfolio_analysis_status, portfolio_analysis_error,
                (score_technical + score_experience + score_industry_fit + score_culture_fit + score_role_alignment + score_trajectory + score_leadership + score_communication) AS sum8
         FROM applications WHERE id=$1`, [appId]);
      const r = rows[0];
      // An unreadable resume says nothing about whether a portfolio exists, so the
      // 9th dimension is simply not applied — the average is still the plain 8-dimension mean.
      expect(r.portfolio_analysis_status).toBe('no_portfolio');
      expect(r.score_portfolio).toBeNull();
      expect(r.portfolio_analysis_error).toMatch(/could not be read/i);
      expect(Number(r.score_avg)).toBeCloseTo(Math.round((Number(r.sum8) / 8) * 10) / 10, 1);
    });

    test('an HR re-run on a scored application re-checks the resume and answers 202', async ({ request }) => {
      const hr = await getToken(request, 'hr');
      const created = await authed(request, hr).post('/api/candidates', { full_name: `Rerun ${uid()}`, email: `pf+${uid()}@example.com`, role_id: roleId });
      const appId = (await created.json()).application.id;
      const rerun = await authed(request, hr).post(`/api/applications/${appId}/portfolio-analysis`, {});
      expect(rerun.status()).toBe(202);
      expect((await rerun.json()).status).toBe('no_portfolio');
    });

    test('a hiring manager can read the review but cannot re-run it', async ({ request }) => {
      const hr = await getToken(request, 'hr');
      const hm = await getToken(request, 'hm_alex');
      const created = await authed(request, hr).post('/api/candidates', { full_name: `HM Gate ${uid()}`, email: `pf+${uid()}@example.com`, role_id: roleId });
      const appId = (await created.json()).application.id;
      expect((await authed(request, hm).get(`/api/applications/${appId}/portfolio-analysis`)).status()).toBe(200);
      expect((await authed(request, hm).post(`/api/applications/${appId}/portfolio-analysis`, {})).status()).toBe(403);
    });

    test('re-run is refused while a review is genuinely running', async ({ request }) => {
      const hr = await getToken(request, 'hr');
      const created = await authed(request, hr).post('/api/candidates', { full_name: `Busy ${uid()}`, email: `pf+${uid()}@example.com`, role_id: roleId });
      const appId = (await created.json()).application.id;
      await db.query(`UPDATE applications SET portfolio_analysis_status='running', portfolio_started_at=NOW() WHERE id=$1`, [appId]);
      const rerun = await authed(request, hr).post(`/api/applications/${appId}/portfolio-analysis`, {});
      expect(rerun.status()).toBe(409);
      // ...and it changed nothing: a live job's state must never be stomped on.
      const { rows } = await db.query(`SELECT portfolio_analysis_status FROM applications WHERE id=$1`, [appId]);
      expect(rows[0].portfolio_analysis_status).toBe('running');
    });

    test('a review stuck in "running" past the function limit (killed job) can be re-run', async ({ request }) => {
      const hr = await getToken(request, 'hr');
      const created = await authed(request, hr).post('/api/candidates', { full_name: `Dead job ${uid()}`, email: `pf+${uid()}@example.com`, role_id: roleId });
      const appId = (await created.json()).application.id;
      // A worker killed by a timeout/OOM never runs its `finally`, so the row would
      // otherwise say "running" forever and refuse every retry.
      await db.query(`UPDATE applications SET portfolio_analysis_status='running', portfolio_started_at=NOW() - INTERVAL '11 minutes' WHERE id=$1`, [appId]);
      const rerun = await authed(request, hr).post(`/api/applications/${appId}/portfolio-analysis`, {});
      expect(rerun.status()).toBe(202);
      const { rows } = await db.query(`SELECT portfolio_analysis_status FROM applications WHERE id=$1`, [appId]);
      expect(rows[0].portfolio_analysis_status).not.toBe('running');
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
