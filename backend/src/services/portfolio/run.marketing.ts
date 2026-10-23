// WORKER-ONLY (see browser.ts). The marketing work-sample review (roles whose review kind is 'marketing_work').
// run.ts has already claimed the job and loaded the application, candidate and role; it hands over here instead of
// running the designer flow.
//
// Flow: the links stored at enqueue are opened — short links and link-in-bio pages are expanded first, then websites go
// to Chromium and everything else is fetched anonymously, both at once and under ONE budget — and what came back is
// judged WITHOUT the model first. When no page or file was really opened there is no model call and, unlike the designer
// review, no score either: a dimension with no evidence is simply not applied (Aaron, 2026-10-22). That includes links
// that yielded only metadata — a video's title and thumbnails, an Instagram bio — which say nothing about the work
// itself. Only when something was really opened does one model call score it.
//
// The same holds AFTER the model call: the analyzer screens the items again (its own injection scan, media types, size
// limits) and can end up showing the model nothing at all — or nothing but metadata. That is not a score of 0, it is no
// score: a review is recorded as completed only when the model really ran and was shown at least one opened page or
// file (review findings 1.0, 2.0, 3.3, 5.0). And a model that was shown work but could assess NONE of what the work can show
// (every direct and quality criterion marked not assessable: unreadable material, a language it cannot judge) did not review
// anything either: that settles as 'unreviewable', never as a score made of half the model's number (second review F5).
import type { Application, Candidate, Role } from '../../types/index.js';
import { pickAnswerLinks } from './answerLinks.js';
import type { AnswerLinkPick } from './answerLinks.js';
import { analyzeMarketing, reviewedFromAcquired } from './analyze.marketing.js';
import { BUDGET, BudgetTracker } from './acquire/budget.js';
import { defaultFetchers } from './acquire/fetchers.js';
import { acquireFetchItems, expandResolveItems, fromCaptured } from './acquire/index.js';
import type { FetchItem } from './acquire/index.js';
import { INJECTION_REASON, StepTimeoutError, cleanText, reserveText, scanDocumentText, within } from './acquire/pdf.js';
import type { Acquired, AcquireContext, AcquireOutcome } from './acquire/types.js';
import { BROWSER_CLOSE_MS, BrowserBusyError, withBrowser } from './browser.js';
import { MARKETING_CAPTURE_OPTS, browserOptionsFor, capturePortfolios } from './capture.js';
import type { CapturedPortfolio } from './capture.js';
import { minimalMarketingAnalysis } from './enqueue.js';
import type { ReviewProfile } from './profiles.js';
import { BUSY_WAIT_MS, TOTAL_BUDGET_MS } from './jobState.js';
import { assessChecklist } from './rubric.marketing.js';
import type { RunResult } from './run.js';
import { applyPortfolioOutcome } from './scoring.js';
import type { PortfolioAnalysisResult, PortfolioLink, PortfolioReviewed } from './types.js';

export interface MarketingRunContext {
  applicationId: string;
  app:           Application;
  candidate:     Candidate;
  role:          Role;
  profile:       ReviewProfile;
  startedAt:     number;
  /** The queue's delivery count (1-based). Only settleFailure acts on it. */
  attempt:       number;
  /** run.ts's failure handling: on an early attempt a transient error hands the job back and throws; otherwise it is recorded as 'failed'. */
  settleFailure: (err: unknown, prefix: string) => Promise<RunResult>;
  /** Puts the claimed job back to 'pending' without recording a failure. */
  release:       () => Promise<void>;
}

// The same wording the analyzer puts on its own flag for an item its injection pre-scan excluded.
const INJECTION_FLAG = 'Link text aimed at AI reviewers';
const PRIVATE_MESSAGE = 'The links are private or no longer exist - ask the candidate to re-share them';
const NO_WORK_MESSAGE = 'The links did not contain marketing work that could be assessed';
// The model was shown work but could assess none of what the work can show (see assessChecklist).
const UNASSESSABLE_MESSAGE = 'The material could not be assessed (unreadable, or in a language the review cannot judge)';
const UNASSESSABLE_NOW = 'The material could not be assessed this time (unreadable, or in a language the review cannot judge)';
const UNASSESSABLE_SUMMARY = 'The linked work was opened, but none of the criteria it can show could be assessed (unreadable, or in a language the review cannot judge), so nothing was scored.';
// Said of each link the model was shown in that case (the card's "Not reviewed" line reads it).
const UNASSESSABLE_LINK_REASON = 'Opened, but none of the criteria it can show could be assessed (unreadable, or in a language the review cannot judge)';

// Shown for a link that carries no reason of its own.
const DEFAULT_REASON: Record<AcquireOutcome, string> = {
  inaccessible: 'The link is private or no longer exists',
  failed:       'The link could not be opened because of a problem on our side',
  unreviewable: 'Not opened automatically',
  ok:           'Nothing readable was found',
  partial:      'Nothing readable was found',
};

// A reason line is at most 240 characters, so even with the lead-in and the closing "— the earlier review (N/10) still
// applies. Use Re-run to retry." the message stays well inside the 500 characters run.ts keeps.
const MAX_REASONS = 3;
const MAX_REASON_TEXT = 240;

/**
 * How long past its own deadline the website capture may take to hand back what it has: the capture stops at the acquisition deadline, and
 * the browser then gets BROWSER_CLOSE_MS to close before withBrowser kills it, so this is that plus a margin. Past it the capture is given up on
 * (see the wait on `capturing`): a stuck browser must end a review the way any failure on OUR side does, not hold the invocation to the
 * platform's 300 s kill with the row stuck on 'running'. Also the least a capture that is already running is given when the clock says its
 * deadline has passed.
 */
export const CAPTURE_GRACE_MS = BROWSER_CLOSE_MS + 5_000;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * A link that failed on OUR side (timeout, rate limit, a dropped connection, a corrupt download) is retryable by
 * definition and never held against the candidate. 503 is what run.ts's isTransient() reads as "retry", so on an early
 * attempt the job goes back to the queue instead of being recorded as failed straight away.
 */
const ourSideFailure = (message: string): Error => Object.assign(new Error(message), { status: 503 });

/** An item nothing was read from. 'artifact' because no metadata-only claim is being made either. */
function unread(ref: string, link: PortfolioLink, outcome: AcquireOutcome, reason: string, injectionHit = false): Acquired {
  return { ref, link, outcome, reason, basis: 'artifact', media: [], text: '', facts: [], injectionHit };
}

/** Read AND worth showing the model: opened, not excluded as an injection attempt, and carrying words or pictures. */
const isUsable = (a: Acquired): boolean =>
  (a.outcome === 'ok' || a.outcome === 'partial') && !a.injectionHit && (a.text.trim().length > 0 || a.media.length > 0);

/**
 * A failure worth retrying: one that could have yielded something to score. A video or social link only ever yields
 * metadata (titles, a bio), which is never scored, so losing one to a hiccup of ours costs the review nothing — retrying
 * it would only burn queue attempts and end in a red "failed" where the healthy outcome is a neutral "not scored".
 */
const couldHaveBeenScored = (a: Acquired): boolean =>
  a.outcome === 'failed' && a.link?.handler !== 'video' && a.link?.handler !== 'social';

/**
 * The refs the model was really shown. The analyzer records a coverage ONLY for those (a link it never sent, whatever the
 * reason, has none), so this is the one place that says what the model had in front of it.
 */
function shownRefsOf(analysis: PortfolioAnalysisResult): Set<string> {
  const shown = new Set<string>();
  for (const p of Array.isArray(analysis?.portfolios) ? analysis.portfolios : []) {
    if (p && p.coverage != null && typeof p.ref === 'string') shown.add(p.ref);
  }
  return shown;
}

/** 'L2' -> [2, 0], 'L2.1' -> [2, 1]: a link's position, then its place among the links a short link / link-in-bio page expanded into. */
function refOrder(ref: string): [number, number] {
  const m = /^L(\d+)(?:\.(\d+))?$/.exec(ref);
  return m ? [Number(m[1]), m[2] ? Number(m[2]) : 0] : [Number.MAX_SAFE_INTEGER, 0];
}
const byRef = (a: Acquired, b: Acquired): number => {
  const [a1, a2] = refOrder(a.ref);
  const [b1, b2] = refOrder(b.ref);
  return a1 - b1 || a2 - b2;
};

/** Up to three distinct reasons, in the order the links appear, as one line for HR. */
function reasonLine(items: Acquired[]): string {
  const seen = new Set<string>();
  for (const a of items) {
    const reason = (a.reason?.trim() || DEFAULT_REASON[a.outcome]).replace(/[.\s]+$/, '');
    if (reason) seen.add(reason);
  }
  return clip([...seen].slice(0, MAX_REASONS).join('; '), MAX_REASON_TEXT);
}

/**
 * A website capture, made fit for the model: scanned for wording aimed at an AI reviewer (a hit keeps the whole item out
 * of the model call and sends it to a human), cleaned of invisible characters, and held to what is left of the review's
 * text and image budgets (which the fetchers, running at the same time, draw on too).
 */
function admitCapture(a: Acquired, ctx: AcquireContext): Acquired {
  if (a.outcome !== 'ok' && a.outcome !== 'partial') return a;
  // The scan reads the raw text: cleanText() would remove the invisible characters a smuggled instruction hides in.
  if (scanDocumentText(a.text)) return unread(a.ref, a.link, 'unreviewable', INJECTION_REASON, true);

  const text = reserveText(cleanText(a.text), ctx);
  const images = ctx.budget.reserveImages(a.media.length);
  const media = a.media.slice(0, images);
  if (!text.text && media.length === 0) {
    return unread(a.ref, a.link, 'unreviewable', 'The size limit for this review was reached before this site could be read');
  }

  const cut: string[] = [];
  if (text.truncated) cut.push('Text shortened to stay within the size limit for this review');
  if (images < a.media.length) cut.push(`Screenshots limited to ${images} of ${a.media.length} to stay within the size limit for this review`);
  if (!cut.length) return { ...a, text: text.text, media };
  const note = cut.join('. ');
  return { ...a, text: text.text, media, outcome: 'partial', reason: a.reason ? `${a.reason}. ${note}` : note, facts: [...a.facts, ...cut] };
}

/**
 * Text on a PAGE or in a DOCUMENT that is aimed at an AI reviewer: the only hit that is flagged to HR as an attempt. A hit in a video's
 * description or an Instagram bio (basis 'metadata') is third-party text we merely passed along — the uploader is not necessarily the
 * candidate, and promotional copy can read like an instruction — so that item is routed to a human with its reason and NO accusation,
 * exactly as the analyzer does for the items it withholds itself (a hit in a web address or label is never flagged either).
 */
const isTextInjectionHit = (x: Acquired): boolean => x.injectionHit === true && x.basis !== 'metadata';

/** The review as stored when no model ran: what code knows about every link, and the links that were never opened. */
function unscoredAnalysis(a: {
  acquired: Acquired[]; listedNotReviewed: AnswerLinkPick['listedNotReviewed']; claimText: string; summary: string;
}): PortfolioAnalysisResult {
  return {
    ...minimalMarketingAnalysis({ summary: a.summary, claimText: a.claimText, unreviewed: a.listedNotReviewed }),
    portfolios: a.acquired.map(x => reviewedFromAcquired(x)),
    redFlags: a.acquired.some(isTextInjectionHit) ? [INJECTION_FLAG] : [],
  };
}

/** `items` carrying the reason the analyzer recorded for each (a link it withheld is "opened" here and "not reviewed" there). */
function withAnalyzerReasons(items: Acquired[], analysis: PortfolioAnalysisResult): Acquired[] {
  const records = new Map((Array.isArray(analysis?.portfolios) ? analysis.portfolios : []).map(p => [p.ref, p] as const));
  return items.map(a => {
    const rec = records.get(a.ref);
    const reason = rec?.reason || rec?.accessNote;
    return reason ? { ...a, reason } : a;
  });
}

/**
 * What the MODEL wrote about a link (the analyzer copies it into the record of each link it was shown): how relevant it was, whose work
 * it looked like, how many campaigns it showed, a one-line summary, and how much of it the model says it saw. A review that is not
 * scored carries none of it — the card would otherwise list the link under "Links looked at" as "Reviewed", "credited to the
 * candidate, 5 campaigns seen", beneath a "Not scored" header (third review, G13). What is left is what code measured: outcome, reason,
 * basis, handler, facts, the access notes and the flag for text aimed at a reviewer. (`isPortfolio` and `belongsToCandidate` are
 * derived from that judgement and go back to their neutral values.) The card counts a link as read only when it has a coverage.
 */
const MODEL_LINK_FIELDS = ['relevance', 'attribution', 'campaignsSeen', 'summary', 'coverage'] as const;

export function withoutModelJudgement(records: readonly PortfolioReviewed[], shownReason?: string): PortfolioReviewed[] {
  return records.map(rec => {
    const out: PortfolioReviewed = { ...rec, isPortfolio: true, belongsToCandidate: null };
    for (const field of MODEL_LINK_FIELDS) delete out[field];
    // A link the model was shown (it had a coverage) and that has no reason of its own: say what happened to it in code's words.
    if (shownReason && rec.coverage != null && !rec.reason) { out.reason = shownReason; out.accessNote = shownReason; }
    return out;
  });
}

/**
 * A review the model rated "not marketing work" is stored with the model's own record (its rating is the reason it was not scored, and its
 * one-line summary says what the page was), minus the two per-link claims that contradict that rating: whose work it was and how many
 * campaigns it showed. Otherwise the card reads "profile page, not a work sample" beside "credited to the candidate, 5 campaigns seen".
 */
function withoutWorkClaims(analysis: PortfolioAnalysisResult): PortfolioAnalysisResult {
  return {
    ...analysis,
    portfolios: (Array.isArray(analysis.portfolios) ? analysis.portfolios : []).map(rec => {
      const out: PortfolioReviewed = { ...rec, belongsToCandidate: null };
      delete out.attribution;
      delete out.campaignsSeen;
      return out;
    }),
  };
}

/**
 * The review stored when the analyzer's answer cannot stand as a review (it was left with nothing it could judge, or the model
 * could assess none of it): what code knows about every link — as the analyzer recorded them where it did (an item its own scan
 * withheld is 'unreviewable' there, not 'ok' as it was opened here), without anything the model said about them
 * (withoutModelJudgement) — and the red flags that are OURS (text aimed at the reviewer), but no model verdicts and no score
 * (model 'none', score 0 mean "not scored"). The model's own red flags, highlights and campaigns are not carried over: they would be
 * a judgement of material it only saw as titles, could not read, or did not see at all. `extra` adds fields that are kept for audit
 * (the criteria with their not-assessable flags, the audit notes); `shownReason` is said of each link the model was shown.
 */
export function discardedAnalysis(
  analysis: PortfolioAnalysisResult,
  a: { acquired: Acquired[]; listedNotReviewed: AnswerLinkPick['listedNotReviewed']; claimText: string },
  summary: string,
  extra: Partial<PortfolioAnalysisResult> = {},
  shownReason?: string,
): PortfolioAnalysisResult {
  const base = unscoredAnalysis({ ...a, summary });
  const records = Array.isArray(analysis.portfolios) ? analysis.portfolios : [];
  const aimedAtReviewer = (Array.isArray(analysis.redFlags) ? analysis.redFlags : []).filter(f => typeof f === 'string' && /aimed at AI reviewers/i.test(f));
  return {
    ...base,
    portfolios: records.length ? withoutModelJudgement(records, shownReason) : base.portfolios,
    redFlags: [...new Set([...base.redFlags, ...aimedAtReviewer])],
    // The model call, if one was made, was paid for whatever came of it.
    ...(analysis.usage ? { usage: analysis.usage } : {}),
    ...extra,
  };
}

/**
 * Settles a review that has no score to give: the dimension is not applied (status + message, average untouched). BUT if
 * the application already carries a score from an earlier review, that review is not overwritten: this run is recorded
 * as 'failed' with a message saying the earlier score still applies, which is what the card shows
 * ("still includes the earlier review"). Never matches a retry pattern, so it settles on the spot.
 */
async function settleNotScored(
  ctx: MarketingRunContext,
  n: { status: 'inaccessible' | 'unreviewable' | 'no_portfolio'; message: string; now: string; analysis: PortfolioAnalysisResult },
): Promise<RunResult> {
  const earlier = ctx.app.score_portfolio;
  if (earlier != null) {
    return await ctx.settleFailure(new Error(`the earlier review (${earlier}/10) still applies`), n.now);
  }
  await applyPortfolioOutcome(
    ctx.applicationId,
    { status: n.status, score: null, note: '', redFlags: [], message: n.message, analysis: n.analysis },
    { foldPolicy: ctx.profile.foldPolicy },
  );
  return { ran: true, status: n.status };
}

export async function runMarketingReview(ctx: MarketingRunContext): Promise<RunResult> {
  const { applicationId, app, candidate, role, profile } = ctx;

  const stored = (app.portfolio_urls ?? []) as PortfolioLink[];
  if (!stored.length) {
    return await ctx.settleFailure(new Error('No work-sample links stored for this application'), 'Work-sample review could not start');
  }

  // The stored links are authoritative; the answer is read again only for the candidate's own words and for the
  // links that were never going to be opened (a LinkedIn profile, a link cut by a cap).
  const answer = pickAnswerLinks(app.screening_answers, { candidateName: candidate.full_name });
  const storedUrls = new Set(stored.map(l => l.url));
  const listedNotReviewed = answer.listedNotReviewed.filter(l => !storedUrls.has(l.url));
  const claimText = answer.claimText;

  // Refs by position, before anything is opened, so a link keeps its name whatever happens to the others.
  const storedItems = stored.map((link, i): FetchItem => ({ link, ref: `L${i + 1}` }));

  const acquireCtx: AcquireContext = {
    deadline: ctx.startedAt + BUDGET.acquireMs,
    budget: new BudgetTracker(),
    candidateName: candidate.full_name,
  };

  // A short link or link-in-bio page can lead to a website, and websites are Chromium's. So those are expanded FIRST, and
  // only then are the links split into websites and everything else: each expansion takes its original's place in
  // order (L3 -> L3.1, L3.2), and one that could not be expanded is already an item with its reason.
  const { items, settled } = await expandResolveItems(storedItems, acquireCtx, defaultFetchers);

  // The caps apply to what the review really has to open, i.e. AFTER expansion: each short link or link-in-bio page stands for the
  // links it leads to, and the resolver keeps at most the first 4 of them (a Linktree that lists six yields four items here; the
  // other two are not followed). Whatever is over a cap is listed as not opened, never dropped.
  const siteItems: FetchItem[] = [];
  const fetchItems: FetchItem[] = [];
  const notOpened: Acquired[] = [];
  for (const item of items) {
    if (siteItems.length + fetchItems.length >= BUDGET.maxItems) {
      notOpened.push(unread(item.ref, item.link, 'unreviewable', `Only the first ${BUDGET.maxItems} links are opened`));
    } else if (item.link.handler !== 'site') {
      fetchItems.push(item);
    } else if (siteItems.length < BUDGET.maxSites) {
      siteItems.push(item);
    } else {
      notOpened.push(unread(item.ref, item.link, 'unreviewable', `Only the first ${BUDGET.maxSites} websites are opened`));
    }
  }

  // Websites go to Chromium and everything else is fetched, at the same time. Chromium is only taken when there is a
  // website to open, so a review of documents and videos can never be bounced for want of a browser.
  const capturing: Promise<CapturedPortfolio[]> = siteItems.length
    ? withBrowser(
      b => capturePortfolios(b, siteItems.map(i => i.link), acquireCtx.deadline, MARKETING_CAPTURE_OPTS),
      { maxWaitMs: BUSY_WAIT_MS, ...browserOptionsFor(MARKETING_CAPTURE_OPTS) },
    )
    : Promise.resolve([]);
  const fetching: Promise<Acquired[]> = fetchItems.length
    ? acquireFetchItems(fetchItems, acquireCtx, defaultFetchers)
    : Promise.resolve([]);
  // If the browser cannot be had we stop right here without waiting for the fetches (their results are of no use to
  // a job that is handed back), so nobody may be left holding a rejection that would crash the process.
  fetching.catch(() => {});

  let captures: CapturedPortfolio[];
  try {
    // Bounded: withBrowser races the browser's close against BROWSER_CLOSE_MS and kills it, so this is only the last line (a capture that
    // never returns at all). The abandoned capture is left to finish or die by itself; nobody awaits it, and a rejection of it is handled
    // because the wait below is a race on it.
    captures = await within(capturing, Math.max(CAPTURE_GRACE_MS, acquireCtx.deadline + CAPTURE_GRACE_MS - Date.now()));
  } catch (err) {
    if (err instanceof BrowserBusyError) {
      // Lost a race for the browser after claiming. Not a failure and not an attempt used: put the job back so the
      // caller can re-queue it.
      await ctx.release();
      return { ran: false, status: 'busy', reason: 'browser in use by another review on this instance' };
    }
    if (err instanceof StepTimeoutError) {
      // The browser did not hand back its capture in time. OUR side, like any other browser failure: retried on an early attempt,
      // recorded as failed with the Re-run hint on the last. Not a verdict on the candidate's sites, so never a "not scored".
      return await ctx.settleFailure(ourSideFailure('the browser did not respond in time'), 'Website capture did not finish');
    }
    return await ctx.settleFailure(err, 'Could not start the browser');
  }
  const fetched = await fetching;

  const captured = siteItems.map((item, i) => admitCapture(fromCaptured(captures[i], item.ref), acquireCtx));
  const acquired = [...fetched, ...captured, ...notOpened, ...settled].sort(byRef);

  // Only a page or file that was really opened can be judged. Metadata alone (basis 'metadata') is context for the model
  // when there is real work to judge, but on its own it is listed for HR and never scored.
  const artifacts = acquired.filter(a => isUsable(a) && a.basis === 'artifact');
  const notJudged = acquired.filter(a => !artifacts.includes(a));
  const retryable = acquired.filter(couldHaveBeenScored);

  // ── Nothing was really opened: decided without the model ──────────────────────────────────────────
  if (!artifacts.length) {
    // Something broke on our side that could have been the real work, so "nothing to review" would be a guess about the
    // candidate: try again, never score. (A video or social link that broke is not that: it could never have been scored.)
    if (retryable.length) {
      return await ctx.settleFailure(
        ourSideFailure(`${retryable.length} link(s) could not be opened (${reasonLine(retryable.slice(0, 1))})`),
        'Work-sample capture failed',
      );
    }
    if (acquired.every(a => a.outcome === 'inaccessible')) {
      return await settleNotScored(ctx, {
        status: 'inaccessible', message: PRIVATE_MESSAGE,
        now: 'The links could not be opened this time (they are private or no longer exist)',
        analysis: unscoredAnalysis({ acquired, listedNotReviewed, claimText, summary: 'The linked work is private or no longer exists.' }),
      });
    }
    const why = reasonLine(notJudged);
    const onlyMetadata = acquired.some(isUsable);
    return await settleNotScored(ctx, {
      status: 'unreviewable', message: why,
      now: `The links could not be opened this time (${why})`,
      analysis: unscoredAnalysis({
        acquired, listedNotReviewed, claimText,
        summary: onlyMetadata
          ? 'Only titles, descriptions or bios could be read (videos and social posts are not opened), which says nothing about the work itself, so nothing was scored.'
          : 'The linked work could not be opened by an automated review.',
      }),
    });
  }

  // ── Something was really opened: one model call ───────────────────────────────────────────────
  let analysis: PortfolioAnalysisResult;
  try {
    analysis = await analyzeMarketing({
      candidate, role, acquired, listedNotReviewed, claimText, deadline: ctx.startedAt + TOTAL_BUDGET_MS,
    });
  } catch (err) {
    return await ctx.settleFailure(err, 'Analysis failed');
  }

  // ── What the model was really shown ────────────────────────────────────────────────────────────
  // The analyzer screens the items a second time and may send the model less than was opened here (or nothing: a scanned
  // PDF the API refused leaves no text and no pictures, an item whose text hides an instruction is withheld whole). A
  // run that "completed" over that would score a candidate 0 for work nobody looked at. So everything below is decided
  // over the links the analyzer says it SHOWED, never over what was merely opened.
  const shown = shownRefsOf(analysis);
  const shownArtifacts = artifacts.filter(a => shown.has(a.ref));
  const modelRan = typeof analysis.model === 'string' && analysis.model !== '' && analysis.model !== 'none';

  if (!modelRan || shownArtifacts.length === 0) {
    // Same rule as above: something broke on our side that could have been the real work, so try again before concluding.
    if (retryable.length) {
      return await ctx.settleFailure(
        ourSideFailure(`${retryable.length} link(s) could not be opened (${reasonLine(retryable.slice(0, 1))}) and the rest could not be read`),
        'Inconclusive review',
      );
    }
    // Say what really happened to the files that were opened: text aimed at a reviewer, a scan with no text, only personal details,
    // pages the API refused ... (the analyzer records each link's own reason; "could not be read automatically" would be a guess).
    const why = reasonLine(withAnalyzerReasons(artifacts, analysis));
    return await settleNotScored(ctx, {
      status: 'unreviewable', message: why,
      now: `The linked files could not be reviewed this time (${why})`,
      analysis: discardedAnalysis(analysis, { acquired, listedNotReviewed, claimText }, `Nothing could be reviewed (${why}), so nothing was scored.`),
    });
  }

  // Scored only if a page or file the model was shown is marketing work. One the model recognised as not work (a company
  // homepage with nothing of the candidate's, a profile page) does not count; one it did not classify gets the benefit
  // of the doubt, as does an employer or client brand page with no personal credit (attribution is judged separately).
  const relevanceOf = new Map(analysis.portfolios.map(p => [p.ref, p.relevance] as const));
  const sawWork = shownArtifacts.some(a => {
    const relevance = relevanceOf.get(a.ref);
    return relevance !== 'irrelevant' && relevance !== 'profile_only';
  });
  if (!sawWork) {
    // A link that failed on our side may have been the real work: that is not "no marketing work", try again.
    if (retryable.length) {
      return await ctx.settleFailure(
        ourSideFailure(`${retryable.length} link(s) could not be opened (${reasonLine(retryable.slice(0, 1))}) and the rest were not marketing work`),
        'Inconclusive review',
      );
    }
    return await settleNotScored(ctx, {
      status: 'no_portfolio', message: NO_WORK_MESSAGE,
      now: 'The links did not contain marketing work that could be assessed this time',
      analysis: withoutWorkClaims(analysis),
    });
  }

  // The model was shown work, but could assess NOTHING the work can show (every direct and quality criterion not assessable, or none
  // returned): there is no review, and the analyzer's score for it (0) means nothing. Not scored, never half the model's number.
  // (Some assessable but under 40% is different: the analyzer already used the model's own score alone, with low confidence.)
  if (assessChecklist(analysis.criteria).mode === 'none') {
    if (retryable.length) {
      return await ctx.settleFailure(
        ourSideFailure(`${retryable.length} link(s) could not be opened (${reasonLine(retryable.slice(0, 1))}) and the rest could not be assessed`),
        'Inconclusive review',
      );
    }
    return await settleNotScored(ctx, {
      status: 'unreviewable', message: UNASSESSABLE_MESSAGE, now: UNASSESSABLE_NOW,
      analysis: discardedAnalysis(analysis, { acquired, listedNotReviewed, claimText }, UNASSESSABLE_SUMMARY, {
        criteria: Array.isArray(analysis.criteria) ? analysis.criteria : [],
        scoreNote: 'Not assessable', confidence: 'low',
        ...(Array.isArray(analysis.evidenceNotes) && analysis.evidenceNotes.length ? { evidenceNotes: analysis.evidenceNotes } : {}),
      }, UNASSESSABLE_LINK_REASON),
    });
  }

  // The last line of defence, over everything above: a completed review needs a real, whole-number score from a model
  // that really ran over at least one opened page or file. (Every path that cannot say so has already settled.)
  if (!Number.isInteger(analysis.score) || analysis.score < 0 || analysis.score > 10) {
    return await ctx.settleFailure(new Error('the review produced a score that is not a whole number from 0 to 10'), 'Analysis failed');
  }

  // Links that were opened but are not part of what was judged — never opened, refused, metadata only, or withheld by the
  // analyzer — with the analyzer's own reason where it has one (a withheld item is "opened" here but not there).
  const notReviewed = acquired
    .filter(a => !(artifacts.includes(a) && shown.has(a.ref)))
    .map(a => (shown.has(a.ref) || !isUsable(a) ? a : withAnalyzerReasons([a], analysis)[0]));

  await applyPortfolioOutcome(
    applicationId,
    {
      status: 'completed', score: analysis.score, note: analysis.scoreNote,
      oneLiner: analysis.summary, redFlags: analysis.redFlags, analysis,
      message: notReviewed.length ? `${notReviewed.length} of ${acquired.length} links could not be reviewed (${reasonLine(notReviewed)}).` : undefined,
    },
    { foldPolicy: profile.foldPolicy },
  );
  return { ran: true, status: 'completed' };
}
