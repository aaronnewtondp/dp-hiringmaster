import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import zlib from 'node:zlib';
import { renderLongFormJd } from './longFormJd.js';
import { extractPdfText } from '../driveService.js';
import {
  ABOUT_DP_BULLETS, LONG_JD_FOOTER_NOTE, APPLICATION_FORM_URL, HEADER_TAGLINE, FOOTER_CONTACT, LONG_JD_COLORS, WHY_ICON_KEYS, WhyIconKey,
} from './theme.js';
import { Role } from '../../types/index.js';
import { JdContent } from '../jdContent.js';

// The long-form JD is rendered for every approved role. Layout regressions (a missing section, the wrong variant colour, a footer that falls off) are invisible
// until someone opens the PDF, so each rendered file is read back: its text is extracted with the same helper socialJd.test.ts uses, and its content streams are
// inflated where a colour has to be checked. Only Date is faked (pdfkit stamps a creation date and derives the file id from it), which makes a render
// byte-for-byte repeatable. All data below is synthetic.
// Real PDF renders and a pdf.js text extraction: well inside a second each, but not under the 5 s default when the whole suite contends for CPU.
vi.setConfig({ testTimeout: 30_000 });

const plain = (markup: string) => markup.replace(/<\/?b>/g, '');
const squash = (s: string) => s.replace(/\s+/g, '').replace(/[‘’]/g, "'");

const bullets = (n: number, label: string) =>
  Array.from({ length: n }, (_, i) => `${label} item ${i + 1} with <b>bold part</b> and a few more words so that the line wraps inside its column`);
const why = (keys: WhyIconKey[]) => keys.map((k, i) => ({ iconKey: k, title: `Why ${k} title`, description: `Reason number ${i + 1} written as one short sentence.`, isGreen: i % 2 === 1 }));

const role = (over: Partial<Role> = {}): Role => ({
  id: 'R900', title: 'Synthetic Backend Engineer', department: 'Engineering', location: 'Pune', employment_type: 'Full-Time', yoe_required: '5-8', ...over,
} as unknown as Role);

const content = (over: Partial<JdContent> = {}): JdContent => ({
  variant: 'tech',
  tags: [{ text: 'Python', isGreen: false }, { text: 'Time Series', isGreen: true }],
  aboutRoleParagraph: 'You will <b>own</b> the synthetic data platform end to end.',
  highlightQuote: 'A <b>synthetic</b> highlight that the box has to wrap.',
  keyResponsibilities: ['Build the ingestion pipeline', 'Keep it observable'],
  mustHaves: ['Five years of Python', 'SQL fluency'],
  goodToHaves: ['Kafka exposure', 'IoT background'],
  goodToHaveLabel: 'Good to Have',
  whyJoinUs: why(['pay', 'impact', 'growth', 'team']),
  socialAboutRole: [], socialAboutYou: [],
  ...over,
} as JdContent);

const MAX_CONTENT = content({
  tags: Array.from({ length: 8 }, (_, i) => ({ text: `Skill Number ${i + 1}`, isGreen: i % 2 === 1 })),
  aboutRoleParagraph: 'You will <b>own</b> a synthetic platform. ' + 'A sentence that adds length to the paragraph. '.repeat(40),
  keyResponsibilities: bullets(7, 'Responsibility'),
  mustHaves: bullets(8, 'Must have'),
  goodToHaves: bullets(8, 'Good to have'),
});

const pages = (buf: Buffer) => (buf.toString('latin1').match(/\/Type \/Page(?![a-z])/g) ?? []).length;
// Every Flate content stream, inflated, joined.
function streams(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let out = ''; let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) { try { out += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1') + '\n'; } catch { /* not a Flate stream (an image) */ } }
  return out;
}
// The Info dictionary string for a key (pdfkit writes it as an indirect object holding "(text)").
function info(buf: Buffer, key: string): string | null {
  const raw = buf.toString('latin1');
  const ref = new RegExp(`/${key} (\\d+) 0 R`).exec(raw);
  if (!ref) return null;
  const obj = new RegExp(`\\n${ref[1]} 0 obj\\n\\(([\\s\\S]*?)\\)\\nendobj`).exec(raw);
  if (!obj) return null;
  const bytes = Buffer.from(obj[1], 'latin1');
  // pdfkit writes a string with any non-ASCII character as UTF-16BE behind a byte-order mark.
  return bytes[0] === 0xfe && bytes[1] === 0xff ? Buffer.from(bytes.subarray(2)).swap16().toString('utf16le') : obj[1];
}
// "r g b scn" as pdfkit writes a fill colour.
const fill = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `${((n >> 16) & 255) / 255} ${((n >> 8) & 255) / 255} ${(n & 255) / 255} scn`;
};

const cache = new Map<string, Buffer>();
async function render(r: Role, c: JdContent, key?: string): Promise<Buffer> {
  if (key && cache.has(key)) return cache.get(key)!;
  const buf = await renderLongFormJd(r, c);
  if (key) cache.set(key, buf);
  return buf;
}
const textCache = new Map<Buffer, string>();
async function text(buf: Buffer): Promise<string> {
  if (!textCache.has(buf)) textCache.set(buf, squash(await extractPdfText(buf)));
  return textCache.get(buf)!;
}
const textOf = async (r: Role, c: JdContent, key?: string) => text(await render(r, c, key));

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-29T12:00:00Z')); });
afterAll(() => { vi.useRealTimers(); });

describe('renderLongFormJd: the file', () => {
  it('is an A4 PDF with real content', async () => {
    const buf = await render(role(), content(), 'basic');
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.subarray(-8).toString('latin1')).toContain('%%EOF');
    expect(buf.length).toBeGreaterThan(20_000);
    expect(buf.toString('latin1')).toMatch(/\/MediaBox \[\s*0\s+0\s+595\.28\s+841\.89\s*\]/);
  });

  it('is repeatable: the same input gives the same bytes', async () => {
    const a = await renderLongFormJd(role(), content());
    const b = await renderLongFormJd(role(), content());
    expect(a.equals(b)).toBe(true);
  });

  it('embeds the logo image and uses the standard Helvetica and Courier faces (no embedded fonts)', async () => {
    const raw = (await render(role(), content(), 'basic')).toString('latin1');
    expect(raw).toContain('/Subtype /Image');
    expect(raw).toMatch(/\/BaseFont \/Helvetica-Bold/);
    expect(raw).toMatch(/\/BaseFont \/Courier-Bold/);
    expect(raw).not.toContain('/FontFile');
  });

  it('puts the role title and the author in the document properties; an empty title falls back to "Job Description"', async () => {
    const buf = await render(role({ title: 'Synthetic Backend Engineer' }), content(), 'basic');
    expect(info(buf, 'Title')).toBe('Synthetic Backend Engineer');
    expect(info(buf, 'Author')).toBe('DigitalPaani');
    expect(info(await render(role({ title: '' }), content()), 'Title')).toBe('Job Description');
  });

  it('renders content with every list empty and no quote (the renderer never assumes a section has items)', async () => {
    const buf = await render(
      role(), content({ tags: [], aboutRoleParagraph: '', highlightQuote: null, keyResponsibilities: [], mustHaves: [], goodToHaves: [] }), 'empty');
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(buf)).toBe(1);
    const t = await text(buf);
    for (const label of ['ABOUTTHEROLE', 'KEYRESPONSIBILITIES', 'MUSTHAVES', 'GOODTOHAVE', 'WHYJOINUS']) expect(t).toContain(label);
  });

  it('needs exactly four whyJoinUs items: finalizeJdContent guarantees four, and the 2x2 grid fails loudly on fewer', async () => {
    await expect(renderLongFormJd(role(), content({ whyJoinUs: why(['pay', 'impact']) }))).rejects.toThrow(TypeError);
  });

  it('a one-page JD stays on one page and maximum-length content (8 tags, 7 responsibilities, 8 + 8 requirements) runs onto a second but no more than a third', async () => {
    expect(pages(await render(role(), content(), 'basic'))).toBe(1);
    const n = pages(await render(role(), MAX_CONTENT, 'max'));
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(3);
  });
});

describe('renderLongFormJd: what is printed', () => {
  it('the title, the subtitle (department · location · type) and every section heading', async () => {
    const t = await textOf(role(), content(), 'basic');
    expect(t).toContain('SyntheticBackendEngineer');
    expect(t).toContain('Engineering·Pune·Full-Time');
    for (const label of ['ABOUTDIGITALPAANI', 'ABOUTTHEROLE', 'KEYRESPONSIBILITIES', 'MUSTHAVES', 'GOODTOHAVE', 'WHYJOINUS']) expect(t).toContain(label);
  });

  it('every must-have, good-to-have and key-responsibility bullet, in full, with the <b> markup consumed', async () => {
    const t = await textOf(role(), MAX_CONTENT, 'max');
    for (const list of [MAX_CONTENT.keyResponsibilities, MAX_CONTENT.mustHaves, MAX_CONTENT.goodToHaves]) {
      for (const item of list) expect(t).toContain(squash(plain(item)));
    }
    expect(t).not.toContain('<b>');
    expect(t).not.toContain('</b>');
  });

  it('the apply link and the fixed footer: form URL note, running header tagline, contact line and page number', async () => {
    const t = await textOf(role(), content(), 'basic');
    expect(t).toContain(squash(plain(LONG_JD_FOOTER_NOTE)));
    expect(t).toContain(squash(APPLICATION_FORM_URL));
    expect(t).toContain(squash(HEADER_TAGLINE));
    expect(t).toContain(squash(FOOTER_CONTACT));
    expect(t).toContain('Page1');
  });

  it('a second page carries the running footer too ("Page 2")', async () => {
    const t = await textOf(role(), MAX_CONTENT, 'max');
    expect(t).toContain('Page1');
    expect(t).toContain('Page2');
  });

  it('the five fixed "About DigitalPaani" bullets are always there, the same on every role', async () => {
    const t = await textOf(role(), content(), 'basic');
    for (const b of ABOUT_DP_BULLETS) expect(t).toContain(squash(plain(b)));
    const other = await textOf(role({ title: 'Other Role', department: 'Operations' }), content({ variant: 'infra' }));
    for (const b of ABOUT_DP_BULLETS) expect(other).toContain(squash(plain(b)));
  });

  it('the about-the-role paragraph and the highlight quote (printed inside quotation marks) when there is one', async () => {
    const t = await textOf(role(), content(), 'basic');
    expect(t).toContain('Youwillownthesyntheticdataplatformendtoend.');
    expect(t).toContain('"Asynthetichighlightthattheboxhastowrap."');
  });

  it('no quote box at all when highlightQuote is null', async () => {
    const t = await textOf(role(), content({ highlightQuote: null }));
    expect(t).not.toContain('"A');
    expect(t).not.toContain('highlightthatthebox');
  });

  it('a <b> that is never closed is printed literally (the markup is only read as a matched pair)', async () => {
    const t = await textOf(role(), content({ aboutRoleParagraph: 'Stray <b>open tag only' }));
    expect(t).toContain('Stray<b>opentagonly');
  });

  describe('the requirements label', () => {
    it('"Good to Have" prints as that heading', async () => {
      const t = await textOf(role(), content({ goodToHaveLabel: 'Good to Have' }), 'basic');
      expect(t).toContain('GOODTOHAVE');
      expect(t).not.toContain('WHOYOUARE');
    });
    it('"Who You Are" replaces it', async () => {
      const t = await textOf(role(), content({ goodToHaveLabel: 'Who You Are' }));
      expect(t).toContain('WHOYOUARE');
      expect(t).not.toContain('GOODTOHAVE');
    });
  });

  it('unequal requirement lists (3 must-haves, 8 good-to-haves) both print completely', async () => {
    const must = bullets(3, 'Alpha'); const good = bullets(8, 'Beta');
    const t = await textOf(role(), content({ mustHaves: must, goodToHaves: good }));
    for (const item of [...must, ...good]) expect(t).toContain(squash(plain(item)));
  });
});

describe('renderLongFormJd: the header card', () => {
  it('tags print in capitals; more tags than fit one row wrap onto further rows and none is lost', async () => {
    const tags = Array.from({ length: 20 }, (_, i) => ({ text: `Wrapping Tag ${i + 1}`, isGreen: i % 3 === 0 }));
    const t = await textOf(role(), content({ tags }));
    for (const tag of tags) expect(t).toContain(squash(tag.text.toUpperCase()));
  });

  it('with no tags the card still renders', async () => {
    const buf = await render(role(), content({ tags: [] }));
    expect(pages(buf)).toBe(1);
    expect(await text(buf)).toContain('SyntheticBackendEngineer');
  });

  describe('the meta row falls back, field by field, to a stated default', () => {
    const bare = role({ location: null, employment_type: null, department: null, yoe_required: null } as unknown as Partial<Role>);
    it.each(['LocationTBD', 'Full-Time', 'ExperienceTBD', 'General'])('missing data prints %s', async expected => {
      expect(await textOf(bare, content())).toContain(expected);
    });
    it('with every optional field missing the subtitle line is empty (no stray separators)', async () => {
      const t = await textOf(bare, content());
      expect(t).not.toContain('··');
    });
    it('a subtitle skips the parts that are missing', async () => {
      const t = await textOf(role({ department: null, location: 'Pune', employment_type: 'Contract' } as unknown as Partial<Role>), content());
      expect(t).toContain('Pune·Contract');
      expect(t).not.toContain('·Pune');
    });
    it('a role with no title is "Untitled Role"', async () => {
      expect(await textOf(role({ title: '' }), content())).toContain('UntitledRole');
    });
  });

  describe('experience is labelled "<n> Experience" unless the text already says years', () => {
    it.each([
      ['5-8', '5-8Experience'],
      ['3+', '3+Experience'],
      ['5-8 years', '5-8years'],
      ['3+ Years', '3+Years'],
      ['1 Year', '1Year'],
    ])('%j prints as %s', async (yoe, expected) => {
      const t = await textOf(role({ yoe_required: yoe }), content());
      expect(t).toContain(expected);
    });
    it('and the words are not doubled when years is already there', async () => {
      const t = await textOf(role({ yoe_required: '5-8 years' }), content());
      expect(t).not.toContain('yearsExperience');
    });
  });
});

describe('renderLongFormJd: the variant sets the header gradient', () => {
  const firstTop = (v: 'tech' | 'infra') => fill(v === 'tech' ? LONG_JD_COLORS.headerTech[0] : LONG_JD_COLORS.headerInfra[0]);

  it('tech uses the blue gradient and not the green one', async () => {
    const s = streams(await render(role(), content({ variant: 'tech' }), 'tech'));
    expect(s).toContain(firstTop('tech'));
    expect(s).not.toContain(firstTop('infra'));
  });

  it('infra uses the green gradient and not the blue one', async () => {
    const s = streams(await render(role(), content({ variant: 'infra' }), 'infra'));
    expect(s).toContain(firstTop('infra'));
    expect(s).not.toContain(firstTop('tech'));
  });

  it('the two variants differ only in the header: the same text comes out', async () => {
    expect(await text(await render(role(), content({ variant: 'tech' }), 'tech'))).toBe(await text(await render(role(), content({ variant: 'infra' }), 'infra')));
  });
});

const ICON_GROUPS: WhyIconKey[][] = [
  ['pay', 'impact', 'growth', 'team'],
  ['startup', 'mission', 'domain', 'influence'],
  ['ownership', 'learn', 'pay', 'impact'],
];

describe('renderLongFormJd: the Why Join Us grid', () => {
  it('prints all four titles and descriptions', async () => {
    const items = why(['startup', 'mission', 'domain', 'influence']);
    const t = await textOf(role(), content({ whyJoinUs: items }));
    for (const it of items) { expect(t).toContain(squash(it.title)); expect(t).toContain(squash(it.description)); }
  });

  it.each(ICON_GROUPS.map(g => [g]))('every icon draws without error: %j', async keys => {
    const buf = await render(role(), content({ whyJoinUs: why(keys) }));
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await text(buf)).toContain(squash(`Why ${keys[3]} title`));
  });

  it('the groups above cover every icon key in theme.ts (a new icon must be added to a group)', () => {
    expect([...new Set(ICON_GROUPS.flat())].sort()).toEqual([...WHY_ICON_KEYS].sort());
  });

  it('the dollar sign of the pay icon is drawn as text (it cannot sit inside the mirrored group)', async () => {
    expect(await textOf(role(), content({ whyJoinUs: why(['pay', 'impact', 'growth', 'team']) }))).toContain('$');
  });
});
