import { Fragment, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, CheckCircle, PauseCircle, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { applicationsApi, rolesApi } from '../services/api.ts';
import { Application, PRIORITIES, APPLICATION_STATUSES, LOCATIONS, DEPARTMENTS } from '../types/index.ts';
import { Spinner, EmptyState, OverBudgetBadge } from '../components/shared/Badges.tsx';
import MultiSelectFilter from '../components/shared/MultiSelectFilter.tsx';
import StageChangeModal from '../components/shared/StageChangeModal.tsx';
import RejectReasonModal from '../components/shared/RejectReasonModal.tsx';
import { isOverBudget, isWithinBudgetOrNear } from '../utils/budget.ts';
import { useAuth } from '../contexts/AuthContext.tsx';

// Same chunked-batching constant as Candidates.tsx / HMQueue.tsx's bulk actions.
const BULK_CONCURRENCY = 3;

// Compact 0-10 dimension cell — mirrors ResumeIQPanel.tsx's private
// scoreColor() thresholds (copied, not imported: four lines, not worth a
// cross-component dependency for).
function ScoreCell({ score }: { score?: number }) {
  const color =
    score == null ? 'text-gray-300' :
    score >= 8    ? 'text-green-600 font-semibold' :
    score >= 6    ? 'text-dp-600 font-medium' :
    score >= 4    ? 'text-amber-600' :
    'text-red-500';
  return <span className={`text-xs ${color}`}>{score != null ? score : '—'}</span>;
}

// Mirrors ResumeIQPanel.tsx's private recColor mapping (copied, same reasoning).
function VerdictBadge({ recommendation }: { recommendation?: string }) {
  if (!recommendation) return <span className="text-xs text-gray-300">—</span>;
  const color =
    recommendation === 'Strong Yes' ? 'bg-green-100 text-green-800' :
    recommendation === 'Yes'        ? 'bg-dp-100 text-dp-800' :
    recommendation === 'Maybe'      ? 'bg-amber-100 text-amber-800' :
    'bg-red-100 text-red-800';
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${color}`}>{recommendation}</span>;
}

const DIMENSIONS: Array<{ key: keyof Application; label: string }> = [
  { key: 'score_technical',      label: 'Tech' },
  { key: 'score_experience',     label: 'Exp' },
  { key: 'score_industry_fit',   label: 'Ind' },
  { key: 'score_culture_fit',    label: 'Cult' },
  { key: 'score_role_alignment', label: 'Role' },
  { key: 'score_trajectory',     label: 'Traj' },
  { key: 'score_leadership',     label: 'Lead' },
  { key: 'score_communication',  label: 'Comm' },
];

export default function ScorecardSummary() {
  const qc = useQueryClient();
  const { canLead } = useAuth();
  const [searchParams] = useSearchParams();
  // Arriving from a role's detail page ("Scorecard Summary" button there)
  // pre-filters to that role — read once on mount; the Role MultiSelectFilter
  // below is the single source of truth after that (clearing it un-filters,
  // same as picking it manually would).
  const [roleIds,     setRoleIds]     = useState<string[]>(() => {
    const roleId = searchParams.get('role_id');
    return roleId ? [roleId] : [];
  });
  const [departments, setDepartments] = useState<string[]>([]);
  const [locations,   setLocations]   = useState<string[]>([]);
  const [modes,       setModes]       = useState<string[]>([]);
  const [priorities,  setPriorities]  = useState<string[]>([]);
  const [statuses,    setStatuses]    = useState<string[]>([]);
  const [filterInBudget, setFilterInBudget] = useState(false);
  const [expanded,    setExpanded]    = useState<Set<string>>(new Set());
  const [stageModalApp, setStageModalApp] = useState<Application | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [rejectTargetIds, setRejectTargetIds] = useState<string[] | null>(null);
  const [bulkSaving, setBulkSaving] = useState(false);

  const params: Record<string, string | string[]> = { limit: '100', scored_only: 'true' };
  if (roleIds.length)     params.role_id = roleIds;
  if (departments.length) params.department = departments;
  if (locations.length)   params.location = locations;
  if (modes.length)       params.recruitment_mode = modes;
  if (priorities.length)  params.priority = priorities;
  // Default to Active only — otherwise a Rejected/Hold-for-Future candidate
  // (who has already left this queue's whole reason for existing) would
  // linger here forever. The Status filter still lets anyone deliberately
  // pick Rejected/Hold for Future/etc. to audit them; this only changes
  // what shows up with no filter touched.
  params.status = statuses.length ? statuses : ['Active'];

  const { data, isLoading } = useQuery<{ data: { applications: Application[] } }>({
    queryKey: ['applications', 'scorecard', roleIds, departments, locations, modes, priorities, statuses],
    queryFn:  () => applicationsApi.list(params),
  });
  const allApps = data?.data?.applications || [];
  // Client-side, same reasoning as Candidates.tsx's identical toggle —
  // role_ctc_band is freeform text, best parsed in JS.
  const apps = filterInBudget
    ? allApps.filter(a => isWithinBudgetOrNear(a.candidate_expected_ctc, a.role_ctc_band))
    : allApps;

  const { data: filterOptionsData } = useQuery<{ data: { recruitment_modes: string[]; roles: { id: string; title: string }[] } }>({
    queryKey: ['roles', 'filter-options'],
    queryFn:  () => rolesApi.filterOptions(),
  });
  const modeOptions = filterOptionsData?.data?.recruitment_modes || [];
  const roleOptions = (filterOptionsData?.data?.roles || []).map(r => ({ value: r.id, label: r.title }));

  const hasActiveFilters = roleIds.length || departments.length || locations.length || modes.length || priorities.length || statuses.length || filterInBudget;

  const toggleExpanded = (id: string) => setExpanded(prev => {
    const s = new Set(prev);
    s.has(id) ? s.delete(id) : s.add(id);
    return s;
  });

  // Shortlist / Hold for Future / Reject only make sense at Resume Review —
  // same precondition the backend enforces for the non-HR-tier carve-out.
  const reviewable = apps.filter(a => a.stage === 'Resume Review');
  const allReviewableSelected  = reviewable.length > 0 && reviewable.every(a => selectedIds.has(a.id));
  const someReviewableSelected = reviewable.some(a => selectedIds.has(a.id));

  const toggleSelected = (id: string) => setSelectedIds(prev => {
    const s = new Set(prev);
    s.has(id) ? s.delete(id) : s.add(id);
    return s;
  });
  const toggleSelectAll = () => setSelectedIds(prev => {
    const s = new Set(prev);
    reviewable.forEach(a => allReviewableSelected ? s.delete(a.id) : s.add(a.id));
    return s;
  });

  const refreshApps = () => {
    qc.invalidateQueries({ queryKey: ['applications'] });
    setSelectedIds(new Set());
  };

  const runBulk = async (fn: (id: string) => Promise<unknown>, ids: string[], label: string) => {
    setBulkSaving(true);
    let succeeded = 0;
    for (let i = 0; i < ids.length; i += BULK_CONCURRENCY) {
      const batch = ids.slice(i, i + BULK_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(fn));
      succeeded += settled.filter(r => r.status === 'fulfilled').length;
    }
    toast[succeeded === ids.length ? 'success' : 'error'](`${succeeded} of ${ids.length} ${label}`);
    setBulkSaving(false);
    refreshApps();
  };

  const bulkShortlist     = () => runBulk(id => applicationsApi.advanceStage(id, 'Shortlisted'), Array.from(selectedIds), 'shortlisted');
  const bulkHoldForFuture = () => runBulk(id => applicationsApi.updateStatus(id, { new_status: 'Hold for Future' }), Array.from(selectedIds), 'put on hold');

  const handleBulkReject = async (reasonCat: string, reasonDetail: string) => {
    if (!rejectTargetIds) return;
    setBulkSaving(true);
    let succeeded = 0;
    for (let i = 0; i < rejectTargetIds.length; i += BULK_CONCURRENCY) {
      const batch = rejectTargetIds.slice(i, i + BULK_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(id => applicationsApi.updateStatus(id, {
        new_status: 'Rejected', rejection_reason_cat: reasonCat, rejection_reason_detail: reasonDetail || undefined,
      })));
      succeeded += settled.filter(r => r.status === 'fulfilled').length;
    }
    toast[succeeded === rejectTargetIds.length ? 'success' : 'error'](`${succeeded} of ${rejectTargetIds.length} rejected`);
    setBulkSaving(false);
    setRejectTargetIds(null);
    refreshApps();
  };

  const shortlistOne = async (id: string) => {
    try {
      await applicationsApi.advanceStage(id, 'Shortlisted');
      toast.success('Candidate shortlisted');
      refreshApps();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || 'Action failed');
    }
  };

  const holdForFutureOne = async (id: string) => {
    try {
      await applicationsApi.updateStatus(id, { new_status: 'Hold for Future' });
      toast.success('Put on hold for future roles');
      refreshApps();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || 'Action failed');
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Scorecard Summary</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Every ResumeIQ-scored candidate, ranked and compared side by side — mirrors the
          digitalpaani-candidate-scoring skill's output format.
        </p>
        {roleIds.length === 1 && roleOptions.some(r => r.value === roleIds[0]) && (
          <div className="mt-2 inline-flex items-center gap-2 text-sm bg-dp-50 text-dp-800 px-3 py-1.5 rounded-lg">
            Filtered to <span className="font-medium">{roleOptions.find(r => r.value === roleIds[0])?.label}</span>
            <button onClick={() => setRoleIds([])} className="text-dp-600 hover:underline text-xs">View all roles</button>
          </div>
        )}
      </div>

      <div className="flex gap-1.5 flex-nowrap overflow-x-auto pb-1">
        <div className="shrink-0"><MultiSelectFilter label="Department"       options={DEPARTMENTS}          selected={departments} onChange={setDepartments} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Location"         options={LOCATIONS}            selected={locations}   onChange={setLocations} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Recruitment Mode" options={modeOptions}          selected={modes}        onChange={setModes} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Priority"         options={PRIORITIES}           selected={priorities}  onChange={setPriorities} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Status"           options={APPLICATION_STATUSES} selected={statuses}     onChange={setStatuses} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Role"             options={roleOptions}          selected={roleIds}      onChange={setRoleIds} /></div>
        <button
          onClick={() => setFilterInBudget(v => !v)}
          className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            filterInBudget ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
          }`}
        >
          In-budget only
        </button>
      </div>

      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-dp-50 border border-dp-100 rounded-lg">
          <span className="text-xs font-medium text-dp-700">{selectedIds.size} selected</span>
          <button
            onClick={bulkShortlist}
            disabled={bulkSaving}
            className="flex items-center gap-1.5 btn-primary text-xs py-1 px-2.5"
          >
            {bulkSaving ? <Spinner size="sm" /> : <CheckCircle className="w-3.5 h-3.5" />}
            Shortlist
          </button>
          <button
            onClick={bulkHoldForFuture}
            disabled={bulkSaving}
            className="flex items-center gap-1.5 btn-secondary text-xs py-1 px-2.5"
          >
            <PauseCircle className="w-3.5 h-3.5" />
            Hold for Future
          </button>
          <button
            onClick={() => setRejectTargetIds(Array.from(selectedIds))}
            disabled={bulkSaving}
            className="flex items-center gap-1.5 btn-secondary text-xs py-1 px-2.5 text-red-600 hover:bg-red-50"
          >
            <XCircle className="w-3.5 h-3.5" />
            Reject
          </button>
        </div>
      )}

      <div className="card overflow-x-auto">
        {isLoading ? (
          <div className="flex justify-center p-12"><Spinner size="lg" /></div>
        ) : apps.length === 0 ? (
          <div className="p-12">
            <EmptyState
              title={hasActiveFilters ? 'No scored candidates match these filters' : 'No scored candidates yet'}
            />
          </div>
        ) : (
          <table className="w-full table-fixed">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="table-th px-1.5 w-[28px]">
                  {reviewable.length > 0 && (
                    <input
                      type="checkbox"
                      checked={allReviewableSelected}
                      ref={el => { if (el) el.indeterminate = someReviewableSelected && !allReviewableSelected; }}
                      onChange={toggleSelectAll}
                      title="Select all (Resume Review only)"
                    />
                  )}
                </th>
                {[
                  ['#', 'w-[32px]'], ['', 'w-[28px]'], ['Candidate', 'w-[150px]'], ['Role', 'w-[120px]'],
                  ['Company / Industry', 'w-[140px]'], ['Notice', 'w-[55px]'], ['CTC → ECTC', 'w-[95px]'],
                  ...DIMENSIONS.map(d => [d.label, 'w-[42px]'] as [string, string]),
                  ['Avg', 'w-[45px]'], ['Verdict', 'w-[80px]'], ['Resume', 'w-[55px]'],
                  ['Stage', 'w-[110px]'], ['Actions', 'w-[150px]'],
                ].map(([h, w], i) => (
                  <th key={`${h}-${i}`} title={h} className={`table-th px-1.5 truncate tracking-normal ${w}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {apps.map((app, idx) => (
                <Fragment key={app.id}>
                  <tr className="hover:bg-gray-50 transition-colors">
                    <td className="table-td px-1.5 py-3">
                      {app.stage === 'Resume Review' && (
                        <input type="checkbox" checked={selectedIds.has(app.id)} onChange={() => toggleSelected(app.id)} />
                      )}
                    </td>
                    <td className="table-td px-1.5 py-3 text-xs text-gray-400">{idx + 1}</td>
                    <td className="table-td px-1.5 py-3">
                      <button onClick={() => toggleExpanded(app.id)} className="text-gray-400 hover:text-dp-600">
                        {expanded.has(app.id) ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                    </td>
                    <td className="table-td px-1.5 py-3">
                      <Link to={`/candidates/${app.candidate_id}`} className="text-sm font-medium text-gray-900 hover:text-dp-600 block truncate">
                        {app.candidate_name}
                      </Link>
                      <div className="text-xs text-gray-400 truncate">{app.email}</div>
                    </td>
                    <td className="table-td px-1.5 py-3 truncate">
                      <Link to={`/roles/${app.role_id}`} className="text-xs text-gray-700 hover:text-dp-600 block truncate">
                        {app.role_title}
                      </Link>
                    </td>
                    <td className="table-td px-1.5 py-3 text-xs text-gray-500 truncate" title={`${app.candidate_company || '—'} / ${app.candidate_industry || '—'}`}>
                      {app.candidate_company || '—'} / {app.candidate_industry || '—'}
                    </td>
                    <td className="table-td px-1.5 py-3 text-xs text-gray-500 truncate">
                      {app.candidate_notice_period_days != null ? `${app.candidate_notice_period_days}d` : '—'}
                    </td>
                    <td className="table-td px-1.5 py-3 text-xs text-gray-500 truncate">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate">
                          {app.candidate_ctc_fixed ? `₹${app.candidate_ctc_fixed}L` : '—'}
                          {' → '}
                          {app.candidate_expected_ctc ? `₹${app.candidate_expected_ctc}L` : '—'}
                        </span>
                        <OverBudgetBadge overBudget={isOverBudget(app.candidate_expected_ctc, app.role_ctc_band)} />
                      </div>
                    </td>
                    {DIMENSIONS.map(d => (
                      <td key={d.key} className="table-td px-1.5 py-3 text-right"><ScoreCell score={app[d.key] as number | undefined} /></td>
                    ))}
                    <td className="table-td px-1.5 py-3 text-sm font-semibold text-gray-900">
                      {app.score_avg != null ? Number(app.score_avg).toFixed(1) : '—'}
                    </td>
                    <td className="table-td px-1.5 py-3"><VerdictBadge recommendation={app.score_recommendation} /></td>
                    <td className="table-td px-1.5 py-3 text-xs">
                      {app.candidate_resume_link ? (
                        <a href={app.candidate_resume_link} target="_blank" rel="noreferrer" className="text-dp-600 hover:underline">View</a>
                      ) : '—'}
                    </td>
                    <td className="table-td px-1.5 py-3">
                      {canLead ? (
                        <button onClick={() => setStageModalApp(app)} className="text-xs text-gray-600 hover:text-dp-600 underline truncate block">
                          {app.stage}
                        </button>
                      ) : (
                        <span className="text-xs text-gray-500 truncate block">{app.stage}</span>
                      )}
                    </td>
                    <td className="table-td px-1.5 py-3">
                      {app.stage === 'Resume Review' && (
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => setRejectTargetIds([app.id])}
                            title="Reject"
                            className="p-1 rounded text-gray-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => holdForFutureOne(app.id)}
                            title="Hold for future roles"
                            className="p-1 rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                          >
                            <PauseCircle className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => shortlistOne(app.id)}
                            title="Shortlist"
                            className="flex items-center gap-1 btn-primary text-xs py-1 px-2"
                          >
                            <CheckCircle className="w-3.5 h-3.5" />
                            Shortlist
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                  {expanded.has(app.id) && (
                    <tr key={`${app.id}-detail`} className="bg-gray-50/60">
                      <td colSpan={7 + DIMENSIONS.length + 6} className="px-4 py-4">
                        <div className="grid grid-cols-3 gap-4">
                          <div>
                            <div className="text-xs text-green-600 font-medium mb-1">✓ Key strengths</div>
                            {app.score_strengths?.length ? (
                              <ul className="text-xs text-gray-600 space-y-0.5">
                                {app.score_strengths.map((s, i) => <li key={i}>• {s}</li>)}
                              </ul>
                            ) : <p className="text-xs text-gray-400">—</p>}
                          </div>
                          <div>
                            <div className="text-xs text-red-500 font-medium mb-1">⚠ Red flags</div>
                            {app.score_red_flags?.length ? (
                              <ul className="text-xs text-gray-600 space-y-0.5">
                                {app.score_red_flags.map((s, i) => <li key={i}>• {s}</li>)}
                              </ul>
                            ) : <p className="text-xs text-gray-400">None noted</p>}
                          </div>
                          <div>
                            <div className="text-xs text-gray-500 font-medium mb-1">Executive summary</div>
                            <p className="text-xs text-gray-600 leading-relaxed">{app.score_summary || '—'}</p>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {stageModalApp && (
        <StageChangeModal
          application={stageModalApp}
          onClose={() => setStageModalApp(null)}
          onUpdated={() => qc.invalidateQueries({ queryKey: ['applications'] })}
        />
      )}

      {rejectTargetIds && (
        <RejectReasonModal
          count={rejectTargetIds.length}
          saving={bulkSaving}
          onConfirm={handleBulkReject}
          onClose={() => setRejectTargetIds(null)}
        />
      )}
    </div>
  );
}
