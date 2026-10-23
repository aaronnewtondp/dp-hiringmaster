// WORKER-ONLY (see ../browser.ts). Reads Word (.docx) and PowerPoint (.pptx) files for the marketing work-sample review.
// Both are ZIP archives built by the candidate, so nothing in them is trusted — not their sizes, not their markup:
//   - the archive is opened by zip.ts, a bounded hand-written reader: entry count, names and offsets are checked up front,
//     and every part is inflated under a hard cap (per XML part, per picture, and in total) that a lying archive cannot
//     talk its way past;
//   - text is pulled out of the XML by a LINEAR tag walk (walkTags) — no backtracking regex, no DOM — so a part made of
//     100,000 unclosed tags costs the same as an honest one. (mammoth built two full DOMs of a 40 MB document.xml, and the
//     old slide regex was quadratic: a 2 KB .pptx hung the worker for hours.)
import { createHash } from 'crypto';
import { BUDGET } from './budget.js';
import { sniffType } from './fetchCapped.js';
import { BUDGET_REASON, cleanText, decodeEntities, injectionPrepared, reserveText, safeLabel, scanDocumentTextCooperatively, unread } from './pdf.js';
import type { Prepared } from './pdf.js';
import type { AcquireContext, MediaBlock } from './types.js';
import { BAD_ZIP_REASON, ZipGuardError, ZipLimitError, openZip } from './zip.js';
import type { ZipArchive, ZipEntry } from './zip.js';

/** Pictures at or below this size are logos, bullets and icons, not work. */
export const MIN_IMAGE_BYTES = 5 * 1024;
export const DOCX_MAX_IMAGES = 6;
export const PPTX_MAX_IMAGES = 8;
export const PPTX_MAX_SLIDES = 100;
/** One slide's XML. Real slides are a few KB; a megabyte of markup on one slide is not a slide. */
export const PPTX_MAX_SLIDE_XML_BYTES = 1024 * 1024;
/** All the slide XML of one deck. */
export const PPTX_MAX_TOTAL_SLIDE_XML_BYTES = 8 * 1024 * 1024;
/**
 * word/document.xml: the cap for the body part, 16 MB (the 4 MB every other XML part gets refused 3 of 118 real Word files on
 * this machine, all of them ordinary documents). The walk below is linear: measured on 16 and 32 MB of entities, unclosed and
 * deeply nested tags, CDATA, NULs, one giant attribute and picture-reference churn, every shape took under 0.8 s, and time
 * doubled with size. The archive's total (ZIP_MAX_TOTAL_INFLATED), per-entry and ratio caps are unchanged, and the text kept is
 * capped separately (DOCX_MAX_TEXT_CHARS), so a hostile body costs time, not memory.
 */
export const DOCX_MAX_XML_BYTES = 16 * 1024 * 1024;
/**
 * The most text of a document body that is collected. Nothing reads more: the injection scan looks at the first 400,000
 * characters and the review keeps 12,000. Without this, 16 MB of entities (&amp; &amp; …) made the decoder's intermediate
 * strings peak at 400 MB of heap; with it the peak stays under ~100 MB at any size. Pictures are still found past the cap.
 */
export const DOCX_MAX_TEXT_CHARS = 2_000_000;
const RELS_MAX_BYTES = 1024 * 1024;
const MAX_PICTURE_REFS = 200;
const KEPT_IMAGE_TYPES: ReadonlySet<string> = new Set(['png', 'jpeg', 'webp']);

export const ARCHIVE_REASON = 'This is an archive or an unsupported file type (for example a zip or a spreadsheet), which is not opened automatically';
export const LEGACY_OFFICE_REASON = 'Old Office format (.doc/.ppt) - ask the candidate for a PDF or a current .docx/.pptx';
const EMPTY_DOCX_REASON = 'The document has no readable text or images';
const EMPTY_PPTX_REASON = 'The presentation has no readable text or images';
const NO_SLIDES_REASON = 'The presentation has no slides';

/** The result for an archive that could not be opened: the guard's own reason, or the generic one. */
export function zipFailure(e: unknown): Prepared {
  return unread('unreviewable', e instanceof ZipGuardError ? e.reason : BAD_ZIP_REASON);
}

// ─── what is this file ───────────────────────────────────────────────────────

/** Legacy binary Office (.doc/.ppt/.xls) files start with the OLE compound-file signature. */
export function isLegacyOffice(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}

/** Decides from the archive's own entries (never its name): a Word file, a PowerPoint file, or something else. Throws ZipGuardError for a hostile archive. */
export function detectOfficeKind(bytes: Buffer): 'docx' | 'pptx' | 'archive' {
  const zip = openZip(bytes);
  if (zip.find('word/document.xml')) return 'docx';
  if (zip.find('ppt/presentation.xml')) return 'pptx';
  return 'archive';
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

// ─── a linear XML walk ───────────────────────────────────────────────────────

/**
 * What the walk tells its visitor about one tag. `open`/`gt` are the offsets of its '<' and '>', `end` is where the text
 * that follows it stops (the next '<', or the end of the string): the text content is xml.slice(gt + 1, end).
 */
type TagVisitor = (name: string, closing: boolean, selfClosing: boolean, open: number, gt: number, end: number) => void;

/**
 * Visits every tag of an XML string once, left to right, in time linear in its length. A '<' always starts a new tag
 * (XML forbids a raw '<' inside an attribute value), so a '<' that is not closed by a '>' before the next '<' is not a tag
 * and is skipped — which is also why `<a:t <a:t <a:t …` repeated a hundred thousand times costs one pass, not a hundred
 * thousand scans to the end of the string. The search for '>' resumes where the last one was found, never from scratch.
 */
function walkTags(xml: string, visit: TagVisitor): void {
  const n = xml.length;
  let open = xml.indexOf('<');
  let gt = -1;
  while (open >= 0) {
    const next = xml.indexOf('<', open + 1);
    const end = next < 0 ? n : next;
    if (gt < open) {
      gt = xml.indexOf('>', open + 1);
      if (gt < 0) return;   // no '>' anywhere after this point: nothing else in the string is a tag
    }
    if (gt < end) {
      const closing = xml.charCodeAt(open + 1) === 0x2f;
      const nameStart = open + (closing ? 2 : 1);
      let nameEnd = nameStart;
      while (nameEnd < gt) {
        const c = xml.charCodeAt(nameEnd);
        if (c <= 0x20 || c === 0x2f) break;
        nameEnd++;
      }
      visit(xml.slice(nameStart, nameEnd), closing, xml.charCodeAt(gt - 1) === 0x2f, open, gt, end);
    }
    open = next;
  }
}

/** The attributes of one tag's text (`name="value"` or `name='value'` pairs), read in one pass. First occurrence wins. */
function readAttributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const n = tag.length;
  let i = 0;
  while (i < n) {
    const eq = tag.indexOf('=', i);
    if (eq < 0) break;
    let nameStart = eq;
    while (nameStart > i && tag.charCodeAt(nameStart - 1) > 0x20) nameStart--;
    let q = eq + 1;
    while (q < n && tag.charCodeAt(q) <= 0x20) q++;
    const quote = tag[q];
    if (quote !== '"' && quote !== "'") { i = eq + 1; continue; }
    const close = tag.indexOf(quote, q + 1);
    if (close < 0) break;
    const name = tag.slice(nameStart, eq);
    if (name && !out.has(name)) out.set(name, tag.slice(q + 1, close));
    i = close + 1;
  }
  return out;
}

const attributesOf = (xml: string, open: number, gt: number) => readAttributes(xml.slice(open, gt));

// ─── Word ────────────────────────────────────────────────────────────────────

export interface DocxContent {
  /** The body text: a blank line between paragraphs, tabs and line breaks as written. */
  text: string;
  /** The relationship ids of the pictures the body points at, in document order (at most MAX_PICTURE_REFS). */
  pictureIds: string[];
}

/**
 * The text and picture references of a word/document.xml. Text is every <w:t> run, a tab for <w:tab/> (not the tab-stop
 * definitions under <w:tabs>), a newline for <w:br/> and a blank line at the end of each paragraph. The Fallback half of a
 * mc:AlternateContent is skipped: Word writes text boxes and pictures twice (a modern copy and a legacy copy) and only the
 * first is shown. Pictures are <a:blip r:embed> and the legacy <v:imagedata r:id>.
 */
export function extractDocxContent(xml: string, maxChars = DOCX_MAX_TEXT_CHARS): DocxContent {
  const out: string[] = [];
  const pictureIds: string[] = [];
  let kept = 0;
  const keep = (text: string) => { if (kept < maxChars) { out.push(text); kept += text.length; } };
  let inTabStops = false;
  let fallback = 0;
  walkTags(xml, (name, closing, selfClosing, open, gt, end) => {
    if (fallback > 0 || name === 'mc:Fallback') {
      if (name === 'mc:Fallback') fallback = Math.max(0, fallback + (closing ? -1 : selfClosing ? 0 : 1));
      return;
    }
    if (closing) {
      if (name === 'w:p') keep('\n\n');
      else if (name === 'w:tabs') inTabStops = false;
      return;
    }
    switch (name) {
      case 'w:t':
        // Only as much of the run as there is room for: the rest is never read, and decoding 15 MB of entities in one piece is what costs memory.
        if (!selfClosing && end > gt + 1 && kept < maxChars) keep(decodeEntities(xml.slice(gt + 1, Math.min(end, gt + 1 + (maxChars - kept) + 8))));
        break;
      case 'w:tab':
        if (!inTabStops) keep('\t');
        break;
      case 'w:tabs':
        if (!selfClosing) inTabStops = true;
        break;
      case 'w:br': case 'w:cr':
        keep('\n');
        break;
      case 'a:blip': case 'v:imagedata': {
        if (pictureIds.length >= MAX_PICTURE_REFS) break;
        const id = attributesOf(xml, open, gt).get(name === 'a:blip' ? 'r:embed' : 'r:id');
        if (id) pictureIds.push(id);
        break;
      }
    }
  });
  return { text: out.join(''), pictureIds };
}

/** A relationship target resolved against its source part's folder, as a package part name; null when it leaves the package or is a link. */
function resolvePartName(folder: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;   // http:, file: …: not a part of this package
  const parts = (target.startsWith('/') ? target.slice(1) : `${folder}${target}`).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!resolved.length) return null;
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.length ? resolved.join('/') : null;
}

/** Relationship id -> package part name, for the image relationships of one .rels file. */
export function imageRelationships(relsXml: string, folder: string): Map<string, string> {
  const out = new Map<string, string>();
  walkTags(relsXml, (name, closing, _selfClosing, open, gt) => {
    if (name !== 'Relationship' || closing) return;
    const a = attributesOf(relsXml, open, gt);
    const id = a.get('Id');
    const target = a.get('Target');
    if (!id || !target || !(a.get('Type') ?? '').endsWith('/image') || (a.get('TargetMode') ?? '').toLowerCase() === 'external') return;
    const part = resolvePartName(folder, target);
    if (part && !out.has(id)) out.set(id, part);
  });
  return out;
}

/** The pictures a .docx body points at, as archive entries, in document order, each once. */
function docxPictures(zip: ZipArchive, pictureIds: string[]): ZipEntry[] {
  const relsEntry = zip.find('word/_rels/document.xml.rels');
  if (!relsEntry || !pictureIds.length) return [];
  const rels = imageRelationships(zip.inflate(relsEntry, RELS_MAX_BYTES).toString('utf8'), 'word/');
  const entries: ZipEntry[] = [];
  const seen = new Set<ZipEntry>();
  for (const id of pictureIds) {
    const name = rels.get(id);
    const entry = name === undefined ? undefined : zip.find(name);
    if (entry && !entry.dir && !seen.has(entry)) {
      seen.add(entry);
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * Reads a .docx: its text plus up to DOCX_MAX_IMAGES of its pictures that are bigger than MIN_IMAGE_BYTES and really are
 * png/jpeg/webp. The injection scan runs over the whole text before anything is reserved or kept. Pictures are picked one
 * after another, so the image and byte budgets are claimed strictly and in document order.
 */
export async function prepareDocx(bytes: Buffer, label: string, ctx: AcquireContext): Promise<Prepared> {
  let raw: string;
  let zip: ZipArchive;
  let pictures: ZipEntry[];
  try {
    zip = openZip(bytes);
    const body = zip.find('word/document.xml');
    if (!body) return zipFailure(null);
    const content = extractDocxContent(zip.inflate(body, DOCX_MAX_XML_BYTES).toString('utf8'));
    raw = content.text;
    if (await scanDocumentTextCooperatively(raw)) return injectionPrepared();   // up to 400,000 characters of regex work (~400 ms in one call on real text): in windows, the event loop gets a turn between them
    pictures = docxPictures(zip, content.pictureIds);
  } catch (e) {
    return zipFailure(e);
  }

  const kept: Array<{ buf: Buffer; mime: string }> = [];
  const seen = new Set<string>();
  let moreImages = false;
  let budgetHit = false;
  let archiveCap = false;
  try {
    for (const entry of pictures) {
      if (kept.length >= DOCX_MAX_IMAGES) { moreImages = true; break; }
      // Judged by what the part declares, so a logo or an oversized file is never inflated. A part that lies is caught by inflate().
      if (entry.size <= MIN_IMAGE_BYTES || entry.size > BUDGET.maxImageBytes) continue;
      let buf: Buffer;
      try {
        buf = zip.inflate(entry, BUDGET.maxImageBytes);
      } catch (e) {
        if (e instanceof ZipLimitError) { archiveCap = true; break; }
        throw e;
      }
      const type = sniffType(buf);
      if (!KEPT_IMAGE_TYPES.has(type)) continue;
      const digest = createHash('sha1').update(buf).digest('hex');
      if (seen.has(digest)) continue;
      seen.add(digest);
      if (ctx.budget.reserveImages(1) < 1 || !ctx.budget.reserveBytes(buf.length)) { budgetHit = true; break; }
      kept.push({ buf, mime: `image/${type}` });
    }
  } catch (e) {
    return zipFailure(e);
  }

  const { text, truncated } = reserveText(cleanText(raw), ctx);
  const media: MediaBlock[] = kept.map((k, n) => ({
    kind: 'image', label: `${safeLabel(label, 100) || 'Word document'} - image ${n + 1}`, mime: k.mime, b64: k.buf.toString('base64'), bytes: k.buf.length,
  }));

  if (!text && !media.length) return unread('unreviewable', cleanText(raw) ? BUDGET_REASON : EMPTY_DOCX_REASON);

  const why: string[] = [];
  if (truncated) why.push(`the text was cut at ${text.length.toLocaleString('en-US')} characters`);
  if (moreImages) why.push(`only the first ${DOCX_MAX_IMAGES} images were included`);
  if (archiveCap) why.push('some images were left out because the file is larger than the size that is read');
  if (budgetHit) why.push("the review's image or size limit was reached");
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  return {
    outcome: why.length ? 'partial' : 'ok',
    ...(why.length ? { reason: `Only part of this document was read: ${why.join('; ')}` } : {}),
    media,
    text,
    facts: [`DOCX, ${plural(words, 'word')} read${media.length ? `, ${plural(media.length, 'image')}` : ''}`],
    injectionHit: false,
  };
}

// ─── PowerPoint ──────────────────────────────────────────────────────────────

/**
 * The text of one slide's XML, one line per paragraph: each <a:t> run is added to the current line and </a:p> ends it.
 * Every <a:t> counts, whether the shape is on the slide or parked far outside it: the model is shown all of it, so the
 * injection scan has to see all of it too. One pass (walkTags), linear however the tags are nested or left unclosed.
 */
export function extractSlideText(xml: string): string {
  const lines: string[] = [];
  let line = '';
  walkTags(xml, (name, closing, selfClosing, _open, gt, end) => {
    if (name === 'a:t' && !closing) {
      if (!selfClosing && end > gt + 1) line += decodeEntities(xml.slice(gt + 1, end));
    } else if (name === 'a:p' && closing) {
      if (line.trim()) lines.push(line.trim());
      line = '';
    }
  });
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n');
}

const slideNumber = (name: string) => Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1]);

/**
 * Reads a .pptx: the text of up to PPTX_MAX_SLIDES slides (in slideN.xml numeric order; a slide over
 * PPTX_MAX_SLIDE_XML_BYTES, or one that would take the deck past PPTX_MAX_TOTAL_SLIDE_XML_BYTES, is skipped and counted)
 * plus up to PPTX_MAX_IMAGES of the largest png/jpeg/webp pictures in ppt/media. Only the entries actually used are inflated.
 */
export async function preparePptx(bytes: Buffer, label: string, ctx: AcquireContext): Promise<Prepared> {
  let zip: ZipArchive;
  try {
    zip = openZip(bytes);
  } catch (e) {
    return zipFailure(e);
  }

  const entries = zip.entries.filter(f => !f.dir);
  const slides = entries
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f.name))
    .sort((a, b) => slideNumber(a.name) - slideNumber(b.name));
  if (!slides.length) return unread('unreviewable', NO_SLIDES_REASON);

  const sections: string[] = [];
  let slidesRead = 0;
  let skippedSlides = Math.max(0, slides.length - PPTX_MAX_SLIDES);
  let slideBytes = 0;
  try {
    for (const [i, slide] of slides.slice(0, PPTX_MAX_SLIDES).entries()) {
      if (slide.size > PPTX_MAX_SLIDE_XML_BYTES || slideBytes + slide.size > PPTX_MAX_TOTAL_SLIDE_XML_BYTES) { skippedSlides++; continue; }
      slideBytes += slide.size;
      const text = extractSlideText(zip.inflate(slide, PPTX_MAX_SLIDE_XML_BYTES).toString('utf8'));
      slidesRead++;
      if (text) sections.push(`[slide ${i + 1}]\n${text}`);
    }
  } catch (e) {
    return zipFailure(e);
  }
  const rawText = sections.join('\n\n');
  if (await scanDocumentTextCooperatively(rawText)) return injectionPrepared();   // as for a .docx: windows, never one long stall

  // Biggest first: the large pictures are the artwork, the small ones are decoration.
  const pictures = entries
    .filter(f => /^ppt\/media\/[^/]+\.(png|jpe?g|webp)$/i.test(f.name))
    .filter(f => f.size > MIN_IMAGE_BYTES && f.size <= BUDGET.maxImageBytes)
    .sort((a, b) => b.size - a.size);
  const granted = ctx.budget.reserveImages(Math.min(PPTX_MAX_IMAGES, pictures.length));
  const kept: Array<{ buf: Buffer; mime: string }> = [];
  let byteBudgetHit = false;
  let archiveCap = false;
  try {
    for (const picture of pictures.slice(0, granted)) {
      let buf: Buffer;
      try {
        buf = zip.inflate(picture, BUDGET.maxImageBytes);
      } catch (e) {
        if (e instanceof ZipLimitError) { archiveCap = true; break; }
        throw e;
      }
      const type = sniffType(buf);
      if (!KEPT_IMAGE_TYPES.has(type)) continue;
      if (!ctx.budget.reserveBytes(buf.length)) { byteBudgetHit = true; break; }
      kept.push({ buf, mime: `image/${type}` });
    }
  } catch (e) {
    return zipFailure(e);
  }

  const { text, truncated } = reserveText(cleanText(rawText), ctx);
  const media: MediaBlock[] = kept.map((k, n) => ({
    kind: 'image', label: `${safeLabel(label, 100) || 'Presentation'} - image ${n + 1}`, mime: k.mime, b64: k.buf.toString('base64'), bytes: k.buf.length,
  }));
  if (!text && !media.length) return unread('unreviewable', cleanText(rawText) ? BUDGET_REASON : EMPTY_PPTX_REASON);

  const why: string[] = [];
  if (truncated) why.push(`the text was cut at ${text.length.toLocaleString('en-US')} characters`);
  if (skippedSlides > 0) why.push(`${plural(skippedSlides, 'slide')} could not be read`);
  const imagesLeftOut = pictures.length - kept.length;
  if (imagesLeftOut > 0) why.push(`${kept.length} of ${pictures.length} images were included`);
  if (archiveCap) why.push('some images were left out because the file is larger than the size that is read');
  if (byteBudgetHit) why.push("the review's size limit was reached");
  const imagePart = pictures.length ? `, ${plural(kept.length, 'image')}${imagesLeftOut > 0 ? ` of ${pictures.length}` : ''}` : '';
  return {
    outcome: why.length ? 'partial' : 'ok',
    ...(why.length ? { reason: `Only part of this presentation was read: ${why.join('; ')}` } : {}),
    media,
    text,
    facts: [`PPTX, ${plural(slidesRead, 'slide')} read${imagePart}`],
    injectionHit: false,
    pagesReviewed: slidesRead,
  };
}
