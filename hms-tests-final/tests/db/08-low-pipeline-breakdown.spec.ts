// ─────────────────────────────────────────────────────────────────────────────
// Low Pipeline Roles — the per-role pipeline breakdown (2026-10-01).
// dashboard.ts's low_pipeline entries now carry the whole funnel for the role,
// not just the one number the "low" threshold is judged on:
//   active_count             every Active candidate (the pipeline)
//   scored_above_60_count    ...with a ResumeIQ fit score > 60
//   shortlisted_count        ...past Applied and Screened
//   shortlisted_scored_count ...shortlisted AND scored > 60  (< 3 puts the role on the list)
// Needs fit scores / stages set directly (no API sets a score), so it talks to
// Postgres. INTENTIONALLY LOCAL-ONLY, like the other tests/db specs.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';

test.describe('Low Pipeline Roles — pipeline breakdown counts', () => {
  let client: Client;
  const roleIds: string[] = [];
  const candidateIds: string[] = [];

  test.beforeAll(async () => { client = new Client({ connectionString: LOCAL_DB_URL }); await client.connect(); });
  test.afterAll(async () => {
    if (roleIds.length) {
      await client.query(`DELETE FROM activity_log WHERE role_id = ANY($1)`, [roleIds]);
      await client.query(`DELETE FROM applications WHERE role_id = ANY($1)`, [roleIds]);
      await client.query(`DELETE FROM pending_actions WHERE role_id = ANY($1)`, [roleIds]);
      await client.query(`DELETE FROM roles WHERE id = ANY($1)`, [roleIds]);
    }
    if (candidateIds.length) await client.query(`DELETE FROM candidates WHERE id = ANY($1)`, [candidateIds]);
    await client.end();
  });

  async function newRole(status = 'Live – Sourcing') {
    const { rows } = await client.query(
      `INSERT INTO roles (title, department, hiring_manager_name, priority, status, location, employment_type, start_date)
       VALUES ($1, 'Tech/Devs', 'Test HM', 'P1', $2, 'Gurgaon', 'Full-Time / Permanent', CURRENT_DATE - 10) RETURNING id`,
      [`Pipeline Breakdown Role ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, status]);
    roleIds.push(rows[0].id);
    return rows[0].id as string;
  }

  async function addApp(roleId: string, o: { stage?: string; status?: string; fit: number | null }) {
    const { rows: c } = await client.query(
      `INSERT INTO candidates (full_name, email) VALUES ($1, $2) RETURNING id`,
      [`Breakdown Candidate ${Math.random().toString(36).slice(2, 8)}`, `breakdown+${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`]);
    candidateIds.push(c[0].id);
    await client.query(
      `INSERT INTO applications (candidate_id, role_id, stage, status, ai_fit_score) VALUES ($1,$2,$3,$4,$5)`,
      [c[0].id, roleId, o.stage ?? 'Applied and Screened', o.status ?? 'Active', o.fit]);
  }

  async function lowPipelineRow(request: Parameters<typeof authed>[0], roleId: string) {
    const api = authed(request, await getToken(request, 'hr'));
    const body = await (await api.get(`/api/dashboard?role_id=${roleId}`)).json();
    return (body.low_pipeline as Array<Record<string, unknown>>).find(r => r.id === roleId);
  }

  test('counts each step of the funnel separately, and they nest', async ({ request }) => {
    const roleId = await newRole();
    // 9 Active candidates:
    await addApp(roleId, { fit: 85 });                                   // pipeline, >60
    await addApp(roleId, { fit: 61 });                                   // pipeline, >60 (just over)
    await addApp(roleId, { fit: 60 });                                   // pipeline, NOT >60 (60 is not above 60)
    await addApp(roleId, { fit: 30 });                                   // pipeline
    await addApp(roleId, { fit: null });                                 // pipeline, unscored
    await addApp(roleId, { stage: 'Interview Round 1', fit: 90 });       // shortlisted, >60
    await addApp(roleId, { stage: 'Interview Round 1', fit: 40 });       // shortlisted, NOT >60
    await addApp(roleId, { stage: 'Founders Round', fit: null });        // shortlisted, unscored
    await addApp(roleId, { stage: 'Interview Round 2', fit: 35 });       // shortlisted, NOT >60  (makes shortlisted != scored_above_60)
    // ...and ones that must NOT count anywhere:
    await addApp(roleId, { status: 'Rejected', fit: 95 });
    await addApp(roleId, { status: 'Hold for Future', stage: 'Interview Round 1', fit: 95 });
    await addApp(roleId, { status: 'Withdrawn', stage: 'Interview Round 2', fit: 95 });

    const row = await lowPipelineRow(request, roleId);
    expect(row, 'a role with fewer than 3 shortlisted >60 appears in low_pipeline').toBeTruthy();
    expect(row).toMatchObject({
      active_count: 9,
      scored_above_60_count: 3,       // 85, 61, 90
      shortlisted_count: 4,           // two Interview Round 1 + Interview Round 2 + Founders Round
      shortlisted_scored_count: 1,    // only the 90 at Interview Round 1
    });
    const r = row as { active_count: number; scored_above_60_count: number; shortlisted_count: number; shortlisted_scored_count: number };
    expect(r.shortlisted_scored_count).toBeLessThanOrEqual(r.shortlisted_count);
    expect(r.shortlisted_scored_count).toBeLessThanOrEqual(r.scored_above_60_count);
    expect(r.shortlisted_count).toBeLessThanOrEqual(r.active_count);
    expect(r.scored_above_60_count).toBeLessThanOrEqual(r.active_count);
  });

  test('an empty pipeline reads 0 / 0 / 0 / 0 (not missing)', async ({ request }) => {
    const roleId = await newRole();
    expect(await lowPipelineRow(request, roleId)).toMatchObject({ active_count: 0, scored_above_60_count: 0, shortlisted_count: 0, shortlisted_scored_count: 0 });
  });

  test('a role with 3+ shortlisted candidates scored above 60 is NOT low-pipeline, whatever the rest of its pipeline looks like', async ({ request }) => {
    const roleId = await newRole();
    for (let i = 0; i < 3; i++) await addApp(roleId, { stage: 'Interview Round 1', fit: 70 + i });
    for (let i = 0; i < 10; i++) await addApp(roleId, { fit: 20 });
    expect(await lowPipelineRow(request, roleId)).toBeUndefined();
  });

  test('exactly 2 qualifying candidates is still low-pipeline (the threshold is "fewer than 3")', async ({ request }) => {
    const roleId = await newRole();
    for (let i = 0; i < 2; i++) await addApp(roleId, { stage: 'Interview Round 2', fit: 75 });
    await addApp(roleId, { fit: 88 });                                   // scored >60 but not shortlisted: widens scored_above_60 past shortlisted
    expect(await lowPipelineRow(request, roleId)).toMatchObject({ shortlisted_scored_count: 2, shortlisted_count: 2, scored_above_60_count: 3, active_count: 3 });
  });

  test('closed roles are not listed at all', async ({ request }) => {
    const roleId = await newRole('Closed – Filled');
    await addApp(roleId, { fit: 80 });
    expect(await lowPipelineRow(request, roleId)).toBeUndefined();
  });
});
