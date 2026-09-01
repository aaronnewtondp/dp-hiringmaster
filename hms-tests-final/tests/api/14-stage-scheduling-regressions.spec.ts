import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidateWithApp, SEEDED } from '../helpers/api';

test.describe('Stage-Driven Round Scheduling — Regression Guards', () => {

  // ─── Round scheduling must not touch application.stage ────────────────────
  // Historical bug: POST /api/interviews used to auto-advance an
  // application's stage as a side effect, matched off the round's free-text
  // round_name. That's fundamentally incompatible with the fixed 11-stage
  // pipeline model (Applied and Screened → ... → Joined) — a recruiter could type any
  // round_name they wanted, so "advancing" the stage off it was never a
  // reliable signal. The auto-advance was removed; stage is now owned
  // exclusively by POST /api/applications/:id/stage. This guards against a
  // regression where scheduling silently moves stage/stage_entry_time again.
  test.describe('Scheduling a round does not change the application stage', () => {

    test('stage and stage_entry_time are untouched by POST /api/interviews', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { application } = await createCandidateWithApp(request, token);

      const stageRes = await authed(request, token).post(`/api/applications/${application.id}/stage`, {
        new_stage: 'Interview Round 1',
      });
      expect(stageRes.status()).toBe(200);

      const beforeRes = await authed(request, token).get(`/api/applications/${application.id}`);
      expect(beforeRes.status()).toBe(200);
      const { application: before } = await beforeRes.json();
      expect(before.stage).toBe('Interview Round 1');
      const stageEntryTimeBefore = before.stage_entry_time;

      // round_name is deliberately unrelated text — if stage were still being
      // derived from it, this would surface immediately.
      const interviewRes = await authed(request, token).post('/api/interviews', {
        application_id: application.id,
        round_name: 'Technical Deep-Dive',
        round_number: 1,
      });
      expect(interviewRes.status()).toBe(201);

      const afterRes = await authed(request, token).get(`/api/applications/${application.id}`);
      expect(afterRes.status()).toBe(200);
      const { application: after } = await afterRes.json();
      expect(after.stage).toBe('Interview Round 1');
      expect(after.stage_entry_time).toBe(stageEntryTimeBefore);
    });
  });

  // ─── Founders Round SLA ─────────────────────────────────────────────────────
  // Historical bug risk: the old third interview stage was literally named
  // 'Interview – Round 3', so getSlaHours()'s stage.startsWith('Interview')
  // check caught it "for free". Renaming it to 'Founders Round' as part of
  // the 11-stage pipeline rework silently breaks that startsWith match unless
  // 'Founders Round' gets its own explicit branch — without it, this stage
  // would quietly fall through to the 72-hour IDLE default instead of the
  // interview-feedback SLA every other interview stage gets (48h — every
  // 24h SLA threshold was widened to 48h; see SLA_HOURS in types/index.ts).
  test.describe('Founders Round gets the interview-feedback SLA', () => {

    test('sla_hours is 48, not the 72-hour idle default', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { application } = await createCandidateWithApp(request, token);

      const stageRes = await authed(request, token).post(`/api/applications/${application.id}/stage`, {
        new_stage: 'Founders Round',
      });
      expect(stageRes.status()).toBe(200);

      const getRes = await authed(request, token).get(`/api/applications/${application.id}`);
      expect(getRes.status()).toBe(200);
      const { application: fetched } = await getRes.json();
      expect(fetched.stage).toBe('Founders Round');
      expect(fetched.sla_hours).toBe(48);
    });
  });

  // ─── Role shortlisted_count ─────────────────────────────────────────────────
  // Historical bug: the shortlisted_count subquery on GET /api/roles listed
  // stage names that never actually existed in the real pipeline
  // ('Interview – Round 3', 'Interview – Round 4') — presumably aspirational
  // or copy-pasted from an earlier design. Any application that had actually
  // progressed into those later interview stages was silently excluded from
  // the count. Uses a before/after delta (not an absolute value) since other
  // tests in this suite may also create applications against the same seeded
  // role.
  test.describe("Role's shortlisted_count includes Founders Round applications", () => {

    test('creating and advancing an application to Founders Round increases shortlisted_count by 1', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const roleId = SEEDED.roles.qa_eng;

      const rolesBeforeRes = await authed(request, token).get('/api/roles');
      expect(rolesBeforeRes.status()).toBe(200);
      const { roles: rolesBefore } = await rolesBeforeRes.json();
      const roleBefore = rolesBefore.find((r: { id: string }) => r.id === roleId);
      expect(roleBefore).toBeTruthy();
      const countBefore = Number(roleBefore.shortlisted_count);

      const { application } = await createCandidateWithApp(request, token, roleId);
      const stageRes = await authed(request, token).post(`/api/applications/${application.id}/stage`, {
        new_stage: 'Founders Round',
      });
      expect(stageRes.status()).toBe(200);

      const rolesAfterRes = await authed(request, token).get('/api/roles');
      expect(rolesAfterRes.status()).toBe(200);
      const { roles: rolesAfter } = await rolesAfterRes.json();
      const roleAfter = rolesAfter.find((r: { id: string }) => r.id === roleId);
      expect(roleAfter).toBeTruthy();
      const countAfter = Number(roleAfter.shortlisted_count);

      expect(countAfter).toBe(countBefore + 1);
    });
  });

  // ─── SLA_HOURS widening (24h → 48h) ─────────────────────────────────────────
  // Every getSlaHours() branch that used to return 24 was widened to 48 in one
  // batch change to SLA_HOURS (types/index.ts): RESUME_REVIEW_HIGH_FIT,
  // RESUME_REVIEW_NORMAL, REF_INIT, OFFER_RELEASE, and INTERVIEW_FEEDBACK.
  // HM_SHORTLIST is now an orphaned constant — the 'Shortlisted' stage it
  // used to key off was retired outright (see STAGE_ORDER), and
  // getSlaHours() has no branch left that references it — so it's
  // deliberately not covered here. 'Founders Round' is already covered by
  // the dedicated describe block above (it needed its own explicit branch after a rename
  // broke its startsWith('Interview') match). These three cover the
  // remaining branches that would otherwise silently stay at 24h — or fall
  // through to the 72h IDLE default — if the widening were ever reverted for
  // just one stage.
  test.describe('SLA thresholds widened from 24h to 48h', () => {

    test('Reference Check: sla_hours is 48', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { application } = await createCandidateWithApp(request, token);

      const stageRes = await authed(request, token).post(`/api/applications/${application.id}/stage`, {
        new_stage: 'Reference Check',
      });
      expect(stageRes.status()).toBe(200);

      const getRes = await authed(request, token).get(`/api/applications/${application.id}`);
      expect(getRes.status()).toBe(200);
      const { application: fetched } = await getRes.json();
      expect(fetched.stage).toBe('Reference Check');
      expect(fetched.sla_hours).toBe(48);
    });

    test('Offer Released: sla_hours is 48', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { application } = await createCandidateWithApp(request, token);

      const stageRes = await authed(request, token).post(`/api/applications/${application.id}/stage`, {
        new_stage: 'Offer Released',
      });
      expect(stageRes.status()).toBe(200);

      const getRes = await authed(request, token).get(`/api/applications/${application.id}`);
      expect(getRes.status()).toBe(200);
      const { application: fetched } = await getRes.json();
      expect(fetched.stage).toBe('Offer Released');
      expect(fetched.sla_hours).toBe(48);
    });

    test("Interview Round 1 (representative startsWith('Interview') case): sla_hours is 48", async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { application } = await createCandidateWithApp(request, token);

      const stageRes = await authed(request, token).post(`/api/applications/${application.id}/stage`, {
        new_stage: 'Interview Round 1',
      });
      expect(stageRes.status()).toBe(200);

      const getRes = await authed(request, token).get(`/api/applications/${application.id}`);
      expect(getRes.status()).toBe(200);
      const { application: fetched } = await getRes.json();
      expect(fetched.stage).toBe('Interview Round 1');
      expect(fetched.sla_hours).toBe(48);
    });
  });

  // ─── offer_sent_date / offer_accepted_date stamping ─────────────────────────
  // Historical bug: neither column was ever written by the stage-transition
  // route, despite the dashboard's Time to Fill metric being a literal
  // AVG(offer_accepted_date - role.start_date) — every accepted offer had a
  // NULL offer_accepted_date (and every released offer a NULL
  // offer_sent_date) no matter how far the application had actually
  // progressed. Fixed by conditionally appending ', offer_sent_date=NOW()' /
  // ', offer_accepted_date=NOW()' onto the same stage-transition UPDATE,
  // keyed off new_stage. The fix is additive per-transition — each date is
  // only written on the one transition that matches it, never COALESCE'd or
  // reapplied on other transitions — so advancing an application further
  // afterward must never clobber a date a previous transition already set.
  // That's the actual regression this guards: not just "the column gets
  // stamped", but "stamping one date doesn't touch the other."
  //
  // Both columns are `DATE`, not `TIMESTAMP` (schema.sql, matches
  // role.start_date — also DATE, since Time to Fill is a plain
  // DATE-minus-DATE day count), so NOW() is implicitly cast down to the
  // current UTC calendar day on write; time-of-day is not preserved. The
  // "recency" check below is asserted at day granularity for that reason,
  // not to the minute/second.
  test.describe('Stage transitions stamp offer_sent_date / offer_accepted_date', () => {

    test('Offer Released stamps offer_sent_date; a later Offer Accepted stamps offer_accepted_date without disturbing offer_sent_date', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { application } = await createCandidateWithApp(request, token);

      const todayUtc = new Date().toISOString().slice(0, 10);

      const releaseRes = await authed(request, token).post(`/api/applications/${application.id}/stage`, {
        new_stage: 'Offer Released',
      });
      expect(releaseRes.status()).toBe(200);

      const afterReleaseRes = await authed(request, token).get(`/api/applications/${application.id}`);
      expect(afterReleaseRes.status()).toBe(200);
      const { application: afterRelease } = await afterReleaseRes.json();

      expect(afterRelease.stage).toBe('Offer Released');
      expect(afterRelease.offer_sent_date).toBeTruthy();
      expect(afterRelease.offer_accepted_date).toBeFalsy();
      expect(new Date(afterRelease.offer_sent_date).toISOString().slice(0, 10)).toBe(todayUtc);

      const acceptRes = await authed(request, token).post(`/api/applications/${application.id}/stage`, {
        new_stage: 'Offer Accepted',
      });
      expect(acceptRes.status()).toBe(200);

      const afterAcceptRes = await authed(request, token).get(`/api/applications/${application.id}`);
      expect(afterAcceptRes.status()).toBe(200);
      const { application: afterAccept } = await afterAcceptRes.json();

      expect(afterAccept.stage).toBe('Offer Accepted');
      expect(afterAccept.offer_accepted_date).toBeTruthy();
      expect(new Date(afterAccept.offer_accepted_date).toISOString().slice(0, 10)).toBe(todayUtc);

      // The actual regression guard: offer_sent_date stamped by the FIRST
      // transition must be unchanged by the SECOND transition. A naive fix
      // (e.g. unconditionally stamping both columns on every stage change, or
      // COALESCE-ing in a way that still re-evaluates NOW()) would silently
      // overwrite it here instead of leaving the earlier value alone.
      expect(afterAccept.offer_sent_date).toBe(afterRelease.offer_sent_date);
    });
  });
});
