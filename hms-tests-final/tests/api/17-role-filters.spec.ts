import { test, expect } from '@playwright/test';
import { getToken, authed, uid, createCandidateWithApp } from '../helpers/api';

// Covers the master-filter feature added this session:
//   - backend/src/utils/roleFilters.ts (shared parse + SQL builder)
//   - GET /api/roles (multi-value department/location/recruitment_mode/
//     priority/status/role_id filters) + GET /api/roles/filter-options
//   - GET /api/dashboard (same filters applied across every metric)
//   - GET /api/applications (role_id filter, now array-capable)
//
// Two closed statuses use an EN DASH ("Closed – Filled" / "Closed – Cancelled"),
// not a hyphen — matches roleFilters.ts / roles.ts exactly.
const CLOSED_STATUSES = ['Closed – Filled', 'Closed – Cancelled'];

test.describe('Role/Dashboard/Candidates master filters', () => {

  test.describe('GET /api/roles/filter-options', () => {

    test('recruitment_modes is a non-empty array, roles is [{id,title}], no Closed roles included', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/roles/filter-options');
      expect(res.status()).toBe(200);

      const { recruitment_modes, roles } = await res.json();

      expect(Array.isArray(recruitment_modes)).toBe(true);
      expect(recruitment_modes.length).toBeGreaterThan(0);
      for (const mode of recruitment_modes) expect(typeof mode).toBe('string');

      expect(Array.isArray(roles)).toBe(true);
      expect(roles.length).toBeGreaterThan(0);
      for (const r of roles) {
        expect(typeof r.id).toBe('string');
        expect(typeof r.title).toBe('string');
      }

      // Cross-check a couple of the returned ids directly against
      // GET /api/roles/:id — none of them should carry a Closed status.
      const sample = roles.slice(0, 2);
      expect(sample.length).toBeGreaterThan(0);
      for (const r of sample) {
        const detailRes = await authed(request, token).get(`/api/roles/${r.id}`);
        expect(detailRes.status()).toBe(200);
        const { role } = await detailRes.json();
        expect(CLOSED_STATUSES).not.toContain(role.status);
      }
    });

    test('a role moved to Closed – Filled drops out of the roles list', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);

      const createRes = await api.post('/api/roles', {
        title: `Filter Options Closed Test ${uid()}`, priority: 'P2',
      });
      expect(createRes.status()).toBe(201);
      const { role } = await createRes.json();

      // Sanity: freshly-created (Draft) role IS in the list before closing.
      const beforeRes = await api.get('/api/roles/filter-options');
      const before = await beforeRes.json();
      expect(before.roles.some((r: { id: string }) => r.id === role.id)).toBe(true);

      const patchRes = await api.patch(`/api/roles/${role.id}`, { status: 'Closed – Filled' });
      expect(patchRes.status()).toBe(200);

      const afterRes = await api.get('/api/roles/filter-options');
      const after = await afterRes.json();
      expect(after.roles.some((r: { id: string }) => r.id === role.id)).toBe(false);
    });
  });

  test.describe('GET /api/roles — department filter', () => {

    test('filters to an exact department match and excludes a non-matching one', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);

      const dept = `Dept-${uid()}`;
      const createRes = await api.post('/api/roles', {
        title: `Dept Filter Test ${uid()}`, priority: 'P2', department: dept,
      });
      expect(createRes.status()).toBe(201);
      const { role } = await createRes.json();

      const matchRes = await api.get(`/api/roles?department=${encodeURIComponent(dept)}`);
      expect(matchRes.status()).toBe(200);
      const { roles: matched } = await matchRes.json();
      expect(matched.some((r: { id: string }) => r.id === role.id)).toBe(true);
      for (const r of matched) expect(r.department).toBe(dept);

      const noMatchDept = `Dept-${uid()}`; // fresh random value, guaranteed unused
      const noMatchRes = await api.get(`/api/roles?department=${encodeURIComponent(noMatchDept)}`);
      expect(noMatchRes.status()).toBe(200);
      const { roles: unmatched } = await noMatchRes.json();
      expect(unmatched.some((r: { id: string }) => r.id === role.id)).toBe(false);
      expect(unmatched.length).toBe(0);
    });
  });

  test.describe('GET /api/roles — multi-value priority filter', () => {

    test('priority=P1&priority=P2 returns only those two priorities', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);

      const titleTag = uid();
      const [p1Res, p2Res, p3Res] = await Promise.all([
        api.post('/api/roles', { title: `MultiPri P1 ${titleTag}`, priority: 'P1' }),
        api.post('/api/roles', { title: `MultiPri P2 ${titleTag}`, priority: 'P2' }),
        api.post('/api/roles', { title: `MultiPri P3 ${titleTag}`, priority: 'P3' }),
      ]);
      const p1Role = (await p1Res.json()).role;
      const p2Role = (await p2Res.json()).role;
      const p3Role = (await p3Res.json()).role;

      const res = await api.get('/api/roles?priority=P1&priority=P2');
      expect(res.status()).toBe(200);
      const { roles } = await res.json();

      for (const role of roles) expect(['P1', 'P2']).toContain(role.priority);

      const ids = roles.map((r: { id: string }) => r.id);
      expect(ids).toContain(p1Role.id);
      expect(ids).toContain(p2Role.id);
      expect(ids).not.toContain(p3Role.id);
    });
  });

  test.describe('GET /api/dashboard — role_id master filter', () => {

    // Uses a freshly-created role + a small, known number of applications
    // rather than a shared SEEDED role — the seeded roles (e.g. Senior
    // Product Manager) accumulate applications across every run of this
    // whole suite over time, so a fixed limit against them is inherently
    // flaky: it either clips the real count (undercounting) or eventually
    // needs bumping again as more tests pile more data onto them. A fresh,
    // self-owned role has a fully deterministic count with no such drift.
    test('filtering by a single role_id narrows open_roles_count and active_candidates agrees with /api/applications', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);

      const createRes = await api.post('/api/roles', { title: `Dashboard Role Filter Test ${uid()}`, priority: 'P2' });
      expect(createRes.status()).toBe(201);
      const { role } = await createRes.json();
      // open_roles_count only counts Live – Sourcing / Approved / Under
      // Review — a fresh role defaults to Draft, so promote it.
      const patchRes = await api.patch(`/api/roles/${role.id}`, { status: 'Live – Sourcing' });
      expect(patchRes.status()).toBe(200);

      const APP_COUNT = 3;
      for (let i = 0; i < APP_COUNT; i++) {
        const { application } = await createCandidateWithApp(request, token, role.id);
        expect(application.role_id).toBe(role.id);
      }

      const [unfilteredRes, filteredRes] = await Promise.all([
        api.get('/api/dashboard'),
        api.get(`/api/dashboard?role_id=${role.id}`),
      ]);
      expect(unfilteredRes.status()).toBe(200);
      expect(filteredRes.status()).toBe(200);

      const unfiltered = await unfilteredRes.json();
      const filtered   = await filteredRes.json();

      // Exactly this one role is in scope, and it's genuinely open.
      expect(filtered.metrics.open_roles_count).toBe(1);
      expect(filtered.metrics.open_roles_count).toBeLessThanOrEqual(unfiltered.metrics.open_roles_count);
      expect(filtered.metrics.active_candidates).toBe(APP_COUNT);

      // Independent cross-check against /api/applications for the same role
      // — a small, comfortably-above-APP_COUNT limit is fine here since the
      // count is fully controlled by this test, not shared/growing state.
      const appsRes = await api.get(`/api/applications?role_id=${role.id}&limit=50`);
      expect(appsRes.status()).toBe(200);
      const { applications } = await appsRes.json();
      const activeCount = applications.filter((a: { status: string }) => a.status === 'Active').length;
      expect(activeCount).toBe(APP_COUNT);
      expect(filtered.metrics.active_candidates).toBe(activeCount);
    });
  });

  test.describe('GET /api/applications — multi-value role_id filter', () => {

    // Same reasoning as above — two fresh roles with known, small
    // application counts instead of shared SEEDED roles, so the reconciled
    // totals are exact rather than dependent on how much other tests (past
    // or future) have already piled onto a shared seeded role.
    test('role_id=X&role_id=Y returns only applications for those two roles, and counts reconcile', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const titleTag = uid();

      const [xRes, yRes] = await Promise.all([
        api.post('/api/roles', { title: `MultiRole X ${titleTag}`, priority: 'P2' }),
        api.post('/api/roles', { title: `MultiRole Y ${titleTag}`, priority: 'P2' }),
      ]);
      const roleX = (await xRes.json()).role.id;
      const roleY = (await yRes.json()).role.id;

      const X_COUNT = 2;
      const Y_COUNT = 3;
      for (let i = 0; i < X_COUNT; i++) await createCandidateWithApp(request, token, roleX);
      for (let i = 0; i < Y_COUNT; i++) await createCandidateWithApp(request, token, roleY);

      const [combinedRes, xOnlyRes, yOnlyRes] = await Promise.all([
        api.get(`/api/applications?role_id=${roleX}&role_id=${roleY}&limit=50`),
        api.get(`/api/applications?role_id=${roleX}&limit=50`),
        api.get(`/api/applications?role_id=${roleY}&limit=50`),
      ]);
      expect(combinedRes.status()).toBe(200);
      expect(xOnlyRes.status()).toBe(200);
      expect(yOnlyRes.status()).toBe(200);

      const { applications: combined } = await combinedRes.json();
      const { applications: xOnly }    = await xOnlyRes.json();
      const { applications: yOnly }    = await yOnlyRes.json();

      expect(xOnly.length).toBe(X_COUNT);
      expect(yOnly.length).toBe(Y_COUNT);

      const distinctRoleIds = new Set(combined.map((a: { role_id: string }) => a.role_id));
      for (const id of distinctRoleIds) expect([roleX, roleY]).toContain(id);

      expect(combined.length).toBe(X_COUNT + Y_COUNT);
      expect(combined.length).toBe(xOnly.length + yOnly.length);
    });
  });

  test.describe('GET /api/dashboard — fully-filtered-out case', () => {

    test('a department matching nothing returns zeroed metrics, not an unfiltered fallback', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);

      const noMatchDept = `NoMatch-${uid()}`;
      const res = await api.get(`/api/dashboard?department=${encodeURIComponent(noMatchDept)}`);
      expect(res.status()).toBe(200);
      const { metrics } = await res.json();

      expect(metrics.open_roles_count).toBe(0);
      expect(metrics.active_candidates).toBe(0);
    });
  });
});
