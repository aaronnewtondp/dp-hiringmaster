import { describe, it, expect } from 'vitest';
import {
  BUSY_RETRY_DELAY_SECONDS, BUSY_RETRY_JITTER_SECONDS, MAX_BUSY_RETRIES,
  busyRetryPlan, parsePortfolioMessage,
} from './queueMessage.js';

describe('parsePortfolioMessage', () => {
  it('accepts a plain { applicationId } message (the shape every first send uses)', () => {
    expect(parsePortfolioMessage({ applicationId: 'A0611' })).toEqual({ applicationId: 'A0611', busyRetries: 0 });
  });

  it('carries the busy counter of a handed-back message', () => {
    expect(parsePortfolioMessage({ applicationId: 'A10384', busyRetries: 7 })).toEqual({ applicationId: 'A10384', busyRetries: 7 });
  });

  it('rejects anything that is not a valid application id', () => {
    for (const bad of [null, undefined, 'A0611', 42, [], {}, { applicationId: 'a0611' }, { applicationId: 'A' }, { applicationId: 'A0611; DROP' }, { applicationId: 'A12345678901' }, { applicationId: 611 }]) {
      expect(parsePortfolioMessage(bad)).toBeNull();
    }
  });

  it('never trusts the counter: junk becomes 0, negatives and fractions are clamped, and it cannot exceed the cap', () => {
    const id = { applicationId: 'A0001' };
    expect(parsePortfolioMessage({ ...id, busyRetries: 'many' })!.busyRetries).toBe(0);
    expect(parsePortfolioMessage({ ...id, busyRetries: NaN })!.busyRetries).toBe(0);
    expect(parsePortfolioMessage({ ...id, busyRetries: Infinity })!.busyRetries).toBe(0);
    expect(parsePortfolioMessage({ ...id, busyRetries: -5 })!.busyRetries).toBe(0);
    expect(parsePortfolioMessage({ ...id, busyRetries: 3.9 })!.busyRetries).toBe(3);
    expect(parsePortfolioMessage({ ...id, busyRetries: 10_000 })!.busyRetries).toBe(MAX_BUSY_RETRIES);
  });
});

describe('busyRetryPlan', () => {
  it('requeues with the counter advanced by one', () => {
    const plan = busyRetryPlan(0, () => 0);
    expect(plan).toEqual({ action: 'requeue', busyRetries: 1, delaySeconds: BUSY_RETRY_DELAY_SECONDS });
  });

  it('spreads retries with jitter so a burst of busy reviews does not re-collide', () => {
    const lo = busyRetryPlan(3, () => 0);
    const hi = busyRetryPlan(3, () => 0.999999);
    expect(lo.action === 'requeue' && lo.delaySeconds).toBe(BUSY_RETRY_DELAY_SECONDS);
    expect(hi.action === 'requeue' && hi.delaySeconds).toBe(BUSY_RETRY_DELAY_SECONDS + BUSY_RETRY_JITTER_SECONDS - 1);
  });

  it('keeps requeuing right up to the cap, then gives up', () => {
    expect(busyRetryPlan(MAX_BUSY_RETRIES - 1).action).toBe('requeue');
    expect(busyRetryPlan(MAX_BUSY_RETRIES).action).toBe('give_up');
    expect(busyRetryPlan(MAX_BUSY_RETRIES + 50).action).toBe('give_up');
  });

  it('the cap is long enough to outlast a backfill but still bounded (roughly 2 hours of waiting)', () => {
    const worstCaseSeconds = MAX_BUSY_RETRIES * (BUSY_RETRY_DELAY_SECONDS + BUSY_RETRY_JITTER_SECONDS);
    expect(worstCaseSeconds).toBeGreaterThan(90 * 60);
    expect(worstCaseSeconds).toBeLessThan(4 * 3600);
  });
});
