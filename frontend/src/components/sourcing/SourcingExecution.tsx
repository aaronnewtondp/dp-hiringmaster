import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { sourcingApi } from '../../services/api.ts';
import { SourcingDashboard } from '../../types/sourcing.ts';
import { EmptyState, PriorityBadge } from '../shared/Badges.tsx';
import KpiCard from '../shared/KpiCard.tsx';
import InfoTooltip from '../shared/InfoTooltip.tsx';
import { exceptionLabel, topN } from '../../utils/sourcingFormat.ts';

const TOP = 10;

/**
 * Dashboard → Sourcing execution (the last section, below every existing module). One summary tile and then the exceptions
 * ARE the section: for each, what was committed, what actually happened and what to do next — not a vanity chart of effort.
 * Lazy: its own endpoint, the same master filters and Hiring Manager lock as the sections above, nothing at all while the
 * module is switched off. Provisional signals (new detectors still being calibrated) show for HR/Leadership only, greyed.
 */
export default function SourcingExecution({ masterFilterParams }: { masterFilterParams: Record<string, string[]> }) {
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading, isError, isFetching } = useQuery<{ data: SourcingDashboard | { enabled: false } }>({
    queryKey: ['dashboard-sourcing', masterFilterParams],
    queryFn:  () => sourcingApi.dashboard(masterFilterParams),
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60 * 1000,
    retry: false,
  });

  const payload = data?.data;
  if (payload && payload.enabled === false) return null;                         // module off: the page is exactly what it was
  const d = payload && payload.enabled ? payload : undefined;

  const heading = (
    <div className="flex items-center gap-2 mb-3">
      <h2 className="text-base font-semibold text-gray-900">Sourcing execution</h2>
      <span className="text-xs text-gray-400">— are sourcing commitments being kept, and where are they slipping</span>
    </div>
  );

  if (isLoading && !d) return <div>{heading}<div className="card p-8 text-center text-sm text-gray-400">Loading…</div></div>;
  if (isError && !d) return <div>{heading}<div role="alert" className="card p-6 text-sm text-gray-500">Couldn't load sourcing execution.</div></div>;
  if (!d) return null;

  const s = d.summary;
  const rows = d.exceptions;
  const { shown, more } = topN(rows, showAll ? Infinity : TOP);
  const live = rows.filter(r => !r.provisional);

  return (
    <div className={isFetching ? 'opacity-70 transition-opacity' : ''} aria-busy={isFetching}>
      {heading}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <KpiCard
          icon={Compass} label="Sourcing" accent={live.length > 0 ? 'text-red-500' : 'text-dp-600'}
          value={live.filter(r => r.status === 'open').length}
          info={<>The big number is open exceptions on live plans: a sourcing task that was due and not done, a plan not activated in time, or too few qualified candidates. Blocked, catching-up and provisional items are not counted. Plans active = active plans ÷ open roles (Approved and Live – Sourcing). Done on time = share of tasks finished in the last 14 days by their due date. Overdue now = open tasks past their due day on active plans. Everything follows the filters above.</>}
          sub={[
            ['Plans active', `${s.plans_active} / ${s.open_roles}`],
            ['Done on time (14d)', s.on_time_pct_14d === null ? '—' : `${s.on_time_pct_14d}%`],
            ['Overdue now', s.overdue_commitments],
            [d.read_only ? 'Blocked' : 'Provisional signals', d.read_only ? s.exceptions_blocked : s.provisional_signals],
          ]}
        />
        <div className="lg:col-span-2 card p-5 flex flex-col justify-center text-sm text-gray-600" data-testid="sourcing-summary-note">
          {s.plans_draft > 0 && !d.read_only && <p>{s.plans_draft} open {s.plans_draft === 1 ? 'role has' : 'roles have'} a plan waiting to be activated.</p>}
          {Object.keys(s.by_priority).length > 0 && (
            <p>Open and blocked exceptions by priority: {Object.entries(s.by_priority).sort(([a], [b]) => a.localeCompare(b)).map(([p, n]) => `${p} ${n}`).join(' · ')}.</p>
          )}
          {!d.read_only && d.provisional_until && s.provisional_signals > 0 && (
            <p className="text-gray-400">Provisional signals (greyed) are new and still being calibrated — they do not raise tasks or alerts until {d.provisional_until}.</p>
          )}
          {s.plans_draft === 0 && Object.keys(s.by_priority).length === 0 && <p>Every active plan is on track.</p>}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="card p-8"><EmptyState title="No sourcing exceptions ✓" message="Every commitment that has come due has been kept." /></div>
      ) : (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-gray-100 flex items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900">Exceptions</h3>
            <InfoTooltip align="left" text="One line per problem, most serious first (live before provisional, then by priority and how overdue). A role can appear more than once, for example an overdue LinkedIn task and a volume gap. 'Provisional' rows are new signals still being calibrated (HR/Admin and Leadership only). Age = days since HMS first flagged it." width="w-80" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="table-th">Role</th>
                  <th className="table-th">Committed</th>
                  <th className="table-th">What happened</th>
                  <th className="table-th">Next</th>
                  <th className="table-th text-right"><span className="inline-flex items-center gap-1">Age<InfoTooltip align="right" text="Days since HMS first flagged this — not how overdue the task is (see 'What happened')." /></span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {shown.map(r => (
                  <tr key={r.id} className={r.provisional ? 'text-gray-400' : ''}>
                    <td className="table-td">
                      <div className="flex items-center gap-2">
                        <PriorityBadge priority={r.priority} />
                        <Link to={`/sourcing?sourcing_role=${r.role_id}`} className="font-medium text-gray-900 hover:text-dp-600">{r.role_title}</Link>
                      </div>
                      <div className="text-[11px] text-gray-400 mt-0.5 flex flex-wrap gap-x-2">
                        <span>{exceptionLabel(r.type)}</span>
                        {r.provisional && <span className="font-medium text-gray-500">Provisional</span>}
                        {r.status === 'blocked' && <span className="font-medium text-amber-700">Blocked{r.blocker_due ? ` until ${r.blocker_due}` : ''}</span>}
                      </div>
                    </td>
                    <td className="table-td text-xs">{r.committed}</td>
                    <td className="table-td text-xs">{r.happened}</td>
                    <td className="table-td text-xs">{r.next_action}</td>
                    <td className="table-td text-xs text-right font-mono whitespace-nowrap">{r.age_days}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(more > 0 || showAll) && rows.length > TOP && (
            <div className="px-5 py-2.5 border-t border-gray-50">
              <button type="button" onClick={() => setShowAll(v => !v)} className="text-xs text-dp-600 hover:underline">
                {showAll ? 'Show fewer' : `Show all ${rows.length}`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
