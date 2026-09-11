// ─── Naukri Excel bulk importer ────────────────────────────────────────────────
// Naukri has no self-serve API for pulling applicant data out of an employer
// account (confirmed via research — everything real routes through a paid,
// account-manager-gated "Zwayam Amplify" integration). The practical fallback
// is Naukri's own recruiter-portal bulk export (Resdex/eApps → Excel, 500-2000
// rows per download) — this script imports that export format directly.
//
// Usage:
//   npx tsx src/scripts/importNaukriExcel.ts <path-to-excel> <role-id> [--dry-run] [--skip-scoring]
//
// <role-id> is required and NOT auto-matched from the Excel's "Job Title"
// column — a real run of this data showed Naukri's own job title
// ("Process & Proposal Manager") doesn't reliably match this system's role
// title ("Manager – Process & Proposals") even after whitespace/dash
// normalization, so guessing here risks silently linking candidates to the
// wrong role (or dropping them). Always pass the exact role id you confirmed
// yourself (check it first: SELECT id, title FROM roles WHERE title ILIKE
// '%...%').
//
// What this does NOT populate, by design (Naukri's own export doesn't carry
// this data, and force-fitting an approximate value would be misleading):
//   - resume_drive_link — the export's "Candidate profile" link points at
//     Naukri's own portal page, not a fetchable resume file; ResumeIQ falls
//     back to profile-fields-only scoring for these, same as any candidate
//     with no resume on file.
//   - expected_ctc — the export only gives current salary, never an asking
//     price, so CTC -> ECTC / Over Budget flagging won't show anything for
//     candidates imported this way.
//
// Idempotent: safe to re-run the same file (or a re-download that includes
// rows already imported) — matches existing candidates by email and skips
// an application that already exists for that (candidate, role) pair.
import 'dotenv/config';
import * as XLSX from 'xlsx';
import { query, queryOne, pool } from '../db/index.js';
import { runResumeIQScoring } from '../services/resumeIQTrigger.js';
import { Candidate } from '../types/index.js';

interface ParsedRow {
  name: string;
  email: string;
  phone: string | null;
  currentLocation: string | null;
  preferredLocation: string | null;
  yearsOfExperience: number | null;
  currentCompany: string | null;
  currentDesignation: string | null;
  currentCtcFixed: number | null;
  noticePeriodDays: number | null;
  applicationDate: string; // ISO date
}

// Fields eligible for the same "fill-null-only" update candidateIngest.ts
// already uses for a repeat applicant — a re-imported/updated Naukri profile
// never overwrites a value HR may have since corrected by hand.
const PROFILE_FIELDS = [
  'phone', 'current_location', 'years_of_experience', 'current_company',
  'current_designation', 'current_ctc_fixed', 'notice_period_days',
] as const;

function cleanText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s.toUpperCase() === 'NA' || s.toUpperCase() === 'N/A') return null;
  return s;
}

// Naukri sometimes puts more than one address in this cell — either the same
// email repeated (a harmless export artifact) or, at least once in a real
// export, two genuinely different addresses. Taking the first is the same
// resolvable-without-guessing convention used for every other ambiguous cell
// here — surfaced in the summary printout so a human can double check.
function cleanEmail(v: unknown): string | null {
  const s = cleanText(v);
  if (!s) return null;
  const first = s.split(',')[0]?.trim().toLowerCase();
  return first || null;
}

function parseSalaryLakhs(v: unknown): number | null {
  const s = cleanText(v);
  if (!s) return null;
  const m = s.match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

function parseExperienceYears(v: unknown): number | null {
  const s = cleanText(v);
  if (!s) return null;
  if (s.trim().toLowerCase() === 'fresher') return 0;
  const m = s.match(/(\d+)\s*Year\(s\)\s*(\d+)\s*Month\(s\)/i);
  if (!m) return null;
  const years = parseInt(m[1], 10);
  const months = parseInt(m[2], 10);
  return Math.round((years + months / 12) * 100) / 100;
}

// "Serving Notice Period" (no specific duration given) deliberately returns
// null rather than a guessed number — same reasoning as leaving
// resume_drive_link/expected_ctc empty rather than force-fitting a value
// the source data doesn't actually contain.
function parseNoticeDays(v: unknown): number | null {
  const s = cleanText(v);
  if (!s) return null;
  const lower = s.toLowerCase();
  const num = s.match(/(\d+)/);
  if (lower.includes('day')) return num ? parseInt(num[1], 10) : null;
  if (lower.includes('month')) return num ? Math.round(parseInt(num[1], 10) * 30) : null;
  return null;
}

function parseApplicationDate(v: unknown): string {
  const s = cleanText(v);
  if (!s) throw new Error(`Unparseable application date: ${JSON.stringify(v)}`);
  // "10-Sep-2026" -> 2026-09-10. Excel dates read via XLSX with
  // cellDates:true come through as JS Date objects instead, handled below.
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) throw new Error(`Unrecognized application date format: ${s}`);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthIdx = months.indexOf(m[2]);
  if (monthIdx === -1) throw new Error(`Unrecognized month in date: ${s}`);
  const day = m[1].padStart(2, '0');
  const month = String(monthIdx + 1).padStart(2, '0');
  return `${m[3]}-${month}-${day}`;
}

function parseWorkbook(filePath: string): ParsedRow[] {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });

  const seen = new Set<string>();
  const parsed: ParsedRow[] = [];

  for (const row of rows) {
    const name = cleanText(row['Name']);
    const email = cleanEmail(row['Email ID']);
    const phone = cleanText(row['Phone Number']);
    const applicationDate = parseApplicationDate(row['Date of application']);
    if (!name || !email) {
      console.warn(`[skip] Row missing name or email: ${JSON.stringify(row).slice(0, 120)}`);
      continue;
    }
    // Exact-duplicate row guard — a real export had one candidate appear
    // twice, identical in every field (name/email/phone/date).
    const dedupeKey = `${name}|${email}|${phone}|${applicationDate}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    parsed.push({
      name,
      email,
      phone,
      currentLocation: cleanText(row['Current Location']),
      preferredLocation: cleanText(row['Preferred Locations']),
      yearsOfExperience: parseExperienceYears(row['Total Experience']),
      currentCompany: cleanText(row['Curr. Company name']),
      currentDesignation: cleanText(row['Curr. Company Designation']),
      currentCtcFixed: parseSalaryLakhs(row['Annual Salary']),
      noticePeriodDays: parseNoticeDays(row['Notice period/ Availability to join']),
      applicationDate,
    });
  }
  return parsed;
}

async function findOrCreateCandidate(row: ParsedRow, dryRun: boolean): Promise<{ id: string; isNew: boolean }> {
  const existing = await queryOne<Candidate>('SELECT * FROM candidates WHERE lower(email) = lower($1)', [row.email]);

  if (existing) {
    const updates: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const candidateAsRecord = existing as unknown as Record<string, unknown>;
    const fieldValues: Record<(typeof PROFILE_FIELDS)[number], unknown> = {
      phone: row.phone,
      current_location: row.currentLocation,
      years_of_experience: row.yearsOfExperience,
      current_company: row.currentCompany,
      current_designation: row.currentDesignation,
      current_ctc_fixed: row.currentCtcFixed,
      notice_period_days: row.noticePeriodDays,
    };
    for (const field of PROFILE_FIELDS) {
      if (candidateAsRecord[field] === null && fieldValues[field] !== null) {
        updates.push(`${field} = $${i++}`);
        values.push(fieldValues[field]);
      }
    }
    if (updates.length && !dryRun) {
      values.push(existing.id);
      await query(`UPDATE candidates SET ${updates.join(', ')} WHERE id = $${i}`, values);
    }
    return { id: existing.id, isNew: false };
  }

  if (dryRun) return { id: '(new)', isNew: true };

  const created = await queryOne<{ id: string }>(
    `INSERT INTO candidates (
       full_name, email, phone, current_location, years_of_experience,
       current_company, current_designation, current_ctc_fixed, notice_period_days, source
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Naukri/IIMjobs') RETURNING id`,
    [row.name, row.email, row.phone, row.currentLocation, row.yearsOfExperience,
     row.currentCompany, row.currentDesignation, row.currentCtcFixed, row.noticePeriodDays]
  );
  return { id: created!.id, isNew: true };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipScoring = args.includes('--skip-scoring');
  const positional = args.filter(a => !a.startsWith('--'));
  const [filePath, roleId] = positional;

  if (!filePath || !roleId) {
    console.error('Usage: npx tsx src/scripts/importNaukriExcel.ts <path-to-excel> <role-id> [--dry-run] [--skip-scoring]');
    process.exit(1);
  }

  const role = await queryOne<{ id: string; title: string }>('SELECT id, title FROM roles WHERE id = $1', [roleId]);
  if (!role) {
    console.error(`No role found with id "${roleId}". Look it up first: SELECT id, title FROM roles WHERE title ILIKE '%...%';`);
    process.exit(1);
  }

  console.log(`${dryRun ? '[DRY RUN] ' : ''}Importing "${filePath}" -> role ${role.id} (${role.title})`);
  const rows = parseWorkbook(filePath);
  console.log(`Parsed ${rows.length} unique candidate rows.`);

  let candidatesCreated = 0, candidatesMatched = 0, applicationsCreated = 0, applicationsSkipped = 0;
  let scored = 0, scoringFailed = 0;
  const scoringErrors: string[] = [];

  for (const row of rows) {
    const { id: candidateId, isNew } = await findOrCreateCandidate(row, dryRun);
    isNew ? candidatesCreated++ : candidatesMatched++;

    if (dryRun) continue;

    const existingApp = await queryOne<{ id: string }>(
      'SELECT id FROM applications WHERE candidate_id = $1 AND role_id = $2',
      [candidateId, role.id]
    );
    if (existingApp) {
      applicationsSkipped++;
      continue;
    }

    const app = await queryOne<{ id: string }>(
      `INSERT INTO applications (
         candidate_id, role_id, application_date, source_channel, preferred_location, stage_entry_time, sla_hours
       ) VALUES ($1,$2,$3::timestamptz,'Naukri Excel Import',$4,$3::timestamptz,48) RETURNING id`,
      [candidateId, role.id, row.applicationDate, row.preferredLocation]
    );
    applicationsCreated++;

    await query(
      `INSERT INTO activity_log (application_id, candidate_id, role_id, event_type, event_detail, performed_by_name)
       VALUES ($1,$2,$3,'Application Created','New application created via Naukri Excel Import','System')`,
      [app!.id, candidateId, role.id]
    );

    // Synchronous, not fire-and-forget — same reasoning as every other
    // creation path in this codebase (see CLAUDE.md's Vercel async rule).
    // This script itself only ever runs locally/on-demand, but the rule
    // this mirrors is about never leaving a created application unscored
    // with no trace of why, not specifically about Vercel.
    if (!skipScoring) {
      try {
        const result = await runResumeIQScoring(app!.id);
        if (result.scored) scored++;
        else { scoringFailed++; scoringErrors.push(`${row.email}: ${result.error}`); }
      } catch (err) {
        scoringFailed++;
        scoringErrors.push(`${row.email}: ${(err as Error).message}`);
      }
    }
  }

  console.log('\n─── Summary ───');
  console.log(`Candidates created:      ${candidatesCreated}`);
  console.log(`Candidates matched (existing, fill-null-only update): ${candidatesMatched}`);
  console.log(`Applications created:    ${applicationsCreated}`);
  console.log(`Applications skipped (already existed for this role): ${applicationsSkipped}`);
  if (!skipScoring && !dryRun) {
    console.log(`Scored successfully:     ${scored}`);
    console.log(`Scoring failed:          ${scoringFailed}`);
    if (scoringErrors.length) {
      console.log('Scoring errors (retry individually from Scorecard Summary\'s "Retry scoring"):');
      scoringErrors.forEach(e => console.log(`  - ${e}`));
    }
  }
  if (skipScoring && !dryRun) {
    console.log('Scoring skipped (--skip-scoring) — use Scorecard Summary\'s "Retry scoring" banner to score these later.');
  }
  if (dryRun) {
    console.log('\nDry run only — nothing was written. Re-run without --dry-run to actually import.');
  }

  await pool.end();
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
