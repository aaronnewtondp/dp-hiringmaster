import { Router, Request, Response } from 'express';
import { query, queryOne, transaction } from '../db/index.js';
import { authenticate, requireHR, isHRTier, canSeeCompForRole, stripRestrictedFields } from '../middleware/auth.js';
import { Role, STAGE_ORDER } from '../types/index.js';
import { generateJdContent } from '../services/jdContent.js';
import { renderLongFormJd } from '../services/pdf/longFormJd.js';
import { renderSocialJd } from '../services/pdf/socialJd.js';
import { renderRoleClosureSummary } from '../services/pdf/roleClosureSummary.js';
import { uploadJdPdf } from '../services/driveService.js';
import { parseRoleFilters, buildRoleFilterSql } from '../utils/roleFilters.js';
import { getCompBenchmark } from '../services/compBenchmark.js';
import { computeAging } from '../utils/aging.js';
import { ALL_BREACH_ACTION_TYPES } from '../jobs/slaChecker.js';

const router = Router();
router.use(authenticate);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function enrichRole(role: Role) {
  const { days_open, days_overdue, aging_alert } = computeAging(
    role.start_date || null, role.target_closure_date || null, role.priority, role.status
  );
  return { ...role, days_open, days_overdue, aging_alert };
}

// ─── GET /api/roles — list all roles with computed fields ─────────────────────
router.get('/', async (req: Request, res: Response) => {
  const filters = parseRoleFilters(req.query as Record<string, unknown>);
  const filterFragment = buildRoleFilterSql(filters, 1);

  const sql = `
    SELECT r.*,
      COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'Active') AS active_candidate_count,
      COUNT(DISTINCT a.id) FILTER (
        WHERE a.status = 'Active'
        AND a.stage IN ('Interview Round 1','Interview Round 2',
                         'Assignment Round','Founders Round')
      ) AS shortlisted_count
    FROM roles r
    LEFT JOIN applications a ON a.role_id = r.id
    WHERE 1=1
    ${filterFragment.sql}
    GROUP BY r.id ORDER BY r.priority ASC, r.start_date DESC
  `;

  const roles = await query<Role>(sql, filterFragment.params);

  // ctc_band visible to HR-tier always, and to a Hiring Manager only for
  // the specific role(s) they're assigned to (canSeeCompForRole) — every
  // other role stays stripped for them, same as before this existed.
  const persona = req.user!.persona;
  const result = roles.map(r => {
    const enriched = enrichRole(r);
    const canSeeComp = canSeeCompForRole(persona, req.user!.name, r.hiring_manager_name);
    if (!canSeeComp) {
      const { ctc_band: _ctc, ...safe } = enriched as Role & { ctc_band: string };
      return safe;
    }
    return enriched;
  });

  res.json({ roles: result });
});

// ─── GET /api/roles/filter-options — distinct values for the filter dropdowns ──
// Recruitment Mode and the Role list are genuinely data-driven (whatever the
// requisition form has actually sent, or whichever roles currently exist) —
// Department/Location/Priority/Status are fixed, known enums the frontend
// already hardcodes (Department used to be derived from roles.department,
// but that's noisy test/legacy data, not a reliable proxy for the form's
// real dropdown options — see frontend's DEPARTMENTS const).
// Must be registered before GET /:id so "filter-options" isn't swallowed as
// a role id.
router.get('/filter-options', async (_req: Request, res: Response) => {
  const [recruitmentModes, roles] = await Promise.all([
    query<{ mode: string }>(
      `SELECT DISTINCT unnest(recruitment_mode) AS mode FROM roles WHERE recruitment_mode IS NOT NULL ORDER BY mode`
    ),
    // Role master filter (Dashboard + Candidates) — every role not in a
    // Closed state, so it stays current automatically as roles are created
    // or closed, with no separate list to maintain.
    query<{ id: string; title: string }>(
      `SELECT id, title FROM roles WHERE status NOT IN ('Closed – Filled','Closed – Cancelled') ORDER BY title`
    ),
  ]);

  res.json({
    recruitment_modes: recruitmentModes.map(r => r.mode),
    roles,
  });
});

// ─── GET /api/roles/:id — single role detail ──────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  const role = await queryOne<Role>('SELECT * FROM roles WHERE id = $1', [req.params.id]);
  if (!role) { res.status(404).json({ error: 'Role not found' }); return; }

  const persona = req.user!.persona;
  const enriched = enrichRole(role);

  if (!canSeeCompForRole(persona, req.user!.name, role.hiring_manager_name)) {
    const { ctc_band: _ctc, ...safe } = enriched as Role & { ctc_band: string };
    res.json({ role: safe }); return;
  }
  res.json({ role: enriched });
});

// ─── POST /api/roles — create new role, or a Hiring Manager's role request ────
// Open to HR-tier (creates the role directly) and to Hiring Manager (submits
// a request — same Draft-status row, same form, just framed as a request on
// the frontend and logged as 'Role Requested' instead of 'Role Created' so
// HR can tell the two apart on the role's own activity timeline). Leadership
// is already HR-tier, so no separate carve-out needed for them.
router.post('/', async (req: Request, res: Response) => {
  const persona = req.user!.persona;
  if (!isHRTier(persona) && persona !== 'hiring_manager') {
    res.status(403).json({ error: 'Only HR, Leadership, or a Hiring Manager can create/request a role' });
    return;
  }

  const {
    title, department, hiring_manager_name, priority, new_or_replacement,
    num_openings, location, employment_type, yoe_required, ctc_band,
    kpi_expectations, job_description, must_have_skills, nice_to_have_skills,
    suggested_interviewers, assignment_required, recruitment_mode,
    additional_remarks, target_closure_date,
    vacancy_reason, qualification_required,
  } = req.body;

  if (!title || !priority) {
    res.status(400).json({ error: 'title and priority are required' });
    return;
  }

  // A Hiring Manager can request a role but never sets its own compensation
  // band — same restriction as everywhere else ctc_band is HR/Leadership-only.
  const effectiveCtcBand = isHRTier(persona) ? ctc_band : null;

  // start_date (Open Date) is deliberately never taken from the request body
  // here — it stays NULL until the role is actually approved, at which
  // point PATCH /:id's approval branch sets it to that day automatically.
  // Role age is meant to track "days since approved," not "days since this
  // form was submitted," so a Draft/requested role has no Open Date yet.
  // ID auto-generated by PostgreSQL sequence (seq_role → R001, R002 …)
  const role = await queryOne<Role>(
    `INSERT INTO roles (
      title, department, hiring_manager_name, priority, new_or_replacement,
      num_openings, location, employment_type, yoe_required,
      ctc_band, kpi_expectations, job_description, must_have_skills, nice_to_have_skills,
      suggested_interviewers, assignment_required, recruitment_mode, additional_remarks,
      target_closure_date, vacancy_reason, qualification_required, created_by
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
    ) RETURNING *`,
    [
      title, department, hiring_manager_name, priority, new_or_replacement,
      num_openings || 1, location, employment_type, yoe_required,
      effectiveCtcBand, kpi_expectations, job_description, must_have_skills, nice_to_have_skills,
      suggested_interviewers, assignment_required ?? true, recruitment_mode || [],
      additional_remarks, target_closure_date,
      vacancy_reason || [], qualification_required, req.user!.userId,
    ]
  );

  const isRequest = !isHRTier(persona);
  await query(
    `INSERT INTO activity_log (role_id, event_type, event_detail, performed_by, performed_by_name)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      role!.id, isRequest ? 'Role Requested' : 'Role Created',
      `${role!.title} ${isRequest ? 'requested' : 'created'} (${role!.priority})`,
      req.user!.userId, req.user!.name,
    ]
  );

  res.status(201).json({ role: enrichRole(role!) });
});

// ─── DELETE /api/roles/:id — discard a Draft role (HR only) ───────────────────
// Only Draft roles can be discarded — this is the "reject a role request"
// counterpart to approving one (item #24). Anything past Draft may already
// have a JD generated, applications, etc., which a hard delete would corrupt
// or orphan, so this deliberately refuses once a role has moved on.
router.delete('/:id', requireHR, async (req: Request, res: Response) => {
  const role = await queryOne<Role>('SELECT * FROM roles WHERE id = $1', [req.params.id]);
  if (!role) { res.status(404).json({ error: 'Role not found' }); return; }
  if (role.status !== 'Draft') {
    res.status(400).json({ error: 'Only Draft roles can be discarded' });
    return;
  }
  // Defense in depth — status=Draft should already guarantee this, but the
  // applications.role_id FK has no ON DELETE clause of its own (defaults to
  // RESTRICT), so a stray application would otherwise surface as an opaque
  // DB error instead of a clear one.
  const appCount = await queryOne<{ count: string }>('SELECT count(*) FROM applications WHERE role_id=$1', [req.params.id]);
  if (appCount && parseInt(appCount.count, 10) > 0) {
    res.status(400).json({ error: 'This role already has applications and cannot be discarded' });
    return;
  }

  // Logged before the delete, same reasoning as candidates.ts's own
  // pre-delete logging — activity_log.role_id is ON DELETE SET NULL, so the
  // row survives the role's removal (just loses the link), rather than
  // being lost entirely.
  await query(
    `INSERT INTO activity_log (role_id, event_type, event_detail, performed_by, performed_by_name)
     VALUES ($1, 'Role Discarded', $2, $3, $4)`,
    [req.params.id, `${role.title} discarded`, req.user!.userId, req.user!.name]
  );
  await query('DELETE FROM roles WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ─── PATCH /api/roles/:id — update role fields with edit log ─────────────────
router.patch('/:id', async (req: Request, res: Response) => {
  const existing = await queryOne<Role>('SELECT * FROM roles WHERE id = $1', [req.params.id]);
  if (!existing) { res.status(404).json({ error: 'Role not found' }); return; }

  // Approving a role (Draft/Under Review → Approved) is HR-tier only
  // (HR/Admin, Leadership, Super Admin) — a Hiring Manager can no longer
  // approve even their own role (2026-09-01 product decision, tightened
  // from the earlier own-role carve-out). They can still submit a role
  // request and see/edit their own role's other fields is unaffected by
  // this gate — approval specifically now always requires HR-tier.
  const isApprovingThisRole = req.body.status === 'Approved' && existing.status !== 'Approved';

  if (!isHRTier(req.user!.persona)) {
    res.status(403).json({ error: 'HR access required' });
    return;
  }

  // approver_name/approval_date/start_date are never client-settable — set
  // automatically the moment a role is actually approved (item #22): the
  // approver is always the real acting user, never a typed-in name, and the
  // role's Open Date (used for aging calculations) is copied from the
  // approval date rather than entered separately.
  const body: Record<string, unknown> = { ...req.body };
  // Strip unconditionally first — these three must never be settable
  // directly from a client-supplied value, only re-added below when the
  // server itself is the one deciding a real approval just happened.
  delete body.approver_name;
  delete body.approval_date;
  delete body.start_date;
  if (isApprovingThisRole) {
    const today = new Date().toISOString().slice(0, 10);
    body.approver_name  = req.user!.name;
    body.approval_date  = today;
    body.start_date     = today;
  }

  const allowedFields = [
    'title','department','hiring_manager_name','priority','status','new_or_replacement',
    'num_openings','location','employment_type','yoe_required',
    'ctc_band','kpi_expectations','job_description','must_have_skills','nice_to_have_skills',
    'suggested_interviewers','assignment_required','recruitment_mode','additional_remarks',
    'target_closure_date','approval_note',
    'jd_drive_link','social_jd_drive_link','whatsapp_forward_link','referral_message_link',
    'approval_summary_link','posting_status','vacancy_reason','qualification_required',
    // Only ever written by the server-side injection above, never taken
    // directly from the request body otherwise.
    'approver_name','approval_date','start_date',
  ];

  const updates: string[] = [];
  const values: unknown[] = [];
  const editLogEntries: Array<{ field: string; old: string; new_val: string }> = [];
  let idx = 1;

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      const oldVal = String((existing as unknown as Record<string, unknown>)[field] ?? '');
      const newVal = String(body[field]);
      if (oldVal !== newVal) {
        updates.push(`${field} = $${idx++}`);
        values.push(body[field]);
        editLogEntries.push({ field, old: oldVal, new_val: newVal });
      }
    }
  }

  if (updates.length === 0) {
    res.json({ role: enrichRole(existing), message: 'No changes detected' });
    return;
  }

  values.push(req.params.id);
  const updatedRole = await transaction(async (client) => {
    const result = await client.query(
      `UPDATE roles SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    // Write edit log entries
    for (const entry of editLogEntries) {
      await client.query(
        `INSERT INTO role_edit_log (role_id, field_name, old_value, new_value, changed_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.params.id, entry.field, entry.old, entry.new_val, req.user!.userId]
      );
    }

    // Role activity timeline — mirrors the candidate/application activity
    // log (item #25), narrative rather than field-level (role_edit_log
    // above already covers the granular old→new diff). Status gets its own
    // event since it's the most narratively significant field; every other
    // changed field is summarized into one combined entry so a multi-field
    // edit doesn't flood the timeline with one row per field.
    const statusEntry = editLogEntries.find(e => e.field === 'status');
    if (isApprovingThisRole) {
      // One clean event rather than a generic Status Changed — the
      // auto-populated approver_name/approval_date/start_date changes
      // below are the mechanics of approval, not separately-noteworthy
      // edits, so they're excluded from the "Role Updated" summary too.
      await client.query(
        `INSERT INTO activity_log (role_id, event_type, event_detail, performed_by, performed_by_name)
         VALUES ($1, 'Role Approved', $2, $3, $4)`,
        [req.params.id, `Approved by ${req.user!.name}`, req.user!.userId, req.user!.name]
      );
    } else if (statusEntry) {
      await client.query(
        `INSERT INTO activity_log (role_id, event_type, event_detail, old_value, new_value, performed_by, performed_by_name)
         VALUES ($1, 'Status Changed', $2, $3, $4, $5, $6)`,
        [req.params.id, `Status → ${statusEntry.new_val}`, statusEntry.old, statusEntry.new_val, req.user!.userId, req.user!.name]
      );
    }
    const approvalMechanicsFields = ['status', 'approver_name', 'approval_date', 'start_date'];
    const otherEntries = editLogEntries.filter(e =>
      isApprovingThisRole ? !approvalMechanicsFields.includes(e.field) : e.field !== 'status'
    );
    if (otherEntries.length > 0) {
      await client.query(
        `INSERT INTO activity_log (role_id, event_type, event_detail, performed_by, performed_by_name)
         VALUES ($1, 'Role Updated', $2, $3, $4)`,
        [req.params.id, otherEntries.map(e => `${e.field}: "${e.old}" → "${e.new_val}"`).join('; '), req.user!.userId, req.user!.name]
      );
    }

    return result.rows[0] as Role;
  });

  // Trigger JD generation when a role transitions into Approved —
  // synchronous (awaited), NOT fire-and-forget. This used to run via
  // setImmediate() after the response was already prepared, which works
  // fine on a persistent server but silently never completes on Vercel:
  // serverless function execution can be frozen/terminated as soon as a
  // response is sent, so a setImmediate() callback scheduled afterward has
  // no guarantee of ever running to completion — confirmed in production,
  // where this left jd_drive_link/social_jd_drive_link permanently null
  // with zero error output. Awaiting it here means the PATCH request takes
  // as long as generation actually takes (~20-30s for a real Claude call +
  // 2 PDF renders + 2 Drive uploads) — see vercel.json's maxDuration, raised
  // to accommodate this. Guarded on the transition itself (not just current
  // status) plus !existing.jd_drive_link, so a role PATCHed with status
  // already 'Approved' (e.g. an unrelated field edit) never regenerates.
  let jdGeneration: { generated: boolean; error?: string } | undefined;
  if (updatedRole.status === 'Approved' && existing.status !== 'Approved' && !existing.jd_drive_link) {
    try {
      const content = await generateJdContent(updatedRole);
      if (!content) {
        console.error(`[JD-Gen] Skipping ${updatedRole.id} — content generation failed`);
        jdGeneration = { generated: false, error: 'JD content generation failed' };
      } else {
        const folderId = process.env.DRIVE_JD_FOLDER_ID;
        if (!folderId) {
          console.error(`[JD-Gen] DRIVE_JD_FOLDER_ID not set — skipping upload for ${updatedRole.id}`);
          jdGeneration = { generated: false, error: 'DRIVE_JD_FOLDER_ID not configured' };
        } else {
          const [longFormBuffer, socialBuffer] = await Promise.all([
            renderLongFormJd(updatedRole, content),
            renderSocialJd(updatedRole, content),
          ]);

          const safeTitle = updatedRole.title.replace(/[^a-zA-Z0-9]+/g, '_');
          const [longFormUpload, socialUpload] = await Promise.all([
            uploadJdPdf(longFormBuffer, `DP_JD_${updatedRole.id}_${safeTitle}.pdf`, folderId),
            uploadJdPdf(socialBuffer, `Social_${updatedRole.id}_${safeTitle}.pdf`, folderId),
          ]);

          // Only write the links once every step above has succeeded — a
          // partial failure leaves both columns untouched so the guard above
          // allows a clean retry on the next role edit. generated_jd_content
          // persists the structured content itself (not just the rendered
          // PDFs) so ResumeIQ can score against it directly instead of
          // re-deriving structure from PDF text later.
          await query(
            'UPDATE roles SET jd_drive_link=$1, social_jd_drive_link=$2, generated_jd_content=$3 WHERE id=$4',
            [longFormUpload.webViewLink, socialUpload.webViewLink, JSON.stringify(content), updatedRole.id]
          );
          await query(
            `INSERT INTO activity_log (role_id, event_type, event_detail, performed_by_name)
             VALUES ($1, 'JD Generated', $2, 'System')`,
            [updatedRole.id, `Long-form + social JD generated for ${updatedRole.title}`]
          );
          console.log(`[JD-Gen] Generated JDs for ${updatedRole.id}`);

          // Reflect the fresh links immediately in this response, rather
          // than making the caller poll for a value that's already known.
          updatedRole.jd_drive_link = longFormUpload.webViewLink;
          updatedRole.social_jd_drive_link = socialUpload.webViewLink;
          updatedRole.generated_jd_content = content as unknown as Record<string, unknown>;
          jdGeneration = { generated: true };
        }
      }
    } catch (err) {
      console.error(`[JD-Gen] Generation failed for ${updatedRole.id}:`, err);
      jdGeneration = { generated: false, error: 'JD generation failed — will retry automatically the next time this role is approved' };
    }
  }

  const canSeeComp = canSeeCompForRole(req.user!.persona, req.user!.name, updatedRole.hiring_manager_name);
  const safeUpdated = canSeeComp
    ? enrichRole(updatedRole)
    : (() => { const { ctc_band: _ctc, ...safe } = enrichRole(updatedRole) as Role & { ctc_band: string }; return safe; })();
  res.json({ role: safeUpdated, jdGeneration });
});

// ─── GET /api/roles/:id/edit-log ──────────────────────────────────────────────
router.get('/:id/edit-log', async (req: Request, res: Response) => {
  const role = await queryOne<{ hiring_manager_name: string | null }>('SELECT hiring_manager_name FROM roles WHERE id=$1', [req.params.id]);
  const canSeeComp = canSeeCompForRole(req.user!.persona, req.user!.name, role?.hiring_manager_name);

  const logs = await query(
    `SELECT el.*, u.name AS changed_by_name
     FROM role_edit_log el
     LEFT JOIN users u ON u.id = el.changed_by
     WHERE el.role_id = $1
     ORDER BY el.changed_at DESC`,
    [req.params.id]
  );
  // A row logging a ctc_band edit carries the plaintext old/new value —
  // excluded entirely (not just redacted in place) for anyone who can't see
  // this role's comp, same rule as everywhere else in this file.
  const safeLogs = canSeeComp ? logs : logs.filter((l: unknown) => (l as { field_name?: string }).field_name !== 'ctc_band');
  res.json({ logs: safeLogs });
});

// ─── GET /api/roles/:id/activity — role-level activity timeline ──────────────
// Role-level events only (Role Created/Updated/Approved, JD Generated) — NOT
// every candidate's stage/status history against this role, which also sets
// role_id on its own activity_log rows (applications.ts's logActivity) but
// belongs to that candidate's own timeline, not this one.
router.get('/:id/activity', async (req: Request, res: Response) => {
  const role = await queryOne<{ hiring_manager_name: string | null }>('SELECT hiring_manager_name FROM roles WHERE id=$1', [req.params.id]);
  const canSeeComp = canSeeCompForRole(req.user!.persona, req.user!.name, role?.hiring_manager_name);

  const log = await query(
    // COALESCE, not a bare override: al.* already carries the row's own
    // performed_by_name (set at insert time for system-attributed events
    // like ingested-role creation or JD generation, where performed_by
    // itself is NULL). A bare "u.name AS performed_by_name" would have the
    // LEFT JOIN's NULL (no user matches a NULL performed_by) silently
    // clobber that stored 'System' value instead of just filling in the
    // live name for rows that do have a real performed_by.
    `SELECT al.*, COALESCE(u.name, al.performed_by_name) AS performed_by_name
     FROM activity_log al
     LEFT JOIN users u ON u.id = al.performed_by
     WHERE al.role_id = $1 AND al.application_id IS NULL AND al.candidate_id IS NULL
     ORDER BY al.created_at DESC`,
    [req.params.id]
  );
  // A 'Role Updated' event's event_detail is a free-text summary that can
  // bundle a ctc_band change together with unrelated field changes in one
  // string (e.g. "ctc_band: "18-24 LPA" → "20-26 LPA"; location: "Pune" →
  // "Gurgaon""), so the whole entry can't just be dropped — only the
  // ctc_band segment is stripped out of the text for anyone who can't see
  // this role's comp, leaving any other bundled field changes visible.
  const safeLog = canSeeComp ? log : log.map((l: unknown) => {
    const entry = l as { event_detail?: string };
    if (!entry.event_detail || !entry.event_detail.includes('ctc_band:')) return l;
    const redacted = entry.event_detail
      .split('; ')
      .filter(part => !part.trim().startsWith('ctc_band:'))
      .join('; ');
    return { ...entry, event_detail: redacted || '(compensation change — details hidden)' };
  });
  res.json({ activity: safeLog });
});

// ─── GET /api/roles/:id/pipeline — applications grouped by stage ──────────────
router.get('/:id/pipeline', async (req: Request, res: Response) => {
  const role = await queryOne<{ hiring_manager_name: string | null }>('SELECT hiring_manager_name FROM roles WHERE id=$1', [req.params.id]);
  const canSeeComp = canSeeCompForRole(req.user!.persona, req.user!.name, role?.hiring_manager_name);

  const apps = await query(
    `SELECT a.*, c.full_name AS candidate_name, c.email, ag.name AS agency_name
     FROM applications a
     JOIN candidates c ON c.id = a.candidate_id
     LEFT JOIN agencies ag ON ag.id = a.agency_id
     WHERE a.role_id = $1 AND a.status = 'Active'
     ORDER BY a.ai_fit_score DESC NULLS LAST`,
    [req.params.id]
  );

  // This route never stripped restricted fields before — every non-HR
  // persona (and, before today, every Hiring Manager regardless of which
  // role they were even looking at) got internal_risk_notes/agency_fee_
  // estimate/offer_ctc_fixed/offer_ctc_variable/hr_comp_alignment/CTC
  // figures unfiltered. Single check up front since this route is already
  // scoped to one role.
  const safeApps = apps.map(a => stripRestrictedFields(a as Record<string, unknown>, req.user!.persona, canSeeComp));

  // Group by stage
  const byStage: Record<string, unknown[]> = {};
  for (const app of safeApps) {
    const stage = (app as Record<string,unknown>).stage as string;
    if (!byStage[stage]) byStage[stage] = [];
    byStage[stage].push(app);
  }

  res.json({ pipeline: byStage, total: safeApps.length });
});

// ─── GET /api/roles/:id/comp-benchmark — internal comp benchmarking ───────────
// Item #26 (corrected: role-specific, not tied to any one candidate) —
// HR/Admin only, matches ctc_band's own visibility restriction. comp_benchmarks
// is checked first as grounding data; Claude's general market knowledge is
// only used as a fallback when no internal row exists for this role — see
// compBenchmark.ts for the exact ordering.
router.get('/:id/comp-benchmark', requireHR, async (req: Request, res: Response) => {
  const role = await queryOne<Role>('SELECT * FROM roles WHERE id = $1', [req.params.id]);
  if (!role) { res.status(404).json({ error: 'Role not found' }); return; }

  try {
    const benchmark = await getCompBenchmark(role);
    res.json({ benchmark });
  } catch (err) {
    console.error('[CompBenchmark] Failed for role', req.params.id, err);
    res.status(500).json({ error: 'Compensation benchmarking failed — please try again' });
  }
});

// ─── GET /api/roles/:id/closure-summary.pdf — 1-page retrospective PDF ───────
// CEO directive (2026-08-29): only available once a role is actually closed
// (Filled or Cancelled) — the button that hits this is hidden until then on
// the frontend, and enforced here too so the link itself can't be shared/
// reused before that. Metrics cover ALL candidates ever linked to this role
// (not just Active — a retrospective needs the full history), unlike the
// live Dashboard's own per-role metrics which are Active-scoped by design.
// Visible to HR-tier always, and to the role's own Hiring Manager — same
// ownership rule as compensation visibility (canSeeCompForRole), reused here
// as a general "can manage/review this role" check rather than introducing
// a second, differently-named ownership gate for the same underlying rule.
const CLOSED_STATUSES = ['Closed – Filled', 'Closed – Cancelled'];

// Every action_type a retrospective should count as a genuine candidate-flow
// SLA breach — same definition the Dashboard KPI and Hiring Funnel Snapshot
// use (slaChecker.ts's ALL_BREACH_ACTION_TYPES), so a closure summary can
// never disagree with what those surfaces called a breach while the role
// was still open. Deliberately excludes 'Role aging alert' (that's about
// the role sitting open too long, already covered by Days to close above,
// and dashboard.ts's own test suite establishes it never belongs alongside
// candidate breach types) and 'Compensation change flag' (a comp-admin
// concern, not a candidate-flow SLA issue) — both already excluded by
// ALL_BREACH_ACTION_TYPES itself.
const CLOSURE_BREACH_TYPES = ALL_BREACH_ACTION_TYPES;

router.get('/:id/closure-summary.pdf', async (req: Request, res: Response) => {
  const role = await queryOne<Role>('SELECT * FROM roles WHERE id = $1', [req.params.id]);
  if (!role) { res.status(404).json({ error: 'Role not found' }); return; }

  if (!canSeeCompForRole(req.user!.persona, req.user!.name, role.hiring_manager_name)) {
    res.status(403).json({ error: 'HR access required, or you must be this role\'s assigned Hiring Manager' });
    return;
  }
  if (!CLOSED_STATUSES.includes(role.status)) {
    res.status(400).json({ error: 'A closure summary is only available once a role is Closed – Filled or Closed – Cancelled' });
    return;
  }

  const [closedAtRow, funnelRows, outcomeRow, breachRows, sourceRows, velocityRows, timeToFillRow] = await Promise.all([
    // Most recent transition INTO a closed status — a role can in principle
    // be reopened and re-closed (seen elsewhere this session), so this is
    // "when it most recently closed," not "when it first ever did."
    queryOne<{ created_at: string }>(
      `SELECT created_at FROM activity_log
       WHERE role_id=$1 AND event_type='Status Changed' AND new_value = ANY($2::text[])
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.id, CLOSED_STATUSES]
    ),
    query<{ stage: string; status: string; count: string }>(
      `SELECT stage, status, COUNT(*) as count FROM applications WHERE role_id=$1 GROUP BY stage, status`,
      [req.params.id]
    ),
    queryOne<{ total: string; active: string; joined: string; rejected: string; withdrawn: string; hold_for_future: string }>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status='Active') AS active,
              COUNT(*) FILTER (WHERE status='Joined') AS joined,
              COUNT(*) FILTER (WHERE status='Rejected') AS rejected,
              COUNT(*) FILTER (WHERE status='Withdrawn') AS withdrawn,
              COUNT(*) FILTER (WHERE status='Hold for Future') AS hold_for_future
       FROM applications WHERE role_id=$1`,
      [req.params.id]
    ),
    query<{ action_type: string; count: string }>(
      `SELECT pa.action_type, COUNT(*) as count
       FROM pending_actions pa
       WHERE pa.action_type = ANY($2::text[])
         AND (pa.role_id=$1 OR pa.application_id IN (SELECT id FROM applications WHERE role_id=$1))
       GROUP BY pa.action_type ORDER BY count DESC`,
      [req.params.id, CLOSURE_BREACH_TYPES]
    ),
    // Grouped by candidates.source, not the retired applications.source_channel
    // — see the matching comment in dashboard.ts's own Source Quality query
    // for why (2026-08-24, commit 2092a54). Aliased back to source_channel
    // so renderRoleClosureSummary's ClosureSummaryData shape stays unchanged.
    query<{ source_channel: string; n: string; engaged: string; hired: string }>(
      `SELECT c.source AS source_channel, COUNT(*) AS n,
              COUNT(*) FILTER (WHERE a.stage <> 'Applied and Screened') AS engaged,
              COUNT(*) FILTER (WHERE a.stage = 'Joined') AS hired
       FROM applications a
       JOIN candidates c ON c.id = a.candidate_id
       WHERE a.role_id=$1 AND c.source IS NOT NULL AND c.source <> ''
       GROUP BY c.source ORDER BY n DESC`,
      [req.params.id]
    ),
    query<{ stage: string; count: string }>(
      `SELECT stage, COUNT(*) as count FROM applications WHERE role_id=$1 GROUP BY stage`,
      [req.params.id]
    ),
    queryOne<{ avg_days: string | null }>(
      `SELECT AVG(offer_accepted_date - start_date) as avg_days FROM applications a
       JOIN roles r ON r.id = a.role_id
       WHERE a.role_id=$1 AND a.offer_accepted_date IS NOT NULL AND r.start_date IS NOT NULL`,
      [req.params.id]
    ),
  ]);

  const closedDate = closedAtRow?.created_at || null;
  const daysToClose = role.start_date && closedDate
    ? Math.floor((new Date(closedDate).getTime() - new Date(role.start_date).getTime()) / 86400000)
    : null;

  type FunnelCounts = { active: number; joined: number; rejected: number; withdrawn: number; hold_for_future: number };
  const funnelByStage: Record<string, FunnelCounts> = {};
  for (const stage of STAGE_ORDER) funnelByStage[stage] = { active: 0, joined: 0, rejected: 0, withdrawn: 0, hold_for_future: 0 };
  for (const row of funnelRows) {
    const bucket = funnelByStage[row.stage];
    if (!bucket) continue;
    const n = parseInt(row.count);
    if (row.status === 'Active') bucket.active = n;
    else if (row.status === 'Joined') bucket.joined = n;
    else if (row.status === 'Rejected') bucket.rejected = n;
    else if (row.status === 'Withdrawn') bucket.withdrawn = n;
    else if (row.status === 'Hold for Future') bucket.hold_for_future = n;
  }

  const FIRST_INTERVIEW_IDX = STAGE_ORDER.indexOf('Interview Round 1');
  const FIRST_OFFER_IDX = STAGE_ORDER.indexOf('Offer Released');
  let interviewedCount = 0, offeredCount = 0;
  for (const row of velocityRows) {
    const idx = STAGE_ORDER.indexOf(row.stage);
    if (idx < 0) continue;
    const n = parseInt(row.count);
    if (idx >= FIRST_INTERVIEW_IDX) interviewedCount += n;
    if (idx >= FIRST_OFFER_IDX) offeredCount += n;
  }

  const rejectedByStage = STAGE_ORDER.map(stage => ({ stage, count: funnelByStage[stage].rejected }))
    .filter(s => s.count > 0).sort((a, b) => b.count - a.count)[0];

  const slaByType = breachRows.map(r => ({ type: r.action_type, count: parseInt(r.count) }));

  try {
    const pdfBuffer = await renderRoleClosureSummary({
      role: {
        id: role.id, title: role.title, department: role.department || null,
        hiring_manager_name: role.hiring_manager_name || null, priority: role.priority,
        location: role.location || null, employment_type: role.employment_type || null,
        status: role.status, start_date: role.start_date || null,
        target_closure_date: role.target_closure_date || null,
        closed_date: closedDate, days_to_close: daysToClose, num_openings: role.num_openings,
      },
      totalApplications: parseInt(outcomeRow?.total || '0'),
      outcomes: {
        active: parseInt(outcomeRow?.active || '0'), joined: parseInt(outcomeRow?.joined || '0'),
        rejected: parseInt(outcomeRow?.rejected || '0'), withdrawn: parseInt(outcomeRow?.withdrawn || '0'),
        hold_for_future: parseInt(outcomeRow?.hold_for_future || '0'),
      },
      funnel: STAGE_ORDER.map(stage => ({ stage, ...funnelByStage[stage] })),
      slaBreaches: { total: slaByType.reduce((s, t) => s + t.count, 0), byType: slaByType },
      sourceQuality: sourceRows.map(r => {
        const n = parseInt(r.n);
        return {
          source_channel: r.source_channel, n,
          pass_rate: n > 0 ? Math.round((parseInt(r.engaged) / n) * 1000) / 10 : 0,
          hire_rate: n > 0 ? Math.round((parseInt(r.hired) / n) * 1000) / 10 : 0,
        };
      }),
      velocity: {
        interview_to_offer_ratio: interviewedCount > 0 ? Math.round((offeredCount / interviewedCount) * 1000) / 10 : null,
        biggest_drop_off: rejectedByStage || null,
      },
      timeToFillDays: timeToFillRow?.avg_days != null ? Math.round(Number(timeToFillRow.avg_days) * 10) / 10 : null,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${role.id}-closure-summary.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[ClosureSummary] Failed for role', req.params.id, err);
    res.status(500).json({ error: 'Failed to generate closure summary PDF' });
  }
});

export default router;
