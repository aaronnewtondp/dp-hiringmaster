// ─────────────────────────────────────────────────────────────────────────────
// Interview feedback authorization — PATCH /api/interviews/:id/feedback (backend/src/routes/interviews.ts:323-342).
//
// The rule (CLAUDE.md "Hiring Manager's real capability set"): feedback rights are NOT gated by persona but by an e-mail match against
// interview_rounds.interviewer_emails. HR-tier (hr_recruiter, leadership, super_admin) may submit on ANY round; everyone else only on a round
// that lists them — and a round that lists nobody at all (no array, or an empty one) has no assignee to check, so it stays open.
// Until now the only test touching this accepted [200, 403] (05-access-control.spec.ts), so a regression that let any Hiring Manager score any
// candidate would have gone unnoticed.
//
// Every test builds its own application and round (no scheduled_date, so no Calendar invite is attempted) and depends on nothing else.
// Assignment rounds are the one exception that cannot avoid the Gmail send attempt (round creation always tries it, and degrades to
// email.sent=false when there are no credentials, which is what an isolated stack has).
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { authed, getSession, getToken, uid } from '../helpers/api';
import { HR_TIER_USERS, activityOf, forgeToken, newApplicationAt, newRound, rawStatus, roundsOf } from '../helpers/api-specs';

const ALEX = 'alex@digitalpaani.com';
const SATYADEV = 'satyadev@digitalpaani.com';
const NOT_ASSIGNED = 'You are not an assigned interviewer for this round.';

// 'Hold' + a mid score: never a "positive enough" result, so the application is not auto-advanced behind the test's back.
const feedback = (extra: Record<string, unknown> = {}) => ({
  eval_areas_assessed: ['Communication'], scores_per_area: { Communication: 3 }, confidence_level: 'Medium',
  overall_assessment: 'Neutral', round_recommendation: 'Hold', strengths_observed: 'Clear communicator', ...extra,
});

async function roundFor(request: Parameters<typeof newApplicationAt>[0], interviewerEmails?: string[], extra: Record<string, unknown> = {}) {
  const { hr, application } = await newApplicationAt(request, 'Interview Round 1');
  const { round } = await newRound(hr, application.id, interviewerEmails === undefined ? extra : { interviewer_emails: interviewerEmails, ...extra });
  return { hr, application, round };
}

async function storedRound(hr: ReturnType<typeof authed>, applicationId: string, roundId: string) {
  return (await roundsOf(hr, applicationId)).find(r => r.id === roundId)!;
}

test.describe('PATCH /api/interviews/:id/feedback — a round that lists interviewers', () => {

  test('a Hiring Manager who is listed submits (200); the round is Submitted and records who entered it', async ({ request }) => {
    const { hr, application, round } = await roundFor(request, [ALEX]);
    const alex = await getSession(request, 'hm_alex');

    const res = await authed(request, alex.token).patch(`/api/interviews/${round.id}/feedback`, feedback({ overall_assessment: 'Positive' }));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.round.feedback_status).toBe('Submitted');
    expect(body.round.entered_by).toBe(alex.user.id);
    expect(body.round.overall_assessment).toBe('Positive');
    expect(body.auto_advanced).toBeNull();

    const stored = await storedRound(hr, application.id, round.id);
    expect(stored.feedback_status).toBe('Submitted');
    expect(stored.feedback_submitted_at).toBeTruthy();
    expect(Number(stored.overall_round_score)).toBe(3);
  });

  test('a Hiring Manager who is NOT listed gets 403 "not an assigned interviewer" and nothing is stored', async ({ request }) => {
    const { hr, application, round } = await roundFor(request, [ALEX]);
    const satyadev = await getToken(request, 'hm_satyadev');

    const res = await authed(request, satyadev).patch(`/api/interviews/${round.id}/feedback`, feedback({ overall_assessment: 'Strong Positive' }));
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe(NOT_ASSIGNED);

    const stored = await storedRound(hr, application.id, round.id);
    expect(stored.feedback_status).toBe('Pending');
    expect(stored.overall_assessment).toBeNull();
    expect(stored.entered_by).toBeNull();
    expect(stored.feedback_submitted_at).toBeNull();
    const events = (await activityOf(hr, application.id)).map(a => a.event_type);
    expect(events).not.toContain('Interview Feedback Submitted');
  });

  test('the e-mail match ignores case: a listed upper-case address matches the lower-case sign-in e-mail, and the reverse', async ({ request }) => {
    // Direction 1: the round stores the address as typed (POST /interviews only validates its shape), the token carries users.email.
    const upper = await roundFor(request, ['ALEX@DigitalPaani.COM']);
    expect(upper.round.interviewer_emails).toEqual(['ALEX@DigitalPaani.COM']);
    const alexToken = await getToken(request, 'hm_alex');
    const a = await authed(request, alexToken).patch(`/api/interviews/${upper.round.id}/feedback`, feedback());
    expect(a.status()).toBe(200);

    // Direction 2: the route lower-cases the TOKEN's e-mail too. Real tokens always carry the stored (lower-case) e-mail, so mint one
    // for Alex's real user id with a mixed-case e-mail to exercise that half.
    const lower = await roundFor(request, [ALEX]);
    const alex = await getSession(request, 'hm_alex');
    const mixed = forgeToken({ userId: alex.user.id, email: 'Alex@DigitalPaani.com', persona: 'hiring_manager', name: alex.user.name });
    const b = await authed(request, mixed).patch(`/api/interviews/${lower.round.id}/feedback`, feedback());
    expect(b.status()).toBe(200);
  });

  test('a look-alike address is not a match: the whole address is compared, not a prefix or a substring', async ({ request }) => {
    const { round } = await roundFor(request, ['alex.other@digitalpaani.com', 'xalex@digitalpaani.com']);
    const alexToken = await getToken(request, 'hm_alex');
    const res = await authed(request, alexToken).patch(`/api/interviews/${round.id}/feedback`, feedback());
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe(NOT_ASSIGNED);
  });

  test('with several interviewers listed, each of them may submit and an outsider may not', async ({ request }) => {
    const { hr, application, round } = await roundFor(request, [SATYADEV, ALEX]);
    for (const who of ['hm_alex', 'hm_satyadev'] as const) {
      const res = await authed(request, await getToken(request, who)).patch(`/api/interviews/${round.id}/feedback`, feedback());
      expect(res.status(), `${who} is listed`).toBe(200);
    }
    // Deeksha is a real Hiring Manager (seed.sql) who is not on this round: a token for her is refused.
    const deeksha = forgeToken({ email: 'deeksha@digitalpaani.com', persona: 'hiring_manager', name: 'Deeksha Chaturvedi' });
    const outsider = await authed(request, deeksha).patch(`/api/interviews/${round.id}/feedback`, feedback());
    expect(outsider.status()).toBe(403);
    expect((await storedRound(hr, application.id, round.id)).feedback_status).toBe('Submitted');
  });

  test('HR-tier users (hr, hr2, leadership, super_admin) may submit on a round that lists only someone else', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Interview Round 1');
    for (const who of HR_TIER_USERS) {
      const { round } = await newRound(hr, application.id, { interviewer_emails: [ALEX] });
      const session = await getSession(request, who);
      const res = await authed(request, session.token).patch(`/api/interviews/${round.id}/feedback`, feedback());
      expect(res.status(), `${who} may relay feedback on any round`).toBe(200);
      expect((await res.json()).round.entered_by).toBe(session.user.id);
    }
  });
});

test.describe('PATCH /api/interviews/:id/feedback — a round that lists nobody is open', () => {

  test('no interviewer_emails at all: every Hiring Manager may submit (200)', async ({ request }) => {
    const { hr, application, round } = await roundFor(request);
    expect(round.interviewer_emails == null).toBe(true);
    for (const who of ['hm_alex', 'hm_satyadev'] as const) {
      const res = await authed(request, await getToken(request, who)).patch(`/api/interviews/${round.id}/feedback`, feedback());
      expect(res.status(), who).toBe(200);
    }
    expect((await storedRound(hr, application.id, round.id)).feedback_status).toBe('Submitted');
  });

  test('an empty interviewer_emails array counts as nobody assigned (200 for any Hiring Manager)', async ({ request }) => {
    const { round } = await roundFor(request, []);
    expect(round.interviewer_emails).toEqual([]);
    const res = await authed(request, await getToken(request, 'hm_satyadev')).patch(`/api/interviews/${round.id}/feedback`, feedback());
    expect(res.status()).toBe(200);
  });
});

test.describe('PATCH /api/interviews/:id/feedback — unknown round and anonymous callers', () => {

  test('an unknown round is 404 "Round not found" for a Hiring Manager and for HR alike', async ({ request }) => {
    for (const who of ['hm_alex', 'hr'] as const) {
      const res = await authed(request, await getToken(request, who)).patch(`/api/interviews/IR-NOPE-${uid()}/feedback`, feedback());
      expect(res.status(), who).toBe(404);
      expect((await res.json()).error).toBe('Round not found');
    }
  });

  test('no token and a garbage token are both 401, and the round is untouched', async ({ request }) => {
    const { hr, application, round } = await roundFor(request, [ALEX]);
    const none = await rawStatus(request, 'PATCH', `/api/interviews/${round.id}/feedback`, { data: feedback() });
    expect(none.status).toBe(401);
    const junk = await rawStatus(request, 'PATCH', `/api/interviews/${round.id}/feedback`, { headers: { Authorization: 'Bearer not.a.jwt' }, data: feedback() });
    expect(junk.status).toBe(401);
    expect((await storedRound(hr, application.id, round.id)).feedback_status).toBe('Pending');
  });
});

test.describe('PATCH /api/interviews/:id/feedback — Assignment rounds', () => {

  test('an unlisted Hiring Manager is refused (403) and no outcome is stored; the listed one records it', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Assignment Round');
    // Round creation sends the assignment e-mail: with no Google credentials that degrades to email.sent=false (the round is still created).
    const { round } = await newRound(hr, application.id, {
      round_name: 'Assignment Round', round_type: 'Assignment', interviewer_emails: [ALEX],
      mail_body_content: 'Please find your assignment below.', assignment_link: 'https://example.com/assignment',
    });
    const scores = {
      assignment_outcome: 'Approved for Next Round', score_technical_accuracy: 4, score_problem_solving: 4,
      score_clarity: 4, score_practical_thinking: 4, score_completeness: 4,
    };

    const refused = await authed(request, await getToken(request, 'hm_satyadev')).patch(`/api/interviews/${round.id}/feedback`, scores);
    expect(refused.status()).toBe(403);
    expect((await refused.json()).error).toBe(NOT_ASSIGNED);
    const before = await storedRound(hr, application.id, round.id);
    expect(before.feedback_status).toBe('Pending');
    expect(before.assignment_outcome).toBeNull();
    expect(before.assignment_overall_score).toBeNull();

    const accepted = await authed(request, await getToken(request, 'hm_alex')).patch(`/api/interviews/${round.id}/feedback`, scores);
    expect(accepted.status()).toBe(200);
    const body = await accepted.json();
    expect(body.round.assignment_outcome).toBe('Approved for Next Round');
    expect(Number(body.round.assignment_overall_score)).toBe(4);
    expect(body.round.feedback_status).toBe('Submitted');
  });
});

test.describe('PATCH /api/interviews/:id/feedback — behaviour that is NOT a rule (pinned as it is today)', () => {

  test('TODAY: a second submission by the assigned interviewer silently overwrites the first (200 both times, no 409, two activity rows)', async ({ request }) => {
    const { hr, application, round } = await roundFor(request, [ALEX]);
    const alex = authed(request, await getToken(request, 'hm_alex'));

    const first = await alex.patch(`/api/interviews/${round.id}/feedback`, feedback({ overall_assessment: 'Concern', strengths_observed: 'first draft' }));
    expect(first.status()).toBe(200);
    const second = await alex.patch(`/api/interviews/${round.id}/feedback`, feedback({ overall_assessment: 'Strong Positive', strengths_observed: 'second draft' }));
    expect(second.status()).toBe(200);

    const stored = await storedRound(hr, application.id, round.id);
    expect(stored.overall_assessment).toBe('Strong Positive');
    expect(stored.strengths_observed).toBe('second draft');
    const submissions = (await activityOf(hr, application.id)).filter(a => a.event_type === 'Interview Feedback Submitted');
    expect(submissions).toHaveLength(2);
  });

  test('TODAY: an out-of-range value (overall_assessment) is a 500 from the CHECK constraint, not a 400, and the round stays Pending', async ({ request }) => {
    const { hr, application, round } = await roundFor(request, [ALEX]);
    const res = await authed(request, await getToken(request, 'hm_alex')).patch(`/api/interviews/${round.id}/feedback`, feedback({ overall_assessment: 'Excellent' }));
    expect(res.status()).toBe(500);
    expect((await res.json()).error).toBe('Internal server error');
    // The transaction rolled back: no half-written round and no activity row.
    const stored = await storedRound(hr, application.id, round.id);
    expect(stored.feedback_status).toBe('Pending');
    expect(stored.overall_assessment).toBeNull();
    expect((await activityOf(hr, application.id)).map(a => a.event_type)).not.toContain('Interview Feedback Submitted');
  });
});
