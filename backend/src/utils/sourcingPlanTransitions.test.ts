import { describe, it, expect } from 'vitest';
import { planTransitionFor, PlanStatus, PlanTransition } from './sourcingPlanTransitions.js';

const PLAN_STATES: Array<PlanStatus | null> = [null, 'draft', 'active', 'paused', 'closed'];
const ROLE_STATUSES = ['Draft', 'Under Review', 'Approved', 'Live – Sourcing', 'On Hold', 'Closed – Filled', 'Closed – Cancelled'] as const;

// The whole rule, written out cell by cell so a change to it has to be a visible change here. Rows: the plan's own
// state; columns: the role's NEW status. Nothing about how the role got there.
const EXPECTED: Record<string, Record<(typeof ROLE_STATUSES)[number], PlanTransition>> = {
  none:   { 'Draft': 'none', 'Under Review': 'none', 'Approved': 'seed',         'Live – Sourcing': 'seed',         'On Hold': 'none',  'Closed – Filled': 'none',  'Closed – Cancelled': 'none' },
  draft:  { 'Draft': 'none', 'Under Review': 'none', 'Approved': 'none',         'Live – Sourcing': 'none',         'On Hold': 'none',  'Closed – Filled': 'close', 'Closed – Cancelled': 'close' },
  active: { 'Draft': 'none', 'Under Review': 'none', 'Approved': 'none',         'Live – Sourcing': 'none',         'On Hold': 'pause', 'Closed – Filled': 'close', 'Closed – Cancelled': 'close' },
  paused: { 'Draft': 'none', 'Under Review': 'none', 'Approved': 'resume',       'Live – Sourcing': 'resume',       'On Hold': 'none',  'Closed – Filled': 'close', 'Closed – Cancelled': 'close' },
  closed: { 'Draft': 'none', 'Under Review': 'none', 'Approved': 'reopen_draft', 'Live – Sourcing': 'reopen_draft', 'On Hold': 'none',  'Closed – Filled': 'none',  'Closed – Cancelled': 'none' },
};

describe('planTransitionFor — every (plan state × role status) combination', () => {
  for (const plan of PLAN_STATES) {
    for (const role of ROLE_STATUSES) {
      const want = EXPECTED[plan ?? 'none'][role];
      it(`plan ${plan ?? 'missing'} + role ${role} → ${want}`, () => {
        expect(planTransitionFor(plan, role)).toBe(want);
      });
    }
  }

  it('covers all 5 plan states × all 7 role statuses', () => {
    expect(PLAN_STATES).toHaveLength(5);
    expect(ROLE_STATUSES).toHaveLength(7);
    expect(Object.keys(EXPECTED)).toHaveLength(5);
    for (const row of Object.values(EXPECTED)) expect(Object.keys(row)).toHaveLength(7);
  });
});

describe('planTransitionFor — the outcome does not depend on the path taken', () => {
  // What each action leaves the plan as (the hook applies it, the function is then asked again).
  const after = (plan: PlanStatus | null, t: PlanTransition): PlanStatus | null => {
    switch (t) {
      case 'seed': return 'draft';
      case 'reopen_draft': return 'draft';
      case 'resume': return 'active';
      case 'pause': return 'paused';
      case 'close': return 'closed';
      default: return plan;
    }
  };

  it('is idempotent: once a transition has been applied, the same role status asks for nothing more', () => {
    for (const plan of PLAN_STATES) {
      for (const role of ROLE_STATUSES) {
        const settled = after(plan, planTransitionFor(plan, role));
        expect(planTransitionFor(settled, role), `${plan} + ${role}`).toBe('none');
      }
    }
  });

  it('every path to an open role ends in a usable plan (draft or active), never closed or paused', () => {
    const open = ['Approved', 'Live – Sourcing'];
    for (const plan of PLAN_STATES) {
      for (const role of open) {
        const settled = after(plan, planTransitionFor(plan, role));
        expect(['draft', 'active']).toContain(settled);
      }
    }
  });

  it('every path to a closed role ends in a closed plan (or no plan at all if there never was one)', () => {
    for (const plan of PLAN_STATES) {
      for (const role of ['Closed – Filled', 'Closed – Cancelled']) {
        const settled = after(plan, planTransitionFor(plan, role));
        expect(settled).toBe(plan === null ? null : 'closed');
      }
    }
  });

  it('the two stuck chains from the review now resolve (a: Closed → On Hold → Approved; b: On Hold → Under Review → Approved)', () => {
    // a: a closed plan, role moves to On Hold, then Approved
    let plan: PlanStatus | null = 'closed';
    for (const role of ['On Hold', 'Approved']) plan = after(plan, planTransitionFor(plan, role));
    expect(plan).toBe('draft');
    // b: an active plan, role moves On Hold, Under Review, then Approved
    plan = 'active';
    for (const role of ['On Hold', 'Under Review', 'Approved']) plan = after(plan, planTransitionFor(plan, role));
    expect(plan).toBe('active');
  });
});

describe('planTransitionFor — unexpected input is a no-op, never a throw', () => {
  it('an unknown role status asks for nothing', () => {
    for (const plan of PLAN_STATES) expect(planTransitionFor(plan, 'Archived')).toBe('none');
    expect(planTransitionFor('active', '')).toBe('none');
  });
  it('an unknown plan state asks for nothing (the table has a CHECK, but a future value must not be acted on blindly)', () => {
    expect(planTransitionFor('archived' as unknown as PlanStatus, 'Approved')).toBe('none');
    expect(planTransitionFor('archived' as unknown as PlanStatus, 'Closed – Filled')).toBe('none');
  });
});
