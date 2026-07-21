import { Router, Request, Response } from 'express';
import { runSlaCheck, sendDailyDigest } from '../jobs/slaChecker.js';

const router = Router();

function verifyCron(req: Request, res: Response): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'CRON_SECRET not set' });
    return false;
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// POST /api/cron/sla-check — runs all 4 checks (application SLAs, assignment
// deadlines, role aging, joining risk), same as dashboard.ts's compute-on-read
// path, so Vercel Cron and a dashboard load are equivalent instead of the
// cron route silently covering less.
router.post('/sla-check', async (req: Request, res: Response) => {
  if (!verifyCron(req, res)) return;
  try {
    await runSlaCheck();
    res.json({ ok: true });
  } catch (err) {
    console.error('[cron] SLA check failed', err);
    res.status(500).json({ error: 'SLA check failed' });
  }
});

// POST /api/cron/email-digest
router.post('/email-digest', async (req: Request, res: Response) => {
  if (!verifyCron(req, res)) return;
  try {
    await sendDailyDigest();
    res.json({ ok: true });
  } catch (err) {
    console.error('[cron] Email digest failed', err);
    res.status(500).json({ error: 'Email digest failed' });
  }
});

export default router;