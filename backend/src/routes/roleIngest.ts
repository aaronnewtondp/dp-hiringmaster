import { Router, Request, Response } from 'express';
import { query, queryOne, transaction } from '../db/index.js';
import { Role } from '../types/index.js';

const router = Router();

function mapPriority(raw?: string): string {
  const p = (raw || '').trim().toUpperCase();
  if (['P0', 'P1', 'P2', 'P3'].includes(p)) return p;
  return 'P1';
}

// ─── POST /api/roles/ingest ─────────────────────────────────────────────────────
// Called by a Google Apps Script trigger bound to the Requisition Form's
// response sheet, firing on every new form submission (onFormSubmit).
router.post('/ingest', async (req: Request, res: Response) => {
  const providedSecret = req.headers['x-ingest-secret'];
  if (!providedSecret || providedSecret !== process.env.ROLE_INGEST_SECRET) {
    res.status(401).json({ error: 'Invalid or missing ingest secret' });
    return;
  }

  const {
    timestamp, email, department, hiring_manager, priority_level,
    new_or_replacement, vacancy_reason, job_title, num_openings, location,
    appointment_type, qualification_required, must_have_skills, nice_to_have_skills,
    yoe_required, ctc_band, kpi_expectations, additional_remarks,
    target_closure_date, start_date,
  } = req.body;

  if (!job_title) {
    res.status(400).json({ error: 'job_title is required' });
    return;
  }

  const sourceRowKey = `${timestamp || ''}|${email || ''}`;
  if (sourceRowKey.trim() !== '|') {
    const existing = await queryOne<Role>(
      'SELECT id, title FROM roles WHERE requisition_source_row = $1',
      [sourceRowKey]
    );
    if (existing) {
      res.status(200).json({ message: 'Already ingested — skipped duplicate', role_id: existing.id });
      return;
    }
  }

  const role = await transaction(async (client) => {
    const seq = await client.query(`SELECT nextval('seq_role') as n`);
    const roleId = 'R' + String(seq.rows[0].n).padStart(3, '0');

    const result = await client.query(
      `INSERT INTO roles (
         id, title, department, hiring_manager_name, priority, status,
         num_openings, location,
         new_or_replacement, vacancy_reason, appointment_type, qualification_required,
         must_have_skills, nice_to_have_skills, yoe_required, ctc_band,
         kpi_expectations, additional_remarks,
         target_closure_date, start_date, requisition_source_row
       )
       VALUES ($1,$2,$3,$4,$5,'Draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        roleId, job_title, department || null, hiring_manager || null,
        mapPriority(priority_level),
        num_openings ? parseInt(num_openings, 10) : 1,
        location || null,
        new_or_replacement || null, vacancy_reason || null,
        appointment_type || null, qualification_required || null,
        must_have_skills || null, nice_to_have_skills || null,
        yoe_required || null, ctc_band || null,
        kpi_expectations || null, additional_remarks || null,
        target_closure_date || null, start_date || null,
        sourceRowKey,
      ]
    );
    return result.rows[0] as Role;
  });

  console.log(`[Requisition Ingest] Created role ${role.id} — ${role.title}`);
  res.status(201).json({ role });
});

export default router;
