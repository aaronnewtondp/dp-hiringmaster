import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Briefcase, Users, ListChecks, TrendingUp, Clock, Radio, Building2, X } from 'lucide-react';
import { dashboardApi, rolesApi } from '../services/api.ts';
import { DashboardData, PendingAction, Priority, STAGES, PRIORITIES, ROLE_STATUSES, LOCATIONS } from '../types/index.ts';
import { PriorityBadge, AgingBadge, Spinner, EmptyState } from '../components/shared/Badges.tsx';
import MultiSelectFilter from '../components/shared/MultiSelectFilter.tsx';
import { formatDistanceToNow } from 'date-fns';

// ─── KPI card ─────────────────────────────────────────────────────────────────
function KpiCard({ icon: Icon, label, value, sub, accent }:
  { icon: React.ElementType; label: string; value: number | string; sub?: string; accent?: string }) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`w-4 h-4 ${accent || 'text-gray-400'}`} />
        <span className="text-xs font-medium text-gray-500">{label}</span>
      </div>
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
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
function PendingActionRow({ action: a, owner }: { action: PendingAction; owner: string }) {
  return (
    <div className="px-4 py-3">
      <div className="text-xs font-medium text-gray-800 mb-0.5">{a.action_type}</div>
      {a.candidate_name && (
        <div className="text-xs text-gray-500">{a.candidate_name}</div>
      )}
      <div className="text-xs text-gray-400">{a.role_title}</div>
      {owner === 'HR / Recruiter' && a.current_stage && (
        <div className="text-xs text-gray-400">Stage: {a.current_stage}</div>
      )}
      {a.hours_overdue > 0 && (
        <span className="inline-flex mt-1 px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
          {Math.floor(a.hours_overdue)}h overdue
        </span>
      )}
    </div>
  );
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
          <span className={`text-xl font-bold ${header}`}>{actions.length}</span>
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
  const [departments, setDepartments] = useState<string[]>([]);
  const [locations,   setLocations]   = useState<string[]>([]);
  const [modes,        setModes]      = useState<string[]>([]);
  const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
  const [statuses,     setStatuses]   = useState<string[]>([]);

  const { data: filterOptionsData } = useQuery<{ data: { departments: string[]; recruitment_modes: string[] } }>({
    queryKey: ['roles', 'filter-options'],
    queryFn:  () => rolesApi.filterOptions(),
  });
  const departmentOptions = filterOptionsData?.data?.departments || [];
  const modeOptions       = filterOptionsData?.data?.recruitment_modes || [];

  const filterParams: Record<string, string[]> = {};
  if (departments.length)      filterParams.department = departments;
  if (locations.length)        filterParams.location = locations;
  if (modes.length)            filterParams.recruitment_mode = modes;
  if (filterPriorities.length) filterParams.priority = filterPriorities;
  if (statuses.length)         filterParams.status = statuses;

  const { data, isLoading, error } = useQuery<{ data: DashboardData }>({
    queryKey: ['dashboard', departments, locations, modes, filterPriorities, statuses],
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
          source_quality, time_to_fill, agency_performance } = d;

  const OWNERS = ['HR / Recruiter', 'Hiring Manager', 'Interviewer', 'Leadership / Founders'];

  // Shared canonical order from types/index.ts — this used to be a separately
  // hand-maintained subset that had already drifted out of sync (different
  // stage count than RoleDetail.tsx's own copy) before the stage-list rework.
  // filter(s => funnelMap.has(s)) below already only renders stages with
  // actual data, so using the full list here doesn't clutter empty funnels.
  const FUNNEL_ORDER = STAGES;
  const funnelMap = new Map(hiring_funnel.map(f => [f.stage, parseInt(f.count)]));
  const maxFunnelVal = Math.max(...hiring_funnel.map(f => parseInt(f.count)), 1);

  const hasActiveFilters = departments.length + locations.length + modes.length
    + filterPriorities.length + statuses.length > 0;
  const clearAllFilters = () => {
    setDepartments([]); setLocations([]); setModes([]); setFilterPriorities([]); setStatuses([]);
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
        <MultiSelectFilter label="Department"       options={departmentOptions} selected={departments}      onChange={setDepartments} />
        <MultiSelectFilter label="Location"         options={LOCATIONS}         selected={locations}        onChange={setLocations} />
        <MultiSelectFilter label="Recruitment Mode" options={modeOptions}       selected={modes}             onChange={setModes} />
        <MultiSelectFilter label="Priority"         options={PRIORITIES}        selected={filterPriorities} onChange={setFilterPriorities} />
        <MultiSelectFilter label="Status"           options={ROLE_STATUSES}     selected={statuses}          onChange={setStatuses} />
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
          sub={`${metrics.strong_fit_candidates} strong fit (≥75)`}
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
                    <td className="table-td font-medium text-gray-900 max-w-[140px] truncate">{r.title}</td>
                    <td className="table-td"><PriorityBadge priority={r.priority as Priority} /></td>
                    <td className="table-td text-gray-500 text-xs">{r.hiring_manager_name}</td>
                    <td className="table-td">
                      <AgingBadge alert={r.aging_alert} days={r.days_open} />
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
            {FUNNEL_ORDER.filter(s => funnelMap.has(s)).map(stage => {
              const count = funnelMap.get(stage) || 0;
              const pct   = Math.round((count / maxFunnelVal) * 100);
              return (
                <div key={stage} className="flex items-center gap-3">
                  <span className="text-xs text-gray-500 w-36 truncate shrink-0">{stage}</span>
                  <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-dp-400 rounded-full transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-xs font-medium text-gray-700 w-6 text-right">{count}</span>
                </div>
              );
            })}
            {hiring_funnel.length === 0 && (
              <EmptyState title="No active candidates" />
            )}
          </div>
        </div>
      </div>

      {/* Source Quality + Time to Fill + Agency Performance (PRD §18 Phase 2) */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-base font-semibold text-gray-900">Source &amp; agency quality</h2>
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
                      <span className="text-xs text-gray-400 shrink-0">n={s.n}</span>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 w-16 shrink-0">Pass rate</span>
                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-dp-400 rounded-full transition-all" style={{ width: `${s.pass_rate}%` }} />
                        </div>
                        <span className="text-xs font-medium text-gray-700 w-10 text-right">{s.pass_rate}%</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 w-16 shrink-0">Hire rate</span>
                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${s.hire_rate}%` }} />
                        </div>
                        <span className="text-xs font-medium text-gray-700 w-10 text-right">{s.hire_rate}%</span>
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
                  <div className="text-3xl font-semibold text-gray-900">
                    {time_to_fill.overall_days}<span className="text-base font-normal text-gray-400 ml-1">days avg</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5 mb-4">Open date → offer accepted</div>
                  <div className="grid grid-cols-4 gap-2">
                    {PRIORITIES.map(p => (
                      <div key={p} className="text-center">
                        <PriorityBadge priority={p} />
                        <div className="text-sm font-medium text-gray-700 mt-1.5">
                          {time_to_fill.by_priority[p] != null ? `${time_to_fill.by_priority[p]}d` : '—'}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Agency Performance */}
          <div className="card overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
              <Building2 className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-semibold text-gray-900">Agency performance</h2>
            </div>
            {agency_performance.length === 0 ? (
              <div className="p-5"><EmptyState title="No agency-sourced applications yet" /></div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="table-th">Agency</th>
                    <th className="table-th">Subs</th>
                    <th className="table-th">Hire rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {agency_performance.map(a => (
                    <tr key={a.agency_id}>
                      <td className="table-td font-medium text-gray-900 max-w-[120px] truncate">{a.agency_name}</td>
                      <td className="table-td text-gray-500">{a.n}</td>
                      <td className="table-td text-gray-700">{a.hire_rate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
