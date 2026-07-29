import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, ChevronRight } from 'lucide-react';
import { rolesApi } from '../services/api.ts';
import { Role, PRIORITIES, ROLE_STATUSES, LOCATIONS, DEPARTMENTS } from '../types/index.ts';
import { PriorityBadge, AgingBadge, StageBadge, Spinner, EmptyState } from '../components/shared/Badges.tsx';
import MultiSelectFilter from '../components/shared/MultiSelectFilter.tsx';
import { useAuth } from '../contexts/AuthContext.tsx';

export default function Roles() {
  const { canHR } = useAuth();
  const [departments, setDepartments] = useState<string[]>([]);
  const [locations,   setLocations]   = useState<string[]>([]);
  const [modes,       setModes]       = useState<string[]>([]);
  const [priorities,  setPriorities]  = useState<string[]>([]);
  // Defaults to the same "Active" scope the old status toggle defaulted to
  // (Live – Sourcing only) — an empty Status filter now means "all
  // statuses," so this preselection keeps first-load behavior unchanged.
  const [statuses,    setStatuses]    = useState<string[]>(['Live – Sourcing']);

  const { data: filterOptionsData } = useQuery<{ data: { recruitment_modes: string[] } }>({
    queryKey: ['roles', 'filter-options'],
    queryFn:  () => rolesApi.filterOptions(),
  });
  const modeOptions = filterOptionsData?.data?.recruitment_modes || [];

  const params: Record<string, string[]> = {};
  if (departments.length) params.department = departments;
  if (locations.length)   params.location = locations;
  if (modes.length)       params.recruitment_mode = modes;
  if (priorities.length)  params.priority = priorities;
  if (statuses.length)    params.status = statuses;

  const { data, isLoading } = useQuery<{ data: { roles: Role[] } }>({
    queryKey: ['roles', departments, locations, modes, priorities, statuses],
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
        <MultiSelectFilter label="Department"       options={DEPARTMENTS}       selected={departments} onChange={setDepartments} />
        <MultiSelectFilter label="Location"         options={LOCATIONS}         selected={locations}   onChange={setLocations} />
        <MultiSelectFilter label="Recruitment Mode" options={modeOptions}       selected={modes}        onChange={setModes} />
        <MultiSelectFilter label="Priority"         options={PRIORITIES}        selected={priorities}  onChange={setPriorities} />
        <MultiSelectFilter label="Status"           options={ROLE_STATUSES}     selected={statuses}    onChange={setStatuses} />
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
                {[
                  'Role', 'Priority', 'Department', 'Location', 'Openings', 'Age',
                  'Shortlisted', ...(canHR ? ['Salary Range'] : []), 'Candidates', 'Status', '',
                ].map(h => (
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
                  <td className="table-td"><PriorityBadge priority={role.priority} /></td>
                  <td className="table-td text-gray-500 text-xs">{role.department}</td>
                  <td className="table-td text-gray-500 text-xs">{role.location}</td>
                  <td className="table-td text-center">{role.num_openings}</td>
                  <td className="table-td text-center">
                    <AgingBadge alert={role.aging_alert} days={role.days_open} />
                  </td>
                  <td className="table-td text-center text-gray-500">{role.shortlisted_count ?? 0}</td>
                  {canHR && (
                    <td className="table-td text-gray-500 text-xs whitespace-nowrap">{role.ctc_band || '—'}</td>
                  )}
                  <td className="table-td text-center font-medium">
                    <span className={role.active_candidate_count === 0 ? 'text-red-500' : 'text-gray-900'}>
                      {role.active_candidate_count ?? 0}
                    </span>
                  </td>
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
