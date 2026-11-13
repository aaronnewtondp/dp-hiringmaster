// Gathers the facts the health boxes and the additional alert detectors judge (utils/sourcingDetailRules.ts). Read-only, set-based:
// a fixed handful of queries however many plans there are — never a per-plan loop. Shared by the role page, the leadership overview
// and the engine, so all three always agree.
import { query } from '../db/index.js';
import { addCalendarDays, istDate, mondayOf } from '../utils/workingDays.js';
import { mergeDetailThresholds, DetailThresholds, RowStatus, TrackedAs } from '../utils/sourcingDetail.js';
import { QUALIFIED_TIMESTAMPS_SQL } from '../utils/sourcingQualified.js';
import { AppFact, CheckinFact, CompanyFact, completedWeeks, DetailFacts, OutreachFact, RowFact } from '../utils/sourcingDetailRules.js';
import { loadSettings } from './sourcingSettings.js';
import { effectiveTarget } from './sourcingPlans.js';

export async function loadDetailThresholds(): Promise<DetailThresholds> {
  const rows = await query<{ value: unknown }>(`SELECT value FROM sourcing_settings WHERE key = 'detail_thresholds'`);
  return mergeDetailThresholds(rows[0]?.value);
}

/** Applications looked at: those that applied, were scored or were touched in the last 56 days — the same predicate the volume rule uses. */
export const FACT_WINDOW_DAYS = 56;

const emptyOutreach = (): OutreachFact => ({
  people: 0, contacted: 0, followups: 0, replied: 0, qualified: 0, contacted_7d: 0, contacted_last_week: 0, stale_found: 0, last_upload: null, last_contact: null,
});

export async function loadDetailFacts(opts: { planIds?: string[]; statuses?: string[]; now?: Date } = {}): Promise<DetailFacts[]> {
  const now = opts.now ?? new Date();
  const today = istDate(now);
  const settings = await loadSettings();
  const statuses = opts.statuses ?? ['draft', 'active', 'paused'];

  const plans = await query<{
    plan_id: string; role_id: string; title: string; priority: string; plan_status: string; activated_on: string | null; weekly_qualified_target: number | null;
    company_list_ids: string[] | null;
  }>(
    `SELECT p.id::text AS plan_id, p.role_id, r.title, r.priority, p.status AS plan_status,
            to_char(p.activated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS activated_on, p.weekly_qualified_target,
            (SELECT d.company_list_ids::text[] FROM sourcing_plan_details d WHERE d.plan_id = p.id) AS company_list_ids
       FROM sourcing_plans p JOIN roles r ON r.id = p.role_id
      WHERE p.status = ANY($1::text[]) AND ($2::bigint[] IS NULL OR p.id = ANY($2::bigint[]))`,
    [statuses, opts.planIds ?? null]);
  if (!plans.length) return [];
  const planIds = plans.map(p => p.plan_id);
  const roleIds = plans.map(p => p.role_id);
  const since = new Date(now.getTime() - FACT_WINDOW_DAYS * 86400000);
  const lastWeek = completedWeeks(today, 1)[0];
  const d7 = addCalendarDays(today, -7);
  const staleBefore = addCalendarDays(today, -5);

  const [rowRows, chanRows, appRows, outRows, uploadRows, checkinRows, agencyRows] = await Promise.all([
    query<RowFact & { plan_id: string }>(
      `SELECT id::text AS id, plan_id::text AS plan_id, workbook_channel, mapped_channels, status, tracked_as, weekly_work::float AS weekly_work,
              expected_qualified::float AS expected_qualified, start_condition, platform
         FROM sourcing_plan_rows WHERE plan_id = ANY($1::bigint[]) ORDER BY position, id`, [planIds]),
    query<{ plan_id: string; channel: string; state: string }>(
      `SELECT plan_id::text AS plan_id, channel, state FROM sourcing_plan_channels WHERE plan_id = ANY($1::bigint[])`, [planIds]),
    query<{ role_id: string } & AppFact>(
      `SELECT a.role_id, a.sub_source, a.application_date, a.status, a.stage, a.recruiter_screening_status AS screening, ${QUALIFIED_TIMESTAMPS_SQL}
         FROM applications a
        WHERE a.role_id = ANY($1::text[])
          AND (a.score_computed_at >= $2 OR a.last_updated >= $2 OR a.application_date >= $2)`, [roleIds, since]),
    query<{ role_id: string } & Record<string, string | null>>(
      `SELECT role_id, count(*)::text AS people, count(first_contacted)::text AS contacted, COALESCE(sum(followups),0)::text AS followups,
              count(*) FILTER (WHERE replied)::text AS replied, count(*) FILTER (WHERE qualified)::text AS qualified,
              count(*) FILTER (WHERE first_contacted > $2::date)::text AS contacted_7d,
              count(*) FILTER (WHERE first_contacted BETWEEN $3::date AND $4::date)::text AS contacted_last_week,
              count(*) FILTER (WHERE first_contacted IS NULL AND created_at < ($5::date)::timestamp)::text AS stale_found,
              to_char(max(last_contacted), 'YYYY-MM-DD') AS last_contact
         FROM sourcing_outreach_people WHERE role_id = ANY($1::text[]) GROUP BY role_id`, [roleIds, d7, lastWeek.start, lastWeek.end, staleBefore]),
    query<{ role_id: string; last_upload: string | null }>(
      `SELECT r AS role_id, to_char(max(u.uploaded_at) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS last_upload
         FROM sourcing_outreach_uploads u, unnest(u.role_ids) AS r WHERE r = ANY($1::text[]) GROUP BY r`, [roleIds]),
    query<CheckinFact & { plan_id: string }>(
      `SELECT plan_id::text AS plan_id, to_char(week_start, 'YYYY-MM-DD') AS week_start, answers, blocker_text
         FROM sourcing_checkins WHERE plan_id = ANY($1::bigint[]) AND week_start >= $2::date ORDER BY week_start DESC`, [planIds, addCalendarDays(mondayOf(today), -63)]),
    query<{ plan_id: string }>(
      `SELECT DISTINCT ch.plan_id::text AS plan_id
         FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id = c.plan_channel_id
        WHERE ch.plan_id = ANY($1::bigint[]) AND ch.channel = 'Agency' AND c.kind = 'followup_agency' AND c.status = 'open' AND c.due_at < $2`, [planIds, now]),
  ]);

  // Company coverage per plan: companies in the plan's lists, how many the role's outreach has touched, and how many people that found.
  const listIds = [...new Set(plans.flatMap(p => p.company_list_ids ?? []))];
  const members = listIds.length ? await query<{ list_id: string; company_id: string }>(
    `SELECT m.list_id::text AS list_id, m.company_id::text AS company_id
       FROM sourcing_company_list_members m JOIN sourcing_companies c ON c.id = m.company_id
      WHERE m.list_id = ANY($1::bigint[]) AND NOT c.excluded`, [listIds]) : [];
  const touched = listIds.length ? await query<{ role_id: string; company_id: string; people: string }>(
    `SELECT role_id, company_id::text AS company_id, count(*)::text AS people
       FROM sourcing_outreach_people WHERE role_id = ANY($1::text[]) AND company_id IS NOT NULL GROUP BY role_id, company_id`, [roleIds]) : [];

  const by = <T extends { plan_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>(); for (const r of rows) { const l = m.get(r.plan_id) ?? []; l.push(r); m.set(r.plan_id, l); } return m;
  };
  const rowsBy = by(rowRows); const chanBy = by(chanRows); const checkBy = by(checkinRows);
  const appsByRole = new Map<string, AppFact[]>();
  for (const a of appRows) { const l = appsByRole.get(a.role_id) ?? []; l.push({ ...a, application_date: new Date(a.application_date), shortlisted_at: a.shortlisted_at ? new Date(a.shortlisted_at) : null, scored_at: a.scored_at ? new Date(a.scored_at) : null }); appsByRole.set(a.role_id, l); }
  const outBy = new Map(outRows.map(o => [o.role_id, o]));
  const upBy = new Map(uploadRows.map(u => [u.role_id, u.last_upload]));
  const agencyOverdue = new Set(agencyRows.map(a => a.plan_id));
  const memberBy = new Map<string, string[]>();
  for (const m of members) { const l = memberBy.get(m.list_id) ?? []; l.push(m.company_id); memberBy.set(m.list_id, l); }

  return plans.map(p => {
    const o = outBy.get(p.role_id);
    const outreach: OutreachFact = o ? {
      people: Number(o.people), contacted: Number(o.contacted), followups: Number(o.followups), replied: Number(o.replied), qualified: Number(o.qualified),
      contacted_7d: Number(o.contacted_7d), contacted_last_week: Number(o.contacted_last_week), stale_found: Number(o.stale_found),
      last_upload: upBy.get(p.role_id) ?? null, last_contact: (o.last_contact as string | null) ?? null,
    } : { ...emptyOutreach(), last_upload: upBy.get(p.role_id) ?? null };

    const companyIds = new Set((p.company_list_ids ?? []).flatMap(l => memberBy.get(l) ?? []));
    const mine = touched.filter(t => t.role_id === p.role_id && companyIds.has(t.company_id));
    const companies: CompanyFact = { listed: companyIds.size, touched: mine.length, people_in_touched: mine.reduce((s, t) => s + Number(t.people), 0) };

    const channel_states: Record<string, string> = {};
    for (const c of chanBy.get(p.plan_id) ?? []) channel_states[c.channel] = c.state;
    const eff = effectiveTarget(p.weekly_qualified_target, p.priority, settings);
    return {
      plan_id: p.plan_id, role_id: p.role_id, title: p.title, priority: p.priority, plan_status: p.plan_status, activated_on: p.activated_on,
      target: eff.applicable ? eff.min : null,
      rows: (rowsBy.get(p.plan_id) ?? []).map(r => ({ ...r, status: r.status as RowStatus, tracked_as: r.tracked_as as TrackedAs | null })),
      channel_states, agency_followup_overdue: agencyOverdue.has(p.plan_id),
      apps: appsByRole.get(p.role_id) ?? [], outreach, companies,
      checkins: (checkBy.get(p.plan_id) ?? []).map(c => ({ week_start: c.week_start, answers: (c.answers ?? {}) as Record<string, string>, blocker_text: c.blocker_text })),
    };
  });
}
