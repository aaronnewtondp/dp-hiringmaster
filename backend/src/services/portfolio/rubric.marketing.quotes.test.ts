import { describe, it, expect } from 'vitest';
import { enforceEvidenceRules, type EvidenceContext } from './rubric.marketing.js';
import type { CriterionResult, CriterionVerdict } from './types.js';

// How a model's quote is held to the text it was given (rubric.marketing.ts, rule 8): found verbatim (after folding numbers and
// symbols), found as a NEAR match (at least 70% of its words in order, every figure, negation and name present: held at partial),
// or not found (invented: not_evidenced). Second adversarial review, F12: "5.2 percent" for "5.2%", "2.9 x" for "2.9x" and the
// kerning-split "Cam paign" used to be treated like a fabricated sentence.

const MULTIPLY = String.fromCharCode(0xd7);

const read = (evidence: string, verdict: CriterionVerdict = 'strong'): CriterionResult => ({
  id: 'mh3', label: 'Launched 5+ campaigns', verdict, evidence, group: 'direct', weight: 1.5, basis: 'read', source: 'L1', assessable: true,
});
const ctxOf = (text: string, claimText = ''): EvidenceContext => ({
  acquired: [{ ref: 'L1', basis: 'artifact', outcome: 'ok', text, link: { platform: 'custom' } }], claimText,
});
type Kind = 'exact' | 'near' | 'absent';
/** What the matcher decided: exact = a strong verdict kept with no note; near = lowered to partial for a near match; absent = invented. */
function kindOf(evidence: string, text: string, verdict: CriterionVerdict = 'strong'): Kind {
  const r = enforceEvidenceRules([read(evidence, verdict)], ctxOf(text));
  const v = r.criteria[0].verdict;
  const notes = r.notes.join(' | ');
  if (/near match/.test(notes)) return 'near';
  if (/not found/.test(notes) && v === 'not_evidenced') return 'absent';
  if (r.notes.length === 0 && v === verdict) return 'exact';
  throw new Error(`unclassifiable: ${v} / ${notes}`);
}

// ─── The reviewer's reproductions (F12) ──────────────────────────────────────
describe('F12 — a quote that is only written differently is found, a fabricated one is not', () => {
  const TEXT = `[page 1]\nWater Wise 2024: we grew LinkedIn reach from 12,000 to 340,000 in six months.\nOur "brand-new" identity replaced the legacy look.\n[page 2]\nThe market-\ning team of four ran 6 campaigns. Results: 5.2% conversion vs. 1.8% baseline - a 2.9x lift.`;
  const KERNED = 'Cam paign delivered 4,200 leads';

  it.each([
    ['"5.2 percent conversion vs 1.8 percent baseline" for "5.2% conversion vs. 1.8% baseline"', 'Cites "5.2 percent conversion vs 1.8 percent baseline"'],
    ['"5.2 per cent conversion" for "5.2%"', 'Cites "5.2 per cent conversion vs 1.8 per cent baseline"'],
    ['"5.2 % conversion" with a space before the sign', 'Cites "5.2 % conversion vs 1.8 % baseline"'],
    [`"a 2.9${MULTIPLY} lift" for "2.9x"`, `Cites "a 2.9${MULTIPLY} lift"`],
    ['"a 2.9 x lift" with a space', 'Cites "a 2.9 x lift"'],
    ['"reach from 12K to 340K" for "12,000 to 340,000"', 'Cites "LinkedIn reach from 12K to 340K in six months"'],
    ['"12 thousand to 340 thousand"', 'Cites "LinkedIn reach from 12 thousand to 340 thousand in six months"'],
  ])('%s: still a verbatim quote, the strong verdict stands with no note', (_name, evidence) => {
    const r = enforceEvidenceRules([read(evidence)], ctxOf(TEXT));
    expect(r.criteria[0].verdict).toBe('strong');
    expect(r.notes).toEqual([]);
  });

  it('words an extractor split ("Cam paign") are matched when the model quotes them whole, and the other way round', () => {
    expect(kindOf('Says "Campaign delivered 4,200 leads"', KERNED)).toBe('exact');
    expect(kindOf('Says "Cam paign delivered 4,200 leads"', 'Campaign delivered 4,200 leads')).toBe('exact');
  });

  it('a fabricated sentence still fails, whatever it shares with the text', () => {
    for (const fake of [
      'grew reach from 100K to 9 million in one month',                   // the reviewers\' own fabrication
      'grew LinkedIn reach from 12,000 to 940,000 in six months',         // all but one figure is real: the figure is what changed
      'a 2.9x lift in revenue and a 40 percent cut in costs',
      'we won the national award for the market ing team of four',
    ]) {
      const r = enforceEvidenceRules([read(`Cites "${fake}"`)], ctxOf(TEXT));
      expect(r.criteria[0].verdict, fake).toBe('not_evidenced');
      expect(r.notes[0], fake).toMatch(/quoted text not found in L1; the quote is invented/);
    }
  });

  it('the 3-word minimum stands: a 2-word quote is not a quote at all', () => {
    expect(enforceEvidenceRules([read('Cites "nine million"', 'partial')], ctxOf(TEXT)).criteria[0].verdict).toBe('partial');
    expect(enforceEvidenceRules([read('Cites "nine million reach"', 'strong')], ctxOf(TEXT)).criteria[0].verdict).toBe('not_evidenced');
  });
});

// ─── What a near match is ────────────────────────────────────────────────────
describe('a near match: 70% of the words in order, close together, every figure / negation / name present', () => {
  const TEXT = 'The retail pilot across 140 stores lifted repeat purchase by 27 percent in the first quarter of the year.';

  it('one changed word of eleven is a near match: the strong verdict is held at partial, with a note that says so', () => {
    const r = enforceEvidenceRules([read('Says "retail pilot across 140 stores boosted repeat purchase by 27 percent"')], ctxOf(TEXT));
    expect(r.criteria[0].verdict).toBe('partial');
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^mh3: the quote is a near match of the text in L1 \(\d+% of its words in order; every number, name and negation in it is there\), not verbatim; strong lowered to partial$/);
  });

  it('a partial or a concern is KEPT (a note is made): a near match never raises a verdict', () => {
    for (const verdict of ['partial', 'concern'] as const) {
      const r = enforceEvidenceRules([read('Says "retail pilot across 140 stores boosted repeat purchase by 27 percent"', verdict)], ctxOf(TEXT));
      expect(r.criteria[0].verdict, verdict).toBe(verdict);
      expect(r.notes[0], verdict).toMatch(new RegExp(`near match.*; ${verdict} kept$`));
    }
  });

  it('the share it reports is the worst part of a quote that uses an ellipsis', () => {
    const r = enforceEvidenceRules([read('Says "retail pilot across 140 stores ... boosted repeat purchase by 27 percent in the first quarter"')], ctxOf(TEXT));
    expect(r.criteria[0].verdict).toBe('partial');
    expect(r.notes[0]).toMatch(/near match/);
  });

  it('a part that is exact and a part that is invented is invented', () => {
    const r = enforceEvidenceRules([read('Says "retail pilot across 140 stores ... doubled our market share overnight"')], ctxOf(TEXT));
    expect(r.criteria[0].verdict).toBe('not_evidenced');
  });

  it('short quotes are strict: with 3 words every one has to be there, with 4 or 5 words one may differ (but never a figure)', () => {
    const text = 'We opened 40 outlets in Pune last year.';
    expect(kindOf('"opened 40 outlets"', text)).toBe('exact');
    expect(kindOf('"launched 40 outlets"', text)).toBe('absent');          // 2 of 3
    expect(kindOf('"opened 40 shops in Pune"', text)).toBe('near');         // 4 of 5
    expect(kindOf('"opened 50 outlets in Pune"', text)).toBe('absent');     // 4 of 5 words, but the figure changed
  });

  it('a changed figure is absent, in digits or in words', () => {
    expect(kindOf('"retail pilot across 400 stores lifted repeat purchase by 27 percent"', TEXT)).toBe('absent');
    expect(kindOf('"retail pilot across 140 stores lifted repeat purchase by 72 percent"', TEXT)).toBe('absent');
    const words = 'The hero film was shot in two days with a team of five.';
    expect(kindOf('"hero film was shot in two days with a team of five"', words)).toBe('exact');
    expect(kindOf('"hero film was shot in three days with a team of five"', words)).toBe('absent');
    expect(kindOf('"hero film was shot in just two days by a team of five"', words)).toBe('near');
  });

  it('an added negation is absent: a flipped claim is not a paraphrase', () => {
    const words = 'The hero film was shot in two days with a team of five.';
    expect(kindOf('"hero film was not shot in two days with a team of five"', words)).toBe('absent');
    expect(kindOf('"hero film was never shot in two days with a team of five"', words)).toBe('absent');
    expect(kindOf('"hero film was shot in two days without a team of five"', words)).toBe('absent');
  });

  it('a changed name is absent: a different person credited is not a paraphrase', () => {
    const credit = 'Art direction by Meera Iyer, copy by the Brightloom writers room.';
    expect(kindOf('"Art direction by Meera Iyer, copy by the Brightloom writers room"', credit)).toBe('exact');
    expect(kindOf('"Art direction by Rohan Mehta, copy by the Brightloom writers room"', credit)).toBe('absent');
    expect(kindOf('"Art direction by Meera Iyer, copy by the Brightloom writing team"', credit)).toBe('near');
    // a sentence that merely starts with a capital is not a name
    expect(kindOf('"Our copywriters rewrote the email launch sequence"', 'The copywriters rewrote the launch email sequence.')).toBe('near');
  });

  it('a quote with no lower-case letter says nothing by its capitals (ALL CAPS); a Title Case heading names every word it capitalises', () => {
    const text = 'every drop counts when a river runs dry in june';
    expect(kindOf('"EVERY DROP COUNTS WHEN A RIVER RUNS DRY TODAY"', text)).toBe('near');
    // the cautious side: a paraphrased Title Case heading is "absent", not "near" (its capitalised words must all be in the text)
    expect(kindOf('"Every Drop Counts When A River Runs Dry Today"', text)).toBe('absent');
    expect(kindOf('"Every Drop Counts When A River Runs Dry In June"', text)).toBe('exact');
  });

  it('a quote of mostly names keeps them all (the first version dropped the name rule for a quote that was mostly capitals)', () => {
    const text = 'Design lead: Kabir Rao. Strategy: Nandini Shah.';
    expect(kindOf('"Design lead: Kabir Rao. Strategy: Nandini Shah."', text)).toBe('exact');
    expect(kindOf('"Design lead: Kabir Rao. Strategy: Anita Shah."', text)).toBe('absent');
    expect(kindOf('"Design lead: Kabir Rao. Strategy: Nandini Shah and team"', text)).toBe('near');
  });

  it('words stitched from two places far apart in the text do not make a quote', () => {
    const text = `Project Neer launched in 2024. ${'Filler about brand tone and style across many channels. '.repeat(8)} The hero film was shot in two days.`;
    expect(kindOf('"Project Neer launched in 2024 and the hero film was shot in two days"', text)).toBe('absent');
  });

  it('words in the wrong order are not a match', () => {
    expect(kindOf('"stores 140 across pilot retail the lifted"', TEXT)).toBe('absent');
  });

  it('is searched in the candidate\'s own answer too when that is cited', () => {
    const r = enforceEvidenceRules([{ ...read('Says "ran the retail pilot across 140 stores and lifted repeat purchase"'), source: 'L1, answer' }],
      ctxOf('unrelated words about a different thing entirely', 'I ran the retail pilot across 140 stores and lifted repeat purchase by a lot'));
    // found verbatim in the answer; with an artifact cited next to it the verdict is the artifact's to carry (the answer alone would be a claim)
    expect(r.criteria[0].verdict).toBe('strong');
    expect(r.notes).toEqual([]);
    const near = enforceEvidenceRules([{ ...read('Says "ran the retail pilot across 140 stores and boosted repeat purchase"'), source: 'L1, answer' }],
      ctxOf('unrelated words about a different thing entirely', 'I ran the retail pilot across 140 stores and lifted repeat purchase by a lot'));
    expect(near.criteria[0].verdict).toBe('partial');
    expect(near.notes[0]).toMatch(/near match of the text in L1, answer/);
  });

  it('does not apply to a native document whose text is cut: the quote check is skipped there as before', () => {
    const c = read('Page 18 says "campaign delivered four thousand qualified leads in Q3"');
    const r = enforceEvidenceRules([c], { acquired: [{ ref: 'L1', basis: 'artifact', outcome: 'ok', text: 'filler '.repeat(50), link: { platform: 'pdf_file' }, nativeDocument: true, textTruncated: true }], claimText: '' });
    expect(r.criteria[0].verdict).toBe('strong');
    expect(r.notes).toEqual([]);
  });
});

// ─── HELD-OUT corpus ─────────────────────────────────────────────────────────
// Written AFTER the matcher and not tuned on: fresh texts (a D2C agency review, a brand-story deck, a Hindi page) and fresh wording, none
// of it taken from the reviewers' reproductions or from the tests above. Each row is one quote against one text with the outcome a reader
// would expect: exact (a strong verdict stands), near (held at partial) or absent (a fabrication: not_evidenced).
describe('HELD-OUT corpus', () => {
  const A = [
    '[page 1]',
    'Brightloom Studios: Annual Creative Review 2025',
    'Project Neer is a refillable-bottle launch for AquaPure, delivered in 11 weeks on a ₹18 lakh budget.',
    'Instagram Reels reach hit 2.4M in the first month, 3.1x the previous quarter.',
    '[page 2]',
    'The retail pilot across 140 stores lifted repeat purchase by 27% (n=1,850 households).',
    'Our copywriters rewrote the launch email sequence and open rate rose from 21% to 38 per cent.',
    'The hero film was shot in two days with a team of five.',
    '[page 3]',
    'The campaign "Har Boond Ka Hisaab" ran on radio, hoardings and WhatsApp status.',
    'Cost per lead fell from Rs. 640 to Rs. 410 over eight months.',
    "Art direction by Meera Iyer, copy by the Brightloom writers' room.",
  ].join('\n');
  const B = [
    '[slide 1]',
    'Saffron & Salt - brand story deck',
    'Design lead: Kabir Rao. Strategy: Nandini Shah.',
    '[slide 2]',
    'Our identity system covers pack-',
    'aging, menus and a Hindi-English wordmark; it replaced a 2019 logo.',
    'Zomato and Swiggy listings drove 62% of first orders in the Pune pilot.',
    '[slide 3]',
    'Pro duct photography was shot in-house, cutting agency spend by ₹9,50,000 a year.',
    'The relaunch reel crossed 1.2 million views and 48K saves.',
  ].join('\n');
  const H = 'नीर अभियान: 2024 में 8 शहरों में शुरू हुआ।\nइंस्टाग्राम पर पहुँच बढ़ी और टीम में पाँच लोग थे।';

  const rows: Array<[string, string, string, Kind]> = [
    // ── exact: the same words, written differently
    ['A', 'Reels reach hit 2.4 million in the first month', A, 'exact'],
    ['A', `3.1 ${MULTIPLY} the previous quarter`, A, 'exact'],
    ['A', 'open rate rose from 21 percent to 38 percent', A, 'exact'],
    ['A', 'on a Rs. 18 lakh budget', A, 'exact'],
    ['A', 'Cost per lead fell from ₹640 to ₹410 over eight months', A, 'exact'],
    ['A', 'retail pilot across 140 stores lifted repeat purchase by 27 per cent', A, 'exact'],
    ['A', 'n = 1850 households', A, 'exact'],
    ['A', "Art direction by Meera Iyer, copy by the Brightloom writers' room", A, 'exact'],
    ['A', 'a refillable bottle launch for AquaPure', A, 'exact'],
    ['A', 'delivered in 11 weeks on a 18 lakh budget', A, 'exact'],
    ['B', 'identity system covers packaging, menus and a Hindi-English wordmark', B, 'exact'],
    ['B', 'Zomato and Swiggy listings drove 62 percent of first orders', B, 'exact'],
    ['B', 'Product photography was shot in-house', B, 'exact'],
    ['B', 'cutting agency spend by Rs 9.5 lakh a year', B, 'exact'],
    ['B', 'crossed 1.2M views and 48 thousand saves', B, 'exact'],
    ['B', 'Design lead: Kabir Rao', B, 'exact'],
    ['H', '8 शहरों में शुरू हुआ', H, 'exact'],
    ['A', 'Project Neer ... delivered in 11 weeks', A, 'exact'],
    // ── near: a little paraphrased, nothing that changes a figure, a name or a claim
    ['A', 'retail pilot across 140 stores boosted repeat purchase by 27%', A, 'near'],
    ['A', 'the hero film was shot in just two days by a team of five', A, 'near'],
    ['A', 'open rate went from 21% to 38%', A, 'near'],
    ['A', 'cost per lead dropped from Rs 640 to Rs 410 across eight months', A, 'near'],
    ['A', 'the copywriters rewrote the email launch sequence', A, 'near'],
    ['A', 'Project Neer launched a refillable bottle for AquaPure in 11 weeks', A, 'near'],
    ['B', 'identity system covers packaging, menus and a bilingual Hindi-English wordmark', B, 'near'],
    ['B', 'Zomato and Swiggy listings drove nearly 62% of first orders in the Pune pilot', B, 'near'],
    ['B', 'relaunch reel crossed 1.2 million views and 48K saves in a week', B, 'near'],
    ['H', 'नीर अभियान 2024 में 8 शहरों में लॉन्च हुआ', H, 'near'],
    // ── absent: fabrications, however much of the real wording they borrow
    ['A', 'Reels reach hit 24 million in the first month', A, 'absent'],
    ['A', 'retail pilot across 400 stores lifted repeat purchase by 27%', A, 'absent'],
    ['A', 'Cost per lead fell from Rs. 640 to Rs. 210 over eight months', A, 'absent'],
    ['A', 'The campaign won a Cannes Lion for craft', A, 'absent'],
    ["A", "Project Neer doubled AquaPure's market share in a single quarter", A, 'absent'],
    ['A', 'stores 140 across pilot retail the', A, 'absent'],
    ['A', 'The hero film was shot in three days with a team of five', A, 'absent'],
    ['A', 'The hero film was not shot in two days with a team of five', A, 'absent'],
    ['A', "Art direction by Rohan Mehta, copy by the Brightloom writers' room", A, 'absent'],
    ['A', 'Retail pilot across 140 stores and the hero film was shot in two days', A, 'absent'],
    ['A', 'Our copywriters rewrote the pitch deck for Tata', A, 'absent'],
    // two phrases that are NOT next to each other in the text (first run: labelled "exact" by mistake, and the matcher said near)
    ['A', 'across 1850 households', A, 'absent'],
    ['A', 'Brightloom Studios won the Effie award for the Project Neer launch', A, 'absent'],
    ['B', 'Design lead: Kabir Rao. Strategy: Anita Shah.', B, 'absent'],
    ['B', 'Zomato and Swiggy listings drove 26% of first orders in the Pune pilot', B, 'absent'],
    ['B', 'The relaunch reel crossed 12 million views', B, 'absent'],
    ['B', 'it replaced a 2021 logo', B, 'absent'],
    ['B', 'Our identity system never covers packaging', B, 'absent'],
    ['B', 'Customer research with 400 shoppers shaped the tagline', B, 'absent'],
    ['H', '9 शहरों में शुरू हुआ', H, 'absent'],
    ['A', 'Project Neer ... delivered in 12 weeks', A, 'absent'],
  ];

  it.each(rows.map(([t, q, text, want], i) => [`#${i + 1} [${t}] ${want}: ${q}`, q, text, want] as const))('%s', (_name, quote, text, want) => {
    expect(kindOf(`Says "${quote}"`, text)).toBe(want);
  });

  it('summary: every fabrication is rejected, every exact quote is kept as it is, every paraphrase is held at partial', () => {
    const got = rows.map(([, q, text, want]) => [want, kindOf(`Says "${q}"`, text)] as const);
    const count = (want: Kind) => got.filter(([w]) => w === want).length;
    const ok = (want: Kind) => got.filter(([w, k]) => w === want && k === want).length;
    expect({ exact: [ok('exact'), count('exact')], near: [ok('near'), count('near')], absent: [ok('absent'), count('absent')] })
      .toEqual({ exact: [count('exact'), count('exact')], near: [count('near'), count('near')], absent: [count('absent'), count('absent')] });
    expect(rows.length).toBeGreaterThanOrEqual(48);
  });

  it('a fabrication that borrows words is never raised to strong, whichever verdict it claims', () => {
    for (const [, q, text, want] of rows.filter(r => r[3] === 'absent')) {
      for (const verdict of ['strong', 'partial', 'concern'] as const) {
        expect(enforceEvidenceRules([read(`Says "${q}"`, verdict)], ctxOf(text)).criteria[0].verdict, `${verdict}: ${q}`).toBe('not_evidenced');
      }
      expect(want).toBe('absent');
    }
  });
});

// ─── HELD-OUT corpus, round 2 ────────────────────────────────────────────────
// The first round found two defects (a name guard switched off for a quote of mostly names; a window loose enough to stitch a short quote
// together from phrases 12 words apart). They were fixed, which made that round a training set. This is a second round: a new text, new
// wording, written before the matcher was run on it. Its outcome is what the report quotes.
describe('HELD-OUT corpus, round 2 (written after the round-1 fixes, not tuned on)', () => {
  const C = [
    'Case study: Rebuilding the Kaveri Dairy brand',
    'When I joined Kaveri Dairy in 2022 the brand had no voice. We spent six weeks on research with 300 customers.',
    'The new tagline, "Fresh from the farm, every morning", appeared on 2,000 delivery vans.',
    'Subscriptions grew from 9,000 to 41,000 households in fourteen months.',
    'Our Diwali film earned 3.6 million views at a media cost of ₹7.5 lakh.',
    'I managed a team of four: a designer, two writers and a video editor.',
    'The campaign was run by the in-house team without an agency.',
  ].join('\n');

  const rows: Array<[string, Kind]> = [
    // exact
    ['the brand had no voice', 'exact'],
    ['We spent six weeks on research with 300 customers', 'exact'],
    ['The new tagline Fresh from the farm every morning appeared on 2,000 delivery vans', 'exact'],
    ['Subscriptions grew from 9K to 41K households in fourteen months', 'exact'],
    ['Our Diwali film earned 3.6M views at a media cost of Rs 7.5 lakh', 'exact'],
    ['I managed a team of four, a designer, two writers and a video editor', 'exact'],
    ['The campaign was run by the in house team without an agency', 'exact'],
    ['2000 delivery vans', 'exact'],
    // near
    ['The new tagline appeared on around 2,000 delivery vans', 'near'],
    ['Subscriptions rose from 9,000 to 41,000 households within fourteen months', 'near'],
    ['Our Diwali film got 3.6 million views at a media cost of 7.5 lakh rupees', 'near'],
    ['I managed a team of four people: a designer, two writers and a video editor', 'near'],
    // absent
    ['Subscriptions grew from 9,000 to 14,000 households in fourteen months', 'absent'],
    ['We spent six weeks on research with 3,000 customers', 'absent'],
    ['Our Diwali film earned 36 million views', 'absent'],
    ['I managed a team of nine', 'absent'],
    ['The campaign was run by Dentsu without an agency', 'absent'],
    ['The brand had won the Best Dairy Brand award', 'absent'],
    ['When I joined Kaveri Dairy in 2019 the brand had no voice', 'absent'],
    ['When I joined Kaveri Dairy in 2022 the brand never had a voice', 'absent'],
  ];

  it.each(rows.map(([q, want], i) => [`#${i + 1} ${want}: ${q}`, q, want] as const))('%s', (_name, quote, want) => {
    expect(kindOf(`Says "${quote}"`, C)).toBe(want);
  });

  // FIRST RUN: 20 of 21 correct. The miss, "We spent six weeks on research with 300 customers and rebuilt the logo overnight" (a real
  // 9-word sentence with an invented 5-word tail: 10 of its 14 words are in the text), was labelled "absent" and the matcher said near. It
  // is kept below as a known limit instead of being tuned away: the bar is the decided 70%, and a near match can only ever be a partial.
  it('summary: every row of the round is classified as expected', () => {
    const wrong = rows.filter(([q, want]) => kindOf(`Says "${q}"`, C) !== want);
    expect(wrong).toEqual([]);
    expect(rows).toHaveLength(20);
  });

  // Known limits, stated rather than hidden. Neither can be told from an honest paraphrase by counting words.
  it('known limit: ONE changed content word in a long quote is a near match (held at partial), not a fabrication', () => {
    expect(kindOf('"Fresh from the farm every evening appeared on 2,000 delivery vans"', C)).toBe('near');
  });

  it('known limit: a real sentence with an invented tail of under 30% of its words is a near match (held at partial)', () => {
    expect(kindOf('"We spent six weeks on research with 300 customers and rebuilt the logo overnight"', C)).toBe('near');
    // the same tail on a shorter quote is a bigger share of it, and is absent
    expect(kindOf('"We spent six weeks on research and rebuilt the logo overnight"', C)).toBe('absent');
  });

  it('known limit, the cautious side: "no" for "without" (the same claim) is refused, because a negation must be in the text', () => {
    expect(kindOf('"The campaign was run in-house with no agency"', C)).toBe('absent');
  });
});

// ─── G12 (third review): "six weeks" for "6 weeks" is the same words ─────────────────────────────────────────
// foldNumbers folded %, x, K/M/lakh/crore and currency, but a number WORD in the quote had to appear as that word in the text, so an honest
// digit <-> word swap zeroed a good verdict exactly like a fabricated sentence. Number words are now figures on BOTH sides (zero to ninety-nine,
// "a dozen", "two hundred", "a thousand"); the figure itself is kept, so a changed figure is as absent as ever.
describe('G12 — number words and digits are one figure, a changed figure is still absent', () => {
  const TEXT_A = [
    'Jal Mitra campaign, 2023',
    'Objective: make wastewater reuse a household topic in 14 cities.',
    'Results: 2.4M views, 38% uplift in enquiries versus the previous quarter. Reached 14 cities in 6 weeks.',
    'Budget: Rs 18 lakh. Team of 4 (1 designer, 2 writers, 1 editor).',
    '-- 2 of 9 --',
    'We ran a 3-year campaign for a utility; CTR was 4.2x the category benchmark.',
    'Brand guidelines were rolled out to 5 agencies and 2 regional teams in Mumbai and Delhi.',
  ].join('\n');

  it.each([
    // the reviewer's five rows (all were "invented")
    ['reached 14 cities in six weeks', 'exact'],
    ['Reached fourteen cities in 6 weeks', 'exact'],
    ['we ran a three-year campaign for a utility', 'exact'],
    ['Team of four: one designer, two writers and one editor', 'near'],                              // the extra "and" is a paraphrase, not a change
    ['brand guidelines rolled out to five agencies and two regional teams', 'near'],                 // "were" dropped
    // the same, the other way round and with other figures
    ['Reached 14 cities in 6 weeks', 'exact'],
    ['Team of 4 (one designer, 2 writers, 1 editor)', 'exact'],
    ['rolled out to five agencies and 2 regional teams in Mumbai and Delhi', 'exact'],
    // a figure that CHANGED stays absent, in words as in digits
    ['Reached forty cities in 6 weeks', 'absent'],
    ['reached 14 cities in seven weeks', 'absent'],
    ['Reached 14 cities in sixteen weeks', 'absent'],
    ['we ran a five-year campaign for a utility', 'absent'],
    ['Team of four: two designers, two writers and one editor', 'near'],                              // known limit: composition is not compared (see below)
    ['rolled out to nine agencies and two regional teams in Mumbai and Delhi', 'absent'],
    ['the campaign saved five crore litres of water', 'absent'],
  ] as Array<[string, Kind]>)('%s -> %s', (quote, want) => {
    expect(kindOf(`Shows "${quote}"`, TEXT_A)).toBe(want);
  });

  describe('what is folded, and what is not', () => {
    const cases: Array<[string, string, string, Kind]> = [
      // [what it shows, quote, text, expected]
      ['zero to nineteen', 'we ran zero paid campaigns and nineteen organic ones', 'We ran 0 paid campaigns and 19 organic ones', 'exact'],
      ['tens', 'ninety creators, sixty editors and forty writers', '90 creators, 60 editors and 40 writers', 'exact'],
      ['tens and units, hyphen or space, any case', 'the team ran Twenty-Five campaigns and thirty one reels', 'The team ran 25 campaigns and 31 reels', 'exact'],
      ['a hundred, two hundred, twelve hundred', 'a hundred stalls, two hundred volunteers and twelve hundred guests', '100 stalls, 200 volunteers and 1200 guests', 'exact'],
      ['a dozen, two dozen', 'a dozen films and two dozen posters', '12 films and 24 posters', 'exact'],
      ['a thousand, a million, a lakh, two crore', 'a thousand leads, a million views, a lakh sign-ups and two crore reach', '1,000 leads, 1M views, 1,00,000 sign-ups and 2 crore reach', 'exact'],
      ['a figure that merely sits next to a word', 'the one-off event drew two thousand guests', 'The 1-off event drew 2,000 guests', 'exact'],
      ['the word "one" as a pronoun is read the same on both sides', 'one of our best campaigns ran in two cities', 'One of our best campaigns ran in two cities', 'exact'],
      ['"twenty, five" is two numbers, not twenty-five', 'the team ran twenty, five campaigns in total', 'The team ran 25 campaigns in total', 'absent'],
      ['25 is not 52', 'the team ran twenty-five campaigns in total', 'The team ran 52 campaigns in total', 'absent'],
      ['twenty is not twelve', 'the team ran twenty campaigns in total', 'The team ran 12 campaigns in total', 'absent'],
      ['"a thousand" is not "a hundred"', 'a thousand people joined the shoot', 'A hundred people joined the shoot', 'absent'],
      ['a magnitude word with no figure ("several thousand") stays a figure of its own', 'several hundred views in the first month', 'several thousand views in the first month', 'absent'],
      ['"a few thousand" is not 1,000', 'a few thousand views in the first month', '1,000 views in the first month', 'absent'],
      ['"none" is not read as "one"', 'none of the posts was paid for by us', '1 of the posts was paid for by us', 'absent'],
      ['an ordinal is not a cardinal: "tenth" stays a word', 'someone wrote the tenth post for the launch', 'someone wrote the tenth post for the launch', 'exact'],
      ['a number inside a longer word is left alone ("phone", "someone", "stone")', 'someone left a phone beside the stone wall', 'someone left a phone beside the stone wall', 'exact'],
      ['"no one" keeps its negation', 'no one wrote the tagline except the team', 'one wrote the tagline except the team', 'absent'],
      ['"no one" folds like the text does', 'no one wrote the tagline except the team', 'no 1 wrote the tagline except the team', 'exact'],
    ];
    it.each(cases)('%s', (_name, quote, text, want) => {
      expect(kindOf(`Says "${quote}"`, text)).toBe(want);
    });
  });

  it('the negation guards and the capitalised-name guard stand next to the folding', () => {
    const text = 'The hero film was shot in two days by Meera Iyer with a team of five.';
    expect(kindOf('"hero film was shot in 2 days by Meera Iyer with a team of 5"', text)).toBe('exact');
    expect(kindOf('"hero film was not shot in two days by Meera Iyer with a team of five"', text)).toBe('absent');
    expect(kindOf('"hero film was shot in two days by Rohan Mehta with a team of five"', text)).toBe('absent');
    expect(kindOf('"hero film was shot in three days by Meera Iyer with a team of five"', text)).toBe('absent');
    expect(kindOf('"hero film was shot in just two days by Meera Iyer with a team of 5"', text)).toBe('near');
  });

  it('a number word and a digit are one figure in a near match too, and still have to be there', () => {
    const text = 'Our retail pilot reached 140 stores in the first quarter and lifted repeat purchase by 27 percent.';
    expect(kindOf('"retail pilot reached one hundred forty stores"', text)).toBe('absent');                    // "one hundred forty" is not folded as a whole: see the limits
    expect(kindOf('"retail pilot reached 140 stores and boosted repeat purchase by twenty-seven percent"', text)).toBe('near');
    expect(kindOf('"retail pilot reached 140 stores and boosted repeat purchase by twenty-eight percent"', text)).toBe('absent');
  });
});

// ─── HELD-OUT corpus, round 3 (G12) ──────────────────────────────────────────
// Written BEFORE the fix with two texts and wording that appear in no earlier corpus (the reviewers' sets, rounds 1-2 above, the round-3 sets);
// row 40 was added after the first measurement of the other 39. FIRST MEASUREMENT of the 39 rows: before the fix 21 right of 39 with 16 honest
// quotes zeroed ("invented") and 2 fabrications accepted; after it 35 of 39, with 2 honest quotes zeroed and the same 2 fabrications accepted.
// The four rows that are still wrong are kept below as known limits instead of being tuned away. All 40 are regression rows now.
describe('HELD-OUT corpus, round 3 (written before the number-word fix, not tuned on)', () => {
  const D = [
    '[page 1]',
    'Case study: Launching Nutri Nook, a millet snack brand (2024)',
    'We started with a team of three founders and a budget of Rs 12 lakh.',
    'In the first ninety days we shipped 14 flavours to 22 pincodes.',
    'Our launch reel collected 1.9 million views and 6,300 pre-orders.',
    '[page 2]',
    'The packaging was designed in-house over twelve weeks, with 5 rounds of feedback from 200 parents.',
    'Referral codes drove 35% of week-one sales; a dozen micro-influencers posted unpaid.',
    'We wrote 40 product pages, 8 newsletters and a 3-part email welcome series.',
    'Retention at day 60 was 41 per cent, double the category average.',
    '[page 3]',
    'Creative direction: Farah Siddiqui. Photography: Ishaan Verma.',
    'We never ran paid ads in the first quarter.',
    'Our tagline "Small grain, big morning" appeared on 1,500 shelf strips.',
    'The founder\'s note went to a hundred and fifty early customers by hand.',
  ].join('\n');
  const E = [
    '[slide 1]',
    'Clean Lakes Alliance: Annual impact deck 2025',
    'Volunteers planted 8,000 saplings along 12 lakes in nine months.',
    'Our short film reached 450 thousand viewers, 2x our target.',
    '[slide 2]',
    'Budget: ₹35 lakh across three phases; each phase lasted four months.',
    'The social team of six answered 1,200 comments in Hindi and English.',
    'Press coverage appeared in 17 outlets, including The Hindu and Mint.',
    '[slide 3]',
    'Led by Anjali Rao, with design by the Studio Tilt collective.',
    'Zero paid media was used; every share was organic.',
    'Survey of 650 residents: 72 percent said they would join again.',
    'It was the fifth campaign the team ran in two years.',
  ].join('\n');
  const T: Record<string, string> = { D, E };

  const rows: Array<[string, string, Kind]> = [
    // exact: the same words, a digit written as a word or the other way round
    ['D', 'In the first 90 days we shipped 14 flavours to 22 pincodes', 'exact'],
    ['D', 'a team of 3 founders and a budget of Rs 12 lakh', 'exact'],
    ['D', 'packaging was designed in-house over 12 weeks', 'exact'],
    ['D', 'with five rounds of feedback from two hundred parents', 'exact'],
    ['D', 'Referral codes drove thirty-five percent of week-one sales', 'exact'],
    ['D', 'a dozen micro-influencers posted unpaid', 'exact'],
    ['D', '12 micro-influencers posted unpaid', 'exact'],
    ['D', 'We wrote forty product pages, eight newsletters and a three-part email welcome series', 'exact'],
    ['D', 'Retention at day sixty was forty-one per cent', 'exact'],
    ['D', 'Our launch reel collected 1.9M views and 6300 pre-orders', 'exact'],
    ['D', 'Creative direction: Farah Siddiqui, photography: Ishaan Verma', 'exact'],
    ['D', 'We never ran paid ads in the first quarter', 'exact'],
    ['D', 'Small grain, big morning appeared on 1500 shelf strips', 'exact'],
    ['E', 'planted eight thousand saplings along twelve lakes in nine months', 'exact'],
    ['E', 'Budget: Rs 35 lakh across 3 phases; each phase lasted 4 months', 'exact'],
    ['E', 'The social team of 6 answered 1200 comments in Hindi and English', 'exact'],
    ['E', 'Press coverage appeared in seventeen outlets, including The Hindu and Mint', 'exact'],
    ['E', 'Led by Anjali Rao, with design by the Studio Tilt collective', 'exact'],
    ['E', 'Survey of 650 residents: seventy-two percent said they would join again', 'exact'],
    // near: a little paraphrased, nothing that changes a figure, a name or a claim
    ['E', 'Our short film reached 450,000 viewers, twice our target', 'near'],
    ['E', 'It was the 5th campaign the team ran in two years', 'near'],
    ['D', 'The packaging was designed in-house over twelve weeks, with 5 rounds of input from 200 parents', 'near'],
    ['D', 'Referral codes brought in 35% of week-one sales', 'near'],
    ['E', 'Volunteers planted 8,000 saplings around 12 lakes in nine months', 'near'],
    ['E', 'The social team of six replied to 1,200 comments in Hindi and English', 'near'],
    ['D', 'We wrote forty product pages, 8 newsletters and a 3-part welcome email series', 'near'],
    ['E', 'Zero paid media was used; every share was organic and unpaid', 'near'],
    // absent: a changed figure (digit or word), a changed name, a fabrication
    ['D', 'In the first ninety days we shipped 40 flavours to 22 pincodes', 'absent'],
    ['D', 'a team of five founders and a budget of Rs 12 lakh', 'absent'],
    ['D', 'Our launch reel collected 1.9 million views and 3,600 pre-orders', 'absent'],
    ['D', 'Retention at day sixty was fourteen per cent', 'absent'],
    ['D', 'Creative direction: Farah Siddiqui. Photography: Rohan Kapoor.', 'absent'],
    ['E', 'Volunteers planted 80,000 saplings along 12 lakes in nine months', 'absent'],
    ['E', 'Press coverage appeared in 17 outlets, including The Times of India and Mint', 'absent'],
    ['E', 'The campaign won the best D2C launch award at Goafest', 'absent'],
    ['E', 'It was the fifth campaign the team ran in seven years', 'absent'],   // row 40, added after the first measurement
  ];

  it.each(rows.map(([t, q, want], i) => [`#${i + 1} [${t}] ${want}: ${q}`, q, t, want] as const))('%s', (_name, quote, t, want) => {
    expect(kindOf(`Says "${quote}"`, T[t])).toBe(want);
  });

  it('summary: every exact quote is kept as it is, every paraphrase held at partial, every fabrication rejected (36 rows; the 4 known limits are below)', () => {
    const wrong = rows.filter(([t, q, want]) => kindOf(`Says "${q}"`, T[t]) !== want);
    expect(wrong).toEqual([]);
    expect(rows).toHaveLength(36);
  });

  // The four rows the matcher still gets wrong, stated rather than hidden. Two are honest quotes that are zeroed, two are changes that are held at partial.
  describe('known limits (documented, not tuned away)', () => {
    it('an honest number spoken in several scales is zeroed: "a hundred and fifty" for 150, "six thousand three hundred" for 6,300', () => {
      expect(kindOf('Says "The founder\'s note went to 150 early customers by hand"', D)).toBe('absent');
      expect(kindOf('Says "Our launch reel collected 1.9 million views and six thousand three hundred pre-orders"', D)).toBe('absent');
      // one scale at a time is folded: "two hundred", "twelve hundred", "six thousand" are exact
      expect(kindOf('Says "a launch reel that collected six thousand pre-orders"', 'a launch reel that collected 6,000 pre-orders')).toBe('exact');
    });

    it('a flipped claim made by REPLACING its negation is held at partial, not rejected (the guard checks that the quote\'s negations are in the text, not the reverse)', () => {
      expect(kindOf('Says "We always ran paid ads in the first quarter"', D)).toBe('near');
      expect(kindOf('Says "We never ran paid ads in the first quarter"', D)).toBe('exact');
    });

    it('a changed figure that also stands elsewhere in the same stretch of text is held at partial (figures are checked as a set, not by place)', () => {
      expect(kindOf('Says "Budget: Rs 35 lakh across four phases; each phase lasted four months"', E)).toBe('near');
      expect(kindOf('Says "Budget: Rs 35 lakh across five phases; each phase lasted four months"', E)).toBe('absent');
    });

    it('and none of the three can ever stand at strong: the worst they get is partial', () => {
      for (const q of ['We always ran paid ads in the first quarter', 'Budget: Rs 35 lakh across four phases; each phase lasted four months']) {
        const text = q.startsWith('We') ? D : E;
        expect(enforceEvidenceRules([read(`Says "${q}"`, 'strong')], ctxOf(text)).criteria[0].verdict).toBe('partial');
      }
    });
  });
});

// ─── Hostile text ────────────────────────────────────────────────────────────
describe('the matcher stays fast on hostile text', () => {
  const timed = (text: string, quote: string): number => {
    const t0 = performance.now();
    enforceEvidenceRules([read(`Says "${quote}"`)], ctxOf(text));
    return performance.now() - t0;
  };
  const words = 'the campaign grew reach and launched new brand work for water clean river'.split(' ');
  const rep = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join(' ');

  it.each([
    ['400,000 characters of common words, a 40-word quote', rep(60000, i => words[i % words.length]), rep(40, i => words[(i * 7) % words.length])],
    ['a run of 400,000 digits', '1'.repeat(400000), 'grew reach from 1111 to 222222 in months'],
    ['200,000 "1." pairs', '1.'.repeat(200000), 'grew reach from 12 k to 340 k in six months'],
    ['130,000 "9k" tokens', '9k '.repeat(130000), 'grew reach 9k 9k 9k 9k 9k 9k'],
    ['200,000 one-letter words, a 40-word quote of the same letter', rep(200000, () => 'a'), rep(40, () => 'a')],
    ['one 400,000-letter word against a long run-together quote', 'a'.repeat(400000), `${'a'.repeat(200)} b c`],
    ['100,000 "5 x "', '5 x '.repeat(100000), 'grew 5 x 5 x 5 x reach 5 x 5 x'],
    ['400,000 percent signs', '%'.repeat(400000), 'grew reach to 5% in months'],
    ['100,000 "one" words and a quote of number words', 'one '.repeat(100000), 'one one one one one one one one'],
    ['70,000 "twenty-one" pairs', 'twenty-one '.repeat(70000), 'grew twenty-one twenty-one twenty-one twenty-one reach'],
    ['a run of 400,000 letters that spells number words end to end', 'twentyone'.repeat(44000), 'grew twenty one twenty one twenty one reach'],
    ['100,000 "a hundred" pairs', 'a hundred '.repeat(40000), 'grew a hundred a hundred a hundred reach in months'],
    ['100,000 hyphens after a tens word', 'twenty-'.repeat(57000), 'grew twenty-five reach in months'],
    ['"a " 200,000 times then a magnitude word', 'a '.repeat(200000) + 'thousand', 'grew a thousand reach in months'],
    ['200,000 "nine nine" with a long quote of nines', 'nine nine '.repeat(40000), rep(40, () => 'nine')],
  ])('%s', (_name, text, quote) => {
    expect(timed(text, quote)).toBeLessThan(2500);
  });
});
