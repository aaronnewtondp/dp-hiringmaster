import { test, expect } from '@playwright/test';
import { getToken, authed, uid } from '../helpers/api';

test.describe('Dashboard API', () => {

  test.describe('GET /api/dashboard', () => {

    test('returns all Phase 1 metric keys', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.metrics).toHaveProperty('open_roles_count');
      expect(body.metrics).toHaveProperty('open_roles_by_priority');
      expect(body.metrics).toHaveProperty('active_candidates');
      expect(body.metrics).toHaveProperty('sla_breach_total');
      expect(body.metrics).toHaveProperty('sla_breach_by_owner');
      expect(body).toHaveProperty('hiring_funnel_snapshot');
      expect(body).toHaveProperty('hiring_funnel');
      expect(body).toHaveProperty('aging_roles');
    });

    test('open_roles_by_priority covers P0–P3', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { metrics } = await (await authed(request, token).get('/api/dashboard')).json();
      const open_roles_by_priority = metrics.open_roles_by_priority;
      for (const p of ['P0', 'P1', 'P2', 'P3']) {
        expect(open_roles_by_priority).toHaveProperty(p);
      }
    });

    test('open_roles_count reflects seeded data (at least 7)', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { metrics } = await (await authed(request, token).get('/api/dashboard')).json();
      const open_roles_count = metrics.open_roles_count;
      expect(open_roles_count).toBeGreaterThanOrEqual(7);
    });

    test('hiring_funnel_snapshot is an array of all 11 canonical stages, each with a breach_types array', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { hiring_funnel_snapshot } = await (await authed(request, token).get('/api/dashboard')).json();
      expect(Array.isArray(hiring_funnel_snapshot)).toBe(true);
      expect(hiring_funnel_snapshot.length).toBe(11);
      for (const stage of hiring_funnel_snapshot) {
        expect(typeof stage.stage).toBe('string');
        expect(typeof stage.total).toBe('number');
        expect(Array.isArray(stage.breach_types)).toBe(true);
      }
    });

    test('sla_breach_total equals the sum of sla_breach_by_owner, and both match a manual count from hiring_funnel_snapshot', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { metrics, hiring_funnel_snapshot } = await (await authed(request, token).get('/api/dashboard')).json();

      const sumByOwner = Object.values(metrics.sla_breach_by_owner as Record<string, number>).reduce((a, b) => a + b, 0);
      expect(metrics.sla_breach_total).toBe(sumByOwner);

      const manualCount = hiring_funnel_snapshot.reduce(
        (sum: number, stage: { breach_types: Array<{ count: number }> }) =>
          sum + stage.breach_types.reduce((s, bt) => s + bt.count, 0), 0
      );
      expect(metrics.sla_breach_total).toBe(manualCount);
    });

    test("'Role aging alert' never appears as a breach_types entry — it belongs to the Aging Roles box, not this stage-driven engine", async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { hiring_funnel_snapshot } = await (await authed(request, token).get('/api/dashboard')).json();
      for (const stage of hiring_funnel_snapshot) {
        for (const bt of stage.breach_types) {
          expect(bt.type).not.toBe('Role aging alert');
        }
      }
    });

    test('hiring_funnel is an array', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { hiring_funnel } = await (await authed(request, token).get('/api/dashboard')).json();
      expect(Array.isArray(hiring_funnel)).toBe(true);
    });

    test('aging_roles array contains objects with aging_alert field', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { aging_roles } = await (await authed(request, token).get('/api/dashboard')).json();
      expect(Array.isArray(aging_roles)).toBe(true);
      for (const role of aging_roles) {
        expect(['ok', 'yellow', 'red']).toContain(role.aging_alert);
      }
    });

    // 2026-09-01: aging_roles was widened from "only overdue Approved/Live –
    // Sourcing roles" to "every role currently Approved, Live – Sourcing, or
    // On Hold", each carrying its own days_open/aging_alert regardless of
    // whether it's actually overdue (dashboard.ts's agingTableRoles). A
    // freshly-Approved P2 role is nowhere near its 35-day yellow threshold,
    // so under the OLD behavior it would never have appeared here at all.
    test('a freshly-Approved role (not overdue) still appears in aging_roles, not just overdue ones', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);

      const createRes = await api.post('/api/roles', { title: `Aging Roles Fresh ${uid()}`, priority: 'P2' });
      expect(createRes.status()).toBe(201);
      const { role } = await createRes.json();

      const approveRes = await api.patch(`/api/roles/${role.id}`, { status: 'Approved' });
      expect(approveRes.status()).toBe(200);

      const { aging_roles } = await (await api.get('/api/dashboard')).json();
      const found = aging_roles.find((r: { id: string }) => r.id === role.id);
      expect(found).toBeTruthy();
      expect(found.aging_alert).toBe('ok');
      expect(found.days_open).toBeGreaterThanOrEqual(0);
    });

    // On Hold roles are included for reference now too, but never flagged —
    // the aging clock isn't "running" while a role is paused, so
    // computeAging() always returns 'ok' for On Hold regardless of days_open.
    test('an On Hold role appears in aging_roles and always has aging_alert "ok"', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);

      const createRes = await api.post('/api/roles', { title: `Aging Roles On Hold ${uid()}`, priority: 'P0' });
      expect(createRes.status()).toBe(201);
      const { role } = await createRes.json();

      expect((await api.patch(`/api/roles/${role.id}`, { status: 'Approved' })).status()).toBe(200);
      const holdRes = await api.patch(`/api/roles/${role.id}`, { status: 'On Hold' });
      expect(holdRes.status()).toBe(200);

      const { aging_roles } = await (await api.get('/api/dashboard')).json();
      const found = aging_roles.find((r: { id: string }) => r.id === role.id);
      expect(found).toBeTruthy();
      expect(found.aging_alert).toBe('ok');
    });
  });

  test.describe('GET /api/dashboard/pending', () => {

    test('HR sees all pending actions (no filter)', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard/pending');
      expect(res.status()).toBe(200);
      const { actions } = await res.json();
      expect(Array.isArray(actions)).toBe(true);
    });

    test('HM sees only their own queue', async ({ request }) => {
      const token   = await getToken(request, 'hm_alex');
      const { actions } = await (await authed(request, token).get('/api/dashboard/pending')).json();
      // dashboard.ts filters HM's queue to the literal owner_type string
      // 'Hiring Manager' (Title Case) — confirmed directly from source.
      for (const a of actions) {
        expect(a.owner_type).toBe('Hiring Manager');
      }
    });

    test('Leadership sees only their queue', async ({ request }) => {
      const token   = await getToken(request, 'leadership');
      const { actions } = await (await authed(request, token).get('/api/dashboard/pending')).json();
      for (const a of actions) {
        expect(a.owner_type).toBe('Leadership / Founders');
      }
    });
  });
});
