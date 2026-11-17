// One rule for `candidates.full_name`, used by every path that creates or edits a candidate. The column is TEXT NOT NULL with no length limit (by
// design: the cap is application-level, no CHECK, no migration), and the name feeds the gender classifier, the name masking/signal of the marketing
// review and every list. The frontend keeps a twin of the number (frontend/src/utils/candidateName.ts), pinned by crossPackageTwins.test.ts.

/** Longest full name, counted in characters (code points: an emoji is one). */
export const FULL_NAME_MAX_CHARS = 200;

/** Trim and collapse every run of whitespace (no-break space and ideographic space included) to one space. Non-text is ''. */
export function collapseName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim();
}

export type NameCheck =
  | { ok: true; name: string }
  | { ok: false; reason: 'empty' | 'too_long' };

/** USER-FACING paths (POST/PATCH /api/candidates): clean the name, and refuse (the caller answers 400) one that is empty/not text or over the cap. Never cuts. */
export function checkFullName(raw: unknown): NameCheck {
  const name = collapseName(raw);
  if (!name) return { ok: false, reason: 'empty' };
  if (Array.from(name).length > FULL_NAME_MAX_CHARS) return { ok: false, reason: 'too_long' };
  return { ok: true, name };
}

/**
 * MACHINE paths (the public form through Apps Script, the Naukri import): never reject an applicant for a long name. Cleans, then cuts to the cap on a
 * code-point boundary (a surrogate pair is never split), backing up to the last space when that costs less than half the name so a word is not cut in
 * two. Returns null only when there is no name at all (empty, whitespace, or not text/number). Logs once when something was cut (the length only,
 * never the name).
 */
export function truncateFullName(raw: unknown, source = 'ingest'): string | null {
  const name = collapseName(typeof raw === 'number' ? String(raw) : raw);
  if (!name) return null;
  const chars = Array.from(name);
  if (chars.length <= FULL_NAME_MAX_CHARS) return name;
  let cut = chars.slice(0, FULL_NAME_MAX_CHARS);
  if (chars[FULL_NAME_MAX_CHARS] !== ' ') {
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace >= FULL_NAME_MAX_CHARS / 2) cut = cut.slice(0, lastSpace);
  }
  console.warn(`[candidate name] ${source}: full_name of ${chars.length} characters truncated to ${FULL_NAME_MAX_CHARS}`);
  return cut.join('').trimEnd();
}
