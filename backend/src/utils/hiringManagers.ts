// A role's Hiring Manager is the free-text roles.hiring_manager_name matched against a user's name — there is no
// user FK, and every rule that depends on it (compensation visibility, the Hiring Manager dashboard lock, My Tasks,
// the Hiring Manager's SLA count) goes through the helpers below. A role can have SEVERAL Hiring Managers: list them in
// that same field, separated by a comma, semicolon, ampersand or the word "and" — "Mandeep Dagar, Piyush Negi". Each
// listed person is then a Hiring Manager of the role in every sense; nothing else about the field changed (it is still
// one text column, still what the role forms and the requisition ingest write, still displayed as typed).
//
// Write names "First Last, First Last". A comma always separates people, so a surname-first "Gosain, Amit" reads as two
// people ("Gosain" and "Amit").
//
// SLA rows: slaChecker copies the whole field into pending_actions.responsible_person every sweep, and the Hiring Manager
// queue matches a name inside that column, so each listed person sees them. 'HM shortlist review' rows are written once,
// outside the sweep — PATCH /roles/:id refreshes their responsible_person when the field changes.
//
// The rule exists three times and must stay identical: here (TypeScript), namedHiringManagerSql below (Postgres), and
// frontend/src/utils/hiringManagers.ts. tests/db/11-co-hiring-managers.spec.ts runs all three over one table of cases.
//
// Matching is deliberately a SUPERSET of the old whole-string equality: a user whose name equals the entire field still
// matches, so no existing single-name role can lose a Hiring Manager because of this.
//
// Performance: the field is user-written. Whitespace runs are collapsed to ONE space first (linear), and every later
// pattern only ever sees single spaces, so nothing here can backtrack quadratically on a long run of blanks; input is also
// never examined past MAX_EXAMINED_LENGTH characters.

/** Never look at more than this many characters of a field. */
const MAX_EXAMINED_LENGTH = 1000;
/** The longest value a write may store. */
export const MAX_HIRING_MANAGER_FIELD_LENGTH = 300;

// Plain \s plus the invisible separators that arrive when a name is pasted from Slack, Docs or a web page (no-break
// space, en/em spaces, zero-width space, ideographic space, BOM). Postgres' \s follows the database locale and misses
// several of these, so the SQL below spells the same class out instead of trusting \s.
const WHITESPACE_RUN = /[\s\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;
const collapse = (s: string) => s.replace(WHITESPACE_RUN, ' ').trim();
const comparable = (s: string) => collapse(s).toLowerCase();

/** The individual names in a hiring_manager_name value: in the order written, original case, blanks dropped. */
export function splitHiringManagerNames(field: string | null | undefined): string[] {
  if (!field) return [];
  return collapse(String(field).slice(0, MAX_EXAMINED_LENGTH))
    .replace(/ ?[;&] ?/g, ',')            // ; and &  ->  ,
    .replace(/ ?, ?/g, ',')               // no blanks around a comma
    .replace(/(^|,)and /gi, '$1')         // "A, and B" and a leading "and A"
    .replace(/ and /gi, ',')              // "A and B"  (a whole word: "Sandeep Anand" is untouched)
    .split(',')
    .map(n => n.trim())
    .filter(Boolean);
}

/** The canonical way to write a field: "Mandeep Dagar, Piyush Negi". */
export function canonicalHiringManagerField(field: string | null | undefined): string {
  return splitHiringManagerNames(field).join(', ');
}

/** Is `userName` one of the people named in `field`? Whole-name, case- and whitespace-insensitive — "Amit" is not "Amit Gosain". */
export function isNamedHiringManager(userName: string | null | undefined, field: string | null | undefined): boolean {
  if (!userName || !field) return false;
  const me = comparable(userName);
  if (!me) return false;
  if (comparable(String(field).slice(0, MAX_EXAMINED_LENGTH)) === me) return true;     // the old rule, kept as-is
  return splitHiringManagerNames(field).some(n => comparable(n) === me);
}

/** Validates and canonicalises a hiring_manager_name that is about to be stored. A blank value is allowed (clears the field). */
export function normalizeHiringManagerInput(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'hiring_manager_name must be text' };
  if (raw.length > 4 * MAX_HIRING_MANAGER_FIELD_LENGTH) {
    return { ok: false, error: `Hiring Manager is too long (at most ${MAX_HIRING_MANAGER_FIELD_LENGTH} characters)` };
  }
  const names = splitHiringManagerNames(raw);
  if (names.length === 0) {
    return collapse(raw) === '' ? { ok: true, value: '' } : { ok: false, error: 'Hiring Manager must name at least one person' };
  }
  const value = names.join(', ');
  if (value.length > MAX_HIRING_MANAGER_FIELD_LENGTH) {
    return { ok: false, error: `Hiring Manager is too long (at most ${MAX_HIRING_MANAGER_FIELD_LENGTH} characters)` };
  }
  return { ok: true, value };
}

// ── Postgres twin ─────────────────────────────────────────────────────────────────────────────────────────────────
// Same steps, same order, as splitHiringManagerNames / isNamedHiringManager. `\\` below is one backslash in the SQL text.
const WS_CLASS = '[\\s\\u00a0\\u1680\\u2000-\\u200b\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+';
const collapseSql = (expr: string) => `btrim(regexp_replace(${expr}, '${WS_CLASS}', ' ', 'g'))`;
const examinedSql = (column: string) => `left(${column}::text, ${MAX_EXAMINED_LENGTH})`;

function namesArraySql(column: string): string {
  const base = `lower(${collapseSql(examinedSql(column))})`;
  const semicolonsAndAmpersands = `regexp_replace(${base}, ' ?[;&] ?', ',', 'g')`;
  const commas = `regexp_replace(${semicolonsAndAmpersands}, ' ?, ?', ',', 'g')`;
  const leadingAnd = `regexp_replace(${commas}, '(^|,)and ', '\\1', 'g')`;
  const middleAnd = `regexp_replace(${leadingAnd}, ' and ', ',', 'g')`;
  return `string_to_array(${middleAnd}, ',')`;
}

/**
 * SQL for "the user named by parameter `param` (e.g. '$1') is one of the Hiring Managers in column `column`" — the
 * database twin of isNamedHiringManager. `column` and `param` must be constants chosen by the caller, never user input.
 * NULL-safe: a NULL column never matches.
 */
export function namedHiringManagerSql(column: string, param: string): string {
  const me = `lower(${collapseSql(`${param}::text`)})`;
  const whole = `lower(${collapseSql(examinedSql(column))})`;
  return `(${me} <> '' AND (${whole} = ${me} OR ${me} = ANY(${namesArraySql(column)})))`;
}
