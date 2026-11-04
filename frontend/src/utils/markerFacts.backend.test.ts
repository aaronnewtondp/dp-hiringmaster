import { describe, it, expect } from 'vitest';
import {
  AGE_COLUMN_INFO, AGING_FLAG_DAYS, AGING_THRESHOLDS_TEXT, DASHBOARD_REFRESH_MINUTES, DASHBOARD_REFRESH_MS, FIT_COLUMN_INFO, IN_BUDGET_FILTER_INFO,
  NO_MOVEMENT_DAYS, OVER_BUDGET_TOLERANCE_PERCENT, SESSION_HOURS, SLA_ASSIGNMENT_DEADLINE_HOURS, SLA_ASSIGNMENT_FEEDBACK_HOURS,
  SLA_CHECK_THROTTLE_MINUTES, SLA_ESCALATION_HOURS, SLA_HIGH_SCORE_FIT, SLA_HIGH_SCORE_HOURS, SLA_JOINING_RISK_DAYS, SLA_STANDARD_HOURS, SOURCING_ON_TIME_DAYS,
} from './columnInfo.ts';
import { OVER_BUDGET_TOLERANCE } from './budget.ts';
import { LOW_PIPELINE_MAX_ACTIVE, LOW_PIPELINE_MAX_SHORTLISTED } from '../types/index.ts';
import { agingPhrase, backendFacts, numberConst, overBudgetPercent, readRepoFile, slice } from '../test/backendSource.ts';

// The info markers quote numbers that the backend decides. This file reads the backend's SOURCE (src/test/backendSource.ts)
// and checks every figure a marker states against it, so a change to a backend constant turns a test red here instead of
// leaving a stale number on screen. The sentences themselves are checked in columnInfo.test.ts and the page tests; they build
// their expected text from `backendFacts()`, never from digits typed into the test.
const b = backendFacts();

describe('the guard really reads the backend', () => {
  it('found every figure, as a real number', () => {
    for (const [name, value] of Object.entries(b)) {
      if (typeof value === 'number') expect(Number.isFinite(value) && value > 0, `${name} = ${value}`).toBe(true);
    }
    expect(Object.keys(b.aging)).toEqual(['P0', 'P1', 'P2', 'P3']);
    for (const [, [yellow, red]] of Object.entries(b.aging)) expect(red).toBeGreaterThan(yellow);
  });

  it('refuses to check nothing when a declaration cannot be found', () => {
    expect(() => numberConst('x.ts', 'const OTHER = 3;', 'BREACH_STANDARD_HOURS')).toThrow(/could not find/);
    // a table is not a number: this must not read "Record<...> = {" as a figure
    expect(() => numberConst('x.ts', 'export const AGING: Record<string, number> = { P0: 1 };', 'AGING')).toThrow(/could not find/);
    expect(() => slice('x.ts', 'nothing here', /export function nope/, /\n\}/)).toThrow(/could not find/);
    expect(() => readRepoFile('backend/src/does-not-exist.ts')).toThrow(/needs the whole repository/);
  });

  it('reads a product of numbers, as in SLA_CHECK_THROTTLE_MS = 3 * 60 * 1000', () => {
    expect(numberConst('x.ts', 'const SLA_CHECK_THROTTLE_MS = 3 * 60 * 1000; // 3 minutes', 'SLA_CHECK_THROTTLE_MS')).toBe(180_000);
    expect(numberConst('x.ts', 'export const OVER_BUDGET_TOLERANCE = 1.15;', 'OVER_BUDGET_TOLERANCE')).toBe(1.15);
  });
});

describe('role age: the frontend table is the backend AGING_THRESHOLDS', () => {
  it('has the same yellow and red days for every priority', () => {
    expect(AGING_FLAG_DAYS).toEqual(b.aging);
  });
  it('a role turns yellow or red AT the threshold, so "past its Close Target by N days" is right', () => {
    expect(b.agingStartsAtThreshold).toBe(true);
  });
  it('the sentences list the backend numbers', () => {
    expect(AGING_THRESHOLDS_TEXT).toBe(agingPhrase(b));
    expect(AGE_COLUMN_INFO).toContain(`past its Close Target by ${agingPhrase(b)}`);
  });
  it('the red ! on an Aging role fires after MORE than the backend number of days, so the text says "more than"', () => {
    expect(NO_MOVEMENT_DAYS).toBe(b.noMovementDays);
    expect(b.noMovementIsStrict).toBe(true);
  });
});

describe('SLA windows: the frontend figures are the ones in jobs/slaChecker.ts', () => {
  it('the standard window is 48h, for Idle Candidate as well as the five tiered stages', () => {
    expect(SLA_STANDARD_HOURS).toBe(b.slaStandardHours);
    expect(b.slaIdleHours, 'Idle Candidate has its own constant: if it differs the marker needs a second figure').toBe(b.slaStandardHours);
  });
  it('a Fit score at or above the threshold shortens it', () => {
    expect(SLA_HIGH_SCORE_FIT).toBe(b.slaHighScoreFit);
    expect(SLA_HIGH_SCORE_HOURS).toBe(b.slaHighScoreHours);
    expect(b.slaHighScoreAtOrAbove, 'the markers say "75 or more" and "≥75"').toBe(true);
  });
  it('Assignment Feedback Due and the Leadership escalation are both 96h, from different constants', () => {
    expect(SLA_ASSIGNMENT_FEEDBACK_HOURS).toBe(b.slaAssignmentFeedbackHours);
    expect(SLA_ESCALATION_HOURS).toBe(b.slaEscalationHours);
  });
  it('the assignment deadline is the send time plus the backend number of hours', () => {
    expect(SLA_ASSIGNMENT_DEADLINE_HOURS).toBe(b.slaAssignmentDeadlineHours);
  });
  it('joining risk is the backend number of days, and its task is stored as that many days of hours (the card reads "Overdue 5D")', () => {
    expect(SLA_JOINING_RISK_DAYS).toBe(b.joiningRiskDays);
    expect(b.joiningRiskStoredHours).toBe(b.joiningRiskDays * 24);
  });
  it('the SLA sweep runs at most once per the backend number of minutes', () => {
    expect(SLA_CHECK_THROTTLE_MINUTES).toBe(b.slaCheckThrottleMinutes);
  });
  it('the Fit sentence quotes the backend figures', () => {
    expect(FIT_COLUMN_INFO).toContain(`A score of ${b.slaHighScoreFit} or more also shortens the ${b.slaStandardHours} hour SLA windows to ${b.slaHighScoreHours} hours`);
  });
});

describe('compensation: the 15% is the backend tolerance', () => {
  it('both packages use the same multiplier', () => {
    expect(OVER_BUDGET_TOLERANCE).toBe(b.overBudgetTolerance);
  });
  it('a candidate exactly at the line already needs a reason to be shortlisted, so the text says "15% or more"', () => {
    expect(b.severeOverBudgetAtOrAbove).toBe(true);
  });
  it('and the markers write it as a percentage', () => {
    expect(OVER_BUDGET_TOLERANCE_PERCENT).toBe(overBudgetPercent(b));
    expect(IN_BUDGET_FILTER_INFO).toContain(`more than ${overBudgetPercent(b)}% above the top of the role's CTC band`);
    expect(IN_BUDGET_FILTER_INFO).toContain(`up to ${overBudgetPercent(b)}% still show`);
  });
});

describe('other figures the markers quote', () => {
  it('a sign-in lasts the backend default number of hours, which User Management says about deactivated people', () => {
    expect(SESSION_HOURS).toBe(b.sessionHours);
  });
  it('the Sourcing tile\'s "done on time" window is the number of days the backend counts', () => {
    expect(SOURCING_ON_TIME_DAYS).toBe(b.sourcingDoneWindowDays);
  });
  it('Low pipeline roles: the frontend thresholds are the backend ones', () => {
    expect(LOW_PIPELINE_MAX_SHORTLISTED).toBe(b.lowPipelineMaxShortlisted);
    expect(LOW_PIPELINE_MAX_ACTIVE).toBe(b.lowPipelineMaxActive);
  });
  it('the Active candidates tile counts the fit-score bands the tile labels name', () => {
    // Dashboard.markers.test.tsx checks the labels and the marker against these two numbers
    expect(b.fitHighCount).toBeGreaterThan(b.fitLowCount);
  });
});

describe('how often the Dashboard refreshes', () => {
  const REFRESHING = [
    'frontend/src/pages/Dashboard.tsx',
    'frontend/src/components/shared/SlaBreachesByRole.tsx',
    'frontend/src/components/sourcing/SourcingExecution.tsx',
  ];
  it.each(REFRESHING)('%s refetches on the shared interval', rel => {
    expect(readRepoFile(rel), `${rel} must use refetchInterval: DASHBOARD_REFRESH_MS`).toMatch(/refetchInterval:\s*DASHBOARD_REFRESH_MS\b/);
  });

  it('the Hiring Funnel Snapshot does not, which is why the Dashboard subtitle names it as the exception', () => {
    expect(
      readRepoFile('frontend/src/components/shared/HiringFunnelSnapshot.tsx'),
      'it now refreshes by itself: delete "except the Hiring Funnel Snapshot..." from the Dashboard subtitle and from this test',
    ).not.toMatch(/refetchInterval/);
  });

  it('the interval is the number of minutes the subtitle says', () => {
    expect(DASHBOARD_REFRESH_MS).toBe(DASHBOARD_REFRESH_MINUTES * 60 * 1000);
  });
});
