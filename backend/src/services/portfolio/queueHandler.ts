// WORKER-ONLY (imports run.ts → the browser). The body of the queue consumer in
// api/portfolio-worker.ts, kept here so its decisions can be unit-tested with
// the heavy parts injected.
import { runPortfolioAnalysis, RunResult } from './run.js';
import { enqueuePortfolioAnalysis, markPortfolioFailed } from './enqueue.js';
import { busyRetryPlan, parsePortfolioMessage } from './queueMessage.js';

export interface HandlerDeps {
  run:     (applicationId: string, opts: { attempt: number }) => Promise<RunResult>;
  requeue: (applicationId: string, opts: { busyRetries: number; delaySeconds: number }) => Promise<{ enqueued: boolean; error?: string }>;
  giveUp:  (applicationId: string) => Promise<void>;
}

const defaultDeps: HandlerDeps = {
  run:     (id, opts) => runPortfolioAnalysis(id, opts),
  requeue: (id, opts) => enqueuePortfolioAnalysis(id, opts),
  giveUp:  (id) => markPortfolioFailed(id, 'The portfolio browser stayed busy for too long, so this review never got to run. Use Re-run to retry.'),
};

export type HandlerOutcome =
  | { outcome: 'ignored' }
  | { outcome: 'done'; result: RunResult }
  | { outcome: 'requeued'; busyRetries: number; delaySeconds: number }
  | { outcome: 'gave_up' };

/**
 * Returns normally for everything that is settled (acknowledging the message) and
 * THROWS only when the queue should redeliver it: a transient failure of ours
 * (run.ts decides), or a failure to hand a busy review back to the queue.
 */
export async function handlePortfolioMessage(
  raw: unknown,
  metadata: { deliveryCount?: number } | undefined,
  deps: HandlerDeps = defaultDeps,
): Promise<HandlerOutcome> {
  const msg = parsePortfolioMessage(raw);
  if (!msg) return { outcome: 'ignored' };                      // malformed: acknowledge, don't retry forever

  const result = await deps.run(msg.applicationId, { attempt: metadata?.deliveryCount ?? 1 });
  if (result.status !== 'busy') return { outcome: 'done', result };

  // Another review holds this instance's browser. Not a failure and not an attempt used:
  // send a fresh delayed message and acknowledge this one.
  const plan = busyRetryPlan(msg.busyRetries);
  if (plan.action === 'give_up') {
    await deps.giveUp(msg.applicationId);
    return { outcome: 'gave_up' };
  }
  const queued = await deps.requeue(msg.applicationId, { busyRetries: plan.busyRetries, delaySeconds: plan.delaySeconds });
  // If the hand-back itself failed, fall back to the queue's own redelivery rather than lose the review.
  if (!queued.enqueued) throw new Error(`Could not hand the busy review back to the queue: ${queued.error ?? 'unknown error'}`);
  return { outcome: 'requeued', busyRetries: plan.busyRetries, delaySeconds: plan.delaySeconds };
}
