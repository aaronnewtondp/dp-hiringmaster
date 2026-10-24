// WORKER-ONLY (see ../browser.ts). Validates and reads one PDF for the marketing work-sample review. A PDF is
// untrusted input twice over: it goes to a parser WE run, and (when small enough) straight to the model as a native
// document block. So it is checked locally first — one corrupt or password-protected file would otherwise fail the
// whole model call — and its text layer, which the model also sees, is scanned for wording aimed at an AI reviewer.
//
// The parser (pdfjs, via pdf-parse) never runs in this process: services/pdfSandbox/sandbox.ts runs it in a child process that is killed at a hard
// deadline or when memory balloons (a thread could not contain a single huge allocation, which aborts the whole process). The
// pre-flight (services/pdfSandbox/preflight.ts, re-exported from this file) is the cheap first line (it refuses what it can recognise without
// starting a process); the sandbox is what makes a file it could not recognise harmless. Both are shared with resume parsing on the main API.
//
// This file also holds the few helpers every document fetcher shares (reasons, text cleaning, the injection scan,
// budgeted text, a step timeout), so office.ts, google.ts and documents.ts can stay small.
import { constants, inflateSync } from 'zlib';
import { findInjection, stripInvisible } from '../injection.js';
import { hasReadableText, wellFormed } from '../text.js';
import { BUDGET } from './budget.js';
import { PDF_PARSE_MS, isLoadFailure, isPasswordError, readPdfInSandbox } from '../../pdfSandbox/sandbox.js';
import type { PdfReadOptions, PdfReadResult, PdfReader } from '../../pdfSandbox/sandbox.js';
import type { AcquireContext, Acquired, MediaBlock } from './types.js';

/** What a document fetcher produces for one file, before documents.ts attaches the link's ref and basis. */
export type Prepared = Pick<Acquired, 'outcome' | 'reason' | 'media' | 'text' | 'facts' | 'injectionHit' | 'pagesReviewed' | 'pageTitles'>;

export const INJECTION_REASON = 'Contains text addressed to an AI reviewer - routed to a human';
export const SIZE_LIMIT_REASON = 'File is larger than the size limit - not opened';
export const BUDGET_REASON = 'The size limit for this review was reached before this file could be opened';
const NOT_A_PDF_REASON = 'This file could not be read as a PDF';
const PASSWORDED_REASON = 'The PDF is password-protected or locked - ask the candidate for an unlocked copy';
const PDF_SLOW_REASON = 'This PDF took too long to read';
const NO_PAGES_REASON = 'The PDF has no pages';
export const TOO_COMPLEX_REASON = 'This PDF is too complex to open automatically';
/** OUR side: the PDF reader itself could not start (a missing module or worker file). Never a verdict on the file. */
export const PDF_READER_REASON = 'The PDF reader could not be started on our side - this will be retried';
/** Added to a PDF's facts when its extracted text was cut at the per-item cap. */
export const TEXT_SHORTENED_FACT = 'Extracted text shortened';

const PDF_MAGIC = '%PDF-';

export function unread(outcome: Acquired['outcome'], reason: string): Prepared {
  return { outcome, reason, media: [], text: '', facts: [], injectionHit: false };
}

/** The deterministic injection scan matched: nothing from this file reaches the model, and a human looks at it. */
export function injectionPrepared(): Prepared {
  return { outcome: 'unreviewable', reason: INJECTION_REASON, media: [], text: '', facts: [], injectionHit: true };
}

// ─── text helpers ────────────────────────────────────────────────────────────

// What counts as invisible (zero-width and bidi controls, soft hyphens, control characters, the Unicode "tag" block that some models read
// as instructions) is ONE definition, stripInvisible() in injection.ts: the scan must see exactly what the cleaned text will read.
const TAG_CHAR_RE = /[\u{e0020}-\u{e007e}]/gu;
// pdf-parse separates pages in its joined text with "-- 1 of 3 --" lines; they are noise, not content.
const PAGE_MARKER_RE = /^[ \t]*--[ \t]*\d+[ \t]+of[ \t]+\d+[ \t]*--[ \t]*$/gm;

/** Invisible "tag" characters decoded back to the ASCII they spell, so a smuggled instruction can be scanned. */
function hiddenTagText(text: string): string {
  let out = '';
  for (const m of text.matchAll(TAG_CHAR_RE)) out += String.fromCharCode(m[0].codePointAt(0)! - 0xe0000);
  return out;
}

/**
 * The injection scan for text extracted from a file: the visible words, plus anything hidden in invisible tag
 * characters. Returns the matched pattern name, or null. Run it on the RAW text, before cleanText() removes them.
 */
export function scanDocumentText(raw: string): string | null {
  return findInjection(raw) ?? findInjection(hiddenTagText(raw));
}

// The injection patterns are the single most expensive thing this module asks of its thread: ~1 microsecond per character on real,
// text-heavy PDFs (400,000 characters, the most injection.ts ever reads, took up to ~400 ms in ONE call, two such calls per file).
// scanTextSteps() runs the same scan over overlapping windows and gives the event loop a turn between them.
/** injection.ts reads no more than this many characters of what it is given (its MAX_SCAN_CHARS); the windowed scan covers the same ones, so it costs the same. */
const INJECTION_READS = 400_000;
/** One slice of the injection scan: characters. About 60-100 ms on real text. */
export const INJECTION_WINDOW = 64 * 1024;
/** How far each window reaches back into the previous one. Far longer than any phrase a pattern matches (a few hundred characters), so a match always lies whole inside some window. */
export const INJECTION_OVERLAP = 2 * 1024;
/** Put in front of a window that starts mid-text: a word no pattern treats as a lead-in, so the start of the window is not mistaken for the start of a sentence ("^" would match there and flag a phrase that the whole text has after "never"). */
const WINDOW_LEAD = 'zqxjv ';

/**
 * scanDocumentText over windows, yielding between them. A text of at most one window and its overlap is scanned exactly as scanDocumentText
 * does; a longer one in windows of INJECTION_WINDOW characters, each starting INJECTION_OVERLAP characters before its nominal start (moved to the next
 * blank, so no word is cut), and only its first INJECTION_READS characters, like injection.ts itself. Whether there is a hit is the same as for the
 * whole text; the NAME returned is that of the first window to have one (it can differ from the whole-text scan's pick only when attacks of
 * different kinds sit in different windows, and nothing but a log line reads it).
 */
export function* scanTextSteps(raw: string): Generator<void, string | null, void> {
  const text = raw.length > INJECTION_READS ? raw.slice(0, INJECTION_READS) : raw;
  if (text.length <= INJECTION_WINDOW + INJECTION_OVERLAP) return scanDocumentText(text);
  for (let nominal = 0; nominal < text.length; nominal += INJECTION_WINDOW) {
    let from = nominal === 0 ? 0 : nominal - INJECTION_OVERLAP;
    if (from > 0) {
      const blank = text.slice(from, from + 256).search(/\s/);
      if (blank >= 0) from += blank + 1;
    }
    const window = text.slice(from, Math.min(text.length, nominal + INJECTION_WINDOW + INJECTION_OVERLAP));
    const hit = scanDocumentText(from === 0 ? window : WINDOW_LEAD + window);
    if (hit !== null) return hit;
    yield;
  }
  // The windows read the first INJECTION_READS characters, as injection.ts does. scanDocumentText ALSO decodes the invisible "tag" characters of the WHOLE
  // text (a smuggled instruction can sit anywhere in a long document, and decoding them is one cheap pass), so a longer text gets that reading too: a
  // .docx can carry up to 2,000,000 characters, and the answer for it must be the plain scan's.
  return raw.length > INJECTION_READS ? findInjection(hiddenTagText(raw)) : null;
}

/** scanDocumentText that lets the event loop run between windows. For callers on a thread that other work depends on. `until`: see runCooperatively. */
export function scanDocumentTextCooperatively(raw: string, until?: number): Promise<string | null> {
  return runCooperatively(scanTextSteps(raw), PDF_SLICE_MS, until);
}

/** Extracted text made fit to store and to show a model: no control or invisible characters, tidy line breaks. */
export function cleanText(raw: string): string {
  return stripInvisible(raw)
    .replace(/\r\n?/g, '\n')
    .replace(PAGE_MARKER_RE, '')
    .split('\n').map(l => l.trimEnd()).join('\n')   // per line, not a /[ \t]+$/ pass: that one is quadratic on a long space run
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export { decodeEntities } from '../../boundedFiles/xml.js';

/** A short, markup-free string made from untrusted text (a file name, a title): safe in a facts line or a label. */
export function safeLabel(raw: string, max = 80): string {
  return wellFormed(stripInvisible(raw).replace(/[\u0000-\u001f\u007f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)).trim();
}

/**
 * Reserves room in the review's character budget for `text` and returns what fits. Synchronous, so two files read at
 * the same time can never both be granted the same characters.
 */
export function reserveText(text: string, ctx: AcquireContext): { text: string; truncated: boolean } {
  if (!text) return { text: '', truncated: false };
  const granted = ctx.budget.reserveChars(text.length);
  if (granted >= text.length) return { text, truncated: false };
  return { text: wellFormed(text.slice(0, granted)), truncated: true };
}

// ─── time ────────────────────────────────────────────────────────────────────

export class StepTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = 'StepTimeoutError';
  }
}

/** Rejects with StepTimeoutError if `p` takes longer than `ms`. The work itself cannot be cancelled, only abandoned. */
export function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StepTimeoutError(ms)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** How long a parsing step may run: at most `cap`, never past the item's deadline, never under a second. */
export function stepMs(ctx: AcquireContext, cap: number): number {
  return Math.max(1_000, Math.min(cap, ctx.deadline - Date.now()));
}

// The pre-flight (bounds, allowances, cooperative scheduling, the stream/dictionary readers) moved to pdfSandbox/preflight.ts so resume parsing on the main API can use it
// without importing anything under acquire/. Everything it exported is still exported from here, so nothing that imported it from this file changes.
import {
  Allowance, BT_NEEDLE, EndstreamFinder, INDIRECT_CHAIN_RE, MAX_DICTIONARY_TEXT, MAX_STREAM_INFLATED, MAX_STREAM_WORDS, MAX_TOTAL_INFLATED, PDF_SLICE_MS, PassAbandonedError, STREAM_NEEDLE,
  countOf, decodeAscii85, decodeAsciiHex, hasZlibHeader, nextStream, preflightPdfAsync, runCooperatively, runStraight, streamDictionary, validatedLength,
} from '../../pdfSandbox/preflight.js';
import type { ObjMemo, PdfSteps, PdfWorkTally } from '../../pdfSandbox/preflight.js';
export * from '../../pdfSandbox/preflight.js';
type Steps<T> = PdfSteps<T>;

// ─── text a parser does not return ───────────────────────────────────────────

// pdfjs (inside pdf-parse) leaves out text drawn outside the page area, so an instruction parked off the page never shows
// up in the extracted text — yet a PDF sent natively is read by the model's own extractor, which may keep it. So a
// PDF that will be sent natively is also scanned at the source: the strings in its page content streams.
const MAX_SCANNED_STREAMS = 4000;
/**
 * Content scanned per stream: what the pre-flight lets one stream inflate to (so a stream it passed is never "too big" here). It was 2 MB,
 * which sent 6 of 11 Figma exports and 1 of 16 Canva exports to text only: a vector page or a page of outlined text inflates past it.
 */
export const MAX_SCANNED_STREAM_BYTES = MAX_STREAM_INFLATED;
const MAX_SCANNED_CHARS = 400_000;
/**
 * The scan's allowance of work, in bytes handled by JavaScript: the input of the ASCII85 / ASCIIHex decoders and the characters
 * pdfTextStrings walks (a character of string content with escapes counts 9). A page of vector operators with some text on it costs about
 * its length; text-heavy streams stop at MAX_SCANNED_CHARS collected. Past it the scan stops vouching for the file instead of grinding on.
 * Measured on 819 real PDFs: p50 88,000, p99 4.7 million, max 10.4 million units (a unit is ~2.5 ns, so the allowance is ~80 ms of walking).
 */
export const MAX_SCAN_WORK = 32 * 1024 * 1024;
// Streams that are not page content: pictures, fonts, colour profiles, object/xref streams, metadata, attachments.
const NOT_CONTENT_RE = /\/Subtype\s*\/Image|\/Type\s*\/(?:ObjStm|XRef|Metadata|EmbeddedFile)|\/Length1|\/FontFile|\/ICCBased/;
/** What `\s` matched in the latin1 text of a dictionary. */
const isBlankCode = (c: number) => (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0xa0;
/** "/Filter" keys looked at in one dictionary, blanks tolerated between it and its value, and the longest array looked at: a real chain is two or three names. */
const MAX_FILTER_KEYS = 64;
const MAX_FILTER_BLANKS = 256;
const MAX_FILTER_ARRAY = 1024;

/**
 * The filter names a stream dictionary lists: those of the first "/Filter" that is followed (after blanks) by an array or by a name. It replaces
 * `/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/`, which was quadratic: a dictionary of an unclosed "/Filter [" repeated through its 60 KB made it run
 * to the end of the text from every one of them, 580 ms for ONE dictionary (and 36 s for a file of 120) in the content scan. Here every step is
 * bounded: 64 keys, 256 blanks, an array of at most 1,024 characters (one that is not closed within them does not count as a chain).
 */
export function filterNames(dictionary: string): string[] {
  let at = 0;
  for (let n = 0; n < MAX_FILTER_KEYS; n++) {
    const key = dictionary.indexOf('/Filter', at);
    if (key < 0) return [];
    at = key + 7;
    let p = at;
    while (p < dictionary.length && p - at <= MAX_FILTER_BLANKS && isBlankCode(dictionary.charCodeAt(p))) p++;
    const c = dictionary.charCodeAt(p);
    if (c === 0x5b) {                                                       // [ ... ]
      const close = dictionary.slice(p + 1, p + 1 + MAX_FILTER_ARRAY).indexOf(']');
      if (close >= 0) return dictionary.slice(p + 1, p + 1 + close).match(/[A-Za-z0-9]+/g) ?? [];
    } else if (c === 0x2f) {                                                // /Name
      let q = p + 1;
      while (q < dictionary.length && q - p <= 64) {
        const ch = dictionary.charCodeAt(q);
        if (!((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a))) break;
        q++;
      }
      if (q > p + 1) return [dictionary.slice(p + 1, q)];
    }
  }
  return [];
}
const IMAGE_FILTERS: ReadonlySet<string> = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode']);
const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

/** What a unit of the scan's allowance is worth: about 2.5 ns of one character walked. Escapes, hex digits and decoded bytes cost what they cost (measured). */
const STRING_ESCAPE_UNITS = 40;
const HEX_DIGIT_UNITS = 4;
const DECODE_UNITS = 2;

const isHexDigit = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

/**
 * The text strings a content stream draws, in order: literal strings "(…)" (balanced parentheses, backslash escapes, octal
 * codes, line continuations) and hex strings "<…>". One left-to-right walk that visits each character a bounded number of
 * times — no regex, so no backtracking: a stream of "(\(\(\(…" or "(\\(\\" costs the same as ordinary text. Comments
 * ("% …" to the end of the line, outside a string) and dictionary brackets ("<<", ">>") are skipped. Stops once
 * `maxChars` of text were collected (stopped: true), or once the optional `work` allowance (one unit per character visited, nine for
 * a character of string content that is escaped) is spent.
 */
export function pdfTextStrings(content: string, maxChars: number, work?: Allowance): { strings: string[]; chars: number; stopped: boolean } {
  const strings: string[] = [];
  const n = content.length;
  let chars = 0;
  let i = 0;
  let left = work ? work.left : Number.POSITIVE_INFINITY;
  const done = (stopped: boolean) => { if (work) work.left = left; return { strings, chars, stopped }; };
  const take = (text: string): boolean => {
    strings.push(text);
    chars += text.length;
    return chars >= maxChars;
  };
  while (i < n) {
    if (--left < 0) return done(true);
    const c = content.charCodeAt(i);
    if (c === 0x25) {                                  // '%': a comment
      const from = i;
      while (i < n && content.charCodeAt(i) !== 0x0a && content.charCodeAt(i) !== 0x0d) i++;
      left -= i - from;
    } else if (c === 0x28) {                           // '(': a literal string
      let depth = 1;
      let text = '';
      let from = ++i;
      while (i < n) {
        if (--left < 0) return done(true);
        const d = content.charCodeAt(i);
        if (d === 0x5c) {                              // backslash escape
          left -= STRING_ESCAPE_UNITS;
          text += content.slice(from, i);
          i++;
          if (i >= n) { from = i; break; }
          const e = content.charCodeAt(i);
          if (e >= 0x30 && e <= 0x37) {                // up to three octal digits
            let code = 0;
            let digits = 0;
            while (digits < 3 && i < n && content.charCodeAt(i) >= 0x30 && content.charCodeAt(i) <= 0x37) { code = code * 8 + content.charCodeAt(i) - 0x30; i++; digits++; }
            text += String.fromCharCode(code & 0xff);
          } else if (e === 0x0d) {                     // a backslash before a line break continues the line
            i++;
            if (content.charCodeAt(i) === 0x0a) i++;
          } else if (e === 0x0a) {
            i++;
          } else {
            const ch = content[i];
            text += ESCAPES[ch] ?? ch;
            i++;
          }
          from = i;
        } else if (d === 0x28) {                       // a nested "(" is part of the string; parentheses balance
          depth++;
          i++;
        } else if (d === 0x29) {
          if (--depth === 0) break;
          i++;
        } else {
          i++;
        }
      }
      text += content.slice(from, i);
      i++;                                             // past the closing ')'
      if (text && take(text)) return done(true);
    } else if (c === 0x3c) {                           // '<': a dictionary ("<<") or a hex string
      if (content.charCodeAt(i + 1) === 0x3c) { i += 2; continue; }
      let j = i + 1;
      let hex = '';
      const hexCap = 2 * Math.max(0, maxChars - chars) + 2;   // more digits than could ever be collected
      let over = false;
      while (j < n) {
        left -= HEX_DIGIT_UNITS;
        if (left < 0) return done(true);
        const h = content.charCodeAt(j);
        if (isHexDigit(h)) {
          hex += content[j];
          if (hex.length > hexCap) { over = true; break; }       // a 20 MB hex string was built digit by digit (2 s in one call) before this limit
        } else if (!(h === 0x20 || h === 0x0a || h === 0x0d || h === 0x09 || h === 0x0c || h === 0x00)) break;
        j++;
      }
      if (over) { take(Buffer.from(hex.slice(0, hexCap - (hexCap % 2)), 'hex').toString('latin1')); return done(true); }
      if (j < n && content.charCodeAt(j) === 0x3e && hex.length > 0) {
        const text = Buffer.from(hex.padEnd(Math.ceil(hex.length / 2) * 2, '0'), 'hex').toString('latin1');
        i = j + 1;
        if (take(text)) return done(true);
      } else {
        i++;                                           // not a hex string: an ordinary '<'
      }
    } else {
      i++;
    }
  }
  return done(false);
}

export interface PdfStreamScan {
  /** The injection pattern the strings matched, or null. */
  hit: string | null;
  /**
   * False when something that could hold page content was NOT read: a stream that would not inflate or inflates past
   * the per-stream cap, one wrapped in a filter this scan does not decode (LZW, run-length, crypt, a predictor …), or more
   * streams or text than the scan takes. The file must then not go to the model as a document, because the scan cannot
   * vouch for what is in it.
   */
  complete: boolean;
}

const PREDICTOR_RE = /\/Predictor[\s\0]*(\d+)/;
const FLATE_FILTERS: ReadonlySet<string> = new Set(['FlateDecode', 'Fl']);
const ASCII85_FILTERS: ReadonlySet<string> = new Set(['ASCII85Decode', 'A85']);
const ASCIIHEX_FILTERS: ReadonlySet<string> = new Set(['ASCIIHexDecode', 'AHx']);

/**
 * A content stream's bytes after its whole /Filter chain, applied in order exactly as pdfjs does (Flate, ASCII85 and ASCIIHex,
 * alone or chained: ReportLab writes every stream as [/ASCII85Decode /FlateDecode]), each step capped at
 * MAX_SCANNED_STREAM_BYTES. null = this scan cannot read it: any other filter, a predictor, a corrupt or oversize stage.
 * `work` pays for the text decoders' input.
 */
function decodeForScan(data: Buffer, filters: string[], dictionary: string, budget: { inflated: number }, work: Allowance): Buffer | null {
  const predictor = PREDICTOR_RE.exec(dictionary);
  if (predictor && Number(predictor[1]) > 1) return null;   // the decoded bytes are not the content
  let out = data;
  for (const name of filters) {
    if (FLATE_FILTERS.has(name)) {
      if (budget.inflated >= MAX_TOTAL_INFLATED) return null;
      try {
        out = inflateSync(out, { maxOutputLength: MAX_SCANNED_STREAM_BYTES, finishFlush: constants.Z_SYNC_FLUSH });
      } catch {
        return null;   // corrupt, or it inflates past the cap
      }
      budget.inflated += out.length;
    } else if (ASCII85_FILTERS.has(name) || ASCIIHEX_FILTERS.has(name)) {
      if (!work.spend(out.length * DECODE_UNITS)) return null;
      const text = (ASCII85_FILTERS.has(name) ? decodeAscii85 : decodeAsciiHex)(out, 0, out.length, MAX_SCANNED_STREAM_BYTES);
      if (text === null) return null;
      out = text;
    } else {
      return null;
    }
  }
  return out;
}

/**
 * Scans the text strings inside a PDF's page content streams (Flate, ASCII85 or ASCIIHex, alone or chained, or uncompressed;
 * every decode is capped) for wording aimed at an AI reviewer. Streams are found the way pdfjs finds them (nextStream: the
 * keyword "stream" after a dictionary and whatever junk precedes the line break; the first version needed the break right after
 * the keyword, so "stream  \n" hid a stream, and the text in it, from this scan) and end where pdfjs ends them (a validated
 * /Length, else "endstream"). A stream whose dictionary names no filter but whose bytes start like zlib is read as Flate: the
 * dictionary is the file's own claim; if those bytes then turn out not to inflate, they were never Flate and are scanned as they are.
 * A stream whose /Filter or /DecodeParms is an indirect reference ("/Filter 12 0 R") makes the
 * scan incomplete: the chain is written elsewhere, and an ASCII85 + Flate text behind it would otherwise read as noise. Strings are tried joined (kerning splits words: [(Ig) 20 (nore)]) and spaced (words as
 * separate strings). It reads simple-font text as written; text in a subset CID font or inside a picture cannot be read this way,
 * which is why this is a second layer on top of the extracted text, not a proof.
 * Like the pre-flight it is written as steps (a yield after each stream and before each injection pattern pass, which is where a
 * text-heavy file spends most of its time) and its work is allowed a fixed amount (MAX_SCAN_WORK, MAX_DICTIONARY_TEXT).
 */
export function* scanSteps(bytes: Buffer, tally?: PdfWorkTally): Steps<PdfStreamScan> {
  if (countOf(bytes, STREAM_NEEDLE, MAX_STREAM_WORDS + 1) > MAX_STREAM_WORDS) return { hit: null, complete: false };   // the pre-flight refuses such a file; stand-alone, do not walk it
  const pieces: string[] = [];
  let complete = true;
  const incomplete = (why: string) => { complete = false; if (tally && tally.incompleteBecause === undefined) tally.incompleteBecause = why; };
  let collected = 0;
  const inflateBudget = { inflated: 0 };
  const work = new Allowance(MAX_SCAN_WORK);
  const dictionaryText = new Allowance(MAX_DICTIONARY_TEXT);
  const memo: ObjMemo = { keyword: -1, obj: -1 };
  const endstreams = new EndstreamFinder(bytes);
  let streams = 0;
  for (let found = nextStream(bytes, 0); found; found = nextStream(bytes, found.keyword + 6)) {
    const { keyword, start } = found;
    if (start < 0) { incomplete('no line break after the stream keyword'); break; }   // a stream pdfjs reads whose data cannot be located: the file is not vouched for (and not worth walking on)
    if (streams >= MAX_SCANNED_STREAMS || collected >= MAX_SCANNED_CHARS || work.left < 0) { incomplete('more streams, text or work than the scan takes'); break; }
    streams++;
    yield;   // at the top: the paths below that `continue` (a stream that will not inflate costs ~50 us to throw about) would otherwise never give the event loop a turn

    const { text: dict, own } = streamDictionary(bytes, keyword, memo);
    if (!dictionaryText.spend(dict.length)) { incomplete('dictionary text allowance spent'); break; }
    if (!own) { incomplete('a stream with no obj header of its own'); continue; }
    if (NOT_CONTENT_RE.test(dict)) continue;
    if (INDIRECT_CHAIN_RE.test(dict)) { incomplete('an indirect /Filter or /DecodeParms'); continue; }   // how the data is encoded is not written here, so what it says cannot be read here
    let filters = filterNames(dict);
    if (filters.some(f => IMAGE_FILTERS.has(f))) continue;

    const length = validatedLength(bytes, start, dict);
    let end: number;
    if (length !== null) {
      end = start + length;
    } else {
      end = endstreams.next(start);
      if (end < 0) { incomplete('no endstream'); break; }
    }
    const data = bytes.subarray(start, end);
    // The bytes say Flate where the dictionary says nothing; if they then do not inflate, the dictionary was right and they are plain content.
    const sniffed = !filters.length && hasZlibHeader(data);
    if (sniffed) filters = ['FlateDecode'];

    let content: string | null = null;
    if (filters.length) {
      const decoded = decodeForScan(data, filters, dict, inflateBudget, work);
      if (decoded !== null) content = decoded.toString('latin1');
      else if (!sniffed) { incomplete(`a filter chain the scan cannot read (${filters.join(' ')})`); continue; }   // LZW / run-length / crypt / a predictor / corrupt / over the cap: not read here
    }
    if (content === null) {
      // An unfiltered span is read as it is, and it is the one read that was free: a file may hold thousands of stream starts that all end at ONE far
      // "endstream" (each is a valid-looking start, none is skipped), so every one of them re-read the same megabytes, 4,000 times over a 7.8 MB span =
      // 10.5 s of this thread's CPU for a file the sandbox never sees, and the burn went on after the item had been given up on. So the span is charged
      // BEFORE anything reads it (a quarter of its length: the native search below costs about that much of what a unit is worth), and a file that
      // spends the allowance is not vouched for, like every other bounded loop here. Real files hold each unfiltered stream once (their spans do not
      // overlap), so what they spend in total is at most a quarter of their size: 2 MB of the 32 MB allowance at the 8 MB file limit.
      if (!work.spend((end - start) >> 2)) { incomplete('more streams, text or work than the scan takes'); break; }
      // Looked for natively first: no string is made for a span without "BT" (the test below needs the two letters, so nothing is skipped that it would have taken).
      const hasBT = bytes.subarray(start, end).indexOf(BT_NEEDLE) >= 0;
      if (!hasBT) continue;                      // nothing in it draws text (and, past the cap, nothing is lost by not reading it)
      if (end - start > MAX_SCANNED_STREAM_BYTES) incomplete('an unfiltered stream past the cap that draws text');   // it does, so the part past the cap is not vouched for
      content = bytes.toString('latin1', start, Math.min(end, start + MAX_SCANNED_STREAM_BYTES));
    }
    yield;   // the inflate and the copy into a string are one slice, the test for text another, the walk below a third
    if (!/\bBT\b/.test(content)) continue;
    yield;

    const read = pdfTextStrings(content, MAX_SCANNED_CHARS - collected, work);
    for (const text of read.strings) pieces.push(text);
    collected += read.chars;
    if (read.stopped) { incomplete('more text or work than the scan takes'); break; }   // more text than the scan takes (or work than it is allowed): the rest is not vouched for
    yield;
  }
  if (tally) { tally.scanWork = work.spent; tally.dictionaryText = dictionaryText.spent; }
  yield;
  // The injection patterns are most of a text-heavy file's cost (up to ~1 microsecond a character, two passes at most): scanTextSteps does them in windows.
  let hit = yield* scanTextSteps(pieces.join('').slice(0, MAX_SCANNED_CHARS));
  if (hit === null) {
    yield;
    hit = yield* scanTextSteps(pieces.join(' ').slice(0, MAX_SCANNED_CHARS));
  }
  return { hit, complete };
}

/** The content scan, run straight through (see scanSteps). Synchronous: the caller that must not stall its event loop uses scanPdfContentStreamsAsync. */
export function scanPdfContentStreams(bytes: Buffer, tally?: PdfWorkTally): PdfStreamScan {
  return runStraight(scanSteps(bytes, tally));
}

/** The same scan, handing the event loop back every PDF_SLICE_MS. What preparePdf uses. `until`: see runCooperatively. */
export function scanPdfContentStreamsAsync(bytes: Buffer, tally?: PdfWorkTally, until?: number): Promise<PdfStreamScan> {
  return runCooperatively(scanSteps(bytes, tally), PDF_SLICE_MS, until);
}

// ─── the PDF ─────────────────────────────────────────────────────────────────

/** What a result that is not "the parser read the file" means for the review. Never throws. */
function unreadable(result: Exclude<PdfReadResult, { kind: 'read' }>): Prepared {
  switch (result.kind) {
    case 'unavailable':
      return unread('failed', PDF_READER_REASON);   // the process could not be started, or the module would not load: ours
    case 'timeout':
      // Cut off by the item's own (shared) deadline: nobody's fault. Cut off by the per-PDF cap: the file is too heavy to read.
      return unread('unreviewable', result.limitedBy === 'item' ? PDF_SLOW_REASON : TOO_COMPLEX_REASON);
    case 'too-complex':
      return unread('unreviewable', TOO_COMPLEX_REASON);
    case 'parser-error':
      if (isPasswordError(result)) return unread('inaccessible', PASSWORDED_REASON);
      if (isLoadFailure(result)) return unread('failed', PDF_READER_REASON);   // e.g. "Setting up fake worker failed": pdf.worker.mjs is not in the bundle
      return unread('unreviewable', NOT_A_PDF_REASON);
  }
}

/** The seams preparePdf reads through; tests substitute them, production never passes them. */
export interface PdfReadHooks {
  reader?: PdfReader;
  options?: Partial<PdfReadOptions>;
}

/**
 * Reads one downloaded PDF.
 *  - Not a PDF (no %PDF- at byte 0), or one pdf-parse cannot open: 'unreviewable', neutral — a complete download that
 *    will not parse says nothing about the candidate. Larger than BUDGET.maxFileBytes: 'unreviewable' (a cap, not a failure).
 *  - Encrypted (password-protected, or locked with an owner password): 'inaccessible' — they can send an open copy. Its
 *    streams are ciphertext, so nothing about it could be bounded before parsing.
 *  - the pre-flight runs BEFORE pdf-parse ever sees the file: a PDF whose streams inflate past the caps, or that uses
 *    something that cannot be bounded, is 'unreviewable' ("too complex to open automatically") and is never parsed (no process is
 *    started for it). It, and the content scan below, hand the event loop back every PDF_SLICE_MS.
 *  - The parse itself runs in a child process (pdfSandbox.ts) that is killed at a hard deadline (PDF_PARSE_MS) or when memory
 *    balloons: a file that gets killed, runs out of heap or crashes the process is 'unreviewable' with the same "too complex"
 *    reason, NOT 'failed' and not retried (a hostile or pathological file is the candidate's; a retry costs another 300 s).
 *  - The PDF READER failing to start (a missing module or worker file, or a process that would not start) is 'failed': OUR side,
 *    retried and visible, never a verdict on the file. (A silent 'unreviewable' here hid a missing pdf.worker.mjs for every
 *    PDF in production once.)
 *  - Its text is always extracted and scanned for injection; a match drops text and media ('unreviewable', injectionHit).
 *  - Native 'document' block ONLY when the PDF is at most the per-file page cap, was granted every page by the shared
 *    budget, is not encrypted (an encrypted file the API may refuse would fail the whole model call) and its raw page content
 *    could be fully checked for injection (scanPdfContentStreams). Otherwise the first `granted` pages are read as
 *    text only and the result is 'partial'.
 *  - The budget is reserved synchronously (pages, then bytes for a native block, then characters), so PDFs read
 *    concurrently can never overshoot a cap.
 */
export async function preparePdf(bytes: Buffer, label: string, ctx: AcquireContext, hooks: PdfReadHooks = {}): Promise<Prepared> {
  try {
    return await preparePdfWithin(bytes, label, ctx, hooks);
  } catch (e) {
    // The item's deadline passed while one of the passes on this thread was still running (see runCooperatively): the pass was stopped at its next
    // slice rather than left to burn CPU unobserved. It started and ran out of time, which is nobody's fault: the same neutral answer the sandbox gives
    // for a read cut off by the item's deadline. (The orchestrator has already given up on this item by then; this is what a direct caller sees.)
    if (e instanceof PassAbandonedError) return unread('unreviewable', PDF_SLOW_REASON);
    throw e;
  }
}

async function preparePdfWithin(bytes: Buffer, label: string, ctx: AcquireContext, hooks: PdfReadHooks): Promise<Prepared> {
  if (bytes.length < PDF_MAGIC.length || bytes.toString('latin1', 0, PDF_MAGIC.length) !== PDF_MAGIC) {
    return unread('unreviewable', NOT_A_PDF_REASON);
  }
  if (bytes.length > BUDGET.maxFileBytes) return unread('unreviewable', SIZE_LIMIT_REASON);

  const until = ctx.deadline;   // the item's own deadline: past it nobody is waiting for what these passes would find
  const flight = await preflightPdfAsync(bytes, undefined, until);   // cooperative: the event loop keeps running between its slices
  if (!flight.ok) return flight.why === 'encrypted' ? unread('inaccessible', PASSWORDED_REASON) : unread('unreviewable', TOO_COMPLEX_REASON);

  const parsed = await (hooks.reader ?? readPdfInSandbox)(bytes, { maxPages: BUDGET.maxPdfPagesPerFile, deadline: ctx.deadline, capMs: PDF_PARSE_MS, ...hooks.options });
  if (parsed.kind !== 'read') return unreadable(parsed);

  const total = parsed.total;
  // pdfjs reports permission flags only for an encrypted document, so this is "opened without a password, but locked".
  const encrypted = parsed.encrypted;
  if (!Number.isInteger(total) || total < 1) return unread('unreviewable', NO_PAGES_REASON);
  const pages = parsed.pages.length ? parsed.pages : [{ num: 1, text: '' }];

  // Everything the model could read of this file — all `want` pages, whether sent as a document or as text.
  if (await scanDocumentTextCooperatively(pages.map(p => p.text).join('\n'), until)) return injectionPrepared();

  const want = Math.min(total, BUDGET.maxPdfPagesPerFile);
  // A file that may go out as a document is read by the model's own extractor, so scan its raw page content too.
  let inspected = true;
  if (!encrypted && total <= BUDGET.maxPdfPagesPerFile) {
    const scan = await scanPdfContentStreamsAsync(bytes, undefined, until);
    if (scan.hit) return injectionPrepared();
    inspected = scan.complete;
  }
  const granted = ctx.budget.reservePages(want);
  if (granted === 0) return unread('unreviewable', BUDGET_REASON);

  const fits = total <= BUDGET.maxPdfPagesPerFile && granted === total;
  const native = fits && !encrypted && inspected && ctx.budget.reserveBytes(bytes.length);

  const read = pages.slice(0, granted).map(p => ({ num: p.num, text: cleanText(p.text) })).filter(p => p.text);
  const readable = hasReadableText(read.map(p => p.text).join('\n'));
  const body = read.map(p => `[page ${p.num}]\n${p.text}`).join('\n\n');
  const { text, truncated } = reserveText(readable ? body : '', ctx);
  // Our own measurement, shown to the model beside the text: the extracted text is NOT the whole document when this is
  // present, so a quote it cannot find there (or a page that is only pictures) is not evidence against the candidate.
  const shortened = truncated ? [TEXT_SHORTENED_FACT] : [];

  if (native) {
    const media: MediaBlock[] = [{
      kind: 'document', label: safeLabel(label, 120) || 'PDF', mime: 'application/pdf',
      b64: bytes.toString('base64'), bytes: bytes.length, pages: total,
    }];
    return { outcome: 'ok', media, text, facts: [`PDF, ${total} of ${total} pages read`, ...shortened], injectionHit: false, pagesReviewed: total };
  }

  // Why it was not sent as a document, in words that read right after "because".
  const causes: string[] = [];
  if (total > BUDGET.maxPdfPagesPerFile) causes.push(`it has ${total} pages (the limit is ${BUDGET.maxPdfPagesPerFile})`);
  else if (granted < total) causes.push("the review's page limit was reached");
  if (encrypted) causes.push('it is encrypted');
  if (fits && !encrypted) causes.push(inspected ? "the review's size limit was reached" : 'its page content could not be fully checked');

  if (!readable) {
    return unread('unreviewable', `The PDF has no readable text (it is made of images) and could not be opened as pages: ${causes.join('; ')}`);
  }
  if (truncated) causes.push(`the text was cut at ${text.length.toLocaleString('en-US')} characters`);
  return {
    outcome: 'partial',
    reason: `Only the text was read (${granted} of ${total} pages): ${causes.join('; ')}`,
    media: [],
    text,
    facts: [`PDF, ${granted} of ${total} pages read (text only)`, ...shortened],
    injectionHit: false,
    pagesReviewed: granted,
  };
}
