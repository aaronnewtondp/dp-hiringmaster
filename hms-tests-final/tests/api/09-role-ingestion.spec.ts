import { test, expect } from '@playwright/test';
import { BASE, ROLE_INGEST_SECRET, uid } from '../helpers/api';

// ─── POST /api/roles/ingest ─────────────────────────────────────────────────
// Public webhook (no JWT) hit by the Requisition Form's Apps Script trigger.
// Guarded only by the 'x-ingest-secret' header — see roleIngest.ts.

test.describe('Role Ingestion Webhook', () => {

  test.describe('POST /api/roles/ingest', () => {

    test('happy path — creates a Draft role with an R-series ID and persists fields', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/roles/ingest`, {
        headers: { 'x-ingest-secret': ROLE_INGEST_SECRET },
        data: {
          timestamp:              `${Date.now()}-${marker}`,
          email:                  `requester+${marker}@digitalpaani.com`,
          department:             'Engineering',
          hiring_manager:         'Alex',
          priority_level:         'P2',
          new_or_replacement:     'New',
          vacancy_reason:         'Team expansion',
          job_title:              `Ingested Test Role ${marker}`,
          num_openings:           '2',
          location:               'Bengaluru',
          appointment_type:       'Full-time',
          qualification_required: 'B.Tech',
          must_have_skills:       'Node.js, TypeScript',
          nice_to_have_skills:    'Docker',
          yoe_required:           '3-5',
          ctc_band:               '12-18 LPA',
          kpi_expectations:       'Ship features on time',
          additional_remarks:     'Urgent backfill',
          target_closure_date:    '2026-09-01',
          start_date:             '2026-09-15',
        },
      });
      expect(res.status()).toBe(201);
      const { role } = await res.json();
      expect(role.id).toMatch(/^R\d{3}$/);
      expect(role.status).toBe('Draft');
      expect(role.title).toBe(`Ingested Test Role ${marker}`);
      expect(role.department).toBe('Engineering');
      expect(role.priority).toBe('P2');
      expect(Number(role.num_openings)).toBe(2);
      expect(role.location).toBe('Bengaluru');
    });

    test('returns 400 when job_title is missing', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/roles/ingest`, {
        headers: { 'x-ingest-secret': ROLE_INGEST_SECRET },
        data: {
          timestamp: `${Date.now()}-${marker}`,
          email:     `requester+${marker}@digitalpaani.com`,
          department: 'Engineering',
        },
      });
      expect(res.status()).toBe(400);
    });

    test('duplicate timestamp+email is a no-op — second POST returns the same role_id', async ({ request }) => {
      const marker    = uid();
      const timestamp  = `${Date.now()}-${marker}`;
      const email      = `dup+${marker}@digitalpaani.com`;
      const payload = {
        timestamp, email,
        job_title: `Dedup Test Role ${marker}`,
      };

      const res1 = await request.post(`${BASE}/api/roles/ingest`, {
        headers: { 'x-ingest-secret': ROLE_INGEST_SECRET },
        data: payload,
      });
      expect(res1.status()).toBe(201);
      const { role } = await res1.json();

      const res2 = await request.post(`${BASE}/api/roles/ingest`, {
        headers: { 'x-ingest-secret': ROLE_INGEST_SECRET },
        data: payload,
      });
      expect(res2.status()).toBe(200);
      const body2 = await res2.json();
      expect(body2.role_id).toBe(role.id);
    });

    test('invalid priority_level falls back to P1', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/roles/ingest`, {
        headers: { 'x-ingest-secret': ROLE_INGEST_SECRET },
        data: {
          timestamp:      `${Date.now()}-${marker}`,
          email:          `requester+${marker}@digitalpaani.com`,
          job_title:      `Priority Fallback Role ${marker}`,
          priority_level: 'not-a-real-priority',
        },
      });
      expect(res.status()).toBe(201);
      const { role } = await res.json();
      expect(role.priority).toBe('P1');
    });

    test('missing priority_level also falls back to P1', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/roles/ingest`, {
        headers: { 'x-ingest-secret': ROLE_INGEST_SECRET },
        data: {
          timestamp: `${Date.now()}-${marker}`,
          email:     `requester+${marker}@digitalpaani.com`,
          job_title: `No Priority Role ${marker}`,
        },
      });
      expect(res.status()).toBe(201);
      const { role } = await res.json();
      expect(role.priority).toBe('P1');
    });

    test('returns 401 with wrong x-ingest-secret', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/roles/ingest`, {
        headers: { 'x-ingest-secret': 'totally-wrong-secret' },
        data: {
          timestamp: `${Date.now()}-${marker}`,
          email:     `requester+${marker}@digitalpaani.com`,
          job_title: `Should Not Be Created ${marker}`,
        },
      });
      expect(res.status()).toBe(401);
    });

    test('returns 401 with no x-ingest-secret header at all', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/roles/ingest`, {
        data: {
          timestamp: `${Date.now()}-${marker}`,
          email:     `requester+${marker}@digitalpaani.com`,
          job_title: `Should Not Be Created ${marker}`,
        },
      });
      expect(res.status()).toBe(401);
    });

    test('this route has no JWT auth — a valid Authorization bearer token alone is not accepted', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/roles/ingest`, {
        headers: { Authorization: 'Bearer some.jwt.token' },
        data: {
          timestamp: `${Date.now()}-${marker}`,
          email:     `requester+${marker}@digitalpaani.com`,
          job_title: `Should Not Be Created ${marker}`,
        },
      });
      expect(res.status()).toBe(401);
    });
  });
});
