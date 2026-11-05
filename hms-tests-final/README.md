# DigitalPaani HMS — Playwright Test Suite

The end-to-end layer of the HMS test pyramid: real HTTP requests, real Postgres and real browsers against a running stack. It is one of three layers
(backend and frontend Vitest are the other two, see "Module/logic-level tests" at the end). Counts in this file were measured on 2026-11-05 with
`npx playwright test --list` (`origin/main` at `b4ccb67`); re-measure before quoting them.

**The one rule: every project except `smoke` creates, changes and deletes data. Never point them at production, Supabase or any database you
care about.** `playwright.config.ts` only defines `api`, `db`, `e2e` and `e2e-mobile` when `TEST_API_URL` is a local address; against anything else the
only project is the read-only `smoke`, and `--project=api` stops with `Project(s) "api" not found`.

## Quick start — a disposable stack (recommended)

`scripts/test-stack.sh` builds a fully isolated stack for one index `N` (0..9): its own Postgres container, its own backend process from THIS
checkout's `backend/src` and (unless `--no-frontend`) its own Vite server. It never touches the developer's `dp_hms_db` (5432), `dp_hms_backend` (4000),
Vite (5173) or `ci-eval-pg` (55432); those ports are refused.

```bash
cd hms-tests-final
npm install
npx playwright install chromium               # only the e2e / e2e-mobile projects need a browser

bash scripts/test-stack.sh up 3               # database :55443, backend :4113, frontend :5183 (api/db only: add --no-frontend)
eval "$(bash scripts/test-stack.sh env 3)"    # exports TEST_API_URL, TEST_FRONTEND_URL, TEST_DB_URL
npx playwright test --project=api --project=db
npx playwright test --project=e2e
bash scripts/test-stack.sh preview 3          # production build behind `vite preview`: needed by e2e-mobile and the PWA checks
npx playwright test --project=e2e-mobile
bash scripts/test-stack.sh down 3
```

Ports for index N: database `55440+N`, backend `4110+N`, frontend `5180+N`. Commands: `up | down | status | env | preview | restart | reset`.
`restart` restarts the backend only (it does not watch files: do it after editing `backend/src`); `reset` recreates the database from `schema.sql` +
`seed.sql` and restarts the backend; `up` is idempotent. State, logs and pid files live in `.stack/N/` (git-ignored). The backend runs on an EMPTY
environment (`env -i`): no `ANTHROPIC_API_KEY`, no Google credentials, no `backend/.env`, `SOURCING_ENABLED=true` unless `STACK_SOURCING_ENABLED` says
otherwise. Several stacks can run side by side, one per git worktree. `npm run stack:up|down|env` wrap the three common commands with `STACK=N`.
A pid file is only signalled when the process is still that stack's own. Needs Docker and `lsof`; `perl` or `python3` starts the daemons as process-group leaders.

`seed.sql` stops at its closing block on an empty database (`setval('seq_candidate', 0)`, see `ROADMAP.md`) and `seq_eval_question` /
`seq_comp_benchmark` start behind the seeded ids; the stack script tolerates that one error and advances the two sequences itself.

### Or against the developer's own Docker stack

```bash
docker-compose up -d                          # repo root: dp_hms_db + dp_hms_backend
cd frontend && npm run dev                    # Vite on :5173 (the e2e project)
cd ../hms-tests-final && npm run test:local   # api + db + e2e — MUTATES that database, LOCAL ONLY
```

The defaults (`http://localhost:4000`, `:5173`, `postgresql://hms_user:hms_password@localhost:5432/dp_hms`) point there. Running the db specs against
it is allowed but wrecks and rewrites its data; prefer a stack.

## Projects and commands

| Project | Specs | Tests | Needs |
|---|---|---|---|
| `api` | `tests/api/` — 42 files (`00-test-infrastructure`, `01`–`41`) | 379 | backend + Postgres |
| `db` | `tests/db/` — 18 files (`00`–`17`); direct Postgres through `pg` | 413 | backend + a Postgres you may wreck; **LOCAL ONLY** |
| `e2e` | `tests/e2e/` — 16 files (`00`–`14`, `16`) | 220 | + a frontend (Vite dev server) and Chromium |
| `e2e-mobile` | `tests/e2e-mobile/15-responsive-and-pwa.spec.ts` — Chromium 390x844, touch | 30 | + `test-stack.sh preview` (a production build: dev mode registers no service worker) |
| `smoke` | `tests/smoke/` — `production.spec.ts`, `production-ui.spec.ts` | 38 | a deployment (or a local stack) and the two smoke accounts; **read-only** |

1,080 tests in 79 files in all, not counting the 3 `@live` tests, which are dropped unless `TEST_LIVE=1` (below).

| Script (`package.json`) | Runs |
|---|---|
| `npm run test:api` / `test:db` / `test:e2e` / `test:smoke` / `test:mobile` | one project (list reporter) |
| `npm run test:local` | `tests/api tests/db tests/e2e` — the full MUTATING suite, LOCAL ONLY |
| `npm run test:ci` | `--project=api --project=db` (what the nightly workflow runs, minus its exclusions) |
| `npm run test:prod` | `tests/smoke` against `https://dp-hiringmaster-be.vercel.app` / `https://dp-hiringmaster.vercel.app` — read-only, safe for production |
| `npm run test:live` | `TEST_LIVE=1 playwright test --grep @live` — ONLY the three live tests |
| `npm test` | everything the target's projects allow, smoke included |
| `npm run test:report` | open the last HTML report |

### Run-wide rules (in `playwright.config.ts`, on purpose)

- **`workers: 1`, `fullyParallel: false`, `retries: 0`.** Every spec shares ONE database; several files depend on what an earlier test in the same
  file created; the SLA sweep, the sourcing engine and the dashboard totals are global, so two specs at once change each other's numbers; and a retry
  would restart a failed test in a new worker where its module-level state is gone, so a test that skips itself on a missing precondition would then
  pass vacuously. Speed comes from several isolated STACKS side by side, not from parallel workers on one database.
- `forbidOnly` in CI (`CI=1`); test timeout 60 s, `expect` timeout 10 s; reporters: HTML + list locally, list + github + junit + HTML in CI.
- Screenshots, video and trace are kept only on failure, and are OFF for `smoke` so nothing from production is written to disk. `PW_OUTPUT_DIR`
  moves `test-results/`.
- The browser's time zone is pinned to `Asia/Kolkata` (e2e/06 asserts that exact instant) and every non-local host fails with
  `ERR_NAME_NOT_RESOLVED` (the app loads Google Fonts and the Google Identity script; with them unreachable the page falls back to system fonts and
  the Google button never renders, so a run no longer depends on Google's CDN; `PW_ALLOW_EXTERNAL_HOSTS=1` turns it off).

### `@live` tests

A test that needs a real Anthropic key or Google credentials has `@live` in its title and is skipped unless `TEST_LIVE=1`. Today: `db/07`
"a candidate with NO readable resume gets the base score untouched … (the creation-time hook, with a real model) @live", `e2e/03`
"@live Approving a role generates a JD and a Drive link appears on the role page", `e2e/14` "@live a role with no internal benchmark gets an AI
estimate, labelled as one". They only pass against a backend that HAS the credentials (the developer's Docker one; a stack has none).

## Run against production (Vercel)

```bash
npm run test:prod
```

This runs **only** the smoke project against the live deployment. Production is smoke-only, by design: every other project creates and deletes real
rows. `tests/smoke/production.spec.ts` is read-only, or — for the ingestion webhooks and the candidate-role-linking route — asserts only the
auth-rejection path (wrong/missing secret, no token), which 401s before the request reaches the database; `production-ui.spec.ts` opens the main pages in a
real browser (headings render, no redirect to login, no 5xx, no uncaught page error), a role page, `/users` bouncing both accounts, and the Help page's
FAQ rows and the two guide PDFs as real navigations with the service worker in control. If you want broader production coverage, extend `tests/smoke/`;
don't point the other projects at prod.

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
  smoke password can read but never write. The suite itself never writes either, never prints candidate data, and has traces, videos and screenshots off.
- **No real identity behind them.** `.invalid` is reserved by RFC 2606, so no mailbox can exist there and Google sign-in (which admits only
  `@digitalpaani.com`) can never reach them. They exist only as rows created by SQL and sign in only through `POST /api/auth/login`.
- **Passwords never live in the repo.** Random 32-character passwords sit in `hms-tests-final/.env.smoke.local` (git-ignored, mode 600) or the
  environment: `SMOKE_LEADERSHIP_EMAIL/PASSWORD`, `SMOKE_HM_EMAIL/PASSWORD`. `helpers/smoke-env.ts` loads them.

**Creating them (done once in production, 2026-10-19 — only needed again to rotate a password, or on a fresh local database).**
`node scripts/smoke-accounts.mjs` prints the SQL (bcrypt hashes only — the passwords are never printed) from the passwords in `.env.smoke.local`,
creating that file with fresh passwords if it is missing; `--rotate` replaces both passwords. Re-running it is safe and refreshes the hash. Production:
run the SQL in Supabase → SQL editor. Local Docker: `node scripts/smoke-accounts.mjs | docker exec -i dp_hms_db psql -U hms_user -d dp_hms`; a stack:
`… | docker exec -i hms-pw-db-N psql -U hms_user -d dp_hms` (then `npm run test:smoke` with that stack's `env`, 38 of 38 pass). The read-only guard only
protects once the backend that contains it is deployed. Do not remove `POST /api/auth/login` from the backend: the smoke accounts (and the seeded
users) sign in through it.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `TEST_API_URL` | `http://localhost:4000` | Backend base URL; a non-local value leaves only the `smoke` project |
| `TEST_FRONTEND_URL` | `http://localhost:5173` | Frontend base URL (e2e, e2e-mobile, smoke UI) |
| `TEST_DB_URL` | `postgresql://hms_user:hms_password@localhost:5432/dp_hms` | The database every db spec connects to. Must be local; an API on a stack port (4110-4119) with no `TEST_DB_URL` is refused, so the specs can never mutate the developer's database while the API under test uses the stack's own |
| `TEST_LIVE` | unset | `1` also runs the `@live` tests |
| `ROLE_INGEST_SECRET` | the local-Docker value in `docker-compose.yml` | Requisition Form webhook shared secret |
| `CANDIDATE_INGEST_SECRET` | the local-Docker value in `docker-compose.yml` | Job Application Form webhook shared secret |
| `CRON_SECRET` | `local_dev_cron_secret_not_for_prod` | Cron auth (`/api/cron/*`) |
| `SMOKE_LEADERSHIP_EMAIL/PASSWORD`, `SMOKE_HM_EMAIL/PASSWORD` | from `.env.smoke.local` | the production smoke accounts |
| `PW_OUTPUT_DIR` | `test-results` | Playwright output directory |
| `PW_ALLOW_EXTERNAL_HOSTS` | unset | `1` lets the browser reach the internet |
| `HMS_PW_HEALTH_WAIT_MS` | 10000 | how long global setup waits for `GET /health` |
| `STACK`, `STACK_SOURCING_ENABLED` | 0, `true` | the stack index for `npm run stack:*`; the stack backend's `SOURCING_ENABLED` |

The ingest-secret defaults work out of the box against local Docker and a stack (both are already committed in `docker-compose.yml`); override them for an
environment with different secrets.

## How token caching works

`tests/helpers/global-setup.ts` runs **once per `npx playwright test` invocation** (not once per project) before the tests:
1. **local target:** `GET /health` (the run is aborted with a clear message, after `HMS_PW_HEALTH_WAIT_MS`, when the API is unreachable, instead of
   ~700 confusing failures), then logs in the six seeded test users (`hr`, `hr2`, `hm_alex`, `hm_satyadev`, `leadership`, `super_admin`) and THROWS
   when any login fails (a user that cannot sign in means a wrong or half-seeded database);
2. writes the JWTs to `.auth/tokens.json` and the matching user records to `.auth/users.json` (git-ignored), so no test logs in on its own (the
   production login rate limiter is 20 / 15 min) and a browser session can be built from the cache (`helpers/e2e.ts`);
3. warms `GET /api/dashboard` once with a 120 s budget: the SLA sweep is compute-on-read and the first call after a quiet spell took 25-30 s.

Against production only the two smoke accounts are used, a failed login is a warning, the run throws when NO token was obtained, and there is no health
check or warm-up. Running against local right after prod (or vice versa) regenerates the tokens for the new target. `.auth/` is created by the run.

## Test structure

```
scripts/
├── test-stack.sh        # the disposable stack (above)
├── stack-vite.mjs       # Vite through its JS API with a private cacheDir (a worktree's node_modules is a symlink to the main checkout's)
└── smoke-accounts.mjs   # prints the SQL that creates / refreshes the two smoke accounts
tests/
├── helpers/
│   ├── global-setup.ts   # described above
│   ├── api.ts            # USERS, token cache, authed(), data factories, uid(), ingest/cron secrets, pollUntil(),
│   │                      # withConnectionRetry() (ECONNRESET / ECONNREFUSED / "socket hang up" only — a 500 is an answer, never retried)
│   ├── db.ts             # the ONE definition of the db spec connection (TEST_DB_URL, local-only guard, stack-port guard)
│   ├── db-specs.ts       # schema replay (split / apply schema.sql and seed.sql, fingerprints, throw-away databases), healing of shared state a
│   │                      # killed run left behind, base ResumeIQ scores by SQL, purgeByTitlePrefix
│   ├── dates.ts          # futureIso / pastIso / futureLocalDateTime / futureDateOnly from the real clock, never hard-coded dates
│   ├── e2e.ts            # loginViaApi, gotoAs, expectNoPageErrors — a browser session built from the cached token
│   ├── e2e-candidates.ts # candidate-side browser fixtures (own role / candidate / application per test, Cleanup registry, request recording)
│   ├── e2e-roles.ts      # roles / My Tasks fixtures written by SQL (a score, stage-entry time, portfolio flag have no API), removed in one transaction
│   ├── e2e-misc.ts       # User Management, Help / info-marker and PWA helpers (structure checks only, never a sentence)
│   ├── browser-checks.ts # DB-free browser/text checks shared with the production smoke spec (which must never load the database helpers)
│   ├── calendar.ts       # real Google Calendar helper for the one real-round-trip test (get/delete event, credential detection)
│   ├── smoke-env.ts      # loads the production smoke-account credentials (.env.smoke.local / env)
│   └── sourcing-db.ts    # LOCAL ONLY: purgeRolesFast() and trackerMigrationSql() (the migration block at the end of schema.sql)
├── api/  (42 files, 379 tests)
│   ├── 00-test-infrastructure.spec.ts            # the helpers themselves: connection retry, date helpers, db-URL guards, session cache, the stack script's
│   │                                              # argument checks, "write-capable projects are local-only" (33 tests, almost all pure)
│   ├── 01-auth … 09-role-ingestion               # auth, roles, candidates, applications (3 independent fields), persona gates + restricted-field stripping,
│   │                                              # dashboard shape, interviews (+ Assignment rules, interviewer_emails, duration), agencies/notes/eval/comp, Requisition webhook
│   ├── 10-jd-generation-and-scoring              # REAL Claude / Drive / ResumeIQ calls (2 tests) — fail without credentials, see below
│   ├── 11-candidate-ingestion … 14-stage-scheduling-regressions    # Job Application webhook, manual linking, regression guards, stage-driven scheduling
│   ├── 15-calendar-integration                   # Calendar sync gating + 1 real Calendar API call (skips without credentials)
│   ├── 16-talent-pool … 24-scorecard-and-status-filter             # archive filters + reactivate, role/applications master filters, Create Role fields,
│   │                                              # pending-actions regressions, candidate delete + unlinked pagination, detail field parity, scored_only
│   ├── 25-mandatory-feedback-gate … 31-budget-exception-gate       # feedback gate, reference checks, approval (HR-tier only, no HM carve-out), discard, activity, comp benchmark, over-budget reason
│   ├── 32-dashboard-additions … 41-multiple-rejection-reasons      # roles_by_status/rejected_by_stage/low_pipeline/velocity, candidate source, agency hires, comp
│   │                                              # visibility, HM dashboard lock, auto-advance on positive feedback, closure summary PDF, funnel snapshot, gender, rejection_reason_cats[]
├── db/  (18 files, 413 tests — direct Postgres, LOCAL ONLY)
│   ├── 00-schema-integrity … 06-manual-jd-source   # sequences, GIN indexes, sourcing tables (RLS, live-exception partial unique index), archival, discard log,
│   │                                              # dashboard audit fixes, aging anchored to close target, no-recent-activity flag, jd_source='manual' guards
│   ├── 07-portfolio-review                       # designer-kind portfolio review: schema, route gating, killed-job recovery, backfill guards; needs no model (base scores are set by SQL)
│   ├── 08-low-pipeline-breakdown, 09-sla-by-role # the Low Pipeline rule (<3 shortlisted AND <8 active) and GET /dashboard/sla-by-role
│   ├── 10-leadership-role-hiring-manager, 11-co-hiring-managers   # a Leadership user who is a role's named HM; several HMs in one field ("A, B"), incl. the SQL-vs-TypeScript parity of the name rule
│   ├── 12-portfolio-score-filter                 # min_portfolio_score (whole-number scores, inclusive, NULL never matches)
│   ├── 13-sourcing-plans (39), 14-sourcing-workspace (83)         # the Sourcing module: lifecycle, engine, resolution paths, shadow mode, HM redaction, role hooks,
│   │                                              # weekly trackers, Close/Reopen, per-role target, plan history, AI-advice cache, the data migration. NEED SOURCING_ENABLED=true (skip themselves otherwise)
│   ├── 15-marketing-work-review (68)             # R019 work-sample review (portfolio_review_kind = 'marketing_work'): schema, no API toggle, unscored outcomes, re-run guard, backfill; applications made by SQL, so no model or browser runs
│   ├── 16-schema-replay (54)                     # builds a throw-away database from schema.sql + seed.sql, asserts the tables / RLS flags / nine id sequences / CHECKs / seed counts, applies schema.sql a second
│   │                                              # time and compares; pins the seed and re-run defects "as TODAY". Needs a role with CREATEDB
│   └── 17-user-lifecycle (22)                    # Remove access (is_active, never a delete), personas and the super_admin rules, Google-only accounts; contains the pins that PR #55 made stale
├── smoke/  (38 tests)
│   ├── production.spec.ts      # READ-ONLY API checks + auth-rejection checks, as the two smoke accounts (health, auth, roles, one role, dashboard, lists, persona gates, sourcing status)
│   └── production-ui.spec.ts   # the same idea in a real browser: every main page for both personas, a role page, /users bounces, Help FAQ and the guide PDFs
├── e2e/  (16 files, 220 tests)
│   ├── 00-test-infrastructure.spec.ts   # loginViaApi / gotoAs / expectNoPageErrors and the project's hermetic network + time zone
│   ├── 01-login … 08-sourcing           # login/sign-out, dashboard (+ funnel snapshot, SLA-breaches chart), JD generation through the UI (the real generation is the `@live` test), inline editing,
│   │                                    # unlinked candidates, ScheduleRoundModal (IST instant, e-mail validation, stage-gated buttons), create role + master filters, Sourcing page
│   ├── 09-user-management (27)          # /users: Super-Admin only, never a selectable super_admin, Remove access, self-lockout
│   ├── 10-candidate-actions (31)        # every stage/status/feedback modal on a candidate page: the exact request body, what the user sees, what the API stores
│   ├── 11-candidates-bulk-and-pipeline (16)   # selection, bulk modals, the Gender filter's "Not tagged" union, Archived Pipeline filters and Reactivate
│   ├── 12-my-tasks (33)                 # HR queue, Ready for Review + filters, Portfolio >= 7.5, a Leadership user who is also a role's HM, two HMs on one role, a Hiring Manager's page
│   ├── 13-help-and-info-markers (23)    # Help FAQ + guide PDFs (the PDFs need a production build) and the info markers: structure only, never a sentence
│   ├── 14-role-detail-actions (21)      # change status, closure summary, discard, manual-JD note, Regenerate JD, the Portfolio review card states, compensation HR vs HM
│   └── 16-lists-and-forms (14)          # Roles list + filters, Agencies list, the Add-candidate form
└── e2e-mobile/  (1 file, 30 tests)
    └── 15-responsive-and-pwa.spec.ts    # the sidebar drawer below lg:, touch targets, the PWA install surface (manifest, service worker, NetworkOnly /api); the PWA part needs `preview`
```

There is no `e2e/15`: that number is the mobile spec. The list is written by hand; each file's own header comment is the authoritative description.

### Specs that pin a product defect "as TODAY"

A test whose title contains `TODAY` asserts what the product does now where that looks unintended, so a fix turns it red on purpose and the test is
changed with the fix: `db/16-schema-replay` (8: seed.sql stops on `setval(…, 0)`, two sequences behind their tables, `schema.sql` not re-runnable, no index on
`pending_actions`, RLS off on the 17 original tables), `db/17-user-lifecycle` (8), `e2e/09-user-management` (3), `e2e/10-candidate-actions` (5),
`e2e/11-candidates-bulk-and-pipeline` (2), `e2e/12-my-tasks` (1), `e2e/13-help-and-info-markers` (1), `e2e/14-role-detail-actions` (2),
`e2e/16-lists-and-forms` (3), `e2e-mobile/15-responsive-and-pwa` (1). `ROADMAP.md` lists the product issues behind them.

**Stale pins as of 2026-11-05.** PR #55 made `authenticate()` check `users.is_active` live (15 s cache), but three tests still assert the old behaviour and fail
on `main`: `db/17` "TODAY: the OLD token of the deactivated user still works …" (line 197) and "TODAY: a DEACTIVATED super_admin's old token still passes
requireSuperAdmin …" (line 303; the file is serial, so the second only shows once the first is skipped) and `e2e/09` "TODAY: a token issued before the role
change and the deactivation keeps working …" (line 479). The persona-change pins in `db/17` (a promotion or demotion reaches the person only at the next
sign-in) are still true. Update them with the next change in that area; until then the nightly integration run is red.

### A fresh-stack run, 2026-11-05

`api` + `db` with the nightly exclusions: 772 tests, 756 passed, 1 failed (the first stale pin), 14 not run behind it, 1 skipped, 38 s. `e2e`: 220 tests,
212 passed, 3 failed (the stale `e2e/09` pin, and two popover-clipping checks in `e2e/13`: "Candidates: marker 2 of 7" and "Dashboard (Hiring Manager):
marker 8 of 13", which also failed alone on a re-run on that small database; not investigated), 3 skipped, 2 not run, about 3 minutes. `e2e-mobile` 30 of 30
(against `preview`). `smoke` 38 of 38. A re-run is the first thing to do for a failure in a timing-based or layout check; a failure that repeats is real.

## Module/logic-level tests (Vitest) — the other two layers

This Playwright suite exercises the app through its API/UI surface. It does not test a pure function with many input combinations or a component
with a faked API; that is Vitest, next to the code it tests:

- `backend/src/**/*.test.ts` — `npm test` from `backend/`: 119 files (118 run, 1 opt-in), 9,603 tests passing + 14 skipped. Route tests run the real Express
  routers, real `authenticate`/`require*` middleware and real JWTs with the database faked (`src/test/fakeDb.ts`, `routeHarness.ts`, `externalMocks.ts`);
  `src/routes.authMatrix.test.ts` is the allow-list of every route; `src/utils/crossPackageTwins.test.ts` keeps the frontend's copies of backend rules in
  step. `src/services/portfolio/**` (55 files, 6,731 tests) covers the Portfolio review, which cannot run on a stack (browser, model, file parsing): the
  rubric and scoring rules, answer-link picking, the injection and fairness filters, capture and its teardown guard, the PDF pre-flight and its
  child-process sandbox (real children), the Word/PowerPoint readers; several files hold a `*.heldout*.test.ts` of cases written after the rule was tuned.
  Timing-based tests use CPU time or cost ratios (`src/testing/timing.ts`) and can still fail on a heavily loaded machine: re-run before suspecting the code.
  `capture.realBrowser.test.ts` (14 tests) is skipped unless `PORTFOLIO_REAL_BROWSER_TEST=1` (a real desktop Chrome, not the headless shell production runs).
- `frontend/src/**/*.test.{ts,tsx}` — `npm test` from `frontend/`: 76 files, 2,305 tests (Vitest + jsdom + React Testing Library; per-page
  `*.markers.test.tsx` pin the info-marker texts against the backend's real numbers; `pages.smoke.test.tsx` renders every page).

Both are credential-free and touch no database. Tests titled `characterization:` (backend) or `TODAY:` (frontend) pin unintended current behaviour like
the Playwright `TODAY` tests above.

CI (`.github/workflows/ci.yml`) runs both Vitest suites and type-checks this directory (`tsc` over `hms-tests-final`, config in `tools/ci-lint/`) on every
PR; `.github/workflows/integration.yml` runs the `api` + `db` projects nightly against a fresh Postgres and backend with no credentials (a
`--grep-invert` list of tests that need a real key or are racy). `e2e`, `e2e-mobile` and `smoke` run nowhere in GitHub: run them locally. Details:
`CLAUDE.md`, "CI (GitHub Actions)".

## A note on real external calls (real cost, real time)

`tests/api/10-jd-generation-and-scoring.spec.ts` (2 tests) is the one spec that triggers real, paid external calls without an `@live` tag: Anthropic (JD
content generation and ResumeIQ scoring against the generated JD) and Google Drive (PDF upload), about 30-60 s each. Without credentials it fails or
times out: expected in that setup, not a suite bug (the nightly workflow excludes it). The `@live` tests above are the other three.

`tests/api/15-calendar-integration.spec.ts` and `tests/e2e/06-schedule-round.spec.ts` each contain one real Google Calendar call: scheduling a Standard
round with a real `scheduled_date` + `interviewer_emails` creates a real event through the service account's domain-wide delegation, impersonating
`aaron.newton@digitalpaani.com` as organizer (the one test persona confirmed to be a real Workspace mailbox; the other seeded users are not real mailboxes
and fail impersonation with `invalid_grant`). Both are guarded with `test.skip(!hasCalendarCredentials(), …)` and delete the event they create in a
`finally` block via `tests/helpers/calendar.ts`, because a stray event sits on a real person's calendar. A stack has no credentials, so they skip there.

An Assignment round's e-mail must never be sent from a test: the e2e fixtures assert that a stack's send FAILS (no Gmail), and use candidate addresses on the
reserved `.invalid` TLD.

## Notes on E2E tests and Google OAuth

The production Login page only shows the Google Sign-In button (no email/password form). The browser projects therefore build the session the way the
app does after a sign-in (`helpers/e2e.ts`): the cached JWT and user record are written to `localStorage` as `hms_token` / `hms_user`, then the test
navigates (`loginViaApi(page)`, `gotoAs(page, 'hr', '/dashboard')`). That works against local Docker and a stack, where the seeded users have a password;
against production only the two read-only smoke accounts can sign in through `POST /api/auth/login`, and `tests/smoke/production-ui.spec.ts` is the read-only
production counterpart of the `e2e` project.

## Seeded data reference

Seven roles are seeded:

| ID   | Name                         |
|------|------------------------------|
| R001 | Sr. Backend Developer        |
| R002 | E&I Engineer (Mumbai)        |
| R003 | Sr. E&I Engineer (Hyderabad) |
| R004 | Manager Process & Proposals  |
| R005 | Quality Assurance Engineer   |
| R006 | Senior Product Manager       |
| R007 | Senior UX/Product Designer   |

`seed.sql` creates nine users, all with the password `password123` (local Docker and stacks only — production accounts have no password). The suite's six
user keys: `hr` = `aaron.newton@` (`hr_recruiter`), `hr2` = `garima@` (`hr_recruiter`), `hm_alex` = `alex@` and `hm_satyadev` = `satyadev@`
(`hiring_manager`), `leadership` = `nalin@` (`leadership`), `super_admin` = `superadmin@` (`super_admin`, a local fixture distinct from
`aaron.newton@` so persona assertions on `hr` stay valid; the only user who reaches `/api/users`), all `@digitalpaani.com`. The seed also holds
`deeksha@`, `mandeep@` (hiring managers) and `mansi@` (leadership), which the suite does not sign in as.
