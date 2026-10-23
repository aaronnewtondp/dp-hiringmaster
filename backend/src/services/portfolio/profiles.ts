// LIGHT — safe to import from the main API (no browser, no model, no Drive). Decides WHICH portfolio review a
// role gets and the few policy switches that differ between the reviews. roles.portfolio_analysis_enabled is
// still the on/off switch; roles.portfolio_review_kind (default 'design_portfolio') picks the review.
import type { Role } from '../../types/index.js';
import type { PortfolioReviewKind } from './types.js';

export interface ReviewProfile {
  kind: PortfolioReviewKind;
  /** Where the candidate's links come from: the resume's hyperlinks (designer) or the screening answer (marketing). */
  source: 'resume' | 'screening';
  /**
   * What happens to work that cannot be opened. 'legacy' = the designer scores (3 for file/deck-only links, 1 for
   * private or dead ones). 'unscored' = the dimension is simply not applied — the candidate's average is untouched.
   */
  unreachable: 'legacy' | 'unscored';
  /**
   * What happens when there is nothing to review at all (no link, blank/"N/A" answer, text only).
   * 'zero_when_resume_read' = designer: score 0 plus a red flag, but only if the resume could be read.
   */
  noEvidence: 'zero_when_resume_read' | 'unscored';
  /**
   * 'always' folds the score into score_avg / ai_fit_score (R007, and R019 by Aaron's decision).
   * 'upside_only' folds it only when it is at least the candidate's base average, so submitting a weak sample can
   * never rank someone below having submitted nothing. A knob only — nothing uses it today.
   */
  foldPolicy: 'always' | 'upside_only';
}

const PROFILES: Record<PortfolioReviewKind, ReviewProfile> = {
  design_portfolio: { kind: 'design_portfolio', source: 'resume',    unreachable: 'legacy',   noEvidence: 'zero_when_resume_read', foldPolicy: 'always' },
  marketing_work:   { kind: 'marketing_work',   source: 'screening', unreachable: 'unscored', noEvidence: 'unscored',              foldPolicy: 'always' },
};

export function isReviewKind(v: unknown): v is PortfolioReviewKind {
  return v === 'design_portfolio' || v === 'marketing_work';
}

/**
 * The review a role gets, or null when portfolio review is switched off for it. A role without a (valid) kind is
 * a designer role: every role flagged before kinds existed keeps exactly its old behaviour.
 */
export function reviewProfileFor(
  role: Pick<Role, 'portfolio_analysis_enabled' | 'portfolio_review_kind'> | null | undefined,
): ReviewProfile | null {
  if (!role?.portfolio_analysis_enabled) return null;
  return PROFILES[isReviewKind(role.portfolio_review_kind) ? role.portfolio_review_kind : 'design_portfolio'];
}
