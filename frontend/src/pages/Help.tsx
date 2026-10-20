import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, ExternalLink, HelpCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { PERSONAS } from '../types/index.ts';
import { sourcingApi } from '../services/api.ts';

interface Section {
  id:       string;
  question: string;
  answer:   React.ReactNode;
}

// Grouped so the page reads as a table of contents, not one long list —
// each group maps to one of the four things item #23 asked for: sections,
// workflow/logic, AI automation, and where to find things.
const GROUPS: Array<{ title: string; gated?: 'sourcing'; sections: Section[] }> = [
  {
    title: 'What each section of the Hiring Master System is for',
    sections: [
      {
        id: 'dashboard',
        question: 'What am I looking at on the Dashboard?',
        answer: (
          <>
            <p>A live snapshot of hiring health, in three parts. The top KPI cards (Roles Snapshot, Active Candidates, SLA Breaches) each carry four supporting sub-metrics — hover the{' '}
            <span className="italic">i</span> icon next to any card or section title throughout
            the app for an on-the-spot explanation of exactly what it measures.</p>
            <p className="mt-2">Below that, the <strong>Hiring Funnel Snapshot</strong> is an
            interactive chevron strip: click any stage to see which SLA breach types are open
            there and exactly who's overdue, filterable by owner (HR/Recruiter or Hiring Manager).
            Role isn't a filter local to this section — it inherits the Role filter from the
            master filters above, like every other section.</p>
            <p className="mt-2">Right under it, <strong>SLA breaches by role</strong> shows the
            same open breaches by role instead of by stage: one stacked bar per open role (the
            eight with the most breaches, or all of them with <em>Show all</em>), longest first.
            The bar is split by where in the funnel the overdue candidates are sitting — five
            steps, from <em>Applied &amp; Screened</em> through <em>Reference → Offer</em>, each a
            darker blue the further along it is. Hover a segment for the exact count; click a bar
            for the second level — the stage-by-stage split with each breach type and who owns
            it. The legend highlights one step, and <em>Table</em> shows the same numbers as
            rows. It follows the master filters (not the owner buttons — it always counts both
            HR and Hiring Manager breaches, and the drill-down shows who owns each), and a
            Hiring Manager sees only their own roles. Breaches on roles that aren't open (closed, cancelled or
            still a draft) aren't drawn; a note under the chart says how many there are.</p>
            <p className="mt-2">Further down: <strong>Aging roles</strong> (every role currently
            Approved, Live – Sourcing, or On Hold, with days-open shown for all of them — only
            ones actually past their Close Target get a red/yellow flag, sorted to the top; On
            Hold roles are listed for reference but never flagged. A red <strong>!</strong> next to
            a role's name means no candidate on that role has had any real movement — a stage or status change, feedback — in 3+ days; new applications arriving and automatic scoring don't count toward this, so a role can't look active just because people are still applying
            to it while nobody's actually working the pipeline), the <strong>Hiring
            funnel</strong> chart
            (every stage, broken into Active/Rejected/Withdrawn/Hold for Future so a stage never
            silently disappears just because nobody's currently sitting there), Source Quality,
            Low Pipeline Roles (open roles with <strong>fewer than 3 shortlisted candidates and
            fewer than 8 active candidates</strong> in the pipeline — those two columns decide who
            is listed; the scored-above-60 columns beside them are shown for information only),
            and Operational
            Velocity (turnaround time per stage,
            Interview→Offer ratio, and the biggest drop-off stage shown both by raw count and by
            rejection rate, since those two can point at different stages). When the Sourcing module is switched on, a final <strong>Sourcing execution</strong> section lists the sourcing exceptions (see the Sourcing group below).</p>
            <p className="mt-2">Filters at the top (Department, Location, Recruitment Mode,
            Priority, Role) scope every section together. <strong>A Hiring Manager's dashboard is
            locked to their own role(s)</strong> — the Role filter is replaced with a fixed
            indicator and can't be changed, enforced on the server regardless of what the page
            sends.</p>
          </>
        ),
      },
      {
        id: 'roles',
        question: 'What is the Roles page, and how is it different from a role\'s detail page?',
        answer: (
          <>
            <p>Roles lists every requisition — one row per position, with priority, department, location, openings, age, Active Candidates, Active Shortlist and status (HR-tier users also see a Salary Range column; the hiring manager is searchable rather than a column). Click into a role for its full detail: requirements, compensation band (HR-tier only), approval status, links (Long-form JD, Social JD and Assignment Link), pipeline, and activity timeline. New roles normally arrive automatically from the Requisition Form, but the New Role / Request Role button lets you add one directly. HR can also discard a Draft that isn't going ahead — it is permanently deleted, and refused if the role already has applications.</p>
            <p className="mt-2">Once a role is marked <strong>Closed – Filled</strong> or{' '}
            <strong>Closed – Cancelled</strong>, a <strong>Download Closure Summary</strong>{' '}
            button appears on its detail page for HR-tier users — a 1-page PDF retrospective covering every
            candidate the role ever saw (not just the ones still active), total SLA breaches by
            type, source quality, and how long it took to close.</p>
          </>
        ),
      },
      {
        id: 'candidates',
        question: 'What is Active Candidates, and what are "Unmatched Candidates"?',
        answer: (
          <>
            <p>Active Candidates lists applications across every role — except Rejected and Withdrawn ones, which live in Archived Pipeline — up to the 100 highest-scoring, with the same filter set as the Dashboard and a server-side search that finds candidates beyond the 100 shown. Company / Industry is a merged column ("company /
            industry", both from the candidate's own profile); Application Date shows how many
            days ago the candidate applied. The Last Updated column shows a one-line subtext of
            what actually happened most recently (a stage change, a score, an email sent) — not
            just when. Click the <strong>Fit</strong>, <strong>Application Date</strong>, or{' '}
            <strong>Last Updated</strong> column headers to sort by that column — click again to
            flip direction (starts descending); sorting only reorders whatever rows are currently
            visible after your filters. An amber <strong>Unmatched Candidates</strong> banner can
            appear above the table — every candidate with no application to any role yet, for
            either reason: a resume was added directly (or an old application was removed), or a
            candidate applied via the Job Application Form but the role name they typed didn't
            match any role in the system closely enough to auto-link. HR can link each one
            manually, use the suggested-role quick link when the system found a likely match, or
            delete the candidate outright.</p>
            <p className="mt-2">Every candidate also carries a best-effort <strong>Gender</strong>{' '}
            tag (M/F), auto-computed from their first name — an unrecognized or genuinely
            ambiguous name is left blank rather than guessed, and it can't be edited from the screens today. Filterable alongside every other master filter,
            here and on Archived Pipeline and My Tasks' Ready for Review.</p>
          </>
        ),
      },
      {
        id: 'candidate-detail',
        question: 'On a candidate\'s page, why does a "Rejected" tag look clickable?',
        answer: (
          <p>Click any red <strong>Rejected</strong> tag on a candidate's applications to see the
          exact reason(s) (and any additional detail) that were logged at the time — no need
          to dig through the activity timeline to find it. The Applications section itself now
          starts expanded by default when you open a candidate's page.</p>
        ),
      },
      {
        id: 'screening-notes',
        question: 'Why don\'t I see Screening & Risk Notes on every application? (HR/Leadership only)',
        answer: (
          <p>The "Screening & Risk Notes" panel on an application only shows automatically if it
          already has notes on it. If it's empty, click <strong>+ Add HR Screening Notes</strong>{' '}
          to reveal the fields and start one — this keeps the page from showing an empty panel on
          every application that's never needed one.</p>
        ),
      },
      {
        id: 'reference-checks',
        question: 'Where do I record a reference check?',
        answer: (
          <p>On a candidate's page, add a reference check with the reference's name, phone number, and relationship to the candidate, plus the feedback they gave and optional call notes. HR-tier users add one while the application is at the Reference Check stage, and at least one is needed before it can move on. Each one is logged individually — a candidate can have more than one reference check on record, and each stays attached to the specific application it was taken for.</p>
        ),
      },
      {
        id: 'stage-status-buttons',
        question: 'Where are the Stage/Status buttons on a candidate\'s page? (HR/Leadership only)',
        answer: (
          <p>If a candidate has exactly one application, Stage/Status buttons sit at the top of
          the page next to their name. If they have two or more applications, there's no single
          "the" application to act on from the top, so the buttons move down to sit on each
          application's own row instead. These buttons are HR-tier only — a Hiring Manager shortlists a candidate from Applied and Screened in My Tasks → Ready for review instead.</p>
        ),
      },
      {
        id: 'talent-pool',
        question: 'What is Archived Pipeline for?',
        answer: (
          <>
            <p>A separate holding area for candidates who are either <strong>on hold for future
            roles</strong> (good candidates, wrong timing) or <strong>archived</strong> (rejected
            or withdrawn). Rejected and Withdrawn applications are kept out of the main Active Candidates view (Hold for Future ones also stay visible there) so they don't clutter active hiring, but stay searchable here and re-linkable to a new role at any time by HR.</p>
            <p className="mt-2">It's a table, not a card grid — one row per candidate <em>and</em>{' '}
            application, so a candidate with more than one past application shows their full
            history here, not just the one that put them in this pool. Each row has its own{' '}
            <strong>Reactivate</strong> button to re-link that candidate to a new role.</p>
          </>
        ),
      },
      {
        id: 'scorecard-queue',
        question: 'What is My Tasks, and what is the Scorecard Summary table?',
        answer: (
          <>
            <p><strong>My Tasks</strong> is your own worklist, shown as a row of boxes with counts: <strong>Ready for review</strong> (candidates awaiting a shortlist decision — HR/Admin and Super Admin see everyone, a Hiring Manager sees only their own role's candidates, and Leadership sees only candidates flagged for Founder Review, since day-to-day shortlisting is HR/HM's job rather than a leadership task), <strong>Feedback Due</strong> (overdue interview and assignment feedback — HR/Admin and Super Admin see everyone's, a Hiring Manager only the rounds they're an interviewer on), and a third box that differs by persona: HR/Admin and Super Admin see <strong>Other Pending Actions</strong> (everything else actually theirs to resolve), plus a separate <strong>Leadership Alerts</strong> panel — company-wide notices like role-aging flags or the Feedback-Overdue escalation that nobody individually owns, kept visible but not counted toward the actionable badge; a Hiring Manager sees their own Other Pending Actions; Leadership sees Leadership Alerts directly. HR/Admin and Super Admin also get a fourth box, <strong>Sourcing</strong>, when the Sourcing module is switched on. Each list shows the 100 highest-priority, oldest open items. A Leadership user who is also the named Hiring Manager of a role (a name on the role's Hiring Manager field) keeps all of that and additionally gets that role's Hiring Manager work: its candidates join Ready for review, its overdue shortlist decisions land in Other Pending Actions, and the interview feedback they personally owe on that role (rounds where they're the listed interviewer, or that have no interviewer assigned) lands in Feedback Due — with a line at the top naming the role(s). Only that role — it doesn't make them a Hiring Manager anywhere else.</p>
            <p className="mt-1.5"><strong>Scorecard Summary</strong> is the table inside Ready for review — not a separate page (a role's Scorecard Summary button opens it filtered to that role). It lists scored candidates side by side with all 8 dimension scores (plus Portfolio for designer roles) and the verdict, filterable and searchable; only candidates at Applied and Screened have checkboxes and the Shortlist / Hold for Future / Reject actions, individually or in bulk — later-stage rows are there for comparison. Instead of a chevron, a centered <strong>View Highlights and Summary</strong> button under the score columns expands a candidate's strengths, red flags, and executive summary. HR/Admin also see a banner when some candidates have no ResumeIQ score (the automatic scoring didn't complete) with a <strong>Retry scoring</strong> button.</p>
            <p className="mt-1.5">For roles that get a <strong>portfolio review</strong> (today the
            Senior UX/Product Designer role), Ready for review has a <strong>Portfolio ≥ 7.5</strong>{' '}
            button beside the search box: it narrows the list to candidates whose portfolio
            review scored 7.5 or higher. Portfolio scores are whole numbers (0–10), so that means 8 or
            more, and candidates with no portfolio score — including every other role's — are hidden
            while it is on. The button only appears when the Role filter is clear or includes such a
            role.</p>
          </>
        ),
      },
      {
        id: 'agencies',
        question: 'What is the Agencies page? (HR/Leadership only)',
        answer: (
          <p>Tracks recruitment agencies — contract terms, fee tiers, replacement guarantees,
          billing terms — and the candidates they've submitted, so agency performance and fees can
          be reviewed against what they've actually delivered. Hires are counted from a
          candidate's own Source field (set to Agency) reaching Offer Accepted or later, not from
          an older per-application field.</p>
        ),
      },
      {
        id: 'comp-benchmark',
        question: 'What is the "Run benchmark" button on a role\'s page? (HR-tier only)',
        answer: (
          <p>Compensation benchmarking for that specific role, based on its own requirements
          (experience level, must-have skills, etc.) — not tied to any one candidate. It checks
          this system's own internal comp-benchmark records first, and only falls back to general
          market knowledge when there's no internal data for a role like this one. Same
          visibility rule as every other compensation field: HR-tier only.</p>
        ),
      },
      {
        id: 'user-management',
        question: 'What is User Management? (Super Admin only)',
        answer: (
          <p>The only place accounts actually get added, edited, or deactivated — "removing access" deactivates an account rather than deleting it, since a user's past actions (interview feedback, activity log entries) stay attached to their record. A user's Name must match what HR writes in a role's Hiring Manager field (whole name, ignoring case), or that person won't get that role's Hiring Manager view. Held by exactly one person at DigitalPaani.</p>
        ),
      },
    ],
  },
  {
    title: 'How the hiring workflow actually works',
    sections: [
      {
        id: 'role-lifecycle',
        question: 'What do the role statuses mean, and what is "Close Target"?',
        answer: (
          <>
            <p><strong>Draft</strong> (just created, not yet reviewed) → <strong>Under
            Review</strong> → <strong>Approved</strong> (an authorized approver has signed off —
            this is also when the role's Open Date is set) → <strong>Live – Sourcing</strong>{' '}
            (actively hiring) → <strong>On Hold</strong> or <strong>Closed – Filled</strong> /
            <strong> Closed – Cancelled</strong>. The acting approver's name and the approval date
            are recorded automatically the moment a role is approved (never something you type
            in) and shown on the role's detail page.</p>
            <p className="mt-1.5"><strong>Close Target</strong> is a separate date HR sets for
            when a role should realistically close. A role's red/yellow aging alert is driven
            entirely by this date, not by how long it's simply been open — a role isn't flagged
            at all until its Close Target has actually passed, and pushing the target out clears
            an existing alert. A role with no Close Target set falls back to flagging on
            days-since-opened instead, so nothing loses visibility for lacking one.</p>
          </>
        ),
      },
      {
        id: 'three-fields',
        question: 'Why does an application have a Stage, a Status, AND a Screening Status?',
        answer: (
          <>
            <p>They track three independent things, each updated separately:</p>
            <ul className="list-disc pl-5 mt-1.5 space-y-1">
              <li><strong>Stage</strong> — where the candidate sits in the pipeline (Applied and
              Screened → Interview rounds → Reference Check → Offer → Joined). Every applicant is
              scored by ResumeIQ automatically at Applied and Screened (the name reflects that
              scoring has already happened by the time a candidate is at this stage) and can be
              shortlisted straight into Interview Round 1 from there — Resume Review and
              Shortlisted no longer exist as separate stages.</li>
              <li><strong>Status</strong> — whether they're still active in that pipeline: Active,
              Rejected, Withdrawn, Hold for Future, or Joined.</li>
              <li><strong>Recruiter Screening Status</strong> — HR's own internal screening
              progress, separate from the pipeline stage the candidate visibly sits at (shown as a read-only label today).</li>
            </ul>
            <p className="mt-1.5">Rejecting or withdrawing a candidate always requires selecting
            a reason first — this is deliberate, not a bug, so hiring data stays auditable. When
            rejecting, tick <strong>one or more</strong> reasons (a candidate often fails on
            several things at once); withdrawals take a single reason.</p>
          </>
        ),
      },
      {
        id: 'interview-scheduling',
        question: 'What happens when I schedule an interview round?',
        answer: (
          <p>Setting a date/time and interviewer email(s) on a Standard round (Interview Round 1/2, Founders Round) sends a real Google Calendar invite to the interviewers, the candidate and hr@digitalpaani.com — you'll see a confirmation toast once it goes out. The Schedule Round button appears while the application is at one of those three stages. If the invite fails to send for any reason, the round itself is still created (scheduling isn't blocked on it) and a warning shows on the round instead. Assignment rounds don't go through Calendar at all — see the Assignment email question below for how those work instead.</p>
        ),
      },
      {
        id: 'rejection-email',
        question: 'Does rejecting a candidate notify them?',
        answer: (
          <p>Optionally, yes — after picking a rejection reason, an editable draft email is
          generated for you (tone matched to the reason, but never exposing the literal internal
          reasons to the candidate; if you tick several reasons the draft uses one neutral
          wording instead of singling any of them out). Review or edit it, then send it in the same action
          that marks the candidate Rejected — available both for a single candidate and for a
          bulk rejection. Sending is optional; leaving it unchecked just rejects the candidate
          with no email.</p>
        ),
      },
      {
        id: 'sla-pending',
        question: 'What triggers a "pending action" or an "SLA breach"?',
        answer: (
          <>
            <p>Every stage has a maximum time a candidate should sit there before someone needs
            to act. Each breach has its own named type and owner — hover the{' '}
            <span className="italic">i</span> next to the Dashboard's SLA Breaches card for the
            full list, but broadly: <strong>Idle Candidate</strong> (no movement for 48h+ at the
            flatter stages), <strong>Resume Shortlist Pending</strong> (Applied and Screened specifically),
            <strong> Interview/Founders "Not Scheduled"</strong> (a round hasn't been booked),
            <strong> Assignment "Not Sent"</strong> (the assignment hasn't gone out), or{' '}
            <strong>"Feedback Due"</strong> (feedback hasn't been submitted since a round happened), <strong>Assignment deadline breached</strong> (no submission within 60h of the assignment being sent), and <strong>Joining risk — no contact</strong> (no HR contact logged in the 5 days after Offer Accepted). A breached application is marked sla_breach and a
            pending action is raised for whoever owns that step. These checks run automatically
            whenever the Dashboard loads — there's no separate button to trigger them, and a
            breach resolves itself the moment its underlying condition is actually addressed
            (not just on the next scheduled check).</p>
            <p className="mt-2"><strong>Hiring SOP v2.1 — score-tiered windows:</strong> at Applied
            and Screened, Interview Round 1/2, Founders Round, and Assignment Round, a high-scored
            candidate (ResumeIQ fit score 75+) gets a tighter 24h window instead of the standard
            48h — on both the HR-facing side (shortlist/schedule/send) and the Hiring-Manager-facing
            "Feedback Due" side. Idle Candidate and Assignment Feedback Due (96h) are untouched by
            this — it's a targeted change for five named stages, not a blanket halving.</p>
            <p className="mt-2"><strong>Leadership escalation:</strong> if a Standard-round
            (Interview 1/2, Founders) Feedback Due breach is still open 96h after the interview,
            HMS raises a second, Leadership-owned flag — <strong>Feedback Overdue — Leadership
            Escalation</strong>, shown under My Tasks' Leadership Alerts — alongside the original
            Hiring-Manager-owned one, which stays open in parallel until feedback is actually
            submitted. This is additional visibility, not a replacement for the original flag.</p>
          </>
        ),
      },
      {
        id: 'over-budget',
        question: 'Why was I asked for a reason before shortlisting a candidate?',
        answer: (
          <p>If a candidate's expected CTC is 15% or more above the role's stated compensation
          band, the Hiring Master System requires an explicit, on-record reason before they can be
          shortlisted into Interview Round 1 — so an over-budget hire is always a documented
          decision, not an accident.</p>
        ),
      },
      {
        id: 'auto-advance',
        question: 'Can a candidate move to the next stage automatically?',
        answer: (
          <p>Yes — submitting feedback for an Interview Round 1/2, Founders Round, or Assignment
          Round that comes back genuinely positive (recommended to Proceed, or Proceed with
          Concerns, with an average score above the midpoint of the rubric) automatically
          advances the candidate to the next stage the moment that feedback is submitted, no
          separate manual step needed. A lukewarm or negative result (Hold, Reject, or a low
          score even with a positive recommendation) never triggers this — it only ever fires on
          a clearly positive outcome.</p>
        ),
      },
    ],
  },
  {
    title: 'AI automation in the Hiring Master System',
    sections: [
      {
        id: 'resumeiq',
        question: 'What is ResumeIQ, and when does it run?',
        answer: (
          <p>ResumeIQ automatically scores a candidate the moment they apply — there's no manual
          step to trigger it. It fetches the actual resume text from Drive (PDF, DOCX, or Google
          Docs) and scores it across 8 dimensions — Technical, Experience, Industry Fit, Culture
          Fit, Role Alignment, Trajectory, Leadership, Communication — producing an average
          score, strengths, red flags, an executive summary, and a recommendation (Strong Yes /
          Yes / Maybe / No). It only runs once per application; if the resume can't be fetched,
          it falls back to scoring from the candidate's profile fields instead of failing
          outright.</p>
        ),
      },
      {
        id: 'portfolio-review',
        question: 'How does the Portfolio review work for designer roles?',
        answer: (
          <>
            <p>For the Senior UX/Product Designer role, ResumeIQ adds a ninth dimension —{' '}
            <strong>Portfolio</strong>. Right after the normal 8-dimension score is saved, the
            portfolio links in the candidate's resume (Behance, Framer, Figma, their own site, and
            so on — including links hidden behind a word like "Portfolio") are opened in a
            browser and reviewed page by page against the JD and the hiring manager's 15 criteria
            — full ownership of a product, storytelling and process, field research, design
            system work, whether the site itself works, and so on. This takes a few minutes, so
            the overall score shown at first is <strong>provisional</strong> (marked "…" in the
            Port column) and updates when the review finishes.</p>
            <p className="mt-2">The result appears under <strong>View Highlights and Summary</strong>{' '}
            and on the candidate's page: a 0-10 portfolio score (included in the overall score),
            what was reviewed, strengths and concerns, and each criterion marked Evidenced /
            Partly / Not evidenced / Concern with a line of evidence. "Not evidenced" only means
            the portfolio doesn't show it — it is not held against the candidate. A missing
            portfolio link, or a dead or private one, is a concern and lowers the score.
            If a review fails on our side it never counts against the candidate; HR can press{' '}
            <strong>Re-run</strong> to retry, which also re-reads the resume in case a link was
            missed.</p>
          </>
        ),
      },
      {
        id: 'jd-gen',
        question: 'Where do generated job descriptions come from?',
        answer: (
          <>
            <p>Once a role is approved, the Hiring Master System can generate both a long-form JD (2-page PDF) and a
            social-sharable graphic version directly from the role's data, and store both on
            Drive with links surfaced on the role's detail page. A <strong>Regenerate JD</strong>{' '}
            button lets HR re-run generation (content edit, layout fix) while the role is still Approved and a JD exists — it always overwrites both the long-form and social JD. If the first generation fails there is no JD to regenerate: move the role out of Approved and back in to retry.</p>
            <p className="mt-2">Some roles have a long-form JD written entirely outside the
            system instead (a founder- or hiring-manager-authored PDF). For those, the role's
            long-form JD link points directly at that original document rather than a
            system-generated one, the Regenerate JD button doesn't appear (there's nothing here
            for it to regenerate), and ResumeIQ scores candidates against the real content of
            that externally-authored JD, not a short fallback. The social JD is still
            auto-generated from it as usual.</p>
          </>
        ),
      },
      {
        id: 'assignment-email',
        question: 'How do Assignment emails get sent?',
        answer: (
          <p>From a candidate's Assignment Round action, the Hiring Master System composes and sends the assignment
          email directly (from the shared HR inbox) — one action both creates the interview
          round record and sends the email, with the assignment link and any supporting docs
          included. If a send fails, the round stays in place and the action becomes a retry.</p>
        ),
      },
          {
        id: 'emails',
        question: 'What e-mails does HMS send?',
        answer: (
          <p>Assignment e-mails (from the shared HR inbox), the optional rejection e-mail, and
          Google Calendar invites for interview rounds. HMS does not send a daily summary of pending
          items. If the Sourcing module's digests are switched on, HR/Admin also get one daily
          sourcing note on weekdays when something needs doing, and the configured leadership
          addresses get a Monday summary.</p>
        ),
      },
    ],
  },
  {
    title: 'Sourcing execution & accountability',
    gated: 'sourcing',
    sections: [
      {
        id: 'sourcing-what',
        question: 'What is Sourcing execution, and where do I find it?',
        answer: (
          <p>Every open role gets a <strong>sourcing plan</strong>: the channels HR will use
          (LinkedIn, Naukri/IIMjobs, Agency, Internal Referral, Direct Outreach) and dated tasks
          for each. When something that was promised isn't done, HMS raises an <em>exception</em>.
          You'll find it in three places: the <strong>Sourcing</strong> card on a role's page
          (between Pipeline and Activity), the <strong>Sourcing</strong> box in My Tasks (HR/Admin
          and Super Admin), and the last section of the Dashboard, <strong>Sourcing execution</strong>.</p>
        ),
      },
      {
        id: 'sourcing-owner',
        question: 'Who owns a sourcing plan?',
        answer: (
          <p>HR/Admin as a whole — never an individual. A plan has no owner field: the card says
          "Owner: HR", every HR user sees the same Sourcing queue in My Tasks, and anyone in HR can
          complete, skip or resolve anything on any plan.</p>
        ),
      },
      {
        id: 'sourcing-plan',
        question: 'How do I activate and work a plan? (HR-tier)',
        answer: (
          <>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Open the role's Sourcing card (or My Tasks → Sourcing → Plans to activate) and click{' '}
              <strong>Activate plan</strong>. Tick the channels you'll use; for any that is already live,
              tick <strong>Already running before today</strong> and enter the posting date, so it
              isn't shown as overdue and the renewal reminder counts from that date. Leaving a
              suggested channel out needs a reason.</li>
              <li>Work the list in My Tasks → Sourcing: <strong>Mark done</strong> (a link or note is
              optional), <strong>Skip</strong> (with a reason) or <strong>Undo skip</strong>.</li>
              <li>On the role's card, <strong>Add channel</strong> / <strong>Bring back</strong> adds one
              mid-flight (its first task falls due in 1–2 working days), <strong>Stop using</strong>{' '}
              leaves one out (with a reason) and <strong>Edit strategy note</strong> changes the note.</li>
            </ol>
            <p className="mt-2">A role going On Hold pauses its plan; closing the role closes it and
            queues nothing else. Reopening a role returns its plan to a draft to activate again.</p>
          </>
        ),
      },
      {
        id: 'sourcing-exceptions',
        question: 'What is an exception, and how do I resolve one?',
        answer: (
          <>
            <p>An exception is something promised and not done: a plan not activated in time, a channel
            that isn't live, an overdue task or follow-up, too few qualified candidates (an open P0/P1
            role with fewer than 5 in the last 7 days on each of the last 5 working days), or a blocker
            past its deadline. "Qualified" means shortlisted by a person or scored above 60 by ResumeIQ.</p>
            <p className="mt-2">Resolve each one of three ways: <strong>I'll catch up</strong> (a reason and
            a date within 14 days — it comes back if still true), <strong>Change the plan</strong> (a
            reason; optionally stop using the channel) or <strong>I'm blocked</strong> (a reason, who must
            unblock it, and a deadline within 60 days).</p>
          </>
        ),
      },
      {
        id: 'sourcing-provisional',
        question: 'What does "Provisional" mean on a sourcing signal?',
        answer: (
          <p>A new threshold signal, such as "not enough qualified candidates", that is still being
          calibrated for its first 6 weeks. HR/Admin and Leadership see it greyed out on the dashboard
          and the role card, but it raises no tasks, sends no e-mail and can't be resolved yet.</p>
        ),
      },
      {
        id: 'sourcing-dates',
        question: 'How are due dates worked out?',
        answer: (
          <p>From the day the plan is activated, in working days — Monday to Friday, India time.
          Public holidays aren't modelled. A task is overdue only after its due day ends. Following
          tasks are created when the first one is completed: portal postings are renewed before they
          expire (every 30 days), agencies are followed up weekly, referrals reposted every 14 days,
          and weekly outbound contacts are logged (the first 4 weeks only record a baseline).</p>
        ),
      },
      {
        id: 'sourcing-attribution',
        question: 'Why does "Applications by source" say "Not tagged"?',
        answer: (
          <p>The table counts applicants by what they answer to an optional "How did you hear about
          this role?" question on the Job Application Form. Without that question every form
          applicant is recorded as LinkedIn, so applicants show as "Not tagged" and the table can't
          say where they came from. It's the applicant's own answer, so treat it as a claim.</p>
        ),
      },
      {
        id: 'sourcing-hm',
        question: 'What does a Hiring Manager see?',
        answer: (
          <p>A read-only "View only" card on their own roles: channels, tasks, dates and counts, but
          no strategy note, links, completion notes or provisional signals. A channel's excluded
          reason and an exception's resolution path and dates are still shown. A Hiring Manager of
          another role sees nothing.</p>
        ),
      },
    ],
  },
  {
    title: 'Access & permissions',
    sections: [
      {
        id: 'personas',
        question: 'What can each role/persona do?',
        answer: (
          <>
            <p className="mb-2">There are four personas — a fifth, Interviewer, was merged into
            Hiring Manager since it was already functionally identical everywhere (interview
            feedback rights are gated by who's actually listed on a round, not by persona).</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>HR/Admin</strong> — full visibility and control across roles, candidates,
              approvals, screening, and compensation data for every role.</li>
              <li><strong>Hiring Manager</strong> — views roles/candidates/applications company-wide
              with compensation fields hidden, <em>except</em> for the specific role(s) they're
              assigned to, where they see comp the same as HR. Submits interview feedback for
              rounds they're listed on, records Assignment outcomes, and can shortlist/hold/reject
              candidates from Applied and Screened (in My Tasks → Ready for review). Role approval is HR/Leadership/Super Admin only — a Hiring
              Manager can't approve even their own role. Their Dashboard is
              locked to their own role(s) — this can't be changed. A role can have more than one
              Hiring Manager: HR lists them all in the role's Hiring Manager field, separated by
              commas, and each one gets all of the above for that role. Each name is matched against the person's HMS user name — whole name, ignoring case — so "Amit" does not match "Amit Gosain"; saving the role warns about any name that matches no user.</li>
              <li><strong>Leadership</strong> — sees and can do everything HR/Admin can (their permissions are deliberately identical, and HR/Admin approve roles too). The differences are a narrower default in My Tasks → Ready for review (Founder-flagged candidates, plus any role they are the named Hiring Manager of) and changing the Sourcing module's settings.</li>
              <li><strong>Super Admin</strong> — everything Leadership has, plus User Management
              (adding/removing accounts). Held by exactly one person.</li>
            </ul>
          </>
        ),
      },
      {
        id: 'comp-visibility',
        question: 'Who can see compensation details, exactly?',
        answer: (
          <p>Compensation data of any kind — a role's CTC band, a candidate's current or expected
          CTC, agency fee estimates, offer figures — is visible to HR, Leadership, Super Admin
          always, and to a Hiring Manager only for the specific role(s) they're assigned to (and
          only for candidates/applications linked to that role). Nobody else ever sees it,
          anywhere in the system, including in a role's edit history if a compensation field was ever changed. On screen, the role's own CTC band is shown to HR-tier users only; a Hiring Manager sees the compensation of candidates on the role(s) they're assigned to.</p>
        ),
      },
    ],
  },
];

function FaqRow({ section, open, onToggle }: { section: Section; open: boolean; onToggle: () => void }) {
  return (
    <div className="border-b border-gray-100 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 py-3 text-left hover:text-dp-600 transition-colors"
      >
        <span className="text-sm font-medium text-gray-800">{section.question}</span>
        {open ? <ChevronUp className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />}
      </button>
      {open && (
        <div className="pb-4 text-sm text-gray-600 leading-relaxed">{section.answer}</div>
      )}
    </div>
  );
}

export default function Help() {
  const { user } = useAuth();
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  // The Sourcing group describes screens that exist only while the module is switched on, so it is shown only then.
  const { data: sourcingStatus } = useQuery<{ data: { enabled?: boolean } }>({
    queryKey: ['sourcing-status'], queryFn: () => sourcingApi.status(), staleTime: 5 * 60 * 1000, retry: false,
  });
  const sourcingOn = sourcingStatus?.data?.enabled === true;

  const toggle = (id: string) => setOpenIds(prev => {
    const s = new Set(prev);
    s.has(id) ? s.delete(id) : s.add(id);
    return s;
  });

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <div className="flex items-center gap-2">
          <HelpCircle className="w-5 h-5 text-dp-600" />
          <h1 className="text-xl font-semibold text-gray-900">Help &amp; FAQ</h1>
        </div>
        <p className="text-sm text-gray-500 mt-0.5">
          How the Hiring Master System's sections, workflows, and AI automation fit together — available to everyone,
          regardless of role.
        </p>
      </div>

      <div className="card p-5 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="text-sm font-medium text-gray-900">Full User Access Guide</div>
          <div className="text-xs text-gray-500 mt-0.5">
            A complete written reference covering every persona's permissions in detail, as{' '}
            {user ? <>you're logged in as <span className="font-medium text-gray-700">{PERSONAS[user.persona]}</span></> : 'a reference'}.
          </div>
        </div>
        <a
          href="/DigitalPaani_HMS_User_Access_Guide.pdf"
          target="_blank"
          rel="noreferrer"
          className="text-dp-600 hover:underline text-sm font-medium flex items-center gap-1.5 shrink-0"
        >
          Open guide <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>

      <div className="card p-5 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="text-sm font-medium text-gray-900">Hiring SOP</div>
          <div className="text-xs text-gray-500 mt-0.5">
            The standard operating procedure every HR/Admin, Hiring Manager, Leadership, and Super Admin follows —
            stage-by-stage ownership and the SLAs each persona is held to.
          </div>
        </div>
        <a
          href="/DigitalPaani_Hiring_SOP.pdf"
          target="_blank"
          rel="noreferrer"
          className="text-dp-600 hover:underline text-sm font-medium flex items-center gap-1.5 shrink-0"
        >
          Open SOP <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>

      {GROUPS.filter(group => group.gated !== 'sourcing' || sourcingOn).map(group => (
        <div key={group.title} className="card p-5">
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-1">{group.title}</h2>
          <div>
            {group.sections.map(section => (
              <FaqRow key={section.id} section={section} open={openIds.has(section.id)} onToggle={() => toggle(section.id)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
