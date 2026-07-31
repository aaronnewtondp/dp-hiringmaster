// ─────────────────────────────────────────────────────────────────────────────
// Talent Pool & Archival (PRD §21) — archival is immediate: the moment an
// application's status flips to Rejected/Withdrawn, it's excluded from
// Candidates.tsx's default pipeline view and reachable via Talent Pool's
// Archived mode, with no age requirement. (This was originally gated behind
// a 90-day threshold per a literal reading of PRD §21's "90+ days" clause,
// but real usage showed that's not what's wanted — a candidate rejected
// moments ago sat in neither view for 90 days, which is exactly the
// confusion archival was meant to prevent. The 91-day backdating below is
// kept only to prove old/stale rows are unaffected by the same logic, not
// because age matters anymore.)
//
// The 91-day cases still use a direct Postgres connection to backdate
// last_updated (every status-changing route hardcodes NOW(), so there's no
// API path to set an arbitrary past timestamp) — following
// 00-schema-integrity.spec.ts's exact precedent for when a direct DB
// connection is genuinely necessary.
//
// INTENTIONALLY LOCAL-ONLY: hardcoded local-dev credentials, deliberately
// excluded from test:prod (which only runs tests/smoke — read-only, API-only,
// never direct DB access against production).
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed, createCandidateWithApp } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';

test.describe('Talent Pool Archival — immediate, no age threshold (local Postgres, direct connection)', () => {
  let client: Client;

  test.beforeAll(async () => {
    client = new Client({ connectionString: LOCAL_DB_URL });
    await client.connect();
  });

  test.afterAll(async () => {
    await client.end();
  });

  test('a Rejected application backdated past 90 days is excluded from the default pipeline view but reachable via archived=true', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { candidate, application } = await createCandidateWithApp(request, token);

    await api.post(`/api/applications/${application.id}/status`, {
      new_status: 'Rejected', rejection_reason_cat: 'Missing mandatory skill',
    });

    await client.query(
      `UPDATE applications SET last_updated = NOW() - INTERVAL '91 days' WHERE id = $1`,
      [application.id]
    );

    // Excluded from Candidates.tsx's default pipeline table
    const pipelineRes  = await api.get('/api/applications?exclude_stale_archived=true&limit=500');
    const pipelineBody = await pipelineRes.json();
    expect(pipelineBody.applications.some((a: { id: string }) => a.id === application.id)).toBe(false);

    // Still fully reachable via GET /api/applications without the flag (no silent behavior
    // change for any other existing caller of this shared endpoint)
    const unfilteredRes  = await api.get('/api/applications?limit=500');
    const unfilteredBody = await unfilteredRes.json();
    expect(unfilteredBody.applications.some((a: { id: string }) => a.id === application.id)).toBe(true);

    // Reachable via the Talent Pool page's Archived mode
    const archivedRes  = await api.get(`/api/candidates?archived=true&q=${encodeURIComponent(candidate.full_name)}`);
    const archivedBody = await archivedRes.json();
    const found = archivedBody.candidates.find((c: { id: string }) => c.id === candidate.id);
    expect(found).toBeDefined();
    expect(found.applications.find((a: { id: string }) => a.id === application.id).status).toBe('Rejected');
  });

  test('a Withdrawn application backdated past 90 days is also treated as archived (not just Rejected)', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { candidate, application } = await createCandidateWithApp(request, token);

    await api.post(`/api/applications/${application.id}/status`, {
      new_status: 'Withdrawn', withdrawal_reason_cat: 'Personal reasons',
    });
    await client.query(
      `UPDATE applications SET last_updated = NOW() - INTERVAL '91 days' WHERE id = $1`,
      [application.id]
    );

    const res  = await api.get(`/api/candidates?archived=true&q=${encodeURIComponent(candidate.full_name)}`);
    const body = await res.json();
    expect(body.candidates.some((c: { id: string }) => c.id === candidate.id)).toBe(true);
  });

  test('a Rejected application archives immediately — no backdating, no 90-day wait', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { candidate, application } = await createCandidateWithApp(request, token);

    // Sanity: present in the default pipeline view, absent from Archived, before rejecting.
    const beforePipeline = await (await api.get('/api/applications?exclude_stale_archived=true&limit=500')).json();
    expect(beforePipeline.applications.some((a: { id: string }) => a.id === application.id)).toBe(true);
    const beforeArchived = await (await api.get(`/api/candidates?archived=true&q=${encodeURIComponent(candidate.full_name)}`)).json();
    expect(beforeArchived.candidates.some((c: { id: string }) => c.id === candidate.id)).toBe(false);

    await api.post(`/api/applications/${application.id}/status`, {
      new_status: 'Rejected', rejection_reason_cat: 'Missing mandatory skill',
    });

    // Immediately excluded from the default pipeline view — no backdating.
    const pipelineRes  = await api.get('/api/applications?exclude_stale_archived=true&limit=500');
    const pipelineBody = await pipelineRes.json();
    expect(pipelineBody.applications.some((a: { id: string }) => a.id === application.id)).toBe(false);

    // Immediately reachable via Talent Pool's Archived mode — no backdating.
    const archivedRes  = await api.get(`/api/candidates?archived=true&q=${encodeURIComponent(candidate.full_name)}`);
    const archivedBody = await archivedRes.json();
    expect(archivedBody.candidates.some((c: { id: string }) => c.id === candidate.id)).toBe(true);
  });
});
