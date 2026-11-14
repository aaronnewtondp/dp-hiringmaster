// ─────────────────────────────────────────────────────────────────────────────
// User lifecycle: removing access, changing a persona, and the super_admin rules — at the level of the data and of the token.
//
// "Remove access" is `users.is_active = false`, never a delete (CLAUDE.md: interview_rounds.entered_by, activity_log.performed_by and the rest all
// reference users.id). `super_admin` is "assigned to exactly one person and never a selectable role anywhere". What these tests establish, with
// users inserted by SQL (the seed's own bcrypt hash, copied from a seeded row, so each can sign in with the seeded password) and driven through the
// real API as the seeded super_admin:
//
//   removing access   the row stays, the history that points at it keeps pointing at it, a hard DELETE is refused by the database (every foreign
//                     key to users(id) is NO ACTION), the list still shows the user as inactive, and a password sign-in answers 401 — with the same
//                     words as a wrong password
//   the 24 h token   since PR #55 authenticate() re-checks users.is_active (15 s in-process cache; PATCH /api/users/:id invalidates it, so on the
//                     instance that handled the PATCH the effect is immediate, on another serverless instance within 15 s; a failed lookup answers 503).
//                     So the old token of a deactivated user, and of a deactivated SUPER_ADMIN, answers 401 on reads, HR-gated routes and writes, and works
//                     again the moment access is restored. PINNED AS "TODAY": a persona change (promotion or demotion) still only takes effect at the next
//                     sign-in, because the token carries the persona it was issued with and only is_active is re-read.
//   super_admin       the API never creates or assigns it (400, nothing written) and a super_admin cannot demote or deactivate themselves; at the
//                     database level the CHECK admits exactly four personas and nothing limits super_admin to one row (TODAY: the "exactly one person"
//                     rule is a convention, not a constraint)
//   accounts          a user made through the API is Google-only (no password hash, auth_provider 'email'), stored trimmed and lower-case; a password
//                     sign-in to it answers 400 "uses Google sign-in" — different from the 401 for an unknown address (TODAY: it tells a caller that
//                     the account exists); users.email is a case-sensitive UNIQUE, so SQL can store an address the API could never match again
//
// Everything this file creates (users, the draft roles they make and the log rows of both) is removed in afterAll — and, keyed by an e-mail prefix,
// at the start of the next run if a killed run left anything behind. INTENTIONALLY LOCAL-ONLY: direct Postgres access, like the other tests/db specs.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect, APIRequestContext } from '@playwright/test';
import type { Client } from 'pg';
import { getToken, authed, uid, BASE } from '../helpers/api';
import { newClient } from '../helpers/db';
import { purgeRolesFast } from '../helpers/sourcing-db';

const SEED_PASSWORD = 'password123';                       // the seeded users' password (seed.sql; local Docker only)
const EMAIL_PREFIX = 'lifecycle.';                         // every user this file makes has an address like lifecycle.<run>.<label>@example.com

type Json = Record<string, any>;

test.describe('User lifecycle (local Postgres + API)', () => {
  test.describe.configure({ mode: 'serial' });

  let db: Client;
  const RUN = uid();
  let sa = '';                                             // the seeded super_admin's token
  const users: Record<string, { id: string; email: string; name: string }> = {};

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────

  /** A user made by SQL with the seeded password hash (copied from a seeded row, never typed here). */
  async function makeUser(label: string, persona: string, extra: { email?: string } = {}) {
    const email = extra.email ?? `${EMAIL_PREFIX}${RUN}.${label}@example.com`;
    const name = `Lifecycle ${label} ${RUN}`;
    const { rows } = await db.query(
      `INSERT INTO users (name, email, password_hash, persona, department)
       SELECT $1, $2, password_hash, $3, 'Lifecycle test' FROM users WHERE email = 'garima@digitalpaani.com' RETURNING id`,
      [name, email, persona]);
    users[label] = { id: rows[0].id, email, name };
    return users[label];
  }

  async function login(request: APIRequestContext, email: string, password = SEED_PASSWORD) {
    const res = await request.post(`${BASE}/api/auth/login`, { data: { email, password } });
    return { status: res.status(), body: (await res.json().catch(() => ({}))) as Json };
  }
  async function tokenFor(request: APIRequestContext, label: string): Promise<string> {
    const r = await login(request, users[label].email);
    expect(r.status, `${label} must be able to sign in: ${JSON.stringify(r.body)}`).toBe(200);
    return r.body.token as string;
  }
  async function call(request: APIRequestContext, token: string, method: 'get' | 'post' | 'patch', path: string, data: object = {}) {
    const api = authed(request, token);
    const res = method === 'get' ? await api.get(path) : method === 'post' ? await api.post(path, data) : await api.patch(path, data);
    return { status: res.status(), body: (await res.json().catch(() => ({}))) as Json };
  }
  const setActive = (request: APIRequestContext, id: string, is_active: boolean) => call(request, sa, 'patch', `/api/users/${id}`, { is_active });
  const dbUser = async (id: string) => (await db.query(`SELECT id, email, persona, is_active, password_hash IS NOT NULL AS has_hash, auth_provider, department FROM users WHERE id=$1`, [id])).rows[0];

  /** Removes every user whose address carries this file's prefix, the draft roles they created and the log rows of both. */
  async function purgeLifecycleUsers() {
    const ids = (await db.query(`SELECT id FROM users WHERE email ILIKE $1`, [`${EMAIL_PREFIX}%@example.com`])).rows.map(r => r.id as string);
    if (!ids.length) return 0;
    const roleIds = (await db.query(`SELECT id FROM roles WHERE created_by = ANY($1::uuid[])`, [ids])).rows.map(r => r.id as string);
    await purgeRolesFast(db, roleIds);
    await db.query(`DELETE FROM activity_log WHERE performed_by = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM role_edit_log WHERE changed_by = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
    return ids.length;
  }

  test.beforeAll(async ({ request }) => {
    db = newClient();
    await db.connect();
    await purgeLifecycleUsers();                           // a killed run's leftovers
    sa = await getToken(request, 'super_admin');
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    try { await purgeLifecycleUsers(); } finally { await db.end(); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('the data rules', () => {
    test('every foreign key to users(id) is NO ACTION: deleting a user can never silently erase history or cascade into it', async () => {
      const { rows } = await db.query(
        `SELECT c.relname AS t, a.attname AS col, con.confdeltype AS rule
           FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_class r ON r.oid = con.confrelid
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
          WHERE con.contype = 'f' AND r.relname = 'users' ORDER BY 1, 2`);
      expect(rows.length).toBeGreaterThan(15);                                                   // roles.created_by, activity_log.performed_by, interview_rounds.entered_by, ref_checks.conducted_by ...
      const notNoAction = rows.filter(r => r.rule !== 'a').map(r => `${r.t}.${r.col}`);
      expect(notNoAction, 'these foreign keys to users would delete or null history when a user is deleted').toEqual([]);
      for (const key of ['roles.created_by', 'activity_log.performed_by', 'interview_rounds.entered_by', 'role_edit_log.changed_by', 'candidate_edit_log.changed_by']) {
        expect(rows.map(r => `${r.t}.${r.col}`), key).toContain(key);
      }
    });

    test('the persona CHECK admits exactly four personas and auth_provider exactly three, and a new row defaults to auth_provider "email"', async () => {
      const probe = await makeUser('check', 'hr_recruiter');
      for (const bad of ['interviewer', 'admin', 'Hr_Recruiter', '', 'super admin']) {
        await expect(db.query(`UPDATE users SET persona=$1 WHERE id=$2`, [bad, probe.id]), JSON.stringify(bad)).rejects.toThrow(/users_persona_check/);
      }
      for (const bad of ['password', 'Google', '']) {
        await expect(db.query(`UPDATE users SET auth_provider=$1 WHERE id=$2`, [bad, probe.id]), JSON.stringify(bad)).rejects.toThrow(/users_auth_provider_check/);
      }
      for (const ok of ['hiring_manager', 'leadership', 'super_admin', 'hr_recruiter']) {          // every allowed value is accepted by SQL, super_admin included
        await db.query('BEGIN');
        await db.query(`UPDATE users SET persona=$1 WHERE id=$2`, [ok, probe.id]);
        await db.query('ROLLBACK');
      }
      const row = await dbUser(probe.id);
      expect(row.persona).toBe('hr_recruiter');                                                  // every refused write left the row alone
      expect(row.auth_provider).toBe('email');
      expect(row.is_active).toBe(true);
    });

    test('the seeded database has exactly one super_admin', async () => {
      const { rows } = await db.query(`SELECT email FROM users WHERE persona='super_admin'`);
      expect(rows.map(r => r.email)).toEqual(['superadmin@digitalpaani.com']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('removing access', () => {
    let staleToken = '';       // the token the user holds when access is removed
    let draftRole = '';

    test('a user who can sign in and has made something in HMS', async ({ request }) => {
      const u = await makeUser('hr', 'hr_recruiter');
      staleToken = await tokenFor(request, 'hr');
      const made = await call(request, staleToken, 'post', '/api/roles', { title: `Lifecycle draft ${RUN}`, priority: 'P2' });
      expect(made.status).toBe(201);
      draftRole = made.body.role.id;
      const created = await db.query(`SELECT created_by FROM roles WHERE id=$1`, [draftRole]);
      expect(created.rows[0].created_by).toBe(u.id);
      expect((await db.query(`SELECT 1 FROM activity_log WHERE role_id=$1 AND performed_by=$2`, [draftRole, u.id])).rowCount).toBe(1);
    });

    test('Remove access (is_active=false) keeps the row and everything that references it, and the list shows the user as inactive', async ({ request }) => {
      const u = users.hr;
      const r = await setActive(request, u.id, false);
      expect(r.status).toBe(200);
      expect(r.body.user).toMatchObject({ id: u.id, email: u.email, persona: 'hr_recruiter', is_active: false });
      expect(r.body.user).not.toHaveProperty('password_hash');

      const row = await dbUser(u.id);
      expect(row.is_active).toBe(false);
      expect(row.persona).toBe('hr_recruiter');                                                  // nothing else changed
      expect(row.has_hash).toBe(true);
      const trail = await db.query(
        `SELECT r.created_by, u.is_active, (SELECT count(*) FROM activity_log l WHERE l.role_id = r.id AND l.performed_by = u.id)::int AS logged
           FROM roles r JOIN users u ON u.id = r.created_by WHERE r.id = $1`, [draftRole]);
      expect(trail.rows).toEqual([{ created_by: u.id, is_active: false, logged: 1 }]);           // the role still joins to its (now inactive) creator

      const list = await call(request, sa, 'get', '/api/users');
      expect(list.status).toBe(200);
      const listed = (list.body.users as Json[]).find(x => x.id === u.id);
      expect(listed).toMatchObject({ email: u.email, is_active: false });
      expect(listed).not.toHaveProperty('password_hash');
    });

    test('the database refuses to hard-delete a user that history points at (which is why access is removed, never the row)', async () => {
      await expect(db.query(`DELETE FROM users WHERE id=$1`, [users.hr.id])).rejects.toThrow(/violates foreign key constraint/);
      expect((await dbUser(users.hr.id)).email).toBe(users.hr.email);
    });

    test('a password sign-in is refused with 401 and the very words of a wrong password — no hint that the account exists but is switched off', async ({ request }) => {
      const right = await login(request, users.hr.email);
      const wrong = await login(request, users.hr.email, 'definitely-not-the-password');
      const unknown = await login(request, `${EMAIL_PREFIX}${RUN}.nobody@example.com`);
      expect(right.status).toBe(401);
      expect(right.body).toEqual({ error: 'Invalid email or password' });
      expect(wrong.status).toBe(401);
      expect(wrong.body).toEqual(right.body);
      expect(unknown).toEqual({ status: 401, body: right.body });
      expect(right.body.token).toBeUndefined();
    });

    test('the OLD token of the deactivated user is refused with 401 on every kind of route (reads, the HR gate, writes) and nothing is written: authenticate() re-checks users.is_active, and PATCH invalidates the 15 s cache at once', async ({ request }) => {
      const gone = { error: 'Account is deactivated or no longer exists' };
      const rolesBefore = (await db.query(`SELECT count(*)::int AS n FROM roles WHERE created_by=$1`, [users.hr.id])).rows[0].n;
      for (const path of ['/api/auth/me', '/api/roles', '/api/agencies']) {
        const r = await call(request, staleToken, 'get', path);
        expect(r.status, path).toBe(401);
        expect(r.body, path).toEqual(gone);
      }
      const write = await call(request, staleToken, 'post', '/api/roles', { title: `Lifecycle written after deactivation ${RUN}`, priority: 'P3' });
      expect(write.status).toBe(401);
      expect(write.body).toEqual(gone);
      expect((await db.query(`SELECT count(*)::int AS n FROM roles WHERE created_by=$1`, [users.hr.id])).rows[0].n).toBe(rolesBefore);   // the write never happened
      expect((await dbUser(users.hr.id)).is_active).toBe(false);
    });

    test('Restore access signs the user in again; the old token (only refused while the row was inactive, never revoked) and the new one both work at once', async ({ request }) => {
      const r = await setActive(request, users.hr.id, true);
      expect(r.status).toBe(200);
      expect(r.body.user.is_active).toBe(true);
      const fresh = await login(request, users.hr.email);
      expect(fresh.status).toBe(200);
      expect(fresh.body.user).toMatchObject({ id: users.hr.id, persona: 'hr_recruiter' });
      expect((await call(request, fresh.body.token, 'get', '/api/auth/me')).status).toBe(200);
      expect((await call(request, staleToken, 'get', '/api/auth/me')).status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('a persona change reaches the person only at their next sign-in', () => {
    test('TODAY: a promoted user keeps the old persona in the old token; a fresh sign-in has the new one', async ({ request }) => {
      const u = await makeUser('promoted', 'hiring_manager');
      const old = await tokenFor(request, 'promoted');
      expect((await call(request, old, 'get', '/api/agencies')).status).toBe(403);               // HR-tier only

      const patched = await call(request, sa, 'patch', `/api/users/${u.id}`, { persona: 'leadership' });
      expect(patched.status).toBe(200);
      expect((await dbUser(u.id)).persona).toBe('leadership');

      expect((await call(request, old, 'get', '/api/auth/me')).body.user.persona).toBe('hiring_manager');   // the token carries the persona it was issued with
      expect((await call(request, old, 'get', '/api/agencies')).status).toBe(403);
      const fresh = await login(request, u.email);
      expect(fresh.body.user.persona).toBe('leadership');
      expect((await call(request, fresh.body.token, 'get', '/api/agencies')).status).toBe(200);
    });

    test('TODAY: and a demoted user keeps the old, higher persona in the old token (privileges outlive the demotion by up to the token lifetime)', async ({ request }) => {
      const u = users.promoted;
      const old = await tokenFor(request, 'promoted');                                           // leadership token
      expect((await call(request, old, 'get', '/api/agencies')).status).toBe(200);

      expect((await call(request, sa, 'patch', `/api/users/${u.id}`, { persona: 'hiring_manager' })).status).toBe(200);
      expect((await dbUser(u.id)).persona).toBe('hiring_manager');

      expect((await call(request, old, 'get', '/api/auth/me')).body.user.persona).toBe('leadership');
      expect((await call(request, old, 'get', '/api/agencies')).status).toBe(200);                // still HR-tier
      const fresh = await login(request, u.email);
      expect(fresh.body.user.persona).toBe('hiring_manager');
      expect((await call(request, fresh.body.token, 'get', '/api/agencies')).status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('super_admin', () => {
    test('the API never creates or assigns it (or the retired "interviewer"): 400, and no row is written or changed', async ({ request }) => {
      const target = users.promoted;
      const before = await dbUser(target.id);
      const email = `${EMAIL_PREFIX}${RUN}.never@example.com`;
      for (const persona of ['super_admin', 'interviewer', 'admin']) {
        const created = await call(request, sa, 'post', '/api/users', { name: 'Never', email, persona });
        expect(created.status, persona).toBe(400);
        expect(created.body.error, persona).toMatch(/persona must be one of: hr_recruiter, hiring_manager, leadership/);
        const patched = await call(request, sa, 'patch', `/api/users/${target.id}`, { persona });
        expect(patched.status, persona).toBe(400);
      }
      expect((await db.query(`SELECT 1 FROM users WHERE email=$1`, [email])).rowCount).toBe(0);
      expect(await dbUser(target.id)).toEqual(before);
      expect((await db.query(`SELECT email FROM users WHERE persona='super_admin'`)).rows.map(r => r.email)).toEqual(['superadmin@digitalpaani.com']);
    });

    test('a super_admin cannot change their own persona or active status (self-lockout); an own-profile edit that touches neither is allowed', async ({ request }) => {
      const id = (await db.query(`SELECT id FROM users WHERE email='superadmin@digitalpaani.com'`)).rows[0].id as string;
      const before = await dbUser(id);
      for (const body of [{ persona: 'hr_recruiter' }, { is_active: false }, { persona: 'leadership', is_active: true }]) {
        const r = await call(request, sa, 'patch', `/api/users/${id}`, body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.body.error).toMatch(/cannot change your own role or active status/);
      }
      expect(await dbUser(id)).toEqual(before);
      const own = await call(request, sa, 'patch', `/api/users/${id}`, { department: before.department });   // value unchanged, so the seeded row stays as it was
      expect(own.status).toBe(200);
    });

    test('only a super_admin reaches /api/users: HR, Leadership, a Hiring Manager and an anonymous caller are refused', async ({ request }) => {
      for (const who of ['hr', 'hr2', 'leadership', 'hm_alex'] as const) {
        const token = await getToken(request, who);
        expect((await call(request, token, 'get', '/api/users')).status, who).toBe(403);
        expect((await call(request, token, 'post', '/api/users', { name: 'x', email: 'x@example.com', persona: 'hr_recruiter' })).status, who).toBe(403);
      }
      expect((await request.get(`${BASE}/api/users`)).status()).toBe(401);
    });

    test('TODAY: nothing in the database limits super_admin to one row — a second one can be inserted by SQL and signs in as super_admin', async ({ request }) => {
      await makeUser('second_sa', 'super_admin');
      expect((await db.query(`SELECT count(*)::int AS n FROM users WHERE persona='super_admin'`)).rows[0].n).toBe(2);
      const t = await tokenFor(request, 'second_sa');
      expect((await call(request, t, 'get', '/api/auth/me')).body.user.persona).toBe('super_admin');
      expect((await call(request, t, 'get', '/api/users')).status).toBe(200);
    });

    test('a DEACTIVATED super_admin\'s old token is refused 401 at the authenticate gate, before requireSuperAdmin: it can neither list users nor edit another one', async ({ request }) => {
      const t = await tokenFor(request, 'second_sa');
      expect((await call(request, t, 'get', '/api/users')).status).toBe(200);                    // control: while active, the token opens User Management
      expect((await setActive(request, users.second_sa.id, false)).status).toBe(200);
      expect((await dbUser(users.second_sa.id)).is_active).toBe(false);
      expect((await login(request, users.second_sa.email)).status).toBe(401);                    // cannot sign in again ...

      const gone = { error: 'Account is deactivated or no longer exists' };
      const list = await call(request, t, 'get', '/api/users');                                  // ... and the token they already hold no longer opens anything
      expect(list.status).toBe(401);
      expect(list.body).toEqual(gone);
      const before = (await dbUser(users.promoted.id)).department;
      const edited = await call(request, t, 'patch', `/api/users/${users.promoted.id}`, { department: `Edited after revocation ${RUN}` });
      expect(edited.status).toBe(401);
      expect(edited.body).toEqual(gone);
      expect((await dbUser(users.promoted.id)).department).toBe(before);                         // nothing was edited
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('accounts made through the API, and addresses', () => {
    test('a created user is stored trimmed and lower-case, Google-only (no password hash, auth_provider email), and the response carries no hash', async ({ request }) => {
      const mixed = `  ${EMAIL_PREFIX}${RUN}.Api.User@Example.COM  `;
      const r = await call(request, sa, 'post', '/api/users', { name: `Lifecycle api ${RUN}`, email: mixed, persona: 'hiring_manager', department: 'QA' });
      expect(r.status).toBe(201);
      const stored = mixed.trim().toLowerCase();
      expect(r.body.user).toMatchObject({ email: stored, persona: 'hiring_manager', department: 'QA', is_active: true, auth_provider: 'email' });
      expect(r.body.user).not.toHaveProperty('password_hash');
      users.api = { id: r.body.user.id, email: stored, name: `Lifecycle api ${RUN}` };
      expect(await dbUser(r.body.user.id)).toMatchObject({ email: stored, has_hash: false, auth_provider: 'email', is_active: true });

      // the same address in another spelling is a duplicate (the API compares lower-cased) and writes nothing
      const dup = await call(request, sa, 'post', '/api/users', { name: 'Dup', email: stored.toUpperCase(), persona: 'leadership' });
      expect(dup.status).toBe(400);
      expect(dup.body.error).toMatch(/already exists/);
      expect((await db.query(`SELECT count(*)::int AS n FROM users WHERE email ILIKE $1`, [stored])).rows[0].n).toBe(1);
    });

    test('TODAY: a password sign-in to that Google-only account answers 400 "uses Google sign-in" — not the 401 an unknown address gets, so it reveals the account exists', async ({ request }) => {
      const known = await login(request, users.api.email, 'whatever');
      expect(known.status).toBe(400);
      expect(known.body.error).toMatch(/uses Google sign-in/);
      const unknown = await login(request, `${EMAIL_PREFIX}${RUN}.absent@example.com`, 'whatever');
      expect(unknown.status).toBe(401);
      expect(known.body.token).toBeUndefined();
    });

    test('PATCH stores a new address trimmed and lower-case, and an edit never touches the password hash', async ({ request }) => {
      const r = await call(request, sa, 'patch', `/api/users/${users.api.id}`, { email: `  ${EMAIL_PREFIX}${RUN}.Api.Renamed@EXAMPLE.com `, name: `Lifecycle api renamed ${RUN}` });
      expect(r.status).toBe(200);
      expect(r.body.user.email).toBe(`${EMAIL_PREFIX}${RUN}.api.renamed@example.com`);
      expect(await dbUser(users.api.id)).toMatchObject({ has_hash: false, auth_provider: 'email' });
      expect((await call(request, sa, 'patch', `/api/users/${users.api.id}`, {})).status).toBe(400);   // no fields
    });

    test('an unknown user id is a 404', async ({ request }) => {
      const r = await call(request, sa, 'patch', '/api/users/00000000-0000-0000-0000-00000000dead', { department: 'x' });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('User not found');
    });

    test('TODAY: a malformed user id is a 500 (the id reaches Postgres as a uuid and fails the cast) — not a 400 or 404', async ({ request }) => {
      const r = await call(request, sa, 'patch', '/api/users/not-a-uuid', { department: 'x' });
      expect(r.status).toBe(500);
    });

    test('TODAY: users.email is a case-sensitive UNIQUE: SQL can store an address with capitals, that user can never sign in by password, and once a lower-case twin exists the same sign-in lands on the TWIN', async ({ request }) => {
      const lower = `${EMAIL_PREFIX}${RUN}.casetwin@example.com`;
      const upper = `${EMAIL_PREFIX}${RUN}.CaseTwin@example.com`;
      await makeUser('upper', 'hr_recruiter', { email: upper });
      expect((await login(request, upper)).status).toBe(401);                                    // login lower-cases what it is given: a stored capital is never matched
      expect((await login(request, lower)).status).toBe(401);                                    // ... and the lower-case spelling matches no row either
      await makeUser('lower', 'hr_recruiter', { email: lower });                                 // accepted: 'a@b' and 'A@b' are different strings to the UNIQUE
      expect((await db.query(`SELECT count(*)::int AS n FROM users WHERE lower(email) = $1`, [lower])).rows[0].n).toBe(2);
      const viaUpper = await login(request, upper);                                              // the user typing the capitals now signs in as somebody else
      expect(viaUpper.status).toBe(200);
      expect(viaUpper.body.user.id).toBe(users.lower.id);
      expect(viaUpper.body.user.id).not.toBe(users.upper.id);
    });
  });
});
