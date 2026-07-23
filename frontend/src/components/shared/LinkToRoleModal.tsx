import { useState } from 'react';
import toast from 'react-hot-toast';
import { candidatesApi, rolesApi } from '../../services/api.ts';
import { Role } from '../../types/index.ts';
import { useQuery } from '@tanstack/react-query';

interface LinkToRoleModalProps {
  candidate:       { id: string; full_name: string };
  // Roles this candidate already has an application for — excluded from the
  // picker so the 409 ("Already linked to this role") never comes up as a
  // surprise. Callers with no existing applications in hand (e.g. the
  // Unlinked candidates panel, which only ever shows candidates with zero
  // applications) can omit this.
  excludeRoleIds?: string[];
  sourceChannel:   string;
  onClose:         () => void;
  onLinked:        () => void;
}

// Extracted from Candidates.tsx's original inline "Link to role" modal so
// the Talent Pool page's "Reactivate" action can reuse the exact same
// POST /api/candidates/:id/applications flow instead of duplicating it.
export default function LinkToRoleModal({ candidate, excludeRoleIds, sourceChannel, onClose, onLinked }: LinkToRoleModalProps) {
  const [roleId,  setRoleId]  = useState('');
  const [linking, setLinking] = useState(false);

  const { data: rolesData } = useQuery<{ data: { roles: Role[] } }>({
    queryKey: ['roles', 'active'],
    queryFn:  () => rolesApi.list({ status: 'Live – Sourcing' }),
  });
  const roles = (rolesData?.data?.roles || []).filter(r => !excludeRoleIds?.includes(r.id));

  const handleLink = async () => {
    if (!roleId) return;
    setLinking(true);
    try {
      await candidatesApi.linkRole(candidate.id, { role_id: roleId, source_channel: sourceChannel });
      toast.success('Candidate linked to role');
      onLinked();
      onClose();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error || 'Failed to link candidate');
    }
    setLinking(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
        <h3 className="text-base font-semibold">Link {candidate.full_name} to a role</h3>
        <select value={roleId} onChange={e => setRoleId(e.target.value)} className="select">
          <option value="">Select a role…</option>
          {roles.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
        </select>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={handleLink} disabled={linking || !roleId} className="btn-primary">
            {linking ? 'Linking…' : 'Link'}
          </button>
        </div>
      </div>
    </div>
  );
}
