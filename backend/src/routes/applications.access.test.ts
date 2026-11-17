import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// The governance rules of routes/applications.ts (CLAUDE.md "Application state model" and "Hiring Manager's real capability set"),
// exercised through the real router with the real authenticate / require* middleware and signed JWTs. Only the database, the
// ResumeIQ trigger and Gmail are replaced. Every refusal is asserted twice: the status code AND that nothing was written.

const h = vi.hoisted(() => ({ runResumeIQScoring: vi.fn(), sendAssignmentEmail: vi.fn() }));
vi.mock('../db/index.js', async () => (await import('../test/fakeDb.js')).dbModule());
vi.mock('../services/resumeIQTrigger.js', () => ({ runResumeIQScoring: h.runResumeIQScoring }));
vi.mock('../services/gmailService.js', () => ({ sendAssignmentEmail: h.sendAssignmentEmail }));

import applicationsRouter, { getSlaHours } from './applications.js';
import { STAGE_SLA_ACTION_TYPES, tieredStandardHours } from '../jobs/slaChecker.js';
import { OVER_BUDGET_TOLERANCE } from '../utils/budget.js';
import { SLA_HOURS, STAGE_ORDER } from '../types/index.js';
import { fakeDb } from '../test/fakeDb.js';
import { ApiClient, ALL_PERSONAS, TEST_JWT_SECRET, TEST_USERS, buildApp, setEnv, type Actor } from '../test/routeHarness.js';
import type { Persona } from '../types/index.js';

const api = new ApiClient(buildApp(app => app.use('/api/applications', applicationsRouter)));
let restoreEnv: () => void = () => undefined;

// ─── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────
const HR_TIER = ['hr_recruiter', 'leadership', 'super_admin'] as const;
const APP_ID = 'A9001';
const APP_ROW = {
  id: APP_ID, candidate_id: 'C9001', role_id: 'R9001', stage: 'Applied and Screened', status: 'Active',
  ai_fit_score: 60, score_avg: 6.1, recruiter_screening_status: 'Under Recruiter Review',
};
// What the final `SELECT a.*, r.hiring_manager_name …` returns: a row full of fields only HR-tier (or the role's own Hiring Manager) may see.
const UPDATED_ROW = {
  ...APP_ROW, hiring_manager_name: 'Somebody Else', last_updated: '2026-10-29T10:00:00Z',
  offer_ctc_fixed: 2200000, offer_ctc_variable: 100000, internal_risk_notes: 'will not stay', agency_fee_estimate: 300000,
  hr_comp_alignment: 'aligned', current_ctc_fixed: 1800000, expected_ctc: 2100000, ectc: 2100000,
};

const SQL = {
  app: /^SELECT \* FROM applications WHERE id ?= ?\$1$/,
  candidateCtc: /^SELECT expected_ctc FROM candidates WHERE id=\$1$/,
  roleBand: /^SELECT ctc_band FROM roles WHERE id=\$1$/,
  pendingRounds: /^SELECT round_name FROM interview_rounds WHERE application_id=\$1 AND feedback_status != 'Submitted'$/,
  refCount: /^SELECT count\(\*\) FROM ref_checks WHERE application_id=\$1$/,
  stageUpdate: /^UPDATE applications SET stage=\$1, stage_entry_time=NOW\(\)/,
  resolveStagePending: /^UPDATE pending_actions SET resolved=true, resolved_at=NOW\(\) WHERE application_id=\$1 AND resolved=false AND action_type = ANY\(\$2::text\[\]\)$/,
  activity: /^INSERT INTO activity_log/,
  roleForHmAction: /^SELECT title, hiring_manager_name FROM roles WHERE id = \$1$/,
  candidateName: /^SELECT full_name FROM candidates WHERE id ?= ?\$1$/,
  roleTitle: /^SELECT title FROM roles WHERE id ?= ?\$1$/,
  hmAction: /^INSERT INTO pending_actions \(owner_type, priority_level, action_type, description, application_id, candidate_name, role_title, hours_overdue, role_id, responsible_person\)/,
  updatedRow: /^SELECT a\.\*, r\.hiring_manager_name FROM applications a JOIN roles r ON r\.id = a\.role_id WHERE a\.id = \$1$/,
  statusUpdate: /^UPDATE applications SET status=\$1, rejection_reason_cat=\$2, rejection_reason_detail=\$3, withdrawal_reason_cat=\$4, withdrawal_reason_detail=\$5, last_updated=NOW\(\)/,
  resolveAllPending: /^UPDATE pending_actions SET resolved=true, resolved_at=NOW\(\) WHERE application_id=\$1 AND resolved=false$/,
  candidateEmail: /^SELECT email FROM candidates WHERE id=\$1$/,
  screeningUpdate: /^UPDATE applications SET recruiter_screening_status=\$1, last_updated=NOW\(\) WHERE id=\$2( AND recruiter_screening_status IS DISTINCT FROM \$1)?$/,
  screeningRole: /^SELECT hiring_manager_name FROM roles WHERE id = \$1$/,
  resolveHmReview: /^UPDATE pending_actions SET resolved=true, resolved_at=NOW\(\) WHERE application_id=\$1 AND action_type='HM shortlist review' AND resolved=false$/,
  scheduleInterview: /^INSERT INTO pending_actions \(owner_type, priority_level, action_type, description, application_id, candidate_name, role_title, hours_overdue\) VALUES \('HR \/ Recruiter'/,
  founderUpdate: /^UPDATE applications SET founder_review_flag=\$1, founder_review_note=\$2, founder_review_set_by=\$3, founder_review_set_at=NOW\(\), last_updated=NOW\(\) WHERE id=\$4$/,
  founderRaise: /^INSERT INTO pending_actions \(owner_type, priority_level, action_type, description, application_id, candidate_name, role_title, hours_overdue\) VALUES \('Leadership \/ Founders'/,
  founderClear: /^UPDATE pending_actions SET resolved=true, resolved_at=NOW\(\) WHERE application_id=\$1 AND action_type='Founder Review' AND resolved=false$/,
};

interface Scenario {
  app?: Record<string, unknown> | null;
  expectedCtc?: number | null;
  ctcBand?: string | null;
  pendingRounds?: string[];
  refChecks?: string | null;
  updated?: Record<string, unknown>;
  candidateEmail?: string | null;
  roleHm?: string | null;
  screeningUnchanged?: boolean;
}
/** Program the statements the routes read. A field left out means "nothing there" (no band, no pending feedback, no reference check). */
function program(s: Scenario = {}) {
  fakeDb.whenOne(SQL.app, s.app === undefined ? APP_ROW : s.app === null ? null : { ...APP_ROW, ...s.app });
  fakeDb.whenOne(SQL.candidateCtc, { expected_ctc: s.expectedCtc ?? null });
  fakeDb.whenOne(SQL.roleBand, { ctc_band: s.ctcBand ?? null });
  fakeDb.when(SQL.pendingRounds, (s.pendingRounds ?? []).map(round_name => ({ round_name })));
  fakeDb.whenOne(SQL.refCount, s.refChecks === undefined ? null : { count: s.refChecks });
  fakeDb.whenOne(SQL.roleForHmAction, { title: 'Quality Assurance Engineer', hiring_manager_name: 'Test Hiring Manager' });
  fakeDb.whenOne(SQL.candidateName, { full_name: 'Candidate Example' });
  fakeDb.whenOne(SQL.roleTitle, { title: 'Quality Assurance Engineer' });
  fakeDb.whenOne(SQL.updatedRow, { ...UPDATED_ROW, ...(s.updated ?? {}) });
  fakeDb.whenOne(SQL.screeningRole, { hiring_manager_name: s.roleHm === undefined ? 'Test Hiring Manager' : s.roleHm });
  // The screening UPDATE answers one row (it changed) unless a scenario says the stored status already equals the new one.
  fakeDb.when(SQL.screeningUpdate, s.screeningUnchanged ? [] : [{ id: APP_ID }]);
  fakeDb.whenOne(SQL.candidateEmail, s.candidateEmail === undefined ? { email: 'candidate@example.test' } : { email: s.candidateEmail });
}

const stage = (as: Actor, body: Record<string, unknown>) => api.post(`/api/applications/${APP_ID}/stage`, { as, body });
const status = (as: Actor, body: Record<string, unknown>) => api.post(`/api/applications/${APP_ID}/status`, { as, body });
const screening = (as: Actor, body: Record<string, unknown>) => api.post(`/api/applications/${APP_ID}/screening`, { as, body });
const nothingWritten = () => { expect(fakeDb.writes()).toEqual([]); expect(fakeDb.tx.started).toBe(0); };

beforeAll(async () => { await api.start(); });
afterAll(async () => { await api.stop(); });
beforeEach(() => {
  fakeDb.reset();
  h.runResumeIQScoring.mockReset().mockResolvedValue({ scored: true });
  h.sendAssignmentEmail.mockReset().mockResolvedValue(undefined);
  restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { restoreEnv(); vi.restoreAllMocks(); });

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('POST /:id/stage — who may move an application where', () => {
  it('rejects a request with no new_stage (400) and an unknown application (404), for every persona, before anything is written', async () => {
    program();
    for (const persona of ALL_PERSONAS) {
      expect([persona, (await stage(persona, {})).status]).toEqual([persona, 400]);
    }
    program({ app: null });
    for (const persona of ALL_PERSONAS) {
      expect([persona, (await stage(persona, { new_stage: 'Interview Round 1' })).status]).toEqual([persona, 404]);
    }
    nothingWritten();
  });

  describe('shortlisting — Applied and Screened → Interview Round 1 — is open to EVERY persona', () => {
    it.each(ALL_PERSONAS)('%s may shortlist: 200, the stage is written, and the move is attributed to them', async persona => {
      program();
      const res = await stage(persona, { new_stage: 'Interview Round 1' });
      expect(res.status).toBe(200);
      const update = fakeDb.one(SQL.stageUpdate);
      expect(update.params.slice(0, 3)).toEqual(['Interview Round 1', SLA_HOURS.INTERVIEW_FEEDBACK, APP_ID]);
      const log = fakeDb.one(SQL.activity);
      expect(log.params).toEqual([APP_ID, 'C9001', 'R9001', 'Stage Changed', 'Stage → Interview Round 1', 'Applied and Screened', 'Interview Round 1', TEST_USERS[persona].userId, TEST_USERS[persona].name]);
      expect(fakeDb.tx).toEqual({ started: 1, committed: 1, rolledBack: 0 });
    });

    it('raises the Hiring Manager\'s "HM shortlist review" action, naming the role\'s Hiring Manager field as the responsible person', async () => {
      program();
      await stage('hiring_manager', { new_stage: 'Interview Round 1' });
      const action = fakeDb.one(SQL.hmAction);
      expect(action.params).toEqual([
        'Review Candidate Example for Quality Assurance Engineer — HM shortlist decision needed',
        APP_ID, 'Candidate Example', 'Quality Assurance Engineer', 'R9001', 'Test Hiring Manager',
      ]);
      expect(action.sql).toContain("'Hiring Manager', 'High', 'HM shortlist review'");
    });

    it('and only that move raises it: an HR move from Interview Round 1 to Round 2 raises nothing', async () => {
      program({ app: { stage: 'Interview Round 1' } });
      await stage('hr_recruiter', { new_stage: 'Interview Round 2' });
      expect(fakeDb.find(SQL.hmAction)).toEqual([]);
    });
  });

  describe('every other transition is HR-tier only', () => {
    const FORBIDDEN_FOR_HIRING_MANAGER: Array<[string, string]> = [
      ['Applied and Screened', 'Interview Round 2'],
      ['Applied and Screened', 'Assignment Round'],
      ['Applied and Screened', 'Offer Released'],
      ['Applied and Screened', 'Joined'],
      ['Applied and Screened', 'Applied and Screened'],
      ['Interview Round 1', 'Interview Round 2'],
      ['Interview Round 1', 'Interview Round 1'],
      ['Interview Round 1', 'Applied and Screened'],
      ['Interview Round 2', 'Interview Round 1'],
      ['Founders Round', 'Reference Check'],
      ['Offer Discussion', 'Offer Released'],
      ['Offer Accepted', 'Joined'],
    ];

    it.each(FORBIDDEN_FOR_HIRING_MANAGER)('hiring_manager %s → %s is 403 "HR access required", and nothing is written', async (from, to) => {
      program({ app: { stage: from } });
      const res = await stage('hiring_manager', { new_stage: to });
      expect([res.status, res.body]).toEqual([403, { error: 'HR access required' }]);
      nothingWritten();
      expect(h.runResumeIQScoring).not.toHaveBeenCalled();
    });

    it('the one carve-out is exactly (Applied and Screened → Interview Round 1): no other pair of stages in STAGE_ORDER lets a hiring_manager through', async () => {
      const allowed: string[] = [];
      for (const from of STAGE_ORDER) {
        for (const to of STAGE_ORDER) {
          fakeDb.reset();
          program({ app: { stage: from } });
          const res = await stage('hiring_manager', { new_stage: to });
          if (res.status !== 403) allowed.push(`${from} → ${to} (${res.status})`);
        }
      }
      expect(allowed).toEqual(['Applied and Screened → Interview Round 1 (200)']);
    });

    it.each(HR_TIER)('%s may make any of them: 200, each written with the stage asked for', async persona => {
      for (const [from, to] of FORBIDDEN_FOR_HIRING_MANAGER) {
        fakeDb.reset();
        program({ app: { stage: from }, refChecks: '1' });
        const res = await stage(persona, { new_stage: to });
        expect([persona, from, to, res.status]).toEqual([persona, from, to, 200]);
        expect(fakeDb.one(SQL.stageUpdate).params[0]).toBe(to);
      }
    });

    it('a leftover persona such as the retired "interviewer" is treated like a hiring_manager: shortlist only', async () => {
      program({ app: { stage: 'Interview Round 1' } });
      const odd = { ...TEST_USERS.hiring_manager, persona: 'interviewer' as unknown as Persona };
      expect((await stage(odd, { new_stage: 'Interview Round 2' })).status).toBe(403);
      fakeDb.reset(); program();
      expect((await stage(odd, { new_stage: 'Interview Round 1' })).status).toBe(200);
    });
  });

  it('new_stage must be one of STAGE_ORDER: a retired or made-up name, or a non-string, is a 400 and nothing is written (the column is plain TEXT, so nothing else would stop it)', async () => {
    for (const new_stage of ['Interview – Round 3', 'Screening', 'Resume Review', 'Shortlisted', 'applied and screened', 42, ['Joined'], {}]) {
      fakeDb.reset(); program();
      const res = await stage('hr_recruiter', { new_stage });
      expect([JSON.stringify(new_stage), res.status, res.body.error]).toEqual([JSON.stringify(new_stage), 400, 'Unknown stage']);
      expect(fakeDb.writes()).toEqual([]);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('POST /:id/stage — the over-budget gate (15% over the role\'s band needs a reason before Interview Round 1)', () => {
  const BAND = '18-24 LPA';               // ceiling 24 → the gate opens at 24 × 1.15
  const over = 24 * OVER_BUDGET_TOLERANCE + 1;
  const under = 24 * OVER_BUDGET_TOLERANCE - 1;

  it.each(['hr_recruiter', 'hiring_manager'] as const)('%s: an over-budget shortlist without a reason is 400 and nothing is written', async persona => {
    program({ expectedCtc: over, ctcBand: BAND });
    const res = await stage(persona, { new_stage: 'Interview Round 1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/15%\+ over the role's band/);
    nothingWritten();
  });

  it.each(['hr_recruiter', 'hiring_manager'] as const)('%s: with budget_exception_reason_cat it goes through, the reason is stored and named in the activity log', async persona => {
    program({ expectedCtc: over, ctcBand: BAND });
    const res = await stage(persona, { new_stage: 'Interview Round 1', budget_exception_reason_cat: 'Rare skill set', budget_exception_reason_detail: 'Only one in the market' });
    expect(res.status).toBe(200);
    expect(fakeDb.one(SQL.stageUpdate).params).toEqual(['Interview Round 1', SLA_HOURS.INTERVIEW_FEEDBACK, APP_ID, 'Rare skill set', 'Only one in the market']);
    expect(fakeDb.one(SQL.activity).params[4]).toBe('Stage → Interview Round 1 (over-budget exception: Rare skill set)');
  });

  it('just under the threshold needs no reason; with no band, or no expected CTC, the gate cannot be evaluated and does not fire', async () => {
    for (const s of [{ expectedCtc: under, ctcBand: BAND }, { expectedCtc: over, ctcBand: null }, { expectedCtc: null, ctcBand: BAND }, { expectedCtc: over, ctcBand: 'negotiable' }]) {
      fakeDb.reset();
      program(s);
      expect([JSON.stringify(s), (await stage('hr_recruiter', { new_stage: 'Interview Round 1' })).status]).toEqual([JSON.stringify(s), 200]);
    }
  });

  it('applies only to Interview Round 1: an over-budget candidate moves to Round 2 or an offer with no reason', async () => {
    for (const to of ['Interview Round 2', 'Assignment Round', 'Offer Released']) {
      fakeDb.reset();
      program({ app: { stage: 'Interview Round 1' }, expectedCtc: over, ctcBand: BAND, refChecks: '1' });
      expect([to, (await stage('hr_recruiter', { new_stage: to })).status]).toEqual([to, 200]);
    }
  });

  it('is asked BEFORE the persona check: a hiring_manager aiming for Round 1 from another stage is told 400 (reason needed) when over budget, and only then 403', async () => {
    program({ app: { stage: 'Interview Round 2' }, expectedCtc: over, ctcBand: BAND });
    expect((await stage('hiring_manager', { new_stage: 'Interview Round 1' })).status).toBe(400);
    fakeDb.reset();
    program({ app: { stage: 'Interview Round 2' }, expectedCtc: over, ctcBand: BAND });
    expect((await stage('hiring_manager', { new_stage: 'Interview Round 1', budget_exception_reason_cat: 'x' })).status).toBe(403);
    nothingWritten();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('POST /:id/stage — feedback and reference-check gates', () => {
  it('pending interview feedback blocks the move (400, rounds named) and writes nothing', async () => {
    program({ app: { stage: 'Interview Round 1' }, pendingRounds: ['Round 1', 'Technical screen'] });
    const res = await stage('hr_recruiter', { new_stage: 'Interview Round 2' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Feedback is still pending for: Round 1, Technical screen. Submit feedback for these rounds before advancing this candidate.');
    nothingWritten();
  });

  it('skip_reason is the deliberate escape hatch: the check is not even run, the move is written, and the activity says it was skipped and why', async () => {
    program({ app: { stage: 'Interview Round 1' }, pendingRounds: ['Round 1'] });
    const res = await stage('hr_recruiter', { new_stage: 'Interview Round 2', skip_reason: 'Interviewer unavailable' });
    expect(res.status).toBe(200);
    expect(fakeDb.find(SQL.pendingRounds)).toEqual([]);
    expect(fakeDb.one(SQL.activity).params[4]).toBe('Stage skipped to Interview Round 2. Reason: Interviewer unavailable');
  });

  it('is asked after the persona check: a hiring_manager moving past a round with pending feedback is 403, not 400', async () => {
    program({ app: { stage: 'Interview Round 1' }, pendingRounds: ['Round 1'] });
    expect((await stage('hiring_manager', { new_stage: 'Interview Round 2' })).status).toBe(403);
  });

  it('leaving Reference Check needs at least one reference check on file: none (count "0", or no row) is 400, one is fine', async () => {
    for (const refChecks of ['0', undefined]) {
      fakeDb.reset();
      program({ app: { stage: 'Reference Check' }, refChecks });
      const res = await stage('hr_recruiter', { new_stage: 'Pre-Joining Documents' });
      expect([refChecks, res.status, res.body.error]).toEqual([refChecks, 400, 'Add at least one reference check before advancing this candidate.']);
      nothingWritten();
    }
    fakeDb.reset();
    program({ app: { stage: 'Reference Check' }, refChecks: '3' });
    expect((await stage('hr_recruiter', { new_stage: 'Pre-Joining Documents' })).status).toBe(200);
  });

  it('the reference-check rule is bypassed by skip_reason, and does not apply to staying in the stage or to any other stage', async () => {
    program({ app: { stage: 'Reference Check' }, refChecks: '0' });
    expect((await stage('hr_recruiter', { new_stage: 'Pre-Joining Documents', skip_reason: 'Verified by phone' })).status).toBe(200);
    expect(fakeDb.find(SQL.refCount)).toEqual([]);
    fakeDb.reset(); program({ app: { stage: 'Reference Check' }, refChecks: '0' });
    expect((await stage('hr_recruiter', { new_stage: 'Reference Check' })).status).toBe(200);
    expect(fakeDb.find(SQL.refCount)).toEqual([]);
    fakeDb.reset(); program({ app: { stage: 'Founders Round' }, refChecks: '0' });
    expect((await stage('hr_recruiter', { new_stage: 'Reference Check' })).status).toBe(200);
    expect(fakeDb.find(SQL.refCount)).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('POST /:id/stage — what a move writes', () => {
  it('stamps the offer dates only where they belong: Offer Released → offer_sent_date, Offer Accepted → offer_accepted_date, Joined → status and a non-overwriting offer_accepted_date', async () => {
    const sqlFor = async (from: string, to: string) => {
      fakeDb.reset(); program({ app: { stage: from }, refChecks: '1' });
      await stage('hr_recruiter', { new_stage: to });
      return fakeDb.one(SQL.stageUpdate).sql;
    };
    const released = await sqlFor('Offer Discussion', 'Offer Released');
    expect(released).toContain('offer_sent_date=NOW()');
    expect(released).not.toMatch(/offer_accepted_date|status='Joined'/);
    const accepted = await sqlFor('Offer Released', 'Offer Accepted');
    expect(accepted).toContain('offer_accepted_date=NOW()');
    expect(accepted).not.toMatch(/offer_sent_date|status='Joined'/);
    const joined = await sqlFor('Offer Accepted', 'Joined');
    expect(joined).toContain('offer_accepted_date=COALESCE(offer_accepted_date, NOW())');
    expect(joined).toContain(`status='Joined'`);
    const plain = await sqlFor('Interview Round 1', 'Interview Round 2');
    expect(plain).not.toMatch(/offer_sent_date|offer_accepted_date|status='Joined'/);
  });

  it('starts the 5-day joining-risk clock on the move INTO Offer Accepted only: last_hr_contact = GREATEST(existing, today), never overwriting a more recent contact', async () => {
    const sqlFor = async (from: string, to: string) => {
      fakeDb.reset(); program({ app: { stage: from }, refChecks: '1' });
      await stage('hr_recruiter', { new_stage: to });
      return fakeDb.one(SQL.stageUpdate).sql;
    };
    expect(await sqlFor('Offer Released', 'Offer Accepted')).toContain('last_hr_contact=GREATEST(last_hr_contact, CURRENT_DATE)');
    // reaching Offer Accepted again restarts the clock AND clears the flag raised for the previous acceptance (found in review)
    expect(await sqlFor('Offer Released', 'Offer Accepted')).toContain('joining_risk_auto_flag=false');
    for (const to of ['Offer Released', 'Joined', 'Interview Round 2']) {
      expect(await sqlFor('Offer Discussion', to)).not.toContain('joining_risk_auto_flag');
    }
    for (const to of ['Offer Released', 'Joined', 'Interview Round 2']) {
      expect(await sqlFor('Offer Discussion', to)).not.toContain('last_hr_contact');
    }
  });

  it('resets the SLA clock: stage_entry_time=NOW(), sla_breach=false, sla_hours from getSlaHours(new stage, fit score)', async () => {
    program({ app: { stage: 'Interview Round 1', ai_fit_score: 90 } });
    await stage('hr_recruiter', { new_stage: 'Assignment Round' });
    const u = fakeDb.one(SQL.stageUpdate);
    expect(u.sql).toContain('stage_entry_time=NOW()');
    expect(u.sql).toContain('sla_breach=false');
    expect(u.params[1]).toBe(getSlaHours('Assignment Round', 90));
    expect(u.params[1]).toBe(24);                 // Assignment Round is score-tiered: fit 90 stores the 24h window, as the engine breaches
  });

  it('resolves the stage-keyed pending actions of the OLD stage — all stage SLA types plus "HM shortlist review" — in the same transaction', async () => {
    program({ app: { stage: 'Interview Round 1' } });
    await stage('hr_recruiter', { new_stage: 'Interview Round 2' });
    const resolve = fakeDb.one(SQL.resolveStagePending);
    expect(resolve.inTransaction).toBe(true);
    expect(resolve.params[0]).toBe(APP_ID);
    expect(resolve.params[1]).toEqual([...STAGE_SLA_ACTION_TYPES, 'HM shortlist review']);
    expect(fakeDb.one(SQL.stageUpdate).inTransaction).toBe(true);
    expect(fakeDb.one(SQL.activity).inTransaction).toBe(true);
  });

  it('a failure inside the transaction rolls it back and is a 500: the caller is never told it worked', async () => {
    program();
    fakeDb.failing(SQL.activity, 'activity_log insert failed');
    const res = await stage('hr_recruiter', { new_stage: 'Interview Round 1' });
    expect(res.status).toBe(500);
    expect(fakeDb.tx).toEqual({ started: 1, committed: 0, rolledBack: 1 });
    expect(fakeDb.find(SQL.hmAction)).toEqual([]);          // nothing that follows the commit ran
  });

  it('the safety-net scoring runs only for an application with no score yet, and its result is returned', async () => {
    program({ app: { score_avg: null } });
    h.runResumeIQScoring.mockResolvedValue({ scored: false, error: 'no key' });
    const res = await stage('hr_recruiter', { new_stage: 'Interview Round 1' });
    expect(h.runResumeIQScoring).toHaveBeenCalledWith(APP_ID);
    expect(res.body.resumeiq).toEqual({ scored: false, error: 'no key' });

    fakeDb.reset(); h.runResumeIQScoring.mockClear(); program({ app: { score_avg: 7.2 } });
    const scored = await stage('hr_recruiter', { new_stage: 'Interview Round 1' });
    expect(h.runResumeIQScoring).not.toHaveBeenCalled();
    expect(scored.body.resumeiq).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('POST /:id/stage — the response never carries compensation to someone who may not see it', () => {
  const COMP = ['offer_ctc_fixed', 'offer_ctc_variable', 'internal_risk_notes', 'agency_fee_estimate', 'hr_comp_alignment', 'current_ctc_fixed', 'expected_ctc', 'ectc'];

  it('a hiring_manager who is not named on the role gets the application without any restricted field (the shortlist carve-out used to leak them)', async () => {
    program({ updated: { hiring_manager_name: 'Somebody Else' } });
    const { body } = await stage('hiring_manager', { new_stage: 'Interview Round 1' });
    for (const f of COMP) expect(body.application, f).not.toHaveProperty(f);
    expect(body.application.id).toBe(APP_ID);
    expect(body.application.stage).toBe('Applied and Screened');           // the row as the database returned it
  });

  it('HR-tier sees everything', async () => {
    for (const persona of HR_TIER) {
      fakeDb.reset(); program();
      const { body } = await stage(persona, { new_stage: 'Interview Round 1' });
      for (const f of COMP) expect([persona, f, body.application[f]]).toEqual([persona, f, (UPDATED_ROW as Record<string, unknown>)[f]]);
    }
  });

  it('the role\'s own Hiring Manager (named in the field, one of several) sees it too', async () => {
    program({ updated: { hiring_manager_name: 'Another Person, test hiring manager' } });
    const { body } = await stage('hiring_manager', { new_stage: 'Interview Round 1' });
    expect(body.application.offer_ctc_fixed).toBe(2200000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('POST /:id/status — Reject / Withdraw / Hold', () => {
  it('needs new_status (400) and an existing application (404), before anything is written', async () => {
    program();
    expect((await status('hr_recruiter', {})).status).toBe(400);
    fakeDb.reset(); program({ app: null });
    expect((await status('hr_recruiter', { new_status: 'Hold for Future' })).status).toBe(404);
    nothingWritten();
  });

  describe('who may set what', () => {
    it.each(['Hold for Future', 'Rejected'])('a hiring_manager may set "%s" from Applied and Screened', async newStatus => {
      program();
      const res = await status('hiring_manager', { new_status: newStatus, rejection_reason_cat: 'Skills gap' });
      expect(res.status).toBe(200);
      expect(fakeDb.one(SQL.statusUpdate).params[0]).toBe(newStatus);
    });

    it.each([
      ['Applied and Screened', 'Withdrawn'], ['Applied and Screened', 'Active'], ['Applied and Screened', 'Joined'], ['Applied and Screened', 'Closed'],
      ['Applied and Screened', 'On Hold'], ['Applied and Screened', 'rejected'],
      ['Interview Round 1', 'Hold for Future'], ['Interview Round 1', 'Rejected'], ['Founders Round', 'Rejected'], ['Offer Released', 'Hold for Future'],
    ])('a hiring_manager at "%s" setting "%s" is 403 "HR access required", nothing written', async (from, newStatus) => {
      program({ app: { stage: from } });
      const res = await status('hiring_manager', { new_status: newStatus, rejection_reason_cat: 'x', withdrawal_reason_cat: 'x' });
      expect([res.status, res.body]).toEqual([403, { error: 'HR access required' }]);
      nothingWritten();
    });

    it.each(HR_TIER)('%s may set any status from any stage', async persona => {
      for (const [from, newStatus] of [['Interview Round 1', 'Rejected'], ['Offer Released', 'Withdrawn'], ['Founders Round', 'Hold for Future'], ['Joined', 'Active'], ['Interview Round 2', 'Closed']]) {
        fakeDb.reset(); program({ app: { stage: from } });
        const res = await status(persona, { new_status: newStatus, rejection_reason_cat: 'r', withdrawal_reason_cat: 'w' });
        expect([persona, from, newStatus, res.status]).toEqual([persona, from, newStatus, 200]);
      }
    });
  });

  describe('a reason is required to reject or withdraw (hard 400)', () => {
    const REJECT_MSG = 'A rejection reason is required when rejecting a candidate (rejection_reason_cats or rejection_reason_cat)';
    const WITHDRAW_MSG = 'A withdrawal reason is required when withdrawing a candidate (withdrawal_reason_cat)';
    it.each(['Rejected', 'Withdrawn'])('%s with no reason of any kind is 400, nothing written, and the same for a blank or non-text reason', async newStatus => {
      for (const body of [{}, { rejection_reason_cat: '' }, { rejection_reason_cat: '   ' }, { rejection_reason_cats: [] }, { rejection_reason_cats: ['', '  ', 3, null] }, { rejection_reason_cat: 42 }, { withdrawal_reason_cat: '' }]) {
        fakeDb.reset(); program();
        const res = await status('hr_recruiter', { new_status: newStatus, ...body });
        expect([newStatus, JSON.stringify(body), res.status, res.body.error]).toEqual([newStatus, JSON.stringify(body), 400, newStatus === 'Rejected' ? REJECT_MSG : WITHDRAW_MSG]);
        nothingWritten();
      }
    });

    it('the requirement does not apply to the other statuses (Hold for Future, Active, Closed need none)', async () => {
      for (const s of ['Hold for Future', 'Active', 'Closed']) {
        fakeDb.reset(); program();
        expect([s, (await status('hr_recruiter', { new_status: s })).status]).toEqual([s, 200]);
      }
    });

    it('a single legacy reason (rejection_reason_cat) is stored as given, trimmed', async () => {
      program();
      await status('hr_recruiter', { new_status: 'Rejected', rejection_reason_cat: '  Salary expectations too high ', rejection_reason_detail: 'Asked 40% over' });
      expect(fakeDb.one(SQL.statusUpdate).params).toEqual(['Rejected', 'Salary expectations too high', 'Asked 40% over', null, null, APP_ID]);
    });

    it('several reasons (rejection_reason_cats) are stored in the one column joined with "; ", in order, de-duplicated without regard to case, with blanks dropped and any ";" inside a reason turned into ","', async () => {
      program();
      await status('hr_recruiter', { new_status: 'Rejected', rejection_reason_cats: ['Skills gap', ' skills GAP ', '', 'Notice period; too long', 'Culture fit'] });
      expect(fakeDb.one(SQL.statusUpdate).params[1]).toBe('Skills gap; Notice period, too long; Culture fit');
    });

    it('the array wins over the single string when it has anything in it; an empty or all-blank array falls back to the string', async () => {
      program();
      await status('hr_recruiter', { new_status: 'Rejected', rejection_reason_cats: ['A', 'B'], rejection_reason_cat: 'Legacy' });
      expect(fakeDb.one(SQL.statusUpdate).params[1]).toBe('A; B');
      fakeDb.reset(); program();
      await status('hr_recruiter', { new_status: 'Rejected', rejection_reason_cats: [' ', ''], rejection_reason_cat: 'Legacy' });
      expect(fakeDb.one(SQL.statusUpdate).params[1]).toBe('Legacy');
    });

    it('at most 12 reasons, 200 characters each, are kept', async () => {
      program();
      const many = Array.from({ length: 20 }, (_, i) => `Reason ${i + 1}`);
      await status('hr_recruiter', { new_status: 'Rejected', rejection_reason_cats: [...many.slice(0, 11), 'x'.repeat(500)] });
      const stored = String(fakeDb.one(SQL.statusUpdate).params[1]).split('; ');
      expect(stored).toHaveLength(12);
      expect(stored[11]).toHaveLength(200);
      fakeDb.reset(); program();
      await status('hr_recruiter', { new_status: 'Rejected', rejection_reason_cats: many });
      expect(String(fakeDb.one(SQL.statusUpdate).params[1]).split('; ')).toHaveLength(12);
    });

    it('a withdrawal stores its reason in the withdrawal columns and leaves the rejection columns null', async () => {
      program();
      await status('hr_recruiter', { new_status: 'Withdrawn', withdrawal_reason_cat: 'Accepted another offer', withdrawal_reason_detail: 'Counter-offer' });
      expect(fakeDb.one(SQL.statusUpdate).params).toEqual(['Withdrawn', null, null, 'Accepted another offer', 'Counter-offer', APP_ID]);
    });

    it('the activity log line names the status and the joined reasons', async () => {
      program();
      await status('hr_recruiter', { new_status: 'Rejected', rejection_reason_cats: ['A', 'B'] });
      expect(fakeDb.one(SQL.activity).params).toEqual([APP_ID, 'C9001', 'R9001', 'Status Changed', 'Status → Rejected (A; B)', 'Active', 'Rejected', 'U9001', 'Test Recruiter']);
    });
  });

  describe('each status needs its OWN kind of reason (400 before any write)', () => {
    const noWrite = () => expect(fakeDb.statements().join('\n')).not.toMatch(/UPDATE applications SET status/);

    it('Rejected with only a withdrawal reason is a 400 naming the rejection reason; nothing is written', async () => {
      program();
      const res = await status('hr_recruiter', { new_status: 'Rejected', withdrawal_reason_cat: 'Accepted another offer' });
      expect([res.status, res.body.error]).toEqual([400, 'A rejection reason is required when rejecting a candidate (rejection_reason_cats or rejection_reason_cat)']);
      noWrite();
    });

    it('Withdrawn with only rejection reasons (array or string) is a 400 naming the withdrawal reason; nothing is written', async () => {
      for (const body of [{ rejection_reason_cats: ['Skills gap'] }, { rejection_reason_cat: 'Skills gap' }]) {
        fakeDb.reset(); program();
        const res = await status('hr_recruiter', { new_status: 'Withdrawn', ...body });
        expect([res.status, res.body.error]).toEqual([400, 'A withdrawal reason is required when withdrawing a candidate (withdrawal_reason_cat)']);
        noWrite();
      }
    });

    it('a blank withdrawal_reason_cat (empty, whitespace, non-string) is a 400', async () => {
      for (const v of ['', '   ', '\t\n', 7, null, {}, ['x']]) {
        fakeDb.reset(); program();
        expect([String(v), (await status('hr_recruiter', { new_status: 'Withdrawn', withdrawal_reason_cat: v })).status]).toEqual([String(v), 400]);
        noWrite();
      }
    });

    it('a Rejected with only blank rejection reasons is a 400 even with a withdrawal reason', async () => {
      program();
      expect((await status('hr_recruiter', { new_status: 'Rejected', rejection_reason_cats: [' ', ''], withdrawal_reason_cat: 'Personal reasons' })).status).toBe(400);
      noWrite();
    });

    it('the withdrawal reason is stored trimmed', async () => {
      program();
      expect((await status('hr_recruiter', { new_status: 'Withdrawn', withdrawal_reason_cat: '  Personal reasons ' })).status).toBe(200);
      expect(fakeDb.one(SQL.statusUpdate).params).toEqual(['Withdrawn', null, null, 'Personal reasons', null, APP_ID]);
    });

    it('a Hiring Manager rejecting from Applied and Screened still needs a rejection reason', async () => {
      program();
      const res = await status('hiring_manager', { new_status: 'Rejected', withdrawal_reason_cat: 'Personal reasons' });
      expect(res.status).toBe(400);
      noWrite();
    });
  });

  describe('side effects of a status change', () => {
    it('anything other than Active clears joining_risk_auto_flag; setting Active does not', async () => {
      for (const s of ['Rejected', 'Withdrawn', 'Hold for Future', 'Closed', 'Joined']) {
        fakeDb.reset(); program();
        await status('hr_recruiter', { new_status: s, rejection_reason_cat: 'r', withdrawal_reason_cat: 'w' });
        expect([s, fakeDb.one(SQL.statusUpdate).sql.includes('joining_risk_auto_flag = false')]).toEqual([s, true]);
      }
      fakeDb.reset(); program({ app: { status: 'Hold for Future' } });
      await status('hr_recruiter', { new_status: 'Active' });
      expect(fakeDb.one(SQL.statusUpdate).sql).not.toContain('joining_risk_auto_flag');
    });

    it('resolves every open pending action of the application, inside the same transaction as the status write', async () => {
      program();
      await status('hr_recruiter', { new_status: 'Hold for Future' });
      const r = fakeDb.one(SQL.resolveAllPending);
      expect([r.params, r.inTransaction, fakeDb.one(SQL.statusUpdate).inTransaction]).toEqual([[APP_ID], true, true]);
      expect(fakeDb.tx).toEqual({ started: 1, committed: 1, rolledBack: 0 });
    });
  });

  describe('the rejection e-mail', () => {
    const reject = (extra: Record<string, unknown> = {}, as: Actor = 'hr_recruiter', newStatus = 'Rejected') =>
      status(as, { new_status: newStatus, rejection_reason_cat: 'Skills gap', send_rejection_email: true, rejection_email_subject: 'Your application', rejection_email_body: 'Thank you for applying.', ...extra });

    it('is only valid together with Rejected: any other status is 400, before anything is written', async () => {
      for (const s of ['Withdrawn', 'Hold for Future', 'Active']) {
        fakeDb.reset(); program();
        const res = await reject({ withdrawal_reason_cat: 'x' }, 'hr_recruiter', s);
        expect([s, res.status, res.body.error]).toEqual([s, 400, 'send_rejection_email is only valid when new_status is Rejected']);
        nothingWritten();
      }
      expect(h.sendAssignmentEmail).not.toHaveBeenCalled();
    });

    it.each([['no subject', { rejection_email_subject: '' }], ['no body', { rejection_email_body: '' }], ['neither', { rejection_email_subject: undefined, rejection_email_body: undefined }]])('needs a subject and a body (%s → 400), before anything is written', async (_name, extra) => {
      program();
      const res = await reject(extra);
      expect([res.status, res.body.error]).toEqual([400, 'rejection_email_subject and rejection_email_body are required to send a rejection email']);
      nothingWritten();
    });

    it('sends exactly what the client composed, to the candidate\'s address, AFTER the status change has committed; records the send and answers { sent: true }', async () => {
      program({ candidateEmail: 'candidate@example.test' });
      const res = await reject();
      expect(res.status).toBe(200);
      expect(h.sendAssignmentEmail).toHaveBeenCalledTimes(1);
      expect(h.sendAssignmentEmail).toHaveBeenCalledWith({ to: 'candidate@example.test', subject: 'Your application', text: 'Thank you for applying.' });
      expect(res.body).toEqual({ success: true, new_status: 'Rejected', email: { sent: true } });
      expect(fakeDb.tx.committed).toBe(1);
      expect(fakeDb.statements().findIndex(s => SQL.statusUpdate.test(s))).toBeLessThan(fakeDb.statements().findIndex(s => /rejection_email_sent_at=NOW\(\)/.test(s)));
      expect(fakeDb.one(/rejection_email_sent_at=NOW\(\), rejection_email_error=NULL WHERE id=\$1/).params).toEqual([APP_ID]);
      const log = fakeDb.find(SQL.activity).filter(c => c.params.includes('Rejection Email Sent'));
      expect(log).toHaveLength(1);
      expect(log[0].params[4]).toBe('Sent to candidate@example.test');
    });

    it('a failed send does not undo the rejection: 200 with { sent: false }, the error stored (cut to 500 characters) and logged', async () => {
      program();
      h.sendAssignmentEmail.mockRejectedValue(new Error('Gmail said no: ' + 'x'.repeat(600)));
      const res = await reject();
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.email.sent).toBe(false);
      expect(res.body.email.error).toMatch(/Candidate rejected, but the email failed to send/);
      expect(fakeDb.tx.committed).toBe(1);
      const stored = fakeDb.one(/^UPDATE applications SET rejection_email_error=\$1 WHERE id=\$2$/);
      expect(String(stored.params[0])).toHaveLength(500);
      expect(fakeDb.find(SQL.activity).some(c => c.params.includes('Rejection Email Failed'))).toBe(true);
      expect(fakeDb.find(/rejection_email_sent_at/)).toEqual([]);
    });

    it('a candidate with no e-mail on file is not sent anything: { sent: false }, and the reason is stored', async () => {
      program({ candidateEmail: null });
      const res = await reject();
      expect(res.status).toBe(200);
      expect(h.sendAssignmentEmail).not.toHaveBeenCalled();
      expect(res.body.email).toEqual({ sent: false, error: 'Candidate has no email on file — cannot send rejection email.' });
      expect(fakeDb.one(/^UPDATE applications SET rejection_email_error=\$1 WHERE id=\$2$/).params).toEqual(['Candidate has no email on file.', APP_ID]);
    });

    it('a hiring_manager may send one with their Applied-and-Screened rejection; the persona gate has already run', async () => {
      program();
      expect((await reject({}, 'hiring_manager')).status).toBe(200);
      fakeDb.reset(); program({ app: { stage: 'Interview Round 1' } }); h.sendAssignmentEmail.mockClear();
      expect((await reject({}, 'hiring_manager')).status).toBe(403);
      expect(h.sendAssignmentEmail).not.toHaveBeenCalled();
    });

    it('without send_rejection_email nothing is sent and the response has no email field', async () => {
      program();
      const res = await status('hr_recruiter', { new_status: 'Rejected', rejection_reason_cat: 'Skills gap' });
      expect(h.sendAssignmentEmail).not.toHaveBeenCalled();
      expect(res.body).toEqual({ success: true, new_status: 'Rejected' });
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('POST /:id/screening — recruiter_screening_status', () => {
  it('needs new_screening_status (400) and an existing application (404)', async () => {
    program();
    expect((await screening('hr_recruiter', {})).status).toBe(400);
    fakeDb.reset(); program({ app: null });
    expect((await screening('hr_recruiter', { new_screening_status: 'New' })).status).toBe(404);
    nothingWritten();
  });

  it('a hiring_manager named on the role may set HM Shortlisted — and only HM Shortlisted', async () => {
    program();
    const ok = await screening('hiring_manager', { new_screening_status: 'HM Shortlisted' });
    expect(ok.status).toBe(200);
    expect(fakeDb.one(SQL.screeningUpdate).params).toEqual(['HM Shortlisted', APP_ID]);
    for (const value of ['New', 'Under Recruiter Review', 'Awaiting HM Review', 'Rejected', 'hm shortlisted', 'HM Shortlisted ', 'Anything else']) {
      fakeDb.reset(); program();
      const res = await screening('hiring_manager', { new_screening_status: value });
      expect([value, res.status, res.body]).toEqual([value, 403, { error: 'Only HR/Leadership can set this screening status.' }]);
      nothingWritten();
    }
  });

  describe('a Hiring Manager is scoped to the roles that name them', () => {
    const SCOPE_ERROR = { error: 'Only the Hiring Manager named on this role (or HR/Leadership) can shortlist for it.' };

    it('a Hiring Manager named on ANOTHER role gets 403, decided before any write', async () => {
      program({ roleHm: 'Someone Else' });
      const res = await screening('hiring_manager', { new_screening_status: 'HM Shortlisted' });
      expect([res.status, res.body]).toEqual([403, SCOPE_ERROR]);
      nothingWritten();
    });

    it('a role with no Hiring Manager named (null or blank) refuses every Hiring Manager', async () => {
      for (const roleHm of [null, '', '   ']) {
        fakeDb.reset(); program({ roleHm });
        expect([roleHm, (await screening('hiring_manager', { new_screening_status: 'HM Shortlisted' })).status]).toEqual([roleHm, 403]);
        nothingWritten();
      }
    });

    it('a co-Hiring-Manager field ("A, B") admits each listed person, case and spacing aside, and not a partial name', async () => {
      for (const roleHm of ['Test Hiring Manager, Piyush Negi', 'Piyush Negi & Test Hiring Manager', '  test   HIRING manager ']) {
        fakeDb.reset(); program({ roleHm });
        expect([roleHm, (await screening('hiring_manager', { new_screening_status: 'HM Shortlisted' })).status]).toEqual([roleHm, 200]);
      }
      for (const roleHm of ['Test Hiring', 'Test Hiring Managers', 'Hiring Manager']) {
        fakeDb.reset(); program({ roleHm });
        expect([roleHm, (await screening('hiring_manager', { new_screening_status: 'HM Shortlisted' })).status]).toEqual([roleHm, 403]);
        nothingWritten();
      }
    });

    it.each(HR_TIER)('%s is not scoped by the role (a Leadership user who is not the named HM still may)', async persona => {
      program({ roleHm: 'Someone Else' });
      expect((await screening(persona, { new_screening_status: 'HM Shortlisted' })).status).toBe(200);
    });
  });

  it.each(HR_TIER)('%s may set any value, HM Shortlisted included', async persona => {
    for (const value of ['New', 'Under Recruiter Review', 'Awaiting HM Review', 'HM Shortlisted']) {
      fakeDb.reset(); program();
      const res = await screening(persona, { new_screening_status: value });
      expect([persona, value, res.status]).toEqual([persona, value, 200]);
      expect(fakeDb.one(SQL.screeningUpdate).params[0]).toBe(value);
    }
  });

  describe("repeating 'HM Shortlisted' is a no-op", () => {
    it('writes no activity row and no pending action, answers 200 unchanged:true with the application (restricted fields stripped for a Hiring Manager)', async () => {
      program({ app: { recruiter_screening_status: 'HM Shortlisted' }, screeningUnchanged: true });
      const res = await screening('hiring_manager', { new_screening_status: 'HM Shortlisted' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, new_screening_status: 'HM Shortlisted', unchanged: true });
      expect(res.body.application.id).toBe(APP_ID);
      expect(fakeDb.find(SQL.activity)).toEqual([]);
      expect(fakeDb.find(SQL.resolveHmReview)).toEqual([]);
      expect(fakeDb.find(SQL.scheduleInterview)).toEqual([]);
    });

    it('is decided by the UPDATE itself (IS DISTINCT FROM), so two simultaneous requests cannot both raise the action', async () => {
      program();
      await screening('hr_recruiter', { new_screening_status: 'HM Shortlisted' });
      expect(fakeDb.one(SQL.screeningUpdate).sql).toContain('IS DISTINCT FROM');
    });

    it('a repeat by HR is the same no-op; the first change still writes everything', async () => {
      program({ app: { recruiter_screening_status: 'HM Shortlisted' }, screeningUnchanged: true });
      const res = await screening('hr_recruiter', { new_screening_status: 'HM Shortlisted' });
      expect(res.body.unchanged).toBe(true);
      expect(fakeDb.find(SQL.scheduleInterview)).toEqual([]);
      fakeDb.reset(); program();
      const first = await screening('hr_recruiter', { new_screening_status: 'HM Shortlisted' });
      expect(first.body).toEqual({ success: true, new_screening_status: 'HM Shortlisted' });
      expect(fakeDb.find(SQL.scheduleInterview)).toHaveLength(1);
    });

    it('other values are untouched: a repeat still writes and logs as before (it never raised an action)', async () => {
      program({ app: { recruiter_screening_status: 'Under Recruiter Review' } });
      const res = await screening('hr_recruiter', { new_screening_status: 'Under Recruiter Review' });
      expect(res.body).toEqual({ success: true, new_screening_status: 'Under Recruiter Review' });
      expect(fakeDb.one(SQL.screeningUpdate).sql).not.toContain('IS DISTINCT FROM');
      expect(fakeDb.find(SQL.activity)).toHaveLength(1);
    });
  });

  it('the old and new values are logged against the acting user', async () => {
    program({ app: { recruiter_screening_status: 'Awaiting HM Review' } });
    await screening('hiring_manager', { new_screening_status: 'HM Shortlisted' });
    expect(fakeDb.one(SQL.activity).params).toEqual([APP_ID, 'C9001', 'R9001', 'Recruiter Screening Status Changed', 'Screening → HM Shortlisted', 'Awaiting HM Review', 'HM Shortlisted', 'U9002', 'Test Hiring Manager']);
  });

  it('HM Shortlisted (from anyone allowed to set it) resolves the open "HM shortlist review" action and raises "Schedule interview" for HR — in one transaction; no other value does either', async () => {
    program();
    await screening('hiring_manager', { new_screening_status: 'HM Shortlisted' });
    expect(fakeDb.one(SQL.resolveHmReview).params).toEqual([APP_ID]);
    const raise = fakeDb.one(SQL.scheduleInterview);
    expect(raise.params).toEqual([APP_ID, 'Candidate Example', 'Quality Assurance Engineer']);
    expect(raise.inTransaction).toBe(true);
    expect(fakeDb.tx).toEqual({ started: 1, committed: 1, rolledBack: 0 });

    fakeDb.reset(); program();
    await screening('hr_recruiter', { new_screening_status: 'Under Recruiter Review' });
    expect(fakeDb.find(SQL.resolveHmReview)).toEqual([]);
    expect(fakeDb.find(SQL.scheduleInterview)).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('POST /:id/founder-flag', () => {
  const flag = (as: Actor, body: Record<string, unknown>) => api.post(`/api/applications/${APP_ID}/founder-flag`, { as, body });

  it('is HR-tier only: a hiring_manager gets 403 before the database is even read', async () => {
    program();
    const res = await flag('hiring_manager', { set: true });
    expect([res.status, res.body]).toEqual([403, { error: 'Only HR or Leadership can set the Founder Review flag' }]);
    expect(fakeDb.untouched()).toBe(true);
  });

  it.each(HR_TIER)('%s sets it: the flag, note and who set it are stored; a "Founder Review" action is raised for Leadership; logged', async persona => {
    program();
    const res = await flag(persona, { set: true, note: 'Strong portfolio' });
    expect(res.status).toBe(200);
    expect(fakeDb.one(SQL.founderUpdate).params).toEqual([true, 'Strong portfolio', TEST_USERS[persona].userId, APP_ID]);
    expect(fakeDb.one(SQL.founderRaise).params).toEqual([APP_ID, 'Candidate Example', 'Quality Assurance Engineer']);
    expect(fakeDb.one(SQL.activity).params.slice(3, 7)).toEqual(['Founder Review Flag Set', 'Strong portfolio', null, 'true']);
  });

  it('clearing it stores false and a null note, resolves the open "Founder Review" action, and raises nothing', async () => {
    program();
    const res = await flag('leadership', { set: false });
    expect(res.status).toBe(200);
    expect(fakeDb.one(SQL.founderUpdate).params).toEqual([false, null, 'U9003', APP_ID]);
    expect(fakeDb.one(SQL.founderClear).params).toEqual([APP_ID]);
    expect(fakeDb.find(SQL.founderRaise)).toEqual([]);
    expect(fakeDb.one(SQL.activity).params[3]).toBe('Founder Review Flag Cleared');
  });

  it('an unknown application is 404 and nothing is written', async () => {
    program({ app: null });
    expect((await flag('hr_recruiter', { set: true })).status).toBe(404);
    nothingWritten();
  });

  it('characterization: only the boolean true stores a true flag, but any truthy value takes the "set" branch for the log and the action — { set: "yes" } stores false yet raises a Founder Review action', async () => {
    program();
    await flag('hr_recruiter', { set: 'yes' });
    expect(fakeDb.one(SQL.founderUpdate).params[0]).toBe(false);
    expect(fakeDb.find(SQL.founderRaise)).toHaveLength(1);
    expect(fakeDb.one(SQL.activity).params[3]).toBe('Founder Review Flag Set');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('PATCH /:id/notes and POST /:id/retry-scoring (HR-tier)', () => {
  const notes = (as: Actor, body: Record<string, unknown>) => api.patch(`/api/applications/${APP_ID}/notes`, { as, body });

  it('both are 403 for a hiring_manager, before the database', async () => {
    const a = await notes('hiring_manager', { hr_key_positives: 'x' });
    const b = await api.post(`/api/applications/${APP_ID}/retry-scoring`, { as: 'hiring_manager', body: {} });
    expect([a.status, b.status]).toEqual([403, 403]);
    expect(fakeDb.untouched()).toBe(true);
    expect(h.runResumeIQScoring).not.toHaveBeenCalled();
  });

  it('notes: only the whitelisted fields are written — stage, status, scores and anything else sent are ignored, and a body with none of them is 400', async () => {
    program();
    const res = await notes('hr_recruiter', { stage: 'Joined', status: 'Rejected', ai_fit_score: 100, score_avg: 10, id: 'A1', hr_key_positives: 'Clear communicator', internal_risk_notes: 'Notice period risk' });
    expect(res.status).toBe(200);
    const update = fakeDb.one(/^UPDATE applications SET hr_key_positives = \$1, internal_risk_notes = \$2, last_updated=NOW\(\) WHERE id=\$3$/);
    expect(update.params).toEqual(['Clear communicator', 'Notice period risk', APP_ID]);
    fakeDb.reset(); program();
    const none = await notes('hr_recruiter', { stage: 'Joined', ai_fit_score: 100 });
    expect([none.status, none.body]).toEqual([400, { error: 'No valid fields' }]);
    nothingWritten();
  });

  it('notes: logging fresh HR contact (last_hr_contact) resets the write-once joining_risk_auto_flag; other fields do not', async () => {
    program();
    await notes('hr_recruiter', { last_hr_contact: '2026-10-28' });
    expect(fakeDb.one(/^UPDATE applications SET last_hr_contact = \$1, last_updated=NOW\(\), joining_risk_auto_flag = false WHERE id=\$2$/).params).toEqual(['2026-10-28', APP_ID]);
    fakeDb.reset(); program();
    await notes('hr_recruiter', { joining_risk_notes: 'n' });
    expect(fakeDb.statements().join('\n')).not.toContain('joining_risk_auto_flag');
  });

  it('notes: setting or changing a priority override needs a non-blank reason (400 before any write); only the reason, or clearing, needs none', async () => {
    const noWrite = () => expect(fakeDb.statements().join('\n')).not.toMatch(/UPDATE applications SET/);
    for (const reason of [undefined, '', '   ', '\n', null, 5]) {
      fakeDb.reset(); program();
      const body: Record<string, unknown> = { hr_priority_override: 'Critical' };
      if (reason !== undefined) body.hr_priority_override_reason = reason;
      const res = await notes('hr_recruiter', body);
      expect([String(reason), res.status, res.body.error]).toEqual([String(reason), 400, 'hr_priority_override_reason is required when setting an HR priority override']);
      noWrite();
    }
    // other notes fields sent alongside do not rescue it, and nothing of them is written either
    fakeDb.reset(); program();
    expect((await notes('hr_recruiter', { hr_priority_override: 'High', hr_recruiter_summary: 'x' })).status).toBe(400);
    noWrite();
  });

  describe('notes: the override reason may already be stored (the candidate page sends only the keys that changed)', () => {
    const SEL = /^SELECT hr_priority_override, hr_priority_override_reason FROM applications WHERE id=\$1$/;
    const actRow = () => fakeDb.whenOne(/^SELECT candidate_id, role_id FROM applications WHERE id=\$1$/, { candidate_id: 'C9001', role_id: 'R9001' });

    it('changing only the select, with a reason already on record, is accepted and the activity line carries the stored reason', async () => {
      program(); actRow();
      fakeDb.whenOne(SEL, { hr_priority_override: 'High', hr_priority_override_reason: 'Referral from CEO' });
      const res = await notes('hr_recruiter', { hr_priority_override: 'Critical' });
      expect([res.status, res.body]).toEqual([200, { success: true }]);
      expect(fakeDb.one(SQL.activity).params[4]).toBe('HR Priority → Critical: Referral from CEO');
    });

    it('a reason in the request wins over the stored one', async () => {
      program(); actRow();
      fakeDb.whenOne(SEL, { hr_priority_override: 'High', hr_priority_override_reason: 'old reason' });
      expect((await notes('hr_recruiter', { hr_priority_override: 'Critical', hr_priority_override_reason: 'new reason' })).status).toBe(200);
      expect(fakeDb.one(SQL.activity).params[4]).toBe('HR Priority → Critical: new reason');
    });

    it('re-sending the value that is already stored is not a change: no reason needed, even with none on record', async () => {
      program(); actRow();
      fakeDb.whenOne(SEL, { hr_priority_override: 'High', hr_priority_override_reason: null });
      expect((await notes('hr_recruiter', { hr_priority_override: 'High' })).status).toBe(200);
    });

    it('a CHANGE with no reason in the request and none (or a blank one) on record is still 400, and nothing is written', async () => {
      for (const stored of [{ hr_priority_override: 'High', hr_priority_override_reason: null }, { hr_priority_override: 'High', hr_priority_override_reason: '   ' }, { hr_priority_override: null, hr_priority_override_reason: null }]) {
        fakeDb.reset(); program();
        fakeDb.whenOne(SEL, stored);
        const res = await notes('hr_recruiter', { hr_priority_override: 'Critical' });
        expect([JSON.stringify(stored), res.status]).toEqual([JSON.stringify(stored), 400]);
        expect(fakeDb.statements().join('\n')).not.toMatch(/UPDATE applications SET/);
      }
    });
  });

  it('notes: clearing the override (null, empty string, Normal) needs no reason; an empty string is stored as NULL; a reason alone is not an override change', async () => {
    for (const [v, stored] of [[null, null], ['', null], ['Normal', 'Normal']] as const) {
      fakeDb.reset(); program();
      fakeDb.whenOne(/^SELECT candidate_id, role_id FROM applications WHERE id=\$1$/, { candidate_id: 'C9001', role_id: 'R9001' });
      expect([String(v), (await notes('hr_recruiter', { hr_priority_override: v })).status]).toEqual([String(v), 200]);
      expect(fakeDb.one(/^UPDATE applications SET hr_priority_override = \$1/).params).toEqual([stored, APP_ID]);
    }
    fakeDb.reset(); program();
    expect((await notes('hr_recruiter', { hr_priority_override_reason: 'only a reason' })).status).toBe(200);
  });

  it('notes: the override reason is trimmed-checked but stored as sent; a valid pair is logged', async () => {
    program();
    fakeDb.whenOne(/^SELECT candidate_id, role_id FROM applications WHERE id=\$1$/, { candidate_id: 'C9001', role_id: 'R9001' });
    expect((await notes('hr_recruiter', { hr_priority_override: 'High', hr_priority_override_reason: ' urgent ' })).status).toBe(200);
  });

  it('notes: setting a priority override is logged with the reason, against the acting user', async () => {
    program();
    fakeDb.whenOne(/^SELECT candidate_id, role_id FROM applications WHERE id=\$1$/, { candidate_id: 'C9001', role_id: 'R9001' });
    await notes('leadership', { hr_priority_override: 'P0', hr_priority_override_reason: 'Founder referral' });
    expect(fakeDb.one(SQL.activity).params).toEqual([APP_ID, 'C9001', 'R9001', 'Priority Override Set', 'HR Priority → P0: Founder referral', null, 'P0', 'U9003', 'Test Leader']);
  });

  it('retry-scoring: HR-tier runs the scoring for an existing application and returns its result; an unknown application is 404', async () => {
    fakeDb.whenOne(/^SELECT id, score_avg FROM applications WHERE id=\$1$/, { id: APP_ID, score_avg: null });
    h.runResumeIQScoring.mockResolvedValue({ scored: true });
    const res = await api.post(`/api/applications/${APP_ID}/retry-scoring`, { as: 'hr_recruiter', body: {} });
    expect([res.status, res.body]).toEqual([200, { resumeiq: { scored: true } }]);
    expect(h.runResumeIQScoring).toHaveBeenCalledWith(APP_ID);
    fakeDb.reset(); h.runResumeIQScoring.mockClear();
    expect((await api.post(`/api/applications/${APP_ID}/retry-scoring`, { as: 'hr_recruiter', body: {} })).status).toBe(404);
    expect(h.runResumeIQScoring).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('GET /:id and GET / — compensation is hidden from a hiring_manager unless they are named on that role', () => {
  const ROW = {
    ...UPDATED_ROW, candidate_name: 'Candidate Example', role_title: 'Quality Assurance Engineer', role_ctc_band: '18-24 LPA',
    candidate_expected_ctc: 30, candidate_ctc_fixed: 20, candidate_ctc_variable: 2,
  };
  const HIDDEN = ['offer_ctc_fixed', 'offer_ctc_variable', 'internal_risk_notes', 'agency_fee_estimate', 'hr_comp_alignment', 'role_ctc_band', 'candidate_expected_ctc', 'candidate_ctc_fixed', 'candidate_ctc_variable', 'ectc'];
  const detail = (as: Actor, hmField: string) => {
    fakeDb.reset();
    fakeDb.whenOne(/^SELECT a\.\*, c\.full_name AS candidate_name/, { ...ROW, hiring_manager_name: hmField });
    return api.get(`/api/applications/${APP_ID}`, { as });
  };
  const list = (as: Actor, hmField: string) => {
    fakeDb.reset();
    fakeDb.when(/^SELECT a\.\*, c\.full_name AS candidate_name/, [{ ...ROW, hiring_manager_name: hmField }]);
    return api.get('/api/applications', { as });
  };

  it('detail: stripped for a hiring_manager on someone else\'s role, whole for HR-tier and for the named Hiring Manager (one of several, any case)', async () => {
    const stripped = (await detail('hiring_manager', 'Somebody Else')).body.application;
    for (const f of HIDDEN) expect(stripped, f).not.toHaveProperty(f);
    expect(stripped.candidate_name).toBe('Candidate Example');
    for (const persona of HR_TIER) {
      const full = (await detail(persona, 'Somebody Else')).body.application;
      for (const f of HIDDEN) expect([persona, f, full[f]]).toEqual([persona, f, (ROW as Record<string, unknown>)[f]]);
    }
    const named = (await detail('hiring_manager', 'Somebody Else, TEST hiring   manager')).body.application;
    for (const f of HIDDEN) expect(named[f], f).toBe((ROW as Record<string, unknown>)[f]);
  });

  it('the over-budget yes/no is computed from the real figures BEFORE they are stripped and is the one thing a hiring_manager keeps (they must be able to resolve the shortlist gate)', async () => {
    const hm = (await detail('hiring_manager', 'Somebody Else')).body.application;
    expect(hm.is_severely_over_budget).toBe(true);               // 30 against a band whose ceiling is 24 → over 27.6
    expect(hm).not.toHaveProperty('role_ctc_band');
    const fine = await (async () => { fakeDb.reset(); fakeDb.whenOne(/^SELECT a\.\*, c\.full_name AS candidate_name/, { ...ROW, candidate_expected_ctc: 20, hiring_manager_name: 'x' }); return api.get(`/api/applications/${APP_ID}`, { as: 'hiring_manager' }); })();
    expect(fine.body.application.is_severely_over_budget).toBe(false);
  });

  it('list: the same rule applied row by row', async () => {
    const hm = (await list('hiring_manager', 'Somebody Else')).body;
    expect(hm.count).toBe(1);
    for (const f of HIDDEN) expect(hm.applications[0], f).not.toHaveProperty(f);
    expect(hm.applications[0].is_severely_over_budget).toBe(true);
    const hr = (await list('hr_recruiter', 'Somebody Else')).body.applications[0];
    for (const f of HIDDEN) expect(hr[f], f).toBe((ROW as Record<string, unknown>)[f]);
  });

  it('detail: 404 for an unknown application', async () => {
    fakeDb.whenOne(/^SELECT a\.\*, c\.full_name AS candidate_name/, null);
    expect((await api.get(`/api/applications/${APP_ID}`, { as: 'hiring_manager' })).status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('getSlaHours — the sla_hours stored on an application at each stage change', () => {
  const H = SLA_HOURS;
  it.each([
    ['Applied and Screened', 48], ['Interview Round 1', H.INTERVIEW_FEEDBACK], ['Interview Round 2', H.INTERVIEW_FEEDBACK],
    ['Founders Round', H.INTERVIEW_FEEDBACK], ['Reference Check', H.REF_INIT], ['Offer Released', H.OFFER_RELEASE],
    ['Assignment Round', 48], ['Pre-Joining Documents', H.IDLE], ['Offer Discussion', H.IDLE], ['Offer Accepted', H.IDLE], ['Joined', H.IDLE],
    ['Interview Round 7', H.INTERVIEW_FEEDBACK], ['Interview – Round 3', H.INTERVIEW_FEEDBACK],
    ['interview round 1', H.IDLE], ['Resume Review', H.IDLE], ['Shortlisted', H.IDLE], ['', H.IDLE], ['Banana', H.IDLE],
  ])('%s → %i hours', (stageName, hours) => {
    expect(getSlaHours(stageName)).toBe(hours);
  });

  it('every stage of STAGE_ORDER gets one of the documented values (a stage added without thinking about its SLA falls to the 72-hour idle default)', () => {
    const byStage = Object.fromEntries(STAGE_ORDER.map(s => [s, getSlaHours(s)]));
    expect(byStage).toEqual({
      'Applied and Screened': 48, 'Interview Round 1': 48, 'Interview Round 2': 48, 'Assignment Round': 48, 'Founders Round': 48,
      'Reference Check': 48, 'Pre-Joining Documents': 72, 'Offer Discussion': 72, 'Offer Released': 48, 'Offer Accepted': 72, 'Joined': 72,
    });
  });

  it('the fit score tiers the five SOP stages (24 from fit 75) and matters nowhere else', () => {
    for (const fit of [undefined, null, 0, 74, 74.99, NaN, -5]) {
      expect([fit, getSlaHours('Applied and Screened', fit)]).toEqual([fit, 48]);
      expect([fit, getSlaHours('Interview Round 1', fit)]).toEqual([fit, 48]);
      expect([fit, getSlaHours('Joined', fit)]).toEqual([fit, 72]);
    }
    for (const fit of [75, 100]) {
      for (const st of ['Applied and Screened', 'Interview Round 1', 'Interview Round 2', 'Founders Round', 'Assignment Round']) expect([st, getSlaHours(st, fit)]).toEqual([st, 24]);
      expect([fit, getSlaHours('Reference Check', fit)]).toEqual([fit, 48]);
      expect([fit, getSlaHours('Joined', fit)]).toEqual([fit, 72]);
    }
  });

  it('for a high-fit candidate (fit >= 75) the stored sla_hours equals the engine\'s breach threshold (tieredStandardHours), above and below the line', () => {
    expect(getSlaHours('Applied and Screened', 80)).toBe(24);
    expect(tieredStandardHours(80)).toBe(24);
    expect(getSlaHours('Applied and Screened', 74)).toBe(tieredStandardHours(74));
  });
});
