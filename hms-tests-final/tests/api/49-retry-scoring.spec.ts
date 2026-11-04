// ─────────────────────────────────────────────────────────────────────────────
// POST /api/applications/:id/retry-scoring (applications.ts, services/resumeIQTrigger.ts runResumeIQScoring).
// The safety net for an application that was left unscored (the model call failed or was cut off at creation) and the engine behind the
// bulk "Retry scoring" button. HR-tier only, idempotent: an application that already has score_avg is answered { scored: true } without
// another model call.
//
// What runs without a model key (the isolated stack has none): everything except a successful score. A scoring attempt that cannot reach
// the model answers { scored: false, error } and writes NOTHING. The test that needs that premise checks it from the application's own
// creation response and skips when the backend actually can score. What needs a key and Drive (the profile-fields-only fallback for a
// resume that cannot be read) is tagged @live.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { authed, createCandidate, getToken, uid } from '../helpers/api';
import { HR_TIER_USERS, activityOf, applicationRow, newApplicationAt, rawStatus, retireTrackedApplications, trackApplication } from '../helpers/api-specs';
import { withDb } from '../helpers/db';

test.afterAll(retireTrackedApplications);   // leave no open pending rows behind (see helpers/api-specs.ts)

const SCORING_FAILED = 'Scoring failed — will retry automatically the next time this is retried';

async function markScored(applicationId: string, scoreAvg: number) {
  await withDb(c => c.query('UPDATE applications SET score_avg = $2 WHERE id = $1', [applicationId, scoreAvg]));
}
const scoringEvents = async (hr: ReturnType<typeof authed>, applicationId: string) =>
  (await activityOf(hr, applicationId)).filter(a => a.event_type === 'ResumeIQ Scoring Completed');

test.describe('POST /api/applications/:id/retry-scoring — access and lookup', () => {

  test('an unknown application is 404 "Application not found"', async ({ request }) => {
    const res = await authed(request, await getToken(request, 'hr')).post(`/api/applications/A-NOPE-${uid()}/retry-scoring`, {});
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: 'Application not found' });
  });

  test('Hiring Managers are refused (403 "HR access required") and an anonymous caller is 401 — before the application is even looked up', async ({ request }) => {
    const { application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    for (const who of ['hm_alex', 'hm_satyadev'] as const) {
      const res = await authed(request, await getToken(request, who)).post(`/api/applications/${application.id}/retry-scoring`, {});
      expect(res.status(), who).toBe(403);
      expect((await res.json()).error).toBe('HR access required');
    }
    const unknownAsHm = await authed(request, await getToken(request, 'hm_alex')).post(`/api/applications/A-NOPE-${uid()}/retry-scoring`, {});
    expect(unknownAsHm.status()).toBe(403);                       // 403, not 404: the persona gate comes first
    const anon = await rawStatus(request, 'POST', `/api/applications/${application.id}/retry-scoring`, { data: {} });
    expect(anon.status).toBe(401);
  });
});

test.describe('POST /api/applications/:id/retry-scoring — an application that is already scored', () => {

  test('is answered { resumeiq: { scored: true } } with no model call: score, timestamp and activity log are untouched (every HR-tier persona)', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    await markScored(application.id, 6.5);
    const before = await applicationRow(application.id);
    expect(before.score_computed_at).toBeNull();                  // the marker of "the engine never ran for this row"

    for (const who of HR_TIER_USERS) {
      const res = await authed(request, await getToken(request, who)).post(`/api/applications/${application.id}/retry-scoring`, {});
      expect(res.status(), who).toBe(200);
      expect(await res.json(), who).toEqual({ resumeiq: { scored: true } });
    }
    const after = await applicationRow(application.id);
    expect(Number(after.score_avg)).toBe(6.5);
    expect(after.score_computed_at).toBeNull();
    expect(after.ai_fit_score).toBe(before.ai_fit_score);
    expect(after.score_technical).toBe(before.score_technical);
    expect(await scoringEvents(hr, application.id)).toHaveLength(0);
  });

  test('a score of 0.0 counts as scored (the stored value is the string "0.0", which is truthy): no re-scoring, no error', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    await markScored(application.id, 0);
    const res = await hr.post(`/api/applications/${application.id}/retry-scoring`, {});
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ resumeiq: { scored: true } });
    expect(Number((await applicationRow(application.id)).score_avg)).toBe(0);
  });
});

test.describe('POST /api/applications/:id/retry-scoring — an unscored application when the model cannot be reached', () => {

  test('is 200 { scored: false, error } and writes nothing: no score, no fit score, no activity row — and a second retry fails the same way', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const hr = authed(request, hrToken);
    const { candidate, res: createRes } = await createCandidate(request, hrToken, { role_id: 'R006' });
    const created = await createRes.json();
    // Premise: scoring did not happen at creation. A backend that holds an Anthropic key scores on creation, so there is nothing to retry.
    test.skip(created.resumeiq?.scored === true, 'this backend can reach the model (it scored at creation): the failure path cannot be observed here');
    expect(created.resumeiq).toEqual({ scored: false, error: SCORING_FAILED });
    const appId = created.application.id as string;
    trackApplication(appId);
    expect(candidate.id).toBe(created.application.candidate_id);

    const before = await applicationRow(appId);
    expect(before.score_avg).toBeNull();

    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await hr.post(`/api/applications/${appId}/retry-scoring`, {});
      expect(res.status(), `attempt ${attempt}`).toBe(200);
      expect(await res.json(), `attempt ${attempt}`).toEqual({ resumeiq: { scored: false, error: SCORING_FAILED } });
    }
    const after = await applicationRow(appId);
    for (const column of ['score_avg', 'ai_fit_score', 'ai_priority_bucket', 'score_technical', 'score_summary', 'score_computed_at', 'score_resume_read']) {
      expect(after[column], column).toBe(before[column]);
    }
    expect(await scoringEvents(hr, appId)).toHaveLength(0);
  });
});

test.describe('retry-scoring against the real model (needs ANTHROPIC_API_KEY on the backend)', () => {

  test('@live a candidate whose resume link cannot be read is still scored from the profile fields, with score_resume_read=false; retrying afterwards is a no-op', async ({ request }) => {
    test.setTimeout(120_000);
    const hrToken = await getToken(request, 'hr');
    const hr = authed(request, hrToken);
    const { res } = await createCandidate(request, hrToken, {
      role_id: 'R006', resume_drive_link: `https://drive.google.com/file/d/bogus-${uid()}/view`,
      current_company: 'Test Co', current_designation: 'Product Manager', years_of_experience: 5,
    });
    const created = await res.json();
    trackApplication(created.application.id);
    expect(created.resumeiq?.scored, 'the unreadable resume must degrade to profile-only scoring, never a hard error').toBe(true);

    const row = await applicationRow(created.application.id);
    expect(row.score_resume_read).toBe(false);
    expect(Number(row.score_avg)).toBeGreaterThanOrEqual(0);
    expect(Number(row.score_avg)).toBeLessThanOrEqual(10);
    expect(await scoringEvents(hr, created.application.id)).toHaveLength(1);

    const retry = await hr.post(`/api/applications/${created.application.id}/retry-scoring`, {});
    expect(await retry.json()).toEqual({ resumeiq: { scored: true } });
    expect(await scoringEvents(hr, created.application.id)).toHaveLength(1);          // still exactly one: the retry did not score again
  });
});
