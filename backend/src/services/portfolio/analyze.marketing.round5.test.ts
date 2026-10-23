import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Candidate, Role } from '../../types/index.js';
import type { Acquired } from './acquire/types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Fix round 5 (FB), through the REAL analyzer with only the Anthropic SDK replaced:
//   B1  a dropped or moved decimal point is an invented figure, not a verbatim quote (fourth review, review4-fairness-rubric; the matcher itself is
//       pinned row by row in rubric.marketing.decimals.test.ts, this is the end-to-end reproduction)
//   B2  a criterion lowered because it rests only on work credited to someone else is blank like every other rule-lowered verdict
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    messages = { create: (...a: unknown[]) => h.create(...a) };
    constructor(_opts: unknown) { /* the key and the timeout are not what is tested here */ }
  },
}));

import { analyzeMarketing } from './analyze.marketing.js';
import { MARKETING_CRITERIA, MARKETING_NICE_TO_HAVES } from './rubric.marketing.js';

// ── Fixtures ────────────────────────────────────────────────────────────────
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MUST = [
  'Built a brand from scratch at a startup', 'Led a creative team', 'Launched 5+ campaigns', 'Writes excellent copy', 'Visual concepts',
  'Reach people at scale', 'Limited resources', 'Mission-driven', 'Pitch and sell', 'Startup operating',
];
const NICE = ['Climate', 'Influencers', 'Video', 'Events', 'Agency', 'B2B', 'Founder', 'Analytics', 'SEO', 'Photography'];
const role = {
  id: 'R019', title: 'Head of Marketing & Creative Direction',
  must_have_skills: `Non-negotiable.\n${MUST.map((m, i) => `${i + 1}. ${m}`).join('\n')}`,
  nice_to_have_skills: `Accelerators.\n${NICE.map((m, i) => `${i + 1}. ${m}`).join('\n')}`,
  kpi_expectations: 'Own the brand', generated_jd_content: { aboutRoleParagraph: 'Own the DigitalPaani brand narrative.', keyResponsibilities: ['Run campaigns', 'Lead creative team'] },
} as unknown as Role;
const cand = (full_name: string) => ({ id: 'C1', full_name } as unknown as Candidate);
const IMG = { kind: 'image' as const, label: 's', mime: 'image/png', b64: PNG, bytes: 70 };

const entry = (id: string, over: Record<string, unknown> = {}) => ({ id, verdict: 'not_evidenced', basis: 'none', source: '', evidence: '', ...over });
const criteria = (over: Record<string, Record<string, unknown>> = {}) => MARKETING_CRITERIA.map(c => entry(c.id, over[c.id]));
const niceToHaves = (over: Record<string, Record<string, unknown>> = {}) => MARKETING_NICE_TO_HAVES.map(c => entry(c.id, over[c.id]));
const ownLink = { ref: 'L1', summary: 'Work', relevance: 'work_sample', attribution: 'candidate_owned', candidateCredited: true, campaignsSeen: 6, coverage: 'full' };
const modelJson = (over: Record<string, unknown> = {}) => ({
  links: [ownLink], criteria: criteria(), niceToHaves: niceToHaves(),
  campaigns: [], modelScore: 8, confidence: 'high', scoreNote: 'x', highlights: ['a'], redFlags: [], unverifiedClaims: [], summary: 's', ...over,
});
const reply = (model: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(model) }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 800 } });

const mkLink = (url: string) => ({ url, host: new URL(url).hostname, platform: 'custom' as const, handler: 'site' as const });
const site = (over: Partial<Acquired> = {}, url = 'https://agency.example/case/aqua'): Acquired =>
  ({ ref: 'L1', link: mkLink(url), outcome: 'ok', basis: 'artifact', media: [IMG], text: '', facts: ['3 pages captured'], injectionHit: false, ...over });

async function run(name: string, acquired: Acquired[], model: unknown) {
  h.create.mockResolvedValueOnce(reply(model));
  return analyzeMarketing({ candidate: cand(name), role, acquired, listedNotReviewed: [], claimText: 'See the links' });
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => { h.create.mockReset(); consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { consoleError.mockRestore(); });

type Row = { id: string; verdict: string; basis: string; source: string; evidence: string };
const crit = (r: { criteria: unknown[] }, id: string): Row => (r.criteria as Row[]).find(c => c.id === id)!;
const notesFor = (r: { evidenceNotes?: string[] }, id: string): string[] => (r.evidenceNotes ?? []).filter(n => n.startsWith(`${id}: `));

// ═════════════════════════════════════════════════════════════════════════════
describe('B1: the fourth review\'s real-analyzer reproduction (3.5% quoted as 35%)', () => {
  const TEXT = 'Clean Water Week case study. Engagement rose 3.5% in the quarter after launch. Reach 2.1M across 14 cities. '.repeat(3);
  const go = (quote: string) => run('Zed Quux', [site({ text: TEXT })], modelJson({
    criteria: criteria({
      eq_outcomes: { verdict: 'strong', basis: 'read', source: 'L1', evidence: `Reports "${quote}"` },
      mh3: { verdict: 'partial', basis: 'seen', source: 'L1', evidence: 'x' },
    }),
  }));

  it('the honest quote (3.5%) keeps its strong verdict, its evidence and no note', async () => {
    const r = await go('Engagement rose 3.5% in the quarter after launch');
    expect(crit(r, 'eq_outcomes')).toMatchObject({ verdict: 'strong', basis: 'read', source: 'L1', evidence: 'Reports "Engagement rose 3.5% in the quarter after launch"' });
    expect(notesFor(r, 'eq_outcomes')).toEqual([]);
  });

  it('the same quote with the decimal point dropped (35%) is an invented quote: not evidenced, blank, with a note, and the 10x figure is nowhere in the stored review', async () => {
    const r = await go('Engagement rose 35% in the quarter after launch');
    expect(crit(r, 'eq_outcomes')).toMatchObject({ verdict: 'not_evidenced', basis: 'none', source: '', evidence: '' });
    expect(notesFor(r, 'eq_outcomes')).toEqual(['eq_outcomes: quoted text not found in L1; the quote is invented, so strong lowered to not_evidenced']);
    expect(JSON.stringify(r)).not.toContain('35%');
  });

  it('a different invented decimal (8.5%) is rejected the same way (the control that always worked)', async () => {
    const r = await go('Engagement rose 8.5% in the quarter after launch');
    expect(crit(r, 'eq_outcomes')).toMatchObject({ verdict: 'not_evidenced', basis: 'none', source: '', evidence: '' });
    expect(notesFor(r, 'eq_outcomes')).toHaveLength(1);
  });

  it('through the analyzer, the invented figure moves the checklist exactly as any rejected quote does: below the honest quote\'s', async () => {
    const honest = await go('Engagement rose 3.5% in the quarter after launch');
    const slip = await go('Engagement rose 35% in the quarter after launch');
    expect(slip.checklistScore).toBeLessThan(honest.checklistScore);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('B2: a verdict that rests only on work credited to someone else is blank, like every other rule-lowered verdict', () => {
  const CREDIT = 'Concept and direction: Amit Verma, Creative Director';
  const longText = (extra: string) => `Brand Playbook 2024 for Clean Water Week.\n${CREDIT}\n${extra}\nObjective: raise awareness of wastewater reuse across 40 industrial sites.\nResults: 2.1M reach, 38% uplift in enquiries, 14 press mentions. `.repeat(3);
  const WORK = 'Reached 14 cities in 6 weeks';
  const OTHER = { ref: 'L2', summary: 'Agency case', relevance: 'work_sample', attribution: 'other_person', candidateCredited: false, creditQuote: CREDIT, campaignsSeen: 4, coverage: 'full' };
  const acquired = (): Acquired[] => [
    site({ ref: 'L1', text: 'Aqua rebrand by Neha Sharma. Five campaigns shown in this portfolio, each with a brief, a concept and results.' }, 'https://nehasharma.example/work'),
    site({ ref: 'L2', text: longText(`${WORK} after the launch.`) }, 'https://agency.example/case/other'),
  ];
  const praise = (source: string, verdict = 'strong') => ({ verdict, basis: 'read', source, evidence: `ok "${WORK}"` });
  const model = (praiseWord = 'ok') => modelJson({
    links: [{ ...ownLink, campaignsSeen: 4 }, OTHER],
    criteria: criteria({
      mh3: { ...praise('L2'), evidence: `${praiseWord} "${WORK}"` },                 // rests only on L2: lowered, blanked
      mh5: { ...praise('L2', 'partial'), evidence: `${praiseWord} "${WORK}"` },      // a partial, the same
      mh4: { ...praise('L1, L2'), evidence: `${praiseWord} "${WORK}"` },             // cites the candidate's own link too: stands
      mh6: { verdict: 'not_evidenced', basis: 'none', source: 'L2', evidence: 'Nothing here shows distribution' },   // already not evidenced: left as written
      eq_ownership: { ...praise('L2', 'partial'), evidence: `${praiseWord} "${WORK}"` },             // exempt
    }),
    niceToHaves: niceToHaves({
      nh3: { ...praise('L2'), evidence: `${praiseWord} "${WORK}"` },                 // a nice-to-have resting only on L2
      nh5: { ...praise('L1, L2'), evidence: `${praiseWord} "${WORK}"` },
    }),
  });

  it('the lowered criteria lose basis, source and evidence; the reason is in the audit note with the criterion id; nothing else changes', async () => {
    const r = await run('Neha Sharma', acquired(), model());
    // the label stood (a checked credit line on text searched without the name), so L2 is "someone else's work"
    expect((r.portfolios.find(p => p.ref === 'L2') as { attribution?: string }).attribution).toBe('other_person');

    expect(crit(r, 'mh3')).toMatchObject({ verdict: 'not_evidenced', basis: 'none', source: '', evidence: '' });
    expect(crit(r, 'mh5')).toMatchObject({ verdict: 'not_evidenced', basis: 'none', source: '', evidence: '' });
    expect(notesFor(r, 'mh3')).toEqual(['mh3: rests only on work credited to someone else; strong lowered to not_evidenced']);
    expect(notesFor(r, 'mh5')).toEqual(['mh5: rests only on work credited to someone else; partial lowered to not_evidenced']);
    expect(notesFor(r, 'nh3')).toEqual(['nh3: rests only on work credited to someone else; strong lowered to not_evidenced']);
    // the rejected wording is not kept anywhere in the audit notes either
    expect((r.evidenceNotes ?? []).join(' | ')).not.toContain(WORK);

    // what the card renders (jdAlignment) is blank too
    const nh3 = MARKETING_NICE_TO_HAVES.findIndex(n => n.id === 'nh3');
    expect(r.jdAlignment.niceToHaves[nh3]).toMatchObject({ verdict: 'not_evidenced', evidence: '' });
    const mh3 = MARKETING_CRITERIA.findIndex(c => c.id === 'mh3');
    expect(r.jdAlignment.mustHaves[mh3]).toMatchObject({ verdict: 'not_evidenced', evidence: '' });

    // untouched: a verdict that also cites the candidate's own link, the exempt ownership criterion, and a verdict that was not_evidenced to begin with
    expect(crit(r, 'mh4')).toMatchObject({ verdict: 'strong', basis: 'read', source: 'L1, L2', evidence: `ok "${WORK}"` });
    expect(crit(r, 'eq_ownership')).toMatchObject({ verdict: 'partial', evidence: `ok "${WORK}"` });
    expect(crit(r, 'mh6')).toMatchObject({ verdict: 'not_evidenced', evidence: 'Nothing here shows distribution' });
    expect(r.jdAlignment.niceToHaves[MARKETING_NICE_TO_HAVES.findIndex(n => n.id === 'nh5')]).toMatchObject({ verdict: 'strong', evidence: `ok "${WORK}"` });
  });

  it('only the evidence text changed: the score, the checklist, the caps and every note are identical whatever praise the model wrote', async () => {
    const a = await run('Neha Sharma', acquired(), model('ok'));
    const b = await run('Neha Sharma', acquired(), model('a really remarkable result'));
    expect(b.score).toBe(a.score);
    expect(b.checklistScore).toBe(a.checklistScore);
    expect(b.caps).toEqual(a.caps);
    expect(b.evidenceNotes).toEqual(a.evidenceNotes);
    expect(b.criteria.map(c => [c.id, c.verdict, c.basis, c.source])).toEqual(a.criteria.map(c => [c.id, c.verdict, c.basis, c.source]));
  });

  it('without a link credited to someone else nothing is lowered or blanked (the guard does not apply)', async () => {
    const r = await run('Neha Sharma', acquired(), { ...model(), links: [{ ...ownLink, campaignsSeen: 4 }, { ...OTHER, attribution: 'candidate_owned', candidateCredited: true, creditQuote: '' }] });
    expect(crit(r, 'mh3')).toMatchObject({ verdict: 'strong', evidence: `ok "${WORK}"` });
    expect(notesFor(r, 'mh3')).toEqual([]);
  });
});
