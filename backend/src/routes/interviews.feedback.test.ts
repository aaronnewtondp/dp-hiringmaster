// First, before any router is imported (see src/test/routeHarness.ts): express-async-errors must patch Express before a route exists.
import 'express-async-errors';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// routes/interviews.ts: who may submit feedback on a round, what a submission writes and when it moves the candidate on by itself,
// and the Assignment round's e-mail flow. CLAUDE.md: a hiring_manager may submit interview feedback only for rounds they are
// actually listed in (interview_rounds.interviewer_emails — an e-mail match, not a persona), "enforced in PATCH /interviews/:id/feedback,
// not just a comment"; a round with no interviewer_emails at all (e.g. Assignment rounds) has no assignee to check, so it stays open to
// any persona; HR-tier may submit for any round.
// Real router and real authenticate / require* middleware; the database, Calendar, Gmail and the ResumeIQ trigger are replaced.

const h = vi.hoisted(() => ({ createInterviewCalendarEvent: vi.fn(), sendAssignmentEmail: vi.fn(), runResumeIQScoring: vi.fn() }));
vi.mock('../db/index.js', async () => (await import('../test/fakeDb.js')).dbModule());
vi.mock('../services/calendarService.js', () => ({ createInterviewCalendarEvent: h.createInterviewCalendarEvent }));
vi.mock('../services/gmailService.js', () => ({ sendAssignmentEmail: h.sendAssignmentEmail }));
vi.mock('../services/resumeIQTrigger.js', () => ({ runResumeIQScoring: h.runResumeIQScoring }));   // applications.ts (imported for getSlaHours) pulls it in

import interviewsRouter from './interviews.js';
import { getSlaHours } from './applications.js';
import { FEEDBACK_DUE_ACTION_TYPES, NOT_SCHEDULED_ACTION_TYPES, STAGE_SLA_ACTION_TYPES } from '../jobs/slaChecker.js';
import { STAGE_ORDER } from '../types/index.js';
import { fakeDb } from '../test/fakeDb.js';
import { ApiClient, ALL_PERSONAS, TEST_JWT_SECRET, TEST_USERS, buildApp, setEnv, type Actor } from '../test/routeHarness.js';
import type { Persona } from '../types/index.js';

const api = new ApiClient(buildApp(app => app.use('/api/interviews', interviewsRouter)));
let restoreEnv: () => void = () => undefined;

const NOW = new Date('2026-10-29T10:00:00.000Z');
const HR_TIER = ['hr_recruiter', 'leadership', 'super_admin'] as const;
const ROUND_ID = 'IR0001';
const APP_ID = 'A9001';
const HM_EMAIL = TEST_USERS.hiring_manager.email;       // manager@example.test

const ROUND = {
  id: ROUND_ID, application_id: APP_ID, round_name: 'Round 1', round_type: 'Standard', round_number: 1,
  interviewer_emails: [HM_EMAIL, 'other.interviewer@example.test'] as string[] | null, feedback_status: 'Pending',
};
const ASSIGNMENT_ROUND = { ...ROUND, id: 'IR0002', round_name: 'Assignment', round_type: 'Assignment', interviewer_emails: null };
const APP_AT = (stage: string, over: Record<string, unknown> = {}) => ({ stage, status: 'Active', candidate_id: 'C9001', role_id: 'R9001', ai_fit_score: 60, ...over });

const SQL = {
  round: /^SELECT \* FROM interview_rounds WHERE id=\$1$/,
  standardUpdate: /^UPDATE interview_rounds SET eval_areas_assessed=\$1, scores_per_area=\$2, overall_round_score=\$3/,
  assignmentUpdate: /^UPDATE interview_rounds SET assignment_outcome=\$1, score_technical_accuracy=\$2/,
  resolveFeedbackDue: /^UPDATE pending_actions SET resolved=true, resolved_at=NOW\(\) WHERE application_id=\$1 AND action_type = ANY\(\$2::text\[\]\) AND resolved=false$/,
  breachOff: /^UPDATE applications SET sla_breach=false WHERE id=\$1 AND sla_breach=true$/,
  appIds: /^SELECT candidate_id, role_id FROM applications WHERE id=\$1$/,
  appStage: /^SELECT stage, status, candidate_id, role_id, ai_fit_score FROM applications WHERE id=\$1$/,
  advance: /^UPDATE applications SET stage=\$1, stage_entry_time=NOW\(\), sla_hours=\$2, sla_breach=false, last_updated=NOW\(\) WHERE id=\$3$/,
  resolveStagePending: /^UPDATE pending_actions SET resolved=true, resolved_at=NOW\(\) WHERE application_id=\$1 AND resolved=false AND action_type = ANY\(\$2::text\[\]\)$/,
  feedbackLog: /^INSERT INTO activity_log \(application_id, candidate_id, role_id, event_type, event_detail, new_value, performed_by, performed_by_name\)/,
  stageLog: /^INSERT INTO activity_log \(application_id, candidate_id, role_id, event_type, event_detail, old_value, new_value, performed_by, performed_by_name\)/,
};

function programRound(round: Record<string, unknown> | null = ROUND, app: Record<string, unknown> | null = APP_AT('Interview Round 1')) {
  fakeDb.whenOne(SQL.round, round);
  fakeDb.whenOne(SQL.appIds, { candidate_id: 'C9001', role_id: 'R9001' });
  fakeDb.whenOne(SQL.appStage, app);
}

const STANDARD_FEEDBACK = {
  eval_areas_assessed: ['Technical', 'Communication'], scores_per_area: { Technical: 4, Communication: 3 }, confidence_level: 'High',
  overall_assessment: 'Solid', strengths_observed: 'Clear thinking', key_concerns: 'None', unresolved_questions: null, suggested_probe_areas: null,
  round_recommendation: 'Proceed', notes: 'n',
};
const feedback = (as: Actor, body: Record<string, unknown> = STANDARD_FEEDBACK, id = ROUND_ID) => api.patch(`/api/interviews/${id}/feedback`, { as, body });
const nothingWritten = () => { expect(fakeDb.writes()).toEqual([]); expect(fakeDb.tx.started).toBe(0); };

beforeAll(async () => { await api.start(); });
afterAll(async () => { await api.stop(); });
beforeEach(() => {
  fakeDb.reset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.createInterviewCalendarEvent.mockReset().mockResolvedValue({ eventId: 'evt-1', eventLink: 'https://calendar.example.test/evt-1' });
  h.sendAssignmentEmail.mockReset().mockResolvedValue(undefined);
  restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { restoreEnv(); vi.useRealTimers(); vi.restoreAllMocks(); });

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('PATCH /:id/feedback — who may submit', () => {
  it('an unknown round is 404 for everyone, and nothing is written', async () => {
    programRound(null);
    for (const persona of ALL_PERSONAS) expect([persona, (await feedback(persona)).status]).toEqual([persona, 404]);
    nothingWritten();
  });

  it('a hiring_manager LISTED in interviewer_emails may submit: 200, the feedback is written, and entered_by is that person', async () => {
    programRound();
    const res = await feedback('hiring_manager');
    expect(res.status).toBe(200);
    expect(fakeDb.one(SQL.standardUpdate).params.at(-2)).toBe('U9002');
  });

  it('the e-mail comparison ignores case on both sides', async () => {
    programRound({ ...ROUND, interviewer_emails: ['MANAGER@Example.TEST'] });
    expect((await feedback('hiring_manager')).status).toBe(200);
    fakeDb.reset();
    programRound({ ...ROUND, interviewer_emails: [HM_EMAIL] });
    expect((await feedback({ ...TEST_USERS.hiring_manager, email: 'Manager@EXAMPLE.test' })).status).toBe(200);
  });

  it('a hiring_manager NOT listed is 403 "You are not an assigned interviewer for this round.", before anything is written', async () => {
    programRound({ ...ROUND, interviewer_emails: ['someone.else@example.test'] });
    const res = await feedback('hiring_manager');
    expect([res.status, res.body]).toEqual([403, { error: 'You are not an assigned interviewer for this round.' }]);
    nothingWritten();
  });

  it.each([
    ['the same name at another domain', 'manager@example.test.evil'],
    ['a longer local part', 'senior.manager@example.test'],
    ['a shorter address', 'anager@example.test'],
    ['the address with whitespace', ' manager@example.test'],
  ])('only an exact (case-insensitive) address counts: %s is not a match', async (_what, listed) => {
    programRound({ ...ROUND, interviewer_emails: [listed] });
    expect((await feedback('hiring_manager')).status).toBe(403);
    nothingWritten();
  });

  it('the check is on the e-mail in the token, not on the name: a hiring_manager with the right name but another address is refused', async () => {
    programRound();
    const res = await feedback({ ...TEST_USERS.hiring_manager, email: 'impostor@example.test' });
    expect(res.status).toBe(403);
    nothingWritten();
  });

  it.each([['null', null], ['an empty list', []]])('a round with %s as interviewer_emails has nobody to check against, so any persona may submit', async (_what, interviewers) => {
    for (const persona of ALL_PERSONAS) {
      fakeDb.reset();
      programRound({ ...ROUND, interviewer_emails: interviewers });
      expect([persona, (await feedback(persona)).status]).toEqual([persona, 200]);
    }
  });

  it('HR-tier may submit for ANY round, listed or not (relaying scores given verbally); the submission is attributed to them', async () => {
    for (const persona of HR_TIER) {
      fakeDb.reset();
      programRound({ ...ROUND, interviewer_emails: ['someone.else@example.test'] });
      const res = await feedback(persona);
      expect([persona, res.status]).toEqual([persona, 200]);
      expect(fakeDb.one(SQL.standardUpdate).params.at(-2)).toBe(TEST_USERS[persona].userId);
    }
  });

  it('a leftover persona (the retired "interviewer") is treated like a hiring_manager: an unlisted one is refused, a listed one may submit', async () => {
    const odd = { ...TEST_USERS.hiring_manager, persona: 'interviewer' as unknown as Persona };
    programRound({ ...ROUND, interviewer_emails: ['someone.else@example.test'] });
    expect((await feedback(odd)).status).toBe(403);
    fakeDb.reset(); programRound();
    expect((await feedback(odd)).status).toBe(200);
  });

  it('the gate runs before the body is looked at: an unlisted hiring_manager sending nothing is 403, not a validation answer', async () => {
    programRound({ ...ROUND, interviewer_emails: ['someone.else@example.test'] });
    expect((await feedback('hiring_manager', {})).status).toBe(403);
  });

  it('on an Assignment round with nobody listed a hiring_manager may submit too', async () => {
    programRound(ASSIGNMENT_ROUND);
    const res = await feedback('hiring_manager', { assignment_outcome: 'Approved for Next Round', score_technical_accuracy: 4, score_problem_solving: 4, score_clarity: 4, score_practical_thinking: 4, score_completeness: 4 }, 'IR0002');
    expect(res.status).toBe(200);
    expect(fakeDb.find(SQL.assignmentUpdate)).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('PATCH /:id/feedback — what a submission writes', () => {
  it('a Standard round: the whole form is stored, scores_per_area as JSON, the overall score is their average to one decimal, and the round becomes Submitted — all in one transaction', async () => {
    programRound();
    await feedback('hr_recruiter', { ...STANDARD_FEEDBACK, scores_per_area: { A: 4, B: 3, C: 3 } });
    const u = fakeDb.one(SQL.standardUpdate);
    expect(u.sql).toContain(`feedback_status='Submitted', feedback_submitted_at=NOW()`);
    expect(u.params).toEqual([
      ['Technical', 'Communication'], JSON.stringify({ A: 4, B: 3, C: 3 }), 3.3, 'High', 'Solid', 'Clear thinking', 'None', null, null, 'Proceed', 'n', 'U9001', ROUND_ID,
    ]);
    expect(u.inTransaction).toBe(true);
  });

  it.each([
    [{ a: 4, b: 3, c: 5 }, 4], [{ a: 3, b: 4 }, 3.5], [{ a: 1, b: 2, c: 2 }, 1.7], [{ a: 5 }, 5], [{}, null],
  ])('the overall round score for %j is %s', async (scores, expected) => {
    programRound();
    await feedback('hr_recruiter', { ...STANDARD_FEEDBACK, scores_per_area: scores });
    expect(fakeDb.one(SQL.standardUpdate).params[2]).toBe(expected);
  });

  it('no scores at all leaves the overall score empty (null) rather than 0', async () => {
    programRound();
    await feedback('hr_recruiter', { ...STANDARD_FEEDBACK, scores_per_area: undefined });
    expect(fakeDb.one(SQL.standardUpdate).params[2]).toBeNull();
  });

  it('resolves whichever feedback-due breach applied (the whole family) and clears the application\'s breach flag', async () => {
    programRound();
    await feedback('hr_recruiter');
    expect(fakeDb.one(SQL.resolveFeedbackDue).params).toEqual([APP_ID, FEEDBACK_DUE_ACTION_TYPES]);
    expect(fakeDb.one(SQL.breachOff).params).toEqual([APP_ID]);
  });

  it('is logged as "Interview Feedback Submitted" with the round, the assessment and the score, the recommendation as the new value, against the acting user', async () => {
    programRound();
    await feedback('hiring_manager');
    expect(fakeDb.find(SQL.feedbackLog)[0].params).toEqual([APP_ID, 'C9001', 'R9001', 'Interview Feedback Submitted', 'Round 1: Solid (score: 3.5)', 'Proceed', 'U9002', 'Test Hiring Manager']);
  });

  it('an Assignment round stores the five rubric scores, the outcome and the weighted total (40/25/15/10/10) and logs "Assignment Evaluated"', async () => {
    programRound({ ...ASSIGNMENT_ROUND });
    await feedback('hr_recruiter', {
      assignment_outcome: 'Approved for Next Round', score_technical_accuracy: 5, score_problem_solving: 3, score_clarity: 5,
      score_practical_thinking: 1, score_completeness: 1, assignment_notes: 'ok',
    }, 'IR0002');
    const u = fakeDb.one(SQL.assignmentUpdate);
    expect(u.params).toEqual(['Approved for Next Round', 5, 3, 5, 1, 1, 3.7, 'ok', 'U9001', 'IR0002']);        // 2 + .75 + .75 + .1 + .1
    expect(fakeDb.find(SQL.standardUpdate)).toEqual([]);
    expect(fakeDb.find(SQL.feedbackLog)[0].params.slice(3, 6)).toEqual(['Assignment Evaluated', 'Assignment: Approved for Next Round (score: 3.7/5)', 'Approved for Next Round']);
  });

  it('the weighted total needs all five scores: with one missing it is null (and the log says "—")', async () => {
    programRound({ ...ASSIGNMENT_ROUND });
    await feedback('hr_recruiter', { assignment_outcome: 'Rejected', score_technical_accuracy: 5, score_problem_solving: 3, score_clarity: 5, score_practical_thinking: 1 }, 'IR0002');
    expect(fakeDb.one(SQL.assignmentUpdate).params[6]).toBeNull();
    expect(String(fakeDb.find(SQL.feedbackLog)[0].params[4])).toContain('(score: —/5)');
  });

  it('a failure inside the transaction rolls it back and is a 500; nothing after it (no auto-advance) runs', async () => {
    programRound();
    fakeDb.failing(SQL.breachOff, 'update failed');
    const res = await feedback('hr_recruiter');
    expect(res.status).toBe(500);
    expect(fakeDb.tx).toEqual({ started: 1, committed: 0, rolledBack: 1 });
    expect(fakeDb.find(SQL.appStage)).toEqual([]);
  });

  it('characterization: the body is not validated — an empty submission is accepted, marks the round Submitted with empty fields, and resolves the overdue-feedback breach', async () => {
    programRound();
    const res = await feedback('hiring_manager', {});
    expect(res.status).toBe(200);
    const u = fakeDb.one(SQL.standardUpdate);
    expect(u.params.slice(0, 11).every(p => p == null)).toBe(true);                // every field of the form is empty (undefined is bound as NULL)
    expect(u.sql).toContain(`feedback_status='Submitted'`);
    expect(fakeDb.find(SQL.resolveFeedbackDue)).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('PATCH /:id/feedback — moving the candidate on by itself after positive feedback', () => {
  const submit = (body: Record<string, unknown> = STANDARD_FEEDBACK, as: Actor = 'hr_recruiter') => feedback(as, body);
  const positive = { ...STANDARD_FEEDBACK, scores_per_area: { a: 4, b: 4 }, round_recommendation: 'Proceed' };

  describe('advances to the NEXT stage in STAGE_ORDER when the round is positive and the application is Active at that round\'s own stage', () => {
    it.each([
      ['Interview Round 1', 'Interview Round 2'], ['Interview Round 2', 'Assignment Round'], ['Assignment Round', 'Founders Round'], ['Founders Round', 'Reference Check'],
    ])('%s → %s', async (from, to) => {
      programRound(ROUND, APP_AT(from, { ai_fit_score: 90 }));
      const res = await submit(positive);
      expect(res.body.auto_advanced).toEqual({ from, to });
      const move = fakeDb.one(SQL.advance);
      expect(move.params).toEqual([to, getSlaHours(to, 90), APP_ID]);
      expect(move.inTransaction).toBe(true);
      expect(fakeDb.one(SQL.resolveStagePending).params).toEqual([APP_ID, STAGE_SLA_ACTION_TYPES]);
      expect(fakeDb.one(SQL.stageLog).sql).toContain("'Stage Changed'");
      expect(fakeDb.one(SQL.stageLog).params).toEqual([APP_ID, 'C9001', 'R9001', `Auto-advanced to ${to} — positive feedback on Round 1`, from, to, 'U9001', 'Test Recruiter']);
    });

    it('the stages that can trigger it are exactly Interview Round 1, Interview Round 2, Assignment Round and Founders Round: feedback arriving at any other stage moves nobody', async () => {
      const moved: string[] = [];
      for (const stage of STAGE_ORDER) {
        fakeDb.reset();
        programRound(ROUND, APP_AT(stage));
        const res = await submit(positive);
        if (res.body.auto_advanced) moved.push(`${stage} → ${res.body.auto_advanced.to}`);
      }
      expect(moved).toEqual(['Interview Round 1 → Interview Round 2', 'Interview Round 2 → Assignment Round', 'Assignment Round → Founders Round', 'Founders Round → Reference Check']);
    });

    it('a hiring_manager\'s own positive feedback advances the candidate too (whoever submits it), and the move is attributed to them', async () => {
      programRound(ROUND, APP_AT('Interview Round 1'));
      const res = await feedback('hiring_manager', positive);
      expect(res.body.auto_advanced).toEqual({ from: 'Interview Round 1', to: 'Interview Round 2' });
      expect(fakeDb.one(SQL.stageLog).params.slice(6)).toEqual(['U9002', 'Test Hiring Manager']);
    });

    it('"Proceed with Concerns" counts as positive too', async () => {
      programRound();
      expect((await submit({ ...positive, round_recommendation: 'Proceed with Concerns' })).body.auto_advanced).not.toBeNull();
    });
  });

  describe('does NOT advance', () => {
    it.each([
      ['recommendation "Reject"', { round_recommendation: 'Reject' }],
      ['recommendation "Hold"', { round_recommendation: 'Hold' }],
      ['no recommendation', { round_recommendation: undefined }],
      ['a recommendation spelled differently', { round_recommendation: 'proceed' }],
      ['an average of exactly 2.5 (it must EXCEED the midpoint)', { scores_per_area: { a: 2, b: 3 } }],
      ['an average below 2.5', { scores_per_area: { a: 2, b: 2 } }],
      ['no scores', { scores_per_area: undefined }],
      ['an empty score set', { scores_per_area: {} }],
    ])('with %s', async (_what, change) => {
      programRound();
      const res = await submit({ ...positive, ...change });
      expect(res.status).toBe(200);
      expect(res.body.auto_advanced).toBeNull();
      expect(fakeDb.find(SQL.advance)).toEqual([]);
      expect(fakeDb.find(SQL.appStage)).toEqual([]);          // not even looked at
    });

    it('just above 2.5 does advance (2.6)', async () => {
      programRound();
      expect((await submit({ ...positive, scores_per_area: { a: 2.6 } })).body.auto_advanced).not.toBeNull();
    });

    it.each(['Hold for Future', 'Rejected', 'Withdrawn', 'Closed', 'Joined'])('when the application is %s rather than Active: late feedback is a no-op, not a surprise jump', async status => {
      programRound(ROUND, APP_AT('Interview Round 1', { status }));
      const res = await submit(positive);
      expect(res.body.auto_advanced).toBeNull();
      expect(fakeDb.find(SQL.advance)).toEqual([]);
    });

    it('when the application cannot be found', async () => {
      programRound(ROUND, null);
      const res = await submit(positive);
      expect(res.status).toBe(200);
      expect(res.body.auto_advanced).toBeNull();
    });
  });

  describe('Assignment rounds', () => {
    const rubric = (outcome: string, score: number) => ({ assignment_outcome: outcome, score_technical_accuracy: score, score_problem_solving: score, score_clarity: score, score_practical_thinking: score, score_completeness: score });

    it('advance only for outcome "Approved for Next Round" with a weighted total above 2.5', async () => {
      programRound(ASSIGNMENT_ROUND, APP_AT('Assignment Round'));
      expect((await feedback('hr_recruiter', rubric('Approved for Next Round', 4), 'IR0002')).body.auto_advanced).toEqual({ from: 'Assignment Round', to: 'Founders Round' });
      for (const [outcome, score] of [['Rejected', 5], ['Approved for Next Round', 2], ['Approved for Next Round', 2.5], ['Approved with Concerns', 5]] as const) {
        fakeDb.reset(); programRound(ASSIGNMENT_ROUND, APP_AT('Assignment Round'));
        const res = await feedback('hr_recruiter', rubric(outcome, score), 'IR0002');
        expect([outcome, score, res.body.auto_advanced]).toEqual([outcome, score, null]);
      }
    });

    it('an incomplete rubric (a score missing) gives no total and so never advances', async () => {
      programRound(ASSIGNMENT_ROUND, APP_AT('Assignment Round'));
      const res = await feedback('hr_recruiter', { ...rubric('Approved for Next Round', 5), score_completeness: undefined }, 'IR0002');
      expect(res.body.auto_advanced).toBeNull();
    });
  });

  it('characterization: scores are not range-checked — a score of 99 passes the "above 2.5" test, so an out-of-range value advances the candidate', async () => {
    programRound(ROUND, APP_AT('Interview Round 1'));
    const res = await feedback('hiring_manager', { ...STANDARD_FEEDBACK, scores_per_area: { a: 99 }, round_recommendation: 'Proceed' });
    expect(fakeDb.one(SQL.standardUpdate).params[2]).toBe(99);
    expect(res.body.auto_advanced).toEqual({ from: 'Interview Round 1', to: 'Interview Round 2' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('POST / — creating a round (HR-tier) and the Assignment e-mail', () => {
  const APP_LOOKUP = /^SELECT a\.candidate_id, a\.role_id, c\.full_name AS candidate_name, c\.email AS candidate_email/;
  const NEXT_ID = /^SELECT id FROM interview_rounds ORDER BY id DESC LIMIT 1$/;
  const INSERT_ROUND = /^INSERT INTO interview_rounds \(id, application_id, round_name, round_type, round_number,/;
  const CANDIDATE = { candidate_id: 'C9001', role_id: 'R9001', candidate_name: 'Candidate Example', candidate_email: 'candidate@example.test', role_title: 'Quality Assurance Engineer', candidate_resume_link: null };
  const create = (as: Actor, body: Record<string, unknown>) => api.post('/api/interviews', { as, body });

  function programCreate(candidate: Record<string, unknown> | null = CANDIDATE, lastId: string | null = null) {
    fakeDb.whenOne(APP_LOOKUP, candidate);
    fakeDb.whenOne(NEXT_ID, lastId ? { id: lastId } : null);
    fakeDb.when(INSERT_ROUND, p => [{
      id: p[0], application_id: p[1], round_name: p[2], round_type: p[3], round_number: p[4], interviewer_emails: p[5], scheduled_date: p[6],
      interview_mode: p[7], focus_areas: p[8], duration_minutes: p[9], assignment_mail_body: p[10], assignment_cc: p[11], assignment_link: p[12],
    }]);
    fakeDb.whenOne(/^SELECT candidate_id, role_id FROM applications WHERE id=\$1$/, { candidate_id: 'C9001', role_id: 'R9001' });
  }
  const ASSIGNMENT = { application_id: APP_ID, round_name: 'Assignment', round_type: 'Assignment', mail_body_content: 'Please complete the attached task.', assignment_link: 'https://docs.example.test/task' };
  const STANDARD = { application_id: APP_ID, round_name: 'Round 1', interviewer_emails: [HM_EMAIL], scheduled_date: '2026-11-02T09:30:00.000Z', interview_mode: 'Video', duration_minutes: 45 };

  it('is HR-tier only: a hiring_manager gets 403 before the database', async () => {
    programCreate();
    const res = await create('hiring_manager', STANDARD);
    expect([res.status, res.body]).toEqual([403, { error: 'HR access required' }]);
    expect(fakeDb.untouched()).toBe(true);
  });

  it.each([
    ['no application_id', { round_name: 'x' }], ['no round_name', { application_id: APP_ID }],
  ])('%s → 400', async (_what, body) => {
    programCreate();
    expect((await create('hr_recruiter', body)).status).toBe(400);
    nothingWritten();
  });

  it.each([
    ['interviewer_emails that is not a list', { interviewer_emails: 'a@example.test' }, 'interviewer_emails must be an array of strings'],
    ['interviewer_emails with a non-string', { interviewer_emails: ['a@example.test', 7] }, 'interviewer_emails must be an array of strings'],
    ['an invalid interviewer address', { interviewer_emails: ['not-an-email'] }, '"not-an-email" is not a valid email address'],
    ['an Assignment with no mail body', { ...ASSIGNMENT, mail_body_content: '' }, 'mail_body_content and assignment_link are required for Assignment rounds'],
    ['an Assignment with no link', { ...ASSIGNMENT, assignment_link: undefined }, 'mail_body_content and assignment_link are required for Assignment rounds'],
    ['an Assignment whose cc is not a list', { ...ASSIGNMENT, cc: 'a@example.test' }, 'cc must be an array of strings'],
    ['an Assignment with an invalid cc address', { ...ASSIGNMENT, cc: ['a@example.test', 'nope'] }, '"nope" is not a valid email address'],
  ])('%s → 400 with its own message, before anything is written', async (_what, extra, message) => {
    programCreate();
    const res = await create('hr_recruiter', { ...STANDARD, ...extra });
    expect([res.status, res.body.error]).toEqual([400, message]);
    nothingWritten();
  });

  it('an unknown application is 404', async () => {
    programCreate(null);
    expect((await create('hr_recruiter', STANDARD)).status).toBe(404);
    nothingWritten();
  });

  describe('round ids (nextRoundId)', () => {
    it.each([[null, 'IR0001'], ['IR0001', 'IR0002'], ['IR0009', 'IR0010'], ['IR0999', 'IR1000'], ['IR9999', 'IR10000']])('after %s the next round is %s (zero-padded to four digits, never truncated)', async (last, next) => {
      programCreate(CANDIDATE, last);
      const res = await create('hr_recruiter', STANDARD);
      expect(res.body.round.id).toBe(next);
      expect(fakeDb.one(INSERT_ROUND).params[0]).toBe(next);
      expect(fakeDb.one(NEXT_ID).inTransaction).toBe(true);
    });

    it('characterization: the "last" id is the greatest as TEXT, so once IR10000 exists the latest is again IR9999 and the next id issued is IR10000 — an id that already exists', async () => {
      const existing = ['IR9998', 'IR9999', 'IR10000'];
      fakeDb.whenOne(APP_LOOKUP, CANDIDATE);
      fakeDb.when(NEXT_ID, () => [{ id: [...existing].sort().reverse()[0] }]);          // what ORDER BY id DESC returns for text ids
      fakeDb.when(INSERT_ROUND, p => [{ id: p[0] }]);
      const res = await create('hr_recruiter', STANDARD);
      expect(existing).toContain(res.body.round.id);
      expect(res.body.round.id).toBe('IR10000');
    });
  });

  describe('a Standard round and its calendar invite', () => {
    it('with a date and interviewers it is synced: the invite goes from the scheduling user\'s calendar to the interviewers, the candidate and hr@, with no duplicates, and the response says so', async () => {
      programCreate();
      const res = await create('hr_recruiter', { ...STANDARD, interviewer_emails: [HM_EMAIL, 'hr@digitalpaani.com'] });
      expect(res.status).toBe(201);
      expect(h.createInterviewCalendarEvent).toHaveBeenCalledTimes(1);
      const arg = h.createInterviewCalendarEvent.mock.calls[0][0];
      expect(arg).toMatchObject({
        organizerEmail: TEST_USERS.hr_recruiter.email, startTime: '2026-11-02T09:30:00.000Z', durationMinutes: 45, mode: 'Video',
        summary: 'Round 1 — Candidate Example (Quality Assurance Engineer)',
      });
      expect(arg.attendees).toEqual([HM_EMAIL, 'hr@digitalpaani.com', 'candidate@example.test']);
      expect(res.body.calendar).toEqual({ synced: true, event_link: 'https://calendar.example.test/evt-1' });
      expect(fakeDb.one(/^UPDATE interview_rounds SET calendar_event_id=\$1, calendar_event_link=\$2, calendar_sync_error=NULL/).params).toEqual(['evt-1', 'https://calendar.example.test/evt-1', 'IR0001']);
    });

    it('a failed invite does not fail the round: 201, { synced: false } with a plain message, the error stored (cut to 500) and logged', async () => {
      programCreate();
      h.createInterviewCalendarEvent.mockRejectedValue(new Error('calendar said no ' + 'x'.repeat(600)));
      const res = await create('hr_recruiter', STANDARD);
      expect(res.status).toBe(201);
      expect(res.body.calendar).toEqual({ synced: false, error: 'Round scheduled, but the calendar invite failed — you may need to notify interviewers manually.' });
      expect(String(fakeDb.one(/^UPDATE interview_rounds SET calendar_sync_error=\$1, updated_at=NOW\(\) WHERE id=\$2$/).params[0])).toHaveLength(500);
      expect(fakeDb.find(SQL.feedbackLog).some(c => c.params.includes('Calendar Invite Failed'))).toBe(true);
    });

    it('with no date or no interviewers nothing is attempted, and that is said explicitly instead of looking like a sync', async () => {
      programCreate();
      const res = await create('hr_recruiter', { application_id: APP_ID, round_name: 'Round 1' });
      expect(res.status).toBe(201);
      expect(h.createInterviewCalendarEvent).not.toHaveBeenCalled();
      expect(res.body.calendar).toEqual({ synced: false, error: 'No calendar invite was sent — this round has no a scheduled date/time and interviewer emails set.' });
    });

    it('a dated Standard round resolves the "Not Scheduled" breach family and "Schedule interview"; an undated one (TBD) does not', async () => {
      programCreate();
      await create('hr_recruiter', STANDARD);
      const resolve = fakeDb.one(/^UPDATE pending_actions SET resolved=true, resolved_at=NOW\(\) WHERE application_id=\$1 AND action_type = ANY\(\$2::text\[\]\) AND resolved=false$/);
      expect(resolve.params).toEqual([APP_ID, [...NOT_SCHEDULED_ACTION_TYPES, 'Schedule interview']]);
      fakeDb.reset(); programCreate();
      await create('hr_recruiter', { application_id: APP_ID, round_name: 'Round 1' });
      expect(fakeDb.find(/action_type = ANY/)).toEqual([]);
    });
  });

  describe('an Assignment round sends its e-mail from the shared HR inbox path', () => {
    it('creates the round and sends subject, body, link and supporting documentation to the candidate (cc as given); records the send and a 60-hour deadline; resolves "Assignment Not Sent"', async () => {
      programCreate();
      const res = await create('hr_recruiter', { ...ASSIGNMENT, cc: ['lead@example.test'], supporting_documentation: 'https://docs.example.test/extra' });
      expect(res.status).toBe(201);
      expect(h.sendAssignmentEmail).toHaveBeenCalledTimes(1);
      expect(h.sendAssignmentEmail).toHaveBeenCalledWith({
        to: 'candidate@example.test', cc: ['lead@example.test'], subject: 'DigitalPaani Quality Assurance Engineer Assignment - Candidate Example',
        text: 'Please complete the attached task.\n\nAssignment Link: https://docs.example.test/task\nSupporting Documentation: https://docs.example.test/extra',
      });
      expect(res.body.email).toEqual({ sent: true });
      expect(res.body.calendar).toBeUndefined();               // an Assignment has no meeting to put on a calendar
      expect(h.createInterviewCalendarEvent).not.toHaveBeenCalled();
      const sent = fakeDb.one(/^UPDATE interview_rounds SET assignment_send_date=NOW\(\), assignment_deadline=\$1, assignment_email_error=NULL/);
      expect(sent.params).toEqual(['2026-10-31T22:00:00.000Z', 'IR0001']);                 // now + 60 hours
      expect(res.body.round.assignment_deadline).toBe('2026-10-31T22:00:00.000Z');
      expect(fakeDb.one(/action_type='Assignment Not Sent'/).params).toEqual([APP_ID]);
      expect(fakeDb.find(SQL.feedbackLog).some(c => c.params.includes('Assignment Email Sent') && c.params.includes('Sent to candidate@example.test (cc: lead@example.test)'))).toBe(true);
    });

    it('without supporting documentation or cc the text has no such line and no cc is sent', async () => {
      programCreate();
      await create('hr_recruiter', ASSIGNMENT);
      const mail = h.sendAssignmentEmail.mock.calls[0][0];
      expect(mail.text).toBe('Please complete the attached task.\n\nAssignment Link: https://docs.example.test/task');
      expect(mail.cc).toBeUndefined();
    });

    it('a send that fails does not fail the round: 201, the round exists, the error is stored (cut to 500) and logged, and no send date is recorded', async () => {
      programCreate();
      h.sendAssignmentEmail.mockRejectedValue(new Error('Gmail quota ' + 'y'.repeat(600)));
      const res = await create('hr_recruiter', ASSIGNMENT);
      expect(res.status).toBe(201);
      expect(res.body.round.id).toBe('IR0001');
      expect(res.body.email).toEqual({ sent: false, error: 'Assignment round saved, but the email failed to send — you can retry from the round row.' });
      expect(String(fakeDb.one(/^UPDATE interview_rounds SET assignment_email_error=\$1, updated_at=NOW\(\) WHERE id=\$2$/).params[0])).toHaveLength(500);
      expect(fakeDb.find(/assignment_send_date=NOW\(\)/)).toEqual([]);
      expect(fakeDb.find(SQL.feedbackLog).some(c => c.params.includes('Assignment Email Failed'))).toBe(true);
      expect(fakeDb.tx.committed).toBe(1);
    });

    it('a candidate with no e-mail address gets nothing sent; the reason is stored and returned', async () => {
      programCreate({ ...CANDIDATE, candidate_email: null });
      const res = await create('hr_recruiter', ASSIGNMENT);
      expect(res.status).toBe(201);
      expect(h.sendAssignmentEmail).not.toHaveBeenCalled();
      expect(res.body.email).toEqual({ sent: false, error: 'Candidate has no email on file — cannot send assignment.' });
      expect(fakeDb.one(/^UPDATE interview_rounds SET assignment_email_error=\$1, updated_at=NOW\(\) WHERE id=\$2$/).params).toEqual(['Candidate has no email on file.', 'IR0001']);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('POST /:id/assignment-send (retry) and /:id/assignment-submit — HR-tier', () => {
  const RETRY = { mail_body_content: 'Please complete the task.', assignment_link: 'https://docs.example.test/task', cc: ['lead@example.test'], supporting_documentation: 'https://docs.example.test/extra' };
  const retry = (as: Actor, body: Record<string, unknown> = RETRY, id = 'IR0002') => api.post(`/api/interviews/${id}/assignment-send`, { as, body });
  const CANDIDATE_ROW = /^SELECT c\.full_name AS candidate_name, c\.email AS candidate_email, r\.title AS role_title FROM applications a/;
  const programRetry = (round: Record<string, unknown> | null = ASSIGNMENT_ROUND, candidate: Record<string, unknown> | null = { candidate_name: 'Candidate Example', candidate_email: 'candidate@example.test', role_title: 'Quality Assurance Engineer' }) => {
    fakeDb.whenOne(SQL.round, round);
    fakeDb.whenOne(CANDIDATE_ROW, candidate);
    fakeDb.whenOne(SQL.appIds, { candidate_id: 'C9001', role_id: 'R9001' });
  };

  it('both are 403 for a hiring_manager, before the database', async () => {
    programRetry();
    const a = await retry('hiring_manager');
    const b = await api.post('/api/interviews/IR0002/assignment-submit', { as: 'hiring_manager', body: { submission_link: 'https://x.example.test' } });
    expect([a.status, b.status]).toEqual([403, 403]);
    expect(fakeDb.untouched()).toBe(true);
    expect(h.sendAssignmentEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['no mail body', { ...RETRY, mail_body_content: '' }, 400], ['no link', { ...RETRY, assignment_link: '' }, 400],
    ['cc that is not a list', { ...RETRY, cc: 'a@example.test' }, 400], ['an invalid cc address', { ...RETRY, cc: ['nope'] }, 400],
  ])('%s → %i, nothing sent and nothing written', async (_what, body, code) => {
    programRetry();
    expect((await retry('hr_recruiter', body)).status).toBe(code);
    expect(h.sendAssignmentEmail).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('an unknown round is 404, a round that is not an Assignment round is 400, and neither sends anything', async () => {
    programRetry(null);
    expect((await retry('hr_recruiter')).status).toBe(404);
    fakeDb.reset(); programRetry({ ...ROUND, id: 'IR0003' });
    const res = await retry('hr_recruiter', RETRY, 'IR0003');
    expect([res.status, res.body.error]).toEqual([400, 'This round is not configured as an Assignment round']);
    expect(h.sendAssignmentEmail).not.toHaveBeenCalled();
  });

  it('stores the values of THIS attempt on the round (so a retry from the form overwrites what was last attempted), sends them, and answers with the round and the outcome', async () => {
    programRetry();
    const res = await retry('hr_recruiter');
    expect(res.status).toBe(200);
    expect(fakeDb.one(/^UPDATE interview_rounds SET assignment_mail_body=\$1, assignment_cc=\$2, assignment_link=\$3, assignment_supporting_docs=\$4, updated_at=NOW\(\) WHERE id=\$5$/).params)
      .toEqual(['Please complete the task.', ['lead@example.test'], 'https://docs.example.test/task', 'https://docs.example.test/extra', 'IR0002']);
    expect(h.sendAssignmentEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'candidate@example.test', cc: ['lead@example.test'] }));
    expect(res.body.email).toEqual({ sent: true });
    expect(res.body.round.id).toBe('IR0002');
  });

  it('a failed retry reports it the same way as the first attempt and keeps the round', async () => {
    programRetry();
    h.sendAssignmentEmail.mockRejectedValue(new Error('still failing'));
    const res = await retry('hr_recruiter');
    expect(res.status).toBe(200);
    expect(res.body.email.sent).toBe(false);
    expect(fakeDb.one(/^UPDATE interview_rounds SET assignment_email_error=\$1, updated_at=NOW\(\) WHERE id=\$2$/).params).toEqual(['still failing', 'IR0002']);
  });

  it('characterization: nothing stops a retry on a round whose e-mail already went out — the "only before it has been sent" rule lives in the UI, the API sends again', async () => {
    programRetry({ ...ASSIGNMENT_ROUND, assignment_send_date: '2026-10-28T10:00:00.000Z' });
    const res = await retry('hr_recruiter');
    expect(res.status).toBe(200);
    expect(h.sendAssignmentEmail).toHaveBeenCalledTimes(1);
  });

  it('assignment-submit: needs submission_link (400) and an existing round (404); then records it on the round and the application and logs it, in one transaction', async () => {
    programRetry();
    const post = (body: Record<string, unknown>, id = 'IR0002') => api.post(`/api/interviews/${id}/assignment-submit`, { as: 'hr_recruiter', body });
    expect((await post({})).status).toBe(400);
    fakeDb.reset(); programRetry(null);
    expect((await post({ submission_link: 'https://x.example.test' })).status).toBe(404);
    fakeDb.reset(); programRetry();
    const ok = await post({ submission_link: 'https://x.example.test/answer' });
    expect([ok.status, ok.body]).toEqual([200, { success: true }]);
    expect(fakeDb.one(/^UPDATE interview_rounds SET assignment_submission_date=NOW\(\), assignment_submission_link=\$1, updated_at=NOW\(\) WHERE id=\$2$/).params).toEqual(['https://x.example.test/answer', 'IR0002']);
    expect(fakeDb.one(/^UPDATE applications SET assignment_submission_link=\$1, last_updated=NOW\(\) WHERE id=\$2$/).params).toEqual(['https://x.example.test/answer', APP_ID]);
    expect(fakeDb.tx).toEqual({ started: 1, committed: 1, rolledBack: 0 });
  });
});
