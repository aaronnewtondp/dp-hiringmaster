import { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, Briefcase, Users, TrendingUp, TrendingDown, Radio, Gauge, Lock } from 'lucide-react';
import { dashboardApi, rolesApi } from '../services/api.ts';
import { DashboardData, Priority, STAGES, PRIORITIES, LOCATIONS, DEPARTMENTS } from '../types/index.ts';
import { PriorityBadge, AgingBadge, StageBadge, Spinner, EmptyState } from '../components/shared/Badges.tsx';
import MultiSelectFilter from '../components/shared/MultiSelectFilter.tsx';
import HiringFunnelSnapshot from '../components/shared/HiringFunnelSnapshot.tsx';
import InfoTooltip from '../components/shared/InfoTooltip.tsx';
import { usePersistedState } from '../hooks/usePersistedState.ts';
import { useAuth } from '../contexts/AuthContext.tsx';

// SLA breach types, per slaChecker.ts's stage/breach-type engine — kept here
// (not generated from the backend) since these are fixed, named categories
// meant for a human reader, not a live data shape.
// Aging Roles now lists every Approved/Live – Sourcing/On Hold role, not
// just overdue ones (2026-09-01) — sorted red-first so the roles that
// actually need attention still surface at the top of a now-longer list.
const AGING_SEVERITY: Record<'red' | 'yellow' | 'ok', number> = { red: 0, yellow: 1, ok: 2 };

const SLA_BREACH_TYPES_INFO = (
  <div className="space-y-1.5">
    <div className="font-medium text-white">SLA breach types</div>
    <ul className="space-y-1">
      <li><b>Idle Candidate</b> — no stage change in 48h+ (Reference Check, Pre-Joining Docs, Offer Discussion, Offer Released)</li>
      <li><b>Resume Shortlist Pending</b> — HM hasn't shortlisted within 48h of Applied</li>
      <li><b>Interview/Founders Round Not Scheduled</b> — no round booked within 48h of entering that stage</li>
      <li><b>Assignment Not Sent</b> — assignment not sent within 48h of entering Assignment Round</li>
      <li><b>Interview/Founders Feedback Due</b> — HM hasn't submitted feedback within 48h of the interview</li>
      <li><b>Assignment Feedback Due</b> — HM hasn't submitted feedback within 96h of the assignment being sent</li>
      <li><b>Joining risk — no contact</b> — no HR contact logged in 5+ days after Offer Accepted</li>
    </ul>
  </div>
);

// ─── KPI card (stat tile v2) ────────────────────────────────────────────────
// Header row: icon + label + the headline number inline (bold, two Tailwind
// steps down from the old standalone 2xl now that it sits beside text).
// Below it: a 2x2 grid of 4 supporting sub-metrics. Sub-metric values stay
// neutral gray uniformly — the header icon's `accent` already carries the
// one severity signal a card needs, so tinting every sub-metric too would
// be redundant emphasis rather than new information.
function KpiCard({ icon: Icon, label, value, sub, accent, info, infoWidth, infoAlign = 'left' }: {
  icon: React.ElementType; label: string; value: number | string;
  sub: [string, string | number][]; accent?: string; info?: ReactNode; infoWidth?: string;
  infoAlign?: 'left' | 'right' | 'center';
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-3">
        <Icon className={`w-4 h-4 shrink-0 ${accent || 'text-gray-400'}`} />
        <span className="text-xs font-medium text-gray-500">{label}</span>
        {info && <InfoTooltip text={info} align={infoAlign} {...(infoWidth ? { width: infoWidth } : {})} />}
        <span className="text-3xl font-mono font-bold text-gray-900 ml-auto">{value}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 pt-3 border-t border-gray-100">
        {sub.map(([subLabel, subValue]) => (
          <div key={subLabel}>
            <div className="text-[11px] text-gray-400 leading-tight">{subLabel}</div>
            <div className="text-sm font-mono font-semibold text-gray-700 mt-0.5">{subValue}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  // A Hiring Manager's dashboard is locked to their own role(s) — enforced
  // server-side (dashboard.ts overrides role_id outright for this persona
  // regardless of what's sent), so this is purely about being honest in the
  // UI rather than showing a Role filter that would silently do nothing.
  const isLockedToOwnRole = user?.persona === 'hiring_manager';

  // Master filters — same fields/semantics as the Roles summary view's own
  // filters (backend/src/utils/roleFilters.ts is the single shared
  // implementation), just scoped to the whole dashboard instead of one page:
  // every metric/section below is computed only over roles matching these.
  const [departments, setDepartments] = usePersistedState<string[]>('dashboard.departments', []);
  const [locations,   setLocations]   = usePersistedState<string[]>('dashboard.locations', []);
  const [modes,        setModes]      = usePersistedState<string[]>('dashboard.modes', []);
  const [filterPriorities, setFilterPriorities] = usePersistedState<string[]>('dashboard.priorities', []);
  const [roleIds,      setRoleIds]    = usePersistedState<string[]>('dashboard.roleIds', []);

  const { data: filterOptionsData } = useQuery<{ data: { recruitment_modes: string[]; roles: { id: string; title: string }[] } }>({
    queryKey: ['roles', 'filter-options'],
    queryFn:  () => rolesApi.filterOptions(),
    enabled:  !isLockedToOwnRole,
  });
  const modeOptions = filterOptionsData?.data?.recruitment_modes || [];
  const roleOptions = (filterOptionsData?.data?.roles || []).map(r => ({ value: r.id, label: r.title }));

  const filterParams: Record<string, string[]> = {};
  if (departments.length)      filterParams.department = departments;
  if (locations.length)        filterParams.location = locations;
  if (modes.length)            filterParams.recruitment_mode = modes;
  if (filterPriorities.length) filterParams.priority = filterPriorities;
  // Never sent for a Hiring Manager — the backend ignores/overrides it for
  // this persona anyway, so sending it would just be misleading.
  if (roleIds.length && !isLockedToOwnRole) filterParams.role_id = roleIds;

  const { data, isLoading, error } = useQuery<{ data: DashboardData }>({
    queryKey: ['dashboard', departments, locations, modes, filterPriorities, roleIds],
    queryFn:  () => dashboardApi.get(filterParams),
    refetchInterval: 5 * 60 * 1000, // refresh every 5 min
  });

  if (isLoading) return (
    <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>
  );
  if (error || !data) return (
    <EmptyState title="Failed to load dashboard" message="Check your connection and try again" />
  );

  const d = data.data;
  const { metrics, aging_roles, hiring_funnel,
          source_quality, velocity, low_pipeline } = d;

  // Shared canonical order from types/index.ts. hiring_funnel now always
  // carries all 13 stages regardless of filters (the backend fills in zero
  // counts), so every stage renders even when a filtered view has nobody
  // currently Active there — it used to silently vanish when the funnel
  // only counted status='Active' candidates.
  const FUNNEL_ORDER = STAGES;
  const funnelMap = new Map(hiring_funnel.map(f => [f.stage, f]));
  const maxFunnelVal = Math.max(...hiring_funnel.map(f => f.active), 1);

  const hasActiveFilters = departments.length + locations.length + modes.length
    + filterPriorities.length + (isLockedToOwnRole ? 0 : roleIds.length) > 0;
  const clearAllFilters = () => {
    setDepartments([]); setLocations([]); setModes([]); setFilterPriorities([]); setRoleIds([]);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">Hiring health overview — updated live</p>
        </div>
      </div>

      {/* Master filters — every section below reflects these */}
      <div className="flex items-center gap-2 flex-wrap">
        <MultiSelectFilter label="Department"       options={DEPARTMENTS}       selected={departments}      onChange={setDepartments} />
        <MultiSelectFilter label="Location"         options={LOCATIONS}         selected={locations}        onChange={setLocations} />
        <MultiSelectFilter label="Recruitment Mode" options={modeOptions}       selected={modes}             onChange={setModes} />
        <MultiSelectFilter label="Priority"         options={PRIORITIES}        selected={filterPriorities} onChange={setFilterPriorities} />
        {isLockedToOwnRole ? (
          <span
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-gray-50 text-xs text-gray-500"
            title="Every metric on this page is scoped to your own role(s) — this can't be changed"
          >
            <Lock className="w-3 h-3" /> Locked to your role
          </span>
        ) : (
          <MultiSelectFilter label="Role" options={roleOptions} selected={roleIds} onChange={setRoleIds} />
        )}
        {hasActiveFilters && (
          <button onClick={clearAllFilters} className="text-xs text-gray-400 hover:text-gray-600 underline">
            Clear all
          </button>
        )}
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <KpiCard icon={Briefcase} label="Open roles" value={metrics.open_roles_count} accent="text-dp-600"
          info="Roles currently Live – Sourcing, Approved, or Under Review — Draft and Closed roles don't count. Avg. active role age is the mean days since each open role's approval date; Avg. time to fill is the mean days from a role's approval to its first accepted offer, across all-time history."
          sub={[
            ['P0+P1 roles', metrics.open_roles_by_priority.P0 + metrics.open_roles_by_priority.P1],
            ['Avg. active role age', metrics.avg_active_role_age_days != null ? `${metrics.avg_active_role_age_days}d` : '—'],
            ['Avg. time to fill', metrics.avg_time_to_fill_days != null ? `${metrics.avg_time_to_fill_days}d` : '—'],
            ['Filled (30D)', metrics.roles_filled_last_30d],
          ]} />
        <KpiCard icon={Users} label="Active candidates" value={metrics.active_candidates} accent="text-green-600"
          info="Every application with status = Active (i.e. not Rejected, Withdrawn, Hold for Future, or Joined). Score ≥75/≤45 are ResumeIQ fit-score bands; ≥Interview 1 counts candidates currently sitting at Interview Round 1 or later; Unmatched is Job Application Form submissions that never matched an open role."
          sub={[
            ['Score ≥75', metrics.candidates_score_ge_75],
            ['Score ≤45', metrics.candidates_score_le_45],
            ['≥Interview 1', metrics.candidates_at_interview1_plus],
            ['Unmatched', metrics.candidates_unmatched],
          ]} />
        <KpiCard icon={AlertTriangle} label="SLA breaches" value={metrics.sla_breach_total}
          accent={metrics.sla_breach_total > 0 ? 'text-red-500' : 'text-gray-400'}
          info={SLA_BREACH_TYPES_INFO} infoWidth="w-96" infoAlign="right"
          sub={[
            ['HR/Admin', metrics.sla_breach_by_owner['HR / Recruiter'] || 0],
            ['Hiring Manager', metrics.sla_breach_by_owner['Hiring Manager'] || 0],
            ['Top type', metrics.sla_breach_top_type?.type ?? '—'],
            ['Top stage', metrics.sla_breach_top_stage?.stage ?? '—'],
          ]} />
      </div>

      {/* Hiring Funnel Snapshot — replaces the old "Pending actions by owner" board */}
      <HiringFunnelSnapshot masterFilterParams={filterParams} />

      {/* Aging roles + Hiring funnel */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Aging roles */}
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-900">Aging roles</h2>
            <InfoTooltip align="left" text="Every role currently Approved, Live – Sourcing, or On Hold, with how long it's been open. Only an Approved or Live – Sourcing role that's actually passed its own Close Target gets highlighted — yellow then red, thresholds set per priority — a role with no Close Target set falls back to flagging on days-since-opened instead. On Hold roles are shown for reference (how long they've been open) but never get an aging alert, since the clock isn't really running while a role is paused." />
          </div>
          {aging_roles.length === 0 ? (
            <div className="p-5"><EmptyState title="No open roles" /></div>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-white">
                  <tr className="border-b border-gray-100">
                    <th className="table-th">Role</th>
                    <th className="table-th">P</th>
                    <th className="table-th">HM</th>
                    <th className="table-th">Status</th>
                    <th className="table-th">Age</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {[...aging_roles]
                    .sort((a, b) => AGING_SEVERITY[a.aging_alert] - AGING_SEVERITY[b.aging_alert])
                    .map(r => (
                    <tr key={r.id} className={r.aging_alert === 'red' ? 'bg-red-50' : r.aging_alert === 'yellow' ? 'bg-amber-50' : ''}>
                      <td className="table-td font-medium text-gray-900">
                        <Link to={`/roles/${r.id}`} className="hover:text-dp-600">{r.title}</Link>
                      </td>
                      <td className="table-td"><PriorityBadge priority={r.priority as Priority} /></td>
                      <td className="table-td text-gray-500 text-xs">{r.hiring_manager_name}</td>
                      <td className="table-td"><StageBadge stage={r.status} /></td>
                      <td className="table-td">
                        <AgingBadge alert={r.aging_alert} daysOpen={r.days_open} daysOverdue={r.days_overdue} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Hiring funnel */}
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-semibold text-gray-900">Hiring funnel</h2>
              <InfoTooltip align="left" text="Every candidate who has ever reached each stage, not just those currently sitting there. The bar shows how many are still Active at that stage; the subtext below it breaks out how many were later Rejected, Withdrawn, or put on Hold for Future while at that stage — stage never resets once a candidate moves on, even after rejection." />
            </div>
          </div>
          <div className="px-5 py-4 space-y-2.5">
            {FUNNEL_ORDER.map(stage => {
              const f = funnelMap.get(stage);
              const active = f?.active ?? 0;
              const pct    = Math.round((active / maxFunnelVal) * 100);
              return (
                <div key={stage} className="flex items-center gap-3">
                  <span className="text-xs text-gray-500 w-36 truncate shrink-0">{stage}</span>
                  <div className="flex-1">
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-dp-400 rounded-full transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {(!!f?.rejected || !!f?.withdrawn || !!f?.hold_for_future) && (
                      <div className="text-[10px] font-mono mt-0.5 space-x-2">
                        {!!f?.rejected && <span className="text-red-400">{f.rejected} rejected</span>}
                        {!!f?.withdrawn && <span className="text-amber-500">{f.withdrawn} withdrawn</span>}
                        {!!f?.hold_for_future && <span className="text-gray-400">{f.hold_for_future} on hold</span>}
                      </div>
                    )}
                  </div>
                  <span className="text-xs font-mono font-medium text-gray-700 w-6 text-right">{active}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Source Quality + Low Pipeline Roles (PRD §18 Phase 2) — Time to Fill
          and Roles by status were retired as standalone cards: Time to
          Fill's headline moved into the Open Roles KPI card above, and
          Roles by status is superseded by the richer per-status breakdown
          already on the Roles page. This frees the row for Low Pipeline
          Roles, previously buried below the fold under Operational
          Velocity despite being one of the more actionable "needs sourcing
          help" signals on the page. */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-base font-semibold text-gray-900">Source quality &amp; pipeline</h2>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Source Quality */}
          <div className="card overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
              <Radio className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-semibold text-gray-900">Source quality</h2>
              <InfoTooltip align="left" text="Computed over full application history (not just Active), per source channel. Pass rate = % that ever reached Interview Round 1 or later. Hire rate = % that ever reached Offer Accepted or later. Contribution = that channel's share of all sourced applications." />
            </div>
            <div className="px-5 py-4 space-y-4">
              {source_quality.length === 0 ? (
                <EmptyState title="No sourced applications yet" />
              ) : (
                source_quality.map(s => (
                  <div key={s.source_channel}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-xs font-medium text-gray-700 truncate">{s.source_channel}</span>
                      <span className="text-xs font-mono text-gray-400 shrink-0">n={s.n}</span>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 w-24 shrink-0">Pass rate</span>
                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-dp-400 rounded-full transition-all" style={{ width: `${s.pass_rate}%` }} />
                        </div>
                        <span className="text-xs font-mono font-medium text-gray-700 w-10 text-right">{s.pass_rate}%</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 w-24 shrink-0">Hire rate</span>
                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${s.hire_rate}%` }} />
                        </div>
                        <span className="text-xs font-mono font-medium text-gray-700 w-10 text-right">{s.hire_rate}%</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 w-24 shrink-0">Contribution</span>
                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-amber-400 rounded-full transition-all" style={{ width: `${s.contribution_pct}%` }} />
                        </div>
                        <span className="text-xs font-mono font-medium text-gray-700 w-10 text-right">{s.contribution_pct}%</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Low pipeline roles */}
          <div className="card overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-gray-900">Low pipeline roles</h2>
                <InfoTooltip align="left" text="Open roles that are already showing a yellow or red aging alert (past Close Target) AND currently have fewer than 3 Active candidates in their pipeline — a signal that sourcing, not process, may be the actual bottleneck." />
              </div>
              <p className="text-xs text-gray-400 mt-0.5">Open, aging roles with fewer than 3 active candidates</p>
            </div>
            {low_pipeline.length === 0 ? (
              <div className="p-5"><EmptyState title="No low-pipeline roles ✓" /></div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="table-th">Role</th>
                    <th className="table-th">P</th>
                    <th className="table-th">HM</th>
                    <th className="table-th">Active candidates</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {low_pipeline.map(r => (
                    <tr key={r.id}>
                      <td className="table-td font-medium text-gray-900">
                        <Link to={`/roles/${r.id}`} className="hover:text-dp-600">{r.title}</Link>
                      </td>
                      <td className="table-td"><PriorityBadge priority={r.priority as Priority} /></td>
                      <td className="table-td text-gray-500 text-xs">{r.hiring_manager_name}</td>
                      <td className="table-td font-mono text-sm text-gray-700">{r.active_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Operational Velocity — items #10/#29 */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-base font-semibold text-gray-900">Operational velocity</h2>
          <span className="text-xs text-gray-400">— where time and candidates are being lost</span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Turnaround time by stage */}
          <div className="card overflow-hidden lg:col-span-2">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
              <Gauge className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-semibold text-gray-900">Turnaround time by stage</h2>
              <InfoTooltip align="left" text="Average time between entering a stage and leaving it, mined from the stage-change activity log — sorted slowest first, so the top bar is literally where time is being lost the most." />
            </div>
            <div className="px-5 py-4 space-y-2.5">
              {velocity.tat_by_stage.length === 0 ? (
                <EmptyState title="Not enough stage-change history yet" />
              ) : (() => {
                const maxHours = Math.max(...velocity.tat_by_stage.map(t => t.avg_hours), 1);
                return velocity.tat_by_stage.map((t, i) => (
                  <div key={t.stage} className="flex items-center gap-3">
                    <span className="text-xs text-gray-500 w-36 truncate shrink-0">{t.stage}</span>
                    <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${i === 0 ? 'bg-rust-400' : 'bg-dp-400'}`}
                        style={{ width: `${(t.avg_hours / maxHours) * 100}%` }}
                      />
                    </div>
                    <span className="text-xs font-mono font-medium text-gray-700 w-16 text-right">
                      {t.avg_hours < 24 ? `${t.avg_hours}h` : `${Math.round((t.avg_hours / 24) * 10) / 10}d`}
                    </span>
                  </div>
                ));
              })()}
            </div>
          </div>

          {/* Interview→Offer ratio + biggest drop-off */}
          <div className="space-y-6">
            <div className="card p-5">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-4 h-4 text-dp-600" />
                <span className="text-xs font-medium text-gray-500">Interview → Offer ratio</span>
                <InfoTooltip align="left" text="Of everyone who ever reached Interview Round 1 or later (regardless of what happened after — hired, rejected, withdrawn), the % that went on to reach Offer Released or later." />
              </div>
              <div className="text-2xl font-mono font-semibold text-gray-900">
                {velocity.interview_to_offer_ratio != null ? `${velocity.interview_to_offer_ratio}%` : '—'}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                {velocity.offered_count} of {velocity.interviewed_count} interviewed candidates reached offer
              </div>
            </div>
            <div className="card p-5">
              <div className="flex items-center gap-2 mb-2">
                <TrendingDown className="w-4 h-4 text-rust-600" />
                <span className="text-xs font-medium text-gray-500">Biggest drop-off stage</span>
                <InfoTooltip align="left" text="Two different views of the same rejection data: highest count is the stage with the most total rejections (naturally biased toward high-volume early stages); highest rate is the stage that rejects the largest share of everyone who reaches it. Shown together since they can point at different stages." />
              </div>
              {velocity.biggest_drop_off ? (
                <div className="space-y-2">
                  <div>
                    <div className="text-sm font-semibold text-gray-900">{velocity.biggest_drop_off.stage}</div>
                    <div className="text-xs font-mono text-gray-400">{velocity.biggest_drop_off.count} rejected — highest count</div>
                  </div>
                  {velocity.biggest_drop_off_by_rate && velocity.biggest_drop_off_by_rate.stage !== velocity.biggest_drop_off.stage && (
                    <div>
                      <div className="text-sm font-semibold text-gray-900">{velocity.biggest_drop_off_by_rate.stage}</div>
                      <div className="text-xs font-mono text-gray-400">{velocity.biggest_drop_off_by_rate.rate}% rejected — highest rate</div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-sm text-gray-400">No rejections recorded</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
