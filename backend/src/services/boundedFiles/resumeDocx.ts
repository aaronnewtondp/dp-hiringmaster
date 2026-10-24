// SHARED (main API). Reads ONE candidate's resume .docx for ResumeIQ — its text and its hyperlinks — through the BOUNDED zip reader (zip.ts) and the linear XML walk,
// never through mammoth. A .docx is a ZIP the candidate built, and mammoth can be told neither "stop at N bytes" nor "stop at N seconds": measured on 2026-10-23, a 123 KB
// archive whose word/document.xml inflates to 40 MB made mammoth.extractRawText abort node ("JavaScript heap out of memory", SIGABRT, 4.2 s, 1.65 GB; 120 MB the same),
// and a 25 KB one with an 8 MB part cost 641 MB resident. Here the same files are refused in under a millisecond, because nothing is inflated that the caller did not allow:
// the archive's directory is checked before anything is read, `word/document.xml` is inflated under RESUME_DOCX_MAX_XML_BYTES (and a part that lies about its size is refused),
// and the walk that pulls the text out is linear however the tags are nested or left unclosed. No child process is needed: a bounded read can simply refuse.
//
// What "not read" means to the caller (driveService.ts maps it, exactly as for a PDF — pdfSandbox/resume.ts):
//   - 'unreadable'  — a verdict on the FILE (too complex or too large to open safely, not a Word file, password-protected). Neutral: scoring falls back to the profile fields, and an
//                     unreadable resume applies NO portfolio dimension (never a 0).
//   - 'unavailable' — OUR failure (something this module did not foresee). Never a verdict on the candidate.
// Only word/document.xml (the body) and its relationship part are read, as mammoth did: headers, footers and pictures never are.
import { DOCX_MAX_LINKS, extractDocxContent, extractDocxHyperlinks, hyperlinkRelationships } from './docx.js';
import { BAD_ZIP_REASON, ENCRYPTED_ZIP_REASON, TOO_MANY_ENTRIES_REASON, ZipGuardError, ZipLimitError, openZip } from './zip.js';

/**
 * The largest word/document.xml opened. A real resume's body is 20-300 KB; 8 MB is a very large document, and the walk over it is linear (measured at about 50 ms per MB of
 * text, so one hostile 8 MB part holds this process's thread for about 0.4 s at the very worst: the same order as one slice of the PDF pre-flight's allowance, never an abort).
 */
export const RESUME_DOCX_MAX_XML_BYTES = 8 * 1024 * 1024;
/** The most text kept: about 40 dense pages, as many as a resume PDF is read to (its text was unbounded under mammoth). */
export const RESUME_DOCX_MAX_CHARS = 200_000;
/** The relationship part: a few hundred bytes in a real file. */
const RELS_MAX_BYTES = 1024 * 1024;
const BODY_PART = 'word/document.xml';
const RELS_PART = 'word/_rels/document.xml.rels';

export type ResumeDocxRead =
  | { kind: 'read'; text: string; links: Array<{ url: string; label?: string }>; linksFailed: boolean }
  | { kind: 'unreadable'; why: 'too-complex' | 'not-a-docx' | 'encrypted' }
  | { kind: 'unavailable'; message: string };

/** Reads one downloaded resume .docx. Synchronous and bounded; never throws. `withLinks`: also return the hyperlinks (the designer-portfolio roles need them). */
export function readResumeDocx(bytes: Buffer, o: { withLinks?: boolean } = {}): ResumeDocxRead {
  try {
    const zip = openZip(bytes, { maxTotalInflated: RESUME_DOCX_MAX_XML_BYTES + RELS_MAX_BYTES });
    const body = zip.find(BODY_PART);
    if (!body) return { kind: 'unreadable', why: 'not-a-docx' };
    const xml = zip.inflate(body, RESUME_DOCX_MAX_XML_BYTES).toString('utf8');
    const text = extractDocxContent(xml, RESUME_DOCX_MAX_CHARS).text;

    let links: Array<{ url: string; label?: string }> = [];
    let linksFailed = false;
    if (o.withLinks) {
      // The words of the text are already in hand; a failure here is about the LINKS only: the text is kept, and the caller is told the links are unknown (never "none").
      try {
        const relsEntry = zip.find(RELS_PART);
        const targets = relsEntry ? hyperlinkRelationships(zip.inflate(relsEntry, RELS_MAX_BYTES).toString('utf8')) : new Map<string, string>();
        links = extractDocxHyperlinks(xml, targets, DOCX_MAX_LINKS).map(l => ({ url: l.url, ...(l.label ? { label: l.label } : {}) }));
      } catch {
        linksFailed = true;
      }
    }
    return { kind: 'read', text, links, linksFailed };
  } catch (e) {
    if (e instanceof ZipLimitError) return { kind: 'unreadable', why: 'too-complex' };
    if (e instanceof ZipGuardError) {
      if (e.reason === ENCRYPTED_ZIP_REASON) return { kind: 'unreadable', why: 'encrypted' };
      if (e.reason === TOO_MANY_ENTRIES_REASON) return { kind: 'unreadable', why: 'too-complex' };
      return { kind: 'unreadable', why: e.reason === BAD_ZIP_REASON ? 'not-a-docx' : 'too-complex' };
    }
    return { kind: 'unavailable', message: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
