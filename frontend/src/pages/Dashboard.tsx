import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Briefcase, Users, ListChecks, TrendingUp, Clock } from 'lucide-react';
import { dashboardApi } from '../services/api.ts';
import { DashboardData, PendingAction, Priority, STAGES } from '../types/index.ts';
import { PriorityBadge, AgingBadge, Spinner, EmptyState } from '../components/shared/Badges.tsx';
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

function PendingOwnerColumn({ owner, actions }: { owner: string; actions: PendingAction[] }) {
  const style  = OWNER_STYLES[owner] || 'bg-gray-50 border-gray-200';
  const header = OWNER_HEADER[owner] || 'text-gray-700';
  return (
    <div className={`rounded-xl border ${style} overflow-hidden`}>
      <div className="px-4 py-3 flex items-center justify-between">
        <span className={`text-sm font-semibold ${header}`}>{owner}</span>
        <span className={`text-xl font-bold ${header}`}>{actions.length}</span>
      </div>
      <div className="divide-y divide-white/60">
        {actions.length === 0 ? (
          <div className="px-4 py-3 text-xs text-gray-400">No pending actions ✓</div>
        ) : (
          actions.slice(0, 5).map(a => (
            <div key={a.id} className="px-4 py-3">
              <div className="text-xs font-medium text-gray-800 mb-0.5">{a.action_type}</div>
              {a.candidate_name && (
                <div className="text-xs text-gray-500">{a.candidate_name}</div>
              )}
              <div className="text-xs text-gray-400">{a.role_title}</div>
              {a.hours_overdue > 0 && (
                <span className="inline-flex mt-1 px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                  {Math.floor(a.hours_overdue)}h overdue
                </span>
              )}
            </div>
          ))
        )}
        {actions.length > 5 && (
          <div className="px-4 py-2 text-xs text-gray-400">+{actions.length - 5} more</div>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { data, isLoading, error } = useQuery<{ data: DashboardData }>({
    queryKey: ['dashboard'],
    queryFn:  () => dashboardApi.get(),
    refetchInterval: 5 * 60 * 1000, // refresh every 5 min
  });

  if (isLoading) return (
    <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>
  );
  if (error || !data) return (
    <EmptyState title="Failed to load dashboard" message="Check your connection and try again" />
  );

  const d = data.data;
  const { metrics, pending_actions_by_owner, aging_roles, hiring_funnel } = d;

  const OWNERS = ['HR / Recruiter', 'Hiring Manager', 'Interviewer', 'Leadership / Founders'];

  // Shared canonical order from types/index.ts — this used to be a separately
  // hand-maintained subset that had already drifted out of sync (different
  // stage count than RoleDetail.tsx's own copy) before the stage-list rework.
  // filter(s => funnelMap.has(s)) below already only renders stages with
  // actual data, so using the full list here doesn't clutter empty funnels.
  const FUNNEL_ORDER = STAGES;
  const funnelMap = new Map(hiring_funnel.map(f => [f.stage, parseInt(f.count)]));
  const maxFunnelVal = Math.max(...hiring_funnel.map(f => parseInt(f.count)), 1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-0.5">Hiring health overview — updated live</p>
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
    </div>
  );
}
