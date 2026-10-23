// WORKER-ONLY (see ../browser.ts). Runs the fetch-only link handlers (document, image, video, social, resolve) of a
// marketing work-sample review under hard time budgets and turns whatever happens to each link into one Acquired.
// It never throws: a link that errors, times out or never got a turn is an OUTCOME ('failed' = our side, never held
// against the candidate). The Chromium site capture is a separate path; fromCaptured() adapts its result to the same shape.
// Short links and link-in-bio pages can lead to a website, and websites are Chromium's, not this module's: so the caller
// runs expandResolveItems() FIRST, then splits what comes back into sites (Chromium) and the rest (acquireFetchItems).
import type { CapturedPortfolio } from '../capture.js';
import { wellFormed } from '../text.js';
import type { PortfolioLink, ReviewHandler } from '../types.js';
import { BUDGET } from './budget.js';
import { isTimeoutError } from './fetchCapped.js';
import type { Acquired, AcquireContext, AcquireOutcome, MediaBlock } from './types.js';

export interface FetchItem { link: PortfolioLink; ref: string }
export type Fetcher = (item: FetchItem, ctx: AcquireContext) => Promise<Acquired>;
/** Expands a short link or link-in-bio page into the work links behind it (already re-classified, so each has its handler). */
export type Resolver = (item: FetchItem, ctx: AcquireContext) => Promise<{ links: PortfolioLink[]; reason?: string }>;
// 'resolve' maps to a Resolver, not a Fetcher, and 'none' is never opened — so neither is a Fetcher key.
export type FetcherMap = Partial<Record<Exclude<ReviewHandler, 'resolve' | 'none'>, Fetcher>> & { resolve?: Resolver };

const MAX_RESOLVED_LINKS = 4;
const REASON_RAN_OUT = 'Ran out of time before this link could be opened';
const REASON_TIMEOUT = 'Could not be fetched (timeout)';
const REASON_NOT_OPENED_KIND = 'This kind of link is not opened automatically';
const REASON_NONE = 'Not opened automatically';
const REASON_NESTED = 'This is a nested short link, so it was not followed';
// A website behind a short link, reached through acquireFetchItems: Chromium opens websites and this module never does. The
// run layer avoids this by calling expandResolveItems first (see there); this is what a caller that did not is told.
const REASON_SITE_BEHIND_SHORT_LINK = 'A website behind a short link was not opened here';
const REASON_NO_LINKS = 'No work links were found behind this link';

const OUTCOMES: ReadonlySet<string> = new Set<AcquireOutcome>(['ok', 'partial', 'inaccessible', 'failed', 'unreviewable']);

/** An Acquired for a link nothing was read from. 'artifact' because no metadata-only claim is being made either. */
function unread(item: FetchItem, outcome: AcquireOutcome, reason: string): Acquired {
  return { ref: item.ref, link: item.link, outcome, reason, basis: 'artifact', media: [], text: '', facts: [], injectionHit: false };
}

/** A reason for HR (and, via the not-reviewed list, the prompt) from an arbitrary thrown value: never raw attacker text. */
function failureReason(e: unknown): string {
  if (isTimeoutError(e)) return REASON_TIMEOUT;
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  let detail = '';
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)) detail = code;
  else {
    // A parser can echo document text in its error message, so keep it short and free of anything that looks like markup.
    let raw = '';
    try { raw = e instanceof Error ? e.message : String(e); } catch { /* an unprintable value */ }
    detail = wellFormed(raw.replace(/[\u0000-\u001f\u007f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80));
  }
  return `Could not be fetched (${detail || 'unknown error'})`;
}

/** A fetcher's answer, made safe for the analyzer: our ref wins, missing collections become empty, junk becomes 'failed'. */
function normalized(item: FetchItem, r: unknown): Acquired {
  if (typeof r !== 'object' || r === null || !OUTCOMES.has((r as Acquired).outcome)) {
    return unread(item, 'failed', 'Could not be fetched (unexpected result)');
  }
  const a = r as Acquired;
  return {
    ...a,
    ref: item.ref,
    link: a.link ?? item.link,
    basis: a.basis === 'metadata' ? 'metadata' : 'artifact',
    media: Array.isArray(a.media) ? a.media : [],
    text: typeof a.text === 'string' ? a.text : '',
    facts: Array.isArray(a.facts) ? a.facts : [],
    injectionHit: a.injectionHit === true,
  };
}

/** At most `max` callers hold a slot at once; a freed slot passes straight to the longest waiter. */
function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    acquire: (): Promise<void> => {
      if (active < max) { active++; return Promise.resolve(); }
      return new Promise<void>(resolve => waiting.push(resolve));
    },
    release: (): void => {
      const next = waiting.shift();
      if (next) next();
      else active--;
    },
  };
}

type Boxed<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Runs `fn` with a deadline of min(perItemMs, what is left of the phase). Past the phase deadline it does not start at all.
 * The work itself cannot be cancelled from here, only abandoned, so `fn` is handed a context whose own deadline
 * is that same cut-off (fetchCapped has its own timeout for the network part). Never rejects.
 */
async function timeBoxed<T>(fn: (ctx: AcquireContext) => Promise<T>, ctx: AcquireContext, phaseDeadline: number): Promise<Boxed<T>> {
  const now = Date.now();
  if (now >= phaseDeadline) return { ok: false, reason: REASON_RAN_OUT };
  const itemDeadline = Math.min(now + BUDGET.perItemMs, phaseDeadline);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { name: 'AbortError' })), itemDeadline - now);
  });
  try {
    // The async wrapper turns a fetcher that throws synchronously into an ordinary rejection.
    const value = await Promise.race([(async () => fn({ ...ctx, deadline: Math.min(ctx.deadline, itemDeadline) }))(), expired]);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, reason: failureReason(e) };
  } finally {
    clearTimeout(timer);
  }
}

const isLink = (l: unknown): l is PortfolioLink => typeof l === 'object' && l !== null && typeof (l as PortfolioLink).url === 'string';

/**
 * At most BUDGET.fetchConcurrency calls at once, each under BUDGET.perItemMs, all of them under
 * min(ctx.deadline, now + BUDGET.fetchPhaseMs): one `run` per phase, so resolving and fetching share the same slots.
 */
function createRunner(ctx: AcquireContext) {
  const phaseDeadline = Math.min(ctx.deadline, Date.now() + BUDGET.fetchPhaseMs);
  const slots = createLimiter(BUDGET.fetchConcurrency);
  // A slot is taken for the duration of one fetcher/resolver call only, and the deadline is checked once it is held.
  return async <T>(fn: (c: AcquireContext) => Promise<T>): Promise<Boxed<T>> => {
    await slots.acquire();
    try { return await timeBoxed(fn, ctx, phaseDeadline); } finally { slots.release(); }
  };
}
type Runner = ReturnType<typeof createRunner>;

/**
 * What a short link or link-in-bio page leads to: the links (first MAX_RESOLVED_LINKS, each already re-classified by the
 * resolver, so each carries its handler), or the Acquired that settles the link when nothing came out of it.
 */
async function resolveOne(item: FetchItem, run: Runner, resolver: Resolver | undefined): Promise<{ links: PortfolioLink[] } | { settled: Acquired }> {
  if (!resolver) return { settled: unread(item, 'unreviewable', REASON_NOT_OPENED_KIND) };
  const r = await run(c => resolver(item, c));
  if (!r.ok) return { settled: unread(item, 'failed', r.reason) };
  const found = Array.isArray(r.value?.links) ? r.value.links.filter(isLink).slice(0, MAX_RESOLVED_LINKS) : [];
  if (!found.length) {
    const why = r.value?.reason;
    return { settled: unread(item, 'unreviewable', typeof why === 'string' && why ? why : REASON_NO_LINKS) };
  }
  return { links: found };
}

/**
 * Resolves ONLY the short links and link-in-bio pages (handler 'resolve') of `items` — one level deep, under the same
 * slots, per-item timeout and phase budget as acquireFetchItems — and hands back what is left to do:
 *  - `items`: every other input untouched, with each resolved link replaced IN PLACE by the links behind it as
 *    `<ref>.1`, `<ref>.2` … (at most 4). These carry whatever handler the resolver gave them — 'site' (a website, own
 *    domain, Behance, Canva, Notion …) as well as 'document', 'video', 'social', or 'none' — and are for the caller to
 *    process like any other item. That is the point: a website behind a short link or Linktree is a website, so the
 *    caller must split `items` into Chromium sites and fetch-only items AFTER calling this, not before.
 *  - `settled`: an Acquired for each link that could not be expanded — 'unreviewable' when the resolver found nothing (its
 *    own reason), had no resolver to ask, or the link behind it is itself a short link (not followed: one level only);
 *    'failed' (ours, retried, never held against the candidate) when the resolver threw or ran out of time.
 * Never throws. Both lists are in input order, whatever order the resolvers finished in.
 */
export async function expandResolveItems(items: FetchItem[], ctx: AcquireContext, fetchers: FetcherMap): Promise<{ items: FetchItem[]; settled: Acquired[] }> {
  const run = createRunner(ctx);
  const each = await Promise.all(items.map(async (item): Promise<{ items: FetchItem[]; settled: Acquired[] }> => {
    if (item.link.handler !== 'resolve') return { items: [item], settled: [] };
    try {
      const r = await resolveOne(item, run, fetchers.resolve);
      if ('settled' in r) return { items: [], settled: [r.settled] };
      const out = { items: [] as FetchItem[], settled: [] as Acquired[] };
      r.links.forEach((link, i) => {
        const child: FetchItem = { link, ref: `${item.ref}.${i + 1}` };
        if (link.handler === 'resolve') out.settled.push(unread(child, 'unreviewable', REASON_NESTED));
        else out.items.push(child);
      });
      return out;
    } catch (e) {
      return { items: [], settled: [unread(item, 'failed', failureReason(e))] };
    }
  }));
  return { items: each.flatMap(e => e.items), settled: each.flatMap(e => e.settled) };
}

/**
 * Fetches every item with its handler's fetcher, BUDGET.fetchConcurrency at a time, each under BUDGET.perItemMs and
 * all of them under min(ctx.deadline, now + BUDGET.fetchPhaseMs). Results are in INPUT order.
 *  - handler 'none' => unreviewable; a handler with no registered fetcher (or none set) => unreviewable.
 *  - 'resolve': the resolver's links (first 4) each go through their own handler ONCE and take the original's place as
 *    `<ref>.1`, `<ref>.2` …; a resolved link that is itself 'resolve' is not followed; no links => unreviewable. A
 *    resolved WEBSITE ('site') is not opened here (Chromium does that, elsewhere) and is reported as such. A caller that
 *    has a browser should call expandResolveItems first, which hands those websites back for it to open.
 *  - a fetcher that throws, times out or answers nonsense, or a link whose turn came after the phase deadline, is
 *    'failed' (ours). Whatever finished before the deadline is kept.
 */
export async function acquireFetchItems(items: FetchItem[], ctx: AcquireContext, fetchers: FetcherMap): Promise<Acquired[]> {
  const run = createRunner(ctx);

  const resolveThenFetch = async (item: FetchItem): Promise<Acquired[]> => {
    const r = await resolveOne(item, run, fetchers.resolve);
    if ('settled' in r) return [r.settled];
    const parts = await Promise.all(r.links.map((link, i) => handle({ link, ref: `${item.ref}.${i + 1}` }, 1)));
    return parts.flat();
  };

  const dispatch = async (item: FetchItem, depth: 0 | 1): Promise<Acquired[]> => {
    const handler = item.link.handler;
    if (handler === 'none') return [unread(item, 'unreviewable', REASON_NONE)];
    if (handler === 'resolve') return depth === 0 ? resolveThenFetch(item) : [unread(item, 'unreviewable', REASON_NESTED)];
    const fetcher = handler ? fetchers[handler] : undefined;
    if (!fetcher) return [unread(item, 'unreviewable', handler === 'site' && depth === 1 ? REASON_SITE_BEHIND_SHORT_LINK : REASON_NOT_OPENED_KIND)];
    const r = await run(c => fetcher(item, c));
    return [r.ok ? normalized(item, r.value) : unread(item, 'failed', r.reason)];
  };

  const handle = async (item: FetchItem, depth: 0 | 1): Promise<Acquired[]> => {
    try { return await dispatch(item, depth); }
    catch (e) { return [unread(item, 'failed', failureReason(e))]; }
  };

  return (await Promise.all(items.map(item => handle(item, 0)))).flat();
}

// `access` is compared as a string: the capture module's union can grow ('unreviewable' is a member it is adding), and a
// value this adapter has never heard of must read as OUR failure rather than break the build or be held against the candidate.
// `partial` is the capture's own "I stopped early" flag.
type CapturedForAdapter = CapturedPortfolio & { partial?: boolean };

const CAPTURE_DEFAULT_REASON: Record<'inaccessible' | 'failed' | 'unreviewable', string> = {
  inaccessible: 'The link could not be opened',
  failed:       'The site could not be opened because of a problem on our side',
  unreviewable: REASON_NOT_OPENED_KIND,
};

/**
 * A page's address as it goes into the text the model reads and the name search reads: no query string, no fragment and no credentials. A candidate
 * can append anything to a link they paste ("?by=Neha+Sharma", "#neha-sharma"), and the loaded address keeps it; the host and path say where the
 * page is, and the rest is theirs.
 */
export function addressForText(url: unknown): string {
  const raw = typeof url === 'string' ? url : '';
  if (!/[?#@]/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return raw.split(/[?#]/)[0] ?? '';
  }
}

/**
 * Adapts one Chromium site capture to the shape the fetchers return: every page screenshot becomes an image block labelled
 * 'Screenshot <n> of <ref>' (the CALLER applies the image budget, nothing is dropped here), the page texts become 'Page: <title> (<url without query or fragment>)' sections
 * (capped at BUDGET.maxCharsPerItem), and our measurements go to `facts`. The analyzer scans the text for injection,
 * so injectionHit is always false here.
 */
export function fromCaptured(c: CapturedForAdapter, ref: string): Acquired {
  const unreadWith = (outcome: 'inaccessible' | 'failed' | 'unreviewable', reason?: string): Acquired =>
    unread({ link: c.link, ref }, outcome, reason || CAPTURE_DEFAULT_REASON[outcome]);

  const access: string = c.access;
  if (access === 'blocked') return unreadWith('inaccessible', c.accessNote);
  if (access === 'unreviewable' || access === 'skipped') return unreadWith('unreviewable', c.accessNote);
  if (access !== 'ok') return unreadWith('failed', c.accessNote);
  // 'ok' with nothing read would otherwise look like a reviewed artifact.
  if (!c.pages.length) return unreadWith('failed', c.accessNote || 'No page content could be read');

  // The label is OURS and fixed ('Screenshot 2 of L1'). The capture's own label is built from the page's <title>, which the
  // candidate wrote, and a media label sits in the prompt next to our trusted facts: page titles stay inside the (untrusted) text.
  const media: MediaBlock[] = c.pages.flatMap(p => p.shots).map((s, i) => ({
    kind: 'image', label: `Screenshot ${i + 1} of ${ref}`, mime: 'image/jpeg', b64: s.data, bytes: Buffer.byteLength(s.data, 'base64'),
  }));

  let text = c.pages.map(p => `Page: ${p.title} (${addressForText(p.url)})\n${p.text}`.trimEnd()).join('\n\n');
  const textTrimmed = text.length > BUDGET.maxCharsPerItem;
  if (textTrimmed) text = wellFormed(text.slice(0, BUDGET.maxCharsPerItem));

  const why: string[] = [];
  if (c.signals?.truncated) why.push('Time ran out before every page could be captured');
  if (textTrimmed) why.push(`Page text trimmed to ${BUDGET.maxCharsPerItem.toLocaleString('en-US')} characters`);
  if (c.partial && !why.length) why.push('Only part of this site could be captured');
  const partial = why.length > 0;

  const n = c.pages.length;
  const facts = [`${n} page${n === 1 ? '' : 's'} captured`];
  if (media.length) facts.push(`${media.length} screenshot${media.length === 1 ? '' : 's'}`);
  facts.push(...why);

  return {
    ref,
    link: c.link,
    outcome: partial ? 'partial' : 'ok',
    ...(partial ? { reason: c.accessNote || why.join('. ') } : {}),
    basis: 'artifact',
    media,
    text,
    facts,
    injectionHit: false,
    pagesReviewed: n,
    pageTitles: c.pages.map(p => p.title),
  };
}
