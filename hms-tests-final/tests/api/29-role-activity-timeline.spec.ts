import { test, expect } from '@playwright/test';
import {
  BASE, ROLE_INGEST_SECRET, uid,
  getToken, authed, createCandidateWithApp,
} from '../helpers/api';

// ─── GET /api/roles/:id/activity ───────────────────────────────────────────
// Role-level activity timeline — mirrors GET /api/candidates/:id/activity
// (see 03-candidates.spec.ts) but is its own route with its own scoping
// clause: WHERE role_id = $1 AND application_id IS NULL AND candidate_id IS
// NULL. That third clause is the whole point of the route existing
// separately rather than just filtering the candidate one by role_id —
// applications.ts's logActivity() stamps role_id onto EVERY event it logs
// (Stage Changed, Status Changed, screening-status changes, founder-flag
// toggles …) because those events also need to show up on the role's
// pipeline joins elsewhere, but narratively they belong to that candidate's
// own journey, not to the role's own creation/approval/edit history. Without
// the IS NULL guards, a popular role's activity tab would be swamped with
// every candidate's stage churn instead of just its own lifecycle events.

type ActivityEntry = {
  event_type: string;
  event_detail: string;
  old_value: string | null;
  new_value: string | null;
  performed_by: string | null;
  performed_by_name: string | null;
  role_id: string | null;
  application_id: string | null;
  candidate_id: string | null;
  created_at: string;
};

async function createRole(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  overrides: Record<string, unknown> = {}
) {
  const res = await authed(request, token).post('/api/roles', {
    title: `Activity Timeline Role ${uid()}`,
    priority: 'P2',
    department: 'Engineering',
    ...overrides,
  });
  const body = await res.json();
  return { res, role: body.role };
}

async function getActivity(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  roleId: string
): Promise<ActivityEntry[]> {
  const res = await authed(request, token).get(`/api/roles/${roleId}/activity`);
  expect(res.status()).toBe(200);
  const { activity } = await res.json();
  return activity as ActivityEntry[];
}

test.describe('Role Activity Timeline', () => {

  // ─── HR create → 'Role Created' ──────────────────────────────────────────
  test.describe('POST /api/roles as HR logs Role Created', () => {

    test("HR creates a role — activity contains 'Role Created' with the title in event_detail", async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { res, role } = await createRole(request, token);
      expect(res.status()).toBe(201);

      const activity = await getActivity(request, token, role.id);
      const created = activity.find(e => e.event_type === 'Role Created');
      expect(created).toBeTruthy();
      expect(created!.event_detail).toContain(role.title);
    });
  });

  // ─── Hiring Manager create → 'Role Requested', not 'Role Created' ────────
  // Same POST /api/roles endpoint, same Draft-status row — only the
  // event_type differs, so HR can tell "I made this" from "a Hiring Manager
  // asked for this" purely from the role's own timeline.
  test.describe('POST /api/roles as a Hiring Manager logs Role Requested, not Role Created', () => {

    test("hm_alex requests a role — activity has event_type 'Role Requested', no 'Role Created' entry", async ({ request }) => {
      const hmToken = await getToken(request, 'hm_alex');
      const { res, role } = await createRole(request, hmToken, {
        title: `HM Requested Role ${uid()}`,
      });
      expect(res.status()).toBe(201);

      const hrToken = await getToken(request, 'hr');
      const activity = await getActivity(request, hrToken, role.id);

      const requested = activity.find(e => e.event_type === 'Role Requested');
      expect(requested).toBeTruthy();
      expect(requested!.event_detail).toContain(role.title);

      const created = activity.find(e => e.event_type === 'Role Created');
      expect(created).toBeFalsy();
    });
  });

  // ─── PATCH a non-status field → 'Role Updated' ───────────────────────────
  test.describe('PATCH /api/roles/:id on a non-status field logs Role Updated', () => {

    test("HR changes department — activity has a 'Role Updated' entry mentioning 'department'", async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { role } = await createRole(request, token, { department: 'Engineering' });

      const patchRes = await authed(request, token).patch(`/api/roles/${role.id}`, {
        department: 'Operations',
      });
      expect(patchRes.status()).toBe(200);

      const activity = await getActivity(request, token, role.id);
      const updated = activity.find(e => e.event_type === 'Role Updated');
      expect(updated).toBeTruthy();
      expect(updated!.event_detail).toContain('department');
    });
  });

  // ─── PATCH status to a non-Approved value → 'Status Changed' ─────────────
  test.describe('PATCH /api/roles/:id changing status (not to Approved) logs Status Changed', () => {

    test("HR moves Draft -> Under Review — activity has 'Status Changed', not 'Role Approved', with old/new values set", async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { role } = await createRole(request, token);
      expect(role.status).toBe('Draft');

      const patchRes = await authed(request, token).patch(`/api/roles/${role.id}`, {
        status: 'Under Review',
      });
      expect(patchRes.status()).toBe(200);

      const activity = await getActivity(request, token, role.id);
      const statusChanged = activity.find(e => e.event_type === 'Status Changed');
      expect(statusChanged).toBeTruthy();
      expect(statusChanged!.old_value).toBe('Draft');
      expect(statusChanged!.new_value).toBe('Under Review');

      const approved = activity.find(e => e.event_type === 'Role Approved');
      expect(approved).toBeFalsy();
    });
  });

  // ─── Approving a role → 'Role Approved', never a generic Status Changed ──
  // roles.ts deliberately branches on isApprovingThisRole BEFORE the generic
  // statusEntry check, so an approval gets exactly one event for the status
  // transition ('Role Approved', event_detail containing 'Approved by
  // <name>') — never both, and never the generic 'Status Changed' entry a
  // less careful implementation would produce by treating every status
  // change uniformly.
  test.describe('PATCH /api/roles/:id approving a role logs Role Approved, never a generic Status Changed', () => {

    test("HR approves a Draft role — activity has 'Role Approved' containing 'Approved by', and no 'Status Changed' entry with new_value 'Approved'", async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { role } = await createRole(request, token);

      const patchRes = await authed(request, token).patch(`/api/roles/${role.id}`, {
        status: 'Approved',
      });
      expect(patchRes.status()).toBe(200);

      const activity = await getActivity(request, token, role.id);
      const approved = activity.find(e => e.event_type === 'Role Approved');
      expect(approved).toBeTruthy();
      expect(approved!.event_detail).toContain('Approved by');

      const badStatusChanged = activity.find(
        e => e.event_type === 'Status Changed' && e.new_value === 'Approved'
      );
      expect(badStatusChanged).toBeFalsy();
    });
  });

  // ─── Candidate/application events sharing role_id stay off the role's own timeline ──
  test.describe('Application-level events are excluded from the role timeline despite sharing role_id', () => {

    test("linking a candidate application to a role and changing its stage does not surface a 'Stage Changed' entry on the ROLE's activity", async ({ request }) => {
      const token = await getToken(request, 'hr');
      const { role } = await createRole(request, token);

      const { application } = await createCandidateWithApp(request, token, role.id);
      expect(application.role_id).toBe(role.id);

      // Advance stage away from the default 'Applied and Screened' so logActivity actually
      // writes a 'Stage Changed' row against this role_id. Any free-text
      // stage string exercises the same logActivity() call — there's no
      // per-stage special-casing to dodge here anymore: ResumeIQ scoring
      // isn't tied to a particular stage transition at all now ('Resume
      // Review' was retired — see STAGE_ORDER), it already ran
      // synchronously at application-creation time via createCandidateWithApp.
      const stageRes = await authed(request, token).post(`/api/applications/${application.id}/stage`, {
        new_stage: 'Screening',
      });
      expect(stageRes.status()).toBe(200);

      // Sanity check the event really was written and really does carry this
      // role's id — otherwise the "not found" assertion below would pass
      // trivially even if the exclusion clause were deleted entirely.
      const candActivityRes = await authed(request, token).get(`/api/candidates/${application.candidate_id}/activity`);
      expect(candActivityRes.status()).toBe(200);
      const { activity: candActivity } = await candActivityRes.json();
      const stageChangedOnCandidate = (candActivity as ActivityEntry[]).find(
        e => e.event_type === 'Stage Changed' && e.role_id === role.id
      );
      expect(stageChangedOnCandidate).toBeTruthy();

      const roleActivity = await getActivity(request, token, role.id);
      const stageChangedOnRole = roleActivity.find(e => e.event_type === 'Stage Changed');
      expect(stageChangedOnRole).toBeFalsy();
    });
  });

  // ─── Ingest webhook → 'Role Created', performed_by_name 'System' ─────────
  test.describe('POST /api/roles/ingest logs Role Created performed by System', () => {

    test("ingested role's activity has event_type 'Role Created' with performed_by_name 'System'", async ({ request }) => {
      const marker = uid();
      const ingestRes = await request.post(`${BASE}/api/roles/ingest`, {
        headers: { 'x-ingest-secret': ROLE_INGEST_SECRET },
        data: {
          timestamp: `${Date.now()}-${marker}`,
          email:     `requester+${marker}@digitalpaani.com`,
          job_title: `Ingested Activity Role ${marker}`,
        },
      });
      expect(ingestRes.status()).toBe(201);
      const { role } = await ingestRes.json();

      const hrToken = await getToken(request, 'hr');
      const activity = await getActivity(request, hrToken, role.id);
      const created = activity.find(e => e.event_type === 'Role Created');
      expect(created).toBeTruthy();
      expect(created!.performed_by_name).toBe('System');
    });
  });
});
