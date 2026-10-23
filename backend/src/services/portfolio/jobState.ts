// LIGHT — imported by both the worker (run.ts) and the main API's re-run route,
// so the definition of "this job is dead" lives in exactly one place.

/**
 * A row in 'running' longer than this is treated as dead. It must exceed the
 * worker function's 300s hard limit (so a live job is never reclaimed) but stay
 * BELOW the queue's visibility timeout (330s) so that the redelivered message
 * can actually reclaim a job whose function was killed.
 */
export const STALE_RUNNING_SECONDS = 310;

/**
 * Deliveries (counting ones spent before a hand-back, see queueMessage.ts) after which a
 * transient failure is recorded as 'failed' instead of retried. Matches `maxDeliveries` in
 * vercel.json and the retry hook in api/portfolio-worker.ts.
 */
export const MAX_ATTEMPTS = 3;

/**
 * Wall-clock budget for the whole job. The function limit is 300s; browser and fetch work gets what's left after
 * reserving time for the model call and DB writes. Here (not in run.ts) so run.ts and run.marketing.ts can both read it
 * without importing each other.
 */
export const TOTAL_BUDGET_MS = 270_000;

/**
 * How long a review waits for this instance's browser before reporting 'busy'. Short on
 * purpose: the occupant needs minutes, so waiting longer only burns billed time — the
 * caller hands the review back to the queue to be tried again later instead.
 */
export const BUSY_WAIT_MS = 3_000;
