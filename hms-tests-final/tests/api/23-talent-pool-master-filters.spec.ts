import { test, expect } from '@playwright/test';
import { getToken, authed, uid } from '../helpers/api';

// Covers the Department/Location/Role master filters added to the Talent
// Pool page this session — GET /api/candidates?hold_for_future=true (or
// archived=true) combined with department/location/role_id.
//
// These are implemented as an EXISTS subquery against a SECOND roles join
// (aliased r, shadowing the query's own outer `LEFT JOIN roles r` used to
// build each candidate's aggregated `applications` array via json_agg) —
// specifically so filtering by role attributes narrows which CANDIDATES
// appear, rather than silently dropping non-matching applications out of
// the applications array for candidates who'd otherwise still match. These
// tests assert the full applications array survives intact, not just that
// filtering narrows the candidate list.
test.describe('GET /api/candidates — Talent Pool Department/Location/Role filters', () => {

  async function makeHoldForFutureCandidate(
    request: Parameters<typeof getToken>[0],
    token: string,
    roleId: string,
    extraRoleId?: string
  ) {
    const api = authed(request, token);
    const marker = uid();
    const candRes = await api.post('/api/candidates', {
      full_name: `Talent Pool Filter Test ${marker}`,
      email:     `talentpoolfilter+${marker}@example.com`,
      role_id:   roleId,
    });
    const { candidate, application } = await candRes.json();

    if (extraRoleId) {
      await api.post(`/api/candidates/${candidate.id}/applications`, { role_id: extraRoleId });
    }

    const statusRes = await api.post(`/api/applications/${application.id}/status`, {
      new_status: 'Hold for Future',
    });
    expect(statusRes.status()).toBe(200);
    return { candidate, application };
  }

  test('department filter narrows the candidate list and leaves the applications array intact', async ({ request }) => {
    // makeHoldForFutureCandidate below triggers a real, synchronous
    // ResumeIQ scoring call at creation (Applied and Screened is scored
    // immediately now, not on a later stage move) — same reasoning as the
    // equivalent per-test timeouts added across this suite for the same change.
    test.setTimeout(60_000);
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const dept  = `TP-Dept-${uid()}`;

    const roleRes = await api.post('/api/roles', { title: `TP Filter Dept Role ${uid()}`, priority: 'P2', department: dept });
    const { role } = await roleRes.json();

    const { candidate } = await makeHoldForFutureCandidate(request, token, role.id);

    const [matchRes, noMatchRes] = await Promise.all([
      api.get(`/api/candidates?hold_for_future=true&department=${encodeURIComponent(dept)}&limit=200`),
      api.get(`/api/candidates?hold_for_future=true&department=${encodeURIComponent(`NoMatch-${uid()}`)}&limit=200`),
    ]);
    expect(matchRes.status()).toBe(200);
    expect(noMatchRes.status()).toBe(200);

    const { candidates: matched }   = await matchRes.json();
    const { candidates: unmatched } = await noMatchRes.json();

    const found = matched.find((c: { id: string }) => c.id === candidate.id);
    expect(found).toBeTruthy();
    expect(found.applications.length).toBeGreaterThan(0);
    expect(unmatched.some((c: { id: string }) => c.id === candidate.id)).toBe(false);
  });

  test('role_id filter matches a candidate with 2 applications by EITHER role, and both applications still show', async ({ request }) => {
    test.setTimeout(60_000);
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const tag   = uid();

    const [roleA, roleB] = await Promise.all([
      api.post('/api/roles', { title: `TP Filter RoleA ${tag}`, priority: 'P2' }).then(r => r.json()).then(b => b.role),
      api.post('/api/roles', { title: `TP Filter RoleB ${tag}`, priority: 'P2' }).then(r => r.json()).then(b => b.role),
    ]);

    const { candidate } = await makeHoldForFutureCandidate(request, token, roleA.id, roleB.id);

    const res = await api.get(`/api/candidates?hold_for_future=true&role_id=${roleB.id}&limit=200`);
    expect(res.status()).toBe(200);
    const { candidates } = await res.json();
    const found = candidates.find((c: { id: string }) => c.id === candidate.id);
    expect(found).toBeTruthy();

    // Filtering by roleB must not have dropped the roleA application row
    // out of the aggregated array — that's exactly the bug the EXISTS
    // subquery (vs. a plain WHERE on the outer join) is there to prevent.
    const roleIds = found.applications.map((a: { role_id: string }) => a.role_id);
    expect(roleIds).toContain(roleA.id);
    expect(roleIds).toContain(roleB.id);
  });

  test('location filter (substring match) narrows results the same way it does on Roles/Dashboard', async ({ request }) => {
    test.setTimeout(60_000);
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const city  = `TPCity-${uid()}`;

    const roleRes = await api.post('/api/roles', { title: `TP Filter Location Role ${uid()}`, priority: 'P2', location: `${city}/OtherCity` });
    const { role } = await roleRes.json();
    const { candidate } = await makeHoldForFutureCandidate(request, token, role.id);

    const res = await api.get(`/api/candidates?hold_for_future=true&location=${encodeURIComponent(city)}&limit=200`);
    expect(res.status()).toBe(200);
    const { candidates } = await res.json();
    expect(candidates.some((c: { id: string }) => c.id === candidate.id)).toBe(true);
  });

  test('department + role_id combine with AND semantics, matching neither excludes the candidate', async ({ request }) => {
    test.setTimeout(60_000);
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const dept  = `TP-Combo-Dept-${uid()}`;

    const roleRes = await api.post('/api/roles', { title: `TP Filter Combo Role ${uid()}`, priority: 'P2', department: dept });
    const { role } = await roleRes.json();
    const { candidate } = await makeHoldForFutureCandidate(request, token, role.id);

    const [bothMatchRes, wrongRoleRes] = await Promise.all([
      api.get(`/api/candidates?hold_for_future=true&department=${encodeURIComponent(dept)}&role_id=${role.id}&limit=200`),
      api.get(`/api/candidates?hold_for_future=true&department=${encodeURIComponent(dept)}&role_id=R001&limit=200`),
    ]);
    const { candidates: bothMatch }  = await bothMatchRes.json();
    const { candidates: wrongRole }  = await wrongRoleRes.json();
    expect(bothMatch.some((c: { id: string }) => c.id === candidate.id)).toBe(true);
    expect(wrongRole.some((c: { id: string }) => c.id === candidate.id)).toBe(false);
  });

  test('works in archived mode too, not just hold_for_future', async ({ request }) => {
    test.setTimeout(60_000);
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const dept  = `TP-Archived-Dept-${uid()}`;

    const roleRes = await api.post('/api/roles', { title: `TP Filter Archived Role ${uid()}`, priority: 'P2', department: dept });
    const { role } = await roleRes.json();

    const candRes = await api.post('/api/candidates', {
      full_name: `TP Archived Filter Test ${uid()}`,
      email:     `tparchivedfilter+${uid()}@example.com`,
      role_id:   role.id,
    });
    const { application } = await candRes.json();
    await api.post(`/api/applications/${application.id}/status`, {
      new_status: 'Rejected', rejection_reason_cat: 'Below experience threshold',
    });
    // Archival is immediate (no age threshold) — this proves the department
    // filter combines correctly with archived=true's query shape (AND
    // semantics), not a boundary/timing case.
    const res = await api.get(`/api/candidates?archived=true&department=${encodeURIComponent(dept)}&limit=200`);
    expect(res.status()).toBe(200);
    const { candidates } = await res.json();
    expect(candidates.some((c: { id: string }) => c.id === application.candidate_id)).toBe(true);

    // ...and correspondingly excluded when the department filter doesn't match.
    const wrongDeptRes = await api.get(`/api/candidates?archived=true&department=${encodeURIComponent('Corporate Functions/Business Operations')}&limit=200`);
    const { candidates: wrongDept } = await wrongDeptRes.json();
    expect(wrongDept.some((c: { id: string }) => c.id === application.candidate_id)).toBe(false);
  });
});
