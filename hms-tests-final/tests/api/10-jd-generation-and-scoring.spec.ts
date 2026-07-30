import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidateWithApp, pollUntil, uid } from '../helpers/api';

// ─── JD Generation + ResumeIQ scoring — REAL external calls ───────────────────
// Unlike every other spec file in this suite, this file is explicitly allowed
// to trigger paid, real external calls: Claude API (JD content + resume
// scoring), PDF rendering, and a real Google Drive upload. Kept to a SMALL
// number of test cases on purpose — this is expensive/slow, not a place for
// exhaustive edge-case coverage.
//
// Both triggers (JD generation on roles.ts PATCH /:id, ResumeIQ scoring on
// applications.ts POST /:id/stage) are SYNCHRONOUS — awaited inline before
// the response is sent, per CLAUDE.md's "no fire-and-forget on Vercel" rule
// (a prior setImmediate version silently broke JD generation in production
// for weeks). Each triggering response carries a {success,error}-shaped
// field (jdGeneration / resumeiq) asserted on directly below — polling
// afterward would still pass even if that contract regressed back to
// fire-and-forget, so the polling here is belt-and-suspenders state
// confirmation, not the actual regression guard.
//
// The second test depends on state (roleId, jd_drive_link) created by the
// first — safe because playwright.config.ts runs this suite with
// fullyParallel: false / workers: 1, so tests within a file execute serially,
// in order.

let roleId: string;

test.describe('JD Generation + ResumeIQ scoring (real external calls)', () => {

  test('role Approved → real JD generation, then real ResumeIQ scoring against the generated JD', async ({ request }) => {
    // Real Claude call + PDF render + Drive upload, then a second real Claude
    // call for scoring — give this plenty of room beyond Playwright's default.
    test.setTimeout(180_000);

    const token = await getToken(request, 'hr');
    const api   = authed(request, token);

    // 1. Create a fresh role as HR — P3 so it doesn't skew dashboard aging expectations
    const createRes = await api.post('/api/roles', {
      title:    `Test JD Gen Role ${uid()}`,
      priority: 'P3',
    });
    expect(createRes.status()).toBe(201);
    const { role: createdRole } = await createRes.json();
    expect(createdRole.status).toBe('Draft');
    roleId = createdRole.id;

    // 2. PATCH it to Approved — this is the trigger site in roles.ts (fires
    // when status transitions into 'Approved' from anything else, guarded by
    // !existing.jd_drive_link). Generation is awaited inline, so the PATCH
    // response itself already carries the {generated,error} outcome — this
    // is the actual regression guard against fire-and-forget silently
    // returning (see file header).
    const approveRes = await api.patch(`/api/roles/${roleId}`, { status: 'Approved' });
    expect(approveRes.status()).toBe(200);
    const { role: approvedRole, jdGeneration } = await approveRes.json();
    expect(approvedRole.status).toBe('Approved');
    expect(jdGeneration).toBeTruthy();
    expect(jdGeneration.generated).toBe(true);
    expect(jdGeneration.error).toBeUndefined();
    // The synchronous response already has the real links — no polling
    // required to observe them, unlike the pre-fix behavior.
    expect(approvedRole.jd_drive_link).toMatch(/^https:\/\//);
    expect(approvedRole.social_jd_drive_link).toMatch(/^https:\/\//);

    // 3. Poll GET /api/roles/:id until JD generation has completed
    const roleWithJd = await pollUntil(
      async () => {
        const r = await api.get(`/api/roles/${roleId}`);
        const body = await r.json();
        return body.role;
      },
      (r) => !!r.jd_drive_link && !!r.generated_jd_content,
      { timeoutMs: 90_000, intervalMs: 3_000 }
    );

    expect(roleWithJd.jd_drive_link).toMatch(/^https:\/\//);
    expect(roleWithJd.social_jd_drive_link).toMatch(/^https:\/\//);
    expect(roleWithJd.generated_jd_content).toBeTruthy();
    expect(typeof roleWithJd.generated_jd_content).toBe('object');

    // 4. Create a candidate + application against THIS role
    const { application } = await createCandidateWithApp(request, token, roleId);
    expect(application.role_id).toBe(roleId);

    // 5. Advance to Resume Review — the real ResumeIQ trigger point in
    // applications.ts (guarded by !app.score_avg), also synchronous — the
    // stage-change response itself carries the {scored,error} outcome.
    const stageRes = await api.post(`/api/applications/${application.id}/stage`, {
      new_stage: 'Resume Review',
    });
    expect(stageRes.status()).toBe(200);
    const { resumeiq } = await stageRes.json();
    expect(resumeiq).toBeTruthy();
    expect(resumeiq.scored).toBe(true);
    expect(resumeiq.error).toBeUndefined();

    // 6. Poll GET /api/applications/:id until scoring has completed
    const scoredApp = await pollUntil(
      async () => {
        const r = await api.get(`/api/applications/${application.id}`);
        const body = await r.json();
        return body.application;
      },
      (a) => a.score_avg !== null && a.score_avg !== undefined,
      { timeoutMs: 60_000, intervalMs: 3_000 }
    );

    const scoreAvg = Number(scoredApp.score_avg);
    expect(scoreAvg).toBeGreaterThanOrEqual(0);
    expect(scoreAvg).toBeLessThanOrEqual(10);
    expect(['Strong Yes', 'Yes', 'Maybe', 'No']).toContain(scoredApp.score_recommendation);
  });

  test('re-approving an already-Approved role with jd_drive_link set does NOT regenerate the JD', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);

    const before = await (await api.get(`/api/roles/${roleId}`)).json();
    expect(before.role.status).toBe('Approved');
    expect(before.role.jd_drive_link).toBeTruthy();

    // Unrelated field change on a role that's already Approved with a
    // jd_drive_link already set — the guard is
    // `updatedRole.status === 'Approved' && existing.status !== 'Approved' && !existing.jd_drive_link`,
    // so this must be a no-op for JD generation. Synchronous check, no
    // polling needed — if the guard failed, generation would race here, but
    // jd_drive_link would still read as unchanged the instant the PATCH returns.
    const patchRes = await api.patch(`/api/roles/${roleId}`, {
      additional_remarks: `No-regen check ${uid()}`,
    });
    expect(patchRes.status()).toBe(200);
    const { role: afterRole } = await patchRes.json();

    expect(afterRole.status).toBe('Approved');
    expect(afterRole.jd_drive_link).toBe(before.role.jd_drive_link);
    expect(afterRole.social_jd_drive_link).toBe(before.role.social_jd_drive_link);
  });
});
