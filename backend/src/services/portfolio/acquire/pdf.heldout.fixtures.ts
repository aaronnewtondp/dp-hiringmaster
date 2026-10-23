// Test-only: a HELD-OUT set of hostile and benign PDFs for preflightPdf and the PDF sandbox. The first round of fixes was tuned on
// the reviewers' own repro files and those fixes missed their neighbours (a different keyword spelling, a third Flate layer), so this
// set is deliberately written in other shapes than every repro in pdf.test.ts / pdf.hostile.test.ts. Each hostile case says where it
// must stop: 'preflight' (refused before any process starts) or 'sandbox' (passes the cheap checks by design, and the killable child process
// has to end it). Never imported by production code.
import { deflateSync } from 'zlib';
import {
  TEXT_CONTENT, ascii85, asciiHex, buildPdf, cmapOf, flateLayers, flateOfText, flateZeros, flateZerosUnfinished, fontsPdf, formBombPdf,
  imagePdf, indirectFilterPage, jpegClaimingWith, jpxClaiming, onePage, pages, pdfkitPdf, rawPdf, streamBody, withRawObject, xrefStreamPdf,
} from './pdf.fixtures.js';
import type { PdfObject } from './pdf.fixtures.js';

export interface HeldOutCase {
  name: string;
  build: () => Buffer | Promise<Buffer>;
}
export interface HeldOutHostile extends HeldOutCase {
  /** Where it must be stopped. */
  stoppedBy: 'preflight' | 'sandbox' | 'encrypted';
}

const B = (x: string) => Buffer.from(x, 'latin1');
const bomb = () => flateZeros(30);
const blanks = (n: number) => ' '.repeat(n);

/** A page whose content stream is `data` under `dict`, with the stream keyword written as `keyword`. */
const page = (data: Buffer, dict: string, keyword?: string) => onePage(data, { dict, keyword });

/** A bomb in an image-looking stream, wrapped in a long dictionary of junk keys (so the filter keys sit far from the "N G obj" header). */
const longDictionary = (junkBytes: number, data: Buffer) => buildPdf([
  [1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
  [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>'],
  [4, Buffer.concat([B(`<< /Junk (${'j'.repeat(junkBytes)}) /Filter /FlateDecode /Length ${data.length} >>\nstream\n`), data, B('\nendstream')])],
]);

export const HELD_OUT_HOSTILE: HeldOutHostile[] = [
  // ── where pdfjs finds a stream ────────────────────────────────────────────
  { name: 'bomb, keyword "stream" + 300 blanks + a lone CR', stoppedBy: 'preflight', build: () => page(bomb(), '/Filter /FlateDecode', `stream${blanks(300)}\r`) },
  { name: 'bomb, keyword glued to the dictionary: ">>stream\\r\\n"', stoppedBy: 'preflight', build: () => buildPdf([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>'],
    [4, Buffer.concat([B(`<< /Filter /FlateDecode /Length ${bomb().length} >>stream\r\n`), bomb(), B('\nendstream')])]]) },
  { name: 'bomb, a %-comment between the dictionary and the keyword', stoppedBy: 'preflight', build: () => buildPdf([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>'],
    [4, Buffer.concat([B(`<< /Filter /FlateDecode /Length ${bomb().length} >>\n% the next line starts the data\nstream\n`), bomb(), B('\nendstream')])]]) },
  { name: 'bomb, "stream" followed by a trailing comment-like tail on the same line', stoppedBy: 'preflight', build: () => page(bomb(), '/Filter /FlateDecode', 'stream % data follows\n') },
  { name: 'bomb, 600 blanks after the keyword (more than a real writer ever puts there)', stoppedBy: 'preflight', build: () => page(bomb(), '/Filter /FlateDecode', `stream${blanks(600)}\n`) },
  { name: 'bomb in ASCIIHex + Flate with "stream  \\n"', stoppedBy: 'preflight', build: () => page(asciiHex(bomb()), '/Filter [/ASCIIHexDecode /FlateDecode]', 'stream  \n') },
  { name: 'bomb behind a 70 KB dictionary whose own header is out of reach', stoppedBy: 'preflight', build: () => longDictionary(70_000, bomb()) },
  { name: 'bomb whose dictionary plants "obj" in a string so a naive "after the last obj" read loses the filter', stoppedBy: 'preflight', build: () => page(bomb(), '/Filter /FlateDecode /Note (obj)') },

  // ── layers ────────────────────────────────────────────────────────────────
  { name: 'three nested Flate layers over a 30 MB inner stream', stoppedBy: 'preflight', build: () => page(flateLayers(bomb(), 2), '/Filter [/FlateDecode /FlateDecode /FlateDecode]') },
  { name: 'two layers hidden behind a dictionary that names only one', stoppedBy: 'preflight', build: () => page(flateLayers(bomb(), 1), '/Filter /FlateDecode') },
  { name: 'ASCII85 + Flate + Flate with "stream\\t\\n"', stoppedBy: 'preflight', build: () => page(ascii85(flateLayers(bomb(), 1)), '/Filter [/ASCII85Decode /FlateDecode /FlateDecode]', 'stream\t\n') },
  { name: 'inner layer that simply stops (no final block), two layers', stoppedBy: 'preflight', build: () => page(deflateSync(flateZerosUnfinished(30)), '/Filter [/FlateDecode /FlateDecode]') },
  { name: 'six Flate layers around a small stream (nobody nests that deep)', stoppedBy: 'preflight', build: () => page(flateLayers(B(TEXT_CONTENT), 6), '/Filter /FlateDecode') },
  { name: 'Flate, then ASCII85, then Flate again: names two layers, only one can be verified', stoppedBy: 'preflight', build: () => page(deflateSync(ascii85(deflateSync(bomb()))), '/Filter [/FlateDecode /ASCII85Decode /FlateDecode]') },

  // ── codecs ────────────────────────────────────────────────────────────────
  { name: 'page content is a PROGRESSIVE JPEG (SOF2) claiming 40000 x 40000, filter spelled /DCT', stoppedBy: 'preflight', build: () => page(jpegClaimingWith(0xc2, 40000, 40000), '/Filter /DCT') },
  { name: 'page content is a JPEG 2000 header claiming 100000 x 100000', stoppedBy: 'preflight', build: () => page(jpxClaiming(100000, 100000), '/Filter /JPXDecode') },
  { name: 'an "image" whose own header claims 30000 x 30000 (900 megapixels)', stoppedBy: 'preflight', build: () => imagePdf(jpegClaimingWith(0xc0, 30000, 30000)) },
  { name: 'a small DCT image inside a Flate layer, claiming 20000 x 20000', stoppedBy: 'preflight', build: () => imagePdf(deflateSync(jpegClaimingWith(0xc0, 20000, 20000)), '/Filter [/FlateDecode /DCTDecode]') },
  { name: 'page content filtered as CCITT fax (no picture in sight)', stoppedBy: 'preflight', build: () => page(Buffer.alloc(40, 1), '/Filter /CCITTFaxDecode') },
  { name: 'page content filtered with LZW and "stream  \\n"', stoppedBy: 'preflight', build: () => page(B('BT (x) Tj ET'), '/Filter /LZWDecode', 'stream  \n') },

  // ── CMaps and fonts ───────────────────────────────────────────────────────
  { name: '40 fonts, each with one full 32-bit range <00000000> <00FFFFFF> (16.7 million codes)', stoppedBy: 'preflight', build: () => fontsPdf(40, 'tu', { cmap: cmapOf([['00000000', '00FFFFFF']]) }) },
  { name: '150 fonts whose full range is split into 256 sections of 256 codes', stoppedBy: 'preflight', build: () => fontsPdf(150, 'tu', { cmap: cmapOf(Array.from({ length: 256 }, (_, i) => [`${i.toString(16).padStart(2, '0')}00`, `${i.toString(16).padStart(2, '0')}FF`] as [string, string])) }) },
  { name: '900 fonts whose full-range CMap is Flate-compressed', stoppedBy: 'preflight', build: () => fontsPdf(900, 'tu', { dict: '/Filter /FlateDecode', wrap: b => deflateSync(b) }) },
  { name: '900 fonts whose full-range CMap is ASCIIHex-encoded', stoppedBy: 'preflight', build: () => fontsPdf(900, 'tu', { dict: '/Filter /ASCIIHexDecode', wrap: b => asciiHex(b) }) },
  { name: '900 fonts with a full CID range (begincidrange)', stoppedBy: 'preflight', build: () => fontsPdf(900, 'tu', { cmap: cmapOf([['0000', 'FFFF']], 'cid') }) },
  { name: '4000 plain fonts', stoppedBy: 'preflight', build: () => fontsPdf(4000, 'std') },

  // ── page structure ────────────────────────────────────────────────────────
  { name: 'a /MediaBox of 1e9 x 1e9 points', stoppedBy: 'preflight', build: () => onePage(B(TEXT_CONTENT), { mediaBox: '[0 0 1e9 1e9]' }) },
  { name: '25,000 tiny streams', stoppedBy: 'preflight', build: () => rawPdf(pages(1), 0, { extraObjects: Array.from({ length: 25_000 }, () => ({ dict: '', data: B('x') })) }) },
  { name: '600 object streams', stoppedBy: 'preflight', build: () => rawPdf(pages(1), 0, { extraObjects: Array.from({ length: 600 }, () => ({ dict: '/Type /ObjStm /N 1 /First 5', data: B('x') })) }) },
  { name: '3000 forms (more than any real file: the most among 820 real PDFs is 1152)', stoppedBy: 'preflight', build: () => {
    const forms: PdfObject[] = Array.from({ length: 3000 }, (_, i) => [10 + i, streamBody('/Type /XObject /Subtype /Form /BBox [0 0 1 1]', B('q Q'))]);
    return onePage(B('q Q'), { extra: forms });
  } },

  // ── what only the sandbox can stop (the cheap checks cannot tell it from a deck with that many forms) ──
  { name: 'a 300 MB ASCII85 + Flate bomb of "q Q" operators whose /Filter is an indirect reference (the chain is written in another object)', stoppedBy: 'sandbox', build: () => indirectFilterPage(ascii85(flateOfText(300))) },
  { name: 'forms that each call the next three times, 14 levels (3^14 = 4.8 million draws)', stoppedBy: 'sandbox', build: () => formBombPdf(14, 3) },
  { name: 'forms that each call the next four times, 11 levels', stoppedBy: 'sandbox', build: () => formBombPdf(11, 4) },

  // ── encrypted ─────────────────────────────────────────────────────────────
  { name: 'an encrypted file (its streams are ciphertext) with a bomb-sized stream', stoppedBy: 'encrypted', build: () =>
    Buffer.from(withRawObject('/Filter /FlateDecode', bomb()).toString('latin1').replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 9 0 R'), 'latin1') },
];

export const HELD_OUT_BENIGN: HeldOutCase[] = [
  { name: 'double-Flate content (rare, legitimate)', build: () => page(flateLayers(B(TEXT_CONTENT), 2), '/Filter [/FlateDecode /FlateDecode]') },
  { name: 'four Flate layers around a small stream', build: () => page(flateLayers(B(TEXT_CONTENT), 4), '/Filter [/FlateDecode /FlateDecode /FlateDecode /FlateDecode]') },
  { name: 'ReportLab: [/ASCII85Decode /FlateDecode] on every stream', build: () => rawPdf(pages(2), 0, { chain: 'a85+flate' }) },
  { name: 'ASCIIHex + Flate content', build: () => rawPdf(pages(2), 0, { chain: 'ahx+flate' }) },
  { name: 'a baseline JPEG picture of 8000 x 8000 (64 megapixels)', build: () => imagePdf(jpegClaimingWith(0xc0, 8000, 8000)) },
  { name: 'a progressive JPEG picture of 6000 x 4000', build: () => imagePdf(jpegClaimingWith(0xc2, 6000, 4000)) },
  { name: 'a JPEG 2000 picture of 5000 x 3000', build: () => imagePdf(jpxClaiming(5000, 3000), '/Filter /JPXDecode') },
  { name: 'a CCITT fax picture', build: () => imagePdf(Buffer.alloc(40, 1), '/Filter /CCITTFaxDecode') },
  { name: '100 fonts that each carry a full identity ToUnicode range (6.5 million codes: what a real Type0-heavy deck can reach)', build: () => fontsPdf(100, 'tu') },
  { name: 'a 14400 x 14400 point page (200 inches)', build: () => onePage(B(TEXT_CONTENT), { mediaBox: '[0 0 14400 14400]' }) },
  { name: '1400 plain fonts (the most among 820 real PDFs is 766)', build: () => fontsPdf(1400, 'std') },
  { name: 'a chain of 40 forms that each call the next once', build: () => formBombPdf(40, 1) },
  { name: 'prose containing the word "stream" with 700 characters before the next line break', build: () => rawPdf([`The data stream ${'of the campaign '.repeat(45)}ended well.`]) },
  { name: 'the keyword followed by one blank before the line break ("stream \\n")', build: () => page(deflateSync(B(TEXT_CONTENT)), '/Filter /FlateDecode', 'stream \n') },
  { name: 'a stream keyword with a CRLF and no blank line', build: () => page(deflateSync(B(TEXT_CONTENT)), '/Filter /FlateDecode', 'stream\r\n') },
  { name: 'a cross-reference STREAM file (PDF 1.5)', build: () => xrefStreamPdf() },
  { name: 'PDFKit output', build: () => pdfkitPdf({}, 3) },
  { name: 'a content stream whose dictionary carries a 20 KB inline resource blob before /Filter', build: () => longDictionaryBenign() },
];

function longDictionaryBenign(): Buffer {
  const data = deflateSync(B(TEXT_CONTENT));
  return buildPdf([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
    [4, Buffer.concat([B(`<< /Junk (${'j'.repeat(20_000)}) /Filter /FlateDecode /Length ${data.length} >>\nstream\n`), data, B('\nendstream')])],
    [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  ]);
}
