import dns from 'dns';
import net from 'net';

// SSRF guard for every URL the portfolio pipeline is about to visit or
// probe. The URLs come out of candidate-supplied resumes, i.e. they are
// attacker-controlled input that our own server (and browser) will fetch.
// The realistic threat isn't the public internet — it's a link that points
// at localhost / a private range / a cloud metadata endpoint, or a public
// hostname that resolves or redirects to one.

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

/**
 * Expands any IPv6 text form to its eight 16-bit groups. Works on the forms
 * `new URL()` produces — notably IPv4-mapped addresses normalised to HEX
 * (`[::ffff:127.0.0.1]` becomes `::ffff:7f00:1`), which a dotted-quad regex
 * never matches.
 */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // Embedded dotted IPv4 tail (::ffff:1.2.3.4) -> two hex groups.
  const tail = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    if (!net.isIPv4(tail[2])) return null;
    const v4 = ipv4ToInt(tail[2]);
    s = `${tail[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest].map(g => parseInt(g, 16));
  return groups.length === 8 && groups.every(g => Number.isFinite(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPrivateIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind !== 6) return false;
  const g = expandV6(ip);
  if (!g) return true;                                   // unparseable: refuse
  const allZeroTo = (n: number) => g.slice(0, n).every(x => x === 0);
  if (allZeroTo(7) && (g[7] === 0 || g[7] === 1)) return true;         // :: and ::1
  if (allZeroTo(5) && g[5] === 0xffff) return isPrivateV4(v4FromGroups(g[6], g[7]));   // ::ffff:a.b.c.d (IPv4-mapped)
  if (allZeroTo(6)) return true;                         // ::a.b.c.d (deprecated IPv4-compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isPrivateV4(v4FromGroups(g[6], g[7]));  // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return isPrivateV4(v4FromGroups(g[1], g[2]));   // 6to4 embeds the IPv4 in bits 16-47
  if (g[0] === 0x2001 && g[1] === 0) return true;        // Teredo tunnelling
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;   // documentation range
  if (g[0] === 0x0100 && g.slice(1, 4).every(x => x === 0)) return true; // 100::/64 discard
  if ((g[0] & 0xfe00) === 0xfc00) return true;           // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true;           // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true;           // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true;           // ff00::/8 multicast
  return false;
}

export function isBlockedHostname(host: string): boolean {
  // "localhost." and "metadata.google.internal." (trailing dot) are the same
  // names to a resolver; strip it before every check.
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!h) return true;
  if (net.isIP(h)) return isPrivateIp(h);
  return h === 'localhost'
    || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
    || h.endsWith('.intranet') || h.endsWith('.lan') || h.endsWith('.home.arpa')
    || h === 'metadata.google.internal' || !h.includes('.');
}

/** Synchronous check usable inside request-interception callbacks. */
export function isSafeUrlSync(rawUrl: string): boolean {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  return !isBlockedHostname(u.hostname);
}

async function resolvesToPublic(host: string): Promise<boolean> {
  const bare = host.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (net.isIP(bare)) return !isPrivateIp(bare);
  try {
    const addrs = await dns.promises.lookup(bare, { all: true });
    return addrs.length > 0 && !addrs.some(a => isPrivateIp(a.address));
  } catch { return false; }
}

/** Full check including DNS resolution — use before navigating or fetching. */
export async function assertSafePublicUrl(rawUrl: string): Promise<URL> {
  if (!isSafeUrlSync(rawUrl)) throw new Error('unsafe or unsupported URL');
  const u = new URL(rawUrl);
  const bare = u.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (net.isIP(bare)) return u;
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(bare, { all: true });
  } catch {
    throw new Error('hostname does not resolve');
  }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) {
    throw new Error('hostname resolves to a private or reserved address');
  }
  return u;
}

/**
 * Per-crawl cache of "does this hostname resolve to a public address" — used by
 * the browser's request filter so every sub-resource and redirect target is
 * DNS-checked, not just string-matched. (A determined DNS-rebinding attacker
 * can still race the lookup; this closes the ordinary public-name-that-points-
 * at-a-private-address case.)
 */
export function makeHostChecker(): (url: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return async (rawUrl: string) => {
    if (/^(data|blob|about):/i.test(rawUrl)) return true;
    if (!isSafeUrlSync(rawUrl)) return false;
    const host = new URL(rawUrl).hostname.toLowerCase();
    let hit = cache.get(host);
    if (!hit) { hit = resolvesToPublic(host); cache.set(host, hit); }
    return hit;
  };
}

const MAX_REDIRECTS = 4;

/**
 * fetch() that validates EVERY hop. A public URL that 302s to
 * http://169.254.169.254/… must not be followed just because the first hop was
 * safe, which is what `redirect: 'follow'` would do.
 */
export async function safeFetch(
  rawUrl: string,
  init: { method?: 'GET' | 'HEAD'; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> {
  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafePublicUrl(url);
    const res = await fetch(url, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url).toString();
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}
