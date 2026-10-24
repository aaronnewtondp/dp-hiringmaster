// SHARED: imported by the portfolio worker (via portfolio/acquire/pdf.ts) AND by the main API (resume parsing, pdfSandbox/resume.ts <- driveService.ts).
// It imports nothing of HMS or the portfolio review, only node built-ins (child_process, fs, module) — a test (pdfSandbox/boundary.test.ts) fails if that
// ever changes. Runs pdf-parse (pdfjs) on ONE candidate PDF in a CHILD PROCESS that the parent can kill. pdfjs has no
// operation, time or memory governance of its own, and it runs synchronously for long stretches: a few KB of hostile PDF (nested form
// XObjects that call each other twice, a content stream patched to be a 65000 x 65000 JPEG, 3000 fonts whose ToUnicode maps each expand
// <0000>-<FFFF>) kept the event loop busy for 15-40 s, so no timeout on the main thread ever fired, and at 1-2.5 GB it aborted node
// outright ("JavaScript heap out of memory", exit 134), taking every review co-located on the instance with it. preflightPdf() refuses
// the shapes it recognises; this is what is left standing when it does not.
//
// A THREAD is not enough, and that is why this is a process. The first version ran the parse in a worker_thread with resourceLimits.
// That contains an INCREMENTAL allocator (the thread's heap limit fires an 'error' event) but not ONE very large allocation: a 24 KB PDF
// whose content stream holds a single ~22-24 MB literal string makes pdfjs build a glyph array of tens of millions of objects in one
// step, V8 reaches "FATAL ERROR: Reached heap limit Allocation failed" before the thread's near-heap-limit hook can act, and that fatal
// ABORTS THE WHOLE PROCESS (exit 134; 12 of 12 runs at 24 MB, and in the Lambda image after the sandbox had already answered). Only a
// process boundary survives that, so:
//  - The parse runs in a child node process (`--max-old-space-size`, no environment, no shell, no IPC channel, three plain pipes). The PDF
//    goes in over stdin; ONE bounded JSON line comes back on stdout. A heap abort, an OOM kill, a segfault or a hang takes out the child
//    and nothing else: the parent sees an exit signal and answers "too complex".
//  - The parent kills the child (SIGKILL) at a hard deadline, when its resident size passes a ceiling, and when it writes more than it may.
//    Nothing awaits a kill: the answer is returned the moment the verdict is known.
//  - The resident size is read from /proc on Linux (asynchronously: a few tens of microseconds) and from `ps` on macOS (dev machines; coarser). It matters because
//    --max-old-space-size does not cap ArrayBuffers / external memory (a 65000 x 65000 JPEG decode is all external).
//  - One PDF at a time per process: the review's budgets already limit what is parsed, and a second parse would only make the first one's
//    memory growth impossible to attribute. An item whose OWN deadline passes while it waits for its turn is never started and is
//    'unavailable' (ours: files ahead of it used up its time, so the review retries), not the neutral timeout of a file that ran out of time.
//  - The child has its own deadman switch (PDF_WATCHDOG_SOURCE): a worker thread that ends it when its parent is gone (the exit hook below
//    does not run on SIGKILL or SIGTERM) or when its hard cap has passed, so an orphan never spins on.
//  - A killed, crashed or out-of-memory child is "too complex to open automatically": a verdict on the FILE (neutral, never retried: a hostile
//    or pathological file would just waste another 300 s run). Not being able to start the child, or its failing before the parser was even
//    constructed, is OURS.
// Bundling: the child's script is passed inline (`node -e <script> <absolute path>`), so there is no extra file for a tracer to find; the
// absolute path of pdf-parse's CommonJS entry is resolved here (a tracer follows `require.resolve`), and pdf-parse's own pdf.worker.mjs
// (pdfjs's fake worker, inside the child) is shipped by vercel.json includeFiles.
import { spawn, execFile } from 'child_process';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';

/** The hard limit on one PDF's parse. Real files read in well under two seconds. */
export const PDF_PARSE_MS = 12_000;
/** Never start a child with less than this left (a started child is given at least a second, as stepMs always did). */
const MIN_PARSE_MS = 1_000;
/** After a kill is requested, the next PDF waits at most this long for the dead child's memory to be released. */
const EXIT_GRACE_MS = 2_000;
/** A child ends itself this long after the deadline its parent set it (the parent kills it at the deadline; this is for a parent that cannot). */
export const CHILD_HARD_CAP_SLACK_MS = 3_000;
/** How often a child checks that its parent is still the process that started it. A dead parent's child lives at most this long, plus its start-up. */
export const CHILD_PARENT_POLL_MS = 1_000;

/**
 * What the child may hold on the JS heap (`--max-old-space-size`). pdfjs needs well under 200 MB for a real 20-page deck; 512 MB leaves room
 * for the largest files the review opens (8 MB) and is far below the 2 GB function. Passing it as a flag to a separate process is what makes
 * hitting it survivable: V8 aborts the CHILD, however large the allocation that crossed the line.
 */
export const PDF_CHILD_HEAP_MB = 512;

const MB = 1024 * 1024;
/**
 * The resident-size watchdog, for the CHILD. A child starts fresh for every PDF, so this is an absolute ceiling, not growth over a baseline.
 * Measured (2026-10-23): over 837 real PDFs a child's peak resident size was far below it (see the figures in CLAUDE.md), and the hostile
 * reproductions that go through external memory grew a process by 750 MB to 1.8 GB within a second or two. The ceiling is conservative because
 * the function has 2 GB and Chromium may be resident beside the parent (a bomb plus Chromium with three heavy pages peaked at a 1.3 GB cgroup
 * when the kill landed at +730 MB). The heap flag aborts a JS-heap bomb on its own at about 600 MB resident, so this is for external memory.
 * Polled every `intervalMs` (Linux: /proc, microseconds) or `psIntervalMs` (elsewhere: spawns `ps`, so coarser; macOS is a development machine,
 * production is Linux).
 */
export const PDF_MEMORY_WATCH = {
  intervalMs: 100,
  psIntervalMs: 500,
  ceilingBytes: 700 * MB,
} as const;

/** What one child returns of a PDF's text. Far above anything used (the injection scan reads 400,000 characters, the budget 60,000). */
const MAX_PAGE_CHARS = 400_000;
const MAX_TOTAL_CHARS = 1_200_000;
/** The parent never accumulates more of the child's stdout than this (1.2M characters of text is at most ~7 MB as escaped JSON); a child that writes more is killed. */
export const PDF_MAX_OUTPUT_BYTES = 16 * MB;
/** stderr is kept only to recognise a heap abort and the ready marker; the rest is discarded as it arrives (the pipe must still be drained). */
const MAX_STDERR_BYTES = 64 * 1024;

export interface PdfPage { num: number; text: string }

/** A hyperlink annotation of a PDF page: where it points, and the words it covers (trimmed, at most 80 characters; '' when none). */
export interface PdfLink { url: string; text: string }

/** Link annotations returned for one file, at most. A real resume has a handful; a file with thousands is built to be big (the answer is one stdout line). */
export const PDF_MAX_LINKS = 500;
/** The longest destination kept; a longer one is cut (it would not be a link anyone follows, and the line the child writes stays small). */
export const PDF_MAX_LINK_CHARS = 2048;

export type PdfReadResult =
  /**
   * The parser opened the file: its page count, whether it is locked, and the text of the first `maxPages` pages. With `withLinks`, also its link
   * annotations (`links`, in page order) — or `linksFailed: true` when the text was read but the annotations could not be (never a verdict that the
   * file has no links).
   */
  | { kind: 'read'; total: number; encrypted: boolean; pages: PdfPage[]; links?: PdfLink[]; linksFailed?: boolean }
  /** The parser threw while reading THIS file. The caller classifies it (a password, our own load failure, a bad file). */
  | { kind: 'parser-error'; name: string; message: string; code?: string }
  /** Killed at the deadline. `limitedBy` says whether that was the per-PDF cap or the item's own (shared) deadline. */
  | { kind: 'timeout'; limitedBy: 'pdf' | 'item' }
  /** Killed or died while parsing: out of heap, out of resident memory, or the process ended without an answer. */
  | { kind: 'too-complex'; cause: 'heap' | 'memory' | 'crash' }
  /** OUR side: the child could not be started, or failed before the parser was even constructed. Never a verdict on the file. */
  | { kind: 'unavailable'; message: string };

/** The child's resident size in bytes, or null when it cannot be read (the process is gone, or this platform has no way). May be async. */
export type RssProbe = (pid: number) => number | null | Promise<number | null>;

export interface PdfReadOptions {
  /** Most pages whose text is wanted (the first N). */
  maxPages: number;
  /** Also return the file's link annotations (pdfjs's per-page parse: a little more work, in the same child and under the same limits). Default false. */
  withLinks?: boolean;
  /** Epoch ms of the item's deadline. Past it, no child is started. */
  deadline: number;
  /** The per-PDF cap. Default PDF_PARSE_MS. */
  capMs?: number;
  /** Test seams. */
  parserModule?: string;
  /** The program to run (default: the node that is running this). */
  execPath?: string;
  /** The child's `--max-old-space-size`, in MB. Default PDF_CHILD_HEAP_MB. */
  heapMb?: number;
  memory?: { probe?: RssProbe; intervalMs?: number; ceilingBytes?: number };
  /** How much stdout the parent accepts from the child before killing it. Default PDF_MAX_OUTPUT_BYTES. */
  maxOutputBytes?: number;
}

/** The seam preparePdf reads through (so its classification logic can be tested without a process). */
export type PdfReader = (bytes: Buffer, options: PdfReadOptions) => Promise<PdfReadResult>;

// ─── the child's script ──────────────────────────────────────────────────────

// pdf-parse v2 wraps pdfjs-dist, which expects the browser globals DOMMatrix / ImageData / Path2D. On Vercel the optional native
// package that normally supplies them (@napi-rs/canvas) does not reliably make it into the bundle, and pdfjs then crashes at
// module load, so — exactly like driveService.ts, which this child must not import because it drags googleapis — dependency-free
// stand-ins are installed first, inside the child. DOMMatrix needs real 2D affine math (it positions glyphs, which decides the
// text we extract); ImageData and Path2D only matter for canvas rendering we never do. Plain JS in a string (no TypeScript, no
// backslashes, no backticks): it runs under tsx, vitest and the compiled bundle alike, and is evaluated by the unit tests.
export const PDF_GLOBALS_SOURCE = `
class DOMMatrixPolyfill {
  constructor(init) {
    if (Array.isArray(init) && init.length >= 6) {
      this.a = init[0]; this.b = init[1]; this.c = init[2]; this.d = init[3]; this.e = init[4]; this.f = init[5];
    } else if (init && typeof init === 'object') {
      this.a = init.a; this.b = init.b; this.c = init.c; this.d = init.d; this.e = init.e; this.f = init.f;
    } else {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
    }
  }
  multiply(o) {
    return new DOMMatrixPolyfill([
      this.a * o.a + this.c * o.b, this.b * o.a + this.d * o.b,
      this.a * o.c + this.c * o.d, this.b * o.c + this.d * o.d,
      this.a * o.e + this.c * o.f + this.e, this.b * o.e + this.d * o.f + this.f,
    ]);
  }
  assign(m) { this.a = m.a; this.b = m.b; this.c = m.c; this.d = m.d; this.e = m.e; this.f = m.f; return this; }
  multiplySelf(o) { return this.assign(this.multiply(o)); }
  preMultiplySelf(o) { return this.assign(o.multiply(this)); }
  translate(tx, ty) { return this.multiply(new DOMMatrixPolyfill([1, 0, 0, 1, tx, ty])); }
  scale(sx, sy) { return this.multiply(new DOMMatrixPolyfill([sx, 0, 0, sy === undefined ? sx : sy, 0, 0])); }
  invertSelf() {
    const det = this.a * this.d - this.b * this.c;
    const a = this.a, b = this.b, c = this.c, d = this.d, e = this.e, f = this.f;
    this.a = d / det; this.b = -b / det; this.c = -c / det; this.d = a / det;
    this.e = (c * f - d * e) / det; this.f = (b * e - a * f) / det;
    return this;
  }
  setTransform(o) { return this.assign(o); }
}
class Path2DPolyfill {
  constructor() {}
  addPath() {} moveTo() {} lineTo() {} closePath() {} rect() {}
  bezierCurveTo() {} quadraticCurveTo() {} arc() {} arcTo() {} ellipse() {}
}
class ImageDataPolyfill {
  constructor(dataOrWidth, widthOrHeight, height) {
    if (dataOrWidth instanceof Uint8ClampedArray) {
      this.data = dataOrWidth; this.width = widthOrHeight; this.height = height;
    } else {
      this.width = dataOrWidth; this.height = widthOrHeight;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    }
  }
}
/** Installs what pdfjs needs on g, once. Prefers the real native ones when loadNative() returns them. */
function installPdfGlobals(g, loadNative) {
  if (g.DOMMatrix && g.Path2D && g.ImageData) return;
  let native = null;
  try { native = loadNative(); } catch (e) { native = null; }
  if (!g.DOMMatrix) g.DOMMatrix = (native && native.DOMMatrix) || DOMMatrixPolyfill;
  if (!g.Path2D) g.Path2D = (native && native.Path2D) || Path2DPolyfill;
  if (!g.ImageData) g.ImageData = (native && native.ImageData) || ImageDataPolyfill;
}
`;

// The child's own deadman switch. The parent kills the child at a deadline and on its own exit, but neither survives the parent's death by a
// SIGNAL: a default-disposition SIGTERM does not run 'exit' handlers and SIGKILL cannot (the OOM killer sends it), and the child had no
// deadline of its own, so an orphan kept a core at 100% for as long as its parse took (four of them were found 13 hours old). The main
// thread of a child busy in pdfjs cannot run a timer, so the watch is a WORKER THREAD inside the child: it polls the parent (the pid in
// argv is the parent that started this child; once process.ppid is any other pid the parent is gone) and ends the whole process with
// SIGKILL when the parent has gone or when the hard cap (argv: the parent's own timeout plus CHILD_HARD_CAP_SLACK_MS) has passed. The
// worker is unref'd and the child leaves through process.exit, so it neither keeps a finished child alive nor delays its exit; it writes
// nothing to stdout or stderr, so the answer protocol is untouched. Failing to start it is not a reason to fail the parse. Inline, like the
// rest of the script: no extra file for a tracer to find. (Plain JS, no backslash or backtick: see PDF_CHILD_SOURCE.)
export const PDF_WATCHDOG_SOURCE = `
(function startWatchdog() {
  try {
    const { Worker } = require('worker_threads');
    const hardCapMs = Number(process.argv[5]) > 0 ? Number(process.argv[5]) : ${PDF_PARSE_MS + CHILD_HARD_CAP_SLACK_MS};
    const parentPid = Number(process.argv[6]) > 0 ? Number(process.argv[6]) : process.ppid;
    const code = "const { workerData } = require('worker_threads'); "
      + "const die = () => process.kill(process.pid, 'SIGKILL'); "
      + "setInterval(() => { if (process.ppid !== workerData.parentPid) die(); }, ${CHILD_PARENT_POLL_MS}); "
      + "setTimeout(die, workerData.hardCapMs);";
    // stdout/stderr: true keeps the worker's streams out of this process's: without it the Worker constructor touches process.stdout and process.stderr,
    // which turns fds 1 and 2 into non-blocking pipes, and the synchronous write of the ready mark below could then fail with EAGAIN under a full pipe.
    const watchdog = new Worker(code, { eval: true, stdout: true, stderr: true, workerData: { parentPid, hardCapMs } });
    watchdog.on('error', () => {});
    watchdog.unref();
  } catch (e) { /* no watchdog: the parent's deadline and exit hook still apply */ }
})();
`;

/** Written to the child's stderr, synchronously, once the parser object exists: "a failure after this is about the FILE". */
const READY_MARK = '@@pdf-sandbox-ready@@';
/** Precedes the one JSON document on stdout, so a stray write from a dependency before it cannot be mistaken for the answer. */
const RESULT_MARK = '@@pdf-sandbox-result@@';

// The child reads the PDF from stdin, then runs. argv (after the script): [pdf-parse entry, maxPages, maxPageChars, maxTotalChars, hardCapMs, parentPid,
// withLinks ('1' to also return the link annotations; absent = no)] (hardCapMs and parentPid are for the watchdog above).
// Every outcome is ONE line: RESULT_MARK + JSON + a line break, then process.exit once it is flushed (pdfjs leaves handles open). A throw
// before the parser exists is {phase:'load'} (ours); after it, {phase:'parse'} (the file's).
const PDF_CHILD_MAIN_SOURCE = `
const fs = require('fs');
const READY_MARK = ${JSON.stringify(READY_MARK)};
const RESULT_MARK = ${JSON.stringify(RESULT_MARK)};
const NL = String.fromCharCode(10);
const entry = process.argv[1];
const maxPages = Number(process.argv[2]);
const maxPageChars = Number(process.argv[3]);
const maxTotalChars = Number(process.argv[4]);
const withLinks = process.argv[7] === '1';
const MAX_LINKS = ${PDF_MAX_LINKS};
const MAX_LINK_CHARS = ${PDF_MAX_LINK_CHARS};
// pdfjs logs a warning for every oddity; a hostile file can make that millions of lines.
for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = () => {};

let phase = 'load';
let finished = false;
const describe = (e) => ({
  name: String((e && e.name) || 'Error').slice(0, 80),
  message: String((e && e.message) || e).slice(0, 500),
  code: e && typeof e.code === 'string' ? e.code.slice(0, 80) : undefined,
});
const finish = (message) => {
  if (finished) return;
  finished = true;
  let line;
  try { line = JSON.stringify(message); } catch (e) { line = JSON.stringify({ type: 'error', phase, error: describe(e) }); }
  process.stdout.write(RESULT_MARK + line + NL, () => process.exit(0));
};
const fail = (e) => finish({ type: 'error', phase, error: describe(e) });
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const capPages = (pages) => {
  let left = maxTotalChars;
  return pages.map((p) => {
    const text = typeof p.text === 'string' ? p.text.slice(0, Math.max(0, Math.min(maxPageChars, left))) : '';
    left -= text.length;
    return { num: Number(p.num), text };
  });
};

// The link annotations pdfjs found, page by page: url and the words the link covers (what the portfolio picker reads as its label).
const collectLinks = (meta) => {
  const out = [];
  const pages = (meta && meta.pages) || [];
  for (const page of pages) {
    const found = (page && page.links) || [];
    for (const l of found) {
      if (out.length >= MAX_LINKS) return out;
      if (!l || typeof l.url !== 'string' || !l.url) continue;
      out.push({ url: l.url.slice(0, MAX_LINK_CHARS), text: typeof l.text === 'string' ? l.text.trim().slice(0, 80) : '' });
    }
  }
  return out;
};

async function run(bytes) {
  try {
    installPdfGlobals(globalThis, () => require('@napi-rs/canvas'));
    const { PDFParse } = require(entry);
    const parser = new PDFParse({ data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), verbosity: 0 });
    phase = 'parse';
    try { fs.writeSync(2, READY_MARK + NL); } catch (e) { /* the parent has gone */ }
    let meta = null;
    let links;
    let linksFailed = false;
    if (withLinks) {
      try {
        meta = await parser.getInfo({ parsePageInfo: true });
        links = collectLinks(meta);
      } catch (e) {
        // The text may still be readable. Say that the annotations were not (our doubt about THIS read), never that the file has no links.
        linksFailed = true;
        links = undefined;
        meta = null;
      }
    }
    if (!meta) meta = await parser.getInfo();
    const total = meta && meta.total;
    // pdfjs reports permission flags only for an encrypted document, so this is "opened without a password, but locked".
    const encrypted = Array.isArray(meta && meta.permission);
    let pages = [];
    if (Number.isInteger(total) && total >= 1) {
      const result = await parser.getText({ first: Math.min(total, maxPages) });
      pages = result.pages && result.pages.length ? result.pages : [{ num: 1, text: result.text || '' }];
    }
    finish({ type: 'read', total, encrypted, pages: capPages(pages), links, linksFailed: linksFailed || undefined });
  } catch (e) {
    fail(e);
  }
}

const chunks = [];
let received = 0;
process.stdin.on('data', (c) => { chunks.push(c); received += c.length; });
process.stdin.on('error', fail);
process.stdin.on('end', () => { run(Buffer.concat(chunks, received)); });
`;

/** The whole child script (also what the unit tests read to prove it parses and what it installs). */
export const PDF_CHILD_SOURCE = `'use strict';${PDF_WATCHDOG_SOURCE}${PDF_GLOBALS_SOURCE}${PDF_CHILD_MAIN_SOURCE}`;

// ─── the resident-size probe ─────────────────────────────────────────────────

/**
 * The child's resident size. Linux: VmRSS from /proc/<pid>/status (in kB, so page-size independent). Read ASYNCHRONOUSLY: a procfs read of a
 * process that is being torn down, or is thrashing, can wait on the kernel, and that wait must be a thread-pool thread's, never this one's
 * (the poll already skips a tick while one is in flight, so at most one thread is ever tied up). Elsewhere (macOS, a development machine):
 * `ps -o rss=`, also asynchronous, which is why its interval is coarser. null when it cannot be read: the deadline and the heap flag still apply.
 */
export const childResidentBytes: RssProbe = async (pid) => {
  if (process.platform === 'linux') {
    try {
      const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(await fs.promises.readFile(`/proc/${pid}/status`, 'latin1'));
      return m ? Number(m[1]) * 1024 : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') return null;
  return new Promise<number | null>(resolve => {
    try {
      execFile('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { env: {}, timeout: 1500, windowsHide: true }, (err, stdout) => {
        const kb = err ? NaN : Number.parseInt(String(stdout).trim(), 10);
        resolve(Number.isFinite(kb) ? kb * 1024 : null);
      });
    } catch {
      resolve(null);
    }
  });
};

// ─── the entry point ─────────────────────────────────────────────────────────

/**
 * The absolute path of pdf-parse's CommonJS entry, resolved HERE so the child (whose own require() is relative to nothing) loads exactly the
 * copy this bundle ships. pdf-parse's package.json maps "require" to dist/pdf-parse/cjs/index.cjs; that file imports its sibling
 * pdf.worker.mjs relative to itself.
 */
export function pdfParseEntry(): string {
  if (typeof require === 'function') return require.resolve('pdf-parse');
  return createRequire(__filename).resolve('pdf-parse');
}

/** Our own failure to start the PDF reader (a module or its worker file missing), as opposed to a bad file. */
const LOAD_FAILURE_RE = /fake worker|cannot find module|cannot find package|is not a function|ERR_MODULE|ERR_REQUIRE_ESM|ERR_UNKNOWN_FILE_EXTENSION/i;
/** Whether a 'parser-error' is OUR load failure (e.g. "Setting up fake worker failed": pdf.worker.mjs is not in the bundle) rather than something about the file. */
export function isLoadFailure(e: { message?: unknown; code?: unknown }): boolean {
  const { message, code } = e;
  return code === 'MODULE_NOT_FOUND' || (typeof code === 'string' && /^ERR_(?:MODULE|REQUIRE|IMPORT|UNKNOWN_FILE)/.test(code)) || (typeof message === 'string' && LOAD_FAILURE_RE.test(message));
}

/** Whether a 'parser-error' is pdfjs asking for a password. */
export function isPasswordError(e: { name?: unknown; message?: unknown }): boolean {
  return e.name === 'PasswordException' || (typeof e.message === 'string' && /password/i.test(e.message));
}

const HEAP_RE = /heap out of memory|Reached heap limit|JavaScript heap|invalid (?:array|typed array) length/i;
const NATIVE_OOM_RE = /bad_alloc|Cannot allocate memory|ENOMEM|out of memory|Array buffer allocation failed/i;

/** Children that are running now: killed if this process exits first, so a PDF never outlives the review that asked for it. */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;
/** Kills every child that is running (what this process's exit does). Exported for the tests. */
export function killLiveSandboxChildren(): void {
  for (const child of live) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', killLiveSandboxChildren);
}

interface Started { result: Promise<PdfReadResult>; exited: Promise<void> }

/** The child's answer, from its whole stdout; null when there is none (nothing written, cut off, or not what the child writes). */
function parseAnswer(stdout: Buffer): { type?: string; phase?: string; total?: number; encrypted?: boolean; pages?: PdfPage[]; links?: unknown; linksFailed?: boolean; error?: { name: string; message: string; code?: string } } | null {
  const text = stdout.toString('utf8');
  const at = text.indexOf(RESULT_MARK);
  if (at < 0) return null;
  const end = text.indexOf('\n', at);
  if (end < 0) return null;   // the line was cut off: killed in the middle of writing it
  try {
    const answer = JSON.parse(text.slice(at + RESULT_MARK.length, end));
    return answer && typeof answer === 'object' ? answer : null;
  } catch {
    return null;
  }
}

/** The child is not trusted either: keep only well-formed entries, bounded again here (the parent never relies on the child's own caps for what it hands on). */
function cleanLinks(raw: unknown[]): PdfLink[] {
  const out: PdfLink[] = [];
  for (const l of raw) {
    if (out.length >= PDF_MAX_LINKS) break;
    const url = (l as { url?: unknown } | null)?.url;
    if (typeof url !== 'string' || !url) continue;
    const text = (l as { text?: unknown }).text;
    out.push({ url: url.slice(0, PDF_MAX_LINK_CHARS), text: typeof text === 'string' ? text.slice(0, 80) : '' });
  }
  return out;
}

function start(bytes: Buffer, o: PdfReadOptions, queuedAt: number): Started {
  const cap = o.capMs ?? PDF_PARSE_MS;
  const left = o.deadline - Date.now();
  const noChild = (result: PdfReadResult): Started => ({ result: Promise.resolve(result), exited: Promise.resolve() });
  // An item whose own deadline has already passed was abandoned by its caller: do not spend a process on it.
  if (left <= 0) {
    // Its deadline passed WHILE IT WAITED for its turn (it had time when it was queued): the file was never looked at, and what ate its time was the
    // files ahead of it, not anything about it. That is OUR congestion, not a verdict on the file: 'unavailable', so the review retries instead of
    // neutrally dropping a candidate's work sample because somebody else's hostile PDF was in front (three 12 s PDFs ahead made six of seven
    // ordinary decks "took too long to read"). One that was already past its deadline when it arrived keeps the neutral timeout.
    if (o.deadline > queuedAt) return noChild({ kind: 'unavailable', message: 'The PDF reader was busy with other files until this one ran out of time' });
    return noChild({ kind: 'timeout', limitedBy: 'item' });
  }
  const timeoutMs = Math.max(MIN_PARSE_MS, Math.min(cap, left));
  const limitedBy = left < cap ? 'item' : 'pdf';
  const maxOutput = o.maxOutputBytes ?? PDF_MAX_OUTPUT_BYTES;

  const probe = o.memory?.probe ?? childResidentBytes;
  const ceiling = o.memory?.ceilingBytes ?? PDF_MEMORY_WATCH.ceilingBytes;
  const intervalMs = o.memory?.intervalMs ?? (process.platform === 'linux' ? PDF_MEMORY_WATCH.intervalMs : PDF_MEMORY_WATCH.psIntervalMs);

  let child: ChildProcess;
  try {
    child = spawn(
      o.execPath ?? process.execPath,
      // Nothing of the parent's: no execArgv (under tsx that is a loader), no NODE_OPTIONS, no environment at all (no secrets), no shell.
      [`--max-old-space-size=${o.heapMb ?? PDF_CHILD_HEAP_MB}`, '-e', PDF_CHILD_SOURCE, o.parserModule ?? pdfParseEntry(), String(o.maxPages), String(MAX_PAGE_CHARS), String(MAX_TOTAL_CHARS), String(timeoutMs + CHILD_HARD_CAP_SLACK_MS), String(process.pid), o.withLinks ? '1' : '0'],
      { env: {}, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true },
    );
  } catch (e) {
    return noChild({ kind: 'unavailable', message: String((e as Error)?.message ?? e).slice(0, 200) });
  }
  child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void } | null)?.unref?.();
  live.add(child);
  installExitHook();

  let finish!: (r: PdfReadResult) => void;
  let markExited!: () => void;
  const result = new Promise<PdfReadResult>(resolve => { finish = resolve; });
  const exited = new Promise<void>(resolve => { markExited = resolve; });
  let settled = false;
  let ready = false;
  let gone = false;
  let graceTimer: NodeJS.Timeout | undefined;
  let probing = false;
  const outChunks: Buffer[] = [];
  let outBytes = 0;
  let errText = '';

  const stopTimers = () => { clearTimeout(deadlineTimer); clearInterval(memoryTimer); };
  const settle = (r: PdfReadResult) => {
    if (settled) return;
    settled = true;
    stopTimers();
    finish(r);
    if (gone) return;
    // Never awaited: a child stuck in uninterruptible I/O cannot block the review. The next PDF waits for it only briefly.
    graceTimer = setTimeout(markExited, EXIT_GRACE_MS);
    graceTimer.unref();
    try { child.kill('SIGKILL'); } catch { /* it is already gone */ }
  };

  const deadlineTimer = setTimeout(() => settle({ kind: 'timeout', limitedBy }), timeoutMs);
  const memoryTimer = setInterval(() => {
    if (probing || settled || child.pid === undefined) return;
    probing = true;
    void Promise.resolve()
      .then(() => probe(child.pid as number))
      .then(rss => { if (typeof rss === 'number' && rss > ceiling) settle({ kind: 'too-complex', cause: 'memory' }); }, () => { /* an unreadable size is not a verdict */ })
      .finally(() => { probing = false; });
  }, intervalMs);

  // stdin: the PDF, then end. EPIPE (the child died before reading it all) is the child's story, told by its exit. None of the three pipes may
  // throw on this thread: an 'error' event nobody listens to is an uncaught exception, and a killed child is ordinary here.
  for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.on('error', () => { /* the exit tells the story */ });
  child.stdin?.end(bytes);

  child.stdout?.on('data', (chunk: Buffer) => {
    if (settled) return;
    outBytes += chunk.length;
    if (outBytes > maxOutput) { settle({ kind: 'too-complex', cause: 'crash' }); return; }   // writes more than any answer is long: not a parser we trust
    outChunks.push(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (errText.length < MAX_STDERR_BYTES) errText += chunk.toString('latin1', 0, MAX_STDERR_BYTES - errText.length);   // the rest is read and dropped
    if (!ready && errText.includes(READY_MARK)) ready = true;
  });
  // Kept attached for the child's whole life: an 'error' event nobody listens to would be thrown on this thread. Only a failure to spawn
  // reaches here before a verdict (a kill that fails comes after one).
  child.on('error', (e: Error) => {
    // A program that never started has no 'exit' to wait for (and nothing to release): the next PDF need not wait out the grace period.
    if (child.pid === undefined) { gone = true; live.delete(child); markExited(); }
    settle({ kind: 'unavailable', message: String(e?.message ?? e).slice(0, 200) });
  });
  child.on('exit', () => {
    gone = true;
    live.delete(child);
    clearTimeout(graceTimer);
    markExited();
  });
  // 'close' comes after 'exit' AND after stdout/stderr have ended, so everything the child wrote is in hand.
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    gone = true;
    live.delete(child);
    if (settled) return;
    const answer = parseAnswer(Buffer.concat(outChunks, outBytes));
    if (answer?.type === 'read') {
      return settle({
        kind: 'read', total: answer.total as number, encrypted: answer.encrypted === true, pages: Array.isArray(answer.pages) ? answer.pages : [],
        ...(o.withLinks && Array.isArray(answer.links) ? { links: cleanLinks(answer.links) } : {}),
        ...(o.withLinks && answer.linksFailed === true ? { linksFailed: true } : {}),
      });
    }
    if (answer?.type === 'error') {
      const e = answer.error ?? { name: 'Error', message: '' };
      // Before the parser was even constructed, the failure is in what WE load (a missing module), never in the file.
      return settle(answer.phase === 'parse' ? { kind: 'parser-error', name: e.name, message: e.message, code: e.code } : { kind: 'unavailable', message: e.message });
    }
    // No answer. If the parser had not been constructed the child never got going (ours); otherwise the PDF took it down.
    if (!ready) return settle({ kind: 'unavailable', message: `The PDF reader exited before it started (${signal ?? `code ${code}`})` });
    if (signal === 'SIGKILL') return settle({ kind: 'too-complex', cause: 'memory' });   // not ours (we settle before we kill): the OS's out-of-memory killer
    if (HEAP_RE.test(errText)) return settle({ kind: 'too-complex', cause: 'heap' });
    if (NATIVE_OOM_RE.test(errText)) return settle({ kind: 'too-complex', cause: 'memory' });
    settle({ kind: 'too-complex', cause: 'crash' });
  });
  return { result, exited };
}

/** One PDF at a time per process: the next waits for the previous child to be gone (or for a short grace period, never longer). */
let tail: Promise<void> = Promise.resolve();

/**
 * Reads one PDF (page count, lock state and the text of the first `maxPages` pages) in a killable child process. Never rejects.
 * See the notes at the top of this file for what each result kind means.
 */
export const readPdfInSandbox: PdfReader = (bytes, options) => {
  const queuedAt = Date.now();
  const job = tail.then(() => start(bytes, options, queuedAt));
  tail = job.then(s => s.exited, () => undefined);
  return job.then(s => s.result, e => ({ kind: 'unavailable', message: String((e as Error)?.message ?? e).slice(0, 200) }) as PdfReadResult);
};
