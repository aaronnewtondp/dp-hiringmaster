// LIGHT — pure helpers for the portfolio queue message and the "browser is
// busy, try again later" policy. No browser, no database: unit-testable and safe
// to import from anywhere.

/** Application ids look like A0747 / A10140 — anything else is not ours to run. */
export const APPLICATION_ID = /^A\d{1,10}$/;

/**
 * Vercel runs several queue deliveries on one function instance, but this
 * process can only host one Chromium at a time (2 GB, and the /tmp extraction
 * race — see browser.ts). A delivery that arrives while the browser is taken
 * must NOT fail or burn one of its three delivery attempts: it is handed back
 * as a brand-new, delayed message and tried again later. The counter rides in
 * the message so this can be bounded without touching the queue's own
 * redelivery cap (`maxDeliveries` in vercel.json, which exists to bound the
 * cost of a hard-killed review and must stay small).
 */
export const MAX_BUSY_RETRIES = 90;
/** Base delay before a busy message is tried again; each one adds up to JITTER_SECONDS so a burst doesn't re-collide. */
export const BUSY_RETRY_DELAY_SECONDS = 60;
export const BUSY_RETRY_JITTER_SECONDS = 45;

export interface PortfolioMessage {
  applicationId: string;
  /** How many times this review has already been bounced because the browser was busy. */
  busyRetries: number;
}

/** Validates an untrusted queue payload; returns null for anything that isn't ours. */
export function parsePortfolioMessage(raw: unknown): PortfolioMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const { applicationId, busyRetries } = raw as { applicationId?: unknown; busyRetries?: unknown };
  if (typeof applicationId !== 'string' || !APPLICATION_ID.test(applicationId)) return null;
  const n = typeof busyRetries === 'number' && Number.isFinite(busyRetries) ? Math.floor(busyRetries) : 0;
  return { applicationId, busyRetries: Math.min(Math.max(n, 0), MAX_BUSY_RETRIES) };
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
