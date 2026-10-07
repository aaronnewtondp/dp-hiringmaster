// Mirrors backend/src/utils/hiringManagers.ts — keep the delimiter rule identical. A role's Hiring Manager field can list
// several people ("Mandeep Dagar, Piyush Negi"); a user is one of the role's Hiring Managers when their whole name matches
// any entry (case- and edge-space-insensitive; "Amit" is not "Amit Gosain").

const DELIMITER = /\s*(?:,|;|&|\sand\s)\s*/i;

export function splitHiringManagerNames(field: string | null | undefined): string[] {
  if (!field) return [];
  return field.split(DELIMITER).map(n => n.trim()).filter(Boolean);
}

const norm = (s: string) => s.trim().toLowerCase();

export function isNamedHiringManager(userName: string | null | undefined, field: string | null | undefined): boolean {
  if (!userName || !userName.trim()) return false;
  const me = norm(userName);
  return splitHiringManagerNames(field).some(n => norm(n) === me);
}

export const HIRING_MANAGER_FIELD_HINT = 'Separate several people with a comma — each one is a Hiring Manager of this role.';
