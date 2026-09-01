import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Search, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { candidatesApi, rolesApi } from '../services/api.ts';
import { Candidate, DEPARTMENTS, LOCATIONS } from '../types/index.ts';
import { StageBadge, StatusBadge, FitScore, Spinner, EmptyState } from '../components/shared/Badges.tsx';
import LinkToRoleModal from '../components/shared/LinkToRoleModal.tsx';
import MultiSelectFilter from '../components/shared/MultiSelectFilter.tsx';
import { useAuth } from '../contexts/AuthContext.tsx';
import { usePersistedState } from '../hooks/usePersistedState.ts';
import { formatDistanceToNow } from 'date-fns';
import InfoTooltip from '../components/shared/InfoTooltip.tsx';

type Mode = 'hold_for_future' | 'archived';
const LIMIT = 50;

const COLUMN_INFO: Record<string, string> = {
  'Status': "The application's Active/Hold for Future/Rejected/Withdrawn status — this is why the row is in Talent Pool.",
  'Application Date': 'Days since the candidate applied to this specific role.',
  'Last Added': "When this candidate/application pair last had activity — same underlying data as Candidates' Last Updated, just relabeled here.",
};

// One row per (candidate, application) — same flattening Candidates.tsx uses
// for its own table, so the two pages share a row-level column model (item
// #8.2). A candidate lands in this pool if ANY of their applications match
// the current mode (backend's own EXISTS filter), but every application of
// that candidate is still shown, preserving this page's original "show full
// history, not just the flagged one" behavior from the old card layout.
type TalentPoolRow = { candidate: Candidate; app: NonNullable<Candidate['applications']>[number] };

// Same three sortable columns as Candidates.tsx (item #7), applied to the
// analogous fields here — client-side over whatever page of rows is
// currently loaded, same reasoning as Candidates.tsx's own sort.
type SortKey = 'fit' | 'application_date' | 'last_added';

export default function TalentPool() {
  const { canHR } = useAuth();
  const qc = useQueryClient();

  const [mode,         setMode]         = usePersistedState<Mode>('talentpool.mode', 'hold_for_future');
  const [searchInput,  setSearchInput]  = usePersistedState('talentpool.search', '');
  const [search,       setSearch]       = useState(searchInput);
  const [tag,          setTag]          = usePersistedState('talentpool.tag', '');
  const [skills,       setSkills]       = usePersistedState('talentpool.skills', '');
  const [industry,     setIndustry]     = usePersistedState('talentpool.industry', '');
  const [departments,  setDepartments]  = usePersistedState<string[]>('talentpool.departments', []);
  const [locations,    setLocations]    = usePersistedState<string[]>('talentpool.locations', []);
  const [roleIds,      setRoleIds]      = usePersistedState<string[]>('talentpool.roleIds', []);
  const [offset,       setOffset]       = useState(0);
  const [items,        setItems]        = useState<Candidate[]>([]);
  const [total,        setTotal]        = useState(0);
  const [linkCandidate, setLinkCandidate] = useState<Candidate | null>(null);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  // Debounced free-text search — this is the first filter in the app that
  // hits the backend on every keystroke rather than filtering an
  // already-fetched array, so it needs its own debounce (nothing else here
  // debounces today).
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput); setOffset(0); }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  function resetAndSet<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setOffset(0); };
  }

  const params: Record<string, string | string[]> = {
    limit: String(LIMIT), offset: String(offset), [mode]: 'true',
  };
  if (search)          params.q = search;
  if (tag)             params.tag = tag;
  if (industry)        params.industry = industry;
  if (skills)          params.skills = skills.split(',').map(s => s.trim()).filter(Boolean);
  if (departments.length) params.department = departments;
  if (locations.length)   params.location = locations;
  if (roleIds.length)      params.role_id = roleIds;

  const { data, isLoading } = useQuery<{ data: { candidates: Candidate[]; total: number } }>({
    queryKey: ['talent-pool', mode, search, tag, skills, industry, departments, locations, roleIds, offset],
    queryFn:  () => candidatesApi.list(params),
  });

  // Role master filter — same shared endpoint Dashboard/Roles/Candidates use,
  // non-Closed roles only, auto-updated whenever a role is created/closed.
  const { data: roleFilterOptions } = useQuery<{ data: { roles: { id: string; title: string }[] } }>({
    queryKey: ['roles', 'filter-options'],
    queryFn:  () => rolesApi.filterOptions(),
  });
  const roleOptions = (roleFilterOptions?.data?.roles || []).map(r => ({ value: r.id, label: r.title }));

  useEffect(() => {
    if (!data?.data) return;
    const page = data.data.candidates || [];
    setItems(prev => (offset === 0 ? page : [...prev, ...page]));
    setTotal(data.data.total || 0);
  }, [data]);

  const rows: TalentPoolRow[] = items.flatMap(c =>
    (c.applications || []).map(app => ({ candidate: c, app }))
  );
  const sortValue = (row: TalentPoolRow, key: SortKey): number => {
    if (key === 'fit') return row.app.ai_fit_score ?? -Infinity;
    const raw = key === 'application_date' ? row.app.application_date : row.app.last_updated;
    return raw ? new Date(raw).getTime() : -Infinity;
  };
  const sortedRows = sortKey
    ? [...rows].sort((a, b) => (sortDir === 'desc' ? 1 : -1) * (sortValue(b, sortKey) - sortValue(a, sortKey)))
    : rows;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Talent Pool</h1>
        <p className="text-sm font-mono text-gray-500 mt-0.5">
          {mode === 'hold_for_future'
            ? `${total} on hold for future roles`
            : `${total} archived candidates (rejected/withdrawn)`}
        </p>
      </div>

      {/* Mode toggle */}
      <div className="flex gap-2">
        {(['hold_for_future', 'archived'] as Mode[]).map(m => (
          <button
            key={m}
            onClick={() => resetAndSet<Mode>(setMode)(m)}
            className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
              mode === m ? 'bg-dp-600 text-white border-dp-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {m === 'hold_for_future' ? 'Hold for Future' : 'Archived'}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            placeholder="Search by name, email, or phone…"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="input pl-9"
          />
        </div>
        <input
          placeholder="Tag"
          value={tag}
          onChange={e => resetAndSet<string>(setTag)(e.target.value)}
          className="input w-36"
        />
        <input
          placeholder="Skills (comma-separated)"
          title="Exact match against parsed résumé data — may return no results until résumé parsing populates this field"
          value={skills}
          onChange={e => resetAndSet<string>(setSkills)(e.target.value)}
          className="input w-52"
        />
        <input
          placeholder="Industry"
          title="Exact match against parsed résumé data — may return no results until résumé parsing populates this field"
          value={industry}
          onChange={e => resetAndSet<string>(setIndustry)(e.target.value)}
          className="input w-36"
        />
        <MultiSelectFilter label="Department" options={DEPARTMENTS} selected={departments} onChange={resetAndSet<string[]>(setDepartments)} />
        <MultiSelectFilter label="Location"   options={LOCATIONS}   selected={locations}   onChange={resetAndSet<string[]>(setLocations)} />
        <MultiSelectFilter label="Role"       options={roleOptions} selected={roleIds}     onChange={resetAndSet<string[]>(setRoleIds)} />
      </div>

      {/* Results — table, same column model as Candidates.tsx (item #8.2):
          Candidate, Role, Stage, Status, Fit, CTC → ECTC, Notice, Preferred
          Location, Company / Industry, Resume Link, Application Date, Last
          Added (= last_updated, just relabeled since this page reads as
          "when this candidate's application last moved" rather than "last
          edited"), Actions. */}
      {isLoading && offset === 0 ? (
        <div className="flex justify-center p-12"><Spinner size="lg" /></div>
      ) : rows.length === 0 ? (
        <div className="card p-12">
          <EmptyState
            title={mode === 'hold_for_future' ? 'No candidates on hold for future roles' : 'No archived candidates match your filters'}
          />
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full table-fixed">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                {[
                  { label: 'Candidate', width: 'w-[150px]' },
                  { label: 'Role', width: 'w-[100px]' },
                  { label: 'Stage', width: 'w-[90px]' },
                  { label: 'Status', width: 'w-[90px]' },
                  { label: 'Fit', width: 'w-[64px]', sortKey: 'fit' as const },
                  { label: 'CTC → ECTC', width: 'w-[105px]' },
                  { label: 'Notice', width: 'w-[55px]' },
                  { label: 'Preferred Location', width: 'w-[110px]' },
                  { label: 'Company / Industry', width: 'w-[150px]' },
                  { label: 'Resume Link', width: 'w-[68px]' },
                  { label: 'Application Date', width: 'w-[122px]', sortKey: 'application_date' as const },
                  { label: 'Last Added', width: 'w-[100px]', sortKey: 'last_added' as const },
                  { label: 'Actions', width: 'w-[90px]' },
                ].map(col => (
                  // overflow-hidden unconditional — see Candidates.tsx's own
                  // header cells for why (a too-wide label used to visually
                  // bleed into the next column's header).
                  <th key={col.label} title={col.label} className={`table-th px-2 tracking-normal overflow-hidden ${col.width}`}>
                    <div className="flex items-center gap-1 min-w-0">
                      {col.sortKey ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(col.sortKey)}
                          className="flex items-center gap-1 min-w-0 hover:text-dp-600 transition-colors group"
                        >
                          <span className="truncate">{col.label}</span>
                          {sortKey === col.sortKey ? (
                            sortDir === 'asc'
                              ? <ChevronUp className="w-3.5 h-3.5 shrink-0 text-dp-600" strokeWidth={3} />
                              : <ChevronDown className="w-3.5 h-3.5 shrink-0 text-dp-600" strokeWidth={3} />
                          ) : (
                            <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 text-gray-400 group-hover:text-dp-500" strokeWidth={2.5} />
                          )}
                        </button>
                      ) : (
                        <span className="truncate">{col.label}</span>
                      )}
                      {COLUMN_INFO[col.label] && <InfoTooltip text={COLUMN_INFO[col.label]} width="w-60" />}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sortedRows.map(({ candidate: c, app: a }) => (
                <tr key={a.id} className="hover:bg-gray-50 transition-colors">
                  <td className="table-td px-2 py-4">
                    <div className="min-w-0">
                      <Link to={`/candidates/${c.id}`} className="font-medium text-gray-900 hover:text-dp-600 block truncate">
                        {c.full_name}
                      </Link>
                      {c.hr_tags && c.hr_tags.length > 0 && (
                        <div className="flex gap-1 mt-0.5 flex-wrap">
                          {c.hr_tags.map(t => (
                            <span key={t} className="text-[10px] bg-gray-100 text-gray-600 px-1 rounded">{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="table-td px-2 py-4 truncate">
                    <Link to={`/roles/${a.role_id}`} className="text-sm text-gray-700 hover:text-dp-600 block truncate">
                      {a.role_title}
                    </Link>
                  </td>
                  <td className="table-td px-2 py-4"><StageBadge stage={a.stage} /></td>
                  <td className="table-td px-2 py-4"><StatusBadge status={a.status} /></td>
                  <td className="table-td px-2 py-4"><FitScore score={a.ai_fit_score} /></td>
                  <td className="table-td px-2 py-4 text-xs text-gray-500 truncate font-mono">
                    {c.current_ctc_fixed ? `₹${c.current_ctc_fixed}L` : '—'}
                    {' → '}
                    {c.expected_ctc ? `₹${c.expected_ctc}L` : '—'}
                  </td>
                  <td className="table-td px-2 py-4 text-xs font-mono text-gray-500 truncate">
                    {c.notice_period_days != null ? `${c.notice_period_days}d` : '—'}
                  </td>
                  <td className="table-td px-2 py-4 text-xs text-gray-500 truncate" title={a.preferred_location || ''}>
                    {a.preferred_location || '—'}
                  </td>
                  <td className="table-td px-2 py-4 text-xs text-gray-500 truncate" title={`${c.current_company || '—'} / ${c.current_industry || '—'}`}>
                    {c.current_company || '—'} / {c.current_industry || '—'}
                  </td>
                  <td className="table-td px-2 py-4 text-xs truncate">
                    {c.resume_drive_link ? (
                      <a href={c.resume_drive_link} target="_blank" rel="noreferrer" className="text-dp-600 hover:underline">View</a>
                    ) : '—'}
                  </td>
                  <td className="table-td px-2 py-4 text-xs font-mono text-gray-500 truncate">
                    {a.application_date ? `${Math.floor((Date.now() - new Date(a.application_date).getTime()) / 86400000)}d ago` : '—'}
                  </td>
                  <td className="table-td px-2 py-4 text-xs text-gray-400 truncate">
                    {a.last_updated ? formatDistanceToNow(new Date(a.last_updated), { addSuffix: true }) : '—'}
                  </td>
                  <td className="table-td px-2 py-4">
                    {canHR && (
                      <button onClick={() => setLinkCandidate(c)} className="btn-secondary text-xs py-1 px-2.5 whitespace-nowrap">
                        Reactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {items.length < total && (
            <div className="flex justify-center py-3 border-t border-gray-100">
              <button onClick={() => setOffset(o => o + LIMIT)} className="btn-secondary text-sm">
                Load more
              </button>
            </div>
          )}
        </div>
      )}

      {linkCandidate && (
        <LinkToRoleModal
          candidate={linkCandidate}
          excludeRoleIds={(linkCandidate.applications || []).map(a => a.role_id)}
          sourceChannel="Talent Pool Reactivation"
          onClose={() => setLinkCandidate(null)}
          onLinked={() => qc.invalidateQueries({ queryKey: ['talent-pool'] })}
        />
      )}
    </div>
  );
}
