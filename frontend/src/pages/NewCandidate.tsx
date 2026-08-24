import { useState, FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { useQuery } from '@tanstack/react-query';
import { candidatesApi, rolesApi, agenciesApi } from '../services/api.ts';
import { Role, Agency, RECRUITMENT_CHANNELS } from '../types/index.ts';
import { useAuth } from '../contexts/AuthContext.tsx';

type FormState = {
  full_name: string; email: string; phone: string; linkedin_url: string;
  role_id: string;
  // Where this candidate was originally sourced (candidate-level).
  source: string; sourced_by_agency_id: string;
  agency_id: string;
  current_ctc_fixed: string; expected_ctc: string; notice_period_days: string;
  current_company: string; current_industry: string; current_designation: string;
  current_location: string; years_of_experience: string; preferred_location: string;
  languages_known: string;
  resume_drive_link: string;
};

// Every field is required except linkedin_url, source_channel, and
// current_designation — mirrors the Job Application Form, where those
// three have no equivalent question (LinkedIn URL is new to the form and
// optional there too; Source Channel and Designation aren't asked at all).
const REQUIRED_FIELDS: Array<[keyof FormState, string]> = [
  ['full_name', 'Full Name'], ['email', 'Email'], ['phone', 'Phone Number'],
  ['role_id', 'Role applying for'],
  ['current_company', 'Current Company'], ['current_industry', 'Current Industry'],
  ['current_location', 'Current Location'], ['years_of_experience', 'Years of Experience'],
  ['preferred_location', 'Preferred Location'], ['languages_known', 'Languages Known'],
  ['current_ctc_fixed', 'Current CTC (Fixed and Variable breakup) in LPA'],
  ['expected_ctc', 'Expected CTC'], ['notice_period_days', 'Notice Period'],
  ['resume_drive_link', 'Resume — Google Drive link'],
];

export default function NewCandidate() {
  const navigate = useNavigate();
  const { canHR } = useAuth();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>({
    // Identity
    full_name: '', email: '', phone: '', linkedin_url: '',
    // Application
    role_id: '', source: '', sourced_by_agency_id: '', agency_id: '',
    // Compensation
    current_ctc_fixed: '', expected_ctc: '', notice_period_days: '',
    // Current role
    current_company: '', current_industry: '', current_designation: '',
    current_location: '', years_of_experience: '', preferred_location: '',
    languages_known: '',
    // Resume
    resume_drive_link: '',
  });

  const { data: rolesData } = useQuery<{ data: { roles: Role[] } }>({
    queryKey: ['roles', 'active'],
    queryFn:  () => rolesApi.list({ status: 'Live – Sourcing' }),
  });
  const roles = rolesData?.data?.roles || [];

  const { data: agenciesData } = useQuery<{ data: { agencies: Agency[] } }>({
    queryKey: ['agencies'],
    queryFn: () => agenciesApi.list(),
    enabled: canHR,
  });
  const agencies = agenciesData?.data?.agencies || [];

  const set = (k: keyof FormState, v: string) => setForm(f => (
    // Changing Source away from 'Agency' clears the now-inapplicable
    // sourcing agency, same as the dependsOn behavior on the detail page.
    k === 'source' && v !== 'Agency' ? { ...f, source: v, sourced_by_agency_id: '' } : { ...f, [k]: v }
  ));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    for (const [key, label] of REQUIRED_FIELDS) {
      if (!String(form[key]).trim()) { toast.error(`${label} is required`); return; }
    }
    if (form.source === 'Agency' && !form.sourced_by_agency_id) {
      toast.error('Select which agency sourced this candidate');
      return;
    }
    setSaving(true);
    try {
      // Convert numeric fields, omit empty strings so the backend gets null not ""
      const payload: Record<string, unknown> = { ...form };
      for (const numField of ['current_ctc_fixed', 'expected_ctc', 'notice_period_days', 'years_of_experience']) {
        const val = form[numField as keyof FormState];
        payload[numField] = val === '' ? null : Number(val);
      }
      for (const strField of ['linkedin_url', 'agency_id', 'source', 'sourced_by_agency_id', 'current_company', 'current_industry',
        'current_designation', 'current_location', 'preferred_location', 'languages_known',
        'resume_drive_link', 'email', 'phone']) {
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
              <label className="label">Email *</label>
              <input type="email" className="input" value={form.email} onChange={e => set('email', e.target.value)} required placeholder="candidate@email.com" />
            </div>
            <div>
              <label className="label">Phone Number *</label>
              <input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} required placeholder="+91 XXXXXXXXXX" />
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
              <label className="label">Role applying for *</label>
              <select className="select" value={form.role_id} onChange={e => set('role_id', e.target.value)} required>
                <option value="">Select a role…</option>
                {roles.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Source</label>
              <select className="select" value={form.source} onChange={e => set('source', e.target.value)}>
                <option value="">Not specified</option>
                {RECRUITMENT_CHANNELS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {form.source === 'Agency' && (
              <div>
                <label className="label">Sourcing Agency *</label>
                <select className="select" value={form.sourced_by_agency_id} onChange={e => set('sourced_by_agency_id', e.target.value)} required>
                  <option value="">Select agency…</option>
                  {agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
            )}
          </div>
        </div>

        {/* ── Current role & experience ────────────────────────────────────── */}
        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Current role & experience</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Current Company *</label>
              <input className="input" value={form.current_company} onChange={e => set('current_company', e.target.value)} required />
            </div>
            <div>
              <label className="label">Current Designation</label>
              <input className="input" value={form.current_designation} onChange={e => set('current_designation', e.target.value)} />
            </div>
            <div>
              <label className="label">Current Industry *</label>
              <input className="input" value={form.current_industry} onChange={e => set('current_industry', e.target.value)} required placeholder="e.g. Water Treatment, SaaS…" />
            </div>
            <div>
              <label className="label">Current Location *</label>
              <input className="input" value={form.current_location} onChange={e => set('current_location', e.target.value)} required />
            </div>
            <div>
              <label className="label">Preferred Location *</label>
              <input className="input" value={form.preferred_location} onChange={e => set('preferred_location', e.target.value)} required />
            </div>
            <div>
              <label className="label">Years of Experience *</label>
              <input type="number" step="0.1" min="0" className="input" value={form.years_of_experience} onChange={e => set('years_of_experience', e.target.value)} required />
            </div>
            <div>
              <label className="label">Languages Known *</label>
              <input className="input" value={form.languages_known} onChange={e => set('languages_known', e.target.value)} required placeholder="e.g. English, Hindi" />
            </div>
          </div>
        </div>

        {/* ── Compensation ─────────────────────────────────────────────────── */}
        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Compensation</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="label">Current CTC (Fixed and Variable breakup) in LPA *</label>
              <input type="number" step="0.1" min="0" className="input" value={form.current_ctc_fixed} onChange={e => set('current_ctc_fixed', e.target.value)} required />
            </div>
            <div>
              <label className="label">Expected CTC (LPA) *</label>
              <input type="number" step="0.1" min="0" className="input" value={form.expected_ctc} onChange={e => set('expected_ctc', e.target.value)} required />
            </div>
            <div>
              <label className="label">Notice Period (days) *</label>
              <input type="number" min="0" className="input" value={form.notice_period_days} onChange={e => set('notice_period_days', e.target.value)} required />
            </div>
          </div>
        </div>

        {/* ── Resume ───────────────────────────────────────────────────────── */}
        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Resume</h2>
          <div>
            <label className="label">Resume — Google Drive link *</label>
            <input className="input" value={form.resume_drive_link} onChange={e => set('resume_drive_link', e.target.value)} required placeholder="https://drive.google.com/…" />
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
