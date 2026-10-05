import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SlaByRole } from '../../types/index.ts';

const slaByRole = vi.fn();
vi.mock('../../services/api.ts', () => ({ dashboardApi: { slaByRole: (p: unknown) => slaByRole(p) } }));

import SlaBreachesByRole from './SlaBreachesByRole.tsx';

const stage = (name: string, count: number, types: Array<[string, string, number]>) =>
  ({ stage: name, count, breach_types: types.map(([type, owner, c]) => ({ type, owner, count: c })) });

const DATA: SlaByRole = {
  stages: [],
  total_breaches: 14,
  closed_roles: { roles: 2, breaches: 5 },
  roles: [
    { role_id: 'R7', role_title: 'Senior UX Designer', priority: 'P1', status: 'Live – Sourcing', hiring_manager_name: 'Alex', total: 9,
      by_stage: [stage('Applied and Screened', 6, [['Resume Shortlist Pending', 'Hiring Manager', 6]]),
                 stage('Interview Round 1', 2, [['Interview 1 Feedback Due', 'Hiring Manager', 1], ['Interview 1 Not Scheduled', 'HR / Recruiter', 1]]),
                 stage('Founders Round', 1, [['Founders Round Feedback Due', 'Hiring Manager', 1]])] },
    { role_id: 'R2', role_title: 'Backend Engineer', priority: 'P0', status: 'Approved', hiring_manager_name: null, total: 4,
      by_stage: [stage('Assignment Round', 4, [['Assignment Not Sent', 'HR / Recruiter', 4]])] },
    { role_id: 'R5', role_title: 'QA Engineer', priority: 'P2', status: 'On Hold', hiring_manager_name: 'Sam', total: 1,
      by_stage: [stage('Joined', 1, [['Idle Candidate', 'HR / Recruiter', 1]])] },
  ],
};
function manyRoles(n: number): SlaByRole {
  const roles = Array.from({ length: n }, (_, i) => ({
    role_id: `R${i}`, role_title: `Role ${String(i).padStart(2, '0')}`, priority: 'P1', status: 'Approved', hiring_manager_name: null, total: n - i,
    by_stage: [stage('Applied and Screened', n - i, [['Resume Shortlist Pending', 'Hiring Manager', n - i]])],
  }));
  return { stages: [], roles, total_breaches: roles.reduce((s, r) => s + r.total, 0), closed_roles: { roles: 0, breaches: 0 } };
}

function mount(data: SlaByRole, master: Record<string, string[]> = {}) {
  slaByRole.mockResolvedValue({ data });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><SlaBreachesByRole masterFilterParams={master} /></MemoryRouter></QueryClientProvider>);
}
const bars = () => screen.getAllByRole('button', { name: /open SLA breaches/ });

beforeEach(() => slaByRole.mockReset());

describe('SlaBreachesByRole', () => {
  it('shows one bar per open role, biggest first, each with its total', async () => {
    mount(DATA);
    await screen.findByText('Senior UX Designer');
    const names = bars().map(b => b.getAttribute('aria-label')!.split(':')[0]);
    expect(names).toEqual(['Senior UX Designer', 'Backend Engineer', 'QA Engineer']);
    expect(within(bars()[0]).getByText('9')).toBeInTheDocument();
    expect(screen.getByText(/14 open breaches across 3 open roles/)).toBeInTheDocument();
  });

  it('passes the dashboard filters straight through to the endpoint', async () => {
    mount(DATA, { department: ['Tech'], role_id: ['R7'] });
    await waitFor(() => expect(slaByRole).toHaveBeenCalledWith({ department: ['Tech'], role_id: ['R7'] }));
  });

  it("describes each bar's funnel-step split in text, so it is readable without colour", async () => {
    mount(DATA);
    await screen.findByText('Senior UX Designer');
    expect(bars()[0].getAttribute('aria-label')).toContain('6 at Applied & Screened, 2 at Interview 1, 1 at Assignment & Founders');
  });

  it('the legend lists only the funnel steps that actually occur, in funnel order', async () => {
    mount(DATA);
    await screen.findByText('Senior UX Designer');
    const legend = screen.getByRole('group', { name: 'Funnel steps' });
    expect(within(legend).getAllByRole('button').map(b => b.textContent)).toEqual([
      'Applied & Screened', 'Interview 1', 'Assignment & Founders', 'Reference → Offer',
    ]);
  });

  it('clicking a legend step spotlights it, and clicking again clears it', async () => {
    mount(DATA);
    await screen.findByText('Senior UX Designer');
    const step = within(screen.getByRole('group', { name: 'Funnel steps' })).getByRole('button', { name: 'Interview 1' });
    fireEvent.click(step);
    expect(step).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(step);
    expect(step).toHaveAttribute('aria-pressed', 'false');
  });

  it('the second level: clicking a role lists every stage, what is overdue there, and who owns it', async () => {
    mount(DATA);
    await screen.findByText('Senior UX Designer');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    fireEvent.click(bars()[0]);
    const panel = screen.getByRole('region', { name: /Senior UX Designer — breaches by stage/ });
    expect(within(panel).getByText('Applied and Screened')).toBeInTheDocument();
    expect(within(panel).getByText('Interview Round 1')).toBeInTheDocument();
    expect(within(panel).getByText('Founders Round')).toBeInTheDocument();
    expect(within(panel).getByText('Resume Shortlist Pending')).toBeInTheDocument();
    expect(within(panel).getByText('Interview 1 Not Scheduled')).toBeInTheDocument();
    expect(within(panel).getAllByText('HR / Recruiter').length).toBeGreaterThan(0);
    expect(within(panel).getByText(/Hiring Manager: Alex/)).toBeInTheDocument();
    expect(bars()[0]).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(bars()[0]);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('shows only the top eight roles until "Show all"', async () => {
    mount(manyRoles(11));
    await screen.findByText('Role 00');
    expect(bars()).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 11 roles' }));
    expect(bars()).toHaveLength(11);
    fireEvent.click(screen.getByRole('button', { name: 'Show top 8 only' }));
    expect(bars()).toHaveLength(8);
  });

  it('offers no "Show all" when everything already fits', async () => {
    mount(DATA);
    await screen.findByText('Senior UX Designer');
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
  });

  it('has a table view with every role (even beyond the top eight) and the totals', async () => {
    mount(manyRoles(11));
    await screen.findByText('Role 00');
    fireEvent.click(screen.getByRole('button', { name: /Table/ }));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(12);          // header + 11 roles
    expect(within(table).getByRole('columnheader', { name: 'Applied & Screened' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Funnel steps' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Chart/ }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says what it left out: breaches on closed roles are counted, not hidden', async () => {
    mount(DATA);
    await screen.findByText('Senior UX Designer');
    expect(screen.getByText(/Not shown: 5 breaches on 2 closed roles/)).toBeInTheDocument();
  });

  it('is quiet about closed roles when there are none', async () => {
    mount({ ...DATA, closed_roles: { roles: 0, breaches: 0 } });
    await screen.findByText('Senior UX Designer');
    expect(screen.queryByText(/Not shown/)).not.toBeInTheDocument();
  });

  it('empty state when no open role has a breach', async () => {
    mount({ stages: [], roles: [], total_breaches: 0, closed_roles: { roles: 0, breaches: 0 } });
    expect(await screen.findByText(/No SLA breaches on open roles/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Table/ })).toBeInTheDocument();      // the toggle stays; nothing breaks
  });

  it('role names link to the role page', async () => {
    mount(DATA);
    const link = await screen.findByRole('link', { name: 'Senior UX Designer' });
    expect(link).toHaveAttribute('href', '/roles/R7');
  });

  it('a hover readout leads with the value and names the funnel step', async () => {
    mount(DATA);
    await screen.findByText('Senior UX Designer');
    const segment = bars()[0].querySelector('span[style*="flex-grow: 6"]') as HTMLElement;
    expect(segment).toBeTruthy();
    fireEvent.pointerEnter(segment, { clientX: 100, clientY: 100 });
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText('6')).toBeInTheDocument();
    expect(within(tip).getByText(/at Applied & Screened/)).toBeInTheDocument();
    expect(within(tip).getByText(/67% of this role's 9/)).toBeInTheDocument();
    fireEvent.pointerLeave(segment);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  describe('the hover readout never outlives its bar', () => {
    const hover = async () => {
      mount(DATA);
      await screen.findByText('Senior UX Designer');
      const segment = bars()[0].querySelector('span[style*="flex-grow: 6"]') as HTMLElement;
      fireEvent.pointerEnter(segment, { clientX: 100, clientY: 100 });
      await screen.findByRole('tooltip');
    };

    it('goes away when the page scrolls under a still mouse', async () => {
      await hover();
      fireEvent.scroll(window);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('goes away when the bars are re-drawn (switching to the table and back does not resurrect it)', async () => {
      await hover();
      fireEvent.click(screen.getByRole('button', { name: /Table/ }));
      fireEvent.click(screen.getByRole('button', { name: /Chart/ }));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('goes away when the window loses focus', async () => {
      await hover();
      fireEvent.blur(window);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('is never shown for a touch tap (the drill-down carries the same numbers)', async () => {
      mount(DATA);
      await screen.findByText('Senior UX Designer');
      const segment = bars()[0].querySelector('span[style*="flex-grow: 6"]') as HTMLElement;
      fireEvent.pointerEnter(segment, { clientX: 100, clientY: 100, pointerType: 'touch' });
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });
});
