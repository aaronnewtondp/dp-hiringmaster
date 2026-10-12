import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The "Portfolio >= 7.5" filter in Ready for Review: only offered where it can match (a role that gets a portfolio review),
// applied server-side, and never silently applied while hidden.
const list = vi.fn();
const roles = vi.fn();
vi.mock('../services/api.ts', () => ({
  applicationsApi: { list: (p: unknown) => list(p) },
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

beforeEach(() => {
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
});
