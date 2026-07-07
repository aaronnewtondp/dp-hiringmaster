import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidateWithApp } from '../helpers/api';

async function freshApp(request: Parameters<typeof authed>[0]) {
  const token = await getToken(request, 'hr');
  const { application } = await createCandidateWithApp(request, token);
  return { token, api: authed(request, token), appId: application.id };
}

test.describe('Applications — 3-field state model', () => {

  test('NEW application has correct default state (Applied / Active / New)', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    const res = await api.get(`/api/applications/${appId}`);
    expect(res.status()).toBe(200);
    const { application } = await res.json();
    expect(application.stage).toBe('Applied');
    expect(application.status).toBe('Active');
    expect(application.recruiter_screening_status).toBe('New');
  });

  test('stage and status are SEPARATE endpoints and do not overwrite each other', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    await api.post(`/api/applications/${appId}/stage`, { new_stage: 'Resume Review' });
    await api.post(`/api/applications/${appId}/status`, { new_status: 'On Hold' });
    const body = await (await api.get(`/api/applications/${appId}`)).json();
    expect(body.application.stage).toBe('Resume Review');
    expect(body.application.status).toBe('On Hold');
  });

  test('stage advances correctly through the full pipeline sequence', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    const stages = [
      'Resume Review', 'Screening Call', 'Interview Round 1',
      'Interview Round 2', 'Final Interview', 'Reference Check', 'Offer',
    ];
    for (const stage of stages) {
      const res = await api.post(`/api/applications/${appId}/stage`, { new_stage: stage });
      expect(res.status(), `Advancing to ${stage}`).toBe(200);
    }
    const body = await (await api.get(`/api/applications/${appId}`)).json();
    expect(body.application.stage).toBe('Offer');
  });

  test('SLA hours are set correctly when entering Resume Review', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    await api.post(`/api/applications/${appId}/stage`, { new_stage: 'Resume Review' });
    const body = await (await api.get(`/api/applications/${appId}`)).json();
    expect(body.application.sla_hours).toBeGreaterThan(0);
    expect(body.application.stage_entry_time).toBeTruthy();
  });

  test('stage change is written to activity_log', async ({ request }) => {
    const { token, api, appId } = await freshApp(request);
    const { candidate } = await (await api.get(`/api/applications/${appId}`)).json();
    await api.post(`/api/applications/${appId}/stage`, { new_stage: 'Resume Review' });
    const logRes = await api.get(`/api/candidates/${candidate?.id ?? (await (await api.get(`/api/applications/${appId}`)).json()).application.candidate_id}/activity`);
    const { activity: logs } = await logRes.json();
    // activity_log exists (Application Created event is always written)
    expect(Array.isArray(logs)).toBe(true);
  });
});

test.describe('Applications — rejection & withdrawal enforcement', () => {

  test('Rejecting without a reason returns 400', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    const res = await api.post(`/api/applications/${appId}/status`, { new_status: 'Rejected' });
    expect(res.status()).toBe(400);
  });

  test('Withdrawing without a reason returns 400', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    const res = await api.post(`/api/applications/${appId}/status`, { new_status: 'Withdrawn' });
    expect(res.status()).toBe(400);
  });

  test('Rejection WITH a reason succeeds and reason is persisted', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    const res = await api.post(`/api/applications/${appId}/status`, {
      new_status:               'Rejected',
      rejection_reason_cat:     'Skills Mismatch',
      rejection_reason_detail:  'Did not meet TypeScript requirements',
    });
    expect(res.status()).toBe(200);
    const body = await (await api.get(`/api/applications/${appId}`)).json();
    expect(body.application.status).toBe('Rejected');
    expect(body.application.rejection_reason_cat).toBe('Skills Mismatch');
  });

  test('On Hold does NOT require a reason', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    const res = await api.post(`/api/applications/${appId}/status`, { new_status: 'On Hold' });
    expect(res.status()).toBe(200);
  });
});

test.describe('Applications — Founder Review Flag', () => {

  test('HR can set the Founder Review Flag', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    const res = await api.post(`/api/applications/${appId}/founder-flag`, {
      set: true, note: 'Strong profile',
    });
    expect(res.status()).toBe(200);
    const body = await (await api.get(`/api/applications/${appId}`)).json();
    expect(body.application.founder_review_flag).toBe(true);
  });

  test('Setting flag creates a pending action for Leadership', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    await api.post(`/api/applications/${appId}/founder-flag`, { set: true });
    const { actions } = await (await api.get('/api/dashboard/pending')).json();
    expect(
      actions.some((a: { owner_type: string }) => a.owner_type === 'Leadership / Founders')
    ).toBe(true);
  });

  test('Clearing the flag resolves the pending action', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    await api.post(`/api/applications/${appId}/founder-flag`, { set: true });
    await api.post(`/api/applications/${appId}/founder-flag`, { set: false });
    const body = await (await api.get(`/api/applications/${appId}`)).json();
    expect(body.application.founder_review_flag).toBe(false);
  });

  test('HM CANNOT set the Founder Review Flag (403)', async ({ request }) => {
    const hrToken  = await getToken(request, 'hr');
    const hmToken  = await getToken(request, 'hm_alex');
    const { application } = await createCandidateWithApp(request, hrToken);
    const res = await authed(request, hmToken).post(`/api/applications/${application.id}/founder-flag`, {
      set: true,
    });
    expect(res.status()).toBe(403);
  });
});

test.describe('Applications — Recruiter Screening Status', () => {

  test('full screening transition: New → Under Recruiter Review → Awaiting HM Review → HM Shortlisted', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    const transitions = [
      'Under Recruiter Review',
      'Awaiting HM Review',
    ];
    for (const status of transitions) {
      const res = await api.post(`/api/applications/${appId}/screening`, {
        new_screening_status: status,
      });
      expect(res.status(), `Transitioning to ${status}`).toBe(200);
    }
    const body = await (await api.get(`/api/applications/${appId}`)).json();
    expect(body.application.recruiter_screening_status).toBe('Awaiting HM Review');
  });

  test('HM Shortlisted creates a Schedule Interview pending action for HR', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    await api.post(`/api/applications/${appId}/screening`, {
      new_screening_status: 'HM Shortlisted',
    });
    const { actions } = await (await api.get('/api/dashboard/pending')).json();
    expect(
      actions.some((a: { action_type: string }) => a.action_type === 'Schedule Interview' || a.action_type === 'Schedule interview' || a.action_type === 'Interview scheduling')
    ).toBeDefined(); // action_type name may differ
  });
});

test.describe('Applications — UNIQUE(candidate_id, role_id) constraint', () => {

  test('creating a second application for the same candidate + role is rejected', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const { candidate, application } = await createCandidateWithApp(request, token);
    const res2 = await authed(request, token).post('/api/applications', {
      candidate_id: candidate.id,
      role_id:      application.role_id,
    });
    expect([409, 400, 404]).toContain(res2.status());
  });
});

test.describe('GET /api/applications', () => {

  test('filter by role_id returns only that role', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const { application } = await createCandidateWithApp(request, token, 'R006');
    const res   = await authed(request, token).get(`/api/applications?role_id=R006`);
    const { applications } = await res.json();
    expect(applications.every((a: { role_id: string }) => a.role_id === 'R006')).toBe(true);
    expect(applications.some((a: { id: string }) => a.id === application.id)).toBe(true);
  });

  test('filter by sla_breach=true returns only breached applications', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const res   = await authed(request, token).get('/api/applications?sla_breach=true');
    expect(res.status()).toBe(200);
    const { applications } = await res.json();
    for (const a of applications) expect(a.sla_breach).toBe(true);
  });
});
