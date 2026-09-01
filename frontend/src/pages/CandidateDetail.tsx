import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Star, ChevronDown, ChevronUp, CalendarPlus, MessageSquare, FileText, Send, Link2, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import { candidatesApi, applicationsApi, interviewsApi, refChecksApi, agenciesApi } from '../services/api.ts';
import { Candidate, Application, InterviewRound, ReferenceCheck, Agency, REJECTION_REASONS, WITHDRAWAL_REASONS, RECRUITMENT_CHANNELS } from '../types/index.ts';
import { StageBadge, StatusBadge, PriorityBadge, OverBudgetBadge, Spinner, EmptyState } from '../components/shared/Badges.tsx';
import PipelineProgress from '../components/shared/PipelineProgress.tsx';
import { isOverBudget } from '../utils/budget.ts';
import EditableSection from '../components/shared/EditableSection.tsx';
import StageChangeModal from '../components/shared/StageChangeModal.tsx';
import ResumeIQPanel from '../components/ResumeIQPanel.tsx';
import InterviewFeedbackModal from '../components/InterviewFeedbackModal.tsx';
import ScheduleRoundModal from '../components/ScheduleRoundModal.tsx';
import SendAssignmentModal from '../components/SendAssignmentModal.tsx';
import AssignmentOutcomeModal from '../components/AssignmentOutcomeModal.tsx';
import AddReferenceCheckModal from '../components/AddReferenceCheckModal.tsx';
import LinkToRoleModal from '../components/shared/LinkToRoleModal.tsx';
import { useAuth } from '../contexts/AuthContext.tsx';
import { formatDistanceToNow, format } from 'date-fns';

// Screening & Risk Notes stays collapsed by default (item #10) unless it
// already has something in it — once a note exists it should just be
// visible, not hidden behind an extra click every time the page loads.
function hasScreeningNotes(app: Application): boolean {
  return !!(
    app.hr_recruiter_summary || app.hr_key_positives || app.hr_key_concerns ||
    app.hr_comp_alignment || app.hr_communication_assessment ||
    app.hr_priority_override || app.hr_priority_override_reason ||
    (app.hr_tags && app.hr_tags.length > 0) || app.internal_risk_notes
  );
}

function FeedbackBadge({ status }: { status: string }) {
  if (status === 'Submitted') return <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">Submitted</span>;
  if (status === 'Overdue') return <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium animate-pulse">Overdue</span>;
  return <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">Pending</span>;
}

// Mirrors slaChecker.ts's checkAssignmentDeadlines() 3-condition check so the
// UI never disagrees with what actually creates the "deadline breached"
// pending action: sent, not yet submitted, deadline passed.
function AssignmentStatusPill({ round }: { round: InterviewRound }) {
  if (!round.assignment_send_date || round.assignment_submission_date) return null;
  const overdue = !!round.assignment_deadline && new Date(round.assignment_deadline) < new Date();
  if (overdue) {
    return <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium animate-pulse">Overdue</span>;
  }
  return (
    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
      Due {round.assignment_deadline ? format(new Date(round.assignment_deadline), 'MMM d, h:mm a') : '—'}
    </span>
  );
}

// Round-scheduling is gated by the application's current stage — Standard
// interview rounds can only be created while sitting in one of these three
// stages; Assignment rounds only from 'Assignment Round' (checked inline
// below). This is what makes the "Schedule round"/"Send Assignment"
// controls appear/disappear as the stage moves, instead of always showing.
const INTERVIEW_STAGES = ['Interview Round 1', 'Interview Round 2', 'Founders Round'];

// Drives SendAssignmentModal — either freshly creating+sending (mode
// 'create', no roundId yet) or retrying a round whose send previously
// failed (mode 'retry', prefilled from that round's own persisted values).
interface AssignmentModalState {
  mode:                   'create' | 'retry';
  applicationId:          string;
  roundId?:               string;
  roleId:                 string;
  nextRoundNumber?:       number;
  candidateName:          string;
  roleTitle:              string;
  candidateEmail?:        string;
  initialMailBody?:       string;
  initialCc?:             string;
  initialAssignmentLink?: string;
  initialSupportingDocs?: string;
}

export default function CandidateDetail() {
  const { id } = useParams<{ id: string }>();
  const { canHR, user } = useAuth();
  const qc = useQueryClient();

  const [stageModalApp, setStageModalApp] = useState<Application | null>(null);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [selectedAppId, setSelectedAppId] = useState('');
  const [statusValue, setStatusValue] = useState('');
  const [rejectionCat, setRejectionCat] = useState('');
  const [rejectionDetail, setRejectionDetail] = useState('');
  const [viewingRejection, setViewingRejection] = useState<{ cat?: string; detail?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const [showFounderModal, setShowFounderModal] = useState(false);
  const [founderAppId, setFounderAppId] = useState('');
  const [founderSetTo, setFounderSetTo] = useState(true);
  const [founderNote, setFounderNote] = useState('');

  const [feedbackRound, setFeedbackRound] = useState<(InterviewRound & { candidate_name?: string; role_title?: string }) | null>(null);
  const [outcomeRound, setOutcomeRound] = useState<(InterviewRound & { candidate_name?: string; role_title?: string }) | null>(null);
  const [scheduleAppId, setScheduleAppId] = useState<string | null>(null);
  const [scheduleNextNum, setScheduleNextNum] = useState(1);
  const [scheduleDefaultName, setScheduleDefaultName] = useState('');
  const [expandedApps, setExpandedApps] = useState<Set<string>>(new Set());
  // Full submitted feedback (strengths/concerns/notes/per-area scores) is
  // otherwise only ever visible inside the submission modal — this expands
  // a round's row in place to show it read-only, mirroring expandedApps'
  // toggle pattern one level down.
  const [expandedRounds, setExpandedRounds] = useState<Set<string>>(new Set());
  const [showAddApplication, setShowAddApplication] = useState(false);
  // Screening & Risk Notes no longer shows by default (item #10) — most
  // applications never have anything in it, so it read as visual clutter on
  // every expanded application. An "Add HR Screening Notes" button reveals
  // it on demand instead; once a note exists it should just be visible, not
  // hidden behind an extra click every time the page loads.
  const [screeningNotesOpen, setScreeningNotesOpen] = useState<Set<string>>(new Set());

  const [assignmentModal, setAssignmentModal] = useState<AssignmentModalState | null>(null);

  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [submitRoundId, setSubmitRoundId] = useState('');
  const [submitLink, setSubmitLink] = useState('');
  const [addRefCheckAppId, setAddRefCheckAppId] = useState<string | null>(null);

  const toggleApp = (appId: string) =>
    setExpandedApps(prev => {
      const s = new Set(prev);
      s.has(appId) ? s.delete(appId) : s.add(appId);
      return s;
    });

  const toggleRound = (roundId: string) =>
    setExpandedRounds(prev => {
      const s = new Set(prev);
      s.has(roundId) ? s.delete(roundId) : s.add(roundId);
      return s;
    });

  const { data, isLoading } = useQuery<{ data: { candidate: Candidate; applications: Application[] } }>({
    queryKey: ['candidate', id],
    queryFn: () => candidatesApi.get(id!),
  });

  const { data: actData } = useQuery<{ data: { activity: unknown[] } }>({
    queryKey: ['candidate-activity', id],
    queryFn: () => candidatesApi.activity(id!),
  });

  const candidate = data?.data?.candidate;
  const applications = data?.data?.applications || [];
  const activity = actData?.data?.activity || [];

  // Mirrors the backend's own canSeeCompForRole exactly (auth.ts) — the
  // fields themselves are already stripped server-side for anyone this
  // doesn't apply to, so this is only about not rendering a Compensation
  // section that has nothing real behind it. A candidate can have
  // applications to several roles, so this is true if ANY of them is a role
  // this Hiring Manager is assigned to.
  const canSeeComp = canHR || applications.some(app =>
    user?.persona === 'hiring_manager' &&
    !!app.hiring_manager_name &&
    app.hiring_manager_name.trim().toLowerCase() === user.name.trim().toLowerCase()
  );

  // Applications section starts expanded by default (was collapsed) —
  // seeded once per candidate load, keyed off candidate.id rather than
  // `applications` itself, so a later refetch (e.g. after a stage change)
  // doesn't fight a manual collapse the user made after the page loaded.
  useEffect(() => {
    if (candidate?.id && applications.length > 0) {
      setExpandedApps(new Set(applications.map(a => a.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate?.id]);

  // Agency list is HR-tier only server-side — only fetched for personas
  // that can actually use it, so a Hiring Manager viewing this page never
  // fires a request that's guaranteed to 403.
  const { data: agenciesData } = useQuery<{ data: { agencies: Agency[] } }>({
    queryKey: ['agencies'],
    queryFn: () => agenciesApi.list(),
    enabled: canHR,
  });
  const agencies = agenciesData?.data?.agencies || [];

  const { data: roundsMap, refetch: refetchRounds } = useQuery<Record<string, InterviewRound[]>>({
    queryKey: ['interview-rounds', applications.map(a => a.id).join(',')],
    queryFn: async () => {
      if (!applications.length) return {};
      const results = await Promise.all(applications.map(a => interviewsApi.list(a.id)));
      const map: Record<string, InterviewRound[]> = {};
      applications.forEach((a, i) => {
        map[a.id] = (results[i] as { data: { rounds: InterviewRound[] } }).data.rounds || [];
      });
      return map;
    },
    enabled: applications.length > 0,
  });

  const { data: refChecksMap, refetch: refetchRefChecks } = useQuery<Record<string, ReferenceCheck[]>>({
    queryKey: ['ref-checks', applications.map(a => a.id).join(',')],
    queryFn: async () => {
      if (!applications.length) return {};
      const results = await Promise.all(applications.map(a => refChecksApi.list(a.id)));
      const map: Record<string, ReferenceCheck[]> = {};
      applications.forEach((a, i) => {
        map[a.id] = (results[i] as { data: { ref_checks: ReferenceCheck[] } }).data.ref_checks || [];
      });
      return map;
    },
    enabled: applications.length > 0,
  });

  const saveCandidateFields = async (changes: Record<string, unknown>) => {
    await candidatesApi.update(id!, changes);
    qc.invalidateQueries({ queryKey: ['candidate', id] });
  };

  const saveApplicationNotes = async (appId: string, changes: Record<string, unknown>) => {
    await applicationsApi.updateNotes(appId, changes);
    qc.invalidateQueries({ queryKey: ['candidate', id] });
  };

  const handleFounderFlag = async () => {
    setSaving(true);
    try {
      await applicationsApi.setFounderFlag(founderAppId, founderSetTo, founderNote || undefined);
      toast.success(founderSetTo ? 'Flagged for Founder Review' : 'Founder Review flag cleared');
      setShowFounderModal(false);
      qc.invalidateQueries({ queryKey: ['candidate', id] });
    } catch { toast.error('Failed to update Founder Review flag'); }
    setSaving(false);
  };

  const handleSubmitAssignment = async () => {
    if (!submitLink.trim()) { toast.error('Submission link is required'); return; }
    setSaving(true);
    try {
      await interviewsApi.submitAssignment(submitRoundId, submitLink.trim());
      toast.success('Submission recorded');
      setShowSubmitModal(false);
      qc.invalidateQueries({ queryKey: ['interview-rounds'] });
      refetchRounds();
    } catch { toast.error('Failed to record submission'); }
    setSaving(false);
  };

  const handleStatusUpdate = async () => {
    if (!selectedAppId || !statusValue) return;
    if ((statusValue === 'Rejected' || statusValue === 'Withdrawn') && !rejectionCat) {
      toast.error('A reason is required'); return;
    }
    setSaving(true);
    try {
      await applicationsApi.updateStatus(selectedAppId, {
        new_status: statusValue,
        rejection_reason_cat: rejectionCat || undefined,
        rejection_reason_detail: rejectionDetail || undefined,
      });
      toast.success(`Status updated to ${statusValue}`);
      setShowStatusModal(false);
      qc.invalidateQueries({ queryKey: ['candidate', id] });
      // Status drives inclusion on Scorecard Summary/My Tasks/Talent Pool —
      // those live on the shared 'applications' key, not this page's own.
      qc.invalidateQueries({ queryKey: ['applications'] });
    } catch { toast.error('Failed to update status'); }
    setSaving(false);
  };

  if (isLoading) return <div className="flex justify-center p-12"><Spinner size="lg" /></div>;
  if (!candidate) return <EmptyState title="Candidate not found" />;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/candidates" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-3">
          <ArrowLeft className="w-4 h-4" /> Candidates
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-full bg-dp-100 flex items-center justify-center text-dp-700 font-semibold text-lg">
              {candidate.full_name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1">
              <h1 className="text-xl font-semibold text-gray-900">{candidate.full_name}</h1>
              <div className="flex items-center gap-3 mt-1 text-sm text-gray-500 flex-wrap">
                {candidate.email && <span>{candidate.email}</span>}
                {candidate.phone && <><span>·</span><span>{candidate.phone}</span></>}
                {candidate.linkedin_url && (
                  <a href={candidate.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-dp-600 hover:underline flex items-center gap-1">
                    <ExternalLink className="w-3 h-3" /> LinkedIn
                  </a>
                )}
                {candidate.resume_drive_link && (
                  <a href={candidate.resume_drive_link} target="_blank" rel="noopener noreferrer" className="text-dp-600 hover:underline flex items-center gap-1">
                    <FileText className="w-3 h-3" /> Resume
                  </a>
                )}
              </div>
              <div className="flex gap-2 mt-2 flex-wrap">
                {(candidate.hr_tags || []).map(tag => (
                  <span key={tag} className="px-2 py-0.5 rounded-full text-xs bg-dp-50 text-dp-700 font-medium">{tag}</span>
                ))}
              </div>
            </div>
          </div>
          {/* Stage/Status moved to the top-right of the page (item #11) for
              the common one-application case, rather than requiring a
              scroll down to that application's own row. A candidate with
              more than one application has no single unambiguous "the"
              stage to act on from here, so those keep their per-row
              buttons further down instead. */}
          {canHR && applications.length === 1 && (
            <div className="flex gap-2 shrink-0">
              <button onClick={() => setStageModalApp(applications[0])} className="btn-secondary text-xs py-1.5 px-3">Stage</button>
              <button onClick={() => { setSelectedAppId(applications[0].id); setStatusValue(applications[0].status); setShowStatusModal(true); }} className="btn-secondary text-xs py-1.5 px-3">Status</button>
            </div>
          )}
        </div>
      </div>

      {applications.length > 0 && (
        <div className="space-y-3">
          {applications.map(app => (
            <PipelineProgress
              key={app.id}
              stage={app.stage}
              label={applications.length > 1 ? app.role_title : undefined}
            />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="space-y-4">
          <EditableSection
            title="Identity"
            data={candidate}
            onSave={saveCandidateFields}
            fields={[
              { key: 'full_name', label: 'Full Name', type: 'text' },
              { key: 'email', label: 'Email', type: 'text' },
              { key: 'phone', label: 'Phone', type: 'text' },
              { key: 'linkedin_url', label: 'LinkedIn', type: 'text', linkify: true },
              {
                key: 'source', label: 'Source', type: 'select',
                options: ['', ...RECRUITMENT_CHANNELS],
                optionLabels: { '': 'Not specified' },
              },
              {
                key: 'sourced_by_agency_id', label: 'Sourcing Agency', type: 'select',
                options: ['', ...agencies.map(a => a.id)],
                optionLabels: { '': 'Select agency…', ...Object.fromEntries(agencies.map(a => [a.id, a.name])) },
                dependsOn: { key: 'source', value: 'Agency' },
                requiredWhenVisible: true,
                displayKey: 'sourced_by_agency_name',
              },
            ]}
          />
          <EditableSection
            title="Current Role"
            data={{ ...candidate, preferred_location: applications[0]?.preferred_location }}
            onSave={async (changes) => {
              // preferred_location lives on the application, not the
              // candidate (it can differ per role someone applies to) — so
              // it has to be split off and saved through the application's
              // own endpoint, against the candidate's primary (first)
              // application, while every other field here is a real
              // candidate-level column saved the normal way.
              const { preferred_location, ...candidateChanges } = changes;
              if (Object.keys(candidateChanges).length > 0) await saveCandidateFields(candidateChanges);
              if (preferred_location !== undefined && applications[0]) {
                await saveApplicationNotes(applications[0].id, { preferred_location });
              }
            }}
            fields={[
              { key: 'current_company', label: 'Company', type: 'text' },
              { key: 'current_designation', label: 'Designation', type: 'text' },
              { key: 'current_industry', label: 'Industry', type: 'text' },
              { key: 'current_location', label: 'Location', type: 'text' },
              { key: 'preferred_location', label: 'Preferred Location', type: 'text' },
              { key: 'years_of_experience', label: 'Experience (yrs)', type: 'number' },
              { key: 'languages_known', label: 'Languages Known', type: 'text' },
            ]}
          />
          <EditableSection
            title="Compensation"
            data={candidate}
            onSave={saveCandidateFields}
            fields={[
              { key: 'current_ctc_fixed', label: 'Current CTC (Fixed and Variable breakup) in LPA', type: 'number', hidden: !canSeeComp },
              { key: 'expected_ctc', label: 'Expected CTC', type: 'number', hidden: !canSeeComp },
              { key: 'notice_period_days', label: 'Notice Period (days)', type: 'number' },
            ]}
          />
          <EditableSection
            title="Resume & Tags"
            data={candidate}
            onSave={saveCandidateFields}
            fields={[
              { key: 'resume_drive_link', label: 'Resume Link', type: 'text', linkify: true },
              { key: 'hr_tags', label: 'HR Tags', type: 'tags' },
            ]}
          />
        </div>

        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">Applications ({applications.length})</h2>
            {canHR && (
              <button
                onClick={() => setShowAddApplication(true)}
                className="btn-secondary text-xs py-1.5 px-3"
              >
                <Plus className="w-3.5 h-3.5" /> Add Application
              </button>
            )}
          </div>
          {applications.length === 0 ? (
            <div className="p-8"><EmptyState title="No applications" /></div>
          ) : (
            <div className="divide-y divide-gray-50">
              {applications.map(app => {
                const rounds = roundsMap?.[app.id] || [];
                const refChecks = refChecksMap?.[app.id] || [];
                const expanded = expandedApps.has(app.id);
                // Same fallback pattern (and same source data) the Over
                // Budget badge below already uses for its own calculation —
                // shown right next to it so "Over Budget" is never a flag
                // with no visible figures to justify it (CLAUDE.md's
                // budget-flagging convention: consistent everywhere
                // compensation is surfaced). Naturally hides for a persona
                // these fields are stripped for, same as the badge does.
                const ctcFixed = app.candidate_ctc_fixed ?? candidate.current_ctc_fixed;
                const ectc = app.candidate_expected_ctc ?? candidate.expected_ctc;
                return (
                  <div key={app.id} className={`${app.sla_breach ? 'bg-red-50/30' : ''}`}>
                    <div className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Link to={`/roles/${app.role_id}`} className="font-medium text-gray-900 hover:text-dp-600 text-sm">{app.role_title}</Link>
                            {app.role_priority && <PriorityBadge priority={app.role_priority} />}
                            {app.sla_breach && <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-medium">SLA</span>}
                            {canHR ? (
                              <button
                                onClick={() => { setFounderAppId(app.id); setFounderSetTo(!app.founder_review_flag); setFounderNote(''); setShowFounderModal(true); }}
                                className={`text-xs px-1.5 py-0.5 rounded flex items-center gap-1 ${app.founder_review_flag ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-400 hover:bg-purple-50 hover:text-purple-600'}`}
                                title={app.founder_review_flag ? 'Clear Founder Review flag' : 'Flag for Founder Review'}
                              >
                                <Star className={`w-3 h-3 ${app.founder_review_flag ? 'fill-current' : ''}`} /> Founder
                              </button>
                            ) : app.founder_review_flag && (
                              <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded"><Star className="w-3 h-3 inline fill-current" /> Founder</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                            <StageBadge stage={app.stage} />
                            {app.status === 'Rejected' ? (
                              <button
                                onClick={() => setViewingRejection({ cat: app.rejection_reason_cat, detail: app.rejection_reason_detail })}
                                title="Click to see the rejection reason"
                              >
                                <StatusBadge status={app.status} />
                              </button>
                            ) : (
                              <StatusBadge status={app.status} />
                            )}
                            <span className="text-xs text-gray-400">{app.recruiter_screening_status}</span>
                            {app.score_avg != null && <span className="text-xs font-semibold text-dp-700">ResumeIQ: {Number(app.score_avg).toFixed(1)}/10</span>}
                            {(ctcFixed != null || ectc != null) && (
                              <span className="text-xs font-mono text-gray-500">
                                {ctcFixed ? `₹${ctcFixed}L` : '—'} → {ectc ? `₹${ectc}L` : '—'}
                              </span>
                            )}
                            <OverBudgetBadge overBudget={isOverBudget(ectc, app.role_ctc_band)} />
                          </div>
                          <div className="flex gap-3 mt-2 text-xs text-gray-400">
                            <span>Source: {app.source_channel || '—'}</span>
                            <span>Updated {formatDistanceToNow(new Date(app.last_updated), { addSuffix: true })}</span>
                            {rounds.length > 0 && <span>{rounds.length} round{rounds.length !== 1 ? 's' : ''}</span>}
                          </div>
                        </div>
                        <div className="flex gap-2 shrink-0 items-start">
                          {/* Single-application candidates get these buttons
                              at the page's top-right instead (item #11) —
                              only shown here when there's more than one
                              application to disambiguate between. */}
                          {canHR && applications.length > 1 && (
                            <>
                              <button onClick={() => setStageModalApp(app)} className="btn-secondary text-xs py-1.5 px-3">Stage</button>
                              <button onClick={() => { setSelectedAppId(app.id); setStatusValue(app.status); setShowStatusModal(true); }} className="btn-secondary text-xs py-1.5 px-3">Status</button>
                            </>
                          )}
                          <button onClick={() => toggleApp(app.id)} className="text-gray-400 hover:text-gray-600 p-1" title={expanded ? 'Collapse' : 'Expand details'}>
                            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>
                    </div>

                    {expanded && (
                      <div className="px-4 pb-4 space-y-4">
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Interview rounds</span>
                            {canHR && INTERVIEW_STAGES.includes(app.stage) && (
                              <button
                                onClick={() => {
                                  setScheduleAppId(app.id);
                                  setScheduleNextNum(rounds.length + 1);
                                  setScheduleDefaultName(app.stage);
                                }}
                                className="flex items-center gap-1.5 text-xs text-dp-600 hover:text-dp-800 font-medium"
                              >
                                <CalendarPlus className="w-3.5 h-3.5" /> Schedule round
                              </button>
                            )}
                            {canHR && app.stage === 'Assignment Round' && (
                              <button
                                onClick={() => setAssignmentModal({
                                  mode: 'create',
                                  applicationId: app.id,
                                  roleId: app.role_id,
                                  nextRoundNumber: rounds.length + 1,
                                  candidateName: candidate.full_name,
                                  roleTitle: app.role_title,
                                  candidateEmail: candidate.email,
                                })}
                                className="flex items-center gap-1.5 text-xs text-dp-600 hover:text-dp-800 font-medium"
                              >
                                <Send className="w-3.5 h-3.5" /> Send Assignment
                              </button>
                            )}
                          </div>
                          {rounds.length === 0 ? (
                            <p className="text-xs text-gray-400">No rounds scheduled yet.</p>
                          ) : (
                            <div className="space-y-2">
                              {rounds.map(round => {
                                // Only rounds with actual submitted feedback have anything to
                                // expand — Pending/Overdue Standard rounds or Assignment rounds
                                // with no outcome recorded yet show no chevron at all.
                                const hasDetail = round.round_type === 'Assignment' ? !!round.assignment_outcome : round.feedback_status === 'Submitted';
                                return (
                                <div key={round.id} className="rounded-lg bg-gray-50 border border-gray-100">
                                <div className="flex items-center justify-between py-2 px-3">
                                  <div>
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs font-medium text-gray-900">Round {round.round_number} — {round.round_name}</span>
                                      {round.round_type === 'Assignment' ? <AssignmentStatusPill round={round} /> : <FeedbackBadge status={round.feedback_status} />}
                                      {round.round_type === 'Assignment' && <span className="text-xs px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">Assignment</span>}
                                    </div>
                                    <div className="text-xs text-gray-400 mt-0.5 flex gap-3">
                                      {round.interviewer_emails && round.interviewer_emails.length > 0 && (
                                        <span>👤 {round.interviewer_emails.join(', ')}</span>
                                      )}
                                      {round.scheduled_date && <span>📅 {format(new Date(round.scheduled_date), 'MMM d, h:mm a')}</span>}
                                      {round.calendar_event_link && (
                                        <a href={round.calendar_event_link} target="_blank" rel="noreferrer"
                                           className="flex items-center gap-1 text-dp-600 hover:underline">
                                          <ExternalLink className="w-3 h-3" /> Calendar invite
                                        </a>
                                      )}
                                      {round.calendar_sync_error && (
                                        <span className="text-amber-600" title={round.calendar_sync_error}>⚠ Calendar invite failed</span>
                                      )}
                                      {round.assignment_link && (
                                        <a href={round.assignment_link} target="_blank" rel="noreferrer"
                                           className="flex items-center gap-1 text-dp-600 hover:underline">
                                          <ExternalLink className="w-3 h-3" /> Assignment link
                                        </a>
                                      )}
                                      {round.assignment_submission_link && (
                                        <a href={round.assignment_submission_link} target="_blank" rel="noreferrer"
                                           className="flex items-center gap-1 text-dp-600 hover:underline">
                                          <ExternalLink className="w-3 h-3" /> Submission link
                                        </a>
                                      )}
                                      {round.assignment_email_error && (
                                        <span className="text-amber-600" title={round.assignment_email_error}>⚠ Assignment email failed to send</span>
                                      )}
                                      {round.overall_assessment && <span className="font-medium text-gray-600">{round.overall_assessment} · {round.round_recommendation}</span>}
                                      {round.overall_round_score != null && <span>Score: {Number(round.overall_round_score).toFixed(1)}/5</span>}
                                      {round.assignment_outcome && (
                                        <span className={`font-medium ${
                                          round.assignment_outcome === 'Approved for Next Round' ? 'text-green-600' :
                                          round.assignment_outcome === 'Assignment Resent' ? 'text-amber-600' : 'text-red-600'
                                        }`}>
                                          {round.assignment_outcome}{round.assignment_overall_score != null && ` · ${Number(round.assignment_overall_score).toFixed(1)}/5`}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  {round.round_type === 'Assignment' ? (
                                    // Send/Record submission are HR-owned lifecycle steps (matches
                                    // requireHR on the backend routes) — but Record outcome is the
                                    // actual technical evaluation, done by whichever persona is
                                    // qualified to judge the submission (HM/Interviewer), same as
                                    // Standard-round feedback below is open to everyone. HR can still
                                    // score it themselves (e.g. relaying verbal scores from someone
                                    // else) since this button isn't persona-gated either.
                                    !round.assignment_send_date ? (
                                      // Only reachable when a send was never successful — see
                                      // attemptAssignmentEmail (backend/src/routes/interviews.ts).
                                      // This is the retry path, prefilled from what was last tried.
                                      canHR && (
                                        <button onClick={() => setAssignmentModal({
                                          mode: 'retry',
                                          applicationId: app.id,
                                          roundId: round.id,
                                          roleId: app.role_id,
                                          candidateName: candidate.full_name,
                                          roleTitle: app.role_title,
                                          candidateEmail: candidate.email,
                                          initialMailBody: round.assignment_mail_body,
                                          initialCc: round.assignment_cc?.join(', '),
                                          initialAssignmentLink: round.assignment_link,
                                          initialSupportingDocs: round.assignment_supporting_docs,
                                        })} className="flex items-center gap-1.5 text-xs text-dp-600 hover:text-dp-800 font-medium shrink-0 ml-3">
                                          <Send className="w-3.5 h-3.5" /> Send assignment
                                        </button>
                                      )
                                    ) : !round.assignment_submission_date ? (
                                      canHR && (
                                        <button onClick={() => { setSubmitRoundId(round.id); setSubmitLink(''); setShowSubmitModal(true); }} className="flex items-center gap-1.5 text-xs text-dp-600 hover:text-dp-800 font-medium shrink-0 ml-3">
                                          <Link2 className="w-3.5 h-3.5" /> Record submission
                                        </button>
                                      )
                                    ) : !round.assignment_outcome ? (
                                      <button onClick={() => setOutcomeRound({ ...round, candidate_name: candidate.full_name, role_title: app.role_title })} className="flex items-center gap-1.5 text-xs text-dp-600 hover:text-dp-800 font-medium shrink-0 ml-3">
                                        <MessageSquare className="w-3.5 h-3.5" /> Record outcome
                                      </button>
                                    ) : null
                                  ) : round.feedback_status !== 'Submitted' && (
                                    <button onClick={() => setFeedbackRound({ ...round, candidate_name: candidate.full_name, role_title: app.role_title })} className="flex items-center gap-1.5 text-xs text-dp-600 hover:text-dp-800 font-medium shrink-0 ml-3">
                                      <MessageSquare className="w-3.5 h-3.5" /> Submit feedback
                                    </button>
                                  )}
                                  {hasDetail && (
                                    <button onClick={() => toggleRound(round.id)} title="Show full feedback" className="text-gray-400 hover:text-dp-600 shrink-0 ml-2">
                                      {expandedRounds.has(round.id) ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                    </button>
                                  )}
                                </div>
                                {hasDetail && expandedRounds.has(round.id) && (
                                  <div className="px-3 pb-3 pt-1 border-t border-gray-100 space-y-2 text-xs">
                                    {round.round_type === 'Assignment' ? (
                                      <>
                                        {[
                                          ['Technical accuracy', round.score_technical_accuracy],
                                          ['Problem solving',    round.score_problem_solving],
                                          ['Clarity',            round.score_clarity],
                                          ['Practical thinking', round.score_practical_thinking],
                                          ['Completeness',       round.score_completeness],
                                        ].some(([, v]) => v != null) && (
                                          <div className="flex flex-wrap gap-3 text-gray-600">
                                            {[
                                              ['Technical accuracy', round.score_technical_accuracy],
                                              ['Problem solving',    round.score_problem_solving],
                                              ['Clarity',            round.score_clarity],
                                              ['Practical thinking', round.score_practical_thinking],
                                              ['Completeness',       round.score_completeness],
                                            ].filter(([, v]) => v != null).map(([label, v]) => (
                                              <span key={label as string}>{label}: <span className="font-medium">{Number(v)}/5</span></span>
                                            ))}
                                          </div>
                                        )}
                                        {round.assignment_notes && (
                                          <p className="text-gray-600 whitespace-pre-wrap">{round.assignment_notes}</p>
                                        )}
                                        {!round.assignment_notes && ![round.score_technical_accuracy, round.score_problem_solving, round.score_clarity, round.score_practical_thinking, round.score_completeness].some(v => v != null) && (
                                          <p className="text-gray-400">No further detail recorded.</p>
                                        )}
                                      </>
                                    ) : (
                                      <>
                                        {round.scores_per_area && Object.keys(round.scores_per_area).length > 0 && (
                                          <div className="flex flex-wrap gap-3 text-gray-600">
                                            {Object.entries(round.scores_per_area).map(([area, score]) => (
                                              <span key={area}>{area}: <span className="font-medium">{score}/5</span></span>
                                            ))}
                                          </div>
                                        )}
                                        {round.confidence_level && (
                                          <p className="text-gray-500">Confidence: <span className="font-medium text-gray-700">{round.confidence_level}</span></p>
                                        )}
                                        {round.strengths_observed && (
                                          <div><span className="font-semibold text-gray-500">Strengths: </span><span className="text-gray-600 whitespace-pre-wrap">{round.strengths_observed}</span></div>
                                        )}
                                        {round.key_concerns && (
                                          <div><span className="font-semibold text-gray-500">Concerns: </span><span className="text-gray-600 whitespace-pre-wrap">{round.key_concerns}</span></div>
                                        )}
                                        {round.unresolved_questions && (
                                          <div><span className="font-semibold text-gray-500">Unresolved questions: </span><span className="text-gray-600 whitespace-pre-wrap">{round.unresolved_questions}</span></div>
                                        )}
                                        {round.suggested_probe_areas && (
                                          <div><span className="font-semibold text-gray-500">Suggested probe areas: </span><span className="text-gray-600 whitespace-pre-wrap">{round.suggested_probe_areas}</span></div>
                                        )}
                                        {round.notes && (
                                          <div><span className="font-semibold text-gray-500">Notes: </span><span className="text-gray-600 whitespace-pre-wrap">{round.notes}</span></div>
                                        )}
                                        {!round.strengths_observed && !round.key_concerns && !round.unresolved_questions && !round.suggested_probe_areas && !round.notes && (!round.scores_per_area || Object.keys(round.scores_per_area).length === 0) && (
                                          <p className="text-gray-400">No further detail recorded.</p>
                                        )}
                                      </>
                                    )}
                                  </div>
                                )}
                                </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        <div className="border-t border-gray-100 pt-3 mt-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Reference Checks</span>
                            {canHR && app.stage === 'Reference Check' && (
                              <button
                                onClick={() => setAddRefCheckAppId(app.id)}
                                className="flex items-center gap-1.5 text-xs text-dp-600 hover:text-dp-800 font-medium"
                              >
                                <FileText className="w-3.5 h-3.5" /> Add Reference Check
                              </button>
                            )}
                          </div>
                          {refChecks.length === 0 ? (
                            <p className="text-xs text-gray-400">No reference checks added yet.</p>
                          ) : (
                            <div className="space-y-2">
                              {refChecks.map(rc => (
                                <div key={rc.id} className="py-2 px-3 rounded-lg bg-gray-50 border border-gray-100">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xs font-medium text-gray-900">{rc.reference_name}</span>
                                    <span className="text-xs px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">{rc.relationship}</span>
                                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                                      rc.feedback === 'Excellent' ? 'bg-green-100 text-green-700' :
                                      rc.feedback === 'Good' ? 'bg-dp-100 text-dp-700' :
                                      rc.feedback === 'Average' ? 'bg-amber-100 text-amber-700' :
                                      'bg-red-100 text-red-700'
                                    }`}>{rc.feedback}</span>
                                    <span className="text-xs text-gray-400">{formatDistanceToNow(new Date(rc.conducted_at), { addSuffix: true })}</span>
                                  </div>
                                  <div className="text-xs text-gray-400 mt-0.5">{rc.reference_number}</div>
                                  {rc.reference_call_notes && (
                                    <p className="text-xs text-gray-600 mt-1 italic">{rc.reference_call_notes}</p>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <ResumeIQPanel app={app} />

                        {app.screening_answers && app.screening_answers.length > 0 && (
                          <div className="border-t border-gray-100 pt-3 mt-3">
                            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Screening Answers</span>
                            <div className="mt-2 space-y-2">
                              {app.screening_answers.map((qa, i) => (
                                <div key={i} className="text-xs">
                                  <p className="text-gray-500 font-medium">{qa.question}</p>
                                  <p className="text-gray-700 mt-0.5">{qa.answer}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {canHR ? (
                          hasScreeningNotes(app) || screeningNotesOpen.has(app.id) ? (
                            <EditableSection
                              title="Screening & Risk Notes"
                              data={app}
                              onSave={(changes) => saveApplicationNotes(app.id, changes)}
                              fields={[
                                { key: 'hr_recruiter_summary', label: 'Recruiter Summary', type: 'textarea' },
                                { key: 'hr_key_positives', label: 'Key Positives', type: 'textarea' },
                                { key: 'hr_key_concerns', label: 'Key Concerns', type: 'textarea' },
                                { key: 'hr_comp_alignment', label: 'Compensation Alignment', type: 'textarea' },
                                { key: 'hr_communication_assessment', label: 'Communication Assessment', type: 'textarea' },
                                { key: 'hr_priority_override', label: 'Priority Override', type: 'select', options: ['Normal', 'High', 'Critical'] },
                                { key: 'hr_priority_override_reason', label: 'Override Reason', type: 'text' },
                                { key: 'hr_tags', label: 'Tags', type: 'tags' },
                                { key: 'internal_risk_notes', label: 'Internal Risk Notes', type: 'textarea' },
                              ]}
                            />
                          ) : (
                            <button
                              onClick={() => setScreeningNotesOpen(prev => new Set(prev).add(app.id))}
                              className="text-xs text-dp-600 hover:text-dp-700 hover:underline font-medium border-t border-gray-100 pt-3 mt-3"
                            >
                              + Add HR Screening Notes
                            </button>
                          )
                        ) : app.hr_recruiter_summary && (
                          <div className="text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2 italic border-l-2 border-dp-300">"{app.hr_recruiter_summary}"</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Activity timeline</h2>
        </div>
        {activity.length === 0 ? (
          <div className="p-8"><EmptyState title="No activity logged yet" /></div>
        ) : (
          <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
            {(activity as Array<Record<string, unknown>>).map((evt, i) => (
              <div key={i} className="px-5 py-3 flex items-start gap-3">
                <div className="w-2 h-2 rounded-full bg-dp-400 mt-1.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-900">{String(evt.event_type)}</span>
                    <span className="text-xs text-gray-400">by {String(evt.performed_by_name || 'System')}</span>
                  </div>
                  {evt.event_detail && <p className="text-xs text-gray-500 mt-0.5">{String(evt.event_detail)}</p>}
                </div>
                <span className="text-xs text-gray-400 whitespace-nowrap shrink-0">{evt.created_at ? format(new Date(String(evt.created_at)), 'MMM d, h:mm a') : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {stageModalApp && (
        <StageChangeModal
          application={stageModalApp}
          onClose={() => setStageModalApp(null)}
          onUpdated={() => {
            qc.invalidateQueries({ queryKey: ['candidate', id] });
            // Stage drives inclusion on Scorecard Summary/My Tasks (Applied-
            // gated actions, budget/stage filters) — those live on
            // the shared 'applications' key, not this page's own.
            qc.invalidateQueries({ queryKey: ['applications'] });
          }}
        />
      )}

      {viewingRejection && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setViewingRejection(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold">Rejection reason</h3>
            <p className="text-sm text-gray-900">{viewingRejection.cat || 'No reason logged'}</p>
            {viewingRejection.detail && <p className="text-sm text-gray-500">{viewingRejection.detail}</p>}
            <div className="flex justify-end">
              <button onClick={() => setViewingRejection(null)} className="btn-secondary">Close</button>
            </div>
          </div>
        </div>
      )}

      {showStatusModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-base font-semibold">Update status</h3>
            <select value={statusValue} onChange={e => setStatusValue(e.target.value)} className="select">
              {['Active', 'Rejected', 'Withdrawn', 'Hold for Future'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {(statusValue === 'Rejected' || statusValue === 'Withdrawn') && (
              <>
                <select value={rejectionCat} onChange={e => setRejectionCat(e.target.value)} className="select">
                  <option value="">Select reason *</option>
                  {(statusValue === 'Rejected' ? REJECTION_REASONS : WITHDRAWAL_REASONS).map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <textarea placeholder="Additional detail (optional)" value={rejectionDetail} onChange={e => setRejectionDetail(e.target.value)} className="input h-20 resize-none" />
              </>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowStatusModal(false)} className="btn-secondary">Cancel</button>
              <button onClick={handleStatusUpdate} disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Update'}</button>
            </div>
          </div>
        </div>
      )}

      {showFounderModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-base font-semibold">{founderSetTo ? 'Flag for Founder Review' : 'Clear Founder Review flag'}</h3>
            <textarea
              placeholder="Note (optional)"
              value={founderNote}
              onChange={e => setFounderNote(e.target.value)}
              className="input h-20 resize-none"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowFounderModal(false)} className="btn-secondary">Cancel</button>
              <button onClick={handleFounderFlag} disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Confirm'}</button>
            </div>
          </div>
        </div>
      )}

      {showSubmitModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-base font-semibold">Record submission</h3>
            <input
              value={submitLink}
              onChange={e => setSubmitLink(e.target.value)}
              placeholder="Drive/repo link to the submission"
              className="input"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowSubmitModal(false)} className="btn-secondary">Cancel</button>
              <button onClick={handleSubmitAssignment} disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {outcomeRound && (
        <AssignmentOutcomeModal round={outcomeRound} onClose={() => setOutcomeRound(null)} onSuccess={() => { qc.invalidateQueries({ queryKey: ['interview-rounds'] }); refetchRounds(); }} />
      )}

      {feedbackRound && (
        <InterviewFeedbackModal round={feedbackRound} onClose={() => setFeedbackRound(null)} onSuccess={() => { qc.invalidateQueries({ queryKey: ['interview-rounds'] }); refetchRounds(); }} />
      )}

      {scheduleAppId && (
        <ScheduleRoundModal
          applicationId={scheduleAppId}
          nextRoundNumber={scheduleNextNum}
          defaultRoundName={scheduleDefaultName}
          onClose={() => setScheduleAppId(null)}
          onSuccess={() => { qc.invalidateQueries({ queryKey: ['interview-rounds'] }); refetchRounds(); }}
        />
      )}

      {assignmentModal && (
        <SendAssignmentModal
          {...assignmentModal}
          onClose={() => setAssignmentModal(null)}
          onSuccess={() => { qc.invalidateQueries({ queryKey: ['interview-rounds'] }); refetchRounds(); }}
        />
      )}

      {addRefCheckAppId && (
        <AddReferenceCheckModal
          applicationId={addRefCheckAppId}
          onClose={() => setAddRefCheckAppId(null)}
          onSuccess={() => { qc.invalidateQueries({ queryKey: ['ref-checks'] }); refetchRefChecks(); }}
        />
      )}

      {showAddApplication && candidate && (
        <LinkToRoleModal
          candidate={candidate}
          excludeRoleIds={applications.map(a => a.role_id)}
          sourceChannel="Manual Add"
          onClose={() => setShowAddApplication(false)}
          onLinked={() => {
            qc.invalidateQueries({ queryKey: ['candidate', id] });
            qc.invalidateQueries({ queryKey: ['applications'] });
          }}
        />
      )}
    </div>
  );
}
