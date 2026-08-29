// ─────────────────────────────────────────────────────────────────────────────
// Compensation visibility — CEO directive (2026-08-29): comp details for a
// role, of any kind, should only be visible to that role's own Hiring
// Manager, HR, Leadership, or Super Admin — nobody else, and that includes
// candidate/application CTC fields whenever they're linked to a role the
// viewer doesn't own.
//
// Audit found this was NOT previously true in two distinct ways:
//   1. candidate-profile CTC fields (current_ctc_fixed/variable, current_
//      esops, expected_ctc) and their applications.ts-joined aliases
//      (candidate_ctc_fixed/variable, candidate_expected_ctc), plus the
//      application's own current_ctc_fixed/current_ctc_variable/ectc, were
//      never in stripRestrictedFields' RESTRICTED_FIELDS at all — visible to
//      literally every authenticated persona, always.
//   2. Several routes never called stripRestrictedFields (or roles.ts's
//      manual ctc_band destructure) in the first place: applications.ts's
//      POST /:id/stage response, roles.ts's PATCH /:id response, GET /:id/
//      pipeline, GET /:id/edit-log, GET /:id/activity.
//
// Fix: canSeeCompForRole(persona, userName, hiringManagerName) in auth.ts —
// HR-tier always true; hiring_manager true only when hiringManagerName
// matches their own name. Seeded roles used below: R006 (Senior Product
// Manager) is Alex's own role; R002 (E&I Engineer Mumbai) belongs to
// Satyadev, i.e. NOT Alex's — used as the "doesn't own this one" case.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidate, SEEDED } from '../helpers/api';

const RESTRICTED_KEYS = [
  'ctc_band', 'role_ctc_band', 'internal_risk_notes', 'agency_fee_estimate',
  'offer_ctc_fixed', 'offer_ctc_variable', 'hr_comp_alignment',
  'current_ctc_fixed', 'current_ctc_variable', 'current_esops', 'expected_ctc', 'ectc',
  'candidate_ctc_fixed', 'candidate_ctc_variable', 'candidate_expected_ctc',
];

function assertStripped(obj: Record<string, unknown>) {
  for (const k of RESTRICTED_KEYS) expect(obj).not.toHaveProperty(k);
}

test.describe('Compensation visibility — own-role Hiring Manager + HR-tier only', () => {

  test('GET /api/roles/:id — HM sees ctc_band for their own role, not for another HM\'s role', async ({ request }) => {
    const alexToken = await getToken(request, 'hm_alex');

    const ownRes = await authed(request, alexToken).get(`/api/roles/${SEEDED.roles.senior_pm}`); // R006, Alex's own
    expect(ownRes.status()).toBe(200);
    const { role: ownRole } = await ownRes.json();
    expect(ownRole.ctc_band).toBeTruthy();

    const otherRes = await authed(request, alexToken).get(`/api/roles/${SEEDED.roles.ei_mumbai}`); // R002, Satyadev's
    expect(otherRes.status()).toBe(200);
    const { role: otherRole } = await otherRes.json();
    expect(otherRole).not.toHaveProperty('ctc_band');
  });

  test('GET /api/roles list — ctc_band present only on the HM\'s own role among the results', async ({ request }) => {
    const alexToken = await getToken(request, 'hm_alex');
    const res = await authed(request, alexToken).get('/api/roles');
    expect(res.status()).toBe(200);
    const { roles } = await res.json();

    const own = roles.find((r: { id: string }) => r.id === SEEDED.roles.senior_pm);
    const other = roles.find((r: { id: string }) => r.id === SEEDED.roles.ei_mumbai);
    expect(own.ctc_band).toBeTruthy();
    expect(other).not.toHaveProperty('ctc_band');
  });

  test('HR/Leadership always see ctc_band regardless of role ownership', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const leadToken = await getToken(request, 'leadership');
    for (const token of [hrToken, leadToken]) {
      const res = await authed(request, token).get(`/api/roles/${SEEDED.roles.ei_mumbai}`);
      const { role } = await res.json();
      expect(role.ctc_band).toBeTruthy();
    }
  });

  test('GET /api/applications and /:id — candidate CTC visible only for the HM\'s own role', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const alexToken = await getToken(request, 'hm_alex');

    const { candidate: ownCand, res: ownRes } = await createCandidate(request, hrToken, {
      role_id: SEEDED.roles.senior_pm, expected_ctc: 22, current_ctc_fixed: 18,
    });
    const { application: ownApp } = await ownRes.json();
    const { res: otherRes } = await createCandidate(request, hrToken, {
      role_id: SEEDED.roles.ei_mumbai, expected_ctc: 5, current_ctc_fixed: 4,
    });
    const { application: otherApp } = await otherRes.json();

    const listRes = await authed(request, alexToken).get('/api/applications?limit=500');
    const { applications } = await listRes.json();
    const ownRow = applications.find((a: { id: string }) => a.id === ownApp.id);
    const otherRow = applications.find((a: { id: string }) => a.id === otherApp.id);
    expect(Number(ownRow.candidate_expected_ctc)).toBe(22);
    expect(Number(ownRow.candidate_ctc_fixed)).toBe(18);
    assertStripped(otherRow);

    const ownDetailRes = await authed(request, alexToken).get(`/api/applications/${ownApp.id}`);
    expect(Number((await ownDetailRes.json()).application.candidate_expected_ctc)).toBe(22);
    const otherDetailRes = await authed(request, alexToken).get(`/api/applications/${otherApp.id}`);
    assertStripped((await otherDetailRes.json()).application);
  });

  test('POST /:id/stage response — the exact leak found in the audit (raw, unstripped row previously returned)', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const alexToken = await getToken(request, 'hm_alex');

    // Not Alex's role, and reachable by any persona per the Shortlist-from-
    // Resume-Review carve-out — the scenario that actually leaked before.
    // expected_ctc kept within R002's own band (3-3.5 LPA) so this doesn't
    // also trip the unrelated over-budget mandatory-reason gate.
    const { res } = await createCandidate(request, hrToken, { role_id: SEEDED.roles.ei_mumbai, expected_ctc: 3.2 });
    const { application } = await res.json();
    await authed(request, hrToken).post(`/api/applications/${application.id}/stage`, { new_stage: 'Resume Review' });

    const stageRes = await authed(request, alexToken).post(`/api/applications/${application.id}/stage`, { new_stage: 'Shortlisted' });
    expect(stageRes.status()).toBe(200);
    const { application: updated } = await stageRes.json();
    assertStripped(updated);
  });

  test('GET /api/candidates and /:id — candidate profile CTC visible only when linked to the HM\'s own role', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const alexToken = await getToken(request, 'hm_alex');

    const { candidate: ownCand, res: ownRes } = await createCandidate(request, hrToken, {
      role_id: SEEDED.roles.senior_pm, expected_ctc: 21,
    });
    void ownRes;
    const { candidate: otherCand, res: otherRes } = await createCandidate(request, hrToken, {
      role_id: SEEDED.roles.ei_mumbai, expected_ctc: 5.5,
    });
    void otherRes;

    const ownDetail = await authed(request, alexToken).get(`/api/candidates/${ownCand.id}`);
    expect(Number((await ownDetail.json()).candidate.expected_ctc)).toBe(21);
    const otherDetail = await authed(request, alexToken).get(`/api/candidates/${otherCand.id}`);
    assertStripped((await otherDetail.json()).candidate);

    const listRes = await authed(request, alexToken).get('/api/candidates?limit=500');
    const { candidates } = await listRes.json();
    const ownRow = candidates.find((c: { id: string }) => c.id === ownCand.id);
    const otherRow = candidates.find((c: { id: string }) => c.id === otherCand.id);
    expect(Number(ownRow.expected_ctc)).toBe(21);
    assertStripped(otherRow);
  });

  test('GET /api/roles/:id/pipeline — application rows stripped for a non-owned role, visible for the HM\'s own', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const alexToken = await getToken(request, 'hm_alex');

    const { res: ownRes } = await createCandidate(request, hrToken, { role_id: SEEDED.roles.senior_pm });
    void ownRes;
    const { res: otherRes } = await createCandidate(request, hrToken, { role_id: SEEDED.roles.ei_mumbai });
    void otherRes;

    // This route's own query selects a.* (the application row) plus
    // candidate_name/email/agency_name — no candidate-profile CTC join —
    // so the restricted fields actually at stake here are the
    // application's OWN comp columns (present as real, if often-null,
    // columns on every row: internal_risk_notes, agency_fee_estimate,
    // offer_ctc_fixed/variable, hr_comp_alignment, current_ctc_fixed/
    // variable, ectc). For the owner, those keys should still be present
    // on the row (even when their value is null) rather than stripped out
    // entirely; for a non-owned role, stripRestrictedFields deletes the
    // keys outright.
    const ownPipeline = await authed(request, alexToken).get(`/api/roles/${SEEDED.roles.senior_pm}/pipeline`);
    const ownAll = Object.values((await ownPipeline.json()).pipeline).flat() as Record<string, unknown>[];
    expect(ownAll.length).toBeGreaterThan(0);
    for (const row of ownAll) expect(row).toHaveProperty('agency_fee_estimate');

    const otherPipeline = await authed(request, alexToken).get(`/api/roles/${SEEDED.roles.ei_mumbai}/pipeline`);
    const otherAll = Object.values((await otherPipeline.json()).pipeline).flat() as Record<string, unknown>[];
    expect(otherAll.length).toBeGreaterThan(0);
    for (const row of otherAll) assertStripped(row);
  });

  test('PATCH /api/roles/:id response — ctc_band visible in the response for the role\'s own HM approving it', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const alexToken = await getToken(request, 'hm_alex');

    // A fresh role owned by Alex, rather than mutating a seeded fixture
    // other tests may depend on.
    const createRes = await authed(request, hrToken).post('/api/roles', {
      title: `Comp Visibility Test Role ${Date.now()}`,
      priority: 'P2', hiring_manager_name: 'Alex', ctc_band: '10-15 LPA',
    });
    expect(createRes.status()).toBe(201);
    const { role } = await createRes.json();
    expect(role.status).toBe('Draft'); // status isn't settable at creation — starts Draft regardless

    // hm_alex approving their OWN role — allowed by the pre-existing
    // isApprovingThisRole/isHmForThisRole carve-out (Draft -> Approved
    // satisfies it just as well as Under Review -> Approved), and now also
    // comp-visible in the response since it's their own role.
    const approveRes = await authed(request, alexToken).patch(`/api/roles/${role.id}`, { status: 'Approved' });
    expect(approveRes.status()).toBe(200);
    expect((await approveRes.json()).role.ctc_band).toBe('10-15 LPA');
  });

  test('GET /api/roles/:id/edit-log — a ctc_band change is visible to the role\'s own HM, excluded for another HM', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const alexToken = await getToken(request, 'hm_alex');
    const satyadevToken = await getToken(request, 'hm_satyadev');

    const createRes = await authed(request, hrToken).post('/api/roles', {
      title: `Comp Edit-Log Test Role ${Date.now()}`, priority: 'P2', hiring_manager_name: 'Alex', ctc_band: '10-15 LPA',
    });
    const { role } = await createRes.json();
    await authed(request, hrToken).patch(`/api/roles/${role.id}`, { ctc_band: '12-18 LPA' });

    const ownLog = await authed(request, alexToken).get(`/api/roles/${role.id}/edit-log`);
    const { logs: ownLogs } = await ownLog.json();
    expect(ownLogs.some((l: { field_name: string }) => l.field_name === 'ctc_band')).toBe(true);

    const otherLog = await authed(request, satyadevToken).get(`/api/roles/${role.id}/edit-log`);
    const { logs: otherLogs } = await otherLog.json();
    expect(otherLogs.some((l: { field_name: string }) => l.field_name === 'ctc_band')).toBe(false);
  });

  test('GET /api/roles/:id/activity — a bundled ctc_band mention is redacted from event_detail for another HM, kept for the role\'s own', async ({ request }) => {
    const hrToken = await getToken(request, 'hr');
    const alexToken = await getToken(request, 'hm_alex');
    const satyadevToken = await getToken(request, 'hm_satyadev');

    const createRes = await authed(request, hrToken).post('/api/roles', {
      title: `Comp Activity Test Role ${Date.now()}`, priority: 'P2', hiring_manager_name: 'Alex', ctc_band: '10-15 LPA', location: 'Gurgaon',
    });
    const { role } = await createRes.json();
    // Two fields in one PATCH — bundled into a single 'Role Updated'
    // event_detail string ("ctc_band: ...; location: ...").
    await authed(request, hrToken).patch(`/api/roles/${role.id}`, { ctc_band: '12-18 LPA', location: 'Pune' });

    const ownActivity = await authed(request, alexToken).get(`/api/roles/${role.id}/activity`);
    const { activity: ownLog } = await ownActivity.json();
    const ownEntry = ownLog.find((a: { event_detail?: string }) => a.event_detail?.includes('location'));
    expect(ownEntry.event_detail).toContain('ctc_band');

    const otherActivity = await authed(request, satyadevToken).get(`/api/roles/${role.id}/activity`);
    const { activity: otherLog } = await otherActivity.json();
    const otherEntry = otherLog.find((a: { event_detail?: string }) => a.event_detail?.includes('location'));
    expect(otherEntry.event_detail).not.toContain('ctc_band');
    expect(otherEntry.event_detail).toContain('location');
  });
});
