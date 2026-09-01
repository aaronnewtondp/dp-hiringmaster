// ─────────────────────────────────────────────────────────────────────────────
// Dashboard audit fixes (2026-08-24) — regression coverage for the bugs found
// while investigating a user report that already-Rejected candidates
// (Sanjana Nandkishor Jawanjal, Mohammad Affan, Hardik Singh) were still
// showing up as SLA breaches in Pending Actions, plus a full audit of every
// dashboard metric that followed from it.
//
// Root cause of the reported bug: runSlaCheck() is throttled to once per 3
// minutes per serverless instance (dashboard.ts's maybeRunSlaCheck) and
// checkApplicationSLAs() does an initial SELECT ... WHERE status='Active'
// into memory, then loops with several sequential awaited queries per row —
// during that loop a concurrent status-change request (HR rejecting the
// same candidate) could land in the gap between the SELECT and this row's
// turn, creating a pending_actions row for an application already rejected
// moments earlier, with nothing left to ever resolve it.
//
// Uses a direct Postgres connection (same precedent as
// 01-talent-pool-archival.spec.ts) to backdate stage_entry_time, simulate
// the exact race by inserting an orphaned pending_actions row directly, and
// to force joining_risk_auto_flag=true without waiting out the real 5-day
// window. POST /api/cron/sla-check (CRON_SECRET-gated) is used to run
// runSlaCheck() on demand instead of waiting on its 3-minute dashboard-load
// throttle.
//
// INTENTIONALLY LOCAL-ONLY: hardcoded local-dev credentials, deliberately
// excluded from test:prod.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed, createCandidateWithApp, CRON_SECRET } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';

test.describe('Dashboard audit fixes — SLA race, orphan sweep, funnel shape, status write-paths', () => {
  let client: Client;

  test.beforeAll(async () => {
    client = new Client({ connectionString: LOCAL_DB_URL });
    await client.connect();
  });

  test.afterAll(async () => {
    await client.end();
  });

  async function runCronSlaCheck(request: Parameters<typeof authed>[0]) {
    const res = await authed(request, CRON_SECRET).post('/api/cron/sla-check', {});
    expect(res.status()).toBe(200);
  }

  test('a candidate rejected after going overdue never gets sla_breach flipped or a new pending_action (atomic re-check)', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const api = authed(request, hrToken);
    const { application } = await createCandidateWithApp(request, hrToken);

    // Already sitting at 'Applied' from creation ('Resume Review' was
    // retired as a stage — see STAGE_ORDER) — 'Applied' carries the same
    // 48h SLA that stage used to (see getSlaHours in applications.ts). Push
    // stage_entry_time back past that threshold.
    await client.query(
      `UPDATE applications SET stage_entry_time = NOW() - INTERVAL '60 hours' WHERE id = $1`,
      [application.id]
    );

    const statusRes = await api.post(`/api/applications/${application.id}/status`, {
      new_status: 'Rejected', rejection_reason_cat: 'Missing mandatory skill',
    });
    expect(statusRes.status()).toBe(200);

    await runCronSlaCheck(request);

    const { rows } = await client.query(
      `SELECT sla_breach, status FROM applications WHERE id = $1`, [application.id]
    );
    expect(rows[0].status).toBe('Rejected');
    expect(rows[0].sla_breach).toBe(false);

    const pending = await client.query(
      `SELECT id FROM pending_actions WHERE application_id = $1 AND resolved = false`,
      [application.id]
    );
    expect(pending.rows.length).toBe(0);
  });

  test('resolveOrphanedActions sweeps a pending_action left dangling on a non-Active application', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const api = authed(request, hrToken);
    const { application } = await createCandidateWithApp(request, hrToken);

    const statusRes = await api.post(`/api/applications/${application.id}/status`, {
      new_status: 'Rejected', rejection_reason_cat: 'Missing mandatory skill',
    });
    expect(statusRes.status()).toBe(200);

    // Simulate an orphan slipping in through some other path (or predating
    // this fix entirely) — a real unresolved row pointing at an application
    // that is no longer Active.
    const inserted = await client.query(
      `INSERT INTO pending_actions (owner_type, priority_level, action_type, description, application_id, candidate_name, role_title, hours_overdue)
       VALUES ('HR / Recruiter','High','Resume to triage','Manually-simulated orphan for regression test',$1,'Test','Test',10)
       RETURNING id`,
      [application.id]
    );
    const orphanId = inserted.rows[0].id;

    await runCronSlaCheck(request);

    const { rows } = await client.query(`SELECT resolved FROM pending_actions WHERE id = $1`, [orphanId]);
    expect(rows[0].resolved).toBe(true);
  });

  test('checkJoiningRisk successfully creates a pending_action for a fresh Offer Accepted / no-contact application', async ({ request }) => {
    // Regression for a real, previously-undiscovered bug found while writing
    // this file: the INSERT below used to pass an extra, never-referenced
    // $2 placeholder (a stray leftover `null` in the params array) that the
    // query text never actually used anywhere — Postgres throws 42P18
    // ("could not determine data type of parameter $2") the instant that
    // happens, on every single call. Since last_hr_contact is NULL by
    // default on every freshly-created application, this fired for
    // effectively every real at-risk candidate and was swallowed one layer
    // up by maybeRunSlaCheck's catch-and-log — runSlaCheck() never surfaced
    // an error to any caller, so this had silently never worked in
    // production despite joining_risk_auto_flag itself (a separate
    // statement, unaffected) correctly flipping true.
    const hrToken = await getToken(request, 'hr');
    const api = authed(request, hrToken);
    const { application } = await createCandidateWithApp(request, hrToken, 'R006');

    const stageRes = await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Offer Accepted' });
    expect(stageRes.status()).toBe(200);

    await runCronSlaCheck(request); // must not 500 — this is exactly what used to throw

    const { rows: appRows } = await client.query(
      `SELECT joining_risk_auto_flag FROM applications WHERE id = $1`, [application.id]
    );
    expect(appRows[0].joining_risk_auto_flag).toBe(true);

    const { rows: actionRows } = await client.query(
      `SELECT id FROM pending_actions WHERE application_id = $1 AND action_type = 'Joining risk — no contact' AND resolved = false`,
      [application.id]
    );
    expect(actionRows.length).toBe(1);
  });

  test('hiring_funnel includes a stage even when every occupant has since been rejected, with the rejection counted', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const api = authed(request, hrToken);
    const { application } = await createCandidateWithApp(request, hrToken, 'R006');

    const stageRes = await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 2' });
    expect(stageRes.status()).toBe(200);
    const statusRes = await api.post(`/api/applications/${application.id}/status`, {
      new_status: 'Rejected', rejection_reason_cat: 'Failed interview',
    });
    expect(statusRes.status()).toBe(200);

    const dashRes = await api.get('/api/dashboard?role_id=R006');
    expect(dashRes.status()).toBe(200);
    const { hiring_funnel } = await dashRes.json();

    // All 11 canonical stages always present, dense — this is the actual
    // fix: the funnel used to filter to status='Active' only, so a stage
    // with zero currently-active occupants (everyone since rejected/
    // withdrawn/on hold) vanished from the array entirely instead of
    // showing up with active:0 and the real rejected count.
    expect(hiring_funnel.length).toBe(11);
    const entry = hiring_funnel.find((f: { stage: string }) => f.stage === 'Interview Round 2');
    expect(entry).toBeTruthy();
    expect(entry.rejected).toBeGreaterThanOrEqual(1);
  });

  test('advancing an application to Joined sets status to Joined (excludes it from active_candidates going forward)', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const api = authed(request, hrToken);
    const { application } = await createCandidateWithApp(request, hrToken);

    const stageRes = await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Joined' });
    expect(stageRes.status()).toBe(200);

    const getRes = await api.get(`/api/applications/${application.id}`);
    const { application: fetched } = await getRes.json();
    expect(fetched.stage).toBe('Joined');
    expect(fetched.status).toBe('Joined');
  });

  test('an empty-string source_channel is normalized to null on write (an application-level field, separate from source_quality)', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const api = authed(request, hrToken);
    const createRes = await api.post('/api/candidates', {
      full_name: 'Empty Source Test Candidate',
      email: `emptysource+${Date.now()}@example.com`,
      role_id: 'R006',
      source_channel: '',
    });
    expect(createRes.status()).toBe(201);
    const { application } = await createRes.json();

    const getRes = await api.get(`/api/applications/${application.id}`);
    const { application: fetched } = await getRes.json();
    expect(fetched.source_channel).toBeNull();
  });

  // source_quality is grouped by candidates.source (the unified, currently-
  // collected Naukri/IIMjobs · LinkedIn · Internal Referral · Agency ·
  // Direct Outreach vocabulary), not applications.source_channel, which was
  // retired as a collected field on 2026-08-24 (commit 2092a54) — see the
  // matching comment in dashboard.ts's Source Quality query.
  test('an empty-string candidate source is normalized to null on write and excluded from source_quality', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const api = authed(request, hrToken);
    const createRes = await api.post('/api/candidates', {
      full_name: 'Empty Source Test Candidate',
      email: `emptysource+${Date.now()}@example.com`,
      role_id: 'R006',
      source: '',
    });
    expect(createRes.status()).toBe(201);
    const { candidate } = await createRes.json();
    expect(candidate.source).toBeNull();

    const dashRes = await api.get('/api/dashboard');
    const { source_quality } = await dashRes.json();
    const emptyEntry = source_quality.find((s: { source_channel: string }) => s.source_channel === '');
    expect(emptyEntry).toBeUndefined();
  });

  test('joining_risk excludes an Offer Accepted application once its status leaves Active', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const api = authed(request, hrToken);
    const { application } = await createCandidateWithApp(request, hrToken, 'R006');

    const stageRes = await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Offer Accepted' });
    expect(stageRes.status()).toBe(200);

    // Force the at-risk flag directly rather than waiting out the real
    // 5-day no-contact window.
    await client.query(`UPDATE applications SET joining_risk_auto_flag = true WHERE id = $1`, [application.id]);

    const statusRes = await api.post(`/api/applications/${application.id}/status`, {
      new_status: 'Withdrawn', withdrawal_reason_cat: 'Personal reasons',
    });
    expect(statusRes.status()).toBe(200);

    const dashRes = await api.get('/api/dashboard?role_id=R006');
    const { joining_risk } = await dashRes.json();
    const found = joining_risk.find((j: { id: string }) => j.id === application.id);
    expect(found).toBeUndefined();

    // The status-change route itself should have reset the flag too (see
    // next two tests for the dedicated reset-path coverage) — checked here
    // as a secondary confirmation, not the primary assertion.
    const { rows } = await client.query(`SELECT joining_risk_auto_flag FROM applications WHERE id = $1`, [application.id]);
    expect(rows[0].joining_risk_auto_flag).toBe(false);
  });

  test('joining_risk_auto_flag resets to false when fresh HR contact is logged via notes', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const api = authed(request, hrToken);
    const { application } = await createCandidateWithApp(request, hrToken, 'R006');

    await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Offer Accepted' });
    await client.query(`UPDATE applications SET joining_risk_auto_flag = true WHERE id = $1`, [application.id]);

    const notesRes = await api.patch(`/api/applications/${application.id}/notes`, {
      last_hr_contact: new Date().toISOString(),
    });
    expect(notesRes.status()).toBe(200);

    const { rows } = await client.query(`SELECT joining_risk_auto_flag FROM applications WHERE id = $1`, [application.id]);
    expect(rows[0].joining_risk_auto_flag).toBe(false);
  });

  test('joining_risk_auto_flag resets to false when status moves away from Active (Rejected)', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const api = authed(request, hrToken);
    const { application } = await createCandidateWithApp(request, hrToken, 'R006');

    await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Offer Accepted' });
    await client.query(`UPDATE applications SET joining_risk_auto_flag = true WHERE id = $1`, [application.id]);

    const statusRes = await api.post(`/api/applications/${application.id}/status`, {
      new_status: 'Rejected', rejection_reason_cat: 'Offer declined',
    });
    expect(statusRes.status()).toBe(200);

    const { rows } = await client.query(`SELECT joining_risk_auto_flag FROM applications WHERE id = $1`, [application.id]);
    expect(rows[0].joining_risk_auto_flag).toBe(false);
  });
});
