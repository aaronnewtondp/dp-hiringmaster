// WORKER-ONLY (see ../browser.ts). Everything specific to links on Google Drive / Docs / Slides / Sheets, plus the
// classification of the web pages that come back when a "download" is not a file. All of it is ANONYMOUS: candidate links are
// opened as a stranger would open them, with public export URLs and never with the service account (a candidate could
// otherwise point at an internal file and have it summarised into a review hiring managers can read).
//
// The one rule that makes the URLs safe: an id is taken from the candidate's link, checked against GOOGLE_ID_RE, and only
// then placed into a URL built here on a fixed Google host. Nothing else of the candidate's URL is ever reused.
import type { PortfolioPlatform } from '../types.js';
import { decodeEntities } from './pdf.js';

export const GOOGLE_ID_RE = /^[A-Za-z0-9_-]{10,}$/;
const MAX_GOOGLE_ID_LENGTH = 200;

// Google, Dropbox and OneDrive answer 400/401/403/404/410 for "private", "deleted" and "this machine is not allowed" alike, so
// the wording claims no more than we know and says what the candidate can do about any of them.
export const PRIVATE_LINK_REASON = 'Link is private, deleted or does not allow automated access - ask the candidate to check that anyone with the link can view it';
export const TOO_LARGE_TO_SCAN_REASON = 'File too large to open automatically';
export const BOT_WALL_REASON = 'The site blocks automated access, so this link could not be opened';
export const GOOGLE_BLOCKED_REASON = 'Google temporarily blocked our automated download';
export const OPENED_A_PAGE_REASON = 'The link opened a web page instead of a file';
export const FOLDER_LISTING_REASON = 'Folder listing not available';
export const FOLDER_NOTHING_REASON = 'The folder has nothing that can be opened automatically (only videos, archives, subfolders or other file types)';
const PUBLISHED_REASON = 'A Google file "published to the web" is a web page, not a file, so it is not opened';
const UNSUPPORTED_GOOGLE_REASON = 'This kind of Google link (a form, a drawing or a Drive home page) is not opened';
const BAD_ID_REASON = 'This Google link does not contain a valid file id';

export function quotaReason(host: HostKind): string {
  return host === 'dropbox' ? 'Dropbox limited downloads of this file' : 'Google limited downloads of this file';
}

export type GoogleKind = 'file' | 'doc' | 'slides' | 'sheet' | 'folder';
/** `resourceKey` is the extra secret older link-shared files need ("?resourcekey=0-…"); without it they answer 404. */
export interface GoogleTarget { kind: GoogleKind; id: string; resourceKey?: string }
export type ParsedGoogleLink = { ok: true; target: GoogleTarget } | { ok: false; reason: string };
/** Who serves the link; decides how an HTTP failure is read (a 404 from Google or Dropbox means "private or gone"). */
export type HostKind = 'google' | 'dropbox' | 'onedrive' | 'direct';

const GOOGLE_FILE_HOSTS = new Set(['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com']);

/** Hosts that serve Drive/Docs files (a leading "www." is ignored). */
export function isGoogleFileHost(host: string): boolean {
  return GOOGLE_FILE_HOSTS.has(host.toLowerCase().replace(/^www\./, ''));
}

export function isGoogleId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= MAX_GOOGLE_ID_LENGTH && GOOGLE_ID_RE.test(id);
}

const RESOURCE_KEY_RE = /^[A-Za-z0-9_-]{3,100}$/;

// Every shape of Drive / Docs link the people filling in the form really paste. Any number of account segments may sit in
// front of the path, in either order — "/u/0" (the browser's signed-in-account switcher) and "/a/acme.com" (a Workspace
// domain) — and "/u/N" may also sit inside it:
//   docs.google.com/document/d/ID, …/document/u/0/d/ID, …/a/acme.com/document/d/ID, …/u/0/a/acme.com/spreadsheets/d/ID
//   drive.google.com/file/d/ID, …/file/u/0/d/ID, …/a/acme.com/file/d/ID
//   drive.google.com/drive/folders/ID, …/drive/u/0/folders/ID, …/drive/mobile/folders/ID, …/a/acme.com/drive/folders/ID
// Each segment is tried one way only (u/ or a/ or the keyword), so none of these can backtrack on a hostile path.
const ACCOUNT = String.raw`(?:(?:u\/\d+|a\/[^/]+)\/)*`;
const WORKSPACE_RE = new RegExp(String.raw`^\/${ACCOUNT}(document|presentation|spreadsheets)\/(?:u\/\d+\/)?d\/([^/?#]+)`);
const FILE_RE = new RegExp(String.raw`^\/${ACCOUNT}file\/(?:u\/\d+\/)?d\/([^/?#]+)`);
const FOLDER_RE = new RegExp(String.raw`^\/${ACCOUNT}(?:drive\/(?:(?:u\/\d+|a\/[^/]+|mobile)\/)*)?folders\/([^/?#]+)`);
/** The leading "/u/N" and "/a/domain" segments of a path, to be dropped before looking the path up in ID_QUERY_PATHS. */
const ACCOUNT_PREFIX_RE = /^(?:\/(?:u\/\d+|a\/[^/]+))+(?=\/)/;
// Links that carry the id in the query: "open?id=", "uc?id=", "folderview?id=" (with or without an account prefix).
const ID_QUERY_PATHS = new Set(['/open', '/uc', '/download', '/folderview']);
/** A path without trailing slashes (a loop, so a long run of them cannot cost more than its length). */
function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end--;
  return path.slice(0, end);
}
const WORKSPACE_KIND: Record<string, GoogleKind> = { document: 'doc', presentation: 'slides', spreadsheets: 'sheet' };
const PLATFORM_KIND: Partial<Record<PortfolioPlatform, GoogleKind>> = {
  gdrive_folder: 'folder', google_doc: 'doc', google_slides: 'slides', google_sheet: 'sheet',
};

/**
 * What a Google link points at, and its id. `platform` only breaks the tie for "open?id=ID" links, which say nothing
 * about the type; every other form says it in its path. Fails (with a reason for HR) on an id that is not 10+ of
 * letters, digits, "_" and "-" — which is also what rejects "../.." and percent-encoded tricks — and on kinds we
 * do not open (forms, drawings, "published to the web" pages, the Drive home page).
 */
export function parseGoogleUrl(u: URL, platform?: PortfolioPlatform): ParsedGoogleLink {
  const path = u.pathname;
  let kind: GoogleKind;
  let rawId: string | null;

  const workspace = WORKSPACE_RE.exec(path);
  const file = workspace ? null : FILE_RE.exec(path);
  const folder = workspace || file ? null : FOLDER_RE.exec(path);
  if (workspace) {
    kind = WORKSPACE_KIND[workspace[1]];
    rawId = workspace[2];
    if (rawId === 'e') return { ok: false, reason: PUBLISHED_REASON };   // /d/e/2PACX-… is a published web page
  } else if (file) {
    kind = 'file';
    rawId = file[1];
  } else if (folder) {
    kind = 'folder';
    rawId = folder[1];
  } else {
    const queryPath = withoutTrailingSlashes(path.replace(ACCOUNT_PREFIX_RE, ''));
    if (!ID_QUERY_PATHS.has(queryPath)) return { ok: false, reason: UNSUPPORTED_GOOGLE_REASON };
    kind = queryPath === '/folderview' ? 'folder' : (platform && PLATFORM_KIND[platform]) || 'file';
    rawId = u.searchParams.get('id');
  }
  if (!isGoogleId(rawId)) return { ok: false, reason: BAD_ID_REASON };
  const key = u.searchParams.get('resourcekey');
  return { ok: true, target: { kind, id: rawId, ...(key && RESOURCE_KEY_RE.test(key) ? { resourceKey: key } : {}) } };
}

/**
 * The public URL that returns this target as a file: a plain download, a PDF export (Docs, Slides), CSV of the first tab
 * (Sheets), or the folder's embedded listing page. Throws on an id that is not valid, so a hand-built target cannot
 * smuggle a path into the URL either.
 */
export function googleFetchUrl(t: GoogleTarget): string {
  if (!isGoogleId(t.id)) throw new Error('invalid Google id');
  const key = t.resourceKey && RESOURCE_KEY_RE.test(t.resourceKey) ? t.resourceKey : null;
  switch (t.kind) {
    case 'file':   return `https://drive.google.com/uc?export=download&id=${t.id}${key ? `&resourcekey=${key}` : ''}`;
    case 'doc':    return `https://docs.google.com/document/d/${t.id}/export?format=pdf${key ? `&resourcekey=${key}` : ''}`;
    case 'slides': return `https://docs.google.com/presentation/d/${t.id}/export/pdf${key ? `?resourcekey=${key}` : ''}`;
    case 'sheet':  return `https://docs.google.com/spreadsheets/d/${t.id}/export?format=csv${key ? `&resourcekey=${key}` : ''}`;
    case 'folder': return `https://drive.google.com/embeddedfolderview?id=${t.id}${key ? `&resourcekey=${key}` : ''}`;
  }
}

// ─── what a returned web page means ──────────────────────────────────────────

export type PageKind = 'private' | 'quota' | 'too_large_to_scan' | 'google_blocked' | 'bot_wall' | 'unknown';

const QUOTA_PHRASES = [
  'too many users have viewed or downloaded', 'download quota exceeded', 'quota exceeded for this file',
  'generating too much traffic',                                  // Dropbox's "links temporarily disabled" page
];
const VIRUS_SCAN_PHRASES = ["can't scan this file for viruses", 'virus scan warning', 'download anyway'];
const GOOGLE_BLOCKED_PHRASES = ['our systems have detected unusual traffic', 'unusual traffic from your computer network'];
const GOOGLE_PRIVATE_PHRASES = [
  'you need access', 'you need permission', 'request access',
  'sorry, the file you have requested does not exist', 'sorry, unable to open the file at this time',
  'error 404 (not found)', 'the requested url was not found on this server',
  'servicelogin', 'sign in - google accounts',
];
const DROPBOX_PRIVATE_PHRASES = [
  'this item might have been deleted', 'error (404)', "we can't find the page", 'sign in or create an account',
  'this link has been disabled', 'this link is no longer available',
];
const BOT_WALL_PHRASES = [
  'just a moment...', '_cf_chl', 'cf-browser-verification', 'cf-challenge', 'cdn-cgi/challenge-platform', 'px-captcha',
  'hcaptcha', 'attention required! | cloudflare', 'checking your browser before accessing', 'enable javascript and cookies to continue',
];
const AKAMAI_REFERENCE_RE = /reference #\d+\.[0-9a-f]+/;
const SIGN_IN_TITLE_RE = /<title[^>]*>\s*(?:sign in|log in|login)\b/;

const hasAny = (haystack: string, phrases: string[]) => phrases.some(p => haystack.includes(p));

/**
 * What an HTML body means when we asked for a file. Matched on lower-cased text of the first 200 KB — wording, not
 * structure, because Google and Dropbox change their markup constantly. 'unknown' is the safe answer for anything not
 * recognised: it ends as a neutral "opened a web page instead of a file", never as a verdict on the candidate.
 *  - private: a sign-in page, "You need access", "Request access", or a 404 page (the candidate must re-share).
 *  - quota / too_large_to_scan: Drive limited this file's downloads / will not scan a file this big.
 *  - google_blocked: Google refused OUR requests ("unusual traffic") — our side, retried.
 *  - bot_wall: a Cloudflare / captcha / Akamai challenge. Nobody's fault.
 */
export function classifyDownloadPage(html: string, o: { hostKind: HostKind; finalUrl?: string }): PageKind {
  const page = html.slice(0, 200_000).toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
  let finalHost = '';
  let finalPath = '';
  try {
    const u = new URL(o.finalUrl ?? '');
    finalHost = u.hostname.toLowerCase();
    finalPath = u.pathname.toLowerCase();
  } catch { /* no usable final URL */ }

  if (o.hostKind === 'google') {
    if (hasAny(page, QUOTA_PHRASES)) return 'quota';
    if (hasAny(page, VIRUS_SCAN_PHRASES)) return 'too_large_to_scan';
    if (hasAny(page, GOOGLE_BLOCKED_PHRASES) || finalPath.startsWith('/sorry/')) return 'google_blocked';
    if (finalHost === 'accounts.google.com' || SIGN_IN_TITLE_RE.test(page) || hasAny(page, GOOGLE_PRIVATE_PHRASES)) return 'private';
  } else if (o.hostKind === 'dropbox') {
    if (hasAny(page, QUOTA_PHRASES)) return 'quota';
    if (finalPath === '/login' || finalPath.startsWith('/login/') || SIGN_IN_TITLE_RE.test(page) || hasAny(page, DROPBOX_PRIVATE_PHRASES)) return 'private';
  }
  if (hasAny(page, BOT_WALL_PHRASES) || (page.includes('access denied') && AKAMAI_REFERENCE_RE.test(page))) return 'bot_wall';
  return 'unknown';
}

// ─── folders ─────────────────────────────────────────────────────────────────

export const MAX_FOLDER_FILES = 4;
const MAX_FOLDER_ENTRIES = 100;
const FOLDER_HTML_LIMIT = 600_000;

export interface FolderEntry { id: string; title: string; kind: GoogleKind }

// Bounded repeats everywhere: this runs on a page we do not control.
const ANCHOR_RE = /<a\b[^>]{0,2000}?\bhref\s*=\s*"([^"]{1,600})"[^>]{0,2000}>([\s\S]{0,800}?)<\/a>/gi;
const TITLE_DIV_RE = /class="flip-entry-title"[^>]*>([^<]{0,300})</i;
const ENTRY_DIV_RE = /id="entry-([A-Za-z0-9_-]{10,200})"[\s\S]{0,1500}?class="flip-entry-title"[^>]*>([^<]{0,300})</gi;

function entryFromHref(href: string): { id: string; kind: GoogleKind } | null {
  let u: URL;
  try { u = new URL(href); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.hostname !== 'drive.google.com' && u.hostname !== 'docs.google.com') return null;
  const parsed = parseGoogleUrl(u);
  return parsed.ok ? parsed.target : null;
}

const tidyTitle = (raw: string) => decodeEntities(raw.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * The files listed on a folder's public embedded page (https://drive.google.com/embeddedfolderview?id=ID): their ids,
 * titles and kinds, in page order, without duplicates. Subfolders are returned with kind 'folder' (never opened).
 * Titles are the candidate's text: callers must treat them as untrusted. [] when nothing could be parsed.
 */
export function parseFolderListing(html: string): FolderEntry[] {
  const page = html.length > FOLDER_HTML_LIMIT ? html.slice(0, FOLDER_HTML_LIMIT) : html;
  const out: FolderEntry[] = [];
  const seen = new Set<string>();
  const add = (id: string, title: string, kind: GoogleKind) => {
    if (out.length >= MAX_FOLDER_ENTRIES || seen.has(id)) return;
    seen.add(id);
    out.push({ id, title, kind });
  };

  ANCHOR_RE.lastIndex = 0;
  for (const m of page.matchAll(ANCHOR_RE)) {
    const target = entryFromHref(decodeEntities(m[1]));
    if (!target) continue;
    const inner = m[2];
    add(target.id, tidyTitle(TITLE_DIV_RE.exec(inner)?.[1] ?? inner), target.kind);
  }
  if (out.length) return out;

  // Older layout: the entry id is on the wrapping div and the title sits further down.
  ENTRY_DIV_RE.lastIndex = 0;
  for (const m of page.matchAll(ENTRY_DIV_RE)) add(m[1], tidyTitle(m[2]), 'file');
  return out;
}

// What a file in a folder is worth opening, by type (pdf first: it carries the most of a campaign), and the file
// extensions that can be opened at all. Anything else — video, archives, design sources, legacy Office — is never fetched.
const EXTENSION_SCORE: Record<string, number> = { pdf: 100, pptx: 90, docx: 70, png: 40, jpg: 40, jpeg: 40, webp: 40, gif: 40 };
const GOOGLE_KIND_SCORE: Partial<Record<GoogleKind, number>> = { slides: 85, doc: 70, sheet: 20 };
const NAME_HINT_RE = /\b(?:case stud(?:y|ies)|campaigns?|deck|portfolio|work)\b/;
const NAME_HINT_BOOST = 25;
const UNKNOWN_TYPE_SCORE = 10;

function entryScore(e: FolderEntry): number | null {
  let base: number | undefined;
  if (e.kind === 'file') {
    const ext = /\.([a-z0-9]{1,5})$/i.exec(e.title.trim())?.[1]?.toLowerCase();
    base = ext === undefined ? UNKNOWN_TYPE_SCORE : EXTENSION_SCORE[ext];
  } else {
    base = GOOGLE_KIND_SCORE[e.kind];
  }
  if (base === undefined) return null;
  return base + (NAME_HINT_RE.test(e.title.toLowerCase().replace(/[_.\-]+/g, ' ')) ? NAME_HINT_BOOST : 0);
}

/**
 * Every file of a folder worth opening, best first: pdf, pptx, Google Slides, docx / Google Docs, then images, then
 * Sheets; a name saying "case study", "campaign", "deck", "portfolio" or "work" moves a file up. No recursion — subfolders
 * are left out. The caller takes the first MAX_FOLDER_FILES.
 */
export function rankFolderFiles(entries: FolderEntry[]): FolderEntry[] {
  return entries
    .map((e, i) => ({ e, i, score: entryScore(e) }))
    .filter((x): x is { e: FolderEntry; i: number; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.e);
}
