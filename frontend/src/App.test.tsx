import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigationType, useSearchParams } from 'react-router-dom';

// Everything App.tsx routes to is a stub: what is under test is the route table and `DashboardRoute`, the redirect that sends links made when the
// Sourcing plans were the last section of the Dashboard (`/dashboard?sourcing_role=…#sourcing-workspace`) to the Sourcing page.
const dashboardMounted = vi.fn();
vi.mock('./pages/Dashboard.tsx', () => ({
  default: () => { useEffect(() => { dashboardMounted(); }, []); return <div data-testid="page-dashboard">Dashboard</div>; },
}));
vi.mock('./pages/Sourcing.tsx', () => ({
  default: () => {
    const [params] = useSearchParams();
    return <div data-testid="page-sourcing" data-role={params.get('sourcing_role') ?? ''}>Sourcing</div>;
  },
}));
vi.mock('./pages/Login.tsx',           () => ({ default: () => <div data-testid="page-login">Login</div> }));
vi.mock('./pages/Roles.tsx',           () => ({ default: () => <div data-testid="page-roles">Roles</div> }));
vi.mock('./pages/NewRole.tsx',         () => ({ default: () => null }));
vi.mock('./pages/RoleDetail.tsx',      () => ({ default: () => null }));
vi.mock('./pages/Candidates.tsx',      () => ({ default: () => null }));
vi.mock('./pages/NewCandidate.tsx',    () => ({ default: () => null }));
vi.mock('./pages/CandidateDetail.tsx', () => ({ default: () => null }));
vi.mock('./pages/TalentPool.tsx',      () => ({ default: () => null }));
vi.mock('./pages/Agencies.tsx',        () => ({ default: () => null }));
vi.mock('./pages/AgencyDetail.tsx',    () => ({ default: () => null }));
vi.mock('./pages/MyTasks.tsx',         () => ({ default: () => null }));
vi.mock('./pages/UserManagement.tsx',  () => ({ default: () => null }));
vi.mock('./pages/Help.tsx',            () => ({ default: () => null }));
vi.mock('./components/layout/Layout.tsx', () => ({ default: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div> }));

let currentUser: { id: string; name: string; email: string; persona: string } | null = null;
vi.mock('./contexts/AuthContext.tsx', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ user: currentUser, loading: false, isSuperAdmin: currentUser?.persona === 'super_admin' }),
}));

import App, { DashboardRoute } from './App.tsx';

// Records every location the router visits and HOW it got there (POP = the entry the test started on, REPLACE = a <Navigate replace>).
const visited: Array<{ url: string; type: string }> = [];
function Trace() {
  const l = useLocation();
  const type = useNavigationType();
  useEffect(() => { visited.push({ url: l.pathname + l.search + l.hash, type }); }, [l.key]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <div data-testid="where">{l.pathname}{l.search}{l.hash}</div>;
}
const where = () => screen.getByTestId('where').textContent;

// `DashboardRoute` on its own, in a two-route table: /dashboard (the component under test) and /sourcing (where it must send people).
function mountRoute(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Trace />
      <Routes>
        <Route path="/dashboard" element={<DashboardRoute />} />
        <Route path="/sourcing" element={<div data-testid="page-sourcing">Sourcing</div>} />
      </Routes>
    </MemoryRouter>,
  );
}
// The real route table (App), with the pages above as stubs.
function mountApp(entry: string) {
  return render(<MemoryRouter initialEntries={[entry]}><Trace /><App /></MemoryRouter>);
}

beforeEach(() => {
  dashboardMounted.mockReset();
  visited.length = 0;
  currentUser = { id: 'u1', name: 'Aaron Newton', email: 'aaron.newton@digitalpaani.com', persona: 'super_admin' };
});

describe('DashboardRoute — legacy Sourcing links are sent to the Sourcing page', () => {
  it('/dashboard?sourcing_role=R5#sourcing-workspace lands on /sourcing?sourcing_role=R5 (the hash is dropped)', () => {
    mountRoute('/dashboard?sourcing_role=R5#sourcing-workspace');
    expect(where()).toBe('/sourcing?sourcing_role=R5');
    expect(screen.getByTestId('page-sourcing')).toBeInTheDocument();
    expect(screen.queryByTestId('page-dashboard')).toBeNull();
  });

  it('/dashboard#sourcing-workspace lands on /sourcing, with no role', () => {
    mountRoute('/dashboard#sourcing-workspace');
    expect(where()).toBe('/sourcing');
    expect(screen.getByTestId('page-sourcing')).toBeInTheDocument();
  });

  it('/dashboard?sourcing_role=R5 (no hash) also lands on /sourcing?sourcing_role=R5', () => {
    mountRoute('/dashboard?sourcing_role=R5');
    expect(where()).toBe('/sourcing?sourcing_role=R5');
  });

  it('/dashboard?sourcing_role=R5#something-else still redirects (the role alone is enough) and drops the hash', () => {
    mountRoute('/dashboard?sourcing_role=R5#something-else');
    expect(where()).toBe('/sourcing?sourcing_role=R5');
  });

  it('never mounts the Dashboard on the way (it would fire all its data requests for a page nobody is looking at)', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard?sourcing_role=R5#sourcing-workspace']}>
        <Trace />
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('page-sourcing')).toBeInTheDocument();
    expect(dashboardMounted).not.toHaveBeenCalled();
  });

  // The role id goes through URLSearchParams (decode) and encodeURIComponent (encode): what comes out is the same value, percent-encoded the
  // standard way — so the Sourcing page, which reads the parameter with the same URLSearchParams, gets exactly the id that was in the old link.
  it.each([
    ['R019',       'R019',       'R019'],
    ['R%2F5',      'R%2F5',      'R/5'],          // an encoded slash stays encoded (it must not become a path separator)
    ['R%205',      'R%205',      'R 5'],
    ['R+5',        'R%205',      'R 5'],          // "+" in a query string means a space; it is re-encoded as %20
    ['R%2B5',      'R%2B5',      'R+5'],          // an encoded plus stays an encoded plus (it must not turn into a space)
    ['R%265',      'R%265',      'R&5'],          // an encoded ampersand must not split the parameter
    ['R5%23x',     'R5%23x',     'R5#x'],         // an encoded hash must not start a fragment
    ['R%3D5',      'R%3D5',      'R=5'],
    ['R%C3%A9',    'R%C3%A9',    'Ré'],      // non-ASCII survives as UTF-8 percent-encoding
  ])('?sourcing_role=%s is sent on as ?sourcing_role=%s and reads back as %j', (incoming, outgoing, decoded) => {
    render(
      <MemoryRouter initialEntries={[`/dashboard?sourcing_role=${incoming}#sourcing-workspace`]}>
        <Trace />
        <App />
      </MemoryRouter>,
    );
    expect(where()).toBe(`/sourcing?sourcing_role=${outgoing}`);
    expect(screen.getByTestId('page-sourcing')).toHaveAttribute('data-role', decoded);
  });

  it('keeps the encoded value without a hash too (?sourcing_role=R%2F5 → ?sourcing_role=R%2F5)', () => {
    mountRoute('/dashboard?sourcing_role=R%2F5');
    expect(where()).toBe('/sourcing?sourcing_role=R%2F5');
  });

  it('carries over only sourcing_role: other query parameters of the old link are not Sourcing parameters and are dropped', () => {
    mountRoute('/dashboard?priority=P0&sourcing_role=R5&x=1#sourcing-workspace');
    expect(where()).toBe('/sourcing?sourcing_role=R5');
  });

  it('uses the first value when the parameter is repeated (the same one the workspace would read)', () => {
    mountRoute('/dashboard?sourcing_role=R1&sourcing_role=R2');
    expect(where()).toBe('/sourcing?sourcing_role=R1');
  });

  it('an EMPTY sourcing_role on its own is not a Sourcing link: the Dashboard renders', () => {
    mountRoute('/dashboard?sourcing_role=');
    expect(where()).toBe('/dashboard?sourcing_role=');
    expect(screen.queryByTestId('page-sourcing')).toBeNull();
  });

  it('an empty sourcing_role WITH the old hash goes to /sourcing, with no role', () => {
    mountRoute('/dashboard?sourcing_role=#sourcing-workspace');
    expect(where()).toBe('/sourcing');
  });
});

describe('DashboardRoute — everything else is the Dashboard, untouched', () => {
  it.each([
    ['/dashboard'],
    ['/dashboard?priority=P0'],
    ['/dashboard#something-else'],
    ['/dashboard#sourcing-workspace-2'],     // the hash must be exactly #sourcing-workspace
    ['/dashboard?SOURCING_ROLE=R5'],         // parameter names are case-sensitive
  ])('%s renders the Dashboard and stays where it is', (entry) => {
    render(
      <MemoryRouter initialEntries={[entry]}>
        <Trace />
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('page-dashboard')).toBeInTheDocument();
    expect(screen.queryByTestId('page-sourcing')).toBeNull();
    expect(where()).toBe(entry);
    expect(dashboardMounted).toHaveBeenCalledTimes(1);
    expect(visited).toEqual([{ url: entry, type: 'POP' }]);          // no redirect, no extra navigation
  });

  it('the component renders its child Dashboard exactly once on a plain visit', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Trace />
        <App />
      </MemoryRouter>,
    );
    expect(dashboardMounted).toHaveBeenCalledTimes(1);
  });
});

describe('DashboardRoute — no redirect loop', () => {
  it('one hop: it replaces the entry once and stops (the target is not itself a DashboardRoute)', () => {
    mountRoute('/dashboard?sourcing_role=R5#sourcing-workspace');
    expect(visited).toEqual([
      { url: '/dashboard?sourcing_role=R5#sourcing-workspace', type: 'POP' },
      { url: '/sourcing?sourcing_role=R5', type: 'REPLACE' },        // REPLACE: the Back button does not bounce through the old link
    ]);
  });

  it('a re-render after the redirect does not navigate again', () => {
    const view = mountRoute('/dashboard?sourcing_role=R5#sourcing-workspace');
    view.rerender(
      <MemoryRouter initialEntries={['/dashboard?sourcing_role=R5#sourcing-workspace']}>
        <Trace />
        <Routes>
          <Route path="/dashboard" element={<DashboardRoute />} />
          <Route path="/sourcing" element={<div data-testid="page-sourcing">Sourcing</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(visited.filter(v => v.type === 'REPLACE')).toHaveLength(1);
    expect(where()).toBe('/sourcing?sourcing_role=R5');
  });

  it('landing directly on /sourcing never passes through the Dashboard route', () => {
    mountApp('/sourcing?sourcing_role=R5');
    expect(where()).toBe('/sourcing?sourcing_role=R5');
    expect(visited).toEqual([{ url: '/sourcing?sourcing_role=R5', type: 'POP' }]);
    expect(dashboardMounted).not.toHaveBeenCalled();
  });

  it('the app-level redirect also ends after one replace', () => {
    mountApp('/dashboard?sourcing_role=R5#sourcing-workspace');
    expect(visited.map(v => v.type)).toEqual(['POP', 'REPLACE']);
    expect(where()).toBe('/sourcing?sourcing_role=R5');
  });
});

describe('App routes — /sourcing', () => {
  it('/sourcing renders the Sourcing page inside the layout, not the Dashboard', () => {
    mountApp('/sourcing');
    expect(inLayout('page-sourcing')).toBe(true);
    expect(screen.queryByTestId('page-dashboard')).toBeNull();
    expect(where()).toBe('/sourcing');
  });

  it('/sourcing?sourcing_role=R5 hands the role to the Sourcing page', () => {
    mountApp('/sourcing?sourcing_role=R5');
    expect(screen.getByTestId('page-sourcing')).toHaveAttribute('data-role', 'R5');
  });

  it('/sourcing is available to every persona (the page and its endpoints decide what each one sees)', () => {
    for (const persona of ['hr_recruiter', 'hiring_manager', 'leadership', 'super_admin']) {
      currentUser = { id: 'u', name: 'Someone', email: 'someone@digitalpaani.com', persona };
      const view = mountApp('/sourcing');
      expect(screen.getByTestId('page-sourcing')).toBeInTheDocument();
      view.unmount();
    }
  });

  it('signed out, /sourcing goes to the login page and the Sourcing page is never rendered', () => {
    currentUser = null;
    mountApp('/sourcing?sourcing_role=R5');
    expect(screen.getByTestId('page-login')).toBeInTheDocument();
    expect(screen.queryByTestId('page-sourcing')).toBeNull();
    expect(where()).toBe('/login');
  });

  it('signed out, a legacy /dashboard Sourcing link goes to login too (it is not redirected into Sourcing first)', () => {
    currentUser = null;
    mountApp('/dashboard?sourcing_role=R5#sourcing-workspace');
    expect(screen.getByTestId('page-login')).toBeInTheDocument();
    expect(screen.queryByTestId('page-sourcing')).toBeNull();
    expect(where()).toBe('/login');
  });
});

describe('App routes — the Dashboard and the rest are as before', () => {
  it('/ goes to the Dashboard', () => {
    mountApp('/');
    expect(screen.getByTestId('page-dashboard')).toBeInTheDocument();
    expect(where()).toBe('/dashboard');
  });

  it('/dashboard renders the Dashboard inside the layout', () => {
    mountApp('/dashboard');
    expect(inLayout('page-dashboard')).toBe(true);
  });

  it('an unknown path still falls back to the Dashboard', () => {
    mountApp('/no-such-page');
    expect(screen.getByTestId('page-dashboard')).toBeInTheDocument();
    expect(where()).toBe('/dashboard');
  });

  it('other pages are untouched (/roles still renders Roles)', () => {
    mountApp('/roles');
    expect(screen.getByTestId('page-roles')).toBeInTheDocument();
    expect(screen.queryByTestId('page-sourcing')).toBeNull();
  });
});

function inLayout(testId: string): boolean {
  return screen.getByTestId('layout').contains(screen.getByTestId(testId));
}
