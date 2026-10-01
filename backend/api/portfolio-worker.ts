/**
 * Vercel function that runs portfolio reviews (headless Chromium + a vision
 * model call). Deliberately a SEPARATE function from api/index.ts:
 *  - it needs a 300s budget (a review takes ~35-140s) and the 70 MB Chromium
 *    binary, neither of which the main API should carry;
 *  - if Chromium ever misbehaves on Vercel it can only break this function.
 *
 * It is a Vercel Queues (beta) CONSUMER: vercel.json's experimentalTriggers
 * wires the `portfolio-analysis` topic to it and Vercel's queue infrastructure
 * delivers { applicationId } messages here. A queue consumer has NO public URL
 * (Vercel documents it as air-gapped from the internet) — so there is
 * deliberately no HTTP entry point here: a secret-protected "direct run" route
 * would be unreachable in production, and dead code that looks like a fallback
 * is worse than none. Ways to run a review outside the queue are local only:
 * call runPortfolioAnalysis(applicationId) from a tsx script with DATABASE_URL
 * set, optionally with PORTFOLIO_BROWSER_WS_ENDPOINT pointing at a hosted
 * Chrome. To verify the deployed function, press Re-run on one application.
 */
import 'dotenv/config';
import express from 'express';
import { QueueClient } from '@vercel/queue';
import { MAX_ATTEMPTS } from '../src/services/portfolio/run.js';
import { handlePortfolioMessage } from '../src/services/portfolio/queueHandler.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const queue = new QueueClient();
const handleQueueMessage = queue.handleNodeCallback(
  async (message, metadata) => {
    // All the decisions live in queueHandler.ts (unit-tested). Returns normally for every
    // settled outcome — completed, inaccessible, a recorded 'failed', "not claimable", or a
    // review handed back to the queue because this instance's browser was busy — which
    // acknowledges the message, so a dead portfolio site is never retried. It THROWS only
    // for a transient failure of ours (browser launch, model overloaded) on an early
    // attempt, or when a busy review could not be handed back; the queue then redelivers
    // with a fresh invocation and budget.
    // (vercel.json also caps deliveries at MAX_ATTEMPTS, which bounds the one case this code
    // can't see: a hard kill — OOM, the 300s limit — where no JS runs to ack or throw. The
    // row then reads 'running' and, after STALE_RUNNING_SECONDS, an HR Re-run can reclaim it.)
    const outcome = await handlePortfolioMessage(message, metadata);
    console.log('[Portfolio] queue message handled', JSON.stringify({ deliveryCount: metadata?.deliveryCount, ...outcome }));
  },
  {
    visibilityTimeoutSeconds: 330,
    retry: (_err, metadata) => (metadata.deliveryCount >= MAX_ATTEMPTS ? { acknowledge: true } : { afterSeconds: 120 }),
  },
);

app.get('*', (_req, res) => { res.json({ ok: true, service: 'portfolio-worker' }); });
app.post('*', handleQueueMessage as unknown as express.RequestHandler);

export default app;
