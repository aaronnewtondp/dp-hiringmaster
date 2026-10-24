// WORKER-ONLY (see ../browser.ts). The media and social half of the marketing work-sample acquisition: images, video
// links (YouTube / Vimeo / Loom / a direct file), Instagram, and the resolver that unwraps short links and link-in-bio
// pages into the work behind them.
//
// Everything is anonymous and goes through fetchCapped / safeFetch, so EVERY hop of EVERY url is SSRF-checked —
// including the ones WE derive (oEmbed endpoints, thumbnails built from a validated id, a hub's hrefs). The one exception to
// "through safeFetch" is the short-link resolver, which walks redirects itself, one hop at a time, with the same guard
// (assertSafePublicUrl) so that it can decide, before each request, whether the next address may be asked for at all.
// The model cannot watch a video or open a social profile, so those links only ever yield METADATA (basis 'metadata',
// never outcome 'ok'): a title, a description, thumbnails, a bio snippet. Every word of that metadata was typed by a
// stranger, so it is injection-scanned before it can reach the model. LinkedIn is never fetched, by any function here — and
// neither is any other destination the classifier marks 'none' (other social sites, file-transfer links), not even as the
// last stop of a short link's redirect chain.
import { findInjection, stripInvisible } from '../injection.js';
import { wellFormed } from '../text.js';
import type { PortfolioLink, ReviewHandler } from '../types.js';
import { classifyAnswerUrl } from '../answerLinks.js';
import type { ClassifiedAnswerUrl } from '../answerLinks.js';
import { assertSafePublicUrl, safeFetch } from '../urlSafety.js';
import { BUDGET } from './budget.js';
import { fetchCapped, sniffType } from './fetchCapped.js';
import type { CappedResult } from './fetchCapped.js';
import type { FetchItem } from './index.js';
import type { Acquired, AcquireContext, AcquireOutcome, MediaBlock } from './types.js';

export interface ResolveResult { links: PortfolioLink[]; reason?: string }

/**
 * Thrown by resolveLink when OUR side failed to look behind a link (timeout, dropped connection, rate limit, a 5xx).
 * The orchestrator records a throwing resolver as 'failed' — retried, never scored, never held against the candidate —
 * which the plain {links: [], reason} answer cannot say: that one ends as 'unreviewable'. The message is safe to show.
 */
export class ResolveFailedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ResolveFailedError';
  }
}

const HTML_CAP_BYTES = 500 * 1024;
const JSON_CAP_BYTES = 256 * 1024;
const HTML_ACCEPT = 'text/html,application/xhtml+xml';
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif;q=0.9,*/*;q=0.1';
// Honest about who is asking, and shaped like a browser UA so ordinary sites answer it (same string as fetchCapped's default).
const HONEST_UA = 'Mozilla/5.0 (compatible; DigitalPaaniBot/1.0; +https://digitalpaani.com)';

const MAX_THUMBNAILS = 3;
const MAX_HUB_HREFS = 15;
const MAX_HUB_LINKS = 4;
const MAX_TITLE_CHARS = 300;
const MAX_AUTHOR_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 1500;
const MAX_META_CHARS = 1000;

// Reasons shown to HR. None of them ever contains text from a response, a URL or a key.
const REASON_LINKEDIN = 'LinkedIn is never opened automatically - a profile page is not a work sample';
const REASON_BAD_ADDRESS = 'The address could not be read';
const REASON_OUT_OF_TIME = 'Ran out of time before this link could be opened - it will be retried';
const REASON_BOT_WALL = 'The site blocks automated viewing - open it by hand';
// Same wording as documents.ts: on a file-sharing or video service a refusal really does mean "not shared with everyone".
const REASON_PRIVATE_LINK = 'Link is private, deleted or does not allow automated access - ask the candidate to check that anyone with the link can view it';
// On the candidate's own site a 400 or 403 proves nothing: it may be a bot rule or a hot-link rule, so nobody is at fault.
const REASON_REFUSED = 'The site did not allow automated access';
const REASON_INJECTION = 'Text on this link was aimed at an AI reviewer, so it was left out - please review it by hand';
const REASON_VIDEO_NOT_WATCHED = 'Video was not watched - only its title, description and thumbnails were reviewed';
const REASON_PAGE_NOT_WATCHED = 'Videos were not watched - only the page title and description were available';
const REASON_VIDEO_UNAVAILABLE = 'The video is private, removed or not shared publicly';
const REASON_INSTAGRAM_WALL = 'Instagram does not allow automated viewing - open it by hand';
const REASON_INSTAGRAM_SNIPPET = 'Only the public bio/caption snippet was available - the posts themselves were not viewed';
const REASON_TEXT_LIMIT = 'The review reached its limit for text, so this link was not included';
const REASON_IMAGE_LIMIT = 'The review reached its size limit, so this image was not included';

const IMAGE_MIME: Partial<Record<ReturnType<typeof sniffType>, string>> = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
};

// ─── small helpers ───────────────────────────────────────────────────────────

type Failure = { outcome: AcquireOutcome; reason: string; status?: number };
type Got = { res: CappedResult } | { fail: Failure };

function acquired(item: FetchItem, outcome: AcquireOutcome, over: Partial<Acquired> = {}): Acquired {
  return { ref: item.ref, link: item.link, outcome, basis: 'artifact', media: [], text: '', facts: [], injectionHit: false, ...over };
}

const refuse = (item: FetchItem, f: Failure, over: Partial<Acquired> = {}): Acquired =>
  acquired(item, f.outcome, { reason: f.reason, ...over });

function parseUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch { return null; }
}

const hostOf = (u: URL): string => u.hostname.toLowerCase().replace(/\.+$/, '');
const hostOfUrl = (raw: string): string => { const u = parseUrl(raw); return u ? hostOf(u) : ''; };
const onHost = (host: string, base: string): boolean => host === base || host.endsWith(`.${base}`);

/** LinkedIn (and its lnkd.in shortener) is never fetched: judged from the link's own host AND the host in its URL. */
function isLinkedIn(item: FetchItem, u: URL | null): boolean {
  const hosts = [item.link.host ?? '', u ? hostOf(u) : ''].map(h => h.toLowerCase());
  return item.link.platform === 'linkedin' || hosts.some(h => onHost(h, 'linkedin.com') || onHost(h, 'lnkd.in'));
}

const itemDeadline = (ctx: AcquireContext): number => Math.min(ctx.deadline, Date.now() + BUDGET.perItemMs);

/**
 * Text from a stranger: whitespace collapsed, capped without cutting an emoji in half. Invisible and control characters
 * (injection.ts stripInvisible: the ONE definition the scan itself uses) are REMOVED, not turned into spaces: a phrase split by
 * zero-width characters ("ig\u200bnore previous …") must read as the phrase it is, so the injection scan that runs on this text
 * still sees it.
 */
function clean(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  const t = stripInvisible(s).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return wellFormed(t);
  const cut = /[\ud800-\udbff]/.test(t[max - 1]) ? max - 1 : max;
  return wellFormed(t.slice(0, cut)).trim();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 12400 -> '12.4K', 1_500_000 -> '1.5M'. Rolls over to the next unit instead of printing '1000K'. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  const units: Array<[number, string]> = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (let i = 0; i < units.length; i++) {
    const [size, suffix] = units[i];
    if (n < size) continue;
    const rounded = Math.round((n / size) * 10) / 10;
    if (rounded >= 1000 && i > 0) return `1${units[i - 1][1]}`;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}${suffix}`;
  }
  return String(Math.round(n));
}

function secondsToText(total: number): string | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const t = Math.round(total);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const parts = [h ? `${h} h` : '', m ? `${m} min` : '', s ? `${s} s` : ''].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

/** 'PT12M4S' -> '12 min 4 s'. Null for a live stream's 'P0D', anything malformed, or zero. */
export function isoDurationToText(iso: unknown): string | null {
  if (typeof iso !== 'string') return null;
  const m = /^P(?:(\d{1,4})D)?(?:T(?:(\d{1,4})H)?(?:(\d{1,4})M)?(?:(\d{1,4})S)?)?$/.exec(iso);
  if (!m) return null;
  const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map(v => (v ? Number(v) : 0));
  return secondsToText(d * 86400 + h * 3600 + min * 60 + s);
}

function firstInjection(...fields: string[]): boolean {
  return fields.some(f => findInjection(f) !== null);
}

// ─── fetching with a classified failure ──────────────────────────────────────

// Services where a "no" means what it says: the file or video is private or gone. Everywhere else a 400/403 may only be the
// site refusing a machine.
const SHARING_SERVICE_HOSTS = [
  'google.com', 'googleusercontent.com', 'dropbox.com', 'dropboxusercontent.com', 'onedrive.live.com', '1drv.ms',
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'ytimg.com', 'vimeo.com', 'vimeocdn.com',
];
const isSharingService = (host: string): boolean => SHARING_SERVICE_HOSTS.some(d => onHost(host, d));

/**
 * Why a response was not a usable 2xx, by whose fault it is — one policy with documents.ts:
 *  - 404/410/401 are the candidate's link not working for a stranger (inaccessible);
 *  - 400/403 are the same on Google, Dropbox, OneDrive, YouTube and Vimeo (`host`: the service says "private or gone"), but on
 *    any other host they may just be a bot rule or a hot-link rule, so they prove nothing (unreviewable, neutral);
 *  - 408, 429 and 5xx are OURS or the site's passing trouble (failed: retried, never held against anyone);
 *  - a Cloudflare challenge (cf-mitigated on a status such a challenge is served with) is nobody's fault (unreviewable);
 *  - any other status is a link nobody can say anything about (unreviewable).
 * `host` is the lower-case host the request went to ('' when unknown, which reads as "not a sharing service").
 */
function failureOfStatus(status: number, headers: Record<string, string>, host = ''): Failure {
  const challenge = (status === 403 || status === 429 || status === 503) && headers['cf-mitigated'] !== undefined;
  if (challenge) return { outcome: 'unreviewable', reason: REASON_BOT_WALL, status };
  const service = isSharingService(host);
  if (status === 404 || status === 410) {
    return { outcome: 'inaccessible', reason: service ? REASON_PRIVATE_LINK : `The link does not exist or was removed (error ${status})`, status };
  }
  if (status === 401) {
    return { outcome: 'inaccessible', reason: service ? REASON_PRIVATE_LINK : `The link is private or needs a sign-in (error ${status})`, status };
  }
  if (status === 400 || status === 403) {
    return service
      ? { outcome: 'inaccessible', reason: REASON_PRIVATE_LINK, status }
      : { outcome: 'unreviewable', reason: REASON_REFUSED, status };
  }
  if (status === 429) return { outcome: 'failed', reason: 'The site is limiting how fast we may ask (error 429) - it will be retried', status };
  if (status === 408) return { outcome: 'failed', reason: 'The site took too long to answer (error 408) - it will be retried', status };
  if (status >= 500) return { outcome: 'failed', reason: `The site had a temporary problem (error ${status}) - it will be retried`, status };
  if (status >= 400) return { outcome: 'unreviewable', reason: `The link could not be opened (error ${status})`, status };
  return { outcome: 'failed', reason: `The link did not answer as expected (status ${status}) - it will be retried`, status };
}

/** A thrown error, by what it says about whose fault it is. The error text itself is never shown. */
function failureOfError(e: unknown): Failure {
  let msg = '';
  try { msg = e instanceof Error ? e.message : String(e); } catch { /* an unprintable value */ }
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  if (code === 'ENOTFOUND' || /hostname does not resolve|ENOTFOUND/i.test(msg)) {
    return { outcome: 'inaccessible', reason: 'The address does not exist (the website could not be found)' };
  }
  if (/unsafe or unsupported URL|private or reserved address/i.test(msg)) {
    return { outcome: 'unreviewable', reason: 'This address cannot be opened automatically' };
  }
  if (/too many redirects/i.test(msg)) return { outcome: 'inaccessible', reason: 'The link redirects in a loop' };
  if (/CERT_|ERR_TLS_CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(`${msg} ${String(code ?? '')}`)) {
    return { outcome: 'inaccessible', reason: "The website's security certificate is invalid" };
  }
  return { outcome: 'failed', reason: 'The link could not be reached (timeout or connection problem) - it will be retried' };
}

/**
 * One capped GET that never throws. Resolves with the response only when there is something to look at: a whole 2xx
 * body, or `tooLarge` (the caller decides what too large means for its kind of file). Anything else is a Failure.
 */
async function get(url: string, o: { maxBytes: number; accept?: string; userAgent?: string }, until: number): Promise<Got> {
  const timeoutMs = Math.floor(until - Date.now());
  if (timeoutMs <= 0) return { fail: { outcome: 'failed', reason: REASON_OUT_OF_TIME } };
  let res: CappedResult;
  try {
    res = await fetchCapped(url, { ...o, timeoutMs });
  } catch (e) {
    return { fail: failureOfError(e) };
  }
  if (res.tooLarge) return { res };
  if (!res.ok) return { fail: failureOfStatus(res.status, res.headers ?? {}, hostOfUrl(url)) };
  if (!res.bytes || res.bytes.length === 0) return { fail: { outcome: 'failed', reason: 'The link returned an empty response - it will be retried' } };
  return { res };
}

/** GETs a JSON object (an oEmbed or API answer). Anything else is a failure on the far side, i.e. ours to retry. */
async function getJson(url: string, until: number): Promise<{ json: Record<string, unknown> } | { fail: Failure }> {
  const got = await get(url, { maxBytes: JSON_CAP_BYTES, accept: 'application/json' }, until);
  if ('fail' in got) return got;
  const unexpected: Failure = { outcome: 'failed', reason: 'The site answered with something unexpected - it will be retried' };
  if (got.res.tooLarge || !got.res.bytes) return { fail: unexpected };
  try {
    const parsed: unknown = JSON.parse(got.res.bytes.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { fail: unexpected };
    return { json: parsed as Record<string, unknown> };
  } catch {
    return { fail: unexpected };
  }
}

// ─── images ──────────────────────────────────────────────────────────────────

function imageMime(bytes: Buffer): string | null {
  return IMAGE_MIME[sniffType(bytes)] ?? null;
}

/** One image slot, then its bytes. Both reservations are synchronous, so concurrent fetchers can never both pass a cap. */
function reserveImage(ctx: AcquireContext, bytes: number): boolean {
  return ctx.budget.reserveImages(1) === 1 && ctx.budget.reserveBytes(bytes);
}

/** A thumbnail or similar: one best-effort image. Null = not usable (skip it); 'full' = the budget is spent (stop asking). */
async function takeImage(url: string, label: string, ctx: AcquireContext, until: number): Promise<MediaBlock | 'full' | null> {
  const got = await get(url, { maxBytes: BUDGET.maxImageBytes, accept: IMAGE_ACCEPT }, until);
  if ('fail' in got || got.res.tooLarge || !got.res.bytes) return null;
  const { bytes } = got.res;
  const mime = imageMime(bytes);
  if (!mime) return null;
  if (!reserveImage(ctx, bytes.length)) return 'full';
  return { kind: 'image', label, mime, b64: bytes.toString('base64'), bytes: bytes.length };
}

/** A direct image link: one capped download, the format decided from its bytes (never the content-type), one image block. */
export async function fetchImage(item: FetchItem, ctx: AcquireContext): Promise<Acquired> {
  const u = parseUrl(item.link.url);
  if (!u) return acquired(item, 'unreviewable', { reason: REASON_BAD_ADDRESS });
  if (isLinkedIn(item, u)) return acquired(item, 'unreviewable', { reason: REASON_LINKEDIN });

  const got = await get(item.link.url, { maxBytes: BUDGET.maxImageBytes, accept: IMAGE_ACCEPT }, itemDeadline(ctx));
  if ('fail' in got) return refuse(item, got.fail);
  const { res } = got;
  if (res.tooLarge || !res.bytes) {
    return acquired(item, 'unreviewable', { reason: `Image larger than ${BUDGET.maxImageBytes / (1024 * 1024)} MB - too large to review automatically` });
  }
  const mime = imageMime(res.bytes);
  if (!mime) {
    return acquired(item, 'unreviewable', { reason: 'Image format not supported - only JPEG, PNG, WebP and GIF can be reviewed' });
  }
  if (!reserveImage(ctx, res.bytes.length)) return acquired(item, 'unreviewable', { reason: REASON_IMAGE_LIMIT });
  return acquired(item, 'ok', {
    media: [{ kind: 'image', label: `${item.ref} image`, mime, b64: res.bytes.toString('base64'), bytes: res.bytes.length }],
    facts: [`Image, ${formatBytes(res.bytes.length)}`],
  });
}

// ─── HTML metadata (no regex over attacker-sized input) ──────────────────────

const MAX_TAG_CHARS = 4096;
const MAX_TAGS_SCANNED = 600;
// Total characters examined by one findTags() call. A page of unclosed tags would otherwise cost MAX_TAG_CHARS per '<'.
const MAX_SCAN_WORK = 4_000_000;
const WHITESPACE = /\s/;

interface HtmlTag { attrs: Record<string, string>; end: number; closed: boolean }

/** The attributes of one tag, scanning at most MAX_TAG_CHARS: a tag that never closes costs a bounded amount of work. */
function readTag(html: string, nameEnd: number): HtmlTag {
  const limit = Math.min(html.length, nameEnd + MAX_TAG_CHARS);
  const attrs: Record<string, string> = Object.create(null);
  let i = nameEnd;
  while (i < limit) {
    const c = html[i];
    if (c === '>') return { attrs, end: i + 1, closed: true };
    if (c === '/' || WHITESPACE.test(c)) { i++; continue; }
    const nameStart = i;
    while (i < limit && html[i] !== '=' && html[i] !== '>' && html[i] !== '/' && !WHITESPACE.test(html[i])) i++;
    const name = html.slice(nameStart, i).toLowerCase();
    while (i < limit && WHITESPACE.test(html[i])) i++;
    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < limit && WHITESPACE.test(html[i])) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        if (close === -1 || close >= limit) return { attrs, end: limit, closed: false };
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const valueStart = i;
        while (i < limit && html[i] !== '>' && !WHITESPACE.test(html[i])) i++;
        value = html.slice(valueStart, i);
      }
    }
    if (name && !(name in attrs)) attrs[name] = value;
  }
  return { attrs, end: limit, closed: false };
}

/** Opening tags called `name`, in document order (case-insensitive), at most `limit` of them, within a bounded amount of work. */
function findTags(html: string, name: string, limit: number): HtmlTag[] {
  const out: HtmlTag[] = [];
  let work = 0;
  let i = html.indexOf('<');
  while (i !== -1 && out.length < limit && work <= MAX_SCAN_WORK) {
    const nameEnd = i + 1 + name.length;
    if (nameEnd < html.length && html.slice(i + 1, nameEnd).toLowerCase() === name && /[\s/>]/.test(html[nameEnd])) {
      const tag = readTag(html, nameEnd);
      work += tag.end - i;
      if (tag.closed) {
        out.push(tag);
        i = html.indexOf('<', tag.end);
        continue;
      }
    }
    i = html.indexOf('<', i + 1);
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** One pass, so '&amp;lt;' becomes '&lt;' and never '<'. */
function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi, (whole, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex ?? '', 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
  });
}

/** The `content` of the first <meta property|name="key"> that has any, cleaned and capped. Null when there is none. */
export function readMeta(html: string, key: string, max = MAX_META_CHARS): string | null {
  for (const tag of findTags(html, 'meta', MAX_TAGS_SCANNED)) {
    const { property, name, content } = tag.attrs;
    if (property?.toLowerCase() !== key && name?.toLowerCase() !== key) continue;
    const value = clean(decodeEntities(content ?? ''), max);
    if (value) return value;
  }
  return null;
}

/** The text of the first <title>, cleaned and capped. */
export function readTitle(html: string, max = MAX_TITLE_CHARS): string | null {
  const [tag] = findTags(html, 'title', 1);
  if (!tag) return null;
  const close = html.indexOf('</', tag.end);
  const raw = html.slice(tag.end, close === -1 ? tag.end + 2000 : Math.min(close, tag.end + 2000));
  return clean(decodeEntities(raw), max) || null;
}

/** Absolute http(s) hrefs of a link-in-bio page, in page order, de-duplicated, its own host left out, at most MAX_HUB_HREFS. */
export function extractHubHrefs(html: string, hubHost: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of findTags(html, 'a', MAX_TAGS_SCANNED * 4)) {
    const href = decodeEntities(tag.attrs.href ?? '').trim();
    if (!/^https?:\/\//i.test(href)) continue;    // relative, #anchor, mailto:, tel:, javascript:, //host
    const u = parseUrl(href);
    if (!u || onHost(hostOf(u), hubHost) || seen.has(u.href)) continue;
    seen.add(u.href);
    out.push(href);
    if (out.length >= MAX_HUB_HREFS) break;
  }
  return out;
}

// ─── video ───────────────────────────────────────────────────────────────────

interface VideoMetadata {
  site:        string;
  reason:      string;
  title:       string;
  author:      string;
  description: string;
  /** Trusted, formatted by us: '12.4K views', '12 min 4 s'. */
  extras:      string[];
  thumbnails:  () => Promise<MediaBlock[]>;
}

/**
 * The shared tail of every video/page-metadata path: scan what a stranger wrote, THEN spend requests on thumbnails,
 * reserve the text from the budget, and report metadata only ('partial', never 'ok').
 */
async function videoMetadata(item: FetchItem, ctx: AcquireContext, m: VideoMetadata): Promise<Acquired> {
  if (firstInjection(m.title, m.author, m.description)) {
    return acquired(item, 'unreviewable', { reason: REASON_INJECTION, basis: 'metadata', injectionHit: true });
  }
  const media = await m.thumbnails();
  const wanted = [
    m.title && `Title: ${m.title}`,
    m.author && `Channel: ${m.author}`,
    m.description && `Description: ${m.description}`,
  ].filter(Boolean).join('\n');
  const text = wanted.slice(0, wanted ? ctx.budget.reserveChars(wanted.length) : 0);
  if (!text && media.length === 0) {
    return acquired(item, 'unreviewable', { basis: 'metadata', reason: wanted ? REASON_TEXT_LIMIT : 'Nothing could be read from this video link' });
  }

  // Fields are single-line (clean() collapses whitespace), so a line start can only be one of OUR labels.
  const parts = [/^Title: /m.test(text) && 'title', /^Description: /m.test(text) && 'description'].filter(Boolean) as string[];
  if (media.length) parts.push(`${media.length} thumbnail${media.length === 1 ? '' : 's'}`);
  const fact = `${m.site}: ${parts.join(', ') || 'details'}${m.extras.length ? `; ${m.extras.join('; ')}` : ''}`;
  return acquired(item, 'partial', { reason: m.reason, basis: 'metadata', media, text, facts: [fact] });
}

/** A video that cannot be opened: a missing/private/blocked video is the candidate's link; the rest keeps its own class. */
function videoFailure(f: Failure): Failure {
  const gone = f.status === 401 || f.status === 403 || f.status === 404 || f.status === 410;
  // YouTube and Vimeo already carry the sharing-service wording; this is for the rest (Loom).
  return gone && f.outcome === 'inaccessible' && f.reason !== REASON_PRIVATE_LINK ? { ...f, reason: REASON_VIDEO_UNAVAILABLE } : f;
}

const YOUTUBE_ID = /^[\w-]{11}$/;

/** The 11-character id of a YouTube video link (watch?v=, youtu.be/, shorts/, embed/, live/, v/), or null. Never a guess. */
export function youtubeVideoId(raw: string): string | null {
  const u = parseUrl(raw);
  if (!u) return null;
  const host = hostOf(u);
  const segments = u.pathname.split('/').filter(Boolean);
  let candidate: string | null | undefined;
  if (host === 'youtu.be') candidate = segments[0];
  else if (onHost(host, 'youtube.com') || onHost(host, 'youtube-nocookie.com')) {
    if (segments[0] === 'watch') candidate = u.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(segments[0] ?? '')) candidate = segments[1];
  }
  return candidate && YOUTUBE_ID.test(candidate) ? candidate : null;
}

/** A channel, @handle, user or playlist page: no single video, so only its page title and description can be read. */
function isYouTubeListingPage(u: URL): boolean {
  if (!onHost(hostOf(u), 'youtube.com')) return false;
  const first = u.pathname.split('/').filter(Boolean)[0] ?? '';
  return first.startsWith('@') || ['channel', 'c', 'user', 'playlist'].includes(first);
}

/** Up to three thumbnails of a video, from URLs built here out of the validated id — never taken from a response. */
async function youtubeThumbnails(id: string, ref: string, ctx: AcquireContext, until: number): Promise<MediaBlock[]> {
  const base = `https://i.ytimg.com/vi/${id}`;
  const blocks: MediaBlock[] = [];
  // The best frame first (maxres, else the default hq one), then the three extra frames, best effort.
  for (const names of [['maxresdefault.jpg', 'hqdefault.jpg'], ['hq1.jpg'], ['hq2.jpg'], ['hq3.jpg']]) {
    if (blocks.length >= MAX_THUMBNAILS) break;
    for (const name of names) {
      const got = await takeImage(`${base}/${name}`, `${ref} YouTube thumbnail ${blocks.length + 1}`, ctx, until);
      if (got === 'full') return blocks;
      if (got) { blocks.push(got); break; }
    }
  }
  return blocks;
}

/** Optional, only with YOUTUBE_API_KEY set: the description, duration and view count. Any failure just means "without". */
async function youtubeApiDetails(id: string, until: number): Promise<{ description: string; duration: string | null; views: number | null } | null> {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) return null;
  const got = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${id}&key=${encodeURIComponent(key)}`, until);
  if ('fail' in got) return null;
  const first: unknown = Array.isArray(got.json.items) ? got.json.items[0] : null;
  if (typeof first !== 'object' || first === null) return null;
  const { snippet, contentDetails, statistics } = first as Record<string, Record<string, unknown> | undefined>;
  const views = typeof statistics?.viewCount === 'string' && /^\d{1,15}$/.test(statistics.viewCount) ? Number(statistics.viewCount) : null;
  return {
    description: clean(snippet?.description, MAX_DESCRIPTION_CHARS),
    duration: isoDurationToText(contentDetails?.duration),
    views,
  };
}

async function fetchYouTubeVideo(item: FetchItem, ctx: AcquireContext, id: string): Promise<Acquired> {
  const until = itemDeadline(ctx);
  const oembed = await getJson(
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, until);
  if ('fail' in oembed) return refuse(item, videoFailure(oembed.fail), { basis: 'metadata' });

  const api = await youtubeApiDetails(id, until);
  const extras = [api?.views != null ? `${formatCount(api.views)} views` : '', api?.duration ?? ''].filter(Boolean);
  return videoMetadata(item, ctx, {
    site: 'YouTube video',
    reason: REASON_VIDEO_NOT_WATCHED,
    title: clean(oembed.json.title, MAX_TITLE_CHARS),
    author: clean(oembed.json.author_name, MAX_AUTHOR_CHARS),
    description: api?.description ?? '',
    extras,
    thumbnails: () => youtubeThumbnails(id, item.ref, ctx, until),
  });
}

/** A channel/playlist/@handle page: its <title>, og:title and og:description are all there is. */
async function fetchListingPage(item: FetchItem, ctx: AcquireContext, site: string): Promise<Acquired> {
  const got = await get(item.link.url, { maxBytes: HTML_CAP_BYTES, accept: HTML_ACCEPT, userAgent: HONEST_UA }, itemDeadline(ctx));
  if ('fail' in got) return refuse(item, got.fail, { basis: 'metadata' });
  if (got.res.tooLarge || !got.res.bytes) {
    return acquired(item, 'unreviewable', { basis: 'metadata', reason: 'The page is too large to read automatically' });
  }
  const html = got.res.bytes.toString('utf8');
  return videoMetadata(item, ctx, {
    site,
    reason: REASON_PAGE_NOT_WATCHED,
    title: readMeta(html, 'og:title', MAX_TITLE_CHARS) ?? readTitle(html) ?? '',
    author: '',
    description: readMeta(html, 'og:description', MAX_DESCRIPTION_CHARS) ?? readMeta(html, 'description', MAX_DESCRIPTION_CHARS) ?? '',
    extras: [],
    thumbnails: async () => [],
  });
}

/** vimeo.com/<id>[/<hash>], player.vimeo.com/video/<id>?h=<hash>, channels/…/<id>, groups/…/videos/<id>, showcase/…/video/<id>. */
function vimeoCanonicalUrl(u: URL): string | null {
  const segments = u.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  let hash: string | null | undefined;
  if (hostOf(u) === 'player.vimeo.com') {
    if (segments[0] === 'video') id = segments[1];
    hash = u.searchParams.get('h');
  } else if (/^\d+$/.test(segments[0] ?? '')) {
    id = segments[0];
    hash = segments[1];
  } else if (segments[0] === 'channels') id = segments[2];
  else if (segments[0] === 'groups' && segments[2] === 'videos') id = segments[3];
  else if ((segments[0] === 'album' || segments[0] === 'showcase') && segments[2] === 'video') id = segments[3];
  if (!id || !/^\d{4,12}$/.test(id)) return null;
  return `https://vimeo.com/${id}${hash && /^[0-9a-f]{8,16}$/i.test(hash) ? `/${hash}` : ''}`;
}

/** A thumbnail URL out of a Vimeo response is followed ONLY when it is https on a *.vimeocdn.com host, with no login or port. */
function vimeoThumbnailUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const u = parseUrl(raw.trim());
  if (!u || u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  return hostOf(u).endsWith('.vimeocdn.com') ? u.href : null;
}

async function fetchVimeoVideo(item: FetchItem, ctx: AcquireContext, u: URL): Promise<Acquired> {
  const canonical = vimeoCanonicalUrl(u);
  if (!canonical) {
    return acquired(item, 'unreviewable', { basis: 'metadata', reason: 'Only a single Vimeo video can be read automatically, not a profile or showcase page' });
  }
  const until = itemDeadline(ctx);
  const oembed = await getJson(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(canonical)}`, until);
  if ('fail' in oembed) return refuse(item, videoFailure(oembed.fail), { basis: 'metadata' });

  const thumbnail = vimeoThumbnailUrl(oembed.json.thumbnail_url);
  const duration = typeof oembed.json.duration === 'number' ? secondsToText(oembed.json.duration) : null;
  return videoMetadata(item, ctx, {
    site: 'Vimeo video',
    reason: REASON_VIDEO_NOT_WATCHED,
    title: clean(oembed.json.title, MAX_TITLE_CHARS),
    author: clean(oembed.json.author_name, MAX_AUTHOR_CHARS),
    description: clean(oembed.json.description, MAX_DESCRIPTION_CHARS),
    extras: duration ? [duration] : [],
    thumbnails: async () => {
      if (!thumbnail) return [];
      const got = await takeImage(thumbnail, `${item.ref} Vimeo thumbnail 1`, ctx, until);
      return got && got !== 'full' ? [got] : [];
    },
  });
}

async function fetchLoomVideo(item: FetchItem, ctx: AcquireContext, u: URL): Promise<Acquired> {
  const [kind, id] = u.pathname.split('/').filter(Boolean);
  if ((kind !== 'share' && kind !== 'embed') || !id || !/^[\w-]{16,64}$/.test(id)) {
    return acquired(item, 'unreviewable', { basis: 'metadata', reason: 'The Loom address could not be read' });
  }
  const until = itemDeadline(ctx);
  const oembed = await getJson(`https://www.loom.com/v1/oembed?url=${encodeURIComponent(`https://www.loom.com/share/${id}`)}`, until);
  if ('fail' in oembed) return refuse(item, videoFailure(oembed.fail), { basis: 'metadata' });

  const duration = typeof oembed.json.duration === 'number' ? secondsToText(oembed.json.duration) : null;
  return videoMetadata(item, ctx, {
    site: 'Loom video',
    reason: REASON_VIDEO_NOT_WATCHED,
    title: clean(oembed.json.title, MAX_TITLE_CHARS),
    author: clean(oembed.json.author_name, MAX_AUTHOR_CHARS),
    description: clean(oembed.json.description, MAX_DESCRIPTION_CHARS),
    extras: duration ? [duration] : [],
    thumbnails: async () => [],
  });
}

const VIDEO_FILE_EXTENSION = /\.(mp4|m4v|mov|webm|mkv|avi|ogv|mpe?g)$/i;

/** The total size a response declares: a 206's Content-Range total (we ask for one byte), else Content-Length. */
function declaredSize(res: Response): number | null {
  const range = res.headers.get('content-range');
  const total = range ? /\/(\d+)\s*$/.exec(range)?.[1] : undefined;
  const raw = total ?? (res.status === 206 ? null : res.headers.get('content-length'));
  if (raw == null || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * A direct video file: nothing to read and no frames to look at. One GET for the first byte (so the headers tell us the
 * size and type), the body cancelled at once. The link is reported as not watched — there is no title, description
 * or thumbnail to review, so it can never count as evidence.
 */
async function fetchVideoFile(item: FetchItem, ctx: AcquireContext): Promise<Acquired> {
  const ms = Math.floor(itemDeadline(ctx) - Date.now());
  if (ms <= 0) return refuse(item, { outcome: 'failed', reason: REASON_OUT_OF_TIME }, { basis: 'metadata' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await safeFetch(item.link.url, { method: 'GET', headers: { 'user-agent': HONEST_UA, range: 'bytes=0-0' }, signal: controller.signal });
    try { await res.body?.cancel(); } catch { /* the body is not needed */ }
    if (res.status < 200 || res.status >= 300) {
      const cf = res.headers.get('cf-mitigated');
      return refuse(item, failureOfStatus(res.status, cf === null ? {} : { 'cf-mitigated': cf }, hostOfUrl(item.link.url)), { basis: 'metadata' });
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
      return acquired(item, 'unreviewable', { basis: 'metadata', reason: 'This link opens a web page, not a video file' });
    }
    const size = declaredSize(res);
    const type = /^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/.test(contentType) ? contentType : '';
    return acquired(item, 'unreviewable', {
      basis: 'metadata',
      reason: "Video was not watched - only the file's size and type could be checked",
      facts: [`Video file${size !== null ? `, ${formatBytes(size)}` : ''}${type ? `, ${type}` : ''}`],
    });
  } catch (e) {
    return refuse(item, failureOfError(e), { basis: 'metadata' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * YouTube, Vimeo, Loom or a direct video file. The model cannot watch video, so this is METADATA ONLY (basis 'metadata',
 * a readable one is 'partial', never 'ok'): title, channel, description, up to three thumbnails.
 */
export async function fetchVideo(item: FetchItem, ctx: AcquireContext): Promise<Acquired> {
  const u = parseUrl(item.link.url);
  if (!u) return acquired(item, 'unreviewable', { basis: 'metadata', reason: REASON_BAD_ADDRESS });
  if (isLinkedIn(item, u)) return acquired(item, 'unreviewable', { basis: 'metadata', reason: REASON_LINKEDIN });

  const host = hostOf(u);
  if (host === 'youtu.be' || onHost(host, 'youtube.com') || onHost(host, 'youtube-nocookie.com')) {
    const id = youtubeVideoId(item.link.url);
    if (id) return fetchYouTubeVideo(item, ctx, id);
    if (isYouTubeListingPage(u)) return fetchListingPage(item, ctx, 'YouTube page');
    return acquired(item, 'unreviewable', { basis: 'metadata', reason: 'The YouTube address does not point to a single video or a channel' });
  }
  if (onHost(host, 'vimeo.com')) return fetchVimeoVideo(item, ctx, u);
  if (onHost(host, 'loom.com')) return fetchLoomVideo(item, ctx, u);
  if (item.link.platform === 'video_file' || VIDEO_FILE_EXTENSION.test(u.pathname)) return fetchVideoFile(item, ctx);
  return acquired(item, 'unreviewable', { basis: 'metadata', reason: 'This video site cannot be read automatically - open it by hand' });
}

// ─── Instagram ───────────────────────────────────────────────────────────────

// Where Instagram sends an anonymous visitor it will not show the page to.
const INSTAGRAM_WALL_PATH = /^\/(?:accounts\/login|challenge|consent)(?:\/|$)/i;
const INSTAGRAM_REFUSALS = new Set([302, 401, 403, 429]);

const isInstagramHost = (host: string): boolean => onHost(host, 'instagram.com') || host === 'instagr.am';

/**
 * Instagram, and only the snippet its public page offers every visitor: ONE honest GET, then og:title and
 * og:description (follower counts, a bio or a caption). A login or consent wall, or a page without an og:description,
 * is "does not allow automated viewing" — nobody's fault. LinkedIn and every other social site are never fetched.
 */
export async function fetchSocial(item: FetchItem, ctx: AcquireContext): Promise<Acquired> {
  const u = parseUrl(item.link.url);
  if (isLinkedIn(item, u)) return acquired(item, 'unreviewable', { basis: 'metadata', reason: REASON_LINKEDIN });
  if (!u) return acquired(item, 'unreviewable', { basis: 'metadata', reason: REASON_BAD_ADDRESS });
  if (!isInstagramHost(hostOf(u))) {
    return acquired(item, 'unreviewable', { basis: 'metadata', reason: 'This social platform does not allow automated viewing - open it by hand' });
  }

  const wall = (): Acquired => acquired(item, 'unreviewable', { basis: 'metadata', reason: REASON_INSTAGRAM_WALL });
  const got = await get(item.link.url, { maxBytes: HTML_CAP_BYTES, accept: HTML_ACCEPT, userAgent: HONEST_UA }, itemDeadline(ctx));
  if ('fail' in got) {
    if (got.fail.status !== undefined && INSTAGRAM_REFUSALS.has(got.fail.status)) return wall();
    if (got.fail.outcome === 'unreviewable') return wall();
    return refuse(item, got.fail, { basis: 'metadata' });
  }
  if (got.res.tooLarge || !got.res.bytes) return wall();

  const final = parseUrl(got.res.finalUrl || item.link.url);
  if (!final || !isInstagramHost(hostOf(final)) || INSTAGRAM_WALL_PATH.test(final.pathname)) return wall();
  const html = got.res.bytes.toString('utf8');
  const description = readMeta(html, 'og:description');
  if (!description) return wall();
  const title = readMeta(html, 'og:title', MAX_TITLE_CHARS) ?? '';

  if (firstInjection(title, description)) {
    return acquired(item, 'unreviewable', { basis: 'metadata', reason: REASON_INJECTION, injectionHit: true });
  }
  const wanted = [title && `Title: ${title}`, `Description: ${description}`].filter(Boolean).join('\n');
  const text = wanted.slice(0, ctx.budget.reserveChars(wanted.length));
  if (!text) return acquired(item, 'unreviewable', { basis: 'metadata', reason: REASON_TEXT_LIMIT });
  return acquired(item, 'partial', {
    reason: REASON_INSTAGRAM_SNIPPET,
    basis: 'metadata',
    text,
    facts: ['Instagram: public bio/caption snippet only'],
  });
}

// ─── short links and link-in-bio pages ───────────────────────────────────────

const HUB_HOSTS = ['linktr.ee', 'bio.link', 'beacons.ai', 'linkin.bio', 'lnk.bio', 'campsite.bio'];
// Where a sign-in wall puts the page a visitor was after (Google: ?continue=). The wall itself is never a work link.
const SIGN_IN_HOSTS = ['accounts.google.com', 'login.live.com', 'login.microsoftonline.com'];

const toLink = (c: { url: string; host: string; platform: PortfolioLink['platform']; handler: ReviewHandler }): PortfolioLink =>
  ({ url: c.url, host: c.host, platform: c.platform, handler: c.handler });

/** document 0, site/image 1, video 2, social 3: the order a hub's links are kept in. */
function reviewRank(l: PortfolioLink): number {
  switch (l.handler) {
    case 'document': return 0;
    case 'site': case 'image': return 1;
    case 'video': return 2;
    case 'social': return 3;
    default: return 4;
  }
}

/** No links, and why. A failure on our side is thrown instead (see ResolveFailedError), so it is retried and never reads as "nothing there". */
function unresolved(f: Failure): ResolveResult {
  if (f.outcome === 'failed') throw new ResolveFailedError(f.reason.replace(/ - it will be retried$/, ''));
  return { links: [], reason: f.reason };
}

async function discardBody(res: Response): Promise<void> {
  try { await res.body?.cancel(); } catch { /* the body is not needed */ }
}

/** Where a short link's redirect chain ended, or the never-opened destination it stopped in front of, or why it failed. */
type Probed = { finalUrl: string; status: number } | { stopped: ClassifiedAnswerUrl } | { fail: Failure };

// At most this many requests for one short link (the link itself, then each redirect it points to).
const MAX_HOPS = 5;
const REASON_BAD_REDIRECT = 'The short link redirects to an address that cannot be read';

/**
 * Follows a short link's redirects ONE HOP AT A TIME and reads where it ended up. Never reads a body. Each hop is
 * SSRF-checked (assertSafePublicUrl) and requested with `redirect: 'manual'`, so we, not fetch, decide whether the next
 * address may be asked for: every Location is classified BEFORE it is requested, and one that is never opened (LinkedIn,
 * lnkd.in, other social, WeTransfer, Google Play, Looker Studio, Google Photos) ends the walk right there — no request, not even a HEAD, ever reaches it — and is
 * handed back as the destination (to be listed for HR, not fetched). A Location that is a sign-in page is not requested
 * either: the file it asks for is in its `continue` parameter, which is all that is read from it.
 */
async function probe(url: string, method: 'HEAD' | 'GET', until: number): Promise<Probed> {
  const ms = Math.floor(until - Date.now());
  if (ms <= 0) return { fail: { outcome: 'failed', reason: REASON_OUT_OF_TIME } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    let current = url;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      await assertSafePublicUrl(current);
      const res = await fetch(current, { method, headers: { 'user-agent': HONEST_UA }, redirect: 'manual', signal: controller.signal });
      await discardBody(res);
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) return { finalUrl: current, status: res.status };

      let next: string;
      try { next = new URL(location, current).toString(); } catch { return { fail: { outcome: 'unreviewable', reason: REASON_BAD_REDIRECT } }; }
      const c = classifyAnswerUrl(next);
      if (c && c.handler === 'none') return { stopped: c };
      if (signInTarget(next)) return { finalUrl: next, status: res.status };
      current = next;
    }
    return { fail: { outcome: 'inaccessible', reason: 'The link redirects in a loop' } };
  } catch (e) {
    return { fail: failureOfError(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** If a redirect chain ended on a sign-in page, the page it was asking for (Google's `continue`), else null. */
function signInTarget(finalUrl: string): { target: string | null } | null {
  const u = parseUrl(finalUrl);
  if (!u || !SIGN_IN_HOSTS.some(h => onHost(hostOf(u), h))) return null;
  const next = u.searchParams.get('continue');
  return { target: next && parseUrl(next) ? next : null };
}

async function resolveShortLink(item: FetchItem, ctx: AcquireContext): Promise<ResolveResult> {
  // A link that is never opened is not requested even as the first hop (a link stored by an older classifier, say).
  const first = classifyAnswerUrl(item.link.url);
  if (first && first.handler === 'none') return { links: [toLink(first)] };

  const until = itemDeadline(ctx);
  let probed = await probe(item.link.url, 'HEAD', until);
  // Plenty of shorteners refuse HEAD (405/403/…); a GET (body cancelled unread) is the fallback.
  if ('fail' in probed || ('finalUrl' in probed && probed.status >= 400)) probed = await probe(item.link.url, 'GET', until);
  if ('fail' in probed) return unresolved(probed.fail);
  // The chain led somewhere that is never opened: it is reported as the link it is (handler 'none'), so it is listed
  // for HR with the others, and nothing was requested from it.
  if ('stopped' in probed) return { links: [toLink(probed.stopped)] };

  const signIn = signInTarget(probed.finalUrl);
  if (signIn && !signIn.target) return { links: [], reason: 'The short link leads to a sign-in page - the file is not shared publicly' };
  const finalUrl = signIn?.target ?? probed.finalUrl;

  const c = classifyAnswerUrl(finalUrl);
  if (!c) return { links: [], reason: 'The short link leads to a page that cannot be reviewed' };
  if (c.handler === 'resolve') {
    // Still on a short-link or hub address: either the service is having trouble (ours to retry), the link is dead, it
    // refused a machine, or it really does lead to another hop, which is not followed.
    if (probed.status === 429 || probed.status >= 500) throw new ResolveFailedError(`The short-link service had a temporary problem (error ${probed.status})`);
    if (probed.status === 404 || probed.status === 410) return { links: [], reason: `The short link no longer works (error ${probed.status})` };
    if (probed.status === 400 || probed.status === 403) return { links: [], reason: REASON_REFUSED };
    return { links: [], reason: 'The short link leads to another short link or link-in-bio page - only one level is followed' };
  }
  if (c.handler === 'none') {
    return { links: [], reason: c.platform === 'linkedin' ? REASON_LINKEDIN : 'The short link leads to a page that cannot be opened automatically' };
  }
  return { links: [toLink(c)] };
}

async function resolveHub(item: FetchItem, ctx: AcquireContext, hubHost: string): Promise<ResolveResult> {
  const got = await get(item.link.url, { maxBytes: HTML_CAP_BYTES, accept: HTML_ACCEPT, userAgent: HONEST_UA }, itemDeadline(ctx));
  if ('fail' in got) return unresolved(got.fail);
  if (got.res.tooLarge || !got.res.bytes) return { links: [], reason: 'The link-in-bio page is too large to read automatically' };

  const found = new Map<string, PortfolioLink>();
  for (const href of extractHubHrefs(got.res.bytes.toString('utf8'), hubHost)) {
    const c = classifyAnswerUrl(href);
    // 'none' = never opened (LinkedIn, …); 'resolve' = another hub or short link: only one level is ever followed.
    if (!c || c.handler === 'none' || c.handler === 'resolve' || found.has(c.key)) continue;
    found.set(c.key, toLink(c));
  }
  const links = [...found.values()].sort((a, b) => reviewRank(a) - reviewRank(b)).slice(0, MAX_HUB_LINKS);
  return links.length ? { links } : { links: [], reason: 'No links to reviewable work were found on the link-in-bio page' };
}

/**
 * Expands a short link (bit.ly, t.co, …) or a link-in-bio page (linktr.ee, …) into the work behind it, ONE level only:
 * the result is re-classified, and anything that is still a short link or a hub, or is never opened, is dropped.
 * Returns {links: [], reason} when nothing reviewable is behind it (including a link that is dead or private); throws
 * ResolveFailedError when our side failed. LinkedIn (and lnkd.in) are never requested. A short link that LEADS to a
 * never-opened destination (LinkedIn, other social, WeTransfer, Google Play, Looker Studio, Google Photos) is answered with that destination as the one link, handler
 * 'none': the walk stopped in front of it, so it is listed for HR and nothing was asked of it.
 */
export async function resolveLink(item: FetchItem, ctx: AcquireContext): Promise<ResolveResult> {
  const u = parseUrl(item.link.url);
  if (!u) return { links: [], reason: REASON_BAD_ADDRESS };
  if (isLinkedIn(item, u)) return { links: [], reason: REASON_LINKEDIN };
  const hub = HUB_HOSTS.find(h => onHost(hostOf(u), h));
  return hub ? resolveHub(item, ctx, hub) : resolveShortLink(item, ctx);
}
