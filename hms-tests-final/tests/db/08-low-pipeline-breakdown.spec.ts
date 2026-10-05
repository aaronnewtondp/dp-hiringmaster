// ─────────────────────────────────────────────────────────────────────────────
// Low Pipeline Roles — membership rule + the per-role pipeline breakdown.
//
// RULE (2026-10-05): an OPEN role is low-pipeline when it has
//     fewer than 3 shortlisted candidates   AND   fewer than 8 Active candidates.
// (Before: "fewer than 3 shortlisted AND scored above 60" — the score condition
// was dropped; the scored figures are still reported and shown, for information.)
//
// Each listed role carries the funnel behind it (all over status='Active'):
//   active_count             the pipeline
//   scored_above_60_count    ...with a ResumeIQ fit score > 60   (exactly 60 does not count)
//   shortlisted_count        ...past Applied and Screened
//   shortlisted_scored_count ...shortlisted AND scored > 60
// Needs fit scores / stages set directly (no API sets a score), so it talks to
// Postgres. INTENTIONALLY LOCAL-ONLY, like the other tests/db specs.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';

type Row = { active_count: number; scored_above_60_count: number; shortlisted_count: number; shortlisted_scored_count: number };

test.describe('Low Pipeline Roles — rule and breakdown counts', () => {
  let client: Client;
  const roleIds: string[] = [];
  const candidateIds: string[] = [];

  test.beforeAll(async () => { client = new Client({ connectionString: LOCAL_DB_URL }); await client.connect(); });
  test.afterAll(async () => {
    // pending_actions.application_id has no index, so each deleted application's ON DELETE
    // CASCADE scans the whole (multi-million-row, locally) table once: ~100 applications here
    // is well over the 30s default.
    test.setTimeout(180_000);
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

  async function addApp(roleId: string, o: { stage?: string; status?: string; fit?: number | null } = {}) {
    const { rows: c } = await client.query(
      `INSERT INTO candidates (full_name, email) VALUES ($1, $2) RETURNING id`,
      [`Breakdown Candidate ${Math.random().toString(36).slice(2, 8)}`, `breakdown+${Date.now()}${Math.random().toString(36).slice(2, 8)}@example.com`]);
    candidateIds.push(c[0].id);
    await client.query(
      `INSERT INTO applications (candidate_id, role_id, stage, status, ai_fit_score) VALUES ($1,$2,$3,$4,$5)`,
      [c[0].id, roleId, o.stage ?? 'Applied and Screened', o.status ?? 'Active', o.fit ?? null]);
  }
  async function addMany(roleId: string, n: number, o: Parameters<typeof addApp>[1] = {}) {
    for (let i = 0; i < n; i++) await addApp(roleId, o);
  }

  async function lowPipelineRow(request: Parameters<typeof authed>[0], roleId: string) {
    const api = authed(request, await getToken(request, 'hr'));
    const body = await (await api.get(`/api/dashboard?role_id=${roleId}`)).json();
    return (body.low_pipeline as Array<Record<string, unknown>>).find(r => r.id === roleId);
  }

  test.describe('the counts', () => {
    test('count each step of the funnel separately, and they nest', async ({ request }) => {
      const roleId = await newRole();
      // 7 Active candidates:
      await addApp(roleId, { fit: 85 });                                   // pipeline, >60
      await addApp(roleId, { fit: 61 });                                   // pipeline, >60 (just over)
      await addApp(roleId, { fit: 60 });                                   // pipeline, NOT >60 (60 is not above 60)
      await addApp(roleId, { fit: 30 });                                   // pipeline
      await addApp(roleId, { fit: null });                                 // pipeline, unscored
      await addApp(roleId, { stage: 'Interview Round 1', fit: 90 });       // shortlisted, >60
      await addApp(roleId, { stage: 'Interview Round 2', fit: 35 });       // shortlisted, NOT >60  (so shortlisted != scored_above_60)
      // ...and ones that must NOT count anywhere:
      await addApp(roleId, { status: 'Rejected', fit: 95 });
      await addApp(roleId, { status: 'Hold for Future', stage: 'Interview Round 1', fit: 95 });
      await addApp(roleId, { status: 'Withdrawn', stage: 'Interview Round 2', fit: 95 });

      const row = await lowPipelineRow(request, roleId) as unknown as Row;
      expect(row, '7 active / 2 shortlisted is low-pipeline').toBeTruthy();
      expect(row).toMatchObject({
        active_count: 7,
        scored_above_60_count: 3,       // 85, 61, 90
        shortlisted_count: 2,           // Interview Round 1 + Interview Round 2
        shortlisted_scored_count: 1,    // only the 90 at Interview Round 1
      });
      expect(row.shortlisted_scored_count).toBeLessThanOrEqual(row.shortlisted_count);
      expect(row.shortlisted_scored_count).toBeLessThanOrEqual(row.scored_above_60_count);
      expect(row.shortlisted_count).toBeLessThanOrEqual(row.active_count);
      expect(row.scored_above_60_count).toBeLessThanOrEqual(row.active_count);
    });

    test('an empty pipeline is listed, reading 0 / 0 / 0 / 0 (not missing)', async ({ request }) => {
      const roleId = await newRole();
      expect(await lowPipelineRow(request, roleId)).toMatchObject({ active_count: 0, scored_above_60_count: 0, shortlisted_count: 0, shortlisted_scored_count: 0 });
    });
  });

  test.describe('the rule: fewer than 3 shortlisted AND fewer than 8 active', () => {
    test('7 active and 2 shortlisted: listed', async ({ request }) => {
      const roleId = await newRole();
      await addMany(roleId, 5);
      await addMany(roleId, 2, { stage: 'Interview Round 1' });
      expect(await lowPipelineRow(request, roleId)).toMatchObject({ active_count: 7, shortlisted_count: 2 });
    });

    test('exactly 8 active is NOT low ("fewer than 8"), even with nobody shortlisted', async ({ request }) => {
      const roleId = await newRole();
      await addMany(roleId, 8);
      expect(await lowPipelineRow(request, roleId)).toBeUndefined();
    });

    test('7 active is still low — one under the cap', async ({ request }) => {
      const roleId = await newRole();
      await addMany(roleId, 7);
      expect(await lowPipelineRow(request, roleId)).toMatchObject({ active_count: 7, shortlisted_count: 0 });
    });

    test('exactly 3 shortlisted is NOT low ("fewer than 3"), even in a small pipeline', async ({ request }) => {
      const roleId = await newRole();
      await addMany(roleId, 3, { stage: 'Interview Round 1' });
      expect(await lowPipelineRow(request, roleId)).toBeUndefined();
    });

    test('2 shortlisted is still low — one under the line', async ({ request }) => {
      const roleId = await newRole();
      await addMany(roleId, 2, { stage: 'Interview Round 1' });
      expect(await lowPipelineRow(request, roleId)).toMatchObject({ shortlisted_count: 2 });
    });

    test('a big pool of applicants nobody has shortlisted yet is NOT low — that is a process problem, not thin sourcing', async ({ request }) => {
      const roleId = await newRole();
      await addMany(roleId, 30);
      expect(await lowPipelineRow(request, roleId)).toBeUndefined();
    });

    test('scores no longer matter: 3 shortlisted who all scored badly is NOT low (the old rule would have listed it)', async ({ request }) => {
      const roleId = await newRole();
      await addMany(roleId, 3, { stage: 'Interview Round 1', fit: 20 });
      expect(await lowPipelineRow(request, roleId)).toBeUndefined();     // shortlisted_scored_count is 0 here — old rule: listed
    });

    test('...and 2 shortlisted who all scored well is still low (the old rule listed it too)', async ({ request }) => {
      const roleId = await newRole();
      await addMany(roleId, 2, { stage: 'Interview Round 1', fit: 88 });
      expect(await lowPipelineRow(request, roleId)).toMatchObject({ shortlisted_count: 2, shortlisted_scored_count: 2 });
    });

    test('only Active candidates count toward either number', async ({ request }) => {
      const roleId = await newRole();
      await addMany(roleId, 4, { status: 'Rejected' });
      await addMany(roleId, 4, { status: 'Hold for Future', stage: 'Interview Round 1' });
      await addMany(roleId, 2);
      expect(await lowPipelineRow(request, roleId)).toMatchObject({ active_count: 2, shortlisted_count: 0 });
    });

    test('closed roles are never listed', async ({ request }) => {
      const roleId = await newRole('Closed – Filled');
      await addApp(roleId, { fit: 80 });
      expect(await lowPipelineRow(request, roleId)).toBeUndefined();
    });

    test('every entry the dashboard returns satisfies the rule', async ({ request }) => {
      const body = await (await authed(request, await getToken(request, 'hr')).get('/api/dashboard')).json();
      for (const r of body.low_pipeline as Row[]) {
        expect(r.shortlisted_count).toBeLessThan(3);
        expect(r.active_count).toBeLessThan(8);
      }
    });
  });
});
