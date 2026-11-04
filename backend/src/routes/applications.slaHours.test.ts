import { describe, it, expect, vi } from 'vitest';

// getSlaHours(stage, fitScore) is the value stored in applications.sla_hours whenever an application enters a stage (stage moves, interview scheduling,
// ingestion). It is NOT what the SLA engine chases: slaChecker.ts has its own thresholds (see slaChecker.tables.test.ts). This file pins what is stored
// today, stage by stage, so a change to the table or to the stage names shows up as one named test. Only the pure function is exercised: every module the
// route file imports that could reach a database, a model or a mailbox is replaced.
vi.mock('../db/index.js', () => ({ query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn(), pool: {} }));
vi.mock('../services/resumeIQTrigger.js', () => ({ runResumeIQScoring: vi.fn() }));
vi.mock('../services/gmailService.js', () => ({ sendAssignmentEmail: vi.fn() }));

import { getSlaHours } from './applications.js';
import { SLA_HOURS, STAGE_ORDER } from '../types/index.js';
import { BREACH_IDLE_HOURS } from '../jobs/slaChecker.js';

describe('getSlaHours: the hours stored for an application entering a stage', () => {
  it.each([
    ['Applied and Screened', 48],
    ['Interview Round 1', 48],
    ['Interview Round 2', 48],
    ['Founders Round', 48],
    ['Reference Check', 48],
    ['Offer Released', 48],
    ['Assignment Round', 72],            // falls through to the idle value: ASSIGNMENT_SEND / ASSIGNMENT_EVALUATE are not used here
    ['Pre-Joining Documents', 72],
    ['Offer Discussion', 72],
    ['Offer Accepted', 72],
    ['Joined', 72],
  ])('%s is stored as %s hours', (stage, hours) => {
    expect(getSlaHours(stage)).toBe(hours);
  });

  it('every pipeline stage has a stored value, and the table above covers all eleven', () => {
    expect(STAGE_ORDER).toHaveLength(11);
    for (const stage of STAGE_ORDER) expect(Object.values(SLA_HOURS)).toContain(getSlaHours(stage));
  });

  it('a stage that matches nothing (an unknown or retired name) is the idle value', () => {
    for (const stage of ['', 'Resume Review', 'Shortlisted', 'Applied', 'Offer Declined']) expect(getSlaHours(stage)).toBe(SLA_HOURS.IDLE);
  });

  it('any stage name that STARTS with "Interview" is an interview round (the old "Interview – Round 3" naming included)', () => {
    expect(getSlaHours('Interview – Round 3')).toBe(SLA_HOURS.INTERVIEW_FEEDBACK);
    expect(getSlaHours('Interview')).toBe(SLA_HOURS.INTERVIEW_FEEDBACK);
    expect(getSlaHours('Pre-Interview')).toBe(SLA_HOURS.IDLE);       // only a prefix counts
  });

  it.each([[null], [undefined], [0], [10], [74], [74.9], [75], [80], [100]])('a fit score of %j does not change the Applied and Screened value today (high-fit and normal are both 48)', score => {
    expect(getSlaHours('Applied and Screened', score)).toBe(48);
    expect(SLA_HOURS.RESUME_REVIEW_HIGH_FIT).toBe(SLA_HOURS.RESUME_REVIEW_NORMAL);
  });

  it('the fit score is ignored at every other stage', () => {
    for (const stage of STAGE_ORDER.filter(s => s !== 'Applied and Screened')) expect(getSlaHours(stage, 99)).toBe(getSlaHours(stage, null));
  });

  it('KNOWN DIVERGENCE (pinned so a change is deliberate): the stored idle value is 72h while the engine\'s Idle Candidate breach is 48h', () => {
    expect(SLA_HOURS.IDLE).toBe(72);
    expect(getSlaHours('Offer Discussion')).toBe(72);
    expect(BREACH_IDLE_HOURS).toBe(48);
    expect(getSlaHours('Offer Discussion')).not.toBe(BREACH_IDLE_HOURS);
  });
});
