// ─────────────────────────────────────────────────────────────────────────────
// Persona rules on the two application routes a Hiring Manager is allowed to touch (backend/src/routes/applications.ts):
//
//   POST /:id/screening   HR-tier may set ANY recruiter_screening_status; a Hiring Manager only 'HM Shortlisted' (everyone else: nothing).
//   POST /:id/stage       HR-tier may move to any stage; everyone else only Applied and Screened -> Interview Round 1 (the shortlist).
//   POST /:id/status      HR-tier any status; everyone else only Hold for Future / Rejected, and only from Applied and Screened.
//
// The shortlist rule was pinned only incidentally (35-comp-visibility) and the screening rule by a test that accepted 200, 403 or 500
// (05-access-control). Side effects are asserted from the database (pending_actions, applications): the /dashboard/pending queue is a
// capped window and says nothing about rows it did not return.
// Every test creates its own application on a seeded role (R006: Alex is its Hiring Manager; R002: Satyadev's).
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { authed, getSession, getToken, uid } from '../helpers/api';
import { HR_TIER_USERS, activityOf, applicationRow, newApplicationAt, pendingRows, rawStatus } from '../helpers/api-specs';

const HR_ONLY_SCREENING = 'Only HR/Leadership can set this screening status.';
const SCREENING_VALUES = ['New', 'Under Recruiter Review', 'Awaiting HM Review', 'HM Shortlisted', 'Screening Hold', 'Screening Rejected'];

test.describe('POST /api/applications/:id/screening', () => {

  test('a Hiring Manager may set HM Shortlisted: the HM review row is resolved and a "Schedule interview" row opens for HR', async ({ request }) => {
    // HR shortlists (Applied -> Interview Round 1), which opens the Hiring Manager's 'HM shortlist review' row for the role's HM.
    const { application } = await newApplicationAt(request, 'Interview Round 1', 'R006');
    const before = await pendingRows(application.id);
    expect(before.filter(r => r.action_type === 'HM shortlist review' && !r.resolved)).toHaveLength(1);
    expect(before.find(r => r.action_type === 'HM shortlist review')).toMatchObject({ owner_type: 'Hiring Manager', responsible_person: 'Alex' });

    const alex = await getSession(request, 'hm_alex');
    const res = await authed(request, alex.token).post(`/api/applications/${application.id}/screening`, { new_screening_status: 'HM Shortlisted' });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ success: true, new_screening_status: 'HM Shortlisted' });

    expect((await applicationRow(application.id)).recruiter_screening_status).toBe('HM Shortlisted');
    const after = await pendingRows(application.id);
    expect(after.find(r => r.action_type === 'HM shortlist review')?.resolved).toBe(true);
    const schedule = after.filter(r => r.action_type === 'Schedule interview');
    expect(schedule).toHaveLength(1);
    expect(schedule[0]).toMatchObject({ owner_type: 'HR / Recruiter', resolved: false });
  });

  test('the screening change is written to the activity log with the old and new value and the acting Hiring Manager', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    const alexToken = await getToken(request, 'hm_alex');
    await authed(request, alexToken).post(`/api/applications/${application.id}/screening`, { new_screening_status: 'HM Shortlisted' });
    const event = (await activityOf(hr, application.id)).find(a => a.event_type === 'Recruiter Screening Status Changed');
    expect(event).toMatchObject({ old_value: 'New', new_value: 'HM Shortlisted', event_detail: 'Screening → HM Shortlisted', performed_by_name: 'Alex' });
  });

  test('every other screening status is HR-tier only: a Hiring Manager gets 403, the status is unchanged and no row is created', async ({ request }) => {
    const { application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    const alex = authed(request, await getToken(request, 'hm_alex'));
    const rowsBefore = (await pendingRows(application.id)).length;

    for (const status of SCREENING_VALUES.filter(s => s !== 'HM Shortlisted').concat(['not-a-real-status'])) {
      const res = await alex.post(`/api/applications/${application.id}/screening`, { new_screening_status: status });
      expect(res.status(), status).toBe(403);
      expect((await res.json()).error, status).toBe(HR_ONLY_SCREENING);
    }
    expect((await applicationRow(application.id)).recruiter_screening_status).toBe('New');
    expect(await pendingRows(application.id)).toHaveLength(rowsBefore);
  });

  test('a Hiring Manager is not scoped to their own roles here: Satyadev may shortlist on a role Alex owns (the rule is the persona, not the role)', async ({ request }) => {
    // Pinned as the code behaves: the route checks persona + the value only, never roles.hiring_manager_name.
    const { application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    const res = await authed(request, await getToken(request, 'hm_satyadev')).post(`/api/applications/${application.id}/screening`, { new_screening_status: 'HM Shortlisted' });
    expect(res.status()).toBe(200);
    expect((await applicationRow(application.id)).recruiter_screening_status).toBe('HM Shortlisted');
  });

  test('HR-tier users (hr, hr2, leadership, super_admin) may set every defined screening status', async ({ request }) => {
    for (const who of HR_TIER_USERS) {
      const { application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
      const api = authed(request, await getToken(request, who));
      for (const status of SCREENING_VALUES) {
        const res = await api.post(`/api/applications/${application.id}/screening`, { new_screening_status: status });
        expect(res.status(), `${who} -> ${status}`).toBe(200);
        expect((await applicationRow(application.id)).recruiter_screening_status).toBe(status);
      }
    }
  });

  test('HM Shortlisted set by Leadership has the same effects as by a Hiring Manager (review row resolved, HR row created)', async ({ request }) => {
    const { application } = await newApplicationAt(request, 'Interview Round 1', 'R006');
    const res = await authed(request, await getToken(request, 'leadership')).post(`/api/applications/${application.id}/screening`, { new_screening_status: 'HM Shortlisted' });
    expect(res.status()).toBe(200);
    const rows = await pendingRows(application.id);
    expect(rows.find(r => r.action_type === 'HM shortlist review')?.resolved).toBe(true);
    expect(rows.filter(r => r.action_type === 'Schedule interview' && !r.resolved)).toHaveLength(1);
  });

  test('a missing new_screening_status is 400 for everyone — even before the application is looked up', async ({ request }) => {
    const { application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    for (const [who, id] of [['hr', application.id], ['hm_alex', application.id], ['hm_alex', `A-NOPE-${uid()}`]] as const) {
      const res = await authed(request, await getToken(request, who)).post(`/api/applications/${id}/screening`, {});
      expect(res.status(), `${who} ${id}`).toBe(400);
      expect((await res.json()).error).toBe('new_screening_status required');
    }
  });

  test('an unknown application is 404 for HR and for a Hiring Manager (the lookup comes before the persona check)', async ({ request }) => {
    for (const who of ['hr', 'hm_alex'] as const) {
      const res = await authed(request, await getToken(request, who)).post(`/api/applications/A-NOPE-${uid()}/screening`, { new_screening_status: 'HM Shortlisted' });
      expect(res.status(), who).toBe(404);
      expect((await res.json()).error).toBe('Application not found');
    }
  });

  test('no token is 401', async ({ request }) => {
    const { application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    const res = await rawStatus(request, 'POST', `/api/applications/${application.id}/screening`, { data: { new_screening_status: 'HM Shortlisted' } });
    expect(res.status).toBe(401);
    expect((await applicationRow(application.id)).recruiter_screening_status).toBe('New');
  });

  test('TODAY: an undefined status value from HR is a 500 (the CHECK constraint), not a 400, and nothing changes', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    const res = await hr.post(`/api/applications/${application.id}/screening`, { new_screening_status: 'Totally Bogus' });
    expect(res.status()).toBe(500);
    expect((await res.json()).error).toBe('Internal server error');
    expect((await applicationRow(application.id)).recruiter_screening_status).toBe('New');
    expect((await activityOf(hr, application.id)).map(a => a.event_type)).not.toContain('Recruiter Screening Status Changed');
  });

  test('TODAY: setting HM Shortlisted twice is not idempotent — each call opens another "Schedule interview" row for HR', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    for (let i = 0; i < 2; i++) {
      const res = await hr.post(`/api/applications/${application.id}/screening`, { new_screening_status: 'HM Shortlisted' });
      expect(res.status()).toBe(200);
    }
    const open = (await pendingRows(application.id)).filter(r => r.action_type === 'Schedule interview' && !r.resolved);
    expect(open).toHaveLength(2);
  });
});

test.describe('POST /api/applications/:id/stage — the shortlist is the only move open to a Hiring Manager', () => {

  test('a Hiring Manager moves Applied and Screened -> Interview Round 1 (200) and the role\'s HM gets a "HM shortlist review" row', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Applied and Screened', 'R002');   // R002: Satyadev's role, not Alex's
    const alex = authed(request, await getToken(request, 'hm_alex'));

    const res = await alex.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 1' });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.application.stage).toBe('Interview Round 1');
    // The response is stripped for a Hiring Manager on a role that is not theirs (no HR-only fields leak through this carve-out).
    for (const field of ['internal_risk_notes', 'agency_fee_estimate', 'offer_ctc_fixed', 'offer_ctc_variable', 'hr_comp_alignment', 'role_ctc_band']) {
      expect(body.application, field).not.toHaveProperty(field);
    }

    expect((await applicationRow(application.id)).stage).toBe('Interview Round 1');
    const row = (await pendingRows(application.id)).find(r => r.action_type === 'HM shortlist review');
    expect(row).toMatchObject({ owner_type: 'Hiring Manager', resolved: false, responsible_person: 'Satyadev' });
    const event = (await activityOf(hr, application.id)).find(a => a.event_type === 'Stage Changed');
    expect(event).toMatchObject({ old_value: 'Applied and Screened', new_value: 'Interview Round 1', performed_by_name: 'Alex' });
  });

  test('any other move is HR-tier only: a Hiring Manager gets 403 "HR access required" and the stage is unchanged', async ({ request }) => {
    const { application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    const alex = authed(request, await getToken(request, 'hm_alex'));
    for (const stage of ['Interview Round 2', 'Assignment Round', 'Founders Round', 'Reference Check', 'Offer Released', 'Joined', 'Applied and Screened', 'Not A Stage']) {
      const res = await alex.post(`/api/applications/${application.id}/stage`, { new_stage: stage });
      expect(res.status(), stage).toBe(403);
      expect((await res.json()).error, stage).toBe('HR access required');
    }
    expect((await applicationRow(application.id)).stage).toBe('Applied and Screened');
  });

  test('the carve-out exists only AT Applied and Screened: once the application has moved on, a Hiring Manager cannot move it at all', async ({ request }) => {
    const { application } = await newApplicationAt(request, 'Interview Round 1', 'R006');
    const alex = authed(request, await getToken(request, 'hm_alex'));
    for (const stage of ['Interview Round 1', 'Interview Round 2']) {
      const res = await alex.post(`/api/applications/${application.id}/stage`, { new_stage: stage });
      expect(res.status(), stage).toBe(403);
    }
    expect((await applicationRow(application.id)).stage).toBe('Interview Round 1');
  });

  test('HR-tier users (hr, hr2, leadership, super_admin) may move an application to any stage', async ({ request }) => {
    for (const who of HR_TIER_USERS) {
      const { application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
      const res = await authed(request, await getToken(request, who)).post(`/api/applications/${application.id}/stage`, { new_stage: 'Founders Round' });
      expect(res.status(), who).toBe(200);
      expect((await applicationRow(application.id)).stage).toBe('Founders Round');
    }
  });

  test('a missing new_stage is 400 for a Hiring Manager too, and an unknown application is 404 (both before the persona check)', async ({ request }) => {
    const { application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    const alex = authed(request, await getToken(request, 'hm_alex'));
    const missing = await alex.post(`/api/applications/${application.id}/stage`, {});
    expect(missing.status()).toBe(400);
    expect((await missing.json()).error).toBe('new_stage required');
    const unknown = await alex.post(`/api/applications/A-NOPE-${uid()}/stage`, { new_stage: 'Interview Round 2' });
    expect(unknown.status()).toBe(404);
  });
});

test.describe('POST /api/applications/:id/status — the Hiring Manager carve-out (Hold for Future / Rejected, from Applied and Screened only)', () => {

  test('a Hiring Manager may put an Applied-and-Screened candidate on Hold for Future (200) and may reject with a reason', async ({ request }) => {
    const alex = authed(request, await getToken(request, 'hm_alex'));
    const held = await newApplicationAt(request, 'Applied and Screened', 'R006');
    const hold = await alex.post(`/api/applications/${held.application.id}/status`, { new_status: 'Hold for Future' });
    expect(hold.status()).toBe(200);
    expect((await applicationRow(held.application.id)).status).toBe('Hold for Future');

    const rejected = await newApplicationAt(request, 'Applied and Screened', 'R006');
    const noReason = await alex.post(`/api/applications/${rejected.application.id}/status`, { new_status: 'Rejected' });
    expect(noReason.status()).toBe(400);
    expect((await noReason.json()).error).toBe('A reason is required when rejecting or withdrawing a candidate');
    const withReason = await alex.post(`/api/applications/${rejected.application.id}/status`, { new_status: 'Rejected', rejection_reason_cats: ['Skills Mismatch'] });
    expect(withReason.status()).toBe(200);
    expect((await applicationRow(rejected.application.id)).status).toBe('Rejected');
  });

  test('every other status, and any status once the candidate is past Applied and Screened, is 403 for a Hiring Manager', async ({ request }) => {
    const alex = authed(request, await getToken(request, 'hm_alex'));
    const early = await newApplicationAt(request, 'Applied and Screened', 'R006');
    for (const status of ['Withdrawn', 'Active', 'Closed', 'Joined']) {
      const res = await alex.post(`/api/applications/${early.application.id}/status`, { new_status: status, withdrawal_reason_cat: 'x' });
      expect(res.status(), status).toBe(403);
    }
    const late = await newApplicationAt(request, 'Interview Round 1', 'R006');
    for (const status of ['Hold for Future', 'Rejected']) {
      const res = await alex.post(`/api/applications/${late.application.id}/status`, { new_status: status, rejection_reason_cats: ['x'] });
      expect(res.status(), `${status} after Applied`).toBe(403);
      expect((await res.json()).error).toBe('HR access required');
    }
    expect((await applicationRow(early.application.id)).status).toBe('Active');
    expect((await applicationRow(late.application.id)).status).toBe('Active');
  });
});
