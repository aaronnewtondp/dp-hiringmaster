/**
 * Layout logic for the social JD (1080×1350 portrait) — everything that decides
 * WHERE things go and HOW MUCH text fits, with no pdfkit dependency.
 *
 * Why this is a separate module: the template has a fixed top half (hook copy)
 * and a bottom half that must adapt to whatever the role's content is — a
 * 46-character title, three tags or ten, bullets that are terse or sprawling,
 * a role with no location. All of that is measuring and fitting text. By taking
 * a `measure` callback instead of a pdfkit document, every rule below can be
 * unit-tested with a fake measurer (see socialJdLayout.test.ts) and the renderer
 * only has to draw what this module returns.
 *
 * Units are PDF points, 1:1 with the CSS pixels of the HTML prototype this
 * template was designed in (page = 1080×1350).
 */

// ─── Fonts ──────────────────────────────────────────────────────────────────
export type FontKey = 'fig' | 'figBold' | 'figXBold' | 'monoMed' | 'monoSemi';

/** hhea ascender / descender per em, read from the shipped TTFs. pdfkit places
 *  text by its top edge (= baseline − ascender), so the renderer needs these to
 *  put a baseline exactly where the layout says. */
export const FONT_METRICS: Record<FontKey, { asc: number; desc: number }> = {
  fig:      { asc: 0.95,  desc: 0.25 },
  figBold:  { asc: 0.95,  desc: 0.25 },
  figXBold: { asc: 0.95,  desc: 0.25 },
  monoMed:  { asc: 1.025, desc: 0.275 },
  monoSemi: { asc: 1.025, desc: 0.275 },
};

/** Width of `text` set in `font` at `size`pt with `spacing`pt added after EVERY
 *  character (CSS letter-spacing semantics, trailing one included). */
export type Measure = (text: string, font: FontKey, size: number, spacing?: number) => number;

/** CSS-style baseline inside a line box: half-leading + ascent. */
export function baselineInLine(font: FontKey, size: number, lineHeight: number): number {
  const { asc, desc } = FONT_METRICS[font];
  return (lineHeight - (asc + desc) * size) / 2 + asc * size;
}

// ─── Geometry (the template's fixed skeleton) ───────────────────────────────
export const PAGE_W = 1080;
export const PAGE_H = 1350;
export const MARGIN = 72;
export const CONTENT_W = PAGE_W - 2 * MARGIN; // 936

/** The hero (logo → role block) must end by 40% of the page; the rest is the 60%. */
export const HERO_MAX_BOTTOM = PAGE_H * 0.4; // 540

/** Centre of the ripple/crosshair artwork at the top right. */
export const RIPPLE = { cx: 950, cy: 196 };
/** The hook must stay clear of the artwork's two innermost rings (the fainter outer rings run behind the
 *  text by design): `ring` is the radius of the second-innermost one, `gap` the clear space kept left of it. */
export const HOOK_CLEARANCE = { ring: 106, gap: 24 };
/** The hook's lines must END left of this x (visible end of the last glyph). Derived from the artwork, so moving
 *  the ripple moves the limit. Mansi's third line ("We have the technology to solve it.") is what set the hook size (49pt). */
export const HOOK_MAX_RIGHT = RIPPLE.cx - HOOK_CLEARANCE.ring - HOOK_CLEARANCE.gap; // 820

export const CTA_H = 83;
export const CTA_TOP = PAGE_H - CTA_H; // 1267

export const GEO = {
  heroTop: 110,
  h1Size: 49,
  h1LineH: 0.99,
  h1Spacing: -0.035,          // em
  subSize: 23,
  subLineH: 1.38,
  subMarginTop: 31,
  cardMarginTop: 35,
  cardH: 140,
  // The role block's divider sits on the second column's gridline so the meta
  // text lines up with "Who You Are" / the column indexes below it.
  col2X: MARGIN + 438 + 60,   // 570
  chipsTop: 574,
  chipH: 34.5,
  chipFont: 14.5,
  chipPadX: 15,
  chipGap: 12,
  chipSpacing: 0.05,          // em
  chipMaxRows: 2,
  colsGapAfterChips: 48,
  colsBottomGap: 52,          // clear space kept above the CTA bar
  colW: 438,
  colGap: 60,
} as const;

export const COL_X = [MARGIN, MARGIN + GEO.colW + GEO.colGap] as const;

// ─── Small text helpers ─────────────────────────────────────────────────────
export function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/** Straight quotes → typographic ones. The generator emits straight quotes
 *  ("DigitalPaani's", "can't") and the template is set in a display face where
 *  they look wrong; an apostrophe inside a word, or closing a word, becomes ’. */
export function smartQuotes(s: string): string {
  return s
    .replace(/(\w)'(?=\w)/g, '$1\u2019')            // don't, DigitalPaani's
    .replace(/(\w)'(?=[\s.,;:!?)]|$)/g, '$1\u2019') // players'
    .replace(/(^|[\s(\[])'/g, '$1\u2018')           // 'quoted'
    .replace(/'/g, '\u2019')
    .replace(/(^|[\s(\[])"/g, '$1\u201C')           // "quoted"
    .replace(/"/g, '\u201D');
}

/** Strip markup, collapse whitespace, set typographic quotes — every string the
 *  template draws from role content goes through this. */
export function cleanText(s: string): string {
  return smartQuotes(stripTags(String(s ?? '')));
}

/** Shrink `text` until it fits `maxW`: first by font size (down to minSize),
 *  then by cutting words/characters and appending "…". */
export function fitSingleLine(
  text: string, font: FontKey, maxW: number, size: number, minSize: number,
  spacingEm: number, measure: Measure,
): { text: string; size: number } {
  const w = (t: string, s: number) => measure(t, font, s, spacingEm * s);
  let s = size;
  while (s > minSize && w(text, s) > maxW) s = Math.max(minSize, Math.round((s - 0.5) * 100) / 100);
  if (w(text, s) <= maxW) return { text, size: s };
  return { text: ellipsize(text, maxW, (t) => w(t, s)), size: s };
}

/** Longest prefix of `text` (+ "…") that fits `maxW` under `width`. */
export function ellipsize(text: string, maxW: number, width: (t: string) => number): string {
  if (width(text) <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (width(text.slice(0, mid).trimEnd() + '…') <= maxW) lo = mid; else hi = mid - 1;
  }
  return lo === 0 ? '…' : text.slice(0, lo).trimEnd() + '…';
}

/** Greedy word-wrap into at most `maxLines`; the last line is ellipsized if the
 *  text still doesn't fit. */
export function wrapLines(
  text: string, maxW: number, maxLines: number, width: (t: string) => number,
): string[] {
  const words = text.split(' ').filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (width(next) <= maxW || !cur) { cur = next; continue; }
    // About to start another line — if that would exceed the cap, keep everything
    // that's left on the final allowed line and let the ellipsis below trim it.
    if (lines.length === maxLines - 1) { cur = [cur, ...words.slice(i)].join(' '); break; }
    lines.push(cur);
    cur = words[i];
  }
  if (cur) lines.push(cur);
  if (lines.length) lines[lines.length - 1] = ellipsize(lines[lines.length - 1], maxW, width);
  return lines;
}

// ─── Title block ────────────────────────────────────────────────────────────
const NO_LINE_START = new Set(['&', '/', '-', '–', '—', '+', ')']);

function breakAllowed(words: string[], i: number): boolean {
  // i = index of the first word of the NEXT line
  if (NO_LINE_START.has(words[i])) return false;      // never start a line with "& Creative…"
  if (words[i - 1].endsWith('(')) return false;
  return true;
}

/** Best split of `words` into exactly `n` lines (n = 2 or 3): minimise the
 *  widest line, never start a line with a connector, avoid a one-word orphan. */
function bestSplit(words: string[], n: number, width: (t: string) => number): string[] {
  const breaks: number[][] = [];
  const rec = (start: number, left: number, acc: number[]) => {
    if (left === 1) { breaks.push(acc); return; }
    for (let i = start + 1; i <= words.length - (left - 1); i++) {
      if (!breakAllowed(words, i)) continue;
      rec(i, left - 1, [...acc, i]);
    }
  };
  rec(0, n, []);
  let best: { lines: string[]; score: number } | null = null;
  for (const b of breaks) {
    const idx = [0, ...b, words.length];
    const lines = idx.slice(0, -1).map((s, k) => words.slice(s, idx[k + 1]).join(' '));
    const ws = lines.map(width);
    let score = Math.max(...ws);
    if (Math.min(...ws) < 0.3 * Math.max(...ws)) score *= 1.15; // lopsided
    if (!best || score < best.score) best = { lines, score };
  }
  return best ? best.lines : [words.join(' ')];
}

export interface TitleFit { lines: string[]; size: number }

/** Largest title size (40 → 26pt) at which the role title fits the left half of
 *  the role block, preferring one line, then two, then three. */
export function fitTitle(title: string, maxW: number, measure: Measure): TitleFit {
  const clean = cleanText(title) || 'Untitled role';
  const words = clean.split(' ');
  const spacingEm = -0.03;
  const w = (s: number) => (t: string) => measure(t, 'figXBold', s, spacingEm * s);

  if (w(40)(clean) <= maxW) return { lines: [clean], size: 40 };
  for (let s = 40; s >= 32; s -= 1) {
    if (words.length >= 2) {
      const lines = bestSplit(words, 2, w(s));
      if (lines.every(l => w(s)(l) <= maxW)) return { lines, size: s };
    }
  }
  for (let s = 31; s >= 26; s -= 1) {
    for (const n of [2, 3]) {
      if (words.length < n) continue;
      const lines = bestSplit(words, n, w(s));
      if (lines.every(l => w(s)(l) <= maxW)) return { lines, size: s };
    }
  }
  const lines = words.length >= 2 ? bestSplit(words, 2, w(26)) : [clean];
  return { lines: lines.map(l => ellipsize(l, maxW, w(26))), size: 26 };
}

// ─── Role-block meta ────────────────────────────────────────────────────────
export interface ExperienceParts { num?: string; unit?: string; text?: string }

/** "5-10 years" → { num:"5–10", unit:"yrs" } (digits are set in mono);
 *  "3+ Years" → { num:"3+", unit:"yrs" }. Real role records are messier than that —
 *  "3-6" (no unit), "3 - 6 years in recruitment", even a 97-character sentence starting
 *  "1-2 in B2B technology…" — so a LEADING number/range is taken and the free-text tail is
 *  dropped (the long-form JD carries the detail; this is a compact meta field). A tail that
 *  says the number is NOT in years (months/weeks/days) keeps the whole text instead, so
 *  "6 months" never becomes "6 yrs". Text with no leading number stays as plain text. */
export function formatExperience(raw?: string | null): ExperienceParts | null {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?))?(\+)?(?![\d.])(.*)$/i);
  if (!m || /^\s*(?:months?|mos?|weeks?|days?)\b/i.test(m[4]) || Math.max(+m[1], +(m[2] ?? 0)) > 60) return { text: s };  // >60 isn't a years-of-experience figure
  const num = `${m[1]}${m[2] ? `–${m[2]}` : ''}${m[3] ?? ''}`;
  return { num, unit: 'yrs' };
}

export interface MetaItem { key: string; value: ExperienceParts }
export interface MetaPlacement extends MetaItem { col: 0 | 1; row: number; span2: boolean }

export interface MetaPlan {
  placements: MetaPlacement[];
  /** x offset (from the meta grid's left edge) of the second column. */
  col1X: number;
}

/** Plan the role block's meta grid (Location, Experience, Team). The two columns are NOT
 *  equal: "5–10 yrs" needs far less room than "Hyderabad, Bangalore", so the boundary moves
 *  to give the wider value room instead of shrinking it next to its short neighbour — but it
 *  never moves left of the half-way gridline, so a normal role keeps the reference layout.
 *  `widthOf(item)` is the item's natural width at full size; `minShrink` is how far a value
 *  may still be scaled down (13%) before we pick a different arrangement.
 *   3 items, default  — Location | Experience on row 0, Team spanning row 1 (the R019 reference);
 *   3 items, Location can't fit even widened — Location spans row 0, Experience | Team share row 1;
 *   2 items — side by side if both fit, otherwise stacked full-width;  1 item — full width.
 *  Never more than two rows: the block is a fixed height. */
export function planMeta(
  items: MetaItem[], widthOf: (item: MetaItem) => number, metaW: number, gap = 28, minShrink = 0.87,
): MetaPlan {
  const half = metaW / 2;
  const at = (it: MetaItem, col: 0 | 1, row: number, span2: boolean): MetaPlacement => ({ ...it, col, row, span2 });
  const fits = (it: MetaItem, avail: number) => widthOf(it) * minShrink <= avail;
  const boundary = (a: MetaItem, b: MetaItem) => {
    if (widthOf(a) + gap <= half) return half;
    return Math.max(half, Math.min(widthOf(a) + gap, metaW - widthOf(b) * minShrink - 8));
  };

  if (items.length === 0) return { placements: [], col1X: half };
  if (items.length === 1) return { placements: [at(items[0], 0, 0, true)], col1X: half };
  if (items.length === 2) {
    const b = boundary(items[0], items[1]);
    return fits(items[0], b - gap) && fits(items[1], metaW - b)
      ? { placements: [at(items[0], 0, 0, false), at(items[1], 1, 0, false)], col1X: b }
      : { placements: [at(items[0], 0, 0, true), at(items[1], 0, 1, true)], col1X: half };
  }
  const [a, b, c] = items;
  const b1 = boundary(a, b);
  if (!fits(a, b1 - gap)) {
    const b2 = boundary(b, c);
    if (fits(b, b2 - gap) && fits(c, metaW - b2)) {
      return { placements: [at(a, 0, 0, true), at(b, 0, 1, false), at(c, 1, 1, false)], col1X: b2 };
    }
  }
  return { placements: [at(a, 0, 0, false), at(b, 1, 0, false), at(c, 0, 1, true)], col1X: b1 };
}

// ─── Skill chips ────────────────────────────────────────────────────────────
export interface ChipIn { text: string; isGreen?: boolean }
export interface ChipPlaced { text: string; green: boolean; x: number; w: number }
export interface ChipRows { rows: ChipPlaced[][]; dropped: number }

const MAX_CHIP_CHARS = 26;

function chipWidth(text: string, measure: Measure): number {
  return measure(text, 'figBold', GEO.chipFont, GEO.chipSpacing * GEO.chipFont) + 2 * GEO.chipPadX;
}

function flow(chips: { text: string; green: boolean; w: number }[], breakAtGroup: boolean): typeof chips[] {
  const rows: typeof chips[] = [];
  let cur: typeof chips = [];
  let curW = 0;
  const flush = () => { if (cur.length) rows.push(cur); cur = []; curW = 0; };
  chips.forEach((c, i) => {
    if (breakAtGroup && i > 0 && c.green !== chips[i - 1].green) flush();
    const add = (cur.length ? GEO.chipGap : 0) + c.w;
    if (cur.length && curW + add > CONTENT_W) flush();
    curW += (cur.length ? GEO.chipGap : 0) + c.w;
    cur.push(c);
  });
  flush();
  return rows;
}

/** Normalise, order (craft/blue chips first, sector/green chips second) and
 *  pack the role's tags into at most two centred rows — dropping trailing tags
 *  rather than ever growing a third row, which would break the vertical rhythm. */
export function packChips(tags: ChipIn[] | undefined, measure: Measure): ChipRows {
  const seen = new Set<string>();
  const clean = (tags ?? [])
    .map(t => ({ text: cleanText(String(t?.text ?? '')).toUpperCase(), green: !!t?.isGreen }))
    .filter(t => t.text && !seen.has(t.text) && !!seen.add(t.text))
    .map(t => ({ ...t, text: t.text.length > MAX_CHIP_CHARS ? t.text.slice(0, MAX_CHIP_CHARS - 1).trimEnd() + '…' : t.text }));
  const ordered = [...clean.filter(t => !t.green), ...clean.filter(t => t.green)]
    .map(t => ({ ...t, w: chipWidth(t.text, measure) }));

  let kept = ordered;
  let rows = flow(kept, true);
  if (rows.length > GEO.chipMaxRows) rows = flow(kept, false);
  while (rows.length > GEO.chipMaxRows && kept.length) {
    kept = kept.slice(0, -1);
    rows = flow(kept, false);
  }
  const placed = rows.map(r => {
    const total = r.reduce((s, c) => s + c.w, 0) + GEO.chipGap * (r.length - 1);
    let x = MARGIN + (CONTENT_W - total) / 2;
    return r.map(c => { const p = { text: c.text, green: c.green, x, w: c.w }; x += c.w + GEO.chipGap; return p; });
  });
  return { rows: placed, dropped: ordered.length - kept.length };
}

export function chipsBlockHeight(rowCount: number): number {
  return rowCount === 0 ? 0 : rowCount * GEO.chipH + (rowCount - 1) * GEO.chipGap;
}

// ─── Job / You columns ──────────────────────────────────────────────────────
export interface Bullet { lead: string; desc: string }

/** "<b>Label:</b> Description" (the generator's format) → lead + detail.
 *  Also copes with "Label: Description" and bare text. */
export function parseBullet(raw: string): Bullet {
  const s = String(raw ?? '').trim();
  const b = s.match(/^<b>(.*?)<\/b>\s*:?\s*(.*)$/is);
  let lead: string, desc: string;
  if (b) { lead = b[1]; desc = b[2]; }
  else {
    const c = stripTags(s).match(/^([^:]{2,32}):\s+(.+)$/);
    if (c) { lead = c[1]; desc = c[2]; } else { lead = stripTags(s); desc = ''; }
  }
  lead = cleanText(lead).replace(/[:.\s]+$/, '');
  desc = cleanText(desc).replace(/\.+$/, '');
  return { lead, desc };
}

export interface RowLayout {
  lead: string; leadSize: number;
  descLines: string[]; descSize: number;
  h: number; // content height only (no padding/rule)
}
export interface ColumnsLayout {
  rows: { left?: RowLayout; right?: RowLayout; h: number; pad: number }[];
  scale: number;
  headerH: number;
  total: number;
  overflow: boolean;
}

export const COLS = {
  textX: 46,            // index gutter (30) + gap (16)
  leadSize: 28, descSize: 22.5,
  leadLH: 1.15, descLH: 1.25,
  leadDescGap: 3,
  pad: 12,
  headerH: 64,          // rule + heading + spacing before the first row
  maxPad: 18,
  spareThreshold: 24,   // px of unused height before rows are allowed to breathe
  minScale: 0.85,
} as const;

const TEXT_W = GEO.colW - COLS.textX; // 392

function layoutRow(b: Bullet, s: number, maxDescLines: number, measure: Measure): RowLayout {
  const lead = fitSingleLine(b.lead, 'figBold', TEXT_W, COLS.leadSize * s, COLS.leadSize * s * 0.8, -0.015, measure);
  const dSize = COLS.descSize * s;
  const dw = (t: string, sz = dSize) => measure(t, 'fig', sz, 0);
  let descLines: string[] = [];
  let descSize = dSize;
  if (b.desc) {
    if (dw(b.desc) <= TEXT_W) descLines = [b.desc];
    else {
      const shrunk = fitSingleLine(b.desc, 'fig', TEXT_W, dSize, dSize * 0.9, 0, measure);
      if (shrunk.text === b.desc) { descLines = [b.desc]; descSize = shrunk.size; }
      else descLines = wrapLines(b.desc, TEXT_W, maxDescLines, t => dw(t));
    }
  }
  const h = lead.size * COLS.leadLH + (descLines.length ? COLS.leadDescGap * s + descLines.length * descSize * COLS.descLH : 0);
  return { lead: lead.text, leadSize: lead.size, descLines, descSize, h };
}

/** Fit both columns into `availH` (header + rows). Rows are shared across the
 *  two columns so the hairlines line up. Tries natural size first, then scales
 *  type and padding down to 85%, then single-line details; if the content is
 *  still too tall it reports `overflow` (the renderer clips rather than
 *  overlapping the CTA). When there's room to spare, rows breathe a little. */
export function layoutColumns(
  left: Bullet[], right: Bullet[], availH: number, measure: Measure,
): ColumnsLayout {
  const n = Math.max(left.length, right.length);
  if (n === 0) return { rows: [], scale: 1, headerH: 0, total: 0, overflow: false };

  const attempt = (s: number, maxDescLines: number): ColumnsLayout => {
    const pad = COLS.pad * s;
    const rows = Array.from({ length: n }, (_, i) => {
      const l = left[i] ? layoutRow(left[i], s, maxDescLines, measure) : undefined;
      const r = right[i] ? layoutRow(right[i], s, maxDescLines, measure) : undefined;
      return { left: l, right: r, h: Math.max(l?.h ?? 0, r?.h ?? 0) + 2 * pad + 1, pad };
    });
    const headerH = COLS.headerH * s;
    const total = headerH + rows.reduce((t, r) => t + r.h, 0);
    return { rows, scale: s, headerH, total, overflow: total > availH + 0.5 };
  };

  let result = attempt(1, 2);
  for (const [s, lines] of [[0.95, 2], [0.9, 2], [0.85, 2], [0.85, 1]] as const) {
    if (!result.overflow) break;
    result = attempt(s, lines);
  }
  if (!result.overflow && availH - result.total > COLS.spareThreshold) {
    // A sparse role (few rows) would leave a dead band above the apply bar, so let rows breathe a
    // little — but only past a threshold, so a normal role keeps the exact designed row pitch.
    const extra = Math.min((availH - result.total) / (2 * n), COLS.maxPad - result.rows[0].pad);
    if (extra > 0) {
      result.rows = result.rows.map(r => ({ ...r, pad: r.pad + extra, h: r.h + 2 * extra }));
      result.total += 2 * extra * n;
    }
  }
  return result;
}
