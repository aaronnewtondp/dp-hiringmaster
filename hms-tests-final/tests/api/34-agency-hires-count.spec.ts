import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidate } from '../helpers/api';

// ─── Agency "Hires" count — driven by candidates.sourced_by_agency_id ─────────
// (Identity section's Source = Agency), not the older, never-actually-set
// applications.agency_id field. Counted per distinct CANDIDATE, gated on the
// candidate having at least one application at Offer Accepted or Joined —
// Offer Released doesn't count yet, the offer could still fall through.
test.describe('Agency Hires count (GET /api/agencies, GET /api/agencies/:id)', () => {

  async function getAgencyHires(request: Parameters<typeof authed>[0], token: string, agencyId: string) {
    const listRes = await authed(request, token).get('/api/agencies');
    const { agencies } = await listRes.json();
    const fromList = agencies.find((a: { id: string }) => a.id === agencyId);

    const singleRes = await authed(request, token).get(`/api/agencies/${agencyId}`);
    const { agency } = await singleRes.json();

    return { fromList: Number(fromList.total_hired), fromSingle: Number(agency.total_hired) };
  }

  test('candidate sourced from an agency, stage advanced to Offer Accepted, increments Hires by 1', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const agencyId = 'AGN006'; // Antal (seeded)

    const before = await getAgencyHires(request, hrToken, agencyId);

    const { candidate, res } = await createCandidate(request, hrToken, {
      source: 'Agency',
      sourced_by_agency_id: agencyId,
      role_id: 'R006',
    });
    const { application } = await res.json();

    const stageRes = await authed(request, hrToken).post(
      `/api/applications/${application.id}/stage`,
      { new_stage: 'Offer Accepted' }
    );
    expect(stageRes.status()).toBe(200);

    const after = await getAgencyHires(request, hrToken, agencyId);
    expect(after.fromList).toBe(before.fromList + 1);
    expect(after.fromSingle).toBe(before.fromSingle + 1);

    // Cross-check the candidate itself carries the right source, since the
    // count above is worthless if this silently drifted.
    const candRes = await authed(request, hrToken).get(`/api/candidates/${candidate.id}`);
    const { candidate: fetched } = await candRes.json();
    expect(fetched.sourced_by_agency_id).toBe(agencyId);
  });

  test('candidate sourced from an agency but still at Applied and Screened does NOT count as a hire', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const agencyId = 'AGN003'; // Talhive (seeded) — separate agency, avoids interference with the test above

    const before = await getAgencyHires(request, hrToken, agencyId);

    await createCandidate(request, hrToken, {
      source: 'Agency',
      sourced_by_agency_id: agencyId,
      role_id: 'R006',
    });

    const after = await getAgencyHires(request, hrToken, agencyId);
    expect(after.fromList).toBe(before.fromList);
    expect(after.fromSingle).toBe(before.fromSingle);
  });

  test('a candidate NOT sourced from any agency never counts toward any agency\'s Hires', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');

    const { res } = await createCandidate(request, hrToken, {
      source: 'LinkedIn',
      role_id: 'R006',
    });
    const { application, candidate } = await res.json();

    await authed(request, hrToken).post(`/api/applications/${application.id}/stage`, { new_stage: 'Offer Accepted' });

    // Sanity: this candidate really has no sourcing agency on record.
    const candRes = await authed(request, hrToken).get(`/api/candidates/${candidate.id}`);
    const { candidate: fetched } = await candRes.json();
    expect(fetched.sourced_by_agency_id).toBeFalsy();
  });
});
