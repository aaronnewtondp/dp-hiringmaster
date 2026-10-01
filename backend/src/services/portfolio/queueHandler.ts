// WORKER-ONLY (imports run.ts → the browser). The body of the queue consumer in
// api/portfolio-worker.ts, kept here so its decisions can be unit-tested with
// the heavy parts injected.
import { runPortfolioAnalysis, RunResult } from './run.js';
import { enqueuePortfolioAnalysis, markPortfolioGaveUp, portfolioNeedsReview } from './enqueue.js';
import { MAX_ATTEMPTS } from './jobState.js';
import { busyRetryPlan, effectiveAttempt, parsePortfolioMessage } from './queueMessage.js';

export interface HandlerDeps {
  run:         (applicationId: string, opts: { attempt: number }) => Promise<RunResult>;
  requeue:     (applicationId: string, opts: { busyRetries: number; attemptsUsed: number; delaySeconds: number }) => Promise<{ enqueued: boolean; error?: string }>;
  /** Is there still a review to do for this application? False once it has settled or another worker holds it. */
  needsReview: (applicationId: string) => Promise<boolean>;
  /** Records a failure — but only on a row that is still waiting (or a dead 'running' one); never on one that settled. */
  giveUp:      (applicationId: string, message: string) => Promise<void>;
}

const defaultDeps: HandlerDeps = {
  run:         (id, opts) => runPortfolioAnalysis(id, opts),
  requeue:     (id, opts) => enqueuePortfolioAnalysis(id, opts),
  needsReview: (id) => portfolioNeedsReview(id),
  giveUp:      (id, message) => markPortfolioGaveUp(id, message),
};

const MSG_BUSY_TOO_LONG = 'The portfolio browser stayed busy for too long, so this review never got to run. Use Re-run to retry.';
const MSG_ATTEMPTS_SPENT = 'This review kept failing before it could finish (the worker was stopped mid-review more than once). Use Re-run to retry.';
const MSG_COULD_NOT_REQUEUE = 'This review could not be put back in the queue after the browser was busy. Use Re-run to retry.';

export type HandlerOutcome =
  | { outcome: 'ignored' }
  | { outcome: 'done'; result: RunResult }
  | { outcome: 'requeued'; busyRetries: number; delaySeconds: number }
  | { outcome: 'stale' }
  | { outcome: 'gave_up' };

/**
 * Returns normally for everything that is settled (acknowledging the message) and
 * THROWS only when the queue should redeliver it: a transient failure of ours
 * (run.ts decides), or a failure to hand a busy review back to the queue while
 * attempts remain.
 */
export async function handlePortfolioMessage(
  raw: unknown,
  metadata: { deliveryCount?: number } | undefined,
  deps: HandlerDeps = defaultDeps,
): Promise<HandlerOutcome> {
  const msg = parsePortfolioMessage(raw);
  if (!msg) return { outcome: 'ignored' };                      // malformed: acknowledge, don't retry forever

  const deliveryCount = Math.max(metadata?.deliveryCount ?? 1, 1);
  const attempt = effectiveAttempt(msg, deliveryCount);
  if (attempt > MAX_ATTEMPTS) {
    // Earlier deliveries (carried across hand-backs) already spent the whole budget — the
    // signature of a review that keeps killing its worker. Stop paying 300s a time for it.
    await deps.giveUp(msg.applicationId, MSG_ATTEMPTS_SPENT);
    return { outcome: 'gave_up' };
  }

  const result = await deps.run(msg.applicationId, { attempt });
  if (result.status !== 'busy') return { outcome: 'done', result };

  // Another review holds this instance's browser. Not a failure and not an attempt used.
  // But first make sure there is still something to do: a duplicate or stale message for an
  // application that has since settled (or that another worker now holds) must end here,
  // not bounce for hours and then be marked failed.
  if (!(await deps.needsReview(msg.applicationId))) return { outcome: 'stale' };

  const plan = busyRetryPlan(msg.busyRetries);
  if (plan.action === 'give_up') {
    await deps.giveUp(msg.applicationId, MSG_BUSY_TOO_LONG);
    return { outcome: 'gave_up' };
  }

  // The busy delivery itself ran nothing, so it is not carried forward; earlier ones are.
  const attemptsUsed = msg.attemptsUsed + (deliveryCount - 1);
  const queued = await deps.requeue(msg.applicationId, { busyRetries: plan.busyRetries, attemptsUsed, delaySeconds: plan.delaySeconds });
  if (!queued.enqueued) {
    // The queue's own redelivery is the fallback — unless this is the last delivery it will make
    // (the worker's retry hook acknowledges at MAX_ATTEMPTS), in which case the review would
    // vanish and leave the row 'pending' forever. Record it so it shows up with a Re-run action.
    if (deliveryCount >= MAX_ATTEMPTS || attempt >= MAX_ATTEMPTS) {
      await deps.giveUp(msg.applicationId, MSG_COULD_NOT_REQUEUE);
      return { outcome: 'gave_up' };
    }
    throw new Error(`Could not hand the busy review back to the queue: ${queued.error ?? 'unknown error'}`);
  }
  return { outcome: 'requeued', busyRetries: plan.busyRetries, delaySeconds: plan.delaySeconds };
}
