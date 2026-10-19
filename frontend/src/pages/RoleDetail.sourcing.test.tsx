import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SourcingPlanView } from '../types/sourcing.ts';

const rolesGet = vi.fn();
const rolesUpdate = vi.fn();
const plan = vi.fn();
vi.mock('../services/api.ts', () => ({
  rolesApi: {
    get: (id: string) => rolesGet(id),
    update: (id: string, d: Record<string, unknown>) => rolesUpdate(id, d),
    pipeline: async () => ({ data: { pipeline: {}, total: 0 } }),
    activity: async () => ({ data: { activity: [] } }),
  },
  sourcingApi: { plan: (id: string) => plan(id), people: async () => ({ data: { people: [] } }) },
}));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Aaron Newton', email: 'a@x.com', persona: 'hr_recruiter' }, canHR: true }),
}));

import RoleDetail from './RoleDetail.tsx';

// What the (mocked) server currently answers. Each test sets it up, and the update mock changes it the way the real PATCH
// does: the role route runs the sourcing hook BEFORE it responds (roles.ts, onRoleSaved), so a plan read after the
// response already sees the new plan.
const role = (over: Record<string, unknown> = {}) => ({
  id: 'R5', title: 'QA Engineer', department: 'Engineering', hiring_manager_name: 'Alex', priority: 'P1', status: 'Live – Sourcing',
  location: 'Mumbai', employment_type: 'Full-time', num_openings: 1, recruitment_mode: ['LinkedIn'], assignment_required: false,
  jd_drive_link: 'https://drive.example/jd', jd_source: 'generated', created_at: '2026-10-01T00:00:00Z',
  days_open: 5, days_overdue: 0, aging_alert: 'green', ...over,
});
const view = (status: 'draft' | 'active' | 'paused'): SourcingPlanView => ({
  enabled: true,
  plan: { id: '9', role_id: 'R5', status, strategy_note: null, baseline: null, baseline_at: null,
          activated_at: status === 'draft' ? null : '2026-10-10T00:00:00Z', paused_at: null, pause_total_days: 0, closed_at: null },
  role: { id: 'R5', title: 'QA Engineer', priority: 'P1', status: 'Live – Sourcing', num_openings: 1, hiring_manager_name: 'Alex', recruitment_mode: ['LinkedIn'], approval_date: '2026-10-01' },
  channels: [{ id: '1', channel: 'LinkedIn', state: status === 'draft' ? 'planned' : 'active', excluded_reason: null, config: {}, targets: {}, commitments: [] }],
  exceptions: [], changes: [],
  volume: { weekly_qualified: 3, shortlisted: 1, scored: 3, min: 5, rule: 'either', applicable: true },
  output: [], attribution_reliable: {}, settings: { go_live_date: '2026-10-01', qualified_rule: 'either', shadow_until: null },
});

let server: { role: ReturnType<typeof role>; plan: unknown };

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/roles/R5']}>
        <Routes><Route path="/roles/:id" element={<RoleDetail />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const chip = () => screen.getByTestId('sourcing-chip');

beforeEach(() => {
  for (const m of [rolesGet, rolesUpdate, plan]) m.mockReset();
  rolesGet.mockImplementation(async () => ({ data: { role: server.role } }));
  plan.mockImplementation(async () => ({ data: server.plan }));
});

describe('RoleDetail — the sourcing plan follows role edits', () => {
  it('changing the status (live → On Hold) re-reads the plan: the header chip and the card both say paused, with no reload', async () => {
    server = { role: role(), plan: view('active') };
    rolesUpdate.mockImplementation(async (_id: string, changes: Record<string, unknown>) => {
      server = { role: role({ status: changes.status }), plan: view('paused') };
      return { data: { role: server.role } };
    });
    mount();
    await waitFor(() => expect(chip()).toHaveTextContent('Sourcing on track'));
    const readsBefore = plan.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Change status' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'On Hold' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(rolesUpdate).toHaveBeenCalledWith('R5', { status: 'On Hold' }));

    // The cached plan is "fresh" for 30 s, so only an explicit invalidation can make this second read happen.
    await waitFor(() => expect(plan.mock.calls.length).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(chip()).toHaveTextContent('Sourcing paused'));
    expect(screen.getByText('Paused (role on hold)')).toBeInTheDocument();
  });

  it('approving a role re-reads the plan: the draft plan the server just seeded appears on the page', async () => {
    // A Draft role has no plan yet; approving it is what makes the server seed one.
    server = { role: role({ status: 'Draft' }), plan: { enabled: true, plan: null } };
    rolesUpdate.mockImplementation(async () => {
      server = { role: role({ status: 'Approved' }), plan: view('draft') };
      return { data: { role: server.role } };
    });
    mount();
    await screen.findByRole('button', { name: 'Approve Role' });
    await waitFor(() => expect(plan).toHaveBeenCalled());
    expect(screen.queryByTestId('sourcing-chip')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve Role' }));
    await waitFor(() => expect(rolesUpdate).toHaveBeenCalledWith('R5', { status: 'Approved' }));

    await waitFor(() => expect(chip()).toHaveTextContent('Sourcing plan not activated'));
    expect(screen.getByText('Draft — not tracked yet')).toBeInTheDocument();
  });

  it('saving any role field re-reads the plan, so a page that has gone stale catches up (here: the role was put on hold elsewhere meanwhile)', async () => {
    server = { role: role(), plan: view('active') };
    rolesUpdate.mockResolvedValue({ data: { role: role({ title: 'QA Engineer II' }) } });
    mount();
    await waitFor(() => expect(chip()).toHaveTextContent('Sourcing on track'));
    const readsBefore = plan.mock.calls.length;
    server = { ...server, plan: view('paused') }; // changed by someone else; this tab has not heard about it

    fireEvent.click(screen.getByTitle('Edit Basic Info'));
    fireEvent.change(screen.getByDisplayValue('QA Engineer'), { target: { value: 'QA Engineer II' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rolesUpdate).toHaveBeenCalledWith('R5', { title: 'QA Engineer II' }));

    await waitFor(() => expect(plan.mock.calls.length).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(chip()).toHaveTextContent('Sourcing paused'));
  });
});
