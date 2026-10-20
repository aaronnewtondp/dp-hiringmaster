import { useQuery } from '@tanstack/react-query';
import { sourcingApi } from '../services/api.ts';
import { SourcingPlanResponse } from '../types/sourcing.ts';

/**
 * A role's sourcing plan, or `{ enabled:false }` while the module is off. A 403 (a Hiring Manager who is not named on the
 * role) or any other failure simply yields no data — the sourcing UI hides itself instead of showing an error on a page
 * that is otherwise fine. Never retried: the answer does not change by asking again.
 */
export function useSourcingPlan(roleId: string | undefined) {
  return useQuery<SourcingPlanResponse>({
    queryKey: ['sourcing-plan', roleId],
    queryFn:  async () => (await sourcingApi.plan(roleId!)).data as SourcingPlanResponse,
    enabled:  !!roleId,
    retry:    false,
    staleTime: 30_000,
  });
}

/** Header chip for the role page: what the plan's state is, in a few words. */
export function sourcingChip(view: SourcingPlanResponse | undefined): { text: string; tone: 'red' | 'amber' | 'green' | 'gray' } | null {
  if (!view || !view.enabled || !view.plan) return null;
  const live = (view.exceptions ?? []).filter(e => !e.is_shadow && (e.status === 'open' || e.status === 'blocked'));
  switch (view.plan.status) {
    case 'draft':  return { text: 'Sourcing plan not activated', tone: 'amber' };
    case 'paused': return { text: 'Sourcing paused', tone: 'gray' };
    case 'closed': return null;
    default: {
      if (live.length) return { text: `Sourcing: ${live.length} ${live.length === 1 ? 'issue' : 'issues'}`, tone: 'red' };
      // Overdue work the owner has promised to catch up on is not "on track" — say what it is.
      if ((view.exceptions ?? []).some(e => !e.is_shadow && e.status === 'snoozed')) return { text: 'Sourcing: catching up', tone: 'amber' };
      return { text: 'Sourcing on track', tone: 'green' };
    }
  }
}
