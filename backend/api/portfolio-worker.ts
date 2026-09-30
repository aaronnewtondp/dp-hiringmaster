/**
 * Vercel function that runs portfolio reviews (headless Chromium + a vision
 * model call). Deliberately a SEPARATE function from api/index.ts:
 *  - it needs a 300s budget (a review takes ~35-140s) and the 70 MB Chromium
 *    binary, neither of which the main API should carry;
 *  - if Chromium ever misbehaves on Vercel it can only break this function.
 *
 * Two ways in:
 *  1. Vercel Queues (beta) delivers { applicationId } messages here — the
 *     normal path, triggered from vercel.json's experimentalTriggers. Vercel
 *     invokes queue consumers itself; that path is not reachable from outside.
 *  2. A direct POST carrying the shared x-ingest-secret runs one review
 *     synchronously — the fallback if the queue is unavailable, and how the
 *     deployed function can be verified independently of the queue.
 */
import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import { QueueClient } from '@vercel/queue';
import { MAX_ATTEMPTS, runPortfolioAnalysis } from '../src/services/portfolio/run.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Application ids look like A0747 / A10140 — anything else is not ours to run.
const APPLICATION_ID = /^A\d{1,10}$/;

function secretMatches(provided: unknown): boolean {
  const secret = process.env.ROLE_INGEST_SECRET;
  if (!secret || typeof provided !== 'string') return false;   // no secret configured => the direct path is CLOSED, never open
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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
    const result = await runPortfolioAnalysis(applicationId, { attempt: metadata?.deliveryCount ?? 1 });
    console.log('[Portfolio] queue job finished', applicationId, JSON.stringify(result));
  },
  {
    visibilityTimeoutSeconds: 330,
    retry: (_err, metadata) => (metadata.deliveryCount >= MAX_ATTEMPTS ? { acknowledge: true } : { afterSeconds: 120 }),
  },
);

app.get('*', (_req, res) => { res.json({ ok: true, service: 'portfolio-worker' }); });

app.post('*', async (req, res, next) => {
  if (secretMatches(req.headers['x-ingest-secret'])) {
    const applicationId = String(req.body?.applicationId || '');
    if (!APPLICATION_ID.test(applicationId)) { res.status(400).json({ error: 'valid applicationId required' }); return; }
    try {
      res.json(await runPortfolioAnalysis(applicationId));   // direct run: no retries, so it settles as 'failed' if it fails
    } catch (err) {
      res.status(500).json({ error: (err as Error).message.slice(0, 200) });
    }
    return;
  }
  return (handleQueueMessage as unknown as express.RequestHandler)(req, res, next);
});

export default app;
