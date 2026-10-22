import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DashboardData } from '../types/index.ts';
import type { SourcingDashboard, SourcingDashboardRow } from '../types/sourcing.ts';

// The Dashboard keeps ONE Sourcing section — "Sourcing execution", the cross-role exceptions overview. One role's whole plan (the workspace) moved
// to its own page (sidebar → Sourcing). Everything else on the Dashboard is incidental here; the two sections with their own data calls are stubbed.
const dashboardGet = vi.fn();
const filterOptions = vi.fn();
const sourcingDashboard = vi.fn();
const workspaceCalls = vi.fn();
const planCalls = vi.fn();
vi.mock('../services/api.ts', () => ({
  dashboardApi: { get: (p: unknown) => dashboardGet(p) },
  rolesApi: { filterOptions: () => filterOptions() },
  sourcingApi: {
    dashboard: (p: unknown) => sourcingDashboard(p),
    // If the Dashboard ever mounted the workspace again it would call these — and the workspace answers "on" with a role, so it WOULD render.
    workspace: () => { workspaceCalls(); return Promise.resolve({ data: { enabled: true, read_only: false, roles: [{ role_id: 'R1', title: 'Role 1', priority: 'P1', plan_id: '1', plan_status: 'active', open_exceptions: 0, channels_live: 1, qualified: 6, target: 5, behind: false }], drafts: [] } }); },
    plan:      (id: string) => { planCalls(id); return Promise.resolve({ data: { enabled: false } }); },
    advice:    () => Promise.resolve({ data: { enabled: false } }),
  },
}));
vi.mock('../components/shared/HiringFunnelSnapshot.tsx', () => ({ default: () => <div data-testid="funnel-snapshot" /> }));
vi.mock('../components/shared/SlaBreachesByRole.tsx', () => ({ default: () => <div data-testid="sla-by-role" /> }));

let currentUser: { id: string; name: string; email: string; persona: string } = { id: 'u1', name: 'Aaron Newton', email: 'aaron.newton@digitalpaani.com', persona: 'hr_recruiter' };
vi.mock('../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ user: currentUser }) }));

import Dashboard from './Dashboard.tsx';

const dashboardData = (): { data: DashboardData } => ({
  data: {
    metrics: {
      open_roles_count: 7, open_roles_by_priority: { P0: 2, P1: 3, P2: 1, P3: 1 }, avg_active_role_age_days: 12, avg_time_to_fill_days: 30, roles_filled_last_30d: 1,
      active_candidates: 120, candidates_score_ge_75: 10, candidates_score_le_45: 20, candidates_at_interview1_plus: 15, candidates_unmatched: 2,
      sla_breach_total: 0, sla_breach_by_owner: {}, sla_breach_top_type: null, sla_breach_top_stage: null, red_aging_roles: 0, joining_risk_count: 0,
    },
    hiring_funnel_snapshot: [], aging_roles: [], low_pipeline: [], roles_by_status: {}, hiring_funnel: [], rejected_by_stage: {}, source_quality: [],
    velocity: { interview_to_offer_ratio: null, interviewed_count: 0, offered_count: 0, tat_by_stage: [], biggest_drop_off: null, biggest_drop_off_by_rate: null },
  },
});

const row = (i: number, over: Partial<SourcingDashboardRow> = {}): SourcingDashboardRow => ({
  id: String(i), plan_id: String(i), role_id: `R${i}`, role_title: `Role ${i}`, priority: 'P1', channel: 'LinkedIn', type: 'CHANNEL_NOT_ACTIVATED', status: 'open',
  provisional: false, severity: 40, age_days: i, blocker_due: null,
  committed: `LinkedIn: Publish the posting (${i})`, happened: 'Not done — 2 days overdue', next_action: 'Publish on LinkedIn and mark it done', ...over,
});
const sourcingOn = (rows: SourcingDashboardRow[] = [row(1), row(2)]): { data: SourcingDashboard } => ({
  data: {
    enabled: true, read_only: false, provisional_until: null,
    summary: { open_roles: 14, plans_active: 6, plans_draft: 8, plans_paused: 0, commitments_done_14d: 10, on_time_pct_14d: 80, overdue_commitments: 3,
               exceptions_open: rows.length, exceptions_blocked: 0, exceptions_snoozed: 0, provisional_signals: 0, by_priority: { P1: rows.length } },
    exceptions: rows,
  },
});

function mount(entry = '/dashboard') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[entry]}><Dashboard /></MemoryRouter></QueryClientProvider>);
}
const scrollIntoView = vi.fn();

beforeEach(() => {
  dashboardGet.mockReset(); filterOptions.mockReset(); sourcingDashboard.mockReset(); workspaceCalls.mockReset(); planCalls.mockReset(); scrollIntoView.mockReset();
  sessionStorage.clear();
  Element.prototype.scrollIntoView = scrollIntoView;
  currentUser = { id: 'u1', name: 'Aaron Newton', email: 'aaron.newton@digitalpaani.com', persona: 'hr_recruiter' };
  dashboardGet.mockResolvedValue(dashboardData());
  filterOptions.mockResolvedValue({ data: { recruitment_modes: [], roles: [] } });
  sourcingDashboard.mockResolvedValue(sourcingOn());
});
afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });

const noWorkspace = (container: HTMLElement) => {
  expect(screen.queryByTestId('sourcing-workspace')).toBeNull();
  expect(container.querySelector('#sourcing-workspace')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Sourcing plans' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Sourcing plans' })).toBeNull();
  expect(screen.queryByText('Sourcing plans')).toBeNull();
  expect(screen.queryByTestId('plan-panel')).toBeNull();
};

describe('Dashboard — Sourcing: the plan workspace has moved to its own page', () => {
  it('with the module on, shows Sourcing execution and NOT the Sourcing workspace', async () => {
    const { container } = mount();
    expect(await screen.findByRole('heading', { level: 2, name: 'Sourcing execution' })).toBeInTheDocument();
    expect(await screen.findByText('Plans active')).toBeInTheDocument();           // the real SourcingExecution rendered its summary tile
    noWorkspace(container);
    expect(screen.queryByRole('group', { name: 'Roles with a sourcing plan' })).toBeNull();
    expect(screen.queryByTestId('role-pill-R1')).toBeNull();
  });

  it('never asks the workspace endpoint for anything (it is not mounted, not merely hidden)', async () => {
    mount();
    await screen.findByText('Plans active');
    await new Promise(r => setTimeout(r, 20));
    expect(workspaceCalls).not.toHaveBeenCalled();
    expect(planCalls).not.toHaveBeenCalled();
    expect(sourcingDashboard).toHaveBeenCalledTimes(1);
  });

  it('Sourcing execution is the last section of the page — nothing follows it', async () => {
    const { container } = mount();
    await screen.findByText('Plans active');
    const h2s = screen.getAllByRole('heading', { level: 2 });
    expect(h2s[h2s.length - 1]).toHaveTextContent('Sourcing execution');
    const root = container.firstElementChild as HTMLElement;                       // the page's own wrapper
    const last = root.lastElementChild as HTMLElement;
    expect(last).toContainElement(screen.getByRole('heading', { level: 2, name: 'Sourcing execution' }));
  });

  it('its exception rows lead to the Sourcing page, one role per link', async () => {
    mount();
    await screen.findByText('Plans active');
    expect(screen.getByRole('link', { name: 'Role 1' })).toHaveAttribute('href', '/sourcing?sourcing_role=R1');
    expect(screen.getByRole('link', { name: 'Role 2' })).toHaveAttribute('href', '/sourcing?sourcing_role=R2');
    for (const a of screen.getAllByRole('link')) expect(a.getAttribute('href')).not.toMatch(/^\/dashboard/);   // no link back into the Dashboard's old #sourcing-workspace
  });

  it('hands the dashboard\'s master filters to Sourcing execution', async () => {
    sessionStorage.setItem('hms:dashboard.priorities', JSON.stringify(['P0']));
    sessionStorage.setItem('hms:dashboard.departments', JSON.stringify(['Engineering']));
    mount();
    await screen.findByText('Plans active');
    expect(sourcingDashboard).toHaveBeenCalledWith({ department: ['Engineering'], priority: ['P0'] });
  });

  it('a legacy #sourcing-workspace hash on the Dashboard itself neither mounts the workspace nor scrolls (DashboardRoute redirects those before the Dashboard mounts)', async () => {
    const { container } = mount('/dashboard?sourcing_role=R1#sourcing-workspace');
    await screen.findByText('Plans active');
    await new Promise(r => setTimeout(r, 20));
    noWorkspace(container);
    expect(workspaceCalls).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('a Hiring Manager\'s Dashboard has no workspace either (and still shows their Sourcing execution)', async () => {
    currentUser = { id: 'u2', name: 'Alex Rivera', email: 'alex@digitalpaani.com', persona: 'hiring_manager' };
    sourcingDashboard.mockResolvedValue({ data: { ...sourcingOn().data, read_only: true } });
    const { container } = mount();
    expect(await screen.findByRole('heading', { level: 2, name: 'Sourcing execution' })).toBeInTheDocument();
    await screen.findByText('Plans active');
    noWorkspace(container);
    expect(workspaceCalls).not.toHaveBeenCalled();
  });
});

describe('Dashboard — Sourcing: module off or unavailable', () => {
  it('with the module off, shows no Sourcing section at all and the rest of the Dashboard is untouched', async () => {
    sourcingDashboard.mockResolvedValue({ data: { enabled: false } });
    const { container } = mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    await waitFor(() => expect(sourcingDashboard).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByText('Sourcing execution')).toBeNull();
    expect(screen.queryByText('Plans active')).toBeNull();
    noWorkspace(container);
    expect(workspaceCalls).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Operational velocity' })).toBeInTheDocument();
    expect(screen.getByTestId('funnel-snapshot')).toBeInTheDocument();
    expect(screen.getByTestId('sla-by-role')).toBeInTheDocument();
  });

  it('when Sourcing execution cannot load, it says so in its own section and the workspace still does not appear', async () => {
    sourcingDashboard.mockRejectedValue(new Error('boom'));
    const { container } = mount();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load sourcing execution.");
    expect(screen.getByRole('heading', { level: 2, name: 'Sourcing execution' })).toBeInTheDocument();
    noWorkspace(container);
    expect(workspaceCalls).not.toHaveBeenCalled();
  });
});
