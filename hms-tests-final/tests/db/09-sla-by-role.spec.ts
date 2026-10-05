// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dashboard/sla-by-role — the "SLA breaches by role" stacked bar chart.
//
// Same unresolved breach rows as the Hiring Funnel Snapshot, grouped by role and
// then by stage. Real breaches are made the way tests/api/19 does: backdate
// stage_entry_time directly in Postgres, then run the engine on demand with
// POST /api/cron/sla-check (CRON_SECRET). INTENTIONALLY LOCAL-ONLY, like the
// other tests/db specs.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed, createCandidateWithApp, CRON_SECRET, BASE } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';

type Req = Parameters<typeof authed>[0];
type Bar = {
  role_id: string; role_title: string; priority: string; status: string; hiring_manager_name: string | null;
  total: number;
  by_stage: { stage: string; count: number; breach_types: { type: string; owner: string; count: number }[] }[];
};
type Payload = {
  roles: Bar[]; total_breaches: number; not_open_roles: { roles: number; breaches: number }; stages: string[];
};
type SnapshotStage = { stage: string; total: number };

test.describe('GET /api/dashboard/sla-by-role', () => {
  test.describe.configure({ mode: 'serial' });          // they share one set of breaches
  test.setTimeout(90_000);                               // the first dashboard load can run a full SLA sweep

  let client: Client;
  const appIds: string[] = [];
  const candidateIds: string[] = [];
  let r005Status: string | null = null;

  test.beforeAll(async () => {
    client = new Client({ connectionString: LOCAL_DB_URL });
    await client.connect();
    r005Status = (await client.query(`SELECT status FROM roles WHERE id = 'R005'`)).rows[0]?.status ?? null;
  });
  test.afterAll(async () => {
    // R005 is a shared seeded role other specs rely on being open: put it back even if a test above died mid-change
    // (a timeout skips the test's own `finally`).
    if (r005Status) await client.query(`UPDATE roles SET status = $1 WHERE id = 'R005'`, [r005Status]);
    if (appIds.length) {
      await client.query(`DELETE FROM pending_actions WHERE application_id = ANY($1)`, [appIds]);
      await client.query(`DELETE FROM activity_log WHERE application_id = ANY($1)`, [appIds]);
      await client.query(`DELETE FROM applications WHERE id = ANY($1)`, [appIds]);
    }
    if (candidateIds.length) await client.query(`DELETE FROM candidates WHERE id = ANY($1)`, [candidateIds]);
    await client.end();
  });

  /** What the chart counts that the snapshot cannot: breaches on applications at a stage outside the 11 canonical ones. */
  const otherStage = (b: Payload) => b.roles.reduce((n, r) => n + r.by_stage.filter(s => s.stage === 'Other').reduce((m, s) => m + s.count, 0), 0);
  /** bars + roles that are not open − the 'Other' stage = every breach the Hiring Funnel Snapshot counts. */
  const reconciled = (b: Payload) => b.total_breaches + b.not_open_roles.breaches - otherStage(b);

  async function runSlaCheck(request: Req) {
    expect((await authed(request, CRON_SECRET).post('/api/cron/sla-check', {})).status()).toBe(200);
  }
  async function get(request: Req, persona: 'hr' | 'hm_alex' | 'hm_satyadev', qs = ''): Promise<Payload> {
    const res = await authed(request, await getToken(request, persona)).get(`/api/dashboard/sla-by-role${qs}`);
    expect(res.status()).toBe(200);
    return res.json();
  }
  async function snapshotTotal(request: Req, persona: 'hr' | 'hm_alex' | 'hm_satyadev', qs = ''): Promise<number> {
    const { hiring_funnel_snapshot } = await (await authed(request, await getToken(request, persona)).get(`/api/dashboard/funnel-snapshot${qs}`)).json();
    return (hiring_funnel_snapshot as SnapshotStage[]).reduce((n, s) => n + s.total, 0);
  }
  /** An application on `roleId`, parked 50 hours at its current stage, with the engine run so the breach exists. */
  async function breachedApp(request: Req, roleId: string, stage = 'Applied and Screened', hours = 50) {
    const token = await getToken(request, 'hr');
    const { candidate, application } = await createCandidateWithApp(request, token, roleId);
    appIds.push(application.id); candidateIds.push(candidate.id);
    await client.query(`UPDATE applications SET stage = $2, stage_entry_time = NOW() - ($3 || ' hours')::interval WHERE id = $1`, [application.id, stage, String(hours)]);
    return application.id as string;
  }

  test('requires auth', async ({ request }) => {
    expect((await request.get(`${BASE}/api/dashboard/sla-by-role`)).status()).toBe(401);
  });

  test('has the documented shape, and its parts agree with each other', async ({ request }) => {
    const body = await get(request, 'hr');
    expect(Array.isArray(body.roles)).toBe(true);
    expect(typeof body.total_breaches).toBe('number');
    expect(typeof body.not_open_roles.roles).toBe('number');
    expect(typeof body.not_open_roles.breaches).toBe('number');
    expect(body.stages.length).toBe(11);                  // the canonical funnel, always
    expect(body.stages[0]).toBe('Applied and Screened');

    expect(body.roles.reduce((n, r) => n + r.total, 0)).toBe(body.total_breaches);
    const sorted = [...body.roles].sort((a, b) => b.total - a.total || a.role_title.localeCompare(b.role_title));
    expect(body.roles.map(r => r.role_id)).toEqual(sorted.map(r => r.role_id));   // most breaches first

    for (const r of body.roles) {
      expect(r.total).toBeGreaterThan(0);                 // a role with nothing overdue is not a bar
      expect(r.by_stage.reduce((n, s) => n + s.count, 0)).toBe(r.total);
      // 'Other' (a stage outside the canonical 11) is not in body.stages and sorts last
      const ranks = r.by_stage.map(s => (body.stages.includes(s.stage) ? body.stages.indexOf(s.stage) : body.stages.length));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));                      // funnel order
      for (const s of r.by_stage) {
        expect(s.breach_types.reduce((n, t) => n + t.count, 0)).toBe(s.count);
        for (const t of s.breach_types) { expect(typeof t.type).toBe('string'); expect(typeof t.owner).toBe('string'); }
      }
    }
  });

  test('only open roles are bars', async ({ request }) => {
    const body = await get(request, 'hr');
    const open = ['Approved', 'Live – Sourcing', 'Under Review', 'On Hold'];
    for (const r of body.roles) expect(open).toContain(r.status);
  });

  test('a fresh breach shows up on its role at its stage, and moves the totals by exactly one', async ({ request }) => {
    const before = await get(request, 'hr');
    const beforeRole = before.roles.find(r => r.role_id === 'R006');
    const appId = await breachedApp(request, 'R006');
    await runSlaCheck(request);
    const after = await get(request, 'hr');

    const bar = after.roles.find(r => r.role_id === 'R006')!;
    expect(bar, 'R006 now has an overdue application').toBeTruthy();
    expect(bar.total).toBe((beforeRole?.total ?? 0) + 1);
    expect(after.total_breaches).toBe(before.total_breaches + 1);
    const atStage = bar.by_stage.find(s => s.stage === 'Applied and Screened')!;
    expect(atStage.count).toBe((beforeRole?.by_stage.find(s => s.stage === 'Applied and Screened')?.count ?? 0) + 1);
    // 'Resume Shortlist Pending' is the Applied-and-Screened breach and is Hiring-Manager-owned
    expect(atStage.breach_types.find(t => t.type === 'Resume Shortlist Pending')?.owner).toBe('Hiring Manager');
    expect(appId).toBeTruthy();
  });

  test('the same role split by stage: a second application at another stage is its own segment', async ({ request }) => {
    const before = (await get(request, 'hr')).roles.find(r => r.role_id === 'R006');
    // Interview Round 1 with nothing scheduled for 50h -> an HR-owned "not scheduled" style breach
    await breachedApp(request, 'R006', 'Interview Round 1', 50);
    await runSlaCheck(request);
    const bar = (await get(request, 'hr')).roles.find(r => r.role_id === 'R006')!;
    expect(bar.total).toBe((before?.total ?? 0) + 1);
    const r1 = bar.by_stage.find(s => s.stage === 'Interview Round 1')!;
    expect(r1).toBeTruthy();
    expect(r1.count).toBe((before?.by_stage.find(s => s.stage === 'Interview Round 1')?.count ?? 0) + 1);
    // stages stay in funnel order: Applied and Screened before Interview Round 1
    const names = bar.by_stage.map(s => s.stage);
    expect(names.indexOf('Applied and Screened')).toBeLessThan(names.indexOf('Interview Round 1'));
  });

  test('reconciles with the Hiring Funnel Snapshot: bars + breaches on roles that are not open (− any "Other" stage) = every snapshot breach', async ({ request }) => {
    const body = await get(request, 'hr');
    expect(reconciled(body)).toBe(await snapshotTotal(request, 'hr'));
  });

  test('role_id filter narrows to that role, and its total matches the snapshot under the same filter', async ({ request }) => {
    const body = await get(request, 'hr', '?role_id=R006');
    expect(body.roles.every(r => r.role_id === 'R006')).toBe(true);
    expect(body.roles.length).toBe(1);
    expect(reconciled(body)).toBe(await snapshotTotal(request, 'hr', '?role_id=R006'));
  });

  test('master filters apply exactly as on the snapshot (department)', async ({ request }) => {
    const qs = '?department=Product%2FQA';
    const body = await get(request, 'hr', qs);
    expect(reconciled(body)).toBe(await snapshotTotal(request, 'hr', qs));
  });

  test('owner toggle splits the total: every breach type is owned by the requested owner, and the two halves add up', async ({ request }) => {
    const [all, hr, hm] = await Promise.all([
      get(request, 'hr'),
      get(request, 'hr', '?owner=' + encodeURIComponent('HR / Recruiter')),
      get(request, 'hr', '?owner=' + encodeURIComponent('Hiring Manager')),
    ]);
    for (const r of hr.roles) for (const s of r.by_stage) for (const t of s.breach_types) expect(t.owner).toBe('HR / Recruiter');
    for (const r of hm.roles) for (const s of r.by_stage) for (const t of s.breach_types) expect(t.owner).toBe('Hiring Manager');
    // Leadership-owned rows are not part of the SLA breach set at all, so the two owners cover everything.
    expect(hr.total_breaches + hm.total_breaches).toBe(all.total_breaches);
  });

  test('an unrecognised owner value is ignored, like on the snapshot (not an error, not an empty chart)', async ({ request }) => {
    const [all, bogus] = await Promise.all([get(request, 'hr'), get(request, 'hr', '?owner=Nobody')]);
    expect(bogus.total_breaches).toBe(all.total_breaches);
  });

  test('a Hiring Manager only ever sees bars for their own roles, and cannot widen it with role_id', async ({ request }) => {
    const mine = await get(request, 'hm_alex');
    for (const r of mine.roles) expect(r.hiring_manager_name?.toLowerCase()).toContain('alex');

    // Satyadev asking for Alex's role gets the same chart as asking for nothing.
    const [plain, forged] = await Promise.all([get(request, 'hm_satyadev'), get(request, 'hm_satyadev', '?role_id=R006')]);
    expect(forged).toEqual(plain);
    for (const r of plain.roles) expect(r.hiring_manager_name?.toLowerCase()).toContain('satyadev');
    expect(plain.roles.some(r => r.role_id === 'R006')).toBe(false);      // R006 is Alex's
  });

  test('resolving the breach (the candidate moves on) takes it off the chart', async ({ request }) => {
    const appId = await breachedApp(request, 'R005');
    await runSlaCheck(request);
    const withIt = (await get(request, 'hr')).roles.find(r => r.role_id === 'R005')?.total ?? 0;
    expect(withIt).toBeGreaterThan(0);
    await client.query(`UPDATE applications SET status = 'Rejected' WHERE id = $1`, [appId]);
    await runSlaCheck(request);
    const without = (await get(request, 'hr')).roles.find(r => r.role_id === 'R005')?.total ?? 0;
    expect(without).toBe(withIt - 1);
  });

  test('a breach whose application was moved to another role is counted under the NEW role, not the stale one', async ({ request }) => {
    const appId = await breachedApp(request, 'R005');
    await runSlaCheck(request);
    const [r5, r6] = [
      (await get(request, 'hr')).roles.find(r => r.role_id === 'R005')?.total ?? 0,
      (await get(request, 'hr')).roles.find(r => r.role_id === 'R006')?.total ?? 0,
    ];
    // Move the application; pending_actions.role_id keeps pointing at R005 until the engine rewrites it.
    await client.query(`UPDATE applications SET role_id = 'R006' WHERE id = $1`, [appId]);
    const after = await get(request, 'hr');
    expect(after.roles.find(r => r.role_id === 'R005')?.total ?? 0).toBe(r5 - 1);
    expect(after.roles.find(r => r.role_id === 'R006')?.total ?? 0).toBe(r6 + 1);
  });

  // Closed, cancelled AND draft roles are all "not open": off the chart, but counted (a draft role is
  // not "closed", and the footnote under the chart must not call it that).
  for (const status of ['Closed – Filled', 'Closed – Cancelled', 'Draft']) {
    test(`breaches on a role that is ${status} leave the chart but are still counted in not_open_roles`, async ({ request }) => {
      const appId = await breachedApp(request, 'R005');
      await runSlaCheck(request);
      const before = await get(request, 'hr');
      expect(before.roles.find(r => r.role_id === 'R005'), 'R005 starts out as an open role with a breach').toBeTruthy();
      const { rows } = await client.query(`SELECT status FROM roles WHERE id = 'R005'`);
      const original = rows[0].status as string;
      try {
        await client.query(`UPDATE roles SET status = $1 WHERE id = 'R005'`, [status]);
        const after = await get(request, 'hr');
        expect(after.roles.find(r => r.role_id === 'R005')).toBeUndefined();
        expect(after.not_open_roles.breaches).toBeGreaterThan(before.not_open_roles.breaches);
        expect(after.not_open_roles.roles).toBeGreaterThan(before.not_open_roles.roles);
        // nothing is lost: what left the chart moved to not_open_roles
        expect(after.total_breaches + after.not_open_roles.breaches).toBe(before.total_breaches + before.not_open_roles.breaches);
      } finally {
        await client.query(`UPDATE roles SET status = $1 WHERE id = 'R005'`, [original]);
      }
      expect(appId).toBeTruthy();
    });
  }
});
