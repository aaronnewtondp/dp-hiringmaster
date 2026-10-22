# DigitalPaani HMS — Playwright Test Suite v3.0

## Quick start (local Docker)

```bash
cd hms-tests-final
npm install
npx playwright install chromium
npm run test:api      # all API tests (webhooks, CRUD, access control, ...)
npm run test:db       # Security-Immediate schema-integrity checks (direct Postgres)
npm run test:smoke    # lightweight, read-only smoke tests
npm run test:e2e      # browser E2E tests
npm run test:local    # api + db + e2e — the full mutating suite, LOCAL ONLY
npm test              # everything, including smoke
```

Requires the local stack already running: `docker-compose up -d` (backend + Postgres)
from the repo root, and `cd ../frontend && npm run dev` (Vite on :5173) for the
`e2e` project.

## Run against production (Vercel)

```bash
npm run test:prod
```

This runs **only** the smoke tests against the live Vercel deployment:
- Backend: `https://dp-hiringmaster-be.vercel.app`
- Frontend: `https://dp-hiringmaster.vercel.app`

**Production is smoke-only, by design.** Every other project (`api`, `db`, `e2e`)
creates and deletes real rows (test candidates, roles, applications) — safe against
local Docker's disposable seed data, but never intended to run against the real
production database. `tests/smoke/production.spec.ts` is read-only, or — for the
ingestion webhooks and the candidate-role-linking route — asserts only the
auth-rejection path (wrong/missing secret, no token), which 401s before the
request ever reaches the database. If you ever want broader production coverage,
extend `tests/smoke/`, don't point `test:api`/`test:db`/`test:e2e` at prod.

### Production smoke accounts

Every production account is Google-only (since 2026-10-19 the seed password hash was removed from the 8 users that still had one), so
the seeded users cannot sign in to production. `test:prod` therefore signs in as **two dedicated smoke accounts**:

| Account | Persona | Why |
|---|---|---|
| `smoke.leadership@hms-smoke.invalid` | `leadership` (HR-tier) | sees everything an HR user sees; not a sourcing-owner candidate, so it never shows up in a recruiter picker |
| `smoke.hm@hms-smoke.invalid` | `hiring_manager`, named on no role | the restricted view: no compensation, no agencies/benchmarks, empty states everywhere |

How they are kept safe:
- **Read-only, enforced by the backend.** Any authenticated request from the reserved domain that is not GET/HEAD/OPTIONS is answered
  `403 Smoke-test accounts are read-only` (`backend/src/middleware/auth.ts`, unit-tested, and checked live on local Docker). A leaked
  smoke password can read but never write. The suite itself never writes either; it never prints candidate data, and traces, videos and
  screenshots are off for the `smoke` project so nothing is written to disk.
- **No real identity behind them.** `.invalid` is reserved by RFC 2606, so no mailbox can exist there and Google sign-in (which admits only
  `@digitalpaani.com`) can never reach them. They exist only as rows created by SQL and sign in only through `POST /api/auth/login`.
- **Passwords never live in the repo.** Random 32-character passwords sit in `hms-tests-final/.env.smoke.local` (git-ignored, mode 600) or the
  environment: `SMOKE_LEADERSHIP_EMAIL/PASSWORD`, `SMOKE_HM_EMAIL/PASSWORD`. `helpers/smoke-env.ts` loads them.

**Creating them in production (done once, 2026-10-19 — only needed again to rotate a password).** `node scripts/smoke-accounts.mjs` prints the SQL (bcrypt hashes only — the passwords are never printed) from the
passwords in `.env.smoke.local`, creating that file with fresh passwords if it is missing; `--rotate` replaces both passwords. Run the SQL
in Supabase → SQL editor. Re-running it is safe and refreshes the hash. For local Docker:
`node scripts/smoke-accounts.mjs | docker exec -i dp_hms_db psql -U hms_user -d dp_hms`. The read-only guard only
protects once the backend that contains it is deployed; until then the accounts are ordinary HR-tier / Hiring-Manager accounts.

Do not remove `POST /api/auth/login` from the backend: the smoke accounts (and local Docker's seeded users) sign in through it.

**What `test:prod` covers** (`tests/smoke/`, 34 tests): `production.spec.ts` — health, auth, the ingest/no-token rejections, roles (HR sees
compensation, the Hiring Manager never does), one role, the dashboard, agencies / eval questions / comp benchmarks with their persona gates, the main
list and dashboard endpoints for both personas (status and shape only), user management is Super-Admin only, sourcing status once deployed;
`production-ui.spec.ts` — a real browser opens every main page for both personas (heading renders, no redirect to login, no 5xx, no uncaught
page error) plus a role page, and checks that `/users` bounces both back to the dashboard. The same suite runs against local Docker with
`npm run test:smoke` (the smoke accounts exist there too, created with the script above).

## Environment variables

| Variable                  | Default                                                                    | Description                              |
|----------------------------|-----------------------------------------------------------------------------|-------------------------------------------|
| `TEST_API_URL`             | `http://localhost:4000`                                                     | Backend base URL                          |
| `TEST_FRONTEND_URL`        | `http://localhost:5173`                                                     | Frontend base URL                         |
| `ROLE_INGEST_SECRET`       | matches `docker-compose.yml`'s local dev value                              | Requisition Form webhook shared secret    |
| `CANDIDATE_INGEST_SECRET`  | matches `docker-compose.yml`'s local dev value                              | Job Application Form webhook shared secret|
| `CRON_SECRET`              | `local_dev_cron_secret_not_for_prod`                                         | Vercel Cron auth (sla-check/email-digest/sourcing-check) |

The ingest-secret defaults work out of the box against local Docker. Override them
via env var for any run against an environment with different secrets (e.g. if you
ever add a mutating suite run against a staging environment with its own secrets).

## How token caching works

`global-setup.ts` runs **once per `npx playwright test` invocation** (i.e. once per
project you run) before its tests, logging in all 5 test users and writing their
JWTs to `.auth/tokens.json`. Every test then reads from this file rather than
calling `/api/auth/login` individually.

This means:
- The rate limiter (20 logins / 15 min in production) is never hit regardless of
  test count
- Against local Docker it logs in the 5 seeded users; against production it logs in only the two smoke accounts
  (the seeded users are Google-only there — see "Production smoke accounts")
- Running against local right after running against prod (or vice versa)
  regenerates fresh tokens for the new target automatically — no stale-token risk

## Test structure

This list is regenerated by hand periodically, not auto-generated — if it
ever looks thinner than `find tests -name "*.spec.ts" | wc -l`, it's drifted
again; each file's own header comment is the authoritative description.

```
tests/
├── helpers/
│   ├── global-setup.ts   # pre-auth all users once per run
│   ├── api.ts            # token cache, authed() helper, data factories,
│   │                      # ingest secrets, pollUntil() async-condition poller
│   └── calendar.ts       # real Google Calendar helper (get/delete event, credential
│                          # detection) — used by the one real-round-trip Calendar test
│                          # and its e2e counterpart, see below
├── api/  (41 files)
│   ├── 01-auth.spec.ts
│   ├── 02-roles.spec.ts
│   ├── 03-candidates.spec.ts
│   ├── 04-applications.spec.ts                    # stage/status/recruiter_screening_status — 3 independent fields
│   ├── 05-access-control.spec.ts                  # persona gates + restricted-field stripping
│   ├── 06-dashboard.spec.ts                        # Phase 1 dashboard shape
│   ├── 07-interviews.spec.ts                       # + Assignment-eval persona rules, interviewer_emails
│   │                                                # validation, duration_minutes (Calendar integration)
│   ├── 08-misc.spec.ts                             # agencies, notes, eval-questions, comp-benchmarks
│   ├── 09-role-ingestion.spec.ts                   # Requisition Form webhook
│   ├── 10-jd-generation-and-scoring.spec.ts        # real Claude/Drive/ResumeIQ calls, see below
│   ├── 11-candidate-ingestion.spec.ts              # Job Application Form webhook
│   ├── 12-candidate-role-linking.spec.ts           # manual "unlinked candidate" linking
│   ├── 13-inline-editing-regressions.spec.ts       # regression guards for real fixed bugs
│   ├── 14-stage-scheduling-regressions.spec.ts     # stage-driven scheduling rework
│   ├── 15-calendar-integration.spec.ts             # Calendar sync gating + 1 real Calendar API call, see below
│   ├── 16-talent-pool.spec.ts                      # hold_for_future/archived filters, reactivate,
│   │                                                # exclude_stale_archived, COUNT(DISTINCT) regression guard
│   ├── 17-role-filters.spec.ts                     # department/location/mode/priority/role master filters
│   ├── 18-create-role-form-fields.spec.ts          # Create Role form field set
│   ├── 19-pending-actions-regressions.spec.ts      # GET /api/dashboard/pending regression guards
│   ├── 20-candidate-delete-and-unlinked-pagination.spec.ts
│   ├── 21-applications-master-filters.spec.ts      # role_status/department/etc. on the Applications view
│   ├── 22-candidate-detail-field-parity.spec.ts    # inline-edit "no changes detected" path
│   ├── 23-talent-pool-master-filters.spec.ts       # master filters combined with hold_for_future/archived
│   ├── 24-scorecard-and-status-filter.spec.ts      # scored_only filter + candidate_industry
│   ├── 25-mandatory-feedback-gate.spec.ts          # feedback required before certain stage moves
│   ├── 26-reference-checks.spec.ts                 # Reference check CRUD
│   ├── 27-role-approval-workflow.spec.ts           # PATCH /:id's approval branch — HR-tier-only, no HM carve-out
│   ├── 28-role-discard.spec.ts                     # DELETE /:id — "discard a role request"
│   ├── 29-role-activity-timeline.spec.ts           # GET /:id/activity
│   ├── 30-comp-benchmarking.spec.ts                # GET /:id/comp-benchmark
│   ├── 31-budget-exception-gate.spec.ts            # mandatory over-budget reason on POST /:id/stage
│   ├── 32-dashboard-additions.spec.ts              # roles_by_status, rejected_by_stage, low_pipeline, velocity
│   ├── 33-candidate-source-field.spec.ts           # candidates.source (Identity section)
│   ├── 34-agency-hires-count.spec.ts               # driven by candidates.sourced_by_agency_id
│   ├── 35-comp-visibility.spec.ts                  # per-role Hiring Manager comp visibility
│   ├── 36-hm-dashboard-lock.spec.ts                # Hiring Manager dashboard scoping
│   ├── 37-auto-advance-positive-feedback.spec.ts   # positive interview feedback auto-advances stage
│   ├── 38-role-closure-summary.spec.ts             # role closure summary PDF/route
│   ├── 39-dashboard-funnel-snapshot-endpoint.spec.ts # GET /api/dashboard/funnel-snapshot
│   ├── 40-candidate-gender.spec.ts                 # auto-tag from name, manual correction, gender filter
│   └── 41-multiple-rejection-reasons.spec.ts       # rejection_reason_cats[]: stored '; '-joined, legacy single field, validation, HM path
├── db/  (14 files — direct Postgres via `pg`, LOCAL ONLY, never prod)
│   ├── 00-schema-integrity.spec.ts        # dedicated sequences, GIN indexes, sourcing tables (RLS, live-exception partial unique index, cascade)
│   ├── 01-talent-pool-archival.spec.ts    # 90-day archival threshold (backdates last_updated directly)
│   ├── 02-role-discard-activity-log.spec.ts
│   ├── 03-dashboard-audit-fixes.spec.ts
│   ├── 04-role-aging-close-target.spec.ts # aging_alert anchored to target_closure_date, not days-open
│   ├── 05-aging-roles-no-movement.spec.ts # no_recent_candidate_activity flag (backdates activity_log)
│   ├── 06-manual-jd-source.spec.ts        # roles.jd_source='manual' guard on auto-gen + regenerate-jd
│   ├── 07-portfolio-review.spec.ts        # portfolio review (9th ResumeIQ dimension): schema, route gating, killed-job recovery, backfill guards — no browser/model calls
│   ├── 08-low-pipeline-breakdown.spec.ts  # Low Pipeline Roles: the rule (<3 shortlisted AND <8 active, exact boundaries) + the Pipeline / Scored >60 / Shortlisted / Shortlisted >60 counts (sets fit scores + stages directly)
│   ├── 09-sla-by-role.spec.ts             # GET /api/dashboard/sla-by-role: shape, reconciles with funnel-snapshot, filters/owner/HM lock, stale-role move, closed roles (real breaches via backdated stage_entry_time + /api/cron/sla-check)
│   ├── 10-leadership-role-hiring-manager.spec.ts # a Leadership user who is also a role's named HM: /pending adds that role's HM queue + hm_roles (role-scoped), applications founder_flag+or_role_id union, persona/dashboard unchanged
│   ├── 11-co-hiring-managers.spec.ts      # several Hiring Managers in one hiring_manager_name ("A, B"): comp visibility, dashboard lock, SLA row attribution + My Tasks queue, SLA KPI, Leadership co-HM, look-alike names rejected, SQL-vs-TypeScript parity of the name rule
│   ├── 12-portfolio-score-filter.spec.ts  # GET /api/applications?min_portfolio_score (whole-number scores, inclusive, NULL never matches, 400 on junk, composes with other filters) + roles/filter-options portfolio_analysis_enabled
│   └── 13-sourcing-plans.spec.ts          # Sourcing module: seed/activate/complete, engine firing + clearing (no duplicates under 6 concurrent runs), the 3 resolution paths, shadow mode, HM redaction (no PII), role hooks (hold/close — nothing is queued on close — reopen, and multi-hop status chains that must not strand a plan), managing a running plan (a channel added mid-flight gets its first commitment, follow-ons revive when an activation is completed again, Undo-skip rules, owner / strategy-note edits), hooks survive missing tables, source_tag → sub_source (35 tests). NEEDS SOURCING_ENABLED=true on the backend (skips itself otherwise)
├── smoke/
│   ├── production.spec.ts      # safe for live Vercel — READ-ONLY API checks + auth-rejection checks, as the two smoke accounts
│   └── production-ui.spec.ts   # the same idea in a real browser: every main page opens for both personas
└── e2e/  (8 files)
    ├── 01-login.spec.ts
    ├── 02-dashboard.spec.ts             # + Hiring Funnel Snapshot chevron/rail/tile interactions, SLA-breaches-by-role chart (render, drill-down, table view)
    ├── 03-jd-generation.spec.ts         # slow, real JD generation through the actual UI
    ├── 04-inline-editing.spec.ts        # EditableSection save/cancel, Role/Candidate/Agency
    ├── 05-unlinked-candidates.spec.ts   # unlinked panel + Link-to-role modal
    ├── 06-schedule-round.spec.ts        # ScheduleRoundModal — IST timezone regression, email
    │                                    # validation, stage-gated button visibility
    ├── 07-create-role-and-filters.spec.ts
    └── 08-sourcing.spec.ts              # Sourcing module in the browser: the sidebar "Sourcing" entry (every persona) and its /sourcing page (role switcher, plan panel, dialogs, weekly trackers), the Dashboard keeps only "Sourcing execution" (its rows link to /sourcing) and no longer has the plans, old /dashboard?sourcing_role=X#sourcing-workspace links redirect to /sourcing, recruiter gets a My Tasks Sourcing box (links to /sourcing), Leadership gets none, header chip + read-only Recruitment Mode, Hiring Manager read-only plan on their own role and none for another HM's role. Skips itself unless SOURCING_ENABLED=true
```

## Module/logic-level tests (Vitest) — a separate layer from this suite

This Playwright suite exercises the app through its API/UI surface — real
HTTP requests, real browser interactions. It does not test a pure function
in isolation with many input combinations; that's what Vitest is for, and
it lives alongside the code it tests, not here:

- `backend/src/**/*.test.ts` — `npm test` (or `npm run test:watch`) from `backend/`
- `frontend/src/**/*.test.{ts,tsx}` — `npm test` (or `npm run test:watch`) from `frontend/`

Backend coverage focuses on pure logic with many edge cases worth enumerating
directly rather than via a real HTTP round trip: `computeAging` (aging.ts),
persona/comp-visibility gating (`auth.ts`'s `isHRTier`/`canSeeCompForRole`/
`stripRestrictedFields`), the SOP v2.1 score-tiered SLA (`tieredStandardHours`),
JD-variant classification (`theme.ts`), JD-content extraction/validation
(`jdContent.ts`'s `finalizeJdContent`), and ResumeIQ's prompt-building
fallback logic (`resumeIQ.ts`'s `buildRoleRequirementsSection` — including
the documented "truthy-but-empty `generated_jd_content` never falls back"
gotcha). Frontend coverage includes both pure utils (`budget.ts`,
`rejectionEmailTemplates.ts`) and component-level tests via React Testing
Library (`components/shared/Badges.tsx`) — proving both layers work, not
just pure functions.

## A note on real external calls (real cost, real time)

`tests/api/10-jd-generation-and-scoring.spec.ts` and `tests/e2e/03-jd-generation.spec.ts`
are **intentionally** the only tests in this suite that trigger real, paid external
calls: Anthropic (JD content generation + ResumeIQ scoring) and Google Drive (PDF
upload). This was a deliberate scope decision — proving the full Phase 3/4 chain
actually works end-to-end (not just that the code compiles) was judged worth the
small real cost and ~30-60s runtime per test. Everything else in this suite is
free and fast. If Anthropic/Drive credentials aren't configured in your local
`.env`, these two tests will fail/timeout — that's expected in that setup, not a
suite bug.

`tests/api/15-calendar-integration.spec.ts` and `tests/e2e/06-schedule-round.spec.ts`
each contain one more real external call: scheduling a Standard interview round with
a real `scheduled_date` + `interviewer_emails` creates a real Google Calendar event
via the same service-account + domain-wide-delegation credentials, impersonating
`aaron.newton@digitalpaani.com` as organizer (the one test persona confirmed to be a
real Workspace mailbox — `garima@` and the others are real HMS users but not real
mailboxes, and will fail impersonation with `invalid_grant` if ever used this way).
Both tests are guarded with `test.skip(!hasCalendarCredentials(), ...)` so they
degrade gracefully without the key present. Unlike the Drive/Claude tests above —
which have no delete route to clean up with and just leave their test data in
place — a stray real Calendar event sits on an actual person's actual calendar, so
both tests explicitly delete the event they create via `tests/helpers/calendar.ts`'s
`deleteCalendarEvent()` in a `finally` block.

## Notes on E2E tests and Google OAuth

The production Login page only shows the Google Sign-In button (no email/password
form). E2E tests work around this by:
1. Calling `POST /api/auth/login` directly via `page.request.post()`
2. Injecting the JWT into `localStorage` via `page.evaluate()`
3. Navigating to `/dashboard`

This works against local Docker, where the seeded users have a password. Against production only the two
read-only smoke accounts can sign in this way (every real account is Google-only since 2026-10-19); the `e2e` project itself is local-only,
and `tests/smoke/production-ui.spec.ts` is its read-only production counterpart.

## Seeded data reference

| ID   | Name                         |
|------|------------------------------|
| R001 | Sr. Backend Developer        |
| R002 | E&I Engineer (Mumbai)        |
| R003 | Sr. E&I Engineer (Hyderabad) |
| R004 | Manager Process & Proposals  |
| R005 | Quality Assurance Engineer   |
| R006 | Senior Product Manager       |
| R007 | Senior UX/Product Designer   |

Test users: `aaron.newton@`, `garima@`, `alex@`, `satyadev@`, `nalin@` —
all `@digitalpaani.com`, password `password123` (the LOCAL Docker seed only — production accounts have no password).

**Persona note**: `aaron.newton@` is genuinely seeded as `leadership` (Founders
Office), not `hr_recruiter` — confirmed directly against the database. It's kept
as the suite's `hr` test-user key regardless, since `leadership` has HR-equivalent-
or-greater access everywhere in this app (`requireHR` allows both personas), so it
still works as the general HR-privileged test identity; only assertions that check
its *exact* persona value were corrected to expect `leadership`.
