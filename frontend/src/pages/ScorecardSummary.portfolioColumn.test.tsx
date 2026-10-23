import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Ready for Review — the Portfolio column's cell (every state says something) and the expanded row that holds the
// portfolio review card (it must stay inside the visible part of a table that scrolls sideways).
const list = vi.fn();
const portfolioReview = vi.fn();
vi.mock('../services/api.ts', () => ({
  applicationsApi: {
    list: (p: unknown) => list(p),
    advanceStage: vi.fn(), updateStatus: vi.fn(), retryScoring: vi.fn(),
    portfolioReview: (id: string) => portfolioReview(id),
    rerunPortfolio: vi.fn(),
  },
  rolesApi: { filterOptions: () => Promise.resolve({ data: { recruitment_modes: [], roles: [] } }) },
}));
vi.mock('../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ canLead: true, canHR: true }) }));

import ScorecardSummary from './ScorecardSummary.tsx';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ScorecardSummary /></MemoryRouter></QueryClientProvider>);
}

const QUEUE_ERROR = "Could not be queued (Cannot find package '@vercel/queue'). Use Re-run to retry.";

const row = (name: string, over: Record<string, unknown> = {}) => ({
  id: `A-${name}`, candidate_id: `C-${name}`, candidate_name: name, email: `${name}@example.com`, role_id: 'R019', role_title: 'Head of Marketing & Creative Direction',
  stage: 'Applied and Screened', status: 'Active', score_avg: 7, ai_fit_score: 70, score_portfolio: null, portfolio_analysis_status: null, portfolio_analysis_error: null,
  application_date: '2026-10-01T00:00:00Z', ...over,
});

// The Portfolio cell of a candidate's row: the cell under the "Portfolio" header.
const portfolioCell = (name: string) => {
  const headers = screen.getAllByRole('columnheader');
  const at = headers.findIndex(h => h.querySelector('span')?.textContent === 'Portfolio');
  expect(at).toBeGreaterThan(-1);
  const tr = screen.getByText(name).closest('tr') as HTMLTableRowElement;
  return tr.querySelectorAll('td')[at] as HTMLTableCellElement;
};

const show = async (rows: ReturnType<typeof row>[]) => {
  list.mockResolvedValue({ data: { applications: rows } });
  mount();
  await screen.findByText(rows[0].candidate_name);
};

beforeEach(() => {
  list.mockReset(); portfolioReview.mockReset(); sessionStorage.clear();
  portfolioReview.mockResolvedValue({ data: { kind: 'marketing_work', status: 'completed', score: 7, message: null, urls: [], analyzed_at: null, note: null, analysis: null } });
});

describe('Ready for Review — the Portfolio cell', () => {
  it('a failed RE-RUN keeps the earlier score in view and marks it with a red dot, instead of hiding it behind "!"', async () => {
    await show([row('Failed KeptScore', { portfolio_analysis_status: 'failed', score_portfolio: 7, portfolio_analysis_error: 'The links could not be opened this time — the earlier review (7/10) still applies. Use Re-run to retry.' })]);
    const cell = portfolioCell('Failed KeptScore');
    expect(cell).toHaveTextContent('7');
    expect(cell).not.toHaveTextContent('!');
    const dot = within(cell).getByRole('img');
    expect(dot).toHaveAttribute('title', 'A later re-run failed — this is the earlier review');
    expect(dot.className).toContain('bg-red-500');
    expect(within(cell).getByText('7')).toHaveClass('text-dp-600');   // the score keeps its usual colour
  });

  it('a failed review that never had a score is still the red "!" with its own hover', async () => {
    await show([row('Failed NoScore', { portfolio_analysis_status: 'failed', score_portfolio: null })]);
    const cell = portfolioCell('Failed NoScore');
    expect(cell).toHaveTextContent('!');
    expect(within(cell).getByText('!')).toHaveAttribute('title', 'Portfolio review failed — open the candidate to re-run it');
    expect(within(cell).queryByRole('img')).not.toBeInTheDocument();
  });

  it('a score of 0 that was kept is still shown (a zero is a score, not a blank)', async () => {
    await show([row('Failed Zero', { portfolio_analysis_status: 'failed', score_portfolio: 0 })]);
    const cell = portfolioCell('Failed Zero');
    expect(cell).toHaveTextContent('0');
    expect(within(cell).getByRole('img')).toBeInTheDocument();
  });

  it.each([
    ['no_portfolio', 'Not scored: no work samples to review'],
    ['inaccessible', 'Not scored: the linked work is private or unavailable'],
    ['unreviewable', 'Not scored: the linked work cannot be opened automatically'],
  ])('a "%s" review with no score is a muted dash that says why: "%s"', async (status, title) => {
    await show([row('Unscored', { portfolio_analysis_status: status, score_portfolio: null })]);
    const dash = within(portfolioCell('Unscored')).getByText('—');
    expect(dash).toHaveAttribute('title', title);
    expect(dash).toHaveClass('text-gray-400');
  });

  it('a scored completed review is just its score, and one with a score on an unscored status (a designer\'s 1) shows it', async () => {
    await show([row('Scored', { portfolio_analysis_status: 'completed', score_portfolio: 8 }), row('Designer', { portfolio_analysis_status: 'inaccessible', score_portfolio: 1 })]);
    expect(portfolioCell('Scored')).toHaveTextContent('8');
    expect(portfolioCell('Scored').querySelector('[title]')).toBeNull();
    expect(portfolioCell('Designer')).toHaveTextContent('1');
    expect(portfolioCell('Designer').querySelector('[title]')).toBeNull();
  });

  it('a review in progress is "…", and one that could not be queued is not: it asks for a re-run', async () => {
    await show([
      row('Waiting', { portfolio_analysis_status: 'pending' }),
      row('Running', { portfolio_analysis_status: 'running' }),
      row('NotQueued', { portfolio_analysis_status: 'pending', portfolio_analysis_error: QUEUE_ERROR }),
    ]);
    expect(within(portfolioCell('Waiting')).getByText('…')).toHaveAttribute('title', 'Portfolio review in progress — the average is provisional');
    expect(within(portfolioCell('Running')).getByText('…')).toBeInTheDocument();
    const notQueued = within(portfolioCell('NotQueued')).getByText('!');
    expect(notQueued).toHaveAttribute('title', 'Portfolio review could not be queued — open the candidate to re-run it');
    expect(portfolioCell('NotQueued')).not.toHaveTextContent('…');
  });

  it('a candidate with no review at all keeps the plain dash in a table that has the column', async () => {
    await show([row('Has', { portfolio_analysis_status: 'completed', score_portfolio: 8 }), row('None')]);
    const cell = portfolioCell('None');
    expect(cell).toHaveTextContent('—');
    expect(cell.querySelector('[title]')).toBeNull();
  });
});

describe('Ready for Review — the expanded row', () => {
  const expand = async (name: string) => {
    fireEvent.click(within(screen.getByText(name).closest('tr')!.nextElementSibling as HTMLElement).getByRole('button', { name: 'View Highlights and Summary' }));
  };

  it('holds the portfolio review card in a frame that stays in view and has a width of its own', async () => {
    await show([row('Reviewed', { portfolio_analysis_status: 'completed', score_portfolio: 7 })]);
    await expand('Reviewed');
    const frame = await screen.findByTestId('portfolio-card-frame');
    const classes = frame.className.split(/\s+/);
    expect(classes).toContain('sticky');
    expect(classes).toContain('left-4');
    expect(classes).toContain('max-w-5xl');
    expect(classes).toContain('w-[min(100%,64rem,calc(100vw_-_4.5rem))]');
    expect(classes).toContain('lg:w-[min(100%,64rem,calc(100vw_-_19rem))]');
    // the card is inside it, and the frame is inside the full-width cell (colSpan untouched)
    expect(await within(frame).findByText('Portfolio review')).toBeInTheDocument();
    const cell = frame.closest('td')!;
    expect(Number(cell.getAttribute('colSpan'))).toBeGreaterThan(10);
  });

  it('has no frame when the application has no portfolio review', async () => {
    await show([row('Plain')]);
    await expand('Plain');
    expect(await screen.findByText('Key strengths', { exact: false })).toBeInTheDocument();
    expect(screen.queryByTestId('portfolio-card-frame')).not.toBeInTheDocument();
  });
});
