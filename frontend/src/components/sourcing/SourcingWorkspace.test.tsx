import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkspaceRole, SourcingWorkspace as Workspace } from '../../types/sourcing.ts';

// A plain function, not vi.fn(): the spy re-throws a rejected result on a derived promise, which vitest reports as an unhandled error.
let workspace: () => Promise<unknown> = async () => ({ data: { enabled: false } });
const workspaceCalls = vi.fn();
vi.mock('../../services/api.ts', () => ({ sourcingApi: { workspace: () => { workspaceCalls(); return workspace(); } } }));

// The panel has its own tests; here it only has to say which role it was given (and when it is mounted afresh).
const panelMounted = vi.fn();
vi.mock('./SourcingPlanPanel.tsx', () => ({
  default: ({ roleId }: { roleId: string }) => {
    useEffect(() => { panelMounted(roleId); }, [roleId]);
    return <div data-testid="plan-panel">Plan of {roleId}</div>;
  },
}));

import SourcingWorkspace from './SourcingWorkspace.tsx';

const role = (id: string, over: Partial<WorkspaceRole> = {}): WorkspaceRole => ({
  role_id: id, title: `Role ${id}`, priority: 'P1', plan_id: `p${id}`, plan_status: 'active', open_exceptions: 0, channels_live: 1,
  qualified: 6, target: 5, behind: false, ...over,
});
const ws = (over: Partial<Workspace> = {}): { data: Workspace } => ({ data: { enabled: true, read_only: false, roles: [role('R1'), role('R2')], drafts: [], ...over } });

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname}{l.search}{l.hash}</div>; }
let qc: QueryClient;
function mount(entry = '/dashboard', props: { heading?: boolean } = {}) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}><SourcingWorkspace {...props} /><Where /></MemoryRouter>
    </QueryClientProvider>,
  );
}
const answers = (body: unknown) => { workspace = async () => body; };
const pill = (id: string) => screen.getByTestId(`role-pill-${id}`);
const where = () => screen.getByTestId('where').textContent;
const scrollIntoView = vi.fn();

beforeEach(() => {
  workspaceCalls.mockReset(); panelMounted.mockReset(); scrollIntoView.mockReset();
  sessionStorage.clear();
  Element.prototype.scrollIntoView = scrollIntoView;
  answers(ws());
});
afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });

describe('SourcingWorkspace — whether it shows', () => {
  it('renders nothing at all while the module is off (default, headed use)', async () => {
    answers({ data: { enabled: false } });
    const { container } = mount();
    await waitFor(() => expect(workspaceCalls).toHaveBeenCalled());
    await waitFor(() => expect(qc.getQueryState(['sourcing-workspace'])?.status).toBe('success'));
    expect(container.querySelector('#sourcing-workspace')).toBeNull();
    expect(screen.queryByText('Sourcing plans')).toBeNull();
    expect(screen.queryByTestId('plan-panel')).toBeNull();
  });

  it('while loading it shows its heading and a spinner, with no pills yet', async () => {
    let release: (v: unknown) => void = () => {};
    workspace = () => new Promise(r => { release = r; });
    const { container } = mount();
    expect(screen.getByRole('heading', { name: 'Sourcing plans' })).toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(container.querySelector('#sourcing-workspace')).not.toBeNull();
    expect(screen.queryByRole('group', { name: 'Roles with a sourcing plan' })).toBeNull();
    release(ws());
    expect(await screen.findByTestId('role-pill-R1')).toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('a failed load says so instead of vanishing', async () => {
    workspace = async () => { throw new Error('boom'); };
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the sourcing plans.");
    expect(screen.getByRole('heading', { name: 'Sourcing plans' })).toBeInTheDocument();
    expect(screen.queryByTestId('plan-panel')).toBeNull();
  });

  it('is a labelled region with the id the links point at', async () => {
    mount();
    const region = await screen.findByRole('region', { name: 'Sourcing plans' });
    expect(region).toHaveAttribute('id', 'sourcing-workspace');
    expect(region).toHaveAttribute('data-testid', 'sourcing-workspace');
  });
});

describe('SourcingWorkspace — the role pills', () => {
  it('shows one pill per role with priority, title, "qualified/target" and "On track"', async () => {
    answers(ws({ roles: [role('R1', { priority: 'P0', title: 'Sr. Backend Developer', qualified: 8, target: 6 })] }));
    mount();
    const p = await screen.findByTestId('role-pill-R1');
    expect(within(p).getByText('P0')).toBeInTheDocument();
    expect(within(p).getByText('Sr. Backend Developer')).toBeInTheDocument();
    expect(within(p).getByText('8/6 qualified')).toBeInTheDocument();
    expect(within(p).getByText('On track')).toBeInTheDocument();
    expect(within(p).queryByText(/issue/)).toBeNull();
  });

  it('says how many issues a role has (singular and plural) and then no longer says "On track"', async () => {
    answers(ws({ roles: [role('R1', { open_exceptions: 1 }), role('R2', { open_exceptions: 3 })] }));
    mount();
    await screen.findByTestId('role-pill-R1');
    expect(within(pill('R1')).getByText('1 issue')).toBeInTheDocument();
    expect(within(pill('R2')).getByText('3 issues')).toBeInTheDocument();
    expect(within(pill('R1')).queryByText('On track')).toBeNull();
    expect(within(pill('R2')).queryByText('On track')).toBeNull();
  });

  it('a role that is behind its target shows its count in red and is not "On track"', async () => {
    answers(ws({ roles: [role('R1', { qualified: 1, target: 5, behind: true }), role('R2', { qualified: 6, target: 5, behind: false })] }));
    mount();
    await screen.findByTestId('role-pill-R1');
    expect(within(pill('R1')).getByText('1/5 qualified').className).toMatch(/text-red-600/);
    expect(within(pill('R1')).queryByText('On track')).toBeNull();
    expect(within(pill('R2')).getByText('6/5 qualified').className).not.toMatch(/text-red/);
  });

  it('a role with no target shows no "qualified" count at all', async () => {
    answers(ws({ roles: [role('R1', { target: null, qualified: 3 })] }));
    mount();
    await screen.findByTestId('role-pill-R1');
    expect(within(pill('R1')).queryByText(/qualified/)).toBeNull();
    expect(within(pill('R1')).getByText('On track')).toBeInTheDocument();
  });

  it('a paused plan reads "On hold" (not its count, not "On track")', async () => {
    answers(ws({ roles: [role('R1', { plan_status: 'paused' })] }));
    mount();
    await screen.findByTestId('role-pill-R1');
    expect(within(pill('R1')).getByText('On hold')).toBeInTheDocument();
    expect(within(pill('R1')).queryByText(/qualified|On track/)).toBeNull();
  });

  it('a draft plan reads "Not activated"', async () => {
    answers(ws({ roles: [], drafts: [role('R9', { plan_status: 'draft', target: null })] }));
    mount();
    await screen.findByTestId('role-pill-R9');
    expect(within(pill('R9')).getByText('Not activated')).toBeInTheDocument();
    expect(within(pill('R9')).queryByText('On track')).toBeNull();
  });

  it('the pills sit in a labelled group', async () => {
    mount();
    const group = await screen.findByRole('group', { name: 'Roles with a sourcing plan' });
    expect(within(group).getAllByRole('button')).toHaveLength(2);
  });
});

describe('SourcingWorkspace — choosing a role', () => {
  it('starts on the first role: it is pressed and the panel is for it', async () => {
    mount();
    await screen.findByTestId('role-pill-R1');
    expect(pill('R1')).toHaveAttribute('aria-pressed', 'true');
    expect(pill('R2')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of R1');
  });

  it('clicking a pill selects it, puts ?sourcing_role= in the URL (replacing, not stacking history) and remembers it for the session', async () => {
    mount();
    await screen.findByTestId('role-pill-R2');
    fireEvent.click(pill('R2'));
    expect(pill('R2')).toHaveAttribute('aria-pressed', 'true');
    expect(pill('R1')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of R2');
    expect(where()).toBe('/dashboard?sourcing_role=R2');
    expect(JSON.parse(sessionStorage.getItem('hms:sourcing.role')!)).toBe('R2');
  });

  it('keeps the other query parameters when it sets its own', async () => {
    mount('/dashboard?priority=P0#sourcing-workspace');
    await screen.findByTestId('role-pill-R2');
    fireEvent.click(pill('R2'));
    expect(where()).toMatch(/^\/dashboard\?priority=P0&sourcing_role=R2/);
  });

  it('mounts the panel afresh for each role (nothing of the previous role\'s dialogs carries over)', async () => {
    mount();
    await screen.findByTestId('plan-panel');
    expect(panelMounted).toHaveBeenLastCalledWith('R1');
    fireEvent.click(pill('R2'));
    expect(panelMounted).toHaveBeenLastCalledWith('R2');
    fireEvent.click(pill('R2'));                                       // the same pill again changes nothing
    expect(panelMounted.mock.calls.filter(c => c[0] === 'R2')).toHaveLength(1);
  });

  it('?sourcing_role= in the URL wins over the remembered role', async () => {
    sessionStorage.setItem('hms:sourcing.role', JSON.stringify('R1'));
    mount('/dashboard?sourcing_role=R2');
    await screen.findByTestId('role-pill-R2');
    expect(pill('R2')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of R2');
  });

  it('with no URL parameter it restores the remembered role', async () => {
    sessionStorage.setItem('hms:sourcing.role', JSON.stringify('R2'));
    mount();
    await screen.findByTestId('role-pill-R2');
    expect(pill('R2')).toHaveAttribute('aria-pressed', 'true');
  });

  it('an unknown role in the URL falls back to the remembered one, then to the first', async () => {
    sessionStorage.setItem('hms:sourcing.role', JSON.stringify('R2'));
    const a = mount('/dashboard?sourcing_role=R404');
    await screen.findByTestId('role-pill-R2');
    expect(pill('R2')).toHaveAttribute('aria-pressed', 'true');
    a.unmount();

    sessionStorage.clear();
    mount('/dashboard?sourcing_role=R404');
    await screen.findByTestId('role-pill-R1');
    expect(pill('R1')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of R1');
  });

  it('a role arrived at by link becomes the remembered one, so the sidebar link next time shows it too', async () => {
    mount('/sourcing?sourcing_role=R2', { heading: false });
    await screen.findByTestId('role-pill-R2');
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('hms:sourcing.role')!)).toBe('R2'));
    cleanup();
    mount('/sourcing', { heading: false });                            // the sidebar link: no query string
    await screen.findByTestId('role-pill-R2');
    expect(pill('R2')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of R2');
  });

  it('a linked role the list does not know is NOT remembered (it must not replace a good remembered role)', async () => {
    sessionStorage.setItem('hms:sourcing.role', JSON.stringify('R1'));
    mount('/sourcing?sourcing_role=R404', { heading: false });
    await screen.findByTestId('role-pill-R1');
    expect(JSON.parse(sessionStorage.getItem('hms:sourcing.role')!)).toBe('R1');
  });

  it('a link to a role that has no plan to show says so, instead of silently showing another role', async () => {
    mount('/sourcing?sourcing_role=R404', { heading: false });
    await screen.findByTestId('role-pill-R1');
    expect(screen.getByTestId('wanted-role-missing')).toHaveTextContent(/That role isn't in the list/);
    expect(screen.getByTestId('wanted-role-missing')).not.toHaveTextContent('R404');   // the id from the URL is never echoed
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of R1');
  });

  it('no note when the linked role is listed, when there is no link, or while it is still loading', async () => {
    mount('/sourcing?sourcing_role=R2', { heading: false });
    await screen.findByTestId('role-pill-R2');
    expect(screen.queryByTestId('wanted-role-missing')).toBeNull();
    cleanup();
    mount('/sourcing', { heading: false });
    await screen.findByTestId('role-pill-R1');
    expect(screen.queryByTestId('wanted-role-missing')).toBeNull();
    cleanup();
    workspace = () => new Promise(() => {});
    mount('/sourcing?sourcing_role=R404', { heading: false });
    await waitFor(() => expect(workspaceCalls).toHaveBeenCalled());
    expect(screen.queryByTestId('wanted-role-missing')).toBeNull();
  });

  it('a linked draft role counts as known: no note, and it is remembered', async () => {
    answers(ws({ roles: [role('R1')], drafts: [role('R9', { plan_status: 'draft' })], drafts_total: 1 }));
    mount('/sourcing?sourcing_role=R9', { heading: false });
    await screen.findByTestId('plan-panel');
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of R9');
    expect(screen.queryByTestId('wanted-role-missing')).toBeNull();
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('hms:sourcing.role')!)).toBe('R9'));
  });

  it('a remembered role that no longer has a plan is ignored', async () => {
    sessionStorage.setItem('hms:sourcing.role', JSON.stringify('R-gone'));
    mount();
    await screen.findByTestId('role-pill-R1');
    expect(pill('R1')).toHaveAttribute('aria-pressed', 'true');
  });

  it('a corrupt remembered value does not break the page', async () => {
    sessionStorage.setItem('hms:sourcing.role', '{not json');
    mount();
    expect(await screen.findByTestId('role-pill-R1')).toBeInTheDocument();
    expect(pill('R1')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('SourcingWorkspace — plans waiting to be activated', () => {
  const drafts = (n: number) => Array.from({ length: n }, (_, i) => role(`D${i + 1}`, { plan_status: 'draft', target: null, title: `Draft role ${i + 1}` }));

  it('lists them behind a disclosure that counts them (singular and plural)', async () => {
    answers(ws({ drafts: drafts(2) }));
    const a = mount();
    expect(await screen.findByText('2 roles have a plan waiting to be activated')).toBeInTheDocument();
    expect(screen.getByTestId('role-pill-D1')).toBeInTheDocument();
    a.unmount();

    answers(ws({ drafts: drafts(1) }));
    mount();
    expect(await screen.findByText('1 role has a plan waiting to be activated')).toBeInTheDocument();
  });

  it('is collapsed while an active role is selected, and no drafts means no disclosure', async () => {
    answers(ws({ drafts: drafts(2) }));
    const a = mount();
    await screen.findByTestId('role-pill-R1');
    expect(a.container.querySelector('details')!.open).toBe(false);
    a.unmount();

    answers(ws({ drafts: [] }));
    const b = mount();
    await screen.findByTestId('role-pill-R1');
    expect(b.container.querySelector('details')).toBeNull();
  });

  it('says how many it is showing when the server capped the list (drafts_total)', async () => {
    answers(ws({ drafts: drafts(3), drafts_total: 57 }));
    mount();
    expect(await screen.findByText('57 roles have a plan waiting to be activated')).toBeInTheDocument();
    expect(screen.getByText('Showing the 3 most urgent of 57.')).toBeInTheDocument();
  });

  it('shows no "most urgent" note when everything is listed', async () => {
    answers(ws({ drafts: drafts(3), drafts_total: 3 }));
    mount();
    await screen.findByText('3 roles have a plan waiting to be activated');
    expect(screen.queryByText(/most urgent/)).toBeNull();
  });

  it('selecting a draft shows its panel (where "Activate plan" lives) and opens the disclosure', async () => {
    answers(ws({ drafts: drafts(2) }));
    const { container } = mount();
    await screen.findByTestId('role-pill-D2');
    fireEvent.click(pill('D2'));
    expect(pill('D2')).toHaveAttribute('aria-pressed', 'true');
    expect(pill('R1')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of D2');
    expect(container.querySelector('details')!.open).toBe(true);
    expect(where()).toBe('/dashboard?sourcing_role=D2');
  });

  it('opens a draft straight from a link (My Tasks "Activate")', async () => {
    answers(ws({ drafts: drafts(2) }));
    const { container } = mount('/dashboard?sourcing_role=D1#sourcing-workspace');
    await screen.findByTestId('role-pill-D1');
    expect(pill('D1')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of D1');
    expect(container.querySelector('details')!.open).toBe(true);
  });

  it('with no active role it says so, opens the drafts and selects the first one', async () => {
    answers(ws({ roles: [], drafts: drafts(2) }));
    const { container } = mount();
    expect(await screen.findByText('No plan is active yet. Open one of the roles below and activate it.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Roles with a sourcing plan' })).toBeNull();
    expect(container.querySelector('details')!.open).toBe(true);
    expect(pill('D1')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of D1');
  });
});

describe('SourcingWorkspace — empty states and the read-only view', () => {
  it('HR with nothing to show is told to approve a role', async () => {
    answers(ws({ roles: [], drafts: [] }));
    mount();
    expect(await screen.findByText('No sourcing plans yet')).toBeInTheDocument();
    expect(screen.getByText('A plan is created for every open role. Approve a role and it will appear here.')).toBeInTheDocument();
    expect(screen.queryByTestId('plan-panel')).toBeNull();
  });

  it('a Hiring Manager with nothing to show is told a plan appears once HR activates one', async () => {
    answers(ws({ read_only: true, roles: [], drafts: [] }));
    mount();
    expect(await screen.findByText('No sourcing plans yet')).toBeInTheDocument();
    expect(screen.getByText('A plan appears here once HR activates one for a role you are hiring for.')).toBeInTheDocument();
    expect(screen.queryByText(/Approve a role/)).toBeNull();
  });

  it('a Hiring Manager\'s workspace lists their roles and shows the plan of the selected one', async () => {
    answers(ws({ read_only: true, roles: [role('R5', { title: 'QA Engineer' })], drafts: [] }));
    mount();
    expect(await screen.findByTestId('role-pill-R5')).toBeInTheDocument();
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of R5');
    expect(screen.queryByText(/waiting to be activated/)).toBeNull();
    expect(screen.queryByText('No sourcing plans yet')).toBeNull();
  });
});

describe('SourcingWorkspace — arriving by a link', () => {
  it('scrolls itself into view once loaded when the URL hash is #sourcing-workspace', async () => {
    mount('/dashboard#sourcing-workspace');
    await screen.findByTestId('role-pill-R1');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById('sourcing-workspace'));
  });

  it('also scrolls when only ?sourcing_role= is present', async () => {
    mount('/dashboard?sourcing_role=R2');
    await screen.findByTestId('role-pill-R2');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
  });

  it('does not scroll while it is still loading', async () => {
    workspace = () => new Promise(() => {});
    mount('/dashboard#sourcing-workspace');
    await new Promise(r => setTimeout(r, 20));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('does not scroll on a plain visit, nor when the user picks a pill themselves', async () => {
    mount();
    await screen.findByTestId('role-pill-R1');
    fireEvent.click(pill('R2'));
    await waitFor(() => expect(pill('R2')).toHaveAttribute('aria-pressed', 'true'));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('does not scroll again when the user then picks another role', async () => {
    mount('/dashboard#sourcing-workspace');
    await screen.findByTestId('role-pill-R1');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    fireEvent.click(pill('R2'));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('does not throw where scrollIntoView does not exist (jsdom, old browsers)', async () => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    mount('/dashboard#sourcing-workspace');
    expect(await screen.findByTestId('role-pill-R1')).toBeInTheDocument();
  });
});

// ── The Sourcing page (sidebar → Sourcing) shows this component under its own h1, so it is mounted with heading={false}; the Dashboard-era default
// (heading shown, scroll into view when you arrive by a link) must stay exactly as it was for anything that still mounts it bare.
const HEADING = 'Sourcing plans';
const SUBLINE = /pick a role to see its channels, weekly results, next steps and history/;
const settle = () => new Promise(r => setTimeout(r, 20));
const sectionHeading = () => screen.queryByRole('heading', { name: HEADING });

describe('SourcingWorkspace — the section heading (heading prop)', () => {
  it('is shown by default, with its sub-line, once the plans have loaded', async () => {
    mount();
    await screen.findByTestId('role-pill-R1');
    expect(screen.getByRole('heading', { level: 2, name: HEADING })).toBeInTheDocument();
    expect(screen.getByText(SUBLINE)).toBeInTheDocument();
  });

  it('heading={true} is the same as leaving it out', async () => {
    mount('/dashboard', { heading: true });
    await screen.findByTestId('role-pill-R1');
    expect(screen.getByRole('heading', { level: 2, name: HEADING })).toBeInTheDocument();
    expect(screen.getByText(SUBLINE)).toBeInTheDocument();
  });

  it('is shown by default in every state: loading, failed, empty and read-only', async () => {
    let release: (v: unknown) => void = () => {};
    workspace = () => new Promise(r => { release = r; });
    const a = mount();
    expect(sectionHeading()).toBeInTheDocument();                                     // loading
    release(ws({ roles: [], drafts: [] }));
    await screen.findByText('No sourcing plans yet');
    expect(sectionHeading()).toBeInTheDocument();                                     // empty
    a.unmount();

    answers(ws({ read_only: true, roles: [], drafts: [] }));
    const b = mount();
    await screen.findByText('No sourcing plans yet');
    expect(sectionHeading()).toBeInTheDocument();                                     // read-only empty
    b.unmount();

    workspace = async () => { throw new Error('boom'); };
    mount();
    await screen.findByRole('alert');
    expect(sectionHeading()).toBeInTheDocument();                                     // failed
  });

  it('heading={false} draws no section heading and no sub-line once the plans have loaded', async () => {
    mount('/sourcing', { heading: false });
    await screen.findByTestId('role-pill-R1');
    expect(sectionHeading()).toBeNull();
    // Only a screen-reader-only h2 ("Plans by role"), so the plan's h3 headings do not hang straight under the page's h1; nothing visible is added.
    const headings = screen.queryAllByRole('heading');
    expect(headings.map(h => h.textContent)).toEqual(['Plans by role']);
    expect(headings[0].tagName).toBe('H2');
    expect(headings[0]).toHaveClass('sr-only');
    expect(screen.queryByText(SUBLINE)).toBeNull();
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  it('heading={false} draws none while loading either — just the spinner', async () => {
    workspace = () => new Promise(() => {});
    const { container } = mount('/sourcing', { heading: false });
    await waitFor(() => expect(workspaceCalls).toHaveBeenCalled());
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(container.querySelector('#sourcing-workspace')).not.toBeNull();
    expect(sectionHeading()).toBeNull();
    expect(screen.queryAllByRole('heading')).toHaveLength(0);
    expect(screen.queryByText(SUBLINE)).toBeNull();
  });

  it('heading={false} draws none when the load fails — the alert stands alone', async () => {
    workspace = async () => { throw new Error('boom'); };
    mount('/sourcing', { heading: false });
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the sourcing plans.");
    expect(sectionHeading()).toBeNull();
    expect(screen.queryAllByRole('heading')).toHaveLength(0);
  });

  it('heading={false} draws none in the empty states (HR and Hiring Manager wording unchanged)', async () => {
    answers(ws({ roles: [], drafts: [] }));
    const a = mount('/sourcing', { heading: false });
    expect(await screen.findByText('No sourcing plans yet')).toBeInTheDocument();
    expect(screen.getByText('A plan is created for every open role. Approve a role and it will appear here.')).toBeInTheDocument();
    expect(sectionHeading()).toBeNull();
    a.unmount();

    answers(ws({ read_only: true, roles: [], drafts: [] }));
    mount('/sourcing', { heading: false });
    expect(await screen.findByText('No sourcing plans yet')).toBeInTheDocument();
    expect(screen.getByText('A plan appears here once HR activates one for a role you are hiring for.')).toBeInTheDocument();
    expect(sectionHeading()).toBeNull();
  });

  it('heading={false} (the Sourcing page) says "switched off" while the module is off, instead of a blank body', async () => {
    answers({ data: { enabled: false } });
    const { container } = mount('/sourcing', { heading: false });
    await waitFor(() => expect(qc.getQueryState(['sourcing-workspace'])?.status).toBe('success'));
    expect(container.querySelector('#sourcing-workspace')).toBeNull();
    expect(screen.getByText('Sourcing is switched off')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is being tracked or chased while it is off/)).toBeInTheDocument();
    expect(screen.queryByTestId('plan-panel')).toBeNull();
  });

  it('the default (heading shown) still renders nothing at all while the module is off', async () => {
    answers({ data: { enabled: false } });
    const { container } = mount('/dashboard');
    await waitFor(() => expect(qc.getQueryState(['sourcing-workspace'])?.status).toBe('success'));
    expect(screen.queryByText('Sourcing is switched off')).toBeNull();
    expect(Array.from(container.children)).toEqual([screen.getByTestId('where')]);    // nothing but the test's own location readout
  });

  it('heading={false} keeps the labelled region and the id the links point at', async () => {
    mount('/sourcing', { heading: false });
    const region = await screen.findByRole('region', { name: HEADING });               // the accessible name stays even though no heading is drawn
    expect(region).toHaveAttribute('id', 'sourcing-workspace');
    expect(region).toHaveAttribute('data-testid', 'sourcing-workspace');
  });

  it('heading={false} leaves no visible spacer where the heading was: after the screen-reader-only h2 the role pills come first', async () => {
    mount('/sourcing', { heading: false });
    const region = await screen.findByTestId('sourcing-workspace');
    expect(region.children[0].tagName).toBe('H2');
    expect(region.children[0]).toHaveClass('sr-only');
    expect(region.children[1]).toHaveAttribute('role', 'group');
    expect(region.children[1]).toHaveAttribute('aria-label', 'Roles with a sourcing plan');
  });

  it('heading={false} changes nothing else: same pills, same panel, and picking a role writes ?sourcing_role= on /sourcing', async () => {
    mount('/sourcing', { heading: false });
    await screen.findByTestId('role-pill-R2');
    expect(within(screen.getByRole('group', { name: 'Roles with a sourcing plan' })).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of R1');
    fireEvent.click(pill('R2'));
    expect(pill('R2')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of R2');
    expect(where()).toBe('/sourcing?sourcing_role=R2');
    expect(JSON.parse(sessionStorage.getItem('hms:sourcing.role')!)).toBe('R2');
  });

  it('heading={false} still opens a draft named in the URL, and lists drafts behind their disclosure', async () => {
    answers(ws({ drafts: [role('D1', { plan_status: 'draft', target: null, title: 'Draft role 1' })] }));
    const { container } = mount('/sourcing?sourcing_role=D1', { heading: false });
    await screen.findByTestId('role-pill-D1');
    expect(pill('D1')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('1 role has a plan waiting to be activated')).toBeInTheDocument();
    expect(container.querySelector('details')!.open).toBe(true);
    expect(sectionHeading()).toBeNull();
  });
});

describe('SourcingWorkspace — the scroll nudge (heading prop)', () => {
  it('by default scrolls into view once, when you arrive by ?sourcing_role=', async () => {
    mount('/dashboard?sourcing_role=R2');
    await screen.findByTestId('role-pill-R2');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById('sourcing-workspace'));
    expect(pill('R2')).toHaveAttribute('aria-pressed', 'true');
  });

  it('heading={true} scrolls exactly as the default does (role, hash, and both together — still once)', async () => {
    for (const entry of ['/dashboard?sourcing_role=R2', '/dashboard#sourcing-workspace', '/dashboard?sourcing_role=R2#sourcing-workspace']) {
      scrollIntoView.mockReset();
      const view = mount(entry, { heading: true });
      await screen.findByTestId('role-pill-R1');
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      await settle();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });

  it('by default it still does not scroll on a plain visit', async () => {
    mount('/dashboard');
    await screen.findByTestId('role-pill-R1');
    await settle();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('heading={false} never scrolls: not for ?sourcing_role=, not for the old #sourcing-workspace hash, not for both', async () => {
    for (const entry of ['/sourcing?sourcing_role=R2', '/sourcing#sourcing-workspace', '/sourcing?sourcing_role=R2#sourcing-workspace']) {
      const view = mount(entry, { heading: false });
      await screen.findByTestId('role-pill-R1');
      await settle();
      expect(scrollIntoView).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it('heading={false} still selects the linked role without scrolling (only the nudge is switched off)', async () => {
    mount('/sourcing?sourcing_role=R2', { heading: false });
    await screen.findByTestId('role-pill-R2');
    await settle();
    expect(pill('R2')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of R2');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('heading={false} does not scroll for a linked draft, an empty workspace or a read-only one either', async () => {
    answers(ws({ drafts: [role('D1', { plan_status: 'draft', target: null })] }));
    const a = mount('/sourcing?sourcing_role=D1#sourcing-workspace', { heading: false });
    await screen.findByTestId('role-pill-D1');
    await settle();
    a.unmount();

    answers(ws({ roles: [], drafts: [] }));
    const b = mount('/sourcing?sourcing_role=R2#sourcing-workspace', { heading: false });
    await screen.findByText('No sourcing plans yet');
    await settle();
    b.unmount();

    answers(ws({ read_only: true, roles: [role('R5')] }));
    mount('/sourcing?sourcing_role=R5#sourcing-workspace', { heading: false });
    await screen.findByTestId('role-pill-R5');
    await settle();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('heading={false} does not scroll when the user picks a role, or while it is still loading', async () => {
    workspace = () => new Promise(() => {});
    const a = mount('/sourcing?sourcing_role=R2', { heading: false });
    await settle();
    expect(scrollIntoView).not.toHaveBeenCalled();
    a.unmount();

    answers(ws());
    mount('/sourcing', { heading: false });
    await screen.findByTestId('role-pill-R1');
    fireEvent.click(pill('R2'));
    await waitFor(() => expect(pill('R2')).toHaveAttribute('aria-pressed', 'true'));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('heading={false} does not throw where scrollIntoView does not exist', async () => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    mount('/sourcing?sourcing_role=R2', { heading: false });
    expect(await screen.findByTestId('role-pill-R2')).toBeInTheDocument();
  });
});
