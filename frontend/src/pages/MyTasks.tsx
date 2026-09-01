import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, PauseCircle, XCircle, MessageSquare, Clock, AlertCircle, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { applicationsApi, dashboardApi, rolesApi } from '../services/api.ts';
import { Application, PendingAction, InterviewRound, Role } from '../types/index.ts';
import { StageBadge, FitScore, PriorityBadge, Spinner, EmptyState } from '../components/shared/Badges.tsx';
import InterviewFeedbackModal from '../components/InterviewFeedbackModal.tsx';
import RejectReasonModal from '../components/shared/RejectReasonModal.tsx';
import BudgetExceptionModal from '../components/shared/BudgetExceptionModal.tsx';
import { usePersistedState } from '../hooks/usePersistedState.ts';
import { useAuth } from '../contexts/AuthContext.tsx';
import { formatDistanceToNow } from 'date-fns';

// Same chunked-batching constant/reasoning as Candidates.tsx's bulk actions.
const BULK_CONCURRENCY = 3;

// Sentinel role_id used when a Hiring Manager owns no roles at all — mirrors
// applyHiringManagerRoleLock's own backend convention (roleFilters.ts) so an
// empty owned-role set reliably yields zero rows via `r.id = ANY($n)` rather
// than an unfiltered (i.e. everyone else's) result.
const NO_ROLES_OWNED_SENTINEL = '__no_roles_owned__';

// ─── Shortlist decision row ───────────────────────────────────────────────────
// Three actions — Shortlist moves the application's STAGE to 'Interview
// Round 1' (shortlisting no longer has its own intermediate stage); Hold for
// Future / Reject change its STATUS instead, which is what actually drops it
// out of this queue (see the query below).
function ShortlistRow({
  app,
  selected,
  onToggleSelect,
  onAction,
  onReject,
  onShortlist,
}: {
  app: Application & { candidate_name?: string; role_title?: string };
  selected: boolean;
  onToggleSelect: () => void;
  onAction: () => void;
  onReject: () => void;
  onShortlist: () => void;
}) {
  const [acting, setActing] = useState(false);

  const holdForFuture = async () => {
    setActing(true);
    try {
      await applicationsApi.updateStatus(app.id, { new_status: 'Hold for Future' });
      toast.success('Put on hold for future roles');
      onAction();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || 'Action failed');
    }
    setActing(false);
  };

  const waitingHours = app.stage_entry_time
    ? Math.round((Date.now() - new Date(app.stage_entry_time).getTime()) / 3600000)
    : null;

  return (
    <div className="flex items-center gap-4 p-4 hover:bg-gray-50 transition-colors">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        className="shrink-0"
      />

      {/* Avatar */}
      <div className="w-9 h-9 rounded-full bg-dp-100 flex items-center justify-center text-dp-700 font-semibold text-sm shrink-0">
        {app.candidate_name?.charAt(0).toUpperCase() || '?'}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to={`/candidates/${app.candidate_id}`}
            className="text-sm font-medium text-gray-900 hover:text-dp-600"
          >
            {app.candidate_name || app.candidate_id}
          </Link>
          {app.role_priority && (
            <PriorityBadge priority={app.role_priority as 'P0'|'P1'|'P2'|'P3'} />
          )}
          <FitScore score={app.ai_fit_score} />
          {app.ai_priority_bucket && (
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
              app.ai_priority_bucket === 'Strong Fit'   ? 'bg-green-100 text-green-700' :
              app.ai_priority_bucket === 'Review'       ? 'bg-amber-100 text-amber-700' :
              'bg-red-100 text-red-600'
            }`}>
              {app.ai_priority_bucket}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-400 mt-0.5 flex gap-2 flex-wrap">
          <span>{app.role_title}</span>
          {app.application_date && (
            <span className="font-mono">· Applied {Math.floor((Date.now() - new Date(app.application_date).getTime()) / 86400000)}d ago</span>
          )}
          {app.candidate_expected_ctc && <span className="font-mono">· ECTC ₹{app.candidate_expected_ctc}L</span>}
          {app.candidate_notice_period_days != null && <span className="font-mono">· {app.candidate_notice_period_days}d notice</span>}
          {waitingHours != null && (
            <span className={waitingHours > 48 ? 'text-red-500 font-medium font-mono' : 'font-mono'}>
              · Waiting {waitingHours}h
              {waitingHours > 48 && ' ⚠️'}
            </span>
          )}
        </div>
        {app.score_summary && (
          <p className="text-xs text-gray-500 mt-1 line-clamp-1 italic">"{app.score_summary}"</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 shrink-0">
        <button
          onClick={onReject}
          disabled={acting}
          title="Reject"
          className="p-1.5 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600 transition-colors"
        >
          <XCircle className="w-4 h-4" />
        </button>
        <button
          onClick={holdForFuture}
          disabled={acting}
          title="Hold for future roles"
          className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
        >
          <PauseCircle className="w-4 h-4" />
        </button>
        <button
          onClick={onShortlist}
          disabled={acting}
          className="flex items-center gap-1.5 btn-primary text-xs py-1.5 px-3"
        >
          <CheckCircle className="w-3.5 h-3.5" />
          Shortlist
        </button>
      </div>
    </div>
  );
}

// ─── Feedback due row ─────────────────────────────────────────────────────────
function FeedbackRow({
  action,
  onFeedback,
}: {
  action: PendingAction;
  onFeedback: (action: PendingAction) => void;
}) {
  const isOverdue = action.hours_overdue > 0;

  return (
    <div className="flex items-center gap-4 p-4 hover:bg-gray-50 transition-colors">
      <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
        isOverdue ? 'bg-red-100' : 'bg-amber-100'
      }`}>
        {isOverdue
          ? <AlertCircle className="w-4 h-4 text-red-600" />
          : <Clock className="w-4 h-4 text-amber-600" />
        }
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900">{action.candidate_name || '—'}</div>
        <div className="text-xs text-gray-400 mt-0.5 flex gap-2">
          <span>{action.role_title}</span>
          {isOverdue && (
            <span className="text-red-500 font-medium font-mono">
              · {Math.round(action.hours_overdue)}h overdue
            </span>
          )}
          <span>· {formatDistanceToNow(new Date(action.created_at), { addSuffix: true })}</span>
        </div>
        <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{action.description}</p>
      </div>
      {action.application_id && (
        <button
          onClick={() => onFeedback(action)}
          className="flex items-center gap-1.5 btn-secondary text-xs py-1.5 px-3 shrink-0"
        >
          <MessageSquare className="w-3.5 h-3.5" />
          Submit feedback
        </button>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
// "Ready for review" visibility/scoping — this page is a PERSONAL worklist,
// not another company-wide table (that's what Candidates/Scorecard Summary
// are for), so each persona sees only what's actually theirs to act on:
//   - HR/Admin & Super Admin: every Applied candidate, unfiltered — there's
//     no per-recruiter ownership field on roles to split this further, and
//     screening oversight company-wide genuinely IS HR's own job function,
//     not a slice borrowed from someone else's queue.
//   - Hiring Manager: only candidates on the role(s) they're the hiring
//     manager for — the whole point of "my" tasks for this persona. Scoped
//     the same way applyHiringManagerRoleLock (backend, roleFilters.ts)
//     already scopes their Dashboard: matching roles.hiring_manager_name
//     against their own name.
//   - Leadership: only candidates flagged for Founder Review — the one
//     existing Leadership-specific concept tied to individual applications
//     (founder_review_flag, settable only by HR/Leadership; setting it
//     already raises an owner_type='Leadership / Founders' pending action,
//     same family as the Feedback-due/Other-pending scoping below). Every
//     OTHER Applied candidate is HR/HM's day-to-day job, not Leadership's,
//     so this is genuinely "their own" rather than "everything" or
//     "nothing".
export default function MyTasks() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isHiringManager = user?.persona === 'hiring_manager';
  const isLeadership    = user?.persona === 'leadership';
  // Every persona sees SOME slice of "Ready for review" now (HR/Admin/Super
  // Admin: everyone; Hiring Manager: own roles; Leadership: Founder-flagged
  // only) — there's no persona left to hide this section from entirely, so
  // unlike ownRoleIds below there's no visibility gate left to compute here.

  const [feedbackRound, setFeedbackRound] = useState<(InterviewRound & { candidate_name?: string; role_title?: string }) | null>(null);
  const [searchInput, setSearchInput] = usePersistedState('mytasks.search', '');
  const [search,      setSearch]      = useState(searchInput);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [rejectTargetIds, setRejectTargetIds] = useState<string[] | null>(null);
  const [budgetExceptionIds, setBudgetExceptionIds] = useState<string[] | null>(null);
  const [bulkSaving, setBulkSaving] = useState(false);

  // Only fetched for a Hiring Manager — the one persona whose "Ready for
  // review" scope depends on which roles are actually theirs.
  const { data: ownRolesData, isSuccess: ownRolesLoaded } =
    useQuery<{ data: { roles: Role[] } }>({
      queryKey: ['my-tasks-own-roles', user?.name],
      queryFn:  () => rolesApi.list(),
      enabled:  isHiringManager,
    });
  const ownRoleIds = useMemo(() => {
    if (!isHiringManager) return [];
    const mine = (ownRolesData?.data?.roles || []).filter(
      r => (r.hiring_manager_name || '').trim().toLowerCase() === (user?.name || '').trim().toLowerCase()
    );
    return mine.length ? mine.map(r => r.id) : [NO_ROLES_OWNED_SENTINEL];
  }, [isHiringManager, ownRolesData, user?.name]);

  // Every applicant is scored by ResumeIQ automatically and can be
  // shortlisted directly from Applied — this IS the "ready for review"
  // signal now (no separate screening-status gate, no Resume Review stage).
  // status=Active is what makes Hold-for-Future/Reject actually remove a
  // candidate from this list; Shortlist removes them via the stage filter.
  const { data: awaitingData, isLoading: loadingAwaiting, refetch: refetchAwaiting } =
    useQuery<{ data: { applications: Application[] } }>({
      queryKey: ['my-tasks-awaiting', isHiringManager, ownRoleIds, isLeadership],
      queryFn:  () => applicationsApi.list({
        stage: 'Applied and Screened', status: 'Active',
        ...(isHiringManager ? { role_id: ownRoleIds } : {}),
        ...(isLeadership ? { founder_flag: 'true' } : {}),
      }),
      enabled: !isHiringManager || ownRolesLoaded,
    });

  // Pending actions for the current user (feedback due etc.) — already
  // persona-scoped server-side (see GET /dashboard/pending).
  const { data: pendingData, isLoading: loadingPending, refetch: refetchPending } =
    useQuery<{ data: { actions: PendingAction[] } }>({
      queryKey: ['my-tasks-pending'],
      queryFn:  () => dashboardApi.pending(),
    });

  const awaiting    = awaitingData?.data?.applications || [];
  const allPending  = pendingData?.data?.actions || [];
  const feedbackDue = allPending.filter(a =>
    a.action_type.toLowerCase().includes('feedback') ||
    a.action_type.toLowerCase().includes('interview')
  );

  // Debounced client-side search over the (already-fetched) Ready-for-review
  // list — same 350ms feel as Candidates.tsx/ScorecardSummary.tsx's search,
  // just filtered in JS since this list isn't paginated server-side.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 350);
    return () => clearTimeout(t);
  }, [searchInput]);
  const searchLower = search.trim().toLowerCase();
  const awaitingFiltered = searchLower
    ? awaiting.filter(a => `${a.candidate_name || ''} ${a.role_title || ''}`.toLowerCase().includes(searchLower))
    : awaiting;

  const isLoading = loadingAwaiting || loadingPending;

  const refreshQueue = () => {
    refetchAwaiting();
    qc.invalidateQueries({ queryKey: ['my-tasks-pending'] });
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string) => setSelectedIds(prev => {
    const s = new Set(prev);
    s.has(id) ? s.delete(id) : s.add(id);
    return s;
  });
  const allSelected  = awaitingFiltered.length > 0 && awaitingFiltered.every(a => selectedIds.has(a.id));
  const toggleSelectAll = () => setSelectedIds(prev => {
    const s = new Set(prev);
    awaitingFiltered.forEach(a => allSelected ? s.delete(a.id) : s.add(a.id));
    return s;
  });

  // Same chunked Promise.allSettled pattern as Candidates.tsx's bulk
  // actions — each single-ID call already exists and is unchanged.
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
    refreshQueue();
  };

  // 15%+ over-budget candidates need an explicit reason before shortlisting
  // (backend enforces this too). One shared reason applies to the whole
  // batch when bulk-acting, same as bulk Reject's single reason-for-the-batch
  // pattern.
  const shortlistIds = async (ids: string[], reasonCat?: string, reasonDetail?: string) => {
    const opts = { budgetExceptionReasonCat: reasonCat, budgetExceptionReasonDetail: reasonDetail };
    if (ids.length === 1) {
      try {
        await applicationsApi.advanceStage(ids[0], 'Interview Round 1', opts);
        toast.success('Candidate shortlisted');
        refreshQueue();
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
    // client-side — that field is stripped for this exact persona (Hiring
    // Manager), so a client-side re-derivation always came back false,
    // meaning the modal never opened and the shortlist attempt hit the
    // backend's 400 with no way to ever supply a reason.
    const anyOverBudget = awaiting.some(a => ids.includes(a.id) && a.is_severely_over_budget);
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

  const bulkShortlist    = () => requestShortlist(Array.from(selectedIds));
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
    refreshQueue();
  };

  // When a feedback action is clicked — we need a round object
  // Since pending actions don't carry round details, open candidate detail instead
  const handleFeedbackAction = (action: PendingAction) => {
    if (!action.application_id) return;
    // We create a minimal round stub — in practice user navigates to candidate detail
    // for the full feedback form
    toast('Opening candidate profile — submit feedback from the interview rounds section', {
      icon: 'ℹ️',
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-gray-900">My Tasks</h1>
        <p className="text-sm text-gray-400 mt-1">
          {isLeadership
            ? 'Founder-flagged candidates awaiting a shortlist decision, and feedback due from you'
            : 'Candidates awaiting your shortlist decision and feedback due from you'}
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-12"><Spinner size="lg" /></div>
      ) : (
        <div className="space-y-6">
          {/* ── Section 1: Ready for review — every persona sees a scoped
               slice now (HR/Admin/Super Admin: everyone; Hiring Manager: own
               roles; Leadership: Founder-flagged only), see the note above
               the component. ─────────────────────────────────────────────── */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                {awaitingFiltered.length > 0 && (
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    title="Select all"
                  />
                )}
                <div>
                  <h2 className="text-sm font-semibold text-gray-900">Ready for review</h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {isHiringManager
                      ? "Candidates who've applied to your role(s) — shortlist, hold for future, or reject"
                      : isLeadership
                      ? 'Founder-flagged candidates who\'ve applied — shortlist, hold for future, or reject'
                      : "Candidates who've applied — shortlist, hold for future, or reject"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search candidate or role…"
                    value={searchInput}
                    onChange={e => setSearchInput(e.target.value)}
                    className="input text-xs pl-8 py-1.5 w-48"
                  />
                </div>
                <span className={`text-xs font-semibold font-mono px-2.5 py-1 rounded-full whitespace-nowrap ${
                  awaiting.length === 0
                    ? 'bg-gray-100 text-gray-500'
                    : 'bg-amber-100 text-amber-700'
                }`}>
                  {awaiting.length} pending
                </span>
              </div>
            </div>

            {selectedIds.size > 0 && (
              <div className="px-5 py-2.5 bg-dp-50 border-b border-dp-100 flex items-center gap-3">
                <span className="text-xs font-medium font-mono text-dp-700">{selectedIds.size} selected</span>
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

            {awaitingFiltered.length === 0 ? (
              <div className="p-8">
                <EmptyState
                  title={awaiting.length === 0 ? 'All caught up' : 'No matches'}
                  message={awaiting.length === 0
                    ? (isLeadership
                        ? 'No Founder-flagged candidates awaiting a shortlist decision.'
                        : 'No candidates awaiting your shortlist decision.')
                    : 'No candidates match this search.'}
                />
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {awaitingFiltered.map(app => (
                  <ShortlistRow
                    key={app.id}
                    app={app as Application & { candidate_name?: string; role_title?: string }}
                    selected={selectedIds.has(app.id)}
                    onToggleSelect={() => toggleSelected(app.id)}
                    onReject={() => setRejectTargetIds([app.id])}
                    onAction={refreshQueue}
                    onShortlist={() => requestShortlist([app.id])}
                  />
                ))}
              </div>
            )}
          </div>

          {/* ── Section 2: Feedback due ──────────────────────────────────────── */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Feedback due</h2>
                <p className="text-xs text-gray-400 mt-0.5">Interview rounds awaiting your feedback</p>
              </div>
              <span className={`text-xs font-semibold font-mono px-2.5 py-1 rounded-full ${
                feedbackDue.length === 0
                  ? 'bg-gray-100 text-gray-500'
                  : feedbackDue.some(a => a.hours_overdue > 0)
                    ? 'bg-red-100 text-red-700'
                    : 'bg-amber-100 text-amber-700'
              }`}>
                {feedbackDue.length} pending
              </span>
            </div>

            {feedbackDue.length === 0 ? (
              <div className="p-8">
                <EmptyState
                  title="No feedback pending"
                  message="All interview feedback is up to date."
                />
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {feedbackDue.map(action => (
                  <FeedbackRow
                    key={action.id}
                    action={action}
                    onFeedback={handleFeedbackAction}
                  />
                ))}
                <div className="px-5 py-3 bg-blue-50/50">
                  <p className="text-xs text-blue-600">
                    💡 To submit feedback, open the candidate profile and expand the application — the feedback form is in the Interview Rounds section.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* ── All pending actions ──────────────────────────────────────────── */}
          {allPending.filter(a => !feedbackDue.includes(a)).length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100">
                <h2 className="text-sm font-semibold text-gray-900">Other pending actions</h2>
              </div>
              <div className="divide-y divide-gray-50">
                {allPending.filter(a => !feedbackDue.includes(a)).map(action => (
                  <div key={action.id} className="px-5 py-3 flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-gray-300 mt-2 shrink-0" />
                    <div>
                      <p className="text-xs font-medium text-gray-700">{action.action_type}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{action.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {feedbackRound && (
        <InterviewFeedbackModal
          round={feedbackRound}
          onClose={() => setFeedbackRound(null)}
          onSuccess={() => {
            refetchPending();
            qc.invalidateQueries({ queryKey: ['interview-rounds'] });
          }}
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
