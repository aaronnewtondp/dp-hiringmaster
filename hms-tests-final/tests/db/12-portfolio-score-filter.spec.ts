// ─────────────────────────────────────────────────────────────────────────────
// GET /api/applications?min_portfolio_score=N — the server side of the "Portfolio >= 7.5" filter in My Tasks'
// Ready for Review. The portfolio score (the 9th ResumeIQ dimension) is a WHOLE NUMBER 0-10 stored in
// applications.score_portfolio, set only for roles that get a portfolio review (roles.portfolio_analysis_enabled),
// so 7.5 means 8 or more in practice. Also: GET /api/roles/filter-options reports which roles have portfolio review
// (the UI offers the filter only where it can match). Needs scores set directly, so it talks to Postgres.
// INTENTIONALLY LOCAL-ONLY, like the other tests/db specs.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';
type Req = Parameters<typeof authed>[0];

test.describe('Portfolio score filter (min_portfolio_score)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(60_000);

  let client: Client;
  const roleIds: string[] = [];
  const candidateIds: string[] = [];
  let withReview = '', withoutReview = '';
  const app: Record<string, string> = {};            // label -> application id

  test.beforeAll(async () => {
    client = new Client({ connectionString: LOCAL_DB_URL });
    await client.connect();

    const newRole = async (label: string, portfolio: boolean) => {
      const { rows } = await client.query(
        `INSERT INTO roles (title, department, hiring_manager_name, priority, status, location, employment_type, start_date, portfolio_analysis_enabled)
         VALUES ($1, 'Product/QA', 'Alex', 'P1', 'Live – Sourcing', 'Gurgaon', 'Full-Time / Permanent', CURRENT_DATE - 10, $2) RETURNING id`,
        [`PortfolioFilter ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, portfolio]);
      roleIds.push(rows[0].id);
      return rows[0].id as string;
    };
    const newApp = async (label: string, roleId: string, score: number | null, status = 'Active') => {
      const { rows: c } = await client.query(
        `INSERT INTO candidates (full_name, email) VALUES ($1, $2) RETURNING id`,
        [`PF Candidate ${label}`, `pf+${label}${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`]);
      candidateIds.push(c[0].id);
      const { rows } = await client.query(
        `INSERT INTO applications (candidate_id, role_id, stage, status, score_avg, score_portfolio) VALUES ($1, $2, 'Applied and Screened', $3, 6, $4) RETURNING id`,
        [c[0].id, roleId, status, score]);
      app[label] = rows[0].id;
    };

    withReview = await newRole('with', true);
    withoutReview = await newRole('without', false);
    for (const s of [10, 9, 8, 7, 1, 0]) await newApp(`s${s}`, withReview, s);
    await newApp('none', withReview, null);                               // review not done / no portfolio score
    await newApp('rejected9', withReview, 9, 'Rejected');
    await newApp('otherRole', withoutReview, null);
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);     // pending_actions.application_id is unindexed: each cascading delete scans it
    if (roleIds.length) {
      await client.query(`DELETE FROM activity_log WHERE role_id = ANY($1)`, [roleIds]);
      await client.query(`DELETE FROM applications WHERE role_id = ANY($1)`, [roleIds]);
      await client.query(`DELETE FROM pending_actions WHERE role_id = ANY($1)`, [roleIds]);
      await client.query(`DELETE FROM roles WHERE id = ANY($1)`, [roleIds]);
    }
    if (candidateIds.length) await client.query(`DELETE FROM candidates WHERE id = ANY($1)`, [candidateIds]);
    await client.end();
  });

  const idsFor = async (request: Req, qs: string, who: 'hr' | 'hm_alex' | 'leadership' = 'hr'): Promise<string[]> => {
    const res = await authed(request, await getToken(request, who)).get(`/api/applications?limit=500&${qs}`);
    expect(res.status(), qs).toBe(200);
    return ((await res.json()).applications as { id: string }[]).map(a => a.id);
  };
  const labels = (ids: string[]) => Object.entries(app).filter(([, id]) => ids.includes(id)).map(([l]) => l).sort();

  test('7.5 keeps 8, 9 and 10 only: the whole-number scores 7 and below, and "no portfolio score", are out', async ({ request }) => {
    const ids = await idsFor(request, `role_id=${withReview}&status=Active&min_portfolio_score=7.5`);
    expect(labels(ids)).toEqual(['s10', 's8', 's9']);
  });

  test('the threshold is inclusive and works at every boundary', async ({ request }) => {
    expect(labels(await idsFor(request, `role_id=${withReview}&status=Active&min_portfolio_score=8`))).toEqual(['s10', 's8', 's9']);
    expect(labels(await idsFor(request, `role_id=${withReview}&status=Active&min_portfolio_score=8.5`))).toEqual(['s10', 's9']);
    expect(labels(await idsFor(request, `role_id=${withReview}&status=Active&min_portfolio_score=10`))).toEqual(['s10']);
    expect(labels(await idsFor(request, `role_id=${withReview}&status=Active&min_portfolio_score=10.5`))).toEqual([]);
    expect(labels(await idsFor(request, `role_id=${withReview}&status=Active&min_portfolio_score=7`))).toEqual(['s10', 's7', 's8', 's9']);
  });

  test('a score of 0 is a score (it matches min 0), but "no portfolio score" never matches anything', async ({ request }) => {
    const ids = await idsFor(request, `role_id=${withReview}&status=Active&min_portfolio_score=0`);
    expect(labels(ids)).toEqual(['s0', 's1', 's10', 's7', 's8', 's9']);
    expect(labels(ids)).not.toContain('none');
    expect(labels(await idsFor(request, `role_id=${withReview}&status=Active&min_portfolio_score=-5`))).toEqual(['s0', 's1', 's10', 's7', 's8', 's9']);
  });

  test('without the parameter nothing changes: every candidate of the role is still listed, scored or not', async ({ request }) => {
    const ids = await idsFor(request, `role_id=${withReview}&status=Active`);
    expect(labels(ids)).toEqual(['none', 's0', 's1', 's10', 's7', 's8', 's9']);
  });

  test('it combines with the other filters (status, role) instead of replacing them', async ({ request }) => {
    // the Rejected candidate scored 9 but the status filter still excludes it
    expect(labels(await idsFor(request, `role_id=${withReview}&status=Active&min_portfolio_score=7.5`))).not.toContain('rejected9');
    expect(labels(await idsFor(request, `role_id=${withReview}&status=Rejected&min_portfolio_score=7.5`))).toEqual(['rejected9']);
    // a role without portfolio review has no scores, so the filter empties it
    expect(await idsFor(request, `role_id=${withoutReview}&status=Active&min_portfolio_score=7.5`)).toEqual([]);
    expect(labels(await idsFor(request, `role_id=${withoutReview}&status=Active`))).toEqual(['otherRole']);
  });

  test('applied before the row cap: a small limit returns qualifying rows, never rows the filter excludes', async ({ request }) => {
    const res = await authed(request, await getToken(request, 'hr')).get(`/api/applications?limit=2&role_id=${withReview}&status=Active&min_portfolio_score=7.5`);
    const rows = (await res.json()).applications as { id: string; score_portfolio: number }[];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.score_portfolio).toBeGreaterThanOrEqual(7.5);
  });

  test('a value that is not a plain number is a 400 (a silently ignored filter would list everyone while the UI says it is on)', async ({ request }) => {
    const api = authed(request, await getToken(request, 'hr'));
    for (const bad of ['abc', '', '%20', 'NaN', 'Infinity', '-Infinity', '1e999', '7.5;drop', '7.5&min_portfolio_score=1', '[7.5]']) {
      const res = await api.get(`/api/applications?min_portfolio_score=${bad}`);
      expect(res.status(), JSON.stringify(bad)).toBe(400);
      expect((await res.json()).error).toMatch(/min_portfolio_score/);
    }
  });

  test('every persona that can open Ready for Review can use it (it is not HR-gated)', async ({ request }) => {
    for (const who of ['hr', 'leadership', 'hm_alex'] as const) {
      expect(labels(await idsFor(request, `role_id=${withReview}&status=Active&min_portfolio_score=7.5`, who)), who).toEqual(['s10', 's8', 's9']);
    }
  });

  test('role filter options say which roles get a portfolio review', async ({ request }) => {
    const body = await (await authed(request, await getToken(request, 'hr')).get('/api/roles/filter-options')).json();
    const byId = new Map((body.roles as { id: string; portfolio_analysis_enabled: boolean }[]).map(r => [r.id, r.portfolio_analysis_enabled]));
    expect(byId.get(withReview)).toBe(true);
    expect(byId.get(withoutReview)).toBe(false);
    for (const v of byId.values()) expect(typeof v).toBe('boolean');
  });
});
