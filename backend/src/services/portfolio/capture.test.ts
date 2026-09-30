import { describe, it, expect } from 'vitest';
import { detectAccessProblem, pickInternalPages, classifyLoadFailure } from './capture.js';

describe('detectAccessProblem', () => {
  it('treats 401/403 and 404/410 as the candidate\'s link not working', () => {
    expect(detectAccessProblem(403, 'https://x.com', 'x')?.kind).toBe('blocked');
    expect(detectAccessProblem(401, 'https://x.com', 'x')?.kind).toBe('blocked');
    expect(detectAccessProblem(404, 'https://x.com', 'x')?.kind).toBe('blocked');
    expect(detectAccessProblem(410, 'https://x.com', 'x')?.kind).toBe('blocked');
  });
  it('treats a 5xx as our-side/transient, not held against the candidate', () => {
    expect(detectAccessProblem(503, 'https://x.com', 'x')?.kind).toBe('error');
  });
  it('recognises a private Figma file by its login redirect or request-access wall', () => {
    expect(detectAccessProblem(200, 'https://www.figma.com/login?next=/file/abc', '')?.kind).toBe('blocked');
    expect(detectAccessProblem(200, 'https://www.figma.com/design/abc', 'You need access to this file. Request access')?.kind).toBe('blocked');
  });
  it('recognises a short soft-404 page but not a long real page that merely mentions it', () => {
    expect(detectAccessProblem(200, 'https://x.com/gone', 'Page not found')?.kind).toBe('blocked');
    const longPage = 'Case study: we reduced "page not found" errors by 40%. '.repeat(30);
    expect(detectAccessProblem(200, 'https://x.com/work', longPage)).toBeNull();
  });
  it('returns null for a healthy page', () => {
    expect(detectAccessProblem(200, 'https://x.com', 'A perfectly normal portfolio page with real content.')).toBeNull();
  });
});

describe('pickInternalPages', () => {
  const anchors = (paths: string[], base = 'https://jane.design') => paths.map(p => ({ href: `${base}${p}`, text: p.replace(/\W+/g, ' ') }));
  it('keeps same-host pages, drops other hosts, assets, anchors and the home page itself', () => {
    const picked = pickInternalPages([
      ...anchors(['/work/case-1', '/about', '/cv.pdf', '/img/a.png', '/']),
      { href: 'https://other.com/work', text: 'work' },
      { href: 'mailto:jane@jane.design', text: 'mail' },
    ], 'https://jane.design', new Set(), 5);
    expect(picked.some(u => u.includes('other.com'))).toBe(false);
    expect(picked.some(u => u.endsWith('.pdf') || u.endsWith('.png') || u.startsWith('mailto'))).toBe(false);
    expect(picked).toContain('https://jane.design/work/case-1');
  });
  it('ranks case-study-looking pages first and respects the max', () => {
    const picked = pickInternalPages(anchors(['/contact', '/about', '/work/dashboard-redesign', '/projects/app']), 'https://jane.design', new Set(), 2);
    expect(picked).toHaveLength(2);
    expect(picked.every(u => /work|projects/.test(u))).toBe(true);
  });
  it('skips pages already visited (scheme/www/trailing-slash insensitive origin+path)', () => {
    const visited = new Set(['https://jane.design/work/case-1']);
    expect(pickInternalPages(anchors(['/work/case-1/', '/work/case-2']), 'https://jane.design', visited, 5)).toEqual(['https://jane.design/work/case-2']);
  });
  it('treats www and non-www as the same site', () => {
    expect(pickInternalPages([{ href: 'https://www.jane.design/work/x', text: 'x' }], 'https://jane.design', new Set(), 3)).toHaveLength(1);
  });
});

describe('classifyLoadFailure', () => {
  it('a non-network error is our problem, not the candidate\'s', async () => {
    const r = await classifyLoadFailure('net::ERR_ABORTED', 'https://example.invalid');
    expect(r.kind).toBe('error');
  });
});

import { pickExternalCaseStudies } from './capture.js';
describe('pickExternalCaseStudies', () => {
  const a = (hrefs: string[]) => hrefs.map(h => ({ href: h, text: 'case study' }));
  it('follows outbound Figma prototypes / Behance projects but not arbitrary sites or platform homepages', () => {
    const picked = pickExternalCaseStudies(a([
      'https://www.figma.com/proto/abc/Case-Study?node-id=1-2',
      'https://www.figma.com/',                      // platform homepage
      'https://www.behance.net/gallery/123/project',
      'https://twitter.com/jane', 'https://example.com/blog', 'https://www.linkedin.com/in/jane',
    ]), 'https://jane.design', new Set(), 5);
    expect(picked).toEqual(['https://www.figma.com/proto/abc/Case-Study?node-id=1-2', 'https://www.behance.net/gallery/123/project']);
  });
  it('never picks a link on the portfolio\'s own host, respects max, and skips visited pages', () => {
    const visited = new Set(['https://www.figma.com/proto/abc/x']);
    const picked = pickExternalCaseStudies(a([
      'https://www.figma.com/proto/abc/x', 'https://www.figma.com/proto/def/y', 'https://www.figma.com/design/ghi/z', 'https://www.figma.com/design/jkl/w',
    ]), 'https://jane.design', visited, 2);
    expect(picked).toHaveLength(2);
    expect(picked.some(u => u.includes('/abc/x'))).toBe(false);
    expect(pickExternalCaseStudies(a(['https://jane.design/work']), 'https://jane.design', new Set())).toEqual([]);
  });
});
