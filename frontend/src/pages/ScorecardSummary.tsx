import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { applicationsApi, rolesApi } from '../services/api.ts';
import { Application, PRIORITIES, APPLICATION_STATUSES, LOCATIONS, DEPARTMENTS } from '../types/index.ts';
import { Spinner, EmptyState, OverBudgetBadge } from '../components/shared/Badges.tsx';
import MultiSelectFilter from '../components/shared/MultiSelectFilter.tsx';
import StageChangeModal from '../components/shared/StageChangeModal.tsx';
import { isOverBudget, isWithinBudgetOrNear } from '../utils/budget.ts';

// Compact 0-10 dimension cell — mirrors ResumeIQPanel.tsx's private
// scoreColor() thresholds (copied, not imported: four lines, not worth a
// cross-component dependency for).
function ScoreCell({ score }: { score?: number }) {
  const color =
    score == null ? 'text-gray-300' :
    score >= 8    ? 'text-green-600 font-semibold' :
    score >= 6    ? 'text-dp-600 font-medium' :
    score >= 4    ? 'text-amber-600' :
    'text-red-500';
  return <span className={`text-xs ${color}`}>{score != null ? score : '—'}</span>;
}

// Mirrors ResumeIQPanel.tsx's private recColor mapping (copied, same reasoning).
function VerdictBadge({ recommendation }: { recommendation?: string }) {
  if (!recommendation) return <span className="text-xs text-gray-300">—</span>;
  const color =
    recommendation === 'Strong Yes' ? 'bg-green-100 text-green-800' :
    recommendation === 'Yes'        ? 'bg-dp-100 text-dp-800' :
    recommendation === 'Maybe'      ? 'bg-amber-100 text-amber-800' :
    'bg-red-100 text-red-800';
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${color}`}>{recommendation}</span>;
}

const DIMENSIONS: Array<{ key: keyof Application; label: string }> = [
  { key: 'score_technical',      label: 'Tech' },
  { key: 'score_experience',     label: 'Exp' },
  { key: 'score_industry_fit',   label: 'Ind' },
  { key: 'score_culture_fit',    label: 'Cult' },
  { key: 'score_role_alignment', label: 'Role' },
  { key: 'score_trajectory',     label: 'Traj' },
  { key: 'score_leadership',     label: 'Lead' },
  { key: 'score_communication',  label: 'Comm' },
];

export default function ScorecardSummary() {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  // Arriving from a role's detail page ("Scorecard Summary" button there)
  // pre-filters to that role — read once on mount; the Role MultiSelectFilter
  // below is the single source of truth after that (clearing it un-filters,
  // same as picking it manually would).
  const [roleIds,     setRoleIds]     = useState<string[]>(() => {
    const roleId = searchParams.get('role_id');
    return roleId ? [roleId] : [];
  });
  const [departments, setDepartments] = useState<string[]>([]);
  const [locations,   setLocations]   = useState<string[]>([]);
  const [modes,       setModes]       = useState<string[]>([]);
  const [priorities,  setPriorities]  = useState<string[]>([]);
  const [statuses,    setStatuses]    = useState<string[]>([]);
  const [filterInBudget, setFilterInBudget] = useState(false);
  const [expanded,    setExpanded]    = useState<Set<string>>(new Set());
  const [stageModalApp, setStageModalApp] = useState<Application | null>(null);

  const params: Record<string, string | string[]> = { limit: '100', scored_only: 'true' };
  if (roleIds.length)     params.role_id = roleIds;
  if (departments.length) params.department = departments;
  if (locations.length)   params.location = locations;
  if (modes.length)       params.recruitment_mode = modes;
  if (priorities.length)  params.priority = priorities;
  if (statuses.length)    params.status = statuses;

  const { data, isLoading } = useQuery<{ data: { applications: Application[] } }>({
    queryKey: ['applications', 'scorecard', roleIds, departments, locations, modes, priorities, statuses],
    queryFn:  () => applicationsApi.list(params),
  });
  const allApps = data?.data?.applications || [];
  // Client-side, same reasoning as Candidates.tsx's identical toggle —
  // role_ctc_band is freeform text, best parsed in JS.
  const apps = filterInBudget
    ? allApps.filter(a => isWithinBudgetOrNear(a.candidate_expected_ctc, a.role_ctc_band))
    : allApps;

  const { data: filterOptionsData } = useQuery<{ data: { recruitment_modes: string[]; roles: { id: string; title: string }[] } }>({
    queryKey: ['roles', 'filter-options'],
    queryFn:  () => rolesApi.filterOptions(),
  });
  const modeOptions = filterOptionsData?.data?.recruitment_modes || [];
  const roleOptions = (filterOptionsData?.data?.roles || []).map(r => ({ value: r.id, label: r.title }));

  const hasActiveFilters = roleIds.length || departments.length || locations.length || modes.length || priorities.length || statuses.length || filterInBudget;

  const toggleExpanded = (id: string) => setExpanded(prev => {
    const s = new Set(prev);
    s.has(id) ? s.delete(id) : s.add(id);
    return s;
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Scorecard Summary</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Every ResumeIQ-scored candidate, ranked and compared side by side — mirrors the
          digitalpaani-candidate-scoring skill's output format.
        </p>
        {roleIds.length === 1 && roleOptions.some(r => r.value === roleIds[0]) && (
          <div className="mt-2 inline-flex items-center gap-2 text-sm bg-dp-50 text-dp-800 px-3 py-1.5 rounded-lg">
            Filtered to <span className="font-medium">{roleOptions.find(r => r.value === roleIds[0])?.label}</span>
            <button onClick={() => setRoleIds([])} className="text-dp-600 hover:underline text-xs">View all roles</button>
          </div>
        )}
      </div>

      <div className="flex gap-1.5 flex-nowrap overflow-x-auto pb-1">
        <div className="shrink-0"><MultiSelectFilter label="Department"       options={DEPARTMENTS}          selected={departments} onChange={setDepartments} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Location"         options={LOCATIONS}            selected={locations}   onChange={setLocations} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Recruitment Mode" options={modeOptions}          selected={modes}        onChange={setModes} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Priority"         options={PRIORITIES}           selected={priorities}  onChange={setPriorities} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Status"           options={APPLICATION_STATUSES} selected={statuses}     onChange={setStatuses} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Role"             options={roleOptions}          selected={roleIds}      onChange={setRoleIds} /></div>
        <button
          onClick={() => setFilterInBudget(v => !v)}
          className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            filterInBudget ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
          }`}
        >
          In-budget only
        </button>
      </div>

      <div className="card overflow-x-auto">
        {isLoading ? (
          <div className="flex justify-center p-12"><Spinner size="lg" /></div>
        ) : apps.length === 0 ? (
          <div className="p-12">
            <EmptyState
              title={hasActiveFilters ? 'No scored candidates match these filters' : 'No scored candidates yet'}
            />
          </div>
        ) : (
          <table className="w-full table-fixed">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                {[
                  ['#', 'w-[32px]'], ['Candidate', 'w-[150px]'], ['Role', 'w-[120px]'],
                  ['Company / Industry', 'w-[140px]'], ['Notice', 'w-[55px]'], ['CTC → ECTC', 'w-[95px]'],
                  ...DIMENSIONS.map(d => [d.label, 'w-[42px]'] as [string, string]),
                  ['Avg', 'w-[45px]'], ['Verdict', 'w-[80px]'], ['Resume', 'w-[55px]'],
                  ['Stage', 'w-[110px]'], ['', 'w-[28px]'],
                ].map(([h, w]) => (
                  <th key={h} title={h} className={`table-th px-1.5 truncate tracking-normal ${w}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {apps.map((app, idx) => (
                <>
                  <tr key={app.id} className="hover:bg-gray-50 transition-colors">
                    <td className="table-td px-1.5 py-3 text-xs text-gray-400">{idx + 1}</td>
                    <td className="table-td px-1.5 py-3">
                      <Link to={`/candidates/${app.candidate_id}`} className="text-sm font-medium text-gray-900 hover:text-dp-600 block truncate">
                        {app.candidate_name}
                      </Link>
                      <div className="text-xs text-gray-400 truncate">{app.email}</div>
                    </td>
                    <td className="table-td px-1.5 py-3 truncate">
                      <Link to={`/roles/${app.role_id}`} className="text-xs text-gray-700 hover:text-dp-600 block truncate">
                        {app.role_title}
                      </Link>
                    </td>
                    <td className="table-td px-1.5 py-3 text-xs text-gray-500 truncate" title={`${app.candidate_company || '—'} / ${app.candidate_industry || '—'}`}>
                      {app.candidate_company || '—'} / {app.candidate_industry || '—'}
                    </td>
                    <td className="table-td px-1.5 py-3 text-xs text-gray-500 truncate">
                      {app.candidate_notice_period_days != null ? `${app.candidate_notice_period_days}d` : '—'}
                    </td>
                    <td className="table-td px-1.5 py-3 text-xs text-gray-500 truncate">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate">
                          {app.candidate_ctc_fixed ? `₹${app.candidate_ctc_fixed}L` : '—'}
                          {' → '}
                          {app.candidate_expected_ctc ? `₹${app.candidate_expected_ctc}L` : '—'}
                        </span>
                        <OverBudgetBadge overBudget={isOverBudget(app.candidate_expected_ctc, app.role_ctc_band)} />
                      </div>
                    </td>
                    {DIMENSIONS.map(d => (
                      <td key={d.key} className="table-td px-1.5 py-3 text-right"><ScoreCell score={app[d.key] as number | undefined} /></td>
                    ))}
                    <td className="table-td px-1.5 py-3 text-sm font-semibold text-gray-900">
                      {app.score_avg != null ? Number(app.score_avg).toFixed(1) : '—'}
                    </td>
                    <td className="table-td px-1.5 py-3"><VerdictBadge recommendation={app.score_recommendation} /></td>
                    <td className="table-td px-1.5 py-3 text-xs">
                      {app.candidate_resume_link ? (
                        <a href={app.candidate_resume_link} target="_blank" rel="noreferrer" className="text-dp-600 hover:underline">View</a>
                      ) : '—'}
                    </td>
                    <td className="table-td px-1.5 py-3">
                      <button onClick={() => setStageModalApp(app)} className="text-xs text-gray-600 hover:text-dp-600 underline truncate block">
                        {app.stage}
                      </button>
                    </td>
                    <td className="table-td px-1.5 py-3">
                      <button onClick={() => toggleExpanded(app.id)} className="text-gray-400 hover:text-dp-600">
                        {expanded.has(app.id) ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                    </td>
                  </tr>
                  {expanded.has(app.id) && (
                    <tr key={`${app.id}-detail`} className="bg-gray-50/60">
                      <td colSpan={6 + DIMENSIONS.length + 5} className="px-4 py-4">
                        <div className="grid grid-cols-3 gap-4">
                          <div>
                            <div className="text-xs text-green-600 font-medium mb-1">✓ Key strengths</div>
                            {app.score_strengths?.length ? (
                              <ul className="text-xs text-gray-600 space-y-0.5">
                                {app.score_strengths.map((s, i) => <li key={i}>• {s}</li>)}
                              </ul>
                            ) : <p className="text-xs text-gray-400">—</p>}
                          </div>
                          <div>
                            <div className="text-xs text-red-500 font-medium mb-1">⚠ Red flags</div>
                            {app.score_red_flags?.length ? (
                              <ul className="text-xs text-gray-600 space-y-0.5">
                                {app.score_red_flags.map((s, i) => <li key={i}>• {s}</li>)}
                              </ul>
                            ) : <p className="text-xs text-gray-400">None noted</p>}
                          </div>
                          <div>
                            <div className="text-xs text-gray-500 font-medium mb-1">Executive summary</div>
                            <p className="text-xs text-gray-600 leading-relaxed">{app.score_summary || '—'}</p>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {stageModalApp && (
        <StageChangeModal
          application={stageModalApp}
          onClose={() => setStageModalApp(null)}
          onUpdated={() => qc.invalidateQueries({ queryKey: ['applications'] })}
        />
      )}
    </div>
  );
}
