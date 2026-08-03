import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, X } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import { usersApi } from '../services/api.ts';
import { ManagedUser, PERSONAS } from '../types/index.ts';
import { useAuth } from '../contexts/AuthContext.tsx';
import { Spinner, EmptyState } from '../components/shared/Badges.tsx';

// super_admin is assigned to exactly one person by policy — never a
// selectable role in this UI, matching the backend's own guard on
// POST/PATCH /api/users.
const ASSIGNABLE_ROLES = ['hr_recruiter', 'hiring_manager', 'interviewer', 'leadership'] as const;
type AssignableRole = typeof ASSIGNABLE_ROLES[number];

function UserModal({ user, onClose, onSuccess }: {
  user: ManagedUser | 'new';
  onClose: () => void;
  onSuccess: () => void;
}) {
  const isNew = user === 'new';
  const [name, setName]             = useState(isNew ? '' : user.name);
  const [email, setEmail]           = useState(isNew ? '' : user.email);
  const [persona, setPersona]       = useState<AssignableRole>(isNew ? 'hr_recruiter' : user.persona as AssignableRole);
  const [department, setDepartment] = useState(isNew ? '' : (user.department || ''));
  const [saving, setSaving]         = useState(false);

  const handleSubmit = async () => {
    if (!name.trim())  { toast.error('Name is required');  return; }
    if (!email.trim()) { toast.error('Email is required'); return; }

    const fields = {
      name:       name.trim(),
      email:      email.trim(),
      persona,
      department: department.trim() || undefined,
    };

    setSaving(true);
    try {
      if (isNew) {
        await usersApi.create(fields);
        toast.success('User added');
      } else {
        await usersApi.update(user.id, fields);
        toast.success('User updated');
      }
      onSuccess();
      onClose();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || 'Failed to save user');
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">{isNew ? 'Add user' : 'Edit user'}</h3>
          <button onClick={onClose}><X className="w-4 h-4 text-gray-400" /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Name <span className="text-red-500">*</span></label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Priya Sharma" className="input text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Email <span className="text-red-500">*</span></label>
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="name@digitalpaani.com" className="input text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Role <span className="text-red-500">*</span></label>
            <select value={persona} onChange={e => setPersona(e.target.value as AssignableRole)} className="select text-sm">
              {ASSIGNABLE_ROLES.map(p => <option key={p} value={p}>{PERSONAS[p]}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Department <span className="text-gray-400">(optional)</span></label>
            <input value={department} onChange={e => setDepartment(e.target.value)} placeholder="e.g. HR" className="input text-sm" />
          </div>
        </div>
        <div className="flex gap-3 justify-end px-5 py-4 border-t border-gray-100">
          <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="btn-primary text-sm">
            {saving ? <Spinner size="sm" /> : isNew ? 'Add user' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function UserManagement() {
  const { user: currentUser } = useAuth();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<{ data: { users: ManagedUser[] } }>({
    queryKey: ['users'],
    queryFn:  () => usersApi.list(),
  });
  const users = data?.data?.users || [];

  const [editingUser, setEditingUser] = useState<ManagedUser | 'new' | null>(null);
  const [togglingId,  setTogglingId]  = useState<string | null>(null);

  const handleToggleActive = async (u: ManagedUser) => {
    setTogglingId(u.id);
    try {
      await usersApi.update(u.id, { is_active: !u.is_active });
      toast.success(u.is_active ? 'Access revoked' : 'Access restored');
      qc.invalidateQueries({ queryKey: ['users'] });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || 'Failed to update user');
    }
    setTogglingId(null);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">User Management</h1>
          <p className="text-sm text-gray-500 mt-0.5">{users.length} users</p>
        </div>
        <button onClick={() => setEditingUser('new')} className="btn-primary">
          <UserPlus className="w-4 h-4" /> Add user
        </button>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center p-12"><Spinner size="lg" /></div>
        ) : users.length === 0 ? (
          <div className="p-12"><EmptyState title="No users" /></div>
        ) : (
          <table className="w-full">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                {['Name', 'Email', 'Role', 'Department', 'Status', 'Last Login', ''].map(h => (
                  <th key={h} className="table-th">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {users.map((u, idx) => {
                const isSelf = u.id === currentUser?.id;
                return (
                  <tr key={u.id} className={idx % 2 ? 'bg-gray-50/40' : ''}>
                    <td className="table-td font-medium text-gray-900">{u.name}</td>
                    <td className="table-td text-gray-600">{u.email}</td>
                    <td className="table-td">
                      <span className="inline-flex px-2 py-0.5 rounded-md text-xs font-medium bg-dp-50 text-dp-700">
                        {PERSONAS[u.persona]}
                      </span>
                    </td>
                    <td className="table-td text-gray-600">{u.department || '—'}</td>
                    <td className="table-td">
                      <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${
                        u.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}>
                        {u.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="table-td text-xs text-gray-400">
                      {u.last_login ? formatDistanceToNow(new Date(u.last_login), { addSuffix: true }) : 'Never'}
                    </td>
                    <td className="table-td text-right whitespace-nowrap">
                      {u.persona === 'super_admin' ? (
                        <span className="text-xs text-gray-400" title="Super-Admin is managed outside this page">—</span>
                      ) : (
                        <div className="flex items-center gap-3 justify-end">
                          <button onClick={() => setEditingUser(u)} className="text-xs text-dp-600 hover:text-dp-800 font-medium">
                            Edit
                          </button>
                          <button
                            onClick={() => handleToggleActive(u)}
                            disabled={isSelf || togglingId === u.id}
                            title={isSelf ? "You can't change your own access" : undefined}
                            className={`text-xs font-medium ${
                              isSelf ? 'text-gray-300 cursor-not-allowed'
                                     : u.is_active ? 'text-red-600 hover:text-red-800' : 'text-green-600 hover:text-green-800'
                            }`}
                          >
                            {u.is_active ? 'Deactivate' : 'Reactivate'}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editingUser && (
        <UserModal
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onSuccess={() => qc.invalidateQueries({ queryKey: ['users'] })}
        />
      )}
    </div>
  );
}
