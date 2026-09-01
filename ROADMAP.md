# DigitalPaani HMS — Roadmap

> Living document. Update checkboxes and add notes as work completes — this is
> the shared source of truth for "what's done" and "what's next," meant to be
> read at the start of every session alongside `CLAUDE.md`.

---

## Security — Immediate

- [x] Separate Postgres sequences for `eval_questions` and `comp_benchmarks`
      (previously shared one sequence, causing duplicate-key crashes)
- [x] GIN indexes on `candidates.parsed_skills/parsed_industries/hr_tags` and
      `applications` AI/score array columns
- [ ] **RLS (Row Level Security) on all 14 Supabase tables** — currently
      disabled everywhere. The Supabase anon key is exposed client-side, so
      right now anyone with browser dev tools could query `ctc_band`,
      `internal_risk_notes`, and other sensitive fields directly against
      Supabase, completely bypassing the Express/JWT access control layer.
      **This is the single highest-priority open item.**

---

## Phase 1 — Core backend (complete, historical reference)

Multi-persona auth, role management (CRUD, edit log, CTC change trigger,
aging), candidate pipeline 3-field state model, application stage machine +
SLA, rejection/withdrawal enforcement, Founder Review Flag, ResumeIQ trigger,
assignment repo, interview rounds + feedback scoring, reference checks, agency
repo, dashboard KPIs, eval questions + comp benchmarks, all 32 original API
routes, activity log. Google OAuth. Vercel + Supabase + GitHub deployment
live.

---

## Phase 2 — Make the product usable

- [x] Interview feedback form UI (`InterviewFeedbackModal.tsx`)
- [x] Schedule interview round modal (`ScheduleRoundModal.tsx`)
- [x] ResumeIQ score display — rebuilt as full 8-dimension table
      (`ResumeIQPanel.tsx`), matching the `digitalpaani-candidate-scoring`
      skill's output format exactly
- [x] HM Queue page (`HMQueue.tsx`) — shortlist decisions + feedback due.
      **Superseded in Phase 5** — renamed to "My Tasks" (`MyTasks.tsx`,
      `/my-tasks`), now visible to every persona instead of just
      `hiring_manager`/`leadership` (the `interviewer` persona referenced
      here no longer exists — merged into `hiring_manager` earlier in the
      project, see the bug-fix log at the bottom of this file).
- [x] SLA checker fixed for Vercel — compute-on-read pattern in
      `dashboard.ts`, since Vercel Hobby doesn't support the 15-min cron the
      original design assumed

---

## Phase 3 — Role creation, JD generation & inline editing

- [x] **Requisition Form → Role ingestion.** Live in production. Apps Script
      on the Requisition Sheet POSTs new rows to `/api/roles/ingest`, creates
      role in `Draft` status, fully mapped (department, hiring manager,
      priority, new/replacement, vacancy reason, appointment type,
      qualification, must/nice-to-have skills, YOE, CTC band, JD text,
      remarks, dates). Deduped via `requisition_source_row`.
- [x] **JD generation on role status → Approved.** Live. Auto-triggers (not a
      manual button) on the Draft/Under Review → Approved transition, guarded
      by `!jd_drive_link` so it only runs once per role. Claude condenses raw
      role fields into structured content (`jdContent.ts`), then two Node/TS
      renderers ported from the `digitalpaani-long-jd`/`digitalpaani-social-jd`
      skills' ReportLab source produce the PDFs (`pdf/longFormJd.ts` via
      pdfmake, `pdf/socialJd.ts` via pdfkit — colors/fonts/layout ported 1:1,
      verified by rendering and visually inspecting output against the
      skills' reference PDFs). Uploaded to Drive via domain-wide delegation
      (`GOOGLE_DRIVE_IMPERSONATE_EMAIL` — a bare service account has no Drive
      storage quota of its own, confirmed against the real API). Links shown
      on the role detail page's Links & Assets card; a "Change status"
      control was added since none existed before (needed to actually reach
      Approved from the UI).
- [x] **Inline editing — Roles, Candidates, Agencies.** Live. One reusable
      component (`components/shared/EditableSection.tsx`, config-driven,
      per-section Save/Cancel) applied to all three entities:
  - **Roles**: was closest to pure frontend work — backend `PATCH /:id` was
    already fully whitelisted with an edit log; just needed ~12 missing
    fields added to the frontend `Role` type. `ctc_band` hidden entirely for
    non-HR personas (not masked — not rendered).
  - **Candidates**: the `PATCH /:id` allowlist was stale — it only accepted
    legacy `parsed_*` fields, silently no-opping on every real profile field
    actually shown on screen (`current_company`, `current_ctc_fixed`, etc.).
    Fixed the allowlist; added `candidate_edit_log` (new table, same shape as
    `role_edit_log`).
  - **Agencies**: had no detail page at all — only a list view. Built
    `AgencyDetail.tsx` + `/agencies/:id` route + row-click wiring from
    scratch; added `agency_edit_log` (new table).
  - All fields editable including Drive links (`resume_drive_link`,
    `jd_drive_link`, etc.) per explicit scope decision — excluded only
    IDs/timestamps/computed-only fields. `status` stays out of scope on
    Roles (already has its own dedicated Change Status modal).
  - Verified end-to-end in-browser for all three entities: edit/save
    persists + logs correctly, Cancel discards with zero API calls, non-HR
    persona gating confirmed on `ctc_band`.

---

## Phase 4 — Candidate ingestion & scoring fidelity

- [x] **Candidate ingestion from the Job Application Form.** Live. Same
      Sheet→AppsScript→webhook pattern as Phase 3's role ingestion
      (`POST /api/candidates/ingest`, `candidateIngest.ts`, shared-secret
      auth via `CANDIDATE_INGEST_SECRET` — a dedicated secret, not a reuse
      of `ROLE_INGEST_SECRET`, since this endpoint carries candidate PII).
      Email (trimmed + lowercased) is the natural dedup key: a new email
      creates a candidate row, a known email finds it and does a
      fill-null-only update so a resubmission can never clobber HR's
      inline-edit corrections (Phase 3). The free-text "role applying for"
      answer — one shared Google Form serves all roles, so this isn't a
      role_id already — is matched by normalized exact title against
      non-closed roles; zero or multiple matches degrade gracefully (the
      candidate row still gets created/updated, just no application row),
      logging an `activity_log` entry (`Unmatched Role — Manual
      Reconciliation`) for HR to resolve by hand rather than failing the
      whole webhook call. A clean match creates an `applications` row
      (`stage='Applied'`, source `'Job Application Form'`), reusing the
      exact insert shape `candidates.ts`'s manual creation route already
      uses. Verified live against local Docker: fresh candidate + matched
      role, duplicate resubmit (no-op), same email + second role (reuses
      candidate, adds a second application), and unmatched role name (degrades
      gracefully) all behave as designed. Along the way, fixed the
      `Candidate` TypeScript interface, which was missing all 11 real
      profile columns (`current_ctc_fixed`, `expected_ctc`,
      `resume_drive_link`, etc.) — the columns themselves were already live
      in both Docker and Supabase, just never reflected in the type, which
      is what was causing several pre-existing `npx tsc --noEmit` errors in
      `resumeIQ.ts`/`applications.ts`.
- [x] **ResumeIQ scores against the generated JD document.** Live. The
      structured content `jdContent.ts` generates for the JD PDFs (narrative,
      condensed key responsibilities, must-haves/good-to-haves, tags) was
      being discarded after rendering — persisted it instead as
      `roles.generated_jd_content` (JSONB), written alongside the two Drive
      links in the same JD-generation trigger. `resumeIQ.ts`'s
      `buildRoleRequirementsSection()` reads it when present, giving the
      scoring prompt a genuinely fuller picture of the role than the three
      short DB fields (`must_have_skills`/`nice_to_have_skills`/
      `kpi_expectations`) ever did. Falls back to those same three fields,
      byte-for-byte unchanged, for any role without generated content — no
      behavior change for roles not yet through the Approved+JD-generation
      flow. Verified both code paths directly against real data (R008).
- [ ] **Drive auto-folder creation** on Role and Candidate creation — every
      role/candidate should get a Drive folder automatically; currently none
      do. (`driveService.ts` already has working Drive API access via the
      service account, including a write-capable client added for JD PDF
      uploads via domain-wide delegation — this needs a `createFolder`-
      equivalent added there.) *Moved from Phase 3 — everything else in that
      phase is done; this one fits more naturally alongside Phase 4's
      candidate-ingestion work.*
- [x] **Resume text fetched from Google Drive** — done. Real PDF/DOCX/Google
      Doc extraction via service account, wired into the scoring trigger,
      confirmed working end-to-end (verified with a real resume producing a
      real, differentiated score vs. the profile-only fallback).
- [ ] Offer letter generation + UI
- [ ] Pre-joining documents checklist
- [ ] Email digest (currently a stub that returns `ok` — no actual sending)

---

## Phase 5 — Pipeline simplification, ownership-scoped worklists, UI polish

- [x] **Stage model simplified — 'Resume Review' and 'Shortlisted' retired.**
      `STAGE_ORDER`/`STAGES` cut from 13 to 11 stages. Every application
      starts at `Applied` and is scored by ResumeIQ automatically and
      synchronously at creation (`resumeIQTrigger.ts`'s
      `runResumeIQScoring()`, called from `candidates.ts` and
      `candidateIngest.ts`) rather than on a later stage transition.
      "Shortlisting" is now a direct `Applied` → `Interview Round 1` move,
      open to every persona from `Applied` specifically (still HR-tier-only
      for every other transition). Touched the budget-exception gate, the
      SLA breach engine (`Idle Candidate` no longer covers `Applied`;
      `Resume Shortlist Pending` retargeted to `Applied`; the old
      `Interview to be Scheduled` breach dropped as redundant with
      `Interview 1 Not Scheduled`), Source Quality's Pass Rate definition,
      and Roles' `Active Shortlist` count. A one-time data migration moved
      every already-existing application off the two retired stage values
      on both local Docker and production Supabase (documented in
      `schema.sql`) — removing a stage from the type doesn't touch rows
      already sitting at the old value.
- [x] **Role approval restricted to HR-tier.** A Hiring Manager can no
      longer approve even their own role (`PATCH /:id`'s `isHmForThisRole`
      carve-out removed — the whole route is now `isHRTier`-gated).
      Approver name/date are captured and shown; Open Date copies from
      Approval Date the same moment, feeding Role Age.
- [x] **Aging Roles widened** to list every `Approved`/`Live – Sourcing`/
      `On Hold` role (not just overdue ones), with alert coloring only for
      roles actually past their Close Target.
- [x] **"My Tasks"** (renamed from "My Queue", `MyTasks.tsx`, `/my-tasks`,
      visible to every persona). Its "Ready for review" section is scoped
      per persona: HR/Admin & Super Admin see every `Applied` candidate
      unfiltered; a Hiring Manager sees only their own role(s); Leadership
      sees only candidates flagged for Founder Review
      (`founder_review_flag`) — the one existing Leadership-specific
      concept tied to individual applications, rather than either
      "everything" or "nothing".
- [x] **Column-order consistency** across Candidates, Talent Pool, and
      Scorecard Summary (Candidate → Role → Stage → \[Status on Talent
      Pool] → Fit → CTC → ECTC → Notice → Preferred Location → Company /
      Industry → Resume Link → \[scoring section on Scorecard] →
      Application Date → Last Updated/Last Added → Actions). Talent Pool
      rebuilt from a card layout into a table (one row per candidate ×
      application, preserving the "show full application history" behavior
      the cards had). Candidates gained a sortable Application Date column
      (plus Fit/Last Updated made sortable too).
- [x] Dashboard KPI cards enlarged; Hiring Funnel Snapshot's local Role
      filter removed (master filters only) and the chevron strip centered.
- [x] Candidate Detail: Screening & Risk Notes collapsed by default behind
      an "+ Add HR Screening Notes" button; Stage/Status action buttons
      moved to the page's top-right for a single-application candidate
      (stay per-row when there are multiple applications, since there's no
      single unambiguous "the" stage to act on from a page-level control).

---

## Notable bugs fixed this project (context for why certain code looks the way it does)

- `express.json()` body parser must be registered **before** any route that
  reads `req.body` in `server.ts` — a route mounted before it will always see
  `req.body` as `undefined`.
- `pdf-parse` v2 exports a `PDFParse` class, not a default function — a
  version upgrade silently broke resume extraction until this was found.
- Local Docker Postgres and Supabase drifted out of sync **repeatedly**
  during this project (candidate profile fields, `applications.updated_at`,
  all 22 ResumeIQ score columns, role requisition fields) — each time
  traced back to an `ALTER TABLE` applied to Supabase but never mirrored to
  local Docker + `schema.sql`. See the schema-sync rule in `CLAUDE.md` §2.
- Two services sharing one Postgres sequence (`eval_questions` and
  `comp_benchmarks` both used `seq_refcheck`) caused duplicate-key crashes —
  fixed by giving every ID series its own dedicated sequence.
- Candidate CTC/notice-period fields were being read from legacy
  `applications`-level columns (always null) instead of the real
  `candidates`-level columns — fixed on the Candidates list view; worth
  double-checking any new UI that touches these fields reads from the right
  table.
- Removing a value from `STAGE_ORDER`/`STAGES` (or any similar enum-like
  array) does **not** touch rows already stored with that old value —
  `applications.stage` is plain `TEXT` with no `CHECK` constraint. Retiring
  `Resume Review`/`Shortlisted` (Phase 5) left 378 local / 373 Supabase rows
  silently stuck displaying a stage badge that no longer existed anywhere
  else in the app, until caught by an in-browser check and fixed with a
  one-time data migration (see `schema.sql`). Any future stage/enum removal
  needs the same treatment: migrate existing rows in the same pass, not just
  the type definition.
