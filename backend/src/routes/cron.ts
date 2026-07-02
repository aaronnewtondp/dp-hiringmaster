/**
 * Vercel Cron endpoints — called by Vercel's scheduler on the schedules
 * defined in vercel.json. Each endpoint is a plain HTTP POST that Vercel
 * hits on schedule.
 *
 * Requests from Vercel Cron arrive with:
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Set CRON_SECRET in your Vercel environment variables.
 */
import { Router, Request, Response } from 'express';
import { checkApplicationSLAs } from '../jobs/slaChecker.js';
import { sendDailyDigest } from '../jobs/emailDigest.js';

const router = Router();

function verifyCron(req: Request, res: Response): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[cron] CRON_SECRET is not set — rejecting request');
    res.status(500).json({ error: 'Server misconfiguration' });
    return false;
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// POST /api/cron/sla-check  (every 15 min via vercel.json)
router.post('/sla-check', async (req: Request, res: Response) => {
  if (!verifyCron(req, res)) return;
  try {
    const result = await checkApplicationSLAs();
    console.log('[cron] SLA check completed', result);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron] SLA check failed', err);
    res.status(500).json({ error: 'SLA check failed' });
  }
});

// POST /api/cron/email-digest  (8:15am daily via vercel.json)
router.post('/email-digest', async (req: Request, res: Response) => {
  if (!verifyCron(req, res)) return;
  try {
    await sendDailyDigest();
    console.log('[cron] Daily digest sent');
    res.json({ ok: true });
  } catch (err) {
    console.error('[cron] Daily digest failed', err);
    res.status(500).json({ error: 'Digest failed' });
  }
});

export default router;
