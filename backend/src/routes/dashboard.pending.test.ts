// First, before any router is imported (see src/test/routeHarness.ts): express-async-errors must patch Express before a route exists.
import 'express-async-errors';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// GET /api/dashboard/pending — the persona branches of My Tasks' queue (routes/dashboard.ts). CLAUDE.md: every other persona sees
// its own queue (HR-tier: everything); a hiring_manager is scoped to the rows that NAME them (a substring match on
// responsible_person, owner_type 'Hiring Manager'); leadership sees the Leadership-owned rows and, only when they are ALSO the named
// Hiring Manager of a role, that role's Hiring Manager rows too — with the name read from users.name, not from the token, two
// separate 100-row windows, and `hm_roles` listing those roles; role-aging / comp-change / escalation notices are split off into
// `alerts` so "Other Pending Actions" only counts resolvable work.
// The real router and the real authenticate middleware run; only the database is replaced, so the tests assert on the SQL the handler
// issued and on the response it built from the rows it was given. (What Postgres does with the SQL — the name match itself — is
// covered by hms-tests-final/tests/db/10-leadership-role-hiring-manager.spec.ts and 11-co-hiring-managers.spec.ts, not here.)

vi.mock('../db/index.js', async () => (await import('../test/fakeDb.js')).dbModule());

import dashboardRouter from './dashboard.js';
import { NON_ACTIONABLE_ALERT_TYPES } from '../jobs/slaChecker.js';
import { namedHiringManagerSql } from '../utils/hiringManagers.js';
import { fakeDb } from '../test/fakeDb.js';
import { ApiClient, ALL_PERSONAS, SMOKE_USER, TEST_JWT_SECRET, TEST_USERS, buildApp, setEnv, type Actor } from '../test/routeHarness.js';

const api = new ApiClient(buildApp(app => app.use('/api/dashboard', dashboardRouter)));
let restoreEnv: () => void = () => undefined;

const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim();

// The statement every persona's queue is built from, with the owner filter spliced in (collapsed, as the fake database records it).
const BASE_SELECT = 'SELECT pa.*, a.candidate_id FROM pending_actions pa LEFT JOIN applications a ON a.id = pa.application_id WHERE pa.resolved=false';
const BASE_TAIL = 'ORDER BY pa.priority_level DESC, pa.created_at ASC LIMIT 100';
const queueSql = (ownerFilter: string) => collapse(`${BASE_SELECT} ${ownerFilter} ${BASE_TAIL}`);

const HM_FILTER = `AND owner_type='Hiring Manager' AND position(lower(trim($1)) IN lower(coalesce(responsible_person,''))) > 0`;
const LEADERSHIP_FILTER = `AND owner_type='Leadership / Founders'`;
const LEADERSHIP_HM_FILTER = `AND owner_type='Hiring Manager' AND position(lower(trim($1)) IN lower(coalesce(responsible_person,''))) > 0 AND COALESCE(a.role_id, pa.role_id) = ANY($2::text[])`;

const SQL = {
  user: /^SELECT name FROM users WHERE id = \$1$/,
  hmRoles: /^SELECT id, title FROM roles WHERE .* ORDER BY title$/,
  anyQueue: /^SELECT pa\.\*, a\.candidate_id FROM pending_actions pa/,
  leadershipQueue: /owner_type='Leadership \/ Founders'/,
  hmQueue: /owner_type='Hiring Manager'/,
};

const row = (action_type: string, extra: Record<string, unknown> = {}) => ({ id: `${action_type}-${Object.keys(extra).length}`, action_type, candidate_id: 'C9001', ...extra });
const pending = (as: Actor) => api.get('/api/dashboard/pending', { as });
const actionTypes = (rows: Array<{ action_type: string }>) => rows.map(r => r.action_type);

beforeAll(async () => { await api.start(); });
afterAll(async () => { await api.stop(); });
beforeEach(() => {
  fakeDb.reset();
  restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { restoreEnv(); vi.restoreAllMocks(); });

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('GET /pending — who gets in', () => {
  it('an anonymous request is 401 and the database is never touched', async () => {
    const res = await api.get('/api/dashboard/pending');
    expect(res.status).toBe(401);
    expect(fakeDb.untouched()).toBe(true);
  });

  it('a malformed or wrongly signed token is 401 and the database is never touched', async () => {
    const bad = await api.get('/api/dashboard/pending', { authorization: 'Bearer not-a-jwt' });
    const empty = await api.get('/api/dashboard/pending', { authorization: 'Bearer ' });
    expect([bad.status, empty.status]).toEqual([401, 401]);
    expect(fakeDb.untouched()).toBe(true);
  });

  it('every one of the four personas is answered 200 with the three keys, even on an empty queue', async () => {
    for (const persona of ALL_PERSONAS) {
      fakeDb.reset();
      const res = await pending(persona);
      expect([persona, res.status]).toEqual([persona, 200]);
      expect(res.body).toEqual({ actions: [], alerts: [], hm_roles: [] });
    }
  });

  it('a read-only smoke account may read the queue (the smoke guard only stops writes); it is served the Leadership branch for its persona', async () => {
    const res = await pending(SMOKE_USER);
    expect(res.status).toBe(200);
    expect(fakeDb.one(SQL.user).params).toEqual([SMOKE_USER.userId]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('GET /pending — HR-tier (hr_recruiter, super_admin): everything, one query, no owner filter', () => {
  it.each(['hr_recruiter', 'super_admin'] as const)('%s runs exactly one statement, with no owner filter and no parameters', async persona => {
    const rows = [row('Resume Shortlist Pending', { owner_type: 'Hiring Manager' }), row('Founder Review', { owner_type: 'Leadership / Founders' })];
    fakeDb.when(SQL.anyQueue, rows);
    const res = await pending(persona);
    expect(res.status).toBe(200);
    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0].sql).toBe(queueSql(''));
    expect(fakeDb.calls[0].params).toEqual([]);
    expect(actionTypes(res.body.actions)).toEqual(['Resume Shortlist Pending', 'Founder Review']);      // both owners' rows, nothing dropped
    expect(res.body.hm_roles).toEqual([]);
  });

  it('never looks up the user or the roles (the Hiring Manager workspace is a Leadership-only addition)', async () => {
    await pending('hr_recruiter');
    expect(fakeDb.find(/FROM users|FROM roles/)).toEqual([]);
  });

  it('the queue is ordered by priority_level DESC then oldest first, and capped at 100 rows in SQL', async () => {
    await pending('hr_recruiter');
    expect(fakeDb.calls[0].sql.endsWith(BASE_TAIL)).toBe(true);
  });

  it('only unresolved rows are asked for', async () => {
    await pending('super_admin');
    expect(fakeDb.calls[0].sql).toContain('WHERE pa.resolved=false');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('GET /pending — hiring_manager: only the rows that name them', () => {
  const HM = { ...TEST_USERS.hiring_manager, name: 'Pat Example' };

  it('runs exactly one statement, filtered to owner_type Hiring Manager and to responsible_person containing the TOKEN\'s name', async () => {
    const res = await pending(HM);
    expect(res.status).toBe(200);
    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0].sql).toBe(queueSql(HM_FILTER));
    expect(fakeDb.calls[0].params).toEqual(['Pat Example']);
  });

  it('the match is a case-insensitive SUBSTRING (position … > 0), not equality: a multi-interviewer round names several people in one responsible_person', async () => {
    await pending(HM);
    const sql = fakeDb.calls[0].sql;
    expect(sql).toContain(`position(lower(trim($1)) IN lower(coalesce(responsible_person,''))) > 0`);
    expect(sql).not.toMatch(/responsible_person\s*=/);
  });

  it('is not scoped by role: the Hiring Manager filter has no role condition (that is the leadership-with-roles branch)', async () => {
    await pending(HM);
    expect(fakeDb.calls[0].sql).not.toContain('ANY(');
    expect(fakeDb.find(/FROM roles/)).toEqual([]);
  });

  it('uses the name in the token as it is (users.name is not consulted: CLAUDE.md "the hiring_manager persona compares the token name")', async () => {
    fakeDb.whenOne(SQL.user, { name: 'Somebody Else Entirely' });
    await pending(HM);
    expect(fakeDb.find(/FROM users/)).toEqual([]);
    expect(fakeDb.calls[0].params).toEqual(['Pat Example']);
  });

  it('never sees Leadership-owned rows in its filter: owner_type is part of the SQL, not applied afterwards in JavaScript', async () => {
    // The fake returns whatever it is given; the filter is the SQL's job. Pin that the handler does not re-filter rows itself.
    fakeDb.when(SQL.anyQueue, [row('Resume Shortlist Pending', { owner_type: 'Hiring Manager' }), row('Founder Review', { owner_type: 'Leadership / Founders' })]);
    const res = await pending(HM);
    expect(actionTypes(res.body.actions)).toEqual(['Resume Shortlist Pending', 'Founder Review']);
    expect(fakeDb.calls[0].sql).toContain(`owner_type='Hiring Manager'`);
  });

  it('characterization: the name is sent unchecked — a blank name goes to SQL as an empty needle, which the handler neither refuses nor special-cases', async () => {
    await pending({ ...TEST_USERS.hiring_manager, name: '' });
    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0].params).toEqual(['']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('GET /pending — leadership', () => {
  const LEADER = { ...TEST_USERS.leadership, name: 'Token Display Name' };
  const OWN = [row('Founder Review', { owner_type: 'Leadership / Founders', id: 'p1' }), row('Role aging alert', { owner_type: 'Leadership / Founders', id: 'p2' })];
  const HM_ROWS = [row('Resume Shortlist Pending', { owner_type: 'Hiring Manager', id: 'p3' }), row('HM shortlist review', { owner_type: 'Hiring Manager', id: 'p4' })];

  function programLeader(opts: { usersName?: string | null; roles?: Array<{ id: string; title: string }> } = {}) {
    if (opts.usersName !== null) fakeDb.whenOne(SQL.user, { name: opts.usersName ?? 'Registered Name' });
    fakeDb.when(SQL.hmRoles, opts.roles ?? []);
    fakeDb.when(SQL.leadershipQueue, OWN);
    fakeDb.when(SQL.hmQueue, HM_ROWS);
  }

  describe('who is nobody\'s Hiring Manager', () => {
    it('gets exactly what Leadership always got: ONE queue statement, the Leadership-owned rows, and hm_roles []', async () => {
      programLeader();
      const res = await pending(LEADER);
      expect(res.status).toBe(200);
      const queues = fakeDb.find(SQL.anyQueue);
      expect(queues).toHaveLength(1);
      expect(queues[0].sql).toBe(queueSql(LEADERSHIP_FILTER));
      expect(queues[0].params).toEqual([]);
      expect(res.body.hm_roles).toEqual([]);
      expect(actionTypes(res.body.actions)).toEqual(['Founder Review']);
      expect(actionTypes(res.body.alerts)).toEqual(['Role aging alert']);
    });

    it('asks the database who they are by id first, then which roles name them, then fetches the queue', async () => {
      programLeader();
      await pending(LEADER);
      const order = fakeDb.calls.map(c => (SQL.user.test(c.sql) ? 'user' : SQL.hmRoles.test(c.sql) ? 'roles' : SQL.anyQueue.test(c.sql) ? 'queue' : c.sql));
      expect(order).toEqual(['user', 'roles', 'queue']);
      expect(fakeDb.one(SQL.user).params).toEqual([LEADER.userId]);
    });

    it('never sees a Hiring Manager row: the Leadership query is owner_type Leadership / Founders only', async () => {
      programLeader();
      const res = await pending(LEADER);
      expect(fakeDb.find(SQL.hmQueue)).toEqual([]);
      expect(res.body.actions.concat(res.body.alerts).some((r: { owner_type?: string }) => r.owner_type === 'Hiring Manager')).toBe(false);
    });
  });

  describe('who is ALSO the named Hiring Manager of a role', () => {
    const ROLES = [{ id: 'R9001', title: 'Alpha Role' }, { id: 'R9002', title: 'Beta Role' }];

    it('also gets that role\'s Hiring Manager rows: a SECOND statement limited to those role ids, and hm_roles lists the roles', async () => {
      programLeader({ roles: ROLES });
      const res = await pending(LEADER);
      expect(res.status).toBe(200);
      const queues = fakeDb.find(SQL.anyQueue);
      expect(queues).toHaveLength(2);
      const hm = queues.find(c => SQL.hmQueue.test(c.sql))!;
      expect(hm.sql).toBe(queueSql(LEADERSHIP_HM_FILTER));
      expect(hm.params).toEqual(['Registered Name', ['R9001', 'R9002']]);
      expect(res.body.hm_roles).toEqual(ROLES);
    });

    it('the two owner groups are two separate windows: each statement carries its own LIMIT 100 (a pile of one group cannot push the other out)', async () => {
      programLeader({ roles: ROLES });
      await pending(LEADER);
      const queues = fakeDb.find(SQL.anyQueue);
      expect(queues.map(c => c.sql.endsWith('LIMIT 100'))).toEqual([true, true]);
      expect(queues.filter(c => c.sql.includes(`owner_type='Leadership / Founders'`))).toHaveLength(1);
      expect(queues.filter(c => c.sql.includes(`owner_type='Hiring Manager'`))).toHaveLength(1);
    });

    it('the response is the Leadership rows first, then the Hiring Manager rows, each group in the order the database gave it', async () => {
      programLeader({ roles: ROLES });
      const res = await pending(LEADER);
      expect(res.body.actions.map((r: { id: string }) => r.id)).toEqual(['p1', 'p3', 'p4']);
      expect(res.body.alerts.map((r: { id: string }) => r.id)).toEqual(['p2']);
    });

    it('the name comes from users.name looked up by the token\'s userId, NOT from the token (a Google display name can differ and would silently drop the whole queue)', async () => {
      programLeader({ usersName: 'Registered Name', roles: ROLES });
      await pending(LEADER);                                                  // the token says 'Token Display Name'
      expect(fakeDb.one(SQL.user).params).toEqual([LEADER.userId]);
      expect(fakeDb.one(SQL.hmRoles).params).toEqual(['Registered Name']);
      expect(fakeDb.find(SQL.hmQueue)[0].params[0]).toBe('Registered Name');
      expect(fakeDb.calls.some(c => c.params.includes('Token Display Name'))).toBe(false);
    });

    it('falls back to the token\'s name only when there is no users row for that id', async () => {
      programLeader({ usersName: null, roles: ROLES });
      await pending(LEADER);
      expect(fakeDb.one(SQL.hmRoles).params).toEqual(['Token Display Name']);
      expect(fakeDb.find(SQL.hmQueue)[0].params[0]).toBe('Token Display Name');
    });

    it('the roles are found with the shared named-Hiring-Manager SQL (so "A, B" co-managers and whole-name matching apply), ordered by title', async () => {
      programLeader({ roles: ROLES });
      await pending(LEADER);
      expect(fakeDb.one(SQL.hmRoles).sql).toBe(collapse(`SELECT id, title FROM roles WHERE ${namedHiringManagerSql('hiring_manager_name', '$1')} ORDER BY title`));
    });

    it('is scoped PER ROLE: the Hiring Manager statement requires the row\'s role (application\'s, else the row\'s own) to be one of those roles, so a row naming them on someone else\'s role stays out', async () => {
      programLeader({ roles: ROLES });
      await pending(LEADER);
      const sql = fakeDb.find(SQL.hmQueue)[0].sql;
      expect(sql).toContain('AND COALESCE(a.role_id, pa.role_id) = ANY($2::text[])');
      expect(sql).toContain(`position(lower(trim($1)) IN lower(coalesce(responsible_person,''))) > 0`);
    });

    it('a Hiring Manager row that is a non-actionable notice still goes to alerts (the split is on action_type, whichever statement it came from)', async () => {
      programLeader({ roles: ROLES });
      fakeDb.when(SQL.hmQueue, [row('Compensation change flag', { owner_type: 'Hiring Manager', id: 'p5' }), row('HM shortlist review', { owner_type: 'Hiring Manager', id: 'p6' })]);
      const res = await pending(LEADER);
      expect(res.body.alerts.map((r: { id: string }) => r.id)).toEqual(['p2', 'p5']);
      expect(res.body.actions.map((r: { id: string }) => r.id)).toEqual(['p1', 'p6']);
    });
  });

  it('a failing statement is a 500 — never a half-built queue — and says nothing of the database', async () => {
    programLeader({ roles: [{ id: 'R9001', title: 'Alpha Role' }] });
    fakeDb.failing(SQL.hmQueue, 'relation does not exist');
    const res = await pending(LEADER);
    expect(res.status).toBe(500);
    expect(res.body.actions).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('GET /pending — actions and alerts are split on action_type, for every persona', () => {
  const NOTICES = [...NON_ACTIONABLE_ALERT_TYPES];

  it('the notice types are the role-aging notice, the comp-change notice and the Leadership escalation (CLAUDE.md "Leadership escalation on stale feedback")', () => {
    expect(NOTICES).toEqual(['Role aging alert', 'Compensation change flag', 'Feedback Overdue — Leadership Escalation']);
  });

  it.each(['hr_recruiter', 'hiring_manager', 'super_admin'] as const)('%s: every notice type lands in alerts, everything else — Founder Review included — stays in actions, order preserved', async persona => {
    const rows = [
      row('Founder Review', { id: 'a' }), row(NOTICES[0], { id: 'b' }), row('Resume Shortlist Pending', { id: 'c' }),
      row(NOTICES[1], { id: 'd' }), row('Applied and Screened - Shortlist Overdue', { id: 'e' }), row(NOTICES[2], { id: 'f' }),
    ];
    fakeDb.when(SQL.anyQueue, rows);
    const res = await pending(persona);
    expect(res.body.actions.map((r: { id: string }) => r.id)).toEqual(['a', 'c', 'e']);
    expect(res.body.alerts.map((r: { id: string }) => r.id)).toEqual(['b', 'd', 'f']);
    expect(res.body.actions.length + res.body.alerts.length).toBe(rows.length);       // nothing is hidden
  });

  it('a type that merely resembles a notice is an action: the comparison is exact', async () => {
    fakeDb.when(SQL.anyQueue, [row('role aging alert', { id: 'x' }), row('Role aging alert ', { id: 'y' }), row('Role aging alert', { id: 'z' })]);
    const res = await pending('hr_recruiter');
    expect(res.body.alerts.map((r: { id: string }) => r.id)).toEqual(['z']);
    expect(res.body.actions.map((r: { id: string }) => r.id)).toEqual(['x', 'y']);
  });

  it('rows are passed through untouched (candidate_id from the join included)', async () => {
    const r = { id: 'k', action_type: 'Founder Review', candidate_id: 'C9007', priority_level: 'High', responsible_person: 'Someone' };
    fakeDb.when(SQL.anyQueue, [r]);
    const res = await pending('hr_recruiter');
    expect(res.body.actions).toEqual([r]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('GET /pending — a persona that is not one of the four', () => {
  it('characterization: only "hiring_manager" and "leadership" are narrowed, so a token with any other persona string (the retired "interviewer") is served the UNFILTERED queue, as HR-tier is', async () => {
    const res = await pending({ ...TEST_USERS.hiring_manager, persona: 'interviewer' as unknown as 'hiring_manager' });
    expect(res.status).toBe(200);
    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0].sql).toBe(queueSql(''));
    expect(fakeDb.calls[0].params).toEqual([]);
  });
});
