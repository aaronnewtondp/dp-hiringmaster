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
  res.json({ ref_checks: refs });
});

// POST /api/ref-checks — create a new reference check record
router.post('/', requireHR, async (req: Request, res: Response) => {
  const { application_id, reference_name, reference_number, relationship,
          reference_call_notes, feedback } = req.body;
  if (!application_id) { res.status(400).json({ error: 'application_id required' }); return; }
  if (!reference_name || !reference_number || !relationship || !feedback) {
    res.status(400).json({ error: 'reference_name, reference_number, relationship, and feedback are required' });
    return;
  }

  const app = await queryOne<{ id: string; candidate_id: string; role_id: string }>(
    'SELECT id, candidate_id, role_id FROM applications WHERE id=$1', [application_id]
  );
  if (!app) { res.status(404).json({ error: 'Application not found' }); return; }

  const refCheck = await transaction(async (client) => {
    const rc = await client.query(
      `INSERT INTO ref_checks
         (application_id, reference_name, reference_number, relationship,
          reference_call_notes, feedback, conducted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [application_id, reference_name, reference_number, relationship,
       reference_call_notes || null, feedback, req.user!.userId]
    );

    await client.query(
      `INSERT INTO activity_log (application_id, candidate_id, role_id, event_type, event_detail, new_value, performed_by, performed_by_name)
       VALUES ($1,$2,$3,'Reference Check Added',$4,$5,$6,$7)`,
      [application_id, app.candidate_id, app.role_id,
       `${reference_name} (${relationship}) — Feedback: ${feedback}`,
       feedback, req.user!.userId, req.user!.name]
    );

    return rc.rows[0];
  });

  res.status(201).json({ ref_check: refCheck });
});

// PATCH /api/ref-checks/:id — update a reference check
router.patch('/:id', requireHR, async (req: Request, res: Response) => {
  const allowed = ['reference_name', 'reference_number', 'relationship',
    'reference_call_notes', 'feedback'];
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
  res.json({ ref_check: rc });
});

export default router;
