import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';

// My Tasks for the HR/Admin and Hiring Manager personas (MyTasks.test.tsx has the Leadership user who is also a role's Hiring Manager,
// and the Sourcing box): the three boxes and what each counts, how the Feedback Due and Other Pending Actions panels read, the scope a
// Hiring Manager's Ready for Review is given (and that it is never wider than their own roles, even while the role list is on its way or
// cannot be read), the ?role_id= deep link from a role page, and which section is remembered. Ready for Review itself is stubbed; the
// props it is given show the scope.
const pending = vi.fn();
const rolesList = vi.fn();
const sourcingStatus = vi.fn();
vi.mock('../services/api.ts', () => ({
  dashboardApi: { pending: () => pending() },
  rolesApi: { list: () => rolesList() },
  sourcingApi: { status: () => sourcingStatus(), queue: async () => ({ data: {} }), people: async () => ({ data: { people: [] } }) },
}));

const h = vi.hoisted(() => ({
  user: { id: 'u-test', name: 'Test Person', persona: 'hr_recruiter', email: 'test.person@example.test' } as { id: string; name: string; persona: string; email: string },
  readyCount: 0,
  scorecard: vi.fn(),
}));
vi.mock('../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock('./ScorecardSummary.tsx', () => ({
  default: (p: { onCountChange?: (n: number) => void }) => {
    h.scorecard(p);
    useEffect(() => { p.onCountChange?.(h.readyCount); }, [p.onCountChange]);        // the real table reports how many it lists
    return <div data-testid="scorecard" />;
  },
}));
vi.mock('../components/InterviewFeedbackModal.tsx', () => ({ default: () => null }));

import MyTasks from './MyTasks.tsx';

const SENTINEL = '__no_roles_owned__';          // the same string the backend's applyHiringManagerRoleLock uses for "owns no role"

const action = (id: number, owner_type: string, action_type: string, extra: Record<string, unknown> = {}) =>
  ({ id, owner_type, action_type, priority_level: 'High', description: `${action_type} #${id}`, hours_overdue: 0, created_at: '2026-10-01T00:00:00.000Z', ...extra });

// Four feedback-due kinds (the exact action types), plus three that merely sound like it
const FEEDBACK = [
  action(1, 'Hiring Manager', 'Interview 1 Feedback Due', { application_id: 'A9001', candidate_id: 'C9001', candidate_name: 'Test Candidate One', role_title: 'Test Role Alpha', hours_overdue: 2.6 }),
  action(2, 'Hiring Manager', 'Interview 2 Feedback Due', { application_id: 'A9002', candidate_id: 'C9002', candidate_name: 'Test Candidate Two', role_title: 'Test Role Beta', hours_overdue: 0 }),
  action(3, 'Hiring Manager', 'Founders Round Feedback Due', { application_id: 'A9003', candidate_id: 'C9003', candidate_name: 'Test Candidate Three', role_title: 'Test Role Gamma' }),
  action(4, 'Hiring Manager', 'Assignment Feedback Due', { candidate_id: 'C9004', candidate_name: 'Test Candidate Four', role_title: 'Test Role Delta' }),           // no application: nothing to open
];
const OTHER = [
  action(11, 'HR / Recruiter', 'Resume Shortlist Pending', { candidate_id: 'C9005', candidate_name: 'Test Candidate Five', role_title: 'Test Role Alpha' }),
  action(12, 'HR / Recruiter', 'Interview 1 Not Scheduled', { candidate_name: 'Test Candidate Six', role_title: 'Test Role Beta' }),                   // sounds like interview feedback; it is not
  action(13, 'HR / Recruiter', 'Low Pipeline', { role_title: 'Test Role Gamma' }),
];
const ALERTS = [action(21, 'Leadership / Founders', 'Role aging alert'), action(22, 'Leadership / Founders', 'Comp change notice')];

const as = (persona: string, name = 'Test Person') => { h.user = { id: 'u-test', name, persona, email: 'test.person@example.test' }; };

function Candidate() { const { id } = useParams(); return <div data-testid="candidate-page">{id}</div>; }
function tree(path: string, qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/my-tasks" element={<MyTasks />} /><Route path="/candidates/:id" element={<Candidate />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const mount = (path = '/my-tasks') => render(tree(path, newClient()));

const box = (name: RegExp) => screen.getByRole('button', { name });
const countOf = (b: HTMLElement) => within(b).getByText(/^\d+$/).textContent;
const scopes = () => h.scorecard.mock.calls.map(c => (c[0] as { personaScope?: unknown }).personaScope);
const lastScope = () => scopes()[scopes().length - 1];
const SECTION_KEY = 'hms:mytasks.section';

beforeEach(() => {
  for (const m of [pending, rolesList, sourcingStatus, h.scorecard]) m.mockReset();
  sessionStorage.clear();
  as('hr_recruiter');
  h.readyCount = 0;
  sourcingStatus.mockResolvedValue({ data: { enabled: false } });
  rolesList.mockResolvedValue({ data: { roles: [] } });
  pending.mockResolvedValue({ data: { actions: [...FEEDBACK, ...OTHER], alerts: ALERTS } });
});

describe('My Tasks — HR/Admin: the three boxes', () => {
  it('shows Ready for Review, Feedback Due and Other Pending Actions, and no Leadership Alerts box', async () => {
    mount();
    await screen.findByTestId('scorecard');
    for (const name of [/^Ready for Review/, /^Feedback Due/, /^Other Pending Actions/]) expect(box(name)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Leadership Alerts/ })).toBeNull();
  });

  it('Ready for Review counts what its table lists, Feedback Due only the four feedback-due kinds, Other Pending Actions everything else — never the alerts', async () => {
    h.readyCount = 7;
    mount();
    await waitFor(() => expect(countOf(box(/^Ready for Review/))).toBe('7'));
    await waitFor(() => expect(countOf(box(/^Feedback Due/))).toBe('4'));
    expect(countOf(box(/^Other Pending Actions/))).toBe('3');               // "Interview 1 Not Scheduled" is not feedback just because it says "Interview"
  });

  it('the counts start at zero while nothing has arrived', async () => {
    pending.mockReturnValue(new Promise(() => {}));
    mount();
    await screen.findByTestId('scorecard');
    expect(countOf(box(/^Ready for Review/))).toBe('0');
    expect(countOf(box(/^Feedback Due/))).toBe('0');
    expect(countOf(box(/^Other Pending Actions/))).toBe('0');
  });

  it('starts on Ready for Review, with the pressed state on that box only, and switching shows one panel at a time', async () => {
    mount();
    await screen.findByTestId('scorecard');
    expect(box(/^Ready for Review/)).toHaveAttribute('aria-pressed', 'true');
    expect(box(/^Feedback Due/)).toHaveAttribute('aria-pressed', 'false');
    expect(box(/^Other Pending Actions/)).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(box(/^Feedback Due/));
    expect(await screen.findByRole('heading', { name: 'Feedback due' })).toBeInTheDocument();
    expect(screen.queryByTestId('scorecard')).toBeNull();
    expect(box(/^Feedback Due/)).toHaveAttribute('aria-pressed', 'true');
    expect(box(/^Ready for Review/)).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(box(/^Other Pending Actions/));
    expect(await screen.findByRole('heading', { name: 'Other pending actions' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Feedback due' })).toBeNull();

    fireEvent.click(box(/^Ready for Review/));
    expect(await screen.findByTestId('scorecard')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Other pending actions' })).toBeNull();
  });

  it('HR/Admin and Super Admin see every role: no persona scope at all, and the role list is never asked for', async () => {
    for (const persona of ['hr_recruiter', 'super_admin']) {
      as(persona);
      h.scorecard.mockClear();
      const { unmount } = mount();
      await screen.findByTestId('scorecard');
      expect(lastScope(), persona).toBeUndefined();
      unmount();
    }
    expect(rolesList).not.toHaveBeenCalled();
  });

  it('shows Ready for Review at once, without waiting for the pending actions', async () => {
    pending.mockReturnValue(new Promise(() => {}));
    mount();
    expect(await screen.findByTestId('scorecard')).toBeInTheDocument();
  });
});

describe('My Tasks — Feedback Due', () => {
  const open = async () => { mount(); fireEvent.click(await screen.findByRole('button', { name: /^Feedback Due/ })); await screen.findByRole('heading', { name: 'Feedback due' }); };

  it('lists each of the four feedback kinds with the candidate, the role and its description, and nothing that is not feedback', async () => {
    await open();
    for (const name of ['Test Candidate One', 'Test Candidate Two', 'Test Candidate Three', 'Test Candidate Four']) expect(screen.getByText(name)).toBeInTheDocument();
    for (const role of ['Test Role Alpha', 'Test Role Beta', 'Test Role Gamma', 'Test Role Delta']) expect(screen.getByText(role)).toBeInTheDocument();
    expect(screen.getByText('Interview 1 Feedback Due #1')).toBeInTheDocument();
    expect(screen.queryByText('Test Candidate Five')).toBeNull();
    expect(screen.queryByText('Test Candidate Six')).toBeNull();            // "Interview 1 Not Scheduled" belongs to Other Pending Actions
  });

  it('says how many hours overdue a row is, rounded, and nothing for a row that is not overdue', async () => {
    await open();
    expect(screen.getByText('· 3h overdue')).toBeInTheDocument();             // 2.6 hours
    expect(screen.getAllByText(/h overdue$/)).toHaveLength(1);
  });

  it('a row with no candidate name shows a dash, not "undefined"', async () => {
    pending.mockResolvedValue({ data: { actions: [action(1, 'Hiring Manager', 'Interview 1 Feedback Due', { application_id: 'A9001', candidate_id: 'C9001' })], alerts: [] } });
    await open();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/undefined|null/);
  });

  it('offers "Submit feedback" on a row that has an application, and on no other', async () => {
    await open();
    expect(screen.getAllByRole('button', { name: /Submit feedback/ })).toHaveLength(3);     // rows 1-3 have an application, row 4 has none
    const noApplication = screen.getByText('Test Candidate Four').closest('div.flex.items-center') as HTMLElement;
    expect(within(noApplication).queryByRole('button', { name: /Submit feedback/ })).toBeNull();
  });

  it('"Submit feedback" opens that candidate\'s page (that is where the interview round\'s feedback form is)', async () => {
    await open();
    const row = screen.getByText('Test Candidate Two').closest('div.flex.items-center') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Submit feedback/ }));
    expect(await screen.findByTestId('candidate-page')).toHaveTextContent('C9002');
  });

  it('a row that has an application but no candidate id goes nowhere when its button is pressed', async () => {
    pending.mockResolvedValue({ data: { actions: [action(1, 'Hiring Manager', 'Interview 1 Feedback Due', { application_id: 'A9001', candidate_id: null, candidate_name: 'Test Candidate One' })], alerts: [] } });
    await open();
    fireEvent.click(screen.getByRole('button', { name: /Submit feedback/ }));
    expect(screen.queryByTestId('candidate-page')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Feedback due' })).toBeInTheDocument();
  });

  it('with nothing due it says so, and the box counts 0', async () => {
    pending.mockResolvedValue({ data: { actions: OTHER, alerts: [] } });
    await open();
    expect(screen.getByText('No feedback pending')).toBeInTheDocument();
    expect(countOf(box(/^Feedback Due/))).toBe('0');
  });

  it('while the pending actions are on their way it shows a spinner, never the "No feedback pending" answer', async () => {
    let resolve!: (v: unknown) => void;
    pending.mockReturnValue(new Promise(r => { resolve = r; }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^Feedback Due/ }));
    expect(document.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByText('No feedback pending')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Feedback due' })).toBeNull();
    await act(async () => { resolve({ data: { actions: FEEDBACK, alerts: [] } }); });
    expect(await screen.findByText('Test Candidate One')).toBeInTheDocument();
    expect(document.querySelector('.animate-spin')).toBeNull();
  });

  it('the box\'s icon is red when anything is overdue and amber when nothing is', async () => {
    const first = mount();
    await waitFor(() => expect(countOf(box(/^Feedback Due/))).toBe('4'));
    expect(box(/^Feedback Due/).querySelector('svg')?.getAttribute('class')).toContain('text-red-500');
    first.unmount();

    pending.mockResolvedValue({ data: { actions: [FEEDBACK[1], FEEDBACK[2]], alerts: [] } });         // both have 0 hours overdue
    mount();
    await waitFor(() => expect(countOf(box(/^Feedback Due/))).toBe('2'));
    const svg = box(/^Feedback Due/).querySelector('svg');
    expect(svg?.getAttribute('class')).toContain('text-amber-500');
    expect(svg?.getAttribute('class')).not.toContain('text-red-500');
  });
});

describe('My Tasks — Other Pending Actions', () => {
  const open = async () => { mount(); fireEvent.click(await screen.findByRole('button', { name: /^Other Pending Actions/ })); await screen.findByRole('heading', { name: 'Other pending actions' }); };

  it('lists each item with its kind and description, naming the candidate and the role, and linking to the candidate when it can', async () => {
    await open();
    expect(screen.getByText('Resume Shortlist Pending')).toBeInTheDocument();
    expect(screen.getByText('Resume Shortlist Pending #11')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Test Candidate Five' });
    expect(link).toHaveAttribute('href', '/candidates/C9005');
    expect(link.parentElement).toHaveTextContent('Test Candidate Five · Test Role Alpha');
  });

  it('a candidate without an id is named but not linked; an item with only a role names just the role; one with neither names nobody', async () => {
    await open();
    expect(screen.queryByRole('link', { name: 'Test Candidate Six' })).toBeNull();
    expect(screen.getByText('Test Candidate Six · Test Role Beta')).toBeInTheDocument();
    expect(screen.getByText('Test Role Gamma')).toBeInTheDocument();                         // the "Low Pipeline" item: role only, no separator
    expect(screen.queryByText(/· Test Role Gamma/)).toBeNull();
  });

  it('does not list the feedback-due kinds, which have their own box', async () => {
    await open();
    expect(screen.queryByText('Interview 1 Feedback Due')).toBeNull();
    expect(screen.queryByText('Assignment Feedback Due')).toBeNull();
  });

  it('the Leadership notices are shown in a separate panel with their own count, and are not counted in the box', async () => {
    await open();
    expect(screen.getByText('Leadership Alerts (2)')).toBeInTheDocument();
    expect(screen.getByText('Role aging alert')).toBeInTheDocument();
    expect(screen.getByText('Comp change notice')).toBeInTheDocument();
    expect(countOf(box(/^Other Pending Actions/))).toBe('3');
  });

  it('with no notices there is no such panel', async () => {
    pending.mockResolvedValue({ data: { actions: OTHER, alerts: [] } });
    await open();
    expect(screen.queryByText(/Leadership Alerts/)).toBeNull();
  });

  it('with nothing else pending it says so — even when notices exist, since they are not tasks', async () => {
    pending.mockResolvedValue({ data: { actions: FEEDBACK, alerts: ALERTS } });
    await open();
    expect(screen.getByText('Nothing else pending ✓')).toBeInTheDocument();
    expect(countOf(box(/^Other Pending Actions/))).toBe('0');
    expect(screen.getByText('Leadership Alerts (2)')).toBeInTheDocument();
  });

  it('while the pending actions are on their way it shows a spinner, never the "Nothing else pending" answer', async () => {
    pending.mockReturnValue(new Promise(() => {}));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^Other Pending Actions/ }));
    expect(document.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByText('Nothing else pending ✓')).toBeNull();
  });
});

describe('My Tasks — a Hiring Manager', () => {
  beforeEach(() => as('hiring_manager', 'Hana Manager'));
  const roles = (...rows: Array<[string, string]>) => ({ data: { roles: rows.map(([id, hiring_manager_name]) => ({ id, hiring_manager_name })) } });

  it('has the same three boxes as HR/Admin (the pending actions are already theirs, server-side), and no Leadership Alerts box', async () => {
    mount();
    await screen.findByTestId('scorecard');
    for (const name of [/^Ready for Review/, /^Feedback Due/, /^Other Pending Actions/]) expect(box(name)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Leadership Alerts/ })).toBeNull();
    await waitFor(() => expect(countOf(box(/^Feedback Due/))).toBe('4'));
  });

  it('Ready for Review is scoped to the roles whose Hiring Manager field names them, matching whole names and ignoring case and spacing', async () => {
    rolesList.mockResolvedValue(roles(
      ['R9001', 'Hana Manager'], ['R9002', '  hana   MANAGER '], ['R9003', 'Ivan Lead, Hana Manager'], ['R9004', 'Ivan Lead'],
      ['R9005', 'Hana'], ['R9006', 'Hana Managerson'], ['R9007', ''],
    ));
    mount();
    await waitFor(() => expect(lastScope()).toEqual({ ownRoleIds: ['R9001', 'R9002', 'R9003'] }));
  });

  it('a Hiring Manager who owns no role is given the "owns nothing" sentinel, never an empty list that would mean "everyone"', async () => {
    rolesList.mockResolvedValue(roles(['R9004', 'Ivan Lead']));
    mount();
    await waitFor(() => expect(rolesList).toHaveBeenCalled());
    await waitFor(() => expect(lastScope()).toEqual({ ownRoleIds: [SENTINEL] }));
    for (const scope of scopes()) {
      const ids = (scope as { ownRoleIds?: string[] }).ownRoleIds;
      expect(ids, 'every scope ever handed out').toBeDefined();
      expect(ids!.length).toBeGreaterThan(0);
    }
  });

  it('fails closed while the role list is on its way: the very first Ready for Review already carries the sentinel, never an unscoped list', async () => {
    let resolve!: (v: unknown) => void;
    rolesList.mockReturnValue(new Promise(r => { resolve = r; }));
    mount();
    await screen.findByTestId('scorecard');
    expect(scopes()[0]).toEqual({ ownRoleIds: [SENTINEL] });
    expect(lastScope()).toEqual({ ownRoleIds: [SENTINEL] });
    await act(async () => { resolve(roles(['R9001', 'Hana Manager'])); });
    await waitFor(() => expect(lastScope()).toEqual({ ownRoleIds: ['R9001'] }));
  });

  it('fails closed when the role list cannot be read: still the sentinel, and the page still works', async () => {
    rolesList.mockImplementation(async () => { throw new Error('Network Error'); });
    mount();
    await waitFor(() => expect(rolesList).toHaveBeenCalled());
    expect(await screen.findByTestId('scorecard')).toBeInTheDocument();
    expect(lastScope()).toEqual({ ownRoleIds: [SENTINEL] });
    for (const scope of scopes()) expect((scope as { ownRoleIds: string[] }).ownRoleIds).toEqual([SENTINEL]);
  });

  it('shows Ready for Review at once, without waiting for the pending actions', async () => {
    pending.mockReturnValue(new Promise(() => {}));
    mount();
    expect(await screen.findByTestId('scorecard')).toBeInTheDocument();
  });

  it('the role list is the Hiring Manager\'s own: another Hiring Manager signing in on the same tab does not inherit it', async () => {
    const qc = newClient();
    rolesList.mockResolvedValue(roles(['R9001', 'Hana Manager'], ['R9002', 'Ivan Lead']));
    const first = render(tree('/my-tasks', qc));
    await waitFor(() => expect(lastScope()).toEqual({ ownRoleIds: ['R9001'] }));
    first.unmount();

    as('hiring_manager', 'Ivan Lead');
    h.scorecard.mockClear();
    let resolve!: (v: unknown) => void;
    rolesList.mockReturnValue(new Promise(r => { resolve = r; }));
    render(tree('/my-tasks', qc));
    await screen.findByTestId('scorecard');
    expect(lastScope()).toEqual({ ownRoleIds: [SENTINEL] });                                  // not Hana's R9001 from the cache
    await act(async () => { resolve(roles(['R9001', 'Hana Manager'], ['R9002', 'Ivan Lead'])); });
    await waitFor(() => expect(lastScope()).toEqual({ ownRoleIds: ['R9002'] }));
  });

  it('only a Hiring Manager makes the role-list request; HR/Admin, Leadership and Super Admin never do', async () => {
    for (const persona of ['hr_recruiter', 'leadership', 'super_admin']) {
      as(persona);
      const { unmount } = mount();
      await screen.findByTestId('scorecard');
      unmount();
    }
    expect(rolesList).not.toHaveBeenCalled();
    as('hiring_manager', 'Hana Manager');
    mount();
    await waitFor(() => expect(rolesList).toHaveBeenCalledTimes(1));
  });
});

describe('My Tasks — the ?role_id= link from a role page', () => {
  it('opens Ready for Review, whatever section was left on last time', async () => {
    for (const left of ['feedback', 'other', 'sourcing']) {
      sessionStorage.setItem(SECTION_KEY, JSON.stringify(left));
      const { unmount } = mount('/my-tasks?role_id=R9001');
      expect(await screen.findByTestId('scorecard'), left).toBeInTheDocument();
      expect(box(/^Ready for Review/), left).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByRole('heading', { name: 'Feedback due' }), left).toBeNull();
      expect(JSON.parse(sessionStorage.getItem(SECTION_KEY)!), left).toBe('ready');
      unmount();
    }
  });

  it('without it, the section left on last time is kept; an empty role_id is no link at all', async () => {
    sessionStorage.setItem(SECTION_KEY, JSON.stringify('feedback'));
    const first = mount('/my-tasks');
    expect(await screen.findByRole('heading', { name: 'Feedback due' })).toBeInTheDocument();
    first.unmount();

    const second = mount('/my-tasks?role_id=');
    expect(await screen.findByRole('heading', { name: 'Feedback due' })).toBeInTheDocument();
    expect(screen.queryByTestId('scorecard')).toBeNull();
    second.unmount();
  });

  it('works the same for a Hiring Manager', async () => {
    as('hiring_manager', 'Hana Manager');
    sessionStorage.setItem(SECTION_KEY, JSON.stringify('other'));
    mount('/my-tasks?role_id=R9001');
    expect(await screen.findByTestId('scorecard')).toBeInTheDocument();
  });
});

describe('My Tasks — the section is remembered for the tab', () => {
  it('choosing a box stores it, and the next visit opens on it', async () => {
    const first = mount();
    fireEvent.click(await screen.findByRole('button', { name: /^Other Pending Actions/ }));
    expect(JSON.parse(sessionStorage.getItem(SECTION_KEY)!)).toBe('other');
    first.unmount();

    mount();
    expect(await screen.findByRole('heading', { name: 'Other pending actions' })).toBeInTheDocument();
    expect(screen.queryByTestId('scorecard')).toBeNull();
    expect(box(/^Other Pending Actions/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('starts on Ready for Review for a new tab, and when the stored value cannot be read', async () => {
    const first = mount();
    expect(await screen.findByTestId('scorecard')).toBeInTheDocument();
    first.unmount();
    sessionStorage.setItem(SECTION_KEY, '{not json');
    mount();
    expect(await screen.findByTestId('scorecard')).toBeInTheDocument();
  });
});
