import { describe, it, expect } from 'vitest';
import { buildRejectionDraft, isKnownRejectionReason, interpolateRejectionDraft } from './rejectionEmailTemplates.js';
import { REJECTION_REASONS } from '../types/index.ts';

describe('buildRejectionDraft', () => {
  it('never exposes the literal internal reason category in the candidate-facing copy', () => {
    for (const reason of REJECTION_REASONS) {
      const draft = buildRejectionDraft(reason, 'Jane Doe', 'Senior Engineer');
      expect(draft.body.toLowerCase()).not.toContain(reason.toLowerCase());
    }
  });

  it('interpolates the real candidate name and role title for a single-candidate draft', () => {
    const draft = buildRejectionDraft('Compensation mismatch', 'Jane Doe', 'Senior Engineer');
    expect(draft.subject).toContain('Senior Engineer');
    expect(draft.body).toContain('Jane Doe');
    expect(draft.body).toContain('Senior Engineer');
  });

  it('produces a generic fallback opener for an unrecognized reason category', () => {
    const draft = buildRejectionDraft('Some made-up reason', 'Jane Doe', 'Senior Engineer');
    expect(draft.body).toContain("we've decided not to move forward with your application");
  });

  it('passes literal {{tokens}} through untouched for the bulk-flow path', () => {
    const draft = buildRejectionDraft('Cultural / values concern', '{{candidate_name}}', '{{role_title}}');
    expect(draft.body).toContain('{{candidate_name}}');
    expect(draft.subject).toContain('{{role_title}}');
  });
});

describe('buildRejectionDraft with several reasons', () => {
  it('accepts a list, and a one-item list reads exactly like the single reason', () => {
    expect(buildRejectionDraft(['Compensation mismatch'], 'Jane', 'Eng'))
      .toEqual(buildRejectionDraft('Compensation mismatch', 'Jane', 'Eng'));
  });

  it('uses one neutral multi-factor line for several reasons — no single "because X", never the internal categories', () => {
    const two = buildRejectionDraft(['Missing mandatory skill', 'Compensation mismatch'], 'Jane', 'Eng');
    expect(two.body).toContain('several factors');
    for (const reason of REJECTION_REASONS) expect(two.body.toLowerCase()).not.toContain(reason.toLowerCase());
  });

  it('does not let a role-level reason contradict a candidate-level one (no "unrelated to your candidacy" next to a skills gap)', () => {
    const mixed = buildRejectionDraft(['Role cancelled / on hold', 'Missing mandatory skill'], 'Jane', 'Eng');
    expect(mixed.body).not.toContain('unrelated to your candidacy');
  });

  it('falls back to the generic opener for an empty list', () => {
    expect(buildRejectionDraft([], 'Jane', 'Eng').body).toContain("we've decided not to move forward with your application");
  });

  it('is the same neutral text for any pair of reasons (nothing leaks which ones were picked)', () => {
    const a = buildRejectionDraft(['Communication gap', 'Short average tenure'], 'Jane', 'Eng');
    const b = buildRejectionDraft(['Missing mandatory skill', 'Cultural / values concern', 'Compensation mismatch'], 'Jane', 'Eng');
    expect(a).toEqual(b);
  });
});

describe('isKnownRejectionReason', () => {
  it('is true for every real REJECTION_REASONS value', () => {
    for (const reason of REJECTION_REASONS) {
      expect(isKnownRejectionReason(reason)).toBe(true);
    }
  });

  it('is false for an arbitrary string', () => {
    expect(isKnownRejectionReason('Not a real reason')).toBe(false);
  });
});

describe('interpolateRejectionDraft', () => {
  it('fills every occurrence of both tokens', () => {
    const draft = buildRejectionDraft('Compensation mismatch', '{{candidate_name}}', '{{role_title}}');
    const filled = interpolateRejectionDraft(draft, 'Jane Doe', 'Senior Engineer');
    expect(filled.subject).not.toContain('{{role_title}}');
    expect(filled.body).not.toContain('{{candidate_name}}');
    expect(filled.body).toContain('Jane Doe');
    expect(filled.subject).toContain('Senior Engineer');
  });

  it('is a no-op on a draft that never had tokens in it', () => {
    const draft = { subject: 'Fixed subject', body: 'Fixed body, no tokens here.' };
    const filled = interpolateRejectionDraft(draft, 'Jane Doe', 'Senior Engineer');
    expect(filled).toEqual(draft);
  });
});
