import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Sourcing page's role switcher: who sees which plans, how many drafts are listed, and who is "behind" target.
// The database is answered from canned rows; the logic around them is what is pinned here.
const h = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../db/index.js', () => ({
  query: (...a: unknown[]) => h.query(...a),
  queryOne: (...a: unknown[]) => h.queryOne(...a),
  transaction: vi.fn(),
  pool: {},
}));

import { getWorkspace, DRAFTS_SHOWN } from './sourcingWorkspace.js';
import { OPEN_ROLE_STATUSES } from '../utils/sourcingConfig.js';

const NOW = new Date('2026-10-14T06:00:00Z');
const HR = { userId: 'U-HR', hr: true };
const HM = { userId: 'U-HM', hr: false };

interface PlanRow {
  plan_id: string; plan_status: 'draft' | 'active' | 'paused'; weekly_qualified_target: number | null; role_id: string; title: string; priority: string;
  hiring_manager_name: string | null; open_exceptions: string; channels_live: string;
}
const planRow = (over: Partial<PlanRow> & { role_id: string }): PlanRow => ({
  plan_id: `P-${over.role_id}`, plan_status: 'active', weekly_qualified_target: null, title: `Role ${over.role_id}`, priority: 'P1',
  hiring_manager_name: 'Test Manager', open_exceptions: '0', channels_live: '0', ...over,
});

let plans: PlanRow[];
let apps: Array<{ role_id: string; shortlisted_at: Date | null; scored_at: Date | null }>;
let hmName: string | null;
let settingRows: Array<{ key: string; value: unknown }>;

beforeEach(() => {
  plans = [];
  apps = [];
  hmName = 'Test Manager';
  settingRows = [];
  h.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT key, value FROM sourcing_settings')) return settingRows;
    if (sql.includes('FROM sourcing_plans p JOIN roles r')) return plans;
    if (sql.includes('FROM applications a')) return apps;
    return [];
  });
  h.queryOne.mockReset().mockImplementation(async (sql: string) => (sql.includes('FROM users') ? (hmName === null ? null : { name: hmName }) : null));
});

const shortlistedDaysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000);

describe('getWorkspace: what is listed', () => {
  it('lists active and paused plans as roles and draft plans separately', async () => {
    plans = [
      planRow({ role_id: 'R1', plan_status: 'active' }),
      planRow({ role_id: 'R2', plan_status: 'paused' }),
      planRow({ role_id: 'R3', plan_status: 'draft' }),
    ];
    const w = await getWorkspace(HR, NOW);
    expect(w.roles.map(r => [r.role_id, r.plan_status])).toEqual([['R1', 'active'], ['R2', 'paused']]);
    expect(w.drafts.map(r => r.role_id)).toEqual(['R3']);
    expect(w.drafts_total).toBe(1);
  });

  it('only a draft of an OPEN role is requested from the database (a held role\'s plan is "paused", not a draft)', async () => {
    await getWorkspace(HR, NOW);
    const call = h.query.mock.calls.find(c => String(c[0]).includes('FROM sourcing_plans p JOIN roles r'))!;
    expect(String(call[0])).toContain("p.status IN ('active','paused') OR (p.status = 'draft' AND r.status = ANY($1::text[]))");
    expect(call[1]).toEqual([OPEN_ROLE_STATUSES]);
  });

  it('orders by role priority (P0 first) then id, in the query', async () => {
    await getWorkspace(HR, NOW);
    const sql = String(h.query.mock.calls.find(c => String(c[0]).includes('FROM sourcing_plans p JOIN roles r'))![0]);
    expect(sql).toContain("CASE r.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END");
    expect(sql).toMatch(/ORDER BY CASE r\.priority[^\n]*END, r\.id/);
  });

  it('with nothing to show, nothing is returned and no application query runs', async () => {
    const w = await getWorkspace(HR, NOW);
    expect(w).toEqual({ roles: [], drafts: [], drafts_total: 0 });
    expect(h.query.mock.calls.some(c => String(c[0]).includes('FROM applications a'))).toBe(false);
  });

  it(`lists at most ${DRAFTS_SHOWN} drafts and counts all of them`, async () => {
    plans = Array.from({ length: DRAFTS_SHOWN + 15 }, (_, i) => planRow({ role_id: `R${String(i).padStart(3, '0')}`, plan_status: 'draft' }));
    const w = await getWorkspace(HR, NOW);
    expect(w.drafts).toHaveLength(DRAFTS_SHOWN);
    expect(w.drafts_total).toBe(DRAFTS_SHOWN + 15);
    expect(w.drafts[0].role_id).toBe('R000');                         // the most urgent first: the query's order is kept
    expect(w.drafts[DRAFTS_SHOWN - 1].role_id).toBe(`R${String(DRAFTS_SHOWN - 1).padStart(3, '0')}`);
  });

  it('the draft cap does not limit active and paused roles', async () => {
    plans = Array.from({ length: DRAFTS_SHOWN + 5 }, (_, i) => planRow({ role_id: `R${i}`, plan_status: 'active' }));
    expect((await getWorkspace(HR, NOW)).roles).toHaveLength(DRAFTS_SHOWN + 5);
  });

  it('DRAFTS_SHOWN is 40', () => {
    expect(DRAFTS_SHOWN).toBe(40);
  });
});

describe('getWorkspace: a Hiring Manager sees only their own roles, never a draft', () => {
  it('HR-tier does not look the user up; a Hiring Manager does', async () => {
    await getWorkspace(HR, NOW);
    expect(h.queryOne).not.toHaveBeenCalled();
    await getWorkspace(HM, NOW);
    expect(h.queryOne).toHaveBeenCalledTimes(1);
    expect(h.queryOne.mock.calls[0][1]).toEqual(['U-HM']);
  });

  it('keeps the active and paused plans of roles whose Hiring Manager field names them, drops everyone else\'s', async () => {
    plans = [
      planRow({ role_id: 'R1', hiring_manager_name: 'Test Manager' }),
      planRow({ role_id: 'R2', hiring_manager_name: 'Other Person' }),
      planRow({ role_id: 'R3', hiring_manager_name: 'Test Manager', plan_status: 'paused' }),
      planRow({ role_id: 'R4', hiring_manager_name: null }),
    ];
    const w = await getWorkspace(HM, NOW);
    expect(w.roles.map(r => r.role_id)).toEqual(['R1', 'R3']);
  });

  it('never shows a draft plan, even of their own role', async () => {
    plans = [planRow({ role_id: 'R1', plan_status: 'draft' }), planRow({ role_id: 'R2', plan_status: 'active' })];
    const w = await getWorkspace(HM, NOW);
    expect(w.drafts).toEqual([]);
    expect(w.drafts_total).toBe(0);
    expect(w.roles.map(r => r.role_id)).toEqual(['R2']);
  });

  it('a co-Hiring-Manager role (names separated by a comma) is theirs; a different person sharing only a first name is not', async () => {
    plans = [
      planRow({ role_id: 'R1', hiring_manager_name: 'Aaa Bbb, Test Manager' }),
      planRow({ role_id: 'R2', hiring_manager_name: 'Test Manager and Ccc Ddd' }),
      planRow({ role_id: 'R3', hiring_manager_name: 'Test Managerson' }),
      planRow({ role_id: 'R4', hiring_manager_name: 'Test' }),
    ];
    const w = await getWorkspace(HM, NOW);
    expect(w.roles.map(r => r.role_id)).toEqual(['R1', 'R2']);
  });

  it('matching is case- and whitespace-insensitive', async () => {
    hmName = '  test   MANAGER ';
    plans = [planRow({ role_id: 'R1', hiring_manager_name: 'Test Manager' })];
    expect((await getWorkspace(HM, NOW)).roles).toHaveLength(1);
  });

  it('a user who no longer exists sees nothing', async () => {
    hmName = null;
    plans = [planRow({ role_id: 'R1' })];
    expect(await getWorkspace(HM, NOW)).toEqual({ roles: [], drafts: [], drafts_total: 0 });
  });

  it('the comparison uses users.name (looked up by id), never anything the caller passes in', async () => {
    plans = [planRow({ role_id: 'R1', hiring_manager_name: 'Test Manager' })];
    hmName = 'Someone Else';
    expect((await getWorkspace({ userId: 'U-HM', hr: false }, NOW)).roles).toEqual([]);
  });
});

describe('getWorkspace: counts, target and "behind"', () => {
  it('returns the open exception and live channel counts as numbers', async () => {
    plans = [planRow({ role_id: 'R1', open_exceptions: '3', channels_live: '2' })];
    const r = (await getWorkspace(HR, NOW)).roles[0];
    expect(r).toMatchObject({ open_exceptions: 3, channels_live: 2, role_id: 'R1', title: 'Role R1', priority: 'P1', plan_id: 'P-R1', plan_status: 'active' });
  });

  it('the exception count query leaves out provisional signals and everything on a paused plan', async () => {
    await getWorkspace(HR, NOW);
    const sql = String(h.query.mock.calls.find(c => String(c[0]).includes('FROM sourcing_plans p JOIN roles r'))![0]);
    expect(sql).toContain("e.status = 'open' AND NOT e.is_shadow AND p.status <> 'paused'");
    expect(sql).toContain("ch.state = 'active'");
  });

  it('a P0/P1 role with no own target is measured against the default 5; behind when fewer qualified in 7 days', async () => {
    plans = [planRow({ role_id: 'R1', priority: 'P0' })];
    apps = Array.from({ length: 4 }, () => ({ role_id: 'R1', shortlisted_at: shortlistedDaysAgo(2), scored_at: null }));
    const r = (await getWorkspace(HR, NOW)).roles[0];
    expect(r).toMatchObject({ target: 5, qualified: 4, behind: true });
  });

  it('exactly at the target is not behind', async () => {
    plans = [planRow({ role_id: 'R1', priority: 'P1' })];
    apps = Array.from({ length: 5 }, () => ({ role_id: 'R1', shortlisted_at: shortlistedDaysAgo(2), scored_at: null }));
    expect((await getWorkspace(HR, NOW)).roles[0]).toMatchObject({ target: 5, qualified: 5, behind: false });
  });

  it('a role\'s own target overrides the default (a P2 role with a target is measured too)', async () => {
    plans = [planRow({ role_id: 'R1', priority: 'P2', weekly_qualified_target: 2 })];
    apps = [{ role_id: 'R1', shortlisted_at: shortlistedDaysAgo(1), scored_at: null }];
    expect((await getWorkspace(HR, NOW)).roles[0]).toMatchObject({ target: 2, qualified: 1, behind: true });
  });

  it('a P2/P3 role with no target has no target, is never behind, and shows 0 qualified without a lookup for it', async () => {
    plans = [planRow({ role_id: 'R1', priority: 'P2' }), planRow({ role_id: 'R2', priority: 'P3' })];
    apps = [{ role_id: 'R1', shortlisted_at: shortlistedDaysAgo(1), scored_at: null }];
    const w = await getWorkspace(HR, NOW);
    expect(w.roles.map(r => [r.role_id, r.target, r.qualified, r.behind])).toEqual([['R1', null, 0, false], ['R2', null, 0, false]]);
    expect(h.query.mock.calls.some(c => String(c[0]).includes('FROM applications a'))).toBe(false);
  });

  it('a paused plan shows its target and count but is never "behind" (its clocks are stopped)', async () => {
    plans = [planRow({ role_id: 'R1', plan_status: 'paused' })];
    expect((await getWorkspace(HR, NOW)).roles[0]).toMatchObject({ target: 5, qualified: 0, behind: false });
  });

  it('a draft shows its target but no counts and is never behind; the application query skips drafts', async () => {
    plans = [planRow({ role_id: 'R1', plan_status: 'draft' })];
    const w = await getWorkspace(HR, NOW);
    expect(w.drafts[0]).toMatchObject({ target: 5, qualified: 0, behind: false });
    expect(h.query.mock.calls.some(c => String(c[0]).includes('FROM applications a'))).toBe(false);
  });

  it('counts only applications that first qualified in the last 7 days, per role, and asks the database only for the roles with a target', async () => {
    plans = [
      planRow({ role_id: 'R1', priority: 'P0' }),
      planRow({ role_id: 'R2', priority: 'P1' }),
      planRow({ role_id: 'R3', priority: 'P3' }),
      planRow({ role_id: 'R4', priority: 'P0', plan_status: 'draft' }),
    ];
    apps = [
      { role_id: 'R1', shortlisted_at: shortlistedDaysAgo(1), scored_at: null },
      { role_id: 'R1', shortlisted_at: shortlistedDaysAgo(8), scored_at: null },                  // too old
      { role_id: 'R1', shortlisted_at: null, scored_at: shortlistedDaysAgo(3) },
      { role_id: 'R2', shortlisted_at: shortlistedDaysAgo(6), scored_at: null },
    ];
    const w = await getWorkspace(HR, NOW);
    expect(w.roles.map(r => [r.role_id, r.qualified])).toEqual([['R1', 2], ['R2', 1], ['R3', 0]]);
    const appCall = h.query.mock.calls.find(c => String(c[0]).includes('FROM applications a'))!;
    expect((appCall[1] as unknown[])[0]).toEqual(['R1', 'R2']);                                    // not the P3 role, not the draft
    expect(((appCall[1] as unknown[])[1] as Date).toISOString()).toBe(new Date(NOW.getTime() - 21 * 86400000).toISOString());
  });

  describe('the qualified count follows the settings, not constants', () => {
    it('volume_window_days sets the window: with 14 days an application that qualified 10 days ago counts, with the default 7 it does not', async () => {
      plans = [planRow({ role_id: 'R1', priority: 'P0' })];
      apps = [{ role_id: 'R1', shortlisted_at: shortlistedDaysAgo(10), scored_at: null }];
      expect((await getWorkspace(HR, NOW)).roles[0].qualified).toBe(0);
      settingRows = [{ key: 'volume_window_days', value: 14 }];
      expect((await getWorkspace(HR, NOW)).roles[0].qualified).toBe(1);
    });

    it('qualified_rule decides what qualifies: "shortlisted" ignores a candidate who was only scored, "scored" ignores one who was only shortlisted, "either" counts both', async () => {
      plans = [planRow({ role_id: 'R1', priority: 'P0' })];
      apps = [
        { role_id: 'R1', shortlisted_at: shortlistedDaysAgo(1), scored_at: null },                // shortlisted only
        { role_id: 'R1', shortlisted_at: null, scored_at: shortlistedDaysAgo(2) },                // scored only
      ];
      const qualifiedWith = async (rule: string) => {
        settingRows = [{ key: 'qualified_rule', value: rule }];
        return (await getWorkspace(HR, NOW)).roles[0].qualified;
      };
      expect(await qualifiedWith('either')).toBe(2);
      expect(await qualifiedWith('shortlisted')).toBe(1);
      expect(await qualifiedWith('scored')).toBe(1);
    });

    it('volume_min_qualified is the default target of a P0/P1 role, and the "behind" line moves with it', async () => {
      plans = [planRow({ role_id: 'R1', priority: 'P1' })];
      apps = [
        { role_id: 'R1', shortlisted_at: shortlistedDaysAgo(1), scored_at: null },
        { role_id: 'R1', shortlisted_at: shortlistedDaysAgo(2), scored_at: null },
      ];
      settingRows = [{ key: 'volume_min_qualified', value: 2 }];
      expect((await getWorkspace(HR, NOW)).roles[0]).toMatchObject({ target: 2, qualified: 2, behind: false });
      settingRows = [{ key: 'volume_min_qualified', value: 3 }];
      expect((await getWorkspace(HR, NOW)).roles[0]).toMatchObject({ target: 3, qualified: 2, behind: true });
    });
  });

  it('a Hiring Manager\'s application lookup is limited to their own roles', async () => {
    plans = [planRow({ role_id: 'R1' }), planRow({ role_id: 'R2', hiring_manager_name: 'Other Person' })];
    await getWorkspace(HM, NOW);
    const appCall = h.query.mock.calls.find(c => String(c[0]).includes('FROM applications a'))!;
    expect((appCall[1] as unknown[])[0]).toEqual(['R1']);
  });
});
