// ─────────────────────────────────────────────────────────────────────────────
// A Leadership user who is ALSO the named Hiring Manager of a role (Mansi Jain /
// R019 Head of Marketing in production; here the seeded leadership user Nalin and
// throwaway roles) keeps the Leadership persona but works that role's Hiring
// Manager queue:
//   - GET /dashboard/pending adds the 'Hiring Manager'-owned rows that name them, on roles
//     they are the HM of — and nothing else (role-scoped, not a persona switch).
//   - the same response lists those roles in `hm_roles`.
//   - GET /applications?founder_flag=true&or_role_id=... is a UNION (flagged OR on those roles).
// Real breaches are made the way tests/db/09 does: backdate stage_entry_time, then run the engine with
// POST /api/cron/sla-check. INTENTIONALLY LOCAL-ONLY, like the other tests/db specs.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed, CRON_SECRET, BASE } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';
type Req = Parameters<typeof authed>[0];
type Pending = { id: number; owner_type: string; action_type: string; application_id: string | null; role_id: string | null; responsible_person: string | null };
type PendingBody = { actions: Pending[]; alerts: Pending[]; hm_roles: { id: string; title: string }[] };

test.describe('Leadership user who is also a role\'s Hiring Manager', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);                              // the engine sweep on a large local dataset

  let client: Client;
  let leaderName = '';
  const roleIds: string[] = [];
  const candidateIds: string[] = [];
  const apps: Record<string, string> = {};              // label -> application id
  let ownRole = '', otherRole = '', shoutyRole = '';

  test.beforeAll(async ({ request }) => {
    client = new Client({ connectionString: LOCAL_DB_URL });
    await client.connect();
    leaderName = (await client.query(`SELECT name FROM users WHERE email = 'nalin@digitalpaani.com'`)).rows[0].name;

    const newRole = async (title: string, hm: string) => {
      const { rows } = await client.query(
        `INSERT INTO roles (title, department, hiring_manager_name, priority, status, location, employment_type, start_date)
         VALUES ($1, 'Tech/Devs', $2, 'P1', 'Live – Sourcing', 'Gurgaon', 'Full-Time / Permanent', CURRENT_DATE - 10) RETURNING id`,
        [`${title} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, hm]);
      roleIds.push(rows[0].id);
      return rows[0].id as string;
    };
    const newApp = async (label: string, roleId: string, o: { founder?: boolean; stale?: boolean } = {}) => {
      const { rows: c } = await client.query(
        `INSERT INTO candidates (full_name, email) VALUES ($1, $2) RETURNING id`,
        [`Role HM Candidate ${label}`, `rolehm+${label}${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`]);
      candidateIds.push(c[0].id);
      const { rows } = await client.query(
        `INSERT INTO applications (candidate_id, role_id, stage, status, founder_review_flag, stage_entry_time)
         VALUES ($1, $2, 'Applied and Screened', 'Active', $3, ${o.stale ? `NOW() - INTERVAL '60 hours'` : 'NOW()'}) RETURNING id`,
        [c[0].id, roleId, !!o.founder]);
      apps[label] = rows[0].id;
    };

    ownRole    = await newRole('Role HM Own',   leaderName);                 // she/he IS the Hiring Manager
    shoutyRole = await newRole('Role HM Shouty', `  ${leaderName.toUpperCase()} `);   // same person, different case/spacing
    otherRole  = await newRole('Role HM Other', 'Someone Else');              // somebody else's role

    await newApp('own-stale', ownRole, { stale: true });                       // overdue on a role they are HM of
    await newApp('own-fresh', ownRole);
    await newApp('shouty-stale', shoutyRole, { stale: true });
    await newApp('other-stale', otherRole, { stale: true });                   // overdue, but somebody else's role
    await newApp('other-flagged', otherRole, { founder: true });
    await newApp('other-plain', otherRole);

    // A Hiring-Manager-owned row that NAMES the leadership user but sits on somebody else's role (the shape you get
    // when they are an interviewer on another role's round): must NOT come into their queue — access is per role.
    await client.query(
      `INSERT INTO pending_actions (owner_type, priority_level, action_type, description, application_id, candidate_name, role_title, hours_overdue, role_id, responsible_person)
       VALUES ('Hiring Manager', 'High', 'Interview 1 Feedback Due', 'named but not their role', $1, 'x', 'x', 1, $2, $3)`,
      [apps['other-stale'], otherRole, leaderName]);

    expect((await authed(request, CRON_SECRET).post('/api/cron/sla-check', {})).status()).toBe(200);

    // GET /dashboard/pending returns at most 100 rows, oldest first within a priority. This long-lived local database
    // holds hundreds of old unresolved Leadership rows from earlier runs, which would push these brand-new rows out of
    // the window (production has ~30). Make this spec's rows the oldest so they are in it — what is under test is
    // who is allowed to see them, not the window.
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

  const pending = async (request: Req, who: 'leadership' | 'hr' | 'hm_alex'): Promise<PendingBody> =>
    (await authed(request, await getToken(request, who)).get('/api/dashboard/pending')).json();
  const mine = (b: PendingBody, ids: string[]) => b.actions.filter(a => a.application_id && ids.includes(a.application_id));

  test.describe('GET /dashboard/pending', () => {
    test('their Hiring Manager queue for the role they are HM of is there: the overdue shortlist decision', async ({ request }) => {
      const body = await pending(request, 'leadership');
      const row = mine(body, [apps['own-stale']]).find(a => a.action_type === 'Resume Shortlist Pending');
      expect(row, 'overdue application on their own role').toBeTruthy();
      expect(row!.owner_type).toBe('Hiring Manager');
      expect(row!.role_id).toBe(ownRole);
    });

    test('the name match ignores case and spacing, like every other Hiring Manager rule', async ({ request }) => {
      const body = await pending(request, 'leadership');
      expect(mine(body, [apps['shouty-stale']]).some(a => a.action_type === 'Resume Shortlist Pending')).toBe(true);
    });

    test('nothing from somebody else\'s role comes in — including a row that merely names them', async ({ request }) => {
      const body = await pending(request, 'leadership');
      expect(mine(body, [apps['other-stale'], apps['other-plain'], apps['other-flagged']])).toEqual([]);
    });

    test('an application that is not overdue has no row (the queue is the engine\'s, not a list of every candidate)', async ({ request }) => {
      expect(mine(await pending(request, 'leadership'), [apps['own-fresh']])).toEqual([]);
    });

    test('the whole queue is still only Leadership-owned rows plus Hiring-Manager rows on THEIR roles', async ({ request }) => {
      const body = await pending(request, 'leadership');
      const hm = new Set(body.hm_roles.map(r => r.id));
      for (const a of [...body.actions, ...body.alerts]) {
        if (a.owner_type === 'Leadership / Founders') continue;
        expect(a.owner_type).toBe('Hiring Manager');
        // role_id on the row can be stale (the application may have moved); the server judges by the application's current role
        const cur = a.application_id
          ? (await client.query(`SELECT role_id FROM applications WHERE id = $1`, [a.application_id])).rows[0]?.role_id
          : a.role_id;
        expect(hm.has(cur ?? a.role_id ?? ''), `${a.action_type} on ${cur} is not one of their roles`).toBe(true);
      }
    });

    test('hm_roles lists exactly the roles they are the named HM of (case/space-insensitive), and not others', async ({ request }) => {
      const ids = (await pending(request, 'leadership')).hm_roles.map(r => r.id);
      expect(ids).toEqual(expect.arrayContaining([ownRole, shoutyRole]));
      expect(ids).not.toContain(otherRole);
    });

    test('nobody else gets hm_roles: HR-tier and Hiring Managers see [] (their view needs no widening)', async ({ request }) => {
      expect((await pending(request, 'hr')).hm_roles).toEqual([]);
      expect((await pending(request, 'hm_alex')).hm_roles).toEqual([]);
    });

    test('HR still sees every row; a real Hiring Manager is untouched (only their own rows)', async ({ request }) => {
      const hr = await pending(request, 'hr');
      expect(mine(hr, [apps['own-stale'], apps['other-stale']]).length).toBeGreaterThanOrEqual(2);
      for (const a of (await pending(request, 'hm_alex')).actions) expect(a.owner_type).toBe('Hiring Manager');
    });

    test('a Leadership user with no role of their own gets no widening (precondition for the others: only roles named for them count)', async () => {
      // Make the leadership user nobody's HM and ask again: hm_roles is [] and no Hiring-Manager row remains.
      await client.query(`UPDATE roles SET hiring_manager_name = 'Temporarily Someone Else' WHERE id = ANY($1)`, [[ownRole, shoutyRole]]);
      try {
        // can't use the `request` fixture in this test's signature cheaply; use a fresh context via fetch
        const login = await (await fetch(`${BASE}/api/auth/login`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'nalin@digitalpaani.com', password: 'password123' }),
        })).json();
        const body: PendingBody = await (await fetch(`${BASE}/api/dashboard/pending`, { headers: { authorization: `Bearer ${login.token}` } })).json();
        expect(body.hm_roles.map(r => r.id)).not.toContain(ownRole);
        expect(body.actions.filter(a => a.owner_type === 'Hiring Manager' && [ownRole, shoutyRole].includes(a.role_id ?? ''))).toEqual([]);
      } finally {
        await client.query(`UPDATE roles SET hiring_manager_name = $2 WHERE id = $1`, [ownRole, leaderName]);
        await client.query(`UPDATE roles SET hiring_manager_name = $2 WHERE id = $1`, [shoutyRole, `  ${leaderName.toUpperCase()} `]);
      }
    });
  });

  test.describe('they stay Leadership — this is not a persona switch', () => {
    test('persona is unchanged', async ({ request }) => {
      const me = await (await authed(request, await getToken(request, 'leadership')).get('/api/auth/me')).json();
      expect((me.user ?? me).persona).toBe('leadership');
    });

    test('the dashboard is NOT locked to their own roles (a Hiring Manager\'s would be): same funnel snapshot as HR', async ({ request }) => {
      const [lead, hr] = await Promise.all(['leadership', 'hr'].map(async who =>
        (await authed(request, await getToken(request, who as 'leadership' | 'hr')).get('/api/dashboard/funnel-snapshot?role_id=' + otherRole)).json()));
      expect(lead).toEqual(hr);      // a lock would have replaced role_id with their own roles
    });
  });

  test.describe('GET /applications?founder_flag=true&or_role_id=... (Ready for Review)', () => {
    const list = async (request: Req, qs: string): Promise<string[]> => {
      const res = await authed(request, await getToken(request, 'leadership')).get(`/api/applications?scored_only=false&limit=500&${qs}`);
      expect(res.status()).toBe(200);
      return ((await res.json()).applications as { id: string }[]).map(a => a.id);
    };

    test('founder_flag alone: only flagged candidates (unchanged)', async ({ request }) => {
      const ids = await list(request, 'founder_flag=true&status=Active');
      expect(ids).toContain(apps['other-flagged']);
      expect(ids).not.toContain(apps['own-fresh']);
      expect(ids).not.toContain(apps['other-plain']);
    });

    test('with or_role_id it is a UNION: flagged ones AND every candidate on those roles', async ({ request }) => {
      const ids = await list(request, `founder_flag=true&status=Active&or_role_id=${ownRole}`);
      expect(ids).toContain(apps['other-flagged']);       // flagged, on somebody else's role: still there
      expect(ids).toContain(apps['own-fresh']);            // unflagged, but on their role: now there
      expect(ids).toContain(apps['own-stale']);
      expect(ids).not.toContain(apps['other-plain']);      // unflagged AND somebody else's: still out
      expect(ids).not.toContain(apps['other-stale']);
    });

    test('several roles at once', async ({ request }) => {
      const ids = await list(request, `founder_flag=true&status=Active&or_role_id=${ownRole}&or_role_id=${shoutyRole}`);
      expect(ids).toEqual(expect.arrayContaining([apps['own-fresh'], apps['shouty-stale'], apps['other-flagged']]));
      expect(ids).not.toContain(apps['other-plain']);
    });

    test('the user\'s own Role filter still narrows the union (AND), it never widens it', async ({ request }) => {
      const ids = await list(request, `founder_flag=true&status=Active&or_role_id=${ownRole}&role_id=${ownRole}`);
      expect(ids).toContain(apps['own-fresh']);
      expect(ids).not.toContain(apps['other-flagged']);    // flagged, but outside the chosen role
    });

    test('or_role_id without founder_flag is ignored: it cannot be used to widen an ordinary listing', async ({ request }) => {
      const ids = await list(request, `status=Active&or_role_id=${ownRole}&role_id=${otherRole}`);
      expect(ids).toContain(apps['other-plain']);
      expect(ids).not.toContain(apps['own-fresh']);        // role_id decides; or_role_id did nothing
    });

    test('an or_role_id value that matches nothing leaves just the flagged set', async ({ request }) => {
      const ids = await list(request, 'founder_flag=true&status=Active&or_role_id=__no_such_role__');
      expect(ids).toContain(apps['other-flagged']);
      expect(ids).not.toContain(apps['own-fresh']);
    });
  });
});
