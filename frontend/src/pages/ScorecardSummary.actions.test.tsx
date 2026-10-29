import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { OVER_BUDGET_SHORTLIST_REASONS, REJECTION_REASONS } from '../types/index.ts';
import { application, FILTER_OPTIONS } from '../test/candidateFixtures.ts';

// Ready for Review (Scorecard Summary): the request it makes and each filter's parameter, Shortlist / Hold for Future /
// Reject for one row and for a selection (the mandatory over-budget reason, several rejection reasons, per-recipient
// e-mail text, batching), the retry-scoring banner, and what each persona is given. The Portfolio filter, the persona
// scope request, the Portfolio column and the column headers are pinned in the other ScorecardSummary.*.test.tsx files.
const h = vi.hoisted(() => ({
  persona: 'hr_recruiter' as 'hr_recruiter' | 'hiring_manager' | 'leadership' | 'super_admin',
  list: vi.fn(), advanceStage: vi.fn(), updateStatus: vi.fn(), retryScoring: vi.fn(), filterOptions: vi.fn(),
  toastSuccess: vi.fn(), toastError: vi.fn(),
}));
vi.mock('../services/api.ts', () => ({
  applicationsApi: {
    list: (p: unknown) => h.list(p),
    advanceStage: (...a: unknown[]) => h.advanceStage(...a),
    updateStatus: (...a: unknown[]) => h.updateStatus(...a),
    retryScoring: (...a: unknown[]) => h.retryScoring(...a),
  },
  rolesApi: { filterOptions: () => h.filterOptions() },
}));
// The same derivation AuthContext uses for these two flags (its own tests pin the real one).
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({
    canHR: h.persona !== 'hiring_manager',
    canLead: h.persona === 'leadership' || h.persona === 'super_admin',
  }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: (m: string) => h.toastSuccess(m), error: (m: string) => h.toastError(m) } }));

import ScorecardSummary from './ScorecardSummary.tsx';

// The debounce test fakes setTimeout: give react-query the real one so only the page's own timer is driven by the fake clock.
const realSetTimeout = globalThis.setTimeout;
beforeAll(() => { notifyManager.setScheduler(cb => { realSetTimeout(cb, 0); }); });

const row = (id: string, over: Record<string, unknown> = {}) => application(id, {
  email: `${id.toLowerCase()}@example.test`, score_avg: 7, score_recommendation: 'Yes', ...over,
});
const R1 = row('A9001', { score_avg: 8.2, candidate_expected_ctc: 20, is_severely_over_budget: true, application_date: '2026-10-01T00:00:00Z' });
const R2 = row('A9002', { role_id: 'R9002', role_title: 'Test Role Beta', score_avg: 6.5, application_date: '2026-10-10T00:00:00Z' });
const R3 = row('A9003', { score_avg: 7.1, application_date: '2026-10-05T00:00:00Z' });
const ROWS = [R1, R2, R3];

type Scope = Parameters<typeof ScorecardSummary>[0]['personaScope'];
function mount(opts: { scope?: Scope; path?: string; onCountChange?: (n: number) => void } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[opts.path || '/']}><ScorecardSummary personaScope={opts.scope} onCountChange={opts.onCountChange} /></MemoryRouter>
    </QueryClientProvider>,
  );
}
const showRows = async (opts: Parameters<typeof mount>[0] = {}) => { mount(opts); await screen.findByText('Test Candidate A9001'); };
const lastRequest = () => h.list.mock.calls[h.list.mock.calls.length - 1][0] as Record<string, unknown>;
const BASE = { limit: '500', scored_only: 'true', scored_only_exempt_stage: 'Applied and Screened', status: ['Active'] };
const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLTableRowElement;
const names = () => Array.from(document.querySelectorAll('tbody tr')).map(tr => tr.querySelector('a')?.textContent).filter(Boolean);
const tick = (name: string) => fireEvent.click(within(rowOf(name)).getByRole('checkbox'));
const bar = (count: number) => screen.getByText(`${count} selected`).parentElement as HTMLElement;
const modalOf = (heading: string | RegExp) => screen.getByRole('heading', { name: heading }).closest('.fixed') as HTMLElement;
const pick = async (filter: RegExp, option: string) => {
  fireEvent.click(screen.getByRole('button', { name: filter }));
  fireEvent.click(await screen.findByLabelText(option));
};
const NO_BUDGET = { budgetExceptionReasonCat: undefined, budgetExceptionReasonDetail: undefined };

beforeEach(() => {
  h.persona = 'hr_recruiter';
  for (const f of [h.list, h.advanceStage, h.updateStatus, h.retryScoring, h.filterOptions, h.toastSuccess, h.toastError]) f.mockReset();
  sessionStorage.clear();
  h.list.mockResolvedValue({ data: { applications: ROWS } });
  h.advanceStage.mockResolvedValue({ data: {} });
  h.updateStatus.mockResolvedValue({ data: {} });
  h.retryScoring.mockResolvedValue({ data: {} });
  h.filterOptions.mockResolvedValue(FILTER_OPTIONS);
});
afterEach(() => { vi.useRealTimers(); });

describe('Ready for Review — the request and its filters', () => {
  it('asks for scored applications (500 at most), Active only, with Applied and Screened exempt from the score rule', async () => {
    await showRows();
    expect(h.list.mock.calls[0][0]).toEqual(BASE);
  });

  it('the Status filter REPLACES the Active default instead of adding to it', async () => {
    await showRows();
    await pick(/^Status/, 'Rejected');
    await waitFor(() => expect(lastRequest().status).toEqual(['Rejected']));
    fireEvent.click(screen.getByLabelText('Hold for Future'));
    await waitFor(() => expect(lastRequest().status).toEqual(['Rejected', 'Hold for Future']));
    fireEvent.click(screen.getByRole('button', { name: /Clear status/ }));
    await waitFor(() => expect(lastRequest().status).toEqual(['Active']));
  });

  it.each([
    ['Department', /^Department/, 'Tech/Devs', 'department', ['Tech/Devs']],
    ['Location', /^Location/, 'Pune', 'location', ['Pune']],
    ['Recruitment Mode', /^Recruitment Mode/, 'Agency', 'recruitment_mode', ['Agency']],
    ['Priority', /^Priority/, 'P0', 'priority', ['P0']],
    ['Role', /^Role/, 'Test Role Beta', 'role_id', ['R9002']],
    ['Gender (Male)', /^Gender/, 'Male', 'gender', ['M']],
    ['Gender (Female)', /^Gender/, 'Female', 'gender', ['F']],
    ['Gender (Not tagged)', /^Gender/, 'Not tagged', 'gender', ['UNKNOWN']],
  ])('%s filter sends %s', async (_name, button, option, param, value) => {
    await showRows();
    await pick(button as RegExp, option as string);
    await waitFor(() => expect(lastRequest()).toEqual({ ...BASE, [param as string]: value }));
  });

  it('Gender: "Not tagged" next to Female sends both, in the order ticked', async () => {
    await showRows();
    await pick(/^Gender/, 'Not tagged');
    fireEvent.click(screen.getByLabelText('Female'));
    await waitFor(() => expect(lastRequest().gender).toEqual(['UNKNOWN', 'F']));
  });

  it('search waits 350 ms after the last keystroke and then sends `q`', async () => {
    await showRows();
    const before = h.list.mock.calls.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const box = screen.getByPlaceholderText('Search candidate or role…');
    fireEvent.change(box, { target: { value: 'te' } });
    act(() => { vi.advanceTimersByTime(300); });
    fireEvent.change(box, { target: { value: 'tes' } });
    act(() => { vi.advanceTimersByTime(349); });
    expect(h.list).toHaveBeenCalledTimes(before);
    act(() => { vi.advanceTimersByTime(1); });
    vi.useRealTimers();
    await waitFor(() => expect(lastRequest()).toEqual({ ...BASE, q: 'tes' }));
    expect(h.list.mock.calls.slice(before).map(c => (c[0] as Record<string, unknown>).q)).toEqual(['tes']);
  });

  it('In-budget only hides candidates more than 15% over the band, without asking the server again', async () => {
    await showRows();
    const calls = h.list.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'In-budget only' }));
    expect(names()).toEqual(['Test Candidate A9002', 'Test Candidate A9003']);
    expect(h.list).toHaveBeenCalledTimes(calls);
  });

  it('arriving from a role page (?role_id=) filters to that role, says so, and "View all roles" takes the filter away', async () => {
    await showRows({ path: '/?role_id=R9002' });
    await waitFor(() => expect(lastRequest()).toEqual({ ...BASE, role_id: ['R9002'] }));
    expect(await screen.findByText('Test Role Beta', { selector: 'span.font-medium' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View all roles' }));
    await waitFor(() => expect(lastRequest()).toEqual(BASE));
  });
});

describe('Ready for Review — a Hiring Manager\'s own roles', () => {
  it('a Hiring Manager who owns no role sends the no-roles sentinel, never an empty filter (which would mean everyone)', async () => {
    h.persona = 'hiring_manager';
    mount({ scope: { ownRoleIds: [] } });
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    expect(lastRequest().role_id).toEqual(['__no_roles_owned__']);
  });

  it('their Role filter can only narrow their own roles: a role they do not own yields the sentinel, not that role', async () => {
    h.persona = 'hiring_manager';
    mount({ scope: { ownRoleIds: ['R9001'] } });
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    expect(lastRequest().role_id).toEqual(['R9001']);
    await pick(/^Role/, 'Test Role Beta');                                   // R9002 is not theirs
    await waitFor(() => expect(lastRequest().role_id).toEqual(['__no_roles_owned__']));
    fireEvent.click(screen.getByLabelText('Test Role Alpha'));               // R9001 is
    await waitFor(() => expect(lastRequest().role_id).toEqual(['R9001']));
  });
});

describe('Ready for Review — which rows can be acted on', () => {
  const MIXED = [R1, row('A9004', { stage: 'Interview Round 2' }), row('A9005', { stage: 'Joined' })];

  it('only Applied and Screened rows have a checkbox and the Reject / Hold / Shortlist buttons', async () => {
    h.list.mockResolvedValue({ data: { applications: MIXED } });
    await showRows();
    expect(within(rowOf('Test Candidate A9001')).getByRole('checkbox')).toBeInTheDocument();
    expect(within(rowOf('Test Candidate A9001')).getByTitle('Shortlist')).toBeInTheDocument();
    for (const name of ['Test Candidate A9004', 'Test Candidate A9005']) {
      expect(within(rowOf(name)).queryByRole('checkbox')).not.toBeInTheDocument();
      expect(within(rowOf(name)).queryByTitle('Shortlist')).not.toBeInTheDocument();
      expect(within(rowOf(name)).queryByTitle('Reject')).not.toBeInTheDocument();
      expect(within(rowOf(name)).queryByTitle('Hold for future roles')).not.toBeInTheDocument();
    }
  });

  it('the header checkbox selects only the Applied and Screened rows', async () => {
    h.list.mockResolvedValue({ data: { applications: MIXED } });
    await showRows();
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('with nothing at Applied and Screened there is no header checkbox at all', async () => {
    h.list.mockResolvedValue({ data: { applications: [row('A9004', { stage: 'Interview Round 2' })] } });
    mount();
    await screen.findByText('Test Candidate A9004');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('reports the number of rows that can be acted on to its parent (My Tasks badge)', async () => {
    const onCountChange = vi.fn();
    h.list.mockResolvedValue({ data: { applications: MIXED } });
    await showRows({ onCountChange });
    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(1));
  });
});

describe('Ready for Review — Shortlist, Hold for Future and Reject on one row', () => {
  it('Shortlist moves the application straight to Interview Round 1, says so, and reloads the list', async () => {
    await showRows();
    const calls = h.list.mock.calls.length;
    fireEvent.click(within(rowOf('Test Candidate A9003')).getByTitle('Shortlist'));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('Candidate shortlisted'));
    expect(h.advanceStage).toHaveBeenCalledTimes(1);
    expect(h.advanceStage).toHaveBeenCalledWith('A9003', 'Interview Round 1', NO_BUDGET);
    await waitFor(() => expect(h.list.mock.calls.length).toBeGreaterThan(calls));
  });

  it('a refused Shortlist shows the server\'s reason, or a generic one', async () => {
    h.advanceStage.mockImplementationOnce(async () => { throw { response: { data: { error: 'Only HR can do that' } } }; });
    await showRows();
    fireEvent.click(within(rowOf('Test Candidate A9003')).getByTitle('Shortlist'));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Only HR can do that'));
    h.advanceStage.mockImplementationOnce(async () => { throw new Error('boom'); });
    fireEvent.click(within(rowOf('Test Candidate A9003')).getByTitle('Shortlist'));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Action failed'));
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it('Hold for future puts the application on hold, says so, and reloads', async () => {
    await showRows();
    const calls = h.list.mock.calls.length;
    fireEvent.click(within(rowOf('Test Candidate A9002')).getByTitle('Hold for future roles'));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('Put on hold for future roles'));
    expect(h.updateStatus).toHaveBeenCalledWith('A9002', { new_status: 'Hold for Future' });
    await waitFor(() => expect(h.list.mock.calls.length).toBeGreaterThan(calls));
  });

  it('a refused Hold shows the server\'s reason, or a generic one', async () => {
    h.updateStatus.mockImplementationOnce(async () => { throw { response: { data: { error: 'Not allowed' } } }; });
    await showRows();
    fireEvent.click(within(rowOf('Test Candidate A9002')).getByTitle('Hold for future roles'));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Not allowed'));
    h.updateStatus.mockImplementationOnce(async () => { throw new Error('boom'); });
    fireEvent.click(within(rowOf('Test Candidate A9002')).getByTitle('Hold for future roles'));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Action failed'));
  });

  it('Reject opens the reason dialog for that one candidate; it cannot be confirmed without a reason', async () => {
    await showRows();
    fireEvent.click(within(rowOf('Test Candidate A9002')).getByTitle('Reject'));
    const modal = modalOf('Reject candidate');
    expect(within(modal).getByRole('button', { name: 'Reject' })).toBeDisabled();
    expect(h.updateStatus).not.toHaveBeenCalled();
    for (const r of REJECTION_REASONS) expect(within(modal).getByLabelText(r)).toBeInTheDocument();
  });

  it('Reject with several reasons sends the list, the older joined string and the trimmed detail, then reports "1 of 1 rejected"', async () => {
    await showRows();
    fireEvent.click(within(rowOf('Test Candidate A9002')).getByTitle('Reject'));
    const modal = modalOf('Reject candidate');
    fireEvent.click(within(modal).getByLabelText('Missing mandatory skill'));
    fireEvent.click(within(modal).getByLabelText('Short average tenure'));
    fireEvent.change(within(modal).getByPlaceholderText('Optional context…'), { target: { value: '  thin on depth  ' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('1 of 1 rejected'));
    expect(h.updateStatus).toHaveBeenCalledWith('A9002', {
      new_status: 'Rejected', rejection_reason_cats: ['Missing mandatory skill', 'Short average tenure'],
      rejection_reason_cat: 'Missing mandatory skill; Short average tenure', rejection_reason_detail: 'thin on depth',
    });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Reject candidate' })).not.toBeInTheDocument());
  });

  it('Cancel on the reason dialog rejects nobody', async () => {
    await showRows();
    fireEvent.click(within(rowOf('Test Candidate A9002')).getByTitle('Reject'));
    fireEvent.click(within(modalOf('Reject candidate')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Reject candidate' })).not.toBeInTheDocument();
    expect(h.updateStatus).not.toHaveBeenCalled();
  });
});

describe('Ready for Review — the over-budget reason when shortlisting', () => {
  it('a 15%+ over-budget row opens the reason dialog FIRST and moves nothing until it is confirmed', async () => {
    await showRows();
    fireEvent.click(within(rowOf('Test Candidate A9001')).getByTitle('Shortlist'));
    const modal = modalOf('This candidate is 15%+ over budget');
    expect(h.advanceStage).not.toHaveBeenCalled();
    expect(within(modal).getByRole('button', { name: 'Shortlist' })).toBeDisabled();
    fireEvent.click(within(modal).getByRole('button', { name: 'Shortlist' }));
    expect(h.advanceStage).not.toHaveBeenCalled();
  });

  it('confirming sends the reason and the trimmed detail with the move to Interview Round 1, then closes the dialog', async () => {
    await showRows();
    fireEvent.click(within(rowOf('Test Candidate A9001')).getByTitle('Shortlist'));
    const modal = modalOf('This candidate is 15%+ over budget');
    fireEvent.change(within(modal).getByDisplayValue('Select reason'), { target: { value: OVER_BUDGET_SHORTLIST_REASONS[3] } });
    fireEvent.change(within(modal).getByPlaceholderText('Optional context…'), { target: { value: '  founders agreed  ' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Shortlist' }));
    await waitFor(() => expect(h.advanceStage).toHaveBeenCalledTimes(1));
    expect(h.advanceStage).toHaveBeenCalledWith('A9001', 'Interview Round 1', {
      budgetExceptionReasonCat: OVER_BUDGET_SHORTLIST_REASONS[3], budgetExceptionReasonDetail: 'founders agreed',
    });
    await waitFor(() => expect(screen.queryByRole('heading', { name: /15%\+ over budget/ })).not.toBeInTheDocument());
    expect(h.toastSuccess).toHaveBeenCalledWith('Candidate shortlisted');
  });

  it('Cancel on the reason dialog sends nothing', async () => {
    await showRows();
    fireEvent.click(within(rowOf('Test Candidate A9001')).getByTitle('Shortlist'));
    fireEvent.click(within(modalOf('This candidate is 15%+ over budget')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: /15%\+ over budget/ })).not.toBeInTheDocument();
    expect(h.advanceStage).not.toHaveBeenCalled();
  });

  it('a row that is over the band but not 15%+ over goes straight through, with no reason', async () => {
    h.list.mockResolvedValue({ data: { applications: [row('A9006', { candidate_expected_ctc: 16, is_severely_over_budget: false })] } });
    mount();
    await screen.findByText('Test Candidate A9006');
    fireEvent.click(within(rowOf('Test Candidate A9006')).getByTitle('Shortlist'));
    await waitFor(() => expect(h.advanceStage).toHaveBeenCalledWith('A9006', 'Interview Round 1', NO_BUDGET));
    expect(screen.queryByRole('heading', { name: /15%\+ over budget/ })).not.toBeInTheDocument();
  });

  it('the server\'s flag decides, not the band: a row whose band was stripped for this persona still asks for the reason', async () => {
    h.persona = 'hiring_manager';
    h.list.mockResolvedValue({ data: { applications: [row('A9007', { role_ctc_band: undefined, candidate_expected_ctc: undefined, is_severely_over_budget: true })] } });
    mount({ scope: { ownRoleIds: ['R9001'] } });
    await screen.findByText('Test Candidate A9007');
    fireEvent.click(within(rowOf('Test Candidate A9007')).getByTitle('Shortlist'));
    expect(modalOf('This candidate is 15%+ over budget')).toBeInTheDocument();
    expect(h.advanceStage).not.toHaveBeenCalled();
  });
});

describe('Ready for Review — acting on a selection', () => {
  it('shows the bar with Shortlist, Hold for Future and Reject once something is ticked', async () => {
    await showRows();
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    tick('Test Candidate A9002'); tick('Test Candidate A9003');
    const b = bar(2);
    expect(within(b).getByRole('button', { name: 'Shortlist' })).toBeInTheDocument();
    expect(within(b).getByRole('button', { name: 'Hold for Future' })).toBeInTheDocument();
    expect(within(b).getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('bulk Shortlist moves each selected application to Interview Round 1 and reports "N of M shortlisted"', async () => {
    await showRows();
    tick('Test Candidate A9002'); tick('Test Candidate A9003');
    fireEvent.click(within(bar(2)).getByRole('button', { name: 'Shortlist' }));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('2 of 2 shortlisted'));
    expect(h.advanceStage).toHaveBeenCalledTimes(2);
    expect(h.advanceStage).toHaveBeenCalledWith('A9002', 'Interview Round 1', NO_BUDGET);
    expect(h.advanceStage).toHaveBeenCalledWith('A9003', 'Interview Round 1', NO_BUDGET);
    await waitFor(() => expect(screen.queryByText(/selected$/)).not.toBeInTheDocument());
  });

  it('a selection containing a 15%+ over-budget candidate asks once for a reason that then applies to every one of them', async () => {
    await showRows();
    tick('Test Candidate A9001'); tick('Test Candidate A9002');
    fireEvent.click(within(bar(2)).getByRole('button', { name: 'Shortlist' }));
    const modal = modalOf('2 candidates are 15%+ over budget');
    expect(h.advanceStage).not.toHaveBeenCalled();
    fireEvent.change(within(modal).getByDisplayValue('Select reason'), { target: { value: OVER_BUDGET_SHORTLIST_REASONS[1] } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Shortlist' }));
    await waitFor(() => expect(h.advanceStage).toHaveBeenCalledTimes(2));
    const opts = { budgetExceptionReasonCat: OVER_BUDGET_SHORTLIST_REASONS[1], budgetExceptionReasonDetail: '' };
    expect(h.advanceStage).toHaveBeenCalledWith('A9001', 'Interview Round 1', opts);
    expect(h.advanceStage).toHaveBeenCalledWith('A9002', 'Interview Round 1', opts);
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('2 of 2 shortlisted'));
  });

  it('bulk Hold for Future puts each selected application on hold and reports "N of M put on hold"', async () => {
    await showRows();
    tick('Test Candidate A9002'); tick('Test Candidate A9003');
    fireEvent.click(within(bar(2)).getByRole('button', { name: 'Hold for Future' }));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('2 of 2 put on hold'));
    expect(h.updateStatus).toHaveBeenCalledWith('A9002', { new_status: 'Hold for Future' });
    expect(h.updateStatus).toHaveBeenCalledWith('A9003', { new_status: 'Hold for Future' });
  });

  it('bulk Reject sends every ticked reason to each application, and the e-mail is addressed to each candidate by name and role', async () => {
    h.updateStatus.mockImplementation(async (id: string) => ({ data: { email: { sent: id !== 'A9003' } } }));
    await showRows();
    tick('Test Candidate A9002'); tick('Test Candidate A9003');
    fireEvent.click(within(bar(2)).getByRole('button', { name: 'Reject' }));
    const modal = modalOf('Reject 2 candidates');
    fireEvent.click(within(modal).getByLabelText('Communication gap'));
    fireEvent.click(within(modal).getByLabelText('Compensation mismatch'));
    fireEvent.click(within(modal).getByLabelText('Send rejection email to candidates'));
    const body = within(modal).getByDisplayValue(/^Hi \{\{candidate_name\}\}/) as HTMLTextAreaElement;
    for (const r of ['Communication gap', 'Compensation mismatch']) expect(body.value.toLowerCase()).not.toContain(r.toLowerCase());
    fireEvent.click(within(modal).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledTimes(2));
    const sent = (id: string) => h.updateStatus.mock.calls.find(c => c[0] === id)![1] as Record<string, unknown>;
    expect(sent('A9002')).toMatchObject({
      new_status: 'Rejected', rejection_reason_cats: ['Communication gap', 'Compensation mismatch'],
      rejection_reason_cat: 'Communication gap; Compensation mismatch', send_rejection_email: true,
    });
    expect(sent('A9002').rejection_email_subject).toBe('Update on your application — Test Role Beta');
    expect(sent('A9002').rejection_email_body).toContain('Hi Test Candidate A9002,');
    expect(sent('A9003').rejection_email_subject).toBe('Update on your application — Test Role Alpha');
    expect(sent('A9003').rejection_email_body).toContain('Hi Test Candidate A9003,');
    expect(sent('A9003').rejection_email_body as string).not.toContain('{{');
    await waitFor(() => expect(h.toastSuccess.mock.calls.concat(h.toastError.mock.calls).map(c => c[0])).toContain('2 of 2 rejected — 1 of 2 emails sent'));
  });

  it('bulk Reject without the e-mail ticked sends no e-mail fields and reports only the rejections', async () => {
    await showRows();
    tick('Test Candidate A9002');
    fireEvent.click(within(bar(1)).getByRole('button', { name: 'Reject' }));
    const modal = modalOf('Reject candidate');
    fireEvent.click(within(modal).getByLabelText('Communication gap'));
    fireEvent.click(within(modal).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('1 of 1 rejected'));
    const sent = h.updateStatus.mock.calls[0][1] as Record<string, unknown>;
    expect(sent.send_rejection_email).toBeUndefined();
    expect(sent.rejection_email_subject).toBeUndefined();
    expect(sent.rejection_email_body).toBeUndefined();
  });

  it('when some of a selection fail it reports how many worked, as an error', async () => {
    h.advanceStage.mockImplementation(async (id: string) => { if (id === 'A9003') throw new Error('refused'); return { data: {} }; });
    await showRows();
    tick('Test Candidate A9002'); tick('Test Candidate A9003');
    fireEvent.click(within(bar(2)).getByRole('button', { name: 'Shortlist' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('1 of 2 shortlisted'));
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it('works three at a time: the fourth waits for the first batch', async () => {
    const four = ['A9011', 'A9012', 'A9013', 'A9014'].map(id => row(id));
    h.list.mockResolvedValue({ data: { applications: four } });
    const gates: Record<string, () => void> = {};
    h.updateStatus.mockImplementation((id: string) => new Promise(res => { gates[id] = () => res({ data: {} }); }));
    mount();
    await screen.findByText('Test Candidate A9011');
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(within(bar(4)).getByRole('button', { name: 'Hold for Future' }));
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledTimes(3));
    expect(h.updateStatus.mock.calls.map(c => c[0])).toEqual(['A9011', 'A9012', 'A9013']);
    await act(async () => { await Promise.resolve(); });
    expect(h.updateStatus).toHaveBeenCalledTimes(3);
    gates.A9011(); gates.A9012(); gates.A9013();
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledTimes(4));
    gates.A9014();
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('4 of 4 put on hold'));
  });

  it('while a bulk action runs, the bar buttons are disabled so it cannot be started twice', async () => {
    h.updateStatus.mockImplementation(() => new Promise(() => {}));
    await showRows();
    tick('Test Candidate A9002');
    fireEvent.click(within(bar(1)).getByRole('button', { name: 'Hold for Future' }));
    await waitFor(() => expect(within(bar(1)).getByRole('button', { name: 'Hold for Future' })).toBeDisabled());
    expect(within(bar(1)).getByRole('button', { name: 'Reject' })).toBeDisabled();
  });
});

describe('Ready for Review — a selection only ever acts on the rows still on screen', () => {
  it('a ticked row that a filter has since hidden is neither counted nor acted on, and does not trigger the over-budget reason', async () => {
    await showRows();
    tick('Test Candidate A9001'); tick('Test Candidate A9002');              // A9001 is the 15%+ over-budget one
    fireEvent.click(screen.getByRole('button', { name: 'In-budget only' }));  // hides A9001
    expect(screen.queryByText('Test Candidate A9001')).not.toBeInTheDocument();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(within(bar(1)).getByRole('button', { name: 'Shortlist' }));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('Candidate shortlisted'));
    expect(h.advanceStage).toHaveBeenCalledTimes(1);
    expect(h.advanceStage).toHaveBeenCalledWith('A9002', 'Interview Round 1', NO_BUDGET);
    expect(screen.queryByRole('heading', { name: /15%\+ over budget/ })).not.toBeInTheDocument();
  });

  it('the same holds for bulk Reject: the hidden row is not rejected', async () => {
    await showRows();
    tick('Test Candidate A9001'); tick('Test Candidate A9002');
    fireEvent.click(screen.getByRole('button', { name: 'In-budget only' }));
    fireEvent.click(within(bar(1)).getByRole('button', { name: 'Reject' }));
    const modal = modalOf('Reject candidate');
    fireEvent.click(within(modal).getByLabelText('Communication gap'));
    fireEvent.click(within(modal).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledTimes(1));
    expect(h.updateStatus.mock.calls[0][0]).toBe('A9002');
  });
});

describe('Ready for Review — the retry-scoring banner', () => {
  const UNSCORED = [row('A9021', { score_avg: null }), row('A9022', { score_avg: null, stage: 'Interview Round 2' }), row('A9023')];

  it('HR-tier personas see how many candidates have no ResumeIQ score, and Retry scoring retries exactly those', async () => {
    h.list.mockResolvedValue({ data: { applications: UNSCORED } });
    mount();
    expect(await screen.findByText(/2 candidates without a ResumeIQ score/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry scoring' }));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('2 of 2 retried'));
    expect(h.retryScoring.mock.calls.map(c => c[0]).sort()).toEqual(['A9021', 'A9022']);
  });

  it('says "1 candidate" for one', async () => {
    h.list.mockResolvedValue({ data: { applications: [UNSCORED[0], UNSCORED[2]] } });
    mount();
    expect(await screen.findByText(/^1 candidate without a ResumeIQ score/)).toBeInTheDocument();
  });

  it('is absent when every row is scored', async () => {
    await showRows();
    expect(screen.queryByRole('button', { name: 'Retry scoring' })).not.toBeInTheDocument();
  });

  it('a Hiring Manager never sees it, whatever is unscored', async () => {
    h.persona = 'hiring_manager';
    h.list.mockResolvedValue({ data: { applications: UNSCORED } });
    mount({ scope: { ownRoleIds: ['R9001'] } });
    await screen.findByText('Test Candidate A9021');
    expect(screen.queryByRole('button', { name: 'Retry scoring' })).not.toBeInTheDocument();
    expect(screen.queryByText(/without a ResumeIQ score/)).not.toBeInTheDocument();
  });

  it('a partly failed retry is reported as an error with the real count', async () => {
    h.retryScoring.mockImplementation(async (id: string) => { if (id === 'A9022') throw new Error('x'); return { data: {} }; });
    h.list.mockResolvedValue({ data: { applications: UNSCORED } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry scoring' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('1 of 2 retried'));
  });
});

describe('Ready for Review — what each persona is given', () => {
  it.each(['hr_recruiter', 'hiring_manager', 'leadership', 'super_admin'] as const)('%s can Shortlist, Hold and Reject (these are open to every persona)', async persona => {
    h.persona = persona;
    await showRows(persona === 'hiring_manager' ? { scope: { ownRoleIds: ['R9001', 'R9002'] } } : {});
    const r = within(rowOf('Test Candidate A9003'));
    expect(r.getByTitle('Shortlist')).toBeInTheDocument();
    expect(r.getByTitle('Hold for future roles')).toBeInTheDocument();
    expect(r.getByTitle('Reject')).toBeInTheDocument();
    expect(r.getByRole('checkbox')).toBeInTheDocument();
  });

  it('a Hiring Manager gets a plain stage badge, never a button that edits the stage', async () => {
    h.persona = 'hiring_manager';
    await showRows({ scope: { ownRoleIds: ['R9001', 'R9002'] } });
    const cell = within(rowOf('Test Candidate A9003')).getByText('Applied and Screened');
    expect(cell.closest('button')).toBeNull();
  });

  it.each(['leadership', 'super_admin'] as const)('%s gets a stage button that opens the stage dialog for that application', async persona => {
    h.persona = persona;
    await showRows();
    const badge = within(rowOf('Test Candidate A9003')).getByText('Applied and Screened');
    expect(badge.closest('button')).not.toBeNull();
    fireEvent.click(badge);
    const modal = modalOf('Update stage');
    expect((within(modal).getByDisplayValue('Applied and Screened') as HTMLSelectElement).value).toBe('Applied and Screened');
    fireEvent.change(within(modal).getByRole('combobox'), { target: { value: 'Interview Round 2' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(h.advanceStage).toHaveBeenCalledWith('A9003', 'Interview Round 2', NO_BUDGET));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Update stage' })).not.toBeInTheDocument());
  });

  it('the stage dialog opened from a row asks for the over-budget reason when a 15%+ over-budget row is moved to Interview Round 1', async () => {
    h.persona = 'leadership';
    await showRows();
    fireEvent.click(within(rowOf('Test Candidate A9001')).getByText('Applied and Screened'));
    const modal = modalOf('Update stage');
    fireEvent.change(within(modal).getByRole('combobox'), { target: { value: 'Interview Round 1' } });
    expect(within(modal).getByRole('button', { name: 'Update' })).toBeDisabled();
    expect(within(modal).getByText(/15%\+ over the role's compensation band/)).toBeInTheDocument();
  });
});

describe('Ready for Review — the list, sorting and states', () => {
  it('Average Score sorts highest first and then lowest first; Application Age sorts by the application date, newest application first and then oldest', async () => {
    await showRows();
    fireEvent.click(screen.getByRole('button', { name: 'Average Score' }));
    expect(names()).toEqual(['Test Candidate A9001', 'Test Candidate A9003', 'Test Candidate A9002']);
    fireEvent.click(screen.getByRole('button', { name: 'Average Score' }));
    expect(names()).toEqual(['Test Candidate A9002', 'Test Candidate A9003', 'Test Candidate A9001']);
    fireEvent.click(screen.getByRole('button', { name: 'Application Age' }));          // by date: 10-10, 10-05, 10-01
    expect(names()).toEqual(['Test Candidate A9002', 'Test Candidate A9003', 'Test Candidate A9001']);
    fireEvent.click(screen.getByRole('button', { name: 'Application Age' }));
    expect(names()).toEqual(['Test Candidate A9001', 'Test Candidate A9003', 'Test Candidate A9002']);
  });

  it('the Highlights toggle opens strengths, red flags and the summary for that row only', async () => {
    h.list.mockResolvedValue({ data: { applications: [
      row('A9031', { score_strengths: ['Clear ownership'], score_red_flags: ['Short stints'], score_summary: 'Test summary text.' }), row('A9032'),
    ] } });
    mount();
    await screen.findByText('Test Candidate A9031');
    expect(screen.queryByText('Test summary text.')).not.toBeInTheDocument();
    fireEvent.click(within(rowOf('Test Candidate A9031').nextElementSibling as HTMLElement).getByRole('button', { name: 'View Highlights and Summary' }));
    expect(screen.getByText('• Clear ownership')).toBeInTheDocument();
    expect(screen.getByText('• Short stints')).toBeInTheDocument();
    expect(screen.getByText('Test summary text.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'View Highlights and Summary' })).toHaveLength(1);   // the other row's is still closed
    fireEvent.click(screen.getByRole('button', { name: 'Hide Highlights and Summary' }));
    expect(screen.queryByText('Test summary text.')).not.toBeInTheDocument();
  });

  it('shows the loading spinner (and no table) while the list is on its way', async () => {
    h.list.mockReturnValue(new Promise(() => {}));
    mount();
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    expect(document.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('with no filters and no rows it says nothing has been scored yet', async () => {
    h.list.mockResolvedValue({ data: { applications: [] } });
    mount();
    expect(await screen.findByText('No scored candidates yet')).toBeInTheDocument();
  });

  it('with a filter on and no rows it says no candidate matches the filters', async () => {
    h.list.mockResolvedValue({ data: { applications: [] } });
    mount();
    await screen.findByText('No scored candidates yet');
    await pick(/^Department/, 'Tech/Devs');
    expect(await screen.findByText('No scored candidates match these filters')).toBeInTheDocument();
  });

  it('a failed list request does not crash the page: the filters stay and no rows are invented', async () => {
    h.list.mockImplementation(async () => { throw new Error('network down'); });
    mount();
    await waitFor(() => expect(document.querySelector('.animate-spin')).toBeNull());
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Department/ })).toBeInTheDocument();
  });
});
