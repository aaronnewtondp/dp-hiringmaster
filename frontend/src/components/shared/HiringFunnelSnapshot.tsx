import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { dashboardApi } from '../../services/api.ts';
import { DashboardData, HiringFunnelSnapshotStage } from '../../types/index.ts';
import { EmptyState } from './Badges.tsx';
import { STAGE_COLORS, UNLIT_BG, shade, glossyFill } from './PipelineProgress.tsx';

// ─── Chevron geometry — same interlocking-arrow shape/overlap as the
// candidate-detail PipelineProgress.tsx. Unlike the first version of this
// component, colors are now the SAME 13-hue per-stage palette
// PipelineProgress uses (per user feedback — the flat single navy tone read
// as inert chrome, not data): every segment is lit in its own stage color
// by default; selecting one stage keeps just that segment's hue and greys
// out every other one (UNLIT_BG), so "which stage is selected" is an
// unambiguous, high-contrast state rather than a subtle shade shift. The
// breach-count badge stays the dominant visual element either way.
const OVERLAP_PCT_OF = (n: number) => (100 / n) * 0.11;
const CLIP_FIRST = 'polygon(0% 0%, 80% 0%, 100% 50%, 80% 100%, 0% 100%)';
const CLIP_REST  = 'polygon(0% 0%, 80% 0%, 100% 50%, 80% 100%, 0% 100%, 20% 50%)';

const STAGE_LABELS: Record<string, string> = {
  'Applied': 'Applied', 'Resume Review': 'Resume Review', 'Shortlisted': 'Shortlisted',
  'Interview Round 1': 'Interview 1', 'Interview Round 2': 'Interview 2',
  'Assignment Round': 'Assignment', 'Founders Round': 'Founders',
  'Reference Check': 'Reference Check', 'Pre-Joining Documents': 'Pre-Joining',
  'Offer Discussion': 'Discussion', 'Offer Released': 'Released',
  'Offer Accepted': 'Accepted', 'Joined': 'Joined',
};

const OWNER_OPTIONS = ['HR / Recruiter', 'Hiring Manager'] as const;

function overdueDays(hours: number): number {
  return Math.max(1, Math.ceil(hours / 24));
}

function toggleBtnClass(active: boolean) {
  return `shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
    active ? 'bg-dp-600 text-white border-dp-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
  }`;
}

function railBtnClass(active: boolean) {
  // Deliberately no truncate/line-clamp — a role title wraps to as many
  // lines as it needs (the rail's own max-h-80 overflow-y-auto already
  // bounds the section) so a name is never cut off, per the user's
  // explicit "all names should be clearly visible" ask. line-clamp-2 was
  // tried first but doesn't actually clamp to 2 visible lines in this
  // browser's rendering of legacy -webkit-box (confirmed via computed
  // style/box metrics) — plain wrapping has no such cross-engine risk.
  return `w-full text-left px-3 py-2 rounded-lg text-xs font-medium leading-snug whitespace-normal break-words transition-colors ${
    active ? 'bg-dp-600 text-white' : 'text-gray-600 hover:bg-gray-100'
  }`;
}

export default function HiringFunnelSnapshot({
  masterFilterParams,
  roleOptions,
}: {
  masterFilterParams: Record<string, string[]>;
  roleOptions: { value: string; label: string }[];
}) {
  const [localRoleId, setLocalRoleId] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [openStage, setOpenStage] = useState<string | null>(null);
  const [openType, setOpenType] = useState<string | null>(null);

  const params: Record<string, string | string[]> = { ...masterFilterParams };
  if (localRoleId) params.role_id = [localRoleId];
  if (owner) params.owner = owner;

  const { data, isLoading } = useQuery<{ data: DashboardData }>({
    queryKey: ['dashboard-funnel-snapshot', masterFilterParams, localRoleId, owner],
    queryFn:  () => dashboardApi.get(params),
  });

  const snapshot: HiringFunnelSnapshotStage[] = data?.data?.hiring_funnel_snapshot || [];
  const stageMap = new Map(snapshot.map(s => [s.stage, s]));

  const panelHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (openStage) panelHeadingRef.current?.focus();
  }, [openStage, openType]);

  const toggleStage = (stage: string) => {
    if (openStage === stage) { setOpenStage(null); setOpenType(null); }
    else { setOpenStage(stage); setOpenType(null); }
  };
  const toggleType = (type: string) => setOpenType(prev => (prev === type ? null : type));

  const activeStageData = openStage ? stageMap.get(openStage) : undefined;
  const activeTypeData = activeStageData?.breach_types.find(bt => bt.type === openType);

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900">Hiring Funnel Snapshot</h2>
        <p className="text-xs text-gray-400 mt-0.5">SLA breaches across the pipeline — click a stage to see what's overdue and who owns it</p>
      </div>

      {/* Owner filter — horizontal, top */}
      <div className="px-5 pt-4 flex items-center gap-2 flex-wrap">
        <button className={toggleBtnClass(owner === null)} onClick={() => setOwner(null)}>All owners</button>
        {OWNER_OPTIONS.map(o => (
          <button key={o} className={toggleBtnClass(owner === o)} onClick={() => setOwner(o)}>{o}</button>
        ))}
      </div>

      <div className="px-5 pb-5 pt-4 flex gap-4">
        {/* Role filter — vertical rail, left (collapses to a select below lg).
            Bounded height with its own scroll region — a company with many
            open roles must never let this rail dictate the whole page's
            height. */}
        <div className="hidden lg:flex flex-col gap-1 w-56 shrink-0">
          <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1 px-1">Filter this section by role</div>
          <div className="flex flex-col gap-1 max-h-80 overflow-y-auto pr-1">
            <button className={railBtnClass(localRoleId === null)} onClick={() => setLocalRoleId(null)}>All roles</button>
            {roleOptions.map(r => (
              <button key={r.value} className={railBtnClass(localRoleId === r.value)} onClick={() => setLocalRoleId(r.value)} title={r.label}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <div className="lg:hidden w-full max-w-[10rem] shrink-0">
          <label className="text-[10px] uppercase tracking-wide text-gray-400 mb-1 block">Filter this section by role</label>
          <select
            className="select text-xs"
            value={localRoleId ?? ''}
            onChange={e => setLocalRoleId(e.target.value || null)}
          >
            <option value="">All roles</option>
            {roleOptions.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        <div className="flex-1 min-w-0">
          {isLoading ? (
            <div className="text-xs text-gray-400 py-8 text-center">Loading…</div>
          ) : (
            <>
              <div className="relative">
                <div className="flex w-full overflow-x-auto pb-1">
                  {snapshot.map((s, i) => {
                    const isOpen = openStage === s.stage;
                    const isGreyed = openStage !== null && !isOpen;
                    const stageHue = STAGE_COLORS[s.stage] || UNLIT_BG;
                    const fillHue = isOpen ? shade(stageHue, 20) : isGreyed ? UNLIT_BG : stageHue;
                    return (
                      <button
                        key={s.stage}
                        type="button"
                        title={s.stage}
                        aria-expanded={isOpen}
                        aria-controls={`funnel-panel-${s.stage.replace(/\s+/g, '-')}`}
                        onClick={() => toggleStage(s.stage)}
                        className={`flex flex-col items-center justify-center transition-transform focus:outline-none focus:ring-2 focus:ring-dp-500 focus:ring-offset-2 focus:z-10 ${
                          isOpen ? 'ring-2 ring-white ring-offset-1 z-10' : ''
                        }`}
                        style={{
                          flex: '1 1 0%',
                          minWidth: 84,
                          height: 72,
                          marginLeft: i === 0 ? 0 : `-${OVERLAP_PCT_OF(snapshot.length)}%`,
                          background: glossyFill(fillHue),
                          boxShadow: isOpen
                            ? 'inset 0 1px 1px rgba(255,255,255,0.5), inset 0 -3px 4px rgba(0,0,0,0.22), 0 2px 4px rgba(0,0,0,0.2)'
                            : 'inset 0 1px 1px rgba(255,255,255,0.35), inset 0 -3px 4px rgba(0,0,0,0.15), 0 1px 2px rgba(0,0,0,0.1)',
                          clipPath: i === 0 ? CLIP_FIRST : CLIP_REST,
                          padding: '0 14px',
                        }}
                      >
                        <span
                          className={`font-mono font-bold leading-none text-white ${s.total > 0 ? 'text-lg' : 'text-sm'}`}
                          style={{ textShadow: '0 1px 3px rgba(0,0,0,0.85)' }}
                        >
                          {s.total}
                        </span>
                        <span className="text-white/90 font-semibold uppercase whitespace-nowrap mt-1" style={{ fontSize: '7.5px', letterSpacing: '0.02em' }}>
                          {STAGE_LABELS[s.stage] || s.stage}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="pointer-events-none absolute right-0 top-0 bottom-1 w-6 bg-gradient-to-l from-white to-transparent" />
              </div>

              {openStage && activeStageData && (
                <div
                  id={`funnel-panel-${openStage.replace(/\s+/g, '-')}`}
                  role="region"
                  aria-live="polite"
                  className="mt-4 border border-gray-100 rounded-xl overflow-hidden"
                >
                  <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
                    <h3 ref={panelHeadingRef} tabIndex={-1} className="text-xs font-semibold text-gray-700 outline-none">
                      {openStage}{openType ? <span className="text-gray-400 font-normal"> › {openType}</span> : ''}
                    </h3>
                    <button
                      onClick={() => { setOpenStage(null); setOpenType(null); }}
                      className="text-xs text-gray-400 hover:text-gray-600"
                    >
                      Collapse
                    </button>
                  </div>

                  {activeStageData.breach_types.length === 0 ? (
                    <div className="p-6"><EmptyState title="No breaches — all clear ✓" /></div>
                  ) : (
                    <div className="divide-y divide-gray-50">
                      {activeStageData.breach_types.map(bt => (
                        <div key={bt.type}>
                          <button
                            type="button"
                            aria-expanded={openType === bt.type}
                            aria-controls={`funnel-type-${bt.type.replace(/\s+/g, '-')}`}
                            onClick={() => toggleType(bt.type)}
                            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-dp-500"
                          >
                            <span className="flex items-center gap-2 text-xs">
                              <span className="font-medium text-gray-800">{bt.type}</span>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${bt.owner === 'Hiring Manager' ? 'bg-amber-100 text-amber-700' : 'bg-dp-100 text-dp-700'}`}>
                                {bt.owner}
                              </span>
                            </span>
                            <span className="flex items-center gap-2">
                              <span className="text-xs font-mono font-semibold text-gray-700">{bt.count}</span>
                              <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform ${openType === bt.type ? 'rotate-180' : ''}`} />
                            </span>
                          </button>

                          {openType === bt.type && (
                            <div id={`funnel-type-${bt.type.replace(/\s+/g, '-')}`} className="px-4 pb-3 space-y-2">
                              {bt.candidates.length === 0 ? (
                                <div className="text-xs text-gray-400 py-2">No breaches — all clear ✓</div>
                              ) : (
                                bt.candidates.map(c => {
                                  const cardInner = (
                                    <>
                                      <div className="flex items-center justify-between">
                                        <span className="font-medium text-gray-900">{c.candidate_name}</span>
                                        <span className="font-mono font-semibold text-red-600 shrink-0">Overdue {overdueDays(c.overdue_hours)}D</span>
                                      </div>
                                      <div className="text-gray-400 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                                        <span>SLA Owner: {c.owner}</span>
                                        <span>Role: {c.role_title}</span>
                                        <span>Stage: {c.stage}</span>
                                      </div>
                                    </>
                                  );
                                  const cardClass = 'block rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2.5 text-xs transition-colors';
                                  return c.candidate_id ? (
                                    <Link
                                      key={c.application_id}
                                      to={`/candidates/${c.candidate_id}`}
                                      className={`${cardClass} hover:border-dp-300 hover:bg-white`}
                                    >
                                      {cardInner}
                                    </Link>
                                  ) : (
                                    <div key={c.application_id} className={cardClass}>{cardInner}</div>
                                  );
                                })
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
