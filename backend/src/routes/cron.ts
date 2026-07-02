import { Router, Request, Response } from 'express';
import { checkApplicationSLAs } from '../jobs/slaChecker.js';

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

// POST /api/cron/sla-check
router.post('/sla-check', async (req: Request, res: Response) => {
  if (!verifyCron(req, res)) return;
  try {
    const result = await checkApplicationSLAs();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron] SLA check failed', err);
    res.status(500).json({ error: 'SLA check failed' });
  }
});

// POST /api/cron/email-digest (stub — email not yet implemented)
router.post('/email-digest', async (req: Request, res: Response) => {
  if (!verifyCron(req, res)) return;
  res.json({ ok: true, message: 'Email digest not yet implemented' });
});

export default router;