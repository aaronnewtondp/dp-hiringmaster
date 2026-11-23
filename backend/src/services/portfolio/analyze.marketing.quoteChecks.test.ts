import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Candidate, Role } from '../../types/index.js';
import type { Acquired } from './acquire/types.js';

// analysis.quoteChecks through the REAL analyzer (only the Anthropic SDK replaced): recorded for a rejected quote, bounded, free of any
// text of the page or the quote, and with no effect on the verdicts, the score or the audit notes.

const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    messages = { create: (...a: unknown[]) => h.create(...a) };
    constructor(_opts: unknown) { /* not what is tested here */ }
  },
}));

import { analyzeMarketing } from './analyze.marketing.js';
import { MARKETING_CRITERIA, MARKETING_NICE_TO_HAVES, QUOTE_CHECKS_MAX } from './rubric.marketing.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MUST = ['Built a brand', 'Led a team', 'Launched 5+ campaigns', 'Copy', 'Visual', 'Reach', 'Limited resources', 'Mission', 'Pitch', 'Startup'];
const NICE = ['Climate', 'Influencers', 'Video', 'Events', 'Agency', 'B2B', 'Founder', 'Analytics', 'SEO', 'Photography'];
const role = {
  id: 'R019', title: 'Head of Marketing',
  must_have_skills: `Non-negotiable.\n${MUST.map((m, i) => `${i + 1}. ${m}`).join('\n')}`,
  nice_to_have_skills: `Accelerators.\n${NICE.map((m, i) => `${i + 1}. ${m}`).join('\n')}`,
  kpi_expectations: 'Own the brand', generated_jd_content: { aboutRoleParagraph: 'Own the brand.', keyResponsibilities: ['Run campaigns'] },
} as unknown as Role;
const cand = { id: 'C1', full_name: 'Priya Sharma' } as unknown as Candidate;

const entry = (id: string, over: Record<string, unknown> = {}) => ({ id, verdict: 'not_evidenced', basis: 'none', source: '', evidence: '', ...over });
const strong = (evidence: string) => ({ verdict: 'strong', basis: 'read', source: 'L1', evidence });
const reply = (model: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(model) }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 800 } });
const modelJson = (crit: Record<string, Record<string, unknown>>, nice: Record<string, Record<string, unknown>> = {}) => ({
  links: [{ ref: 'L1', summary: 'Work', relevance: 'work_sample', attribution: 'candidate_owned', candidateCredited: true, campaignsSeen: 6, coverage: 'full' }],
  criteria: MARKETING_CRITERIA.map(c => entry(c.id, crit[c.id])), niceToHaves: MARKETING_NICE_TO_HAVES.map(c => entry(c.id, nice[c.id])),
  campaigns: [], modelScore: 8, confidence: 'high', scoreNote: 'x', highlights: ['a'], redFlags: [], unverifiedClaims: [], summary: 's',
});
const PAGE = 'Ostrivant glemmoth prundafel. Brand by Priya Sharma launched the campaign in 2024. The R&amp;D team ran three bold campaigns. Wuxlibar snorgate zindoprell vexturan campaign.';
const link = { url: 'https://agency.example/case/aqua', host: 'agency.example', platform: 'custom' as const, handler: 'site' as const };
const site: Acquired = { ref: 'L1', link, outcome: 'ok', basis: 'artifact', media: [{ kind: 'image', label: 's', mime: 'image/png', b64: PNG, bytes: 70 }], text: PAGE, facts: [], injectionHit: false };

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => { h.create.mockReset(); consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { consoleError.mockRestore(); });
const run = (model: unknown, name = 'Priya Sharma') => {
  h.create.mockResolvedValueOnce(reply(model));
  return analyzeMarketing({ candidate: { ...cand, full_name: name } as Candidate, role, acquired: [site], listedNotReviewed: [], claimText: 'See the links' });
};

describe('analysis.quoteChecks through the analyzer', () => {
  const FAKE = 'Says "zorbulax quimfler plenkarta voshnit dromble"';
  const NAMED = 'Says "Brand by Priya Sharma launched the campaign"';

  it('is recorded for a rejected quote on a criterion and on a nice-to-have, and not at all when every quote holds', async () => {
    const ok = await run(modelJson({ mh3: strong('Says "the R&amp;D team ran three bold campaigns"') }));
    expect(ok.quoteChecks).toBeUndefined();
    const r = await run(modelJson({ mh3: strong(FAKE), mh5: strong(NAMED) }, { nh9: { verdict: 'partial', basis: 'read', source: 'L1', evidence: 'Says "totally made up words about seo"' } }));
    expect(r.quoteChecks!.map(c => [c.criterion, c.outcome])).toEqual([['mh3', 'invented'], ['mh5', 'invented'], ['nh9', 'invented']]);
    // the name was masked to [candidate] before the model read it: the unmasked reading of the fragment explains mh5 and only mh5
    expect(r.quoteChecks!.map(c => c.wouldPassWith.unmasked)).toEqual([false, true, false]);
    expect(r.quoteChecks!.every(c => c.ref === 'L1' && c.itemHadMedia === true)).toBe(true);
  });

  it('changes no verdict and no note: the verdicts and the audit notes are the matcher\'s own', async () => {
    const r = await run(modelJson({ mh3: strong(FAKE), mh5: strong(NAMED), mh4: strong('Says "the R&D team ran three very bold campaigns"') }));
    const verdict = (id: string) => r.criteria.find(c => c.id === id)!.verdict;
    expect([verdict('mh3'), verdict('mh5'), verdict('mh4')]).toEqual(['not_evidenced', 'not_evidenced', 'partial']);
    const notes = r.evidenceNotes!.filter(n => /^mh[345]:/.test(n));
    expect(notes).toContain('mh3: quoted text not found in L1; the quote is invented, so strong lowered to not_evidenced');
    expect(notes).toContain('mh5: quoted text not found in L1; the quote is invented, so strong lowered to not_evidenced');
    expect(notes.some(n => /^mh4: the quote is a near match/.test(n))).toBe(true);
    expect(JSON.stringify(r.evidenceNotes)).not.toMatch(/quoteChecks|wouldPass/);
    expect(r.quoteChecks!.map(c => c.outcome).sort()).toEqual(['invented', 'invented', 'near']);
  });

  it(`never holds more than ${QUOTE_CHECKS_MAX} entries (the evidence text the model may write is itself clipped, so the cap is exercised in rubric.marketing.quoteChecks.test)`, async () => {
    const many = Array.from({ length: 30 }, (_, i) => `"made up claim ${i} here"`).join(' and ');
    const r = await run(modelJson({ mh3: strong(many), mh5: strong(many) }, { nh9: { verdict: 'partial', basis: 'read', source: 'L1', evidence: many } }));
    expect(r.quoteChecks!.length).toBeGreaterThan(0);
    expect(r.quoteChecks!.length).toBeLessThanOrEqual(QUOTE_CHECKS_MAX);
  });

  it('stores nothing of the quote, the page or the name (no word or 4-letter piece of them)', async () => {
    const r = await run(modelJson({ mh3: strong(FAKE), mh5: strong(NAMED), mh4: strong('Says "ostrivant glemmoth made up words here"') }));
    const stored = JSON.stringify(r.quoteChecks).toLowerCase();
    expect(r.quoteChecks!.length).toBe(3);
    for (const word of ['zorbulax', 'quimfler', 'plenkarta', 'voshnit', 'dromble', 'ostrivant', 'glemmoth', 'prundafel', 'wuxlibar', 'snorgate', 'zindoprell', 'vexturan', 'priya', 'sharma', 'candidate', 'brand', 'launched']) {
      for (let i = 0; i + 4 <= word.length; i++) expect(stored, word.slice(i, i + 4)).not.toContain(word.slice(i, i + 4));
    }
  });
});
