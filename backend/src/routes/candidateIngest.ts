import { Router, Request, Response } from 'express';
import { transaction } from '../db/index.js';
import { Candidate } from '../types/index.js';

const router = Router();

// Profile fields eligible for the fill-null-only update on a repeat
// applicant — deliberately excludes full_name (always refreshed) and
// email/id (identity, never rewritten here).
const PROFILE_FIELDS = [
  'phone', 'current_ctc_fixed', 'current_ctc_variable', 'current_esops',
  'expected_ctc', 'notice_period_days', 'current_company', 'current_industry',
  'current_designation', 'current_location', 'years_of_experience', 'resume_drive_link',
  'languages_known',
] as const;

function toNum(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toStr(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

// ─── POST /api/candidates/ingest ───────────────────────────────────────────────
// Called by a Google Apps Script trigger bound to the Job Application Form's
// response sheet, firing on every new form submission (onFormSubmit). Mirrors
// roleIngest.ts's shared-secret auth pattern, but creates (or reuses) both a
// candidate row and — if the applicant's role can be matched — an application
// row linking the two, since Apps Script can't hold a user session for JWT.
router.post('/ingest', async (req: Request, res: Response) => {
  const providedSecret = req.headers['x-ingest-secret'];
  if (!providedSecret || providedSecret !== process.env.CANDIDATE_INGEST_SECRET) {
    res.status(401).json({ error: 'Invalid or missing ingest secret' });
    return;
  }

  const {
    email, full_name, phone, current_ctc_fixed, current_ctc_variable, current_esops,
    expected_ctc, notice_period_days, current_company, current_industry,
    current_designation, current_location, years_of_experience, resume_drive_link,
    languages_known, role_applied_for, preferred_location, qualifications_note,
  } = req.body;

  if (!email || !full_name) {
    res.status(400).json({ error: 'email and full_name are required' });
    return;
  }

  const normEmail = String(email).trim().toLowerCase();
  const submitted: Record<string, number | string | null> = {
    phone: toStr(phone),
    current_ctc_fixed: toNum(current_ctc_fixed),
    current_ctc_variable: toNum(current_ctc_variable),
    current_esops: toNum(current_esops),
    expected_ctc: toNum(expected_ctc),
    notice_period_days: toNum(notice_period_days),
    current_company: toStr(current_company),
    current_industry: toStr(current_industry),
    current_designation: toStr(current_designation),
    current_location: toStr(current_location),
    years_of_experience: toNum(years_of_experience),
    resume_drive_link: toStr(resume_drive_link),
    languages_known: toStr(languages_known),
  };

  const result = await transaction(async (client) => {
    const existingResult = await client.query('SELECT * FROM candidates WHERE email = $1', [normEmail]);
    const existing = existingResult.rows[0] as (Candidate & Record<string, unknown>) | undefined;

    let candidate: Candidate;
    if (existing) {
      // Fill-null-only — a repeat applicant's fresh submission never overwrites
      // fields HR may have since corrected via inline editing (candidate_edit_log).
      const setClauses: string[] = ['full_name = $1'];
      const values: unknown[] = [full_name];
      let idx = 2;
      for (const field of PROFILE_FIELDS) {
        if (existing[field] === null || existing[field] === undefined) {
          const submittedVal = submitted[field];
          if (submittedVal !== null) {
            setClauses.push(`${field} = $${idx++}`);
            values.push(submittedVal);
          }
        }
      }
      values.push(existing.id);
      const updateResult = await client.query(
        `UPDATE candidates SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
      );
      candidate = updateResult.rows[0] as Candidate;
    } else {
      const insertResult = await client.query(
        `INSERT INTO candidates (
           full_name, email, phone,
           current_ctc_fixed, current_ctc_variable, current_esops, expected_ctc,
           notice_period_days, current_company, current_industry, current_designation,
           current_location, years_of_experience, resume_drive_link, languages_known
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [
          full_name, normEmail, submitted.phone,
          submitted.current_ctc_fixed, submitted.current_ctc_variable, submitted.current_esops,
          submitted.expected_ctc, submitted.notice_period_days, submitted.current_company,
          submitted.current_industry, submitted.current_designation, submitted.current_location,
          submitted.years_of_experience, submitted.resume_drive_link, submitted.languages_known,
        ]
      );
      candidate = insertResult.rows[0] as Candidate;
    }

    let application: Record<string, unknown> | null = null;
    let duplicate = false;
    let duplicateApplicationId: string | undefined;
    let warning: string | undefined;

    const roleQuery = toStr(role_applied_for);
    if (roleQuery) {
      // Collapse internal whitespace on both sides, not just leading/trailing —
      // form dropdown text has been seen with stray double-spaces (e.g.
      // "Customer  Success Manager") that a plain trim() wouldn't catch.
      const roleMatches = await client.query(
        `SELECT id, title FROM roles
         WHERE lower(regexp_replace(trim(title), '\\s+', ' ', 'g')) = lower(regexp_replace(trim($1), '\\s+', ' ', 'g'))
         AND status NOT IN ('Closed – Filled', 'Closed – Cancelled')`,
        [roleQuery]
      );

      if (roleMatches.rows.length === 1) {
        const roleId = roleMatches.rows[0].id as string;

        const existingApp = await client.query(
          'SELECT id FROM applications WHERE candidate_id = $1 AND role_id = $2',
          [candidate.id, roleId]
        );

        if (existingApp.rows.length > 0) {
          duplicate = true;
          duplicateApplicationId = existingApp.rows[0].id;
        } else {
          const appResult = await client.query(
            `INSERT INTO applications (
               candidate_id, role_id, source_channel, preferred_location, qualifications_note,
               stage, status, recruiter_screening_status, stage_entry_time, sla_hours
             ) VALUES ($1,$2,'Job Application Form',$3,$4,'Applied','Active','New',NOW(),48) RETURNING *`,
            [candidate.id, roleId, toStr(preferred_location), toStr(qualifications_note)]
          );
          application = appResult.rows[0];

          await client.query(
            `INSERT INTO activity_log (application_id, candidate_id, role_id, event_type, event_detail, performed_by_name)
             VALUES ($1,$2,$3,'Application Created','New application created via Job Application Form',$4)`,
            [(application as { id: string }).id, candidate.id, roleId, 'System']
          );
        }
      } else {
        warning = roleMatches.rows.length === 0
          ? `No open role matched "${roleQuery}"`
          : `Multiple roles matched "${roleQuery}" — ambiguous`;

        await client.query(
          `INSERT INTO activity_log (candidate_id, event_type, event_detail, performed_by_name)
           VALUES ($1, 'Unmatched Role — Manual Reconciliation', $2, $3)`,
          [candidate.id, roleQuery, 'System']
        );
      }
    }

    return { candidate, application, duplicate, duplicateApplicationId, warning };
  });

  if (result.duplicate) {
    res.status(200).json({ message: 'Already ingested — skipped duplicate', application_id: result.duplicateApplicationId });
    return;
  }

  console.log(`[Candidate Ingest] ${result.application ? 'Created application for' : 'Processed'} candidate ${result.candidate.id}${result.warning ? ` — ${result.warning}` : ''}`);
  res.status(201).json({ candidate: result.candidate, application: result.application, warning: result.warning });
});

export default router;
