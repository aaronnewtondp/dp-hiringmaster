// Shared by GET /api/dashboard (the merged SLA Breaches KPI card) and
// GET /api/dashboard/funnel-snapshot (the Hiring Funnel Snapshot section) —
// both need the exact same unresolved-breach rows, just built into different
// shapes, so the two can never disagree on what counts as an open breach.
import { query } from '../db/index.js';
import { STAGE_ORDER } from '../types/index.js';
import { ALL_BREACH_ACTION_TYPES } from '../jobs/slaChecker.js';
import { RoleFilterParams, roleIdsSubquery } from './roleFilters.js';

export interface SlaBreachRow {
  id: number; action_type: string; owner_type: string; hours_overdue: number;
  application_id: string; candidate_name: string; role_title: string;
  pa_role_id: string | null; current_stage: string | null; candidate_id: string | null;
  responsible_person: string | null;
}

export async function fetchSlaBreachRows(filters: RoleFilterParams, ownerParam?: string): Promise<SlaBreachRow[]> {
  const scoped = roleIdsSubquery(filters, 2);
  const params: unknown[] = [ALL_BREACH_ACTION_TYPES, ...(scoped?.params || [])];
  let ownerSql = '';
  if (ownerParam) {
    params.push(ownerParam);
    ownerSql = ` AND pa.owner_type = $${params.length}`;
  }
  return query<SlaBreachRow>(`
    SELECT pa.id, pa.action_type, pa.owner_type, pa.hours_overdue, pa.application_id,
           pa.candidate_name, pa.role_title, pa.role_id AS pa_role_id,
           a.stage AS current_stage, a.candidate_id AS candidate_id, pa.responsible_person
    FROM pending_actions pa
    LEFT JOIN applications a ON a.id = pa.application_id
    WHERE pa.resolved=false AND pa.action_type = ANY($1::text[])
      ${scoped ? ` AND COALESCE(a.role_id, pa.role_id) IN ${scoped.sql}` : ''}
      ${ownerSql}
    ORDER BY pa.hours_overdue DESC
  `, params);
}

export interface SnapshotCandidate {
  application_id: string; candidate_id: string | null; candidate_name: string;
  role_id: string | null; role_title: string; owner: string; stage: string; overdue_hours: number;
}

export interface SnapshotBreachType {
  type: string; owner: string; count: number; candidates: SnapshotCandidate[];
}

export interface SnapshotStage {
  stage: string; total: number; breach_types: SnapshotBreachType[];
}

// Every canonical stage, always — even zero-breach ones — so the chevron
// strip never has to guess at a missing entry; a stage's breach_types array
// is simply empty when nothing's overdue there.
export function buildHiringFunnelSnapshot(rows: SlaBreachRow[]): SnapshotStage[] {
  const snapshotByStage: Record<string, Record<string, SnapshotCandidate[]>> = {};
  for (const stage of STAGE_ORDER) snapshotByStage[stage] = {};
  for (const pa of rows) {
    const stage = pa.current_stage || 'Unknown';
    if (!snapshotByStage[stage]) snapshotByStage[stage] = {};
    if (!snapshotByStage[stage][pa.action_type]) snapshotByStage[stage][pa.action_type] = [];
    snapshotByStage[stage][pa.action_type].push({
      application_id: pa.application_id,
      candidate_id: pa.candidate_id,
      candidate_name: pa.candidate_name,
      role_id: pa.pa_role_id,
      role_title: pa.role_title,
      owner: pa.owner_type,
      stage,
      overdue_hours: pa.hours_overdue,
    });
  }
  return STAGE_ORDER.map(stage => {
    const breachTypes = Object.entries(snapshotByStage[stage] || {}).map(([type, candidates]) => ({
      type, owner: candidates[0]?.owner || '', count: candidates.length, candidates,
    }));
    return { stage, total: breachTypes.reduce((sum, bt) => sum + bt.count, 0), breach_types: breachTypes };
  });
}
