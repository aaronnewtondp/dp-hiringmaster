import { describe, it, expect } from 'vitest';
import {
  DESIGNER_CRITERIA, htmlBasedFromPlatforms, capPortfolioUxVerdict, normalizeCriteria,
  clampScore, checklistScore, blendPortfolioScore, computeAvg, stringList,
} from './rubric.js';
import { PortfolioSignals } from './types.js';

const sig = (over: Partial<PortfolioSignals> = {}): PortfolioSignals => ({
  brokenLinksChecked: 10, brokenLinks: 0, brokenLinkSamples: [], consoleErrors: 0,
  failedRequests: 0, mobileOverflow: false, loadMs: 1000, truncated: false, ...over,
});

describe('DESIGNER_CRITERIA', () => {
  it('holds exactly the hiring manager\'s 15 criteria with unique ids', () => {
    expect(DESIGNER_CRITERIA).toHaveLength(15);
    expect(new Set(DESIGNER_CRITERIA.map(c => c.id)).size).toBe(15);
  });
});

describe('htmlBasedFromPlatforms', () => {
  it('own-domain and Framer sites satisfy the HTML preference', () => {
    expect(htmlBasedFromPlatforms(['custom']).verdict).toBe('strong');
    expect(htmlBasedFromPlatforms(['framer']).verdict).toBe('strong');
  });
  it('Behance, Figma files and PDFs are a concern; template builders are partial', () => {
    expect(htmlBasedFromPlatforms(['behance']).verdict).toBe('concern');
    expect(htmlBasedFromPlatforms(['figma_file']).verdict).toBe('concern');
    expect(htmlBasedFromPlatforms(['pdf_file']).verdict).toBe('concern');
    expect(htmlBasedFromPlatforms(['wix']).verdict).toBe('partial');
  });
  it('the best portfolio wins when a candidate lists several', () => {
    expect(htmlBasedFromPlatforms(['behance', 'custom']).verdict).toBe('strong');
  });
  it('is not evidenced when nothing was reviewed', () => {
    expect(htmlBasedFromPlatforms([]).verdict).toBe('not_evidenced');
  });
});

describe('capPortfolioUxVerdict', () => {
  it('leaves a clean site untouched', () => {
    expect(capPortfolioUxVerdict('strong', [sig()]).verdict).toBe('strong');
  });
  it('caps at partial with any broken link or mobile overflow, whatever the model said', () => {
    expect(capPortfolioUxVerdict('strong', [sig({ brokenLinks: 1 })]).verdict).toBe('partial');
    expect(capPortfolioUxVerdict('strong', [sig({ mobileOverflow: true })]).verdict).toBe('partial');
  });
  it('drops to concern when many links are broken', () => {
    expect(capPortfolioUxVerdict('strong', [sig({ brokenLinks: 5 })]).verdict).toBe('concern');
    expect(capPortfolioUxVerdict('strong', [sig({ brokenLinksChecked: 5, brokenLinks: 2 })]).verdict).toBe('concern');
  });
  it('never upgrades a weak model verdict', () => {
    expect(capPortfolioUxVerdict('concern', [sig()]).verdict).toBe('concern');
  });
});

describe('normalizeCriteria', () => {
  it('always returns all 15 in canonical order, filling gaps as not_evidenced', () => {
    const out = normalizeCriteria([{ id: 'storytelling', verdict: 'strong', evidence: 'Case study walks problem to insight' }]);
    expect(out).toHaveLength(15);
    expect(out.map(c => c.id)).toEqual(DESIGNER_CRITERIA.map(c => c.id));
    expect(out.find(c => c.id === 'storytelling')!.verdict).toBe('strong');
    expect(out.find(c => c.id === 'ownership')!.verdict).toBe('not_evidenced');
  });
  it('ignores unknown ids, invalid verdicts and duplicates; clips long evidence', () => {
    const out = normalizeCriteria([
      { id: 'made_up', verdict: 'strong', evidence: 'x' },
      { id: 'ownership', verdict: 'amazing', evidence: 'y'.repeat(1000) },
      { id: 'ownership', verdict: 'strong', evidence: 'dup' },
    ]);
    const own = out.find(c => c.id === 'ownership')!;
    expect(own.verdict).toBe('not_evidenced');
    expect(own.evidence.length).toBeLessThanOrEqual(220);
    expect(out.some(c => c.id === 'made_up')).toBe(false);
  });
  it('survives garbage input', () => {
    expect(normalizeCriteria(undefined)).toHaveLength(15);
    expect(normalizeCriteria('nope' as never)).toHaveLength(15);
  });
});

describe('scores', () => {
  it('clampScore bounds and rounds; non-numbers become 0', () => {
    expect(clampScore(7.6)).toBe(8);
    expect(clampScore(42)).toBe(10);
    expect(clampScore(-3)).toBe(0);
    expect(clampScore('9')).toBe(9);
    expect(clampScore('abc')).toBe(0);
    expect(clampScore(undefined)).toBe(0);
  });
  it('checklistScore reflects coverage', () => {
    const all = (v: 'strong' | 'concern' | 'not_evidenced') =>
      DESIGNER_CRITERIA.map(c => ({ id: c.id, label: c.label, verdict: v, evidence: '' }));
    expect(checklistScore(all('strong'))).toBe(10);
    expect(checklistScore(all('concern'))).toBe(0);
    expect(checklistScore(all('not_evidenced'))).toBe(2);
  });
  it('blend averages model and checklist', () => {
    expect(blendPortfolioScore(8, 4)).toBe(6);
    expect(blendPortfolioScore(10, 10)).toBe(10);
  });
  it('computeAvg is the mean of 8 base dimensions, or 9 with a portfolio score, to 1 decimal', () => {
    const base = [7, 7, 7, 7, 7, 7, 7, 7];
    expect(computeAvg(base)).toBe(7);
    expect(computeAvg(base, 0)).toBe(6.2);   // (56 + 0) / 9
    expect(computeAvg(base, 9)).toBe(7.2);   // (56 + 9) / 9
    expect(computeAvg(base, null)).toBe(7);
  });
  it('stringList trims, drops empties and caps length/count', () => {
    expect(stringList(['  a  ', '', 'b', 'c', 'd'], 3, 10)).toEqual(['a', 'b', 'c']);
    expect(stringList('nope', 3, 10)).toEqual([]);
  });
});
