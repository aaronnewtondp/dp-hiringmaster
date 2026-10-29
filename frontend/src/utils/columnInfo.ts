// Explanations that more than one screen shows, kept in ONE place so the markers can never drift apart. Each text
// says exactly what the number counts; the fact behind every sentence is named next to it (backend paths are
// relative to backend/src). When one of these facts changes in the code, change the sentence here — the unit test
// in columnInfo.test.ts pins the facts, not the exact words.

// ─── Gender ───────────────────────────────────────────────────────────────────
// One explanation for the Gender column, shared by the three independent candidate tables (Active Candidates, Archived
// Pipeline, Ready for Review) so the three info markers can never drift apart. Facts: backend/src/utils/genderClassifier.ts
// (auto-tag at creation, NULL = unknown on purpose) and the absence of any screen that edits the field.
export const GENDER_COLUMN_INFO =
  "M or F, worked out automatically from the candidate's name when they were added: a best guess, not a verified fact. A " +
  "dash means Unknown: an unrecognised or genuinely unisex name is left untagged on purpose rather than guessed. It can't " +
  "be edited from these screens; the Gender filter's \"Not tagged\" option finds the dashes.";

// ─── Fit / Average Score ─────────────────────────────────────────────────────
// The same ResumeIQ result is shown on two scales: Average Score (0-10, Ready for Review and the candidate page) and
// Fit (0-100) = Average Score x 10, rounded (services/resumeIQTrigger.ts: ai_fit_score = round(avg * 10)). Colours of
// Fit: components/shared/Badges.tsx FitScore (green 75+, amber 50-74, red below 50). The 75 line is
// jobs/slaChecker.ts HIGH_SCORE_THRESHOLD: it shortens the 48 hour windows to 24 hours at Applied and Screened,
// Interview Round 1 and 2, Founders Round and Assignment Round. The Portfolio rating is folded into the average
// whenever its review gives it a score (services/portfolio/scoring.ts); a review that ends without a score leaves it out.
export const FIT_COLUMN_INFO =
  "ResumeIQ's score for this application, from 0 to 100: the Average Score (the mean of its 8 ratings out of 10: Technical, " +
  "Experience, Industry Fit, Culture Fit, Role Alignment, Trajectory, Leadership and Communication) × 10. Roles that have a " +
  "portfolio or work-sample review add a ninth rating, Portfolio, once that review finishes; it counts whenever the review " +
  "gives it a score, and when a review ends without one the average is the 8 ratings alone. Green is 75 and above, amber " +
  "50 to 74, red below 50. Scored automatically when the candidate applies. A score of 75 or more also shortens the 48 hour " +
  "SLA windows to 24 hours at Applied and Screened, the interview rounds, Founders Round and Assignment Round.";

export const AVERAGE_SCORE_INFO =
  "ResumeIQ's mean of its 8 ratings, each from 0 to 10, plus the Portfolio rating for roles that have a portfolio or " +
  "work-sample review. The Fit column on Active Candidates and Archived Pipeline is this number × 10.";

export const VERDICT_INFO =
  "ResumeIQ's own recommendation (Strong Yes, Yes, Maybe or No), given when it read the resume. It is not calculated from " +
  "the Average Score, and it does not change when a Portfolio review is added later, so the two can disagree.";

export const DIMENSION_INFO =
  "One of ResumeIQ's eight ratings of this resume against the role, from 0 to 10. 8 and above is green, 6 to 7 blue, " +
  "4 to 5 amber and below 4 red; a dash means it was not scored.";

export const PORTFOLIO_COLUMN_INFO =
  "A ninth rating, only for roles that have a portfolio or work-sample review. It is included in the Average Score " +
  "whenever the review gives it a score. “…” means the review is running, “!” means it failed or could not be queued, a " +
  "red dot means a later re-run failed and the earlier score is kept, and a dash means there is no score: either nothing " +
  "could be scored (hover over the dash for the reason) or no review has been run for this candidate.";

// ─── Profile columns the three candidate tables share ────────────────────────
// candidates.notice_period_days and candidates.current_company / current_industry: profile fields, one value per candidate
// (the same on each of their rows). Notice period is a number of days (the cell shows "30d").
export const NOTICE_PERIOD_INFO = "Notice period in days, from the candidate's profile (one figure per candidate, the same on each of their rows).";
// applications.stage is changed by a stage move only: the status route (routes/applications.ts) touches status, so an
// application put on hold, rejected or withdrawn keeps the stage it was left at. (Archived Pipeline words the same fact in the
// past tense, because every row there has already been put aside.)
export const STAGE_COLUMN_INFO =
  "The pipeline stage this application is at. Putting it on hold, rejecting or withdrawing it changes its status, not its stage, so it stays where it was left.";
export const COMPANY_INDUSTRY_INFO = "Current company and industry from the candidate's own profile, shown as one field.";

// ─── CTC ─────────────────────────────────────────────────────────────────────
// candidates.current_ctc_fixed is filled from the application form's "Current CTC (Fixed and Variable breakup) in LPA"
// answer (and typed in under that same label on Add candidate and the candidate page), so it can include variable pay.
export const CTC_COLUMN_INFO =
  "Current CTC → expected CTC in ₹ lakhs per year, from the candidate's own profile (one figure per candidate, not per " +
  "role). The current figure is what was entered for “Current CTC (Fixed and Variable breakup) in LPA”, so it can include " +
  "variable pay.";

// Over Budget = expected CTC above the top number of the role's CTC band (utils/budget.ts isOverBudget).
export const OVER_BUDGET_INFO =
  "“Over Budget” means the expected CTC is above the top of the role's CTC band. A dash means not recorded or hidden: a " +
  "Hiring Manager sees compensation only on their own roles.";

// The In-budget only filter is more lenient than the badge (utils/budget.ts isWithinBudgetOrNear: expected <= band top x 1.15,
// and true when the band or the expected CTC is missing or unreadable).
export const IN_BUDGET_FILTER_INFO =
  "Hides candidates whose expected CTC is more than 15% above the top of the role's CTC band. Candidates between 0% and 15% " +
  "over still show, with the red Over Budget tag, and so do candidates whose band or expected CTC is missing.";

// ─── Dates ───────────────────────────────────────────────────────────────────
// Both tables show the number of days since applying (not a date): application_date.
export const APPLICATION_AGE_INFO = "Days since the candidate applied. It shows a number of days, not a date.";

// applications.last_updated is written by a stage change (including feedback that moves the candidate on), a status
// change, the screening status, the HR notes, the Founder flag and an assignment submission (routes/applications.ts,
// routes/interviews.ts). Scheduling an interview, submitting feedback and ResumeIQ scoring do not write it.
// Active Candidates also shows the latest activity-log line under it (applications.ts last_activity_detail).
export function lastUpdatedInfo(withLatestEvent: boolean): string {
  return "When this application's stage, status, screening status, notes, Founder flag or assignment submission last " +
    "changed. Scheduling an interview, submitting feedback and ResumeIQ scoring do not change it on their own (feedback " +
    "that moves the candidate on to the next stage does)." +
    (withLatestEvent ? " The grey line under it is the latest logged event, which can be newer." : "");
}

// ─── SLA ─────────────────────────────────────────────────────────────────────
// applications.sla_breach is set by the stage-SLA sweep (jobs/slaChecker.ts applyBreachBatch) and cleared by a stage change,
// scheduling an interview, submitting feedback or sending an assignment. A status change does NOT clear it. The
// assignment-deadline and joining-risk checks never set it. The Dashboard counts open breach tasks (pending_actions).
export const SLA_FLAG_INFO =
  "Marked when HMS finds the application past one of its time limits (SLA). The mark stays until the application moves to " +
  "another stage, an interview is scheduled, feedback is submitted or an assignment is sent; putting it on hold does not " +
  "clear it. The Dashboard's SLA breaches counts open overdue tasks instead, so the two numbers can differ.";

// ─── Role age and priority ───────────────────────────────────────────────────
// Mirrors backend/src/types/index.ts AGING_THRESHOLDS: [yellow, red] = days past the Close Target (or, with no target,
// days open) at which an Approved or Live – Sourcing role turns yellow and red (utils/aging.ts computeAging).
export const AGING_FLAG_DAYS: Record<'P0' | 'P1' | 'P2' | 'P3', readonly [number, number]> = {
  P0: [10, 23], P1: [15, 45], P2: [30, 68], P3: [30, 90],
};
const agingList = Object.entries(AGING_FLAG_DAYS).map(([p, [y, r]]) => `${y} and ${r} days (${p})`);
export const AGING_THRESHOLDS_TEXT = `${agingList.slice(0, -1).join(', ')} or ${agingList[agingList.length - 1]}`;

export const AGE_COLUMN_INFO =
  `Days the role has been open. An Approved or Live – Sourcing role turns yellow, then red, once it is past its Close Target by ${AGING_THRESHOLDS_TEXT}. ` +
  "If no Close Target is set, the same numbers are applied to the days it has been open. Draft, Under Review, On Hold and " +
  "Closed roles never flag. P0 is the most urgent priority and P3 the least.";

// Hover on a priority tag. Facts: AGING_FLAG_DAYS above; the Sourcing module gives a default weekly target of qualified
// candidates only to P0 and P1 roles (services/sourcingPlans.ts effectiveTarget).
export function priorityInfo(priority: string): string {
  return `Priority ${priority}. P0 is the most urgent, P3 the least. Priority sets how far past its Close Target an open role ` +
    "can run before it is flagged (see Age on the Roles page). In Sourcing, only P0 and P1 roles get a default weekly target.";
}

// Hover on the Age badge of a role that is flagged but has no Close Target (computeAging then reports 0 days over).
export const AGING_NO_TARGET_INFO =
  "No Close Target is set for this role, so it is flagged on the days it has been open. Set a Close Target in the role's Dates section.";
