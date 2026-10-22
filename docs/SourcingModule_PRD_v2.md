# Sourcing Execution & Accountability — Product Spec (current state)

**Document status:** reflects the system **as built on 22 October 2026**. Phases P0–P2 are live in production (switched on 20 October). The 21 October **workspace release** — the plan workspace, per-role qualified target, weekly channel trackers, Close/Reopen channel, plan history and AI next steps — was merged to `main` on 22 October (PR #11) and its database change applied to production that day. **On 22 October the plan workspace also moved from the bottom of the Dashboard to its own page, Sourcing, in the left menu** (§9); that move is built and tested on a branch and is not yet merged. P3 and P4 are specified here but not built. · **Owner:** Aaron Newton (Founders Office) · **Origin:** Mansi Jain's seed PRD · **Supersedes:** the 14 October 2026 design spec (whose "as built" notes are folded in below).

---

## 1. Summary

Every open role gets a **sourcing plan**: the channels the team will use, and dated **commitments** for each (publish the posting, brief the agencies, launch the referral push, hit the weekly outbound target). Recruiters confirm work with one click. HMS compares the plan with reality and raises a short list of **exceptions** — things that were promised and did not happen — each of which must be answered one of three ways: *catch up*, *change the plan*, or *genuine blocker*.

**Sourcing is owned by the HR/Admin persona as a whole, never by an individual recruiter.** Everyone in HR sees the same queue and can act on every plan. Leadership sees an exception-led section at the bottom of the Dashboard. Every role's plan is on the **Sourcing** page in the left menu, which every persona can open while the module is on; Hiring Managers see a read-only view of their own roles there. Nothing in the existing hiring workflow, SLA engine or dashboards changes, and the whole module can be switched off with one environment variable.

## 2. Problem and goals

Sourcing used to be reactive. When a role was thin, management reconstructed after the fact which channels had been used, why follow-ups slipped and what had been promised. The Hiring SOP states expectations — activate channels within one working day of approval; at least five qualified candidates a week for each open P0/P1 role; the Hiring Manager steps in after five working days short — but nothing enforced or even measured them.

For any role, without chasing anyone, the module answers:

1. What was the sourcing strategy, and what did we commit to?
2. What has actually been done, and what remains?
3. Where is execution or effectiveness falling short, and what corrective action is required?

It is an **execution-management layer**, not another candidate-pipeline dashboard. Recruiters must never spend more time reporting than doing.

**Success measures:** share of open roles with an active plan · on-time completion of commitments · time to resolve exceptions · fewer roles reaching "low pipeline" without a visible, owned corrective action.

## 3. Design rules (Aaron's brief)

1. Research and refine the seed PRD rather than transcribe it.
2. Reuse existing HMS workflows (roles, My Tasks, the dashboard, the Gmail service).
3. Never disrupt what exists: the SLA engine, `pending_actions`, the main dashboard payload, Source quality and `candidates.source` are untouched.
4. Use free external APIs where they genuinely exist (only the Google Workspace APIs HMS already holds qualify).
5. Make sourcing simpler and actionable: one queue, one plan per role, six exception types.
6. Dashboard additions go **below** the existing modules.

## 4. Decisions on record

| Decision | By / when |
|---|---|
| "Qualified candidate" = shortlisted by a person **or** ResumeIQ score above 60, always shown as its two parts, switchable by a setting | Aaron, Oct 2026 |
| Outbound prospect work stays in Google Sheets; HMS pulls via the Sheets API (P4) | Aaron, Oct 2026 |
| HMS sends templated outreach directly from the owner's mailbox from day one, with guardrails (P4) | Aaron, Oct 2026 |
| Hiring Manager view is **partly** redacted by design: a channel's excluded reason and an exception's resolution path and dates stay visible | Aaron, 19 Oct 2026 |
| Dashboard shows a "couldn't load" card until the backend is deployed — accepted | Aaron, 19 Oct 2026 |
| Channels are managed on the plan, with Add channel, Bring back, Undo skip and Edit strategy note; a channel added mid-flight starts its own first task | Aaron, 19 Oct 2026 |
| **No "take down the postings" task** when a role closes — removed with every workflow around it | Aaron, 19 Oct 2026 |
| **Ownership is the HR persona, not individuals** ("no segregation of HRs for sourcing") | Aaron, 19 Oct 2026 |
| **Public holidays are not modelled**; working days are Monday–Friday | Aaron, 19 Oct 2026 |
| E-mail digests stay **off** | Aaron, 19 Oct 2026 |
| Stay on Vercel Hobby as is; leave the dormant e-mail-digest cron alone | Aaron, 19 Oct 2026 |
| The Google Form change (the "How did you hear about this opening?" dropdown) was optional on 19 Oct; from 21 Oct it also feeds the weekly channel tracker, so it is needed for the tracker to count | 19 / 21 Oct 2026 |
| Channel tasks: log the post (link + weekly sourcing target), then an automatic weekly tracker (red/green); Close channel replaces Stop using and keeps a summary; the qualified target is per role; Needs attention gives AI-written next steps; the plan history logs every action; the whole plan moved from the role page to a workspace (first a Dashboard section — see the next row) | 21 Oct 2026 |
| The plan workspace moves from the bottom of the Dashboard to its **own page, Sourcing, in the left menu** (after Roles; shown to every persona, and only while the module is on); the Dashboard keeps only the Sourcing execution exceptions section; the role page keeps only its header chip; old Dashboard links (`?sourcing_role=`, `#sourcing-workspace`) redirect to the new page | 22 Oct 2026 |

## 5. Who can do what

| Persona | Sourcing capabilities |
|---|---|
| **HR / Admin** (`hr_recruiter`) | Everything, on every plan: activate plans, mark tasks done, skip and undo, add or bring back channels, edit the strategy note, resolve exceptions. Has the **Sourcing box in My Tasks**. |
| **Super Admin** | The same as HR/Admin on every plan, plus the Sourcing box. Changes thresholds in settings together with Leadership. |
| **Leadership** | The same write rights as HR (Leadership is HR-tier); reads the Dashboard exceptions section and every plan on the Sourcing page; changes sourcing settings. Has no Sourcing box in My Tasks (that box stays alerts-only by design). |
| **Hiring Manager** | A **read-only view of their own roles** (matched by name, including a role with several Hiring Managers): plan structure, status, dates and counts. No strategy note, baseline, history, links, completion notes, exception reasons or provisional signals. Still included, on purpose: a channel's excluded reason and an exception's resolution path, snooze date and blocker date. A Hiring Manager of another role gets nothing. |

**No individual owner.** A plan carries no owner field in the product: activation asks for none; the plan shows "Owner: HR"; every HR user sees the identical My Tasks queue (there is no "mine" and no "everyone" switch); the dashboard table has no owner column. The one named person that remains is the **blocker owner** — who must unblock a blocked exception — chosen from the list of active people.

## 6. Core model

- **Plan** — one per role. Status `draft`, `active`, `paused` or `closed`; a strategy note; a **baseline** frozen at activation so the original commitment survives later edits; a change history. A draft is created automatically for every open role (on Approval, by a one-off backfill, and whenever a role is opened on the plan page). A draft is not tracked: it raises only "plan not activated". **Activation is the commitment moment.**
- **Channel** — `LinkedIn` and `Naukri/IIMjobs` (portals), `Agency`, `Internal Referral`, `Direct Outreach`. A channel is `planned` (not live yet), `active` (live) or `excluded` (not used, with a written reason).
- **Commitment** — a dated task on a channel, with a rolling due date (last done + cadence). It becomes overdue only after its due **day** ends (IST). Completing it records who and when, optional evidence, and rolls recurring tasks forward.
- **Evidence** — a link, a count, a note or an attestation, labelled *self-reported* or *auto* (reserved for later phases where HMS sees the work itself).
- **Exception** — a detected gap between plan and reality, with plain-language "what was committed / what happened / next action". At most one live exception per (role, channel, type).
- The role's **priority, openings and dates are read from the role**, never copied. The Close Target is not used for urgency.

### 6.1 Working days and dates

All dates are India Standard Time. **Working days are Monday to Friday; public holidays are not modelled** — a task that falls due on a holiday is simply due that day. Due dates are anchored to the **activation date** (never to an old approval date), so activating a plan for an existing role cannot create an instant overdue pile.

### 6.2 Commitment templates

| When | Commitment | Due |
|---|---|---|
| Plan activated — portals | Publish the posting on LinkedIn / Naukri | 1 working day after activation |
| Plan activated — Agency | Select agencies and share the role brief | 2 working days |
| Plan activated — Internal Referral | Launch the employee referral push | 1 working day |
| Plan activated — Direct Outreach | Start outbound outreach and set the weekly contact target | 2 working days |
| Activation task done — portals | Renew the posting before it expires (repeats every 30 days; due 3 days before expiry, counted from the posting's own date) | 27 days after posting |
| Activation task done — Agency | Follow up with the briefed agencies (weekly) | 7 days |
| Activation task done — Referral | Repost the role to employees | 14 days |
| Activation task done — Outreach | Log this week's outbound contacts against the target (weekly; the first 4 weeks only record a baseline and raise nothing) | 7 days |

A follow-on task is created only when the activation task is completed, so a task never exists before the way to evidence it does. On the activation screen, a channel ticked **"Already running before today"** is recorded as done at once and its renewal clock starts from the posting's own date — turning a backlog into one click.

### 6.3 What "qualified" means

A candidate counts as qualified from the first moment they were **shortlisted by a person** (the first move out of "Applied and Screened") **or** scored **above 60** by ResumeIQ. Both parts are always shown separately, because a score above 60 is easy to reach. The setting `qualified_rule` (`either`, `shortlisted`, `scored`) tightens it without code. The count uses only immutable timestamps, so any past week can be rebuilt. The SOP target applies to open **P0/P1** roles only.

## 7. Plan lifecycle

### 7.1 Role status drives plan status

The plan is reconciled from the role's **new status** and the plan's **current status**, never from the path the role took. Saving the same status twice changes nothing.

| Role becomes… | Plan: none | draft | active | paused | closed |
|---|---|---|---|---|---|
| **Approved / Live – Sourcing** | create a draft | stays | stays | resumes (every open due date moves out by the time paused) | returns to draft (re-activate it) |
| **On Hold** | — | stays | pauses (clocks stop) | stays | stays |
| **Closed – Filled / Cancelled** | — | closes | closes | closes | stays |
| **Draft / Under Review** | — | stays | stays | stays | stays |

**Closing** skips every open commitment and resolves every live exception as "role closed". **Nothing is queued** — there is no take-down task; taking a posting down on the portal is the recruiter's own job and the plan does not track it. A role that is reopened returns to a draft plan and must be activated again; history is kept, and re-activating with "already running" brings the skipped follow-ons back.

### 7.2 Managing a running plan

On an **active or paused** plan, HR-tier users have these controls in the plan's panel on the Sourcing page (a draft chooses its channels at activation; a closed plan is finished; a Hiring Manager sees none):

| Control | What it does |
|---|---|
| **Add channel** | Adds a channel that is not in the plan. Its first task falls due in 1–2 working days from today (on a paused plan, 1–2 working days after the role is back on). Adding a channel already in the plan is refused. |
| **Bring back** | Restores a channel that was left out, showing the earlier reason. Completing its first task again brings its follow-ons back with fresh dates; ones already running are left alone. |
| **Undo skip** | Reopens a skipped task: a skipped follow-up is due tomorrow, a skipped first task gets its normal 1–2 working days. Not offered for a channel that is left out. |
| **Close channel** | Stops a channel, with a required reason. Its open tasks are skipped and nothing is chased, but the post link, the targets and every weekly result stay on the plan as a summary (§7.3). Replaces "Stop using". |
| **Reopen channel** | Brings a closed channel back: its follow-up tasks return and the weekly tracker restarts from that day (the next day if it was closed the same day) with the same target. |
| **Edit target and link** | On a live LinkedIn / Naukri/IIMjobs / Direct Outreach channel: changes the weekly sourcing target and the post link (§7.3). |
| **Edit plan** | The strategy note (HR only) and this role's weekly qualified target (§7.4); every change is written to the plan history. |

Rules enforced by the server: a task that was skipped, or belongs to a channel that is left out or a closed plan, cannot be marked done; a plan can be activated only while it is a draft; every action on a task takes the plan's lock first, so two people acting at once can neither deadlock nor leave open work on a closed plan or a left-out channel.

### 7.3 LinkedIn, Naukri/IIMjobs and Direct Outreach: log the post, then a weekly tracker

These three channels run as **two** things (21 Oct 2026). The first task is *logging the post* — the job post, or the outreach campaign. To complete it (or to tick "already running" at activation) HR must give the **link** and a **weekly sourcing target**: a whole number of applicants per week, qualified and unqualified together. The tracker starts the day it is logged.

From then on HMS measures the channel automatically. It counts every application to the role whose **"How did you hear about this opening?"** answer on the application form maps to that channel, in consecutive 7-day periods from the logging day (India dates). When a week ends it records **actual vs target** — **green "Met"** at or above the target, **red "Missed"** below — as one line on the channel, and as an entry in the plan history; the week in progress shows live above them. Nobody types the numbers in. The renewal reminder for the two portals (every ~30 days) stays; Direct Outreach's earlier "log this week's contacts" task is gone because the tracker replaces it; Agency and Internal Referral are unchanged.

A target can be changed on a live channel (**Edit target and link**): weeks that already finished keep the target they were measured against. A tracker runs only while its channel is live and its plan is active. Anything that stops one — closing the channel, leaving it out, removing it from the role's Recruitment Mode, the role going On Hold, the role closing — records the weeks that had ended and then the week in progress as **"cut short"** (shown, but neither met nor missed, and not counted in the totals) and stops the tracker; starting again (logging the post again, Reopen channel, the role coming back) begins a fresh tracker from that day. A channel that is live but has no target (it was logged before this release) has its "log the post" task handed back with a due date two days after the release, and tracking starts when HR completes it with a link and a target.

**Close channel keeps the story.** A closed channel shows its summary: closing date and reason, the post link, the weekly target, weeks tracked and how many were on target, how many applicants carried its tag (and how many qualified), and the weekly results. **Reopen channel** continues it.

### 7.4 The weekly qualified target is per role

Each plan carries its own target of qualified candidates in the last 7 days (**Edit plan**, or at activation; 1–500). Blank means the default: **5 for a P0/P1 role** (the SOP), **none for a P2/P3 role** — and a P2/P3 role is checked like any other once it has one. The panel shows "X / Y qualified in the last 7 days" and says whether Y is the role's own or the default. The "not enough qualified candidates" signal, the My Tasks volume line and the workspace pills all use it. It is separate from a channel's weekly sourcing target (§7.3).

**Recruitment Mode.** The role's own "Recruitment Mode" field is read-only on the role page once a plan exists; the plan is authoritative and mirrors one way, into the role, through the audited role edit. A channel added to the role by any other route joins the plan with its first task; one removed there is left out (the automatic reason is matched exactly, so a recruiter's own reason is never overridden).

## 8. The exception engine

Computed on read, idempotent and isolated: it uses its own tables, its own 3-minute throttle (called when the queue, the Sourcing page or the Dashboard is opened) and a daily cron, and never touches the SLA engine. Correctness comes from a database rule — at most one live exception per (plan, channel, type, key) across the open, snoozed and blocked states — not from the throttle.

| Exception | Raised when | Live or provisional |
|---|---|---|
| **Plan not activated** | A role approved **after go-live** still has no active plan more than 1 working day later (existing roles appear in the "Plans to activate" list instead, so they can be rolled out in waves) | Live |
| **Channel set-up overdue** | A channel's first task is overdue (for LinkedIn, Naukri/IIMjobs and Direct Outreach that is logging the post: link and weekly target) | Live |
| **Task overdue** | Any other open task is past its due day (renewal, repost, follow-up) | Live |
| **Follow-up overdue** | The agency follow-up is overdue | Live |
| **Not enough qualified candidates** | An open P0/P1 role has fewer than 5 qualified in the rolling 7 days on **each** of the last 5 working days | **Provisional** until `shadow_until` |
| **Blocker overdue** | A recorded blocker's deadline has passed | Live |

The overdue family rolls up to **one exception per channel at its worst state**. Severity = role priority (P0 40, P1 30, P2 20, P3 10) + days overdue (capped at 20) + 15 if the role is low on pipeline.

**Shadow mode.** The first time the engine runs enabled it stamps `go_live_date` = today and `shadow_until` = today + 42 days (never overwriting a value already there). Until then, threshold signals are *provisional*: shown to HR-tier users only (greyed, on the Dashboard and in the role's plan on the Sourcing page), no My Tasks item, no Hiring Manager view, never named in an e-mail, not resolvable. This exists because, with real data, 7 of 9 P0/P1 roles would have tripped the volume rule on day one. A draft plan's volume signal is always provisional.

### 8.1 Resolving an exception

| Path | Needs | Effect |
|---|---|---|
| **I'll catch up** | A reason and a date within 14 days | Snoozed; it comes back if still true on that date |
| **Change the plan** | A reason; optionally "close the channel" | Closed, with the reason recorded in the plan history |
| **I'm blocked** | A reason, who must unblock it, and a deadline within 60 days | Parked as blocked; raises "blocker overdue" if the deadline passes |

Provisional signals cannot be resolved. System facts and the recruiter's stated cause are stored separately.

## 9. Where it appears

1. **Sourcing page** (left menu, after Roles; route `/sourcing`) — one role's whole plan at a time. It was the last section of the Dashboard from 21 Oct 2026 and has been a page of its own since 22 Oct 2026 (before that, a card on each role's page). A pill for every role with an active or paused plan switches the panel below: the plan state and "Owner: HR", the target gauge with both qualified parts, **Needs attention** (each problem with its recommended next steps — §9.1), each channel with its weekly tracker (red/green weeks), tasks and close/reopen, applications by source, and the **plan history** timeline. Plans waiting to be activated are listed under the pills so they can be opened and activated. **Every persona sees the menu entry while the module is on** (HR/Admin, Hiring Manager, Leadership, Super Admin); while it is off the entry is hidden and the page, if opened directly, says "Sourcing is switched off". The role page keeps only a header chip ("Sourcing on track", "Sourcing: 2 issues", "Sourcing paused", "Sourcing plan not activated") that opens the role's plan on this page, and My Tasks, the Dashboard's exceptions table and the e-mails link there the same way (`/sourcing?sourcing_role=<role id>`). A link made before the move (`/dashboard?sourcing_role=…`, with or without `#sourcing-workspace`) is redirected to the new page. A Hiring Manager sees the same panel for their own roles, read-only and without links, notes, closing reasons, history or recommended steps.
2. **My Tasks → Sourcing** (HR/Admin and Super Admin): plans to activate, tasks due today, open exceptions grouped by role (top 5 and "show N more"), a count of those catching up or blocked, and this week's volume against target. One shared queue for all of HR.
3. **Dashboard → Sourcing execution** — after Operational velocity: a one-line summary (active plans / open roles, on-time % over 14 days, overdue count, open exceptions by priority) and an exceptions table (top 10, "show all") with *committed / what happened / next action / age*; each row's role name opens that role's plan on the Sourcing page. This is the **only** sourcing section left on the Dashboard. Hiring Managers see only their own roles, without provisional rows or blocker dates.
4. **E-mails** (internal only, from hr@, **off by default**): one daily note to all active HR/Admin users when something needs doing (weekdays), and a Monday summary to the configured leadership addresses. Each role in a note links to its plan on the Sourcing page, and the daily note ends by pointing to "Sourcing in the left menu of HMS (or My Tasks → Sourcing)". Each kind is claimed for the day first, so a retried cron cannot send twice.

### 9.1 Recommended next steps (AI)

Under **Needs attention**, each problem's **Next** box and a short plan-level box give concrete steps written from the role's actual situation: which channel, what to do, by when. HMS hands an AI model (Claude) a *facts pack* — the role, its target and the gap, the pipeline **as counts** (waiting for a shortlist decision, scored above 60, over 48 hours, interviewing, new this week, the Hold-for-Future pool on other roles), each channel's weekly target, this week, last four weeks and open tasks, and the open problems. It contains **no candidate names, e-mails, phone numbers or links**. The answer is validated (a step may only name one of the five channels or one of the problems it was given), saved, and reused for up to a day while the numbers are the same; it is written again when they change (at once when a *new* problem appears) and on **Refresh** (once a minute at most). If the AI is unavailable or has no key, rule-based steps from the same facts are shown and labelled. HR/Admin and Leadership only.

### 9.2 Plan history

Every action on a plan is logged and shown as a timeline with who did it: tasks done, skipped or undone; channels added, closed or reopened; target and link edits; the strategy note; activation, hold, resume, close; resolutions (catch up, blocker, change plan). HMS adds its own entries, marked **System**: a problem it flagged or saw clear by itself (provisional signals are not logged), and the result of each finished tracker week. Filter by tasks, channels, weekly results, targets, alerts or plan; the latest 200 are loaded. HR/Admin and Leadership only.

## 10. Attribution

Today every Job Application Form applicant is stamped `LinkedIn` by the ingest, so **channel yield cannot be trusted**. The fix is a visible dropdown on the form, **"How did you hear about this opening?"**, with the options **Linkedin, Naukri/IIMJobs, DigitalPaani HR Outreach, Hiring Agency, DigitalPaani Employee Referral**. The Apps Script forwards it as a `source_tag` and the backend maps each option to a channel — Linkedin → LinkedIn, Naukri/IIMJobs → Naukri/IIMjobs, **DigitalPaani HR Outreach → Direct Outreach, Hiring Agency → Agency, DigitalPaani Employee Referral → Internal Referral** — and stores it in `applications.sub_source` (spelling and case are forgiven; a form with no answer, or an answer that is none of these, is labelled "Not tagged" or "Other"). Since 21 Oct 2026 it also **drives the weekly channel tracker** (§7.3), so each job post or campaign should link to the form with its option pre-filled (Google Forms → "Get pre-filled link"). It is the applicant's own answer, so it is *claimed* attribution; sources with fewer than five applications are flagged "too few to judge". `candidates.source` and the existing Source quality figures are untouched.

**Without it** the module still works — plans, tasks, exceptions, the queue and the dashboard — but the weekly trackers count nothing (every week would read as missed) and "Applications by source" cannot say where applicants came from, so add the field before relying on the tracker. Order: update the live Apps Script first (the two HANDLED_ELSEWHERE entries and the `source_tag` line; never paste the reference copy over it), have the module on, then add the dropdown.

## 11. Data model

Eight additive tables, all `CREATE … IF NOT EXISTS`, BIGSERIAL ids, row-level security on with no policies (the backend bypasses it; direct API access is blocked). No existing table changed.

| Table | Holds |
|---|---|
| `sourcing_plans` | One per role: status, strategy note, baseline, activation / pause / close times |
| `sourcing_plan_channels` | Channel, state, excluded reason, config (posting link and date), targets |
| `sourcing_commitments` | Each task: kind, title, cadence, due, status, meta |
| `sourcing_commitment_log` | Append-only: who completed what, when, against which due date |
| `sourcing_evidence` | Evidence attached to a completion (self-reported or auto) |
| `sourcing_exceptions` | Detected gaps and how they were resolved (partial unique index over open / snoozed / blocked) |
| `sourcing_plan_changes` | Plan history: activation, channels added or left out, skips, strategy-note edits |
| `sourcing_settings` | Key/value settings and the "digest sent today" claims |

`sourcing_plans.owner_user_id` and `sourcing_exceptions.owner_user_id` still exist in the schema but are **unused and always empty** (kept so no production migration is needed). Settings: `go_live_date`, `shadow_until`, `qualified_rule`, `portal_expiry_days` (30 / 30), `renew_lead_days` (3), `agency_followup_days` (7), `referral_repost_days` (14), `weekly_baseline_weeks` (4), `volume_min_qualified` (5), `volume_window_days` (7), `volume_gap_working_days` (5), `referral_audience_email`, `digest_recipients`, `daily_digest_enabled` (off).

## 12. API (`/api/sourcing`)

All routes answer `{ enabled: false }` (reads) or 503 (writes) while the module is off.

| Route | Purpose | Who |
|---|---|---|
| `GET /status` | Is it on, plus the public settings | any signed-in user |
| `GET /plans/:roleId` | The plan view (seeds a missing draft for an open role) | HR-tier: full; the role's Hiring Manager: redacted; others: 403 |
| `POST /plans/:planId/activate` | Activate a draft (channels, "already running", strategy note) | HR-tier |
| `PATCH /plans/:planId` | Edit the strategy note (an owner field is refused with 400) | HR-tier |
| `PUT /plans/:planId/channel` | Add, bring back or leave out a channel (channel in the body — `Naukri/IIMjobs` contains a slash) | HR-tier |
| `POST /commitments/:id/complete`, `/skip`, `/reopen` | Mark done, skip with a reason, undo a skip | HR-tier |
| `POST /exceptions/:id/resolve` | Catch up / change the plan / blocker | HR-tier |
| `GET /workspace` | The roles on the Sourcing page: active and paused plans to switch between, plus draft plans waiting to be activated (HR-tier only) | HR-tier: every role; a Hiring Manager: only roles named on them, read-only; others: 403 |
| `GET /queue` | The shared My Tasks queue | HR-tier |
| `GET /people` | Who can be named as a blocker owner (never includes automation accounts) | HR-tier |
| `GET`/`PUT /settings` | Read (HR-tier); change (Leadership / Super Admin) | — |
| `GET /api/dashboard/sourcing` | The Dashboard's Sourcing execution section | any signed-in user, role-locked for Hiring Managers |
| `GET`/`POST /api/cron/sourcing-check` | The daily engine run (cron secret) | Vercel Cron |

## 13. Safety, non-disruption and rollout

- **One switch.** Without `SOURCING_ENABLED=true` on the backend the module is inert: reads say "disabled", writes are refused, the role hook runs no queries, the UI hides itself. **Rollback** = set it to false and redeploy (tables stay, inert); a guarded script removes them.
- **Hooks never break existing flows.** The sourcing hook on a role save runs after the save commits and before JD generation, has its own error handling and tolerates missing tables — proven by a test that renames a sourcing table and shows a role save still succeeds.
- **PII.** Plan payloads carry no candidate personal data, and the Hiring Manager view is redacted (see §5).
- **Production today.** The schema is applied in Supabase (migration `20261019025305`, eight empty tables, matching the repo exactly). The code was merged on 20 October (PR #9) and `SOURCING_ENABLED=true` was set on the production backend the same day, so the module is on; its go-live clock starts at the first real use. As of 21 October one plan (R003) has been activated by HR. Six production roles' Hiring Manager names were corrected to the users' full names on 19 October (R003, R005, R007, R012, R0015, R020) so the Hiring Manager rules match.
- **Go-live order.** Deploy the backend, then the frontend (the dashboard shows a "couldn't load" card until the backend is live); set the flag and redeploy; activate P0/P1 roles in waves, with R016 as a dry run. (Optional: the Google Form change in §10.)
- **Vercel Hobby** is non-commercial and allows one cron run a day; the engine therefore also runs whenever the queue, the Sourcing page or the Dashboard is opened. Staying on Hobby was a deliberate choice.

## 14. Quality

Backend unit tests (engine detectors, working days, templates, e-mail builders, the plan-transition table) — 129 tests across 7 files; frontend component tests (the Sourcing page and its panels and dialogs, the sidebar entry and the legacy-link redirect, the dashboard section, My Tasks, Help) — 717 tests across 28 files for the whole frontend; backend 646 tests across 36 files for the whole backend; a 39-test integration suite against a real database (plan lifecycle, the engine and its concurrency, role-status chains, channel management, the no-owner rule, Hiring Manager redaction) and a browser suite for the screens. The whole local suite (API, database, browser and smoke projects, 646 tests at the 22 October release) passes with the module switched on apart from one pre-existing, unrelated timeout in the unmatched-candidates test, and the 34-test read-only smoke suite passes against the live production deployment. An independent review found and drove fixes for a deadlock between task actions and plan-level actions, a paused-plan date error and several silent re-opening paths; each fix has a test proven to fail without it.

## 15. Not built yet

| Phase | Scope |
|---|---|
| **P3 Automation** | One-click **agency brief** and follow-up, and **referral push**, sent through Gmail with the message id captured as automatic evidence; channel effort-versus-output once attribution is reliable |
| **P4 Outbound** | Company lists and prospect tracking in Google Sheets pulled via the Sheets API (the sheet owns status and dates; HMS keeps a touch log so weekly activity can be rebuilt); coverage and output exceptions; **direct-send templated outreach** from the owner's mailbox with guardrails (recruiter-supplied email only, never hr@, reserve-then-send log, per-person daily cap, signed unsubscribe link, suppression list, kill switch, DPDP notice); prospect and outreach views on the Sourcing page (the page itself now exists as the plan workspace) |
| **Parked** | Free job syndication (needs a public careers page), Cutshort, Brave search, GitHub search, Campus as a channel |

**Verified external options (14 October 2026).** *Used:* Gmail send, Drive, Calendar and the Sheets API — all free and already held by HMS. *Do not build against:* LinkedIn's posting/apply APIs (partner and paid) and any scraping or reseller of LinkedIn, Naukri, Indeed, foundit, Apna, Hirist or Internshala; Google Custom Search and Bing Search (closed); the free tiers of contact-data vendors; polling job boards for liveness. **LinkedIn data stays human-entered.**

**Compliance (P4).** India's DPDP Rules were notified 13 November 2025; notice, consent, retention and erasure duties apply from **13 May 2027**. Hence: store only a name, a human-entered profile link, current employer and role, a recruiter-supplied email, source and dates; no scraped contact details; 12-month default retention for unconverted prospects; suppression honoured before every send; convert to an applicant record only when the person applies.

## 16. Open questions

1. Confirm the portal expiry and renewal cadence and the agency first-response time (both provisional).
2. The internal audience address for referral pushes (needed for P3).
3. Whether to enable the Sheets API in the GCP project and share the trackers with the service account (needed for P4).
4. After the first weeks of provisional data: is "shortlisted OR ResumeIQ above 60" still the right definition of qualified?

## Appendix — What changed from the seed PRD, and why

| Seed PRD | This product | Why |
|---|---|---|
| Channels chosen at plan time | Seeded from the role's existing Recruitment Mode; the plan is authoritative afterwards | The requisition already captures it; two pickers would drift |
| Exceptions as work items | Own tables and endpoint, computed on read | `pending_actions` would have inflated every HR user's badge and been swept by the SLA engine |
| 7+ exception types | 6, with threshold signals provisional first | 7 of 9 P0/P1 roles would trip the rule on day one |
| Per-recruiter ownership | **HR persona owns every plan** | Aaron: no segregation of HRs for sourcing |
| Holiday calendar | Monday–Friday only | Aaron: the complexity is not needed |
| Take-down tracking on close | None | Aaron: not worth the complexity |
| Candidate source from existing fields | Optional form dropdown → application-level `sub_source` | Existing source data is wrong (every form applicant is `LinkedIn`) |
| Portal liveness tracking | Attested plus expected expiry; "unknown", never "closed" | No free API; scraping is prohibited |
| Leadership, HR and recruiter dashboards | An exceptions-led Dashboard section, one My Tasks box, one plan per role on a Sourcing page (a chip on the role page) | Avoid a wall of numbers |
