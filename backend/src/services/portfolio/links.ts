import { PortfolioLink, PortfolioPlatform } from './types.js';

// ─── Pure link extraction / classification ───────────────────────────────────
// Deliberately free of any Drive/PDF/browser dependency so it is trivially
// unit-testable and safe to import from the main API bundle.

// No real URL in a resume is anywhere near this long. The cap matters for
// safety, not just tidiness: the trailing-punctuation trim used to be a `+$`
// regex, which is quadratic on a long run of punctuation — one hostile 100 KB
// "URL" in a resume froze the API process for ~15 seconds.
const MAX_URL_LENGTH = 2048;
const TRAILING_CHARS = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '`', '>', ']', '}']);

// Hosts that are never a design portfolio — social, code hosting, messaging,
// the company's own site, and Google Forms/Docs boilerplate.
const NOISE_HOST = /(^|\.)(linkedin\.com|lnkd\.in|github\.com|gitlab\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com|youtu\.be|wa\.me|whatsapp\.com|t\.me|telegram\.me|digitalpaani\.com|forms\.gle|goo\.gl|bit\.ly|tinyurl\.com|t\.co|maps\.google\.com|calendly\.com|zoom\.us)$/i;

// Known portfolio-hosting domains that people frequently write without a
// scheme ("figma.com/proto/...", "name.framer.website") — these are matched
// bare, so a plain-text URL typed without "https://" is not missed.
const BARE_PORTFOLIO_RE = /(?<![@\w.\-/])((?:[a-z0-9-]+\.)*(?:figma\.com|figma\.site|framer\.(?:website|app|ai|com)|behance\.net|dribbble\.com|wixsite\.com|editorx\.io|notion\.site|adobeportfolio\.com|myportfolio\.com|webflow\.io|carrd\.co|cargo\.site|squarespace\.com|medium\.com)(?:\/[^\s<>"'`)\]]*)?)/gi;

const SCHEME_URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const WWW_RE = /(?<![@\w.\-/])(www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"'`)\]]*)?)/gi;
// "Portfolio: janedoe.design" — a bare custom domain is only trusted when a
// label introduces it; otherwise it is indistinguishable from a filename.
const LABELLED_RE = /\b(?:portfolio|website|web\s*site|my\s*site|work|case\s*stud(?:y|ies)|url|link)\s*[:\-–|]\s*((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"'`)\]]*)?)/gi;

export function normalizeUrl(raw: string): string | null {
  if (!raw || raw.length > MAX_URL_LENGTH * 2) return null;
  let s = raw.trim().replace(/^[<(\["'`]+/, '');
  if (!s || /^(mailto|tel|javascript|data|file|ftp):/i.test(s)) return null;
  // Strip trailing sentence punctuation (linear), and an unbalanced trailing ")".
  let end = s.length;
  while (end > 0 && TRAILING_CHARS.has(s[end - 1])) end--;
  s = s.slice(0, end);
  while (s.endsWith(')') && (s.match(/\(/g) || []).length < (s.match(/\)/g) || []).length) s = s.slice(0, -1);
  if (s.length > MAX_URL_LENGTH) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname.includes('.') || /\s/.test(u.hostname)) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  // Drop a lone trailing slash on the bare origin so "x.com" == "x.com/".
  const out = u.toString();
  return u.pathname === '/' && !u.search ? out.replace(/\/$/, '') : out;
}

export function extractUrlsFromText(text: string): string[] {
  if (!text) return [];
  if (text.length > 400_000) text = text.slice(0, 400_000);   // a resume is never this long; bound the work anyway
  const found: string[] = [];
  for (const re of [SCHEME_URL_RE, BARE_PORTFOLIO_RE, WWW_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) found.push(m[1] ?? m[0]);
  }
  LABELLED_RE.lastIndex = 0;
  for (const m of text.matchAll(LABELLED_RE)) found.push(m[1]);
  return found;
}

export function classifyUrl(url: string): (PortfolioLink & { kind: 'portfolio' | 'noise' }) | null {
  const norm = normalizeUrl(url);
  if (!norm) return null;
  const u = new URL(norm);
  const host = u.hostname.replace(/^www\./, '');
  const path = u.pathname.toLowerCase();
  const mk = (platform: PortfolioPlatform, kind: 'portfolio' | 'noise' = 'portfolio') => ({ url: norm, host, platform, kind });

  if (NOISE_HOST.test(host)) return mk('custom', 'noise');
  if (host === 'docs.google.com' && path.startsWith('/presentation')) return mk('google_slides');
  if (host === 'sites.google.com') return mk('custom');
  if (/(^|\.)google\.com$/.test(host) && !host.startsWith('drive.')) return mk('custom', 'noise');
  if (host === 'drive.google.com') return mk('pdf_file');
  if (/\.pdf$/.test(path)) return mk('pdf_file');
  if (/(^|\.)figma\.site$/.test(host)) return mk('figma_site');
  if (/(^|\.)figma\.com$/.test(host)) return mk('figma_file');
  if (/(^|\.)framer\.(website|app|ai|com)$/.test(host)) return mk('framer');
  if (/(^|\.)behance\.net$/.test(host)) return mk('behance');
  if (/(^|\.)(wixsite\.com|wix\.com|editorx\.io)$/.test(host)) return mk('wix');
  if (/(^|\.)dribbble\.com$/.test(host)) return mk('dribbble');
  if (/(^|\.)(notion\.site|notion\.so)$/.test(host)) return mk('notion');
  if (/(^|\.)(adobeportfolio\.com|myportfolio\.com)$/.test(host)) return mk('adobe_portfolio');
  if (/(^|\.)webflow\.io$/.test(host)) return mk('webflow');
  if (/(^|\.)squarespace\.com$/.test(host)) return mk('squarespace');
  if (/(^|\.)carrd\.co$/.test(host)) return mk('carrd');
  if (/(^|\.)(cargo\.site|cargocollective\.com)$/.test(host)) return mk('cargo');
  return mk('custom');
}

// Lower rank = analyzed first. Real HTML sites (custom domain / Framer /
// Webflow / Figma Sites) first because they carry the richest evidence and
// are what the hiring manager prefers; then template builders; then
// gallery-style platforms; the un-crawlable canvas/PDF cases last.
const PLATFORM_RANK: Record<PortfolioPlatform, number> = {
  custom: 0, framer: 0, webflow: 0, figma_site: 0,
  wix: 1, squarespace: 1, carrd: 1, cargo: 1, adobe_portfolio: 1,
  behance: 2, dribbble: 2, notion: 2,
  figma_file: 3, google_slides: 3, pdf_file: 3,
};
const MULTI_PER_HOST: ReadonlySet<PortfolioPlatform> = new Set(['behance', 'dribbble', 'notion']);

export interface LinkInput { url: string; label?: string }

/** Scheme-, www- and trailing-slash-insensitive identity, so http/https twins collapse. */
export function dedupeKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${u.search}`.toLowerCase();
  } catch { return url.toLowerCase(); }
}

// Real hyperlink destinations first (with the visible label when known),
// then URLs found in the plain text — normalized and de-duplicated.
export function mergeResumeLinks(structural: LinkInput[], textUrls: string[]): LinkInput[] {
  const out: LinkInput[] = [];
  const seen = new Map<string, number>();
  const add = (raw: string, label?: string) => {
    const n = normalizeUrl(raw);
    if (!n) return;
    const key = dedupeKey(n);
    const at = seen.get(key);
    if (at !== undefined) { if (label && !out[at].label) out[at].label = label; return; }
    seen.set(key, out.length);
    out.push({ url: n, ...(label ? { label } : {}) });
  };
  for (const l of structural) add(l.url, l.label);
  for (const u of textUrls) add(u);
  return out;
}

// ─── Deciding which custom-domain links are actually the candidate's portfolio ─
// Known platforms (Behance, Framer, ...) are self-evident. An arbitrary domain
// is the hard case: the same resume also links employers, universities, SSO
// pages and resume builders. Cheap, transparent signals rather than guessing.
const COMMON_NAME_TOKENS = new Set(['kumar', 'singh', 'sharma', 'gupta', 'verma', 'khan', 'patel', 'shah', 'mohd', 'mohammed', 'jain', 'yadav', 'agarwal', 'mishra', 'reddy']);
const INSTITUTION_HOST = /(\.ac\.[a-z]{2,3}|\.edu(\.[a-z]{2,3})?|\.gov(\.[a-z]{2,3})?|\.nic\.in)$/i;
const RESUME_BUILDER_HOST = /(^|\.)(enhancv\.com|zety\.com|novoresume\.com|resume\.io|resumegenius\.com|kickresume\.com|flowcv\.com|myperfectresume\.com|livecareer\.com|naukri\.com|indeed\.com|glassdoor\.com|cutshort\.io|wellfound\.com)$/i;
const APP_PATH = /\/(login|signin|sign-in|sso|auth|oauth|dashboard|admin|account|portal)(\/|$)/i;
const APP_HOST = /^(sso|login|auth|app|accounts|portal|admin|my)\./i;
const PORTFOLIO_LABEL = /(portfolio|website|web\s*site|case\s*stud|my\s*work|works?\b|behance|dribbble|projects?)/i;

export function nameTokens(fullName?: string): string[] {
  return (fullName || '').toLowerCase().split(/[^a-z]+/).filter(t => t.length >= 4 && !COMMON_NAME_TOKENS.has(t));
}

/** Positive = looks like the candidate's own site; <= -3 = certainly not a portfolio. */
export function customLinkScore(link: PortfolioLink, label: string | undefined, tokens: string[]): number {
  let score = 0;
  const host = link.host;
  if (net_isIp(host) || INSTITUTION_HOST.test(host) || RESUME_BUILDER_HOST.test(host)) score -= 4;
  let path = '';
  try { path = new URL(link.url).pathname; } catch { /* keep '' */ }
  if (APP_PATH.test(path) || APP_HOST.test(host)) score -= 3;
  const compactHost = host.replace(/[^a-z]/g, '');
  if (tokens.some(t => compactHost.includes(t))) score += 3;
  if (label && PORTFOLIO_LABEL.test(label)) score += 2;
  return score;
}

function net_isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

export function pickPortfolioLinks(
  inputs: Array<string | LinkInput>, max = 3, ctx: { candidateName?: string } = {},
): PortfolioLink[] {
  const tokens = nameTokens(ctx.candidateName);
  const seen = new Set<string>();
  const classified: Array<PortfolioLink & { depth: number; score: number }> = [];
  for (const input of inputs) {
    const raw = typeof input === 'string' ? input : input.url;
    const label = typeof input === 'string' ? undefined : input.label;
    const c = classifyUrl(raw);
    if (!c || c.kind === 'noise') continue;
    const key = dedupeKey(c.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const base = { url: c.url, host: c.host, platform: c.platform };
    const score = c.platform === 'custom' ? customLinkScore(base, label, tokens) : (label && PORTFOLIO_LABEL.test(label) ? 1 : 0);
    if (score <= -3) continue;
    classified.push({ ...base, depth: new URL(c.url).pathname.split('/').filter(Boolean).length, score });
  }
  // Best platform rank first; within a rank, the most portfolio-like link
  // first; then the shallowest URL — a site's home page beats a deep link.
  classified.sort((a, b) => PLATFORM_RANK[a.platform] - PLATFORM_RANK[b.platform] || b.score - a.score || a.depth - b.depth);

  const perHost = new Map<string, number>();
  const picked: PortfolioLink[] = [];
  for (const c of classified) {
    const limit = MULTI_PER_HOST.has(c.platform) ? 2 : 1;
    const n = perHost.get(c.host) || 0;
    if (n >= limit) continue;
    perHost.set(c.host, n + 1);
    picked.push({ url: c.url, host: c.host, platform: c.platform });
    if (picked.length >= max) break;
  }
  return picked;
}
