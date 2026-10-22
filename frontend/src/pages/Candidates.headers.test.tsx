import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Active Candidates' column headers: every name is written out in full and wraps at its spaces instead of
// being truncated ("Notice", "Preferred Location", "Resume Link", "Application Date" used to be cut off).
// Same rule as Ready for Review (ScorecardSummary.headers.test.tsx) and Archived Pipeline.
const list = vi.fn();
vi.mock('../services/api.ts', () => ({
  applicationsApi: { list: (p: unknown) => list(p), advanceStage: vi.fn(), updateStatus: vi.fn() },
  candidatesApi: {
    unmatched: () => Promise.resolve({ data: { submissions: [], total: 0 } }),
    linkRole: vi.fn(), remove: vi.fn(), list: vi.fn(),
  },
  rolesApi: { filterOptions: () => Promise.resolve({ data: { recruitment_modes: [], roles: [] } }), list: vi.fn() },
}));
vi.mock('../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ canHR: true, canLead: true }) }));

import Candidates from './Candidates.tsx';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><Candidates /></MemoryRouter></QueryClientProvider>);
}

const row = (id: string) => ({
  id, candidate_id: `C-${id}`, candidate_name: `Candidate ${id}`, role_id: 'R001', role_title: 'Quality Assurance Engineer',
  stage: 'Applied and Screened', status: 'Active', ai_fit_score: 72, application_date: '2026-10-01T00:00:00Z',
});

// The visible label of each header cell (the checkbox and chevron columns have none).
const labels = () =>
  screen.getAllByRole('columnheader').map(h => h.querySelector('span')?.textContent).filter((t): t is string => !!t);

beforeEach(() => {
  list.mockReset(); sessionStorage.clear();
  list.mockResolvedValue({ data: { applications: [row('A1')] } });
});

describe('Active Candidates — column headers', () => {
  it('spells out every header in full, in order', async () => {
    mount();
    await screen.findByText('Candidate A1');
    expect(labels()).toEqual([
      'Candidate', 'Gender', 'Role', 'Stage', 'Fit', 'Current CTC → Expected CTC', 'Notice Period',
      'Preferred Location', 'Company / Industry', 'Resume Link', 'Application Date', 'Last Updated',
    ]);
  });

  it('no longer uses the old abbreviations', async () => {
    mount();
    await screen.findByText('Candidate A1');
    for (const old of ['CTC → ECTC', 'Notice']) expect(labels()).not.toContain(old);
  });

  it('wraps labels instead of truncating them, uppercases the sortable ones, and lets an info-marker popover escape its cell', async () => {
    mount();
    await screen.findByText('Candidate A1');
    let withMarker = 0;
    for (const th of screen.getAllByRole('columnheader')) {
      const label = th.querySelector('span');
      if (!label?.textContent) continue;                       // checkbox / chevron columns
      expect(th.className).toContain('whitespace-normal');     // overrides .table-th's nowrap
      expect(label.className).not.toContain('truncate');       // a clipped name is the bug this guards
      const sort = th.querySelector('button:not([aria-label])');
      if (sort) expect(sort.className).toContain('uppercase'); // buttons reset text-transform otherwise
      if (th.querySelector('[aria-label="More info"]')) {      // a popover hangs below its marker
        withMarker++;
        expect(th.className).not.toContain('overflow-hidden');
      }
    }
    expect(withMarker).toBeGreaterThan(0);                     // the branch above was exercised
  });
});
