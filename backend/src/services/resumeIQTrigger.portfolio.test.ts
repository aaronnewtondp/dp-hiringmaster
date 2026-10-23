import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

// Characterization tests for runResumeIQScoring in resumeIQTrigger.ts, concentrating on the
// portfolio-review branch (roles with portfolio_analysis_enabled). They pin what the code does
// TODAY so the portfolio pipeline can be refactored to host a second review kind without changing
// anything R007 sees. Everything outside the function (database, Claude scoring, Drive, link
// picking, the queue hand-off) is mocked; hasReadableText and SLA_HOURS are the real ones.

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
  return {
    ...actual,
    scoreCandidate: (...a: unknown[]) => scoreCandidate(...a),
  };
});

const fetchResumeText = vi.fn();
const fetchResumeTextAndLinks = vi.fn();
vi.mock('./driveService.js', () => ({
  fetchResumeText: (...a: unknown[]) => fetchResumeText(...a),
  fetchResumeTextAndLinks: (...a: unknown[]) => fetchResumeTextAndLinks(...a),
}));

const pickPortfolioLinks = vi.fn();
vi.mock('./portfolio/links.js', () => ({ pickPortfolioLinks: (...a: unknown[]) => pickPortfolioLinks(...a) }));

const preparePortfolioReview = vi.fn();
const markPortfolioFailed = vi.fn();
vi.mock('./portfolio/enqueue.js', () => ({
  preparePortfolioReview: (...a: unknown[]) => preparePortfolioReview(...a),
  markPortfolioFailed: (...a: unknown[]) => markPortfolioFailed(...a),
}));

import { runResumeIQScoring } from './resumeIQTrigger.js';
import { SLA_HOURS } from '../types/index.js';

afterAll(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
});

// ─── fixtures ────────────────────────────────────────────────────────────────
const RESUME_URL = 'https://drive.google.com/file/d/abc123/view';
// >= 50 readable characters, so hasReadableText() says yes
const READABLE_TEXT = 'Jane Doe — Senior product designer, ten years of shipping design systems and mobile apps.';
const SCREENING = [{ question: 'Why this role?', answer: 'I love water tech.' }];

const APP = {
  id: 'A0611', candidate_id: 'C1001', role_id: 'R007', score_avg: null,
  preferred_location: 'Mumbai', screening_answers: SCREENING,
};
const CANDIDATE = { id: 'C1001', full_name: 'Jane Doe', resume_drive_link: RESUME_URL };
const ROLE_ON  = { id: 'R007', title: 'Senior UX/Product Designer', portfolio_analysis_enabled: true };
const ROLE_OFF = { id: 'R003', title: 'Quality Assurance Engineer', portfolio_analysis_enabled: false };

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
const LINK_A = { url: 'https://jane.design', host: 'jane.design', platform: 'custom' };
const LINK_B = { url: 'https://www.behance.net/jane', host: 'behance.net', platform: 'behance' };
const RAW_LINKS = [{ url: 'https://jane.design', label: 'Portfolio' }, { url: 'https://www.behance.net/jane' }];

let app: Record<string, unknown> | null;
let candidate: Record<string, unknown> | null;
let role: Record<string, unknown> | null;

const sql = (call: number) => String(query.mock.calls[call][0]).replace(/\s+/g, ' ').trim();

beforeEach(() => {
  app = { ...APP };
  candidate = { ...CANDIDATE };
  role = { ...ROLE_ON };
  query.mockReset().mockResolvedValue([]);
  queryOne.mockReset().mockImplementation(async (s: string) => {
    if (/FROM applications/.test(s)) return app;
    if (/FROM candidates/.test(s)) return candidate;
    if (/FROM roles/.test(s)) return role;
    return null;
  });
  // like the real scoreCandidate: resumeRead is simply "was text supplied"
  scoreCandidate.mockReset().mockImplementation(async (_c: unknown, _r: unknown, text: string | null) => scored({ resumeRead: !!text }));
  fetchResumeText.mockReset().mockResolvedValue(READABLE_TEXT);
  fetchResumeTextAndLinks.mockReset().mockResolvedValue({ text: READABLE_TEXT, links: RAW_LINKS });
  pickPortfolioLinks.mockReset().mockReturnValue([LINK_A, LINK_B]);
  preparePortfolioReview.mockReset().mockResolvedValue({ status: 'pending', links: [LINK_A, LINK_B], queued: true });
  markPortfolioFailed.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

// ─── guards before any work ──────────────────────────────────────────────────
describe('runResumeIQScoring — guards', () => {
  it('application missing: {scored:false, error} and not a single other call', async () => {
    app = null;
    expect(await runResumeIQScoring('A9999')).toStrictEqual({ scored: false, error: 'Application not found' });
    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(queryOne).toHaveBeenCalledWith('SELECT * FROM applications WHERE id=$1', ['A9999']);
    expect(query).not.toHaveBeenCalled();
    expect(scoreCandidate).not.toHaveBeenCalled();
  });

  it('already scored (score_avg set): {scored:true} with no lookups, fetches, scoring, writes or portfolio work', async () => {
    for (const score_avg of [7.4, '7.4', '0.0']) {          // pg returns NUMERIC as a string; any truthy value counts
      app = { ...APP, score_avg };
      expect(await runResumeIQScoring('A0611')).toStrictEqual({ scored: true });
    }
    expect(queryOne).toHaveBeenCalledTimes(3);              // only the application row, once per call
    expect(fetchResumeText).not.toHaveBeenCalled();
    expect(fetchResumeTextAndLinks).not.toHaveBeenCalled();
    expect(scoreCandidate).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(pickPortfolioLinks).not.toHaveBeenCalled();
    expect(preparePortfolioReview).not.toHaveBeenCalled();
    expect(markPortfolioFailed).not.toHaveBeenCalled();
  });

  it('candidate or role missing: {scored:false} and nothing is scored or queued', async () => {
    for (const which of ['candidate', 'role'] as const) {
      candidate = { ...CANDIDATE }; role = { ...ROLE_ON };
      if (which === 'candidate') candidate = null; else role = null;
      expect(await runResumeIQScoring('A0611')).toStrictEqual({ scored: false, error: 'Candidate or role not found' });
    }
    expect(scoreCandidate).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(preparePortfolioReview).not.toHaveBeenCalled();
  });

  it('looks the rows up by id: application by id, candidate by app.candidate_id, role by app.role_id', async () => {
    await runResumeIQScoring('A0611');
    expect(queryOne.mock.calls).toEqual([
      ['SELECT * FROM applications WHERE id=$1', ['A0611']],
      ['SELECT * FROM candidates WHERE id=$1', ['C1001']],
      ['SELECT * FROM roles WHERE id=$1', ['R007']],
    ]);
  });
});

// ─── flag OFF: the unchanged path every non-designer role takes ──────────────
describe('runResumeIQScoring — roles WITHOUT portfolio review', () => {
  for (const flag of [false, null, undefined] as const) {
    it(`portfolio_analysis_enabled=${String(flag)}: plain fetchResumeText, no links, no portfolio work, result {scored:true}`, async () => {
      role = { ...ROLE_OFF, portfolio_analysis_enabled: flag };
      const r = await runResumeIQScoring('A0611');

      expect(fetchResumeText).toHaveBeenCalledTimes(1);
      expect(fetchResumeText).toHaveBeenCalledWith(RESUME_URL);
      expect(fetchResumeTextAndLinks).not.toHaveBeenCalled();

      expect(pickPortfolioLinks).not.toHaveBeenCalled();
      expect(preparePortfolioReview).not.toHaveBeenCalled();
      expect(markPortfolioFailed).not.toHaveBeenCalled();

      expect(r).toStrictEqual({ scored: true });          // no `portfolio` key at all
    });
  }

  it('no resume link on file: nothing is fetched and the resume text is null', async () => {
    role = { ...ROLE_OFF };
    candidate = { ...CANDIDATE, resume_drive_link: null };
    expect(await runResumeIQScoring('A0611')).toStrictEqual({ scored: true });
    expect(fetchResumeText).not.toHaveBeenCalled();
    expect(fetchResumeTextAndLinks).not.toHaveBeenCalled();
    expect(scoreCandidate.mock.calls[0][2]).toBeNull();
  });
});

// ─── the base score is written exactly as before, whatever the role ──────────
describe('runResumeIQScoring — the 8-dimension score and what is passed to Claude', () => {
  it("passes candidate, role, the fetched text, the application's preferred location and the screening answers as the 5 arguments", async () => {
    await runResumeIQScoring('A0611');
    expect(scoreCandidate).toHaveBeenCalledTimes(1);
    const args = scoreCandidate.mock.calls[0];
    expect(args).toHaveLength(5);
    expect(args[0]).toBe(candidate);
    expect(args[1]).toBe(role);
    expect(args[2]).toBe(READABLE_TEXT);
    expect(args[3]).toBe('Mumbai');
    expect(args[4]).toBe(SCREENING);      // 5th argument: the screening answers, passed through untouched
  });

  it('with the portfolio flag ON the text comes from fetchResumeTextAndLinks (the same download), not fetchResumeText', async () => {
    await runResumeIQScoring('A0611');
    expect(fetchResumeTextAndLinks).toHaveBeenCalledTimes(1);
    expect(fetchResumeTextAndLinks).toHaveBeenCalledWith(RESUME_URL);
    expect(fetchResumeText).not.toHaveBeenCalled();
    expect(scoreCandidate.mock.calls[0][2]).toBe(READABLE_TEXT);
  });

  it('a resume that could not be fetched is scored from profile fields only (text null) — flag ON', async () => {
    fetchResumeTextAndLinks.mockResolvedValue({ text: null, links: [] });
    await runResumeIQScoring('A0611');
    expect(scoreCandidate.mock.calls[0][2]).toBeNull();
  });

  it('writes the score row (23 values + SLA + id) and then the activity log row, in that order, before any portfolio work', async () => {
    await runResumeIQScoring('A0611');

    expect(query).toHaveBeenCalledTimes(2);
    expect(sql(0)).toMatch(/^UPDATE applications SET score_technical=\$1, score_technical_note=\$2,/);
    expect(sql(0)).toMatch(/score_computed_at=NOW\(\), ai_fit_score=\$23, ai_priority_bucket=\$24, sla_hours=\$25 WHERE id=\$26$/);
    expect(query.mock.calls[0][1]).toStrictEqual([
      7, 't', 8, 'e', 6, 'i', 7, 'c', 8, 'r', 7, 'tr', 6, 'l', 8, 'co',
      7.4, ['s1', 's2', 's3'], ['rf'], 'Good fit.', 'Yes', true,
      74, 'Review',
      SLA_HOURS.RESUME_REVIEW_NORMAL,
      'A0611',
    ]);

    expect(sql(1)).toMatch(/^INSERT INTO activity_log \(application_id, candidate_id, role_id, event_type, event_detail, new_value, performed_by_name\) VALUES \(\$1,\$2,\$3,'ResumeIQ Scoring Completed',\$4,\$5,'System'\)$/);
    expect(query.mock.calls[1][1]).toStrictEqual(['A0611', 'C1001', 'R007', 'Score: 74/100 (Review)', 'Review']);

    // the portfolio hand-off comes only after both rows are saved
    const last = Math.max(...query.mock.invocationCallOrder);
    expect(preparePortfolioReview.mock.invocationCallOrder[0]).toBeGreaterThan(last);
  });

  it('derives ai_fit_score = round(avg*10), the bucket from avg, and the SLA hours from avg >= 8', async () => {
    scoreCandidate.mockResolvedValue(scored({ avgScore: 8.2 }));
    await runResumeIQScoring('A0611');
    const p = query.mock.calls[0][1] as unknown[];
    expect(p[16]).toBe(8.2);
    expect(p[22]).toBe(82);
    expect(p[23]).toBe('Strong Fit');
    expect(p[24]).toBe(SLA_HOURS.RESUME_REVIEW_HIGH_FIT);
    expect(query.mock.calls[1][1]).toStrictEqual(['A0611', 'C1001', 'R007', 'Score: 82/100 (Strong Fit)', 'Strong Fit']);
  });
});

// ─── flag ON: the portfolio branch ───────────────────────────────────────────
describe('runResumeIQScoring — roles WITH portfolio review', () => {
  it('picks at most 3 links with the candidate name, hands them to preparePortfolioReview, and maps its answer', async () => {
    const r = await runResumeIQScoring('A0611');

    expect(pickPortfolioLinks).toHaveBeenCalledTimes(1);
    expect(pickPortfolioLinks).toHaveBeenCalledWith(RAW_LINKS, 3, { candidateName: 'Jane Doe' });

    expect(preparePortfolioReview).toHaveBeenCalledTimes(1);
    expect(preparePortfolioReview).toHaveBeenCalledWith({ applicationId: 'A0611', links: [LINK_A, LINK_B], resumeRead: true });

    expect(r).toStrictEqual({ scored: true, portfolio: { status: 'pending', queued: true, links: 2 } });
    expect(markPortfolioFailed).not.toHaveBeenCalled();
  });

  it('passes the picked links through by reference, unmodified', async () => {
    const picked = [LINK_A];
    pickPortfolioLinks.mockReturnValue(picked);
    preparePortfolioReview.mockResolvedValue({ status: 'pending', links: picked, queued: true });
    await runResumeIQScoring('A0611');
    expect(preparePortfolioReview.mock.calls[0][0].links).toBe(picked);
  });

  it('the application id handed over is app.id (the row\'s id), not the argument as typed', async () => {
    app = { ...APP, id: 'A0611' };
    await runResumeIQScoring('a0611');
    expect(preparePortfolioReview.mock.calls[0][0].applicationId).toBe('A0611');
  });

  describe('result.portfolio is mapped from what preparePortfolioReview returned', () => {
    const cases: Array<{ name: string; prepared: unknown; expected: unknown }> = [
      {
        name: "'pending' + queued",
        prepared: { status: 'pending', links: [LINK_A, LINK_B], queued: true },
        expected: { status: 'pending', queued: true, links: 2 },
      },
      {
        name: "'pending' but the queue refused it",
        prepared: { status: 'pending', links: [LINK_A], queued: false },
        expected: { status: 'pending', queued: false, links: 1 },
      },
      {
        name: "'no_portfolio' (no link in the resume)",
        prepared: { status: 'no_portfolio', links: [], queued: false },
        expected: { status: 'no_portfolio', queued: false, links: 0 },
      },
      {
        name: "'busy' (a live review already holds the row)",
        prepared: { status: 'busy', links: [LINK_A, LINK_B], queued: false },
        expected: { status: 'busy', queued: false, links: 2 },
      },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        preparePortfolioReview.mockResolvedValue(c.prepared);
        const r = await runResumeIQScoring('A0611');
        expect(r).toStrictEqual({ scored: true, portfolio: c.expected });
      });
    }

    it('the link count is prepared.links.length, not the number of links picked', async () => {
      pickPortfolioLinks.mockReturnValue([LINK_A, LINK_B]);
      preparePortfolioReview.mockResolvedValue({ status: 'pending', links: [LINK_A], queued: true });
      const r = await runResumeIQScoring('A0611');
      expect(r.portfolio?.links).toBe(1);
    });
  });

  describe('resumeRead handed to preparePortfolioReview = scoring read the resume AND the text has real words', () => {
    const resumeReadSent = () => preparePortfolioReview.mock.calls[0][0].resumeRead;

    it('readable text → true', async () => {
      await runResumeIQScoring('A0611');
      expect(resumeReadSent()).toBe(true);
    });

    it('text that is only pdf-parse page markers (scanned PDF) → false, even though scoring "read" a non-empty string', async () => {
      fetchResumeTextAndLinks.mockResolvedValue({ text: '-- 1 of 2 --\n\n-- 2 of 2 --', links: [] });
      pickPortfolioLinks.mockReturnValue([]);
      preparePortfolioReview.mockResolvedValue({ status: 'no_portfolio', links: [], queued: false });
      await runResumeIQScoring('A0611');
      expect(scoreCandidate.mock.calls[0][2]).toBe('-- 1 of 2 --\n\n-- 2 of 2 --');
      expect(resumeReadSent()).toBe(false);
    });

    it('text shorter than 50 readable characters → false', async () => {
      fetchResumeTextAndLinks.mockResolvedValue({ text: 'Jane Doe, designer.', links: [] });
      await runResumeIQScoring('A0611');
      expect(resumeReadSent()).toBe(false);
    });

    it('no text at all (fetch failed) → false', async () => {
      fetchResumeTextAndLinks.mockResolvedValue({ text: null, links: [] });
      await runResumeIQScoring('A0611');
      expect(resumeReadSent()).toBe(false);
    });

    it('scoring says the resume was not read, even if the text is readable → false (&& short-circuits on result.resumeRead)', async () => {
      scoreCandidate.mockResolvedValue(scored({ resumeRead: false }));
      await runResumeIQScoring('A0611');
      expect(resumeReadSent()).toBe(false);
    });
  });

  it('no resume link on file: nothing is fetched, no links, and preparePortfolioReview still runs with resumeRead false', async () => {
    candidate = { ...CANDIDATE, resume_drive_link: null };
    pickPortfolioLinks.mockReturnValue([]);
    preparePortfolioReview.mockResolvedValue({ status: 'no_portfolio', links: [], queued: false });
    const r = await runResumeIQScoring('A0611');

    expect(fetchResumeText).not.toHaveBeenCalled();
    expect(fetchResumeTextAndLinks).not.toHaveBeenCalled();
    expect(scoreCandidate.mock.calls[0][2]).toBeNull();
    expect(pickPortfolioLinks).toHaveBeenCalledWith([], 3, { candidateName: 'Jane Doe' });
    expect(preparePortfolioReview).toHaveBeenCalledWith({ applicationId: 'A0611', links: [], resumeRead: false });
    expect(r).toStrictEqual({ scored: true, portfolio: { status: 'no_portfolio', queued: false, links: 0 } });
  });

  describe('links could not be read (linksError)', () => {
    beforeEach(() => {
      fetchResumeTextAndLinks.mockResolvedValue({ text: READABLE_TEXT, links: RAW_LINKS, linksError: true });
    });

    it("records OUR failure with a Re-run hint instead of a false 'no links' verdict, and queues nothing", async () => {
      const r = await runResumeIQScoring('A0611');

      expect(markPortfolioFailed).toHaveBeenCalledTimes(1);
      expect(markPortfolioFailed).toHaveBeenCalledWith('A0611', "The resume's links could not be read. Use Re-run to retry.");
      expect(pickPortfolioLinks).not.toHaveBeenCalled();
      expect(preparePortfolioReview).not.toHaveBeenCalled();
      expect(r).toStrictEqual({ scored: true, portfolio: { status: 'failed', queued: false, links: 0 } });
    });

    it('the 8-dimension score is still saved and logged first', async () => {
      await runResumeIQScoring('A0611');
      expect(query).toHaveBeenCalledTimes(2);
      expect(sql(0)).toMatch(/^UPDATE applications SET score_technical=/);
      expect(sql(1)).toMatch(/^INSERT INTO activity_log/);
      expect(markPortfolioFailed.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...query.mock.invocationCallOrder));
    });

    it('still scores from the text it did read', async () => {
      await runResumeIQScoring('A0611');
      expect(scoreCandidate.mock.calls[0][2]).toBe(READABLE_TEXT);
    });

    it('applies even when the text itself could not be read (text null)', async () => {
      fetchResumeTextAndLinks.mockResolvedValue({ text: null, links: [], linksError: true });
      const r = await runResumeIQScoring('A0611');
      expect(markPortfolioFailed).toHaveBeenCalledWith('A0611', "The resume's links could not be read. Use Re-run to retry.");
      expect(r.portfolio?.status).toBe('failed');
    });
  });

  it('linksError false or absent is not an error: the normal path runs', async () => {
    fetchResumeTextAndLinks.mockResolvedValue({ text: READABLE_TEXT, links: RAW_LINKS, linksError: false });
    expect((await runResumeIQScoring('A0611')).portfolio?.status).toBe('pending');
    expect(markPortfolioFailed).not.toHaveBeenCalled();
    expect(preparePortfolioReview).toHaveBeenCalledTimes(1);
  });

  describe('a failure in the portfolio hand-off never undoes the saved score', () => {
    it('preparePortfolioReview throwing → {scored:true} with no portfolio key, logged, score rows untouched', async () => {
      const boom = new Error('db down');
      preparePortfolioReview.mockRejectedValue(boom);
      const r = await runResumeIQScoring('A0611');

      expect(r).toStrictEqual({ scored: true });
      expect(console.error).toHaveBeenCalledWith('[ResumeIQ] Portfolio preparation failed for', 'A0611', boom);
      expect(query).toHaveBeenCalledTimes(2);                 // the score UPDATE and the activity row — nothing reverts them
      expect(markPortfolioFailed).not.toHaveBeenCalled();
    });

    it('pickPortfolioLinks throwing → {scored:true}, preparePortfolioReview not called', async () => {
      pickPortfolioLinks.mockImplementation(() => { throw new Error('bad url'); });
      expect(await runResumeIQScoring('A0611')).toStrictEqual({ scored: true });
      expect(preparePortfolioReview).not.toHaveBeenCalled();
    });

    it('markPortfolioFailed throwing on the linksError path → {scored:true}', async () => {
      fetchResumeTextAndLinks.mockResolvedValue({ text: READABLE_TEXT, links: RAW_LINKS, linksError: true });
      markPortfolioFailed.mockRejectedValue(new Error('db down'));
      expect(await runResumeIQScoring('A0611')).toStrictEqual({ scored: true });
    });
  });
});

// ─── failure before the score is saved ───────────────────────────────────────
describe('runResumeIQScoring — failure before the score is saved', () => {
  const SCORING_FAILED = { scored: false, error: 'Scoring failed — will retry automatically the next time this is retried' };

  it('scoreCandidate throwing → {scored:false, error}; nothing is written and no portfolio review is prepared', async () => {
    scoreCandidate.mockRejectedValue(new Error('anthropic 529'));
    expect(await runResumeIQScoring('A0611')).toStrictEqual(SCORING_FAILED);
    expect(query).not.toHaveBeenCalled();
    expect(preparePortfolioReview).not.toHaveBeenCalled();
    expect(markPortfolioFailed).not.toHaveBeenCalled();
  });

  it('the score UPDATE failing → {scored:false, error}; no portfolio review is prepared', async () => {
    query.mockRejectedValue(new Error('db down'));
    expect(await runResumeIQScoring('A0611')).toStrictEqual(SCORING_FAILED);
    expect(preparePortfolioReview).not.toHaveBeenCalled();
  });

  it('fetchResumeTextAndLinks throwing → the same {scored:false, error} (the Drive layer normally never throws)', async () => {
    fetchResumeTextAndLinks.mockRejectedValue(new Error('drive exploded'));
    expect(await runResumeIQScoring('A0611')).toStrictEqual(SCORING_FAILED);
    expect(scoreCandidate).not.toHaveBeenCalled();
  });
});
