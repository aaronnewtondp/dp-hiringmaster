import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import {
  CHILD_HARD_CAP_SLACK_MS, CHILD_PARENT_POLL_MS, PDF_CHILD_HEAP_MB, PDF_CHILD_SOURCE, PDF_GLOBALS_SOURCE, PDF_MAX_OUTPUT_BYTES, PDF_MEMORY_WATCH, PDF_PARSE_MS, PDF_WATCHDOG_SOURCE,
  childResidentBytes, killLiveSandboxChildren, pdfParseEntry, readPdfInSandbox,
} from './pdfSandbox.js';
import type { PdfReadOptions, PdfReadResult } from './pdfSandbox.js';
import { fontsPdf, formBombPdf, formCyclePdf, hugeStringPdf, pages, pdfkitPdf, rawPdf } from './pdf.fixtures.js';
import { preflightPdf, preparePdf, TOO_COMPLEX_REASON } from './pdf.js';
import { BudgetTracker } from './budget.js';

// A stand-in for pdf-parse, loaded by the child process in place of the real module (the child takes the module's path as an argument).
// It does what the "PDF" bytes say, so each test can make the child spin, run out of heap in one step or in many, die, never answer, throw,
// flood its pipes or allocate external memory, with no real hostile file needed. Real pdf-parse over real (and real hostile) PDFs is
// exercised further down.
const FAKE_PARSER = `
const fs = require('fs');
class PDFParse {
  constructor(opts) {
    this.mode = Buffer.from(opts.data).toString('latin1');
    if (this.mode === 'construct-throws') throw new Error('constructor exploded');
  }
  async getInfo() {
    const m = this.mode;
    if (m === 'spin') { for (;;) {} }
    if (m.startsWith('flag:')) { fs.writeFileSync(m.slice(5), 'parsing'); for (;;) {} }   // says it is inside the parser (the ready mark is already written), then spins
    if (m === 'oom') { const keep = []; for (;;) keep.push(new Array(100000).fill(Math.random())); }
    if (m === 'bigalloc') { const one = new Array(60000000); one.fill(1); return { total: one.length, permission: null }; }
    if (m.startsWith('exit:')) process.exit(Number(m.slice(5)));
    if (m === 'never') return new Promise(() => {});
    if (m.startsWith('throw:')) { const [, name, message, code] = m.split(':'); throw Object.assign(new Error(message), { name, code: code || undefined }); }
    if (m === 'late-throw') { setTimeout(() => { throw new Error('async boom'); }, 10); return new Promise(() => {}); }
    if (m === 'late-reject') { setTimeout(() => { Promise.reject(new Error('async reject')); }, 10); return new Promise(() => {}); }
    if (m.startsWith('sleep:')) { this.t0 = Date.now(); await new Promise(r => setTimeout(r, Number(m.slice(6)))); }
    if (m.startsWith('mem:')) {   // external memory the heap flag does not cap: random bytes, so a compressing OS cannot hide them
      const keep = require('crypto').randomFillSync(Buffer.allocUnsafe(Number(m.slice(4)) * 1048576));
      await new Promise(r => setTimeout(r, 20000));
      return { total: keep.length > 0 ? 1 : 0, permission: null };
    }
    if (m === 'flood') { const chunk = 'x'.repeat(1 << 20); for (let i = 0; i < 64; i++) process.stdout.write(chunk); await new Promise(r => setTimeout(r, 20000)); }
    if (m === 'stray') process.stdout.write('stray text from a dependency before the answer' + String.fromCharCode(10));
    if (m === 'noisy') for (let i = 0; i < 6; i++) fs.writeSync(2, 'e'.repeat(1 << 20));
    if (m === 'zero') return { total: 0, permission: null };
    if (m === 'locked') return { total: 2, permission: [] };
    return { total: 3, permission: null };
  }
  async getText(params) {
    const m = this.mode;
    if (m.startsWith('sleep:')) return { text: '', pages: [{ num: 1, text: this.t0 + '-' + Date.now() }] };
    if (m === 'big') return { text: '', pages: [{ num: 1, text: 'a'.repeat(900000) }, { num: 2, text: 'b'.repeat(900000) }, { num: 3, text: 'c'.repeat(900000) }] };
    if (m === 'no-pages') return { text: 'only joined text' };
    if (m === 'utf8') return { text: '', pages: [{ num: 1, text: 'na\\u00efve \\u65e5\\u672c\\u8a9e \\ud83d\\ude00 e\\u0301' }] };
    if (m === 'env') return { text: '', pages: [{ num: 1, text: JSON.stringify({ keys: Object.keys(process.env), send: typeof process.send, channel: typeof process.channel, pid: process.pid, ppid: process.ppid, stdinTTY: !!process.stdin.isTTY }) }] };
    if (m === 'argv') return { text: '', pages: [{ num: 1, text: JSON.stringify(process.argv.slice(1)) }] };
    return { text: '', pages: [{ num: 1, text: 'first=' + params.first }] };
  }
}
module.exports = { PDFParse };
`;

let dir = '';
let fakePath = '';
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-sandbox-test-'));
  fakePath = path.join(dir, 'fake-pdf-parse.cjs');
  fs.writeFileSync(fakePath, FAKE_PARSER);
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const fakeRead = (mode: string, o: Partial<PdfReadOptions> = {}): Promise<PdfReadResult> =>
  readPdfInSandbox(Buffer.from(mode), { maxPages: 20, deadline: Date.now() + 60_000, parserModule: fakePath, ...o });

/** Largest gap between ticks of a 50 ms timer on THIS thread: the proof that the main thread stayed responsive. */
function heartbeat() {
  let last = Date.now();
  let max = 0;
  const timer = setInterval(() => { const now = Date.now(); max = Math.max(max, now - last); last = now; }, 50);
  return { stop: () => { clearInterval(timer); return Math.max(max, Date.now() - last); } };
}

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('readPdfInSandbox — a real PDF, read by the real pdf-parse inside a child process', { timeout: 60_000 }, () => {
  it('returns the page count, the lock state and the text of the pages, and leaves the caller\'s bytes alone', async () => {
    const bytes = rawPdf(pages(3));
    const before = Buffer.from(bytes);
    const r = await readPdfInSandbox(bytes, { maxPages: 20, deadline: Date.now() + 30_000 });
    expect(r).toMatchObject({ kind: 'read', total: 3, encrypted: false });
    if (r.kind !== 'read') throw new Error('unreachable');
    expect(r.pages.map(p => p.num)).toEqual([1, 2, 3]);
    expect(r.pages[0].text).toContain('Page 1 describes the campaign concept');
    expect(bytes.equals(before)).toBe(true);           // the child was fed from the caller's bytes: the caller can still base64 these
    expect(bytes.length).toBe(before.length);
  });

  it('reads only the first maxPages pages', async () => {
    const r = await readPdfInSandbox(rawPdf(pages(6)), { maxPages: 2, deadline: Date.now() + 30_000 });
    expect(r).toMatchObject({ kind: 'read', total: 6 });
    if (r.kind === 'read') expect(r.pages.map(p => p.num)).toEqual([1, 2]);
  });

  it('a file pdf-parse cannot open is a parser-error carrying the parser\'s own name and message (the caller decides what it means)', async () => {
    const r = await readPdfInSandbox(Buffer.from('%PDF-1.4\nthis is not a pdf at all, just a header'), { maxPages: 20, deadline: Date.now() + 30_000 });
    expect(r.kind).toBe('parser-error');
    if (r.kind === 'parser-error') expect(typeof r.message).toBe('string');
  });

  it('a password-protected PDF is a parser-error named PasswordException', async () => {
    const bytes = await pdfkitPdf({ userPassword: 'secret', ownerPassword: 'owner' });
    const r = await readPdfInSandbox(bytes, { maxPages: 20, deadline: Date.now() + 30_000 });
    expect(r).toMatchObject({ kind: 'parser-error', name: 'PasswordException' });
  });

  it('a PDF locked with an owner password only opens and reports encrypted: true', async () => {
    const bytes = await pdfkitPdf({ ownerPassword: 'owner', permissions: { printing: 'lowResolution' } });
    expect(await readPdfInSandbox(bytes, { maxPages: 20, deadline: Date.now() + 30_000 })).toMatchObject({ kind: 'read', encrypted: true });
  });

  it('pdfParseEntry is the CommonJS entry of the pdf-parse this bundle ships, and pdf.worker.mjs sits beside it', () => {
    const entry = pdfParseEntry();
    expect(path.isAbsolute(entry)).toBe(true);
    expect(entry.endsWith(path.join('pdf-parse', 'dist', 'pdf-parse', 'cjs', 'index.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(entry), 'pdf.worker.mjs'))).toBe(true);
  });
});

describe('readPdfInSandbox — the parent stays responsive and the child is killed', { timeout: 60_000 }, () => {
  it('a child stuck in an endless loop is killed at the deadline, and this thread never stalls while it spins', async () => {
    const beat = heartbeat();
    const started = Date.now();
    const r = await fakeRead('spin', { capMs: 1200 });
    const gap = beat.stop();
    expect(r).toEqual({ kind: 'timeout', limitedBy: 'pdf' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1100);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(gap).toBeLessThan(1000);
  });

  it('the killed child is really gone (SIGKILL, not a polite request)', async () => {
    let pid = 0;
    const r = await fakeRead('spin', { capMs: 1100, memory: { probe: id => { pid = id; return null; }, intervalMs: 20 } });
    expect(r.kind).toBe('timeout');
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(process.pid);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 5000 });
  });

  it('when the ITEM deadline is the nearer limit, the timeout says so (nobody\'s fault, not "too complex")', async () => {
    const r = await fakeRead('spin', { capMs: 30_000, deadline: Date.now() + 1300 });
    expect(r).toEqual({ kind: 'timeout', limitedBy: 'item' });
  });

  it('an item whose deadline has already passed is not given a process at all', async () => {
    const started = Date.now();
    expect(await fakeRead('spin', { deadline: Date.now() - 5 })).toEqual({ kind: 'timeout', limitedBy: 'item' });
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('a real form-XObject bomb (a 5 KB file whose work doubles with every level: 20 levels take ~14 s and 1.6 GB in-process) is killed at the deadline with the parent alive', async () => {
    const bomb = formBombPdf(20, 2);
    expect(bomb.length).toBeLessThan(8000);
    const beat = heartbeat();
    const r = await readPdfInSandbox(bomb, { maxPages: 20, deadline: Date.now() + 60_000, capMs: 2000 });
    const gap = beat.stop();
    expect(r).toEqual({ kind: 'timeout', limitedBy: 'pdf' });
    expect(gap).toBeLessThan(1000);
  });

  it('two forms that call each other do not hang the review either', async () => {
    const r = await readPdfInSandbox(formCyclePdf(), { maxPages: 20, deadline: Date.now() + 60_000, capMs: 2000 });
    expect(['read', 'timeout', 'too-complex', 'parser-error']).toContain(r.kind);
  });

  it('the defaults: a 12 s cap, a 512 MB heap flag, a 700 MB resident ceiling polled every 100 ms (500 ms where it costs a ps), a 16 MB output cap', () => {
    expect(PDF_PARSE_MS).toBe(12_000);
    expect(PDF_CHILD_HEAP_MB).toBe(512);
    expect(PDF_MEMORY_WATCH).toEqual({ intervalMs: 100, psIntervalMs: 500, ceilingBytes: 700 * 1024 * 1024 });
    expect(PDF_MAX_OUTPUT_BYTES).toBe(16 * 1024 * 1024);
  });
});

describe('readPdfInSandbox — memory: what used to abort the whole process now only ends the child', { timeout: 120_000 }, () => {
  it('a child that runs out of heap a little at a time is "too complex" (stderr says why), not a crashed process: this process keeps running', async () => {
    const beat = heartbeat();
    const r = await fakeRead('oom', { heapMb: 64 });
    expect(r).toEqual({ kind: 'too-complex', cause: 'heap' });
    expect(beat.stop()).toBeLessThan(1000);
    expect(await fakeRead('throw:Error:still alive')).toMatchObject({ kind: 'parser-error', message: 'still alive' });   // and the next PDF is read normally
  });

  it('ONE huge allocation that crosses the heap limit in a single step (what aborted node with exit 134 from a worker thread, in 12 of 12 runs) ends the child and nothing else', async () => {
    const beat = heartbeat();
    const parentPid = process.pid;
    for (let run = 0; run < 3; run++) {
      const r = await fakeRead('bigalloc', { heapMb: 64 });
      expect(r, `run ${run}`).toEqual({ kind: 'too-complex', cause: 'heap' });
    }
    expect(process.pid).toBe(parentPid);
    expect(beat.stop()).toBeLessThan(1500);
    expect(await fakeRead('throw:Error:still alive')).toMatchObject({ kind: 'parser-error', message: 'still alive' });
  });

  it('the same with a REAL file: one 8 MB literal string (a 9 KB PDF; 24 MB aborted a 512 MB heap) against a 64 MB heap is "too complex" every time, and the test process survives it', async () => {
    const pdf = hugeStringPdf(8);
    expect(pdf.length).toBeLessThan(20_000);
    expect(preflightPdf(pdf)).toMatchObject({ ok: true });                   // the pre-flight cannot tell this one from a deck: the sandbox has to
    const beat = heartbeat();
    for (let run = 0; run < 3; run++) {
      const r = await readPdfInSandbox(pdf, { maxPages: 20, deadline: Date.now() + 60_000, heapMb: 64 });
      expect(r, `run ${run}`).toEqual({ kind: 'too-complex', cause: 'heap' });
    }
    expect(beat.stop()).toBeLessThan(1500);
  });

  it('...and through preparePdf the verdict is the neutral "too complex", never retried', async () => {
    const r = await preparePdf(hugeStringPdf(8), 'bomb.pdf', { deadline: Date.now() + 60_000, budget: new BudgetTracker() }, { options: { heapMb: 64 } });
    expect(r).toMatchObject({ outcome: 'unreviewable', reason: TOO_COMPLEX_REASON, media: [], text: '' });
  });

  it('a modest string in the same file is just read (the limit is about the size, not about strings)', async () => {
    const r = await readPdfInSandbox(hugeStringPdf(0.5), { maxPages: 20, deadline: Date.now() + 60_000, heapMb: 64 });
    expect(r).toMatchObject({ kind: 'read', total: 1 });
  });

  it('3000 fonts that each expand a <0000>-<FFFF> ToUnicode map (a 1.1 MB file that aborted node with "heap out of memory" in-process) are "too complex" and nothing else is hurt', async () => {
    const bomb = fontsPdf(3000, 'tu');
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    const beat = heartbeat();
    const r = await readPdfInSandbox(bomb, { maxPages: 20, deadline: Date.now() + 60_000 });
    expect(r.kind).toBe('too-complex');
    expect(beat.stop()).toBeLessThan(1000);
  });

  it('the resident-size watchdog asks about the CHILD (its pid, not ours) and kills it when the answer passes the ceiling', async () => {
    const asked: number[] = [];
    let calls = 0;
    const probe = (pid: number) => { asked.push(pid); return 100_000_000 + calls++ * 40_000_000; };   // +40 MB on every poll
    const started = Date.now();
    const r = await fakeRead('spin', { memory: { probe, intervalMs: 20, ceilingBytes: 400_000_000 }, capMs: 30_000 });
    expect(r).toEqual({ kind: 'too-complex', cause: 'memory' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(calls).toBeGreaterThanOrEqual(8);
    expect(new Set(asked).size).toBe(1);
    expect(asked[0]).toBeGreaterThan(0);
    expect(asked[0]).not.toBe(process.pid);
  });

  it('the REAL probe reads a real child: 250 MB of external memory (which the heap flag does not count) passes a 150 MB ceiling and the child is killed', async () => {
    const started = Date.now();
    const r = await fakeRead('mem:250', { memory: { intervalMs: 50, ceilingBytes: 150 * 1024 * 1024 }, capMs: 30_000 });
    expect(r).toEqual({ kind: 'too-complex', cause: 'memory' });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('...while the same allocation under a generous ceiling is not touched', async () => {
    const r = await fakeRead('mem:60', { memory: { intervalMs: 50, ceilingBytes: 2_000_000_000 }, capMs: 3000 });
    expect(r).toEqual({ kind: 'timeout', limitedBy: 'pdf' });   // it sleeps for 20 s: only the deadline ended it
  });

  it('a probe that throws, rejects or has no answer is not a verdict on the file', async () => {
    const throwing = await fakeRead('sleep:300', { memory: { probe: () => { throw new Error('no /proc'); }, intervalMs: 20 } });
    const rejecting = await fakeRead('sleep:300', { memory: { probe: () => Promise.reject(new Error('ps failed')), intervalMs: 20 } });
    const none = await fakeRead('sleep:300', { memory: { probe: () => null, intervalMs: 20 } });
    expect([throwing.kind, rejecting.kind, none.kind]).toEqual(['read', 'read', 'read']);
  });

  it('an async probe is waited for, and a slow one never has two in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const probe = async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise(r => setTimeout(r, 60)); inFlight--; return 1; };
    const r = await fakeRead('sleep:500', { memory: { probe, intervalMs: 10 } });
    expect(r.kind).toBe('read');
    expect(maxInFlight).toBe(1);
  });
});

describe('childResidentBytes — the probe', () => {
  it('reads the size of a live process (this one) as a plausible number of bytes', async () => {
    const rss = await childResidentBytes(process.pid);
    expect(typeof rss).toBe('number');
    expect(rss as number).toBeGreaterThan(10 * 1024 * 1024);
    expect(rss as number).toBeLessThan(64 * 1024 * 1024 * 1024);
  });

  it('is null for a process that does not exist', async () => {
    expect(await childResidentBytes(2_000_000_000)).toBeNull();
  });

  it('on Linux it parses VmRSS (in kB, whatever the page size) from /proc/<pid>/status, and is null when the file is missing or has no such line', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const read = vi.spyOn(fs.promises, 'readFile');
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      read.mockImplementation((async (p: unknown) => {
        if (p === '/proc/321/status') return 'Name:\tnode\nVmPeak:\t  900000 kB\nVmRSS:\t  123456 kB\nRssAnon:\t 1 kB\n';
        if (p === '/proc/322/status') return 'Name:\tnode\nVmPeak:\t  900000 kB\n';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }) as unknown as typeof fs.promises.readFile);
      expect(await childResidentBytes(321)).toBe(123_456 * 1024);
      expect(await childResidentBytes(322)).toBeNull();
      expect(await childResidentBytes(323)).toBeNull();
    } finally {
      read.mockRestore();
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('never reads it on this thread: the /proc read is a promise (a read that waits on the kernel must not hold the event loop)', () => {
    const p = childResidentBytes(process.pid);
    expect(p).toBeInstanceOf(Promise);
    return p;
  });
});

describe('readPdfInSandbox — what each way of ending means', { timeout: 60_000 }, () => {
  it('a child that dies mid-parse (exit code 3) is too complex: the file is the suspect, not us', async () => {
    expect(await fakeRead('exit:3')).toEqual({ kind: 'too-complex', cause: 'crash' });
  });

  it('a child whose event loop empties on a promise that never settles ends without an answer: too complex too', async () => {
    expect(await fakeRead('never')).toEqual({ kind: 'too-complex', cause: 'crash' });
  });

  it('an exception thrown later from a timer inside the parser is reported as the parser\'s error, not lost and not fatal to this process', async () => {
    expect(await fakeRead('late-throw')).toMatchObject({ kind: 'parser-error', message: 'async boom' });
    expect(await fakeRead('late-reject')).toMatchObject({ kind: 'parser-error', message: 'async reject' });
  });

  it('an error thrown by the parser while reading carries its name, message and code to the caller', async () => {
    expect(await fakeRead('throw:PasswordException:No password given')).toMatchObject({ kind: 'parser-error', name: 'PasswordException', message: 'No password given' });
    expect(await fakeRead('throw:Error:boom:ERR_MODULE_NOT_FOUND')).toMatchObject({ kind: 'parser-error', message: 'boom', code: 'ERR_MODULE_NOT_FOUND' });
  });

  it('failing BEFORE the parser exists (its module will not load, or its constructor throws) is OURS: unavailable, never a verdict on the file', async () => {
    expect(await readPdfInSandbox(Buffer.from('x'), { maxPages: 20, deadline: Date.now() + 30_000, parserModule: path.join(dir, 'missing.cjs') })).toMatchObject({ kind: 'unavailable' });
    expect(await fakeRead('construct-throws')).toMatchObject({ kind: 'unavailable', message: 'constructor exploded' });
  });

  it('a process that cannot be created at all (an argument that cannot be passed, or no such program) is unavailable too', async () => {
    expect(await fakeRead('x', { parserModule: (() => 1) as never })).toMatchObject({ kind: 'unavailable' });   // spawn() throws on a non-string argument
    expect(await fakeRead('x', { execPath: path.join(dir, 'no-such-node') })).toMatchObject({ kind: 'unavailable' });   // ENOENT arrives as an 'error' event
  });

  it('a program that exits before the parser was constructed (here: a shell that rejects the flags) is OURS, whatever its exit status', async () => {
    const r = await fakeRead('x', { execPath: '/bin/sh' });
    expect(r).toMatchObject({ kind: 'unavailable' });
    if (r.kind === 'unavailable') expect(r.message).toContain('before it started');
  });

  it('reports a page count of zero as it is (the caller says "no pages"), without asking for any text', async () => {
    expect(await fakeRead('zero')).toEqual({ kind: 'read', total: 0, encrypted: false, pages: [] });
  });

  it('reports locked files, and falls back to the joined text when the parser returns no per-page list', async () => {
    expect(await fakeRead('locked')).toMatchObject({ kind: 'read', total: 2, encrypted: true });
    expect(await fakeRead('no-pages')).toMatchObject({ kind: 'read', pages: [{ num: 1, text: 'only joined text' }] });
  });

  it('caps what comes back: 400,000 characters a page, 1,200,000 in all (the injection scan reads 400,000 and the budget 60,000)', async () => {
    const r = await fakeRead('big');
    expect(r.kind).toBe('read');
    if (r.kind !== 'read') return;
    expect(r.pages.map(p => p.text.length)).toEqual([400_000, 400_000, 400_000]);
    expect(r.pages.reduce((n, p) => n + p.text.length, 0)).toBe(1_200_000);
  });

  it('carries text over the pipe as UTF-8 and loses nothing (accents, CJK, an emoji pair, a combining mark)', async () => {
    const r = await fakeRead('utf8');
    const expected = ['na', String.fromCharCode(0xef), 've ', String.fromCodePoint(0x65e5, 0x672c, 0x8a9e), ' ', String.fromCodePoint(0x1f600), ' e', String.fromCharCode(0x301)].join('');
    expect(r).toMatchObject({ kind: 'read', pages: [{ num: 1, text: expected }] });
  });

  it('asks the parser for min(total, maxPages) pages', async () => {
    const r = await fakeRead('x', { maxPages: 2 });
    expect(r).toMatchObject({ kind: 'read', pages: [{ num: 1, text: 'first=2' }] });
    expect(await fakeRead('x', { maxPages: 9 })).toMatchObject({ pages: [{ text: 'first=3' }] });
  });

  it('never rejects, whatever happens', async () => {
    for (const mode of ['spin', 'oom', 'exit:1', 'never', 'throw:Error:x', 'construct-throws']) {
      await expect(fakeRead(mode, { capMs: 700, heapMb: 64 })).resolves.toBeTypeOf('object');
    }
  });
});

describe('readPdfInSandbox — how the parent reads the way a child ended (fake programs, so each signal is exact and no crash report is written)', { timeout: 60_000 }, () => {
  const READY = "echo '@@pdf-sandbox-ready@@' >&2";
  const RESULT = '@@pdf-sandbox-result@@';
  const scripts: Record<string, string> = {
    'read': `${READY}; echo '${RESULT}{"type":"read","total":2,"encrypted":false,"pages":[{"num":1,"text":"hi"}]}'`,
    'abort-heap': `${READY}; echo 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' >&2; kill -ABRT $$`,
    'abort-plain': `${READY}; kill -ABRT $$`,
    'abort-native-oom': `${READY}; echo "terminate called after throwing an instance of 'std::bad_alloc'" >&2; kill -ABRT $$`,
    'segv': `${READY}; kill -SEGV $$`,
    'killed-from-outside': `${READY}; kill -KILL $$`,
    'exit-0-silent': `${READY}; exit 0`,
    'exit-7': `${READY}; exit 7`,
    'garbled-json': `${READY}; echo '${RESULT}{not json at all'`,
    'cut-off-json': `${READY}; printf '${RESULT}{"type":"read","total":2'`,
    'wrong-shape': `${READY}; echo '${RESULT}[1,2,3]'`,
    'no-mark': `${READY}; echo '{"type":"read","total":2,"encrypted":false,"pages":[]}'`,
    'load-error': `echo '${RESULT}{"type":"error","phase":"load","error":{"name":"Error","message":"Cannot find module"}}'`,
    'parse-error': `${READY}; echo '${RESULT}{"type":"error","phase":"parse","error":{"name":"PasswordException","message":"No password given","code":"X"}}'`,
    'never-ready-exit': 'exit 1',
    'ready-then-hang': `${READY}; exec sleep 30`,
    'noise-then-read': `echo 'noise one'; ${READY}; echo 'noise two'; echo '${RESULT}{"type":"read","total":1,"encrypted":true,"pages":[]}'`,
  };
  const run = (name: string, o: Partial<PdfReadOptions> = {}) => {
    const file = path.join(dir, `${name}.sh`);
    fs.writeFileSync(file, `#!/bin/sh\n${scripts[name]}\n`, { mode: 0o755 });
    return readPdfInSandbox(Buffer.from('%PDF-1.4'), { maxPages: 20, deadline: Date.now() + 60_000, execPath: file, ...o });
  };

  it('an answer on stdout is the answer, whatever else the child printed around it', async () => {
    expect(await run('read')).toEqual({ kind: 'read', total: 2, encrypted: false, pages: [{ num: 1, text: 'hi' }] });
    expect(await run('noise-then-read')).toEqual({ kind: 'read', total: 1, encrypted: true, pages: [] });
  });

  it('SIGABRT after a heap message is "heap"; a native allocation failure is "memory"; a plain abort and a segfault are "crash"', async () => {
    expect(await run('abort-heap')).toEqual({ kind: 'too-complex', cause: 'heap' });
    expect(await run('abort-native-oom')).toEqual({ kind: 'too-complex', cause: 'memory' });
    expect(await run('abort-plain')).toEqual({ kind: 'too-complex', cause: 'crash' });
    expect(await run('segv')).toEqual({ kind: 'too-complex', cause: 'crash' });
  });

  it('a SIGKILL that was not ours (the operating system\'s out-of-memory killer) is "memory"', async () => {
    expect(await run('killed-from-outside')).toEqual({ kind: 'too-complex', cause: 'memory' });
  });

  it('any other end without an answer after the parser started is "crash": a silent exit 0, an exit status, garbled, cut-off or wrong-shaped output, no result mark', async () => {
    for (const name of ['exit-0-silent', 'exit-7', 'garbled-json', 'cut-off-json', 'wrong-shape', 'no-mark']) {
      expect(await run(name), name).toEqual({ kind: 'too-complex', cause: 'crash' });
    }
  });

  it('an error answer is the parser\'s when it came from the parse phase, and OURS (unavailable) when it came from the load phase', async () => {
    expect(await run('parse-error')).toEqual({ kind: 'parser-error', name: 'PasswordException', message: 'No password given', code: 'X' });
    expect(await run('load-error')).toEqual({ kind: 'unavailable', message: 'Cannot find module' });
  });

  it('ending before the ready marker, however it ends, is OURS: unavailable', async () => {
    expect(await run('never-ready-exit')).toMatchObject({ kind: 'unavailable' });
  });

  it('a child that says it is ready and then hangs is killed at the deadline, not waited for', async () => {
    const started = Date.now();
    expect(await run('ready-then-hang', { capMs: 1200 })).toEqual({ kind: 'timeout', limitedBy: 'pdf' });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('readPdfInSandbox — a child cannot talk the parent into holding or doing too much', { timeout: 60_000 }, () => {
  it('more output than the cap is a kill, not an accumulation: "too complex", fast, with the parent alive', async () => {
    const beat = heartbeat();
    const started = Date.now();
    const r = await fakeRead('flood', { maxOutputBytes: 2 * 1024 * 1024, capMs: 30_000 });
    expect(r).toEqual({ kind: 'too-complex', cause: 'crash' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(beat.stop()).toBeLessThan(1500);
  });

  it('stray writes to stdout before the answer do not corrupt it, and a 6 MB flood of stderr is drained without blocking the child or being kept', async () => {
    expect(await fakeRead('stray')).toMatchObject({ kind: 'read', total: 3 });
    const started = Date.now();
    expect(await fakeRead('noisy')).toMatchObject({ kind: 'read', total: 3 });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('the child gets NOTHING of ours: a separate process whose parent is us (no shell between), no environment, no IPC channel, stdin is a pipe', async () => {
    const saved = process.env.HMS_SANDBOX_SECRET;
    const savedOptions = process.env.NODE_OPTIONS;
    process.env.HMS_SANDBOX_SECRET = 'must-not-leak';
    process.env.NODE_OPTIONS = '--max-old-space-size=4000';
    try {
      const r = await fakeRead('env');
      expect(r.kind).toBe('read');
      if (r.kind !== 'read') return;
      const seen = JSON.parse(r.pages[0].text) as { keys: string[]; send: string; channel: string; pid: number; ppid: number; stdinTTY: boolean };
      expect(seen.keys).not.toContain('HMS_SANDBOX_SECRET');
      expect(seen.keys).not.toContain('NODE_OPTIONS');
      expect(seen.keys).not.toContain('PATH');
      expect(seen.keys.every(k => !/secret|token|key|pass|anthropic|database|google|supabase/i.test(k))).toBe(true);
      expect(seen.send).toBe('undefined');
      expect(seen.channel).toBe('undefined');
      expect(seen.pid).not.toBe(process.pid);
      expect(seen.ppid).toBe(process.pid);
      expect(seen.stdinTTY).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.HMS_SANDBOX_SECRET; else process.env.HMS_SANDBOX_SECRET = saved;
      if (savedOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedOptions;
    }
  });

  it('children are killed when this process exits (killLiveSandboxChildren is what the exit hook runs): an abandoned PDF never outlives its review', async () => {
    let pid = 0;
    const flag = path.join(dir, `parsing-${process.pid}-${Date.now()}`);
    const pending = fakeRead(`flag:${flag}`, { capMs: 30_000, memory: { probe: id => { pid = id; return null; }, intervalMs: 20 } });
    await vi.waitFor(() => expect(fs.existsSync(flag)).toBe(true), { timeout: 20_000 });   // inside the parser: the ready mark is out (before this, a death is "ours": unavailable)
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(true);
    killLiveSandboxChildren();
    const r = await pending;
    expect(r.kind).toBe('too-complex');        // an external SIGKILL reads as the OS's out-of-memory killer
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 5000 });
  });
});

describe('readPdfInSandbox — one PDF at a time', { timeout: 60_000 }, () => {
  it('two reads started together run one after the other, never in parallel', async () => {
    const [a, b] = await Promise.all([fakeRead('sleep:300'), fakeRead('sleep:300')]);
    const span = (r: PdfReadResult) => {
      if (r.kind !== 'read') throw new Error(`not read: ${r.kind}`);
      const [from, to] = r.pages[0].text.split('-').map(Number);
      return { from, to };
    };
    const [first, second] = [span(a), span(b)].sort((x, y) => x.from - y.from);
    expect(first.to - first.from).toBeGreaterThanOrEqual(250);
    expect(second.from).toBeGreaterThanOrEqual(first.to);       // the second parse began after the first one's ended
  });

  it('a read queued behind a hung one waits only for that one\'s kill, and still runs', async () => {
    const hung = fakeRead('spin', { capMs: 800 });
    const next = fakeRead('x');
    expect((await hung).kind).toBe('timeout');
    expect((await next).kind).toBe('read');
  });

  it('a queued item whose own deadline passed while it waited is not started, and says so as OUR congestion (unavailable), not as a verdict on the file', async () => {
    const parsing = path.join(dir, `queued-${process.pid}-${Date.now()}`);
    const hung = fakeRead('spin', { capMs: 1000 });
    const late = fakeRead(`flag:${parsing}`, { deadline: Date.now() + 300 });
    const r = await late;
    expect(r).toMatchObject({ kind: 'unavailable' });
    expect(fs.existsSync(parsing)).toBe(false);          // no process was ever started for it
    await hung;
  });

  it('...but an item that ARRIVES with its deadline already passed keeps the neutral timeout: nothing waited for anybody', async () => {
    expect(await fakeRead('x', { deadline: Date.now() - 5 })).toEqual({ kind: 'timeout', limitedBy: 'item' });
    const hung = fakeRead('spin', { capMs: 600 });
    expect(await fakeRead('x', { deadline: Date.now() - 5 })).toEqual({ kind: 'timeout', limitedBy: 'item' });   // also while the queue is busy
    await hung;
  });

  it('hostile files ahead of ordinary ones do not make the ordinary ones "took too long to read": each one that ran out of time in the queue is unavailable (retried), none is a neutral timeout', async () => {
    // The reviewer's case, scaled down: three files that each hold the sandbox for their whole cap, then four ordinary ones whose own deadline is shorter than that wait.
    const hostile = [1, 2, 3].map(() => fakeRead('spin', { capMs: 500 }));
    const ordinary = [1, 2, 3, 4].map(() => fakeRead('x', { deadline: Date.now() + 700 }));
    const results = await Promise.all([...hostile, ...ordinary]);
    expect(results.slice(0, 3).map(r => r.kind)).toEqual(['timeout', 'timeout', 'timeout']);
    expect(results.slice(3).map(r => r.kind)).toEqual(['unavailable', 'unavailable', 'unavailable', 'unavailable']);
  });

  it('an item that STARTED and ran out of its own time is still the neutral timeout (a started read is a verdict on the file, not on the queue)', async () => {
    expect(await fakeRead('spin', { capMs: 30_000, deadline: Date.now() + 1300 })).toEqual({ kind: 'timeout', limitedBy: 'item' });
  });
});

// ─── the child's own deadman switch ──────────────────────────────────────────
// The parent kills the child at a deadline and on its own exit, but a parent that dies by SIGKILL (the OOM killer) or by a default-disposition SIGTERM runs
// no exit handler, and the child had no deadline of its own: an orphan spun at 100% of a core for as long as its parse took (four were found 13 hours old).
// These tests run REAL children (the real PDF_CHILD_SOURCE, the stand-in parser) and look at the operating system's process table, not at a mock.
describe('the child\'s deadman switch — a child never outlives its parent or its own hard cap', { timeout: 90_000 }, () => {
  const alive: number[] = [];
  const holders: ChildProcess[] = [];
  afterAll(() => {
    // whatever a failing test left behind must not become the 13-hour orphan this is about
    for (const pid of alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    for (const h of holders) { try { h.kill('SIGKILL'); } catch { /* gone */ } }
  });

  const CHILD_ARGS = (hardCapMs: number | null, parentPid: number | null): string[] => [
    '--max-old-space-size=128', '-e', PDF_CHILD_SOURCE, fakePath, '20', '400000', '1200000',
    ...(hardCapMs === null ? [] : [String(hardCapMs)]), ...(parentPid === null ? [] : [String(parentPid)]),
  ];
  const READY = '@@pdf-sandbox-ready@@';
  const RESULT = '@@pdf-sandbox-result@@';

  /** Runs a real child on `mode` straight from this test (the parent is this process, which stays alive) and reports how it ended. */
  function runChild(mode: string, args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; ms: number; pid: number }> {
    return new Promise(resolve => {
      const started = Date.now();
      const child = spawn(process.execPath, args, { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
      alive.push(child.pid as number);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.stdin.on('error', () => {});
      child.stdin.end(mode);
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, ms: Date.now() - started, pid: child.pid as number }));
    });
  }

  it('the watchdog is the first thing in the script, ahead of everything that could spin, and is ONE worker thread kept out of the child\'s stdio', () => {
    expect(PDF_CHILD_SOURCE.indexOf(PDF_WATCHDOG_SOURCE)).toBeGreaterThan(0);
    expect(PDF_CHILD_SOURCE.indexOf(PDF_WATCHDOG_SOURCE)).toBeLessThan(PDF_CHILD_SOURCE.indexOf('installPdfGlobals'));
    expect(PDF_WATCHDOG_SOURCE.match(/new Worker\(/g)).toHaveLength(1);
    expect(PDF_WATCHDOG_SOURCE).toContain('watchdog.unref()');
    // without these two options the Worker constructor makes fds 1 and 2 non-blocking, and the ready mark's synchronous write can fail with EAGAIN
    expect(PDF_WATCHDOG_SOURCE).toMatch(/stdout: true, stderr: true/);
    expect(CHILD_PARENT_POLL_MS).toBe(1000);
    expect(CHILD_HARD_CAP_SLACK_MS).toBe(3000);
  });

  it('the parent hands the child its own deadline (plus the slack) and its pid, and the child never sees anything else of ours', async () => {
    const r = await fakeRead('argv', { capMs: 5000 });
    expect(r.kind).toBe('read');
    if (r.kind !== 'read') return;
    const argv = JSON.parse(r.pages[0].text) as string[];
    expect(argv.slice(1, 4)).toEqual(['20', '400000', '1200000']);
    expect(argv[4]).toBe(String(5000 + CHILD_HARD_CAP_SLACK_MS));      // the hard cap: the parent's timeout for this very read, plus the slack
    expect(argv[5]).toBe(String(process.pid));                         // the parent that started it
    expect(argv).toHaveLength(6);
  });

  it('the hard cap follows the read\'s own limit, whichever is nearer (the item\'s deadline, not just the per-PDF cap)', async () => {
    const r = await fakeRead('argv', { capMs: 30_000, deadline: Date.now() + 7000 });
    if (r.kind !== 'read') throw new Error('not read');
    const cap = Number((JSON.parse(r.pages[0].text) as string[])[4]);
    expect(cap).toBeGreaterThan(CHILD_HARD_CAP_SLACK_MS + 5000);
    expect(cap).toBeLessThanOrEqual(7000 + CHILD_HARD_CAP_SLACK_MS);
  });

  it('a child whose parent is SIGKILLed dies by itself within a few seconds, although its main thread is in an endless loop', async () => {
    const sourceFile = path.join(dir, 'child-source.js');
    const holder = path.join(dir, 'holder.cjs');
    const pidFile = path.join(dir, `holder-child-${process.pid}.pid`);
    const spinning = path.join(dir, `holder-spinning-${process.pid}`);
    fs.writeFileSync(sourceFile, PDF_CHILD_SOURCE);
    fs.writeFileSync(holder, [
      "const { spawn } = require('child_process'); const fs = require('fs');",
      'const [, , sourceFile, parserFile, pidFile, flagFile] = process.argv;',
      "const child = spawn(process.execPath, ['--max-old-space-size=128', '-e', fs.readFileSync(sourceFile, 'utf8'), parserFile, '20', '400000', '1200000', '600000', String(process.pid)], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });",
      "child.stdin.end('flag:' + flagFile); child.stdout.resume(); child.stderr.resume();",
      'fs.writeFileSync(pidFile, String(child.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const parent = spawn(process.execPath, [holder, sourceFile, fakePath, pidFile, spinning], { stdio: 'ignore' });
    holders.push(parent);
    await vi.waitFor(() => expect(fs.existsSync(spinning)).toBe(true), { timeout: 20_000 });      // the child is inside the parser: spinning
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    alive.push(childPid);
    expect(isAlive(childPid)).toBe(true);
    await new Promise(r => setTimeout(r, 1500));                                                   // a whole poll interval of spinning with its parent alive: it must NOT end itself
    expect(isAlive(childPid)).toBe(true);

    const killedAt = Date.now();
    parent.kill('SIGKILL');                                                                        // no exit handler runs on this
    await vi.waitFor(() => expect(isAlive(childPid)).toBe(false), { timeout: 12_000, interval: 100 });
    const took = Date.now() - killedAt;
    expect(took).toBeLessThan(5500);                                                               // one poll interval and a little more, never the 10 minutes of its hard cap
  });

  it('...and when the parent dies BEFORE the watchdog has looked (the child starts already orphaned), the pid it was given says so at the first look', async () => {
    // the pid it is told is its parent (1_999_999 does not exist, so it is "somebody else" from the first tick): a child that is not its parent's is ended
    const r = await runChild('flag:' + path.join(dir, `orphan-${process.pid}`), CHILD_ARGS(600_000, 1_999_999));
    expect(r.signal).toBe('SIGKILL');
    expect(r.ms).toBeLessThan(6000);
  });

  it('a child that outlives its hard cap ends itself, with its parent alive and well', async () => {
    const r = await runChild('spin', CHILD_ARGS(1500, process.pid));
    expect(r.signal).toBe('SIGKILL');
    expect(r.ms).toBeGreaterThanOrEqual(1400);
    expect(r.ms).toBeLessThan(6000);
    expect(isAlive(process.pid)).toBe(true);
  });

  it('a normal parse is untouched: exit 0 well inside the hard cap, ONE answer line on stdout, only the ready mark on stderr', async () => {
    const r = await runChild('x', CHILD_ARGS(600_000, process.pid));
    expect(r.code).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.ms).toBeLessThan(5000);                       // the worker thread neither keeps a finished child alive nor delays its exit (its cap is 10 minutes)
    expect(r.stdout.startsWith(RESULT)).toBe(true);
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stdout.split('\n').filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(r.stdout.slice(RESULT.length))).toMatchObject({ type: 'read', total: 3, encrypted: false });
    expect(r.stderr).toBe(READY + '\n');
  });

  it('...also when the parent gave it neither a cap nor a pid (an old caller, or a hand-run script): it falls back to a default cap and the pid it started with', async () => {
    const r = await runChild('x', CHILD_ARGS(null, null));
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith(RESULT)).toBe(true);
  });

  it('...and a child with a heavy pipe is as before: the watchdog does not turn stdout/stderr non-blocking (a 6 MB synchronous write to stderr still works)', async () => {
    const r = await runChild('noisy', CHILD_ARGS(600_000, process.pid));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.slice(r.stdout.indexOf(RESULT) + RESULT.length))).toMatchObject({ type: 'read', total: 3 });
  });

  it('a watchdog that cannot start (no worker threads, or a Worker that throws) is not a reason to fail the parse', () => {
    const run = (require_: (id: string) => unknown) => new vm.Script(PDF_WATCHDOG_SOURCE).runInNewContext({ require: require_, process: { argv: [], ppid: 1 } });
    expect(() => run(() => { throw new Error('no worker_threads here'); })).not.toThrow();
    expect(() => run(() => ({ Worker: class { constructor() { throw new Error('cannot create a thread'); } } }))).not.toThrow();
  });

  it('the worker\'s own script reads the cap and the pid it is given, and ends the process with SIGKILL for either reason', () => {
    const made: Array<{ code: string; options: { workerData: { parentPid: number; hardCapMs: number }; eval: boolean } }> = [];
    class FakeWorker {
      constructor(code: string, options: { workerData: { parentPid: number; hardCapMs: number }; eval: boolean }) { made.push({ code, options }); }
      on() { return this; }
      unref() { return this; }
    }
    new vm.Script(PDF_WATCHDOG_SOURCE).runInNewContext({ require: () => ({ Worker: FakeWorker }), process: { argv: ['node', 'entry', '20', '1', '2', '4321', '777'], ppid: 1 } });
    expect(made).toHaveLength(1);
    expect(made[0].options.eval).toBe(true);
    expect(made[0].options.workerData).toEqual({ parentPid: 777, hardCapMs: 4321 });
    expect(made[0].code).toContain("process.kill(process.pid, 'SIGKILL')");
    expect(made[0].code).toContain('process.ppid !== workerData.parentPid');
    expect(made[0].code).toContain(`}, ${CHILD_PARENT_POLL_MS});`);
    expect(made[0].code).toContain('setTimeout(die, workerData.hardCapMs)');
  });
});

describe('the child script', () => {
  it('is syntactically valid JavaScript with no TypeScript in it', () => {
    expect(() => new vm.Script(PDF_CHILD_SOURCE)).not.toThrow();
    expect(PDF_CHILD_SOURCE).not.toMatch(/: (?:string|number|boolean)\b/);
  });

  it('has no backslash and no backtick (it travels as one command-line argument and is built in a template literal)', () => {
    expect(PDF_CHILD_SOURCE).not.toContain('\\');
    expect(PDF_CHILD_SOURCE).not.toContain('`');
  });

  it('is small enough for one argument on every platform (Linux allows 128 KB)', () => {
    expect(PDF_CHILD_SOURCE.length).toBeLessThan(16 * 1024);
  });
});

describe('the browser globals pdfjs needs (installed inside the child, where this process\'s globals are not)', () => {
  const names = ['DOMMatrix', 'Path2D', 'ImageData'] as const;
  /** Runs the child's globals installer against a fresh, empty "global" object. */
  function install(g: Record<string, unknown>, loadNative: () => unknown) {
    const run = new Function('g', 'loadNative', `${PDF_GLOBALS_SOURCE}\ninstallPdfGlobals(g, loadNative);`);
    run(g, loadNative);
    return g;
  }

  it('installs working stand-ins when the native canvas package cannot be loaded', () => {
    const g = install({}, () => { throw new Error('native binary missing'); });
    expect(names.map(n => (g[n] as { name: string }).name)).toEqual(['DOMMatrixPolyfill', 'Path2DPolyfill', 'ImageDataPolyfill']);
    const Matrix = g.DOMMatrix as new (init?: number[]) => { a: number; b: number; c: number; d: number; e: number; f: number; translate(x: number, y: number): typeof m; scale(x: number, y?: number): typeof m };
    const m = new Matrix([2, 0, 0, 2, 10, 20]);
    const t = m.translate(5, 5);
    expect([t.a, t.b, t.c, t.d, t.e, t.f]).toEqual([2, 0, 0, 2, 20, 30]);
    const s = new Matrix().scale(3);
    expect([s.a, s.d]).toEqual([3, 3]);
    const Data = g.ImageData as new (w: number, h: number) => { data: Uint8ClampedArray };
    expect(new Data(2, 3).data.length).toBe(24);
  });

  it('the stand-in matrix does the affine algebra pdfjs positions glyphs with', () => {
    const g = install({}, () => null);
    const Matrix = g.DOMMatrix as new (init?: unknown) => Record<'a' | 'b' | 'c' | 'd' | 'e' | 'f', number> & { multiply(o: unknown): typeof x; invertSelf(): typeof x; multiplySelf(o: unknown): typeof x; preMultiplySelf(o: unknown): typeof x; setTransform(o: unknown): typeof x };
    const x = new Matrix();
    const rotate = new Matrix([0, 1, -1, 0, 0, 0]);
    const moved = new Matrix([1, 0, 0, 1, 7, 9]);
    const both = rotate.multiply(moved);
    expect([both.a, both.b, both.c, both.d, both.e, both.f]).toEqual([0, 1, -1, 0, -9, 7]);
    const inverse = new Matrix([2, 0, 0, 4, 6, 8]).invertSelf();
    expect([inverse.a, inverse.d, inverse.e, inverse.f]).toEqual([0.5, 0.25, -3, -2]);
    expect(new Matrix({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }).setTransform(moved).e).toBe(7);
    const self = new Matrix([1, 0, 0, 1, 1, 1]);
    self.multiplySelf(new Matrix([1, 0, 0, 1, 2, 3]));
    expect([self.e, self.f]).toEqual([3, 4]);
    self.preMultiplySelf(new Matrix([2, 0, 0, 2, 0, 0]));
    expect([self.a, self.e, self.f]).toEqual([2, 6, 8]);
  });

  it('prefers the real native implementations when they do load', () => {
    const g = install({}, () => ({ DOMMatrix: class NativeMatrix {}, Path2D: class NativePath {}, ImageData: class NativeData {} }));
    expect(names.map(n => (g[n] as { name: string }).name)).toEqual(['NativeMatrix', 'NativePath', 'NativeData']);
  });

  it('leaves globals that already exist alone', () => {
    const sentinel = function Sentinel() {};
    const g = install({ DOMMatrix: sentinel, Path2D: sentinel, ImageData: sentinel }, () => { throw new Error('must not even be asked'); });
    for (const n of names) expect(g[n]).toBe(sentinel);
  });

  it('fills in only what is missing', () => {
    const sentinel = function Sentinel() {};
    const g = install({ DOMMatrix: sentinel }, () => null);
    expect(g.DOMMatrix).toBe(sentinel);
    expect((g.Path2D as { name: string }).name).toBe('Path2DPolyfill');
  });
});
