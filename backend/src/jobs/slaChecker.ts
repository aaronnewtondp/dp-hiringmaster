import { query, queryOne, transaction } from '../db/index.js';
import { Priority } from '../types/index.js';
import { computeAging } from '../utils/aging.js';

// ─── Main SLA check — called by scheduler every 15 minutes ───────────────────
export async function runSlaCheck(): Promise<void> {
  const start = Date.now();
  console.log(`[SLA] Running check at ${new Date().toISOString()}`);

  await Promise.all([
    resolveOrphanedActions(),
    checkFlatStageBreaches(),
    checkNotYetActioned(),
    checkFeedbackDue(),
    checkAssignmentDeadlines(),
    checkRoleAging(),
    checkJoiningRisk(),
  ]);

  console.log(`[SLA] Check complete in ${Date.now() - start}ms`);
}

// ─── 0. Safety net: resolve any application-linked pending_actions left
// dangling by an application that's no longer Active (rejected, withdrawn,
// on hold, or joined). The breach checks below already guard against the
// specific race that causes this going forward, but this sweep also covers
// any other path that creates the same kind of orphan, and cleans up
// whatever already exists. Role-level actions ('Role aging alert') and the
// compensation-change flag have no application_id, so the join here never
// touches them.
async function resolveOrphanedActions(): Promise<void> {
  await query(`
    UPDATE pending_actions pa
    SET resolved = true, resolved_at = NOW()
    FROM applications a
    WHERE pa.application_id = a.id
      AND pa.resolved = false
      AND a.status <> 'Active'
  `);
}

// ─── Breach engine — stage/breach-type table ─────────────────────────────────
// Every check below only ever considers status='Active' applications. Each
// stage's breach-type set is exhaustive and mutually exclusive by
// construction — "Idle Candidate" only ever appears for a stage with no
// other breach type defined for it, never as a runtime fallback race.
const BREACH_IDLE_HOURS = 48;
const BREACH_STANDARD_HOURS = 48;              // Applied / Not-Scheduled / Feedback-Due
const BREACH_ASSIGNMENT_FEEDBACK_HOURS = 96;

type Owner = 'HR / Recruiter' | 'Hiring Manager';

// Shared tail for every breach-type check below — batched across ALL
// breached applications for one config at once, not one row at a time.
// The original per-row version did up to 5 sequential round trips per
// breach (atomic flip, candidate lookup, role lookup, resolve-stale,
// insert) — fine locally, but with production's real network latency to
// Supabase, a stage with a few hundred genuinely-overdue applications
// turned into a thousand-plus serialized round trips on the dashboard's
// synchronous critical path (maybeRunSlaCheck awaits this before
// responding), which is exactly the kind of load that either times out or
// just makes the page look like it's "crashed" from the user's side.
// candidate_name/role_title/hiring_manager_name are now pre-joined by each
// caller's own SELECT instead of looked up per row here.
async function applyBreachBatch(
  apps: Array<{ id: string; role_id: string; candidate_name: string; role_title: string; hiring_manager_name: string | null; hoursOverdue: number }>,
  actionType: string,
  ownerType: Owner
): Promise<void> {
  if (apps.length === 0) return;

  // Atomically flip sla_breach for every candidate row in one statement,
  // re-checking status='Active' the same way the per-row version did — a
  // concurrent status change landing in the gap between this batch's SELECT
  // and now is still caught, just for the whole batch instead of one row.
  const stillActiveRows = await query<{ id: string }>(
    `UPDATE applications SET sla_breach=true WHERE id = ANY($1::text[]) AND status='Active' RETURNING id`,
    [apps.map(a => a.id)]
  );
  const stillActiveIds = new Set(stillActiveRows.map(r => r.id));
  const activeApps = apps.filter(a => stillActiveIds.has(a.id));
  if (activeApps.length === 0) return;

  await query(
    `UPDATE pending_actions SET resolved=true, resolved_at=NOW()
     WHERE application_id = ANY($1::text[]) AND action_type=$2 AND resolved=false`,
    [activeApps.map(a => a.id), actionType]
  );

  await query(
    `INSERT INTO pending_actions
       (owner_type, priority_level, action_type, description, application_id,
        candidate_name, role_title, hours_overdue, role_id, responsible_person)
     SELECT $1, 'High', $2, $2||' — '||floor(d.hours_overdue)||'h overdue',
            d.application_id, d.candidate_name, d.role_title, d.hours_overdue, d.role_id, d.responsible_person
     FROM unnest($3::text[], $4::text[], $5::text[], $6::numeric[], $7::text[], $8::text[])
       AS d(application_id, candidate_name, role_title, hours_overdue, role_id, responsible_person)`,
    [
      ownerType, actionType,
      activeApps.map(a => a.id),
      activeApps.map(a => a.candidate_name || 'Unknown'),
      activeApps.map(a => a.role_title || 'Unknown'),
      activeApps.map(a => Math.max(0, a.hoursOverdue)),
      activeApps.map(a => a.role_id),
      activeApps.map(a => (ownerType === 'Hiring Manager' ? a.hiring_manager_name || null : null)),
    ]
  );
}

// ─── 1. Flat, stage-entry-time-anchored breaches (no round involved) ─────────
// Reference Check / Pre-Joining Documents / Offer Discussion / Offer
// Released all share the plain "Idle Candidate" catch-all. Applied gets its
// own named breach type and owner instead (below) — 2026-09-01: 'Resume
// Review' and 'Shortlisted' were retired as distinct stages (every
// application is scored automatically at Applied now, and "Shortlist"
// advances straight to Interview Round 1), so "Resume Shortlist Pending"
// now measures from Applied instead, and the old "Interview to be
// Scheduled" (fired at Shortlisted) is dropped outright — once shortlisting
// lands a candidate directly at Interview Round 1, "Interview 1 Not
// Scheduled" below (NOT_YET_ACTIONED_STAGES) already covers exactly the
// same "no round booked yet" condition; keeping both would have been two
// breach types firing for the same thing.
const FLAT_STAGE_CHECKS: Array<{ stages: string[]; actionType: string; owner: Owner }> = [
  { stages: ['Reference Check', 'Pre-Joining Documents', 'Offer Discussion', 'Offer Released'], actionType: 'Idle Candidate', owner: 'HR / Recruiter' },
  { stages: ['Applied'], actionType: 'Resume Shortlist Pending', owner: 'Hiring Manager' },
];

async function checkFlatStageBreaches(): Promise<void> {
  for (const cfg of FLAT_STAGE_CHECKS) {
    const apps = await query<{ id: string; role_id: string; stage_entry_time: string;
             candidate_name: string; role_title: string; hiring_manager_name: string | null }>(
      `SELECT a.id, a.role_id, a.stage_entry_time,
              c.full_name AS candidate_name, r.title AS role_title, r.hiring_manager_name
       FROM applications a
       JOIN candidates c ON c.id = a.candidate_id
       JOIN roles r ON r.id = a.role_id
       WHERE a.status='Active' AND a.stage = ANY($1) AND a.stage_entry_time IS NOT NULL`,
      [cfg.stages]
    );
    const thresholdHours = cfg.actionType === 'Idle Candidate' ? BREACH_IDLE_HOURS : BREACH_STANDARD_HOURS;
    const breached = apps
      .map(app => ({ ...app, hoursOverdue: (Date.now() - new Date(app.stage_entry_time).getTime()) / 3600000 - thresholdHours }))
      .filter(app => app.hoursOverdue > 0);
    await applyBreachBatch(breached, cfg.actionType, cfg.owner);
  }
}

// ─── 2. "Not yet actioned" breaches (Interview 1/2, Founders Round, Assignment) ─
// Fires when NO interview_rounds row of the matching round_type — created
// at or after this stage visit began (stage_entry_time) — has its anchor
// column (scheduled_date for Standard rounds, assignment_send_date for
// Assignment) actually set. A round row that exists but is still "TBD"
// (anchor column null) doesn't count as actioned.
type NotYetActionedConfig = {
  stage: string; roundType: 'Standard' | 'Assignment';
  anchorColumn: 'scheduled_date' | 'assignment_send_date'; actionType: string;
};
const NOT_YET_ACTIONED_STAGES: NotYetActionedConfig[] = [
  { stage: 'Interview Round 1', roundType: 'Standard', anchorColumn: 'scheduled_date', actionType: 'Interview 1 Not Scheduled' },
  { stage: 'Interview Round 2', roundType: 'Standard', anchorColumn: 'scheduled_date', actionType: 'Interview 2 Not Scheduled' },
  { stage: 'Founders Round', roundType: 'Standard', anchorColumn: 'scheduled_date', actionType: 'Founders Round Not Scheduled' },
  { stage: 'Assignment Round', roundType: 'Assignment', anchorColumn: 'assignment_send_date', actionType: 'Assignment Not Sent' },
];

async function checkNotYetActioned(): Promise<void> {
  for (const cfg of NOT_YET_ACTIONED_STAGES) {
    // anchorColumn/roundType are fixed values from the internal config array
    // above, never user input — safe to interpolate as a column/value
    // identifier rather than a bound parameter (Postgres can't parameterize
    // column names).
    const apps = await query<{ id: string; role_id: string; stage_entry_time: string;
             candidate_name: string; role_title: string; hiring_manager_name: string | null }>(
      `SELECT a.id, a.role_id, a.stage_entry_time,
              c.full_name AS candidate_name, r.title AS role_title, r.hiring_manager_name
       FROM applications a
       JOIN candidates c ON c.id = a.candidate_id
       JOIN roles r ON r.id = a.role_id
       WHERE a.status='Active' AND a.stage=$1 AND a.stage_entry_time IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM interview_rounds ir
           WHERE ir.application_id = a.id AND ir.round_type = $2
             AND ir.created_at >= a.stage_entry_time AND ir.${cfg.anchorColumn} IS NOT NULL
         )`,
      [cfg.stage, cfg.roundType]
    );
    const breached = apps
      .map(app => ({ ...app, hoursOverdue: (Date.now() - new Date(app.stage_entry_time).getTime()) / 3600000 - BREACH_STANDARD_HOURS }))
      .filter(app => app.hoursOverdue > 0);
    await applyBreachBatch(breached, cfg.actionType, 'HR / Recruiter');
  }
}

// ─── 3. "Feedback due" breaches (Interview 1/2, Founders Round, Assignment) ──
// Fires once a round of the matching type (created since this stage visit
// began) has its anchor column set, feedback hasn't been submitted, and the
// threshold has elapsed since that anchor time (not since stage entry —
// waiting on a future-dated interview is never a breach). DISTINCT ON picks
// the most recently anchored qualifying round per application, in the rare
// case more than one exists.
type FeedbackDueConfig = {
  stage: string; roundType: 'Standard' | 'Assignment';
  anchorColumn: 'scheduled_date' | 'assignment_send_date';
  thresholdHours: number; actionType: string;
};
const FEEDBACK_DUE_STAGES: FeedbackDueConfig[] = [
  { stage: 'Interview Round 1', roundType: 'Standard', anchorColumn: 'scheduled_date', thresholdHours: BREACH_STANDARD_HOURS, actionType: 'Interview 1 Feedback Due' },
  { stage: 'Interview Round 2', roundType: 'Standard', anchorColumn: 'scheduled_date', thresholdHours: BREACH_STANDARD_HOURS, actionType: 'Interview 2 Feedback Due' },
  { stage: 'Founders Round', roundType: 'Standard', anchorColumn: 'scheduled_date', thresholdHours: BREACH_STANDARD_HOURS, actionType: 'Founders Round Feedback Due' },
  { stage: 'Assignment Round', roundType: 'Assignment', anchorColumn: 'assignment_send_date', thresholdHours: BREACH_ASSIGNMENT_FEEDBACK_HOURS, actionType: 'Assignment Feedback Due' },
];

export const FEEDBACK_DUE_ACTION_TYPES = FEEDBACK_DUE_STAGES.map(s => s.actionType);
export const NOT_SCHEDULED_ACTION_TYPES = NOT_YET_ACTIONED_STAGES
  .filter(s => s.roundType === 'Standard')
  .map(s => s.actionType);

async function checkFeedbackDue(): Promise<void> {
  for (const cfg of FEEDBACK_DUE_STAGES) {
    const rows = await query<{ id: string; role_id: string; anchor_time: string;
             candidate_name: string; role_title: string; hiring_manager_name: string | null }>(
      `SELECT DISTINCT ON (a.id) a.id, a.role_id, ir.${cfg.anchorColumn} AS anchor_time,
              c.full_name AS candidate_name, r.title AS role_title, r.hiring_manager_name
       FROM applications a
       JOIN candidates c ON c.id = a.candidate_id
       JOIN roles r ON r.id = a.role_id
       JOIN interview_rounds ir ON ir.application_id = a.id
         AND ir.round_type = $2
         AND ir.created_at >= a.stage_entry_time
         AND ir.${cfg.anchorColumn} IS NOT NULL
         AND ir.feedback_status != 'Submitted'
       WHERE a.status='Active' AND a.stage=$1
       ORDER BY a.id, ir.${cfg.anchorColumn} DESC`,
      [cfg.stage, cfg.roundType]
    );
    const breached = rows
      .map(row => ({ ...row, hoursOverdue: (Date.now() - new Date(row.anchor_time).getTime()) / 3600000 - cfg.thresholdHours }))
      .filter(row => row.hoursOverdue > 0);
    await applyBreachBatch(breached, cfg.actionType, 'Hiring Manager');
  }
}

// Every action_type any breach check above can produce — applications.ts
// uses this exact list to resolve a still-open stage-SLA action the moment
// an application's stage changes, since one of these existing for the OLD
// stage is stale the instant the application moves on.
export const STAGE_SLA_ACTION_TYPES = [
  'Idle Candidate', 'Resume Shortlist Pending',
  ...NOT_YET_ACTIONED_STAGES.map(s => s.actionType),
  ...FEEDBACK_DUE_STAGES.map(s => s.actionType),
] as const;

// ─── 4. Assignment 60-hour hard submission deadline ─────────────────────────
// Independent of "Assignment Feedback Due" above (96h, requires feedback not
// yet submitted) — this is a separate, harder deadline: the candidate never
// submitted anything at all within 60h of the assignment being sent.
async function checkAssignmentDeadlines(): Promise<void> {
  const overdue = await query<{ id: string; application_id: string; assignment_deadline: string }>(`
    SELECT ir.id, ir.application_id, ir.assignment_deadline
    FROM interview_rounds ir
    WHERE ir.round_type = 'Assignment'
      AND ir.assignment_send_date IS NOT NULL
      AND ir.assignment_submission_date IS NULL
      AND ir.assignment_deadline < NOW()
  `);

  for (const round of overdue) {
    const existing = await queryOne(
      `SELECT id FROM pending_actions WHERE application_id=$1 AND action_type='Assignment deadline breached' AND resolved=false`,
      [round.application_id]
    );
    if (existing) continue;

    const app = await queryOne<{ candidate_id: string; role_id: string }>(
      'SELECT candidate_id, role_id FROM applications WHERE id=$1', [round.application_id]
    );
    const cand = await queryOne<{ full_name: string }>('SELECT full_name FROM candidates WHERE id=$1', [app?.candidate_id]);
    const role = await queryOne<{ title: string }>('SELECT title FROM roles WHERE id=$1', [app?.role_id]);

    await query(
      `INSERT INTO pending_actions (owner_type, priority_level, action_type, description, application_id, candidate_name, role_title, hours_overdue, role_id)
       VALUES ('HR / Recruiter','High','Assignment deadline breached',
         'Assignment not submitted by deadline for '||$2||' – '||$3, $1, $2, $3, $4, $5)`,
      [
        round.application_id, cand?.full_name || '', role?.title || '',
        Math.floor((Date.now() - new Date(round.assignment_deadline).getTime()) / 3600000),
        app?.role_id || null,
      ]
    );
  }
}

// ─── 5. Role aging alerts ────────────────────────────────────────────────────
// Matches computeAging()'s target_closure_date-driven semantics (roles.ts /
// dashboard.ts both use the same shared function) so this Leadership
// notification never disagrees with what the Roles/Dashboard pages
// themselves show — previously this duplicated the OLD days-open-only
// logic independently, so a role could show "not overdue" everywhere in
// the UI while still carrying a stale red pending_action from before
// Close Target was ever set or was later pushed out.
async function checkRoleAging(): Promise<void> {
  // Approved counts too, not just Live – Sourcing — a role's aging clock
  // starts the moment it's approved (Open Date is set then, see roles.ts),
  // so it can already be overdue on its Close Target before it's even
  // posted for sourcing.
  const roles = await query<{ id: string; title: string; priority: string; start_date: string; target_closure_date: string | null; status: string }>(`
    SELECT id, title, priority, start_date, target_closure_date, status
    FROM roles
    WHERE status IN ('Approved', 'Live – Sourcing') AND start_date IS NOT NULL
  `);

  for (const role of roles) {
    const { days_overdue, aging_alert } = computeAging(role.start_date, role.target_closure_date, role.priority as Priority, role.status);

    if (aging_alert === 'red') {
      const existing = await queryOne(
        `SELECT id FROM pending_actions WHERE role_title=$1 AND action_type='Role aging alert' AND resolved=false`,
        [role.title]
      );
      if (!existing) {
        await query(
          `INSERT INTO pending_actions (owner_type, priority_level, action_type, description, role_title, hours_overdue, role_id)
           VALUES ('Leadership / Founders','High','Role aging alert',
             $1||' ('||$2||') — '||$3||' days overdue on Close Target (Red Alert)', $1, 0, $4)`,
          [role.title, role.priority, days_overdue, role.id]
        );
      }
    } else {
      // No longer overdue (Close Target pushed out, or was cleared) —
      // resolve any lingering alert rather than leaving it stuck open.
      await query(
        `UPDATE pending_actions SET resolved=true, resolved_at=NOW()
         WHERE role_title=$1 AND action_type='Role aging alert' AND resolved=false`,
        [role.title]
      );
    }
  }
}

// ─── 6. Joining risk — no HR contact in 5 days after Offer Accepted ──────────
async function checkJoiningRisk(): Promise<void> {
  const atRisk = await query<{ id: string; candidate_id: string; role_id: string }>(`
    UPDATE applications
    SET joining_risk_auto_flag = true
    WHERE stage = 'Offer Accepted'
      AND status = 'Active'
      AND joining_risk_auto_flag = false
      AND (last_hr_contact IS NULL OR last_hr_contact < NOW() - INTERVAL '5 days')
    RETURNING id, candidate_id, role_id
  `);

  for (const app of atRisk) {
    const cand = await queryOne<{ full_name: string }>('SELECT full_name FROM candidates WHERE id=$1', [app.candidate_id]);
    const role = await queryOne<{ title: string }>('SELECT title FROM roles WHERE id=$1', [app.role_id]);
    await query(
      `INSERT INTO pending_actions (owner_type, priority_level, action_type, description, application_id, candidate_name, role_title, hours_overdue, role_id)
       VALUES ('HR / Recruiter','High','Joining risk — no contact',
         'No HR contact logged in 5+ days for '||$2||' (Offer Accepted)', $1, $2, $3, 120, $4)`,
      [app.id, cand?.full_name || '', role?.title || '', app.role_id]
    );
  }
}

// ─── Daily email digest ───────────────────────────────────────────────────────
export async function sendDailyDigest(): Promise<void> {
  const nodemailer = await import('nodemailer');
  const actions = await query<{ owner_type: string; action_type: string; description: string; candidate_name: string; role_title: string; hours_overdue: number }>(`
    SELECT * FROM pending_actions WHERE resolved=false ORDER BY owner_type, priority_level DESC
  `);

  if (actions.length === 0) { console.log('[Digest] No pending actions — skipping email'); return; }

  const byOwner: Record<string, typeof actions> = {};
  for (const a of actions) {
    if (!byOwner[a.owner_type]) byOwner[a.owner_type] = [];
    byOwner[a.owner_type].push(a);
  }

  let body = `DigitalPaani HMS — Daily Pending Actions\n`;
  body += `Date: ${new Date().toDateString()} | Total: ${actions.length} open\n\n`;
  for (const [owner, items] of Object.entries(byOwner)) {
    body += `── ${owner} (${items.length}) ──\n`;
    items.forEach(i => {
      body += `  • [${i.action_type}] ${i.description}\n`;
      if (i.candidate_name) body += `    Candidate: ${i.candidate_name} | Role: ${i.role_title}\n`;
    });
    body += '\n';
  }

  try {
    const transporter = nodemailer.default.createTransport({
      host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587'),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to:   process.env.HR_EMAIL,
      subject: `[DigitalPaani HMS] ${actions.length} Pending Actions — ${new Date().toDateString()}`,
      text: body,
    });
    console.log(`[Digest] Sent to ${process.env.HR_EMAIL}`);
  } catch (err) {
    console.error('[Digest] Email failed:', err);
  }
}
