// ─────────────────────────────────────────────────────────────────────────────
// Backend surface added for Scorecard Summary + the Candidates page's
// "Status" filter fix: scored_only filtering, candidate_industry in the
// join, and status upgraded from single-value equality to array-aware
// (= ANY). Bulk stage/status change itself needs no new backend coverage —
// it's a client-side fan-out over the existing single-ID advanceStage/
// updateStatus endpoints, already covered by 04-applications.spec.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed, createCandidateWithApp, SEEDED } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';

test.describe('scored_only filter + candidate_industry', () => {
  let client: Client;

  test.beforeAll(async () => {
    client = new Client({ connectionString: LOCAL_DB_URL });
    await client.connect();
  });

  test.afterAll(async () => {
    await client.end();
  });

  test('scored_only=true only returns applications with a score_avg set', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);

    const res  = await api.get('/api/applications?scored_only=true&limit=500');
    const body = await res.json();
    expect(body.applications.every((a: { score_avg: number | null }) => a.score_avg != null)).toBe(true);
  });

  test('an unscored application is excluded from scored_only=true', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token, SEEDED.roles.qa_eng);

    // Every application is scored synchronously at creation time now
    // (runResumeIQScoring, called inline from candidates.ts's POST /) — there's
    // no longer a way to produce a genuinely unscored application through the
    // API alone. Null out score_avg directly to simulate the state this test
    // actually cares about (e.g. what a real ResumeIQ failure, or a
    // pre-existing unscored row, looks like), so the scored_only filter's
    // exclusion behavior still gets real coverage.
    await client.query(`UPDATE applications SET score_avg = NULL WHERE id = $1`, [application.id]);

    const res  = await api.get('/api/applications?scored_only=true&limit=500');
    const body = await res.json();
    expect(body.applications.some((a: { id: string }) => a.id === application.id)).toBe(false);
  });

  test('candidate_industry is present on GET /api/applications rows', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { candidate, application } = await createCandidateWithApp(request, token, SEEDED.roles.qa_eng);
    await api.patch(`/api/candidates/${candidate.id}`, { current_industry: 'Water Technology' });

    const res  = await api.get('/api/applications?limit=500');
    const body = await res.json();
    const found = body.applications.find((a: { id: string }) => a.id === application.id);
    expect(found).toBeDefined();
    expect(found.candidate_industry).toBe('Water Technology');
  });
});

test.describe('applications.status filter — array-aware, application status not role status', () => {
  test('status accepts multiple values via repeated query params', async ({ request }) => {
    // Two candidate creations below each trigger a real, synchronous
    // ResumeIQ scoring call now (runResumeIQScoring at creation time),
    // which didn't exist when this test was written against Playwright's
    // 30s default.
    test.setTimeout(60_000);
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application: rejectedApp } = await createCandidateWithApp(request, token, SEEDED.roles.qa_eng);
    await api.post(`/api/applications/${rejectedApp.id}/status`, {
      new_status: 'Rejected', rejection_reason_cat: 'Missing mandatory skill',
    });
    const { application: activeApp } = await createCandidateWithApp(request, token, SEEDED.roles.qa_eng);

    const res  = await api.get('/api/applications?status=Active&status=Rejected&limit=500');
    const body = await res.json();
    const ids  = body.applications.map((a: { id: string }) => a.id);
    expect(ids).toContain(rejectedApp.id);
    expect(ids).toContain(activeApp.id);
    expect(body.applications.every((a: { status: string }) => a.status === 'Active' || a.status === 'Rejected')).toBe(true);
  });

  test('a single status value still filters correctly (backwards compatible)', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token, SEEDED.roles.qa_eng);
    await api.post(`/api/applications/${application.id}/status`, {
      new_status: 'Hold for Future',
    });

    const res  = await api.get('/api/applications?status=Hold for Future&limit=500');
    const body = await res.json();
    expect(body.applications.some((a: { id: string }) => a.id === application.id)).toBe(true);
    expect(body.applications.every((a: { status: string }) => a.status === 'Hold for Future')).toBe(true);
  });
});
