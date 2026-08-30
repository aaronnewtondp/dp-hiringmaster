import { test, expect } from '@playwright/test';
import { getToken, authed } from '../helpers/api';

// GET /api/dashboard/funnel-snapshot — split out of the main GET /api/dashboard
// (RCA, 2026-08-30): HiringFunnelSnapshot.tsx used to call the full 14-query
// dashboard endpoint on load and on every local owner/role-rail change,
// duplicating everything else that endpoint computes just to refresh one
// section. This route computes only hiring_funnel_snapshot. These tests
// confirm it's a byte-for-byte equivalent slice of the main endpoint's own
// hiring_funnel_snapshot field, under every filter/persona combination that
// field already needs to behave correctly under.
test.describe('GET /api/dashboard/funnel-snapshot', () => {

  test('requires auth', async ({ request }) => {
    const res = await request.get('http://localhost:4000/api/dashboard/funnel-snapshot');
    expect(res.status()).toBe(401);
  });

  test('response shape is lean — only hiring_funnel_snapshot, nothing else', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const res   = await authed(request, token).get('/api/dashboard/funnel-snapshot');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['hiring_funnel_snapshot']);
  });

  test('unfiltered: identical to GET /api/dashboard\'s own hiring_funnel_snapshot field (HR)', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const [full, snap] = await Promise.all([
      (await authed(request, token).get('/api/dashboard')).json(),
      (await authed(request, token).get('/api/dashboard/funnel-snapshot')).json(),
    ]);
    expect(snap.hiring_funnel_snapshot).toEqual(full.hiring_funnel_snapshot);
  });

  test('is an array of all 13 canonical stages, each with a breach_types array', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const { hiring_funnel_snapshot } = await (await authed(request, token).get('/api/dashboard/funnel-snapshot')).json();
    expect(Array.isArray(hiring_funnel_snapshot)).toBe(true);
    expect(hiring_funnel_snapshot.length).toBe(13);
    for (const stage of hiring_funnel_snapshot) {
      expect(typeof stage.stage).toBe('string');
      expect(typeof stage.total).toBe('number');
      expect(Array.isArray(stage.breach_types)).toBe(true);
    }
  });

  test('owner filter — every returned candidate matches the requested owner', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const { hiring_funnel_snapshot } = await (
      await authed(request, token).get('/api/dashboard/funnel-snapshot?owner=Hiring Manager')
    ).json();
    for (const stage of hiring_funnel_snapshot) {
      for (const bt of stage.breach_types) {
        expect(bt.owner).toBe('Hiring Manager');
        for (const c of bt.candidates) expect(c.owner).toBe('Hiring Manager');
      }
    }
  });

  test('master role filters scope the snapshot identically to GET /api/dashboard', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const [full, snap] = await Promise.all([
      (await authed(request, token).get('/api/dashboard?department=Product%2FQA')).json(),
      (await authed(request, token).get('/api/dashboard/funnel-snapshot?department=Product%2FQA')).json(),
    ]);
    expect(snap.hiring_funnel_snapshot).toEqual(full.hiring_funnel_snapshot);
  });

  test('a Hiring Manager is locked to their own role(s), matching GET /api/dashboard\'s own lock', async ({ request }) => {
    const token = await getToken(request, 'hm_alex');
    const [full, snap] = await Promise.all([
      (await authed(request, token).get('/api/dashboard')).json(),
      (await authed(request, token).get('/api/dashboard/funnel-snapshot')).json(),
    ]);
    expect(snap.hiring_funnel_snapshot).toEqual(full.hiring_funnel_snapshot);
    // A Hiring Manager who is not the owner of a stray breach's role should
    // never see it — every candidate's role must be one hm_alex actually owns.
    // (Cross-checked indirectly: the main endpoint's own lock is covered by
    // 36-hm-dashboard-lock.spec.ts; this test only needs to prove the two
    // endpoints agree, which the deep-equal above already does.)
  });

  test('a Hiring Manager sending someone else\'s role_id has it overridden outright, same as sending none', async ({ request }) => {
    const token = await getToken(request, 'hm_satyadev');
    // R006 (Senior Product Manager) is Alex's role, not Satyadev's — the
    // server-side lock must override this regardless, so the result should
    // be identical to Satyadev's own normal (unscoped) snapshot rather than
    // either leaking R006's breaches in or going empty.
    const [unscoped, withOthersRoleId] = await Promise.all([
      (await authed(request, token).get('/api/dashboard/funnel-snapshot')).json(),
      (await authed(request, token).get('/api/dashboard/funnel-snapshot?role_id=R006')).json(),
    ]);
    expect(withOthersRoleId.hiring_funnel_snapshot).toEqual(unscoped.hiring_funnel_snapshot);
  });
});
