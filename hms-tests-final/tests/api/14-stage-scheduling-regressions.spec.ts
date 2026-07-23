import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidateWithApp, SEEDED } from '../helpers/api';

test.describe('Stage-Driven Round Scheduling — Regression Guards', () => {

  // ─── Round scheduling must not touch application.stage ────────────────────
  // Historical bug: POST /api/interviews used to auto-advance an
  // application's stage as a side effect, matched off the round's free-text
  // round_name. That's fundamentally incompatible with the fixed 13-stage
  // pipeline model (Applied → ... → Joined) — a recruiter could type any
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
  // the 13-stage pipeline rework silently breaks that startsWith match unless
  // 'Founders Round' gets its own explicit branch — without it, this stage
  // would quietly fall through to the 72-hour IDLE default instead of the
  // 24-hour interview-feedback SLA every other interview stage gets.
  test.describe('Founders Round gets the 24-hour interview-feedback SLA', () => {

    test('sla_hours is 24, not the 72-hour idle default', async ({ request }) => {
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
      expect(fetched.sla_hours).toBe(24);
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
});
