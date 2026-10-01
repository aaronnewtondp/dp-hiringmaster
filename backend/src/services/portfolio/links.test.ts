import { describe, it, expect } from 'vitest';
import { normalizeUrl, extractUrlsFromText, classifyUrl, pickPortfolioLinks, mergeResumeLinks, dedupeKey, nameTokens, customLinkScore } from './links.js';

describe('normalizeUrl', () => {
  it('adds https, lowercases the host, drops the fragment and a bare-origin trailing slash', () => {
    expect(normalizeUrl('Jane.Framer.Website/')).toBe('https://jane.framer.website');
    expect(normalizeUrl('https://www.behance.net/jane#about')).toBe('https://www.behance.net/jane');
  });
  it('strips trailing sentence punctuation and an unbalanced closing paren', () => {
    expect(normalizeUrl('https://jane.design/work).')).toBe('https://jane.design/work');
    expect(normalizeUrl('(https://jane.design)')).toBe('https://jane.design');
  });
  it('keeps query strings (Figma links carry node-id)', () => {
    expect(normalizeUrl('https://www.figma.com/proto/abc/x?node-id=1-2&t=z')).toContain('node-id=1-2');
  });
  it('rejects non-web schemes, emails and hosts without a dot', () => {
    for (const bad of ['mailto:a@b.com', 'tel:+911234567890', 'javascript:alert(1)', 'file:///etc/passwd', 'http://localhost:3000', '', '   ']) {
      expect(normalizeUrl(bad), bad).toBeNull();
    }
  });
});

describe('extractUrlsFromText', () => {
  it('finds scheme URLs', () => {
    expect(extractUrlsFromText('See https://jane.design/work and more')).toContain('https://jane.design/work');
  });
  it('finds known portfolio hosts typed without a scheme', () => {
    const urls = extractUrlsFromText('Portfolio: behance.net/janedoe | figma.com/proto/AbC/flow | jane.framer.website');
    expect(urls.some(u => u.includes('behance.net/janedoe'))).toBe(true);
    expect(urls.some(u => u.includes('figma.com/proto/AbC/flow'))).toBe(true);
    expect(urls.some(u => u.includes('jane.framer.website'))).toBe(true);
  });
  it('finds a bare custom domain only when a label introduces it', () => {
    expect(extractUrlsFromText('Portfolio: janedoe.design')).toContain('janedoe.design');
    expect(extractUrlsFromText('resume_final_v2.pdf attached')).toEqual([]);
  });
  it('does not treat the domain half of an email address as a link', () => {
    expect(extractUrlsFromText('mail me at jane@medium.com or jane@figma.com')).toEqual([]);
  });
  it('finds www-prefixed bare domains', () => {
    expect(extractUrlsFromText('Site www.jane-doe.co.in/case-studies')).toContain('www.jane-doe.co.in/case-studies');
  });
});

describe('classifyUrl', () => {
  it.each([
    ['https://www.figma.com/design/abc/x', 'figma_file'],
    ['https://jane.figma.site', 'figma_site'],
    ['https://jane.framer.website', 'framer'],
    ['https://www.behance.net/jane', 'behance'],
    ['https://jane.wixsite.com/portfolio', 'wix'],
    ['https://dribbble.com/jane', 'dribbble'],
    ['https://jane.notion.site/Portfolio-abc', 'notion'],
    ['https://jane.myportfolio.com', 'adobe_portfolio'],
    ['https://jane.webflow.io', 'webflow'],
    ['https://docs.google.com/presentation/d/1/edit', 'google_slides'],
    ['https://example.com/portfolio.pdf', 'pdf_file'],
    ['https://janedoe.design', 'custom'],
    ['https://sites.google.com/view/jane', 'custom'],
  ])('%s -> %s', (url, platform) => {
    const c = classifyUrl(url)!;
    expect(c.platform).toBe(platform);
    expect(c.kind).toBe('portfolio');
  });
  it.each([
    'https://www.linkedin.com/in/jane', 'https://github.com/jane', 'https://twitter.com/jane',
    'https://forms.gle/abc', 'https://www.digitalpaani.com', 'https://docs.google.com/forms/d/e/1',
  ])('%s is noise', (url) => {
    expect(classifyUrl(url)!.kind).toBe('noise');
  });
});

describe('pickPortfolioLinks', () => {
  it('drops noise and ranks real HTML sites ahead of gallery and canvas links', () => {
    const picked = pickPortfolioLinks([
      'https://www.linkedin.com/in/jane',
      'https://www.figma.com/proto/abc/x',
      'https://www.behance.net/jane',
      'https://janedoe.design',
    ]);
    expect(picked.map(p => p.platform)).toEqual(['custom', 'behance', 'figma_file']);
  });
  it('prefers a site home page over a deep link on the same host', () => {
    const picked = pickPortfolioLinks(['https://janedoe.design/work/case-1/deep', 'https://janedoe.design']);
    expect(picked).toHaveLength(1);
    expect(picked[0].url).toBe('https://janedoe.design');
  });
  it('allows two Behance links but only one per ordinary host, and caps the total', () => {
    const picked = pickPortfolioLinks([
      'https://www.behance.net/gallery/1/a', 'https://www.behance.net/gallery/2/b', 'https://www.behance.net/gallery/3/c',
      'https://a.design', 'https://b.design', 'https://c.design',
    ], 3);
    expect(picked).toHaveLength(3);
    expect(picked.filter(p => p.platform === 'behance').length).toBeLessThanOrEqual(2);
  });
  it('returns nothing when there is no portfolio-looking link', () => {
    expect(pickPortfolioLinks(['https://www.linkedin.com/in/jane', 'https://github.com/jane'])).toEqual([]);
  });
});

describe('mergeResumeLinks', () => {
  it('unions structural and text-derived URLs, normalized and de-duplicated', () => {
    const merged = mergeResumeLinks([{ url: 'https://jane.design/' }], ['jane.design', 'behance.net/jane']);
    expect(merged.map(m => m.url)).toEqual(['https://jane.design', 'https://behance.net/jane']);
  });
  it('collapses http/https and www twins, keeping the structural label', () => {
    const merged = mergeResumeLinks(
      [{ url: 'http://www.behance.net/jane', label: 'My Portfolio' }],
      ['https://www.behance.net/jane'],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].label).toBe('My Portfolio');
  });
  it('dedupeKey ignores scheme, www and trailing slash', () => {
    expect(dedupeKey('http://www.x.com/a/')).toBe(dedupeKey('https://x.com/a'));
  });
});

// Regressions taken from a real sample of applicant resumes: the same resume
// links employers, a university, an SSO dashboard, a repository by IP and a
// resume builder next to the real portfolio.
describe('pickPortfolioLinks — real-world noise', () => {
  it('does not pick http/https twins of the same Behance profile twice', () => {
    const picked = pickPortfolioLinks(['http://www.behance.net/jane', 'https://www.behance.net/jane']);
    expect(picked).toHaveLength(1);
  });
  it('drops universities, SSO/login pages, IP-address hosts and resume builders', () => {
    const picked = pickPortfolioLinks([
      'https://dtu.ac.in', 'https://sso.omnisai.io/dashboard',
      'http://14.139.251.106:8080/jspui/handle/1', 'https://www.enhancv.com',
    ]);
    expect(picked).toEqual([]);
  });
  it('ranks a site whose host contains the candidate\'s name above an employer site', () => {
    const picked = pickPortfolioLinks(
      ['https://sixthsense.rakuten.com', 'https://www.mitesh.design'],
      3, { candidateName: 'Mitesh Patel' },
    );
    expect(picked[0].host).toBe('mitesh.design');
  });
  it('a "Portfolio" hyperlink label lifts an otherwise unremarkable domain', () => {
    const picked = pickPortfolioLinks(
      [{ url: 'https://acme-corp.com', label: 'Company' }, { url: 'https://zzz-studio.co', label: 'Portfolio' }],
      1, { candidateName: 'Jane Doe' },
    );
    expect(picked[0].host).toBe('zzz-studio.co');
  });
  it('ignores very common surnames when matching a candidate\'s name to a host', () => {
    expect(nameTokens('Amit Kumar Singh')).toEqual(['amit']);
    const link = { url: 'https://kumarindustries.com', host: 'kumarindustries.com', platform: 'custom' as const };
    expect(customLinkScore(link, undefined, nameTokens('Ravi Kumar'))).toBe(0);
  });
});

// A single hostile 100 KB "URL" in a resume used to freeze the API process for
// ~15 seconds (quadratic trailing-punctuation regex). Bounded now — assert it.
describe('hostile input cannot stall the process', () => {
  const fast = (f: () => unknown) => { const t = Date.now(); f(); return Date.now() - t; };
  it('a huge run of trailing punctuation is rejected/handled in milliseconds', () => {
    expect(fast(() => normalizeUrl('https://x.com/' + '.'.repeat(100000) + 'a'))).toBeLessThan(250);
    expect(normalizeUrl('https://x.com/' + '.'.repeat(100000) + 'a')).toBeNull();
  });
  it('an over-long URL is not a URL', () => {
    expect(normalizeUrl('https://x.com/' + 'a'.repeat(5000))).toBeNull();
    expect(normalizeUrl('https://x.com/' + 'a'.repeat(1000))).not.toBeNull();
  });
  it('the text sweeps are linear on adversarial shapes', () => {
    for (const chunk of ['a.', 'figma.', 'portfolio: a.b ', 'www.a', 'https://']) {
      expect(fast(() => extractUrlsFromText(chunk.repeat(Math.ceil(400_000 / chunk.length))))).toBeLessThan(500);
    }
  });
  it('trailing punctuation is still stripped from ordinary links', () => {
    expect(normalizeUrl('https://jane.design/work).')).toBe('https://jane.design/work');
    expect(normalizeUrl('https://jane.design,')).toBe('https://jane.design');
  });
});
