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
- [x] **Seed password hash removed from production users (2026-10-19)** — it was still set on
      8 users; `password_hash` is now NULL for them, so every production account is Google-only
      and `/api/auth/login` answers "use Google sign-in". Consequence: `hms-tests-final`'s
      `npm run test:prod` smoke tests log in by password and no longer work against production
      until they are given another way in (see `CLAUDE.md` Testing). `seed.sql` still carries
      the seed password for LOCAL Docker only.
- [x] **Production smoke-test accounts (2026-10-19)** — chosen and approved by Aaron; both rows created in production, `npm run test:prod`
      signs in as them (34 smoke tests, API + browser).

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
      renderers produce the PDFs (`pdf/longFormJd.ts` via pdfmake, ported from
      the `digitalpaani-long-jd` skill's ReportLab source and verified by
      visually inspecting output against its reference PDF; `pdf/socialJd.ts`
      via pdfkit — redesigned 2026-10-22 as the standard social-JD template,
      no longer a port of the skill: see CLAUDE.md "Social JD template"). Uploaded to Drive via domain-wide delegation
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
      (`stage='Applied and Screened'`, source `'Job Application Form'`), reusing the
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
- [x] **Naukri bulk-import script.** Naukri has no self-serve API (confirmed
      by research — every real vendor integration routes through a paid,
      account-manager-gated product, and it's broken outright for other
      vendors before). `backend/src/scripts/importNaukriExcel.ts` imports
      Naukri's own recruiter-portal bulk Excel export directly instead —
      same insert shape and `runResumeIQScoring()` call as
      `candidateIngest.ts` above, explicit required `role_id` argument (not
      auto-matched from Naukri's own job-title text, which doesn't reliably
      match this system's role titles), `--dry-run`/`--skip-scoring` flags,
      idempotent on re-run. Doesn't populate `resume_drive_link` (the
      export's own "candidate profile" link points at Naukri's portal, not
      a fetchable resume) or `expected_ctc` (not in the export). Verified
      end-to-end against local Docker: parse, dedup (exact-duplicate rows,
      comma-joined duplicate/ambiguous email cells), fill-null-only update
      for a repeat email, idempotent re-run (0 new rows), and a real
      `runResumeIQScoring()` call landing a real score.
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
- [x] **Head of Marketing work-sample review — the 9th ResumeIQ dimension for R019 (built 2026-10-22; NOT live
      yet).** Generalises the designer (R007) portfolio review: `roles.portfolio_review_kind`
      (`design_portfolio` default | `marketing_work`) picks the review, `portfolio_analysis_enabled` stays the
      switch, both set by SQL. For R019 the links in the screening answer "Links to public resources/portfolio…"
      are fetched anonymously (never with the service account) — Drive/Docs/Slides/PDF/Word/PowerPoint/images,
      own sites in Chromium, YouTube/Vimeo as metadata only, Instagram caption only, LinkedIn never — and judged
      by one model call against the role's raw must/nice-to-have lists, with a code-enforced evidence rubric,
      hard caps, a model that is never given the candidate's name or personal data, and a protected-attribute
      filter. The score folds into `score_avg` like R007's, but work that cannot really be reviewed
      (blank/"N/A", text only, private, bot-walled, social/video-only, a scan the model cannot read) is **not
      scored** — never 0, and a review the model was never shown any work for, or could assess none of, cannot
      be recorded as completed. New neutral `unreviewable` status; ONE intended change also reaches R007's
      browser capture (the neutral Cloudflare/captcha handling) — the WebSocket lockdown, popup blocking and
      teardown guard are marketing-only, so R007 keeps its pre-existing exposure by decision. Hardened for hostile
      candidate files after three adversarial reviews and four fix rounds: bounded zip reader, a CPU-bounded
      cooperative PDF pre-flight, PDF parsing in a killable CHILD PROCESS (it replaced a worker thread that one huge
      allocation could take down with the whole process; resource isolation, not a security sandbox), a browser
      teardown guard against requests a page starts as it unloads, a fairness layer (name masking as fuzzy as the
      name signal, personal-statement redaction at about 85-90% recall on unseen wording) and an ownership concern
      that needs a quoted credit; the findings were fixed, or documented as open.
      Design record: CLAUDE.md "Marketing work-sample review (2026-10-22, R019)"; runbook with the tested
      rollback SQL: `docs/MarketingWorkSampleReview_Runbook.md`. Backend 84 files / 6,983 tests and
      frontend 35 / 950 pass; local Playwright spec 15 has 65 tests (all pass; 3 of the designer spec 07's 15
      fail locally only because the local Anthropic key is over its usage limit until 2026-11-01); one real-model
      canary run (not Chromium, and it pre-dates fix rounds 3 and 4).
- [ ] **Go-live of the work-sample review (Aaron-run).** Schema block to Supabase first → deploy → R007 re-run
      on the deployed worker (the worker's `includeFiles` is now one brace-glob string carrying pdf-parse's
      `index.cjs` and `pdf.worker.mjs` AND the Chromium binaries: confirmed locally and by an nft trace, NOT on
      Vercel, and a bad glob would break designer reviews too) → flag R019 → canary (the first Chromium capture of
      R019 anywhere, plus a real PDF: the only check of the PDF sandbox on Vercel — it must prove the worker can
      `spawn` `process.execPath` with `-e` and `--max-old-space-size` and read `/proc/<pid>/status`) → backfill
      (~90 answers with links, ~18 text-only, ~17 blank; no concurrency throttle, so go in waves) → Mansi's
      spot-check. To settle first: the form's privacy-notice check and the optional dedicated Anthropic key; after
      touching any browser launch argument, the teardown guard or the PDF sandbox, repeat the Lambda-image check
      (runbook step 0: popups, teardown vectors, the partial crawl, the PDF reader). Follow-ups, not built:
      **reuse the PDF sandbox in the main API so resume parsing (`driveService.ts`, every role) stops running
      pdfjs on the API function's main thread** (recommended, pre-existing; a separate session was started for it),
      cap `candidates.full_name` at ingest, and network-level egress filtering or a validating proxy for the
      browser (socket/popup/teardown SSRF is only mitigated for R019 and not at all for R007's capture) — see the
      runbook and the "Known gaps" in CLAUDE.md.
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
      starts at `Applied and Screened` (renamed same-day from plain
      `Applied` — see below) and is scored by ResumeIQ automatically and
      synchronously at creation (`resumeIQTrigger.ts`'s
      `runResumeIQScoring()`, called from `candidates.ts` and
      `candidateIngest.ts`) rather than on a later stage transition.
      "Shortlisting" is now a direct `Applied and Screened` →
      `Interview Round 1` move, open to every persona from `Applied and
      Screened` specifically (still HR-tier-only for every other
      transition). Touched the budget-exception gate, the SLA breach engine
      (`Idle Candidate` no longer covers this stage; `Resume Shortlist
      Pending` retargeted to it; the old `Interview to be Scheduled` breach
      dropped as redundant with `Interview 1 Not Scheduled`), Source
      Quality's Pass Rate definition, and Roles' `Active Shortlist` count. A
      one-time data migration moved every already-existing application off
      the two retired stage values on both local Docker and production
      Supabase (documented in `schema.sql`) — removing a stage from the
      type doesn't touch rows already sitting at the old value.
- [x] **'Applied' renamed 'Applied and Screened'** (same day as the above,
      after using the plain name for a few hours) — the longer name signals
      at a glance that ResumeIQ has already scored the candidate by the
      time they're at this stage, not just that they submitted an
      application. Same treatment as the stage retirement above: every
      `STAGE_ORDER`/`FLAT_STAGE_CHECKS`/UI reference updated together with
      a one-time data migration on local Docker and Supabase (schema.sql's
      `DEFAULT` updated too). The stage's color was also standardized to
      yellow across every visual (StageBadge, the candidate-detail pipeline
      chevron bar, and the Dashboard's Hiring Funnel Snapshot, which shares
      the same `STAGE_COLORS` constant) — previously slate-gray on the two
      chevron views despite already being yellow on the plain badge.
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
      per persona: HR/Admin & Super Admin see every `Applied and Screened` candidate
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

## Phase 6 — Sourcing Execution & Accountability (spec: `docs/SourcingModule_PRD_v2.md`)

- [x] **P0 foundations** — `sourcing_*` tables (RLS on, additive), settings + `SOURCING_ENABLED` flag, IST working-day helper, owners
      endpoint, draft-plan backfill script, daily cron route (GET+POST), go-live runbook.
- [x] **P1 plan + commitments + engine + queue + attribution** — plan seeding (a draft per open role; there is no create or delete
      endpoint) / read / update (owner, strategy note, channels) / activation with "already running" attestation, post-commit role
      hooks (approve / hold / close / reopen / recruitment-mode reconcile), compute-on-read engine with a DB-enforced no-duplicate
      live-exception guarantee, three resolution paths, shadow mode for threshold signals, RoleDetail card + header chip, My Tasks
      "Sourcing" box, `source_tag` → `applications.sub_source`.
- [x] **P2 leadership view + e-mails** — Dashboard "Sourcing execution" (last section), daily note to the HR team and Monday leadership
      summary (both off until configured).
- [x] **Schema applied to Supabase (2026-10-19)** — migration `20261019025305` `sourcing_execution_module_tables`: 8 tables, RLS on with
      no policies, matches `schema.sql` object-for-object, all empty. Guarded rollback: `docs/SourcingModule_Rollback.sql`.
- [x] **Review fixes (2026-10-19)** — a role's status now reconciles its plan from the role's NEW status and the plan's CURRENT status
      (`planTransitionFor`), so Closed → On Hold → Approved and On Hold → Under Review → Approved no longer strand a plan; the role page
      re-reads the plan after approve / status change / field save. Docs corrected (19 inaccuracies).
- [x] **Enabled in production (2026-10-20)** — PR #9 merged (`a2f825e`), both Vercel projects deployed, `SOURCING_ENABLED=true` set on
      `dp-hiringmaster-be` Production and the backend redeployed (`dpl_36JxBH4H…`); `/api/sourcing/status` answers `enabled:true` and the
      34-test production smoke suite passes with it on. The go-live clock (`go_live_date`, `shadow_until` = +42 days) starts at the first
      real use of the Sourcing queue, the Sourcing page or the dashboard section. Rollback: flag false + redeploy, or Instant Rollback to `dpl_BoLi6zv…`.
- [x] **Sourcing workspace release (2026-10-21, Aaron's seven changes)** — merged and deployed 2026-10-22 (PR #11, squash `5862653`; PR #12 cosmetics; schema applied to Supabase as `20261021205937`; the live Apps Script maps the form's source tag; 34-test production smoke green): the plan moved from the
      role page to Dashboard → Sourcing plans (role switcher, history timeline; moved again on 2026-10-22 — next item); a weekly qualified target per role; AI next steps in Needs attention;
      plan history logs every action; LinkedIn / Naukri/IIMjobs / Direct Outreach = log the post (link + weekly target) then an automatic red/green weekly
      tracker; Close channel (summary kept, reopenable) replaces Stop using; Applications by source and the tracker read the form's "How did you hear about this opening?"
      field. Release order and the production migration are in `docs/SourcingModule_Runbook.md` ("Release 2026-10-21"). Item 5.3 of the request was blank
      — the portals keep their 30-day renewal task unless told otherwise.
- [ ] **Sourcing page in the left menu (2026-10-22)** — BUILT, unit-tested (frontend 717, backend 646) and browser-tested (e2e `08-sourcing`, 15 tests) on branch `feat/sourcing-sidebar-page`, NOT yet released: the plan workspace moved from the
      bottom of the Dashboard to its own page, **Sourcing** (`/sourcing`, left menu right after Roles, every persona while the module is on, hidden — and the
      page says "Sourcing is switched off" — while it is off; shared hook `useSourcingEnabled`). The Dashboard keeps only Sourcing execution; the role page keeps
      only its chip; My Tasks' box is unchanged; `/dashboard?sourcing_role=…` and `#sourcing-workspace` links redirect (`DashboardRoute` in `App.tsx`); the
      e-mail links are `/sourcing?sourcing_role=<id>` and the daily note's closing line points at "Sourcing in the left menu". Help, the User Access Guide
      (Version 5.2), the PRD, the runbook and `CLAUDE.md` updated. No schema, env or flag change; deploy frontend first, then backend
      (`docs/SourcingModule_Runbook.md`, "Release 2026-10-22").
- [ ] **Activate plans in waves (HR)** — P0/P1 roles first, R016 or R019 as the dry run; tell the HR team before the first open. The Google
      Form dropdown (and the Apps Script change that goes with it) is OPTIONAL — it only tells you which channel an applicant came from.
      Digest e-mails stay off until switched on in settings. Order and caveats: the runbook.
- [x] **Channel handling and take-down (2026-10-19, Aaron's decisions)** — a channel added to an active/paused plan gets its first
      commitment; skipped follow-ons return when the channel's activation is completed again; the card has Add channel / Bring back,
      Undo skip and Edit strategy note; the closed-role take-down task and everything chasing it was removed. 7 new db-spec tests, 10 new
      component tests; one extra bug found and fixed on the way (close → reopen → re-activate left follow-ons skipped).
- [x] **HR-persona ownership, no holidays (2026-10-19, Aaron's decisions)** — a plan has no individual owner (every HR user sees and can act
      on every plan; the daily e-mail is one message to all HR/Admin users); public holidays are not modelled (Mon–Fri only). Six production
      roles' Hiring Manager names corrected to the users' full names (R003, R005, R007, R012, R0015, R020).
- [x] **Help page, info markers and User Access Guide brought up to date (2026-10-19)** — `Help.tsx` answers rewritten against the code (My Tasks
      is boxes, Scorecard Summary is the table inside Ready for review, the Sourcing FAQ group shows only while the module is on, a
      "What e-mails does HMS send?" item that says there is no daily pending-items mail); info-marker texts corrected on Dashboard, Roles,
      Active Candidates, Scorecard, Archived Pipeline, Agencies, My Tasks, candidate and role pages; the guide (docx + PDF) is Version 5.1 (sourcing workspace release), Version 5.2 from 2026-10-22 (Sourcing page).
      `Help.test.tsx` pins the gate and three answers. Follow-up (2026-10-20): new markers on the three Gender columns (one shared text,
      `utils/columnInfo.ts`), the Active Candidates and Archived Pipeline subtitles, and the Archived Pipeline Stage / Fit / CTC → ECTC /
      Notice / Company-Industry / Actions headers; the narrow columns were widened so the label still shows next to the icon.
- [ ] **P3 automation** — one-click agency brief and referral push through Gmail (auto-evidence); channel effort-vs-output once
      attribution has enough tagged applications.
- [ ] **P4 outbound** — company lists, Sheets-API prospect sync, coverage/outbound exceptions, direct-send templated outreach with
      guardrails (owner-mailbox sender, durable cap, suppression, signed unsubscribe), prospect/outreach views on the Sourcing page.
- [ ] Parked (needs a public careers page, partner access or is policy-barred): job syndication, Cutshort, Brave/GitHub search, Campus.

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
