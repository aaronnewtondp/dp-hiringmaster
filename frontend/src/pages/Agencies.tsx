import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
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
          <p className="text-sm text-gray-500 mt-0.5">{agencies.length} agencies</p>
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
                {['Agency','Status','Commission Tiers','Submissions','Hires','Replacement'].map(h => (
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
                  <td className="table-td text-xs text-gray-600">
                    {ag.tier1_rate && <div>{ag.tier1_band || 'All'}: {ag.tier1_rate}</div>}
                    {ag.tier2_rate && <div>{ag.tier2_band}: {ag.tier2_rate}</div>}
                    {ag.tier3_rate && <div>{ag.tier3_band}: {ag.tier3_rate}</div>}
                  </td>
                  <td className="table-td text-center font-medium">{ag.total_submitted ?? 0}</td>
                  <td className="table-td text-center text-green-700 font-medium">{ag.total_hired ?? 0}</td>
                  <td className="table-td text-xs text-gray-500">{ag.replacement_guarantee_days ?? 60}d</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
