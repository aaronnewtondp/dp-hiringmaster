import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SourcingException, SourcingPlanChannel, SourcingPlanView } from '../types/sourcing.ts';

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
const NO_TRACKER = { applicable: false, target: null, anchor: null, link: null, running: null, weeks: [], totals: { weeks: 0, met: 0, actual: 0, target: 0 }, sourced: { applications: 0, qualified: 0 } };
const channel = (state: SourcingPlanChannel['state']): SourcingPlanChannel => ({
  id: '1', channel: 'LinkedIn', state, excluded_reason: null, closed_at: null, closed_reason: null, config: {}, targets: {}, tracker: NO_TRACKER, commitments: [],
});
const exception = (over: Partial<SourcingException> = {}): SourcingException => ({
  id: '5', channel: 'LinkedIn', type: 'CHANNEL_NOT_ACTIVATED', status: 'open', severity: 40, is_shadow: false, detected_at: '2026-10-12T00:00:00Z',
  last_seen_at: '2026-10-14T00:00:00Z', evidence: {}, resolution_path: null, reason: null, corrective_action: null, snooze_until: null,
  blocker_due: null, blocker_owner_name: null, resolved_at: null, committed: 'c', happened: 'h', next_action: 'n', ...over,
});
const view = (status: 'draft' | 'active' | 'paused' | 'closed', exceptions: SourcingException[] = []): SourcingPlanView => ({
  enabled: true,
  plan: { id: '9', role_id: 'R5', status, strategy_note: null, baseline: null, baseline_at: null,
          activated_at: status === 'draft' ? null : '2026-10-10T00:00:00Z', paused_at: null, pause_total_days: 0, closed_at: null, weekly_qualified_target: null },
  role: { id: 'R5', title: 'QA Engineer', priority: 'P1', status: 'Live – Sourcing', num_openings: 1, hiring_manager_name: 'Alex', recruitment_mode: ['LinkedIn'], approval_date: '2026-10-01' },
  channels: [channel(status === 'draft' ? 'planned' : 'active')],
  exceptions, changes: [], changes_total: 0,
  volume: { weekly_qualified: 3, shortlisted: 1, scored: 3, min: 5, rule: 'either', applicable: true, target_source: 'default', role_target: null, default_target: 5 },
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
const pageReady = () => screen.findByRole('heading', { level: 1, name: 'QA Engineer' });

beforeEach(() => {
  for (const m of [rolesGet, rolesUpdate, plan]) m.mockReset();
  rolesGet.mockImplementation(async () => ({ data: { role: server.role } }));
  plan.mockImplementation(async () => ({ data: server.plan }));
});

describe('RoleDetail — the sourcing plan follows role edits', () => {
  it('changing the status (live → On Hold) re-reads the plan: the header chip says paused, with no reload', async () => {
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
    expect(chip().className).toMatch(/bg-gray-100/);
    expect(chip()).toHaveAttribute('href', '/dashboard?sourcing_role=R5#sourcing-workspace');
  });

  it('approving a role re-reads the plan: the draft plan the server just seeded shows in the header chip', async () => {
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
    expect(chip().className).toMatch(/bg-amber-50/);
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

describe('RoleDetail — the sourcing plan has moved to the Dashboard', () => {
  it('no longer renders the plan on the page: none of the card\'s sections, buttons or its own requests', async () => {
    server = { role: role(), plan: view('active', [exception()]) };
    mount();
    await waitFor(() => expect(chip()).toBeInTheDocument());
    for (const gone of [/Needs attention/, /Applications by source/, /Plan history/, /Activate plan/, /Edit plan/, /Add channel/, /Close channel/, /Mark done/, /Resolve…/]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    expect(screen.queryByTestId('plan-timeline')).toBeNull();
    expect(screen.queryByTestId('sourcing-workspace')).toBeNull();
    expect(screen.queryByTestId('channel-LinkedIn')).toBeNull();
    expect(plan).toHaveBeenCalledWith('R5');            // only the chip's own read of the plan is left
  });

  it('keeps the rest of the page: the role renders with its pipeline total even with a plan', async () => {
    server = { role: role(), plan: view('active') };
    mount();
    expect(await pageReady()).toBeInTheDocument();
    expect(screen.getByText('active candidates')).toBeInTheDocument();
  });
});

describe('RoleDetail — the header chip opens the plan on the Dashboard', () => {
  const HREF = '/dashboard?sourcing_role=R5#sourcing-workspace';
  const cases: Array<[string, SourcingPlanView, string, RegExp]> = [
    ['draft plan',                         view('draft'),                                                        'Sourcing plan not activated', /bg-amber-50/],
    ['active plan with nothing wrong',     view('active'),                                                       'Sourcing on track',           /bg-green-50/],
    ['active plan with one open issue',    view('active', [exception()]),                                        'Sourcing: 1 issue',           /bg-red-50/],
    ['active plan with two issues',        view('active', [exception(), exception({ id: '6', status: 'blocked' })]), 'Sourcing: 2 issues',        /bg-red-50/],
    ['active plan catching up',            view('active', [exception({ status: 'snoozed' })]),                   'Sourcing: catching up',       /bg-amber-50/],
    ['paused plan',                        view('paused'),                                                       'Sourcing paused',             /bg-gray-100/],
    ['active plan with only a provisional signal', view('active', [exception({ is_shadow: true })]),             'Sourcing on track',           /bg-green-50/],
  ];
  for (const [name, v, text, tone] of cases) {
    it(`${name}: "${text}", linking to the workspace`, async () => {
      server = { role: role(), plan: v };
      mount();
      await waitFor(() => expect(chip()).toHaveTextContent(text));
      expect(chip().tagName).toBe('A');
      expect(chip()).toHaveAttribute('href', HREF);
      expect(chip().className).toMatch(tone);
      expect(chip()).toHaveAttribute('title', "Open this role's sourcing plan on the Dashboard");
    });
  }

  it('links by the role\'s own id', async () => {
    server = { role: role({ id: 'R5' }), plan: view('active') };
    mount();
    await waitFor(() => expect(chip()).toBeInTheDocument());
    expect(chip().getAttribute('href')).toContain('sourcing_role=R5');
  });

  it('is absent when the plan is closed, when there is no plan, while the module is off, and when the plan cannot be read', async () => {
    for (const p of [view('closed'), { enabled: true, plan: null }, { enabled: false }]) {
      server = { role: role(), plan: p };
      const { unmount } = mount();
      await pageReady();
      await waitFor(() => expect(plan).toHaveBeenCalled());
      expect(screen.queryByTestId('sourcing-chip')).toBeNull();
      unmount();
      plan.mockClear();
    }
    // a 403 (a Hiring Manager of another role) or any failure hides the chip and leaves the page working
    server = { role: role(), plan: view('active') };
    plan.mockRejectedValue(new Error('403'));
    mount();
    await pageReady();
    await waitFor(() => expect(plan).toHaveBeenCalled());
    expect(screen.queryByTestId('sourcing-chip')).toBeNull();
  });
});

describe('RoleDetail — Recruitment Mode follows the plan', () => {
  it('is read-only (and says the plan manages it) once a plan exists: editing the section offers no channel buttons for it', async () => {
    server = { role: role(), plan: view('active') };
    mount();
    await waitFor(() => expect(chip()).toBeInTheDocument());
    expect(screen.getByText('Recruitment Mode (managed in the Sourcing plan)')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Edit Requirements'));
    expect(screen.getByText('Recruitment Mode (managed in the Sourcing plan)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Direct Outreach' })).toBeNull();
  });

  it('is an ordinary editable field while the role has no plan (or the module is off)', async () => {
    server = { role: role(), plan: { enabled: false } };
    mount();
    await pageReady();
    await waitFor(() => expect(plan).toHaveBeenCalled());
    expect(screen.getByText('Recruitment Mode')).toBeInTheDocument();
    expect(screen.queryByText(/managed in the Sourcing plan/)).toBeNull();
    fireEvent.click(screen.getByTitle('Edit Requirements'));
    expect(screen.getByRole('button', { name: 'Direct Outreach' })).toBeInTheDocument();
  });

  it('becomes read-only straight after approval seeds the plan, with no reload', async () => {
    server = { role: role({ status: 'Draft' }), plan: { enabled: true, plan: null } };
    rolesUpdate.mockImplementation(async () => {
      server = { role: role({ status: 'Approved' }), plan: view('draft') };
      return { data: { role: server.role } };
    });
    mount();
    await screen.findByRole('button', { name: 'Approve Role' });
    await waitFor(() => expect(plan).toHaveBeenCalled());
    expect(screen.getByText('Recruitment Mode')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve Role' }));
    await waitFor(() => expect(screen.getByText('Recruitment Mode (managed in the Sourcing plan)')).toBeInTheDocument());
  });
});
