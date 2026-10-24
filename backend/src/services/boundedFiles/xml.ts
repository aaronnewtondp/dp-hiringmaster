// SHARED (the portfolio worker and the main API). Imports nothing. The linear XML tag walk every Office reader here is built on, and the entity decoder.
// Candidate files are hostile input: nothing here backtracks or builds a DOM, so a part of a hundred thousand unclosed tags costs the same as an honest one.
// Moved out of portfolio/acquire/office.ts and pdf.ts on 2026-10-23 (so resume parsing can use it without importing acquire/); the code is unchanged.

/**
 * What the walk tells its visitor about one tag. `open`/`gt` are the offsets of its '<' and '>', `end` is where the text
 * that follows it stops (the next '<', or the end of the string): the text content is xml.slice(gt + 1, end).
 */
export type TagVisitor = (name: string, closing: boolean, selfClosing: boolean, open: number, gt: number, end: number) => void;

/**
 * Visits every tag of an XML string once, left to right, in time linear in its length. A '<' always starts a new tag
 * (XML forbids a raw '<' inside an attribute value), so a '<' that is not closed by a '>' before the next '<' is not a tag
 * and is skipped — which is also why `<a:t <a:t <a:t …` repeated a hundred thousand times costs one pass, not a hundred
 * thousand scans to the end of the string. The search for '>' resumes where the last one was found, never from scratch.
 */
export function walkTags(xml: string, visit: TagVisitor): void {
  const n = xml.length;
  let open = xml.indexOf('<');
  let gt = -1;
  while (open >= 0) {
    const next = xml.indexOf('<', open + 1);
    const end = next < 0 ? n : next;
    if (gt < open) {
      gt = xml.indexOf('>', open + 1);
      if (gt < 0) return;   // no '>' anywhere after this point: nothing else in the string is a tag
    }
    if (gt < end) {
      const closing = xml.charCodeAt(open + 1) === 0x2f;
      const nameStart = open + (closing ? 2 : 1);
      let nameEnd = nameStart;
      while (nameEnd < gt) {
        const c = xml.charCodeAt(nameEnd);
        if (c <= 0x20 || c === 0x2f) break;
        nameEnd++;
      }
      visit(xml.slice(nameStart, nameEnd), closing, xml.charCodeAt(gt - 1) === 0x2f, open, gt, end);
    }
    open = next;
  }
}

/** The attributes of one tag's text (`name="value"` or `name='value'` pairs), read in one pass. First occurrence wins. */
export function readAttributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const n = tag.length;
  let i = 0;
  while (i < n) {
    const eq = tag.indexOf('=', i);
    if (eq < 0) break;
    let nameStart = eq;
    while (nameStart > i && tag.charCodeAt(nameStart - 1) > 0x20) nameStart--;
    let q = eq + 1;
    while (q < n && tag.charCodeAt(q) <= 0x20) q++;
    const quote = tag[q];
    if (quote !== '"' && quote !== "'") { i = eq + 1; continue; }
    const close = tag.indexOf(quote, q + 1);
    if (close < 0) break;
    const name = tag.slice(nameStart, eq);
    if (name && !out.has(name)) out.set(name, tag.slice(q + 1, close));
    i = close + 1;
  }
  return out;
}

export const attributesOf = (xml: string, open: number, gt: number) => readAttributes(xml.slice(open, gt));

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes the XML/HTML character references that show up in slide text and Drive listings. Unknown ones stay as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi, (whole, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const cp = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
  });
}

