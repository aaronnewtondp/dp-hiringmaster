import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Search, Plus, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react';
import toast from 'react-hot-toast';
import { applicationsApi, candidatesApi, rolesApi } from '../services/api.ts';
import { Application, Candidate, Role, STAGES } from '../types/index.ts';
import { StageBadge, StatusBadge, FitScore, SlaBadge, Spinner, EmptyState, PriorityBadge } from '../components/shared/Badges.tsx';
import { useAuth } from '../contexts/AuthContext.tsx';
import { formatDistanceToNow } from 'date-fns';

export default function Candidates() {
  const { canHR } = useAuth();
  const qc = useQueryClient();
  const [search,      setSearch]      = useState('');
  const [filterStage, setFilterStage] = useState('all');
  const [filterSla,   setFilterSla]   = useState(false);
  const [showUnlinked, setShowUnlinked] = useState(true);
  const [linkCandidate, setLinkCandidate] = useState<Candidate | null>(null);
  const [roleId, setRoleId] = useState('');
  const [linking, setLinking] = useState(false);

  const params: Record<string,string> = { limit: '100' };
  if (filterStage !== 'all') params.stage  = filterStage;
  if (filterSla)             params.sla_breach = 'true';

  const { data, isLoading } = useQuery<{ data: { applications: Application[] } }>({
    queryKey: ['applications', filterStage, filterSla],
    queryFn:  () => applicationsApi.list(params),
  });

  // Candidates.tsx's main table is application-row driven, so a candidate
  // with zero applications (e.g. an ingested candidate whose "role applying
  // for" answer didn't match any open role) never shows up there — surfaced
  // separately here via the same GET /api/candidates the Candidate detail
  // page already uses.
  const { data: candidatesData } = useQuery<{ data: { candidates: Candidate[] } }>({
    queryKey: ['candidates', 'unlinked'],
    queryFn:  () => candidatesApi.list({ limit: '100' }),
  });
  const unlinked = (candidatesData?.data?.candidates || []).filter(c => !c.applications || c.applications.length === 0);

  const { data: rolesData } = useQuery<{ data: { roles: Role[] } }>({
    queryKey: ['roles', 'active'],
    queryFn:  () => rolesApi.list({ status: 'Live – Sourcing' }),
  });
  const roles = rolesData?.data?.roles || [];

  const handleLinkRole = async () => {
    if (!linkCandidate || !roleId) return;
    setLinking(true);
    try {
      await candidatesApi.linkRole(linkCandidate.id, { role_id: roleId, source_channel: 'Job Application Form' });
      toast.success('Candidate linked to role');
      setLinkCandidate(null);
      setRoleId('');
      qc.invalidateQueries({ queryKey: ['candidates', 'unlinked'] });
      qc.invalidateQueries({ queryKey: ['applications'] });
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error || 'Failed to link candidate');
    }
    setLinking(false);
  };

  const all = data?.data?.applications || [];
  const filtered = search
    ? all.filter(a =>
        a.candidate_name?.toLowerCase().includes(search.toLowerCase()) ||
        a.role_title?.toLowerCase().includes(search.toLowerCase())
      )
    : all;

  const slaCount = all.filter(a => a.sla_breach).length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Candidates</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {filtered.length} applications
            {slaCount > 0 && <span className="ml-2 text-red-500 font-medium">{slaCount} SLA breached</span>}
          </p>
        </div>
        {canHR && (
          <Link to="/candidates/new" className="btn-primary">
            <Plus className="w-4 h-4" /> Add candidate
          </Link>
        )}
      </div>

      {unlinked.length > 0 && (
        <div className="card overflow-hidden border-amber-200">
          <button
            onClick={() => setShowUnlinked(v => !v)}
            className="w-full px-5 py-3 flex items-center justify-between hover:bg-amber-50/50 transition-colors"
          >
            <h2 className="text-sm font-semibold text-amber-800">Unlinked candidates ({unlinked.length})</h2>
            {showUnlinked ? <ChevronUp className="w-4 h-4 text-amber-600" /> : <ChevronDown className="w-4 h-4 text-amber-600" />}
          </button>
          {showUnlinked && (
            <div className="divide-y divide-gray-50 border-t border-amber-100">
              {unlinked.map(c => (
                <div key={c.id} className="px-5 py-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <Link to={`/candidates/${c.id}`} className="font-medium text-gray-900 hover:text-dp-600 text-sm">{c.full_name}</Link>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-400 flex-wrap">
                      {c.email && <span>{c.email}</span>}
                      {c.phone && <span>· {c.phone}</span>}
                      <span>· added {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}</span>
                    </div>
                  </div>
                  {canHR && (
                    <button onClick={() => setLinkCandidate(c)} className="btn-secondary text-xs py-1.5 px-3 shrink-0">
                      Link to role
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Search + filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            placeholder="Search by name or role…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="input pl-9"
          />
        </div>
        <select
          value={filterStage}
          onChange={e => setFilterStage(e.target.value)}
          className="select w-48"
        >
          <option value="all">All stages</option>
          {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button
          onClick={() => setFilterSla(v => !v)}
          className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
            filterSla ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
          }`}
        >
          SLA breached only
        </button>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center p-12"><Spinner size="lg" /></div>
        ) : filtered.length === 0 ? (
          <div className="p-12"><EmptyState title="No candidates match" /></div>
        ) : (
          <table className="w-full">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                {['Candidate','Role','Stage','Screening','Fit','Source','CTC → ECTC','Notice','Updated',''].map(h => (
                  <th key={h} className="table-th">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.map(app => (
                <tr key={app.id} className={`hover:bg-gray-50 transition-colors ${app.sla_breach ? 'bg-red-50/30' : ''}`}>
                  <td className="table-td">
                    <div className="flex items-center gap-2">
                      <div>
                        <Link to={`/candidates/${app.candidate_id}`} className="font-medium text-gray-900 hover:text-dp-600">
                          {app.candidate_name}
                        </Link>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className="text-xs text-gray-400">{app.id}</span>
                          <SlaBadge breached={app.sla_breach} />
                          {app.founder_review_flag && (
                            <span className="text-xs bg-purple-100 text-purple-700 px-1 rounded">Founder</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="table-td">
                    <Link to={`/roles/${app.role_id}`} className="text-sm text-gray-700 hover:text-dp-600 block max-w-[140px] truncate">
                      {app.role_title}
                    </Link>
                    {app.role_priority && <PriorityBadge priority={app.role_priority} />}
                  </td>
                  <td className="table-td"><StageBadge stage={app.stage} /></td>
                  <td className="table-td">
                    <span className="text-xs text-gray-500">{app.recruiter_screening_status}</span>
                  </td>
                  <td className="table-td"><FitScore score={app.ai_fit_score} /></td>
                  <td className="table-td text-xs text-gray-500">{app.source_channel || '—'}</td>
                  <td className="table-td text-xs text-gray-500 whitespace-nowrap">
                    {app.candidate_ctc_fixed ? `₹${app.candidate_ctc_fixed}L` : '—'}
                    {' → '}
                    {app.candidate_expected_ctc ? `₹${app.candidate_expected_ctc}L` : '—'}
                  </td>
                  <td className="table-td text-xs text-gray-500">
                    {app.candidate_notice_period_days != null ? `${app.candidate_notice_period_days}d` : '—'}
                  </td>
                  <td className="table-td text-xs text-gray-400 whitespace-nowrap">
                    {app.last_updated ? formatDistanceToNow(new Date(app.last_updated), { addSuffix: true }) : '—'}
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
        )}
      </div>

      {linkCandidate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-base font-semibold">Link {linkCandidate.full_name} to a role</h3>
            <select value={roleId} onChange={e => setRoleId(e.target.value)} className="select">
              <option value="">Select a role…</option>
              {roles.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setLinkCandidate(null); setRoleId(''); }} className="btn-secondary">Cancel</button>
              <button onClick={handleLinkRole} disabled={linking || !roleId} className="btn-primary">
                {linking ? 'Linking…' : 'Link'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
