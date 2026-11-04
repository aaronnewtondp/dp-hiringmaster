import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { HIRING_MANAGER_FIELD_HINT } from '../utils/hiringManagers.ts';

// The role form: every required field blocks the submit with its own message, the Hiring Manager's form has no compensation
// band and starts with their own name, Leadership and the Hiring Manager both "request" a role while HR "creates" one, and
// what is sent is shaped the way the server expects. The labels are not wired to their inputs, so a control is found through
// the label it sits under.
const create = vi.fn();
vi.mock('../services/api.ts', () => ({ rolesApi: { create: (d: unknown) => create(d) } }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const auth = vi.hoisted(() => ({ persona: 'hr_recruiter' as string, name: 'Hana Manager' }));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'u-test', name: auth.name, email: 'test.person@example.test', persona: auth.persona } }),
}));

import NewRole from './NewRole.tsx';

const toastError = vi.mocked(toast.error);
const toastSuccess = vi.mocked(toast.success);

function Landing() { const { id } = useParams(); return <div data-testid="role-page">{id}</div>; }
function mount() {
  return render(
    <MemoryRouter initialEntries={['/roles/new']}>
      <Routes>
        <Route path="/roles/new" element={<NewRole />} />
        <Route path="/roles/:id" element={<Landing />} />
        <Route path="/roles" element={<div data-testid="roles-list" />} />
      </Routes>
    </MemoryRouter>,
  );
}

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const control = (label: string): Control => {
  const l = screen.getByText(label);
  return (l.parentElement as HTMLElement).querySelector('input, select, textarea') as Control;
};
const setValue = (label: string, value: string) => fireEvent.change(control(label), { target: { value } });
const submit = () => fireEvent.submit(document.querySelector('form') as HTMLFormElement);
const toggle = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const submitButton = () => screen.getByRole('button', { name: /^(Create role|Creating…|Submit request|Submitting…)$/ });

// [payload key, the name in the "<name> is required" message, the label the control sits under]
const REQUIRED: Array<[string, string, string]> = [
  ['title',                  'Role Title',                  'Role Title *'],
  ['department',             'Department',                  'Department *'],
  ['hiring_manager_name',    'Hiring Manager',              'Hiring Manager *'],
  ['location',               'Location',                    'Location *'],
  ['yoe_required',           'Experience Range',            'Experience Range *'],
  ['qualification_required', 'Educational Qualifications',  'Educational Qualifications *'],
  ['ctc_band',               'CTC Band',                    'CTC Band (₹ LPA) *'],
  ['job_description',        'Job Description',             'Job Description *'],
  ['must_have_skills',       'Must Have Skills',            'Must Have Skills *'],
  ['nice_to_have_skills',    'Nice to Have Skills',         'Nice to Have Skills *'],
  ['target_closure_date',    'Target Close Date',           'Target Close Date *'],
];
const VALID: Record<string, string> = {
  'Role Title *': 'Test Platform Engineer', 'Department *': 'Tech/Devs', 'Hiring Manager *': 'Hana Manager', 'Location *': 'Pune',
  'Experience Range *': '3–5 years', 'Educational Qualifications *': 'B.Tech', 'CTC Band (₹ LPA) *': '18–24 LPA',
  'Target Close Date *': '2026-12-31', 'Must Have Skills *': 'Node.js; SQL', 'Nice to Have Skills *': 'Docker', 'Job Description *': 'Build things',
};

// Fills everything the form needs (what the persona can see), then the two toggle groups.
function fillValid() {
  for (const [label, value] of Object.entries(VALID)) {
    if (screen.queryByText(label)) setValue(label, value);
  }
  toggle('Resignation');
  toggle('LinkedIn');
}

beforeEach(() => {
  create.mockReset(); toastError.mockClear(); toastSuccess.mockClear();
  auth.persona = 'hr_recruiter'; auth.name = 'Hana Manager';
  create.mockResolvedValue({ data: { role: { id: 'R9100' } } });
});

describe('NewRole — required fields', () => {
  for (const [, name, label] of REQUIRED) {
    it(`a blank ${name} stops the submit with "${name} is required" and sends nothing`, async () => {
      mount();
      fillValid();
      setValue(label, '');
      submit();
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastError).toHaveBeenCalledWith(`${name} is required`);
      expect(create).not.toHaveBeenCalled();
    });
  }

  it('a field holding only spaces counts as blank', () => {
    mount();
    fillValid();
    setValue('Role Title *', '    ');
    submit();
    expect(toastError).toHaveBeenCalledWith('Role Title is required');
    expect(create).not.toHaveBeenCalled();
  });

  it('with nothing filled in, the first field is the one reported, then the next as each is filled', () => {
    mount();
    submit();
    expect(toastError).toHaveBeenLastCalledWith('Role Title is required');
    setValue('Role Title *', 'Test Platform Engineer');
    submit();
    expect(toastError).toHaveBeenLastCalledWith('Department is required');
    setValue('Department *', 'Tech/Devs');
    submit();
    expect(toastError).toHaveBeenLastCalledWith('Hiring Manager is required');
    expect(create).not.toHaveBeenCalled();
  });

  it('the optional fields (KPI Expectations, Additional Remarks) are not required', async () => {
    mount();
    fillValid();
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('NewRole — openings, vacancy reason and recruitment channel', () => {
  for (const [what, value] of [['zero', '0'], ['negative', '-2'], ['cleared', '']] as const) {
    it(`${what} openings stop the submit: "Openings must be at least 1"`, () => {
      // clearing the field makes the form hold NaN, which React reports as a console warning; that is not what is under test
      const noise = vi.spyOn(console, 'error').mockImplementation(() => {});
      mount();
      fillValid();
      setValue('Openings *', value);
      submit();
      expect(toastError).toHaveBeenCalledWith('Openings must be at least 1');
      expect(create).not.toHaveBeenCalled();
      noise.mockRestore();
    });
  }

  it('no Vacancy Caused Due To option stops the submit, and a toggled-off option is as good as none', () => {
    mount();
    fillValid();
    toggle('Resignation');                                          // off again
    submit();
    expect(toastError).toHaveBeenCalledWith('Select at least one Vacancy Caused Due To option');
    expect(create).not.toHaveBeenCalled();
  });

  it('no Recruitment Channel stops the submit', () => {
    mount();
    fillValid();
    toggle('LinkedIn');                                             // off again
    submit();
    expect(toastError).toHaveBeenCalledWith('Select at least one Recruitment Channel');
    expect(create).not.toHaveBeenCalled();
  });

  it('the checks run in order: text fields, openings, vacancy reason, channel', () => {
    mount();
    for (const [label, value] of Object.entries(VALID)) setValue(label, value);
    setValue('Openings *', '0');
    submit();
    expect(toastError).toHaveBeenLastCalledWith('Openings must be at least 1');
    setValue('Openings *', '1');
    submit();
    expect(toastError).toHaveBeenLastCalledWith('Select at least one Vacancy Caused Due To option');
    toggle('Resignation');
    submit();
    expect(toastError).toHaveBeenLastCalledWith('Select at least one Recruitment Channel');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('NewRole — what is sent', () => {
  it('sends every field as typed, openings as a number, the toggles as lists, and always asks for an assignment round', async () => {
    mount();
    fillValid();
    toggle('New Project');
    toggle('Direct Outreach');
    setValue('Openings *', '3');
    setValue('Priority *', 'P0');
    setValue('New / Replacement *', 'Replacement');
    setValue('Employment Type *', 'Contract');
    setValue('KPI Expectations', 'Ship the first release');
    setValue('Additional Remarks', 'Reports to the platform lead');
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0][0];
    expect(payload).toEqual({
      title: 'Test Platform Engineer', department: 'Tech/Devs', hiring_manager_name: 'Hana Manager', priority: 'P0',
      new_or_replacement: 'Replacement', vacancy_reason: ['Resignation', 'New Project'], num_openings: 3, location: 'Pune',
      employment_type: 'Contract', yoe_required: '3–5 years', qualification_required: 'B.Tech', ctc_band: '18–24 LPA',
      kpi_expectations: 'Ship the first release', job_description: 'Build things', must_have_skills: 'Node.js; SQL',
      nice_to_have_skills: 'Docker', additional_remarks: 'Reports to the platform lead', recruitment_mode: ['LinkedIn', 'Direct Outreach'],
      target_closure_date: '2026-12-31', assignment_required: true,
    });
    expect(typeof payload.num_openings).toBe('number');
  });

  it('starts as a one-opening P1 New Position, Full-Time / Permanent', async () => {
    mount();
    fillValid();
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({
      priority: 'P1', new_or_replacement: 'New Position', num_openings: 1, employment_type: 'Full-Time / Permanent',
    });
  });

  it('goes to the new role\'s page once it is created', async () => {
    create.mockResolvedValue({ data: { role: { id: 'R9123' } } });
    mount();
    fillValid();
    submit();
    expect(await screen.findByTestId('role-page')).toHaveTextContent('R9123');
  });

  it('while it is being saved the button is disabled and says so, and the form is not sent twice', async () => {
    let resolve!: (v: unknown) => void;
    create.mockReturnValue(new Promise(r => { resolve = r; }));
    mount();
    fillValid();
    submit();
    await waitFor(() => expect(submitButton()).toHaveTextContent('Creating…'));
    expect(submitButton()).toBeDisabled();
    resolve({ data: { role: { id: 'R9124' } } });
    expect(await screen.findByTestId('role-page')).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('NewRole — a server error', () => {
  const failWith = (err: unknown) => create.mockImplementation(async () => { throw err; });

  it('shows the server\'s own message, stays on the form and lets the user try again', async () => {
    failWith(Object.assign(new Error('Request failed'), { response: { data: { error: 'A role with this title already exists' } } }));
    mount();
    fillValid();
    submit();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('A role with this title already exists'));
    expect(screen.queryByTestId('role-page')).toBeNull();
    expect(toastSuccess).not.toHaveBeenCalled();
    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(submitButton()).toHaveTextContent('Create role');
  });

  it('falls back to a generic message when the server gave none: "create" for HR', async () => {
    failWith(new Error('Network Error'));
    mount();
    fillValid();
    submit();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to create role'));
    expect(screen.queryByTestId('role-page')).toBeNull();
  });

  it('falls back to a generic message when the server gave none: "request" for a Hiring Manager', async () => {
    auth.persona = 'hiring_manager';
    failWith(new Error('Network Error'));
    mount();
    fillValid();
    submit();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to submit request'));
  });
});

describe('NewRole — what each persona sees and gets', () => {
  const personas: Array<{ persona: string; heading: string; button: string; success: string; ctc: boolean; prefilled: boolean }> = [
    { persona: 'hr_recruiter',   heading: 'Create new role',  button: 'Create role',    success: 'Role created',                         ctc: true,  prefilled: false },
    { persona: 'super_admin',    heading: 'Create new role',  button: 'Create role',    success: 'Role created',                         ctc: true,  prefilled: false },
    { persona: 'leadership',     heading: 'Request new role', button: 'Submit request', success: 'Role requested — HR will review it shortly', ctc: true,  prefilled: false },
    { persona: 'hiring_manager', heading: 'Request new role', button: 'Submit request', success: 'Role requested — HR will review it shortly', ctc: false, prefilled: true },
  ];
  for (const p of personas) {
    it(`${p.persona}: heading "${p.heading}", button "${p.button}", ${p.ctc ? 'with' : 'without'} the CTC Band, Hiring Manager ${p.prefilled ? 'prefilled with their own name' : 'empty'}`, async () => {
      auth.persona = p.persona;
      mount();
      expect(screen.getByRole('heading', { level: 1, name: p.heading })).toBeInTheDocument();
      expect(submitButton()).toHaveTextContent(p.button);
      if (p.ctc) expect(screen.getByText('CTC Band (₹ LPA) *')).toBeInTheDocument();
      else expect(screen.queryByText(/^CTC Band/)).toBeNull();
      expect(control('Hiring Manager *')).toHaveValue(p.prefilled ? 'Hana Manager' : '');

      fillValid();
      expect(control('Hiring Manager *')).toHaveValue('Hana Manager');
      submit();
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(p.success));
      expect(toastError).not.toHaveBeenCalled();
      expect(await screen.findByTestId('role-page')).toBeInTheDocument();
    });
  }

  it('the Hiring Manager is not asked for a band and never sends one, and the missing band does not block the submit', async () => {
    auth.persona = 'hiring_manager';
    mount();
    fillValid();
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].ctc_band).toBe('');
  });

  it('Leadership still has to give a band: it is the Hiring Manager alone who is exempt', () => {
    auth.persona = 'leadership';
    mount();
    fillValid();
    setValue('CTC Band (₹ LPA) *', '');
    submit();
    expect(toastError).toHaveBeenCalledWith('CTC Band is required');
    expect(create).not.toHaveBeenCalled();
  });

  it('the Hiring Manager can overwrite the prefilled name, and a blank one is still refused', () => {
    auth.persona = 'hiring_manager';
    mount();
    fillValid();
    setValue('Hiring Manager *', '');
    submit();
    expect(toastError).toHaveBeenCalledWith('Hiring Manager is required');
    setValue('Hiring Manager *', 'Hana Manager, Ivan Lead');
    submit();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].hiring_manager_name).toBe('Hana Manager, Ivan Lead');
  });

  it('explains how to name several Hiring Managers next to the field', () => {
    mount();
    expect(screen.getByText(HIRING_MANAGER_FIELD_HINT)).toBeInTheDocument();
  });
});
