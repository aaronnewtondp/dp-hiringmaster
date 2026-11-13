// Sourcing plan detailing — API (additive to routes/sourcing.ts, mounted at the same /api/sourcing prefix). Spec: docs/SourcingPlanDetailing_Spec.md
//   * Gated on SOURCING_ENABLED exactly like the rest of the module (reads answer { enabled:false }, writes 503).
//   * Everything is HR-tier (the HR/Admin persona owns sourcing). Templates and the alert thresholds are Leadership / Super Admin ("the HR lead").
//   * The company directory: HR-tier view, add and edit; only Leadership / Super Admin delete.
import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireHR } from '../middleware/auth.js';
import { isSourcingEnabled } from '../utils/sourcingConfig.js';
import { COMPANY_EXCLUDE_HINTS, RESOLUTION_REASONS } from '../utils/sourcingDetail.js';
import { SourcingError, getPlanRowById } from '../services/sourcingPlans.js';
import {
  applyTemplate, getOverview, getPlanDetail, getReminders, listTemplates, prefillPlan, saveDetailThresholds, submitCheckin, updatePlanDetail, updateTemplate, uploadOutreach,
} from '../services/sourcingDetail.js';
import { loadDetailThresholds } from '../services/sourcingDetailFacts.js';
import {
  deleteCompany, getCompany, importCompanies, importCompaniesCsv, listCompanies, listCompanyLists, markChecked, saveCompany, setExcluded,
} from '../services/sourcingCompanies.js';
import { maybeRunSourcingCheck } from '../jobs/sourcingChecker.js';

const router = Router();
router.use(authenticate);

function disabled(req: Request, res: Response, next: NextFunction) {
  if (isSourcingEnabled()) { next(); return; }
  if (req.method === 'GET') { res.json({ enabled: false }); return; }
  res.status(503).json({ error: 'The sourcing module is not enabled', enabled: false });
}
function fail(res: Response, err: unknown, what: string) {
  if (err instanceof SourcingError) { res.status(err.status).json({ error: err.message }); return; }
  console.error(`[Sourcing] ${what} failed:`, err);
  res.status(500).json({ error: `${what} failed` });
}
const idParam = (v: unknown): string | null => (typeof v === 'string' && /^\d{1,18}$/.test(v) ? v : null);
const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {});
/** "The HR lead": Leadership or the Super Admin. */
const isHrLead = (req: Request) => req.user!.persona === 'leadership' || req.user!.persona === 'super_admin';

// ── Templates ─────────────────────────────────────────────────────────────────────────────────────
router.get('/templates', disabled, requireHR, async (_req, res) => {
  try { res.json({ enabled: true, templates: await listTemplates() }); } catch (err) { fail(res, err, 'Loading templates'); }
});
router.put('/templates/:key', disabled, requireHR, async (req, res) => {
  if (!isHrLead(req)) { res.status(403).json({ error: 'Only Leadership or the Super Admin can edit templates' }); return; }
  try { await updateTemplate(String(req.params.key), body(req), req.user!); res.json({ ok: true }); } catch (err) { fail(res, err, 'Saving the template'); }
});

// ── A plan's detail ───────────────────────────────────────────────────────────────────────────────
router.get('/plans/:roleId/detail', disabled, requireHR, async (req, res) => {
  try { const detail = await getPlanDetail(String(req.params.roleId)); res.json({ enabled: true, detail }); } catch (err) { fail(res, err, 'Loading the plan detail'); }
});
router.patch('/plans/:planId/detail', disabled, requireHR, async (req, res) => {
  const id = idParam(req.params.planId); if (!id) { res.status(400).json({ error: 'Invalid plan' }); return; }
  try { await updatePlanDetail(id, body(req), req.user!); res.json({ ok: true }); } catch (err) { fail(res, err, 'Saving the plan detail'); }
});
router.post('/plans/:planId/template', disabled, requireHR, async (req, res) => {
  const id = idParam(req.params.planId); if (!id) { res.status(400).json({ error: 'Invalid plan' }); return; }
  const key = body(req).template_key;
  if (typeof key !== 'string' || !key) { res.status(400).json({ error: 'Choose a template' }); return; }
  try { res.json({ ok: true, template: await applyTemplate(id, key, req.user!) }); } catch (err) { fail(res, err, 'Applying the template'); }
});
router.post('/plans/:planId/prefill', disabled, requireHR, async (req, res) => {
  const id = idParam(req.params.planId); if (!id) { res.status(400).json({ error: 'Invalid plan' }); return; }
  try { res.json({ ok: true, template: await prefillPlan(id, { userId: req.user!.userId }) }); } catch (err) { fail(res, err, 'Pre-filling the plan'); }
});
router.post('/plans/:planId/checkin', disabled, requireHR, async (req, res) => {
  const id = idParam(req.params.planId); if (!id) { res.status(400).json({ error: 'Invalid plan' }); return; }
  const b = body(req);
  try {
    const plan = await getPlanRowById(id); if (!plan) { res.status(404).json({ error: 'Plan not found' }); return; }
    const out = await submitCheckin(id, {
      week_start: typeof b.week_start === 'string' ? b.week_start : undefined,
      answers: b.answers && typeof b.answers === 'object' ? b.answers as Record<string, unknown> : {},
      blocker_text: typeof b.blocker_text === 'string' ? b.blocker_text : null,
    }, req.user!);
    maybeRunSourcingCheck().catch(() => undefined);
    res.json({ ok: true, ...out });
  } catch (err) { fail(res, err, 'Saving the check-in'); }
});

// ── Outreach upload, reminders, overview ──────────────────────────────────────────────────────────
router.post('/outreach/upload', disabled, requireHR, async (req, res) => {
  const b = body(req);
  try {
    const result = await uploadOutreach(typeof b.csv === 'string' ? b.csv : '', typeof b.filename === 'string' ? b.filename : null, req.user!);
    maybeRunSourcingCheck().catch(() => undefined);
    res.json({ ok: true, ...result });
  } catch (err) { fail(res, err, 'Uploading the outreach sheet'); }
});
router.get('/reminders', disabled, requireHR, async (_req, res) => {
  try { res.json({ enabled: true, reminders: await getReminders() }); } catch (err) { fail(res, err, 'Loading reminders'); }
});
router.get('/overview', disabled, requireHR, async (_req, res) => {
  try { await maybeRunSourcingCheck(); res.json({ enabled: true, ...(await getOverview()), reasons: RESOLUTION_REASONS }); } catch (err) { fail(res, err, 'Loading the overview'); }
});

// ── Alert thresholds + the "alerts are live" switch (Leadership / Super Admin) ────────────────────────
router.get('/detail-settings', disabled, requireHR, async (_req, res) => {
  try { res.json({ enabled: true, thresholds: await loadDetailThresholds() }); } catch (err) { fail(res, err, 'Loading the alert settings'); }
});
router.put('/detail-settings', disabled, requireHR, async (req, res) => {
  if (!isHrLead(req)) { res.status(403).json({ error: 'Only Leadership or the Super Admin can change the alert settings' }); return; }
  try { res.json({ ok: true, thresholds: await saveDetailThresholds(body(req), req.user!.userId) }); } catch (err) { fail(res, err, 'Saving the alert settings'); }
});

// ── Company directory ─────────────────────────────────────────────────────────────────────────────
router.get('/company-lists', disabled, requireHR, async (_req, res) => {
  try { res.json({ enabled: true, lists: await listCompanyLists() }); } catch (err) { fail(res, err, 'Loading company lists'); }
});
router.get('/companies', disabled, requireHR, async (req, res) => {
  const q = req.query;
  const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  try {
    res.json({ enabled: true, exclude_hints: COMPANY_EXCLUDE_HINTS, ...(await listCompanies({
      q: s(q.q), list: s(q.list), segment: s(q.segment), size: s(q.size), city: s(q.city), role: s(q.role),
      contacted: q.contacted === 'yes' || q.contacted === 'no' ? q.contacted : undefined, excluded: q.excluded === 'true', recheck: q.recheck === 'true',
      limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined,
    })) });
  } catch (err) { fail(res, err, 'Loading companies'); }
});
router.post('/companies/import', disabled, requireHR, async (req, res) => {
  const b = body(req);
  try {
    if (typeof b.csv === 'string') res.json({ ok: true, ...(await importCompaniesCsv(b.csv, req.user!)) });
    else if (Array.isArray(b.rows)) res.json({ ok: true, ...(await importCompanies(b.rows as never, req.user!)) });
    else res.status(400).json({ error: 'Send the file as csv text' });
  } catch (err) { fail(res, err, 'Importing companies'); }
});
router.get('/companies/:id', disabled, requireHR, async (req, res) => {
  try { const c = await getCompany(String(req.params.id)); if (!c) { res.status(404).json({ error: 'Company not found' }); return; } res.json({ enabled: true, company: c }); } catch (err) { fail(res, err, 'Loading the company'); }
});
router.post('/companies', disabled, requireHR, async (req, res) => {
  try { res.json({ ok: true, id: await saveCompany(null, body(req), req.user!) }); } catch (err) { fail(res, err, 'Adding the company'); }
});
router.patch('/companies/:id', disabled, requireHR, async (req, res) => {
  const id = idParam(req.params.id); if (!id) { res.status(400).json({ error: 'Invalid company' }); return; }
  try { await saveCompany(id, body(req), req.user!); res.json({ ok: true }); } catch (err) { fail(res, err, 'Saving the company'); }
});
router.post('/companies/:id/exclude', disabled, requireHR, async (req, res) => {
  const id = idParam(req.params.id); if (!id) { res.status(400).json({ error: 'Invalid company' }); return; }
  const b = body(req);
  try { await setExcluded(id, b.excluded !== false, typeof b.reason === 'string' ? b.reason : null, req.user!); res.json({ ok: true }); } catch (err) { fail(res, err, 'Excluding the company'); }
});
router.post('/companies/:id/checked', disabled, requireHR, async (req, res) => {
  const id = idParam(req.params.id); if (!id) { res.status(400).json({ error: 'Invalid company' }); return; }
  try { await markChecked(id, req.user!); res.json({ ok: true }); } catch (err) { fail(res, err, 'Marking the company as checked'); }
});
router.delete('/companies/:id', disabled, requireHR, async (req, res) => {
  if (!isHrLead(req)) { res.status(403).json({ error: 'Only the HR lead (Leadership or the Super Admin) can delete a company' }); return; }
  const id = idParam(req.params.id); if (!id) { res.status(400).json({ error: 'Invalid company' }); return; }
  try { await deleteCompany(id); res.json({ ok: true }); } catch (err) { fail(res, err, 'Deleting the company'); }
});

export default router;
