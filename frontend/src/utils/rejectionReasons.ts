// A rejection can carry several reasons. The API stores them in the existing
// applications.rejection_reason_cat column as ONE string joined with this
// delimiter — mirrors backend/src/utils/rejectionReasons.ts (separate packages,
// so it can't be a shared import; the backend strips ';' out of every reason so
// splitting is always lossless).
export const REASON_DELIMITER = '; ';

/**
 * Request fields for a status change that carries reasons. Sends the new array AND the
 * older single string (the same '; '-joined text the server would build). Frontend and
 * backend are separate Vercel projects that deploy independently: a backend that doesn't
 * know `rejection_reason_cats` yet would otherwise answer every rejection with "a reason is
 * required". The new backend prefers the array and ignores the string; an old one stores
 * the string — identical result either way.
 */
export function reasonFields(reasons: string[]): { rejection_reason_cats?: string[]; rejection_reason_cat?: string } {
  if (!reasons.length) return {};
  return { rejection_reason_cats: reasons, rejection_reason_cat: reasons.join(REASON_DELIMITER) };
}

export function splitReasons(stored: string | null | undefined): string[] {
  if (!stored) return [];
  return stored.split(REASON_DELIMITER.trim()).map(s => s.trim()).filter(Boolean);
}
