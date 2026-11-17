import { describe, it, expect } from 'vitest';
import { isSkippableStageGate, apiErrorMessage } from './stageGate.ts';

describe('stageGate', () => {
  it('recognises exactly the two refusals a skip_reason bypasses, by the start of the message', () => {
    expect(isSkippableStageGate('Feedback is still pending for Interview Round 1')).toBe(true);
    expect(isSkippableStageGate('Add at least one reference check before advancing')).toBe(true);
    expect(isSkippableStageGate('HR access required')).toBe(false);
    expect(isSkippableStageGate("This candidate's expected CTC is 15%+ over the role's band — select a reason before shortlisting.")).toBe(false);
    expect(isSkippableStageGate('Not: Feedback is still pending for x')).toBe(false);
    expect(isSkippableStageGate(undefined)).toBe(false);
    expect(isSkippableStageGate('')).toBe(false);
  });
  it('reads the API error text, tolerating anything else', () => {
    expect(apiErrorMessage({ response: { data: { error: 'boom' } } })).toBe('boom');
    expect(apiErrorMessage(new Error('x'))).toBeUndefined();
    expect(apiErrorMessage(null)).toBeUndefined();
  });
});
