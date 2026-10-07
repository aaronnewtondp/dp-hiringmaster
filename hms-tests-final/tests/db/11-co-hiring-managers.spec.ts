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
import { getToken, authed, CRON_SECRET, BASE, ROLE_INGEST_SECRET, uid } from '../helpers/api';
import { isNamedHiringManager, namedHiringManagerSql } from '../../../backend/src/utils/hiringManagers';
import { isNamedHiringManager as isNamedHiringManagerFrontend } from '../../../frontend/src/utils/hiringManagers';

// Invisible characters that arrive when a name is pasted from Slack, Docs or a web page.
const NBSP = String.fromCharCode(0xa0);
const ZWSP = String.fromCharCode(0x200b);
const IDEO = String.fromCharCode(0x3000);
const BOM  = String.fromCharCode(0xfeff);

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

  // A sweep resolves and re-inserts every breach row with created_at = NOW(), which undoes the backdating in beforeAll
  // (any dashboard load more than 3 minutes after the last one runs one). Re-pin them before every test.
  test.beforeEach(async () => {
    if (Object.keys(apps).length) {
      await client.query(`UPDATE pending_actions SET created_at = '2000-01-01' WHERE application_id = ANY($1) AND resolved = false`, [Object.values(apps)]);
    }
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
      await client.query(`DELETE FROM activity_log WHERE role_id = ANY($1)`, [roleIds]);
      await client.query(`DELETE FROM role_edit_log WHERE role_id = ANY($1)`, [roleIds]);
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

  test.describe('the SQL, backend TypeScript and frontend TypeScript rules are the same rule', () => {
    const FIELDS = [
      'Alex', 'alex ', '  ALEX  ', 'Alex Kumar', 'Alexander', 'Alex, Satyadev', 'Satyadev,Alex', 'Satyadev ; Alex', 'Satyadev & Alex',
      'Satyadev and Alex', 'Satyadev AND Alex', 'Satyadev And Alex', 'Sandeep Anand', 'Anand Kumar', 'Brandon', 'Alex,, ,', ',', ' ', '', 'Amit Gosain',
      'Amit', 'Amit ', 'Someone Else and Nalin', 'Nalin & Alex', 'Alex and', 'and Alex', 'Satyadev, and Alex', 'Satyadev, Nalin, and Alex',
      'Alex;and Satyadev', 'and', 'Dagar, Mandeep', 'Anderson & Sons',
      // pasted whitespace in every position: edge, inside a name, around a delimiter, in place of the spaces around "and"
      `Mandeep${NBSP}Dagar,${NBSP}Piyush Negi`, `Mandeep Dagar,${NBSP}${NBSP}Piyush${NBSP}Negi${NBSP}`, `${NBSP}Piyush Negi`,
      'Mandeep Dagar,\tPiyush Negi\n', '\tPiyush Negi', 'Piyush Negi\r\n', `Mandeep Dagar${NBSP}and${NBSP}Piyush Negi`,
      `Mandeep Dagar${IDEO}and${IDEO}Piyush Negi`, `${BOM}Piyush Negi`, `Piyush${ZWSP}Negi`, `Mandeep Dagar${ZWSP}, Piyush Negi`,
    ];
    const USERS = ['Alex', 'alex', ' Satyadev ', 'Amit', 'Nalin', 'Sandeep Anand', 'Anand', 'Piyush Negi', `Piyush${NBSP}Negi`, 'Mandeep Dagar',
      'Dagar, Mandeep', 'Anderson & Sons', 'and', ''];

    test('for every field/user pair they agree (SQL results compared with isNamedHiringManager in both packages)', async () => {
      const mismatches: string[] = [];
      let trueCount = 0;
      for (const field of FIELDS) for (const user of USERS) {
        const { rows } = await client.query(`SELECT ${namedHiringManagerSql('$2::text', '$1::text')} AS hit`, [user, field]);
        const sql = rows[0].hit === true;               // NULL (blank field) counts as false
        const js = isNamedHiringManager(user, field);
        const fe = isNamedHiringManagerFrontend(user, field);
        if (js) trueCount++;
        if (sql !== js || fe !== js) mismatches.push(`field=${JSON.stringify(field)} user=${JSON.stringify(user)} sql=${sql} backend=${js} frontend=${fe}`);
      }
      expect(mismatches).toEqual([]);
      expect(trueCount).toBeGreaterThan(40);            // the table really exercises matches, not just misses
    });

    test('the exotic-whitespace rows really do match (not vacuously agreeing on false)', async () => {
      for (const [user, field] of [
        ['Piyush Negi', `Mandeep${NBSP}Dagar,${NBSP}Piyush Negi`], ['Piyush Negi', 'Mandeep Dagar,\tPiyush Negi\n'],
        ['Piyush Negi', `Mandeep Dagar${NBSP}and${NBSP}Piyush Negi`], ['Piyush Negi', `${BOM}Piyush Negi`], ['Alex', 'Satyadev, and Alex'],
        [`Piyush${NBSP}Negi`, 'Mandeep Dagar, Piyush Negi'],
      ]) {
        const { rows } = await client.query(`SELECT ${namedHiringManagerSql('$2::text', '$1::text')} AS hit`, [user, field]);
        expect(rows[0].hit, `${JSON.stringify(user)} in ${JSON.stringify(field)}`).toBe(true);
        expect(isNamedHiringManager(user, field)).toBe(true);
      }
    });

    test('a field of a million blanks is answered quickly by the database too', async () => {
      const t0 = Date.now();
      await client.query(`SELECT ${namedHiringManagerSql('$2::text', '$1::text')} AS hit`, ['Piyush Negi', ' '.repeat(1_000_000)]);
      expect(Date.now() - t0).toBeLessThan(2000);
    });
  });

  test.describe('writing the field (POST/PATCH /roles, the requisition ingest)', () => {
    const hrApi = async (request: Req) => authed(request, await getToken(request, 'hr'));
    const storedName = async (id: string) => (await client.query(`SELECT hiring_manager_name FROM roles WHERE id = $1`, [id])).rows[0].hiring_manager_name as string;

    test('PATCH stores the canonical "A, B" form however it was typed, and logs the change once', async ({ request }) => {
      const api = await hrApi(request);
      const res = await api.patch(`/api/roles/${roles.alexOnly}`, { hiring_manager_name: `  mandeep dagar ;${NBSP}Piyush Negi  and Ria Sontakke ` });
      expect(res.status()).toBe(200);
      expect(await storedName(roles.alexOnly)).toBe('mandeep dagar, Piyush Negi, Ria Sontakke');
      const log = (await client.query(`SELECT count(*)::int AS n FROM role_edit_log WHERE role_id = $1 AND field_name = 'hiring_manager_name'`, [roles.alexOnly])).rows[0].n;
      expect(log).toBe(1);
      // put it back for the other tests
      await api.patch(`/api/roles/${roles.alexOnly}`, { hiring_manager_name: 'Alex and Someone Else' });
      expect(await storedName(roles.alexOnly)).toBe('Alex, Someone Else');
    });

    test('re-saving the same people in another spelling is not a change', async ({ request }) => {
      const api = await hrApi(request);
      await api.patch(`/api/roles/${roles.both}`, { hiring_manager_name: 'Alex, Satyadev' });
      const res = await api.patch(`/api/roles/${roles.both}`, { hiring_manager_name: ' Alex ;  Satyadev ' });
      expect((await res.json()).message).toBe('No changes detected');
    });

    test('values that would silently remove every Hiring Manager, or that are not text / too long, are refused and nothing changes', async ({ request }) => {
      const api = await hrApi(request);
      const before = await storedName(roles.both);
      for (const bad of [',', ' ; ', '&', 42, null, ['Alex'], 'x'.repeat(301), ' '.repeat(5000)]) {
        const res = await api.patch(`/api/roles/${roles.both}`, { hiring_manager_name: bad });
        expect(res.status(), JSON.stringify(bad).slice(0, 30)).toBe(400);
      }
      expect(await storedName(roles.both)).toBe(before);
    });

    test('the response names anyone who matches no active user (a typo would otherwise be invisible)', async ({ request }) => {
      const api = await hrApi(request);
      const good = await (await api.patch(`/api/roles/${roles.alexOnly}`, { hiring_manager_name: 'Alex, Satyadev' })).json();
      expect(good.unmatched_hiring_managers).toEqual([]);
      const typo = await (await api.patch(`/api/roles/${roles.alexOnly}`, { hiring_manager_name: 'Alex, Satyadve, Nobody Atall' })).json();
      expect(typo.unmatched_hiring_managers).toEqual(['Satyadve', 'Nobody Atall']);
      await api.patch(`/api/roles/${roles.alexOnly}`, { hiring_manager_name: 'Alex, Someone Else' });
    });

    test('open "HM shortlist review" rows follow the field (the sweep never rewrites them); resolved ones and other roles are left alone', async ({ request }) => {
      const api = await hrApi(request);
      const mk = async (appKey: string, resolved: boolean, person: string) => (await client.query(
        `INSERT INTO pending_actions (owner_type, priority_level, action_type, description, application_id, candidate_name, role_title, hours_overdue, role_id, responsible_person, resolved)
         VALUES ('Hiring Manager', 'High', 'HM shortlist review', 'review', $1, 'x', 'x', 0, $2, $3, $4) RETURNING id`,
        [apps[appKey], resolved ? roles[appKey] : roles[appKey], person, resolved])).rows[0].id as number;
      const open = await mk('both', false, 'Alex, Satyadev');
      const done = await mk('both', true, 'Alex, Satyadev');
      const other = await mk('lookalike', false, 'Alexander, Satyadev Kumar');
      const personOf = async (id: number) => (await client.query(`SELECT responsible_person FROM pending_actions WHERE id = $1`, [id])).rows[0].responsible_person as string;
      await api.patch(`/api/roles/${roles.both}`, { hiring_manager_name: 'Alex, Satyadev, Piyush Negi' });
      expect(await personOf(open)).toBe('Alex, Satyadev, Piyush Negi');
      expect(await personOf(done)).toBe('Alex, Satyadev');
      expect(await personOf(other)).toBe('Alexander, Satyadev Kumar');
      await api.patch(`/api/roles/${roles.both}`, { hiring_manager_name: 'Alex, Satyadev' });   // removing a person takes the row away from them too
      expect(await personOf(open)).toBe('Alex, Satyadev');
    });

    test('POST (HR or a Hiring Manager requesting a role) canonicalises, and refuses a value of only delimiters', async ({ request }) => {
      const make = async (who: 'hr' | 'hm_alex', name: string) => {
        const res = await authed(request, await getToken(request, who)).post('/api/roles', {
          title: `CoHM POST ${uid()}`, priority: 'P2', hiring_manager_name: name });
        if (res.status() === 201) roleIds.push((await res.json()).role.id);
        return res;
      };
      const hr = await make('hr', ` Alex ; Satyadev${NBSP}`);
      expect(hr.status()).toBe(201);
      expect((await hr.json()).role.hiring_manager_name).toBe('Alex, Satyadev');
      expect((await make('hm_alex', 'Alex and Piyush Negi')).status()).toBe(201);
      expect((await make('hm_alex', ' , ')).status()).toBe(400);
    });

    test('the requisition ingest canonicalises too', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/roles/ingest`, {
        headers: { 'x-ingest-secret': ROLE_INGEST_SECRET },
        data: { timestamp: `${Date.now()}-${marker}`, email: `requester+${marker}@digitalpaani.com`, job_title: `CoHM Ingest ${marker}`,
                hiring_manager: ` Alex ;${NBSP}Satyadev `, priority_level: 'P2' },
      });
      expect(res.status()).toBe(201);
      const role = (await res.json()).role;
      roleIds.push(role.id);
      expect(role.hiring_manager_name).toBe('Alex, Satyadev');
    });
  });
});
