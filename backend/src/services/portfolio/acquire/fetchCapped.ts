// WORKER-ONLY (see ../browser.ts). Downloads one candidate-supplied URL with hard ceilings on time and size.
// Built ONLY on safeFetch, so every redirect hop is SSRF-validated; this adds what safeFetch lacks: a deadline over the
// whole download (headers + body) and a byte cap that is enforced while streaming, never trusting content-length alone.
import { safeFetch } from '../urlSafety.js';

export interface CappedOptions {
  /** Largest body we will hold, counted AFTER any content-encoding (gzip/br) has been undone. */
  maxBytes:   number;
  /** Deadline for the whole download — connecting, headers and the entire body. */
  timeoutMs:  number;
  accept?:    string;
  userAgent?: string;
}

export interface CappedResult {
  /** True only for a 2xx whose whole body (<= maxBytes) was read; then `bytes` is non-null. */
  ok:          boolean;
  status:      number;
  /** null on a non-2xx and when the body was too large. */
  bytes:       Buffer | null;
  /** As reported by the server — never trusted; callers sniff the bytes (see sniffType). */
  contentType: string;
  /** The last hop's URL (safeFetch follows redirects itself); the input URL when the Response does not carry one. */
  finalUrl:    string;
  /** The body exceeded maxBytes (declared by content-length, or counted while streaming). */
  tooLarge:    boolean;
  /** Lowercased subset of the response headers: just what callers need to classify a failure or name a file. */
  headers:     Record<string, string>;
}

const KEPT_HEADERS = ['content-type', 'content-length', 'content-disposition', 'cf-mitigated', 'server', 'location', 'x-frame-options'] as const;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; DigitalPaaniBot/1.0; +https://digitalpaani.com)';
// setTimeout silently turns anything above 2^31-1 ms into 1 ms, i.e. a "very patient" caller would get no patience at all.
const MAX_TIMEOUT_MS = 2_147_483_647;

function timeoutError(ms: number): Error {
  const e = new Error(`timed out after ${ms} ms`);
  e.name = 'AbortError';
  return e;
}

/** True for the error fetchCapped throws on its deadline, and for any other abort/timeout-shaped error. */
export function isTimeoutError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const { name, message } = e as { name?: unknown; message?: unknown };
  return name === 'AbortError' || name === 'TimeoutError' || (typeof message === 'string' && /^timed out/i.test(message));
}

/**
 * undici reports every network failure as `TypeError: fetch failed` and hides the useful part (ENOTFOUND,
 * ECONNRESET, a TLS error) in `.cause`. Lift the code into the message and onto `.code` so callers can tell a dead
 * domain (the candidate's problem) from a dropped connection (ours). The same Error is returned (class, stack and
 * cause intact); one that already says something is left alone.
 */
function clearError(e: unknown): Error {
  if (!(e instanceof Error)) return new Error(`request failed: ${String(e).slice(0, 200)}`);
  const cause = (e as { cause?: unknown }).cause;
  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && !e.message.includes(code)) {
    e.message = `${e.message} (${code})`;
    (e as Error & { code?: string }).code = code;
  }
  return e;
}

function keptHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const v = h.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

/** The declared body size, or null when the header is missing or not a plain non-negative integer. */
function declaredLength(h: Headers): number | null {
  const raw = h.get('content-length');
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());   // a digit string never yields NaN; an absurdly long one is Infinity, i.e. over any cap
}

/**
 * Downloads `url` (SSRF-checked at every hop) into memory, never holding more than `maxBytes`.
 * Resolves for any HTTP status; REJECTS on network failure and on the deadline — a timeout is recognisable by
 * isTimeoutError() (name 'AbortError', message starting 'timed out').
 *  - non-2xx: ok false, bytes null, body cancelled unread (status + headers still returned: a 403 with
 *    `cf-mitigated` is a bot wall, not a private file).
 *  - content-length above the cap: rejected before reading a byte. The header is compared as sent (the encoded size);
 *    an encoded body is practically never larger than its decoded form, so this does not turn away a file that fits.
 *  - otherwise streamed through a counter that sees decoded bytes; the moment it passes the cap the download is
 *    cancelled, so a lying or absent content-length cannot make us buffer more than maxBytes (plus one chunk in flight).
 */
export async function fetchCapped(url: string, o: CappedOptions): Promise<CappedResult> {
  if (!Number.isFinite(o.maxBytes) || o.maxBytes < 0) throw new Error('fetchCapped: maxBytes must be a non-negative number');
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0 || o.timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`fetchCapped: timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  // Raced against the download so the deadline holds even where the signal cannot help (the DNS lookup inside
  // safeFetch, a body that stalls without erroring).
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reader?.cancel().catch(() => {});
      reject(timeoutError(o.timeoutMs));
    }, o.timeoutMs);
  });

  const download = async (): Promise<CappedResult> => {
    const res = await safeFetch(url, {
      method: 'GET',
      headers: { 'user-agent': o.userAgent ?? DEFAULT_USER_AGENT, accept: o.accept ?? '*/*' },
      signal: controller.signal,
    });
    const base = {
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      finalUrl: res.url || url,
      headers: keptHeaders(res.headers),
    };
    if (timedOut) {   // the deadline passed while the headers were in flight: nobody is waiting for this body
      await res.body?.cancel().catch(() => {});
      throw timeoutError(o.timeoutMs);
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ...base, ok: false, bytes: null, tooLarge: false };
    }
    const declared = declaredLength(res.headers);
    if (declared !== null && declared > o.maxBytes) {
      await res.body?.cancel().catch(() => {});
      return { ...base, ok: false, bytes: null, tooLarge: true };
    }
    if (!res.body) return { ...base, ok: true, bytes: Buffer.alloc(0), tooLarge: false };

    reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) throw timeoutError(o.timeoutMs);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > o.maxBytes) {
        await reader.cancel().catch(() => {});
        return { ...base, ok: false, bytes: null, tooLarge: true };
      }
      chunks.push(value);
    }
    return { ...base, ok: true, bytes: Buffer.concat(chunks, total), tooLarge: false };
  };

  try {
    return await Promise.race([download(), deadline]);
  } catch (e) {
    throw timedOut ? timeoutError(o.timeoutMs) : clearError(e);
  } finally {
    clearTimeout(timer);
    // Also releases the sockets of redirect responses safeFetch never read. A no-op on a body that is already finished.
    controller.abort();
  }
}

export type SniffedType = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'zip' | 'html' | 'unknown';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const PNG_TAIL = [0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buf: Buffer, sig: readonly number[], at = 0): boolean {
  return buf.length >= at + sig.length && sig.every((b, i) => buf[at + i] === b);
}

// Optional UTF-8 BOM and whitespace, then a tag that opens an HTML document. The tag name must end at a
// tag-terminating byte, otherwise `<header>` would pass for `<head>`. Matched on a latin1 view so bytes map 1:1.
const HTML_START = /^(?:ï»¿)?[\t\n\f\r ]*(?:<!doctype html|<html|<head|<body)(?=[\t\n\f\r >])/i;

/**
 * What a downloaded body really is, from its leading bytes. A server's content-type is a claim, not evidence
 * (a Drive "view" page is text/html with a .pdf name; a hostile host can call anything image/png).
 * Short or empty buffers are never an error, they just do not match: 'unknown'.
 */
export function sniffType(buf: Buffer): SniffedType {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';                                    // %PDF-
  // 89 50 4E 47 identifies it; a buffer long enough to hold the rest of the 8-byte signature must also match it.
  if (startsWith(buf, PNG_MAGIC) && (buf.length < 8 || startsWith(buf, PNG_TAIL, 4))) return 'png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'gif';   // GIF87a / GIF89a
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';   // RIFF....WEBP
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) return 'zip';        // PK local header / empty archive
  if (HTML_START.test(buf.toString('latin1', 0, Math.min(buf.length, 1024)))) return 'html';
  return 'unknown';
}
