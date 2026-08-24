import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, Briefcase, Users, ListChecks, TrendingUp, TrendingDown, Clock, Radio, ListTree, Gauge, X } from 'lucide-react';
import { dashboardApi, rolesApi } from '../services/api.ts';
import { DashboardData, PendingAction, Priority, STAGES, PRIORITIES, ROLE_STATUSES, LOCATIONS, DEPARTMENTS } from '../types/index.ts';
import { PriorityBadge, AgingBadge, Spinner, EmptyState } from '../components/shared/Badges.tsx';
import MultiSelectFilter from '../components/shared/MultiSelectFilter.tsx';
import { usePersistedState } from '../hooks/usePersistedState.ts';

// ─── KPI card ─────────────────────────────────────────────────────────────────
function KpiCard({ icon: Icon, label, value, sub, accent }:
  { icon: React.ElementType; label: string; value: number | string; sub?: string; accent?: string }) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`w-4 h-4 ${accent || 'text-gray-400'}`} />
        <span className="text-xs font-medium text-gray-500">{label}</span>
      </div>
      <div className="text-2xl font-mono font-semibold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

// ─── Owner column ─────────────────────────────────────────────────────────────
const OWNER_STYLES: Record<string, string> = {
  'HR / Recruiter':       'bg-dp-50 border-dp-200',
  'Hiring Manager':       'bg-amber-50 border-amber-200',
  'Interviewer':          'bg-green-50 border-green-200',
  'Leadership / Founders':'bg-purple-50 border-purple-200',
};
const OWNER_HEADER: Record<string, string> = {
  'HR / Recruiter':       'text-dp-700',
  'Hiring Manager':       'text-amber-700',
  'Interviewer':          'text-green-700',
  'Leadership / Founders':'text-purple-700',
};

// Shared row renderer so the truncated column view and the "show all" modal
// render identically — current_stage is only meaningful for HR/Recruiter
// entries (the only owner with an application-level SLA-breach queue where
// "which stage is this candidate stuck in" is the missing piece of context).
// Rows are clickable when there's somewhere to send the user: candidate_id
// takes priority (most actions are candidate-level); role_id is the fallback
// for role-only actions like the Compensation change flag or Role aging
// alert, which have no application/candidate attached at all.
function PendingActionRow({ action: a, owner }: { action: PendingAction; owner: string }) {
  const daysOverdue = a.hours_overdue > 0 ? Math.ceil(a.hours_overdue / 24) : 0;
  const linkTo = a.candidate_id ? `/candidates/${a.candidate_id}` : a.role_id ? `/roles/${a.role_id}` : null;
  // responsible_person is the HM name for Hiring Manager rows and (once ever
  // populated — see slaChecker.ts) the interviewer's email for Interviewer
  // rows; every other owner's actions are a shared team queue, not one
  // person's, so nothing is shown there.
  const showResponsible = (owner === 'Hiring Manager' || owner === 'Interviewer') && a.responsible_person;

  const body = (
    <div className="px-4 py-3">
      <div className="text-xs font-medium text-gray-800 mb-0.5">
        {a.action_type}
        {showResponsible && <span className="font-normal text-gray-400"> - {a.responsible_person}</span>}
      </div>
      {a.candidate_name && (
        <div className="text-xs text-gray-500">{a.candidate_name}</div>
      )}
      <div className="text-xs text-gray-400">{a.role_title}</div>
      {owner === 'HR / Recruiter' && a.current_stage && (
        <div className="text-xs text-gray-400">Stage: {a.current_stage}</div>
      )}
      {a.action_type === 'Compensation change flag' && a.description && (
        <div className="text-xs text-gray-500 mt-0.5">{a.description}</div>
      )}
      {daysOverdue > 0 && (
        <span className="inline-flex mt-1 px-1.5 py-0.5 rounded text-xs font-mono font-medium bg-red-100 text-red-700">
          {daysOverdue}d overdue
        </span>
      )}
    </div>
  );

  if (!linkTo) return body;
  return <Link to={linkTo} className="block hover:bg-white/70 transition-colors">{body}</Link>;
}

function PendingOwnerColumn({ owner, actions }: { owner: string; actions: PendingAction[] }) {
  const style  = OWNER_STYLES[owner] || 'bg-gray-50 border-gray-200';
  const header = OWNER_HEADER[owner] || 'text-gray-700';
  const [showAll, setShowAll] = useState(false);

  return (
    <>
      <div className={`rounded-xl border ${style} overflow-hidden`}>
        <div className="px-4 py-3 flex items-center justify-between">
          <span className={`text-sm font-semibold ${header}`}>{owner}</span>
          <span className={`text-xl font-mono font-bold ${header}`}>{actions.length}</span>
        </div>
        <div className="divide-y divide-white/60">
          {actions.length === 0 ? (
            <div className="px-4 py-3 text-xs text-gray-400">No pending actions ✓</div>
          ) : (
            actions.slice(0, 5).map(a => <PendingActionRow key={a.id} action={a} owner={owner} />)
          )}
        </div>
        {actions.length > 5 && (
          <button
            onClick={() => setShowAll(true)}
            className="w-full px-4 py-2 text-xs text-gray-400 hover:text-gray-700 hover:bg-white/60 transition-colors text-left border-t border-white/60"
          >
            +{actions.length - 5} more
          </button>
        )}
      </div>

      {showAll && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={() => setShowAll(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
              <span className={`text-sm font-semibold ${header}`}>{owner} — {actions.length} pending</span>
              <button onClick={() => setShowAll(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="divide-y divide-gray-100 overflow-y-auto">
              {actions.map(a => <PendingActionRow key={a.id} action={a} owner={owner} />)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function Dashboard() {
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
  });
  const modeOptions = filterOptionsData?.data?.recruitment_modes || [];
  const roleOptions = (filterOptionsData?.data?.roles || []).map(r => ({ value: r.id, label: r.title }));

  const filterParams: Record<string, string[]> = {};
  if (departments.length)      filterParams.department = departments;
  if (locations.length)        filterParams.location = locations;
  if (modes.length)            filterParams.recruitment_mode = modes;
  if (filterPriorities.length) filterParams.priority = filterPriorities;
  if (roleIds.length)          filterParams.role_id = roleIds;

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
  const { metrics, pending_actions_by_owner, aging_roles, hiring_funnel,
          source_quality, time_to_fill, roles_by_status,
          velocity, low_pipeline } = d;

  const OWNERS = ['HR / Recruiter', 'Hiring Manager', 'Interviewer', 'Leadership / Founders'];

  // Shared canonical order from types/index.ts. hiring_funnel now always
  // carries all 13 stages regardless of filters (the backend fills in zero
  // counts), so every stage renders even when a filtered view has nobody
  // currently Active there — it used to silently vanish when the funnel
  // only counted status='Active' candidates.
  const FUNNEL_ORDER = STAGES;
  const funnelMap = new Map(hiring_funnel.map(f => [f.stage, f]));
  const maxFunnelVal = Math.max(...hiring_funnel.map(f => f.active), 1);

  const hasActiveFilters = departments.length + locations.length + modes.length
    + filterPriorities.length + roleIds.length > 0;
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
        <MultiSelectFilter label="Role"              options={roleOptions}       selected={roleIds}           onChange={setRoleIds} />
        {hasActiveFilters && (
          <button onClick={clearAllFilters} className="text-xs text-gray-400 hover:text-gray-600 underline">
            Clear all
          </button>
        )}
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard icon={Briefcase}   label="Open roles"        value={metrics.open_roles_count}
          sub={`${metrics.open_roles_by_priority.P0 + metrics.open_roles_by_priority.P1} high priority`}
          accent="text-dp-600" />
        <KpiCard icon={Users}       label="Active candidates" value={metrics.active_candidates}
          sub={`${metrics.strong_fit_candidates} strong fit (≥70 score)`}
          accent="text-green-600" />
        <KpiCard icon={AlertTriangle} label="SLA breaches"    value={metrics.sla_breaches}
          sub="Needing immediate action"
          accent={metrics.sla_breaches > 0 ? 'text-red-500' : 'text-gray-400'} />
        <KpiCard icon={ListChecks}  label="Pending actions"   value={metrics.total_pending_actions}
          sub={`${metrics.red_aging_roles} roles at Red Alert`}
          accent={metrics.total_pending_actions > 0 ? 'text-amber-500' : 'text-gray-400'} />
      </div>

      {/* Pending actions by owner */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-base font-semibold text-gray-900">Pending actions by owner</h2>
          <span className="text-xs text-gray-400">— bottleneck view</span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {OWNERS.map(owner => (
            <PendingOwnerColumn
              key={owner}
              owner={owner}
              actions={pending_actions_by_owner[owner] || []}
            />
          ))}
        </div>
      </div>

      {/* Aging roles + Hiring funnel */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Aging roles */}
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">Aging roles</h2>
          </div>
          {aging_roles.length === 0 ? (
            <div className="p-5"><EmptyState title="All roles within thresholds ✓" /></div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="table-th">Role</th>
                  <th className="table-th">P</th>
                  <th className="table-th">HM</th>
                  <th className="table-th">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {aging_roles.map(r => (
                  <tr key={r.id} className={r.aging_alert === 'red' ? 'bg-red-50' : 'bg-amber-50'}>
                    <td className="table-td font-medium text-gray-900">
                      <Link to={`/roles/${r.id}`} className="hover:text-dp-600">{r.title}</Link>
                    </td>
                    <td className="table-td"><PriorityBadge priority={r.priority as Priority} /></td>
                    <td className="table-td text-gray-500 text-xs">{r.hiring_manager_name}</td>
                    <td className="table-td">
                      <AgingBadge alert={r.aging_alert} daysOpen={r.days_open} daysOverdue={r.days_overdue} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Hiring funnel */}
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-semibold text-gray-900">Hiring funnel</h2>
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

      {/* Source Quality + Time to Fill + Roles by status (PRD §18 Phase 2) */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-base font-semibold text-gray-900">Source quality &amp; pipeline</h2>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Source Quality */}
          <div className="card overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
              <Radio className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-semibold text-gray-900">Source quality</h2>
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
                        <span className="text-xs text-gray-400 w-16 shrink-0">Pass rate</span>
                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-dp-400 rounded-full transition-all" style={{ width: `${s.pass_rate}%` }} />
                        </div>
                        <span className="text-xs font-mono font-medium text-gray-700 w-10 text-right">{s.pass_rate}%</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 w-16 shrink-0">Hire rate</span>
                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${s.hire_rate}%` }} />
                        </div>
                        <span className="text-xs font-mono font-medium text-gray-700 w-10 text-right">{s.hire_rate}%</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Time to Fill */}
          <div className="card overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
              <Clock className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-semibold text-gray-900">Time to fill</h2>
            </div>
            <div className="px-5 py-4">
              {time_to_fill.overall_days === null ? (
                <EmptyState title="No filled roles yet" message="Populates once an offer is accepted" />
              ) : (
                <>
                  <div className="text-3xl font-mono font-semibold text-gray-900">
                    {time_to_fill.overall_days}<span className="text-base font-sans font-normal text-gray-400 ml-1">days avg</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5 mb-4">Open date → offer accepted</div>
                  <div className="grid grid-cols-4 gap-2">
                    {PRIORITIES.map(p => (
                      <div key={p} className="text-center">
                        <PriorityBadge priority={p} />
                        <div className="text-sm font-mono font-medium text-gray-700 mt-1.5">
                          {time_to_fill.by_priority[p] != null ? `${time_to_fill.by_priority[p]}d` : '—'}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Roles by status */}
          <div className="card overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
              <ListTree className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-semibold text-gray-900">Roles by status</h2>
            </div>
            {Object.keys(roles_by_status).length === 0 ? (
              <div className="p-5"><EmptyState title="No roles yet" /></div>
            ) : (
              <div className="divide-y divide-gray-50">
                {ROLE_STATUSES.filter(s => roles_by_status[s] > 0).map(status => (
                  <div key={status} className="px-5 py-2.5 flex items-center justify-between">
                    <span className="text-xs text-gray-600">{status}</span>
                    <span className="text-sm font-mono font-medium text-gray-900">{roles_by_status[status]}</span>
                  </div>
                ))}
              </div>
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

        {/* Low pipeline roles */}
        {low_pipeline.length > 0 && (
          <div className="card overflow-hidden mt-6">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-900">Low pipeline roles</h2>
              <p className="text-xs text-gray-400 mt-0.5">Open, aging roles with fewer than 3 active candidates</p>
            </div>
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
          </div>
        )}
      </div>
    </div>
  );
}
