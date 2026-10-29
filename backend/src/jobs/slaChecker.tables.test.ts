import { describe, it, expect } from 'vitest';
import {
  tieredStandardHours,
  BREACH_IDLE_HOURS, BREACH_STANDARD_HOURS, BREACH_ASSIGNMENT_FEEDBACK_HOURS, HIGH_SCORE_THRESHOLD, BREACH_HIGH_SCORE_HOURS, LEADERSHIP_ESCALATION_HOURS,
  FLAT_STAGE_CHECKS, NOT_YET_ACTIONED_STAGES, FEEDBACK_DUE_STAGES, VALID_STAGES_BY_ACTION_TYPE, ALL_KNOWN_ACTION_TYPES,
  STAGE_SLA_ACTION_TYPES, ALL_BREACH_ACTION_TYPES, NON_ACTIONABLE_ALERT_TYPES, EXTERNAL_ACTION_TYPES, LEADERSHIP_ESCALATION_ACTION_TYPES,
  FEEDBACK_DUE_ACTION_TYPES, NOT_SCHEDULED_ACTION_TYPES,
} from './slaChecker.js';
import { STAGE_ORDER, SLA_HOURS } from '../types/index.js';

// The SLA engine's declarative tables (which stage is chased by which breach type, and for whom) and its thresholds.
// The SQL that runs over them is covered by the Playwright db specs against a real Postgres; what is pinned here is the data that drives it:
// a stage added to STAGE_ORDER with no SLA treatment, a typo in an action_type string, or one list drifting from another would otherwise
// silently stop chasing a stage or auto-resolve live rows (resolveUnknownActionTypes resolves anything not in ALL_KNOWN_ACTION_TYPES).
const asSet = (xs: readonly string[]) => new Set(xs);
const hasDuplicates = (xs: readonly string[]) => new Set(xs).size !== xs.length;

describe('thresholds (Hiring SOP v2.1)', () => {
  it('the standard breach is 48h, the high-score tier is 24h from a fit score of 75, idle is 48h and assignment feedback 96h', () => {
    expect(BREACH_STANDARD_HOURS).toBe(48);
    expect(BREACH_HIGH_SCORE_HOURS).toBe(24);
    expect(HIGH_SCORE_THRESHOLD).toBe(75);
    expect(BREACH_IDLE_HOURS).toBe(48);
    expect(BREACH_ASSIGNMENT_FEEDBACK_HOURS).toBe(96);
  });

  it('the Leadership escalation comes strictly later than any feedback breach it escalates (96h > 48h > 24h)', () => {
    expect(LEADERSHIP_ESCALATION_HOURS).toBe(96);
    expect(LEADERSHIP_ESCALATION_HOURS).toBeGreaterThan(BREACH_STANDARD_HOURS);
    expect(LEADERSHIP_ESCALATION_HOURS).toBeGreaterThan(BREACH_HIGH_SCORE_HOURS);
  });

  it('the tier is a tightening: the high-score hours are below the standard ones', () => {
    expect(BREACH_HIGH_SCORE_HOURS).toBeLessThan(BREACH_STANDARD_HOURS);
  });

  it('SOP lines that are deliberately NOT tiered: idle stays 48h and assignment feedback stays 96h whatever the score', () => {
    // BREACH_IDLE_HOURS and BREACH_ASSIGNMENT_FEEDBACK_HOURS are read directly by the engine, never through tieredStandardHours.
    expect(BREACH_IDLE_HOURS).toBe(BREACH_STANDARD_HOURS);
    expect(BREACH_ASSIGNMENT_FEEDBACK_HOURS).toBeGreaterThan(BREACH_STANDARD_HOURS);
  });

  it('KNOWN DIVERGENCE (pinned so a change is deliberate): the stored SLA_HOURS.RESUME_REVIEW_HIGH_FIT is still 48 while the engine tiers a high-fit candidate at 24', () => {
    expect(SLA_HOURS.RESUME_REVIEW_HIGH_FIT).toBe(48);
    expect(tieredStandardHours(HIGH_SCORE_THRESHOLD)).toBe(24);
    expect(SLA_HOURS.RESUME_REVIEW_HIGH_FIT).not.toBe(tieredStandardHours(HIGH_SCORE_THRESHOLD));
  });
});

describe('tieredStandardHours (48h, or 24h for a candidate scoring at least 75)', () => {
  it.each([
    [null, 48],
    [undefined as unknown as null, 48],
    [Number.NaN, 48],
    [-100, 48],
    [-0.0001, 48],
    [0, 48],
    [1, 48],
    [74, 48],
    [74.99, 48],
    [74.999999, 48],
    [75, 24],
    [75.000001, 24],
    [75.01, 24],
    [76, 24],
    [100, 24],
    [101, 24],
    [1e9, 24],
    [Number.POSITIVE_INFINITY, 24],
    [Number.NEGATIVE_INFINITY, 48],
  ])('a fit score of %s gets %sh', (score, hours) => {
    expect(tieredStandardHours(score)).toBe(hours);
  });

  it('the cut-off is the exported HIGH_SCORE_THRESHOLD, inclusive', () => {
    expect(tieredStandardHours(HIGH_SCORE_THRESHOLD)).toBe(BREACH_HIGH_SCORE_HOURS);
    expect(tieredStandardHours(HIGH_SCORE_THRESHOLD - 0.01)).toBe(BREACH_STANDARD_HOURS);
  });

  it('only ever answers one of the two tier values', () => {
    for (const s of [null, 0, 12.5, 50, 74.9, 75, 99, 100]) expect([BREACH_STANDARD_HOURS, BREACH_HIGH_SCORE_HOURS]).toContain(tieredStandardHours(s));
  });
});

describe('FLAT_STAGE_CHECKS (stage-entry-anchored breaches with no round involved)', () => {
  it('is exactly the idle catch-all for four late stages and "Resume Shortlist Pending" at Applied and Screened', () => {
    expect(FLAT_STAGE_CHECKS).toEqual([
      { stages: ['Reference Check', 'Pre-Joining Documents', 'Offer Discussion', 'Offer Released'], actionType: 'Idle Candidate', owner: 'HR / Recruiter' },
      { stages: ['Applied and Screened'], actionType: 'Resume Shortlist Pending', owner: 'Hiring Manager' },
    ]);
  });

  it('every stage it names is a real pipeline stage', () => {
    for (const cfg of FLAT_STAGE_CHECKS) for (const s of cfg.stages) expect(STAGE_ORDER, `${cfg.actionType} -> ${s}`).toContain(s);
  });

  it('owners are one of the two people-owner types the pending-actions queue knows', () => {
    for (const cfg of FLAT_STAGE_CHECKS) expect(['HR / Recruiter', 'Hiring Manager']).toContain(cfg.owner);
  });
});

describe('NOT_YET_ACTIONED_STAGES and FEEDBACK_DUE_STAGES (round-based breaches)', () => {
  it('"not yet actioned" covers Interview 1, Interview 2, Founders Round and Assignment, in pipeline order', () => {
    expect(NOT_YET_ACTIONED_STAGES.map(c => [c.stage, c.actionType, c.roundType])).toEqual([
      ['Interview Round 1', 'Interview 1 Not Scheduled', 'Standard'],
      ['Interview Round 2', 'Interview 2 Not Scheduled', 'Standard'],
      ['Founders Round', 'Founders Round Not Scheduled', 'Standard'],
      ['Assignment Round', 'Assignment Not Sent', 'Assignment'],
    ]);
  });

  it('"feedback due" covers the same four stages, with the Standard rounds tiered and Assignment on its own flat 96h', () => {
    expect(FEEDBACK_DUE_STAGES.map(c => [c.stage, c.actionType, c.roundType, c.thresholdHours, c.scoreTiered])).toEqual([
      ['Interview Round 1', 'Interview 1 Feedback Due', 'Standard', 48, true],
      ['Interview Round 2', 'Interview 2 Feedback Due', 'Standard', 48, true],
      ['Founders Round', 'Founders Round Feedback Due', 'Standard', 48, true],
      ['Assignment Round', 'Assignment Feedback Due', 'Assignment', 96, false],
    ]);
  });

  it('both tables name only real pipeline stages, and the same stages as each other', () => {
    for (const c of [...NOT_YET_ACTIONED_STAGES, ...FEEDBACK_DUE_STAGES]) expect(STAGE_ORDER).toContain(c.stage);
    expect(NOT_YET_ACTIONED_STAGES.map(c => c.stage)).toEqual(FEEDBACK_DUE_STAGES.map(c => c.stage));
  });

  it('a Standard round is anchored to scheduled_date and an Assignment round to assignment_send_date, in both tables', () => {
    for (const c of [...NOT_YET_ACTIONED_STAGES, ...FEEDBACK_DUE_STAGES]) {
      expect(c.anchorColumn, c.actionType).toBe(c.roundType === 'Standard' ? 'scheduled_date' : 'assignment_send_date');
    }
  });

  it('anchorColumn is one of two fixed identifiers (it is interpolated into SQL, so it must never be anything else)', () => {
    for (const c of [...NOT_YET_ACTIONED_STAGES, ...FEEDBACK_DUE_STAGES]) {
      expect(['scheduled_date', 'assignment_send_date']).toContain(c.anchorColumn);
      expect(c.anchorColumn).toMatch(/^[a-z_]+$/);
    }
  });

  it('a tiered feedback config starts from the standard hours (the tier then lowers it per candidate); the flat one is the assignment 96h', () => {
    for (const c of FEEDBACK_DUE_STAGES) {
      expect(c.thresholdHours).toBe(c.scoreTiered ? BREACH_STANDARD_HOURS : BREACH_ASSIGNMENT_FEEDBACK_HOURS);
    }
  });

  it('only Standard-round feedback is tiered (the SOP names "interview feedback")', () => {
    expect(FEEDBACK_DUE_STAGES.filter(c => c.scoreTiered).every(c => c.roundType === 'Standard')).toBe(true);
    expect(FEEDBACK_DUE_STAGES.filter(c => !c.scoreTiered).map(c => c.roundType)).toEqual(['Assignment']);
  });
});

describe('every pipeline stage is chased by something (or is accounted for elsewhere)', () => {
  const chased = new Set<string>([
    ...FLAT_STAGE_CHECKS.flatMap(c => c.stages),
    ...NOT_YET_ACTIONED_STAGES.map(c => c.stage),
    ...FEEDBACK_DUE_STAGES.map(c => c.stage),
  ]);

  it('the stages with no stage-driven SLA are exactly Offer Accepted (the separate joining-risk check) and Joined (terminal)', () => {
    expect(STAGE_ORDER.filter(s => !chased.has(s))).toEqual(['Offer Accepted', 'Joined']);
  });

  it('every other stage in STAGE_ORDER has at least one breach type, so adding a stage means choosing its SLA', () => {
    for (const s of STAGE_ORDER.filter(x => x !== 'Offer Accepted' && x !== 'Joined')) expect(chased.has(s), s).toBe(true);
  });

  it('no stage named by any table is missing from STAGE_ORDER (a renamed stage would silently stop being checked)', () => {
    for (const s of chased) expect(STAGE_ORDER, s).toContain(s);
  });
});

describe('action-type lists', () => {
  it('no action type is produced by two different configs', () => {
    const all = [...FLAT_STAGE_CHECKS.map(c => c.actionType), ...NOT_YET_ACTIONED_STAGES.map(c => c.actionType), ...FEEDBACK_DUE_STAGES.map(c => c.actionType)];
    expect(hasDuplicates(all)).toBe(false);
    expect(all).toHaveLength(10);
  });

  it('FEEDBACK_DUE_ACTION_TYPES and NOT_SCHEDULED_ACTION_TYPES list the expected strings (Assignment is not in "not scheduled": it is sent, not scheduled)', () => {
    expect(FEEDBACK_DUE_ACTION_TYPES).toEqual(['Interview 1 Feedback Due', 'Interview 2 Feedback Due', 'Founders Round Feedback Due', 'Assignment Feedback Due']);
    expect(NOT_SCHEDULED_ACTION_TYPES).toEqual(['Interview 1 Not Scheduled', 'Interview 2 Not Scheduled', 'Founders Round Not Scheduled']);
    expect(NOT_SCHEDULED_ACTION_TYPES).not.toContain('Assignment Not Sent');
  });

  it('STAGE_SLA_ACTION_TYPES is the two flat types plus every not-actioned and feedback type (10)', () => {
    expect([...STAGE_SLA_ACTION_TYPES]).toEqual([
      'Idle Candidate', 'Resume Shortlist Pending',
      'Interview 1 Not Scheduled', 'Interview 2 Not Scheduled', 'Founders Round Not Scheduled', 'Assignment Not Sent',
      'Interview 1 Feedback Due', 'Interview 2 Feedback Due', 'Founders Round Feedback Due', 'Assignment Feedback Due',
    ]);
  });

  it('every type the engine can produce from a stage is in STAGE_SLA_ACTION_TYPES, and nothing else is', () => {
    const produced = [...FLAT_STAGE_CHECKS.map(c => c.actionType), ...NOT_YET_ACTIONED_STAGES.map(c => c.actionType), ...FEEDBACK_DUE_STAGES.map(c => c.actionType)];
    expect(asSet(STAGE_SLA_ACTION_TYPES)).toEqual(asSet(produced));
    expect(hasDuplicates(STAGE_SLA_ACTION_TYPES)).toBe(false);
  });

  it('ALL_BREACH_ACTION_TYPES is the stage types plus the two independent checks, and contains every feedback and not-scheduled type', () => {
    expect([...ALL_BREACH_ACTION_TYPES]).toEqual([...STAGE_SLA_ACTION_TYPES, 'Assignment deadline breached', 'Joining risk — no contact']);
    for (const t of [...FEEDBACK_DUE_ACTION_TYPES, ...NOT_SCHEDULED_ACTION_TYPES, ...STAGE_SLA_ACTION_TYPES]) expect(ALL_BREACH_ACTION_TYPES).toContain(t);
    expect(hasDuplicates(ALL_BREACH_ACTION_TYPES)).toBe(false);
    expect(ALL_BREACH_ACTION_TYPES).toHaveLength(12);
  });

  it('the Leadership escalation, role aging and compensation flag are NOT candidate-flow breaches (the dashboard\'s breach count must not include them)', () => {
    for (const t of [...LEADERSHIP_ESCALATION_ACTION_TYPES, 'Role aging alert', 'Compensation change flag']) expect(ALL_BREACH_ACTION_TYPES).not.toContain(t);
  });

  it('the non-actionable alert list is exactly role aging, the compensation flag and the Leadership escalation', () => {
    expect(asSet(NON_ACTIONABLE_ALERT_TYPES)).toEqual(asSet(['Role aging alert', 'Compensation change flag', 'Feedback Overdue — Leadership Escalation']));
    expect(NON_ACTIONABLE_ALERT_TYPES).toContain(LEADERSHIP_ESCALATION_ACTION_TYPES[0]);
  });

  it('"Founder Review" is NOT a non-actionable alert (it feeds the founder-flagged queue)', () => {
    expect(NON_ACTIONABLE_ALERT_TYPES).not.toContain('Founder Review');
    expect(EXTERNAL_ACTION_TYPES).toContain('Founder Review');
  });

  it('the externally-inserted types are exactly Founder Review, HM shortlist review and Schedule interview', () => {
    expect([...EXTERNAL_ACTION_TYPES]).toEqual(['Founder Review', 'HM shortlist review', 'Schedule interview']);
  });

  it('the three families (breach, non-actionable alert, external) never overlap', () => {
    const breach = asSet(ALL_BREACH_ACTION_TYPES);
    const alerts = asSet(NON_ACTIONABLE_ALERT_TYPES);
    for (const t of alerts) expect(breach.has(t), `alert ${t} also a breach`).toBe(false);
    for (const t of EXTERNAL_ACTION_TYPES) {
      expect(breach.has(t), `external ${t} also a breach`).toBe(false);
      expect(alerts.has(t), `external ${t} also an alert`).toBe(false);
    }
  });

  it('ALL_KNOWN_ACTION_TYPES is the union of the three families with no duplicates (anything outside it is auto-resolved as retired)', () => {
    expect(ALL_KNOWN_ACTION_TYPES).toHaveLength(ALL_BREACH_ACTION_TYPES.length + NON_ACTIONABLE_ALERT_TYPES.length + EXTERNAL_ACTION_TYPES.length);
    expect(hasDuplicates(ALL_KNOWN_ACTION_TYPES)).toBe(false);
    for (const t of [...ALL_BREACH_ACTION_TYPES, ...NON_ACTIONABLE_ALERT_TYPES, ...EXTERNAL_ACTION_TYPES]) expect(ALL_KNOWN_ACTION_TYPES).toContain(t);
  });

  it('the retired "Interview feedback due" string is unknown (so the sweep keeps resolving any leftover row)', () => {
    expect(ALL_KNOWN_ACTION_TYPES).not.toContain('Interview feedback due');
  });

  it('every action type is a plain non-empty trimmed string', () => {
    for (const t of ALL_KNOWN_ACTION_TYPES) {
      expect(typeof t).toBe('string');
      expect(t.length).toBeGreaterThan(0);
      expect(t).toBe(t.trim());
    }
  });
});

describe('VALID_STAGES_BY_ACTION_TYPE (which stage each stage-keyed breach is valid for; feeds the stale-row sweep)', () => {
  it('has a key for every stage-driven action type and nothing else', () => {
    expect(asSet(Object.keys(VALID_STAGES_BY_ACTION_TYPE))).toEqual(asSet(STAGE_SLA_ACTION_TYPES));
  });

  it('is derived exactly from the three tables', () => {
    expect(VALID_STAGES_BY_ACTION_TYPE).toEqual({
      'Idle Candidate': ['Reference Check', 'Pre-Joining Documents', 'Offer Discussion', 'Offer Released'],
      'Resume Shortlist Pending': ['Applied and Screened'],
      'Interview 1 Not Scheduled': ['Interview Round 1'],
      'Interview 2 Not Scheduled': ['Interview Round 2'],
      'Founders Round Not Scheduled': ['Founders Round'],
      'Assignment Not Sent': ['Assignment Round'],
      'Interview 1 Feedback Due': ['Interview Round 1'],
      'Interview 2 Feedback Due': ['Interview Round 2'],
      'Founders Round Feedback Due': ['Founders Round'],
      'Assignment Feedback Due': ['Assignment Round'],
    });
  });

  it('every valid stage is a pipeline stage and no list is empty', () => {
    for (const [type, stages] of Object.entries(VALID_STAGES_BY_ACTION_TYPE)) {
      expect(stages.length, type).toBeGreaterThan(0);
      for (const s of stages) expect(STAGE_ORDER, `${type} -> ${s}`).toContain(s);
    }
  });

  it('"Idle Candidate" is only ever valid at a stage with no other breach type (a stage never mixes breach types by construction)', () => {
    const idleStages = VALID_STAGES_BY_ACTION_TYPE['Idle Candidate'];
    for (const [type, stages] of Object.entries(VALID_STAGES_BY_ACTION_TYPE)) {
      if (type === 'Idle Candidate') continue;
      for (const s of stages) expect(idleStages, `${type} also valid at idle stage ${s}`).not.toContain(s);
    }
  });

  it('"Resume Shortlist Pending" is the only breach at Applied and Screened', () => {
    const at = Object.entries(VALID_STAGES_BY_ACTION_TYPE).filter(([, stages]) => stages.includes('Applied and Screened')).map(([t]) => t);
    expect(at).toEqual(['Resume Shortlist Pending']);
  });

  it('"not scheduled" and "feedback due" can share a stage (they are mutually exclusive by round state, not by stage)', () => {
    const at = Object.entries(VALID_STAGES_BY_ACTION_TYPE).filter(([, stages]) => stages.includes('Interview Round 1')).map(([t]) => t).sort();
    expect(at).toEqual(['Interview 1 Feedback Due', 'Interview 1 Not Scheduled']);
  });
});
