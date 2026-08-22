import { test, expect } from '@playwright/test';
import { BASE, getToken, authed, createCandidateWithApp, uid } from '../helpers/api';

// ─── DELETE /api/roles/:id — "discard a role request" ──────────────────────
// New endpoint: the reject/discard counterpart to approving a role. Only a
// role still sitting in Draft (i.e. nobody has acted on it yet — no JD, no
// applications) can ever be discarded; once a role has moved past Draft,
// deleting it outright would risk corrupting or orphaning whatever's already
// hanging off it (generated JD, applications, interview rounds, ...), so the
// route refuses instead. Per roles.ts, an activity_log row (event_type
// 'Role Discarded') is written immediately before the DELETE — that row's
// survival (via activity_log.role_id's ON DELETE SET NULL) is verified
// separately in tests/db/02-role-discard-activity-log.spec.ts, since it's
// not observable through the HTTP API once the role itself is gone.
test.describe('DELETE /api/roles/:id — discard a Draft role', () => {

  test('HR discards a Draft role with no applications — 200, then GET 404s (actually gone)', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);

    const createRes = await api.post('/api/roles', {
      title: `Discard Me ${uid()}`,
      priority: 'P2',
    });
    expect(createRes.status()).toBe(201);
    const { role } = await createRes.json();
    expect(role.status).toBe('Draft');

    const delRes = await request.delete(`${BASE}/api/roles/${role.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delRes.status()).toBe(200);
    const delBody = await delRes.json();
    expect(delBody).toEqual({ success: true });

    const getRes = await api.get(`/api/roles/${role.id}`);
    expect(getRes.status()).toBe(404);
  });

  // Uses a namespaced random id rather than a small fixed number like R999 —
  // this local dataset has accumulated enough test-created roles over time
  // that a low fixed id is not reliably free, and colliding with a real row
  // would turn this into a false negative (or worse, a real discard).
  test('404 discarding a role id that does not exist', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const fakeId = `RNONEXISTENT${uid()}`;

    const delRes = await request.delete(`${BASE}/api/roles/${fakeId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delRes.status()).toBe(404);
    const body = await delRes.json();
    expect(body.error).toBeTruthy();
  });

  test('role past Draft (Approved) cannot be discarded — 400, role survives', async ({ request }) => {
    // Approving triggers real synchronous JD generation (Claude call + 2 PDF
    // renders + 2 Drive uploads, awaited inline per the no-fire-and-forget
    // rule) — observed ~20-30s. Default Playwright test timeout is 30s, so
    // this needs headroom the same way 10-jd-generation-and-scoring.spec.ts
    // does for the same PATCH call.
    test.setTimeout(180_000);

    const token = await getToken(request, 'hr');
    const api   = authed(request, token);

    const createRes = await api.post('/api/roles', {
      title: `Approve Then Discard ${uid()}`,
      priority: 'P2',
    });
    expect(createRes.status()).toBe(201);
    const { role } = await createRes.json();

    const approveRes = await api.patch(`/api/roles/${role.id}`, { status: 'Approved' });
    expect(approveRes.status()).toBe(200);
    const { role: approvedRole } = await approveRes.json();
    expect(approvedRole.status).toBe('Approved');

    const delRes = await request.delete(`${BASE}/api/roles/${role.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delRes.status()).toBe(400);
    const body = await delRes.json();
    expect(body.error).toBe('Only Draft roles can be discarded');

    const getRes = await api.get(`/api/roles/${role.id}`);
    expect(getRes.status()).toBe(200);
    const stillThere = await getRes.json();
    expect(stillThere.role.status).toBe('Approved');
  });

  // Defense in depth: status===Draft should already guarantee zero
  // applications, but applications.role_id has no ON DELETE clause of its
  // own (defaults to RESTRICT) — so this guard exists to turn what would
  // otherwise be an opaque DB constraint error into a clear 400, for the
  // edge case of a stray application against a role that's still Draft.
  test('Draft role that already has an application cannot be discarded — 400, role survives', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);

    const createRes = await api.post('/api/roles', {
      title: `Draft With Application ${uid()}`,
      priority: 'P2',
    });
    expect(createRes.status()).toBe(201);
    const { role } = await createRes.json();
    expect(role.status).toBe('Draft');

    await createCandidateWithApp(request, token, role.id);

    const delRes = await request.delete(`${BASE}/api/roles/${role.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delRes.status()).toBe(400);
    const body = await delRes.json();
    expect(body.error).toBe('This role already has applications and cannot be discarded');

    const getRes = await api.get(`/api/roles/${role.id}`);
    expect(getRes.status()).toBe(200);
  });

  test('hiring_manager persona cannot discard a role — 403, role survives', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const hrApi   = authed(request, hrToken);

    const createRes = await hrApi.post('/api/roles', {
      title: `HM Cannot Discard ${uid()}`,
      priority: 'P2',
    });
    expect(createRes.status()).toBe(201);
    const { role } = await createRes.json();

    const hmToken = await getToken(request, 'hm_alex');
    const delRes  = await request.delete(`${BASE}/api/roles/${role.id}`, {
      headers: { Authorization: `Bearer ${hmToken}` },
    });
    expect(delRes.status()).toBe(403);

    const getRes = await hrApi.get(`/api/roles/${role.id}`);
    expect(getRes.status()).toBe(200);
  });
});
