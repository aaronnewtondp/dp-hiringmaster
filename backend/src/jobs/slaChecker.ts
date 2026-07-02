import { query, queryOne, transaction } from '../db/index.js';
import { SLA_HOURS, AGING_THRESHOLDS, Priority } from '../types/index.js';

// ─── Main SLA check — called by scheduler every 15 minutes ───────────────────
export async function runSlaCheck(): Promise<void> {
  const start = Date.now();
  console.log(`[SLA] Running check at ${new Date().toISOString()}`);

  await Promise.all([
    checkApplicationSLAs(),
    checkAssignmentDeadlines(),
    checkRoleAging(),
    checkJoiningRisk(),
  ]);

  console.log(`[SLA] Check complete in ${Date.now() - start}ms`);
}

// ─── 1. Application-level SLA breaches ───────────────────────────────────────
async function checkApplicationSLAs(): Promise<void> {
  const apps = await query<{
    id: string; stage: string; status: string;
    stage_entry_time: string; sla_hours: number; sla_breach: boolean;
    ai_fit_score: number; candidate_id: string; role_id: string;
  }>(`
    SELECT a.id, a.stage, a.status, a.stage_entry_time, a.sla_hours,
           a.sla_breach, a.ai_fit_score, a.candidate_id, a.role_id
    FROM applications a
    WHERE a.status = 'Active'
      AND a.stage NOT IN ('Joined','Offer Accepted')
      AND a.stage_entry_time IS NOT NULL
  `);

  for (const app of apps) {
    const hoursInStage = (Date.now() - new Date(app.stage_entry_time).getTime()) / 3600000;
    const slaHrs = app.sla_hours || getSlaForStage(app.stage, app.ai_fit_score);

    if (hoursInStage > slaHrs && !app.sla_breach) {
      // Mark breach on application
      await query('UPDATE applications SET sla_breach=true WHERE id=$1', [app.id]);

      // Determine owner
      const ownerType = getOwnerForStage(app.stage);
      const actionType = getActionTypeForStage(app.stage);

      // Look up names for display
      const cand = await queryOne<{ full_name: string }>('SELECT full_name FROM candidates WHERE id=$1', [app.candidate_id]);
      const role = await queryOne<{ title: string }>('SELECT title FROM roles WHERE id=$1', [app.role_id]);

      // Resolve any previous action of same type for this app (avoid duplicates)
      await query(
        `UPDATE pending_actions SET resolved=true, resolved_at=NOW()
         WHERE application_id=$1 AND action_type=$2 AND resolved=false`,
        [app.id, actionType]
      );

      // Create new pending action
      await query(
        `INSERT INTO pending_actions
           (owner_type, priority_level, action_type, description, application_id,
            candidate_name, role_title, hours_overdue)
         VALUES ($1,'High',$2,$3,$4,$5,$6,$7)`,
        [
          ownerType, actionType,
          `${actionType} — ${Math.floor(hoursInStage - slaHrs)}h overdue`,
          app.id, cand?.full_name || 'Unknown', role?.title || 'Unknown',
          Math.max(0, hoursInStage - slaHrs),
        ]
      );
    } else if (hoursInStage <= slaHrs && app.sla_breach) {
      // SLA recovered — clear breach (e.g. stage was updated)
      await query('UPDATE applications SET sla_breach=false WHERE id=$1', [app.id]);
      await query(
        `UPDATE pending_actions SET resolved=true, resolved_at=NOW()
         WHERE application_id=$1 AND resolved=false`,
        [app.id]
      );
    }
  }
}

// ─── 2. Assignment 60-hour deadline ─────────────────────────────────────────
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
      `INSERT INTO pending_actions (owner_type, priority_level, action_type, description, application_id, candidate_name, role_title, hours_overdue)
       VALUES ('HR / Recruiter','High','Assignment deadline breached',
         'Assignment not submitted by deadline for '||$3||' – '||$4, $1, $3, $4, $5)`,
      [
        round.application_id, null, cand?.full_name || '', role?.title || '',
        Math.floor((Date.now() - new Date(round.assignment_deadline).getTime()) / 3600000),
      ]
    );
  }
}

// ─── 3. Role aging alerts ────────────────────────────────────────────────────
async function checkRoleAging(): Promise<void> {
  const roles = await query<{ id: string; title: string; priority: string; start_date: string }>(`
    SELECT id, title, priority, start_date
    FROM roles
    WHERE status = 'Live – Sourcing' AND start_date IS NOT NULL
  `);

  const now = Date.now();
  for (const role of roles) {
    const days = Math.floor((now - new Date(role.start_date).getTime()) / 86400000);
    const thresh = AGING_THRESHOLDS[role.priority as Priority] || AGING_THRESHOLDS.P1;

    if (days >= thresh.red) {
      const existing = await queryOne(
        `SELECT id FROM pending_actions WHERE role_title=$1 AND action_type='Role aging alert' AND resolved=false`,
        [role.title]
      );
      if (!existing) {
        await query(
          `INSERT INTO pending_actions (owner_type, priority_level, action_type, description, role_title, hours_overdue)
           VALUES ('Leadership / Founders','High','Role aging alert',
             $1||' ('||$2||') — '||$3||' days open (Red Alert)', $1, 0)`,
          [role.title, role.priority, days]
        );
      }
    }
  }
}

// ─── 4. Joining risk — no HR contact in 5 days after Offer Accepted ──────────
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
      `INSERT INTO pending_actions (owner_type, priority_level, action_type, description, application_id, candidate_name, role_title, hours_overdue)
       VALUES ('HR / Recruiter','High','Joining risk — no contact',
         'No HR contact logged in 5+ days for '||$3||' (Offer Accepted)', $1, $3, $4, 120)`,
      [app.id, null, cand?.full_name || '', role?.title || '']
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getSlaForStage(stage: string, fitScore?: number): number {
  if (stage === 'Resume Review') return fitScore && fitScore >= 75 ? SLA_HOURS.RESUME_REVIEW_HIGH_FIT : SLA_HOURS.RESUME_REVIEW_NORMAL;
  if (stage === 'Shortlisted') return SLA_HOURS.HM_SHORTLIST;
  if (stage.startsWith('Interview')) return SLA_HOURS.INTERVIEW_FEEDBACK;
  if (stage === 'Final Evaluation') return SLA_HOURS.FINAL_EVAL;
  if (stage === 'Reference Check') return SLA_HOURS.REF_INIT;
  if (stage === 'Offer Released') return SLA_HOURS.OFFER_RELEASE;
  return SLA_HOURS.IDLE;
}

function getOwnerForStage(stage: string): string {
  if (stage === 'Shortlisted') return 'Hiring Manager';
  if (stage.startsWith('Interview')) return 'Hiring Manager';
  return 'HR / Recruiter';
}

function getActionTypeForStage(stage: string): string {
  if (stage === 'Resume Review') return 'Resume to triage';
  if (stage === 'Shortlisted') return 'HM shortlist review';
  if (stage.startsWith('Interview')) return 'Interview feedback due';
  if (stage === 'Final Evaluation') return 'Final evaluation decision';
  if (stage === 'Reference Check') return 'Reference check to initiate';
  if (stage === 'Offer Released') return 'Offer follow-up';
  return 'Idle candidate';
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
