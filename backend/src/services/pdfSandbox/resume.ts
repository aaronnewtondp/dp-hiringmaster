// SHARED (main API). Reads ONE candidate's resume PDF for ResumeIQ — its text and its link annotations — without ever running pdfjs on this process.
// A resume is uploaded by a candidate through the public Job Application Form, exactly like a work sample, and `pdf-parse`/pdfjs has no operation, time or
// memory governance of its own: a few KB of hostile PDF starved the Node event loop for 15-40+ s (so no JS timeout could fire) or aborted node outright with
// an out-of-memory. Parsed on the main thread of api/index.ts, that wedges every request the function is serving. So:
//   1. preflightPdfAsync (preflight.ts) looks at the bytes first — bounded, deterministic, and it hands the event loop back every 20 ms — and refuses what it
//      recognises as a bomb ("too complex") without starting anything;
//   2. whatever it lets through is parsed by readPdfInSandbox (sandbox.ts): a child PROCESS with a heap cap, a hard 12 s deadline and a resident-memory
//      watchdog, which the parent can kill; nothing the file does can reach this process.
// Result: a file is READ, or it is not, and either way the caller carries on. This function never throws and never blocks the event loop for more than a slice.
//
// What "not read" means to the caller (driveService.ts maps it, resumeIQTrigger.ts acts on it):
//   - 'unreadable'  — a verdict on the FILE (too complex, too large, password-protected, not a PDF). Neutral: scoring falls back to the profile fields, and an
//                     unreadable resume applies NO portfolio dimension (never a 0).
//   - 'unavailable' — OUR failure (the child could not be started, a module or pdf.worker.mjs missing, a queue of other PDFs used up the time). Never a verdict
//                     on the candidate; the caller records it as a retryable failure where there is somewhere to record it.
import { preflightPdfAsync } from './preflight.js';
import { PDF_PARSE_MS, isLoadFailure, isPasswordError, readPdfInSandbox } from './sandbox.js';
import type { PdfReadOptions, PdfReadResult, PdfReader } from './sandbox.js';

/** Pages whose text is read. Real resumes are 1-4 pages; a CV with publications, 10-20. A longer file is read as far as this and no further (it was all of them). */
export const RESUME_MAX_PAGES = 40;
/**
 * The largest resume that is opened. Real resumes are a few hundred KB (a scanned one, a few MB). The pre-flight's allowances are calibrated for files up to 8 MB
 * (the work-sample review's limit), and a file that big and complex is simply refused by them; this stops a file of hundreds of MB from ever being held in memory
 * and walked (driveService.ts also asks Drive for the size before it downloads anything).
 */
export const RESUME_MAX_BYTES = 20 * 1024 * 1024;
/** The whole read, including time spent waiting behind other PDFs (the sandbox runs one at a time per process). The function has 60 s and scoring needs most of the rest. */
export const RESUME_READ_MS = 25_000;
/** pdfjs finds "%PDF-" anywhere in the first 1024 bytes (a producer may write a few bytes before it). */
const HEADER_WINDOW = 1024;

export type ResumePdfRead =
  /** `text` is pdf-parse's own format (each page followed by "-- N of T --"), so an image-only PDF is page markers alone: see hasReadableText. */
  | { kind: 'read'; text: string; links: Array<{ url: string; label?: string }>; linksFailed: boolean }
  | { kind: 'unreadable'; why: 'too-complex' | 'too-large' | 'password' | 'not-a-pdf' }
  | { kind: 'unavailable'; message: string };

/** The seams the tests substitute; production passes none. */
export interface ResumePdfHooks {
  reader?: PdfReader;
  options?: Partial<PdfReadOptions>;
  /** The whole read's budget in ms (default RESUME_READ_MS). */
  budgetMs?: number;
}

/** pdf-parse's joined text, rebuilt from the pages the child returned: `<page text>\n\n-- <n> of <total> --\n\n` for each page. */
export function joinPages(pages: Array<{ num: number; text: string }>, total: number): string {
  return pages.map(p => `${p.text}\n\n-- ${p.num} of ${total} --\n\n`).join('');
}

function fromResult(result: PdfReadResult, withLinks: boolean): ResumePdfRead {
  switch (result.kind) {
    case 'read': {
      // total < 1: a PDF with no pages reads as empty text, as pdf-parse always did.
      const pages = Number.isInteger(result.total) && result.total >= 1 ? result.pages : [];
      return {
        kind: 'read',
        text: joinPages(pages, result.total),
        links: withLinks ? (result.links ?? []).map(l => ({ url: l.url, ...(l.text ? { label: l.text } : {}) })) : [],
        linksFailed: withLinks && result.linksFailed === true,
      };
    }
    case 'timeout':
      // Cut off by the whole read's own budget (waiting behind other files used it up) is not the file's doing; cut off by the per-PDF cap is.
      return result.limitedBy === 'item' ? { kind: 'unavailable', message: 'The PDF reader ran out of time on this file' } : { kind: 'unreadable', why: 'too-complex' };
    case 'too-complex':
      return { kind: 'unreadable', why: 'too-complex' };
    case 'unavailable':
      return { kind: 'unavailable', message: result.message };
    case 'parser-error':
      if (isPasswordError(result)) return { kind: 'unreadable', why: 'password' };
      if (isLoadFailure(result)) return { kind: 'unavailable', message: result.message };   // e.g. "Setting up fake worker failed": pdf.worker.mjs is not in the bundle
      return { kind: 'unreadable', why: 'not-a-pdf' };
  }
}

/** Reads one downloaded resume PDF. Never throws. `withLinks`: also return the link annotations (the designer-portfolio roles need them). */
export async function readResumePdf(bytes: Buffer, o: { withLinks?: boolean } = {}, hooks: ResumePdfHooks = {}): Promise<ResumePdfRead> {
  const withLinks = o.withLinks === true;
  try {
    if (bytes.length > RESUME_MAX_BYTES) return { kind: 'unreadable', why: 'too-large' };
    if (!bytes.subarray(0, HEADER_WINDOW).includes('%PDF-')) return { kind: 'unreadable', why: 'not-a-pdf' };

    const deadline = Date.now() + (hooks.budgetMs ?? RESUME_READ_MS);
    // A file that declares an encryption dictionary has streams that are ciphertext, so the pre-flight cannot bound it ('encrypted'). Many ordinary resumes are
    // "encrypted" only to forbid editing or printing (an empty user password): pdfjs reads those, and so did this code before, so they go to the sandbox, which does
    // not depend on the pre-flight to be safe. Only a file the pre-flight calls COMPLEX is refused here.
    const flight = await preflightPdfAsync(bytes, undefined, deadline);
    if (!flight.ok && flight.why === 'complex') return { kind: 'unreadable', why: 'too-complex' };

    const read = hooks.reader ?? readPdfInSandbox;
    const result = await read(bytes, { maxPages: RESUME_MAX_PAGES, withLinks, deadline, capMs: PDF_PARSE_MS, ...hooks.options });
    return fromResult(result, withLinks);
  } catch (e) {
    // The pre-flight's own pass was stopped because the whole budget had passed (PassAbandonedError), or something this module did not foresee: the file was not
    // read, and nothing here knows why, so it is not held against the candidate.
    const name = (e as { name?: unknown } | null)?.name;
    if (name === 'PassAbandonedError') return { kind: 'unreadable', why: 'too-complex' };
    return { kind: 'unavailable', message: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
