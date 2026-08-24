import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, ExternalLink } from 'lucide-react';
import { agenciesApi } from '../services/api.ts';
import { Agency } from '../types/index.ts';
import { Spinner, EmptyState } from '../components/shared/Badges.tsx';

export default function Agencies() {
  const { data, isLoading } = useQuery<{ data: { agencies: Agency[] } }>({
    queryKey: ['agencies'],
    queryFn:  () => agenciesApi.list(),
  });
  const agencies = data?.data?.agencies || [];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Agency Repository</h1>
          <p className="text-sm font-mono text-gray-500 mt-0.5">{agencies.length} agencies</p>
        </div>
        <button className="btn-primary">
          <Plus className="w-4 h-4" /> Add agency
        </button>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center p-12"><Spinner size="lg" /></div>
        ) : agencies.length === 0 ? (
          <div className="p-12"><EmptyState title="No agencies" /></div>
        ) : (
          <table className="w-full">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                {['Agency Name','Status','Requirement Type','Commission Tiers','Market Positioning','Hires','Replacement','Billing and Payment terms','Agreement Link'].map(h => (
                  <th key={h} className="table-th">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {agencies.map((ag, idx) => (
                <tr key={ag.id} className={`hover:bg-gray-50 cursor-pointer ${idx % 2 ? 'bg-gray-50/40' : ''}`}>
                  <td className="table-td">
                    <Link to={`/agencies/${ag.id}`} className="block">
                      <div className="font-medium text-gray-900 hover:text-dp-600">{ag.name}</div>
                      {ag.contact_name && <div className="text-xs text-gray-400">{ag.contact_name}</div>}
                    </Link>
                  </td>
                  <td className="table-td">
                    <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${
                      ag.contract_status === 'Active' ? 'bg-green-100 text-green-700' :
                      ag.contract_status === 'On Hold' ? 'bg-amber-100 text-amber-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {ag.contract_status}
                    </span>
                  </td>
                  <td className="table-td text-xs text-gray-600 max-w-[160px]">
                    {ag.specialisations || <span className="text-gray-300">—</span>}
                  </td>
                  <td className="table-td text-xs font-mono text-gray-600">
                    {ag.tier1_rate && <div>{ag.tier1_band || 'All'}: {ag.tier1_rate}</div>}
                    {ag.tier2_rate && <div>{ag.tier2_band}: {ag.tier2_rate}</div>}
                    {ag.tier3_rate && <div>{ag.tier3_band}: {ag.tier3_rate}</div>}
                    {!ag.tier1_rate && !ag.tier2_rate && !ag.tier3_rate && <span className="text-gray-300">—</span>}
                  </td>
                  <td className="table-td text-xs text-gray-600 max-w-[220px]">
                    {ag.market_positioning || <span className="text-gray-300">—</span>}
                  </td>
                  <td className="table-td text-center text-green-700 font-medium font-mono">{ag.total_hired ?? 0}</td>
                  <td className="table-td text-xs text-gray-500 max-w-[180px]">
                    <div className="font-mono">{ag.replacement_guarantee_days ?? 60}d window</div>
                    {ag.replacement_triggers && <div className="text-gray-400 mt-0.5">{ag.replacement_triggers}</div>}
                  </td>
                  <td className="table-td text-xs text-gray-500 max-w-[200px]">
                    {ag.billing_effective_window
                      ? <div className="font-mono text-gray-600">{ag.billing_effective_window}</div>
                      : <span className="text-gray-300">—</span>}
                    {ag.billing_late_penalty && ag.billing_late_penalty !== 'None stated' && (
                      <div className="text-amber-600 mt-0.5">{ag.billing_late_penalty}</div>
                    )}
                  </td>
                  <td className="table-td">
                    {ag.agreement_drive_link ? (
                      <a
                        href={ag.agreement_drive_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-xs text-dp-600 hover:underline"
                      >
                        View <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : <span className="text-gray-300 text-xs">—</span>}
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
