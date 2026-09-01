import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, ChevronRight, Search } from 'lucide-react';
import { rolesApi } from '../services/api.ts';
import { Role, PRIORITIES, ROLE_STATUSES, LOCATIONS, DEPARTMENTS } from '../types/index.ts';
import { PriorityBadge, AgingBadge, StageBadge, Spinner, EmptyState } from '../components/shared/Badges.tsx';
import InfoTooltip from '../components/shared/InfoTooltip.tsx';

const COLUMN_INFO: Record<string, string> = {
  'Age': 'Days overdue past this role\'s Close Target, and days since it opened — no alert shows at all until Close Target has actually passed.',
  'Active Shortlist': 'Candidates currently sitting at Interview Round 1 or later, still Active — not a historical total.',
  'Active Candidates': 'Everyone currently Active in this role\'s pipeline, at any stage — not a lifetime total.',
};
import MultiSelectFilter from '../components/shared/MultiSelectFilter.tsx';
import { useAuth } from '../contexts/AuthContext.tsx';
import { usePersistedState } from '../hooks/usePersistedState.ts';

export default function Roles() {
  const { canHR, user } = useAuth();
  // Leadership is already HR-tier (canHR) but still gets "Request Role"
  // wording, not "New Role" — the underlying action is identical (creates a
  // Draft role), only the framing differs per item #24. Hiring Manager gets
  // the same button newly, where previously they had none at all.
  const canCreateOrRequestRole = canHR || user?.persona === 'hiring_manager';
  const isRequestFraming = user?.persona === 'hiring_manager' || user?.persona === 'leadership';
  const [search,      setSearch]      = usePersistedState('roles.search', '');
  const [departments, setDepartments] = usePersistedState<string[]>('roles.departments', []);
  const [locations,   setLocations]   = usePersistedState<string[]>('roles.locations', []);
  const [modes,       setModes]       = usePersistedState<string[]>('roles.modes', []);
  const [priorities,  setPriorities]  = usePersistedState<string[]>('roles.priorities', []);
  // Defaults to the same "Active" scope the old status toggle defaulted to
  // (Live – Sourcing only) — an empty Status filter now means "all
  // statuses," so this preselection keeps first-load behavior unchanged.
  const [statuses,    setStatuses]    = usePersistedState<string[]>('roles.statuses', ['Live – Sourcing']);

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
  const filtered = search
    ? roles.filter(r => {
        const q = search.toLowerCase();
        return r.title?.toLowerCase().includes(q)
          || r.id?.toLowerCase().includes(q)
          || r.department?.toLowerCase().includes(q)
          || r.location?.toLowerCase().includes(q)
          || r.hiring_manager_name?.toLowerCase().includes(q)
          || r.status?.toLowerCase().includes(q);
      })
    : roles;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Roles</h1>
          <p className="text-sm text-gray-500 mt-0.5">{filtered.length} roles shown</p>
        </div>
        {canCreateOrRequestRole && (
          <Link to="/roles/new" className="btn-primary">
            <Plus className="w-4 h-4" /> {isRequestFraming ? 'Request role' : 'New role'}
          </Link>
        )}
      </div>

      {/* Search + filters */}
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            placeholder="Search by title, department, location, HM, status…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="input pl-9"
          />
        </div>
        <MultiSelectFilter label="Department"       options={DEPARTMENTS}       selected={departments} onChange={setDepartments} />
        <MultiSelectFilter label="Location"         options={LOCATIONS}         selected={locations}   onChange={setLocations} />
        <MultiSelectFilter label="Recruitment Mode" options={modeOptions}       selected={modes}        onChange={setModes} />
        <MultiSelectFilter label="Priority"         options={PRIORITIES}        selected={priorities}  onChange={setPriorities} />
        <MultiSelectFilter label="Status"           options={ROLE_STATUSES}     selected={statuses}    onChange={setStatuses} />
      </div>

      {/* Table — overflow-x-auto (not overflow-hidden) so a narrow viewport
          scrolls horizontally instead of silently clipping the last
          columns with no way to reach them. */}
      <div className="card overflow-x-auto">
        {isLoading ? (
          <div className="flex justify-center p-12"><Spinner size="lg" /></div>
        ) : filtered.length === 0 ? (
          <div className="p-12"><EmptyState title="No roles match this filter" /></div>
        ) : (
          <table className="w-full">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                {[
                  'Role', 'Priority', 'Department', 'Location', 'Openings', 'Age',
                  'Active Candidates', 'Active Shortlist', ...(canHR ? ['Salary Range'] : []), 'Status', '',
                ].map(h => (
                  <th
                    key={h}
                    className={`table-th ${h === 'Location' ? 'pr-1' : h === 'Openings' ? 'pl-1' : ''}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {h}
                      {COLUMN_INFO[h] && <InfoTooltip text={COLUMN_INFO[h]} />}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.map(role => (
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
                  <td className="table-td text-gray-500 text-xs pr-1">{role.location}</td>
                  <td className="table-td text-center pl-1">{role.num_openings}</td>
                  <td className="table-td text-center">
                    <AgingBadge alert={role.aging_alert} daysOpen={role.days_open} daysOverdue={role.days_overdue} />
                  </td>
                  <td className="table-td text-center font-medium">
                    <span className={role.active_candidate_count === 0 ? 'text-red-500' : 'text-gray-900'}>
                      {role.active_candidate_count ?? 0}
                    </span>
                  </td>
                  <td className="table-td text-center text-gray-500">{role.shortlisted_count ?? 0}</td>
                  {canHR && (
                    <td className="table-td text-gray-500 text-xs whitespace-nowrap">{role.ctc_band || '—'}</td>
                  )}
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
