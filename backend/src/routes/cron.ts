import { Router, Request, Response } from 'express';
import { runSlaCheck, sendDailyDigest } from '../jobs/slaChecker.js';
import { runSourcingCheck } from '../jobs/sourcingChecker.js';
import { sendSourcingDigests } from '../services/sourcingDigest.js';
import { isSourcingEnabled } from '../utils/sourcingConfig.js';

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

// GET|POST /api/cron/sourcing-check — Sourcing module exception engine. One handler for both verbs: Vercel Cron
// issues GET (the existing /email-digest route is POST-only and therefore never fires; deliberately left alone).
// A no-op unless SOURCING_ENABLED=true. Same engine the dashboard/queue run opportunistically, so cron and a page
// load are equivalent.
async function sourcingCheck(req: Request, res: Response) {
  if (!verifyCron(req, res)) return;
  if (!isSourcingEnabled()) { res.json({ ok: true, enabled: false }); return; }
  try {
    const summary = await runSourcingCheck();
    // Internal e-mails (off until switched on in the sourcing settings). Never throws: a mail problem is reported, not fatal.
    const digests = await sendSourcingDigests();
    res.json({ ok: true, enabled: true, ...summary, digests });
  } catch (err) {
    console.error('[cron] Sourcing check failed', err);
    res.status(500).json({ error: 'Sourcing check failed' });
  }
}
router.get('/sourcing-check', sourcingCheck);
router.post('/sourcing-check', sourcingCheck);

export default router;