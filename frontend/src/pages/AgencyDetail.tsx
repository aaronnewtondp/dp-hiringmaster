import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { agenciesApi } from '../services/api.ts';
import { Agency } from '../types/index.ts';
import { Spinner, EmptyState } from '../components/shared/Badges.tsx';
import EditableSection from '../components/shared/EditableSection.tsx';

export default function AgencyDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<{ data: { agency: Agency } }>({
    queryKey: ['agency', id],
    queryFn:  () => agenciesApi.get(id!),
  });

  const agency = data?.data?.agency;

  const saveAgencyFields = async (changes: Record<string, unknown>) => {
    await agenciesApi.update(id!, changes);
    qc.invalidateQueries({ queryKey: ['agency', id] });
  };

  if (isLoading) return <div className="flex justify-center p-12"><Spinner size="lg" /></div>;
  if (!agency) return <EmptyState title="Agency not found" />;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/agencies" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-3">
          <ArrowLeft className="w-4 h-4" /> Agencies
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900">{agency.name}</h1>
          <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${
            agency.contract_status === 'Active' ? 'bg-green-100 text-green-700' :
            agency.contract_status === 'On Hold' ? 'bg-amber-100 text-amber-700' :
            'bg-gray-100 text-gray-600'
          }`}>
            {agency.contract_status}
          </span>
        </div>
        {(agency.total_submitted != null || agency.total_hired != null) && (
          <div className="flex items-center gap-4 mt-1 text-sm text-gray-500">
            <span>{agency.total_submitted ?? 0} submitted</span>
            <span>·</span>
            <span>{agency.total_hired ?? 0} hired</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <EditableSection
          title="Contact"
          data={agency}
          onSave={saveAgencyFields}
          fields={[
            { key: 'name', label: 'Agency Name', type: 'text' },
            { key: 'contact_name', label: 'Contact Name', type: 'text' },
            { key: 'contact_email', label: 'Contact Email', type: 'text' },
            { key: 'contact_phone', label: 'Contact Phone', type: 'text' },
          ]}
        />
        <EditableSection
          title="Contract"
          data={agency}
          onSave={saveAgencyFields}
          fields={[
            { key: 'contract_status', label: 'Status', type: 'select', options: ['Active', 'Inactive', 'On Hold'] },
            { key: 'replacement_guarantee_days', label: 'Replacement Guarantee (days)', type: 'number' },
          ]}
        />
        <EditableSection
          title="Commission Tiers"
          data={agency}
          onSave={saveAgencyFields}
          fields={[
            { key: 'tier1_band', label: 'Tier 1 Band', type: 'text' },
            { key: 'tier1_rate', label: 'Tier 1 Rate', type: 'text' },
            { key: 'tier2_band', label: 'Tier 2 Band', type: 'text' },
            { key: 'tier2_rate', label: 'Tier 2 Rate', type: 'text' },
            { key: 'tier3_band', label: 'Tier 3 Band', type: 'text' },
            { key: 'tier3_rate', label: 'Tier 3 Rate', type: 'text' },
          ]}
        />
        <EditableSection
          title="Notes & Links"
          data={agency}
          onSave={saveAgencyFields}
          fields={[
            { key: 'specialisations', label: 'Specialisations', type: 'textarea' },
            { key: 'agreement_drive_link', label: 'Agreement Link', type: 'text', linkify: true },
            { key: 'notes', label: 'Notes', type: 'textarea' },
          ]}
        />
      </div>
    </div>
  );
}
