import { test, expect } from '@playwright/test';
import { getToken, authed } from '../helpers/api';

// Mirrors dashboard.ts's own STAGE_ORDER exactly (which itself is a
// duplicate of frontend/src/types/index.ts's STAGES — the backend has no
// shared copy of this list, see that file's comment). Used here only to
// validate velocity.tat_by_stage's canonical-name filter; nothing else in
// this file needs it.
const STAGE_ORDER = [
  'Applied', 'Resume Review', 'Shortlisted',
  'Interview Round 1', 'Interview Round 2', 'Assignment Round', 'Founders Round',
  'Reference Check', 'Pre-Joining Documents', 'Offer Discussion',
  'Offer Released', 'Offer Accepted', 'Joined',
];

// Sibling of 06-dashboard.spec.ts — that file already covers the Phase 1
// keys (metrics.*, open_roles_by_priority, pending_actions_by_owner shape,
// hiring_funnel, aging_roles). This file covers only what changed on top of
// that in a later batch: roles_by_status, rejected_by_stage, low_pipeline
// actually being exercised, the agency_performance module's removal, and
// the new velocity block. Nothing here re-asserts what 06 already checks.
test.describe('Dashboard API additions', () => {

  // ─── roles_by_status ───────────────────────────────────────────────────────
  // NEW top-level object: every role status roleStats saw, mapped to a
  // count — replaces the dashboard's old free-form role-Status filter with a
  // direct breakdown. roleStats' own WHERE clause excludes
  // 'Closed – Filled'/'Closed – Cancelled' outright, so this is never the
  // full status enum, only whatever's left open/in-progress.
  test.describe('roles_by_status', () => {

    test('is a non-empty object mapping every status seen to a positive integer count', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const { roles_by_status } = await res.json();

      expect(typeof roles_by_status).toBe('object');
      expect(roles_by_status).not.toBeNull();

      const entries = Object.entries(roles_by_status);
      expect(entries.length).toBeGreaterThan(0);

      for (const [status, count] of entries) {
        expect(typeof status).toBe('string');
        expect(typeof count).toBe('number');
        expect(Number.isInteger(count)).toBe(true);
        expect(count as number).toBeGreaterThan(0);
      }
    });

    // schema.sql's roles.status CHECK constraint spells this status with a
    // real en-dash (–, U+2013), not a hyphen-minus ('-', U+002D):
    // 'Live – Sourcing'. A naive ASCII-hyphen assumption anywhere in this
    // pipeline (ingestion, this endpoint's grouping, frontend matching)
    // would silently produce a key nothing else recognizes. This doesn't
    // require the status to be present in the live dataset right now — it
    // only pins the exact character down for the case where it is.
    test('the "Live – Sourcing" status key, if present, uses the real en-dash character', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { roles_by_status } = await (await authed(request, token).get('/api/dashboard')).json();

      const liveKey = Object.keys(roles_by_status).find(k => k.includes('Live'));
      if (liveKey) {
        expect(liveKey).toBe('Live – Sourcing');
      }
    });
  });

  // ─── rejected_by_stage ─────────────────────────────────────────────────────
  // NEW top-level object: stage -> count of applications with status
  // 'Rejected' currently frozen at that stage (stage never moves on
  // rejection — see dashboard.ts's own comment on the query). Legitimately
  // {} if the live dataset happens to have zero rejections right now, so
  // this only asserts shape, not non-emptiness.
  test.describe('rejected_by_stage', () => {

    test('maps stage -> positive integer count (shape-only; empty object is valid)', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const { rejected_by_stage } = await res.json();

      expect(typeof rejected_by_stage).toBe('object');
      expect(rejected_by_stage).not.toBeNull();

      for (const [stage, count] of Object.entries(rejected_by_stage)) {
        expect(typeof stage).toBe('string');
        expect(typeof count).toBe('number');
        expect(Number.isInteger(count)).toBe(true);
        expect(count as number).toBeGreaterThan(0);
      }
    });
  });

  // ─── low_pipeline ──────────────────────────────────────────────────────────
  // Not new this batch — it existed before — but is now actually rendered on
  // the frontend, which makes a shape regression here worth guarding. Built
  // from rolesWithAging.filter(active_count < 3 && aging_alert !== 'ok'), so
  // by construction every entry is 'yellow' or 'red', never 'ok'.
  test.describe('low_pipeline', () => {

    test('is an array; every entry has active_count < 3 and a non-"ok" aging_alert', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const { low_pipeline } = await res.json();

      expect(Array.isArray(low_pipeline)).toBe(true);
      for (const role of low_pipeline) {
        expect(typeof role.active_count).toBe('number');
        expect(role.active_count).toBeLessThan(3);
        expect(['yellow', 'red']).toContain(role.aging_alert);
      }
    });
  });

  // ─── agency_performance removal ────────────────────────────────────────────
  // The whole Agency Performance dashboard module was removed from this
  // endpoint's response in this batch. This is a real regression guard, not
  // a placeholder: removing a feature and having the key silently reappear
  // (a bad rebase/merge, or the removal getting reverted) is exactly the
  // kind of thing that should fail loudly rather than just going unnoticed
  // on the frontend.
  test.describe('agency_performance is fully removed', () => {

    test('the top-level agency_performance key no longer exists on the response', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const body = await res.json();

      expect(body).not.toHaveProperty('agency_performance');
    });
  });

  // ─── velocity ──────────────────────────────────────────────────────────────
  // NEW top-level object (Operational Velocity, items #10/#29): how far
  // through the pipeline applications get and how long each stage takes.
  // interviewed_count/offered_count are computed from CURRENT (possibly
  // rejection-frozen) stage against the fixed STAGE_ORDER index — a
  // candidate who interviewed and was later rejected still "reached
  // interview" for this ratio's purpose, which is why offered_count is
  // guaranteed <= interviewed_count by construction (Offer Released's index
  // is always >= Interview Round 1's).
  test.describe('velocity', () => {

    test('interview_to_offer_ratio / interviewed_count / offered_count: shape and the offered <= interviewed invariant', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const { velocity } = await res.json();

      expect(typeof velocity).toBe('object');
      expect(Number.isInteger(velocity.interviewed_count)).toBe(true);
      expect(Number.isInteger(velocity.offered_count)).toBe(true);
      expect(velocity.interviewed_count).toBeGreaterThanOrEqual(0);
      expect(velocity.offered_count).toBeGreaterThanOrEqual(0);

      // By construction: every application counted as "offered" (stage index
      // >= Offer Released) necessarily also cleared the earlier "interviewed"
      // threshold (stage index >= Interview Round 1).
      expect(velocity.offered_count).toBeLessThanOrEqual(velocity.interviewed_count);

      if (velocity.interviewed_count === 0) {
        // null, not 0 or NaN — dividing by zero interviewed candidates isn't
        // "a 0% ratio", it's "no ratio to report yet".
        expect(velocity.interview_to_offer_ratio).toBeNull();
      } else {
        expect(typeof velocity.interview_to_offer_ratio).toBe('number');
        // (offered/interviewed) * 100, rounded to 1 decimal — recomputed
        // independently from the two counts the response itself reported.
        const expectedRatio = Math.round((velocity.offered_count / velocity.interviewed_count) * 1000) / 10;
        expect(velocity.interview_to_offer_ratio).toBeCloseTo(expectedRatio, 5);
      }
    });

    test('tat_by_stage is sorted slowest-first and contains only canonical 13-stage names', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const { velocity } = await res.json();

      expect(Array.isArray(velocity.tat_by_stage)).toBe(true);

      for (const row of velocity.tat_by_stage) {
        // activity_log can carry 'Stage Changed' rows naming stages retired
        // in an earlier rework (e.g. a legacy 'Screening Call' stage) — the
        // backend filters those out before returning tat_by_stage, so
        // nothing here should ever be a name outside the current pipeline.
        expect(STAGE_ORDER).toContain(row.stage);
        expect(typeof row.avg_hours).toBe('number');
        expect(Number.isInteger(row.n)).toBe(true);
        expect(row.n).toBeGreaterThan(0);
      }

      if (velocity.tat_by_stage.length >= 2) {
        for (let i = 1; i < velocity.tat_by_stage.length; i++) {
          expect(velocity.tat_by_stage[i].avg_hours).toBeLessThanOrEqual(velocity.tat_by_stage[i - 1].avg_hours);
        }
      }
    });

    // biggest_drop_off is just the single highest-count entry of
    // rejected_by_stage, surfaced as one callout instead of making the
    // caller scan the whole map. Checking against the max count (rather than
    // a specific stage name) sidesteps any tie-break ordering question —
    // JS object key insertion order isn't a contract worth pinning here.
    test('biggest_drop_off is null iff rejected_by_stage is empty, and otherwise matches its max count', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const { velocity, rejected_by_stage } = await res.json();

      const counts: number[] = Object.values(rejected_by_stage) as number[];

      if (counts.length === 0) {
        expect(velocity.biggest_drop_off).toBeNull();
      } else {
        expect(velocity.biggest_drop_off).not.toBeNull();
        expect(typeof velocity.biggest_drop_off.stage).toBe('string');
        expect(rejected_by_stage).toHaveProperty(velocity.biggest_drop_off.stage);
        expect(velocity.biggest_drop_off.count).toBe(Math.max(...counts));
      }
    });
  });

  // ─── KPI redesign — new Active Candidates score buckets ────────────────────
  // strong_fit_candidates (>=70, one flat bucket) is retired outright in
  // favor of two exact thresholds (>=75 / <=45) the new KPI card shows side
  // by side. Not easily verified end-to-end without controlling exact
  // seeded scores, so these are light-touch sanity checks: each bucket is a
  // real subset of active_candidates, never negative, and the two buckets
  // (being non-overlapping — a score can't be both >=75 and <=45) never sum
  // to more than the whole.
  test.describe('metrics.candidates_score_ge_75 / candidates_score_le_45', () => {

    test('both are non-negative integers; neither exceeds active_candidates; the two never overlap-sum past it', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const { metrics } = await res.json();

      expect(Number.isInteger(metrics.candidates_score_ge_75)).toBe(true);
      expect(Number.isInteger(metrics.candidates_score_le_45)).toBe(true);
      expect(metrics.candidates_score_ge_75).toBeGreaterThanOrEqual(0);
      expect(metrics.candidates_score_le_45).toBeGreaterThanOrEqual(0);
      expect(metrics.active_candidates).toBeGreaterThanOrEqual(metrics.candidates_score_ge_75);
      expect(metrics.active_candidates).toBeGreaterThanOrEqual(metrics.candidates_score_le_45);
      expect(metrics.active_candidates).toBeGreaterThanOrEqual(
        metrics.candidates_score_ge_75 + metrics.candidates_score_le_45
      );
    });
  });

  // ─── KPI redesign — remaining Active Candidates / Open Roles / SLA sub-metrics
  test.describe('metrics — remaining KPI-card sub-metrics', () => {

    test('candidates_at_interview1_plus is a non-negative integer not exceeding active_candidates', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { metrics } = await (await authed(request, token).get('/api/dashboard')).json();
      expect(Number.isInteger(metrics.candidates_at_interview1_plus)).toBe(true);
      expect(metrics.candidates_at_interview1_plus).toBeGreaterThanOrEqual(0);
      expect(metrics.active_candidates).toBeGreaterThanOrEqual(metrics.candidates_at_interview1_plus);
    });

    test('candidates_unmatched is a non-negative integer', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { metrics } = await (await authed(request, token).get('/api/dashboard')).json();
      expect(Number.isInteger(metrics.candidates_unmatched)).toBe(true);
      expect(metrics.candidates_unmatched).toBeGreaterThanOrEqual(0);
    });

    test('avg_active_role_age_days is null or a non-negative number', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { metrics } = await (await authed(request, token).get('/api/dashboard')).json();
      expect(metrics.avg_active_role_age_days === null || metrics.avg_active_role_age_days >= 0).toBe(true);
    });

    test('avg_time_to_fill_days is null or a non-negative number', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { metrics } = await (await authed(request, token).get('/api/dashboard')).json();
      expect(metrics.avg_time_to_fill_days === null || metrics.avg_time_to_fill_days >= 0).toBe(true);
    });

    test('roles_filled_last_30d is a non-negative integer', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { metrics } = await (await authed(request, token).get('/api/dashboard')).json();
      expect(Number.isInteger(metrics.roles_filled_last_30d)).toBe(true);
      expect(metrics.roles_filled_last_30d).toBeGreaterThanOrEqual(0);
    });

    test('sla_breach_top_type / sla_breach_top_stage are null or { count > 0 }, consistent with sla_breach_total', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { metrics } = await (await authed(request, token).get('/api/dashboard')).json();
      if (metrics.sla_breach_total === 0) {
        expect(metrics.sla_breach_top_type).toBeNull();
        expect(metrics.sla_breach_top_stage).toBeNull();
      } else {
        expect(metrics.sla_breach_top_type.count).toBeGreaterThan(0);
        expect(metrics.sla_breach_top_type.count).toBeLessThanOrEqual(metrics.sla_breach_total);
        expect(metrics.sla_breach_top_stage.count).toBeGreaterThan(0);
        expect(metrics.sla_breach_top_stage.count).toBeLessThanOrEqual(metrics.sla_breach_total);
      }
    });
  });

  // ─── KPI redesign — Source Quality's new contribution_pct ──────────────────
  test.describe('source_quality contribution_pct', () => {

    test('every channel has a 0-100 contribution_pct, and they sum to ~100% across channels', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { source_quality } = await (await authed(request, token).get('/api/dashboard')).json();
      if (source_quality.length === 0) return; // nothing sourced in this filtered view

      for (const row of source_quality) {
        expect(row.contribution_pct).toBeGreaterThanOrEqual(0);
        expect(row.contribution_pct).toBeLessThanOrEqual(100);
      }
      const total = source_quality.reduce((sum: number, r: { contribution_pct: number }) => sum + r.contribution_pct, 0);
      expect(Math.abs(total - 100)).toBeLessThan(0.5); // rounding tolerance across channels
    });
  });
});
