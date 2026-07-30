import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Search, Plus, ChevronRight, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { applicationsApi, candidatesApi, rolesApi } from '../services/api.ts';
import { Application, Candidate, STAGES } from '../types/index.ts';
import { StageBadge, StatusBadge, FitScore, SlaBadge, Spinner, EmptyState, PriorityBadge } from '../components/shared/Badges.tsx';
import LinkToRoleModal from '../components/shared/LinkToRoleModal.tsx';
import MultiSelectFilter from '../components/shared/MultiSelectFilter.tsx';
import { useAuth } from '../contexts/AuthContext.tsx';
import { formatDistanceToNow } from 'date-fns';

const UNLINKED_PAGE_SIZE = 50;

export default function Candidates() {
  const { canHR } = useAuth();
  const qc = useQueryClient();
  const [search,      setSearch]      = useState('');
  const [filterStage, setFilterStage] = useState('all');
  const [filterSla,   setFilterSla]   = useState(false);
  const [roleIds,     setRoleIds]     = useState<string[]>([]);
  const [showUnlinked, setShowUnlinked] = useState(true);
  const [linkCandidate, setLinkCandidate] = useState<Candidate | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<Candidate | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [unlinkedOffset, setUnlinkedOffset] = useState(0);
  const [unlinkedItems,  setUnlinkedItems]  = useState<Candidate[]>([]);
  const [unlinkedTotal,  setUnlinkedTotal]  = useState(0);

  // Archival (PRD §21) — Rejected/Withdrawn applications untouched for 90+
  // days are excluded from this default pipeline view; they remain fully
  // reachable via the Talent Pool page's "Archived" mode instead.
  const params: Record<string, string | string[]> = { limit: '100', exclude_stale_archived: 'true' };
  if (filterStage !== 'all') params.stage  = filterStage;
  if (filterSla)             params.sla_breach = 'true';
  if (roleIds.length)        params.role_id = roleIds;

  const { data, isLoading } = useQuery<{ data: { applications: Application[] } }>({
    queryKey: ['applications', filterStage, filterSla, roleIds],
    queryFn:  () => applicationsApi.list(params),
  });

  // Role master filter — same options as Dashboard.tsx's, only non-Closed
  // roles, auto-updated whenever a role is created/closed since it's a
  // live query rather than a hand-maintained list.
  const { data: roleFilterOptions } = useQuery<{ data: { roles: { id: string; title: string }[] } }>({
    queryKey: ['roles', 'filter-options'],
    queryFn:  () => rolesApi.filterOptions(),
  });
  const roleOptions = (roleFilterOptions?.data?.roles || []).map(r => ({ value: r.id, label: r.title }));

  // Candidates.tsx's main table is application-row driven, so a candidate
  // with zero applications (e.g. an ingested candidate whose "role applying
  // for" answer didn't match any open role) never shows up there — surfaced
  // separately here via GET /api/candidates?unlinked=true. Previously this
  // fetched a flat limit:100 page of ALL candidates and filtered client-side
  // to applications == null, so a truly-unlinked candidate only showed up if
  // they happened to fall within the 100 most-recently-updated candidates
  // overall — the backend now filters this at the query level, with real
  // pagination, so the full set is reachable.
  const { data: candidatesData, isLoading: unlinkedLoading } = useQuery<{ data: { candidates: Candidate[]; total: number } }>({
    queryKey: ['candidates', 'unlinked', unlinkedOffset],
    queryFn:  () => candidatesApi.list({ unlinked: 'true', limit: String(UNLINKED_PAGE_SIZE), offset: String(unlinkedOffset) }),
  });

  useEffect(() => {
    if (!candidatesData?.data) return;
    const page = candidatesData.data.candidates || [];
    setUnlinkedItems(prev => (unlinkedOffset === 0 ? page : [...prev, ...page]));
    setUnlinkedTotal(candidatesData.data.total || 0);
  }, [candidatesData]);

  const refreshUnlinked = () => {
    setUnlinkedOffset(0);
    qc.invalidateQueries({ queryKey: ['candidates', 'unlinked'] });
  };

  const handleDelete = async () => {
    if (!deleteCandidate) return;
    setDeleting(true);
    try {
      await candidatesApi.remove(deleteCandidate.id);
      toast.success(`${deleteCandidate.full_name} deleted`);
      setDeleteCandidate(null);
      refreshUnlinked();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error || 'Failed to delete candidate');
    }
    setDeleting(false);
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

      {/* Unlinked candidates have no application, so they never belong to
          any role — the panel is meaningless (always empty) once a Role
          filter is active, so hide it rather than show a confusing "0". */}
      {roleIds.length === 0 && (unlinkedTotal > 0 || unlinkedLoading) && (
        <div className="card overflow-hidden border-amber-200">
          <button
            onClick={() => setShowUnlinked(v => !v)}
            className="w-full px-5 py-3 flex items-center justify-between hover:bg-amber-50/50 transition-colors"
          >
            <h2 className="text-sm font-semibold text-amber-800">Unlinked candidates ({unlinkedTotal})</h2>
            {showUnlinked ? <ChevronUp className="w-4 h-4 text-amber-600" /> : <ChevronDown className="w-4 h-4 text-amber-600" />}
          </button>
          {showUnlinked && (
            <>
              <div className="divide-y divide-gray-50 border-t border-amber-100">
                {unlinkedItems.map(c => (
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
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => setLinkCandidate(c)} className="btn-secondary text-xs py-1.5 px-3">
                          Link to role
                        </button>
                        <button
                          onClick={() => setDeleteCandidate(c)}
                          title="Delete candidate"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {unlinkedItems.length < unlinkedTotal && (
                <div className="flex justify-center py-3 border-t border-amber-100">
                  <button
                    onClick={() => setUnlinkedOffset(o => o + UNLINKED_PAGE_SIZE)}
                    className="btn-secondary text-xs py-1.5 px-3"
                  >
                    Load more ({unlinkedItems.length} of {unlinkedTotal})
                  </button>
                </div>
              )}
            </>
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
        <MultiSelectFilter label="Role" options={roleOptions} selected={roleIds} onChange={setRoleIds} />
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
        <LinkToRoleModal
          candidate={linkCandidate}
          sourceChannel="Job Application Form"
          onClose={() => setLinkCandidate(null)}
          onLinked={() => {
            refreshUnlinked();
            qc.invalidateQueries({ queryKey: ['applications'] });
          }}
        />
      )}

      {deleteCandidate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-base font-semibold text-gray-900">Delete {deleteCandidate.full_name}?</h3>
            <p className="text-sm text-gray-500">
              This permanently deletes this candidate's record. This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteCandidate(null)} className="btn-secondary">Cancel</button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
