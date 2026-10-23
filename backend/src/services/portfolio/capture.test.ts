import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Browser, HTTPRequest } from 'puppeteer-core';
import vm from 'node:vm';
import {
  detectAccessProblem, pickInternalPages, classifyLoadFailure, capturePortfolios, classifyCanva, isBotWall,
  lockdownScript, BLOCKED_REALTIME_APIS, BLOCKED_WORKER_APIS, browserOptionsFor, closeExtraPages, withoutUserGesture, launchedWithoutPopupBlocking,
  findUnopenedPages, partialCrawlNote, makeTeardownGuard,
  BOT_WALL_NOTE, CANVA_PARTIAL_NOTE, CANVA_EMPTY_NOTE, DESIGNER_CAPTURE_OPTS, MARKETING_CAPTURE_OPTS,
  type CaptureOptions, type CapturedPage, type CapturedPortfolio,
} from './capture.js';
import type { PortfolioLink, PortfolioSignals } from './types.js';

// The network and the browser are fakes: nothing in this file opens a socket. urlSafety is replaced
// (DNS lookups and real fetches); the SDK is replaced for the one analyze.ts pin at the bottom.
const h = vi.hoisted(() => ({ safeFetch: vi.fn(), create: vi.fn(), hostIsPublic: async (_url: string): Promise<boolean> => true }));
vi.mock('./urlSafety.js', () => ({
  safeFetch: (...a: unknown[]) => h.safeFetch(...a),
  assertSafePublicUrl: async () => {},
  makeHostChecker: () => (url: string) => h.hostIsPublic(url),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic { messages = { create: (...a: unknown[]) => h.create(...a) }; },
}));

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

// ═════════════════════════════════════════════════════════════════════════════
// Bot walls are neutral; every other verdict is unchanged
// ═════════════════════════════════════════════════════════════════════════════
const WALL = { kind: 'unreviewable', note: BOT_WALL_NOTE };

describe('detectAccessProblem — verdicts that existed before bot-wall handling are unchanged', () => {
  it.each([
    [401, 'https://x.com', 'x', { kind: 'blocked', note: 'Requires login or permission (HTTP 401)' }],
    [403, 'https://x.com', 'x', { kind: 'blocked', note: 'Requires login or permission (HTTP 403)' }],
    [404, 'https://x.com', 'x', { kind: 'blocked', note: 'Page not found (HTTP 404)' }],
    [410, 'https://x.com', 'x', { kind: 'blocked', note: 'Page not found (HTTP 410)' }],
    [500, 'https://x.com', 'x', { kind: 'error', note: 'Site returned HTTP 500' }],
    [502, 'https://x.com', 'x', { kind: 'error', note: 'Site returned HTTP 502' }],
    [503, 'https://x.com', 'x', { kind: 'error', note: 'Site returned HTTP 503' }],
    [200, 'https://www.figma.com/login?next=/file/abc', '', { kind: 'blocked', note: 'Figma file is private — sign-in required' }],
    [200, 'https://x.com', 'Request access', { kind: 'blocked', note: 'Portfolio is private or requires access' }],
    [200, 'https://x.com', 'Access Denied', { kind: 'blocked', note: 'Portfolio is private or requires access' }],
    [200, 'https://x.com', 'Sign in to view this project', { kind: 'blocked', note: 'Portfolio is private or requires access' }],
    [200, 'https://x.com/gone', 'Page not found', { kind: 'blocked', note: 'Page not found' }],
    [200, 'https://x.com/gone', 'Nothing here', { kind: 'blocked', note: 'Page not found' }],
    [429, 'https://x.com', 'Too many requests', null],   // a bare 429 never was a verdict
    [200, 'https://x.com', 'A perfectly normal portfolio page.', null],
    [null, 'https://x.com', 'A perfectly normal portfolio page.', null],
  ])('status %s %s %j', (status, url, text, expected) => {
    expect(detectAccessProblem(status, url, text)).toEqual(expected);
    // the new header map changes nothing when it carries no bot-protection header
    expect(detectAccessProblem(status, url, text, {})).toEqual(expected);
    expect(detectAccessProblem(status, url, text, { server: 'nginx', 'cf-ray': '8a1b2c3d-BOM' })).toEqual(expected);
  });

  it('the bot-wall note is the exact, HR-facing wording', () => {
    expect(BOT_WALL_NOTE).toBe('Site is protected by a bot check (Cloudflare/captcha) - cannot be opened automatically');
  });
});

describe('detectAccessProblem — a bot wall is unreviewable, never "blocked" or "error"', () => {
  // The header (like the words below) is set by the candidate's OWN server, so it is only believed on a status a challenge is
  // actually served with. It used to count on any status, which let a site turn a plain 404 or a broken page into a neutral
  // "unreviewable" just by sending it ([5.11]).
  it.each([403, 503, 429])('the cf-mitigated header decides alone on a status a challenge is served with (%s), whatever the text', (status) => {
    expect(detectAccessProblem(status, 'https://x.com', '', { 'cf-mitigated': 'challenge' })).toEqual(WALL);
    expect(detectAccessProblem(status, 'https://x.com', 'Sorry, you have been blocked', { 'cf-mitigated': 'challenge' })).toEqual(WALL);
    expect(detectAccessProblem(status, 'https://x.com', 'A long, real page. '.repeat(100), { 'cf-mitigated': 'challenge' })).toEqual(WALL);
  });

  it.each([200, 204, 301, 404, 401, 410, 500, 502, null])('...but on any other status (%s) it changes nothing: the page is judged as if the header were not there', (status) => {
    for (const text of ['', 'A real page with real content about the studio and its work.', 'Page not found']) {
      const without = detectAccessProblem(status, 'https://x.com', text);
      expect(detectAccessProblem(status, 'https://x.com', text, { 'cf-mitigated': 'challenge' })).toEqual(without);
      expect(without?.kind).not.toBe('unreviewable');
    }
    expect(isBotWall(status, '', { 'cf-mitigated': 'challenge' })).toBe(false);
  });

  it('a self-served 2xx page cannot buy neutrality: a header, or the words of a challenge, on a 200 with real content is just a page', () => {
    const page = 'Case study: we shipped three campaigns. '.repeat(40);
    expect(detectAccessProblem(200, 'https://candidate.example/', page, { 'cf-mitigated': 'challenge' })).toBeNull();
    expect(detectAccessProblem(200, 'https://candidate.example/', `Just a moment...\n${page}`, { 'cf-mitigated': 'challenge' })).toBeNull();
  });

  it('the header only has to be present (an empty value counts) and its name is matched case-insensitively', () => {
    expect(detectAccessProblem(403, 'https://x.com', 'x', { 'cf-mitigated': '' })).toEqual(WALL);
    expect(detectAccessProblem(403, 'https://x.com', 'x', { 'CF-Mitigated': 'challenge' })).toEqual(WALL);
  });

  it('a site that merely sits behind Cloudflare is not a wall: no cf-mitigated header, no marker => the old verdict', () => {
    const behindCloudflare = { server: 'cloudflare', 'cf-ray': '8a1b2c3d4e5f-BOM', 'cf-cache-status': 'DYNAMIC' };
    expect(detectAccessProblem(403, 'https://x.com', 'Forbidden', behindCloudflare)?.kind).toBe('blocked');
    expect(detectAccessProblem(503, 'https://x.com', 'Down for maintenance', behindCloudflare)?.kind).toBe('error');
    expect(detectAccessProblem(404, 'https://x.com', 'Not here', behindCloudflare)?.kind).toBe('blocked');
  });

  const MARKERS: Array<[string, string]> = [
    ['Cloudflare interstitial title', 'Just a moment...'],
    ['Cloudflare legacy wait', 'Checking your browser before accessing example.com. This process is automatic.'],
    ['Cloudflare challenge script', 'window._cf_chl_opt = { cvId: "3" }'],
    ['Cloudflare challenge class', '<div id="cf-challenge-running">'],
    ['PerimeterX', '<div id="px-captcha"></div>'],
    ['hCaptcha', 'Please complete the hCaptcha below to continue'],
    ['reCAPTCHA', '<div class="g-recaptcha" data-sitekey="x"></div>'],
    ['Cloudflare block page title', 'Attention Required! | Cloudflare'],
    ['Cloudflare block page title across lines', 'Attention Required!\n\nSorry, you have been blocked\nCloudflare Ray ID: 8a1b2c'],
    ['Akamai, one line', 'Access Denied You don\'t have permission to access "http://x.com/" on this server. Reference #18.2d351ab8.1557333295.a4e16ab'],
    ['Akamai, as innerText', 'Access Denied\n\nYou don\'t have permission to access "http://x.com/" on this server.\nReference #18.2d351ab8.1557333295.a4e16ab'],
    ['upper case', 'JUST A MOMENT'],
  ];

  it.each(MARKERS)('%s => unreviewable on 403, 429 and 503', (_name, text) => {
    for (const status of [403, 429, 503]) expect(detectAccessProblem(status, 'https://x.com', text)).toEqual(WALL);
  });

  it.each(MARKERS)('%s => but only on those statuses (a 200 page, a 404, a 500 are judged as before)', (_name, text) => {
    for (const status of [200, 404, 401, 500, 502, null]) {
      expect(detectAccessProblem(status, 'https://x.com', text)?.kind).not.toBe('unreviewable');
    }
  });

  it('a 200 page that merely CONTAINS the words in long content is a normal page', () => {
    const longPage = 'Case study: just a moment of silence on air, then the hCaptcha-free checkout converted 12% more. '.repeat(20);
    expect(longPage.length).toBeGreaterThan(700);
    expect(detectAccessProblem(200, 'https://x.com/work', longPage)).toBeNull();
    expect(detectAccessProblem(200, 'https://x.com/work', 'Just a moment...')).toBeNull();   // short too: a 200 is never a challenge
    expect(isBotWall(200, longPage)).toBe(false);
  });

  it('a plain 403 with no bot-wall evidence stays "blocked" exactly as before', () => {
    for (const text of [
      'Forbidden', 'You do not have permission to view this page.', 'Access Denied', '403 Forbidden\nnginx',
      'Access Denied\nYou do not have permission to view this portfolio.',   // no "Reference #<n>"
      'Please verify your account', 'Sign in to continue',
    ]) {
      expect(detectAccessProblem(403, 'https://x.com', text)).toEqual({ kind: 'blocked', note: 'Requires login or permission (HTTP 403)' });
    }
    expect(detectAccessProblem(503, 'https://x.com', 'Service Unavailable')).toEqual({ kind: 'error', note: 'Site returned HTTP 503' });
  });

  it('the word pairs must be near each other: "Access Denied" and a far-away "Reference #1" are not one Akamai page', () => {
    const far = `Access Denied\n${'filler words about the studio and its clients. '.repeat(40)}\nReference #1`;
    expect(detectAccessProblem(403, 'https://x.com', far)?.kind).toBe('blocked');
  });

  it('the marker scan is bounded: a megabyte of hostile text neither hangs nor matches', () => {
    const hostile = 'access denied '.repeat(80_000);
    const t0 = performance.now();
    const verdict = detectAccessProblem(403, 'https://x.com', hostile);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(verdict?.kind).toBe('blocked');
    // a marker beyond the scanned head is ignored (a challenge page is short)
    expect(isBotWall(403, `${'.'.repeat(20_000)} just a moment`)).toBe(false);
    expect(isBotWall(403, `${'.'.repeat(600)} just a moment`)).toBe(true);
  });

  // A challenge page says a line or two; a 403 page full of ordinary content that merely quotes a marker is not one ([5.11]).
  describe('the page must be short', () => {
    const FILLER = 'We design campaigns for water-tech brands and run them end to end. ';
    // exactly `readable` characters, the last one not a space (so trimming cannot shorten it)
    const withMarker = (readable: number) => `Just a moment... ${FILLER.repeat(Math.ceil(readable / FILLER.length))}`.slice(0, readable - 1) + 'x';

    it('just under 700 readable characters is a challenge page; 700 and over is a page of the site\'s own', () => {
      expect(isBotWall(403, withMarker(699))).toBe(true);
      expect(isBotWall(403, withMarker(700))).toBe(false);
      expect(isBotWall(403, withMarker(5_000))).toBe(false);
      expect(detectAccessProblem(403, 'https://x.com', withMarker(5_000))).toEqual({ kind: 'blocked', note: 'Requires login or permission (HTTP 403)' });
    });

    it('applies to every marker and every status a wall is served with', () => {
      for (const marker of ['checking your browser', 'px-captcha', 'hcaptcha', 'g-recaptcha', '_cf_chl_opt', 'Attention Required! | Cloudflare', 'Access Denied\nReference #18.2d351ab8.1']) {
        for (const status of [403, 429, 503]) {
          expect(isBotWall(status, marker), `${marker} ${status} short`).toBe(true);
          expect(isBotWall(status, `${marker}\n${FILLER.repeat(30)}`), `${marker} ${status} long`).toBe(false);
        }
      }
    });

    it('is about what a visitor reads: the markup and scripts of a real challenge page do not count against it', () => {
      const challenge = `<!DOCTYPE html><html><head><title>Just a moment...</title><style>${'body{margin:0}'.repeat(300)}</style></head>`
        + `<body><noscript>Enable JavaScript and cookies to continue</noscript><script>window._cf_chl_opt={cvId:'3'};${'var a=1;'.repeat(900)}</script>`
        + `<div class="main-wrapper" role="main"><h1>candidate.example</h1><h2>Performing security verification</h2></div></body></html>`;
      expect(challenge.length).toBeGreaterThan(8_000);
      expect(isBotWall(403, challenge)).toBe(true);
      expect(isBotWall(503, challenge, {})).toBe(true);
    });

    it('...and a real page of markup whose visible words are many is still a page', () => {
      const real = `<html><head><title>Just a moment of calm</title></head><body><p>${FILLER.repeat(20)}</p></body></html>`;
      expect(isBotWall(403, real)).toBe(false);
    });

    it('a stray "<" in a page\'s own words does not swallow the text up to the next ">"', () => {
      // innerText has no markup, but a page can say "a < b" — and a later ">" must not hide a long stretch of real words
      const prose = `Price < budget. ${FILLER.repeat(30)} Budget > price.`;
      expect(isBotWall(403, `Just a moment... ${prose}`)).toBe(false);
    });

    it('whitespace does not pad a short page past the limit', () => {
      expect(isBotWall(403, `Just a moment...${' \n\t'.repeat(2_000)}Enable JavaScript`)).toBe(true);
    });

    it('a hostile page of unclosed tags is read in linear time', () => {
      for (const hostile of ['<'.repeat(16_000), '<script'.repeat(2_300), '<style>'.repeat(2_000), `just a moment ${'<a '.repeat(5_000)}`]) {
        const t0 = performance.now();
        isBotWall(403, hostile);
        expect(performance.now() - t0).toBeLessThan(500);
      }
    });
  });

  // Canva handling is the marketing review's alone ({ canva: true }); the designer review reads canva.com like any site,
  // exactly as before ([3.7]).
  it('a Canva design that redirects to the sign-in page is private, like a Figma one (marketing: opts.canva)', () => {
    const canva = { canva: true };
    expect(detectAccessProblem(200, 'https://www.canva.com/login?redirect=%2Fdesign%2FX', 'Log in', undefined, canva)).toEqual({ kind: 'blocked', note: 'Canva design is private — sign-in required' });
    expect(detectAccessProblem(200, 'https://www.canva.com/design/X/view', 'A design', undefined, canva)).toBeNull();
    expect(detectAccessProblem(200, 'https://canva.com/signup', 'Sign up', undefined, canva)?.kind).toBe('blocked');
    // only Canva's own host counts: a look-alike host or a URL that merely mentions the path is an ordinary page
    for (const url of ['https://jane.example/?next=canva.com/login', 'https://canva.com.evil.example/login', 'https://notcanva.com/login']) {
      expect(detectAccessProblem(200, url, 'A page about the work', undefined, canva)).toBeNull();
    }
  });

  it('...and without it (the designer review, or no options at all) a Canva sign-in page is read exactly as it was before: no verdict', () => {
    for (const opts of [undefined, {}, { canva: false }]) {
      expect(detectAccessProblem(200, 'https://www.canva.com/login?redirect=%2Fdesign%2FX', 'Log in', undefined, opts)).toBeNull();
      expect(detectAccessProblem(200, 'https://canva.com/signup', 'Sign up', undefined, opts)).toBeNull();
    }
    // every other verdict is untouched by the option
    expect(detectAccessProblem(404, 'https://www.canva.com/design/X', 'x', undefined, { canva: true })).toEqual(detectAccessProblem(404, 'https://www.canva.com/design/X', 'x'));
  });
});

describe('classifyLoadFailure — a bot check answering the plain request is never a dead site', () => {
  const URL_X = 'https://jane.example';
  const wall = (body: string, status: number, headers: Record<string, string> = {}) => new Response(body, { status, headers });

  beforeEach(() => { h.safeFetch.mockReset(); });

  it.each(['net::ERR_CONNECTION_CLOSED', 'Navigation timeout of 25000 ms exceeded', 'net::ERR_TIMED_OUT'])('%s + the plain request got a Cloudflare challenge => unreviewable', async (message) => {
    h.safeFetch.mockResolvedValueOnce(wall('<title>Just a moment...</title>', 403, { 'cf-mitigated': 'challenge' }));
    expect(await classifyLoadFailure(message, URL_X)).toEqual(WALL);
  });

  it('...recognised from the page alone on 503 / 429 / 403 when there is no header', async () => {
    for (const [status, body] of [[503, '<html>Checking your browser before accessing jane.example</html>'], [429, '<div id="px-captcha"></div>'], [403, 'Attention Required! | Cloudflare']] as const) {
      h.safeFetch.mockResolvedValueOnce(wall(body, status));
      expect(await classifyLoadFailure('net::ERR_CONNECTION_RESET', URL_X)).toEqual(WALL);
    }
  });

  it.each([403, 429, 503])('...a header alone is enough on %s (the page was a challenge that our browser could not pass)', async (status) => {
    h.safeFetch.mockResolvedValueOnce(wall('', status, { 'cf-mitigated': 'challenge' }));
    expect(await classifyLoadFailure('net::ERR_CONNECTION_CLOSED', URL_X)).toEqual(WALL);
  });

  it('...but not on a 200 (or any status a challenge is not served with): the site answers normally, so it is the retryable "error" ([5.11])', async () => {
    for (const status of [200, 404, 500]) {
      h.safeFetch.mockResolvedValueOnce(wall('A real page', status, { 'cf-mitigated': 'challenge' }));
      expect(await classifyLoadFailure('net::ERR_CONNECTION_CLOSED', URL_X)).toEqual({ kind: 'error', note: 'Site responds to normal requests but not to our browser' });
    }
  });

  it('a site that answers normally (or with a plain error) is alive but refuses our browser: still the retryable "error", as before', async () => {
    for (const [status, body] of [[200, 'Welcome'], [200, 'just a moment of your time'], [403, 'Forbidden'], [500, 'oops'], [404, 'hcaptcha?']] as const) {
      h.safeFetch.mockResolvedValueOnce(wall(body, status));
      expect(await classifyLoadFailure('net::ERR_CONNECTION_CLOSED', URL_X)).toEqual({ kind: 'error', note: 'Site responds to normal requests but not to our browser' });
    }
  });

  it('a plain request that fails at network level is still a dead link; a slow one is still just "error"', async () => {
    h.safeFetch.mockRejectedValueOnce(new Error('does not resolve'));
    expect((await classifyLoadFailure('net::ERR_NAME_NOT_RESOLVED', URL_X)).kind).toBe('blocked');
    h.safeFetch.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(await classifyLoadFailure('Navigation timeout of 25000 ms exceeded', URL_X)).toEqual({ kind: 'error', note: 'Site did not respond in time' });
  });

  it('goes through the SSRF-safe fetch, as a GET with a browser user agent', async () => {
    h.safeFetch.mockResolvedValueOnce(wall('ok', 200));
    await classifyLoadFailure('net::ERR_CONNECTION_CLOSED', URL_X);
    expect(h.safeFetch).toHaveBeenCalledTimes(1);
    expect(h.safeFetch.mock.calls[0][0]).toBe(URL_X);
    expect(h.safeFetch.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { 'user-agent': expect.stringContaining('Mozilla/5.0') } });
  });

  it('reads at most the head of the body, then cancels it (a hostile endless response cannot stall or exhaust the worker)', async () => {
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) { pulls++; c.enqueue(new TextEncoder().encode('x'.repeat(4096))); },
      cancel() { cancelled = true; },
    });
    h.safeFetch.mockResolvedValueOnce(new Response(endless, { status: 403 }));
    expect((await classifyLoadFailure('net::ERR_CONNECTION_CLOSED', URL_X)).kind).toBe('error');
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);   // 16,000 characters is 4 chunks (+1 the stream prefetches)
  });

  it('a body that cannot be read never turns into a verdict about the site', async () => {
    const broken = new ReadableStream<Uint8Array>({ pull() { throw new Error('socket hang up'); } });
    h.safeFetch.mockResolvedValueOnce(new Response(broken, { status: 403 }));
    expect(await classifyLoadFailure('net::ERR_CONNECTION_CLOSED', URL_X)).toEqual({ kind: 'error', note: 'Site responds to normal requests but not to our browser' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Capture options
// ═════════════════════════════════════════════════════════════════════════════
describe('capture options', () => {
  it('DESIGNER_CAPTURE_OPTS are exactly the values that were hard-coded before', () => {
    // canvaPartial / lockdown / blockWorkers / blockPopups / guardTeardown / partialWhenPagesLeft were added later and are OFF for the designer review: its captures must not change.
    expect(DESIGNER_CAPTURE_OPTS).toEqual({
      maxPages: 6, mobileCheck: true, linkHealth: true, textLimit: 4500, canvaPartial: false, lockdown: false, blockWorkers: false, blockPopups: false,
      guardTeardown: false, partialWhenPagesLeft: false,
    });
  });
  it('MARKETING_CAPTURE_OPTS: fewer pages, no phone-width render, no link audit, far more text, and the network lockdown on', () => {
    expect(MARKETING_CAPTURE_OPTS).toEqual({
      maxPages: 4, mobileCheck: false, linkHealth: false, textLimit: 12000, canvaPartial: true, lockdown: true, blockWorkers: true, blockPopups: true,
      guardTeardown: true, partialWhenPagesLeft: true,
    });
  });
  it('both are frozen: one review cannot change what the next one captures', () => {
    expect(Object.isFrozen(DESIGNER_CAPTURE_OPTS)).toBe(true);
    expect(Object.isFrozen(MARKETING_CAPTURE_OPTS)).toBe(true);
    expect(() => { (DESIGNER_CAPTURE_OPTS as CaptureOptions).maxPages = 1; }).toThrow(TypeError);
  });
  it('browserOptionsFor: the designer review asks for nothing (its launch is untouched), the marketing review asks for blocked popups', () => {
    expect(browserOptionsFor(DESIGNER_CAPTURE_OPTS)).toStrictEqual({});
    expect(browserOptionsFor(MARKETING_CAPTURE_OPTS)).toStrictEqual({ blockPopups: true });
    expect(browserOptionsFor({ ...MARKETING_CAPTURE_OPTS, blockPopups: false })).toStrictEqual({});
  });
});

// ─── A fake browser: just enough Page for capturePortfolio to run on ─────────
interface FakeSite {
  status?: number; headers?: Record<string, string>; title?: string; text?: string;
  anchors?: Array<{ href: string; text: string }>;
  finalUrl?: string;     // where a redirect lands (page.url())
  noShots?: boolean;     // screenshots come back empty
  throws?: string;       // page.goto rejects with this message
  hangs?: boolean;       // page.goto never answers
}

interface FakeOptions {
  lockdownThrows?: boolean;
  jsOffThrows?: boolean;        // page.setJavaScriptEnabled(false) rejects
  jsOffHangs?: boolean;         // ... never answers
  jsOnThrows?: boolean;         // page.setJavaScriptEnabled(true) rejects
  blankFails?: boolean;         // navigating to about:blank rejects
  closeHangs?: boolean;         // page.close() never answers
  targets?: FakeTarget[];       // what browser.targets() lists besides the page itself
  onGoto?: (url: string) => void;   // runs inside page.goto, after it is logged: lets a test make the page do something while it is open
}
interface FakeTarget { type: () => string; createCDPSession: () => Promise<{ send: (method: string, params: unknown) => Promise<unknown> }> }

/** A request as puppeteer hands it to a 'request' listener: it can be answered once, and says whether it has been. */
function fakeRequest(url: string, o: { type?: string; log?: string[] } = {}) {
  let handled = false;
  const answers: string[] = [];
  const answer = (what: string) => async () => {
    if (handled) throw new Error('Request is already handled!');
    handled = true; answers.push(what); o.log?.push(`${what}:${url}`);
  };
  const req = {
    url: () => url, resourceType: () => o.type ?? 'fetch',
    isInterceptResolutionHandled: () => handled,
    abort: vi.fn(async (code?: string) => answer(`abort(${code})`)()),
    continue: vi.fn(async () => answer('continue')()),
  };
  return { req: req as unknown as HTTPRequest, raw: req, answers };
}

function fakeBrowser(sites: (url: string) => FakeSite, o: FakeOptions = {}) {
  // `lockdowns` is every script given to evaluateOnNewDocument and how many navigations had already happened by then.
  // `gestureReads` counts what puppeteer would run WITH a user gesture (page.evaluate, page.title); `cdpEvals` is what went
  // through a CDP session (Runtime.evaluate) and with which userGesture; `cdpSessions` how many sessions were opened.
  // `events` is the order of what touches the page's lifecycle: 'goto' / 'blank' (about:blank) / 'js:off' / 'js:on' / 'close' / 'abort:<url>'.
  const log = {
    gotos: [] as string[], viewports: [] as number[], closed: 0, lockdowns: [] as Array<{ script: string; gotosBefore: number }>,
    gestureReads: 0, cdpEvals: [] as Array<{ expression: string; userGesture: unknown }>, cdpSessions: 0,
    listeners: [] as Array<['on' | 'off', string]>, closedPopups: [] as string[],
    events: [] as string[], jsToggles: [] as boolean[], requestListeners: [] as Array<(req: HTTPRequest) => unknown>,
  };
  let site: FakeSite = {};
  let current = '';
  // The page's own functions run in a browser; here each is told apart by what it reads.
  const answer = (src: string): unknown => {
    if (src === 'document.title') return site.title ?? 'A title';
    if (src.includes('innerText')) return site.text ?? 'A page about the work';
    if (src.includes('querySelectorAll')) return site.anchors ?? [];
    if (src.includes('scrollWidth')) return false;
    if (src.includes('innerHeight')) return undefined;
    if (src.includes('scrollHeight')) return 800;
    return undefined;
  };
  // The capture's own page target: if anything tried to close it, `closedPopups` would say 'OWN PAGE'.
  const ownTarget = { type: () => 'page', page: async () => ({ close: async () => { log.closedPopups.push('OWN PAGE'); } }) };
  const page = {
    setUserAgent: async () => {},
    setViewport: async (v: { width: number }) => { log.viewports.push(v.width); },
    setRequestInterception: async () => {},
    evaluateOnNewDocument: async (script: unknown) => {
      if (o.lockdownThrows) throw new Error('Protocol error (Page.addScriptToEvaluateOnNewDocument): Target closed');
      log.lockdowns.push({ script: String(script), gotosBefore: log.gotos.length });
    },
    on: (event: string, fn: (req: HTTPRequest) => unknown) => { if (event === 'request') log.requestListeners.push(fn); },
    setJavaScriptEnabled: async (enabled: boolean) => {
      log.jsToggles.push(enabled); log.events.push(enabled ? 'js:on' : 'js:off');
      if (!enabled && o.jsOffThrows) throw new Error('Protocol error (Emulation.setScriptExecutionDisabled): Target closed');
      if (!enabled && o.jsOffHangs) await new Promise(() => {});
      if (enabled && o.jsOnThrows) throw new Error('Protocol error (Emulation.setScriptExecutionDisabled): Target closed');
    },
    goto: async (url: string) => {
      if (url === 'about:blank') {
        log.events.push('blank');
        if (o.blankFails) throw new Error('net::ERR_ABORTED');
        current = url;
        return null;
      }
      log.gotos.push(url); log.events.push('goto');
      o.onGoto?.(url);
      site = sites(url);
      if (site.hangs) await new Promise(() => {});
      if (site.throws) throw new Error(site.throws);
      current = site.finalUrl ?? url;
      return { status: () => site.status ?? 200, headers: () => site.headers ?? {} };
    },
    waitForNetworkIdle: async () => {},
    evaluate: async (fn: unknown) => { log.gestureReads++; return answer(String(fn)); },
    title: async () => { log.gestureReads++; return site.title ?? 'A title'; },
    createCDPSession: async () => {
      log.cdpSessions++;
      return {
        send: async (method: string, params: { expression: string; userGesture?: unknown }) => {
          if (method !== 'Runtime.evaluate') throw new Error(`unexpected CDP method ${method}`);
          log.cdpEvals.push({ expression: params.expression, userGesture: params.userGesture });
          return { result: { value: answer(params.expression) } };
        },
      };
    },
    target: () => ownTarget,
    screenshot: async () => (site.noShots ? null : Buffer.from('jpeg')),
    url: () => current,
    close: async () => { log.closed++; log.events.push('close'); if (o.closeHangs) await new Promise(() => {}); },
  };
  // browser.on('targetcreated') as puppeteer has it, so a test can make a popup appear: `popup(type)`.
  const handlers = new Set<(t: unknown) => void>();
  const browser = {
    newPage: async () => page,
    targets: () => [ownTarget, ...(o.targets ?? [])],
    on: (event: string, fn: (t: unknown) => void) => { log.listeners.push(['on', event]); if (event === 'targetcreated') handlers.add(fn); },
    off: (event: string, fn: (t: unknown) => void) => { log.listeners.push(['off', event]); if (event === 'targetcreated') handlers.delete(fn); },
  };
  const popup = (type: string, name = 'popup') => {
    // closable whatever its type, so that only the type check decides what gets closed
    const target = { type: () => type, page: async () => ({ close: async () => { log.closedPopups.push(name); } }) };
    for (const fn of [...handlers]) fn(target);
    return target;
  };
  return { browser: browser as unknown as Browser, log, popup, ownTarget, page, handlers };
}

const linkTo = (url: string, platform: PortfolioLink['platform'] = 'custom'): PortfolioLink => ({ url, host: new URL(url).hostname, platform });

/** Runs a capture to the end under fake timers (the crawl's pauses are real sleeps otherwise). */
async function capture(browser: Browser, links: PortfolioLink[], opts?: CaptureOptions): Promise<CapturedPortfolio[]> {
  const run = opts ? capturePortfolios(browser, links, Date.now() + 600_000, opts) : capturePortfolios(browser, links, Date.now() + 600_000);
  await vi.runAllTimersAsync();
  return run;
}
const one = async (browser: Browser, link: PortfolioLink, opts?: CaptureOptions) => (await capture(browser, [link], opts))[0];

const HOME = 'https://jane.example';
const WORK_PAGES = ['a', 'b', 'c', 'd'].map(x => `${HOME}/work/${x}`);
const BEHANCE = 'https://www.behance.net/gallery/1/Campaign';
const FIGMA = 'https://www.figma.com/proto/abc/Deck';
const homeAnchors = [
  ...WORK_PAGES.map((href, i) => ({ href, text: `Case ${'abcd'[i]}` })),
  { href: BEHANCE, text: 'Campaign' },
  { href: FIGMA, text: 'Deck' },
  { href: 'https://twitter.com/jane', text: 'tw' },
  { href: 'https://news.example/press', text: 'press' },
  { href: 'mailto:jane@jane.example', text: 'mail' },
];
const richSite = (url: string): FakeSite => (url === HOME ? { anchors: homeAnchors, text: 'a'.repeat(20_000) } : { text: 'b'.repeat(20_000) });
const ALL_OFF: CaptureOptions = { maxPages: 6, mobileCheck: false, linkHealth: false, textLimit: 4500, canvaPartial: false, lockdown: false, blockWorkers: false, blockPopups: false, guardTeardown: false, partialWhenPagesLeft: false };

describe('capturePortfolios — options', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.safeFetch.mockReset();
    h.safeFetch.mockResolvedValue({ status: 200 });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('without options it behaves as the designer review always did (6 pages, phone render, link audit, 4500 characters)', async () => {
    const { browser, log } = fakeBrowser(richSite);
    const r = await one(browser, linkTo(HOME));
    expect(r.access).toBe('ok');
    expect(r.pages.map(p => p.url)).toEqual([HOME, ...WORK_PAGES.slice(0, 3), BEHANCE, FIGMA]);
    expect(r.pages.every(p => p.text.length === 4500)).toBe(true);
    expect(log.viewports).toEqual([1280, 390]);
    expect(r.mobileShot?.label).toBe('Home page at phone width (390px)');
    expect(r.signals.mobileOverflow).toBe(false);
    expect(r.signals.brokenLinksChecked).toBe(7);   // 4 work pages, behance, figma, news — twitter and mailto skipped
    expect(h.safeFetch).toHaveBeenCalledTimes(7);
    expect(r.partial).toBeUndefined();
  });

  it('passing DESIGNER_CAPTURE_OPTS explicitly gives the identical capture', async () => {
    const a = fakeBrowser(richSite);
    const b = fakeBrowser(richSite);
    const ra = await one(a.browser, linkTo(HOME));
    h.safeFetch.mockClear();
    const rb = await one(b.browser, linkTo(HOME), DESIGNER_CAPTURE_OPTS);
    expect(rb).toEqual(ra);
    // (the listener is a new function per page, so what is compared is how many were registered)
    expect({ ...b.log, requestListeners: b.log.requestListeners.length }).toEqual({ ...a.log, requestListeners: a.log.requestListeners.length });
  });

  it('maxPages caps the crawl: marketing keeps the home page and the first 3 queued pages only', async () => {
    const { browser, log } = fakeBrowser(richSite);
    const r = await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.pages.map(p => p.url)).toEqual([HOME, ...WORK_PAGES.slice(0, 3)]);
    expect(log.gotos).toEqual([HOME, ...WORK_PAGES.slice(0, 3)]);   // nothing else was even requested
  });

  it.each([1, 2, 3, 5])('maxPages %i is honoured to the page', async (maxPages) => {
    const { browser, log } = fakeBrowser(richSite);
    const r = await one(browser, linkTo(HOME), { ...ALL_OFF, maxPages });
    expect(r.pages).toHaveLength(maxPages);
    expect(log.gotos).toHaveLength(maxPages);
  });

  it('a bigger maxPages cannot invent pages: the queue is home + 3 internal + 2 outbound case studies', async () => {
    const { browser } = fakeBrowser(richSite);
    const r = await one(browser, linkTo(HOME), { ...ALL_OFF, maxPages: 50 });
    expect(r.pages).toHaveLength(6);
  });

  it.each([
    [4500, 4500], [12000, 12000], [800, 800], [100_000, 20_000],
  ])('textLimit %i keeps %i characters of a 20,000-character page', async (textLimit, kept) => {
    const { browser } = fakeBrowser(richSite);
    const r = await one(browser, linkTo(HOME), { ...ALL_OFF, maxPages: 2, textLimit });
    expect(r.pages.map(p => p.text.length)).toEqual([kept, kept]);
  });

  it('mobileCheck off: no phone-width render, no extra navigation, no overflow measurement', async () => {
    const { browser, log } = fakeBrowser(richSite);
    const r = await one(browser, linkTo(HOME), { ...DESIGNER_CAPTURE_OPTS, mobileCheck: false });
    expect(log.viewports).toEqual([1280]);
    expect(log.gotos.filter(u => u === HOME)).toHaveLength(1);
    expect(r.mobileShot).toBeUndefined();
    expect(r.signals.mobileOverflow).toBeNull();
    expect(r.signals.brokenLinksChecked).toBe(7);   // the other step is independent
  });

  it('linkHealth off: no outbound request is made and no link is counted', async () => {
    const { browser, log } = fakeBrowser(richSite);
    const r = await one(browser, linkTo(HOME), { ...DESIGNER_CAPTURE_OPTS, linkHealth: false });
    expect(h.safeFetch).not.toHaveBeenCalled();
    expect(r.signals).toMatchObject({ brokenLinksChecked: 0, brokenLinks: 0, brokenLinkSamples: [] });
    expect(r.signals.mobileOverflow).toBe(false);   // the other step is independent
    expect(log.viewports).toEqual([1280, 390]);
  });

  it('marketing options: neither extra step runs', async () => {
    const { browser, log } = fakeBrowser(richSite);
    const r = await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(log.viewports).toEqual([1280]);
    expect(r.mobileShot).toBeUndefined();
    expect(h.safeFetch).not.toHaveBeenCalled();
    expect(r.pages.every(p => p.text.length === 12000)).toBe(true);
  });

  it('options are per call: the same links captured with the other options afterwards are unaffected', async () => {
    const m = await one(fakeBrowser(richSite).browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    const d = await one(fakeBrowser(richSite).browser, linkTo(HOME));
    expect(m.pages).toHaveLength(4);
    expect(d.pages).toHaveLength(6);
  });
});

describe('capturePortfolios — a bot wall is unreviewable, not a dead or private link', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.safeFetch.mockReset();
    h.safeFetch.mockResolvedValue({ status: 200 });
  });
  afterEach(() => { vi.useRealTimers(); });

  const each = [['designer (default)', undefined], ['designer', DESIGNER_CAPTURE_OPTS], ['marketing', MARKETING_CAPTURE_OPTS]] as const;

  it.each(each)('%s: a Cloudflare challenge on the first page => unreviewable with the neutral note, nothing else attempted', async (_n, opts) => {
    const { browser, log } = fakeBrowser(() => ({ status: 403, headers: { 'cf-mitigated': 'challenge' }, text: '', title: 'Just a moment...' }));
    const r = await one(browser, linkTo(HOME), opts);
    expect(r.access).toBe('unreviewable');
    expect(r.accessNote).toBe(BOT_WALL_NOTE);
    expect(r.pages).toEqual([]);
    expect(log.gotos).toEqual([HOME]);
    expect(log.viewports).toEqual([1280]);
    expect(h.safeFetch).not.toHaveBeenCalled();
    expect(log.closed).toBe(1);   // the page is still released
  });

  it('the page <title> is read on a wall status: "Just a moment..." / "Attention Required! | Cloudflare" never appear in innerText', async () => {
    for (const [status, title, text] of [
      [503, 'Just a moment...', 'Enable JavaScript and cookies to continue'],
      [403, 'Attention Required! | Cloudflare', 'Sorry, you have been blocked'],
      [429, 'hCaptcha challenge', ''],
    ] as const) {
      const { browser } = fakeBrowser(() => ({ status, title, text }));
      const r = await one(browser, linkTo(HOME));
      expect({ status, access: r.access }).toEqual({ status, access: 'unreviewable' });
    }
  });

  it('a plain 403 / 503 with an ordinary title keeps its old verdict (blocked / error)', async () => {
    const blocked = await one(fakeBrowser(() => ({ status: 403, title: 'Forbidden', text: 'Forbidden' })).browser, linkTo(HOME));
    expect(blocked).toMatchObject({ access: 'blocked', accessNote: 'Requires login or permission (HTTP 403)' });
    const down = await one(fakeBrowser(() => ({ status: 503, title: 'Maintenance', text: 'Back soon' })).browser, linkTo(HOME));
    expect(down).toMatchObject({ access: 'error', accessNote: 'Site returned HTTP 503' });
  });

  it('a normal 200 page whose title says "Just a moment..." is read as usual (the title only counts on a wall status)', async () => {
    const r = await one(fakeBrowser(() => ({ title: 'Just a moment...', text: 'A real page about the studio and its work.' })).browser, linkTo(HOME));
    expect(r.access).toBe('ok');
    expect(r.pages).toHaveLength(1);
  });

  it('a wall on a LATER page costs only that page: the pages already read are kept and the capture stays ok', async () => {
    const { browser } = fakeBrowser(url => (url === WORK_PAGES[0]
      ? { status: 403, headers: { 'cf-mitigated': 'challenge' } }
      : richSite(url)));
    const r = await one(browser, linkTo(HOME), ALL_OFF);
    expect(r.access).toBe('ok');
    expect(r.pages.map(p => p.url)).not.toContain(WORK_PAGES[0]);
    expect(r.pages.map(p => p.url)).toContain(HOME);
    expect(r.pages.length).toBeGreaterThan(1);
  });

  it('a navigation that throws while a wall blocks even the plain request is neutral too', async () => {
    h.safeFetch.mockResolvedValue(new Response('Checking your browser before accessing jane.example', { status: 503 }));
    const { browser } = fakeBrowser(() => ({ throws: 'Navigation timeout of 25000 ms exceeded' }));
    const r = await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r).toMatchObject({ access: 'unreviewable', accessNote: BOT_WALL_NOTE, pages: [] });
  });

  it('...whereas a throw with a plain error from the plain request stays "error" (our side, retried)', async () => {
    h.safeFetch.mockResolvedValue(new Response('Welcome', { status: 200 }));
    const { browser } = fakeBrowser(() => ({ throws: 'Navigation timeout of 25000 ms exceeded' }));
    expect((await one(browser, linkTo(HOME))).access).toBe('error');
  });

  describe('the designer link audit', () => {
    // every server-side probe says "broken"; the browser then decides, per link
    const audit = async (outbound: FakeSite) => {
      h.safeFetch.mockResolvedValue({ status: 404 });
      const { browser } = fakeBrowser(url => (url === HOME
        ? { anchors: [{ href: 'https://far.example/page', text: 'page' }] }
        : outbound));
      return (await one(browser, linkTo(HOME))).signals;
    };

    it.each([
      ['a Cloudflare challenge (header)', { status: 503, headers: { 'cf-mitigated': 'challenge' }, title: 'x' }],
      ['a "Just a moment..." page', { status: 503, title: 'Just a moment...' }],
      ['an "Attention Required! | Cloudflare" block', { status: 403, title: 'Attention Required! | Cloudflare' }],
    ] as const)('a linked page behind %s is alive: not counted as a broken link', async (_n, outbound) => {
      expect(await audit(outbound)).toMatchObject({ brokenLinksChecked: 1, brokenLinks: 0, brokenLinkSamples: [] });
    });

    it('...while a link that really answers 404 / 403 / 500 is still confirmed broken', async () => {
      for (const status of [404, 403, 500]) {
        expect(await audit({ status, title: 'Not available' })).toMatchObject({ brokenLinksChecked: 1, brokenLinks: 1, brokenLinkSamples: ['https://far.example/page'] });
      }
    });
  });

  it('each link is judged on its own: a walled link does not change its neighbours', async () => {
    const { browser } = fakeBrowser(url => (url.startsWith('https://walled.example')
      ? { status: 403, headers: { 'cf-mitigated': 'challenge' } }
      : { text: 'Real work' }));
    const [walled, fine] = await capture(browser, [linkTo('https://walled.example'), linkTo('https://fine.example')], MARKETING_CAPTURE_OPTS);
    expect(walled.access).toBe('unreviewable');
    expect(fine.access).toBe('ok');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Canva
// ═════════════════════════════════════════════════════════════════════════════
const pageWith = (url: string, shots: number): CapturedPage => ({
  url, title: 't', text: 'x', shots: Array.from({ length: shots }, (_, i) => ({ label: `s${i}`, data: 'd' })),
});

describe('classifyCanva', () => {
  const CANVA = 'https://www.canva.com/design/DAF123/abc/view';

  it('a Canva view link that rendered a screenshot is ok but partial: only the first screens are visible', () => {
    expect(classifyCanva([CANVA], [pageWith(CANVA, 1)])).toEqual({ access: 'ok', partial: true, note: CANVA_PARTIAL_NOTE });
    expect(CANVA_PARTIAL_NOTE).toBe('Canva view link: only the first screens are visible');
  });

  it('...and one that rendered nothing at all is unreviewable (no fault of the candidate)', () => {
    expect(classifyCanva([CANVA], [pageWith(CANVA, 0)])).toEqual({ access: 'unreviewable', note: CANVA_EMPTY_NOTE });
    expect(classifyCanva([CANVA], [pageWith(CANVA, 0), pageWith(CANVA, 0)])?.access).toBe('unreviewable');
  });

  it('one screenshot on any captured page is enough', () => {
    expect(classifyCanva([CANVA], [pageWith(CANVA, 0), pageWith(CANVA, 2)])).toMatchObject({ access: 'ok', partial: true });
  });

  it('a short link is recognised by where it landed', () => {
    expect(classifyCanva(['https://canva.link/xyz', CANVA], [pageWith(CANVA, 1)])).toMatchObject({ access: 'ok', partial: true });
    expect(classifyCanva(['https://canva.link/xyz'], [pageWith('https://canva.link/xyz', 1)])).toBeNull();   // never landed on canva.com
  });

  it.each([
    'https://canva.com/design/X/view', 'https://www.canva.com/design/X/view', 'https://CANVA.COM/design/X/view',
    'https://something.canva.com/x',
  ])('%s is Canva', (url) => {
    expect(classifyCanva([url], [pageWith(url, 1)])?.access).toBe('ok');
  });

  it.each([
    'https://jane.example', 'https://jane.my.canva.site/portfolio', 'https://notcanva.com/design/X', 'https://canva.com.evil.example/x',
    'https://jane.example/canva.com', 'https://jane.example/?u=https://www.canva.com/design/X', 'not a url', '',
  ])('%s is not: nothing about it changes', (url) => {
    expect(classifyCanva([url], [pageWith(url, 1)])).toBeNull();
    expect(classifyCanva([url], [pageWith(url, 0)])).toBeNull();
  });

  it('no urls, no pages', () => {
    expect(classifyCanva([], [])).toBeNull();
  });
});

describe('capturePortfolios — Canva links', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.safeFetch.mockReset();
    h.safeFetch.mockResolvedValue({ status: 200 });
  });
  afterEach(() => { vi.useRealTimers(); });

  const CANVA = 'https://www.canva.com/design/DAF123/abc/view';

  // Canva handling is opt-in (canvaPartial, on for the marketing review only): the designer review captures canva.com as
  // the ordinary site it always was ([3.7]; the "designer" describe below pins that).
  describe('marketing (canvaPartial)', () => {
    const MKT = MARKETING_CAPTURE_OPTS;

    it('a Canva view link that loads is ok and flagged partial, with the note', async () => {
      const r = await one(fakeBrowser(() => ({ text: 'A deck' })).browser, linkTo(CANVA, 'canva'), MKT);
      expect(r).toMatchObject({ access: 'ok', partial: true, accessNote: CANVA_PARTIAL_NOTE });
      expect(r.pages).toHaveLength(1);
      expect(r.pages[0].shots.length).toBeGreaterThan(0);
    });

    it('...even when the platform label is just "custom": it is detected by host', async () => {
      const r = await one(fakeBrowser(() => ({ text: 'A deck' })).browser, linkTo(CANVA, 'custom'), MKT);
      expect(r).toMatchObject({ access: 'ok', partial: true });
    });

    it('a canva.link short link counts once it has landed on canva.com', async () => {
      const r = await one(fakeBrowser(() => ({ finalUrl: CANVA })).browser, linkTo('https://canva.link/abc', 'canva'), MKT);
      expect(r).toMatchObject({ access: 'ok', partial: true, accessNote: CANVA_PARTIAL_NOTE });
    });

    it('no screenshot at all => unreviewable (nothing to look at, no fault of the candidate)', async () => {
      const { browser, log } = fakeBrowser(() => ({ noShots: true }));
      const r = await one(browser, linkTo(CANVA, 'canva'), MKT);
      expect(r).toMatchObject({ access: 'unreviewable', accessNote: CANVA_EMPTY_NOTE });
      expect(r.partial).toBeUndefined();
      expect(log.viewports).toEqual([1280]);
      expect(h.safeFetch).not.toHaveBeenCalled();
    });

    it('a private Canva design that bounces to the sign-in page is blocked (the candidate\'s link), not partial', async () => {
      const r = await one(fakeBrowser(() => ({ finalUrl: 'https://www.canva.com/login?redirect=%2Fdesign', text: 'Log in' })).browser, linkTo(CANVA, 'canva'), MKT);
      expect(r).toMatchObject({ access: 'blocked', accessNote: 'Canva design is private — sign-in required' });
      expect(r.partial).toBeUndefined();
    });

    it('a Canva link that is walled keeps the wall verdict', async () => {
      const r = await one(fakeBrowser(() => ({ status: 403, headers: { 'cf-mitigated': 'challenge' } })).browser, linkTo(CANVA, 'canva'), MKT);
      expect(r).toMatchObject({ access: 'unreviewable', accessNote: BOT_WALL_NOTE });
    });

    it.each([
      ['a published Canva website', 'https://jane.my.canva.site/portfolio'],
      ['an ordinary site', HOME],
      ['a look-alike host', 'https://canva.com.evil.example/x'],
    ])('%s is left exactly as it was: ok, not partial, no note', async (_n, url) => {
      const r = await one(fakeBrowser(() => ({ text: 'Work' })).browser, linkTo(url), MKT);
      expect(r.access).toBe('ok');
      expect(r.partial).toBeUndefined();
      expect(r.accessNote).toBeUndefined();
    });
  });

  // The designer review (R007) must read canva.com exactly as it did before Canva handling existed: an ordinary site
  // captured, whatever it rendered, with no partial flag, no note and no sign-in verdict.
  describe('designer (canvaPartial off): canva.com is an ordinary site, byte-identical to before', () => {
    it.each([['default options', undefined], ['DESIGNER_CAPTURE_OPTS', DESIGNER_CAPTURE_OPTS]] as const)('%s: a Canva view link that loads is plainly ok — not partial, no note', async (_n, opts) => {
      const r = await one(fakeBrowser(() => ({ text: 'A deck' })).browser, linkTo(CANVA, 'canva'), opts);
      expect(r.access).toBe('ok');
      expect(r.partial).toBeUndefined();
      expect(r.accessNote).toBeUndefined();
      expect(r.pages).toHaveLength(1);
    });

    it('a Canva page that rendered no screenshot is still ok with the text that was captured (it used to be)', async () => {
      const { browser, log } = fakeBrowser(() => ({ noShots: true, text: 'The words on the design' }));
      const r = await one(browser, linkTo(CANVA, 'canva'));
      expect(r.access).toBe('ok');
      expect(r.accessNote).toBeUndefined();
      expect(r.pages[0].text).toBe('The words on the design');
      expect(log.viewports).toEqual([1280, 390]);   // and the designer extras still run
    });

    it('a Canva sign-in page is not given a verdict of its own (it used to be read like any page)', async () => {
      const r = await one(fakeBrowser(() => ({ finalUrl: 'https://www.canva.com/login?redirect=%2Fdesign', text: 'Log in' })).browser, linkTo(CANVA, 'canva'));
      expect(r.access).toBe('ok');
      expect(r.accessNote).toBeUndefined();
    });

    it('a canva.link short link that landed on canva.com is likewise left alone', async () => {
      const r = await one(fakeBrowser(() => ({ finalUrl: CANVA })).browser, linkTo('https://canva.link/abc', 'canva'));
      expect(r).toMatchObject({ access: 'ok' });
      expect(r.partial).toBeUndefined();
    });

    it('the designer extras (phone render, link audit) run on a Canva capture as on any site', async () => {
      const { browser, log } = fakeBrowser(() => ({ text: 'A deck' }));
      const r = await one(browser, linkTo(CANVA, 'canva'));
      expect(log.viewports).toEqual([1280, 390]);
      expect(r.mobileShot).toBeDefined();
    });

    it('a Canva link that is walled still gets the wall verdict (bot walls are for both reviews)', async () => {
      const r = await one(fakeBrowser(() => ({ status: 403, headers: { 'cf-mitigated': 'challenge' } })).browser, linkTo(CANVA, 'canva'));
      expect(r).toMatchObject({ access: 'unreviewable', accessNote: BOT_WALL_NOTE });
    });

    it('classifyCanva and the sign-in rule are not reached at all: the same site, designer vs marketing, differs only in these', async () => {
      const designer = await one(fakeBrowser(() => ({ text: 'A deck' })).browser, linkTo(CANVA, 'canva'), { ...ALL_OFF, canvaPartial: false });
      const marketing = await one(fakeBrowser(() => ({ text: 'A deck' })).browser, linkTo(CANVA, 'canva'), { ...ALL_OFF, canvaPartial: true });
      expect({ ...marketing, partial: undefined, accessNote: undefined }).toEqual({ ...designer, partial: undefined, accessNote: undefined });
      expect(marketing.partial).toBe(true);
      expect(designer.partial).toBeUndefined();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// No WebSockets: the request filter cannot see their handshakes ([5.8])
// ═════════════════════════════════════════════════════════════════════════════
describe('capturePortfolios — the marketing page is locked down before it navigates anywhere; the designer page is not', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.safeFetch.mockReset();
    h.safeFetch.mockResolvedValue({ status: 200 });
  });
  afterEach(() => { vi.useRealTimers(); });

  const designer = [['designer (default options)', undefined], ['designer', DESIGNER_CAPTURE_OPTS]] as const;

  it('marketing: the script is installed once per page, before the first navigation', async () => {
    const { browser, log } = fakeBrowser(() => ({ text: 'A page about the work' }));
    const r = await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.access).toBe('ok');
    expect(log.lockdowns).toEqual([{ script: lockdownScript({ blockWorkers: true }), gotosBefore: 0 }]);
  });

  it.each(designer)('%s: NO lockdown script is injected at all — R007 captures run exactly as they did before the marketing review existed', async (_n, opts) => {
    const { browser, log } = fakeBrowser(() => ({ text: 'A page about the work' }));
    const r = await one(browser, linkTo(HOME), opts);
    expect(r.access).toBe('ok');
    expect(log.lockdowns).toEqual([]);
  });

  it('the lockdown follows the option, not the review kind: `lockdown` on installs it (with or without workers), off installs nothing', async () => {
    for (const [lockdown, blockWorkers, expected] of [[true, false, [false]], [true, true, [true]], [false, true, []], [false, false, []]] as const) {
      const { browser, log } = fakeBrowser(() => ({ text: 'x' }));
      await one(browser, linkTo(HOME), { ...ALL_OFF, lockdown, blockWorkers });
      expect(log.lockdowns.map(l => l.script), `lockdown=${lockdown} blockWorkers=${blockWorkers}`).toEqual(expected.map(w => lockdownScript({ blockWorkers: w })));
    }
  });

  it('each portfolio gets its own page and so its own lockdown', async () => {
    const { browser, log } = fakeBrowser(() => ({ text: 'x' }));
    await capture(browser, [linkTo('https://a.example'), linkTo('https://b.example'), linkTo('https://c.example')], MARKETING_CAPTURE_OPTS);
    expect(log.lockdowns).toHaveLength(3);
    // each install came before that page's own first navigation: one navigation per portfolio here, so 0, 1, 2 so far
    expect(log.lockdowns.map(l => l.gotosBefore)).toEqual([0, 1, 2]);
  });

  it('only the marketing review also takes workers away', () => {
    expect(DESIGNER_CAPTURE_OPTS.blockWorkers).toBe(false);
    expect(MARKETING_CAPTURE_OPTS.blockWorkers).toBe(true);
    const designer = lockdownScript({ blockWorkers: false });
    const marketing = lockdownScript({ blockWorkers: true });
    for (const name of BLOCKED_WORKER_APIS) {
      expect(designer).not.toContain(`"${name}"`);
      expect(marketing).toContain(`"${name}"`);
    }
    expect(designer).not.toContain('ServiceWorkerContainer');
    expect(marketing).toContain('ServiceWorkerContainer');
    for (const name of BLOCKED_REALTIME_APIS) { expect(designer).toContain(`"${name}"`); expect(marketing).toContain(`"${name}"`); }
  });

  it('marketing: if the lockdown cannot be installed nothing is opened — a retryable error, never held against the candidate', async () => {
    const { browser, log } = fakeBrowser(() => ({ text: 'A page' }), { lockdownThrows: true });
    const r = await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.access).toBe('error');
    expect(r.accessNote).toMatch(/^Capture failed \(Protocol error/);
    expect(r.pages).toEqual([]);
    expect(log.gotos).toEqual([]);      // not one navigation
    expect(log.closed).toBe(1);         // and the page is still released
  });

  it.each(designer)('%s: a failing lockdown install cannot matter, because the designer never asks for one', async (_n, opts) => {
    const { browser, log } = fakeBrowser(() => ({ text: 'A page' }), { lockdownThrows: true });
    const r = await one(browser, linkTo(HOME), opts);
    expect(r.access).toBe('ok');
    expect(log.gotos.length).toBeGreaterThan(0);
  });

  it('an unsafe link never reaches the page at all, so there is nothing to lock down', async () => {
    const { browser, log } = fakeBrowser(() => ({ text: 'x' }));
    const r = await one(browser, linkTo('https://x.example/deck.pdf', 'pdf_file'), MARKETING_CAPTURE_OPTS);
    expect(r.access).toBe('skipped');
    expect(log.lockdowns).toEqual([]);
    expect(log.gotos).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// No popups: a new page target never meets the request filter ([F20])
// ═════════════════════════════════════════════════════════════════════════════
describe('capturePortfolios — popups (marketing only)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.safeFetch.mockReset();
    h.safeFetch.mockResolvedValue({ status: 200 });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('marketing: reads the page without ever granting it a user gesture (no page.evaluate, no page.title), over one CDP session with userGesture:false', async () => {
    const { browser, log } = fakeBrowser(richSite);
    const r = await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.pages.length).toBeGreaterThan(1);
    expect(log.gestureReads).toBe(0);
    expect(log.cdpSessions).toBe(1);                       // one per page, opened lazily and reused
    expect(log.cdpEvals.length).toBeGreaterThan(10);
    expect(log.cdpEvals.every(e => e.userGesture === false)).toBe(true);
  });

  it.each([['designer (default options)', undefined], ['designer', DESIGNER_CAPTURE_OPTS]] as const)('%s: reads exactly as before — page.evaluate / page.title, no CDP session, no target listener', async (_n, opts) => {
    const { browser, log } = fakeBrowser(richSite);
    const r = await one(browser, linkTo(HOME), opts);
    expect(r.pages.length).toBeGreaterThan(1);
    expect(log.gestureReads).toBeGreaterThan(10);
    expect(log.cdpSessions).toBe(0);
    expect(log.listeners).toEqual([]);
  });

  it('what is read is the same either way: the capture with and without the no-gesture reads is identical', async () => {
    const a = await one(fakeBrowser(richSite).browser, linkTo(HOME), { ...MARKETING_CAPTURE_OPTS, blockPopups: false });
    const b = await one(fakeBrowser(richSite).browser, linkTo(HOME), { ...MARKETING_CAPTURE_OPTS, blockPopups: true });
    expect(b).toEqual(a);
    expect(b.pages.length).toBeGreaterThan(1);
  });

  it('a bot-wall probe reads the title through the same no-gesture path', async () => {
    const { browser, log } = fakeBrowser(() => ({ status: 403, title: 'Just a moment...', text: 'Checking your browser' }));
    const r = await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.access).toBe('unreviewable');
    expect(log.gestureReads).toBe(0);
    expect(log.cdpEvals.some(e => e.expression === 'document.title')).toBe(true);
  });

  it('marketing: listens for new targets while the portfolio is open and stops when it is done', async () => {
    const { browser, log, handlers } = fakeBrowser(richSite);
    await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(log.listeners).toEqual([['on', 'targetcreated'], ['off', 'targetcreated']]);
    expect(handlers.size).toBe(0);
  });

  it('each portfolio has its own listener, removed before the next one starts', async () => {
    const { browser, log } = fakeBrowser(() => ({ text: 'x' }));
    await capture(browser, [linkTo('https://a.example'), linkTo('https://b.example')], MARKETING_CAPTURE_OPTS);
    expect(log.listeners).toEqual([['on', 'targetcreated'], ['off', 'targetcreated'], ['on', 'targetcreated'], ['off', 'targetcreated']]);
  });

  it('the listener is removed when the capture fails too', async () => {
    const { browser, log, handlers } = fakeBrowser(() => ({ throws: 'net::ERR_NAME_NOT_RESOLVED' }));
    h.safeFetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(log.listeners).toEqual([['on', 'targetcreated'], ['off', 'targetcreated']]);
    expect(handlers.size).toBe(0);
    expect(log.closed).toBe(1);
  });

  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  it('closeExtraPages closes a popup the moment it appears, and nothing else', async () => {
    const { browser, log, popup, page } = fakeBrowser(() => ({}));
    closeExtraPages(browser, page as never);
    popup('page', 'window.open');
    popup('page', 'target=_blank link');
    popup('service_worker', 'a worker');       // not a page: left to the lockdown
    popup('other', 'something else');
    await flush();
    expect(log.closedPopups).toEqual(['window.open', 'target=_blank link']);
  });

  it('closeExtraPages never closes the capture\'s own page, even if its creation is announced after the listener is installed', async () => {
    const { browser, log, handlers, ownTarget, page } = fakeBrowser(() => ({}));
    closeExtraPages(browser, page as never);
    for (const fn of [...handlers]) fn(ownTarget);
    await flush();
    expect(log.closedPopups).toEqual([]);
  });

  it('closeExtraPages survives a popup that cannot be closed (the target is gone already)', async () => {
    const { browser, handlers, page } = fakeBrowser(() => ({}));
    closeExtraPages(browser, page as never);
    for (const gone of [
      { type: () => 'page', page: async () => { throw new Error('Target closed'); } },
      { type: () => 'page', page: async () => null },
      { type: () => 'page', page: async () => ({ close: async () => { throw new Error('Protocol error'); } }) },
    ]) {
      expect(() => { for (const fn of [...handlers]) fn(gone); }).not.toThrow();
    }
    await flush();     // no unhandled rejection: vitest would fail the run
  });

  it('closeExtraPages returns an unsubscribe that removes exactly its own listener', () => {
    const { browser, log, handlers, page } = fakeBrowser(() => ({}));
    const stop = closeExtraPages(browser, page as never);
    expect(handlers.size).toBe(1);
    stop();
    expect(handlers.size).toBe(0);
    expect(log.listeners).toEqual([['on', 'targetcreated'], ['off', 'targetcreated']]);
  });
});

describe('launchedWithoutPopupBlocking — saying so when the launch flag did not reach the browser', () => {
  const withArgs = (spawnargs: string[] | null | undefined) =>
    ({ process: () => (spawnargs === undefined ? undefined : spawnargs === null ? null : { spawnargs }) }) as unknown as Browser;

  it('a browser we spawned with --block-new-web-contents is fine; one spawned without it is not', () => {
    expect(launchedWithoutPopupBlocking(withArgs(['--no-sandbox', '--block-new-web-contents']))).toBe(false);
    expect(launchedWithoutPopupBlocking(withArgs(['--no-sandbox', '--disable-dev-shm-usage']))).toBe(true);
    expect(launchedWithoutPopupBlocking(withArgs([]))).toBe(true);
  });

  it('a remote browser we only connected to (no process) says nothing either way', () => {
    expect(launchedWithoutPopupBlocking(withArgs(null))).toBe(false);
    expect(launchedWithoutPopupBlocking(withArgs(undefined))).toBe(false);
    expect(launchedWithoutPopupBlocking({} as Browser)).toBe(false);
  });

  describe('capturePortfolios logs it', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      h.safeFetch.mockReset();
      h.safeFetch.mockResolvedValue({ status: 200 });
    });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
    const spawned = (args: string[]) => { const f = fakeBrowser(() => ({ text: 'x' })); (f.browser as unknown as { process: () => unknown }).process = () => ({ spawnargs: args }); return f; };

    it('once per call (not per portfolio) when marketing options meet a browser launched without the flag', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await capture(spawned(['--no-sandbox']).browser, [linkTo('https://a.example'), linkTo('https://b.example')], MARKETING_CAPTURE_OPTS);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/browserOptionsFor/);
    });

    it('not when the flag is there', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await capture(spawned(['--no-sandbox', '--block-new-web-contents']).browser, [linkTo(HOME)], MARKETING_CAPTURE_OPTS);
      expect(warn).not.toHaveBeenCalled();
    });

    it('never for the designer review, which asks for no popup blocking', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await capture(spawned(['--no-sandbox']).browser, [linkTo(HOME)], DESIGNER_CAPTURE_OPTS);
      await capture(spawned(['--no-sandbox']).browser, [linkTo(HOME)]);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe('withoutUserGesture — the page reads that never hand the page a user gesture', () => {
  function fakePage() {
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    let sessions = 0;
    let reply: (expression: string) => unknown = () => ({ result: { type: 'undefined' } });
    const real = {
      evaluate: vi.fn(async () => 'GESTURE evaluate'),
      title: vi.fn(async () => 'GESTURE title'),
      createCDPSession: async () => {
        sessions++;
        return { send: async (method: string, params: Record<string, unknown>) => { sent.push({ method, params }); return reply(String(params.expression)); } };
      },
      goto: vi.fn(async function (this: unknown, url: string) { return { self: this, url }; }),
      url: () => 'https://x.example/',
    };
    return { real, sent, sessions: () => sessions, setReply: (fn: typeof reply) => { reply = fn; } };
  }

  it('runs a function in the page through Runtime.evaluate with userGesture:false, its arguments as JSON', async () => {
    const f = fakePage();
    f.setReply(() => ({ result: { type: 'number', value: 800 } }));
    const view = withoutUserGesture(f.real as never);
    const v = await view.evaluate((y: number, label: string) => window.scrollTo(0, y) ?? label, 120, 'a "quoted" label');
    expect(v).toBe(800);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].method).toBe('Runtime.evaluate');
    expect(f.sent[0].params).toMatchObject({ returnByValue: true, awaitPromise: true, userGesture: false });
    const expression = String(f.sent[0].params.expression);
    expect(expression).toMatch(/^\(.*window\.scrollTo.*\)\(120, "a \\"quoted\\" label"\)$/s);
    expect(() => new vm.Script(expression)).not.toThrow();
    expect(f.real.evaluate).not.toHaveBeenCalled();
  });

  it('sends undefined and no-argument calls as valid source', async () => {
    const f = fakePage();
    const view = withoutUserGesture(f.real as never);
    await view.evaluate(() => 1);
    await view.evaluate((a: unknown, b: unknown) => [a, b], undefined, null);
    expect(String(f.sent[0].params.expression)).toMatch(/\)\(\)$/);
    expect(String(f.sent[1].params.expression)).toMatch(/\)\(undefined, null\)$/);
    for (const s of f.sent) expect(() => new vm.Script(String(s.params.expression))).not.toThrow();
  });

  it('a string is run as it is', async () => {
    const f = fakePage();
    const view = withoutUserGesture(f.real as never);
    await view.evaluate('1 + 2');
    expect(f.sent[0].params.expression).toBe('1 + 2');
  });

  it('title() reads document.title the same way, and never calls the page\'s own title()', async () => {
    const f = fakePage();
    f.setReply(() => ({ result: { type: 'string', value: 'Portfolio' } }));
    const view = withoutUserGesture(f.real as never);
    expect(await view.title()).toBe('Portfolio');
    expect(f.sent[0].params).toMatchObject({ expression: 'document.title', userGesture: false });
    expect(f.real.title).not.toHaveBeenCalled();
  });

  it('opens one session, lazily, and reuses it (and concurrent first reads share it)', async () => {
    const f = fakePage();
    const view = withoutUserGesture(f.real as never);
    expect(f.sessions()).toBe(0);
    await Promise.all([view.evaluate(() => 1), view.evaluate(() => 2), view.title()]);
    await view.evaluate(() => 3);
    expect(f.sessions()).toBe(1);
    expect(f.sent).toHaveLength(4);
  });

  it('a script error in the page rejects with its description, like page.evaluate does', async () => {
    const f = fakePage();
    f.setReply(() => ({ result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: nope is not defined' } } }));
    const view = withoutUserGesture(f.real as never);
    await expect(view.evaluate(() => 1)).rejects.toThrow('ReferenceError: nope is not defined');
    f.setReply(() => ({ result: { type: 'object' }, exceptionDetails: { text: 'Uncaught' } }));
    await expect(view.evaluate(() => 1)).rejects.toThrow('Uncaught');
  });

  it('every other member is the real page\'s, bound to it', async () => {
    const f = fakePage();
    const view = withoutUserGesture(f.real as never);
    expect(view.url()).toBe('https://x.example/');
    const res = await view.goto('https://x.example/work') as unknown as { self: unknown; url: string };
    expect(res.url).toBe('https://x.example/work');
    expect(res.self).toBe(f.real);
    expect(f.sessions()).toBe(0);      // not opened by anything but a read
  });
});

describe('lockdownScript — what the injected script does inside the page', () => {
  // The script is plain text run by Chromium before any page script. Here it runs in a bare vm context that stands in for
  // the page's window, holding the APIs a real browser has.
  const REAL_APIS = [...BLOCKED_REALTIME_APIS, ...BLOCKED_WORKER_APIS];
  function pageWith(hostname: string, present: readonly string[] = [...REAL_APIS, 'fetch', 'XMLHttpRequest', 'Image']) {
    const sandbox: Record<string, unknown> = { location: { hostname }, DOMException };
    sandbox.window = sandbox;
    for (const name of present) sandbox[name] = class { constructor() { /* the real thing: would connect */ } };
    class ServiceWorkerContainer { register() { return Promise.resolve('registered'); } }
    sandbox.ServiceWorkerContainer = ServiceWorkerContainer;
    return vm.createContext(sandbox) as Record<string, any>;
  }
  const run = (script: string, ctx: object) => vm.runInContext(script, ctx);
  const threw = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return e as DOMException; } };

  it.each(BLOCKED_REALTIME_APIS.map(n => [n]))('%s throws a SecurityError when constructed, and when merely called', (name) => {
    const ctx = pageWith('candidate.example');
    run(lockdownScript({ blockWorkers: false }), ctx);
    for (const attempt of [() => new ctx[name]('ws://127.0.0.1:9001/'), () => ctx[name]('ws://127.0.0.1:9001/'), () => new ctx[name]()]) {
      const e = threw(attempt);
      expect(e).toBeInstanceOf(DOMException);
      expect(e?.name).toBe('SecurityError');
    }
  });

  it('the replacement cannot be undone by the page: not writable, not configurable, not deletable', () => {
    const ctx = pageWith('candidate.example');
    run(lockdownScript({ blockWorkers: false }), ctx);
    const before = ctx.WebSocket;
    expect(run('Object.getOwnPropertyDescriptor(window, "WebSocket").writable', ctx)).toBe(false);
    expect(run('Object.getOwnPropertyDescriptor(window, "WebSocket").configurable', ctx)).toBe(false);
    // sloppy-mode assignment and delete fail silently; strict mode and defineProperty throw
    run('window.WebSocket = function Native() {}; delete window.WebSocket;', ctx);
    expect(ctx.WebSocket).toBe(before);
    // (the vm context has its own TypeError class, so the error is matched by what it says)
    expect(() => run('"use strict"; window.WebSocket = 1', ctx)).toThrow(/read only property 'WebSocket'/);
    expect(() => run('Object.defineProperty(window, "WebSocket", { value: 1 })', ctx)).toThrow(/Cannot redefine property: WebSocket/);
  });

  it('an API this browser does not have is not invented (a page that feature-detects must still see it missing)', () => {
    const ctx = pageWith('candidate.example', ['WebSocket', 'EventSource']);
    run(lockdownScript({ blockWorkers: true }), ctx);
    for (const name of ['WebSocketStream', 'WebTransport', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'Worker', 'SharedWorker']) {
      expect(name in ctx, name).toBe(false);
    }
    expect(threw(() => new ctx.WebSocket('ws://x'))?.name).toBe('SecurityError');
  });

  it('nothing else is touched: HTTP stays available (the request filter covers it)', () => {
    const ctx = pageWith('candidate.example');
    const before = { fetch: ctx.fetch, xhr: ctx.XMLHttpRequest, image: ctx.Image };
    run(lockdownScript({ blockWorkers: true }), ctx);
    expect({ fetch: ctx.fetch, xhr: ctx.XMLHttpRequest, image: ctx.Image }).toEqual(before);
    expect(threw(() => new ctx.XMLHttpRequest())).toBeNull();
  });

  it('designer: workers and service workers are left alone, exactly as before', async () => {
    const ctx = pageWith('candidate.example');
    run(lockdownScript({ blockWorkers: false }), ctx);
    expect(threw(() => new ctx.Worker('/w.js'))).toBeNull();
    expect(threw(() => new ctx.SharedWorker('/s.js'))).toBeNull();
    await expect(new ctx.ServiceWorkerContainer().register('/sw.js')).resolves.toBe('registered');
  });

  it('marketing: a Worker, a SharedWorker and a service worker are refused (the one way left to open a socket)', async () => {
    const ctx = pageWith('candidate.example');
    run(lockdownScript({ blockWorkers: true }), ctx);
    expect(threw(() => new ctx.Worker('/w.js'))?.name).toBe('SecurityError');
    expect(threw(() => new ctx.SharedWorker('/s.js'))?.name).toBe('SecurityError');
    await expect(new ctx.ServiceWorkerContainer().register('/sw.js')).rejects.toMatchObject({ name: 'SecurityError' });
    expect(run('Object.getOwnPropertyDescriptor(ServiceWorkerContainer.prototype, "register").configurable', ctx)).toBe(false);
  });

  it('a browser without ServiceWorkerContainer is fine', () => {
    const ctx = pageWith('candidate.example');
    delete ctx.ServiceWorkerContainer;
    expect(() => run(lockdownScript({ blockWorkers: true }), ctx)).not.toThrow();
  });

  it.each([['www.figma.com'], ['figma.com'], ['FIGMA.COM'], ['file.figma.com']])('%s (Figma\'s own viewer) is left alone, in both variants', (host) => {
    for (const blockWorkers of [false, true]) {
      const ctx = pageWith(host);
      const before = Object.fromEntries(REAL_APIS.map(n => [n, ctx[n]]));
      run(lockdownScript({ blockWorkers }), ctx);
      expect(Object.fromEntries(REAL_APIS.map(n => [n, ctx[n]]))).toEqual(before);
      expect(threw(() => new ctx.WebSocket('wss://www.figma.com/api/multiplayer/x'))).toBeNull();
    }
  });

  it.each([
    ['figma.site'], ['jane.figma.site'], ['figma.com.evil.example'], ['evil-figma.com'], ['notfigma.com'], ['figma.company'], ['candidate.example'], [''],
  ])('%j is NOT Figma: it is locked like any other site', (host) => {
    const ctx = pageWith(host);
    run(lockdownScript({ blockWorkers: false }), ctx);
    expect(threw(() => new ctx.WebSocket('ws://127.0.0.1:9001/'))?.name).toBe('SecurityError');
  });

  it('is plain source: no transpiler helper in it (a `__name(...)` call would throw inside the page and protect nothing)', () => {
    for (const blockWorkers of [false, true]) {
      const script = lockdownScript({ blockWorkers });
      expect(script).not.toMatch(/__name|__defProp|__publicField|_a\b/);
      expect(() => new vm.Script(script)).not.toThrow();
      expect(typeof script).toBe('string');
    }
  });

  it('the list of APIs is exactly the decided one', () => {
    expect([...BLOCKED_REALTIME_APIS]).toEqual(['WebSocket', 'WebSocketStream', 'WebTransport', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'EventSource']);
    expect([...BLOCKED_WORKER_APIS]).toEqual(['Worker', 'SharedWorker']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A guarded teardown: what a page can still send while its document goes away (marketing only)
// ═════════════════════════════════════════════════════════════════════════════
describe('capturePortfolios — the teardown guard (marketing only)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.safeFetch.mockReset();
    h.safeFetch.mockResolvedValue({ status: 200 });
    h.hostIsPublic = async () => true;
  });
  afterEach(() => { vi.useRealTimers(); h.hostIsPublic = async () => true; vi.restoreAllMocks(); });

  const designer = [['designer (default options)', undefined], ['designer', DESIGNER_CAPTURE_OPTS]] as const;

  it('marketing: every navigation after the first goes through an empty page with the scripts off, and the close comes last, scripts off', async () => {
    const { browser, log } = fakeBrowser(richSite);
    const r = await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.pages).toHaveLength(4);
    expect(log.events).toEqual([
      'goto',
      'js:off', 'blank', 'js:on', 'goto',
      'js:off', 'blank', 'js:on', 'goto',
      'js:off', 'blank', 'js:on', 'goto',
      'js:off', 'close',
    ]);
    expect(log.gotos).toEqual([HOME, ...WORK_PAGES.slice(0, 3)]);     // the empty page is not a navigation the capture counts
  });

  it('marketing: the first navigation is not preceded by anything (there is no document to leave yet)', async () => {
    const { browser, log } = fakeBrowser(() => ({ text: 'x' }));
    await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(log.events).toEqual(['goto', 'js:off', 'close']);
  });

  it.each(designer)('%s: no script is ever switched off, no empty page, no wait: the teardown is exactly page.close()', async (_n, opts) => {
    const { browser, log } = fakeBrowser(richSite);
    const r = await one(browser, linkTo(HOME), opts);
    expect(r.pages.length).toBeGreaterThan(1);
    expect(log.jsToggles).toEqual([]);
    expect(log.events.filter(e => e !== 'goto')).toEqual(['close']);
  });

  it('what is captured is the same with and without the guard', async () => {
    const a = await one(fakeBrowser(richSite).browser, linkTo(HOME), { ...MARKETING_CAPTURE_OPTS, guardTeardown: false });
    const b = await one(fakeBrowser(richSite).browser, linkTo(HOME), { ...MARKETING_CAPTURE_OPTS, guardTeardown: true });
    expect(b).toEqual(a);
  });

  it('the option decides, not the review kind: guardTeardown alone turns it on, and off with everything else on', async () => {
    const on = fakeBrowser(() => ({ text: 'x' }));
    await one(on.browser, linkTo(HOME), { ...ALL_OFF, guardTeardown: true });
    expect(on.log.jsToggles).toEqual([false]);
    const off = fakeBrowser(() => ({ text: 'x' }));
    await one(off.browser, linkTo(HOME), { ...MARKETING_CAPTURE_OPTS, guardTeardown: false });
    expect(off.log.jsToggles).toEqual([]);
  });

  it('scripts that cannot be switched off before a navigation: that page is not navigated to (skipped), the pages already read are kept', async () => {
    const { browser, log } = fakeBrowser(richSite, { jsOffThrows: true });
    const r = await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.access).toBe('ok');
    expect(r.pages.map(p => p.url)).toEqual([HOME]);
    expect(log.gotos).toEqual([HOME]);
    expect(log.events).not.toContain('blank');
    expect(log.closed).toBe(1);          // and the page is still closed
  });

  it('scripts that never answer to being switched off: bounded, the navigation is not made, the capture still ends and closes', async () => {
    const { browser, log } = fakeBrowser(richSite, { jsOffHangs: true });
    const r = await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.access).toBe('ok');
    expect(r.pages.map(p => p.url)).toEqual([HOME]);
    expect(log.events).not.toContain('blank');
    expect(log.closed).toBe(1);
  });

  it('an empty page that cannot be reached: scripts stay off, the page is not navigated to, never a page captured over the old document', async () => {
    const { browser, log } = fakeBrowser(richSite, { blankFails: true });
    const r = await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.pages.map(p => p.url)).toEqual([HOME]);
    expect(log.gotos).toEqual([HOME]);
    expect(log.jsToggles).not.toContain(true);
  });

  it('scripts that cannot be switched back on: that navigation is not made (a page that could not run its scripts would read as blank)', async () => {
    const { browser, log } = fakeBrowser(richSite, { jsOnThrows: true });
    const r = await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.pages.map(p => p.url)).toEqual([HOME]);
    expect(log.gotos).toEqual([HOME]);
  });

  it('a page that does not close: the wait is bounded, the capture ends, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { browser } = fakeBrowser(() => ({ text: 'x' }), { closeHangs: true });
    const r = await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.access).toBe('ok');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/did not close within 10s/));
  });

  it('designer: a page that does not close is waited for exactly as before (no cap, no warning)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { browser } = fakeBrowser(() => ({ text: 'x' }), { closeHangs: true });
    let done = false;
    const run = capturePortfolios(browser, [linkTo(HOME)], Date.now() + 600_000, DESIGNER_CAPTURE_OPTS).then(r => { done = true; return r; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(done).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    void run;
  });

  it('the per-portfolio time cap closes the abandoned page through the guard too: scripts off first, then the close', async () => {
    const { browser, log } = fakeBrowser(() => ({ hangs: true }));
    const r = await one(browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.access).toBe('error');
    expect(r.signals.truncated).toBe(true);
    expect(log.events.slice(-2)).toEqual(['js:off', 'close']);
  });

  describe('the guard on its own', () => {
    function parts(o: { blank?: Promise<unknown>; targets?: FakeTarget[] } = {}) {
      const toggles: boolean[] = [];
      const page = {
        setJavaScriptEnabled: async (v: boolean) => { toggles.push(v); },
        goto: async (url: string) => { if (url === 'about:blank') await o.blank; return null; },
      };
      const browser = { targets: () => o.targets ?? [] };
      return { guard: makeTeardownGuard(browser as unknown as Browser, page as never), toggles };
    }
    const flush = async () => { await vi.advanceTimersByTimeAsync(500); };

    it('a navigation still in flight when the guard is sealed never switches the scripts back on, and does not go on to navigate', async () => {
      let release!: () => void;
      const { guard, toggles } = parts({ blank: new Promise<void>(r => { release = r; }) });
      const nav = guard.beforeNavigation();
      const settled = nav.then(() => 'resolved', (e: Error) => e.message);
      await flush();                         // scripts off, about:blank requested and waiting
      const sealed = guard.seal();
      await flush();
      release();                             // the empty page arrives after the seal
      await sealed;
      expect(await settled).toBe('The page is being closed');
      expect(toggles).not.toContain(true);
    });

    it('a sealed guard refuses another navigation', async () => {
      const { guard } = parts();
      const sealed = guard.seal();
      await flush(); await sealed;
      await expect(guard.beforeNavigation()).rejects.toThrow(/being closed/);
    });

    it('seal is idempotent: the second call is the first one', async () => {
      const { guard, toggles } = parts();
      const a = guard.seal(); const b = guard.seal();
      await flush(); await Promise.all([a, b]);
      expect(toggles).toEqual([false]);
    });

    it('a request that arrives while the guard is holding is answered with an abort on sight, never shown to the check', async () => {
      const { guard } = parts();
      const sealed = guard.seal();
      const { req, raw } = fakeRequest('https://x.example/late');
      const check = vi.fn(async () => {});
      guard.filter(req, check);
      await flush(); await sealed;
      expect(check).not.toHaveBeenCalled();
      expect(raw.abort).toHaveBeenCalledWith('blockedbyclient');
    });

    it('requests the check is still working on are aborted and the abort is acknowledged before seal() returns', async () => {
      const { guard } = parts();
      const a = fakeRequest('https://x.example/a'); const b = fakeRequest('https://x.example/b');
      guard.filter(a.req, () => new Promise<void>(() => {}));       // a verdict that never comes
      guard.filter(b.req, () => new Promise<void>(() => {}));
      const sealed = guard.seal();
      await flush(); await sealed;
      expect(a.answers).toEqual(['abort(blockedbyclient)']);
      expect(b.answers).toEqual(['abort(blockedbyclient)']);
    });

    it('a request the check has answered is no longer waiting: it is not aborted again', async () => {
      const { guard } = parts();
      const { req, raw } = fakeRequest('https://x.example/done');
      guard.filter(req, async r => { void r.continue(); });
      await flush();
      const sealed = guard.seal();
      await flush(); await sealed;
      expect(raw.continue).toHaveBeenCalledTimes(1);
      expect(raw.abort).not.toHaveBeenCalled();
    });

    it('an abort that fails does not stop the seal (the target may be gone already)', async () => {
      const { guard } = parts();
      const { req, raw } = fakeRequest('https://x.example/gone');
      raw.abort.mockRejectedValue(new Error('Target closed'));
      guard.filter(req, () => new Promise<void>(() => {}));
      const sealed = guard.seal();
      await flush();
      await expect(sealed).resolves.toBeUndefined();
    });

    it('between navigations requests flow again once the empty page is there (holding ends with the navigation step)', async () => {
      const { guard } = parts();
      const nav = guard.beforeNavigation();
      await flush(); await nav;
      const { req } = fakeRequest('https://x.example/next-page');
      const check = vi.fn(async () => {});
      guard.filter(req, check);
      expect(check).toHaveBeenCalledTimes(1);
    });

    describe('a cross-site iframe has a target of its own', () => {
      const frame = (o: { type?: string; fails?: boolean } = {}) => {
        const sends: Array<[string, unknown]> = [];
        let sessions = 0;
        const target: FakeTarget = {
          type: () => o.type ?? 'other',
          createCDPSession: async () => {
            sessions++;
            if (o.fails) throw new Error('Target closed');
            return { send: async (method, params) => { sends.push([method, params]); } };
          },
        };
        return { target, sends, sessions: () => sessions };
      };

      it('its scripts are switched off as well, through a session of its own that is made once per target', async () => {
        const f = frame();
        const { guard } = parts({ targets: [f.target] });
        const nav = guard.beforeNavigation(); await flush(); await nav;
        await Promise.all([guard.seal(), flush()]);
        expect(f.sends).toEqual([
          ['Emulation.setScriptExecutionDisabled', { value: true }],
          ['Emulation.setScriptExecutionDisabled', { value: true }],
        ]);
        expect(f.sessions()).toBe(1);
      });

      it('only a frame target (puppeteer type "other") is touched: pages, workers and the browser are left alone', async () => {
        const page = frame({ type: 'page' }); const worker = frame({ type: 'service_worker' }); const browserT = frame({ type: 'browser' });
        const { guard } = parts({ targets: [page.target, worker.target, browserT.target] });
        await Promise.all([guard.seal(), flush()]);
        expect([page.sessions(), worker.sessions(), browserT.sessions()]).toEqual([0, 0, 0]);
      });

      it('a frame that is gone (its session cannot be made) does not stop anything', async () => {
        const f = frame({ fails: true });
        const { guard, toggles } = parts({ targets: [f.target] });
        const nav = guard.beforeNavigation(); await flush(); await nav;
        await Promise.all([guard.seal(), flush()]);
        expect(toggles).toEqual([false, true, false]);
      });
    });
  });

  describe('through the capture: what the page has started and the filter has not answered yet', () => {
    // A verdict that comes when the test says so: the way a DNS lookup that is slow looks to the filter.
    const slowVerdict = () => {
      let resolve!: (v: boolean) => void;
      const promise = new Promise<boolean>(r => { resolve = r; });
      return { promise, resolve };
    };
    const startRequest = (log: ReturnType<typeof fakeBrowser>['log'], url: string, type = 'fetch') => {
      const r = fakeRequest(url, { type, log: log.events });
      for (const fn of log.requestListeners) void fn(r.req);
      return r;
    };

    it('marketing: a request still waiting for its verdict when the page is closed is aborted (and acknowledged) BEFORE the close', async () => {
      const verdict = slowVerdict();
      h.hostIsPublic = () => verdict.promise;
      let waiting: ReturnType<typeof fakeRequest> | undefined;
      const f = fakeBrowser(() => ({ text: 'x' }), { onGoto: () => { waiting = startRequest(f.log, 'https://slow.example/beacon'); } });
      await one(f.browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
      expect(waiting!.answers).toEqual(['abort(blockedbyclient)']);
      expect(f.log.events.indexOf('abort(blockedbyclient):https://slow.example/beacon')).toBeGreaterThan(-1);
      expect(f.log.events.indexOf('abort(blockedbyclient):https://slow.example/beacon')).toBeLessThan(f.log.events.indexOf('close'));
      // the verdict arrives afterwards: the request has been answered, so nothing more is done (no second answer, no thrown error)
      verdict.resolve(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(waiting!.raw.continue).not.toHaveBeenCalled();
      expect(waiting!.answers).toEqual(['abort(blockedbyclient)']);
    });

    it('marketing: the same before each later navigation (the old document is about to go)', async () => {
      const verdict = slowVerdict();
      h.hostIsPublic = () => verdict.promise;
      let waiting: ReturnType<typeof fakeRequest> | undefined;
      const f = fakeBrowser(richSite, { onGoto: url => { if (url === HOME) waiting = startRequest(f.log, 'https://slow.example/keepalive'); } });
      await one(f.browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
      const at = f.log.events.indexOf('abort(blockedbyclient):https://slow.example/keepalive');
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(f.log.events.indexOf('blank'));       // answered before the old document was left
    });

    it('marketing: the requests a page makes after the guard has started are never given a DNS check', async () => {
      const calls: string[] = [];
      h.hostIsPublic = async (u: string) => { calls.push(u); return true; };
      const f = fakeBrowser(() => ({ text: 'x' }), { onGoto: () => {} });
      const run = capturePortfolios(f.browser, [linkTo(HOME)], Date.now() + 600_000, MARKETING_CAPTURE_OPTS);
      await vi.advanceTimersByTimeAsync(5);
      // the page is being read; one request in the open is checked as usual ...
      const normal = startRequest(f.log, 'https://cdn.example/a.js');
      await vi.advanceTimersByTimeAsync(5);
      expect(calls).toEqual(['https://cdn.example/a.js']);
      expect(normal.answers).toEqual(['continue']);
      await vi.runAllTimersAsync();
      await run;
    });

    it('marketing: a request that is checked and public is continued, one that is not is aborted, media is aborted without a check', async () => {
      h.hostIsPublic = async (u: string) => !u.includes('internal');
      const f = fakeBrowser(() => ({ text: 'x' }));
      const run = capturePortfolios(f.browser, [linkTo(HOME)], Date.now() + 600_000, MARKETING_CAPTURE_OPTS);
      await vi.advanceTimersByTimeAsync(5);
      const ok = startRequest(f.log, 'https://cdn.example/a.js');
      const bad = startRequest(f.log, 'http://internal.example/x');
      const media = startRequest(f.log, 'https://cdn.example/v.mp4', 'media');
      await vi.advanceTimersByTimeAsync(5);
      expect(ok.answers).toEqual(['continue']);
      expect(bad.answers).toEqual(['abort(blockedbyclient)']);
      expect(media.answers).toEqual(['abort(blockedbyclient)']);
      await vi.runAllTimersAsync();
      await run;
    });

    it.each(designer)('%s: the same page leaves the request unanswered at the close — the designer review is exactly what it was', async (_n, opts) => {
      const verdict = slowVerdict();
      h.hostIsPublic = () => verdict.promise;
      let waiting: ReturnType<typeof fakeRequest> | undefined;
      const f = fakeBrowser(() => ({ text: 'x' }), { onGoto: () => { waiting = startRequest(f.log, 'https://slow.example/beacon'); } });
      await one(f.browser, linkTo(HOME), opts);
      expect(waiting!.answers).toEqual([]);
      expect(f.log.requestListeners).toHaveLength(1);
      verdict.resolve(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(waiting!.answers).toEqual(['continue']);     // as it always did: answered when the verdict came, whenever that was
    });

    it('marketing: a verdict that comes back after the guard answered the request does not answer it again (a second answer is a rejected promise nobody handles)', async () => {
      const verdict = slowVerdict();
      h.hostIsPublic = () => verdict.promise;
      let waiting: ReturnType<typeof fakeRequest> | undefined;
      const f = fakeBrowser(() => ({ text: 'x' }), { onGoto: () => { waiting = startRequest(f.log, 'http://internal.example/x'); } });
      await one(f.browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
      verdict.resolve(false);            // the "not public" verdict would abort a request that was aborted already
      await vi.advanceTimersByTimeAsync(10);
      expect(waiting!.raw.abort).toHaveBeenCalledTimes(1);
      expect(waiting!.raw.continue).not.toHaveBeenCalled();
    });
  });

  describe('frame targets through the capture', () => {
    it('marketing: a frame target is frozen at each empty page and at the close; the designer review never lists targets', async () => {
      const sends: unknown[] = [];
      const target: FakeTarget = { type: () => 'other', createCDPSession: async () => ({ send: async (m, p) => { sends.push([m, p]); } }) };
      const m = fakeBrowser(richSite, { targets: [target] });
      await one(m.browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
      expect(sends).toHaveLength(4);              // 3 empty pages + the close
      const d = fakeBrowser(richSite, { targets: [target] });
      const listed = vi.spyOn(d.browser, 'targets');
      sends.length = 0;
      await one(d.browser, linkTo(HOME), DESIGNER_CAPTURE_OPTS);
      expect(listed).not.toHaveBeenCalled();
      expect(sends).toEqual([]);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A site that was not read in full is partial (marketing only)
// ═════════════════════════════════════════════════════════════════════════════
describe('findUnopenedPages / partialCrawlNote', () => {
  const a = (...hrefs: string[]) => hrefs.map(href => ({ href, text: href.split('/').pop() ?? '' }));
  const key = (u: string) => { const x = new URL(u); return x.origin + x.pathname.replace(/\/$/, ''); };
  const visitedOf = (...urls: string[]) => new Set(urls.map(key));

  it('nothing linked, nothing unread', () => {
    expect(findUnopenedPages([{ url: HOME, anchors: [] }], visitedOf(HOME), [])).toEqual([]);
  });

  it('a same-site page that was linked and not opened is unread; one that was opened is not', () => {
    const crawled = [{ url: HOME, anchors: a(`${HOME}/work/a`, `${HOME}/work/b`, `${HOME}/about`) }];
    expect(findUnopenedPages(crawled, visitedOf(HOME, `${HOME}/work/a`), [])).toEqual([`${HOME}/work/b`, `${HOME}/about`].sort((x, y) => (x.includes('work') ? -1 : 1) - (y.includes('work') ? -1 : 1)));
  });

  it('what the crawl had picked and never reached counts, once, whatever its spelling', () => {
    const crawled = [{ url: HOME, anchors: a(`${HOME}/work/d`) }];
    const unread = findUnopenedPages(crawled, visitedOf(HOME), [`${HOME}/work/d/`, 'https://www.behance.net/gallery/1/Campaign']);
    expect(unread).toHaveLength(2);
  });

  it('links the crawl would never follow are not unread pages: assets, mail, the page itself, other hosts that are not case-study hosts', () => {
    const crawled = [{ url: HOME, anchors: a(`${HOME}/cv.pdf`, `${HOME}/img/a.png`, 'mailto:jane@jane.example', `${HOME}#top`, `${HOME}/`, 'https://twitter.com/jane', 'https://news.example/press', 'tel:+911234567890') }];
    expect(findUnopenedPages(crawled, visitedOf(HOME), [])).toEqual([]);
  });

  it('a case-study host the page links to and nobody opened is unread (the crawl may follow it)', () => {
    const crawled = [{ url: HOME, anchors: a(BEHANCE, FIGMA, 'https://www.figma.com/login') }];
    expect(findUnopenedPages(crawled, visitedOf(HOME), []).sort()).toEqual([BEHANCE, FIGMA].sort());
  });

  it('the links of every page that was opened count, not only the home page', () => {
    const crawled = [{ url: HOME, anchors: [] }, { url: `${HOME}/work/a`, anchors: a(`${HOME}/work/deep/z`) }];
    expect(findUnopenedPages(crawled, visitedOf(HOME, `${HOME}/work/a`), [])).toEqual([`${HOME}/work/deep/z`]);
  });

  it('the same page linked twice, or by a query or hash variant, is counted once', () => {
    const crawled = [{ url: HOME, anchors: a(`${HOME}/work/x`, `${HOME}/work/x#top`, `${HOME}/work/x/`) }];
    expect(findUnopenedPages(crawled, visitedOf(HOME), [])).toHaveLength(1);
  });

  it('the note says how many pages were read and how many were left, in the singular too', () => {
    expect(partialCrawlNote(4, 3)).toBe('Opened 4 pages; the site links to 3 more that were not read');
    expect(partialCrawlNote(1, 1)).toBe('Opened 1 page; the site links to 1 more that was not read');
  });
});

describe('findUnopenedPages — held-out site shapes (written after the function, from site layouts none of the tests above use)', () => {
  type Shape = { name: string; opened: string[]; links: Record<string, string[]>; queued?: string[]; unread: boolean };
  const keyOf = (u: string) => { const x = new URL(u); x.hash = ''; return x.origin + x.pathname.replace(/\/$/, ''); };
  const run = (c: Shape) => {
    const crawled = c.opened.map(url => ({ url, anchors: (c.links[url] ?? []).map(href => ({ href, text: '' })) }));
    return findUnopenedPages(crawled, new Set(c.opened.map(keyOf)), c.queued ?? []).length > 0;
  };
  const S = 'https://studio-aria.example';
  const shapes: Shape[] = [
    { name: 'a one-page site whose menu is all #anchors', opened: [`${S}/`], links: { [`${S}/`]: [`${S}/#about`, `${S}/#work`, `${S}/#contact`, '#top', 'tel:+911234567890'] }, unread: false },
    { name: 'a studio site: home + 3 case studies opened, the nav links to exactly those', opened: [`${S}/`, `${S}/projects/maple`, `${S}/projects/lotus`, `${S}/projects/saffron`], links: { [`${S}/`]: [`${S}/projects/maple`, `${S}/projects/lotus`, `${S}/projects/saffron`], [`${S}/projects/maple`]: [`${S}/`, `${S}/projects/lotus`] }, unread: false },
    { name: 'the same studio with a fourth case study in the nav that the crawl did not open', opened: [`${S}/`, `${S}/projects/maple`, `${S}/projects/lotus`, `${S}/projects/saffron`], links: { [`${S}/`]: [`${S}/projects/maple`, `${S}/projects/lotus`, `${S}/projects/saffron`, `${S}/projects/jasmine`] }, unread: true },
    { name: 'a footer with only legal pages nobody opened', opened: [`${S}/`], links: { [`${S}/`]: [`${S}/privacy-policy`, `${S}/terms`] }, unread: true },
    { name: 'a blog with ?page=2 pagination links on the page that was opened', opened: [`${S}/blog`], links: { [`${S}/blog`]: [`${S}/blog?page=2`, `${S}/blog?page=3`, `${S}/blog#comments`] }, unread: false },
    { name: 'a language switcher (/hi) that was not opened', opened: [`${S}/`], links: { [`${S}/`]: [`${S}/hi`, `${S}/ta`] }, unread: true },
    { name: 'a trailing slash and an http/https-identical link to the page itself', opened: [`${S}/work/`], links: { [`${S}/work/`]: [`${S}/work`, `${S}/work/`, `${S}/work/#grid`] }, unread: false },
    { name: 'only downloads and images are linked (a CV, a zip, an svg logo)', opened: [`${S}/`], links: { [`${S}/`]: [`${S}/cv-jane.pdf`, `${S}/assets/kit.zip`, `${S}/logo.svg`, `${S}/clip.mp4`] }, unread: false },
    { name: 'social profiles and a mail link in the footer', opened: [`${S}/`], links: { [`${S}/`]: ['https://www.instagram.com/studio.aria', 'https://www.linkedin.com/company/studio-aria', 'https://twitter.com/aria', 'mailto:hello@studio-aria.example', 'https://wa.me/911234567890'] }, unread: false },
    { name: 'javascript: and data: links', opened: [`${S}/`], links: { [`${S}/`]: ['javascript:void(0)', 'data:text/plain,hi', 'blob:https://studio-aria.example/1234'] }, unread: false },
    { name: 'a Behance gallery linked twice, one project opened', opened: [`${S}/`, 'https://www.behance.net/gallery/111/Maple'], links: { [`${S}/`]: ['https://www.behance.net/gallery/111/Maple', 'https://www.behance.net/gallery/111/Maple?tracking=1'] }, unread: false },
    { name: 'a Behance gallery and a Notion page linked, neither opened', opened: [`${S}/`], links: { [`${S}/`]: ['https://www.behance.net/gallery/222/Lotus', 'https://aria.notion.site/Case-study-9f3a'] }, unread: true },
    { name: 'a Medium profile root is not a case study (the crawl would not follow it either)', opened: [`${S}/`], links: { [`${S}/`]: ['https://medium.com/@aria'] }, unread: false },
    { name: 'Figma community / pricing links, not content pages', opened: [`${S}/`], links: { [`${S}/`]: ['https://www.figma.com/community', 'https://www.figma.com/pricing'] }, unread: false },
    { name: 'a Figma prototype linked and not opened', opened: [`${S}/`], links: { [`${S}/`]: ['https://www.figma.com/proto/AbC123/Brand-deck'] }, unread: true },
    { name: 'a sub-page of an opened page links one level deeper', opened: [`${S}/`, `${S}/campaigns`], links: { [`${S}/`]: [`${S}/campaigns`], [`${S}/campaigns`]: [`${S}/campaigns/diwali-2025`] }, unread: true },
    { name: 'the picked-but-not-reached queue alone makes it partial', opened: [`${S}/`], links: { [`${S}/`]: [] }, queued: [`${S}/work/late`], unread: true },
    { name: 'a queued page that WAS opened in the end is not unread', opened: [`${S}/`, `${S}/work/late`], links: {}, queued: [`${S}/work/late`], unread: false },
    { name: 'a link to another site\'s page on a host the crawl never follows', opened: [`${S}/`], links: { [`${S}/`]: ['https://client-brand.example/campaign/launch', 'https://news.example/aria-wins-award'] }, unread: false },
    { name: 'an entry page that is not the root: the site root is not counted (the crawl\'s own rule)', opened: [`${S}/portfolio`], links: { [`${S}/portfolio`]: [`${S}/`, `${S}/portfolio`] }, unread: false },
    { name: 'upper-case path segments of an opened page', opened: [`${S}/Work/Maple`], links: { [`${S}/Work/Maple`]: [`${S}/Work/Maple`, `${S}/Work/Maple#team`] }, unread: false },
    { name: 'a sitemap-style footer of twelve pages, three opened', opened: [`${S}/`, `${S}/about`, `${S}/work`, `${S}/contact`], links: { [`${S}/`]: Array.from({ length: 12 }, (_, i) => `${S}/p/${i}`) }, unread: true },
    { name: 'a relative-looking link that resolves to the opened page', opened: [`${S}/work/a`], links: { [`${S}/work/a`]: [`${S}/work/a/../a`] }, unread: false },
    { name: 'a www / non-www spelling of the same opened page', opened: [`${S}/`, `${S}/work`], links: { [`${S}/`]: [`https://www.studio-aria.example/work`] }, unread: false },
  ];

  it.each(shapes)('$name', c => { expect(run(c)).toBe(c.unread); });

  it('the table is balanced enough to mean something (both outcomes well represented)', () => {
    const unread = shapes.filter(s => s.unread).length;
    expect(unread).toBeGreaterThanOrEqual(8);
    expect(shapes.length - unread).toBeGreaterThanOrEqual(10);
  });
});

describe('capturePortfolios — a site that was not read in full is partial (marketing only)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.safeFetch.mockReset();
    h.safeFetch.mockResolvedValue({ status: 200 });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('more pages than maxPages: partial, with the count in the note', async () => {
    const r = await one(fakeBrowser(richSite).browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.access).toBe('ok');
    expect(r.pages).toHaveLength(4);
    expect(r.partial).toBe(true);
    expect(r.accessNote).toBe(partialCrawlNote(4, 3));        // the 4th work page, the Behance project and the Figma deck
  });

  it('every linked page was opened: not partial, no note', async () => {
    const site = (url: string): FakeSite => (url === HOME ? { anchors: [{ href: `${HOME}/work/a`, text: 'Case a' }, { href: `${HOME}/work/b`, text: 'Case b' }] } : { text: 'b' });
    const r = await one(fakeBrowser(site).browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.pages).toHaveLength(3);
    expect(r.partial).toBeUndefined();
    expect(r.accessNote).toBeUndefined();
  });

  it('a single page with nothing to follow is the whole site', async () => {
    const r = await one(fakeBrowser(() => ({ text: 'A one-page portfolio', anchors: [{ href: 'mailto:jane@jane.example', text: 'mail' }, { href: `${HOME}#work`, text: 'work' }] })).browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.partial).toBeUndefined();
  });

  it('a link the crawl did not pick (a footer page, below the best three) is a page nobody read', async () => {
    const site = (url: string): FakeSite => (url === HOME
      ? { anchors: [...WORK_PAGES.slice(0, 3).map(href => ({ href, text: 'Case' })), { href: `${HOME}/privacy`, text: 'Privacy' }] }
      : { text: 'b' });
    const r = await one(fakeBrowser(site).browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.pages).toHaveLength(4);
    expect(r.partial).toBe(true);
    expect(r.accessNote).toBe(partialCrawlNote(4, 1));
  });

  it('a later page that could not be read (a wall, a failed load) leaves its site partial, and the pages read are kept', async () => {
    const site = (url: string): FakeSite => (url === HOME
      ? { anchors: [{ href: WORK_PAGES[0], text: 'Case a' }, { href: WORK_PAGES[1], text: 'Case b' }] }
      : url === WORK_PAGES[1] ? { throws: 'net::ERR_CONNECTION_RESET' } : { text: 'b' });
    const r = await one(fakeBrowser(site).browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.access).toBe('ok');
    expect(r.pages.map(p => p.url)).toEqual([HOME, WORK_PAGES[0]]);
    expect(r.partial).toBe(true);
    expect(r.accessNote).toBe(partialCrawlNote(2, 1));
  });

  it('the clock running out with pages still queued: partial as well (the time flag is the capture\'s own and stays set)', async () => {
    const f = fakeBrowser(richSite, { onGoto: url => { if (url === WORK_PAGES[0]) vi.setSystemTime(Date.now() + 20_000); } });
    const run = capturePortfolios(f.browser, [linkTo(HOME)], Date.now() + 40_000, MARKETING_CAPTURE_OPTS);
    await vi.runAllTimersAsync();
    const [r] = await run;
    expect(r.signals.truncated).toBe(true);
    expect(r.pages.length).toBeLessThan(4);
    expect(r.partial).toBe(true);
  });

  it('a Figma file is one canvas with no crawl: never partial for pages it does not have', async () => {
    const r = await one(fakeBrowser(() => ({ text: 'canvas', anchors: [{ href: 'https://www.figma.com/community', text: 'x' }, { href: 'https://www.figma.com/pricing', text: 'y' }] })).browser, linkTo(FIGMA, 'figma_file'), MARKETING_CAPTURE_OPTS);
    expect(r.access).toBe('ok');
    expect(r.partial).toBeUndefined();
  });

  it('partialWhenPagesLeft off (everything else as marketing): never partial', async () => {
    const r = await one(fakeBrowser(richSite).browser, linkTo(HOME), { ...MARKETING_CAPTURE_OPTS, partialWhenPagesLeft: false });
    expect(r.partial).toBeUndefined();
    expect(r.accessNote).toBeUndefined();
  });

  it.each([['designer (default options)', undefined], ['designer', DESIGNER_CAPTURE_OPTS]] as const)('%s: the same site is not marked partial — its output is exactly what it was', async (_n, opts) => {
    const r = await one(fakeBrowser(richSite).browser, linkTo(HOME), opts);
    expect(r.pages).toHaveLength(6);
    expect(r.partial).toBeUndefined();
    expect(r.accessNote).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual(['access', 'link', 'mobileShot', 'pages', 'signals']);
  });

  it('a site that is not ok stays what it was: no partial note on an unreadable site', async () => {
    const r = await one(fakeBrowser(() => ({ status: 404, text: 'Not found', anchors: [{ href: `${HOME}/a`, text: 'a' }] })).browser, linkTo(HOME), MARKETING_CAPTURE_OPTS);
    expect(r.access).toBe('blocked');
    expect(r.partial).toBeUndefined();
  });

  it('a Canva link keeps its own partial note (a view link only ever shows its first screens)', async () => {
    const CANVA = 'https://www.canva.com/design/DAF/view';
    const r = await one(fakeBrowser(url => (url === CANVA ? { text: 'A deck', anchors: [{ href: 'https://www.canva.com/design/DAF/other/view', text: 'x' }] } : { text: 'x' })).browser, linkTo(CANVA, 'canva'), MARKETING_CAPTURE_OPTS);
    expect(r.partial).toBe(true);
    expect(r.accessNote).toBe(CANVA_PARTIAL_NOTE);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The designer analysis must not treat a neutral wall as a finding
// ═════════════════════════════════════════════════════════════════════════════
describe('analyzePortfolios (designer) with an unreviewable capture', () => {
  const signals = (): PortfolioSignals => ({
    brokenLinksChecked: 0, brokenLinks: 0, brokenLinkSamples: [], consoleErrors: 0,
    failedRequests: 0, mobileOverflow: null, loadMs: null, truncated: false,
  });
  const cap = (url: string, access: CapturedPortfolio['access'], accessNote?: string): CapturedPortfolio => ({
    link: linkTo(url), access, accessNote, signals: signals(),
    pages: access === 'ok' ? [{ url, title: 'Home', text: 'Case study', shots: [] }] : [],
  });

  it('is not red-flagged, not accessible, and does not stop the readable portfolio from being scored', async () => {
    h.create.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({
      portfolios: [{ url: 'https://good.example', isPortfolio: true, belongsToCandidate: true }],
      criteria: [], jdAlignment: { mustHaves: [], niceToHaves: [] }, portfolioScore: 7, scoreNote: 'Solid', highlights: [], redFlags: [], summary: 'S.',
    }) }] });
    const { analyzePortfolios } = await import('./analyze.js');
    const res = await analyzePortfolios(
      { full_name: 'Jane Doe' } as never,
      { title: 'Senior UX/Product Designer', must_have_skills: 'A', nice_to_have_skills: 'B', kpi_expectations: 'C', generated_jd_content: null } as never,
      [cap('https://good.example', 'ok'), cap('https://walled.example', 'unreviewable', BOT_WALL_NOTE), cap('https://private.example', 'blocked', 'Portfolio is private or requires access')],
    );
    expect(res.portfolios.map(p => [p.accessKind, p.accessible])).toEqual([['ok', true], ['unreviewable', false], ['blocked', false]]);
    expect(res.redFlags).toEqual(['Portfolio link not reviewable — Portfolio is private or requires access']);   // only the BLOCKED link is held against them
    expect(res.score).toBeGreaterThan(2);
  });
});
