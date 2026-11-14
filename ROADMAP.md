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
      signs in as them (34 smoke tests, API + browser, when created; 38 now that the Help checks were added).

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
- [x] **Head of Marketing work-sample review — the 9th ResumeIQ dimension for R019 (built 2026-10-22; merged and
      deployed 2026-10-23, PR #18; LIVE since 2026-10-24; backfilled 2026-10-25).** Generalises the designer
      (R007) portfolio review: `roles.portfolio_review_kind`
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
      rollback SQL: `docs/MarketingWorkSampleReview_Runbook.md`. Backend 84 files / 7,496 tests (14 skipped;
      run 2026-10-26, after PRs #22 and #23) and frontend 35 / 951 pass; local
      Playwright spec 15 has 68 tests, all passing on 2026-10-26 against PR #23's branch (3 of the designer
      spec 07's 15 fail locally only because the local Anthropic key was over its usage limit when they ran — the
      workspace limit production uses was lifted 2026-10-24 and they were not re-run); one local real-model canary
      run (not Chromium, and it pre-dates fix rounds 3 and 4) and, since 2026-10-24/25, 37 stored model calls on real R019
      applications in production (counted at the 2026-10-25 drain; 43 by 2026-10-26).
- [x] **Go-live of the work-sample review (Aaron-run, 2026-10-23 to 2026-10-25).** Done in this order: schema block
      to Supabase (2026-10-23, `20261023111710`) → deploy (2026-10-23) → R007 re-run on the deployed worker
      (2026-10-24, A0625: same score and average — the worker's queue, Chromium, model call and the brace-glob
      `includeFiles` all work on Vercel) → R019 flagged by one SQL statement (2026-10-24 ~15:00 IST, after the
      Anthropic workspace spend limit that had stopped scoring (first application left unscored: 2026-10-23) was lifted) → canary on the four
      unscored applications (the first real Chromium capture of an R019 site; no PDF in it) → backfill 2026-10-25
      ~03:15–03:30 IST with `--min-score 4` (PR #22): 87 eligible, 56 queued, 31 settled at enqueue, 0 errors; the
      first backfill reviews were also the PDF proof (the child process read 14 PDFs on Vercel). R019 afterwards,
      125 applications: completed 33, failed 1 (a Google Slides export fetch timeout), inaccessible 2, no_portfolio 25,
      unreviewable 30, no review 34 (the 23 Active below 4.0 and the 11 Rejected, deliberately not backfilled; no
      backfill of them is planned). By 2026-10-26 R019 had 133 applications: the 8 created since the flag were each reviewed at creation (6 completed, 1 no_portfolio, 1 unreviewable), so the new-applicant path is observed. **Fold measured on the 33 completed reviews:** 26 averages down, 4 up, 3
      unchanged, mean −0.18; 10 candidates down a priority bucket, none up; one lost Strong Fit and the 24h SLA
      tier; three are now below 4.0. **Decision (Aaron, 2026-10-25): keep the fold policy as it is** (`'always'`;
      the `upside_only` knob stays in code, unused). No spot-check by the hiring manager is scheduled. Numbers,
      outcomes and what the real worker showed: CLAUDE.md "Production state"; steps and queries: the runbook.
- [ ] **Work-sample review — follow-ups, not built.** cap `candidates.full_name` at ingest; network-level egress
      filtering or a validating proxy for the browser (socket/popup/teardown SSRF is only mitigated for R019 and not
      at all for R007's capture); the form's privacy-notice check and the optional dedicated Anthropic key
      (`PORTFOLIO_ANTHROPIC_API_KEY`) are not recorded as settled before the backfill; whether the quote matcher is
      too strict or the model quotes loosely (7 of the 33 reviews carry an invented-quote downgrade) has not been
      analysed; after touching any browser launch argument, the teardown guard or the PDF sandbox, repeat the
      Lambda-image check (runbook step 0: popups, teardown vectors, the partial crawl, the PDF reader) — it is also
      the only test of the `/proc` resident-size reading, which Vercel's results cannot show. See the runbook and
      the "Known gaps" in CLAUDE.md.
- [x] **Resume PDF parsing, for EVERY role, moved off the API function's main thread (written 2026-10-23, merged 2026-10-26 as PR #21).**
      `driveService.ts` ran pdfjs on the main thread of `api/index.ts`, so a hostile resume (a few KB: 15-40+ s of
      starved event loop, or an uncatchable out-of-memory) could wedge every request on the instance. The PDF sandbox
      and its pre-flight moved out of `portfolio/acquire/` to `services/pdfSandbox/` (shared by the worker and the main
      API; `acquire/pdf.ts` and `acquire/pdfSandbox.ts` re-export, so no old import changed) and every resume PDF is now
      read through them: Drive's declared size is checked before downloading (20 MB), the bounded pre-flight refuses
      bombs, a killable child process (512 MB heap, 12 s, 700 MB resident) parses the rest, first 40 pages, text
      byte-identical to the old parse and links from the same child. A hostile or unreadable resume scores on the
      profile fields (neutral; no portfolio dimension, never a 0); OUR failure to read (child could not start) is a
      visible, retryable `failed` for portfolio roles. Main API `includeFiles` is now `…/pdf-parse/dist/pdf-parse/cjs/*`
      (a plain star glob). Real nft trace: `api/index` 2,394 -> 2,399 files, 62.5 -> 64.4 MB, no Chromium; worker
      unchanged at 73.6 MB. Run from exactly that file set in the Lambda Node 22 image: ordinary, locked and hostile
      resumes all behave, event loop gap <= 143 ms. Backend 88 files / 7,130 tests pass (baseline `main`: 85 / 7,000; 130 new: `resume`, `boundary`,
      `driveService.resume`, plus link and argv tests in the sandbox's own and a packaging check). Details: CLAUDE.md "ResumeIQ".
- [x] **Deploy canary for the resume sandbox (passed 2026-10-26).** The child process has run on Vercel in the
      R019 worker (14 PDFs, 2026-10-25), but not in the MAIN function: that function must be able to `spawn` `process.execPath` with `-e` and `--max-old-space-size` and read `/proc/<pid>/status`. After the
      deploy, score or re-run one real application of ANY role and check `score_resume_read` is true; watch the logs for
      "[Drive] The resume reader could not read resume". If it cannot start there, every role is scored on profile fields
      only until it is fixed or rolled back (no fallback to the in-process parse, on purpose). The same canary covers
      the work-sample review's PDF check above (both use the one sandbox). A Word resume needs no process (it is a bounded read in the
      function itself), so the canary only has to confirm one real `.docx` resume scores with `score_resume_read` true.
      **Result:** Aaron pressed Re-run on R007 A0621 (a 44 KB PDF resume) at about 17:03 UTC: the main function read it through the sandbox, the review completed with the identical result of 2026-10-01 (portfolio 2/10, overall 1.2/10),
      no "could not read resume" line in the log, production smoke 34/34. Not covered: a real `.docx` resume, a hostile PDF in the main function, the `/proc` reading and a brand-new application's
      `score_resume_read` (the next real applicant is the check). Details: CLAUDE.md "Production state".
- [x] **Resume Word files moved to the bounded zip reader; `mammoth` removed (written 2026-10-23, merged 2026-10-26 as PR #21).** `mammoth`
      aborted node on a 123 KB hostile `.docx` (heap out of memory in 4.2 s; 641 MB for a 25 KB one). `driveService.ts` now reads a
      resume `.docx` with `services/boundedFiles/resumeDocx.ts`: the bounded zip reader (the one the marketing review has, moved to a shared
      folder with its XML walk and Word text reader; old paths re-export), an 8 MB body cap, text cut at 200,000 characters, and a new
      hyperlink reader (relationship targets plus Word's `HYPERLINK` fields). Same contract as a PDF: hostile or unreadable is neutral, OUR
      failure is a retryable `failed`, text without links is `linksError`. Against `mammoth` on the 113 real `.docx` on the dev machine: same
      text (F1 median 1.00; the four lower ones are 70-110k-word tender documents at the new cap), **identical hyperlinks on all 113**. Hostile
      files refused in under 1 ms at 177 MB resident in the Lambda image. `mammoth` and 15 dependencies removed from `package.json` and the
      lockfile; real nft trace: `api/index` 2,190 files / 63.1 MB (was 2,394 / 62.5 MB before both resume changes), no jszip or mammoth.
      Backend 90 files / 7,207 tests pass (baseline `main` 85 / 7,000; 77 of the 207 new tests are the Word change). Details: CLAUDE.md "ResumeIQ".
- [ ] `pdf.scanCharge.test.ts` "scanPdfContentStreamsAsync and the cooperative text scan the same" is timing-sensitive and already flaky on
      untouched `main` (5 of 8 runs failed): it expects a 6,000-stream scan to outlast one 20 ms slice, which a fast machine does not.
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
- [ ] Email digest — `sendDailyDigest()` (`jobs/slaChecker.ts`, nodemailer over the `SMTP_*` variables) is real, not a stub, but nothing runs it in
      production: `backend/vercel.json` schedules `/api/cron/email-digest` at 08:15 and Vercel Cron issues GET, while `routes/cron.ts` registers that
      route as POST only (the `sourcing-check` route answers both verbs for exactly this reason). Fix the verb (or accept the digest is off) and
      decide the sender; the Help page already says there is no daily pending-items e-mail.

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
- [x] **Sourcing page in the left menu (2026-10-22)** — merged 2026-10-22 as PR #13 (`671002d`; it was unit-tested at 717 frontend / 646 backend tests then and browser-tested by e2e `08-sourcing`, 15 tests): the plan workspace moved from the
      bottom of the Dashboard to its own page, **Sourcing** (`/sourcing`, left menu right after Roles, every persona while the module is on, hidden — and the
      page says "Sourcing is switched off" — while it is off; shared hook `useSourcingEnabled`). The Dashboard keeps only Sourcing execution; the role page keeps
      only its chip; My Tasks' box is unchanged; `/dashboard?sourcing_role=…` and `#sourcing-workspace` links redirect (`DashboardRoute` in `App.tsx`); the
      e-mail links are `/sourcing?sourcing_role=<id>` and the daily note's closing line points at "Sourcing in the left menu". Help, the User Access Guide
      (Version 5.2), the PRD, the runbook and `CLAUDE.md` updated. No schema, env or flag change; deploy frontend first, then backend
      (`docs/SourcingModule_Runbook.md`, "Release 2026-10-22"); CLAUDE.md "Surfaces" describes it as it is.
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

## Phase 7 — Engineering hygiene: CI, tests, Help (2026-11-05; the details are in CLAUDE.md "Testing" and "CI (GitHub Actions)")

- [x] **CI (PR #28).** `.github/workflows/ci.yml` on every PR and push to `main` (backend `tsc` + Vitest, the Node 22.11 `require()` check, frontend
      `tsc` + Vitest + `vite build`, Playwright type-check, async-promise lint, the database schema/seed/id-sequence guards, actionlint + shellcheck;
      the aggregate **`CI passed`** is the one check to require), plus CodeQL, dependency review, a gitleaks secret scan with
      `.github/gitleaks.toml`, a weekly `npm audit`, a nightly Playwright `api` + `db` run (`integration.yml`) and Dependabot.
- [x] **Backend Vitest (PRs #31 flaky sandbox/timing tests, #32 route-level tests, #33 pure-logic tests, #56 a CI-runner floor for one linearity check).**
      119 files, 9,603 tests + 14 skipped (measured 2026-11-05). Includes the allow-list of every route (`routes.authMatrix.test.ts`) and the
      backend/frontend "twin" drift guard (`utils/crossPackageTwins.test.ts`).
- [x] **Frontend Vitest (PRs #34 foundation and core components, #35 candidate pages and tables, #36 roles, agencies and admin pages).** 76 files, 2,305 tests.
- [x] **Playwright foundation and specs (PRs #37 isolated disposable stack `scripts/test-stack.sh`, shared helpers and `@live` tagging; #39 schema replay,
      user lifecycle and offline portfolio db specs; #40 candidate modals, bulk actions, lists; #41 My Tasks, role detail, role creation; #42 users,
      Help, responsive and PWA).** 1,080 tests in 79 files over five projects (`api` 379, `db` 413, `e2e` 220, `e2e-mobile` 30, `smoke` 38). The `api`
      specs of PR #38 are still open and are not in this count.
- [x] **Help page and info markers (PRs #29, #30).** FAQ answers brought up to the system; every column and KPI marker says what its query counts, and
      the marker tests read the backend's real numbers (`frontend/src/test/backendSource.ts`).
- [x] **A deactivated user loses access within seconds (PR #55, 2026-11-05).** `authenticate()` checks `users.is_active` live (15 s in-process cache,
      fail-closed 503, invalidated by `POST`/`PATCH /api/users`). Only `is_active` is live; persona and name still come from the token (below).
- [x] **Dependabot vulnerability alerts enabled (repository setting, 2026-11-05).** Not a file; see CLAUDE.md "CI".
- [ ] **Branch protection requiring `CI passed`** — recommended in CLAUDE.md; a repository setting, not recorded as done.
- [ ] **The nightly `integration.yml` is red** until `hms-tests-final/tests/db/17-user-lifecycle.spec.ts` (lines 197 and 303) and
      `tests/e2e/09-user-management.spec.ts` (line 479) are updated to the live `is_active` check, and `backend/src/routes/auth.test.ts`'s "characterization:
      authentication does not ask the database…" is rewritten (it passes vacuously). Measured 2026-11-05: `api` + `db` nightly selection 772 tests,
      756 passed, 1 failed, 14 not run behind it.
- [ ] **Two `e2e/13-help-and-info-markers` checks failed on a fresh local stack** ("Candidates: marker 2 of 7", "Dashboard (Hiring Manager): marker 8 of 13":
      the opened popover is reported covered or clipped by the page card), alone as well as in the full run. Find out whether they need more rows than a
      fresh database has or are a real clipping defect (a related one is already pinned "as TODAY": the Gender header popover is cut off by the table card
      when the list has a single row).
- [ ] **The nightly `EXCLUDE` list may be longer than it needs to be.** On 2026-11-05, on a fresh stack with no credentials, `db/07` (all 17 tests, the three excluded ones
      included), `db/05-aging-roles-no-movement` (13), `api/19-pending-actions-regressions` (9, the excluded "every candidate entry carries application_id" included)
      and the excluded `db/15` "a Drive PDF + a website: pending" all passed when run on their own, once each, although `integration.yml`'s header says they need a
      real key, a long-lived database, a multi-line queue error or are racy. Re-measure a few times, then trim the regex (do not add an entry without a measured
      reason, as the header says).
- [x] Stale comments in the CI files fixed: the "659 tests" count (`.github/README.md`, CLAUDE.md), `audit.yml`'s "Dependabot alerts are off", and the
      `frontend/src/services/api.ts` comments about axios array params (bracket form `key[]=a&key[]=b`; `api.test.ts` pins the real format).

### Open product issues found by the test suites (verified on `origin/main`, 2026-11-05)
Each was confirmed by reading the code and, where it says "verified", by calling a local disposable stack. Where a test pins the behaviour it is
named: fixing the issue turns that test red on purpose (see the "TODAY" / `characterization:` tests), so change the test with the fix.

*Data and ids*
- [ ] **Interview-round ids collide.** `nextRoundId` (`backend/src/routes/interviews.ts`) reads `SELECT id FROM interview_rounds ORDER BY id DESC LIMIT 1` and
      adds 1, instead of using `seq_interview` (which exists, and is the column default). Two concurrent `POST /api/interviews` get the same id and one
      fails on the primary key with a 500; and because the order is TEXT, once `IR10000` exists the "last" id is `IR9999` again and the next id issued is
      `IR10000`, which already exists (`interviews.feedback.test.ts`, "characterization: the "last" id is the greatest as TEXT…").
- [ ] **Several write routes answer 500 instead of 400 on a CHECK or cast violation** (the unhandled error reaches the generic handler). Reproduced:
      `POST /api/roles` with `priority:"ZZ"` or `num_openings:"abc"`; `PATCH /api/roles/:id` with a bad `priority`, `status` or `num_openings`;
      `POST /api/agencies` with a `contract_status` outside Active/Inactive/On Hold; `PATCH /api/applications/:id/notes` with `hr_priority_override:"Bogus"`;
      `PATCH /api/users/<not a uuid>` (and `e2e/09`: editing a user's e-mail onto another user's is a 500 where Add user answers a clear 400);
      `POST /api/auth/login` with a non-string e-mail. Most write routes do not validate enum or numeric fields at all (`POST /api/roles` ignores an
      unknown `status`; `POST /api/applications/:id/stage` stores any string as a stage, `applications.stage` being plain TEXT; interview feedback accepts an
      empty body and scores outside 1-5, and a 99 passes the "above 2.5" test that auto-advances the candidate).
- [ ] **`seed.sql`'s closing `setval` block fails on an empty database.** `setval('seq_candidate', COALESCE(MAX(...), 0))` (and the same for application,
      interview, refcheck) is "value 0 is out of bounds": `seed.sql` stops at its last block (data already committed), and **a fresh `docker-compose up`
      on a new volume does not initialise: the Postgres init script fails there and the container exits with code 3** (verified 2026-11-05; an existing volume is
      fine). Use `setval(seq, 1, false)` when the table is empty. CI and the test stack tolerate exactly this one error (`known-db-defects.txt`,
      `.github/ci/apply-db.sh`, `scripts/test-stack.sh`); pinned by `db/16-schema-replay`.
- [ ] **`seq_eval_question` and `seq_comp_benchmark` stay behind the seeded ids.** `seed.sql` inserts `Q001-Q013` / `BEN001-BEN012` explicitly and never advances them;
      they are created `START 1`, the later `START 14` / `START 13` lines are `CREATE SEQUENCE IF NOT EXISTS` no-ops, so on a rebuilt database the first insert that
      relies on the default id fails on the primary key (the `api/08` "HR can add a new question" test). Add the two `setval` lines to `seed.sql`, then
      delete `known-db-defects.txt`'s two lines and `.github/ci/seed-sequence-workaround.sql`.
- [ ] **`schema.sql` is not re-runnable** although its patch section is headed "Safe to run multiple times": the original block uses plain `CREATE TABLE`
      (42P07 on the first statement) and two patches fail when repeated (`ALTER COLUMN vacancy_reason TYPE TEXT[] USING string_to_array(...)` when it is
      already `text[]`, and `ADD COLUMN gender` without `IF NOT EXISTS`). Pinned by `db/16`.
- [ ] **`pending_actions` has foreign keys to `applications` and `roles` with no index on `application_id` / `role_id`**, so every delete of an application or
      role scans the table (`hms-tests-final/tests/helpers/sourcing-db.ts` `purgeRolesFast` exists because of it; pinned by `db/16`).
- [ ] **`db.transaction()` can mask the original error** (`backend/src/db/index.ts`): its `catch` awaits `client.query('ROLLBACK')` before rethrowing, so a failed
      ROLLBACK (a dropped connection) replaces the real error, and `client.release()` returns the broken client to the pool without `release(err)`.
- [ ] **`roleIngest` edge cases** (`backend/src/routes/roleIngest.ts`): `num_openings:"abc"` becomes `parseInt` NaN and the insert fails with a 500 (the sequence
      value is burned); `"0"` and `"-2"` are stored as given; the dedup key is `timestamp|email`, a row with neither has the key `|` and skips the lookup (a re-fired
      trigger creates duplicates), and `requisition_source_row` has no unique index, so two concurrent posts of one row can both insert; the role id is padded to
      3 digits (`R013`) where the column default pads to 4 (`R0009`).
- [ ] **`compBenchmark` can produce NaN bounds** (`services/compBenchmark.ts`): a model reply with no text block parses as `{}` and returns `range_min` /
      `range_max` NaN, with no validation of the range (`compBenchmark.test.ts`, "CURRENT BEHAVIOUR").

*Access control and workflow rules*
- [ ] **Persona and name are taken from the token** (`authenticate()` in `middleware/auth.ts`; `issueToken` in `routes/auth.ts`), so a demotion (or promotion) only
      takes effect at the person's next sign-in, up to `JWT_EXPIRES_IN` (24 h) later; only `is_active` is live since PR #55. Re-read `persona` (and `name`) in the
      same cached lookup, or shorten the token. Pinned by the two persona tests in `db/17` (`e2e/09` line 479 mixes this with the deactivation check and needs splitting).
- [ ] **HR priority override does not require a reason although the test says it does.** `PATCH /api/applications/:id/notes` accepts `hr_priority_override` with no
      `hr_priority_override_reason` (200; the activity line just ends in an empty reason), while `api/08-misc` is titled "HR priority override requires a reason"
      and asserts `[400, 200]` ("backend may not validate this yet"), so it cannot fail. Decide the rule; make the test exact.
- [ ] **The Hiring Manager is not scoped on `POST /api/applications/:id/screening`.** Any Hiring Manager can set `HM Shortlisted` on any application, whatever the
      role's `hiring_manager_name` (verified: a Hiring Manager named on another role did it), unlike comp visibility and the dashboard, which are per role.
- [ ] **`HM Shortlisted` is not idempotent** (same route): repeating it resolves nothing new but inserts another open "Schedule interview" action each time (three
      calls, three open rows), because the route never compares the old and new status.
- [ ] **`POST /api/interviews/:id/assignment-submit` does not check the round type**: a Standard round accepts an assignment submission (it writes the submission
      onto the round and the application). `assignment-send` does check (400 "not configured as an Assignment round").
- [ ] **A candidate with no e-mail gets an inconsistent answer when an Assignment round is created** (`attemptAssignmentEmail`): the row stores
      "Candidate has no email on file." while the response says "Candidate has no email on file — cannot send assignment.", and, unlike a failed send, no
      "Assignment Email Failed" activity-log row is written.
- [ ] **The rejection/withdrawal reason gate is looser than it reads**: either kind of reason satisfies either status (a `Rejected` with only a withdrawal reason
      is stored with no rejection reason), and a whitespace-only `withdrawal_reason_cat` counts (`applications.access.test.ts`).
- [ ] **`GET /api/candidates/:id/edit-log` is open to a Hiring Manager and returns the raw rows, including the old and new values of the compensation fields**
      (`expected_ctc` etc.) that `GET /api/candidates/:id` strips for that persona (verified live; `routes.authMatrix.test.ts` pins it). `requireLeadership` is
      exported but mounted on no route.
- [ ] **Google sign-in reads neither `email_verified` nor `hd`** (the check is the e-mail suffix alone), does not compare the Google subject with the stored
      `google_id` (a different account for the same e-mail takes the link over when the picture differs), and answers 500 for a verified token with no payload
      (`routes/auth.test.ts`, "characterization").
- [ ] **Stored `sla_hours` disagrees with the SLA engine for high-fit candidates.** `getSlaHours('Applied and Screened', 80)` stores 48 while the SLA engine
      (`tieredStandardHours`) breaches at 24 since Hiring SOP v2.1 (the two agree below fit 75).
- [ ] **"Joining risk" is raised for every Offer Accepted application at once.** `checkJoiningRisk` (`jobs/slaChecker.ts`) flags `last_hr_contact IS NULL OR older than
      5 days`, and nothing sets `last_hr_contact` when the stage moves (only `PATCH /notes` does), so the next SLA sweep raises "Joining risk — no contact"
      ("No HR contact logged in 5+ days") immediately, with `hours_overdue` hard-coded to 120.
- [ ] **`backend/src/jobs/scheduler.ts` is dead code** (imported nowhere; Vercel Cron and the compute-on-read sweep replaced it; it is also the 2 known findings of
      the async-promise lint). Delete it and add `--fail` to the lint step in `ci.yml`.

*Frontend*
- [ ] **A corrupt `hms_user` in localStorage white-screens the app**: `AuthContext` parses it with a bare `JSON.parse` in the mount effect and there is no error
      boundary, so the crash survives reloads until site data is cleared; and any valid-JSON value (a string, a number, an array, `true`) is adopted as the user, with
      no persona and so no rights (`AuthContext.test.tsx`).
- [ ] **The 401 interceptor redirects on a failed sign-in** (`frontend/src/services/api.ts`): it treats every 401, including the `POST /auth/login` and
      `/auth/google` calls themselves, as an expired session, clears storage and sets `window.location.href = '/login'`, a full reload that loses the error
      message (`api.test.ts`).
- [ ] **The "Add agency" button has no handler** (`pages/Agencies.tsx`): it is drawn for every persona, including one who cannot load the list, and does nothing
      (`pages.smoke.test.tsx`, `e2e/16`).
- [ ] **Axios array parameters are bracket-serialized** (`gender[]=UNKNOWN`, `or_role_id[]=R019`), not repeated keys as the comments in `services/api.ts` say.
      Express's `qs` reads both, so nothing is broken, but anything that matches request URLs (a proxy rule, a Playwright route) must use the real form.
- [ ] **`frontend/tsconfig.json` has duplicate keys** (`strict`, `noUnusedLocals`, `noUnusedParameters` each appear twice); `strict` is false.
- [ ] **`Candidates.tsx` calls `GET /api/candidates/unmatched` for every persona** (the query has no `enabled`), although the route is HR-tier only: a Hiring Manager's
      page makes a request that is always a 403 (verified).
- [ ] **A failed background refresh replaces the whole Dashboard** (`pages/Dashboard.tsx`): the `error || !data` test shows "Failed to load dashboard" even
      though react-query still holds the last good `data` when a `refetchInterval` refresh fails.
- [ ] **A Hiring Manager sees a Recruitment Mode filter with no options** on the Dashboard: the `roles/filter-options` query is disabled for them
      (`enabled: !isLockedToOwnRole`), but the filter is still drawn, with an empty list.
- [ ] **Smaller pinned UI behaviours** (each in the listed spec's header): the Stage modal has no skip-reason control; a candidate page keeps the old stage until
      reloaded after an auto-advance; a Hiring Manager not on a round still sees "Submit feedback" and the edit pencils on roles and candidates (every save is
      a 403); a role's activity timeline does not refresh after Change status; the bulk over-budget reason is sent for, and stored on, every selected row; bulk
      withdraw stores its reason in the rejection column; clearing a user's Department in Edit does not clear it; the first tap on an info marker on a phone
      opens nothing (`e2e/10`, `e2e/11`, `e2e/14`, `e2e/09`, `e2e-mobile/15`).
- [ ] **Approve Role hides a JD-generation failure** (`RoleDetail.tsx` `handleApprove`): the PATCH returns `jdGeneration` (30 s of Claude, two PDFs, two Drive
      uploads, awaited inline) but the button only toasts "Role approved", so a failed generation is invisible there; the Change status modal
      (`handleStatusUpdate`) does show it, and the "Links & Assets" card just shows no JD link.

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
