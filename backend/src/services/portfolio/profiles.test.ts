import { describe, it, expect } from 'vitest';
import { isReviewKind, reviewProfileFor } from './profiles.js';

describe('reviewProfileFor — which review a role gets', () => {
  it('is null when portfolio review is off, whatever the kind says', () => {
    expect(reviewProfileFor(null)).toBeNull();
    expect(reviewProfileFor(undefined)).toBeNull();
    expect(reviewProfileFor({})).toBeNull();
    expect(reviewProfileFor({ portfolio_analysis_enabled: false })).toBeNull();
    expect(reviewProfileFor({ portfolio_analysis_enabled: false, portfolio_review_kind: 'marketing_work' })).toBeNull();
  });

  it('gives a flagged role with no kind the designer review (every role flagged before kinds existed)', () => {
    const p = reviewProfileFor({ portfolio_analysis_enabled: true });
    expect(p?.kind).toBe('design_portfolio');
    expect(reviewProfileFor({ portfolio_analysis_enabled: true, portfolio_review_kind: 'design_portfolio' })).toBe(p);
  });

  it('falls back to the designer review for a kind it does not know, rather than breaking the role', () => {
    const bogus = { portfolio_analysis_enabled: true, portfolio_review_kind: 'astrology' } as unknown as Parameters<typeof reviewProfileFor>[0];
    expect(reviewProfileFor(bogus)?.kind).toBe('design_portfolio');
    const nul = { portfolio_analysis_enabled: true, portfolio_review_kind: null } as unknown as Parameters<typeof reviewProfileFor>[0];
    expect(reviewProfileFor(nul)?.kind).toBe('design_portfolio');
  });

  it('designer: links come from the resume; unreachable work and no evidence keep the legacy scoring', () => {
    expect(reviewProfileFor({ portfolio_analysis_enabled: true })).toEqual({
      kind: 'design_portfolio', source: 'resume', unreachable: 'legacy', noEvidence: 'zero_when_resume_read', foldPolicy: 'always',
    });
  });

  it('marketing: links come from the screening answer; unreachable work and no evidence are never scored (Aaron, 2026-10-22)', () => {
    expect(reviewProfileFor({ portfolio_analysis_enabled: true, portfolio_review_kind: 'marketing_work' })).toEqual({
      kind: 'marketing_work', source: 'screening', unreachable: 'unscored', noEvidence: 'unscored', foldPolicy: 'always',
    });
  });
});

describe('isReviewKind', () => {
  it('accepts exactly the two kinds the database CHECK allows', () => {
    expect(isReviewKind('design_portfolio')).toBe(true);
    expect(isReviewKind('marketing_work')).toBe(true);
    for (const v of ['', 'design', 'marketing', 'Marketing_Work', null, undefined, 7, {}]) expect(isReviewKind(v)).toBe(false);
  });
});
