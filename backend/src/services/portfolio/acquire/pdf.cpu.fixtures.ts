// Test-only: files built to make the parent-side passes (preflightPdf and scanPdfContentStreams, which run on the review's own thread, next
// to the deadline timers and the resident-size watchdog) spend CPU. One shape per loop. Never imported by production code.
//
// STALL_SHAPES is the DEVELOPMENT set: the reviewers' reproductions and the shapes found while fixing them (the passes were tuned on these).
// pdf.cpu.heldout.fixtures.ts is the HELD-OUT set, written after the fixes and built differently from every one of these.
import { deflateSync } from 'zlib';
import { MB, hugeStringPdf, streamBody } from './pdf.fixtures.js';

const L = (s: string) => Buffer.from(s, 'latin1');
export const HEAD = L('%PDF-1.4\n');
/** `unit` repeated to exactly `bytes` bytes (after a PDF header). */
export const filled = (unit: string, bytes: number) => Buffer.concat([HEAD, L(unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes))]);
export const obj = (n: number, body: Buffer | string) => Buffer.concat([L(`${n} 0 obj\n`), Buffer.isBuffer(body) ? body : L(body), L('\nendobj\n')]);
/** A one-page PDF whose only content stream is `content` (any dictionary). */
export function pageWith(content: Buffer, dict = '/Filter /FlateDecode'): Buffer {
  return Buffer.concat([
    HEAD, obj(1, '<< /Type /Catalog /Pages 2 0 R >>'), obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'),
    obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'), obj(4, streamBody(dict, content)),
  ]);
}
/** The same deflated stream as `copies` objects. */
export const manyStreams = (dict: string, data: Buffer, copies: number, first = 10) => Buffer.concat([HEAD, ...Array.from({ length: copies }, (_, i) => obj(first + i, streamBody(dict, data)))]);

export interface StallCase {
  name: string;
  build: () => Buffer;
  /** What the pre-flight does with it: refuses it ('refused': no process is ever started for it) or lets it through ('ok': bounded work, the sandbox decides). */
  preflight: 'refused' | 'ok';
}

const TOP = 8 * MB - 1024;
const defl = (b: Buffer) => deflateSync(b);
const text = (unit: string, bytes: number) => L(unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes));

export const STALL_SHAPES: StallCase[] = [
  // ── the keyword, counted and looked back from ───────────────────────────────────────────────────────────────
  { name: '"q stream " on one 8 MB line (the review-3 file: 2.5-3.4 s per pass, 5 s here)', build: () => filled('q stream ', TOP), preflight: 'refused' },
  { name: '"endstream " x 8 MB', build: () => filled('endstream ', TOP), preflight: 'refused' },
  { name: '">>stream" + 500 blanks + line break, x 8 MB', build: () => filled(`>>stream${' '.repeat(500)}\n`, TOP), preflight: 'refused' },
  { name: '"x %c<LF>stream<LF>" (a comment line above every keyword) x 8 MB', build: () => filled('x %c\nstream\n', TOP), preflight: 'refused' },
  { name: '"<<>>stream<LF>" x 8 MB (700,000 streams without data)', build: () => filled('<<>>stream\n', TOP), preflight: 'refused' },
  // ── "/Encrypt", "/MediaBox", fonts and forms: regexes and native searches over the whole file ───────────────────────
  { name: '"/Encrypt " x 8 MB (never a reference)', build: () => filled('/Encrypt ', TOP), preflight: 'refused' },
  { name: '"/EncryptMetadata false " x 8 MB', build: () => filled('/EncryptMetadata false ', TOP), preflight: 'refused' },
  { name: '"/MediaBox [" x 8 MB (no closing bracket: the old regex backtracked 120 characters on every one)', build: () => filled('/MediaBox [', TOP), preflight: 'refused' },
  { name: '"/MediaBox [0 0 612 792] " x 8 MB (thousands of valid ones)', build: () => filled('/MediaBox [0 0 612 792] ', TOP), preflight: 'refused' },
  { name: '"/Type " x 8 MB', build: () => filled('/Type ', TOP), preflight: 'ok' },
  { name: '"/Type" + 1000 blanks x 8 MB', build: () => filled(`/Type${' '.repeat(1000)}`, TOP), preflight: 'ok' },
  { name: '"/Subtype" + 1000 blanks x 8 MB', build: () => filled(`/Subtype${' '.repeat(1000)}`, TOP), preflight: 'ok' },
  // ── the text decoders: every stream re-reading the rest of the file ─────────────────────────────────────────────────
  {
    name: '19,000 tiny ASCII85 streams followed by 6.5 MB with no "~" (the review-3 file: unbounded search to the end of the file, 2.7 s)',
    build: () => { let s = ''; for (let i = 1; i <= 19_000; i++) s += `${i} 0 obj\n<< /Filter /ASCII85Decode >>\nstream\nAAAAA\nendstream\nendobj\n`; return Buffer.concat([HEAD, L(s + 'x'.repeat(TOP - s.length))]); },
    preflight: 'ok',
  },
  {
    name: '4,000 ASCII85 stream keywords, 7.9 MB of blanks, ONE endstream at the end (every span is the whole file: 80 s in the content scan)',
    build: () => { let s = ''; for (let i = 1; i <= 4000; i++) s += `${i} 0 obj\n<< /Filter /ASCII85Decode >>\nstream\n`; return Buffer.concat([HEAD, L(s + ' '.repeat(TOP - s.length) + '\nendstream\n')]); },
    preflight: 'refused',
  },
  {
    name: '4,000 ASCIIHex stream keywords, 7.9 MB of blanks, ONE endstream at the end',
    build: () => { let s = ''; for (let i = 1; i <= 4000; i++) s += `${i} 0 obj\n<< /Filter /ASCIIHexDecode >>\nstream\n`; return Buffer.concat([HEAD, L(s + ' '.repeat(TOP - s.length) + '\nendstream\n')]); },
    preflight: 'refused',
  },
  // ── dictionaries ───────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: 'ONE obj header, then 19,999 streams (each one\'s dictionary is the text back to that obj: 64 KB each, with a dozen regexes over every copy)',
    build: () => { let s = '1 0 obj\n'; for (let i = 0; i < 19_999 && s.length < 7 * MB; i++) s += `<< /A ${i} >>stream\n\nendstream\n`; return Buffer.concat([HEAD, L(s)]); },
    preflight: 'refused',
  },
  {
    name: 'an obj header every 1,500 streams (the same, with the 64 KB window never empty)',
    build: () => { let s = ''; for (let i = 0; i < 19_999 && s.length < 7 * MB; i++) { if (i % 1500 === 0) s += `${i} 0 obj\n`; s += `<< /A ${i} >>stream\n\nendstream\n`; } return Buffer.concat([HEAD, L(s)]); },
    preflight: 'refused',
  },
  {
    name: '120 stream dictionaries of 60 KB, each an unclosed "/Filter [" repeated (the filter regex was quadratic: 580 ms for one dictionary, 36 s for the file, in the content scan)',
    build: () => Buffer.concat([HEAD, ...Array.from({ length: 120 }, (_, i) => obj(i + 1, L(`<< ${'/Filter ['.repeat(6000)} >>\nstream\nxx\nendstream`)))]),
    preflight: 'ok',
  },
  { name: 'a 60 KB dictionary of "/Length 1 " (the direct-length regex over a long text)', build: () => Buffer.concat([HEAD, L('1 0 obj\n<< '), text('/Length 1 ', 60 * 1024), L('>>\nstream\nxx\nendstream\n')]), preflight: 'ok' },
  { name: 'a 60 KB dictionary of "/FlateDecode " names', build: () => Buffer.concat([HEAD, L('1 0 obj\n<< /Filter ['), text('/FlateDecode ', 60 * 1024), L(']>>\nstream\nxx\nendstream\n')]), preflight: 'refused' },
  { name: 'a 60 KB dictionary full of #41 name escapes', build: () => Buffer.concat([HEAD, L('1 0 obj\n<< /X ('), text('#41', 60 * 1024), L(') >>\nstream\nxx\nendstream\n')]), preflight: 'ok' },
  // ── ToUnicode / CID range maps: what JavaScript walks after inflating ──────────────────────────────────────────────────
  { name: '16 deflated 4 MB CMaps of "beginbfrange <0000> <0001> <0000> endbfrange" (a 200 KB file; 460 ms of walking in one call)', build: () => manyStreams('/Filter /FlateDecode', defl(text('beginbfrange <0000> <0001> <0000> endbfrange ', 4 * MB - 100)), 16), preflight: 'refused' },
  { name: 'the same sections one cell each (nothing for the cell cap to count)', build: () => manyStreams('/Filter /FlateDecode', defl(text('1 beginbfrange <0000> <0000> <0000> endbfrange ', 4 * MB - 100)), 16), preflight: 'refused' },
  { name: '8 MB of uncompressed "beginbfrange <0000> <0001> <0000> endbfrange"', build: () => filled('beginbfrange <0000> <0001> <0000> endbfrange ', TOP), preflight: 'refused' },
  // ── very many streams, each one cheap ─────────────────────────────────────────────────────────────────────────────────
  { name: '20,000 tiny Flate streams (the most the pre-flight takes: ~300 ms in one call)', build: () => manyStreams('/Filter /FlateDecode', defl(L('BT (x) Tj ET')), 20_000), preflight: 'ok' },
  { name: '20,000 tiny image streams', build: () => manyStreams('/Type /XObject /Subtype /Image /Width 2 /Height 2 /Filter /FlateDecode', defl(L('xxxxxxxx')), 20_000), preflight: 'ok' },
  { name: '500 object streams that each inflate to 128 KB', build: () => manyStreams('/Type /ObjStm /N 2 /First 8 /Filter /FlateDecode', defl(L(`1 0 2 0 ${'x'.repeat(128 * 1024)}`)), 500), preflight: 'ok' },
  { name: '3,000 small Flate streams with their own objects (a large real deck)', build: () => manyStreams('/Filter /FlateDecode', defl(L('BT (x) Tj ET')), 3000), preflight: 'ok' },
  // ── what the content scan walks ───────────────────────────────────────────────────────────────────────────────────────────
  { name: 'a 23 MB content stream of "(\\(" (a 24 KB file; every escape is a string concatenation)', build: () => pageWith(defl(L(`BT /F1 12 Tf ${'(\\('.repeat(Math.floor((23 * MB) / 3))}`))), preflight: 'ok' },
  { name: 'a 23 MB content stream of vector operators and one BT', build: () => pageWith(defl(Buffer.concat([text('0.5 0.25 0.75 rg 123.456 789.012 m 150.1 200.2 l h f\n', 23 * MB), L('BT /F1 12 Tf (hi) Tj ET')]))), preflight: 'ok' },
  { name: 'a 23 MB content stream of short strings (the scan stops at 400,000 characters)', build: () => pageWith(defl(text('BT /F1 12 Tf 72 700 Td (Hello world) Tj ET\n', 23 * MB))), preflight: 'ok' },
  { name: 'a 23 MB content stream of "<414243> " hex strings', build: () => pageWith(defl(Buffer.concat([L('BT '), text('<414243> ', 23 * MB)]))), preflight: 'ok' },
  { name: 'ONE 20 MB hex string (built digit by digit in ONE call: 2 s)', build: () => pageWith(defl(L(`BT /F1 12 Tf <${'41'.repeat(10 * MB)}> Tj ET`))), preflight: 'ok' },
  { name: 'a 23 MB content stream of % comment lines', build: () => pageWith(defl(Buffer.concat([L('BT '), text('% a comment line of text\n', 23 * MB)]))), preflight: 'ok' },
  { name: 'ONE 22 MB literal string (the review-3 file that aborted node from a worker thread)', build: () => hugeStringPdf(22), preflight: 'ok' },
  { name: '30 text streams of 2 MB each (the scan reads them until it has 400,000 characters)', build: () => manyStreams('/Filter /FlateDecode', defl(text('BT (Hello world how are you) Tj ET\n', 2 * MB - 100)), 30), preflight: 'ok' },
  { name: 'three 22 MB Flate streams (66 MB: past the 64 MB total)', build: () => manyStreams('/Filter /FlateDecode', defl(text('q Q ', 22 * MB)), 3), preflight: 'refused' },
  { name: 'five 25 MB image streams of zeros (125 MB: under the 128 MB picture total)', build: () => manyStreams('/Type /XObject /Subtype /Image /Width 5000 /Height 5000 /Filter /FlateDecode', defl(Buffer.alloc(25 * MB)), 5), preflight: 'ok' },
];
