/**
 * Social-sharable JD PDF (1080×1350 portrait) — pdfkit port of the
 * digitalpaani-social-jd skill's social_generator.py (ReportLab, 303 lines).
 * Ground truth is that Python script, not the skill's SKILL.md prose.
 *
 * ── Coordinate system note ──────────────────────────────────────────────────
 * ReportLab's canvas is Y-UP (origin bottom-left); pdfkit is Y-DOWN (origin
 * top-left). Rather than rewriting the layout math from scratch, this file
 * mirrors the Python source's own running `y` variable exactly (same starting
 * value, same `y -= N` decrements, in the same order), and only converts to
 * pdfkit's coordinate space at the moment of each draw call, via `flipY()`
 * plus one of two rules depending on what ReportLab primitive is being
 * reproduced:
 *   - box/rect (corner + extends UPWARD by h):      pdfkit top = flipY(cornerY) - h
 *   - baseline text (drawString/drawCentredString): pdfkit top = flipY(baselineY) - fontSize*ASCENT_RATIO
 *   - point (line endpoint / circle center):        pdfkit y  = flipY(Y)
 * This keeps every numeric constant from the Python source directly traceable
 * here, rather than hand-waving a global re-derivation.
 *
 * Icons additionally need their own internal Y-flip (24-gy per the design
 * grid) independent of the page-level flip above — see drawIcon().
 */

import PDFDocument from 'pdfkit';
import fs from 'fs';
import { Role } from '../../types/index.js';
import { JdContent } from '../jdContent.js';
import {
  SOCIAL_JD_COLORS,
  SOCIAL_TAGLINE,
  SOCIAL_FOOTER_LINE1,
  APPLICATION_FORM_URL,
  LOGO_PATH,
  ICON_COLORS,
} from './theme.js';

const PAGE_WIDTH = 1080;
const PAGE_HEIGHT = 1350;

// Helvetica ascender, per the standard AFM metric (718/1000 em). Used to
// approximate ReportLab's baseline-referenced y positions as pdfkit's
// top-of-box-referenced text() calls.
const ASCENT_RATIO = 0.718;

function flipY(y: number): number {
  return PAGE_HEIGHT - y;
}

// ─── Color helpers ──────────────────────────────────────────────────────────
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function lerpColor(c1: [number, number, number], c2: [number, number, number], t: number): string {
  const mix = (a: number, b: number) => Math.round(a * (1 - t) + b * t);
  const [r, g, b] = [mix(c1[0], c2[0]), mix(c1[1], c2[1]), mix(c1[2], c2[2])];
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

// ─── Gradient background (grad_rect in the Python) ─────────────────────────
function drawGradientBackground(doc: PDFKit.PDFDocument): void {
  const steps = 30;
  const stepH = PAGE_HEIGHT / steps;
  const navy = hexToRgb(SOCIAL_JD_COLORS.navy);
  const navyLight = hexToRgb(SOCIAL_JD_COLORS.navyLight);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const color = lerpColor(navy, navyLight, t);
    doc.rect(0, i * stepH, PAGE_WIDTH, stepH + 0.5).fill(color);
  }
}

// ─── Icons (social's own 4 meta icons — 24-unit design grid, Y-up as
// authored). "Corrected orientation" per the Python's own comments — do not
// reuse the long-form JD's icon shapes, these have different path data. ────
type IconOp =
  | { op: 'move'; x: number; y: number }
  | { op: 'line'; x: number; y: number }
  | { op: 'curve'; cp1x: number; cp1y: number; cp2x: number; cp2y: number; x: number; y: number }
  | { op: 'close' };

interface IconCircle {
  cx: number;
  cy: number;
  r: number;
  color: string;
}

interface IconSpec {
  fill: string;
  path: IconOp[];
  circles?: IconCircle[];
}

type IconKind = 'pin' | 'building' | 'grad' | 'tag';

const ICONS: Record<IconKind, IconSpec> = {
  // Pin pointing down — moveTo/curveTo verbatim from icon_pin()
  pin: {
    fill: ICON_COLORS.pin,
    path: [
      { op: 'move', x: 12, y: 2 },
      { op: 'curve', cp1x: 12, cp1y: 2, cp2x: 5, cp2y: 9.75, x: 5, y: 15 },
      { op: 'curve', cp1x: 5, cp1y: 18.87, cp2x: 8.13, cp2y: 22, x: 12, y: 22 },
      { op: 'curve', cp1x: 15.87, cp1y: 22, cp2x: 19, cp2y: 18.87, x: 19, y: 15 },
      { op: 'curve', cp1x: 19, cp1y: 9.75, cp2x: 12, cp2y: 2, x: 12, y: 2 },
      { op: 'close' },
    ],
    circles: [{ cx: 12, cy: 15, r: 2.5, color: '#ffffff' }],
  },
  // Building facing up — verbatim from icon_building()
  building: {
    fill: ICON_COLORS.building,
    path: [
      { op: 'move', x: 4, y: 3 },
      { op: 'line', x: 4, y: 17 },
      { op: 'line', x: 12, y: 21 },
      { op: 'line', x: 20, y: 17 },
      { op: 'line', x: 20, y: 3 },
      { op: 'close' },
    ],
    circles: ([[6, 9], [10, 9], [14, 9], [6, 13], [10, 13], [14, 13]] as [number, number][]).map(
      ([x, y]) => ({ cx: x + 1.25, cy: y + 1.25, r: 1.2, color: '#ffffff' })
    ),
  },
  // Graduation cap facing up — verbatim from icon_grad() (single flat quad, no band)
  grad: {
    fill: ICON_COLORS.grad,
    path: [
      { op: 'move', x: 12, y: 21 },
      { op: 'line', x: 1, y: 15 },
      { op: 'line', x: 12, y: 9 },
      { op: 'line', x: 23, y: 15 },
      { op: 'close' },
    ],
  },
  // Tag oriented correctly — verbatim from icon_tag()
  tag: {
    fill: ICON_COLORS.tag,
    path: [
      { op: 'move', x: 3, y: 12.5 },
      { op: 'line', x: 11.5, y: 21 },
      { op: 'line', x: 20, y: 21 },
      { op: 'line', x: 20, y: 12.5 },
      { op: 'line', x: 11.5, y: 4 },
      { op: 'close' },
    ],
    circles: [{ cx: 17, cy: 17, r: 1.3, color: '#ffffff' }],
  },
};

/**
 * Draws one meta-row icon. `x` and `originYUp` match the Python call site's
 * `renderPDF.draw(icon_fn(sz), c, x, originYUp)` — i.e. originYUp is the
 * canvas Y-UP position of the icon's own bottom-left corner, on the SAME
 * page-level y-up frame the rest of this file mirrors.
 *
 * Within the icon's own 24-unit design grid, the path was authored Y-up
 * (matching ReportLab's native Drawing coordinate space); pdfkit needs each
 * grid point flipped as (24 - gy) before scaling — this is a SEPARATE flip
 * from the page-level one above, needed because these are actual curved
 * vector paths where getting the orientation wrong is visually obvious
 * (upside-down pin, etc.), not just a coarse block position.
 */
function drawIcon(doc: PDFKit.PDFDocument, kind: IconKind, x: number, originYUp: number, sz: number): void {
  const spec = ICONS[kind];
  const s = sz / 24;
  const px = (gx: number) => x + gx * s;
  const py = (gy: number) => flipY(originYUp) - gy * s;

  spec.path.forEach(op => {
    if (op.op === 'move') doc.moveTo(px(op.x), py(op.y));
    else if (op.op === 'line') doc.lineTo(px(op.x), py(op.y));
    else if (op.op === 'curve') {
      doc.bezierCurveTo(px(op.cp1x), py(op.cp1y), px(op.cp2x), py(op.cp2y), px(op.x), py(op.y));
    } else doc.closePath();
  });
  doc.fill(spec.fill);

  (spec.circles || []).forEach(c => {
    doc.circle(px(c.cx), py(c.cy), c.r * s).fill(c.color);
  });
}

// ─── Rich-text bullet parsing ("<b>Label:</b> Description") ────────────────
interface RichSegment {
  text: string;
  bold: boolean;
}

function parseRichText(s: string): RichSegment[] {
  const parts: RichSegment[] = [];
  const regex = /<b>(.*?)<\/b>/gi;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(s)) !== null) {
    if (m.index > lastIndex) parts.push({ text: s.slice(lastIndex, m.index), bold: false });
    parts.push({ text: m[1], bold: true });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < s.length) parts.push({ text: s.slice(lastIndex), bold: false });
  return parts;
}

function stripTags(s: string): string {
  return s.replace(/<\/?b>/gi, '');
}

// ─── Title line-splitting heuristic (replaces the Python's hand-authored
// 'Senior Backend\nDeveloper' literal — there's no manual authoring here) ──
function splitTitleLines(title: string): string[] {
  const trimmed = title.trim();
  const words = trimmed.split(/\s+/);
  if (words.length < 2 || trimmed.length <= 18) return [trimmed];

  const mid = trimmed.length / 2;
  let bestIdx = 0;
  let bestDist = Infinity;
  let pos = 0;
  for (let i = 0; i < words.length - 1; i++) {
    pos += words[i].length + 1; // position just after the space following this word
    const dist = Math.abs(pos - mid);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  const line1 = words.slice(0, bestIdx + 1).join(' ');
  const line2 = words.slice(bestIdx + 1).join(' ');
  return [line1, line2];
}

// ─── PNG dimension read (for logo aspect ratio — avoids depending on
// pdfkit's undocumented/untyped internal image-loading APIs) ───────────────
function getPngDimensions(filePath: string): { width: number; height: number } {
  const buf = fs.readFileSync(filePath);
  // PNG: width/height are big-endian uint32s at byte offsets 16 and 20.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

export async function renderSocialJd(role: Role, content: JdContent): Promise<Buffer> {
  const doc = new PDFDocument({
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });

  const chunks: Buffer[] = [];
  doc.on('data', chunk => chunks.push(chunk));
  const donePromise = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // ── Background ────────────────────────────────────────────────────────
  drawGradientBackground(doc);

  // y mirrors the Python's own running y-up variable exactly (starts at
  // PAGE_HEIGHT, decremented by the same amounts, in the same order).
  let y = PAGE_HEIGHT;

  // ── WE'RE HIRING! badge ─────────────────────────────────────────────────
  y -= 90;
  {
    const badgeW = 350;
    const badgeH = 60;
    const badgeX = (PAGE_WIDTH - badgeW) / 2;
    const cornerYUp = y; // roundRect(x, y, w, h) — corner, extends UP by h
    doc.roundedRect(badgeX, flipY(cornerYUp) - badgeH, badgeW, badgeH, 30).fill(SOCIAL_JD_COLORS.teal);

    const fontSize = 26;
    const baselineYUp = y + 21;
    doc
      .font('Helvetica-Bold')
      .fontSize(fontSize)
      .fillColor('#ffffff')
      .text("WE'RE HIRING!", badgeX, flipY(baselineYUp) - fontSize * ASCENT_RATIO, {
        width: badgeW,
        align: 'center',
        lineBreak: false,
      });
  }

  // ── Job title ────────────────────────────────────────────────────────────
  y -= 110;
  {
    const fontSize = 72;
    doc.font('Helvetica-Bold').fontSize(fontSize).fillColor('#ffffff');
    const lines = splitTitleLines(role.title);
    for (const line of lines) {
      const baselineYUp = y;
      doc.text(line, 0, flipY(baselineYUp) - fontSize * ASCENT_RATIO, {
        width: PAGE_WIDTH,
        align: 'center',
        lineBreak: false,
      });
      y -= 80;
    }
  }

  // ── Tagline ──────────────────────────────────────────────────────────────
  y -= 20;
  {
    const fontSize = 26;
    const baselineYUp = y;
    doc
      .font('Helvetica')
      .fontSize(fontSize)
      .fillColor(SOCIAL_JD_COLORS.taglineText)
      .text(SOCIAL_TAGLINE, 0, flipY(baselineYUp) - fontSize * ASCENT_RATIO, {
        width: PAGE_WIDTH,
        align: 'center',
        lineBreak: false,
      });
  }

  // ── Meta info row ────────────────────────────────────────────────────────
  y -= 80;
  {
    const metaItems: Array<{ icon: IconKind; label: string }> = [];
    if (role.location) metaItems.push({ icon: 'pin', label: role.location });
    if (role.employment_type) metaItems.push({ icon: 'building', label: role.employment_type });
    if (role.yoe_required) metaItems.push({ icon: 'grad', label: role.yoe_required });
    if (role.department) metaItems.push({ icon: 'tag', label: role.department });

    const fontSize = 20;
    doc.font('Helvetica-Bold').fontSize(fontSize);

    const ICON_ADVANCE = 22; // x-advance after each icon, before the label
    const LABEL_GAP = 10; // gap after label, before separator/next icon
    const SEP_GAP = 12; // gap after the separator line

    // Bug fix: the original Python computed the centering width using
    // (18 + labelWidth + 15) per item while the draw loop actually advanced
    // x by 22 (+ labelWidth + 10 [+ 12 for the separator]) — a mismatch that
    // left the row visibly off-center. Here the width sum uses the EXACT
    // same per-item advance the draw loop uses below, so centering is exact.
    const perItemAdvance = (label: string, isLast: boolean) =>
      ICON_ADVANCE + doc.widthOfString(label) + LABEL_GAP + (isLast ? 0 : SEP_GAP);

    const totalW = metaItems.reduce(
      (sum, item, i) => sum + perItemAdvance(item.label, i === metaItems.length - 1),
      0
    );

    let x = (PAGE_WIDTH - totalW) / 2;
    const rowYUp = y;

    metaItems.forEach((item, i) => {
      drawIcon(doc, item.icon, x, rowYUp - 2, 16);
      x += ICON_ADVANCE;

      // drawIcon's .fill(color) calls leave the doc's fill color set to the
      // icon's color — reset to white before drawing the label text.
      doc.font('Helvetica-Bold').fontSize(fontSize).fillColor('#ffffff');
      const baselineYUp = rowYUp;
      doc.text(item.label, x, flipY(baselineYUp) - fontSize * ASCENT_RATIO, { lineBreak: false });
      const labelWidth = doc.widthOfString(item.label);
      x += labelWidth + LABEL_GAP;

      if (i < metaItems.length - 1) {
        doc
          .moveTo(x, flipY(rowYUp - 3))
          .lineTo(x, flipY(rowYUp + 16))
          .lineWidth(1)
          .strokeColor(SOCIAL_JD_COLORS.metaDivider)
          .stroke();
        x += SEP_GAP;
      }
    });
  }

  // ── Tech tags — greedy row-wrap, each row independently centered ────────
  y -= 50;
  {
    const fontSize = 13;
    doc.font('Helvetica-Bold').fontSize(fontSize);
    const maxRowWidth = 800;

    const tagWidths: number[] = [];
    const rowWidths: number[] = [0];
    let currentRow = 0;
    for (const tag of content.tags) {
      const tw = doc.widthOfString(tag.text.toUpperCase()) + 22;
      if (rowWidths[currentRow] + tw > maxRowWidth) {
        currentRow += 1;
        rowWidths.push(0);
      }
      rowWidths[currentRow] += tw + 10;
      tagWidths.push(tw);
    }

    let tagYUp = y;
    let tagIdx = 0;
    for (const rowWidth of rowWidths) {
      let tagX = (PAGE_WIDTH - rowWidth + 10) / 2;
      while (tagIdx < content.tags.length) {
        const tag = content.tags[tagIdx];
        const tw = tagWidths[tagIdx];
        if (tagX + tw > (PAGE_WIDTH + rowWidth) / 2) break;

        const bg = tag.isGreen ? SOCIAL_JD_COLORS.tagGreen : SOCIAL_JD_COLORS.tagBlue;
        const fg = tag.isGreen ? SOCIAL_JD_COLORS.tagGreenTxt : SOCIAL_JD_COLORS.tagBlueTxt;

        const cornerYUp = tagYUp - 4;
        doc.roundedRect(tagX, flipY(cornerYUp) - 20, tw, 20, 5).fill(bg);

        const baselineYUp = tagYUp + 2;
        doc
          .fillColor(fg)
          .text(tag.text.toUpperCase(), tagX + 11, flipY(baselineYUp) - fontSize * ASCENT_RATIO, {
            lineBreak: false,
          });

        tagX += tw + 10;
        tagIdx += 1;
      }
      tagYUp -= 26;
    }

    y = tagYUp - 60;
  }

  // ── Two columns: "About the role:" / "About you:" ──────────────────────
  const colMargin = 70;
  const colGap = 60;
  const colW = (PAGE_WIDTH - 2 * colMargin - colGap) / 2;
  const rightX = colMargin + colW + colGap;

  {
    const headerFontSize = 28;
    doc.font('Helvetica-Bold').fontSize(headerFontSize).fillColor(SOCIAL_JD_COLORS.lightGreen);

    const headerBaselineYUp = y;
    const headerTopPdf = flipY(headerBaselineYUp) - headerFontSize * ASCENT_RATIO;
    doc.text('About the role:', colMargin, headerTopPdf, { lineBreak: false });
    doc.text('About you:', rightX, headerTopPdf, { lineBreak: false });

    const underlineYUp = y - 6;
    const underlinePdfY = flipY(underlineYUp);
    doc
      .moveTo(colMargin, underlinePdfY)
      .lineTo(colMargin + 280, underlinePdfY)
      .lineWidth(3)
      .strokeColor(SOCIAL_JD_COLORS.teal)
      .stroke();
    doc
      .moveTo(rightX, underlinePdfY)
      .lineTo(rightX + 220, underlinePdfY)
      .lineWidth(3)
      .strokeColor(SOCIAL_JD_COLORS.teal)
      .stroke();
  }

  // ── Bullets ──────────────────────────────────────────────────────────────
  const bulletFontSize = 18;
  const bulletLeading = 25;
  doc.font('Helvetica').fontSize(bulletFontSize);
  const naturalLineHeight = doc.currentLineHeight();
  const bulletLineGap = bulletLeading - naturalLineHeight;
  const bulletWidth = colW - 25;

  function renderBulletColumn(items: string[], x: number): number {
    let bulletYUp = y - 50;
    for (const raw of items) {
      // Conservative height measurement: uses the wider (Bold) font for the
      // whole plain string so wrapping never comes out narrower than the
      // real mixed-font render — avoids under-measuring and clipping into
      // the next bullet or the footer.
      doc.font('Helvetica-Bold').fontSize(bulletFontSize);
      const plain = stripTags(raw);
      const h = doc.heightOfString(plain, { width: bulletWidth, lineGap: bulletLineGap });

      const paragraphTopYUp = bulletYUp + 10;
      const topPdfY = flipY(paragraphTopYUp);

      const segments = parseRichText(raw);
      doc.x = x;
      doc.y = topPdfY;
      segments.forEach((seg, i) => {
        doc
          .font(seg.bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(bulletFontSize)
          .fillColor('#ffffff')
          .text(seg.text, {
            continued: i < segments.length - 1,
            width: bulletWidth,
            lineGap: bulletLineGap,
          });
      });

      // Bullet dot aligned to the first line of this item.
      const dotYUp = bulletYUp + 6;
      doc.circle(x - 14, flipY(dotYUp), 5).fill(SOCIAL_JD_COLORS.teal);

      bulletYUp -= h + 20;
    }
    return bulletYUp;
  }

  const leftFinalYUp = renderBulletColumn(content.socialAboutRole, colMargin + 22);
  const rightFinalYUp = renderBulletColumn(content.socialAboutYou, rightX + 22);

  // ── Overflow guard ───────────────────────────────────────────────────────
  // The original has no guard at all — footer sits at a fixed position
  // regardless of content height. MAX_SOCIAL_BULLETS=5 (jdContent.ts) should
  // already keep this from happening; this is a defensive check, not a
  // dynamic-shrink algorithm.
  const footerSeparatorYUp = 180 + 70; // footer_y + 70, matches the footer section below
  if (leftFinalYUp < footerSeparatorYUp || rightFinalYUp < footerSeparatorYUp) {
    console.warn(
      `[socialJd] Bullet content for role ${role.id} may overlap the footer ` +
        `(leftEndYUp=${leftFinalYUp.toFixed(1)}, rightEndYUp=${rightFinalYUp.toFixed(1)}, ` +
        `footerSeparatorYUp=${footerSeparatorYUp}). Consider trimming socialAboutRole/socialAboutYou.`
    );
  }

  // ── Footer CTA (fixed position, independent of the flowing content above) ─
  const footerYUp = 180;

  {
    const separatorYUp = footerYUp + 70;
    doc
      .moveTo(colMargin, flipY(separatorYUp))
      .lineTo(PAGE_WIDTH - colMargin, flipY(separatorYUp))
      .lineWidth(1)
      .strokeColor('#ffffff')
      .strokeOpacity(0.2)
      .stroke();
    doc.strokeOpacity(1);

    const line1FontSize = 18;
    const line1BaselineYUp = footerYUp + 42;
    doc
      .font('Helvetica')
      .fontSize(line1FontSize)
      .fillColor(SOCIAL_JD_COLORS.footerLine1)
      .text(SOCIAL_FOOTER_LINE1, 0, flipY(line1BaselineYUp) - line1FontSize * ASCENT_RATIO, {
        width: PAGE_WIDTH,
        align: 'center',
        lineBreak: false,
      });

    const line2FontSize = 24;
    const line2BaselineYUp = footerYUp + 10;
    doc
      .font('Helvetica-Bold')
      .fontSize(line2FontSize)
      .fillColor(SOCIAL_JD_COLORS.teal)
      .text(APPLICATION_FORM_URL, 0, flipY(line2BaselineYUp) - line2FontSize * ASCENT_RATIO, {
        width: PAGE_WIDTH,
        align: 'center',
        lineBreak: false,
      });
  }

  // ── Logo (with fallback) ─────────────────────────────────────────────────
  {
    const logoYUp = 60;
    const logoH = 85;
    try {
      const { width: imgW, height: imgH } = getPngDimensions(LOGO_PATH);
      const aspect = imgW / imgH;
      const logoW = logoH * aspect;
      const topEdgeYUp = logoYUp + logoH;
      doc.image(LOGO_PATH, (PAGE_WIDTH - logoW) / 2, flipY(topEdgeYUp), {
        width: logoW,
        height: logoH,
      });
    } catch (err) {
      console.error('[socialJd] Logo load failed, falling back to text:', err);
      const fontSize = 32;
      const baselineYUp = logoYUp + 25;
      doc
        .font('Helvetica-Bold')
        .fontSize(fontSize)
        .fillColor('#ffffff')
        .text('DigitalPaani', 0, flipY(baselineYUp) - fontSize * ASCENT_RATIO, {
          width: PAGE_WIDTH,
          align: 'center',
          lineBreak: false,
        });
    }
  }

  doc.end();
  return donePromise;
}
