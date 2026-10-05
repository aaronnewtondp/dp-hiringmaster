import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Only the request the Ready-for-Review table makes for each persona scope — the table itself is covered
// elsewhere. A Leadership user who is also a role's Hiring Manager must ask for founder-flagged OR that role.
const list = vi.fn();
vi.mock('../services/api.ts', () => ({
  applicationsApi: { list: (p: unknown) => list(p) },
  rolesApi: { filterOptions: () => Promise.resolve({ data: { recruitment_modes: [], roles: [] } }) },
}));
vi.mock('../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ canLead: true, canHR: true }) }));

import ScorecardSummary from './ScorecardSummary.tsx';

function mount(scope?: Parameters<typeof ScorecardSummary>[0]['personaScope']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><ScorecardSummary personaScope={scope} /></MemoryRouter></QueryClientProvider>);
}
const requested = () => list.mock.calls[list.mock.calls.length - 1][0] as Record<string, unknown>;

beforeEach(() => { list.mockReset(); sessionStorage.clear(); list.mockResolvedValue({ data: { applications: [] } }); });

describe('ScorecardSummary — the request each persona scope makes', () => {
  it('Founder-flag-only Leadership: asks for founder_flag and nothing wider', async () => {
    mount({ founderFlagOnly: true });
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(requested().founder_flag).toBe('true');
    expect(requested().or_role_id).toBeUndefined();
  });

  it('Founder-flag-only Leadership with an empty alsoRoleIds list: still no union (an empty list must not widen anything)', async () => {
    mount({ founderFlagOnly: true, alsoRoleIds: [] });
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(requested().founder_flag).toBe('true');
    expect(requested().or_role_id).toBeUndefined();
  });

  it('Leadership who is also a role\'s Hiring Manager: founder_flag AND or_role_id, so the server unions them', async () => {
    mount({ founderFlagOnly: true, alsoRoleIds: ['R019'] });
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(requested().founder_flag).toBe('true');
    expect(requested().or_role_id).toEqual(['R019']);
    expect(requested().role_id).toBeUndefined();                // the union must not be ANDed with a role_id filter nobody chose
  });

  it('alsoRoleIds without the Founder flag is ignored (it only ever widens the flag scope)', async () => {
    mount({ alsoRoleIds: ['R019'] });
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(requested().or_role_id).toBeUndefined();
    expect(requested().founder_flag).toBeUndefined();
  });

  it('Hiring Manager: own roles via role_id, as before', async () => {
    mount({ ownRoleIds: ['R005', 'R006'] });
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(requested().role_id).toEqual(['R005', 'R006']);
    expect(requested().founder_flag).toBeUndefined();
  });
});
