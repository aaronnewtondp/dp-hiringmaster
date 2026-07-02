import { useState, FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { useQuery } from '@tanstack/react-query';
import { candidatesApi, rolesApi } from '../services/api.ts';
import { Role } from '../types/index.ts';

const CHANNELS = ['Naukri','LinkedIn','IIMJobs','Employee Referral','Agency','Direct Outreach','WhatsApp Forward'];

export default function NewCandidate() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    full_name: '', email: '', phone: '', linkedin_url: '',
    role_id: '', source_channel: '', agency_id: '',
  });

  const { data: rolesData } = useQuery<{ data: { roles: Role[] } }>({
    queryKey: ['roles', 'active'],
    queryFn:  () => rolesApi.list({ status: 'Live – Sourcing' }),
  });
  const roles = rolesData?.data?.roles || [];

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.full_name) { toast.error('Name is required'); return; }
    setSaving(true);
    try {
      const res = await candidatesApi.create(form as Record<string, unknown>);
      toast.success('Candidate added');
      navigate(`/candidates/${res.data.candidate.id}`);
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { existing_id?: string; existing_name?: string } } };
      if (e.response?.status === 409) {
        toast.error(`Duplicate — ${e.response.data?.existing_name} already exists (${e.response.data?.existing_id})`);
      } else {
        toast.error('Failed to add candidate');
      }
    }
    setSaving(false);
  };

  return (
    <div className="max-w-lg">
      <Link to="/candidates" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ArrowLeft className="w-4 h-4" /> Candidates
      </Link>
      <h1 className="text-xl font-semibold text-gray-900 mb-6">Add candidate</h1>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Candidate profile</h2>
          <div>
            <label className="label">Full Name *</label>
            <input className="input" value={form.full_name} onChange={e => set('full_name', e.target.value)} required placeholder="First Last" />
          </div>
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="candidate@email.com" />
            <p className="text-xs text-gray-400 mt-1">Duplicate check runs on email — you'll be warned if already in the system.</p>
          </div>
          <div>
            <label className="label">Phone</label>
            <input className="input" type="tel" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+91 98XXX XXXXX" />
          </div>
          <div>
            <label className="label">LinkedIn URL</label>
            <input className="input" type="url" value={form.linkedin_url} onChange={e => set('linkedin_url', e.target.value)} placeholder="https://linkedin.com/in/..." />
          </div>
        </div>

        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Application (optional)</h2>
          <div>
            <label className="label">Apply to Role</label>
            <select className="select" value={form.role_id} onChange={e => set('role_id', e.target.value)}>
              <option value="">— no role yet —</option>
              {roles.map(r => (
                <option key={r.id} value={r.id}>{r.title} ({r.id})</option>
              ))}
            </select>
          </div>
          {form.role_id && (
            <div>
              <label className="label">Source Channel</label>
              <select className="select" value={form.source_channel} onChange={e => set('source_channel', e.target.value)}>
                <option value="">— select —</option>
                {CHANNELS.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="flex gap-3 justify-end">
          <Link to="/candidates" className="btn-secondary">Cancel</Link>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? 'Adding…' : 'Add candidate'}
          </button>
        </div>
      </form>
    </div>
  );
}
