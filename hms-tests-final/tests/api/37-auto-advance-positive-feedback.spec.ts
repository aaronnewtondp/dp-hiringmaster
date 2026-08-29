// ─────────────────────────────────────────────────────────────────────────────
// Auto-advance on positive feedback (CEO directive, 2026-08-29) — reduces
// friction moving candidates along: submitting feedback for an Interview
// Round 1/2, Founders Round, or Assignment Round that's positive enough
// (Standard: round_recommendation 'Proceed' or 'Proceed with Concerns';
// Assignment: assignment_outcome 'Approved for Next Round' — Assignment has
// no "with concerns" equivalent) AND whose average score exceeds 2.5 (both
// round shapes use a 1-5 rubric scale) auto-advances the application to the
// next canonical stage. Only fires when the application is still Active and
// still sitting at the exact stage the round belongs to.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidateWithApp } from '../helpers/api';

async function setupStandardRound(request: Parameters<typeof authed>[0], stage: string) {
  const token = await getToken(request, 'hr');
  const api = authed(request, token);
  const { application } = await createCandidateWithApp(request, token);
  await api.post(`/api/applications/${application.id}/stage`, { new_stage: stage });
  const irRes = await api.post('/api/interviews', {
    application_id: application.id, round_name: stage, round_number: 1,
  });
  const { round } = await irRes.json();
  return { token, api, application, round };
}

async function setupAssignmentRound(request: Parameters<typeof authed>[0]) {
  const token = await getToken(request, 'hr');
  const api = authed(request, token);
  const { application } = await createCandidateWithApp(request, token);
  await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Assignment Round' });
  const irRes = await api.post('/api/interviews', {
    application_id: application.id, round_name: 'Assignment Round', round_number: 1, round_type: 'Assignment',
    mail_body_content: 'Please find your assignment below.',
    assignment_link: 'https://drive.google.com/test-assignment',
  });
  const { round } = await irRes.json();
  return { token, api, application, round };
}

test.describe('Auto-advance on positive feedback', () => {

  test('Interview Round 1: "Proceed" with avg score > 2.5 auto-advances to Interview Round 2', async ({ request }) => {
    const { api, application, round } = await setupStandardRound(request, 'Interview Round 1');
    const res = await api.patch(`/api/interviews/${round.id}/feedback`, {
      overall_assessment: 'Positive', round_recommendation: 'Proceed',
      scores_per_area: { Technical: 4, Communication: 4 }, confidence_level: 'High',
    });
    expect(res.status()).toBe(200);
    const { auto_advanced } = await res.json();
    expect(auto_advanced).toEqual({ from: 'Interview Round 1', to: 'Interview Round 2' });

    const appRes = await api.get(`/api/applications/${application.id}`);
    expect((await appRes.json()).application.stage).toBe('Interview Round 2');
  });

  test('"Proceed with Concerns" with avg score > 2.5 also auto-advances', async ({ request }) => {
    const { api, application, round } = await setupStandardRound(request, 'Interview Round 2');
    const res = await api.patch(`/api/interviews/${round.id}/feedback`, {
      overall_assessment: 'Positive', round_recommendation: 'Proceed with Concerns',
      scores_per_area: { Technical: 3, Communication: 4 }, confidence_level: 'Medium',
    });
    const { auto_advanced } = await res.json();
    expect(auto_advanced).toEqual({ from: 'Interview Round 2', to: 'Assignment Round' });
    const appRes = await api.get(`/api/applications/${application.id}`);
    expect((await appRes.json()).application.stage).toBe('Assignment Round');
  });

  test('"Hold" recommendation does not auto-advance, even with a high score', async ({ request }) => {
    const { api, application, round } = await setupStandardRound(request, 'Interview Round 1');
    const res = await api.patch(`/api/interviews/${round.id}/feedback`, {
      overall_assessment: 'Neutral', round_recommendation: 'Hold',
      scores_per_area: { Technical: 5, Communication: 5 }, confidence_level: 'Medium',
    });
    const { auto_advanced } = await res.json();
    expect(auto_advanced).toBeNull();
    const appRes = await api.get(`/api/applications/${application.id}`);
    expect((await appRes.json()).application.stage).toBe('Interview Round 1');
  });

  test('"Proceed" but avg score <= 2.5 does not auto-advance (score gate)', async ({ request }) => {
    const { api, application, round } = await setupStandardRound(request, 'Interview Round 1');
    const res = await api.patch(`/api/interviews/${round.id}/feedback`, {
      overall_assessment: 'Neutral', round_recommendation: 'Proceed',
      scores_per_area: { Technical: 2, Communication: 3 }, confidence_level: 'Medium',
    });
    const { auto_advanced } = await res.json();
    expect(auto_advanced).toBeNull();
    const appRes = await api.get(`/api/applications/${application.id}`);
    expect((await appRes.json()).application.stage).toBe('Interview Round 1');
  });

  test('Founders Round: positive feedback advances to Reference Check', async ({ request }) => {
    const { api, application, round } = await setupStandardRound(request, 'Founders Round');
    const res = await api.patch(`/api/interviews/${round.id}/feedback`, {
      overall_assessment: 'Strong Positive', round_recommendation: 'Proceed',
      scores_per_area: { Leadership: 5 }, confidence_level: 'High',
    });
    const { auto_advanced } = await res.json();
    expect(auto_advanced).toEqual({ from: 'Founders Round', to: 'Reference Check' });
  });

  test('Assignment Round: "Approved for Next Round" with avg score > 2.5 advances to Founders Round', async ({ request }) => {
    const { api, application, round } = await setupAssignmentRound(request);
    const res = await api.patch(`/api/interviews/${round.id}/feedback`, {
      assignment_outcome: 'Approved for Next Round',
      score_technical_accuracy: 4, score_problem_solving: 4,
      score_clarity: 4, score_practical_thinking: 4, score_completeness: 4,
    });
    expect(res.status()).toBe(200);
    const { auto_advanced } = await res.json();
    expect(auto_advanced).toEqual({ from: 'Assignment Round', to: 'Founders Round' });
    const appRes = await api.get(`/api/applications/${application.id}`);
    expect((await appRes.json()).application.stage).toBe('Founders Round');
  });

  test('Assignment Round: "Rejected" outcome does not auto-advance', async ({ request }) => {
    const { api, application, round } = await setupAssignmentRound(request);
    const res = await api.patch(`/api/interviews/${round.id}/feedback`, {
      assignment_outcome: 'Rejected',
      score_technical_accuracy: 5, score_problem_solving: 5,
      score_clarity: 5, score_practical_thinking: 5, score_completeness: 5,
    });
    const { auto_advanced } = await res.json();
    expect(auto_advanced).toBeNull();
    const appRes = await api.get(`/api/applications/${application.id}`);
    expect((await appRes.json()).application.stage).toBe('Assignment Round');
  });

  test('does not auto-advance an application that is no longer Active (rejected before feedback landed)', async ({ request }) => {
    const { api, application, round } = await setupStandardRound(request, 'Interview Round 1');
    await api.post(`/api/applications/${application.id}/status`, {
      new_status: 'Rejected', rejection_reason_cat: 'Failed interview',
    });
    const res = await api.patch(`/api/interviews/${round.id}/feedback`, {
      overall_assessment: 'Positive', round_recommendation: 'Proceed',
      scores_per_area: { Technical: 5, Communication: 5 }, confidence_level: 'High',
    });
    expect(res.status()).toBe(200);
    const { auto_advanced } = await res.json();
    expect(auto_advanced).toBeNull();
    const appRes = await api.get(`/api/applications/${application.id}`);
    const stillApp = (await appRes.json()).application;
    expect(stillApp.stage).toBe('Interview Round 1'); // stage is frozen on rejection, unaffected
    expect(stillApp.status).toBe('Rejected');
  });
});
