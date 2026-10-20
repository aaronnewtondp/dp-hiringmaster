// "Qualified candidate" (spec §6): shortlisted by a human OR ResumeIQ > 60 — Aaron's decision, switchable
// via the `qualified_rule` setting. Computed only from immutable timestamps, so any past window can be
// rebuilt: `ai_scored_at` is never written in production (0 of 1,246 rows on 2026-10-14), `stage_entry_time` is
// overwritten on every move, so the scored part is dated by `score_computed_at` and the shortlisted part
// by the first `Stage Changed` activity row that left Applied and Screened.
import type { QualifiedRule } from './sourcingConfig.js';

export interface QualifiedInput {
  shortlisted_at: Date | null;
  scored_at: Date | null;
}

export function qualifiedAt(a: QualifiedInput, rule: QualifiedRule): Date | null {
  const s = a.shortlisted_at, c = a.scored_at;
  if (rule === 'shortlisted') return s;
  if (rule === 'scored') return c;
  if (s && c) return s < c ? s : c;
  return s ?? c;
}

/** Counts of applications that first met the rule in (end − windowDays, end] — plus the two components separately. */
export function qualifiedInWindow(
  apps: QualifiedInput[], end: Date, windowDays: number, rule: QualifiedRule,
): { qualified: number; shortlisted: number; scored: number } {
  const hi = end.getTime();
  const lo = hi - windowDays * 86400000;
  const within = (d: Date | null) => !!d && d.getTime() > lo && d.getTime() <= hi;
  return {
    qualified: apps.filter(a => within(qualifiedAt(a, rule))).length,
    shortlisted: apps.filter(a => within(a.shortlisted_at)).length,
    scored: apps.filter(a => within(a.scored_at)).length,
  };
}

/** SQL fragment shared by the engine and the role view: one row per application with its two qualifying timestamps. */
export const QUALIFIED_TIMESTAMPS_SQL = `
  (SELECT MIN(al.created_at) FROM activity_log al
    WHERE al.application_id = a.id AND al.event_type = 'Stage Changed' AND al.old_value = 'Applied and Screened') AS shortlisted_at,
  CASE WHEN a.ai_fit_score > 60 THEN COALESCE(a.score_computed_at, a.application_date) END AS scored_at`;
