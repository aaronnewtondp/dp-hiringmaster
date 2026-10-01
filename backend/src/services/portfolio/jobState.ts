// LIGHT — imported by both the worker (run.ts) and the main API's re-run route,
// so the definition of "this job is dead" lives in exactly one place.

/**
 * A row in 'running' longer than this is treated as dead. It must exceed the
 * worker function's 300s hard limit (so a live job is never reclaimed) but stay
 * BELOW the queue's visibility timeout (330s) so that the redelivered message
 * can actually reclaim a job whose function was killed.
 */
export const STALE_RUNNING_SECONDS = 310;
