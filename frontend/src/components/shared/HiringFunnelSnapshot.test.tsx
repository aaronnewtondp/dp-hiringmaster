import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const funnelSnapshot = vi.fn();
vi.mock('../../services/api.ts', () => ({ dashboardApi: { funnelSnapshot: (p: unknown) => funnelSnapshot(p) } }));

import HiringFunnelSnapshot from './HiringFunnelSnapshot.tsx';

const ROLES = [{ value: 'R001', label: 'Backend Dev' }, { value: 'R007', label: 'Senior UX Designer' }, { value: 'R009', label: 'QA Engineer' }];

function mount(master: Record<string, string[]>, roleOptions = ROLES) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><MemoryRouter><HiringFunnelSnapshot masterFilterParams={master} roleOptions={roleOptions} /></MemoryRouter></QueryClientProvider>,
  );
}
const lastParams = () => funnelSnapshot.mock.calls[funnelSnapshot.mock.calls.length - 1][0] as Record<string, unknown>;

beforeEach(() => {
  sessionStorage.clear();       // usePersistedState remembers filters in sessionStorage under an 'hms:' prefix
  funnelSnapshot.mockReset().mockResolvedValue({ data: { hiring_funnel_snapshot: [] } });
});

describe('HiringFunnelSnapshot — section-only Role filter', () => {
  it('sends the dashboard filters unchanged until a role is picked in this section', async () => {
    mount({ department: ['Tech'] });
    await waitFor(() => expect(funnelSnapshot).toHaveBeenCalled());
    expect(lastParams()).toEqual({ department: ['Tech'] });
  });

  it('picking a role sends role_id for this section and keeps the other dashboard filters', async () => {
    mount({ department: ['Tech'] });
    await waitFor(() => expect(funnelSnapshot).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^Role/ }));
    fireEvent.click(screen.getByLabelText('Senior UX Designer'));
    await waitFor(() => expect(lastParams()).toEqual({ department: ['Tech'], role_id: ['R007'] }));
  });

  it("replaces (does not intersect with) the dashboard's own Role filter, and says so", async () => {
    mount({ role_id: ['R001', 'R009'] });
    await waitFor(() => expect(lastParams()).toEqual({ role_id: ['R001', 'R009'] }));
    fireEvent.click(screen.getByRole('button', { name: /^Role/ }));
    fireEvent.click(screen.getByLabelText('Senior UX Designer'));
    await waitFor(() => expect(lastParams()).toEqual({ role_id: ['R007'] }));
    expect(screen.getByText(/not the dashboard's Role filter/)).toBeInTheDocument();
  });

  it('several roles can be picked, and clearing returns to the dashboard filters', async () => {
    mount({ role_id: ['R009'] });
    fireEvent.click(screen.getByRole('button', { name: /^Role/ }));
    fireEvent.click(screen.getByLabelText('Backend Dev'));
    fireEvent.click(screen.getByLabelText('Senior UX Designer'));
    await waitFor(() => expect(lastParams()).toEqual({ role_id: ['R001', 'R007'] }));
    fireEvent.click(screen.getByRole('button', { name: /Clear role/i }));
    await waitFor(() => expect(lastParams()).toEqual({ role_id: ['R009'] }));
  });

  it('shows no Role filter when there are no role options (a Hiring Manager is locked to their own roles)', async () => {
    mount({}, []);
    await waitFor(() => expect(funnelSnapshot).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /^Role/ })).not.toBeInTheDocument();
  });

  it('ignores a remembered selection for a role that no longer exists instead of filtering everything out', async () => {
    sessionStorage.setItem('hms:dashboard.funnelRoleIds', JSON.stringify(['R999']));
    mount({});
    await waitFor(() => expect(funnelSnapshot).toHaveBeenCalled());
    expect(lastParams()).toEqual({});
  });

  it('remembers the selection for next time', async () => {
    mount({});
    fireEvent.click(screen.getByRole('button', { name: /^Role/ }));
    fireEvent.click(screen.getByLabelText('QA Engineer'));
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('hms:dashboard.funnelRoleIds') || '[]')).toEqual(['R009']));
  });
});
