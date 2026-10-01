import { describe, it, expect } from 'vitest';
import {
  BUSY_RETRY_DELAY_SECONDS, BUSY_RETRY_JITTER_SECONDS, MAX_BUSY_RETRIES,
  busyRetryPlan, effectiveAttempt, parsePortfolioMessage,
} from './queueMessage.js';
import { MAX_ATTEMPTS } from './jobState.js';

describe('parsePortfolioMessage', () => {
  it('accepts a plain { applicationId } message (the shape every first send uses)', () => {
    expect(parsePortfolioMessage({ applicationId: 'A0611' })).toEqual({ applicationId: 'A0611', busyRetries: 0, attemptsUsed: 0 });
  });

  it('carries the busy counter of a handed-back message', () => {
    expect(parsePortfolioMessage({ applicationId: 'A10384', busyRetries: 7, attemptsUsed: 1 })).toEqual({ applicationId: 'A10384', busyRetries: 7, attemptsUsed: 1 });
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

  it('applies the same distrust to the spent-attempts counter, capped at the attempt budget', () => {
    const id = { applicationId: 'A0001' };
    expect(parsePortfolioMessage({ ...id, attemptsUsed: 'x' })!.attemptsUsed).toBe(0);
    expect(parsePortfolioMessage({ ...id, attemptsUsed: -2 })!.attemptsUsed).toBe(0);
    expect(parsePortfolioMessage({ ...id, attemptsUsed: 1.7 })!.attemptsUsed).toBe(1);
    expect(parsePortfolioMessage({ ...id, attemptsUsed: 99 })!.attemptsUsed).toBe(MAX_ATTEMPTS);
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

  it('the wait budget outlasts a large backfill (several hours) but stays inside the queue\'s 24h message retention', () => {
    const shortest = MAX_BUSY_RETRIES * BUSY_RETRY_DELAY_SECONDS;
    const longest = MAX_BUSY_RETRIES * (BUSY_RETRY_DELAY_SECONDS + BUSY_RETRY_JITTER_SECONDS);
    expect(shortest).toBeGreaterThan(6 * 3600);     // a few hundred reviews, one at a time, still fit
    expect(longest).toBeLessThan(24 * 3600);        // a message can never outlive its retention
  });
});

describe('effectiveAttempt', () => {
  it('is the deliveries spent before a hand-back plus the current delivery', () => {
    expect(effectiveAttempt({ applicationId: 'A1', busyRetries: 0, attemptsUsed: 0 }, 1)).toBe(1);
    expect(effectiveAttempt({ applicationId: 'A1', busyRetries: 4, attemptsUsed: 1 }, 1)).toBe(2);
    expect(effectiveAttempt({ applicationId: 'A1', busyRetries: 4, attemptsUsed: 1 }, 2)).toBe(3);
  });
  it('treats a missing or nonsensical delivery count as the first delivery', () => {
    expect(effectiveAttempt({ applicationId: 'A1', busyRetries: 0, attemptsUsed: 0 }, undefined)).toBe(1);
    expect(effectiveAttempt({ applicationId: 'A1', busyRetries: 0, attemptsUsed: 0 }, 0)).toBe(1);
  });
});
