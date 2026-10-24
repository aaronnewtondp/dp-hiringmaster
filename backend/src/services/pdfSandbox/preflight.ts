// SHARED (the main API and the worker both import this; it imports nothing of the portfolio review, Chromium or HMS). A bounded, deterministic look at ONE
// candidate-supplied PDF before any parser sees it: pdfjs inflates a stream with no cap and has no sense of how much work a file asks of it, so the
// file is read here first, by code whose every step has an allowance, and a file that cannot be bounded is refused ("too complex") instead of being
// handed over. It is the CHEAP first line; sandbox.ts (a killable child process) is what makes a file this could not recognise harmless.
//
// Two callers: the marketing work-sample review (portfolio/acquire/pdf.ts, which re-exports all of this under its old names) and resume parsing for every
// role (pdfSandbox/resume.ts, used by driveService.ts on the main API function). Moved here from acquire/pdf.ts on 2026-10-23 so the main API can use it without
// importing anything under acquire/ (see "Import boundary" in CLAUDE.md); the code is otherwise unchanged except for the `export` keywords the content scan
// that stayed in pdf.ts needs.
import { performance } from 'perf_hooks';
import { constants, inflateRawSync } from 'zlib';

// ─── a bounded look at every stream, BEFORE pdfjs sees the file ──────────────

// pdfjs inflates a Flate stream with no cap: a ~1 MB PDF whose content stream inflates to 1 GB took ~40 s and peaked above
// 2.4 GB. So the file is looked at first, here, by code whose every step is bounded, and a file that cannot be bounded is never
// handed to the parser. This is the cheap first line, not the only one: pdfSandbox.ts runs whatever gets past it in a child process that
// is killed at a deadline or when memory balloons, which is why the checks below only need to catch what is OBVIOUS.
//
// The look itself runs on THIS thread, so its cost is bounded too, in two ways. (1) Every loop whose length the file decides has an
// allowance (the `Allowance` objects below, charged in bytes handled by JavaScript): a file that spends it is refused as "too complex",
// and the verdict never depends on the clock. (2) Both passes are written as generators that yield between streams, and preparePdf drives
// them with `runCooperatively`, which hands the event loop back every PDF_SLICE_MS: a legitimate but heavy file (the injection scan alone
// is 200-450 ms of regex work on a text-heavy deck) no longer stalls the deadline timers and the resident-size watchdog that share this
// thread. preflightPdf() and scanPdfContentStreams() are the same code run straight through, for callers that want a plain answer.
/** What one stream may inflate to, and what all of a file's streams may inflate to in total. */
export const MAX_STREAM_INFLATED = 24 * 1024 * 1024;
export const MAX_TOTAL_INFLATED = 64 * 1024 * 1024;
// Pictures get their own, larger allowance. pdfjs never decodes an image to extract text, and the scanned or lossless-image
// PDFs this review is FOR inflate to tens of megabytes (2 of 550 real PDFs sampled passed 64 MB of page images; a pitch deck
// at 53 MB came close). The same picture budget still caps what a stream mislabelled as an image could make pdfjs do.
export const MAX_IMAGE_STREAM_INFLATED = 48 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_INFLATED = 128 * 1024 * 1024;
/** Streams looked at in one file. Real decks have hundreds; a file of tens of thousands is built to be slow. */
export const MAX_PDF_STREAMS = 20_000;
/** Object streams (compressed groups of objects pdfjs unpacks on open). Real files have a few dozen at most. */
export const MAX_OBJECT_STREAMS = 500;
/**
 * Occurrences of the word "stream" (the keyword and every "endstream" alike) a file may hold. Counted natively and up front, so a file made
 * of nothing but the word is refused before any per-keyword work is done (each keyword that is not a stream start costs a look back at
 * what precedes it, and 8 MB of "q stream q stream" took 5 s). Measured on 819 real PDFs: p99 1,452, max 6,014; a file at MAX_PDF_STREAMS
 * has twice that many.
 */
export const MAX_STREAM_WORDS = 80_000;
/** "/Encrypt" occurrences that are looked at (each one that is not a reference is skipped). Real files have at most 3. */
const MAX_ENCRYPT_WORDS = 2_000;
/** "/MediaBox" occurrences that are looked at. Real files: max 311 of 819. */
const MAX_MEDIA_BOXES = 20_000;
/** Whitespace tolerated between "/MediaBox" and its "[" before the file is called implausible (the old regex had no limit). */
const MEDIA_BOX_BLANKS = 1_024;
/**
 * Text read to learn what a stream's dictionary says, summed over the file. A stream's dictionary is the text back to its own "N G obj", so
 * it is as long as the dictionary really is, and real dictionaries do not overlap (their total is at most the file's size). It is only
 * longer when a hostile file puts thousands of stream keywords after ONE obj header (each then re-reads up to 64 KB, and the regexes run
 * over every copy). The allowance is the size of the largest file the review opens; the real maximum among 819 PDFs was 261 KB.
 */
export const MAX_DICTIONARY_TEXT = 8 * 1024 * 1024;
/** Bytes of ToUnicode / CID range sections walked by JavaScript in one pre-flight (the sections of the file itself and of every inflated stream). Real maximum among 819 PDFs: 34 KB. */
export const MAX_CMAP_WALK = 4 * 1024 * 1024;
/** How far back from a stream keyword its dictionary is looked for (the stream's own "N G obj" header ends the search sooner). Real Form XObjects carry dictionaries of up to ~48 KB (inline resources). */
const DICTIONARY_WINDOW = 64 * 1024;
/** Flate layers followed inside one stream. A real file has one (a second is rare); more is built to be slow. */
export const MAX_FLATE_LAYERS = 4;
/**
 * Pixels a picture codec's own header may declare. A content stream patched to be a 65000 x 65000 JPEG made pdfjs allocate 1.5 GB
 * and run 10 s. The biggest real picture among 820 PDFs sampled is far smaller (a 600 dpi A4 scan is 35 million).
 */
export const MAX_CODEC_PIXELS = 100_000_000;
/**
 * Codes the ToUnicode / CID range maps of one file may expand to, in total. One full <0000> <FFFF> range is 65,536 and a Type0
 * font with an identity map carries one; 800 fonts that each carry one cost pdfjs 5 s and 2.5 GB, 3000 aborted node.
 */
export const MAX_CMAP_CELLS = 8_000_000;
// Counts of things that are only worth refusing when absurd. Measured on the 820 real PDFs on this machine: fonts p99 46, max 766;
// form XObjects p99 86, max 1152 (16 files had more than 50, 36 more than 20), so "about 200 fonts / about 50 forms" would have
// refused real files and still missed the form bomb, which needs only ~25 forms (each calls the next twice). The sandbox is what
// stops that one; these only cut the cheapest wide variants off before a process is started.
export const MAX_FONT_DICTS = 1500;
export const MAX_FORM_XOBJECTS = 2500;
/** A /MediaBox side, in points, past which no page is a page (the largest PDF viewers accept is 14,400). */
export const MAX_PAGE_UNITS = 200_000;
// Filters whose output size cannot be bounded cheaply: LZW and run-length expand without a practical limit, and a JBIG2 "page"
// can declare gigabytes. A file that names one anywhere near a stream is not opened.
const UNBOUNDED_FILTER_RE = /\/(?:LZWDecode|LZW|RunLengthDecode|JBIG2Decode)(?![A-Za-z0-9])/;
const ASCII85_NAME_RE = /\/(?:ASCII85Decode|A85)(?![A-Za-z0-9])/;
const ASCIIHEX_NAME_RE = /\/(?:ASCIIHexDecode|AHx)(?![A-Za-z0-9])/;
const FLATE_NAME_RE = /\/(?:FlateDecode|Fl)(?![A-Za-z0-9])/g;
const CODEC_NAME_RE = /\/(?:DCTDecode|DCT|JPXDecode|CCITTFaxDecode|CCF)(?![A-Za-z0-9])/;
const DCT_NAME_RE = /\/(?:DCTDecode|DCT)(?![A-Za-z0-9])/;
const JPX_NAME_RE = /\/JPXDecode(?![A-Za-z0-9])/;
const IMAGE_SUBTYPE_RE = /\/Subtype\s*\/Image(?![A-Za-z0-9])/;
const IMAGE_WIDTH_RE = /\/Width[\s\0]+\d/;
const FONT_DICT_RE = /\/Type[\s\0]*\/Font(?![A-Za-z0-9])/g;
const FORM_XOBJECT_RE = /\/Subtype[\s\0]*\/Form(?![A-Za-z0-9])/g;
// A direct "/Length 1234" (not "/Length 12 0 R", not "/Length1"). Dictionaries that give two are ambiguous and not trusted.
const DIRECT_LENGTH_RE = /\/Length[\s\0]+(\d{1,10})(?![\d.])(?![\s\0]+\d+[\s\0]+R(?![A-Za-z0-9]))/g;
/**
 * Bytes the ASCII85/ASCIIHex decoders may read in all in the pre-flight (a file of overlapping streams would otherwise make each decode
 * re-read the rest of the file). Real streams do not overlap, so their total is at most the file's size (8 MB at most; the real maximum
 * among 819 PDFs was 86 KB).
 */
const MAX_DECODE_WORK = 8 * 1024 * 1024;
/** A picture codec's header is read from at most this many bytes of the stream. */
const CODEC_HEAD_BYTES = 64 * 1024;
const NAME_ESCAPE_RE = /#([0-9A-Fa-f]{2})/g;
/** A PDF name may spell any character as #xx ("/LZW#44ecode" is "/LZWDecode"); undo that before looking for a filter by name. */
const unescapeNames = (text: string) => (text.includes('#') ? text.replace(NAME_ESCAPE_RE, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))) : text);
export const STREAM_NEEDLE = Buffer.from('stream');
const ENDSTREAM_NEEDLE = Buffer.from('endstream');
const OBJ_NEEDLE = Buffer.from('obj');
const OBJSTM_NEEDLE = Buffer.from('/ObjStm');
const ENCRYPT_NEEDLE = Buffer.from('/Encrypt');
const MEDIA_BOX_NEEDLE = Buffer.from('/MediaBox');
export const BT_NEEDLE = Buffer.from('BT');

export type PdfPreflight = { ok: true; streams: number; inflated: number } | { ok: false; why: 'encrypted' | 'complex' };

/** What a pass spent, for the tests and for calibrating the allowances against real files. Pass an object to preflightPdf / scanPdfContentStreams to have it filled in. */
export interface PdfWorkTally {
  streamWords?: number;
  dictionaryText?: number;
  cmapWalk?: number;
  decodeWork?: number;
  scanWork?: number;
  /** Why the content scan could not vouch for the file (the first reason), when it could not. */
  incompleteBecause?: string;
}

/**
 * A deterministic allowance of work for one pass over a candidate file, in bytes handled by JavaScript. `spend` says whether there was
 * enough left. It counts work, never time, so a verdict is the same on a slow machine and a busy one.
 */
export class Allowance {
  constructor(readonly total: number, public left: number = total) {}
  spend(n: number): boolean { this.left -= n; return this.left >= 0; }
  get spent(): number { return this.total - this.left; }
}

// ─── cooperative scheduling ──────────────────────────────────────────────────

/** A pass as a generator: each `yield` is a safe place for the event loop to run. */
export type PdfSteps<T> = Generator<void, T, void>;
type Steps<T> = PdfSteps<T>;

export function runStraight<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** The longest stretch of one pass that runs without giving the event loop a turn, give or take one step (a stream). */
export const PDF_SLICE_MS = 20;

/** A cooperative pass was stopped because the deadline it was given passed: its caller had already given up on it (see runCooperatively). */
export class PassAbandonedError extends Error {
  constructor() {
    super('the pass was abandoned: its deadline passed');
    this.name = 'PassAbandonedError';
  }
}

/**
 * Runs a pass to the end on this thread, but lets the event loop run whenever a slice has lasted PDF_SLICE_MS. Which yields happen never changes the answer.
 * `until` (epoch ms, normally the item's deadline) ends a pass that is still running when it passes: the orchestrator abandons a document that overruns
 * its time (it cannot cancel it), and a pass nobody is waiting for must not keep burning this thread's CPU on, say, thousands of overlapping streams. The
 * check is made at the first slice boundary after the deadline (the event loop has just had its turn, so the timers that fired are what set `until`), the
 * generator is closed there, and the promise rejects with PassAbandonedError. A pass that finishes inside one slice never reaches the check: the answer
 * for an ordinary file does not depend on the clock.
 */
export async function runCooperatively<T>(steps: Steps<T>, sliceMs = PDF_SLICE_MS, until?: number): Promise<T> {
  let sliceStart = performance.now();
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() - sliceStart >= sliceMs) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (until !== undefined && Date.now() >= until) {
        steps.return(undefined as never);
        throw new PassAbandonedError();
      }
      sliceStart = performance.now();
    }
  }
}

/** True for 0x30-0x39 (a digit) or '<': what follows "/Encrypt" in a real trailer ("/Encrypt 12 0 R" or "/Encrypt <<"). */
const startsReference = (c: number | undefined) => c !== undefined && ((c >= 0x30 && c <= 0x39) || c === 0x3c);
const isWhite = (c: number | undefined) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
/** ( ) < > [ ] { } / % — the characters that end a PDF token without whitespace. */
const isDelimiter = (c: number | undefined) => c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const isRegular = (c: number | undefined) => c !== undefined && !isWhite(c) && !isDelimiter(c);

/**
 * Whether the trailer (or cross-reference stream) names an encryption dictionary: 'declared'. Every stream of such a file is
 * ciphertext, so nothing about it can be bounded here; "/EncryptMetadata" and prose that merely contains the word do not count.
 * 'implausible' = more than MAX_ENCRYPT_WORDS occurrences and none of them a reference (real files have at most 3).
 */
export function encryptionOf(bytes: Buffer): 'declared' | 'none' | 'implausible' {
  let at = 0;
  for (let n = 0; ; n++) {
    const i = bytes.indexOf(ENCRYPT_NEEDLE, at);
    if (i < 0) return 'none';
    if (n >= MAX_ENCRYPT_WORDS) return 'implausible';
    let j = i + 8;
    while (isWhite(bytes[j])) j++;
    if (startsReference(bytes[j])) return 'declared';
    at = i + 8;
  }
}

export function countOf(bytes: Buffer, needle: string | Buffer, limit: number): number {
  let n = 0;
  let at = 0;
  const length = typeof needle === 'string' ? Buffer.byteLength(needle) : needle.length;
  while (n < limit) {
    const i = bytes.indexOf(needle, at);
    if (i < 0) break;
    n++;
    at = i + length;
  }
  return n;
}

/** How many times `re` (a /g pattern) matches `text`, counting no further than `limit`. */
function countMatches(text: string, re: RegExp, limit: number): number {
  const scan = new RegExp(re.source, 'g');
  let n = 0;
  while (n < limit && scan.exec(text)) n++;
  return n;
}

/** What [\s\0] matched in the latin1 text the first version ran its regex over: JavaScript's \s (which reaches 0xA0 and the vertical tab) and NUL. */
const isMediaBlank = (c: number | undefined) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x0b || c === 0xa0 || c === 0x00;

/**
 * 'absurd' when a /MediaBox declares a page side nobody has printed (pdfjs lays out text against it); 'implausible' when the file has
 * more than MAX_MEDIA_BOXES of them or thousands of blanks between the key and its bracket; else 'ok'. Written as native searches over a
 * bounded window, one occurrence at a time: the regex it replaces (`/MediaBox[\s\0]*\[([^\]]{1,120})\]`) backtracks up to 120 characters
 * on every occurrence that has no closing bracket, and 8 MB of "/MediaBox [" cost it 190 ms in a single call.
 */
export function mediaBoxVerdict(bytes: Buffer): 'ok' | 'absurd' | 'implausible' {
  let at = 0;
  for (let n = 0; ; n++) {
    const i = bytes.indexOf(MEDIA_BOX_NEEDLE, at);
    if (i < 0) return 'ok';
    if (n >= MAX_MEDIA_BOXES) return 'implausible';
    at = i + MEDIA_BOX_NEEDLE.length;
    let p = at;
    const blanksEnd = Math.min(bytes.length, at + MEDIA_BOX_BLANKS + 1);
    while (p < blanksEnd && isMediaBlank(bytes[p])) p++;
    if (p - at > MEDIA_BOX_BLANKS) return 'implausible';
    if (bytes[p] !== 0x5b) continue;
    const inside = bytes.subarray(p + 1, Math.min(bytes.length, p + 122));
    const close = inside.indexOf(0x5d);
    if (close < 1 || close > 120) continue;            // the first version needed 1-120 characters before the "]"
    for (const token of inside.toString('latin1', 0, close).split(/[\s\0]+/)) {
      const v = Number(token);
      if (token !== '' && Number.isFinite(v) && Math.abs(v) > MAX_PAGE_UNITS) return 'absurd';
    }
  }
}

/** The two-byte zlib header pdfjs requires of a FlateDecode stream (compression method 8, a valid check value, no preset dictionary). */
export function hasZlibHeader(bytes: Buffer): boolean {
  if (bytes.length < 2) return false;
  const cmf = bytes[0];
  const flg = bytes[1];
  return (cmf & 0x0f) === 8 && (cmf >> 4) <= 7 && ((cmf << 8) + flg) % 31 === 0 && (flg & 0x20) === 0;
}

/** The number a stream's dictionary claims as its /Length, only when it gives exactly one direct one; otherwise null. */
function claimedLength(dictionary: string): number | null {
  let length: number | null = null;
  for (const m of dictionary.matchAll(DIRECT_LENGTH_RE)) {
    if (length !== null) return null;
    length = Number(m[1]);
  }
  return length;
}

/**
 * The byte length a stream's dictionary declares, but only when pdfjs will certainly honour it: exactly one direct
 * "/Length N" in the dictionary and the keyword "endstream" right after those N bytes. (pdfjs trusts a validated /Length and
 * scans for "endstream" only when it is wrong; an "endstream" planted INSIDE the data is therefore ignored by pdfjs, and
 * must be by this check too.) null = ambiguous: the caller then reads to the end of the file, which can only over-count.
 */
export function validatedLength(bytes: Buffer, start: number, dictionary: string): number | null {
  const length = claimedLength(dictionary);
  if (length === null || start + length > bytes.length) return null;
  return bytes.toString('latin1', start + length, start + length + 16).trimStart().startsWith('endstream') ? length : null;
}

/**
 * Where the next "endstream" at or after a position is. Streams are visited in file order, so the answer for one stream is usually the
 * answer for the next: each search resumes where the last one ended, and a file with no "endstream" left is searched once, not once per
 * stream (a file of thousands of stream keywords and no "endstream" read the whole rest of the file for each).
 */
export class EndstreamFinder {
  private at = -1;
  private from = 0;
  private none = false;
  constructor(private readonly bytes: Buffer) {}
  /** The offset of the next "endstream" at or after `from`, or -1. `from` must not go backwards between calls. */
  next(from: number): number {
    if (from < this.from) { this.at = -1; this.none = false; }
    this.from = from;
    if (this.none) return -1;
    if (this.at >= from) return this.at;
    const i = this.bytes.indexOf(ENDSTREAM_NEEDLE, from);
    if (i < 0) { this.none = true; return -1; }
    this.at = i;
    return i;
  }
}

// ─── where pdfjs finds a stream ──────────────────────────────────────────────

/**
 * Most bytes after the keyword "stream" that may pass before the line break pdfjs skips to. A real file has the break right there
 * (the spec allows CRLF or LF; some writers add a space first). pdfjs itself would skip ANY amount of junk, so a file that needs more
 * than this is refused rather than guessed about.
 */
const STREAM_EOL_WINDOW = 512;
/** How far back from "stream" the whitespace and comments before it are walked to see whether a dictionary ends there. */
const BEFORE_STREAM_WINDOW = 4096;

/** A place pdfjs may begin a stream's data. `start` is the first byte of the data, or -1 when no line break follows within the window. */
export interface StreamAt { keyword: number; start: number }

/**
 * True when what comes before the "stream" at `keyword` could be the end of a dictionary: the previous non-blank character is the
 * '>' of ">>". pdfjs reads a stream only straight after a dictionary (whitespace and %-comments between are allowed), so prose
 * that merely contains the word "stream" is not a stream. Anything this cannot decide (a comment in the way, an enormous run of
 * blanks) counts as "could be", because a superset of pdfjs's streams is safe and a subset is not.
 * The blanks are walked in JavaScript (their runs are disjoint, so all of them together are at most the file's size); the start of the
 * line and the look for a '%' on it are native searches: a JavaScript walk back to the line start cost 4,096 steps for EVERY keyword on a
 * single 8 MB line.
 */
function followsDictionary(bytes: Buffer, keyword: number): boolean {
  const floor = Math.max(0, keyword - BEFORE_STREAM_WINDOW);
  let p = keyword - 1;
  while (p >= floor && isWhite(bytes[p])) p--;
  if (p < floor) return true;                                  // nothing but blanks for 4 KB: do not guess
  if (bytes[p] === 0x3e) return true;                          // ">>"
  const window = bytes.subarray(floor, p + 1);
  const lineStart = Math.max(window.lastIndexOf(0x0a), window.lastIndexOf(0x0d)) + 1;   // 0 when the window holds no line break
  return window.indexOf(0x25, lineStart) >= 0;                 // a %-comment line: pdfjs skips those, so a dictionary may sit above it
}

/**
 * The next "stream" token at or after `from` that pdfjs could treat as a stream start, with where its data begins. pdfjs takes
 * the keyword as ANY "stream" token that follows a dictionary and skips from it to the next LF or CR, so "stream   \n" and
 * "stream junk\n" are streams as much as "stream\n" is (the first version of this scan skipped them, which hid a 1 GB bomb and an
 * injected instruction from every check). A "stream" inside another word ("endstream", "mainstream", "streams") is not the token.
 * Callers have counted the word first (MAX_STREAM_WORDS), so the number of iterations here is bounded.
 */
export function nextStream(bytes: Buffer, from: number): StreamAt | null {
  let at = from;
  for (;;) {
    const keyword = bytes.indexOf(STREAM_NEEDLE, at);
    if (keyword < 0) return null;
    at = keyword + 6;
    if (isRegular(bytes[keyword - 1]) || isRegular(bytes[keyword + 6])) continue;
    if (!followsDictionary(bytes, keyword)) continue;
    const limit = Math.min(bytes.length, keyword + 6 + STREAM_EOL_WINDOW);
    const tail = bytes.subarray(keyword + 6, limit);
    const lf = tail.indexOf(0x0a);
    const cr = tail.indexOf(0x0d);
    const found = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
    if (found < 0) return keyword + 6 + tail.length >= bytes.length ? { keyword, start: bytes.length } : { keyword, start: -1 };   // the file ends inside the keyword's line: no data at all / no break in the window
    const p = keyword + 6 + found;
    return { keyword, start: bytes[p] === 0x0d && bytes[p + 1] === 0x0a ? p + 2 : p + 1 };
  }
}

/** The last "obj" before a keyword, found incrementally: streams come in file order, so only the bytes since the previous keyword are searched. */
export interface ObjMemo { keyword: number; obj: number }

/** The text of the dictionary in front of a stream keyword, and whether the stream's own "N G obj" header was found (so it is exactly that object's). */
export function streamDictionary(bytes: Buffer, keyword: number, memo?: ObjMemo): { text: string; own: boolean } {
  const lo = Math.max(0, keyword - DICTIONARY_WINDOW);
  let obj = -1;
  if (memo && memo.keyword >= lo && memo.keyword <= keyword) {
    // The last obj in [lo, keyword) is the last one since the previous keyword, else the one found for the previous keyword if it is still in the window.
    const i = bytes.subarray(memo.keyword, keyword).lastIndexOf(OBJ_NEEDLE);
    obj = i >= 0 ? memo.keyword + i : memo.obj >= lo ? memo.obj : -1;
  } else {
    const i = bytes.subarray(lo, keyword).lastIndexOf(OBJ_NEEDLE);
    obj = i >= 0 ? lo + i : -1;
  }
  if (memo) { memo.keyword = keyword; memo.obj = obj; }
  if (obj >= 0) return { text: unescapeNames(bytes.toString('latin1', obj + 3, keyword)), own: true };
  return { text: unescapeNames(bytes.toString('latin1', Math.max(lo, keyword - 4096), keyword)), own: false };
}

/** ASCIIHexDecode as pdfjs reads it: digit pairs, whitespace skipped, '>' ends the data, a lone last digit is padded with 0. */
export function decodeAsciiHex(bytes: Buffer, from: number, to: number, max: number): Buffer | null {
  const out = Buffer.allocUnsafe(Math.min(max, Math.ceil((to - from) / 2) + 1));   // every byte is written before it is read
  let n = 0;
  let high = -1;
  for (let i = from; i < to; i++) {
    const c = bytes[i];
    if (c === 0x3e) break;
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
    if (v < 0) continue;
    if (high < 0) { high = v; continue; }
    if (n >= out.length) return null;
    out[n++] = (high << 4) | v;
    high = -1;
  }
  if (high >= 0 && n < out.length) out[n++] = high << 4;
  return out.subarray(0, n);
}

/**
 * ASCII85Decode as pdfjs reads it: whitespace skipped, 'z' is four zero bytes, '~' ends the data, a short last group is padded
 * with 'u'. Returns null when the output would pass `max` (a run of 'z' is 4:1, so this is a real bound, not a formality).
 */
export function decodeAscii85(bytes: Buffer, from: number, to: number, max: number): Buffer | null {
  const eod = bytes.subarray(from, to).indexOf(0x7e);                              // the data ends at its own '~', searched within the span only:
  if (eod >= 0) to = from + eod;                                                    // an unbounded search read to the end of the FILE for every stream
  const out = Buffer.allocUnsafe(Math.min(max, (to - from) * 4 + 8));              // not zero-filled: 'z' writes its own zeros
  let n = 0;
  let group = 0;
  let count = 0;
  for (let i = from; i < to; i++) {
    const c = bytes[i];
    if (c === 0x7e) break;
    if (isWhite(c)) continue;
    if (c === 0x7a && count === 0) {
      if (n + 4 > out.length) return null;
      out[n] = 0; out[n + 1] = 0; out[n + 2] = 0; out[n + 3] = 0;   // four stores, not out.fill(): a native call per 'z' made 7 MB of them cost 400 ms
      n += 4;
      continue;
    }
    group = group * 85 + (c - 0x21);
    if (++count === 5) {
      if (n + 4 > out.length) return null;
      out.writeUInt32BE(group >>> 0, n);
      n += 4;
      group = 0;
      count = 0;
    }
  }
  if (count > 1) {
    for (let k = count; k < 5; k++) group = group * 85 + 84;
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(group >>> 0, 0);
    if (n + count - 1 > out.length) return null;
    tail.copy(out, n, 0, count - 1);
    n += count - 1;
  }
  return out.subarray(0, n);
}

// ─── codecs and CMaps: what a size check cannot see ──────────────────────────

/** Height x width of a JPEG, read from its first frame header (SOF); null when there is none in the part given. */
export function jpegPixels(b: Buffer): number | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  for (let n = 0; n < 256 && p + 4 <= b.length; n++) {
    if (b[p] !== 0xff) { p++; continue; }
    const marker = b[p + 1];
    if (marker === 0xff) { p++; continue; }                                                     // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }   // markers that carry no length
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return p + 9 <= b.length ? b.readUInt16BE(p + 5) * b.readUInt16BE(p + 7) : null;
    }
    if (marker === 0xda) return null;                                                          // image data before any frame header
    p += 2 + b.readUInt16BE(p + 2);
  }
  return null;
}

/** Width x height of a JPEG 2000 image, read from its codestream's SIZ marker (inside a JP2 wrapper or bare); null when absent. */
export function jpxPixels(b: Buffer): number | null {
  const at = b.indexOf(Buffer.from([0xff, 0x4f, 0xff, 0x51]));
  return at >= 0 && at + 16 <= b.length ? b.readUInt32BE(at + 8) * b.readUInt32BE(at + 12) : null;
}

/** Pixels a stream's own picture header declares, for a stream the dictionary says is a DCT or JPX picture; null when unknown. */
function codecPixels(dictionary: string, data: Buffer): number | null {
  const head = data.length > CODEC_HEAD_BYTES ? data.subarray(0, CODEC_HEAD_BYTES) : data;
  if (DCT_NAME_RE.test(dictionary)) return jpegPixels(head);
  if (JPX_NAME_RE.test(dictionary)) return jpxPixels(head);
  return null;
}

const hexValue = (c: number) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1);
const CMAP_SECTIONS: ReadonlyArray<readonly [Buffer, Buffer]> = [[Buffer.from('beginbfrange'), Buffer.from('endbfrange')], [Buffer.from('begincidrange'), Buffer.from('endcidrange')]];
const MAX_CMAP_TOKENS = 400_000;
const MAX_CMAP_SECTION_BYTES = 1024 * 1024;
/** A section is charged at least this much, so a file of thousands of empty ones is not free. */
const CMAP_SECTION_MIN_CHARGE = 64;

/** The cells one bfrange / cidrange section expands to: each (low, high, destination) triple maps high - low + 1 codes. */
function cmapSectionCells(data: Buffer, from: number, stop: number): number {
  let cells = 0;
  let low = 0;
  let position = 0;      // 0 = low, 1 = high, 2 = destination
  let tokens = 0;
  let i = from;
  while (i < stop && tokens < MAX_CMAP_TOKENS) {
    const c = data[i];
    let token: number | null = null;
    if (c === 0x3c) {                                  // <hex>: the first 8 digits (the codespace is at most 4 bytes)
      let value = 0;
      let digits = 0;
      i++;
      while (i < stop && data[i] !== 0x3e) {
        const d = hexValue(data[i]);
        if (d >= 0 && digits < 8) { value = value * 16 + d; digits++; }
        i++;
      }
      i++;
      token = value;
    } else if (c === 0x5b) {                           // [ <dst> <dst> ... ]: one destination token, however long
      const close = data.subarray(i + 1, stop).indexOf(0x5d);
      i = close < 0 ? stop : i + 1 + close + 1;
      token = 0;
    } else if (c >= 0x30 && c <= 0x39) {               // a decimal (the first CID of a cidrange)
      while (i < stop && data[i] >= 0x30 && data[i] <= 0x39) i++;
      token = 0;
    } else {
      i++;
    }
    if (token === null) continue;
    tokens++;
    if (position === 0) low = token;
    else if (position === 1) cells += Math.max(0, token - low + 1);
    position = (position + 1) % 3;
  }
  return cells;
}

/**
 * How many codes the bfrange / cidrange sections in `data` expand to. pdfjs builds a table entry for every code of a range
 * (up to 16 million per range), so a handful of ranges of "<0000> <FFFF>" on hundreds of fonts is a bomb that is only a few
 * hundred KB on the wire and whose stream sizes (tiny) say nothing. Linear: each section is read once and bounded.
 * `walk`, when given, is the allowance for the bytes the sections make JavaScript read (several MB of deflated "bfrange <0000> <0001>"
 * sections cost 28 ms of walking each); running out of it reports MAX_CMAP_CELLS + 1, which the pre-flight refuses.
 */
export function cmapRangeCells(data: Buffer, walk?: Allowance): number {
  let cells = 0;
  for (const [begin, end] of CMAP_SECTIONS) {
    let at = 0;
    for (;;) {
      const from = data.indexOf(begin, at);
      if (from < 0) break;
      const bodyStart = from + begin.length;
      let stop = data.indexOf(end, bodyStart);
      if (stop < 0 || stop - bodyStart > MAX_CMAP_SECTION_BYTES) stop = Math.min(data.length, bodyStart + MAX_CMAP_SECTION_BYTES);
      if (walk && !walk.spend(Math.max(stop - bodyStart, CMAP_SECTION_MIN_CHARGE))) return MAX_CMAP_CELLS + 1;
      cells += cmapSectionCells(data, bodyStart, stop);
      if (cells > MAX_CMAP_CELLS) return cells;
      at = stop + 1;
    }
  }
  return cells;
}

/**
 * Decides whether pdfjs may be given this file. Every place a stream could begin (see nextStream: the keyword "stream" after a
 * dictionary, whatever follows it on the line; nested or overlapping objects are not skipped) is looked at, and none of it
 * trusts the file's own dictionary for the one thing that matters, whether the data is Flate:
 *  - a stream that starts with a valid zlib header is inflated and its output counted: capped per stream
 *    (MAX_STREAM_INFLATED) and in total (MAX_TOTAL_INFLATED). A stream the dictionary calls an image has its own, larger caps
 *    (MAX_IMAGE_*), since pdfjs never decodes pictures to read text. A pdfjs decode of the same bytes cannot produce more
 *    than this. Any overflow, and any stream that will not inflate, is refused: an error is not something to guess about,
 *    since pdfjs is more lenient than zlib and could carry on past the point where zlib stops. The one exception is a stream whose
 *    OWN dictionary names no filter at all (and no indirect chain): pdfjs reads it as it is, so bytes that merely begin like zlib are
 *    not Flate and the failure to inflate them is not about this file.
 *  - the output is looked at again: when it is itself a zlib stream (/Filter [/FlateDecode /FlateDecode]: a 3 KB file whose
 *    inner layer inflated to 600 MB inside pdfjs, uncapped) it is inflated under the same caps, up to MAX_FLATE_LAYERS deep. A
 *    dictionary that names Flate more than once while fewer layers could be verified is refused.
 *  - the span inflated is the stream's own: its validated /Length (see validatedLength), exactly as pdfjs reads it. Flate
 *    streams that simply stop without a final block (Acrobat and Aspose write those) then inflate as far as they go.
 *    Without a validated /Length the input runs to the end of the file and must end cleanly on its own.
 *  - ASCII85 and ASCIIHex are decoded first (bounded) and the result is checked for a zlib header too, so the very common
 *    "[/ASCII85Decode /FlateDecode]" chain is bounded like any other Flate stream rather than refused.
 *  - a dictionary (best effort, the bytes back to its "N G obj", #xx name escapes undone) that names LZW, run-length or JBIG2
 *    is refused: those cannot be bounded this way;
 *  - a picture codec (DCT, JPX, CCITT) on a stream that is not a picture is page content pdfjs would DECODE: refused. Any DCT or
 *    JPX stream whose own header declares more than MAX_CODEC_PIXELS is refused whatever its dictionary claims;
 *  - the ToUnicode / CID range maps (compressed or not) may expand to at most MAX_CMAP_CELLS codes in total;
 *  - absurd counts (MAX_FONT_DICTS fonts, MAX_FORM_XOBJECTS forms) and a /MediaBox side past MAX_PAGE_UNITS are refused (a /Length
 *    larger than the whole file is NOT a reason: 8 of 820 real PDFs have one, a producer bug, and pdfjs just scans for "endstream");
 *  - an encrypted file is refused up front ('encrypted'), since its streams are ciphertext;
 *  - more than MAX_PDF_STREAMS streams, MAX_STREAM_WORDS occurrences of the word "stream", or MAX_OBJECT_STREAMS object streams, and a
 *    stream keyword with no line break within STREAM_EOL_WINDOW bytes (pdfjs would skip any amount of junk), is refused;
 *  - the work itself is bounded (see the top of this section): the dictionary text read, the bytes the text decoders read and the bytes
 *    of CMap sections walked each have an allowance, and a file that spends one is refused.
 * Anything refused is reported as 'complex' (or 'encrypted'); the caller never gives such a file to pdfjs. Not a proof: names
 * can still be spelled in ways a window-and-regex check misses, which is why every inflate above is capped anyway and why the
 * parser runs in a killable child process regardless.
 */
export function* preflightSteps(bytes: Buffer, tally?: PdfWorkTally): Steps<PdfPreflight> {
  const complex = { ok: false, why: 'complex' } as const;
  const encryption = encryptionOf(bytes);
  if (encryption === 'declared') return { ok: false, why: 'encrypted' };
  if (encryption === 'implausible') return complex;
  if (countOf(bytes, OBJSTM_NEEDLE, MAX_OBJECT_STREAMS + 1) > MAX_OBJECT_STREAMS) return complex;
  const words = countOf(bytes, STREAM_NEEDLE, MAX_STREAM_WORDS + 1);
  if (tally) tally.streamWords = words;
  if (words > MAX_STREAM_WORDS) return complex;
  yield;
  {
    const raw = bytes.toString('latin1');
    if (countMatches(raw, FONT_DICT_RE, MAX_FONT_DICTS + 1) > MAX_FONT_DICTS) return complex;
    if (countMatches(raw, FORM_XOBJECT_RE, MAX_FORM_XOBJECTS + 1) > MAX_FORM_XOBJECTS) return complex;
  }
  yield;
  if (mediaBoxVerdict(bytes) !== 'ok') return complex;
  const cmapWalk = new Allowance(MAX_CMAP_WALK);
  const dictionaryText = new Allowance(MAX_DICTIONARY_TEXT);
  const decodeWork = new Allowance(MAX_DECODE_WORK);
  const report = () => { if (tally) { tally.cmapWalk = cmapWalk.spent; tally.dictionaryText = dictionaryText.spent; tally.decodeWork = decodeWork.spent; } };
  let cells = cmapRangeCells(bytes, cmapWalk);   // the CMaps that are not compressed
  if (cells > MAX_CMAP_CELLS) { report(); return complex; }
  yield;

  let streams = 0;
  let inflated = 0;
  let imageInflated = 0;
  let decoded = 0;
  const memo: ObjMemo = { keyword: -1, obj: -1 };
  const endstreams = new EndstreamFinder(bytes);
  for (let found = nextStream(bytes, 0); found; found = nextStream(bytes, found.keyword + 6)) {
    const { keyword, start } = found;
    if (start < 0) { report(); return complex; }
    if (++streams > MAX_PDF_STREAMS) { report(); return complex; }

    const { text: dictionary, own } = streamDictionary(bytes, keyword, memo);
    if (!dictionaryText.spend(dictionary.length)) { report(); return complex; }
    if (UNBOUNDED_FILTER_RE.test(dictionary)) { report(); return complex; }

    const isImage = IMAGE_SUBTYPE_RE.test(dictionary);
    const streamCap = isImage ? MAX_IMAGE_STREAM_INFLATED : MAX_STREAM_INFLATED;
    const length = validatedLength(bytes, start, dictionary);
    const named = own ? countMatches(dictionary, FLATE_NAME_RE, MAX_FLATE_LAYERS + 1) : 0;

    // The payloads that could be Flate: the data as it is, and (when the dictionary names a text filter) its decoding.
    // Raw data runs to the end of the file when /Length cannot be trusted: zlib stops at the stream's own end, so that costs
    // only what the stream holds.
    const raw0 = bytes.subarray(start, length === null ? bytes.length : start + length);
    const payloads: Array<{ data: Buffer; tolerant: boolean; text: boolean }> = [{ data: raw0, tolerant: length !== null, text: false }];
    for (const [named85, decode] of [[ASCII85_NAME_RE, decodeAscii85], [ASCIIHEX_NAME_RE, decodeAsciiHex]] as const) {
      if (!named85.test(dictionary)) continue;
      // A text filter has no end of its own the way a zlib stream has, so it stops where pdfjs would stop reading: at the
      // validated /Length, or else at the first "endstream" (what pdfjs scans for when /Length is wrong).
      let stop = start + (length ?? 0);
      if (length === null) {
        stop = endstreams.next(start);
        if (stop < 0) stop = bytes.length;
      }
      if (!decodeWork.spend(stop - start)) { report(); return complex; }
      const text = decode(bytes, start, stop, streamCap);
      decoded += text?.length ?? 0;
      if (text === null || decoded > MAX_TOTAL_INFLATED) { report(); return complex; }   // decoded text counts too: a file of 'z' runs is a bomb of its own
      payloads.push({ data: text, tolerant: true, text: true });
    }

    let deepest = 0;
    for (const payload of payloads) {
      if (payload.text && payload.data.length <= MAX_CMAP_SECTION_BYTES * 4) cells += cmapRangeCells(payload.data, cmapWalk);
      let layer = payload.data;
      let lenient = payload.tolerant;
      for (let depth = 0; hasZlibHeader(layer); depth++) {
        if (depth >= MAX_FLATE_LAYERS) { report(); return complex; }
        let out: Buffer;
        try {
          out = inflateRawSync(layer.subarray(2), { maxOutputLength: streamCap, ...(lenient ? { finishFlush: constants.Z_SYNC_FLUSH } : {}) });
        } catch (e) {
          // The first layer, one the dictionary names, and any that overflowed the cap are refused. A deeper one that merely
          // fails is already-decoded content that happens to start like zlib (about 1 byte in 2000 of picture data does): pdfjs
          // would not decode it again. The same goes for a first layer on a stream whose own dictionary names no filter.
          if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') { report(); return complex; }
          // (A dictionary that gives its filter chain only by reference, "/Filter 12 0 R", says nothing about which filters there are.)
          if (depth === 0 && !(own && named === 0 && !INDIRECT_CHAIN_RE.test(dictionary))) { report(); return complex; }
          if (depth > 0 && depth < named) { report(); return complex; }
          break;
        }
        if (isImage) imageInflated += out.length;
        else inflated += out.length;
        if (inflated > MAX_TOTAL_INFLATED || imageInflated > MAX_IMAGE_TOTAL_INFLATED) { report(); return complex; }
        if (!isImage && out.length <= MAX_CMAP_SECTION_BYTES * 4) cells += cmapRangeCells(out, cmapWalk);
        if (cells > MAX_CMAP_CELLS) { report(); return complex; }
        if (CODEC_NAME_RE.test(dictionary) && (codecPixels(dictionary, out) ?? 0) > MAX_CODEC_PIXELS) { report(); return complex; }
        deepest = Math.max(deepest, depth + 1);
        layer = out;
        lenient = true;
      }
    }
    if (named >= 2 && deepest < named) { report(); return complex; }   // names more Flate layers than could be inflated and bounded

    if (CODEC_NAME_RE.test(dictionary)) {
      if ((codecPixels(dictionary, raw0) ?? 0) > MAX_CODEC_PIXELS) { report(); return complex; }
      // A picture codec on something that is not a picture (no /Subtype /Image, no /Width) is page content pdfjs would decode.
      if (!isImage && !IMAGE_WIDTH_RE.test(dictionary)) { report(); return complex; }
    }
    yield;
  }
  report();
  return { ok: true, streams, inflated: inflated + imageInflated };
}

/** The pre-flight, run straight through (see preflightSteps). Synchronous: the caller that must not stall its event loop uses preflightPdfAsync. */
export function preflightPdf(bytes: Buffer, tally?: PdfWorkTally): PdfPreflight {
  return runStraight(preflightSteps(bytes, tally));
}

/** The same pre-flight, handing the event loop back every PDF_SLICE_MS. What preparePdf uses. `until`: see runCooperatively. */
export function preflightPdfAsync(bytes: Buffer, tally?: PdfWorkTally, until?: number): Promise<PdfPreflight> {
  return runCooperatively(preflightSteps(bytes, tally), PDF_SLICE_MS, until);
}

// "/Filter 12 0 R": the chain lives in another object this scan does not resolve (2 of 820 real PDFs have one on a page content stream).
export const INDIRECT_CHAIN_RE = /\/(?:Filter|DecodeParms)[\s\0]+\d+[\s\0]+\d+[\s\0]+R(?![A-Za-z0-9])/;
