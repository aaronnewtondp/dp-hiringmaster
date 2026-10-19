// Sourcing module — what a role's status change should do to its sourcing plan. Spec: docs/SourcingModule_PRD_v2.md
//
// The decision depends ONLY on the role's NEW status and the plan's CURRENT status, never on the status the role came
// from. The first version of the hook compared previous → next and so depended on the path: Closed → On Hold → Approved
// left the plan 'closed' on an open role (activation then refuses with 409 "The role is closed" and nothing could unstick
// it), and On Hold → Under Review → Approved left it 'paused' for good (the engine, queue and digests all ignore a paused
// plan, so that role silently had no sourcing accountability).
//
// Idempotent by construction: each action leaves the plan in the one state this table maps back to 'none' for the same
// role status, so saving a role twice with the same status changes nothing the second time.
import { CLOSED_ROLE_STATUSES, OPEN_ROLE_STATUSES } from './sourcingConfig.js';

export type PlanStatus = 'draft' | 'active' | 'paused' | 'closed';

export type PlanTransition =
  | 'seed'          // no plan yet on an open role → create the draft
  | 'resume'        // paused plan on an open role → active again, due dates moved by the time spent paused
  | 'reopen_draft'  // closed plan on an open role → back to draft (history kept; must be re-activated)
  | 'pause'         // active plan on a role that went On Hold → stop its clocks
  | 'close'         // any live plan on a closed role → close it (commitments skipped, exceptions cleared)
  | 'none';

const OPEN: readonly string[] = OPEN_ROLE_STATUSES;
const CLOSED: readonly string[] = CLOSED_ROLE_STATUSES;

/**
 * @param planStatus the plan's current status, or null when the role has no plan.
 * @param roleStatus the role's status AFTER the save.
 *
 *   role open (Approved / Live – Sourcing):  no plan → seed · paused → resume · closed → reopen_draft · draft/active → none
 *   role On Hold:                            active → pause · every other plan state → none
 *   role closed (Filled / Cancelled):        draft/active/paused → close · already closed or no plan → none
 *   role Draft / Under Review (or unknown):  none
 *
 * A closed plan is deliberately NOT reopened by Draft / Under Review / On Hold: a draft plan only means something on an
 * open role (the engine looks at draft plans of open roles only). It returns to draft the moment the role is open again.
 */
export function planTransitionFor(planStatus: PlanStatus | null, roleStatus: string): PlanTransition {
  if (CLOSED.includes(roleStatus)) {
    return planStatus === 'draft' || planStatus === 'active' || planStatus === 'paused' ? 'close' : 'none';
  }
  if (OPEN.includes(roleStatus)) {
    switch (planStatus) {
      case null: return 'seed';
      case 'paused': return 'resume';
      case 'closed': return 'reopen_draft';
      default: return 'none';
    }
  }
  if (roleStatus === 'On Hold') return planStatus === 'active' ? 'pause' : 'none';
  return 'none';
}
