// WORKER-ONLY (see ../browser.ts). The fetcher for the 'document' handler: PDFs, Word and PowerPoint files, Google
// Drive files / folders / Docs / Slides / Sheets, Dropbox and (personal) OneDrive links, and direct links to any of those.
//
// ANONYMOUS ONLY: a link is opened the way a stranger would open it — public export URLs through fetchCapped (so every
// hop is SSRF-checked) — never with the service account, which can read internal files a candidate must not be able
// to point at. A restricted file is simply "not reviewable".
//
// What a file REALLY is is decided from its bytes (sniffType), never from its URL or content-type: a Drive "view" link
// answers text/html, a hostile host can call anything image/png. Every outcome is a value, nothing here throws:
//   inaccessible = the candidate's link does not work for a stranger (held against them: they can re-share it)
//   failed       = OUR side broke (timeout, Google 429/5xx, dropped connection): retried, never held against them
//   unreviewable = nobody is at fault (bot wall, quota, archive, old Office format, size cap, injection)
//   partial      = read, but a cap cut it short — a cap is never a failure
import { wellFormed } from '../text.js';
import type { PortfolioLink } from '../types.js';
import { BUDGET } from './budget.js';
import { fetchCapped, isTimeoutError, sniffType } from './fetchCapped.js';
import type { CappedResult, SniffedType } from './fetchCapped.js';
import {
  FOLDER_LISTING_REASON, FOLDER_NOTHING_REASON, BOT_WALL_REASON, GOOGLE_BLOCKED_REASON, MAX_FOLDER_FILES, OPENED_A_PAGE_REASON,
  PRIVATE_LINK_REASON, TOO_LARGE_TO_SCAN_REASON, classifyDownloadPage, googleFetchUrl, isGoogleFileHost, parseFolderListing,
  parseGoogleUrl, quotaReason, rankFolderFiles,
} from './google.js';
import type { FolderEntry, GoogleKind, HostKind, PageKind } from './google.js';
import type { FetchItem } from './index.js';
import { ARCHIVE_REASON, LEGACY_OFFICE_REASON, detectOfficeKind, isLegacyOffice, prepareDocx, preparePptx, zipFailure } from './office.js';
import {
  BUDGET_REASON, SIZE_LIMIT_REASON, cleanText, injectionPrepared, preparePdf, reserveText, safeLabel, scanDocumentText, scanDocumentTextCooperatively, unread,
} from './pdf.js';
import type { Prepared } from './pdf.js';
import type { Acquired, AcquireContext, MediaBlock } from './types.js';

/**
 * Largest download we hold: the per-file read limit, for every type. (A PDF between 8 and 16 MB used to be taken and read as
 * text only; every byte of one is parsed by pdfjs, which has no caps of its own, so the limit now stops at the door.)
 */
const DOWNLOAD_MAX_BYTES = BUDGET.maxFileBytes;
const LISTING_MAX_BYTES = 1024 * 1024;
const LISTING_MS = 8_000;
/** Held back from the item's deadline so a partial result is returned before the orchestrator abandons the item. */
const SAFETY_MS = 1_000;
const MIN_FETCH_MS = 1_500;
const SHEET_MAX_CHARS = 6_000;
const SHEET_SNIFF_BYTES = 100_000;

const RAN_OUT_REASON = 'Ran out of time before this link could be opened';
const TIMEOUT_REASON = 'Could not be fetched (timeout)';
const CONNECT_REASON = 'Could not be downloaded right now (connection problem)';
const NOT_A_URL_REASON = 'This is not a valid web address';
const NOT_PUBLIC_REASON = 'The link is not a public web address';
const NO_SUCH_SITE_REASON = 'The website address does not exist';
const BAD_CERT_REASON = "The site's security certificate is not valid";
const REDIRECT_LOOP_REASON = 'The link redirects in a loop';
const REFUSED_REASON = 'The site did not allow automated access';
const NEEDS_SIGN_IN_REASON = 'This link needs a sign-in to open';
const CLOUD_UNSUPPORTED_REASON = 'This file-sharing service cannot be opened automatically';
const EMPTY_FILE_REASON = 'The file is empty';
const UNSUPPORTED_TYPE_REASON = 'This file type cannot be opened automatically';
const EMPTY_SHEET_REASON = 'The sheet is empty';

const inaccessible = (reason: string) => unread('inaccessible', reason);
const unreviewable = (reason: string) => unread('unreviewable', reason);
const failed = (reason: string) => unread('failed', reason);

// ─── turning a link into a request ───────────────────────────────────────────

const hostIs = (host: string, ...domains: string[]) => domains.some(d => host === d || host.endsWith(`.${d}`));

/** A Dropbox share link as a direct download: "?dl=0" (or no dl at all) becomes "dl=1". Nothing else is changed. */
export function dropboxDirectUrl(u: URL): string {
  const direct = new URL(u.toString());
  direct.hash = '';
  direct.searchParams.set('dl', '1');
  return direct.toString();
}

/** The public shares-API URL for a personal OneDrive link: "u!" + the link itself, base64url-encoded. */
export function oneDriveSharesUrl(u: URL): string {
  const link = new URL(u.toString());
  link.hash = '';
  const encoded = Buffer.from(link.toString(), 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `https://api.onedrive.com/v1.0/shares/u!${encoded}/root/content`;
}

type Plan =
  | { kind: 'stop'; part: Prepared }
  | { kind: 'folder'; target: { id: string; resourceKey?: string } }
  | { kind: 'download'; url: string; hostKind: HostKind; label: string; sheet: boolean };

const GOOGLE_LABEL: Record<GoogleKind, string> = {
  file: 'Google Drive file', doc: 'Google Doc (PDF export)', slides: 'Google Slides (PDF export)', sheet: 'Google Sheet', folder: 'Google Drive folder',
};

const stop = (part: Prepared): Plan => ({ kind: 'stop', part });

function planFor(link: PortfolioLink): Plan {
  let u: URL;
  try { u = new URL(link.url); } catch { return stop(unreviewable(NOT_A_URL_REASON)); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return stop(unreviewable(NOT_A_URL_REASON));
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.+$/, '');

  if (isGoogleFileHost(host)) {
    const parsed = parseGoogleUrl(u, link.platform);
    if (!parsed.ok) return stop(unreviewable(parsed.reason));
    const t = parsed.target;
    if (t.kind === 'folder') return { kind: 'folder', target: t };
    return { kind: 'download', url: googleFetchUrl(t), hostKind: 'google', label: GOOGLE_LABEL[t.kind], sheet: t.kind === 'sheet' };
  }
  if (hostIs(host, 'dropbox.com', 'dropboxusercontent.com')) {
    if (u.pathname === '/') return stop(unreviewable(CLOUD_UNSUPPORTED_REASON));
    return { kind: 'download', url: dropboxDirectUrl(u), hostKind: 'dropbox', label: 'Dropbox file', sheet: false };
  }
  if (host === '1drv.ms' || host === 'onedrive.live.com') {
    return { kind: 'download', url: oneDriveSharesUrl(u), hostKind: 'onedrive', label: 'OneDrive file', sheet: false };
  }
  if (hostIs(host, 'sharepoint.com', 'onedrive.com', 'office.com', 'office365.com', 'microsoft.com')) {
    return stop(unreviewable(NEEDS_SIGN_IN_REASON));
  }
  if (link.platform === 'cloud_file') return stop(unreviewable(CLOUD_UNSUPPORTED_REASON));
  u.hash = '';
  return { kind: 'download', url: u.toString(), hostKind: 'direct', label: 'Linked file', sheet: false };
}

// ─── reading what came back ──────────────────────────────────────────────────

const TLS_PROBLEM_RE = /\b(CERT_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_CERT_ALTNAME_INVALID|ERR_SSL_[A-Z_]+)\b/;

/**
 * An exception from fetchCapped as an outcome. A timeout or a dropped connection is OURS (failed). A dead domain,
 * an invalid certificate or a non-public address on a candidate's own host is THEIRS (inaccessible); the same lookup
 * failing for Google or Dropbox is ours.
 */
export function thrownPart(e: unknown, hostKind: HostKind): Prepared {
  if (isTimeoutError(e)) return failed(TIMEOUT_REASON);
  const message = e instanceof Error ? e.message : '';
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  if (/unsafe or unsupported URL|resolves to a private/.test(message)) return inaccessible(NOT_PUBLIC_REASON);
  if (/hostname does not resolve/.test(message)) return hostKind === 'direct' ? inaccessible(NO_SUCH_SITE_REASON) : failed(CONNECT_REASON);
  if (/too many redirects/.test(message)) return unreviewable(REDIRECT_LOOP_REASON);
  if (hostKind === 'direct' && TLS_PROBLEM_RE.test(`${typeof code === 'string' ? code : ''} ${message}`)) return inaccessible(BAD_CERT_REASON);
  return failed(CONNECT_REASON);
}

/**
 * A non-2xx answer as an outcome. On Google, Dropbox and OneDrive 400/401/403/404/410 mean "private or gone" (inaccessible);
 * on a candidate's own host only 401/404/410 do — a 400 or 403 there may be a bot wall or hot-link rule, which proves
 * nothing about the candidate (unreviewable, with a neutral reason: HR is never told to chase them for a machine's refusal).
 * 408, 429 and 5xx are OURS to retry (failed). A `cf-mitigated` header is a Cloudflare challenge whatever the status.
 * Exported so every fetcher classifies a status the same way.
 */
export function statusPart(status: number, headers: Record<string, string>, hostKind: HostKind): Prepared {
  if (headers['cf-mitigated']) return unreviewable(BOT_WALL_REASON);
  if (status === 404 || status === 410 || status === 401) return inaccessible(PRIVATE_LINK_REASON);
  if (status === 400 || status === 403) return hostKind === 'direct' ? unreviewable(REFUSED_REASON) : inaccessible(PRIVATE_LINK_REASON);
  if (status === 408 || status === 429 || status >= 500) return failed(`Could not be downloaded right now (HTTP ${status})`);
  return unreviewable(`The link could not be opened (HTTP ${status})`);
}

function pageKindPart(kind: PageKind, hostKind: HostKind): Prepared {
  switch (kind) {
    case 'private':           return inaccessible(PRIVATE_LINK_REASON);
    case 'quota':             return unreviewable(quotaReason(hostKind));
    case 'too_large_to_scan': return unreviewable(TOO_LARGE_TO_SCAN_REASON);
    case 'google_blocked':    return failed(GOOGLE_BLOCKED_REASON);
    case 'bot_wall':          return unreviewable(BOT_WALL_REASON);
    default:                  return unreviewable(OPENED_A_PAGE_REASON);
  }
}

const mbOrKb = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function prepareImage(bytes: Buffer, type: SniffedType, label: string, ctx: AcquireContext): Prepared {
  if (bytes.length > BUDGET.maxImageBytes) return unreviewable(SIZE_LIMIT_REASON);
  if (ctx.budget.reserveImages(1) < 1 || !ctx.budget.reserveBytes(bytes.length)) return unreviewable(BUDGET_REASON);
  const media: MediaBlock[] = [{
    kind: 'image', label: safeLabel(label, 120) || 'Image', mime: `image/${type}`, b64: bytes.toString('base64'), bytes: bytes.length,
  }];
  return { outcome: 'ok', media, text: '', facts: [`Image, ${type.toUpperCase()}, ${mbOrKb(bytes.length)}`], injectionHit: false };
}

/** The first tab of a Google Sheet as CSV text: at most SHEET_MAX_CHARS characters, text only. */
function prepareSheet(bytes: Buffer, ctx: AcquireContext): Prepared {
  if (bytes.subarray(0, 4096).includes(0)) return unreviewable(UNSUPPORTED_TYPE_REASON);
  const decoded = bytes.toString('utf8', 0, Math.min(bytes.length, SHEET_SNIFF_BYTES)).replace(/^﻿/, '');
  const raw = decoded.slice(0, SHEET_MAX_CHARS);
  if (scanDocumentText(raw)) return injectionPrepared();
  const cleaned = cleanText(raw);
  if (!cleaned) return unreviewable(EMPTY_SHEET_REASON);
  const { text, truncated } = reserveText(cleaned, ctx);
  if (!text) return unreviewable(BUDGET_REASON);
  const cut = truncated || decoded.length > SHEET_MAX_CHARS || bytes.length > SHEET_SNIFF_BYTES;
  return {
    outcome: cut ? 'partial' : 'ok',
    ...(cut ? { reason: `Only the first ${text.length.toLocaleString('en-US')} characters of the first tab were read` } : {}),
    media: [],
    text,
    facts: [`Sheet (first tab), ${text.length.toLocaleString('en-US')} characters read`],
    injectionHit: false,
  };
}

const looksLikeMarkup = (bytes: Buffer) => /<(?:!doctype|html|head|body|title)\b/.test(bytes.toString('latin1', 0, 2048).toLowerCase());

/** A web page where a file was expected: what it says (sign-in, quota, bot wall …) decides the outcome. */
const pagePart = (bytes: Buffer, finalUrl: string, hostKind: HostKind): Prepared =>
  pageKindPart(classifyDownloadPage(bytes.toString('utf8', 0, Math.min(bytes.length, 200_000)), { hostKind, finalUrl }), hostKind);

/** Decides what the bytes are and hands them to the right reader. */
async function readBytes(
  bytes: Buffer, finalUrl: string, spec: { hostKind: HostKind; label: string; sheet: boolean }, ctx: AcquireContext,
): Promise<Prepared> {
  const type = sniffType(bytes);
  switch (type) {
    case 'pdf':
      return preparePdf(bytes, spec.label, ctx);
    case 'zip': {
      let kind: 'docx' | 'pptx' | 'archive';
      try { kind = detectOfficeKind(bytes); } catch (e) { return zipFailure(e); }
      if (kind === 'docx') return prepareDocx(bytes, spec.label, ctx);
      if (kind === 'pptx') return preparePptx(bytes, spec.label, ctx);
      return unreviewable(ARCHIVE_REASON);
    }
    case 'png': case 'jpeg': case 'gif': case 'webp':
      return prepareImage(bytes, type, spec.label, ctx);
    case 'html':
      return pagePart(bytes, finalUrl, spec.hostKind);
    default:
      if (isLegacyOffice(bytes)) return unreviewable(LEGACY_OFFICE_REASON);
      if (looksLikeMarkup(bytes)) return pagePart(bytes, finalUrl, spec.hostKind);
      return spec.sheet ? prepareSheet(bytes, ctx) : unreviewable(UNSUPPORTED_TYPE_REASON);
  }
}

async function download(
  url: string, spec: { hostKind: HostKind; label: string; sheet: boolean }, ctx: AcquireContext,
): Promise<Prepared> {
  const left = ctx.deadline - Date.now();
  if (left < MIN_FETCH_MS) return failed(RAN_OUT_REASON);
  let r: CappedResult;
  try {
    r = await fetchCapped(url, { maxBytes: DOWNLOAD_MAX_BYTES, timeoutMs: Math.min(BUDGET.perItemMs, left) });
  } catch (e) {
    return thrownPart(e, spec.hostKind);
  }
  if (r.tooLarge) return unreviewable(SIZE_LIMIT_REASON);
  if (!r.ok) return statusPart(r.status, r.headers, spec.hostKind);
  if (!r.bytes) return failed(CONNECT_REASON);
  if (r.bytes.length === 0) return unreviewable(EMPTY_FILE_REASON);
  try {
    return await readBytes(r.bytes, r.finalUrl, spec, ctx);
  } catch {
    // A reader that throws is our bug, not the candidate's: say so for this file instead of losing a whole folder.
    return failed('Could not be read (unexpected error)');
  }
}

// ─── folders ─────────────────────────────────────────────────────────────────

const usable = (p: Prepared) => p.media.length > 0 || p.text.trim() !== '';
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * One result for a whole folder. A file whose text aims at an AI reviewer holds back the entire folder for a human
 * (the others sit in the same link); otherwise media and text are concatenated, facts are kept per file, and the
 * outcome is 'ok' only when every file was fully read and none was left out by the file cap.
 */
function mergeFolder(parts: Prepared[], picks: FolderEntry[], eligible: number): Prepared {
  if (parts.some(p => p.injectionHit)) return injectionPrepared();

  const opened = parts.filter(usable);
  if (!opened.length) {
    const ours = parts.find(p => p.outcome === 'failed');
    if (ours) return failed(ours.reason ?? CONNECT_REASON);
    if (parts.every(p => p.outcome === 'inaccessible')) return inaccessible(parts[0].reason ?? PRIVATE_LINK_REASON);
    return unreviewable(parts.find(p => p.outcome === 'unreviewable')?.reason ?? FOLDER_NOTHING_REASON);
  }

  // The 12K-per-item text cap is shared out evenly: file 1 must not be able to crowd files 2-4 out of the text.
  const share = Math.floor(BUDGET.maxCharsPerItem / opened.length);
  let cutText = false;
  const sections: string[] = [];
  const facts = [`Folder: ${opened.length} of ${eligible} files read`];
  const titles: string[] = [];
  parts.forEach((p, i) => {
    const n = i + 1;
    if (!usable(p)) {
      facts.push(`File ${n}: not read${p.reason ? ` (${p.reason})` : ''}`);
      return;
    }
    for (const f of p.facts) facts.push(`File ${n}: ${f}`);
    const title = safeLabel(picks[i].title, 80);
    if (title) titles.push(title);
    if (p.text) {
      const text = p.text.length > share ? wellFormed(p.text.slice(0, share)) : p.text;
      if (text.length < p.text.length) cutText = true;
      sections.push(`=== File ${n}${title ? `: ${title}` : ''} ===\n${text}`);
    }
  });

  const why: string[] = [];
  if (eligible > picks.length) why.push(`only ${picks.length} of ${eligible} files in the folder were opened`);
  if (parts.length > opened.length) why.push(`${plural(parts.length - opened.length, 'file')} could not be read`);
  if (opened.some(p => p.outcome !== 'ok')) why.push('some files were only partly read');
  if (cutText) why.push('their text was shortened to fit');

  const pagesReviewed = opened.reduce((sum, p) => sum + (p.pagesReviewed ?? 0), 0);
  return {
    outcome: why.length ? 'partial' : 'ok',
    ...(why.length ? { reason: `Only part of this folder was read: ${why.join('; ')}` } : {}),
    media: opened.flatMap(p => p.media),
    text: sections.join('\n\n'),
    facts,
    injectionHit: false,
    ...(pagesReviewed ? { pagesReviewed } : {}),
    ...(titles.length ? { pageTitles: titles } : {}),
  };
}

async function readFolder(target: { id: string; resourceKey?: string }, ctx: AcquireContext): Promise<Prepared> {
  const left = ctx.deadline - Date.now();
  if (left < MIN_FETCH_MS) return failed(RAN_OUT_REASON);
  let r: CappedResult;
  try {
    r = await fetchCapped(googleFetchUrl({ kind: 'folder', ...target }), {
      maxBytes: LISTING_MAX_BYTES, timeoutMs: Math.min(LISTING_MS, left), accept: 'text/html',
    });
  } catch (e) {
    return thrownPart(e, 'google');
  }
  if (r.tooLarge) return unreviewable(FOLDER_LISTING_REASON);
  if (!r.ok) return statusPart(r.status, r.headers, 'google');
  if (!r.bytes) return failed(CONNECT_REASON);

  const html = r.bytes.toString('utf8');
  const entries = parseFolderListing(html);
  if (!entries.length) {
    // A listing we cannot read is "not available" unless the page says why (sign-in, quota, our own block …).
    const kind = classifyDownloadPage(html, { hostKind: 'google', finalUrl: r.finalUrl });
    return kind === 'unknown' ? unreviewable(FOLDER_LISTING_REASON) : pageKindPart(kind, 'google');
  }

  const ranked = rankFolderFiles(entries);
  if (!ranked.length) return unreviewable(FOLDER_NOTHING_REASON);
  const picks = ranked.slice(0, MAX_FOLDER_FILES);
  // File names are the candidate's text, and they reach the model (as section headers inside the untrusted block).
  for (const p of picks) if (await scanDocumentTextCooperatively(p.title)) return injectionPrepared();

  const parts = await Promise.all(picks.map((p, i) => download(
    googleFetchUrl({ kind: p.kind, id: p.id }),
    { hostKind: 'google', label: `Folder file ${i + 1}`, sheet: p.kind === 'sheet' },
    ctx,
  )));
  return mergeFolder(parts, picks, ranked.length);
}

// ─── the fetcher ─────────────────────────────────────────────────────────────

/**
 * The 'document' handler. Never throws and never reads past the item's deadline: it works to `ctx.deadline` minus one
 * second so a partial result (the files of a folder that did arrive) is returned before the orchestrator gives up on it.
 */
export async function fetchDocument(item: FetchItem, ctx: AcquireContext): Promise<Acquired> {
  const inner: AcquireContext = { ...ctx, deadline: ctx.deadline - SAFETY_MS };
  let part: Prepared;
  try {
    const plan = planFor(item.link);
    if (plan.kind === 'stop') part = plan.part;
    else if (plan.kind === 'folder') part = await readFolder(plan.target, inner);
    else part = await download(plan.url, plan, inner);
  } catch {
    part = failed('Could not be fetched (unexpected error)');
  }
  return { ref: item.ref, link: item.link, basis: 'artifact', ...part };
}
