// ─────────────────────────────────────────────────────────────────────────────
// roles.jd_source ('generated' default | 'manual') — 2026-09-22. A role's
// long-form JD can be authored entirely outside this system (imported via
// backend/src/scripts/importManualJd.ts) instead of AI-generated on Approve.
// jd_source='manual' must be respected in two independent places so that
// import is never silently overwritten:
//   1. roles.ts's auto-generate-on-Approve trigger (PATCH /:id) — must skip
//      entirely for a manual role, even one with no jd_drive_link yet (e.g.
//      approved before the import script actually ran).
//   2. POST /:id/regenerate-jd — must refuse with 400 rather than overwrite.
//
// Sets jd_source/jd_drive_link directly via SQL (there's no API surface for
// either — generated_jd_content/jd_source aren't in PATCH /:id's
// allowedFields) to simulate "a manual JD was already imported for this
// role" without invoking the real importManualJd.ts script (which makes a
// real Claude call + Drive upload — out of scope for a guard-behavior test).
// INTENTIONALLY LOCAL-ONLY, same precedent as 04/05.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed, uid } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';

test.describe('roles.jd_source guards against silent overwrite', () => {
  let client: Client;
  const createdRoleIds: string[] = [];

  test.beforeAll(async () => {
    client = new Client({ connectionString: LOCAL_DB_URL });
    await client.connect();
  });

  test.afterAll(async () => {
    if (createdRoleIds.length) {
      await client.query(`DELETE FROM role_edit_log WHERE role_id = ANY($1)`, [createdRoleIds]);
      await client.query(`DELETE FROM activity_log WHERE role_id = ANY($1)`, [createdRoleIds]);
      await client.query(`DELETE FROM roles WHERE id = ANY($1)`, [createdRoleIds]);
    }
    await client.end();
  });

  async function createDraftRole(request: import('@playwright/test').APIRequestContext, token: string) {
    const res = await authed(request, token).post('/api/roles', {
      title: `Manual JD Test Role ${uid()}`,
      priority: 'P3',
    });
    expect(res.status()).toBe(201);
    const { role } = await res.json();
    createdRoleIds.push(role.id);
    return role;
  }

  test('a Draft role marked jd_source=manual (no jd_drive_link yet) skips auto-generation entirely on Approve', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const role = await createDraftRole(request, token);

    // Simulate: HR intends to import a manual JD, and has already flagged
    // the role as such, before actually running the import script.
    await client.query(`UPDATE roles SET jd_source='manual' WHERE id=$1`, [role.id]);

    const approveRes = await authed(request, token).patch(`/api/roles/${role.id}`, { status: 'Approved' });
    expect(approveRes.status()).toBe(200);
    const body = await approveRes.json();

    expect(body.role.status).toBe('Approved');
    // The auto-trigger must not have run at all — no jdGeneration field on
    // the response, and jd_drive_link/generated_jd_content stay untouched.
    expect(body.jdGeneration).toBeUndefined();
    expect(body.role.jd_drive_link).toBeFalsy();

    const { rows } = await client.query(
      `SELECT jd_drive_link, generated_jd_content FROM roles WHERE id=$1`, [role.id]
    );
    expect(rows[0].jd_drive_link).toBeNull();
    expect(rows[0].generated_jd_content).toBeNull();
  });

  test('POST /:id/regenerate-jd refuses a jd_source=manual role with a 400, leaving its links untouched', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const role = await createDraftRole(request, token);

    const fakeLongForm = 'https://drive.google.com/file/d/FAKE_MANUAL_JD_TEST/view';
    const fakeSocial = 'https://drive.google.com/file/d/FAKE_SOCIAL_JD_TEST/view';
    await client.query(
      `UPDATE roles SET status='Approved', jd_source='manual', jd_drive_link=$1, social_jd_drive_link=$2 WHERE id=$3`,
      [fakeLongForm, fakeSocial, role.id]
    );

    const res = await authed(request, token).post(`/api/roles/${role.id}/regenerate-jd`, {});
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('manually provided');

    const { rows } = await client.query(
      `SELECT jd_drive_link, social_jd_drive_link, jd_source FROM roles WHERE id=$1`, [role.id]
    );
    expect(rows[0].jd_drive_link).toBe(fakeLongForm);
    expect(rows[0].social_jd_drive_link).toBe(fakeSocial);
    expect(rows[0].jd_source).toBe('manual');
  });

  test('POST /:id/regenerate-jd on a non-Approved manual-JD role still gets the original status-guard 400, not the manual-JD one', async ({ request }) => {
    // Guards the ordering of the two checks in the route: the pre-existing
    // "must be Approved" check should still fire first/independently — my
    // new jd_source check didn't accidentally swallow or reorder it.
    const token = await getToken(request, 'hr');
    const role = await createDraftRole(request, token); // stays Draft
    await client.query(`UPDATE roles SET jd_source='manual' WHERE id=$1`, [role.id]);

    const res = await authed(request, token).post(`/api/roles/${role.id}/regenerate-jd`, {});
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Only an Approved role has a JD to regenerate.');
  });

  test('jd_source defaults to "generated" for a normally-created role', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const role = await createDraftRole(request, token);
    const { rows } = await client.query(`SELECT jd_source FROM roles WHERE id=$1`, [role.id]);
    expect(rows[0].jd_source).toBe('generated');
  });
});
