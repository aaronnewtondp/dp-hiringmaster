import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// A plain function, not vi.fn(): the spy re-throws a rejected result on a derived promise, which vitest reports as an unhandled error.
let status: () => Promise<unknown> = async () => ({ data: { enabled: false } });
const statusCalls = vi.fn();
vi.mock('../../services/api.ts', () => ({ sourcingApi: { status: () => { statusCalls(); return status(); } } }));

// Same derivation as AuthContext's own `canHR` / `isSuperAdmin`, driven by the persona the test picks.
type Persona = 'hr_recruiter' | 'hiring_manager' | 'leadership' | 'super_admin';
let persona: Persona = 'hr_recruiter';
const logout = vi.fn();
vi.mock('../../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({
    user: { id: 'u1', name: 'Test User', email: 'test.user@digitalpaani.com', persona },
    logout,
    canHR: persona === 'hr_recruiter' || persona === 'leadership' || persona === 'super_admin',
    isSuperAdmin: persona === 'super_admin',
  }),
}));

import Sidebar from './Sidebar.tsx';

const PERSONAS: Persona[] = ['hr_recruiter', 'hiring_manager', 'leadership', 'super_admin'];

// The nav, in order, for each persona while the Sourcing module is ON. Agencies is HR-tier only (HR/Admin, Leadership, Super Admin), User
// Management is Super Admin only; every persona gets Sourcing, between Roles and Active Candidates.
const NAV_WITH_SOURCING: Record<Persona, string[]> = {
  hr_recruiter:   ['Dashboard', 'Roles', 'Sourcing', 'Active Candidates', 'Archived Pipeline', 'My Tasks', 'Agencies', 'Help / FAQ'],
  hiring_manager: ['Dashboard', 'Roles', 'Sourcing', 'Active Candidates', 'Archived Pipeline', 'My Tasks', 'Help / FAQ'],
  leadership:     ['Dashboard', 'Roles', 'Sourcing', 'Active Candidates', 'Archived Pipeline', 'My Tasks', 'Agencies', 'Help / FAQ'],
  super_admin:    ['Dashboard', 'Roles', 'Sourcing', 'Active Candidates', 'Archived Pipeline', 'My Tasks', 'Agencies', 'User Management', 'Help / FAQ'],
};
const without = (labels: string[], drop: string) => labels.filter(l => l !== drop);

let qc: QueryClient;
function mount(entry = '/dashboard', onClose: () => void = () => {}) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}><Sidebar open={false} onClose={onClose} /></MemoryRouter>
    </QueryClientProvider>,
  );
}
const nav = () => screen.getByRole('navigation');
const navLabels = () => within(nav()).getAllByRole('link').map(a => a.textContent);
const sourcingLink = () => within(nav()).queryByRole('link', { name: 'Sourcing' });
const answers = (body: unknown) => { status = async () => body; };
const fails = () => { status = async () => { throw new Error('boom'); }; };
const settled = (state: 'success' | 'error') => waitFor(() => expect(qc.getQueryState(['sourcing-status'])?.status).toBe(state));

beforeEach(() => {
  statusCalls.mockReset(); logout.mockReset();
  persona = 'hr_recruiter';
  answers({ data: { enabled: false } });
});

describe.each(PERSONAS)('Sidebar — the Sourcing entry for %s', (who) => {
  beforeEach(() => { persona = who; });

  it('is not there while the module status is still loading', async () => {
    status = () => new Promise(() => {});                              // never answers
    mount();
    await waitFor(() => expect(statusCalls).toHaveBeenCalled());
    expect(sourcingLink()).toBeNull();
    expect(screen.queryByText('Sourcing')).toBeNull();
    expect(navLabels()).toEqual(without(NAV_WITH_SOURCING[who], 'Sourcing'));   // nothing else is held back by the status
  });

  it('is not there when the module is switched off', async () => {
    answers({ data: { enabled: false } });
    mount();
    await settled('success');
    expect(sourcingLink()).toBeNull();
    expect(navLabels()).toEqual(without(NAV_WITH_SOURCING[who], 'Sourcing'));
  });

  it('is not there when the status call fails', async () => {
    fails();
    mount();
    await settled('error');
    expect(sourcingLink()).toBeNull();
    expect(navLabels()).toEqual(without(NAV_WITH_SOURCING[who], 'Sourcing'));
  });

  it('is there once the module is on: /sourcing, labelled "Sourcing", after Roles and before Active Candidates', async () => {
    answers({ data: { enabled: true } });
    mount();
    const link = await within(nav()).findByRole('link', { name: 'Sourcing' });
    expect(link).toHaveAttribute('href', '/sourcing');
    const labels = navLabels();
    expect(labels.indexOf('Sourcing')).toBe(labels.indexOf('Roles') + 1);
    expect(labels.indexOf('Sourcing')).toBe(labels.indexOf('Active Candidates') - 1);
    expect(labels).toEqual(NAV_WITH_SOURCING[who]);                    // and the rest of the menu is exactly this persona's, nothing gained or lost
  });

  it('keeps Agencies HR-tier only and User Management Super-Admin only whether or not Sourcing is shown', async () => {
    const hrTier = who !== 'hiring_manager';
    for (const enabled of [false, true]) {
      answers({ data: { enabled } });
      const view = mount();
      await settled('success');
      expect(!!within(nav()).queryByRole('link', { name: 'Agencies' })).toBe(hrTier);
      expect(!!within(nav()).queryByRole('link', { name: 'User Management' })).toBe(who === 'super_admin');
      expect(!!sourcingLink()).toBe(enabled);
      view.unmount();
    }
  });
});

describe('Sidebar — the Sourcing entry, other cases', () => {
  it('asks the module status once, through the shared sourcing-status query', async () => {
    answers({ data: { enabled: true } });
    mount();
    await within(nav()).findByRole('link', { name: 'Sourcing' });
    expect(statusCalls).toHaveBeenCalledTimes(1);
    expect(qc.getQueryData(['sourcing-status'])).toEqual({ data: { enabled: true } });
  });

  it('shows it only for enabled === true — a status answer without the flag, or with a truthy non-boolean, does not count', async () => {
    for (const body of [{ data: {} }, { data: { enabled: 'true' } }, { data: { enabled: 1 } }, { data: { enabled: null } }, {}]) {
      answers(body);
      const view = mount();
      await settled('success');
      expect(sourcingLink()).toBeNull();
      view.unmount();
    }
  });

  it('appears as soon as an already-open sidebar learns the module is on (no remount needed)', async () => {
    let release: (v: unknown) => void = () => {};
    status = () => new Promise(r => { release = r; });
    mount();
    await waitFor(() => expect(statusCalls).toHaveBeenCalled());
    expect(sourcingLink()).toBeNull();
    release({ data: { enabled: true } });
    expect(await within(nav()).findByRole('link', { name: 'Sourcing' })).toBeInTheDocument();
  });

  it('is the current page at /sourcing, with or without ?sourcing_role=, and Roles is not', async () => {
    answers({ data: { enabled: true } });
    for (const entry of ['/sourcing', '/sourcing?sourcing_role=R5']) {
      const view = mount(entry);
      const link = await within(nav()).findByRole('link', { name: 'Sourcing' });
      expect(link).toHaveAttribute('aria-current', 'page');
      expect(link.className).toMatch(/border-dp-200/);
      expect(within(nav()).getByRole('link', { name: 'Roles' })).not.toHaveAttribute('aria-current');
      expect(within(nav()).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
      view.unmount();
    }
  });

  it('is not the current page on the Dashboard', async () => {
    answers({ data: { enabled: true } });
    mount('/dashboard');
    const link = await within(nav()).findByRole('link', { name: 'Sourcing' });
    expect(link).not.toHaveAttribute('aria-current');
    expect(within(nav()).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
  });

  it('closes the drawer when it is clicked, like every other nav link', async () => {
    answers({ data: { enabled: true } });
    const onClose = vi.fn();
    mount('/dashboard', onClose);
    fireEvent.click(await within(nav()).findByRole('link', { name: 'Sourcing' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('puts a Compass icon beside the label (an svg inside the link)', async () => {
    answers({ data: { enabled: true } });
    mount();
    const link = await within(nav()).findByRole('link', { name: 'Sourcing' });
    expect(link.querySelector('svg')).not.toBeNull();
  });
});
