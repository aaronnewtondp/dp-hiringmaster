import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Search, Plus, ChevronRight } from 'lucide-react';
import { applicationsApi } from '../services/api.ts';
import { Application, STAGES } from '../types/index.ts';
import { StageBadge, StatusBadge, FitScore, SlaBadge, Spinner, EmptyState, PriorityBadge } from '../components/shared/Badges.tsx';
import { useAuth } from '../contexts/AuthContext.tsx';
import { formatDistanceToNow } from 'date-fns';

export default function Candidates() {
  const { canHR } = useAuth();
  const [search,      setSearch]      = useState('');
  const [filterStage, setFilterStage] = useState('all');
  const [filterSla,   setFilterSla]   = useState(false);

  const params: Record<string,string> = { limit: '100' };
  if (filterStage !== 'all') params.stage  = filterStage;
  if (filterSla)             params.sla_breach = 'true';

  const { data, isLoading } = useQuery<{ data: { applications: Application[] } }>({
    queryKey: ['applications', filterStage, filterSla],
    queryFn:  () => applicationsApi.list(params),
  });

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
                    {app.current_ctc_fixed ? `₹${app.current_ctc_fixed}L` : '—'}
                    {' → '}
                    {app.ectc ? `₹${app.ectc}L` : '—'}
                  </td>
                  <td className="table-td text-xs text-gray-500">
                    {app.notice_period_days != null ? `${app.notice_period_days}d` : '—'}
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
    </div>
  );
}
