import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { candidatesApi } from '../services/api.ts';
import { Candidate } from '../types/index.ts';
import { StageBadge, StatusBadge, FitScore, Spinner, EmptyState } from '../components/shared/Badges.tsx';
import LinkToRoleModal from '../components/shared/LinkToRoleModal.tsx';
import { useAuth } from '../contexts/AuthContext.tsx';
import { formatDistanceToNow } from 'date-fns';

type Mode = 'hold_for_future' | 'archived';
const LIMIT = 50;

export default function TalentPool() {
  const { canHR } = useAuth();
  const qc = useQueryClient();

  const [mode,         setMode]         = useState<Mode>('hold_for_future');
  const [searchInput,  setSearchInput]  = useState('');
  const [search,       setSearch]       = useState('');
  const [tag,          setTag]          = useState('');
  const [skills,       setSkills]       = useState('');
  const [industry,     setIndustry]     = useState('');
  const [offset,       setOffset]       = useState(0);
  const [items,        setItems]        = useState<Candidate[]>([]);
  const [total,        setTotal]        = useState(0);
  const [linkCandidate, setLinkCandidate] = useState<Candidate | null>(null);

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
  if (search)   params.q = search;
  if (tag)      params.tag = tag;
  if (industry) params.industry = industry;
  if (skills)   params.skills = skills.split(',').map(s => s.trim()).filter(Boolean);

  const { data, isLoading } = useQuery<{ data: { candidates: Candidate[]; total: number } }>({
    queryKey: ['talent-pool', mode, search, tag, skills, industry, offset],
    queryFn:  () => candidatesApi.list(params),
  });

  useEffect(() => {
    if (!data?.data) return;
    const page = data.data.candidates || [];
    setItems(prev => (offset === 0 ? page : [...prev, ...page]));
    setTotal(data.data.total || 0);
  }, [data]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Talent Pool</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          {mode === 'hold_for_future'
            ? `${total} on hold for future roles`
            : `${total} archived candidates (rejected/withdrawn, 90+ days)`}
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
      </div>

      {/* Results */}
      {isLoading && offset === 0 ? (
        <div className="flex justify-center p-12"><Spinner size="lg" /></div>
      ) : items.length === 0 ? (
        <div className="card p-12">
          <EmptyState
            title={mode === 'hold_for_future' ? 'No candidates on hold for future roles' : 'No archived candidates match your filters'}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(c => (
            <div key={c.id} className="card p-5 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <Link to={`/candidates/${c.id}`} className="font-medium text-gray-900 hover:text-dp-600">
                    {c.full_name}
                  </Link>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-400 flex-wrap">
                    {c.email && <span>{c.email}</span>}
                    {c.phone && <span>· {c.phone}</span>}
                  </div>
                  {c.hr_tags && c.hr_tags.length > 0 && (
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {c.hr_tags.map(t => (
                        <span key={t} className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{t}</span>
                      ))}
                    </div>
                  )}
                </div>
                {canHR && (
                  <button
                    onClick={() => setLinkCandidate(c)}
                    className="btn-secondary text-xs py-1.5 px-3 shrink-0"
                  >
                    Reactivate
                  </button>
                )}
              </div>

              {c.applications && c.applications.length > 0 && (
                <div className="divide-y divide-gray-50 border-t border-gray-100 pt-2">
                  {c.applications.map(a => (
                    <div key={a.id} className="flex items-center justify-between gap-3 py-1.5">
                      <Link
                        to={`/roles/${a.role_id}`}
                        className="text-sm text-gray-700 hover:text-dp-600 truncate max-w-[220px]"
                      >
                        {a.role_title}
                      </Link>
                      <div className="flex items-center gap-2 shrink-0">
                        <StageBadge stage={a.stage} />
                        <StatusBadge status={a.status} />
                        <FitScore score={a.ai_fit_score} />
                        <span className="text-xs text-gray-400 whitespace-nowrap">
                          {a.last_updated ? formatDistanceToNow(new Date(a.last_updated), { addSuffix: true }) : '—'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {items.length < total && (
            <div className="flex justify-center pt-2">
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
