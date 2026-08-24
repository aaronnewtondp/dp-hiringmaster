// ─────────────────────────────────────────────────────────────────────────────
// Role aging alert — now driven by target_closure_date, not days-since-open
// (2026-08-25 product decision). A user reported pushing a role's Close
// Target out to a future date had no effect on its red aging alert — turned
// out the alert was computed purely from days-since-start_date vs a
// per-priority threshold, with no relationship to Close Target at all.
//
// New behavior (backend/src/utils/aging.ts, shared by roles.ts, dashboard.ts,
// and slaChecker.ts's checkRoleAging — previously three independent copies
// of the aging math that could disagree with each other):
//   - target_closure_date in the future (or role has none at all... see the
//     no-target case below) → no overdue alert regardless of how long the
//     role has been open.
//   - target_closure_date in the past → red/yellow driven by days PAST that
//     date (days_overdue), using the same per-priority AGING_THRESHOLDS
//     values as before, just re-anchored.
//   - days_open is still returned and still shown (both stats side by side
//     per the product decision), it just no longer drives the alert color
//     on its own when a Close Target is set.
//   - No target_closure_date at all → falls back to the legacy days-open
//     thresholds, so a role that's never had a target entered doesn't
//     silently lose aging visibility.
//
// Uses a direct Postgres connection to insert/backdate roles — same
// precedent as 01-talent-pool-archival.spec.ts and 03-dashboard-audit-fixes.
// INTENTIONALLY LOCAL-ONLY.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed, CRON_SECRET } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';

test.describe('Role aging alert — target_closure_date driven, not days-open driven', () => {
  let client: Client;
  const createdRoleIds: string[] = [];

  test.beforeAll(async () => {
    client = new Client({ connectionString: LOCAL_DB_URL });
    await client.connect();
  });

  test.afterAll(async () => {
    if (createdRoleIds.length) {
      await client.query(`DELETE FROM pending_actions WHERE role_id = ANY($1)`, [createdRoleIds]);
      await client.query(`DELETE FROM role_edit_log WHERE role_id = ANY($1)`, [createdRoleIds]);
      await client.query(`DELETE FROM activity_log WHERE role_id = ANY($1)`, [createdRoleIds]);
      await client.query(`DELETE FROM roles WHERE id = ANY($1)`, [createdRoleIds]);
    }
    await client.end();
  });

  async function createRole(overrides: { priority?: string; startDaysAgo: number; targetClosureDaysFromNow: number | null }) {
    const startDate = new Date(Date.now() - overrides.startDaysAgo * 86400000).toISOString().slice(0, 10);
    const targetDate = overrides.targetClosureDaysFromNow == null
      ? null
      : new Date(Date.now() + overrides.targetClosureDaysFromNow * 86400000).toISOString().slice(0, 10);

    const { rows } = await client.query(
      `INSERT INTO roles (title, department, hiring_manager_name, priority, status, location, employment_type, start_date, target_closure_date)
       VALUES ($1, 'Tech/Devs', 'Test HM', $2, 'Live – Sourcing', 'Gurgaon', 'Full-Time / Permanent', $3, $4)
       RETURNING id`,
      [`Aging Test Role ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, overrides.priority || 'P0', startDate, targetDate]
    );
    const id = rows[0].id;
    createdRoleIds.push(id);
    return id;
  }

  test('a role open 200 days but with a Close Target still in the future is NOT flagged red', async ({ request }) => {
    const roleId = await createRole({ priority: 'P0', startDaysAgo: 200, targetClosureDaysFromNow: 30 });

    const hrToken = await getToken(request, 'hr');
    const res = await authed(request, hrToken).get(`/api/roles/${roleId}`);
    expect(res.status()).toBe(200);
    const { role } = await res.json();

    expect(role.aging_alert).toBe('ok');
    expect(role.days_overdue).toBe(0);
    expect(role.days_open).toBeGreaterThanOrEqual(200);
  });

  test('a role whose Close Target has passed is flagged red, with days_overdue counted from the target date', async ({ request }) => {
    // P0's red threshold is 15 days (AGING_THRESHOLDS) — 20 days past target
    // clears it comfortably regardless of exact threshold tuning.
    const roleId = await createRole({ priority: 'P0', startDaysAgo: 200, targetClosureDaysFromNow: -20 });

    const hrToken = await getToken(request, 'hr');
    const res = await authed(request, hrToken).get(`/api/roles/${roleId}`);
    const { role } = await res.json();

    expect(role.aging_alert).toBe('red');
    expect(role.days_overdue).toBeGreaterThanOrEqual(19);
    expect(role.days_overdue).toBeLessThan(role.days_open);
  });

  test('a role with no Close Target at all falls back to the legacy days-open threshold', async ({ request }) => {
    const roleId = await createRole({ priority: 'P0', startDaysAgo: 200, targetClosureDaysFromNow: null });

    const hrToken = await getToken(request, 'hr');
    const res = await authed(request, hrToken).get(`/api/roles/${roleId}`);
    const { role } = await res.json();

    expect(role.aging_alert).toBe('red');
    expect(role.days_overdue).toBe(0); // no target to be overdue against
  });

  test('pushing Close Target into the future clears an existing red alert', async ({ request }) => {
    const roleId = await createRole({ priority: 'P0', startDaysAgo: 200, targetClosureDaysFromNow: -20 });
    const hrToken = await getToken(request, 'hr');

    const before = await authed(request, hrToken).get(`/api/roles/${roleId}`);
    expect((await before.json()).role.aging_alert).toBe('red');

    const futureDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const patchRes = await authed(request, hrToken).patch(`/api/roles/${roleId}`, { target_closure_date: futureDate });
    expect(patchRes.status()).toBe(200);

    const after = await authed(request, hrToken).get(`/api/roles/${roleId}`);
    const { role } = await after.json();
    expect(role.aging_alert).toBe('ok');
    expect(role.days_overdue).toBe(0);
  });

  test("checkRoleAging creates a Leadership 'Role aging alert' pending_action once overdue, and resolves it once no longer overdue", async ({ request }) => {
    const roleId = await createRole({ priority: 'P0', startDaysAgo: 200, targetClosureDaysFromNow: -20 });
    const hrToken = await getToken(request, 'hr');

    const cronRes = await authed(request, CRON_SECRET).post('/api/cron/sla-check', {});
    expect(cronRes.status()).toBe(200);

    const { rows: created } = await client.query(
      `SELECT id FROM pending_actions WHERE role_id = $1 AND action_type = 'Role aging alert' AND resolved = false`,
      [roleId]
    );
    expect(created.length).toBe(1);

    const futureDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    await authed(request, hrToken).patch(`/api/roles/${roleId}`, { target_closure_date: futureDate });

    const cronRes2 = await authed(request, CRON_SECRET).post('/api/cron/sla-check', {});
    expect(cronRes2.status()).toBe(200);

    const { rows: afterResolve } = await client.query(
      `SELECT id FROM pending_actions WHERE role_id = $1 AND action_type = 'Role aging alert' AND resolved = false`,
      [roleId]
    );
    expect(afterResolve.length).toBe(0);
  });
});
