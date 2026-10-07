import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// My Tasks is persona-scoped. What is under test here is the Leadership user who is ALSO the named Hiring
// Manager of a role (Mansi Jain / Head of Marketing): she stays Leadership, but works that role's Hiring
// Manager queue and ready list. Everything the page renders around that is mocked.
const pending = vi.fn();
const rolesList = vi.fn();
vi.mock('../services/api.ts', () => ({
  dashboardApi: { pending: () => pending() },
  rolesApi: { list: () => rolesList() },
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
  pending.mockReset(); rolesList.mockReset(); scorecardProps.mockReset();
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
