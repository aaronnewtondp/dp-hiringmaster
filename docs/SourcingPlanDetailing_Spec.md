# Sourcing plan detailing — spec and rollout (2026-11-13)

Source: a colleague's proposal ("Sourcing Tracker: What to Build", PDF, 9 Nov 2026) and workbook ("Sourcing plans.xlsx": 10 role plans, 118 company rows). Built as an
**additive layer** on the sourcing module (`docs/SourcingModule_PRD_v2.md`). Decisions (Aaron, 2026-11-13): build all six parts; keep today's thresholds as defaults;
ownership stays the HR/Admin persona (a plan line's "owner" is a label); the plan's non-form channels are supporting activities.

## What did NOT change
- The five channels (`SOURCING_CHANNELS`), the three tracked ones, and the form attribution (`source_tag` → `normalizeSourceTag` → `applications.sub_source`).
- The weekly tracker, commitments, the six existing exception types, shadow mode, persona ownership, working-day rules, `qualified_rule`.
- Today's values: a plan is chased after 1 working day (the proposal's 3 is NOT adopted).
- Existing tests are untouched; one existing helper gained a sibling (`useCanHR`, `AuthContext.tsx`) so the Sourcing page can add tabs without requiring a provider in tests.

## The six parts
1. **Templates + pre-fill** — `sourcing_templates` (6 seeded from the workbook: hard-to-fill technical, senior/leadership, tech, design, customer success, easy-to-fill;
   `utils/sourcingPlanTemplates.ts`, seeded `ON CONFLICT DO NOTHING` the first time Sourcing is read, so HR-lead edits are never overwritten). A new draft plan is pre-filled
   (job titles, company lists, plan lines) by `prefillNewPlans` (called from `ensureDraftPlansForOpenRoles`, best-effort), and an older draft on first view. Matching is by title
   keywords + department (`pickTemplate`); no match → the recruiter picks one. **Pre-fill never activates, adds a channel or sets a target**: the activation form only
   *preselects* the template's live channels and weekly qualified target; the recruiter decides. Fractional workbook targets (2.5) are rounded (1–500).
2. **Company directory** — `sourcing_companies` (one record per company, normalised key without Ltd/Pvt), lists, members. Import from CSV (UI) or the workbook
   (`npx tsx src/scripts/importSourcingWorkbook.ts <xlsx> [--dry-run]`; 118 rows → **101 distinct companies**, several firms appear in more than one list). Exclude with a reason,
   "still correct" re-check (flag after 183 days), delete = Leadership/Super Admin only. "People contacted / Candidates / Last contacted" are computed, never typed
   (candidates are matched on the normalised free-text `current_company`).
3. **Outreach upload** — weekly CSV (role ID, company, job title, profile link, date contacted, status, next follow-up, outcome). Wrong/closed role IDs, bad links,
   future dates are rejected row by row; one person = one (role, profile link); first message = new person, a later date = one follow-up, the same file again changes nothing.
   *Replied* / *qualified* are read from the sheet's own status/outcome words (`isReplied`, `isQualifiedOutcome`) — a documented heuristic. This is the OUTBOUND funnel only;
   Direct Outreach's performance in the weekly tracker is still the form-tagged applications.
4. **Weekly check-in + reminders** — one per active plan per week (Monday key), yes/no questions only for lines that are live; due Friday, alert after 2 working days.
   "Coming up" list on the Sourcing page (check-ins, uploads, untagged candidates, plans to activate).
5. **Health boxes + leadership overview** — Enough / Right / Plan-worked colours (thresholds in `DetailThresholds`), results by channel ("too few to judge" under 5), untrusted-numbers
   warning over 25% untagged (counted over candidates since the plan went live), an Overview tab (4 numbers, filters: priority, hiring manager, colour) and a Company directory tab.
6. **New alerts** — 15 types, plain TEXT in `sourcing_exceptions.type`: CHECKIN_OVERDUE, WORK_BELOW_TARGET, CHANNEL_QUIET, SCREENING_BACKLOG, NO_RESULTS, WRONG_CANDIDATES,
   HM_REJECTS_MOST, SOURCE_MISSING, BACKUP_PLAN_DUE, COMPANY_LIST_NOT_WORKED, TOO_FEW_PEOPLE_FOUND, FOUND_NOT_CONTACTED, FEW_REPLIES, REPLIES_NOT_SUITABLE, AGENCY_WEAK.
   Reused instead of duplicated: plan not activated (`PLAN_NOT_ACTIVATED`), channel not started, setup overdue, follow-ups missed, blocker not fixed, not enough qualified
   (`VOLUME_GAP`), hiring manager slow (the existing HMS SLA). **All new alerts are provisional** (`is_shadow`: HR-tier dashboard only, no My Tasks, no e-mail) until
   `detail_thresholds.alerts_live` is set true (`PUT /api/sourcing/detail-settings`, Leadership/Super Admin). Weekly-judged alerts look at the last *completed* Monday–Sunday week
   and only once a whole week has run under the plan, so nothing fires mid-week. The resolution reason list (wrong companies or titles, too busy…) is a pick-list on the existing Resolve dialog.

## Engine integration (the only change to existing logic)
`runSourcingCheck` merges `collectDetailExceptions` into its desired set; the same reconcile governs old and new types. If the new detectors throw, the existing alerts are
unaffected and the new types are left as they are for that run (`keepTypes` on `reconcileExceptions`, default empty = old behaviour).

## Known gaps / not built
- "Alert open more than 7 days moves up in urgency" — severity is recomputed each sweep without the alert's age (follow-up).
- Per-channel auto-tagged apply links (the proposal's "behind the scenes") — deliberately not built; form attribution is unchanged.
- Owners: no per-person routing ("channel owner", "recruiter + HM" are labels; HM-involved alerts are counted on the Overview).
- Monday founder summary: the existing Monday e-mail is unchanged; the Overview tab is the leadership page.
- Accepted-by-hiring-manager is approximated from the application (HM Shortlisted / moved past Applied and Screened vs rejected at that stage).
- Not viewed in a browser in the build session (component tests + a live API smoke test only) — look at the Sourcing page before relying on it.

## Rollout (schema BEFORE code)
1. Apply the "Sourcing plan detailing (2026-11-13)" block of `schema.sql` to Supabase (9 new tables, RLS on, additive; nothing existing altered) — needs Aaron's go.
2. Deploy backend, then frontend. 3. Import the workbook's company lists (dry-run first). 4. Open Sourcing → templates seed, drafts pre-fill. 5. Watch the provisional alerts
on the Dashboard for a few weeks, then set `alerts_live` (or tune thresholds via `detail_thresholds`).
Rollback: ignore the layer (nothing depends on it); `SOURCING_ENABLED=false` hides everything; the new tables can be dropped without touching any existing one.
