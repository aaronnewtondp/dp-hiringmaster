/**
 * Social-sharable JD PDF (1080×1350, 4:5 portrait) — the standard template for
 * every role, redesigned 2026-10-22 (first shipped for R019) to Brand Book v7.
 *
 * Structure (identical on every role):
 *   TOP 40%  — logo · "Now hiring" · the three-line hook · the intro · the role
 *              block (title + location / experience / team). The hook and intro
 *              are fixed constants in theme.ts — they never change per role.
 *   BOTTOM 60% — skill chips · "The Job" / "Who You Are" columns · apply bar. These adapt
 *              to the role: its tags, its five+five bullets, its title length.
 *
 * Rendering is pdfkit (vector, no browser) so it runs inside the main API
 * function — Chromium is worker-only (see CLAUDE.md, portfolio review). The
 * design was prototyped in HTML/CSS; coordinates here are the prototype's CSS
 * pixels 1:1 (1px = 1pt), and baselines are placed with the same
 * half-leading + ascent arithmetic a browser uses, so the two match.
 *
 * All "where does it go / does it fit" decisions live in socialJdLayout.ts
 * (pure, unit-tested). This file only draws what that module decides.
 */

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { Role } from '../../types/index.js';
import { JdContent } from '../jdContent.js';
import {
  SOCIAL_COLORS as C,
  SOCIAL_HOOK_MUTED, SOCIAL_HOOK_PUNCH, SOCIAL_INTRO_FACT, SOCIAL_INTRO_ASK,
  SOCIAL_NOW_HIRING, SOCIAL_ROLE_EYEBROW, SOCIAL_COL_HEADINGS, SOCIAL_CTA_TEXT,
  SOCIAL_YOU_ARE_HERE, SOCIAL_APPLY_URL,
} from './theme.js';
import {
  FontKey, FONT_METRICS, Measure, baselineInLine,
  PAGE_W, PAGE_H, MARGIN, CONTENT_W, CTA_TOP, CTA_H, HERO_MAX_BOTTOM, GEO, COL_X, COLS,
  fitSingleLine, fitTitle, formatExperience, planMeta, packChips, chipsBlockHeight,
  HOOK_MAX_RIGHT, HOOK_CLEARANCE, RIPPLE,
  parseBullet, layoutColumns, stripTags, cleanText,
  MetaItem, ExperienceParts, RowLayout,
} from './socialJdLayout.js';

// ─── Ripple graphic (the brand's "See" layer: blueprint linework) ───────────
// [radius, stroke width, opacity, dash?]. Radii avoid the radial band occupied by
// the "NOW HIRING" label so no ring strikes through it.
const RINGS: [number, number, number, [number, number]?][] = [
  [52, 1.5, 0.6], [HOOK_CLEARANCE.ring, 1.3, 0.45], [190, 1.3, 0.34, [3, 9]],
  [268, 9, 0.18, [1.5, 14]],            // tick ring — thick short dashes read as measurement ticks
  [268, 1.1, 0.22], [356, 1.1, 0.16], [456, 1.1, 0.12, [3, 9]],
  [576, 1.1, 0.09], [706, 1.1, 0.07], [856, 1.1, 0.05],
];

// Assets are read with LITERAL path.join(__dirname, …) expressions on purpose: that is the form
// Vercel's file tracer (@vercel/nft) can follow, so the fonts and logo are bundled into the serverless
// function. Passing path strings through a variable into pdfkit hides them from the tracer — the same
// failure that once dropped pdf.worker.mjs from the bundle (see backend/vercel.json, driveService.ts).
// Read once, then cached for the life of the process.
let assets: { fonts: Record<FontKey, Buffer>; logo: Buffer } | null = null;
function loadAssets() {
  assets ??= {
    fonts: {
      fig:      fs.readFileSync(path.join(__dirname, '../../assets/fonts/Figtree-Regular.ttf')),
      figBold:  fs.readFileSync(path.join(__dirname, '../../assets/fonts/Figtree-Bold.ttf')),
      figXBold: fs.readFileSync(path.join(__dirname, '../../assets/fonts/Figtree-ExtraBold.ttf')),
      monoMed:  fs.readFileSync(path.join(__dirname, '../../assets/fonts/IBMPlexMono-Medium.ttf')),
      monoSemi: fs.readFileSync(path.join(__dirname, '../../assets/fonts/IBMPlexMono-SemiBold.ttf')),
    },
    logo: fs.readFileSync(path.join(__dirname, '../../assets/dp_logo_white.png')),
  };
  return assets;
}

const HERO_LEFT = MARGIN;
const LOGO = { x: MARGIN - 12, y: 28, w: 122 }; // -12: the PNG has built-in left padding; this aligns the "D" with the headline edge

export async function renderSocialJd(role: Role, content: JdContent): Promise<Buffer> {
  const doc = new PDFDocument({
    size: [PAGE_W, PAGE_H],
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    info: {
      Title: `${stripTags(role.title)} — DigitalPaani`,
      Author: 'DigitalPaani',
      Subject: 'Social job description',
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const { fonts, logo } = loadAssets();
  (Object.keys(fonts) as FontKey[]).forEach(k => doc.registerFont(k, fonts[k]));

  // CSS letter-spacing semantics: `spacing` pt after every character, last included.
  const measure: Measure = (text, font, size, spacing = 0) => {
    doc.font(font).fontSize(size);
    return doc.widthOfString(text) + spacing * Array.from(text).length;
  };

  /** Draw `str` with its BASELINE at `baseline`. */
  function text(
    str: string, x: number, baseline: number, font: FontKey, size: number, color: string,
    o: { opacity?: number; spacing?: number; align?: 'left' | 'right' | 'center' } = {},
  ): number {
    const spacing = o.spacing ?? 0;
    const w = measure(str, font, size, spacing);
    const left = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    doc.font(font).fontSize(size).fillColor(color, o.opacity ?? 1)
      .text(str, left, baseline - FONT_METRICS[font].asc * size, { lineBreak: false, characterSpacing: spacing });
    return w;
  }

  const rect = (x: number, y: number, w: number, h: number, color: string, opacity = 1) =>
    doc.fillColor(color, opacity).rect(x, y, w, h).fill();

  // ── Background: navy, a soft elliptical lift behind the ripples, the grid ──
  rect(0, 0, PAGE_W, PAGE_H, C.navy);
  doc.save();
  doc.translate(RIPPLE.cx, RIPPLE.cy).scale(1, 518 / 636);          // CSS: radial-gradient(860px 700px, navyMid 0 → navy 74%)
  const glow = doc.radialGradient(0, 0, 0, 0, 0, 636).stop(0, C.navyMid).stop(1, C.navy);
  doc.rect(-3000, -3000, 6000, 6000).fill(glow);
  doc.restore();
  for (let x = 0; x < PAGE_W; x += 40) rect(x, 0, 1, PAGE_H, C.tealLt, 0.065);   // "instrumented, not decorative"
  for (let y = 0; y < PAGE_H; y += 40) rect(0, y, PAGE_W, 1, C.tealLt, 0.065);

  // ── Ripples + crosshair + "you are here" callout ───────────────────────────
  for (const [r, sw, op, dash] of RINGS) {
    if (dash) doc.dash(dash[0], { space: dash[1] });
    doc.lineWidth(sw).strokeColor(C.tealLt, op).circle(RIPPLE.cx, RIPPLE.cy, r).stroke();
    if (dash) doc.undash();
  }
  doc.lineWidth(1.4).strokeColor(C.tealLt, 0.75)
    .moveTo(RIPPLE.cx - 20, RIPPLE.cy).lineTo(RIPPLE.cx + 20, RIPPLE.cy).stroke()
    .moveTo(RIPPLE.cx, RIPPLE.cy - 20).lineTo(RIPPLE.cx, RIPPLE.cy + 20).stroke();
  doc.fillColor(C.tealLt, 0.95).circle(RIPPLE.cx, RIPPLE.cy, 4.5).fill();
  doc.lineWidth(1.1).strokeColor(C.tealLt, 0.55).moveTo(RIPPLE.cx, RIPPLE.cy + 52).lineTo(RIPPLE.cx, RIPPLE.cy + 64).stroke();
  text(SOCIAL_YOU_ARE_HERE, RIPPLE.cx, RIPPLE.cy + 82, 'monoMed', 11, C.tealLt, { opacity: 0.85, spacing: 11 * 0.18, align: 'center' });

  // corner registration marks
  doc.lineWidth(1.5).strokeColor(C.tealLt, 0.5);
  for (const x0 of [26, PAGE_W - 26 - 20]) {
    doc.moveTo(x0 + 9.75, 18).lineTo(x0 + 9.75, 38).stroke().moveTo(x0, 27.75).lineTo(x0 + 20, 27.75).stroke();
  }

  // ── Top bar: logo + NOW HIRING ─────────────────────────────────────────────
  const logoH = LOGO.w * (362 / 701);
  doc.image(logo, LOGO.x, LOGO.y, { width: LOGO.w });
  {
    const cy = LOGO.y + logoH / 2;
    const size = 14, sp = size * 0.14;
    const w = measure(SOCIAL_NOW_HIRING, 'monoMed', size, sp);
    const left = MARGIN + CONTENT_W - w;
    const baseline = cy - (1.3 * size) / 2 + FONT_METRICS.monoMed.asc * size;
    text(SOCIAL_NOW_HIRING, left, baseline, 'monoMed', size, C.tealLt, { spacing: sp });
    doc.fillColor(C.tealLt, 0.18).circle(left - 10 - 4.5, cy, 9.5).fill();
    doc.fillColor(C.tealLt, 1).circle(left - 10 - 4.5, cy, 4.5).fill();
  }

  // ── Hook (fixed copy) ──────────────────────────────────────────────────────
  const h1Size = GEO.h1Size, h1LH = h1Size * GEO.h1LineH, h1Sp = GEO.h1Spacing * h1Size;
  const h1Base = (i: number) => GEO.heroTop + i * h1LH + baselineInLine('figXBold', h1Size, h1LH);
  SOCIAL_HOOK_MUTED.forEach((line, i) => text(line, HERO_LEFT, h1Base(i), 'figXBold', h1Size, C.white, { opacity: 0.7, spacing: h1Sp }));
  {
    const w = text(SOCIAL_HOOK_PUNCH.lead, HERO_LEFT, h1Base(2), 'figXBold', h1Size, C.white, { spacing: h1Sp });
    text(SOCIAL_HOOK_PUNCH.accent, HERO_LEFT + w, h1Base(2), 'figXBold', h1Size, C.rustLt, { spacing: h1Sp });
  }
  const h1Bottom = GEO.heroTop + 3 * h1LH;
  for (const line of [...SOCIAL_HOOK_MUTED, SOCIAL_HOOK_PUNCH.lead + SOCIAL_HOOK_PUNCH.accent]) {
    // visible end of the last glyph: the measure includes one trailing letter-space (negative here), which is not drawn
    const end = HERO_LEFT + measure(line, 'figXBold', h1Size, h1Sp) - h1Sp;
    if (end > HOOK_MAX_RIGHT) console.warn(`[SocialJD] hook line "${line}" ends at ${end.toFixed(0)}pt, past ${HOOK_MAX_RIGHT}pt (it would run into the ripple artwork)`);
  }

  // ── Intro (fixed copy) ─────────────────────────────────────────────────────
  const subLH = GEO.subSize * GEO.subLineH;
  const subTop = h1Bottom + GEO.subMarginTop;
  const subBase = (i: number) => subTop + i * subLH + baselineInLine('fig', GEO.subSize, subLH);
  text(SOCIAL_INTRO_FACT, HERO_LEFT, subBase(0), 'fig', GEO.subSize, C.white, { opacity: 0.82, spacing: -0.005 * GEO.subSize });
  // the ask is set in the brand's warm emphasis (rust) so it stands out from the intro above it
  text(SOCIAL_INTRO_ASK, HERO_LEFT, subBase(1), 'figBold', GEO.subSize, C.rustLt, { spacing: -0.005 * GEO.subSize });
  const subBottom = subTop + 2 * subLH;

  // ── Role block — translucent teal "glass" ──────────────────────────────────
  const cardX = MARGIN, cardY = subBottom + GEO.cardMarginTop, cardW = CONTENT_W, cardH = GEO.cardH;
  const innerTop = cardY + 1, innerH = cardH - 2;
  {
    const g = doc.linearGradient(cardX, cardY, cardX + cardW, cardY + cardH)
      .stop(0, C.tealLt, 0.17).stop(1, C.tealLt, 0.07);
    doc.roundedRect(cardX, cardY, cardW, cardH, 6).fill(g);
    doc.lineWidth(1).strokeColor(C.tealLt, 0.34).roundedRect(cardX + 0.5, cardY + 0.5, cardW - 1, cardH - 1, 5.5).stroke();
    // right-hand meta: location / experience / team (any of them may be missing)
    const items: MetaItem[] = [];
    const loc = cleanText(role.location ?? '');
    if (loc) items.push({ key: 'LOCATION', value: { text: loc } });
    const exp = formatExperience(role.yoe_required);
    if (exp) items.push({ key: 'EXPERIENCE', value: exp });
    const team = cleanText(role.department ?? '');
    if (team) items.push({ key: 'TEAM', value: { text: team } });
    const metaX = GEO.col2X, metaW = cardX + cardW - 1 - 28 - metaX;
    const naturalW = (it: MetaItem) => it.value.num
      ? measure(it.value.num, 'monoSemi', 22, -0.02 * 22) + measure(' ' + (it.value.unit ?? ''), 'figBold', 23, -0.01 * 23)
      : measure(it.value.text ?? '', 'figBold', 23, -0.01 * 23);
    const { placements: placed, col1X } = planMeta(items, naturalW, metaW);

    // The divider sits at x=541.5 so the meta text lands exactly on the second column's gridline (x=570).
    // With no meta at all there is nothing to divide: drop the rule and give the title the whole block.
    const dividerX = GEO.col2X - 28.5;
    if (placed.length) doc.lineWidth(1).strokeColor(C.tealLt, 0.28).moveTo(dividerX, innerTop).lineTo(dividerX, innerTop + innerH).stroke();

    // left: eyebrow + fitted title, centred as a group in the block
    const titleX = cardX + 1 + 36;
    const titleMaxW = (placed.length ? dividerX - 12 : cardX + cardW - 1 - 36) - titleX;
    const t = fitTitle(role.title, titleMaxW, measure);
    const tLH = t.size * 1.02;
    const eyebrowH = 1.3 * 12.5;
    const groupH = eyebrowH + 10 + t.lines.length * tLH;
    const top = innerTop + (innerH - groupH) / 2;
    doc.fillColor(C.tealLt, 1).rect(titleX, top + (eyebrowH - 8) / 2, 8, 8).fill();
    text(SOCIAL_ROLE_EYEBROW, titleX + 17, top + FONT_METRICS.monoMed.asc * 12.5, 'monoMed', 12.5, C.tealLt, { spacing: 12.5 * 0.14 });
    const t0 = top + eyebrowH + 10;
    t.lines.forEach((line, i) =>
      text(line, titleX, t0 + i * tLH + baselineInLine('figXBold', t.size, tLH), 'figXBold', t.size, C.white, { spacing: -0.03 * t.size }));

    // right: the meta items on a two-column grid
    const itemH = 11.5 + 5 + 1.1 * 23;
    const rowsN = placed.length ? Math.max(...placed.map(p => p.row)) + 1 : 0;
    const gridH = rowsN * itemH + Math.max(0, rowsN - 1) * 16;
    const gridTop = innerTop + (innerH - gridH) / 2;
    for (const p of placed) {
      const x = metaX + (p.col === 1 ? col1X : 0);
      const w = p.span2 ? metaW : p.col === 0 ? col1X - 28 : metaW - col1X;
      const y = gridTop + p.row * (itemH + 16);
      text(p.key, x, y + baselineInLine('monoMed', 11.5, 11.5), 'monoMed', 11.5, C.tealLt, { opacity: 0.9, spacing: 11.5 * 0.14 });
      drawMetaValue(p.value, x, y + 16.5 + baselineInLine('figBold', 23, 1.1 * 23), w);
    }
  }
  const heroBottom = cardY + cardH;
  // The template's contract: everything from the logo to the role block fits in the top 40%.
  if (heroBottom > HERO_MAX_BOTTOM) console.warn(`[SocialJD] hero ends at ${heroBottom.toFixed(1)}pt, past the 40% line (${HERO_MAX_BOTTOM}pt)`);

  function drawMetaValue(v: ExperienceParts, x: number, baseline: number, maxW: number) {
    if (v.num) {
      // digits in mono (brand rule: numerics are IBM Plex Mono), unit in Figtree
      const w = (s: number) => measure(v.num!, 'monoSemi', s * (22 / 23), -0.02 * s * (22 / 23)) + measure(' ' + (v.unit ?? ''), 'figBold', s, -0.01 * s);
      let s = 23;
      while (s > 16 && w(s) > maxW) s -= 0.5;
      const nw = text(v.num, x, baseline, 'monoSemi', s * (22 / 23), C.white, { spacing: -0.02 * s * (22 / 23) });
      text(' ' + (v.unit ?? ''), x + nw, baseline, 'figBold', s, C.white, { spacing: -0.01 * s });
      return;
    }
    const f = fitSingleLine(v.text ?? '', 'figBold', maxW, 23, 16, -0.01, measure);
    text(f.text, x, baseline, 'figBold', f.size, C.white, { spacing: -0.01 * f.size });
  }

  // ── Skill chips (centred rows; blue = craft, green = sector) ───────────────
  const chips = packChips(content.tags, measure);
  chips.rows.forEach((row, ri) => {
    const y = GEO.chipsTop + ri * (GEO.chipH + GEO.chipGap);
    for (const c of row) {
      doc.fillColor(c.green ? C.chipGreenBg : C.chipBlueBg, 1).roundedRect(c.x, y, c.w, GEO.chipH, 6).fill();
      text(c.text, c.x + GEO.chipPadX, y + 10 + baselineInLine('figBold', GEO.chipFont, GEO.chipFont), 'figBold', GEO.chipFont,
        c.green ? C.chipGreenTx : C.chipBlueTx, { spacing: GEO.chipSpacing * GEO.chipFont });
    }
  });
  if (chips.dropped) console.warn(`[SocialJD] ${role.id}: dropped ${chips.dropped} tag(s) that did not fit two chip rows`);

  // ── The Job / Who You Are ──────────────────────────────────────────────────────────
  const colsTop = chips.rows.length ? GEO.chipsTop + chipsBlockHeight(chips.rows.length) + GEO.colsGapAfterChips : GEO.chipsTop;
  const availH = CTA_TOP - GEO.colsBottomGap - colsTop;
  const layout = layoutColumns(
    (content.socialAboutRole ?? []).map(parseBullet).filter(b => b.lead),
    (content.socialAboutYou ?? []).map(parseBullet).filter(b => b.lead),
    availH, measure,
  );
  if (layout.overflow) console.warn(`[SocialJD] ${role.id}: columns exceed the available height even at minimum scale`);

  [SOCIAL_COL_HEADINGS.job, SOCIAL_COL_HEADINGS.you].forEach((heading, ci) => {
    const x = COL_X[ci];
    rect(x, colsTop, 56, 3, C.tealLt);
    text(heading, x, colsTop + 20 + baselineInLine('figXBold', 36, 36), 'figXBold', 36, C.white, { spacing: -0.02 * 36 });
    let y = colsTop + COLS.headerH;
    layout.rows.forEach((row, ri) => {
      const r: RowLayout | undefined = ci === 0 ? row.left : row.right;
      const s = layout.scale;
      if (r) {
        text(String(ri + 1).padStart(2, '0'), x, y + row.pad + 7 * s + FONT_METRICS.monoMed.asc * 16 * s, 'monoMed', 16 * s, C.tealLt, { spacing: 0.04 * 16 * s });
        const tx = x + COLS.textX;
        const leadLH = r.leadSize * COLS.leadLH;
        text(r.lead, tx, y + row.pad + baselineInLine('figBold', r.leadSize, leadLH), 'figBold', r.leadSize, C.white, { spacing: -0.015 * r.leadSize });
        const dTop = y + row.pad + leadLH + COLS.leadDescGap * s;
        const dLH = r.descSize * COLS.descLH;
        r.descLines.forEach((ln, li) =>
          text(ln, tx, dTop + li * dLH + baselineInLine('fig', r.descSize, dLH), 'fig', r.descSize, C.white, { opacity: 0.68 }));
      }
      if (ri < layout.rows.length - 1) rect(x, y + row.h - 1, GEO.colW, 1, C.white, 0.1);
      y += row.h;
    });
  });

  // ── Apply bar (the whole bar is the link) ──────────────────────────────────
  rect(0, CTA_TOP, PAGE_W, CTA_H, C.tealLt);
  const ctaMid = CTA_TOP + CTA_H / 2;
  text(SOCIAL_CTA_TEXT, MARGIN, ctaMid - (1.2 * 32) / 2 + FONT_METRICS.figXBold.asc * 32, 'figXBold', 32, C.navy, { spacing: -0.025 * 32 });
  {
    const R = 19, cx = MARGIN + CONTENT_W - R;
    const urlText = SOCIAL_APPLY_URL.replace(/^https?:\/\//, '');
    text(urlText, cx - R - 13, ctaMid - (1.3 * 20.8) / 2 + FONT_METRICS.monoSemi.asc * 20.8, 'monoSemi', 20.8, C.navy, { align: 'right', spacing: -0.02 * 20.8 });
    doc.fillColor(C.navy, 1).circle(cx, ctaMid, R).fill();
    doc.lineWidth(2.2).lineCap('round').lineJoin('round').strokeColor(C.tealLt, 1)
      .moveTo(cx - 7, ctaMid).lineTo(cx + 7, ctaMid).stroke()
      .moveTo(cx + 2.5, ctaMid - 4.7).lineTo(cx + 7, ctaMid).lineTo(cx + 2.5, ctaMid + 4.7).stroke();
  }
  doc.link(0, CTA_TOP, PAGE_W, CTA_H, SOCIAL_APPLY_URL);

  doc.end();
  return done;
}
