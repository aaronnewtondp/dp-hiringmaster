import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Search, Plus, ChevronRight, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { applicationsApi, candidatesApi, rolesApi } from '../services/api.ts';
import { Application, Candidate, STAGES, PRIORITIES, APPLICATION_STATUSES, LOCATIONS, DEPARTMENTS, REJECTION_REASONS, WITHDRAWAL_REASONS, OVER_BUDGET_SHORTLIST_REASONS } from '../types/index.ts';
import { StageBadge, StatusBadge, FitScore, SlaBadge, OverBudgetBadge, Spinner, EmptyState, PriorityBadge } from '../components/shared/Badges.tsx';
import { isOverBudget, isWithinBudgetOrNear } from '../utils/budget.ts';
import LinkToRoleModal from '../components/shared/LinkToRoleModal.tsx';
import MultiSelectFilter from '../components/shared/MultiSelectFilter.tsx';
import { useAuth } from '../contexts/AuthContext.tsx';
import { usePersistedState } from '../hooks/usePersistedState.ts';
import { formatDistanceToNow } from 'date-fns';

const UNLINKED_PAGE_SIZE = 50;

interface UnmatchedSubmission {
  candidate_id:         string;
  full_name:            string;
  email:                string | null;
  submitted_text:       string;
  created_at:           string;
  suggested_role_id:    string | null;
  suggested_role_title: string | null;
}

export default function Candidates() {
  const { canHR } = useAuth();
  const qc = useQueryClient();
  // Persisted to sessionStorage (not plain useState) so filters survive
  // navigating away and back within the same browser session — item #13.
  const [searchInput, setSearchInput] = usePersistedState('candidates.search', '');
  const [search,      setSearch]      = useState(searchInput);
  const [filterStage, setFilterStage] = usePersistedState('candidates.stage', 'all');
  const [filterSla,   setFilterSla]   = usePersistedState('candidates.sla', false);
  const [filterInBudget, setFilterInBudget] = usePersistedState('candidates.inBudget', false);
  const [roleIds,     setRoleIds]     = usePersistedState<string[]>('candidates.roleIds', []);
  const [departments, setDepartments] = usePersistedState<string[]>('candidates.departments', []);
  const [locations,   setLocations]   = usePersistedState<string[]>('candidates.locations', []);
  const [modes,       setModes]       = usePersistedState<string[]>('candidates.modes', []);
  const [priorities,  setPriorities]  = usePersistedState<string[]>('candidates.priorities', []);
  const [applicationStatuses, setApplicationStatuses] = usePersistedState<string[]>('candidates.statuses', []);
  const [showUnlinked, setShowUnlinked] = useState(true);
  const [linkCandidate, setLinkCandidate] = useState<Candidate | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<Candidate | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [unlinkedOffset, setUnlinkedOffset] = useState(0);
  const [unlinkedItems,  setUnlinkedItems]  = useState<Candidate[]>([]);
  const [unlinkedTotal,  setUnlinkedTotal]  = useState(0);

  // Job Application Form submissions whose role text never matched a role —
  // these never got an application at all, so a candidate with OTHER
  // existing applications doesn't show up in Unlinked Candidates above
  // (they're not unlinked) and had no visibility anywhere before this panel.
  const [showUnmatched,   setShowUnmatched]   = useState(false);
  const [unmatchedOffset, setUnmatchedOffset] = useState(0);
  const [unmatchedItems,  setUnmatchedItems]  = useState<UnmatchedSubmission[]>([]);
  const [unmatchedTotal,  setUnmatchedTotal]  = useState(0);
  const [reconcileTarget, setReconcileTarget] = useState<UnmatchedSubmission | null>(null);
  const [resolvingId,     setResolvingId]     = useState<string | null>(null);

  // Bulk select + bulk stage/status change — new UI territory for this app
  // (no prior row-selection pattern existed anywhere), HR-only to match the
  // backend's requireHR gate on both mutation endpoints.
  const [selectedIds,       setSelectedIds]       = useState<Set<string>>(new Set());
  const [showBulkStageModal, setShowBulkStageModal] = useState(false);
  const [bulkStageValue,    setBulkStageValue]    = useState(STAGES[0]);
  const [showBulkStatusModal, setShowBulkStatusModal] = useState(false);
  const [bulkStatusValue,   setBulkStatusValue]   = useState('Active');
  const [bulkRejectionCat,  setBulkRejectionCat]  = useState('');
  const [bulkRejectionDetail, setBulkRejectionDetail] = useState('');
  const [bulkBudgetReasonCat,    setBulkBudgetReasonCat]    = useState('');
  const [bulkBudgetReasonDetail, setBulkBudgetReasonDetail] = useState('');
  const [bulkSaving,        setBulkSaving]        = useState(false);

  // Debounced free-text search — same reasoning and timing as TalentPool.tsx's
  // own `q` search: this now hits the server (see `params.q` below) rather
  // than filtering whatever the flat `limit` below happened to fetch, since
  // a candidate ranked past that cutoff (new, unscored, sorted last) was
  // previously unsearchable no matter what you typed.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Archival (PRD §21) — Rejected/Withdrawn applications untouched for 90+
  // days are excluded from this default pipeline view; they remain fully
  // reachable via the Talent Pool page's "Archived" mode instead.
  const params: Record<string, string | string[]> = { limit: '100', exclude_stale_archived: 'true' };
  if (search)                  params.q = search;
  if (filterStage !== 'all')   params.stage  = filterStage;
  if (filterSla)               params.sla_breach = 'true';
  if (roleIds.length)          params.role_id = roleIds;
  if (departments.length)      params.department = departments;
  if (locations.length)        params.location = locations;
  if (modes.length)            params.recruitment_mode = modes;
  if (priorities.length)       params.priority = priorities;
  // This page's "Status" filter means the APPLICATION's own status
  // (Active/Rejected/etc) — unlike Dashboard/Roles, where "Status" means
  // role status (Draft/Approved/etc, sent as role_status). Sent as this
  // endpoint's native `status` param.
  if (applicationStatuses.length) params.status = applicationStatuses;

  const { data, isLoading } = useQuery<{ data: { applications: Application[] } }>({
    queryKey: ['applications', search, filterStage, filterSla, roleIds, departments, locations, modes, priorities, applicationStatuses],
    queryFn:  () => applicationsApi.list(params),
  });

  // Master filters — same fields/options as Dashboard.tsx's/Roles.tsx's own,
  // via the shared GET /api/roles/filter-options endpoint (non-Closed roles
  // only, auto-updated whenever a role is created/closed).
  const { data: filterOptionsData } = useQuery<{ data: { recruitment_modes: string[]; roles: { id: string; title: string }[] } }>({
    queryKey: ['roles', 'filter-options'],
    queryFn:  () => rolesApi.filterOptions(),
  });
  const modeOptions = filterOptionsData?.data?.recruitment_modes || [];
  const roleOptions = (filterOptionsData?.data?.roles || []).map(r => ({ value: r.id, label: r.title }));

  // Candidates.tsx's main table is application-row driven, so a candidate
  // with zero applications (e.g. an ingested candidate whose "role applying
  // for" answer didn't match any open role) never shows up there — surfaced
  // separately here via GET /api/candidates?unlinked=true. Previously this
  // fetched a flat limit:100 page of ALL candidates and filtered client-side
  // to applications == null, so a truly-unlinked candidate only showed up if
  // they happened to fall within the 100 most-recently-updated candidates
  // overall — the backend now filters this at the query level, with real
  // pagination, so the full set is reachable.
  const { data: candidatesData, isLoading: unlinkedLoading } = useQuery<{ data: { candidates: Candidate[]; total: number } }>({
    queryKey: ['candidates', 'unlinked', unlinkedOffset],
    queryFn:  () => candidatesApi.list({ unlinked: 'true', limit: String(UNLINKED_PAGE_SIZE), offset: String(unlinkedOffset) }),
  });

  useEffect(() => {
    if (!candidatesData?.data) return;
    const page = candidatesData.data.candidates || [];
    setUnlinkedItems(prev => (unlinkedOffset === 0 ? page : [...prev, ...page]));
    setUnlinkedTotal(candidatesData.data.total || 0);
  }, [candidatesData]);

  const refreshUnlinked = () => {
    setUnlinkedOffset(0);
    qc.invalidateQueries({ queryKey: ['candidates', 'unlinked'] });
  };

  const { data: unmatchedData, isLoading: unmatchedLoading } = useQuery<{ data: { submissions: UnmatchedSubmission[]; total: number } }>({
    queryKey: ['candidates', 'unmatched-role-submissions', unmatchedOffset],
    queryFn:  () => candidatesApi.unmatchedRoleSubmissions({ limit: String(UNLINKED_PAGE_SIZE), offset: String(unmatchedOffset) }),
  });

  useEffect(() => {
    if (!unmatchedData?.data) return;
    const page = unmatchedData.data.submissions || [];
    setUnmatchedItems(prev => (unmatchedOffset === 0 ? page : [...prev, ...page]));
    setUnmatchedTotal(unmatchedData.data.total || 0);
  }, [unmatchedData]);

  // Optimistic local removal rather than a full refetch — the backend's own
  // "still unresolved" check only re-matches by suggested_role_id (see the
  // route's own comment on why a no-suggestion row can't be detected as
  // resolved that way), so removing it here client-side is what actually
  // makes "Choose role" feel instant for that case specifically.
  const removeResolvedSubmission = (sub: UnmatchedSubmission) => {
    setUnmatchedItems(prev => prev.filter(s => !(s.candidate_id === sub.candidate_id && s.submitted_text === sub.submitted_text)));
    setUnmatchedTotal(t => Math.max(0, t - 1));
    qc.invalidateQueries({ queryKey: ['applications'] });
  };

  const handleQuickResolve = async (sub: UnmatchedSubmission) => {
    if (!sub.suggested_role_id) return;
    setResolvingId(sub.candidate_id);
    try {
      await candidatesApi.linkRole(sub.candidate_id, { role_id: sub.suggested_role_id, source_channel: 'Job Application Form' });
      toast.success(`${sub.full_name} linked to ${sub.suggested_role_title}`);
      removeResolvedSubmission(sub);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error || 'Failed to link candidate');
    }
    setResolvingId(null);
  };

  const handleDelete = async () => {
    if (!deleteCandidate) return;
    setDeleting(true);
    try {
      await candidatesApi.remove(deleteCandidate.id);
      toast.success(`${deleteCandidate.full_name} deleted`);
      setDeleteCandidate(null);
      refreshUnlinked();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error || 'Failed to delete candidate');
    }
    setDeleting(false);
  };

  const all = data?.data?.applications || [];
  // `q` above already did the name/email/role-title matching server-side.
  let filtered = all;
  // Client-side — role_ctc_band is freeform text, best parsed in JS rather
  // than added as a new SQL filter dimension.
  if (filterInBudget) {
    filtered = filtered.filter(a => isWithinBudgetOrNear(a.candidate_expected_ctc, a.role_ctc_band));
  }

  const slaCount = all.filter(a => a.sla_breach).length;

  const toggleSelected = (id: string) => setSelectedIds(prev => {
    const s = new Set(prev);
    s.has(id) ? s.delete(id) : s.add(id);
    return s;
  });
  const allVisibleSelected  = filtered.length > 0 && filtered.every(a => selectedIds.has(a.id));
  const someVisibleSelected = filtered.some(a => selectedIds.has(a.id));
  const toggleSelectAll = () => setSelectedIds(prev => {
    const s = new Set(prev);
    filtered.forEach(a => allVisibleSelected ? s.delete(a.id) : s.add(a.id));
    return s;
  });

  // Chunked, not all-at-once — only matters when the batch includes a move
  // into 'Resume Review' (a real, synchronous Drive+Claude call per
  // application, ~10-16s observed) but applied uniformly for simplicity;
  // the cost of chunking a handful of cheap DB-only transitions is
  // negligible. Each single-ID call already exists and is unchanged —
  // this is a client-side fan-out, not a new backend endpoint.
  const BULK_CONCURRENCY = 3;
  // Bulk stage-change is a generic "jump to any stage" tool too, same gap as
  // StageChangeModal.tsx — item #1's mandatory over-budget reason has to be
  // handled here as well, not just on ScorecardSummary/HMQueue's dedicated
  // Shortlist buttons. is_severely_over_budget is server-computed and never
  // stripped for any persona, so this check is safe regardless of who's
  // driving this modal.
  const bulkNeedsBudgetReason = bulkStageValue === 'Shortlisted' &&
    all.some(a => selectedIds.has(a.id) && a.is_severely_over_budget);

  const handleBulkStage = async () => {
    if (bulkNeedsBudgetReason && !bulkBudgetReasonCat) {
      toast.error('Select a reason before shortlisting — at least one selected candidate is 15%+ over budget');
      return;
    }
    setBulkSaving(true);
    const ids = Array.from(selectedIds);
    let succeeded = 0;
    for (let i = 0; i < ids.length; i += BULK_CONCURRENCY) {
      const batch = ids.slice(i, i + BULK_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(id => applicationsApi.advanceStage(id, bulkStageValue, {
        budgetExceptionReasonCat: bulkNeedsBudgetReason ? bulkBudgetReasonCat : undefined,
        budgetExceptionReasonDetail: bulkNeedsBudgetReason ? bulkBudgetReasonDetail.trim() || undefined : undefined,
      })));
      succeeded += settled.filter(r => r.status === 'fulfilled').length;
    }
    toast[succeeded === ids.length ? 'success' : 'error'](`${succeeded} of ${ids.length} updated to ${bulkStageValue}`);
    setShowBulkStageModal(false);
    setBulkBudgetReasonCat('');
    setBulkBudgetReasonDetail('');
    setSelectedIds(new Set());
    qc.invalidateQueries({ queryKey: ['applications'] });
    setBulkSaving(false);
  };

  const handleBulkStatus = async () => {
    if ((bulkStatusValue === 'Rejected' || bulkStatusValue === 'Withdrawn') && !bulkRejectionCat) {
      toast.error('A reason is required'); return;
    }
    setBulkSaving(true);
    const ids = Array.from(selectedIds);
    const settled = await Promise.allSettled(ids.map(id => applicationsApi.updateStatus(id, {
      new_status: bulkStatusValue,
      rejection_reason_cat: bulkRejectionCat || undefined,
      rejection_reason_detail: bulkRejectionDetail || undefined,
    })));
    const succeeded = settled.filter(r => r.status === 'fulfilled').length;
    toast[succeeded === ids.length ? 'success' : 'error'](`${succeeded} of ${ids.length} updated to ${bulkStatusValue}`);
    setShowBulkStatusModal(false);
    setSelectedIds(new Set());
    qc.invalidateQueries({ queryKey: ['applications'] });
    setBulkSaving(false);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Candidates</h1>
          <p className="text-sm font-mono text-gray-500 mt-0.5">
            {filtered.length} applications
            {slaCount > 0 && <span className="ml-2 text-red-500 font-medium font-mono">{slaCount} SLA breached</span>}
          </p>
        </div>
        {canHR && (
          <Link to="/candidates/new" className="btn-primary">
            <Plus className="w-4 h-4" /> Add candidate
          </Link>
        )}
      </div>

      {/* Unlinked candidates have no application, so they never belong to
          any role — the panel is meaningless (always empty) once a Role
          filter is active, so hide it rather than show a confusing "0". */}
      {roleIds.length === 0 && (unlinkedTotal > 0 || unlinkedLoading) && (
        <div className="card overflow-hidden border-amber-200">
          <button
            onClick={() => setShowUnlinked(v => !v)}
            className="w-full px-5 py-3 flex items-center justify-between hover:bg-amber-50/50 transition-colors"
          >
            <h2 className="text-sm font-semibold font-mono text-amber-800">Unlinked candidates ({unlinkedTotal})</h2>
            {showUnlinked ? <ChevronUp className="w-4 h-4 text-amber-600" /> : <ChevronDown className="w-4 h-4 text-amber-600" />}
          </button>
          {showUnlinked && (
            <>
              <div className="divide-y divide-gray-50 border-t border-amber-100">
                {unlinkedItems.map(c => (
                  <div key={c.id} className="px-5 py-3 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <Link to={`/candidates/${c.id}`} className="font-medium text-gray-900 hover:text-dp-600 text-sm">{c.full_name}</Link>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-400 flex-wrap">
                        {c.email && <span>{c.email}</span>}
                        {c.phone && <span>· {c.phone}</span>}
                        <span>· added {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}</span>
                      </div>
                    </div>
                    {canHR && (
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => setLinkCandidate(c)} className="btn-secondary text-xs py-1.5 px-3">
                          Link to role
                        </button>
                        <button
                          onClick={() => setDeleteCandidate(c)}
                          title="Delete candidate"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {unlinkedItems.length < unlinkedTotal && (
                <div className="flex justify-center py-3 border-t border-amber-100">
                  <button
                    onClick={() => setUnlinkedOffset(o => o + UNLINKED_PAGE_SIZE)}
                    className="btn-secondary text-xs py-1.5 px-3"
                  >
                    Load more ({unlinkedItems.length} of {unlinkedTotal})
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Job Application Form submissions whose role text never matched a
          role — these never got an application at all, so a candidate with
          existing applications to OTHER roles doesn't appear in Unlinked
          Candidates above (they're not unlinked) and had zero visibility
          anywhere before this panel. */}
      {roleIds.length === 0 && (unmatchedTotal > 0 || unmatchedLoading) && (
        <div className="card overflow-hidden border-amber-200">
          <button
            onClick={() => setShowUnmatched(v => !v)}
            className="w-full px-5 py-3 flex items-center justify-between hover:bg-amber-50/50 transition-colors"
          >
            <h2 className="text-sm font-semibold font-mono text-amber-800">Unmatched role submissions ({unmatchedTotal})</h2>
            {showUnmatched ? <ChevronUp className="w-4 h-4 text-amber-600" /> : <ChevronDown className="w-4 h-4 text-amber-600" />}
          </button>
          {showUnmatched && (
            <>
              <div className="divide-y divide-gray-50 border-t border-amber-100">
                {unmatchedItems.map(sub => (
                  <div key={`${sub.candidate_id}-${sub.submitted_text}`} className="px-5 py-3 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <Link to={`/candidates/${sub.candidate_id}`} className="font-medium text-gray-900 hover:text-dp-600 text-sm">{sub.full_name}</Link>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-400 flex-wrap">
                        {sub.email && <span>{sub.email}</span>}
                        <span>· applied for "{sub.submitted_text}"</span>
                        <span>· {formatDistanceToNow(new Date(sub.created_at), { addSuffix: true })}</span>
                      </div>
                    </div>
                    {canHR && (
                      <div className="flex items-center gap-2 shrink-0">
                        {sub.suggested_role_id && (
                          <button
                            onClick={() => handleQuickResolve(sub)}
                            disabled={resolvingId === sub.candidate_id}
                            className="btn-primary text-xs py-1.5 px-3 whitespace-nowrap"
                          >
                            {resolvingId === sub.candidate_id ? <Spinner size="sm" /> : `Link to ${sub.suggested_role_title}`}
                          </button>
                        )}
                        <button onClick={() => setReconcileTarget(sub)} className="btn-secondary text-xs py-1.5 px-3 whitespace-nowrap">
                          Choose role
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {unmatchedItems.length < unmatchedTotal && (
                <div className="flex justify-center py-3 border-t border-amber-100">
                  <button
                    onClick={() => setUnmatchedOffset(o => o + UNLINKED_PAGE_SIZE)}
                    className="btn-secondary text-xs py-1.5 px-3"
                  >
                    Load more ({unmatchedItems.length} of {unmatchedTotal})
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Search + filters — single row; scrolls horizontally rather than
          wrapping if the viewport is too narrow to fit everything. */}
      <div className="flex gap-1.5 flex-nowrap overflow-x-auto pb-1">
        <div className="relative w-40 shrink-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            placeholder="Search by name or role…"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="input pl-9"
          />
        </div>
        <select
          value={filterStage}
          onChange={e => setFilterStage(e.target.value)}
          className="select w-32 shrink-0 text-xs"
        >
          <option value="all">All stages</option>
          {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="shrink-0"><MultiSelectFilter label="Department"       options={DEPARTMENTS}   selected={departments}  onChange={setDepartments} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Location"         options={LOCATIONS}     selected={locations}    onChange={setLocations} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Recruitment Mode" options={modeOptions}   selected={modes}         onChange={setModes} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Priority"         options={PRIORITIES}    selected={priorities}   onChange={setPriorities} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Status"           options={APPLICATION_STATUSES} selected={applicationStatuses} onChange={setApplicationStatuses} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Role" options={roleOptions} selected={roleIds} onChange={setRoleIds} /></div>
        <button
          onClick={() => setFilterSla(v => !v)}
          className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            filterSla ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
          }`}
        >
          SLA breached only
        </button>
        <button
          onClick={() => setFilterInBudget(v => !v)}
          className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            filterInBudget ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
          }`}
        >
          In-budget only
        </button>
      </div>

      {canHR && selectedIds.size > 0 && (
        <div className="card px-4 py-2.5 flex items-center gap-3 bg-dp-50 border-dp-200">
          <span className="text-sm font-medium font-mono text-dp-800">{selectedIds.size} selected</span>
          <button onClick={() => setShowBulkStageModal(true)} className="btn-secondary text-xs py-1.5 px-3">Change Stage</button>
          <button onClick={() => setShowBulkStatusModal(true)} className="btn-secondary text-xs py-1.5 px-3">Change Status</button>
          <button onClick={() => setSelectedIds(new Set())} className="text-xs text-gray-500 hover:text-gray-700 ml-auto">Clear</button>
        </div>
      )}

      {/* Table — table-fixed with explicit per-column widths so the whole
          thing fits the card's width without clipping; overflow-x-auto is
          a safety net for narrow viewports rather than the primary fit
          mechanism. */}
      <div className="card overflow-x-auto">
        {isLoading ? (
          <div className="flex justify-center p-12"><Spinner size="lg" /></div>
        ) : filtered.length === 0 ? (
          <div className="p-12"><EmptyState title="No candidates match" /></div>
        ) : (
          <table className="w-full table-fixed">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                {canHR && (
                  <th className="table-th px-2 w-[28px]">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      ref={el => { if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected; }}
                      onChange={toggleSelectAll}
                    />
                  </th>
                )}
                {[
                  ['Candidate', 'w-[140px]'], ['Role', 'w-[100px]'], ['Stage', 'w-[95px]'],
                  ['Fit', 'w-[55px]'], ['CTC → ECTC', 'w-[100px]'], ['Notice', 'w-[62px]'],
                  ['Preferred Location', 'w-[115px]'], ['Current Company', 'w-[120px]'],
                  ['Resume Link', 'w-[72px]'], ['Last Updated', 'w-[108px]'], ['', 'w-[34px]'],
                ].map(([h, w]) => (
                  <th key={h} title={h} className={`table-th px-2 truncate tracking-normal ${w}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.map(app => (
                <tr key={app.id} className={`hover:bg-gray-50 transition-colors ${app.sla_breach ? 'bg-red-50/30' : ''}`}>
                  {canHR && (
                    <td className="table-td px-2 py-4">
                      <input type="checkbox" checked={selectedIds.has(app.id)} onChange={() => toggleSelected(app.id)} />
                    </td>
                  )}
                  <td className="table-td px-2 py-4">
                    <div className="min-w-0">
                      <Link to={`/candidates/${app.candidate_id}`} className="font-medium text-gray-900 hover:text-dp-600 block truncate">
                        {app.candidate_name}
                      </Link>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="text-xs text-gray-400">{app.id}</span>
                        <SlaBadge breached={app.sla_breach} />
                        {app.founder_review_flag && (
                          <span className="text-xs bg-purple-100 text-purple-700 px-1 rounded">Founder</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="table-td px-2 py-4 truncate">
                    <Link to={`/roles/${app.role_id}`} className="text-sm text-gray-700 hover:text-dp-600 block truncate">
                      {app.role_title}
                    </Link>
                    {app.role_priority && <PriorityBadge priority={app.role_priority} />}
                  </td>
                  <td className="table-td px-2 py-4"><StageBadge stage={app.stage} /></td>
                  <td className="table-td px-2 py-4"><FitScore score={app.ai_fit_score} /></td>
                  <td className="table-td px-2 py-4 text-xs text-gray-500 truncate">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono">
                        {app.candidate_ctc_fixed ? `₹${app.candidate_ctc_fixed}L` : '—'}
                        {' → '}
                        {app.candidate_expected_ctc ? `₹${app.candidate_expected_ctc}L` : '—'}
                      </span>
                      <OverBudgetBadge overBudget={isOverBudget(app.candidate_expected_ctc, app.role_ctc_band)} />
                    </div>
                  </td>
                  <td className="table-td px-2 py-4 text-xs font-mono text-gray-500 truncate">
                    {app.candidate_notice_period_days != null ? `${app.candidate_notice_period_days}d` : '—'}
                  </td>
                  <td className="table-td px-2 py-4 text-xs text-gray-500 truncate" title={app.preferred_location || ''}>{app.preferred_location || '—'}</td>
                  <td className="table-td px-2 py-4 text-xs text-gray-500 truncate" title={app.candidate_company || ''}>{app.candidate_company || '—'}</td>
                  <td className="table-td px-2 py-4 text-xs truncate">
                    {app.candidate_resume_link ? (
                      <a href={app.candidate_resume_link} target="_blank" rel="noreferrer" className="text-dp-600 hover:underline">
                        View
                      </a>
                    ) : '—'}
                  </td>
                  <td className="table-td px-2 py-4 text-xs text-gray-400 truncate">
                    {app.last_updated ? formatDistanceToNow(new Date(app.last_updated), { addSuffix: true }) : '—'}
                  </td>
                  <td className="table-td px-1 py-4">
                    <Link to={`/candidates/${app.candidate_id}`} className="text-gray-400 hover:text-dp-600">
                      <ChevronRight className="w-4 h-4" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {linkCandidate && (
        <LinkToRoleModal
          candidate={linkCandidate}
          sourceChannel="Job Application Form"
          onClose={() => setLinkCandidate(null)}
          onLinked={() => {
            refreshUnlinked();
            qc.invalidateQueries({ queryKey: ['applications'] });
          }}
        />
      )}

      {reconcileTarget && (
        <LinkToRoleModal
          candidate={{ id: reconcileTarget.candidate_id, full_name: reconcileTarget.full_name }}
          sourceChannel="Job Application Form"
          onClose={() => setReconcileTarget(null)}
          onLinked={() => removeResolvedSubmission(reconcileTarget)}
        />
      )}

      {deleteCandidate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-base font-semibold text-gray-900">Delete {deleteCandidate.full_name}?</h3>
            <p className="text-sm text-gray-500">
              This permanently deletes this candidate's record. This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteCandidate(null)} className="btn-secondary">Cancel</button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showBulkStageModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <h3 className="text-base font-semibold mb-1">Update stage</h3>
            <p className="text-sm font-mono text-gray-500 mb-4">{selectedIds.size} candidates</p>
            <select value={bulkStageValue} onChange={e => setBulkStageValue(e.target.value)} className="select mb-4">
              {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {bulkNeedsBudgetReason && (
              <div className="mb-4 space-y-3 p-3 bg-amber-50 border border-amber-100 rounded-lg">
                <p className="text-xs text-amber-800">
                  At least one selected candidate is 15%+ over the role's compensation band — select a reason to proceed.
                </p>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1.5">Reason <span className="text-red-500">*</span></label>
                  <select value={bulkBudgetReasonCat} onChange={e => setBulkBudgetReasonCat(e.target.value)} className="select text-sm">
                    <option value="">Select reason</option>
                    {OVER_BUDGET_SHORTLIST_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1.5">Additional detail <span className="text-gray-400">(optional)</span></label>
                  <textarea
                    value={bulkBudgetReasonDetail}
                    onChange={e => setBulkBudgetReasonDetail(e.target.value)}
                    placeholder="Optional context…"
                    className="input text-sm h-16 resize-none"
                  />
                </div>
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowBulkStageModal(false); setBulkBudgetReasonCat(''); setBulkBudgetReasonDetail(''); }} className="btn-secondary">Cancel</button>
              <button onClick={handleBulkStage} disabled={bulkSaving || (bulkNeedsBudgetReason && !bulkBudgetReasonCat)} className="btn-primary">{bulkSaving ? 'Updating…' : 'Update'}</button>
            </div>
          </div>
        </div>
      )}

      {showBulkStatusModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <div>
              <h3 className="text-base font-semibold">Update status</h3>
              <p className="text-sm font-mono text-gray-500">{selectedIds.size} candidates</p>
            </div>
            <select value={bulkStatusValue} onChange={e => setBulkStatusValue(e.target.value)} className="select">
              {['Active', 'Rejected', 'Withdrawn', 'Hold for Future'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {(bulkStatusValue === 'Rejected' || bulkStatusValue === 'Withdrawn') && (
              <>
                <select value={bulkRejectionCat} onChange={e => setBulkRejectionCat(e.target.value)} className="select">
                  <option value="">Select reason *</option>
                  {(bulkStatusValue === 'Rejected' ? REJECTION_REASONS : WITHDRAWAL_REASONS).map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <textarea placeholder="Additional detail (optional)" value={bulkRejectionDetail} onChange={e => setBulkRejectionDetail(e.target.value)} className="input h-20 resize-none" />
              </>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowBulkStatusModal(false)} className="btn-secondary">Cancel</button>
              <button onClick={handleBulkStatus} disabled={bulkSaving} className="btn-primary">{bulkSaving ? 'Updating…' : 'Update'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
