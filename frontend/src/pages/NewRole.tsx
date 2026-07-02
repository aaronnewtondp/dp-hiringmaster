import { useState, FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { rolesApi } from '../services/api.ts';

const PRIORITIES = ['P0','P1','P2','P3'];
const DEPTS = ['Tech/Dev','Product/QA','Project Implementation','Domain','Sales','Operations','HR','R&D'];
const EMP_TYPES = ['Full-Time / Permanent','Contract','Internship'];
const CHANNELS = ['Naukri','LinkedIn','IIMJobs','Employee Referral','Agency','Direct Outreach'];

export default function NewRole() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: '', department: '', hiring_manager_name: '', priority: 'P1',
    new_replacement: 'New Position', num_openings: 1, location: '',
    employment_type: 'Full-Time / Permanent', yoe_required: '',
    ctc_band: '', kpi_expectations: '', job_description: '',
    must_have_skills: '', nice_to_have_skills: '',
    assignment_required: false, recruitment_mode: [] as string[],
    start_date: new Date().toISOString().slice(0,10), target_closure_date: '',
  });

  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));
  const toggleChannel = (c: string) => set('recruitment_mode',
    form.recruitment_mode.includes(c)
      ? form.recruitment_mode.filter(x => x !== c)
      : [...form.recruitment_mode, c]
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.title || !form.priority) { toast.error('Title and priority are required'); return; }
    setSaving(true);
    try {
      const res = await rolesApi.create(form as Record<string, unknown>);
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
              <label className="label">Department</label>
              <select className="select" value={form.department} onChange={e => set('department', e.target.value)}>
                <option value="">— select —</option>
                {DEPTS.map(d => <option key={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Hiring Manager</label>
              <input className="input" value={form.hiring_manager_name} onChange={e => set('hiring_manager_name', e.target.value)} placeholder="Full name" />
            </div>
            <div>
              <label className="label">Priority *</label>
              <select className="select" value={form.priority} onChange={e => set('priority', e.target.value)}>
                {PRIORITIES.map(p => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="label">New / Replacement</label>
              <select className="select" value={form.new_replacement} onChange={e => set('new_replacement', e.target.value)}>
                <option>New Position</option><option>Replacement</option>
              </select>
            </div>
            <div>
              <label className="label">Openings</label>
              <input className="input" type="number" min={1} value={form.num_openings} onChange={e => set('num_openings', parseInt(e.target.value))} />
            </div>
            <div>
              <label className="label">Location</label>
              <input className="input" value={form.location} onChange={e => set('location', e.target.value)} placeholder="e.g. Gurgaon, WFH" />
            </div>
            <div>
              <label className="label">Employment Type</label>
              <select className="select" value={form.employment_type} onChange={e => set('employment_type', e.target.value)}>
                {EMP_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Experience Range</label>
              <input className="input" value={form.yoe_required} onChange={e => set('yoe_required', e.target.value)} placeholder="e.g. 3–5 years" />
            </div>
            <div>
              <label className="label">CTC Band (₹ LPA)</label>
              <input className="input" value={form.ctc_band} onChange={e => set('ctc_band', e.target.value)} placeholder="e.g. 18–24 LPA" />
            </div>
            <div>
              <label className="label">Open Date</label>
              <input className="input" type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} />
            </div>
            <div>
              <label className="label">Target Close Date</label>
              <input className="input" type="date" value={form.target_closure_date} onChange={e => set('target_closure_date', e.target.value)} />
            </div>
          </div>
        </div>

        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Requirements</h2>
          <div>
            <label className="label">Mandatory Skills</label>
            <textarea className="input h-24 resize-none" value={form.must_have_skills} onChange={e => set('must_have_skills', e.target.value)} placeholder="Node.js; TypeScript; PostgreSQL; Docker" />
          </div>
          <div>
            <label className="label">KPI Expectations</label>
            <textarea className="input h-24 resize-none" value={form.kpi_expectations} onChange={e => set('kpi_expectations', e.target.value)} placeholder="What success looks like in this role in 90 days" />
          </div>
          <div>
            <label className="label">Job Description</label>
            <textarea className="input h-32 resize-none" value={form.job_description} onChange={e => set('job_description', e.target.value)} placeholder="Key responsibilities and expectations" />
          </div>
        </div>

        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Sourcing</h2>
          <div>
            <label className="label">Recruitment Channels</label>
            <div className="flex gap-2 flex-wrap mt-1">
              {CHANNELS.map(c => (
                <button key={c} type="button"
                  onClick={() => toggleChannel(c)}
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
          <div className="flex items-center gap-3">
            <input type="checkbox" id="assignment_required" checked={form.assignment_required}
              onChange={e => set('assignment_required', e.target.checked)} className="rounded" />
            <label htmlFor="assignment_required" className="text-sm text-gray-700">Assignment round required</label>
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
