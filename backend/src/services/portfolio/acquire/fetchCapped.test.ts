import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Never touches the network: safeFetch (SSRF check + fetch) is replaced by canned Responses with streamed bodies.
vi.mock('../urlSafety.js', () => ({ safeFetch: vi.fn() }));

import { safeFetch } from '../urlSafety.js';
import { fetchCapped, isTimeoutError, sniffType } from './fetchCapped.js';

const safeFetchMock = vi.mocked(safeFetch);
const URL_IN = 'https://files.example.com/work/campaign.pdf';
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

async function rejection(p: Promise<unknown>): Promise<Error & { code?: string }> {
  try { await p; } catch (e) { return e as Error & { code?: string }; }
  throw new Error('expected the promise to reject');
}

type Step = Uint8Array | Error | 'stall' | { wait: number; chunk: Uint8Array };

/**
 * A pull-driven body that records how much of it the consumer actually asked for and whether it was cancelled.
 * highWaterMark 0: nothing is produced until a read, so `pulls` is exactly the number of reads that reached it.
 */
function fakeBody(steps: Step[]) {
  let i = 0;
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      state.pulls++;
      const next = steps[i++];
      if (next === undefined) return controller.close();
      if (next === 'stall') return new Promise<void>(() => {});
      if (next instanceof Error) return controller.error(next);
      if (next instanceof Uint8Array) return controller.enqueue(next);
      await new Promise(r => setTimeout(r, next.wait));
      controller.enqueue(next.chunk);
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, state };
}

function respond(steps: Step[], init: { status?: number; headers?: Record<string, string>; url?: string } = {}) {
  const b = fakeBody(steps);
  const res = new Response(b.stream, { status: init.status ?? 200, headers: init.headers });
  if (init.url) Object.defineProperty(res, 'url', { value: init.url });
  safeFetchMock.mockResolvedValueOnce(res);
  return b.state;
}

beforeEach(() => { safeFetchMock.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('fetchCapped — success path', () => {
  it('returns every byte in order with status, content type and headers', async () => {
    respond([Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5), Uint8Array.of(6)], { headers: { 'content-type': 'application/pdf' } });
    const r = await fetchCapped(URL_IN, { maxBytes: 100, timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.tooLarge).toBe(false);
    expect(Buffer.isBuffer(r.bytes)).toBe(true);
    expect([...r.bytes!]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.contentType).toBe('application/pdf');
    expect(r.finalUrl).toBe(URL_IN);
  });

  it('keeps the order of a thousand one-byte chunks', async () => {
    const chunks = Array.from({ length: 1000 }, (_, i) => Uint8Array.of(i % 256));
    respond(chunks);
    const r = await fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.bytes!.length).toBe(1000);
    expect(r.bytes!.every((v, i) => v === i % 256)).toBe(true);
  });

  it('accepts a body of exactly maxBytes and refuses one byte more (no content-length: counted while streaming)', async () => {
    respond([bytes(400), bytes(600)]);
    const exact = await fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    expect(exact.ok).toBe(true);
    expect(exact.bytes!.length).toBe(1000);

    respond([bytes(400), bytes(601)]);
    const over = await fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    expect(over).toMatchObject({ ok: false, tooLarge: true, bytes: null, status: 200 });
  });

  it('an empty body and a zero-length chunk are fine', async () => {
    respond([new Uint8Array(0)]);
    const r = await fetchCapped(URL_IN, { maxBytes: 10, timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.bytes!.length).toBe(0);
  });

  it('a 204 with no body at all is ok with an empty buffer', async () => {
    safeFetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const r = await fetchCapped(URL_IN, { maxBytes: 10, timeoutMs: 5000 });
    expect(r).toMatchObject({ ok: true, status: 204, tooLarge: false });
    expect(r.bytes!.length).toBe(0);
  });

  it('maxBytes 0 admits only an empty body', async () => {
    respond([]);
    expect((await fetchCapped(URL_IN, { maxBytes: 0, timeoutMs: 5000 })).ok).toBe(true);
    respond([bytes(1)]);
    expect(await fetchCapped(URL_IN, { maxBytes: 0, timeoutMs: 5000 })).toMatchObject({ ok: false, tooLarge: true });
  });

  it('asks safeFetch for a GET with the caller\'s accept and user agent, and hands it an abort signal', async () => {
    respond([bytes(1)]);
    await fetchCapped(URL_IN, { maxBytes: 10, timeoutMs: 5000, accept: 'application/pdf', userAgent: 'TestAgent/1' });
    const [url, init] = safeFetchMock.mock.calls[0];
    expect(url).toBe(URL_IN);
    expect(init).toMatchObject({ method: 'GET', headers: { accept: 'application/pdf', 'user-agent': 'TestAgent/1' } });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('has an honest default user agent and accepts anything when none is given', async () => {
    respond([bytes(1)]);
    await fetchCapped(URL_IN, { maxBytes: 10, timeoutMs: 5000 });
    const headers = safeFetchMock.mock.calls[0][1]!.headers!;
    expect(headers.accept).toBe('*/*');
    expect(headers['user-agent']).toMatch(/DigitalPaaniBot/);
  });

  it('aborts its own signal when done, so the sockets of unread redirect responses are released', async () => {
    respond([bytes(5)]);
    await fetchCapped(URL_IN, { maxBytes: 10, timeoutMs: 5000 });
    expect(safeFetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });
});

describe('fetchCapped — size cap', () => {
  it('rejects on a content-length over the cap without reading a single body byte', async () => {
    const state = respond([bytes(10)], { headers: { 'content-length': '1001' } });
    const r = await fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    expect(r).toMatchObject({ ok: false, tooLarge: true, bytes: null, status: 200 });
    expect(state.pulls).toBe(0);
    expect(state.cancelled).toBe(true);
  });

  it('lets a content-length equal to the cap through', async () => {
    respond([bytes(1000)], { headers: { 'content-length': '1000' } });
    const r = await fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.bytes!.length).toBe(1000);
  });

  it.each(['abc', '-5', '1e3', '12abc', '', ' ', '1.5'])('ignores a malformed content-length (%j) and counts the stream instead', async (value) => {
    respond([bytes(50)], { headers: { 'content-length': value } });
    const small = await fetchCapped(URL_IN, { maxBytes: 100, timeoutMs: 5000 });
    expect(small.ok).toBe(true);
    expect(small.bytes!.length).toBe(50);

    respond([bytes(150)], { headers: { 'content-length': value } });
    const big = await fetchCapped(URL_IN, { maxBytes: 100, timeoutMs: 5000 });
    expect(big).toMatchObject({ ok: false, tooLarge: true, bytes: null });
  });

  it('a content-length beyond any real size is simply over the cap, however many digits it has', async () => {
    for (const huge of ['99999999999999999999999', '9'.repeat(400)]) {
      const state = respond([bytes(1)], { headers: { 'content-length': huge } });
      const r = await fetchCapped(URL_IN, { maxBytes: 10, timeoutMs: 5000 });
      expect(r, huge.slice(0, 12)).toMatchObject({ ok: false, tooLarge: true, bytes: null });
      expect(state.pulls).toBe(0);
    }
  });

  it('stops reading and cancels the stream as soon as the count passes the cap, when content-length lies low', async () => {
    const steps = Array.from({ length: 1000 }, () => bytes(400));
    const state = respond(steps, { headers: { 'content-length': '10' } });
    const r = await fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    expect(r).toMatchObject({ ok: false, tooLarge: true, bytes: null });
    expect(state.pulls).toBe(3);          // 400 + 400 + 400 > 1000: the third read tripped it, 997 chunks were never produced
    expect(state.cancelled).toBe(true);
  });

  it('does the same when there is no content-length at all', async () => {
    const steps = Array.from({ length: 1000 }, () => bytes(400));
    const state = respond(steps);
    const r = await fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    expect(r).toMatchObject({ ok: false, tooLarge: true, bytes: null });
    expect(state.pulls).toBe(3);
    expect(state.cancelled).toBe(true);
  });

  it('a single chunk larger than the whole cap is refused without being kept', async () => {
    const state = respond([bytes(5000), bytes(5000)]);
    const r = await fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    expect(r).toMatchObject({ ok: false, tooLarge: true, bytes: null });
    expect(state.pulls).toBe(1);
    expect(state.cancelled).toBe(true);
  });

  it('counts the bytes it is DELIVERED (after gzip/br decoding), not the small encoded content-length', async () => {
    // undici hands us the decoded stream and leaves the encoded size in content-length.
    const headers = { 'content-encoding': 'gzip', 'content-length': '120' };
    const state = respond(Array.from({ length: 50 }, () => bytes(100)), { headers });
    const bomb = await fetchCapped(URL_IN, { maxBytes: 2500, timeoutMs: 5000 });
    expect(bomb).toMatchObject({ ok: false, tooLarge: true, bytes: null });
    expect(state.pulls).toBe(26);         // 25 x 100 = 2500 fits, the 26th chunk passes the cap
    expect(state.cancelled).toBe(true);

    respond(Array.from({ length: 20 }, () => bytes(100)), { headers });
    const fits = await fetchCapped(URL_IN, { maxBytes: 2500, timeoutMs: 5000 });
    expect(fits.ok).toBe(true);
    expect(fits.bytes!.length).toBe(2000);
  });
});

describe('fetchCapped — non-2xx', () => {
  it.each([400, 401, 403, 404, 410, 429, 500, 502, 503])('%i: ok false, no bytes, body cancelled unread', async (status) => {
    const state = respond([bytes(100), bytes(100)], { status, headers: { 'content-type': 'text/html' } });
    const r = await fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    expect(r).toMatchObject({ ok: false, status, bytes: null, tooLarge: false, contentType: 'text/html' });
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBe(0);
  });

  it('keeps the headers a caller needs to tell a bot wall from a private file', async () => {
    respond([bytes(10)], { status: 403, headers: { 'cf-mitigated': 'challenge', server: 'cloudflare', 'content-type': 'text/html; charset=UTF-8' } });
    const r = await fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.headers).toEqual({ 'cf-mitigated': 'challenge', server: 'cloudflare', 'content-type': 'text/html; charset=UTF-8' });
  });

  it('an error page is never reported as "too large", whatever its content-length says', async () => {
    respond([bytes(10)], { status: 404, headers: { 'content-length': '999999' } });
    const r = await fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    expect(r).toMatchObject({ ok: false, status: 404, tooLarge: false, bytes: null });
  });

  it('a 3xx that safeFetch hands back (no usable Location) is a failure, with the Location header preserved', async () => {
    safeFetchMock.mockResolvedValueOnce(new Response(null, { status: 304, headers: { location: '/somewhere' } }));
    const r = await fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    expect(r).toMatchObject({ ok: false, status: 304, bytes: null, tooLarge: false });
    expect(r.headers.location).toBe('/somewhere');
  });
});

describe('fetchCapped — headers, content type, final URL', () => {
  it('returns only the lowercased subset it documents, with values untouched', async () => {
    respond([bytes(5)], {
      headers: {
        'Content-Type': 'Application/PDF',
        'Content-Length': '5',
        'Content-Disposition': 'attachment; filename="Brand Deck.pdf"',
        'CF-Mitigated': 'challenge',
        Server: 'gws',
        Location: 'https://elsewhere.example/',
        'X-Frame-Options': 'SAMEORIGIN',
        'Set-Cookie': 'session=secret',
        'X-Powered-By': 'Express',
        'Cache-Control': 'no-store',
        Authorization: 'Bearer nope',
      },
    });
    const r = await fetchCapped(URL_IN, { maxBytes: 100, timeoutMs: 5000 });
    expect(r.headers).toEqual({
      'content-type': 'Application/PDF',
      'content-length': '5',
      'content-disposition': 'attachment; filename="Brand Deck.pdf"',
      'cf-mitigated': 'challenge',
      server: 'gws',
      location: 'https://elsewhere.example/',
      'x-frame-options': 'SAMEORIGIN',
    });
  });

  it('leaves out the headers the response did not send', async () => {
    respond([bytes(1)], { headers: { server: 'nginx' } });
    const r = await fetchCapped(URL_IN, { maxBytes: 100, timeoutMs: 5000 });
    expect(r.headers).toEqual({ server: 'nginx' });
    expect(r.contentType).toBe('');
  });

  it('reports the content type as sent and never second-guesses it (callers sniff the bytes)', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 body');
    respond([pdf], { headers: { 'content-type': 'image/png' } });
    const r = await fetchCapped(URL_IN, { maxBytes: 100, timeoutMs: 5000 });
    expect(r.contentType).toBe('image/png');
    expect(sniffType(r.bytes!)).toBe('pdf');
  });

  it('finalUrl is the last hop when the Response carries one', async () => {
    respond([bytes(1)], { url: 'https://cdn.example.net/final/file.pdf?token=abc' });
    const r = await fetchCapped(URL_IN, { maxBytes: 100, timeoutMs: 5000 });
    expect(r.finalUrl).toBe('https://cdn.example.net/final/file.pdf?token=abc');
  });

  it('finalUrl falls back to the URL it was asked for', async () => {
    respond([bytes(1)]);
    const r = await fetchCapped(URL_IN, { maxBytes: 100, timeoutMs: 5000 });
    expect(r.finalUrl).toBe(URL_IN);
  });

  it('reports the final URL on a failure too', async () => {
    respond([bytes(1)], { status: 404, url: 'https://moved.example.org/gone' });
    const r = await fetchCapped(URL_IN, { maxBytes: 100, timeoutMs: 5000 });
    expect(r.finalUrl).toBe('https://moved.example.org/gone');
  });
});

describe('fetchCapped — deadline over the whole download', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('rejects with a recognisable timeout when the body stalls mid-stream, and cancels the stalled body', async () => {
    const state = respond([bytes(10), 'stall']);
    const p = fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError', message: 'timed out after 5000 ms' });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(state.cancelled).toBe(true);
    expect(safeFetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true);
    await p.catch((e: unknown) => expect(isTimeoutError(e)).toBe(true));
  });

  it('does not reject one millisecond early', async () => {
    respond([bytes(10), 'stall']);
    const p = fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    const assertion = expect(p).rejects.toThrow(/^timed out/);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it('times out before the headers arrive (safeFetch never answers, e.g. a hanging DNS lookup)', async () => {
    safeFetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const p = fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 2000 });
    const assertion = expect(p).rejects.toThrow(/^timed out after 2000 ms/);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  });

  it('cancels a response that turns up after the deadline instead of leaking its body', async () => {
    let answer!: (r: Response) => void;
    safeFetchMock.mockImplementationOnce(() => new Promise<Response>(r => { answer = r; }));
    const p = fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 1000 });
    const assertion = expect(p).rejects.toThrow(/^timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    const late = fakeBody([bytes(10)]);
    answer(new Response(late.stream, { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(late.state.cancelled).toBe(true);
    expect(late.state.pulls).toBe(0);
  });

  it('the deadline covers the whole body, not each chunk: chunks arriving every 2 s still time out at 5 s', async () => {
    const slow = (n: number): Step => ({ wait: 2000, chunk: bytes(n) });
    const state = respond([slow(1), slow(1), slow(1), slow(1)]);
    const p = fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    const assertion = expect(p).rejects.toThrow(/^timed out after 5000 ms/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(state.cancelled).toBe(true);
  });

  it('a slow but in-time download succeeds', async () => {
    const slow = (n: number): Step => ({ wait: 1000, chunk: bytes(n) });
    respond([slow(2), slow(3)]);
    const p = fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(2000);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.bytes!.length).toBe(5);
  });

  it('leaves no timer behind after a success, a failure status, a too-large body or a network error', async () => {
    respond([bytes(1)]);
    await fetchCapped(URL_IN, { maxBytes: 10, timeoutMs: 5000 });
    expect(vi.getTimerCount()).toBe(0);

    respond([bytes(1)], { status: 500 });
    await fetchCapped(URL_IN, { maxBytes: 10, timeoutMs: 5000 });
    expect(vi.getTimerCount()).toBe(0);

    respond([bytes(100)]);
    await fetchCapped(URL_IN, { maxBytes: 10, timeoutMs: 5000 });
    expect(vi.getTimerCount()).toBe(0);

    safeFetchMock.mockRejectedValueOnce(new Error('boom'));
    await fetchCapped(URL_IN, { maxBytes: 10, timeoutMs: 5000 }).catch(() => {});
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an abort that is not our deadline still reads as a timeout to callers', async () => {
    safeFetchMock.mockRejectedValueOnce(new DOMException('This operation was aborted', 'AbortError'));
    await expect(fetchCapped(URL_IN, { maxBytes: 10, timeoutMs: 5000 })).rejects.toSatisfy(isTimeoutError);
  });
});

describe('fetchCapped — failures surface as rejections callers can classify', () => {
  it('lifts the cause code of undici\'s generic "fetch failed" into the message and onto .code', async () => {
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND gone.example'), { code: 'ENOTFOUND' }) });
    safeFetchMock.mockRejectedValueOnce(err);
    const caught = await rejection(fetchCapped(URL_IN, { maxBytes: 10, timeoutMs: 5000 }));
    expect(caught).toBe(err);                                // the same TypeError, class and cause intact
    expect(caught.message).toBe('fetch failed (ENOTFOUND)');
    expect(caught.code).toBe('ENOTFOUND');
    expect((caught.cause as { code: string }).code).toBe('ENOTFOUND');
    expect(isTimeoutError(caught)).toBe(false);
  });

  it('does the same for a connection that drops mid-body', async () => {
    const reset = new TypeError('terminated', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) });
    respond([bytes(10), reset]);
    const caught = await rejection(fetchCapped(URL_IN, { maxBytes: 1000, timeoutMs: 5000 }));
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught.message).toBe('terminated (ECONNRESET)');
    expect(caught.code).toBe('ECONNRESET');
  });

  it.each(['unsafe or unsupported URL', 'hostname does not resolve', 'too many redirects'])(
    'passes safeFetch\'s own error "%s" through untouched', async (message) => {
      const err = new Error(message);
      safeFetchMock.mockRejectedValueOnce(err);
      await expect(fetchCapped(URL_IN, { maxBytes: 10, timeoutMs: 5000 })).rejects.toBe(err);
    });

  it('does not wrap an error that already names its cause code', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { cause: { code: 'ECONNREFUSED' } });
    safeFetchMock.mockRejectedValueOnce(err);
    await expect(fetchCapped(URL_IN, { maxBytes: 10, timeoutMs: 5000 })).rejects.toBe(err);
  });

  it('turns a non-Error rejection into an Error', async () => {
    safeFetchMock.mockRejectedValueOnce('kaput');
    await expect(fetchCapped(URL_IN, { maxBytes: 10, timeoutMs: 5000 })).rejects.toThrow('request failed: kaput');
  });

  it('never calls safeFetch with a cap or a deadline that is not a real number', async () => {
    for (const maxBytes of [NaN, -1, Infinity]) {
      await expect(fetchCapped(URL_IN, { maxBytes, timeoutMs: 5000 }), `maxBytes ${maxBytes}`).rejects.toThrow(/maxBytes/);
    }
    for (const timeoutMs of [0, -5, NaN, Infinity, 2_147_483_648]) {
      await expect(fetchCapped(URL_IN, { maxBytes: 10, timeoutMs }), `timeoutMs ${timeoutMs}`).rejects.toThrow(/timeoutMs/);
    }
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});

describe('isTimeoutError', () => {
  it('recognises the abort and timeout shapes', () => {
    expect(isTimeoutError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isTimeoutError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTimeoutError(new Error('timed out after 20000 ms'))).toBe(true);
    expect(isTimeoutError(new Error('Timed out while waiting'))).toBe(true);
    expect(isTimeoutError(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isTimeoutError(new DOMException('slow', 'TimeoutError'))).toBe(true);
  });

  it('is false for everything else, including non-errors', () => {
    for (const v of [new Error('fetch failed'), new Error('request timed out'), new TypeError('terminated'), 'timed out', null, undefined, 42, {}, { message: 42 }]) {
      expect(isTimeoutError(v), String(v)).toBe(false);
    }
  });
});

describe('sniffType', () => {
  const ascii = (s: string) => Buffer.from(s, 'latin1');
  const hex = (h: string) => Buffer.from(h.replace(/\s+/g, ''), 'hex');
  const PNG8 = '89504e47 0d0a1a0a';

  it('pdf: %PDF- at offset 0', () => {
    expect(sniffType(ascii('%PDF-1.7\n%âãÏÓ\n1 0 obj'))).toBe('pdf');
    expect(sniffType(ascii('%PDF-'))).toBe('pdf');
  });

  it('pdf: a truncated marker, a different case, or leading junk is not a PDF', () => {
    expect(sniffType(ascii('%PDF'))).toBe('unknown');
    expect(sniffType(ascii('%pdf-1.7'))).toBe('unknown');
    expect(sniffType(ascii(' %PDF-1.7'))).toBe('unknown');
    expect(sniffType(ascii('\n%PDF-1.7'))).toBe('unknown');
  });

  it('png: the full 8-byte signature', () => {
    expect(sniffType(hex(`${PNG8} 0000000d 49484452`))).toBe('png');
  });

  it('png: still png when the buffer is cut inside the signature (4 to 7 bytes)', () => {
    expect(sniffType(hex('89504e47'))).toBe('png');
    expect(sniffType(hex('89504e47 0d0a1a'))).toBe('png');
  });

  it('png: refuses a buffer with the magic prefix but a different tail, and one shorter than the prefix', () => {
    expect(sniffType(hex('89504e47 0a0a1a0a'))).toBe('unknown');
    expect(sniffType(hex('89504e47 0d0a1a0b'))).toBe('unknown');
    expect(sniffType(hex('89504e'))).toBe('unknown');
  });

  it('jpeg: FF D8 FF followed by anything', () => {
    expect(sniffType(hex('ffd8ffe0 00104a46 494600'))).toBe('jpeg');
    expect(sniffType(hex('ffd8ffe1'))).toBe('jpeg');
    expect(sniffType(hex('ffd8ff'))).toBe('jpeg');
    expect(sniffType(hex('ffd8'))).toBe('unknown');
    expect(sniffType(hex('ffd9ff'))).toBe('unknown');
  });

  it('gif: GIF87a and GIF89a only', () => {
    expect(sniffType(ascii('GIF89a\x01\x00\x01\x00'))).toBe('gif');
    expect(sniffType(ascii('GIF87a'))).toBe('gif');
    expect(sniffType(ascii('GIF88a'))).toBe('unknown');
    expect(sniffType(ascii('GIF89'))).toBe('unknown');
    expect(sniffType(ascii('gif89a'))).toBe('unknown');
  });

  it('webp: RIFF, four size bytes, WEBP', () => {
    expect(sniffType(Buffer.concat([ascii('RIFF'), hex('24000000'), ascii('WEBPVP8 ')]))).toBe('webp');
    expect(sniffType(Buffer.concat([ascii('RIFF'), hex('24000000'), ascii('WEBP')]))).toBe('webp');
  });

  it('webp: other RIFF containers and truncated headers are not webp', () => {
    expect(sniffType(Buffer.concat([ascii('RIFF'), hex('24000000'), ascii('WAVEfmt ')]))).toBe('unknown');
    expect(sniffType(Buffer.concat([ascii('RIFF'), hex('24000000'), ascii('AVI LIST')]))).toBe('unknown');
    expect(sniffType(Buffer.concat([ascii('RIFF'), hex('24000000'), ascii('WEB')]))).toBe('unknown');
    expect(sniffType(ascii('RIFF'))).toBe('unknown');
  });

  it('zip: a local file header or an empty archive (what .docx and .pptx are)', () => {
    expect(sniffType(Buffer.concat([hex('504b0304'), ascii('[Content_Types].xml')]))).toBe('zip');
    expect(sniffType(hex('504b0506 00000000'))).toBe('zip');
    expect(sniffType(hex('504b0304'))).toBe('zip');
    expect(sniffType(hex('504b03'))).toBe('unknown');
    expect(sniffType(ascii('PK'))).toBe('unknown');
    expect(sniffType(hex('504b0102'))).toBe('unknown');   // a central-directory record is not the start of an archive
  });

  describe('html', () => {
    it.each([
      '<!DOCTYPE html>', '<!doctype html>', '<!DocType HTML>', '<!doctype html lang="en">',
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN">',
      '<html>', '<HTML>', '<html lang="en">', '<head>', '<HEAD >', '<body>', '<body class="x">',
      '  <html>', '\n\n<!doctype html>', '\t \r\n\f<html>', '<html\nlang="en">',
    ])('%j is html', (s) => expect(sniffType(ascii(s))).toBe('html'));

    it('allows one UTF-8 BOM, and whitespace after it', () => {
      expect(sniffType(Buffer.concat([hex('efbbbf'), ascii('<!doctype html>')]))).toBe('html');
      expect(sniffType(Buffer.concat([hex('efbbbf'), ascii(' \n <html>')]))).toBe('html');
      expect(sniffType(Buffer.concat([hex('efbbbf efbbbf'), ascii('<html>')]))).toBe('unknown');
    });

    it.each([
      '<header>', '<headline>', '<htmlx>', '<bodybuilder>', '<heading>', '<!doctype htmlx>',
      '<html', '<head', '<body', '<!doctype html',                      // cut before the tag ends: cannot tell
      '<?xml version="1.0"?>', '<svg xmlns="http://www.w3.org/2000/svg">',
      'html', 'html>', '{"a":"<html>"}', 'Hello, world', '   ', '',
    ])('%j is not html', (s) => expect(sniffType(ascii(s))).toBe('unknown'));

    it('only looks at the first KB, so megabytes of padding cannot hide or fake a marker', () => {
      expect(sniffType(Buffer.concat([ascii(' '.repeat(200)), ascii('<html>')]))).toBe('html');
      expect(sniffType(Buffer.concat([Buffer.alloc(5 * 1024 * 1024, 0x20), ascii('<html>')]))).toBe('unknown');
    });
  });

  it('a binary type wins over an html marker later in the same buffer', () => {
    expect(sniffType(ascii('%PDF-1.7\n<html><body>'))).toBe('pdf');
    expect(sniffType(Buffer.concat([hex('504b0304'), ascii('<!doctype html>')]))).toBe('zip');
    expect(sniffType(Buffer.concat([hex('ffd8ffe0'), ascii('<html>')]))).toBe('jpeg');
  });

  it('an empty or one-byte buffer is unknown, and no prefix of any signature throws', () => {
    expect(sniffType(Buffer.alloc(0))).toBe('unknown');
    expect(sniffType(Buffer.from([0x25]))).toBe('unknown');
    const everyKind = new Set(['pdf', 'png', 'jpeg', 'gif', 'webp', 'zip', 'html', 'unknown']);
    const samples = [
      ascii('%PDF-1.7'), hex(`${PNG8} 0000`), hex('ffd8ffe0'), ascii('GIF89a'),
      Buffer.concat([ascii('RIFF'), hex('24000000'), ascii('WEBPVP8 ')]), hex('504b0304'), ascii('﻿<!doctype html>'),
    ];
    for (const s of samples) {
      for (let n = 0; n <= s.length; n++) expect(everyKind.has(sniffType(s.subarray(0, n)))).toBe(true);
    }
  });

  it('random binary is unknown, never a false match', () => {
    expect(sniffType(hex('00010203 04050607 08090a0b'))).toBe('unknown');
    expect(sniffType(Buffer.alloc(64, 0))).toBe('unknown');
    expect(sniffType(Buffer.alloc(64, 0xff))).toBe('unknown');
  });
});
