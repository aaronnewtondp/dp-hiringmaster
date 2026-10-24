import { dedupeKey, classifyUrl, nameTokens, normalizeUrl } from './links.js';
import { PortfolioLink, PortfolioPlatform, ReviewHandler } from './types.js';

// ─── Work-sample links from a screening answer (Head of Marketing review) ────
// LIGHT and pure: safe to import from the main API bundle (no network, no Drive, no browser).
// The marketing review's links come from the candidate's answer to "Links to public resources/portfolio ...",
// not from the resume. People paste anything there — a Drive PDF, an Instagram handle without "https://",
// a Linktree, "N/A", "all my work is under NDA" — so this file (a) finds the answer, (b) decides whether it is
// a real answer, (c) extracts and classifies every link in it and (d) picks the few worth opening, ranked.
//
// It has its OWN extraction regexes on purpose: links.ts's shared ones feed the designer review (R007) and are
// pinned by its tests; widening them would change which links a designer's resume yields.

export const WORK_SAMPLE_QUESTION_RE = /links to public resources\/portfolio/i;

export interface AnswerLinkPick {
  /** false for no matching answer, a blank / "N/A" / "NDA" style answer, or a few meaningless characters and no link. */
  answered: boolean;
  /** answered with words but not one usable link: described, never reviewed. */
  textOnly: boolean;
  /** The answer with its line breaks kept (runs of spaces and 3+ line breaks collapsed), capped at 1500 chars with a trailing "…" when cut; '' when !answered. */
  claimText: string;
  /** Picked links, best first. Each carries the handler that will open it. */
  links: PortfolioLink[];
  /** Links that were NOT opened and why (code-built, plain language): cut by a cap, or never opened by policy. */
  listedNotReviewed: Array<{ url: string; platform: PortfolioPlatform; reason: string }>;
}

export interface ClassifiedAnswerUrl {
  url: string;
  host: string;
  platform: PortfolioPlatform;
  handler: ReviewHandler;
  /** Canonical identity for de-duplication (drive:<id>, yt:<id>, ig:<path>, else a scheme/www/tracking-insensitive form). */
  key: string;
}

// ─── Limits ──────────────────────────────────────────────────────────────────
// Every limit below is about bounded work on hostile input, not tidiness: the answer is free text typed by the
// candidate. All scanning is linear (no `+$` / nested-quantifier regexes — see links.ts's note on the 15 s freeze).
const MAX_ANSWER_CHARS = 40_000;     // a real answer is a few hundred characters
const MAX_TOKEN_CHARS = 4096;        // a longer run of non-space characters is not a URL (links.ts caps URLs at 2048)
const MAX_RAW_PIECES = 400;          // candidate URL pieces ever handed to normalizeUrl
const MAX_URLS = 40;                 // URLs returned from one answer
const CLAIM_MAX_CHARS = 1500;
const MIN_ANSWER_CHARS = 12;         // letters/digits needed for words without a link to count as an answer
const BLANK_MAX_CHARS = 400;         // a longer text is a real description, whatever words it uses

const MAX_PICKED = 8;
const GROUP_CAP = { document: 3, site: 2, video: 2, social: 2, resolve: 2 } as const;
type Group = keyof typeof GROUP_CAP;

// ─── Finding the answer ──────────────────────────────────────────────────────

/** The work-sample answer inside applications.screening_answers. Tolerates null, non-arrays and junk entries. */
export function findWorkSampleAnswer(screening: unknown): { question: string; answer: string } | null {
  if (!Array.isArray(screening)) return null;
  for (const entry of screening) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { question, answer } = entry as { question?: unknown; answer?: unknown };
    if (typeof question !== 'string' || typeof answer !== 'string') continue;
    if (WORK_SAMPLE_QUESTION_RE.test(question)) return { question, answer };
  }
  return null;
}

// ─── Is the answer a real answer? ────────────────────────────────────────────
// "N/A", "none", "under NDA", "will share on request" are statements that there is NOTHING to open. The matcher is
// conservative: a text is blank only when EVERY word is one of a small vocabulary of function words and
// absence / confidentiality / deferral words, and at least one of them is a real cue ("no", "not", "NDA",
// "on request" ...). A single unknown word (a verb like "led", a digit, a URL) makes it a real answer. Either way
// the application is not scored — the difference is only which message HR sees — so the bias is toward "not blank".
const CUE_WORDS = new Set((
  'na nil none no nope nah nada nothing not never cant cannot unable wont dont doesnt isnt wasnt arent havent hasnt didnt couldnt shouldnt wouldnt ' +
  'nda confidential confidentiality proprietary private restricted unavailable request demand interview interviews later will shall ' +
  'nahi nahin nhi'
).split(' '));

const FILLER_WORDS = new Set((
  'a an the i me my mine we our us it its they them their this that these those there here ' +
  'is are was were be been being am have has had having do does did get got ' +
  'to of for at in on upon during with without as so also and or but however though although yet still ' +
  'any some all most many much more about by from into than then if when once after before while whenever because since ' +
  'due owing hence thus both either such same other another each every own very really just strictly highly completely totally entirely fully ' +
  'currently presently right now moment time present today ' +
  'sorry unfortunately sadly apologies please kindly thanks thank you your yours regards hi hello hey dear sir madam team hr ' +
  'link links url urls portfolio portfolios work works sample samples website websites site sites online public publicly external ' +
  'resource resources material materials example examples case study studies campaign campaigns project projects detail details ' +
  'document documents file files share shared sharing shareable sharable provide provided send sent give given show showcase showing shown display displayed ' +
  'disclose disclosed disclosure post posted publish published reveal revealed attach attached attachment submit submitted add added available applicable ' +
  'agreement agreements client clients company companies employer employers organisation organization previous past current prior former existing ' +
  'specific particular relevant direct live via able allowed permitted permission liberty position policy policies reason reasons restriction restrictions ' +
  'signed sign bound covered protected under subject terms conditions contract contracts legal secret ' +
  'can could would should may might must happy glad willing ready discuss discussion call meeting round rounds stage person connect conversation ' +
  'shortlisted shortlisting selected selection asked ask required needed necessary ' +
  'koi hai'
).split(' '));

export function isBlankAnswer(text: string): boolean {
  if (typeof text !== 'string') return true;
  // Nothing but whitespace / punctuation / symbols (in any script — a Devanagari sentence is NOT blank).
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  if (text.length > BLANK_MAX_CHARS) return false;
  const words = text
    .toLowerCase()
    .replace(/['\u2018\u2019`\u00b4]/g, '')
    .replace(/\bn\s*[./\\-]\s*a\b/g, ' na ')               // n/a, n.a., N.A, n-a
    .replace(/\bnon[\s-]*disclosure\b/g, ' nda ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ');
  if (words.length > 40) return false;
  let cue = false;
  for (const w of words) {
    if (CUE_WORDS.has(w)) cue = true;
    else if (!FILLER_WORDS.has(w)) return false;
  }
  return cue;
}

// ─── Extracting URLs ─────────────────────────────────────────────────────────

// A character class from code points and ranges, written as numbers: the characters in these classes are invisible, or look like
// one thing and are another, and a source file should say which.
function charClass(...parts: Array<number | [number, number]>): string {
  const esc = (c: number) => `\\u${c.toString(16).padStart(4, '0')}`;
  return `[${parts.map(p => (typeof p === 'number' ? esc(p) : `${esc(p[0])}-${esc(p[1])}`)).join('')}]`;
}

// Characters that carry no text and are pasted into a URL from Slack / Docs / a right-to-left keyboard: removed, not treated as a
// separator. The soft hyphen, the Arabic letter mark, the zero-width characters and the left-to-right / right-to-left marks
// (U+200B-U+200F), the embedding controls (U+202A-U+202E), the word joiner, the isolate controls (U+2066-U+2069), the variation
// selectors (the invisible half of an emoji like a right arrow in its emoji form) and the byte order mark.
const INVISIBLE_RE = new RegExp(charClass(0xad, 0x61c, [0x200b, 0x200f], [0x202a, 0x202e], 0x2060, [0x2066, 0x2069], [0xfe00, 0xfe0f], 0xfeff), 'g');
// A hyphen that only looks like one (U+2010 hyphen, U+2011 non-breaking hyphen: what a word processor puts in a slug) is one.
const LOOKALIKE_HYPHEN_RE = new RegExp(charClass(0x2010, 0x2011), 'g');
// A token is a run of characters that can be part of an address: whitespace, comma, semicolon, pipe, angle brackets and ASCII
// quotes split, and so does EVERY non-ASCII character that is not a letter, a mark that belongs to a letter (a virama, a vowel
// sign, an accent) or a digit: smart and CJK quotes and brackets, guillemets, a Devanagari danda, an ideographic full stop or
// comma, full-width punctuation, dashes, ellipses, arrows, emoji. A real address carries none of those (a Hindi path, a
// Devanagari domain and an accented slug are letters, so they stay), so cutting there is how a link in curly quotes ends at
// the host, not in a percent-encoded quote or a punycode host that does not exist. One pass, every step constant: no
// backtracking (the two alternatives cannot match the same character).
const TOKEN_RE = /(?:[^\s,;|<>"'`\x80-\u{10ffff}]|(?![\x00-\x7f])[\p{L}\p{Mn}\p{Mc}\p{N}])+/gu;
const LEADING_WRAP_RE = /^[(\[{*\-_~]+/;
const TRAILING_JUNK = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '*', '_', '~', "'", '"', '`', '>']);
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
// Between two tokens, a lone one of these is still inside a URL when what follows is not a link of its own.
const GLUE_CHARS = new Set([',', '|', "'"]);
// The full stop a CJK keyboard types (U+3002 ideographic, U+FF0E full-width, U+FF61 half-width): a URL parser reads each as a dot
// in a host, so 'https://janedoe。design' is janedoe.design (and was, before tokens were cut at non-ASCII punctuation). It is
// also how a sentence ends, so it joins two tokens only before more ASCII address, never before words ('https://x.com。ご覧ください').
const DOT_LIKE = new Set([0x3002, 0xff0e, 0xff61].map(c => String.fromCharCode(c)));
const ASCII_ONLY_RE = /^[\x21-\x7e]+$/;
const HAS_SCHEME_RE = /https?:\/\//i;
// A token that ends like this was wrapped (a bracket, markdown / WhatsApp emphasis) and the link ended with the wrapper.
const ENDS_WRAPPED_RE = /[)\]}>*_~]$/;
// "portfolio:janedoe.design" — a label glued to the address by a colon.
const GLUED_LABEL_RE = /^\p{L}{2,24}[:=](?!\/)(.+)$/u;

// Hosts people type without "https://". These are trusted bare: the host alone makes it clearly a link.
const BARE_KNOWN_HOSTS = new Set([
  'instagram.com', 'instagr.am', 'youtube.com', 'youtu.be', 'vimeo.com', 'loom.com',
  'drive.google.com', 'docs.google.com', 'canva.com', 'canva.link', 'canva.site', 'dropbox.com',
  'linktr.ee', 'bio.link', 'beacons.ai', 'linkin.bio', 'lnk.bio', 'campsite.bio',
  'notion.so', 'notion.site', 'behance.net', 'dribbble.com', 'medium.com', 'substack.com',
  'linkedin.com', 'figma.com', 'figma.site', 'wetransfer.com', 'we.tl',
  'bit.ly', 'lnkd.in', 't.co', 'tinyurl.com', 'rb.gy', 'ow.ly', 'buff.ly', '1drv.ms', 'goo.gl',
  'is.gd', 'cutt.ly', 'shorturl.at', 'tiny.cc', 't.ly',
  'framer.website', 'framer.app', 'framer.ai', 'framer.com', 'webflow.io', 'wixsite.com', 'adobeportfolio.com',
  'myportfolio.com', 'carrd.co', 'cargo.site', 'cargocollective.com', 'squarespace.com',
  'facebook.com', 'fb.com', 'fb.me', 'fb.watch', 'twitter.com', 'x.com', 'threads.net', 'tiktok.com',
  'pinterest.com', 'pin.it', 'snapchat.com', 'sharepoint.com', 'onedrive.live.com',
]);

// A bare custom domain ("janedoe.design/work") is trusted only with one of these endings: a longer list would turn
// ordinary words glued to a full stop ("e.g", "etc", "Node.js", "Ph.D") into links.
const CUSTOM_TLDS = new Set([
  'com', 'in', 'co', 'io', 'design', 'studio', 'me', 'net', 'org', 'agency', 'work', 'art', 'site', 'xyz', 'app', 'page',
  'online', 'website', 'portfolio', 'creative', 'media', 'digital',
  'co.in', 'org.in', 'net.in', 'co.uk', 'com.au', 'com.sg',
]);

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function isKnownBareHost(host: string): boolean {
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (BARE_KNOWN_HOSTS.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

/** Plausible DNS host: 2+ labels, each 1-63 of [a-z0-9_-], no label starting/ending with "-", at most 253 chars. */
function validHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  return labels.every(l => /^[a-z0-9_-]{1,63}$/i.test(l) && !l.startsWith('-') && !l.endsWith('-'));
}

function isIpHost(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * `s` without the ASCII punctuation and emphasis it ends with (anything non-ASCII that is not a letter never reaches a token: see
 * TOKEN_RE). With `balanced` (a scheme URL, whose path can
 * legitimately end in a bracket: /wiki/Foo_(bar)) a closing bracket is kept while it has an opener, stripped once it has none.
 */
function stripTrailingJunk(s: string, balanced = false): string {
  let end = s.length;
  const open: Record<string, number> = { '(': 0, '[': 0, '{': 0 };
  const close: Record<string, number> = { ')': 0, ']': 0, '}': 0 };
  if (balanced) {
    for (const c of s) {
      if (c in open) open[c]++;
      else if (c in close) close[c]++;
    }
  }
  while (end > 0) {
    const c = s[end - 1];
    if (balanced && c in CLOSERS) {
      if (open[CLOSERS[c]] >= close[c]) break;     // it closes something: part of the address
      close[c]--;
      end--;
    } else if (TRAILING_JUNK.has(c)) end--;
    else break;
  }
  return s.slice(0, end);
}

/** A scheme-less token worth treating as a link, or null. The token has no whitespace or comma inside. */
function bareCandidate(token: string): string | null {
  let t = token.replace(LEADING_WRAP_RE, '');
  if (!t || t[0] === '@' || t[0] === '#') return null;
  const glued = GLUED_LABEL_RE.exec(t);
  if (glued) t = glued[1].replace(LEADING_WRAP_RE, '');
  t = stripTrailingJunk(t);
  if (!t) return null;
  const cut = t.search(/[/?#]/);
  const hostPart = cut === -1 ? t : t.slice(0, cut);
  // "jane@medium.com" is an email; "medium.com/@jane" (an "@" in the path) is a profile and is fine.
  if (!hostPart || hostPart.includes('@') || hostPart.length > 253) return null;
  const labels = hostPart.split('.');
  if (labels.length < 2) return null;
  if (!labels.every(l => /^[A-Za-z0-9-]{1,63}$/.test(l) && !l.startsWith('-') && !l.endsWith('-'))) return null;
  const lower = labels.map(l => l.toLowerCase());
  if (lower[0] === 'www') return labels.length >= 3 ? t : null;
  if (isKnownBareHost(lower.join('.'))) return t;

  // Custom domain: a conservative ending, a real name label, and not a sentence missing its space.
  const tld1 = lower[lower.length - 1];
  const tld2 = lower.slice(-2).join('.');
  let nameAt: number;
  if (lower.length >= 3 && CUSTOM_TLDS.has(tld2)) nameAt = lower.length - 3;
  else if (CUSTOM_TLDS.has(tld1)) nameAt = lower.length - 2;
  else return null;
  const name = lower[nameAt];
  if (name.length < 2 || /^\d+$/.test(name)) return null;
  // "campaigns.In 2022" — a capital after the full stop is two sentences run together. ("JANEDOE.COM" is fine.)
  if (/^[A-Z]/.test(labels[labels.length - 1]) && /[a-z]/.test(labels[labels.length - 2])) return null;
  return t;
}

function urlsInToken(token: string, budget: { pieces: number }): string[] {
  if (!/https?:\/\//i.test(token)) {
    // Most tokens are ordinary words; only a plausible address is counted against the budget.
    const bare = bareCandidate(token);
    if (!bare || budget.pieces >= MAX_RAW_PIECES) return [];
    budget.pieces++;
    const n = normalizeUrl(bare);
    return n ? [n] : [];
  }
  // Scheme URL(s). Several can be glued together ("https://a.comhttps://b.com"), and text can precede the first
  // one ("Portfolio:https://x.com", "[my work](https://x.com)").
  const out: string[] = [];
  for (const piece of token.split(/(?=https?:\/\/)/i)) {
    if (!/^https?:\/\//i.test(piece)) continue;
    if (budget.pieces >= MAX_RAW_PIECES) break;
    budget.pieces++;
    // Emphasis (**x**, _x_, ~x~) right after the link is not part of it: 'https://janedoe.design**' used to be a host that did
    // not exist. (An ellipsis, an emoji or a smart quote never gets this far: TOKEN_RE ended the token before it.)
    const n = normalizeUrl(stripTrailingJunk(piece, true));
    if (!n) continue;
    let host = '';
    try { host = new URL(n).hostname; } catch { continue; }
    if (validHost(host)) out.push(n);
  }
  return out;
}

interface Scan {
  urls: string[];
  /** The text with every token that yielded a link blanked out — what is left is the candidate's own wording. */
  residual: string;
}

function scanAnswer(rawText: string): Scan {
  const text = rawText.length > MAX_ANSWER_CHARS ? rawText.slice(0, MAX_ANSWER_CHARS) : rawText;
  const clean = text.replace(INVISIBLE_RE, '').replace(LOOKALIKE_HYPHEN_RE, '-');
  const urls: string[] = [];
  const seen = new Set<string>();
  const kept: string[] = [];
  const budget = { pieces: 0 };
  const tokens = Array.from(clean.matchAll(TOKEN_RE));
  let last = 0;
  for (let t = 0; t < tokens.length; t++) {
    const m = tokens[t];
    let token = m[0];
    if (token.length > MAX_TOKEN_CHARS) continue;
    let end = (m.index ?? 0) + token.length;
    // A comma, pipe or apostrophe split the text into tokens, but inside a URL they are part of it
    // ('https://janedoe.design/work,2023/x'). So a scheme URL takes the next token along when exactly ONE of them sits
    // between the two with no space, unless that next token is a link of its own ('https://a.com,https://b.com',
    // 'https://a.com,instagram.com/x') or the URL was wrapped and has ended ('(https://a.com/x),and'). A CJK full stop (DOT_LIKE)
    // is glued the same way, but only to more ASCII address.
    if (HAS_SCHEME_RE.test(token)) {
      while (t + 1 < tokens.length) {
        const next = tokens[t + 1];
        const nextAt = next.index ?? 0;
        if (nextAt !== end + 1 || !(GLUE_CHARS.has(clean[end]) || DOT_LIKE.has(clean[end])) || ENDS_WRAPPED_RE.test(token)) break;
        if (DOT_LIKE.has(clean[end]) && !ASCII_ONLY_RE.test(next[0])) break;
        if (token.length + 1 + next[0].length > MAX_TOKEN_CHARS) break;
        if (urlsInToken(next[0], { pieces: 0 }).length > 0) break;
        token += clean[end] + next[0];
        end = nextAt + next[0].length;
        t++;
      }
    }
    const found = urlsInToken(token, budget);
    if (found.length === 0) {
      if (budget.pieces >= MAX_RAW_PIECES) break;
      continue;
    }
    kept.push(clean.slice(last, m.index), ' ');
    last = end;
    for (const u of found) {
      if (seen.has(u)) continue;
      seen.add(u);
      urls.push(u);
    }
    if (urls.length >= MAX_URLS) break;
  }
  kept.push(clean.slice(last));
  return { urls: urls.slice(0, MAX_URLS), residual: kept.join('') };
}

/**
 * Every link in a free-text answer, in order of appearance, normalised and de-duplicated: scheme URLs, "www." URLs,
 * the hosts people type without a scheme (instagram.com/x, youtu.be/x, drive.google.com/…, bit.ly/x …) and a bare
 * custom domain when it is clearly one. Emails, "e.g." / "etc." and file names are not links.
 */
export function extractAnswerUrls(text: string): string[] {
  if (typeof text !== 'string' || !text) return [];
  return scanAnswer(text).urls;
}

// ─── Classifying a URL ───────────────────────────────────────────────────────

const TRACKING_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|msclkid|igsh|igshid|si|mc_cid|mc_eid)$/i;
const GOOGLE_ID = /^[A-Za-z0-9_-]{10,}$/;
const YOUTUBE_ID = /^[\w-]{11}$/;

const LINK_HUB_HOSTS = ['linktr.ee', 'bio.link', 'beacons.ai', 'linkin.bio', 'lnk.bio', 'campsite.bio'];
const SHORTENER_HOSTS = ['bit.ly', 't.co', 'tinyurl.com', 'rb.gy', 'ow.ly', 'buff.ly', 'goo.gl', '1drv.ms', 'is.gd', 'cutt.ly', 'shorturl.at', 'tiny.cc', 't.ly'];
const SOCIAL_OTHER_HOSTS = ['facebook.com', 'fb.com', 'fb.me', 'fb.watch', 'twitter.com', 'x.com', 'threads.net', 'threads.com', 'tiktok.com', 'pinterest.com', 'pin.it', 'snapchat.com'];
const CLOUD_DOCUMENT_HOSTS = ['dropbox.com', 'dropboxusercontent.com', 'onedrive.live.com', 'sharepoint.com'];
// Google hosts that can carry a work sample and are opened. Every other *.google.com address (search, maps, calendar, meet,
// forms) is boilerplate that Google Forms answers are full of, except the three products listed below.
const GOOGLE_KEEP = new Set(['drive.google.com', 'docs.google.com', 'sites.google.com', 'drive.usercontent.google.com']);

// Three Google products are plausible marketing work samples (an app the candidate marketed, a reporting dashboard, a campaign
// photo album) but are not opened automatically: JS-rendered and login-prone, and no fetcher exists. They are NOT part of the
// *.google.com boilerplate that is dropped: a dropped link vanishes, and an answer whose only link it was read as "no work
// samples provided". They are classified as never-opened links (handler 'none', platform 'custom'), so HR sees the link with its
// own reason. Exact hosts only (a look-alike such as play.google.com.evil.example is an ordinary site, and so is evilplay.google.com).
type ListedGoogleProduct = 'play' | 'looker' | 'photos';

function listedGoogleProduct(host: string, lowerPath: string): ListedGoogleProduct | null {
  if (host === 'play.google.com') return 'play';
  if (host === 'lookerstudio.google.com' || host === 'datastudio.google.com') return 'looker';
  // photos.app.goo.gl is Google Photos' own short link (it used to be read as any other shortener and resolved: the worker then
  // asked for it, and the page it leads to was not reviewable); goo.gl/photos/... is its older spelling.
  if (host === 'photos.google.com' || host === 'photos.app.goo.gl') return 'photos';
  if (host === 'goo.gl' && /^\/photos(\/|$)/.test(lowerPath)) return 'photos';
  return null;
}

const LISTED_GOOGLE_REASON: Record<ListedGoogleProduct, string> = {
  play: 'Google Play listing - not opened automatically, open it by hand',
  looker: 'Looker Studio report - not opened automatically, open it by hand',
  photos: 'Google Photos album or photo - not opened automatically, open it by hand',
};

/** Links that are never a work sample: the company's own, forms, scheduling, chat, maps, internal hosts, raw IPs. */
function isDropped(host: string, lowerPath: string): boolean {
  if (hostIs(host, 'digitalpaani.com')) return true;
  if (host === 'forms.gle' || hostIs(host, 'forms.google.com')) return true;
  if (host === 'docs.google.com' && /^\/forms(\/|$)/.test(lowerPath)) return true;
  if (host === 'goo.gl' && /^\/(forms|maps)(\/|$)/.test(lowerPath)) return true;
  if (hostIs(host, 'calendly.com') || hostIs(host, 'zoom.us')) return true;
  if (host === 'wa.me' || hostIs(host, 'whatsapp.com') || hostIs(host, 'whatsapp.net')) return true;
  if (host === 't.me' || host === 'telegram.dog' || hostIs(host, 'telegram.me') || hostIs(host, 'telegram.org')) return true;
  if (host === 'maps.app.goo.gl' || host === 'maps.apple.com') return true;
  // includes maps.google.com and google.com/maps; not the three listed products above
  if (hostIs(host, 'google.com') && !GOOGLE_KEEP.has(host) && listedGoogleProduct(host, lowerPath) === null) return true;
  if (/(^|\.)localhost(\.|$)/.test(host) || /\.(localdomain|local|internal|lan|intranet|home\.arpa)$/.test(host)) return true;
  return false;
}

function cleanQuery(search: string): string {
  if (!search) return '';
  const kept = search.slice(1).split('&').filter(p => p && !TRACKING_PARAM.test(p.split('=')[0]));
  return kept.length ? `?${kept.join('&')}` : '';
}

function instagramKey(path: string): string {
  const segs = path.split('/').filter(Boolean);
  // Post / reel codes are case-sensitive; profile handles are not.
  const codeLike = segs.length > 0 && /^(p|reel|reels|tv|stories|s)$/i.test(segs[0]);
  const parts = codeLike ? [segs[0].toLowerCase(), ...segs.slice(1)] : segs.map(s => s.toLowerCase());
  return `ig:${parts.join('/')}`;
}

function youtubeKey(host: string, path: string, params: URLSearchParams): string {
  let id: string | null = null;
  if (host === 'youtu.be') id = path.split('/').filter(Boolean)[0] ?? null;
  else {
    const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/i.exec(path);
    if (m) id = m[1];
    else if (/^\/watch\/?$/i.test(path)) id = params.get('v');
  }
  if (id && YOUTUBE_ID.test(id)) return `yt:${id}`;
  // A playlist, channel, @handle, or a watch link whose id is not well-formed: the address itself. The video and
  // playlist ids live in the query string, so they are part of the identity (two playlists are two links).
  const query = ['v', 'list'].filter(k => params.get(k)).map(k => `${k}=${params.get(k)}`).join('&');
  return `youtube.com${path.toLowerCase().replace(/\/$/, '')}${query ? `?${query}` : ''}`;
}

function vimeoKey(path: string, fallback: string): string {
  const m = /^\/(?:video\/)?(\d{5,})(?:\/[A-Za-z0-9]+)?\/?$/.exec(path);
  return m ? `vimeo:${m[1]}` : fallback;
}

function loomKey(path: string, fallback: string): string {
  const m = /^\/(?:share|embed)\/([A-Za-z0-9]{10,})/.exec(path);
  return m ? `loom:${m[1]}` : fallback;
}

// Drive and Docs put the signed-in account in front of the path: "/u/0/" (the Nth account in the browser) and
// "/a/example.com/" (a Google Workspace domain), in either order. They say nothing about the file.
const GOOGLE_ACCOUNT_PREFIX_RE = /^(?:\/(?:a\/[^/]+|u\/\d+))+(?=\/)/;

/**
 * Drive / Docs links that name a file or folder by a well-formed id, else null (the caller then treats it as a plain site).
 * `path` is the address's canonical path — WITHOUT any account prefix or "mobile/" (what google.ts's own parser reads) — so
 * the same file reached as /file/d/ID, /file/u/0/d/ID, /u/0/file/d/ID or /a/example.com/file/d/ID is one link.
 */
function googleFile(host: string, rawPath: string, params: URLSearchParams): { platform: PortfolioPlatform; id: string; path: string } | null {
  // "/drive/mobile/folders/ID" is the same folder as "/drive/folders/ID"; the mobile spelling is dropped with the account prefix.
  const path = rawPath.replace(GOOGLE_ACCOUNT_PREFIX_RE, '').replace(/^\/drive\/mobile\/folders\//, '/drive/folders/');
  let platform: PortfolioPlatform | null = null;
  let id: string | null = null;
  if (host === 'docs.google.com') {
    const m = /^\/(document|presentation|spreadsheets)\/(?:u\/\d+\/)?d\/(?:e\/)?([^/?#]+)/.exec(path);
    if (m) {
      platform = m[1] === 'document' ? 'google_doc' : m[1] === 'presentation' ? 'google_slides' : 'google_sheet';
      id = m[2];
    }
  } else if (host === 'drive.google.com') {
    let m = /^\/file\/(?:u\/\d+\/)?d\/([^/?#]+)/.exec(path);
    if (m) { platform = 'gdrive_file'; id = m[1]; }
    else if ((m = /^\/drive\/(?:u\/\d+\/|mobile\/)?folders\/([^/?#]+)/.exec(path))) { platform = 'gdrive_folder'; id = m[1]; }
    else if (/^\/folderview\/?$/.test(path)) { platform = 'gdrive_folder'; id = params.get('id'); }
    else if (/^\/(open|uc)\/?$/.test(path)) { platform = 'gdrive_file'; id = params.get('id'); }
  } else if (host === 'drive.usercontent.google.com' && /^\/download\/?$/.test(path)) {
    platform = 'gdrive_file';
    id = params.get('id');
  }
  return platform && id && GOOGLE_ID.test(id) ? { platform, id, path } : null;
}

/**
 * What a link is and how it will be opened, or null when it is not a work sample at all (mail / phone / script
 * schemes, Google Forms, scheduling, chat, maps, the company's own site, raw IP addresses, links with credentials).
 * The URL comes back normalised with tracking parameters (utm_*, fbclid, si, igsh …) removed.
 */
export function classifyAnswerUrl(url: string): ClassifiedAnswerUrl | null {
  if (typeof url !== 'string') return null;
  const norm = normalizeUrl(url);
  if (!norm) return null;
  let u: URL;
  try { u = new URL(norm); } catch { return null; }
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/^www\./, '');
  if (!validHost(host) || isIpHost(host)) return null;
  const path = u.pathname;
  const lower = path.toLowerCase();
  if (isDropped(host, lower)) return null;

  u.search = cleanQuery(u.search);
  const out = u.toString();
  const clean = u.pathname === '/' && !u.search ? out.replace(/\/$/, '') : out;
  const params = u.searchParams;
  const key = dedupeKey(clean);
  const mk = (platform: PortfolioPlatform, handler: ReviewHandler, k = key, url = clean): ClassifiedAnswerUrl =>
    ({ url, host, platform, handler, key: k });

  // Play / Looker Studio / Photos: never opened, listed for HR. Checked before the file-extension rules so that a path ending in
  // ".pdf" on one of these hosts cannot turn it into a document that the worker would download. The identity keeps the case of the
  // path and query (Photos short ids and Play package names are case-sensitive, and dedupeKey lower-cases everything, which would
  // merge two different albums into one entry) and ignores the account prefix ("/u/0/") like Drive's does.
  if (listedGoogleProduct(host, lower) !== null) {
    return mk('custom', 'none', `${host}${path.replace(GOOGLE_ACCOUNT_PREFIX_RE, '').replace(/\/$/, '')}${u.search}`);
  }

  // Google Drive / Docs. A malformed id is not trusted as a file: it is treated as a plain site link.
  if (host === 'drive.google.com' || host === 'docs.google.com' || host === 'drive.usercontent.google.com') {
    const g = googleFile(host, path, params);
    if (!g) return mk('custom', 'site');
    // A "/u/0/" or "/a/example.com/" prefix only says which account the link was copied from (and "mobile/" which app). It is
    // dropped from the address so the file opens (and is deduplicated) like any other: the fetcher reads the plain forms.
    let url = clean;
    if (g.path !== path) {
      u.pathname = g.path;
      const rebuilt = u.toString();
      url = u.pathname === '/' && !u.search ? rebuilt.replace(/\/$/, '') : rebuilt;
    }
    return mk(g.platform, 'document', `drive:${g.id}`, url);
  }

  // Files by extension, wherever they are hosted.
  if (/\.pdf$/.test(lower)) return mk('pdf_file', 'document');
  if (/\.docx?$/.test(lower)) return mk('docx_file', 'document');
  if (/\.pptx?$/.test(lower)) return mk('pptx_file', 'document');
  if (/\.(jpe?g|png|webp|gif)$/.test(lower)) return mk('image_file', 'image');
  if (/\.(mp4|mov|webm|mkv)$/.test(lower)) return mk('video_file', 'video');

  if (hostIs(host, 'instagram.com') || host === 'instagr.am') return mk('instagram', 'social', instagramKey(path));
  if (hostIs(host, 'linkedin.com') || host === 'lnkd.in') return mk('linkedin', 'none');
  if (SOCIAL_OTHER_HOSTS.some(d => hostIs(host, d))) return mk('social_other', 'none');
  if (hostIs(host, 'wetransfer.com') || host === 'we.tl') return mk('cloud_file', 'none');
  if (CLOUD_DOCUMENT_HOSTS.some(d => hostIs(host, d))) return mk('cloud_file', 'document');
  if (hostIs(host, 'youtube.com') || host === 'youtu.be' || hostIs(host, 'youtube-nocookie.com')) {
    return mk('youtube', 'video', youtubeKey(host, path, params));
  }
  if (hostIs(host, 'vimeo.com')) return mk('vimeo', 'video', vimeoKey(path, key));
  if (hostIs(host, 'loom.com')) return mk('loom', 'video', loomKey(path, key));
  if (LINK_HUB_HOSTS.some(d => hostIs(host, d))) return mk('link_hub', 'resolve');
  if (SHORTENER_HOSTS.some(d => hostIs(host, d))) return mk('link_hub', 'resolve');
  if (hostIs(host, 'canva.com') || hostIs(host, 'canva.link') || hostIs(host, 'canva.site')) return mk('canva', 'site');
  if (hostIs(host, 'medium.com') || hostIs(host, 'substack.com')) return mk('medium', 'site');

  // Behance, Dribbble, Notion, Figma, Framer, Webflow, Wix …: the designer pipeline's own classification. Anything
  // else is the candidate's own site.
  const known = classifyUrl(clean);
  return mk(known ? known.platform : 'custom', 'site');
}

// ─── Picking the links worth opening ─────────────────────────────────────────

function meaningfulChars(text: string, stopAt: number): number {
  let n = 0;
  for (const _m of text.matchAll(/[\p{L}\p{N}]/gu)) if (++n >= stopAt) break;
  return n;
}

// The answer as HR will read it: runs of spaces and tabs collapse to one space and three or more line breaks to two, but the
// line breaks themselves stay (a numbered list of campaigns must not become one run-on paragraph). Control characters (a NUL
// would be rejected by Postgres jsonb) become spaces and lone surrogates (a cut mid-emoji) are replaced, then it is capped at
// CLAIM_MAX_CHARS, ending in an ellipsis when something was cut so it never looks like it just stops.
// (Built with RegExp / fromCharCode: written as literal escapes, U+2028 and U+2029 would be real line breaks in this source.)
const LINE_BREAKS_RE = new RegExp('\\r\\n?|[\\u0085\\u2028\\u2029]', 'g');
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
const ELLIPSIS = String.fromCharCode(0x2026);

function claimOf(text: string): string {
  const norm = text
    .replace(LINE_BREAKS_RE, '\n')
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, ' ')
    .replace(/[^\S\n]+/g, ' ')            // blanks of every kind except the line break (space runs first: linear, no `\s*\n\s*`)
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, REPLACEMENT_CHAR);
  if (norm.length <= CLAIM_MAX_CHARS) return norm;
  const cut = norm.slice(0, CLAIM_MAX_CHARS - 1);
  return `${(/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut).trimEnd()}${ELLIPSIS}`;
}

// Documents first (they carry the most evidence), then websites and links still to be resolved, then video
// (metadata only), then Instagram (a snippet only). Within a rank the candidate's own order is kept.
function rankOf(handler: ReviewHandler): number {
  switch (handler) {
    case 'document': case 'image': return 1;
    case 'site': case 'resolve': return 2;
    case 'video': return 3;
    default: return 4;
  }
}

function groupOf(handler: ReviewHandler): Group {
  switch (handler) {
    case 'document': case 'image': return 'document';
    case 'video': return 'video';
    case 'social': return 'social';
    case 'resolve': return 'resolve';
    default: return 'site';
  }
}

// One address on a website is enough, except where a person's work genuinely lives on several pages.
function hostLimit(c: ClassifiedAnswerUrl): number {
  if (c.host === 'drive.google.com' || c.host === 'docs.google.com') return 3;
  if (c.platform === 'behance' || c.platform === 'notion' || c.platform === 'dribbble') return 2;
  return 1;
}

// youtu.be and m.youtube.com are the same website as youtube.com; so are instagram.com and instagr.am.
function hostGroup(host: string): string {
  if (host === 'youtu.be' || hostIs(host, 'youtube.com') || hostIs(host, 'youtube-nocookie.com')) return 'youtube.com';
  if (host === 'instagr.am' || hostIs(host, 'instagram.com')) return 'instagram.com';
  return host;
}

function notOpenedReason(c: ClassifiedAnswerUrl, candidateName: string | undefined): string {
  if (c.platform === 'linkedin') {
    const base = 'LinkedIn blocks automated viewing - open it by hand';
    let slug: string | null = null;
    try { slug = /^\/in\/([^/]+)/i.exec(new URL(c.url).pathname)?.[1] ?? null; } catch { /* keep null */ }
    const tokens = nameTokens(candidateName);
    if (!slug || tokens.length === 0) return base;
    let decoded = slug;
    try { decoded = decodeURIComponent(slug); } catch { /* keep the raw slug */ }
    const compact = decoded.toLowerCase().replace(/[^a-z]/g, '');
    return tokens.some(t => compact.includes(t))
      ? `${base} (profile address looks like the candidate's name)`
      : `${base} (profile address does not resemble the candidate's name)`;
  }
  if (c.platform === 'cloud_file') return 'expiring file-transfer link';
  if (c.platform === 'social_other') return 'social media link not opened automatically';
  let lowerPath = '';
  try { lowerPath = new URL(c.url).pathname.toLowerCase(); } catch { /* keep '' */ }
  const product = listedGoogleProduct(c.host, lowerPath);
  if (product) return LISTED_GOOGLE_REASON[product];
  return 'link not opened automatically';
}

/**
 * The marketing review's input: which links from the screening answer to open, in what order, and what to tell
 * HR about the rest. Never throws: a missing, malformed or hostile answer is simply "not answered".
 */
export function pickAnswerLinks(screening: unknown, ctx: { candidateName?: string } = {}): AnswerLinkPick {
  const found = findWorkSampleAnswer(screening);
  if (!found) return { answered: false, textOnly: false, claimText: '', links: [], listedNotReviewed: [] };

  const raw = found.answer.length > MAX_ANSWER_CHARS ? found.answer.slice(0, MAX_ANSWER_CHARS) : found.answer;
  const scan = scanAnswer(raw);

  const entries: Array<{ idx: number; c: ClassifiedAnswerUrl }> = [];
  const seen = new Set<string>();
  for (const u of scan.urls) {
    const c = classifyAnswerUrl(u);
    if (!c || seen.has(c.key)) continue;
    seen.add(c.key);
    entries.push({ idx: entries.length, c });
  }

  // With no usable link, the answer counts only if the candidate's own words (the answer minus any link) are a
  // real description — not "N/A", not "under NDA", not "see resume".
  const hasWords = entries.length === 0
    && !isBlankAnswer(scan.residual)
    && meaningfulChars(scan.residual, MIN_ANSWER_CHARS) >= MIN_ANSWER_CHARS;
  const answered = entries.length > 0 || hasWords;
  if (!answered) return { answered: false, textOnly: false, claimText: '', links: [], listedNotReviewed: [] };

  const name = typeof ctx?.candidateName === 'string' ? ctx.candidateName : undefined;
  const listed: Array<{ idx: number; url: string; platform: PortfolioPlatform; reason: string }> = [];
  const candidates: typeof entries = [];
  for (const e of entries) {
    if (e.c.handler === 'none') listed.push({ idx: e.idx, url: e.c.url, platform: e.c.platform, reason: notOpenedReason(e.c, name) });
    else candidates.push(e);
  }
  candidates.sort((a, b) => rankOf(a.c.handler) - rankOf(b.c.handler) || a.idx - b.idx);

  const perHost = new Map<string, number>();
  const perGroup = new Map<Group, number>();
  const picked: PortfolioLink[] = [];
  for (const e of candidates) {
    const hostKey = hostGroup(e.c.host);
    const limit = hostLimit(e.c);
    const group = groupOf(e.c.handler);
    let reason: string | null = null;
    if ((perHost.get(hostKey) ?? 0) >= limit) reason = `only ${limit} link${limit === 1 ? '' : 's'} per website ${limit === 1 ? 'is' : 'are'} opened`;
    else if ((perGroup.get(group) ?? 0) >= GROUP_CAP[group]) reason = `only the top ${GROUP_CAP[group]} links of each kind are opened`;
    else if (picked.length >= MAX_PICKED) reason = `only the top ${MAX_PICKED} links are opened`;
    if (reason) {
      listed.push({ idx: e.idx, url: e.c.url, platform: e.c.platform, reason });
      continue;
    }
    perHost.set(hostKey, (perHost.get(hostKey) ?? 0) + 1);
    perGroup.set(group, (perGroup.get(group) ?? 0) + 1);
    picked.push({ url: e.c.url, host: e.c.host, platform: e.c.platform, handler: e.c.handler });
  }

  listed.sort((a, b) => a.idx - b.idx);
  return {
    answered: true,
    textOnly: entries.length === 0,
    claimText: claimOf(raw),
    links: picked,
    listedNotReviewed: listed.map(({ url, platform, reason }) => ({ url, platform, reason })),
  };
}
