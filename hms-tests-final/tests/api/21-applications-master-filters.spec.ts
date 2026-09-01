import { test, expect } from '@playwright/test';
import { getToken, authed, uid, createCandidateWithApp } from '../helpers/api';

// Covers the master-filter feature added to the Candidates summary page
// this session: GET /api/applications now accepts department/location/
// recruitment_mode/priority filters via the shared roleFilters.ts helper
// (already covered for GET /api/roles and GET /api/dashboard in
// 17-role-filters.spec.ts), plus a role-status dimension.
//
// role_status deliberately isn't sent as `status` — that key already means
// the APPLICATION's own status (Active/Rejected/etc) on this exact route,
// a completely different, non-overlapping value set from a ROLE's status
// (Draft/Approved/etc). The frontend sends the role-status master filter
// under `role_status`, and the backend remaps it locally before handing off
// to the shared parser. These tests exist specifically to catch a
// regression where that remapping breaks and role-status values silently
// get compared against a.status instead, returning zero rows.
//
// Also covers the two new joined candidate-profile fields the summary
// table's Current Company / Resume Link columns depend on
// (candidate_company / candidate_resume_link) — aliased from candidates.
// current_company / candidates.resume_drive_link, NOT the stale legacy
// applications.resume_drive_link column (see CLAUDE.md's documented rule
// on candidate profile fields never living on applications).
test.describe('GET /api/applications — master filters + candidate profile fields', () => {

  test.describe('department / location / recruitment_mode / priority filters', () => {

    test('department filter narrows to only applications against a role in that department', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const dept  = `Dept-${uid()}`;

      const roleRes = await api.post('/api/roles', { title: `App Filter Dept Role ${uid()}`, priority: 'P2', department: dept });
      expect(roleRes.status()).toBe(201);
      const { role } = await roleRes.json();

      const { application } = await createCandidateWithApp(request, token, role.id);

      const [matchRes, noMatchRes] = await Promise.all([
        api.get(`/api/applications?department=${encodeURIComponent(dept)}&limit=200`),
        api.get(`/api/applications?department=${encodeURIComponent(`NoMatch-${uid()}`)}&limit=200`),
      ]);
      expect(matchRes.status()).toBe(200);
      expect(noMatchRes.status()).toBe(200);

      const { applications: matched }   = await matchRes.json();
      const { applications: unmatched } = await noMatchRes.json();
      expect(matched.some((a: { id: string }) => a.id === application.id)).toBe(true);
      expect(unmatched.length).toBe(0);
    });

    test('priority=P1&priority=P2 (multi-value) excludes a P3-role application', async ({ request }) => {
      // Two candidate creations below each trigger a real, synchronous
      // ResumeIQ scoring call now (runResumeIQScoring at creation time),
      // which didn't exist when this test was written against Playwright's
      // 30s default.
      test.setTimeout(60_000);
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const tag    = uid();

      const [p1Role, p3Role] = await Promise.all([
        api.post('/api/roles', { title: `App Filter Pri P1 ${tag}`, priority: 'P1' }).then(r => r.json()).then(b => b.role),
        api.post('/api/roles', { title: `App Filter Pri P3 ${tag}`, priority: 'P3' }).then(r => r.json()).then(b => b.role),
      ]);
      const [{ application: p1App }, { application: p3App }] = await Promise.all([
        createCandidateWithApp(request, token, p1Role.id),
        createCandidateWithApp(request, token, p3Role.id),
      ]);

      const res = await api.get('/api/applications?priority=P1&priority=P2&limit=200');
      expect(res.status()).toBe(200);
      const { applications } = await res.json();
      const ids = applications.map((a: { id: string }) => a.id);
      expect(ids).toContain(p1App.id);
      expect(ids).not.toContain(p3App.id);
    });

    test('recruitment_mode filter matches only roles with an overlapping mode', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const mode  = `Mode-${uid()}`;

      const roleRes = await api.post('/api/roles', {
        title: `App Filter Mode Role ${uid()}`, priority: 'P2', recruitment_mode: [mode],
      });
      expect(roleRes.status()).toBe(201);
      const { role } = await roleRes.json();
      const { application } = await createCandidateWithApp(request, token, role.id);

      const res = await api.get(`/api/applications?recruitment_mode=${encodeURIComponent(mode)}&limit=200`);
      expect(res.status()).toBe(200);
      const { applications } = await res.json();
      expect(applications.some((a: { id: string }) => a.id === application.id)).toBe(true);
    });
  });

  test.describe('role_status — remapped so it never collides with application status', () => {

    test('role_status=Draft never gets compared against the application\'s own status field', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);

      // Freshly-created role defaults to Draft; the application on it
      // defaults to status='Active' — if role_status were ever wired
      // straight into the shared `status` param, this request would
      // compare 'Draft' against a.status ('Active') and return zero rows.
      const roleRes = await api.post('/api/roles', { title: `App Filter RoleStatus ${uid()}`, priority: 'P2' });
      expect(roleRes.status()).toBe(201);
      const { role } = await roleRes.json();
      expect(role.status).toBe('Draft');

      const { application } = await createCandidateWithApp(request, token, role.id);
      expect(application.status).toBe('Active');

      const res = await api.get('/api/applications?role_status=Draft&limit=200');
      expect(res.status()).toBe(200);
      const { applications } = await res.json();
      expect(applications.some((a: { id: string }) => a.id === application.id)).toBe(true);
    });

    test('the pre-existing `status` param still means APPLICATION status, unaffected by role_status support', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);

      const { application } = await createCandidateWithApp(request, token);
      expect(application.status).toBe('Active');

      const res = await api.get(`/api/applications?status=Active&limit=200`);
      expect(res.status()).toBe(200);
      const { applications } = await res.json();
      expect(applications.every((a: { status: string }) => a.status === 'Active')).toBe(true);
      expect(applications.some((a: { id: string }) => a.id === application.id)).toBe(true);
    });

    test('role_status combined with department narrows on both dimensions at once', async ({ request }) => {
      // createCandidateWithApp below triggers a real, synchronous ResumeIQ
      // scoring call at creation (Applied and Screened is scored immediately
      // now, not on a later stage move) — same reasoning as the multi-value
      // priority test above in this file.
      test.setTimeout(60_000);
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const dept  = `Dept-Combo-${uid()}`;

      const roleRes = await api.post('/api/roles', { title: `App Filter Combo ${uid()}`, priority: 'P2', department: dept });
      const { role } = await roleRes.json();
      const { application } = await createCandidateWithApp(request, token, role.id);

      const [matchRes, wrongDeptRes] = await Promise.all([
        api.get(`/api/applications?role_status=Draft&department=${encodeURIComponent(dept)}&limit=200`),
        api.get(`/api/applications?role_status=Draft&department=${encodeURIComponent(`Other-${uid()}`)}&limit=200`),
      ]);
      const { applications: matched }    = await matchRes.json();
      const { applications: wrongDept }  = await wrongDeptRes.json();
      expect(matched.some((a: { id: string }) => a.id === application.id)).toBe(true);
      expect(wrongDept.length).toBe(0);
    });
  });

  test.describe('candidate_company / candidate_resume_link joined fields', () => {

    test('both fields are populated from candidates, not the stale applications.resume_drive_link column', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const marker = uid();

      const candRes = await api.post('/api/candidates', {
        full_name:         `Field Source Test ${marker}`,
        email:             `fieldsource+${marker}@example.com`,
        current_company:   `Acme Co ${marker}`,
        resume_drive_link: `https://drive.google.com/field-source-${marker}`,
        role_id:           'R006',
      });
      expect(candRes.status()).toBe(201);
      const { application } = await candRes.json();

      const res = await api.get(`/api/applications?role_id=R006&limit=200`);
      expect(res.status()).toBe(200);
      const { applications } = await res.json();
      const found = applications.find((a: { id: string }) => a.id === application.id);
      expect(found).toBeTruthy();
      expect(found.candidate_company).toBe(`Acme Co ${marker}`);
      expect(found.candidate_resume_link).toBe(`https://drive.google.com/field-source-${marker}`);
    });

    test('candidate with no company/resume set returns null for both, not the string "undefined"', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const { application } = await createCandidateWithApp(request, token);

      const res = await api.get(`/api/applications?role_id=${application.role_id}&limit=200`);
      const { applications } = await res.json();
      const found = applications.find((a: { id: string }) => a.id === application.id);
      expect(found.candidate_company).toBeFalsy();
      expect(found.candidate_resume_link).toBeFalsy();
    });
  });
});
