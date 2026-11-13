// Sourcing plan detailing — templates and pre-fill, the plan's detail rows, the weekly check-in, the outreach upload, reminders and the
// leadership overview. ADDITIVE: this file never touches commitments, trackers, channel states or the form attribution; it reads them.
// Spec: docs/SourcingPlanDetailing_Spec.md. Ownership stays the HR/Admin persona: "owner" fields here are LABELS, never a user id.
import { query, queryOne, transaction } from '../db/index.js';
import { JwtPayload } from '../types/index.js';
import { OPEN_ROLE_STATUSES, SOURCING_CHANNELS } from '../utils/sourcingConfig.js';
import {
  mapWorkbookChannel, parseRowStatus, parseTrackedAs, RESOLUTION_REASONS, roundTarget, DetailThresholds, DEFAULT_DETAIL_THRESHOLDS, mergeDetailThresholds,
} from '../utils/sourcingDetail.js';
import { pickTemplate, PlanTemplate, SEED_TEMPLATES, suggestedChannels, TemplateRow } from '../utils/sourcingPlanTemplates.js';
import {
  channelResults, ChannelResult, computeHealth, lastFridayOnOrBefore, PlanHealth, cohortOf,
} from '../utils/sourcingDetailRules.js';
import {
  mergePerson, parseCsv, StoredPerson, validateOutreachRows, companyKey, RejectedRow,
} from '../utils/sourcingOutreach.js';
import { addCalendarDays, addWorkingDays, endOfIstDay, istDate, mondayOf } from '../utils/workingDays.js';
import { describeException } from '../utils/sourcingDescribe.js';
import { loadSettings } from './sourcingSettings.js';
import { SourcingError, logChangeQ, effectiveTarget } from './sourcingPlans.js';
import { loadDetailFacts, loadDetailThresholds } from './sourcingDetailFacts.js';

const OPEN = OPEN_ROLE_STATUSES as unknown as string[];

// ─── Thresholds / alert switch ───────────────────────────────────────────────────────────────────────
export async function saveDetailThresholds(patch: Record<string, unknown>, userId: string): Promise<DetailThresholds> {
  const current = await loadDetailThresholds();
  const merged = mergeDetailThresholds({ ...current, ...patch });
  // Only store what differs from the defaults, so a later change of a default still reaches everyone who never touched that value.
  const diff: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== (DEFAULT_DETAIL_THRESHOLDS as unknown as Record<string, unknown>)[k]) diff[k] = v;
  await query(
    `INSERT INTO sourcing_settings (key, value, updated_by) VALUES ('detail_thresholds', $1::jsonb, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`, [JSON.stringify(diff), userId]);
  return merged;
}

// ─── Templates ───────────────────────────────────────────────────────────────────────────────────────
export interface TemplateRecord extends PlanTemplate { id: string; is_active: boolean }

/** Insert any seed template that is missing (by key). Never overwrites: a template the HR lead has edited stays as edited. */
export async function seedTemplates(): Promise<void> {
  for (const t of SEED_TEMPLATES) {
    await query(
      `INSERT INTO sourcing_templates (key, name, description, match_rules, weekly_qualified_target, job_titles, company_lists, channel_rows)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6::text[],$7::text[],$8::jsonb) ON CONFLICT (key) DO NOTHING`,
      [t.key, t.name, t.description, JSON.stringify(t.match_rules), t.weekly_qualified_target, t.job_titles, t.company_lists, JSON.stringify(t.channel_rows)]);
  }
}

export async function listTemplates(): Promise<TemplateRecord[]> {
  await seedTemplates();
  const rows = await query<TemplateRecord & { weekly_qualified_target: string | null }>(
    `SELECT id::text AS id, key, name, description, match_rules, weekly_qualified_target::float AS weekly_qualified_target, job_titles, company_lists, channel_rows, is_active
       FROM sourcing_templates ORDER BY id`);
  return rows as unknown as TemplateRecord[];
}

const cleanList = (v: unknown, max = 20, len = 160): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map(x => x.trim().slice(0, len)).filter(Boolean))].slice(0, max) : [];

/** Validate one plan line (a template's or a plan's). Returns null when it is not usable. */
export function cleanRow(raw: unknown): TemplateRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const label = typeof r.workbook_channel === 'string' ? r.workbook_channel.trim().slice(0, 60) : '';
  const status = parseRowStatus(r.status);
  if (!label || !status) return null;
  const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.round(n * 100) / 100 : null; };
  const txt = (v: unknown, n = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  return {
    workbook_channel: label, platform: txt(r.platform), status, owner_label: txt(r.owner_label, 60), tracked_as: parseTrackedAs(r.tracked_as),
    weekly_work: num(r.weekly_work), work_unit: txt(r.work_unit, 80), expected_applicants: num(r.expected_applicants), expected_qualified: num(r.expected_qualified),
    start_condition: txt(r.start_condition), first_task: txt(r.first_task), repeats: txt(r.repeats), reason: status === 'not_used' ? txt(r.reason) : null,
  };
}

export async function updateTemplate(key: string, patch: Record<string, unknown>, user: JwtPayload): Promise<void> {
  const cur = await queryOne<{ id: string }>(`SELECT id::text AS id FROM sourcing_templates WHERE key = $1`, [key]);
  if (!cur) throw new SourcingError(404, 'Template not found');
  const sets: string[] = []; const vals: unknown[] = [];
  const add = (col: string, v: unknown, cast = '') => { vals.push(v); sets.push(`${col} = $${vals.length}${cast}`); };
  if (typeof patch.name === 'string' && patch.name.trim()) add('name', patch.name.trim().slice(0, 120));
  if (typeof patch.description === 'string') add('description', patch.description.slice(0, 500));
  if (Array.isArray(patch.job_titles)) add('job_titles', cleanList(patch.job_titles), '::text[]');
  if (Array.isArray(patch.company_lists)) add('company_lists', cleanList(patch.company_lists), '::text[]');
  if (patch.weekly_qualified_target !== undefined) {
    const t = patch.weekly_qualified_target === null ? null : Number(patch.weekly_qualified_target);
    if (t !== null && !(Number.isFinite(t) && t >= 0.5 && t <= 500)) throw new SourcingError(400, 'The weekly qualified target must be between 0.5 and 500');
    add('weekly_qualified_target', t);
  }
  if (Array.isArray(patch.channel_rows)) {
    const rows = (patch.channel_rows as unknown[]).map(cleanRow);
    if (rows.some(r => r === null) || rows.length > 30) throw new SourcingError(400, 'Every channel line needs a name and a status (live, backup or not used)');
    add('channel_rows', JSON.stringify(rows), '::jsonb');
  }
  if (typeof patch.is_active === 'boolean') add('is_active', patch.is_active);
  if (!sets.length) throw new SourcingError(400, 'Nothing to change');
  vals.push(user.userId); sets.push(`updated_by = $${vals.length}::uuid`);
  vals.push(key);
  await query(`UPDATE sourcing_templates SET ${sets.join(', ')} WHERE key = $${vals.length}`, vals);
}

// ─── Pre-filling a plan ──────────────────────────────────────────────────────────────────────────────
async function companyListIdsByName(names: string[]): Promise<string[]> {
  if (!names.length) return [];
  const rows = await query<{ id: string }>(`SELECT id::text AS id FROM sourcing_company_lists WHERE name = ANY($1::text[])`, [names]);
  return rows.map(r => r.id);
}

async function writeRows(planId: string, rows: TemplateRow[]): Promise<void> {
  await query(`DELETE FROM sourcing_plan_rows WHERE plan_id = $1::bigint`, [planId]);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    await query(
      `INSERT INTO sourcing_plan_rows (plan_id, position, workbook_channel, mapped_channels, platform, status, owner_label, tracked_as, weekly_work, work_unit,
                                       expected_applicants, expected_qualified, start_condition, first_task, repeats, reason)
       VALUES ($1::bigint,$2,$3,$4::text[],$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [planId, i, r.workbook_channel, mapWorkbookChannel(r.workbook_channel, r.platform), r.platform, r.status, r.owner_label, r.tracked_as, r.weekly_work, r.work_unit,
       r.expected_applicants, r.expected_qualified, r.start_condition, r.first_task, r.repeats, r.reason]);
  }
}

/**
 * Pre-fill a DRAFT plan from a template (the given one, else the best match for the role). Only ever fills an empty plan — a plan that already has detail
 * rows is left alone unless `replace` is set — and it never activates anything, adds a channel or sets a target: those stay the recruiter's call at
 * activation (the suggestion is returned by getPlanDetail). Returns the template used, or null when none matched.
 */
export async function prefillPlan(planId: string, opts: { templateKey?: string | null; replace?: boolean; userId?: string | null } = {}): Promise<{ key: string; name: string } | null> {
  const plan = await queryOne<{ role_id: string; status: string; title: string; department: string | null; priority: string }>(
    `SELECT p.role_id, p.status, r.title, r.department, r.priority FROM sourcing_plans p JOIN roles r ON r.id = p.role_id WHERE p.id = $1::bigint`, [planId]);
  if (!plan) throw new SourcingError(404, 'Plan not found');
  if (plan.status !== 'draft') throw new SourcingError(409, 'Only a draft plan can be pre-filled');
  const has = await queryOne<{ n: string }>(`SELECT (SELECT count(*) FROM sourcing_plan_rows WHERE plan_id = $1::bigint) AS n`, [planId]);
  if (Number(has?.n) > 0 && !opts.replace) return null;

  const templates = (await listTemplates()).filter(t => t.is_active);
  const tpl = opts.templateKey ? templates.find(t => t.key === opts.templateKey) : pickTemplate(plan, templates);
  if (opts.templateKey && !tpl) throw new SourcingError(404, 'Template not found');
  if (!tpl) return null;

  const listIds = await companyListIdsByName(tpl.company_lists);
  await writeRows(planId, tpl.channel_rows);
  await query(
    `INSERT INTO sourcing_plan_details (plan_id, template_key, job_titles, company_list_ids, prefilled_at, updated_by)
     VALUES ($1::bigint, $2, $3::text[], $4::bigint[], NOW(), $5::uuid)
     ON CONFLICT (plan_id) DO UPDATE SET template_key = EXCLUDED.template_key, job_titles = EXCLUDED.job_titles, company_list_ids = EXCLUDED.company_list_ids,
                  prefilled_at = NOW(), updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [planId, tpl.key, tpl.job_titles, listIds, opts.userId ?? null]);
  await logChangeQ(planId, opts.userId ?? null, { type: 'plan_prefilled', template: tpl.name });
  return { key: tpl.key, name: tpl.name };
}

/** Called for plans the engine / role hook just created. Best-effort: a fault here must never fail the creation of a draft plan. */
export async function prefillNewPlans(planIds: string[]): Promise<void> {
  for (const id of planIds) {
    try { await prefillPlan(id); } catch (err) { console.error(`[Sourcing] could not pre-fill plan ${id} (ignored):`, err); }
  }
}

// ─── The plan's detail (one read for the role page) ─────────────────────────────────────────────────
export interface PlanDetail {
  plan_id: string; plan_status: string;
  template: { key: string; name: string } | null;
  job_titles: string[]; target_date: string | null;
  company_lists: Array<{ id: string; name: string; companies: number }>;
  rows: Array<TemplateRow & { id: string; mapped_channels: string[] }>;
  suggested_channels: Array<{ channel: string; weekly_target: number | null }>;
  suggested_target: number | null;
  health: PlanHealth;
  channel_results: ChannelResult[];
  untagged_warning: boolean;
  outreach: {
    companies_listed: number; companies_worked: number; worked_share: number | null;
    people_found: number; people_contacted: number; followups: number; replied: number; last_upload: string | null;
    by_title: Array<{ job_title: string; found: number; contacted: number; replied: number }>;
  };
  checkin: { week_of: string; due: string; done: boolean; answers: Record<string, string>; blocker_text: string | null; questions: string[] } | null;
  thresholds: DetailThresholds;
  reasons: readonly string[];
}

const CHECKIN_QUESTIONS = ['post_refreshed', 'referral_push', 'agency_followup', 'outreach_uploaded'] as const;

/** Which check-in questions apply to this plan: only for lines that are live in the plan, so nobody is asked about a channel that is not used. */
export function applicableQuestions(rows: Array<{ status: string; mapped_channels: string[] }>): string[] {
  const live = rows.filter(r => r.status === 'live');
  const q: string[] = [];
  if (live.some(r => r.mapped_channels.includes('LinkedIn') || r.mapped_channels.includes('Naukri/IIMjobs'))) q.push('post_refreshed');
  if (live.some(r => r.mapped_channels.includes('Internal Referral'))) q.push('referral_push');
  if (live.some(r => r.mapped_channels.includes('Agency'))) q.push('agency_followup');
  if (live.some(r => r.mapped_channels.includes('Direct Outreach'))) q.push('outreach_uploaded');
  return q;
}

export async function getPlanDetail(roleId: string, now: Date = new Date()): Promise<PlanDetail | null> {
  const plan = await queryOne<{ id: string; status: string }>(`SELECT id::text AS id, status FROM sourcing_plans WHERE role_id = $1`, [roleId]);
  if (!plan) return null;
  // A draft plan made before this layer existed (or by a hook that skipped it) is pre-filled on first view. Idempotent: a plan with rows is left alone.
  if (plan.status === 'draft') { try { await prefillPlan(plan.id); } catch (err) { console.error('[Sourcing] pre-fill on view failed (ignored):', err); } }

  const settings = await loadSettings();
  const t = await loadDetailThresholds();
  const [facts] = await loadDetailFacts({ planIds: [plan.id], now });
  if (!facts) return null;
  const today = istDate(now);

  const det = await queryOne<{ template_key: string | null; job_titles: string[]; company_list_ids: string[]; target_date: string | null; template_name: string | null; template_target: number | null }>(
    `SELECT d.template_key, d.job_titles, d.company_list_ids::text[] AS company_list_ids, to_char(d.target_date, 'YYYY-MM-DD') AS target_date,
            t.name AS template_name, t.weekly_qualified_target::float AS template_target
       FROM sourcing_plan_details d LEFT JOIN sourcing_templates t ON t.key = d.template_key WHERE d.plan_id = $1::bigint`, [plan.id]);
  const rows = await query<TemplateRow & { id: string; mapped_channels: string[] }>(
    `SELECT id::text AS id, workbook_channel, mapped_channels, platform, status, owner_label, tracked_as, weekly_work::float AS weekly_work, work_unit,
            expected_applicants::float AS expected_applicants, expected_qualified::float AS expected_qualified, start_condition, first_task, repeats, reason
       FROM sourcing_plan_rows WHERE plan_id = $1::bigint ORDER BY position, id`, [plan.id]);
  const lists = (det?.company_list_ids ?? []).length ? await query<{ id: string; name: string; companies: string }>(
    `SELECT l.id::text AS id, l.name, (SELECT count(*) FROM sourcing_company_list_members m JOIN sourcing_companies c ON c.id = m.company_id WHERE m.list_id = l.id AND NOT c.excluded)::text AS companies
       FROM sourcing_company_lists l WHERE l.id = ANY($1::bigint[]) ORDER BY l.name`, [det!.company_list_ids]) : [];

  const byTitle = await query<{ job_title: string | null; found: string; contacted: string; replied: string }>(
    `SELECT COALESCE(job_title, '(no title)') AS job_title, count(*)::text AS found, count(first_contacted)::text AS contacted, count(*) FILTER (WHERE replied)::text AS replied
       FROM sourcing_outreach_people WHERE role_id = $1 GROUP BY 1 ORDER BY count(*) DESC LIMIT 20`, [roleId]);

  // The check-in that is due (or the early one for this week), with the answers if it is already in.
  const friday = lastFridayOnOrBefore(today);
  const dueWeek = mondayOf(friday);
  const dueDone = facts.checkins.find(c => c.week_start === dueWeek);
  const showWeek = plan.status === 'active' && facts.activated_on && facts.activated_on < friday && !dueDone ? dueWeek : mondayOf(today);
  const shown = facts.checkins.find(c => c.week_start === showWeek);
  const checkin = plan.status === 'active' ? {
    week_of: showWeek, due: addCalendarDays(showWeek, 4), done: !!shown, answers: shown?.answers ?? {}, blocker_text: shown?.blocker_text ?? null,
    questions: applicableQuestions(rows),
  } : null;

  const eff = effectiveTarget(null, facts.priority, settings);
  const health = computeHealth(facts, now, settings.qualified_rule, t);
  const channelsShown = SOURCING_CHANNELS.filter(c => facts.channel_states[c] && facts.channel_states[c] !== 'excluded');
  const touchedShare = facts.companies.listed > 0 ? facts.companies.touched / facts.companies.listed : null;
  return {
    plan_id: plan.id, plan_status: plan.status,
    template: det?.template_key ? { key: det.template_key, name: det.template_name ?? det.template_key } : null,
    job_titles: det?.job_titles ?? [], target_date: det?.target_date ?? null,
    company_lists: lists.map(l => ({ id: l.id, name: l.name, companies: Number(l.companies) })),
    rows, suggested_channels: suggestedChannels(rows),
    suggested_target: roundTarget(det?.template_target ?? null) ?? (eff.applicable ? eff.min : null),
    health, channel_results: channelResults(facts, settings.qualified_rule, t, channelsShown),
    untagged_warning: health.source.untrusted,
    outreach: {
      companies_listed: facts.companies.listed, companies_worked: facts.companies.touched, worked_share: touchedShare,
      people_found: facts.outreach.people, people_contacted: facts.outreach.contacted, followups: facts.outreach.followups, replied: facts.outreach.replied,
      last_upload: facts.outreach.last_upload,
      by_title: byTitle.map(b => ({ job_title: b.job_title ?? '(no title)', found: Number(b.found), contacted: Number(b.contacted), replied: Number(b.replied) })),
    },
    checkin, thresholds: t, reasons: RESOLUTION_REASONS,
  };
}

/** Edit what the recruiter reviews: job titles, company lists, target date and the plan's lines. Saved in the plan's history with who and why. */
export async function updatePlanDetail(planId: string, input: Record<string, unknown>, user: JwtPayload): Promise<void> {
  const plan = await queryOne<{ status: string }>(`SELECT status FROM sourcing_plans WHERE id = $1::bigint`, [planId]);
  if (!plan) throw new SourcingError(404, 'Plan not found');
  if (plan.status === 'closed') throw new SourcingError(409, 'The role is closed');
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 300) : null;
  const fields: string[] = [];
  await query(`INSERT INTO sourcing_plan_details (plan_id, updated_by) VALUES ($1::bigint, $2::uuid) ON CONFLICT (plan_id) DO NOTHING`, [planId, user.userId]);
  if (Array.isArray(input.job_titles)) {
    await query(`UPDATE sourcing_plan_details SET job_titles = $2::text[], updated_by = $3::uuid, updated_at = NOW() WHERE plan_id = $1::bigint`, [planId, cleanList(input.job_titles), user.userId]);
    fields.push('job titles');
  }
  if (Array.isArray(input.company_list_ids)) {
    const ids = [...new Set(input.company_list_ids.filter((x): x is string => typeof x === 'string' && /^\d{1,18}$/.test(x)))];
    const valid = ids.length ? await query<{ id: string }>(`SELECT id::text AS id FROM sourcing_company_lists WHERE id = ANY($1::bigint[])`, [ids]) : [];
    await query(`UPDATE sourcing_plan_details SET company_list_ids = $2::bigint[], updated_by = $3::uuid, updated_at = NOW() WHERE plan_id = $1::bigint`, [planId, valid.map(v => v.id), user.userId]);
    fields.push('company lists');
  }
  if (input.target_date !== undefined) {
    const d = input.target_date;
    if (d !== null && !(typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))) throw new SourcingError(400, 'The target date must be a date');
    await query(`UPDATE sourcing_plan_details SET target_date = $2::date, updated_by = $3::uuid, updated_at = NOW() WHERE plan_id = $1::bigint`, [planId, d, user.userId]);
    fields.push('target date');
  }
  if (Array.isArray(input.rows)) {
    const rows = (input.rows as unknown[]).map(cleanRow);
    if (rows.some(r => r === null) || rows.length > 30) throw new SourcingError(400, 'Every plan line needs a channel name and a status (live, backup or not used)');
    if ((rows as TemplateRow[]).some(r => r.status === 'not_used' && !r.reason)) throw new SourcingError(400, 'A line that is not used needs a reason');
    await writeRows(planId, rows as TemplateRow[]);
    fields.push('plan lines');
  }
  if (!fields.length) throw new SourcingError(400, 'Nothing to change');
  await logChangeQ(planId, user.userId, { type: 'plan_detail_edited', fields }, reason);
}

/** Apply a different template to a draft plan (replacing its lines). */
export async function applyTemplate(planId: string, templateKey: string, user: JwtPayload): Promise<{ key: string; name: string }> {
  const r = await prefillPlan(planId, { templateKey, replace: true, userId: user.userId });
  if (!r) throw new SourcingError(404, 'Template not found');
  return r;
}

// ─── Weekly check-in ─────────────────────────────────────────────────────────────────────────────────
export async function submitCheckin(
  planId: string, input: { week_start?: string; answers?: Record<string, unknown>; blocker_text?: string | null }, user: JwtPayload, now: Date = new Date(),
): Promise<{ week_of: string }> {
  const today = istDate(now);
  const plan = await queryOne<{ status: string }>(`SELECT status FROM sourcing_plans WHERE id = $1::bigint`, [planId]);
  if (!plan) throw new SourcingError(404, 'Plan not found');
  if (plan.status !== 'active') throw new SourcingError(409, 'Only an active plan has a weekly check-in');
  const planRows = await query<{ status: string; mapped_channels: string[] }>(`SELECT status, mapped_channels FROM sourcing_plan_rows WHERE plan_id = $1::bigint`, [planId]);
  const allowed = new Set(applicableQuestions(planRows));
  const answers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.answers ?? {})) {
    if (!(CHECKIN_QUESTIONS as readonly string[]).includes(k) || !allowed.has(k)) continue;
    if (v === 'yes' || v === 'no') answers[k] = v;
  }
  const thisMonday = mondayOf(today);
  let week = input.week_start;
  if (week === undefined) {
    const prev = mondayOf(lastFridayOnOrBefore(today));
    const prevDone = await queryOne<{ n: string }>(`SELECT count(*)::text AS n FROM sourcing_checkins WHERE plan_id = $1::bigint AND week_start = $2::date`, [planId, prev]);
    week = Number(prevDone?.n) === 0 ? prev : thisMonday;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || mondayOf(week) !== week) throw new SourcingError(400, 'The check-in week must be the Monday of the week');
  if (week > thisMonday || week < addCalendarDays(thisMonday, -28)) throw new SourcingError(400, 'A check-in can be for this week or one of the last four');
  const blocker = typeof input.blocker_text === 'string' && input.blocker_text.trim() ? input.blocker_text.trim().slice(0, 500) : null;
  await query(
    `INSERT INTO sourcing_checkins (plan_id, week_start, answers, blocker_text, submitted_by) VALUES ($1::bigint, $2::date, $3::jsonb, $4, $5::uuid)
     ON CONFLICT (plan_id, week_start) DO UPDATE SET answers = EXCLUDED.answers, blocker_text = EXCLUDED.blocker_text, submitted_by = EXCLUDED.submitted_by, submitted_at = NOW()`,
    [planId, week, JSON.stringify(answers), blocker, user.userId]);
  await logChangeQ(planId, user.userId, { type: 'checkin_submitted', week_of: week, blocked: !!blocker });
  return { week_of: week };
}

// ─── Outreach upload ─────────────────────────────────────────────────────────────────────────────────
export interface UploadResult {
  upload_id: string; rows_total: number; people_new: number; followups: number; merged: number; rejected: RejectedRow[]; rejected_total: number; roles: string[];
  unlisted_companies: number;
}

export async function uploadOutreach(csv: string, filename: string | null, user: JwtPayload, now: Date = new Date()): Promise<UploadResult> {
  if (typeof csv !== 'string' || !csv.trim()) throw new SourcingError(400, 'The file is empty');
  if (csv.length > 1_500_000) throw new SourcingError(400, 'The file is too large (1.5 MB at most)');
  const today = istDate(now);
  const table = parseCsv(csv);
  const valid = await query<{ role_id: string }>(`SELECT role_id FROM sourcing_plans WHERE status IN ('draft','active','paused')`);
  const { rows, rejected, fatal } = validateOutreachRows(table, new Set(valid.map(v => v.role_id)), today);
  if (fatal) throw new SourcingError(400, fatal);
  if (rows.length === 0) throw new SourcingError(400, `No usable rows — ${rejected.slice(0, 3).map(r => `row ${r.row}: ${r.reason}`).join('; ') || 'nothing to import'}`);

  // Fold rows in file order, earliest date first for the same person, so the first contact is the earliest and each later date is one follow-up.
  const ordered = [...rows].sort((a, b) => (a.date_contacted ?? '9999') < (b.date_contacted ?? '9999') ? -1 : (a.date_contacted ?? '9999') > (b.date_contacted ?? '9999') ? 1 : 0);
  const keys = [...new Set(ordered.map(r => `${r.role_id}|${r.profile_key}`))];
  const companyKeys = [...new Set(ordered.map(r => companyKey(r.company)))].filter(Boolean);
  const out = await transaction(async (client) => {
    const stored = new Map<string, StoredPerson>();
    const existing = await client.query(
      `SELECT role_id, profile_key, to_char(first_contacted,'YYYY-MM-DD') AS first_contacted, to_char(last_contacted,'YYYY-MM-DD') AS last_contacted, followups,
              status, to_char(next_followup,'YYYY-MM-DD') AS next_followup, outcome, job_title, company_text
         FROM sourcing_outreach_people WHERE (role_id || '|' || profile_key) = ANY($1::text[])`, [keys]);
    for (const e of existing.rows) stored.set(`${e.role_id}|${e.profile_key}`, e as StoredPerson);
    const companies = await client.query(`SELECT id::text AS id, name_key FROM sourcing_companies WHERE name_key = ANY($1::text[])`, [companyKeys]);
    const companyId = new Map<string, string>(companies.rows.map((c: { id: string; name_key: string }) => [c.name_key, c.id]));

    const up = await client.query(
      `INSERT INTO sourcing_outreach_uploads (uploaded_by, filename, rows_total, role_ids) VALUES ($1::uuid, $2, $3, $4::text[]) RETURNING id::text AS id`,
      [user.userId, filename?.slice(0, 200) ?? null, table.length - 1, [...new Set(ordered.map(r => r.role_id))]]);
    const uploadId = up.rows[0].id as string;
    let created = 0, followups = 0, merged = 0, unlisted = 0;
    for (const r of ordered) {
      const k = `${r.role_id}|${r.profile_key}`;
      const m = mergePerson(stored.get(k) ?? null, r);
      stored.set(k, m.person);
      if (m.kind === 'new') created++; else if (m.kind === 'followup') followups++; else merged++;
      const cid = companyId.get(companyKey(r.company)) ?? null;
      if (!cid) unlisted++;
      const p = m.person;
      await client.query(
        `INSERT INTO sourcing_outreach_people (role_id, profile_key, profile_link, company_text, company_id, job_title, first_contacted, last_contacted, followups, status,
                                               next_followup, outcome, replied, qualified, upload_id)
         VALUES ($1,$2,$3,$4,$5::bigint,$6,$7::date,$8::date,$9,$10,$11::date,$12,$13,$14,$15::bigint)
         ON CONFLICT (role_id, profile_key) DO UPDATE SET company_text = EXCLUDED.company_text, company_id = COALESCE(EXCLUDED.company_id, sourcing_outreach_people.company_id),
           job_title = EXCLUDED.job_title, first_contacted = EXCLUDED.first_contacted, last_contacted = EXCLUDED.last_contacted, followups = EXCLUDED.followups,
           status = EXCLUDED.status, next_followup = EXCLUDED.next_followup, outcome = EXCLUDED.outcome, replied = EXCLUDED.replied, qualified = EXCLUDED.qualified,
           upload_id = EXCLUDED.upload_id, updated_at = NOW()`,
        [r.role_id, r.profile_key, r.profile_link, p.company_text, cid, p.job_title, p.first_contacted, p.last_contacted, p.followups, p.status, p.next_followup, p.outcome,
         p.replied, p.qualified, uploadId]);
    }
    await client.query(
      `UPDATE sourcing_outreach_uploads SET rows_new = $2, rows_followup = $3, rows_merged = $4, rows_rejected = $5, rejected = $6::jsonb WHERE id = $1::bigint`,
      [uploadId, created, followups, merged, rejected.length, JSON.stringify(rejected.slice(0, 50))]);
    return { uploadId, created, followups, merged, unlisted };
  });

  const roles = [...new Set(ordered.map(r => r.role_id))];
  for (const roleId of roles) {
    const p = await queryOne<{ id: string }>(`SELECT id::text AS id FROM sourcing_plans WHERE role_id = $1`, [roleId]);
    if (p) await logChangeQ(p.id, user.userId, { type: 'outreach_uploaded', new: ordered.filter(r => r.role_id === roleId).length, followups: out.followups });
  }
  return { upload_id: out.uploadId, rows_total: table.length - 1, people_new: out.created, followups: out.followups, merged: out.merged, rejected: rejected.slice(0, 50), rejected_total: rejected.length, roles, unlisted_companies: out.unlisted };
}

// ─── Reminders (the recruiter's "what is coming up") ────────────────────────────────────────────────
export interface Reminder { kind: 'checkin' | 'outreach_upload' | 'untagged' | 'plan'; role_id: string; title: string; due: string | null; overdue: boolean; detail: string }

export async function getReminders(now: Date = new Date()): Promise<Reminder[]> {
  const today = istDate(now);
  const t = await loadDetailThresholds();
  const facts = await loadDetailFacts({ now, statuses: ['active'] });
  const friday = lastFridayOnOrBefore(today);
  const nextFriday = addCalendarDays(friday, friday >= today ? 0 : 7);
  const out: Reminder[] = [];
  for (const f of facts) {
    if (!f.activated_on) continue;
    const dueWeek = mondayOf(friday);
    if (f.activated_on < friday && !f.checkins.some(c => c.week_start === dueWeek)) {
      out.push({ kind: 'checkin', role_id: f.role_id, title: `Weekly check-in due for ${f.role_id}`, due: friday, overdue: today > friday, detail: f.title });
    } else if (!f.checkins.some(c => c.week_start === mondayOf(today))) {
      out.push({ kind: 'checkin', role_id: f.role_id, title: `Weekly check-in for ${f.role_id}`, due: nextFriday, overdue: false, detail: f.title });
    }
    const hasOutbound = f.rows.some(r => r.status === 'live' && r.mapped_channels.includes('Direct Outreach'));
    if (hasOutbound && (!f.outreach.last_upload || f.outreach.last_upload < mondayOf(today))) {
      out.push({ kind: 'outreach_upload', role_id: f.role_id, title: `Upload the outreach sheet for ${f.role_id}`, due: nextFriday, overdue: false, detail: f.outreach.last_upload ? `Last upload ${f.outreach.last_upload}` : 'No upload yet' });
    }
    const untagged = cohortOf(f).filter(a => !a.sub_source || a.sub_source === 'untagged_default').length;
    if (untagged > 0) out.push({ kind: 'untagged', role_id: f.role_id, title: `${untagged} candidate${untagged === 1 ? '' : 's'} on ${f.role_id} ha${untagged === 1 ? 's' : 've'} no source`, due: null, overdue: false, detail: 'Choose a source so the channel numbers can be trusted' });
  }
  const drafts = await query<{ role_id: string; title: string }>(
    `SELECT p.role_id, r.title FROM sourcing_plans p JOIN roles r ON r.id = p.role_id WHERE p.status = 'draft' AND r.status = ANY($1::text[]) ORDER BY p.role_id LIMIT 20`, [OPEN]);
  for (const d of drafts) out.push({ kind: 'plan', role_id: d.role_id, title: `Review and activate the plan for ${d.role_id}`, due: null, overdue: false, detail: d.title });
  return out;
}

// ─── Leadership overview (Screen 5) ──────────────────────────────────────────────────────────────────
export interface OverviewRow {
  role_id: string; title: string; priority: string; plan_status: string; hiring_manager: string | null;
  enough: PlanHealth['enough'] | null; right: PlanHealth['right'] | null; worked: PlanHealth['worked'] | null;
  open_alerts: number; provisional_alerts: number; hm_alerts: number; headline: string | null;
}
export interface Overview {
  summary: { roles_with_active_plan: number; roles_total: number; checkins_on_time: number; checkins_due: number; open_alerts: number; hm_alerts: number };
  rows: OverviewRow[];
}

/** Alerts that need the hiring manager as well as the recruiter. (Owner is a label: in HMS the HR persona owns every alert.) */
export const HM_INVOLVED_TYPES = ['HM_REJECTS_MOST', 'WRONG_CANDIDATES'] as const;
export const ALERT_OWNER_LABEL: Record<string, string> = { HM_REJECTS_MOST: 'Recruiter + hiring manager', WRONG_CANDIDATES: 'Recruiter + hiring manager' };

export async function getOverview(now: Date = new Date()): Promise<Overview> {
  const settings = await loadSettings();
  const t = await loadDetailThresholds();
  const today = istDate(now);
  // Active and paused plans, plus the drafts of roles that are open (a draft plan of a role that is not open is nobody's to-do).
  const roles = await query<{ plan_id: string; hiring_manager_name: string | null }>(
    `SELECT p.id::text AS plan_id, r.hiring_manager_name FROM sourcing_plans p JOIN roles r ON r.id = p.role_id
      WHERE p.status IN ('active','paused') OR (p.status = 'draft' AND r.status = ANY($1::text[]))`, [OPEN]);
  const facts = roles.length ? await loadDetailFacts({ now, planIds: roles.map(r => r.plan_id) }) : [];
  const hmBy = new Map(roles.map(r => [r.plan_id, r.hiring_manager_name]));
  const alerts = await query<{ plan_id: string; type: string; is_shadow: boolean; n: string; evidence: Record<string, unknown>; channel: string }>(
    `SELECT plan_id::text AS plan_id, type, is_shadow, count(*)::text AS n, (array_agg(evidence ORDER BY severity DESC))[1] AS evidence, (array_agg(channel ORDER BY severity DESC))[1] AS channel
       FROM sourcing_exceptions WHERE status IN ('open','blocked') AND plan_id = ANY($1::bigint[]) GROUP BY plan_id, type, is_shadow`, [facts.map(f => f.plan_id)]);

  // Weekly check-ins on time over the last four due Fridays (only for weeks the plan was already active).
  const fridays = [0, 1, 2, 3].map(i => addCalendarDays(lastFridayOnOrBefore(today), -7 * i));
  const submitted = await query<{ plan_id: string; week_start: string; submitted_at: Date }>(
    `SELECT plan_id::text AS plan_id, to_char(week_start,'YYYY-MM-DD') AS week_start, submitted_at FROM sourcing_checkins WHERE week_start >= $1::date`, [addCalendarDays(mondayOf(fridays[3]), 0)]);
  let due = 0, onTime = 0;
  for (const f of facts) {
    if (f.plan_status !== 'active' || !f.activated_on) continue;
    for (const fr of fridays) {
      if (f.activated_on >= fr) continue;
      const limit = endOfIstDay(addWorkingDays(fr, t.checkin_overdue_working_days));
      if (limit.getTime() > now.getTime() && !submitted.some(s => s.plan_id === f.plan_id && s.week_start === mondayOf(fr))) continue;   // not yet late: not counted either way
      due++;
      const s = submitted.find(x => x.plan_id === f.plan_id && x.week_start === mondayOf(fr));
      if (s && new Date(s.submitted_at).getTime() <= limit.getTime()) onTime++;
    }
  }

  const rows: OverviewRow[] = facts.map(f => {
    const mine = alerts.filter(a => a.plan_id === f.plan_id);
    const live = mine.filter(a => !a.is_shadow);
    const health = f.plan_status === 'active' ? computeHealth(f, now, settings.qualified_rule, t) : null;
    const top = live[0];
    const headline = f.plan_status === 'draft' ? 'Plan not activated'
      : top ? describeException({ type: top.type, channel: top.channel, evidence: top.evidence }).happened : null;
    return {
      role_id: f.role_id, title: f.title, priority: f.priority, plan_status: f.plan_status, hiring_manager: hmBy.get(f.plan_id) ?? null,
      enough: health?.enough ?? null, right: health?.right ?? null, worked: health?.worked ?? null,
      open_alerts: live.reduce((s, a) => s + Number(a.n), 0), provisional_alerts: mine.filter(a => a.is_shadow).reduce((s, a) => s + Number(a.n), 0),
      hm_alerts: live.filter(a => (HM_INVOLVED_TYPES as readonly string[]).includes(a.type)).reduce((s, a) => s + Number(a.n), 0), headline,
    };
  });
  const PRI: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  rows.sort((a, b) => (PRI[a.priority] ?? 9) - (PRI[b.priority] ?? 9) || b.open_alerts - a.open_alerts || a.role_id.localeCompare(b.role_id));
  return {
    summary: {
      roles_with_active_plan: rows.filter(r => r.plan_status === 'active').length, roles_total: rows.length, checkins_on_time: onTime, checkins_due: due,
      open_alerts: rows.reduce((s, r) => s + r.open_alerts, 0), hm_alerts: rows.reduce((s, r) => s + r.hm_alerts, 0),
    },
    rows,
  };
}
