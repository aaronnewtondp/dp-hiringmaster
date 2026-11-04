import { describe, it, expect, vi, beforeEach } from 'vitest';

// roleFilters decides which rows every dashboard metric and the Hiring Manager role lock can see. The pure builders are
// tested directly; applyHiringManagerRoleLock is tested with the database answered from canned rows.
const query = vi.fn();
vi.mock('../db/index.js', () => ({
  query: (...a: unknown[]) => query(...a),
  queryOne: vi.fn(),
}));

import {
  toArray, parseRoleFilters, hasActiveFilters, buildRoleFilterSql, roleIdsSubquery,
  applyHiringManagerRoleLock, type RoleFilterParams,
} from './roleFilters.js';
import { namedHiringManagerSql } from './hiringManagers.js';
import type { JwtPayload } from '../types/index.js';

const empty = (): RoleFilterParams => ({
  departments: [], locations: [], recruitmentModes: [], priorities: [], statuses: [], roleIds: [],
});

const user = (persona: JwtPayload['persona'], name = 'Test Manager'): JwtPayload => ({
  userId: 'U9001', email: 'manager@example.test', persona, name,
});

beforeEach(() => { query.mockReset(); });

describe('toArray (query-string value to string[])', () => {
  it.each([
    ['a single string becomes a one-element array', 'a', ['a']],
    ['an array is kept in order', ['a', 'b'], ['a', 'b']],
    ['numbers inside an array are stringified', ['a', 1, 2.5], ['a', '1', '2.5']],
    ['a bare number is stringified', 7, ['7']],
    ['the empty string means "no value", not [""]', '', []],
    ['undefined means no value', undefined, []],
    ['null means no value', null, []],
    ['an empty array stays empty', [], []],
    ['an array keeps its own empty strings (only a bare "" is dropped)', ['', 'a'], ['', 'a']],
    ['zero is a value, not "no value"', 0, ['0']],
    ['false is a value, not "no value"', false, ['false']],
  ])('%s', (_name, input, expected) => {
    expect(toArray(input)).toEqual(expected);
  });
});

describe('parseRoleFilters (which query-string key feeds which filter)', () => {
  it('maps each query key to its own filter, and role_id to roleIds', () => {
    const f = parseRoleFilters({
      department: 'Engineering',
      location: ['Mumbai', 'Hyderabad'],
      recruitment_mode: 'Agency',
      priority: ['P0', 'P1'],
      status: 'Live – Sourcing',
      role_id: 'R001',
    });
    expect(f).toEqual({
      departments: ['Engineering'],
      locations: ['Mumbai', 'Hyderabad'],
      recruitmentModes: ['Agency'],
      priorities: ['P0', 'P1'],
      statuses: ['Live – Sourcing'],
      roleIds: ['R001'],
    });
  });

  it('an empty query yields no filters at all', () => {
    expect(parseRoleFilters({})).toEqual(empty());
  });

  it('the plural spellings are NOT the query keys (departments, locations, role_ids are ignored)', () => {
    expect(parseRoleFilters({ departments: 'x', locations: 'y', role_ids: 'z', roleId: 'w' })).toEqual(empty());
  });
});

describe('hasActiveFilters (one field is enough)', () => {
  it('is false for the empty filter set', () => {
    expect(hasActiveFilters(empty())).toBe(false);
  });

  it.each([
    'departments', 'locations', 'recruitmentModes', 'priorities', 'statuses', 'roleIds',
  ] as const)('is true when only %s is set', field => {
    expect(hasActiveFilters({ ...empty(), [field]: ['x'] })).toBe(true);
  });
});

describe('buildRoleFilterSql (the WHERE fragment every metric appends)', () => {
  it('no filters gives an empty fragment and no params', () => {
    expect(buildRoleFilterSql(empty(), 1)).toEqual({ sql: '', params: [] });
    expect(buildRoleFilterSql(empty(), 7)).toEqual({ sql: '', params: [] });
  });

  it('every clause starts with " AND " so the caller can append it to an existing WHERE', () => {
    const { sql } = buildRoleFilterSql({ ...empty(), statuses: ['Approved'] }, 1);
    expect(sql.startsWith(' AND ')).toBe(true);
  });

  it.each([
    ['roleIds', 'r.id = ANY($1)'],
    ['departments', 'r.department = ANY($1)'],
    ['priorities', 'r.priority = ANY($1)'],
    ['statuses', 'r.status = ANY($1)'],
    ['recruitmentModes', 'r.recruitment_mode && $1::text[]'],
    ['locations', 'r.location ILIKE ANY($1::text[])'],
  ] as const)('%s becomes exactly one clause', (field, clause) => {
    const { sql, params } = buildRoleFilterSql({ ...empty(), [field]: ['v'] }, 1);
    expect(sql).toBe(` AND ${clause}`);
    expect(params).toHaveLength(1);
  });

  it('recruitment_mode uses array overlap (&&) against a text[] because roles.recruitment_mode is an array column', () => {
    const { sql, params } = buildRoleFilterSql({ ...empty(), recruitmentModes: ['Agency', 'Direct Outreach'] }, 1);
    expect(sql).toContain('&&');
    expect(sql).toContain('::text[]');
    expect(params).toEqual([['Agency', 'Direct Outreach']]);
  });

  it('the single-valued filters pass the array through unchanged as the bound parameter', () => {
    const { params } = buildRoleFilterSql({ ...empty(), departments: ['A', 'B'], roleIds: ['R1', 'R2'] }, 1);
    expect(params).toEqual([['R1', 'R2'], ['A', 'B']]);
  });

  it('placeholders are numbered from paramOffset, one per active filter, in the fixed order roleIds, departments, priorities, statuses, recruitmentModes, locations', () => {
    const f: RoleFilterParams = {
      roleIds: ['R1'], departments: ['D'], priorities: ['P0'], statuses: ['S'], recruitmentModes: ['M'], locations: ['L'],
    };
    const { sql, params } = buildRoleFilterSql(f, 3);
    expect(sql).toBe(
      ' AND r.id = ANY($3)'
      + ' AND r.department = ANY($4)'
      + ' AND r.priority = ANY($5)'
      + ' AND r.status = ANY($6)'
      + ' AND r.recruitment_mode && $7::text[]'
      + ' AND r.location ILIKE ANY($8::text[])',
    );
    expect(params).toEqual([['R1'], ['D'], ['P0'], ['S'], ['M'], ['%L%']]);
  });

  it('inactive filters do not consume a placeholder number (numbering stays dense)', () => {
    const { sql, params } = buildRoleFilterSql({ ...empty(), priorities: ['P1'], locations: ['Pune'] }, 5);
    expect(sql).toBe(' AND r.priority = ANY($5) AND r.location ILIKE ANY($6::text[])');
    expect(params).toEqual([['P1'], ['%Pune%']]);
  });

  it('the number of placeholders in the SQL always equals the number of params returned', () => {
    const f: RoleFilterParams = {
      roleIds: ['R1'], departments: [], priorities: ['P0'], statuses: [], recruitmentModes: ['M'], locations: ['L'],
    };
    const { sql, params } = buildRoleFilterSql(f, 10);
    const placeholders = sql.match(/\$\d+/g) ?? [];
    expect(placeholders).toHaveLength(params.length);
    expect(placeholders).toEqual(['$10', '$11', '$12', '$13']);
  });

  it('a multi-value filter still takes ONE placeholder (an array parameter, not one per value)', () => {
    const { sql, params } = buildRoleFilterSql({ ...empty(), statuses: ['Approved', 'On Hold', 'Draft'] }, 1);
    expect(sql).toBe(' AND r.status = ANY($1)');
    expect(params).toEqual([['Approved', 'On Hold', 'Draft']]);
  });

  describe('locations are substring (ILIKE) patterns, because roles.location is free text like "Hyderabad, Bangalore"', () => {
    it('each selected city is wrapped in % on both sides', () => {
      const { params } = buildRoleFilterSql({ ...empty(), locations: ['Mumbai', 'Hyderabad'] }, 1);
      expect(params).toEqual([['%Mumbai%', '%Hyderabad%']]);
    });

    it('the pattern is NOT escaped: a literal % or _ in the input stays a wildcard (pins today; the code assumes a fixed city list)', () => {
      const { params } = buildRoleFilterSql({ ...empty(), locations: ['100%', 'a_b'] }, 1);
      expect(params).toEqual([['%100%%', '%a_b%']]);
    });

    it('a user-supplied value is bound as a parameter, never spliced into the SQL text', () => {
      const evil = "x'); DROP TABLE roles; --";
      const { sql, params } = buildRoleFilterSql({ ...empty(), locations: [evil], departments: [evil] }, 1);
      expect(sql).not.toContain('DROP');
      expect(sql).not.toContain(evil);
      expect(JSON.stringify(params)).toContain('DROP TABLE roles');
    });
  });
});

describe('roleIdsSubquery (the same fragment as a (SELECT id FROM roles r ...) subquery)', () => {
  it('returns null when no filter is active so callers can skip the subquery', () => {
    expect(roleIdsSubquery(empty(), 1)).toBeNull();
  });

  it('wraps the fragment in "(SELECT id FROM roles r WHERE 1=1 ...)" with the same params', () => {
    const f = { ...empty(), departments: ['Engineering'], priorities: ['P0'] };
    const sub = roleIdsSubquery(f, 2);
    expect(sub).toEqual({
      sql: '(SELECT id FROM roles r WHERE 1=1 AND r.department = ANY($2) AND r.priority = ANY($3))',
      params: [['Engineering'], ['P0']],
    });
  });

  it('shares its parameter numbering and params with buildRoleFilterSql', () => {
    const f: RoleFilterParams = { ...empty(), roleIds: ['R1'], locations: ['Pune'] };
    const direct = buildRoleFilterSql(f, 4);
    const sub = roleIdsSubquery(f, 4)!;
    expect(sub.params).toEqual(direct.params);
    expect(sub.sql).toBe(`(SELECT id FROM roles r WHERE 1=1${direct.sql})`);
  });
});

describe('applyHiringManagerRoleLock (a Hiring Manager only ever sees their own roles)', () => {
  it.each(['hr_recruiter', 'leadership', 'super_admin'] as const)(
    'a %s user is not locked: filters untouched and no query is run', async persona => {
      const filters: RoleFilterParams = { ...empty(), roleIds: ['R_PICKED'], departments: ['Engineering'] };
      const before = structuredClone(filters);
      await applyHiringManagerRoleLock(filters, user(persona));
      expect(filters).toEqual(before);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('a Hiring Manager with two roles has roleIds replaced by exactly those two (a role they picked themselves is overwritten)', async () => {
    query.mockResolvedValueOnce([{ id: 'R016' }, { id: 'R019' }]);
    const filters: RoleFilterParams = { ...empty(), roleIds: ['R_SOMEONE_ELSES'], priorities: ['P0'] };
    await applyHiringManagerRoleLock(filters, user('hiring_manager', 'Test Manager'));
    expect(filters.roleIds).toEqual(['R016', 'R019']);
    expect(filters.priorities).toEqual(['P0']);          // the other filters are left alone
  });

  it('a Hiring Manager who owns no role gets the sentinel id, never an empty list (empty would mean "no filter", i.e. everyone)', async () => {
    query.mockResolvedValueOnce([]);
    const filters = empty();
    await applyHiringManagerRoleLock(filters, user('hiring_manager'));
    expect(filters.roleIds).toEqual(['__no_roles_owned__']);
    // The sentinel really is "active": downstream builders must emit a clause that matches nothing, not skip the filter.
    expect(hasActiveFilters(filters)).toBe(true);
    const { sql, params } = buildRoleFilterSql(filters, 1);
    expect(sql).toBe(' AND r.id = ANY($1)');
    expect(params).toEqual([['__no_roles_owned__']]);
    expect(roleIdsSubquery(filters, 1)).not.toBeNull();
  });

  it('the sentinel also replaces a role id the Hiring Manager asked for but does not own', async () => {
    query.mockResolvedValueOnce([]);
    const filters: RoleFilterParams = { ...empty(), roleIds: ['R_NOT_MINE'] };
    await applyHiringManagerRoleLock(filters, user('hiring_manager'));
    expect(filters.roleIds).toEqual(['__no_roles_owned__']);
  });

  it('looks the roles up by the user name (not the e-mail or id) through the shared named-Hiring-Manager SQL', async () => {
    query.mockResolvedValueOnce([]);
    await applyHiringManagerRoleLock(empty(), user('hiring_manager', 'Co Manager One'));
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toBe(`SELECT id FROM roles WHERE ${namedHiringManagerSql('hiring_manager_name', '$1')}`);
    expect(params).toEqual(['Co Manager One']);
  });

  it('mutates the filters object in place and resolves to undefined', async () => {
    query.mockResolvedValueOnce([{ id: 'R001' }]);
    const filters = empty();
    const same = filters;
    const result = await applyHiringManagerRoleLock(filters, user('hiring_manager'));
    expect(result).toBeUndefined();
    expect(same.roleIds).toEqual(['R001']);
  });

  it('a database error propagates (the lock fails closed rather than leaving the filter open)', async () => {
    query.mockRejectedValueOnce(new Error('db down'));
    const filters = empty();
    await expect(applyHiringManagerRoleLock(filters, user('hiring_manager'))).rejects.toThrow('db down');
    expect(filters.roleIds).toEqual([]);
  });
});
