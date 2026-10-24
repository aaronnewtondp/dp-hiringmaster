// Resume fetching (loadResume): what ResumeIQ and the portfolio review get back for each kind of file, with Drive faked and the PDF sandbox and the Word reader REAL (a short
// per-PDF cap is injected so a killed bomb costs 1.5 s, not 12). The point of these tests is the contract callers depend on (resumeIQTrigger.ts, routes/portfolio.ts):
//   text null + no linksError = the resume could not be read, nobody's fault but the file's (neutral: profile-only scoring, no portfolio dimension, never a 0);
//   text null + linksError    = OUR failure (retryable, and a portfolio-review role records a visible 'failed');
//   text + linksError         = the text was read but the hyperlinks could not be.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import PDFDocument from 'pdfkit';
import type { ResumePdfRead } from './pdfSandbox/resume.js';

const drive = vi.hoisted(() => ({
  meta: { mimeType: 'application/pdf', name: 'resume.pdf', size: '1000' } as { mimeType: string; name: string; size?: string },
  bytes: Buffer.alloc(0) as Buffer,
  mediaCalls: 0,
  fail: null as Error | null,
  doc: { text: 'Google Doc text', html: '' },
}));
vi.mock('./googleAuth.js', () => ({ getGoogleCredentials: () => ({ client_email: 'sa@example.iam', private_key: 'k' }) }));
vi.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: class {}, JWT: class {} },
    drive: () => ({
      files: {
        get: async (params: { alt?: string }) => {
          if (drive.fail) throw drive.fail;
          if (params.alt === 'media') { drive.mediaCalls++; return { data: drive.bytes.buffer.slice(drive.bytes.byteOffset, drive.bytes.byteOffset + drive.bytes.length) }; }
          return { data: drive.meta };
        },
        export: async (params: { mimeType: string }) => ({ data: params.mimeType === 'text/html' ? drive.doc.html : drive.doc.text }),
      },
    }),
  },
}));

// The real sandbox, with a short cap, unless a test says what the reader returns.
const reader = vi.hoisted(() => ({ override: null as null | (() => Promise<ResumePdfRead>), calls: [] as Array<{ withLinks?: boolean }> }));
vi.mock('./pdfSandbox/resume.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./pdfSandbox/resume.js')>();
  return {
    ...actual,
    readResumePdf: (bytes: Buffer, o?: { withLinks?: boolean }) => {
      reader.calls.push({ withLinks: o?.withLinks });
      return reader.override ? reader.override() : actual.readResumePdf(bytes, o, { options: { capMs: 1500 } });
    },
  };
});

import { extractPdfText, fetchResumeText, fetchResumeTextAndLinks } from './driveService.js';
import { RESUME_MAX_BYTES } from './pdfSandbox/resume.js';
import { fontsPdf, formBombPdf, pages, rawPdf } from './portfolio/acquire/pdf.fixtures.js';
import { buildZip, zipOf } from './portfolio/acquire/zip.fixtures.js';
import zlib from 'zlib';

const URL = 'https://drive.google.com/file/d/RESUMEFILE123/view';

function pdfkit(build: (doc: InstanceType<typeof PDFDocument>) => void): Promise<Buffer> {
  return new Promise(resolve => {
    const doc = new PDFDocument({ size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    build(doc);
    doc.end();
  });
}
const resumeWithLink = () => pdfkit(doc => {
  doc.text('Jane Doe, senior product designer');
  doc.text('My Portfolio', { link: 'https://janedoe.example/work', underline: true });
  doc.addPage().text('Second page: Acme Water, 2021-2024');
});

function serve(bytes: Buffer, meta: Partial<typeof drive.meta> = {}) {
  drive.bytes = bytes;
  drive.meta = { mimeType: 'application/pdf', name: 'resume.pdf', size: String(bytes.length), ...meta };
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  drive.mediaCalls = 0; drive.fail = null; drive.doc = { text: 'Google Doc text', html: '' };
  reader.override = null; reader.calls = [];
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); error.mockRestore(); });

describe('a resume PDF is read through the sandbox, to the same text as before', { timeout: 60_000 }, () => {
  it.each([
    ['one page', () => Promise.resolve(rawPdf(pages(1)))],
    ['three pages', () => Promise.resolve(rawPdf(pages(3)))],
    ['a resume with a hyperlink', resumeWithLink],
    ['an image-only page (no text layer: page markers alone)', () => Promise.resolve(rawPdf(['']))],
  ] as Array<[string, () => Promise<Buffer>]>)('%s: byte-identical to what in-process pdf-parse produced (the old behaviour)', async (_n, build) => {
    const bytes = await build();
    serve(bytes);
    expect(await fetchResumeText(URL)).toBe(await extractPdfText(bytes));
  });

  it('fetchResumeTextAndLinks returns the text and the real hyperlink with the words it covers', async () => {
    serve(await resumeWithLink());
    const r = await fetchResumeTextAndLinks(URL);
    expect(r.text).toContain('Jane Doe, senior product designer');
    expect(r.linksError).toBeUndefined();
    expect(r.links).toEqual([expect.objectContaining({ url: expect.stringContaining('janedoe.example/work'), label: 'My Portfolio' })]);
  });

  it('fetchResumeText asks for no links at all (one parse, no per-page annotation walk); fetchResumeTextAndLinks asks for them', async () => {
    serve(await resumeWithLink());
    expect(await fetchResumeText(URL)).toContain('Jane Doe');
    await fetchResumeTextAndLinks(URL);
    expect(reader.calls).toEqual([{ withLinks: false }, { withLinks: true }]);
  });
});

describe('a resume the PDF reader will not open is neutral, never an error', { timeout: 60_000 }, () => {
  it('a pre-flight refusal (3000 fonts, each expanding a ToUnicode map): no text, no links, no linksError, and a warning that names the file but not its content', async () => {
    serve(fontsPdf(3000));
    expect(await fetchResumeText(URL)).toBeNull();
    expect(await fetchResumeTextAndLinks(URL)).toEqual({ text: null, links: [] });
    expect(warn.mock.calls.some(c => String(c[0]).includes('RESUMEFILE123') && String(c[0]).includes('too-complex'))).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it('a form-XObject bomb that only the sandbox can stop: the same neutral answer, and the next resume is read normally', async () => {
    serve(formBombPdf(20, 2));
    expect(await fetchResumeTextAndLinks(URL)).toEqual({ text: null, links: [] });
    serve(rawPdf(pages(2)));
    expect(await fetchResumeText(URL)).toContain('Page 1 describes');
  });

  it.each([
    ['too complex', { kind: 'unreadable', why: 'too-complex' }],
    ['too large', { kind: 'unreadable', why: 'too-large' }],
    ['password-protected', { kind: 'unreadable', why: 'password' }],
    ['not a PDF', { kind: 'unreadable', why: 'not-a-pdf' }],
  ] as Array<[string, ResumePdfRead]>)('%s: text null, no links, NO linksError (a verdict on the file is never held against the candidate and never shows as our failure)', async (_n, result) => {
    serve(rawPdf(pages(1)));
    reader.override = async () => result;
    expect(await fetchResumeText(URL)).toBeNull();
    expect(await fetchResumeTextAndLinks(URL)).toEqual({ text: null, links: [] });
  });

  it('OUR failure (the reader could not start): text null, and with links asked for, linksError — so a portfolio role records a retryable failure instead of "no portfolio"', async () => {
    serve(rawPdf(pages(1)));
    reader.override = async () => ({ kind: 'unavailable', message: 'spawn ENOENT' });
    expect(await fetchResumeText(URL)).toBeNull();
    expect(await fetchResumeTextAndLinks(URL)).toEqual({ text: null, links: [], linksError: true });
    expect(error.mock.calls.some(c => String(c[0]).includes('resume reader could not read resume RESUMEFILE123') && String(c[0]).includes('spawn ENOENT'))).toBe(true);
  });

  it('text read but annotations not: the text is kept and linksError says the links are unknown (the old extractPdfLinks failure, preserved)', async () => {
    serve(rawPdf(pages(1)));
    reader.override = async () => ({ kind: 'read', text: 'Jane Doe', links: [], linksFailed: true });
    expect(await fetchResumeTextAndLinks(URL)).toEqual({ text: 'Jane Doe', links: [], linksError: true });
    expect(await fetchResumeText(URL)).toBe('Jane Doe');
  });

  it('never throws, whatever Drive does', async () => {
    drive.fail = new Error('Drive 500');
    expect(await fetchResumeText(URL)).toBeNull();
    expect(await fetchResumeTextAndLinks(URL)).toEqual({ text: null, links: [] });
  });
});

const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const WORD_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HYPERLINK_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const wordDoc = (body: string, rels = '') => zipOf({
  'word/document.xml': `<?xml version="1.0"?><w:document ${WORD_NS}><w:body>${body}</w:body></w:document>`,
  'word/_rels/document.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
});
const wordResume = () => wordDoc(
  '<w:p><w:r><w:t>Jane Doe, designer</w:t></w:r></w:p><w:p><w:hyperlink r:id="rId7"><w:r><w:t>Portfolio</w:t></w:r></w:hyperlink></w:p>',
  `<Relationship Id="rId7" Type="${HYPERLINK_REL}" Target="https://janedoe.example/work" TargetMode="External"/>`,
);

describe('a Word resume is read by the bounded reader (never mammoth), with the same contract as a PDF', () => {
  it('text and hyperlinks, with the words each link covers', async () => {
    serve(wordResume(), { mimeType: WORD });
    expect(await fetchResumeText(URL)).toBe('Jane Doe, designer\n\nPortfolio\n\n');
    const r = await fetchResumeTextAndLinks(URL);
    expect(r.text).toBe('Jane Doe, designer\n\nPortfolio\n\n');
    expect(r.linksError).toBeUndefined();
    expect(r.links).toEqual([expect.objectContaining({ url: expect.stringContaining('janedoe.example/work'), label: 'Portfolio' })]);
  });

  it('a link typed as visible text is still found by the text scan (the union that finishLinks has always made)', async () => {
    serve(wordDoc('<w:p><w:r><w:t>See https://typed.example/me for work</w:t></w:r></w:p>'), { mimeType: WORD });
    const r = await fetchResumeTextAndLinks(URL);
    expect(r.links).toEqual([expect.objectContaining({ url: expect.stringContaining('typed.example/me') })]);
  });

  it('a hostile .docx (a 123 KB archive whose document.xml inflates to 40 MB: mammoth aborted node on it) is the neutral "unreadable": no text, no links, no linksError, no throw', async () => {
    const bomb = buildZip([{ name: 'word/document.xml', rawCompressed: zlib.deflateRawSync(Buffer.alloc(40 * 1024 * 1024, 0x20)), rawSize: 40 * 1024 * 1024 }]);
    expect(bomb.length).toBeLessThan(200_000);
    serve(bomb, { mimeType: WORD });
    const t = performance.now();
    expect(await fetchResumeText(URL)).toBeNull();
    expect(await fetchResumeTextAndLinks(URL)).toEqual({ text: null, links: [] });
    expect(performance.now() - t).toBeLessThan(1000);
    expect(warn.mock.calls.some(c => String(c[0]).includes('RESUMEFILE123') && String(c[0]).includes('too-complex'))).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ['plain text under a Word type', Buffer.from('not a zip at all')],
    ['a zip with no Word body', zipOf({ 'readme.txt': 'hello' })],
    ['an old binary .doc under a Word type', Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)])],
  ])('%s: neutral, never an error', async (_n, bytes) => {
    serve(bytes, { mimeType: WORD });
    expect(await fetchResumeTextAndLinks(URL)).toEqual({ text: null, links: [] });
  });

  it('the text is kept when only the links could not be read (linksError, as for a PDF)', async () => {
    const bad = buildZip([
      { name: 'word/document.xml', data: `<?xml version="1.0"?><w:document ${WORD_NS}><w:body><w:p><w:r><w:t>Jane Doe</w:t></w:r></w:p></w:body></w:document>` },
      { name: 'word/_rels/document.xml.rels', rawCompressed: zlib.deflateRawSync(Buffer.alloc(20 * 1024 * 1024, 0x20)), rawSize: 20 * 1024 * 1024 },
    ]);
    serve(bad, { mimeType: WORD });
    expect(await fetchResumeTextAndLinks(URL)).toEqual({ text: 'Jane Doe\n\n', links: [], linksError: true });
    expect(await fetchResumeText(URL)).toBe('Jane Doe\n\n');
  });

  it('a Google Doc is still exported as text and as HTML', async () => {
    serve(Buffer.alloc(0), { mimeType: 'application/vnd.google-apps.document' });
    drive.doc.html = '<a href="https://janedoe.example/work">Portfolio</a>';
    const r = await fetchResumeTextAndLinks(URL);
    expect(r.text).toBe('Google Doc text');
    expect(r.links).toEqual([expect.objectContaining({ label: 'Portfolio' })]);
  });

  it('an unsupported type is not read', async () => {
    serve(Buffer.from('x'), { mimeType: 'image/png' });
    expect(await fetchResumeText(URL)).toBeNull();
  });
});

describe('a file too big to hold is not even downloaded', () => {
  it('Drive says the size first: over RESUME_MAX_BYTES, nothing is downloaded (PDF or Word) and nothing is read', async () => {
    for (const mimeType of ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
      serve(rawPdf(pages(1)), { mimeType, size: String(RESUME_MAX_BYTES + 1) });
      expect(await fetchResumeTextAndLinks(URL)).toEqual({ text: null, links: [] });
    }
    expect(drive.mediaCalls).toBe(0);
  });

  it('a size Drive did not state is checked on what arrives', async () => {
    serve(Buffer.alloc(RESUME_MAX_BYTES + 1, 0x20), { size: undefined });
    expect(await fetchResumeText(URL)).toBeNull();
    expect(drive.mediaCalls).toBe(1);
  });

  it('exactly at the limit is still read', async () => {
    serve(rawPdf(pages(1)), { size: String(RESUME_MAX_BYTES) });
    expect(await fetchResumeText(URL)).toContain('Page 1 describes');
  });
});
