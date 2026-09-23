// ─────────────────────────────────────────────────────────────────────────────
// Aging Roles' "no recent candidate movement" flag (2026-09-22) —
// dashboard.ts's aging_roles/low_pipeline entries carry a
// no_recent_candidate_activity boolean, independent of the Close-Target-
// driven aging_alert coloring: true when no genuine activity_log event tied
// to an application under the role (excluding 'Application Created' and
// 'ResumeIQ Scoring Completed' — the two event_types a brand-new application
// generates on its own, with zero human action) has happened in the last 3
// days. The whole point is that a role can't look "active" just because new
// applications keep arriving with nobody actually working the pipeline.
//
// Uses a direct Postgres connection to backdate activity_log rows — same
// precedent as 04-role-aging-close-target.spec.ts. INTENTIONALLY LOCAL-ONLY,
// since there's no API surface to backdate a timestamp through.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';

test.describe('Aging Roles — no_recent_candidate_activity flag', () => {
  let client: Client;
  const createdRoleIds: string[] = [];
  const createdCandidateIds: string[] = [];

  test.beforeAll(async () => {
    client = new Client({ connectionString: LOCAL_DB_URL });
    await client.connect();
  });

  test.afterAll(async () => {
    if (createdRoleIds.length) {
      await client.query(`DELETE FROM activity_log WHERE role_id = ANY($1)`, [createdRoleIds]);
      await client.query(`DELETE FROM applications WHERE role_id = ANY($1)`, [createdRoleIds]);
      await client.query(`DELETE FROM pending_actions WHERE role_id = ANY($1)`, [createdRoleIds]);
      await client.query(`DELETE FROM roles WHERE id = ANY($1)`, [createdRoleIds]);
    }
    if (createdCandidateIds.length) {
      await client.query(`DELETE FROM candidates WHERE id = ANY($1)`, [createdCandidateIds]);
    }
    await client.end();
  });

  async function createRole(status = 'Live – Sourcing') {
    const { rows } = await client.query(
      `INSERT INTO roles (title, department, hiring_manager_name, priority, status, location, employment_type, start_date)
       VALUES ($1, 'Tech/Devs', 'Test HM', 'P1', $2, 'Gurgaon', 'Full-Time / Permanent', CURRENT_DATE - 30)
       RETURNING id`,
      [`No-Movement Test Role ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, status]
    );
    const id = rows[0].id;
    createdRoleIds.push(id);
    return id;
  }

  async function createApplication(roleId: string) {
    const { rows: candRows } = await client.query(
      `INSERT INTO candidates (full_name, email) VALUES ($1, $2) RETURNING id`,
      [`No-Movement Test Candidate ${Date.now()}`, `nomovement+${Date.now()}@example.com`]
    );
    const candidateId = candRows[0].id;
    createdCandidateIds.push(candidateId);

    const { rows: appRows } = await client.query(
      `INSERT INTO applications (candidate_id, role_id) VALUES ($1, $2) RETURNING id`,
      [candidateId, roleId]
    );
    return appRows[0].id as string;
  }

  async function insertActivity(roleId: string, applicationId: string | null, eventType: string, daysAgo: number) {
    await client.query(
      `INSERT INTO activity_log (role_id, application_id, event_type, event_detail, created_at)
       VALUES ($1, $2, $3, $4, NOW() - make_interval(days => $5::int))`,
      [roleId, applicationId, eventType, `${eventType} test event`, daysAgo]
    );
  }

  async function findAgingRole(request: import('@playwright/test').APIRequestContext, roleId: string) {
    const hrToken = await getToken(request, 'hr');
    const res = await authed(request, hrToken).get('/api/dashboard');
    expect(res.status()).toBe(200);
    const { aging_roles } = await res.json();
    const entry = aging_roles.find((r: { id: string }) => r.id === roleId);
    expect(entry, `role ${roleId} should appear in aging_roles`).toBeTruthy();
    return entry;
  }

  test('a role with zero applications ever is flagged (no qualifying activity to look at)', async ({ request }) => {
    const roleId = await createRole();
    const entry = await findAgingRole(request, roleId);
    expect(entry.no_recent_candidate_activity).toBe(true);
  });

  test('a role whose only activity_log rows are Application Created / ResumeIQ Scoring Completed — even from today — is still flagged', async ({ request }) => {
    const roleId = await createRole();
    const appId = await createApplication(roleId);
    await insertActivity(roleId, appId, 'Application Created', 0);
    await insertActivity(roleId, appId, 'ResumeIQ Scoring Completed', 0);

    const entry = await findAgingRole(request, roleId);
    expect(entry.no_recent_candidate_activity).toBe(true);
  });

  test('a role whose last genuine action was 4 days ago, with nothing since, is flagged', async ({ request }) => {
    const roleId = await createRole();
    const appId = await createApplication(roleId);
    await insertActivity(roleId, appId, 'Application Created', 4);
    await insertActivity(roleId, appId, 'Stage Changed', 4);

    const entry = await findAgingRole(request, roleId);
    expect(entry.no_recent_candidate_activity).toBe(true);
  });

  test('a role with a genuine action in the last 3 days is NOT flagged', async ({ request }) => {
    const roleId = await createRole();
    const appId = await createApplication(roleId);
    await insertActivity(roleId, appId, 'Application Created', 10);
    await insertActivity(roleId, appId, 'Stage Changed', 1);

    const entry = await findAgingRole(request, roleId);
    expect(entry.no_recent_candidate_activity).toBe(false);
  });

  // The exact scenario the flag exists to catch: a role can accumulate many
  // brand-new applications while genuinely stalled — new applications alone
  // must never clear the flag.
  test('a pile of fresh applications arriving today does not clear a stale flag from a real action 5 days ago', async ({ request }) => {
    const roleId = await createRole();
    const staleApp = await createApplication(roleId);
    await insertActivity(roleId, staleApp, 'Status Changed', 5);

    for (let i = 0; i < 5; i++) {
      const freshApp = await createApplication(roleId);
      await insertActivity(roleId, freshApp, 'Application Created', 0);
      await insertActivity(roleId, freshApp, 'ResumeIQ Scoring Completed', 0);
    }

    const entry = await findAgingRole(request, roleId);
    expect(entry.no_recent_candidate_activity).toBe(true);
  });

  test('a genuine action on ANY application under the role — not just the most recently created one — clears the flag', async ({ request }) => {
    const roleId = await createRole();
    const oldApp = await createApplication(roleId);
    await insertActivity(roleId, oldApp, 'Application Created', 10);

    const recentApp = await createApplication(roleId);
    await insertActivity(roleId, recentApp, 'Application Created', 0);
    await insertActivity(roleId, oldApp, 'Interview Feedback Submitted', 1); // real action on the OLDER application

    const entry = await findAgingRole(request, roleId);
    expect(entry.no_recent_candidate_activity).toBe(false);
  });

  test('role-metadata-only activity (e.g. Role Updated, no application_id) never counts as candidate movement', async ({ request }) => {
    const roleId = await createRole();
    const appId = await createApplication(roleId);
    await insertActivity(roleId, appId, 'Application Created', 10);
    // application_id NULL — role-level event, e.g. 'Role Updated'/'JD Generated'
    await client.query(
      `INSERT INTO activity_log (role_id, application_id, event_type, event_detail, created_at)
       VALUES ($1, NULL, 'Role Updated', 'field edit', NOW())`,
      [roleId]
    );

    const entry = await findAgingRole(request, roleId);
    expect(entry.no_recent_candidate_activity).toBe(true);
  });

  test('low_pipeline entries (when present) carry the same field, consistent with aging_roles', async ({ request }) => {
    // low_pipeline is a filtered subset of the same rolesWithAging array
    // aging_roles comes from — a role with < 3 shortlisted+scored applications
    // and zero real activity should show up in both, with the same value.
    const roleId = await createRole();

    const hrToken = await getToken(request, 'hr');
    const res = await authed(request, hrToken).get('/api/dashboard');
    const { low_pipeline } = await res.json();
    const entry = low_pipeline.find((r: { id: string }) => r.id === roleId);
    expect(entry, `role ${roleId} should appear in low_pipeline (0 shortlisted+scored applications)`).toBeTruthy();
    expect(entry.no_recent_candidate_activity).toBe(true);
  });
});
