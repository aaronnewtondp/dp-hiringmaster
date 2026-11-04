import { test, expect } from '@playwright/test';
import { getToken, authed, pollUntil, uid } from '../helpers/api';
import { withDb } from '../helpers/db';

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
// Tagging: the first test needs a real Anthropic key AND Google Drive (JD content, PDF upload, ResumeIQ scoring), so it is tagged @live and
// runs only with TEST_LIVE=1 (`npm run test:live`). The other two are OFFLINE tests of the same contract that work against any backend:
// they pin what must hold whether or not generation succeeds. No test depends on another, and none depends on test order or leftovers.

test.describe('JD Generation + ResumeIQ scoring', () => {

  test('@live role Approved → real JD generation, then real ResumeIQ scoring against the generated JD', async ({ request }) => {
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
    const roleId: string = createdRole.id;

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

    // 4. Create a candidate + application against THIS role. ResumeIQ scoring
    // is now triggered synchronously at CREATION time (runResumeIQScoring,
    // called inline from candidates.ts's POST /) — there's no longer a
    // separate "move to Resume Review" step to trigger it (that stage was
    // retired — see STAGE_ORDER). The creation response itself carries the
    // real {scored,error} outcome, same synchronous-response contract the
    // JD-generation step above relies on.
    const createCandRes = await api.post('/api/candidates', {
      full_name: `Test JD Gen Candidate ${uid()}`,
      email:     `test+${uid()}@example.com`,
      role_id:   roleId,
    });
    expect(createCandRes.status()).toBe(201);
    const { application, resumeiq } = await createCandRes.json();
    expect(application.role_id).toBe(roleId);
    expect(application.stage).toBe('Applied and Screened');
    expect(resumeiq).toBeTruthy();
    expect(resumeiq.scored).toBe(true);
    expect(resumeiq.error).toBeUndefined();

    // 5. Poll GET /api/applications/:id until scoring has completed
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

  // Offline: the links are set by SQL (a role that "already has its JD"), so no model or Drive is needed to prove the guard
  //   updatedRole.status === 'Approved' && existing.status !== 'Approved' && !existing.jd_drive_link && existing.jd_source !== 'manual'
  // (roles.ts PATCH /:id). The old version of this test depended on the first test's role and on a real generation.
  test('a role that already has a jd_drive_link is never regenerated: approving it, and editing it afterwards, leave the links untouched and report no jdGeneration', async ({ request }) => {
    const api = authed(request, await getToken(request, 'hr'));
    const { role } = await (await api.post('/api/roles', { title: `JD Guard Role ${uid()}`, priority: 'P3' })).json();
    const longLink = `https://drive.google.com/file/d/long-${uid()}/view`;
    const socialLink = `https://drive.google.com/file/d/social-${uid()}/view`;
    await withDb(c => c.query('UPDATE roles SET jd_drive_link = $1, social_jd_drive_link = $2 WHERE id = $3', [longLink, socialLink, role.id]));

    // The Draft -> Approved transition is exactly when generation fires — except when a link already exists.
    const approve = await api.patch(`/api/roles/${role.id}`, { status: 'Approved' });
    expect(approve.status()).toBe(200);
    const approved = await approve.json();
    expect(approved.role.status).toBe('Approved');
    expect(approved.jdGeneration).toBeUndefined();
    expect(approved.role.jd_drive_link).toBe(longLink);
    expect(approved.role.social_jd_drive_link).toBe(socialLink);

    // An unrelated edit of the now-Approved role: still no generation, links unchanged.
    const edit = await api.patch(`/api/roles/${role.id}`, { additional_remarks: `No-regen check ${uid()}` });
    expect(edit.status()).toBe(200);
    const edited = await edit.json();
    expect(edited.jdGeneration).toBeUndefined();
    expect(edited.role.jd_drive_link).toBe(longLink);
    expect(edited.role.social_jd_drive_link).toBe(socialLink);

    // Leaving and re-entering Approved does not regenerate either: the guard is the link, not the first transition.
    await api.patch(`/api/roles/${role.id}`, { status: 'On Hold' });
    const again = await (await api.patch(`/api/roles/${role.id}`, { status: 'Approved' })).json();
    expect(again.jdGeneration).toBeUndefined();
    expect(again.role.jd_drive_link).toBe(longLink);
  });

  // Offline contract of the "await it inline, return { success, error }" rule (CLAUDE.md, no fire-and-forget on Vercel). Whether generation
  // succeeds depends on the backend's credentials, so this asserts what must hold in BOTH outcomes, and checks the retry promise of the
  // failure message ("will retry automatically the next time this role is approved") whenever the first attempt did fail.
  test('approving never depends on JD generation: 200, status Approved, and a jdGeneration outcome that agrees with the stored links; a failed one is retried on the next approval', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const api = authed(request, hrToken);
    const { role } = await (await api.post('/api/roles', { title: `JD Contract Role ${uid()}`, priority: 'P3' })).json();

    const res = await api.patch(`/api/roles/${role.id}`, { status: 'Approved' });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.role.status).toBe('Approved');
    expect(body.role.approver_name).toBeTruthy();                       // approval metadata is written by the same request
    expect(body.role.approval_date).toBeTruthy();
    expect(body.jdGeneration, 'generation is awaited inline: its outcome is part of the PATCH response').toBeTruthy();
    expect(typeof body.jdGeneration.generated).toBe('boolean');

    const stored = (await (await api.get(`/api/roles/${role.id}`)).json()).role;
    if (body.jdGeneration.generated) {
      expect(body.jdGeneration.error).toBeUndefined();
      expect(stored.jd_drive_link).toMatch(/^https:\/\//);
      expect(stored.social_jd_drive_link).toMatch(/^https:\/\//);
      expect(stored.generated_jd_content).toBeTruthy();
      return;
    }
    // A failed generation: a stable message, nothing half-written, and the role is still approvable again.
    expect(typeof body.jdGeneration.error).toBe('string');
    expect(body.jdGeneration.error.length).toBeGreaterThan(0);
    expect(stored.jd_drive_link).toBeNull();
    expect(stored.social_jd_drive_link).toBeNull();
    expect(stored.generated_jd_content).toBeNull();
    const events = (await (await api.get(`/api/roles/${role.id}/activity`)).json()).activity.map((a: { event_type: string }) => a.event_type);
    expect(events).not.toContain('JD Generated');

    await api.patch(`/api/roles/${role.id}`, { status: 'On Hold' });
    const retry = await (await api.patch(`/api/roles/${role.id}`, { status: 'Approved' })).json();
    expect(retry.jdGeneration, 'the next transition into Approved retries the generation').toBeTruthy();
  });
});
