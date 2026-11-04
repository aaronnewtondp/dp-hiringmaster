import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { backendFacts, overBudgetPercent } from '../test/backendSource.ts';

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

// The text a header's info marker shows.
const markerOf = (label: string): string => {
  const th = screen.getAllByRole('columnheader').find(h => h.querySelector('span')?.textContent === label)!;
  fireEvent.mouseEnter(th.querySelector('[aria-label="More info"]')!);
  return th.querySelector('div.absolute')!.textContent!;
};

describe('Active Candidates — what the markers and hovers say', () => {
  it('Fit: a 0-100 score (the Average Score x 10), its colours, the portfolio rating, and the 75 line for SLA', async () => {
    mount();
    await screen.findByText('Candidate A1');
    const tip = markerOf('Fit');
    expect(tip).toContain('from 0 to 100');
    expect(tip).toContain('× 10');
    expect(tip).toContain('Green is 75 and above, amber 50 to 74, red below 50');
    expect(tip).toContain('shortens the 48 hour SLA windows to 24 hours');
    expect(tip).toContain('Roles that have a portfolio or work-sample review add a ninth rating');
    expect(tip).not.toMatch(/Senior UX|Head of Marketing/);          // the rating is switched on per role by a flag, not by a title
  });

  it('Current CTC: the current figure is the fixed-and-variable breakup (may include variable pay); Over Budget is anything above the band top', async () => {
    mount();
    await screen.findByText('Candidate A1');
    const tip = markerOf('Current CTC → Expected CTC');
    expect(tip).toContain('Current CTC (Fixed and Variable breakup) in LPA');
    expect(tip).toContain('can include variable pay');
    expect(tip).not.toContain('Current fixed CTC');
    expect(tip).toContain("“Over Budget” means the expected CTC is above the top of the role's CTC band");
  });

  it('Application Date says it is a number of days, and carries the explanation of Last Updated (a header with no marker of its own)', async () => {
    mount();
    await screen.findByText('Candidate A1');
    const tip = markerOf('Application Date');
    expect(tip).toContain('number of days, not a date');
    expect(tip).toContain('Last Updated is a separate column');
    expect(tip).toContain('stage, status, screening status, notes, Founder flag or assignment submission');
    expect(tip).toContain('The grey line under it is the latest logged event');
    const lastUpdated = screen.getAllByRole('columnheader').find(h => h.querySelector('span')?.textContent === 'Last Updated')!;
    expect(lastUpdated.querySelector('[aria-label="More info"]')).toBeNull();   // no new icon: it would change the column width
  });

  it('Notice Period and Last Updated explain themselves in a hover on the header (no marker icon: it would change the width)', async () => {
    mount();
    await screen.findByText('Candidate A1');
    const th = (label: string) => screen.getAllByRole('columnheader').find(h => h.querySelector('span')?.textContent === label)!;
    expect(th('Notice Period').getAttribute('title')).toContain('Notice period in days');
    expect(th('Stage').getAttribute('title')).toContain('changes its status, not its stage');                  // routes/applications.ts: the status route leaves stage alone
    const updated = th('Last Updated').getAttribute('title')!;
    expect(updated).toMatch(/^Last Updated: When this application's stage, status, screening status, notes/);
    expect(updated).toContain('Scheduling an interview, submitting feedback and ResumeIQ scoring do not change it on their own');
    expect(updated).toContain('The grey line under it is the latest logged event');
    expect(th('Notice Period').querySelector('[aria-label="More info"]')).toBeNull();
    expect(th('Candidate').getAttribute('title')).toBe('Candidate');           // no explanation: just the label, as before
  });

  it('the page marker says the list also holds Hold for Future, Joined and Closed, and how to see only live ones', async () => {
    mount();
    await screen.findByText('Candidate A1');
    const title = screen.getByText('Active Candidates');
    fireEvent.mouseEnter(title.parentElement!.querySelector('[aria-label="More info"]')!);
    const tip = title.parentElement!.querySelector('div.absolute')!.textContent!;
    expect(tip).toContain('Rejected and Withdrawn applications are not here');
    expect(tip).toContain('Hold for Future, Joined or Closed are listed too');
    expect(tip).toContain('choose Active in the Status filter');
    expect(tip).toContain("the Dashboard's Active candidates counts Active only");
  });

  it('the "In-budget only" button says it is more lenient than the Over Budget tag (still shows up to the backend tolerance over)', async () => {
    mount();
    await screen.findByText('Candidate A1');
    const tip = screen.getByRole('button', { name: 'In-budget only' }).getAttribute('title')!;
    const pct = overBudgetPercent(backendFacts());                                 // backend/src/utils/budget.ts OVER_BUDGET_TOLERANCE, read from the source
    expect(tip).toContain(`more than ${pct}% above the top of the role's CTC band`);
    expect(tip).toContain(`over the band by up to ${pct}% still show, with the red Over Budget tag`);
    expect(tip).toContain('expected CTC is missing, or whose band is missing or has no number in it, also still show, without the tag');
  });

  it('the "SLA breached only" button says what the SLA tag is, including that putting an application on hold does not clear it', async () => {
    mount();
    await screen.findByText('Candidate A1');
    const tip = screen.getByRole('button', { name: 'SLA breached only' }).getAttribute('title')!;
    expect(tip).toContain('Only applications with the red SLA tag');
    expect(tip).toContain('putting it on hold does not clear it');
  });
});
