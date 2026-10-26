import { describe, it, expect, vi } from 'vitest';
import PDFDocument from 'pdfkit';
import { deflateSync } from 'zlib';
import { RESUME_MAX_BYTES, RESUME_MAX_PAGES, joinPages, readResumePdf } from './resume.js';
import type { ResumePdfRead } from './resume.js';
import { preflightPdf } from './preflight.js';
import type { PdfReadOptions, PdfReadResult } from './sandbox.js';
import {
  MB, dctContentPdf, flateLayers, flateZeros, fontsPdf, formBombPdf, formCyclePdf, hugeStringPdf, onePage, pages, pdfkitPdf, rawPdf,
} from '../portfolio/acquire/pdf.fixtures.js';
import { HELD_OUT_BENIGN, HELD_OUT_HOSTILE } from '../portfolio/acquire/pdf.heldout.fixtures.js';

const B = (s: string) => Buffer.from(s, 'latin1');
const read = (pdf: Buffer, o?: { withLinks?: boolean }, options?: Partial<PdfReadOptions>) => readResumePdf(pdf, o, options ? { options } : {});
const COMPLEX = { ok: false, why: 'complex' } as const;
/** What a hostile or refused resume looks like to the caller: not read, and nobody's fault but the file's. */
const TOO_COMPLEX: ResumePdfRead = { kind: 'unreadable', why: 'too-complex' };

/** A reader that returns `result`, and remembers what it was asked. */
function fakeReader(result: PdfReadResult) {
  return vi.fn(async (_bytes: Buffer, _o: PdfReadOptions): Promise<PdfReadResult> => result);
}
const viaReader = (reader: ReturnType<typeof fakeReader>, bytes = rawPdf(pages(1)), o?: { withLinks?: boolean }) => readResumePdf(bytes, o, { reader });

/** Largest gap between ticks of a 50 ms timer on THIS thread: the proof that the API function's event loop stayed free while a file was judged. */
function heartbeat() {
  let last = Date.now();
  let max = 0;
  const timer = setInterval(() => { const now = Date.now(); max = Math.max(max, now - last); last = now; }, 50);
  return { stop: () => { clearInterval(timer); return Math.max(max, Date.now() - last); } };
}

/** A resume as a candidate would send it: a name, a hyperlinked "Portfolio" and a second page. */
function resumePdf(): Promise<Buffer> {
  return new Promise(resolve => {
    const doc = new PDFDocument({ size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.text('Jane Doe, senior product designer');
    doc.text('My Portfolio', { link: 'https://janedoe.example/work', underline: true });
    doc.addPage().text('Second page: Acme Water, 2021-2024');
    doc.end();
  });
}

describe('readResumePdf — what each outcome of the sandbox means to ResumeIQ (fake reader, no process)', () => {
  it('a read becomes pdf-parse\'s own text format: each page, then "-- N of T --"', async () => {
    const r = await viaReader(fakeReader({ kind: 'read', total: 2, encrypted: false, pages: [{ num: 1, text: 'one' }, { num: 2, text: 'two' }] }));
    expect(r).toEqual({ kind: 'read', text: 'one\n\n-- 1 of 2 --\n\ntwo\n\n-- 2 of 2 --\n\n', links: [], linksFailed: false });
  });

  it('joinPages writes the markers of the document\'s TOTAL, also when only the first pages were read', () => {
    expect(joinPages([{ num: 1, text: 'a' }], 6)).toBe('a\n\n-- 1 of 6 --\n\n');
    expect(joinPages([], 0)).toBe('');
  });

  it('the reader is asked for the first RESUME_MAX_PAGES pages, with a deadline and the per-PDF cap, and links only when the caller wants them', async () => {
    const reader = fakeReader({ kind: 'read', total: 1, encrypted: false, pages: [{ num: 1, text: 'x' }] });
    await viaReader(reader);
    await viaReader(reader, rawPdf(pages(1)), { withLinks: true });
    const [plain, withLinks] = reader.mock.calls.map(c => c[1]);
    expect(plain).toMatchObject({ maxPages: RESUME_MAX_PAGES, withLinks: false, capMs: 12_000 });
    expect(withLinks).toMatchObject({ maxPages: RESUME_MAX_PAGES, withLinks: true });
    expect(plain.deadline).toBeGreaterThan(Date.now());
    expect(plain.deadline).toBeLessThanOrEqual(Date.now() + 25_000);
  });

  it('links are handed on as {url, label} (label only when the link covers words); without withLinks none are, whatever the reader returned', async () => {
    const result: PdfReadResult = { kind: 'read', total: 1, encrypted: false, pages: [{ num: 1, text: 'x' }], links: [{ url: 'https://a.example', text: 'Portfolio' }, { url: 'https://b.example', text: '' }] };
    expect(await viaReader(fakeReader(result), rawPdf(pages(1)), { withLinks: true })).toMatchObject({ links: [{ url: 'https://a.example', label: 'Portfolio' }, { url: 'https://b.example' }], linksFailed: false });
    expect(await viaReader(fakeReader(result))).toMatchObject({ links: [], linksFailed: false });
  });

  it('annotations that could not be read are reported as linksFailed (the text is still there), and only when links were asked for', async () => {
    const result: PdfReadResult = { kind: 'read', total: 1, encrypted: false, pages: [{ num: 1, text: 'x' }], linksFailed: true };
    expect(await viaReader(fakeReader(result), rawPdf(pages(1)), { withLinks: true })).toMatchObject({ kind: 'read', linksFailed: true, links: [] });
    expect(await viaReader(fakeReader(result))).toMatchObject({ kind: 'read', linksFailed: false });
  });

  it('a PDF with no pages reads as empty text, as pdf-parse always gave', async () => {
    expect(await viaReader(fakeReader({ kind: 'read', total: 0, encrypted: false, pages: [] }))).toEqual({ kind: 'read', text: '', links: [], linksFailed: false });
  });

  it.each([
    ['killed at the per-PDF cap', { kind: 'timeout', limitedBy: 'pdf' }, TOO_COMPLEX],
    ['out of heap', { kind: 'too-complex', cause: 'heap' }, TOO_COMPLEX],
    ['out of resident memory', { kind: 'too-complex', cause: 'memory' }, TOO_COMPLEX],
    ['crashed', { kind: 'too-complex', cause: 'crash' }, TOO_COMPLEX],
    ['a password request', { kind: 'parser-error', name: 'PasswordException', message: 'No password given' }, { kind: 'unreadable', why: 'password' }],
    ['a password message from an older pdfjs', { kind: 'parser-error', name: 'Error', message: 'Incorrect Password' }, { kind: 'unreadable', why: 'password' }],
    ['a file pdfjs cannot parse', { kind: 'parser-error', name: 'InvalidPDFException', message: 'Invalid PDF structure.' }, { kind: 'unreadable', why: 'not-a-pdf' }],
  ] as Array<[string, PdfReadResult, ResumePdfRead]>)('%s is a verdict on the FILE: unreadable, never an error', async (_n, result, expected) => {
    expect(await viaReader(fakeReader(result), rawPdf(pages(1)), { withLinks: true })).toEqual(expected);
  });

  it.each([
    ['the child could not be started', { kind: 'unavailable', message: 'spawn ENOENT' }, 'spawn ENOENT'],
    ['pdf.worker.mjs missing from the bundle', { kind: 'parser-error', name: 'Error', message: 'Setting up fake worker failed: Cannot find module \'/var/task/pdf.worker.mjs\'' }, 'fake worker'],
    ['pdf-parse missing from the bundle', { kind: 'parser-error', name: 'Error', message: 'x', code: 'MODULE_NOT_FOUND' }, 'x'],
    ['the whole read\'s own budget used up by files ahead of it', { kind: 'timeout', limitedBy: 'item' }, 'ran out of time'],
  ] as Array<[string, PdfReadResult, string]>)('%s is OUR failure: unavailable, so it is never held against the candidate', async (_n, result, message) => {
    const r = await viaReader(fakeReader(result));
    expect(r.kind).toBe('unavailable');
    if (r.kind === 'unavailable') expect(r.message).toContain(message);
  });

  it('a reader that throws is unavailable, not an exception (the function never throws)', async () => {
    const reader = vi.fn(async () => { throw new Error('boom'); });
    expect(await readResumePdf(rawPdf(pages(1)), {}, { reader })).toEqual({ kind: 'unavailable', message: 'boom' });
  });

  it('a pass abandoned by the whole read\'s budget is the neutral "too complex", by name (the pre-flight throws it)', async () => {
    const reader = vi.fn(async () => { throw Object.assign(new Error('the pass was abandoned'), { name: 'PassAbandonedError' }); });
    expect(await readResumePdf(rawPdf(pages(1)), {}, { reader })).toEqual(TOO_COMPLEX);
  });

  it('a file over RESUME_MAX_BYTES is unreadable without a look at it', async () => {
    const reader = fakeReader({ kind: 'read', total: 1, encrypted: false, pages: [] });
    expect(await viaReader(reader, Buffer.alloc(RESUME_MAX_BYTES + 1, 0x20))).toEqual({ kind: 'unreadable', why: 'too-large' });
    expect(reader).not.toHaveBeenCalled();
    expect(RESUME_MAX_BYTES).toBe(20 * MB);
  });

  it('what has no "%PDF-" in its first 1024 bytes is not a PDF and never reaches a process; a header a little way in is fine (pdfjs allows it)', async () => {
    const reader = fakeReader({ kind: 'read', total: 1, encrypted: false, pages: [{ num: 1, text: 'x' }] });
    for (const junk of [Buffer.alloc(0), B('<html><body>Not a resume</body></html>'), Buffer.concat([Buffer.alloc(2000, 0x20), B('%PDF-1.4\n')])]) {
      expect(await viaReader(reader, junk)).toEqual({ kind: 'unreadable', why: 'not-a-pdf' });
    }
    expect(reader).not.toHaveBeenCalled();
    expect((await viaReader(reader, Buffer.concat([Buffer.alloc(500, 0x20), rawPdf(pages(1))]))).kind).toBe('read');
  });

  it('a file the pre-flight calls COMPLEX is refused before any process is started', async () => {
    const pdf = fontsPdf(1600, 'std');
    expect(preflightPdf(pdf)).toEqual(COMPLEX);
    const reader = fakeReader({ kind: 'read', total: 1, encrypted: false, pages: [] });
    expect(await viaReader(reader, pdf)).toEqual(TOO_COMPLEX);
    expect(reader).not.toHaveBeenCalled();
  });

  it('a file that DECLARES encryption goes on to the sandbox: its streams cannot be bounded here, but most "encrypted" resumes only forbid editing, and the sandbox does not need the pre-flight to be safe', async () => {
    const pdf = Buffer.concat([rawPdf(pages(1)), B('\ntrailer << /Encrypt 9 0 R >>\n')]);
    expect(preflightPdf(pdf)).toEqual({ ok: false, why: 'encrypted' });
    const reader = fakeReader({ kind: 'read', total: 1, encrypted: true, pages: [{ num: 1, text: 'x' }] });
    expect((await viaReader(reader, pdf)).kind).toBe('read');
    expect(reader).toHaveBeenCalledTimes(1);
  });
});

describe('readResumePdf — real resumes, read by the real pdf-parse in the real sandbox', { timeout: 60_000 }, () => {
  it('reads the text (pdf-parse format) and the hyperlink of an ordinary resume', async () => {
    const r = await read(await resumePdf(), { withLinks: true });
    expect(r).toMatchObject({ kind: 'read', linksFailed: false, links: [{ url: 'https://janedoe.example/work', label: 'My Portfolio' }] });
    if (r.kind !== 'read') return;
    expect(r.text).toBe('Jane Doe, senior product designer\nMy Portfolio\n\n-- 1 of 2 --\n\nSecond page: Acme Water, 2021-2024\n\n-- 2 of 2 --\n\n');
  });

  it('without withLinks it returns the same text and no links', async () => {
    const r = await read(await resumePdf());
    expect(r).toMatchObject({ kind: 'read', links: [] });
  });

  it('a long document is read only as far as RESUME_MAX_PAGES, and says how many pages it has', async () => {
    const r = await read(rawPdf(pages(RESUME_MAX_PAGES + 10)));
    expect(r.kind).toBe('read');
    if (r.kind !== 'read') return;
    expect(r.text.match(/-- \d+ of \d+ --/g)).toHaveLength(RESUME_MAX_PAGES);
    expect(r.text).toContain(`-- ${RESUME_MAX_PAGES} of ${RESUME_MAX_PAGES + 10} --`);
  });

  it('a resume locked with an OWNER password only (no editing or printing) is read, as it always was: it declares encryption, so the pre-flight cannot bound it, and the sandbox does', async () => {
    const pdf = await pdfkitPdf({ ownerPassword: 'owner', permissions: { printing: 'lowResolution' } });
    expect(preflightPdf(pdf)).toEqual({ ok: false, why: 'encrypted' });
    const r = await read(pdf);
    expect(r.kind).toBe('read');
    if (r.kind === 'read') expect(r.text).toContain('Brand campaign page 1');
  });

  it('a password-protected resume is "unreadable: password" (no text, nothing scored against anyone)', async () => {
    expect(await read(await pdfkitPdf({ userPassword: 'secret', ownerPassword: 'owner' }))).toEqual({ kind: 'unreadable', why: 'password' });
  });

  it('a file that has the header and nothing else is unreadable (not a PDF), without an exception', async () => {
    expect(await read(B('%PDF-1.4\nthis is not a pdf at all, just a header'))).toEqual({ kind: 'unreadable', why: 'not-a-pdf' });
  });

  it('an image-only resume reads as page markers alone (what hasReadableText exists to recognise)', async () => {
    const r = await read(rawPdf(['']));
    expect(r.kind).toBe('read');
    if (r.kind === 'read') expect(r.text.replace(/\s+/g, ' ').trim()).toBe('-- 1 of 1 --');
  });
});

describe('readResumePdf — a hostile resume is "too complex", never an error, and never costs this process its event loop', { timeout: 120_000 }, () => {
  /** The reproductions that wedged or aborted the API function when the resume was parsed in-process (CLAUDE.md, "Hostile files"). */
  const preflightRefuses: Array<[string, () => Buffer]> = [
    ['nested [/FlateDecode /FlateDecode] over a 30 MB inner stream (a 3 KB file; 600 MB inside pdfjs)', () => onePage(flateLayers(flateZeros(30), 2), { dict: '/Filter [/FlateDecode /FlateDecode]' })],
    ['a 30 MB Flate bomb behind "stream" followed by spaces (hid a 400 MB bomb from the first pre-flight)', () => onePage(flateZeros(30), { dict: '/Filter /FlateDecode', keyword: 'stream   \n' })],
    ['page content that is a 65000 x 65000 JPEG (a patched DCT stream: 1.5 GB, 10 s)', () => dctContentPdf(65_000)],
    ['3000 fonts, each with a <0000> <FFFF> ToUnicode map (a 1.1 MB file that aborted node)', () => fontsPdf(3000)],
  ];

  it.each(preflightRefuses)('refused by the pre-flight, no process started, thread beating: %s', async (_n, build) => {
    const pdf = build();
    expect(preflightPdf(pdf)).toEqual(COMPLEX);
    const reader = fakeReader({ kind: 'read', total: 1, encrypted: false, pages: [] });
    const beat = heartbeat();
    expect(await readResumePdf(pdf, { withLinks: true }, { reader })).toEqual(TOO_COMPLEX);
    expect(beat.stop()).toBeLessThan(1000);
    expect(reader).not.toHaveBeenCalled();
  });

  it('a form-XObject bomb (20 levels: ~28 s and 1.8 GB in-process) passes the pre-flight by design and is killed by the sandbox, with the thread beating', async () => {
    const pdf = formBombPdf(20, 2);
    expect(preflightPdf(pdf)).toMatchObject({ ok: true });
    const beat = heartbeat();
    expect(await read(pdf, { withLinks: true }, { capMs: 1500 })).toEqual(TOO_COMPLEX);
    expect(beat.stop()).toBeLessThan(1000);
  });

  it('a 4 KB file of two million nested "q" operators is killed the same way', async () => {
    const pdf = onePage(deflateSync(B(`${'q '.repeat(2_000_000)}BT /F1 12 Tf (x) Tj ET`)), { dict: '/Filter /FlateDecode' });
    expect(pdf.length).toBeLessThan(8000);
    const beat = heartbeat();
    expect(await read(pdf, undefined, { capMs: 1500 })).toEqual(TOO_COMPLEX);
    expect(beat.stop()).toBeLessThan(1000);
  });

  it('one huge literal string (an 8 MB string in a 9 KB file: a single allocation that aborts a worker THREAD) ends only the child process', async () => {
    const pdf = hugeStringPdf(8);
    expect(preflightPdf(pdf)).toMatchObject({ ok: true });
    const beat = heartbeat();
    expect(await read(pdf, undefined, { heapMb: 64, capMs: 8000 })).toEqual(TOO_COMPLEX);
    expect(beat.stop()).toBeLessThan(1000);
  });

  it('declaring encryption is no way past: a form-XObject bomb with "/Encrypt" planted in its trailer skips the pre-flight and is still killed by the sandbox', async () => {
    const pdf = Buffer.from(formBombPdf(20, 2).toString('latin1').replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 99 0 R'), 'latin1');
    expect(preflightPdf(pdf)).toEqual({ ok: false, why: 'encrypted' });      // the pre-flight stands aside for a file it cannot bound...
    const beat = heartbeat();
    expect(await read(pdf, { withLinks: true }, { capMs: 1500 })).toEqual(TOO_COMPLEX);   // ...and what is left standing is the child process
    expect(beat.stop()).toBeLessThan(1000);
  });

  it('two forms that call each other are read or refused, never a hang', async () => {
    const r = await read(formCyclePdf(), undefined, { capMs: 1500 });
    expect(['read', 'unreadable']).toContain(r.kind);
  });

  it('the same API function keeps working afterwards: an ordinary resume read straight after a killed one is read', async () => {
    await read(formBombPdf(20, 2), undefined, { capMs: 1000 });
    expect((await read(await resumePdf())).kind).toBe('read');
  });

  describe('the held-out hostile set (30+ shapes written after the fixes, not tuned on), each as a resume', () => {
    it.each(HELD_OUT_HOSTILE.map(c => [c.name, c] as const))('hostile: %s', async (_name, c) => {
      const pdf = await c.build();
      const beat = heartbeat();
      const r = await read(pdf, { withLinks: true }, { capMs: 1500 });
      const gap = beat.stop();
      expect(gap).toBeLessThan(1000);
      if (c.stoppedBy === 'encrypted') {
        // It declares encryption, so the pre-flight cannot judge it and the sandbox decides: whatever it says, it is not an exception and never "read" garbage.
        expect(['unreadable', 'read']).toContain(r.kind);
      } else {
        expect(r).toEqual(TOO_COMPLEX);
      }
    });
  });

  describe('the held-out benign set (heavy but real), each as a resume', () => {
    it.each(HELD_OUT_BENIGN.map(c => [c.name, c] as const))('benign: %s', async (_name, c) => {
      const r = await read(await c.build(), { withLinks: true });
      expect(r.kind).toBe('read');
    });
  });
});
