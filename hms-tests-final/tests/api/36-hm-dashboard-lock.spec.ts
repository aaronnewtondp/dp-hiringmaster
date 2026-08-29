// ─────────────────────────────────────────────────────────────────────────────
// Hiring Manager dashboard lock (CEO directive, 2026-08-29): a Hiring
// Manager's dashboard is scoped to their own role(s) only, and this can't be
// changed — not just a default the frontend applies, but enforced server-side
// in dashboard.ts (parseRoleFilters' role_id is overridden outright for
// persona === 'hiring_manager', regardless of what the client sends).
//
// Uses 'hm_alex' (Alex) against the live seeded/accumulated dataset rather
// than asserting an exact count — this suite has created many roles owned by
// "Alex" across other test files over time, so the robust assertions are:
// (a) Alex's dashboard count exactly matches an independently-computed count
// of Alex's own open roles, (b) explicitly requesting a role_id belonging to
// a DIFFERENT Hiring Manager doesn't change Alex's result at all (proving
// override, not just an unset default), and (c) HR's company-wide count is
// strictly larger than Alex's scoped one.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { getToken, authed, SEEDED } from '../helpers/api';

const OPEN_STATUSES = ['Live – Sourcing', 'Approved', 'Under Review'];

test.describe('Hiring Manager dashboard — locked to own role(s)', () => {

  test("Alex's dashboard open_roles_count matches exactly her own open roles, computed independently", async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const alexToken = await getToken(request, 'hm_alex');

    const rolesRes = await authed(request, hrToken).get('/api/roles?limit=5000');
    const { roles } = await rolesRes.json();
    const alexOpenCount = roles.filter((r: { hiring_manager_name?: string; status: string }) =>
      r.hiring_manager_name?.trim().toLowerCase() === 'alex' && OPEN_STATUSES.includes(r.status)
    ).length;
    expect(alexOpenCount).toBeGreaterThan(0);

    const dashRes = await authed(request, alexToken).get('/api/dashboard');
    const { metrics } = await dashRes.json();
    expect(metrics.open_roles_count).toBe(alexOpenCount);
  });

  test("explicitly requesting another Hiring Manager's role_id does not change Alex's scoped result", async ({ request }) => {
    const alexToken = await getToken(request, 'hm_alex');

    const baseline = await authed(request, alexToken).get('/api/dashboard');
    const baselineCount = (await baseline.json()).metrics.open_roles_count;

    // R002 (E&I Engineer Mumbai) belongs to Satyadev, not Alex.
    const overrideAttempt = await authed(request, alexToken).get(`/api/dashboard?role_id=${SEEDED.roles.ei_mumbai}`);
    const overrideCount = (await overrideAttempt.json()).metrics.open_roles_count;

    expect(overrideCount).toBe(baselineCount);
  });

  test("HR's company-wide open_roles_count is strictly larger than Alex's own-role-scoped count", async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const alexToken = await getToken(request, 'hm_alex');

    const hrDash = await authed(request, hrToken).get('/api/dashboard');
    const alexDash = await authed(request, alexToken).get('/api/dashboard');
    const hrCount = (await hrDash.json()).metrics.open_roles_count;
    const alexCount = (await alexDash.json()).metrics.open_roles_count;

    expect(hrCount).toBeGreaterThan(alexCount);
  });
});
