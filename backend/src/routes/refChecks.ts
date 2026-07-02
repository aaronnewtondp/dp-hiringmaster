import { Router, Request, Response } from 'express';
import { query, queryOne, transaction } from '../db/index.js';
import { authenticate, requireHR } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/ref-checks?application_id=A0001
router.get('/', async (req: Request, res: Response) => {
  const { application_id } = req.query;
  if (!application_id) { res.status(400).json({ error: 'application_id required' }); return; }
  const refs = await query(
    'SELECT * FROM ref_checks WHERE application_id=$1 ORDER BY conducted_at DESC',
    [application_id]
  );
  // Strip concerns_raised for non-HR
  const persona = (req as any).user!.persona;
  const safe = refs.map((r: Record<string, unknown>) => {
    if (persona !== 'hr_recruiter' && persona !== 'leadership') {
      const { concerns_raised: _, ...rest } = r;
      return rest;
    }
    return r;
  });
  res.json({ ref_checks: safe });
});

// POST /api/ref-checks — create a new ref check record
router.post('/', requireHR, async (req: Request, res: Response) => {
  const { application_id, reference_contacts, overall_outcome,
          positive_comments, concerns_raised, risk_level } = req.body;
  if (!application_id) { res.status(400).json({ error: 'application_id required' }); return; }

  // Advance application stage to Reference Check if not already there
  const app = await queryOne<{ id: string; stage: string; candidate_id: string; role_id: string }>(
    'SELECT id, stage, candidate_id, role_id FROM applications WHERE id=$1', [application_id]
  );
  if (!app) { res.status(404).json({ error: 'Application not found' }); return; }

  const refCheck = await transaction(async (client) => {
    const rc = await client.query(
      `INSERT INTO ref_checks
         (application_id, reference_contacts, overall_outcome, positive_comments,
          concerns_raised, risk_level, conducted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [application_id, reference_contacts, overall_outcome,
       positive_comments, concerns_raised, risk_level,
       (req as any).user!.userId]
    );

    await client.query(
      `INSERT INTO activity_log (application_id, candidate_id, role_id, event_type, event_detail, new_value, performed_by, performed_by_name)
       VALUES ($1,$2,$3,'Reference Check Initiated',$4,$5,$6,$7)`,
      [application_id, app.candidate_id, app.role_id,
       `Contacts: ${reference_contacts || '—'}`,
       overall_outcome || 'In Progress',
       (req as any).user!.userId, (req as any).user!.name]
    );

    return rc.rows[0];
  });

  res.status(201).json({ ref_check: refCheck });
});

// PATCH /api/ref-checks/:id — update/complete a ref check
router.patch('/:id', requireHR, async (req: Request, res: Response) => {
  const allowed = ['reference_contacts','overall_outcome','positive_comments',
    'concerns_raised','risk_level'];
  const updates: string[] = []; const values: unknown[] = []; let i = 1;
  for (const f of allowed) {
    if (req.body[f] !== undefined) { updates.push(`${f}=$${i++}`); values.push(req.body[f]); }
  }
  if (!updates.length) { res.status(400).json({ error: 'No fields' }); return; }
  values.push(req.params.id);
  const rc = await queryOne(
    `UPDATE ref_checks SET ${updates.join(',')} WHERE id=$${i} RETURNING *`, values
  );
  if (!rc) { res.status(404).json({ error: 'Not found' }); return; }

  // Log completion
  if (req.body.overall_outcome) {
    const rec = rc as Record<string, unknown>;
    await queryOne(
      `INSERT INTO activity_log (application_id, event_type, event_detail, new_value, performed_by_name)
       VALUES ($1,'Reference Check Completed',$2,$3,'System')`,
      [rec.application_id, `Outcome: ${req.body.overall_outcome}`, req.body.risk_level || '']
    );
  }
  res.json({ ref_check: rc });
});

export default router;
