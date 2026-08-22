import { test, expect } from '@playwright/test';
import { getToken, authed, SEEDED, uid } from '../helpers/api';

test.describe('Roles API', () => {

  test.describe('GET /api/roles', () => {

    test('returns seeded roles for HR', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/roles');
      expect(res.status()).toBe(200);
      const { roles } = await res.json();
      expect(roles.length).toBeGreaterThanOrEqual(7);
    });

    test('each role has days_open and aging_alert', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { roles } = await (await authed(request, token).get('/api/roles')).json();
      for (const role of roles) {
        expect(typeof role.days_open).toBe('number');
        expect(['ok', 'yellow', 'red']).toContain(role.aging_alert);
      }
    });

    test('HR sees ctc_band', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { roles } = await (await authed(request, token).get('/api/roles')).json();
      const r = roles.find((x: { id: string }) => x.id === SEEDED.roles.backend_dev);
      expect(r).toBeDefined();
      expect(r.ctc_band).toBeTruthy();
    });

    test('Hiring Manager does NOT see ctc_band', async ({ request }) => {
      const token = await getToken(request, 'hm_alex');
      const { roles } = await (await authed(request, token).get('/api/roles')).json();
      for (const role of roles) expect(role.ctc_band).toBeUndefined();
    });

    test('filters by priority', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { roles } = await (await authed(request, token).get('/api/roles?priority=P1')).json();
      for (const role of roles) expect(role.priority).toBe('P1');
    });

    test('returns 401 without token', async ({ request }) => {
      const { BASE } = await import('../helpers/api');
      const res = await request.get(`${BASE}/api/roles`);
      expect(res.status()).toBe(401);
    });
  });

  test.describe('GET /api/roles/:id', () => {

    test('returns a seeded role with all fields', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get(`/api/roles/${SEEDED.roles.senior_pm}`);
      expect(res.status()).toBe(200);
      const { role } = await res.json();
      expect(role.id).toBe(SEEDED.roles.senior_pm);
      expect(role.title).toBeTruthy();
      expect(role.days_open).toBeGreaterThanOrEqual(0);
    });

    test('returns 404 for non-existent role', async ({ request }) => {
      const token = await getToken(request, 'hr');
      // A random-suffixed id, not a small fixed number like R999 — this
      // local dataset accumulates enough test roles over time that a fixed
      // low id eventually stops being guaranteed-nonexistent.
      const res   = await authed(request, token).get(`/api/roles/RNONEXISTENT${uid()}`);
      expect(res.status()).toBe(404);
    });
  });

  test.describe('POST /api/roles', () => {

    test('HR creates a role and gets R-series ID', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).post('/api/roles', {
        title: `Test Role ${uid()}`, priority: 'P2',
      });
      expect(res.status()).toBe(201);
      const { role } = await res.json();
      // Widened from a fixed 3 digits to 3+ — the seq_role-backed id used to
      // truncate (not error) once the sequence passed 999, silently
      // colliding with an existing low id; fixed to pad to 4 digits, so
      // ids can legitimately be either width now.
      expect(role.id).toMatch(/^R\d{3,}$/);
      expect(role.status).toBe('Draft');
    });

    test('returns 400 when title is missing', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).post('/api/roles', { priority: 'P1' });
      expect(res.status()).toBe(400);
    });

    // Hiring Manager submitting a role is now a "role request" (item #24) —
    // same Draft-status result as HR creating one directly, just logged as
    // 'Role Requested' instead of 'Role Created' on the activity timeline.
    test('HM can request a role (creates a Draft role, ctc_band ignored)', async ({ request }) => {
      const token = await getToken(request, 'hm_alex');
      const res   = await authed(request, token).post('/api/roles', {
        title: `HM request ${uid()}`, priority: 'P1', ctc_band: '999-999 LPA',
      });
      expect(res.status()).toBe(201);
      const { role } = await res.json();
      expect(role.status).toBe('Draft');
      expect(role.ctc_band).toBeNull();
    });
  });

  test.describe('PATCH /api/roles/:id + Edit Log', () => {

    test('HR can update a role and change is written to edit log', async ({ request }) => {
      const api = authed(request, await getToken(request, 'hr'));
      await api.patch(`/api/roles/${SEEDED.roles.qa_eng}`, {
        additional_remarks: `Updated ${uid()}`,
      });
      const logRes = await api.get(`/api/roles/${SEEDED.roles.qa_eng}/edit-log`);
      const { logs } = await logRes.json();
      expect(logs.length).toBeGreaterThan(0);
      const entry = logs[0];
      expect(entry.field_name).toBeTruthy();
    });

    test('updating ctc_band creates a Leadership pending action', async ({ request }) => {
      const api   = authed(request, await getToken(request, 'hr'));
      const newBand = `${uid()} LPA`;
      await api.patch(`/api/roles/${SEEDED.roles.backend_dev}`, { ctc_band: newBand });
      const pendRes = await api.get('/api/dashboard/pending');
      const { actions } = await pendRes.json();
      const ctcAction = actions?.find(
        (a: { action_type: string; owner_type: string }) =>
          a.action_type === 'Compensation change flag' && a.owner_type === 'Leadership / Founders'
      );
      expect(ctcAction).toBeDefined();
    });
  });

  test('GET /api/roles/:id/pipeline returns grouped pipeline', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const res   = await authed(request, token).get(`/api/roles/${SEEDED.roles.senior_pm}/pipeline`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.total).toBe('number');
  });
});
