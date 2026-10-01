import { describe, it, expect } from 'vitest';
import { isPrivateIp, isBlockedHostname, isSafeUrlSync, assertSafePublicUrl, makeHostChecker, safeFetch } from './urlSafety.js';

describe('isPrivateIp', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd12:3456::1', '::ffff:10.0.0.1',
  ])('%s is private/reserved', (ip) => expect(isPrivateIp(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '203.0.113.5', '2606:4700:4700::1111'])(
    '%s is public', (ip) => expect(isPrivateIp(ip)).toBe(false));
});

describe('isBlockedHostname / isSafeUrlSync', () => {
  it('blocks localhost, internal suffixes, single-label hosts and private IP literals', () => {
    for (const h of ['localhost', 'app.localhost', 'printer.local', 'db.internal', 'metadata.google.internal', 'intranet', '10.0.0.5', '169.254.169.254']) {
      expect(isBlockedHostname(h), h).toBe(true);
    }
  });
  it('accepts ordinary public hostnames', () => {
    expect(isBlockedHostname('janedoe.design')).toBe(false);
    expect(isSafeUrlSync('https://www.behance.net/jane')).toBe(true);
  });
  it('rejects non-http schemes and URLs with embedded credentials', () => {
    for (const u of ['file:///etc/passwd', 'ftp://x.com', 'javascript:1', 'http://user:pass@example.com', 'not a url', 'http://169.254.169.254/latest/meta-data']) {
      expect(isSafeUrlSync(u), u).toBe(false);
    }
  });
});

describe('assertSafePublicUrl', () => {
  it('rejects an unsafe URL without touching DNS', async () => {
    await expect(assertSafePublicUrl('http://localhost:4000/api')).rejects.toThrow();
    await expect(assertSafePublicUrl('http://127.0.0.1')).rejects.toThrow();
  });
  it('accepts a public IP literal', async () => {
    await expect(assertSafePublicUrl('https://8.8.8.8/')).resolves.toBeInstanceOf(URL);
  });
});

// Regressions from the adversarial review: `new URL()` rewrites IPv4-mapped IPv6
// into HEX, which the original dotted-quad regex never matched, and a trailing
// dot made localhost-style names slip past exact/suffix checks.
describe('SSRF guard — forms that bypassed the first version', () => {
  it.each([
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:169.254.169.254]/latest/meta-data', 'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:192.168.1.1]/', 'http://[64:ff9b::7f00:1]/', 'http://[::7f00:1]/', 'http://[2002:7f00:1::]/',
    'http://[fe80::1]/', 'http://[fd00::1]/', 'http://[fec0::1]/', 'http://[::]/', 'http://[::1]/',
    'http://localhost./', 'http://foo.localhost./', 'http://metadata.google.internal./', 'http://LOCALHOST/',
  ])('%s is refused by the synchronous check', (u) => expect(isSafeUrlSync(u), u).toBe(false));

  it('isPrivateIp sees through every textual form of the same address', () => {
    for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:0001', '::FFFF:127.0.0.1', '::ffff:0a00:0001']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it('a mapped PUBLIC address is still allowed (no over-blocking)', () => {
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateIp('::ffff:808:808')).toBe(false);
    expect(isSafeUrlSync('http://[::ffff:8.8.8.8]/')).toBe(true);
    expect(isSafeUrlSync('https://janedoe.design./')).toBe(true);   // trailing dot on a public name is fine
  });
  it('a malformed host is blocked, never waved through', () => {
    expect(isBlockedHostname('[zzzz::1]')).toBe(true);
    expect(isBlockedHostname('')).toBe(true);
    expect(isBlockedHostname('...')).toBe(true);
  });
});

describe('makeHostChecker', () => {
  it('allows data/blob/about, refuses unsafe literals, and never resolves an unsafe host', async () => {
    const ok = makeHostChecker();
    expect(await ok('data:image/png;base64,AAAA')).toBe(true);
    expect(await ok('http://127.0.0.1/')).toBe(false);
    expect(await ok('http://[::ffff:7f00:1]/')).toBe(false);
    expect(await ok('http://localhost./x')).toBe(false);
    expect(await ok('file:///etc/passwd')).toBe(false);
    expect(await ok('https://8.8.8.8/')).toBe(true);
  });
});

describe('safeFetch', () => {
  it('refuses to fetch an unsafe URL at all', async () => {
    await expect(safeFetch('http://127.0.0.1:1/')).rejects.toThrow();
    await expect(safeFetch('http://[::ffff:7f00:1]:1/')).rejects.toThrow();
  });
});
