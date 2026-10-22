// The Sourcing page's workspace: which roles have a plan to show, and how each one is doing at a glance.
// Active and paused plans are the roles you can switch between; draft plans (waiting to be activated) are listed separately so they can be
// opened and activated. A Hiring Manager sees only the roles they are named on, and never a draft.
import { query, queryOne } from '../db/index.js';
import { isNamedHiringManager } from '../utils/hiringManagers.js';
import { OPEN_ROLE_STATUSES } from '../utils/sourcingConfig.js';
import { qualifiedInWindow, QualifiedInput, QUALIFIED_TIMESTAMPS_SQL } from '../utils/sourcingQualified.js';
import { loadSettings } from './sourcingSettings.js';
import { effectiveTarget } from './sourcingPlans.js';

export interface WorkspaceRole {
  role_id: string; title: string; priority: string; plan_id: string; plan_status: 'draft' | 'active' | 'paused';
  open_exceptions: number; channels_live: number;
  /** Qualified candidates in the last 7 days, against the role's target (null target = none set). */
  qualified: number; target: number | null; behind: boolean;
}

/** Plans waiting to be activated that the switcher lists (the rest are counted): the most urgent first, so it stays usable if many roles are open. */
export const DRAFTS_SHOWN = 40;

export async function getWorkspace(user: { userId: string; hr: boolean }, now: Date = new Date()): Promise<{ roles: WorkspaceRole[]; drafts: WorkspaceRole[]; drafts_total: number }> {
  const settings = await loadSettings();
  const PRI = `CASE r.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END`;
  const rows = await query<{
    plan_id: string; plan_status: 'draft' | 'active' | 'paused'; weekly_qualified_target: number | null; role_id: string; title: string; priority: string;
    hiring_manager_name: string | null; open_exceptions: string; channels_live: string;
  }>(
    `SELECT p.id::text AS plan_id, p.status AS plan_status, p.weekly_qualified_target, r.id AS role_id, r.title, r.priority, r.hiring_manager_name,
            (SELECT count(*) FROM sourcing_exceptions e WHERE e.plan_id = p.id AND e.status = 'open' AND NOT e.is_shadow AND p.status <> 'paused') AS open_exceptions,
            (SELECT count(*) FROM sourcing_plan_channels ch WHERE ch.plan_id = p.id AND ch.state = 'active') AS channels_live
       FROM sourcing_plans p JOIN roles r ON r.id = p.role_id
      WHERE (p.status IN ('active','paused') OR (p.status = 'draft' AND r.status = ANY($1::text[])))   -- a held role's plan is 'paused' while its role is On Hold
      ORDER BY ${PRI}, r.id`, [OPEN_ROLE_STATUSES as unknown as string[]]);

  let visible = rows;
  if (!user.hr) {
    const u = await queryOne<{ name: string }>('SELECT name FROM users WHERE id = $1', [user.userId]);
    visible = rows.filter(r => r.plan_status !== 'draft' && isNamedHiringManager(u?.name, r.hiring_manager_name));
  }

  const withTarget = visible.filter(r => effectiveTarget(r.weekly_qualified_target, r.priority, settings).applicable && r.plan_status !== 'draft');
  const byRole = new Map<string, QualifiedInput[]>();
  if (withTarget.length) {
    const apps = await query<{ role_id: string; shortlisted_at: Date | null; scored_at: Date | null }>(
      `SELECT a.role_id, ${QUALIFIED_TIMESTAMPS_SQL} FROM applications a
        WHERE a.role_id = ANY($1::text[]) AND (a.score_computed_at >= $2 OR a.last_updated >= $2 OR a.application_date >= $2)`,
      [withTarget.map(r => r.role_id), new Date(now.getTime() - 21 * 86400000)]);
    for (const a of apps) {
      const list = byRole.get(a.role_id) ?? [];
      list.push({ shortlisted_at: a.shortlisted_at ? new Date(a.shortlisted_at) : null, scored_at: a.scored_at ? new Date(a.scored_at) : null });
      byRole.set(a.role_id, list);
    }
  }

  const all: WorkspaceRole[] = visible.map(r => {
    const t = effectiveTarget(r.weekly_qualified_target, r.priority, settings);
    const qualified = byRole.has(r.role_id) || t.applicable
      ? qualifiedInWindow(byRole.get(r.role_id) ?? [], now, settings.volume_window_days, settings.qualified_rule).qualified : 0;
    return {
      role_id: r.role_id, title: r.title, priority: r.priority, plan_id: r.plan_id, plan_status: r.plan_status,
      open_exceptions: Number(r.open_exceptions), channels_live: Number(r.channels_live),
      qualified, target: t.applicable ? t.min : null, behind: t.applicable && r.plan_status === 'active' && qualified < t.min,
    };
  });
  const drafts = all.filter(r => r.plan_status === 'draft');
  return { roles: all.filter(r => r.plan_status !== 'draft'), drafts: drafts.slice(0, DRAFTS_SHOWN), drafts_total: drafts.length };
}
