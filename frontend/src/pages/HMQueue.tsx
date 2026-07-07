import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, XCircle, MessageSquare, Clock, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { applicationsApi, dashboardApi } from '../services/api.ts';
import { Application, PendingAction, InterviewRound } from '../types/index.ts';
import { StageBadge, FitScore, PriorityBadge, Spinner, EmptyState } from '../components/shared/Badges.tsx';
import InterviewFeedbackModal from '../components/InterviewFeedbackModal.tsx';
import { formatDistanceToNow } from 'date-fns';

// ─── Shortlist decision row ───────────────────────────────────────────────────
function ShortlistRow({
  app,
  onAction,
}: {
  app: Application & { candidate_name?: string; role_title?: string };
  onAction: () => void;
}) {
  const [acting, setActing] = useState(false);

  const act = async (status: 'HM Shortlisted' | 'Screening Hold') => {
    setActing(true);
    try {
      await applicationsApi.updateScreening(app.id, status);
      toast.success(status === 'HM Shortlisted' ? 'Candidate shortlisted' : 'Put on hold');
      onAction();
    } catch { toast.error('Action failed'); }
    setActing(false);
  };

  const waitingHours = app.stage_entry_time
    ? Math.round((Date.now() - new Date(app.stage_entry_time).getTime()) / 3600000)
    : null;

  return (
    <div className="flex items-center gap-4 p-4 hover:bg-gray-50 transition-colors">
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
          {app.ectc && <span>· ECTC ₹{app.ectc}L</span>}
          {app.notice_period_days != null && <span>· {app.notice_period_days}d notice</span>}
          {waitingHours != null && (
            <span className={waitingHours > 48 ? 'text-red-500 font-medium' : ''}>
              · Waiting {waitingHours}h
              {waitingHours > 48 && ' ⚠️'}
            </span>
          )}
        </div>
        {app.ai_score_summary && (
          <p className="text-xs text-gray-500 mt-1 line-clamp-1 italic">"{app.ai_score_summary}"</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 shrink-0">
        <button
          onClick={() => act('Screening Hold')}
          disabled={acting}
          title="Put on hold"
          className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
        >
          <XCircle className="w-4 h-4" />
        </button>
        <button
          onClick={() => act('HM Shortlisted')}
          disabled={acting}
          className="flex items-center gap-1.5 btn-primary text-xs py-1.5 px-3"
        >
          {acting ? <Spinner size="sm" /> : <CheckCircle className="w-3.5 h-3.5" />}
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
            <span className="text-red-500 font-medium">
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
export default function HMQueue() {
  const qc = useQueryClient();
  const [feedbackRound, setFeedbackRound] = useState<(InterviewRound & { candidate_name?: string; role_title?: string }) | null>(null);

  // Candidates awaiting HM shortlist decision
  const { data: awaitingData, isLoading: loadingAwaiting, refetch: refetchAwaiting } =
    useQuery<{ data: { applications: Application[] } }>({
      queryKey: ['hm-queue-awaiting'],
      queryFn:  () => applicationsApi.list({ screening_status: 'Awaiting HM Review' }),
    });

  // Pending actions for the current user (feedback due etc.)
  const { data: pendingData, isLoading: loadingPending, refetch: refetchPending } =
    useQuery<{ data: { actions: PendingAction[] } }>({
      queryKey: ['hm-queue-pending'],
      queryFn:  () => dashboardApi.pending(),
    });

  const awaiting    = awaitingData?.data?.applications || [];
  const allPending  = pendingData?.data?.actions || [];
  const feedbackDue = allPending.filter(a =>
    a.action_type.toLowerCase().includes('feedback') ||
    a.action_type.toLowerCase().includes('interview')
  );

  const isLoading = loadingAwaiting || loadingPending;

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
        <h1 className="text-xl font-semibold text-gray-900">My Queue</h1>
        <p className="text-sm text-gray-400 mt-1">Candidates awaiting your decision and feedback due from you</p>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-12"><Spinner size="lg" /></div>
      ) : (
        <div className="space-y-6">
          {/* ── Section 1: Shortlist decisions ──────────────────────────────── */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Shortlist decisions</h2>
                <p className="text-xs text-gray-400 mt-0.5">Candidates HR has screened — shortlist or hold</p>
              </div>
              <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                awaiting.length === 0
                  ? 'bg-gray-100 text-gray-500'
                  : 'bg-amber-100 text-amber-700'
              }`}>
                {awaiting.length} pending
              </span>
            </div>

            {awaiting.length === 0 ? (
              <div className="p-8">
                <EmptyState
                  title="All caught up"
                  message="No candidates awaiting your shortlist decision."
                />
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {awaiting.map(app => (
                  <ShortlistRow
                    key={app.id}
                    app={app as Application & { candidate_name?: string; role_title?: string }}
                    onAction={() => {
                      refetchAwaiting();
                      qc.invalidateQueries({ queryKey: ['hm-queue-pending'] });
                    }}
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
              <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
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
    </div>
  );
}
