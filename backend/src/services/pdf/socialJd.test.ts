import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderSocialJd } from './socialJd.js';
import { SOCIAL_FIXTURES } from './socialJd.fixtures.js';
import { extractPdfText } from '../driveService.js';
import { SOCIAL_LEAD_MAX_CHARS, SOCIAL_DETAIL_MAX_CHARS } from '../jdContent.js';
import {
  SOCIAL_HOOK_MUTED, SOCIAL_HOOK_PUNCH, SOCIAL_INTRO_FACT, SOCIAL_INTRO_ASK, SOCIAL_CTA_TEXT,
  SOCIAL_ROLE_EYEBROW, SOCIAL_APPLY_URL, SOCIAL_COL_HEADINGS,
} from './theme.js';
import { GEO, COLS, MARGIN, HOOK_MAX_RIGHT, HOOK_CLEARANCE, RIPPLE, HERO_MAX_BOTTOM } from './socialJdLayout.js';
import { Role } from '../../types/index.js';
import { JdContent } from '../jdContent.js';

afterEach(() => vi.restoreAllMocks());

const render = (name: string) => renderSocialJd(SOCIAL_FIXTURES[name].role, SOCIAL_FIXTURES[name].content);
const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/[‘’]/g, "'").trim();
// The extractor reports letter-spaced labels as "T H E  R O L E", so compare with ALL whitespace removed.
const squash = (s: string) => norm(s).replace(/\s/g, '');

describe('renderSocialJd — document structure', () => {
  it.each(Object.keys(SOCIAL_FIXTURES))('%s renders a single 1080×1350 PDF page', async (name) => {
    const buf = await render(name);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const raw = buf.toString('latin1');
    expect(raw).toMatch(/\/MediaBox \[0 0 1080 1350\]/);
    expect(raw.match(/\/Type \/Page(?![a-z])/g)).toHaveLength(1);
  });

  it.each(Object.keys(SOCIAL_FIXTURES))('%s: the whole apply bar is a live link to the form', async (name) => {
    const raw = (await render(name)).toString('latin1');
    expect(raw).toContain('/Subtype /Link');
    expect(raw).toContain(`(${SOCIAL_APPLY_URL})`);
    // one link only, and it covers the full-width bar (y 0 → 83pt from the bottom)
    expect(raw.match(/\/Subtype \/Link/g)).toHaveLength(1);
    expect(raw).toMatch(/\/Rect \[0 0 1080 83\]/);
  });

  it('embeds the brand typefaces (Figtree, IBM Plex Mono) rather than falling back to Helvetica', async () => {
    const raw = (await render('R019')).toString('latin1');
    expect(raw).toMatch(/\/FontName \/[A-Z]{6}\+Figtree-ExtraBold/);
    expect(raw).toMatch(/\/FontName \/[A-Z]{6}\+Figtree-Bold/);
    expect(raw).toMatch(/\/FontName \/[A-Z]{6}\+Figtree-Regular/);
    expect(raw).toMatch(/\/FontName \/[A-Z]{6}\+IBMPlexMono/);
    expect(raw).not.toContain('/BaseFont /Helvetica');
  });

  it('keeps the file small enough to be a social asset (< 250 KB)', async () => {
    for (const name of Object.keys(SOCIAL_FIXTURES)) expect((await render(name)).length).toBeLessThan(250 * 1024);
  });

  it('never ends the hero past the 40% line, on any fixture', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const name of Object.keys(SOCIAL_FIXTURES)) await render(name);
    expect(warn.mock.calls.filter(c => String(c[0]).includes('40% line'))).toHaveLength(0);
  });
});

describe('renderSocialJd — the fixed top half vs the adaptive bottom half', () => {
  const textOf = async (name: string) => norm(await extractPdfText(await render(name)));
  const squashedOf = async (name: string) => squash(await extractPdfText(await render(name)));

  it('prints the three-line hook, the intro and the apply copy exactly as defined in theme.ts', async () => {
    const t = await squashedOf('R019');
    for (const line of SOCIAL_HOOK_MUTED) expect(t).toContain(squash(line));
    expect(t).toContain(squash(SOCIAL_HOOK_PUNCH.lead + SOCIAL_HOOK_PUNCH.accent));
    expect(t).toContain(squash(SOCIAL_INTRO_FACT));
    expect(t).toContain(squash(SOCIAL_INTRO_ASK));
    expect(t).toContain(squash(SOCIAL_CTA_TEXT));
    expect(t).toContain(squash(SOCIAL_APPLY_URL.replace('https://', '')));
    expect(t).toContain(squash(SOCIAL_ROLE_EYEBROW));
    expect(t).toContain(squash(SOCIAL_COL_HEADINGS.job));
    expect(t).toContain(squash(SOCIAL_COL_HEADINGS.you));
    // pinned literally: Aaron's decision (22 Oct) is exactly "The Job" and "Who You Are", capitalised so
    expect(t).toContain('TheJob');
    expect(t).toContain('WhoYouAre');
    expect(t).not.toContain('Thejob');
  });

  it('is word-for-word identical above the role block on every role, and differs below it', async () => {
    const [a, b] = await Promise.all([squashedOf('R019'), squashedOf('LONG_TITLE')]);
    const eyebrow = squash(SOCIAL_ROLE_EYEBROW);
    const top = (t: string) => t.slice(0, t.indexOf(eyebrow));
    expect(top(a).length).toBeGreaterThan(100);          // a real, non-empty top half...
    expect(top(a)).toBe(top(b));                          // ...identical on both roles
    expect(top(a)).toContain(squash(SOCIAL_HOOK_PUNCH.lead + SOCIAL_HOOK_PUNCH.accent));
    const below = (t: string) => t.slice(t.indexOf(eyebrow) + eyebrow.length);
    expect(below(a)).not.toBe(below(b));
  });

  it("adapts to the role: its title, meta, tags and bullets are what's printed", async () => {
    const t = await textOf('R019');
    expect(t).toContain('Head of Marketing &');
    expect(t).toContain('Creative Direction');
    expect(t).toContain('Gurgaon');
    expect(t).toContain('5–10');
    expect(t).toContain('Sales & Growth');
    expect(t).toContain('BRAND BUILDING');
    expect(t).toContain('CLIMATE/SUSTAINABILITY');
    expect(t).toContain('Write the story');
    expect(t).toContain("DigitalPaani's narrative, from zero");   // typographic quote normalised by norm()
    expect(t).toContain('Scrappy operator');
  });

  it('prints a missing field as nothing rather than as "undefined"', async () => {
    const t = await textOf('SPARSE');
    expect(t).toContain('Field Engineer');
    expect(t).not.toMatch(/undefined|null|NaN/);
    // positive control first: a role WITH these fields does print the labels, so their absence below means something
    const full = await squashedOf('R019');
    for (const label of ['LOCATION', 'EXPERIENCE', 'TEAM']) expect(full).toContain(label);
    const sparse = await squashedOf('SPARSE');
    for (const label of ['LOCATION', 'EXPERIENCE', 'TEAM']) expect(sparse).not.toContain(label);
  });

  it('shows the experience in yrs, with free text left alone', async () => {
    expect(await textOf('LONG_TITLE')).toContain('3+');
    expect(await textOf('SHORT_TITLE')).toContain('Fresher');
  });
});

describe('renderSocialJd — robustness', () => {
  it('renders from a completely empty content object', async () => {
    const buf = await renderSocialJd({ id: 'R1', title: 'Anything' } as Role, {} as JdContent);
    expect(buf.length).toBeGreaterThan(5000);
  });

  it('survives hostile / odd strings without throwing', async () => {
    const buf = await renderSocialJd(
      { id: 'R2', title: '<script>alert(1)</script> & "Quotes" — Ünïcödé', location: ' \n ', department: 'a'.repeat(300), yoe_required: '??' } as Role,
      {
        tags: [{ text: '', isGreen: false }, { text: 'x'.repeat(200), isGreen: true }, null as never],
        socialAboutRole: ['', '<b></b>', '<b>Unclosed lead', ':', 'no colon at all but very long '.repeat(10)],
        socialAboutYou: [undefined as never, '<b>OK:</b> fine'],
      } as unknown as JdContent,
    );
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('drops (and warns about) tags that cannot fit two rows instead of growing a third row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render('MANY_TAGS');
    expect(warn.mock.calls.some(c => String(c[0]).includes('dropped'))).toBe(true);
  });

  it('does not report column overflow for any fixture — including legacy-format bullets', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const name of Object.keys(SOCIAL_FIXTURES)) await render(name);
    expect(warn.mock.calls.filter(c => String(c[0]).includes('columns exceed'))).toHaveLength(0);
  });

  it('can render several roles concurrently (shared cached assets are read-only)', async () => {
    const bufs = await Promise.all(Object.keys(SOCIAL_FIXTURES).map(render));
    expect(bufs.every(b => b.subarray(0, 5).toString() === '%PDF-')).toBe(true);
  });
});

describe('the fixed hook fits the artwork', () => {
  // The three hook lines are constants in theme.ts, so nothing adapts them to a role. The widest one has to end
  // left of the ripple artwork (HOOK_MAX_RIGHT, derived from the artwork's own position) in the real font at the
  // real size — measured here with the same shaping pdfkit uses — otherwise the headline runs into the linework
  // on EVERY role.
  const fontkit = require('fontkit');
  const path = require('path');
  const extraBold = fontkit.openSync(path.join(__dirname, '../../assets/fonts/Figtree-ExtraBold.ttf'));
  // Visible end of the last glyph: the advance sum carries one trailing letter-space (negative) that is never drawn.
  const endX = (line: string, size: number) =>
    MARGIN + (extraBold.layout(line).advanceWidth / extraBold.unitsPerEm) * size
    + GEO.h1Spacing * size * (Array.from(line).length - 1);
  const hookLines = [...SOCIAL_HOOK_MUTED, SOCIAL_HOOK_PUNCH.lead + SOCIAL_HOOK_PUNCH.accent];

  it('is exactly three lines', () => {
    expect(hookLines).toHaveLength(3);
  });

  it(`every hook line ends left of the artwork (${HOOK_MAX_RIGHT}pt) at the hook size (${GEO.h1Size}pt)`, () => {
    for (const line of hookLines) expect(endX(line, GEO.h1Size), line).toBeLessThanOrEqual(HOOK_MAX_RIGHT);
  });

  it('the limit follows the artwork: 24pt short of the second-innermost ring', () => {
    expect(HOOK_MAX_RIGHT).toBe(RIPPLE.cx - HOOK_CLEARANCE.ring - 24);
  });

  it('is sensitive: a hook line that is too long does NOT fit (so the check above can fail)', () => {
    expect(endX(hookLines.join(' '), GEO.h1Size)).toBeGreaterThan(HOOK_MAX_RIGHT);
    expect(endX(hookLines[2] + ' today', GEO.h1Size)).toBeGreaterThan(HOOK_MAX_RIGHT);
  });

  it('fixed copy uses typographic quotes — no straight \' or " in anything set in the display face', () => {
    const fixed = [...hookLines, SOCIAL_INTRO_FACT, SOCIAL_INTRO_ASK, SOCIAL_CTA_TEXT, ...Object.values(SOCIAL_COL_HEADINGS)];
    for (const t of fixed) expect(t, t).not.toMatch(/['"]/);
    expect(hookLines[0]).toContain('\u2019');   // positive control: the apostrophe IS there, and it is the curly one
  });

  it('keeps the hero inside the top 40% with the hook at this size, with no warnings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const name of ['R019', 'LONG_TITLE', 'SHORT_TITLE']) await render(name);
    expect(warn.mock.calls.filter(c => /hook line|past the 40% line/.test(String(c[0])))).toEqual([]);
    expect(GEO.heroTop + 3 * GEO.h1Size * GEO.h1LineH + GEO.subMarginTop + 2 * GEO.subSize * GEO.subLineH + GEO.cardMarginTop + GEO.cardH)
      .toBeLessThanOrEqual(HERO_MAX_BOTTOM);
  });

  it('the renderer WARNS when a hook line is too long (positive control for the guard)', async () => {
    vi.resetModules();
    vi.doMock('./theme.js', async (orig) => ({
      ...(await orig<typeof import('./theme.js')>()),
      SOCIAL_HOOK_MUTED: ['We\u2019re running out of water, and our rivers are polluted.', 'Our rivers are polluted.'],
    }));
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { renderSocialJd: renderLong } = await import('./socialJd.js');
      await renderLong(SOCIAL_FIXTURES.R019.role, SOCIAL_FIXTURES.R019.content);
      expect(warn.mock.calls.some(c => /hook line .* ends at \d+pt, past 820pt/.test(String(c[0])))).toBe(true);
    } finally {
      vi.doUnmock('./theme.js');
      vi.resetModules();
    }
  });
});

describe('prompt ↔ layout coupling', () => {
  // The generator is told "lead ≤ 24 chars, detail ≤ 36 chars" (jdContent.ts). That promise is only worth
  // anything if text AT those limits really fits the template's one-line slots. So: build thousands of realistic
  // phrases of EXACTLY the limit length (seeded, reproducible), measure them in the shipped fonts with the same
  // shaping pdfkit uses, and check how many fit. If someone raises a limit, widens nothing else, or swaps a
  // font, this fails instead of the graphic quietly getting cramped.
  const fontkit = require('fontkit');
  const path = require('path');
  const load = (f: string) => fontkit.openSync(path.join(__dirname, '../../assets/fonts', f));
  const fig = load('Figtree-Regular.ttf'), figBold = load('Figtree-Bold.ttf');
  type Font = { layout(s: string): { advanceWidth: number } };
  const width = (font: Font, s: string, size: number, spacing = 0) => (font.layout(s).advanceWidth / 1000) * size + spacing * s.length;

  const COLUMN_TEXT_W = GEO.colW - COLS.textX;                 // 392pt
  const WORDS = ('hire lead build ship own run scale design write review plan track fix test grow manage coach pitch sell draft launch ' +
    'audit tune map the a an and or with for from into across every real small senior core early live data sensor water plant site team ' +
    'user product brand campaign story roadmap pipeline model system report vendor client budget quality safety field remote startup ' +
    'reliable simple clear fast weekly daily autonomy impact insight metrics decisions stakeholders leadership mentoring hiring writing ' +
    'coding testing delivery operations processes proposals engineering software hardware electrical instrumentation commissioning ' +
    'maintenance compliance climate sustainability').split(' ');
  function phrases(n: number, count = 2000, seed = 12345): string[] {
    let x = seed; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    return Array.from({ length: count }, () => {
      let t = '';
      while (t.length < n) t += (t ? ' ' : '') + WORDS[Math.floor(rnd() * WORDS.length)];
      t = t.slice(0, n).trimEnd();
      while (t.length < n) t += 'e';
      return t;
    });
  }
  const shareFitting = (xs: number[], limit: number) => xs.filter(w => w <= limit).length / xs.length;

  it(`detail lines at the generator limit (${SOCIAL_DETAIL_MAX_CHARS} chars): ≥95% fit at full size, all fit with the allowed 10% shrink`, () => {
    const widths = phrases(SOCIAL_DETAIL_MAX_CHARS).map(p => width(fig, p, COLS.descSize));
    expect(shareFitting(widths, COLUMN_TEXT_W)).toBeGreaterThanOrEqual(0.95);
    expect(shareFitting(widths, COLUMN_TEXT_W / 0.9)).toBe(1);
  });

  it(`lead lines at the generator limit (${SOCIAL_LEAD_MAX_CHARS} chars): all fit at full size`, () => {
    const widths = phrases(SOCIAL_LEAD_MAX_CHARS).map(p => width(figBold, p, COLS.leadSize, -0.015 * COLS.leadSize));
    expect(shareFitting(widths, COLUMN_TEXT_W)).toBe(1);
  });

  it('is sensitive: phrases 4 chars over the detail limit do NOT reliably fit (so the check above can fail)', () => {
    const widths = phrases(SOCIAL_DETAIL_MAX_CHARS + 4).map(p => width(fig, p, COLS.descSize));
    expect(shareFitting(widths, COLUMN_TEXT_W)).toBeLessThan(0.5);
  });

  it('the shipped R019 bullets all respect the generator limits', () => {
    for (const b of [...SOCIAL_FIXTURES.R019.content.socialAboutRole, ...SOCIAL_FIXTURES.R019.content.socialAboutYou]) {
      const m = b.match(/^<b>(.*?):<\/b>\s*(.*)$/)!;
      expect(m[1].length).toBeLessThanOrEqual(SOCIAL_LEAD_MAX_CHARS);
      expect(m[2].length).toBeLessThanOrEqual(SOCIAL_DETAIL_MAX_CHARS);
    }
  });
});
