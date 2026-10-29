import { describe, it, expect } from 'vitest';
import {
  AGE_COLUMN_INFO, AGING_FLAG_DAYS, AGING_THRESHOLDS_TEXT, AGING_NO_TARGET_INFO, APPLICATION_AGE_INFO, AVERAGE_SCORE_INFO, CTC_COLUMN_INFO,
  DIMENSION_INFO, FIT_COLUMN_INFO, IN_BUDGET_FILTER_INFO, OVER_BUDGET_INFO, PORTFOLIO_COLUMN_INFO, SLA_FLAG_INFO, VERDICT_INFO,
  lastUpdatedInfo, priorityInfo,
} from './columnInfo.ts';
import { OVER_BUDGET_TOLERANCE } from './budget.ts';
import { ownerLabel } from './ownerLabel.ts';

// The shared explanations pin FACTS that the code behind each number decides. Where the frontend has the constant, the
// test reads it, so a changed threshold fails here instead of leaving a stale sentence on screen.

describe('role age', () => {
  it('lists, for every priority, the days past the Close Target at which a role turns yellow and then red', () => {
    // backend/src/types/index.ts AGING_THRESHOLDS (yellow, red): P0 10/23, P1 15/45, P2 30/68, P3 30/90
    expect(AGING_FLAG_DAYS).toEqual({ P0: [10, 23], P1: [15, 45], P2: [30, 68], P3: [30, 90] });
    expect(AGING_THRESHOLDS_TEXT).toBe('10 and 23 days (P0), 15 and 45 days (P1), 30 and 68 days (P2) or 30 and 90 days (P3)');
    expect(AGE_COLUMN_INFO).toContain(`past its Close Target by ${AGING_THRESHOLDS_TEXT}`);
  });

  it('says what happens with no Close Target, which statuses never flag, and that P0 is the most urgent', () => {
    expect(AGE_COLUMN_INFO).toContain('If no Close Target is set, the same numbers are applied to the days it has been open');
    expect(AGE_COLUMN_INFO).toContain('Draft, Under Review, On Hold and Closed roles never flag');
    expect(AGE_COLUMN_INFO).toContain('P0 is the most urgent priority and P3 the least');
    expect(AGE_COLUMN_INFO).not.toContain('Nothing is flagged until the Close Target passes');   // the flag starts days AFTER it
  });

  it('the hover on a flagged role with no Close Target says so, and a priority tag explains P0 to P3', () => {
    expect(AGING_NO_TARGET_INFO).toContain('No Close Target is set');
    expect(AGING_NO_TARGET_INFO).toContain('days it has been open');
    expect(priorityInfo('P2')).toContain('Priority P2');
    expect(priorityInfo('P2')).toContain('P0 is the most urgent, P3 the least');
    expect(priorityInfo('P2')).toContain('only P0 and P1 roles get a default weekly target');       // services/sourcingPlans.ts effectiveTarget
  });
});

describe('Fit, Average Score and Verdict', () => {
  it('Fit is the Average Score x 10, coloured at 75 and 50, and 75 shortens the 48 hour SLA windows to 24', () => {
    expect(FIT_COLUMN_INFO).toContain('from 0 to 100');
    expect(FIT_COLUMN_INFO).toContain('× 10');
    expect(FIT_COLUMN_INFO).toContain('Green is 75 and above, amber 50 to 74, red below 50');       // Badges.tsx FitScore
    expect(FIT_COLUMN_INFO).toContain('shortens the 48 hour SLA windows to 24 hours');             // jobs/slaChecker.ts HIGH_SCORE_THRESHOLD
    expect(FIT_COLUMN_INFO).toContain('Applied and Screened, the interview rounds, Founders Round and Assignment Round');
  });

  it('does not name roles for the Portfolio rating: it is switched on per role by a flag, not by a title', () => {
    expect(FIT_COLUMN_INFO).toContain('Roles that have a portfolio or work-sample review add a ninth rating');
    expect(FIT_COLUMN_INFO).not.toMatch(/Senior UX|Head of Marketing/);
    expect(PORTFOLIO_COLUMN_INFO).not.toMatch(/Senior UX|Head of Marketing/);
  });

  it('Average Score names its scale and the Fit column it becomes; Verdict says it is not derived from the score', () => {
    expect(AVERAGE_SCORE_INFO).toContain('each from 0 to 10');
    expect(AVERAGE_SCORE_INFO).toContain('× 10');
    expect(VERDICT_INFO).toContain('not calculated from the Average Score');
    expect(VERDICT_INFO).toContain('does not change when a Portfolio review is added later');
    expect(DIMENSION_INFO).toContain('8 and above is green, 6 to 7 blue, 4 to 5 amber and below 4 red');   // ScorecardSummary ScoreCell
  });

  it('the Portfolio column marks: running, failed, kept-after-failed-rerun and not-scored', () => {
    expect(PORTFOLIO_COLUMN_INFO).toContain('“…” means the review is running');
    expect(PORTFOLIO_COLUMN_INFO).toContain('“!” means it failed or could not be queued');
    expect(PORTFOLIO_COLUMN_INFO).toContain('a later re-run failed and the earlier score is kept');
    expect(PORTFOLIO_COLUMN_INFO).toContain('a dash means there is no score');
    expect(PORTFOLIO_COLUMN_INFO).toContain('nothing could be scored (hover over the dash for the reason)');
    expect(PORTFOLIO_COLUMN_INFO).toContain('no review has been run for this candidate');   // a never-reviewed row is a dash with no hover
  });
});

describe('compensation', () => {
  it('current CTC is the "fixed and variable breakup" figure, so it can include variable pay (same label as the forms)', () => {
    expect(CTC_COLUMN_INFO).toContain('Current CTC (Fixed and Variable breakup) in LPA');
    expect(CTC_COLUMN_INFO).toContain('can include variable pay');
    expect(CTC_COLUMN_INFO).not.toContain('Current fixed CTC');
  });

  it('Over Budget is any amount above the top of the band; the filter keeps up to 15% over (utils/budget.ts)', () => {
    expect(OVER_BUDGET_INFO).toContain('above the top of the role\'s CTC band');
    expect(OVER_BUDGET_TOLERANCE).toBe(1.15);
    expect(IN_BUDGET_FILTER_INFO).toContain('more than 15% above the top of the role\'s CTC band');
    expect(IN_BUDGET_FILTER_INFO).toContain('with the red Over Budget tag');
    expect(IN_BUDGET_FILTER_INFO).toContain('band or expected CTC is missing');
  });
});

describe('dates and SLA', () => {
  it('both application columns say they show a number of days; Last Updated lists what changes it', () => {
    expect(APPLICATION_AGE_INFO).toContain('number of days, not a date');
    const info = lastUpdatedInfo(false);
    expect(info).toContain('stage, status, screening status, notes, Founder flag or assignment submission');
    expect(info).toContain('Scheduling an interview, submitting feedback and ResumeIQ scoring do not change it on their own');
    expect(info).not.toContain('grey line');
    expect(lastUpdatedInfo(true)).toContain('The grey line under it is the latest logged event, which can be newer');
  });

  it('the SLA tag says what clears it, that putting an application on hold does not, and why the Dashboard number differs', () => {
    expect(SLA_FLAG_INFO).toContain('another stage, an interview is scheduled, feedback is submitted or an assignment is sent');
    expect(SLA_FLAG_INFO).toContain('putting it on hold does not clear it');
    expect(SLA_FLAG_INFO).toContain('counts open overdue tasks instead');
  });
});

describe('owner label', () => {
  it('shows the stored owner "HR / Recruiter" as HR/Admin, and leaves "Hiring Manager" alone', () => {
    expect(ownerLabel('HR / Recruiter')).toBe('HR/Admin');
    expect(ownerLabel('Hiring Manager')).toBe('Hiring Manager');
    expect(ownerLabel('Leadership / Founders')).toBe('Leadership / Founders');
  });
});
