import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkspaceRole, SourcingWorkspace as Workspace } from '../types/sourcing.ts';

// The Sourcing page is not persona-aware (the workspace endpoint decides what each persona gets), so AuthContext is deliberately NOT mocked
// here: if the page ever called useAuth() this file would throw "useAuth must be used within AuthProvider".
// Plain functions, not vi.fn() rejections: a spy re-throws a rejected result on a derived promise, which vitest reports as an unhandled error.
let status: () => Promise<unknown> = async () => ({ data: { enabled: false } });
let workspace: () => Promise<unknown> = async () => ({ data: { enabled: false } });
const statusCalls = vi.fn();
const workspaceCalls = vi.fn();
vi.mock('../services/api.ts', () => ({
  sourcingApi: {
    status:    () => { statusCalls(); return status(); },
    workspace: () => { workspaceCalls(); return workspace(); },
  },
}));

// The plan panel has its own tests; the workspace around it is the REAL component (wrapped only so the page's props to it can be read).
vi.mock('../components/sourcing/SourcingPlanPanel.tsx', () => ({
  default: ({ roleId }: { roleId: string }) => <div data-testid="plan-panel">Plan of {roleId}</div>,
}));
const workspaceProps = vi.fn();
const workspaceMounted = vi.fn();
vi.mock('../components/sourcing/SourcingWorkspace.tsx', async () => {
  const actual = await vi.importActual<typeof import('../components/sourcing/SourcingWorkspace.tsx')>('../components/sourcing/SourcingWorkspace.tsx');
  const Actual = actual.default;
  return {
    default: (props: { heading?: boolean }) => {
      workspaceProps(props);
      useEffect(() => { workspaceMounted(); }, []);
      return <Actual {...props} />;
    },
  };
});

import Sourcing from './Sourcing.tsx';

const SUBTITLE = 'Pick a role to see its channels, weekly results, recommended next steps and history.';
const OFF_TITLE = 'Sourcing is switched off';
const OFF_MESSAGE = 'The Sourcing module is not enabled for HMS right now. Nothing is being tracked or chased while it is off.';

const role = (id: string, over: Partial<WorkspaceRole> = {}): WorkspaceRole => ({
  role_id: id, title: `Role ${id}`, priority: 'P1', plan_id: `p${id}`, plan_status: 'active', open_exceptions: 0, channels_live: 1,
  qualified: 6, target: 5, behind: false, ...over,
});
const ws = (over: Partial<Workspace> = {}): { data: Workspace } => ({ data: { enabled: true, read_only: false, roles: [role('R1'), role('R2')], drafts: [], ...over } });

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname}{l.search}{l.hash}</div>; }
let qc: QueryClient;
function mount(entry = '/sourcing') {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}><Sourcing /><Where /></MemoryRouter>
    </QueryClientProvider>,
  );
}
const answers = (s: unknown, w: unknown = ws()) => { status = async () => s; workspace = async () => w; };
const never = () => new Promise<never>(() => {});
const scrollIntoView = vi.fn();

beforeEach(() => {
  statusCalls.mockReset(); workspaceCalls.mockReset(); workspaceProps.mockReset(); workspaceMounted.mockReset(); scrollIntoView.mockReset();
  sessionStorage.clear();
  Element.prototype.scrollIntoView = scrollIntoView;
  answers({ data: { enabled: true } });
});
afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });

describe('Sourcing page — the title is always there', () => {
  it('has one h1 "Sourcing" and the subtitle while the status is loading', () => {
    status = never;
    mount();
    expect(screen.getByRole('heading', { level: 1, name: 'Sourcing' })).toBeInTheDocument();
    expect(screen.getByText(SUBTITLE)).toBeInTheDocument();
  });

  it('has the same h1 and subtitle when the module is off', async () => {
    answers({ data: { enabled: false } });
    mount();
    await screen.findByText(OFF_TITLE);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Sourcing$/);
    expect(screen.getByText(SUBTITLE)).toBeInTheDocument();
  });

  it('has the same h1 and subtitle when the module is on — exactly once', async () => {
    mount();
    await screen.findByTestId('role-pill-R1');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Sourcing$/);
    expect(screen.getAllByText(SUBTITLE)).toHaveLength(1);
  });
});

describe('Sourcing page — loading', () => {
  it('shows a spinner card and neither the off message nor the workspace while the module status is unknown', async () => {
    status = never;
    const { container } = mount();
    await waitFor(() => expect(statusCalls).toHaveBeenCalled());
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByText(OFF_TITLE)).toBeNull();
    expect(screen.queryByText(OFF_MESSAGE)).toBeNull();
    expect(screen.queryByTestId('sourcing-workspace')).toBeNull();
    expect(workspaceProps).not.toHaveBeenCalled();
    expect(workspaceCalls).not.toHaveBeenCalled();                    // the workspace is not even requested on a guess
  });

  it('replaces the spinner with the workspace once the status says the module is on', async () => {
    let release: (v: unknown) => void = () => {};
    status = () => new Promise(r => { release = r; });
    const { container } = mount();
    await waitFor(() => expect(statusCalls).toHaveBeenCalled());
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    release({ data: { enabled: true } });
    expect(await screen.findByTestId('role-pill-R1')).toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(screen.queryByText(OFF_TITLE)).toBeNull();
  });

  it('replaces the spinner with the off message once the status says the module is off', async () => {
    let release: (v: unknown) => void = () => {};
    status = () => new Promise(r => { release = r; });
    const { container } = mount();
    await waitFor(() => expect(statusCalls).toHaveBeenCalled());
    release({ data: { enabled: false } });
    expect(await screen.findByText(OFF_TITLE)).toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });
});

describe('Sourcing page — module off', () => {
  beforeEach(() => answers({ data: { enabled: false } }));

  it('shows the "switched off" empty state with its exact wording', async () => {
    mount();
    expect(await screen.findByText(OFF_TITLE)).toBeInTheDocument();
    expect(screen.getByText(OFF_MESSAGE)).toBeInTheDocument();
  });

  it('mounts no workspace and never asks for one', async () => {
    const { container } = mount();
    await screen.findByText(OFF_TITLE);
    expect(workspaceProps).not.toHaveBeenCalled();
    expect(workspaceCalls).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sourcing-workspace')).toBeNull();
    expect(container.querySelector('#sourcing-workspace')).toBeNull();
    expect(screen.queryByTestId('plan-panel')).toBeNull();
  });

  it('is the same with a role in the URL (a stale link while the module is off)', async () => {
    mount('/sourcing?sourcing_role=R2');
    expect(await screen.findByText(OFF_TITLE)).toBeInTheDocument();
    expect(workspaceCalls).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('Sourcing page — status call fails', () => {
  // Nothing sourcing-related is shown on a guess, but a failed read must not be reported as "switched off": it says the check failed and offers a retry.
  it('mounts no workspace, stops spinning and keeps the title', async () => {
    status = async () => { throw new Error('boom'); };
    const { container } = mount();
    await waitFor(() => expect(qc.getQueryState(['sourcing-status'])?.status).toBe('error'));
    await waitFor(() => expect(container.querySelector('.animate-spin')).toBeNull());
    expect(screen.getByRole('heading', { level: 1, name: 'Sourcing' })).toBeInTheDocument();
    expect(screen.queryByTestId('sourcing-workspace')).toBeNull();
    expect(workspaceProps).not.toHaveBeenCalled();
    expect(workspaceCalls).not.toHaveBeenCalled();
  });

  it('says the check failed — it does NOT claim the module is switched off', async () => {
    status = async () => { throw new Error('boom'); };
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't check whether Sourcing is switched on");
    expect(screen.queryByText(OFF_TITLE)).toBeNull();
    expect(screen.queryByText(OFF_MESSAGE)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('Try again asks the status question again and, once it answers "on", shows the plans', async () => {
    status = async () => { throw new Error('boom'); };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(statusCalls).toHaveBeenCalledTimes(2));
    status = async () => ({ data: { enabled: true } });
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('sourcing-workspace')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(statusCalls).toHaveBeenCalledTimes(3);
  });

  it('Try again that finds the module off says "switched off" (a real answer, not a failure)', async () => {
    status = async () => { throw new Error('boom'); };
    mount();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    status = async () => ({ data: { enabled: false } });
    fireEvent.click(retry);
    expect(await screen.findByText(OFF_TITLE)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Sourcing page — the status says on but the workspace says off (a flag turned off while the tab was open)', () => {
  it('shows the "switched off" message instead of an empty page body', async () => {
    answers({ data: { enabled: true } }, { data: { enabled: false } });
    mount();
    expect(await screen.findByText(OFF_TITLE)).toBeInTheDocument();
    expect(screen.getByText(OFF_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByTestId('sourcing-workspace')).toBeNull();
  });
});

describe('Sourcing page — module on', () => {
  it('renders the workspace and tells it NOT to draw its own heading (heading={false}, not merely absent)', async () => {
    mount();
    expect(await screen.findByTestId('sourcing-workspace')).toBeInTheDocument();
    expect(workspaceProps).toHaveBeenCalled();
    for (const call of workspaceProps.mock.calls) expect(call[0].heading).toBe(false);
    expect(workspaceMounted).toHaveBeenCalledTimes(1);                // mounted once — not once for the spinner and again for the plans
    expect(screen.queryByText(OFF_TITLE)).toBeNull();
  });

  it('shows no duplicate "Sourcing plans" section heading under the page title, but keeps the labelled region the links target', async () => {
    mount();
    const region = await screen.findByRole('region', { name: 'Sourcing plans' });
    expect(region).toHaveAttribute('id', 'sourcing-workspace');
    expect(screen.queryByRole('heading', { name: 'Sourcing plans' })).toBeNull();
    expect(screen.queryByText(/pick a role to see its channels, weekly results, next steps and history/)).toBeNull();   // the section's own sub-line
    // The outline stays h1 → h2 → h3…: the page's h1, then one screen-reader-only h2 that the plan's own h3 headings hang under (nothing visible is added).
    const headings = screen.getAllByRole('heading');
    expect(headings.map(h => h.textContent)).toEqual(['Sourcing', 'Plans by role']);
    expect(headings.map(h => h.tagName)).toEqual(['H1', 'H2']);
    expect(headings[1]).toHaveClass('sr-only');
  });

  it('lists the roles that have a plan and shows the first one\'s plan', async () => {
    mount();
    const group = await screen.findByRole('group', { name: 'Roles with a sourcing plan' });
    expect(within(group).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByTestId('role-pill-R1')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of R1');
  });

  it('opens the role named in the URL, with no scroll nudge (the plan is already at the top of its own page)', async () => {
    mount('/sourcing?sourcing_role=R2');
    await screen.findByTestId('role-pill-R2');
    expect(screen.getByTestId('role-pill-R2')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of R2');
    await new Promise(r => setTimeout(r, 20));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('does not scroll for the legacy #sourcing-workspace hash either', async () => {
    mount('/sourcing?sourcing_role=R2#sourcing-workspace');
    await screen.findByTestId('role-pill-R2');
    await new Promise(r => setTimeout(r, 20));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('picking another role stays on /sourcing and writes ?sourcing_role= there', async () => {
    mount();
    await screen.findByTestId('role-pill-R2');
    fireEvent.click(screen.getByTestId('role-pill-R2'));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/sourcing\?sourcing_role=R2$/);
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of R2');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('asks for the module status once and the workspace once (the page and the workspace do not both poll)', async () => {
    mount();
    await screen.findByTestId('role-pill-R1');
    expect(statusCalls).toHaveBeenCalledTimes(1);
    expect(workspaceCalls).toHaveBeenCalledTimes(1);
  });

  it('shows the workspace\'s own empty state for a role-less module (HR with no plans yet)', async () => {
    answers({ data: { enabled: true } }, ws({ roles: [], drafts: [] }));
    mount();
    expect(await screen.findByText('No sourcing plans yet')).toBeInTheDocument();
    expect(screen.queryByText(OFF_TITLE)).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('shows the read-only (Hiring Manager) workspace the same way, still without a section heading', async () => {
    answers({ data: { enabled: true } }, ws({ read_only: true, roles: [role('R5', { title: 'QA Engineer' })] }));
    mount();
    expect(await screen.findByTestId('role-pill-R5')).toBeInTheDocument();
    expect(screen.getByTestId('plan-panel')).toHaveTextContent('Plan of R5');
    expect(screen.queryByRole('heading', { name: 'Sourcing plans' })).toBeNull();
  });

  it('keeps the title and the module answer when the workspace itself fails to load (the workspace says so)', async () => {
    answers({ data: { enabled: true } });
    workspace = async () => { throw new Error('boom'); };
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the sourcing plans.");
    expect(screen.getByRole('heading', { level: 1, name: 'Sourcing' })).toBeInTheDocument();
    expect(screen.queryByText(OFF_TITLE)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Sourcing plans' })).toBeNull();
  });
});
