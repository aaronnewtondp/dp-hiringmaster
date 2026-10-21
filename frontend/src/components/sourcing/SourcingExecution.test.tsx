import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SourcingDashboard, SourcingDashboardRow } from '../../types/sourcing.ts';

const dashboard = vi.fn();
vi.mock('../../services/api.ts', () => ({ sourcingApi: { dashboard: (p: unknown) => dashboard(p) } }));

import SourcingExecution from './SourcingExecution.tsx';

const row = (i: number, over: Partial<SourcingDashboardRow> = {}): SourcingDashboardRow => ({
  id: String(i), plan_id: String(i), role_id: `R${i}`, role_title: `Role ${i}`, priority: 'P1', channel: 'LinkedIn', type: 'CHANNEL_NOT_ACTIVATED', status: 'open',
  provisional: false, severity: 40, age_days: i, blocker_due: null,
  committed: `LinkedIn: Publish the posting (${i})`, happened: 'Not done — 2 days overdue', next_action: 'Publish on LinkedIn and mark it done', ...over,
});
const payload = (over: Partial<SourcingDashboard> = {}, rows: SourcingDashboardRow[] = [row(1)]): SourcingDashboard => ({
  enabled: true, read_only: false, provisional_until: '2026-11-25',
  summary: { open_roles: 14, plans_active: 6, plans_draft: 8, plans_paused: 0, commitments_done_14d: 10, on_time_pct_14d: 80, overdue_commitments: 3,
             exceptions_open: rows.filter(r => !r.provisional).length, exceptions_blocked: 0, exceptions_snoozed: 0,
             provisional_signals: rows.filter(r => r.provisional).length, by_priority: { P1: 1 } },
  exceptions: rows, ...over,
});
function mount(data: unknown, params: Record<string, string[]> = {}) {
  dashboard.mockResolvedValue({ data });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><SourcingExecution masterFilterParams={params} /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => dashboard.mockReset());

describe('Dashboard → Sourcing execution', () => {
  it('renders nothing at all while the module is off — the dashboard is exactly what it was', async () => {
    const { container } = mount({ enabled: false });
    await waitFor(() => expect(dashboard).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('passes the dashboard\'s master filters through to its own endpoint', async () => {
    mount(payload(), { priority: ['P0'], role_id: ['R7'] });
    await screen.findByText('Sourcing execution');
    expect(dashboard).toHaveBeenCalledWith({ priority: ['P0'], role_id: ['R7'] });
  });

  it('shows the summary tile and an exception row as committed → what happened → next, linking to the role\'s plan in the Sourcing workspace', async () => {
    mount(payload());
    expect(await screen.findByText('Plans active')).toBeInTheDocument();
    expect(screen.getByText('6 / 14')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Role 1' });
    expect(link).toHaveAttribute('href', '/dashboard?sourcing_role=R1#sourcing-workspace');
    expect(screen.getByText('LinkedIn: Publish the posting (1)')).toBeInTheDocument();
    expect(screen.getByText('Not done — 2 days overdue')).toBeInTheDocument();
    expect(screen.getByText('Publish on LinkedIn and mark it done')).toBeInTheDocument();
    expect(screen.queryByText('Aaron Newton')).not.toBeInTheDocument();
  });

  it('every row links to its own role\'s plan in the workspace — never to the role page', async () => {
    mount(payload({}, [row(1), row(2, { role_title: 'Sr. Backend Developer', role_id: 'R019' }), row(3, { provisional: true, type: 'VOLUME_GAP', channel: '*', role_id: 'R7', role_title: 'Designer' })]));
    await screen.findByText('Role 1');
    const hrefs = Object.fromEntries(screen.getAllByRole('link').map(a => [a.textContent, a.getAttribute('href')]));
    expect(hrefs['Role 1']).toBe('/dashboard?sourcing_role=R1#sourcing-workspace');
    expect(hrefs['Sr. Backend Developer']).toBe('/dashboard?sourcing_role=R019#sourcing-workspace');
    expect(hrefs['Designer']).toBe('/dashboard?sourcing_role=R7#sourcing-workspace');
    expect(screen.getAllByRole('link').some(a => a.getAttribute('href')?.startsWith('/roles/'))).toBe(false);
  });

  it('two exceptions on one role give two rows with the same link', async () => {
    mount(payload({}, [row(1, { id: 'a', type: 'CHANNEL_NOT_ACTIVATED' }), row(1, { id: 'b', type: 'COMMITMENT_OVERDUE', channel: 'Agency' })]));
    await screen.findAllByRole('link', { name: 'Role 1' });
    const links = screen.getAllByRole('link', { name: 'Role 1' });
    expect(links).toHaveLength(2);
    for (const l of links) expect(l).toHaveAttribute('href', '/dashboard?sourcing_role=R1#sourcing-workspace');
  });

  it('provisional rows are marked and explained with the date they go live', async () => {
    mount(payload({}, [row(1), row(2, { provisional: true, type: 'VOLUME_GAP', channel: '*' })]));
    expect(await screen.findByText('Provisional')).toBeInTheDocument();
    expect(screen.getByText(/do not raise tasks or alerts until 2026-11-25/)).toBeInTheDocument();
  });

  it('an empty exception list is a good state, not a blank', async () => {
    mount(payload({}, []));
    expect(await screen.findByText('No sourcing exceptions ✓')).toBeInTheDocument();
  });

  it('there is no Owner column for anyone (the HR persona owns every exception), and a Hiring Manager gets no provisional note', async () => {
    mount(payload({ read_only: true }, [row(1)]));
    await screen.findByText('Role 1');
    expect(screen.queryByRole('columnheader', { name: 'Owner' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Provisional signals/)).not.toBeInTheDocument();
  });

  it('shows the first 10 and offers "Show all"', async () => {
    mount(payload({}, Array.from({ length: 13 }, (_, i) => row(i + 1))));
    await screen.findByText('Role 1');
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(11);                       // header + 10
    fireEvent.click(screen.getByRole('button', { name: 'Show all 13' }));
    expect(within(table).getAllByRole('row')).toHaveLength(14);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeInTheDocument();
  });

  it('a failed load says so instead of vanishing', async () => {
    dashboard.mockRejectedValueOnce(new Error('boom'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter><SourcingExecution masterFilterParams={{}} /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't load sourcing execution/);
  });
});
