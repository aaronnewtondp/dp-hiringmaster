// Small, dependency-free text guards shared by the main API and the worker.

/**
 * Replace unpaired UTF-16 surrogates with U+FFFD. A string cut with `.slice(0, n)`
 * can end mid-emoji; `JSON.stringify` then emits a lone `\ud83d` escape, which
 * PostgreSQL's jsonb rejects ("Unicode low surrogate must follow a high
 * surrogate") — failing the whole write. Plain TEXT columns are fine (the pg
 * driver UTF-8 encodes lone surrogates as U+FFFD), jsonb is not.
 * (String.prototype.toWellFormed does this natively, but backend/tsconfig.json
 * targets ES2022 and doesn't type it.)
 */
export function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

/** JSON.stringify that can never produce an escape jsonb will refuse. */
export function jsonbSafeStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'string' ? wellFormed(v) : v));
}

const MIN_READABLE_CHARS = 50;

/**
 * Did we actually read words out of the resume? An image-only (scanned) PDF
 * "extracts" successfully to nothing but pdf-parse's page markers
 * ("-- 1 of 1 --"), so a non-null string is not evidence the resume was read.
 * Used to decide whether "no portfolio link found" is a fair verdict against
 * the candidate (it is not if we could not read anything at all).
 */
export function hasReadableText(text: string | null | undefined): boolean {
  if (!text) return false;
  const stripped = text.replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, '').replace(/\s+/g, ' ').trim();
  return stripped.length >= MIN_READABLE_CHARS;
}
