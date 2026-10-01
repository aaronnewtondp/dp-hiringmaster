// A rejection can carry several reasons. The API stores them in the existing
// applications.rejection_reason_cat column as ONE string joined with this
// delimiter — mirrors backend/src/utils/rejectionReasons.ts (separate packages,
// so it can't be a shared import; the backend strips ';' out of every reason so
// splitting is always lossless).
export const REASON_DELIMITER = '; ';

export function splitReasons(stored: string | null | undefined): string[] {
  if (!stored) return [];
  return stored.split(REASON_DELIMITER.trim()).map(s => s.trim()).filter(Boolean);
}
