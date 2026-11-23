import { describe, it, expect } from 'vitest';
import { enforceEvidenceRules, QUOTE_CHECKS_MAX, type EvidenceContext } from './rubric.marketing.js';
import type { CriterionResult, CriterionVerdict } from './types.js';

// analysis.quoteChecks: one small measurement record per quoted fragment the matcher rejected ('invented') or held at 'near'. Diagnostic
// only: no verdict, score, cap, outcome or note depends on it, and nothing of the fragment or of the page is ever stored.

const read = (evidence: string, over: Partial<CriterionResult> = {}): CriterionResult => ({
  id: 'mh3', label: 'Launched 5+ campaigns', verdict: 'strong' as CriterionVerdict, evidence, group: 'direct', weight: 1.5, basis: 'read', source: 'L1', assessable: true, ...over,
});
type Item = EvidenceContext['acquired'][number];
const item = (text: string, over: Partial<Item> = {}): Item => ({ ref: 'L1', basis: 'artifact', outcome: 'ok', text, link: { platform: 'custom' }, ...over });
const ctx = (text: string, over: Partial<Item> = {}, extra: Partial<EvidenceContext> = {}): EvidenceContext => ({ acquired: [item(text, over)], claimText: '', ...extra });
const checksOf = (evidence: string, text: string, over: Partial<Item> = {}, extra: Partial<EvidenceContext> = {}, c: Partial<CriterionResult> = {}) =>
  enforceEvidenceRules([read(evidence, c)], ctx(text, over, extra)).quoteChecks;
const NO_FLAGS = { entities: false, ampersand: false, copyright: false, strayQuotes: false, unmasked: false };

describe('quoteChecks: what is recorded', () => {
  it('records nothing when every quote is found verbatim, and nothing when the criterion has no quote', () => {
    expect(checksOf('Says "we launched the clean water week campaign"', 'We launched the Clean Water Week campaign.')).toEqual([]);
    expect(checksOf('Says nothing in quotes', 'We launched the Clean Water Week campaign.')).toEqual([]);
  });

  it('an invented quote: criterion, ref, outcome, lengths and the flags, and no text', () => {
    const fragment = 'we won the national award for zorbulax';
    const r = checksOf(`Says "${fragment}"`, 'We launched the Clean Water Week campaign.');
    expect(r).toEqual([{
      criterion: 'mh3', ref: 'L1', outcome: 'invented', chars: fragment.length, words: 7,
      itemHadMedia: true, itemTextTruncated: false, wouldPassWith: NO_FLAGS,
    }]);
  });

  it('a near quote is recorded as near (and its verdict is held at partial, as before)', () => {
    const res = enforceEvidenceRules([read('Says "we launched the clean water week campaign across forty sites"')], ctx('We launched the Clean Water Week campaign across forty big sites.'));
    expect(res.criteria[0].verdict).toBe('partial');
    expect(res.quoteChecks.map(c => c.outcome)).toEqual(['near']);
  });

  it('one record per rejected fragment, each with its own length; a found fragment beside a rejected one is not recorded', () => {
    const r = checksOf('Says "we launched the clean water week campaign" and "totally made up words here" and "another zorbulax claim made"', 'We launched the Clean Water Week campaign.');
    expect(r.map(c => [c.outcome, c.words])).toEqual([['invented', 5], ['invented', 4]]);
  });

  it('a nice-to-have id is recorded as it is (nh9)', () => {
    const r = enforceEvidenceRules([read('Says "made up words about seo here"', { id: 'nh9', group: undefined, weight: undefined })], ctx('We launched the Clean Water Week campaign.')).quoteChecks;
    expect(r[0].criterion).toBe('nh9');
  });

  it('itemHadMedia and itemTextTruncated follow the cited item(s): any cited item counts', () => {
    const text = 'We launched the Clean Water Week campaign.';
    const e = 'Says "totally made up words here"';
    expect(checksOf(e, text, { hasMedia: false })[0]).toMatchObject({ itemHadMedia: false, itemTextTruncated: false });
    expect(checksOf(e, text, { hasMedia: true, textTruncated: true })[0]).toMatchObject({ itemHadMedia: true, itemTextTruncated: true });
    const two = enforceEvidenceRules([read(e, { source: 'L2, L1' })], {
      acquired: [item(text, { hasMedia: false }), item(text, { ref: 'L2', hasMedia: true })], claimText: '',
    }).quoteChecks;
    expect(two[0]).toMatchObject({ ref: 'L2', itemHadMedia: true });
  });

  it('a native document whose text is truncated is unverifiable: nothing was rejected, so nothing is recorded (and the verdict stands)', () => {
    const res = enforceEvidenceRules([read('Says "totally made up words here"')], ctx('We launched.', { nativeDocument: true, textTruncated: true }));
    expect(res.quoteChecks).toEqual([]);
    expect(res.criteria[0].verdict).toBe('strong');
    expect(res.notes).toEqual([]);
  });
});

describe('quoteChecks: wouldPassWith, one extra folding at a time', () => {
  it('entities: the page says &amp;', () => {
    const r = checksOf('Says "R&D team ran three bold campaigns"', 'The R&amp;D team ran three bold campaigns.');
    // an entity usually leaves the words close enough for a near match: passing then means becoming verbatim
    expect(r[0].outcome).toBe('near');
    expect(r[0].wouldPassWith).toEqual({ ...NO_FLAGS, entities: true });
  });

  it('ampersand: "&" on the page, "and" in the quote (and the other way round)', () => {
    expect(checksOf('Says "Research and Development team ran bold campaigns"', 'Research & Development team ran bold campaigns')[0].wouldPassWith).toEqual({ ...NO_FLAGS, ampersand: true });
    expect(checksOf('Says "Research & Development team ran bold campaigns"', 'Research and Development team ran bold campaigns')[0].wouldPassWith).toEqual({ ...NO_FLAGS, ampersand: true });
  });

  it('copyright: (c) or the sign on the page, the word in the quote', () => {
    expect(checksOf('Says "Copyright 2024 Studio Aqua Pvt"', '© 2024 Studio Aqua Pvt')[0].wouldPassWith).toEqual({ ...NO_FLAGS, copyright: true });
    expect(checksOf('Says "Copyright 2024 Studio Aqua Pvt"', '(c) 2024 Studio Aqua Pvt')[0].wouldPassWith).toEqual({ ...NO_FLAGS, copyright: true });
  });

  it('strayQuotes: a quote mark inside the fragment, whose 3+ word pieces are all on the page', () => {
    const r = checksOf('Says “Our "Clean Water Week" campaign”', 'Clean Water Week is here');
    expect(r[0].outcome).toBe('invented');
    expect(r[0].wouldPassWith).toEqual({ ...NO_FLAGS, strayQuotes: true });
    // no mark inside: false whatever the page holds
    expect(checksOf('Says "Our clean water week campaign"', 'Clean Water Week is here')[0].wouldPassWith.strayQuotes).toBe(false);
    // a mark inside but a piece that is not on the page: false
    expect(checksOf('Says “Our "Clean Water Week" and "zorbulax quimfler plenk"”', 'Clean Water Week is here')[0].wouldPassWith.strayQuotes).toBe(false);
  });

  it('unmasked: the quote has the name, the page has the placeholder', () => {
    const page = 'Brand by [candidate] launched the campaign in 2024';
    const e = 'Says "Brand by Priya Sharma launched the campaign"';
    expect(checksOf(e, page, {}, { candidateName: 'Priya Sharma' })[0].wouldPassWith).toEqual({ ...NO_FLAGS, unmasked: true });
    // no name known: nothing to unmask
    expect(checksOf(e, page)[0].wouldPassWith.unmasked).toBe(false);
    // a name that is not in the fragment changes nothing
    expect(checksOf(e, page, {}, { candidateName: 'Rohan Mehta' })[0].wouldPassWith.unmasked).toBe(false);
  });

  it('a fabricated quote has every flag false', () => {
    expect(checksOf('Says "we won the national award for zorbulax"', 'R&amp;D © Studio & Co. [candidate]', {}, { candidateName: 'Priya Sharma' })[0].wouldPassWith).toEqual(NO_FLAGS);
  });

  it('for a near quote, passing means becoming exact', () => {
    const r = checksOf('Says "The R&D team ran three very bold campaigns"', 'The R&amp;D team ran three bold campaigns.');
    expect(r[0].outcome).toBe('near');
    expect(r[0].wouldPassWith.entities).toBe(false);
    const r2 = checksOf('Says "The R&D team ran three bold campaigns, quietly"', 'The R&amp;D team ran three bold campaigns.');
    expect(r2[0].outcome === 'near' ? r2[0].wouldPassWith.entities : true).toBe(false);
  });
});

describe('quoteChecks: bounds, no leaks, no effect on the review', () => {
  it(`is capped at ${QUOTE_CHECKS_MAX} entries`, () => {
    const evidence = Array.from({ length: 55 }, (_, i) => `"made up claim number ${i} here"`).join(' and ');
    expect(checksOf(evidence, 'We launched the Clean Water Week campaign.')).toHaveLength(QUOTE_CHECKS_MAX);
  });

  it('never stores any word or substring (4+ characters) of the fragment or the page', () => {
    const fragment = 'zorbulax quimfler plenkarta voshnit dromble';
    const page = 'Ostrivant glemmoth prundafel; the wuxlibar snorgate zindoprell vexturan campaign. Priya Sharma xyloquent.';
    const r = enforceEvidenceRules([read(`Says "${fragment}" and "ostrivant glemmoth made up words"`)], ctx(page, {}, { candidateName: 'Priya Sharma' })).quoteChecks;
    expect(r.length).toBe(2);
    const stored = JSON.stringify(r).toLowerCase();
    for (const source of [fragment, page, 'ostrivant glemmoth made up words']) {
      const s = source.toLowerCase();
      for (let i = 0; i + 4 <= s.length; i++) {
        const sub = s.slice(i, i + 4);
        if (/^[a-z]{4}$/.test(sub) && /(zorb|quim|plen|vosh|drom|ostr|glem|prun|wuxl|snor|zind|vext|xylo)/.test(sub)) expect(stored).not.toContain(sub);
      }
    }
    expect(stored).not.toContain('priya');
    expect(stored).not.toContain('sharma');
  });

  it('only measurements are stored: the keys are fixed and the values are numbers, booleans and our own ids', () => {
    const [c] = checksOf('Says "totally made up words here"', 'We launched.');
    expect(Object.keys(c).sort()).toEqual(['chars', 'criterion', 'itemHadMedia', 'itemTextTruncated', 'outcome', 'ref', 'words', 'wouldPassWith']);
    expect(Object.keys(c.wouldPassWith).sort()).toEqual(['ampersand', 'copyright', 'entities', 'strayQuotes', 'unmasked']);
  });

  it('changes no verdict, evidence or note: the same criteria and notes with or without a candidate name, and for any text', () => {
    const e = 'Says "Brand by Priya Sharma launched the campaign" and "made up words here"';
    const page = 'Brand by [candidate] launched the campaign in 2024';
    const a = enforceEvidenceRules([read(e)], ctx(page));
    const b = enforceEvidenceRules([read(e)], ctx(page, {}, { candidateName: 'Priya Sharma' }));
    expect({ criteria: a.criteria, notes: a.notes }).toEqual({ criteria: b.criteria, notes: b.notes });
    expect(a.criteria[0].verdict).toBe('not_evidenced');
    expect(a.notes).toEqual(['mh3: quoted text not found in L1; the quote is invented, so strong lowered to not_evidenced']);
  });
});
