import '../test/loadTolerance.ts';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { ago, NOW, LIVE_ROLES, FILTER_OPTIONS } from '../test/candidateFixtures.ts';

// Archived Pipeline (the Talent Pool): its two modes, 50-at-a-time "Load more", the rule that any change of filter or
// search starts again from the first page, the debounced search, client-side sorting and the HR-only Reactivate action.
// Column header wording is pinned in TalentPool.headers.test.tsx and is not repeated here.
const h = vi.hoisted(() => ({
  persona: 'hr_recruiter' as 'hr_recruiter' | 'hiring_manager' | 'leadership' | 'super_admin',
  list: vi.fn(), linkRole: vi.fn(), filterOptions: vi.fn(), rolesList: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn(),
}));
vi.mock('../services/api.ts', () => ({
  candidatesApi: { list: (p: unknown) => h.list(p), linkRole: (...a: unknown[]) => h.linkRole(...a) },
  rolesApi: { filterOptions: () => h.filterOptions(), list: (p: unknown) => h.rolesList(p) },
}));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({ canHR: h.persona !== 'hiring_manager', canLead: h.persona === 'leadership' || h.persona === 'super_admin' }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: (m: string) => h.toastSuccess(m), error: (m: string) => h.toastError(m) } }));

import TalentPool from './TalentPool.tsx';

// The debounce tests fake setTimeout: give react-query the real one so only the page's own timer is driven by the fake clock.
const realSetTimeout = globalThis.setTimeout;
beforeAll(() => { notifyManager.setScheduler(cb => { realSetTimeout(cb, 0); }); });

type AppOver = Record<string, unknown>;
const person = (n: number | string, over: Record<string, unknown> = {}, apps: AppOver[] = [{}]) => ({
  id: `C-P${n}`, full_name: `Test Person P${n}`, email: `p${n}@example.test`, gender: null, hr_tags: [],
  current_ctc_fixed: 10, expected_ctc: 14, notice_period_days: 30, current_company: 'Test Co', current_industry: 'Test Industry', resume_drive_link: null,
  applications: apps.map((a, i) => ({
    id: `A-P${n}-${i}`, role_id: 'R9001', role_title: 'Test Role Alpha', stage: 'Interview Round 1', status: 'Hold for Future', ai_fit_score: 60,
    application_date: ago(5), last_updated: ago(1), preferred_location: 'Pune', ...a,
  })),
  ...over,
});
const PAGE = 50;
const TOTAL = 120;
const pageOf = (offset: number) => Array.from({ length: Math.min(PAGE, TOTAL - offset) }, (_, i) => person(offset + i));
const paged = () => h.list.mockImplementation(async (p: { offset: string }) => ({ data: { candidates: pageOf(Number(p.offset)), total: TOTAL } }));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><TalentPool /></MemoryRouter></QueryClientProvider>);
}
const lastRequest = () => h.list.mock.calls[h.list.mock.calls.length - 1][0] as Record<string, unknown>;
const HOLD = { limit: '50', offset: '0', hold_for_future: 'true' };
const names = () => Array.from(document.querySelectorAll('tbody tr')).map(tr => tr.querySelector('a')?.textContent);
const rowOf = (name: string) => screen.getAllByText(name)[0].closest('tr') as HTMLTableRowElement;
const loadMore = () => screen.getByRole('button', { name: 'Load more' });
const searchBox = () => screen.getByPlaceholderText(/Search by name, email, or phone/);
const pick = async (filter: RegExp, option: string) => {
  fireEvent.click(screen.getByRole('button', { name: filter }));
  fireEvent.click(await screen.findByLabelText(option));
};
const sortBy = (label: string) => fireEvent.click(screen.getByRole('button', { name: label }));
// The page's search-debounce effect also runs once on mount: 350 ms later it sets the (unchanged) search and offset 0. On a real
// clock a test that pressed "Load more" before that moment was put back on page one (a slow machine made that happen), so the first
// page is always shown with that timer already run: mounted on a fake setTimeout that is stepped past it, then the real clock back.
const showFirstPage = async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  mount();
  act(() => { vi.advanceTimersByTime(350); });
  vi.useRealTimers();
  await screen.findByText('Test Person P0');
};

beforeEach(() => {
  h.persona = 'hr_recruiter';
  for (const f of [h.list, h.linkRole, h.filterOptions, h.rolesList, h.toastSuccess, h.toastError]) f.mockReset();
  sessionStorage.clear();
  h.list.mockResolvedValue({ data: { candidates: [person(0)], total: 1 } });
  h.filterOptions.mockResolvedValue(FILTER_OPTIONS);
  h.rolesList.mockResolvedValue(LIVE_ROLES);
  h.linkRole.mockResolvedValue({ data: {} });
});
afterEach(() => { vi.useRealTimers(); });

describe('Archived Pipeline — the two modes', () => {
  it('opens on Hold for Future and asks for the first 50 held candidates, nothing else', async () => {
    await showFirstPage();
    expect(h.list.mock.calls[0][0]).toEqual(HOLD);
    expect(screen.getByRole('heading', { name: 'Archived Pipeline' })).toBeInTheDocument();
  });

  it('counts candidates per mode', async () => {
    h.list.mockResolvedValue({ data: { candidates: [person(0)], total: 7 } });
    mount();
    expect(await screen.findByText('7 on hold for future roles')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('7 archived candidates (rejected/withdrawn)')).toBeInTheDocument();
  });

  it('Archived asks for archived=true instead of hold_for_future, from the first page again', async () => {
    await showFirstPage();
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    await waitFor(() => expect(lastRequest()).toEqual({ limit: '50', offset: '0', archived: 'true' }));
    expect(lastRequest()).not.toHaveProperty('hold_for_future');
    fireEvent.click(screen.getByRole('button', { name: 'Hold for Future' }));
    await waitFor(() => expect(lastRequest()).toEqual(HOLD));
  });

  it('switching mode after "Load more" starts again from offset 0', async () => {
    paged();
    await showFirstPage();
    fireEvent.click(loadMore());
    await screen.findByText('Test Person P50');
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    await waitFor(() => expect(lastRequest()).toEqual({ limit: '50', offset: '0', archived: 'true' }));
  });

  it('remembers the mode for the browser session', async () => {
    await showFirstPage();
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    await waitFor(() => expect(lastRequest().archived).toBe('true'));
    cleanup();
    h.list.mockClear();
    mount();
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    expect(h.list.mock.calls[0][0]).toEqual({ limit: '50', offset: '0', archived: 'true' });
  });

  it('says what an empty list means in each mode', async () => {
    h.list.mockResolvedValue({ data: { candidates: [], total: 0 } });
    mount();
    expect(await screen.findByText('No candidates on hold for future roles')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('No archived candidates match your filters')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('Archived Pipeline — Load more', () => {
  it('shows the first 50 and "Load more", then appends the next 50 at offset 50 and the last 20 at offset 100, then the button goes', async () => {
    paged();
    await showFirstPage();
    expect(names()).toHaveLength(50);
    expect(screen.getByText('120 on hold for future roles')).toBeInTheDocument();

    fireEvent.click(loadMore());
    await waitFor(() => expect(names()).toHaveLength(100));
    expect(lastRequest()).toEqual({ limit: '50', offset: '50', hold_for_future: 'true' });
    expect(names()[0]).toBe('Test Person P0');                           // earlier rows are kept
    expect(names()[99]).toBe('Test Person P99');

    fireEvent.click(loadMore());
    await waitFor(() => expect(names()).toHaveLength(120));
    expect(lastRequest()).toEqual({ limit: '50', offset: '100', hold_for_future: 'true' });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('is not shown when the first page already holds everyone', async () => {
    h.list.mockResolvedValue({ data: { candidates: [person(0), person(1)], total: 2 } });
    mount();
    await screen.findByText('Test Person P0');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('counts candidates, not rows: a candidate with several applications adds rows but does not make the button appear', async () => {
    h.list.mockResolvedValue({ data: { candidates: [person(0, {}, [{}, { id: 'A-second', role_id: 'R9002', role_title: 'Test Role Beta' }]), person(1)], total: 2 } });
    mount();
    await screen.findAllByText('Test Person P0');
    expect(names()).toHaveLength(3);                                      // 3 rows for 2 candidates
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('keeps the rows already on screen while the next page is on its way (no full-page spinner)', async () => {
    h.list.mockImplementation(async (p: { offset: string }) => {
      if (p.offset === '0') return { data: { candidates: pageOf(0), total: TOTAL } };
      return new Promise(() => {});
    });
    await showFirstPage();
    fireEvent.click(loadMore());
    await waitFor(() => expect(lastRequest().offset).toBe('50'));
    expect(names()).toHaveLength(50);
    expect(document.querySelector('.animate-spin')).toBeNull();
  });
});

describe('Archived Pipeline — every filter sends its parameter and starts again from the first page', () => {
  // Each case first loads page two (offset 50), then changes the filter: the next request must be offset 0.
  const afterLoadMore = async () => { paged(); await showFirstPage(); fireEvent.click(loadMore()); await screen.findByText('Test Person P50'); };

  it.each([
    ['Tag', () => fireEvent.change(screen.getByPlaceholderText('Tag'), { target: { value: 'strong' } }), { tag: 'strong' }],
    ['Industry', () => fireEvent.change(screen.getByPlaceholderText('Industry'), { target: { value: 'Water' } }), { industry: 'Water' }],
    ['Skills', () => fireEvent.change(screen.getByPlaceholderText('Skills (comma-separated)'), { target: { value: 'a, b ,,' } }), { skills: ['a', 'b'] }],
    ['Department', () => pick(/^Department/, 'Tech/Devs'), { department: ['Tech/Devs'] }],
    ['Location', () => pick(/^Location/, 'Pune'), { location: ['Pune'] }],
    ['Role', () => pick(/^Role/, 'Test Role Beta'), { role_id: ['R9002'] }],
    ['Gender (Male)', () => pick(/^Gender/, 'Male'), { gender: ['M'] }],
    ['Gender (Female)', () => pick(/^Gender/, 'Female'), { gender: ['F'] }],
    ['Gender (Not tagged)', () => pick(/^Gender/, 'Not tagged'), { gender: ['UNKNOWN'] }],
  ] as const)('%s', async (_name, act_, expected) => {
    await afterLoadMore();
    await act_();
    await waitFor(() => expect(lastRequest()).toEqual({ ...HOLD, ...expected }));
  });

  it('a change of filter replaces the rows instead of appending to the pages already loaded', async () => {
    paged();
    await showFirstPage();
    fireEvent.click(loadMore());
    await waitFor(() => expect(names()).toHaveLength(100));
    h.list.mockResolvedValue({ data: { candidates: [person('X1'), person('X2')], total: 2 } });
    fireEvent.change(screen.getByPlaceholderText('Tag'), { target: { value: 'strong' } });
    await waitFor(() => expect(names()).toEqual(['Test Person PX1', 'Test Person PX2']));
  });

  it('Gender: "Not tagged" next to Male sends both, Male first because it was ticked first', async () => {
    await showFirstPage();
    await pick(/^Gender/, 'Male');
    fireEvent.click(screen.getByLabelText('Not tagged'));
    await waitFor(() => expect(lastRequest().gender).toEqual(['M', 'UNKNOWN']));
  });

  it('the Gender filter offers exactly Male, Female and Not tagged', async () => {
    await showFirstPage();
    fireEvent.click(screen.getByRole('button', { name: /^Gender/ }));
    const panel = (await screen.findByLabelText('Male')).closest('div.fixed') as HTMLElement;
    expect(within(panel).getAllByRole('checkbox').map(c => c.closest('label')?.textContent)).toEqual(['Male', 'Female', 'Not tagged']);
  });

  it('Skills with nothing between the commas is sent as no skills at all', async () => {
    await showFirstPage();
    fireEvent.change(screen.getByPlaceholderText('Skills (comma-separated)'), { target: { value: 'a' } });
    await waitFor(() => expect(lastRequest().skills).toEqual(['a']));
    fireEvent.change(screen.getByPlaceholderText('Skills (comma-separated)'), { target: { value: '' } });
    await waitFor(() => expect(lastRequest()).toEqual(HOLD));
  });
});

describe('Archived Pipeline — debounced search', () => {
  it('sends nothing until 350 ms after the last keystroke, then sends `q` from the first page', async () => {
    paged();
    await showFirstPage();
    fireEvent.click(loadMore());                                           // now on page two
    await screen.findByText('Test Person P50');
    const before = h.list.mock.calls.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(searchBox(), { target: { value: 'tes' } });
    act(() => { vi.advanceTimersByTime(349); });
    expect(h.list).toHaveBeenCalledTimes(before);
    act(() => { vi.advanceTimersByTime(1); });
    vi.useRealTimers();
    await waitFor(() => expect(lastRequest()).toEqual({ ...HOLD, q: 'tes' }));
  });

  it('two keystrokes inside the window send one request with the final text', async () => {
    await showFirstPage();
    const before = h.list.mock.calls.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(searchBox(), { target: { value: 'te' } });
    act(() => { vi.advanceTimersByTime(300); });
    fireEvent.change(searchBox(), { target: { value: 'tes' } });
    act(() => { vi.advanceTimersByTime(349); });
    expect(h.list).toHaveBeenCalledTimes(before);
    act(() => { vi.advanceTimersByTime(1); });
    vi.useRealTimers();
    await waitFor(() => expect(lastRequest().q).toBe('tes'));
    expect(h.list.mock.calls.slice(before).map(c => (c[0] as Record<string, unknown>).q)).toEqual(['tes']);
  });
});

describe('Archived Pipeline — the rows', () => {
  it('shows one row per application, so a candidate with two applications appears twice, with each role', async () => {
    h.list.mockResolvedValue({ data: { candidates: [person(0, {}, [{}, { id: 'A-second', role_id: 'R9002', role_title: 'Test Role Beta', status: 'Rejected', stage: 'Founders Round' }])], total: 1 } });
    mount();
    await screen.findAllByText('Test Person P0');
    const rows = Array.from(document.querySelectorAll('tbody tr')) as HTMLTableRowElement[];
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Test Role Alpha')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Test Role Beta')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Hold for Future')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Rejected')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Founders Round')).toBeInTheDocument();
  });

  it('a candidate with no applications has no rows (the table lists applications)', async () => {
    h.list.mockResolvedValue({ data: { candidates: [person(0, { applications: [] }), person(1, { applications: null })], total: 2 } });
    mount();
    expect(await screen.findByText('No candidates on hold for future roles')).toBeInTheDocument();
  });

  it('shows the candidate\'s own profile figures, links to the candidate and the role, and the tags and gender', async () => {
    h.list.mockResolvedValue({ data: { candidates: [person(0, { gender: 'F', hr_tags: ['strong', 'revisit'], resume_drive_link: 'https://drive.example.test/r0' })], total: 1 } });
    mount();
    const row = (await screen.findAllByText('Test Person P0'))[0].closest('tr') as HTMLTableRowElement;
    expect(within(row).getByRole('link', { name: 'Test Person P0' })).toHaveAttribute('href', '/candidates/C-P0');
    expect(within(row).getByRole('link', { name: 'Test Role Alpha' })).toHaveAttribute('href', '/roles/R9001');
    expect(within(row).getByText('strong')).toBeInTheDocument();
    expect(within(row).getByText('revisit')).toBeInTheDocument();
    expect(within(row).getByText('F')).toBeInTheDocument();
    expect(within(row).getByText(/₹10L → ₹14L/)).toBeInTheDocument();
    expect(within(row).getByText('30d')).toBeInTheDocument();
    expect(within(row).getByText('Test Co / Test Industry')).toBeInTheDocument();
    const resume = within(row).getByRole('link', { name: 'View' });
    expect(resume).toHaveAttribute('href', 'https://drive.example.test/r0');
    expect(resume).toHaveAttribute('target', '_blank');
  });

  it('missing figures show dashes, and the table has no Over Budget flag (compensation is shown as a bare figure here)', async () => {
    h.list.mockResolvedValue({ data: { candidates: [person(0, { current_ctc_fixed: null, expected_ctc: null, notice_period_days: null, current_company: null, current_industry: null }, [{ ai_fit_score: null, preferred_location: null }])], total: 1 } });
    mount();
    const row = (await screen.findAllByText('Test Person P0'))[0].closest('tr') as HTMLTableRowElement;
    expect(within(row).getByText(/— → —/)).toBeInTheDocument();
    expect(within(row).getByText('— / —')).toBeInTheDocument();
    expect(within(row).queryByRole('link', { name: 'View' })).not.toBeInTheDocument();
    expect(screen.queryByText('Over Budget')).not.toBeInTheDocument();
  });

  it('shows the loading spinner (and no table) while the first page is on its way', async () => {
    h.list.mockReturnValue(new Promise(() => {}));
    mount();
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    expect(document.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('a failed request does not crash the page: the heading and the filters stay and no rows are invented', async () => {
    h.list.mockImplementation(async () => { throw new Error('network down'); });
    mount();
    expect(await screen.findByRole('heading', { name: 'Archived Pipeline' })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.animate-spin')).toBeNull());
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Department/ })).toBeInTheDocument();
  });

  it('a fixed clock gives "Nd ago" for the application date and a distance for the last update', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    h.list.mockResolvedValue({ data: { candidates: [person(0, {}, [{ application_date: ago(9), last_updated: ago(2) }])], total: 1 } });
    mount();
    const row = (await screen.findAllByText('Test Person P0'))[0].closest('tr') as HTMLTableRowElement;
    expect(within(row).getByText('9d ago')).toBeInTheDocument();
    expect(within(row).getByText('2 days ago')).toBeInTheDocument();
  });
});

describe('Archived Pipeline — sorting (client side, over the rows loaded)', () => {
  const three = () => h.list.mockResolvedValue({ data: { candidates: [
    person(1, {}, [{ ai_fit_score: 80, application_date: ago(9), last_updated: ago(2) }]),
    person(2, {}, [{ ai_fit_score: null, application_date: ago(4), last_updated: ago(9) }]),
    person(3, {}, [{ ai_fit_score: 55, application_date: ago(19), last_updated: ago(1) }]),
  ], total: 3 } });
  const P = (n: number) => `Test Person P${n}`;

  it('Fit: highest first, then lowest first, a missing score counting as the lowest', async () => {
    three(); mount(); await screen.findByText(P(1));
    sortBy('Fit');
    expect(names()).toEqual([P(1), P(3), P(2)]);
    sortBy('Fit');
    expect(names()).toEqual([P(2), P(3), P(1)]);
  });

  it('Application Date: newest first, then oldest first', async () => {
    three(); mount(); await screen.findByText(P(1));
    sortBy('Application Date');
    expect(names()).toEqual([P(2), P(1), P(3)]);
    sortBy('Application Date');
    expect(names()).toEqual([P(3), P(1), P(2)]);
  });

  it('Last Added: most recent first, then least recent', async () => {
    three(); mount(); await screen.findByText(P(1));
    sortBy('Last Added');
    expect(names()).toEqual([P(3), P(1), P(2)]);
    sortBy('Last Added');
    expect(names()).toEqual([P(2), P(1), P(3)]);
  });

  it('sorting asks the server for nothing new', async () => {
    three(); mount(); await screen.findByText(P(1));
    const calls = h.list.mock.calls.length;
    sortBy('Fit');
    expect(h.list).toHaveBeenCalledTimes(calls);
  });
});

describe('Archived Pipeline — Reactivate', () => {
  it('every HR-tier persona gets a Reactivate button on each row', async () => {
    for (const persona of ['hr_recruiter', 'leadership', 'super_admin'] as const) {
      h.persona = persona;
      mount();
      await screen.findByText('Test Person P0');
      expect(screen.getAllByRole('button', { name: 'Reactivate' })).toHaveLength(1);
      cleanup();
    }
  });

  it('a Hiring Manager sees the pool but has no Reactivate button', async () => {
    h.persona = 'hiring_manager';
    await showFirstPage();
    expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
    expect(names()).toEqual(['Test Person P0']);
  });

  it('opens the link dialog for that candidate, leaves out the roles they already have, and links with the Talent Pool Reactivation channel', async () => {
    h.list.mockResolvedValue({ data: { candidates: [person(0, {}, [{}, { id: 'A-second', role_id: 'R9003', role_title: 'Test Role Gamma' }])], total: 1 } });
    h.rolesList.mockResolvedValue({ data: { roles: [
      { id: 'R9001', title: 'Test Role Alpha' }, { id: 'R9002', title: 'Test Role Beta' }, { id: 'R9003', title: 'Test Role Gamma' },
    ] } });
    mount();
    await screen.findAllByText('Test Person P0');
    fireEvent.click(within(document.querySelector('tbody tr') as HTMLElement).getByRole('button', { name: 'Reactivate' }));
    expect(screen.getByRole('heading', { name: 'Link Test Person P0 to a role' })).toBeInTheDocument();
    const modal = screen.getByRole('heading', { name: /to a role/ }).closest('.fixed') as HTMLElement;
    await within(modal).findByRole('option', { name: 'Test Role Beta' });
    expect(Array.from((within(modal).getByDisplayValue('Select a role…') as HTMLSelectElement).options).slice(1).map(o => o.textContent)).toEqual(['Test Role Beta']);
    fireEvent.change(within(modal).getByDisplayValue('Select a role…'), { target: { value: 'R9002' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(h.linkRole).toHaveBeenCalledWith('C-P0', { role_id: 'R9002', source_channel: 'Talent Pool Reactivation' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /to a role/ })).not.toBeInTheDocument());
  });

  it('reloads the pool after a successful link', async () => {
    await showFirstPage();
    const calls = h.list.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    const modal = screen.getByRole('heading', { name: /to a role/ }).closest('.fixed') as HTMLElement;
    await within(modal).findByRole('option', { name: 'Test Role Beta' });
    fireEvent.change(within(modal).getByDisplayValue('Select a role…'), { target: { value: 'R9002' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(h.list.mock.calls.length).toBeGreaterThan(calls));
  });

  it('Cancel closes the dialog and links nobody', async () => {
    await showFirstPage();
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: /to a role/ })).not.toBeInTheDocument();
    expect(h.linkRole).not.toHaveBeenCalled();
  });
});
