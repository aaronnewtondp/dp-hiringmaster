import { describe, it, expect } from 'vitest';
import { candidateNameSignal, maskNameTokens, nameTokens } from './protectedAttributes.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Fix round 4 (E3A), the name findings of the third review:
//   G11 masking used to compare EXACT tokens while the signal compared spellings: a variant the signal called "likely" reached the model in clear
//       while the hint said it was masked. The mask now uses the same matcher (see nameEvidence in protectedAttributes.ts).
//   G7  the signal's cost grew with the square of the form name's token count (3,000 tokens: ten minutes). Only the first 8 tokens of the first
//       300 characters are matched; a text/name pair that is still too large is "unknown", never "unlikely".
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const cpuMs = (fn: () => void): number => {
  const before = process.cpuUsage();
  fn();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
};
const signal = (name: string, text: string) => candidateNameSignal(name, { text, hasSearchableText: true });

describe('G11: the mask covers every full-name match the signal finds', () => {
  const CASES: Array<[name: string, text: string, gone: string[], stays: string[]]> = [
    ['Shreya Ghoshal', 'Concept and direction: Sreya Ghosal, Creative Director', ['Sreya', 'Ghosal'], ['Creative Director', 'Concept and direction']],
    ['Mohammed Imran Khan', 'Md. Imran Khan, Mohd Imran, Muhammad Imran K.', ['Md', 'Mohd', 'Muhammad', 'Imran', 'Khan'], []],
    ['Md Imran Khan', 'Credits: Mohammed Imran Khan led the film', ['Mohammed', 'Imran', 'Khan'], ['Credits', 'led the film']],
    ['Priya Sharma', 'Priyaa Sharmaa and Preeya Sharma', ['Priyaa', 'Sharmaa', 'Preeya', 'Sharma'], []],
    ['Priya Sharma', 'ProfilePriyaSharmaDesign, PriyaSharmaCreative', ['Priya', 'Sharma'], ['Profile', 'Design', 'Creative']],
    ['Priya Sharma', 'Creative Lead: P. Sharma. Reach 2.1M', ['Sharma', 'P.'], ['Creative Lead', 'Reach 2.1M']],
    ['Priya Sharma', 'https://www.behance.net/psharma and psharma@agency.in', ['psharma'], ['behance.net', 'agency.in']],
    ['P. Sharma', 'Priya Sharma led the work', ['Priya', 'Sharma'], ['led the work']],
    ['Sundaram Venkataraman', 'Concept: Sundar Venkat, Creative Director', ['Sundar', 'Venkat'], ['Creative Director']],
    ['Neha Sharma', 'Neha  Sharma and neha sharma and NEHA SHARMA', ['Neha', 'Sharma', 'neha', 'NEHA', 'SHARMA'], ['and']],
  ];
  it.each(CASES)('%s in "%s"', (name, text, gone, stays) => {
    const masked = maskNameTokens(text, name);
    for (const g of gone) expect(masked, `must be masked: ${g}`).not.toContain(g);
    for (const s of stays) expect(masked, `must stay: ${s}`).toContain(s);
    expect(masked).toContain('[candidate]');
  });

  it('what the signal calls found, the mask makes unfindable (a table of spellings, order, case, accents, initials, written together)', () => {
    const TABLE: Array<[string, string]> = [
      ['Shreya Ghoshal', 'Directed by Sreya Ghosal at the studio'], ['Shreya Ghoshal', 'Ghoshal, Shreya'], ['Shreya Ghoshal', 'S. Ghoshal and team'],
      ['Mohammed Imran Khan', 'Md. Imran Khan'], ['Mohammed Imran Khan', 'Mohd Imran Khan'], ['Mohammed Imran Khan', 'Mohamed Imran Khan Films'],
      ['Priya Sharma', 'Priyaa Sharmaa'], ['Priya Sharma', 'PriyaSharma'], ['Priya Sharma', 'priyasharma'], ['Priya Sharma', 'PSharma'], ['Priya Sharma', 'Sharma P.'],
      ['Priya Sharma', 'Priya M. Sharma'], ['Priya Sharma', 'Priya Kumari Sharma'], ['Priya Sharma', 'By PRIYA SHARMA'], ['Priya Sharma', 'by Priýa Sharmá'],
      ['Anand Krishnamurthy', 'Anand Krishnamoorthy'], ['Kavita Anand Sharma', 'Kavita Sharma'], ['Lakshmi Narayanan', 'Laxmi Narayanan'],
      ['Sundar Pichai', 'Sundaram Pichai'], ['Rohan Deshpande', 'Rohan Deshpandey'], ['Meera Iyer', 'Mira Iyer'], ['Faisal Qureshi', 'Faisal Kureshi'],
    ];
    const notMasked: string[] = [];
    for (const [name, text] of TABLE) {
      const before = signal(name, text);
      const after = signal(name, maskNameTokens(text, name));
      if (before === 'likely' && after === 'likely') notMasked.push(`${name} | ${text} -> ${maskNameTokens(text, name)}`);
    }
    expect(notMasked).toEqual([]);
    // and the table is not vacuous: most of it IS a match
    expect(TABLE.filter(([n, t]) => signal(n, t) === 'likely').length).toBeGreaterThanOrEqual(18);
  });

  it('another person is still another person: a shared surname or given name, next to a different capitalised name, is left as it is', () => {
    expect(maskNameTokens('Concept and direction: Amit Sharma, Creative Director. Copy by Neha Sharma.', 'Neha Sharma')).toBe('Concept and direction: Amit Sharma, Creative Director. Copy by [candidate] [candidate].');
    expect(maskNameTokens('Amit Sharma and Neha Sharma worked with Rina Sharma.', 'Neha Sharma')).toBe('Amit Sharma and [candidate] [candidate] worked with Rina Sharma.');
    expect(maskNameTokens('Priya Nair and Priya Menon were credited', 'Priya Menon')).toBe('Priya Nair and [candidate] [candidate] were credited');
    expect(maskNameTokens('Credits: Rajeev Menon', 'Priya Menon')).toBe('Credits: Rajeev Menon');
    // a variant spelling of ONE token next to a different person is not a full-name match either
    expect(maskNameTokens('Concept: Amit Sharmaa, Creative Director', 'Neha Sharma')).toBe('Concept: Amit Sharmaa, Creative Director');
    expect(maskNameTokens('Priya Nair and Rohit Menon', 'Priya Menon')).toBe('Priya Nair and Rohit Menon');
    expect(maskNameTokens('Sreya alone, with no surname', 'Shreya Ghoshal')).toBe('Sreya alone, with no surname');
  });

  it('a name that is also an ordinary word is still only masked when it is capitalised', () => {
    expect(maskNameTokens('rose water and Rose Hunter and a hunter-gatherer brand', 'Rose Hunter')).toBe('rose water and [candidate] [candidate] and a hunter-gatherer brand');
  });

  it('an exact match and a fuzzy match over the same words give one marker, two names written together give two', () => {
    expect(maskNameTokens('Priya Sharma', 'Priya Sharma')).toBe('[candidate] [candidate]');
    expect(maskNameTokens('https://priyasharma.design/work', 'Priya Sharma')).toBe('https://[candidate][candidate].design/work');
  });
});

describe('G7: the form name is bounded', () => {
  const TEXT = ('Brand deck by Priya Sharma, Creative Director. Campaign reach 2.1M, 38% uplift in enquiries. ').repeat(400);   // about 36 KB
  const mkName = (n: number) => Array.from({ length: n }, (_, i) => `tok${'abcdefghij'[i % 10]}${'abcdefghij'[(i * 7) % 10]}${'abcdefghij'[(i * 3) % 10]}${'abcdefghijklmnopqrstuvwxyz'[i % 26]}`).join(' ');

  it('nameTokens keeps the first 8 tokens of the first 300 characters', () => {
    expect(nameTokens(mkName(3000))).toHaveLength(8);
    expect(nameTokens(`${'x'.repeat(400)} Priya`)).toEqual(['x'.repeat(300)]);   // the first 300 characters are one word of x; "Priya" is past them
    expect(nameTokens('Priya Kumari Sharma')).toEqual(['priya', 'kumari', 'sharma']);
  });
  it('a 3,000-token name costs the same as a short one (signal and mask over 36 KB)', () => {
    const ms = (name: string) => cpuMs(() => { candidateNameSignal(name, { text: TEXT, hasSearchableText: true }); maskNameTokens(TEXT, name); });
    ms('Priya Sharma');   // warm up
    for (const n of [2, 20, 200, 1000, 3000]) {
      expect(ms(mkName(n)), `${n} tokens`).toBeLessThan(400);
    }
  });
  it('the first tokens of a very long name still match', () => {
    const name = `Priya Sharma ${mkName(3000)}`;
    expect(signal(name, 'Credits: Priya Sharma')).toBe('likely');
    expect(maskNameTokens('Credits: Priya Sharma', name)).toBe('Credits: [candidate] [candidate]');
  });
  it('a text in which two tokens of the name both match tens of thousands of words costs a few checks per word, not a product', () => {
    const t = cpuMs(() => { expect(signal('Ann Anne Annie Anna', 'Ann '.repeat(20_000))).toBe('likely'); });
    expect(t).toBeLessThan(500);
    expect(cpuMs(() => { maskNameTokens('Ann Anne '.repeat(10_000), 'Ann Anne Annie Anna'); })).toBeLessThan(800);
  });
  it('past the work budget the answer is "unknown", never "unlikely": 8 name tokens against 30,000 words', () => {
    const words = Array.from({ length: 30_000 }, (_, i) => `word${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${i % 7}`).join(' ');
    const eight = 'Alpha Bravo Charlie Delta Echo Foxtrot Golfer Hotel';
    expect(signal(eight, words)).toBe('unknown');
    expect(signal('Alpha Bravo Charlie', words)).toBe('unlikely');   // within budget: really searched, really absent
    expect(maskNameTokens(`${words} Alpha Bravo`, eight)).toContain('[candidate]');   // the exact masking never skips
  });
});
