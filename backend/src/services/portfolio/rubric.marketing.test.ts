import { describe, it, expect } from 'vitest';
import {
  MARKETING_CRITERIA, MARKETING_NICE_TO_HAVES, normalizeMarketingCriteria, normalizeNiceToHaves,
  enforceEvidenceRules, weightedChecklistScore, niceToHaveBonus, applyMarketingCaps, marketingScore,
  countReturnedCriteria, filterProtectedAttributes, findProtectedAttribute, NOT_RETURNED_TEXT,
  type EvidenceContext, type MarketingCapInput,
} from './rubric.marketing.js';
import { blendPortfolioScore } from './rubric.js';
import type { CriterionResult, CriterionVerdict } from './types.js';

const IDS = MARKETING_CRITERIA.map(c => c.id);
const NH_IDS = MARKETING_NICE_TO_HAVES.map(n => n.id);

const crit = (id: string, verdict: CriterionVerdict, over: Partial<CriterionResult> = {}): CriterionResult => {
  const def = MARKETING_CRITERIA.find(c => c.id === id);
  return {
    id, label: def?.label ?? id, verdict, evidence: '', group: def?.group, weight: def?.weight,
    basis: 'seen', source: 'L1', assessable: true, ...over,
  };
};
type Acq = EvidenceContext['acquired'][number];
const acq = (over: Partial<Acq> = {}): Acq => ({
  ref: 'L1', basis: 'artifact', outcome: 'ok', text: '', link: { platform: 'custom' }, ...over,
});
const ctx = (acquired: Acq[] = [acq()], claimText = 'I ran many campaigns'): EvidenceContext => ({ acquired, claimText });
const enforce = (c: CriterionResult, x: EvidenceContext = ctx()) => enforceEvidenceRules([c], x);

const capInput = (over: Partial<MarketingCapInput> = {}): MarketingCapInput => ({
  reviewedArtifacts: 3, metadataOnly: false, thinArtifact: false, employerOnly: false, ownershipVerdict: 'strong', creditedToOther: false, ...over,
});

// Typographic characters built from code points, so the source file never depends on how an escape is saved.
const LDQ = String.fromCharCode(0x201c);   // left double quotation mark
const RDQ = String.fromCharCode(0x201d);
const LSQ = String.fromCharCode(0x2018);   // left single quotation mark
const RSQ = String.fromCharCode(0x2019);   // right single quotation mark, also the typographic apostrophe
const ELLIPSIS = String.fromCharCode(0x2026);
const EN_DASH = String.fromCharCode(0x2013);
const SOFT_HYPHEN = String.fromCharCode(0x00ad);
const ZWSP = String.fromCharCode(0x200b);
const FI_LIGATURE = String.fromCharCode(0xfb01);

// ─── The criteria ────────────────────────────────────────────────────────────
describe('MARKETING_CRITERIA', () => {
  it('holds mh1..mh10 then the five evidence-quality criteria, in that order, with unique ids', () => {
    expect(MARKETING_CRITERIA).toHaveLength(15);
    expect(IDS).toEqual(['mh1', 'mh2', 'mh3', 'mh4', 'mh5', 'mh6', 'mh7', 'mh8', 'mh9', 'mh10',
      'eq_ownership', 'eq_outcomes', 'eq_craft', 'eq_coherence', 'eq_recency']);
    expect(new Set(IDS).size).toBe(15);
  });

  it.each([
    ['mh1', 'direct', 1.0], ['mh3', 'direct', 1.5], ['mh4', 'direct', 1.0], ['mh5', 'direct', 1.0], ['mh6', 'direct', 0.75],
    ['mh2', 'corroboration', 0.5], ['mh7', 'corroboration', 0.5], ['mh8', 'corroboration', 0.5],
    ['mh9', 'corroboration', 0.5], ['mh10', 'corroboration', 0.5],
    ['eq_ownership', 'quality', 1.0], ['eq_outcomes', 'quality', 1.0], ['eq_craft', 'quality', 1.0],
    ['eq_coherence', 'quality', 0.5], ['eq_recency', 'quality', 0.5],
  ])('%s is %s with weight %s', (id, group, weight) => {
    const def = MARKETING_CRITERIA.find(c => c.id === id)!;
    expect(def.group).toBe(group);
    expect(def.weight).toBe(weight);
  });

  it('gives every criterion a short UI label and a precise description that says what strong and not_evidenced mean', () => {
    for (const c of MARKETING_CRITERIA) {
      expect(c.label.length, c.id).toBeGreaterThan(3);
      expect(c.label.length, c.id).toBeLessThanOrEqual(40);
      expect(c.description, c.id).toMatch(/strong =/);
      expect(c.description, c.id).toMatch(/not_evidenced =/);
    }
  });

  it('mh3 asks for 5+ campaigns and makes 3-4 a partial', () => {
    const d = MARKETING_CRITERIA.find(c => c.id === 'mh3')!.description;
    expect(d).toMatch(/5\+ campaigns/);
    expect(d).toMatch(/3-4/);
    expect(d).toMatch(/partial = 3-4/);
  });

  it('eq_ownership never lets a missing credit be a concern, only a different person or a contradiction', () => {
    const d = MARKETING_CRITERIA.find(c => c.id === 'eq_ownership')!.description;
    expect(d).toMatch(/NEVER a concern/);
    expect(d).toMatch(/DIFFERENT full personal name/);
    expect(d).toMatch(/AND \[candidate\] does not appear in the credits you can read/);
    expect(d).toMatch(/contradicts the candidate's own claim/);
    // the stricter test, in the words the analyzer's prompt and the other_person label use: these are never a concern
    expect(d).toMatch(/A team list, an agency or studio page, an employer's or client's brand page, a missing credit, and a credit you can see only inside an image are never a concern/);
  });

  it('eq_outcomes does not re-count campaigns and eq_craft refuses thumbnails and unwatched video', () => {
    expect(MARKETING_CRITERIA.find(c => c.id === 'eq_outcomes')!.description).toMatch(/do not re-count campaigns/);
    const craft = MARKETING_CRITERIA.find(c => c.id === 'eq_craft')!.description;
    expect(craft).toMatch(/thumbnail/);
    expect(craft).toMatch(/not watched/);
  });

  it('the ten must-have criteria carry the role\'s own requirements', () => {
    const d = (id: string) => MARKETING_CRITERIA.find(c => c.id === id)!.description;
    expect(d('mh1')).toMatch(/from scratch/);
    expect(d('mh2')).toMatch(/1-3 people/);
    expect(d('mh4')).toMatch(/video scripts/);
    expect(d('mh5')).toMatch(/Figma\/Adobe/);
    expect(d('mh6')).toMatch(/virality/);
    expect(d('mh7')).toMatch(/limited resources/);
    expect(d('mh8')).toMatch(/climate, water/);
    expect(d('mh9')).toMatch(/pitch/);
    expect(d('mh10')).toMatch(/startup operating experience/);
  });
});

describe('MARKETING_NICE_TO_HAVES', () => {
  it('holds nh1..nh10 with unique ids, labels and descriptions', () => {
    expect(NH_IDS).toEqual(['nh1', 'nh2', 'nh3', 'nh4', 'nh5', 'nh6', 'nh7', 'nh8', 'nh9', 'nh10']);
    for (const n of MARKETING_NICE_TO_HAVES) {
      expect(n.label.length, n.id).toBeGreaterThan(3);
      expect(n.description, n.id).toMatch(/strong =/);
    }
  });

  it.each([
    ['nh1', /climate/i], ['nh2', /influencer/i], ['nh3', /video/i], ['nh4', /activations/i], ['nh5', /agency/i],
    ['nh6', /B2B/], ['nh7', /founder/i], ['nh8', /analytics/i], ['nh9', /SEO/], ['nh10', /photography/i],
  ])('%s matches the role\'s nice-to-have', (id, re) => {
    expect(MARKETING_NICE_TO_HAVES.find(n => n.id === id)!.description).toMatch(re);
  });
});

// ─── Normalisation ───────────────────────────────────────────────────────────
describe('normalizeMarketingCriteria', () => {
  it('always returns all 15 in canonical order, filling gaps as not_evidenced with the definition\'s group and weight', () => {
    const out = normalizeMarketingCriteria([{ id: 'mh4', verdict: 'strong', basis: 'read', source: 'L2', evidence: 'Clear copy in five formats' }]);
    expect(out.map(c => c.id)).toEqual(IDS);
    const mh4 = out.find(c => c.id === 'mh4')!;
    expect(mh4).toMatchObject({ verdict: 'strong', basis: 'read', source: 'L2', evidence: 'Clear copy in five formats', group: 'direct', weight: 1.0, assessable: true });
    const mh2 = out.find(c => c.id === 'mh2')!;
    // a criterion the model never returned is LEFT OUT (assessable false), not judged absent
    expect(mh2).toMatchObject({ verdict: 'not_evidenced', basis: 'none', source: '', group: 'corroboration', weight: 0.5, evidence: NOT_RETURNED_TEXT, assessable: false });
    expect(out.filter(c => c.id !== 'mh4').every(c => c.assessable === false && c.evidence === NOT_RETURNED_TEXT)).toBe(true);
  });

  it('fills label, group and weight from the definition, ignoring whatever the model sent (assessable is the one flag it may set)', () => {
    const out = normalizeMarketingCriteria([{ id: 'mh1', verdict: 'partial', label: 'Hacked', group: 'quality', weight: 99 } as never]);
    const mh1 = out.find(c => c.id === 'mh1')!;
    expect(mh1.label).toBe('Built a brand from scratch');
    expect(mh1.group).toBe('direct');
    expect(mh1.weight).toBe(1.0);
    expect(mh1.assessable).toBe(true);
  });

  it('drops unknown ids and keeps the first answer for a duplicated id', () => {
    const out = normalizeMarketingCriteria([
      { id: 'made_up', verdict: 'strong' }, { id: 'nh1', verdict: 'strong' }, { id: 'ownership', verdict: 'strong' },
      { id: 'mh3', verdict: 'partial', evidence: 'first' }, { id: 'mh3', verdict: 'strong', evidence: 'second' },
    ]);
    expect(out).toHaveLength(15);
    expect(out.some(c => c.id === 'made_up' || c.id === 'nh1' || c.id === 'ownership')).toBe(false);
    expect(out.find(c => c.id === 'mh3')).toMatchObject({ verdict: 'partial', evidence: 'first' });
  });

  it.each(['amazing', '', 'STRONGEST', 42, null, undefined, {}, ['strong'], true])('turns the invalid verdict %j into not_evidenced', (verdict) => {
    expect(normalizeMarketingCriteria([{ id: 'mh1', verdict }]).find(c => c.id === 'mh1')!.verdict).toBe('not_evidenced');
  });

  it.each(['strong', 'partial', 'not_evidenced', 'concern'] as const)('keeps the valid verdict %s', (verdict) => {
    expect(normalizeMarketingCriteria([{ id: 'mh1', verdict }]).find(c => c.id === 'mh1')!.verdict).toBe(verdict);
  });

  it('is tolerant of case and padding in ids and verdicts, since that is still the model\'s answer', () => {
    const out = normalizeMarketingCriteria([{ id: ' MH3 ', verdict: ' Strong ', basis: ' READ ' }]);
    expect(out.find(c => c.id === 'mh3')).toMatchObject({ verdict: 'strong', basis: 'read' });
  });

  it('clips evidence to 220 characters and collapses whitespace', () => {
    const out = normalizeMarketingCriteria([{ id: 'mh1', verdict: 'strong', evidence: `  a\n\n b\t${'y'.repeat(1000)}` }]);
    const ev = out.find(c => c.id === 'mh1')!.evidence;
    expect(ev.length).toBeLessThanOrEqual(220);
    expect(ev.startsWith('a b y')).toBe(true);
  });

  it('turns non-string evidence into an empty string, but a criterion the model never mentioned says it was not returned', () => {
    const out = normalizeMarketingCriteria([{ id: 'mh1', verdict: 'strong', evidence: { text: 'x' } }, { id: 'mh3', verdict: 'strong', evidence: 42 }]);
    expect(out.find(c => c.id === 'mh1')!.evidence).toBe('');
    expect(out.find(c => c.id === 'mh3')!.evidence).toBe('');
    expect(out.find(c => c.id === 'mh4')!.evidence).toBe('Not returned by the reviewer');
  });

  it.each([['seen', 'seen'], ['read', 'read'], ['claimed', 'claimed'], ['none', 'none'], [' Seen ', 'seen'],
    ['observed', 'none'], ['', 'none'], [7, 'none'], [null, 'none'], [undefined, 'none']] as const)(
    'normalises basis %j to %s', (basis, expected) => {
      expect(normalizeMarketingCriteria([{ id: 'mh1', verdict: 'strong', basis }]).find(c => c.id === 'mh1')!.basis).toBe(expected);
    });

  it('clips the source and drops a non-string source', () => {
    const long = normalizeMarketingCriteria([{ id: 'mh1', verdict: 'strong', source: 'L1'.padEnd(200, 'x') }]);
    expect(long.find(c => c.id === 'mh1')!.source!.length).toBeLessThanOrEqual(64);
    expect(normalizeMarketingCriteria([{ id: 'mh1', verdict: 'strong', source: 5 }]).find(c => c.id === 'mh1')!.source).toBe('');
  });

  it.each([undefined, null, 'nope', 7, {}, [null, 5, 'x', [], undefined]])('survives garbage input %j', (garbage) => {
    const out = normalizeMarketingCriteria(garbage as never);
    expect(out.map(c => c.id)).toEqual(IDS);
    expect(out.every(c => c.verdict === 'not_evidenced')).toBe(true);
  });
});

describe('normalizeNiceToHaves', () => {
  it('always returns all 10 in canonical order with labels, and no group or weight', () => {
    const out = normalizeNiceToHaves([{ id: 'nh9', verdict: 'strong', basis: 'read', source: 'L1', evidence: 'Organic reach from search' }]);
    expect(out.map(c => c.id)).toEqual(NH_IDS);
    expect(out.find(c => c.id === 'nh9')).toMatchObject({ verdict: 'strong', basis: 'read', source: 'L1', label: 'SEO / organic growth' });
    expect(out.find(c => c.id === 'nh1')).toMatchObject({ verdict: 'not_evidenced', evidence: NOT_RETURNED_TEXT, assessable: false });
    expect(out.every(c => c.group === undefined && c.weight === undefined)).toBe(true);
  });

  it('drops the must-have ids and unknown ids, takes the first duplicate, and invalid verdicts become not_evidenced', () => {
    const out = normalizeNiceToHaves([
      { id: 'mh1', verdict: 'strong' }, { id: 'zzz', verdict: 'strong' }, { id: 'nh2', verdict: 'maybe' },
      { id: 'nh3', verdict: 'partial' }, { id: 'nh3', verdict: 'strong' },
    ]);
    expect(out).toHaveLength(10);
    expect(out.some(c => c.id === 'mh1')).toBe(false);
    expect(out.find(c => c.id === 'nh2')!.verdict).toBe('not_evidenced');
    expect(out.find(c => c.id === 'nh3')!.verdict).toBe('partial');
  });

  it.each([undefined, null, 'nope', 3, {}])('survives garbage input %j', (garbage) => {
    expect(normalizeNiceToHaves(garbage as never)).toHaveLength(10);
  });
});

// ─── assessable and the completeness gate ────────────────────────────────────
describe('normalizeMarketingCriteria — assessable', () => {
  it.each([['mh1', 'direct'], ['mh2', 'corroboration'], ['eq_craft', 'quality']])(
    'assessable:false on %s (%s) forces not_evidenced and clears the basis and source, keeping the reviewer\'s reason', (id) => {
      const out = normalizeMarketingCriteria(IDS.map(i => (i === id
        ? { id, verdict: 'strong', basis: 'seen', source: 'L1', evidence: 'Marathi copy the reviewer could not read', assessable: false }
        : { id: i, verdict: 'partial', basis: 'seen', source: 'L1' })));
      expect(out.find(c => c.id === id)).toMatchObject({
        verdict: 'not_evidenced', basis: 'none', source: '', assessable: false, evidence: 'Marathi copy the reviewer could not read',
      });
      expect(out.filter(c => c.id !== id).every(c => c.assessable === true)).toBe(true);
    });

  it('says why when the reviewer gave no reason', () => {
    const out = normalizeMarketingCriteria([{ id: 'mh4', verdict: 'partial', assessable: false }]);
    expect(out.find(c => c.id === 'mh4')).toMatchObject({ verdict: 'not_evidenced', assessable: false, evidence: 'Not assessable from the material shown' });
  });

  it.each([true, undefined, null, 'false', 0, '', 'no', {}, []])('only a real boolean false marks a criterion not assessable (%j is ignored)', (assessable) => {
    const out = normalizeMarketingCriteria([{ id: 'mh3', verdict: 'strong', basis: 'seen', source: 'L1', assessable }]);
    expect(out.find(c => c.id === 'mh3')).toMatchObject({ verdict: 'strong', basis: 'seen', source: 'L1', assessable: true });
  });

  it('works for the nice-to-haves too', () => {
    const out = normalizeNiceToHaves(NH_IDS.map(id => (id === 'nh3'
      ? { id, verdict: 'strong', basis: 'seen', source: 'L1', evidence: 'Film in a language the reviewer cannot follow', assessable: false }
      : { id, verdict: 'not_evidenced', basis: 'none' })));
    expect(out.find(c => c.id === 'nh3')).toMatchObject({ verdict: 'not_evidenced', basis: 'none', source: '', assessable: false });
    expect(out.filter(c => c.id !== 'nh3').every(c => c.assessable === true)).toBe(true);
  });

  it('the first answer for an id wins, its assessable flag included', () => {
    const a = normalizeMarketingCriteria([{ id: 'mh5', verdict: 'strong', assessable: false }, { id: 'mh5', verdict: 'strong', basis: 'seen', source: 'L1' }]);
    expect(a.find(c => c.id === 'mh5')).toMatchObject({ verdict: 'not_evidenced', assessable: false });
    const b = normalizeMarketingCriteria([{ id: 'mh5', verdict: 'strong', basis: 'seen', source: 'L1' }, { id: 'mh5', verdict: 'strong', assessable: false }]);
    expect(b.find(c => c.id === 'mh5')).toMatchObject({ verdict: 'strong', assessable: true });
  });

  it('a not assessable criterion is no evidence for or against: enforceEvidenceRules leaves it alone', () => {
    const out = normalizeMarketingCriteria([{ id: 'mh5', verdict: 'strong', assessable: false }]);
    const r = enforceEvidenceRules(out, ctx());
    expect(r.criteria.find(c => c.id === 'mh5')).toMatchObject({ verdict: 'not_evidenced', assessable: false });
    expect(r.notes).toEqual([]);
  });
});

describe('countReturnedCriteria', () => {
  const all = IDS.map(id => ({ id, verdict: 'partial' }));

  it('counts the distinct valid criterion ids the model returned', () => {
    expect(countReturnedCriteria(all)).toBe(15);
    expect(countReturnedCriteria(all.slice(0, 11))).toBe(11);
    expect(countReturnedCriteria([{ id: 'mh3' }])).toBe(1);
  });

  it.each([undefined, null, 'mh1', 7, true, {}, { id: 'mh1' }, { criteria: 'mh1' }, { criteria: null }])('is 0 when it is not an array (%j)', (raw) => {
    expect(countReturnedCriteria(raw)).toBe(0);
  });

  it('is 0 for an empty array and for an array with nothing valid in it', () => {
    expect(countReturnedCriteria([])).toBe(0);
    expect(countReturnedCriteria([null, undefined, 5, 'mh1', [], {}, { id: 7 }, { id: null }, { id: '' }, { id: {} }, { id: ['mh1'] }])).toBe(0);
  });

  it('counts a repeated id once', () => {
    expect(countReturnedCriteria([{ id: 'mh1' }, { id: 'mh1' }, { id: ' MH1 ' }, { id: 'mh2' }])).toBe(2);
  });

  it('ignores unknown ids and the nice-to-have ids', () => {
    expect(countReturnedCriteria([{ id: 'made_up' }, { id: 'nh1' }, { id: 'nh10' }, { id: 'ownership' }, { id: 'mh11' }, { id: 'mh0' }, { id: 'mh1' }])).toBe(1);
  });

  it('is as tolerant as the normaliser about case and padding in an id', () => {
    expect(countReturnedCriteria([{ id: ' MH3 ' }, { id: 'Eq_Craft' }])).toBe(2);
  });

  it('counts an entry whatever its verdict, as long as the id is valid', () => {
    expect(countReturnedCriteria([{ id: 'mh1', verdict: 'amazing' }, { id: 'mh2' }, { id: 'mh3', assessable: false }])).toBe(3);
  });

  it('accepts the whole raw output as well as its criteria array', () => {
    expect(countReturnedCriteria({ criteria: all.slice(0, 4), modelScore: 8 })).toBe(4);
  });

  it('agrees with the normaliser: a reply that answered 3 of 15 normalises to 15 criteria but counts 3', () => {
    const raw = [{ id: 'mh1', verdict: 'strong' }, { id: 'mh3', verdict: 'strong' }, { id: 'eq_craft', verdict: 'partial' }];
    expect(normalizeMarketingCriteria(raw)).toHaveLength(15);
    expect(countReturnedCriteria(raw)).toBe(3);
  });
});

// ─── enforceEvidenceRules ────────────────────────────────────────────────────
describe('enforceEvidenceRules — rule 1: a verdict must cite a source that was really given', () => {
  it('leaves a verdict that cites a real artifact untouched and records no note', () => {
    const r = enforce(crit('mh3', 'strong', { source: 'L1', basis: 'seen' }));
    expect(r.criteria[0]).toMatchObject({ verdict: 'strong', basis: 'seen', source: 'L1' });
    expect(r.notes).toEqual([]);
  });

  it('matches the ref case-insensitively and stores it in its canonical spelling', () => {
    const r = enforce(crit('mh3', 'strong', { source: ' l1 ' }));
    expect(r.criteria[0]).toMatchObject({ verdict: 'strong', source: 'L1' });
  });

  it('a ref that was never given: basis none, source cleared, strong -> partial', () => {
    const r = enforce(crit('mh3', 'strong', { source: 'L9' }));
    expect(r.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'none', source: '' });
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^mh3: /);
    expect(r.notes[0]).toMatch(/"L9" was not shown/);
    expect(r.notes[0]).toMatch(/strong lowered to partial/);
  });

  it.each([
    ['strong', 'partial'], ['partial', 'not_evidenced'], ['concern', 'not_evidenced'],
  ] as const)('an invalid source lowers %s one step to %s', (from, to) => {
    expect(enforce(crit('mh4', from, { source: 'nope' })).criteria[0].verdict).toBe(to);
  });

  it('a verdict that is already not_evidenced is left exactly as it is, with no note', () => {
    const c = crit('mh4', 'not_evidenced', { source: 'garbage', basis: 'claimed' });
    const r = enforce(c);
    expect(r.criteria[0]).toEqual(c);
    expect(r.notes).toEqual([]);
  });

  it.each(['', '   ', undefined])('no source (%j) counts as invalid and says so', (source) => {
    const r = enforce(crit('mh1', 'strong', { source: source as never }));
    expect(r.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'none', source: '' });
    expect(r.notes[0]).toMatch(/no source cited/);
  });

  it('the answer is a valid source only when the candidate wrote one', () => {
    const none = enforce(crit('mh1', 'partial', { source: 'answer', basis: 'claimed' }), ctx([acq()], '   '));
    expect(none.criteria[0]).toMatchObject({ verdict: 'not_evidenced', basis: 'none', source: '' });
    const some = enforce(crit('mh1', 'partial', { source: 'answer', basis: 'claimed' }), ctx([acq()], 'Ran 6 campaigns'));
    expect(some.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'claimed', source: 'answer' });
  });

  it('accepts "Answer" in any case', () => {
    expect(enforce(crit('mh1', 'partial', { source: 'ANSWER', basis: 'claimed' })).criteria[0].source).toBe('answer');
  });

  it.each(['inaccessible', 'failed', 'unreviewable'])('citing an item whose outcome was %s is citing something the reviewer never saw', (outcome) => {
    const r = enforce(crit('mh3', 'strong', { source: 'L1' }), ctx([acq({ outcome })]));
    expect(r.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'none', source: '' });
  });

  it.each(['ok', 'partial'])('an item with outcome %s is citable', (outcome) => {
    expect(enforce(crit('mh3', 'strong', { source: 'L1' }), ctx([acq({ outcome })])).criteria[0].verdict).toBe('strong');
  });

  it('with several items, picks the cited one', () => {
    const items = [acq({ ref: 'L1' }), acq({ ref: 'L2', basis: 'metadata' })];
    expect(enforce(crit('mh3', 'strong', { source: 'L1' }), ctx(items)).criteria[0].verdict).toBe('strong');
    expect(enforce(crit('mh3', 'strong', { source: 'L2' }), ctx(items)).criteria[0].verdict).toBe('partial');
  });

  it('an empty acquired list leaves only the answer to cite', () => {
    expect(enforce(crit('mh3', 'strong', { source: 'L1' }), ctx([])).criteria[0].verdict).toBe('partial');
  });
});

describe('enforceEvidenceRules — rule 2: the candidate\'s own word is only a claim', () => {
  it('citing the answer makes the basis claimed and lowers strong to partial', () => {
    const r = enforce(crit('mh3', 'strong', { source: 'answer', basis: 'seen' }));
    expect(r.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'claimed', source: 'answer' });
    expect(r.notes[0]).toMatch(/stated by the candidate/);
  });

  it('a partial from the answer stays partial, but the basis is corrected and noted', () => {
    const r = enforce(crit('mh3', 'partial', { source: 'answer', basis: 'read' }));
    expect(r.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'claimed' });
    expect(r.notes).toHaveLength(1);
  });

  it('a partial already marked claimed needs no correction and no note', () => {
    const r = enforce(crit('mh3', 'partial', { source: 'answer', basis: 'claimed' }));
    expect(r.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'claimed' });
    expect(r.notes).toEqual([]);
  });

  it('basis claimed on a real artifact also lowers strong to partial', () => {
    const r = enforce(crit('mh1', 'strong', { source: 'L1', basis: 'claimed' }));
    expect(r.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'claimed', source: 'L1' });
  });

  it('a concern resting on the candidate\'s own statement is not a concern (rule 6 follows rule 2)', () => {
    const r = enforce(crit('eq_ownership', 'concern', { source: 'answer', basis: 'claimed' }));
    expect(r.criteria[0].verdict).toBe('not_evidenced');
    expect(r.notes.join(' ')).toMatch(/concern needs something seen or read/);
  });
});

describe('enforceEvidenceRules — rule 3: metadata is not the work', () => {
  const meta = ctx([acq({ basis: 'metadata' })]);
  it('lowers strong to partial when the cited item showed only metadata', () => {
    const r = enforce(crit('mh6', 'strong'), meta);
    expect(r.criteria[0].verdict).toBe('partial');
    expect(r.notes[0]).toMatch(/only metadata of L1/);
  });
  it('leaves partial alone', () => {
    expect(enforce(crit('mh6', 'partial'), meta).criteria[0].verdict).toBe('partial');
    expect(enforce(crit('mh6', 'partial'), meta).notes).toEqual([]);
  });
  it('does not touch a concern', () => {
    expect(enforce(crit('eq_craft', 'concern'), meta).criteria[0].verdict).toBe('concern');
  });
  it('does not touch strong evidence from a real artifact', () => {
    expect(enforce(crit('mh6', 'strong'), ctx([acq({ basis: 'artifact' })])).criteria[0].verdict).toBe('strong');
  });
});

describe('enforceEvidenceRules — rule 4: a video that was not watched cannot show craft', () => {
  const videoCtx = (platform: string) => ctx([acq({ link: { platform } })]);

  it.each(['youtube', 'vimeo', 'loom', 'video_file'].flatMap(p => ['mh4', 'mh5', 'eq_craft', 'eq_coherence'].map(id => [p, id])))(
    'a strong %s verdict on %s becomes partial', (platform, id) => {
      const r = enforce(crit(id, 'strong'), videoCtx(platform));
      expect(r.criteria[0].verdict).toBe('partial');
      expect(r.notes[0]).toMatch(/video that was not watched/);
    });

  it.each(['mh1', 'mh3', 'mh6', 'eq_ownership', 'eq_outcomes', 'eq_recency'])('does not cap %s on a video link', (id) => {
    expect(enforce(crit(id, 'strong'), videoCtx('youtube')).criteria[0].verdict).toBe('strong');
  });

  it.each(['custom', 'pdf_file', 'gdrive_file', 'behance', 'image_file'])('does not cap craft on a %s link', (platform) => {
    expect(enforce(crit('eq_craft', 'strong'), videoCtx(platform)).criteria[0].verdict).toBe('strong');
  });

  it('leaves partial and concern on video craft as they are', () => {
    expect(enforce(crit('eq_craft', 'partial'), videoCtx('vimeo')).criteria[0].verdict).toBe('partial');
    expect(enforce(crit('eq_craft', 'concern'), videoCtx('vimeo')).criteria[0].verdict).toBe('concern');
  });

  it('a video item that is also metadata-only is lowered once, not twice', () => {
    const r = enforce(crit('mh5', 'strong'), ctx([acq({ basis: 'metadata', link: { platform: 'youtube' } })]));
    expect(r.criteria[0].verdict).toBe('partial');
    expect(r.notes).toHaveLength(1);
  });
});

describe('enforceEvidenceRules — rule 1: the source is a list', () => {
  const two = ctx([acq({ ref: 'L1' }), acq({ ref: 'L2', link: { platform: 'pdf_file' } })]);
  const cite = (source: string, x: EvidenceContext = two, over: Partial<CriterionResult> = {}) =>
    enforce(crit('mh3', 'strong', { source, ...over }), x);

  it.each(['L1, L2', 'L1,L2', 'L1 and L2', 'L1 AND l2', 'L1 + L2', 'L1+L2', 'L1/L2', 'L1; L2', 'L1 & L2', '[L1], [L2]', '(L1) and (L2)', 'L1, L2.', 'L1 (site) and L2 (deck)'])(
    '"%s" cites both L1 and L2: no downgrade, no note, canonical source "L1, L2"', (source) => {
      const r = cite(source);
      expect(r.criteria[0]).toMatchObject({ verdict: 'strong', basis: 'seen', source: 'L1, L2' });
      expect(r.notes).toEqual([]);
    });

  it.each([['[L1]', 'L1'], ['(L1)', 'L1'], ['L1.', 'L1'], ['L1 (site)', 'L1'], ['L1 site', 'L1'], ['L1:', 'L1'], ['"L1"', 'L1'], ['  l1  ', 'L1'], ['L2.', 'L2'], ['see L2 above', 'L2']])(
    '"%s" cites %s and keeps the verdict', (source, expected) => {
      const r = cite(source);
      expect(r.criteria[0]).toMatchObject({ verdict: 'strong', source: expected });
      expect(r.notes).toEqual([]);
    });

  it('a repeated ref is cited once', () => {
    expect(cite('L1, L1, l1').criteria[0].source).toBe('L1');
  });

  it('one valid ref is enough: an invalid one is dropped from the source with a note, and the verdict stays', () => {
    const r = cite('L1, L9');
    expect(r.criteria[0]).toMatchObject({ verdict: 'strong', source: 'L1' });
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^mh3: cited L9 not shown to the reviewer/);
  });

  it('with no valid ref the verdict goes down one step and the source is cleared', () => {
    const r = cite('L8, L9');
    expect(r.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'none', source: '' });
    expect(r.notes[0]).toMatch(/cited source "L8, L9" was not shown/);
  });

  it.each(['Link 1', 'L', 'L-1', 'first site', '1', 'L1x', 'LL1', 'the portfolio', '...'])('"%s" is not a ref', (source) => {
    const r = cite(source);
    expect(r.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'none', source: '' });
  });

  it('a non-string source counts as no source', () => {
    const r = cite(5 as never);
    expect(r.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'none', source: '' });
    expect(r.notes[0]).toMatch(/no source cited/);
  });

  it('a ref with a decimal part is a ref only when one was given, and L2.1 is not L2', () => {
    const withDecimal = ctx([acq({ ref: 'L2.1' })]);
    expect(cite('L2.1', withDecimal).criteria[0]).toMatchObject({ verdict: 'strong', source: 'L2.1' });
    expect(cite('L2', withDecimal).criteria[0].verdict).toBe('partial');
    expect(cite('L2.1', two).criteria[0].verdict).toBe('partial');
  });

  it('the answer in a list: kept next to an item that backs the claim, dropped when the candidate wrote none', () => {
    const both = cite('L1, answer');
    expect(both.criteria[0]).toMatchObject({ verdict: 'strong', basis: 'seen', source: 'L1, answer' });
    expect(both.notes).toEqual([]);
    const noAnswer = cite('answer and L1', ctx([acq()], '   '));
    expect(noAnswer.criteria[0]).toMatchObject({ verdict: 'strong', source: 'L1' });
    expect(noAnswer.notes[0]).toMatch(/cited answer not shown/);
  });

  it('only the answer cited is still a claim (strong becomes partial)', () => {
    const r = cite('answer', two, { basis: 'seen' });
    expect(r.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'claimed', source: 'answer' });
  });

  it('an item that never reached the model is dropped from a list; with none left the verdict goes down', () => {
    const items = [acq({ ref: 'L1' }), acq({ ref: 'L2', outcome: 'failed' })];
    const partlyShown = cite('L1, L2', ctx(items));
    expect(partlyShown.criteria[0]).toMatchObject({ verdict: 'strong', source: 'L1' });
    expect(partlyShown.notes[0]).toMatch(/cited L2 not shown/);
    const noneShown = cite('L2', ctx(items));
    expect(noneShown.criteria[0]).toMatchObject({ verdict: 'partial', source: '' });
  });

  it('the same results come from a criterion that went through normalizeMarketingCriteria (the source clip leaves room for every ref)', () => {
    const items = Array.from({ length: 8 }, (_, i) => acq({ ref: `L${i + 1}` }));
    const source = 'L1, L2, L3, L4, L5, L6, L7, L8';
    const norm = normalizeMarketingCriteria([{ id: 'mh3', verdict: 'strong', basis: 'seen', source }]);
    expect(norm.find(c => c.id === 'mh3')!.source).toBe(source);
    const r = enforceEvidenceRules(norm, ctx(items));
    expect(r.criteria.find(c => c.id === 'mh3')).toMatchObject({ verdict: 'strong', source });
  });
});

describe('enforceEvidenceRules — rules 3 and 4 with several cited items', () => {
  it('strong survives when ANY cited item is a real artifact; it is lowered only when every one is metadata', () => {
    const mixed = ctx([acq({ ref: 'L1' }), acq({ ref: 'L2', basis: 'metadata' })]);
    expect(enforce(crit('mh6', 'strong', { source: 'L1, L2' }), mixed).criteria[0].verdict).toBe('strong');
    const meta = ctx([acq({ ref: 'L1', basis: 'metadata' }), acq({ ref: 'L2', basis: 'metadata' })]);
    const r = enforce(crit('mh6', 'strong', { source: 'L1, L2' }), meta);
    expect(r.criteria[0].verdict).toBe('partial');
    expect(r.notes[0]).toMatch(/only metadata of L1, L2/);
  });

  it('video craft is capped only when every cited item is a video', () => {
    const mixed = ctx([acq({ ref: 'L1', link: { platform: 'pdf_file' } }), acq({ ref: 'L2', link: { platform: 'youtube' } })]);
    expect(enforce(crit('eq_craft', 'strong', { source: 'L1, L2' }), mixed).criteria[0].verdict).toBe('strong');
    const videos = ctx([acq({ ref: 'L1', link: { platform: 'vimeo' } }), acq({ ref: 'L2', link: { platform: 'youtube' } })]);
    const r = enforce(crit('eq_craft', 'strong', { source: 'L1, L2' }), videos);
    expect(r.criteria[0].verdict).toBe('partial');
    expect(r.notes[0]).toMatch(/L1, L2 are videos that were not watched/);
  });
});

describe('enforceEvidenceRules — rule 5: "seen" needs something that was shown as media', () => {
  const text = 'We grew the Instagram page from 12,000 to 48,000 followers in six months.';
  const textOnly = (over: Partial<Acq> = {}) => acq({ hasMedia: false, text, ...over });
  const seen = (evidence: string, verdict: CriterionVerdict = 'strong', over: Partial<CriterionResult> = {}) =>
    crit('mh3', verdict, { basis: 'seen', evidence, ...over });

  it('basis seen on a text-only item is treated as read, so an invented quote no longer slips through', () => {
    const r = enforce(seen('Cites "grew reach from 100K to 9 million in one month"'), ctx([textOnly()]));
    // lowered to not_evidenced: what was rejected (basis, source, the invented quote) is not kept beside it; the notes say why
    expect(r.criteria[0]).toMatchObject({ verdict: 'not_evidenced', basis: 'none', source: '', evidence: '' });
    expect(r.notes).toHaveLength(2);
    expect(r.notes[0]).toMatch(/L1 sent text only, so "seen" was treated as "read"/);
    expect(r.notes[1]).toMatch(/quoted text not found in L1/);
  });

  it('a real quote keeps the strong verdict, now labelled read', () => {
    const r = enforce(seen('Says "grew the Instagram page from 12,000 to 48,000"'), ctx([textOnly()]));
    expect(r.criteria[0]).toMatchObject({ verdict: 'strong', basis: 'read' });
    expect(r.notes).toHaveLength(1);
  });

  it('a strong "seen" on text with nothing quoted needs a quote, so it goes down one step', () => {
    const r = enforce(seen('Shows five campaigns with results'), ctx([textOnly()]));
    expect(r.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'read' });
    expect(r.notes[1]).toMatch(/strong needs a quote/);
  });

  it('a partial "seen" on text with nothing quoted is only relabelled', () => {
    const r = enforce(seen('Shows some campaigns', 'partial'), ctx([textOnly()]));
    expect(r.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'read' });
    expect(r.notes).toHaveLength(1);
  });

  it('an item that sent media (the default) keeps basis seen and is not quote-checked', () => {
    const r = enforce(seen('Headline reads "tripled our qualified leads in one quarter"'), ctx([acq({ text })]));
    expect(r.criteria[0]).toMatchObject({ verdict: 'strong', basis: 'seen' });
    expect(r.notes).toEqual([]);
    expect(enforce(seen('Headline reads "tripled our qualified leads in one quarter"'), ctx([acq({ text, hasMedia: true })])).criteria[0].verdict).toBe('strong');
  });

  it('a native document always counts as media, whatever hasMedia says', () => {
    const r = enforce(seen('Page 4 shows "tripled our qualified leads in one quarter"'), ctx([acq({ text, hasMedia: false, nativeDocument: true })]));
    expect(r.criteria[0]).toMatchObject({ verdict: 'strong', basis: 'seen' });
  });

  it('with several cited items "seen" stays as soon as one of them sent media, and is relabelled when none did', () => {
    const c = seen('Shows "tripled our qualified leads in one quarter"', 'strong', { source: 'L1, L2' });
    const oneWithMedia = ctx([textOnly({ ref: 'L1' }), acq({ ref: 'L2', text })]);
    expect(enforce(c, oneWithMedia).criteria[0]).toMatchObject({ verdict: 'strong', basis: 'seen' });
    const noneWithMedia = ctx([textOnly({ ref: 'L1' }), textOnly({ ref: 'L2' })]);
    expect(enforce(c, noneWithMedia).criteria[0]).toMatchObject({ verdict: 'not_evidenced', basis: 'none', source: '', evidence: '' });
  });

  it('basis read and claimed are not relabelled, and a metadata item is judged the same way', () => {
    expect(enforce(crit('mh3', 'partial', { basis: 'claimed' }), ctx([textOnly()])).criteria[0].basis).toBe('claimed');
    const r = enforce(crit('mh3', 'partial', { basis: 'read', evidence: '' }), ctx([textOnly()]));
    expect(r.notes).toEqual([]);
    const meta = enforce(seen('Bio says "led growth at two startups"', 'partial'), ctx([textOnly({ basis: 'metadata', text: 'Bio: led growth at two startups' })]));
    expect(meta.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'read' });
  });

  it('a concern seen on a text-only item stays a concern: it is read, which is a valid basis for one', () => {
    const r = enforce(crit('eq_ownership', 'concern', { basis: 'seen', evidence: 'Credits "Designed by Meera Rao"' }), ctx([textOnly({ text: 'Designed by Meera Rao' })]));
    expect(r.criteria[0]).toMatchObject({ verdict: 'concern', basis: 'read' });
  });
});

describe('enforceEvidenceRules — rule 6: absence of evidence is never a concern', () => {
  it.each(['seen', 'read'] as const)('a concern with basis %s is kept', (basis) => {
    const r = enforce(crit('eq_ownership', 'concern', { basis, evidence: 'Credits a named agency lead' }));
    expect(r.criteria[0].verdict).toBe('concern');
    expect(r.notes).toEqual([]);
  });

  it.each(['claimed', 'none'] as const)('a concern with basis %s and a real source becomes not_evidenced', (basis) => {
    const r = enforce(crit('eq_ownership', 'concern', { basis }));
    expect(r.criteria[0].verdict).toBe('not_evidenced');
    expect(r.notes[0]).toMatch(/^eq_ownership: a concern needs something seen or read/);
  });

  it('a concern with no basis at all becomes not_evidenced', () => {
    const r = enforce(crit('eq_ownership', 'concern', { basis: undefined }));
    expect(r.criteria[0].verdict).toBe('not_evidenced');
  });
});

describe('enforceEvidenceRules — rule 7: a source with basis none contradicts itself', () => {
  it.each([['strong', 'partial'], ['partial', 'not_evidenced']] as const)('a %s verdict with a real source but basis none goes down one step to %s', (from, to) => {
    const r = enforce(crit('mh3', from, { basis: 'none', source: 'L1' }));
    expect(r.criteria[0].verdict).toBe(to);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^mh3: L1 is cited but the basis is none/);
    expect(r.notes[0]).toMatch(new RegExp(`${from} lowered to ${to}`));
  });

  it('a fabricated quote with basis none and a real source is no longer trusted as strong (it used to pass)', () => {
    const r = enforce(crit('mh3', 'strong', { basis: 'none', source: 'L1', evidence: 'Cites "grew reach from 100K to 9 million in one month"' }), ctx([acq({ text: 'something else' })]));
    expect(r.criteria[0].verdict).toBe('partial');
  });

  it('a concern with basis none is the "no concern from silence" rule, not a second step', () => {
    const r = enforce(crit('eq_ownership', 'concern', { basis: 'none', source: 'L1' }));
    expect(r.criteria[0].verdict).toBe('not_evidenced');
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/a concern needs something seen or read/);
  });

  it('a basis that is not set at all (a hand-built criterion) is left as it is', () => {
    expect(enforce(crit('mh3', 'strong', { basis: undefined })).criteria[0].verdict).toBe('strong');
  });

  it('works through normalizeMarketingCriteria, where a missing or unknown basis becomes none', () => {
    const norm = normalizeMarketingCriteria([
      { id: 'mh3', verdict: 'strong', source: 'L1', evidence: 'looks great' },
      { id: 'mh4', verdict: 'strong', basis: 'observed', source: 'L1' },
      { id: 'mh5', verdict: 'strong', basis: 'seen', source: 'L1' },
    ]);
    const r = enforceEvidenceRules(norm, ctx());
    expect(r.criteria.find(c => c.id === 'mh3')!.verdict).toBe('partial');
    expect(r.criteria.find(c => c.id === 'mh4')!.verdict).toBe('partial');
    expect(r.criteria.find(c => c.id === 'mh5')!.verdict).toBe('strong');
  });
});

describe('enforceEvidenceRules — rule 8: a quote must be real, and strong text needs one', () => {
  // A realistic extraction: page markers, a word hyphenated across a line, typographic quotes and an apostrophe.
  const REVIEW_TEXT = [
    '[page 1]',
    'Water Wise 2024: we grew LinkedIn reach from 12,000 to 340,000 in six months.',
    `Our "brand-new" identity replaced the legacy look. The campaign${RSQ}s tagline was ${LSQ}Every drop counts${RSQ}.`,
    '[page 2]',
    'The market-',
    'ing team of four ran 6 campaigns. Results: 5.2% conversion vs. 1.8% baseline - a 2.9x lift.',
  ].join('\n');
  const withText = ctx([acq({ text: REVIEW_TEXT })]);
  const textCtx = (text: string, over: Partial<Acq> = {}) => ctx([acq({ text, ...over })]);
  const read = (evidence: string, verdict: CriterionVerdict = 'strong', over: Partial<CriterionResult> = {}) =>
    crit('mh3', verdict, { basis: 'read', evidence, ...over });
  const verdictOf = (evidence: string, verdict: CriterionVerdict = 'strong', x: EvidenceContext = withText) =>
    enforce(read(evidence, verdict), x).criteria[0].verdict;

  describe('found and not found', () => {
    it('keeps a verdict whose quote is in the cited text, with no note', () => {
      const r = enforce(read('Says "grew LinkedIn reach from 12,000 to 340,000"'), withText);
      expect(r.criteria[0].verdict).toBe('strong');
      expect(r.notes).toEqual([]);
    });

    it('an invented quote is a hallucination: the verdict becomes not_evidenced whatever it was', () => {
      for (const from of ['strong', 'partial', 'concern'] as const) {
        const r = enforce(read('Says "grew reach from 100K to 9 million in one month"', from), withText);
        expect(r.criteria[0].verdict, from).toBe('not_evidenced');
        expect(r.notes[0], from).toMatch(/quoted text not found in L1/);
        expect(r.notes[0], from).toMatch(new RegExp(`${from} lowered to not_evidenced`));
      }
    });

    it('one invented quote among real ones is enough', () => {
      expect(verdictOf('"grew LinkedIn reach" and "won an industry award"')).toBe('not_evidenced');
      expect(verdictOf('"grew LinkedIn reach" and "6 campaigns Results"')).toBe('strong');
    });

    it('an item with no text cannot back a quoted "read"', () => {
      expect(verdictOf('"launched in March across four cities"', 'strong', textCtx(''))).toBe('not_evidenced');
      expect(verdictOf('"launched in March across four cities"', 'strong', textCtx(undefined as never))).toBe('not_evidenced');
    });

    it('matches whole words only: a quote cannot ride on a longer word', () => {
      const text = textCtx('The team will relaunch in march across four cities');
      // "launch" is not "relaunch", also when the quote is run together: not verbatim, so at most a near match (3 of its 4 words), held at partial
      const r = enforce(read('"launch in march across"'), text);
      expect(r.criteria[0].verdict).toBe('partial');
      expect(r.notes[0]).toMatch(/near match/);
      // with less of the quote in the text there is nothing left of it
      expect(verdictOf('"launch in march across"', 'strong', textCtx('The team will relaunch in april around four cities'))).toBe('not_evidenced');
    });

    it('checks each part of a quote that uses an ellipsis, in any of its three spellings', () => {
      expect(verdictOf('"grew LinkedIn reach ... in six months"')).toBe('strong');
      expect(verdictOf(`"grew LinkedIn reach ${ELLIPSIS} in six months"`)).toBe('strong');
      expect(verdictOf('"grew LinkedIn reach [...] in six months"')).toBe('strong');
      expect(verdictOf(`"grew LinkedIn reach ${ELLIPSIS} doubled our revenue"`)).toBe('not_evidenced');
      expect(verdictOf('"grew LinkedIn reach ... doubled our revenue"')).toBe('not_evidenced');
    });
  });

  describe('what counts as a quote', () => {
    it('double quotes, straight and curly', () => {
      expect(verdictOf(`Says ${LDQ}conversion vs 1.8% baseline${RDQ}`)).toBe('strong');
      expect(verdictOf(`Says ${LDQ}tripled our qualified leads in one quarter${RDQ}`)).toBe('not_evidenced');
    });

    it('single quotes, straight and curly (3 or more words): a real one passes, an invented one is caught', () => {
      expect(verdictOf('Says \'grew LinkedIn reach from 12,000 to 340,000\'')).toBe('strong');
      expect(verdictOf('Says \'grew reach from 100K to 9 million in one month\'')).toBe('not_evidenced');
      expect(verdictOf(`Says ${LSQ}grew LinkedIn reach from 12,000 to 340,000${RSQ}`)).toBe('strong');
      expect(verdictOf(`Says ${LSQ}grew reach from 100K to 9 million in one month${RSQ}`)).toBe('not_evidenced');
    });

    it('an apostrophe never opens or ends a single-quoted quote', () => {
      // "campaign's" and "brand's" are not quote marks, so only 'Every drop counts' is a quote here, and it is real
      expect(verdictOf('Tagline \'Every drop counts\' sits in the campaign\'s materials and the brand\'s voice')).toBe('strong');
      expect(verdictOf(`Tagline ${LSQ}Every drop counts${RSQ} sits in the campaign${RSQ}s materials`)).toBe('strong');
      // an apostrophe INSIDE a quoted phrase does not cut it short: the whole phrase is checked
      expect(verdictOf('Says \'the campaign\'s tagline was Every drop counts\'')).toBe('strong');
      // one changed word of six is a near match (partial), a rewritten phrase is not there at all
      expect(verdictOf('Says \'the campaign\'s tagline was Every river counts\'')).toBe('partial');
      expect(verdictOf('Says \'the campaign\'s tagline was Rivers matter most\'')).toBe('not_evidenced');
      expect(verdictOf('The clients\' results: \'grew LinkedIn reach from 12,000 to 340,000\'')).toBe('strong');
    });

    it('an abbreviated year (\'24) never opens a single-quoted quote', () => {
      const x = textCtx('Q3 results show growth of 40% overall');
      expect(verdictOf('Q3 \'24 results show \'growth of 40%\' overall', 'strong', x)).toBe('strong');
      expect(verdictOf(`Q3 ${LSQ}24 results show ${LSQ}growth of 40%${RSQ} overall`, 'strong', x)).toBe('strong');
    });

    it('a quote of fewer than 3 words is not a quote: a partial with one is not checked, and a strong with only one needs a better quote', () => {
      expect(verdictOf('Calls it "Zero Boond"', 'partial')).toBe('partial');
      expect(verdictOf('Quotes "viral" and \'reach up\'', 'partial')).toBe('partial');
      const r = enforce(read('Calls it "Zero Boond"'), withText);
      expect(r.criteria[0].verdict).toBe('partial');
      expect(r.notes[0]).toMatch(/strong needs a quote/);
    });

    it('counts words, not punctuation, when deciding if a quote is long enough', () => {
      expect(verdictOf('"- - -"', 'partial')).toBe('partial');
      expect(verdictOf('"a, b, c"', 'partial')).toBe('not_evidenced');
    });

    it('an unterminated quote is not a quote', () => {
      expect(verdictOf('Says "tripled our qualified leads in one quarter', 'partial')).toBe('partial');
      expect(verdictOf('Says "tripled our qualified leads in one quarter')).toBe('partial');
    });
  });

  describe('strong text needs a quote (the quote is what can be checked)', () => {
    it('strong + read + no quote goes down one step, with a note', () => {
      const r = enforce(read('Grew the page a lot'), withText);
      expect(r.criteria[0].verdict).toBe('partial');
      expect(r.notes).toHaveLength(1);
      expect(r.notes[0]).toMatch(/^mh3: resting on text read but quoting none of it/);
    });

    it('a partial or a concern with no quote is left alone', () => {
      expect(verdictOf('Grew the page a lot', 'partial')).toBe('partial');
      expect(verdictOf('Credits another agency', 'concern')).toBe('concern');
    });

    it('does not apply to basis seen, claimed or an item that sent media', () => {
      expect(enforce(crit('mh3', 'strong', { basis: 'seen', evidence: 'looks great' }), withText).criteria[0].verdict).toBe('strong');
      expect(enforce(crit('mh3', 'strong', { basis: 'claimed', source: 'L1', evidence: 'looks great' }), withText).criteria[0].verdict).toBe('partial');
    });

    it('a quote that passes leaves a strong verdict whole', () => {
      expect(enforce(read('Says "tagline was Every drop counts"'), withText).notes).toEqual([]);
    });
  });

  describe('the text is normalised the same way as the quote', () => {
    it('ignores case, punctuation, spacing and line breaks', () => {
      expect(verdictOf('"GREW   linkedin, reach --- from 12,000 to 340,000"')).toBe('strong');
      expect(verdictOf('"grew the Instagram page"')).toBe('not_evidenced');
      expect(verdictOf('"campaign went live in March"', 'strong', textCtx('the\ncampaign\n\nwent live\tin  March'))).toBe('strong');
    });

    it('treats a comma inside a number as no difference', () => {
      expect(verdictOf('"reach from 12000 to 340000 in six months"')).toBe('strong');
    });

    it('joins a word hyphenated across a line break (the quote has the whole word)', () => {
      expect(verdictOf('States "marketing team of four ran 6 campaigns"')).toBe('strong');
    });

    it('still finds a compound that was only broken at the line end (the quote keeps its hyphen)', () => {
      const x = textCtx('A well-\nknown brand relaunched with a new voice');
      expect(verdictOf('"a well-known brand relaunched"', 'strong', x)).toBe('strong');
      expect(verdictOf('"a wellknown brand relaunched"', 'strong', x)).toBe('strong');
    });

    it('a word the model ran together matches the text\'s own split ("well-known") on word boundaries only', () => {
      const x = textCtx('A well-known brand relaunched with a new voice');
      expect(verdictOf('"a wellknown brand relaunched"', 'strong', x)).toBe('strong');
      // it may not end inside a word of the text, and with only 2 of 4 words in order nothing is left of it
      expect(verdictOf('"a wellknown brand relaunch"', 'strong', x)).toBe('not_evidenced');
    });

    it('ignores the [page N], [slide N] and -- N of M -- markers the extractors insert, also inside a quote', () => {
      for (const marker of ['[page 2]', '[Page 2 of 9]', '[slide 12]', '-- 2 of 9 --', '--2 of 9--']) {
        const x = textCtx(`We grew the page\n\n${marker}\n\nfrom 12,000 to 48,000 followers`);
        expect(verdictOf('"grew the page from 12,000 to 48,000 followers"', 'strong', x), marker).toBe('strong');
      }
    });

    it('joins a word hyphenated across a page break', () => {
      const x = textCtx('The market-\n\n-- 2 of 3 --\n\ning team of four ran 6 campaigns');
      expect(verdictOf('"marketing team of four ran 6 campaigns"', 'strong', x)).toBe('strong');
    });

    it('ignores soft hyphens and zero-width characters inside words, on both sides', () => {
      const x = textCtx(`The mar${SOFT_HYPHEN}keting team of four ran cam${ZWSP}paigns`);
      expect(verdictOf('"marketing team of four ran campaigns"', 'strong', x)).toBe('strong');
      expect(verdictOf(`"mar${SOFT_HYPHEN}keting team of four"`, 'strong', textCtx('The marketing team of four ran campaigns'))).toBe('strong');
    });

    it('folds typography: dashes, curly apostrophes, compatibility characters', () => {
      expect(verdictOf(`"Q1${EN_DASH}Q3 reach grew 3x"`, 'strong', textCtx('Q1-Q3 reach grew 3x'))).toBe('strong');
      expect(verdictOf('"the campaign\'s tagline was"', 'strong', withText)).toBe('strong');
      expect(verdictOf('"first campaign delivered 4,200 leads"', 'strong', textCtx(`${FI_LIGATURE}rst campaign delivered 4,200 leads`))).toBe('strong');
    });

    it('keeps words in scripts with combining marks intact (Devanagari)', () => {
      const hindi = 'हर बूंद कीमती है अभियान 2024';
      expect(verdictOf('"हर बूंद कीमती है"', 'strong', textCtx(hindi))).toBe('strong');
      expect(verdictOf('"हर नदी कीमती है"', 'strong', textCtx(hindi))).toBe('partial');   // one word of four changed: a near match
      expect(verdictOf('"हर नदी साफ रखो"', 'strong', textCtx(hindi))).toBe('not_evidenced');
    });

    it('stays fast on hostile text: long runs of dashes, whitespace, line breaks, brackets and half markers', () => {
      const evil = [
        `a-${'\n'.repeat(150_000)}!`, '-'.repeat(300_000), `${' '.repeat(300_000)}x`, '['.repeat(100_000),
        '[page '.repeat(50_000), '-- 1 of '.repeat(50_000), 'a-\n'.repeat(100_000), `${'a- \n'.repeat(60_000)}!`,
      ];
      const t0 = Date.now();
      for (const text of evil) verdictOf('"the quick brown fox"', 'strong', textCtx(text));
      expect(Date.now() - t0).toBeLessThan(4000);
    });
  });

  describe('quotes that cannot be checked', () => {
    const evidence = 'Page 18 states "campaign delivered 4,200 qualified leads in Q3"';
    const native = (over: Partial<Acq> = {}) => acq({ nativeDocument: true, link: { platform: 'pdf_file' }, text: 'filler words about nothing '.repeat(40), ...over });

    it('is skipped for a native document whose extracted text was truncated: the words may be on a page we cannot search', () => {
      const r = enforce(read(evidence), ctx([native({ textTruncated: true })]));
      expect(r.criteria[0].verdict).toBe('strong');
      expect(r.notes).toEqual([]);
    });

    it('is skipped for a native document with no extracted text (an image-only PDF)', () => {
      expect(verdictOf(evidence, 'strong', ctx([native({ text: '' })]))).toBe('strong');
      expect(verdictOf(evidence, 'strong', ctx([native({ text: '[page 1]\n\n-- 1 of 1 --\n' })]))).toBe('strong');
    });

    it('is not skipped for a native document whose full text we do have', () => {
      expect(verdictOf(evidence, 'strong', ctx([native()]))).toBe('not_evidenced');
    });

    it('is not skipped for an item that is not a native document, truncated or not: the model saw only that text', () => {
      expect(verdictOf(evidence, 'strong', ctx([acq({ text: 'filler words', textTruncated: true })]))).toBe('not_evidenced');
      expect(verdictOf(evidence, 'strong', ctx([acq({ text: '' })]))).toBe('not_evidenced');
    });

    it('does not excuse a strong verdict that quotes nothing', () => {
      expect(verdictOf('Page 18 shows great results', 'strong', ctx([native({ textTruncated: true })]))).toBe('partial');
    });

    it('with several cited items, a quote that is nowhere in the readable ones is forgiven while any cited item is an unverifiable document', () => {
      const site = acq({ ref: 'L1', text: 'a page about something else' });
      const deck = native({ ref: 'L2', textTruncated: true });
      const c = read(evidence, 'strong', { source: 'L1, L2' });
      expect(enforce(c, ctx([site, deck])).criteria[0].verdict).toBe('strong');
      expect(enforce({ ...c, source: 'L1' }, ctx([site, deck])).criteria[0].verdict).toBe('not_evidenced');
    });
  });

  describe('several sources', () => {
    const items = [acq({ ref: 'L1', text: 'nothing relevant here' }), acq({ ref: 'L2', text: REVIEW_TEXT }), acq({ ref: 'L3', text: 'We won the award for best water campaign of the year' })];
    const cited = (source: string, evidence: string) => enforce(read(evidence, 'strong', { source }), ctx(items)).criteria[0].verdict;

    it('passes when the quote is in ANY cited item\'s text', () => {
      expect(cited('L1, L2', '"grew LinkedIn reach from 12,000"')).toBe('strong');
      expect(cited('L2 and L3', '"best water campaign of the year"')).toBe('strong');
    });

    it('checks only the cited items: a quote that is in an uncited item, or in none, is invented', () => {
      expect(cited('L1', '"grew LinkedIn reach from 12,000"')).toBe('not_evidenced');
      expect(cited('L1, L3', '"grew LinkedIn reach from 12,000"')).toBe('not_evidenced');
      expect(cited('L1, L2', '"won an industry award in Cannes"')).toBe('not_evidenced');
    });

    it('with several quotes, each one has to be in some cited item', () => {
      expect(cited('L2, L3', '"grew LinkedIn reach" and "best water campaign"')).toBe('strong');
      expect(cited('L2', '"grew LinkedIn reach" and "best water campaign"')).toBe('not_evidenced');
    });

    it('the candidate\'s answer is searched when it is cited next to an item', () => {
      const x = ctx([acq({ text: 'a page about something else' })], 'I grew the newsletter from 1,200 to 9,800 subscribers');
      const c = read('Says "grew the newsletter from 1,200 to 9,800"', 'strong', { source: 'L1, answer' });
      expect(enforce(c, x).criteria[0]).toMatchObject({ verdict: 'strong', source: 'L1, answer' });
      expect(enforce({ ...c, source: 'L1' }, x).criteria[0].verdict).toBe('not_evidenced');
    });
  });
});

describe('enforceEvidenceRules — the adversarial review\'s reproductions (findings 1.5 and 1.6)', () => {
  const TEXT = '[page 1]\nWater Wise 2024: we grew LinkedIn reach from 12,000 to 340,000 in six months.\n[page 2]\nThe market-\ning team of four ran 6 campaigns.';
  const text = ctx([acq({ text: TEXT })]);
  const fabricated = 'grew reach from 100K to 9 million in one month';
  type Row = [string, Partial<CriterionResult>, EvidenceContext, CriterionVerdict];
  const rows: Row[] = [
    // 1.5: fabricated evidence used to stay strong or lose only one step
    ['fabricated quote, basis read (was partial)', { basis: 'read', evidence: `Cites "${fabricated}"` }, text, 'not_evidenced'],
    ['fabricated quote, basis seen on a text-only item (was strong)', { basis: 'seen', evidence: `Cites "${fabricated}"` }, ctx([acq({ text: TEXT, hasMedia: false })]), 'not_evidenced'],
    ['fabricated quote, basis none with a real source (was strong)', { basis: 'none', evidence: `Cites "${fabricated}"` }, text, 'partial'],
    ['paraphrase with no quotation marks, basis read (was strong)', { basis: 'read', evidence: 'Grew reach from 100K to 9 million in one month' }, text, 'partial'],
    ['fabricated quote in single quotes (was strong)', { basis: 'read', evidence: `Cites '${fabricated}'` }, text, 'not_evidenced'],
    ['fabricated quote in curly single quotes (was strong)', { basis: 'read', evidence: `Cites ${LSQ}${fabricated}${RSQ}` }, text, 'not_evidenced'],
    // 1.6: correct evidence used to be marked down
    ['hyphenated PDF line break (was partial)', { basis: 'read', evidence: 'States "marketing team of four ran 6 campaigns"' }, text, 'strong'],
    ['quote across a page marker (was partial)', { basis: 'read', evidence: 'Says "in six months The marketing team of four"' }, text, 'strong'],
    ...['L1, L2', 'L1 and L2', 'L1+L2', '[L1]', 'L1.', 'L1 (site)'].map((source): Row => [`source "${source}" (was partial)`, { basis: 'seen', source, evidence: 'five campaigns across the work' }, ctx([acq({ ref: 'L1' }), acq({ ref: 'L2' })]), 'strong']),
    ['native PDF, quote past the 12,000-character text cut (was partial)', { basis: 'read', evidence: 'Page 18 states "campaign delivered 4,200 qualified leads in Q3"' },
      ctx([acq({ nativeDocument: true, textTruncated: true, text: 'filler words about nothing '.repeat(400), link: { platform: 'pdf_file' } })]), 'strong'],
    ['image-only PDF with no extracted text, basis read (was partial)', { basis: 'read', evidence: 'Slide 4: "delivered 4,200 qualified leads in Q3"' },
      ctx([acq({ nativeDocument: true, text: '', link: { platform: 'pdf_file' } })]), 'strong'],
  ];

  it.each(rows)('%s', (_name, over, x, expected) => {
    expect(enforce(crit('mh3', 'strong', { source: 'L1', ...over }), x).criteria[0].verdict).toBe(expected);
  });
});

describe('enforceEvidenceRules — order and interaction', () => {
  it('metadata (rule 3) then a fabricated quote (rule 5): strong -> partial -> not_evidenced', () => {
    const c = crit('mh3', 'strong', { basis: 'read', evidence: 'Says "tripled our qualified leads in one quarter"' });
    const r = enforce(c, ctx([acq({ basis: 'metadata', text: 'some other words entirely' })]));
    expect(r.criteria[0].verdict).toBe('not_evidenced');
    expect(r.notes).toHaveLength(2);
    expect(r.notes[0]).toMatch(/only metadata/);
    expect(r.notes[1]).toMatch(/quoted text not found/);
  });

  it('claimed (rule 2) then a fabricated quote cannot apply: basis is no longer read', () => {
    const c = crit('mh3', 'strong', { basis: 'claimed', evidence: 'Says "tripled our qualified leads in one quarter"' });
    const r = enforce(c, ctx([acq({ text: 'unrelated' })]));
    expect(r.criteria[0].verdict).toBe('partial');
    expect(r.notes).toHaveLength(1);
  });

  it('an invalid source stops the other rules: one step down, never two', () => {
    const c = crit('eq_craft', 'strong', { source: 'L7', basis: 'read', evidence: '"words that appear nowhere at all"' });
    const r = enforce(c, ctx([acq({ link: { platform: 'youtube' }, basis: 'metadata' })]));
    expect(r.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'none', source: '' });
    expect(r.notes).toHaveLength(1);
  });

  it('video craft (rule 4) then a fabricated quote (rule 5): strong -> partial -> not_evidenced', () => {
    const c = crit('eq_craft', 'strong', { basis: 'read', evidence: '"words that appear nowhere at all"' });
    const r = enforce(c, ctx([acq({ link: { platform: 'vimeo' }, text: 'a title and a description' })]));
    expect(r.criteria[0].verdict).toBe('not_evidenced');
    expect(r.notes).toHaveLength(2);
  });

  it('keeps notes in criterion order, each prefixed with its criterion id', () => {
    const r = enforceEvidenceRules([
      crit('mh1', 'strong', { source: 'L5' }), crit('mh2', 'strong'), crit('mh3', 'strong', { source: 'answer' }),
    ], ctx());
    expect(r.notes.map(n => n.split(':')[0])).toEqual(['mh1', 'mh3']);
  });

  it('does not mutate its input and returns new objects, preserving every other field', () => {
    const c = crit('mh3', 'strong', { source: 'L9', evidence: 'kept as written' });
    const snapshot = JSON.parse(JSON.stringify(c));
    const r = enforce(c);
    expect(c).toEqual(snapshot);
    expect(r.criteria[0]).not.toBe(c);
    expect(r.criteria[0]).toMatchObject({ id: 'mh3', label: c.label, evidence: 'kept as written', group: 'direct', weight: 1.5, assessable: true });
  });

  it('is idempotent: enforcing already-enforced criteria changes nothing more', () => {
    const base = ctx([acq({ basis: 'metadata', text: 'x' })]);
    const once = enforceEvidenceRules([crit('mh3', 'strong'), crit('mh4', 'concern', { basis: 'claimed' }), crit('mh5', 'partial', { source: 'zz' })], base);
    const twice = enforceEvidenceRules(once.criteria, base);
    expect(twice.criteria).toEqual(once.criteria);
    expect(twice.notes).toEqual([]);
  });

  it('works on a whole normalised criteria list and on nice-to-haves', () => {
    const norm = normalizeMarketingCriteria([{ id: 'mh3', verdict: 'strong', basis: 'seen', source: 'L1' }, { id: 'mh1', verdict: 'strong', basis: 'seen', source: 'L8' }]);
    const r = enforceEvidenceRules(norm, ctx());
    expect(r.criteria).toHaveLength(15);
    expect(r.criteria.find(c => c.id === 'mh3')!.verdict).toBe('strong');
    expect(r.criteria.find(c => c.id === 'mh1')!.verdict).toBe('partial');
    const nice = enforceEvidenceRules(normalizeNiceToHaves([{ id: 'nh3', verdict: 'strong', basis: 'seen', source: 'L1' }, { id: 'nh4', verdict: 'strong', basis: 'seen', source: 'L3' }]), ctx());
    expect(nice.criteria.find(c => c.id === 'nh3')!.verdict).toBe('strong');
    expect(nice.criteria.find(c => c.id === 'nh4')!.verdict).toBe('partial');
  });

  it('an empty criteria list is fine', () => {
    expect(enforceEvidenceRules([], ctx())).toEqual({ criteria: [], notes: [] });
  });
});

// ─── Scores ──────────────────────────────────────────────────────────────────
describe('weightedChecklistScore', () => {
  const all = (verdict: CriterionVerdict) => MARKETING_CRITERIA.map(c => crit(c.id, verdict));

  it('is 10 when everything is strong and 0 when everything is a concern', () => {
    expect(weightedChecklistScore(all('strong'))).toBe(10);
    expect(weightedChecklistScore(all('concern'))).toBe(0);
  });

  it('is 2 when nothing is evidenced: the five corroboration criteria and eq_ownership leave, the rest count as 0.2', () => {
    expect(weightedChecklistScore(all('not_evidenced'))).toBe(2);
  });

  it('is 6 when everything is partial', () => {
    expect(weightedChecklistScore(all('partial'))).toBe(6);
  });

  it.each([['strong', 10], ['partial', 6], ['not_evidenced', 2], ['concern', 0]] as const)(
    'a single %s direct criterion scores %s (the designer review\'s verdict values)', (verdict, expected) => {
      expect(weightedChecklistScore([crit('mh1', verdict)])).toBe(expected);
    });

  it('weights the mean: a worked example', () => {
    const v: Record<string, CriterionVerdict> = {
      mh1: 'strong', mh3: 'partial', mh4: 'not_evidenced', mh5: 'strong', mh6: 'partial',
      eq_ownership: 'strong', eq_outcomes: 'partial', eq_craft: 'strong', eq_coherence: 'not_evidenced', eq_recency: 'strong',
      mh2: 'strong', mh7: 'not_evidenced', mh8: 'partial', mh9: 'not_evidenced', mh10: 'not_evidenced',
    };
    // numerator 72.5 over a denominator of 9.75 (of the corroboration criteria only the strong mh2 counts): 7.44 -> 7
    expect(weightedChecklistScore(MARKETING_CRITERIA.map(c => crit(c.id, v[c.id])))).toBe(7);
  });

  it('a corroboration criterion counts only when strong: not_evidenced, partial and concern ones all leave the denominator', () => {
    const base = [crit('mh1', 'strong'), crit('mh3', 'strong')];
    for (const verdict of ['not_evidenced', 'partial', 'concern'] as const) {
      expect(weightedChecklistScore([...base, crit('mh2', verdict)]), verdict).toBe(10);
    }
    expect(weightedChecklistScore([...base, crit('mh2', 'strong')])).toBe(10);
    // with a weaker rest, strong ones count at their 0.5 each: (6 * 2.5 + 10 * 1.5) / 4 = 7.5 -> 8
    const weaker = [crit('mh1', 'partial'), crit('mh3', 'partial')];
    expect(weightedChecklistScore(weaker)).toBe(6);
    expect(weightedChecklistScore([...weaker, crit('mh2', 'strong'), crit('mh7', 'strong'), crit('mh8', 'strong')])).toBe(Math.round((6 * 2.5 + 10 * 1.5) / 4));
  });

  it('a not_evidenced direct or quality criterion stays in as 0.2', () => {
    expect(weightedChecklistScore([crit('mh1', 'strong'), crit('mh4', 'not_evidenced')])).toBe(Math.round((10 + 2) / 2));   // 6
    expect(weightedChecklistScore([crit('mh1', 'strong'), crit('eq_craft', 'not_evidenced')])).toBe(Math.round((10 + 2) / 2));
    expect(weightedChecklistScore([crit('mh3', 'strong'), crit('mh4', 'not_evidenced')])).toBe(Math.round((15 + 2) / 2.5));   // 6.8 -> 7
  });

  it('leaves out criteria marked assessable=false, whatever their group or verdict', () => {
    expect(weightedChecklistScore([crit('mh1', 'strong'), crit('mh3', 'concern', { assessable: false })])).toBe(10);
    expect(weightedChecklistScore([crit('mh1', 'strong'), crit('eq_craft', 'not_evidenced', { assessable: false })])).toBe(10);
    expect(weightedChecklistScore([crit('mh1', 'concern'), crit('mh2', 'strong', { assessable: false })])).toBe(0);
  });

  it('an empty denominator is 0: no criteria, only absent corroboration, or nothing assessable', () => {
    expect(weightedChecklistScore([])).toBe(0);
    expect(weightedChecklistScore(['mh2', 'mh7', 'mh8', 'mh9', 'mh10'].map(id => crit(id, 'not_evidenced')))).toBe(0);
    expect(weightedChecklistScore([crit('mh1', 'strong', { assessable: false })])).toBe(0);
  });

  it('rounds a .5 up (half-way cases are exact, not float noise)', () => {
    const unit = (id: string, verdict: CriterionVerdict) => ({ id, label: id, verdict, evidence: '', group: 'direct' as const, weight: 1 });
    // (10 + 6 + 2 + 0) / 4 = 4.5 -> 5
    expect(weightedChecklistScore([unit('a', 'strong'), unit('b', 'partial'), unit('c', 'not_evidenced'), unit('d', 'concern')])).toBe(5);
    // (10 + 6 + 6 + 6) / 4 = 7 exactly -> 7; (10 + 10 + 10 + 6) / 4 = 9
    expect(weightedChecklistScore([unit('a', 'strong'), unit('b', 'partial'), unit('c', 'partial'), unit('d', 'partial')])).toBe(7);
    expect(weightedChecklistScore([unit('a', 'strong'), unit('b', 'strong'), unit('c', 'strong'), unit('d', 'partial')])).toBe(9);
  });

  it('falls back to the definition\'s weight and group when the criterion carries none', () => {
    const bare = (id: string, verdict: CriterionVerdict) => ({ id, label: id, verdict, evidence: '' });
    // mh3 (1.5, strong) + mh4 (1.0, concern): (15 + 0) / 2.5 = 6; mh2 not_evidenced leaves by its definition's group
    expect(weightedChecklistScore([bare('mh3', 'strong'), bare('mh4', 'concern'), bare('mh2', 'not_evidenced')])).toBe(6);
    // mh1 has weight 1.0 in the definition: (10 + 0) / 2 = 5
    expect(weightedChecklistScore([bare('mh1', 'strong'), bare('mh4', 'concern')])).toBe(5);
  });

  it('uses weight 1 for a criterion it does not know, and ignores an unusable weight', () => {
    const unknown = { id: 'zzz', label: 'zzz', verdict: 'strong' as const, evidence: '' };
    expect(weightedChecklistScore([unknown, crit('mh4', 'concern')])).toBe(5);            // (10 + 0) / 2
    expect(weightedChecklistScore([crit('mh3', 'strong', { weight: Number.NaN }), crit('mh4', 'concern')])).toBe(6);   // mh3 falls back to 1.5
    expect(weightedChecklistScore([crit('mh3', 'strong', { weight: -3 }), crit('mh4', 'concern')])).toBe(6);
    expect(weightedChecklistScore([crit('mh3', 'strong', { weight: 0 }), crit('mh4', 'concern')])).toBe(6);
  });

  it('reads an unrecognised verdict as not_evidenced rather than producing NaN', () => {
    expect(weightedChecklistScore([crit('mh1', 'amazing' as never)])).toBe(2);
  });

  it('a heavier criterion moves the score more than a lighter one', () => {
    const heavy = weightedChecklistScore([crit('mh3', 'strong'), crit('mh4', 'concern')]);   // 1.5 vs 1.0
    const light = weightedChecklistScore([crit('mh3', 'concern'), crit('mh4', 'strong')]);
    expect(heavy).toBeGreaterThan(light);
  });
});

describe('niceToHaveBonus', () => {
  const nice = (strongCount: number, verdict: CriterionVerdict = 'strong') =>
    NH_IDS.map((id, i) => crit(id, i < strongCount ? verdict : 'not_evidenced'));

  it.each([[0, 0], [1, 0.25], [2, 0.5], [3, 0.75], [4, 1]])('%s strong nice-to-haves give +%s', (n, bonus) => {
    expect(niceToHaveBonus(nice(n))).toBe(bonus);
  });

  it.each([5, 7, 10])('never goes above +1 (%s strong)', (n) => {
    expect(niceToHaveBonus(nice(n))).toBe(1);
  });

  it('counts only strong: partial and concern earn nothing', () => {
    expect(niceToHaveBonus(nice(10, 'partial'))).toBe(0);
    expect(niceToHaveBonus(nice(10, 'concern'))).toBe(0);
  });

  it('counts a repeated id once, and skips a criterion marked assessable=false', () => {
    expect(niceToHaveBonus([crit('nh1', 'strong'), crit('nh1', 'strong'), crit('nh1', 'strong')])).toBe(0.25);
    expect(niceToHaveBonus([crit('nh1', 'strong', { assessable: false }), crit('nh2', 'strong')])).toBe(0.25);
  });

  it('is 0 for an empty list', () => {
    expect(niceToHaveBonus([])).toBe(0);
  });
});

describe('marketingScore', () => {
  it.each([
    [8, 4, 0, 6], [8, 4, 0.25, 6], [8, 4, 0.5, 7], [8, 4, 0.75, 7], [8, 4, 1, 7],
    [10, 10, 0, 10], [10, 10, 1, 10], [9, 10, 1, 10],
    // no bonus under a blend of 6 (a tie-breaker between good portfolios), so these two stay where the plain blend puts them
    [0, 0, 0, 0], [0, 0, 0.25, 0], [0, 0, 1, 0], [5, 5, 0.5, 5],
  ])('model %s, checklist %s, bonus %s -> %s', (model, checklist, bonus, expected) => {
    expect(marketingScore(model, checklist, bonus)).toBe(expected);
  });

  it('rounds once: the unrounded blend plus the bonus (the designer review\'s blend rounds first, this one does not)', () => {
    // blend(7, 6) = round(6.5) = 7, so adding 0.5 afterwards would have made 8; one rounding gives 6.5 + 0.5 = 7
    expect(blendPortfolioScore(7, 6)).toBe(7);
    expect(marketingScore(7, 6, 0)).toBe(7);
    expect(marketingScore(7, 6, 0.25)).toBe(7);
    expect(marketingScore(7, 6, 0.5)).toBe(7);
    expect(marketingScore(7, 6, 0.75)).toBe(7);
    expect(marketingScore(7, 6, 1)).toBe(8);
  });

  it('treats a non-number model score as 0 and clamps out-of-range inputs', () => {
    // a model score of 0 holds the result to 1 (never more than one point above the model's own judgement)
    expect(marketingScore(Number.NaN, 6, 0)).toBe(1);
    expect(marketingScore(99, 99, 0)).toBe(10);
    expect(marketingScore(-5, -5, 0)).toBe(0);
  });

  it('a bonus can never be negative, beyond +1, or not a number', () => {
    expect(marketingScore(6, 6, -3)).toBe(6);
    expect(marketingScore(6, 6, 5)).toBe(7);
    expect(marketingScore(6, 6, Number.NaN)).toBe(6);
    expect(marketingScore(6, 6, Number.POSITIVE_INFINITY)).toBe(6);
  });
});

describe('applyMarketingCaps', () => {
  it('changes nothing and lists nothing when no cap applies', () => {
    expect(applyMarketingCaps(9, capInput())).toEqual({ score: 9, caps: [] });
  });

  it('metadata-only evidence caps at 5, with the contract\'s wording', () => {
    expect(applyMarketingCaps(8, capInput({ metadataOnly: true }))).toEqual({ score: 5, caps: ['Metadata-only evidence: capped at 5'] });
  });

  it('exactly one thin artifact caps at 6', () => {
    const r = applyMarketingCaps(8, capInput({ reviewedArtifacts: 1, thinArtifact: true }));
    expect(r.score).toBe(6);
    expect(r.caps).toEqual(['One thin work sample reviewed: capped at 6']);
  });

  it.each([0, 2, 3, 8])('a thin artifact caps whatever the number of reviewed artifacts (%s): the caller decides what is thin', (n) => {
    expect(applyMarketingCaps(8, capInput({ reviewedArtifacts: n, thinArtifact: true }))).toEqual({ score: 6, caps: ['One thin work sample reviewed: capped at 6'] });
  });

  it('one artifact that is not thin is not capped', () => {
    expect(applyMarketingCaps(9, capInput({ reviewedArtifacts: 1, thinArtifact: false }))).toEqual({ score: 9, caps: [] });
  });

  it('an ownership concern caps at 3', () => {
    const r = applyMarketingCaps(8, capInput({ ownershipVerdict: 'concern' }));
    expect(r.score).toBe(3);
    expect(r.caps).toHaveLength(1);
    expect(r.caps[0]).toMatch(/capped at 3$/);
  });

  it.each(['strong', 'partial', 'not_evidenced'] as const)('an ownership verdict of %s is not a cap', (ownershipVerdict) => {
    expect(applyMarketingCaps(9, capInput({ ownershipVerdict }))).toEqual({ score: 9, caps: [] });
  });

  it('work credited to someone else caps at 2', () => {
    expect(applyMarketingCaps(8, capInput({ creditedToOther: true }))).toEqual({ score: 2, caps: ['Work credited to someone else: capped at 2'] });
  });

  it('returns the lowest applicable cap and lists every cap that lowered the score on the way', () => {
    const all = applyMarketingCaps(9, capInput({ reviewedArtifacts: 1, thinArtifact: true, metadataOnly: true, ownershipVerdict: 'concern', creditedToOther: true }));
    expect(all.score).toBe(2);
    expect(all.caps).toHaveLength(4);
    const metaAndOwner = applyMarketingCaps(8, capInput({ metadataOnly: true, ownershipVerdict: 'concern' }));
    expect(metaAndOwner.score).toBe(3);
    expect(metaAndOwner.caps).toHaveLength(2);
    const thinAndMeta = applyMarketingCaps(8, capInput({ reviewedArtifacts: 1, thinArtifact: true, metadataOnly: true }));
    expect(thinAndMeta.score).toBe(5);
    expect(thinAndMeta.caps).toEqual(['One thin work sample reviewed: capped at 6', 'Metadata-only evidence: capped at 5']);
  });

  it.each([
    // [score, cap that applies, expected score, expected number of caps listed]
    [10, { metadataOnly: true }, 5, 1], [6, { metadataOnly: true }, 5, 1], [5, { metadataOnly: true }, 5, 0], [4, { metadataOnly: true }, 4, 0],
    [7, { reviewedArtifacts: 1, thinArtifact: true }, 6, 1], [6, { reviewedArtifacts: 1, thinArtifact: true }, 6, 0], [5, { reviewedArtifacts: 1, thinArtifact: true }, 5, 0],
    [4, { ownershipVerdict: 'concern' }, 3, 1], [3, { ownershipVerdict: 'concern' }, 3, 0], [2, { ownershipVerdict: 'concern' }, 2, 0],
    [3, { creditedToOther: true }, 2, 1], [2, { creditedToOther: true }, 2, 0], [0, { creditedToOther: true }, 0, 0],
  ] as Array<[number, Partial<MarketingCapInput>, number, number]>)(
    'score %s with %j -> %s (%s cap(s) listed): a cap equal to or above the score is silent', (score, over, expected, listed) => {
      const r = applyMarketingCaps(score, capInput(over));
      expect(r.score).toBe(expected);
      expect(r.caps).toHaveLength(listed);
    });

  it('lists only the caps that bit: at 5, thin (6) and metadata (5) are silent while an ownership concern (3) bites', () => {
    const r = applyMarketingCaps(5, capInput({ reviewedArtifacts: 1, thinArtifact: true, metadataOnly: true, ownershipVerdict: 'concern' }));
    expect(r.score).toBe(3);
    expect(r.caps).toHaveLength(1);
  });

  it('never raises a score', () => {
    for (let s = 0; s <= 10; s++) {
      const r = applyMarketingCaps(s, capInput({ metadataOnly: true, ownershipVerdict: 'concern', creditedToOther: true }));
      expect(r.score).toBeLessThanOrEqual(s);
    }
  });

  it('clamps a score that is out of range or not a number before capping', () => {
    expect(applyMarketingCaps(99, capInput({ metadataOnly: true })).score).toBe(5);
    expect(applyMarketingCaps(99, capInput())).toEqual({ score: 10, caps: [] });
    expect(applyMarketingCaps(Number.NaN, capInput({ metadataOnly: true }))).toEqual({ score: 0, caps: [] });
  });
});

// ─── The checklist on realistic verdict vectors ──────────────────────────────
const CORROBORATION = ['mh2', 'mh7', 'mh8', 'mh9', 'mh10'];
const DIRECT = ['mh1', 'mh3', 'mh4', 'mh5', 'mh6'];
const QUALITY = ['eq_ownership', 'eq_outcomes', 'eq_craft', 'eq_coherence', 'eq_recency'];
const S = 'strong', P = 'partial', N = 'not_evidenced', C = 'concern';
type Vec = Partial<Record<string, CriterionVerdict>>;
/** All 15 criteria from a verdict vector (missing ids are not_evidenced); non-absent ones rest on something seen. */
const vec = (v: Vec, over: (id: string, verdict: CriterionVerdict) => Partial<CriterionResult> = () => ({})): CriterionResult[] =>
  MARKETING_CRITERIA.map(c => {
    const verdict = v[c.id] ?? N;
    return crit(c.id, verdict, { basis: verdict === N ? 'none' : 'seen', source: verdict === N ? '' : 'L1', ...over(c.id, verdict) });
  });
const checklist = (v: Vec) => weightedChecklistScore(vec(v));

describe('the checklist — attribution is counted once', () => {
  const sum = (group: string) => MARKETING_CRITERIA.filter(c => c.group === group).reduce((s, c) => s + c.weight, 0);

  it('weights: direct 5.25, quality 4, and each corroboration criterion 0.5', () => {
    expect(sum('direct')).toBeCloseTo(5.25, 10);
    expect(sum('quality')).toBeCloseTo(4, 10);
    expect(CORROBORATION.every(id => MARKETING_CRITERIA.find(c => c.id === id)!.weight === 0.5)).toBe(true);
  });

  it('eq_ownership is the only criterion that judges who did the work', () => {
    for (const id of ['mh1', 'mh3', 'mh5']) {
      const d = MARKETING_CRITERIA.find(c => c.id === id)!.description;
      expect(d, id).toMatch(/personal-role criterion \(eq_ownership\)/);
      expect(d, id).not.toMatch(/attributable to the candidate|candidate-made|the candidate's own role/i);
    }
    expect(MARKETING_CRITERIA.find(c => c.id === 'eq_ownership')!.description).toMatch(/ONLY criterion that judges who did the work/);
  });

  it('mh3: strong = at least 5 distinct campaigns shown from concept to execution, 3-4 = partial', () => {
    const d = MARKETING_CRITERIA.find(c => c.id === 'mh3')!.description;
    expect(d).toMatch(/strong = at least 5 distinct campaigns shown, each from concept through execution/);
    expect(d).toMatch(/partial = 3-4 such campaigns/);
  });

  it('eq_coherence is judged per brand or client, so a multi-client portfolio is not penalised', () => {
    expect(MARKETING_CRITERIA.find(c => c.id === 'eq_coherence')!.description).toMatch(/each brand or client separately/);
  });

  it('(a) a strong Drive deck scores 8 or more', () => {
    // direct all strong, quality strong or partial
    expect(checklist({ mh1: S, mh3: S, mh4: S, mh5: S, mh6: S, eq_ownership: S, eq_outcomes: P, eq_craft: S, eq_coherence: P, eq_recency: P })).toBeGreaterThanOrEqual(8);
    expect(checklist({ mh1: S, mh3: S, mh4: S, mh5: S, mh6: S, eq_ownership: P, eq_outcomes: P, eq_craft: P, eq_coherence: P, eq_recency: P })).toBeGreaterThanOrEqual(8);
    expect(checklist({ mh1: S, mh3: S, mh4: S, mh5: S, mh6: S, eq_ownership: S, eq_outcomes: S, eq_craft: S, eq_coherence: S, eq_recency: S })).toBe(10);
    // the review's own typical deck: brand-from-zero not shown, copy and platform partial, ownership only plausible
    expect(checklist({ mh2: P, mh3: S, mh4: P, mh5: S, mh6: P, mh8: S, eq_ownership: P, eq_outcomes: S, eq_craft: S, eq_coherence: S, eq_recency: S })).toBeGreaterThanOrEqual(8);
  });

  it('(b) identical work with eq_ownership not_evidenced versus strong differs by at most one point', () => {
    const work: Vec[] = [
      { mh1: S, mh3: S, mh4: S, mh5: S, mh6: S, eq_outcomes: S, eq_craft: S, eq_coherence: S, eq_recency: S },
      { mh1: N, mh3: P, mh4: P, mh5: P, mh6: P, eq_outcomes: P, eq_craft: S, eq_coherence: S, eq_recency: S },
      { mh3: S, mh4: S, mh5: S, eq_outcomes: S, eq_craft: S, eq_recency: S },
      { mh4: P, mh5: P, eq_craft: P, eq_coherence: P },
      { mh1: P, mh3: P, mh4: P, mh5: P, mh6: P, eq_outcomes: P, eq_craft: P, eq_coherence: P, eq_recency: P },
      { mh3: C, mh4: C, eq_craft: C },
      { mh1: S },
      {},
    ];
    for (const w of work) {
      const unattributed = checklist({ ...w, eq_ownership: N });
      const credited = checklist({ ...w, eq_ownership: S });
      expect(credited - unattributed, JSON.stringify(w)).toBeGreaterThanOrEqual(0);
      expect(credited - unattributed, JSON.stringify(w)).toBeLessThanOrEqual(1);
    }
    // the review's own repro (it scored 6 without a credit line and 9 with one while also changing five other verdicts)
    const sameWork: Vec = { mh3: P, mh4: P, mh5: P, mh6: P, eq_outcomes: P, eq_craft: S, eq_coherence: S, eq_recency: S };
    expect(checklist({ ...sameWork, eq_ownership: S }) - checklist({ ...sameWork, eq_ownership: N })).toBeLessThanOrEqual(1);
  });

  it('an unattributable employer or client page is neutral: not_evidenced eq_ownership leaves the checklist, strong adds, concern subtracts', () => {
    const base: Vec = { mh1: S, mh3: S, mh4: S, mh5: S, mh6: S, eq_outcomes: P, eq_craft: P };
    // the rest of this portfolio averages about 8; what matters is the exact exclusion and the ordering around it
    const without = weightedChecklistScore(vec(base).filter(c => c.id !== 'eq_ownership'));
    expect(checklist({ ...base, eq_ownership: N })).toBe(without);
    expect(checklist({ ...base, eq_ownership: S })).toBeGreaterThanOrEqual(without);
    expect(checklist({ ...base, eq_ownership: C })).toBeLessThan(without);
    expect(checklist({ ...base, eq_ownership: P })).toBe(without);
  });

  it('only eq_ownership is neutral when absent: every other not_evidenced direct or quality criterion still counts as 0.2', () => {
    for (const id of [...DIRECT, ...QUALITY.filter(q => q !== 'eq_ownership')]) {
      const withIt = weightedChecklistScore([crit('mh3', 'strong', { weight: 1 }), crit(id, 'not_evidenced', { weight: 1 })]);
      expect(withIt, id).toBe(6);   // (10 + 2) / 2
    }
  });

  it('(c) a generic template scores 4 or less, even with a strong mission piece or a plausible owner', () => {
    const template: Vec = { mh4: P, mh5: P, eq_craft: P, eq_coherence: P };   // everything else not_evidenced, outcomes included
    expect(checklist(template)).toBeLessThanOrEqual(4);
    expect(checklist({ ...template, mh8: S })).toBeLessThanOrEqual(4);
    expect(checklist({ ...template, eq_ownership: P })).toBeLessThanOrEqual(4);
    expect(checklist({ ...template, mh2: P, mh7: P, mh8: P, mh9: P, mh10: P })).toBeLessThanOrEqual(4);
    expect(checklist({ ...template, mh8: S, eq_ownership: P, eq_recency: P })).toBeLessThanOrEqual(4);
    expect(checklist({ mh4: P, mh5: P, mh6: P, eq_craft: P, eq_coherence: P, eq_recency: P })).toBeLessThanOrEqual(5);
  });

  it('(c, final score) a template at model score 3 stays at 3 or 4 whatever the corroboration says', () => {
    expect(marketingScore(3, checklist({ mh4: P, mh5: P, eq_craft: P, eq_coherence: P }), 0)).toBeLessThanOrEqual(4);
    expect(marketingScore(3, checklist({ mh4: P, mh5: P, eq_craft: P, eq_coherence: P, mh8: S }), 0)).toBeLessThanOrEqual(4);
  });

  it('a single-client portfolio and a multi-client one differ only by the 0.5 coherence criterion', () => {
    const credited: Vec = { mh1: P, mh3: S, mh4: P, mh5: S, mh6: P, eq_ownership: S, eq_outcomes: S, eq_craft: S, eq_recency: S };
    expect(checklist({ ...credited, eq_coherence: S }) - checklist({ ...credited, eq_coherence: P })).toBeLessThanOrEqual(1);
  });
});

describe('the checklist — corroboration is counted only when strong', () => {
  const bases: Vec[] = [
    { mh1: S, mh3: S, mh4: S, mh5: S, mh6: S, eq_ownership: S, eq_outcomes: S, eq_craft: S, eq_coherence: S, eq_recency: S },
    { mh1: P, mh3: P, mh4: P, mh5: P, mh6: P, eq_ownership: P, eq_outcomes: P, eq_craft: P, eq_coherence: P, eq_recency: P },
    { mh4: P, mh5: P, eq_craft: P, eq_coherence: P },
    { mh3: S, mh4: N, mh5: C, eq_ownership: S, eq_outcomes: P },
    {},
  ];

  it('(d) moving any corroboration criterion from not_evidenced to partial, claimed or concern never changes the checklist', () => {
    for (const base of bases) {
      const before = checklist(base);
      for (const id of CORROBORATION) {
        for (const verdict of [P, C] as const) {
          for (const basis of ['seen', 'read', 'claimed', 'none'] as const) {
            const after = weightedChecklistScore(vec({ ...base, [id]: verdict }, i => (i === id ? { basis } : {})));
            expect(after, `${id} ${verdict} ${basis} on ${JSON.stringify(base)}`).toBe(before);
          }
        }
        // a candidate's own claim: source answer / basis claimed, even when the verdict says strong
        for (const claimed of [{ basis: 'claimed' as const, source: 'answer' }, { basis: 'seen' as const, source: 'answer' }, { basis: 'claimed' as const, source: 'L1' }, { basis: 'none' as const, source: '' }]) {
          const after = weightedChecklistScore(vec({ ...base, [id]: S }, i => (i === id ? claimed : {})));
          expect(after, `${id} strong ${JSON.stringify(claimed)}`).toBe(before);
        }
      }
    }
  });

  it('(e) a strong corroboration criterion resting on something seen or read adds a little: never more than its weight share', () => {
    for (const base of bases) {
      const rest = vec(base);
      const before = weightedChecklistScore(rest);
      for (const basis of ['seen', 'read'] as const) {
        for (const id of CORROBORATION) {
          const after = weightedChecklistScore(vec({ ...base, [id]: S }, i => (i === id ? { basis } : {})));
          expect(after, `${id} on ${JSON.stringify(base)}`).toBeGreaterThanOrEqual(before);
          // the direct and quality criteria alone weigh at least 8.25, so one corroboration criterion (0.5) moves the
          // mean by at most 10 * 0.5 / 8.75 = 0.57 points: one point at most once rounded
          expect(after - before, `${id} on ${JSON.stringify(base)}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('all five strong lift a mean-6 portfolio by exactly its weight share (6.0 -> 6.85 -> 7), and one of them does not move it', () => {
    const six: Vec = { mh1: P, mh3: P, mh4: P, mh5: P, mh6: P, eq_ownership: P, eq_outcomes: P, eq_craft: P, eq_coherence: P, eq_recency: P };
    expect(checklist(six)).toBe(6);
    expect(checklist({ ...six, mh2: S })).toBe(6);                       // 6.21
    expect(checklist({ ...six, mh2: S, mh7: S, mh8: S, mh9: S, mh10: S })).toBe(7);   // 6.85
  });

  it('a strong corroboration criterion never lowers a perfect checklist and never raises a perfect one', () => {
    const perfect: Vec = { mh1: S, mh3: S, mh4: S, mh5: S, mh6: S, eq_ownership: S, eq_outcomes: S, eq_craft: S, eq_coherence: S, eq_recency: S };
    expect(checklist(perfect)).toBe(10);
    expect(checklist({ ...perfect, mh2: S, mh7: S, mh8: S, mh9: S, mh10: S })).toBe(10);
    expect(checklist({ ...perfect, mh2: P, mh7: P, mh8: P, mh9: P, mh10: P })).toBe(10);   // used to drop to 9
  });

  it('a weak portfolio is not lifted by claimed or partial corroboration (it used to go from 3 to 4)', () => {
    const weak: Vec = { mh4: P, mh5: P, eq_craft: P, eq_coherence: P };
    expect(checklist({ ...weak, mh2: P, mh7: P, mh8: P, mh9: P, mh10: P })).toBe(checklist(weak));
  });

  it('a corroboration criterion without a basis (hand-built) still counts when strong', () => {
    const bare = { id: 'mh2', label: 'x', verdict: 'strong' as const, evidence: '' };
    expect(weightedChecklistScore([crit('mh1', 'partial'), bare])).toBe(Math.round((1.0 * 6 + 0.5 * 10) / 1.5));
  });
});

describe('the checklist — assessable=false leaves the denominator in every group', () => {
  it.each([['mh3', 'direct'], ['eq_craft', 'quality'], ['eq_ownership', 'quality'], ['mh2', 'corroboration']])('%s (%s)', (id) => {
    const verdicts: CriterionVerdict[] = ['strong', 'partial', 'not_evidenced', 'concern'];
    for (const verdict of verdicts) {
      const out = weightedChecklistScore([crit('mh1', 'strong'), crit(id, verdict, { assessable: false })]);
      expect(out, `${id} ${verdict}`).toBe(10);
    }
  });

  it('a not assessable concern does not drag the score down, and a not assessable strong does not lift it', () => {
    expect(weightedChecklistScore([crit('mh1', 'partial'), crit('mh2', 'strong', { assessable: false })])).toBe(6);
    expect(weightedChecklistScore([crit('mh1', 'partial'), crit('mh2', 'strong')])).toBeGreaterThan(6);
    expect(weightedChecklistScore([crit('mh1', 'partial'), crit('eq_craft', 'concern', { assessable: false })])).toBe(6);
    expect(weightedChecklistScore([crit('mh1', 'partial'), crit('eq_craft', 'concern')])).toBeLessThan(6);
  });

  it('end to end: unreadable, image-led or non-English work is left out instead of scoring 2 out of 10', () => {
    const asked = (assessable?: boolean) => normalizeMarketingCriteria(IDS.map(id => ({
      id, verdict: id === 'mh4' || id === 'mh3' ? 'not_evidenced' : 'strong', basis: 'seen', source: 'L1',
      ...(assessable === false && (id === 'mh4' || id === 'mh3') ? { assessable: false } : {}),
    })));
    const scored = weightedChecklistScore(enforceEvidenceRules(asked(), ctx()).criteria);
    const left = weightedChecklistScore(enforceEvidenceRules(asked(false), ctx()).criteria);
    expect(left).toBe(10);
    expect(scored).toBeLessThan(left);
  });
});

describe('weightedChecklistScore — properties over random verdict vectors (seeded)', () => {
  /** mulberry32: a small deterministic PRNG so a failure reproduces. */
  const rng = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const randomVec = (r: () => number): Record<string, CriterionVerdict> => {
    const v: Record<string, CriterionVerdict> = {};
    for (const id of IDS) {
      const x = r();
      v[id] = x < 0.18 ? 'strong' : x < 0.5 ? 'partial' : x < 0.93 ? 'not_evidenced' : 'concern';
    }
    return v;
  };
  const UP: Record<CriterionVerdict, CriterionVerdict | null> = { concern: 'not_evidenced', not_evidenced: 'partial', partial: 'strong', strong: null };
  const TRIALS = 1500;

  it('the checklist is always an integer in [0, 10], and so is the final score for any model score and bonus', () => {
    const r = rng(20261022);
    for (let t = 0; t < TRIALS; t++) {
      const v = randomVec(r);
      const c = checklist(v);
      expect(Number.isInteger(c) && c >= 0 && c <= 10, JSON.stringify(v)).toBe(true);
      const model = Math.floor(r() * 11);
      const bonus = Math.floor(r() * 5) * 0.25;
      const f = marketingScore(model, c, bonus);
      expect(Number.isInteger(f) && f >= 0 && f <= 10, `${model} ${c} ${bonus}`).toBe(true);
    }
  });

  it('upgrading a direct criterion, or any quality criterion other than eq_ownership, one step never lowers the checklist', () => {
    const r = rng(77);
    for (let t = 0; t < TRIALS; t++) {
      const v = randomVec(r);
      const before = checklist(v);
      for (const id of [...DIRECT, ...QUALITY.filter(q => q !== 'eq_ownership')]) {
        const next = UP[v[id]];
        if (!next) continue;
        expect(checklist({ ...v, [id]: next }), `${id} ${v[id]}->${next} on ${JSON.stringify(v)}`).toBeGreaterThanOrEqual(before);
      }
    }
  });

  it('eq_ownership: strong never lowers the checklist, and neither does a concern becoming not_evidenced', () => {
    const r = rng(4242);
    for (let t = 0; t < TRIALS; t++) {
      const v = randomVec(r);
      const own = v.eq_ownership;
      const before = checklist(v);
      if (own !== 'strong') expect(checklist({ ...v, eq_ownership: 'strong' }), JSON.stringify(v)).toBeGreaterThanOrEqual(before);
      if (own === 'concern') expect(checklist({ ...v, eq_ownership: 'not_evidenced' }), JSON.stringify(v)).toBeGreaterThanOrEqual(before);
    }
  });

  it('eq_ownership: only a strong or a concern counts; a merely plausible owner (partial) is as neutral as an unattributable page (it used to pull a strong portfolio DOWN)', () => {
    const strongWork: Vec = { mh1: S, mh3: S, mh4: S, mh5: S, mh6: S, eq_outcomes: P, eq_craft: P, eq_coherence: P, eq_recency: P };
    expect(checklist({ ...strongWork, eq_ownership: N })).toBe(9);   // 8.55: the unattributable page is simply left out
    expect(checklist({ ...strongWork, eq_ownership: P })).toBe(9);   // the same: partial is neutral (it was 8: a 6 joining a mean of 8.55)
    expect(checklist({ ...strongWork, eq_ownership: S })).toBe(9);
    expect(checklist({ ...strongWork, eq_ownership: C })).toBeLessThan(9);
    // and ownership is exactly one of three states for the mean: left out, in at 10, in at 0
    const without = weightedChecklistScore(vec(strongWork).filter(c => c.id !== 'eq_ownership'));
    expect(checklist({ ...strongWork, eq_ownership: P })).toBe(without);
    expect(checklist({ ...strongWork, eq_ownership: N })).toBe(without);
  });

  it('corroboration: only a strong one resting on something seen or read can move the checklist, and only upwards', () => {
    const r = rng(9001);
    for (let t = 0; t < TRIALS; t++) {
      const v = randomVec(r);
      const noCorroboration: Record<string, CriterionVerdict> = { ...v };
      for (const id of CORROBORATION) noCorroboration[id] = 'not_evidenced';
      const base = checklist(noCorroboration);
      // whatever non-strong verdicts and whatever bases the corroboration criteria carry, nothing changes
      const noisy = vec(noCorroboration, id => (CORROBORATION.includes(id)
        ? { verdict: ([P, C, N] as const)[Math.floor(r() * 3)], basis: (['seen', 'read', 'claimed', 'none'] as const)[Math.floor(r() * 4)] } : {}));
      expect(weightedChecklistScore(noisy), JSON.stringify(v)).toBe(base);
      // a strong one can only raise it
      const id = CORROBORATION[Math.floor(r() * 5)];
      expect(checklist({ ...noCorroboration, [id]: 'strong' }), `${id} on ${JSON.stringify(v)}`).toBeGreaterThanOrEqual(base);
    }
  });

  it('the final score never decreases when a direct criterion is upgraded (model score and bonus held fixed)', () => {
    const r = rng(31337);
    for (let t = 0; t < TRIALS; t++) {
      const v = randomVec(r);
      const model = Math.floor(r() * 11);
      const bonus = Math.floor(r() * 5) * 0.25;
      const before = marketingScore(model, checklist(v), bonus);
      const id = DIRECT[Math.floor(r() * 5)];
      const next = UP[v[id]];
      if (next) expect(marketingScore(model, checklist({ ...v, [id]: next }), bonus)).toBeGreaterThanOrEqual(before);
    }
  });
});

// ─── The bonus ───────────────────────────────────────────────────────────────
describe('niceToHaveBonus — claims earn nothing', () => {
  const strongNice = (over: Partial<CriterionResult>) => [crit('nh1', 'strong', over)];

  it('a strong nice-to-have that rests on the candidate\'s own word, or on nothing, adds no bonus even before enforcement', () => {
    expect(niceToHaveBonus(strongNice({ basis: 'claimed' }))).toBe(0);
    expect(niceToHaveBonus(strongNice({ source: 'answer' }))).toBe(0);
    expect(niceToHaveBonus(strongNice({ basis: 'none' }))).toBe(0);
    expect(niceToHaveBonus(strongNice({ basis: 'seen', source: 'L1' }))).toBe(0.25);
    expect(niceToHaveBonus(strongNice({ basis: 'read', source: 'L2' }))).toBe(0.25);
    expect(niceToHaveBonus(strongNice({ basis: undefined, source: undefined }))).toBe(0.25);
  });
});

describe('marketingScore — one rounding, and the limits on the bonus', () => {
  // The rule written out independently of the implementation: ONE rounding of blend + bonus; the bonus only from a blend of 6; never
  // a 10 made by the bonus; never more than one point above the model's own score.
  const expected = (m: number, c: number, strongNice: number): number => {
    const blend = (m + c) / 2;
    const bonus = blend >= 6 ? Math.min(1, strongNice * 0.25) : 0;
    let f = Math.round(blend + bonus);
    if (f >= 10 && Math.round(blend) < 10) f = 9;
    return Math.min(f, m + 1, 10);
  };
  const niceVec = (n: number) => NH_IDS.map((id, i) => crit(id, i < n ? 'strong' : 'not_evidenced'));
  const column = (model: number, check: number) => Array.from({ length: 11 }, (_, n) => marketingScore(model, check, niceToHaveBonus(niceVec(n))));

  it('rounds the blend and the bonus together: a half-point blend (7, 6) with 0..10 strong nice-to-haves', () => {
    // blend 6.5: +0.25 -> 6.75 -> 7, +0.5 -> 7.0 -> 7, +0.75 -> 7.25 -> 7, +1 -> 7.5 -> 8
    expect(column(7, 6)).toEqual([7, 7, 7, 7, 8, 8, 8, 8, 8, 8, 8]);
    // the old maths rounded the blend first, so +0.5 already made it 8
    expect(blendPortfolioScore(7, 6) + 0.5).toBe(7.5);
  });

  it('a whole-point blend (6, 6): the second strong nice-to-have is the first that can lift it, then it tops out at +1', () => {
    expect(column(6, 6)).toEqual([6, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7]);
  });

  it('a (8, 7) blend of 7.5', () => {
    expect(column(8, 7)).toEqual([8, 8, 8, 8, 9, 9, 9, 9, 9, 9, 9]);
  });

  it('a blend under 6 gets no bonus at all: it is a tie-breaker between good portfolios', () => {
    expect(column(5, 5)).toEqual(Array(11).fill(5));
    expect(column(5, 6)).toEqual(Array(11).fill(6));   // blend 5.5 -> 6 with no bonus
    expect(column(4, 7)).toEqual(Array(11).fill(5));   // blend 5.5 would be 6, but never more than model + 1
    expect(column(0, 0)).toEqual(Array(11).fill(0));
    expect(column(3, 8)).toEqual(Array(11).fill(4));   // blend 5.5 would be 6, but never more than model + 1
  });

  it('never more than one point above the model\'s own score, and never a 10 made by the bonus', () => {
    // the second review's examples: model 8 + checklist 9 + four strong nice-to-haves was 10; model 7 + 9 + 4 was 9; model 9 + 9 + 4 was 10
    expect(marketingScore(8, 9, 1)).toBe(9);
    expect(marketingScore(7, 9, 1)).toBe(8);
    expect(marketingScore(9, 9, 1)).toBe(9);
    expect(marketingScore(9, 9, 0)).toBe(9);
    // 10 needs a plain blend of 9.5 or more
    expect(marketingScore(9, 10, 0)).toBe(10);
    expect(marketingScore(9, 10, 1)).toBe(10);
    expect(marketingScore(10, 9, 1)).toBe(10);
    expect(marketingScore(10, 10, 1)).toBe(10);
    expect(marketingScore(10, 8, 1)).toBe(9);   // blend 9.0 + 1 = 10, but not a 10 by the bonus
    expect(marketingScore(10, 8, 0)).toBe(9);
  });

  it('equals the independent statement of the rule on the whole grid, never moves down as nice-to-haves are added, and gains at most +1 from them', () => {
    for (let m = 0; m <= 10; m++) {
      for (let c = 0; c <= 10; c++) {
        const col = column(m, c);
        col.forEach((got, n) => {
          expect(got, `m${m} c${c} n${n}`).toBe(expected(m, c, n));
          expect(got).toBeLessThanOrEqual(Math.min(10, m + 1));
          if (got === 10) expect(Math.round((m + c) / 2), `m${m} c${c} n${n}`).toBe(10);
          if (n > 0) expect(got).toBeGreaterThanOrEqual(col[n - 1]);
        });
        expect(col[10] - col[0]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is monotone in the model score and in the checklist (bonus held fixed) over the whole grid', () => {
    for (let n = 0; n <= 4; n++) {
      for (let a = 0; a <= 10; a++) {
        for (let b = 0; b < 10; b++) {
          expect(marketingScore(b + 1, a, n * 0.25), `model ${b}->${b + 1} at checklist ${a}, ${n} nice`).toBeGreaterThanOrEqual(marketingScore(b, a, n * 0.25));
          expect(marketingScore(a, b + 1, n * 0.25), `checklist ${b}->${b + 1} at model ${a}, ${n} nice`).toBeGreaterThanOrEqual(marketingScore(a, b, n * 0.25));
        }
      }
    }
  });

  it('ten strong nice-to-haves never add more than the +1 cap', () => {
    expect(niceToHaveBonus(niceVec(10))).toBe(1);
    expect(marketingScore(7, 7, niceToHaveBonus(niceVec(10)))).toBe(8);
  });
});

describe('applyMarketingCaps — the employer-page cap and the thin cap decided by the caller', () => {
  const EMPLOYER = 'Work shown only on employer or client pages without a personal credit: capped at 6';

  it('employer-only work is capped at 6 with the exact wording', () => {
    expect(applyMarketingCaps(9, capInput({ employerOnly: true }))).toEqual({ score: 6, caps: [EMPLOYER] });
    expect(applyMarketingCaps(7, capInput({ employerOnly: true }))).toEqual({ score: 6, caps: [EMPLOYER] });
  });

  it('is silent when the score is already 6 or lower, and when the flag is off', () => {
    expect(applyMarketingCaps(6, capInput({ employerOnly: true }))).toEqual({ score: 6, caps: [] });
    expect(applyMarketingCaps(4, capInput({ employerOnly: true }))).toEqual({ score: 4, caps: [] });
    expect(applyMarketingCaps(9, capInput({ employerOnly: false }))).toEqual({ score: 9, caps: [] });
  });

  it('the thin cap applies whenever the caller says the sample is thin, whatever reviewedArtifacts is', () => {
    for (const n of [0, 1, 2, 5, 8]) {
      expect(applyMarketingCaps(9, capInput({ reviewedArtifacts: n, thinArtifact: true })), `reviewedArtifacts ${n}`)
        .toEqual({ score: 6, caps: ['One thin work sample reviewed: capped at 6'] });
    }
    expect(applyMarketingCaps(9, capInput({ reviewedArtifacts: 1, thinArtifact: false }))).toEqual({ score: 9, caps: [] });
  });

  it('employer-only and thin at the same limit report only the first that bites', () => {
    const r = applyMarketingCaps(9, capInput({ employerOnly: true, thinArtifact: true }));
    expect(r).toEqual({ score: 6, caps: [EMPLOYER] });
  });

  it('lists every cap that bit on the way down, in order of limit', () => {
    const r = applyMarketingCaps(9, capInput({ employerOnly: true, metadataOnly: true, ownershipVerdict: 'concern', creditedToOther: true }));
    expect(r.score).toBe(2);
    expect(r.caps).toEqual([EMPLOYER, 'Metadata-only evidence: capped at 5', 'Work credited to a different person or contradicting the claim: capped at 3', 'Work credited to someone else: capped at 2']);
    const meta = applyMarketingCaps(8, capInput({ employerOnly: true, metadataOnly: true }));
    expect(meta).toEqual({ score: 5, caps: [EMPLOYER, 'Metadata-only evidence: capped at 5'] });
  });

  it('never raises a score, and clamps a score that is not a number', () => {
    for (let s = 0; s <= 10; s++) expect(applyMarketingCaps(s, capInput({ employerOnly: true, thinArtifact: true })).score).toBeLessThanOrEqual(s);
    expect(applyMarketingCaps(Number.NaN, capInput({ employerOnly: true }))).toEqual({ score: 0, caps: [] });
  });
});

// Third adversarial review, G13: a verdict these rules bring down to not_evidenced used to keep the model's basis ("read"), source and
// evidence, so the card showed "Not evidenced" beside a green "read" badge and the quote the text never contained.
describe('enforceEvidenceRules — a verdict brought down to not_evidenced keeps nothing that was rejected (G13)', () => {
  const TEXT = 'Jal Mitra 2023. Reached 14 cities in 6 weeks. Brand deck with results.';
  const textCtx = (over: Partial<Acq> = {}) => ctx([acq({ text: TEXT, hasMedia: false, ...over })]);
  const read = (verdict: CriterionVerdict, evidence: string, over: Partial<CriterionResult> = {}) =>
    crit('mh3', verdict, { basis: 'read', source: 'L1', evidence, ...over });
  const BLANK = { verdict: 'not_evidenced', basis: 'none', source: '', evidence: '' };

  it('an invented quote: not_evidenced with basis none, no source and no evidence (every verdict that can carry a quote)', () => {
    for (const verdict of ['strong', 'partial', 'concern'] as const) {
      const r = enforce(read(verdict, 'Shows "Reached 40 cities in 6 weeks"'), textCtx());
      expect(r.criteria[0], verdict).toMatchObject(BLANK);
      expect(r.notes.some(n => /^mh3: quoted text not found in L1; the quote is invented, so .* lowered to not_evidenced$/.test(n)), verdict).toBe(true);
    }
  });

  it('the note keeps the reason and the criterion id, but not the rejected wording (notes are not run through the fairness filter)', () => {
    const r = enforce(read('strong', 'Shows "Reached 40 cities in 6 weeks"'), textCtx());
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^mh3: /);
    expect(r.notes[0]).not.toMatch(/40 cities/);
  });

  it('a quote that IS in the text is untouched: basis, source and evidence all stay', () => {
    const r = enforce(read('strong', 'Shows "Reached 14 cities in 6 weeks"'), textCtx());
    expect(r.criteria[0]).toMatchObject({ verdict: 'strong', basis: 'read', source: 'L1', evidence: 'Shows "Reached 14 cities in 6 weeks"' });
    expect(r.notes).toEqual([]);
  });

  it('a verdict that is only lowered to partial keeps its evidence (it still stands on something): near match, claim, metadata, video', () => {
    const near = enforce(read('strong', 'Shows "Reached 14 cities in about 6 weeks"'), textCtx());
    expect(near.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'read', source: 'L1', evidence: 'Shows "Reached 14 cities in about 6 weeks"' });
    const claim = enforce(crit('mh3', 'strong', { basis: 'claimed', source: 'answer', evidence: 'The candidate says five campaigns' }));
    expect(claim.criteria[0]).toMatchObject({ verdict: 'partial', basis: 'claimed', source: 'answer', evidence: 'The candidate says five campaigns' });
    const meta = enforce(crit('mh3', 'strong', { basis: 'seen', source: 'L1', evidence: 'Bio lists campaigns' }), ctx([acq({ basis: 'metadata', text: 'Bio' })]));
    expect(meta.criteria[0]).toMatchObject({ verdict: 'partial', source: 'L1', evidence: 'Bio lists campaigns' });
  });

  it('rule 1, no valid source: a partial or a concern that ends as not_evidenced is blank; a strong that only goes to partial keeps its evidence', () => {
    for (const verdict of ['partial', 'concern'] as const) {
      expect(enforce(crit('mh3', verdict, { basis: 'read', source: 'L9', evidence: 'Shows "something"' })).criteria[0], verdict).toMatchObject(BLANK);
      expect(enforce(crit('mh3', verdict, { basis: 'seen', source: '', evidence: 'looked fine' })).criteria[0], verdict).toMatchObject(BLANK);
    }
    expect(enforce(crit('mh3', 'strong', { basis: 'read', source: 'L9', evidence: 'looked fine' })).criteria[0])
      .toMatchObject({ verdict: 'partial', basis: 'none', source: '', evidence: 'looked fine' });
  });

  it('rule 6, a concern resting on a claim: not_evidenced and blank', () => {
    const r = enforce(crit('eq_ownership', 'concern', { basis: 'claimed', source: 'answer', evidence: 'The candidate says it was a colleague' }));
    expect(r.criteria[0]).toMatchObject(BLANK);
    expect(r.notes.some(n => /^eq_ownership: .*concern needs something seen or read/.test(n))).toBe(true);
  });

  it('rule 7, a source with basis none: a partial that goes to not_evidenced is blank', () => {
    const r = enforce(crit('mh3', 'partial', { basis: 'none', source: 'L1', evidence: 'Some campaigns shown' }));
    expect(r.criteria[0]).toMatchObject(BLANK);
    expect(r.notes.some(n => /^mh3: L1 is cited but the basis is none/.test(n))).toBe(true);
  });

  it('two steps down (strong -> partial by rule 3, partial -> not_evidenced by rule 8) ends blank, with a note for each step', () => {
    const r = enforce(read('strong', 'Shows "an invented sentence about retention"'), ctx([acq({ basis: 'metadata', text: 'Bio: led growth at two startups' })]));
    expect(r.criteria[0]).toMatchObject(BLANK);
    expect(r.notes.filter(n => n.startsWith('mh3: '))).toHaveLength(2);
  });

  it('a verdict that was not_evidenced to begin with is left exactly as the model wrote it', () => {
    const own = crit('mh3', 'not_evidenced', { basis: 'seen', source: 'L1', evidence: 'Looked at L1, no campaigns visible' });
    const r = enforce(own, textCtx());
    expect(r.criteria[0]).toEqual(own);
    expect(r.notes).toEqual([]);
  });

  it('nice-to-haves are held to the same rule', () => {
    const nice: CriterionResult = { id: 'nh3', label: 'Video production or direction', verdict: 'strong', basis: 'read', source: 'L1', evidence: 'Shows "shot and edited the film ourselves"', assessable: true };
    const r = enforce(nice, textCtx());
    expect(r.criteria[0]).toMatchObject({ verdict: 'not_evidenced', basis: 'none', source: '', evidence: '' });
    expect(r.notes[0]).toMatch(/^nh3: quoted text not found in L1/);
  });

  it('what the card reads is consistent: a not_evidenced row never carries a basis other than none, nor a source or text', () => {
    const rows = [
      read('strong', 'Shows "Reached 40 cities in 6 weeks"'), read('partial', 'Shows "Reached 40 cities in 6 weeks"'),
      crit('eq_craft', 'partial', { basis: 'none', source: 'L1', evidence: 'ok' }), crit('mh5', 'concern', { basis: 'claimed', source: 'answer', evidence: 'ok' }),
    ];
    for (const row of rows) {
      const c = enforce(row, textCtx()).criteria[0];
      expect(c.verdict).toBe('not_evidenced');
      expect([c.basis, c.source, c.evidence]).toEqual(['none', '', '']);
    }
  });
});

describe('enforceEvidenceRules — properties over random input (seeded)', () => {
  const rng = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const RANK: Record<CriterionVerdict, number> = { strong: 3, partial: 2, concern: 1, not_evidenced: 0 };
  const TEXT = 'Water Wise 2024: we grew LinkedIn reach from 12,000 to 340,000 in six months. The market-\ning team of four ran 6 campaigns.';
  const SOURCES = ['L1', 'L2', 'L9', 'answer', 'L1, L2', '[L1]', 'L1 and answer', '', '   ', 'garbage', 'L1+L2', 'L3.'];
  const EVIDENCE = [
    '', 'plain words with no quote', 'Says "grew LinkedIn reach from 12,000 to 340,000"', 'Says "grew reach from 100K to 9 million"',
    'Says \'marketing team of four\'', 'Says \'invented words in single quotes\'', 'Calls it "Zero Boond"', 'Says "unterminated quote here',
    '"grew LinkedIn reach ... six months"',
  ];

  it('never throws, never raises a verdict, keeps a note for every change, and only leaves valid sources behind', () => {
    const r = rng(555);
    for (let t = 0; t < 1500; t++) {
      const items: Acq[] = ['L1', 'L2', 'L3'].map(ref => acq({
        ref, text: pick(r, [TEXT, '', 'something else entirely', undefined as never]),
        basis: pick(r, ['artifact', 'metadata'] as const), outcome: pick(r, ['ok', 'ok', 'partial', 'failed', 'inaccessible']),
        link: { platform: pick(r, ['custom', 'pdf_file', 'youtube', 'vimeo']) },
        hasMedia: pick(r, [true, false, undefined]), nativeDocument: pick(r, [true, false, undefined]), textTruncated: pick(r, [true, false, undefined]),
      }));
      const x = ctx(items, pick(r, ['I ran many campaigns', '', '   ']));
      const input = IDS.map(id => crit(id, pick(r, ['strong', 'partial', 'not_evidenced', 'concern'] as const), {
        basis: pick(r, ['seen', 'read', 'claimed', 'none', undefined] as const), source: pick(r, SOURCES), evidence: pick(r, EVIDENCE),
      }));
      const snapshot = JSON.parse(JSON.stringify(input));
      const out = enforceEvidenceRules(input, x);
      expect(input, 'input is not mutated').toEqual(snapshot);
      expect(out.criteria).toHaveLength(input.length);
      out.criteria.forEach((c, i) => {
        const before = input[i];
        expect(c.id).toBe(before.id);
        expect(RANK[c.verdict], `${c.id} ${before.verdict}->${c.verdict}`).toBeLessThanOrEqual(RANK[before.verdict]);
        if (c.verdict !== before.verdict) expect(out.notes.some(n => n.startsWith(`${c.id}: `)), `note for ${c.id}`).toBe(true);
        // G13: a verdict brought down to not_evidenced keeps nothing the rules rejected; one that was not_evidenced already is untouched
        if (c.verdict === 'not_evidenced' && before.verdict !== 'not_evidenced') expect([c.basis, c.source, c.evidence], `${c.id} blank`).toEqual(['none', '', '']);
        if (before.verdict === 'not_evidenced') expect(c, `${c.id} untouched`).toEqual(before);
        if (c.verdict !== 'not_evidenced') {
          // what is left cites only sources that exist
          for (const s of c.source!.split(', ').filter(Boolean)) {
            expect(s === 'answer' || ['L1', 'L2', 'L3'].includes(s), `${c.id} source "${c.source}"`).toBe(true);
          }
        }
      });
      for (const n of out.notes) expect(n).toMatch(/^(mh\d+|eq_[a-z]+): /);
    }
  });
});

// ─── Protected attributes ────────────────────────────────────────────────────
describe('filterProtectedAttributes — content about a group is kept', () => {
  const keep = [
    // the contract's must-keeps
    'Women\'s Day campaign reached 2M views',
    'Gender-equality campaign for rural water access',
    'Senior-citizen outreach series',
    'Diwali festive campaign',
    'Campaign for Muslim-owned small businesses',
    // other campaign content
    'Women-led startup rebrand',
    'Campaign on maternal health reached 1M parents',
    'Maternity-care awareness reel series',
    'Pregnancy nutrition explainer videos for ASHA workers',
    'Family-planning awareness campaign',
    'Hindu festival Holi campaign for a dairy brand',
    'Eid greetings social series',
    'Christmas campaign for a retail brand',
    'Campaign for young farmers in Punjab',
    'Led a campaign targeting young mothers',
    'Targeted men and women aged 25 to 40',
    'Campaign aimed at men and women aged 25-40',
    'Targeting adults aged 18+',
    'Target age: 25-34',
    'Audience gender: all',
    'Campaign for people in their 30s',
    'Christian Dior campaign analysis',
    'Women\'s Day campaign for Jain Irrigation',
    'Jain Irrigation social launch',
    'Asian Paints brand film study',
    'Mother Dairy summer campaign',
    // statements that are not about a protected attribute
    'She launched a campaign for women farmers',
    'She led five campaigns',
    'He is a strong copywriter',
    'The candidate is a senior strategist',
    'The candidate is single-handedly responsible for the launch',
    'She is a pretty good copywriter',
    'She is a pretty strong writer',
    'She is a mother brand specialist',
    'The candidate is a parent company brand lead',
    'The host of the series is Priya',
    'She is Aarti Jain',
    'The founder is a woman-led startup advisor',
    'Probably the best portfolio in the pool',
    'Likely to resonate with young women',
    'Likely appeals to Muslim audiences',
    'Probably a woman-led brand',
    'Probably a young brand',
    'Seems like a Hindu festival campaign',
    'Likely a women\'s collective',
    'Likely male audience',
    'Her body of work spans women\'s health campaigns',
    'Her appearance on the podcast drove signups',
    'His children\'s book campaign won an award',
    'Beautiful visual identity and strong typography',
    'Attractive pricing creative for a B2B SaaS',
    'A stunning microsite with scroll-driven storytelling',
    'Led the rebrand of a 10-year-old company',
    'A 5-year-old startup rebrand',
    'The company is 3 years old',
    'Page 2 of the portfolio',
    'Stage 3 of the funnel',
    'Over 8 years of agency experience',
    'Age-old traditions retold for a new audience',
    'Probably a young team',
    'Probably young women',
    'Likely a male-dominated sector',
    'Looks like a female-founder-led startup',
    'Appears to be a young company with a bold identity',
    'The founder is married to the brand vision',
    'Average age 35 across the audience',
    'She is an elderly-care brand strategist',
    'The candidate is an Indian-market specialist',
    'He is a speaker at the Water Summit 2024',
    'The speaker is a recognised voice in water policy',
    'The campaign features a Sikh farmer and his family',
    'Muslim, Hindu and Christian voices featured in the film',
    'Celebrates a Hindu-Muslim friendship story',
    'Single-minded focus on measurable results',
    'Appears to be a married-couple-run agency',
    'Instagram work is aimed at women in rural India.',
    'Candidate credits themselves as sole creative lead on the 2023 Mission Jal campaign.',
    'No campaign metrics are stated, so results are unverified.',
    'Likely strong at social-first creative based on the reels.',
  ];
  it.each(keep)('keeps %j', (s) => {
    expect(findProtectedAttribute(s)).toBeNull();
    expect(filterProtectedAttributes([s])).toEqual({ kept: [s], dropped: 0 });
  });
});

describe('filterProtectedAttributes — statements about the candidate are dropped', () => {
  const drop: Array<[string, string]> = [
    // the contract's must-drops
    ['Candidate appears to be a young woman', 'subject-attribute'],
    ['She is probably married with kids', 'subject-attribute'],
    ['Likely in his 40s', 'hedged-attribute'],
    ['The candidate is a Hindu from North India', 'subject-attribute'],
    ['Good-looking presenter in the videos', 'appearance'],
    ['Contact: jane@x.com', 'email'],
    ['Call +91 98765 43210', 'phone'],
    // gender
    ['The founder is a woman', 'subject-attribute'],
    ['The female candidate led six campaigns', 'attribute-candidate'],
    // 'He is a man of few words' was dropped by the first filter; protectedAttributes.ts keeps the idiom on purpose (the
    // adversarial review lists it as a must-keep) - see protectedAttributes.test.ts.
    ['She identifies as non-binary', 'subject-attribute'],
    // age
    ['The candidate appears to be in her early 30s', 'subject-attribute'],
    ['He is a 34 year old man', 'age'],
    ['A 52-year-old woman fronts the videos', 'age'],
    ['She is 29 years old', 'age'],
    ['The candidate is 35.', 'age'],
    ['Candidate is aged 41', 'age'],
    ['The candidate is at the age of 34', 'age'],
    ['Probably in her mid-30s', 'hedged-attribute'],
    ['She might be too young for this role', 'age'],
    ['He is a young gun in marketing', 'subject-attribute'],
    // religion, caste, ethnicity
    ['Seems to be a Sikh woman', 'hedged-attribute'],
    ['Probably a young Sikh woman.', 'hedged-attribute'],
    ['Likely female, based on the name', 'hedged-attribute'],
    ['Appears male and in his 30s', 'hedged-attribute'],
    ['Probably a Hindu from North India', 'hedged-attribute'],
    ['Looks like a married woman', 'hedged-attribute'],
    ['Seems to be in her forties', 'hedged-attribute'],
    ['Possibly pregnant', 'hedged-attribute'],
    ['She is in her thirties', 'subject-attribute'],
    ['Probably Muslim', 'hedged-attribute'],
    ['Likely a Christian', 'hedged-attribute'],
    ['She is Jain.', 'subject-attribute'],
    ['The applicant is Brahmin', 'subject-attribute'],
    ['The candidate belongs to the Rajput community', 'subject-attribute'],
    ['He comes from a Dalit family', 'subject-attribute'],
    ['She is dark-skinned', 'subject-attribute'],
    ['The candidate is a Muslim woman', 'subject-attribute'],
    ['A Hindu applicant with a strong portfolio', 'attribute-candidate'],
    // marital and family status, pregnancy
    ['Candidate is single', 'subject-attribute'],
    ['The candidate is a divorced man', 'subject-attribute'],
    ['The candidate is a mother of two', 'subject-attribute'],
    ['She is expecting a baby', 'subject-attribute'],
    ['Married with kids', 'family'],
    ['Her husband works in finance', 'family'],
    ['She has two small children', 'family'],
    ['He has a young family', 'family'],
    ['She may start a family soon', 'family'],
    ['She might get pregnant', 'family'],
    ['Maternity leave gap in the CV', 'family'],
    ['Marital status: married', 'family'],
    // appearance
    ['Attractive young woman presenting the reel', 'appearance'],
    ['The presenter is very attractive', 'appearance'],
    ['The host looks stunning', 'appearance'],
    ['Her looks helped the video perform', 'appearance'],
    ['Handsome speaker with a deep voice', 'appearance'],
    ['A pretty woman fronts the film', 'appearance'],
    ['Dark-skinned presenter in the videos', 'appearance'],
    // inferring from a name or picture
    ['Judging by her name she is from the south', 'inference-source'],
    ['Based on the profile picture alone', 'inference-source'],
    ['Based on the profile picture, the candidate looks young', 'subject-attribute'],
    ['Going by his surname', 'inference-source'],
    ['Inferred from the headshot', 'inference-source'],
    ['Guessed from her accent', 'inference-source'],
    // attributes named as fields
    ['Her age is a concern', 'attribute-field'],
    ['Gender: Female', 'attribute-field'],
    ['Date of birth: 12 May 1990', 'attribute-field'],
    ['Religion: Hindu', 'attribute-field'],
    ['The candidate\'s gender is not stated', 'attribute-field'],
    ['Gender of the candidate unclear', 'attribute-field'],
  ];
  it.each(drop)('drops %j (%s)', (s, rule) => {
    expect(findProtectedAttribute(s)).toBe(rule);
    expect(filterProtectedAttributes([s])).toEqual({ kept: [], dropped: 1 });
  });
});

describe('filterProtectedAttributes — contact details', () => {
  const contact = [
    'Contact: jane@x.com', 'Reach her at jane.doe+hr@example.co.in for more', 'jane_doe@sub.example-mail.org',
    'jane [at] example [dot] com', 'jane(at)example.com', 'jane (at) example (dot) com', 'jane at example dot com',
    'jane\uff20example.com', 'JANE@EXAMPLE.COM',
    'Call +91 98765 43210', 'WhatsApp 98765 43210', '+91-98765-43210', '098765 43210', '9876543210', '98765.43210',
    '(022) 2345 6789', '+1 (555) 010-9999', '+44 20 7946 0958', '9 8 7 6 5 4 3 2 1 0', 'Phone: 98765-43210 (office)',
    'Call me on \uff19\uff18\uff17\uff16\uff15 \uff14\uff13\uff12\uff11\uff10', '\uff0b\uff19\uff11 98765 43210',
  ];
  it.each(contact)('drops %j', (s) => {
    expect(['email', 'phone']).toContain(findProtectedAttribute(s));
    expect(filterProtectedAttributes([s]).dropped).toBe(1);
  });

  const notContact = [
    'Handle @digitalpaani on Instagram', 'Posted at 5 pm on Friday', 'Reached 1250 leads in 90 days', 'Budget of \u20b950,00,000',
    'Followers grew from 12000 to 48000', 'Campaigns in 2019, 2020, 2021 and 2022', 'Delivered between 2019 2020 2021',
    'FY2022-2023 performance', '2019-2020-2021-2022 retrospective', 'Reach 2.5M in 3 months', 'ROI of 3.2x', 'Ticket 12345 closed',
    'Case study on water@scale conference',
  ];
  it.each(notContact)('keeps %j', (s) => {
    expect(findProtectedAttribute(s)).toBeNull();
  });
});

describe('filterProtectedAttributes — obfuscation and unicode', () => {
  it.each([
    ['She is m\u200barried', 'zero-width space inside the word'],
    ['She is mar\u00adried', 'soft hyphen'],
    ['She is \u202emarried', 'bidi override'],
    ['SHE IS PROBABLY MARRIED', 'upper case'],
    ['CANDIDATE APPEARS TO BE A YOUNG WOMAN', 'upper case'],
    ['\uff33\uff28\uff25 \uff29\uff33 \uff2d\uff21\uff32\uff32\uff29\uff25\uff24', 'full-width letters'],
    ['The candidate is a H\u0456ndu', 'Cyrillic i'],
    ['The candidate is a Mu\u0455lim', 'Cyrillic s'],
    ['The candidate is a Musl\u00edm', 'accent'],
    ['The candidate is a Musli\u0301m', 'combining accent'],
    ['She is m a r r i e d', 'spaced letters'],
    ['She is  \t probably \n married', 'odd whitespace'],
    ['The candidate\u2019s gender is unclear', 'curly apostrophe'],
    ['She is a woman — and a leader', 'em dash after the term'],
    ['Probably in her mid\u201130s', 'non-breaking hyphen'],
  ])('drops %j (%s)', (s) => {
    expect(filterProtectedAttributes([s]).dropped).toBe(1);
  });

  it('still keeps campaign content written with typographic characters', () => {
    expect(filterProtectedAttributes(['Women\u2019s Day campaign reached 2M views']).dropped).toBe(0);
    expect(filterProtectedAttributes(['Gender\u2011equality campaign for rural water access']).dropped).toBe(0);
    expect(filterProtectedAttributes(['\uff37omen\u2019s Day campaign']).dropped).toBe(0);
  });

  it('a word that is only a prefix or suffix of a longer one is not a term', () => {
    expect(findProtectedAttribute('She is a manager of managers')).toBeNull();
    expect(findProtectedAttribute('She is a mandate holder')).toBeNull();
    expect(findProtectedAttribute('The candidate is a hindu-kush trekking guide')).toBeNull();
    expect(findProtectedAttribute('She is a marketing expert')).toBeNull();
  });
});

describe('filterProtectedAttributes — behaviour', () => {
  it('keeps the other strings verbatim and in order, and counts what it dropped', () => {
    const input = ['  Launched six campaigns  ', 'She is probably married with kids', 'Contact: jane@x.com', 'Strong copy range', 'Likely in his 40s'];
    const out = filterProtectedAttributes(input);
    expect(out.kept).toEqual(['  Launched six campaigns  ', 'Strong copy range']);
    expect(out.dropped).toBe(3);
  });

  it('returns an empty result for an empty list and does not mutate its input', () => {
    expect(filterProtectedAttributes([])).toEqual({ kept: [], dropped: 0 });
    const input = ['Contact: jane@x.com', 'ok'];
    filterProtectedAttributes(input);
    expect(input).toEqual(['Contact: jane@x.com', 'ok']);
  });

  it('ignores anything that is not a string, and survives a non-array', () => {
    expect(filterProtectedAttributes(['ok', 5, null, undefined, {}, ['x']] as never)).toEqual({ kept: ['ok'], dropped: 0 });
    expect(filterProtectedAttributes(undefined as never)).toEqual({ kept: [], dropped: 0 });
    expect(filterProtectedAttributes('nope' as never)).toEqual({ kept: [], dropped: 0 });
  });

  it('keeps an empty or whitespace string (there is nothing in it to drop)', () => {
    expect(filterProtectedAttributes(['', '   '])).toEqual({ kept: ['', '   '], dropped: 0 });
  });

  it('a bare pronoun is not a statement about an attribute', () => {
    expect(filterProtectedAttributes(['She led five campaigns', 'He grew the page 4x', 'Her portfolio is strong'])).toEqual({
      kept: ['She led five campaigns', 'He grew the page 4x', 'Her portfolio is strong'], dropped: 0,
    });
  });

  it('findProtectedAttribute reports null for empty and non-string input', () => {
    expect(findProtectedAttribute('')).toBeNull();
    expect(findProtectedAttribute(null)).toBeNull();
    expect(findProtectedAttribute(undefined)).toBeNull();
  });

  it('an e-mail or phone number wins even inside an otherwise innocent campaign line', () => {
    expect(findProtectedAttribute('Women\'s Day campaign, contact asha@x.com')).toBe('email');
    expect(findProtectedAttribute('Diwali campaign hotline 98765 43210')).toBe('phone');
  });

  it('only the first 20,000 characters are examined', () => {
    expect(findProtectedAttribute(`${'x '.repeat(10_050)}she is married`)).toBeNull();
    expect(findProtectedAttribute(`${'x '.repeat(9_000)}she is married`)).toBe('subject-attribute');
  });

  it('stays fast on hostile input (no catastrophic backtracking)', () => {
    const hostile = [
      'a'.repeat(200_000), 'a@'.repeat(50_000), ' '.repeat(200_000) + 'x', '1 '.repeat(50_000), '1'.repeat(100_000),
      'a '.repeat(50_000) + '!', `she is ${'very '.repeat(20_000)}`, `likely ${'in '.repeat(20_000)}`, '(('.repeat(50_000),
      'aged '.repeat(20_000), 'a.'.repeat(60_000), `${'a'.repeat(60)}@`.repeat(1_000), '+'.repeat(100_000), '- '.repeat(100_000),
    ];
    const started = Date.now();
    for (const h of hostile) filterProtectedAttributes([h]);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
