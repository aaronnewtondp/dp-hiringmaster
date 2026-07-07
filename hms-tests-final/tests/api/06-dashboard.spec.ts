import { test, expect } from '@playwright/test';
import { getToken, authed } from '../helpers/api';

test.describe('Dashboard API', () => {

  test.describe('GET /api/dashboard', () => {

    test('returns all Phase 1 metric keys', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard');
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.metrics).toHaveProperty('open_roles_count');
      expect(body.metrics).toHaveProperty('open_roles_by_priority');
      expect(body.metrics).toHaveProperty('active_candidates');
      expect(body).toHaveProperty('pending_actions_by_owner');
      expect(body).toHaveProperty('hiring_funnel');
      expect(body).toHaveProperty('aging_roles');
    });

    test('open_roles_by_priority covers P0–P3', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { metrics } = await (await authed(request, token).get('/api/dashboard')).json();
      const open_roles_by_priority = metrics.open_roles_by_priority;
      for (const p of ['P0', 'P1', 'P2', 'P3']) {
        expect(open_roles_by_priority).toHaveProperty(p);
      }
    });

    test('open_roles_count reflects seeded data (at least 7)', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { metrics } = await (await authed(request, token).get('/api/dashboard')).json();
      const open_roles_count = metrics.open_roles_count;
      expect(open_roles_count).toBeGreaterThanOrEqual(7);
    });

    test('pending_actions_by_owner is an object', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { pending_actions_by_owner } = await (await authed(request, token).get('/api/dashboard')).json();
      expect(typeof pending_actions_by_owner).toBe('object');
    });

    test('hiring_funnel is an array', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { hiring_funnel } = await (await authed(request, token).get('/api/dashboard')).json();
      expect(Array.isArray(hiring_funnel)).toBe(true);
    });

    test('aging_roles array contains objects with aging_alert field', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { aging_roles } = await (await authed(request, token).get('/api/dashboard')).json();
      expect(Array.isArray(aging_roles)).toBe(true);
      for (const role of aging_roles) {
        expect(['ok', 'yellow', 'red']).toContain(role.aging_alert);
      }
    });
  });

  test.describe('GET /api/dashboard/pending', () => {

    test('HR sees all pending actions (no filter)', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res   = await authed(request, token).get('/api/dashboard/pending');
      expect(res.status()).toBe(200);
      const { actions } = await res.json();
      expect(Array.isArray(actions)).toBe(true);
    });

    test('HM sees only their own queue', async ({ request }) => {
      const token   = await getToken(request, 'hm_alex');
      const { actions } = await (await authed(request, token).get('/api/dashboard/pending')).json();
      for (const a of actions) {
        expect(['hiring_manager', 'hm_alex']).toContain(a.owner_type);
      }
    });

    test('Leadership sees only their queue', async ({ request }) => {
      const token   = await getToken(request, 'leadership');
      const { actions } = await (await authed(request, token).get('/api/dashboard/pending')).json();
      for (const a of actions) {
        expect(a.owner_type).toBe('Leadership / Founders');
      }
    });
  });
});
