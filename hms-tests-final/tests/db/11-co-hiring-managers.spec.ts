// ─────────────────────────────────────────────────────────────────────────────
// A role can have several Hiring Managers: roles.hiring_manager_name may list people separated by a comma,
// semicolon, ampersand or "and" ("Alex, Satyadev"). Each listed person is a Hiring Manager of the role in every
// sense the system checks: compensation visibility, the Hiring Manager dashboard lock, their My Tasks queue (the SLA
// engine copies the whole field into pending_actions.responsible_person), their SLA KPI, and — for a Leadership
// user — the role-scoped workspace (spec 10). A whole name is matched: "Alex" is not "Alexander".
//
// Uses the seeded Hiring Managers Alex and Satyadev and the seeded Leadership user Nalin, throwaway roles, and real
// breaches (backdated stage_entry_time + POST /api/cron/sla-check). INTENTIONALLY LOCAL-ONLY, like tests/db/*.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed, CRON_SECRET } from '../helpers/api';
import { isNamedHiringManager, namedHiringManagerSql } from '../../../backend/src/utils/hiringManagers';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';
type Req = Parameters<typeof authed>[0];
type Who = 'hr' | 'hm_alex' | 'hm_satyadev' | 'leadership';
type Pending = { owner_type: string; action_type: string; application_id: string | null; responsible_person: string | null };

test.describe('Several Hiring Managers on one role', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let client: Client;
  const roleIds: string[] = [];
  const candidateIds: string[] = [];
  const apps: Record<string, string> = {};
  const roles: Record<string, string> = {};
  let kpiBefore: Record<'hm_alex' | 'hm_satyadev', number>;

  const slaKpi = async (request: Req, who: 'hm_alex' | 'hm_satyadev') =>
    Number((await (await authed(request, await getToken(request, who)).get('/api/dashboard')).json()).metrics.sla_breach_total);

  test.beforeAll(async ({ request }) => {
    client = new Client({ connectionString: LOCAL_DB_URL });
    await client.connect();

    // read the KPIs first: opening the dashboard also runs any pending sweep, so what follows is a clean "before"
    kpiBefore = { hm_alex: await slaKpi(request, 'hm_alex'), hm_satyadev: await slaKpi(request, 'hm_satyadev') };

    const newRole = async (key: string, hm: string) => {
      const { rows } = await client.query(
        `INSERT INTO roles (title, department, hiring_manager_name, priority, status, location, employment_type, start_date, ctc_band)
         VALUES ($1, 'Tech/Devs', $2, 'P1', 'Live – Sourcing', 'Gurgaon', 'Full-Time / Permanent', CURRENT_DATE - 10, '20-25 LPA') RETURNING id`,
        [`CoHM ${key} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, hm]);
      roleIds.push(rows[0].id); roles[key] = rows[0].id;
    };
    const newStaleApp = async (key: string) => {
      const { rows: c } = await client.query(
        `INSERT INTO candidates (full_name, email) VALUES ($1, $2) RETURNING id`,
        [`CoHM Candidate ${key}`, `cohm+${key}${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`]);
      candidateIds.push(c[0].id);
      const { rows } = await client.query(
        `INSERT INTO applications (candidate_id, role_id, stage, status, stage_entry_time)
         VALUES ($1, $2, 'Applied and Screened', 'Active', NOW() - INTERVAL '60 hours') RETURNING id`, [c[0].id, roles[key]]);
      apps[key] = rows[0].id;
    };

    await newRole('both',      'Alex, Satyadev');                      // two Hiring Managers
    await newRole('spaced',    '  ALEX ;  satyadev ');                 // case, spacing and a different delimiter
    await newRole('alexOnly',  'Alex and Someone Else');               // one of ours + a stranger
    await newRole('lookalike', 'Alexander, Satyadev Kumar');           // neither Alex nor Satyadev, only look-alikes
    await newRole('leader',    'Someone Else & Nalin');                // a Leadership user is the co-Hiring-Manager
    for (const k of ['both', 'spaced', 'alexOnly', 'lookalike', 'leader']) await newStaleApp(k);

    expect((await authed(request, CRON_SECRET).post('/api/cron/sla-check', {})).status()).toBe(200);

    // GET /dashboard/pending returns at most 100 rows, oldest first, and Alex alone has thousands of old rows locally:
    // make these rows the oldest so the cap cannot hide them. What is under test is who may see them, not the window.
    await client.query(`UPDATE pending_actions SET created_at = '2000-01-01' WHERE application_id = ANY($1)`, [Object.values(apps)]);
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);     // pending_actions.application_id is unindexed: each cascading delete scans it
    const appIds = Object.values(apps);
    if (appIds.length) {
      await client.query(`DELETE FROM pending_actions WHERE application_id = ANY($1)`, [appIds]);
      await client.query(`DELETE FROM activity_log WHERE application_id = ANY($1)`, [appIds]);
      await client.query(`DELETE FROM applications WHERE id = ANY($1)`, [appIds]);
    }
    if (candidateIds.length) await client.query(`DELETE FROM candidates WHERE id = ANY($1)`, [candidateIds]);
    if (roleIds.length) {
      await client.query(`DELETE FROM pending_actions WHERE role_id = ANY($1)`, [roleIds]);
      await client.query(`DELETE FROM roles WHERE id = ANY($1)`, [roleIds]);
    }
    await client.end();
  });

  const get = async (request: Req, who: Who, path: string) => (await authed(request, await getToken(request, who)).get(path)).json();
  const ctcOf = async (request: Req, who: Who, key: string): Promise<string | undefined> =>
    (await get(request, who, `/api/roles/${roles[key]}`)).role.ctc_band;
  const pendingRows = async (request: Req, who: Who) => {
    const b = await get(request, who, '/api/dashboard/pending');
    return [...b.actions, ...b.alerts] as Pending[];
  };
  const hasRowFor = (rows: Pending[], key: string) => rows.some(r => r.application_id === apps[key] && r.action_type === 'Resume Shortlist Pending');

  test.describe('compensation visibility (canSeeCompForRole)', () => {
    test('every listed Hiring Manager sees the role\'s CTC band; the others do not', async ({ request }) => {
      for (const key of ['both', 'spaced']) {
        expect(await ctcOf(request, 'hm_alex', key), `alex on ${key}`).toBe('20-25 LPA');
        expect(await ctcOf(request, 'hm_satyadev', key), `satyadev on ${key}`).toBe('20-25 LPA');
      }
      expect(await ctcOf(request, 'hm_alex', 'alexOnly')).toBe('20-25 LPA');
      expect(await ctcOf(request, 'hm_satyadev', 'alexOnly')).toBeUndefined();
    });

    test('a whole name is required: look-alikes ("Alexander", "Satyadev Kumar") get nothing', async ({ request }) => {
      expect(await ctcOf(request, 'hm_alex', 'lookalike')).toBeUndefined();
      expect(await ctcOf(request, 'hm_satyadev', 'lookalike')).toBeUndefined();
    });

    test('the role list applies the same rule, and HR-tier always sees it', async ({ request }) => {
      const list = (await get(request, 'hm_satyadev', '/api/roles')).roles as { id: string; ctc_band?: string }[];
      const byId = new Map(list.map(r => [r.id, r]));
      expect(byId.get(roles.both)?.ctc_band).toBe('20-25 LPA');
      expect(byId.get(roles.alexOnly)?.ctc_band).toBeUndefined();
      expect(await ctcOf(request, 'hr', 'lookalike')).toBe('20-25 LPA');
    });
  });

  test.describe('SLA attribution and the My Tasks queue', () => {
    test('the engine writes the whole field into responsible_person, so each listed person is named on the row', async () => {
      const { rows } = await client.query(
        `SELECT responsible_person FROM pending_actions WHERE application_id = $1 AND action_type = 'Resume Shortlist Pending' AND resolved = false`, [apps.both]);
      expect(rows).toHaveLength(1);
      expect(rows[0].responsible_person).toBe('Alex, Satyadev');
    });

    test('both Hiring Managers get the row in their queue; a role with only one of them in it reaches only that one', async ({ request }) => {
      const alex = await pendingRows(request, 'hm_alex');
      const satyadev = await pendingRows(request, 'hm_satyadev');
      expect(hasRowFor(alex, 'both')).toBe(true);
      expect(hasRowFor(satyadev, 'both')).toBe(true);
      expect(hasRowFor(alex, 'spaced')).toBe(true);
      expect(hasRowFor(satyadev, 'spaced')).toBe(true);
      expect(hasRowFor(alex, 'alexOnly')).toBe(true);
      expect(hasRowFor(satyadev, 'alexOnly')).toBe(false);
    });

    test('a role they are not on does not reach them', async ({ request }) => {
      // 'leader' lists neither Alex nor Satyadev (the look-alike role is left out of this check on purpose: the Hiring
      // Manager queue has always matched a name as a substring of responsible_person, so "Alex" finds "Alexander")
      expect(hasRowFor(await pendingRows(request, 'hm_alex'), 'leader')).toBe(false);
      expect(hasRowFor(await pendingRows(request, 'hm_satyadev'), 'leader')).toBe(false);
    });

    test('their SLA breach KPI counts the rows of every role they are listed on', async ({ request }) => {
      // Rows of 'both' and 'spaced' are Satyadev's as much as Alex's; with whole-string equality they were nobody's.
      const alex = await slaKpi(request, 'hm_alex');
      const satyadev = await slaKpi(request, 'hm_satyadev');
      expect(alex - kpiBefore.hm_alex).toBeGreaterThanOrEqual(3);          // both, spaced, alexOnly
      expect(satyadev - kpiBefore.hm_satyadev).toBeGreaterThanOrEqual(2);  // both, spaced
    });
  });

  test.describe('the Hiring Manager dashboard lock (applyHiringManagerRoleLock)', () => {
    const barIds = async (request: Req, who: Who) =>
      ((await get(request, who, '/api/dashboard/sla-by-role')).roles as { role_id: string }[]).map(r => r.role_id);

    test('a Hiring Manager\'s dashboard covers every role they are listed on, and only those', async ({ request }) => {
      const alex = await barIds(request, 'hm_alex');
      const satyadev = await barIds(request, 'hm_satyadev');
      expect(alex).toEqual(expect.arrayContaining([roles.both, roles.spaced, roles.alexOnly]));
      expect(satyadev).toEqual(expect.arrayContaining([roles.both, roles.spaced]));
      expect(satyadev).not.toContain(roles.alexOnly);
      for (const ids of [alex, satyadev]) expect(ids).not.toContain(roles.leader);
    });

    test('look-alike names are not locked in', async ({ request }) => {
      expect(await barIds(request, 'hm_alex')).not.toContain(roles.lookalike);
      expect(await barIds(request, 'hm_satyadev')).not.toContain(roles.lookalike);
    });
  });

  test.describe('a Leadership user listed as a co-Hiring-Manager (spec 10\'s workspace)', () => {
    test('hm_roles includes the role, and their queue gets its Hiring Manager row', async ({ request }) => {
      const body = await get(request, 'leadership', '/api/dashboard/pending');
      expect((body.hm_roles as { id: string }[]).map(r => r.id)).toContain(roles.leader);
      expect(hasRowFor([...body.actions, ...body.alerts], 'leader')).toBe(true);
    });

    test('and not the roles they are not on', async ({ request }) => {
      const body = await get(request, 'leadership', '/api/dashboard/pending');
      const ids = (body.hm_roles as { id: string }[]).map(r => r.id);
      for (const k of ['both', 'spaced', 'alexOnly', 'lookalike']) expect(ids).not.toContain(roles[k]);
    });
  });

  test.describe('the SQL and the TypeScript rule are the same rule', () => {
    const FIELDS = [
      'Alex', 'alex ', '  ALEX  ', 'Alex Kumar', 'Alexander', 'Alex, Satyadev', 'Satyadev,Alex', 'Satyadev ; Alex', 'Satyadev & Alex',
      'Satyadev and Alex', 'Satyadev AND Alex', 'Sandeep Anand', 'Brandon', 'Alex,, ,', ',', ' ', '', 'Amit Gosain', 'Amit', 'Amit ',
      'Someone Else and Nalin', 'Nalin & Alex', 'Alex and', 'and Alex',
    ];
    const USERS = ['Alex', 'alex', ' Satyadev ', 'Amit', 'Nalin', 'Sandeep Anand', 'Anand', ''];

    test('for every field/user pair the database and isNamedHiringManager agree', async () => {
      const mismatches: string[] = [];
      for (const field of FIELDS) for (const user of USERS) {
        const { rows } = await client.query(`SELECT ${namedHiringManagerSql('$2::text', '$1::text')} AS hit`, [user, field]);
        const sql = rows[0].hit === true;
        const js = isNamedHiringManager(user, field);
        if (sql !== js) mismatches.push(`field=${JSON.stringify(field)} user=${JSON.stringify(user)} sql=${sql} js=${js}`);
      }
      expect(mismatches).toEqual([]);
    });
  });
});
