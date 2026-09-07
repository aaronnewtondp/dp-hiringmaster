import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, MessageSquare, Clock, AlertCircle, ListChecks } from 'lucide-react';
import toast from 'react-hot-toast';
import { dashboardApi, rolesApi } from '../services/api.ts';
import { PendingAction, InterviewRound, Role } from '../types/index.ts';
import { Spinner, EmptyState } from '../components/shared/Badges.tsx';
import InterviewFeedbackModal from '../components/InterviewFeedbackModal.tsx';
import ScorecardSummary from './ScorecardSummary.tsx';
import { usePersistedState } from '../hooks/usePersistedState.ts';
import { useAuth } from '../contexts/AuthContext.tsx';
import { formatDistanceToNow } from 'date-fns';

// Sentinel role_id used when a Hiring Manager owns no roles at all — mirrors
// applyHiringManagerRoleLock's own backend convention (roleFilters.ts) so an
// empty owned-role set reliably yields zero rows via `r.id = ANY($n)` rather
// than an unfiltered (i.e. everyone else's) result.
const NO_ROLES_OWNED_SENTINEL = '__no_roles_owned__';

type Section = 'ready' | 'feedback' | 'other';

// ─── Section selector box ─────────────────────────────────────────────────────
function SectionBox({ label, count, active, onClick, icon: Icon, accent }: {
  label: string; count: number; active: boolean; onClick: () => void;
  icon: React.ElementType; accent?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 min-w-[180px] card p-4 text-left transition-all border-2 ${
        active ? 'border-dp-500 ring-1 ring-dp-500' : 'border-transparent hover:border-gray-200'
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <Icon className={`w-4 h-4 shrink-0 ${accent || 'text-gray-400'}`} />
        <span className="text-xs font-medium text-gray-500">{label}</span>
      </div>
      <div className="text-2xl font-mono font-bold text-gray-900">{count}</div>
    </button>
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
// Merged with the standalone Scorecard Summary page (2026-09-05) — "Ready for
// review" now renders that same table/filters/actions, embedded, scoped per
// persona exactly as this page's old compact list already was:
//   - HR/Admin & Super Admin: every scored candidate, unfiltered — there's no
//     per-recruiter ownership field on roles to split this further, and
//     screening oversight company-wide genuinely IS HR's own job function.
//   - Hiring Manager: only candidates on the role(s) they're the hiring
//     manager for — scoped the same way applyHiringManagerRoleLock
//     (backend, roleFilters.ts) already scopes their Dashboard: matching
//     roles.hiring_manager_name against their own name.
//   - Leadership: only candidates flagged for Founder Review — the one
//     existing Leadership-specific concept tied to individual applications.
// Feedback due / Other pending actions are unchanged in logic, UI, and
// permissions — only how they're shown changed (one selected section at a
// time via the boxes above, instead of all three always stacked).
export default function MyTasks() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const isHiringManager = user?.persona === 'hiring_manager';
  const isLeadership    = user?.persona === 'leadership';

  const [section, setSection] = usePersistedState<Section>('mytasks.section', 'ready');
  const [readyCount, setReadyCount] = useState(0);

  // Arriving via RoleDetail's "Scorecard Summary" button (?role_id=...) is an
  // explicit, deliberate intent to see that role's scorecard — override
  // whatever section was last persisted.
  useEffect(() => {
    if (searchParams.get('role_id')) setSection('ready');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [feedbackRound, setFeedbackRound] = useState<(InterviewRound & { candidate_name?: string; role_title?: string }) | null>(null);

  // Only fetched for a Hiring Manager — the one persona whose "Ready for
  // review" scope depends on which roles are actually theirs.
  const { data: ownRolesData } =
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

  const personaScope = isHiringManager
    ? { ownRoleIds }
    : isLeadership
    ? { founderFlagOnly: true }
    : undefined;

  // Pending actions for the current user (feedback due etc.) — already
  // persona-scoped server-side (see GET /dashboard/pending).
  const { data: pendingData, isLoading: loadingPending, refetch: refetchPending } =
    useQuery<{ data: { actions: PendingAction[] } }>({
      queryKey: ['my-tasks-pending'],
      queryFn:  () => dashboardApi.pending(),
    });

  const allPending  = pendingData?.data?.actions || [];
  const feedbackDue = allPending.filter(a =>
    a.action_type.toLowerCase().includes('feedback') ||
    a.action_type.toLowerCase().includes('interview')
  );
  const otherPending = allPending.filter(a => !feedbackDue.includes(a));

  const handleFeedbackAction = (action: PendingAction) => {
    if (!action.application_id) return;
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
            ? 'Founder-flagged candidates awaiting a shortlist decision, feedback due from you, and everything else pending'
            : 'Candidates awaiting your shortlist decision, feedback due from you, and everything else pending'}
        </p>
      </div>

      {/* Section selector */}
      <div className="flex gap-3 flex-wrap">
        <SectionBox
          label="Ready for Review"
          count={readyCount}
          active={section === 'ready'}
          onClick={() => setSection('ready')}
          icon={ClipboardList}
          accent="text-dp-600"
        />
        <SectionBox
          label="Feedback Due"
          count={feedbackDue.length}
          active={section === 'feedback'}
          onClick={() => setSection('feedback')}
          icon={Clock}
          accent={feedbackDue.some(a => a.hours_overdue > 0) ? 'text-red-500' : 'text-amber-500'}
        />
        <SectionBox
          label="Other Pending Actions"
          count={otherPending.length}
          active={section === 'other'}
          onClick={() => setSection('other')}
          icon={ListChecks}
        />
      </div>

      {section === 'ready' && (
        <ScorecardSummary personaScope={personaScope} onCountChange={setReadyCount} />
      )}

      {section === 'feedback' && (
        loadingPending ? (
          <div className="flex justify-center p-12"><Spinner size="lg" /></div>
        ) : (
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-900">Feedback due</h2>
              <p className="text-xs text-gray-400 mt-0.5">Interview rounds awaiting your feedback</p>
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
        )
      )}

      {section === 'other' && (
        loadingPending ? (
          <div className="flex justify-center p-12"><Spinner size="lg" /></div>
        ) : (
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-900">Other pending actions</h2>
            </div>
            {otherPending.length === 0 ? (
              <div className="p-8"><EmptyState title="Nothing else pending ✓" /></div>
            ) : (
              <div className="divide-y divide-gray-50">
                {otherPending.map(action => (
                  <div key={action.id} className="px-5 py-3 flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-gray-300 mt-2 shrink-0" />
                    <div>
                      <p className="text-xs font-medium text-gray-700">{action.action_type}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{action.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
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
