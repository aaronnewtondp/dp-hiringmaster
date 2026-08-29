import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidate } from '../helpers/api';

// ─── Candidate 'source' field — Identity section, optional, but 'Agency' ──────
// requires naming which agency. Distinct from applications.source_channel
// (how one specific application arrived) — this is candidate-level, "where
// did we originally find this person." Enforced server-side on both create
// (POST /api/candidates) and edit (PATCH /api/candidates/:id), not just as
// a frontend dropdown gate.
test.describe('Candidate source field', () => {

  test.describe('POST /api/candidates — create', () => {

    test('source left unset entirely — succeeds, not mandatory', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const { res } = await createCandidate(request, hrToken, {});
      expect(res.status()).toBe(201);
      const { candidate } = await res.json();
      expect(candidate.source).toBeFalsy();
    });

    test('source = Agency with no sourced_by_agency_id — 400', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const { res } = await createCandidate(request, hrToken, { source: 'Agency' });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('agency');
    });

    test('source = Agency WITH sourced_by_agency_id — 201, persists', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const { res } = await createCandidate(request, hrToken, {
        source: 'Agency',
        sourced_by_agency_id: 'AGN001',
      });
      expect(res.status()).toBe(201);
      const { candidate } = await res.json();
      expect(candidate.source).toBe('Agency');
      expect(candidate.sourced_by_agency_id).toBe('AGN001');
    });

    test('source = LinkedIn (non-Agency) — 201, no agency required', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const { res } = await createCandidate(request, hrToken, { source: 'LinkedIn' });
      expect(res.status()).toBe(201);
      const { candidate } = await res.json();
      expect(candidate.source).toBe('LinkedIn');
      expect(candidate.sourced_by_agency_id).toBeFalsy();
    });
  });

  test.describe('PATCH /api/candidates/:id — edit', () => {

    test('setting source to Agency with no agency on record — 400, no change applied', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const { candidate } = await createCandidate(request, hrToken, {});

      const patchRes = await authed(request, hrToken).patch(`/api/candidates/${candidate.id}`, {
        source: 'Agency',
      });
      expect(patchRes.status()).toBe(400);

      const getRes = await authed(request, hrToken).get(`/api/candidates/${candidate.id}`);
      const { candidate: fetched } = await getRes.json();
      expect(fetched.source).toBeFalsy();
    });

    test('setting sourced_by_agency_id alone, when source is already Agency — 200, persists', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const { candidate } = await createCandidate(request, hrToken, {
        source: 'Agency',
        sourced_by_agency_id: 'AGN001',
      });

      // Re-pointing to a different agency without resending `source` —
      // exercises the "effective" existing+incoming merge in the validation.
      const patchRes = await authed(request, hrToken).patch(`/api/candidates/${candidate.id}`, {
        sourced_by_agency_id: 'AGN003',
      });
      expect(patchRes.status()).toBe(200);
      const { candidate: patched } = await patchRes.json();
      expect(patched.sourced_by_agency_id).toBe('AGN003');
    });

    test('moving source away from Agency clears the now-stale sourced_by_agency_id server-side', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const { candidate } = await createCandidate(request, hrToken, {
        source: 'Agency',
        sourced_by_agency_id: 'AGN001',
      });

      // Only 'source' is sent — the frontend would normally also clear
      // sourced_by_agency_id itself, but the server must not depend on that.
      const patchRes = await authed(request, hrToken).patch(`/api/candidates/${candidate.id}`, {
        source: 'Direct Outreach',
      });
      expect(patchRes.status()).toBe(200);
      const { candidate: patched } = await patchRes.json();
      expect(patched.source).toBe('Direct Outreach');
      expect(patched.sourced_by_agency_id).toBeFalsy();
    });

    test('GET /api/candidates/:id exposes sourced_by_agency_name via the join', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const { candidate } = await createCandidate(request, hrToken, {
        source: 'Agency',
        sourced_by_agency_id: 'AGN001',
      });

      const getRes = await authed(request, hrToken).get(`/api/candidates/${candidate.id}`);
      expect(getRes.status()).toBe(200);
      const { candidate: fetched } = await getRes.json();
      expect(fetched.sourced_by_agency_name).toBe('Teamplus Staffing');
    });
  });
});
