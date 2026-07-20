/**
 * Long-form JD PDF renderer — Node/TypeScript port of the `digitalpaani-long-jd`
 * skill's `jd_generator.py` (ReportLab/Platypus). See that script (referenced
 * from the skill's `references/` folder) for the ONLY ground truth on visual
 * design — colors, fonts, spacing, and icon path data below are copied from it
 * verbatim wherever the two rendering engines allow a literal port, and
 * approximated (documented inline) where pdfmake's flow-based layout model
 * can't reproduce ReportLab's absolute-canvas drawing 1:1.
 *
 * Engine notes (see also src/types/pdfmake.d.ts):
 * - pdfmake ships no .d.ts of its own (checked node_modules/pdfmake/package.json
 *   — no `types`/`typings` field, no `interfaces.d.ts`); a minimal ambient
 *   declaration lives at src/types/pdfmake.d.ts.
 * - Standard-14 fonts need no vfs/embedding: pdfmake's FontProvider just calls
 *   pdfkit's `.font(name)` with the descriptor string, and pdfkit resolves
 *   'Helvetica', 'Helvetica-Bold', etc. from its built-in AFM metrics with no
 *   file I/O — verified by reading node_modules/pdfmake/src/fontProvider.js.
 * - Text measurement (chip widths, header-card height, greedy tag/chip
 *   wrapping) uses a throwaway `pdfkit` PDFDocument's `.widthOfString()`
 *   rather than hand-rolled metrics — `pdfkit` is already a direct dependency
 *   here (with @types/pdfkit) and uses the exact same base-14 AFM tables
 *   pdfmake's own bundled `@foliojs-fork/pdfkit` does (verified empirically:
 *   both report identical widths for the same string/font/size).
 * - Background-filled "cards" with unknown-until-wrapped content height
 *   (HighlightBox, Why2x2, chip pills) are built as pdfmake `table` nodes with
 *   a custom `layout` (fillColor / selective border widths) instead of
 *   ReportLab's roundRect — tables auto-fit their row height to wrapped
 *   content for free, at the cost of losing rounded corners (see "Design
 *   compromises" in the file-level comment at the bottom... actually noted
 *   inline at each call site below).
 */

import PdfPrinter from 'pdfmake';
import PDFDocument from 'pdfkit';
import { Role } from '../../types/index.js';
import { JdContent, JdTag, WhyJoinUsItem } from '../jdContent.js';
import {
  LONG_JD_COLORS as C,
  ICON_COLORS,
  WHY_ICON_BG,
  ABOUT_DP_BULLETS,
  LONG_JD_FOOTER_NOTE,
  HEADER_TAGLINE,
  FOOTER_CONTACT,
  LOGO_PATH,
  WhyIconKey,
} from './theme.js';

// ─────────────────────────────────────────────────────────────────────────
// Units & page layout (mm → pt, matching jd_generator.py's PAGE_MARGIN /
// CONTENT_MARGIN / HEADER_H / FOOTER_H exactly)
// ─────────────────────────────────────────────────────────────────────────

const MM = 2.8346456693; // 1mm in pt (72pt / 25.4mm)
const mm = (v: number) => v * MM;

const PAGE_W = 595.28; // pdfmake's own A4 constant (standardPageSizes.js) — matched exactly so our
const PAGE_H = 841.89; // hand-computed margins/positions line up with what pdfmake actually lays out.

const PAGE_MARGIN = mm(8);
const CONTENT_MARGIN = mm(14);
const HEADER_H = mm(20);
const FOOTER_H = mm(11);

const BORDER_X = PAGE_MARGIN;
const BORDER_W = PAGE_W - 2 * PAGE_MARGIN;
const BORDER_H = PAGE_H - 2 * PAGE_MARGIN;

// pdfmake places `header` content inside exactly [0, pageMargins.top] and
// `footer` inside exactly [pageHeight - pageMargins.bottom, pageHeight] (both
// full page width) — see layoutBuilder.js's headerSizeFct/footerSizeFct. So
// the "gap" the Python leaves between the header/footer chrome and the
// content frame (5mm in FRAME_Y/FRAME_H) has to be folded into the margin.
const TOP_MARGIN = PAGE_MARGIN + HEADER_H + mm(5);
const BOTTOM_MARGIN = PAGE_MARGIN + FOOTER_H + mm(5);
const SIDE_MARGIN = PAGE_MARGIN + CONTENT_MARGIN;

const FRAME_W = PAGE_W - 2 * SIDE_MARGIN;

// ─────────────────────────────────────────────────────────────────────────
// Text measurement — a throwaway pdfkit doc used purely for
// `.widthOfString()`, never rendered/piped anywhere. Gives byte-identical
// widths to reportlab's stringWidth()-driven greedy-wrap logic since both
// pdfkit forks embed the same base-14 AFM tables (verified empirically).
// ─────────────────────────────────────────────────────────────────────────

const measureDoc = new PDFDocument({ autoFirstPage: false });

function textWidth(text: string, font: string, size: number): number {
  measureDoc.font(font).fontSize(size);
  return measureDoc.widthOfString(text);
}

// ─────────────────────────────────────────────────────────────────────────
// Inline `<b>...</b>` → pdfmake rich-text spans (theme.ts's ABOUT_DP_BULLETS
// and LONG_JD_FOOTER_NOTE, plus any AI-generated content string, use this
// lightweight HTML-ish markup instead of real HTML).
// ─────────────────────────────────────────────────────────────────────────

interface Span {
  text: string;
  bold?: boolean;
}

function parseInlineBold(text: string): Span[] {
  const spans: Span[] = [];
  const re = /<b>(.*?)<\/b>/gs;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      spans.push({ text: text.slice(lastIndex, match.index) });
    }
    spans.push({ text: match[1], bold: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    spans.push({ text: text.slice(lastIndex) });
  }
  return spans.length > 0 ? spans : [{ text }];
}

// ─────────────────────────────────────────────────────────────────────────
// Icons — inline SVG, ported from jd_generator.py's Path/Circle/Polygon calls.
// ReportLab's Drawing/Path API is Y-up (origin bottom-left); SVG is Y-down.
// Each icon's geometry is wrapped in <g transform="translate(0,H) scale(1,-1)">
// so the Python's moveTo/curveTo/lineTo numeric coordinates can be copied in
// verbatim as SVG M/C/L commands (curveTo(x1,y1,x2,y2,x3,y3) -> C x1,y1
// x2,y2,x3,y3) — flipping the coordinate system is lossless for freshly
// authored paths/shapes. It is NOT lossless for <text> glyphs (a flipped
// transform mirrors the glyph itself upside down), so the one icon with a
// text glyph (why_pay's "$") draws that glyph in a separate, non-flipped
// sibling node positioned by converting its y-up baseline to a y-down one.
// ─────────────────────────────────────────────────────────────────────────

type MetaIconKind = 'pin' | 'building' | 'grad' | 'tag';

function metaIconSvg(kind: MetaIconKind): string {
  const flip = (inner: string) =>
    `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g transform="translate(0,24) scale(1,-1)">${inner}</g></svg>`;

  switch (kind) {
    case 'pin':
      return flip(
        `<path fill="${ICON_COLORS.pin}" d="M12,22 C12,22 5,14.25 5,9 C5,5.13 8.13,2 12,2 C15.87,2 19,5.13 19,9 C19,14.25 12,22 12,22 Z"/>` +
          `<circle cx="12" cy="9" r="2.5" fill="#ffffff"/>`
      );
    case 'building': {
      const windows = [
        [6, 15], [10, 15], [14, 15],
        [6, 11], [10, 11], [14, 11],
      ]
        .map(([x, y]) => `<rect x="${x}" y="${y}" width="2.5" height="2.5" fill="#ffffff"/>`)
        .join('');
      return flip(
        `<path fill="${ICON_COLORS.building}" d="M4,21 L4,7 L12,3 L20,7 L20,21 Z"/>${windows}`
      );
    }
    case 'grad':
      return flip(
        `<path fill="${ICON_COLORS.grad}" d="M12,3 L23,9 L12,15 L1,9 Z"/>` +
          `<path fill="${ICON_COLORS.grad}" d="M6,13 L6,16 C6,18.2 8.7,20 12,20 C15.3,20 18,18.2 18,16 L18,13 L12,16 Z"/>`
      );
    case 'tag':
      return flip(
        `<path fill="${ICON_COLORS.tag}" d="M21,11.5 L12.5,3 L4,3 L4,11.5 L12.5,20 Z"/>` +
          `<circle cx="7" cy="7" r="1.3" fill="#ffffff"/>`
      );
  }
}

/** 10-point star polygon (5-point star), matching why_startup/why_ownership's
 * `math.cos`/`math.sin` loop exactly rather than hand-computed coordinates. */
function starPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const ang = Math.PI / 2 - (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    pts.push(`${(cx + rr * Math.cos(ang)).toFixed(2)},${(cy + rr * Math.sin(ang)).toFixed(2)}`);
  }
  return pts.join(' ');
}

function whyIconSvg(key: WhyIconKey): string {
  const s = 20; // fixed 20x20 viewBox, matching _circle_icon(size=20)
  const bg = WHY_ICON_BG[key];
  const bgCircle = `<circle cx="${s / 2}" cy="${s / 2}" r="${s / 2}" fill="${bg}"/>`;
  const flip = (inner: string) =>
    `<svg viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg"><g transform="translate(0,${s}) scale(1,-1)">${bgCircle}${inner}</g></svg>`;

  switch (key) {
    case 'pay': {
      // "$" glyph can't live inside the Y-flipped group (would render upside
      // down) — draw it as a separate, non-flipped sibling. Python's
      // String(s/2, s*0.3, ...) baseline is y-up; y-down baseline = s - (s*0.3).
      const x = s / 2;
      const yUp = s * 0.3;
      const yDown = s - yUp;
      return (
        `<svg viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">` +
        `<g transform="translate(0,${s}) scale(1,-1)">${bgCircle}</g>` +
        `<text x="${x}" y="${yDown}" font-family="Helvetica-Bold" font-weight="bold" font-size="${s * 0.55}" text-anchor="middle" fill="#ffffff">$</text>` +
        `</svg>`
      );
    }
    case 'impact':
      return flip(
        `<circle cx="${s / 2}" cy="${s / 2}" r="${s * 0.28}" fill="#ffffff"/>` +
          `<line x1="${s * 0.22}" y1="${s / 2}" x2="${s * 0.78}" y2="${s / 2}" stroke="${bg}" stroke-width="${s * 0.06}"/>`
      );
    case 'growth':
      return flip(
        `<path fill="#ffffff" d="M${s * 0.25},${s * 0.4} L${s * 0.42},${s * 0.58} L${s * 0.56},${s * 0.48} L${s * 0.75},${s * 0.7} L${s * 0.75},${s * 0.6} L${s * 0.6},${s * 0.42} L${s * 0.42},${s * 0.52} L${s * 0.32},${s * 0.38} Z"/>`
      );
    case 'team':
      return flip(
        `<circle cx="${s * 0.5}" cy="${s * 0.62}" r="${s * 0.12}" fill="#ffffff"/>` +
          `<path fill="#ffffff" d="M${s * 0.3},${s * 0.38} L${s * 0.7},${s * 0.38} L${s * 0.65},${s * 0.28} L${s * 0.35},${s * 0.28} Z"/>`
      );
    case 'startup':
      return flip(`<polygon fill="#ffffff" points="${starPoints(s / 2, s / 2, s * 0.32)}"/>`);
    case 'mission':
      return flip(
        `<circle cx="${s / 2}" cy="${s / 2}" r="${s * 0.3}" fill="none" stroke="#ffffff" stroke-width="${s * 0.06}"/>` +
          `<circle cx="${s / 2}" cy="${s / 2}" r="${s * 0.13}" fill="#ffffff"/>`
      );
    case 'domain':
      return flip(
        `<path fill="none" stroke="#ffffff" stroke-width="${s * 0.1}" stroke-linecap="round" stroke-linejoin="round" ` +
          `d="M${s * 0.28},${s * 0.5} L${s * 0.45},${s * 0.35} L${s * 0.72},${s * 0.62}"/>`
      );
    case 'influence':
      return flip(
        `<circle cx="${s / 2}" cy="${s / 2}" r="${s * 0.32}" fill="none" stroke="#ffffff" stroke-width="${s * 0.06}"/>` +
          `<line x1="${s / 2}" y1="${s / 2}" x2="${s / 2}" y2="${s * 0.72}" stroke="#ffffff" stroke-width="${s * 0.07}"/>` +
          `<line x1="${s / 2}" y1="${s / 2}" x2="${s * 0.66}" y2="${s / 2}" stroke="#ffffff" stroke-width="${s * 0.07}"/>`
      );
    case 'ownership':
      return flip(`<polygon fill="#ffffff" points="${starPoints(s / 2, s / 2, s * 0.28)}"/>`);
    case 'learn':
      return flip(
        `<path fill="#ffffff" d="M${s * 0.25},${s * 0.65} L${s * 0.25},${s * 0.35} L${s * 0.5},${s * 0.42} L${s * 0.75},${s * 0.35} L${s * 0.75},${s * 0.65} L${s * 0.5},${s * 0.58} Z"/>` +
          `<line x1="${s * 0.5}" y1="${s * 0.42}" x2="${s * 0.5}" y2="${s * 0.58}" stroke="#16a085" stroke-width="${s * 0.04}"/>`
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Bullet markers — small filled canvas polygons, ported point-for-point from
// Bullets.draw()'s three `pts` arrays. Deliberately NOT rendered as Unicode
// glyphs (▶ / ◆): standard-14 fonts use WinAnsiEncoding, which doesn't cover
// those codepoints, so a real glyph render would be a gamble; a hand-drawn
// shape renders identically regardless of font/encoding.
// ─────────────────────────────────────────────────────────────────────────

type BulletStyle = 'arrow' | 'must' | 'good';

function bulletMarkerCanvas(style: BulletStyle): unknown[] {
  // fill-only (no lineColor), matching the Python's `drawPath(pth, fill=1, stroke=0)`
  if (style === 'must') {
    return [{
      type: 'polyline', closePath: true, color: C.navy,
      points: [{ x: 6, y: 1 }, { x: 9, y: 4 }, { x: 6, y: 7 }, { x: 3, y: 4 }],
    }];
  }
  if (style === 'good') {
    return [{
      type: 'polyline', closePath: true, color: C.teal,
      points: [{ x: 6, y: 1 }, { x: 10, y: 4 }, { x: 6, y: 7 }, { x: 2, y: 4 }],
    }];
  }
  return [{
    type: 'polyline', closePath: true, color: C.accent,
    points: [{ x: 2, y: 2 }, { x: 9, y: 5 }, { x: 2, y: 8 }],
  }];
}

/** One bullet row: small marker glyph in a fixed-width column + wrapping body text. */
function bulletRow(item: string, style: BulletStyle) {
  return {
    columns: [
      { width: 12, margin: [0, 3, 0, 0], canvas: bulletMarkerCanvas(style) },
      { width: '*', text: parseInlineBold(item), font: 'Helvetica', fontSize: 9, color: C.bodyTxt, lineHeight: 1.3 },
    ],
    columnGap: 2,
  };
}

/** A vertical list of bulletRow()s with a thin separator between (not after
 * the last) item — ports Bullets' hairline `HexColor('#eef3f7')` rule. */
function bulletsList(items: string[], style: BulletStyle) {
  const stack: unknown[] = [];
  items.forEach((item, i) => {
    stack.push(bulletRow(item, style));
    if (i < items.length - 1) {
      stack.push({
        canvas: [{ type: 'line', x1: 0, y1: 0, x2: FRAME_W, y2: 0, lineWidth: 0.5, lineColor: C.bulletSeparator }],
        margin: [0, 4, 0, 4],
      });
    }
  });
  return { stack, margin: [0, 0, 0, 0] };
}

// ─────────────────────────────────────────────────────────────────────────
// Section label — Courier-Bold 7.5pt accent-colored heading + thin rule.
// ─────────────────────────────────────────────────────────────────────────

function sectionLabel(text: string, width: number = FRAME_W) {
  return {
    stack: [
      { text: text.toUpperCase(), font: 'Courier', bold: true, fontSize: 7.5, color: C.accent },
      {
        canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.7, lineColor: C.border }],
        margin: [0, 3, 0, 0],
      },
    ],
    margin: [0, 0, 0, 6],
  };
}

// Ports `section()`'s Python counterpart exactly: `KeepTogether([label,
// Spacer(1,4), first])` wraps only the label + first flowable (not the whole
// section) so a page break can never orphan a section header from its
// content — verified empirically (a plain, non-unbreakable stack let "WHY
// JOIN US" land as the last line of a page with its 2x2 grid pushed to the
// next).
function section(label: string, ...content: unknown[]) {
  const [first, ...rest] = content;
  const head = { unbreakable: true, stack: [sectionLabel(label), ...(first !== undefined ? [first] : [])] };
  return { stack: [head, ...rest], margin: [0, 0, 0, 10] };
}

// ─────────────────────────────────────────────────────────────────────────
// Gradient card header band — 20-band interpolation, ported from
// CardHeader.draw()'s band loop. pdfmake has no native top-to-bottom canvas
// gradient fill for a flowed content node (its built-in `linearGradient` on a
// canvas rect is hardcoded left-to-right, per printer.js — verified by
// reading the source — which is the wrong axis for this design), so we
// approximate it exactly the way the Python does: N thin stacked rects, each
// a linearly-interpolated color.
// ─────────────────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpColor(topHex: string, botHex: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(topHex);
  const [r2, g2, b2] = hexToRgb(botHex);
  const r = Math.round(r1 * (1 - t) + r2 * t);
  const g = Math.round(g1 * (1 - t) + g2 * t);
  const b = Math.round(b1 * (1 - t) + b2 * t);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function gradientBandsCanvas(width: number, height: number, topHex: string, botHex: string): unknown[] {
  const bands = 20;
  const bandH = height / bands;
  const vectors: unknown[] = [];
  for (let i = 0; i < bands; i++) {
    const t = i / (bands - 1);
    vectors.push({
      type: 'rect', x: 0, y: i * bandH, w: width, h: bandH + 0.5,
      color: lerpColor(topHex, botHex, t),
    });
  }
  // bottom border line, matching CardHeader.draw()'s `c.line(0,0,w,0)`
  vectors.push({ type: 'line', x1: 0, y1: height, x2: width, y2: height, lineWidth: 0.5, lineColor: C.border });
  return vectors;
}

// ─────────────────────────────────────────────────────────────────────────
// Greedy row-wrap helper — generic port of CardHeader.draw()'s tag-chip x/y
// tracking loop and _calc_height()'s row-count estimate.
// ─────────────────────────────────────────────────────────────────────────

function wrapGreedy<T>(items: T[], itemWidth: (item: T) => number, maxWidth: number, gap: number): T[][] {
  const rows: T[][] = [];
  let row: T[] = [];
  let rowW = 0;
  for (const item of items) {
    const w = itemWidth(item);
    if (row.length > 0 && rowW + gap + w > maxWidth) {
      rows.push(row);
      row = [];
      rowW = 0;
    }
    if (row.length > 0) rowW += gap;
    row.push(item);
    rowW += w;
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// Tag chips — rounded-rect pill (canvas) + overlaid label. Width is measured
// exactly (pdfkit widthOfString), matching draw()'s `stringWidth(...,'Helvetica-Bold',7) + 13`.
// ─────────────────────────────────────────────────────────────────────────

function chipWidth(text: string): number {
  return textWidth(text.toUpperCase(), 'Helvetica-Bold', 7) + 13;
}

function chip(tag: JdTag) {
  const w = chipWidth(tag.text);
  const bg = tag.isGreen ? C.tagGreen : C.tagBlue;
  const fg = tag.isGreen ? C.tagGreenTxt : C.tagBlueTxt;
  return {
    width: w,
    stack: [
      { canvas: [{ type: 'rect', x: 0, y: 0, w, h: 12, r: 3, color: bg }] },
      { text: tag.text.toUpperCase(), font: 'Helvetica', bold: true, fontSize: 7, color: fg, margin: [6, -9.5, 0, 0] },
    ],
  };
}

function tagRows(tags: JdTag[]): unknown[] {
  const rows = wrapGreedy(tags, (t) => chipWidth(t.text), FRAME_W - 28, 5);
  return rows.map((row, i) => ({
    columns: row.map(chip),
    columnGap: 5,
    margin: [0, i === 0 ? 0 : 5, 0, 0],
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Card header — title/subtitle/meta/tags over the gradient band. Built as a
// canvas background node immediately followed by a negatively-margined
// overlay stack (a standard pdfmake technique for laying content "on top of"
// a preceding canvas/background node — there's no z-index/absolute-within-
// flow primitive otherwise). Vertical rhythm inside the card (gaps between
// title/subtitle/meta/tags) is a close approximation of the Python's pixel
// offsets, not a pixel-exact port — see file header note on visual
// verification constraints (no local PDF rasterizer in this environment).
// ─────────────────────────────────────────────────────────────────────────

function metaRow(role: Role): unknown[] {
  const items: Array<{ icon: MetaIconKind; label: string }> = [
    { icon: 'pin', label: role.location || 'Location TBD' },
    { icon: 'building', label: role.employment_type || 'Full-Time' },
    {
      icon: 'grad',
      label: role.yoe_required
        ? /year/i.test(role.yoe_required) ? role.yoe_required : `${role.yoe_required} Experience`
        : 'Experience TBD',
    },
    { icon: 'tag', label: role.department || 'General' },
  ];

  const columns: unknown[] = [];
  items.forEach((item, i) => {
    columns.push({ svg: metaIconSvg(item.icon), width: 11, height: 11 });
    columns.push({
      text: item.label, font: 'Helvetica', bold: true, fontSize: 8.5, color: C.text,
      width: 'auto', margin: [3, 1.5, 0, 0],
    });
    if (i < items.length - 1) {
      columns.push({
        width: 'auto', margin: [8, 0, 8, 0],
        canvas: [{ type: 'line', x1: 0, y1: 0, x2: 0, y2: 11, lineWidth: 0.6, lineColor: C.metaDivider }],
      });
    }
  });
  return columns;
}

function cardHeader(role: Role, content: JdContent) {
  const topCol = content.variant === 'tech' ? C.headerTech[0] : C.headerInfra[0];
  const botCol = content.variant === 'tech' ? C.headerTech[1] : C.headerInfra[1];

  // ── height estimate, mirroring _calc_height() ──
  const tagRowCountEstimate = wrapGreedy(
    content.tags,
    (t) => textWidth(t.text.toUpperCase(), 'Helvetica-Bold', 7.5) + 20,
    FRAME_W - 16,
    6
  ).length || 1;

  const TOP_PAD = 24;
  const TITLE_H = 18;
  const SUBTITLE_H = 15;
  const META_H = 16;
  const TAG_ROW_H = 16;
  const BOTTOM_PAD = 12;
  const cardHeight = TOP_PAD + TITLE_H + SUBTITLE_H + META_H + tagRowCountEstimate * TAG_ROW_H + BOTTOM_PAD;

  const subtitle = [role.department, role.location, role.employment_type].filter(Boolean).join('   ·   ');

  const overlay = {
    margin: [14, -(cardHeight) + 16, 14, 0],
    stack: [
      { text: role.title || 'Untitled Role', font: 'Helvetica', bold: true, fontSize: 14, color: C.navy },
      { text: subtitle, font: 'Helvetica', italics: true, fontSize: 9, color: C.muted, margin: [0, 4, 0, 0] },
      { columns: metaRow(role), margin: [0, 10, 0, 0] },
      { stack: tagRows(content.tags), margin: [0, 8, 0, 0] },
    ],
  };

  return {
    unbreakable: true,
    stack: [
      { canvas: gradientBandsCanvas(FRAME_W, cardHeight, topCol, botCol) },
      overlay,
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Highlight box — HighlightBox ported as a single-cell table: fillColor for
// the light-blue background, a 4pt-wide left vLine for the teal accent bar.
// Table rows auto-fit wrapped paragraph height (unlike ReportLab, which had
// to pre-wrap the Paragraph to compute an exact box height by hand) — the
// tradeoff is square corners instead of HighlightBox's 5pt roundRect corners.
// ─────────────────────────────────────────────────────────────────────────

function highlightBox(quote: string, width: number = FRAME_W) {
  return {
    table: {
      widths: [width],
      body: [[{
        text: [{ text: '"' }, ...parseInlineBold(quote), { text: '"' }],
        font: 'Helvetica', italics: true, fontSize: 9, color: C.highlightText, lineHeight: 1.3,
      }]],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: (i: number) => (i === 0 ? 4 : 0),
      vLineColor: () => C.accent,
      paddingLeft: (i: number) => (i === 0 ? 10 : 6),
      paddingRight: () => 8,
      paddingTop: () => 8,
      paddingBottom: () => 8,
      fillColor: () => C.lightBlue,
    },
    margin: [0, 3, 0, 0],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Role Requirements — two-column table, ported from TwoColList. Diamond
// bullet markers reuse bulletRow()'s canvas-polygon technique ('must'/'good'
// styles) rather than the Python's literal "&#x25C6;" Unicode glyph — Adobe's
// base-14 standard fonts are WinAnsiEncoding-only and don't cover U+25C6, so
// a drawn shape is the only encoding-safe option in pdfkit.
// ─────────────────────────────────────────────────────────────────────────

function twoColRequirements(
  leftLabel: string, leftItems: string[],
  rightLabel: string, rightItems: string[],
): unknown {
  const colW = (FRAME_W - 16) / 2;
  const maxRows = Math.max(leftItems.length, rightItems.length);

  const body: unknown[][] = [
    [sectionLabel(leftLabel, colW), sectionLabel(rightLabel, colW)],
  ];
  for (let i = 0; i < maxRows; i++) {
    body.push([
      i < leftItems.length ? bulletRow(leftItems[i], 'must') : '',
      i < rightItems.length ? bulletRow(rightItems[i], 'good') : '',
    ]);
  }

  return {
    // headerRows: 1 repeats the "Must Haves"/"Good to Have" label row at the
    // top of the continuation if this table splits across a page break —
    // matching the Python's `Table(..., repeatRows=1)`.
    table: { widths: [colW, colW + 16], body, headerRows: 1 },
    layout: {
      hLineWidth: (i: number) => (i > 1 && i <= maxRows ? 0.4 : 0),
      hLineColor: () => C.bulletSeparator,
      vLineWidth: () => 0,
      paddingLeft: () => 0,
      paddingRight: (i: number) => (i === 0 ? 16 : 0),
      paddingTop: () => 3,
      paddingBottom: () => 3,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Why Join Us — 2x2 grid, ported from Why2x2. Same table-with-fillColor
// tradeoff as highlightBox() (square corners instead of 6pt roundRect).
// ─────────────────────────────────────────────────────────────────────────

function why2x2Cell(item: WhyJoinUsItem) {
  return {
    columns: [
      { svg: whyIconSvg(item.iconKey), width: 20, height: 20 },
      {
        width: '*',
        stack: [
          { text: item.title, font: 'Helvetica', bold: true, fontSize: 9, color: C.navy },
          { text: item.description, font: 'Helvetica', fontSize: 8, color: C.muted, lineHeight: 1.3, margin: [0, 2, 0, 0] },
        ],
      },
    ],
    columnGap: 8,
  };
}

function why2x2(items: WhyJoinUsItem[]) {
  const [a, b, c, d] = items;
  const colW = (FRAME_W - 9) / 2;

  return {
    table: {
      widths: [colW, colW],
      body: [
        [why2x2Cell(a), why2x2Cell(b)],
        [why2x2Cell(c), why2x2Cell(d)],
      ],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: () => 12,
      paddingRight: () => 10,
      paddingTop: () => 12,
      paddingBottom: () => 12,
      fillColor: (rowIndex: number, _node: unknown, columnIndex: number) => {
        const item = [a, b, c, d][rowIndex * 2 + columnIndex];
        return item.isGreen ? C.lightGreen : C.lightBlue;
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Footer note (CTA) — ported from FooterNote.
// ─────────────────────────────────────────────────────────────────────────

function footerNote(): unknown {
  return {
    stack: [
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: FRAME_W, y2: 0, lineWidth: 0.5, lineColor: C.border }] },
      {
        text: parseInlineBold(LONG_JD_FOOTER_NOTE),
        font: 'Helvetica', italics: true, fontSize: 8, color: C.muted, lineHeight: 1.44,
        margin: [0, 6, 0, 0],
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Page chrome — border/header/footer, ported from draw_page_chrome(). Full
// rounded border via the `background` callback (drawn once per page, behind
// content); header/footer navy bands + logo/tagline/contact/page-number via
// the `header`/`footer` callbacks. All three receive page-absolute (0,0)
// coordinate origins per pdfmake's layoutBuilder (addBackground/
// addHeadersAndFooters both commit their block at (0,0) or full pageSize),
// so canvas vectors below use literal page coordinates directly, no
// absolutePosition juggling needed.
// ─────────────────────────────────────────────────────────────────────────

function pageBackground() {
  return {
    canvas: [{
      type: 'rect', x: BORDER_X, y: PAGE_MARGIN, w: BORDER_W, h: BORDER_H,
      r: 6, lineWidth: 1, lineColor: C.border,
    }],
  };
}

// NOTE on the two functions below: pdfmake's `header` callback content is
// committed at page-absolute block origin (0,0) (headerSizeFct returns
// {x:0,y:0,...} — verified in layoutBuilder.js), so canvas vectors in
// pageHeader() are plain page-absolute coordinates. `footer` content is
// committed at block origin (0, pageHeight - pageMargins.bottom) instead
// (footerSizeFct), so pageFooter()'s canvas vectors must be expressed
// relative to THAT local origin, not page-absolute page coordinates — this
// is why the two functions compute their overlay offsets differently.

function pageHeader() {
  const logoH = mm(12);
  const hdrTop = PAGE_MARGIN; // page-absolute (header block origin IS page (0,0))
  const bandBottomExtent = hdrTop + HEADER_H + 1; // canvas node height = max(y+h) over its vectors; +1 for the 2px accent line straddling the band's bottom edge
  const textH = 9; // approx rendered line height of the 7pt tagline, used only to vertically center it against the logo
  return {
    stack: [
      {
        canvas: [
          { type: 'rect', x: BORDER_X, y: hdrTop, w: BORDER_W, h: HEADER_H, color: C.navy },
          { type: 'rect', x: BORDER_X, y: hdrTop + HEADER_H - 1, w: BORDER_W, h: 2, color: C.accent },
        ],
      },
      {
        margin: [0, -bandBottomExtent + hdrTop + (HEADER_H - logoH) / 2, 0, 0],
        // `width: 'auto'` on the left column is required, not cosmetic: an
        // unspecified column width defaults to '*' (verified in
        // columnCalculator.js's isStarColumn), and with two '*' columns the
        // row splits 50/50 — which would right-align the tagline against the
        // row's midpoint instead of its true right edge. 'auto' sizes the
        // left column to the logo's own rendered width and leaves the rest
        // of the row (as '*') to the right-aligned tagline.
        //
        // The 'auto' has to sit on a wrapping `stack`, not the `image` node
        // itself — empirically, an image node reads its own `.width` as a
        // literal numeric render scale (measureImageWithDimensions), so a
        // literal 'auto' string there reaches pdfkit's image transform and
        // throws ("unsupported number: auto"). A stack's width is measured
        // independently of that image-specific path.
        columns: [
          {
            width: 'auto',
            // height-only (no width/fit) lets pdfmake auto-scale width from
            // the image's natural aspect ratio, matching the Python's
            // `logo_w = logo_h * (img.width/img.height)` exactly.
            stack: [{ image: LOGO_PATH, height: logoH }],
            margin: [BORDER_X + mm(8), 0, 0, 0],
          },
          {
            text: HEADER_TAGLINE, font: 'Courier', bold: true, fontSize: 7, color: C.headerRunningText,
            alignment: 'right', margin: [0, (logoH - textH) / 2, BORDER_X + mm(8), 0],
          },
        ],
      },
    ],
  };
}

function pageFooter(currentPage: number) {
  const localTop = mm(5); // local-to-block y where the navy band starts (see note above — footer block origin is NOT page (0,0))
  const textH = 9;
  return {
    stack: [
      {
        canvas: [{ type: 'rect', x: BORDER_X, y: localTop, w: BORDER_W, h: FOOTER_H, color: C.navy }],
      },
      {
        margin: [0, -(FOOTER_H + textH) / 2, 0, 0],
        // same 'auto' vs '*' reasoning as pageHeader() above.
        columns: [
          {
            text: FOOTER_CONTACT, font: 'Helvetica', fontSize: 8, color: C.footerRunningText,
            width: 'auto', margin: [BORDER_X + mm(8), 0, 0, 0],
          },
          {
            text: `Page ${currentPage}`, font: 'Helvetica', fontSize: 8, color: C.footerRunningText,
            alignment: 'right', margin: [0, 0, BORDER_X + mm(8), 0],
          },
        ],
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────

const fonts = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
  Courier: {
    normal: 'Courier',
    bold: 'Courier-Bold',
    italics: 'Courier-Oblique',
    bolditalics: 'Courier-BoldOblique',
  },
};

export async function renderLongFormJd(role: Role, content: JdContent): Promise<Buffer> {
  const printer = new PdfPrinter(fonts);

  const body: unknown[] = [
    cardHeader(role, content),
    { text: '', margin: [0, 6, 0, 0] },
    section('About DigitalPaani', bulletsList(ABOUT_DP_BULLETS, 'arrow')),
    section(
      'About the Role',
      { text: parseInlineBold(content.aboutRoleParagraph), font: 'Helvetica', fontSize: 9, color: C.bodyTxt, alignment: 'justify', lineHeight: 1.44 },
      ...(content.highlightQuote ? [highlightBox(content.highlightQuote)] : []),
    ),
    section('Key Responsibilities', bulletsList(content.keyResponsibilities, 'arrow')),
    section(
      'Role Requirements',
      twoColRequirements('Must Haves', content.mustHaves, content.goodToHaveLabel, content.goodToHaves),
    ),
    section('Why Join Us', why2x2(content.whyJoinUs), { text: '', margin: [0, 6, 0, 0] }, footerNote()),
  ];

  const docDefinition = {
    pageSize: 'A4' as const,
    pageMargins: [SIDE_MARGIN, TOP_MARGIN, SIDE_MARGIN, BOTTOM_MARGIN] as [number, number, number, number],
    defaultStyle: { font: 'Helvetica', fontSize: 9, color: C.bodyTxt },
    background: () => pageBackground(),
    header: () => pageHeader(),
    footer: (currentPage: number) => pageFooter(currentPage),
    info: {
      title: role.title || 'Job Description',
      author: 'DigitalPaani',
    },
    content: body,
  };

  const pdfDoc = printer.createPdfKitDocument(docDefinition);

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
    pdfDoc.on('error', reject);
    pdfDoc.end();
  });
}
