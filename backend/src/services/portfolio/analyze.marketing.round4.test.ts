import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Candidate, Role } from '../../types/index.js';
import { addressForText, fromCaptured } from './acquire/index.js';
import type { Acquired } from './acquire/types.js';
import type { CapturedPortfolio } from './capture.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Fix round 4 (E3A): the analyzer-level findings of the third review, through the REAL analyzer with only the Anthropic SDK replaced.
//   G6  a query string or fragment the candidate appends to a link must never feed the name search (the "Page: <title> (<address>)" header)
//   G7  a huge form name must not pin the worker
//   G8  an ownership "concern" needs a credit line it quotes (like other_person), or a contradicted claim it quotes
//   G11 every variant spelling the signal reads as the name is masked, and the hint line only says "shown as [candidate]" when it is
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    messages = { create: (...a: unknown[]) => h.create(...a) };
    constructor(_opts: unknown) { /* the key and the timeout are not what is tested here */ }
  },
}));

import { analyzeMarketing, type ContentBlock, type MarketingAnalyzeInput } from './analyze.marketing.js';
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
const STRONG = { verdict: 'strong', basis: 'read', source: 'L1', evidence: 'ok' };
const criteria = (over: Record<string, Record<string, unknown>> = {}) => MARKETING_CRITERIA.map(c => entry(c.id, over[c.id]));
const niceToHaves = () => MARKETING_NICE_TO_HAVES.map(c => entry(c.id));
const ownLink = { ref: 'L1', summary: 'Work', relevance: 'work_sample', attribution: 'candidate_owned', candidateCredited: true, campaignsSeen: 6, coverage: 'full' };
const modelJson = (over: Record<string, unknown> = {}) => ({
  links: [ownLink], criteria: criteria({ mh3: STRONG, mh5: STRONG, mh4: STRONG, eq_outcomes: STRONG, eq_craft: STRONG, eq_ownership: STRONG }), niceToHaves: niceToHaves(),
  campaigns: [], modelScore: 8, confidence: 'high', scoreNote: 'x', highlights: ['a'], redFlags: [], unverifiedClaims: [], summary: 's', ...over,
});
const reply = (model: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(model) }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 800 } });

const mkLink = (url: string) => ({ url, host: new URL(url).hostname, platform: 'custom' as const, handler: 'site' as const });
const site = (over: Partial<Acquired> = {}, url = 'https://agency.example/case/aqua'): Acquired =>
  ({ ref: 'L1', link: mkLink(url), outcome: 'ok', basis: 'artifact', media: [IMG], text: '', facts: ['3 pages captured'], injectionHit: false, ...over });

async function run(name: string, acquired: Acquired[], model: unknown = modelJson(), over: Partial<MarketingAnalyzeInput> = {}) {
  h.create.mockResolvedValueOnce(reply(model));
  return analyzeMarketing({ candidate: cand(name), role, acquired, listedNotReviewed: [], claimText: 'See the links', ...over });
}
const requestBlocks = (): ContentBlock[] => (h.create.mock.calls[h.create.mock.calls.length - 1][0] as { messages: Array<{ content: ContentBlock[] }> }).messages[0].content;
const requestText = (): string => requestBlocks().filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('\n');
const wholeRequest = (): string => JSON.stringify(h.create.mock.calls[h.create.mock.calls.length - 1][0]);
const hintLine = (): string => requestText().split('\n').find(l => /The system (found|did not find) the candidate's name/.test(l)) ?? '';

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => { h.create.mockReset(); consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { consoleError.mockRestore(); });

const longText = (credit: string) => `Brand Playbook 2024 for Clean Water Week.\n${credit}\nObjective: raise awareness of wastewater reuse across 40 industrial sites.\nResults: 2.1M reach, 38% uplift in enquiries, 14 press mentions. Our approach combined film, events, and LinkedIn thought leadership. `.repeat(4);
const CREDIT = 'Concept and direction: Amit Verma, Creative Director';
const OTHER = { ...ownLink, attribution: 'other_person', candidateCredited: false, creditQuote: CREDIT };
const cap2 = (r: { score: number; caps?: string[] }) => r.score === 2 && (r.caps ?? []).includes('Work credited to someone else: capped at 2');

// ═════════════════════════════════════════════════════════════════════════════
describe('G6: nothing the candidate appends to a link reaches the name search', () => {
  const page = (title: string, url: string, text: string) => ({ url, title, text, shots: [] as Array<{ label: string; data: string }> });
  const signals = { brokenLinksChecked: 0, brokenLinks: 0, brokenLinkSamples: [], consoleErrors: 0, failedRequests: 0, mobileOverflow: null, loadMs: null, truncated: false };
  const captured = (url: string, loadedUrl = url): CapturedPortfolio =>
    ({ link: mkLink(url), access: 'ok', pages: [page('Aqua case study', loadedUrl, longText(CREDIT))], signals }) as unknown as CapturedPortfolio;

  describe('addressForText', () => {
    it.each([
      ['https://agency.example/case/aqua?by=Neha+Sharma', 'https://agency.example/case/aqua'],
      ['https://agency.example/case/aqua#Neha-Sharma', 'https://agency.example/case/aqua'],
      ['https://agency.example/case/aqua?ref=neha_sharma&utm_source=x#top', 'https://agency.example/case/aqua'],
      ['https://www.behance.net/gallery/123/Aqua?owner=Neha-Sharma', 'https://www.behance.net/gallery/123/Aqua'],
      ['https://neha:secret@agency.example/case/aqua?x=1', 'https://agency.example/case/aqua'],
      ['https://x.test/', 'https://x.test/'],
      ['https://x.test/work', 'https://x.test/work'],
    ])('%s -> %s', (given, expected) => { expect(addressForText(given)).toBe(expected); });
    it('an address that does not parse is cut at the first ? or #, and a non-string is nothing', () => {
      expect(addressForText('not a url?by=Neha')).toBe('not a url');
      expect(addressForText('agency.example/case#neha-sharma')).toBe('agency.example/case');
      expect(addressForText(undefined)).toBe('');
      expect(addressForText(42)).toBe('');
    });
  });

  it.each([
    ['?by=Neha+Sharma', 'https://agency.example/case/aqua?by=Neha+Sharma'],
    ['#fragment', 'https://agency.example/case/aqua#Neha-Sharma'],
    ['?ref=neha_sharma', 'https://agency.example/case/aqua?ref=neha_sharma'],
    ['a Behance ?owner=', 'https://www.behance.net/gallery/123/Aqua?owner=Neha-Sharma'],
  ])('through fromCaptured, a link with %s still reads as "searched, name not found", and the credit to another person still caps at 2', async (_what, url) => {
    const a = fromCaptured(captured(url), 'L1');
    expect(a.text.split('\n')[0]).toBe(`Page: Aqua case study (${url.split(/[?#]/)[0]})`);
    expect(a.text).not.toMatch(/neha|sharma/i);
    const r = await run('Neha Sharma', [a], modelJson({ links: [OTHER] }));
    expect(hintLine()).toContain('did not find');
    expect(cap2(r)).toBe(true);
    expect(r.portfolios[0].attribution).toBe('other_person');
  });

  it('even when a "Page: ... (address)" line that still carries the query reaches the analyzer (mid-line too), the haystack leaves it out', async () => {
    const header = 'Page: Aqua case study (https://agency.example/case/aqua?by=Neha+Sharma)';
    const text = `${header}\n${longText(CREDIT)}`.replace('Brand Playbook 2024', `Brand Playbook 2024 ${header}`);
    const r = await run('Neha Sharma', [site({ text })], modelJson({ links: [OTHER] }));
    expect(hintLine()).toContain('did not find');
    expect(cap2(r)).toBe(true);
  });

  it('control: the name written in the body of the page IS found (and the credit then does not cap)', async () => {
    const r = await run('Neha Sharma', [site({ text: longText(`${CREDIT}\nTeam: Neha Sharma (copy)`) })], modelJson({ links: [OTHER] }));
    expect(hintLine()).toContain('found the candidate\'s name');
    expect(cap2(r)).toBe(false);
  });

  it('the page TITLE is still searched (it is the page\'s own heading)', async () => {
    const a = fromCaptured({ ...captured('https://agency.example/case/aqua'), pages: [page('Neha Sharma | Aqua case study', 'https://agency.example/case/aqua', longText(CREDIT))] } as CapturedPortfolio, 'L1');
    await run('Neha Sharma', [a], modelJson({ links: [OTHER] }));
    expect(hintLine()).toContain('found the candidate\'s name');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('G7: a huge form name does not pin the worker', () => {
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'];
  const mkName = (n: number) => Array.from({ length: n }, (_, i) => `${words[i % 26]}${'abcdefghij'[i % 10]}${'abcdefghij'[(i * 7) % 10]}${'abcdefghij'[(i * 3) % 10]}`).join(' ');
  const para = 'Brand deck: campaign reach 2.1M, 38% uplift in enquiries versus the previous quarter. We launched six campaigns across fourteen cities with a team of four and a modest budget. ';
  const text = para.repeat(Math.floor(30_000 / para.length));
  const items = () => Array.from({ length: 5 }, (_, i) => site({ ref: `L${i + 1}`, text, link: mkLink(`https://site${i}.example/work`) }));
  const timed = async (name: string): Promise<number> => {
    const t0 = performance.now();
    await run(name, items(), modelJson({ links: [] }));
    return performance.now() - t0;
  };

  it('analyzeMarketing over 5 items x 30 KB with a 3,000-token name takes about as long as with a normal one (it was minutes)', async () => {
    const normal = await timed('Priya Sharma');   // also warms the regular expressions up
    const huge = await timed(mkName(3000));
    expect(normal).toBeGreaterThan(0);
    expect(huge).toBeLessThan(1000);
  });
  it('a 300-token name over the same input stays flat too', async () => {
    const t = await timed(mkName(300));
    expect(t).toBeLessThan(1500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('G8: an ownership concern needs a credit line it quotes, or a contradicted claim it quotes', () => {
  const concern = (evidence: string, over: Record<string, unknown> = {}) =>
    criteria({ mh3: STRONG, mh5: STRONG, mh4: STRONG, eq_outcomes: STRONG, eq_craft: STRONG, eq_ownership: { verdict: 'concern', basis: 'read', source: 'L1', evidence, ...over } });
  const own = (attribution: string) => [{ ...ownLink, attribution }];
  const crit = (r: { criteria: Array<{ id: string }> }, id: string) => r.criteria.find(c => c.id === id) as unknown as { verdict: string; basis: string; source: string };
  const ownershipFlag = (r: { redFlags: string[] }) => r.redFlags.some(f => /^Ownership concern:/.test(f));

  it('S5: a brand page that names nobody, concern without a quote -> not evidenced, no flag, no cap', async () => {
    const r = await run('Neha Sharma', [site({ text: longText('All work (c) Aqua Brands Pvt Ltd') })], modelJson({ criteria: concern('The page does not show the candidate and credits another party'), links: own('unknown') }));
    expect(crit(r, 'eq_ownership')).toMatchObject({ verdict: 'not_evidenced', basis: 'none', source: '' });
    expect(ownershipFlag(r)).toBe(false);
    expect(r.caps).toEqual([]);
    expect(r.score).toBeGreaterThan(3);
    expect(r.evidenceNotes!.some(n => /^eq_ownership: a concern about whose work it is was lowered to not_evidenced: it quotes no credit line/.test(n))).toBe(true);
  });
  it('S9: a Devanagari deck read against a Latin form name -> the concern is lowered, with or without an unverifiable quote', async () => {
    const deck = 'ब्रांड प्लेबुक 2024\nतैयार किया: प्रिया शर्मा, ब्रांड प्रमुख\nपहुँच 2.1 मिलियन, पूछताछ में 38% वृद्धि\n'.repeat(8);
    for (const evidence of ['credits someone else', 'credits "तैयार किया: प्रिया शर्मा, ब्रांड प्रमुख", a different person']) {
      const r = await run('Priya Sharma', [site({ text: deck })], modelJson({ criteria: concern(evidence), links: own('unknown') }));
      expect(crit(r, 'eq_ownership').verdict, evidence).toBe('not_evidenced');
      expect(ownershipFlag(r), evidence).toBe(false);
      expect(r.caps, evidence).toEqual([]);
    }
  });
  it('S4: a concern that quotes a credit line really in the text, naming a different full person, on a link searched without the name, still stands (flag, and the cap of 3)', async () => {
    const r = await run('Neha Sharma', [site({ text: longText(CREDIT) })], modelJson({ criteria: concern(`credits "${CREDIT}" so a different person`), links: own('unknown') }));
    expect(crit(r, 'eq_ownership').verdict).toBe('concern');
    expect(ownershipFlag(r)).toBe(true);
    expect(r.score).toBe(3);
    expect(r.caps).toContain('Work credited to a different person or contradicting the claim: capped at 3');
  });
  it('a quote that is not in the text, or names nobody, or has no role word, or names [candidate], does not carry a concern', async () => {
    const text = longText(CREDIT);
    for (const evidence of [
      'credits "Concept and direction: Rohit Malhotra, Creative Director", a different person',
      'credits "Results: 2.1M reach, 38% uplift in enquiries", a different person',
      'credits "Our approach combined film, events, and LinkedIn thought leadership", a different person',
    ]) {
      const r = await run('Neha Sharma', [site({ text })], modelJson({ criteria: concern(evidence), links: own('unknown') }));
      expect(crit(r, 'eq_ownership').verdict, evidence).not.toBe('concern');
      expect(ownershipFlag(r), evidence).toBe(false);
      expect(r.caps, evidence).toEqual([]);
    }
  });
  it('a concern on a link whose other_person label stood (its credit line was checked) stands without a second quote', async () => {
    const r = await run('Neha Sharma', [site({ text: longText(CREDIT) })], modelJson({ criteria: concern('credits a different person'), links: [OTHER] }));
    expect(crit(r, 'eq_ownership').verdict).toBe('concern');
    expect(cap2(r)).toBe(true);
    expect(ownershipFlag(r)).toBe(true);
  });
  it('the candidate\'s name IS in the cited link: the concern comes down to partial, no flag, no cap', async () => {
    const r = await run('Neha Sharma', [site({ text: longText(`${CREDIT}\nTeam: Neha Sharma (copy)`) })], modelJson({ criteria: concern(`credits "${CREDIT}" so a different person`), links: own('unknown') }));
    expect(crit(r, 'eq_ownership').verdict).toBe('partial');
    expect(ownershipFlag(r)).toBe(false);
    expect(r.caps).toEqual([]);
  });
  it('a claim the work contradicts still stands when the concern quotes words really in the text (and nothing else carries it)', async () => {
    const claimed = 'I created the entire Aqua rebrand myself';
    const text = 'Aqua rebrand case study. The Aqua rebrand was created by Amit Verma with a team of six. Results: 2.1M reach and 38% uplift in enquiries across fourteen cities.';
    const real = await run('Neha Sharma', [site({ text, outcome: 'partial' })], modelJson({ criteria: concern('contradicts the claim: "The Aqua rebrand was created by Amit Verma with a team of six"'), links: own('unknown') }), { claimText: claimed });
    expect(crit(real, 'eq_ownership').verdict).toBe('concern');
    const vague = await run('Neha Sharma', [site({ text, outcome: 'partial' })], modelJson({ criteria: concern('contradicts the claim, the page credits somebody else'), links: own('unknown') }), { claimText: claimed });
    expect(crit(vague, 'eq_ownership').verdict).not.toBe('concern');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('G11: what the signal reads as the candidate\'s name is masked, and the hint says so only when it is true', () => {
  const VARIANTS: Array<[name: string, text: string, gone: string[]]> = [
    ['Shreya Ghoshal', `Brand Playbook\nConcept and direction: Sreya Ghosal, Creative Director. Reach 2.1M.\n${'Results across fourteen cities with a team of four. '.repeat(3)}`, ['Sreya', 'Ghosal']],
    ['Mohammed Imran Khan', `Brand Playbook\nProduced by Md. Imran Khan, Founder. Reach 2.1M.\n${'Results across fourteen cities with a team of four. '.repeat(3)}`, ['Md.', 'Imran', 'Khan']],
    ['Priya Sharma', `Brand Playbook\nBy Priyaa Sharmaa and PriyaSharmaCreative. Reach 2.1M.\n${'Results across fourteen cities with a team of four. '.repeat(3)}`, ['Priyaa', 'Sharmaa', 'PriyaSharma']],
    ['Priya Sharma', `Brand Playbook\nCreative Lead: P. Sharma. Reach 2.1M.\n${'Results across fourteen cities with a team of four. '.repeat(3)}`, ['Sharma']],
  ];
  it.each(VARIANTS)('%s: no variant spelling is anywhere in the request, and the hint line is true', async (name, text, gone) => {
    await run(name, [site({ text })]);
    const all = wholeRequest();
    for (const g of gone) expect(all, `leaked: ${g}`).not.toContain(g);
    expect(requestText()).toContain('[candidate]');
    expect(hintLine()).toContain('found the candidate\'s name');
    expect(hintLine()).toContain('(it is shown as [candidate])');
  });
  it('the variant in the written answer and in the web address is masked too', async () => {
    await run('Shreya Ghoshal', [site({ text: longText(CREDIT), link: mkLink('https://example.com/work/Shreya-Ghoshal-Aqua') })], modelJson(), { claimText: 'Ghoshal, Shreya here. My work: https://example.com/work/Shreya-Ghoshal-Aqua' });
    const all = wholeRequest();
    expect(all).not.toMatch(/ghoshal|shreya/i);
  });
  it('another person with a shared surname stays readable (and the hint claims nothing: a lone surname decides nothing)', async () => {
    await run('Neha Sharma', [site({ text: longText('Concept and direction: Amit Sharma, Creative Director') })], modelJson({ links: [{ ...OTHER, creditQuote: 'Concept and direction: Amit Sharma, Creative Director' }] }));
    expect(requestText()).toContain('Concept and direction: Amit Sharma, Creative Director');
    expect(hintLine()).toBe('');
  });
  it('a name only in the part of the page that is cut off is found by the signal but never shown: the hint does not say "shown as [candidate]"', async () => {
    const filler = 'Results across fourteen cities with a team of four and a modest budget. '.repeat(190);   // about 13,700 characters, more than an item may send (12,000)
    await run('Priya Sharma', [site({ text: `${filler}\nCredits: Priya Sharma` })]);
    expect(hintLine()).toContain('found the candidate\'s name');
    expect(hintLine()).not.toContain('shown as [candidate]');
    expect(wholeRequest()).not.toContain('Priya');
  });
});
