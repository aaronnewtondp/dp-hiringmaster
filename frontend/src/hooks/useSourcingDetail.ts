import { useQuery } from '@tanstack/react-query';
import { sourcingApi } from '../services/api.ts';
import { OverviewResponse, PlanDetailResponse, Reminder } from '../types/sourcing.ts';

/** A role's plan detail (health boxes, plan lines, outreach, check-in). HR-tier only; any failure just means "no detail" — the plan page still works. */
export function useSourcingDetail(roleId: string | undefined, enabled: boolean) {
  return useQuery<PlanDetailResponse>({
    queryKey: ['sourcing-detail', roleId],
    queryFn: async () => (await sourcingApi.detail(roleId!)).data as PlanDetailResponse,
    enabled: !!roleId && enabled, retry: false, staleTime: 30_000,
  });
}

/** The recruiter's "coming up" list: weekly check-ins, outreach uploads, untagged candidates, plans waiting to be activated. */
export function useSourcingReminders(enabled: boolean) {
  return useQuery<{ enabled: boolean; reminders: Reminder[] }>({
    queryKey: ['sourcing-reminders'], queryFn: async () => (await sourcingApi.reminders()).data, enabled, retry: false, staleTime: 30_000,
  });
}

/** The leadership page: one row per role with its three health colours and open alerts. */
export function useSourcingOverview(enabled: boolean) {
  return useQuery<OverviewResponse>({
    queryKey: ['sourcing-overview'], queryFn: async () => (await sourcingApi.overview()).data as OverviewResponse, enabled, retry: false, staleTime: 30_000,
  });
}
