import { test, expect } from '@playwright/test';
import { getToken, authed, SEEDED, uid } from '../helpers/api';

// Shape of one row in pending_actions_by_owner[...] as returned by
// GET /api/dashboard — current_stage/sla_breach come from the LEFT JOIN onto
// applications, so both are nullable (entries with no application_id, e.g.
// 'Role aging alert' historically, or the CTC-change trigger's action, have
// no linked application at all).
//
// role_id/responsible_person are real columns on pending_actions itself
// (pa.* — role_id lets a row with no application_id, like the CTC-change
// flag, still link back to a real role; responsible_person is a plain
// denormalized name). candidate_id/ai_fit_score are not pending_actions
// columns at all — they ride in on the same LEFT JOIN onto applications that
// current_stage/sla_breach already used, so they're nullable for exactly the
// same reason: no application_id, no join match, null across the board.
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
  role_id: string | null;
  responsible_person: string | null;
  candidate_id: string | null;
  ai_fit_score: number | null;
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
    // Manager' AND responsible_person matching the requesting HM's own name
    // (case/whitespace-insensitive) *before* applying the same exclusion
    // formula — this is the fix for a real bug where every Hiring Manager's
    // queue was pooled together regardless of who a pending action was
    // actually assigned to. pending_actions_by_owner itself (the full
    // breakdown object) is still built from the unfiltered action list
    // regardless of persona, so it can legitimately contain entries assigned
    // to OTHER hiring managers — this test filters hmEntries down to the
    // requesting HM's own name (fetched via /api/auth/me) before computing
    // the expected total, matching dashboard.ts's own scoping exactly.
    test("hiring_manager persona: metrics.total_pending_actions matches the formula restricted to pending_actions_by_owner['Hiring Manager']", async ({ request }) => {
      const token = await getToken(request, 'hm_alex');
      const client = authed(request, token);
      const meRes = await client.get('/api/auth/me');
      expect(meRes.status()).toBe(200);
      const { user } = await meRes.json();
      const myName = String(user.name).trim().toLowerCase();

      const res   = await client.get('/api/dashboard');
      expect(res.status()).toBe(200);
      const { metrics, pending_actions_by_owner } = await res.json();

      // 'Hiring Manager' must be structurally reachable with real entries —
      // otherwise the formula-restricted comparison below would trivially
      // pass on an empty array and prove nothing.
      expect(Object.prototype.hasOwnProperty.call(pending_actions_by_owner, 'Hiring Manager')).toBe(true);
      const hmEntries: PendingActionEntry[] = (pending_actions_by_owner['Hiring Manager'] || []).filter(
        (e: PendingActionEntry) => !!e.responsible_person && e.responsible_person.trim().toLowerCase() === myName
      );
      expect(Array.isArray(hmEntries)).toBe(true);
      expect(hmEntries.length).toBeGreaterThan(0);

      const expectedTotal = computeExpectedTotal(hmEntries);
      expect(metrics.total_pending_actions).toBe(expectedTotal);
    });
  });

  // ─── role_id / responsible_person / candidate_id / ai_fit_score must be present on every row ──
  // Same shape of gap as current_stage/sla_breach above, hit again this batch:
  // role_id and responsible_person were just added as real columns on
  // pending_actions itself (role_id specifically so a row with no
  // application_id — the CTC-change trigger's 'Compensation change flag' —
  // can still be linked back to a real role instead of only carrying a
  // denormalized role_title string nobody can join on). candidate_id and
  // ai_fit_score ride in on the pre-existing LEFT JOIN onto applications
  // (the same join current_stage/sla_breach already used), added so the
  // frontend can deep-link a Pending Action row straight to the candidate
  // and show their fit score without a second round-trip. hasOwnProperty is
  // used deliberately, not a truthy check — all four are legitimately null
  // for entries with no application_id (e.g. Compensation change flag has
  // no candidate_id/ai_fit_score since it isn't tied to an application at
  // all, and role_id/responsible_person can independently be null on other
  // action types that never populate them) — a truthy check would pass even
  // if the columns/join were dropped entirely.
  test.describe('pending_actions rows carry role_id, responsible_person, candidate_id, and ai_fit_score', () => {

    test('every entry across pending_actions_by_owner has all four keys, even when their value is null', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const { pending_actions_by_owner } = await res.json();

      const allEntries: PendingActionEntry[] = Object.values(pending_actions_by_owner).flat() as PendingActionEntry[];
      expect(allEntries.length).toBeGreaterThan(0);

      for (const entry of allEntries) {
        expect(Object.prototype.hasOwnProperty.call(entry, 'role_id')).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(entry, 'responsible_person')).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(entry, 'candidate_id')).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(entry, 'ai_fit_score')).toBe(true);
      }
    });
  });

  // ─── Hiring Manager column is sorted by ai_fit_score, highest first ───────
  // dashboard.ts re-sorts pending_actions_by_owner['Hiring Manager']
  // specifically (every other owner column keeps the query's default
  // priority_level DESC, created_at ASC order) so an HM sees their
  // strongest candidates at the top of an overdue list, not whatever order
  // SLA breaches happened to fire in. The comparator is
  // `(b.ai_fit_score ?? -1) - (a.ai_fit_score ?? -1)` — an entry with no
  // score at all (e.g. Compensation change flag, which isn't tied to an
  // application) is treated as -1 so it sorts to the bottom rather than
  // floating to the top ahead of every real scored candidate.
  test.describe("pending_actions_by_owner['Hiring Manager'] is sorted by ai_fit_score descending", () => {

    test("entries are non-increasing by ai_fit_score, with null/missing scores treated as -1 and sorted last", async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const { pending_actions_by_owner } = await res.json();

      const hmEntries: PendingActionEntry[] = pending_actions_by_owner['Hiring Manager'] || [];
      // Needs real data to actually exercise the ordering — an empty or
      // single-element array would make the pairwise check below pass
      // trivially without proving anything.
      expect(hmEntries.length).toBeGreaterThan(0);

      const effectiveScore = (e: PendingActionEntry) =>
        e.ai_fit_score === null || e.ai_fit_score === undefined ? -1 : e.ai_fit_score;

      for (let i = 0; i < hmEntries.length - 1; i++) {
        expect(effectiveScore(hmEntries[i])).toBeGreaterThanOrEqual(effectiveScore(hmEntries[i + 1]));
      }
    });
  });

  // ─── Compensation change flag now links back to the actual role ──────────
  // flag_ctc_change()'s pending_actions INSERT used to write only
  // role_title — a denormalized text snapshot with no FK, so there was no
  // way to deep-link the Leadership card's row back to the role it actually
  // describes (and nothing to join on if the role were later renamed).
  // The trigger now also writes role_id. This test fires the trigger for
  // real (PATCH a seeded role's ctc_band, which the trigger's
  // `OLD.ctc_band IS DISTINCT FROM NEW.ctc_band` guard is watching) and
  // confirms the resulting row carries both the new role_id column and the
  // expected old→new description text. Matches on the uid()-suffixed
  // ctc_band value baked into the description rather than on role_title
  // alone, since a role this old realistically has several historical
  // Compensation change flag rows already sitting unresolved in local data.
  test.describe('Compensation change flag pending_actions row carries role_id', () => {

    test("PATCHing a seeded role's ctc_band fires flag_ctc_change() and the resulting entry has role_id set to that role's id", async ({ request }) => {
      const token = await getToken(request, 'hr');

      const roleId = SEEDED.roles.backend_dev;
      const roleRes = await authed(request, token).get(`/api/roles/${roleId}`);
      expect(roleRes.status()).toBe(200);
      const { role } = await roleRes.json();

      const newCtcBand = `${uid()}-99 LPA`;
      const patchRes = await authed(request, token).patch(`/api/roles/${roleId}`, { ctc_band: newCtcBand });
      expect(patchRes.status()).toBe(200);

      const dashRes = await authed(request, token).get('/api/dashboard');
      expect(dashRes.status()).toBe(200);
      const { pending_actions_by_owner } = await dashRes.json();

      const leadershipEntries: PendingActionEntry[] = pending_actions_by_owner['Leadership / Founders'] || [];
      const flagEntry = leadershipEntries.find(
        e => e.action_type === 'Compensation change flag' && e.description.includes(newCtcBand)
      );

      expect(flagEntry).toBeTruthy();
      expect(flagEntry!.role_id).toBe(role.id);
      expect(flagEntry!.role_title).toBe(role.title);
    });
  });
});
