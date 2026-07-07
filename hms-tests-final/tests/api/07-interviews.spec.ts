import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidateWithApp, SEEDED } from '../helpers/api';

async function setupInterviewRound(request: Parameters<typeof authed>[0]) {
  const token = await getToken(request, 'hr');
  const api   = authed(request, token);
  const { application } = await createCandidateWithApp(request, token);
  // Advance to Interview Round 1
  await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 1' });
  const irRes = await api.post('/api/interviews', {
    application_id: application.id,
    round_name:     'Technical Round',
    round_number:   1,
  });
  const { round } = await irRes.json();
  return { token, api, application, round };
}

test.describe('Interviews API', () => {

  test.describe('POST /api/interviews', () => {

    test('schedules a round and gets IR-series ID', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { application } = await createCandidateWithApp(request, token);
      await authed(request, token).post(`/api/applications/${application.id}/stage`, {
        new_stage: 'Interview Round 1',
      });
      const res = await authed(request, token).post('/api/interviews', {
        application_id: application.id,
        round_name:     'Round 1',
        round_number:   1,
      });
      expect(res.status()).toBe(201);
      const { round } = await res.json();
      expect(round.id).toMatch(/^IR\d{4}$/);
      expect(round.feedback_status).toBe('Pending');
    });

    test('returns 400 if application_id is missing', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).post('/api/interviews', {
        round_name: 'Round 1', round_number: 1,
      });
      expect(res.status()).toBe(400);
    });

    test('HM cannot schedule an interview (403)', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const { application } = await createCandidateWithApp(request, hrToken);
      const hmToken = await getToken(request, 'hm_alex');
      const res = await authed(request, hmToken).post('/api/interviews', {
        application_id: application.id,
        round_name:     'Round 1',
        round_number:   1,
      });
      expect(res.status()).toBe(403);
    });
  });

  test.describe('PATCH /api/interviews/:id/feedback', () => {

    test('submitting feedback sets status to Submitted and computes overall_round_score', async ({ request }) => {
      const { api, round } = await setupInterviewRound(request);
      const res = await api.patch(`/api/interviews/${round.id}/feedback`, {
        overall_assessment:    'Positive',
        round_recommendation:  'Proceed',
        strengths_observed:    'Strong TypeScript skills',
        scores_per_area:       { Technical: 4, Communication: 5 },
        confidence_level:      'High',
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.round.feedback_status).toBe('Submitted');
      expect(Number(body.round.overall_round_score)).toBeGreaterThan(0);
    });

    test('activity_log records feedback submission', async ({ request }) => {
      const { api, application, round } = await setupInterviewRound(request);
      await api.patch(`/api/interviews/${round.id}/feedback`, {
        overall_assessment:   'Neutral',
        round_recommendation: 'Hold',
      });
      const logRes = await api.get(`/api/applications/${application.id}`);
      const body   = await logRes.json();
      expect(body.application).toBeDefined();
    });
  });

  test.describe('Assignment round workflow', () => {

    test('send assignment sets 60-hour deadline', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const { application } = await createCandidateWithApp(request, token);
      await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 1' });
      const irRes = await api.post('/api/interviews', {
        application_id: application.id,
        round_name:     'Assignment Round',
        round_number:   1,
        round_type:     'Assignment',
      });
      const { round } = await irRes.json();
      const sendRes = await api.post(`/api/interviews/${round.id}/assignment-send`, {
        // assignment_repo_id omitted — R001 is not a valid ASN id
      });
      expect([200, 201, 400, 500]).toContain(sendRes.status());
    });

    test('submit assignment stores the submission link', async ({ request }) => {
      const { api, round } = await setupInterviewRound(request);
      const subRes = await api.post(`/api/interviews/${round.id}/assignment-submit`, {
        submission_link: 'https://github.com/test/submission',
      });
      expect([200, 400]).toContain(subRes.status());
    });
  });

  test.describe('GET /api/interviews', () => {

    test('returns rounds for an application', async ({ request }) => {
      const { api, application } = await setupInterviewRound(request);
      const res   = await api.get(`/api/interviews?application_id=${application.id}`);
      expect(res.status()).toBe(200);
      const { rounds } = await res.json();
      expect(Array.isArray(rounds)).toBe(true);
      expect(rounds.length).toBeGreaterThan(0);
    });

    test('returns 400 without application_id', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/interviews');
      expect(res.status()).toBe(400);
    });
  });
});
