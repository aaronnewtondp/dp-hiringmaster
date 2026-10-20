# Sourcing module — go-live runbook

Spec: [`SourcingModule_PRD_v2.md`](SourcingModule_PRD_v2.md). This is the operational checklist; nothing here changes
behaviour until `SOURCING_ENABLED=true` on the backend. With the flag off, reads answer `{ enabled:false }`, writes answer 503 (the
cron route answers 200 `{ ok:true, enabled:false }`), every hook no-ops (zero queries) and the UI hides itself. The tables stay,
harmlessly.

**To roll back, set `SOURCING_ENABLED=false` AND redeploy the backend.** A Vercel env-var change only takes effect on a new
deployment (or use Vercel *Instant Rollback* to the deployment from before you enabled it). Flag-off *hides* the module; it does not
pause it: while the flag is off the role hooks do not run, so a role put On Hold or Closed in that window leaves its active plan as
it was (the plan is reconciled the next time that role is saved with a real change — check role statuses before re-enabling).
Removing the tables is a separate, optional step: [`SourcingModule_Rollback.sql`](SourcingModule_Rollback.sql) — guarded, it refuses to
run while any sourcing table holds a row, and it never touches anything outside the 8 `sourcing_*` tables.

## Where production stands (2026-10-20)

Steps 1, 2 and 4 are **done**. The schema was applied to Supabase on 2026-10-19 (migration `20261019025305`, 8 tables, RLS on with no
policies, matching `schema.sql` object-for-object). The code was merged as PR #9 (`a2f825e`) and both Vercel projects deployed;
`SOURCING_ENABLED=true` was then added to the Production environment of `dp-hiringmaster-be` and the backend redeployed
(`dpl_36JxBH4H8ruREWWQkDXqe985SJct`). The module is **on**: `GET /api/sourcing/status` answers `enabled:true`, and the read-only production
smoke suite (34 tests) passes with it on. Not yet done: step 5's clock has not started (`go_live_date` / `shadow_until` are null until the
first real use of the Sourcing queue or dashboard section, or the daily cron), no plan is activated, and the optional steps 3, 6 and 9 are
untouched. To roll back: `SOURCING_ENABLED=false` + redeploy, or Instant Rollback to `dpl_BoLi6zvHy7G1h3fUHpP7sRDs6Txc`.

## Order matters

1. **Schema → Supabase first. Done 2026-10-19.** The "Sourcing Execution & Accountability module — P1 tables" block of
   `backend/src/db/schema.sql` is all `CREATE … IF NOT EXISTS`, plus an idempotent `DROP TRIGGER IF EXISTS` / `CREATE TRIGGER` for the
   3 `updated_at` triggers and `ENABLE ROW LEVEL SECURITY` on the 8 tables. It is additive, touches no existing table, and requires the
   existing `update_updated_at()` function. The code tolerates missing tables, but the module needs them.
2. **Deploy backend, then frontend.** Separate Vercel projects; open tabs keep the old bundle until reload. Stage the commit **by
   explicit path** (`git add <path> …`, never `git add -A`): three unrelated untracked files sit in the repo root (`DP hiring.xlsx`,
   `DigitalPaani_ATS_HMS_PRD_v4.0.docx`, `recruiter-agreement-analysis.html`), and never `git add -f` the Drive service-account key
   (`dp-hiring-master-*.json`, gitignored). **Backend first, and let it finish before the frontend ships.** *Known limitation, left as is
   on purpose:* until the backend is live, every Dashboard load shows a "Couldn't load sourcing execution." card (the role page and
   My Tasks degrade silently). With the flag still off nothing else is visible.
3. **(Optional — only if you want to know which channel produced a candidate.) Update the Apps Script — before the flag and before the form changes.** The module works fully without steps 3 and 6; skipping them only means *Applications by source* cannot say where applicants came from, because the live ingest stamps every form applicant `LinkedIn`. Make two edits to the LIVE script in the response sheet's Apps Script — **do not paste the reference copy `CandidateApplicationFormTrigger.gs.js` over it** (its `CANDIDATE_INGEST_SECRET` is only a placeholder, so every submission would be rejected, and the live script may have diverged from the copy): add the `'How did you hear about this role?': true` entry to `HANDLED_ELSEWHERE`, and the line `source_tag: firstNonEmpty('How did you hear about this role?')` to `payload`. Until the question exists it sends a blank tag, which is harmless. The order matters: the live script puts every form
   column it does not recognise into `screening_answers`, so a dropdown added first would be stored as a screening question for every
   applicant.
4. **Set env on the backend project:** `SOURCING_ENABLED=true`, **then redeploy** (the variable is read at request time but a new
   deployment is what carries it). Also confirm `CRON_SECRET` (Vercel Cron sends it) and `FRONTEND_URL` (used for links in the e-mails;
   links are simply omitted without it).
5. **First engine run stamps the clock.** The first time the engine runs enabled (any queue/dashboard load, or the daily cron) it
   records `go_live_date = today` and `shadow_until = today + 42 days` in `sourcing_settings` — never overwriting a value that is
   already there. Until `shadow_until`, threshold signals (volume gap) are *provisional*: shown to HR-tier users only (a greyed
   "Provisional" on the dashboard and on the role's Sourcing card), no My Tasks item, no Hiring-Manager view, never listed in an e-mail
   (the Monday summary only states how many exist), not resolvable. **Settings cannot be written while the flag is off** (`PUT
   /api/sourcing/settings` answers 503), so the go-live date and `shadow_until` cannot be pre-set through the API. Either accept the
   stamp, or pre-insert rows into `sourcing_settings` (`key TEXT`, `value JSONB`) by SQL BEFORE the first engine run (before step 4's redeploy, or at the very latest before anyone opens the Dashboard or My Tasks, or the cron fires, after it); the stamp never overwrites a key that exists. Adjust later with `PUT /api/sourcing/settings` (Leadership / Super Admin).
   **Working days are Monday–Friday (IST). Public holidays are deliberately not modelled** — a task that falls due on a holiday is simply due that day.
6. **(Optional, with step 3) Attribution — now add the dropdown to the Google Form.** In the Job Application Form add one dropdown, **"How did you hear about this
   role?"**, options exactly: `LinkedIn`, `Naukri/IIMjobs`, `Agency`, `Internal Referral`, `Direct Outreach`, `Other`. Tagging only
   records while the flag is on (with it off `sub_source` stays NULL), which is why this comes after step 4. Verify with **one** test
   submission under an obviously fake address — it creates a real candidate and application in production and runs ResumeIQ scoring
   (a paid Anthropic call) — then `SELECT sub_source FROM applications ORDER BY application_date DESC LIMIT 1;` shows the channel; it cannot be removed through the API (`DELETE /api/candidates/:id` answers 409 once the candidate has an application), so remove it in the Supabase SQL editor — check the id first: `DELETE FROM applications WHERE candidate_id = '<C####>'; DELETE FROM candidates WHERE id = '<C####>';` (the application's interview, activity, pending-action and portfolio rows cascade or are nulled by their foreign keys) — or leave it Withdrawn with a reason. Per-channel apply links can prefill the dropdown (Forms "get
   pre-filled link") so a posting's link tags its applicants. It is the applicant's own answer — treat it as claimed. Earlier Job
   Application Form applicants all carry `candidates.source = 'LinkedIn'`, but their `applications.sub_source` is NULL (the role card
   shows them as "(untagged)"), so per-channel yield figures start only from the day tagging starts.
7. **Draft plans** appear for every open role automatically; `npx tsx src/scripts/backfillSourcingPlans.ts [--dry-run]` does it in
   one go if you want the "Plans to activate" list complete before anyone opens the app.
8. **Activate in waves** (P0/P1 first). On a role page → Sourcing → *Activate plan*: tick the channels (there is no owner to pick — sourcing belongs to HR/Admin as a whole, and every HR user sees and can act on every plan), and for
   anything already running tick *Already running before today* (+ posting date) — it is recorded as done and the renewal clock
   starts from the posting date. A first role (R016 or R019) before the rest is the sensible dry run. Nothing here is final: after
   activation channels can still be added or brought back and the strategy note edited (see *Managing a running plan* below).
9. **E-mails (optional, off by default).** `PUT /api/sourcing/settings` with `digest_recipients` (company addresses only, Monday
   summary) and/or `daily_digest_enabled: true` (ONE daily note to every active HR/Admin user, only when something needs doing). Both stay off unless
   you switch them on. Sent from hr@ by the daily cron (`/api/cron/sourcing-check`, `30 3 * * *` = 03:30 UTC, about 09:00 IST; on Vercel
   Hobby a cron may fire any time within that hour; GET or POST). The daily note goes only on weekdays, the weekly summary only on Mondays,
   each at most once a day per kind.

## Day-to-day

* **Settings** (`GET/PUT /api/sourcing/settings`): `qualified_rule` (`either` | `shortlisted` | `scored`), portal expiry
  days, the weekly qualified minimum, `shadow_until`. Recruiters can read; Leadership / Super Admin change.
* **Running the engine by hand:** `curl -H "Authorization: Bearer $CRON_SECRET" https://<backend>/api/cron/sourcing-check`.
* **A plan follows its role's status, not the path the role took to get there.** The plan is reconciled from the role's NEW status
  and the plan's CURRENT status on every real role save: an open role (Approved / Live – Sourcing) gets a draft plan if it has none,
  a paused plan resumes (open due dates shift by the time spent paused) and a closed plan goes back to draft (re-activate it); On Hold
  pauses an active plan; Closed – Filled / Cancelled closes a draft, active or paused plan (every open commitment skipped, exceptions
  cleared — nothing is queued, there is no "take down the postings" task); Draft / Under Review change nothing. So Closed → On Hold → Approved ends in a draft plan, and On Hold →
  Under Review → Approved ends in an active plan. Saving the same status twice changes nothing the second time.
* **A role's Recruitment Mode** is read-only on the role page once a plan exists. Edits made directly on the role (API, or a stale open
  tab) are reconciled back into the plan: a channel added there joins the plan with its first commitment (active and paused plans), a channel
  removed there is left out of the plan. Channels are normally managed on the plan itself — see *Managing a running plan*.

## Verifying (local)

```bash
SOURCING_ENABLED=true docker compose up -d backend
cd hms-tests-final && npx playwright test tests/db/13-sourcing-plans.spec.ts      # skips itself if the flag is off
cd hms-tests-final && npx playwright test tests/e2e/08-sourcing.spec.ts           # also skips itself; needs Vite on :5173
cd backend && npm test && cd ../frontend && npm test
```

Before enabling in production, also re-run the existing dashboard / ingestion / pending-actions / role-approval specs with
`SOURCING_ENABLED=true`: no record of an earlier flag-on run survives.

## Known limits

* Vercel **Hobby** allows one cron run a day and its terms are non-commercial; the engine therefore also runs when the dashboard
  or the My Tasks queue is opened (throttled to once every 3 minutes per instance).
* The existing `/api/cron/email-digest` is registered as POST but Vercel Cron issues GET, so it has never fired. Left alone on
  purpose: "fixing" it would switch on a dormant SMTP e-mail nobody expects.
* Outbound prospecting (company lists, Sheets sync, templated outreach) is phase P4 and not built yet; agency/referral one-click
  automation is P3. Both are specified in the PRD.
* **The Hiring Manager view is not fully redacted (left as is on purpose).** For the role's own Hiring Manager, `GET
  /sourcing/plans/:roleId` still includes each channel's `excluded_reason`, and on exceptions the `resolution_path`, `snooze_until`,
  `blocker_due` and the snoozed / blocked states. It also includes the volume block (weekly qualified / shortlisted / scored, minimum, rule), `settings` (`go_live_date`, `shadow_until`, `qualified_rule`), `attribution_reliable`, the plan's activation / pause / close timestamps, commitment `meta` and each completion's done / was-due dates and on-time flag. It does not include the strategy note, baseline, owner, change history, posting URLs,
  completion notes or evidence, exception reasons / corrective actions / evidence, provisional or resolved exceptions. Do not describe
  it as "no reasons".

## Managing a running plan

On an **active or paused** plan (not a draft — activation chooses the channels — and not a closed one) a recruiter or Leadership user has
these controls on the role's Sourcing card:

* **Add channel** — pick a channel that is not in the plan. Tracking starts today; its first task falls due in 1–2 working days (on a
  paused plan the clock starts when the role is back on). A channel that is already in the plan cannot be added again (409).
* **Bring back** (on a channel that was left out) — the same, with the earlier reason shown. Completing the channel's first task again
  brings its follow-ons back (renewal, follow-up, repost, weekly outbound) with fresh due dates; ones that are running are left alone.
* **Undo skip** (on a skipped task) — a skipped follow-up is due tomorrow; a skipped first task gets its normal 1–2 working days. Not offered for a channel that is left out (bring the channel back first)
  or on a plan that is not active.
* **Edit strategy note** — the note shown on the card to HR (the Hiring Manager never sees it); the change is written to the plan's history.
  There is no owner to change: **sourcing is owned by the HR/Admin persona as a whole**, not by individuals. Every HR user sees the same
  My Tasks → Sourcing queue and can complete, skip or resolve anything on any plan; the card shows "Owner: HR".

Also enforced by the server (these are API rules the screens never trip): a task that was skipped, or that belongs to a channel that is left out
or a closed plan, cannot be marked done (409); a plan can only be activated while it is a draft (a paused plan resumes with its role); and a
channel added to a paused plan falls due 1–2 working days after the role is back on, not a whole pause later.

**Closing a role** skips every open task and clears its alerts. Nothing is queued — there is no "take down the postings" task; taking a
posting down on the portal is the recruiter's own job and is not tracked.

**Known gaps:** none open in the plan / channel / task workflow.
