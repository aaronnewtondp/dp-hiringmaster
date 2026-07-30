import { test, expect } from '@playwright/test';
import { BASE, getToken, authed, createCandidate, createCandidateWithApp, uid } from '../helpers/api';

test.describe('Candidate delete + unlinked pagination', () => {

  test.describe('DELETE /api/candidates/:id', () => {

    test('HR deletes an unlinked candidate — 200, then GET 404s (actually gone)', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { candidate } = await createCandidate(request, token);

      const delRes = await request.delete(`${BASE}/api/candidates/${candidate.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(delRes.status()).toBe(200);

      const getRes = await authed(request, token).get(`/api/candidates/${candidate.id}`);
      expect(getRes.status()).toBe(404);
    });

    test('candidate WITH an application cannot be deleted — 409, candidate survives', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { candidate } = await createCandidateWithApp(request, token);

      const delRes = await request.delete(`${BASE}/api/candidates/${candidate.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(delRes.status()).toBe(409);
      const body = await delRes.json();
      expect(body.error).toBeTruthy();

      const getRes = await authed(request, token).get(`/api/candidates/${candidate.id}`);
      expect(getRes.status()).toBe(200);
    });

    test('non-HR persona cannot delete a candidate (403)', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const { candidate } = await createCandidate(request, hrToken);

      const hmToken = await getToken(request, 'hm_alex');
      const delRes = await request.delete(`${BASE}/api/candidates/${candidate.id}`, {
        headers: { Authorization: `Bearer ${hmToken}` },
      });
      expect(delRes.status()).toBe(403);
    });
  });

  test.describe('GET /api/candidates?unlinked=true — real pagination', () => {

    test('limit + offset page through distinct unlinked candidates', async ({ request }) => {
      const token = await getToken(request, 'hr');

      // 3 fresh, guaranteed-unlinked candidates (unique name/email via uid()).
      const created = [];
      for (let i = 0; i < 3; i++) {
        const marker = uid();
        const { candidate } = await createCandidate(request, token, {
          full_name: `Unlinked Pagination ${marker}`,
          email: `unlinked+${marker}@example.com`,
        });
        created.push(candidate);
      }

      const seenIds: string[] = [];
      for (const offset of [0, 1, 2]) {
        const res  = await authed(request, token).get(`/api/candidates?unlinked=true&limit=1&offset=${offset}`);
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.candidates.length).toBe(1);
        expect(body.total).toBeGreaterThanOrEqual(3);
        seenIds.push(body.candidates[0].id);
      }

      // Real pagination advances through different rows each call, not the
      // same page repeated.
      expect(new Set(seenIds).size).toBe(seenIds.length);
    });

    test('every candidate returned has zero applications', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/candidates?unlinked=true&limit=500');
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.candidates)).toBe(true);

      for (const candidate of body.candidates) {
        const apps = candidate.applications;
        const isEmpty = apps === null || apps === undefined || (Array.isArray(apps) && apps.length === 0);
        expect(isEmpty).toBe(true);
      }
    });
  });
});
