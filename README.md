# DigitalPaani Hiring Management System (HMS)

An internal, AI-enabled applicant tracking and hiring automation platform for DigitalPaani: role requisitions, candidate ingestion, resume scoring, JD
generation, interview workflow, SLA accountability and per-role sourcing plans in one system. `CLAUDE.md` is the detailed, always-current description of
the architecture and its rules (read it first); `ROADMAP.md` is the phase-by-phase task status and the list of open product issues.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript + Vite + TailwindCSS, TanStack Query, installable PWA (no offline mode) |
| Backend | Node.js 22 + Express + TypeScript (run with `tsx`, no build step locally) |
| Database | PostgreSQL 16 — Docker locally, Supabase in production; `backend/src/db/schema.sql` is the permanent record of the schema |
| Auth | Google OAuth restricted to `@digitalpaani.com`, exchanged for an HMS JWT (24 h); four personas: `hr_recruiter` (shown as HR/Admin), `hiring_manager`, `leadership`, `super_admin` |
| AI | Anthropic API, model `claude-sonnet-4-5`: ResumeIQ scoring, JD content, the portfolio / work-sample review, sourcing advice |
| Files | Google Drive via a service account (resumes, generated JD PDFs); Gmail (assignment e-mails) and Calendar (interview invites) through the same delegation |
| Intake | Google Forms → Sheets → Apps Script → shared-secret webhooks (`/api/roles/ingest`, `/api/candidates/ingest`) |
| Deployment | Vercel, frontend and backend as two separate projects; background work is awaited inline or run by Vercel Cron / a Vercel Queue worker (no `node-cron`, no fire-and-forget) |
| CI | GitHub Actions: tests, type-checks, database guards, CodeQL, secret scan, dependency review, Dependabot (see `CLAUDE.md`, "CI (GitHub Actions)") |

## Repository layout

| Path | What is there |
|---|---|
| `backend/` | the Express API (`src/routes`, `services`, `jobs`, `middleware`, `utils`, `db/schema.sql` + `seed.sql`), `api/index.ts` (the Vercel function) and `api/portfolio-worker.ts` (the queue worker with Chromium), `vercel.json` |
| `frontend/` | the React app (`src/pages`, `components`, `contexts`, `services/api.ts`, `utils`), `vite.config.ts`, `vercel.json` |
| `hms-tests-final/` | the Playwright suite (API, database, browser, mobile, production smoke) and the disposable test stack; see its `README.md` |
| `.github/` | workflows (`ci.yml`, `codeql.yml`, `dependency-review.yml`, `secret-scan.yml`, `audit.yml`, `integration.yml`), `dependabot.yml`, `gitleaks.toml`, the database guards in `ci/`, the PR template; see its `README.md` |
| `tools/ci-lint/` | CI-only checks (async-promise ESLint rules, the Playwright type-check), a separate package on purpose |
| `docs/` | the Sourcing module PRD and runbook, the work-sample review runbook, reference copies of the two Apps Script triggers |
| `docker-compose.yml` | local Postgres + backend (the frontend is run with Vite, not Docker) |
| `CLAUDE.md`, `ROADMAP.md` | architecture and rules; task status and open issues |
| `DigitalPaani_HMS_PRD_v5.0.docx`, `DigitalPaani_HMS_User_Access_Guide.docx`, `DigitalPaani_Hiring_SOP.docx` | product requirements, the user guide (its PDF is served by the Help page) and the hiring SOP |

## Local setup

Prerequisites: Docker Desktop, Node.js 22 (`backend/package.json` pins `22.x`; Vercel runs an unpinned 22.x).

```bash
cp .env.example .env            # then fill in what you need; see the comments in the file
docker-compose up -d            # dp_hms_db (Postgres, :5432) and dp_hms_backend (API, :4000)
cd frontend && npm install && npm run dev     # Vite on :5173 (pinned: Google OAuth's authorized origins use this exact port)
```

Open http://localhost:5173. The backend container needs `ANTHROPIC_API_KEY` (scoring, JD content), a Google service-account key file
(`dp-hiring-master-6dc8eabb38a8.json`, git-ignored, mounted by `docker-compose.yml`) and `GOOGLE_DRIVE_IMPERSONATE_EMAIL` for anything that touches
Drive, Gmail or Calendar; without them the app still runs and those features report a graceful failure. `SOURCING_ENABLED=true` turns the Sourcing module
on locally (off by default). Without Docker: start a Postgres yourself, apply `backend/src/db/schema.sql` then `seed.sql`, and run `npm run dev` in
`backend/` and `frontend/`.

**A brand-new Postgres volume does not initialise with the current `seed.sql`** (its closing `setval('seq_candidate', 0)` fails and the init script stops, so
the container exits; found 2026-11-05, listed in `ROADMAP.md`). An existing volume is fine. Until it is fixed, create a throw-away database with
`hms-tests-final/scripts/test-stack.sh` (it tolerates that error) or apply the two files with plain `psql`.

### Seeded data and sign-in

A fresh database is seeded with nine users (all local-only, password `password123`; production accounts have no password), seven roles (R001–R007),
agencies, compensation benchmarks, evaluation questions and assignment-repository entries. The Login page offers Google sign-in only; for the seeded
users the tests (and `curl`) use `POST /api/auth/login`:

| Email | Persona |
|---|---|
| `aaron.newton@digitalpaani.com`, `garima@digitalpaani.com` | `hr_recruiter` |
| `alex@digitalpaani.com`, `satyadev@digitalpaani.com`, `deeksha@digitalpaani.com`, `mandeep@digitalpaani.com` | `hiring_manager` |
| `nalin@digitalpaani.com`, `mansi@digitalpaani.com` | `leadership` |
| `superadmin@digitalpaani.com` | `super_admin` (a local fixture; in production exactly one person holds this persona) |

## Tests and CI

| Layer | Run | Size (2026-11-05) |
|---|---|---|
| Backend Vitest | `cd backend && npm test` | 119 files, 9,603 tests (+14 skipped) |
| Frontend Vitest | `cd frontend && npm test` | 76 files, 2,305 tests |
| Playwright (`hms-tests-final/`) | on a disposable stack: `bash scripts/test-stack.sh up N`, then `npx playwright test --project=…`; `npm run test:prod` for the read-only production smoke | 1,080 tests: `api` 379, `db` 413, `e2e` 220, `e2e-mobile` 30, `smoke` 38 |

Every Playwright project except `smoke` creates and deletes data: run them only against a local or disposable stack. `npm run test:prod` is read-only.
Counts drift with every test PR; re-measure before quoting them. `.github/workflows/ci.yml` runs both Vitest suites, the type-checks, a Node 22.11 load
check, the frontend build and the database guards on every PR; its aggregate job **`CI passed`** is the one check to require in branch protection. CodeQL,
dependency review, a gitleaks scan, a weekly `npm audit` and a nightly Playwright `api` + `db` run are separate workflows. Details: `CLAUDE.md`
("Testing", "CI (GitHub Actions)").

## API overview

All routes are under `/api` and need a Bearer JWT unless noted. Each persona sees only what it may: restricted fields (CTC, internal notes, agency fees,
offer figures) are removed at the API layer, not in the UI. `backend/src/routes.authMatrix.test.ts` lists every route and who may call it.

| Mount | Routes (method path) |
|---|---|
| `/auth` | `POST /login` (password; seeded and smoke accounts), `POST /google`, `GET /me`, `POST /logout` |
| `/roles` | `GET /`, `GET /filter-options`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id` (discard a request), `POST /:id/regenerate-jd`, `GET /:id/edit-log`, `/activity`, `/pipeline`, `/comp-benchmark`, `/closure-summary.pdf`; `POST /ingest` (shared secret, Requisition Form) |
| `/candidates` | `GET /`, `GET /unmatched`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`, `POST /:id/applications`, `GET /:id/edit-log`, `GET /:id/activity`; `POST /ingest` (shared secret, Job Application Form) |
| `/applications` | `GET /`, `GET /:id`, `POST /:id/stage`, `POST /:id/status`, `POST /:id/screening`, `PATCH /:id/notes`, `POST /:id/founder-flag`, `POST /:id/retry-scoring`; portfolio review: `GET`/`POST /:id/portfolio-analysis`, `POST /portfolio-backfill` (shared secret) |
| `/interviews` | `GET /`, `POST /`, `PATCH /:id/feedback`, `POST /:id/assignment-send`, `POST /:id/assignment-submit` |
| `/dashboard` | `GET /`, `/pending`, `/funnel-snapshot`, `/sla-by-role`, `/sourcing` |
| `/agencies`, `/assignment-repo`, `/ref-checks`, `/eval-questions`, `/comp-benchmarks` | lookups and repositories: writes are HR-tier; agencies and comp benchmarks are HR-tier for reads too |
| `/users` | `GET /`, `POST /`, `PATCH /:id` — `super_admin` only |
| `/sourcing` | status, settings, people, workspace, plans (activate, edit, channels), commitments, exceptions, queue, advice — off unless `SOURCING_ENABLED=true` |
| `/cron` | `POST /sla-check`, `POST /email-digest`, `GET`/`POST /sourcing-check` — `Authorization: Bearer $CRON_SECRET` |

Application state is three independent fields, each with its own endpoint: `stage` (Applied and Screened → Interview Round 1 → … → Joined),
`status` (Active / Rejected / Withdrawn / Hold for Future / Joined / Closed) and `recruiter_screening_status`. Never conflate them (`CLAUDE.md`).

## Pages

`/dashboard`, `/sourcing`, `/roles` (+ `/new`, `/:id`), `/candidates` (+ `/new`, `/:id`), `/talent-pool` (Archived Pipeline), `/agencies` (+ `/:id`), `/my-tasks`,
`/help`, and `/users` (Super-Admin only). The Help page's FAQ and the info markers next to column headers and KPIs are hand-written; change them with the
behaviour they describe.

## Architecture decisions

**Why PostgreSQL:** a proper relational model for Candidates ↔ Applications ↔ Roles ↔ Interview Rounds, concurrent writes, indexed filters. No Sheets-style workarounds.

**Why JWT + persona middleware:** restricted fields are stripped server-side before the data leaves the API. The JWT lives 24 h, but `authenticate()` also
checks `users.is_active` live (15 s cache), so a deactivated user loses access within seconds; persona and name still come from the token.

**Why compute-on-read and Vercel Cron, not `node-cron`:** Vercel Hobby has no sub-hourly cron and a serverless function can be frozen once its response is sent.
SLA breaches are re-checked when the dashboard loads (at most once per 3 minutes per instance); anything slow (JD generation, scoring) is awaited inline and
answered with a `{ success, error }` field; the browser-based portfolio review runs on a queue worker.

**Drive is storage, HMS is the record:** JDs and resumes live in Google Drive; HMS stores the links (and the generated JD's structured content).

**Three schema places, always in sync:** Supabase, the local Docker Postgres and `schema.sql`. An `ALTER TABLE` applied to Supabase is applied to local Docker and
appended to `schema.sql`, in that order, every time.

## Deployment

Two Vercel projects deploy from `main`: the backend (`backend/vercel.json`: one Express function, a 300 s queue-consumer worker, two crons) and the frontend (a
Vite build with an SPA rewrite). Order matters: schema before code; the new backend and frontend before any data edit that old code reads differently. The main
environment variables are in `.env.example` (`SOURCING_ENABLED`, the portfolio-review variables and a few more are not); `CLAUDE.md` ("Environment variables / secrets", "Production state") and `docs/` hold the runbooks. Vercel posts its own
build status; GitHub Actions never deploys.

## Roadmap

Phase-by-phase status, including what shipped (JD generation, candidate ingestion, ResumeIQ with the 9th portfolio / work-sample dimension, the Sourcing module,
CI and the test suites) and what is still open (offer letter generation, a pre-joining documents checklist, the daily e-mail digest, Sourcing P3/P4, and the
product issues found by the test work): `ROADMAP.md`.
