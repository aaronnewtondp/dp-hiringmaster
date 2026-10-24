import { describe, it, expect } from 'vitest';
import { DOCX_MAX_LINKS, DOCX_MAX_LINK_CHARS, extractDocxHyperlinks, hyperlinkOfInstruction, hyperlinkRelationships } from './docx.js';

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const doc = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}</w:body></w:document>`;
const run = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const rels = (...items: string[]) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
const ext = (id: string, target: string) => `<Relationship Id="${id}" Type="${HYPERLINK}" Target="${target}" TargetMode="External"/>`;

/** A complex field as Word writes it: begin, the instruction, separate, the shown words, end. */
const field = (instruction: string, shown: string) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">${instruction}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run(shown)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;

describe('hyperlinkRelationships — the destinations of a document\'s external hyperlink relationships', () => {
  it('keeps external hyperlinks by id, decodes &amp; in the target, and ignores everything else', () => {
    const map = hyperlinkRelationships(rels(
      ext('rId1', 'https://janedoe.example/work?a=1&amp;b=2'),
      ext('rId2', 'mailto:jane@example.com'),
      `<Relationship Id="rId3" Type="${IMAGE}" Target="media/image1.png"/>`,
      `<Relationship Id="rId4" Type="${HYPERLINK}" Target="#bookmark"/>`,                       // not external: a place inside the document
      `<Relationship Id="rId5" Type="${HYPERLINK}" Target="https://x.example" TargetMode="Internal"/>`,
      `<Relationship Type="${HYPERLINK}" Target="https://noid.example" TargetMode="External"/>`,
      `<Relationship Id="rId6" Type="${HYPERLINK}" TargetMode="External"/>`,
    ));
    expect([...map]).toEqual([['rId1', 'https://janedoe.example/work?a=1&b=2'], ['rId2', 'mailto:jane@example.com']]);
  });

  it('TargetMode is case-insensitive, the first of a duplicated id wins, and a destination is cut at DOCX_MAX_LINK_CHARS', () => {
    const map = hyperlinkRelationships(rels(
      `<Relationship Id="a" Type="${HYPERLINK}" Target="https://first.example" TargetMode="external"/>`,
      ext('a', 'https://second.example'),
      ext('b', `https://long.example/${'x'.repeat(5000)}`),
    ));
    expect(map.get('a')).toBe('https://first.example');
    expect(map.get('b')).toHaveLength(DOCX_MAX_LINK_CHARS);
  });

  it('is linear on a file of a hundred thousand relationships and reads only the first few thousand', () => {
    const xml = rels(...Array.from({ length: 100_000 }, (_, i) => ext(`r${i}`, `https://x.example/${i}`)));
    const t = performance.now();
    const map = hyperlinkRelationships(xml);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(map.size).toBe(5000);
  });

  it('garbage in, nothing out', () => {
    expect([...hyperlinkRelationships('')]).toEqual([]);
    expect([...hyperlinkRelationships('<Relationship Id="x" Type="')]).toEqual([]);
    expect([...hyperlinkRelationships('not xml at all <<< >>>')]).toEqual([]);
  });
});

describe('hyperlinkOfInstruction — the destination of a HYPERLINK field', () => {
  it.each([
    [' HYPERLINK "https://janedoe.example/work" ', 'https://janedoe.example/work'],
    ['HYPERLINK "https://a.example/?x=1&y=2"', 'https://a.example/?x=1&y=2'],
    ['hyperlink "https://lower.example"', 'https://lower.example'],
    [' HYPERLINK https://unquoted.example/path ', 'https://unquoted.example/path'],
    [' HYPERLINK "https://t.example" \\o "A tooltip" ', 'https://t.example'],
    [' HYPERLINK \\o "A tooltip" "https://switch-first.example" ', 'https://switch-first.example'],
    [' HYPERLINK "mailto:jane@example.com" ', 'mailto:jane@example.com'],
  ])('%j -> %j', (instruction, url) => {
    expect(hyperlinkOfInstruction(instruction)).toBe(url);
  });

  it.each([
    [' HYPERLINK \\l "bookmark" '],                    // a link inside the document
    [' HYPERLINK \\l bookmark '],
    [' PAGEREF _Toc123 \\h '],
    [' REF bookmark \\h '],
    [' HYPERLINK '],
    [' HYPERLINK "" '],
    [''],
    ['TOC \\o "1-3" \\h \\z \\u'],
  ])('%j is not an external link', instruction => {
    expect(hyperlinkOfInstruction(instruction)).toBeNull();
  });

  it('a destination followed by a \\l place is still a link to that destination (the reader follows the address, not the place in it)', () => {
    expect(hyperlinkOfInstruction(' HYPERLINK "https://x.example/page" \\l "part" ')).toBe('https://x.example/page');
  });

  it('never reads more than it needs of a very long instruction', () => {
    const url = hyperlinkOfInstruction(` HYPERLINK "https://x.example/${'a'.repeat(100_000)}" `);
    expect(url === null || url.length <= DOCX_MAX_LINK_CHARS).toBe(true);   // either refused (the quote never closes within what is read) or cut: never the whole 100,000
  });
});

describe('extractDocxHyperlinks — the links of a Word body', () => {
  const targets = new Map([['rId1', 'https://janedoe.example/work'], ['rId2', 'https://www.behance.net/janedoe'], ['rId3', 'mailto:jane@example.com']]);

  it('<w:hyperlink r:id> resolves through the relationships, with the words it covers, in document order', () => {
    const links = extractDocxHyperlinks(doc(
      `<w:p>${run('Portfolio: ')}<w:hyperlink r:id="rId1" w:history="1">${run('janedoe.example')}</w:hyperlink></w:p>`
      + `<w:p><w:hyperlink r:id="rId2">${run('Be')}${run('hance')}</w:hyperlink>${run(' and ')}<w:hyperlink r:id="rId3">${run('email me')}</w:hyperlink></w:p>`), targets);
    expect(links).toEqual([
      { url: 'https://janedoe.example/work', label: 'janedoe.example' },
      { url: 'https://www.behance.net/janedoe', label: 'Behance' },
      { url: 'mailto:jane@example.com', label: 'email me' },
    ]);
  });

  it('the words are collapsed to single spaces, trimmed, cut at 80 characters, and decoded; a link that covers no words has an empty label', () => {
    const links = extractDocxHyperlinks(doc(
      `<w:hyperlink r:id="rId1">${run('  My   &amp;   Work  ')}${run('\n')}</w:hyperlink>`
      + `<w:hyperlink r:id="rId2">${run('w'.repeat(500))}</w:hyperlink>`
      + `<w:hyperlink r:id="rId3"><w:r><w:drawing/></w:r></w:hyperlink>`), targets);
    expect(links.map(l => l.label)).toEqual(['My & Work', 'w'.repeat(80), '']);
  });

  it('a link inside the document (an anchor, an unknown id, a self-closing tag) is not a hyperlink to anywhere', () => {
    expect(extractDocxHyperlinks(doc(
      `<w:hyperlink w:anchor="_Toc1">${run('Contents')}</w:hyperlink>`
      + `<w:hyperlink r:id="rId99">${run('unknown id')}</w:hyperlink>`
      + `<w:hyperlink r:id="rId1"/>`
      + `<w:hyperlink>${run('no target at all')}</w:hyperlink>`), targets)).toEqual([]);
  });

  it('text OUTSIDE a link is not its label, and deleted text is not text', () => {
    const links = extractDocxHyperlinks(doc(
      `<w:p>${run('before ')}<w:hyperlink r:id="rId1">${run('inside')}<w:r><w:delText>deleted</w:delText></w:r></w:hyperlink>${run(' after')}</w:p>`), targets);
    expect(links).toEqual([{ url: 'https://janedoe.example/work', label: 'inside' }]);
  });

  describe('HYPERLINK fields (Word\'s older form, and what pasting from a web page leaves behind)', () => {
    it('the link is the instruction\'s destination and its label the words between the separator and the end', () => {
      expect(extractDocxHyperlinks(doc(`<w:p>${field(' HYPERLINK "https://janedoe.example/work" ', 'My Portfolio')}</w:p>`), new Map())).toEqual([
        { url: 'https://janedoe.example/work', label: 'My Portfolio' },
      ]);
    });

    it('an instruction written across several runs is joined', () => {
      const xml = doc(`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPER</w:instrText></w:r><w:r><w:instrText>LINK "https://split.example/a" </w:instrText></w:r>`
        + `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('Split')}${run(' link')}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`);
      expect(extractDocxHyperlinks(xml, new Map())).toEqual([{ url: 'https://split.example/a', label: 'Split link' }]);
    });

    it('fields that are not hyperlinks, or are links inside the document, add nothing and do not disturb the ones around them', () => {
      const xml = doc(`<w:p>${field(' PAGEREF _Toc1 \\h ', '3')}${field(' HYPERLINK \\l "_Toc2" ', 'Skills')}${field(' HYPERLINK "https://after.example" ', 'After')}</w:p>`);
      expect(extractDocxHyperlinks(xml, new Map())).toEqual([{ url: 'https://after.example', label: 'After' }]);
    });

    it('a field nested in a field keeps each one\'s own words', () => {
      const inner = field(' PAGEREF _Toc1 ', '5');
      const xml = doc(`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "https://outer.example" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('see page ')}${inner}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`);
      const links = extractDocxHyperlinks(xml, new Map());
      expect(links).toHaveLength(1);
      expect(links[0].url).toBe('https://outer.example');
      expect(links[0].label).toContain('see page');
    });

    it('a field with no separator has no shown words and, as Word never writes one, is not a link', () => {
      const xml = doc(`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "https://nosep.example" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`);
      expect(extractDocxHyperlinks(xml, new Map())).toEqual([]);
    });

    it('thousands of unclosed field starts cost one pass, and the stray ends after them do not take another field\'s link', () => {
      const xml = doc(`<w:p>${'<w:r><w:fldChar w:fldCharType="begin"/></w:r>'.repeat(5000)}${'<w:r><w:fldChar w:fldCharType="end"/></w:r>'.repeat(5001)}${field(' HYPERLINK "https://ok.example" ', 'ok')}</w:p>`);
      const t = performance.now();
      const links = extractDocxHyperlinks(xml, new Map());
      expect(performance.now() - t).toBeLessThan(1500);
      expect(links).toEqual([{ url: 'https://ok.example', label: 'ok' }]);
    });
  });

  it('the Fallback half of mc:AlternateContent is skipped: Word writes a link in a text box twice and only the first is shown', () => {
    const xml = doc(`<w:p><mc:AlternateContent><mc:Choice Requires="wps"><w:hyperlink r:id="rId1">${run('shown')}</w:hyperlink></mc:Choice>`
      + `<mc:Fallback><w:hyperlink r:id="rId2">${run('legacy copy')}</w:hyperlink></mc:Fallback></mc:AlternateContent></w:p>`);
    expect(extractDocxHyperlinks(xml, targets)).toEqual([{ url: 'https://janedoe.example/work', label: 'shown' }]);
  });

  it('keeps at most DOCX_MAX_LINKS links (or the number asked for), and a million of them is one linear pass', () => {
    const many = doc(`<w:p>${'<w:hyperlink r:id="rId1"><w:r><w:t>x</w:t></w:r></w:hyperlink>'.repeat(50_000)}</w:p>`);
    const t = performance.now();
    expect(extractDocxHyperlinks(many, targets)).toHaveLength(DOCX_MAX_LINKS);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(extractDocxHyperlinks(many, targets, 3)).toHaveLength(3);
  });

  it('unclosed hyperlinks and tags that never end cost one pass and return what was complete', () => {
    const xml = doc(`<w:hyperlink r:id="rId1">${run('closed')}</w:hyperlink>${'<w:hyperlink r:id="rId2"><w:r><w:t>'.repeat(100_000)}`);
    const t = performance.now();
    const links = extractDocxHyperlinks(xml, targets);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(links[0]).toEqual({ url: 'https://janedoe.example/work', label: 'closed' });
  });

  it('garbage in, nothing out', () => {
    expect(extractDocxHyperlinks('', targets)).toEqual([]);
    expect(extractDocxHyperlinks('<w:hyperlink r:id="rId1"', targets)).toEqual([]);
    expect(extractDocxHyperlinks('plain text, no tags at all', targets)).toEqual([]);
  });
});
