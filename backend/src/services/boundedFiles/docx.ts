// SHARED (the portfolio worker and the main API). Reads the parts of a Word file that matter, from the XML strings of an archive the BOUNDED zip reader (zip.ts) has already
// opened: the text, the pictures it points at, and (for resumes) the hyperlinks. Pure functions over strings; nothing here touches the archive or the disk.
// extractDocxContent and imageRelationships moved here from portfolio/acquire/office.ts on 2026-10-23, unchanged; portfolio/acquire/office.ts re-exports them.
import { attributesOf, decodeEntities, walkTags } from './xml.js';

/**
 * The most text of a document body that is collected. Nothing reads more: the injection scan looks at the first 400,000
 * characters and the review keeps 12,000. Without this, 16 MB of entities (&amp; &amp; …) made the decoder's intermediate
 * strings peak at 400 MB of heap; with it the peak stays under ~100 MB at any size. Pictures are still found past the cap.
 */
export const DOCX_MAX_TEXT_CHARS = 2_000_000;
const MAX_PICTURE_REFS = 200;

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


// ─── hyperlinks (resumes) ────────────────────────────────────────────────────

/** A hyperlink of a Word body: where it points, and the words it covers (whitespace collapsed, at most 80 characters; '' when it covers none). */
export interface DocxLink { url: string; label: string }

/** Hyperlinks kept from one document, and the longest destination. A real resume has a handful; the walk itself is linear whatever the file holds. */
export const DOCX_MAX_LINKS = 200;
export const DOCX_MAX_LINK_CHARS = 2048;
/** Relationships read from one .rels file (the rest of a file made of nothing but relationships is not looked at). */
const MAX_RELATIONSHIPS = 5000;
/** Characters of a link's words collected before they are collapsed and cut to 80; nothing reads more. */
const LABEL_COLLECT_CHARS = 240;
/** Fields (Word's `HYPERLINK "…"` is one) open at once; a deeper one is not tracked, and its end is not mistaken for another's. */
const MAX_FIELD_DEPTH = 16;

/** Relationship id -> destination, for the EXTERNAL hyperlink relationships of one .rels file (a link to a place inside the document has none). */
export function hyperlinkRelationships(relsXml: string): Map<string, string> {
  const out = new Map<string, string>();
  let seen = 0;
  walkTags(relsXml, (name, closing, _selfClosing, open, gt) => {
    if (name !== 'Relationship' || closing || ++seen > MAX_RELATIONSHIPS) return;
    const a = attributesOf(relsXml, open, gt);
    const id = a.get('Id');
    const target = a.get('Target');
    if (!id || !target || !(a.get('Type') ?? '').endsWith('/hyperlink') || (a.get('TargetMode') ?? '').toLowerCase() !== 'external') return;
    if (!out.has(id)) out.set(id, decodeEntities(target).slice(0, DOCX_MAX_LINK_CHARS));
  });
  return out;
}

/** The destination of a field instruction such as ` HYPERLINK "https://a.example" ` (Word's older, and a pasted, form of a link); null for anything else, and for a link inside the document (\l). */
export function hyperlinkOfInstruction(instruction: string): string | null {
  const m = /^\s*HYPERLINK\s+((?:\\[a-z]\s+(?:"[^"]*"\s+)?)*)(?:"([^"]+)"|([^\s"\\]+))/i.exec(instruction.slice(0, DOCX_MAX_LINK_CHARS + 64));
  if (!m) return null;
  if (/\\l\b/i.test(m[1] ?? '')) return null;
  const url = (m[2] ?? m[3] ?? '').trim();
  return url ? url.slice(0, DOCX_MAX_LINK_CHARS) : null;
}

const tidyLabel = (raw: string) => raw.replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * The hyperlinks of a word/document.xml, in document order: `<w:hyperlink r:id="…">` resolved through `targets` (hyperlinkRelationships of
 * word/_rels/document.xml.rels; one whose id is unknown, or that has only a `w:anchor`, is a link inside the document and is skipped), and
 * complex fields whose instruction is `HYPERLINK "…"` (the words between the field's separator and its end). The words a link covers are its
 * <w:t> runs. Like extractDocxContent it is one linear walk, skips the Fallback half of mc:AlternateContent, and reads each run only as far as
 * it needs: a document of a million links costs one pass and keeps `maxLinks`.
 */
export function extractDocxHyperlinks(xml: string, targets: Map<string, string>, maxLinks = DOCX_MAX_LINKS): DocxLink[] {
  const links: DocxLink[] = [];
  let anchor: { url: string; label: string } | null = null;
  interface Field { instruction: string; url: string | null; label: string; inResult: boolean }
  const fields: Field[] = [];
  let untracked = 0;
  let fallback = 0;
  const add = (url: string, label: string) => { if (links.length < maxLinks) links.push({ url, label: tidyLabel(label) }); };
  walkTags(xml, (name, closing, selfClosing, open, gt, end) => {
    if (fallback > 0 || name === 'mc:Fallback') {
      if (name === 'mc:Fallback') fallback = Math.max(0, fallback + (closing ? -1 : selfClosing ? 0 : 1));
      return;
    }
    if (closing) {
      if (name === 'w:hyperlink' && anchor) { add(anchor.url, anchor.label); anchor = null; }
      return;
    }
    switch (name) {
      case 'w:hyperlink': {
        if (selfClosing) break;
        const id = attributesOf(xml, open, gt).get('r:id');
        const url = id === undefined ? undefined : targets.get(id);
        anchor = url ? { url, label: '' } : null;
        break;
      }
      case 'w:instrText':
        if (!selfClosing && end > gt + 1) {
          const top = fields[fields.length - 1];
          if (top && !top.inResult && top.instruction.length < DOCX_MAX_LINK_CHARS + 64 && untracked === 0) top.instruction += decodeEntities(xml.slice(gt + 1, Math.min(end, gt + 1 + DOCX_MAX_LINK_CHARS + 64)));
        }
        break;
      case 'w:fldChar': {
        const type = attributesOf(xml, open, gt).get('w:fldCharType');
        if (type === 'begin') {
          if (fields.length >= MAX_FIELD_DEPTH) untracked++;
          else fields.push({ instruction: '', url: null, label: '', inResult: false });
        } else if (type === 'separate') {
          const top = untracked === 0 ? fields[fields.length - 1] : undefined;
          if (top && !top.inResult) { top.inResult = true; top.url = hyperlinkOfInstruction(top.instruction); }
        } else if (type === 'end') {
          if (untracked > 0) { untracked--; break; }
          const done = fields.pop();
          if (done?.url) add(done.url, done.label);
        }
        break;
      }
      case 'w:t': {
        if (selfClosing || end <= gt + 1) break;
        const wantAnchor = anchor !== null && anchor.label.length < LABEL_COLLECT_CHARS;
        const field = fields.length ? fields[fields.length - 1] : undefined;
        const wantField = untracked === 0 && field !== undefined && field.inResult && field.url !== null && field.label.length < LABEL_COLLECT_CHARS;
        if (!wantAnchor && !wantField) break;
        const text = decodeEntities(xml.slice(gt + 1, Math.min(end, gt + 1 + LABEL_COLLECT_CHARS)));
        if (wantAnchor) anchor!.label += text;
        if (wantField) field!.label += text;
        break;
      }
    }
  });
  return links;
}
