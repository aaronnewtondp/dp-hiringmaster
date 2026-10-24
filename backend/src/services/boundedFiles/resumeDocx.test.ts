import { describe, it, expect, vi } from 'vitest';
import zlib from 'zlib';
import { RESUME_DOCX_MAX_CHARS, RESUME_DOCX_MAX_XML_BYTES, readResumeDocx } from './resumeDocx.js';
import { buildZip, forgedDirectory, patchDeclaredSizes, zipOf } from '../portfolio/acquire/zip.fixtures.js';

const MB = 1024 * 1024;
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
const PACKAGE_RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const para = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
const bodyXml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}</w:body></w:document>`;
const relsXml = (...items: string[]) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
const ext = (id: string, target: string) => `<Relationship Id="${id}" Type="${HYPERLINK}" Target="${target}" TargetMode="External"/>`;

/** A minimal but valid .docx. */
function docx(o: { body?: string; paragraphs?: string[]; rels?: string | null; extra?: Record<string, string | Buffer> } = {}): Buffer {
  const files: Record<string, string | Buffer> = {
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': PACKAGE_RELS,
    'word/document.xml': bodyXml(o.body ?? (o.paragraphs ?? []).map(para).join('')),
    ...(o.rels === null ? {} : { 'word/_rels/document.xml.rels': o.rels ?? relsXml() }),
    ...(o.extra ?? {}),
  };
  return zipOf(files);
}

/** A resume as Word writes it: a name, a hyperlinked portfolio, a field-coded link and a table. */
function resume(): Buffer {
  return docx({
    body: para('Jane Doe')
      + `<w:p><w:r><w:t xml:space="preserve">Portfolio: </w:t></w:r><w:hyperlink r:id="rId7"><w:r><w:t>janedoe.example</w:t></w:r></w:hyperlink></w:p>`
      + `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "https://www.behance.net/janedoe" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Behance</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
      + `<w:p><w:r><w:t>Acme Water</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>2021 - 2024</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>Led the redesign</w:t></w:r></w:p>`
      + `<w:tbl><w:tr><w:tc>${para('Skills')}</w:tc><w:tc>${para('Figma, research')}</w:tc></w:tr></w:tbl>`,
    rels: relsXml(ext('rId7', 'https://janedoe.example/work?a=1&amp;b=2')),
  });
}

describe('readResumeDocx — an ordinary resume', () => {
  it('reads the text: a blank line between paragraphs, tabs and line breaks as written, table cells as paragraphs, entities decoded', () => {
    const r = readResumeDocx(resume());
    expect(r.kind).toBe('read');
    if (r.kind !== 'read') return;
    expect(r.text).toBe('Jane Doe\n\nPortfolio: janedoe.example\n\nBehance\n\nAcme Water\t2021 - 2024\nLed the redesign\n\nSkills\n\nFigma, research\n\n');
    expect(r.linksFailed).toBe(false);
    expect(r.links).toEqual([]);                    // links were not asked for
  });

  it('with withLinks: the relationship link and the field link, each with the words it covers, in document order', () => {
    const r = readResumeDocx(resume(), { withLinks: true });
    expect(r).toMatchObject({ kind: 'read', linksFailed: false });
    if (r.kind !== 'read') return;
    expect(r.links).toEqual([
      { url: 'https://janedoe.example/work?a=1&b=2', label: 'janedoe.example' },
      { url: 'https://www.behance.net/janedoe', label: 'Behance' },
    ]);
  });

  it('a resume with no relationships part has no links, and that is not a failure', () => {
    expect(readResumeDocx(docx({ paragraphs: ['Jane Doe'], rels: null }), { withLinks: true })).toMatchObject({ kind: 'read', links: [], linksFailed: false });
  });

  it('an empty document reads as empty text, as mammoth gave', () => {
    expect(readResumeDocx(docx({ body: '' }))).toMatchObject({ kind: 'read', text: '' });
  });

  it('only the body is read, as before: a header, a footer and a deleted run are not text', () => {
    const r = readResumeDocx(docx({
      body: para('Body only') + '<w:p><w:r><w:delText>gone</w:delText></w:r></w:p>',
      extra: { 'word/header1.xml': bodyXml(para('Header text')), 'word/footer1.xml': bodyXml(para('Footer text')) },
    }));
    if (r.kind !== 'read') throw new Error('not read');
    expect(r.text).toBe('Body only\n\n\n\n');
    expect(r.text).not.toContain('Header');
  });

  it('keeps at most RESUME_DOCX_MAX_CHARS characters of text, however long the document is', () => {
    const long = Array.from({ length: 2500 }, () => para('x'.repeat(200))).join('');           // 500,000 characters of text
    const r = readResumeDocx(docx({ body: long }));
    if (r.kind !== 'read') throw new Error('not read');
    expect(r.text.length).toBeGreaterThan(RESUME_DOCX_MAX_CHARS - 300);
    expect(r.text.length).toBeLessThanOrEqual(RESUME_DOCX_MAX_CHARS + 300);
  });

  it('links are found past the text cap (the cap is on text, the walk still reaches them)', () => {
    const long = Array.from({ length: 2500 }, () => para('x'.repeat(200))).join('');
    const r = readResumeDocx(docx({ body: long + '<w:p><w:hyperlink r:id="rId7"><w:r><w:t>late</w:t></w:r></w:hyperlink></w:p>', rels: relsXml(ext('rId7', 'https://late.example')) }), { withLinks: true });
    if (r.kind !== 'read') throw new Error('not read');
    expect(r.links).toEqual([{ url: 'https://late.example', label: 'late' }]);
  });
});

describe('readResumeDocx — what is not a resume it can read is "unreadable", never an error', () => {
  it.each([
    ['empty', Buffer.alloc(0)],
    ['not an archive', Buffer.from('this is plain text, not a zip')],
    ['a PDF with a .docx name', Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n')],
    ['an old binary .doc (an OLE compound file)', Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)])],
    ['a zip that is not a Word file', zipOf({ 'readme.txt': 'hello', 'data/x.csv': 'a,b' })],
    ['a PowerPoint file', zipOf({ 'ppt/presentation.xml': '<p:presentation/>' })],
  ])('%s', (_n, bytes) => {
    expect(readResumeDocx(bytes, { withLinks: true })).toEqual({ kind: 'unreadable', why: 'not-a-docx' });
  });

  it('a password-protected archive entry is "encrypted"', () => {
    const r = readResumeDocx(buildZip([{ name: 'word/document.xml', data: 'x', flags: 0x0801 }]));
    expect(r).toEqual({ kind: 'unreadable', why: 'encrypted' });
  });

  it('a forged directory (more entries than the file can hold) is "too complex"', () => {
    const r = readResumeDocx(forgedDirectory(4000, 4000));
    expect(r.kind).toBe('unreadable');
  });

  it('a non-buffer is an unforeseen failure of OURS ("unavailable"), reported rather than thrown', () => {
    const r = readResumeDocx(null as unknown as Buffer);
    expect(r.kind).toBe('unavailable');
  });
});

describe('readResumeDocx — hostile archives are refused, and nothing larger than the cap is ever allocated', () => {
  const bombOf = (megabytes: number) => zlib.deflateRawSync(Buffer.alloc(megabytes * MB, 0x20));
  const archiveWith = (rawCompressed: Buffer, rawSize: number, extra: Record<string, string> = {}) =>
    buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES }, ...Object.entries(extra).map(([name, data]) => ({ name, data })), { name: 'word/document.xml', rawCompressed, rawSize }]);

  it.each([[40], [120]])('a .docx whose document.xml really inflates to %i MB (mammoth aborted node on the first) is "too complex", in milliseconds, without inflating it', megabytes => {
    const docxBytes = archiveWith(bombOf(megabytes), megabytes * MB);
    expect(docxBytes.length).toBeLessThan(500_000);
    const spy = vi.spyOn(zlib, 'inflateRawSync');
    const t = performance.now();
    const r = readResumeDocx(docxBytes, { withLinks: true });
    expect(performance.now() - t).toBeLessThan(500);
    expect(r).toEqual({ kind: 'unreadable', why: 'too-complex' });
    expect(spy).not.toHaveBeenCalled();             // the directory's claim alone is over the cap: not one byte is inflated
    spy.mockRestore();
  });

  it('a part that CLAIMS 400 MB is refused on its claim, without a byte of it being inflated', () => {
    const spy = vi.spyOn(zlib, 'inflateRawSync');
    // About 407,000 bytes of "compressed" data is the least a directory can claim 400 MB from (DEFLATE cannot beat about 1032:1), so the archive passes the directory checks and reaches the cap
    const r = readResumeDocx(archiveWith(Buffer.alloc(410_000, 1), 400 * MB));
    expect(r).toEqual({ kind: 'unreadable', why: 'too-complex' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a claim no DEFLATE stream could honour (400 MB from a few hundred bytes) is refused by the directory check itself', () => {
    const r = readResumeDocx(archiveWith(zlib.deflateRawSync(Buffer.from(bodyXml(para('x')))), 400 * MB));
    expect(r.kind).toBe('unreadable');
  });

  it('a part that claims LESS than it holds (a lying directory) is stopped at its own claim: nothing near its real size is allocated', () => {
    const real = Buffer.from(bodyXml(para('x'.repeat(100))).padEnd(40 * MB, ' '));
    const liar = patchDeclaredSizes(archiveWith(zlib.deflateRawSync(real), real.length), (name, size) => (name === 'word/document.xml' ? 1000 : size));
    const spy = vi.spyOn(zlib, 'inflateRawSync');
    const r = readResumeDocx(liar);
    expect(r.kind).toBe('unreadable');
    const limits = spy.mock.calls.map(c => (c[1] as { maxOutputLength?: number } | undefined)?.maxOutputLength ?? Infinity);
    expect(Math.max(...limits)).toBeLessThanOrEqual(RESUME_DOCX_MAX_XML_BYTES);
    spy.mockRestore();
  });

  it('a body just over RESUME_DOCX_MAX_XML_BYTES is refused; one just under is read', () => {
    const under = bodyXml('').padEnd(RESUME_DOCX_MAX_XML_BYTES - 10, ' ');
    const over = bodyXml('').padEnd(RESUME_DOCX_MAX_XML_BYTES + 10, ' ');
    expect(readResumeDocx(zipOf({ 'word/document.xml': under })).kind).toBe('read');
    expect(readResumeDocx(zipOf({ 'word/document.xml': over }))).toEqual({ kind: 'unreadable', why: 'too-complex' });
  });

  it('a relationships part that is a bomb costs the LINKS, not the text: the text is read and linksFailed says the links are unknown (never "none")', () => {
    const rels = buildZip([
      { name: 'word/document.xml', data: bodyXml(para('Jane Doe')) },
      { name: 'word/_rels/document.xml.rels', rawCompressed: bombOf(20), rawSize: 20 * MB },
    ]);
    const r = readResumeDocx(rels, { withLinks: true });
    expect(r).toMatchObject({ kind: 'read', linksFailed: true, links: [] });
    if (r.kind === 'read') expect(r.text).toContain('Jane Doe');
    expect(readResumeDocx(rels)).toMatchObject({ kind: 'read', linksFailed: false });         // links not asked for: nothing to fail
  });

  describe('the walk over the largest body it accepts holds this thread for a bounded, short time (the shapes that cost a regex or a DOM their lives)', () => {
    const shapes: Array<[string, () => string]> = [
      ['100,000s of unclosed <w:t tags', () => '<w:t '.repeat(1_500_000)],
      ['deeply nested paragraphs', () => '<w:p>'.repeat(1_200_000)],
      ['a million hyperlinks with unknown ids', () => '<w:hyperlink r:id="x">'.repeat(350_000)],
      ['entities everywhere', () => '<w:p><w:r><w:t>' + '&amp;&#x41;&lt;'.repeat(600_000) + '</w:t></w:r></w:p>'],
      ['field starts that never end', () => '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'.repeat(170_000)],
      ['instruction text without end', () => '<w:r><w:instrText>' + 'HYPERLINK "'.repeat(500_000)],
      ['one enormous attribute', () => `<w:hyperlink r:id="${'a'.repeat(7 * MB)}">`],
    ];
    it.each(shapes)('%s', (_n, build) => {
      const xml = (bodyXml('') .replace('</w:body></w:document>', '') + build()).slice(0, RESUME_DOCX_MAX_XML_BYTES - 16) + '</w:body></w:document>';
      const bytes = zipOf({ 'word/document.xml': xml, 'word/_rels/document.xml.rels': relsXml(ext('rId1', 'https://x.example')) });
      const t = performance.now();
      const r = readResumeDocx(bytes, { withLinks: true });
      const ms = performance.now() - t;
      expect(['read', 'unreadable']).toContain(r.kind);
      expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(2500);
    });
  });
});
