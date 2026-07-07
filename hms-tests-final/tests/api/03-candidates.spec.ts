import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidate, createCandidateWithApp, SEEDED, uid } from '../helpers/api';

test.describe('Candidates API', () => {

  test.describe('POST /api/candidates', () => {

    test('HR creates a candidate — gets C-series ID', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).post('/api/candidates', {
        full_name: `Test ${uid()}`,
        email:     `test+${uid()}@example.com`,
        phone:     `+91 9${uid().slice(0, 9)}`,
      });
      expect(res.status()).toBe(201);
      const { candidate } = await res.json();
      expect(candidate.id).toMatch(/^C\d{4}$/);
    });

    test('candidate created WITH role_id also creates an application', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).post('/api/candidates', {
        full_name: `Test ${uid()}`,
        email:     `test+${uid()}@example.com`,
        role_id:   SEEDED.roles.senior_pm,
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.application).toBeDefined();
      expect(body.application.id).toMatch(/^A\d{4}$/);
      expect(body.application.stage).toBe('Applied');
      expect(body.application.status).toBe('Active');
      expect(body.application.recruiter_screening_status).toBe('New');
    });

    test('DUPLICATE EMAIL returns 409 with existing_id', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const email = `dup+${uid()}@example.com`;
      await authed(request, token).post('/api/candidates', {
        full_name: 'First', email,
      });
      const res2 = await authed(request, token).post('/api/candidates', {
        full_name: 'Second', email,
      });
      expect(res2.status()).toBe(409);
      const body = await res2.json();
      expect(body.existing_id).toBeTruthy();
    });

    test('returns 400 when full_name is missing', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).post('/api/candidates', {
        email: `x+${uid()}@example.com`,
      });
      expect(res.status()).toBe(400);
    });

    test('HM cannot create a candidate (403)', async ({ request }) => {
      const token = await getToken(request, 'hm_alex');
      const res   = await authed(request, token).post('/api/candidates', {
        full_name: `HM attempt ${uid()}`,
        email:     `x+${uid()}@example.com`,
      });
      expect(res.status()).toBe(403);
    });
  });

  test.describe('GET /api/candidates', () => {

    test('returns candidates list for authenticated user', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/candidates');
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.candidates)).toBe(true);
    });

    test('search by name (q param) returns matching results', async ({ request }) => {
      const token  = await getToken(request, 'hr');
      const marker = `SEARCHTEST${uid()}`;
      await createCandidate(request, token, { full_name: marker });
      const res  = await authed(request, token).get(`/api/candidates?q=${marker}`);
      const { candidates } = await res.json();
      expect(candidates.some((c: { full_name: string }) => c.full_name.includes(marker))).toBe(true);
    });
  });

  test.describe('GET /api/candidates/:id', () => {

    test('returns candidate profile + their applications', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { candidate, application } = await createCandidateWithApp(request, token);
      const res  = await authed(request, token).get(`/api/candidates/${candidate.id}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.candidate.id).toBe(candidate.id);
      expect(Array.isArray(body.applications)).toBe(true);
      expect(body.applications.some((a: { id: string }) => a.id === application.id)).toBe(true);
    });

    test('returns 404 for non-existent candidate', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/candidates/C9999');
      expect(res.status()).toBe(404);
    });
  });

  test.describe('PATCH /api/candidates/:id', () => {

    test('HR can update candidate profile fields', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { candidate } = await createCandidate(request, token);
      const res = await authed(request, token).patch(`/api/candidates/${candidate.id}`, {
        parsed_total_yoe: 5.5,
        parsed_skills:    ['TypeScript', 'Node.js'],
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(Number(body.candidate.parsed_total_yoe)).toBe(5.5);
      expect(body.candidate.parsed_skills).toContain('TypeScript');
    });
  });

  test('GET /api/candidates/:id/activity — log exists for candidate with application', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const { candidate } = await createCandidateWithApp(request, token);
    const res  = await authed(request, token).get(`/api/candidates/${candidate.id}/activity`);
    expect(res.status()).toBe(200);
    const { activity: logs } = await res.json();
    expect(logs.length).toBeGreaterThan(0);
  });
});
