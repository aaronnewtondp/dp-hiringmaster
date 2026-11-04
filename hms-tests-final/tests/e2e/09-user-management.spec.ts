/**
 * E2E — User Management (/users) and the Super-Admin rules around it.
 *
 * The only screen that can grant or revoke access. It is Super-Admin only (RequireSuperAdmin), `super_admin` is never a selectable role,
 * "Remove access" is is_active=false and never a hard delete, and the signed-in Super-Admin cannot touch their own row. Everything here
 * runs through the real UI against the real API and database of the stack under test; the seeded fixture `super_admin` signs in.
 *
 * What a user created here can do afterwards is part of the contract: it is a Google-only account (no password), so it can sign in through
 * POST /api/auth/login only after a password is set by SQL (helpers/e2e-misc.ts giveSeedPassword) — exactly how the seeded fixtures work.
 *
 * Test data: users `um-pw-<run>-…@example.com`, removed in afterAll (and any leftover of a crashed earlier run in beforeAll).
 * Service workers are blocked for this file so `page.route` sees every request on the dev server and on a production build alike.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { BASE, USERS, authed, getToken, uid } from '../helpers/api';
import { gotoAs, expectNoPageErrors, loginViaApi } from '../helpers/e2e';
import {
  countUsers, deleteUsersByEmail, deleteUsersWithPrefix, expectRealText, giveSeedPassword, openWithSession, userRowByEmail,
} from '../helpers/e2e-misc';

test.use({ serviceWorkers: 'block' });

const ROLE_LABEL: Record<string, string> = {
  hr_recruiter: 'HR/Admin', hiring_manager: 'Hiring Manager', leadership: 'Leadership', super_admin: 'Super Admin',
};
// The only roles the dropdown may ever offer (value -> label), in this order.
const ASSIGNABLE: Array<[string, string]> = [['hr_recruiter', 'HR/Admin'], ['hiring_manager', 'Hiring Manager'], ['leadership', 'Leadership']];

const RUN = uid();
const PREFIX = 'um-pw-';
const emailOf = (tag: string) => `${PREFIX}${RUN}-${tag}@example.com`;
const created: string[] = [];                       // every e-mail this file created, for afterAll

test.beforeAll(async () => { await deleteUsersWithPrefix(PREFIX); });
test.afterAll(async () => { await deleteUsersByEmail(created); await deleteUsersWithPrefix(`${PREFIX}${RUN}`); });

// ── Small page helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const openUsers = (page: Page) => gotoAs(page, 'super_admin', '/users');
const addUserButton = (page: Page) => page.getByRole('button', { name: 'Add user' }).first();   // the page's own button; the modal's submit has the same label
const modalHeading = (page: Page, name: 'Add user' | 'Edit user') => page.getByRole('heading', { name, level: 3 });
const modalSubmit = (page: Page) => page.getByRole('button', { name: 'Cancel' }).locator('xpath=following-sibling::button');
const modalCancel = (page: Page) => page.getByRole('button', { name: 'Cancel' });
const nameInput = (page: Page) => page.getByPlaceholder('e.g. Priya Sharma');
const emailInput = (page: Page) => page.getByPlaceholder('name@digitalpaani.com');
const departmentInput = (page: Page) => page.getByPlaceholder('e.g. HR');
const roleSelect = (page: Page) => page.locator('select');
const rowOf = (page: Page, email: string) => page.getByRole('row').filter({ hasText: email });
const toast = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text }).first();
const usersCount = (page: Page) => page.getByText(/^\d+ users$/);

/** The row's seven cells as plain text (DOM text, not the CSS-transformed rendering). */
async function cells(page: Page, email: string): Promise<string[]> {
  return (await rowOf(page, email).locator('td').allTextContents()).map(s => s.replace(/\s+/g, ' ').trim());
}

async function login(request: APIRequestContext, email: string, password = 'password123') {
  return request.post(`${BASE}/api/auth/login`, { data: { email, password } });
}

/** Records every request the page makes to /api/users... (any method), so a test can prove what the UI did and did not send. */
function watchUserRequests(page: Page): Array<{ method: string; path: string; body: unknown }> {
  const seen: Array<{ method: string; path: string; body: unknown }> = [];
  page.on('request', r => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/users')) return;
    let body: unknown = null;
    try { body = r.postDataJSON(); } catch { body = r.postData(); }
    seen.push({ method: r.method(), path: u.pathname, body });
  });
  return seen;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The page guard
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('who can open /users', () => {
  for (const key of ['hr', 'hr2', 'leadership', 'hm_alex', 'hm_satyadev'] as const) {
    test(`${key} (${USERS[key].persona}) is bounced to the dashboard before any user data is requested, and has no menu link`, async ({ page }) => {
      const requests = watchUserRequests(page);
      await gotoAs(page, key, '/users');
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'User Management' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'User Management' })).toHaveCount(0);
      expect(requests, 'a bounced persona must not even request the user list').toEqual([]);
    });
  }

  test('a signed-out visitor to /users lands on the login page', async ({ page }) => {
    await page.goto('/users');
    await expect(page).toHaveURL(/\/login/);
  });

  test('super_admin sees the menu link, opens /users from it and stays there when the URL is typed', async ({ page }) => {
    await loginViaApi(page, 'super_admin');                            // lands on /dashboard
    const link = page.getByRole('link', { name: 'User Management' });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/users$/);
    await expect(page.getByRole('heading', { name: 'User Management', level: 1 })).toBeVisible();
    await openUsers(page);                                             // a direct visit (full page load) must not bounce the super_admin
    await expect(page).toHaveURL(/\/users$/);
    await expect(page.getByRole('heading', { name: 'User Management', level: 1 })).toBeVisible();
  });

  test('the bounce is not the security boundary: the server refuses the user list to everyone but super_admin', async ({ request }) => {
    for (const key of ['hr', 'hr2', 'leadership', 'hm_alex', 'hm_satyadev'] as const) {
      const res = await authed(request, await getToken(request, key)).get('/api/users');
      expect(res.status(), `${key} must not read /api/users`).toBe(403);
    }
    expect((await request.get(`${BASE}/api/users`)).status(), 'no token').toBe(401);
    expect((await authed(request, await getToken(request, 'super_admin')).get('/api/users')).status()).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The table
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('the user table', () => {
  test('lists every user the API returns, with role label, department, status and last login, and never receives a password hash', async ({ page, request }) => {
    const pageErrors = expectNoPageErrors(page);
    const listed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/users' && r.request().method() === 'GET');
    await openUsers(page);
    const body = await (await listed).json() as { users: Array<Record<string, unknown>> };

    // what the browser received carries no secret
    for (const u of body.users) {
      expect(Object.keys(u), `user ${String(u.email)}`).not.toContain('password_hash');
      expect(Object.keys(u), `user ${String(u.email)}`).not.toContain('google_id');
    }

    await expect(page.getByRole('heading', { name: 'User Management', level: 1 })).toBeVisible();
    await expect(page.locator('thead th')).toHaveCount(7);
    expect((await page.locator('thead th').allTextContents()).map(s => s.trim())).toEqual(['Name', 'Email', 'Role', 'Department', 'Status', 'Last Login', '']);

    const api = await (await authed(request, await getToken(request, 'super_admin')).get('/api/users')).json() as { users: Array<{
      name: string; email: string; persona: string; department: string | null; is_active: boolean; last_login: string | null;
    }> };
    expect(api.users.length).toBeGreaterThanOrEqual(9);                      // the seed has nine
    await expect(page.locator('tbody tr')).toHaveCount(api.users.length);
    await expect(usersCount(page)).toHaveText(`${api.users.length} users`);

    // row by row, in the API's order (persona, then name)
    for (let i = 0; i < api.users.length; i++) {
      const u = api.users[i];
      const row = (await page.locator('tbody tr').nth(i).locator('td').allTextContents()).map(s => s.replace(/\s+/g, ' ').trim());
      expect(row.slice(0, 5), `row ${i}`).toEqual([u.name, u.email, ROLE_LABEL[u.persona], u.department || '—', u.is_active ? 'Active' : 'Inactive']);
      if (u.last_login) expect(row[5], `last login of ${u.email}`).not.toBe('Never'); else expect(row[5], `last login of ${u.email}`).toBe('Never');
      expectRealText(row.join(' | '), `row ${i}`);
    }
    pageErrors.check();
  });

  test('every manageable user has Edit and Deactivate; the signed-in super_admin has neither on their own row', async ({ page }) => {
    await openUsers(page);
    const own = rowOf(page, USERS.super_admin.email);
    await expect(own).toHaveCount(1);
    await expect(own.getByRole('button')).toHaveCount(0);                                      // no Edit, no Deactivate/Reactivate
    await expect(own.locator('td').nth(2)).toHaveText(ROLE_LABEL.super_admin);
    await expect(own.getByTitle(/managed outside this page/i)).toBeVisible();                  // the dash explains itself

    const others = page.locator('tbody tr').filter({ hasNot: page.getByText(USERS.super_admin.email) });
    const n = await others.count();
    expect(n).toBeGreaterThanOrEqual(8);
    for (let i = 0; i < n; i++) {
      await expect(others.nth(i).getByRole('button', { name: 'Edit' })).toBeEnabled();
      await expect(others.nth(i).getByRole('button', { name: /^(Deactivate|Reactivate)$/ })).toBeEnabled();
    }
  });

  test('the server enforces what the UI hides: no self-lockout, super_admin can never be granted', async ({ request }) => {
    const token = await getToken(request, 'super_admin');
    const api = authed(request, token);
    const me = await (await api.get('/api/auth/me')).json() as { user: { userId: string } };
    const before = await countUsers();

    // the signed-in super_admin cannot change their own role or deactivate themselves ...
    for (const body of [{ is_active: false }, { persona: 'leadership' }, { persona: 'hr_recruiter', is_active: true }]) {
      const res = await api.patch(`/api/users/${me.user.userId}`, body);
      expect(res.status(), JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toMatch(/own role or active status/i);
    }
    expect((await userRowByEmail(USERS.super_admin.email))!.is_active).toBe(true);
    expect((await userRowByEmail(USERS.super_admin.email))!.persona).toBe('super_admin');

    // ... and nobody can create or promote anyone to super_admin, whatever the UI shows
    const email = emailOf('sa-attempt');
    created.push(email);
    const res = await api.post('/api/users', { name: 'UM no super admin', email, persona: 'super_admin' });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/persona must be one of/i);
    expect(await userRowByEmail(email), 'a refused create must not leave a row').toBeNull();
    const target = (await userRowByEmail(USERS.hr2.email))!;
    expect((await api.patch(`/api/users/${target.id}`, { persona: 'super_admin' })).status()).toBe(400);
    expect((await userRowByEmail(USERS.hr2.email))!.persona).toBe('hr_recruiter');
    expect(await countUsers()).toBe(before);
  });

  test('the server validates what the UI already checks: required fields (400), a created user answers 201, an unknown id answers 404', async ({ request }) => {
    const api = authed(request, await getToken(request, 'super_admin'));
    const before = await countUsers();
    for (const body of [{ email: emailOf('nf1'), persona: 'leadership' }, { name: 'UM no email', persona: 'leadership' }, { name: 'UM no role', email: emailOf('nf3') }]) {
      const res = await api.post('/api/users', body);
      expect(res.status(), JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toMatch(/required/i);
    }
    expect(await countUsers(), 'a refused create must not leave a row').toBe(before);

    const email = emailOf('status-201');
    created.push(email);
    const ok = await api.post('/api/users', { name: 'UM status check', email, persona: 'leadership' });
    expect(ok.status()).toBe(201);
    expect((await ok.json()).user.email).toBe(email);

    const missing = await api.patch('/api/users/00000000-0000-0000-0000-000000000000', { name: 'UM nobody' });
    expect(missing.status()).toBe(404);
    expect((await missing.json()).error).toMatch(/not found/i);
    const empty = await api.patch(`/api/users/${(await userRowByEmail(email))!.id}`, {});
    expect(empty.status()).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The Add user modal
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Add user modal', () => {
  test('the Role dropdown offers exactly HR/Admin, Hiring Manager and Leadership (default HR/Admin) — never Super Admin', async ({ page }) => {
    const requests = watchUserRequests(page);
    await openUsers(page);
    await addUserButton(page).click();
    await expect(modalHeading(page, 'Add user')).toBeVisible();

    const options = await roleSelect(page).locator('option').evaluateAll(els => els.map(o => [(o as HTMLOptionElement).value, (o.textContent || '').trim()]));
    expect(options).toEqual(ASSIGNABLE);
    await expect(roleSelect(page)).toHaveValue('hr_recruiter');
    expect(options.flat().join(' ')).not.toMatch(/super/i);

    // closing it by Cancel and by the X sends nothing
    await modalCancel(page).click();
    await expect(modalHeading(page, 'Add user')).toHaveCount(0);
    await addUserButton(page).click();
    await modalHeading(page, 'Add user').locator('xpath=following-sibling::button').click();
    await expect(modalHeading(page, 'Add user')).toHaveCount(0);
    expect(requests.filter(r => r.method !== 'GET'), 'opening and closing the modal must not write anything').toEqual([]);
  });

  test('an empty or blank name or e-mail is refused in the browser, with a message and no request', async ({ page }) => {
    const requests = watchUserRequests(page);
    await openUsers(page);
    const before = await countUsers();
    await addUserButton(page).click();

    await modalSubmit(page).click();                                                  // nothing typed
    await expect(toast(page, 'Name is required')).toBeVisible();

    await nameInput(page).fill('   ');                                                // spaces only count as empty
    await emailInput(page).fill('someone@example.com');
    await modalSubmit(page).click();
    await expect(toast(page, 'Name is required')).toBeVisible();

    await nameInput(page).fill('UM Needs An Email');
    await emailInput(page).fill('   ');
    await modalSubmit(page).click();
    await expect(toast(page, 'Email is required')).toBeVisible();

    await expect(modalHeading(page, 'Add user')).toBeVisible();                       // still open
    expect(requests.filter(r => r.method !== 'GET')).toEqual([]);
    expect(await countUsers()).toBe(before);
  });

  test('an e-mail that already exists (other case, padded with spaces) shows the server\'s message and keeps the modal open', async ({ page }) => {
    const requests = watchUserRequests(page);
    await openUsers(page);
    const before = await countUsers();
    await addUserButton(page).click();
    await nameInput(page).fill('UM Duplicate Attempt');
    await emailInput(page).fill(`  ${USERS.hm_alex.email.toUpperCase()}  `);
    await modalSubmit(page).click();

    await expect(toast(page, 'A user with this email already exists')).toBeVisible();
    await expect(modalHeading(page, 'Add user')).toBeVisible();
    await expect(modalSubmit(page)).toBeEnabled();                                     // the button comes back, the form is not stuck
    expect(requests.filter(r => r.method === 'POST')).toHaveLength(1);
    expect(await countUsers()).toBe(before);
  });

  test('a failed request keeps the modal open and says the save failed', async ({ page }) => {
    await openUsers(page);
    const before = await countUsers();
    await page.route('**/api/users', route => (route.request().method() === 'POST' ? route.abort('failed') : route.continue()));
    await addUserButton(page).click();
    await nameInput(page).fill('UM Offline Attempt');
    await emailInput(page).fill(emailOf('offline'));
    created.push(emailOf('offline'));
    await modalSubmit(page).click();

    await expect(toast(page, 'Failed to save user')).toBeVisible();
    await expect(modalHeading(page, 'Add user')).toBeVisible();
    await expect(modalSubmit(page)).toBeEnabled();
    expect(await countUsers()).toBe(before);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The life of one user: add, sign in, edit, remove access, restore access
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('one user, from creation to revoked access', () => {
  test.describe.configure({ mode: 'serial' });          // each step needs the user the step before created

  const email = emailOf('life');
  const name = `UM Lifecycle ${RUN}`;
  const dept = `QA-${RUN}`;
  let userId = '';
  let oldToken = '';                                    // a token issued BEFORE the role change and the deactivation

  test('Add user stores the trimmed, lower-cased e-mail, shows the row and creates no password', async ({ page }) => {
    created.push(email);
    const requests = watchUserRequests(page);
    await openUsers(page);
    const before = await countUsers();

    await addUserButton(page).click();
    await nameInput(page).fill(`  ${name}  `);
    await emailInput(page).fill(`  ${PREFIX}${RUN}-LIFE@Example.COM  `);                 // typed in mixed case, padded with spaces
    await roleSelect(page).selectOption('hiring_manager');
    await departmentInput(page).fill(dept);
    await modalSubmit(page).click();

    await expect(toast(page, 'User added')).toBeVisible();
    await expect(modalHeading(page, 'Add user')).toHaveCount(0);
    await expect(rowOf(page, email)).toHaveCount(1);
    const row = await cells(page, email);
    expect(row.slice(0, 6)).toEqual([name, email, 'Hiring Manager', dept, 'Active', 'Never']);
    await expect(usersCount(page)).toHaveText(`${before + 1} users`);

    const post = requests.filter(r => r.method === 'POST');
    expect(post).toHaveLength(1);
    expect(post[0].body).toMatchObject({ name, persona: 'hiring_manager', department: dept });   // the UI sent the trimmed values

    const db = (await userRowByEmail(email))!;
    expect(db).toMatchObject({ name, email, persona: 'hiring_manager', department: dept, is_active: true, has_password: false });
    userId = db.id;
    expect(await countUsers()).toBe(before + 1);
  });

  test('a user created in the UI is Google-only: password sign-in answers 400 and points at Google', async ({ request }) => {
    const res = await login(request, email);
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/google/i);
    expect((await login(request, email, 'wrong-password')).status()).toBe(400);              // no password exists to be wrong about
  });

  test('once it has a password it signs in through POST /api/auth/login as the person entered in the UI, and can use the app', async ({ page, request }) => {
    expect(await giveSeedPassword(email)).toBe(1);
    const res = await login(request, email);
    expect(res.status()).toBe(200);
    const session = await res.json() as { token: string; user: { id: string; name: string; email: string; persona: string; department: string | null; avatar_url: string | null } };
    expect(session.user).toMatchObject({ id: userId, name, email, persona: 'hiring_manager', department: dept });
    oldToken = session.token;
    expect((await request.get(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${oldToken}` } })).status()).toBe(200);
    expect((await login(request, email, 'wrong-password')).status()).toBe(401);

    // a browser session for that user: the sidebar names them with the role label, and /users is closed to them
    await openWithSession(page, session, '/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Main navigation' }).getByText(name)).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Main navigation' }).getByText('Hiring Manager', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'User Management' })).toHaveCount(0);
    await page.goto('/users');
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('Edit opens prefilled; the role dropdown still has no Super Admin; saving changes the row, the database and the next sign-in', async ({ page, request }) => {
    const requests = watchUserRequests(page);
    await openUsers(page);
    await rowOf(page, email).getByRole('button', { name: 'Edit' }).click();
    await expect(modalHeading(page, 'Edit user')).toBeVisible();

    await expect(nameInput(page)).toHaveValue(name);
    await expect(emailInput(page)).toHaveValue(email);
    await expect(departmentInput(page)).toHaveValue(dept);
    await expect(roleSelect(page)).toHaveValue('hiring_manager');
    const options = await roleSelect(page).locator('option').evaluateAll(els => els.map(o => [(o as HTMLOptionElement).value, (o.textContent || '').trim()]));
    expect(options).toEqual(ASSIGNABLE);

    await roleSelect(page).selectOption('leadership');
    await departmentInput(page).fill(`${dept}-moved`);
    await modalSubmit(page).click();

    await expect(toast(page, 'User updated')).toBeVisible();
    await expect(modalHeading(page, 'Edit user')).toHaveCount(0);
    await expect.poll(async () => (await cells(page, email)).slice(0, 5), { message: 'the row shows the edit' })
      .toEqual([name, email, 'Leadership', `${dept}-moved`, 'Active']);

    const patch = requests.filter(r => r.method === 'PATCH');
    expect(patch).toHaveLength(1);
    expect(patch[0].path).toBe(`/api/users/${userId}`);
    expect(await userRowByEmail(email)).toMatchObject({ persona: 'leadership', department: `${dept}-moved`, is_active: true });

    const next = await (await login(request, email)).json() as { user: { persona: string; department: string } };
    expect(next.user).toMatchObject({ persona: 'leadership', department: `${dept}-moved` });
  });

  test('Edit: an empty name is refused in the browser, and Cancel sends nothing', async ({ page }) => {
    const requests = watchUserRequests(page);
    await openUsers(page);
    await rowOf(page, email).getByRole('button', { name: 'Edit' }).click();
    await nameInput(page).fill('');
    await modalSubmit(page).click();
    await expect(toast(page, 'Name is required')).toBeVisible();
    await expect(modalHeading(page, 'Edit user')).toBeVisible();
    await modalCancel(page).click();
    await expect(modalHeading(page, 'Edit user')).toHaveCount(0);
    expect(requests.filter(r => r.method !== 'GET')).toEqual([]);
    expect((await userRowByEmail(email))!.name).toBe(name);
  });

  test('Edit: a changed e-mail is stored lower-cased and the old address stops being a user', async ({ page }) => {
    const newEmail = emailOf('life-moved');
    created.push(newEmail);
    await openUsers(page);
    await rowOf(page, email).getByRole('button', { name: 'Edit' }).click();
    await emailInput(page).fill(newEmail.toUpperCase().replace('@EXAMPLE.COM', '@Example.com'));
    await modalSubmit(page).click();
    await expect(toast(page, 'User updated')).toBeVisible();
    await expect(rowOf(page, newEmail)).toHaveCount(1);
    expect(await userRowByEmail(email)).toBeNull();
    expect((await userRowByEmail(newEmail))!.id).toBe(userId);

    // put it back so the later steps (and the cleanup list) keep one address
    await rowOf(page, newEmail).getByRole('button', { name: 'Edit' }).click();
    await emailInput(page).fill(email);
    await modalSubmit(page).click();
    await expect(toast(page, 'User updated').last()).toBeVisible();
    await expect(rowOf(page, email)).toHaveCount(1);
    expect((await userRowByEmail(email))!.id).toBe(userId);
  });

  test('TODAY: clearing the Department field in Edit does not clear it (the UI sends nothing for a blank department, the API reads that as "no change")', async ({ page }) => {
    const requests = watchUserRequests(page);
    await openUsers(page);
    await rowOf(page, email).getByRole('button', { name: 'Edit' }).click();
    await departmentInput(page).fill('');
    await modalSubmit(page).click();
    await expect(toast(page, 'User updated').first()).toBeVisible();

    const patch = requests.filter(r => r.method === 'PATCH');
    expect(patch).toHaveLength(1);
    expect(patch[0].body, 'a blank department is dropped from the request').not.toHaveProperty('department');
    expect((await userRowByEmail(email))!.department, 'so the old department is still stored').toBe(`${dept}-moved`);
    await expect.poll(async () => (await cells(page, email))[3]).toBe(`${dept}-moved`);
  });

  test('Deactivate revokes access: toast, Inactive, a Reactivate button, the row stays in the database, no DELETE is sent, password sign-in is refused', async ({ page, request }) => {
    const requests = watchUserRequests(page);
    await openUsers(page);
    const before = await countUsers();

    await rowOf(page, email).getByRole('button', { name: 'Deactivate' }).click();
    await expect(toast(page, 'Access revoked')).toBeVisible();
    await expect.poll(async () => (await cells(page, email))[4]).toBe('Inactive');
    await expect(rowOf(page, email).getByRole('button', { name: 'Reactivate' })).toBeEnabled();
    await expect(rowOf(page, email).getByRole('button', { name: 'Deactivate' })).toHaveCount(0);

    // "remove access" is is_active=false — the row, its history links and its e-mail stay
    expect(await userRowByEmail(email)).toMatchObject({ id: userId, is_active: false });
    expect(await countUsers()).toBe(before);
    await expect(usersCount(page)).toHaveText(`${before} users`);
    expect(requests.map(r => r.method)).not.toContain('DELETE');
    expect(requests.filter(r => r.method === 'PATCH').map(r => r.body)).toEqual([{ is_active: false }]);
    // and there is no way to hard-delete a user over the API either
    expect((await authed(request, await getToken(request, 'super_admin')).delete(`/api/users/${userId}`)).status()).toBe(404);
    expect(await userRowByEmail(email)).not.toBeNull();

    const res = await login(request, email);
    expect(res.status(), 'a deactivated user cannot sign in with a password').toBe(401);
  });

  test('TODAY: a token issued before the role change and the deactivation keeps working, with its OLD role, until it expires (authenticate() trusts the JWT and never re-reads users)', async ({ request }) => {
    expect(oldToken, 'the sign-in step must have run').not.toBe('');
    const db = (await userRowByEmail(email))!;
    expect(db.is_active).toBe(false);
    expect(db.persona).toBe('leadership');

    const me = await request.get(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${oldToken}` } });
    expect(me.status(), 'known gap: a revoked user\'s existing token is still accepted').toBe(200);
    expect((await me.json()).user.persona, 'known gap: the token still says hiring_manager although the user is now leadership').toBe('hiring_manager');
    expect((await request.get(`${BASE}/api/roles`, { headers: { Authorization: `Bearer ${oldToken}` } })).status()).toBe(200);
  });

  test('Reactivate restores access: toast, Active, and password sign-in works again', async ({ page, request }) => {
    await openUsers(page);
    await rowOf(page, email).getByRole('button', { name: 'Reactivate' }).click();
    await expect(toast(page, 'Access restored')).toBeVisible();
    await expect.poll(async () => (await cells(page, email))[4]).toBe('Active');
    await expect(rowOf(page, email).getByRole('button', { name: 'Deactivate' })).toBeEnabled();
    expect(await userRowByEmail(email)).toMatchObject({ id: userId, is_active: true });
    const res = await login(request, email);
    expect(res.status()).toBe(200);
    expect((await res.json()).user.persona).toBe('leadership');
  });

  test('an e-mail that belongs to another user cannot be edited onto this one (TODAY: refused with a 500 "Internal server error" toast, where Add user answers a clear 400)', async ({ page, request }) => {
    const requests = watchUserRequests(page);
    const answered = page.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname.startsWith('/api/users/'));
    await openUsers(page);
    await rowOf(page, email).getByRole('button', { name: 'Edit' }).click();
    await emailInput(page).fill(USERS.hm_satyadev.email);
    await modalSubmit(page).click();

    await expect(modalHeading(page, 'Edit user')).toBeVisible();                       // refused: the modal stays open
    await expect(page.getByRole('status').filter({ hasText: 'User updated' })).toHaveCount(0);
    // the requirement above is what matters; the next two lines pin how the refusal looks TODAY (users.ts PATCH has no duplicate check, the unique index throws)
    expect((await answered).status()).toBe(500);
    await expect(toast(page, 'Internal server error')).toBeVisible();
    expect(requests.filter(r => r.method === 'PATCH')).toHaveLength(1);
    expect((await userRowByEmail(email))!.id, 'the user keeps their own address').toBe(userId);
    expect((await userRowByEmail(USERS.hm_satyadev.email))!.name, 'and the other user is untouched').not.toBe(name);
    const lookup = await (await authed(request, await getToken(request, 'super_admin')).get('/api/users')).json() as { users: Array<{ email: string }> };
    expect(lookup.users.filter(u => u.email === USERS.hm_satyadev.email)).toHaveLength(1);
  });
});
