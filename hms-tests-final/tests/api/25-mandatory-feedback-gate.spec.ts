// ─────────────────────────────────────────────────────────────────────────────
// POST /applications/:id/stage now blocks advancing an application while any
// interview_rounds row for it has feedback_status != 'Submitted' — regardless
// of round_type (Standard or Assignment) or which stage the application is
// currently sitting in. skip_reason (the existing, already-logged escape
// hatch for intentional flow bypasses) skips this check entirely.
//
// Rounds created here deliberately omit scheduled_date/interviewer_emails so
// POST /interviews never reaches its real-Calendar-call gate (see
// 15-calendar-integration.spec.ts's own comment on that gate) — this file is
// scoped to the stage-advance gate itself, not calendar behavior.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidateWithApp } from '../helpers/api';

test.describe('Mandatory interview/assignment feedback before stage advance', () => {

  test('a Standard round with pending feedback blocks stage advance, naming the round', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);
    await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 1' });

    const roundRes = await api.post('/api/interviews', {
      application_id: application.id,
      round_name:     'Technical Deep-Dive',
      round_number:   1,
      round_type:     'Standard',
    });
    expect(roundRes.status()).toBe(201);

    const blockRes = await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 2' });
    expect(blockRes.status()).toBe(400);
    const blockBody = await blockRes.json();
    expect(blockBody.error).toContain('Technical Deep-Dive');
  });

  test('submitting feedback unblocks the advance', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);
    await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 1' });

    const roundRes  = await api.post('/api/interviews', {
      application_id: application.id, round_name: 'Technical Deep-Dive',
      round_number: 1, round_type: 'Standard',
    });
    const { round } = await roundRes.json();

    expect((await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 2' })).status()).toBe(400);

    const feedbackRes = await api.patch(`/api/interviews/${round.id}/feedback`, {
      overall_assessment: 'Positive', round_recommendation: 'Proceed',
      scores_per_area: { Technical: 8 },
    });
    expect(feedbackRes.status()).toBe(200);
    expect((await feedbackRes.json()).round.feedback_status).toBe('Submitted');

    const retryRes = await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 2' });
    expect(retryRes.status()).toBe(200);
  });

  test('an Assignment round with pending feedback also blocks advance (feedback_status is shared across round types)', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);
    await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Assignment Round' });

    const roundRes = await api.post('/api/interviews', {
      application_id: application.id, round_name: 'Assignment Round',
      round_number: 1, round_type: 'Assignment',
    });
    const { round } = await roundRes.json();

    const blockRes = await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Founders Round' });
    expect(blockRes.status()).toBe(400);

    await api.patch(`/api/interviews/${round.id}/feedback`, {
      assignment_outcome: 'Approved for Next Round',
      score_technical_accuracy: 4, score_problem_solving: 4,
      score_clarity: 4, score_practical_thinking: 4, score_completeness: 4,
    });

    const retryRes = await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Founders Round' });
    expect(retryRes.status()).toBe(200);
  });

  test('skip_reason bypasses the feedback gate entirely', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);
    await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 1' });

    await api.post('/api/interviews', {
      application_id: application.id, round_name: 'Technical Deep-Dive',
      round_number: 1, round_type: 'Standard',
    });

    const res = await api.post(`/api/applications/${application.id}/stage`, {
      new_stage: 'Interview Round 2', skip_reason: 'Interviewer unavailable, proceeding without formal feedback',
    });
    expect(res.status()).toBe(200);
  });

  test('an application with no interview rounds at all advances normally', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);

    const res = await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Resume Review' });
    expect(res.status()).toBe(200);
  });
});
