// A role's Hiring Manager is the free-text roles.hiring_manager_name matched against a user's name — there is no
// user FK, and every rule that depends on it (compensation visibility, the Hiring Manager dashboard lock, My Tasks,
// SLA attribution) goes through the helpers below. A role can have SEVERAL Hiring Managers: list them in that same
// field, separated by a comma, semicolon, ampersand or the word "and" — "Mandeep Dagar, Piyush Negi". Each listed
// person is then a Hiring Manager of the role in every sense; nothing else about the field changed (it is still one
// text column, still what the role forms and the requisition ingest write, still displayed as typed).
//
// SLA rows need no special handling: slaChecker copies the whole field into pending_actions.responsible_person, and the
// Hiring Manager queue already matches a name as a substring of that column, so each listed person sees the row.
//
// frontend/src/utils/hiringManagers.ts mirrors the delimiter rule — change them together.

/** Matches one delimiter between names, with the whitespace around it. */
const DELIMITER = /\s*(?:,|;|&|\sand\s)\s*/i;

/** The individual names in a hiring_manager_name value: trimmed, blanks dropped, in the order written. */
export function splitHiringManagerNames(field: string | null | undefined): string[] {
  if (!field) return [];
  return field.split(DELIMITER).map(n => n.trim()).filter(Boolean);
}

const norm = (s: string) => s.trim().toLowerCase();

/** Is `userName` one of the people named in `field`? Whole-name, case- and edge-space-insensitive — "Amit" is not "Amit Gosain". */
export function isNamedHiringManager(userName: string | null | undefined, field: string | null | undefined): boolean {
  if (!userName || !userName.trim()) return false;
  const me = norm(userName);
  return splitHiringManagerNames(field).some(n => norm(n) === me);
}

/**
 * SQL for "the user named by parameter `param` (e.g. '$1') is one of the Hiring Managers in column `column`",
 * the database twin of isNamedHiringManager. The regex is the same delimiter rule as DELIMITER above (Postgres ARE).
 */
export function namedHiringManagerSql(column: string, param: string): string {
  // trim(param) <> '' mirrors isNamedHiringManager: a blank user name must never match a blank entry in the field.
  return `(trim(${param}) <> '' AND lower(trim(${param})) = ANY(regexp_split_to_array(lower(trim(${column})), '\\s*(,|;|&|\\sand\\s)\\s*')))`;
}
