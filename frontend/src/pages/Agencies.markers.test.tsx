import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { backendFacts } from '../test/backendSource.ts';

// What the Agency Repository, the agency page and User Management say about their numbers and fields. Each assertion pins a
// sentence; the fact behind it, which the backend decides, is named in the comment. A figure the sentence quotes (how long a
// sign-in lasts) is taken from the backend's own source (src/test/backendSource.ts), not typed here.
const agenciesList = vi.fn();
const agenciesGet = vi.fn();
const usersList = vi.fn();
vi.mock('../services/api.ts', () => ({
  agenciesApi: { list: () => agenciesList(), get: () => agenciesGet(), update: vi.fn() },
  usersApi: { list: () => usersList(), create: vi.fn(), update: vi.fn() },
}));
vi.mock('../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Test Admin', persona: 'super_admin' } }) }));

import Agencies from './Agencies.tsx';
import AgencyDetail from './AgencyDetail.tsx';
import UserManagement from './UserManagement.tsx';

const agency = (over: Record<string, unknown> = {}) => ({
  id: 'AGN001', name: 'Test Agency', contract_status: 'Active', specialisations: 'Engineering', total_submitted: 0, total_hired: 3, ...over,
});

function mount(ui: React.ReactElement, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter></QueryClientProvider>);
}
const th = (label: string) => screen.getAllByRole('columnheader').find(h => h.textContent?.trim() === label)!;

beforeEach(() => {
  agenciesList.mockReset(); agenciesGet.mockReset(); usersList.mockReset();
  agenciesList.mockResolvedValue({ data: { agencies: [agency()] } });
  agenciesGet.mockResolvedValue({ data: { agency: agency() } });
  usersList.mockResolvedValue({ data: { users: [{ id: 'u2', name: 'Test Person', email: 'person@example.test', persona: 'hiring_manager', department: null, is_active: true, last_login: null }] } });
});

describe('Agency Repository', () => {
  it('Hires: counted once per candidate on the application\'s STAGE, so a candidate who accepted and later withdrew still counts', async () => {
    mount(<Agencies />);
    await screen.findByText('Test Agency');
    const cell = th('Hires');
    fireEvent.mouseEnter(cell.querySelector('[aria-label="More info"]')!);
    const tip = cell.querySelector('div.absolute')!.textContent!;
    expect(tip).toContain('Offer Accepted or Joined');                              // routes/agencies.ts TOTAL_HIRED_SUBQUERY: stage IN (...), no status test
    expect(tip).toContain('counted once per candidate');
    expect(tip).toContain('a candidate who accepted and later withdrew still counts');
  });

  it('Status is the contract status for reference and blocks nothing; the specialisations column is called Requirement Type', async () => {
    mount(<Agencies />);
    await screen.findByText('Test Agency');
    expect(th('Status').getAttribute('title')).toContain("The agency's contract status, for reference");
    expect(th('Status').getAttribute('title')).toContain("doesn't block anything in HMS");   // contract_status is only read and written; every agency is selectable
    expect(th('Requirement Type').getAttribute('title')).toContain('specialises in');
  });
});

describe('Agency page', () => {
  const renderDetail = () => mount(<Routes><Route path="/agencies/:id" element={<AgencyDetail />} /></Routes>, '/agencies/AGN001');

  it('Submitted and Hired use two different linkages, so Submitted is normally 0 and can be lower than Hired', async () => {
    renderDetail();
    await screen.findByText('0 submitted');
    expect(screen.getByText('3 hired')).toBeInTheDocument();
    const box = screen.getByText('3 hired').parentElement!;
    fireEvent.mouseEnter(box.querySelector('[aria-label="More info"]')!);
    const tip = box.querySelector('div.absolute')!.textContent!;
    expect(tip).toContain("whose Sourcing Agency is this agency");                    // hired: candidates.sourced_by_agency_id
    expect(tip).toContain("application's own Agency field");                           // submitted: applications.agency_id, which no screen sets
    expect(tip).toContain('No screen in HMS fills that field in');
    expect(tip).toContain('can be lower than Hired');
  });

  it('calls the field the list calls Requirement Type, and explains the contract status', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Test Agency' });
    expect(screen.getByText('Requirement Type')).toBeInTheDocument();
    expect(screen.queryByText('Specialisations')).not.toBeInTheDocument();
    const title = screen.getByText('Contract');
    fireEvent.mouseEnter(title.parentElement!.querySelector('[aria-label="More info"]')!);
    expect(title.parentElement!.querySelector('div.absolute')!.textContent).toContain("doesn't block anything in HMS");
  });
});

describe('User Management', () => {
  it('Name must match the role\'s Hiring Manager field; Role says what each persona sees; Status says what deactivating does and does not do', async () => {
    mount(<UserManagement />);
    await screen.findByText('Test Person');
    const name = th('Name').getAttribute('title')!;
    expect(name).toContain("the way it appears in a role's Hiring Manager field");   // utils/hiringManagers.ts: whole-name match on users.name
    expect(name).toContain('capitals and extra spaces do not matter, spelling does');
    expect(name).not.toContain('exactly');                                           // "exactly" contradicted "capitals are ignored"
    const role = th('Role').getAttribute('title')!;
    expect(role).toContain('HR/Admin and Leadership have the same access to roles, candidates and compensation');
    expect(role).toContain('only for roles that name them as Hiring Manager');        // canSeeCompForRole, applyHiringManagerRoleLock
    const status = th('Status').getAttribute('title')!;
    expect(status).toContain('Deactivating stops them signing in again');             // routes/auth.ts: both sign-in routes need is_active
    // middleware/auth.ts authenticate() only verifies the token: a person who is already signed in keeps working until it expires
    expect(status).toContain(`a session that is already open keeps working until it expires (${backendFacts().sessionHours} hours by default)`);
    expect(status).toContain('Their history stays on candidates and roles');
  });

  it('the form repeats the help under Name, Email and Role', async () => {
    mount(<UserManagement />);
    await screen.findByText('Test Person');
    fireEvent.click(screen.getByRole('button', { name: /Add user/ }));
    expect(await screen.findByText(/HMS matches Hiring Managers to roles by name: capitals and extra spaces do not matter/)).toBeInTheDocument();
    expect(screen.getByText(/only people added here can sign in/)).toBeInTheDocument();     // routes/auth.ts: sign-in needs an active users row
    expect(screen.getByText(/same access to roles, candidates and compensation/)).toBeInTheDocument();
  });
});
