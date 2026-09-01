import { useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, HelpCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { PERSONAS } from '../types/index.ts';

interface Section {
  id:       string;
  question: string;
  answer:   React.ReactNode;
}

// Grouped so the page reads as a table of contents, not one long list —
// each group maps to one of the four things item #23 asked for: sections,
// workflow/logic, AI automation, and where to find things.
const GROUPS: Array<{ title: string; sections: Section[] }> = [
  {
    title: 'What each section of the Hiring Master System is for',
    sections: [
      {
        id: 'dashboard',
        question: 'What am I looking at on the Dashboard?',
        answer: (
          <>
            <p>A live snapshot of hiring health, in three parts. The top KPI cards (Open Roles,
            Active Candidates, SLA Breaches) each carry four supporting sub-metrics — hover the{' '}
            <span className="italic">i</span> icon next to any card or section title throughout
            the app for an on-the-spot explanation of exactly what it measures.</p>
            <p className="mt-2">Below that, the <strong>Hiring Funnel Snapshot</strong> is an
            interactive chevron strip: click any stage to see which SLA breach types are open
            there and exactly who's overdue, filterable by owner (HR/Recruiter or Hiring Manager).
            Role isn't a filter local to this section anymore — it inherits the Role filter from
            the master filters above, like every other section.</p>
            <p className="mt-2">Further down: <strong>Aging roles</strong> (every role currently
            Approved, Live – Sourcing, or On Hold, with days-open shown for all of them — only
            ones actually past their Close Target get a red/yellow flag, sorted to the top; On
            Hold roles are listed for reference but never flagged), the <strong>Hiring
            funnel</strong> chart
            (every stage, broken into Active/Rejected/Withdrawn/Hold for Future so a stage never
            silently disappears just because nobody's currently sitting there), Source Quality,
            Low Pipeline Roles, and Operational Velocity (turnaround time per stage,
            Interview→Offer ratio, and the biggest drop-off stage shown both by raw count and by
            rejection rate, since those two can point at different stages).</p>
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
            <p>Roles lists every requisition — one row per open position, with priority, status,
            hiring manager, Active Candidates count, and Active Shortlist count. Click into a role
            for its full detail: requirements, compensation band, approval status, links (JD,
            calendar, assignment repo), pipeline, and activity timeline. New roles normally arrive
            automatically from the Requisition Form, but the New Role / Request Role button lets
            you add one directly.</p>
            <p className="mt-2">Once a role is marked <strong>Closed – Filled</strong> or{' '}
            <strong>Closed – Cancelled</strong>, a <strong>Download Closure Summary</strong>{' '}
            button appears on its detail page — a 1-page PDF retrospective covering every
            candidate the role ever saw (not just the ones still active), total SLA breaches by
            type, source quality, and how long it took to close.</p>
          </>
        ),
      },
      {
        id: 'candidates',
        question: 'What is Candidates, and what are "Unlinked" and "Unmatched" candidates?',
        answer: (
          <>
            <p>Candidates is the full applicant list across every role, with search and the same
            filter set as the Dashboard. Company / Industry is a merged column ("company /
            industry", both from the candidate's own profile); Application Date shows how many
            days ago the candidate applied. The Last Updated column shows a one-line subtext of
            what actually happened most recently (a stage change, a score, an email sent) — not
            just when. Click the <strong>Fit</strong>, <strong>Application Date</strong>, or{' '}
            <strong>Last Updated</strong> column headers to sort by that column — click again to
            flip direction (starts descending); sorting only reorders whatever rows are currently
            visible after your filters. Two amber banners can appear above the table:</p>
            <ul className="list-disc pl-5 mt-1.5 space-y-1">
              <li><strong>Unlinked candidates</strong> — a candidate record exists but has no
              application to any role yet (e.g. a resume was added directly, or an old
              application was removed).</li>
              <li><strong>Unmatched role submissions</strong> — a candidate applied via the Job
              Application Form, but the role name they typed didn't match any role in the
              system closely enough to auto-link. HR can link it manually or discard it.</li>
            </ul>
          </>
        ),
      },
      {
        id: 'candidate-detail',
        question: 'On a candidate\'s page, why does a "Rejected" tag look clickable?',
        answer: (
          <p>Click any red <strong>Rejected</strong> tag on a candidate's applications to see the
          exact reason category (and any additional detail) that was logged at the time — no need
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
        id: 'stage-status-buttons',
        question: 'Where are the Stage/Status buttons on a candidate\'s page? (HR/Leadership only)',
        answer: (
          <p>If a candidate has exactly one application, Stage/Status buttons sit at the top of
          the page next to their name. If they have two or more applications, there's no single
          "the" application to act on from the top, so the buttons move down to sit on each
          application's own row instead. These buttons are HR-tier only — a Hiring Manager
          shortlists a candidate from Applied and Screened via the Candidates, Scorecard Summary,
          or My Tasks pages instead.</p>
        ),
      },
      {
        id: 'talent-pool',
        question: 'What is Talent Pool for?',
        answer: (
          <>
            <p>A separate holding area for candidates who are either <strong>on hold for future
            roles</strong> (good candidates, wrong timing) or <strong>archived</strong> (rejected
            or withdrawn). They're pulled out of the main Candidates pipeline view so they don't
            clutter active hiring, but stay searchable and re-linkable to a new role at any time.</p>
            <p className="mt-2">It's a table, not a card grid — one row per candidate <em>and</em>
            application, so a candidate with more than one past application shows their full
            history here, not just the one that put them in this pool. Each row has its own{' '}
            <strong>Reactivate</strong> button to re-link that candidate to a new role.</p>
          </>
        ),
      },
      {
        id: 'scorecard-queue',
        question: 'What\'s the difference between My Tasks and Scorecard Summary?',
        answer: (
          <>
            <p><strong>My Tasks</strong> is your own personal worklist, scoped to what's actually
            yours to act on: a <strong>Ready for review</strong> section (candidates who've
            applied and are awaiting a shortlist decision — HR/Admin and Super Admin see everyone,
            a Hiring Manager sees only their own role's candidates, and Leadership sees only candidates
            flagged for Founder Review, since day-to-day shortlisting is HR/HM's job rather than
            a leadership task), plus any interview or assignment feedback you personally owe.</p>
            <p className="mt-1.5"><strong>Scorecard Summary</strong> is the full, org-wide table
            of every ResumeIQ-scored candidate side by side, with all 8 dimension scores and
            verdict — built for comparing candidates against each other, not just working through
            your own tasks. Instead of a chevron, a centered <strong>View Highlights and
            Summary</strong> button under the score columns expands a candidate's strengths, red
            flags, and executive summary. Both pages offer the same Shortlist / Hold for Future /
            Reject actions on Applied and Screened candidates, individually or in bulk.</p>
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
        id: 'user-management',
        question: 'What is User Management? (Super Admin only)',
        answer: (
          <p>The only place accounts actually get added, edited, or deactivated — "removing
          access" deactivates an account rather than deleting it, since a user's past actions
          (interview feedback, activity log entries) stay attached to their record. Held by
          exactly one person at DigitalPaani.</p>
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
              progress, separate from the pipeline stage the candidate visibly sits at.</li>
            </ul>
            <p className="mt-1.5">Rejecting or withdrawing a candidate always requires selecting
            a reason category first — this is deliberate, not a bug, so hiring data stays
            auditable.</p>
          </>
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
            <strong>"Feedback Due"</strong> (feedback hasn't been submitted since a round
            happened), and <strong>Joining risk — no contact</strong> (5+ days with no HR
            follow-up after Offer Accepted). A breached application is marked sla_breach and a
            pending action is raised for whoever owns that step. These checks run automatically
            whenever the Dashboard loads — there's no separate button to trigger them, and a
            breach resolves itself the moment its underlying condition is actually addressed
            (not just on the next scheduled check).</p>
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
        id: 'jd-gen',
        question: 'Where do generated job descriptions come from?',
        answer: (
          <p>Once a role is approved, the Hiring Master System can generate both a long-form JD (2-page PDF) and a
          social-sharable graphic version directly from the role's data, and store both on
          Drive with links surfaced on the role's detail page.</p>
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
              candidates from Applied and Screened. Role approval is HR/Leadership/Super Admin only — a Hiring
              Manager can't approve even their own role. Their Dashboard is
              locked to their own role(s) — this can't be changed.</li>
              <li><strong>Leadership</strong> — sees everything HR/Admin sees (no field or route
              either is blocked from that the other isn't) and additionally approves roles.</li>
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
          anywhere in the system, including in a role's edit history if a compensation field was
          ever changed.</p>
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

      {GROUPS.map(group => (
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
