import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidateWithApp, uid } from '../helpers/api';

test.describe('Talent Pool & Archival (PRD §21)', () => {

  test.describe('GET /api/candidates — hold_for_future / archived filters', () => {

    test('hold_for_future=true surfaces a candidate whose application is Hold for Future, with last_updated on each entry', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const { candidate, application } = await createCandidateWithApp(request, token);
      await api.post(`/api/applications/${application.id}/status`, { new_status: 'Hold for Future' });

      const res = await api.get(`/api/candidates?hold_for_future=true&q=${encodeURIComponent(candidate.full_name)}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      const found = body.candidates.find((c: { id: string }) => c.id === candidate.id);
      expect(found).toBeDefined();
      const app = found.applications.find((a: { id: string }) => a.id === application.id);
      expect(app.status).toBe('Hold for Future');
      // Needed for the Talent Pool UI to show "on hold since X" rather than a bare status.
      expect(app.last_updated).toBeTruthy();
    });

    test('a freshly-Rejected application does NOT appear in archived=true (not yet 90 days old)', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const { candidate, application } = await createCandidateWithApp(request, token);
      await api.post(`/api/applications/${application.id}/status`, {
        new_status: 'Rejected', rejection_reason_cat: 'Missing mandatory skill',
      });

      const res  = await api.get(`/api/candidates?archived=true&q=${encodeURIComponent(candidate.full_name)}`);
      const body = await res.json();
      expect(body.candidates.find((c: { id: string }) => c.id === candidate.id)).toBeUndefined();
    });

    test('hold_for_future combines with tag — matching tag includes, non-matching tag excludes', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const { candidate, application } = await createCandidateWithApp(request, token);
      const tagValue = `pool-tag-${uid()}`;
      await api.patch(`/api/candidates/${candidate.id}`, { hr_tags: [tagValue] });
      await api.post(`/api/applications/${application.id}/status`, { new_status: 'Hold for Future' });

      const matchRes  = await api.get(`/api/candidates?hold_for_future=true&tag=${encodeURIComponent(tagValue)}`);
      const matchBody = await matchRes.json();
      expect(matchBody.candidates.some((c: { id: string }) => c.id === candidate.id)).toBe(true);

      const noMatchRes  = await api.get(`/api/candidates?hold_for_future=true&tag=${encodeURIComponent(`no-such-tag-${uid()}`)}`);
      const noMatchBody = await noMatchRes.json();
      expect(noMatchBody.candidates.some((c: { id: string }) => c.id === candidate.id)).toBe(false);
    });

    // Regression guard for a real bug found while building this feature: the
    // count query used COUNT(*) without GROUP BY, so a LEFT JOIN to
    // applications fanned out one row per application — a candidate with 2+
    // applications (exactly what cross-role Talent Pool history looks like)
    // was counted once per application instead of once. Fixed to
    // COUNT(DISTINCT c.id).
    test('total counts distinct candidates, not joined application rows, for a candidate with 2 applications', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const { candidate, application } = await createCandidateWithApp(request, token, 'R002');
      await api.post(`/api/applications/${application.id}/status`, { new_status: 'Hold for Future' });
      await api.post(`/api/candidates/${candidate.id}/applications`, {
        role_id: 'R005', source_channel: 'Regression Test',
      });

      const res  = await api.get(`/api/candidates?hold_for_future=true&q=${encodeURIComponent(candidate.full_name)}`);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.candidates.length).toBe(1);
      expect(body.candidates[0].applications.length).toBe(2);
    });
  });

  test.describe('Reactivate — POST /api/candidates/:id/applications for a Talent Pool candidate', () => {

    test('creates a new application row for the new role and leaves the original completely untouched', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const { candidate, application } = await createCandidateWithApp(request, token, 'R002');
      await api.post(`/api/applications/${application.id}/status`, { new_status: 'Hold for Future' });

      const before      = await (await api.get(`/api/candidates/${candidate.id}`)).json();
      const originalApp = before.applications.find((a: { id: string }) => a.id === application.id);

      const linkRes = await api.post(`/api/candidates/${candidate.id}/applications`, {
        role_id: 'R005', source_channel: 'Talent Pool Reactivation',
      });
      expect(linkRes.status()).toBe(201);
      const { application: newApp } = await linkRes.json();
      expect(newApp.id).not.toBe(application.id);
      expect(newApp.role_id).toBe('R005');
      expect(newApp.status).toBe('Active');
      expect(newApp.stage).toBe('Applied');

      const after         = await (await api.get(`/api/candidates/${candidate.id}`)).json();
      const stillOriginal = after.applications.find((a: { id: string }) => a.id === application.id);
      expect(stillOriginal.status).toBe(originalApp.status);
      expect(stillOriginal.stage).toBe(originalApp.stage);
      expect(after.applications.length).toBe(2);
    });

    test('activity log attributes the reactivation to its source_channel, not the unmatched-role reconciliation default text', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const { candidate } = await createCandidateWithApp(request, token, 'R002');

      await api.post(`/api/candidates/${candidate.id}/applications`, {
        role_id: 'R005', source_channel: 'Talent Pool Reactivation',
      });

      const activityRes = await api.get(`/api/candidates/${candidate.id}/activity`);
      const { activity } = await activityRes.json();
      const detail: string[] = activity.map((e: { event_detail: string }) => e.event_detail);
      expect(detail.some(d => d.includes('Talent Pool Reactivation'))).toBe(true);
      expect(detail.some(d => d === 'Application manually linked from unmatched-role reconciliation')).toBe(false);
    });

    test('still falls back to the unmatched-role reconciliation text when no source_channel is given', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const { candidate } = await createCandidateWithApp(request, token, 'R002');

      await api.post(`/api/candidates/${candidate.id}/applications`, { role_id: 'R005' });

      const activityRes = await api.get(`/api/candidates/${candidate.id}/activity`);
      const { activity } = await activityRes.json();
      const detail: string[] = activity.map((e: { event_detail: string }) => e.event_detail);
      expect(detail).toContain('Application manually linked from unmatched-role reconciliation');
    });
  });

  test.describe('GET /api/applications — exclude_stale_archived', () => {

    test('a freshly-Rejected application still appears with exclude_stale_archived=true (not yet 90 days old)', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);
      const { application } = await createCandidateWithApp(request, token);
      await api.post(`/api/applications/${application.id}/status`, {
        new_status: 'Rejected', rejection_reason_cat: 'Missing mandatory skill',
      });

      const res  = await api.get('/api/applications?exclude_stale_archived=true&limit=500');
      const body = await res.json();
      expect(body.applications.some((a: { id: string }) => a.id === application.id)).toBe(true);
    });

    test('exclude_stale_archived=true does not affect Active applications', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { application } = await createCandidateWithApp(request, token);
      const res  = await authed(request, token).get('/api/applications?exclude_stale_archived=true&limit=500');
      const body = await res.json();
      expect(body.applications.some((a: { id: string }) => a.id === application.id)).toBe(true);
    });
  });
});
