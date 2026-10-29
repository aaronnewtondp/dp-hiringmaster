import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import toast from 'react-hot-toast';

// The add-candidate form: each required field blocks the submit with its own message, the Agency source needs an agency (and
// drops it again when the source changes), the numbers go out as numbers and the empty optional strings as null, a duplicate
// is named, and only HR-tier loads the agency list. A control is found through the label it sits under (labels are not wired up).
const create = vi.fn();
const rolesList = vi.fn();
const agenciesList = vi.fn();
vi.mock('../services/api.ts', () => ({
  candidatesApi: { create: (d: unknown) => create(d) },
  rolesApi: { list: (p: unknown) => rolesList(p) },
  agenciesApi: { list: () => agenciesList() },
}));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const auth = vi.hoisted(() => ({ persona: 'hr_recruiter' as string }));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => {
    const p = auth.persona;
    return { user: { id: 'u-test', name: 'Test Person', email: 'test.person@example.test', persona: p },
             canHR: p === 'hr_recruiter' || p === 'leadership' || p === 'super_admin' };
  },
}));

import NewCandidate from './NewCandidate.tsx';

const toastError = vi.mocked(toast.error);
const toastSuccess = vi.mocked(toast.success);

function Landing() { const { id } = useParams(); return <div data-testid="candidate-page">{id}</div>; }
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/candidates/new']}>
        <Routes>
          <Route path="/candidates/new" element={<NewCandidate />} />
          <Route path="/candidates/:id" element={<Landing />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

type Control = HTMLInputElement | HTMLSelectElement;
const control = (label: string): Control => (screen.getByText(label).parentElement as HTMLElement).querySelector('input, select') as Control;
const setValue = (label: string, value: string) => fireEvent.change(control(label), { target: { value } });
const submit = () => fireEvent.submit(document.querySelector('form') as HTMLFormElement);
const saveButton = () => screen.getByRole('button', { name: /^(Add candidate|Saving…)$/ });

// [the name used in "<name> is required", the label the control sits under]
const REQUIRED: Array<[string, string]> = [
  ['Full Name', 'Full Name *'],
  ['Email', 'Email *'],
  ['Phone Number', 'Phone Number *'],
  ['Role applying for', 'Role applying for *'],
  ['Current Company', 'Current Company *'],
  ['Current Industry', 'Current Industry *'],
  ['Current Location', 'Current Location *'],
  ['Years of Experience', 'Years of Experience *'],
  ['Preferred Location', 'Preferred Location *'],
  ['Languages Known', 'Languages Known *'],
  ['Current CTC (Fixed and Variable breakup) in LPA', 'Current CTC (Fixed and Variable breakup) in LPA *'],
  ['Expected CTC', 'Expected CTC (LPA) *'],
  ['Notice Period', 'Notice Period (days) *'],
  ['Resume — Google Drive link', 'Resume — Google Drive link *'],
];
const VALID: Record<string, string> = {
  'Full Name *': 'Test Candidate', 'Email *': 'test.candidate@example.test', 'Phone Number *': '+91 0000000000',
  'Role applying for *': 'R9001', 'Current Company *': 'Example Co', 'Current Industry *': 'Water Treatment',
  'Current Location *': 'Pune', 'Years of Experience *': '4.5', 'Preferred Location *': 'Mumbai', 'Languages Known *': 'English, Hindi',
  'Current CTC (Fixed and Variable breakup) in LPA *': '12.5', 'Expected CTC (LPA) *': '15', 'Notice Period (days) *': '30',
  'Resume — Google Drive link *': 'https://drive.example/resume',
};

async function fillValid() {
  await screen.findByRole('option', { name: 'Test Role Alpha' });          // the role list has to be there before a role can be chosen
  for (const [label, value] of Object.entries(VALID)) setValue(label, value);
}

beforeEach(() => {
  create.mockReset(); rolesList.mockReset(); agenciesList.mockReset(); toastError.mockClear(); toastSuccess.mockClear();
  auth.persona = 'hr_recruiter';
  create.mockResolvedValue({ data: { candidate: { id: 'C9100' } } });
  rolesList.mockResolvedValue({ data: { roles: [{ id: 'R9001', title: 'Test Role Alpha' }, { id: 'R9002', title: 'Test Role Beta' }] } });
  agenciesList.mockResolvedValue({ data: { agencies: [{ id: 'AGN901', name: 'Test Agency One' }, { id: 'AGN902', name: 'Test Agency Two' }] } });
});

describe('NewCandidate — required fields', () => {
  for (const [name, label] of REQUIRED) {
    it(`a blank ${name} stops the submit with "${name} is required" and sends nothing`, async () => {
      mount();
      await fillValid();
      setValue(label, '');
      submit();
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastError).toHaveBeenCalledWith(`${name} is required`);
      expect(create).not.toHaveBeenCalled();
    });
  }

  it('a field holding only spaces counts as blank', async () => {
    mount();
    await fillValid();
    setValue('Current Company *', '   ');
    submit();
    expect(toastError).toHaveBeenCalledWith('Current Company is required');
    expect(create).not.toHaveBeenCalled();
  });

  it('with nothing filled in the first field is the one reported', () => {
    mount();
    submit();
    expect(toastError).toHaveBeenCalledWith('Full Name is required');
    expect(create).not.toHaveBeenCalled();
  });

  it('LinkedIn URL, Current Designation and Source are optional', async () => {
    mount();
    await fillValid();
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('NewCandidate — Source = Agency', () => {
  const agencySelect = () => control('Sourcing Agency *') as HTMLSelectElement;

  it('asks for the agency only while the source is Agency, listing the agencies by name', async () => {
    mount();
    await screen.findByRole('option', { name: 'Test Role Alpha' });
    expect(screen.queryByText('Sourcing Agency *')).toBeNull();
    setValue('Source', 'Agency');
    await screen.findByRole('option', { name: 'Test Agency One' });
    expect(Array.from(agencySelect().options).map(o => o.value)).toEqual(['', 'AGN901', 'AGN902']);
    setValue('Source', 'LinkedIn');
    expect(screen.queryByText('Sourcing Agency *')).toBeNull();
  });

  it('refuses to submit until an agency is chosen', async () => {
    mount();
    await fillValid();
    setValue('Source', 'Agency');
    submit();
    expect(toastError).toHaveBeenCalledWith('Select which agency sourced this candidate');
    expect(create).not.toHaveBeenCalled();
  });

  it('sends the chosen agency as sourced_by_agency_id, with the source', async () => {
    mount();
    await fillValid();
    setValue('Source', 'Agency');
    await screen.findByRole('option', { name: 'Test Agency Two' });
    setValue('Sourcing Agency *', 'AGN902');
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({ source: 'Agency', sourced_by_agency_id: 'AGN902' });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('changing the Source away from Agency drops the agency that had been chosen: none is sent, and it is gone if Agency is picked again', async () => {
    mount();
    await fillValid();
    setValue('Source', 'Agency');
    await screen.findByRole('option', { name: 'Test Agency One' });
    setValue('Sourcing Agency *', 'AGN901');
    setValue('Source', 'LinkedIn');
    setValue('Source', 'Agency');
    expect(agencySelect().value).toBe('');                       // the earlier choice did not come back
    setValue('Source', 'LinkedIn');
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0][0];
    expect(payload.source).toBe('LinkedIn');
    expect(payload.sourced_by_agency_id).toBeNull();
  });
});

describe('NewCandidate — what is sent', () => {
  it('converts the four numeric fields to numbers and turns every empty optional string into null', async () => {
    mount();
    await fillValid();
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toEqual({
      full_name: 'Test Candidate', email: 'test.candidate@example.test', phone: '+91 0000000000', linkedin_url: null,
      role_id: 'R9001', source: null, sourced_by_agency_id: null, agency_id: null,
      current_ctc_fixed: 12.5, expected_ctc: 15, notice_period_days: 30,
      current_company: 'Example Co', current_industry: 'Water Treatment', current_designation: null,
      current_location: 'Pune', years_of_experience: 4.5, preferred_location: 'Mumbai', languages_known: 'English, Hindi',
      resume_drive_link: 'https://drive.example/resume',
    });
  });

  it('sends the optional fields when they are filled in', async () => {
    mount();
    await fillValid();
    setValue('LinkedIn URL', 'linkedin.example/in/test-candidate');
    setValue('Current Designation', 'Process Engineer');
    setValue('Source', 'Direct Outreach');
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({
      linkedin_url: 'linkedin.example/in/test-candidate', current_designation: 'Process Engineer', source: 'Direct Outreach',
    });
  });

  it('a notice period of 0 days is a real answer: it is sent as 0, not dropped as empty', async () => {
    mount();
    await fillValid();
    setValue('Notice Period (days) *', '0');
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].notice_period_days).toBe(0);
  });

  it('says "Candidate added" and opens the new candidate\'s page', async () => {
    create.mockResolvedValue({ data: { candidate: { id: 'C9123' } } });
    mount();
    await fillValid();
    submit();
    expect(await screen.findByTestId('candidate-page')).toHaveTextContent('C9123');
    expect(toastSuccess).toHaveBeenCalledWith('Candidate added');
  });

  it('while saving, the button is disabled and says so, and nothing is sent twice', async () => {
    let resolve!: (v: unknown) => void;
    create.mockReturnValue(new Promise(r => { resolve = r; }));
    mount();
    await fillValid();
    submit();
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saving…'));
    expect(saveButton()).toBeDisabled();
    resolve({ data: { candidate: { id: 'C9124' } } });
    await screen.findByTestId('candidate-page');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('NewCandidate — a failed save', () => {
  const failWith = (err: unknown) => create.mockImplementation(async () => { throw err; });

  it('a duplicate (409) names the candidate who already exists, and stays on the form', async () => {
    failWith(Object.assign(new Error('Conflict'), { response: { status: 409, data: { existing_id: 'C9001', existing_name: 'Test Candidate' } } }));
    mount();
    await fillValid();
    submit();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Duplicate — Test Candidate already exists (C9001)'));
    expect(screen.queryByTestId('candidate-page')).toBeNull();
    await waitFor(() => expect(saveButton()).toBeEnabled());
  });

  it('any other failure is a generic message, whatever the server said', async () => {
    failWith(Object.assign(new Error('Server Error'), { response: { status: 500, data: { error: 'internal detail' } } }));
    mount();
    await fillValid();
    submit();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to add candidate'));
    expect(screen.queryByTestId('candidate-page')).toBeNull();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe('NewCandidate — what it loads', () => {
  it('offers the roles that are Live – Sourcing, by title, and sends the role\'s id', async () => {
    mount();
    await screen.findByRole('option', { name: 'Test Role Beta' });
    expect(rolesList).toHaveBeenCalledTimes(1);
    expect(rolesList).toHaveBeenCalledWith({ status: 'Live – Sourcing' });
    const select = control('Role applying for *') as HTMLSelectElement;
    expect(Array.from(select.options).map(o => [o.value, o.textContent])).toEqual([
      ['', 'Select a role…'], ['R9001', 'Test Role Alpha'], ['R9002', 'Test Role Beta'],
    ]);
  });

  for (const [persona, loads] of [['hr_recruiter', true], ['super_admin', true], ['leadership', true], ['hiring_manager', false]] as const) {
    it(`${persona}: the agency list is ${loads ? 'loaded' : 'never requested'}`, async () => {
      auth.persona = persona;
      mount();
      await screen.findByRole('option', { name: 'Test Role Alpha' });
      if (loads) await waitFor(() => expect(agenciesList).toHaveBeenCalledTimes(1));
      else expect(agenciesList).not.toHaveBeenCalled();
    });
  }

  it('a persona without the agency list has no agency to choose when the source is Agency', async () => {
    auth.persona = 'hiring_manager';
    mount();
    await fillValid();
    setValue('Source', 'Agency');
    const agencySelect = control('Sourcing Agency *') as HTMLSelectElement;
    expect(Array.from(agencySelect.options).map(o => o.value)).toEqual(['']);
    submit();
    expect(toastError).toHaveBeenCalledWith('Select which agency sourced this candidate');
    expect(create).not.toHaveBeenCalled();
  });
});
