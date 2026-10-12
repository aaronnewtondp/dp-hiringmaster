import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The "Portfolio >= 7.5" filter in Ready for Review: only offered where it can match (a role that gets a portfolio review),
// applied server-side, and never silently applied while hidden.
const list = vi.fn();
const roles = vi.fn();
const advanceStage = vi.fn();
const updateStatus = vi.fn();
vi.mock('../services/api.ts', () => ({
  applicationsApi: {
    list: (p: unknown) => list(p),
    advanceStage: (...a: unknown[]) => advanceStage(...a),
    updateStatus: (...a: unknown[]) => updateStatus(...a),
    retryScoring: vi.fn(),
  },
  rolesApi: { filterOptions: () => roles() },
}));
vi.mock('../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ canLead: true, canHR: true }) }));

import ScorecardSummary from './ScorecardSummary.tsx';

const ROLE_OPTIONS = { data: { recruitment_modes: [], roles: [
  { id: 'R007', title: 'Senior UX/Product Designer', portfolio_analysis_enabled: true },
  { id: 'R006', title: 'Senior Product Manager', portfolio_analysis_enabled: false },
] } };

function mount(scope?: Parameters<typeof ScorecardSummary>[0]['personaScope']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ScorecardSummary personaScope={scope} /></MemoryRouter></QueryClientProvider>);
}
const lastRequest = () => list.mock.calls[list.mock.calls.length - 1][0] as Record<string, unknown>;
const toggle = () => screen.queryByRole('button', { name: /Portfolio ≥/ });
const remember = (key: string, value: unknown) => sessionStorage.setItem(`hms:${key}`, JSON.stringify(value));

const row = (id: string, name: string, portfolio: number | null) => ({
  id, candidate_id: `C-${id}`, candidate_name: name, email: `${id}@example.com`, role_id: 'R007', role_title: 'Senior UX/Product Designer',
  stage: 'Applied and Screened', status: 'Active', score_avg: 7, ai_fit_score: 70, score_portfolio: portfolio, portfolio_analysis_status: portfolio == null ? null : 'completed',
  application_date: '2026-10-01T00:00:00Z',
});

beforeEach(() => {
  advanceStage.mockReset(); updateStatus.mockReset();
  advanceStage.mockResolvedValue({ data: {} }); updateStatus.mockResolvedValue({ data: {} });
  list.mockReset(); roles.mockReset(); sessionStorage.clear();
  list.mockResolvedValue({ data: { applications: [] } });
  roles.mockResolvedValue(ROLE_OPTIONS);
});

describe('Ready for Review — Portfolio ≥ 7.5 filter', () => {
  it('is offered when no role is picked, off by default, and sends nothing', async () => {
    mount();
    const btn = await screen.findByRole('button', { name: 'Portfolio ≥ 7.5' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(lastRequest().min_portfolio_score).toBeUndefined();
  });

  it('turning it on asks the server for scores of 7.5 or more, and turning it off stops asking', async () => {
    mount();
    const btn = await screen.findByRole('button', { name: 'Portfolio ≥ 7.5' });
    fireEvent.click(btn);
    await waitFor(() => expect(lastRequest().min_portfolio_score).toBe('7.5'));
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(btn);
    await waitFor(() => expect(lastRequest().min_portfolio_score).toBeUndefined());
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('says what it does, including that scores are whole numbers (so 7.5 means 8+) and that unscored candidates are hidden', async () => {
    mount();
    const btn = await screen.findByRole('button', { name: 'Portfolio ≥ 7.5' });
    expect(btn.getAttribute('title')).toMatch(/7\.5 or higher/);
    expect(btn.getAttribute('title')).toMatch(/whole numbers/);
    expect(btn.getAttribute('title')).toMatch(/8 or more/);
    expect(btn.getAttribute('title')).toMatch(/without a portfolio score are hidden/);
  });

  it('is offered when the Role filter includes the portfolio role (alone or with others)', async () => {
    remember('scorecard.roleIds', ['R007']);
    const first = mount();
    expect(await screen.findByRole('button', { name: 'Portfolio ≥ 7.5' })).toBeInTheDocument();
    first.unmount();
    remember('scorecard.roleIds', ['R006', 'R007']);
    mount();
    expect(await screen.findByRole('button', { name: 'Portfolio ≥ 7.5' })).toBeInTheDocument();
  });

  it('is not offered when the Role filter is narrowed to roles that have no portfolio review', async () => {
    remember('scorecard.roleIds', ['R006']);
    mount();
    await waitFor(() => expect(roles).toHaveBeenCalled());
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(toggle()).not.toBeInTheDocument();
  });

  it('a remembered "on" is NOT applied while the control is hidden (no invisible filter)', async () => {
    remember('scorecard.portfolioHigh', true);
    remember('scorecard.roleIds', ['R006']);
    mount();
    await waitFor(() => expect(roles).toHaveBeenCalled());
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(0));
    // every request made while R006 is selected must lack the filter, before and after the role options arrive
    for (const [req] of list.mock.calls) expect((req as Record<string, unknown>).min_portfolio_score).toBeUndefined();
    expect(toggle()).not.toBeInTheDocument();
  });

  it('a remembered "on" is applied once the control is shown', async () => {
    remember('scorecard.portfolioHigh', true);
    mount();
    const btn = await screen.findByRole('button', { name: 'Portfolio ≥ 7.5' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(lastRequest().min_portfolio_score).toBe('7.5'));
  });

  it('is not offered when no role has portfolio review at all', async () => {
    roles.mockResolvedValue({ data: { recruitment_modes: [], roles: [{ id: 'R006', title: 'Senior Product Manager', portfolio_analysis_enabled: false }] } });
    mount();
    await waitFor(() => expect(roles).toHaveBeenCalled());
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(toggle()).not.toBeInTheDocument();
  });

  it('a role list from an older server (no portfolio_analysis_enabled field) simply hides it', async () => {
    roles.mockResolvedValue({ data: { recruitment_modes: [], roles: [{ id: 'R007', title: 'Senior UX/Product Designer' }] } });
    mount();
    await waitFor(() => expect(roles).toHaveBeenCalled());
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(toggle()).not.toBeInTheDocument();
  });

  it('a Hiring Manager is only offered it when one of their own roles has portfolio review', async () => {
    const hm006 = mount({ ownRoleIds: ['R006'] });
    await waitFor(() => expect(roles).toHaveBeenCalled());
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(toggle()).not.toBeInTheDocument();
    hm006.unmount();
    mount({ ownRoleIds: ['R007'] });
    expect(await screen.findByRole('button', { name: 'Portfolio ≥ 7.5' })).toBeInTheDocument();
  });

  it('combines with the other filters rather than replacing them', async () => {
    remember('scorecard.roleIds', ['R007']);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Portfolio ≥ 7.5' }));
    await waitFor(() => expect(lastRequest().min_portfolio_score).toBe('7.5'));
    expect(lastRequest().role_id).toEqual(['R007']);
    expect(lastRequest().status).toEqual(['Active']);
  });

  it('with the filter on and nothing matching, the empty state says filters are active (not "no scored candidates yet")', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Portfolio ≥ 7.5' }));
    expect(await screen.findByText('No scored candidates match these filters')).toBeInTheDocument();
  });
  it('a Hiring Manager\'s own roles are intersected with the Role filter, exactly like the request: picking a role that is not theirs does not offer it', async () => {
    remember('scorecard.roleIds', ['R007']);                       // R007 has portfolio review, but is not one of this manager's roles
    const first = mount({ ownRoleIds: ['R006'] });
    await waitFor(() => expect(roles).toHaveBeenCalled());
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(toggle()).not.toBeInTheDocument();
    first.unmount();
    sessionStorage.clear();
    remember('scorecard.roleIds', ['R006']);                       // their own role, but without portfolio review
    mount({ ownRoleIds: ['R006', 'R007'] });
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(toggle()).not.toBeInTheDocument();
  });

  it('says in the page what the filter is doing — whole-number scores, and that candidates without a portfolio score are hidden — and can be turned off from there', async () => {
    mount();
    expect(screen.queryByTestId('portfolio-filter-note')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Portfolio ≥ 7.5' }));
    const note = await screen.findByTestId('portfolio-filter-note');
    expect(note).toHaveTextContent(/7\.5 or higher/);
    expect(note).toHaveTextContent(/8 or more/);
    expect(note).toHaveTextContent(/without a portfolio score/);
    expect(note).toHaveTextContent(/other role's/);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(screen.queryByTestId('portfolio-filter-note')).not.toBeInTheDocument());
    await waitFor(() => expect(lastRequest().min_portfolio_score).toBeUndefined());
  });

  it('a remembered "on" waits for the role options instead of fetching (and flashing) the unfiltered list first', async () => {
    remember('scorecard.portfolioHigh', true);
    let resolveRoles!: (v: unknown) => void;
    roles.mockReturnValue(new Promise(r => { resolveRoles = r; }));
    mount();
    await waitFor(() => expect(roles).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 50));
    expect(list).not.toHaveBeenCalled();                          // nothing fetched while it is unknown whether the filter applies
    resolveRoles(ROLE_OPTIONS);
    await waitFor(() => expect(list).toHaveBeenCalled());
    for (const [req] of list.mock.calls) expect((req as Record<string, unknown>).min_portfolio_score).toBe('7.5');   // the FIRST request already carries it
  });

  it('a remembered "off" never waits: the list loads without the role options', async () => {
    let resolveRoles!: (v: unknown) => void;
    roles.mockReturnValue(new Promise(r => { resolveRoles = r; }));
    mount();
    await waitFor(() => expect(list).toHaveBeenCalled());
    resolveRoles(ROLE_OPTIONS);
  });

  describe('bulk actions only ever touch candidates that are on screen', () => {
    const FOUR = [row('A1', 'Cand Ten', 10), row('A2', 'Cand Nine', 9), row('A3', 'Cand Seven', 7), row('A4', 'Cand None', null)];
    const TWO = FOUR.slice(0, 2);
    beforeEach(() => {
      list.mockImplementation((p: Record<string, unknown>) => Promise.resolve({ data: { applications: p.min_portfolio_score ? TWO : FOUR } }));
    });
    const selectAll = async () => {
      await screen.findByText('Cand None');
      fireEvent.click(screen.getAllByRole('checkbox')[0]);        // header checkbox
    };

    it('select all, then narrow the list: the bar counts only the visible selection', async () => {
      mount();
      await selectAll();
      expect(await screen.findByText('4 selected')).toBeInTheDocument();
      fireEvent.click(await screen.findByRole('button', { name: 'Portfolio ≥ 7.5' }));
      await waitFor(() => expect(screen.queryByText('Cand None')).not.toBeInTheDocument());
      expect(await screen.findByText('2 selected')).toBeInTheDocument();
      expect(screen.queryByText('4 selected')).not.toBeInTheDocument();
    });

    it('Shortlist then acts on the two visible candidates only, never the two hidden ones', async () => {
      mount();
      await selectAll();
      fireEvent.click(await screen.findByRole('button', { name: 'Portfolio ≥ 7.5' }));
      await screen.findByText('2 selected');
      fireEvent.click(within(screen.getByText('2 selected').parentElement!).getByRole('button', { name: /^Shortlist$/ }));
      await waitFor(() => expect(advanceStage).toHaveBeenCalledTimes(2));
      expect(advanceStage.mock.calls.map(c => c[0]).sort()).toEqual(['A1', 'A2']);
    });

    it('Hold for Future acts on the visible selection only', async () => {
      mount();
      await selectAll();
      fireEvent.click(await screen.findByRole('button', { name: 'Portfolio ≥ 7.5' }));
      await screen.findByText('2 selected');
      fireEvent.click(within(screen.getByText('2 selected').parentElement!).getByRole('button', { name: /Hold for Future/ }));
      await waitFor(() => expect(updateStatus).toHaveBeenCalledTimes(2));
      expect(updateStatus.mock.calls.map(c => c[0]).sort()).toEqual(['A1', 'A2']);
    });

    it('Reject opens for the visible selection only', async () => {
      mount();
      await selectAll();
      fireEvent.click(await screen.findByRole('button', { name: 'Portfolio ≥ 7.5' }));
      await screen.findByText('2 selected');
      fireEvent.click(within(screen.getByText('2 selected').parentElement!).getByRole('button', { name: /^Reject$/ }));
      expect(await screen.findByText(/Reject 2 candidates/i)).toBeInTheDocument();
    });
  });
});
