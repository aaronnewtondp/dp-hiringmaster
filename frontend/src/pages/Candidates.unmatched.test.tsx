import '../test/loadTolerance.ts';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';

// Active Candidates — the Unmatched Candidates panel: people with no application, the one-click and manual "Link to role",
// Delete with confirmation, and the 50-at-a-time "Load more".
const h = vi.hoisted(() => ({
  persona: 'hr_recruiter' as 'hr_recruiter' | 'hiring_manager' | 'leadership' | 'super_admin',
  list: vi.fn(), advanceStage: vi.fn(), updateStatus: vi.fn(),
  unmatched: vi.fn(), linkRole: vi.fn(), remove: vi.fn(), filterOptions: vi.fn(), rolesList: vi.fn(),
  toastSuccess: vi.fn(), toastError: vi.fn(),
}));
vi.mock('../services/api.ts', () => ({
  applicationsApi: {
    list: (p: unknown) => h.list(p),
    advanceStage: (...a: unknown[]) => h.advanceStage(...a),
    updateStatus: (...a: unknown[]) => h.updateStatus(...a),
  },
  candidatesApi: {
    unmatched: (p: unknown) => h.unmatched(p),
    linkRole: (...a: unknown[]) => h.linkRole(...a),
    remove: (...a: unknown[]) => h.remove(...a),
    list: vi.fn(),
  },
  rolesApi: { filterOptions: () => h.filterOptions(), list: (p: unknown) => h.rolesList(p) },
}));
// The same derivation AuthContext uses for these two flags (its own tests pin the real one).
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({
    canHR: h.persona !== 'hiring_manager',
    canLead: h.persona === 'leadership' || h.persona === 'super_admin',
  }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: (m: string) => h.toastSuccess(m), error: (m: string) => h.toastError(m) } }));

import Candidates from './Candidates.tsx';
import { APPS, FILTER_OPTIONS, LIVE_ROLES, unmatchedRow } from '../test/candidateFixtures.ts';

// react-query hands results to React through setTimeout(0). The debounce tests fake setTimeout, so give the query
// library the real one: only the page's own timer is then driven by the fake clock.
const realSetTimeout = globalThis.setTimeout;
beforeAll(() => { notifyManager.setScheduler(cb => { realSetTimeout(cb, 0); }); });

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><Candidates /></MemoryRouter></QueryClientProvider>);
}
const showList = async () => { mount(); await screen.findByText('Test Candidate A9001'); };
const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLTableRowElement;
const names = () => Array.from(document.querySelectorAll('tbody tr')).map(tr => tr.querySelector('a')?.textContent);
// Opens a multi-select filter (its panel is a portal on document.body) and ticks one option.
const pick = async (filter: RegExp, option: string) => {
  fireEvent.click(screen.getByRole('button', { name: filter }));
  fireEvent.click(await screen.findByLabelText(option));
};

beforeEach(() => {
  h.persona = 'hr_recruiter';
  for (const f of [h.list, h.advanceStage, h.updateStatus, h.unmatched, h.linkRole, h.remove, h.filterOptions, h.rolesList, h.toastSuccess, h.toastError]) f.mockReset();
  sessionStorage.clear();
  h.list.mockResolvedValue({ data: { applications: APPS } });
  h.advanceStage.mockResolvedValue({ data: {} });
  h.updateStatus.mockResolvedValue({ data: {} });
  h.unmatched.mockResolvedValue({ data: { submissions: [], total: 0 } });
  h.filterOptions.mockResolvedValue(FILTER_OPTIONS);
  h.rolesList.mockResolvedValue(LIVE_ROLES);
  h.linkRole.mockResolvedValue({ data: {} });
  h.remove.mockResolvedValue({ data: {} });
});
afterEach(() => { vi.useRealTimers(); });

describe('Active Candidates — the Unmatched Candidates panel', () => {
  const SUGGESTED = unmatchedRow(1, { suggested_role_id: 'R9001', suggested_role_title: 'Test Role Alpha', submitted_text: 'Test Role Alpha opening' });
  const PLAIN = unmatchedRow(2);
  const open = async (count: number) => { await showList(); fireEvent.click(await screen.findByText(`Unmatched Candidates (${count})`)); };

  beforeEach(() => { h.unmatched.mockResolvedValue({ data: { submissions: [SUGGESTED, PLAIN], total: 2 } }); });

  it('shows a collapsed header with the total, and expands to the people', async () => {
    await showList();
    expect(await screen.findByText('Unmatched Candidates (2)')).toBeInTheDocument();
    expect(screen.queryByText('Test Unmatched 1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Unmatched Candidates (2)'));
    expect(await screen.findByText('Test Unmatched 1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Test Unmatched 1' })).toHaveAttribute('href', '/candidates/C-U1');
    expect(screen.getByText('u1@example.test')).toBeInTheDocument();
    expect(screen.getByText(/applied for "Test Role Alpha opening"/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Unmatched Candidates (2)'));                  // and collapses again
    expect(screen.queryByText('Test Unmatched 1')).not.toBeInTheDocument();
  });

  it('asks for the first 50', async () => {
    await showList();
    await screen.findByText('Unmatched Candidates (2)');
    expect(h.unmatched).toHaveBeenCalledWith({ limit: '50', offset: '0' });
  });

  it('is not shown at all when there is nobody unmatched', async () => {
    h.unmatched.mockResolvedValue({ data: { submissions: [], total: 0 } });
    await showList();
    await waitFor(() => expect(h.unmatched).toHaveBeenCalled());
    expect(screen.queryByText(/Unmatched Candidates/)).not.toBeInTheDocument();
  });

  it('is hidden while a Role filter is active (someone with no application belongs to no role)', async () => {
    await showList();
    await screen.findByText('Unmatched Candidates (2)');
    await pick(/^Role/, 'Test Role Alpha');
    await waitFor(() => expect(screen.queryByText(/Unmatched Candidates/)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Clear role/ }));
    expect(await screen.findByText('Unmatched Candidates (2)')).toBeInTheDocument();
  });

  it('only a person with a suggested role gets the one-click "Link to <role>" button', async () => {
    await open(2);
    const r1 = (await screen.findByText('Test Unmatched 1')).closest('div.flex.items-center.justify-between') as HTMLElement;
    const r2 = screen.getByText('Test Unmatched 2').closest('div.flex.items-center.justify-between') as HTMLElement;
    expect(within(r1).getByRole('button', { name: 'Link to Test Role Alpha' })).toBeInTheDocument();
    expect(within(r2).queryByRole('button', { name: /^Link to Test/ })).not.toBeInTheDocument();
    expect(within(r2).getByRole('button', { name: 'Link to role' })).toBeInTheDocument();
  });

  it('the one-click link posts the suggested role with the Job Application Form channel, drops the row and refreshes the list', async () => {
    await open(2);
    const calls = h.list.mock.calls.length;
    fireEvent.click(await screen.findByRole('button', { name: 'Link to Test Role Alpha' }));
    await waitFor(() => expect(h.linkRole).toHaveBeenCalledWith('C-U1', { role_id: 'R9001', source_channel: 'Job Application Form' }));
    await waitFor(() => expect(screen.queryByText('Test Unmatched 1')).not.toBeInTheDocument());
    expect(h.toastSuccess).toHaveBeenCalledWith('Test Unmatched 1 linked to Test Role Alpha');
    expect(screen.getByText('Unmatched Candidates (1)')).toBeInTheDocument();
    await waitFor(() => expect(h.list.mock.calls.length).toBeGreaterThan(calls));   // the person now has an application
  });

  it('a failed one-click link keeps the row and shows the server\'s reason', async () => {
    h.linkRole.mockImplementation(async () => { throw { response: { data: { error: 'Already linked to this role' } } }; });
    await open(2);
    fireEvent.click(await screen.findByRole('button', { name: 'Link to Test Role Alpha' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Already linked to this role'));
    expect(screen.getByText('Test Unmatched 1')).toBeInTheDocument();
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it('"Link to role" lets the HR user pick any live role, then links with the Job Application Form channel and drops the row', async () => {
    await open(2);
    const plain = (await screen.findByText('Test Unmatched 2')).closest('div.flex.items-center.justify-between') as HTMLElement;
    fireEvent.click(within(plain).getByRole('button', { name: 'Link to role' }));
    expect(screen.getByRole('heading', { name: 'Link Test Unmatched 2 to a role' })).toBeInTheDocument();
    expect(h.rolesList).toHaveBeenCalledWith({ status: 'Live – Sourcing' });
    const modal = screen.getByRole('heading', { name: /to a role/ }).closest('.fixed') as HTMLElement;
    const link = within(modal).getByRole('button', { name: 'Link' });
    expect(link).toBeDisabled();
    await within(modal).findByRole('option', { name: 'Test Role Beta' });
    fireEvent.change(within(modal).getByDisplayValue('Select a role…'), { target: { value: 'R9002' } });
    fireEvent.click(link);
    await waitFor(() => expect(h.linkRole).toHaveBeenCalledWith('C-U2', { role_id: 'R9002', source_channel: 'Job Application Form' }));
    await waitFor(() => expect(screen.queryByText('Test Unmatched 2')).not.toBeInTheDocument());
    expect(h.toastSuccess).toHaveBeenCalledWith('Candidate linked to role');
  });

  it('Delete asks first; Cancel deletes nobody', async () => {
    await open(2);
    fireEvent.click((await screen.findAllByTitle('Delete candidate'))[0]);
    expect(screen.getByRole('heading', { name: 'Delete Test Unmatched 1?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: /^Delete / })).not.toBeInTheDocument();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('confirming Delete removes that candidate, says so, and reloads the panel from the first page', async () => {
    await open(2);
    h.unmatched.mockResolvedValue({ data: { submissions: [PLAIN], total: 1 } });
    fireEvent.click((await screen.findAllByTitle('Delete candidate'))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith('C-U1'));
    expect(h.toastSuccess).toHaveBeenCalledWith('Test Unmatched 1 deleted');
    await waitFor(() => expect(screen.queryByText('Test Unmatched 1')).not.toBeInTheDocument());
    expect(screen.getByText('Unmatched Candidates (1)')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Delete / })).not.toBeInTheDocument();
  });

  it('a refused Delete shows the server\'s reason and leaves the dialog and the person in place', async () => {
    h.remove.mockImplementation(async () => { throw { response: { data: { error: 'Candidate has applications' } } }; });
    await open(2);
    fireEvent.click((await screen.findAllByTitle('Delete candidate'))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Candidate has applications'));
    expect(screen.getByRole('heading', { name: 'Delete Test Unmatched 1?' })).toBeInTheDocument();
    expect(screen.getByText('Unmatched Candidates (2)')).toBeInTheDocument();
  });
});

describe('Active Candidates — Unmatched Candidates pagination', () => {
  const people = (from: number, n: number) => Array.from({ length: n }, (_, i) => unmatchedRow(from + i));
  beforeEach(() => {
    h.unmatched.mockImplementation(async (p: { offset: string }) => {
      const offset = Number(p.offset);
      return { data: { submissions: people(offset, Math.min(50, 120 - offset)), total: 120 } };
    });
  });

  it('shows the first 50 with "Load more", then appends the next 50 at offset 50, then the last 20 at offset 100', async () => {
    await showList();
    fireEvent.click(await screen.findByText('Unmatched Candidates (120)'));
    expect(await screen.findByRole('button', { name: 'Load more (50 of 120)' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^Test Unmatched / })).toHaveLength(50);

    fireEvent.click(screen.getByRole('button', { name: 'Load more (50 of 120)' }));
    expect(await screen.findByRole('button', { name: 'Load more (100 of 120)' })).toBeInTheDocument();
    expect(h.unmatched).toHaveBeenCalledWith({ limit: '50', offset: '50' });
    expect(screen.getAllByRole('link', { name: /^Test Unmatched / })).toHaveLength(100);
    expect(screen.getByText('Test Unmatched 0')).toBeInTheDocument();                // earlier rows are kept
    expect(screen.getByText('Test Unmatched 99')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load more (100 of 120)' }));
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^Test Unmatched / })).toHaveLength(120));
    expect(h.unmatched).toHaveBeenCalledWith({ limit: '50', offset: '100' });
    expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument();
  });

  it('shows no "Load more" when everything fits on the first page', async () => {
    h.unmatched.mockResolvedValue({ data: { submissions: people(0, 3), total: 3 } });
    await showList();
    fireEvent.click(await screen.findByText('Unmatched Candidates (3)'));
    await screen.findByText('Test Unmatched 0');
    expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument();
  });
});

