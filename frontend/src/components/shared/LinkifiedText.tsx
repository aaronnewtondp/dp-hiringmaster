import { Fragment } from 'react';

// Free text a candidate typed (screening answers) with its web links made clickable.
// Built from React nodes — never dangerouslySetInnerHTML — and only http/https URLs ever become a link: a
// "javascript:" or "data:" string is left as the plain text it was, so pasted text can never run as code.
// Candidates also write addresses without the scheme ("drive.google.com/file/d/…", "www.mybrand.in"), and the review
// tries to open those, so a short list of work-sample hosts and any "www." host are linked too, by putting https://
// in front. Any other bare domain stays text on purpose — "Node.js", "e.g." and an e-mail's domain are not links.

export type LinkifiedPart = { text: string; href?: undefined } | { text: string; href: string };

// A run of non-space characters from a scheme on. The characters that cannot be part of a pasted URL
// (angle brackets, quotes, backticks) end it, so markup-looking text never lands inside an href.
const URL_RUN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
// Punctuation that ends a sentence or a list item far more often than it ends a URL.
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', '…', ')', ']', '}']);
const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

// Hosts a candidate is likely to paste without a scheme as a work sample. A subdomain of one of them counts too
// (m.youtube.com, in.linkedin.com, name.notion.site). Matches the hosts the review's own link picker understands.
const BARE_HOSTS = [
  'drive.google.com', 'docs.google.com', 'instagram.com', 'youtube.com', 'youtu.be', 'vimeo.com', 'behance.net',
  'canva.com', 'notion.so', 'notion.site', 'linkedin.com', 'dropbox.com', 'medium.com',
];
const KNOWN_HOST = `(?:[a-z0-9-]+\\.)*(?:${BARE_HOSTS.map(h => h.replace(/\./g, '\\.')).join('|')})`;
const WWW_HOST = 'www\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)+';
const PATH_CHAR = /[^\s<>"'`]/.source;
// Where the next address starts after a comma or semicolon pasted with no space ("drive.google.com/a,instagram.com/b").
const NEXT_HOST = `(?:www\\.[a-z0-9-]+\\.[a-z0-9-]|${KNOWN_HOST})`;
// 1 = the character before it (consumed, then handed back as text): never a letter, digit, "@", ".", "/", ":", "%", "+",
// "~" or "-", so the middle of a longer name, an e-mail address and "ftp://host" are not picked up.
// 2 = the address. The host must not run on into a longer name ("instagram.com.evil.example", "notion.software") or be
// an e-mail's domain ("x@host" / "host@x"). A nested quantifier is safe here: every label ends in a dot, so there is
// only one way to split a host into labels, and a match needs a boundary character in front, so a long run of
// letters is scanned once, not once per position.
const BARE_URL = new RegExp(
  `(^|[^\\w@./:%+~-])((?:${WWW_HOST}|${KNOWN_HOST})(?![\\w@-]|\\.[a-z0-9])(?:[/?#](?:(?![,;]${NEXT_HOST})${PATH_CHAR})*)?)`,
  'gi',
);

/** The URL if it is a well-formed http(s) address with a host, else null. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  // A host must follow the scheme directly: the URL parser would quietly read "https:///x" as "https://x/".
  if (!/^https?:\/\/[^/\\?#\s]/i.test(v)) return null;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? v : null;
  } catch {
    return null;
  }
}

/** Splits `url` into the link itself and the sentence punctuation that trails it. */
function trimTrailing(url: string): [string, string] {
  // Bracket counts are taken once and kept up to date as brackets are trimmed: recounting per trimmed character
  // would be quadratic on a pasted run of ")))))…", and this runs on text any candidate can write.
  const opening: Record<string, number> = { '(': 0, '[': 0, '{': 0 };
  const closing: Record<string, number> = { ')': 0, ']': 0, '}': 0 };
  for (const ch of url) {
    if (ch in opening) opening[ch] += 1;
    else if (ch in closing) closing[ch] += 1;
  }
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (!TRAILING.has(ch)) break;
    // A closing bracket belongs to the URL when it balances one inside it, e.g. a Wikipedia-style "/wiki/Tea_(drink)".
    const open = OPENER[ch];
    if (open) {
      if (opening[open] >= closing[ch]) break;
      closing[ch] -= 1;
    }
    end -= 1;
  }
  return [url.slice(0, end), url.slice(end)];
}

/** Plain text -> plain text and links for the scheme-less addresses in it (see BARE_HOSTS). Loses nothing. */
function splitBare(text: string): LinkifiedPart[] {
  const parts: LinkifiedPart[] = [];
  let cursor = 0;
  for (const m of text.matchAll(BARE_URL)) {
    const start = (m.index ?? 0) + m[1].length;
    const [address] = trimTrailing(m[2]);
    const href = safeHttpUrl(`https://${address}`);
    if (!href) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: address, href });
    cursor = start + address.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

/** Text -> alternating plain text and http(s) links, in order, losing nothing (the parts concatenate back to the input). */
export function splitLinkified(input: string): LinkifiedPart[] {
  const parts: LinkifiedPart[] = [];
  const push = (text: string, href?: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (!href && last && !last.href) last.text += text;     // keep plain runs whole
    else parts.push(href ? { text, href } : { text });
  };
  let cursor = 0;
  for (const m of input.matchAll(URL_RUN)) {
    const start = m.index ?? 0;
    push(input.slice(cursor, start));
    // "https://a.com,https://b.com" is one run of characters but two links.
    for (const piece of m[0].split(/(?=https?:\/\/)/i)) {
      const [url, tail] = trimTrailing(piece);
      const href = safeHttpUrl(url);
      if (href) { push(url, href); push(tail); } else push(piece);
    }
    cursor = start + m[0].length;
  }
  push(input.slice(cursor));
  // Second pass, over the text between the explicit links only (an http(s) link is never searched again).
  return parts.flatMap(p => (p.href ? [p] : splitBare(p.text)));
}

export default function LinkifiedText({ text, linkClassName = 'text-dp-600 hover:underline break-all' }: { text: string | null | undefined; linkClassName?: string }) {
  const parts = splitLinkified(typeof text === 'string' ? text : text == null ? '' : String(text));
  return (
    <>
      {parts.map((p, i) => p.href
        ? <a key={i} href={p.href} target="_blank" rel="noreferrer noopener" className={linkClassName}>{p.text}</a>
        : <Fragment key={i}>{p.text}</Fragment>)}
    </>
  );
}
