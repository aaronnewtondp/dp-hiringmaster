import { Fragment, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle, PauseCircle, XCircle, Search, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import toast from 'react-hot-toast';
import { applicationsApi, rolesApi } from '../services/api.ts';
import { Application, PRIORITIES, APPLICATION_STATUSES, LOCATIONS, DEPARTMENTS } from '../types/index.ts';
import { Spinner, EmptyState, OverBudgetBadge, StageBadge } from '../components/shared/Badges.tsx';
import MultiSelectFilter from '../components/shared/MultiSelectFilter.tsx';
import StageChangeModal from '../components/shared/StageChangeModal.tsx';
import RejectReasonModal from '../components/shared/RejectReasonModal.tsx';
import BudgetExceptionModal from '../components/shared/BudgetExceptionModal.tsx';
import { isOverBudget, isWithinBudgetOrNear } from '../utils/budget.ts';
import { useAuth } from '../contexts/AuthContext.tsx';
import { usePersistedState } from '../hooks/usePersistedState.ts';
import InfoTooltip from '../components/shared/InfoTooltip.tsx';

// Same chunked-batching constant as Candidates.tsx / MyTasks.tsx's bulk actions.
const BULK_CONCURRENCY = 3;

const COLUMN_INFO: Record<string, string> = {
  'CTC → ECTC': "Candidate's current fixed CTC, then the Expected CTC they quoted for this role — both read from the candidate's own profile, not this application's legacy fields.",
};

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

// Column counts flanking the DIMENSIONS block, for the toggle/detail rows'
// colSpan math — kept as named constants so a future column add/remove only
// needs updating here, not re-derived by hand at every colSpan call site.
// Before: checkbox, #, Candidate, Role, Stage, CTC→ECTC, Notice,
// Preferred Location, Company/Industry, Resume. After: Avg, Verdict,
// App. Age, Actions.
const SCORECARD_COLS_BEFORE_DIMS = 10;
const SCORECARD_COLS_AFTER_DIMS = 4;

// Same sortable-column pattern as Candidates.tsx (item #7) — Avg and
// App. Age are this page's equivalents of Candidates' Fit and Application
// Date (there's no Last-Updated-equivalent column here to add a third).
type SortKey = 'avg' | 'app_age';

export default function ScorecardSummary() {
  const qc = useQueryClient();
  const { canLead, canHR } = useAuth();
  const [searchParams] = useSearchParams();
  // Filters persisted to sessionStorage (item #13) so they survive
  // navigating away and back. roleIds is the one exception on initial
  // mount: arriving from a role's detail page ("Scorecard Summary" button
  // there) is an explicit, deliberate filter intent that should override
  // whatever was left over from a previous visit — handled in the effect
  // below, after the persisted value has already loaded.
  const [roleIds,     setRoleIds]     = usePersistedState<string[]>('scorecard.roleIds', []);
  const [searchInput, setSearchInput] = usePersistedState('scorecard.search', '');
  const [search,      setSearch]      = useState(searchInput);
  const [departments, setDepartments] = usePersistedState<string[]>('scorecard.departments', []);
  const [locations,   setLocations]   = usePersistedState<string[]>('scorecard.locations', []);
  const [modes,       setModes]       = usePersistedState<string[]>('scorecard.modes', []);
  const [priorities,  setPriorities]  = usePersistedState<string[]>('scorecard.priorities', []);
  const [statuses,    setStatuses]    = usePersistedState<string[]>('scorecard.statuses', []);
  const [filterInBudget, setFilterInBudget] = usePersistedState('scorecard.inBudget', false);

  useEffect(() => {
    const roleId = searchParams.get('role_id');
    if (roleId) setRoleIds([roleId]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [expanded,    setExpanded]    = useState<Set<string>>(new Set());
  const [stageModalApp, setStageModalApp] = useState<Application | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [rejectTargetIds, setRejectTargetIds] = useState<string[] | null>(null);
  const [budgetExceptionIds, setBudgetExceptionIds] = useState<string[] | null>(null);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  // Debounced free-text search — same pattern/timing as Candidates.tsx's own
  // `q` search, hitting the shared /applications route's server-side match
  // over candidate name/email/role title.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  // NOT scoped to Applied and Screened — this page compares every scored
  // candidate across the whole pipeline, not just the shortlisting queue
  // (removing every other stage broke that comparison entirely — see
  // scored_only_exempt_stage below for how the shortlisting queue still
  // stays fully visible without narrowing the fetch to just it).
  // `scored_only_exempt_stage: 'Applied and Screened'` keeps `scored_only`'s
  // original "only show real ResumeIQ scores" rule for every other stage,
  // but carves out Applied and Screened: an application there whose
  // automatic scoring failed or never completed (score_avg IS NULL) still
  // needs the exact same shortlist/reject/hold decision, so it can't be
  // hidden just because it has no score yet. The score columns already
  // render '—' for a null value, so nothing breaks by including these rows.
  // `limit: '500'` is generous headroom above any realistic Active+scored
  // population across the whole pipeline.
  const params: Record<string, string | string[]> = {
    limit: '500', scored_only: 'true', scored_only_exempt_stage: 'Applied and Screened',
  };
  if (search)              params.q = search;
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
    queryKey: ['applications', 'scorecard', search, roleIds, departments, locations, modes, priorities, statuses],
    queryFn:  () => applicationsApi.list(params),
  });
  const allApps = data?.data?.applications || [];
  // Client-side, same reasoning as Candidates.tsx's identical toggle —
  // role_ctc_band is freeform text, best parsed in JS.
  const apps = filterInBudget
    ? allApps.filter(a => isWithinBudgetOrNear(a.candidate_expected_ctc, a.role_ctc_band))
    : allApps;
  const sortValue = (app: Application, key: SortKey): number => {
    if (key === 'avg') return app.score_avg != null ? Number(app.score_avg) : -Infinity;
    return app.application_date ? new Date(app.application_date).getTime() : -Infinity;
  };
  const sortedApps = sortKey
    ? [...apps].sort((a, b) => (sortDir === 'desc' ? 1 : -1) * (sortValue(b, sortKey) - sortValue(a, sortKey)))
    : apps;

  const { data: filterOptionsData } = useQuery<{ data: { recruitment_modes: string[]; roles: { id: string; title: string }[] } }>({
    queryKey: ['roles', 'filter-options'],
    queryFn:  () => rolesApi.filterOptions(),
  });
  const modeOptions = filterOptionsData?.data?.recruitment_modes || [];
  const roleOptions = (filterOptionsData?.data?.roles || []).map(r => ({ value: r.id, label: r.title }));

  const hasActiveFilters = !!search || roleIds.length || departments.length || locations.length || modes.length || priorities.length || statuses.length || filterInBudget;

  const toggleExpanded = (id: string) => setExpanded(prev => {
    const s = new Set(prev);
    s.has(id) ? s.delete(id) : s.add(id);
    return s;
  });

  // Kept as a defensive filter even though the fetch above is already
  // stage-scoped to 'Applied and Screened' — Shortlist / Hold for Future /
  // Reject only ever make sense at that one stage (same precondition the
  // backend enforces for the non-HR-tier carve-out), so this stays correct
  // even if a future edit widens what this query fetches.
  const reviewable = apps.filter(a => a.stage === 'Applied and Screened');
  const allReviewableSelected  = reviewable.length > 0 && reviewable.every(a => selectedIds.has(a.id));
  const someReviewableSelected = reviewable.some(a => selectedIds.has(a.id));
  // Every application is meant to be auto-scored the instant it's created
  // (resumeIQTrigger.ts) — a row that's Applied and Screened + Active with
  // no score means that automatic pass failed or never ran (a failure
  // leaves no trace anywhere else, since runResumeIQScoring only logs on
  // success). Surfaced here rather than silently hidden, with a way to
  // retry it directly.
  const unscored = apps.filter(a => a.score_avg == null);

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

  // 15%+ over-budget candidates need an explicit reason before shortlisting
  // (backend enforces this too — this is just so the user isn't surprised by
  // a 400). One shared reason applies to the whole batch when bulk-acting,
  // same as bulk Reject's single reason-for-the-batch pattern. "Shortlist"
  // now advances straight to Interview Round 1 — 'Shortlisted' was retired
  // as its own intermediate stage.
  const shortlistIds = async (ids: string[], reasonCat?: string, reasonDetail?: string) => {
    const opts = { budgetExceptionReasonCat: reasonCat, budgetExceptionReasonDetail: reasonDetail };
    if (ids.length === 1) {
      try {
        await applicationsApi.advanceStage(ids[0], 'Interview Round 1', opts);
        toast.success('Candidate shortlisted');
        refreshApps();
      } catch (err: unknown) {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
        toast.error(msg || 'Action failed');
      }
    } else {
      await runBulk(id => applicationsApi.advanceStage(id, 'Interview Round 1', opts), ids, 'shortlisted');
    }
  };

  const requestShortlist = (ids: string[]) => {
    // Server-computed (applications.ts), not re-derived from role_ctc_band
    // client-side — that field is stripped for non-HR-tier personas, so a
    // Hiring Manager's own client-side re-derivation always came back
    // false, meaning the modal never opened and their shortlist attempt hit
    // the backend's 400 with no way to ever supply a reason.
    const anyOverBudget = apps.some(a => ids.includes(a.id) && a.is_severely_over_budget);
    if (anyOverBudget) { setBudgetExceptionIds(ids); return; }
    shortlistIds(ids);
  };

  const handleBudgetExceptionConfirm = async (reasonCat: string, reasonDetail: string) => {
    if (!budgetExceptionIds) return;
    setBulkSaving(true);
    await shortlistIds(budgetExceptionIds, reasonCat, reasonDetail);
    setBulkSaving(false);
    setBudgetExceptionIds(null);
  };

  const bulkShortlist     = () => requestShortlist(Array.from(selectedIds));
  const bulkHoldForFuture = () => runBulk(id => applicationsApi.updateStatus(id, { new_status: 'Hold for Future' }), Array.from(selectedIds), 'put on hold');
  const retryScoring = (ids: string[]) => runBulk(id => applicationsApi.retryScoring(id), ids, 'retried');

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
        <div className="inline-flex items-center gap-1.5">
          <h1 className="text-xl font-semibold text-gray-900">Scorecard Summary</h1>
          <InfoTooltip align="left" width="w-80" text={
            <div className="space-y-1.5">
              <p>8 ResumeIQ dimensions, each scored 0–10: <b>Tech</b>nical, <b>Exp</b>erience, <b>Ind</b>ustry Fit, <b>Cult</b>ure Fit, <b>Role</b> Alignment, <b>Traj</b>ectory, <b>Lead</b>ership, <b>Comm</b>unication.</p>
              <p><b>Avg</b> is the mean of all 8. <b>Verdict</b> (Strong Yes / Yes / Maybe / No) comes from the same ResumeIQ pass, not a separate rule.</p>
              <p>Use "View Highlights and Summary" under any row for that candidate's strengths, red flags, and executive summary.</p>
            </div>
          } />
        </div>
        <p className="text-sm text-gray-500 mt-0.5">
          Every candidate at Applied and Screened, plus every other ResumeIQ-scored active candidate,
          ranked and compared side by side — mirrors the digitalpaani-candidate-scoring skill's output format.
        </p>
        {roleIds.length === 1 && roleOptions.some(r => r.value === roleIds[0]) && (
          <div className="mt-2 inline-flex items-center gap-2 text-sm bg-dp-50 text-dp-800 px-3 py-1.5 rounded-lg">
            Filtered to <span className="font-medium">{roleOptions.find(r => r.value === roleIds[0])?.label}</span>
            <button onClick={() => setRoleIds([])} className="text-dp-600 hover:underline text-xs">View all roles</button>
          </div>
        )}
      </div>

      <div className="flex gap-1.5 flex-nowrap overflow-x-auto pb-1">
        <div className="relative shrink-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input
            type="text"
            placeholder="Search candidate or role…"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="input text-xs pl-8 py-1.5 w-52"
          />
        </div>
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

      {canHR && unscored.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
          <span className="text-xs font-medium text-amber-800">
            {unscored.length} candidate{unscored.length === 1 ? '' : 's'} pending ResumeIQ scoring
          </span>
          <button
            onClick={() => retryScoring(unscored.map(a => a.id))}
            disabled={bulkSaving}
            className="flex items-center gap-1.5 btn-secondary text-xs py-1 px-2.5"
          >
            {bulkSaving && <Spinner size="sm" />}
            Retry scoring
          </button>
        </div>
      )}

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
                      title="Select all (Applied only)"
                    />
                  )}
                </th>
                {[
                  { label: '#', width: 'w-[32px]' },
                  { label: 'Candidate', width: 'w-[150px]' },
                  { label: 'Role', width: 'w-[120px]' },
                  { label: 'Stage', width: 'w-[100px]' },
                  { label: 'CTC → ECTC', width: 'w-[105px]' },
                  { label: 'Notice', width: 'w-[55px]' },
                  { label: 'Preferred Location', width: 'w-[110px]' },
                  { label: 'Company / Industry', width: 'w-[140px]' },
                  { label: 'Resume', width: 'w-[55px]' },
                  ...DIMENSIONS.map(d => ({ label: d.label, width: 'w-[42px]' })),
                  { label: 'Avg', width: 'w-[58px]', sortKey: 'avg' as const },
                  { label: 'Verdict', width: 'w-[80px]' },
                  { label: 'App. Age', width: 'w-[80px]', sortKey: 'app_age' as const },
                  { label: 'Actions', width: 'w-[150px]' },
                ].map((col, i) => (
                  // overflow-hidden unconditional — see Candidates.tsx's own
                  // header cells for why (a too-wide label used to visually
                  // bleed into the next column's header).
                  <th key={`${col.label}-${i}`} title={col.label} className={`table-th px-1.5 tracking-normal overflow-hidden ${col.width}`}>
                    <div className="flex items-center gap-1 min-w-0">
                      {col.sortKey ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(col.sortKey)}
                          className="flex items-center gap-1 min-w-0 hover:text-dp-600 transition-colors group"
                        >
                          <span className="truncate">{col.label}</span>
                          {sortKey === col.sortKey ? (
                            sortDir === 'asc'
                              ? <ChevronUp className="w-3.5 h-3.5 shrink-0 text-dp-600" strokeWidth={3} />
                              : <ChevronDown className="w-3.5 h-3.5 shrink-0 text-dp-600" strokeWidth={3} />
                          ) : (
                            <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 text-gray-400 group-hover:text-dp-500" strokeWidth={2.5} />
                          )}
                        </button>
                      ) : (
                        <span className="truncate">{col.label}</span>
                      )}
                      {COLUMN_INFO[col.label] && <InfoTooltip text={COLUMN_INFO[col.label]} width="w-60" />}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sortedApps.map((app, idx) => (
                <Fragment key={app.id}>
                  <tr className="hover:bg-gray-50 transition-colors">
                    <td className="table-td px-1.5 py-3">
                      {app.stage === 'Applied and Screened' && (
                        <input type="checkbox" checked={selectedIds.has(app.id)} onChange={() => toggleSelected(app.id)} />
                      )}
                    </td>
                    <td className="table-td px-1.5 py-3 text-xs text-gray-400 truncate">{idx + 1}</td>
                    <td className="table-td px-1.5 py-3 truncate">
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
                    {/* truncate on the <td> itself (not just its child
                        button/span) is load-bearing here — a table-fixed
                        cell's own overflow stays visible by default, so a
                        long Stage value like "Assignment Round" rendered
                        without it visibly bled into the next column
                        (CTC → ECTC) rather than actually clipping. */}
                    <td className="table-td px-1.5 py-3 truncate">
                      {canLead ? (
                        <button onClick={() => setStageModalApp(app)} className="block max-w-full">
                          <StageBadge stage={app.stage} />
                        </button>
                      ) : (
                        <StageBadge stage={app.stage} />
                      )}
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
                    <td className="table-td px-1.5 py-3 text-xs text-gray-500 truncate">
                      {app.candidate_notice_period_days != null ? `${app.candidate_notice_period_days}d` : '—'}
                    </td>
                    <td className="table-td px-1.5 py-3 text-xs text-gray-500 truncate" title={app.preferred_location || ''}>
                      {app.preferred_location || '—'}
                    </td>
                    <td className="table-td px-1.5 py-3 text-xs text-gray-500 truncate" title={`${app.candidate_company || '—'} / ${app.candidate_industry || '—'}`}>
                      {app.candidate_company || '—'} / {app.candidate_industry || '—'}
                    </td>
                    <td className="table-td px-1.5 py-3 text-xs truncate">
                      {app.candidate_resume_link ? (
                        <a href={app.candidate_resume_link} target="_blank" rel="noreferrer" className="text-dp-600 hover:underline">View</a>
                      ) : '—'}
                    </td>
                    {DIMENSIONS.map(d => (
                      <td key={d.key} className="table-td px-1.5 py-3 text-right"><ScoreCell score={app[d.key] as number | undefined} /></td>
                    ))}
                    <td className="table-td px-1.5 py-3 text-sm font-semibold text-gray-900">
                      {app.score_avg != null ? Number(app.score_avg).toFixed(1) : '—'}
                    </td>
                    <td className="table-td px-1.5 py-3 truncate"><VerdictBadge recommendation={app.score_recommendation} /></td>
                    <td className="table-td px-1.5 py-3 text-xs font-mono text-gray-500 truncate">
                      {app.application_date ? `${Math.floor((Date.now() - new Date(app.application_date).getTime()) / 86400000)}d` : '—'}
                    </td>
                    <td className="table-td px-1.5 py-3">
                      {app.stage === 'Applied and Screened' && (
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
                            onClick={() => requestShortlist([app.id])}
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
                  <tr className="border-t-0">
                    <td colSpan={SCORECARD_COLS_BEFORE_DIMS} className="p-0" />
                    <td colSpan={DIMENSIONS.length} className="px-1.5 pb-2 text-center">
                      <button
                        onClick={() => toggleExpanded(app.id)}
                        className="text-[11px] text-dp-600 hover:text-dp-700 hover:underline font-medium"
                      >
                        {expanded.has(app.id) ? 'Hide Highlights and Summary' : 'View Highlights and Summary'}
                      </button>
                    </td>
                    <td colSpan={SCORECARD_COLS_AFTER_DIMS} className="p-0" />
                  </tr>
                  {expanded.has(app.id) && (
                    <tr key={`${app.id}-detail`} className="bg-gray-50/60">
                      <td colSpan={SCORECARD_COLS_BEFORE_DIMS + DIMENSIONS.length + SCORECARD_COLS_AFTER_DIMS} className="px-4 py-4">
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

      {budgetExceptionIds && (
        <BudgetExceptionModal
          count={budgetExceptionIds.length}
          saving={bulkSaving}
          onConfirm={handleBudgetExceptionConfirm}
          onClose={() => setBudgetExceptionIds(null)}
        />
      )}
    </div>
  );
}
