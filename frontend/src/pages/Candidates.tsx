import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Search, Plus, ChevronRight, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { applicationsApi, candidatesApi, rolesApi } from '../services/api.ts';
import { Application, Candidate, STAGES, PRIORITIES, ROLE_STATUSES, LOCATIONS, DEPARTMENTS } from '../types/index.ts';
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
  const [departments, setDepartments] = useState<string[]>([]);
  const [locations,   setLocations]   = useState<string[]>([]);
  const [modes,       setModes]       = useState<string[]>([]);
  const [priorities,  setPriorities]  = useState<string[]>([]);
  const [roleStatuses, setRoleStatuses] = useState<string[]>([]);
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
  if (filterStage !== 'all')   params.stage  = filterStage;
  if (filterSla)               params.sla_breach = 'true';
  if (roleIds.length)          params.role_id = roleIds;
  if (departments.length)      params.department = departments;
  if (locations.length)        params.location = locations;
  if (modes.length)            params.recruitment_mode = modes;
  if (priorities.length)       params.priority = priorities;
  // Sent as role_status, not status — `status` on this endpoint already
  // means the APPLICATION's own status (Active/Rejected/etc), a different,
  // non-overlapping value set from role status (Draft/Approved/etc).
  if (roleStatuses.length)     params.role_status = roleStatuses;

  const { data, isLoading } = useQuery<{ data: { applications: Application[] } }>({
    queryKey: ['applications', filterStage, filterSla, roleIds, departments, locations, modes, priorities, roleStatuses],
    queryFn:  () => applicationsApi.list(params),
  });

  // Master filters — same fields/options as Dashboard.tsx's/Roles.tsx's own,
  // via the shared GET /api/roles/filter-options endpoint (non-Closed roles
  // only, auto-updated whenever a role is created/closed).
  const { data: filterOptionsData } = useQuery<{ data: { recruitment_modes: string[]; roles: { id: string; title: string }[] } }>({
    queryKey: ['roles', 'filter-options'],
    queryFn:  () => rolesApi.filterOptions(),
  });
  const modeOptions = filterOptionsData?.data?.recruitment_modes || [];
  const roleOptions = (filterOptionsData?.data?.roles || []).map(r => ({ value: r.id, label: r.title }));

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

      {/* Search + filters — single row; scrolls horizontally rather than
          wrapping if the viewport is too narrow to fit everything. */}
      <div className="flex gap-1.5 flex-nowrap overflow-x-auto pb-1">
        <div className="relative w-40 shrink-0">
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
          className="select w-32 shrink-0 text-xs"
        >
          <option value="all">All stages</option>
          {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="shrink-0"><MultiSelectFilter label="Department"       options={DEPARTMENTS}   selected={departments}  onChange={setDepartments} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Location"         options={LOCATIONS}     selected={locations}    onChange={setLocations} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Recruitment Mode" options={modeOptions}   selected={modes}         onChange={setModes} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Priority"         options={PRIORITIES}    selected={priorities}   onChange={setPriorities} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Status"           options={ROLE_STATUSES} selected={roleStatuses} onChange={setRoleStatuses} /></div>
        <div className="shrink-0"><MultiSelectFilter label="Role" options={roleOptions} selected={roleIds} onChange={setRoleIds} /></div>
        <button
          onClick={() => setFilterSla(v => !v)}
          className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            filterSla ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
          }`}
        >
          SLA breached only
        </button>
      </div>

      {/* Table — table-fixed with explicit per-column widths so the whole
          thing fits the card's width without clipping; overflow-x-auto is
          a safety net for narrow viewports rather than the primary fit
          mechanism. */}
      <div className="card overflow-x-auto">
        {isLoading ? (
          <div className="flex justify-center p-12"><Spinner size="lg" /></div>
        ) : filtered.length === 0 ? (
          <div className="p-12"><EmptyState title="No candidates match" /></div>
        ) : (
          <table className="w-full table-fixed">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                {[
                  ['Candidate', 'w-[140px]'], ['Role', 'w-[100px]'], ['Stage', 'w-[95px]'],
                  ['Fit', 'w-[55px]'], ['CTC → ECTC', 'w-[100px]'], ['Notice', 'w-[62px]'],
                  ['Preferred Location', 'w-[115px]'], ['Current Company', 'w-[120px]'],
                  ['Resume Link', 'w-[72px]'], ['Last Updated', 'w-[108px]'], ['', 'w-[34px]'],
                ].map(([h, w]) => (
                  <th key={h} title={h} className={`table-th px-2 truncate tracking-normal ${w}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.map(app => (
                <tr key={app.id} className={`hover:bg-gray-50 transition-colors ${app.sla_breach ? 'bg-red-50/30' : ''}`}>
                  <td className="table-td px-2 py-4">
                    <div className="min-w-0">
                      <Link to={`/candidates/${app.candidate_id}`} className="font-medium text-gray-900 hover:text-dp-600 block truncate">
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
                  </td>
                  <td className="table-td px-2 py-4 truncate">
                    <Link to={`/roles/${app.role_id}`} className="text-sm text-gray-700 hover:text-dp-600 block truncate">
                      {app.role_title}
                    </Link>
                    {app.role_priority && <PriorityBadge priority={app.role_priority} />}
                  </td>
                  <td className="table-td px-2 py-4"><StageBadge stage={app.stage} /></td>
                  <td className="table-td px-2 py-4"><FitScore score={app.ai_fit_score} /></td>
                  <td className="table-td px-2 py-4 text-xs text-gray-500 truncate">
                    {app.candidate_ctc_fixed ? `₹${app.candidate_ctc_fixed}L` : '—'}
                    {' → '}
                    {app.candidate_expected_ctc ? `₹${app.candidate_expected_ctc}L` : '—'}
                  </td>
                  <td className="table-td px-2 py-4 text-xs text-gray-500 truncate">
                    {app.candidate_notice_period_days != null ? `${app.candidate_notice_period_days}d` : '—'}
                  </td>
                  <td className="table-td px-2 py-4 text-xs text-gray-500 truncate" title={app.preferred_location || ''}>{app.preferred_location || '—'}</td>
                  <td className="table-td px-2 py-4 text-xs text-gray-500 truncate" title={app.candidate_company || ''}>{app.candidate_company || '—'}</td>
                  <td className="table-td px-2 py-4 text-xs truncate">
                    {app.candidate_resume_link ? (
                      <a href={app.candidate_resume_link} target="_blank" rel="noreferrer" className="text-dp-600 hover:underline">
                        View
                      </a>
                    ) : '—'}
                  </td>
                  <td className="table-td px-2 py-4 text-xs text-gray-400 truncate">
                    {app.last_updated ? formatDistanceToNow(new Date(app.last_updated), { addSuffix: true }) : '—'}
                  </td>
                  <td className="table-td px-1 py-4">
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
