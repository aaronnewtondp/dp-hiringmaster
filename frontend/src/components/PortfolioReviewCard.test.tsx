import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PortfolioReviewCard from './PortfolioReviewCard.tsx';

let canHR = true;
vi.mock('../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ canHR }) }));

const portfolioReview = vi.fn();
vi.mock('../services/api.ts', () => ({
  applicationsApi: {
    portfolioReview: (id: string) => portfolioReview(id),
    rerunPortfolio: vi.fn(),
  },
}));

function renderCard(status?: 'pending' | 'running' | 'completed' | 'failed' | 'no_portfolio' | 'inaccessible') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  render(
    <QueryClientProvider client={qc}>
      <PortfolioReviewCard applicationId="A0001" status={status} />
    </QueryClientProvider>,
  );
  return { invalidate };
}

beforeEach(() => { canHR = true; portfolioReview.mockReset(); });

describe('PortfolioReviewCard', () => {
  it('offers HR a Re-run even while the review reads "running" (a killed worker never clears that state)', async () => {
    portfolioReview.mockResolvedValue({ data: { status: 'running', score: null, message: null, urls: [], analysis: null } });
    renderCard('running');
    expect(await screen.findByText(/Reviewing the portfolio now/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-run/ })).toBeInTheDocument();
  });

  it('never shows a Hiring Manager a Re-run button or an instruction to use it', async () => {
    canHR = false;
    portfolioReview.mockResolvedValue({
      data: { status: 'failed', score: null, message: 'Analysis failed — browser crashed. Use Re-run to retry.', urls: [], analysis: null },
    });
    renderCard('failed');
    // the card first renders from the application row's status; wait for the fetched message
    expect(await screen.findByText(/browser crashed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Re-run/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Use Re-run/)).not.toBeInTheDocument();
  });

  it('tells HR to Re-run on a failed review, without duplicating the hint stored in the message', async () => {
    portfolioReview.mockResolvedValue({
      data: { status: 'failed', score: null, message: 'Analysis failed — browser crashed. Use Re-run to retry.', urls: [], analysis: null },
    });
    renderCard('failed');
    expect(await screen.findByText(/browser crashed/)).toBeInTheDocument();
    expect(screen.getByText(/excludes the portfolio\. Use Re-run to retry\./)).toBeInTheDocument();
    expect(screen.getAllByText(/Use Re-run/)).toHaveLength(1);
  });

  it('does not claim the score excludes the portfolio when a previous review still counts', async () => {
    portfolioReview.mockResolvedValue({
      data: { status: 'failed', score: 8, message: 'Analysis failed — model overloaded.', urls: [], analysis: null },
    });
    renderCard('failed');
    expect(await screen.findByText(/still includes the previous review \(8\/10\)/)).toBeInTheDocument();
    expect(screen.queryByText(/excludes the portfolio/)).not.toBeInTheDocument();
  });

  it('refreshes the page data around the card when a pending review settles', async () => {
    portfolioReview.mockResolvedValue({
      data: { status: 'no_portfolio', score: 0, message: 'No portfolio link found in the resume.', urls: [], analysis: null },
    });
    const { invalidate } = renderCard('pending');          // the application row said "pending"; the fetch says settled
    await waitFor(() => expect(screen.getByText(/No portfolio was found/)).toBeInTheDocument());
    const keys = invalidate.mock.calls.map(c => JSON.stringify((c[0] as { queryKey: unknown[] }).queryKey));
    expect(keys).toContain(JSON.stringify(['candidate']));
    expect(keys).toContain(JSON.stringify(['applications']));
  });

  it('does not refresh anything for a review that was already settled when the page opened', async () => {
    portfolioReview.mockResolvedValue({
      data: { status: 'no_portfolio', score: 0, message: null, urls: [], analysis: null },
    });
    const { invalidate } = renderCard('no_portfolio');
    await waitFor(() => expect(screen.getByText(/No portfolio was found/)).toBeInTheDocument());
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does not print "judgement 0/10, checklist 0/10" for a review where no model ever ran', async () => {
    portfolioReview.mockResolvedValue({
      data: {
        status: 'inaccessible', score: 1, message: null, urls: [],
        analysis: {
          version: 1, analyzedAt: '2026-10-01T00:00:00Z', model: 'none', portfolios: [], criteria: [],
          jdAlignment: { mustHaves: [], niceToHaves: [] }, modelScore: 0, checklistScore: 0, score: 1,
          scoreNote: '', highlights: [], redFlags: [], summary: 'The link could not be opened.',
        },
      },
    });
    renderCard('inaccessible');
    expect(await screen.findByText(/Reviewed /)).toBeInTheDocument();
    expect(screen.queryByText(/judgement/)).not.toBeInTheDocument();
  });
});
