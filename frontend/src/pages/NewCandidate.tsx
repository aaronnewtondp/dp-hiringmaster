import { useState, FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { useQuery } from '@tanstack/react-query';
import { candidatesApi, rolesApi } from '../services/api.ts';
import { Role } from '../types/index.ts';

const CHANNELS = ['Naukri', 'LinkedIn', 'IIMJobs', 'Employee Referral', 'Agency', 'Direct Outreach', 'WhatsApp Forward', 'Google Form'];

export default function NewCandidate() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    // Identity
    full_name: '', email: '', phone: '', linkedin_url: '',
    // Application
    role_id: '', source_channel: '', agency_id: '',
    // Compensation
    current_ctc_fixed: '', current_ctc_variable: '', current_esops: '', expected_ctc: '',
    notice_period_days: '',
    // Current role
    current_company: '', current_industry: '', current_designation: '',
    current_location: '', years_of_experience: '',
    // Resume
    resume_drive_link: '',
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
      // Convert numeric fields, omit empty strings so the backend gets null not ""
      const payload: Record<string, unknown> = { ...form };
      for (const numField of [
        'current_ctc_fixed', 'current_ctc_variable', 'current_esops', 'expected_ctc',
        'notice_period_days', 'years_of_experience',
      ]) {
        const val = form[numField as keyof typeof form];
        payload[numField] = val === '' ? null : Number(val);
      }
      for (const strField of ['linkedin_url', 'agency_id', 'current_company', 'current_industry',
        'current_designation', 'current_location', 'resume_drive_link', 'email', 'phone']) {
        if (payload[strField] === '') payload[strField] = null;
      }

      const res = await candidatesApi.create(payload);
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
    <div className="max-w-2xl">
      <Link to="/candidates" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ArrowLeft className="w-4 h-4" /> Candidates
      </Link>
      <h1 className="text-xl font-semibold text-gray-900 mb-6">Add candidate</h1>

      <form onSubmit={handleSubmit} className="space-y-5">

        {/* ── Identity ─────────────────────────────────────────────────────── */}
        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Identity</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Full Name *</label>
              <input className="input" value={form.full_name} onChange={e => set('full_name', e.target.value)} required placeholder="First Last" />
            </div>
            <div>
              <label className="label">Email</label>
              <input type="email" className="input" value={form.email} onChange={e => set('email', e.target.value)} placeholder="candidate@email.com" />
            </div>
            <div>
              <label className="label">Phone Number</label>
              <input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+91 XXXXXXXXXX" />
            </div>
            <div>
              <label className="label">LinkedIn URL</label>
              <input className="input" value={form.linkedin_url} onChange={e => set('linkedin_url', e.target.value)} placeholder="linkedin.com/in/…" />
            </div>
          </div>
        </div>

        {/* ── Application ──────────────────────────────────────────────────── */}
        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Application</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Role applying for</label>
              <select className="select" value={form.role_id} onChange={e => set('role_id', e.target.value)}>
                <option value="">— No role yet —</option>
                {roles.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Source channel</label>
              <select className="select" value={form.source_channel} onChange={e => set('source_channel', e.target.value)}>
                <option value="">Select…</option>
                {CHANNELS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* ── Current role & experience ────────────────────────────────────── */}
        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Current role & experience</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Current Company</label>
              <input className="input" value={form.current_company} onChange={e => set('current_company', e.target.value)} />
            </div>
            <div>
              <label className="label">Current Designation</label>
              <input className="input" value={form.current_designation} onChange={e => set('current_designation', e.target.value)} />
            </div>
            <div>
              <label className="label">Current Industry</label>
              <input className="input" value={form.current_industry} onChange={e => set('current_industry', e.target.value)} placeholder="e.g. Water Treatment, SaaS…" />
            </div>
            <div>
              <label className="label">Current Location</label>
              <input className="input" value={form.current_location} onChange={e => set('current_location', e.target.value)} />
            </div>
            <div>
              <label className="label">Years of Experience</label>
              <input type="number" step="0.1" min="0" className="input" value={form.years_of_experience} onChange={e => set('years_of_experience', e.target.value)} />
            </div>
          </div>
        </div>

        {/* ── Compensation ─────────────────────────────────────────────────── */}
        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Compensation</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Current CTC — Fixed (LPA)</label>
              <input type="number" step="0.1" min="0" className="input" value={form.current_ctc_fixed} onChange={e => set('current_ctc_fixed', e.target.value)} />
            </div>
            <div>
              <label className="label">Current CTC — Variable (LPA)</label>
              <input type="number" step="0.1" min="0" className="input" value={form.current_ctc_variable} onChange={e => set('current_ctc_variable', e.target.value)} />
            </div>
            <div>
              <label className="label">ESOPs (LPA equivalent, optional)</label>
              <input type="number" step="0.1" min="0" className="input" value={form.current_esops} onChange={e => set('current_esops', e.target.value)} />
            </div>
            <div>
              <label className="label">Expected CTC (LPA)</label>
              <input type="number" step="0.1" min="0" className="input" value={form.expected_ctc} onChange={e => set('expected_ctc', e.target.value)} />
            </div>
            <div>
              <label className="label">Notice Period (days)</label>
              <input type="number" min="0" className="input" value={form.notice_period_days} onChange={e => set('notice_period_days', e.target.value)} />
            </div>
          </div>
        </div>

        {/* ── Resume ───────────────────────────────────────────────────────── */}
        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Resume</h2>
          <div>
            <label className="label">Resume — Google Drive link</label>
            <input className="input" value={form.resume_drive_link} onChange={e => set('resume_drive_link', e.target.value)} placeholder="https://drive.google.com/…" />
            <p className="text-xs text-gray-400 mt-1">Used by ResumeIQ to fetch and score the resume against the role JD.</p>
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <Link to="/candidates" className="btn-secondary">Cancel</Link>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? 'Saving…' : 'Add candidate'}
          </button>
        </div>
      </form>
    </div>
  );
}
