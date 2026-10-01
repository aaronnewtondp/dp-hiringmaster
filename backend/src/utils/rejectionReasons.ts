// A rejection can now carry several reasons. They are stored in the existing
// applications.rejection_reason_cat TEXT column as one delimited string (so no
// schema change, and every older client/test that sends or reads a single
// reason keeps working unchanged) and split back apart by the UI.
//
// This file is the single place that defines the delimiter and the cleaning
// rules, so the format cannot drift between the route that writes it and the
// code that reads it (frontend/src/utils/rejectionReasons.ts mirrors REASON_DELIMITER).

export const REASON_DELIMITER = '; ';

const MAX_REASONS = 12;
const MAX_REASON_LENGTH = 200;

function clean(reason: unknown): string {
  if (typeof reason !== 'string') return '';
  // A ';' inside a reason would be mistaken for the delimiter when split back apart.
  return reason.replace(/;/g, ',').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH);
}

/**
 * Accepts the new array form (`many`) and/or the legacy single-string form
 * (`single`) and returns a clean, de-duplicated list. The array wins when it
 * has anything in it; otherwise the single string is used. Never throws on
 * junk input — an unusable value just yields an empty list, which the route
 * turns into the normal "a reason is required" 400.
 */
export function normalizeReasons(many: unknown, single?: unknown): string[] {
  const raw: unknown[] = Array.isArray(many) ? many : (typeof many === 'string' ? [many] : []);
  const fromMany = unique(raw.map(clean));
  if (fromMany.length) return fromMany.slice(0, MAX_REASONS);
  const one = clean(single);
  return one ? [one] : [];
}

function unique(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of list) {
    if (!r) continue;
    const key = r.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export function joinReasons(reasons: string[]): string {
  return reasons.join(REASON_DELIMITER);
}

export function splitReasons(stored: string | null | undefined): string[] {
  if (!stored) return [];
  return stored.split(REASON_DELIMITER.trim()).map(s => s.trim()).filter(Boolean);
}
