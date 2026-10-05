// The Dashboard's "Low pipeline roles" rule, in one place.
//
// A role is low-pipeline when it is thinly stocked on BOTH counts:
//   - fewer than 3 shortlisted candidates (Active, past Applied and Screened), AND
//   - fewer than 8 Active candidates in the pipeline overall.
// (2026-10-05 — replaces "fewer than 3 shortlisted AND scored above 60", which is still
// shown as a column but no longer decides membership.) Frontend mirrors the two numbers
// in frontend/src/types/index.ts (separate package, so not a shared import).
export const LOW_PIPELINE_MAX_SHORTLISTED = 3;   // "fewer than 3"
export const LOW_PIPELINE_MAX_ACTIVE = 8;        // "fewer than 8"

export function isLowPipeline(r: { shortlisted_count: number; active_count: number }): boolean {
  return r.shortlisted_count < LOW_PIPELINE_MAX_SHORTLISTED && r.active_count < LOW_PIPELINE_MAX_ACTIVE;
}
