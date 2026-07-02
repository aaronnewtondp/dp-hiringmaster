import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Users, ChevronRight } from 'lucide-react';
import { rolesApi } from '../services/api.ts';
import { Role, Application } from '../types/index.ts';
import { PriorityBadge, AgingBadge, StageBadge, FitScore, Spinner, EmptyState } from '../components/shared/Badges.tsx';

export default function RoleDetail() {
  const { id } = useParams<{ id: string }>();

  const { data: roleData, isLoading: roleLoading } = useQuery<{ data: { role: Role } }>({
    queryKey: ['role', id],
    queryFn:  () => rolesApi.get(id!),
  });

  const { data: pipelineData } = useQuery<{ data: { pipeline: Record<string, Application[]>; total: number } }>({
    queryKey: ['role-pipeline', id],
    queryFn:  () => rolesApi.pipeline(id!),
  });

  const role     = roleData?.data?.role;
  const pipeline = pipelineData?.data?.pipeline || {};
  const total    = pipelineData?.data?.total || 0;

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
          <div className="text-right">
            <div className="text-2xl font-bold text-gray-900">{total}</div>
            <div className="text-xs text-gray-500">active candidates</div>
          </div>
        </div>
      </div>

      {/* Role details */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-900">Requirements</h2>
          <div>
            <div className="text-xs text-gray-400 mb-1">Must-have skills</div>
            <div className="text-sm text-gray-700">{role.must_have_skills || '—'}</div>
          </div>
          <div>
            <div className="text-xs text-gray-400 mb-1">Experience</div>
            <div className="text-sm text-gray-700">{role.yoe_required || '—'}</div>
          </div>
          {role.ctc_band && (
            <div>
              <div className="text-xs text-gray-400 mb-1">CTC Band</div>
              <div className="text-sm text-gray-700">{role.ctc_band}</div>
            </div>
          )}
        </div>
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">KPI Expectations</h2>
          <p className="text-sm text-gray-700 leading-relaxed">{role.kpi_expectations || '—'}</p>
        </div>
        <div className="card p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-900">Links & Assets</h2>
          {role.jd_drive_link ? (
            <a href={role.jd_drive_link} target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-2 text-sm text-dp-600 hover:underline">
              <ExternalLink className="w-3.5 h-3.5" /> Long-form JD
            </a>
          ) : <div className="text-sm text-gray-400">JD not generated yet</div>}
          <div className="text-xs text-gray-400">
            Open: {role.start_date} · Close target: {role.target_closure_date}
          </div>
          <div className="text-xs text-gray-400">
            Openings: {role.num_openings} · Assignment: {role.assignment_required ? 'Yes' : 'No'}
          </div>
        </div>
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
    </div>
  );
}
