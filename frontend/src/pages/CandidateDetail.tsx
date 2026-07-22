import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Star, ChevronDown, ChevronUp, CalendarPlus, MessageSquare, FileText, Send, Link2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { candidatesApi, applicationsApi, interviewsApi, assignmentRepoApi } from '../services/api.ts';
import { Candidate, Application, InterviewRound, AssignmentRepoEntry, STAGES, REJECTION_REASONS, WITHDRAWAL_REASONS } from '../types/index.ts';
import { StageBadge, StatusBadge, PriorityBadge, Spinner, EmptyState } from '../components/shared/Badges.tsx';
import EditableSection from '../components/shared/EditableSection.tsx';
import ResumeIQPanel from '../components/ResumeIQPanel.tsx';
import InterviewFeedbackModal from '../components/InterviewFeedbackModal.tsx';
import ScheduleRoundModal from '../components/ScheduleRoundModal.tsx';
import AssignmentOutcomeModal from '../components/AssignmentOutcomeModal.tsx';
import { useAuth } from '../contexts/AuthContext.tsx';
import { formatDistanceToNow, format } from 'date-fns';

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
// below). This is what makes the "Schedule round"/"Schedule Assignment"
// controls appear/disappear as the stage moves, instead of always showing.
const INTERVIEW_STAGES = ['Interview Round 1', 'Interview Round 2', 'Founders Round'];

export default function CandidateDetail() {
  const { id } = useParams<{ id: string }>();
  const { canHR } = useAuth();
  const qc = useQueryClient();

  const [showStageModal, setShowStageModal] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [selectedAppId, setSelectedAppId] = useState('');
  const [stageValue, setStageValue] = useState('');
  const [statusValue, setStatusValue] = useState('');
  const [rejectionCat, setRejectionCat] = useState('');
  const [rejectionDetail, setRejectionDetail] = useState('');
  const [saving, setSaving] = useState(false);

  const [showFounderModal, setShowFounderModal] = useState(false);
  const [founderAppId, setFounderAppId] = useState('');
  const [founderSetTo, setFounderSetTo] = useState(true);
  const [founderNote, setFounderNote] = useState('');

  const [feedbackRound, setFeedbackRound] = useState<(InterviewRound & { candidate_name?: string; role_title?: string }) | null>(null);
  const [outcomeRound, setOutcomeRound] = useState<(InterviewRound & { candidate_name?: string; role_title?: string }) | null>(null);
  const [scheduleAppId, setScheduleAppId] = useState<string | null>(null);
  const [scheduleNextNum, setScheduleNextNum] = useState(1);
  const [scheduleRoundType, setScheduleRoundType] = useState<'Standard' | 'Assignment'>('Standard');
  const [scheduleDefaultName, setScheduleDefaultName] = useState('');
  const [expandedApps, setExpandedApps] = useState<Set<string>>(new Set());

  const [showSendModal, setShowSendModal] = useState(false);
  const [sendRoundId, setSendRoundId] = useState('');
  const [sendRepoId, setSendRepoId] = useState('');
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [submitRoundId, setSubmitRoundId] = useState('');
  const [submitLink, setSubmitLink] = useState('');

  const toggleApp = (appId: string) =>
    setExpandedApps(prev => {
      const s = new Set(prev);
      s.has(appId) ? s.delete(appId) : s.add(appId);
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

  const { data: repoData } = useQuery<{ data: { assignments: AssignmentRepoEntry[] } }>({
    queryKey: ['assignment-repo'],
    queryFn: () => assignmentRepoApi.list(),
    enabled: showSendModal,
  });
  const repoEntries = repoData?.data?.assignments || [];

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

  const handleSendAssignment = async () => {
    setSaving(true);
    try {
      await interviewsApi.sendAssignment(sendRoundId, { assignment_repo_id: sendRepoId || undefined });
      toast.success('Assignment sent');
      setShowSendModal(false);
      qc.invalidateQueries({ queryKey: ['interview-rounds'] });
      refetchRounds();
    } catch { toast.error('Failed to send assignment'); }
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

  const handleStageUpdate = async () => {
    if (!selectedAppId || !stageValue) return;
    setSaving(true);
    try {
      await applicationsApi.advanceStage(selectedAppId, stageValue);
      toast.success(`Stage updated to ${stageValue}`);
      setShowStageModal(false);
      qc.invalidateQueries({ queryKey: ['candidate', id] });
    } catch { toast.error('Failed to update stage'); }
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
    } catch { toast.error('Failed to update status'); }
    setSaving(false);
  };

  if (isLoading) return <div className="flex justify-center p-12"><Spinner size="lg" /></div>;
  if (!candidate) return <EmptyState title="Candidate not found" />;
  console.log('DEBUG candidate object:', candidate);

  return (
    <div className="space-y-6">
      <div>
        <Link to="/candidates" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-3">
          <ArrowLeft className="w-4 h-4" /> Candidates
        </Link>
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
      </div>

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
            ]}
          />
          <EditableSection
            title="Current Role"
            data={candidate}
            onSave={saveCandidateFields}
            fields={[
              { key: 'current_company', label: 'Company', type: 'text' },
              { key: 'current_designation', label: 'Designation', type: 'text' },
              { key: 'current_industry', label: 'Industry', type: 'text' },
              { key: 'current_location', label: 'Location', type: 'text' },
              { key: 'years_of_experience', label: 'Experience (yrs)', type: 'number' },
            ]}
          />
          <EditableSection
            title="Compensation"
            data={candidate}
            onSave={saveCandidateFields}
            fields={[
              { key: 'current_ctc_fixed', label: 'Current CTC (Fixed)', type: 'number' },
              { key: 'current_ctc_variable', label: 'Current CTC (Variable)', type: 'number' },
              { key: 'current_esops', label: 'Current ESOPs', type: 'number' },
              { key: 'expected_ctc', label: 'Expected CTC', type: 'number' },
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
          <div className="px-5 py-3 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">Applications ({applications.length})</h2>
          </div>
          {applications.length === 0 ? (
            <div className="p-8"><EmptyState title="No applications" /></div>
          ) : (
            <div className="divide-y divide-gray-50">
              {applications.map(app => {
                const rounds = roundsMap?.[app.id] || [];
                const expanded = expandedApps.has(app.id);
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
                            <StatusBadge status={app.status} />
                            <span className="text-xs text-gray-400">{app.recruiter_screening_status}</span>
                            {app.score_avg != null && <span className="text-xs font-semibold text-dp-700">ResumeIQ: {Number(app.score_avg).toFixed(1)}/10</span>}
                          </div>
                          <div className="flex gap-3 mt-2 text-xs text-gray-400">
                            <span>Source: {app.source_channel || '—'}</span>
                            <span>Updated {formatDistanceToNow(new Date(app.last_updated), { addSuffix: true })}</span>
                            {rounds.length > 0 && <span>{rounds.length} round{rounds.length !== 1 ? 's' : ''}</span>}
                          </div>
                        </div>
                        <div className="flex gap-2 shrink-0 items-start">
                          {canHR && (
                            <>
                              <button onClick={() => { setSelectedAppId(app.id); setStageValue(app.stage); setShowStageModal(true); }} className="btn-secondary text-xs py-1.5 px-3">Stage</button>
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
                                  setScheduleRoundType('Standard');
                                  setScheduleDefaultName(app.stage);
                                }}
                                className="flex items-center gap-1.5 text-xs text-dp-600 hover:text-dp-800 font-medium"
                              >
                                <CalendarPlus className="w-3.5 h-3.5" /> Schedule round
                              </button>
                            )}
                            {canHR && app.stage === 'Assignment Round' && (
                              <button
                                onClick={() => {
                                  setScheduleAppId(app.id);
                                  setScheduleNextNum(rounds.length + 1);
                                  setScheduleRoundType('Assignment');
                                  setScheduleDefaultName('');
                                }}
                                className="flex items-center gap-1.5 text-xs text-dp-600 hover:text-dp-800 font-medium"
                              >
                                <CalendarPlus className="w-3.5 h-3.5" /> Schedule Assignment
                              </button>
                            )}
                          </div>
                          {rounds.length === 0 ? (
                            <p className="text-xs text-gray-400">No rounds scheduled yet.</p>
                          ) : (
                            <div className="space-y-2">
                              {rounds.map(round => (
                                <div key={round.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-gray-50 border border-gray-100">
                                  <div>
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs font-medium text-gray-900">Round {round.round_number} — {round.round_name}</span>
                                      {round.round_type === 'Assignment' ? <AssignmentStatusPill round={round} /> : <FeedbackBadge status={round.feedback_status} />}
                                      {round.round_type === 'Assignment' && <span className="text-xs px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">Assignment</span>}
                                    </div>
                                    <div className="text-xs text-gray-400 mt-0.5 flex gap-3">
                                      {round.interviewer_names && <span>👤 {round.interviewer_names}</span>}
                                      {round.scheduled_date && <span>📅 {format(new Date(round.scheduled_date), 'MMM d, h:mm a')}</span>}
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
                                      canHR && (
                                        <button onClick={() => { setSendRoundId(round.id); setSendRepoId(''); setShowSendModal(true); }} className="flex items-center gap-1.5 text-xs text-dp-600 hover:text-dp-800 font-medium shrink-0 ml-3">
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
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <ResumeIQPanel app={app} />

                        {canHR ? (
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

      {showStageModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <h3 className="text-base font-semibold mb-4">Update stage</h3>
            <select value={stageValue} onChange={e => setStageValue(e.target.value)} className="select mb-4">
              {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowStageModal(false)} className="btn-secondary">Cancel</button>
              <button onClick={handleStageUpdate} disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Update'}</button>
            </div>
          </div>
        </div>
      )}

      {showStatusModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-base font-semibold">Update status</h3>
            <select value={statusValue} onChange={e => setStatusValue(e.target.value)} className="select">
              {['Active', 'On Hold', 'Rejected', 'Withdrawn', 'Hold for Future'].map(s => <option key={s} value={s}>{s}</option>)}
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

      {showSendModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-base font-semibold">Send assignment</h3>
            <select value={sendRepoId} onChange={e => setSendRepoId(e.target.value)} className="select">
              <option value="">— Ad hoc, no repo entry —</option>
              {repoEntries.map(a => (
                <option key={a.id} value={a.id}>{a.name}{a.difficulty_level ? ` (${a.difficulty_level})` : ''}</option>
              ))}
            </select>
            <p className="text-xs text-gray-400">Deadline auto-sets to 60 hours from now.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowSendModal(false)} className="btn-secondary">Cancel</button>
              <button onClick={handleSendAssignment} disabled={saving} className="btn-primary">{saving ? 'Sending…' : 'Send'}</button>
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
          roundType={scheduleRoundType}
          defaultRoundName={scheduleDefaultName}
          onClose={() => setScheduleAppId(null)}
          onSuccess={() => { qc.invalidateQueries({ queryKey: ['interview-rounds'] }); refetchRounds(); }}
        />
      )}
    </div>
  );
}
