import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// prepareMarketingReview and minimalMarketingAnalysis (enqueue.ts): what happens to a Head of Marketing
// application's work-sample review the moment the candidate's screening answer has been read. Blank, text-only
// and unopenable answers settle at once with score NULL (the dimension is not applied — never a 0) and no job;
// anything with a link to open is stored and queued. enqueue.prepare.test.ts pins the designer path of the same
// file and must stay as it is — nothing here repeats it. Only the database, the outcome writer and the queue are
// mocked; answerLinks.ts is the real module.
const query = vi.fn();
vi.mock('../../db/index.js', () => ({ query: (...a: unknown[]) => query(...a), queryOne: vi.fn(), transaction: vi.fn() }));
const applyPortfolioOutcome = vi.fn();
vi.mock('./scoring.js', () => ({ applyPortfolioOutcome: (...a: unknown[]) => applyPortfolioOutcome(...a) }));
const send = vi.fn();
vi.mock('@vercel/queue', () => ({ send: (...a: unknown[]) => send(...a) }));

import { PORTFOLIO_TOPIC, minimalMarketingAnalysis, prepareMarketingReview } from './enqueue.js';
import { pickAnswerLinks } from './answerLinks.js';
import type { AnswerLinkPick } from './answerLinks.js';
import { STALE_RUNNING_SECONDS } from './jobState.js';
import { jsonbSafeStringify } from './text.js';
import type { PortfolioLink } from './types.js';

const norm = (s: unknown) => String(s).replace(/\s+/g, ' ').trim();
const sqlOf = (call: number) => norm(query.mock.calls[call][0]);
const paramsOf = (call: number) => query.mock.calls[call][1] as unknown[];
const STALE = String(STALE_RUNNING_SECONDS);
const NOW = '2026-10-22T10:00:00.000Z';

// The conditional "reset to pending": the designer's with-links statement plus the score a previous review left. The stored
// links are replaced unless this run settles without a job ($4 = true) while an earlier review exists — that one keeps them.
const RESET_SQL =
  `UPDATE applications `
  + `SET portfolio_urls=CASE WHEN $4::boolean AND score_portfolio IS NOT NULL THEN portfolio_urls ELSE $1::jsonb END, `
  + `portfolio_analysis_status='pending', portfolio_analysis_error=NULL `
  + `WHERE id=$2 AND (portfolio_analysis_status IS DISTINCT FROM 'running' OR portfolio_started_at < NOW() - ($3 || ' seconds')::interval) `
  + `RETURNING id, score_portfolio`;
const MARK_FAILED_SQL =
  `UPDATE applications SET portfolio_analysis_status='failed', portfolio_analysis_error=$1 `
  + `WHERE id=$2 AND portfolio_analysis_status IS DISTINCT FROM 'running'`;

const MSG_NONE = 'No work samples provided; this dimension is not applied';
const MSG_TEXT_ONLY = 'Only a written description was provided - there were no work samples to review; this dimension is not applied';
const MSG_UNOPENABLE = 'The links are on platforms that cannot be opened automatically - open them by hand';

// ─── fixtures ────────────────────────────────────────────────────────────────
const ID = 'A0619';
const DRIVE_LINK: PortfolioLink = { url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view', host: 'drive.google.com', platform: 'gdrive_file', handler: 'document' };
const SITE_LINK: PortfolioLink = { url: 'https://jane.design', host: 'jane.design', platform: 'custom', handler: 'site' };
const LINKEDIN = { url: 'https://www.linkedin.com/in/jane-doe', platform: 'linkedin' as const, reason: 'LinkedIn blocks automated viewing - open it by hand' };
const FACEBOOK = { url: 'https://www.facebook.com/jane', platform: 'social_other' as const, reason: 'social media link not opened automatically' };

const NOT_ANSWERED: AnswerLinkPick = { answered: false, textOnly: false, claimText: '', links: [], listedNotReviewed: [] };
const TEXT_ONLY: AnswerLinkPick = {
  answered: true, textOnly: true, claimText: 'Led the 2023 rebrand of a water-purifier startup; grew Instagram from 2k to 40k.', links: [], listedNotReviewed: [],
};
const UNOPENABLE: AnswerLinkPick = {
  answered: true, textOnly: false, claimText: 'https://www.linkedin.com/in/jane-doe https://www.facebook.com/jane', links: [], listedNotReviewed: [LINKEDIN, FACEBOOK],
};
const WITH_LINKS: AnswerLinkPick = {
  answered: true, textOnly: false, claimText: 'my work: drive pdf, site, linkedin', links: [DRIVE_LINK, SITE_LINK], listedNotReviewed: [LINKEDIN],
};

const analysisOf = (extra: Record<string, unknown> = {}) => ({
  version: 1, kind: 'marketing_work', analyzedAt: NOW, model: 'none', portfolios: [], criteria: [],
  jdAlignment: { mustHaves: [], niceToHaves: [] }, modelScore: 0, checklistScore: 0, score: 0, scoreNote: '',
  highlights: [], redFlags: [], ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  query.mockReset().mockResolvedValue([{ id: ID, score_portfolio: null }]);     // by default the reset claims the row
  applyPortfolioOutcome.mockReset().mockResolvedValue({ avg: null });
  send.mockReset().mockResolvedValue({ messageId: 'm1' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── blank / "N/A" ───────────────────────────────────────────────────────────
describe('prepareMarketingReview — nothing was answered (blank, "N/A", "under NDA")', () => {
  it("resets the row with no links, then records 'no_portfolio' with score NULL and a minimal marketing review", async () => {
    const r = await prepareMarketingReview({ applicationId: ID, pick: NOT_ANSWERED });

    expect(query).toHaveBeenCalledTimes(1);
    expect(sqlOf(0)).toBe(RESET_SQL);
    expect(paramsOf(0)).toEqual(['[]', ID, STALE, true]);

    expect(applyPortfolioOutcome).toHaveBeenCalledTimes(1);
    const [id, outcome] = applyPortfolioOutcome.mock.calls[0];
    expect(id).toBe(ID);
    expect(outcome).toStrictEqual({
      status: 'no_portfolio', score: null, note: '', redFlags: [], message: MSG_NONE,
      analysis: analysisOf({ summary: 'No work samples were provided.' }),
    });
    // an unscored outcome never carries a one-liner (that would be appended to the candidate's summary)
    expect('oneLiner' in outcome).toBe(false);

    expect(r).toStrictEqual({ status: 'no_portfolio', links: [], queued: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('settles the outcome only AFTER the reset has claimed the row', async () => {
    await prepareMarketingReview({ applicationId: ID, pick: NOT_ANSWERED });
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(applyPortfolioOutcome.mock.invocationCallOrder[0]);
  });

  it('the stored review has no claim text and no unreviewed list to show', async () => {
    await prepareMarketingReview({ applicationId: ID, pick: NOT_ANSWERED });
    const analysis = applyPortfolioOutcome.mock.calls[0][1].analysis;
    expect('claimText' in analysis).toBe(false);
    expect('unreviewed' in analysis).toBe(false);
  });

  it('"answered: false" decides: stray links on a hand-built pick are ignored, nothing is stored or queued', async () => {
    const r = await prepareMarketingReview({
      applicationId: ID,
      pick: { answered: false, textOnly: false, claimText: '', links: [DRIVE_LINK], listedNotReviewed: [LINKEDIN] },
    });
    expect(paramsOf(0)[0]).toBe('[]');
    expect(applyPortfolioOutcome.mock.calls[0][1].message).toBe(MSG_NONE);
    expect('unreviewed' in applyPortfolioOutcome.mock.calls[0][1].analysis).toBe(false);
    expect(r).toStrictEqual({ status: 'no_portfolio', links: [], queued: false });
    expect(send).not.toHaveBeenCalled();
  });
});

// ─── words only ──────────────────────────────────────────────────────────────
describe('prepareMarketingReview — only a written description, no link', () => {
  it("records 'no_portfolio' with score NULL and keeps the candidate's own words in the review", async () => {
    const r = await prepareMarketingReview({ applicationId: ID, pick: TEXT_ONLY });

    expect(sqlOf(0)).toBe(RESET_SQL);
    expect(paramsOf(0)).toEqual(['[]', ID, STALE, true]);
    expect(applyPortfolioOutcome).toHaveBeenCalledTimes(1);
    expect(applyPortfolioOutcome.mock.calls[0][1]).toStrictEqual({
      status: 'no_portfolio', score: null, note: '', redFlags: [], message: MSG_TEXT_ONLY,
      analysis: analysisOf({
        summary: 'Only a written description was provided; there were no work samples to review.',
        claimText: TEXT_ONLY.claimText,
      }),
    });
    expect(r).toStrictEqual({ status: 'no_portfolio', links: [], queued: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('the message differs from the blank one — HR can tell "nothing" from "only words"', () => {
    expect(MSG_TEXT_ONLY).not.toBe(MSG_NONE);
  });

  it('textOnly wins over stray links on a hand-built pick: still nothing is queued', async () => {
    const r = await prepareMarketingReview({ applicationId: ID, pick: { ...TEXT_ONLY, links: [SITE_LINK] } });
    expect(paramsOf(0)[0]).toBe('[]');
    expect(r).toStrictEqual({ status: 'no_portfolio', links: [], queued: false });
    expect(send).not.toHaveBeenCalled();
  });
});

// ─── links that are never opened ─────────────────────────────────────────────
describe('prepareMarketingReview — every link is on a platform that is never opened (LinkedIn, social, file transfer)', () => {
  it("records 'unreviewable' with score NULL and lists each link with its reason, for HR to open by hand", async () => {
    const r = await prepareMarketingReview({ applicationId: ID, pick: UNOPENABLE });

    expect(sqlOf(0)).toBe(RESET_SQL);
    expect(paramsOf(0)).toEqual(['[]', ID, STALE, true]);       // nothing for the worker to open: no links stored
    expect(applyPortfolioOutcome).toHaveBeenCalledTimes(1);
    expect(applyPortfolioOutcome.mock.calls[0][1]).toStrictEqual({
      status: 'unreviewable', score: null, note: '', redFlags: [], message: MSG_UNOPENABLE,
      analysis: analysisOf({
        summary: 'Every link is on a platform that cannot be opened automatically. Open them by hand.',
        unreviewed: [LINKEDIN, FACEBOOK],
      }),
    });
    expect(r).toStrictEqual({ status: 'unreviewable', links: [], queued: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the order of the list and stores only url, platform and reason of each entry', async () => {
    const noisy = { ...UNOPENABLE, listedNotReviewed: [{ ...FACEBOOK, extra: 'x' }, LINKEDIN] } as AnswerLinkPick;
    await prepareMarketingReview({ applicationId: ID, pick: noisy });
    expect(applyPortfolioOutcome.mock.calls[0][1].analysis.unreviewed).toStrictEqual([FACEBOOK, LINKEDIN]);
  });

  it('does not alias the caller\'s list (a later change to the pick cannot rewrite the stored review)', async () => {
    await prepareMarketingReview({ applicationId: ID, pick: UNOPENABLE });
    const stored = applyPortfolioOutcome.mock.calls[0][1].analysis.unreviewed;
    expect(stored).not.toBe(UNOPENABLE.listedNotReviewed);
    expect(stored[0]).not.toBe(UNOPENABLE.listedNotReviewed[0]);
  });

  it('does not store the answer text (the candidate\'s words are not a claim here, the links are the finding)', async () => {
    await prepareMarketingReview({ applicationId: ID, pick: UNOPENABLE });
    expect('claimText' in applyPortfolioOutcome.mock.calls[0][1].analysis).toBe(false);
  });

  it('a hand-built pick with no link to open and nothing listed still never queues an empty job', async () => {
    const r = await prepareMarketingReview({
      applicationId: ID, pick: { answered: true, textOnly: false, claimText: 'x', links: [], listedNotReviewed: [] },
    });
    expect(r).toStrictEqual({ status: 'unreviewable', links: [], queued: false });
    expect(send).not.toHaveBeenCalled();
    expect('unreviewed' in applyPortfolioOutcome.mock.calls[0][1].analysis).toBe(false);
  });
});

// ─── links to open ───────────────────────────────────────────────────────────
describe('prepareMarketingReview — there is something to open', () => {
  it("stores the picked links as JSON, resets to 'pending', and queues the application id only", async () => {
    const r = await prepareMarketingReview({ applicationId: ID, pick: WITH_LINKS });

    expect(query).toHaveBeenCalledTimes(1);
    expect(sqlOf(0)).toBe(RESET_SQL);
    expect(paramsOf(0)).toEqual([JSON.stringify([DRIVE_LINK, SITE_LINK]), ID, STALE, false]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(PORTFOLIO_TOPIC, { applicationId: ID }, undefined);

    expect(r).toStrictEqual({ status: 'pending', links: [DRIVE_LINK, SITE_LINK], queued: true });
    expect(r.links).toBe(WITH_LINKS.links);
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();
  });

  it('what is stored is only the picked links, in order, each with the handler that will open it', async () => {
    await prepareMarketingReview({ applicationId: ID, pick: WITH_LINKS });
    const stored = JSON.parse(paramsOf(0)[0] as string) as PortfolioLink[];
    expect(stored).toEqual([DRIVE_LINK, SITE_LINK]);
    expect(stored.map(l => l.handler)).toEqual(['document', 'site']);
    // the not-opened list is rebuilt by the worker from the answer; it is not part of portfolio_urls
    expect(paramsOf(0)[0]).not.toContain('linkedin');
  });

  it('queues only AFTER the reset has claimed the row', async () => {
    await prepareMarketingReview({ applicationId: ID, pick: WITH_LINKS });
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
  });

  it('a review that already has a score is queued again like any other (the worker decides what to keep)', async () => {
    query.mockResolvedValue([{ id: ID, score_portfolio: 7 }]);
    const r = await prepareMarketingReview({ applicationId: ID, pick: WITH_LINKS });
    expect(r).toStrictEqual({ status: 'pending', links: [DRIVE_LINK, SITE_LINK], queued: true });
    expect(query).toHaveBeenCalledTimes(1);                     // no "failed" write
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();
  });

  it("a failed hand-off to the queue: still 'pending', queued false, and the visible note is written only while the row is pending", async () => {
    send.mockRejectedValue(new Error('queue down'));
    const r = await prepareMarketingReview({ applicationId: ID, pick: WITH_LINKS });

    expect(r).toStrictEqual({ status: 'pending', links: [DRIVE_LINK, SITE_LINK], queued: false });
    expect(query).toHaveBeenCalledTimes(2);                     // reset, then the note
    expect(sqlOf(1)).toBe(`UPDATE applications SET portfolio_analysis_error=$1 WHERE id=$2 AND portfolio_analysis_status='pending'`);
    expect(paramsOf(1)).toEqual(['Could not be queued (queue down). Use Re-run to retry.', ID]);
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();
  });

  it('a failure writing that note is swallowed — the caller still gets the pending/not-queued answer', async () => {
    send.mockRejectedValue(new Error('queue down'));
    query.mockResolvedValueOnce([{ id: ID, score_portfolio: null }]).mockRejectedValueOnce(new Error('db hiccup'));
    const r = await prepareMarketingReview({ applicationId: ID, pick: WITH_LINKS });
    expect(r).toStrictEqual({ status: 'pending', links: [DRIVE_LINK, SITE_LINK], queued: false });
  });

  it('a queue that never answers is abandoned after 8 seconds and treated like any other send failure', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    send.mockReturnValue(new Promise(() => {}));                // never settles
    const pending = prepareMarketingReview({ applicationId: ID, pick: WITH_LINKS });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(8000);
    const r = await pending;
    expect(r).toStrictEqual({ status: 'pending', links: [DRIVE_LINK, SITE_LINK], queued: false });
    expect(paramsOf(1)[0]).toBe('Could not be queued (queue did not respond within 8s). Use Re-run to retry.');
  });

  it('a database failure on the reset propagates and nothing is queued', async () => {
    query.mockRejectedValue(new Error('db down'));
    await expect(prepareMarketingReview({ applicationId: ID, pick: WITH_LINKS })).rejects.toThrow('db down');
    expect(send).not.toHaveBeenCalled();
  });
});

// ─── a live review holds the row ─────────────────────────────────────────────
describe("prepareMarketingReview — a review a live worker holds (the reset claims no row) is 'busy' and nothing changes", () => {
  const cases: Array<[string, AnswerLinkPick, PortfolioLink[]]> = [
    ['nothing answered',  NOT_ANSWERED, []],
    ['words only',        TEXT_ONLY,    []],
    ['unopenable links',  UNOPENABLE,   []],
    ['links to open',     WITH_LINKS,   [DRIVE_LINK, SITE_LINK]],
  ];
  for (const [name, pick, links] of cases) {
    it(name, async () => {
      query.mockResolvedValue([]);
      const r = await prepareMarketingReview({ applicationId: ID, pick });
      expect(r).toStrictEqual({ status: 'busy', links, queued: false });
      expect(query).toHaveBeenCalledTimes(1);                   // the reset attempt, no follow-up write
      expect(applyPortfolioOutcome).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });
  }

  it('the claim test is the designer\'s: not running, or running past the point a live worker could hold it', () => {
    expect(RESET_SQL).toContain(`portfolio_analysis_status IS DISTINCT FROM 'running'`);
    expect(RESET_SQL).toContain(`portfolio_started_at < NOW() - ($3 || ' seconds')::interval`);
    expect(Number(STALE)).toBe(STALE_RUNNING_SECONDS);
  });
});

// ─── a re-run that finds nothing to review ───────────────────────────────────
describe('prepareMarketingReview — a re-run that finds nothing to review keeps the earlier review', () => {
  const cases: Array<[string, AnswerLinkPick, string]> = [
    ['nothing answered', NOT_ANSWERED,
      'No work samples were found in the answer this time — the earlier review (7/10) still applies. Use Re-run to retry.'],
    ['words only', TEXT_ONLY,
      'Only a written description was found this time — the earlier review (7/10) still applies. Use Re-run to retry.'],
    ['unopenable links', UNOPENABLE,
      'The links could not be opened this time (their platforms cannot be opened automatically) — the earlier review (7/10) still applies. Use Re-run to retry.'],
  ];
  for (const [name, pick, message] of cases) {
    it(`${name}: no outcome is applied; the row is marked failed with a message that names the earlier score`, async () => {
      query.mockResolvedValue([{ id: ID, score_portfolio: 7 }]);
      const r = await prepareMarketingReview({ applicationId: ID, pick });

      expect(applyPortfolioOutcome).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(2);                   // reset, then the failed note
      expect(sqlOf(1)).toBe(MARK_FAILED_SQL);
      expect(paramsOf(1)).toEqual([message, ID]);
      expect(r).toStrictEqual({ status: 'failed', links: [], queued: false });
      expect(send).not.toHaveBeenCalled();
    });
  }

  // The links the earlier review was built from must survive a declined re-run. The decision is made by the reset
  // statement itself (one UPDATE, no read-then-write): a declined run tells it to keep portfolio_urls whenever the
  // row already holds a score, and a run that queues never does — the worker treats portfolio_urls as authoritative.
  describe('the links the earlier review was built from are not wiped', () => {
    for (const [name, pick] of [['nothing answered', NOT_ANSWERED], ['words only', TEXT_ONLY], ['unopenable links', UNOPENABLE]] as const) {
      it(`${name}: the reset keeps portfolio_urls for a row that has a score, and the run still ends 'failed' naming that score`, async () => {
        query.mockResolvedValue([{ id: ID, score_portfolio: 5 }]);
        const r = await prepareMarketingReview({ applicationId: ID, pick });

        // ONE statement decides: portfolio_urls is only replaced when there is no score or this run queues a job
        expect(sqlOf(0)).toContain('portfolio_urls=CASE WHEN $4::boolean AND score_portfolio IS NOT NULL THEN portfolio_urls ELSE $1::jsonb END');
        expect(paramsOf(0)[3]).toBe(true);                       // "this run settles without a job"
        // nothing else rewrites the column afterwards: the only other write is the failed note, which has no links in it
        expect(query).toHaveBeenCalledTimes(2);
        expect(sqlOf(1)).toBe(MARK_FAILED_SQL);
        expect(sqlOf(1)).not.toContain('portfolio_urls');
        expect(paramsOf(1)[0]).toMatch(/ — the earlier review \(5\/10\) still applies\. Use Re-run to retry\.$/);
        expect(r).toStrictEqual({ status: 'failed', links: [], queued: false });
        expect(applyPortfolioOutcome).not.toHaveBeenCalled();
      });
    }

    it('a declined run on a row WITHOUT a score still empties the links (nothing depends on them) and records the unscored outcome', async () => {
      query.mockResolvedValue([{ id: ID, score_portfolio: null }]);
      await prepareMarketingReview({ applicationId: ID, pick: NOT_ANSWERED });
      // same statement, same flag: it is the row's own score_portfolio that makes the CASE fall to '[]'
      expect(paramsOf(0)).toEqual(['[]', ID, STALE, true]);
      expect(applyPortfolioOutcome).toHaveBeenCalledTimes(1);
    });

    it('a run that queues a job replaces the links even for a row that has a score (the worker reads portfolio_urls)', async () => {
      query.mockResolvedValue([{ id: ID, score_portfolio: 5 }]);
      const r = await prepareMarketingReview({ applicationId: ID, pick: WITH_LINKS });
      expect(paramsOf(0)).toEqual([JSON.stringify([DRIVE_LINK, SITE_LINK]), ID, STALE, false]);   // $4 false: never keep the old ones
      expect(r).toStrictEqual({ status: 'pending', links: [DRIVE_LINK, SITE_LINK], queued: true });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('the claim guard is unchanged by it: a live worker still makes the run busy before anything is kept or replaced', async () => {
      query.mockResolvedValue([]);
      expect(await prepareMarketingReview({ applicationId: ID, pick: NOT_ANSWERED })).toStrictEqual({ status: 'busy', links: [], queued: false });
      expect(sqlOf(0)).toContain(`WHERE id=$2 AND (portfolio_analysis_status IS DISTINCT FROM 'running'`);
      expect(query).toHaveBeenCalledTimes(1);
    });
  });

  it('an earlier score of 0 is still an earlier review (0 is not "no score")', async () => {
    query.mockResolvedValue([{ id: ID, score_portfolio: 0 }]);
    const r = await prepareMarketingReview({ applicationId: ID, pick: NOT_ANSWERED });
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();
    expect(paramsOf(1)[0]).toContain('the earlier review (0/10) still applies');
    expect(r.status).toBe('failed');
  });

  for (const none of [null, undefined]) {
    it(`no earlier score (${String(none)}) means the normal unscored outcome is recorded`, async () => {
      query.mockResolvedValue([{ id: ID, score_portfolio: none }]);
      const r = await prepareMarketingReview({ applicationId: ID, pick: NOT_ANSWERED });
      expect(applyPortfolioOutcome).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(1);
      expect(r.status).toBe('no_portfolio');
    });
  }

  it('a failure writing the failed note is swallowed (markPortfolioFailed never throws)', async () => {
    query.mockResolvedValueOnce([{ id: ID, score_portfolio: 5 }]).mockRejectedValueOnce(new Error('db hiccup'));
    await expect(prepareMarketingReview({ applicationId: ID, pick: TEXT_ONLY })).resolves.toStrictEqual({ status: 'failed', links: [], queued: false });
  });
});

// ─── failures ────────────────────────────────────────────────────────────────
describe('prepareMarketingReview — failures', () => {
  it('a database failure on the reset propagates and no outcome is applied', async () => {
    query.mockRejectedValue(new Error('db down'));
    await expect(prepareMarketingReview({ applicationId: ID, pick: NOT_ANSWERED })).rejects.toThrow('db down');
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();
  });

  it("a failure applying the outcome marks the row failed with a Re-run hint (it would otherwise wait 'pending' forever) and still propagates", async () => {
    applyPortfolioOutcome.mockRejectedValue(new Error('Application not found'));
    await expect(prepareMarketingReview({ applicationId: ID, pick: TEXT_ONLY })).rejects.toThrow('Application not found');

    expect(query).toHaveBeenCalledTimes(2);
    expect(sqlOf(1)).toBe(MARK_FAILED_SQL);
    expect(paramsOf(1)).toEqual(['The review could not be recorded. Use Re-run to retry.', ID]);
  });

  it('the original error wins even if the failed note cannot be written either', async () => {
    applyPortfolioOutcome.mockRejectedValue(new Error('first problem'));
    query.mockResolvedValueOnce([{ id: ID, score_portfolio: null }]).mockRejectedValueOnce(new Error('second problem'));
    await expect(prepareMarketingReview({ applicationId: ID, pick: UNOPENABLE })).rejects.toThrow('first problem');
  });
});

// ─── minimalMarketingAnalysis ────────────────────────────────────────────────
describe('minimalMarketingAnalysis', () => {
  it('is a complete, valid marketing review with nothing in it but the summary', () => {
    expect(minimalMarketingAnalysis({ summary: 'S' })).toStrictEqual(analysisOf({ summary: 'S' }));
  });

  it('is dated now and says no model ran', () => {
    const a = minimalMarketingAnalysis({ summary: 'S' });
    expect(a.analyzedAt).toBe(NOW);
    expect(a.model).toBe('none');
    expect(a.kind).toBe('marketing_work');
    expect(a.version).toBe(1);
  });

  it('carries the claim text only when there is one', () => {
    expect(minimalMarketingAnalysis({ summary: 'S', claimText: 'my words' }).claimText).toBe('my words');
    for (const none of ['', undefined]) {
      expect('claimText' in minimalMarketingAnalysis({ summary: 'S', claimText: none })).toBe(false);
    }
  });

  it('carries the unreviewed list only when it has entries, copied entry by entry', () => {
    const list = [LINKEDIN];
    const a = minimalMarketingAnalysis({ summary: 'S', unreviewed: list });
    expect(a.unreviewed).toStrictEqual([LINKEDIN]);
    expect(a.unreviewed).not.toBe(list);
    for (const none of [[], undefined]) {
      expect('unreviewed' in minimalMarketingAnalysis({ summary: 'S', unreviewed: none })).toBe(false);
    }
  });

  it('does not change what it was given', () => {
    const list = [{ ...LINKEDIN }, { ...FACEBOOK }];
    const before = JSON.stringify(list);
    minimalMarketingAnalysis({ summary: 'S', claimText: 'c', unreviewed: list });
    expect(JSON.stringify(list)).toBe(before);
  });

  it('survives the jsonb-safe serialiser with nothing lost (what applyPortfolioOutcome stores)', () => {
    const a = minimalMarketingAnalysis({ summary: 'S', claimText: 'c', unreviewed: [LINKEDIN, FACEBOOK] });
    expect(JSON.parse(jsonbSafeStringify(a))).toEqual(a);
  });

  it('has no score of its own that anyone could mistake for a result: the placeholder is 0 and the score column is untouched', () => {
    const a = minimalMarketingAnalysis({ summary: 'S' });
    expect([a.score, a.modelScore, a.checklistScore]).toEqual([0, 0, 0]);
    expect(a.criteria).toEqual([]);
    expect(a.portfolios).toEqual([]);
  });
});

// ─── through the real link picker ────────────────────────────────────────────
describe('prepareMarketingReview — with picks made by the real answer-link picker', () => {
  const QUESTION = "Links to public resources/portfolio to highlight your past work? eg: brand campaigns/marketing intitiatives/ad designs etc that you've run";
  const pickFor = (answer: string) => pickAnswerLinks([{ question: QUESTION, answer }], { candidateName: 'Jane Doe' });

  it('"N/A" is not answered: no_portfolio, score NULL, nothing queued', async () => {
    const r = await prepareMarketingReview({ applicationId: ID, pick: pickFor('N/A') });
    expect(r).toStrictEqual({ status: 'no_portfolio', links: [], queued: false });
    expect(applyPortfolioOutcome.mock.calls[0][1].score).toBeNull();
    expect(applyPortfolioOutcome.mock.calls[0][1].message).toBe(MSG_NONE);
  });

  it('an application with no such question at all is not answered either', async () => {
    const pick = pickAnswerLinks([{ question: 'Why this role?', answer: 'https://jane.design' }], { candidateName: 'Jane Doe' });
    const r = await prepareMarketingReview({ applicationId: ID, pick });
    expect(r.status).toBe('no_portfolio');
    expect(applyPortfolioOutcome.mock.calls[0][1].message).toBe(MSG_NONE);
    expect(send).not.toHaveBeenCalled();
  });

  it('a description with no link is text only: no_portfolio with the words kept', async () => {
    const words = 'I led the rebrand of a water-purifier startup and grew its Instagram from two thousand to forty thousand followers.';
    const r = await prepareMarketingReview({ applicationId: ID, pick: pickFor(words) });
    expect(r).toStrictEqual({ status: 'no_portfolio', links: [], queued: false });
    expect(applyPortfolioOutcome.mock.calls[0][1].message).toBe(MSG_TEXT_ONLY);
    expect(applyPortfolioOutcome.mock.calls[0][1].analysis.claimText).toBe(words);
  });

  it('a LinkedIn profile alone is unreviewable and is listed with its reason', async () => {
    const r = await prepareMarketingReview({ applicationId: ID, pick: pickFor('https://www.linkedin.com/in/jane-doe') });
    expect(r).toStrictEqual({ status: 'unreviewable', links: [], queued: false });
    const unreviewed = applyPortfolioOutcome.mock.calls[0][1].analysis.unreviewed;
    expect(unreviewed).toHaveLength(1);
    expect(unreviewed[0]).toMatchObject({ url: 'https://www.linkedin.com/in/jane-doe', platform: 'linkedin' });
    expect(unreviewed[0].reason).toMatch(/^LinkedIn blocks automated viewing/);
    expect(send).not.toHaveBeenCalled();
  });

  it('a Drive PDF next to a LinkedIn profile is queued; only the Drive file is stored', async () => {
    const r = await prepareMarketingReview({
      applicationId: ID,
      pick: pickFor('Work: https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing and https://www.linkedin.com/in/jane-doe'),
    });
    expect(r.status).toBe('pending');
    expect(r.queued).toBe(true);
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({ platform: 'gdrive_file', handler: 'document' });
    expect(JSON.parse(paramsOf(0)[0] as string)).toEqual(r.links);
    expect(send).toHaveBeenCalledWith(PORTFOLIO_TOPIC, { applicationId: ID }, undefined);
    expect(applyPortfolioOutcome).not.toHaveBeenCalled();
  });

  it('a hostile answer (huge, junk, script schemes) settles without a job and without throwing', async () => {
    const junk = `javascript:alert(1) ${'a'.repeat(200_000)} data:text/html;base64,AAAA`;
    const r = await prepareMarketingReview({ applicationId: ID, pick: pickFor(junk) });
    expect(['no_portfolio', 'unreviewable']).toContain(r.status);
    expect(send).not.toHaveBeenCalled();
  });
});
