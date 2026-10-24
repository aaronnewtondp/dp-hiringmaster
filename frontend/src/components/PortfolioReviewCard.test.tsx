import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import PortfolioReviewCard, { coverageOf, coverageSummary, isNotQueued, reviewKindOf, splitCaps, splitWorkLinks, urlKey } from './PortfolioReviewCard.tsx';
import type { PortfolioAnalysis, PortfolioCriterion, PortfolioReviewResponse, PortfolioReviewedSite, PortfolioStatus } from '../types/index.ts';

let canHR = true;
vi.mock('../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ canHR }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const portfolioReview = vi.fn();
const rerunPortfolio = vi.fn();
vi.mock('../services/api.ts', () => ({
  applicationsApi: {
    portfolioReview: (id: string) => portfolioReview(id),
    rerunPortfolio: (id: string) => rerunPortfolio(id),
  },
}));

function renderCard(status?: PortfolioStatus) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  render(
    <QueryClientProvider client={qc}>
      <PortfolioReviewCard applicationId="A0001" status={status} />
    </QueryClientProvider>,
  );
  return { invalidate };
}

beforeEach(() => {
  canHR = true; portfolioReview.mockReset(); rerunPortfolio.mockReset();
  vi.mocked(toast.success).mockReset(); vi.mocked(toast.error).mockReset();
});

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

// ─── Which review is this? ───────────────────────────────────────────────────────────────────────

describe('reviewKindOf', () => {
  const stored = (kind?: string) => ({ analysis: { kind } as unknown as PortfolioAnalysis });
  it('prefers the kind the stored review names, then the response\'s, and is null while neither is known', () => {
    expect(reviewKindOf({ kind: 'design_portfolio', analysis: stored('marketing_work').analysis })).toBe('marketing_work');
    expect(reviewKindOf({ kind: 'marketing_work', analysis: null })).toBe('marketing_work');
    expect(reviewKindOf({ kind: 'marketing_work', analysis: stored(undefined).analysis })).toBe('marketing_work');
    expect(reviewKindOf({ kind: 'design_portfolio', analysis: null })).toBe('design_portfolio');
    expect(reviewKindOf(undefined)).toBeNull();
    expect(reviewKindOf({ analysis: null })).toBeNull();
  });
  it('ignores a kind it does not know', () => {
    expect(reviewKindOf({ kind: 'sales_pitch' as never, analysis: null })).toBeNull();
    expect(reviewKindOf({ kind: 'marketing_work', analysis: stored('sales_pitch').analysis })).toBe('marketing_work');
  });
});

// ─── Marketing work-sample review ────────────────────────────────────────────────────────────────

const SIGNALS = { brokenLinksChecked: 0, brokenLinks: 0, consoleErrors: 0, mobileOverflow: null, loadMs: null, truncated: false };

const work = (over: Partial<PortfolioReviewedSite> = {}): PortfolioReviewedSite => ({
  url: 'https://drive.google.com/file/d/AAAAAAAAAAAA/view', platform: 'gdrive_file', isPortfolio: true, belongsToCandidate: null,
  accessible: true, pagesReviewed: 18, pageTitles: [], signals: SIGNALS,
  ref: 'L1', handler: 'document', outcome: 'ok', basis: 'artifact', coverage: 'full',
  facts: ['PDF, 18 of 18 pages read'], summary: 'Brand deck with three launch campaigns.', ...over,
});

const crit = (id: string, label: string, verdict: PortfolioCriterion['verdict'], over: Partial<PortfolioCriterion> = {}): PortfolioCriterion => ({
  id, label, verdict, evidence: '', group: 'direct', basis: 'seen', source: 'L1', ...over,
});

const analysis = (over: Partial<PortfolioAnalysis> = {}): PortfolioAnalysis => ({
  version: 1, kind: 'marketing_work', analyzedAt: '2026-10-22T10:00:00Z', model: 'claude-sonnet-4-5',
  portfolios: [work()], criteria: [crit('mh1', 'Built a brand from scratch', 'strong', { evidence: 'Naming, identity and narrative are all in the deck.' })],
  jdAlignment: { mustHaves: [], niceToHaves: [] },
  modelScore: 7, checklistScore: 6, score: 7, scoreNote: '', highlights: ['Clear campaign narrative'], redFlags: [],
  summary: 'A competent portfolio, strongest on brand narrative.', confidence: 'medium', ...over,
});

const answer = (over: Partial<PortfolioReviewResponse> = {}) => portfolioReview.mockResolvedValue({
  data: { kind: 'marketing_work', status: 'completed', score: 7, message: null, urls: [], analyzed_at: null, note: null, analysis: analysis(), ...over },
});

const coverageLines = () => screen.getAllByTestId('coverage-line').map(e => e.textContent);
const bodyText = () => document.body.textContent ?? '';

describe('PortfolioReviewCard — marketing work samples: completed', () => {
  it('shows the score with its confidence, the summary and what the score is based on', async () => {
    answer({ analysis: analysis({
      portfolios: [
        work(),
        work({ ref: 'L2', url: 'https://www.canva.com/design/XYZ/view', platform: 'canva', outcome: 'partial', coverage: 'partial', reason: 'Canva pages are canvas-rendered', facts: [] }),
        work({ ref: 'L3', url: 'https://www.instagram.com/someone/', platform: 'instagram', handler: 'social', outcome: 'unreviewable', basis: 'metadata', accessible: false, reason: 'Login wall', facts: [], summary: undefined }),
      ],
      unreviewed: [
        { url: 'https://www.linkedin.com/in/someone', platform: 'linkedin', reason: 'LinkedIn profile pages are never opened' },
        { url: 'https://we.tl/t-abc', platform: 'cloud_file', reason: 'WeTransfer links expire and cannot be opened automatically' },
      ],
    }) });
    renderCard('completed');
    expect(await screen.findByText('A competent portfolio, strongest on brand narrative.')).toBeInTheDocument();
    expect(bodyText()).toContain('7/10');
    expect(screen.getByText('Medium confidence')).toBeInTheDocument();
    // 2 of the 3 opened links gave something to read (1 only partly), the 3rd and the 2 never-opened ones did not
    expect(screen.getByTestId('coverage-summary')).toHaveTextContent('Based on 2 of 5 links (1 only partly read); 3 not reviewed, listed below.');
  });

  it('says "checklist not used" when the score is the reviewer\'s own judgement, and prints both numbers otherwise', async () => {
    answer({ analysis: analysis({ evidenceNotes: ['Only 30% of the criteria the work can show could be assessed (the checklist needs 40%), so the checklist was not used: the score is the reviewer\'s own judgement, with low confidence'] }) });
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    expect(bodyText()).toContain('judgement 7/10 (checklist not used)');
    expect(bodyText()).not.toContain('checklist 6/10');

    document.body.innerHTML = '';
    portfolioReview.mockReset();
    answer();
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    expect(bodyText()).toContain('judgement 7/10, checklist 6/10');
  });

  it('calls a criterion the reviewer never answered "Not assessed", not "Not assessable"', async () => {
    answer({ analysis: analysis({ criteria: [
      crit('mh1', 'Built a brand from scratch', 'strong', { evidence: 'Naming, identity and narrative are all in the deck.' }),
      crit('mh5', 'Strong visual concepts', 'not_evidenced', { assessable: false, basis: 'none', source: undefined, evidence: 'Not returned by the reviewer' }),
      crit('mh4', 'Copy across formats', 'not_evidenced', { assessable: false, basis: 'none', source: undefined, evidence: 'The text is in a language the review cannot judge' }),
    ] }) });
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 not assessable' }));
    expect(screen.getAllByLabelText('Not assessed')).toHaveLength(1);
    expect(screen.getAllByLabelText('Not assessable')).toHaveLength(1);
  });

  it('labels the confidence level and omits the chip when there is none', async () => {
    for (const [confidence, label] of [['high', 'High confidence'], ['low', 'Low confidence']] as const) {
      portfolioReview.mockReset();
      answer({ analysis: analysis({ confidence }) });
      renderCard('completed');
      expect(await screen.findByText(label)).toBeInTheDocument();
      document.body.innerHTML = '';
    }
    portfolioReview.mockReset();
    answer({ analysis: analysis({ confidence: undefined }) });
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    expect(screen.queryByText(/confidence/)).not.toBeInTheDocument();
  });

  it('puts a coverage line under every link that was read, and lists the rest once under "Not reviewed" with their reasons', async () => {
    answer({ analysis: analysis({
      portfolios: [
        work({ ref: 'L1' }),
        work({ ref: 'L2', platform: 'canva', url: 'https://www.canva.com/design/XYZ/view', outcome: 'partial', coverage: 'partial', reason: 'text was read, layout was not' }),
        work({ ref: 'L3', platform: 'instagram', url: 'https://www.instagram.com/someone/', handler: 'social', outcome: 'unreviewable', basis: 'metadata', reason: 'Login wall' }),
        work({ ref: 'L4', url: 'https://drive.google.com/file/d/BBBBBBBBBBBB/view', outcome: 'inaccessible', reason: 'The file is not shared' }),
        work({ ref: 'L5', platform: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk', handler: 'video', basis: 'metadata', coverage: 'metadata_only', facts: ['3 thumbnails'] }),
        work({ ref: 'L6', url: 'https://drive.google.com/file/d/CCCCCCCCCCCC/view', outcome: 'failed', reason: 'Google answered 503' }),
      ],
    }) });
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    expect(coverageLines()).toEqual([
      'Reviewed',
      'Partly: text was read, layout was not',
      'Video: title, description and thumbnails only — not watched',
    ]);
    expect(screen.getAllByTestId('work-link')).toHaveLength(3);
    // a link that was never read is not "Work reviewed": it is listed once, with why, for HR to open by hand
    const list = within(screen.getByTestId('unreviewed-list'));
    expect(list.getAllByTestId('unreviewed-item').map(e => e.querySelector('div:last-child')?.textContent)).toEqual([
      'Not opened: social platform — Login wall',
      'Private or unavailable — ask the candidate to re-share — The file is not shared',
      'Not reviewed — a problem on our side, not held against the candidate — Google answered 503',
    ]);
  });

  it('shows our own measurements as chips, the model\'s one-line summary and the platform labels', async () => {
    answer({ analysis: analysis({
      portfolios: [
        work({ ref: 'L1', facts: ['PDF, 18 of 18 pages read', '4 images'], campaignsSeen: 3 }),
        work({ ref: 'L2', platform: 'pdf_file', url: 'https://example.com/deck.pdf', facts: [] }),
        work({ ref: 'L3', platform: 'custom', url: 'https://example.com/portfolio', facts: [] }),
        work({ ref: 'L4', platform: 'pptx_file', url: 'https://example.com/deck.pptx', facts: [] }),
        work({ ref: 'L5', platform: 'vimeo', url: 'https://vimeo.com/123456', handler: 'video', facts: [] }),
        work({ ref: 'L6', platform: 'loom', url: 'https://www.loom.com/share/abc', handler: 'video', facts: [] }),
      ],
    }) });
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    expect(screen.getByText('PDF, 18 of 18 pages read')).toBeInTheDocument();
    expect(screen.getByText('4 images')).toBeInTheDocument();
    expect(screen.getByText('3 campaigns seen')).toBeInTheDocument();
    for (const label of ['Google Drive file', 'PDF', 'Website', 'PowerPoint', 'Vimeo', 'Loom']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    // a PDF is "PDF" here, not the designer card's "PDF / file", and a custom host is a "Website", not an "Own site"
    expect(screen.queryByText('PDF / file')).not.toBeInTheDocument();
    expect(screen.queryByText('Own site')).not.toBeInTheDocument();
    expect(screen.getAllByText('Brand deck with three launch campaigns.').length).toBeGreaterThan(0);
  });

  it('links each URL safely, and never makes a non-http address clickable', async () => {
    answer({ analysis: analysis({
      portfolios: [
        work({ ref: 'L1', url: 'https://www.example.com/work?x=1' }),
        work({ ref: 'L2', url: 'javascript:alert(1)', platform: 'custom' }),
      ],
      unreviewed: [{ url: 'data:text/html,hi', platform: 'link_hub', reason: 'Not a web address' }],
    }) });
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    const link = screen.getByRole('link', { name: /example\.com\/work\?x=1/ });
    expect(link).toHaveAttribute('href', 'https://www.example.com/work?x=1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
    expect(screen.getByText('data:text/html,hi')).toBeInTheDocument();
  });

  it('flags text aimed at an AI reviewer, and who the work is credited to', async () => {
    answer({ analysis: analysis({
      portfolios: [
        work({ ref: 'L1', attemptsToInfluenceReviewer: true, attribution: 'other_person', relevance: 'employer_site_no_attribution', campaignsSeen: 1 }),
        work({ ref: 'L2', url: 'https://example.com/two', attribution: 'led_team' }),
        work({ ref: 'L3', url: 'https://example.com/three', attribution: 'unknown', relevance: 'work_sample' }),
      ],
    }) });
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    expect(screen.getByText('contains text aimed at an AI reviewer')).toBeInTheDocument();
    expect(screen.getByText('credits someone else')).toBeInTheDocument();
    expect(screen.getByText('employer site, no attribution')).toBeInTheDocument();
    expect(screen.getByText('candidate led the team')).toBeInTheDocument();
    expect(screen.getByText('1 campaign seen')).toBeInTheDocument();
    // an "unknown" credit and a plain work sample say nothing: an employer page is never treated as a flag
    expect(screen.queryByText(/unknown/)).not.toBeInTheDocument();
  });

  it('lists the strengths and concerns, the campaigns found and the unverified claims', async () => {
    answer({ analysis: analysis({
      highlights: ['Clear campaign narrative'], redFlags: ['Outcomes are stated without a baseline'],
      campaigns: [
        { name: 'Jal Mitra launch', metric: '2.1M reach', roleStated: 'led', ref: 'L1' },
        { name: 'Rebrand', roleStated: 'unclear' },
        { name: 'Annual report', roleStated: 'contributed', metric: '40% more leads' },
      ],
      unverifiedClaims: ['Says they grew the audience 10x', 'Claims to have led a team of 6'],
    }) });
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    expect(screen.getByText('✓ Work-sample strengths')).toBeInTheDocument();
    expect(screen.getByText('⚠ Work-sample concerns')).toBeInTheDocument();
    expect(screen.getByText(/Outcomes are stated without a baseline/)).toBeInTheDocument();

    const campaigns = screen.getByTestId('campaigns');
    expect(within(campaigns).getByText('Campaigns identified (3)')).toBeInTheDocument();
    expect(within(campaigns).getByText('Jal Mitra launch')).toBeInTheDocument();
    expect(within(campaigns).getByText(/2\.1M reach/)).toBeInTheDocument();
    expect(within(campaigns).getByText('led')).toBeInTheDocument();
    expect(within(campaigns).getByText('role unclear')).toBeInTheDocument();
    expect(within(campaigns).getByText('contributed')).toBeInTheDocument();
    expect(within(campaigns).getByText('L1')).toBeInTheDocument();

    const claims = screen.getByTestId('unverified-claims');
    expect(within(claims).getByText(/Says they grew the audience 10x/)).toBeInTheDocument();
    expect(within(claims).getByText(/Claims to have led a team of 6/)).toBeInTheDocument();
  });

  it('says plainly when the score was capped, and shows no note when it was not', async () => {
    answer({ analysis: analysis({ caps: ['Metadata-only evidence: capped at 5', 'Only one thin artifact: capped at 6'] }) });
    renderCard('completed');
    expect(await screen.findByTestId('caps-note')).toHaveTextContent('Score capped: Metadata-only evidence: capped at 5; Only one thin artifact: capped at 6');
    document.body.innerHTML = '';
    portfolioReview.mockReset();
    answer({ analysis: analysis({ caps: [] }) });
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    expect(screen.queryByTestId('caps-note')).not.toBeInTheDocument();
  });

  it('lists what was never opened, with the reason, for HR to open by hand — and omits the list when nothing was skipped', async () => {
    answer({ analysis: analysis({
      unreviewed: [
        { url: 'https://www.linkedin.com/in/someone', platform: 'linkedin', reason: 'LinkedIn profile pages are never opened' },
        { url: 'https://bit.ly/3abc', platform: 'link_hub', reason: 'Over the limit of 8 links per review' },
      ],
    }) });
    renderCard('completed');
    const list = await screen.findByTestId('unreviewed-list');
    expect(within(list).getByText('Not reviewed — open these by hand')).toBeInTheDocument();
    expect(within(list).getByText('LinkedIn')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: /linkedin\.com\/in\/someone/ })).toHaveAttribute('href', 'https://www.linkedin.com/in/someone');
    expect(within(list).getByText('LinkedIn profile pages are never opened')).toBeInTheDocument();
    expect(within(list).getByText('Link page')).toBeInTheDocument();
    expect(within(list).getByText('Over the limit of 8 links per review')).toBeInTheDocument();
    document.body.innerHTML = '';
    portfolioReview.mockReset();
    answer({ analysis: analysis({ unreviewed: [] }) });
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    expect(screen.queryByTestId('unreviewed-list')).not.toBeInTheDocument();
  });

  describe('the criteria', () => {
    const criteria = [
      crit('mh1', 'Built a brand from scratch', 'strong', { basis: 'seen', source: 'L1', evidence: 'Naming, identity and narrative are in the deck' }),
      crit('mh3', 'Launched 5+ campaigns with results', 'not_evidenced', { basis: 'none', source: undefined }),
      crit('mh4', 'Writes copy in several formats', 'partial', { basis: 'claimed', source: 'answer' }),
      crit('eq_ownership', 'Personal role is evidenced', 'strong', { group: 'quality', basis: 'read', source: 'L1' }),
      crit('eq_recency', 'Work from the last three years', 'not_evidenced', { group: 'quality', basis: 'none' }),
      crit('mh2', 'Led a creative team', 'not_evidenced', { group: 'corroboration', assessable: false, basis: 'none' }),
      crit('mh7', 'Worked with limited resources', 'not_evidenced', { group: 'corroboration', basis: 'none' }),
      crit('mh8', 'Passion for mission-driven work', 'strong', { group: 'corroboration', basis: 'read', source: 'L2' }),
    ];

    it('groups them as what the work shows, evidence quality and corroborated elsewhere, in that order', async () => {
      answer({ analysis: analysis({ criteria }) });
      renderCard('completed');
      await screen.findByText('A competent portfolio, strongest on brand narrative.');
      expect(screen.getAllByTestId(/^criteria-group-/).map(e => e.getAttribute('data-testid'))).toEqual([
        'criteria-group-direct', 'criteria-group-quality', 'criteria-group-corroboration',
      ]);
      const direct = within(screen.getByTestId('criteria-group-direct'));
      expect(direct.getByText('What the work shows')).toBeInTheDocument();
      expect(direct.getByText('Built a brand from scratch')).toBeInTheDocument();
      expect(direct.getByText('Writes copy in several formats')).toBeInTheDocument();
      const quality = within(screen.getByTestId('criteria-group-quality'));
      expect(quality.getByText('Evidence quality')).toBeInTheDocument();
      expect(quality.getByText('Personal role is evidenced')).toBeInTheDocument();
      const corroboration = within(screen.getByTestId('criteria-group-corroboration'));
      expect(corroboration.getByText('Corroborated elsewhere')).toBeInTheDocument();
      expect(corroboration.getByText('Passion for mission-driven work')).toBeInTheDocument();
    });

    it('always shows a not-evidenced criterion the work could have shown — what the work lacks is the point — and hides only the ones it cannot', async () => {
      answer({ analysis: analysis({ criteria }) });
      renderCard('completed');
      await screen.findByText('A competent portfolio, strongest on brand narrative.');
      expect(within(screen.getByTestId('criteria-group-direct')).getByText('Launched 5+ campaigns with results')).toBeInTheDocument();
      expect(within(screen.getByTestId('criteria-group-quality')).getByText('Work from the last three years')).toBeInTheDocument();
      // mh2 is flagged not assessable; mh7 is a corroboration criterion with nothing to corroborate it
      expect(screen.queryByText('Led a creative team')).not.toBeInTheDocument();
      expect(screen.queryByText('Worked with limited resources')).not.toBeInTheDocument();
    });

    it('counts only what could be assessed, and reveals the rest behind "Show N not assessable"', async () => {
      answer({ analysis: analysis({ criteria }) });
      renderCard('completed');
      await screen.findByText('A competent portfolio, strongest on brand narrative.');
      // 8 criteria, 2 not assessable: 6 assessed, 3 of them evidenced
      expect(screen.getByText('Criteria — 3 evidenced of 6 assessable')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Show 2 not assessable' }));
      expect(within(screen.getByTestId('criteria-group-corroboration')).getByText('Led a creative team')).toBeInTheDocument();
      expect(screen.getByText('Worked with limited resources')).toBeInTheDocument();
      // they were never counted: the heading is the same
      expect(screen.getByText('Criteria — 3 evidenced of 6 assessable')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Hide not assessable' }));
      expect(screen.queryByText('Led a creative team')).not.toBeInTheDocument();
    });

    it('omits the toggle when every criterion could be assessed, and a group that would be empty', async () => {
      answer({ analysis: analysis({ criteria: [criteria[0], criteria[3]] }) });
      renderCard('completed');
      await screen.findByText('A competent portfolio, strongest on brand narrative.');
      expect(screen.queryByRole('button', { name: /not assessable/ })).not.toBeInTheDocument();
      expect(screen.queryByTestId('criteria-group-corroboration')).not.toBeInTheDocument();
    });

    it('does not draw the corroboration group at all while it is all not assessable, and draws it once revealed', async () => {
      answer({ analysis: analysis({ criteria: [criteria[0], criteria[5], criteria[6]] }) });
      renderCard('completed');
      await screen.findByText('A competent portfolio, strongest on brand narrative.');
      expect(screen.queryByTestId('criteria-group-corroboration')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Show 2 not assessable' }));
      expect(screen.getByTestId('criteria-group-corroboration')).toBeInTheDocument();
    });

    it('counts concerns, and shows each row\'s verdict, evidence and where it came from', async () => {
      answer({ analysis: analysis({ criteria: [
        criteria[0],
        crit('eq_ownership', 'Personal role is evidenced', 'concern', { group: 'quality', basis: 'read', source: 'L3', evidence: 'The page credits another named designer' }),
        crit('eq_craft', 'Finish of the work', 'concern', { group: 'quality', basis: 'seen', source: 'L1' }),
      ] }) });
      renderCard('completed');
      await screen.findByText('A competent portfolio, strongest on brand narrative.');
      expect(screen.getByText('Criteria — 1 evidenced, 2 concerns of 3 assessable')).toBeInTheDocument();
      expect(screen.getByText('The page credits another named designer')).toBeInTheDocument();
      expect(screen.getByText('Naming, identity and narrative are in the deck')).toBeInTheDocument();
      expect(screen.getAllByLabelText('Concern')).toHaveLength(2);
      expect(screen.getByLabelText('Evidenced')).toBeInTheDocument();
    });

    it('marks each verdict seen, read or claimed — claimed ones stand out — and nothing when there was no source', async () => {
      answer({ analysis: analysis({ criteria }) });
      renderCard('completed');
      await screen.findByText('A competent portfolio, strongest on brand narrative.');
      const direct = within(screen.getByTestId('criteria-group-direct'));
      expect(direct.getByText('seen')).toBeInTheDocument();
      const claimed = direct.getByText('claimed');
      expect(claimed).toHaveClass('text-amber-700');
      expect(claimed).toHaveAttribute('title', expect.stringContaining('not shown in the work'));
      expect(claimed.getAttribute('title')).toContain('(answer)');
      expect(within(screen.getByTestId('criteria-group-quality')).getByText('read')).toBeInTheDocument();
      // mh3 has basis "none": its row carries no badge
      const mh3 = direct.getByText('Launched 5+ campaigns with results');
      expect(within(mh3).queryByText(/^(seen|read|claimed|none)$/)).not.toBeInTheDocument();
    });

    it('puts a row from an older build with no group among what the work shows', async () => {
      answer({ analysis: analysis({ criteria: [crit('mh1', 'Built a brand from scratch', 'strong', { group: undefined })] }) });
      renderCard('completed');
      await screen.findByText('A competent portfolio, strongest on brand narrative.');
      expect(within(screen.getByTestId('criteria-group-direct')).getByText('Built a brand from scratch')).toBeInTheDocument();
    });
  });

  it('shows the nice-to-haves as a compact list of what was evidenced, and counts the rest', async () => {
    answer({ analysis: analysis({ jdAlignment: { mustHaves: [{ item: 'Built a brand from scratch', verdict: 'strong', evidence: '' }], niceToHaves: [
      { item: 'Climate or water sector work', verdict: 'strong', evidence: 'Wastewater awareness campaign' },
      { item: 'Managed influencer partnerships', verdict: 'partial', evidence: '' },
      { item: 'SEO or organic growth', verdict: 'not_evidenced', evidence: '' },
      { item: 'Photography or art direction', verdict: 'not_evidenced', evidence: '' },
    ] } }) });
    renderCard('completed');
    const nice = await screen.findByTestId('nice-to-haves');
    expect(within(nice).getByText('Nice-to-haves — 2 of 4 not evidenced')).toBeInTheDocument();
    expect(within(nice).getByText('Climate or water sector work')).toBeInTheDocument();
    expect(within(nice).getByText('Wastewater awareness campaign')).toBeInTheDocument();
    expect(within(nice).getByText('Managed influencer partnerships')).toBeInTheDocument();
    expect(within(nice).queryByText('SEO or organic growth')).not.toBeInTheDocument();
    // the ten must-haves are the criteria rows above, not a second list
    expect(screen.queryByText('Must-haves from the JD')).not.toBeInTheDocument();
  });

  it('keeps the designer card\'s chrome out of a marketing review', async () => {
    answer({ analysis: analysis({ criteria: [crit('mh1', 'Built a brand from scratch', 'strong')] }) });
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    expect(screen.queryByText('Portfolios reviewed')).not.toBeInTheDocument();
    expect(screen.queryByText('Hiring manager criteria', { exact: false })).not.toBeInTheDocument();
    expect(bodyText()).not.toMatch(/phone|broken|design portfolio/i);
    expect(screen.getByText('Work reviewed')).toBeInTheDocument();
  });

  it('prints the model\'s judgement and the checklist only when a model ran', async () => {
    answer({ analysis: analysis() });
    renderCard('completed');
    expect(await screen.findByText(/Reviewed .* · judgement 7\/10, checklist 6\/10/)).toBeInTheDocument();
    document.body.innerHTML = '';
    portfolioReview.mockReset();
    answer({ analysis: analysis({ model: 'none' }) });
    renderCard('completed');
    expect(await screen.findByText(/^Reviewed /)).toBeInTheDocument();
    expect(screen.queryByText(/judgement/)).not.toBeInTheDocument();
  });

  it('copes with a stored review that is missing optional lists', async () => {
    answer({ analysis: { version: 1, kind: 'marketing_work', analyzedAt: '2026-10-22T10:00:00Z', model: 'claude-sonnet-4-5', modelScore: 5, checklistScore: 5, score: 5, scoreNote: '', summary: 'Thin.' } as unknown as PortfolioAnalysis });
    renderCard('completed');
    expect(await screen.findByText('Thin.')).toBeInTheDocument();
    expect(screen.queryByTestId('coverage-summary')).not.toBeInTheDocument();
  });

  it('shows the marketing wording in the tooltip, not the designer\'s', async () => {
    answer();
    renderCard('completed');
    fireEvent.click(await screen.findByRole('button', { name: 'More info' }));
    expect(screen.getByText(/Videos are judged from their title, description and thumbnails only/)).toBeInTheDocument();
    expect(screen.getByText(/otherwise this dimension is not scored/)).toBeInTheDocument();
    expect(screen.queryByText(/15 criteria/)).not.toBeInTheDocument();
    expect(screen.queryByText(/opened in a browser/)).not.toBeInTheDocument();
  });
});

describe('PortfolioReviewCard — marketing work samples: nothing to score', () => {
  const text = (status: PortfolioStatus, over: Partial<PortfolioReviewResponse> = {}) =>
    answer({ status, score: null, analysis: null, ...over });

  it('blank answer: says it is not scored and why, and that the average is the 8 dimensions', async () => {
    text('no_portfolio', { message: 'No work samples provided; this dimension is not applied' });
    renderCard('no_portfolio');
    expect(await screen.findByText(/No work samples provided; this dimension is not applied/)).toBeInTheDocument();
    expect(screen.getByText('Not scored')).toBeInTheDocument();
    expect(screen.getByText(/the overall score is the average of the 8 ResumeIQ dimensions only/)).toBeInTheDocument();
    expect(screen.queryByText(/No portfolio was found/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('claim-text')).not.toBeInTheDocument();
  });

  it('blank answer with no stored message still says why', async () => {
    text('no_portfolio');
    renderCard('no_portfolio');
    expect(await screen.findByText('No work samples were provided.')).toBeInTheDocument();
  });

  it('text-only answer: shows the candidate\'s own words as unverified, linked, labelled "Text only: not scored"', async () => {
    text('no_portfolio', {
      message: 'Only a written description was provided — no work samples to review',
      analysis: analysis({ portfolios: [], criteria: [], model: 'none', summary: 'Only a written description was provided — no work samples to review', claimText: 'I led brand campaigns at two startups, details at https://example.com/work.\nHappy to share on request.' }),
    });
    renderCard('no_portfolio');
    const claim = await screen.findByTestId('claim-text');
    expect(within(claim).getByText('Described by the candidate (unverified)')).toBeInTheDocument();
    expect(claim).toHaveTextContent('I led brand campaigns at two startups, details at https://example.com/work.');
    expect(within(claim).getByRole('link')).toHaveAttribute('href', 'https://example.com/work');   // the full stop is not part of the URL
    expect(within(claim).getByText('Text only: not scored')).toBeInTheDocument();
    expect(screen.getAllByText(/Only a written description was provided — no work samples to review/)).toHaveLength(1);   // a stub with no model run does not repeat itself
    expect(screen.getByText('Not scored')).toBeInTheDocument();
    expect(screen.queryByText('Links looked at')).not.toBeInTheDocument();
  });

  it('text-only answer with no stored message gets the same explanation from the card', async () => {
    text('no_portfolio', { analysis: analysis({ portfolios: [], criteria: [], model: 'none', claimText: 'Ten years of brand work.' }) });
    renderCard('no_portfolio');
    expect(await screen.findByText(/Only a written description was provided — there are no work samples to review/)).toBeInTheDocument();
  });

  it('links that were opened but held no marketing work: lists them, keeps the description, and does not say "text only"', async () => {
    text('no_portfolio', {
      analysis: analysis({
        model: 'claude-sonnet-4-5', criteria: [], claimText: 'My work is on my site.',
        portfolios: [work({ ref: 'L1', platform: 'custom', url: 'https://example.com/', relevance: 'irrelevant', summary: 'A personal blog about travel.', facts: [] })],
      }),
    });
    renderCard('no_portfolio');
    expect(await screen.findByText(/none of it is marketing work/)).toBeInTheDocument();
    expect(screen.getByText('A competent portfolio, strongest on brand narrative.')).toBeInTheDocument();   // the model's own explanation
    expect(screen.getByText('Links looked at')).toBeInTheDocument();
    expect(screen.getByText('A personal blog about travel.')).toBeInTheDocument();
    expect(screen.getByText('not marketing work')).toBeInTheDocument();
    expect(screen.getByText('Described by the candidate (unverified)')).toBeInTheDocument();
    expect(screen.queryByText('Text only: not scored')).not.toBeInTheDocument();
  });

  it('a private or dead link: asks the candidate to re-share it, and tells HR to Re-run afterwards but not a Hiring Manager', async () => {
    text('inaccessible', {
      urls: [{ url: 'https://drive.google.com/file/d/AAAAAAAAAAAA/view', host: 'drive.google.com', platform: 'gdrive_file' }],
    });
    renderCard('inaccessible');
    expect(await screen.findByText(/The linked work is private, deleted or could not be opened/)).toBeInTheDocument();
    expect(screen.getByText(/Ask the candidate to re-share the link so that anyone with the link can view it, then press Re-run\./)).toBeInTheDocument();
    expect(screen.getByText('Links in the answer')).toBeInTheDocument();
    expect(screen.getByText('Google Drive file')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /drive\.google\.com\/file\/d\/AAAAAAAAAAAA\/view/ })).toBeInTheDocument();
    expect(screen.getByText('Not scored')).toBeInTheDocument();
    expect(screen.queryByText(/The portfolio link\(s\) could not be opened/)).not.toBeInTheDocument();
  });

  it('a private link, seen by a Hiring Manager: the same advice without a Re-run button or instruction', async () => {
    canHR = false;
    text('inaccessible', { message: 'Google Drive says the file is private. Use Re-run to retry.' });
    renderCard('inaccessible');
    expect(await screen.findByText(/Google Drive says the file is private\./)).toBeInTheDocument();
    expect(screen.getByText(/Ask the candidate to re-share the link so that anyone with the link can view it\./)).toBeInTheDocument();
    expect(screen.queryByText(/Re-run/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Re-run/ })).not.toBeInTheDocument();
  });

  it('an HR user sees the stored "Use Re-run" hint once', async () => {
    text('inaccessible', { message: 'Google Drive says the file is private. Use Re-run to retry.' });
    renderCard('inaccessible');
    expect(await screen.findByText(/Google Drive says the file is private\. Use Re-run to retry\./)).toBeInTheDocument();
    expect(screen.getAllByText(/Use Re-run to retry/)).toHaveLength(1);
  });

  it('links nobody can open automatically: neutral wording, every skipped link listed with its reason, none held against the candidate', async () => {
    text('unreviewable', {
      analysis: analysis({
        model: 'none', criteria: [], highlights: [], summary: '',
        portfolios: [work({ ref: 'L1', platform: 'instagram', url: 'https://www.instagram.com/someone/', handler: 'social', outcome: 'unreviewable', basis: 'metadata', accessible: false, reason: 'Instagram asks for a login', facts: [], summary: undefined })],
        unreviewed: [{ url: 'https://www.linkedin.com/in/someone', platform: 'linkedin', reason: 'LinkedIn profile pages are never opened' }],
      }),
    });
    renderCard('unreviewable');
    expect(await screen.findByText(/The linked work cannot be opened by an automated review/)).toBeInTheDocument();
    expect(screen.getByText('Not scored')).toBeInTheDocument();
    // nothing was read, so nothing is a "coverage line": both links are listed once under "Not reviewed", with why
    expect(screen.queryAllByTestId('coverage-line')).toEqual([]);
    expect(screen.queryByText('Links looked at')).not.toBeInTheDocument();
    const list = within(screen.getByTestId('unreviewed-list'));
    expect(list.getAllByTestId('unreviewed-item')).toHaveLength(2);
    expect(list.getByText('Not opened: social platform — Instagram asks for a login')).toBeInTheDocument();
    expect(list.getByText('LinkedIn profile pages are never opened')).toBeInTheDocument();
    expect(screen.queryByText(/private/i)).not.toBeInTheDocument();
  });

  // Google Play, Looker Studio and Google Photos links are stored by the backend as never-opened entries with platform "custom" (the
  // closed platform list is not widened) and their own reason; the card needs no change to show them under "Not reviewed".
  it('a Google Play, Looker Studio or Google Photos link that was never opened: listed once under "Not reviewed — open these by hand", linked, with its own reason', async () => {
    const play = 'https://play.google.com/store/apps/details?id=com.acme.app';
    const looker = 'https://lookerstudio.google.com/reporting/0B1c2D3e/page/p_abc';
    const photos = 'https://photos.app.goo.gl/AbC123xYz';
    text('unreviewable', {
      message: 'The links are on platforms that cannot be opened automatically - open them by hand',
      analysis: analysis({
        model: 'none', criteria: [], highlights: [], summary: '', portfolios: [],
        unreviewed: [
          { url: play, platform: 'custom', reason: 'Google Play listing - not opened automatically, open it by hand' },
          { url: looker, platform: 'custom', reason: 'Looker Studio report - not opened automatically, open it by hand' },
          { url: photos, platform: 'custom', reason: 'Google Photos album or photo - not opened automatically, open it by hand' },
        ],
      }),
    });
    renderCard('unreviewable');
    const list = within(await screen.findByTestId('unreviewed-list'));
    expect(list.getByText('Not reviewed — open these by hand')).toBeInTheDocument();
    expect(list.getAllByTestId('unreviewed-item')).toHaveLength(3);
    expect(list.getByRole('link', { name: /play\.google\.com\/store\/apps\/details\?id=com\.acme\.app/ })).toHaveAttribute('href', play);
    expect(list.getByRole('link', { name: /lookerstudio\.google\.com/ })).toHaveAttribute('href', looker);
    expect(list.getByRole('link', { name: /photos\.app\.goo\.gl\/AbC123xYz/ })).toHaveAttribute('href', photos);
    expect(list.getByText('Google Play listing - not opened automatically, open it by hand')).toBeInTheDocument();
    expect(list.getByText('Looker Studio report - not opened automatically, open it by hand')).toBeInTheDocument();
    expect(list.getByText('Google Photos album or photo - not opened automatically, open it by hand')).toBeInTheDocument();
    expect(list.getAllByText('Website')).toHaveLength(3);                       // the "custom" platform's own label
    expect(screen.getByText('Not scored')).toBeInTheDocument();
    expect(screen.queryByText(/No work samples/i)).not.toBeInTheDocument();      // the old, untrue outcome for such an answer
    expect(screen.queryByText(/private/i)).not.toBeInTheDocument();             // nothing here is held against the candidate
  });

  it('shows the links that were provided when no review detail was stored', async () => {
    text('unreviewable', { urls: [{ url: 'https://www.instagram.com/someone/', host: 'www.instagram.com', platform: 'instagram' }] });
    renderCard('unreviewable');
    expect(await screen.findByText('Links in the answer')).toBeInTheDocument();
    expect(screen.getByText('Instagram')).toBeInTheDocument();
    expect(screen.getByText(/cannot be opened by an automated review/)).toBeInTheDocument();
  });

  it('does not claim the dimension was left out when a score is somehow on record', async () => {
    text('inaccessible', { score: 6 });
    renderCard('inaccessible');
    await screen.findByText('Not scored');
    expect(screen.queryByText(/is left out/)).not.toBeInTheDocument();
  });

  it('offers HR a Re-run in every not-scored state and a Hiring Manager none', async () => {
    for (const status of ['no_portfolio', 'inaccessible', 'unreviewable'] as const) {
      for (const hr of [true, false]) {
        canHR = hr; portfolioReview.mockReset(); text(status);
        renderCard(status);
        await screen.findByText('Not scored');
        expect(!!screen.queryByRole('button', { name: /Re-run/ })).toBe(hr);
        document.body.innerHTML = '';
      }
    }
  });
});

describe('PortfolioReviewCard — marketing work samples: in progress and failed', () => {
  it('uses the work-sample wording while queued and while running', async () => {
    answer({ status: 'pending', score: null, analysis: null });
    renderCard('pending');
    expect(await screen.findByText(/Work-sample review queued — the overall score shown is provisional and will update if the review adds a score/)).toBeInTheDocument();
    document.body.innerHTML = '';
    portfolioReview.mockReset();
    answer({ status: 'running', score: null, analysis: null });
    renderCard('running');
    expect(await screen.findByText(/Reviewing the linked work now/)).toBeInTheDocument();
    expect(screen.queryByText(/Reviewing the portfolio now/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-run/ })).toBeInTheDocument();
  });

  it('a failed review with no earlier score: says it is excluded, and tells HR to Re-run exactly once', async () => {
    answer({ status: 'failed', score: null, analysis: null, message: 'Analysis failed — model overloaded. Use Re-run to retry.' });
    renderCard('failed');
    expect(await screen.findByText(/The work-sample review could not be completed\. Analysis failed — model overloaded\./)).toBeInTheDocument();
    expect(screen.getByText(/The overall score currently excludes this review\. Use Re-run to retry\./)).toBeInTheDocument();
    expect(screen.getAllByText(/Use Re-run/)).toHaveLength(1);
    expect(screen.queryByText(/excludes the portfolio/)).not.toBeInTheDocument();
  });

  it('a re-run that found nothing new keeps the earlier score, and the backend\'s own wording is not repeated', async () => {
    answer({
      status: 'failed', score: 7, analysis: null,
      message: 'The links could not be opened this time (Google Drive: file is private) — the earlier review (7/10) still applies. Use Re-run to retry.',
    });
    renderCard('failed');
    expect(await screen.findByText(/the earlier review \(7\/10\) still applies\./)).toBeInTheDocument();
    expect(screen.queryByText(/The overall score still includes the earlier review/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Use Re-run/)).toHaveLength(1);
  });

  it('a failed review whose message does not mention the kept score says so itself', async () => {
    answer({ status: 'failed', score: 7, analysis: null, message: 'Analysis failed — model overloaded.' });
    renderCard('failed');
    expect(await screen.findByText(/The overall score still includes the earlier review \(7\/10\)\. Use Re-run to retry\./)).toBeInTheDocument();
    expect(screen.queryByText(/previous review/)).not.toBeInTheDocument();
  });

  it('a Hiring Manager sees a failed review without any Re-run wording', async () => {
    canHR = false;
    answer({ status: 'failed', score: 7, analysis: null, message: 'The links could not be opened this time — the earlier review (7/10) still applies. Use Re-run to retry.' });
    renderCard('failed');
    expect(await screen.findByText(/the earlier review \(7\/10\) still applies\./)).toBeInTheDocument();
    expect(screen.queryByText(/Use Re-run/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Re-run/ })).not.toBeInTheDocument();
  });
});

describe('PortfolioReviewCard — Re-run toasts', () => {
  const click = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Re-run/ }));
  };

  it.each([
    ['design_portfolio', { status: 'no_portfolio', queued: false }, 'No portfolio link found in the resume'],
    ['design_portfolio', { status: 'pending', queued: true }, 'Portfolio review queued'],
    ['design_portfolio', { status: 'pending', queued: false }, 'Saved, but could not be queued — try again shortly'],
    ['marketing_work', { status: 'no_portfolio', queued: false }, 'No work samples to review in the application answer — not scored'],
    ['marketing_work', { status: 'pending', queued: true }, 'Work-sample review queued'],
    ['marketing_work', { status: 'pending', queued: false }, 'Saved, but could not be queued — try again shortly'],
  ] as const)('%s: %j says "%s"', async (kind, result, message) => {
    portfolioReview.mockResolvedValue({ data: { kind, status: 'failed', score: null, message: null, urls: [], analysis: null } });
    rerunPortfolio.mockResolvedValue({ data: { links: 1, ...result } });
    renderCard('failed');
    await click();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(message));
    expect(rerunPortfolio).toHaveBeenCalledWith('A0001');
  });

  it('never tells a marketing user the link was missing from the resume', async () => {
    portfolioReview.mockResolvedValue({ data: { kind: 'marketing_work', status: 'failed', score: null, message: null, urls: [], analysis: null } });
    rerunPortfolio.mockResolvedValue({ data: { status: 'no_portfolio', links: 0, queued: false } });
    renderCard('failed');
    await click();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(vi.mocked(toast.success).mock.calls[0][0]).not.toMatch(/resume/);
  });

  it('shows the server\'s own error, else a message in the right words', async () => {
    portfolioReview.mockResolvedValue({ data: { kind: 'marketing_work', status: 'failed', score: null, message: null, urls: [], analysis: null } });
    rerunPortfolio.mockRejectedValueOnce({ response: { data: { error: 'A portfolio review is already running' } } });
    renderCard('failed');
    await click();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A portfolio review is already running'));
    rerunPortfolio.mockRejectedValueOnce(new Error('network'));
    await click();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not re-run the work-sample review'));
  });

  it('keeps the designer\'s error wording', async () => {
    portfolioReview.mockResolvedValue({ data: { kind: 'design_portfolio', status: 'failed', score: null, message: null, urls: [], analysis: null } });
    rerunPortfolio.mockRejectedValueOnce(new Error('network'));
    renderCard('failed');
    await click();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not re-run the portfolio review'));
  });
});

// ─── Designer reviews keep their own wording ─────────────────────────────────────────────────────

describe('PortfolioReviewCard — designer reviews are unchanged', () => {
  const site = (over: Partial<PortfolioReviewedSite> = {}): PortfolioReviewedSite => ({
    url: 'https://www.example-design.com/', platform: 'custom', isPortfolio: true, belongsToCandidate: true, accessible: true,
    pagesReviewed: 3, pageTitles: [], signals: { ...SIGNALS, brokenLinksChecked: 10, brokenLinks: 2, mobileOverflow: false }, ...over,
  });
  const designer = (over: Partial<PortfolioAnalysis> = {}): PortfolioAnalysis => ({
    version: 1, analyzedAt: '2026-10-01T00:00:00Z', model: 'claude-sonnet-4-5', portfolios: [site()],
    criteria: [
      { id: 'ownership', label: 'Full ownership of a product', verdict: 'strong', evidence: 'Led the whole app' },
      { id: 'research', label: 'Field research', verdict: 'not_evidenced', evidence: '' },
    ],
    jdAlignment: { mustHaves: [{ item: 'Design systems', verdict: 'partial', evidence: 'A component library' }], niceToHaves: [{ item: 'Motion', verdict: 'strong', evidence: '' }] },
    modelScore: 8, checklistScore: 7, score: 8, scoreNote: '', highlights: ['Strong case studies'], redFlags: ['Two broken links'], summary: 'A strong designer portfolio.', ...over,
  });

  it('renders a review with no kind in the designer\'s words: sites, 15-criteria list, JD alignment, phone-width chips', async () => {
    portfolioReview.mockResolvedValue({ data: { status: 'completed', score: 8, message: null, urls: [], analysis: designer() } });
    renderCard('completed');
    expect(await screen.findByText('A strong designer portfolio.')).toBeInTheDocument();
    expect(screen.getByText('Portfolios reviewed')).toBeInTheDocument();
    expect(screen.getByText('Own site')).toBeInTheDocument();
    expect(screen.getByText('3 pages reviewed · 2 of 10 links broken · phone-friendly')).toBeInTheDocument();
    expect(screen.getByText('✓ Portfolio strengths')).toBeInTheDocument();
    expect(screen.getByText('⚠ Portfolio concerns')).toBeInTheDocument();
    expect(screen.getByText('Hiring manager criteria — 1 evidenced of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 1 not evidenced' })).toBeInTheDocument();
    expect(screen.getByText('Must-haves from the JD')).toBeInTheDocument();
    expect(screen.getByText('Nice-to-haves')).toBeInTheDocument();
    expect(screen.getByText(/judgement 8\/10, checklist 7\/10/)).toBeInTheDocument();
    // none of the marketing furniture
    expect(screen.queryByTestId('coverage-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('coverage-summary')).not.toBeInTheDocument();
    expect(screen.queryByText(/confidence/)).not.toBeInTheDocument();
    expect(screen.queryByText('Not scored')).not.toBeInTheDocument();
    expect(screen.queryByText(/not assessable/)).not.toBeInTheDocument();
  });

  it('uses the designer wording in the tooltip', async () => {
    portfolioReview.mockResolvedValue({ data: { kind: 'design_portfolio', status: 'completed', score: 8, message: null, urls: [], analysis: designer() } });
    renderCard('completed');
    fireEvent.click(await screen.findByRole('button', { name: 'More info' }));
    expect(screen.getByText(/reviewed page by page against the JD and the hiring manager's 15 criteria/)).toBeInTheDocument();
  });

  it('a stored review that names itself as a designer review is one, whatever the response says', async () => {
    portfolioReview.mockResolvedValue({ data: { kind: 'marketing_work', status: 'completed', score: 8, message: null, urls: [], analysis: designer({ kind: 'design_portfolio' }) } });
    renderCard('completed');
    expect(await screen.findByText('Portfolios reviewed')).toBeInTheDocument();
    expect(screen.queryByText('Work reviewed')).not.toBeInTheDocument();
  });

  it('a kind it does not know is a designer review', async () => {
    portfolioReview.mockResolvedValue({ data: { kind: 'sales_pitch', status: 'running', score: null, message: null, urls: [], analysis: null } });
    renderCard('running');
    expect(await screen.findByText(/Reviewing the portfolio now/)).toBeInTheDocument();
  });

  it('says a designer\'s missing portfolio is not found, and keeps listing the links as plain text', async () => {
    portfolioReview.mockResolvedValue({ data: { kind: 'design_portfolio', status: 'inaccessible', score: null, message: 'The site is down.', urls: [{ url: 'https://dead.example.com', host: 'dead.example.com', platform: 'custom' }], analysis: null } });
    renderCard('inaccessible');
    expect(await screen.findByText(/The portfolio link\(s\) could not be opened\. The site is down\./)).toBeInTheDocument();
    expect(screen.getByText('https://dead.example.com')).toBeInTheDocument();
    expect(screen.queryByText('Not scored')).not.toBeInTheDocument();
  });

  it('a designer link no machine could open (bot protection) is neutral, not a dead link', async () => {
    portfolioReview.mockResolvedValue({ data: { kind: 'design_portfolio', status: 'unreviewable', score: null, message: 'Blocked by a bot check.', urls: [], analysis: null } });
    renderCard('unreviewable');
    expect(await screen.findByText(/could not be opened by an automated review \(bot protection or an unsupported link\)\. Blocked by a bot check\./)).toBeInTheDocument();
  });

  it('a designer review with a stored analysis and an unreviewable status still shows the analysis', async () => {
    portfolioReview.mockResolvedValue({ data: { kind: 'design_portfolio', status: 'unreviewable', score: 3, message: null, urls: [], analysis: designer({ summary: 'Site blocked automated browsers.' }) } });
    renderCard('unreviewable');
    expect(await screen.findByText('Site blocked automated browsers.')).toBeInTheDocument();
    expect(screen.getByText('Portfolios reviewed')).toBeInTheDocument();
  });

  it('waits for the review before choosing words, so a marketing candidate never flashes the designer\'s', async () => {
    portfolioReview.mockReturnValue(new Promise(() => { /* never settles */ }));
    renderCard('running');
    expect(await screen.findByText('Loading portfolio review…')).toBeInTheDocument();
    expect(screen.queryByText(/Reviewing the portfolio now/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Re-run/ })).not.toBeInTheDocument();
  });
});

// ─── coverageOf ──────────────────────────────────────────────────────────────────────────────────

describe('coverageOf', () => {
  const cov = (over: Partial<PortfolioReviewedSite>) => coverageOf(work(over));

  it('reviewed in full', () => {
    expect(cov({})).toEqual({ tone: 'ok', label: 'Reviewed' });
    expect(cov({ outcome: 'ok', coverage: 'full', basis: 'artifact' })).toEqual({ tone: 'ok', label: 'Reviewed' });
  });

  it('partly: names the reason, or says what partial meant', () => {
    expect(cov({ outcome: 'partial', reason: 'Only the first 20 of 64 pages were read' })).toEqual({ tone: 'partial', label: 'Partly: Only the first 20 of 64 pages were read' });
    expect(cov({ coverage: 'partial', reason: undefined })).toEqual({ tone: 'partial', label: 'Partly: only part of it could be read' });
    expect(cov({ outcome: 'partial', basis: 'metadata', reason: undefined })).toEqual({ tone: 'partial', label: 'Partly: details only, the content itself was not read' });
    expect(cov({ coverage: 'metadata_only', outcome: 'ok', reason: undefined }).label).toBe('Partly: details only, the content itself was not read');
    expect(cov({ outcome: 'partial', reason: undefined, accessNote: 'Notion page, text only' }).label).toBe('Partly: Notion page, text only');
  });

  it('video platforms are never "reviewed": title, description and thumbnails only', () => {
    for (const platform of ['youtube', 'vimeo', 'loom', 'video_file']) {
      expect(cov({ platform, handler: 'video', basis: 'metadata' })).toEqual({ tone: 'partial', label: 'Video: title, description and thumbnails only — not watched' });
    }
    // by handler alone, whatever the platform was classified as
    expect(cov({ platform: 'custom', handler: 'video' }).label).toContain('not watched');
    // a video that could not be opened at all is described by that, not as a video that was read
    expect(cov({ platform: 'youtube', handler: 'video', outcome: 'inaccessible', reason: 'Private video' }).label).toContain('re-share');
  });

  it('social posts that gave only a caption', () => {
    expect(cov({ platform: 'instagram', handler: 'social', outcome: 'ok', basis: 'metadata' }).label).toBe('Social post: public caption text only — the post itself was not opened');
  });

  it('not opened: social platforms say so, other unreviewable links say why', () => {
    for (const platform of ['instagram', 'linkedin', 'social_other']) {
      expect(cov({ platform, outcome: 'unreviewable', reason: undefined })).toEqual({ tone: 'neutral', label: 'Not opened: social platform' });
    }
    expect(cov({ platform: 'linkedin', outcome: 'unreviewable', reason: 'Profile pages are never opened' }))
      .toEqual({ tone: 'neutral', label: 'Not opened: social platform', detail: 'Profile pages are never opened' });
    expect(cov({ platform: 'custom', handler: 'site', outcome: 'unreviewable', reason: 'The site is behind a Cloudflare check' }))
      .toEqual({ tone: 'neutral', label: 'Not opened: The site is behind a Cloudflare check' });
    expect(cov({ platform: 'custom', outcome: 'unreviewable', reason: undefined, accessNote: undefined }).label).toBe('Not opened: cannot be reviewed automatically');
  });

  it('private or dead: asks for a re-share, a warning rather than a verdict on the candidate', () => {
    expect(cov({ outcome: 'inaccessible', reason: undefined })).toEqual({ tone: 'warn', label: 'Private or unavailable — ask the candidate to re-share' });
    expect(cov({ outcome: 'inaccessible', reason: 'Not shared' }).detail).toBe('Not shared');
  });

  it('failed on our side: says it was not the candidate\'s doing', () => {
    expect(cov({ outcome: 'failed', reason: 'Timed out' })).toEqual({ tone: 'neutral', label: 'Not reviewed — a problem on our side, not held against the candidate', detail: 'Timed out' });
  });

  it('reads a record with no outcome from whether it could be opened', () => {
    expect(cov({ outcome: undefined, accessible: true }).label).toBe('Reviewed');
    expect(cov({ outcome: undefined, accessible: false, accessNote: 'Could not be opened' }).label).toBe('Private or unavailable — ask the candidate to re-share');
  });

  it('trims a reason that is only whitespace', () => {
    expect(cov({ outcome: 'inaccessible', reason: '   ' }).detail).toBeUndefined();
    expect(cov({ outcome: 'partial', reason: '  ', coverage: 'partial' }).label).toBe('Partly: only part of it could be read');
  });
});


// ─── One list of links: nothing is shown twice or counted twice ──────────────────────────────────

describe('splitWorkLinks / urlKey — a link is one link', () => {
  const U = (n: number) => `https://brand${n}.example/work`;
  // what an earlier build stored: EVERY acquired item in `portfolios`, and the unreadable ones again in `unreviewed`
  const L1 = work({ ref: 'L1', url: U(1), platform: 'custom', handler: 'site' });
  const L2 = work({ ref: 'L2', url: 'https://drive.google.com/file/d/1PrivateFileIdXXXX/view', outcome: 'inaccessible', accessible: false, coverage: undefined, reason: 'Google Drive: access denied' });
  const L3 = work({ ref: 'L3', url: 'https://www.instagram.com/jane/', platform: 'instagram', handler: 'social', outcome: 'unreviewable', accessible: false, basis: 'metadata', coverage: undefined, reason: 'Instagram needs a sign-in' });
  const linkedin = { url: 'https://www.linkedin.com/in/jane', platform: 'linkedin', reason: 'LinkedIn profile pages are never opened' };

  it('an unread link that is in both lists counts once, and the totals are the distinct addresses', () => {
    const r = splitWorkLinks({
      portfolios: [L1, L2, L3],
      unreviewed: [linkedin, { url: L2.url, platform: 'gdrive_file', reason: 'The link could not be opened' }, { url: L3.url, platform: 'instagram', reason: 'This kind of link cannot be opened automatically' }],
    });
    expect(r.reviewed.map(p => p.ref)).toEqual(['L1']);
    expect(r.notReviewed.map(e => e.url)).toEqual([L2.url, L3.url, linkedin.url]);
    expect(r.total).toBe(4);
    expect(r.total).toBe(new Set([L1, L2, L3].map(p => urlKey(p.url)).concat(urlKey(linkedin.url))).size);   // total links = distinct links
    expect(coverageSummary(r)).toBe('Based on 1 of 4 links; 3 not reviewed, listed below.');
  });

  it('gives the same answer for the new shape, where `unreviewed` holds only what was never opened', () => {
    const r = splitWorkLinks({ portfolios: [L1, L2, L3], unreviewed: [linkedin] });
    expect(r.total).toBe(4);
    expect(r.reviewed).toHaveLength(1);
    expect(r.notReviewed).toHaveLength(3);
    expect(coverageSummary(r)).toBe('Based on 1 of 4 links; 3 not reviewed, listed below.');
  });

  it('what was read is "reviewed" only if its content reached the reviewer: outcome ok or partial AND a coverage', () => {
    const read = work({ ref: 'L1', url: U(1) });
    const partial = work({ ref: 'L2', url: U(2), outcome: 'partial', coverage: 'partial' });
    const meta = work({ ref: 'L3', url: U(3), basis: 'metadata', coverage: 'metadata_only' });
    const droppedBeforeTheCall = work({ ref: 'L4', url: U(4), outcome: 'ok', coverage: undefined });   // opened, but nothing readable / over the budget / text aimed at the reviewer
    const droppedPartial = work({ ref: 'L5', url: U(5), outcome: 'partial', coverage: undefined });
    const r = splitWorkLinks({ portfolios: [read, partial, meta, droppedBeforeTheCall, droppedPartial], unreviewed: [] });
    expect(r.reviewed.map(p => p.ref)).toEqual(['L1', 'L2', 'L3']);
    expect(r.partly).toBe(2);   // partial + metadata only
    expect(r.notReviewed.map(e => e.site?.ref)).toEqual(['L4', 'L5']);
    expect(coverageSummary(r)).toBe('Based on 3 of 5 links (2 only partly read); 2 not reviewed, listed below.');
  });

  it('says why an opened-but-unused link was not read, from its own reason, else the listed one, else plainly', () => {
    const own = work({ ref: 'L1', url: U(1), coverage: undefined, reason: 'Nothing readable was found at this link' });
    const viaList = work({ ref: 'L2', url: U(2), coverage: undefined, reason: undefined, accessNote: undefined });
    const bare = work({ ref: 'L3', url: U(3), coverage: undefined, reason: undefined, accessNote: undefined });
    const r = splitWorkLinks({ portfolios: [own, viaList, bare], unreviewed: [{ url: U(2), platform: 'custom', reason: 'Over the size limit' }] });
    expect(r.notReviewed.map(e => e.reason)).toEqual([
      'Not reviewed — Nothing readable was found at this link',
      'Not reviewed — Over the size limit',
      'Not reviewed — nothing readable could be taken from it',
    ]);
  });

  it('the same address written with www., a trailing slash, another scheme or a #fragment is one link; a different query is another', () => {
    expect(urlKey('https://www.example.com/work/')).toBe(urlKey('http://example.com/work#top'));
    expect(urlKey('https://EXAMPLE.com/work')).toBe(urlKey('https://example.com/work'));
    expect(urlKey('https://example.com/work')).not.toBe(urlKey('https://example.com/other'));
    expect(urlKey('https://youtube.com/watch?v=aaaaaaaaaaa')).not.toBe(urlKey('https://youtube.com/watch?v=bbbbbbbbbbb'));
    expect(urlKey('https://drive.google.com/file/d/AbC/view')).not.toBe(urlKey('https://drive.google.com/file/d/abc/view'));   // Drive ids are case-sensitive
    expect(urlKey('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(urlKey(undefined)).toBe('');
    // the stored `unreviewed` address is cut at 500 characters; the same link in `portfolios` is not
    const long = `https://example.com/${'a'.repeat(700)}`;
    expect(urlKey(long)).toBe(urlKey(long.slice(0, 500)));
    const r = splitWorkLinks({ portfolios: [work({ url: long, coverage: undefined, outcome: 'unreviewable' })], unreviewed: [{ url: long.slice(0, 500), platform: 'custom', reason: 'x' }] });
    expect(r.total).toBe(1);
  });

  it('a link read in one record is never also listed as not reviewed, and the first record of an address wins', () => {
    const readOne = work({ ref: 'L1', url: 'https://www.example.com/work/' });
    const dup = work({ ref: 'L9', url: 'https://example.com/work', outcome: 'unreviewable', coverage: undefined });
    const r = splitWorkLinks({ portfolios: [dup, readOne, work({ ref: 'L2', url: 'https://example.com/work#again' })], unreviewed: [{ url: 'http://example.com/work', platform: 'custom', reason: 'again' }] });
    expect(r.reviewed.map(p => p.ref)).toEqual(['L1']);
    expect(r.notReviewed).toEqual([]);
    expect(r.total).toBe(1);
    expect(coverageSummary(r)).toBe('Based on 1 of 1 link.');
  });

  it('copes with missing and malformed lists', () => {
    expect(splitWorkLinks({})).toEqual({ reviewed: [], notReviewed: [], total: 0, partly: 0 });
    expect(splitWorkLinks({ portfolios: 'x' as never, unreviewed: {} as never }).total).toBe(0);
    const r = splitWorkLinks({ portfolios: [null as never, 7 as never, work({ ref: 'L1' })], unreviewed: [null as never, { url: 'https://x.example/', platform: 'custom', reason: 'r' }] });
    expect(r.total).toBe(2);
    expect(coverageSummary(splitWorkLinks({}))).toBeNull();
  });
});

describe('PortfolioReviewCard — marketing work samples: a link shown once, counted once', () => {
  const L1 = work({ ref: 'L1', url: 'https://brand.example/work', platform: 'custom', handler: 'site', facts: [], summary: 'Deck' });
  const L2 = work({ ref: 'L2', url: 'https://drive.google.com/file/d/1PrivateFileIdXXXX/view', outcome: 'inaccessible', accessible: false, coverage: undefined, reason: 'Google Drive: access denied', facts: [], summary: undefined });
  const L3 = work({ ref: 'L3', url: 'https://www.instagram.com/jane/', platform: 'instagram', handler: 'social', outcome: 'unreviewable', accessible: false, basis: 'metadata', coverage: undefined, reason: 'Instagram needs a sign-in', facts: [], summary: undefined });
  const linkedin = { url: 'https://www.linkedin.com/in/jane', platform: 'linkedin', reason: 'LinkedIn profile pages are never opened' };

  const hrefs = () => screen.getAllByRole('link').map(a => a.getAttribute('href'));

  it('website + private Drive + Instagram + LinkedIn, as an earlier build stored it: 1 of 4, every address once, only the read one under "Work reviewed"', async () => {
    answer({ analysis: analysis({
      portfolios: [L1, L2, L3],
      unreviewed: [linkedin, { url: L2.url, platform: 'gdrive_file', reason: 'The link could not be opened (private, deleted or not found) - ask the candidate to re-share it' }, { url: L3.url, platform: 'instagram', reason: 'This kind of link cannot be opened automatically' }],
    }) });
    renderCard('completed');
    expect(await screen.findByTestId('coverage-summary')).toHaveTextContent('Based on 1 of 4 links; 3 not reviewed, listed below.');
    expect(screen.queryByText(/of 6 links/)).not.toBeInTheDocument();
    expect(within(screen.getByText('Work reviewed').parentElement!).getAllByTestId('work-link')).toHaveLength(1);
    expect(screen.getAllByTestId('unreviewed-item')).toHaveLength(3);
    // each address appears exactly once on the card
    expect(hrefs().sort()).toEqual([L1.url, L2.url, L3.url, linkedin.url].sort());
    // the unread ones carry the guidance from their own record, not a second copy of the generic one
    const list = within(screen.getByTestId('unreviewed-list'));
    expect(list.getByText('Private or unavailable — ask the candidate to re-share — Google Drive: access denied')).toBeInTheDocument();
    expect(list.getByText('Not opened: social platform — Instagram needs a sign-in')).toBeInTheDocument();
    expect(list.getByText('LinkedIn profile pages are never opened')).toBeInTheDocument();
  });

  it('the same review in the new shape (unreviewed = only what was never opened) reads the same', async () => {
    answer({ analysis: analysis({ portfolios: [L1, L2, L3], unreviewed: [linkedin] }) });
    renderCard('completed');
    expect(await screen.findByTestId('coverage-summary')).toHaveTextContent('Based on 1 of 4 links; 3 not reviewed, listed below.');
    expect(screen.getAllByTestId('unreviewed-item')).toHaveLength(3);
    expect(hrefs()).toHaveLength(4);
  });

  it('shows a flag on an unread link whose text was aimed at an AI reviewer', async () => {
    const hit = work({ ref: 'L4', url: 'https://sneaky.example/', platform: 'custom', outcome: 'unreviewable', accessible: false, coverage: undefined, attemptsToInfluenceReviewer: true, reason: 'Contains text addressed to an AI reviewer - routed to a human', facts: [] });
    answer({ analysis: analysis({ portfolios: [L1, hit], unreviewed: [] }) });
    renderCard('completed');
    const list = await screen.findByTestId('unreviewed-list');
    expect(within(list).getByText('contains text aimed at an AI reviewer')).toBeInTheDocument();
    expect(within(list).getByText(/routed to a human/)).toBeInTheDocument();
  });

  it('a not-scored review shows the same single list: links looked at, then what was not reviewed', async () => {
    answer({ status: 'unreviewable', score: null, analysis: analysis({ model: 'none', criteria: [], highlights: [], summary: '', portfolios: [L2, L3], unreviewed: [linkedin, { url: L2.url, platform: 'gdrive_file', reason: 'dup' }] }) });
    renderCard('unreviewable');
    await screen.findByText('Not scored');
    expect(screen.getAllByTestId('unreviewed-item')).toHaveLength(3);
    expect(screen.queryByText('Links looked at')).not.toBeInTheDocument();
    expect(hrefs()).toHaveLength(3);
  });

  it('a link read in full and a link cut at the page cap: "Partly: first pages read" for a website, not a bare "Reviewed"', async () => {
    answer({ analysis: analysis({ portfolios: [work({ ref: 'L1', url: 'https://brand.example/', platform: 'custom', handler: 'site', outcome: 'ok', coverage: 'partial', reason: undefined, facts: ['4 pages opened'] })], unreviewed: [] }) });
    renderCard('completed');
    await screen.findByTestId('coverage-summary');
    expect(coverageLines()).toEqual(['Partly: first pages read']);
    expect(screen.getByTestId('coverage-summary')).toHaveTextContent('Based on 1 of 1 link (1 only partly read).');
  });
});

describe('coverageOf — a website captured at its page cap', () => {
  const site = (over: Partial<PortfolioReviewedSite>) => coverageOf(work({ platform: 'custom', handler: 'site', outcome: 'ok', coverage: 'full', facts: [], ...over }));
  it('says the first pages were read when the stored coverage is partial and no reason was given', () => {
    expect(site({ coverage: 'partial', reason: undefined })).toEqual({ tone: 'partial', label: 'Partly: first pages read' });
    expect(site({ outcome: 'partial', coverage: 'partial', reason: undefined })).toEqual({ tone: 'partial', label: 'Partly: first pages read' });
  });
  it('keeps a stated reason, details-only for metadata, and the generic wording for a document', () => {
    expect(site({ coverage: 'partial', reason: 'Only the first 4 of 12 pages were opened' }).label).toBe('Partly: Only the first 4 of 12 pages were opened');
    expect(site({ coverage: 'metadata_only', basis: 'metadata', reason: undefined }).label).toBe('Partly: details only, the content itself was not read');
    expect(coverageOf(work({ handler: 'document', coverage: 'partial', reason: undefined })).label).toBe('Partly: only part of it could be read');
  });
  it('a site read in full is "Reviewed"', () => {
    expect(site({})).toEqual({ tone: 'ok', label: 'Reviewed' });
  });
});

// ─── Caps are caps; the audit notes are folded away ──────────────────────────────────────────────

describe('splitCaps', () => {
  const criteria = [crit('mh2', 'Led a creative team', 'partial'), crit('mh3', 'Launched 5+ campaigns', 'partial'), crit('eq_ownership', 'Personal role is evidenced', 'partial')];
  it('keeps only strings that say "capped at" as caps; everything else is an audit note', () => {
    const r = splitCaps({ criteria, caps: [
      'Metadata-only evidence: capped at 5',
      'mh2: stated by the candidate, not shown in the work; strong lowered to partial',
      'Some reviewer text was removed by the fairness filter',
      'A document could not be read natively - judged from its extracted text',
    ] });
    expect(r.caps).toEqual(['Metadata-only evidence: capped at 5']);
    expect(r.notes).toEqual([
      'Led a creative team — stated by the candidate, not shown in the work; strong lowered to partial',
      'Some reviewer text was removed by the fairness filter',
      'A document could not be read natively - judged from its extracted text',
    ]);
  });
  it('never shows an internal criterion id: it becomes the criterion\'s name, or is dropped when the criterion is not known', () => {
    const r = splitCaps({ criteria, evidenceNotes: ['mh3: quoted text not found in L1; partial lowered to not_evidenced', 'nh2: only metadata of L4 was seen; strong lowered to partial', 'eq_ownership: no source cited; strong lowered to partial', 'MH7: x'] });
    expect(r.notes).toEqual([
      'Launched 5+ campaigns — quoted text not found in L1; partial lowered to not_evidenced',
      'only metadata of L4 was seen; strong lowered to partial',
      'Personal role is evidenced — no source cited; strong lowered to partial',
      'x',
    ]);
    expect(r.notes.join(' ')).not.toMatch(/\b(mh|nh)\d+:|eq_/i);
  });
  it('a verdict note that happens to contain "capped at" is still a note, not a score cap', () => {
    const r = splitCaps({ criteria, caps: ['mh5: video craft capped at partial'] });
    expect(r.caps).toEqual([]);
    expect(r.notes).toHaveLength(1);
  });
  it('combines the new field with notes found in an older review\'s caps, once each, and survives odd input', () => {
    const r = splitCaps({ caps: ['Some reviewer text was removed by the fairness filter', 7 as never, '  ', null as never], evidenceNotes: ['Some reviewer text was removed by the fairness filter', 'Another note'] });
    expect(r).toEqual({ caps: [], notes: ['Some reviewer text was removed by the fairness filter', 'Another note'] });
    expect(splitCaps({})).toEqual({ caps: [], notes: [] });
    expect(splitCaps({ caps: 'x' as never, evidenceNotes: {} as never, criteria: 'y' as never })).toEqual({ caps: [], notes: [] });
  });
});

describe('PortfolioReviewCard — marketing work samples: caps and how the evidence was checked', () => {
  it('an older review with audit notes in `caps` does not say "Score capped" — the notes sit in a folded "How the evidence was checked"', async () => {
    answer({ analysis: analysis({
      criteria: [crit('mh2', 'Led a creative team', 'partial', { group: 'corroboration' }), crit('mh3', 'Launched 5+ campaigns', 'partial')],
      caps: [
        'mh2: stated by the candidate, not shown in the work; strong lowered to partial',
        'mh3: quoted text not found in L1; strong lowered to partial',
        'Some reviewer text was removed by the fairness filter',
      ],
    }) });
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    expect(screen.queryByTestId('caps-note')).not.toBeInTheDocument();
    expect(bodyText()).not.toMatch(/Score capped/);
    const notes = screen.getByTestId('evidence-notes') as HTMLDetailsElement;
    expect(notes.tagName).toBe('DETAILS');
    expect(notes.open).toBe(false);                                               // folded away until asked for
    expect(within(notes).getByText('How the evidence was checked')).toBeInTheDocument();
    expect(notes).toHaveTextContent('Launched 5+ campaigns — quoted text not found in L1; strong lowered to partial');
    expect(notes).toHaveTextContent('Some reviewer text was removed by the fairness filter');
    expect(notes.textContent).not.toMatch(/\bmh\d+\b/);                          // no internal ids
  });

  it('a real cap still reads "Score capped", and the notes beside it stay out of that line', async () => {
    answer({ analysis: analysis({
      caps: ['Metadata-only evidence: capped at 5', 'mh3: quoted text not found in L1; strong lowered to partial'],
      evidenceNotes: ['Some images or document pages were left out to stay within the size limit'],
    }) });
    renderCard('completed');
    expect(await screen.findByTestId('caps-note')).toHaveTextContent(/^Score capped: Metadata-only evidence: capped at 5$/);
    const notes = screen.getByTestId('evidence-notes');
    expect(notes).toHaveTextContent('quoted text not found in L1');
    expect(notes).toHaveTextContent('Some images or document pages were left out');
  });

  it('shows nothing when there are no notes', async () => {
    answer({ analysis: analysis({ caps: [], evidenceNotes: [] }) });
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    expect(screen.queryByTestId('evidence-notes')).not.toBeInTheDocument();
    expect(screen.queryByTestId('caps-note')).not.toBeInTheDocument();
  });
});

// ─── Re-run: the toast says what really happened ─────────────────────────────────────────────────

describe('PortfolioReviewCard — Re-run toasts for outcomes that settled at once', () => {
  const click = async () => { fireEvent.click(await screen.findByRole('button', { name: /Re-run/ })); };
  const rerun = async (kind: 'design_portfolio' | 'marketing_work', result: Record<string, unknown>) => {
    portfolioReview.mockResolvedValue({ data: { kind, status: 'failed', score: null, message: null, urls: [], analysis: null } });
    rerunPortfolio.mockResolvedValue({ data: { links: 1, ...result } });
    renderCard('failed');
    await click();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    return vi.mocked(toast.success).mock.calls[0][0];
  };

  it.each([
    [{ status: 'unreviewable', queued: false }, 'Nothing could be opened automatically — not scored; open the links by hand'],
    [{ status: 'failed', queued: false }, 'No new work found — the earlier review still applies'],
    [{ status: 'inaccessible', queued: false }, 'The links are private or gone — not scored'],
    [{ status: 'no_portfolio', queued: false }, 'No work samples to review in the application answer — not scored'],
    [{ status: 'pending', queued: false }, 'Saved, but could not be queued — try again shortly'],
    [{ status: 'pending', queued: true }, 'Work-sample review queued'],
    [{ status: 'pending' }, 'Saved, but could not be queued — try again shortly'],
  ])('marketing: %j says "%s"', async (result, message) => {
    expect(await rerun('marketing_work', result)).toBe(message);
  });

  it('only a job that was really queued says "queued"; a settled outcome never says "try again shortly"', async () => {
    for (const status of ['unreviewable', 'failed', 'inaccessible']) {
      vi.mocked(toast.success).mockReset(); document.body.innerHTML = '';
      expect(await rerun('marketing_work', { status, queued: false })).not.toMatch(/try again|queued/i);
    }
  });

  it('the designer review\'s toasts are exactly as they were', async () => {
    expect(await rerun('design_portfolio', { status: 'no_portfolio', queued: false })).toBe('No portfolio link found in the resume');
    vi.mocked(toast.success).mockReset(); document.body.innerHTML = '';
    expect(await rerun('design_portfolio', { status: 'pending', queued: true })).toBe('Portfolio review queued');
    vi.mocked(toast.success).mockReset(); document.body.innerHTML = '';
    expect(await rerun('design_portfolio', { status: 'pending', queued: false })).toBe('Saved, but could not be queued — try again shortly');
  });
});

// ─── When the review cannot be loaded ────────────────────────────────────────────────────────────

describe('PortfolioReviewCard — the review could not be loaded', () => {
  const marketingWords = /Work-sample|work sample|No portfolio was found|Portfolio review queued|Reviewing the portfolio|could not be opened|Not scored/;

  it.each(['pending', 'running', 'completed', 'no_portfolio', 'inaccessible', 'unreviewable', 'failed'] as const)(
    'says so, and offers a retry, instead of guessing from the application\'s "%s" status',
    async (status) => {
      portfolioReview.mockRejectedValue(new Error('Network Error'));
      renderCard(status);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Could not load the review');
      expect(within(alert).getByRole('button', { name: /Retry/ })).toBeInTheDocument();
      // no wording of either kind, nothing taken from the status that came with the application
      expect(bodyText()).not.toMatch(marketingWords);
      expect(screen.queryByRole('button', { name: /Re-run/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/Loading portfolio review/)).not.toBeInTheDocument();
    },
  );

  it('Retry asks again, and the card then shows the review in its own words', async () => {
    portfolioReview.mockRejectedValueOnce(new Error('Network Error'));   // the first load fails ...
    answer({ analysis: analysis() });                                    // ... every later one succeeds
    renderCard('completed');
    fireEvent.click(await within(await screen.findByRole('alert')).findByRole('button', { name: /Retry/ }));
    expect(await screen.findByText('A competent portfolio, strongest on brand narrative.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(portfolioReview).toHaveBeenCalledTimes(2);
  });

  it('a completed card never silently vanishes: no details on file is said plainly', async () => {
    answer({ status: 'completed', score: 7, analysis: null });
    renderCard('completed');
    expect(await screen.findByText('The review finished, but its details are not available.')).toBeInTheDocument();
    expect(bodyText()).toContain('7/10');
  });

  it('a designer review that loads is unaffected (a response with no kind is still the designer\'s)', async () => {
    portfolioReview.mockResolvedValue({ data: { status: 'running', score: null, message: null, urls: [], analysis: null } });
    renderCard('running');
    expect(await screen.findByText(/Reviewing the portfolio now/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// ─── A review that never reached the queue ───────────────────────────────────────────────────────

describe('PortfolioReviewCard — could not be queued', () => {
  const QUEUE_ERROR = "Could not be queued (Cannot find package '@vercel/queue' imported from /app/src/services/portfolio/enqueue.ts). Use Re-run to retry.";

  it.each(['design_portfolio', 'marketing_work'] as const)('%s: a "Not queued" state — no spinner, no promise of an update, none of the queue\'s own error text', async (kind) => {
    portfolioReview.mockResolvedValue({ data: { kind, status: 'pending', score: null, message: QUEUE_ERROR, urls: [], analysis: null } });
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PortfolioReviewCard applicationId="A0001" status="pending" /></QueryClientProvider>,
    );
    expect(await screen.findByText('Not queued')).toBeInTheDocument();
    expect(screen.getByText(/The review could not be queued\. Use Re-run to retry\./)).toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(bodyText()).not.toMatch(/will update|provisional|usually a few minutes|queued —|Reviewing|vercel|enqueue|Cannot find package|\/app\//i);
    expect(screen.getByRole('button', { name: /Re-run/ })).toBeInTheDocument();
    // it says what the average holds meanwhile
    expect(bodyText()).toMatch(kind === 'marketing_work' ? /The overall score currently excludes this review\./ : /The overall score currently excludes the portfolio\./);
  });

  it('keeps an earlier score in the average and says so', async () => {
    portfolioReview.mockResolvedValue({ data: { kind: 'marketing_work', status: 'pending', score: 7, message: QUEUE_ERROR, urls: [], analysis: null } });
    renderCard('pending');
    expect(await screen.findByText(/The overall score still includes the earlier review \(7\/10\)\./)).toBeInTheDocument();
  });

  it('a Hiring Manager gets no instruction to use a button they do not have', async () => {
    canHR = false;
    portfolioReview.mockResolvedValue({ data: { kind: 'marketing_work', status: 'pending', score: null, message: QUEUE_ERROR, urls: [], analysis: null } });
    renderCard('pending');
    expect(await screen.findByText('Not queued')).toBeInTheDocument();
    expect(bodyText()).not.toMatch(/Re-run/);
    expect(screen.queryByRole('button', { name: /Re-run/ })).not.toBeInTheDocument();
  });

  it('a pending review that WAS queued is unchanged, whatever other note it carries', async () => {
    portfolioReview.mockResolvedValue({ data: { kind: 'marketing_work', status: 'pending', score: null, message: null, urls: [], analysis: null } });
    renderCard('pending');
    expect(await screen.findByText(/Work-sample review queued — the overall score shown is provisional/)).toBeInTheDocument();
    expect(screen.queryByText('Not queued')).not.toBeInTheDocument();
  });

  it('isNotQueued reads the stored message', () => {
    expect(isNotQueued(QUEUE_ERROR)).toBe(true);
    expect(isNotQueued('  could not be queued (x)')).toBe(true);
    expect(isNotQueued('Analysis failed — could not be queued earlier')).toBe(false);
    expect(isNotQueued(null)).toBe(false);
    expect(isNotQueued(undefined)).toBe(false);
  });

  describe('polling', () => {
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(() => { vi.useRealTimers(); });

    it('a queued review is polled every 15 s', async () => {
      portfolioReview.mockResolvedValue({ data: { kind: 'marketing_work', status: 'pending', score: null, message: null, urls: [], analysis: null } });
      renderCard('pending');
      await screen.findByText(/Work-sample review queued/);
      expect(portfolioReview).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(15_500); });
      expect(portfolioReview.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('a review that could not be queued is not polled: nothing will change on its own', async () => {
      portfolioReview.mockResolvedValue({ data: { kind: 'marketing_work', status: 'pending', score: null, message: QUEUE_ERROR, urls: [], analysis: null } });
      renderCard('pending');
      await screen.findByText('Not queued');
      expect(portfolioReview).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(portfolioReview).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── Long unbroken text stays inside the card ────────────────────────────────────────────────────

describe('PortfolioReviewCard — long unbroken strings', () => {
  const LONG = `https://drive.google.com/file/d/${'A1b2C3d4E5'.repeat(19)}/view?usp=sharing&resourcekey=${'0-x'.repeat(10)}`;   // ~250 characters, no space
  const TAG = `#${'WorldWaterDay'.repeat(10)}`;

  const wraps = (el: Element) => !!el.closest('[class*="overflow-wrap:anywhere"]');
  const card = () => document.querySelector('[class*="rounded-lg"]') as HTMLElement;

  it('every place the model or the candidate\'s text lands wraps anywhere, and the card root can shrink', async () => {
    answer({ analysis: analysis({
      summary: `Strong work, see ${LONG}`,
      portfolios: [work({ ref: 'L1', facts: [`Fetched ${LONG}`], summary: `Deck at ${LONG}` })],
      highlights: [`Best piece: ${LONG}`], redFlags: [`Outcome unverified: ${LONG}`],
      campaigns: [{ name: TAG, metric: `${LONG} reach`, roleStated: 'led' }],
      unverifiedClaims: [`Says ${LONG}`],
      criteria: [crit('mh1', 'Built a brand from scratch', 'strong', { evidence: `Quote: ${LONG}` })],
      jdAlignment: { mustHaves: [], niceToHaves: [{ item: 'Climate or water sector work', verdict: 'strong', evidence: `See ${LONG}` }] },
      caps: [`Metadata-only evidence: capped at 5 ${LONG}`],
      evidenceNotes: [`mh1: quoted text not found in ${LONG}`],
      unreviewed: [{ url: LONG, platform: 'link_hub', reason: `Not opened ${LONG}` }],
    }) });
    renderCard('completed');
    await screen.findByText(new RegExp('Strong work, see'));
    expect(card().className).toContain('min-w-0');
    expect(card().className).toContain('[overflow-wrap:anywhere]');
    expect(card().className).toContain('break-words');
    const texts = [
      /Strong work, see/, /Fetched /, /Deck at /, /Best piece: /, /Outcome unverified: /, /Says /, /Quote: /, /See https/,
      /Metadata-only evidence: capped at 5/, /quoted text not found in/, /Not opened https/,
    ];
    for (const t of texts) {
      const els = screen.getAllByText(t, { exact: false });
      expect(els.length).toBeGreaterThan(0);
      for (const el of els) expect(wraps(el), `${t} should wrap`).toBe(true);
    }
    expect(wraps(screen.getByText(TAG))).toBe(true);
    // chips and campaign text can shrink inside their flex row
    const chip = screen.getByText(`Fetched ${LONG}`);
    expect(chip.className).toContain('min-w-0');
    expect(chip.className).toContain('max-w-full');
    expect(screen.getByText(TAG).parentElement!.className).toContain('min-w-0');
    // grid cells may shrink too (a grid item is not allowed to be narrower than its text unless it says so)
    expect(screen.getByText('✓ Work-sample strengths').parentElement!.className).toContain('min-w-0');
    expect(screen.getByText('Quote: ' + LONG).closest('li')!.className).toContain('min-w-0');
  });

  it('a raw address is shown shortened, with the whole address in its title', async () => {
    answer({ analysis: analysis({ portfolios: [work({ ref: 'L1', url: LONG })], unreviewed: [{ url: `${LONG}&x=2`, platform: 'link_hub', reason: 'r' }] }) });
    renderCard('completed');
    await screen.findByTestId('coverage-summary');
    for (const url of [LONG, `${LONG}&x=2`]) {
      const link = screen.getByTitle(url);
      expect(link.getAttribute('href')).toBe(url);
      expect(within(link).getByText(url.replace(/^https?:\/\/(www\.)?/, '')).className).toContain('truncate');
      expect(link.className).toContain('max-w-[16rem]');
    }
  });

  it('the not-scored and failed cards wrap too', async () => {
    answer({ status: 'no_portfolio', score: null, message: `No work: ${LONG}`, analysis: analysis({ portfolios: [], criteria: [], model: 'none', claimText: `I did ${LONG}` }) });
    renderCard('no_portfolio');
    expect(wraps(await screen.findByText(/No work:/, { exact: false }))).toBe(true);
    expect(card().className).toContain('min-w-0');
    document.body.innerHTML = '';
    portfolioReview.mockReset();
    answer({ status: 'failed', score: null, analysis: null, message: `Analysis failed: ${LONG}` });
    renderCard('failed');
    expect(wraps(await screen.findByText(/Analysis failed:/, { exact: false }))).toBe(true);
  });

  it('the designer card\'s markup is left exactly as it was', async () => {
    portfolioReview.mockResolvedValue({ data: { status: 'completed', score: 8, message: null, urls: [], analysis: {
      version: 1, analyzedAt: '2026-10-01T00:00:00Z', model: 'claude-sonnet-4-5', portfolios: [], criteria: [{ id: 'ownership', label: 'Full ownership of a product', verdict: 'strong', evidence: 'Led it' }],
      jdAlignment: { mustHaves: [{ item: 'Design systems', verdict: 'partial', evidence: 'A library' }], niceToHaves: [] },
      modelScore: 8, checklistScore: 7, score: 8, scoreNote: '', highlights: ['Strong'], redFlags: [], summary: 'A strong designer portfolio.',
    } } });
    renderCard('completed');
    await screen.findByText('A strong designer portfolio.');
    expect(card().className).toBe('rounded-lg border border-gray-200 bg-white p-3 space-y-3');
    expect(card().innerHTML).not.toContain('overflow-wrap');
  });
});

// ─── Contrast of the small print ─────────────────────────────────────────────────────────────────

describe('PortfolioReviewCard — small print is readable', () => {
  const faint = /text-gray-(100|200|300|400)\b/;
  const card = () => document.querySelector('[class*="rounded-lg"]') as HTMLElement;
  it('the footer with the judgement and checklist numbers, and the criteria-group hints, are at least gray-500 at 11px', async () => {
    answer({ analysis: analysis({ criteria: [crit('mh1', 'Built a brand from scratch', 'strong'), crit('mh8', 'Mission', 'strong', { group: 'corroboration' })] }) });
    renderCard('completed');
    const footer = await screen.findByText(/Reviewed .* · judgement 7\/10, checklist 6\/10/);
    expect(footer.className).toContain('text-gray-500');
    expect(footer.className).toContain('text-[11px]');
    expect(footer.className).not.toMatch(faint);
    const hint = screen.getByText('Things a portfolio can show for itself.');
    expect(hint.className).toContain('text-gray-500');
    expect(hint.className).toContain('text-[11px]');
    expect(hint.className).not.toMatch(faint);
    expect(screen.getByText(/A portfolio rarely proves these/).className).toContain('text-gray-500');
  });

  it('the link refs (L1 …) that tie evidence to a link are gray-500 or darker wherever they appear: on a link read, on a link not read, and on a campaign', async () => {
    answer({ analysis: analysis({
      portfolios: [work({ ref: 'L1' }), work({ ref: 'L2', url: 'https://drive.google.com/file/d/BBBBBBBBBBBB/view', outcome: 'inaccessible', reason: 'The file is not shared' })],
      campaigns: [{ name: 'Jal Mitra launch', metric: '2.1M reach', roleStated: 'led', ref: 'L1' }],
    }) });
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    const inRow = within(screen.getByTestId('work-link')).getByText('L1');
    const inNotReviewed = within(screen.getByTestId('unreviewed-item')).getByText('L2');
    const inCampaign = within(screen.getByTestId('campaigns')).getByText('L1');
    for (const ref of [inRow, inNotReviewed, inCampaign]) {
      expect(ref.className).toContain('font-mono');
      expect(ref.className).toContain('text-gray-500');
      expect(ref.className).not.toMatch(faint);
    }
  });

  it('the empty states (no strengths, no concerns) are gray-500 or darker', async () => {
    answer({ analysis: analysis({ highlights: ['Clear campaign narrative'], redFlags: [] }) });
    renderCard('completed');
    const none = await screen.findByText('None noted');
    expect(none.className).toContain('text-gray-500');
    expect(none.className).not.toMatch(faint);
    document.body.innerHTML = '';
    portfolioReview.mockReset();
    answer({ analysis: analysis({ highlights: [], redFlags: ['Outcomes are stated without a baseline'] }) });
    renderCard('completed');
    await screen.findByText(/Outcomes are stated without a baseline/);
    const dash = screen.getAllByText('—').find(e => e.tagName === 'P');
    expect(dash?.className).toContain('text-gray-500');
    expect(dash?.className).not.toMatch(faint);
  });

  it('every piece of text a marketing card shows with the "completed" fixture is gray-500 or darker, apart from the "/10" after the score', async () => {
    answer({ analysis: analysis({
      portfolios: [work({ ref: 'L1' }), work({ ref: 'L2', url: 'https://drive.google.com/file/d/BBBBBBBBBBBB/view', outcome: 'inaccessible', reason: 'The file is not shared' })],
      campaigns: [{ name: 'Jal Mitra launch', roleStated: 'led', ref: 'L1' }],
      criteria: [crit('mh1', 'Built a brand from scratch', 'strong'), crit('mh8', 'Mission', 'strong', { group: 'corroboration' })],
      highlights: [], redFlags: [],
    }) });
    renderCard('completed');
    await screen.findByText('A competent portfolio, strongest on brand narrative.');
    const faintText = Array.from(card().querySelectorAll<HTMLElement>('*'))
      .filter(e => faint.test(e.className) && Array.from(e.childNodes).some(n => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== ''))
      .map(e => (e.textContent ?? '').trim());
    expect(faintText).toEqual(['/10']);
  });

  it('the designer card keeps its own markup: its empty states are untouched (R007 is unchanged)', async () => {
    portfolioReview.mockResolvedValue({ data: { status: 'completed', score: 8, message: null, urls: [], analysis: {
      version: 1, analyzedAt: '2026-10-01T00:00:00Z', model: 'claude-sonnet-4-5', portfolios: [], criteria: [{ id: 'o', label: 'Ownership', verdict: 'strong', evidence: '' }],
      jdAlignment: { mustHaves: [], niceToHaves: [] }, modelScore: 8, checklistScore: 7, score: 8, scoreNote: '', highlights: ['Strong'], redFlags: [], summary: 'S.',
    } } });
    renderCard('completed');
    await screen.findByText('S.');
    // Only the marketing card's small print was darkened. Whether the designer card's should be is a separate decision about a
    // review that is deliberately byte-identical to what it was.
    expect(card().innerHTML).toContain('<p class="text-xs text-gray-400">None noted</p>');
  });

  it('the designer card\'s footer too', async () => {
    portfolioReview.mockResolvedValue({ data: { status: 'completed', score: 8, message: null, urls: [], analysis: {
      version: 1, analyzedAt: '2026-10-01T00:00:00Z', model: 'claude-sonnet-4-5', portfolios: [], criteria: [{ id: 'o', label: 'Ownership', verdict: 'strong', evidence: '' }],
      jdAlignment: { mustHaves: [], niceToHaves: [] }, modelScore: 8, checklistScore: 7, score: 8, scoreNote: '', highlights: [], redFlags: [], summary: 'S.',
    } } });
    renderCard('completed');
    const footer = await screen.findByText(/Reviewed .* · judgement 8\/10, checklist 7\/10/);
    expect(footer.className).toContain('text-gray-500');
    expect(footer.className).toContain('text-[11px]');
  });
});

// ─── The candidate's own answer: scheme-less links are clickable ────────────────────────────────

describe('PortfolioReviewCard — the candidate\'s description', () => {
  it('links the addresses written without a scheme, and leaves an e-mail address as text', async () => {
    answer({ status: 'no_portfolio', score: null, analysis: analysis({ portfolios: [], criteria: [], model: 'none', claimText: 'Reel at instagram.com/brightlane.studio, deck: drive.google.com/file/d/AAAAAAAAAAAA/view and www.canva.com/design/XYZ. Mail me@brightlane.studio' }) });
    renderCard('no_portfolio');
    const claim = await screen.findByTestId('claim-text');
    expect(within(claim).getAllByRole('link').map(a => a.getAttribute('href'))).toEqual([
      'https://instagram.com/brightlane.studio', 'https://drive.google.com/file/d/AAAAAAAAAAAA/view', 'https://www.canva.com/design/XYZ',
    ]);
    expect(claim).toHaveTextContent('Mail me@brightlane.studio');
  });
});
