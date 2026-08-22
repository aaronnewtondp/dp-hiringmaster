// ─────────────────────────────────────────────────────────────────────────────
// Role discard — activity_log survival regression test.
//
// DELETE /api/roles/:id (roles.ts) writes an activity_log row (event_type
// 'Role Discarded', role_id = the role's id) BEFORE deleting the role itself.
// activity_log.role_id is declared ON DELETE SET NULL, so once the role row
// is gone, this log row is expected to survive — just with role_id nulled
// out — rather than being lost outright. That survival isn't observable
// through the HTTP API: GET /api/roles/:id/activity 404s the instant the
// role itself is gone (it looks the role up first), so there's no
// API-reachable way to confirm the FK behaved as documented rather than the
// row simply vanishing. Hence a direct-DB test.
//
// INTENTIONALLY LOCAL-ONLY: this file opens a direct Postgres connection to
// the local Docker Postgres instance using hardcoded local-dev credentials
// (see docker-compose.yml). It must never be pointed at a production
// database and is deliberately excluded from `test:prod` (that script only
// runs tests/smoke, which is read-only and API-only — no direct DB access,
// ever, against production).
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { BASE, getToken, authed, uid } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';

test.describe('Role discard — activity_log (local Postgres, direct connection)', () => {
  let client: Client;

  test.beforeAll(async () => {
    client = new Client({ connectionString: LOCAL_DB_URL });
    await client.connect();
  });

  test.afterAll(async () => {
    await client.end();
  });

  test.describe("'Role Discarded' activity_log row outlives the deleted role, role_id SET NULL", () => {

    test('discarding a Draft role leaves exactly one Role Discarded row with role_id=NULL and the title in event_detail', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);

      const title = `DB Discard Log Check ${uid()}`;
      const createRes = await api.post('/api/roles', { title, priority: 'P2' });
      expect(createRes.status()).toBe(201);
      const { role } = await createRes.json();
      expect(role.status).toBe('Draft');

      const delRes = await request.delete(`${BASE}/api/roles/${role.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(delRes.status()).toBe(200);

      const res = await client.query(
        `SELECT event_type, role_id, event_detail FROM activity_log
         WHERE event_type = 'Role Discarded' AND event_detail LIKE $1`,
        [`%${title}%`]
      );

      // Exactly one — proves the pre-delete INSERT actually ran, and that
      // the row wasn't duplicated or otherwise fanned out.
      expect(res.rows.length).toBe(1);

      const row = res.rows[0];
      // The real point of this test: role_id is NULL, not missing — the FK's
      // ON DELETE SET NULL fired as documented, rather than the row being
      // deleted alongside the role (which a naive ON DELETE CASCADE, or a
      // missing FK action entirely under RESTRICT, would instead have
      // produced as "row never existed" or "DELETE FROM roles itself
      // failed").
      expect(row.role_id).toBeNull();
      expect(row.event_detail).toContain(title);
    });
  });
});
