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

// Grouped so the page reads as a table of contents, not one long list: what each
// section of the app is for, how the hiring workflow works, the AI automation,
// sourcing (shown only while the Sourcing module is switched on) and who can see
// and do what.
const GROUPS: Array<{ title: string; gated?: 'sourcing'; sections: Section[] }> = [
  {
    title: 'What each section of the Hiring Master System is for',
    sections: [
      {
        id: 'dashboard',
        question: 'What am I looking at on the Dashboard?',
        answer: (
          <>
            <p>A live snapshot of hiring health, from the top down. The top KPI cards (Roles Snapshot, Active Candidates, SLA Breaches) each carry four supporting sub-metrics — hover the{' '}
            <span className="italic">i</span> icon next to any card or section title throughout
            the app for an on-the-spot explanation of exactly what it measures.</p>
            <p className="mt-2">Below that, the <strong>Hiring Funnel Snapshot</strong> is an
            interactive chevron strip: click any stage to see which SLA breach types are open
            there and exactly who's overdue, filterable by owner (HR/Admin or Hiring Manager).
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
            HR/Admin and Hiring Manager breaches, and the drill-down shows who owns each), and a
            Hiring Manager sees only their own roles. Breaches on roles that aren't open (closed, cancelled or
            still a draft) aren't drawn; a note under the chart says how many there are.</p>
            <p className="mt-2">Further down: <strong>Aging roles</strong> (every role currently
            Approved, Live – Sourcing, or On Hold, with days-open shown for all of them — only an
            Approved or Live – Sourcing role that is far enough past its Close Target gets a
            yellow or red flag, sorted to the top; the days are set out in the role statuses
            question below. On Hold roles are listed for reference but never flagged. A red <strong>!</strong> next to
            a role's name means no candidate on that role has had any real movement — a stage or status change, feedback — in more than 3 days; new applications arriving and automatic scoring don't count toward this, so a role can't look active just because people are still applying
            to it while nobody's actually working the pipeline), the <strong>Hiring
            funnel</strong> chart
            (every stage, broken into Active/Rejected/Withdrawn/Hold for Future so a stage never
            silently disappears just because nobody's currently sitting there; hires are not
            counted in it, so the Joined bar stays at 0), Source Quality (pass rate is the
            share that reached Interview Round 1 or later and hire rate the share that reached Offer
            Accepted or later; a candidate created by the Job Application Form is recorded with the
            Source LinkedIn (someone already in HMS keeps the Source they have), so that bar holds
            most form applicants),
            Low Pipeline Roles (open roles with <strong>fewer than 3 shortlisted candidates and
            fewer than 8 active candidates</strong> in the pipeline — those two columns decide who
            is listed; the scored-above-60 columns beside them are shown for information only),
            and Operational
            Velocity (turnaround time per stage,
            Interview→Offer ratio, and the biggest drop-off stage shown both by raw count and by
            rejection rate, since those two can point at different stages). When the Sourcing module is switched on, the last section is <strong>Sourcing execution</strong> (the sourcing exceptions across roles); one role's whole plan is on the <strong>Sourcing</strong> page in the left menu — see the Sourcing group below.</p>
            <p className="mt-2">Filters at the top (Department, Location, Recruitment Mode,
            Priority, Role) scope every section together, and are remembered while the browser tab
            stays open. <strong>A Hiring Manager's dashboard is
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
            <p>Roles lists requisitions — one row per position, with priority, department, location, openings, age, Active Candidates, Active Shortlist and status (HR/Admin, Leadership and Super Admin also see a Salary Range column; the hiring manager is searchable rather than a column). The page opens showing only <strong>Approved</strong> and <strong>Live – Sourcing</strong> roles: use the Status filter to add Draft, Under Review, On Hold or Closed roles, or clear it to see all. You can also filter by Department, Location, Recruitment Mode and Priority, and search by title, id, department, location, Hiring Manager or status. Your filters are remembered while the browser tab stays open, here and on the Dashboard, Active Candidates, Archived Pipeline and My Tasks.</p>
            <p className="mt-2"><strong>Active Shortlist</strong> counts Active candidates currently at Interview Round 1, Interview Round 2, Assignment Round or Founders Round. The Dashboard's Low pipeline roles table counts a candidate as shortlisted at any stage after Applied and Screened, so the two numbers can differ for the same role.</p>
            <p className="mt-2">Click into a role for its full detail: requirements, compensation band (HR/Admin, Leadership and Super Admin only), approval status, links (Long-form JD, Social JD and Assignment Link), pipeline, and activity timeline. New roles normally arrive automatically from the Requisition Form, but the New Role / Request Role button lets you add one directly. HR can also discard a Draft that isn't going ahead — it is permanently deleted, and refused if the role already has applications.</p>
            <p className="mt-2">Once a role is marked <strong>Closed – Filled</strong> or{' '}
            <strong>Closed – Cancelled</strong>, a <strong>Download Closure Summary</strong>{' '}
            button appears on its detail page for HR/Admin, Leadership and Super Admin — a 1-page PDF retrospective covering every
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
            <p>Active Candidates lists applications across every role — except Rejected and Withdrawn ones, which live in Archived Pipeline (they never show here, even if you pick them in the Status filter) — the 100 highest-scoring applications first (highest ResumeIQ score at the top). There is no next page, so use the search box (name, email or role) and the filters (Stage, Status, Department, Location, Recruitment Mode, Priority, Role, Gender and SLA breached only) to reach the others; they look beyond the 100 shown. In-budget only just narrows the 100 already on screen. Fit is the ResumeIQ average out of 100 — the same score as Average Score in Ready for review, ten times larger (a Fit of 74 is an Average Score of 7.4). Company / Industry is a merged column ("company /
            industry", both from the candidate's own profile); Application Date shows how many
            days ago the candidate applied. The Last Updated column shows a one-line subtext of
            what actually happened most recently (a stage change, a score, an email sent) — not
            just when. Click the <strong>Fit</strong>, <strong>Application Date</strong>, or{' '}
            <strong>Last Updated</strong> column headers to sort by that column — click again to
            flip direction (starts descending); sorting only reorders whatever rows are currently
            visible after your filters. HR/Admin, Leadership and Super Admin also see <strong>Add candidate</strong> (see the question below) and can tick rows to use <strong>Change Stage</strong> or <strong>Change Status</strong> on several candidates at once (rejecting or withdrawing asks for reasons, and rejecting can send the optional e-mail).</p>
            <p className="mt-2">An amber <strong>Unmatched Candidates</strong> banner can
            appear above the table. It lists every candidate with no application to any role,
            either because a resume was added directly (or an old application was removed), or
            because they applied through the Job Application Form and the role they picked did
            not match exactly one role that isn't closed. A match means the same title, ignoring
            capital letters, extra spaces and the kind of dash — a misspelt, renamed or duplicated
            title stays unmatched. If a role with exactly that title exists now, the row offers a
            quick link to it. Otherwise HR/Admin, Leadership and Super Admin can use{' '}
            <strong>Link to role</strong> (it lists only Live – Sourcing roles the candidate hasn't
            already applied to) or delete the candidate — deleting is permanent. The banner is
            hidden while a Role filter is set.</p>
            <p className="mt-2">Every candidate also carries a best-effort <strong>Gender</strong>{' '}
            tag (M/F), auto-computed from their name — an unrecognized or genuinely
            ambiguous name is left blank rather than guessed, and it can't be edited from the screens today. Filterable alongside every other master filter,
            here and on Archived Pipeline and My Tasks' Ready for Review.</p>
          </>
        ),
      },
      {
        id: 'candidate-page',
        question: 'What is on a candidate\'s page?',
        answer: (
          <p>The top shows contact details, HR tags and a pipeline progress bar for each application. On the left are <strong>Identity</strong> (including Source, and the agency when the source is Agency), <strong>Current Role</strong>, <strong>Compensation</strong> (the CTC fields are hidden from a Hiring Manager except on their own roles) and <strong>Resume &amp; Tags</strong>; each has a pencil to edit it, but only HR/Admin, Leadership and Super Admin can save changes — for anyone else the save is refused. On the right, <strong>Applications</strong> lists each role the candidate applied for with its stage, status, SLA tag, Founder star and ResumeIQ score; HR/Admin, Leadership and Super Admin also get the Stage and Status buttons and Add Application. Each application opens expanded and shows its interview rounds (with Schedule round, Send Assignment and Submit feedback), reference checks, the ResumeIQ result, the candidate's own answers from the application form and HR notes. The Activity timeline at the bottom logs every change.</p>
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
        id: 'add-candidate',
        question: 'How do I add a candidate myself, or put an existing candidate on another role?',
        answer: (
          <>
            <p>HR/Admin, Leadership and Super Admin can click <strong>Add candidate</strong> at the top of Active Candidates. Everything on the form is required except LinkedIn URL, designation and Source: name, email, phone, role, current company, industry, current location, preferred location, years of experience, languages, current and expected CTC, notice period and a Google Drive link to the resume. If the Source is Agency, you must also choose the agency. An email that is already in HMS is refused, and the message names the existing candidate. The new application starts at Applied and Screened and is scored by ResumeIQ straight away.</p>
            <p className="mt-2">To put someone who already exists on another role, open their page and click <strong>Add Application</strong>; <strong>Link to role</strong> (Unmatched Candidates) and <strong>Reactivate</strong> (Archived Pipeline) work the same way. These screens, and the role list on Add candidate, offer only <strong>Live – Sourcing</strong> roles (and, for an existing candidate, only roles they haven't applied to). A role becomes Live – Sourcing only when HR/Admin, Leadership or Super Admin set that status on the role's page, so an Approved role isn't offered until then.</p>
          </>
        ),
      },
      {
        id: 'screening-notes',
        question: 'Why don\'t I see Screening & Risk Notes on every application? (HR/Admin, Leadership and Super Admin)',
        answer: (
          <p>The "Screening & Risk Notes" panel on an application only shows automatically if it
          already has notes on it. If it's empty, click <strong>+ Add HR Screening Notes</strong>{' '}
          to reveal the fields and start one — this keeps the page from showing an empty panel on
          every application that's never needed one. Hiring Managers can't open this panel, but the
          Recruiter Summary text is shown to them on the application, so don't put anything private in that one box.</p>
        ),
      },
      {
        id: 'reference-checks',
        question: 'Where do I record a reference check?',
        answer: (
          <p>On a candidate's page, add a reference check with the reference's name, phone number, and relationship to the candidate, plus the feedback they gave and optional call notes. HR/Admin, Leadership and Super Admin add one while the application is at the Reference Check stage, and at least one is needed before it can move on. Each one is logged individually — a candidate can have more than one reference check on record, and each stays attached to the specific application it was taken for.</p>
        ),
      },
      {
        id: 'stage-status-buttons',
        question: 'Where are the Stage and Status buttons on a candidate\'s page? (HR/Admin, Leadership and Super Admin)',
        answer: (
          <p>If a candidate has exactly one application, Stage/Status buttons sit at the top of
          the page next to their name. If they have two or more applications, there's no single
          "the" application to act on from the top, so the buttons move down to sit on each
          application's own row instead. These buttons are for HR/Admin, Leadership and Super Admin only — a Hiring Manager shortlists a candidate from Applied and Screened in My Tasks → Ready for review instead. The Status button offers Active, Rejected, Withdrawn and Hold for Future; Joined is set by moving the stage to Joined.</p>
        ),
      },
      {
        id: 'founder-review',
        question: 'What is the Founder star on an application, and who sets it?',
        answer: (
          <p>Use it to send a candidate to the founders for a look. HR/Admin, Leadership and Super Admin can flag an application: open the candidate's page, click the <strong>Founder</strong> star beside the role, add an optional note and press <strong>Confirm</strong>. The application then shows a purple Founder tag (also in Active Candidates), appears in Leadership's My Tasks under Ready for review, and creates an open Founder Review item for Leadership. Click the star again to clear the flag; clearing closes that item. Flagging does not change the stage or status. Flagged candidates at later stages stay in Ready for review for comparison, without shortlist buttons. Hiring Managers can see that a candidate is flagged but can't set or clear the flag.</p>
        ),
      },
      {
        id: 'talent-pool',
        question: 'What is Archived Pipeline for?',
        answer: (
          <>
            <p>A separate holding area for candidates who are either <strong>on hold for future
            roles</strong> (good candidates, wrong timing) or <strong>archived</strong> (rejected
            or withdrawn). Use the Hold for Future / Archived switch at the top to move between the two. Rejected and Withdrawn applications are kept out of the main Active Candidates view (Hold for Future ones also stay visible there) so they don't clutter active hiring, but stay searchable here and re-linkable to a new role at any time by HR.</p>
            <p className="mt-2">It's a table, not a card grid — one row per candidate <em>and</em>{' '}
            application, so a candidate with more than one past application shows their full
            history here, not just the one that put them in this pool. The count at the top counts candidates, not rows. Each row has its own{' '}
            <strong>Reactivate</strong> button (HR/Admin, Leadership and Super Admin) to put that candidate on another role: it offers Live – Sourcing roles they haven't applied to and starts a new application at Applied and Screened, scored by ResumeIQ. The archived application stays as it was. Search and Tag work well; the Skills and Industry boxes match profile data that nothing fills today, so they will normally find nobody.</p>
          </>
        ),
      },
      {
        id: 'scorecard-queue',
        question: 'What is My Tasks, and what is the Scorecard Summary table?',
        answer: (
          <>
            <p><strong>My Tasks</strong> is your own worklist, shown as a row of boxes with counts: <strong>Ready for review</strong> (candidates awaiting a shortlist decision — HR/Admin and Super Admin see everyone, a Hiring Manager sees only their own role's candidates, and Leadership sees only candidates flagged for Founder Review, since day-to-day shortlisting is HR/HM's job rather than a leadership task), <strong>Feedback Due</strong> (overdue interview and assignment feedback — HR/Admin and Super Admin see everyone's, a Hiring Manager only the rounds they're listed as an interviewer on, or the rounds on their own roles that list no interviewer), and a third box that differs by persona: HR/Admin and Super Admin see <strong>Other Pending Actions</strong> (every other open item company-wide, whoever it is assigned to — including items waiting on Hiring Managers and Founder Review items), plus a separate <strong>Leadership Alerts</strong> panel — role-aging, compensation-change and Feedback-Overdue notices that nobody individually owns, kept visible but not counted toward the actionable badge; a Hiring Manager sees only the Other Pending Actions assigned to them; Leadership sees Leadership Alerts directly. HR/Admin and Super Admin also get a fourth box, <strong>Sourcing</strong>, when the Sourcing module is switched on.</p>
            <p className="mt-1.5">Feedback Due, Other Pending Actions and Leadership Alerts are all filled from one shared list of the 100 highest-priority, oldest open items, so if they add up to about 100 there may be more behind them; Ready for review is separate and shows up to 500 candidates.</p>
            <p className="mt-1.5">A Leadership user who is also the named Hiring Manager of a role (a name on the role's Hiring Manager field) keeps all of that and additionally gets that role's Hiring Manager work (with a separate list of 100 for it): its candidates join Ready for review, its overdue shortlist decisions land in Other Pending Actions, and the interview feedback they personally owe on that role (rounds where they're the listed interviewer, or that have no interviewer assigned) lands in Feedback Due — with a line at the top naming the role(s). Only that role — it doesn't make them a Hiring Manager anywhere else.</p>
            <p className="mt-1.5"><strong>Scorecard Summary</strong> is the table inside Ready for review — not a separate page (a role's Scorecard Summary button opens it filtered to that role). It lists scored candidates side by side with all 8 dimension scores (plus Portfolio for designer and Head of Marketing roles) and the verdict, filterable and searchable. It shows Active candidates by default — use the Status filter to look at others; an Applied and Screened candidate with no ResumeIQ score yet is still listed so it can be decided. Only candidates at Applied and Screened have checkboxes and Shortlist / Hold for Future / Reject buttons on the row, and you can tick several rows to do the same in bulk — later-stage rows are there for comparison. <strong>In-budget only</strong> hides candidates whose expected CTC is more than 15% above the top of the role's band, and Average Score and Application Age can be sorted. Instead of a chevron, a centered <strong>View Highlights and Summary</strong> button under the score columns expands a candidate's strengths, red flags, and executive summary. HR/Admin, Leadership and Super Admin also see a banner when some candidates have no ResumeIQ score (the automatic scoring didn't complete) with a <strong>Retry scoring</strong> button.</p>
            <p className="mt-1.5">For roles that get a <strong>portfolio review</strong> (today the
            Senior UX/Product Designer role and the Head of Marketing &amp; Creative Direction role), Ready for review has a <strong>Portfolio ≥ 7.5</strong>{' '}
            button beside the search box: it narrows the list to candidates whose portfolio
            review scored 7.5 or higher. Portfolio scores are whole numbers (0–10), so that means 8 or
            more, and candidates with no portfolio score — including every other role's, and any
            Head of Marketing candidate whose work could not be reviewed — are hidden
            while it is on. The button only appears when the Role filter is clear or includes such a
            role.</p>
          </>
        ),
      },
      {
        id: 'pending-glossary',
        question: 'What do the items in Other Pending Actions and Leadership Alerts mean?',
        answer: (
          <>
            <p><strong>Resume Shortlist Pending</strong> — a candidate has waited at Applied and Screened beyond the window (the Hiring Manager's item). <strong>HM shortlist review</strong> — a candidate was shortlisted into Interview Round 1; it is a heads-up for the role's Hiring Manager, nothing in the screens completes it, and it clears by itself when the candidate's stage or status next changes. <strong>Interview 1, Interview 2 or Founders Round Not Scheduled</strong> and <strong>Assignment Not Sent</strong> — HR hasn't booked the round with a date or sent the assignment. <strong>Assignment deadline breached</strong> — no submission recorded within 60 hours of sending. <strong>Idle Candidate</strong> — no movement for 48 hours at Reference Check, Pre-Joining Documents, Offer Discussion or Offer Released. <strong>Joining risk — no contact</strong> — a candidate at Offer Accepted with no HR contact on record. <strong>Founder Review</strong> — an application flagged for Leadership. Overdue feedback appears under Feedback Due instead.</p>
            <p className="mt-2">Leadership Alerts are notices of three kinds: <strong>Role aging alert</strong> (a role has reached red), <strong>Compensation change flag</strong> (a role's CTC band was edited) and <strong>Feedback Overdue — Leadership Escalation</strong>. For HR/Admin and Super Admin, and for a Leadership user who is also a role's Hiring Manager, they appear in their own Leadership Alerts panel and are not counted in Other Pending Actions. A Leadership user who is nobody's Hiring Manager has Leadership Alerts as the whole third box, and its count includes them.</p>
          </>
        ),
      },
      {
        id: 'agencies',
        question: 'What is the Agencies page? (HR/Admin, Leadership and Super Admin)',
        answer: (
          <p>The Agency Repository holds each recruitment agency's contact, contract status, commission tiers, replacement guarantee, billing and payment terms and agreement link, so agency terms are in one place. The list shows each agency's hires; open an agency to see two counts, <em>submitted</em> (applications that carry the agency on the application itself and are not Rejected or Withdrawn — an older field that no current screen sets, so it may read 0 for candidates added recently) and <em>hired</em> (candidates the agency sourced who reached Offer Accepted or Joined, counted once per candidate — the same number as Hires in the list). A candidate counts as sourced by an agency when their own Source field is set to Agency and the agency is chosen on their profile. The Add agency button doesn't open anything yet, so agencies can't be added from this screen today.</p>
        ),
      },
      {
        id: 'comp-benchmark',
        question: 'What is the "Run benchmark" button on a role\'s page? (HR/Admin, Leadership and Super Admin)',
        answer: (
          <p>Compensation benchmarking for that specific role, based on its own requirements
          (experience level, must-have skills, etc.) — not tied to any one candidate. It checks
          this system's own internal comp-benchmark records first, and only falls back to general
          market knowledge when there's no internal data for a role like this one. Like the
          role's CTC band, it is shown only to HR/Admin, Leadership and Super Admin.</p>
        ),
      },
      {
        id: 'user-management',
        question: 'What is User Management? (Super Admin only)',
        answer: (
          <p>The only place accounts actually get added, edited, or deactivated — "removing access" deactivates an account rather than deleting it, since a user's past actions (interview feedback, activity log entries) stay attached to their record. Every account except the Super Admin's own has Edit and Deactivate / Reactivate buttons (the Super Admin's own row shows only a dash, so its role and access can't be changed here); the roles on offer are HR/Admin, Hiring Manager and Leadership. A person can sign in only with a company Google account that has been added here and is active. A user's Name must match what HR writes in a role's Hiring Manager field (whole name, ignoring case), or that person won't get that role's Hiring Manager view. Held by exactly one person at DigitalPaani.</p>
        ),
      },
    ],
  },
  {
    title: 'How the hiring workflow actually works',
    sections: [
      {
        id: 'intake',
        question: 'How do roles and candidates get into HMS?',
        answer: (
          <>
            <p><strong>Roles:</strong> a Requisition Form submission creates a Draft role automatically, and the same submission sent twice never creates a second role. HR/Admin and Super Admin can also create a role with New role; Hiring Managers and Leadership use Request role (see the next question).</p>
            <p className="mt-2"><strong>Candidates:</strong> each Job Application Form submission creates the candidate — or reuses the existing one, found by email — and adds an application at Applied and Screened to the role they chose. ResumeIQ scores it before anyone opens it. A second submission for the same role is skipped. A submission for a different role adds another application to the same candidate and fills in profile details that were still empty. If the role they chose doesn't match exactly one role that isn't closed, the candidate waits under Unmatched Candidates on Active Candidates. HR can also add a candidate by hand.</p>
          </>
        ),
      },
      {
        id: 'request-role',
        question: 'How does a Hiring Manager request a role?',
        answer: (
          <p>On Roles, Hiring Managers and Leadership see <strong>Request role</strong> (HR/Admin and Super Admin see <strong>New role</strong>). The form asks for the same details as a new role, except that a Hiring Manager doesn't enter the CTC band. The request is saved as a Draft, and a Hiring Manager's request is marked as requested on the role's timeline. HMS doesn't send HR a message about it, so let them know. HR/Admin, Leadership or Super Admin then open the role and click <strong>Approve Role</strong>, or <strong>Discard role</strong> (Drafts only; it is permanent, and refused once the role has applications). A Hiring Manager can't approve a role — not even their own — and can't change a role's status or details afterwards.</p>
        ),
      },
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
            <p className="mt-1.5">These are not automatic steps. HR/Admin, Leadership or Super Admin set each status by hand — <strong>Approve Role</strong> on a Draft or Under Review role, or <strong>Change status</strong>, which accepts any status in any order. Nothing moves a role from Approved to Live – Sourcing for you, so set it when sourcing starts: Add candidate, Add Application, Link to role and Reactivate offer only Live – Sourcing roles, whereas candidates applying through the Job Application Form are linked to any role that isn't closed. Approving a role also starts JD generation and, when the Sourcing module is switched on, creates a draft sourcing plan; On Hold pauses that plan and closing the role closes it. Closed roles no longer appear in the Role filters.</p>
            <p className="mt-1.5"><strong>Close Target</strong> is a separate date HR sets for
            when a role should realistically close. A role's yellow/red aging alert is driven by how far past this date it is, not by how long it's simply been open: it turns yellow once it is a set number of days past its Close Target and red after a longer wait — P0 after 10 and 23 days, P1 after 15 and 45, P2 after 30 and 68, P3 after 30 and 90. Until then the role just shows how long it has been open, with no colour, and pushing the target out clears an existing alert. A role with no Close Target set uses the same numbers counted from its Open Date, so nothing loses visibility for lacking one. Only Approved and Live – Sourcing roles are ever coloured — On Hold roles never are — and Leadership's Role aging alert is raised at red only.</p>
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
              <li><strong>Stage</strong> — where the candidate sits in the pipeline: Applied and
              Screened, Interview Round 1, Interview Round 2, Assignment Round, Founders Round,
              Reference Check, Pre-Joining Documents, Offer Discussion, Offer Released, Offer Accepted
              and Joined. Every applicant is
              scored by ResumeIQ automatically at Applied and Screened (the name reflects that
              scoring has already happened by the time a candidate is at this stage) and can be
              shortlisted straight into Interview Round 1 from there — Resume Review and
              Shortlisted no longer exist as separate stages. HR/Admin, Leadership and Super Admin
              can set any stage.</li>
              <li><strong>Status</strong> — whether they're still active in that pipeline: Active,
              Rejected, Withdrawn, Hold for Future, or Joined. Moving the stage to Joined also sets the status to Joined.</li>
              <li><strong>Recruiter Screening Status</strong> — a label shown on the application. It
              starts as New and nothing in the screens changes it today, so you can ignore it and use Stage and Status.</li>
            </ul>
            <p className="mt-1.5">Rejecting or withdrawing a candidate always requires selecting
            a reason first — this is deliberate, not a bug, so hiring data stays auditable. When
            rejecting, tick <strong>one or more</strong> reasons (a candidate often fails on
            several things at once); withdrawals take a single reason.</p>
          </>
        ),
      },
      {
        id: 'stage-moves',
        question: 'Why can\'t I move a candidate to another stage, and what do the later stages mean?',
        answer: (
          <p>HR/Admin, Leadership and Super Admin can set any stage with the Stage button (or Change Stage for several candidates on Active Candidates); everyone else can only shortlist from Applied and Screened to Interview Round 1. Three checks can stop a move. Every interview or assignment round already created for the application must have its feedback submitted ("Feedback is still pending for …"). A candidate leaving Reference Check needs at least one reference check on file. And moving to Interview Round 1 when the expected CTC is 15% or more above the top of the band needs an over-budget reason. After the interviews the stages are moved by hand: Reference Check, Pre-Joining Documents, Offer Discussion, Offer Released (records the offer date), Offer Accepted (records the date used for Time to Fill) and Joined (also sets the status to Joined). HMS doesn't generate offer letters or a pre-joining document checklist; those happen outside HMS today.</p>
        ),
      },
      {
        id: 'interview-scheduling',
        question: 'What happens when I schedule an interview round?',
        answer: (
          <p>HR/Admin, Leadership and Super Admin schedule a round from the candidate's page: open the application and click Schedule round, which appears while it is at Interview Round 1, Interview Round 2 or Founders Round. The round name, at least one interviewer email and a date and time (India time) are required; meeting mode (Video, In-person or Phone) and length are optional. Saving sends a real Google Calendar invite from your own calendar to the interviewers, the candidate (only if they have an email on file) and hr@digitalpaani.com — you'll see a confirmation toast once it goes out. If the invite fails to send for any reason, the round itself is still created (scheduling isn't blocked on it) and a warning shows on the round instead. Assignment rounds don't go through Calendar at all — see the Assignment questions below for how those work instead.</p>
        ),
      },
      {
        id: 'interview-feedback',
        question: 'How do I submit interview feedback, and who can?',
        answer: (
          <p>Open the candidate's page (My Tasks → Feedback Due → Submit feedback takes you there), find the round under Interview rounds and click <strong>Submit feedback</strong>. Pick the areas you assessed and score each from 1 to 5, set your confidence and an overall assessment, choose a recommendation (Proceed, Proceed with Concerns, Hold or Reject) and optionally add strengths, concerns, open questions and notes. HR/Admin, Leadership and Super Admin can submit for any round. Other users can submit only for rounds where their email is listed as an interviewer; a round with no interviewer listed is open to anyone. Submitting clears the Feedback Due item, and a clearly positive result moves the candidate on (see the automatic move question below). After it is submitted the round shows the feedback read-only.</p>
        ),
      },
      {
        id: 'assignment-round',
        question: 'How does an Assignment round work, from sending to outcome?',
        answer: (
          <p>At the Assignment Round stage, HR/Admin, Leadership or Super Admin open the candidate's application and click <strong>Send Assignment</strong> (see How do Assignment emails get sent? for what goes into the email). The 60-hour submission deadline starts when the email goes out. HMS can't see the candidate's reply, so when the work comes back HR clicks <strong>Record submission</strong> and pastes the link; until then, Assignment deadline breached is raised once 60 hours have passed. Then comes <strong>Record outcome</strong>, which anyone viewing the application can do (normally the Hiring Manager or HR): score five areas out of 5 — Technical Accuracy (40%), Problem Solving (25%), Clarity &amp; Structure (15%), Practical Thinking (10%) and Completeness (10%) — and choose Approved for Next Round, Assignment Resent or Rejected. Approved for Next Round with a weighted score above 2.5 moves the candidate on automatically. An outcome of Rejected does not reject the candidate; HR still changes the status.</p>
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
          bulk rejection. Sending is optional; the box is off by default and leaving it unchecked just rejects the candidate
          with no email. If the candidate has no email address on file, or the send fails, they are still rejected and a warning shows on their application; a sent email shows as "Rejection email sent".</p>
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
            full list, but broadly: <strong>Idle Candidate</strong> (48h+ at Reference Check, Pre-Joining Documents, Offer Discussion or Offer Released), <strong>Resume Shortlist Pending</strong> (Applied and Screened specifically),
            <strong> Interview/Founders "Not Scheduled"</strong> (a round hasn't been booked with a date),
            <strong> Assignment "Not Sent"</strong> (the assignment hasn't gone out), or{' '}
            <strong>"Feedback Due"</strong> (feedback hasn't been submitted since a round happened), <strong>Assignment deadline breached</strong> (no submission recorded within 60h of the assignment being sent), and <strong>Joining risk — no contact</strong> (a candidate at Offer Accepted with no HR contact date on record — HMS has no screen for logging that contact today, so expect this at the next check after every accepted offer; it clears once the candidate is no longer Active, for example after they move to Joined). A breached application shows a red SLA tag and a
            pending action is raised for whoever owns that step. These checks run when anyone opens the Dashboard (at most once every few minutes) — they are not on a timer and there's no separate button to trigger them, so My Tasks and the SLA counts catch up once the Dashboard has been opened. Most breaches resolve themselves the moment their underlying condition is actually addressed (a stage or status change, feedback submitted, a round booked with a date); Assignment deadline breached clears at the first check after HR records the submission.</p>
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
          <p>A candidate whose expected CTC is above the top of the role's stated compensation
          band gets a red Over Budget badge. If it is 15% or more above the top of the band, the Hiring Master System
          requires an explicit, on-record reason before they can be
          shortlisted into Interview Round 1 — from Ready for review, the Stage button or a bulk stage change, whoever is doing it (a Hiring Manager is asked too, even though the band itself is hidden from them). The choices are Exceptional / rare skillset, Business-critical urgency to fill role, Candidate open to negotiate at offer stage, Leadership-approved exception, or Other — so an over-budget hire is always a documented
          decision, not an accident. If the band or the expected CTC isn't recorded, no reason is asked for. The In-budget only filter hides only candidates more than 15% above the top of the band.</p>
        ),
      },
      {
        id: 'auto-advance',
        question: 'Can a candidate move to the next stage automatically?',
        answer: (
          <p>Yes. When feedback for Interview Round 1, Interview Round 2 or Founders Round is
          Proceed or Proceed with Concerns, with an average score above 2.5 out of 5, the candidate
          moves to the next stage straight away, with no separate manual step. For an Assignment
          Round the outcome must be Approved for Next Round with a weighted score above 2.5 out of 5.
          This only happens while the application is still Active and at one of those four stages,
          and it moves one step along the pipeline (Interview Round 1 → Interview Round 2 → Assignment
          Round → Founders Round → Reference Check). A Hold, Reject, Assignment Resent or Rejected
          result, or a low score, never moves anyone. It doesn't reject or hold the candidate either:
          HR still changes the status separately.</p>
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
          <>
            <p>ResumeIQ automatically scores a candidate the moment they apply — there's no manual
            step to trigger it. It reads the resume from Drive (PDF, Word .docx or Google Docs, up to
            20 MB, and the first 40 pages of a PDF), the profile fields (such as experience, location,
            notice period and CTC) and the answers to the application form's role-specific questions,
            and compares them with the role's JD (the role's short requirement fields when no JD has been generated yet).
            It scores 8 dimensions — Technical, Experience, Industry Fit, Culture
            Fit, Role Alignment, Trajectory, Leadership, Communication — producing an average
            score, strengths, red flags, an executive summary, and a recommendation (Strong Yes /
            Yes / Maybe / No). It only runs once per application. A resume that can't be read — an old .doc
            file, an image, a password-protected file or a file over 20 MB — is not a failure: the
            candidate is scored from the profile fields and the application answers alone, and the candidate's page shows a "No resume read" tag.</p>
            <p className="mt-2">If the scoring itself didn't finish, the candidate shows as not scored and HR/Admin, Leadership and Super Admin can use Retry scoring in Ready for review. If a candidate shows 0 in every dimension together with the red flag "AI scoring returned invalid output — retry needed", the AI's reply couldn't be read and the numbers mean nothing; Retry scoring doesn't list these, so tell whoever maintains HMS.</p>
          </>
        ),
      },
      {
        id: 'ai-boundaries',
        question: 'What does the AI see about a candidate, and who makes the decision?',
        answer: (
          <p>HMS uses AI to score resumes (ResumeIQ), review portfolios and work samples, write job descriptions and suggest sourcing steps. People make every decision: nothing in HMS moves, rejects or hires a candidate because of an AI score. A score is a starting point, though it does feed some timing rules — a ResumeIQ fit of 75 or more gives a tighter 24-hour window, and the portfolio score is part of the average. ResumeIQ reads the resume, the profile fields (including the candidate's name) and the application answers. The designer portfolio review is also given the candidate's name, current designation and years of experience. The Head of Marketing work-sample review gets the name only as a placeholder, not the designation or years of experience, and it tries to remove personal details such as age or family status from what it reads, but it can't guarantee that. The gender tag shown on candidate lists is never given to any AI review, and the sourcing next steps are written from counts only, with no candidate names or contact details. Check the evidence on the candidate's page before relying on a score.</p>
        ),
      },
      {
        id: 'portfolio-review',
        question: 'How does the Portfolio review work (designer and Head of Marketing roles)?',
        answer: (
          <>
            <p>Two roles — the Senior UX/Product Designer and the Head of Marketing &amp; Creative
            Direction — get a ninth ResumeIQ dimension, <strong>Portfolio</strong>. When a review
            has to open links, it runs in the background right after the
            normal 8-dimension score is saved and takes a few
            minutes, so until it finishes the overall score shown is <strong>provisional</strong> (marked "…"
            in the Portfolio column) and updates when the review finishes. If there is nothing to
            open (no link in the resume, or a blank or text-only answer) the result is settled at once.</p>
            <p className="mt-2"><strong>Designer roles.</strong> The portfolio links in the
            candidate's resume (Behance, Framer, Figma, their own site, and so on — including links
            hidden behind a word like "Portfolio") are opened in a browser and reviewed page by page
            against the JD and the hiring manager's 15 criteria — full ownership of a product,
            storytelling and process, field research, design system work, whether the site itself
            works, and so on. A missing portfolio link, or a dead or private one, is a concern and
            lowers the score. This applies only if the resume could be read; if it could not, the
            Portfolio dimension is left out. A portfolio that is only a PDF or slide-deck link is not
            opened automatically: it gets a low score of 3 and a flag asking you to review it by hand.
            A site that blocks automated access is not held against the candidate and is not scored.</p>
            <p className="mt-2"><strong>Head of Marketing.</strong> The review looks at the links in
            the candidate's answer to "Links to public resources/portfolio to highlight your past
            work?" on the application form — Google Drive documents, decks and PDFs, Word and
            PowerPoint files, images, their own site, Behance, Canva or Notion pages — and reads them
            against the role's must-haves and nice-to-haves. It weighs how much of the work can be
            attributed to the candidate, how well it is measured and how finished it is, as well as
            what it shows. YouTube, Vimeo and Loom links and Instagram links are never opened as work:
            only a video's title, description and thumbnails (the video is not watched), or a post's
            public caption, are read, and only as background beside real work — if those are the only
            links, nothing is scored. LinkedIn is never opened. <strong>A missing or "N/A" answer, a text-only answer,
            a private or dead link, a link a machine cannot open, or work the review could not
            assess (unreadable, or in a language it cannot judge) is not scored</strong> — the
            Portfolio dimension is simply left out, the overall score stays the average of the other 8
            dimensions, and the candidate's page says why. A link that cannot be opened is never held
            against the candidate. Inside the review (under View Highlights and Summary, or on the
            candidate's page) the score is shown with how many of the links it is based on and a
            confidence level, it is capped when the evidence is thin, and anything that was not reviewed
            is listed once under "Not reviewed — open these by hand" so you can look at it yourself.
            The Portfolio column shows the score on its own; hover a dash to see why there is none.</p>
            <p className="mt-2">The result appears under <strong>View Highlights and Summary</strong>{' '}
            and on the candidate's page: a 0-10 portfolio score (included in the overall score),
            what was reviewed, strengths and concerns, and each criterion marked Evidenced /
            Partly / Not evidenced / Concern with a line of evidence. "Not evidenced" is not an
            accusation — it means the work doesn't show it — but it is not neutral either: on what
            the work should show it counts for less than "Partly" and <strong>lowers the score</strong>.
            For Head of Marketing there are two exceptions. The few criteria a portfolio can rarely prove
            (a team led, working within limits, a mission, a pitch, time in a start-up — the 8 ResumeIQ dimensions
            already cover them) are left out of the maths unless the work itself clearly shows them, so missing
            or partial evidence of those never lowers the score. And "Personal role shown" — whether the
            candidate's own part in the work is evidenced — only counts when it is clear either way: a named
            credit or an explicit first-person role raises the score, a different person credited (or a claim the
            work contradicts) lowers it, and "Partly" or "Not evidenced" there (a plausible owner, or a brand page
            with no credit) leaves it out of the maths altogether. A criterion the reviewer could not assess at all
            is left out too. If a review fails on
            our side it never counts against the candidate; HR can press <strong>Re-run</strong> to
            retry, which re-reads the resume (designer roles, in case a link was missed) or the
            application answer (Head of Marketing). For Head of Marketing, a Re-run reviews the answer
            again and replaces the score. If the Re-run ends with nothing that can be scored this time (for example the
            links are now private, or the answer is now text only), the earlier score stays in the average and the Portfolio column shows it with a small
            red dot.</p>
          </>
        ),
      },
      {
        id: 'jd-gen',
        question: 'Where do generated job descriptions come from?',
        answer: (
          <>
            <p>When a role is approved, the Hiring Master System generates both a long-form JD PDF and a
            social-sharable graphic version directly from the role's data, and stores both on
            Drive with links under the role's Links &amp; Assets. Approving takes up to about half a minute while it does this. While a JD exists and the role is still Approved, a <strong>Regenerate JD</strong>{' '}
            button lets HR/Admin, Leadership and Super Admin re-run generation (content edit, layout fix) — it always overwrites both the long-form and social JD. If generation fails, the role stays Approved with no JD links (they keep showing "Generating JD…") and there is no Regenerate JD button. A failure message appears when you approve with Change status, but not when you use the Approve Role button, so check the links after approving. To retry, move the role out of Approved and back in — that records you as the approver and sets the Approval Date and Open Date to today (restarting the role's age), and moving it through On Hold or Closed also pauses or closes its sourcing plan.</p>
            <p className="mt-2">Some roles have a long-form JD written entirely outside the
            system (a founder- or hiring-manager-authored PDF). For those, the role's
            long-form JD link points straight at that original document, ResumeIQ scores candidates
            against its real content, and the Regenerate JD button doesn't appear. Approving such a
            role doesn't generate anything, and neither JD can be refreshed from the role page: the
            social JD was prepared separately, so ask whoever maintains HMS if it needs to change.</p>
          </>
        ),
      },
      {
        id: 'assignment-email',
        question: 'How do Assignment emails get sent?',
        answer: (
          <p>HR/Admin, Leadership and Super Admin send an assignment from the candidate's page: when the application is at Assignment Round, click <strong>Send Assignment</strong>, fill in the mail body and the Assignment Link (filled in from the role's Assignment Link when it has one), and optionally CC addresses and supporting document links. The subject is set by HMS. In one step the Hiring Master System creates the assignment round and e-mails the candidate from the shared HR inbox; the candidate needs an email address on file. If a send fails, the round stays in place with a warning, and a <strong>Send assignment</strong> button on the round retries it with what you entered. See How does an Assignment round work? for what happens once the candidate replies.</p>
        ),
      },
      {
        id: 'emails',
        question: 'What e-mails does HMS send?',
        answer: (
          <p>Assignment e-mails (from the shared HR inbox), the optional rejection e-mail, and
          Google Calendar invites for interview rounds. HMS does not send a daily summary of pending
          items. When the Sourcing module's e-mails have been switched on (they are off by default, and
          there is no screen for this yet), HR/Admin and Super Admin users get one daily sourcing note on
          weekdays when something needs doing, and the company addresses set up for it get a Monday summary.</p>
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
          (LinkedIn, Naukri/IIMjobs, Agency, Internal Referral, Direct Outreach), dated tasks for
          each, and a weekly target. When something that was promised isn't done, HMS raises an{' '}
          <em>exception</em>. Open <strong>Sourcing</strong> in the left menu and pick a role at the top
          to see its whole plan. The Dashboard's last section, <strong>Sourcing execution</strong>, shows
          what is slipping across roles. The <strong>Sourcing</strong> box in My Tasks (HR/Admin and
          Super Admin) is the to-do list. A role's own page shows only a chip that opens its plan.</p>
        ),
      },
      {
        id: 'sourcing-owner',
        question: 'Who owns a sourcing plan?',
        answer: (
          <p>HR/Admin as a whole — never an individual. A plan has no owner field: it says
          "Owner: HR", every HR user sees the same Sourcing queue in My Tasks, and anyone in HR can
          complete, skip or resolve anything on any plan.</p>
        ),
      },
      {
        id: 'sourcing-plan',
        question: 'How do I activate and work a plan? (HR/Admin, Leadership and Super Admin)',
        answer: (
          <>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Open <strong>Sourcing</strong> in the left menu, pick the role (a role waiting for
              a plan is listed under "plans waiting to be activated") and click <strong>Activate plan</strong>.
              Tick the channels you'll use and optionally set this role's weekly qualified target. For a
              LinkedIn, Naukri/IIMjobs or Direct Outreach channel that is already live, tick{' '}
              <strong>Already running before today</strong> and give the post link and the weekly sourcing
              target. Leaving a suggested channel out needs a reason.</li>
              <li>Work the tasks on each channel (or from My Tasks → Sourcing): <strong>Mark done</strong>,{' '}
              <strong>Skip</strong> (with a reason) or <strong>Undo skip</strong>.</li>
              <li><strong>Add channel</strong> adds one mid-flight, <strong>Close channel</strong> stops one,{' '}
              <strong>Edit target and link</strong> changes a live channel's weekly target or post link, and{' '}
              <strong>Edit plan</strong> changes the strategy note and the role's weekly qualified target.</li>
            </ol>
            <p className="mt-2">Add channel and Edit plan appear once the plan is active or paused; before that, you
            choose the channels and the target in the Activate plan form. A channel that was left out can be brought
            back with <strong>Bring back</strong>.</p>
            <p className="mt-2">A role going On Hold pauses its plan: the weekly trackers stop (the week in progress is
            kept as "cut short") and start again the day the role is back on. When the role comes off hold, the due dates
            of open tasks move later by the days the plan was paused, so nothing is overdue the moment it resumes. Closing the role closes the plan and
            queues nothing else. Reopening a role returns its plan to a draft to activate again.</p>
          </>
        ),
      },
      {
        id: 'sourcing-tracker',
        question: 'How does the weekly tracker work for LinkedIn, Naukri/IIMjobs and Direct Outreach?',
        answer: (
          <>
            <p>The first task on each of these channels is <strong>logging the post</strong> (the job post
            or outreach campaign). To complete it you must give the <strong>link</strong> and a{' '}
            <strong>weekly sourcing target</strong>: how many applicants, qualified and unqualified
            together, you want that channel to bring in each week.</p>
            <p className="mt-2">From that day HMS counts every application to the role whose answer to “How did you
            hear about this opening?” on the application form is that channel (LinkedIn, Naukri/IIMJobs, HR Outreach → Direct Outreach, Hiring Agency → Agency,
            Employee Referral → Internal Referral). At the end of each 7-day week it
            adds a line to the channel: <strong>green "Met"</strong> if the count reached the target,{' '}
            <strong>red "Missed"</strong> if not. Nothing is typed in — the numbers come from the form.
            The week in progress shows live above the finished weeks, and the tracker runs until the
            channel is closed. If you change a target, weeks that already finished keep the target they
            were measured against. A week cut short — the channel was closed or the role put on hold — is
            listed but is neither met nor missed.</p>
            <p className="mt-2">A channel that was already live before the tracker existed shows “No weekly sourcing
            target is set”, and its “Log the … post” task is waiting: complete it (or use{' '}
            <strong>Add the target and post link</strong>) with the link and the target to start the tracker.</p>
          </>
        ),
      },
      {
        id: 'sourcing-target',
        question: 'Can the qualified-candidate target differ by role?',
        answer: (
          <p>Yes. Each role's plan shows "X / Y qualified in the last 7 days"; click <strong>Edit
          plan</strong> to set Y for that role (1–500), or clear it to go back to the default. The
          default is 5 for P0 and P1 roles; a P2 or P3 role has no target until you set one, and then
          it is checked like any other. "Qualified" means shortlisted by a person or scored above 60 by
          ResumeIQ. This is separate from each channel's weekly sourcing target above.</p>
        ),
      },
      {
        id: 'sourcing-next',
        question: 'Where do the recommended next steps come from?',
        answer: (
          <>
            <p>Under <strong>Needs attention</strong>, each problem has a <strong>Next</strong> box. HMS
            gives an AI model the role's target, the candidate pipeline as counts (how many are waiting
            for a decision, how many scored above 60 and so on), each channel's weekly results, and the
            open problems, and asks for concrete steps — which channel, what to do, by when. No candidate
            names or contact details are shared with it.</p>
            <p className="mt-2">The steps are saved and reused for up to a day while the numbers are the
            same. When the numbers change they are written again once the saved ones are at least 15 minutes
            old (until then you see a note that they are refreshing soon), and sooner when a new problem
            appears. <strong>Refresh</strong> asks for new ones (at most once a minute). If the AI is unavailable
            you get rule-based steps instead, labelled as such. Steps appear only once a plan is active or paused.
            Only HR/Admin, Leadership and Super Admin see them.</p>
          </>
        ),
      },
      {
        id: 'sourcing-close',
        question: 'What does "Close channel" do, and can I undo it?',
        answer: (
          <p>Closing a channel (with a short reason) stops its open tasks and nothing more is chased for
          it. It is not deleted: the post link, the targets and every weekly result stay on the plan as
          a summary, and the week in progress is recorded as "cut short". <strong>Reopen channel</strong>{' '}
          brings back its follow-up tasks and restarts the weekly tracker from that day (the next day if it was
          closed the same day) with the same
          target; the weeks already recorded stay as they are.</p>
        ),
      },
      {
        id: 'sourcing-history',
        question: 'What is in the Plan history?',
        answer: (
          <p>Every action on the plan, newest first, with who did it: tasks done or skipped, channels
          added, closed or reopened, target changes, problems resolved or put off, and the strategy note
          edits. HMS adds its own entries too (marked "System"): a problem it flagged or saw clear
          by itself, and the result of each finished tracker week. Filter by tasks, channels, weekly
          results, targets, alerts or plan (activation, holds and closing). Only HR/Admin, Leadership and Super Admin see it.</p>
        ),
      },
      {
        id: 'sourcing-exceptions',
        question: 'What is an exception, and how do I resolve one?',
        answer: (
          <>
            <p>An exception is something promised and not done: a plan not activated in time, a channel
            whose set-up is overdue, an overdue task or follow-up, too few qualified candidates (fewer than the
            role's target in the last 7 days on each of the last 5 working days), or a blocker past its
            deadline.</p>
            <p className="mt-2">Resolve each one of three ways: <strong>I'll catch up</strong> (a reason and
            a date within 14 days — it comes back if still true), <strong>Change the plan</strong> (a
            reason; optionally close the channel) or <strong>I'm blocked</strong> (a reason, who must
            unblock it, and a deadline within 60 days).</p>
          </>
        ),
      },
      {
        id: 'sourcing-provisional',
        question: 'What does "Provisional" mean on a sourcing signal?',
        answer: (
          <p>A new threshold signal, such as "not enough qualified candidates", that is still being
          calibrated for its first 6 weeks. HR/Admin, Leadership and Super Admin see it greyed out on the Dashboard and the Sourcing page,
          but it raises no tasks, sends no e-mail and can't be resolved yet.</p>
        ),
      },
      {
        id: 'sourcing-dates',
        question: 'How are due dates worked out?',
        answer: (
          <p>The first task of each channel is counted from the day the plan is activated (for a channel added
          later, from the day it was added), in India time, and falls due in working days (Monday to Friday): 1 working day for LinkedIn, Naukri/IIMjobs and
          Internal Referral, 2 for Agency and Direct Outreach. After that, follow-ups are counted in calendar
          days. With the standard settings, a LinkedIn or Naukri/IIMjobs posting is assumed to stay live for 30
          days, so its renewal falls due 27 days after the posting date and again 27 days after each renewal;
          agencies are followed up every 7 days and referrals reposted every 14 days. Public holidays aren't
          modelled. A task is overdue only after its due day ends. The weekly numbers for LinkedIn, Naukri/IIMjobs and
          Direct Outreach are not tasks: the tracker fills them in automatically.</p>
        ),
      },
      {
        id: 'sourcing-attribution',
        question: 'Why does "Applications by source" say "Not tagged"?',
        answer: (
          <p>The table, and the weekly tracker, count applicants by their answer to the{' '}
          <strong>How did you hear about this opening?</strong> question on the Job Application Form. An application with no
          answer shows as "Not tagged" and counts toward no channel, so link each job post or campaign
          to the form with its channel pre-filled. It is the applicant's own answer, so treat it as a
          claim.</p>
        ),
      },
      {
        id: 'sourcing-hm',
        question: 'What does a Hiring Manager see?',
        answer: (
          <p>A read-only "View only" plan for their own roles on the Sourcing page: channels, tasks, dates,
          weekly results and counts, but no strategy note, post links, notes, closing reasons, plan
          history, recommended steps or provisional signals. A channel's reason for being left out and an
          exception's resolution path and dates are still shown. A Hiring Manager of another role sees
          nothing.</p>
        ),
      },
      {
        id: 'sourcing-recruitment-mode',
        question: 'Why can\'t I edit a role\'s Recruitment Mode?',
        answer: (
          <p>Once a role has a sourcing plan, the plan owns the list of channels, so the Recruitment Mode field on
          the role is read-only and says it is managed in the Sourcing plan. Change the channels from the Sourcing
          page: a channel you add, bring back or reopen there is added to the role's Recruitment Mode too, while
          closing a channel leaves the role's list as it was. Before a plan exists, the field is edited on the role
          as usual (by HR/Admin, Leadership and Super Admin).</p>
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
            <p className="mb-2">There are four personas. Interview feedback isn't tied to a persona: HR/Admin,
            Leadership and Super Admin can submit it for any round, and anyone else only for rounds where
            their email is listed as an interviewer (a round with no interviewer listed, such as an
            assignment, is open to everyone).</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>HR/Admin</strong> — full visibility and control across roles, candidates,
              approvals, screening, and compensation data for every role.</li>
              <li><strong>Hiring Manager</strong> — views roles, candidates and applications company-wide
              with compensation hidden, <em>except</em> on the specific role(s) they're named on, where they
              also see the compensation of that role's candidates and applications (current and expected CTC).
              The role's own CTC band field, Salary Range column and Run benchmark panel stay HR/Admin, Leadership and Super Admin only.
              Submits interview feedback for rounds they're listed on, records Assignment outcomes, and can
              shortlist/hold/reject candidates from Applied and Screened (in My Tasks → Ready for review). They can
              also request a new role with the Request role button on the Roles page: it is created as a Draft without a
              compensation band, and HR/Admin, Leadership or Super Admin approve it or discard it. Role approval is HR/Admin,
              Leadership and Super Admin only — a Hiring Manager can't approve even their own role. Their Dashboard is
              locked to their own role(s) — this can't be changed. A role can have more than one
              Hiring Manager: HR lists them all in the role's Hiring Manager field, separated by
              commas, and each one gets all of the above for that role. Write each name as First Last: a comma always separates two people, so "Gosain, Amit" is read as two names and nobody would get access. Each name is matched against the person's HMS user name — whole name, ignoring case — so "Amit" does not match "Amit Gosain"; saving the role warns about any name that matches no user.</li>
              <li><strong>Leadership</strong> — sees and can do everything HR/Admin can (their permissions are deliberately identical, and HR/Admin approve roles too). The differences are in My Tasks: Ready for review shows Founder-flagged candidates plus any role they are the named Hiring Manager of (it can't be widened), and there is no Sourcing box, so Leadership works sourcing plans from the Sourcing page and the Dashboard. While the Sourcing module is switched on, Leadership and the Super Admin — but not HR/Admin — may also change its thresholds and e-mail settings; there is no screen for this yet, so ask whoever maintains HMS.</li>
              <li><strong>Super Admin</strong> — everything HR/Admin and Leadership have, plus User Management
              (adding, editing and deactivating accounts). Held by exactly one person.</li>
            </ul>
          </>
        ),
      },
      {
        id: 'comp-visibility',
        question: 'Who can see compensation details, exactly?',
        answer: (
          <p>A candidate's current and expected CTC are visible to HR/Admin, Leadership and Super Admin
          always, and to a Hiring Manager only for candidates and applications on the role(s) they're named on.
          The role's own CTC band field, its Salary Range column and the Run benchmark panel are shown to HR/Admin,
          Leadership and Super Admin only — a Hiring Manager doesn't see them even on their own role — and so are
          HR's compensation notes in Screening &amp; Risk Notes. Nobody else sees any of it, with one exception:
          when a role's band is edited, that role's activity timeline lists the edit with its old and new values,
          and the role's own Hiring Manager can read them there (for everyone else those values are hidden).</p>
        ),
      },
      {
        id: 'signin',
        question: 'I can\'t sign in — what do I do?',
        answer: (
          <p>Sign in with Google using your @digitalpaani.com account; any other Google account is refused. Your account must also have been added to HMS and not deactivated. If you see "not registered in HMS", ask the Super Admin to add you or restore your access in User Management — the message may tell you to ask HR, but only the Super Admin can add accounts. What you can see and do depends on the role your account has in HMS, and a Hiring Manager is recognised by the name on their account matching the name HR writes in the role's Hiring Manager field.</p>
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
          How the Hiring Master System's sections, workflows, AI automation and access rules fit together — available to everyone,
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
