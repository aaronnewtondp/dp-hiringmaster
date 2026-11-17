import { test, expect } from '@playwright/test';
import { BASE, ROLE_INGEST_SECRET, uid, authed, getToken } from '../helpers/api';
import { futureDateOnly } from '../helpers/dates';

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
          target_closure_date:    futureDateOnly(60),
        },
      });
      expect(res.status()).toBe(201);
      const { role } = await res.json();
      // The id comes from the column default (format_seq_id, 4-digit pad), like POST /roles.
      // Older roles keep their 3-digit ids, so only NEW ids are asserted to be 4+ digits.
      expect(role.id).toMatch(/^R\d{4,}$/);
      expect(role.status).toBe('Draft');
      expect(role.title).toBe(`Ingested Test Role ${marker}`);
      expect(role.department).toBe('Engineering');
      expect(role.priority).toBe('P2');
      expect(Number(role.num_openings)).toBe(2);
      expect(role.location).toBe('Bengaluru');
      // Open Date (start_date) tracks "days since approved," not "days since
      // this Requisition Form was submitted" — an ingested role arrives as a
      // Draft, so it has no Open Date yet regardless of the form's own
      // submission timestamp.
      expect(role.start_date).toBeNull();
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

    test('an invalid num_openings is a 400 and creates nothing', async ({ request }) => {
      const hr = await getToken(request, 'hr');
      for (const bad of ['abc', '0', '-2', '1.5', '100000']) {
        const marker = uid();
        const title = `Bad Openings ${bad} ${marker}`;
        const res = await request.post(`${BASE}/api/roles/ingest`, {
          headers: { 'x-ingest-secret': ROLE_INGEST_SECRET },
          data: { timestamp: `${Date.now()}-${marker}`, email: `bad+${marker}@digitalpaani.com`, job_title: title, num_openings: bad },
        });
        expect(res.status(), `num_openings ${bad}`).toBe(400);
        expect((await res.json()).error).toMatch(/num_openings/);
        const { roles } = await (await authed(request, hr).get('/api/roles')).json();
        expect(roles.filter((r: { title: string }) => r.title === title)).toHaveLength(0);
      }
    });

    test('a numeric-string num_openings ("3") is stored as 3', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/roles/ingest`, {
        headers: { 'x-ingest-secret': ROLE_INGEST_SECRET },
        data: { timestamp: `${Date.now()}-${marker}`, email: `n3+${marker}@digitalpaani.com`, job_title: `Three Openings ${marker}`, num_openings: '3' },
      });
      expect(res.status()).toBe(201);
      expect(Number((await res.json()).role.num_openings)).toBe(3);
    });

    test('a row with neither timestamp nor email is a 400 (it cannot be de-duplicated)', async ({ request }) => {
      const res = await request.post(`${BASE}/api/roles/ingest`, {
        headers: { 'x-ingest-secret': ROLE_INGEST_SECRET },
        data: { job_title: `No Key Role ${uid()}` },
      });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toMatch(/de-duplicated/);
    });

    test('two CONCURRENT posts of one row create exactly one role; the other answers the existing role like a re-fired trigger', async ({ request }) => {
      const marker = uid();
      const title = `Concurrent Ingest ${marker}`;
      const payload = { timestamp: `${Date.now()}-${marker}`, email: `race+${marker}@digitalpaani.com`, job_title: title };
      const post = () => request.post(`${BASE}/api/roles/ingest`, { headers: { 'x-ingest-secret': ROLE_INGEST_SECRET }, data: payload });
      const results = await Promise.all([post(), post(), post(), post()]);
      const statuses = results.map(r => r.status()).sort();
      expect(statuses).toEqual([200, 200, 200, 201]);
      const bodies = await Promise.all(results.map(r => r.json()));
      const created = bodies.find(b => b.role)!;
      for (const b of bodies.filter(b => !b.role)) {
        expect(b.message).toMatch(/Already ingested/);
        expect(b.role_id).toBe(created.role.id);
      }
      const hr = await getToken(request, 'hr');
      const { roles } = await (await authed(request, hr).get('/api/roles')).json();
      expect(roles.filter((r: { title: string }) => r.title === title)).toHaveLength(1);
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
