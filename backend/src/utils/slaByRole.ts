// Powers the Dashboard's "SLA breaches by role" stacked bar chart
// (GET /api/dashboard/sla-by-role). Pure — it only re-shapes the same unresolved-
// breach rows (fetchSlaBreachRows) the Hiring Funnel Snapshot is built from, so the
// two can never disagree about what counts as an open breach.
import { STAGE_ORDER } from '../types/index.js';
import { SlaBreachRow } from './hiringFunnelSnapshot.js';

/** The roles the chart covers: still being hired for. Same "open roles" set as the Aging Roles table. */
export const OPEN_ROLE_STATUSES = ['Approved', 'Live – Sourcing', 'Under Review', 'On Hold'];

/** Stage label for a breach whose application no longer has a recognisable stage. */
export const OTHER_STAGE = 'Other';

export interface RoleMeta {
  id: string; title: string; status: string; priority: string; hiring_manager_name: string | null;
}

export interface SlaRoleBreachType { type: string; owner: string; count: number }
export interface SlaRoleStage { stage: string; count: number; breach_types: SlaRoleBreachType[] }

export interface SlaRoleBar {
  role_id: string; role_title: string; priority: string; status: string; hiring_manager_name: string | null;
  total: number;
  by_stage: SlaRoleStage[];
}

export interface SlaByRole {
  /** Open roles with at least one open breach, most breaches first. */
  roles: SlaRoleBar[];
  /** Sum over `roles` — what the chart shows. */
  total_breaches: number;
  /** Breaches on roles that are no longer open (candidates still marked Active there): left off the chart, counted here so the totals still reconcile. */
  closed_roles: { roles: number; breaches: number };
  /** Canonical funnel order, so the UI can colour and order segments consistently. */
  stages: string[];
}

export function buildSlaByRole(rows: SlaBreachRow[], roles: Map<string, RoleMeta>): SlaByRole {
  type Acc = Map<string, Map<string, SlaRoleBreachType>>;     // stage -> breach type -> counts
  const perRole = new Map<string, Acc>();
  const closed = new Map<string, number>();

  for (const row of rows) {
    const roleId = row.effective_role_id ?? row.pa_role_id;
    if (!roleId) continue;
    const meta = roles.get(roleId);
    if (!meta) continue;                                      // a role that no longer exists has nothing to label
    if (!OPEN_ROLE_STATUSES.includes(meta.status)) {
      closed.set(roleId, (closed.get(roleId) ?? 0) + 1);
      continue;
    }
    const stage = row.current_stage && (STAGE_ORDER as readonly string[]).includes(row.current_stage) ? row.current_stage : OTHER_STAGE;
    let byStage = perRole.get(roleId);
    if (!byStage) perRole.set(roleId, byStage = new Map());
    let byType = byStage.get(stage);
    if (!byType) byStage.set(stage, byType = new Map());
    const t = byType.get(row.action_type);
    if (t) t.count++;
    else byType.set(row.action_type, { type: row.action_type, owner: row.owner_type, count: 1 });
  }

  const stageRank = (s: string) => { const i = (STAGE_ORDER as readonly string[]).indexOf(s); return i === -1 ? STAGE_ORDER.length : i; };

  const bars: SlaRoleBar[] = [...perRole.entries()].map(([roleId, byStage]) => {
    const meta = roles.get(roleId)!;
    const by_stage: SlaRoleStage[] = [...byStage.entries()]
      .map(([stage, byType]) => {
        const breach_types = [...byType.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
        return { stage, count: breach_types.reduce((n, t) => n + t.count, 0), breach_types };
      })
      .sort((a, b) => stageRank(a.stage) - stageRank(b.stage));
    return {
      role_id: roleId, role_title: meta.title, priority: meta.priority, status: meta.status,
      hiring_manager_name: meta.hiring_manager_name,
      total: by_stage.reduce((n, s) => n + s.count, 0),
      by_stage,
    };
  }).sort((a, b) => b.total - a.total || a.role_title.localeCompare(b.role_title));

  return {
    roles: bars,
    total_breaches: bars.reduce((n, r) => n + r.total, 0),
    closed_roles: { roles: closed.size, breaches: [...closed.values()].reduce((n, c) => n + c, 0) },
    stages: [...STAGE_ORDER],
  };
}
