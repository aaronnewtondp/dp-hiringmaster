import { Router, Request, Response } from 'express';
import { query, queryOne, transaction } from '../db/index.js';
import { Role } from '../types/index.js';

const router = Router();

function mapPriority(raw?: string): string {
  const p = (raw || '').trim().toUpperCase();
  if (['P0', 'P1', 'P2', 'P3'].includes(p)) return p;
  return 'P1';
}

// Google Sheets' onFormSubmit trigger sends the submission timestamp in the
// sheet's own display format — for this workspace's IST locale that's
// "DD/MM/YYYY HH:MM:SS" (same shape seen in the candidate ingest CSV export).
// Extract just the date portion for start_date, which is a DATE column.
// Returns null on unrecognized shapes (also handles ISO fallback).
function parseFormTimestampToDate(ts: string | undefined): string | null {
  if (!ts) return null;
  const s = String(ts).trim();
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  return null;
}

// "Vacancy Caused Due To" is a checkbox (multi-select) question — Google
// Forms/Apps Script joins multiple selections into one comma-space-joined
// string in the sheet ("Increased Work Load, Additional Assignments /
// Business Expansion"), same shape the historical data migration on
// roles.vacancy_reason (now TEXT[]) already split on. Mirrors that split
// exactly so a live submission and the backfilled historical rows parse
// identically.
function parseVacancyReason(raw: unknown): string[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw.map(String);
  const s = String(raw).trim();
  return s ? s.split(', ') : null;
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
        new_or_replacement || null, parseVacancyReason(vacancy_reason),
        appointment_type || null, qualification_required || null,
        must_have_skills || null, nice_to_have_skills || null,
        yoe_required || null, ctc_band || null,
        kpi_expectations || null, additional_remarks || null,
        target_closure_date || null,
        // Fall back to the requisition submission date when the form itself
        // doesn't send a start_date — matches how HR would treat "when did
        // this role become open" (the moment the requisition was filed).
        start_date || parseFormTimestampToDate(timestamp),
        sourceRowKey,
      ]
    );
    return result.rows[0] as Role;
  });

  console.log(`[Requisition Ingest] Created role ${role.id} — ${role.title}`);
  res.status(201).json({ role });
});

export default router;
