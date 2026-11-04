import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The Roles list: what it asks the server for (default status filter, one parameter per filter), what the client-side search
// does with the rows it already has, which persona sees the Salary Range column and which wording the create button gets.
// The persona is hoisted so each test can switch it; the flags come from src/test/authMock.ts, the one place the page tests derive them
// (hr_recruiter, leadership and super_admin are HR-tier), which authMock.test.tsx checks against the real AuthContext.
const list = vi.fn();
const filterOptions = vi.fn();
vi.mock('../services/api.ts', () => ({
  rolesApi: { list: (p: unknown) => list(p), filterOptions: () => filterOptions() },
}));

const auth = vi.hoisted(() => ({ persona: 'hr_recruiter' as string }));
vi.mock('../contexts/AuthContext.tsx', () => ({ useAuth: () => authContextValue(auth.persona) }));

import { authContextValue } from '../test/authMock.ts';
import Roles from './Roles.tsx';

const DEFAULT_STATUSES = ['Approved', 'Live – Sourcing'];

const role = (over: Record<string, unknown> = {}) => ({
  id: 'R9001', title: 'Test Role Alpha', priority: 'P1', department: 'Tech/Devs', location: 'Pune', num_openings: 2,
  status: 'Live – Sourcing', hiring_manager_name: 'Hana Manager', aging_alert: 'ok', days_open: 12, days_overdue: 0,
  active_candidate_count: 4, shortlisted_count: 1, ctc_band: '10–12 LPA', ...over,
});
const ALPHA = role();
const BETA = role({
  id: 'R9002', title: 'Test Role Beta', priority: 'P2', department: 'Domain', location: 'Mumbai', status: 'Approved',
  hiring_manager_name: 'Ivan Lead', ctc_band: '20–25 LPA',
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><Roles /></MemoryRouter></QueryClientProvider>);
}
const lastParams = () => list.mock.calls[list.mock.calls.length - 1]?.[0];
const shownTitles = () => screen.queryAllByRole('link').map(a => a.textContent).filter(t => /^Test Role/.test(t ?? ''));
const searchBox = () => screen.getByPlaceholderText(/^Search by title/);

// A filter's panel is portalled onto document.body; closing it again the way a user does (a mousedown outside) keeps two panels from piling up.
const pick = (filter: RegExp, option: string) => {
  fireEvent.click(screen.getByRole('button', { name: filter }));
  fireEvent.click(screen.getByRole('checkbox', { name: option }));
  fireEvent.mouseDown(document.body);
};

beforeEach(() => {
  list.mockReset(); filterOptions.mockReset(); sessionStorage.clear();
  auth.persona = 'hr_recruiter';
  list.mockResolvedValue({ data: { roles: [ALPHA, BETA] } });
  filterOptions.mockResolvedValue({ data: { recruitment_modes: ['LinkedIn', 'Direct Outreach'] } });
});

describe('Roles — what it asks the server for', () => {
  it('asks for Approved and Live – Sourcing roles by default, and nothing else', async () => {
    mount();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(list).toHaveBeenCalledWith({ status: DEFAULT_STATUSES });
    fireEvent.click(screen.getByRole('button', { name: /^Status/ }));
    expect(screen.getByRole('checkbox', { name: 'Approved' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Live – Sourcing' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Draft' })).not.toBeChecked();
  });

  it('an empty Status selection means every status: the parameter is left out, not sent empty', async () => {
    mount();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /^Status/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Clear status/i }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(lastParams()).toEqual({});
    expect(lastParams()).not.toHaveProperty('status');
  });

  it('changing the Status selection sends exactly the chosen statuses, in the order they were picked', async () => {
    mount();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    pick(/^Status/, 'Approved');                                   // un-pick one default
    await waitFor(() => expect(lastParams()).toEqual({ status: ['Live – Sourcing'] }));
    pick(/^Status/, 'Draft');
    await waitFor(() => expect(lastParams()).toEqual({ status: ['Live – Sourcing', 'Draft'] }));
  });

  const cases: Array<[string, RegExp, string, string]> = [
    ['Department',       /^Department/,       'Tech/Devs', 'department'],
    ['Location',         /^Location/,         'Pune',      'location'],
    ['Priority',         /^Priority/,         'P0',        'priority'],
    ['Recruitment Mode', /^Recruitment Mode/, 'LinkedIn',   'recruitment_mode'],
  ];
  for (const [label, matcher, option, key] of cases) {
    it(`the ${label} filter sends ${key} as a list and keeps the default status`, async () => {
      mount();
      await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      if (label === 'Recruitment Mode') await waitFor(() => expect(filterOptions).toHaveBeenCalled());
      pick(matcher, option);
      await waitFor(() => expect(lastParams()).toEqual({ [key]: [option], status: DEFAULT_STATUSES }));
    });
  }

  it('several values for one filter go out as one list, and several filters combine in one request', async () => {
    mount();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    pick(/^Department/, 'Tech/Devs');
    pick(/^Department/, 'Domain');
    pick(/^Priority/, 'P1');
    await waitFor(() => expect(lastParams()).toEqual({ department: ['Tech/Devs', 'Domain'], priority: ['P1'], status: DEFAULT_STATUSES }));
  });

  it('offers exactly the recruitment modes the server reports', async () => {
    mount();
    await waitFor(() => expect(filterOptions).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /^Recruitment Mode/ }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'LinkedIn' })).toBeInTheDocument());
    expect(screen.getByRole('checkbox', { name: 'Direct Outreach' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Agency' })).toBeNull();     // a fixed channel list is not the source
  });

  it('until the server has answered the filter offers no recruitment mode at all, and none is made up in its place', async () => {
    filterOptions.mockReturnValue(new Promise(() => {}));
    mount();
    await waitFor(() => expect(filterOptions).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /^Recruitment Mode/ }));
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('the filter options a role can be filtered by are fixed lists, not taken from the rows', async () => {
    list.mockResolvedValue({ data: { roles: [] } });
    mount();
    await waitFor(() => expect(list).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^Location/ }));
    for (const loc of ['Gurgaon', 'Mumbai', 'Pune', 'Gujarat', 'Bangalore', 'Hyderabad', 'Others']) {
      expect(screen.getByRole('checkbox', { name: loc })).toBeInTheDocument();
    }
  });
});

describe('Roles — client-side search', () => {
  const byField: Array<[string, string, string[]]> = [
    ['title',            'alpha',    ['Test Role Alpha']],
    ['title, upper case', 'BETA',    ['Test Role Beta']],
    ['id',               'r9002',    ['Test Role Beta']],
    ['department',       'domain',   ['Test Role Beta']],
    ['location',         'mumbai',   ['Test Role Beta']],
    ['hiring manager',   'hana',     ['Test Role Alpha']],
    ['status',           'APPROVED', ['Test Role Beta']],
    ['everything (shared text)', 'test role', ['Test Role Alpha', 'Test Role Beta']],
  ];
  for (const [field, term, expected] of byField) {
    it(`matches on ${field} ("${term}"), ignoring case`, async () => {
      mount();
      await screen.findByText('Test Role Alpha');
      fireEvent.change(searchBox(), { target: { value: term } });
      expect(shownTitles()).toEqual(expected);
    });
  }

  it('never asks the server again, and says how many roles are shown', async () => {
    mount();
    await screen.findByText('Test Role Alpha');
    expect(screen.getByText(/^2 roles shown/)).toBeInTheDocument();
    const calls = list.mock.calls.length;
    fireEvent.change(searchBox(), { target: { value: 'alpha' } });
    expect(screen.getByText(/^1 roles? shown/)).toBeInTheDocument();
    fireEvent.change(searchBox(), { target: { value: '' } });
    expect(shownTitles()).toEqual(['Test Role Alpha', 'Test Role Beta']);
    expect(list).toHaveBeenCalledTimes(calls);
  });

  it('a search nothing matches shows the empty state instead of a table', async () => {
    mount();
    await screen.findByText('Test Role Alpha');
    fireEvent.change(searchBox(), { target: { value: 'zzz-no-such-role' } });
    expect(screen.getByText('No roles match this filter')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('an empty server answer shows the same empty state', async () => {
    list.mockResolvedValue({ data: { roles: [] } });
    mount();
    expect(await screen.findByText('No roles match this filter')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('Roles — loading, links and what a row shows', () => {
  it('shows a spinner (no empty state, no table) while the roles are on their way', async () => {
    let resolve!: (v: unknown) => void;
    list.mockReturnValue(new Promise(r => { resolve = r; }));
    const { container } = mount();
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByText('No roles match this filter')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    resolve({ data: { roles: [ALPHA] } });
    expect(await screen.findByText('Test Role Alpha')).toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('links each role to its own page, from the title and from the chevron', async () => {
    mount();
    await screen.findByText('Test Role Alpha');
    const row = screen.getByText('Test Role Alpha').closest('tr') as HTMLElement;
    const hrefs = within(row).getAllByRole('link').map(a => a.getAttribute('href'));
    expect(hrefs).toEqual(['/roles/R9001', '/roles/R9001']);
    expect(within(row).getByText('R9001')).toBeInTheDocument();
  });

  it('shows the openings, the Active Candidates and Active Shortlist counts and the age', async () => {
    mount();
    await screen.findByText('Test Role Alpha');
    const cells = Array.from((screen.getByText('Test Role Alpha').closest('tr') as HTMLTableRowElement).cells).map(c => c.textContent);
    expect(cells[1]).toBe('P1');
    expect(cells[2]).toBe('Tech/Devs');
    expect(cells[3]).toBe('Pune');
    expect(cells[4]).toBe('2');                    // openings
    expect(cells[5]).toBe('12d open');             // an unflagged role shows only its age
    expect(cells[6]).toBe('4');                    // Active Candidates
    expect(cells[7]).toBe('1');                    // Active Shortlist
  });

  it('missing counts read as 0, and only an Active Candidates count that really is 0 is shown in red', async () => {
    list.mockResolvedValue({ data: { roles: [
      role({ id: 'R9003', title: 'Test Role Gamma', active_candidate_count: 0, shortlisted_count: undefined }),
      role({ id: 'R9004', title: 'Test Role Delta', active_candidate_count: undefined, shortlisted_count: 5 }),
      ALPHA,
    ] } });
    mount();
    await screen.findByText('Test Role Gamma');
    const countCell = (title: string) => (screen.getByText(title).closest('tr') as HTMLTableRowElement).cells[6];
    const shortlistCell = (title: string) => (screen.getByText(title).closest('tr') as HTMLTableRowElement).cells[7];
    expect(countCell('Test Role Gamma').textContent).toBe('0');
    expect(countCell('Test Role Gamma').querySelector('span')?.className).toContain('text-red-500');
    expect(shortlistCell('Test Role Gamma').textContent).toBe('0');
    expect(countCell('Test Role Delta').textContent).toBe('0');          // an absent count falls back to showing 0 ...
    expect(countCell('Test Role Delta').querySelector('span')?.className).not.toContain('text-red-500');   // ... but is not flagged: nobody counted a zero
    expect(shortlistCell('Test Role Delta').textContent).toBe('5');
    expect(countCell('Test Role Alpha').querySelector('span')?.className).not.toContain('text-red-500');
  });

  it('flags a role past its Close Target: the age says how far over, and the row is tinted red or yellow', async () => {
    list.mockResolvedValue({ data: { roles: [
      role({ id: 'R9005', title: 'Test Role Red', aging_alert: 'red', days_open: 40, days_overdue: 9 }),
      role({ id: 'R9006', title: 'Test Role Yellow', aging_alert: 'yellow', days_open: 30, days_overdue: 2 }),
      ALPHA,
    ] } });
    mount();
    await screen.findByText('Test Role Red');
    const row = (t: string) => screen.getByText(t).closest('tr') as HTMLElement;
    expect(within(row('Test Role Red')).getByText('🔴 9d over · 40d open')).toBeInTheDocument();
    expect(row('Test Role Red').className).toContain('bg-red-50');
    expect(within(row('Test Role Yellow')).getByText('🟡 2d over · 30d open')).toBeInTheDocument();
    expect(row('Test Role Yellow').className).toContain('bg-amber-50');
    expect(row('Test Role Alpha').className).not.toMatch(/bg-red-50|bg-amber-50/);
  });
});

describe('Roles — what each persona sees', () => {
  const personas: Array<[string, boolean, string]> = [
    ['hr_recruiter',   true,  'New role'],
    ['super_admin',    true,  'New role'],
    ['leadership',     true,  'Request role'],
    ['hiring_manager', false, 'Request role'],
  ];
  for (const [persona, seesSalary, cta] of personas) {
    it(`${persona}: Salary Range ${seesSalary ? 'column and band are shown' : 'column and band are absent'}; the create button reads "${cta}" and opens the form`, async () => {
      auth.persona = persona;
      mount();
      await screen.findByText('Test Role Alpha');
      const header = screen.queryByRole('columnheader', { name: /Salary Range/ });
      if (seesSalary) {
        expect(header).toBeInTheDocument();
        expect(screen.getByText('10–12 LPA')).toBeInTheDocument();
        expect(screen.getByText('20–25 LPA')).toBeInTheDocument();
      } else {
        expect(header).toBeNull();
        expect(screen.queryByText('10–12 LPA')).toBeNull();            // the band is not merely hidden by a column, it is not rendered
        expect(screen.queryByText('20–25 LPA')).toBeNull();
      }
      const button = screen.getByRole('link', { name: new RegExp(`^${cta}$`) });
      expect(button).toHaveAttribute('href', '/roles/new');
      const other = cta === 'New role' ? 'Request role' : 'New role';
      expect(screen.queryByRole('link', { name: other })).toBeNull();
    });
  }

  it('a role with no band shows a dash in the Salary Range cell for HR-tier', async () => {
    list.mockResolvedValue({ data: { roles: [role({ ctc_band: undefined })] } });
    mount();
    await screen.findByText('Test Role Alpha');
    const cells = (screen.getByText('Test Role Alpha').closest('tr') as HTMLTableRowElement).cells;
    const headers = screen.getAllByRole('columnheader').map(h => h.textContent);
    expect(cells[headers.findIndex(h => /Salary Range/.test(h ?? ''))].textContent).toBe('—');
  });

  it('the Hiring Manager\'s rows have one cell fewer than HR-tier\'s (no Salary Range cell)', async () => {
    const hr = mount();
    await screen.findByText('Test Role Alpha');
    const hrCells = (screen.getByText('Test Role Alpha').closest('tr') as HTMLTableRowElement).cells.length;
    hr.unmount();
    auth.persona = 'hiring_manager';
    mount();
    await screen.findByText('Test Role Alpha');
    const hmCells = (screen.getByText('Test Role Alpha').closest('tr') as HTMLTableRowElement).cells.length;
    expect(hmCells).toBe(hrCells - 1);
  });
});

describe('Roles — filters survive leaving the page and coming back', () => {
  it('a chosen filter is sent again after a remount, and is stored under the hms:roles. keys', async () => {
    const first = mount();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    pick(/^Department/, 'Tech/Devs');
    await waitFor(() => expect(lastParams()).toEqual({ department: ['Tech/Devs'], status: DEFAULT_STATUSES }));
    expect(JSON.parse(sessionStorage.getItem('hms:roles.departments') as string)).toEqual(['Tech/Devs']);
    first.unmount();

    list.mockClear();
    mount();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(lastParams()).toEqual({ department: ['Tech/Devs'], status: DEFAULT_STATUSES });
  });

  it('a cleared Status selection and a typed search are remembered too', async () => {
    const first = mount();
    await screen.findByText('Test Role Alpha');
    fireEvent.click(screen.getByRole('button', { name: /^Status/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Clear status/i }));
    fireEvent.change(searchBox(), { target: { value: 'alpha' } });
    expect(JSON.parse(sessionStorage.getItem('hms:roles.statuses') as string)).toEqual([]);
    expect(sessionStorage.getItem('hms:roles.search')).toBe('"alpha"');
    first.unmount();

    list.mockClear();
    mount();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(lastParams()).toEqual({});                                  // "all statuses" survived instead of snapping back to the default
    expect(searchBox()).toHaveValue('alpha');
    await screen.findByText('Test Role Alpha');
    expect(shownTitles()).toEqual(['Test Role Alpha']);
  });
});
