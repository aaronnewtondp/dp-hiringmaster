import { describe, it, expect } from 'vitest';
import {
  MARKETING_CRITERIA, MARKETING_NICE_TO_HAVES, MIN_ASSESSED_SHARE, NOTHING_ASSESSABLE_NOTE, NOT_RETURNED_TEXT,
  assessChecklist, countReturnedCriteria, enforceEvidenceRules, marketingScore, modelOnlyNote, niceToHaveBonus,
  normalizeMarketingCriteria, scoreMarketing, weightedChecklistScore, type EvidenceContext,
} from './rubric.marketing.js';
import type { CriterionResult, CriterionVerdict } from './types.js';

// Second adversarial review of the rubric: F5 (nothing / too little assessable), F10 (the nice-to-have bonus), F11 (more attribution
// evidence must never lower the checklist) and F13 (a criterion the model never returned is left out, not scored as absent).

const IDS = MARKETING_CRITERIA.map(c => c.id);
const NH_IDS = MARKETING_NICE_TO_HAVES.map(n => n.id);
const DIRECT_QUALITY = MARKETING_CRITERIA.filter(c => c.group !== 'corroboration').map(c => c.id);
const CORROBORATION = MARKETING_CRITERIA.filter(c => c.group === 'corroboration').map(c => c.id);
const TOTAL = MARKETING_CRITERIA.filter(c => c.group !== 'corroboration').reduce((n, c) => n + c.weight, 0);

const crit = (id: string, verdict: CriterionVerdict, over: Partial<CriterionResult> = {}): CriterionResult => {
  const def = MARKETING_CRITERIA.find(c => c.id === id);
  return { id, label: def?.label ?? id, verdict, evidence: '', group: def?.group, weight: def?.weight, basis: verdict === 'not_evidenced' ? 'none' : 'seen', source: verdict === 'not_evidenced' ? '' : 'L1', assessable: true, ...over };
};
const all = (verdict: CriterionVerdict, over: (id: string) => Partial<CriterionResult> = () => ({})): CriterionResult[] => IDS.map(id => crit(id, verdict, over(id)));
/** Every direct and quality criterion not assessable except the ones listed (which take `verdict`). */
const onlyAssessable = (ids: string[], verdict: CriterionVerdict = 'strong'): CriterionResult[] =>
  IDS.map(id => crit(id, ids.includes(id) ? verdict : 'not_evidenced', ids.includes(id) ? {} : { assessable: false }));

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

// ─── F11 ─────────────────────────────────────────────────────────────────────
describe('F11 — eq_ownership counts only when it is strong or a concern (monotone checklist)', () => {
  const ORDER: CriterionVerdict[] = ['concern', 'not_evidenced', 'partial', 'strong'];
  const BASES = ['seen', 'read', 'claimed', 'none'] as const;
  type Row = { verdict: CriterionVerdict; basis: typeof BASES[number]; assessable: boolean };
  const randomRows = (r: () => number, quality: number): Record<string, Row> => {
    const rows: Record<string, Row> = {};
    for (const id of IDS) {
      const x = quality + (r() - 0.5) * 0.6;
      const verdict: CriterionVerdict = r() < 0.03 ? 'concern' : x > 0.7 ? 'strong' : x > 0.4 ? 'partial' : 'not_evidenced';
      rows[id] = { verdict, basis: BASES[Math.floor(r() * 4)], assessable: r() > 0.12 };
    }
    return rows;
  };
  const build = (rows: Record<string, Row>): CriterionResult[] => IDS.map(id => {
    const { verdict, basis, assessable } = rows[id];
    return crit(id, verdict, { basis, source: verdict === 'not_evidenced' ? '' : 'L1', assessable });
  });
  const checklistOf = (rows: Record<string, Row>) => weightedChecklistScore(build(rows));

  it('a plausible owner is as neutral as an unattributable page, strong adds, a concern subtracts: the four states in order', () => {
    const base = { mh1: 'strong', mh3: 'strong', mh4: 'strong', mh5: 'strong', mh6: 'strong', eq_outcomes: 'partial', eq_craft: 'partial', eq_coherence: 'partial', eq_recency: 'partial' } as Record<string, CriterionVerdict>;
    const score = (own: CriterionVerdict) => weightedChecklistScore(IDS.map(id => crit(id, id === 'eq_ownership' ? own : (base[id] ?? 'not_evidenced'))));
    const [c, n, p, s] = ORDER.map(score);
    expect(n).toBe(p);                      // not_evidenced and partial leave the mean alike
    expect(c).toBeLessThan(n);
    expect(s).toBeGreaterThanOrEqual(p);
    // the reviewers' repro: a strong deck, model 8: ownership absent or strong -> 9, ownership partial used to give 8
    expect(marketingScore(8, p, 0)).toBe(marketingScore(8, n, 0));
    expect(marketingScore(8, p, 0)).toBe(marketingScore(8, s, 0));
  });

  it('MONOTONE over thousands of random verdict vectors: every single-step upgrade of any criterion never lowers the checklist, every downgrade never raises it', () => {
    const r = rng(20261022);
    let steps = 0;
    for (let t = 0; t < 5000; t++) {
      const rows = randomRows(r, r());
      const before = checklistOf(rows);
      for (const id of IDS) {
        const at = ORDER.indexOf(rows[id].verdict);
        if (at < 3) {
          const up = checklistOf({ ...rows, [id]: { ...rows[id], verdict: ORDER[at + 1] } });
          steps++;
          if (up < before) throw new Error(`upgrade ${id} ${rows[id].verdict} -> ${ORDER[at + 1]} lowered ${before} -> ${up}: ${JSON.stringify(rows)}`);
        }
        if (at > 0) {
          const down = checklistOf({ ...rows, [id]: { ...rows[id], verdict: ORDER[at - 1] } });
          steps++;
          if (down > before) throw new Error(`downgrade ${id} ${rows[id].verdict} -> ${ORDER[at - 1]} raised ${before} -> ${down}: ${JSON.stringify(rows)}`);
        }
      }
    }
    expect(steps).toBeGreaterThan(100_000);
  });

  it('the reviewer\'s simulator: on 20,000 good-deck vectors moving ownership from not_evidenced to partial lowers the checklist in none (it was 16.6%)', () => {
    const r = rng(777);
    let lowered = 0;
    for (let t = 0; t < 20000; t++) {
      const q = 0.55 + r() * 0.45;
      const rows: Record<string, Row> = {};
      for (const id of IDS) {
        const x = q + (r() - 0.4) * 0.4;
        const verdict: CriterionVerdict = x > 0.72 ? 'strong' : x > 0.42 ? 'partial' : 'not_evidenced';
        rows[id] = { verdict, basis: verdict === 'not_evidenced' ? 'none' : 'seen', assessable: true };
      }
      const absent = checklistOf({ ...rows, eq_ownership: { verdict: 'not_evidenced', basis: 'none', assessable: true } });
      const partial = checklistOf({ ...rows, eq_ownership: { verdict: 'partial', basis: 'seen', assessable: true } });
      if (partial < absent) lowered++;
    }
    expect(lowered).toBe(0);
  });

  it('a not assessable criterion never matters, whatever it says', () => {
    const r = rng(31);
    for (let t = 0; t < 2000; t++) {
      const rows = randomRows(r, r());
      const id = IDS[Math.floor(r() * IDS.length)];
      const flipped = ORDER[Math.floor(r() * 4)];
      const a = checklistOf({ ...rows, [id]: { ...rows[id], assessable: false, verdict: 'strong' } });
      const b = checklistOf({ ...rows, [id]: { ...rows[id], assessable: false, verdict: flipped } });
      expect(a).toBe(b);
    }
  });
});

// ─── F13 ─────────────────────────────────────────────────────────────────────
describe('F13 — a criterion the model never returned is left out, not scored as absent', () => {
  const strongAll = IDS.map(id => ({ id, verdict: 'strong', basis: 'seen', source: 'L1', evidence: 'x' }));
  const ctx: EvidenceContext = { acquired: [{ ref: 'L1', basis: 'artifact', outcome: 'ok', text: '', link: { platform: 'custom' } }], claimText: '' };
  const scoreOf = (omit: string[]) => {
    const raw = strongAll.filter(c => !omit.includes(c.id));
    const checked = enforceEvidenceRules(normalizeMarketingCriteria(raw), ctx).criteria;
    return { checked, checklist: weightedChecklistScore(checked), returned: countReturnedCriteria(raw) };
  };

  it('all strong with mh3, mh5 and eq_craft omitted scores 10 like the same reply with them (it scored 8: silence counted as 0.2)', () => {
    expect(scoreOf([]).checklist).toBe(10);
    const dropped = scoreOf(['mh3', 'mh5', 'eq_craft']);
    expect(dropped.returned).toBe(12);   // the completeness gate (12 of 15) is unchanged
    expect(dropped.checklist).toBe(10);
    for (const id of ['mh3', 'mh5', 'eq_craft']) {
      expect(dropped.checked.find(c => c.id === id)).toMatchObject({ verdict: 'not_evidenced', assessable: false, evidence: NOT_RETURNED_TEXT, basis: 'none', source: '' });
    }
  });

  it('a reply that left out criteria is scored on the others, never lower than it would be for them alone', () => {
    const r = rng(5);
    for (let t = 0; t < 400; t++) {
      const verdicts = IDS.map(() => (['strong', 'partial', 'not_evidenced', 'concern'] as const)[Math.floor(r() * 4)]);
      const answered = IDS.map((id, i) => ({ id, verdict: verdicts[i], basis: 'seen', source: 'L1', evidence: '' }));
      const omit = IDS.filter(() => r() < 0.2).slice(0, 3);
      const full = weightedChecklistScore(normalizeMarketingCriteria(answered.filter(c => !omit.includes(c.id))));
      const asIfAbsent = weightedChecklistScore(normalizeMarketingCriteria([
        ...answered.filter(c => !omit.includes(c.id)), ...omit.map(id => ({ id, verdict: 'not_evidenced', basis: 'none', source: '', evidence: '' })),
      ]));
      // leaving a criterion out can only help a reply whose other verdicts are worse than "not evidenced" would be, and never hurts one whose others are better
      const others = answered.filter(c => !omit.includes(c.id));
      if (others.every(c => c.verdict === 'strong')) expect(full).toBeGreaterThanOrEqual(asIfAbsent);
    }
  });

  it('with no model run the criteria say so (no reviewer failed to return anything)', () => {
    const out = normalizeMarketingCriteria(undefined, 'No review was run');
    expect(out.every(c => c.evidence === 'No review was run' && c.assessable === false)).toBe(true);
  });
});

// ─── F5 ──────────────────────────────────────────────────────────────────────
describe('F5 — what can be assessed decides whether there is a score', () => {
  it('the direct + quality weight is 9.25 and the bar is 40% of it', () => {
    expect(TOTAL).toBeCloseTo(9.25, 10);
    expect(MIN_ASSESSED_SHARE).toBe(0.4);
  });

  it('nothing assessable in the direct and quality groups is mode "none", whatever the corroboration says', () => {
    const none = assessChecklist(onlyAssessable([]));
    expect(none).toMatchObject({ mode: 'none', checklist: 0, assessedWeight: 0, share: 0 });
    // all ten corroboration-and-friends strong cannot make a review out of nothing
    const strongCorroboration = IDS.map(id => crit(id, 'strong', DIRECT_QUALITY.includes(id) ? { assessable: false, verdict: 'not_evidenced' } : {}));
    expect(assessChecklist(strongCorroboration).mode).toBe('none');
    expect(assessChecklist([]).mode).toBe('none');
    expect(assessChecklist(undefined).mode).toBe('none');
    expect(assessChecklist(normalizeMarketingCriteria([])).mode).toBe('none');   // a reply that returned nothing at all
  });

  it('under 40% assessable is mode "model_only"; 40% and over is a blend (exact boundaries from the weights)', () => {
    // mh3 1.5 + eq_outcomes 1 + eq_craft 1 = 3.5 (37.8%): under
    expect(assessChecklist(onlyAssessable(['mh3', 'eq_outcomes', 'eq_craft'])).mode).toBe('model_only');
    // + eq_coherence 0.5 = 4.0 (43.2%): over
    expect(assessChecklist(onlyAssessable(['mh3', 'eq_outcomes', 'eq_craft', 'eq_coherence'])).mode).toBe('blend');
    // mh6 .75 + eq_coherence .5 + eq_recency .5 + mh1 1 + eq_ownership 1 = 3.75 (40.5%): over
    expect(assessChecklist(onlyAssessable(['mh6', 'eq_coherence', 'eq_recency', 'mh1', 'eq_ownership'])).mode).toBe('blend');
    // mh6 .75 + eq_coherence .5 + eq_recency .5 + mh1 1 + mh4 1 = 3.75 too; one less: 2.75 -> under
    expect(assessChecklist(onlyAssessable(['mh6', 'eq_coherence', 'eq_recency', 'mh1'])).mode).toBe('model_only');
    // the two criteria of the review's own example (mh5 strong + eq_craft partial) are 2.0 (21.6%)
    const a = assessChecklist(onlyAssessable(['mh5', 'eq_craft']));
    expect(a.mode).toBe('model_only');
    expect(a.share).toBeCloseTo(2 / 9.25, 10);
    expect(a.assessedWeight).toBe(2);
  });

  it('"assessable" is not "counted in the mean": an eq_ownership that is only partial still counts as assessed, so a verdict upgrade never changes the mode', () => {
    const ids = ['mh6', 'eq_coherence', 'eq_recency', 'mh1', 'eq_ownership'];
    for (const verdict of ['concern', 'not_evidenced', 'partial', 'strong'] as const) {
      expect(assessChecklist(onlyAssessable(ids, verdict)).mode, verdict).toBe('blend');
    }
  });

  it('counts each criterion once, ignores unknown ids and the nice-to-haves, and tolerates hand-built entries without group or weight', () => {
    const list = [...onlyAssessable(['mh3', 'eq_outcomes', 'eq_craft']), crit('mh3', 'strong'), crit('zzz', 'strong'), crit('nh1', 'strong'), { id: 'mh1', label: 'x', verdict: 'strong' as const, evidence: '' }];
    // mh3 appears twice (the first, assessable, counts once), mh1 hand-built counts at its definition's weight: 1.5 + 1 + 1 + 1 = 4.5
    expect(assessChecklist(list).assessedWeight).toBe(4.5);
    expect(assessChecklist(list).mode).toBe('blend');
  });

  describe('scoreMarketing', () => {
    const strongNice = (n: number) => NH_IDS.map((id, i) => crit(id, i < n ? 'strong' : 'not_evidenced'));
    const noNice = strongNice(0);

    it('none: not scored. Score 0 means nothing, the note says why (the reviewer\'s EVERYTHING-not-assessable repro scored 3 and 4)', () => {
      for (const model of [6, 8]) {
        const s = scoreMarketing(model, onlyAssessable([]), noNice);
        expect(s).toMatchObject({ mode: 'none', score: 0, checklist: 0, modelScore: model, assessedShare: 0 });
        expect(s.notes).toEqual([NOTHING_ASSESSABLE_NOTE]);
      }
    });

    it('model_only: the score is the model\'s own number, rounded and clamped, with no bonus and a note (the repro "mh5 strong + eq_craft partial, model 6" scored 7)', () => {
      const crits = IDS.map(id => crit(id, id === 'mh5' ? 'strong' : id === 'eq_craft' ? 'partial' : 'not_evidenced', id === 'mh5' || id === 'eq_craft' ? {} : { assessable: false }));
      const s = scoreMarketing(6, crits, strongNice(4));
      expect(s).toMatchObject({ mode: 'model_only', score: 6, modelScore: 6 });
      expect(s.checklist).toBe(8);   // informational: it is NOT what the score rests on
      expect(s.notes).toEqual([modelOnlyNote(2 / 9.25)]);
      expect(s.notes[0]).toMatch(/Only 22% of the criteria the work can show could be assessed \(the checklist needs 40%\).*reviewer's own judgement, with low confidence/);
      for (const [given, want] of [[7.4, 7], [7.5, 8], [11, 10], [-3, 0], ['6', 6], ['abc', 0], [null, 0], [undefined, 0]] as const) {
        expect(scoreMarketing(given, crits, noNice).score, String(given)).toBe(want);
      }
    });

    it('blend: marketingScore of the model, the checklist and the bonus, with no note', () => {
      const crits = all('strong');
      const s = scoreMarketing(8, crits, strongNice(4));
      expect(s).toMatchObject({ mode: 'blend', checklist: 10, modelScore: 8, score: marketingScore(8, 10, 1), assessedShare: 1 });
      expect(s.score).toBe(9);   // blend 9 + bonus 1 = 10, but never a 10 from the bonus and never more than model + 1
      expect(s.notes).toEqual([]);
    });

    it('the mode never depends on the nice-to-haves or the corroboration criteria', () => {
      const base = onlyAssessable(['mh3', 'eq_outcomes', 'eq_craft']);
      const withCorroboration = base.map(c => (CORROBORATION.includes(c.id) ? { ...c, verdict: 'strong' as const, assessable: true } : c));
      expect(scoreMarketing(5, withCorroboration, strongNice(10)).mode).toBe('model_only');
    });
  });
});

// ─── F10 ─────────────────────────────────────────────────────────────────────
describe('F10 — the nice-to-have bonus is a tie-breaker, never a way past the model\'s own judgement', () => {
  // The reviewers' simulation (sim2): 30,000 model-like vectors with a correlated quality, a model score near it and 0..6 strong nice-to-haves.
  const V = ['concern', 'not_evidenced', 'partial', 'strong'] as const;
  const vector = (r: () => number, q: number) => IDS.map(id => {
    const x = q + (r() - 0.5) * 0.5;
    const verdict: CriterionVerdict = r() < 0.02 ? 'concern' : x > 0.72 ? 'strong' : x > 0.42 ? 'partial' : 'not_evidenced';
    return crit(id, verdict);
  });
  const rows: Array<{ model: number; checklist: number; strong: number; blend: number; final: number }> = [];
  const r = rng(12345);
  for (let i = 0; i < 30000; i++) {
    const q = r();
    const checklist = weightedChecklistScore(vector(r, q));
    const model = Math.max(0, Math.min(10, Math.round(q * 10 + (r() - 0.5) * 3)));
    const strong = Math.min(10, Math.floor(r() * r() * 7));
    rows.push({ model, checklist, strong, blend: (model + checklist) / 2, final: marketingScore(model, checklist, Math.min(1, strong * 0.25)) });
  }

  it('is never more than one point above the model\'s own score (it was 11.5% of vectors)', () => {
    expect(rows.filter(x => x.final > x.model + 1)).toEqual([]);
  });

  it('a 10 only exists where the plain blend already rounds to 10 (22% of the 10s came from the bonus alone; 193 had a blend under 9)', () => {
    expect(rows.filter(x => x.final === 10 && Math.round(x.blend) < 10)).toEqual([]);
    expect(rows.filter(x => x.final === 10 && x.blend < 9)).toEqual([]);
  });

  it('a blend under 6 gets no bonus at all', () => {
    expect(rows.filter(x => x.blend < 6 && x.final !== Math.min(Math.round(x.blend), x.model + 1))).toEqual([]);
  });

  it('the bonus lifts the score by at most one point over the plain blend and never lowers it, and the share of 10s is the natural one', () => {
    expect(rows.filter(x => x.final > Math.round(x.blend) + 1)).toEqual([]);
    expect(rows.filter(x => x.final < Math.min(Math.round(x.blend), x.model + 1))).toEqual([]);
    const tens = rows.filter(x => x.final === 10).length / rows.length;
    const natural = rows.filter(x => Math.round(x.blend) === 10).length / rows.length;
    expect(tens).toBeLessThanOrEqual(natural + 1e-9);
    expect(tens).toBeLessThan(0.11);   // it was 12.5%
  });

  it('is monotone: more strong nice-to-haves, a higher model score or a higher checklist never lowers the final', () => {
    let violations = 0;
    for (const x of rows.slice(0, 5000)) {
      const bonus = Math.min(1, x.strong * 0.25);
      if (marketingScore(x.model, x.checklist, Math.min(1, bonus + 0.25)) < x.final) violations++;
      if (x.model < 10 && marketingScore(x.model + 1, x.checklist, bonus) < x.final) violations++;
      if (x.checklist < 10 && marketingScore(x.model, x.checklist + 1, bonus) < x.final) violations++;
    }
    expect(violations).toBe(0);
    expect(V).toHaveLength(4);
  });

  it('the reviewers\' concrete cases: model 8 + checklist 9 + 4 strong nice-to-haves was 10, model 9 + 9 + 4 was 10, model 7 + 9 + 4 was 9', () => {
    const bonus4 = niceToHaveBonus(NH_IDS.map((id, i) => crit(id, i < 4 ? 'strong' : 'not_evidenced')));
    expect(marketingScore(8, 9, bonus4)).toBe(9);
    expect(marketingScore(9, 9, bonus4)).toBe(9);
    expect(marketingScore(7, 9, bonus4)).toBe(8);
  });
});
