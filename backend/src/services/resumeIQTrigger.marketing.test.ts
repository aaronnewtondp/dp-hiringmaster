import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

// runResumeIQScoring in resumeIQTrigger.ts, the work-sample branch: a role whose portfolio review takes its links
// from the screening answer (portfolio_review_kind 'marketing_work', profile source 'screening'). The designer
// branch is pinned by resumeIQTrigger.portfolio.test.ts and must stay as it is; the cases here only prove that
// the two never meet. Everything outside the function (database, Claude scoring, Drive, link picking, the queue
// hand-off) is mocked.

const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../db/index.js', () => ({ query: (...a: unknown[]) => query(...a), queryOne: (...a: unknown[]) => queryOne(...a) }));

// The real priorityBucketFromScore is pure, but resumeIQ.ts builds an Anthropic client at import time.
const scoreCandidate = vi.fn();
const savedKey = vi.hoisted(() => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = prev ?? 'placeholder-key-for-tests';
  return prev;
});
vi.mock('./resumeIQ.js', async () => {
  const actual = await vi.importActual<typeof import('./resumeIQ.js')>('./resumeIQ.js');
  return { ...actual, scoreCandidate: (...a: unknown[]) => scoreCandidate(...a) };
});

const fetchResumeText = vi.fn();
const fetchResumeTextAndLinks = vi.fn();
vi.mock('./driveService.js', () => ({
  fetchResumeText: (...a: unknown[]) => fetchResumeText(...a),
  fetchResumeTextAndLinks: (...a: unknown[]) => fetchResumeTextAndLinks(...a),
}));

const pickPortfolioLinks = vi.fn();
vi.mock('./portfolio/links.js', () => ({ pickPortfolioLinks: (...a: unknown[]) => pickPortfolioLinks(...a) }));

const pickAnswerLinks = vi.fn();
vi.mock('./portfolio/answerLinks.js', () => ({ pickAnswerLinks: (...a: unknown[]) => pickAnswerLinks(...a) }));

const preparePortfolioReview = vi.fn();
const prepareMarketingReview = vi.fn();
const markPortfolioFailed = vi.fn();
vi.mock('./portfolio/enqueue.js', () => ({
  preparePortfolioReview: (...a: unknown[]) => preparePortfolioReview(...a),
  prepareMarketingReview: (...a: unknown[]) => prepareMarketingReview(...a),
  markPortfolioFailed: (...a: unknown[]) => markPortfolioFailed(...a),
}));

import { runResumeIQScoring } from './resumeIQTrigger.js';
import { SLA_HOURS } from '../types/index.js';

afterAll(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
});

// ─── fixtures ────────────────────────────────────────────────────────────────
const RESUME_URL = 'https://drive.google.com/file/d/abc123/view';
const READABLE_TEXT = 'Jane Doe — Head of brand and growth, ten years of building brands for climate and water startups.';
const SCREENING = [
  { question: 'Why this role?', answer: 'I love water tech.' },
  { question: "Links to public resources/portfolio to highlight your past work? eg: brand campaigns/marketing intitiatives/ad designs etc that you've run", answer: 'https://jane.design' },
];

const APP = {
  id: 'A0619', candidate_id: 'C1001', role_id: 'R019', score_avg: null,
  preferred_location: 'Gurugram', screening_answers: SCREENING,
};
const CANDIDATE = { id: 'C1001', full_name: 'Jane Doe', resume_drive_link: RESUME_URL };
const ROLE_MARKETING = { id: 'R019', title: 'Head of Marketing & Creative Direction', portfolio_analysis_enabled: true, portfolio_review_kind: 'marketing_work' };

const dim = (score: number, note: string) => ({ score, note });
function scored(over: Record<string, unknown> = {}) {
  return {
    technical: dim(7, 't'), experience: dim(8, 'e'), industryFit: dim(6, 'i'), cultureFit: dim(7, 'c'),
    roleAlignment: dim(8, 'r'), trajectory: dim(7, 'tr'), leadership: dim(6, 'l'), communication: dim(8, 'co'),
    avgScore: 7.4, strengths: ['s1', 's2', 's3'], redFlags: ['rf'], summary: 'Good fit.', recommendation: 'Yes',
    resumeRead: true,
    ...over,
  };
}
const SITE = { url: 'https://jane.design', host: 'jane.design', platform: 'custom', handler: 'site' };
const DRIVE = { url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view', host: 'drive.google.com', platform: 'gdrive_file', handler: 'document' };
const PICK = { answered: true, textOnly: false, claimText: 'https://jane.design', links: [SITE, DRIVE], listedNotReviewed: [] };

let app: Record<string, unknown> | null;
let candidate: Record<string, unknown> | null;
let role: Record<string, unknown> | null;

const sql = (call: number) => String(query.mock.calls[call][0]).replace(/\s+/g, ' ').trim();

beforeEach(() => {
  app = { ...APP };
  candidate = { ...CANDIDATE };
  role = { ...ROLE_MARKETING };
  query.mockReset().mockResolvedValue([]);
  queryOne.mockReset().mockImplementation(async (s: string) => {
    if (/FROM applications/.test(s)) return app;
    if (/FROM candidates/.test(s)) return candidate;
    if (/FROM roles/.test(s)) return role;
    return null;
  });
  scoreCandidate.mockReset().mockImplementation(async (_c: unknown, _r: unknown, text: string | null) => scored({ resumeRead: !!text }));
  fetchResumeText.mockReset().mockResolvedValue(READABLE_TEXT);
  fetchResumeTextAndLinks.mockReset().mockResolvedValue({ text: READABLE_TEXT, links: [{ url: 'https://resume-link.example' }] });
  pickPortfolioLinks.mockReset().mockReturnValue([]);
  pickAnswerLinks.mockReset().mockReturnValue(PICK);
  preparePortfolioReview.mockReset().mockResolvedValue({ status: 'pending', links: [], queued: true });
  prepareMarketingReview.mockReset().mockResolvedValue({ status: 'pending', links: [SITE, DRIVE], queued: true });
  markPortfolioFailed.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

// ─── the work-sample branch ──────────────────────────────────────────────────
describe('runResumeIQScoring — roles whose review takes its links from the screening answer', () => {
  it('picks the links from the answers with the candidate name, prepares the review, and maps its answer', async () => {
    const r = await runResumeIQScoring('A0619');

    expect(pickAnswerLinks).toHaveBeenCalledTimes(1);
    expect(pickAnswerLinks.mock.calls[0]).toHaveLength(2);
    expect(pickAnswerLinks.mock.calls[0][0]).toBe(SCREENING);                      // the stored answers, untouched
    expect(pickAnswerLinks.mock.calls[0][1]).toStrictEqual({ candidateName: 'Jane Doe' });

    expect(prepareMarketingReview).toHaveBeenCalledTimes(1);
    expect(prepareMarketingReview.mock.calls[0][0]).toStrictEqual({ applicationId: 'A0619', pick: PICK });
    expect(prepareMarketingReview.mock.calls[0][0].pick).toBe(PICK);               // by reference, unmodified

    expect(r).toStrictEqual({ scored: true, portfolio: { status: 'pending', queued: true, links: 2 } });
  });

  it("the application id handed over is app.id (the row's id), not the argument as typed", async () => {
    await runResumeIQScoring('a0619');
    expect(prepareMarketingReview.mock.calls[0][0].applicationId).toBe('A0619');
  });

  describe('result.portfolio is mapped from what prepareMarketingReview returned', () => {
    const cases: Array<{ name: string; prepared: unknown; expected: unknown }> = [
      { name: "'pending' + queued", prepared: { status: 'pending', links: [SITE, DRIVE], queued: true }, expected: { status: 'pending', queued: true, links: 2 } },
      { name: "'pending' but the queue refused it", prepared: { status: 'pending', links: [SITE], queued: false }, expected: { status: 'pending', queued: false, links: 1 } },
      { name: "'no_portfolio' (blank, N/A or words only)", prepared: { status: 'no_portfolio', links: [], queued: false }, expected: { status: 'no_portfolio', queued: false, links: 0 } },
      { name: "'unreviewable' (only LinkedIn / social links)", prepared: { status: 'unreviewable', links: [], queued: false }, expected: { status: 'unreviewable', queued: false, links: 0 } },
      { name: "'busy' (a live review already holds the row)", prepared: { status: 'busy', links: [SITE, DRIVE], queued: false }, expected: { status: 'busy', queued: false, links: 2 } },
      { name: "'failed' (a re-run kept the earlier review)", prepared: { status: 'failed', links: [], queued: false }, expected: { status: 'failed', queued: false, links: 0 } },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        prepareMarketingReview.mockResolvedValue(c.prepared);
        expect(await runResumeIQScoring('A0619')).toStrictEqual({ scored: true, portfolio: c.expected });
      });
    }

    it('the link count is prepared.links.length, not the number of links picked', async () => {
      prepareMarketingReview.mockResolvedValue({ status: 'pending', links: [SITE], queued: true });
      expect((await runResumeIQScoring('A0619')).portfolio?.links).toBe(1);
    });
  });

  describe('the resume is not mined for portfolio links', () => {
    it('the resume text comes from fetchResumeText (one plain download), never fetchResumeTextAndLinks', async () => {
      await runResumeIQScoring('A0619');
      expect(fetchResumeText).toHaveBeenCalledTimes(1);
      expect(fetchResumeText).toHaveBeenCalledWith(RESUME_URL);
      expect(fetchResumeTextAndLinks).not.toHaveBeenCalled();
      expect(scoreCandidate.mock.calls[0][2]).toBe(READABLE_TEXT);
    });

    it('no resume hyperlinks are picked and the designer review is never prepared or failed', async () => {
      await runResumeIQScoring('A0619');
      expect(pickPortfolioLinks).not.toHaveBeenCalled();
      expect(preparePortfolioReview).not.toHaveBeenCalled();
      expect(markPortfolioFailed).not.toHaveBeenCalled();
    });

    it('the review does not depend on the resume: no file on file, or one that cannot be read, still prepares it', async () => {
      candidate = { ...CANDIDATE, resume_drive_link: null };
      expect(await runResumeIQScoring('A0619')).toStrictEqual({ scored: true, portfolio: { status: 'pending', queued: true, links: 2 } });
      expect(fetchResumeText).not.toHaveBeenCalled();
      expect(scoreCandidate.mock.calls[0][2]).toBeNull();
      expect(prepareMarketingReview).toHaveBeenCalledTimes(1);

      candidate = { ...CANDIDATE };
      fetchResumeText.mockResolvedValue(null);
      expect((await runResumeIQScoring('A0619')).portfolio?.status).toBe('pending');
      expect(scoreCandidate.mock.calls[1][2]).toBeNull();
      expect(prepareMarketingReview).toHaveBeenCalledTimes(2);
    });
  });

  describe('the base score is untouched by the work-sample review', () => {
    it('passes candidate, role, text, preferred location and the screening answers to Claude, as for any role', async () => {
      await runResumeIQScoring('A0619');
      const args = scoreCandidate.mock.calls[0];
      expect(args).toHaveLength(5);
      expect(args[0]).toBe(candidate);
      expect(args[1]).toBe(role);
      expect(args[3]).toBe('Gurugram');
      expect(args[4]).toBe(SCREENING);
    });

    it('writes the score row and the activity row first, and only then prepares the review', async () => {
      await runResumeIQScoring('A0619');

      expect(query).toHaveBeenCalledTimes(2);
      expect(sql(0)).toMatch(/^UPDATE applications SET score_technical=\$1, score_technical_note=\$2,/);
      expect(query.mock.calls[0][1]).toStrictEqual([
        7, 't', 8, 'e', 6, 'i', 7, 'c', 8, 'r', 7, 'tr', 6, 'l', 8, 'co',
        7.4, ['s1', 's2', 's3'], ['rf'], 'Good fit.', 'Yes', true,
        74, 'Review', SLA_HOURS.RESUME_REVIEW_NORMAL, 'A0619',
      ]);
      expect(sql(1)).toMatch(/^INSERT INTO activity_log/);
      expect(query.mock.calls[1][1]).toStrictEqual(['A0619', 'C1001', 'R019', 'Score: 74/100 (Review)', 'Review']);

      const last = Math.max(...query.mock.invocationCallOrder);
      expect(pickAnswerLinks.mock.invocationCallOrder[0]).toBeGreaterThan(last);
      expect(prepareMarketingReview.mock.invocationCallOrder[0]).toBeGreaterThan(last);
    });
  });

  describe('a failure in the work-sample hand-off never undoes the saved score', () => {
    it('prepareMarketingReview throwing → {scored:true} with no portfolio key, logged, score rows untouched', async () => {
      const boom = new Error('db down');
      prepareMarketingReview.mockRejectedValue(boom);
      const r = await runResumeIQScoring('A0619');

      expect(r).toStrictEqual({ scored: true });
      expect(console.error).toHaveBeenCalledWith('[ResumeIQ] Work-sample review preparation failed for', 'A0619', boom);
      expect(query).toHaveBeenCalledTimes(2);                 // the score UPDATE and the activity row — nothing reverts them
      expect(markPortfolioFailed).not.toHaveBeenCalled();
    });

    it('pickAnswerLinks throwing → {scored:true}, nothing prepared', async () => {
      pickAnswerLinks.mockImplementation(() => { throw new Error('bad answer'); });
      expect(await runResumeIQScoring('A0619')).toStrictEqual({ scored: true });
      expect(prepareMarketingReview).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(2);
    });
  });

  it('screening answers that are missing or not a list are handed over as they are (the picker decides what "not answered" means)', async () => {
    for (const answers of [null, undefined, 'not a list', {}]) {
      pickAnswerLinks.mockClear();
      app = { ...APP, screening_answers: answers };
      await runResumeIQScoring('A0619');
      expect(pickAnswerLinks.mock.calls[0][0]).toBe(answers);
    }
  });
});

// ─── the two reviews never meet ──────────────────────────────────────────────
describe('runResumeIQScoring — the marketing branch is entered by the marketing profile and nothing else', () => {
  it('a designer role (kind absent or design_portfolio) takes the resume branch: links from the resume, no answer picking', async () => {
    for (const kind of [undefined, 'design_portfolio']) {
      pickAnswerLinks.mockClear(); prepareMarketingReview.mockClear(); preparePortfolioReview.mockClear(); fetchResumeTextAndLinks.mockClear();
      role = { id: 'R007', portfolio_analysis_enabled: true, ...(kind ? { portfolio_review_kind: kind } : {}) };
      await runResumeIQScoring('A0619');
      expect(fetchResumeTextAndLinks).toHaveBeenCalledTimes(1);
      expect(preparePortfolioReview).toHaveBeenCalledTimes(1);
      expect(pickAnswerLinks).not.toHaveBeenCalled();
      expect(prepareMarketingReview).not.toHaveBeenCalled();
    }
  });

  for (const flag of [false, null, undefined] as const) {
    it(`a marketing kind with portfolio_analysis_enabled=${String(flag)}: no portfolio work at all, plain fetchResumeText`, async () => {
      role = { ...ROLE_MARKETING, portfolio_analysis_enabled: flag };
      expect(await runResumeIQScoring('A0619')).toStrictEqual({ scored: true });
      expect(fetchResumeText).toHaveBeenCalledWith(RESUME_URL);
      expect(fetchResumeTextAndLinks).not.toHaveBeenCalled();
      expect(pickAnswerLinks).not.toHaveBeenCalled();
      expect(prepareMarketingReview).not.toHaveBeenCalled();
      expect(preparePortfolioReview).not.toHaveBeenCalled();
    });
  }

  it('an unknown kind falls back to the designer review, never to the work-sample one', async () => {
    role = { ...ROLE_MARKETING, portfolio_review_kind: 'astrology' };
    await runResumeIQScoring('A0619');
    expect(prepareMarketingReview).not.toHaveBeenCalled();
    expect(pickAnswerLinks).not.toHaveBeenCalled();
    expect(preparePortfolioReview).toHaveBeenCalledTimes(1);
  });

  it('an application that is already scored does nothing, marketing role or not', async () => {
    app = { ...APP, score_avg: 7.4 };
    expect(await runResumeIQScoring('A0619')).toStrictEqual({ scored: true });
    expect(scoreCandidate).not.toHaveBeenCalled();
    expect(pickAnswerLinks).not.toHaveBeenCalled();
    expect(prepareMarketingReview).not.toHaveBeenCalled();
  });

  it('when scoring fails there is no review to prepare (the 8-dimension score is its precondition)', async () => {
    scoreCandidate.mockRejectedValue(new Error('anthropic 529'));
    expect(await runResumeIQScoring('A0619')).toStrictEqual({
      scored: false, error: 'Scoring failed — will retry automatically the next time this is retried',
    });
    expect(query).not.toHaveBeenCalled();
    expect(pickAnswerLinks).not.toHaveBeenCalled();
    expect(prepareMarketingReview).not.toHaveBeenCalled();
  });

  it('when saving the score fails there is no review to prepare either', async () => {
    query.mockRejectedValue(new Error('db down'));
    expect((await runResumeIQScoring('A0619')).scored).toBe(false);
    expect(prepareMarketingReview).not.toHaveBeenCalled();
  });
});
