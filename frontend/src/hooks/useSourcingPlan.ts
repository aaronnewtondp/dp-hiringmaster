import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sourcingApi } from '../services/api.ts';
import { SourcingAdvice, SourcingPlanResponse, SourcingWorkspaceResponse } from '../types/sourcing.ts';

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

/** The Dashboard workspace's role switcher: roles with an active/paused plan (+ drafts for HR-tier), or `{ enabled:false }` while the module is off. */
export function useSourcingWorkspace() {
  return useQuery<SourcingWorkspaceResponse>({
    queryKey: ['sourcing-workspace'],
    queryFn:  async () => (await sourcingApi.workspace()).data as SourcingWorkspaceResponse,
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * AI-written next steps for a role's plan (HR-tier only). The server caches them (24 h while the facts are unchanged), so this is cheap to
 * mount; `refresh` asks for a new one (the server allows that at most once a minute). A failure just means "no advice yet" — the panel falls
 * back to the plain next action on each problem.
 */
export function useSourcingAdvice(roleId: string | undefined, enabled: boolean) {
  const qc = useQueryClient();
  const query = useQuery<{ enabled: boolean; advice: SourcingAdvice | null }>({
    queryKey: ['sourcing-advice', roleId],
    queryFn:  async () => (await sourcingApi.advice(roleId!)).data,
    enabled:  !!roleId && enabled,
    retry:    false,
    staleTime: 5 * 60_000,
  });
  const refresh = useMutation({
    mutationFn: async () => (await sourcingApi.advice(roleId!, true)).data as { enabled: boolean; advice: SourcingAdvice | null },
    onSuccess:  data => qc.setQueryData(['sourcing-advice', roleId], data),
  });
  return { ...query, refresh };
}
