# DigitalPaani HMS — Project Context

> This file is read automatically by Claude Code at the start of every session.
> It is the single source of truth for what this system is, why it exists, how
> it's built, and what's still to be done. Keep it current — when architecture
> or conventions change, update this file in the same commit.
>
> For live phase-by-phase task status, see `ROADMAP.md` alongside this file.

---

## 1. What this system is, and why it exists

DigitalPaani is a water-tech AI company. This system — the **Hiring Management
System (HMS)** — is an internal, AI-enabled applicant tracking and hiring
automation platform being built by Aaron Newton in the Founders Office.

**The core problem it solves:** hiring at DigitalPaani currently involves
scattered Google Forms, Sheets, manual resume screening, and no single view of
where every role and candidate stands. HMS unifies this into one system where
**role requisitions, candidate ingestion, resume scoring, and hiring workflows
are automated and interconnected**, with clear ownership and SLA accountability
at every stage.

**The intended end-to-end flow** (this is the product vision — treat it as the
north star for all future work, not just a task list):

```
Requisition Form filled
   → new row in Requisition Sheet
   → role auto-created in HMS (Draft status)                    [DONE]
   → HR reviews, moves role to Approved
   → JD auto-generated (long-form + social, downloadable)        [TODO]
   → candidate applies via Job Application Form
   → candidate + application auto-created, linked to role        [TODO]
   → HR advances candidate to "Resume Review"
   → ResumeIQ fetches resume from Drive, reads actual text        [DONE]
   → ResumeIQ scores resume against the GENERATED JD document     [TODO — currently
                                                                     scores against
                                                                     short DB fields]
   → 8-dimension results shown in candidate view                  [DONE]
   → HR/HM screening, interviews, offer, onboarding               [PARTIAL]
```

**Active roles the system was built around** (useful for realistic test data):
Quality Assurance Engineer, Sr. Backend Developer, Manager – Process &
Proposals, E&I Engineer (Mumbai), Sr. E&I Engineer (Hyderabad), Senior Product
Manager, Senior UX/Product Designer.

**Key people:** Aaron Newton (owner, Founders Office), Mohit Joshi (Customer
Success Manager hiring), Alex (hiring manager, Senior PM + Senior UX roles),
various hiring managers per role.

---

## 2. Architecture

### Stack
| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript + Vite + TailwindCSS |
| Backend | Node.js + Express + TypeScript |
| Local DB | PostgreSQL 16 via Docker |
| Production DB | Supabase (Postgres) |
| Deployment | Vercel (frontend + backend as **separate** projects), GitHub |
| AI | Anthropic API, model `claude-sonnet-4-5` — used for ResumeIQ scoring |
| Auth | Google OAuth (restricted to `@digitalpaani.com`) → HMS JWT |
| File storage | Google Drive (resumes, JDs) via service account |
| Form intake | Google Forms → Sheets → Apps Script webhook → HMS API |

### Environments — three places, always kept in sync
There are **three** representations of the schema, and they must always match:
1. **Supabase** (production) — the real source of truth for prod data
2. **Local Docker Postgres** — for dev/testing, wiped on `docker-compose down -v`
3. **`backend/src/db/schema.sql`** — the file Docker reads to rebuild #2 from
   scratch, and the permanent record of the schema

**Rule, learned the hard way across many bugs this project has hit:** any
`ALTER TABLE` applied to Supabase must *also* be applied directly to local
Docker (immediate fix) *and* appended to `schema.sql` (permanent fix), in that
order, every time. Skipping the third step means the next `docker-compose down
-v` silently reintroduces a bug that was already "fixed."

### Local dev workflow
- **Backend + DB run in Docker.** `docker-compose up -d` (only `dp_hms_backend`
  and `dp_hms_db` — the frontend container was removed).
- **Frontend runs via Vite directly**, not Docker: `cd frontend && npm run dev`.
  Pinned to port 5173 via `strictPort: true` in `vite.config.ts` — never let
  this drift, since Google OAuth's authorized origins are tied to the exact
  port.
- Backend runs via `tsx watch src/server.ts` — no build step, no `dist/`
  folder. TypeScript runs directly.

### Access control model
Five personas: `hr_recruiter` (displayed as "HR/Admin" — same DB value, just
relabeled), `hiring_manager`, `interviewer`, `leadership`, `super_admin`.

`isHRTier(persona)` in `middleware/auth.ts` — `persona === 'hr_recruiter' ||
persona === 'leadership' || persona === 'super_admin'` — is the **single
canonical check** every HR-tier gate in the codebase calls: `requireHR`,
`requireLeadership` (identical to `requireHR` today, and intentionally kept
that way — Leadership's permissions are frozen at their current,
HR-equivalent level; kept as a separate function only so a real future split
doesn't require re-threading every call site again), `stripRestrictedFields()`
(hides `ctc_band`, `internal_risk_notes`, `agency_fee_estimate`,
`offer_ctc_fixed`, `offer_ctc_variable`, `hr_comp_alignment` from anyone
outside HR-tier), the Founder Review flag route, and the recruiter-screening-
status route. **`leadership` sees everything `hr_recruiter` sees** — there is
no field or route either is blocked from that the other isn't.

`super_admin` is a strict superset of HR-tier (passes `isHRTier` too) plus
`requireSuperAdmin`-gated routes (`/api/users`, the User Management API) that
nothing else can reach. **Policy: `super_admin` is assigned to exactly one
person (aaron.newton@digitalpaani.com) and is never a selectable role
anywhere in the UI** — `POST/PATCH /api/users` reject it outright, and the
User Management page's role dropdown only ever offers the other four.

**Hiring Manager's real capability set**: view roles/candidates/applications
(financial fields stripped), submit interview feedback for rounds they're
actually listed in (`interview_rounds.interviewer_emails`) — enforced in
`PATCH /interviews/:id/feedback`, not just a comment — record an Assignment
outcome, and set `recruiter_screening_status` specifically to `'HM
Shortlisted'` (every other screening-status value is HR-tier only, per
`POST /applications/:id/screening`). A round with no `interviewer_emails` set
at all (e.g. Assignment rounds) has no assignee to check, so feedback on
those stays open to any persona — this isn't a residual gap, it's the
correct behavior when nobody was specifically assigned.

**User Management** (`/users`, Super-Admin only — the first page in the app
with a real route-level guard, `RequireSuperAdmin` in
`components/shared/`; every other page still relies on hidden nav
links/buttons only, not a route guard) is how users get added/edited/
deactivated now — there was previously no way to do this except direct SQL
(`POST /api/auth/google` has always rejected any @digitalpaani.com account
not already present in `users`). "Remove access" is `is_active=false`, never
a hard delete — `interview_rounds.entered_by`, `activity_log.performed_by`,
etc. all reference `users.id`.

Also worth knowing: `users.auth_provider`'s CHECK constraint is
`('email','google','both')` — not `'password'`, despite what an older
version of this file said. That drift had zero behavioral impact (the value
is descriptive only, never branched on) but is now corrected in
`schema.sql`/local Docker to match what production actually enforces.

### Application state model — three independent fields
Every application has three separately-updatable fields, each with its own
API endpoint — never conflate them:
- `stage` — pipeline position (Applied → Resume Review → ... → Joined)
- `status` — Active / On Hold / Rejected / Withdrawn / Hold for Future / Joined
- `recruiter_screening_status` — New → Under Recruiter Review → Awaiting HM
  Review → HM Shortlisted (etc.)

Rejection/withdrawal requires a reason category at the API level (hard 400 if
missing) — this is intentional governance, not a bug to relax.

### ID scheme
Sequence-generated, prefixed: `R###` roles, `C####` candidates, `A####`
applications, `IR####` interview rounds, `AGN###` agencies, `Q###` eval
questions, `BEN###` comp benchmarks, `RC###` reference checks.
**Each ID series needs its own dedicated Postgres sequence** — two different
tables sharing one sequence caused duplicate-key crashes in production before;
never let two tables share a sequence again.

### ResumeIQ — 8-dimension scoring
Located in `backend/src/services/resumeIQ.ts` and
`backend/src/services/driveService.ts`. Mirrors the `digitalpaani-candidate-
scoring` skill's rubric exactly: Technical, Experience, Industry Fit, Culture
Fit, Role Alignment, Trajectory, Leadership, Communication → average score,
strengths, red flags, executive summary, recommendation.

Triggered automatically when an application's `stage` transitions to
`Resume Review`, guarded by `!app.score_avg` so it only runs once per
application. **Synchronous (awaited), not fire-and-forget** — see the
Vercel serverless async rule below; this was the exact bug class that rule
documents, fixed at the same time as JD generation.

**Resume text is fetched live from Google Drive** via a service account
(`hiring-master-drive-data@dp-hiring-master.iam.gserviceaccount.com`) —
`driveService.ts` handles PDF (via `pdf-parse` v2's `PDFParse` class — **not**
a default function export, that's a different API shape than v1), DOCX (via
`mammoth`), and native Google Docs (via export). Falls back gracefully to
profile-fields-only scoring if the fetch fails for any reason — this is
intentional, never make a failed Drive fetch a hard error.

**Known gap, not yet closed:** the JD side of the comparison currently reads
`roles.must_have_skills` / `roles.kpi_expectations` — short DB text fields —
rather than the full generated JD document. Once JD generation (Phase 3) is
built, ResumeIQ should be updated to score against that document instead. See
`ROADMAP.md`.

### Assignment emails (Gmail API)
"Send Assignment" (on a candidate's `Assignment Round` stage) composes and
sends a real email to the candidate from `hr@digitalpaani.com` — mail body,
CC, an Assignment Link (autofilled from the role's `approval_summary_link`,
labelled "Assignment Link" under RoleDetail's "Links & Assets"), and optional
supporting-doc Drive links. One action creates the `interview_rounds` row
*and* sends the email (`backend/src/routes/interviews.ts`'s `POST /`,
`round_type='Assignment'` branch) — there's no separate "schedule" step,
since assignments never had a real calendar sync to begin with.

Sending goes through `backend/src/services/gmailService.ts`, which mirrors
`calendarService.ts`'s domain-wide-delegation JWT pattern but with a **fixed**
impersonation subject (`hr@digitalpaani.com`, not the requesting HR user) —
assignment emails must always appear to come from the shared HR inbox.
Requires the `https://www.googleapis.com/auth/gmail.send` scope added to the
service account's OAuth Client ID in Admin Console (additive to the
`drive.file`/`calendar.events` grants already there) and the Gmail API
enabled at the GCP project level — same one-time-setup category as the Drive
API enablement note below. `nodemailer`'s `MailComposer` builds the raw MIME
message fed to the Gmail API's `raw` field (no attachments — supporting docs
are Drive links in the body text, not files).

A failed send is graceful, not fatal — the round is still created,
`interview_rounds.assignment_email_error` is set (mirrors `calendar_sync_
error`), and the per-round action button becomes a retry (same modal,
prefilled from that round's last-attempted values, resubmitting via `POST
/interviews/:id/assignment-send`).

### Rule: no fire-and-forget async on Vercel — await it, or it may never run
**Learned the hard way**: both JD generation (`roles.ts`, on a role's
`status` transitioning to `Approved`) and ResumeIQ scoring above used to
fire their real external-API work (Claude calls, PDF
rendering, Drive uploads) via `setImmediate(async () => {...})` **after**
the route had already sent its response — "async, non-blocking," the normal
pattern on a persistent Node server. On Vercel, it isn't safe: serverless
function execution can be frozen or torn down as soon as the response is
sent, so a `setImmediate` callback scheduled afterward has no guarantee of
ever completing. This silently broke JD generation in production for weeks
with zero error output anywhere — the request itself always succeeded
(role status really did become `Approved`), the callback just never got to
run to completion, so `jd_drive_link`/`social_jd_drive_link` stayed `null`
forever with nothing to point at as broken.

**Fix, and the pattern to follow for any future "background" work on a
mutating route:** await it inline before responding, and return a
`{ success, error }`-shaped field alongside the main payload (e.g.
`jdGeneration`, `resumeiq`, and `calendar` on the Calendar-integration route)
so the caller knows immediately whether it actually completed — never
silently swallow a failure the way fire-and-forget did. This does make the
HTTP request itself take as long as the real work takes (JD generation:
~15-30s observed for a real Claude call + 2 PDF renders + 2 Drive uploads),
which is why `backend/vercel.json` sets `functions["api/index.ts"].maxDuration`
to `60` (the max Vercel allows on the Hobby tier) — without that, awaiting
inline would just trade "hangs forever" for "always times out at Vercel's
10s default."

### Role/candidate ingestion from Google Forms
Requisition Form → Sheet → Apps Script (`onFormSubmit` trigger) → HTTP POST to
`/api/roles/ingest`, authenticated via a shared secret header (`x-ingest-
secret`), not JWT (Apps Script can't hold a user session). Dedup via a
`requisition_source_row` key (`timestamp|email` from the sheet row) so a
re-fired trigger never creates a duplicate role. The Apps Script source lives
outside this repo, in the Google Sheet's own Script editor — there is no local
copy to keep in sync beyond the reference version kept in
`docs/RequisitionFormTrigger.gs.js` (if present).

Candidate ingestion via the Job Application Form follows the same pattern but
is **not yet built** — see `ROADMAP.md` Phase 4.

### SLA / aging checks — compute-on-read, not cron
Vercel Hobby tier does not support sub-hourly cron, so the SLA checker
(`backend/src/jobs/slaChecker.ts`) does **not** rely on a scheduler in
production. Instead, `dashboard.ts` calls `runSlaCheck()` opportunistically on
every dashboard load, throttled to once every 3 minutes per serverless
instance. `runSlaCheck()` itself is a pure, idempotent function safe to call
anytime — if you ever need to trigger it manually or from a different route,
just call it directly; it doesn't assume it's running on a timer.

### Environment variables / secrets
- `GOOGLE_APPLICATION_CREDENTIALS` (local, file path) or
  `GOOGLE_APPLICATION_CREDENTIALS_JSON` (Vercel, full JSON as a string) — the
  Drive service account key. **Never commit the actual key file** — it's
  `.gitignore`'d; if you ever see it untracked in `git status`, stop and
  exclude it before anything else.
- `ROLE_INGEST_SECRET` — shared secret between Apps Script and the ingest
  endpoint. Must match exactly in both places.
- Google Drive API must be **manually enabled** at the GCP project level
  (separate from any file/folder sharing) — a one-time console setting, easy
  to forget on a new project.
- Gmail API (for assignment emails) must likewise be **manually enabled** at
  the GCP project level, and the `gmail.send` scope added to the service
  account's domain-wide-delegation Client ID in Admin Console — see
  "Assignment emails (Gmail API)" above.

### Skills available (SKILL.md format, work in both Claude Code and this chat)
- `digitalpaani-long-jd` — long-form JD PDF generation from role data
- `digitalpaani-social-jd` — social-sharable JD PDF (1080×1350) from either the
  long-form PDF or role data directly
- `digitalpaani-candidate-scoring` — the 8-dimension rubric `resumeIQ.ts` was
  ported from; useful as the reference spec if the backend implementation
  ever needs re-verifying against the original

---

## 3. Working conventions

- **PDFs over HTML** for any generated document output.
- **Full-table format** for candidate scoring exports: rank, candidate+email,
  resume link, company/industry, notice, CTC/ECTC, 8 score columns, avg,
  verdict, strengths, red flags, summary.
- **Budget flagging**: ECTC over a role's stated band should be flagged
  consistently everywhere scoring or screening surfaces compensation.
- **Source of truth for hiring data** is always the live Google Sheet, never
  a stale exported snapshot.
- Candidate profile fields (CTC, notice period, company, industry,
  designation, location, YOE, resume link) live on the **`candidates`** table.
  `applications` has some identically-named legacy columns from an earlier
  schema design — those are **not** the source of truth; always read/write
  candidate profile data on `candidates`, joined in where needed.

---

## 4. Where to look first for anything

| Need to know... | Look at |
|---|---|
| What's done / what's next | `ROADMAP.md` |
| Full product spec | `DigitalPaani_ATS_HMS_PRD_v4.0` (Google Doc, linked from project) |
| Access control rules | `backend/src/middleware/auth.ts` |
| Scoring logic | `backend/src/services/resumeIQ.ts` + `driveService.ts` |
| Application state machine | `backend/src/routes/applications.ts` |
| Schema (permanent record) | `backend/src/db/schema.sql` |
| Role ingestion from Forms | `backend/src/routes/roleIngest.ts` |
| SLA/aging logic | `backend/src/jobs/slaChecker.ts` (called from `dashboard.ts`) |
