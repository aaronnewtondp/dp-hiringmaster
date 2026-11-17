import { describe, it, expect } from 'vitest';
import { canSubmitRoundFeedback } from './feedbackAccess.ts';

const user = (persona: string, email = 'a@example.test') => ({ persona, email });

describe('canSubmitRoundFeedback (mirror of PATCH /interviews/:id/feedback)', () => {
  it.each(['hr_recruiter', 'leadership', 'super_admin'])('%s may on any round, listed or not', persona => {
    expect(canSubmitRoundFeedback(user(persona), { interviewer_emails: ['x@example.test'] })).toBe(true);
    expect(canSubmitRoundFeedback(user(persona), {})).toBe(true);
  });
  it('a Hiring Manager may only when listed, ignoring letter case', () => {
    expect(canSubmitRoundFeedback(user('hiring_manager', 'A@Example.test'), { interviewer_emails: ['b@example.test', 'a@EXAMPLE.test'] })).toBe(true);
    expect(canSubmitRoundFeedback(user('hiring_manager'), { interviewer_emails: ['b@example.test'] })).toBe(false);
  });
  it('a round nobody was assigned to is open to every persona', () => {
    for (const emails of [undefined, null, []]) expect(canSubmitRoundFeedback(user('hiring_manager'), { interviewer_emails: emails })).toBe(true);
  });
  it('a missing user is never offered it', () => {
    expect(canSubmitRoundFeedback(null, {})).toBe(false);
    expect(canSubmitRoundFeedback(undefined, {})).toBe(false);
  });
});
