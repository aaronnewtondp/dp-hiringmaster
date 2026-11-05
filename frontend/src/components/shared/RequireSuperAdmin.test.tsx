import '../../test/loadTolerance.ts';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';

// The one route-level guard in the app (User Management). Every other persona is sent back to the Dashboard, and the guarded page
// is never even mounted for them: a page that fetched on mount would otherwise fire requests the server only answers 403 to.
const h = vi.hoisted(() => ({ persona: 'super_admin' as 'hr_recruiter' | 'hiring_manager' | 'leadership' | 'super_admin' | null, mounted: vi.fn() }));
// The same derivation AuthContext uses for this flag (its own tests pin the real one).
vi.mock('../../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ isSuperAdmin: h.persona === 'super_admin' }) }));

import RequireSuperAdmin from './RequireSuperAdmin.tsx';

const Guarded = () => { h.mounted(); return <div>user management page</div>; };
const Where = () => <div data-testid="where">{useLocation().pathname}</div>;

function mount(path = '/users') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="/dashboard" element={<div>dashboard page</div>} />
        <Route path="/users" element={<RequireSuperAdmin><Guarded /></RequireSuperAdmin>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireSuperAdmin', () => {
  it('shows the guarded page to a Super Admin and stays on its address', () => {
    h.persona = 'super_admin';
    h.mounted.mockClear();
    mount();
    expect(screen.getByText('user management page')).toBeInTheDocument();
    expect(screen.queryByText('dashboard page')).not.toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/users');
  });

  it.each(['hr_recruiter', 'hiring_manager', 'leadership'] as const)('%s is sent to the Dashboard and the guarded page is never mounted', persona => {
    h.persona = persona;
    h.mounted.mockClear();
    mount();
    expect(screen.getByText('dashboard page')).toBeInTheDocument();
    expect(screen.queryByText('user management page')).not.toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/dashboard');
    expect(h.mounted).not.toHaveBeenCalled();
  });

  it('someone who is not signed in at all is sent to the Dashboard too (the app\'s own sign-in guard then takes over)', () => {
    h.persona = null;
    h.mounted.mockClear();
    mount();
    expect(screen.getByText('dashboard page')).toBeInTheDocument();
    expect(h.mounted).not.toHaveBeenCalled();
  });

  it('the redirect replaces the history entry, so Back does not return to the page that was refused', () => {
    h.persona = 'hiring_manager';
    // History starts as [Dashboard, /users]. A redirect that REPLACES the refused entry leaves [Dashboard, Dashboard], so one step
    // back lands on the very first entry, which react-router marks with the key 'default'. A redirect that pushed would leave
    // [Dashboard, /users, Dashboard]: Back would reach /users, be refused again, and end on a brand-new entry with a new key.
    const BackProbe = () => {
      const navigate = useNavigate();
      return <><button onClick={() => navigate(-1)}>back</button><span data-testid="key">{useLocation().key}</span></>;
    };
    render(
      <MemoryRouter initialEntries={['/dashboard', '/users']} initialIndex={1}>
        <BackProbe />
        <Routes>
          <Route path="/dashboard" element={<div>dashboard page</div>} />
          <Route path="/users" element={<RequireSuperAdmin><Guarded /></RequireSuperAdmin>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('dashboard page')).toBeInTheDocument();
    expect(screen.getByTestId('key')).not.toHaveTextContent('default');
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    expect(screen.getByText('dashboard page')).toBeInTheDocument();
    expect(screen.getByTestId('key')).toHaveTextContent('default');
  });
});
