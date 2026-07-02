import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, ChevronRight } from 'lucide-react';
import { rolesApi } from '../services/api.ts';
import { Role, Priority } from '../types/index.ts';
import { PriorityBadge, AgingBadge, StageBadge, Spinner, EmptyState } from '../components/shared/Badges.tsx';
import { useAuth } from '../contexts/AuthContext.tsx';

const PRIORITIES: Priority[] = ['P0','P1','P2','P3'];

export default function Roles() {
  const { canHR } = useAuth();
  const [filterPriority, setFilterPriority] = useState<string>('all');
  const [filterStatus,   setFilterStatus]   = useState<string>('active');

  const params: Record<string,string> = {};
  if (filterPriority !== 'all') params.priority = filterPriority;
  if (filterStatus === 'active') params.status = 'Live – Sourcing';

  const { data, isLoading } = useQuery<{ data: { roles: Role[] } }>({
    queryKey: ['roles', filterPriority, filterStatus],
    queryFn:  () => rolesApi.list(params),
  });

  const roles = data?.data?.roles || [];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Roles</h1>
          <p className="text-sm text-gray-500 mt-0.5">{roles.length} roles shown</p>
        </div>
        {canHR && (
          <Link to="/roles/new" className="btn-primary">
            <Plus className="w-4 h-4" /> New role
          </Link>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <div className="flex items-center gap-1 bg-white rounded-lg border border-gray-200 p-1">
          {(['all', ...PRIORITIES]).map(p => (
            <button
              key={p}
              onClick={() => setFilterPriority(p)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                filterPriority === p
                  ? 'bg-dp-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {p === 'all' ? 'All' : p}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 bg-white rounded-lg border border-gray-200 p-1">
          {[{v:'active',l:'Active'},{v:'all',l:'All statuses'}].map(({v,l}) => (
            <button
              key={v}
              onClick={() => setFilterStatus(v)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                filterStatus === v ? 'bg-dp-600 text-white' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center p-12"><Spinner size="lg" /></div>
        ) : roles.length === 0 ? (
          <div className="p-12"><EmptyState title="No roles match this filter" /></div>
        ) : (
          <table className="w-full">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                {['Role','Dept','Priority','HM','Openings','Age','Alert','Candidates','Shortlisted','Status',''].map(h => (
                  <th key={h} className="table-th">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {roles.map(role => (
                <tr key={role.id} className={`hover:bg-gray-50 transition-colors ${
                  role.aging_alert === 'red' ? 'bg-red-50/40' :
                  role.aging_alert === 'yellow' ? 'bg-amber-50/40' : ''
                }`}>
                  <td className="table-td">
                    <Link to={`/roles/${role.id}`} className="font-medium text-gray-900 hover:text-dp-600 transition-colors">
                      {role.title}
                    </Link>
                    <div className="text-xs text-gray-400">{role.id}</div>
                  </td>
                  <td className="table-td text-gray-500 text-xs">{role.department}</td>
                  <td className="table-td"><PriorityBadge priority={role.priority} /></td>
                  <td className="table-td text-xs text-gray-500 whitespace-nowrap">{role.hiring_manager_name}</td>
                  <td className="table-td text-center">{role.num_openings}</td>
                  <td className="table-td text-center">
                    <AgingBadge alert={role.aging_alert} days={role.days_open} />
                  </td>
                  <td className="table-td">
                    {role.aging_alert === 'red' && <span className="text-xs text-red-600">🔴 Red</span>}
                    {role.aging_alert === 'yellow' && <span className="text-xs text-amber-600">🟡 Yellow</span>}
                    {role.aging_alert === 'ok' && <span className="text-xs text-green-600">✓</span>}
                  </td>
                  <td className="table-td text-center font-medium">
                    <span className={role.active_candidate_count === 0 ? 'text-red-500' : 'text-gray-900'}>
                      {role.active_candidate_count ?? 0}
                    </span>
                  </td>
                  <td className="table-td text-center text-gray-500">{role.shortlisted_count ?? 0}</td>
                  <td className="table-td"><StageBadge stage={role.status} /></td>
                  <td className="table-td">
                    <Link to={`/roles/${role.id}`} className="text-gray-400 hover:text-dp-600 transition-colors">
                      <ChevronRight className="w-4 h-4" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
