// Mirrors backend/src/utils/hiringManagers.ts — keep the rule IDENTICAL (the backend's parity spec runs both). A role's
// Hiring Manager field can list several people ("Mandeep Dagar, Piyush Negi", separated by a comma, semicolon, ampersand or
// the word "and"); a user is one of the role's Hiring Managers when their whole name matches any entry (case- and
// whitespace-insensitive; "Amit" is not "Amit Gosain"), or equals the entire field (the old single-name rule).
// Whitespace runs are collapsed to one space first, so nothing below can backtrack on a long run of blanks.

const MAX_EXAMINED_LENGTH = 1000;
const WHITESPACE_RUN = /[\s\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;
const collapse = (s: string) => s.replace(WHITESPACE_RUN, ' ').trim();
const comparable = (s: string) => collapse(s).toLowerCase();

export function splitHiringManagerNames(field: string | null | undefined): string[] {
  if (!field) return [];
  return collapse(String(field).slice(0, MAX_EXAMINED_LENGTH))
    .replace(/ ?[;&] ?/g, ',')
    .replace(/ ?, ?/g, ',')
    .replace(/(^|,)and /gi, '$1')
    .replace(/ and /gi, ',')
    .split(',')
    .map(n => n.trim())
    .filter(Boolean);
}

export function isNamedHiringManager(userName: string | null | undefined, field: string | null | undefined): boolean {
  if (!userName || !field) return false;
  const me = comparable(userName);
  if (!me) return false;
  if (comparable(String(field).slice(0, MAX_EXAMINED_LENGTH)) === me) return true;
  return splitHiringManagerNames(field).some(n => comparable(n) === me);
}

export const HIRING_MANAGER_FIELD_HINT =
  'Several people? Separate them with a comma, as "First Last, First Last" — each one is a Hiring Manager of this role.';
