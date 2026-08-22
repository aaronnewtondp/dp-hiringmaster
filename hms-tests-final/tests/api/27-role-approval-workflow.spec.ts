import { test, expect } from '@playwright/test';
import { getToken, authed, uid } from '../helpers/api';

// PATCH /api/roles/:id's approval branch (roles.ts) — "approving" is defined
// purely as body.status === 'Approved' AND the role's CURRENT status isn't
// already 'Approved'. That specific transition unlocks three behaviors that
// don't exist for any other field edit on this route:
//   1. A 'hiring_manager' persona is allowed through at all, but ONLY if
//      they're the literal hiring_manager_name string on THAS role (there's
//      no user_id FK — it's a name comparison) AND the request body contains
//      nothing but 'status'.
//   2. approver_name / approval_date / start_date are server-computed and
//      unconditionally stripped from whatever the client sent, then
//      re-injected from the real acting user + today's date.
//   3. A dedicated 'Role Approved' activity_log entry is written, distinct
//      from the generic 'Status Changed' entry every other status edit gets.
//
// Re-approving an already-Approved role is a deliberate no-op (old status ===
// new status means nothing lands in the update set at all), so approver_name/
// approval_date must NOT be re-stamped on a second identical PATCH.
test.describe('Role approval workflow (PATCH /api/roles/:id)', () => {

  async function createDraftRole(request: any, token: string, overrides: Record<string, unknown> = {}) {
    const res = await authed(request, token).post('/api/roles', {
      title: `Approval WF Role ${uid()}`,
      priority: 'P2',
      ...overrides,
    });
    expect(res.status()).toBe(201);
    const { role } = await res.json();
    expect(role.status).toBe('Draft');
    return role;
  }

  const todayStr = () => new Date().toISOString().slice(0, 10);

  test.describe('HR approving a Draft role', () => {

    test('HR approves — 200, status Approved, approver_name/approval_date/start_date all server-computed', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const role  = await createDraftRole(request, token);

      const res = await authed(request, token).patch(`/api/roles/${role.id}`, { status: 'Approved' });
      expect(res.status()).toBe(200);
      const body = await res.json();

      expect(body.role.status).toBe('Approved');
      expect(typeof body.role.approver_name).toBe('string');
      expect(body.role.approver_name.length).toBeGreaterThan(0);
      expect(body.role.approval_date.slice(0, 10)).toBe(todayStr());
      // start_date is copied directly from approval_date on a real approval.
      expect(body.role.start_date.slice(0, 10)).toBe(body.role.approval_date.slice(0, 10));
    });

    // Guards the unconditional `delete body.approver_name / approval_date /
    // start_date` at the top of the handler — these three fields are wiped
    // from the incoming body BEFORE the approval check even runs, so a
    // client trying to sneak in its own values in the SAME request that
    // triggers a real approval gets silently overridden, not merged/rejected.
    test('bogus approver_name/approval_date/start_date in the approve request are ignored — server values win', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const role  = await createDraftRole(request, token);

      const res = await authed(request, token).patch(`/api/roles/${role.id}`, {
        status: 'Approved',
        approver_name: 'Fake Name',
        approval_date: '2020-01-01',
        start_date: '2020-01-01',
      });
      expect(res.status()).toBe(200);
      const body = await res.json();

      expect(body.role.status).toBe('Approved');
      expect(body.role.approver_name).not.toBe('Fake Name');
      expect(body.role.approval_date).not.toBe('2020-01-01');
      expect(body.role.approval_date.slice(0, 10)).toBe(todayStr());
      expect(body.role.start_date.slice(0, 10)).toBe(todayStr());
    });

    // After a real approval, the role's activity timeline gets a dedicated
    // 'Role Approved' event (not the generic 'Status Changed' every other
    // status edit produces) — see roles.ts's isApprovingThisRole branch in
    // the activity-log insert block.
    test('a real approval writes a Role Approved activity_log entry', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const role  = await createDraftRole(request, token);

      const patchRes = await authed(request, token).patch(`/api/roles/${role.id}`, { status: 'Approved' });
      expect(patchRes.status()).toBe(200);
      const { role: approved } = await patchRes.json();

      const activityRes = await authed(request, token).get(`/api/roles/${role.id}/activity`);
      expect(activityRes.status()).toBe(200);
      const { activity } = await activityRes.json();

      const approvalEntry = activity.find((e: any) => e.event_type === 'Role Approved');
      expect(approvalEntry).toBeTruthy();
      expect(approvalEntry.event_detail).toContain('Approved by');
      expect(approvalEntry.event_detail).toContain(approved.approver_name);
    });

    // Re-approval is a no-op: existing.status === 'Approved' already, so
    // isApprovingThisRole is false on the second PATCH, and since the
    // 'status' field's old/new values are now identical too, nothing lands
    // in the update set at all -> 'No changes detected', and critically
    // approver_name/approval_date are NOT re-stamped with a fresh timestamp.
    test('re-approving an already-Approved role is a no-op — message "No changes detected", approver/date not re-stamped', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const role  = await createDraftRole(request, token);

      const first = await authed(request, token).patch(`/api/roles/${role.id}`, { status: 'Approved' });
      expect(first.status()).toBe(200);
      const firstBody = await first.json();

      const second = await authed(request, token).patch(`/api/roles/${role.id}`, { status: 'Approved' });
      expect(second.status()).toBe(200);
      const secondBody = await second.json();

      expect(secondBody.message).toBe('No changes detected');
      expect(secondBody.role.approver_name).toBe(firstBody.role.approver_name);
      expect(secondBody.role.approval_date).toBe(firstBody.role.approval_date);
      expect(secondBody.role.start_date).toBe(firstBody.role.start_date);
    });
  });

  test.describe('Hiring Manager approving their own role', () => {

    // hiring_manager_name is a plain trimmed/lowercased string match against
    // the acting user's own name (seed.sql: alex@digitalpaani.com's name is
    // literally 'Alex') — no user_id FK backs this relationship.
    test('hm_alex approves a role where hiring_manager_name is "Alex" — 200', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const role    = await createDraftRole(request, hrToken, { hiring_manager_name: 'Alex' });

      const hmToken = await getToken(request, 'hm_alex');
      const res     = await authed(request, hmToken).patch(`/api/roles/${role.id}`, { status: 'Approved' });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.role.status).toBe('Approved');
      expect(body.role.approver_name).toBe('Alex');
    });

    // Same persona, different role: hiring_manager_name deliberately does
    // NOT match Alex's own name, so isHmForThisRole is false and the
    // approval attempt is treated exactly like an ordinary non-HR-tier edit.
    test('hm_alex cannot approve a role whose hiring_manager_name is someone else — 403', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const role    = await createDraftRole(request, hrToken, { hiring_manager_name: `Someone Else ${uid()}` });

      const hmToken = await getToken(request, 'hm_alex');
      const res     = await authed(request, hmToken).patch(`/api/roles/${role.id}`, { status: 'Approved' });
      expect(res.status()).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('HR access required');

      // Role must be untouched by the rejected attempt.
      const getRes = await authed(request, hrToken).get(`/api/roles/${role.id}`);
      const { role: unchanged } = await getRes.json();
      expect(unchanged.status).toBe('Draft');
    });

    // The allowed HM-approval path is a single-purpose door: 'status' and
    // NOTHING else. Smuggling an unrelated field in the same request — even
    // though the HM IS the correct named manager and the status value IS
    // 'Approved' — must reject the whole request, not silently drop the
    // extra field and approve anyway.
    test('hm_alex approving with an extra field in the body — 403, and the role is untouched (still Draft, title unchanged)', async ({ request }) => {
      const hrToken = await getToken(request, 'hr');
      const role    = await createDraftRole(request, hrToken, { hiring_manager_name: 'Alex' });

      const hmToken = await getToken(request, 'hm_alex');
      const res     = await authed(request, hmToken).patch(`/api/roles/${role.id}`, {
        status: 'Approved',
        title: 'Sneaky new title',
      });
      expect(res.status()).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Hiring Managers may only approve a role here, not edit other fields');

      const getRes = await authed(request, hrToken).get(`/api/roles/${role.id}`);
      const { role: unchanged } = await getRes.json();
      expect(unchanged.status).toBe('Draft');
      expect(unchanged.title).toBe(role.title);
    });
  });
});
