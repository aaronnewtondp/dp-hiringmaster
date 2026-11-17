import { Router, Request, Response } from 'express';
import { transaction } from '../db/index.js';
import { Role } from '../types/index.js';
import { canonicalHiringManagerField } from '../utils/hiringManagers.js';

const router = Router();

export function mapPriority(raw?: string): string {
  const p = (raw || '').trim().toUpperCase();
  if (['P0', 'P1', 'P2', 'P3'].includes(p)) return p;
  return 'P1';
}

// "Vacancy Caused Due To" is a checkbox (multi-select) question — Google
// Forms/Apps Script joins multiple selections into one comma-space-joined
// string in the sheet ("Increased Work Load, Additional Assignments /
// Business Expansion"), same shape the historical data migration on
// roles.vacancy_reason (now TEXT[]) already split on. Mirrors that split
// exactly so a live submission and the backfilled historical rows parse
// identically.
export function parseVacancyReason(raw: unknown): string[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw.map(String);
  const s = String(raw).trim();
  return s ? s.split(', ') : null;
}

// Upper bound for "Number of openings" on a requisition (a sanity cap, not a business rule).
export const MAX_NUM_OPENINGS = 500;

// num_openings from the form: absent/empty keeps the default of 1; otherwise a positive whole number (a JSON number or
// a numeric string such as "3" or "08"). Anything else ("abc", "0", "-2", "1.5", "1e3", above the cap) is null = invalid.
export function parseNumOpenings(raw: unknown): number | null {
  if (raw === undefined || raw === null) return 1;
  if (typeof raw === 'string' && raw.trim() === '') return 1;
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) n = parseInt(raw.trim(), 10);
  else return null;
  return Number.isInteger(n) && n >= 1 && n <= MAX_NUM_OPENINGS ? n : null;
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
    target_closure_date,
  } = req.body;

  if (!job_title) {
    res.status(400).json({ error: 'job_title is required' });
    return;
  }

  // Validate EVERYTHING before the transaction opens: a bad value must not burn a sequence value or write a row.
  const openings = parseNumOpenings(num_openings);
  if (openings === null) {
    res.status(400).json({ error: `num_openings must be a whole number from 1 to ${MAX_NUM_OPENINGS} (got ${JSON.stringify(num_openings)})` });
    return;
  }

  // The dedup key is "timestamp|email". With neither a usable timestamp nor a usable e-mail the key would be "|" and
  // a re-fired trigger could not be recognised, so the row is refused rather than risk a duplicate role.
  const hasUsable = (v: unknown) => typeof v === 'string' ? v.trim() !== '' : (typeof v === 'number' && Number.isFinite(v));
  if (!hasUsable(timestamp) && !hasUsable(email)) {
    res.status(400).json({ error: 'timestamp or email is required: without one of them this submission cannot be de-duplicated' });
    return;
  }
  const sourceRowKey = `${timestamp || ''}|${email || ''}`;

  const outcome = await transaction(async (client) => {
    // requisition_source_row has no unique index, so two concurrent posts of one row could both insert. Serialise
    // same-key posts: the second waits for the first to commit, then finds its role in the lookup below.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`role-ingest:${sourceRowKey}`]);
    const found = await client.query('SELECT id, title FROM roles WHERE requisition_source_row = $1', [sourceRowKey]);
    if (found.rows[0]) return { existingId: found.rows[0].id as string };

    // start_date (Open Date) is deliberately left unset here — a Draft role
    // hasn't been approved yet, so its aging clock hasn't started. PATCH
    // /:id's approval branch (roles.ts) sets it automatically the day this
    // role is actually approved, same as a manually-created role.
    // The id comes from the column default (format_seq_id, 4-digit pad), the same as POST /roles.
    const result = await client.query(
      `INSERT INTO roles (
         title, department, hiring_manager_name, priority, status,
         num_openings, location,
         new_or_replacement, vacancy_reason, appointment_type, qualification_required,
         must_have_skills, nice_to_have_skills, yoe_required, ctc_band,
         kpi_expectations, additional_remarks,
         target_closure_date, requisition_source_row
       )
       VALUES ($1,$2,$3,$4,'Draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        job_title, department || null, canonicalHiringManagerField(hiring_manager) || null,
        mapPriority(priority_level),
        openings,
        location || null,
        new_or_replacement || null, parseVacancyReason(vacancy_reason),
        appointment_type || null, qualification_required || null,
        must_have_skills || null, nice_to_have_skills || null,
        yoe_required || null, ctc_band || null,
        kpi_expectations || null, additional_remarks || null,
        target_closure_date || null,
        sourceRowKey,
      ]
    );
    await client.query(
      `INSERT INTO activity_log (role_id, event_type, event_detail, performed_by_name)
       VALUES ($1, 'Role Created', $2, 'System')`,
      [result.rows[0].id, `${result.rows[0].title} auto-created from Requisition Form submission`]
    );

    return { role: result.rows[0] as Role };
  });

  if ('existingId' in outcome) {
    res.status(200).json({ message: 'Already ingested — skipped duplicate', role_id: outcome.existingId });
    return;
  }
  const role = outcome.role;

  console.log(`[Requisition Ingest] Created role ${role.id} — ${role.title}`);
  res.status(201).json({ role });
});

export default router;
