import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidateWithApp, uid } from '../helpers/api';

test.describe('Agencies API', () => {

  test('HR gets list of seeded agencies', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const res   = await authed(request, token).get('/api/agencies');
    expect(res.status()).toBe(200);
    const { agencies } = await res.json();
    expect(agencies.length).toBeGreaterThanOrEqual(15);
  });

  test('HM cannot access agencies (403)', async ({ request }) => {
    const token = await getToken(request, 'hm_alex');
    const res   = await authed(request, token).get('/api/agencies');
    expect(res.status()).toBe(403);
  });

  test('HR creates a new agency and gets AGN-series ID', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const res   = await authed(request, token).post('/api/agencies', {
      name:            `Test Agency ${uid()}`,
      contract_status: 'Active',
    });
    expect(res.status()).toBe(201);
    const { agency } = await res.json();
    // At least 3 digits, not exactly 3 — see schema.sql's format_seq_id()
    // note (2026-09-05): ids grow past their pad width, never truncate.
    expect(agency.id).toMatch(/^AGN\d{3,}$/);
  });

  test('PATCH updates agency fields', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const createRes = await authed(request, token).post('/api/agencies', {
      name: `Patch Test ${uid()}`, contract_status: 'Active',
    });
    const { agency } = await createRes.json();
    const note = `Updated note ${uid()}`;
    const patchRes = await authed(request, token).patch(`/api/agencies/${agency.id}`, { notes: note });
    expect(patchRes.status()).toBe(200);
    const body = await patchRes.json();
    expect(body.agency.notes).toBe(note);
  });
});

test.describe('PATCH /api/applications/:id/notes', () => {

  test('HR can update recruiter summary and tags', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const { application } = await createCandidateWithApp(request, token);
    const res = await authed(request, token).patch(`/api/applications/${application.id}/notes`, {
      hr_recruiter_summary:  'Strong fit for the role',
      hr_tags:               ['fast-response', 'high-potential'],
    });
    expect(res.status()).toBe(200);
    // notes PATCH response — shape varies by route implementation
    const body = await res.json();
    expect(body).toBeTruthy();
  });

  test('HR priority override requires a non-blank reason (400, nothing written); a reason alone and clearing the override need none', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const { application } = await createCandidateWithApp(request, token);
    const api = authed(request, token);
    for (const body of [
      { hr_priority_override: 'Critical' },
      { hr_priority_override: 'Critical', hr_priority_override_reason: '' },
      { hr_priority_override: 'Critical', hr_priority_override_reason: '   ' },
    ]) {
      const res = await api.patch(`/api/applications/${application.id}/notes`, body);
      expect(res.status(), JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe('hr_priority_override_reason is required when setting an HR priority override');
    }
    let detail = await (await api.get(`/api/applications/${application.id}`)).json();
    expect(detail.application.hr_priority_override).toBeNull();
    expect(detail.activity.find((a: { event_type: string }) => a.event_type === 'Priority Override Set')).toBeUndefined();

    // a reason on its own is not an override change
    expect((await api.patch(`/api/applications/${application.id}/notes`, { hr_priority_override_reason: 'just a note' })).status()).toBe(200);

    // set with a reason, then clear without one
    expect((await api.patch(`/api/applications/${application.id}/notes`, { hr_priority_override: 'Critical', hr_priority_override_reason: 'Founder referral' })).status()).toBe(200);
    detail = await (await api.get(`/api/applications/${application.id}`)).json();
    expect(detail.application.hr_priority_override).toBe('Critical');
    expect(detail.activity.find((a: { event_type: string }) => a.event_type === 'Priority Override Set')).toMatchObject({ event_detail: 'HR Priority → Critical: Founder referral' });
    expect((await api.patch(`/api/applications/${application.id}/notes`, { hr_priority_override: null })).status()).toBe(200);
    detail = await (await api.get(`/api/applications/${application.id}`)).json();
    expect(detail.application.hr_priority_override).toBeNull();
  });

  test('HR priority override WITH reason succeeds', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const { application } = await createCandidateWithApp(request, token);
    const res = await authed(request, token).patch(`/api/applications/${application.id}/notes`, {
      hr_priority_override:        'High',
      hr_priority_override_reason: 'Urgent backfill needed',
    });
    expect(res.status()).toBe(200);
  });

  test('HM cannot update HR notes (403)', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const { application } = await createCandidateWithApp(request, hrToken);
    const hmToken = await getToken(request, 'hm_alex');
    const res = await authed(request, hmToken).patch(`/api/applications/${application.id}/notes`, {
      hr_recruiter_summary: 'HM attempt to write HR notes',
    });
    expect(res.status()).toBe(403);
  });
});

test.describe('Eval Questions API', () => {

  test('GET /api/eval-questions returns seeded questions', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const res   = await authed(request, token).get('/api/eval-questions');
    expect(res.status()).toBe(200);
    const { questions } = await res.json();
    expect(questions.length).toBeGreaterThanOrEqual(13);
  });

  test('filter by evaluation_area', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const res   = await authed(request, token).get('/api/eval-questions?area=Technical');
    const { questions } = await res.json();
    for (const q of questions) {
      expect(q.evaluation_area).toBe('Technical');
    }
  });

  test('HR can add a new question', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const res   = await authed(request, token).post('/api/eval-questions', {
      evaluation_area: 'Communication',
      role_category:   'All',
      question_text:   `Test question ${uid()}?`,
      question_type:   'Behavioural',
      priority:        'Recommended',
    });
    expect(res.status()).toBe(201);
    const { question } = await res.json();
    // At least 3 digits, not exactly 3 — see schema.sql's format_seq_id()
    // note (2026-09-05): ids grow past their pad width, never truncate.
    expect(question.id).toMatch(/^Q\d{3,}$/);
  });
});

test.describe('Comp Benchmarks API', () => {

  test('GET /api/comp-benchmarks returns seeded data', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const res   = await authed(request, token).get('/api/comp-benchmarks');
    expect(res.status()).toBe(200);
    const { benchmarks } = await res.json();
    expect(benchmarks.length).toBeGreaterThanOrEqual(12);
  });

  test('HM cannot access comp benchmarks (403)', async ({ request }) => {
    const token = await getToken(request, 'hm_alex');
    const res   = await authed(request, token).get('/api/comp-benchmarks');
    expect(res.status()).toBe(403);
  });

  test('HR can filter by role_category', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const res   = await authed(request, token).get('/api/comp-benchmarks?role_category=Engineering');
    expect(res.status()).toBe(200);
    const { benchmarks } = await res.json();
    for (const b of benchmarks) expect(b.role_category).toBe('Engineering');
  });
});
