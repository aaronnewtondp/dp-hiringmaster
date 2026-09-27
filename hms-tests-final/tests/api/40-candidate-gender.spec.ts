// ─────────────────────────────────────────────────────────────────────────────
// Candidate gender auto-tagging (2026-09-28) — candidates.gender ('M'/'F'/
// NULL), auto-computed server-side from full_name at creation via
// backend/src/utils/genderClassifier.ts. NULL means "Unknown" — a real,
// filterable state for a name the dictionary/heuristics don't recognize, or
// a deliberately-excluded ambiguous/unisex name — never coerced to M or F.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { getToken, authed, uid } from '../helpers/api';

test.describe('Candidate gender auto-tagging', () => {

  test('POST /api/candidates auto-tags gender from a well-known male first name', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const res = await authed(request, token).post('/api/candidates', {
      full_name: `Amit Gender Test ${uid()}`,
      email: `gendertest+${uid()}@example.com`,
    });
    expect(res.status()).toBe(201);
    const { candidate } = await res.json();
    expect(candidate.gender).toBe('M');
  });

  test('POST /api/candidates auto-tags gender from a well-known female first name', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const res = await authed(request, token).post('/api/candidates', {
      full_name: `Priya Gender Test ${uid()}`,
      email: `gendertest+${uid()}@example.com`,
    });
    expect(res.status()).toBe(201);
    const { candidate } = await res.json();
    expect(candidate.gender).toBe('F');
  });

  test('POST /api/candidates leaves gender null ("Unknown") for a name the classifier does not recognize', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const res = await authed(request, token).post('/api/candidates', {
      full_name: `Xzqrtnomatch ${uid()}`,
      email: `gendertest+${uid()}@example.com`,
    });
    expect(res.status()).toBe(201);
    const { candidate } = await res.json();
    expect(candidate.gender).toBeNull();
  });

  test('PATCH /api/candidates/:id allows HR to manually correct a gender tag', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const createRes = await authed(request, token).post('/api/candidates', {
      full_name: `Amit Gender Correction Test ${uid()}`,
      email: `gendertest+${uid()}@example.com`,
    });
    const { candidate } = await createRes.json();
    expect(candidate.gender).toBe('M');

    const patchRes = await authed(request, token).patch(`/api/candidates/${candidate.id}`, { gender: 'F' });
    expect(patchRes.status()).toBe(200);
    const { candidate: updated } = await patchRes.json();
    expect(updated.gender).toBe('F');
  });

  test('GET /api/candidates?gender=M only returns candidates tagged male', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const marker = uid();
    await authed(request, token).post('/api/candidates', {
      full_name: `Rahul Filter Test ${marker}`, email: `gendertest+${marker}a@example.com`,
    });
    await authed(request, token).post('/api/candidates', {
      full_name: `Neha Filter Test ${marker}`, email: `gendertest+${marker}b@example.com`,
    });

    const res = await authed(request, token).get(`/api/candidates?q=Filter Test ${marker}&gender=M`);
    expect(res.status()).toBe(200);
    const { candidates } = await res.json();
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.gender).toBe('M');
      expect(c.full_name).not.toContain('Neha');
    }
  });

  test('GET /api/applications?gender=F only returns applications whose candidate is tagged female', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const marker = uid();
    const createRes = await authed(request, token).post('/api/candidates', {
      full_name: `Kavya App Filter Test ${marker}`,
      email: `gendertest+${marker}@example.com`,
      role_id: 'R006',
    });
    expect(createRes.status()).toBe(201);
    const { candidate } = await createRes.json();
    expect(candidate.gender).toBe('F');

    const res = await authed(request, token).get('/api/applications?gender=F&limit=200');
    expect(res.status()).toBe(200);
    const { applications } = await res.json();
    const found = applications.find((a: { candidate_id: string }) => a.candidate_id === candidate.id);
    expect(found).toBeTruthy();
    for (const a of applications) {
      expect(a.candidate_gender).toBe('F');
    }
  });
});
