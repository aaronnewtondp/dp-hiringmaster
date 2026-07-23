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

## Environment variables

| Variable                  | Default                                                                    | Description                              |
|----------------------------|-----------------------------------------------------------------------------|-------------------------------------------|
| `TEST_API_URL`             | `http://localhost:4000`                                                     | Backend base URL                          |
| `TEST_FRONTEND_URL`        | `http://localhost:5173`                                                     | Frontend base URL                         |
| `ROLE_INGEST_SECRET`       | matches `docker-compose.yml`'s local dev value                              | Requisition Form webhook shared secret    |
| `CANDIDATE_INGEST_SECRET`  | matches `docker-compose.yml`'s local dev value                              | Job Application Form webhook shared secret|
| `CRON_SECRET`              | `local_dev_cron_secret_not_for_prod`                                         | Vercel Cron auth (sla-check/email-digest) |

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
- Works against both local Docker (no rate limit) and production Vercel
- Running against local right after running against prod (or vice versa)
  regenerates fresh tokens for the new target automatically — no stale-token risk

## Test structure

```
tests/
├── helpers/
│   ├── global-setup.ts   # pre-auth all users once per run
│   ├── api.ts            # token cache, authed() helper, data factories,
│   │                      # ingest secrets, pollUntil() async-condition poller
│   └── calendar.ts       # real Google Calendar helper (get/delete event, credential
│                          # detection) — used by the one real-round-trip Calendar test
│                          # and its e2e counterpart, see below
├── api/
│   ├── 01-auth.spec.ts
│   ├── 02-roles.spec.ts
│   ├── 03-candidates.spec.ts
│   ├── 04-applications.spec.ts
│   ├── 05-access-control.spec.ts
│   ├── 06-dashboard.spec.ts
│   ├── 07-interviews.spec.ts                # + Assignment-eval persona rules, interviewer_emails
│   │                                         # validation, duration_minutes (Calendar integration)
│   ├── 08-misc.spec.ts                      # agencies, notes, eval-questions, comp-benchmarks
│   ├── 09-role-ingestion.spec.ts            # Phase 3 — Requisition Form webhook
│   ├── 10-jd-generation-and-scoring.spec.ts # Phase 3+4 — real Claude/Drive/ResumeIQ calls, see below
│   ├── 11-candidate-ingestion.spec.ts       # Phase 4 — Job Application Form webhook
│   ├── 12-candidate-role-linking.spec.ts    # Phase 4 — manual "unlinked candidate" linking
│   ├── 13-inline-editing-regressions.spec.ts# Phase 3 — regression guards for real fixed bugs
│   ├── 14-stage-scheduling-regressions.spec.ts # stage-driven scheduling rework — regression guards
│   ├── 15-calendar-integration.spec.ts      # Calendar sync gating + 1 real Calendar API call, see below
│   └── 16-talent-pool.spec.ts               # PRD §21 — hold_for_future/archived filters, reactivate,
│                                             # exclude_stale_archived, COUNT(DISTINCT) regression guard
├── db/
│   ├── 00-schema-integrity.spec.ts   # Security-Immediate: dedicated sequences, GIN indexes
│   │                                  # (direct Postgres via `pg` — LOCAL ONLY, never prod)
│   └── 01-talent-pool-archival.spec.ts # PRD §21 — 90-day archival threshold; no API path can set
│                                        # a past last_updated, so this backdates directly (LOCAL ONLY)
├── smoke/
│   └── production.spec.ts   # safe for live Vercel — read-only + auth-rejection checks only
└── e2e/
    ├── 01-login.spec.ts
    ├── 02-dashboard.spec.ts
    ├── 03-jd-generation.spec.ts      # Phase 3 — slow, real JD generation through the actual UI
    ├── 04-inline-editing.spec.ts     # Phase 3 — EditableSection save/cancel, Role/Candidate/Agency
    ├── 05-unlinked-candidates.spec.ts# Phase 4 — unlinked panel + Link-to-role modal
    └── 06-schedule-round.spec.ts     # ScheduleRoundModal — IST timezone regression, email
                                       # validation, stage-gated button visibility
```

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

This works against both local Docker and production because the `/api/auth/login`
endpoint still exists in the backend (it was only removed from the frontend UI).

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
all `@digitalpaani.com`, password `password123`.

**Persona note**: `aaron.newton@` is genuinely seeded as `leadership` (Founders
Office), not `hr_recruiter` — confirmed directly against the database. It's kept
as the suite's `hr` test-user key regardless, since `leadership` has HR-equivalent-
or-greater access everywhere in this app (`requireHR` allows both personas), so it
still works as the general HR-privileged test identity; only assertions that check
its *exact* persona value were corrected to expect `leadership`.
