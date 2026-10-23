import { describe, it, expect } from 'vitest';
import { enforceEvidenceRules, type EvidenceContext } from './rubric.marketing.js';
import type { CriterionResult, CriterionVerdict } from './types.js';

// Fix round 5, B1 (fourth review, review4-fairness-rubric): the quote matcher accepted a DROPPED OR MOVED DECIMAL POINT as an exact verbatim quote.
// wordKey turned every non-alphanumeric run into a space, so "3.5" became the two words "3" and "5"; the run-together reading (the one that
// matches a word an extractor split, "Cam paign") then joined them with no separator, so a text's "3.5%" read as a quote's "35%" and an invented
// outcome figure ten times too large kept a strong verdict with no note. Two changes close it:
//   1. a decimal point between digits is kept as a letter of its own (so "3.5" is one word, and "3 5" and "35" are other words);
//   2. the run-together reading never joins a word that ends in a digit to one that starts with a digit ("3 5 lakh" is not "35 lakh").
// Every row below is run through enforceEvidenceRules with a strong eq_outcomes verdict quoting the text.

const MULTIPLY = String.fromCharCode(0xd7);

const read = (evidence: string, verdict: CriterionVerdict = 'strong'): CriterionResult => ({
  id: 'eq_outcomes', label: 'Outcomes', verdict, evidence, group: 'quality', weight: 1.5, basis: 'read', source: 'L1', assessable: true,
});
const ctxOf = (text: string): EvidenceContext => ({
  acquired: [{ ref: 'L1', basis: 'artifact', outcome: 'ok', text, link: { platform: 'custom' } }], claimText: '',
});
type Kind = 'exact' | 'near' | 'absent';
/** exact = a strong verdict kept with no note; near = held at partial for a near match; absent = invented (not_evidenced). */
function kindOf(quote: string, text: string): Kind {
  const r = enforceEvidenceRules([read(`Shows "${quote}" in the deck`)], ctxOf(text));
  const notes = r.notes.join(' | ');
  if (/near match/.test(notes)) return 'near';
  if (/not found/.test(notes) && r.criteria[0].verdict === 'not_evidenced') return 'absent';
  if (r.notes.length === 0 && r.criteria[0].verdict === 'strong') return 'exact';
  throw new Error(`unclassifiable: ${r.criteria[0].verdict} / ${notes}`);
}

// ─── The reviewer's pair table ───────────────────────────────────────────────
// BEFORE the fix every collision row was accepted as EXACT (a strong verdict with no note) except "1.8%/0.9%", "1.2M/12M", "1.2M/12 million" and "0.5/5" (absent
// or near); AFTER, every one is invented. Both directions are in: the text may carry the decimal and the quote drop it, or the other way round.
describe('B1: a dropped or moved decimal point is an invented figure, not a verbatim quote', () => {
  const rows: Array<[text: string, quote: string]> = [
    ['Engagement rose 3.5% in the quarter after launch.', 'Engagement rose 35% in the quarter after launch'],
    ['Engagement rose 35% in the quarter after launch.', 'Engagement rose 3.5% in the quarter after launch'],
    ['Engagement rose 3.5% in the quarter after launch.', 'Engagement rose 8.5% in the quarter after launch'],
    ['Click-through improved to 1.8% from 0.9% on paid social.', 'Click-through improved to 18% from 9% on paid social'],
    ['Click-through improved to 18% from 9% on paid social.', 'Click-through improved to 1.8% from 0.9% on paid social'],
    ['The rebrand delivered a 2.4x lift in qualified leads.', 'The rebrand delivered a 24x lift in qualified leads'],
    ['The rebrand delivered a 2.4x lift in qualified leads.', 'The rebrand delivered a 24 x lift in qualified leads'],
    ['The rebrand delivered a 24x lift in qualified leads.', 'The rebrand delivered a 2.4x lift in qualified leads'],
    ['Rated 4.5 stars by 800 customers after the relaunch.', 'Rated 45 stars by 800 customers after the relaunch'],
    ['Rated 45 stars by 800 customers after the relaunch.', 'Rated 4.5 stars by 800 customers after the relaunch'],
    ['Cost per lead fell to Rs 1.25 from Rs 2.50 during the pilot.', 'Cost per lead fell to Rs 125 from Rs 250 during the pilot'],
    ['Cost per lead fell to Rs 1.25 from Rs 2.50 during the pilot.', 'Cost per lead fell to Rs 125 ... Rs 250 during the pilot'],
    ['Cost per lead fell to Rs 125 from Rs 250 during the pilot.', 'Cost per lead fell to Rs 1.25 from Rs 2.50 during the pilot'],
    ['Brand recall went from 12.5% to 31% in the target cohort.', 'Brand recall went from 125% to 31% in the target cohort'],
    ['Brand recall went from 12.5% to 31% in the target cohort.', 'Brand recall went from 12 5% to 31% in the target cohort'],
    ['Brand recall went from 125% to 31% in the target cohort.', 'Brand recall went from 12.5% to 31% in the target cohort'],
    ['Open rate hit 41.2 percent across 9 sends.', 'Open rate hit 412 percent across 9 sends'],
    ['Open rate hit 41.2 percent across 9 sends.', 'Open rate hit 4.12 percent across 9 sends'],
    ['Open rate hit 412 percent across 9 sends.', 'Open rate hit 41.2 percent across 9 sends'],
    ['Reach was 3 5 lakh households.', 'Reach was 35 lakh households'],
    ['Reach was 35 lakh households.', 'Reach was 3 5 lakh households'],
    ['Reached 1.2M people, 40% more than plan.', 'Reached 12M people, 40% more than plan'],
    ['Reached 1.2M people, 40% more than plan.', 'Reached 12 million people, 40% more than plan'],
    ['Conversion improved by 0.5 points over the baseline.', 'Conversion improved by 5 points over the baseline'],
    ['Growth was 1.5x in the first quarter of the year.', 'Growth was fifteen x in the first quarter of the year'],
    ['Growth was 1.5x in the first quarter of the year.', 'Growth was fifteen times in the first quarter of the year'],
    ['Growth was 15x in the first quarter of the year.', 'Growth was 1.5x in the first quarter of the year'],
  ];
  it.each(rows)('%s  <-  "%s"', (text, quote) => {
    expect(kindOf(quote, text)).toBe('absent');
  });

  it('the strong verdict does not survive it, whichever verdict the model gave, and the note says the quote is invented', () => {
    for (const verdict of ['strong', 'partial', 'concern'] as const) {
      const r = enforceEvidenceRules([read('Says "Engagement rose 35% in the quarter after launch"', verdict)], ctxOf('Engagement rose 3.5% in the quarter after launch.'));
      expect(r.criteria[0]).toMatchObject({ verdict: 'not_evidenced', basis: 'none', source: '', evidence: '' });
      expect(r.notes[0]).toMatch(/^eq_outcomes: quoted text not found in L1; the quote is invented, so \w+ lowered to not_evidenced$/);
    }
  });

  describe('the honest spellings of the same figures are still exact', () => {
    const honest: Array<[text: string, quote: string]> = [
      ['Engagement rose 3.5% in the quarter after launch.', 'Engagement rose 3.5 percent in the quarter after launch'],
      ['Engagement rose 3.5 percent in the quarter after launch.', 'Engagement rose 3.5% in the quarter after launch'],
      ['Engagement rose 3.5% in the quarter after launch.', 'Engagement rose 3.5 per cent in the quarter after launch'],
      ['Engagement rose 3.5% in the quarter after launch.', 'Engagement rose 3.5 % in the quarter after launch'],
      ['The rebrand delivered a 2.4x lift in qualified leads.', 'The rebrand delivered a 2.4 x lift in qualified leads'],
      ['The rebrand delivered a 2.4x lift in qualified leads.', `The rebrand delivered a 2.4${MULTIPLY} lift in qualified leads`],
      [`The rebrand delivered a 2.4${MULTIPLY} lift in qualified leads.`, 'The rebrand delivered a 2.4x lift in qualified leads'],
      ['Reached 1.2M people, 40% more than plan.', 'Reached 1.2 million people, 40% more than plan'],
      ['Reached 1.2 million people, 40% more than plan.', 'Reached 1.2M people, 40% more than plan'],
      ['Reached 1.2M people, 40% more than plan.', 'Reached 12,00,000 people, 40% more than plan'],
      ['Reach grew from 12,000 to 340,000 in six months.', 'Reach grew from 12000 to 340000 in 6 months'],
      ['Reach grew from 12000 to 340000 in 6 months.', 'Reach grew from 12,000 to 340,000 in six months'],
      ['Budget was Rs 1,25,000 for the pilot campaign.', 'Budget was Rs 125000 for the pilot campaign'],
      ['Budget was Rs 125000 for the pilot campaign.', 'Budget was Rs 1,25,000 for the pilot campaign'],
      ['Budget was Rs 1,250 for the pilot campaign alone.', 'Budget was Rs 1250 for the pilot campaign alone'],
      ['Budget was Rs 1,250 for the pilot campaign alone.', 'Budget was Rs. 1,250 for the pilot campaign alone'],
      ['We ran 3-5 campaigns every single quarter.', 'We ran 3-5 campaigns every single quarter'],
      ['We ran 3-5 campaigns every single quarter.', 'We ran 3 - 5 campaigns every single quarter'],
      ['Reached six cities in a dozen weeks flat.', 'Reached 6 cities in 12 weeks flat'],
      ['Reached 6 cities in 12 weeks flat.', 'Reached six cities in a dozen weeks flat'],
      ['Rated 4.5 stars by 800 customers after the relaunch.', 'Rated 4.5 stars by 800 customers after the relaunch'],
      ['Cost per lead fell to Rs. 1.25 from Rs. 2.50 during the pilot.', 'Cost per lead fell to ₹1.25 from ₹2.50 during the pilot'],
      ['Cost per lead fell to Rs 1.25 from Rs 2.50 during the pilot.', 'Cost per lead fell to Rs 1.25 ... Rs 2.50 during the pilot'],
      ['The Campaign Shipped as Cam paign One for retail.', 'The Campaign Shipped as Campaign One for retail'],
      ['The Campaign Shipped as Campaign One for retail.', 'The Campaign Shipped as Cam paign One for retail'],
      ['Reach was 3 500000 households.', 'Reach was 3 500000 households'],
      ['Reach was 3.5 lakh households.', 'Reach was 3,50,000 households'],
      ['Reach was 3,50,000 households.', 'Reach was 3.5 lakh households'],
      ['Reach was 3.5 lakh households.', 'Reach was 350000 households'],
    ];
    it.each(honest)('%s  <-  "%s"', (text, quote) => {
      expect(kindOf(quote, text)).toBe('exact');
    });
  });

  it('a near match keeps its figures as ONE word: a changed decimal is absent, an intact one is a near match', () => {
    const text = 'The retail pilot across 140 stores lifted repeat purchase by 2.7 percent in the first quarter of the year.';
    expect(kindOf('retail pilot across 140 stores boosted repeat purchase by 2.7 percent', text)).toBe('near');
    expect(kindOf('retail pilot across 140 stores boosted repeat purchase by 8.7 percent', text)).toBe('absent');
    expect(kindOf('retail pilot across 140 stores boosted repeat purchase by 27 percent', text)).toBe('absent');
    expect(kindOf('retail pilot across 140 stores boosted repeat purchase by 0.27 percent', text)).toBe('absent');
  });
});

// ─── HELD-OUT corpus, round 5 ────────────────────────────────────────────────
// Written BEFORE the fix and before it was run: one new text, 50 quotes with decimal / currency / percent / multiplier / rating / date / lakh-crore shapes,
// each marked with what a reader expects (exact: the same figures written another way; near: a paraphrase with every figure intact; absent: a changed,
// dropped or moved figure). FIRST MEASUREMENT, before the fix: 31 of 50 as expected, with 17 fabrications accepted as EXACT (a strong verdict, no note)
// and 2 held at near; after the fix: 50 of 50. The 3 honest re-spellings the fix zeroes are the known limits below, written and measured the same way.
describe('HELD-OUT corpus, round 5 (decimal-point fix; written before it, not tuned on)', () => {
  const F = [
    '[page 1]',
    'Annual marketing review, FY 2024-25.',
    'Average rating rose to 4.6 stars from 4.1 across 3,200 reviews.',
    'Cart abandonment fell 18.5% after the checkout redesign, a 1.7x improvement over last year.',
    'Cost per acquisition dropped to Rs 86.40 from Rs 124.75.',
    '[page 2]',
    'Newsletter click rate was 2.8% against an industry median of 1.4%.',
    'We grew the community from 0.8 lakh to 2.3 lakh members.',
    'The launch happened on 12.03.2025 and the sale ended 20 March 2025.',
    'Return on ad spend reached 3.2x on Meta and 5.1x on search.',
    'Revenue hit Rs 4.5 crore, up 62.5% year on year.',
    '[page 3]',
    'Version 2.0 of the brand guide shipped to 14 partners.',
    'Packaging weight was cut by 0.35 kg per unit, saving 1.2 tonnes a month.',
  ].join('\n');

  const rows: Array<[quote: string, want: Kind]> = [
    // exact: the same figures, written another way (18)
    ['Average rating rose to 4.6 stars from 4.1 across 3,200 reviews', 'exact'],
    ['Average rating rose to 4.6 stars from 4.1 across 3200 reviews', 'exact'],
    ['Cart abandonment fell 18.5 percent after the checkout redesign', 'exact'],
    ['Cart abandonment fell 18.5 per cent after the checkout redesign, a 1.7 x improvement over last year', 'exact'],
    [`a 1.7${MULTIPLY} improvement over last year`, 'exact'],
    ['Cost per acquisition dropped to ₹86.40 from ₹124.75', 'exact'],
    ['Cost per acquisition dropped to Rs. 86.40 from Rs. 124.75', 'exact'],
    ['Newsletter click rate was 2.8 percent against an industry median of 1.4 percent', 'exact'],
    ['We grew the community from 80,000 to 2,30,000 members', 'exact'],
    ['We grew the community from 0.8 lakh to 2.3 lakh members', 'exact'],
    ['The launch happened on 12.03.2025 and the sale ended 20 March 2025', 'exact'],
    ['Return on ad spend reached 3.2x on Meta and 5.1x on search', 'exact'],
    ['Return on ad spend reached 3.2 x on Meta and 5.1 x on search', 'exact'],
    ['Revenue hit Rs 4.5 crore, up 62.5% year on year', 'exact'],
    ['Revenue hit Rs 45 million, up 62.5 percent year on year', 'exact'],
    ['Version 2.0 of the brand guide shipped to 14 partners', 'exact'],
    ['Packaging weight was cut by 0.35 kg per unit, saving 1.2 tonnes a month', 'exact'],
    ['Cost per acquisition dropped to Rs 86.40 ... Rs 124.75', 'exact'],
    // near: a little paraphrased, every figure intact (5)
    ['Average rating climbed to 4.6 stars from 4.1 across 3,200 reviews', 'near'],
    ['Cart abandonment dropped 18.5% after the checkout redesign, a 1.7x gain over last year', 'near'],
    ['Newsletter click rate was 2.8% versus an industry median of 1.4%', 'near'],
    ['Return on ad spend hit 3.2x on Meta and 5.1x on search', 'near'],
    ['Revenue reached Rs 4.5 crore, up 62.5% year on year', 'near'],
    // absent: a changed, dropped or moved figure (27)
    ['Average rating rose to 46 stars from 4.1 across 3,200 reviews', 'absent'],
    ['Average rating rose to 4.6 stars from 41 across 3,200 reviews', 'absent'],
    ['Average rating rose to 4.6 stars from 4.1 across 32,000 reviews', 'absent'],
    ['Cart abandonment fell 185% after the checkout redesign', 'absent'],
    ['Cart abandonment fell 1.85 percent after the checkout redesign', 'absent'],
    ['Cart abandonment fell 18 5 percent after the checkout redesign', 'absent'],
    ['Cart abandonment fell 8.5% after the checkout redesign, a 1.7x improvement over last year', 'absent'],
    ['a 17x improvement over last year', 'absent'],
    ['a 17 x improvement over last year', 'absent'],
    ['Cost per acquisition dropped to Rs 8640 from Rs 12475', 'absent'],
    ['Cost per acquisition dropped to Rs 8.64 from Rs 12.475', 'absent'],
    ['Cost per acquisition dropped to Rs 8.64 ... Rs 124.75', 'absent'],
    ['Newsletter click rate was 28% against an industry median of 14%', 'absent'],
    ['Newsletter click rate was 2.8% against an industry median of 0.14%', 'absent'],
    ['We grew the community from 8 lakh to 23 lakh members', 'absent'],
    ['We grew the community from 0.8 lakh to 2.3 crore members', 'absent'],
    ['The launch happened on 12.30.2025 and the sale ended 20 March 2025', 'absent'],
    ['Return on ad spend reached 32x on Meta and 5.1x on search', 'absent'],
    ['Return on ad spend reached 3.2x on Meta and 51x on search', 'absent'],
    ['Revenue hit Rs 45 crore, up 62.5% year on year', 'absent'],
    ['Revenue hit Rs 4.5 crore, up 6.25% year on year', 'absent'],
    ['Revenue hit Rs 4.5 crore, up 625% year on year', 'absent'],
    ['Version 20 of the brand guide shipped to 14 partners', 'absent'],
    ['Version 2.0 of the brand guide shipped to 1.4 partners', 'absent'],
    ['Packaging weight was cut by 35 kg per unit, saving 1.2 tonnes a month', 'absent'],
    ['Packaging weight was cut by 0.35 kg per unit, saving 12 tonnes a month', 'absent'],
    ['Packaging weight was cut by 0.35 kg per unit, saving 1 2 tonnes a month', 'absent'],
  ];

  it.each(rows.map(([q, want], i) => [`#${i + 1} ${want}: ${q}`, q, want] as const))('%s', (_name, quote, want) => {
    expect(kindOf(quote, F)).toBe(want);
  });

  it('summary: every figure re-spelled is kept, every paraphrase is held at partial, every changed / dropped / moved figure is rejected', () => {
    const wrong = rows.filter(([q, want]) => kindOf(q, F) !== want);
    expect(wrong).toEqual([]);
    expect(rows).toHaveLength(50);
    expect(rows.filter(r => r[1] === 'absent')).toHaveLength(27);
  });

  it('none of the rejected rows can stand at any verdict (a strong one is not even held at partial)', () => {
    for (const [q] of rows.filter(r => r[1] === 'absent')) {
      for (const verdict of ['strong', 'partial', 'concern'] as const) {
        expect(enforceEvidenceRules([read(`Says "${q}"`, verdict)], ctxOf(F)).criteria[0].verdict, `${verdict}: ${q}`).toBe('not_evidenced');
      }
    }
  });

  // Known limits, stated rather than hidden: honest re-spellings the fix now refuses (written before it was run: all three were EXACT before, absent after).
  describe('known limits (documented, not tuned away)', () => {
    it('a dotted date written with spaces or dashes is a different spelling of a number-and-decimal-point text: refused', () => {
      expect(kindOf('The launch happened on 12 03 2025 and the sale ended 20 March 2025', F)).toBe('absent');
      expect(kindOf('The launch happened on 12-03-2025 and the sale ended 20 March 2025', F)).toBe('absent');
      // the date as the text wrote it is exact, as above
      expect(kindOf('The launch happened on 12.03.2025 and the sale ended 20 March 2025', F)).toBe('exact');
    });
    it('a thousands group written with a space in the text (340 000) is no longer joined to the quote\'s 340,000', () => {
      expect(kindOf('Reached 340,000 people in 3 months', 'Reached 340 000 people in three months')).toBe('absent');
      expect(kindOf('Reached 340 000 people in 3 months', 'Reached 340 000 people in three months')).toBe('exact');
    });
  });
});

// ─── Digits never join ───────────────────────────────────────────────────────
describe('the run-together reading joins broken words, never two numbers', () => {
  // Seeded, so a failure is reproducible: 300 numbers split in two groups, quoted joined, and the other way round.
  const lcg = (seed: number) => { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32; };
  const rnd = lcg(20261023);
  const digits = (n: number) => Array.from({ length: n }, () => String(Math.floor(rnd() * 10))).join('');
  const cases = Array.from({ length: 300 }, () => {
    const a = digits(1 + Math.floor(rnd() * 3));
    const b = digits(1 + Math.floor(rnd() * 3));
    return { a, b, sep: ['.', ' ', '-'][Math.floor(rnd() * 3)] };
  });
  const sentence = (x: string) => `The pilot campaign reached ${x} stores across the region`;

  it('300 random "a<separator>b" in the text against "ab" in the quote, and the reverse: never a verbatim quote', () => {
    const exact: string[] = [];
    for (const { a, b, sep } of cases) {
      if (kindOf(sentence(`${a}${b}`), `${sentence(`${a}${sep}${b}`)}.`) === 'exact') exact.push(`text ${a}${sep}${b} / quote ${a}${b}`);
      if (kindOf(sentence(`${a}${sep}${b}`), `${sentence(`${a}${b}`)}.`) === 'exact') exact.push(`text ${a}${b} / quote ${a}${sep}${b}`);
    }
    expect(exact).toEqual([]);
  });

  it('a thousands comma is still the same number (12,345 is 12345), and a split WORD is still joined', () => {
    for (const { a, b } of cases.slice(0, 60)) {
      const thousands = `${a}${b.padStart(3, '7')}`;
      const grouped = `${a},${b.padStart(3, '7')}`;
      expect(kindOf(sentence(grouped), `${sentence(thousands)}.`)).toBe('exact');
      expect(kindOf(sentence(thousands), `${sentence(grouped)}.`)).toBe('exact');
    }
    expect(kindOf('Product photography was shot in-house this year', 'Pro duct photography was shot in-house this year')).toBe('exact');
    expect(kindOf('Pro duct photography was shot in-house this year', 'Product photography was shot in-house this year')).toBe('exact');
  });

  it('a letter and a digit still join (an extractor may split "covid19"), because the figure itself is unchanged', () => {
    expect(kindOf('The covid19 relief campaign reached many households', 'The covid 19 relief campaign reached many households.')).toBe('exact');
    expect(kindOf('The covid 19 relief campaign reached many households', 'The covid19 relief campaign reached many households.')).toBe('exact');
    expect(kindOf('The covid 20 relief campaign reached many households', 'The covid 19 relief campaign reached many households.')).toBe('absent');
  });
});

// ─── Hostile text ────────────────────────────────────────────────────────────
describe('the decimal-point rule stays linear on hostile text', () => {
  const timed = (text: string, quote: string): number => {
    const t0 = performance.now();
    enforceEvidenceRules([read(`Says "${quote}"`)], ctxOf(text));
    return performance.now() - t0;
  };
  const rep = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join(' ');
  it.each([
    ['200,000 "1." pairs', '1.'.repeat(200000), 'grew reach from 1.1 to 1.1.1 in six months'],
    ['130,000 "3.5 " tokens', '3.5 '.repeat(130000), 'grew reach 3.5 3.5 3.5 3.5 3.5 3.5 3.5'],
    ['200,000 "1 " digit words against a 40-word quote of 1s', '1 '.repeat(200000), rep(40, () => '1')],
    ['100,000 "12 34 " pairs against a run-together quote', '12 34 '.repeat(100000), 'grew 1234 1234 1234 1234 1234 reach in months'],
    ['100,000 "1.1." groups against 40 decimals', '1.1.'.repeat(100000), rep(40, i => `${i}.5`)],
    ['60,000 words with decimals against 40 decimals', rep(60000, i => ['the', 'campaign', 'grew', 'reach', 'and', '3.5', 'launched'][i % 7]), rep(40, i => ['campaign', 'grew', '3.5', 'reach'][i % 4])],
  ])('%s', (_name, text, quote) => {
    expect(timed(text, quote)).toBeLessThan(2500);
  });
});
