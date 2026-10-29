import '../test/loadTolerance.ts';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';

// Active Candidates (the applications table): the request each filter sends, the debounced server search, the
// client-side sort and In-budget filter, row selection, and what a Hiring Manager is never given. The bulk actions are in
// Candidates.bulk.test.tsx and the Unmatched Candidates panel in Candidates.unmatched.test.tsx. Column header wording is
// pinned in Candidates.headers.test.tsx and is not repeated here.
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
import { STAGES } from '../types/index.ts';
import { NOW, APPS, A1, A2, A3, application as app, FILTER_OPTIONS, LIVE_ROLES, unmatchedRow } from '../test/candidateFixtures.ts';

// react-query hands results to React through setTimeout(0). The debounce tests fake setTimeout, so give the query
// library the real one: only the page's own timer is then driven by the fake clock.
const realSetTimeout = globalThis.setTimeout;
beforeAll(() => { notifyManager.setScheduler(cb => { realSetTimeout(cb, 0); }); });

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><Candidates /></MemoryRouter></QueryClientProvider>);
}
// The page's search-debounce effect also runs once on mount (350 ms later it sets the unchanged search). Left on the real clock it
// can fire in the middle of a later test and put the search back to empty, so the list is shown with that timer already run:
// mounted on a fake setTimeout that is stepped past it, then the real clock back.
const showList = async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  mount();
  act(() => { vi.advanceTimersByTime(350); });
  vi.useRealTimers();
  await screen.findByText('Test Candidate A9001');
};
const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLTableRowElement;
const names = () => Array.from(document.querySelectorAll('tbody tr')).map(tr => tr.querySelector('a')?.textContent);
const lastRequest = () => h.list.mock.calls[h.list.mock.calls.length - 1][0] as Record<string, unknown>;
const BASE = { limit: '100', exclude_stale_archived: 'true' };
const tick = (name: string) => fireEvent.click(within(rowOf(name)).getByRole('checkbox'));
const modalOf = (heading: string) => screen.getByRole('heading', { name: heading }).closest('.fixed') as HTMLElement;
// Opens a multi-select filter (its panel is a portal on document.body) and ticks one option.
const pick = async (filter: RegExp, option: string) => {
  fireEvent.click(screen.getByRole('button', { name: filter }));
  fireEvent.click(await screen.findByLabelText(option));
};
const sortBy = (label: string) => fireEvent.click(screen.getByRole('button', { name: label }));

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

describe('Active Candidates — the request each filter sends', () => {
  it('asks for the first 100 non-stale applications and nothing else by default', async () => {
    await showList();
    expect(h.list).toHaveBeenCalledWith(BASE);
    expect(h.list.mock.calls[0][0]).toEqual(BASE);
  });

  it('Stage filter sends `stage`, and "All stages" takes it away again', async () => {
    await showList();
    const stage = screen.getByDisplayValue('All stages');
    fireEvent.change(stage, { target: { value: 'Interview Round 2' } });
    await waitFor(() => expect(lastRequest()).toEqual({ ...BASE, stage: 'Interview Round 2' }));
    fireEvent.change(stage, { target: { value: 'all' } });
    await waitFor(() => expect(lastRequest()).toEqual(BASE));
  });

  it('the stage dropdown offers every pipeline stage (the canonical list), in order', async () => {
    await showList();
    const options = Array.from((screen.getByDisplayValue('All stages') as HTMLSelectElement).options).map(o => o.value);
    expect(options).toEqual(['all', ...STAGES]);
  });

  it('SLA breached only sends sla_breach=true, and a second click stops sending it', async () => {
    await showList();
    fireEvent.click(screen.getByRole('button', { name: 'SLA breached only' }));
    await waitFor(() => expect(lastRequest()).toEqual({ ...BASE, sla_breach: 'true' }));
    fireEvent.click(screen.getByRole('button', { name: 'SLA breached only' }));
    await waitFor(() => expect(lastRequest()).toEqual(BASE));
  });

  it.each([
    ['Department', /^Department/, 'Tech/Devs', 'department', ['Tech/Devs']],
    ['Location', /^Location/, 'Pune', 'location', ['Pune']],
    ['Recruitment Mode', /^Recruitment Mode/, 'Agency', 'recruitment_mode', ['Agency']],
    ['Priority', /^Priority/, 'P0', 'priority', ['P0']],
    // The Role filter shows a title but filters by id.
    ['Role', /^Role/, 'Test Role Beta', 'role_id', ['R9002']],
    // Here "Status" is the APPLICATION's own status, sent as the endpoint's native `status`, never `role_status`.
    ['Status', /^Status/, 'Hold for Future', 'status', ['Hold for Future']],
  ])('%s filter sends %s', async (_name, button, option, param, value) => {
    await showList();
    await pick(button as RegExp, option as string);
    await waitFor(() => expect(lastRequest()).toEqual({ ...BASE, [param as string]: value }));
    expect(lastRequest()).not.toHaveProperty('role_status');
  });

  it('a multi-select sends every ticked option, in the order they were ticked, and Clear removes the param', async () => {
    await showList();
    await pick(/^Location/, 'Pune');
    fireEvent.click(screen.getByLabelText('Mumbai'));
    await waitFor(() => expect(lastRequest()).toEqual({ ...BASE, location: ['Pune', 'Mumbai'] }));
    fireEvent.click(screen.getByRole('button', { name: /Clear location/ }));
    await waitFor(() => expect(lastRequest()).toEqual(BASE));
  });

  it('Gender: Male and Female send M and F; "Not tagged" sends the literal UNKNOWN (alone, and next to M)', async () => {
    await showList();
    await pick(/^Gender/, 'Male');
    await waitFor(() => expect(lastRequest().gender).toEqual(['M']));
    fireEvent.click(screen.getByLabelText('Male'));              // off again
    fireEvent.click(screen.getByLabelText('Female'));
    await waitFor(() => expect(lastRequest().gender).toEqual(['F']));
    fireEvent.click(screen.getByLabelText('Female'));
    fireEvent.click(screen.getByLabelText('Not tagged'));
    await waitFor(() => expect(lastRequest().gender).toEqual(['UNKNOWN']));
    fireEvent.click(screen.getByLabelText('Male'));
    await waitFor(() => expect(lastRequest().gender).toEqual(['UNKNOWN', 'M']));
  });

  it('the Gender filter offers exactly Male, Female and Not tagged', async () => {
    await showList();
    fireEvent.click(screen.getByRole('button', { name: /^Gender/ }));
    const panel = (await screen.findByLabelText('Male')).closest('div.fixed') as HTMLElement;
    expect(within(panel).getAllByRole('checkbox').map(c => c.closest('label')?.textContent)).toEqual(['Male', 'Female', 'Not tagged']);
  });

  it('the Recruitment Mode and Role options come from the server (not a hard-coded list)', async () => {
    await showList();
    fireEvent.click(screen.getByRole('button', { name: /^Recruitment Mode/ }));
    const panel = (await screen.findByLabelText('Direct')).closest('div.fixed') as HTMLElement;
    expect(within(panel).getAllByRole('checkbox').map(c => c.closest('label')?.textContent)).toEqual(['Direct', 'Agency']);
  });

  it('several filters combine into one request', async () => {
    await showList();
    fireEvent.change(screen.getByDisplayValue('All stages'), { target: { value: 'Founders Round' } });
    fireEvent.click(screen.getByRole('button', { name: 'SLA breached only' }));
    await pick(/^Priority/, 'P1');
    await waitFor(() => expect(lastRequest()).toEqual({ ...BASE, stage: 'Founders Round', sla_breach: 'true', priority: ['P1'] }));
  });

  it('a filter is remembered for the browser session: a fresh mount starts from it', async () => {
    await showList();
    fireEvent.click(screen.getByRole('button', { name: 'SLA breached only' }));
    await waitFor(() => expect(lastRequest().sla_breach).toBe('true'));
    cleanup();
    h.list.mockClear();
    mount();
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    expect(h.list.mock.calls[0][0]).toEqual({ ...BASE, sla_breach: 'true' });
  });
});

describe('Active Candidates — debounced server search', () => {
  const searchBox = () => screen.getByPlaceholderText(/Search by name or role/);

  it('sends nothing until 350 ms after the last keystroke, then sends the text as `q`', async () => {
    await showList();
    const before = h.list.mock.calls.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(searchBox(), { target: { value: 'tes' } });
    act(() => { vi.advanceTimersByTime(349); });
    expect(h.list).toHaveBeenCalledTimes(before);
    act(() => { vi.advanceTimersByTime(1); });
    vi.useRealTimers();
    await waitFor(() => expect(lastRequest()).toEqual({ ...BASE, q: 'tes' }));
  });

  it('two keystrokes inside the window send one request, with the final text', async () => {
    await showList();
    const before = h.list.mock.calls.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(searchBox(), { target: { value: 'te' } });
    act(() => { vi.advanceTimersByTime(300); });
    fireEvent.change(searchBox(), { target: { value: 'tes' } });
    act(() => { vi.advanceTimersByTime(349); });           // 649 ms after the first key, 349 after the last
    expect(h.list).toHaveBeenCalledTimes(before);
    act(() => { vi.advanceTimersByTime(1); });
    vi.useRealTimers();
    await waitFor(() => expect(lastRequest().q).toBe('tes'));
    expect(h.list.mock.calls.slice(before).map(c => (c[0] as Record<string, unknown>).q)).toEqual(['tes']);
  });

  it('clearing the box takes `q` away again', async () => {
    await showList();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(searchBox(), { target: { value: 'tes' } });
    act(() => { vi.advanceTimersByTime(350); });
    vi.useRealTimers();
    await waitFor(() => expect(lastRequest().q).toBe('tes'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(searchBox(), { target: { value: '' } });
    act(() => { vi.advanceTimersByTime(350); });
    vi.useRealTimers();
    await waitFor(() => expect(lastRequest()).toEqual(BASE));
  });
});

describe('Active Candidates — the list, count and states', () => {
  it('shows one row per application in the order the server sent, with the count and the SLA-breached count', async () => {
    await showList();
    expect(names()).toEqual(['Test Candidate A9001', 'Test Candidate A9002', 'Test Candidate A9003']);
    expect(screen.getByText(/3 applications/)).toBeInTheDocument();
    expect(screen.getByText('1 SLA breached')).toBeInTheDocument();
  });

  it('a row links to the candidate and to the role, and carries the SLA and Founder tags', async () => {
    await showList();
    const r3 = rowOf('Test Candidate A9003');
    expect(within(r3).getByRole('link', { name: 'Test Candidate A9003' })).toHaveAttribute('href', '/candidates/C-A9003');
    expect(within(r3).getByRole('link', { name: 'Test Role Alpha' })).toHaveAttribute('href', '/roles/R9001');
    expect(within(r3).getByText('SLA')).toBeInTheDocument();
    expect(within(r3).getByText('Founder')).toBeInTheDocument();
    expect(within(rowOf('Test Candidate A9002')).queryByText('SLA')).not.toBeInTheDocument();
  });

  it('shows current → expected CTC and the Over Budget badge only where expected is above the top of the band', async () => {
    await showList();
    expect(within(rowOf('Test Candidate A9001')).getByText(/₹10L → ₹20L/)).toBeInTheDocument();
    expect(within(rowOf('Test Candidate A9001')).getByText('Over Budget')).toBeInTheDocument();
    expect(within(rowOf('Test Candidate A9003')).getByText('Over Budget')).toBeInTheDocument();   // 16 > 15, though under +15%
    expect(within(rowOf('Test Candidate A9002')).queryByText('Over Budget')).not.toBeInTheDocument();
  });

  it('a missing score, CTC, notice period and resume show a dash, and a real resume link opens in a new tab', async () => {
    h.list.mockResolvedValue({ data: { applications: [
      app('A9010', { ai_fit_score: null, candidate_ctc_fixed: null, candidate_expected_ctc: null, candidate_notice_period_days: null, candidate_resume_link: null }),
      app('A9011', { candidate_resume_link: 'https://drive.example.test/resume-a9011' }),
    ] } });
    mount();
    await screen.findByText('Test Candidate A9010');
    expect(within(rowOf('Test Candidate A9010')).getByText(/— → —/)).toBeInTheDocument();
    expect(within(rowOf('Test Candidate A9010')).queryByRole('link', { name: 'View' })).not.toBeInTheDocument();
    const link = within(rowOf('Test Candidate A9011')).getByRole('link', { name: 'View' });
    expect(link).toHaveAttribute('href', 'https://drive.example.test/resume-a9011');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noreferrer/);
  });

  it('shows the loading spinner (and no table) while the list is on its way', async () => {
    h.list.mockReturnValue(new Promise(() => {}));
    mount();
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    expect(document.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says "No candidates match" for an empty result and shows no table', async () => {
    h.list.mockResolvedValue({ data: { applications: [] } });
    mount();
    expect(await screen.findByText('No candidates match')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText(/0 applications/)).toBeInTheDocument();
    expect(screen.queryByText(/SLA breached$/)).not.toBeInTheDocument();
  });

  it('a failed list request does not crash the page: the heading and the filters stay, and no rows are invented', async () => {
    h.list.mockImplementation(async () => { throw new Error('network down'); });
    mount();
    expect(await screen.findByRole('heading', { name: 'Active Candidates' })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.animate-spin')).toBeNull());
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Department/ })).toBeInTheDocument();
  });

  it('relative dates: "Nd ago" for the application date and a distance for the last update (fixed clock)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await showList();
    const r1 = rowOf('Test Candidate A9001');
    expect(within(r1).getByText('9d ago')).toBeInTheDocument();
    expect(within(r1).getByText('2 days ago')).toBeInTheDocument();
  });
});

describe('Active Candidates — In-budget only', () => {
  it('hides candidates whose expected CTC is more than 15% over the band, without asking the server again, and brings them back', async () => {
    await showList();
    const calls = h.list.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'In-budget only' }));
    expect(names()).toEqual(['Test Candidate A9002', 'Test Candidate A9003']);      // A9001: 20 against 15 × 1.15 = 17.25
    expect(screen.getByText(/2 applications/)).toBeInTheDocument();
    expect(h.list).toHaveBeenCalledTimes(calls);
    fireEvent.click(screen.getByRole('button', { name: 'In-budget only' }));
    expect(names()).toHaveLength(3);
  });

  it('never hides a candidate whose band or expected CTC cannot be read (a Hiring Manager gets no band)', async () => {
    h.persona = 'hiring_manager';
    h.list.mockResolvedValue({ data: { applications: [
      app('A9020', { role_ctc_band: undefined, candidate_expected_ctc: 99 }),
      app('A9021', { candidate_expected_ctc: undefined }),
    ] } });
    mount();
    await screen.findByText('Test Candidate A9020');
    fireEvent.click(screen.getByRole('button', { name: 'In-budget only' }));
    expect(names()).toEqual(['Test Candidate A9020', 'Test Candidate A9021']);
  });
});

describe('Active Candidates — sorting (client side, over what was fetched)', () => {
  it('Fit: first click is highest first, second click lowest first, and a missing score counts as the lowest', async () => {
    await showList();
    sortBy('Fit');
    expect(names()).toEqual(['Test Candidate A9001', 'Test Candidate A9003', 'Test Candidate A9002']);
    sortBy('Fit');
    expect(names()).toEqual(['Test Candidate A9002', 'Test Candidate A9003', 'Test Candidate A9001']);
  });

  it('Application Date: newest application first, then oldest first', async () => {
    await showList();
    sortBy('Application Date');
    expect(names()).toEqual(['Test Candidate A9002', 'Test Candidate A9001', 'Test Candidate A9003']);
    sortBy('Application Date');
    expect(names()).toEqual(['Test Candidate A9003', 'Test Candidate A9001', 'Test Candidate A9002']);
  });

  it('Last Updated: most recently touched first, then least recently', async () => {
    await showList();
    sortBy('Last Updated');
    expect(names()).toEqual(['Test Candidate A9003', 'Test Candidate A9001', 'Test Candidate A9002']);
    sortBy('Last Updated');
    expect(names()).toEqual(['Test Candidate A9002', 'Test Candidate A9001', 'Test Candidate A9003']);
  });

  it('switching to another sort column starts again from the descending order', async () => {
    await showList();
    sortBy('Fit'); sortBy('Fit');                       // ascending now
    sortBy('Last Updated');
    expect(names()).toEqual(['Test Candidate A9003', 'Test Candidate A9001', 'Test Candidate A9002']);
  });

  it('sorting asks the server for nothing new', async () => {
    await showList();
    const calls = h.list.mock.calls.length;
    sortBy('Fit');
    expect(h.list).toHaveBeenCalledTimes(calls);
  });
});

describe('Active Candidates — row selection and the bulk bar', () => {
  it('selecting rows shows how many are selected, with Change Stage, Change Status and Clear', async () => {
    await showList();
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    tick('Test Candidate A9001'); tick('Test Candidate A9002');
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change Stage' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change Status' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });

  it('the header checkbox selects every row on screen, and a second click clears them', async () => {
    await showList();
    const [all] = screen.getAllByRole('checkbox');
    fireEvent.click(all);
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    fireEvent.click(all);
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });

  it('select-all covers only the rows the filters leave on screen', async () => {
    await showList();
    fireEvent.click(screen.getByRole('button', { name: 'In-budget only' }));      // A9001 is hidden
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'In-budget only' }));
    expect(within(rowOf('Test Candidate A9001')).getByRole('checkbox')).not.toBeChecked();
    expect(within(rowOf('Test Candidate A9002')).getByRole('checkbox')).toBeChecked();
  });
});

describe('Active Candidates — what a Hiring Manager is given', () => {
  beforeEach(() => { h.persona = 'hiring_manager'; });

  it('sees the list, but no row checkboxes, no bulk bar and no Add candidate link', async () => {
    await showList();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Change Stage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change Status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Add candidate/ })).not.toBeInTheDocument();
    expect(names()).toHaveLength(3);
  });

  it('still opens a candidate from the list', async () => {
    await showList();
    expect(within(rowOf('Test Candidate A9001')).getByRole('link', { name: 'Test Candidate A9001' })).toHaveAttribute('href', '/candidates/C-A9001');
  });

  it('a row with its compensation fields stripped by the server shows dashes and never an Over Budget badge', async () => {
    h.list.mockResolvedValue({ data: { applications: [app('A9040', { candidate_ctc_fixed: undefined, candidate_expected_ctc: undefined, role_ctc_band: undefined })] } });
    mount();
    await screen.findByText('Test Candidate A9040');
    expect(within(rowOf('Test Candidate A9040')).getByText(/— → —/)).toBeInTheDocument();
    expect(screen.queryByText('Over Budget')).not.toBeInTheDocument();
  });

  it('the Unmatched Candidates panel opens but offers no way to link or delete anyone', async () => {
    h.unmatched.mockResolvedValue({ data: { submissions: [unmatchedRow(1, { suggested_role_id: 'R9001', suggested_role_title: 'Test Role Alpha' })], total: 1 } });
    await showList();
    fireEvent.click(await screen.findByText('Unmatched Candidates (1)'));
    expect(await screen.findByText('Test Unmatched 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Link to/ })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Delete candidate')).not.toBeInTheDocument();
  });

  it.each(['hr_recruiter', 'leadership', 'super_admin'] as const)('%s does get the checkboxes, the bulk bar and the Add candidate link', async persona => {
    h.persona = persona;
    await showList();
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    expect(screen.getByRole('link', { name: /Add candidate/ })).toHaveAttribute('href', '/candidates/new');
    tick('Test Candidate A9002');
    expect(screen.getByRole('button', { name: 'Change Stage' })).toBeInTheDocument();
  });
});

describe('Active Candidates — canonical lists', () => {
  it('Status filter offers every application status', async () => {
    await showList();
    fireEvent.click(screen.getByRole('button', { name: /^Status/ }));
    const panel = (await screen.findByLabelText('Hold for Future')).closest('div.fixed') as HTMLElement;
    expect(within(panel).getAllByRole('checkbox').map(c => c.closest('label')?.textContent)).toEqual(['Active', 'Rejected', 'Withdrawn', 'Hold for Future', 'Joined', 'Closed']);
  });
});
