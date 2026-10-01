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
import { MAX_ATTEMPTS, runPortfolioAnalysis } from '../src/services/portfolio/run.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Application ids look like A0747 / A10140 — anything else is not ours to run.
const APPLICATION_ID = /^A\d{1,10}$/;

const queue = new QueueClient();
const handleQueueMessage = queue.handleNodeCallback(
  async (message, metadata) => {
    const applicationId = (message as { applicationId?: unknown } | null)?.applicationId;
    if (typeof applicationId !== 'string' || !APPLICATION_ID.test(applicationId)) return;   // malformed: acknowledge, don't retry forever
    // Returns normally for every settled outcome (completed, inaccessible, a
    // recorded 'failed', or "not claimable") — that acknowledges the message, so
    // a dead portfolio site is never retried. It THROWS only for a transient
    // failure of ours (browser busy/launch, model overloaded) on an early
    // attempt; the queue then redelivers with a fresh invocation and budget.
    // (vercel.json also caps deliveries at MAX_ATTEMPTS, which bounds the one
    // case this code can't see: a hard kill — OOM, the 300s limit — where no
    // JS runs to ack or throw. The row then reads 'running' and, after
    // STALE_RUNNING_SECONDS, an HR Re-run can reclaim it.)
    const result = await runPortfolioAnalysis(applicationId, { attempt: metadata?.deliveryCount ?? 1 });
    console.log('[Portfolio] queue job finished', applicationId, JSON.stringify(result));
  },
  {
    visibilityTimeoutSeconds: 330,
    retry: (_err, metadata) => (metadata.deliveryCount >= MAX_ATTEMPTS ? { acknowledge: true } : { afterSeconds: 120 }),
  },
);

app.get('*', (_req, res) => { res.json({ ok: true, service: 'portfolio-worker' }); });
app.post('*', handleQueueMessage as unknown as express.RequestHandler);

export default app;
