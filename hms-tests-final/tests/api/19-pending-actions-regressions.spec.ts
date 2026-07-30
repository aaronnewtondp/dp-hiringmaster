import { test, expect } from '@playwright/test';
import { getToken, authed } from '../helpers/api';

// Shape of one row in pending_actions_by_owner[...] as returned by
// GET /api/dashboard — current_stage/sla_breach come from the LEFT JOIN onto
// applications, so both are nullable (entries with no application_id, e.g.
// 'Role aging alert' historically, or the CTC-change trigger's action, have
// no linked application at all).
type PendingActionEntry = {
  id: number;
  owner_type: string;
  priority_level: string;
  action_type: string;
  description: string;
  application_id: string | null;
  candidate_name: string | null;
  role_title: string | null;
  hours_overdue: number | null;
  current_stage: string | null;
  sla_breach: boolean | null;
};

// Replicates dashboard.ts's totalPendingActions formula exactly:
//   pendingForUser.filter(pa => !(pa.owner_type === 'HR / Recruiter' && pa.sla_breach)).length
// 'Role aging alert' is filtered first as a no-op safety net — the backend
// query already excludes it outright, so this should never actually remove
// anything; it's here purely so this helper matches the full documented
// formula rather than relying on that upstream exclusion silently.
function computeExpectedTotal(entries: PendingActionEntry[]): number {
  return entries
    .filter(e => e.action_type !== 'Role aging alert')
    .filter(e => !(e.owner_type === 'HR / Recruiter' && e.sla_breach === true))
    .length;
}

test.describe('Pending Actions by Owner — regressions', () => {

  // ─── current_stage / sla_breach must be present on every row ──────────────
  // Historical gap: the pending_actions query used to select only pa.* — no
  // join onto applications at all — so there was no way for the frontend (or
  // the total_pending_actions formula itself, which depends on sla_breach) to
  // know an entry's live stage or SLA-breach state. Fixed by LEFT JOINing
  // applications for `a.stage AS current_stage` and `a.sla_breach AS
  // sla_breach`. Uses hasOwnProperty rather than truthy checks deliberately —
  // both are legitimately null for entries with no application_id (e.g. the
  // CTC-change trigger's 'Compensation change flag'), so a truthy check would
  // pass even if the LEFT JOIN / aliasing were removed entirely.
  test.describe('pending_actions rows carry current_stage and sla_breach keys from the applications LEFT JOIN', () => {

    test('every entry across pending_actions_by_owner has both keys, even when their value is null', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const { pending_actions_by_owner } = await res.json();

      const allEntries: PendingActionEntry[] = Object.values(pending_actions_by_owner).flat() as PendingActionEntry[];
      expect(allEntries.length).toBeGreaterThan(0);

      for (const entry of allEntries) {
        expect(Object.prototype.hasOwnProperty.call(entry, 'current_stage')).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(entry, 'sla_breach')).toBe(true);
      }
    });
  });

  // ─── 'Role aging alert' must never surface as a Pending Action ────────────
  // PRD-wise, role aging belongs to the dedicated Aging Roles box, not
  // Pending Actions — but 'Role aging alert' rows are owner_type 'Leadership
  // / Founders' (see checkRoleAging in slaChecker.ts) and share the same
  // pending_actions table as every other action type, so it's exactly the
  // kind of row that a missing/loosened WHERE clause would silently let leak
  // back into the Leadership card. The fix excludes
  // action_type <> 'Role aging alert' outright in the query, upstream of the
  // owner grouping.
  test.describe("'Role aging alert' is excluded from Pending Actions entirely", () => {

    test("pending_actions_by_owner['Leadership / Founders'] contains no 'Role aging alert' entries", async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const { pending_actions_by_owner } = await res.json();

      const leadershipEntries: PendingActionEntry[] = pending_actions_by_owner['Leadership / Founders'] || [];
      for (const entry of leadershipEntries) {
        expect(entry.action_type).not.toBe('Role aging alert');
      }
    });
  });

  // ─── total_pending_actions counter formula ─────────────────────────────────
  // Two rounds of bugs on the same counter this session:
  //   1st bug: the counter didn't account for SLA-breach-driven entries at
  //   all, so it double-counted against the separate SLA Breaches metric.
  //   2nd bug (the regression this test actually guards): the fix for #1
  //   excluded any entry with sla_breach=true regardless of owner_type — but
  //   sla_breach lives on the *application*, and Hiring-Manager-owned actions
  //   like 'Interview feedback due' fire off the exact same breached
  //   application HR/Recruiter actions do. Excluding by sla_breach alone
  //   wiped out nearly every real Hiring Manager pending action, incorrectly
  //   zeroing their card. The corrected formula only excludes an entry when
  //   BOTH owner_type === 'HR / Recruiter' AND sla_breach === true — every
  //   other owner_type counts an sla_breach=true entry normally. This test
  //   recomputes that exact formula from the response's own data and diffs
  //   it against the server's reported total, so if the exclusion is ever
  //   loosened back to "any sla_breach, any owner" this assertion mismatches.
  test.describe('total_pending_actions excludes SLA-breach entries only when owner_type is HR / Recruiter', () => {

    test('HR: metrics.total_pending_actions matches the owner-scoped exclusion formula computed from pending_actions_by_owner', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const { metrics, pending_actions_by_owner } = await res.json();

      const allEntries: PendingActionEntry[] = Object.values(pending_actions_by_owner).flat() as PendingActionEntry[];
      const expectedTotal = computeExpectedTotal(allEntries);

      expect(metrics.total_pending_actions).toBe(expectedTotal);

      // Sanity check that this test can actually fail: confirm there's at
      // least one Hiring-Manager-owned entry with sla_breach=true in the live
      // data, i.e. exactly the case the old (wrong) "exclude by sla_breach
      // regardless of owner" formula would have wrongly zeroed out. If this
      // ever stops being true (e.g. seed data changes), the assertion above
      // would still pass trivially either way, so this guards against the
      // test silently losing its teeth.
      const hmBreachedEntries = allEntries.filter(
        e => e.owner_type === 'Hiring Manager' && e.sla_breach === true
      );
      expect(hmBreachedEntries.length).toBeGreaterThan(0);
    });

    // Persona-scoped variant: for a hiring_manager persona, dashboard.ts
    // derives `pendingForUser` by filtering to owner_type === 'Hiring
    // Manager' *before* applying the same exclusion formula, so the counter
    // a Hiring Manager sees is restricted to their own actions only. Note:
    // pending_actions_by_owner itself (the full breakdown object) is built
    // from the unfiltered action list regardless of persona — only the
    // pendingForUser slice used for this one metric is persona-scoped — so
    // this test deliberately checks the counter against the persona's own
    // slice of the breakdown, not against the shape of the breakdown object
    // as a whole.
    test("hiring_manager persona: metrics.total_pending_actions matches the formula restricted to pending_actions_by_owner['Hiring Manager']", async ({ request }) => {
      const token = await getToken(request, 'hm_alex');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const { metrics, pending_actions_by_owner } = await res.json();

      // 'Hiring Manager' must be structurally reachable with real entries —
      // otherwise the formula-restricted comparison below would trivially
      // pass on an empty array and prove nothing.
      expect(Object.prototype.hasOwnProperty.call(pending_actions_by_owner, 'Hiring Manager')).toBe(true);
      const hmEntries: PendingActionEntry[] = pending_actions_by_owner['Hiring Manager'] || [];
      expect(Array.isArray(hmEntries)).toBe(true);
      expect(hmEntries.length).toBeGreaterThan(0);

      const expectedTotal = computeExpectedTotal(hmEntries);
      expect(metrics.total_pending_actions).toBe(expectedTotal);
    });
  });
});
