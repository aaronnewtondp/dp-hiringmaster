import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// My Tasks is persona-scoped. What is under test here is the Leadership user who is ALSO the named Hiring
// Manager of a role (Mansi Jain / Head of Marketing): she stays Leadership, but works that role's Hiring
// Manager queue and ready list. Everything the page renders around that is mocked.
const pending = vi.fn();
const rolesList = vi.fn();
const sourcingStatus = vi.fn();
const sourcingQueue = vi.fn();
vi.mock('../services/api.ts', () => ({
  dashboardApi: { pending: () => pending() },
  rolesApi: { list: () => rolesList() },
  // The Sourcing box is additive and recruiter/Super-Admin only; the modals it can open call the rest of sourcingApi.
  sourcingApi: { status: () => sourcingStatus(), queue: () => sourcingQueue(), people: () => Promise.resolve({ data: { people: [] } }) },
}));

let currentUser: { name: string; persona: string; email: string } = { name: 'Mansi Jain', persona: 'leadership', email: 'mansi.jain@digitalpaani.com' };
vi.mock('../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ user: currentUser }) }));

const scorecardProps = vi.fn();
vi.mock('./ScorecardSummary.tsx', () => ({
  default: (p: unknown) => { scorecardProps(p); return <div data-testid="scorecard" />; },
}));
vi.mock('../components/InterviewFeedbackModal.tsx', () => ({ default: () => null }));

import MyTasks from './MyTasks.tsx';

const action = (id: number, owner_type: string, action_type: string, extra: Record<string, unknown> = {}) =>
  ({ id, owner_type, action_type, priority_level: 'High', description: `${action_type} #${id}`, hours_overdue: 5, created_at: new Date().toISOString(), ...extra });

const HM_ITEMS = [
  action(1, 'Hiring Manager', 'Resume Shortlist Pending', { responsible_person: 'Mansi Jain', role_id: 'R019', candidate_id: 'C7', candidate_name: 'Arjun Mehta', role_title: 'Head of Marketing' }),
  action(2, 'Hiring Manager', 'Interview 1 Feedback Due', { responsible_person: 'Mansi Jain', role_id: 'R019', candidate_id: 'C1', application_id: 'A1', candidate_name: 'Priya Rao', role_title: 'Head of Marketing' }),
  action(3, 'Leadership / Founders', 'Founder Review'),
];
const ALERTS = [action(10, 'Leadership / Founders', 'Role aging alert')];

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><MyTasks /></MemoryRouter></QueryClientProvider>);
}
const lastScope = () => scorecardProps.mock.calls[scorecardProps.mock.calls.length - 1]?.[0]?.personaScope;

beforeEach(() => {
  pending.mockReset(); rolesList.mockReset(); scorecardProps.mockReset(); sourcingStatus.mockReset(); sourcingQueue.mockReset();
  sourcingStatus.mockResolvedValue({ data: { enabled: false } });                  // module off unless a test switches it on
  sessionStorage.clear();
  currentUser = { name: 'Mansi Jain', persona: 'leadership', email: 'mansi.jain@digitalpaani.com' };
  rolesList.mockResolvedValue({ data: { roles: [] } });
});

describe('My Tasks — a Leadership user who is also a role\'s Hiring Manager', () => {
  it('says so, and widens Ready for Review to that role on top of the Founder-flag scope', async () => {
    pending.mockResolvedValue({ data: { actions: HM_ITEMS, alerts: ALERTS, hm_roles: [{ id: 'R019', title: 'Head of Marketing & Creative Direction' }] } });
    mount();
    expect(await screen.findByTestId('hm-roles-note')).toHaveTextContent(/Hiring Manager for Head of Marketing & Creative Direction/);
    await waitFor(() => expect(lastScope()).toEqual({ founderFlagOnly: true, alsoRoleIds: ['R019'] }));
  });

  it('does not fetch the Founder-only list first and then swap it: nothing is rendered until the pending response says which roles she is HM of', async () => {
    let resolve!: (v: unknown) => void;
    pending.mockReturnValue(new Promise(r => { resolve = r; }));
    mount();
    expect(screen.queryByTestId('scorecard')).not.toBeInTheDocument();
    expect(scorecardProps).not.toHaveBeenCalled();
    resolve({ data: { actions: [], alerts: [], hm_roles: [{ id: 'R019', title: 'Head of Marketing' }] } });
    await screen.findByTestId('scorecard');
    expect(scorecardProps.mock.calls[0][0].personaScope).toEqual({ founderFlagOnly: true, alsoRoleIds: ['R019'] });
  });

  it('counts her Hiring Manager items as actionable work (Other Pending Actions / Feedback Due), not as Leadership Alerts', async () => {
    pending.mockResolvedValue({ data: { actions: HM_ITEMS, alerts: ALERTS, hm_roles: [{ id: 'R019', title: 'Head of Marketing' }] } });
    mount();
    const other = await screen.findByRole('button', { name: /Other Pending Actions/ });
    await waitFor(() => expect(other).toHaveTextContent('2'));                       // Resume Shortlist Pending + Founder Review (feedback is its own box)
    expect(screen.getByRole('button', { name: /Feedback Due/ })).toHaveTextContent('1');
    expect(screen.queryByRole('button', { name: /^Leadership Alerts/ })).not.toBeInTheDocument();

    fireEvent.click(other);
    expect(await screen.findByText('Resume Shortlist Pending')).toBeInTheDocument();
    expect(screen.getByText('Founder Review')).toBeInTheDocument();
    expect(screen.getByText(/Leadership Alerts \(1\)/)).toBeInTheDocument();        // the aging notice stays visible, in its own panel
    expect(screen.getByText('Role aging alert')).toBeInTheDocument();
  });

  it('names the candidate and role on an Other Pending Actions row and links to the candidate (a bare action name is not actionable)', async () => {
    pending.mockResolvedValue({ data: { actions: HM_ITEMS, alerts: [], hm_roles: [{ id: 'R019', title: 'Head of Marketing' }] } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Other Pending Actions/ }));
    const link = await screen.findByRole('link', { name: 'Arjun Mehta' });
    expect(link).toHaveAttribute('href', '/candidates/C7');
    expect(link.parentElement).toHaveTextContent('Arjun Mehta · Head of Marketing');
  });

  it('if the pending response cannot be read it says so instead of silently showing the narrower Founder-only list, and can retry', async () => {
    pending.mockRejectedValueOnce(new Error('boom'));
    mount();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Founder-flagged candidates only/);
    expect(await screen.findByTestId('scorecard')).toBeInTheDocument();                 // the list is still usable
    pending.mockResolvedValue({ data: { actions: [], alerts: [], hm_roles: [{ id: 'R019', title: 'Head of Marketing' }] } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(lastScope()).toEqual({ founderFlagOnly: true, alsoRoleIds: ['R019'] }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('lists her Feedback Due item with a way into the candidate', async () => {
    pending.mockResolvedValue({ data: { actions: HM_ITEMS, alerts: [], hm_roles: [{ id: 'R019', title: 'Head of Marketing' }] } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Feedback Due/ }));
    expect(await screen.findByText('Priya Rao')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Submit feedback/ })).toBeInTheDocument();
  });
});

describe('My Tasks — the pending cache is per user', () => {
  it('one user\'s pending response is not shown to the next user who signs in without a reload', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = () => <QueryClientProvider client={qc}><MemoryRouter><MyTasks /></MemoryRouter></QueryClientProvider>;
    pending.mockResolvedValue({ data: { actions: HM_ITEMS, alerts: [], hm_roles: [{ id: 'R019', title: 'Head of Marketing' }] } });
    const first = render(tree());
    expect(await screen.findByTestId('hm-roles-note')).toBeInTheDocument();
    first.unmount();

    currentUser = { name: 'Nalin', persona: 'leadership', email: 'nalin@digitalpaani.com' };
    let resolve!: (v: unknown) => void;
    pending.mockReturnValue(new Promise(r => { resolve = r; }));
    render(tree());
    // while the new user's own response is on its way nothing of the previous user's shows
    expect(screen.queryByTestId('hm-roles-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('scorecard')).not.toBeInTheDocument();
    resolve({ data: { actions: [], alerts: [], hm_roles: [] } });
    await screen.findByTestId('scorecard');
    expect(screen.queryByTestId('hm-roles-note')).not.toBeInTheDocument();
  });
});

describe('My Tasks — everyone else is unchanged', () => {
  it('a Leadership user who is nobody\'s Hiring Manager keeps the alerts-only view and the Founder-flag-only scope', async () => {
    currentUser = { name: 'Nalin', persona: 'leadership', email: 'nalin@digitalpaani.com' };
    pending.mockResolvedValue({ data: { actions: [action(3, 'Leadership / Founders', 'Founder Review')], alerts: ALERTS, hm_roles: [] } });
    mount();
    const box = await screen.findByRole('button', { name: /Leadership Alerts/ });
    await waitFor(() => expect(box).toHaveTextContent('2'));                          // alerts + actions, as before
    expect(screen.queryByRole('button', { name: /Other Pending Actions/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('hm-roles-note')).not.toBeInTheDocument();
    await waitFor(() => expect(lastScope()).toEqual({ founderFlagOnly: true, alsoRoleIds: [] }));
  });

  it('a Hiring Manager is scoped to their own roles exactly as before (no Leadership union, no pending wait)', async () => {
    currentUser = { name: 'Alex', persona: 'hiring_manager', email: 'alex@digitalpaani.com' };
    rolesList.mockResolvedValue({ data: { roles: [
      { id: 'R005', hiring_manager_name: 'Alex' }, { id: 'R006', hiring_manager_name: 'alex ' }, { id: 'R019', hiring_manager_name: 'Mansi Jain' },
    ] } });
    pending.mockResolvedValue({ data: { actions: [], alerts: [], hm_roles: [] } });
    mount();
    await waitFor(() => expect(lastScope()).toEqual({ ownRoleIds: ['R005', 'R006'] }));
    expect(screen.queryByTestId('hm-roles-note')).not.toBeInTheDocument();
  });

  it('a Hiring Manager listed with a co-Hiring-Manager ("Mandeep Dagar, Piyush Negi") is scoped to that role too', async () => {
    currentUser = { name: 'Piyush Negi', persona: 'hiring_manager', email: 'piyush.negi@digitalpaani.com' };
    rolesList.mockResolvedValue({ data: { roles: [
      { id: 'R016', hiring_manager_name: 'Mandeep Dagar, Piyush Negi' },
      { id: 'R020', hiring_manager_name: 'Piyush Negi and Someone' },
      { id: 'R001', hiring_manager_name: 'Mandeep Dagar' },
      { id: 'R030', hiring_manager_name: 'Piyush Negi Jr' },
    ] } });
    pending.mockResolvedValue({ data: { actions: [], alerts: [], hm_roles: [] } });
    mount();
    await waitFor(() => expect(lastScope()).toEqual({ ownRoleIds: ['R016', 'R020'] }));      // not R001, and not the longer "Piyush Negi Jr"
  });

  it('HR/Admin sees everything: no persona scope at all', async () => {
    currentUser = { name: 'Aaron Newton', persona: 'hr_recruiter', email: 'aaron.newton@digitalpaani.com' };
    pending.mockResolvedValue({ data: { actions: [], alerts: [] } });                // older servers do not send hm_roles at all
    mount();
    await screen.findByTestId('scorecard');
    expect(lastScope()).toBeUndefined();
  });
});


// ─── Sourcing box (additive 4th box) ────────────────────────────────────────────────────────────────────────
const QUEUE = {
  enabled: true, today: '2026-10-14',
  plans_to_activate: [{ plan_id: '1', role_id: 'R005', title: 'Quality Assurance Engineer', priority: 'P1', approval_date: '2026-10-01' }],
  due: [{ id: '9', plan_id: '2', role_id: 'R001', role_title: 'Sr. Backend Developer', priority: 'P1', channel: 'LinkedIn', kind: 'renew_posting', title: 'Renew the LinkedIn posting', due_date: '2026-10-14', overdue: false }],
  exceptions: [{ role_id: 'R003', title: 'Sr. E&I Engineer (Hyderabad)', priority: 'P1', severity: 40, items: [
    { id: '5', plan_id: '3', channel: 'Agency', type: 'CHANNEL_NOT_ACTIVATED', severity: 40, age_days: 2, committed: 'Agency: Select agencies', happened: 'Not done — 2 days overdue', next_action: 'Choose the agencies' }] }],
  exception_count: 1, snoozed_count: 1, blocked_count: 0, active_plans: 3,
  volume: [{ role_id: 'R003', title: 'Sr. E&I Engineer (Hyderabad)', priority: 'P1', min: 5, qualified: 2 }, { role_id: 'R001', title: 'Sr. Backend Developer', priority: 'P1', min: 5, qualified: 7 }],
  volume_ok: 1,
};
const recruiter = { name: 'Aaron Newton', persona: 'hr_recruiter', email: 'aaron.newton@digitalpaani.com' };

describe('My Tasks — the Sourcing box', () => {
  beforeEach(() => {
    currentUser = recruiter;
    pending.mockResolvedValue({ data: { actions: [], alerts: [] } });
    sourcingStatus.mockResolvedValue({ data: { enabled: true } });
    sourcingQueue.mockResolvedValue({ data: QUEUE });
  });

  it('appears for a recruiter when the module is on, counting plans to activate + due today + open exceptions', async () => {
    mount();
    const box = await screen.findByRole('button', { name: /^Sourcing/ });
    await waitFor(() => expect(box).toHaveTextContent('3'));                           // 1 plan + 1 due today + 1 exception
  });

  it('shows the three groups, the weekly target line, and the "not shown" footer', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^Sourcing/ }));
    expect(await screen.findByText('Plans to activate')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Quality Assurance Engineer' })).toHaveAttribute('href', '/dashboard?sourcing_role=R005#sourcing-workspace');
    expect(screen.getByText('Renew the LinkedIn posting')).toBeInTheDocument();
    expect(screen.getByText('Not done — 2 days overdue')).toBeInTheDocument();
    expect(screen.getByTestId('sourcing-targets')).toHaveTextContent('1 of 2 roles');
    expect(screen.getByTestId('sourcing-targets')).toHaveTextContent('Below target');
    expect(screen.getByText(/1 catching up/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Whose queue' })).not.toBeInTheDocument();          // a recruiter only ever sees their own
  });

  // ── the header line: "X of N roles at their own weekly qualified target" ──
  describe('the weekly-target header line', () => {
    const openBox = async (queue: unknown = QUEUE) => {
      sourcingQueue.mockResolvedValue({ data: queue });
      mount();
      fireEvent.click(await screen.findByRole('button', { name: /^Sourcing/ }));
      return screen.findByTestId('sourcing-targets');
    };
    const norm = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const role = (i: number, qualified: number, min = 5) => ({ role_id: `R2${i}`, title: `Role ${i}`, priority: 'P1', min, qualified });

    it('reads "This week: X of N roles at their own weekly qualified target." with the roles below target named and linked to their plan', async () => {
      const el = await openBox();
      expect(norm(el)).toBe('This week: 1 of 2 roles at their own weekly qualified target. Below target: Sr. E&I Engineer (Hyderabad) (2).');
      expect(screen.getAllByRole('link', { name: 'Sr. E&I Engineer (Hyderabad)' }).map(a => a.getAttribute('href')))
        .toContain('/dashboard?sourcing_role=R003#sourcing-workspace');
      expect(el.textContent).not.toMatch(/at or above|minimum|a minimum of/i);
    });

    it('counts the roles the queue reports, with the singular "1 role"', async () => {
      const el = await openBox({ ...QUEUE, volume: [role(1, 9)], volume_ok: 1 });
      expect(norm(el)).toBe('This week: 1 of 1 role at their own weekly qualified target.');
      expect(el.textContent).not.toMatch(/Below target/);
    });

    it('when every role is on target there is no "Below target" list; when none is, every one is named', async () => {
      const ok = await openBox({ ...QUEUE, volume: [role(1, 5), role(2, 8)], volume_ok: 2 });
      expect(norm(ok)).toBe('This week: 2 of 2 roles at their own weekly qualified target.');   // exactly the target counts as met
      cleanup();
      const none = await openBox({ ...QUEUE, volume: [role(1, 0), role(2, 4)], volume_ok: 0 });
      expect(norm(none)).toBe('This week: 0 of 2 roles at their own weekly qualified target. Below target: Role 1 (0), Role 2 (4).');
    });

    it('names at most three roles below target and counts the rest ("+N more")', async () => {
      const volume = [role(1, 0), role(2, 1), role(3, 2), role(4, 3), role(5, 4), role(6, 9)];
      const el = await openBox({ ...QUEUE, volume, volume_ok: 1 });
      expect(norm(el)).toBe('This week: 1 of 6 roles at their own weekly qualified target. Below target: Role 1 (0), Role 2 (1), Role 3 (2) +2 more.');
      expect(screen.queryByRole('link', { name: 'Role 4' })).not.toBeInTheDocument();
    });

    it('a role\'s own target decides "below": 6 qualified against its own target of 8 is below, 3 against a target of 2 is not', async () => {
      const el = await openBox({ ...QUEUE, volume: [role(1, 6, 8), role(2, 3, 2)], volume_ok: 1 });
      expect(norm(el)).toBe('This week: 1 of 2 roles at their own weekly qualified target. Below target: Role 1 (6).');
    });

    it('with no role carrying a target yet it says how many plans are active and how a target comes about, and never "0 of 0 roles"', async () => {
      const el = await openBox({ ...QUEUE, volume: [], volume_ok: 0, active_plans: 3 });
      expect(norm(el)).toBe('3 active plans. A role\'s weekly qualified target applies once it has one (5 by default for P0 and P1 roles).');
      expect(el.textContent).not.toMatch(/0 of 0/);
      cleanup();
      const one = await openBox({ ...QUEUE, volume: [], volume_ok: 0, active_plans: 1 });
      expect(norm(one)).toMatch(/^1 active plan\. /);
    });
  });

  // ── the empty state ──
  describe('when nothing needs attention', () => {
    const EMPTY = { ...QUEUE, plans_to_activate: [], due: [], exceptions: [], exception_count: 0, snoozed_count: 0, blocked_count: 0 };

    it('says "Nothing needs your attention" with the three things that are clear, and lists no groups', async () => {
      sourcingQueue.mockResolvedValue({ data: EMPTY });
      mount();
      const box = await screen.findByRole('button', { name: /^Sourcing/ });
      fireEvent.click(box);
      expect(await screen.findByText('Nothing needs your attention ✓')).toBeInTheDocument();
      expect(screen.getByText('No plans waiting, nothing due today, no open exceptions.')).toBeInTheDocument();
      expect(screen.queryByText('Plans to activate')).not.toBeInTheDocument();
      expect(screen.queryByText('Due today')).not.toBeInTheDocument();
      expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
      // the weekly-target line still shows above it
      expect(screen.getByTestId('sourcing-targets')).toHaveTextContent('1 of 2 roles at their own weekly qualified target');
    });

    it('is not shown while anything at all is waiting — a plan to activate, a task due today or an open exception each suppress it', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['a plan to activate', { plans_to_activate: QUEUE.plans_to_activate }],
        ['a task due today', { due: QUEUE.due }],
        ['an open exception', { exceptions: QUEUE.exceptions, exception_count: 1 }],
      ];
      for (const [label, over] of cases) {
        sourcingQueue.mockResolvedValue({ data: { ...EMPTY, ...over } });
        const { unmount } = mount();
        fireEvent.click(await screen.findByRole('button', { name: /^Sourcing/ }));
        await screen.findByTestId('sourcing-targets');
        expect(screen.queryByText('Nothing needs your attention ✓'), label).not.toBeInTheDocument();
        unmount();
      }
    });

    it('an overdue task is not "due today": it does not count toward the list, so a queue with only overdue tasks reads as clear (its exception carries it)', async () => {
      sourcingQueue.mockResolvedValue({ data: { ...EMPTY, due: [{ ...QUEUE.due[0], overdue: true }] } });
      mount();
      fireEvent.click(await screen.findByRole('button', { name: /^Sourcing/ }));
      expect(await screen.findByText('Nothing needs your attention ✓')).toBeInTheDocument();
      expect(screen.queryByText('Due today')).not.toBeInTheDocument();
    });
  });

  it('an exception about a channel set-up shows the label "Channel set-up overdue" with the channel, never "Channel not live"', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^Sourcing/ }));
    await screen.findByText('Needs attention');
    expect(screen.getByText('Channel set-up overdue')).toBeInTheDocument();
    expect(screen.getByText('Channel set-up overdue').parentElement).toHaveTextContent('Channel set-up overdue · Agency');
    expect(screen.queryByText(/Channel not live/)).not.toBeInTheDocument();
  });

  it('every role link in the box opens that role\'s plan in the Dashboard\'s Sourcing workspace, and none goes to the role page', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^Sourcing/ }));
    await screen.findByText('Plans to activate');
    const href = (name: string) => screen.getAllByRole('link', { name }).map(a => a.getAttribute('href'));
    // plan to activate: the title AND the Activate button
    expect(href('Quality Assurance Engineer')).toEqual(['/dashboard?sourcing_role=R005#sourcing-workspace']);
    expect(href('Activate')).toEqual(['/dashboard?sourcing_role=R005#sourcing-workspace']);
    // due today
    expect(href('Sr. Backend Developer')).toEqual(['/dashboard?sourcing_role=R001#sourcing-workspace']);
    // the exception group heading and the "Below target" line both name R003
    expect(href('Sr. E&I Engineer (Hyderabad)')).toEqual(Array(2).fill('/dashboard?sourcing_role=R003#sourcing-workspace'));
    expect(screen.getAllByRole('link').some(a => (a.getAttribute('href') ?? '').startsWith('/roles/'))).toBe(false);
  });

  it('is absent while the module is off — and the queue is never fetched', async () => {
    sourcingStatus.mockResolvedValue({ data: { enabled: false } });
    mount();
    await screen.findByTestId('scorecard');
    await waitFor(() => expect(sourcingStatus).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /^Sourcing/ })).not.toBeInTheDocument();
    expect(sourcingQueue).not.toHaveBeenCalled();
  });

  it('never appears for Leadership or a Hiring Manager, who do not even ask', async () => {
    for (const u of [{ name: 'Nalin', persona: 'leadership', email: 'n@x.com' }, { name: 'Alex', persona: 'hiring_manager', email: 'a@x.com' }]) {
      currentUser = u;
      sourcingStatus.mockClear();
      const { unmount } = mount();
      await screen.findByTestId('scorecard');
      expect(screen.queryByRole('button', { name: /^Sourcing/ })).not.toBeInTheDocument();
      expect(sourcingStatus).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('a persisted "sourcing" section is clamped to Ready for Review for someone without the box (never a blank panel)', async () => {
    for (const u of [{ name: 'Nalin', persona: 'leadership', email: 'n@x.com' }, { name: 'Alex', persona: 'hiring_manager', email: 'a@x.com' }]) {
      sessionStorage.setItem('hms:mytasks.section', JSON.stringify('sourcing'));
      currentUser = u;
      const { unmount } = mount();
      expect(await screen.findByTestId('scorecard')).toBeInTheDocument();
      unmount();
    }
    // module off for a recruiter: same fallback
    sessionStorage.setItem('hms:mytasks.section', JSON.stringify('sourcing'));
    currentUser = recruiter;
    sourcingStatus.mockResolvedValue({ data: { enabled: false } });
    mount();
    expect(await screen.findByTestId('scorecard')).toBeInTheDocument();
  });

  it('a recruiter whose persisted section is "sourcing" does not flash Ready for Review while the status loads', async () => {
    sessionStorage.setItem('hms:mytasks.section', JSON.stringify('sourcing'));
    let resolve!: (v: unknown) => void;
    sourcingStatus.mockReturnValue(new Promise(r => { resolve = r; }));
    mount();
    expect(screen.queryByTestId('scorecard')).not.toBeInTheDocument();
    resolve({ data: { enabled: true } });
    expect(await screen.findByText('Plans to activate')).toBeInTheDocument();
    expect(screen.queryByTestId('scorecard')).not.toBeInTheDocument();
  });

  it('every HR user sees the same queue — there is no "mine / everyone" switch for anyone, the Super Admin included', async () => {
    for (const who of [recruiter, { name: 'Super Admin', persona: 'super_admin', email: 'sa@x.com' }]) {
      currentUser = who;
      const view = mount();
      fireEvent.click(await screen.findByRole('button', { name: /^Sourcing/ }));
      await screen.findByText('Plans to activate');
      expect(screen.queryByRole('button', { name: 'Everyone' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Mine' })).not.toBeInTheDocument();
      expect(sourcingQueue).toHaveBeenLastCalledWith();
      view.unmount();
    }
  });

  it('a failed queue says so and can retry — it does not pretend there is nothing to do', async () => {
    sourcingQueue.mockRejectedValueOnce(new Error('boom'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^Sourcing/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't load the sourcing queue/);
    sourcingQueue.mockResolvedValue({ data: QUEUE });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Plans to activate')).toBeInTheDocument();
  });

  it('long lists show the top 5 and "Show N more"', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ plan_id: String(i), role_id: `R10${i}`, title: `Role ${i}`, priority: 'P2', approval_date: null }));
    sourcingQueue.mockResolvedValue({ data: { ...QUEUE, plans_to_activate: many } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^Sourcing/ }));
    await screen.findByText('Plans to activate');
    expect(screen.getAllByRole('link', { name: /^Role \d$/ })).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 more' }));
    expect(screen.getAllByRole('link', { name: /^Role \d$/ })).toHaveLength(8);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeInTheDocument();
  });
});
