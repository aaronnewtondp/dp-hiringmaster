import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The Ready for Review table's column headers: every name is written out in full (they used to be
// "Tech", "Exp", "Ind", "Cult", "Traj", "Lead", "Comm", "Port", "Avg", "App. Age" — several clipped, and
// "Role" appeared twice), and wraps at its spaces instead of being truncated.
const list = vi.fn();
vi.mock('../services/api.ts', () => ({
  applicationsApi: { list: (p: unknown) => list(p), advanceStage: vi.fn(), updateStatus: vi.fn(), retryScoring: vi.fn() },
  rolesApi: { filterOptions: () => Promise.resolve({ data: { recruitment_modes: [], roles: [] } }) },
}));
vi.mock('../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ canLead: true, canHR: true }) }));

import ScorecardSummary from './ScorecardSummary.tsx';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ScorecardSummary /></MemoryRouter></QueryClientProvider>);
}

const row = (id: string, portfolioStatus: string | null) => ({
  id, candidate_id: `C-${id}`, candidate_name: `Candidate ${id}`, email: `${id}@example.com`, role_id: 'R001', role_title: 'Quality Assurance Engineer',
  stage: 'Applied and Screened', status: 'Active', score_avg: 7, ai_fit_score: 70, score_portfolio: portfolioStatus ? 8 : null,
  portfolio_analysis_status: portfolioStatus, application_date: '2026-10-01T00:00:00Z',
});

// The visible label of each header cell (the checkbox column has none).
const labels = () =>
  screen.getAllByRole('columnheader').map(h => h.querySelector('span')?.textContent).filter((t): t is string => !!t);

const BEFORE_SCORES = ['#', 'Candidate', 'Gender', 'Role', 'Stage', 'Current CTC → Expected CTC', 'Notice Period', 'Preferred Location', 'Company / Industry', 'Resume'];
const SCORES = ['Technical', 'Experience', 'Industry Fit', 'Culture Fit', 'Role Alignment', 'Trajectory', 'Leadership', 'Communication'];
const AFTER_SCORES = ['Average Score', 'Verdict', 'Application Age', 'Actions'];

beforeEach(() => {
  list.mockReset(); sessionStorage.clear();
  list.mockResolvedValue({ data: { applications: [row('A1', null)] } });
});

describe('Ready for Review — column headers', () => {
  it('spells out every header in full, in order', async () => {
    mount();
    await screen.findByText('Candidate A1');
    expect(labels()).toEqual([...BEFORE_SCORES, ...SCORES, ...AFTER_SCORES]);
  });

  it('no longer uses the old abbreviations', async () => {
    mount();
    await screen.findByText('Candidate A1');
    const shown = labels();
    for (const old of ['Tech', 'Exp', 'Ind', 'Cult', 'Traj', 'Lead', 'Comm', 'Port', 'Avg', 'App. Age', 'Notice', 'CTC → ECTC']) {
      expect(shown).not.toContain(old);
    }
    // "Role" is the role column only — the dimension is "Role Alignment", so the two can't be confused
    expect(shown.filter(l => l === 'Role')).toHaveLength(1);
  });

  it('adds a "Portfolio" header (not "Port") only when a candidate in view has a portfolio review', async () => {
    mount();
    await screen.findByText('Candidate A1');
    expect(labels()).not.toContain('Portfolio');
  });

  it('shows "Portfolio" right after Communication when a portfolio review exists', async () => {
    list.mockResolvedValue({ data: { applications: [row('A1', null), row('A2', 'completed')] } });
    mount();
    await screen.findByText('Candidate A2');
    const shown = labels();
    expect(shown.indexOf('Portfolio')).toBe(shown.indexOf('Communication') + 1);
    expect(shown).not.toContain('Port');
  });

  it('wraps labels instead of truncating them, and lets an info-marker popover escape its header cell', async () => {
    mount();
    await screen.findByText('Candidate A1');
    for (const th of screen.getAllByRole('columnheader')) {
      const label = th.querySelector('span');
      if (!label) continue;                                    // checkbox column
      expect(th.className).toContain('whitespace-normal');     // overrides .table-th's nowrap
      expect(label.className).not.toContain('truncate');       // a clipped name is the bug this guards
      // A popover hangs below its marker; overflow-hidden on the cell would cut it to a sliver.
      if (th.querySelector('[aria-label="More info"]')) expect(th.className).not.toContain('overflow-hidden');
    }
    // the two cells that carry a marker, so the loop above is known to have exercised that branch
    expect(screen.getAllByLabelText('More info')).toHaveLength(2);
  });
});
