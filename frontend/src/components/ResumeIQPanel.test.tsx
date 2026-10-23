import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Application, PortfolioStatus } from '../types/index.ts';

vi.mock('../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ canHR: true }) }));

const portfolioReview = vi.fn();
vi.mock('../services/api.ts', () => ({
  applicationsApi: { portfolioReview: (id: string) => portfolioReview(id), rerunPortfolio: vi.fn() },
}));

import ResumeIQPanel from './ResumeIQPanel.tsx';

const app = (over: Partial<Application> = {}): Application => ({
  id: 'A0001', score_avg: 7.2, score_technical: 8, score_experience: 7, score_industry_fit: 7, score_culture_fit: 7,
  score_role_alignment: 7, score_trajectory: 7, score_leadership: 7, score_communication: 7, score_recommendation: 'Yes',
  ...over,
} as unknown as Application);

function mount(a: Application) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ResumeIQPanel app={a} /></QueryClientProvider>);
}

// The 9th row: label cell, score cell, note cell.
const portfolioRow = () => screen.getByText('Portfolio', { selector: 'td' }).closest('tr') as HTMLTableRowElement;
const cells = () => Array.from(portfolioRow().querySelectorAll('td'));

const review = (kind?: 'design_portfolio' | 'marketing_work', status: PortfolioStatus = 'completed') =>
  portfolioReview.mockResolvedValue({ data: { kind, status, score: null, message: null, urls: [], analysis: null } });

beforeEach(() => { portfolioReview.mockReset(); review('design_portfolio'); });

describe('ResumeIQPanel — the Portfolio row', () => {
  it('has no Portfolio row, and asks for no review, for a role without portfolio review', () => {
    mount(app());
    expect(screen.queryByText('Portfolio', { selector: 'td' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(8);
    expect(portfolioReview).not.toHaveBeenCalled();
  });

  it('is the ninth row, labelled "Portfolio", with its score and the review\'s own note (designer)', async () => {
    mount(app({ portfolio_analysis_status: 'completed', score_portfolio: 8, score_portfolio_note: 'Strong case studies, one broken link' }));
    expect(screen.getAllByRole('row')).toHaveLength(9);
    expect(screen.getAllByRole('row')[8]).toBe(portfolioRow());
    expect(cells().map(c => c.textContent)).toEqual(['Portfolio', '8', 'Strong case studies, one broken link']);
    expect(cells()[1]).toHaveClass('text-green-600');
  });

  it('is labelled "Portfolio" for a marketing review too, with its score and note', async () => {
    review('marketing_work');
    mount(app({ portfolio_analysis_status: 'completed', score_portfolio: 6, score_portfolio_note: 'Competent, thin on outcomes' }));
    expect(cells().map(c => c.textContent)).toEqual(['Portfolio', '6', 'Competent, thin on outcomes']);
    expect(cells()[1]).toHaveClass('text-dp-600');
  });

  it('explains itself on hover in the words of the review that is on the page', async () => {
    mount(app({ portfolio_analysis_status: 'completed', score_portfolio: 8 }));
    await waitFor(() => expect(cells()[0]).toHaveAttribute('title', expect.stringContaining('Ninth dimension for designer roles')));
    expect(cells()[0].getAttribute('title')).toContain('portfolio site(s)');
    expect(cells()[0].getAttribute('title')).not.toContain('Head of Marketing');
  });

  it('explains a marketing review as work samples, left out when there is nothing to review', async () => {
    review('marketing_work');
    mount(app({ portfolio_analysis_status: 'completed', score_portfolio: 6 }));
    await waitFor(() => expect(cells()[0]).toHaveAttribute('title', expect.stringContaining('Ninth dimension for the Head of Marketing role')));
    expect(cells()[0].getAttribute('title')).toContain('work samples');
    expect(cells()[0].getAttribute('title')).toContain('left out of the average when there is nothing that could be reviewed');
  });

  it('names both roles until it knows which review this is', () => {
    portfolioReview.mockReturnValue(new Promise(() => { /* never settles */ }));
    mount(app({ portfolio_analysis_status: 'pending' }));
    expect(cells()[0].getAttribute('title')).toContain('designer and Head of Marketing roles');
  });

  it('does not call a review that could not be queued "in progress": nothing is on its way', async () => {
    review('marketing_work', 'pending');
    mount(app({ portfolio_analysis_status: 'pending', portfolio_analysis_error: "Could not be queued (Cannot find package '@vercel/queue'). Use Re-run to retry." }));
    expect(cells().map(c => c.textContent)).toEqual(['Portfolio', '—', 'Could not be queued — not included in the average until it is re-run']);
    expect(portfolioRow().textContent).not.toMatch(/vercel|provisional|in progress/i);
  });

  it('says the review is in progress, in both kinds', async () => {
    for (const kind of ['design_portfolio', 'marketing_work'] as const) {
      for (const status of ['pending', 'running'] as const) {
        review(kind, status);
        const { unmount } = mount(app({ portfolio_analysis_status: status }));
        expect(cells().map(c => c.textContent)).toEqual(['Portfolio', '—', 'Review in progress — overall score is provisional']);
        unmount();
      }
    }
  });

  describe('a marketing review that ended without a score', () => {
    beforeEach(() => review('marketing_work', 'no_portfolio'));

    it('shows a dash and the stored reason', async () => {
      mount(app({ portfolio_analysis_status: 'no_portfolio', score_portfolio: null, portfolio_analysis_error: 'No work samples provided; this dimension is not applied' }));
      expect(cells().map(c => c.textContent)).toEqual(['Portfolio', '—', 'No work samples provided; this dimension is not applied']);
      expect(cells()[1]).toHaveClass('text-gray-300');
    });

    it('leaves the "Use Re-run" hint out: this table has no button', async () => {
      mount(app({ portfolio_analysis_status: 'inaccessible', score_portfolio: null, portfolio_analysis_error: 'The linked file is private. Use Re-run to retry.' }));
      expect(cells()[2]).toHaveTextContent('The linked file is private.');
      expect(cells()[2].textContent).not.toMatch(/Re-run/);
    });

    it.each([
      ['no_portfolio', 'Not scored — no portfolio or work samples to review'],
      ['inaccessible', 'Not scored — the linked work is private or unavailable'],
      ['unreviewable', 'Not scored — the linked work cannot be opened automatically'],
      ['failed', 'Review failed — not included in the average'],
    ] as const)('says "%s" in words when no reason was stored', async (status, note) => {
      mount(app({ portfolio_analysis_status: status, score_portfolio: null, portfolio_analysis_error: null }));
      expect(cells().map(c => c.textContent)).toEqual(['Portfolio', '—', note]);
    });

    it('falls back to the words for the status when the stored reason was nothing but the retry hint', async () => {
      mount(app({ portfolio_analysis_status: 'inaccessible', score_portfolio: null, portfolio_analysis_error: 'Use Re-run to retry.' }));
      expect(cells()[2]).toHaveTextContent('Not scored — the linked work is private or unavailable');
    });

    it('a failed re-run that kept an earlier score shows that score and its note, not a "failed" line', async () => {
      mount(app({ portfolio_analysis_status: 'failed', score_portfolio: 7, score_portfolio_note: 'Strong on campaigns', portfolio_analysis_error: 'The links could not be opened this time — the earlier review (7/10) still applies.' }));
      expect(cells().map(c => c.textContent)).toEqual(['Portfolio', '7', 'Strong on campaigns']);
    });
  });

  it('a designer review that no machine could open reads as neutral, whatever the kind says', async () => {
    review('design_portfolio', 'unreviewable');
    mount(app({ portfolio_analysis_status: 'unreviewable', score_portfolio: null, portfolio_analysis_error: null }));
    expect(cells().map(c => c.textContent)).toEqual(['Portfolio', '—', 'Not scored — the linked work cannot be opened automatically']);
  });

  it('a designer review that failed before it ever had a score says so, with the stored reason', async () => {
    review('design_portfolio', 'failed');
    mount(app({ portfolio_analysis_status: 'failed', score_portfolio: null, score_portfolio_note: null, portfolio_analysis_error: 'Analysis failed — browser crashed. Use Re-run to retry.' }));
    expect(cells().map(c => c.textContent)).toEqual(['Portfolio', '—', 'Analysis failed — browser crashed.']);
  });

  it('says the same without waiting for the review to load, and when it cannot be loaded', async () => {
    portfolioReview.mockRejectedValue(new Error('offline'));
    mount(app({ portfolio_analysis_status: 'no_portfolio', score_portfolio: null, portfolio_analysis_error: 'No work samples provided; this dimension is not applied' }));
    expect(cells()[2]).toHaveTextContent('No work samples provided; this dimension is not applied');
    await waitFor(() => expect(portfolioReview).toHaveBeenCalled());
    expect(cells()[2]).toHaveTextContent('No work samples provided; this dimension is not applied');
  });

  it('a scored designer row keeps showing the review\'s own note (never the not-scored wording)', async () => {
    mount(app({ portfolio_analysis_status: 'inaccessible', score_portfolio: 1, score_portfolio_note: 'Portfolio link was dead', portfolio_analysis_error: null }));
    expect(cells().map(c => c.textContent)).toEqual(['Portfolio', '1', 'Portfolio link was dead']);
  });
});

describe('ResumeIQPanel — header', () => {
  it('says in its tooltip that designer and Head of Marketing roles add a ninth dimension, and that Head of Marketing may be left out', () => {
    mount(app());
    fireEvent.click(screen.getByRole('button', { name: 'More info' }));
    const tip = screen.getByText(/Scored automatically the moment this candidate applied/);
    expect(tip).toHaveTextContent('The Senior UX/Product Designer and Head of Marketing roles add a ninth, Portfolio');
    expect(tip).toHaveTextContent('left out when there is nothing to review');
    expect(tip.textContent).not.toMatch(/Designer roles add a ninth/);
  });

  it('when the review cannot be loaded, the card under the table says so and offers a retry — it does not borrow either role\'s wording', async () => {
    portfolioReview.mockRejectedValue(new Error('offline'));
    mount(app({ portfolio_analysis_status: 'no_portfolio', score_portfolio: null, portfolio_analysis_error: 'No work samples provided; this dimension is not applied' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the review');
    expect(within(alert).getByRole('button', { name: /Retry/ })).toBeInTheDocument();
    expect(screen.queryByText(/No portfolio was found/)).not.toBeInTheDocument();
    // the Portfolio row keeps saying what the application itself recorded
    expect(cells()[2]).toHaveTextContent('No work samples provided; this dimension is not applied');
  });

  it('shows the Portfolio review card under the table only when there is a review', async () => {
    review('marketing_work', 'no_portfolio');
    const { unmount } = mount(app({ portfolio_analysis_status: 'no_portfolio', score_portfolio: null }));
    expect(await screen.findByText('Not scored')).toBeInTheDocument();
    expect(within(document.body).getAllByText('Portfolio review')).toHaveLength(1);
    unmount();
    mount(app());
    expect(screen.queryByText('Portfolio review')).not.toBeInTheDocument();
  });

  it('is unchanged for an application that was never scored', () => {
    mount(app({ score_avg: undefined, portfolio_analysis_status: 'completed' }));
    expect(screen.getByText(/Not scored — the automatic scoring at application time didn't complete/)).toBeInTheDocument();
    expect(screen.queryByText('Portfolio', { selector: 'td' })).not.toBeInTheDocument();
    expect(portfolioReview).not.toHaveBeenCalled();
  });
});
