import { useState, FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { rolesApi } from '../services/api.ts';
import { LOCATIONS, VACANCY_REASONS, DEPARTMENTS, EMPLOYMENT_TYPES, RECRUITMENT_CHANNELS, PRIORITIES } from '../types/index.ts';

type FormState = {
  title: string; department: string; hiring_manager_name: string; priority: string;
  new_or_replacement: string; vacancy_reason: string[]; num_openings: number; location: string;
  employment_type: string; yoe_required: string; qualification_required: string;
  ctc_band: string; kpi_expectations: string; job_description: string;
  must_have_skills: string; nice_to_have_skills: string; additional_remarks: string;
  recruitment_mode: string[];
  start_date: string; target_closure_date: string;
};

// Every field is required except kpi_expectations and additional_remarks —
// checked explicitly here (not native `required` alone) since several of
// these are custom toggle-button groups, not plain inputs.
const REQUIRED_TEXT_FIELDS: Array<[keyof FormState, string]> = [
  ['title', 'Role Title'], ['department', 'Department'], ['hiring_manager_name', 'Hiring Manager'],
  ['location', 'Location'], ['yoe_required', 'Experience Range'],
  ['qualification_required', 'Educational Qualifications'], ['ctc_band', 'CTC Band'],
  ['job_description', 'Job Description'], ['must_have_skills', 'Must Have Skills'],
  ['nice_to_have_skills', 'Nice to Have Skills'], ['target_closure_date', 'Target Close Date'],
];

export default function NewRole() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>({
    title: '', department: '', hiring_manager_name: '', priority: 'P1',
    new_or_replacement: 'New Position', vacancy_reason: [], num_openings: 1, location: '',
    employment_type: 'Full-Time / Permanent', yoe_required: '', qualification_required: '',
    ctc_band: '', kpi_expectations: '', job_description: '',
    must_have_skills: '', nice_to_have_skills: '', additional_remarks: '',
    recruitment_mode: [],
    start_date: new Date().toISOString().slice(0,10), target_closure_date: '',
  });

  const set = (k: keyof FormState, v: unknown) => setForm(f => ({ ...f, [k]: v }));
  const toggleIn = (k: 'recruitment_mode' | 'vacancy_reason', value: string) => set(k,
    form[k].includes(value) ? form[k].filter(x => x !== value) : [...form[k], value]
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    for (const [key, label] of REQUIRED_TEXT_FIELDS) {
      if (!String(form[key]).trim()) { toast.error(`${label} is required`); return; }
    }
    if (!form.num_openings || form.num_openings < 1) { toast.error('Openings must be at least 1'); return; }
    if (form.vacancy_reason.length === 0) { toast.error('Select at least one Vacancy Caused Due To option'); return; }
    if (form.recruitment_mode.length === 0) { toast.error('Select at least one Recruitment Channel'); return; }

    setSaving(true);
    try {
      // All roles get an assignment round by default — no per-role toggle.
      const payload = { ...form, assignment_required: true };
      const res = await rolesApi.create(payload as Record<string, unknown>);
      toast.success('Role created');
      navigate(`/roles/${res.data.role.id}`);
    } catch { toast.error('Failed to create role'); }
    setSaving(false);
  };

  return (
    <div className="max-w-3xl">
      <Link to="/roles" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ArrowLeft className="w-4 h-4" /> Roles
      </Link>
      <h1 className="text-xl font-semibold text-gray-900 mb-6">Create new role</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Basic information</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="label">Role Title *</label>
              <input className="input" value={form.title} onChange={e => set('title', e.target.value)} required placeholder="e.g. Senior Backend Developer" />
            </div>
            <div>
              <label className="label">Department *</label>
              <select className="select" value={form.department} onChange={e => set('department', e.target.value)} required>
                <option value="">— select —</option>
                {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Hiring Manager *</label>
              <input className="input" value={form.hiring_manager_name} onChange={e => set('hiring_manager_name', e.target.value)} required placeholder="Full name" />
            </div>
            <div>
              <label className="label">Priority *</label>
              <select className="select" value={form.priority} onChange={e => set('priority', e.target.value)}>
                {PRIORITIES.map(p => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="label">New / Replacement *</label>
              <select className="select" value={form.new_or_replacement} onChange={e => set('new_or_replacement', e.target.value)}>
                <option>New Position</option><option>Replacement</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="label">Vacancy Caused Due To *</label>
              <div className="flex gap-2 flex-wrap mt-1">
                {VACANCY_REASONS.map(r => (
                  <button key={r} type="button"
                    onClick={() => toggleIn('vacancy_reason', r)}
                    className={`px-3 py-1 rounded-lg text-sm border transition-colors ${
                      form.vacancy_reason.includes(r)
                        ? 'bg-dp-600 text-white border-dp-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                    }`}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Openings *</label>
              <input className="input" type="number" min={1} value={form.num_openings} onChange={e => set('num_openings', parseInt(e.target.value))} required />
            </div>
            <div>
              <label className="label">Location *</label>
              <select className="select" value={form.location} onChange={e => set('location', e.target.value)} required>
                <option value="">— select —</option>
                {LOCATIONS.map(l => <option key={l}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Employment Type *</label>
              <select className="select" value={form.employment_type} onChange={e => set('employment_type', e.target.value)}>
                {EMPLOYMENT_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Experience Range *</label>
              <input className="input" value={form.yoe_required} onChange={e => set('yoe_required', e.target.value)} required placeholder="e.g. 3–5 years" />
            </div>
            <div>
              <label className="label">Educational Qualifications *</label>
              <input className="input" value={form.qualification_required} onChange={e => set('qualification_required', e.target.value)} required placeholder="e.g. B.Tech / B.E. in Computer Science" />
            </div>
            <div>
              <label className="label">CTC Band (₹ LPA) *</label>
              <input className="input" value={form.ctc_band} onChange={e => set('ctc_band', e.target.value)} required placeholder="e.g. 18–24 LPA" />
            </div>
            <div>
              <label className="label">Open Date *</label>
              <input className="input" type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} required />
            </div>
            <div>
              <label className="label">Target Close Date *</label>
              <input className="input" type="date" value={form.target_closure_date} onChange={e => set('target_closure_date', e.target.value)} required />
            </div>
          </div>
        </div>

        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Requirements</h2>
          <div>
            <label className="label">Must Have Skills *</label>
            <textarea className="input h-24 resize-none" value={form.must_have_skills} onChange={e => set('must_have_skills', e.target.value)} required placeholder="Node.js; TypeScript; PostgreSQL; Docker" />
          </div>
          <div>
            <label className="label">Nice to Have Skills *</label>
            <textarea className="input h-24 resize-none" value={form.nice_to_have_skills} onChange={e => set('nice_to_have_skills', e.target.value)} required placeholder="GraphQL; AWS; Kubernetes" />
          </div>
          <div>
            <label className="label">KPI Expectations</label>
            <textarea className="input h-24 resize-none" value={form.kpi_expectations} onChange={e => set('kpi_expectations', e.target.value)} placeholder="What success looks like in this role in 90 days" />
          </div>
          <div>
            <label className="label">Job Description *</label>
            <textarea className="input h-32 resize-none" value={form.job_description} onChange={e => set('job_description', e.target.value)} required placeholder="Key responsibilities and expectations" />
          </div>
          <div>
            <label className="label">Additional Remarks</label>
            <textarea className="input h-24 resize-none" value={form.additional_remarks} onChange={e => set('additional_remarks', e.target.value)} placeholder="Anything else worth flagging for this role" />
          </div>
        </div>

        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Sourcing</h2>
          <div>
            <label className="label">Recruitment Channels *</label>
            <div className="flex gap-2 flex-wrap mt-1">
              {RECRUITMENT_CHANNELS.map(c => (
                <button key={c} type="button"
                  onClick={() => toggleIn('recruitment_mode', c)}
                  className={`px-3 py-1 rounded-lg text-sm border transition-colors ${
                    form.recruitment_mode.includes(c)
                      ? 'bg-dp-600 text-white border-dp-600'
                      : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                  }`}>
                  {c}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex gap-3 justify-end">
          <Link to="/roles" className="btn-secondary">Cancel</Link>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? 'Creating…' : 'Create role'}
          </button>
        </div>
      </form>
    </div>
  );
}
