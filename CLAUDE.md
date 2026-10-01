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
   → HR/Leadership/Super Admin reviews, moves role to Approved
     (a Hiring Manager cannot approve even their own role)       [DONE]
   → JD auto-generated (long-form + social, downloadable)        [DONE]
   → candidate applies via Job Application Form
   → candidate + application auto-created, linked to role,
     application starts at "Applied and Screened"                 [DONE]
   → ResumeIQ fetches resume from Drive, reads actual text,
     and scores it automatically and synchronously at Applied
     and Screened — no manual "advance the stage" step triggers
     it (the stage name itself signals scoring has already
     happened by the time a candidate sits here)                  [DONE]
   → ResumeIQ scores resume against the GENERATED JD document
     (falls back to short DB fields for a role with no JD yet)    [DONE]
   → 8-dimension results shown in candidate view                  [DONE]
   → HR (any persona, in practice usually HR/HM) shortlists
     straight from Applied and Screened into Interview Round 1 —
     no separate intermediate "Shortlisted" stage                 [DONE]
   → HR/HM screening, interviews, offer, onboarding               [PARTIAL —
                                                                     offer letter
                                                                     generation and
                                                                     pre-joining
                                                                     docs checklist
                                                                     still TODO]
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

### Testing — two separate layers, don't confuse them
- **`hms-tests-final/`** (Playwright) — exercises the app through its real
  API/UI surface: `npm run test:local` (api+db+e2e, LOCAL ONLY — mutates
  data) or `npm run test:prod` (read-only smoke tests, safe against the live
  Vercel deployment). See that directory's own `README.md` for the full
  per-file breakdown and conventions (fresh test data via `uid()`, direct-
  Postgres `tests/db/*` specs for state no API can set, e.g. backdating a
  timestamp).
- **`backend/src/**/*.test.ts` and `frontend/src/**/*.test.{ts,tsx}`**
  (Vitest) — unit/module-level tests for pure logic and small components,
  run with `npm test` from `backend/` or `frontend/` respectively. This is
  where edge cases for a pure function (`computeAging`, persona gating,
  JD-content validation, SLA tiering, etc.) get enumerated directly, rather
  than indirectly through a real HTTP round trip. New pure logic worth
  testing this way should be `export`ed even if only used internally
  elsewhere in its own module — see `jobs/slaChecker.ts`'s
  `tieredStandardHours` or `services/jdContent.ts`'s `finalizeJdContent` for
  the pattern (both were private until exported specifically to unit-test
  them).

### Access control model
Four personas: `hr_recruiter` (displayed as "HR/Admin" — same DB value, just
relabeled), `hiring_manager`, `leadership`, `super_admin`. (A fifth,
`interviewer`, was merged into `hiring_manager` — it was already functionally
identical to it everywhere: interview-feedback submission rights are gated by
`interview_rounds.interviewer_emails`, an email match, not persona.)

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
User Management page's role dropdown only ever offers the other three.

**Hiring Manager's real capability set**: view roles/candidates/applications
(financial fields stripped), submit interview feedback for rounds they're
actually listed in (`interview_rounds.interviewer_emails`) — enforced in
`PATCH /interviews/:id/feedback`, not just a comment — record an Assignment
outcome, shortlist a candidate straight from `Applied and Screened` to `Interview Round 1`
(this one stage transition is open to every persona, not HR-tier-gated — see
the Application state model section below), and set
`recruiter_screening_status` specifically to `'HM Shortlisted'` (every other
screening-status value is HR-tier only, per `POST /applications/:id/screening`
— note this is a different field from `stage`, untouched by the shortlist
change above). A round with no `interviewer_emails` set at all (e.g.
Assignment rounds) has no assignee to check, so feedback on those stays open
to any persona — this isn't a residual gap, it's the correct behavior when
nobody was specifically assigned. **A Hiring Manager cannot approve a
role — not even their own.** `PATCH /roles/:id` is `isHRTier`-gated
end to end (no `isHmForThisRole` carve-out); approver name and date are
captured from the acting HR-tier user and Open Date copies from Approval
Date the same moment.

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
- `stage` — pipeline position (Applied and Screened → Interview Round 1 →
  Interview Round 2 → Assignment Round → Founders Round → Reference Check →
  Pre-Joining Documents → Offer Discussion → Offer Released → Offer Accepted
  → Joined). `Resume Review` and `Shortlisted` were retired as distinct
  stages — every application is scored by ResumeIQ automatically and
  synchronously the moment it's created (at `Applied and Screened`), and
  "shortlisting" is a direct `Applied and Screened` → `Interview Round 1`
  move, open to **every** persona specifically from `Applied and Screened`
  (every other transition stays HR-tier-only). The stage was renamed from
  plain `Applied` to `Applied and Screened` the same day (2026-09-01), so
  the name itself signals that ResumeIQ has already run by the time a
  candidate is here — no separate "has this been screened yet?" question.
  `STAGE_ORDER`/`STAGES` (`backend/src/types/index.ts`,
  `frontend/src/types/index.ts`) are the single canonical array — renaming
  or removing a value in it does **not** migrate rows already stored with
  the old value, since `applications.stage` is plain `TEXT` with no `CHECK`
  constraint; both the stage retirement and the `Applied` rename each
  required their own one-time data migration on top of the type change (see
  `schema.sql`).
- `status` — Active / Rejected / Withdrawn / Hold for Future / Joined / Closed
  (`'On Hold'` was retired and folded into `'Hold for Future'`; `'Closed'` was
  added later — see `applications_status_check` in `schema.sql`)
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

**A second, related failure mode (2026-09-05)**: `backend/src/db/seed.sql`'s
sequence-advance block at the bottom hardcoded `setval('seq_candidate', 1)`
(and the same for `seq_application`/`seq_interview`/`seq_refcheck`) instead
of computing it from `MAX(...)`, the way `seq_role`/`seq_agency`/
`seq_assignment` correctly do. Harmless against a genuinely empty database
(where those four tables have zero rows anyway), but re-running seed.sql
against a database that already has real data — e.g. `npm run db:reset`
without a full `docker-compose down -v` volume wipe — resets the counter
straight back to 1 while the table still holds thousands of existing rows,
so every subsequent INSERT collides on the primary key until the counter
climbs back past the old max. Fixed to use the same `MAX(...)` pattern
(wrapped in `COALESCE(...,0)`, since these four specifically can be
genuinely empty on a fresh DB, unlike roles/agencies/assignments which this
same script just seeded moments earlier). If a similar "everything's
failing with duplicate key on `<table>_pkey`" symptom ever recurs, check
`SELECT last_value, is_called FROM seq_<name>` against the table's actual
`MAX(id)` first — a stuck-low sequence is the same class of bug.

**A third, more severe failure mode, same day — every prefixed id was one
`LPAD` call away from silently colliding once its sequence grew large
enough.** `LPAD(str, N, '0')` **truncates** (keeps only the first N
characters) once `str` is already >= N characters long — it does not just
skip padding, the way you'd naively expect. Every `'PREFIX' ||
LPAD(nextval(seq)::TEXT, N, '0')` id default in `schema.sql` (`R####`
roles, `C####` candidates, `A####` applications, `IR####` interview
rounds — N=4; `AGN###` agencies, `ASN###` assignments, `BEN###` comp
benchmarks, `Q###` eval questions, `RC###` reference checks — N=3) was
exposed to this: the instant a sequence crossed `10^N - 1`, every following
id collided with an earlier one sharing the same truncated prefix (e.g.
once `seq_candidate` passed 9999, values 10380-10389 all produced the
identical id `'C1038'`). This is exactly what happened in local Docker
after months of this project's own testing pushed `seq_candidate` past
9999 — every subsequent candidate INSERT started failing with "duplicate
key value violates unique constraint candidates_pkey", cascading into
~180 unrelated Playwright failures across every test file that
transitively creates a candidate. `seq_application`/`seq_eval_question`
were both closing in on their own caps too (8880/9999 and 914/999) when
this was caught. Fixed everywhere (Supabase, local Docker, `schema.sql`)
with a shared `format_seq_id(seq, prefix, pad_width)` SQL function that
calls `nextval()` exactly once and only pads when the number is still
narrower than `pad_width` — see `schema.sql`'s own note next to it for the
full ALTER list. If a table's real row count ever gets anywhere near its
pad width again, this is already handled — ids just stop padding and read
one digit longer, no truncation possible.

### ResumeIQ — 8-dimension scoring
Located in `backend/src/services/resumeIQ.ts` and
`backend/src/services/driveService.ts`. Mirrors the `digitalpaani-candidate-
scoring` skill's rubric exactly: Technical, Experience, Industry Fit, Culture
Fit, Role Alignment, Trajectory, Leadership, Communication → average score,
strengths, red flags, executive summary, recommendation.

Triggered automatically the moment an application is **created** (at stage
`Applied and Screened` — there's no later "advance to Resume Review" step,
that stage was retired), via `runResumeIQScoring()` in
`backend/src/services/resumeIQTrigger.ts`, called from `candidates.ts`'s
`POST /` and `POST /:id/applications` and from `candidateIngest.ts`. Guarded
by `!app.score_avg` so it only ever runs once per application. **Synchronous
(awaited), not fire-and-forget** — see the Vercel serverless async rule
below; this was the exact bug class that rule documents, fixed at the same
time as JD generation.

**Resume text is fetched live from Google Drive** via a service account
(`hiring-master-drive-data@dp-hiring-master.iam.gserviceaccount.com`) —
`driveService.ts` handles PDF (via `pdf-parse` v2's `PDFParse` class — **not**
a default function export, that's a different API shape than v1), DOCX (via
`mammoth`), and native Google Docs (via export). Falls back gracefully to
profile-fields-only scoring if the fetch fails for any reason — this is
intentional, never make a failed Drive fetch a hard error.

**JD side of the comparison — closed.** `resumeIQ.ts`'s
`buildRoleRequirementsSection()` reads `roles.generated_jd_content` (the
same structured content the JD PDFs render from, persisted as JSONB
alongside the two Drive links at JD-generation time) when present, giving
the scoring prompt the full generated JD rather than just the three short DB
fields (`must_have_skills`/`nice_to_have_skills`/`kpi_expectations`). Falls
back to those same three fields, unchanged, for any role that hasn't been
through the Approved+JD-generation flow yet. See `ROADMAP.md` Phase 4.

**Externally-authored long-form JDs.** Not every role's JD is written by the
system — `roles.jd_source` (`'generated'` default, or `'manual'`) marks a
role whose long-form JD was drafted by hand outside HMS (a founder/HM-written
PDF) and imported via `backend/src/scripts/importManualJd.ts <pdf-path>
<role-id>`. That script uploads the source PDF as-is to Drive
(`jd_drive_link` points AT that exact file, never a system-rendered one),
extracts its text and runs it through `jdContent.ts`'s
`extractJdContentFromText()` — same target JSON shape and validation as the
normal `generateJdContent()`, but explicitly told to extract/condense only
what's in the source text, never invent — to populate
`generated_jd_content` (so ResumeIQ scores against the real external JD, not
short DB fields), then renders and uploads ONLY the social JD from that
content (the long-form PDF is never system-rendered for a manual role).
`jd_source='manual'` is checked in two places so this is never silently
overwritten: `roles.ts`'s auto-generate-on-Approve trigger skips entirely,
and `POST /:id/regenerate-jd` refuses with a 400. RoleDetail.tsx hides the
"Regenerate JD" button and shows an explanatory note instead, for the same
reason.

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

Candidate ingestion via the Job Application Form follows the same pattern
(`POST /api/candidates/ingest`, `backend/src/routes/candidateIngest.ts`,
shared-secret auth) and **is built** — this doc previously said otherwise,
which was stale.

### Naukri bulk import (no live webhook — Naukri has no self-serve API)
Naukri.com offers no public/self-serve API for pulling applicant data out of
an employer account — every real integration (Greenhouse, Zoho Recruit,
Keka, etc.) routes through a separate, commercially-negotiated, account-
manager-gated product ("Zwayam Amplify"), and even that has broken outright
for other vendors when Naukri changed its backend (Freshteam dropped its
Naukri integration entirely in 2023 for exactly this reason). Not worth
building against for this system.

The practical path instead: Naukri's own recruiter portal supports a manual
bulk export (Resdex/eApps → Excel, 500-2000 rows per download).
`backend/src/scripts/importNaukriExcel.ts` imports that export format
directly — `npx tsx src/scripts/importNaukriExcel.ts <path-to-excel>
<role-id> [--dry-run] [--skip-scoring]`. Reuses the same `candidates`/
`applications`/`activity_log` insert shape and `runResumeIQScoring()` call
as `candidateIngest.ts`, so an imported candidate behaves identically to one
that arrived through any other channel — same fill-null-only update for a
repeat email, same synchronous scoring at creation, same idempotency (safe
to re-run the same export). `role_id` is a required, explicit argument, not
auto-matched from the Excel's own "Job Title" text — a real export's title
("Process & Proposal Manager") didn't match this system's actual role title
("Manager – Process & Proposals") even after whitespace/dash normalization,
so guessing here risks silently linking to the wrong role. Doesn't populate
`resume_drive_link` (the export's candidate-profile link points at Naukri's
own portal page, not a fetchable resume file) or `expected_ctc` (the export
only has current salary) — ResumeIQ scores these candidates on profile
fields only, same graceful fallback as any candidate with no resume on file.

### Candidate gender auto-tagging (2026-09-28, dictionary rebuilt same day)
`candidates.gender` (`'M'` / `'F'` / `NULL`) is auto-computed server-side from
`full_name` at every candidate-creation code path (`candidates.ts`'s
`POST /`, `candidateIngest.ts`'s new-candidate branch, `importNaukriExcel.ts`'s
`findOrCreateCandidate()`), via `backend/src/utils/genderClassifier.ts`.
**`NULL` means "Unknown," a real and deliberate result** — an unrecognized
name, or a known unisex/ambiguous Indian name (Kiran, Simran, Manpreet, and
similar), is never force-guessed; gender is a sensitive attribute, and a
wrong tag is worse than an honest "don't know." The existing-candidate
`UPDATE` branches in `candidateIngest.ts`/`importNaukriExcel.ts` also
backfill `gender` fill-null-only (same pattern as every other profile field
there), so a repeat applicant or re-run Naukri import can still pick up a tag
it missed the first time.

**Dictionary**: `backend/src/data/indian{Male,Female,Ambiguous}Names.json`
(~3,860 / ~3,230 / ~300 first names) — built from two public real-world
datasets (github.com/mbejda's "Indian-Male-Names.csv" / "Indian-Female-
Names.csv", ~14.8k/~15.4k full-name rows) merged with this module's own
original hand-curated dictionary (Parsi/Christian/Anglo-Indian names
especially are underrepresented in an India-scraped dataset, so the curated
list stays a permanent additional source, not a one-time seed). A name
appearing under both genders in the source data is resolved by strong
majority (5x+, 5+ total occurrences) or else filed as ambiguous rather than
guessed — this is where the "genuinely unisex" exclusions come from, not
just this module's own hand-picked list. **Re-run
`npx tsx src/scripts/rebuildGenderNameData.ts`** to regenerate the three
JSON files if either source dataset is ever updated, or to fold in another
one (add its URL to that script's `SOURCES` array) — it's a full rebuild
from source each run, so a one-off manual correction to a specific name
needs to go in that script's own `MANUAL_OVERRIDES`, not a direct edit to
the generated JSON (which won't survive the next rebuild).

**"Kaur" surname signal**: checked first, ahead of even the dictionary —
Sikh women take it specifically and deliberately to signal their own gender
(paired with "Singh" for men), closer to a first-person declaration than a
name-frequency guess. Found via real production records this dictionary got
wrong otherwise: "Amritpal Kaur"/"Kulvinder Kaur" are genuinely unisex Sikh
first names the dictionary (reasonably) defaults to male from thin source
data, but the person's own "Kaur" says otherwise. Checked against real data
for a counter-example and found none — the rare "Kaur" rows in the source
male-names dataset were garbled artifacts, not genuine male bearers.
**Deliberately does NOT do the mirror-image "Singh → male"** — checked
against this system's own real candidate data and found genuine, clean
counter-examples ("Monika Singh", "Ankita Singh", "Pooja Singh", "Akanksha
Singh" are real women in production). Unlike "Kaur", "Singh" is ALSO an
ordinary hereditary family surname across Hindu Rajput/Kshatriya communities,
carried by sons and daughters alike, completely independent of the Sikh
gender-marking convention — not a safe signal on its own despite the
tempting parallel. A handful of genuinely unisex low-sample-size Sikh names
without a "Kaur" to disambiguate them (e.g. a male "Daljit Singh", where the
dictionary alone defaults to female from a single source sighting) remain a
known, accepted, HR-correctable limitation at this scale.

Real-world validation: sampled 300 random production candidate names and ran
the classifier directly before/after each change, cross-checking suspicious
results against the raw source CSVs rather than assuming a dataset label was
correct — this is how the Kaur-vs-Singh asymmetry above was discovered, not
guessed at. Production backfill (`backfillGender.ts`): 1093 candidates,
823 tagged (~75%) / 270 Unknown after all of the above.

Plain, HR-editable field via `PATCH /api/candidates/:id` (not read-only) —
the auto-tag is best-effort, and HR can always correct it. Filterable via
`?gender=M/F` on both `GET /api/candidates` and `GET /api/applications`
(candidates.ts/applications.ts, same hand-rolled `AND c.gender = ANY($n)`
pattern as their existing `q`/`skills`/`tag` filters — this is a
candidate-level filter, not a role-level one, so it does NOT live in
`roleFilters.ts`). The Gender filter dropdown (all 3 pages below) also
offers a third option, **"Not tagged"** — sent to the API as the literal
string `gender=UNKNOWN`, a frontend-only sentinel with no matching DB value.
Both routes special-case it to `c.gender IS NULL` OR'd alongside the normal
`= ANY(...)` match on any other selected values, since `x = ANY(array)` can
never match a SQL NULL no matter what's in the array — selecting Male +
"Not tagged" together correctly returns the union of both, not neither.
Shown as a "Gender" column (via the shared `GenderBadge`
component, `components/shared/Badges.tsx` — plain M/F, or a dash for
Unknown) immediately after the candidate-name column on every page that
lists candidates: Active Candidates (`Candidates.tsx`), Archived Pipeline
(`TalentPool.tsx`), and My Tasks' "Ready for Review" (embedded
`ScorecardSummary.tsx` — note its `SCORECARD_COLS_BEFORE_DIMS` colSpan
constant had to bump from 10 to 11 to account for the new column). These are
three fully independent hand-written JSX tables, not a shared component —
a future column/filter addition needs the same edit made three times.

One-time backfill for existing candidates missing the tag:
`npx tsx src/scripts/backfillGender.ts [--dry-run]` — fill-null-only (never
overwrites an already-set value, whether auto-tagged or HR-corrected), safe
to re-run.

### PWA installability (2026-09-28) — installable icon only, NOT offline-first
`vite-plugin-pwa` (`frontend/vite.config.ts`) adds a web manifest + a minimal
Workbox service worker so the app can be added to a phone/desktop home screen
and launch full-screen with no browser chrome. This is **installability
only** — it does not make the app work offline, and deliberately never will:
there is no scenario where an HR user needs live candidate/role data with no
internet, and caching an API response at all risks a lost/shared/logged-out
device still showing stale candidate PII (CTC, scores) offline. Every
`/api/*` GET is an explicit `NetworkOnly` Workbox route (`vite.config.ts`'s
`workbox.runtimeCaching`) — never intercepted or served from cache, always a
real network round-trip; only the built JS/CSS/HTML app shell + icons are
precached. `registerType: 'autoUpdate'` (`skipWaiting`+`clientsClaim`, wired
via `main.tsx`'s `registerSW({ immediate: true })` from
`virtual:pwa-register`) means a new deploy takes over silently on next load —
no "update available" prompt UI — since a stuck-on-stale-bundle install would
be a worse failure than an unannounced refresh for an internal tool.

**PWA-ness alone doesn't fix mobile/tablet usability** — that's a separate
concern. The sidebar half of it is now fixed (below, 2026-09-28): `Layout.tsx`/
`Sidebar.tsx` collapse to a hamburger-triggered overlay drawer below `lg:`
(1024px — deliberately not `md:`/768px, since an iPad portrait at 768-834px
still needs to collapse too; "mobile and tablet" both sit below `lg:`, only
real desktop/laptop widths stay above it). **Still open**: 5 of 15 pages
still handle dense HR tables purely via horizontal scroll rather than a
narrow-width card reflow — an installed app with a working sidebar but an
unreadable 10-column table on a phone is still only half fixed.

### Sidebar mobile/tablet collapse (2026-09-28)
`Sidebar.tsx` takes `open`/`onClose` props (owned by `Layout.tsx`'s
`sidebarOpen` state, defaulting to closed) instead of rendering unconditionally.
Below `lg:`, it's `fixed` + translated off-screen by default (a real overlay,
outside document flow, so it doesn't reserve any width when closed) and
slides in over a `bg-black/40` backdrop when opened via `Layout.tsx`'s
hamburger button (only rendered below `lg:`); at `lg:`+ it reverts to the
original `sticky`, always-visible, in-flow behavior via a `lg:` breakpoint
override on the same `position` utility, and `open` has no visible effect.
Backdrop click, Escape, and clicking any nav link (`onClick={onClose}` on
every `NavLink`) all close the drawer; body scroll is locked via
`document.body.style.overflow` only while the drawer is open below `lg:`.
Hand-rolled rather than pulling in a Headless-UI-style dialog primitive
(this codebase has none today) — deliberately scoped to exactly the
"sidebar eats the whole phone screen" complaint that prompted it, not a
general modal/dialog abstraction speculatively built ahead of a second use
case.

**Known real risk, not yet resolved**: this app's Google sign-in
(`Login.tsx`'s inline Google Identity Services button/popup pattern) has a
documented compatibility problem running inside an installed/standalone-mode
PWA on iOS — the OAuth popup can hang because the app can't receive its
response in that display mode. Fixing this needs the login page to detect
standalone mode (`navigator.standalone` / `(display-mode: standalone)`) and
fall back to a redirect-based flow there instead of the popup — **not yet
implemented**, and must be verified on a real iPhone (not Chrome DevTools
device emulation) before telling any HR user to install the app on iOS.

**Real bug hit and fixed the same day**: `Help.tsx` links straight to two
static PDFs in `public/` (`DigitalPaani_HMS_User_Access_Guide.pdf`,
`DigitalPaani_Hiring_SOP.pdf`) via a plain `<a href="/....pdf" target=
"_blank">` — a real top-level browser navigation, not client-side routing.
Workbox's `NavigationRoute` (registered by `generateSW` to make the SPA's
own client-side routes work offline) intercepts **every** navigation request
and serves the cached `index.html` app shell instead, unless the path is on
`navigateFallbackDenylist` — the original config only excluded `/api/`, so
clicking either PDF link served the cached SPA shell instead of the actual
file, and the router's own `path="*"` catch-all then redirected straight to
`/dashboard` — a silent, confusing bounce for something that looked, and
tested via curl, completely fine (a plain `curl` request bypasses the
service worker entirely, so it never reproduced this). Fixed by adding
`/\.[a-zA-Z0-9]+$/` to `navigateFallbackDenylist` alongside `/^\/api\//` —
any path with a dotted extension is never a real SPA route in this app, so
it's excluded from the fallback outright. Any *future* direct link to a
static file in `public/` needs no special handling — this fix already
covers it.

Icons (`frontend/public/icons/icon-{192,512}.png`,
`frontend/public/apple-touch-icon.png`) are cropped from the existing
`backend/src/assets/dp_logo_white.png` droplet+recycle glyph on the brand's
navy-800 (`#002454`) background — iOS ignores manifest icons entirely and
needs its own `<link rel="apple-touch-icon">` in `index.html`, which is
separate from the three manifest.json entries.

Verification note: the plugin's dev-mode service worker registration
(`devOptions.enabled`) was deliberately left off (default) so local `npm run
dev` is unaffected; the manifest/service-worker were verified via a real
`npm run build && npm run preview` production build (manifest.webmanifest
content, generated `sw.js`'s precache list, and its `NetworkOnly` `/api/`
route were all inspected directly) — actual browser install-prompt/service-
worker-registration behavior could not be observed inside this session's own
sandboxed Browser-pane Chromium build specifically (service worker
registration fails there even for a trivial one-line test worker, on every
origin, which points to that pane disabling Service Workers entirely rather
than anything specific to this app) — verify registration in a real desktop
Chrome tab or on a real device before relying on it.

### Portfolio review — the 9th ResumeIQ dimension (2026-09-30, Senior UX/Product Designer)
For roles with `roles.portfolio_analysis_enabled = true` (**R007 only**, set by
SQL — deliberately no API/UI toggle), a candidate's portfolio site(s) are opened in
a real browser and reviewed by a vision model against the JD and the hiring
manager's 15 criteria (`backend/src/services/portfolio/rubric.ts`,
`DESIGNER_CRITERIA`). The result is a 9th dimension, `applications.score_portfolio`
(0-10), **folded into `score_avg`/`ai_fit_score`** (so it moves SLA tiering and the
75+ 24h threshold for this role — chosen deliberately, not informational-only), plus a
stored structured review shown in the highlights.

**Never inline in the scoring request** — a review takes ~35-140s. Flow:
1. `runResumeIQScoring()` (unchanged 8-dimension score, written first) → for an
   enabled role it fetches the resume with `fetchResumeTextAndLinks()` (same single
   Drive download) → `pickPortfolioLinks()` → `preparePortfolioReview()`
   (`portfolio/enqueue.ts`): stores `portfolio_urls`, status `pending`, and
   `send()`s `{applicationId}` to the Vercel Queue topic `portfolio-analysis`. A
   resume with no portfolio link settles instantly as `no_portfolio` with a
   dimension score of 0 (and a red flag) — but only if the resume was readable;
   an unreadable resume applies no dimension at all.
2. **`backend/api/portfolio-worker.ts`** — a separate Vercel function (300s, its
   own ~80 MB bundle with Chromium; `vercel.json` `experimentalTriggers`
   `queue/v2beta`) runs `runPortfolioAnalysis()` (`portfolio/run.ts`): atomically
   *claims* the row (a redelivered message can't run twice), captures with
   `puppeteer-core` + `@sparticuz/chromium`, calls Claude with screenshots, writes
   via `applyPortfolioOutcome()` (`portfolio/scoring.ts`). **It has no HTTP entry
   point and cannot have one**: a Vercel queue consumer has no public URL (Vercel
   documents it as air-gapped), so a secret-protected "direct run" route was
   unreachable dead code and was removed after a pre-merge review caught it.
   The deployed function is verified only through the queue — press Re-run on one
   application and watch `portfolio_analysis_status`/`_error`. Running a review
   outside the queue is a local-only thing: call `runPortfolioAnalysis(id)` from a
   `tsx` script (optionally with `PORTFOLIO_BROWSER_WS_ENDPOINT`).
   `vercel.json`'s trigger also sets `maxDeliveries: 3` (= `MAX_ATTEMPTS`) — the
   one case `run.ts` can't see is a hard kill (OOM, the 300s limit), where no JS
   runs to ack or throw; without a cap that message is redelivered, and billed at
   the full 300s x 2 GB, until its 24h TTL — and `maxConcurrency: 5`, which keeps a
   bulk backfill from firing ~150 vision-model calls at once.
3. Status `portfolio_analysis_status`: `pending | running | completed | failed |
   no_portfolio | inaccessible`. **`inaccessible` (dead/private link) is held against
   the candidate; `failed` (our timeout/crash) never is** — `capture.ts`
   distinguishes them, using an independent plain request to tell "site is dead"
   from "site refused our browser".

**Import boundary that must not be crossed:** `browser.ts`, `capture.ts`, `analyze.ts`,
`run.ts` are WORKER-ONLY. The main API imports only `links.ts`, `enqueue.ts`,
`scoring.ts`, `rubric.ts`, `types.ts` — verified with `@vercel/nft` that the main
bundle (~64 MB) contains no Chromium/puppeteer. Importing a worker module from the
Express app would drag 70 MB of Chromium into every request's function.

**Recovery and retry semantics (added after an adversarial review):**
- `STALE_RUNNING_SECONDS = 310` (`portfolio/jobState.ts`) is the single definition of "this job is
  dead". It sits deliberately between the function's 300s hard limit and the queue's 330s
  visibility timeout: a killed function never runs its `finally`, so its row would say `running`
  forever — the redelivered message (>330s) and an HR Re-run (route checks the same threshold)
  can both reclaim it, while a live job (<300s) is never stolen. The status reset in
  `preparePortfolioReview` is a *conditional SQL UPDATE*, not a read-then-write, so a worker
  claiming the row between the two can't have its state stomped.
- Only OUR transient failures are retried: `run.ts` `isTransient()` (browser busy/launch, model
  429/529/timeouts) hands the job back to `pending` and THROWS on attempts 1-2 so the queue
  redelivers (120s later, fresh invocation + budget); attempt 3 (`MAX_ATTEMPTS`) or a direct
  run records `failed`. Settled outcomes (completed/inaccessible/no_portfolio) return normally
  = acknowledged, so a dead portfolio site is never retried. A review that would conclude
  "no usable portfolio" while another link *errored on our side* fails (retryable) instead of
  scoring the candidate down on an incomplete look.
- **Text guards (`portfolio/text.ts`).** `hasReadableText()` — an image-only (scanned) PDF
  "extracts" successfully to nothing but pdf-parse's page markers (`-- 1 of 1 --`), so a
  non-null string is not proof the resume was read; used (portfolio path only — base
  `resumeRead` semantics are unchanged for every role) so such a resume isn't scored 0 as
  "no portfolio link". `jsonbSafeStringify()` — a page title cut by `.slice(0, 200)` can end
  mid-emoji; `JSON.stringify` then emits a lone `\ud83d` escape that PostgreSQL's jsonb
  rejects, which failed the whole review write on every Re-run. Everything stored in
  `portfolio_analyses` goes through it.
- One Chromium per process (`browser.ts` `acquireBrowserSlot`): Fluid compute packs concurrent
  invocations onto one instance and `@sparticuz/chromium` treats "/tmp/chromium exists" as
  "extracted" (upstream Sparticuz/chromium#507), so a second cold-start invocation could launch a
  half-written binary. A waiter that can't get in within 45s throws `BrowserBusyError` (transient
  → queue redelivers). `/tmp/.chromium-ready` marks a finished extraction; a truncated leftover
  is wiped. `--disable-web-security` is filtered out of the Lambda launch args (a hostile page's
  script could otherwise read cross-origin responses).
- `POST /:id/portfolio-analysis` never changes state when the resume can't be read right now
  (502): a transient Drive failure used to look like "no links", wiping stored links and turning a
  good review into `no_portfolio` with the old score still in the average. Likewise a failed
  *link extraction* (`fetchResumeTextAndLinks().linksError`) records `failed`, never a 0.
- Backfill paging steps over rows that stay eligible (`next_offset = offset + left_unchanged`), and
  refuses a role that doesn't exist or isn't flagged — a naive "same offset again" loops forever.
- The automatic `Portfolio Review Completed` event is excluded from the dashboard's "no recent
  candidate movement" flag (`dashboard.ts`), like `ResumeIQ Scoring Completed` — otherwise every
  auto-review would make R007 look active.

**SSRF (`urlSafety.ts`):** every fetch of a resume-supplied URL goes through `safeFetch` (each
redirect hop re-validated), and every browser request through `makeHostChecker` (DNS-resolved, cached
per crawl) — not just a string check. The first version missed IPv4-mapped IPv6 (`new URL()` rewrites
`[::ffff:127.0.0.1]` to HEX `::ffff:7f00:1`, which a dotted-quad regex never matches) and trailing-dot
names (`localhost.`); `isPrivateIp` now expands IPv6 fully (mapped, NAT64, 6to4, Teredo, ULA, link-local).
Residual risk: a DNS-rebinding attacker can still race the lookup. **Also `normalizeUrl` is length-capped
(2048) with a linear trim — a 100 KB punctuation run used to freeze the API for ~15s (quadratic regex),
and that path runs for every role's scoring, not just designers.**

**Things learned the hard way (each caught by testing on real data / a real runtime, not by reasoning):**
- `@sparticuz/chromium` runs **single-process** on Lambda — `browser.createBrowserContext()`
  crashes it ("Target closed"). Use `browser.newPage()`. Found only by running the
  capture code in the `public.ecr.aws/lambda/nodejs:22` image with
  `AWS_EXECUTION_ENV=AWS_Lambda_nodejs22.x` set (without that variable the package never
  unpacks its bundled system libs).
- It's ESM-only; the backend compiles to CommonJS. `require()` of it works on Node
  >= 22.17 (its `engines` floor), so `backend/package.json` pins `"node": "22.x"` and
  `src/types/sparticuz-chromium.d.ts` declares the surface we use.
- Every browser step has a hard cap (`protocolTimeout` 45s, screenshot 20s, 100s per
  portfolio, 270s job budget). Puppeteer's default is 180s *per CDP call*; one stalled
  Figma WebGL screenshot once consumed a 9-minute test run.
- A server-side link check gives false "broken" results (Figma answers `HEAD` with 404, bot
  walls, JS-only apps). Suspects are re-checked with `GET`, then confirmed in the real
  browser before counting. Do not weaken this — a false positive caps the "portfolio UX"
  criterion for an innocent candidate.
- Resumes link employers, universities, SSO pages and resume builders next to the real
  portfolio. `pickPortfolioLinks()` uses candidate-name-in-host, the hyperlink's own
  label ("Portfolio"), and a penalty list (`.ac.in`, `sso.`, IP hosts, resume builders).
- Real hyperlinks are the majority signal: in a 30-resume sample, ~39% of resumes with a
  portfolio had it *only* as a hyperlink (invisible to text extraction).
  `fetchResumeTextAndLinks()` reads PDF Link annotations (`pdf-parse` `getInfo`), DOCX
  hyperlinks (`mammoth.convertToHtml`), Google Docs HTML export, and regex-scans the text.

**Trust boundary:** portfolio pages are attacker-controlled. Page text/titles/URLs are
escaped (`escUntrusted`, angle brackets swapped) so a page can't forge a closing
`</portfolio_content>` tag; the system prompt forbids following in-page instructions;
prompt-injection detection is a separate boolean (`attemptsToInfluenceReviewer`) that
*code* turns into a red flag (the model once reused the wording to accuse a candidate of
injection for a name mismatch). `urlSafety.ts` blocks private/loopback/metadata addresses
for every URL we fetch or the browser requests. The reviewer also checks the portfolio
belongs to the candidate (`belongsToCandidate`) — a resume linking someone else's work is
an integrity flag. Verified with a live adversarial test (a page containing a fake
`SYSTEM OVERRIDE` + tag breakout scored 0 and was flagged).

**Scoring math:** the model's holistic 0-10 and a checklist score (strong 1 / partial 0.6 /
not_evidenced 0.2 / concern 0, over the 15 criteria) are averaged — steadier run to run than
either alone. `html_based` is decided from the platform (own domain / Framer / Webflow strong;
template builders partial; Behance / Figma file / PDF a concern) and `portfolio_ux` is capped
by measured broken links and mobile overflow, whatever the model said. `computeAvg()` always
derives the average from the 8 stored base scores + this run's portfolio score, so a re-run
can never double-count. The `score_summary` gets ` Portfolio review: …` appended and
red flags get a `Portfolio: ` prefix; both are stripped and rewritten on each run.

**Storage:** the review JSON lives in its own table `portfolio_analyses` (not on
`applications`) so `SELECT a.*` list queries stay light; fetched lazily by
`GET /api/applications/:id/portfolio-analysis`. Screenshots are not stored.

**Ops:** `POST /api/applications/:id/portfolio-analysis` (HR-tier) re-extracts links and
re-queues (also the way to pick up a link the first pass missed).
`POST /api/applications/portfolio-backfill` (`x-ingest-secret` = `ROLE_INGEST_SECRET`,
body `{role_id, statuses, limit<=10, offset, dry_run}`) queues existing applicants that
were never reviewed, a few per call (each re-reads a resume from Drive); loop until
`next_offset` is null — or just run `backend/src/scripts/backfillPortfolioReviews.ts`
(`HMS_API_URL=<backend url> ROLE_INGEST_SECRET=... npx tsx src/scripts/backfillPortfolioReviews.ts
--role R007 [--statuses Active] [--dry-run]`), which does that loop and only *queues* (the
reviews then run on the worker, ~1-2 min each). Env: `PORTFOLIO_ANALYSIS_MODEL` (default `claude-sonnet-4-5`),
`PORTFOLIO_BROWSER_WS_ENDPOINT` (attach to a hosted/remote Chrome over CDP instead of
embedded Chromium — the escape hatch if Chromium proves unreliable on Vercel, e.g.
Browserbase), `PORTFOLIO_CHROME_PATH` (local dev). Local dev needs a Chrome/Chromium on
the machine; the Docker backend container has none and never needs one (it only queues).
Local `@vercel/queue` `send()` fails outside Vercel by design → the row stays `pending`
with a visible "Could not be queued" message; run a review locally by calling
`runPortfolioAnalysis(applicationId)` from a `tsx` script with `DATABASE_URL` set.

**Known limits:** Figma *file* links are canvas-rendered — one overview screenshot only,
and private files are reported as inaccessible, not scored; PDF/slide-deck links are not
opened (flagged for manual review); criteria like field visits or business outcomes can
only be judged from what the site states, so absence is "not evidenced", never a concern.
R007's `generated_jd_content` was set on 2026-10-01 from the published long-form JD
(`DP_JD7_Senior_UX_Product_Designer.pdf`, loaded by SQL — R007 has no `jd_drive_link`,
that JD was made outside HMS), so both the base 8-dimension scoring and the portfolio
JD alignment compare against the full JD for applications created from then on;
already-scored applicants keep the score they got against the short DB fields.
**Do not press "Regenerate JD" on R007 expecting it to keep that content** — it
(`roles.ts`) overwrites `generated_jd_content` with a fresh Claude-generated version
(`jd_source` is still `'generated'`).

### SLA / aging checks — compute-on-read, not cron
Vercel Hobby tier does not support sub-hourly cron, so the SLA checker
(`backend/src/jobs/slaChecker.ts`) does **not** rely on a scheduler in
production. Instead, `dashboard.ts` calls `runSlaCheck()` opportunistically on
every dashboard load, throttled to once every 3 minutes per serverless
instance. `runSlaCheck()` itself is a pure, idempotent function safe to call
anytime — if you ever need to trigger it manually or from a different route,
just call it directly; it doesn't assume it's running on a timer.

**Score-tiered thresholds (Hiring SOP v2.1, 2026-09-18):** at Applied and
Screened, Interview Round 1/2, Founders Round, and Assignment Round, the
standard 48h SLA drops to 24h for a high-scored candidate
(`ai_fit_score >= 75`) — both the HR-facing side (shortlist/scheduling/send)
and the Hiring-Manager-facing side (feedback due). `slaChecker.ts`'s
`tieredStandardHours()` is the single place this branches; `BREACH_IDLE_HOURS`
(Idle Candidate) and `BREACH_ASSIGNMENT_FEEDBACK_HOURS` (Assignment Feedback
Due, 96h) are deliberately untouched — the SOP frames this as a 48h->24h
change for five named stages, not a blanket halving. Role aging thresholds
(`AGING_THRESHOLDS`, `backend/src/types/index.ts`) were also revised in the
same SOP update — see that constant's own comment for the exact per-priority
numbers and the reasoning Aaron confirmed for them.

**Leadership escalation on stale feedback:** if a Standard-round (Interview
1/2, Founders) "Feedback Due" breach is still open 96h after the interview —
independent of whether it was a 24h or 48h breach to begin with — HMS raises
a second, Leadership-owned flag (`'Feedback Overdue — Leadership Escalation'`,
`NON_ACTIONABLE_ALERT_TYPES`) alongside the original Hiring-Manager-owned one,
which stays open until feedback is actually submitted. This is additional
visibility, not a replacement.

**Low Pipeline Roles redefined:** was "fewer than 5 Active applications,
any stage/score" — now "fewer than 3 applications that have both been
shortlisted (stage past Applied and Screened) **and** scored above 60 on
ResumeIQ" (`shortlisted_scored_count` in `dashboard.ts`), so a pipeline full
of unqualified applicants no longer reads as healthy just because it's
numerous.

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
