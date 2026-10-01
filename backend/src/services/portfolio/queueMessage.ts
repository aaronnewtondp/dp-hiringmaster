// LIGHT — pure helpers for the portfolio queue message and the "browser is
// busy, try again later" policy. No browser, no database: unit-testable and safe
// to import from anywhere.
import { MAX_ATTEMPTS } from './jobState.js';

/** Application ids look like A0747 / A10140 — anything else is not ours to run. */
export const APPLICATION_ID = /^A\d{1,10}$/;

/**
 * Vercel runs several queue deliveries on one function instance, but this
 * process can only host one Chromium at a time (2 GB, and the /tmp extraction
 * race — see browser.ts). A delivery that arrives while the browser is taken
 * must NOT fail or burn one of its delivery attempts: it is handed back as a
 * brand-new, delayed message and tried again later.
 *
 * A brand-new message restarts the queue's own delivery counter, and that counter
 * (`maxDeliveries` in vercel.json) is what bounds the cost of a HARD-KILLED review —
 * OOM or the 300s limit, where no JS runs to acknowledge or throw. So the deliveries
 * a review has already spent travel in the message (`attemptsUsed`), and the handler
 * works out the true attempt number from both.
 */
/**
 * Hand-backs before giving up. This is a wait budget, not a retry count: it has to
 * outlast a whole backfill draining one review at a time (~150 reviews take ~2h, a few
 * hundred take several), while staying under the queue's 24h message retention.
 * 400 x (60..105s) is ~6.7-11.7h.
 */
export const MAX_BUSY_RETRIES = 400;
/** Base delay before a busy message is tried again; each one adds up to JITTER_SECONDS so a burst doesn't re-collide. */
export const BUSY_RETRY_DELAY_SECONDS = 60;
export const BUSY_RETRY_JITTER_SECONDS = 45;

export interface PortfolioMessage {
  applicationId: string;
  /** How many times this review has already been bounced because the browser was busy. */
  busyRetries: number;
  /** Queue deliveries this review already spent on real attempts (killed or thrown) before being handed back. */
  attemptsUsed: number;
}

function counter(v: unknown, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
  return Math.min(Math.max(n, 0), max);
}

/** Validates an untrusted queue payload; returns null for anything that isn't ours. */
export function parsePortfolioMessage(raw: unknown): PortfolioMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const { applicationId, busyRetries, attemptsUsed } = raw as { applicationId?: unknown; busyRetries?: unknown; attemptsUsed?: unknown };
  if (typeof applicationId !== 'string' || !APPLICATION_ID.test(applicationId)) return null;
  return {
    applicationId,
    busyRetries: counter(busyRetries, MAX_BUSY_RETRIES),
    attemptsUsed: counter(attemptsUsed, MAX_ATTEMPTS),
  };
}

/** The real attempt number of this delivery: earlier spent deliveries plus this one (1-based). */
export function effectiveAttempt(msg: PortfolioMessage, deliveryCount: number | undefined): number {
  return msg.attemptsUsed + Math.max(deliveryCount ?? 1, 1);
}

export type BusyRetryPlan =
  | { action: 'requeue'; busyRetries: number; delaySeconds: number }
  | { action: 'give_up' };

/** What to do with a review that just found the browser busy. `rand` is injectable for tests. */
export function busyRetryPlan(busyRetries: number, rand: () => number = Math.random): BusyRetryPlan {
  if (busyRetries >= MAX_BUSY_RETRIES) return { action: 'give_up' };
  return {
    action: 'requeue',
    busyRetries: busyRetries + 1,
    delaySeconds: BUSY_RETRY_DELAY_SECONDS + Math.floor(rand() * BUSY_RETRY_JITTER_SECONDS),
  };
}
