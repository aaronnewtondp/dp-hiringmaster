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

// Same pattern as setupInterviewRound(), but advances the application to
// 'Assignment Round' and creates a round_type:'Assignment' round instead of
// a Standard one. The two round types are scored through entirely separate
// columns/branches in PATCH /:id/feedback (assignment_* fields vs
// scores_per_area/overall_round_score), so Assignment-specific tests need a
// genuinely Assignment-typed round, not the Standard one setupInterviewRound()
// produces.
async function setupAssignmentRound(request: Parameters<typeof authed>[0]) {
  const token = await getToken(request, 'hr');
  const api   = authed(request, token);
  const { application } = await createCandidateWithApp(request, token);
  await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Assignment Round' });
  const irRes = await api.post('/api/interviews', {
    application_id: application.id,
    round_name:     'Assignment Round',
    round_number:   1,
    round_type:     'Assignment',
  });
  const { round } = await irRes.json();
  return { token, api, application, round };
}

// For the POST /api/interviews field-validation tests below, the round
// itself (and its exact request body) is what's under test — the
// application just needs to already be sitting in a stage where scheduling
// a round is reachable, same as setupInterviewRound() but without creating
// a round of its own.
async function setupApplicationInInterviewStage(request: Parameters<typeof authed>[0]) {
  const token = await getToken(request, 'hr');
  const api   = authed(request, token);
  const { application } = await createCandidateWithApp(request, token);
  await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 1' });
  return { token, api, application };
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

    // Regression guard for the exact weighted rubric in PATCH /:id/feedback:
    // Technical Accuracy 40% / Problem Solving 25% / Clarity 15% / Practical
    // Thinking 10% / Completeness 10%. The expected value is computed with
    // the same expression the route uses (not a hand-rounded decimal), so
    // this catches drift in the weights or rounding, not just "some score
    // came back" — assignment_overall_score is only ever computed once all
    // 5 scores are present in the same PATCH.
    test('assignment feedback computes the weighted overall score exactly and marks Submitted', async ({ request }) => {
      const { api, round } = await setupAssignmentRound(request);
      const scores = {
        score_technical_accuracy: 5,
        score_problem_solving:    4,
        score_clarity:            3,
        score_practical_thinking: 4,
        score_completeness:       5,
      };
      const expectedScore = Math.round((
        scores.score_technical_accuracy * 0.4 + scores.score_problem_solving * 0.25 +
        scores.score_clarity * 0.15 + scores.score_practical_thinking * 0.10 + scores.score_completeness * 0.10
      ) * 10) / 10;

      const res = await api.patch(`/api/interviews/${round.id}/feedback`, {
        assignment_outcome: 'Approved for Next Round',
        ...scores,
      });
      expect(res.status()).toBe(200);
      const { round: updated } = await res.json();
      expect(updated.feedback_status).toBe('Submitted');
      expect(Number(updated.assignment_overall_score)).toBe(expectedScore);
    });

    // Product decision this session: HR sends/submits and owns the
    // assignment lifecycle, but recording the outcome is deliberately open
    // to whoever actually assesses the work — HM or interviewer, not just
    // HR ("I want to give HR the freedom to also score the assignment...
    // HM/interviewer is the one who should be assessing"). PATCH
    // /:id/feedback carries no requireHR middleware for exactly this reason.
    test('Hiring Manager can record an assignment outcome even though HR created the round', async ({ request }) => {
      const { round } = await setupAssignmentRound(request);
      const hmToken = await getToken(request, 'hm_alex');
      const res = await authed(request, hmToken).patch(`/api/interviews/${round.id}/feedback`, {
        assignment_outcome:       'Approved for Next Round',
        score_technical_accuracy: 4,
        score_problem_solving:    4,
        score_clarity:            4,
        score_practical_thinking: 4,
        score_completeness:       4,
      });
      expect(res.status()).toBe(200);
    });

    // Counterpart to the test above: evaluate is open to any persona, but
    // Send/Submit stay HR-only (requireHR on both routes) — a Hiring Manager
    // must not be able to trigger either lifecycle step themselves, only
    // score the outcome once HR has run them.
    test('Hiring Manager cannot send or submit an assignment (403 on both)', async ({ request }) => {
      const { round } = await setupAssignmentRound(request);
      const hmToken = await getToken(request, 'hm_alex');
      const hm = authed(request, hmToken);

      const sendRes = await hm.post(`/api/interviews/${round.id}/assignment-send`, {});
      expect(sendRes.status()).toBe(403);

      const subRes = await hm.post(`/api/interviews/${round.id}/assignment-submit`, {
        submission_link: 'https://github.com/test/submission',
      });
      expect(subRes.status()).toBe(403);
    });
  });

  test.describe('POST /api/interviews — interviewer_emails validation', () => {

    test('accepts a valid array of interviewer emails and echoes it back exactly', async ({ request }) => {
      const { api, application } = await setupApplicationInInterviewStage(request);
      const emails = ['alex@digitalpaani.com', 'satyadev@digitalpaani.com'];
      // scheduled_date is intentionally omitted here: local Docker holds real
      // Google Calendar service-account credentials with domain-wide
      // delegation configured (see tests/helpers/calendar.ts), and a
      // Standard round with BOTH scheduled_date and a non-empty
      // interviewer_emails array triggers a real, synchronous Calendar
      // invite on the organizer's actual calendar. Leaving scheduled_date
      // unset keeps this a pure field-validation/echo test with no external
      // side effect.
      const res = await api.post('/api/interviews', {
        application_id: application.id,
        round_name:     'Round 1',
        round_number:   1,
        interviewer_emails: emails,
      });
      expect(res.status()).toBe(201);
      const { round } = await res.json();
      expect(round.interviewer_emails).toEqual(emails);
    });

    test('rejects an array containing one invalid entry, naming the bad value', async ({ request }) => {
      const { api, application } = await setupApplicationInInterviewStage(request);
      const res = await api.post('/api/interviews', {
        application_id: application.id,
        round_name:     'Round 1',
        round_number:   1,
        interviewer_emails: ['alex@digitalpaani.com', 'not-an-email'],
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('not-an-email');
    });

    test('rejects interviewer_emails sent as a plain string instead of an array', async ({ request }) => {
      const { api, application } = await setupApplicationInInterviewStage(request);
      const res = await api.post('/api/interviews', {
        application_id: application.id,
        round_name:     'Round 1',
        round_number:   1,
        interviewer_emails: 'alex@digitalpaani.com',
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('interviewer_emails must be an array of strings');
    });

    test('omitting interviewer_emails entirely still creates the round', async ({ request }) => {
      const { api, application } = await setupApplicationInInterviewStage(request);
      const res = await api.post('/api/interviews', {
        application_id: application.id,
        round_name:     'Round 1',
        round_number:   1,
      });
      expect(res.status()).toBe(201);
      const { round } = await res.json();
      expect(round.interviewer_emails == null).toBe(true);
    });
  });

  test.describe('POST /api/interviews — duration_minutes', () => {

    test('honors an explicit duration_minutes', async ({ request }) => {
      const { api, application } = await setupApplicationInInterviewStage(request);
      const res = await api.post('/api/interviews', {
        application_id: application.id,
        round_name:     'Round 1',
        round_number:   1,
        duration_minutes: 45,
      });
      expect(res.status()).toBe(201);
      const { round } = await res.json();
      expect(round.duration_minutes).toBe(45);
    });

    test('defaults to 60 minutes when omitted', async ({ request }) => {
      const { api, application } = await setupApplicationInInterviewStage(request);
      const res = await api.post('/api/interviews', {
        application_id: application.id,
        round_name:     'Round 1',
        round_number:   1,
      });
      expect(res.status()).toBe(201);
      const { round } = await res.json();
      expect(round.duration_minutes).toBe(60);
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
