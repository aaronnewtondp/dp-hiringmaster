import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { STAGES, LOW_PIPELINE_MAX_ACTIVE, LOW_PIPELINE_MAX_SHORTLISTED } from '../types/index.ts';
import type { DashboardData } from '../types/index.ts';

// The two low-pipeline thresholds are replaced with numbers the real ones are not, so a figure typed into the page by hand
// (instead of read from the shared constant) cannot pass for it. The test that uses them first checks this replacement is in force.
vi.mock('../types/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../types/index.ts')>()), LOW_PIPELINE_MAX_SHORTLISTED: 11, LOW_PIPELINE_MAX_ACTIVE: 17,
}));

// The Dashboard apart from its Sourcing section (Dashboard.sourcing.test.tsx has that): the master filters and the exact request
// they make, the Hiring Manager's lock to their own role, the headline cards, the funnel, the two role tables and the velocity
// section. The three sections that make their own data calls are stubbed; their props show what filters the page hands them.
const dashboardGet = vi.fn();
const filterOptions = vi.fn();
vi.mock('../services/api.ts', () => ({
  dashboardApi: { get: (p: unknown) => dashboardGet(p) },
  rolesApi: { filterOptions: () => filterOptions() },
}));

const h = vi.hoisted(() => ({ persona: 'hr_recruiter' as string, snapshot: vi.fn(), slaByRole: vi.fn(), sourcing: vi.fn() }));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'u-test', name: 'Test Person', email: 'test.person@example.test', persona: h.persona } }),
}));
vi.mock('../components/shared/HiringFunnelSnapshot.tsx', () => ({ default: (p: unknown) => { h.snapshot(p); return <div data-testid="funnel-snapshot" />; } }));
vi.mock('../components/shared/SlaBreachesByRole.tsx', () => ({ default: (p: unknown) => { h.slaByRole(p); return <div data-testid="sla-by-role" />; } }));
vi.mock('../components/sourcing/SourcingExecution.tsx', () => ({ default: (p: unknown) => { h.sourcing(p); return <div data-testid="sourcing-execution" />; } }));

import Dashboard from './Dashboard.tsx';

const dashboardData = (over: Partial<DashboardData> = {}): { data: DashboardData } => ({
  data: {
    metrics: {
      open_roles_count: 7, open_roles_by_priority: { P0: 2, P1: 3, P2: 1, P3: 1 }, avg_active_role_age_days: 12, avg_time_to_fill_days: 30, roles_filled_last_30d: 4,
      active_candidates: 120, candidates_score_ge_75: 11, candidates_score_le_45: 22, candidates_at_interview1_plus: 15, candidates_unmatched: 6,
      sla_breach_total: 9, sla_breach_by_owner: { 'HR / Recruiter': 5, 'Hiring Manager': 4 }, sla_breach_top_type: { type: 'Idle Candidate', count: 3 },
      sla_breach_top_stage: { stage: 'Offer Released', count: 2 }, red_aging_roles: 0, joining_risk_count: 0,
    },
    hiring_funnel_snapshot: [], aging_roles: [], low_pipeline: [], roles_by_status: {}, hiring_funnel: [], rejected_by_stage: {}, source_quality: [],
    velocity: { interview_to_offer_ratio: null, interviewed_count: 0, offered_count: 0, tat_by_stage: [], biggest_drop_off: null, biggest_drop_off_by_rate: null },
    ...over,
  },
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><Dashboard /></MemoryRouter></QueryClientProvider>);
}
const ready = () => screen.findByRole('heading', { level: 1, name: 'Dashboard' });
const lastParams = () => dashboardGet.mock.calls[dashboardGet.mock.calls.length - 1]?.[0];
const lastProps = (spy: typeof h.snapshot) => spy.mock.calls[spy.mock.calls.length - 1]?.[0]?.masterFilterParams;

// Choosing a filter option changes the query key, and a key with no data yet shows the page's spinner in place of the whole page
// (the filter bar included) until the answer arrives: so the next filter can only be reached once the page is back.
const pick = async (filter: RegExp, option: string) => {
  const before = dashboardGet.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: filter }));
  fireEvent.click(screen.getByRole('checkbox', { name: option }));
  fireEvent.mouseDown(document.body);
  await waitFor(() => expect(dashboardGet.mock.calls.length).toBeGreaterThan(before));
  await ready();
};
const roleFilter = () => screen.queryByRole('button', { name: /^Role(\s|$)/ });

const card = (label: string) => screen.getByText(label).closest('.card') as HTMLElement;
const headline = (label: string) => (card(label).querySelector('span.text-3xl') as HTMLElement).textContent;
const sub = (label: string, subLabel: string) => within(card(label)).getByText(subLabel).nextElementSibling?.textContent;
const sectionCard = (heading: string) => screen.getByRole('heading', { level: 2, name: heading }).closest('.card') as HTMLElement;

beforeEach(() => {
  dashboardGet.mockReset(); filterOptions.mockReset(); h.snapshot.mockReset(); h.slaByRole.mockReset(); h.sourcing.mockReset();
  sessionStorage.clear();
  h.persona = 'hr_recruiter';
  dashboardGet.mockResolvedValue(dashboardData());
  filterOptions.mockResolvedValue({ data: { recruitment_modes: ['LinkedIn', 'Direct Outreach'], roles: [{ id: 'R9001', title: 'Test Role Alpha' }, { id: 'R9002', title: 'Test Role Beta' }] } });
});
afterEach(() => { vi.useRealTimers(); });

describe('Dashboard — the master filters and what they ask for', () => {
  it('asks for everything while no filter is set, and shows no "Clear all"', async () => {
    mount();
    await ready();
    expect(dashboardGet).toHaveBeenCalledTimes(1);
    expect(dashboardGet).toHaveBeenCalledWith({});
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  });

  const cases: Array<[string, RegExp, string, string]> = [
    ['Department',       /^Department/,       'Tech/Devs',        'department'],
    ['Location',         /^Location/,         'Pune',             'location'],
    ['Priority',         /^Priority/,         'P0',               'priority'],
    ['Recruitment Mode', /^Recruitment Mode/, 'LinkedIn',         'recruitment_mode'],
    ['Role',             /^Role(\s|$)/,       'Test Role Alpha',  'role_id'],
  ];
  for (const [label, matcher, option, key] of cases) {
    it(`the ${label} filter sends ${key} as a list${label === 'Role' ? ' of role ids, not titles' : ''}`, async () => {
      mount();
      await ready();
      await waitFor(() => expect(filterOptions).toHaveBeenCalled());
      if (label === 'Recruitment Mode' || label === 'Role') await screen.findByRole('button', { name: matcher });
      fireEvent.click(screen.getByRole('button', { name: matcher }));
      fireEvent.click(await screen.findByRole('checkbox', { name: option }));
      const expected = label === 'Role' ? ['R9001'] : [option];
      await waitFor(() => expect(lastParams()).toEqual({ [key]: expected }));
    });
  }

  it('several filters combine into one request, several values into one list', async () => {
    mount();
    await ready();
    await pick(/^Department/, 'Tech/Devs');
    await pick(/^Department/, 'Domain');
    await pick(/^Priority/, 'P1');
    await waitFor(() => expect(lastParams()).toEqual({ department: ['Tech/Devs', 'Domain'], priority: ['P1'] }));
  });

  it('offers the recruitment modes and roles the server reports, nothing else', async () => {
    mount();
    await ready();
    await waitFor(() => expect(filterOptions).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /^Recruitment Mode/ }));
    expect(await screen.findByRole('checkbox', { name: 'Direct Outreach' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Agency' })).toBeNull();
    fireEvent.mouseDown(document.body);
    fireEvent.click(screen.getByRole('button', { name: /^Role(\s|$)/ }));
    expect(screen.getByRole('checkbox', { name: 'Test Role Beta' })).toBeInTheDocument();
  });

  it('until the server has answered there is no recruitment mode or role to choose from, and nothing is made up in their place', async () => {
    filterOptions.mockReturnValue(new Promise(() => {}));
    mount();
    await ready();
    await waitFor(() => expect(filterOptions).toHaveBeenCalledTimes(1));
    for (const filter of [/^Recruitment Mode/, /^Role(\s|$)/]) {
      fireEvent.click(screen.getByRole('button', { name: filter }));
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
      fireEvent.mouseDown(document.body);
    }
  });

  it('hands the same filters to the funnel snapshot, the SLA-by-role chart and Sourcing execution', async () => {
    mount();
    await ready();
    expect(lastProps(h.snapshot)).toEqual({});
    await pick(/^Department/, 'Tech/Devs');
    await pick(/^Priority/, 'P0');
    await waitFor(() => expect(lastParams()).toEqual({ department: ['Tech/Devs'], priority: ['P0'] }));
    for (const spy of [h.snapshot, h.slaByRole, h.sourcing]) await waitFor(() => expect(lastProps(spy)).toEqual({ department: ['Tech/Devs'], priority: ['P0'] }));
  });

  it('"Clear all" appears with the first filter, empties every filter at once and goes away again', async () => {
    mount();
    await ready();
    await pick(/^Department/, 'Tech/Devs');
    await pick(/^Location/, 'Pune');
    const clear = await screen.findByRole('button', { name: 'Clear all' });
    await waitFor(() => expect(lastParams()).toEqual({ department: ['Tech/Devs'], location: ['Pune'] }));
    fireEvent.click(clear);
    await waitFor(() => expect(lastParams()).toEqual({}));
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
    expect(JSON.parse(sessionStorage.getItem('hms:dashboard.departments') as string)).toEqual([]);
    expect(JSON.parse(sessionStorage.getItem('hms:dashboard.locations') as string)).toEqual([]);
  });

  it('starts from the filters left over from the last visit in this tab', async () => {
    sessionStorage.setItem('hms:dashboard.priorities', JSON.stringify(['P0']));
    sessionStorage.setItem('hms:dashboard.modes', JSON.stringify(['LinkedIn']));
    mount();
    await ready();
    expect(dashboardGet).toHaveBeenCalledWith({ priority: ['P0'], recruitment_mode: ['LinkedIn'] });
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
  });

  // Each of the five filters lives under its own key. A selection left in any ONE of them must be enough to show "Clear all", to turn the
  // two figures that cannot be filtered into N/A, and to be emptied by "Clear all": otherwise a view narrowed by that filter alone would
  // still show the unfiltered "Filled (30D)" and "Unmatched" numbers as if they belonged to it.
  const FILTER_KEYS: Array<[string, string]> = [
    ['hms:dashboard.departments', 'Tech/Devs'], ['hms:dashboard.locations', 'Pune'], ['hms:dashboard.modes', 'LinkedIn'],
    ['hms:dashboard.priorities', 'P0'], ['hms:dashboard.roleIds', 'R9001'],
  ];
  it.each(FILTER_KEYS)('a lone selection stored under %s is a filter: "Clear all" shows, both figures read N/A, and "Clear all" empties it', async (key, value) => {
    sessionStorage.setItem(key, JSON.stringify([value]));
    mount();
    await ready();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
    expect(sub('Roles Snapshot', 'Filled (30D)')).toBe('N/A');
    expect(sub('Active candidates', 'Unmatched')).toBe('N/A');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(lastParams()).toEqual({}));
    expect(JSON.parse(sessionStorage.getItem(key) as string)).toEqual([]);
    await ready();                                                       // the unfiltered request has a new key: the page is back once it answers
    expect(sub('Roles Snapshot', 'Filled (30D)')).toBe('4');
    expect(sub('Active candidates', 'Unmatched')).toBe('6');
  });

  it('with a filter on, the two figures that cannot be filtered read N/A: roles filled in 30 days and unmatched candidates', async () => {
    mount();
    await ready();
    expect(sub('Roles Snapshot', 'Filled (30D)')).toBe('4');
    expect(sub('Active candidates', 'Unmatched')).toBe('6');
    await pick(/^Department/, 'Tech/Devs');
    await waitFor(() => expect(sub('Roles Snapshot', 'Filled (30D)')).toBe('N/A'));
    expect(sub('Active candidates', 'Unmatched')).toBe('N/A');
    expect(sub('Active candidates', 'Fit score ≥75')).toBe('11');          // the rest are unaffected
  });
});

describe('Dashboard — a Hiring Manager is locked to their own role', () => {
  beforeEach(() => { h.persona = 'hiring_manager'; });

  it('shows the lock instead of a Role filter, and never asks for the role list', async () => {
    mount();
    await ready();
    expect(screen.getByText(/Locked to your role/)).toBeInTheDocument();
    expect(roleFilter()).toBeNull();
    expect(filterOptions).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Department/ })).toBeInTheDocument();     // the other filters are still theirs to use
  });

  it('never sends a role_id, even when one is left over from an earlier session', async () => {
    sessionStorage.setItem('hms:dashboard.roleIds', JSON.stringify(['R9002']));
    mount();
    await ready();
    expect(dashboardGet).toHaveBeenCalledTimes(1);
    expect(dashboardGet).toHaveBeenCalledWith({});
    expect(lastParams()).not.toHaveProperty('role_id');
    for (const spy of [h.snapshot, h.slaByRole, h.sourcing]) expect(lastProps(spy)).toEqual({});
  });

  it('a leftover role is not an active filter for them: no "Clear all", and the figures that need "no filter" still show', async () => {
    sessionStorage.setItem('hms:dashboard.roleIds', JSON.stringify(['R9002']));
    mount();
    await ready();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
    expect(sub('Roles Snapshot', 'Filled (30D)')).toBe('4');
    expect(sub('Active candidates', 'Unmatched')).toBe('6');
  });

  it('their own filters still go out, without a role_id', async () => {
    sessionStorage.setItem('hms:dashboard.roleIds', JSON.stringify(['R9002']));
    mount();
    await ready();
    await pick(/^Priority/, 'P1');
    await waitFor(() => expect(lastParams()).toEqual({ priority: ['P1'] }));
    await waitFor(() => expect(lastProps(h.snapshot)).toEqual({ priority: ['P1'] }));
  });

  for (const persona of ['hr_recruiter', 'leadership', 'super_admin']) {
    it(`${persona}: has the Role filter, no lock, and the role list is requested`, async () => {
      h.persona = persona;
      mount();
      await ready();
      expect(roleFilter()).toBeInTheDocument();
      expect(screen.queryByText(/Locked to your role/)).toBeNull();
      await waitFor(() => expect(filterOptions).toHaveBeenCalledTimes(1));
    });
  }

  it('anyone else\'s leftover role selection IS sent, and counts as a filter', async () => {
    h.persona = 'hr_recruiter';
    sessionStorage.setItem('hms:dashboard.roleIds', JSON.stringify(['R9002']));
    mount();
    await ready();
    expect(dashboardGet).toHaveBeenCalledWith({ role_id: ['R9002'] });
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
    expect(sub('Roles Snapshot', 'Filled (30D)')).toBe('N/A');
  });
});

describe('Dashboard — loading and failing', () => {
  it('shows a spinner and no page while the numbers are on their way', async () => {
    let resolve!: (v: unknown) => void;
    dashboardGet.mockReturnValue(new Promise(r => { resolve = r; }));
    const { container } = mount();
    await waitFor(() => expect(dashboardGet).toHaveBeenCalled());
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByRole('heading', { level: 1, name: 'Dashboard' })).toBeNull();
    expect(screen.queryByText('Failed to load dashboard')).toBeNull();
    resolve(dashboardData());
    await ready();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('says "Failed to load dashboard" when the request fails, and shows none of the page', async () => {
    dashboardGet.mockImplementation(async () => { throw new Error('Network Error'); });
    mount();
    expect(await screen.findByText('Failed to load dashboard')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Dashboard' })).toBeNull();
    expect(screen.queryByTestId('funnel-snapshot')).toBeNull();
  });

  it('a refresh that fails after the page has loaded also ends in "Failed to load dashboard": the numbers already shown are not kept', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    mount();
    await ready();
    dashboardGet.mockImplementation(async () => { throw new Error('Network Error'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(await screen.findByText('Failed to load dashboard')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Dashboard' })).toBeNull();
  });

  it('re-reads the dashboard every 5 minutes, and not before', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    mount();
    await ready();
    expect(dashboardGet).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1); });
    expect(dashboardGet).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(dashboardGet).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(dashboardGet).toHaveBeenCalledTimes(3);
  });
});

describe('Dashboard — the headline cards', () => {
  it('Roles Snapshot: open roles, P0+P1 together, average age and time to fill, roles filled in 30 days', async () => {
    mount();
    await ready();
    expect(headline('Roles Snapshot')).toBe('7');
    expect(sub('Roles Snapshot', 'P0+P1 roles')).toBe('5');                 // 2 + 3
    expect(sub('Roles Snapshot', 'Avg. active role age')).toBe('12d');
    expect(sub('Roles Snapshot', 'Avg. time to fill')).toBe('30d');
    expect(sub('Roles Snapshot', 'Filled (30D)')).toBe('4');
  });

  it('an average that cannot be worked out yet reads as a dash, not 0', async () => {
    dashboardGet.mockResolvedValue(dashboardData({ metrics: { ...dashboardData().data.metrics, avg_active_role_age_days: null, avg_time_to_fill_days: null } }));
    mount();
    await ready();
    expect(sub('Roles Snapshot', 'Avg. active role age')).toBe('—');
    expect(sub('Roles Snapshot', 'Avg. time to fill')).toBe('—');
  });

  it('Active candidates: the total and its four breakdowns', async () => {
    mount();
    await ready();
    expect(headline('Active candidates')).toBe('120');
    expect(sub('Active candidates', 'Fit score ≥75')).toBe('11');
    expect(sub('Active candidates', 'Fit score ≤45')).toBe('22');
    expect(sub('Active candidates', '≥Interview 1')).toBe('15');
    expect(sub('Active candidates', 'Unmatched')).toBe('6');
  });

  it('SLA breaches: the total, who owns them, and the worst type and stage', async () => {
    mount();
    await ready();
    expect(headline('SLA breaches')).toBe('9');
    expect(sub('SLA breaches', 'HR/Admin')).toBe('5');                      // the server calls this owner "HR / Recruiter"
    expect(sub('SLA breaches', 'Hiring Manager')).toBe('4');
    expect(sub('SLA breaches', 'Top type')).toBe('Idle Candidate');
    expect(sub('SLA breaches', 'Top stage')).toBe('Offer Released');
  });

  it('with no breaches: 0 each way, a dash for the top type and stage, and the figure is not in red', async () => {
    dashboardGet.mockResolvedValue(dashboardData({ metrics: { ...dashboardData().data.metrics, sla_breach_total: 0, sla_breach_by_owner: {}, sla_breach_top_type: null, sla_breach_top_stage: null } }));
    mount();
    await ready();
    expect(headline('SLA breaches')).toBe('0');
    expect(sub('SLA breaches', 'HR/Admin')).toBe('0');
    expect(sub('SLA breaches', 'Hiring Manager')).toBe('0');
    expect(sub('SLA breaches', 'Top type')).toBe('—');
    expect(sub('SLA breaches', 'Top stage')).toBe('—');
    expect(card('SLA breaches').querySelector('svg')?.getAttribute('class')).not.toContain('text-red-500');
  });

  it('breaches turn the SLA icon red', async () => {
    mount();
    await ready();
    expect(card('SLA breaches').querySelector('svg')?.getAttribute('class')).toContain('text-red-500');
  });
});

describe('Dashboard — the hiring funnel', () => {
  const funnel = () => sectionCard('Hiring funnel');
  const rowOf = (stage: string) => within(funnel()).getByText(stage).parentElement as HTMLElement;
  const countOf = (stage: string) => (rowOf(stage).lastElementChild as HTMLElement).textContent;
  const barWidth = (stage: string) => (rowOf(stage).querySelector('.bg-dp-400') as HTMLElement).style.width;

  beforeEach(() => {
    dashboardGet.mockResolvedValue(dashboardData({ hiring_funnel: [
      { stage: 'Applied and Screened', active: 8, rejected: 2, withdrawn: 1, hold_for_future: 3 },
      { stage: 'Interview Round 1', active: 4, rejected: 0, withdrawn: 0, hold_for_future: 0 },
      { stage: 'Offer Released', active: 0, rejected: 1, withdrawn: 0, hold_for_future: 0 },
    ] }));
  });

  it('lists every stage in the pipeline\'s own order, those nobody is at included, each with its count', async () => {
    mount();
    await ready();
    const labels = Array.from(funnel().querySelectorAll('span.w-36')).map(s => s.textContent);
    expect(labels).toEqual(STAGES);
    expect(countOf('Applied and Screened')).toBe('8');
    expect(countOf('Interview Round 1')).toBe('4');
    for (const empty of ['Interview Round 2', 'Assignment Round', 'Founders Round', 'Reference Check', 'Pre-Joining Documents', 'Offer Discussion', 'Offer Accepted', 'Joined']) {
      expect(countOf(empty)).toBe('0');
    }
    expect(countOf('Offer Released')).toBe('0');
  });

  it('scales each bar against the busiest stage, and an empty stage has none', async () => {
    mount();
    await ready();
    expect(barWidth('Applied and Screened')).toBe('100%');
    expect(barWidth('Interview Round 1')).toBe('50%');
    expect(barWidth('Interview Round 2')).toBe('0%');
    expect(barWidth('Joined')).toBe('0%');
  });

  it('rounds each bar to the nearest whole percent of the busiest stage (9 of 24 is 38%, not 37%; 8 of 24 is 33%, not 34%)', async () => {
    dashboardGet.mockResolvedValue(dashboardData({ hiring_funnel: [
      { stage: 'Applied and Screened', active: 24, rejected: 0, withdrawn: 0, hold_for_future: 0 },
      { stage: 'Interview Round 1', active: 9, rejected: 0, withdrawn: 0, hold_for_future: 0 },
      { stage: 'Interview Round 2', active: 8, rejected: 0, withdrawn: 0, hold_for_future: 0 },
    ] }));
    mount();
    await ready();
    expect([barWidth('Applied and Screened'), barWidth('Interview Round 1'), barWidth('Interview Round 2')]).toEqual(['100%', '38%', '33%']);
  });

  it('under each bar says how many were rejected, withdrawn or put on hold there, and says nothing when none were', async () => {
    mount();
    await ready();
    const text = (stage: string) => rowOf(stage).textContent;
    expect(text('Applied and Screened')).toContain('2 rejected');
    expect(text('Applied and Screened')).toContain('1 withdrawn');
    expect(text('Applied and Screened')).toContain('3 on hold');
    expect(text('Interview Round 1')).not.toMatch(/rejected|withdrawn|on hold/);
    expect(text('Offer Released')).toContain('1 rejected');          // a stage nobody is at now can still have a history
    expect(text('Offer Released')).not.toMatch(/withdrawn|on hold/);
  });

  it('a funnel with nobody in it still shows every stage, all empty', async () => {
    dashboardGet.mockResolvedValue(dashboardData({ hiring_funnel: [] }));
    mount();
    await ready();
    expect(Array.from(funnel().querySelectorAll('span.w-36')).map(s => s.textContent)).toEqual(STAGES);
    for (const stage of STAGES) { expect(countOf(stage)).toBe('0'); expect(barWidth(stage)).toBe('0%'); }
  });
});

describe('Dashboard — Aging roles', () => {
  const aging = (id: string, title: string, alert: 'ok' | 'yellow' | 'red', over: Record<string, unknown> = {}) => ({
    id, title, priority: 'P1', status: 'Live – Sourcing', num_openings: 1, hiring_manager_name: 'Hana Manager', aging_alert: alert,
    days_open: 20, days_overdue: alert === 'ok' ? 0 : 4, active_count: 0, shortlisted_scored_count: 0, no_recent_candidate_activity: false, ...over,
  });
  const titles = () => within(sectionCard('Aging roles')).getAllByRole('link').map(a => a.textContent);

  it('lists the red roles first, then yellow, then the rest, each group in the order the server gave', async () => {
    dashboardGet.mockResolvedValue(dashboardData({ aging_roles: [
      aging('R1', 'Ok One', 'ok'), aging('R2', 'Red One', 'red'), aging('R3', 'Yellow One', 'yellow'),
      aging('R4', 'Red Two', 'red'), aging('R5', 'Ok Two', 'ok'), aging('R6', 'Yellow Two', 'yellow'),
    ] as unknown as DashboardData['aging_roles'] }));
    mount();
    await ready();
    expect(titles()).toEqual(['Red One', 'Red Two', 'Yellow One', 'Yellow Two', 'Ok One', 'Ok Two']);
  });

  it('shows each role\'s link, priority, Hiring Manager and how far past its Close Target it is', async () => {
    dashboardGet.mockResolvedValue(dashboardData({ aging_roles: [
      aging('R2', 'Red One', 'red', { priority: 'P0', days_open: 40, days_overdue: 9, hiring_manager_name: 'Ivan Lead' }),
      aging('R1', 'Ok One', 'ok', { days_open: 12 }),
    ] as unknown as DashboardData['aging_roles'] }));
    mount();
    await ready();
    const red = within(screen.getByText('Red One').closest('tr') as HTMLElement);
    expect(red.getByRole('link')).toHaveAttribute('href', '/roles/R2');
    expect(red.getByText('P0')).toBeInTheDocument();
    expect(red.getByText('Ivan Lead')).toBeInTheDocument();
    expect(red.getByText('🔴 9d over · 40d open')).toBeInTheDocument();
    expect(within(screen.getByText('Ok One').closest('tr') as HTMLElement).getByText('12d open')).toBeInTheDocument();
  });

  it('marks only the roles where no candidate has moved lately', async () => {
    dashboardGet.mockResolvedValue(dashboardData({ aging_roles: [
      aging('R1', 'Quiet One', 'ok', { no_recent_candidate_activity: true }),
      aging('R2', 'Busy One', 'ok'),
    ] as unknown as DashboardData['aging_roles'] }));
    mount();
    await ready();
    const markerCell = (title: string) => (screen.getByText(title).closest('tr') as HTMLTableRowElement).cells[1];
    expect(markerCell('Quiet One').querySelector('svg')).not.toBeNull();
    expect(markerCell('Busy One').querySelector('svg')).toBeNull();
  });

  it('says "No open roles" when there are none', async () => {
    mount();
    await ready();
    expect(within(sectionCard('Aging roles')).getByText('No open roles')).toBeInTheDocument();
    expect(within(sectionCard('Aging roles')).queryByRole('table')).toBeNull();
  });
});

describe('Dashboard — Low pipeline roles', () => {
  const lowRow = (id: string, title: string, over: Record<string, unknown> = {}) => ({
    id, title, priority: 'P2', status: 'Live – Sourcing', num_openings: 1, hiring_manager_name: 'Hana Manager',
    active_count: 5, scored_above_60_count: 3, shortlisted_count: 1, shortlisted_scored_count: 1, no_recent_candidate_activity: false, ...over,
  });

  it('lists each role with its four funnel counts in order: Pipeline, Scored >60, Shortlisted, Shortlisted >60', async () => {
    dashboardGet.mockResolvedValue(dashboardData({ low_pipeline: [
      lowRow('R1', 'Thin One', { priority: 'P0', hiring_manager_name: 'Ivan Lead', active_count: 7, scored_above_60_count: 4, shortlisted_count: 2, shortlisted_scored_count: 1 }),
      lowRow('R2', 'Thin Two'),
    ] as unknown as DashboardData['low_pipeline'] }));
    mount();
    await ready();
    const cells = (title: string) => Array.from((screen.getByText(title).closest('tr') as HTMLTableRowElement).cells).map(c => c.textContent);
    expect(cells('Thin One')).toEqual(['Thin One', 'P0', 'Ivan Lead', '7', '4', '2', '1']);
    expect(cells('Thin Two')).toEqual(['Thin Two', 'P2', 'Hana Manager', '5', '3', '1', '1']);
    expect(within(sectionCard('Low pipeline roles')).getByRole('link', { name: 'Thin One' })).toHaveAttribute('href', '/roles/R1');
  });

  it('quotes the two thresholds from the shared constants in the intro, the two column headers and the info box, not from numbers of its own', async () => {
    expect([LOW_PIPELINE_MAX_SHORTLISTED, LOW_PIPELINE_MAX_ACTIVE]).toEqual([11, 17]);       // the replacement at the top of this file is in force
    dashboardGet.mockResolvedValue(dashboardData({ low_pipeline: [lowRow('R1', 'Thin One')] as unknown as DashboardData['low_pipeline'] }));
    mount();
    await ready();
    const card = within(sectionCard('Low pipeline roles'));
    expect(card.getByText(/^Approved, Live – Sourcing, Under Review or On Hold roles with fewer than/).textContent)
      .toBe('Approved, Live – Sourcing, Under Review or On Hold roles with fewer than 11 shortlisted candidates and fewer than 17 active candidates in the pipeline');
    expect(card.getByRole('columnheader', { name: 'Pipeline' })).toHaveAttribute('title', expect.stringMatching(/fewer than 17$/));
    expect(card.getByRole('columnheader', { name: 'Shortlisted' })).toHaveAttribute('title', expect.stringMatching(/fewer than 11$/));
    fireEvent.mouseEnter(card.getByRole('button', { name: 'More info' }));
    expect(card.getByText(/^Roles that are Approved/).textContent).toMatch(/fewer than 11 shortlisted candidates .* AND fewer than 17 Active candidates/);
  });

  it('says there are none, with no table, when no role is low on pipeline', async () => {
    mount();
    await ready();
    expect(within(sectionCard('Low pipeline roles')).getByText('No low-pipeline roles ✓')).toBeInTheDocument();
    expect(within(sectionCard('Low pipeline roles')).queryByRole('table')).toBeNull();
  });
});

describe('Dashboard — Source quality', () => {
  it('shows each source with its sample size and its pass rate, hire rate and contribution', async () => {
    dashboardGet.mockResolvedValue(dashboardData({ source_quality: [
      { source_channel: 'LinkedIn', n: 40, pass_rate: 25, hire_rate: 5, contribution_pct: 60 },
      { source_channel: 'Agency', n: 10, pass_rate: 50, hire_rate: 20, contribution_pct: 15 },
    ] }));
    mount();
    await ready();
    const block = (name: string) => within(sectionCard('Source quality')).getByText(name).closest('div')!.parentElement as HTMLElement;
    expect(block('LinkedIn').textContent).toContain('40 applications');
    for (const text of ['25%', '5%', '60%']) expect(within(block('LinkedIn')).getByText(text)).toBeInTheDocument();
    expect(block('Agency').textContent).toContain('10 applications');
    for (const text of ['50%', '20%', '15%']) expect(within(block('Agency')).getByText(text)).toBeInTheDocument();
  });

  it('draws each source\'s three bars as long as the three percentages beside them: pass rate, hire rate, contribution', async () => {
    dashboardGet.mockResolvedValue(dashboardData({ source_quality: [{ source_channel: 'LinkedIn', n: 40, pass_rate: 25, hire_rate: 5, contribution_pct: 60 }] }));
    mount();
    await ready();
    const block = within(sectionCard('Source quality')).getByText('LinkedIn').closest('div')!.parentElement as HTMLElement;
    const width = (bar: string) => (block.querySelector(bar) as HTMLElement).style.width;
    expect([width('.bg-dp-400'), width('.bg-green-500'), width('.bg-amber-400')]).toEqual(['25%', '5%', '60%']);
  });

  it('says so when nothing has a source yet', async () => {
    mount();
    await ready();
    expect(within(sectionCard('Source quality')).getByText('No sourced applications yet')).toBeInTheDocument();
  });
});

describe('Dashboard — Operational velocity', () => {
  const velocity = (over: Partial<DashboardData['velocity']> = {}): DashboardData['velocity'] => ({
    interview_to_offer_ratio: 40, interviewed_count: 5, offered_count: 2,
    tat_by_stage: [{ stage: 'Offer Discussion', avg_hours: 60, n: 4 }, { stage: 'Reference Check', avg_hours: 36, n: 3 }, { stage: 'Interview Round 1', avg_hours: 12, n: 9 }, { stage: 'Assignment Round', avg_hours: 48, n: 2 }],
    biggest_drop_off: { stage: 'Applied and Screened', count: 14 }, biggest_drop_off_by_rate: { stage: 'Interview Round 2', count: 3, rate: 60 }, ...over,
  });
  const turnaround = () => sectionCard('Turnaround time by stage');

  it('shows the time spent at each stage in hours under a day and in days from a day up, in the order given', async () => {
    dashboardGet.mockResolvedValue(dashboardData({ velocity: velocity() }));
    mount();
    await ready();
    const rows = Array.from(turnaround().querySelectorAll('span.w-36')).map(s => [s.textContent, s.parentElement?.lastElementChild?.textContent]);
    expect(rows).toEqual([['Offer Discussion', '2.5d'], ['Reference Check', '1.5d'], ['Interview Round 1', '12h'], ['Assignment Round', '2d']]);
  });

  it('a stage is shown in hours up to just under 24 and in days from exactly 24 (23.5 hours is "23.5h", 24 hours is "1d")', async () => {
    dashboardGet.mockResolvedValue(dashboardData({ velocity: velocity({ tat_by_stage: [
      { stage: 'Offer Discussion', avg_hours: 24, n: 2 }, { stage: 'Reference Check', avg_hours: 23.5, n: 2 },
    ] }) }));
    mount();
    await ready();
    const rows = Array.from(turnaround().querySelectorAll('span.w-36')).map(s => [s.textContent, s.parentElement?.lastElementChild?.textContent]);
    expect(rows).toEqual([['Offer Discussion', '1d'], ['Reference Check', '23.5h']]);
  });

  it('says there is not enough history when no stage has been timed', async () => {
    mount();
    await ready();
    expect(within(turnaround()).getByText('Not enough stage-change history yet')).toBeInTheDocument();
  });

  it('Interview → Offer: the percentage and the counts behind it; a dash while there is no ratio', async () => {
    dashboardGet.mockResolvedValue(dashboardData({ velocity: velocity() }));
    const first = mount();
    await ready();
    const ratioCard = () => screen.getByText('Interview → Offer ratio').closest('.card') as HTMLElement;
    expect(ratioCard().querySelector('.text-2xl')?.textContent).toBe('40%');
    expect(ratioCard().textContent).toContain('2 of 5');
    first.unmount();

    dashboardGet.mockResolvedValue(dashboardData());
    mount();
    await ready();
    expect(ratioCard().querySelector('.text-2xl')?.textContent).toBe('—');
  });

  it('Biggest drop-off: the stage with the most rejections and, if it is a different stage, the one with the highest rate', async () => {
    dashboardGet.mockResolvedValue(dashboardData({ velocity: velocity() }));
    mount();
    await ready();
    const dropCard = screen.getByText('Biggest drop-off stage').closest('.card') as HTMLElement;
    expect(within(dropCard).getByText('Applied and Screened')).toBeInTheDocument();
    expect(within(dropCard).getByText(/^14 rejected/)).toBeInTheDocument();
    expect(within(dropCard).getByText('Interview Round 2')).toBeInTheDocument();
    expect(within(dropCard).getByText(/^60% rejected/)).toBeInTheDocument();
  });

  it('when both measures name the same stage it is shown once', async () => {
    dashboardGet.mockResolvedValue(dashboardData({ velocity: velocity({ biggest_drop_off_by_rate: { stage: 'Applied and Screened', count: 14, rate: 70 } }) }));
    mount();
    await ready();
    const dropCard = screen.getByText('Biggest drop-off stage').closest('.card') as HTMLElement;
    expect(within(dropCard).getAllByText('Applied and Screened')).toHaveLength(1);
    expect(within(dropCard).queryByText(/highest rate/)).toBeNull();
  });

  it('with no rejections at all it says so', async () => {
    mount();
    await ready();
    const dropCard = screen.getByText('Biggest drop-off stage').closest('.card') as HTMLElement;
    expect(within(dropCard).getByText('No rejections recorded')).toBeInTheDocument();
  });
});
