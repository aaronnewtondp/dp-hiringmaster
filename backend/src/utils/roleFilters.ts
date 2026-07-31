// Shared role-level filtering — used by GET /api/roles (the Roles summary
// view's own filters), GET /api/dashboard (the same filters promoted to
// dashboard-wide "master filters"), and the role_id dimension is additionally
// consumed directly by GET /api/applications for the Candidates page's Role
// filter. Keeping the parsing + SQL fragment in one place means these
// surfaces can never drift on what "Department = X" (or "Role = X") actually
// matches in SQL.

export interface RoleFilterParams {
  departments:      string[];
  locations:         string[];
  recruitmentModes: string[];
  priorities:       string[];
  statuses:         string[];
  roleIds:          string[];
}

// Query params arrive as a single string when exactly one value is
// selected, or an array when multiple are (both axios's default array
// serialization and Express's default `qs` parser round-trip correctly —
// verified directly against this backend's express instance).
export function toArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v === undefined || v === null || v === '') return [];
  return [String(v)];
}

export function parseRoleFilters(query: Record<string, unknown>): RoleFilterParams {
  return {
    departments:      toArray(query.department),
    locations:        toArray(query.location),
    recruitmentModes: toArray(query.recruitment_mode),
    priorities:       toArray(query.priority),
    statuses:         toArray(query.status),
    roleIds:          toArray(query.role_id),
  };
}

export function hasActiveFilters(f: RoleFilterParams): boolean {
  return f.departments.length > 0 || f.locations.length > 0 || f.recruitmentModes.length > 0
    || f.priorities.length > 0 || f.statuses.length > 0 || f.roleIds.length > 0;
}

// Builds a WHERE-clause fragment (leading " AND ...", ready to append) for a
// query that already has `roles` in scope aliased as `r`. paramOffset is the
// first $n to use — callers own their own params array, so this lets the
// fragment slot in wherever that array currently ends.
export function buildRoleFilterSql(f: RoleFilterParams, paramOffset: number): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = paramOffset;

  if (f.roleIds.length)          { clauses.push(`r.id = ANY($${i++})`); params.push(f.roleIds); }
  if (f.departments.length)      { clauses.push(`r.department = ANY($${i++})`); params.push(f.departments); }
  if (f.priorities.length)       { clauses.push(`r.priority = ANY($${i++})`); params.push(f.priorities); }
  if (f.statuses.length)         { clauses.push(`r.status = ANY($${i++})`); params.push(f.statuses); }
  if (f.recruitmentModes.length) { clauses.push(`r.recruitment_mode && $${i++}::text[]`); params.push(f.recruitmentModes); }
  if (f.locations.length) {
    // roles.location is freeform text and often a compound string ("Hyderabad,
    // Bangalore", "Hyderabad/Pune/Bangalore") — substring match per selected
    // city rather than exact match, so a role tagged with multiple cities
    // matches whichever of them the filter picks. Safe to wrap in %...% with
    // no escaping — the fixed location list never contains % or _ characters.
    clauses.push(`r.location ILIKE ANY($${i++}::text[])`);
    params.push(f.locations.map(loc => `%${loc}%`));
  }

  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

// For queries that touch applications/pending_actions but don't already
// join roles directly — wraps the same fragment as a `(SELECT id FROM roles
// r WHERE ...)` subquery for embedding as `<col> IN <sql>`. Returns null
// when no filters are active so callers can skip the subquery entirely on
// the (common) unfiltered path.
export function roleIdsSubquery(f: RoleFilterParams, paramOffset: number): { sql: string; params: unknown[] } | null {
  if (!hasActiveFilters(f)) return null;
  const { sql, params } = buildRoleFilterSql(f, paramOffset);
  return { sql: `(SELECT id FROM roles r WHERE 1=1${sql})`, params };
}
