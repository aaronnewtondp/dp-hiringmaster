import { test, expect } from '@playwright/test';
import { getToken, authed, uid, createCandidateWithApp } from '../helpers/api';

// Covers CandidateDetail.tsx's field parity with the synced Create
// Candidate form (Languages Known + Preferred Location) against the two
// routes that save them: PATCH /api/candidates/:id and PATCH
// /api/applications/:id/notes. Both routes loop over a fixed `allowedFields`
// array and silently skip any field not in it.
//
// languages_known genuinely hit this: it was missing from candidates.ts's
// allowedFields, so a PATCH sending only that field took the "no changes
// detected" early-return path — 200 OK, edit mode closed in the UI as if it
// worked, but nothing was written; only checking the DB directly after a
// save caught it. preferred_location was added correctly to applications.ts
// on the first attempt (that route 400s instead of silently succeeding when
// every sent field is unrecognized, a louder failure mode), but it's
// guarded here anyway since it's the newer, less-exercised of the two.
test.describe('Candidate Detail field parity — allowlist regression guards', () => {

  test.describe('PATCH /api/candidates/:id — languages_known', () => {

    test('languages_known persists (regression: was missing from allowedFields, PATCH silently no-op\'d)', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const marker = uid();

      const createRes = await api.post('/api/candidates', {
        full_name: `Languages Patch Test ${marker}`,
        email:     `languagespatch+${marker}@example.com`,
      });
      expect(createRes.status()).toBe(201);
      const { candidate } = await createRes.json();
      expect(candidate.languages_known ?? null).toBeNull();

      const patchRes = await api.patch(`/api/candidates/${candidate.id}`, {
        languages_known: 'English, Hindi',
      });
      expect(patchRes.status()).toBe(200);
      const patchBody = await patchRes.json();
      // The exact bug this guards against: languages_known wasn't in
      // allowedFields, so `updates` stayed empty and the route took its
      // "no changes detected" early-return path, echoing back the
      // pre-update (stale) row — still a 200, still shaped like success.
      expect(patchBody.candidate.languages_known).toBe('English, Hindi');

      // Re-fetch independently too, so this doesn't just trust whatever the
      // route chooses to echo back.
      const getRes = await api.get(`/api/candidates/${candidate.id}`);
      const { candidate: refetched } = await getRes.json();
      expect(refetched.languages_known).toBe('English, Hindi');
    });

    test('candidate_edit_log records the languages_known change', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const { candidate } = await (await api.post('/api/candidates', {
        full_name: `Languages EditLog Test ${uid()}`,
        email:     `languageseditlog+${uid()}@example.com`,
      })).json();

      await api.patch(`/api/candidates/${candidate.id}`, { languages_known: 'Tamil, Telugu' });

      const logRes = await api.get(`/api/candidates/${candidate.id}/edit-log`);
      expect(logRes.status()).toBe(200);
      const { logs } = await logRes.json();
      expect(logs.some((l: { field_name: string }) => l.field_name === 'languages_known')).toBe(true);
    });
  });

  test.describe('PATCH /api/applications/:id/notes — preferred_location', () => {

    test('preferred_location persists via the notes route', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const { application } = await createCandidateWithApp(request, token);
      expect(application.preferred_location ?? null).toBeNull();

      const patchRes = await api.patch(`/api/applications/${application.id}/notes`, {
        preferred_location: 'Chennai',
      });
      expect(patchRes.status()).toBe(200);

      const listRes = await api.get(`/api/applications?role_id=${application.role_id}&limit=200`);
      const { applications } = await listRes.json();
      const refetched = applications.find((a: { id: string }) => a.id === application.id);
      expect(refetched.preferred_location).toBe('Chennai');
    });

    test('preferred_location can be saved alongside an unrelated HR note field in the same request', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const { application } = await createCandidateWithApp(request, token);

      const patchRes = await api.patch(`/api/applications/${application.id}/notes`, {
        preferred_location:   'Pune',
        hr_recruiter_summary: 'Strong candidate, mixed-field save test',
      });
      expect(patchRes.status()).toBe(200);

      const listRes = await api.get(`/api/applications?role_id=${application.role_id}&limit=200`);
      const { applications } = await listRes.json();
      const refetched = applications.find((a: { id: string }) => a.id === application.id);
      expect(refetched.preferred_location).toBe('Pune');
      expect(refetched.hr_recruiter_summary).toBe('Strong candidate, mixed-field save test');
    });

    test('HM cannot PATCH application notes (403) — preferred_location addition did not weaken this gate', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const { application } = await createCandidateWithApp(request, hrToken);

      const hmToken = await getToken(request, 'hm_alex');
      const res = await authed(request, hmToken).patch(`/api/applications/${application.id}/notes`, {
        preferred_location: 'Should Not Save',
      });
      expect(res.status()).toBe(403);
    });
  });
});
