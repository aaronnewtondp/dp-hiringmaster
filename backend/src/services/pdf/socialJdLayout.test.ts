import { describe, it, expect } from 'vitest';
import {
  Measure, stripTags, smartQuotes, cleanText, ellipsize, fitSingleLine, wrapLines, fitTitle,
  formatExperience, planMeta, fitWrapped, MetaItem, packChips, chipsBlockHeight, parseBullet, layoutColumns,
  CONTENT_W, MARGIN, GEO, COLS, HERO_MAX_BOTTOM, PAGE_H,
} from './socialJdLayout.js';

// Deterministic stand-in for pdfkit: every glyph is half an em wide, plus CSS-style spacing per character.
const measure: Measure = (text, _font, size, spacing = 0) => Array.from(text).length * (size * 0.5 + spacing);

describe('text cleaning', () => {
  it('strips tags and collapses whitespace', () => {
    expect(stripTags('<b>Hello</b>   there\n friend')).toBe('Hello there friend');
  });

  it('sets typographic quotes', () => {
    expect(smartQuotes("DigitalPaani's story, can't stop")).toBe('DigitalPaani’s story, can’t stop');
    expect(smartQuotes("the players' choice")).toBe('the players’ choice');
    expect(smartQuotes("'quoted' text")).toBe('‘quoted’ text');
    expect(smartQuotes('say "hello" now')).toBe('say “hello” now');
  });

  it('cleanText = strip + typographic quotes', () => {
    expect(cleanText("<b>Don't</b> panic")).toBe('Don’t panic');
    expect(cleanText(undefined as unknown as string)).toBe('');
  });
});

describe('fitSingleLine / ellipsize / wrapLines', () => {
  const w = (t: string) => measure(t, 'fig', 20);

  it('leaves text alone when it fits', () => {
    expect(fitSingleLine('short', 'fig', 200, 20, 14, 0, measure)).toEqual({ text: 'short', size: 20 });
  });

  it('shrinks the font before cutting text', () => {
    const r = fitSingleLine('x'.repeat(24), 'fig', 200, 20, 14, 0, measure); // 24 chars: 240px at 20, 168px at 14
    expect(r.text).toBe('x'.repeat(24));
    expect(r.size).toBeLessThan(20);
    expect(measure(r.text, 'fig', r.size)).toBeLessThanOrEqual(200);
  });

  it('ellipsizes at the minimum size', () => {
    const r = fitSingleLine('x'.repeat(60), 'fig', 200, 20, 14, 0, measure);
    expect(r.size).toBe(14);
    expect(r.text.endsWith('…')).toBe(true);
    expect(measure(r.text, 'fig', 14)).toBeLessThanOrEqual(200);
  });

  it('ellipsize returns the whole string when it fits', () => {
    expect(ellipsize('fits', 500, w)).toBe('fits');
  });

  it('wrapLines honours the line cap — including a cap of ONE (regression: it used to wrap without limit)', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    expect(wrapLines(text, 160, 1, w)).toHaveLength(1);
    expect(wrapLines(text, 160, 1, w)[0].endsWith('…')).toBe(true);
    expect(wrapLines(text, 160, 2, w)).toHaveLength(2);
    expect(wrapLines('one two', 400, 3, w)).toEqual(['one two']);
  });

  it('no wrapped line is wider than the column', () => {
    for (const l of wrapLines('alpha beta gamma delta epsilon zeta eta theta iota kappa', 160, 4, w)) {
      expect(w(l)).toBeLessThanOrEqual(160);
    }
  });
});

describe('fitTitle', () => {
  const maxW = 420;
  const widthOf = (t: string, size: number) => measure(t, 'figXBold', size, -0.03 * size);

  it('keeps a short title on one line at full size', () => {
    expect(fitTitle('Operations Associate', maxW, measure)).toEqual({ lines: ['Operations Associate'], size: 40 });
  });

  it('splits a long title into two balanced lines and never starts a line with a connector', () => {
    const t = fitTitle('Head of Marketing & Creative Direction', maxW, measure);
    expect(t.lines).toEqual(['Head of Marketing &', 'Creative Direction']);
    expect(t.size).toBeGreaterThanOrEqual(32);
  });

  // Chosen so the ONLY tempting split is the bad one: pure "narrowest widest line" would give
  // ["Brand Strategy", "& Design"]. (Titles with a better balanced split elsewhere never exercise the rule.)
  it('keeps the connector on the end of line one, not the start of line two', () => {
    expect(fitTitle('Brand Strategy & Design', maxW, measure).lines).toEqual(['Brand Strategy &', 'Design']);
  });

  it.each(['&', '/', '-', '+'])('never lets a line start with "%s"', (c) => {
    const t = fitTitle(`Brand Strategy ${c} Design`, maxW, measure);
    expect(t.lines).toHaveLength(2);
    for (const l of t.lines.slice(1)) expect(l.startsWith(c)).toBe(false);
  });

  it('shrinks (never overflows) for a very long title', () => {
    const title = 'Data Engineer-IoT Intelligence + ETL Pipelines for Water Infrastructure Platform';
    const t = fitTitle(title, maxW, measure);
    expect(t.lines.length).toBeLessThanOrEqual(3);
    expect(t.size).toBeGreaterThanOrEqual(26);
    for (const l of t.lines) expect(widthOf(l, t.size)).toBeLessThanOrEqual(maxW + 0.5);
  });

  it('falls back to an ellipsis for a single unbreakable monster word', () => {
    const t = fitTitle('A'.repeat(80), maxW, measure);
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0].endsWith('…')).toBe(true);
    expect(t.size).toBe(26);
  });

  it('does not throw on empty input', () => {
    expect(fitTitle('', maxW, measure).lines).toEqual(['Untitled role']);
  });
});

describe('formatExperience', () => {
  it.each([
    ['5-10 years', { num: '5–10', unit: 'yrs' }],
    ['3+ Years', { num: '3+', unit: 'yrs' }],
    ['1 - 2 yrs', { num: '1–2', unit: 'yrs' }],
    ['2 years', { num: '2', unit: 'yrs' }],
    ['0 to 1 years', { num: '0–1', unit: 'yrs' }],
    ['6-10', { num: '6–10', unit: 'yrs' }],
    ['1.5-3 years', { num: '1.5–3', unit: 'yrs' }],
    ['3-6', { num: '3–6', unit: 'yrs' }],                                   // no unit (real: R012, R013)
    ['3 - 6 years in recruitment', { num: '3–6', unit: 'yrs' }],             // real: R018
    ['1-2 in B2B technology/SaaS, industrial solutions, or digital marketing agencies with B2B clients', { num: '1–2', unit: 'yrs' }],  // real: R020
    ['5 plus years', { num: '5', unit: 'yrs' }],
  ])('%s', (raw, expected) => expect(formatExperience(raw)).toEqual(expected));

  it('keeps free text as-is', () => {
    expect(formatExperience('Fresher')).toEqual({ text: 'Fresher' });
    expect(formatExperience('Fresher or 1-2 years')).toEqual({ text: 'Fresher or 1-2 years' });
  });

  it('never mislabels months/weeks as years', () => {
    expect(formatExperience('6 months')).toEqual({ text: '6 months' });
    expect(formatExperience('6-9 Months')).toEqual({ text: '6-9 Months' });
    expect(formatExperience('2 weeks')).toEqual({ text: '2 weeks' });
    expect(formatExperience('2024 onwards')).toEqual({ text: '2024 onwards' });
  });

  it('returns null for missing values', () => {
    expect(formatExperience(null)).toBeNull();
    expect(formatExperience(undefined)).toBeNull();
    expect(formatExperience('   ')).toBeNull();
  });
});

describe('planMeta', () => {
  // metaW 600 → half 300, gap 28, a value may shrink to 87% before another arrangement is picked.
  const mk = (key: string): MetaItem => ({ key, value: { text: key } });
  const it3 = [mk('LOCATION'), mk('EXPERIENCE'), mk('TEAM')];
  const W = 600;
  const widths = (w: Record<string, number>) => (it: MetaItem) => w[it.key] ?? 100;
  const shape = (p: ReturnType<typeof planMeta>) => p.placements.map(x => [x.key, x.col, x.row, x.span2]);

  it('three short items: Location | Experience on row 0, Team spans row 1, boundary at the half-way line', () => {
    const p = planMeta(it3, widths({}), W);
    expect(shape(p)).toEqual([['LOCATION', 0, 0, false], ['EXPERIENCE', 1, 0, false], ['TEAM', 0, 1, true]]);
    expect(p.col1X).toBe(300);
  });

  it('a Location wider than half a column pushes the boundary right instead of shrinking', () => {
    const p = planMeta(it3, widths({ LOCATION: 330 }), W);
    expect(shape(p)).toEqual([['LOCATION', 0, 0, false], ['EXPERIENCE', 1, 0, false], ['TEAM', 0, 1, true]]);
    expect(p.col1X).toBe(358); // 330 + 28 gap
  });

  it('never moves the boundary left of the half-way line, however short Location is', () => {
    expect(planMeta(it3, widths({ LOCATION: 10 }), W).col1X).toBe(300);
  });

  it('the widened boundary never squeezes Experience below its shrink limit', () => {
    const p = planMeta(it3, widths({ LOCATION: 440, EXPERIENCE: 200 }), W);
    // Experience needs 200*0.87 = 174 (+8 breathing room) → boundary at most 600-174-8 = 418
    expect(p.col1X).toBeLessThanOrEqual(418);
    expect(p.col1X).toBeGreaterThan(300);
  });

  it('a Location that cannot fit even when widened spans row 0; Experience | Team share row 1', () => {
    const p = planMeta(it3, widths({ LOCATION: 600 }), W);
    expect(shape(p)).toEqual([['LOCATION', 0, 0, true], ['EXPERIENCE', 0, 1, false], ['TEAM', 1, 1, false]]);
    expect(p.col1X).toBe(300);
  });

  it('falls back to the default grid when the alternative would not fit either (always at most two rows)', () => {
    const p = planMeta(it3, widths({ LOCATION: 600, EXPERIENCE: 600, TEAM: 600 }), W);
    expect(shape(p)).toEqual([['LOCATION', 0, 0, false], ['EXPERIENCE', 1, 0, false], ['TEAM', 0, 1, true]]);
    expect(p.placements.every(x => x.row <= 1)).toBe(true);
  });

  it('two items sit side by side, widening the first column when needed', () => {
    expect(shape(planMeta(it3.slice(0, 2), widths({}), W))).toEqual([['LOCATION', 0, 0, false], ['EXPERIENCE', 1, 0, false]]);
    const wide = planMeta(it3.slice(0, 2), widths({ LOCATION: 330 }), W);
    expect(shape(wide)).toEqual([['LOCATION', 0, 0, false], ['EXPERIENCE', 1, 0, false]]);
    expect(wide.col1X).toBe(358);
  });

  it('two items stack full-width when they cannot share a row', () => {
    const p = planMeta(it3.slice(0, 2), widths({ LOCATION: 600 }), W);
    expect(shape(p)).toEqual([['LOCATION', 0, 0, true], ['EXPERIENCE', 0, 1, true]]);
  });

  it('one item spans; none is empty', () => {
    expect(shape(planMeta(it3.slice(0, 1), widths({}), W))).toEqual([['LOCATION', 0, 0, true]]);
    expect(planMeta([], widths({}), W).placements).toEqual([]);
  });

  describe('with a wrapping item (WORK SETUP) last', () => {
    const work: MetaItem = { key: 'WORK SETUP', value: { text: 'WORK SETUP' }, wrap: true };
    const it4 = [...it3, work];
    const w4 = (o: Record<string, number> = {}) => widths({ 'WORK SETUP': 560, ...o });

    it('four items: Location | Experience on row 0 exactly as in the reference, Team | the sentence on row 1', () => {
      const p = planMeta(it4, w4(), W);
      expect(shape(p)).toEqual([['LOCATION', 0, 0, false], ['EXPERIENCE', 1, 0, false], ['TEAM', 0, 1, false], ['WORK SETUP', 1, 1, false]]);
      expect(p.col1X).toBe(300);
      expect(p.dropped).toBeUndefined();
    });

    it('the first three keep the reference positions they have without the fourth', () => {
      const three = planMeta(it3, w4(), W);
      const four = planMeta(it4, w4(), W);
      expect(four.placements.slice(0, 2)).toEqual(three.placements.slice(0, 2));
      expect(four.col1X).toBe(three.col1X);
    });

    it('a wide Location widens the first column for four items too', () => {
      const p = planMeta(it4, w4({ LOCATION: 330 }), W);
      expect(p.col1X).toBe(358);
      expect(shape(p).map(x => x[0])).toEqual(['LOCATION', 'EXPERIENCE', 'TEAM', 'WORK SETUP']);
    });

    it('when the sentence would be cut in its column, Team is left out and the sentence spans row 1', () => {
      const p = planMeta(it4, w4(), W, 28, 0.87, () => false);
      expect(shape(p)).toEqual([['LOCATION', 0, 0, false], ['EXPERIENCE', 1, 0, false], ['WORK SETUP', 0, 1, true]]);
      expect(p.dropped).toEqual(['TEAM']);
    });

    it('wrapFits is asked about the second column (what is left of the row after the boundary)', () => {
      const asked: number[] = [];
      planMeta(it4, w4(), W, 28, 0.87, (_it, width) => { asked.push(width); return true; });
      expect(asked).toEqual([300]);                       // metaW 600 - boundary 300
      const wide: number[] = [];
      planMeta(it4, w4({ LOCATION: 330 }), W, 28, 0.87, (_it, width) => { wide.push(width); return true; });
      expect(wide).toEqual([242]);                        // 600 - 358
    });

    it('a Location that cannot take its half drops Team and plans the other three as usual', () => {
      const p = planMeta(it4, w4({ LOCATION: 600 }), W);
      expect(p.dropped).toEqual(['TEAM']);
      expect(p.placements.map(x => x.key)).toEqual(['LOCATION', 'EXPERIENCE', 'WORK SETUP']);
      expect(p.placements.every(x => x.row <= 1)).toBe(true);
    });

    it('three items without Team: the sentence spans row 1 (it is not a short value, so it is never squeezed beside another)', () => {
      const p = planMeta([it3[0], it3[1], work], w4(), W);
      expect(shape(p)).toEqual([['LOCATION', 0, 0, false], ['EXPERIENCE', 1, 0, false], ['WORK SETUP', 0, 1, true]]);
      expect(p.dropped).toBeUndefined();
    });

    it('the wrap flag survives into the placement; other items never carry it', () => {
      const p = planMeta(it4, w4(), W);
      expect(p.placements.map(x => !!x.wrap)).toEqual([false, false, false, true]);
    });

    it('never more than two rows, whatever the widths', () => {
      for (const l of [10, 200, 330, 450, 600, 900]) for (const t of [10, 300, 600]) {
        const p = planMeta(it4, w4({ LOCATION: l, TEAM: t }), W);
        expect(Math.max(...p.placements.map(x => x.row))).toBeLessThanOrEqual(1);
      }
    });
  });
});

describe('fitWrapped', () => {
  const mf = (text: string, size: number) => measure(text, 'figBold', size, -0.01 * size);

  it('keeps full size when the sentence fits on its lines at that size', () => {
    const r = fitWrapped('Remote possible', 'figBold', 400, 2, 23, 15, -0.01, measure);
    expect(r.size).toBe(23);
    expect(r.lines).toEqual(['Remote possible']);
  });

  it('wraps onto two lines at the largest size that fits without cutting a word', () => {
    const text = 'Remote working possible for exceptional candidates';
    const r = fitWrapped(text, 'figBold', 205, 2, 23, 15, -0.01, measure);
    expect(r.lines.join(' ')).toBe(text);
    expect(r.lines.length).toBe(2);
    for (const l of r.lines) expect(mf(l, r.size)).toBeLessThanOrEqual(205);
    // largest: half a point bigger would not have fit
    const bigger = fitWrapped(text, 'figBold', 205, 2, r.size + 0.5, r.size + 0.5, -0.01, measure);
    expect(bigger.lines.join(' ') === text).toBe(false);
  });

  it('at the minimum size what still does not fit ends in an ellipsis; never more lines than allowed', () => {
    const r = fitWrapped('word '.repeat(40).trim(), 'figBold', 160, 2, 23, 15, -0.01, measure);
    expect(r.size).toBe(15);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1].endsWith('…')).toBe(true);
    for (const l of r.lines) expect(mf(l, 15)).toBeLessThanOrEqual(160);
  });

  it('one very long word is cut with an ellipsis rather than overflowing', () => {
    const r = fitWrapped('x'.repeat(80), 'figBold', 150, 2, 23, 15, -0.01, measure);
    expect(r.lines.every(l => mf(l, r.size) <= 150)).toBe(true);
    expect(r.lines[r.lines.length - 1].endsWith('…')).toBe(true);
  });

  it('ignores extra whitespace in the input', () => {
    expect(fitWrapped('  a   b  ', 'figBold', 400, 2, 23, 15, -0.01, measure).lines).toEqual(['a b']);
  });

  it('is deterministic and never returns an empty list for text', () => {
    const a = fitWrapped('some words to wrap around a column', 'figBold', 120, 2, 23, 15, -0.01, measure);
    const b = fitWrapped('some words to wrap around a column', 'figBold', 120, 2, 23, 15, -0.01, measure);
    expect(a).toEqual(b);
    expect(a.lines.length).toBeGreaterThan(0);
  });
});

describe('packChips', () => {
  const chipW = (t: string) => measure(t, 'figBold', GEO.chipFont, GEO.chipSpacing * GEO.chipFont) + 2 * GEO.chipPadX;
  const blue = (...t: string[]) => t.map(text => ({ text, isGreen: false }));
  const green = (...t: string[]) => t.map(text => ({ text, isGreen: true }));

  it('uppercases, de-duplicates case-insensitively, and puts craft (blue) chips before sector (green)', () => {
    const r = packChips([...green('Climate'), ...blue('Brand', 'brand', 'Copy')], measure);
    const flat = r.rows.flat();
    expect(flat.map(c => c.text)).toEqual(['BRAND', 'COPY', 'CLIMATE']);
    expect(flat.map(c => c.green)).toEqual([false, false, true]);
  });

  it('gives each colour group its own row when both fit (the reference layout)', () => {
    const r = packChips([...blue('Brand Building', 'Campaign Strategy', 'Creative Direction', 'Copywriting', 'Visual Design'),
      ...green('Climate/Sustainability', 'B2B Marketing', 'Video Production')], measure);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].every(c => !c.green)).toBe(true);
    expect(r.rows[1].every(c => c.green)).toBe(true);
    expect(r.dropped).toBe(0);
  });

  it('centres every row inside the content width', () => {
    const r = packChips([...blue('Alpha', 'Beta', 'Gamma'), ...green('Delta')], measure);
    for (const row of r.rows) {
      const left = row[0].x - MARGIN;
      const last = row[row.length - 1];
      const right = MARGIN + CONTENT_W - (last.x + last.w);
      expect(Math.abs(left - right)).toBeLessThan(0.01);
    }
  });

  it('never exceeds two rows — it drops trailing tags instead', () => {
    const many = [...blue(...Array.from({ length: 14 }, (_, i) => `Skill number ${i}`))];
    const r = packChips(many, measure);
    expect(r.rows.length).toBeLessThanOrEqual(GEO.chipMaxRows);
    expect(r.dropped).toBeGreaterThan(0);
    for (const row of r.rows) {
      const w = row.reduce((s, c) => s + c.w, 0) + GEO.chipGap * (row.length - 1);
      expect(w).toBeLessThanOrEqual(CONTENT_W + 0.01);
    }
  });

  it('truncates absurdly long tags', () => {
    const r = packChips(blue('x'.repeat(60)), measure);
    expect(r.rows[0][0].text.length).toBeLessThanOrEqual(26);
    expect(r.rows[0][0].text.endsWith('…')).toBe(true);
    expect(r.rows[0][0].w).toBe(chipW(r.rows[0][0].text));
  });

  it('handles no tags at all', () => {
    expect(packChips(undefined, measure)).toEqual({ rows: [], dropped: 0 });
    expect(packChips([], measure)).toEqual({ rows: [], dropped: 0 });
    expect(chipsBlockHeight(0)).toBe(0);
    expect(chipsBlockHeight(2)).toBe(2 * GEO.chipH + GEO.chipGap);
  });
});

describe('parseBullet', () => {
  it.each([
    ['<b>Mission:</b> Architect the story', { lead: 'Mission', desc: 'Architect the story' }],
    ['<b>Mission</b>: Architect the story', { lead: 'Mission', desc: 'Architect the story' }],
    ['Mission: Architect the story.', { lead: 'Mission', desc: 'Architect the story' }],
    ["<b>Early stage:</b> A presence the world can't ignore", { lead: 'Early stage', desc: 'A presence the world can’t ignore' }],
    ['Just a bare statement', { lead: 'Just a bare statement', desc: '' }],
    ['<b>Only a lead:</b>', { lead: 'Only a lead', desc: '' }],
  ])('%s', (raw, expected) => expect(parseBullet(raw)).toEqual(expected));
});

describe('layoutColumns', () => {
  const row = (lead: string, desc: string) => ({ lead, desc });
  const five = (suffix = '') => Array.from({ length: 5 }, (_, i) => row(`Lead ${i + 1}${suffix}`, `A short detail ${i + 1}`));
  // the real available height for a role with two chip rows (R019): CTA top − gap − columns top
  const AVAIL = 1267 - GEO.colsBottomGap - (GEO.chipsTop + 2 * GEO.chipH + GEO.chipGap + GEO.colsGapAfterChips);

  it('lays five normal rows out at the designed size and pitch with no breathing room added', () => {
    const l = layoutColumns(five(), five(), AVAIL, measure);
    expect(l.scale).toBe(1);
    expect(l.overflow).toBe(false);
    expect(l.rows).toHaveLength(5);
    for (const r of l.rows) { expect(r.pad).toBe(COLS.pad); expect(r.h).toBeCloseTo(88.325, 2); }
    expect(l.total).toBeLessThanOrEqual(AVAIL);
  });

  it('wraps a long detail to two lines when there is room', () => {
    const long = row('Lead', 'This detail is deliberately much too long to sit on a single line in a narrow column');
    const l = layoutColumns([long], [row('Lead', 'short')], 900, measure);
    expect(l.rows[0].left!.descLines).toHaveLength(2);
    expect(l.rows[0].right!.descLines).toHaveLength(1);
    expect(l.rows[0].h).toBeGreaterThan(88.4); // taller row, shared across both columns
  });

  it('squeezes (scale < 1, single-line details) rather than overlapping when space is tight', () => {
    const long = Array.from({ length: 5 }, (_, i) => row(`Lead ${i}`, 'This detail is deliberately much too long to sit on a single line in a narrow column'));
    const l = layoutColumns(long, long, AVAIL, measure);
    expect(l.scale).toBeLessThan(1);
    expect(l.overflow).toBe(false);
    expect(l.total).toBeLessThanOrEqual(AVAIL + 0.5);
    for (const r of l.rows) expect(r.left!.descLines.length).toBeLessThanOrEqual(2);
  });

  it('reports overflow honestly when nothing can fit, instead of pretending', () => {
    const long = Array.from({ length: 5 }, () => row('Lead', 'This detail is deliberately much too long to sit on a single line in a narrow column'));
    expect(layoutColumns(long, long, 200, measure).overflow).toBe(true);
  });

  it('lets a sparse role breathe, but only up to the cap', () => {
    const l = layoutColumns(five().slice(0, 3), five().slice(0, 3), AVAIL, measure);
    expect(l.rows[0].pad).toBeGreaterThan(COLS.pad);
    expect(l.rows[0].pad).toBeLessThanOrEqual(COLS.maxPad);
    expect(l.total).toBeLessThanOrEqual(AVAIL);
  });

  it('shares row heights across columns and tolerates unequal counts', () => {
    const l = layoutColumns(five(), five().slice(0, 3), AVAIL, measure);
    expect(l.rows).toHaveLength(5);
    expect(l.rows[4].left).toBeDefined();
    expect(l.rows[4].right).toBeUndefined();
  });

  it('handles an empty role', () => {
    const l = layoutColumns([], [], AVAIL, measure);
    expect(l.rows).toEqual([]);
    expect(l.overflow).toBe(false);
  });

  it('shrinks an over-long lead rather than overflowing its column', () => {
    const l = layoutColumns([row('A lead that is far too long for one column line', 'x')], [], AVAIL, measure);
    expect(l.rows[0].left!.leadSize).toBeLessThan(COLS.leadSize);
  });
});

describe('the 40/60 contract', () => {
  it('defines the hero limit as 40% of the page height', () => {
    expect(HERO_MAX_BOTTOM).toBe(PAGE_H * 0.4);
  });
});
