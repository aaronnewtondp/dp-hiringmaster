// ─────────────────────────────────────────────────────────────────────────────
// Role Closure Summary PDF (CEO directive, 2026-08-29) — GET /api/roles/:id/
// closure-summary.pdf. A 1-page retrospective, only available once a role is
// Closed – Filled or Closed – Cancelled, visible to HR-tier and the role's
// own Hiring Manager (same canSeeCompForRole ownership rule used for
// compensation visibility — see 35-comp-visibility.spec.ts).
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidate, uid } from '../helpers/api';

async function createAndCloseRole(request: Parameters<typeof authed>[0], hiringManagerName: string, finalStatus: 'Closed – Filled' | 'Closed – Cancelled') {
  const hrToken = await getToken(request, 'hr');
  const api = authed(request, hrToken);
  const createRes = await api.post('/api/roles', {
    title: `Closure Summary Test Role ${uid()}`, priority: 'P2', hiring_manager_name: hiringManagerName,
  });
  const { role } = await createRes.json();
  // Straight to the closed status without passing through 'Approved' —
  // isApprovingThisRole in roles.ts only fires when the target status is
  // literally 'Approved', so this deliberately skips the real synchronous
  // JD generation (Claude + Drive calls, ~20-30s) that step would otherwise
  // trigger; nothing in the PATCH route enforces going through it first.
  await api.patch(`/api/roles/${role.id}`, { status: finalStatus });
  return { hrToken, api, role };
}

test.describe('GET /api/roles/:id/closure-summary.pdf', () => {

  test('400 when the role is not yet closed', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const api = authed(request, hrToken);
    const createRes = await api.post('/api/roles', { title: `Not Closed Yet ${uid()}`, priority: 'P2' });
    const { role } = await createRes.json();

    const res = await api.get(`/api/roles/${role.id}/closure-summary.pdf`);
    expect(res.status()).toBe(400);
  });

  test('404 for a nonexistent role', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const res = await authed(request, hrToken).get(`/api/roles/RNONEXISTENT${uid()}/closure-summary.pdf`);
    expect(res.status()).toBe(404);
  });

  test('403 for a Hiring Manager who does not own the role', async ({ request }) => {
    const { role } = await createAndCloseRole(request, 'Alex', 'Closed – Filled');
    const satyadevToken = await getToken(request, 'hm_satyadev');
    const res = await authed(request, satyadevToken).get(`/api/roles/${role.id}/closure-summary.pdf`);
    expect(res.status()).toBe(403);
  });

  test("200 with a real PDF for HR-tier once the role is Closed – Filled", async ({ request }) => {
    const { hrToken, role } = await createAndCloseRole(request, 'Alex', 'Closed – Filled');
    const res = await authed(request, hrToken).get(`/api/roles/${role.id}/closure-summary.pdf`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/pdf');
    const buf = await res.body();
    expect(buf.slice(0, 4).toString('utf-8')).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(500);
  });

  test('200 for the role\'s own Hiring Manager once Closed – Cancelled', async ({ request }) => {
    const { role } = await createAndCloseRole(request, 'Alex', 'Closed – Cancelled');
    const alexToken = await getToken(request, 'hm_alex');
    const res = await authed(request, alexToken).get(`/api/roles/${role.id}/closure-summary.pdf`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/pdf');
  });

  test('Content-Disposition names the file after the role id', async ({ request }) => {
    const { hrToken, role } = await createAndCloseRole(request, 'Alex', 'Closed – Filled');
    const res = await authed(request, hrToken).get(`/api/roles/${role.id}/closure-summary.pdf`);
    expect(res.headers()['content-disposition']).toContain(`${role.id}-closure-summary.pdf`);
  });

  test('generates successfully with real pipeline history behind it (candidates across several stages/statuses)', async ({ request }) => {
    // Two candidate creations below each trigger a real, synchronous
    // ResumeIQ scoring call now (runResumeIQScoring at creation time),
    // which didn't exist when this test was written against Playwright's
    // 30s default — that margin is now regularly exceeded here (observed
    // timing out mid-run under normal system load).
    test.setTimeout(60_000);
    const { hrToken, api, role } = await createAndCloseRole(request, 'Alex', 'Closed – Filled');

    const { res: joinedRes } = await createCandidate(request, hrToken, { role_id: role.id });
    const { application: joinedApp } = await joinedRes.json();
    await api.post(`/api/applications/${joinedApp.id}/stage`, { new_stage: 'Joined' });

    const { res: rejectedRes } = await createCandidate(request, hrToken, { role_id: role.id });
    const { application: rejectedApp } = await rejectedRes.json();
    await api.post(`/api/applications/${rejectedApp.id}/status`, {
      new_status: 'Rejected', rejection_reason_cat: 'Failed interview',
    });

    // Role was already closed above, then two applications were mutated —
    // re-fetch to confirm the role is still Closed – Filled (mutating
    // applications doesn't touch role.status) before hitting the endpoint.
    const roleCheck = await api.get(`/api/roles/${role.id}`);
    expect((await roleCheck.json()).role.status).toBe('Closed – Filled');

    const res = await authed(request, hrToken).get(`/api/roles/${role.id}/closure-summary.pdf`);
    expect(res.status()).toBe(200);
    const buf = await res.body();
    expect(buf.slice(0, 4).toString('utf-8')).toBe('%PDF');
  });
});
