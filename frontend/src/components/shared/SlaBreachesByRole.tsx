import { useEffect, useId, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BarChart3, ChevronDown, Table2 } from 'lucide-react';
import { dashboardApi } from '../../services/api.ts';
import { SlaByRole, SlaRoleBar } from '../../types/index.ts';
import { EmptyState } from './Badges.tsx';
import InfoTooltip from './InfoTooltip.tsx';
import { bucketCounts, SLA_STAGE_BUCKETS, OTHER_BUCKET, SlaStageBucket } from '../../utils/slaStageBuckets.ts';

// How many roles the chart shows before "Show all" (the rest are still in the table view).
const TOP_N = 8;

const nf = new Intl.NumberFormat('en-IN');

interface Tip { x: number; y: number; role: SlaRoleBar; bucket: SlaStageBucket; count: number; stages: Array<{ stage: string; count: number }> }

function toggleBtnClass(active: boolean) {
  return `inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
    active ? 'bg-dp-600 text-white border-dp-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
  }`;
}

// The readout sits just below the pointer; near the bottom of the window it flips above, so a tall one (a
// bucket that spans several stages) is never cut off.
function tipTop(t: Tip) {
  const est = 70 + (t.stages.length > 1 ? 10 + t.stages.length * 17 : 0);
  return t.y + 14 + est > window.innerHeight ? Math.max(8, t.y - est - 8) : t.y + 14;
}

// "0%" for a real, non-zero count reads as a bug; anything under half a percent says so instead.
function pctLabel(count: number, total: number) {
  const p = (count / total) * 100;
  return count > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
}

function OwnerChip({ owner }: { owner: string }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${owner === 'Hiring Manager' ? 'bg-amber-100 text-amber-700' : 'bg-dp-100 text-dp-700'}`}>
      {owner}
    </span>
  );
}

// Stacked horizontal bars: one bar per OPEN role, longest first; each bar is split by how far
// along the funnel the overdue candidates are (one blue that darkens down the funnel — see
// utils/slaStageBuckets.ts for why five steps and not eleven stage colours). Click a role for the
// second level: every individual stage, and what is overdue there and who owns it.
//
// Built from the same breach rows as the Hiring Funnel Snapshot above it (same dashboard
// filters), so the two always agree; the tooltip is an enhancement only — every number in it is
// also in the drill-down and the table view.
export default function SlaBreachesByRole({ masterFilterParams }: { masterFilterParams: Record<string, string[]> }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const panelIdBase = useId();

  const { data, isLoading, isError, isFetching } = useQuery<{ data: SlaByRole }>({
    queryKey: ['dashboard-sla-by-role', masterFilterParams],
    queryFn:  () => dashboardApi.slaByRole(masterFilterParams),
    placeholderData: keepPreviousData,       // refetch keeps the frame: hold the last chart, dimmed, instead of flashing
    refetchInterval: 5 * 60 * 1000,          // same cadence as the KPI cards, so a tab left open doesn't drift from them
  });

  const result = data?.data;
  const roles = result?.roles ?? [];
  const visible = showAll ? roles : roles.slice(0, TOP_N);
  const max = Math.max(...visible.map(r => r.total), 1);

  // Buckets that actually occur (across ALL roles, so the legend doesn't change when toggling "Show all").
  const present = new Set<string>();
  const perRole = new Map<string, ReturnType<typeof bucketCounts>>();
  for (const r of roles) {
    const bc = bucketCounts(r.by_stage);
    perRole.set(r.role_id, bc);
    for (const b of bc) present.add(b.bucket.key);
  }
  const legend = [...SLA_STAGE_BUCKETS, OTHER_BUCKET].filter(b => present.has(b.key));
  // A spotlighted step that a filter/refetch has since emptied is no longer in the legend, so there'd be no button
  // left to un-spotlight it — and every segment would sit dimmed. Treat it as off.
  const hl = highlight && present.has(highlight) ? highlight : null;

  // A readout must never outlive its mark: browsers don't send pointerleave when the page scrolls under a
  // still mouse or when the hovered bar is removed (view switch, "Show all", a refetch), and touch has no hover
  // at all — so clear it on scroll / blur / any state change that re-renders the bars.
  useEffect(() => {
    if (!tip) return;
    const clear = () => setTip(null);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('blur', clear);
    return () => { window.removeEventListener('scroll', clear, true); window.removeEventListener('blur', clear); };
  }, [tip]);
  useEffect(() => { setTip(null); }, [view, showAll, expanded, hl, data]);

  const showTip = (e: React.PointerEvent, role: SlaRoleBar, seg: ReturnType<typeof bucketCounts>[number]) => {
    if (e.pointerType === 'touch') return;      // tap opens the drill-down, which carries the same numbers
    setTip({ x: e.clientX, y: e.clientY, role, bucket: seg.bucket, count: seg.count, stages: seg.stages });
  };

  return (
    <div className="card">
      <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-900">SLA breaches by role</h2>
            <InfoTooltip align="left" text="Open SLA breaches on each open role (Approved, Live – Sourcing, Under Review, On Hold), longest bar first. Each bar is split by how far along the funnel the overdue candidates are — lighter = earlier, darker = later. Click a bar to see every stage and what is overdue there. Uses the same dashboard filters as the Hiring Funnel Snapshot above, but always counts both HR and Hiring Manager breaches (the owner buttons don't apply)." />
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            {result && roles.length > 0
              ? <>{nf.format(result.total_breaches)} open breach{result.total_breaches === 1 ? '' : 'es'} across {roles.length} open role{roles.length === 1 ? '' : 's'}{view === 'chart' ? ' — click a bar for the stage-by-stage split' : ''}</>
              : 'Overdue candidates per open role, split by funnel stage'}
          </p>
        </div>
        <div className="flex items-center gap-1.5" role="group" aria-label="Chart view">
          <button type="button" aria-pressed={view === 'chart'} className={toggleBtnClass(view === 'chart')} onClick={() => setView('chart')}>
            <BarChart3 className="w-3.5 h-3.5" /> Chart
          </button>
          <button type="button" aria-pressed={view === 'table'} className={toggleBtnClass(view === 'table')} onClick={() => setView('table')}>
            <Table2 className="w-3.5 h-3.5" /> Table
          </button>
        </div>
      </div>

      <div className={`px-5 py-4 transition-opacity ${isFetching && result ? 'opacity-60' : ''}`}>
        {isLoading && !result ? (
          <div className="text-xs text-gray-400 py-8 text-center">Loading…</div>
        ) : isError && !result ? (
          <div className="text-xs text-red-500 py-8 text-center">Couldn't load the SLA breaches by role.</div>
        ) : roles.length === 0 ? (
          <EmptyState title="No SLA breaches on open roles ✓" />
        ) : view === 'table' ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <caption className="sr-only">Open SLA breaches per open role, by funnel step</caption>
              <thead>
                <tr className="border-b border-gray-100 text-left text-gray-500">
                  <th scope="col" className="py-2 pr-3 font-medium">Role</th>
                  {legend.map(b => <th key={b.key} scope="col" className="py-2 px-2 font-medium text-right whitespace-nowrap">{b.label}</th>)}
                  <th scope="col" className="py-2 pl-2 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {roles.map(r => {
                  const bc = new Map((perRole.get(r.role_id) ?? []).map(b => [b.bucket.key, b.count]));
                  return (
                    <tr key={r.role_id}>
                      <th scope="row" className="py-1.5 pr-3 font-normal text-gray-800 text-left">
                        <Link to={`/roles/${r.role_id}`} className="hover:text-dp-600">{r.role_title}</Link>
                      </th>
                      {legend.map(b => <td key={b.key} className="py-1.5 px-2 text-right font-mono text-gray-700">{bc.get(b.key) ? nf.format(bc.get(b.key)!) : <span className="text-gray-300">—</span>}</td>)}
                      <td className="py-1.5 pl-2 text-right font-mono font-semibold text-gray-900">{nf.format(r.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            {/* Legend — identity never rests on colour alone; click a step to spotlight it across every bar */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-4" role="group" aria-label="Funnel steps">
              {legend.map(b => (
                <button
                  key={b.key} type="button" aria-pressed={hl === b.key}
                  onClick={() => setHighlight(h => (h === b.key ? null : b.key))}
                  className={`inline-flex items-center gap-1.5 text-xs rounded px-1 py-0.5 transition-opacity ${hl && hl !== b.key ? 'opacity-50' : ''} hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-dp-600`}
                >
                  <span className="inline-block w-3 h-3 rounded-[3px]" style={{ background: b.color }} aria-hidden="true" />
                  <span className="text-gray-600">{b.label}</span>
                </button>
              ))}
            </div>

            <ul className="space-y-1">
              {visible.map(r => {
                const open = expanded === r.role_id;
                const segs = perRole.get(r.role_id) ?? [];
                const panelId = `${panelIdBase}-${r.role_id}`;
                const summary = segs.map(s => `${s.count} at ${s.bucket.label}`).join(', ');
                return (
                  <li key={r.role_id}>
                    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] sm:grid-cols-[13rem_minmax(0,1fr)] items-center gap-x-3">
                      <Link to={`/roles/${r.role_id}`} title={r.role_title} className="truncate text-xs text-gray-800 hover:text-dp-600">
                        {r.role_title}
                      </Link>
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-controls={panelId}
                        aria-label={`${r.role_title}: ${r.total} open SLA breaches (${summary}). ${open ? 'Hide' : 'Show'} stage breakdown`}
                        onClick={() => setExpanded(open ? null : r.role_id)}
                        className="flex items-center gap-2 py-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-dp-600"
                      >
                        <span className="flex-1 min-w-0 h-5 flex">
                          <span className="flex h-full gap-[2px]" style={{ width: `${(r.total / max) * 100}%` }}>
                            {segs.map((s, i) => (
                              <span
                                key={s.bucket.key}
                                onPointerEnter={e => showTip(e, r, s)}
                                onPointerMove={e => showTip(e, r, s)}
                                onPointerLeave={() => setTip(null)}
                                className={`h-full transition-opacity ${i === segs.length - 1 ? 'rounded-r-[4px]' : ''}`}
                                style={{
                                  flexGrow: s.count, flexBasis: 0, minWidth: 3, background: s.bucket.color,
                                  opacity: hl && hl !== s.bucket.key ? 0.2 : 1,
                                }}
                              />
                            ))}
                          </span>
                        </span>
                        <span className="font-mono text-xs font-semibold text-gray-900 w-10 text-right shrink-0">{nf.format(r.total)}</span>
                        <ChevronDown className={`w-3.5 h-3.5 text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
                      </button>
                    </div>

                    {open && (
                      <div id={panelId} role="region" aria-label={`${r.role_title} — breaches by stage`} className="mt-1 mb-3 sm:ml-[13.75rem] rounded-lg border border-gray-100 bg-gray-50/60 overflow-hidden">
                        <div className="px-3 py-2 flex items-center justify-between gap-3 border-b border-gray-100 text-xs text-gray-500">
                          <span>
                            <span className="font-semibold text-gray-800">{nf.format(r.total)}</span> open breach{r.total === 1 ? '' : 'es'}
                            {r.hiring_manager_name ? <> · Hiring Manager: {r.hiring_manager_name}</> : null}
                          </span>
                          <Link to={`/roles/${r.role_id}`} className="text-dp-600 hover:underline whitespace-nowrap">Open role →</Link>
                        </div>
                        <ul className="divide-y divide-gray-100">
                          {r.by_stage.map(s => {
                            const b = (perRole.get(r.role_id) ?? []).find(x => x.stages.some(st => st.stage === s.stage))?.bucket ?? OTHER_BUCKET;
                            return (
                              <li key={s.stage} className="px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <span className="inline-block w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ background: b.color }} aria-hidden="true" />
                                  <span className="text-xs font-medium text-gray-800 flex-1">{s.stage}</span>
                                  <span className="font-mono text-xs font-semibold text-gray-900">{nf.format(s.count)}</span>
                                </div>
                                <ul className="ml-[18px] mt-1 space-y-0.5">
                                  {s.breach_types.map(t => (
                                    <li key={t.type} className="flex items-center gap-2 text-[11px] text-gray-500">
                                      <span>{t.type}</span>
                                      <OwnerChip owner={t.owner} />
                                      <span className="ml-auto font-mono text-gray-700">{nf.format(t.count)}</span>
                                    </li>
                                  ))}
                                </ul>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {roles.length > TOP_N && (
              <button type="button" onClick={() => setShowAll(v => !v)} className="mt-3 text-xs text-dp-600 hover:underline">
                {showAll ? `Show top ${TOP_N} only` : `Show all ${roles.length} roles`}
              </button>
            )}
          </>
        )}

        {result && result.not_open_roles.breaches > 0 && (
          <p className="mt-4 text-[11px] text-gray-400">
            Not shown: {nf.format(result.not_open_roles.breaches)} breach{result.not_open_roles.breaches === 1 ? '' : 'es'} on {result.not_open_roles.roles} role{result.not_open_roles.roles === 1 ? '' : 's'} that {result.not_open_roles.roles === 1 ? 'is' : 'are'} not open (closed, cancelled or still a draft) with candidates still marked Active. The Hiring Funnel Snapshot above still includes {result.not_open_roles.breaches === 1 ? 'it' : 'them'}.
          </p>
        )}
      </div>

      {/* Hover readout — value leads, label follows; a line key (not a box) identifies the step. Never the only route to a number. */}
      {tip && view === 'chart' && (
        <div
          role="tooltip"
          className="fixed z-50 pointer-events-none rounded-lg border border-gray-200 bg-white shadow-lg px-3 py-2 text-xs max-w-[15rem]"
          style={{ left: Math.min(tip.x + 14, window.innerWidth - 250), top: tipTop(tip) }}
        >
          <div className="text-[11px] text-gray-500 truncate">{tip.role.role_title}</div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="inline-block w-3 h-[3px] rounded" style={{ background: tip.bucket.color }} aria-hidden="true" />
            <span className="font-mono text-sm font-semibold text-gray-900">{nf.format(tip.count)}</span>
            <span className="text-gray-600">at {tip.bucket.label}</span>
          </div>
          <div className="text-[11px] text-gray-400 mt-0.5">{pctLabel(tip.count, tip.role.total)} of this role's {nf.format(tip.role.total)}</div>
          {tip.stages.length > 1 && (
            <ul className="mt-1 pt-1 border-t border-gray-100 space-y-0.5">
              {tip.stages.map(s => (
                <li key={s.stage} className="flex justify-between gap-3 text-[11px] text-gray-500"><span>{s.stage}</span><span className="font-mono text-gray-700">{nf.format(s.count)}</span></li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
