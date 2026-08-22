import { useState } from 'react';
import { ChevronDown, ChevronUp, Download, HelpCircle } from 'lucide-react';
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
    title: 'What each section of HMS is for',
    sections: [
      {
        id: 'dashboard',
        question: 'What am I looking at on the Dashboard?',
        answer: (
          <>
            <p>A single, live snapshot of hiring health: open roles, active candidates, SLA
            breaches, and pending actions grouped by who owns them (HR/Recruiter, Hiring
            Manager, Interviewer, Leadership). Below that: aging roles (open too long relative
            to their priority), the hiring funnel (how many candidates sit at each stage, with
            how many were rejected at each stage as a subtext), source quality, time to fill,
            and a breakdown of roles by status.</p>
            <p className="mt-2">Use the filters at the top (Department, Location, Recruitment
            Mode, Priority, Role) to scope every section on the page to a subset — they all
            update together.</p>
          </>
        ),
      },
      {
        id: 'roles',
        question: 'What is the Roles page, and how is it different from a role\'s detail page?',
        answer: (
          <p>Roles lists every requisition — one row per open position, with priority, status,
          hiring manager, and how many active candidates are in the pipeline. Click into a role
          to see its full detail: requirements, compensation band (HR/Leadership only),
          approval status, links (JD, calendar, assignment repo), and — once built — its full
          activity timeline. New roles normally arrive automatically from the Requisition Form,
          but the New Role / Request Role button lets you add one directly.</p>
        ),
      },
      {
        id: 'candidates',
        question: 'What is Candidates, and what are "Unlinked" and "Unmatched" candidates?',
        answer: (
          <>
            <p>Candidates is the full applicant list across every role, with search and the same
            filter set as the Dashboard. Two amber banners can appear above the table:</p>
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
        id: 'talent-pool',
        question: 'What is Talent Pool for?',
        answer: (
          <p>A separate holding area for candidates who are either <strong>on hold for future
          roles</strong> (good candidates, wrong timing) or <strong>archived</strong> (rejected
          or withdrawn). They're pulled out of the main Candidates pipeline view so they don't
          clutter active hiring, but stay searchable and re-linkable to a new role at any time.</p>
        ),
      },
      {
        id: 'scorecard-queue',
        question: 'What\'s the difference between My Queue and Scorecard Summary?',
        answer: (
          <>
            <p><strong>My Queue</strong> is your own personal worklist — candidates at Resume
            Review awaiting your shortlist decision, plus any interview feedback you owe.
            It only shows what's actually yours to act on.</p>
            <p className="mt-1.5"><strong>Scorecard Summary</strong> is the full, org-wide table
            of every ResumeIQ-scored candidate side by side, with all 8 dimension scores, verdict,
            and compensation — built for comparing candidates against each other, not just
            working through your own queue. Both pages offer the same Shortlist / Hold for
            Future / Reject actions on Resume Review candidates.</p>
          </>
        ),
      },
      {
        id: 'agencies',
        question: 'What is the Agencies page? (HR/Admin only)',
        answer: (
          <p>Tracks recruitment agencies and the candidates they've submitted, so agency
          performance and fees can be reviewed against what they've actually delivered.</p>
        ),
      },
    ],
  },
  {
    title: 'How the hiring workflow actually works',
    sections: [
      {
        id: 'role-lifecycle',
        question: 'What do the role statuses mean?',
        answer: (
          <p><strong>Draft</strong> (just created, not yet reviewed) → <strong>Under
          Review</strong> → <strong>Approved</strong> (an authorized approver has signed off —
          this is also when the role's Open Date is set, which drives its age calculation) →
          <strong> Live – Sourcing</strong> (actively hiring) → <strong>On Hold</strong> or
          <strong> Closed – Filled</strong> / <strong>Closed – Cancelled</strong>.</p>
        ),
      },
      {
        id: 'three-fields',
        question: 'Why does an application have a Stage, a Status, AND a Screening Status?',
        answer: (
          <>
            <p>They track three independent things, each updated separately:</p>
            <ul className="list-disc pl-5 mt-1.5 space-y-1">
              <li><strong>Stage</strong> — where the candidate sits in the pipeline (Applied →
              Resume Review → Shortlisted → Interview rounds → Reference Check → Offer → Joined).</li>
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
          <p>Every stage has a maximum time a candidate should sit there before someone needs to
          act (e.g. Resume Review, HM shortlist decisions, interview feedback). If a candidate
          sits past that window, the system raises a pending action for whoever owns that step
          (HR/Recruiter, Hiring Manager, Interviewer, or Leadership for compensation-change and
          founder-review flags) and marks the application as SLA-breached. These checks run
          automatically whenever the Dashboard loads — there's no separate button to trigger
          them.</p>
        ),
      },
      {
        id: 'over-budget',
        question: 'Why was I asked for a reason before shortlisting a candidate?',
        answer: (
          <p>If a candidate's expected CTC is 15% or more above the role's stated compensation
          band, HMS requires an explicit, on-record reason before they can be moved to
          Shortlisted — so an over-budget hire is always a documented decision, not an
          accident.</p>
        ),
      },
    ],
  },
  {
    title: 'AI automation in HMS',
    sections: [
      {
        id: 'resumeiq',
        question: 'What is ResumeIQ, and when does it run?',
        answer: (
          <p>ResumeIQ automatically scores a candidate the moment their application moves to
          Resume Review. It fetches the actual resume text from Drive (PDF, DOCX, or Google
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
          <p>Once a role is approved, HMS can generate both a long-form JD (2-page PDF) and a
          social-sharable graphic version directly from the role's data, and store both on
          Drive with links surfaced on the role's detail page.</p>
        ),
      },
      {
        id: 'assignment-email',
        question: 'How do Assignment emails get sent?',
        answer: (
          <p>From a candidate's Assignment Round action, HMS composes and sends the assignment
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
          <ul className="list-disc pl-5 space-y-1.5">
            <li><strong>HR/Admin</strong> — full visibility and control across roles, candidates,
            approvals, screening, and compensation data.</li>
            <li><strong>Hiring Manager</strong> — views roles/candidates/applications with
            compensation fields hidden, submits interview feedback for rounds they're listed on,
            records Assignment outcomes, and can shortlist/hold/reject candidates at Resume
            Review.</li>
            <li><strong>Interviewer</strong> — submits feedback for interview rounds they're
            assigned to.</li>
            <li><strong>Leadership</strong> — sees everything HR/Admin sees (no field or route
            either is blocked from that the other isn't) and additionally approves roles.</li>
            <li><strong>Super Admin</strong> — everything Leadership has, plus User Management
            (adding/removing accounts). Held by exactly one person.</li>
          </ul>
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
          How HMS's sections, workflows, and AI automation fit together — available to everyone,
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
          className="btn-primary text-sm flex items-center gap-1.5 shrink-0"
        >
          <Download className="w-3.5 h-3.5" /> Download guide (PDF)
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
