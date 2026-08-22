import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidateWithApp, uid, SEEDED } from '../helpers/api';

// GET /api/applications/:id/comp-benchmark — item #26's per-application comp
// benchmarking. Distinct from the pre-existing GET /api/comp-benchmarks
// (plural, raw benchmark-table listing, tested elsewhere): this endpoint
// resolves ONE application's likely comp range by first checking whether
// DigitalPaani already has an internal comp_benchmarks row grounded to the
// application's exact role title, and only falling back to a live Claude
// call for a market estimate when no such row exists. See compBenchmark.ts
// — the grounding-first ordering there is explicit, confirmed for item #26,
// not just an implementation detail this suite happens to observe.
test.describe('GET /api/applications/:id/comp-benchmark', () => {

  // ─── Grounding-first: an internal comp_benchmarks row wins, no AI call ─────
  // seed.sql ships BEN003 with role_category='Senior Product Manager' (an
  // EXACT match against SEEDED.roles.senior_pm/R006's title) and
  // internal_band_min/max of 18/25 LPA. compBenchmark.ts's query is a plain
  // `WHERE role_category = $1` against the role's title — no fuzzy or
  // partial matching — so any application against R006 must resolve here
  // without ever reaching the Claude prompt. benchmark_id is asserted as
  // "truthy string starting with BEN" rather than the literal 'BEN003' so
  // this doesn't break if seed data is ever renumbered.
  test.describe('internal_data path — role title exactly matches a seeded comp_benchmarks row', () => {

    test('R006 (Senior Product Manager) application resolves to BEN003\'s internal band, no AI estimate', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const { application } = await createCandidateWithApp(request, hrToken, SEEDED.roles.senior_pm);

      const res = await authed(request, hrToken).get(`/api/applications/${application.id}/comp-benchmark`);
      expect(res.status()).toBe(200);
      const { benchmark } = await res.json();

      expect(benchmark.source).toBe('internal_data');
      // DECIMAL columns can round-trip as strings with trailing formatting
      // (e.g. "18.00") depending on the pg driver's type parsing — coerce
      // with Number() rather than asserting exact string/type equality.
      expect(Number(benchmark.range_min)).toBeCloseTo(18, 5);
      expect(Number(benchmark.range_max)).toBeCloseTo(25, 5);
      expect(benchmark.currency).toBe('LPA');
      expect(typeof benchmark.rationale).toBe('string');
      expect(benchmark.rationale.length).toBeGreaterThan(0);
      expect(typeof benchmark.benchmark_id).toBe('string');
      expect(benchmark.benchmark_id.startsWith('BEN')).toBe(true);
    });
  });

  // ─── AI fallback: no internal row for this role → live Claude call ────────
  // A freshly-created role with a uid()-suffixed title is guaranteed to
  // never equal any seeded comp_benchmarks.role_category, so
  // getCompBenchmark's `rows` array comes back empty and it falls through
  // to the live Anthropic API call. This is a REAL network call to Claude —
  // no mocking — so this test genuinely takes several seconds; that's
  // expected, not a hang. No timeout override here: Playwright's default
  // test timeout comfortably covers it.
  test.describe('ai_estimate path — no comp_benchmarks row matches the role title', () => {

    test('brand-new role with a unique title falls back to a live AI estimate, no benchmark_id', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');

      const roleRes = await authed(request, hrToken).post('/api/roles', {
        title: `Unbenchmarked Role ${uid()}`,
        priority: 'P2',
      });
      expect(roleRes.status()).toBe(201);
      const { role } = await roleRes.json();

      const { application } = await createCandidateWithApp(request, hrToken, role.id);

      const res = await authed(request, hrToken).get(`/api/applications/${application.id}/comp-benchmark`);
      expect(res.status()).toBe(200);
      const { benchmark } = await res.json();

      expect(benchmark.source).toBe('ai_estimate');
      expect(typeof benchmark.range_min).toBe('number');
      expect(typeof benchmark.range_max).toBe('number');
      expect(benchmark.range_min).toBeGreaterThan(0);
      expect(benchmark.range_max).toBeGreaterThan(0);
      expect(benchmark.range_max).toBeGreaterThan(benchmark.range_min);
      expect(benchmark.currency).toBe('LPA');
      expect(typeof benchmark.rationale).toBe('string');
      expect(benchmark.rationale.length).toBeGreaterThan(0);
      // No internal row backs this estimate — the field must be absent, not
      // just falsy (a stray empty string would pass a falsy check but is
      // still the wrong shape per CompBenchmarkResult's optional field).
      expect(benchmark.benchmark_id).toBeUndefined();
    });
  });

  // ─── Access control — HR-tier only, same gate as ctc_band's visibility ────
  test.describe('persona gating', () => {

    test('hiring_manager (hm_alex) is rejected with 403', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const { application } = await createCandidateWithApp(request, hrToken, SEEDED.roles.senior_pm);

      const hmToken = await getToken(request, 'hm_alex');
      const res = await authed(request, hmToken).get(`/api/applications/${application.id}/comp-benchmark`);
      expect(res.status()).toBe(403);
    });
  });

  // ─── 404 on a nonexistent application id ───────────────────────────────────
  test.describe('nonexistent application', () => {

    test('unknown application id returns 404', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const res = await authed(request, hrToken).get(`/api/applications/ANONEXISTENT${uid()}/comp-benchmark`);
      expect(res.status()).toBe(404);
    });
  });
});
