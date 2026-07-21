import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidate, SEEDED, uid } from '../helpers/api';

test.describe('Phase 3 Inline Editing — Regression Guards', () => {

  // ─── Candidates ────────────────────────────────────────────────────────────
  // Historical bug: the PATCH /:id allowlist used to only accept legacy
  // 'parsed_*' fields, so edits made from the real profile fields shown on
  // screen (current_company, current_ctc_fixed, etc.) silently no-opped —
  // the request returned 200 but nothing was ever written.
  test.describe('Candidates PATCH /:id — profile field allowlist', () => {

    test('current_company, current_ctc_fixed, current_designation, current_location, years_of_experience, resume_drive_link all persist', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { candidate } = await createCandidate(request, token);

      const marker = uid();
      const patchBody = {
        current_company:      `Test Co ${marker}`,
        current_ctc_fixed:    1234500 + (Date.now() % 1000),
        current_designation: `Senior Engineer ${marker}`,
        current_location:    `Test City ${marker}`,
        years_of_experience: 3 + (Date.now() % 10) / 10,
        resume_drive_link:   `https://drive.google.com/file/d/${marker}/view`,
      };

      const patchRes = await authed(request, token).patch(`/api/candidates/${candidate.id}`, patchBody);
      expect(patchRes.status()).toBe(200);

      const getRes = await authed(request, token).get(`/api/candidates/${candidate.id}`);
      expect(getRes.status()).toBe(200);
      const { candidate: fetched } = await getRes.json();

      expect(fetched.current_company).toBe(patchBody.current_company);
      expect(Number(fetched.current_ctc_fixed)).toBe(patchBody.current_ctc_fixed);
      expect(fetched.current_designation).toBe(patchBody.current_designation);
      expect(fetched.current_location).toBe(patchBody.current_location);
      expect(Number(fetched.years_of_experience)).toBe(patchBody.years_of_experience);
      expect(fetched.resume_drive_link).toBe(patchBody.resume_drive_link);
    });

    test('candidate_edit_log records the patched profile fields', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { candidate } = await createCandidate(request, token);

      const marker = uid();
      const patchRes = await authed(request, token).patch(`/api/candidates/${candidate.id}`, {
        current_company:     `Test Co ${marker}`,
        current_designation: `Senior Engineer ${marker}`,
      });
      expect(patchRes.status()).toBe(200);

      const logRes = await authed(request, token).get(`/api/candidates/${candidate.id}/edit-log`);
      expect(logRes.status()).toBe(200);
      const { logs } = await logRes.json();
      expect(logs.length).toBeGreaterThan(0);
      expect(
        logs.some((l: { field_name: string }) =>
          ['current_company', 'current_designation'].includes(l.field_name))
      ).toBe(true);
    });
  });

  // ─── Roles ─────────────────────────────────────────────────────────────────
  // Confirms the PATCH write and the restricted-field strip work together end
  // to end: HR's ctc_band write is real (persists, not just echoed back), and
  // a Hiring Manager still can't see it on a subsequent GET.
  test.describe('Roles PATCH /:id — ctc_band write + restricted-field strip', () => {

    test('HR writes ctc_band and it persists, then HM cannot see it on GET', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const roleId  = SEEDED.roles.process_mgr;
      const newBand = `${uid()} LPA`;

      const patchRes = await authed(request, hrToken).patch(`/api/roles/${roleId}`, { ctc_band: newBand });
      expect(patchRes.status()).toBe(200);
      const { role: patchedRole } = await patchRes.json();
      expect(patchedRole.ctc_band).toBe(newBand);

      // Confirm as HR the value is actually stored, not just echoed on the PATCH response
      const hrGetRes = await authed(request, hrToken).get(`/api/roles/${roleId}`);
      expect(hrGetRes.status()).toBe(200);
      const { role: hrRole } = await hrGetRes.json();
      expect(hrRole.ctc_band).toBe(newBand);

      // HM must not see the newly-written value
      const hmToken  = await getToken(request, 'hm_alex');
      const hmGetRes = await authed(request, hmToken).get(`/api/roles/${roleId}`);
      expect(hmGetRes.status()).toBe(200);
      const { role: hmRole } = await hmGetRes.json();
      expect(hmRole.ctc_band).toBeUndefined();
    });
  });

  // ─── Agencies ──────────────────────────────────────────────────────────────
  test.describe('Agencies PATCH /:id + edit log', () => {

    test('HR creates an agency, PATCHes notes + specialisations, both persist and are edit-logged', async ({ request }) => {
      const token = await getToken(request, 'hr');

      const createRes = await authed(request, token).post('/api/agencies', {
        name: `Test Agency ${uid()}`,
      });
      expect(createRes.status()).toBe(201);
      const { agency } = await createRes.json();
      expect(agency.id).toMatch(/^AGN\d{3}$/);

      const marker         = uid();
      const newNotes       = `Regression test notes ${marker}`;
      const newSpecialties = `IT Recruitment ${marker}`;

      const patchRes = await authed(request, token).patch(`/api/agencies/${agency.id}`, {
        notes:           newNotes,
        specialisations: newSpecialties,
      });
      expect(patchRes.status()).toBe(200);
      const { agency: patched } = await patchRes.json();
      expect(patched.notes).toBe(newNotes);
      expect(patched.specialisations).toBe(newSpecialties);

      const getRes = await authed(request, token).get(`/api/agencies/${agency.id}`);
      expect(getRes.status()).toBe(200);
      const { agency: fetched } = await getRes.json();
      expect(fetched.notes).toBe(newNotes);
      expect(fetched.specialisations).toBe(newSpecialties);

      const logRes = await authed(request, token).get(`/api/agencies/${agency.id}/edit-log`);
      expect(logRes.status()).toBe(200);
      const { logs } = await logRes.json();
      expect(logs.length).toBeGreaterThan(0);
      expect(
        logs.some((l: { field_name: string }) =>
          ['notes', 'specialisations'].includes(l.field_name))
      ).toBe(true);
    });
  });
});
