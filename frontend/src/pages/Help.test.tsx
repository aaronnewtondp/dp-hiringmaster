import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// A plain function, not vi.fn(): the spy re-throws a rejected result on a derived promise, which vitest reports as an unhandled error.
let status: () => Promise<unknown> = async () => ({ data: { enabled: false } });
vi.mock('../services/api.ts', () => ({ sourcingApi: { status: () => status() } }));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Aaron Newton', email: 'a@x.com', persona: 'hr_recruiter' } }),
}));

import Help from './Help.tsx';

let qc: QueryClient;
function mount() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Help /></QueryClientProvider>);
}
const SOURCING_TITLE = /Sourcing execution & accountability/i;
const open = (question: RegExp | string) => fireEvent.click(screen.getByRole('button', { name: question }));

const answers = (body: unknown) => { status = async () => body; };
const fails = () => { status = async () => { throw new Error('boom'); }; };

describe('Help — the Sourcing group describes screens that only exist while the module is on', () => {
  it('is hidden when the module is off', async () => {
    answers({ data: { enabled: false } });
    mount();
    await waitFor(() => expect(qc.getQueryState(['sourcing-status'])?.status).toBe('success'));
    expect(screen.queryByText(SOURCING_TITLE)).toBeNull();
    expect(screen.getByText('Access & permissions')).toBeTruthy();   // the rest of the page is untouched
  });

  it('stays hidden — and the page still renders — when the status call fails', async () => {
    fails();
    mount();
    await waitFor(() => expect(qc.getQueryState(['sourcing-status'])?.status).toBe('error'));
    expect(screen.queryByText(SOURCING_TITLE)).toBeNull();
    expect(screen.getByText('Access & permissions')).toBeTruthy();
  });

  it('shows once the module is enabled, and its answers match how the module works today', async () => {
    answers({ data: { enabled: true } });
    mount();
    await screen.findByText(SOURCING_TITLE);

    open(/Who owns a sourcing plan/i);
    expect(screen.getByText(/HR\/Admin as a whole — never an individual/)).toBeTruthy();

    open(/How are due dates worked out/i);
    expect(screen.getByText(/Public holidays aren't modelled/)).toBeTruthy();

    open(/Why does "Applications by source" say "Not tagged"/i);
    expect(screen.getByText(/applicant's own answer/)).toBeTruthy();
  });
});

describe('Help — answers that were wrong or stale', () => {
  beforeEach(() => answers({ data: { enabled: false } }));

  it('does not promise a daily pending-items e-mail (that cron has never fired)', async () => {
    mount();
    open('What e-mails does HMS send?');
    expect(screen.getByText(/does not send a daily summary of pending/)).toBeTruthy();
  });

  it('describes My Tasks as boxes, and Scorecard Summary as the table inside Ready for review', async () => {
    mount();
    open(/What is My Tasks, and what is the Scorecard Summary table/i);
    expect(screen.getByText(/row of boxes with counts/)).toBeTruthy();
    expect(screen.getByText(/not a separate page/)).toBeTruthy();
  });

  it('every question opens independently (no two sections share an id)', async () => {
    answers({ data: { enabled: true } });
    mount();
    await screen.findByText(SOURCING_TITLE);
    const questions = screen.getAllByRole('button').filter(b => b.querySelector('svg') && b.textContent);   // the FAQ rows (the guide links are anchors)
    expect(questions.length).toBeGreaterThan(30);
    for (const q of questions) fireEvent.click(q);
    // all open at once: a duplicated id would have toggled two rows together and left some closed
    expect(document.querySelectorAll('.leading-relaxed').length).toBe(questions.length);
  });
});

// ─── The Sourcing group after the move to the Sourcing page ────────────────────────────────────────
const SOURCING_QUESTIONS: Array<string | RegExp> = [
  'What is Sourcing execution, and where do I find it?',
  'Who owns a sourcing plan?',
  /How do I activate and work a plan/,
  'How does the weekly tracker work for LinkedIn, Naukri/IIMjobs and Direct Outreach?',
  'Can the qualified-candidate target differ by role?',
  'Where do the recommended next steps come from?',
  'What does "Close channel" do, and can I undo it?',
  'What is in the Plan history?',
  /What is an exception, and how do I resolve one/,
  /What does "Provisional" mean/,
  'How are due dates worked out?',
  /Why does "Applications by source" say "Not tagged"/,
  'What does a Hiring Manager see?',
  'Why can\'t I edit a role\'s Recruitment Mode?',
];
/** Opens a question and returns its answer as one whitespace-normalised string. */
function answerTo(question: string | RegExp): string {
  const button = screen.getByRole('button', { name: question });
  fireEvent.click(button);
  const body = button.parentElement!.querySelector('.leading-relaxed');
  expect(body, `no answer opened for ${String(question)}`).not.toBeNull();
  return (body!.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('Help — the Sourcing questions exist only while the module is on', () => {
  it('every Sourcing question is listed when the module is enabled', async () => {
    answers({ data: { enabled: true } });
    mount();
    await screen.findByText(SOURCING_TITLE);
    for (const q of SOURCING_QUESTIONS) expect(screen.getByRole('button', { name: q }), String(q)).toBeInTheDocument();
  });

  it('none of them is listed (and nothing about the workspace leaks into the page) when the module is off', async () => {
    answers({ data: { enabled: false } });
    mount();
    await waitFor(() => expect(qc.getQueryState(['sourcing-status'])?.status).toBe('success'));
    for (const q of SOURCING_QUESTIONS) expect(screen.queryByRole('button', { name: q }), String(q)).toBeNull();
    expect(screen.queryByText(/Close channel/)).toBeNull();
    expect(screen.queryByText(/weekly sourcing target/)).toBeNull();
  });

  it('none of them is listed when the status call fails', async () => {
    fails();
    mount();
    await waitFor(() => expect(qc.getQueryState(['sourcing-status'])?.status).toBe('error'));
    for (const q of SOURCING_QUESTIONS) expect(screen.queryByRole('button', { name: q })).toBeNull();
  });

  it('the Dashboard answer points to Sourcing execution and the Sourcing page only as something that appears with the module', async () => {
    mount();
    const text = answerTo('What am I looking at on the Dashboard?');
    expect(text).toMatch(/When the Sourcing module is switched on, the last section is Sourcing execution .*one role's whole plan is on the Sourcing page in the left menu/);
  });
});

describe('Help — what the Sourcing answers say about the new design', () => {
  beforeEach(() => answers({ data: { enabled: true } }));
  const mountReady = async () => { mount(); await screen.findByText(SOURCING_TITLE); };

  it('says where it lives: Sourcing in the left menu, pick a role at the top, and the role page only has a chip', async () => {
    await mountReady();
    const t = answerTo('What is Sourcing execution, and where do I find it?');
    expect(t).toMatch(/Open Sourcing in the left menu and pick a role at the top to see its whole plan/);
    expect(t).toMatch(/role's own page shows only a chip that opens its plan/);
    expect(t).toMatch(/Sourcing box in My Tasks/);
  });

  it('activation: the Sourcing page flow, the weekly target and the link needed for an already-running tracked channel', async () => {
    await mountReady();
    const t = answerTo(/How do I activate and work a plan/);
    expect(t).toMatch(/Open Sourcing in the left menu, pick the role/);
    expect(t).toMatch(/Activate plan/);
    expect(t).toMatch(/Already running before today and give the post link and the weekly sourcing target/);
    expect(t).toMatch(/Add channel.*Close channel.*Edit target and link.*Edit plan/);
    expect(t).toMatch(/On Hold pauses its plan/);
  });

  it('the weekly tracker: link + weekly target are mandatory, numbers come from the application form, green Met / red Missed', async () => {
    await mountReady();
    const t = answerTo('How does the weekly tracker work for LinkedIn, Naukri/IIMjobs and Direct Outreach?');
    expect(t).toMatch(/logging the post/);
    expect(t).toMatch(/you must give the link and a weekly sourcing target/);
    expect(t).toMatch(/qualified and unqualified together/);
    expect(t).toMatch(/answer to “How did you hear about this opening\?” on the application form is that channel/);
    expect(t).toMatch(/green "Met".*red "Missed"/);
    expect(t).toMatch(/Nothing is typed in/);
    expect(t).toMatch(/runs until the channel is closed/);
    expect(t).toMatch(/weeks that already finished keep the target they were measured against/);
  });

  it('the weekly tracker: a week cut short (channel closed or role on hold) is listed but is neither met nor missed', async () => {
    await mountReady();
    const t = answerTo('How does the weekly tracker work for LinkedIn, Naukri/IIMjobs and Direct Outreach?');
    expect(t).toMatch(/A week cut short — the channel was closed or the role put on hold — is listed but is neither met nor missed\./);
  });

  it('the weekly tracker: a channel that went live before the tracker existed shows "No weekly sourcing target is set" and a waiting "Log the … post" task', async () => {
    await mountReady();
    const t = answerTo('How does the weekly tracker work for LinkedIn, Naukri/IIMjobs and Direct Outreach?');
    expect(t).toMatch(/A channel that was already live before the tracker existed shows “No weekly sourcing target is set”/);
    expect(t).toMatch(/its “Log the … post” task is waiting/);
    expect(t).toMatch(/complete it \(or use Add the target and post link\) with the link and the target to start the tracker/);
  });

  it('activation: a role on hold stops the weekly trackers, keeps the week in progress as "cut short" and starts them again the day the role is back on', async () => {
    await mountReady();
    const t = answerTo(/How do I activate and work a plan/);
    expect(t).toMatch(/A role going On Hold pauses its plan: the weekly trackers stop \(the week in progress is kept as "cut short"\) and start again the day the role is back on\./);
    expect(t).toMatch(/Closing the role closes the plan and queues nothing else/);
    expect(t).toMatch(/Reopening a role returns its plan to a draft to activate again/);
  });

  it('the qualified target: per role, 1-500, default 5 for P0/P1 and none for P2/P3, and separate from the channel targets', async () => {
    await mountReady();
    const t = answerTo('Can the qualified-candidate target differ by role?');
    expect(t).toMatch(/Yes\. Each role's plan shows "X \/ Y qualified in the last 7 days"/);
    expect(t).toMatch(/Edit plan/);
    expect(t).toMatch(/\(1–500\)/);
    expect(t).toMatch(/default is 5 for P0 and P1 roles; a P2 or P3 role has no target until you set one/);
    expect(t).toMatch(/shortlisted by a person or scored above 60 by ResumeIQ/);
    expect(t).toMatch(/separate from each channel's weekly sourcing target/);
  });

  it('next steps: AI from counts only (no names), cached for a day, Refresh at most once a minute, rule-based fallback, HR/Admin, Leadership and Super Admin only', async () => {
    await mountReady();
    const t = answerTo('Where do the recommended next steps come from?');
    expect(t).toMatch(/Needs attention.*Next box/);
    expect(t).toMatch(/AI model/);
    expect(t).toMatch(/No candidate names or contact details are shared with it/);
    expect(t).toMatch(/reused for up to a day while the numbers are the same/);
    expect(t).toMatch(/Refresh asks for new ones \(at most once a minute\)/);
    expect(t).toMatch(/rule-based steps instead, labelled as such/);
    expect(t).toMatch(/Only HR\/Admin, Leadership and Super Admin see them/);
  });

  it('next steps: written again after 15 minutes when the numbers change, sooner for a new problem, and only for an active or paused plan', async () => {
    await mountReady();
    const t = answerTo('Where do the recommended next steps come from?');
    expect(t).toMatch(/When the numbers change they are written again once the saved ones are at least 15 minutes old/);
    expect(t).toMatch(/sooner when a new problem appears/);
    expect(t).toMatch(/Steps appear only once a plan is active or paused/);
  });

  it('Close channel: needs a reason, stops tasks, keeps the summary, cuts the running week short, can be reopened', async () => {
    await mountReady();
    const t = answerTo('What does "Close channel" do, and can I undo it?');
    expect(t).toMatch(/with a short reason/);
    expect(t).toMatch(/stops its open tasks/);
    expect(t).toMatch(/not deleted: the post link, the targets and every weekly result stay on the plan as a summary/);
    expect(t).toMatch(/recorded as "cut short"/);
    expect(t).toMatch(/Reopen channel brings back its follow-up tasks and restarts the weekly tracker from that day \(the next day if it was closed the same day\) with the same target/);
    expect(t).not.toMatch(/Stop using/i);
  });

  it('Plan history: every action, who did it, System entries, the filters and who may see it', async () => {
    await mountReady();
    const t = answerTo('What is in the Plan history?');
    expect(t).toMatch(/Every action on the plan, newest first, with who did it/);
    expect(t).toMatch(/tasks done or skipped, channels added, closed or reopened, target changes/);
    expect(t).toMatch(/marked "System"/);
    expect(t).toMatch(/result of each finished tracker week/);
    expect(t).toMatch(/Filter by tasks, channels, weekly results, targets, alerts or plan \(activation, holds and closing\)/);
    expect(t).toMatch(/Only HR\/Admin, Leadership and Super Admin see it/);
  });

  it('the exception answer uses the role\'s own target, not a fixed number', async () => {
    await mountReady();
    const t = answerTo(/What is an exception, and how do I resolve one/);
    expect(t).toMatch(/fewer than the role's target in the last 7 days on each of the last 5 working days/);
    expect(t).toMatch(/I'll catch up.*Change the plan.*I'm blocked/);
  });

  it('the exception answer calls the set-up exception "set-up is overdue" (not "not live") and says Change the plan can optionally close the channel', async () => {
    await mountReady();
    const t = answerTo(/What is an exception, and how do I resolve one/);
    expect(t).toMatch(/a channel whose set-up is overdue/);
    expect(t).not.toMatch(/not live|Stop using|stop using/);
    expect(t).toMatch(/Change the plan \(a reason; optionally close the channel\)/);
    expect(t).toMatch(/I'm blocked \(a reason, who must unblock it, and a deadline within 60 days\)/);
    expect(t).toMatch(/I'll catch up \(a reason and a date within 14 days — it comes back if still true\)/);
  });

  it('due dates: the weekly numbers are not tasks but filled in by the tracker', async () => {
    await mountReady();
    const t = answerTo('How are due dates worked out?');
    expect(t).toMatch(/weekly numbers for LinkedIn, Naukri\/IIMjobs and Direct Outreach are not tasks: the tracker fills them in automatically/);
  });

  it('"Applications by source" is driven by the form\'s "How did you hear about this opening?" answer, shown as "Not tagged" when blank', async () => {
    await mountReady();
    const t = answerTo(/Why does "Applications by source" say "Not tagged"/);
    expect(t).toMatch(/How did you hear about this opening\? question on the Job Application Form/);
    expect(t).toMatch(/shows as "Not tagged" and counts toward no channel/);
    expect(t).toMatch(/applicant's own answer/);
  });

  it('what a Hiring Manager sees: a read-only plan on the Sourcing page without links, reasons, history or recommended steps', async () => {
    await mountReady();
    const t = answerTo('What does a Hiring Manager see?');
    expect(t).toMatch(/read-only "View only" plan for their own roles on the Sourcing page/);
    expect(t).toMatch(/no strategy note, post links, notes, closing reasons, plan history, recommended steps or provisional signals/);
    expect(t).not.toMatch(/role's page/);
  });

  it('no Sourcing answer still sends anyone to a Sourcing card on the role page', async () => {
    await mountReady();
    for (const q of SOURCING_QUESTIONS) expect(answerTo(q), String(q)).not.toMatch(/Sourcing card|#sourcing\b|role page\b.*Sourcing plan/);
  });
});

// ─── Sourcing answers corrected after the October 2026 audit ───────────────────────────────────────
describe('Help — Sourcing answers that were wrong or incomplete', () => {
  beforeEach(() => answers({ data: { enabled: true } }));
  const mountReady = async () => { mount(); await screen.findByText(SOURCING_TITLE); };

  it('due dates: only the first task is in working days (1 or 2), every follow-up is in calendar days (27 / 7 / 14)', async () => {
    await mountReady();
    const t = answerTo('How are due dates worked out?');
    expect(t).toMatch(/The first task of each channel falls due in working days \(Monday to Friday\): 1 working day for LinkedIn, Naukri\/IIMjobs and Internal Referral, 2 for Agency and Direct Outreach/);
    expect(t).toMatch(/After that, follow-ups are counted in calendar days/);
    expect(t).toMatch(/its renewal falls due 27 days after the posting date and again 27 days after each renewal/);
    expect(t).toMatch(/agencies are followed up every 7 days and referrals reposted every 14 days/);
    // the first version said every due date was in working days and the renewal came "every 30 days"
    expect(t).not.toMatch(/every 30 days/);
  });

  it('activation: Add channel and Edit plan need an active or paused plan, a left-out channel comes back with Bring back, and due dates shift after a hold', async () => {
    await mountReady();
    const t = answerTo(/How do I activate and work a plan/);
    expect(t).toMatch(/Add channel and Edit plan appear once the plan is active or paused/);
    expect(t).toMatch(/Bring back/);
    expect(t).toMatch(/due dates of open tasks move later by the days the plan was paused/);
  });

  it('who sees the sourcing extras is HR/Admin, Leadership and Super Admin, and the question titles do not use the internal word "HR-tier"', async () => {
    await mountReady();
    expect(screen.getByRole('button', { name: /How do I activate and work a plan\? \(HR\/Admin, Leadership and Super Admin\)/ })).toBeInTheDocument();
    expect(answerTo(/What does "Provisional" mean/)).toMatch(/HR\/Admin, Leadership and Super Admin see it greyed out/);
  });

  it('Recruitment Mode: read-only once a plan exists; adding a channel is mirrored to the role, closing one is not', async () => {
    await mountReady();
    const t = answerTo('Why can\'t I edit a role\'s Recruitment Mode?');
    expect(t).toMatch(/the plan owns the list of channels, so the Recruitment Mode field on the role is read-only/);
    expect(t).toMatch(/a channel you add, bring back or reopen there is added to the role's Recruitment Mode too, while closing a channel leaves the role's list as it was/);
  });
});

// ─── Answers outside the Sourcing group, corrected after the October 2026 audit ────────────────────
describe('Help — workflow and section answers that were wrong, stale or misleading', () => {
  beforeEach(() => answers({ data: { enabled: false } }));

  it('SLA checks: raised by opening the Dashboard, not on a timer; Joining risk is raised for every accepted offer because no screen logs the contact', () => {
    mount();
    const t = answerTo('What triggers a "pending action" or an "SLA breach"?');
    expect(t).toMatch(/These checks run when anyone opens the Dashboard \(at most once every few minutes\) — they are not on a timer/);
    expect(t).toMatch(/Assignment deadline breached clears at the first check after HR records the submission/);
    expect(t).toMatch(/Joining risk — no contact \(a candidate at Offer Accepted with no HR contact date on record — HMS has no screen for logging that contact today/);
    // the old text promised a 5-day wait and a "scheduled check", and named a database column
    expect(t).not.toMatch(/in the 5 days after Offer Accepted/);
    expect(t).not.toMatch(/sla_breach/);
  });

  it('automatic move: 2.5 out of 5, Approved for Next Round for an assignment, and it never rejects or holds anyone', () => {
    mount();
    const t = answerTo('Can a candidate move to the next stage automatically?');
    expect(t).toMatch(/Proceed or Proceed with Concerns, with an average score above 2\.5 out of 5/);
    expect(t).toMatch(/Approved for Next Round with a weighted score above 2\.5 out of 5/);
    expect(t).toMatch(/A Hold, Reject, Assignment Resent or Rejected result, or a low score, never moves anyone/);
    expect(t).toMatch(/It doesn't reject or hold the candidate either/);
    expect(t).not.toMatch(/midpoint of the rubric/);
  });

  it('My Tasks: three lists share one window of 100, Ready for review is separate, and Other Pending Actions is everything company-wide for HR', () => {
    mount();
    const t = answerTo(/What is My Tasks, and what is the Scorecard Summary table/i);
    expect(t).toMatch(/all filled from one shared list of the 100 highest-priority, oldest open items/);
    expect(t).toMatch(/Ready for review is separate and shows up to 500 candidates/);
    expect(t).toMatch(/every other open item company-wide, whoever it is assigned to/);
    // a round that lists no interviewer is owed by the role's Hiring Manager, so it is in their Feedback Due too
    expect(t).toMatch(/a Hiring Manager only the rounds they're listed as an interviewer on, or the rounds on their own roles that list no interviewer/);
    expect(t).not.toMatch(/Each list shows the 100/);
  });

  it('Roles: opens on Approved and Live – Sourcing only, and Active Shortlist is defined', () => {
    mount();
    const t = answerTo(/What is the Roles page/);
    expect(t).toMatch(/The page opens showing only Approved and Live – Sourcing roles/);
    expect(t).toMatch(/Active Shortlist counts Active candidates currently at Interview Round 1, Interview Round 2, Assignment Round or Founders Round/);
    expect(t).not.toMatch(/Roles lists every requisition/);
  });

  it('role statuses: set by hand, nothing moves Approved to Live – Sourcing, and the aging days are per priority', () => {
    mount();
    const t = answerTo(/What do the role statuses mean/);
    expect(t).toMatch(/These are not automatic steps/);
    expect(t).toMatch(/Nothing moves a role from Approved to Live – Sourcing for you/);
    expect(t).toMatch(/P0 after 10 and 23 days, P1 after 15 and 45, P2 after 30 and 68, P3 after 30 and 90/);
    // a role short of the yellow threshold shows only how long it has been open — not "days past target"
    expect(t).toMatch(/Until then the role just shows how long it has been open, with no colour/);
    expect(t).not.toMatch(/isn't flagged at all until its Close Target has actually passed/);
  });

  it('stage, status and screening status: all eleven stages are named, and the screening status is only a label that starts as New', () => {
    mount();
    const t = answerTo(/Why does an application have a Stage, a Status, AND a Screening Status/);
    for (const stage of ['Applied and Screened', 'Assignment Round', 'Founders Round', 'Pre-Joining Documents', 'Offer Discussion', 'Offer Released', 'Offer Accepted', 'Joined']) expect(t).toContain(stage);
    expect(t).toMatch(/starts as New and nothing in the screens changes it today/);
    expect(t).not.toMatch(/HR's own internal screening progress/);
  });

  it('over budget: measured against the top of the band, with the reasons and the cases where nothing is asked', () => {
    mount();
    const t = answerTo('Why was I asked for a reason before shortlisting a candidate?');
    expect(t).toMatch(/15% or more above the top of the band/);
    expect(t).toMatch(/Exceptional \/ rare skillset, Business-critical urgency to fill role, Candidate open to negotiate at offer stage, Leadership-approved exception, or Other/);
    expect(t).toMatch(/If the band or the expected CTC isn't recorded, no reason is asked for/);
  });

  it('Active Candidates: Rejected and Withdrawn never show there, and the unmatched rule is an exact title', () => {
    mount();
    const t = answerTo(/What is Active Candidates/);
    expect(t).toMatch(/they never show here, even if you pick them in the Status filter/);
    expect(t).toMatch(/did not match exactly one role that isn't closed/);
    expect(t).toMatch(/ignoring capital letters, extra spaces and the kind of dash/);
    expect(t).toMatch(/The banner is hidden while a Role filter is set/);
  });

  it('Dashboard: no longer says "in three parts", and says the Joined bar stays at 0 and where the LinkedIn bar comes from', () => {
    mount();
    const t = answerTo('What am I looking at on the Dashboard?');
    expect(t).not.toMatch(/in three parts/);
    expect(t).toMatch(/hires are not counted in it, so the Joined bar stays at 0/);
    expect(t).toMatch(/everyone who applied through the Job Application Form is recorded as LinkedIn/);
  });

  it('Archived Pipeline: Reactivate starts a new application on a Live – Sourcing role, and Skills and Industry find nobody', () => {
    mount();
    const t = answerTo('What is Archived Pipeline for?');
    expect(t).toMatch(/it offers Live – Sourcing roles they haven't applied to and starts a new application at Applied and Screened, scored by ResumeIQ/);
    expect(t).toMatch(/the Skills and Industry boxes match profile data that nothing fills today/);
  });

  it('Agencies: the page is a repository with two counts, and the Add agency button does nothing yet', () => {
    mount();
    const t = answerTo(/What is the Agencies page/);
    expect(t).toMatch(/The Agency Repository holds each recruitment agency's contact/);
    expect(t).toMatch(/hired \(candidates the agency sourced who reached Offer Accepted or Joined, counted once per candidate\)/);
    expect(t).toMatch(/The Add agency button doesn't open anything yet/);
    expect(t).not.toMatch(/the candidates they've submitted/);
  });

  it('Screening notes: a Hiring Manager cannot open the panel but can read the Recruiter Summary', () => {
    mount();
    const t = answerTo(/Why don't I see Screening & Risk Notes/);
    expect(t).toMatch(/Hiring Managers can't open this panel, but the Recruiter Summary text is shown to them on the application/);
  });

  it('scheduling: who can, what is required, India time and the candidate invited only with an email on file', () => {
    mount();
    const t = answerTo('What happens when I schedule an interview round?');
    expect(t).toMatch(/at least one interviewer email and a date and time \(India time\) are required/);
    expect(t).toMatch(/the candidate \(only if they have an email on file\)/);
  });

  it('rejection e-mail: off by default, and a missing address or failed send still rejects the candidate', () => {
    mount();
    const t = answerTo('Does rejecting a candidate notify them?');
    expect(t).toMatch(/the box is off by default/);
    expect(t).toMatch(/If the candidate has no email address on file, or the send fails, they are still rejected and a warning shows on their application/);
  });
});

describe('Help — AI automation answers that were wrong or incomplete', () => {
  beforeEach(() => answers({ data: { enabled: false } }));

  it('generated JDs: a manual JD role generates nothing on approval, and the failure path and its side effects are stated', () => {
    mount();
    const t = answerTo('Where do generated job descriptions come from?');
    expect(t).toMatch(/Approving such a role doesn't generate anything, and neither JD can be refreshed from the role page/);
    expect(t).not.toMatch(/social JD is still auto-generated/);
    expect(t).toMatch(/A failure message appears when you approve with Change status, but not when you use the Approve Role button/);
    expect(t).toMatch(/that records you as the approver and sets the Approval Date and Open Date to today/);
    expect(t).not.toMatch(/2-page PDF/);
  });

  it('ResumeIQ: which files it reads, what happens when one cannot be read, and the all-zero score that Retry scoring does not offer', () => {
    mount();
    const t = answerTo('What is ResumeIQ, and when does it run?');
    expect(t).toMatch(/PDF, Word \.docx or Google Docs, up to 20 MB, and the first 40 pages of a PDF/);
    expect(t).toMatch(/the candidate's page shows a "No resume read" tag/);
    expect(t).toMatch(/0 in every dimension together with the red flag "AI scoring returned invalid output — retry needed"/);
    expect(t).toMatch(/Retry scoring doesn't list these, so tell whoever maintains HMS/);
  });

  it('the AI answer: people decide, the gender tag is never given to an AI review, and the redaction is not a guarantee', () => {
    mount();
    const t = answerTo('What does the AI see about a candidate, and who makes the decision?');
    expect(t).toMatch(/People make every decision: nothing in HMS moves, rejects or hires a candidate because of an AI score/);
    expect(t).toMatch(/The gender tag shown on candidate lists is never given to any AI review/);
    expect(t).toMatch(/it can't guarantee that/);
  });

  it('Assignment emails: who sends from where, what is filled in, and the retry button', () => {
    mount();
    const t = answerTo('How do Assignment emails get sent?');
    expect(t).toMatch(/HR\/Admin, Leadership and Super Admin send an assignment from the candidate's page/);
    expect(t).toMatch(/filled in from the role's Assignment Link when it has one/);
    expect(t).toMatch(/a Send assignment button on the round retries it with what you entered/);
  });

  it('e-mails: the sourcing notes go to HR/Admin and Super Admin and to the configured addresses, and are off until switched on', () => {
    mount();
    const t = answerTo('What e-mails does HMS send?');
    expect(t).toMatch(/they are off by default, and there is no screen for this yet/);
    expect(t).toMatch(/HR\/Admin and Super Admin users get one daily sourcing note/);
    expect(t).toMatch(/the company addresses set up for it get a Monday summary/);
    expect(t).not.toMatch(/configured leadership addresses/);
  });
});

describe('Help — access answers that were wrong, stale or misleading', () => {
  beforeEach(() => answers({ data: { enabled: false } }));

  it('personas: no Interviewer history, the Hiring Manager gets the role request and the "First Last" rule, Leadership has no Sourcing box', () => {
    mount();
    const t = answerTo('What can each role/persona do?');
    expect(t).not.toMatch(/Interviewer, was merged/);
    expect(t).toMatch(/There are four personas\. Interview feedback isn't tied to a persona/);
    expect(t).toMatch(/Write each name as First Last: a comma always separates two people/);
    expect(t).toMatch(/request a new role with the Request role button on the Roles page/);
    expect(t).toMatch(/there is no Sourcing box, so Leadership works sourcing plans from the Sourcing page and the Dashboard/);
    expect(t).toMatch(/Leadership and the Super Admin — but not HR\/Admin — may also change its thresholds and e-mail settings; there is no screen for this yet/);
  });

  it('a Hiring Manager sees candidate compensation on their own roles but never the role\'s own CTC band', () => {
    mount();
    const personas = answerTo('What can each role/persona do?');
    expect(personas).toMatch(/also see the compensation of that role's candidates and applications \(current and expected CTC\)/);
    expect(personas).toMatch(/The role's own CTC band field, Salary Range column and Run benchmark panel stay HR\/Admin, Leadership and Super Admin only/);
    const comp = answerTo('Who can see compensation details, exactly?');
    expect(comp).toMatch(/a Hiring Manager doesn't see them even on their own role/);
    // the one place the band still reaches a role's own Hiring Manager is that role's activity timeline: the answer says so
    expect(comp).toMatch(/one exception: when a role's band is edited, that role's activity timeline lists the edit with its old and new values, and the role's own Hiring Manager can read them there/);
    expect(comp).not.toMatch(/Nobody else sees any of it, anywhere in the system/);
    // the first version listed fields no screen shows, and said a Hiring Manager saw the band "the same as HR"
    expect(comp).not.toMatch(/agency fee estimates/);
  });
});

describe('Help — questions added after the October 2026 audit', () => {
  beforeEach(() => answers({ data: { enabled: false } }));

  it('sign-in: Google company account, added and active in HMS, and the message that points at HR when only the Super Admin can add accounts', () => {
    mount();
    const t = answerTo('I can\'t sign in — what do I do?');
    expect(t).toMatch(/Sign in with Google using your @digitalpaani\.com account; any other Google account is refused/);
    expect(t).toMatch(/ask the Super Admin to add you or restore your access in User Management/);
    expect(t).toMatch(/only the Super Admin can add accounts/);
  });

  it('Founder star: who can set it, what it creates, and that it changes neither stage nor status', () => {
    mount();
    const t = answerTo('What is the Founder star on an application, and who sets it?');
    expect(t).toMatch(/HR\/Admin, Leadership and Super Admin can flag an application/);
    expect(t).toMatch(/creates an open Founder Review item for Leadership/);
    expect(t).toMatch(/Flagging does not change the stage or status/);
    expect(t).toMatch(/Hiring Managers can see that a candidate is flagged but can't set or clear the flag/);
  });

  it('Add candidate: what is required, that a duplicate email is refused, and that only Live – Sourcing roles are offered', () => {
    mount();
    const t = answerTo('How do I add a candidate myself, or put an existing candidate on another role?');
    // the form really leaves three fields optional: LinkedIn URL, designation and Source (the first rewrite said only Source)
    expect(t).toMatch(/Everything on the form is required except LinkedIn URL, designation and Source/);
    expect(t).toMatch(/An email that is already in HMS is refused, and the message names the existing candidate/);
    expect(t).toMatch(/offer only Live – Sourcing roles/);
    expect(t).toMatch(/an Approved role isn't offered until then/);
  });

  it('candidate page: what is where, and that the pencil is shown to everyone but saving is HR/Admin, Leadership and Super Admin only', () => {
    mount();
    const t = answerTo('What is on a candidate\'s page?');
    expect(t).toMatch(/only HR\/Admin, Leadership and Super Admin can save changes — for anyone else the save is refused/);
    expect(t).toMatch(/The Activity timeline at the bottom logs every change/);
  });

  it('intake: Requisition Form creates a Draft once, the form creates the candidate and application, and a role that does not match exactly one role waits as unmatched', () => {
    mount();
    const t = answerTo('How do roles and candidates get into HMS?');
    expect(t).toMatch(/a Requisition Form submission creates a Draft role automatically, and the same submission sent twice never creates a second role/);
    expect(t).toMatch(/A second submission for the same role is skipped/);
    expect(t).toMatch(/doesn't match exactly one role that isn't closed, the candidate waits under Unmatched Candidates/);
  });

  it('requesting a role: the Hiring Manager enters no CTC band, HR is not notified, and a Hiring Manager cannot approve', () => {
    mount();
    const t = answerTo('How does a Hiring Manager request a role?');
    expect(t).toMatch(/except that a Hiring Manager doesn't enter the CTC band/);
    expect(t).toMatch(/HMS doesn't send HR a message about it/);
    expect(t).toMatch(/can't approve a role — not even their own/);
  });

  it('stage moves: the three checks that stop a move, and that offer letters and a pre-joining checklist are not in HMS', () => {
    mount();
    const t = answerTo('Why can\'t I move a candidate to another stage, and what do the later stages mean?');
    expect(t).toMatch(/Every interview or assignment round already created for the application must have its feedback submitted/);
    expect(t).toMatch(/A candidate leaving Reference Check needs at least one reference check on file/);
    expect(t).toMatch(/needs an over-budget reason/);
    expect(t).toMatch(/HMS doesn't generate offer letters or a pre-joining document checklist/);
  });

  it('interview feedback: what to fill in, who can submit, and a round with no interviewer listed is open to anyone', () => {
    mount();
    const t = answerTo('How do I submit interview feedback, and who can?');
    expect(t).toMatch(/score each from 1 to 5/);
    expect(t).toMatch(/HR\/Admin, Leadership and Super Admin can submit for any round/);
    expect(t).toMatch(/a round with no interviewer listed is open to anyone/);
  });

  it('assignment round: the 60-hour deadline, Record submission by hand, the five weighted areas, and that a Rejected outcome does not reject', () => {
    mount();
    const t = answerTo('How does an Assignment round work, from sending to outcome?');
    expect(t).toMatch(/The 60-hour submission deadline starts when the email goes out/);
    expect(t).toMatch(/HMS can't see the candidate's reply/);
    expect(t).toMatch(/Technical Accuracy \(40%\), Problem Solving \(25%\), Clarity & Structure \(15%\), Practical Thinking \(10%\) and Completeness \(10%\)/);
    expect(t).toMatch(/An outcome of Rejected does not reject the candidate/);
  });

  it('the pending-items glossary names every item and says the HM shortlist review is a heads-up that nothing completes', () => {
    mount();
    const t = answerTo('What do the items in Other Pending Actions and Leadership Alerts mean?');
    for (const item of ['Resume Shortlist Pending', 'HM shortlist review', 'Assignment Not Sent', 'Assignment deadline breached', 'Idle Candidate', 'Joining risk — no contact', 'Founder Review', 'Role aging alert', 'Compensation change flag', 'Feedback Overdue — Leadership Escalation']) expect(t).toContain(item);
    expect(t).toMatch(/nothing in the screens completes it, and it clears by itself when the candidate's stage or status next changes/);
  });
});

describe('Help — wording rules for the whole page', () => {
  it('no answer uses the internal word "HR-tier" or a database name', async () => {
    answers({ data: { enabled: true } });
    mount();
    await screen.findByText(SOURCING_TITLE);
    const questions = screen.getAllByRole('button').filter(b => b.querySelector('svg') && b.textContent);
    for (const q of questions) fireEvent.click(q);
    const everything = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(everything).not.toMatch(/HR-tier/);
    // a snake_case word is a database column or a code constant (sla_breach, hiring_manager_name, ...), never user wording
    expect(everything).not.toMatch(/\b[a-z]{2,}_[a-z_]+\b/);
  });
});
