import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidate, SEEDED } from '../helpers/api';

// ─── Mandatory over-budget reason gate on POST /api/applications/:id/stage ────
// backend/src/routes/applications.ts, backed by backend/src/utils/budget.ts's
// isSeverelyOverBudget. A candidate 15%+ over the role's stated CTC band
// (OVER_BUDGET_TOLERANCE = 1.15, applied to the max number parsed out of the
// role's freeform ctc_band text) can't be moved to 'Interview Round 1' without an
// explicit, on-record reason — enforced server-side, not just as a frontend
// dropdown gate, since this route is the one place every shortlist path
// (single-row, bulk, either page) actually goes through.
//
// R006 (Senior Product Manager) is seeded with ctc_band '18-25 LPA', so its
// band max is 25 and the severely-over-budget threshold is 25 * 1.15 = 28.75.
test.describe('Budget exception gate — POST /api/applications/:id/stage to Interview Round 1', () => {

  // ─── Severely over budget, no reason supplied ──────────────────────────────
  test.describe('severely over budget (expected_ctc >= band max * 1.15) with no budget_exception_reason_cat', () => {

    test('400s with an error mentioning the 15% threshold, and does not advance the stage', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');

      // expected_ctc 35 vs band max 25 → 35 >= 28.75, well over the threshold.
      const { res } = await createCandidate(request, hrToken, {
        role_id: SEEDED.roles.senior_pm,
        expected_ctc: 35,
      });
      const { application } = await res.json();

      const stageRes = await authed(request, hrToken).post(
        `/api/applications/${application.id}/stage`,
        { new_stage: 'Interview Round 1' }
      );
      expect(stageRes.status()).toBe(400);
      const body = await stageRes.json();
      // Distinctive substring rather than the full message — robust to
      // copy tweaks, but still proves this is the budget gate and not some
      // other 400 (e.g. the pending-interview-feedback gate).
      expect(body.error).toContain('15%');
    });
  });

  // ─── Severely over budget, reason supplied ─────────────────────────────────
  test.describe('severely over budget WITH budget_exception_reason_cat supplied', () => {

    test('200s, the stage advances, and both reason fields persist verbatim on the application', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');

      const { res: createRes } = await createCandidate(request, hrToken, {
        role_id: SEEDED.roles.senior_pm,
        expected_ctc: 35,
      });
      const { application: created } = await createRes.json();

      const stageRes = await authed(request, hrToken).post(
        `/api/applications/${created.id}/stage`,
        {
          new_stage: 'Interview Round 1',
          budget_exception_reason_cat: 'Exceptional / rare skillset',
          budget_exception_reason_detail: 'Test detail',
        }
      );
      expect(stageRes.status()).toBe(200);

      const getRes = await authed(request, hrToken).get(`/api/applications/${created.id}`);
      expect(getRes.status()).toBe(200);
      const { application } = await getRes.json();
      expect(application.stage).toBe('Interview Round 1');
      expect(application.budget_exception_reason_cat).toBe('Exceptional / rare skillset');
      expect(application.budget_exception_reason_detail).toBe('Test detail');
    });
  });

  // ─── Not severely over budget — the critical non-regression guard ─────────
  // The gate must only fire when the candidate is actually 15%+ over — it
  // must never demand a reason from an ordinary, comfortably-in-band
  // candidate. This is the case a sloppy implementation (e.g. gating on ANY
  // amount over the band, matching the frontend's separate OverBudgetBadge
  // threshold rather than the stricter 1.15x one) would get wrong.
  test.describe('comfortably within budget (expected_ctc well under band max * 1.15)', () => {

    test('200s and advances to Interview Round 1 with no budget_exception_reason_cat required at all', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');

      // expected_ctc 20 vs band max 25 → 20 < 28.75, nowhere near the
      // severely-over-budget threshold (in fact under the band max itself).
      const { res: createRes } = await createCandidate(request, hrToken, {
        role_id: SEEDED.roles.senior_pm,
        expected_ctc: 20,
      });
      const { application: created } = await createRes.json();

      const stageRes = await authed(request, hrToken).post(
        `/api/applications/${created.id}/stage`,
        { new_stage: 'Interview Round 1' }
      );
      expect(stageRes.status()).toBe(200);

      const getRes = await authed(request, hrToken).get(`/api/applications/${created.id}`);
      expect(getRes.status()).toBe(200);
      const { application } = await getRes.json();
      expect(application.stage).toBe('Interview Round 1');
      expect(application.budget_exception_reason_cat).toBeFalsy();
    });
  });

  // ─── is_severely_over_budget must be present on every data source that ────
  // feeds a "shortlist this application" control. This is a regression guard
  // for a real bug: GET /api/candidates/:id has its own, separate
  // applications query (distinct from GET /api/applications and
  // GET /api/applications/:id) — it was missed on the first pass, so
  // CandidateDetail.tsx's Stage-change modal never saw the flag and the
  // mandatory-reason gate silently never triggered from that page.
  test.describe('is_severely_over_budget is present on every application data source', () => {

    test('GET /api/candidates/:id exposes is_severely_over_budget on its applications array', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');

      const { res: createRes } = await createCandidate(request, hrToken, {
        role_id: SEEDED.roles.senior_pm,
        expected_ctc: 35,
      });
      const { application, candidate } = await createRes.json();

      const getRes = await authed(request, hrToken).get(`/api/candidates/${candidate.id}`);
      expect(getRes.status()).toBe(200);
      const body = await getRes.json();
      const app = body.applications.find((a: { id: string }) => a.id === application.id);
      expect(app).toBeTruthy();
      expect(app.is_severely_over_budget).toBe(true);
    });
  });
});
