import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Archived Pipeline's column headers: every name is written out in full and wraps at its spaces instead of
// being truncated. Same rule as Ready for Review (ScorecardSummary.headers.test.tsx) and Active Candidates.
const list = vi.fn();
vi.mock('../services/api.ts', () => ({
  candidatesApi: { list: (p: unknown) => list(p), linkRole: vi.fn() },
  rolesApi: { filterOptions: () => Promise.resolve({ data: { roles: [] } }), list: vi.fn() },
}));
vi.mock('../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ canHR: true, canLead: true }) }));

import TalentPool from './TalentPool.tsx';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><TalentPool /></MemoryRouter></QueryClientProvider>);
}

const candidate = {
  id: 'C1', full_name: 'Archived Person', email: 'p@example.com', hr_tags: [],
  applications: [{
    id: 'A1', role_id: 'R001', role_title: 'Quality Assurance Engineer', stage: 'Interview Round 1', status: 'Rejected',
    ai_fit_score: 66, application_date: '2026-09-01T00:00:00Z', last_updated: '2026-09-20T00:00:00Z',
  }],
};

// The visible label of each header cell.
const labels = () =>
  screen.getAllByRole('columnheader').map(h => h.querySelector('span')?.textContent).filter((t): t is string => !!t);

beforeEach(() => {
  list.mockReset(); sessionStorage.clear();
  list.mockResolvedValue({ data: { candidates: [candidate], total: 1 } });
});

describe('Archived Pipeline — column headers', () => {
  it('spells out every header in full, in order', async () => {
    mount();
    await screen.findByText('Archived Person');
    expect(labels()).toEqual([
      'Candidate', 'Gender', 'Role', 'Stage', 'Status', 'Fit', 'Current CTC → Expected CTC', 'Notice Period',
      'Preferred Location', 'Company / Industry', 'Resume Link', 'Application Date', 'Last Updated', 'Actions',
    ]);
  });

  it('no longer uses the old abbreviations', async () => {
    mount();
    await screen.findByText('Archived Person');
    for (const old of ['CTC → ECTC', 'Notice']) expect(labels()).not.toContain(old);
  });

  it('calls the last-change column "Last Updated" (it was "Last Added", which it never meant) and says what changes it', async () => {
    mount();
    await screen.findByText('Archived Person');
    expect(labels()).not.toContain('Last Added');
    const th = screen.getAllByRole('columnheader').find(h => h.querySelector('span')?.textContent === 'Last Updated')!;
    fireEvent.mouseEnter(th.querySelector('[aria-label="More info"]')!);
    const tip = th.querySelector('div.absolute')!.textContent!;
    expect(tip).toContain('stage, status, screening status, notes, Founder flag or assignment submission');
    expect(tip).toContain('Scheduling an interview, submitting feedback and ResumeIQ scoring do not change it');
  });

  it('wraps labels instead of truncating them, uppercases the sortable ones, and lets an info-marker popover escape its cell', async () => {
    mount();
    await screen.findByText('Archived Person');
    let withMarker = 0;
    for (const th of screen.getAllByRole('columnheader')) {
      const label = th.querySelector('span');
      expect(th.className).toContain('whitespace-normal');     // overrides .table-th's nowrap
      expect(label?.className).not.toContain('truncate');      // a clipped name is the bug this guards
      const sort = th.querySelector('button:not([aria-label])');
      if (sort) expect(sort.className).toContain('uppercase'); // buttons reset text-transform otherwise
      if (th.querySelector('[aria-label="More info"]')) {      // a popover hangs below its marker
        withMarker++;
        expect(th.className).not.toContain('overflow-hidden');
      }
    }
    expect(withMarker).toBeGreaterThan(0);                     // the branch above was exercised
  });

  it("the last column's popover opens leftward, so it stays inside the table's right edge", async () => {
    mount();
    await screen.findByText('Archived Person');
    const actions = screen.getAllByRole('columnheader').find(h => h.querySelector('span')?.textContent === 'Actions')!;
    fireEvent.mouseEnter(actions.querySelector('[aria-label="More info"]')!);
    const popover = actions.querySelector('div.absolute')!;
    expect(popover.className).toContain('right-0');
    expect(popover.className).not.toContain('-translate-x-1/2'); // not the centered default
  });
});

describe('Archived Pipeline — what the markers and hovers say', () => {
  const markerOf = (label: string): string => {
    const th = screen.getAllByRole('columnheader').find(h => h.querySelector('span')?.textContent === label)!;
    fireEvent.mouseEnter(th.querySelector('[aria-label="More info"]')!);
    return th.querySelector('div.absolute')!.textContent!;
  };

  it('Fit says the same as on Active Candidates: 0-100, the Average Score x 10, its colours and the 75 line', async () => {
    mount();
    await screen.findByText('Archived Person');
    const tip = markerOf('Fit');
    expect(tip).toContain('ResumeIQ\'s score for this application, from 0 to 100');
    expect(tip).toContain('× 10');
    expect(tip).toContain('Green is 75 and above, amber 50 to 74, red below 50');
    expect(tip).not.toMatch(/Senior UX|Head of Marketing/);
  });

  it('Current CTC says it may include variable pay and that there is no Over Budget flag here', async () => {
    mount();
    await screen.findByText('Archived Person');
    const tip = markerOf('Current CTC → Expected CTC');
    expect(tip).toContain('Current CTC (Fixed and Variable breakup) in LPA');
    expect(tip).toContain('can include variable pay');
    expect(tip).toContain('There is no Over Budget flag here');
  });

  it('Application Date says it is a number of days; the Tag filter says it is an exact match on the candidate\'s HR Tags only', async () => {
    mount();
    await screen.findByText('Archived Person');
    expect(markerOf('Application Date')).toContain('number of days, not a date');
    const tip = screen.getByPlaceholderText('Tag').getAttribute('title')!;
    expect(tip).toContain('Exact match, including capital letters');
    expect(tip).toContain('HR Tags on the candidate page');
    expect(tip).toContain('Tags added inside Screening & Risk Notes belong to the application and are not searched');
  });
});
