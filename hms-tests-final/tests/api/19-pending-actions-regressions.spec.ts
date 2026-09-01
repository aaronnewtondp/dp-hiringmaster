// ─────────────────────────────────────────────────────────────────────────────
// SLA breach engine — stage/breach-type table regressions.
//
// Replaces the old flat "Pending Actions by Owner" model (one generic
// idle-stage check per stage, one owner per stage) with a per-stage,
// per-breach-type table: several stages now carry two distinct breach types
// (an HR-owned "not yet actioned" gap and an HM-owned "feedback due" gap).
// The "Resume Shortlist Pending" breach (HM-owned, not HR) now fires at
// 'Applied and Screened' itself — its original home was the since-retired
// 'Resume Review' stage, retargeted straight to 'Applied' (later renamed
// to 'Applied and Screened' — same first stage, same semantics) when that
// stage was removed (see STAGE_ORDER) — and the whole "Pending Actions by
// Owner" board was replaced by the
// hiring_funnel_snapshot section (stage → breach_types → candidates) plus a
// single merged sla_breach_total/sla_breach_by_owner KPI.
//
// Uses a direct Postgres connection (same precedent as
// 03-dashboard-audit-fixes.spec.ts) to backdate stage_entry_time/
// scheduled_date/assignment_send_date rather than waiting out real
// 48h/96h windows, and POST /api/cron/sla-check to run the engine on demand.
//
// INTENTIONALLY LOCAL-ONLY: hardcoded local-dev credentials, deliberately
// excluded from test:prod.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed, createCandidateWithApp, CRON_SECRET } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';

type SnapshotCandidate = {
  application_id: string; candidate_id: string | null; candidate_name: string;
  role_id: string | null; role_title: string; owner: string; stage: string; overdue_hours: number;
};
type BreachType = { type: string; owner: string; count: number; candidates: SnapshotCandidate[] };
type SnapshotStage = { stage: string; total: number; breach_types: BreachType[] };

test.describe('SLA breach engine — stage/breach-type table regressions', () => {
  let client: Client;

  test.beforeAll(async () => {
    client = new Client({ connectionString: LOCAL_DB_URL });
    await client.connect();
  });

  test.afterAll(async () => {
    await client.end();
  });

  async function runCronSlaCheck(request: Parameters<typeof authed>[0]) {
    const res = await authed(request, CRON_SECRET).post('/api/cron/sla-check', {});
    expect(res.status()).toBe(200);
  }

  async function getSnapshot(request: Parameters<typeof authed>[0], hrToken: string): Promise<SnapshotStage[]> {
    const { hiring_funnel_snapshot } = await (await authed(request, hrToken).get('/api/dashboard')).json();
    return hiring_funnel_snapshot;
  }

  function findCandidate(snapshot: SnapshotStage[], stage: string, appId: string) {
    const s = snapshot.find(x => x.stage === stage);
    return s?.breach_types.flatMap(bt => bt.candidates.map(c => ({ ...c, type: bt.type }))).find(c => c.application_id === appId);
  }

  // ─── Structural shape ───────────────────────────────────────────────────────
  test.describe('hiring_funnel_snapshot shape', () => {
    test('every candidate entry carries application_id, candidate_id, candidate_name, role_id, role_title, owner, stage, overdue_hours', async ({ request }) => {
      // GET /api/dashboard opportunistically runs the full runSlaCheck()
      // sweep (dashboard.ts's maybeRunSlaCheck, throttled to once per 3
      // minutes per instance — see CLAUDE.md's "compute-on-read, not cron"
      // note) whenever this is the first dashboard load outside that
      // window. Against this suite's large, long-accumulated local dataset
      // that sweep alone has been observed taking 25-30s — right at (or
      // over) Playwright's 30s default — so give this generous headroom
      // rather than risk a flaky timeout depending on suite/test ordering.
      test.setTimeout(60_000);
      const hrToken = await getToken(request, 'hr');
      const snapshot = await getSnapshot(request, hrToken);
      const allCandidates = snapshot.flatMap(s => s.breach_types.flatMap(bt => bt.candidates));
      expect(allCandidates.length).toBeGreaterThan(0);
      for (const c of allCandidates) {
        expect(typeof c.application_id).toBe('string');
        expect(typeof c.candidate_name).toBe('string');
        expect(typeof c.role_title).toBe('string');
        expect(typeof c.owner).toBe('string');
        expect(typeof c.stage).toBe('string');
        expect(typeof c.overdue_hours).not.toBe('undefined');
      }
    });

    test('every breach_type count matches its own candidates array length', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const snapshot = await getSnapshot(request, hrToken);
      for (const stage of snapshot) {
        for (const bt of stage.breach_types) {
          expect(bt.count).toBe(bt.candidates.length);
        }
      }
    });

    test('a stage never mixes "Idle Candidate" with any other breach type — the catch-all only ever appears alone', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const snapshot = await getSnapshot(request, hrToken);
      for (const stage of snapshot) {
        const types = stage.breach_types.map(bt => bt.type);
        if (types.includes('Idle Candidate')) {
          expect(types.length).toBe(1);
        }
      }
    });
  });

  // ─── Ownership per breach type ──────────────────────────────────────────────
  test.describe('breach ownership matches the new stage/breach-type table', () => {
    test('Applied and Screened breaches ("Resume Shortlist Pending") are Hiring-Manager-owned, not HR', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const { application } = await createCandidateWithApp(request, hrToken, 'R006');
      // Every new application already starts at 'Applied and Screened' — no
      // explicit transition needed. 'Resume Review' was retired as a stage;
      // this breach now fires directly at 'Applied and Screened' (renamed
      // from plain 'Applied' — see slaChecker.ts's FLAT_STAGE_BREACHES).
      await client.query(`UPDATE applications SET stage_entry_time = NOW() - INTERVAL '50 hours' WHERE id = $1`, [application.id]);
      await runCronSlaCheck(request);

      const snapshot = await getSnapshot(request, hrToken);
      const found = findCandidate(snapshot, 'Applied and Screened', application.id);
      expect(found?.type).toBe('Resume Shortlist Pending');
      expect(found?.owner).toBe('Hiring Manager');
    });

    test('Assignment Round can carry both an HR-owned "Assignment Not Sent" and an HM-owned "Assignment Feedback Due" breach simultaneously, for different candidates', async ({ request }) => {
      // Two candidate creations below each trigger a real, synchronous
      // ResumeIQ scoring call now (runResumeIQScoring at creation time),
      // which didn't exist when this test was written against Playwright's
      // 30s default.
      test.setTimeout(60_000);
      const hrToken = await getToken(request, 'hr');
      const api = authed(request, hrToken);

      // Candidate A: no assignment ever sent.
      const a = await createCandidateWithApp(request, hrToken, 'R006');
      await api.post(`/api/applications/${a.application.id}/stage`, { new_stage: 'Assignment Round', skip_reason: 'test setup' });
      await client.query(`UPDATE applications SET stage_entry_time = NOW() - INTERVAL '50 hours' WHERE id = $1`, [a.application.id]);

      // Candidate B: assignment sent 100h ago, feedback not yet submitted.
      const b = await createCandidateWithApp(request, hrToken, 'R006');
      await api.post(`/api/applications/${b.application.id}/stage`, { new_stage: 'Assignment Round', skip_reason: 'test setup' });
      const roundRes = await api.post('/api/interviews', {
        application_id: b.application.id, round_name: 'Assignment Round', round_type: 'Assignment',
        mail_body_content: 'test', assignment_link: 'https://example.com/assignment',
      });
      expect(roundRes.status()).toBe(201);
      const roundId = (await roundRes.json()).round.id;
      await client.query(
        `UPDATE interview_rounds SET assignment_send_date = NOW() - INTERVAL '100 hours' WHERE id = $1`,
        [roundId]
      );

      await runCronSlaCheck(request);

      const snapshot = await getSnapshot(request, hrToken);
      const foundA = findCandidate(snapshot, 'Assignment Round', a.application.id);
      const foundB = findCandidate(snapshot, 'Assignment Round', b.application.id);
      expect(foundA?.type).toBe('Assignment Not Sent');
      expect(foundA?.owner).toBe('HR / Recruiter');
      expect(foundB?.type).toBe('Assignment Feedback Due');
      expect(foundB?.owner).toBe('Hiring Manager');
    });
  });

  // ─── Resolution on the moment the underlying condition changes ─────────────
  test.describe('breaches resolve immediately when actioned, not just on the next SLA-check pass', () => {
    test('"Interview 1 Not Scheduled" resolves the instant a Standard round is scheduled', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const api = authed(request, hrToken);
      const { application } = await createCandidateWithApp(request, hrToken, 'R006');
      await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 1', skip_reason: 'test setup' });
      await client.query(`UPDATE applications SET stage_entry_time = NOW() - INTERVAL '50 hours' WHERE id = $1`, [application.id]);
      await runCronSlaCheck(request);

      let snapshot = await getSnapshot(request, hrToken);
      expect(findCandidate(snapshot, 'Interview Round 1', application.id)?.type).toBe('Interview 1 Not Scheduled');

      const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const roundRes = await api.post('/api/interviews', {
        application_id: application.id, round_name: 'Interview Round 1', round_type: 'Standard',
        scheduled_date: future, interviewer_emails: ['someone@digitalpaani.com'],
      });
      expect(roundRes.status()).toBe(201);

      snapshot = await getSnapshot(request, hrToken);
      expect(findCandidate(snapshot, 'Interview Round 1', application.id)).toBeUndefined();

      const appRes = await api.get(`/api/applications/${application.id}`);
      expect((await appRes.json()).application.sla_breach).toBe(false);
    });

    test('"Interview 1 Feedback Due" fires 48h after a past scheduled_date and resolves the instant feedback is submitted', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const api = authed(request, hrToken);
      const { application } = await createCandidateWithApp(request, hrToken, 'R006');
      await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 1', skip_reason: 'test setup' });

      const past = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
      const roundRes = await api.post('/api/interviews', {
        application_id: application.id, round_name: 'Interview Round 1', round_type: 'Standard',
        scheduled_date: past, interviewer_emails: ['someone@digitalpaani.com'],
      });
      const roundId = (await roundRes.json()).round.id;
      await runCronSlaCheck(request);

      let snapshot = await getSnapshot(request, hrToken);
      const found = findCandidate(snapshot, 'Interview Round 1', application.id);
      expect(found?.type).toBe('Interview 1 Feedback Due');
      expect(found?.owner).toBe('Hiring Manager');
      // 72h scheduled - 48h threshold = ~24h overdue. Postgres returns
      // numeric/decimal columns as strings via node-postgres — coerce first.
      expect(Number(found!.overdue_hours)).toBeGreaterThan(20);
      expect(Number(found!.overdue_hours)).toBeLessThan(28);

      const fbRes = await api.patch(`/api/interviews/${roundId}/feedback`, {
        eval_areas_assessed: ['Communication'], scores_per_area: { Communication: 4 },
        confidence_level: 'High', overall_assessment: 'Positive', round_recommendation: 'Proceed',
      });
      expect(fbRes.status()).toBe(200);

      snapshot = await getSnapshot(request, hrToken);
      expect(findCandidate(snapshot, 'Interview Round 1', application.id)).toBeUndefined();
    });
  });

  // ─── Status filtering ───────────────────────────────────────────────────────
  test.describe('breaches are never calculated for a non-Active application', () => {
    test('a candidate rejected while overdue never appears in hiring_funnel_snapshot', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const api = authed(request, hrToken);
      const { application } = await createCandidateWithApp(request, hrToken, 'R006');
      // Already sitting at 'Applied and Screened' from creation — no
      // transition needed ('Resume Review' was retired as a stage).
      await client.query(`UPDATE applications SET stage_entry_time = NOW() - INTERVAL '60 hours' WHERE id = $1`, [application.id]);

      const statusRes = await api.post(`/api/applications/${application.id}/status`, {
        new_status: 'Rejected', rejection_reason_cat: 'Missing mandatory skill',
      });
      expect(statusRes.status()).toBe(200);
      await runCronSlaCheck(request);

      const snapshot = await getSnapshot(request, hrToken);
      expect(findCandidate(snapshot, 'Applied and Screened', application.id)).toBeUndefined();
    });
  });

  // ─── Merged KPI card ─────────────────────────────────────────────────────────
  test.describe('sla_breach_total / sla_breach_by_owner', () => {
    test('HR sees the company-wide total; a Hiring Manager sees only their own scoped total', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const hmToken = await getToken(request, 'hm_alex');

      const { metrics: hrMetrics } = await (await authed(request, hrToken).get('/api/dashboard')).json();
      const { metrics: hmMetrics } = await (await authed(request, hmToken).get('/api/dashboard')).json();

      expect(hrMetrics.sla_breach_total).toBe(
        hrMetrics.sla_breach_by_owner['HR / Recruiter'] + hrMetrics.sla_breach_by_owner['Hiring Manager']
      );
      // The HM-scoped total is a Hiring-Manager-only, name-matched subset of
      // the company-wide Hiring Manager count — never larger than it, and
      // HR / Recruiter is always excluded entirely from an HM's own number.
      expect(hmMetrics.sla_breach_by_owner['HR / Recruiter']).toBe(0);
      expect(hmMetrics.sla_breach_total).toBeLessThanOrEqual(hrMetrics.sla_breach_by_owner['Hiring Manager']);
    });
  });
});
