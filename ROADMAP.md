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
- [x] HM Queue page (`HMQueue.tsx`) — shortlist decisions + feedback due,
      visible to `hiring_manager`/`interviewer`/`leadership` personas
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
- [ ] **Drive auto-folder creation** on Role and Candidate creation — every
      role/candidate should get a Drive folder automatically; currently none
      do. (`driveService.ts` already has working Drive API access via the
      service account — this needs a `createFolder`-equivalent added there.)
- [ ] **Inline editing — Roles, Candidates, Agencies.** Scope, as defined:
  - All fields on each entity (not a subset)
  - Detail page only (not list/table views)
  - Explicit Save / Cancel per field or per section (not autosave)

---

## Phase 4 — Candidate ingestion & scoring fidelity

- [ ] **Candidate ingestion from the Job Application Form.** Same
      Sheet→AppsScript→webhook pattern as Phase 3's role ingestion, but for
      candidates — grouped/linked to the correct role based on the
      applicant's "role applying for" selection. Field mapping already
      scoped: Email, Name, Phone, Current CTC (fixed+variable+ESOPs),
      Expected CTC, Notice Period, Current Company, Industry, Designation,
      Location, YOE, Resume Link — all already exist as real columns on
      `candidates` (added this project's schema work).
- [ ] **ResumeIQ scores against the generated JD document**, not the short DB
      fields it currently uses. Depends on the Phase 3 JD generation feature
      existing first — there's nothing to score against otherwise.
- [x] **Resume text fetched from Google Drive** — done. Real PDF/DOCX/Google
      Doc extraction via service account, wired into the scoring trigger,
      confirmed working end-to-end (verified with a real resume producing a
      real, differentiated score vs. the profile-only fallback).
- [ ] Offer letter generation + UI
- [ ] Pre-joining documents checklist
- [ ] Email digest (currently a stub that returns `ok` — no actual sending)

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
