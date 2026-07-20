import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Users, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { rolesApi } from '../services/api.ts';
import { Role, Application } from '../types/index.ts';
import { PriorityBadge, AgingBadge, StageBadge, FitScore, Spinner, EmptyState } from '../components/shared/Badges.tsx';
import EditableSection from '../components/shared/EditableSection.tsx';
import { useAuth } from '../contexts/AuthContext.tsx';

const ROLE_STATUSES = ['Draft', 'Under Review', 'Approved', 'Live – Sourcing', 'On Hold', 'Closed – Filled', 'Closed – Cancelled'];

export default function RoleDetail() {
  const { id } = useParams<{ id: string }>();
  const { canHR } = useAuth();
  const qc = useQueryClient();

  const [showStatusModal, setShowStatusModal] = useState(false);
  const [statusValue, setStatusValue] = useState('');
  const [saving, setSaving] = useState(false);

  const { data: roleData, isLoading: roleLoading } = useQuery<{ data: { role: Role } }>({
    queryKey: ['role', id],
    queryFn:  () => rolesApi.get(id!),
    refetchInterval: (query) => {
      const r = query.state.data?.data?.role;
      return r?.status === 'Approved' && !r.jd_drive_link ? 10_000 : false;
    },
  });

  const { data: pipelineData } = useQuery<{ data: { pipeline: Record<string, Application[]>; total: number } }>({
    queryKey: ['role-pipeline', id],
    queryFn:  () => rolesApi.pipeline(id!),
  });

  const role     = roleData?.data?.role;
  const pipeline = pipelineData?.data?.pipeline || {};
  const total    = pipelineData?.data?.total || 0;

  const saveRoleFields = async (changes: Record<string, unknown>) => {
    await rolesApi.update(id!, changes);
    qc.invalidateQueries({ queryKey: ['role', id] });
  };

  const handleStatusUpdate = async () => {
    if (!statusValue) return;
    setSaving(true);
    try {
      await rolesApi.update(id!, { status: statusValue });
      toast.success(`Status updated to ${statusValue}`);
      setShowStatusModal(false);
      qc.invalidateQueries({ queryKey: ['role', id] });
    } catch { toast.error('Failed to update status'); }
    setSaving(false);
  };

  if (roleLoading) return <div className="flex justify-center p-12"><Spinner size="lg" /></div>;
  if (!role) return <EmptyState title="Role not found" />;

  const STAGE_ORDER = ['Applied','Resume Review','Shortlisted','Interview – Round 1',
    'Interview – Round 2','Interview – Round 3','Assignment Round','Final Evaluation',
    'Reference Check','Offer Discussion','Offer Released','Offer Accepted'];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link to="/roles" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-3">
          <ArrowLeft className="w-4 h-4" /> Roles
        </Link>
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold text-gray-900">{role.title}</h1>
              <PriorityBadge priority={role.priority} />
              <StageBadge stage={role.status} />
            </div>
            <div className="flex items-center gap-4 mt-1 text-sm text-gray-500">
              <span>{role.department}</span>
              <span>·</span>
              <span>{role.hiring_manager_name}</span>
              <span>·</span>
              <span>{role.location}</span>
              <span>·</span>
              <AgingBadge alert={role.aging_alert} days={role.days_open} />
            </div>
          </div>
          <div className="text-right shrink-0 space-y-2">
            <div>
              <div className="text-2xl font-bold text-gray-900">{total}</div>
              <div className="text-xs text-gray-500">active candidates</div>
            </div>
            {canHR && (
              <button
                onClick={() => { setStatusValue(role.status); setShowStatusModal(true); }}
                className="btn-secondary text-xs py-1.5 px-3"
              >
                Change status
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Role details — all fields inline-editable, per-section Save/Cancel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <EditableSection
          title="Basic Info"
          data={role}
          onSave={saveRoleFields}
          fields={[
            { key: 'title', label: 'Title', type: 'text' },
            { key: 'department', label: 'Department', type: 'text' },
            { key: 'hiring_manager_name', label: 'Hiring Manager', type: 'text' },
            { key: 'priority', label: 'Priority', type: 'select', options: ['P0', 'P1', 'P2', 'P3'] },
            { key: 'new_replacement', label: 'New / Replacement', type: 'select', options: ['New Position', 'Replacement'] },
            { key: 'replacement_reason', label: 'Replacement Reason', type: 'text' },
            { key: 'location', label: 'Location', type: 'text' },
            { key: 'employment_type', label: 'Employment Type', type: 'text' },
            { key: 'num_openings', label: 'Openings', type: 'number' },
          ]}
        />
        <EditableSection
          title="Requirements"
          data={role}
          onSave={saveRoleFields}
          fields={[
            { key: 'yoe_required', label: 'Experience', type: 'text' },
            { key: 'ctc_band', label: 'CTC Band', type: 'text', hidden: !canHR },
            { key: 'must_have_skills', label: 'Must-have skills', type: 'textarea' },
            { key: 'nice_to_have_skills', label: 'Nice-to-have skills', type: 'textarea' },
            { key: 'suggested_interviewers', label: 'Suggested Interviewers', type: 'text' },
            { key: 'assignment_required', label: 'Assignment Required', type: 'boolean' },
            { key: 'recruitment_mode', label: 'Recruitment Mode', type: 'tags' },
          ]}
        />
        <EditableSection
          title="Description"
          data={role}
          onSave={saveRoleFields}
          fields={[
            { key: 'job_description', label: 'Job Description', type: 'textarea' },
            { key: 'kpi_expectations', label: 'KPI Expectations', type: 'textarea' },
            { key: 'additional_remarks', label: 'Additional Remarks', type: 'textarea' },
          ]}
        />
        <EditableSection
          title="Dates"
          data={role}
          onSave={saveRoleFields}
          fields={[
            { key: 'start_date', label: 'Open Date', type: 'date' },
            { key: 'target_closure_date', label: 'Close Target', type: 'date' },
          ]}
        />
        <EditableSection
          title="Approval"
          data={role}
          onSave={saveRoleFields}
          fields={[
            { key: 'approver_name', label: 'Approver', type: 'text' },
            { key: 'approval_date', label: 'Approval Date', type: 'date' },
            { key: 'approval_note', label: 'Approval Note', type: 'textarea' },
          ]}
        />
        <EditableSection
          title="Links & Assets"
          data={role}
          onSave={saveRoleFields}
          pendingLabels={role.status === 'Approved' ? {
            jd_drive_link: 'Generating JD…',
            social_jd_drive_link: 'Generating social JD…',
          } : undefined}
          fields={[
            { key: 'jd_drive_link', label: 'Long-form JD', type: 'text', linkify: true },
            { key: 'social_jd_drive_link', label: 'Social JD', type: 'text', linkify: true },
            { key: 'whatsapp_forward_link', label: 'WhatsApp Forward Link', type: 'text', linkify: true },
            { key: 'referral_message_link', label: 'Referral Message Link', type: 'text', linkify: true },
            { key: 'approval_summary_link', label: 'Approval Summary Link', type: 'text', linkify: true },
            { key: 'posting_status', label: 'Posting Status', type: 'json' },
          ]}
        />
      </div>
      <div className="text-xs text-gray-400 -mt-2">
        Openings: {role.num_openings} · Assignment: {role.assignment_required ? 'Yes' : 'No'}
      </div>

      {/* Pipeline */}
      <div>
        <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <Users className="w-4 h-4 text-gray-400" />
          Pipeline
        </h2>
        {total === 0 ? (
          <div className="card p-8"><EmptyState title="No active candidates in this pipeline" /></div>
        ) : (
          <div className="space-y-3">
            {STAGE_ORDER.filter(s => pipeline[s]?.length).map(stage => (
              <div key={stage} className="card overflow-hidden">
                <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <StageBadge stage={stage} />
                    <span className="text-xs text-gray-500">{pipeline[stage].length} candidate{pipeline[stage].length !== 1 ? 's' : ''}</span>
                  </div>
                </div>
                <table className="w-full">
                  <tbody className="divide-y divide-gray-50">
                    {pipeline[stage].map(app => (
                      <tr key={app.id} className={`hover:bg-gray-50 ${app.sla_breach ? 'bg-red-50/20' : ''}`}>
                        <td className="table-td font-medium text-gray-900 w-56">
                          <Link to={`/candidates/${app.candidate_id}`} className="hover:text-dp-600">
                            {(app as Application & { candidate_name?: string }).candidate_name}
                          </Link>
                        </td>
                        <td className="table-td text-xs text-gray-500">{app.source_channel}</td>
                        <td className="table-td"><FitScore score={app.ai_fit_score} /></td>
                        <td className="table-td text-xs text-gray-400">{app.recruiter_screening_status}</td>
                        <td className="table-td">
                          {app.sla_breach && (
                            <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-medium">SLA</span>
                          )}
                        </td>
                        <td className="table-td">
                          <Link to={`/candidates/${app.candidate_id}`} className="text-gray-400 hover:text-dp-600">
                            <ChevronRight className="w-4 h-4" />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>

      {showStatusModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-base font-semibold">Update status</h3>
            <select value={statusValue} onChange={e => setStatusValue(e.target.value)} className="select">
              {ROLE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowStatusModal(false)} className="btn-secondary">Cancel</button>
              <button onClick={handleStatusUpdate} disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Update'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
