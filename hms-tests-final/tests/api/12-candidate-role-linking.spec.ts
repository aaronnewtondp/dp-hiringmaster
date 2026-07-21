import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidate, SEEDED, uid } from '../helpers/api';

test.describe('Candidate-Role Linking API', () => {

  test.describe('POST /api/candidates/:id/applications', () => {

    test('links an existing candidate (no prior applications) to a role — 201', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { candidate } = await createCandidate(request, token);
      const res = await authed(request, token).post(`/api/candidates/${candidate.id}/applications`, {
        role_id: SEEDED.roles.qa_eng,
      });
      expect(res.status()).toBe(201);
      const { application } = await res.json();
      expect(application.stage).toBe('Applied');
      expect(application.status).toBe('Active');
      expect(application.recruiter_screening_status).toBe('New');
      expect(application.candidate_id).toBe(candidate.id);
      expect(application.role_id).toBe(SEEDED.roles.qa_eng);
    });

    test('re-linking the SAME (candidate, role) pair returns 409 with application_id', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { candidate } = await createCandidate(request, token);
      const first = await authed(request, token).post(`/api/candidates/${candidate.id}/applications`, {
        role_id: SEEDED.roles.senior_ux,
      });
      expect(first.status()).toBe(201);
      const { application: firstApp } = await first.json();

      const second = await authed(request, token).post(`/api/candidates/${candidate.id}/applications`, {
        role_id: SEEDED.roles.senior_ux,
      });
      expect(second.status()).toBe(409);
      const body = await second.json();
      expect(body.application_id).toBeTruthy();
      expect(body.application_id).toBe(firstApp.id);
    });

    test('returns 404 for a non-existent candidate', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res = await authed(request, token).post('/api/candidates/C9999/applications', {
        role_id: SEEDED.roles.backend_dev,
      });
      expect(res.status()).toBe(404);
    });

    test('returns 400 when role_id is missing', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { candidate } = await createCandidate(request, token);
      const res = await authed(request, token).post(`/api/candidates/${candidate.id}/applications`, {});
      expect(res.status()).toBe(400);
    });

    test('returns 400 for a non-existent role_id', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { candidate } = await createCandidate(request, token);
      const res = await authed(request, token).post(`/api/candidates/${candidate.id}/applications`, {
        role_id: 'R999',
      });
      expect(res.status()).toBe(400);
    });

    test('Hiring Manager cannot link a candidate to a role (403)', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const { candidate } = await createCandidate(request, hrToken);

      const hmToken = await getToken(request, 'hm_alex');
      const res = await authed(request, hmToken).post(`/api/candidates/${candidate.id}/applications`, {
        role_id: SEEDED.roles.process_mgr,
      });
      expect(res.status()).toBe(403);
    });

    test('activity log entry is attributed to the authenticated HR user, not System', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { candidate } = await createCandidate(request, token);
      await authed(request, token).post(`/api/candidates/${candidate.id}/applications`, {
        role_id: SEEDED.roles.ei_hyd,
      });

      const res = await authed(request, token).get(`/api/candidates/${candidate.id}/activity`);
      const { activity: logs } = await res.json();
      const entry = logs.find(
        (l: { event_type: string }) => l.event_type === 'Application Created'
      );
      expect(entry).toBeDefined();
      expect(entry.performed_by_name).toBeTruthy();
      expect(entry.performed_by_name).not.toBe('System');
    });
  });
});
