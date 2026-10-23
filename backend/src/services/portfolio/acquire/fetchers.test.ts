import { describe, it, expect, vi } from 'vitest';
import type { ReviewHandler } from '../types.js';
import type { Acquired, AcquireContext } from './types.js';
import { BudgetTracker } from './budget.js';

// defaultFetchers is pure wiring, so what is under test is the wiring: every handler a link can carry reaches the
// module that opens that kind of link (and only that one). The fetcher modules are replaced by distinct stubs so a
// crossed wire is visible, and nothing here can touch the network.
vi.mock('./documents.js', () => ({ fetchDocument: vi.fn() }));
vi.mock('./media.js', () => ({
  fetchImage:  vi.fn(),
  fetchVideo:  vi.fn(),
  fetchSocial: vi.fn(),
  resolveLink: vi.fn(),
}));

import { fetchDocument } from './documents.js';
import { fetchImage, fetchSocial, fetchVideo, resolveLink } from './media.js';
import { acquireFetchItems, expandResolveItems } from './index.js';
import { defaultFetchers } from './fetchers.js';

// The compiler makes this list exhaustive: a new ReviewHandler is a type error here until it is added, which is the
// prompt to decide whether it needs a fetcher.
const ALL_HANDLERS: Record<ReviewHandler, true> = { site: true, document: true, image: true, video: true, social: true, resolve: true, none: true };
const HANDLERS = Object.keys(ALL_HANDLERS) as ReviewHandler[];
// Opened by Chromium (site) or never opened (none): neither is fetched.
const NOT_FETCHED: ReviewHandler[] = ['site', 'none'];
const FETCHED = HANDLERS.filter(h => !NOT_FETCHED.includes(h));

const ctx = (): AcquireContext => ({ deadline: Date.now() + 60_000, budget: new BudgetTracker() });
const link = (handler: ReviewHandler | undefined, host = 'x.example') =>
  ({ url: `https://${host}/${handler ?? 'unset'}`, host, platform: 'custom', handler }) as const;
const acquiredFor = (ref: string, url: string): Acquired => ({
  ref, link: { url, host: 'x.example', platform: 'custom' }, outcome: 'ok', basis: 'artifact',
  media: [], text: 'words', facts: [], injectionHit: false,
});

describe('defaultFetchers: which handlers have a fetcher', () => {
  it('has one for every handler except site and none', () => {
    for (const h of FETCHED) expect(defaultFetchers[h as keyof typeof defaultFetchers], `handler ${h}`).toBeTypeOf('function');
  });

  it('has none for site (Chromium opens websites) or none (never opened)', () => {
    for (const h of NOT_FETCHED) expect(Object.hasOwn(defaultFetchers, h), `handler ${h}`).toBe(false);
  });

  it('has exactly the five entries, no stray key', () => {
    expect(Object.keys(defaultFetchers).sort()).toEqual(['document', 'image', 'resolve', 'social', 'video']);
    expect(FETCHED.slice().sort()).toEqual(Object.keys(defaultFetchers).sort());
  });
});

describe('defaultFetchers: no handler is wired to the wrong module', () => {
  it('document opens with fetchDocument', () => expect(defaultFetchers.document).toBe(fetchDocument));
  it('image opens with fetchImage', () => expect(defaultFetchers.image).toBe(fetchImage));
  it('video opens with fetchVideo', () => expect(defaultFetchers.video).toBe(fetchVideo));
  it('social opens with fetchSocial', () => expect(defaultFetchers.social).toBe(fetchSocial));
  it('resolve expands with resolveLink', () => expect(defaultFetchers.resolve).toBe(resolveLink));

  it('no two handlers share a function', () => {
    const fns = Object.values(defaultFetchers);
    expect(new Set(fns).size).toBe(fns.length);
  });
});

describe('defaultFetchers through the orchestrator', () => {
  it('sends each link to the fetcher of its own handler, once, with its ref', async () => {
    for (const fn of [fetchDocument, fetchImage, fetchVideo, fetchSocial]) {
      vi.mocked(fn).mockReset().mockImplementation(async (item) => acquiredFor(item.ref, item.link.url));
    }
    const items = [
      { link: link('document'), ref: 'L1' },
      { link: link('image'),    ref: 'L2' },
      { link: link('video'),    ref: 'L3' },
      { link: link('social'),   ref: 'L4' },
    ];
    const out = await acquireFetchItems(items, ctx(), defaultFetchers);

    expect(out.map(a => a.ref)).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(vi.mocked(fetchDocument).mock.calls.map(c => c[0].ref)).toEqual(['L1']);
    expect(vi.mocked(fetchImage).mock.calls.map(c => c[0].ref)).toEqual(['L2']);
    expect(vi.mocked(fetchVideo).mock.calls.map(c => c[0].ref)).toEqual(['L3']);
    expect(vi.mocked(fetchSocial).mock.calls.map(c => c[0].ref)).toEqual(['L4']);
  });

  it('follows a short link once: the resolver runs, then the link it found goes to its own fetcher as <ref>.1', async () => {
    vi.mocked(fetchDocument).mockReset().mockImplementation(async (item) => acquiredFor(item.ref, item.link.url));
    vi.mocked(resolveLink).mockReset().mockResolvedValue({
      links: [{ url: 'https://drive.google.com/file/d/abcdefghijk/view', host: 'drive.google.com', platform: 'gdrive_file', handler: 'document' }],
    });
    const out = await acquireFetchItems([{ link: link('resolve', 'bit.ly'), ref: 'L2' }], ctx(), defaultFetchers);

    expect(vi.mocked(resolveLink)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchDocument).mock.calls.map(c => c[0].ref)).toEqual(['L2.1']);
    expect(out.map(a => a.ref)).toEqual(['L2.1']);
  });

  it('opens nothing for a site or a none link: they come back unreviewable and no fetcher is called', async () => {
    for (const fn of [fetchDocument, fetchImage, fetchVideo, fetchSocial]) vi.mocked(fn).mockReset();
    vi.mocked(resolveLink).mockReset();
    const out = await acquireFetchItems([
      { link: link('site'), ref: 'L1' },
      { link: link('none'), ref: 'L2' },
      { link: link(undefined), ref: 'L3' },
    ], ctx(), defaultFetchers);

    expect(out.map(a => [a.ref, a.outcome])).toEqual([['L1', 'unreviewable'], ['L2', 'unreviewable'], ['L3', 'unreviewable']]);
    for (const fn of [fetchDocument, fetchImage, fetchVideo, fetchSocial, resolveLink]) expect(fn).not.toHaveBeenCalled();
  });
});

describe('defaultFetchers through expandResolveItems', () => {
  it('the resolver is resolveLink: a short link that leads to a website comes back as a site item for the browser, and nothing else is fetched', async () => {
    for (const fn of [fetchDocument, fetchImage, fetchVideo, fetchSocial]) vi.mocked(fn).mockReset();
    const site = { url: 'https://www.behance.net/janedoe', host: 'behance.net', platform: 'behance', handler: 'site' } as const;
    vi.mocked(resolveLink).mockReset().mockResolvedValue({ links: [site] });
    const out = await expandResolveItems([
      { link: link('document'), ref: 'L1' },
      { link: link('resolve', 'bit.ly'), ref: 'L2' },
    ], ctx(), defaultFetchers);

    expect(vi.mocked(resolveLink)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolveLink).mock.calls[0][0].ref).toBe('L2');
    expect(out.items.map(i => [i.ref, i.link.handler])).toEqual([['L1', 'document'], ['L2.1', 'site']]);
    expect(out.settled).toEqual([]);
    for (const fn of [fetchDocument, fetchImage, fetchVideo, fetchSocial]) expect(fn).not.toHaveBeenCalled();   // expanding opens nothing but the short link
  });

  it('a link that is not a short link is never given to the resolver', async () => {
    vi.mocked(resolveLink).mockReset();
    const items = [{ link: link('site'), ref: 'L1' }, { link: link('video'), ref: 'L2' }, { link: link('none'), ref: 'L3' }];
    expect((await expandResolveItems(items, ctx(), defaultFetchers)).items).toEqual(items);
    expect(resolveLink).not.toHaveBeenCalled();
  });
});

