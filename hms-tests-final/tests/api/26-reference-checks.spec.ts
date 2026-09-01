// ─────────────────────────────────────────────────────────────────────────────
// Reference checks (backend/src/routes/refChecks.ts, table ref_checks) — CRUD
// plus the mandatory-at-least-one-before-leaving-Reference-Check gate on
// POST /applications/:id/stage. The table's original columns
// (reference_contacts/overall_outcome/positive_comments/concerns_raised/
// risk_level/ai_summary) were replaced outright — confirmed zero rows and
// zero frontend usage anywhere before this change — so there's no legacy
// shape to keep testing here.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidateWithApp } from '../helpers/api';

test.describe('Reference check CRUD', () => {

  test('POST requires reference_name, reference_number, relationship, and feedback', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);

    const res = await api.post('/api/ref-checks', {
      application_id: application.id, reference_name: 'Priya Sharma',
    });
    expect(res.status()).toBe(400);
  });

  test('POST with all fields creates a record with the RC prefix and correct shape', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);

    const res = await api.post('/api/ref-checks', {
      application_id:       application.id,
      reference_name:       'Priya Sharma',
      reference_number:     '+91 98765 43210',
      relationship:         'Reporting Manager',
      feedback:             'Excellent',
      reference_call_notes: 'Very strong endorsement, would rehire.',
    });
    expect(res.status()).toBe(201);
    const { ref_check } = await res.json();
    expect(ref_check.id).toMatch(/^RC\d+$/);
    expect(ref_check.reference_name).toBe('Priya Sharma');
    expect(ref_check.reference_number).toBe('+91 98765 43210');
    expect(ref_check.relationship).toBe('Reporting Manager');
    expect(ref_check.feedback).toBe('Excellent');
    expect(ref_check.reference_call_notes).toBe('Very strong endorsement, would rehire.');
  });

  test('reference_call_notes is optional', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);

    const res = await api.post('/api/ref-checks', {
      application_id:   application.id,
      reference_name:   'Amit Rao',
      reference_number: '+91 91234 56780',
      relationship:     'Colleague',
      feedback:         'Good',
    });
    expect(res.status()).toBe(201);
    expect((await res.json()).ref_check.reference_call_notes).toBeFalsy();
  });

  test('GET returns reference checks for an application', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);

    await api.post('/api/ref-checks', {
      application_id: application.id, reference_name: 'Priya Sharma',
      reference_number: '+91 98765 43210', relationship: 'Reporting Manager', feedback: 'Excellent',
    });

    const res  = await api.get(`/api/ref-checks?application_id=${application.id}`);
    expect(res.status()).toBe(200);
    const { ref_checks } = await res.json();
    expect(ref_checks.length).toBe(1);
    expect(ref_checks[0].reference_name).toBe('Priya Sharma');
  });

  test('PATCH updates an existing reference check', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);

    const createRes = await api.post('/api/ref-checks', {
      application_id: application.id, reference_name: 'Priya Sharma',
      reference_number: '+91 98765 43210', relationship: 'Reporting Manager', feedback: 'Good',
    });
    const { ref_check } = await createRes.json();

    const patchRes = await api.patch(`/api/ref-checks/${ref_check.id}`, { feedback: 'Excellent' });
    expect(patchRes.status()).toBe(200);
    expect((await patchRes.json()).ref_check.feedback).toBe('Excellent');
  });
});

test.describe('Reference-check-required gate on POST /applications/:id/stage', () => {

  test('leaving Reference Check with zero reference checks is blocked', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);
    await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Reference Check' });

    const res = await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Pre-Joining Documents' });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('reference check');
  });

  test('adding a reference check unblocks the advance', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);
    await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Reference Check' });

    expect((await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Pre-Joining Documents' })).status()).toBe(400);

    await api.post('/api/ref-checks', {
      application_id: application.id, reference_name: 'Priya Sharma',
      reference_number: '+91 98765 43210', relationship: 'Reporting Manager', feedback: 'Excellent',
    });

    const res = await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Pre-Joining Documents' });
    expect(res.status()).toBe(200);
  });

  test('skip_reason bypasses the reference-check gate', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);
    await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Reference Check' });

    const res = await api.post(`/api/applications/${application.id}/stage`, {
      new_stage: 'Pre-Joining Documents', skip_reason: 'Internal transfer, references already on file elsewhere',
    });
    expect(res.status()).toBe(200);
  });

  test('the gate only fires when leaving Reference Check, not on unrelated transitions', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);

    // Never visited Reference Check at all — moving between earlier stages
    // must not be blocked by a gate that only applies when actually sitting
    // in that stage.
    const res = await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 1' });
    expect(res.status()).toBe(200);
  });
});
