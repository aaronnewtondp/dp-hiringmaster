import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Star } from 'lucide-react';
import toast from 'react-hot-toast';
import { candidatesApi, applicationsApi } from '../services/api.ts';
import { Candidate, Application, STAGES, REJECTION_REASONS, WITHDRAWAL_REASONS } from '../types/index.ts';
import { StageBadge, StatusBadge, FitScore, PriorityBadge, Spinner, EmptyState } from '../components/shared/Badges.tsx';
import { useAuth } from '../contexts/AuthContext.tsx';
import { formatDistanceToNow, format } from 'date-fns';

export default function CandidateDetail() {
  const { id } = useParams<{ id: string }>();
  const { canHR, user } = useAuth();
  const qc = useQueryClient();

  const [showStageModal,    setShowStageModal]    = useState(false);
  const [showStatusModal,   setShowStatusModal]   = useState(false);
  const [selectedAppId,     setSelectedAppId]     = useState<string>('');
  const [stageValue,        setStageValue]        = useState('');
  const [statusValue,       setStatusValue]       = useState('');
  const [rejectionCat,      setRejectionCat]      = useState('');
  const [rejectionDetail,   setRejectionDetail]   = useState('');
  const [saving,            setSaving]            = useState(false);

  const { data, isLoading } = useQuery<{ data: { candidate: Candidate; applications: Application[] } }>({
    queryKey: ['candidate', id],
    queryFn:  () => candidatesApi.get(id!),
  });

  const { data: actData } = useQuery<{ data: { activity: unknown[] } }>({
    queryKey: ['candidate-activity', id],
    queryFn:  () => candidatesApi.activity(id!),
  });

  const candidate    = data?.data?.candidate;
  const applications = data?.data?.applications || [];
  const activity     = actData?.data?.activity || [];

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

  return (
    <div className="space-y-6">
      {/* Header */}
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
            <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
              {candidate.email && <span>{candidate.email}</span>}
              {candidate.phone && <span>·</span>}
              {candidate.phone && <span>{candidate.phone}</span>}
              {candidate.linkedin_url && (
                <a href={candidate.linkedin_url} target="_blank" rel="noopener noreferrer"
                   className="text-dp-600 hover:underline flex items-center gap-1">
                  <ExternalLink className="w-3 h-3" /> LinkedIn
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

      {/* Parsed resume + applications */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Parsed profile */}
        <div className="card p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-900">Parsed profile</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Experience</span>
              <span className="font-medium">{candidate.parsed_total_yoe != null ? `${candidate.parsed_total_yoe} yrs` : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Education</span>
              <span className="font-medium text-right max-w-[140px] truncate">{candidate.parsed_education || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Stability</span>
              <span className={`font-medium ${candidate.job_stability_months && candidate.job_stability_months < 18 ? 'text-red-600' : ''}`}>
                {candidate.job_stability_months != null ? `${candidate.job_stability_months}mo avg` : '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Parsed</span>
              <span className={`font-medium ${candidate.parsing_completeness === 'Not Parsed' ? 'text-amber-600' : 'text-green-600'}`}>
                {candidate.parsing_completeness}
              </span>
            </div>
          </div>
          {(candidate.parsed_skills || []).length > 0 && (
            <div>
              <div className="text-xs text-gray-400 mb-1.5">Skills</div>
              <div className="flex flex-wrap gap-1">
                {(candidate.parsed_skills || []).slice(0, 8).map(s => (
                  <span key={s} className="px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600">{s}</span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Applications */}
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">Applications ({applications.length})</h2>
          </div>
          {applications.length === 0 ? (
            <div className="p-8"><EmptyState title="No applications" /></div>
          ) : (
            <div className="divide-y divide-gray-50">
              {applications.map(app => (
                <div key={app.id} className={`p-4 ${app.sla_breach ? 'bg-red-50/30' : ''}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link to={`/roles/${app.role_id}`} className="font-medium text-gray-900 hover:text-dp-600 text-sm">
                          {(app as Application & { role_title?: string }).role_title}
                        </Link>
                        {(app as Application & { role_priority?: string }).role_priority && (
                          <PriorityBadge priority={(app as Application & { role_priority?: string }).role_priority as 'P0'|'P1'|'P2'|'P3'} />
                        )}
                        {app.sla_breach && <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-medium">SLA</span>}
                        {app.founder_review_flag && <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded"><Star className="w-3 h-3 inline" /> Founder</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <StageBadge stage={app.stage} />
                        <StatusBadge status={app.status} />
                        <span className="text-xs text-gray-400">{app.recruiter_screening_status}</span>
                        <FitScore score={app.ai_fit_score} />
                      </div>
                      {app.ai_score_summary && (
                        <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">{app.ai_score_summary}</p>
                      )}
                      {app.hr_recruiter_summary && (
                        <p className="text-xs text-gray-600 mt-1 italic">"{app.hr_recruiter_summary}"</p>
                      )}
                    </div>
                    {canHR && (
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => { setSelectedAppId(app.id); setStageValue(app.stage); setShowStageModal(true); }}
                          className="btn-secondary text-xs py-1.5 px-3"
                        >
                          Stage
                        </button>
                        <button
                          onClick={() => { setSelectedAppId(app.id); setStatusValue(app.status); setShowStatusModal(true); }}
                          className="btn-secondary text-xs py-1.5 px-3"
                        >
                          Status
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-3 mt-2 text-xs text-gray-400">
                    <span>Source: {app.source_channel || '—'}</span>
                    {app.ectc && <span>ECTC: ₹{app.ectc}L</span>}
                    {app.notice_period_days != null && <span>Notice: {app.notice_period_days}d</span>}
                    <span>Updated {formatDistanceToNow(new Date(app.last_updated), { addSuffix: true })}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Activity log */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Activity timeline</h2>
        </div>
        {activity.length === 0 ? (
          <div className="p-8"><EmptyState title="No activity logged yet" /></div>
        ) : (
          <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
            {(activity as Array<Record<string,unknown>>).map((evt, i) => (
              <div key={i} className="px-5 py-3 flex items-start gap-3">
                <div className="w-2 h-2 rounded-full bg-dp-400 mt-1.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-900">{String(evt.event_type)}</span>
                    <span className="text-xs text-gray-400">by {String(evt.performed_by_name || 'System')}</span>
                  </div>
                  {evt.event_detail && (
                    <p className="text-xs text-gray-500 mt-0.5">{String(evt.event_detail)}</p>
                  )}
                </div>
                <span className="text-xs text-gray-400 whitespace-nowrap shrink-0">
                  {evt.created_at ? format(new Date(String(evt.created_at)), 'MMM d, h:mm a') : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Stage modal */}
      {showStageModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <h3 className="text-base font-semibold mb-4">Update stage</h3>
            <select value={stageValue} onChange={e => setStageValue(e.target.value)} className="select mb-4">
              {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowStageModal(false)} className="btn-secondary">Cancel</button>
              <button onClick={handleStageUpdate} disabled={saving} className="btn-primary">
                {saving ? 'Saving…' : 'Update'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Status modal */}
      {showStatusModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-base font-semibold">Update status</h3>
            <select value={statusValue} onChange={e => setStatusValue(e.target.value)} className="select">
              {['Active','On Hold','Rejected','Withdrawn','Hold for Future'].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            {(statusValue === 'Rejected' || statusValue === 'Withdrawn') && (
              <>
                <select value={rejectionCat} onChange={e => setRejectionCat(e.target.value)} className="select">
                  <option value="">Select reason *</option>
                  {(statusValue === 'Rejected' ? REJECTION_REASONS : WITHDRAWAL_REASONS).map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <textarea
                  placeholder="Additional detail (optional)"
                  value={rejectionDetail}
                  onChange={e => setRejectionDetail(e.target.value)}
                  className="input h-20 resize-none"
                />
              </>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowStatusModal(false)} className="btn-secondary">Cancel</button>
              <button onClick={handleStatusUpdate} disabled={saving} className="btn-primary">
                {saving ? 'Saving…' : 'Update'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
