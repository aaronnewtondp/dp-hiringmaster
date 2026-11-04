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
import {
  STAGES, ROLE_STATUSES, APPLICATION_STATUSES, PERSONAS, OVER_BUDGET_SHORTLIST_REASONS,
  LOW_PIPELINE_MAX_SHORTLISTED, LOW_PIPELINE_MAX_ACTIVE,
} from '../types/index.ts';
import { OVER_BUDGET_TOLERANCE, isOverBudget, isSeverelyOverBudget, isWithinBudgetOrNear } from '../utils/budget.ts';
import { SLA_STAGE_BUCKETS } from '../utils/slaStageBuckets.ts';

// The frontend is a browser package and has no @types/node. These three built-ins are used only to READ source files as text (see the
// last part of this file), so they are left untyped instead of adding a dependency.
// @ts-ignore TS2307 until @types/node is added to the frontend
import fs from 'node:fs';
// @ts-ignore TS2307 until @types/node is added to the frontend
import path from 'node:path';
// @ts-ignore TS2307 until @types/node is added to the frontend
import { fileURLToPath } from 'node:url';

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
    expect(t).toMatch(/The first task of each channel is counted from the day the plan is activated \(for a channel added later, from the day it was added\), in India time, and falls due in working days \(Monday to Friday\): 1 working day for LinkedIn, Naukri\/IIMjobs and Internal Referral, 2 for Agency and Direct Outreach/);
    // a channel added to a running plan starts from the day it was added, and follow-ups from the previous task: "from the day the plan is activated" was not true of them
    expect(t).not.toMatch(/Due dates are counted from the day the plan is activated/);
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

  it('stage, status and screening status: the screening status is only a label that starts as New', () => {
    mount();
    const t = answerTo(/Why does an application have a Stage, a Status, AND a Screening Status/);
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

  it('Active Candidates: only the top 100 are loaded with no next page, In-budget only cannot reach past them, and Fit is Average Score times ten', () => {
    mount();
    const t = answerTo(/What is Active Candidates/);
    expect(t).toMatch(/the 100 highest-scoring applications first \(highest ResumeIQ score at the top\)\. There is no next page/);
    // the server applies every filter except In-budget only, which narrows the 100 already loaded in the browser
    expect(t).toMatch(/the filters \(Stage, Status, Department, Location, Recruitment Mode, Priority, Role, Gender and SLA breached only\) to reach the others; they look beyond the 100 shown\. In-budget only just narrows the 100 already on screen/);
    expect(t).not.toMatch(/up to 100 at a time/);
    expect(t).not.toMatch(/SLA breached only and In-budget only/);
    // the two columns are one score on two scales, not "the same number"
    expect(t).toMatch(/the same score as Average Score in Ready for review, ten times larger \(a Fit of 74 is an Average Score of 7\.4\)/);
    expect(t).not.toMatch(/the same number as Average Score/);
  });

  it('Dashboard: the red ! means no movement in MORE than 3 days, and the chart sentence names HR/Admin like the rest of the page', () => {
    mount();
    const t = answerTo('What am I looking at on the Dashboard?');
    expect(t).toMatch(/has had any real movement — a stage or status change, feedback — in more than 3 days/);
    expect(t).not.toMatch(/3\+ days/);
    expect(t).toMatch(/it always counts both HR\/Admin and Hiring Manager breaches/);
    expect(t).toMatch(/filterable by owner \(HR\/Admin or Hiring Manager\)/);
    expect(t).not.toMatch(/HR\/Recruiter|both HR and Hiring Manager/);
  });

  it('Dashboard: no longer says "in three parts", and says the Joined bar stays at 0 and where the LinkedIn bar comes from (a new form candidate, not everyone)', () => {
    mount();
    const t = answerTo('What am I looking at on the Dashboard?');
    expect(t).not.toMatch(/in three parts/);
    expect(t).toMatch(/hires are not counted in it, so the Joined bar stays at 0/);
    expect(t).toMatch(/a candidate created by the Job Application Form is recorded with the Source LinkedIn \(someone already in HMS keeps the Source they have\), so that bar holds most form applicants/);
    // a candidate already in HMS with another Source keeps it, so the LinkedIn bar does not hold EVERY form applicant
    expect(t).not.toMatch(/includes all form applicants/);
  });

  it('Archived Pipeline: Reactivate starts a new application on a Live – Sourcing role, and Skills and Industry find nobody', () => {
    mount();
    const t = answerTo('What is Archived Pipeline for?');
    expect(t).toMatch(/it offers Live – Sourcing roles they haven't applied to and starts a new application at Applied and Screened, scored by ResumeIQ/);
    expect(t).toMatch(/the Skills and Industry boxes match profile data that nothing fills today/);
  });

  it('Agencies: the list shows hires, an agency\'s own page shows submitted and hired, and the Add agency button does nothing yet', () => {
    mount();
    const t = answerTo(/What is the Agencies page/);
    expect(t).toMatch(/The Agency Repository holds each recruitment agency's contact/);
    // the list shows only the hires column; the submitted and hired counts together are on an agency's own page
    expect(t).toMatch(/The list shows each agency's hires; open an agency to see two counts, submitted \(/);
    expect(t).toMatch(/hired \(candidates the agency sourced who reached Offer Accepted or Joined, counted once per candidate — the same number as Hires in the list\)/);
    expect(t).not.toMatch(/Each agency also shows two counts/);
    expect(t).toMatch(/The Add agency button doesn't open anything yet/);
    expect(t).not.toMatch(/the candidates they've submitted/);
  });

  it('Screening notes: a Hiring Manager cannot open the panel but can read the Recruiter Summary', () => {
    mount();
    const t = answerTo(/Why don't I see Screening & Risk Notes/);
    expect(t).toMatch(/Hiring Managers can't open this panel, but the Recruiter Summary text is shown to them on the application/);
  });

  it('User Management: the roles on offer exclude Super Admin, the Super Admin\'s own row has no buttons, and sign-in needs an account added here', () => {
    mount();
    const t = answerTo(/What is User Management/);
    expect(t).toMatch(/the roles on offer are HR\/Admin, Hiring Manager and Leadership/);
    // the Super Admin's own row has no buttons at all, only a dash: the screen never offers a disabled button for it
    expect(t).toMatch(/Every account except the Super Admin's own has Edit and Deactivate \/ Reactivate buttons \(the Super Admin's own row shows only a dash, so its role and access can't be changed here\)/);
    expect(t).not.toMatch(/Each account has Edit and Deactivate/);
    expect(t).toMatch(/A person can sign in only with a company Google account that has been added here and is active/);
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

  it('the glossary says where Leadership Alerts are counted: not for HR/Admin and Super Admin, but yes for a Leadership user with no role of their own', () => {
    mount();
    const t = answerTo('What do the items in Other Pending Actions and Leadership Alerts mean?');
    expect(t).toMatch(/Leadership Alerts are notices of three kinds: Role aging alert/);
    expect(t).toMatch(/For HR\/Admin and Super Admin, and for a Leadership user who is also a role's Hiring Manager, they appear in their own Leadership Alerts panel and are not counted in Other Pending Actions/);
    expect(t).toMatch(/A Leadership user who is nobody's Hiring Manager has Leadership Alerts as the whole third box, and its count includes them/);
    // "shown but not counted" was said of every persona, and is false for Leadership's own box
    expect(t).not.toMatch(/Leadership Alerts are shown but not counted/);
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

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Everything above pins what the Help page SAYS. What follows pins it to the code that DECIDES each figure or rule, so a
// later change to a threshold, a limit or a list fails here instead of leaving Help quietly out of date (which is how the
// page drifted in the first place). Figures the frontend already exports are imported; figures that only exist in the
// backend (or in a screen's own literal) are READ AS TEXT from the source file, in the style of the backend's
// crossPackageTwins.test.ts. Every reader throws when it cannot find what it looks for, so a check can never pass by
// comparing nothing.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
function source(rel: string): string {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error(`${rel} is missing: these checks compare the Help page with the code that decides each figure, so they need the whole repository checked out.`);
  return fs.readFileSync(file, 'utf8');
}
/** The capture groups of the first match of `re` in a source file. */
function grab(rel: string, re: RegExp): string[] {
  const m = re.exec(source(rel));
  if (!m) throw new Error(`${rel}: nothing matches ${re}. The code this check reads has moved or changed shape: update the check, do not drop it.`);
  return m.slice(1);
}
function arithmetic(expr: string, where: string): number {
  if (!/^[\d_.\s*/+()-]+$/.test(expr)) throw new Error(`${where}: "${expr}" is not plain arithmetic, so this check cannot read it`);
  return Function(`"use strict"; return (${expr.replace(/_/g, '')});`)() as number;
}
/** `const NAME = <number or plain arithmetic>;` anywhere in a source file (exported or not). */
const constant = (rel: string, name: string): number =>
  arithmetic(grab(rel, new RegExp(`\\bconst ${name}\\b[^=\\n]*=\\s*([^;\\n]+?)\\s*;`))[0], `${rel} ${name}`);
const numberIn = (rel: string, re: RegExp): number => Number(grab(rel, re)[0]);
const quotedList = (text: string): string[] => [...text.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]);
const BACKEND = {
  types:     'backend/src/types/index.ts',
  sla:       'backend/src/jobs/slaChecker.ts',
  interviews: 'backend/src/routes/interviews.ts',
  dashboard: 'backend/src/routes/dashboard.ts',
  resume:    'backend/src/services/pdfSandbox/resume.ts',
  advisor:   'backend/src/services/sourcingAdvisor.ts',
  config:    'backend/src/utils/sourcingConfig.ts',
  templates: 'backend/src/utils/sourcingTemplates.ts',
  plans:     'backend/src/services/sourcingPlans.ts',
  settings:  'backend/src/services/sourcingSettings.ts',
  qualified: 'backend/src/utils/sourcingQualified.ts',
} as const;

/** The number a sentence of an answer quotes (first capture group); fails if the sentence is gone. */
function said(answer: string, re: RegExp): number {
  const m = re.exec(answer);
  expect(m, `the answer no longer says ${re}`).not.toBeNull();
  return Number(m![1]);
}
/** Every number the sentences matching a global regex quote (first capture group). */
const saidEverywhere = (answer: string, re: RegExp): number[] => [...answer.matchAll(re)].map(m => Number(m[1]));
const inWords = (list: readonly string[]): string => `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;

describe('Help — the names and figures in the answers are the ones the screens use', () => {
  beforeEach(() => answers({ data: { enabled: false } }));
  const WORD: Record<number, string> = { 4: 'four', 5: 'five' };

  it('names every pipeline stage in STAGES, in pipeline order', () => {
    mount();
    const t = answerTo(/Why does an application have a Stage, a Status, AND a Screening Status/);
    const bullet = t.slice(t.indexOf('Stage —'), t.indexOf('Status —'));
    for (const stage of STAGES) expect(bullet, stage).toContain(stage);
    const at = STAGES.map(stage => bullet.indexOf(stage));
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('names every status a person can set (all but the unused "Closed") and every role status, in order', () => {
    mount();
    const t = answerTo(/Why does an application have a Stage, a Status, AND a Screening Status/);
    const bullet = t.slice(t.indexOf('Status —'), t.indexOf('Recruiter Screening Status'));
    // 'Closed' is allowed by the database and listed by the Status filter, but nothing in HMS ever sets it
    for (const status of APPLICATION_STATUSES.filter(s => s !== 'Closed')) expect(bullet, status).toContain(status);
    const roles = answerTo(/What do the role statuses mean/);
    for (const status of ROLE_STATUSES) expect(roles, status).toContain(status);
    const at = ROLE_STATUSES.map(status => roles.indexOf(status));
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('says there are as many personas as the app has, and names each by the label the screens show', () => {
    mount();
    const t = answerTo('What can each role/persona do?');
    const n = Object.keys(PERSONAS).length;
    expect(WORD[n], `add the word for ${n} personas to this test`).toBeDefined();
    expect(t).toContain(`There are ${WORD[n]} personas`);
    for (const label of Object.values(PERSONAS)) expect(t, label).toContain(label);
  });

  it('lists the over-budget reasons exactly as the reason picker offers them', () => {
    mount();
    const t = answerTo('Why was I asked for a reason before shortlisting a candidate?');
    const reasons = [...OVER_BUDGET_SHORTLIST_REASONS];
    expect(t).toContain(`The choices are ${reasons.slice(0, -1).join(', ')}, or ${reasons[reasons.length - 1]}`);
  });

  it('quotes the over-budget tolerance in every answer that mentions it, and describes the rules the budget helpers apply', () => {
    mount();
    const pct = Math.round((OVER_BUDGET_TOLERANCE - 1) * 100);
    const asked = answerTo('Why was I asked for a reason before shortlisting a candidate?');
    const moves = answerTo(/Why can't I move a candidate to another stage/);
    const scorecard = answerTo(/What is My Tasks, and what is the Scorecard Summary table/i);
    for (const [name, text] of Object.entries({ asked, moves, scorecard })) {
      const found = saidEverywhere(text, /(\d+)% (?:or more )?above the top of the (?:role's )?band/g);
      expect(found.length, `${name} no longer quotes the tolerance`).toBeGreaterThan(0);
      expect(found, name).toEqual(found.map(() => pct));
    }
    // "15% or more above the top of the band" asks for a reason; "more than 15% above" is what In-budget only hides; "above the top" is the red badge
    const band = '10-20 LPA', top = 20, edge = top * OVER_BUDGET_TOLERANCE;
    expect(asked).toMatch(/is above the top of the role's stated compensation band gets a red Over Budget badge/);
    expect(isOverBudget(top + 0.01, band)).toBe(true);
    expect(isOverBudget(top, band)).toBe(false);
    expect(asked).toMatch(/If it is 15% or more above the top of the band/);
    expect(isSeverelyOverBudget(edge, band)).toBe(true);
    expect(isSeverelyOverBudget(edge - 0.01, band)).toBe(false);
    expect(asked).toMatch(/The In-budget only filter hides only candidates more than 15% above the top of the band/);
    expect(isWithinBudgetOrNear(edge, band)).toBe(true);
    expect(isWithinBudgetOrNear(edge + 0.01, band)).toBe(false);
    expect(asked).toMatch(/If the band or the expected CTC isn't recorded, no reason is asked for/);
    for (const [expected, ctcBand] of [[null, band], [edge * 2, null], [null, null]] as const) {
      expect(isSeverelyOverBudget(expected, ctcBand)).toBe(false);
      expect(isWithinBudgetOrNear(expected, ctcBand)).toBe(true);
    }
  });

  it('quotes the Low Pipeline Roles limits from the constants the Dashboard uses', () => {
    mount();
    const t = answerTo('What am I looking at on the Dashboard?');
    expect(t).toContain(`fewer than ${LOW_PIPELINE_MAX_SHORTLISTED} shortlisted candidates and fewer than ${LOW_PIPELINE_MAX_ACTIVE} active candidates`);
  });

  it('describes the SLA-by-role chart as the funnel steps SLA_STAGE_BUCKETS defines', () => {
    mount();
    const t = answerTo('What am I looking at on the Dashboard?');
    expect(WORD[SLA_STAGE_BUCKETS.length], `add the word for ${SLA_STAGE_BUCKETS.length} steps to this test`).toBeDefined();
    expect(t).toContain(`${WORD[SLA_STAGE_BUCKETS.length]} steps, from ${SLA_STAGE_BUCKETS[0].label} through ${SLA_STAGE_BUCKETS[SLA_STAGE_BUCKETS.length - 1].label}`);
  });

  it('names the eight ResumeIQ dimensions as the Scorecard Summary columns', () => {
    const block = grab('frontend/src/pages/ScorecardSummary.tsx', /const DIMENSIONS[^=]*=\s*\[([\s\S]*?)\n\];/)[0];
    const labels = [...block.matchAll(/label: '([^']+)'/g)].map(m => m[1]);
    expect(labels.length).toBeGreaterThan(0);
    mount();
    const t = answerTo('What is ResumeIQ, and when does it run?');
    expect(t).toContain(`It scores ${labels.length} dimensions — ${labels.join(', ')} —`);
  });

  it('says Active Candidates loads 100 applications and Ready for review up to 500, as the screens request them', () => {
    const active = numberIn('frontend/src/pages/Candidates.tsx', /const params: Record<string, string \| string\[\]> = \{ limit: '(\d+)'/);
    const ready = numberIn('frontend/src/pages/ScorecardSummary.tsx', /limit: '(\d+)', scored_only: 'true'/);
    mount();
    expect(said(answerTo(/What is Active Candidates/), /the (\d+) highest-scoring applications/)).toBe(active);
    expect(said(answerTo(/What is My Tasks, and what is the Scorecard Summary table/i), /Ready for review is separate and shows up to (\d+) candidates/)).toBe(ready);
  });
});

describe('Help — the figures the backend decides are the ones the backend uses', () => {
  beforeEach(() => answers({ data: { enabled: false } }));

  it('the aging days per priority are AGING_THRESHOLDS', () => {
    const block = grab(BACKEND.types, /export const AGING_THRESHOLDS[^=]*=\s*\{([\s\S]*?)\};/)[0];
    const table: Record<string, number[]> = {};
    for (const m of block.matchAll(/(P\d):\s*\{\s*yellow:\s*(\d+),\s*red:\s*(\d+)\s*\}/g)) table[m[1]] = [Number(m[2]), Number(m[3])];
    expect(Object.keys(table)).toEqual(['P0', 'P1', 'P2', 'P3']);
    mount();
    const t = answerTo(/What do the role statuses mean/);
    for (const [priority, days] of Object.entries(table)) {
      const m = new RegExp(`${priority} after (\\d+) and (\\d+)`).exec(t);
      expect(m, `${priority} is missing from the answer`).not.toBeNull();
      expect([Number(m![1]), Number(m![2])], priority).toEqual(days);
    }
  });

  it('the SLA windows are the slaChecker hours: 48h standard, 24h from fit 75, 48h idle, 96h assignment feedback, 96h before the Leadership escalation', () => {
    const standard = constant(BACKEND.sla, 'BREACH_STANDARD_HOURS'), high = constant(BACKEND.sla, 'BREACH_HIGH_SCORE_HOURS');
    const threshold = constant(BACKEND.sla, 'HIGH_SCORE_THRESHOLD'), idle = constant(BACKEND.sla, 'BREACH_IDLE_HOURS');
    const assignmentFeedback = constant(BACKEND.sla, 'BREACH_ASSIGNMENT_FEEDBACK_HOURS'), escalation = constant(BACKEND.sla, 'LEADERSHIP_ESCALATION_HOURS');
    // the window is chosen by "fit score >= HIGH_SCORE_THRESHOLD", so "75+" is right and "above 75" would not be
    grab(BACKEND.sla, /aiFitScore >= HIGH_SCORE_THRESHOLD \? BREACH_HIGH_SCORE_HOURS : BREACH_STANDARD_HOURS/);
    mount();
    const t = answerTo('What triggers a "pending action" or an "SLA breach"?');
    expect(said(t, /Idle Candidate \((\d+)h\+ at/)).toBe(idle);
    expect(said(t, /ResumeIQ fit score (\d+)\+\) gets a tighter \d+h window/)).toBe(threshold);
    expect(said(t, /gets a tighter (\d+)h window instead of the standard/)).toBe(high);
    expect(said(t, /instead of the standard (\d+)h/)).toBe(standard);
    expect(said(t, /Assignment Feedback Due \((\d+)h\) are untouched/)).toBe(assignmentFeedback);
    expect(said(t, /still open (\d+)h after the interview/)).toBe(escalation);
    const ai = answerTo('What does the AI see about a candidate, and who makes the decision?');
    expect(said(ai, /a ResumeIQ fit of (\d+) or more gives a tighter \d+-hour window/)).toBe(threshold);
    expect(said(ai, /a ResumeIQ fit of \d+ or more gives a tighter (\d+)-hour window/)).toBe(high);
  });

  it('Idle Candidate covers the stages the checker lists, after the hours it waits', () => {
    const idle = constant(BACKEND.sla, 'BREACH_IDLE_HOURS');
    const stages = quotedList(grab(BACKEND.sla, /stages: \[([^\]]+)\], actionType: 'Idle Candidate'/)[0]);
    expect(stages.length).toBeGreaterThan(0);
    mount();
    const sla = answerTo('What triggers a "pending action" or an "SLA breach"?');
    expect(sla).toContain(`(${idle}h+ at ${stages.slice(0, -1).join(', ')} or ${stages[stages.length - 1]})`);
    const glossary = answerTo('What do the items in Other Pending Actions and Leadership Alerts mean?');
    expect(glossary).toContain(`Idle Candidate — no movement for ${idle} hours at ${stages.slice(0, -1).join(', ')} or ${stages[stages.length - 1]}`);
  });

  it('the assignment deadline is the 60 hours the send route stores, and the breach is raised from that stored deadline', () => {
    const hours = arithmetic(grab(BACKEND.interviews, /const deadline = new Date\(Date\.now\(\) \+ ([\d\s*]+)\);/)[0], 'assignment deadline') / 3_600_000;
    grab(BACKEND.sla, /ir\.assignment_deadline < NOW\(\)/);
    mount();
    const sla = answerTo('What triggers a "pending action" or an "SLA breach"?');
    expect(said(sla, /within (\d+)h of the assignment being sent/)).toBe(hours);
    const glossary = answerTo('What do the items in Other Pending Actions and Leadership Alerts mean?');
    expect(said(glossary, /Assignment deadline breached — no submission recorded within (\d+) hours of sending/)).toBe(hours);
    const round = answerTo('How does an Assignment round work, from sending to outcome?');
    expect(said(round, /The (\d+)-hour submission deadline starts when the email goes out/)).toBe(hours);
    expect(said(round, /Assignment deadline breached is raised once (\d+) hours have passed/)).toBe(hours);
  });

  it('automatic advance needs a score above 2.5 for both an interview and an assignment, as the feedback route checks', () => {
    const interview = numberIn(BACKEND.interviews, /overall_round_score != null && overall_round_score > ([\d.]+)/);
    const assignment = numberIn(BACKEND.interviews, /assignment_overall_score != null && assignment_overall_score > ([\d.]+)/);
    expect(interview).toBe(assignment);
    mount();
    const t = answerTo('Can a candidate move to the next stage automatically?');
    expect(said(t, /with an average score above ([\d.]+) out of 5/)).toBe(interview);
    expect(said(t, /with a weighted score above ([\d.]+) out of 5/)).toBe(assignment);
  });

  it('the assignment score areas carry the weights the route multiplies them by', () => {
    const w = grab(BACKEND.interviews, /score_technical_accuracy \* ([\d.]+) \+ score_problem_solving \* ([\d.]+) \+\s*score_clarity \* ([\d.]+) \+ score_practical_thinking \* ([\d.]+) \+ score_completeness \* ([\d.]+)/).map(x => Math.round(Number(x) * 100));
    mount();
    const t = answerTo('How does an Assignment round work, from sending to outcome?');
    const m = /Technical Accuracy \((\d+)%\), Problem Solving \((\d+)%\), Clarity & Structure \((\d+)%\), Practical Thinking \((\d+)%\) and Completeness \((\d+)%\)/.exec(t);
    expect(m, 'the weights sentence is gone').not.toBeNull();
    expect(m!.slice(1).map(Number)).toEqual(w);
    expect(w.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('the red ! on the Dashboard means no movement for MORE than NO_MOVEMENT_DAYS, as the comparison is written', () => {
    const days = constant(BACKEND.dashboard, 'NO_MOVEMENT_DAYS');
    grab(BACKEND.dashboard, /getTime\(\)\) > NO_MOVEMENT_DAYS \* 86400000/);   // strictly greater: "3+ days" would be wrong
    mount();
    expect(said(answerTo('What am I looking at on the Dashboard?'), /in more than (\d+) days/)).toBe(days);
  });

  it('My Tasks lists share one window of the size the pending query returns', () => {
    const window = numberIn(BACKEND.dashboard, /ORDER BY pa\.priority_level DESC, pa\.created_at ASC LIMIT (\d+)/);
    mount();
    const t = answerTo(/What is My Tasks, and what is the Scorecard Summary table/i);
    expect(said(t, /one shared list of the (\d+) highest-priority/)).toBe(window);
    expect(said(t, /with a separate list of (\d+) for it/)).toBe(window);
  });

  it('ResumeIQ reads resumes up to RESUME_MAX_BYTES and the first RESUME_MAX_PAGES pages of a PDF', () => {
    const megabytes = constant(BACKEND.resume, 'RESUME_MAX_BYTES') / (1024 * 1024);
    const pages = constant(BACKEND.resume, 'RESUME_MAX_PAGES');
    mount();
    const t = answerTo('What is ResumeIQ, and when does it run?');
    expect(said(t, /up to (\d+) MB, and the first \d+ pages of a PDF/)).toBe(megabytes);
    expect(said(t, /up to \d+ MB, and the first (\d+) pages of a PDF/)).toBe(pages);
    expect(said(t, /a file over (\d+) MB — is not a failure/)).toBe(megabytes);
  });
});

describe('Help — the Sourcing figures are the ones the module uses', () => {
  beforeEach(() => answers({ data: { enabled: true } }));
  const mountReady = async () => { mount(); await screen.findByText(SOURCING_TITLE); };
  const DEFAULTS = (key: string) => numberIn(BACKEND.config, new RegExp(`\\b${key}: (\\d+),`));

  it('names the channels the plan can use, and the three that have a weekly tracker', async () => {
    const channels = quotedList(grab(BACKEND.config, /export const SOURCING_CHANNELS = \[([^\]]*)\]/)[0]);
    const tracked = quotedList(grab(BACKEND.config, /export const TRACKED_CHANNELS[^=]*=\s*\[([^\]]*)\]/)[0]);
    await mountReady();
    expect(answerTo('What is Sourcing execution, and where do I find it?')).toContain(`(${channels.join(', ')})`);
    expect(screen.getByRole('button', { name: `How does the weekly tracker work for ${inWords(tracked)}?` })).toBeInTheDocument();
  });

  it('due dates: 1 or 2 working days for the first task of each channel, as activationSpec sets them', async () => {
    const days = (channelBranch: RegExp) => numberIn(BACKEND.templates, channelBranch);
    const portal = days(/PORTAL_CHANNELS\.includes\(channel\)\) \{[\s\S]*?addWorkingDays\(activationDate, (\d+)/);
    const portals = quotedList(grab(BACKEND.config, /export const PORTAL_CHANNELS[^=]*=\s*\[([^\]]*)\]/)[0]);
    const code: Record<string, number> = {};
    for (const channel of portals) code[channel] = portal;
    code['Agency'] = days(/channel === 'Agency'\) \{[\s\S]*?addWorkingDays\(activationDate, (\d+)/);
    code['Internal Referral'] = days(/channel === 'Internal Referral'\) \{[\s\S]*?addWorkingDays\(activationDate, (\d+)/);
    code['Direct Outreach'] = days(/channel === 'Direct Outreach'\) \{[\s\S]*?addWorkingDays\(activationDate, (\d+)/);
    await mountReady();
    const t = answerTo('How are due dates worked out?');
    const m = /\(Monday to Friday\): (\d+) working days? for (.+?), (\d+) for (.+?)\. After that/.exec(t);
    expect(m, 'the first-task sentence is gone').not.toBeNull();
    const names = (list: string) => list.split(/, | and /);
    const quoted: Record<string, number> = {};
    for (const channel of names(m![2])) quoted[channel] = Number(m![1]);
    for (const channel of names(m![4])) quoted[channel] = Number(m![3]);
    expect(quoted).toEqual(code);
  });

  it('due dates: a portal posting stays live 30 days and renews 27 days after, agencies every 7 days and referrals every 14, as the settings and the follow-on formula say', async () => {
    const [linkedin, naukri] = grab(BACKEND.config, /portal_expiry_days: \{ 'LinkedIn': (\d+), 'Naukri\/IIMjobs': (\d+) \}/).map(Number);
    const lead = DEFAULTS('renew_lead_days');
    // the renewal falls due live − lead days after the posting, and after each renewal
    grab(BACKEND.templates, /addCalendarDays\(start, Math\.max\(1, live - lead\)\)/);
    grab(BACKEND.templates, /Math\.max\(1, cadenceDays - leadDays\)/);
    expect(linkedin).toBe(naukri);   // one sentence covers both portals
    await mountReady();
    const t = answerTo('How are due dates worked out?');
    const m = /stay live for (\d+) days, so its renewal falls due (\d+) days after the posting date and again (\d+) days after each renewal; agencies are followed up every (\d+) days and referrals reposted every (\d+) days/.exec(t);
    expect(m, 'the follow-up sentence is gone').not.toBeNull();
    expect(m!.slice(1).map(Number)).toEqual([linkedin, linkedin - lead, linkedin - lead, DEFAULTS('agency_followup_days'), DEFAULTS('referral_repost_days')]);
  });

  it('the qualified target: 1 to 500, default 5 for P0 and P1 only, over the last 7 days on each of the last 5 working days', async () => {
    const min = constant(BACKEND.config, 'MIN_QUALIFIED_TARGET'), max = constant(BACKEND.config, 'MAX_QUALIFIED_TARGET');
    grab(BACKEND.plans, /priority === 'P0' \|\| priority === 'P1' \? settings\.volume_min_qualified : null/);
    const [target, window, gap] = [DEFAULTS('volume_min_qualified'), DEFAULTS('volume_window_days'), DEFAULTS('volume_gap_working_days')];
    await mountReady();
    const t = answerTo('Can the qualified-candidate target differ by role?');
    expect(t).toContain(`(${min}–${max})`);
    expect(said(t, /default is (\d+) for P0 and P1 roles; a P2 or P3 role has no target/)).toBe(target);
    expect(said(t, /qualified in the last (\d+) days/)).toBe(window);
    const exception = answerTo(/What is an exception, and how do I resolve one/);
    expect(said(exception, /in the last (\d+) days on each of the last \d+ working days/)).toBe(window);
    expect(said(exception, /in the last \d+ days on each of the last (\d+) working days/)).toBe(gap);
  });

  it('resolving an exception: a catch-up date within 14 days and a blocker deadline within 60 days, as the route enforces', async () => {
    const catchUp = numberIn(BACKEND.plans, /s > addCalendarDays\(today, (\d+)\)\) throw new SourcingError\(400, 'Pick a catch-up date/);
    const blocker = numberIn(BACKEND.plans, /due > addCalendarDays\(today, (\d+)\)\) throw new SourcingError\(400, 'A blocker needs/);
    await mountReady();
    const t = answerTo(/What is an exception, and how do I resolve one/);
    expect(said(t, /a reason and a date within (\d+) days/)).toBe(catchUp);
    expect(said(t, /a deadline within (\d+) days/)).toBe(blocker);
  });

  it('"Provisional" lasts the number of weeks the first engine run stamps, and "qualified" means a ResumeIQ score above the one the queries use', async () => {
    const weeks = constant(BACKEND.settings, 'DEFAULT_SHADOW_DAYS') / 7;
    const scored = numberIn(BACKEND.qualified, /ai_fit_score > (\d+) THEN/);
    const dashboardScored = numberIn(BACKEND.dashboard, /ai_fit_score > (\d+)\) AS scored_above_60_count/);
    expect(dashboardScored).toBe(scored);
    await mountReady();
    expect(said(answerTo(/What does "Provisional" mean/), /first (\d+) weeks/)).toBe(weeks);
    expect(said(answerTo('Can the qualified-candidate target differ by role?'), /scored above (\d+) by ResumeIQ/)).toBe(scored);
    expect(said(answerTo('Where do the recommended next steps come from?'), /how many scored above (\d+) and so on/)).toBe(scored);
  });

  it('the next-steps answer: reused for up to ADVICE_TTL_MS, rewritten after ADVICE_CHANGED_MIN_AGE_MS, Refresh once per ADVICE_REFRESH_COOLDOWN_MS', async () => {
    const ttl = constant(BACKEND.advisor, 'ADVICE_TTL_MS'), changed = constant(BACKEND.advisor, 'ADVICE_CHANGED_MIN_AGE_MS'), cooldown = constant(BACKEND.advisor, 'ADVICE_REFRESH_COOLDOWN_MS');
    await mountReady();
    const t = answerTo('Where do the recommended next steps come from?');
    expect(ttl, 'the answer says "up to a day"').toBe(24 * 60 * 60 * 1000);
    expect(t).toMatch(/reused for up to a day while the numbers are the same/);
    expect(said(t, /once the saved ones are at least (\d+) minutes old/) * 60 * 1000).toBe(changed);
    expect(cooldown, 'the answer says "at most once a minute"').toBe(60 * 1000);
    expect(t).toMatch(/\(at most once a minute\)/);
  });
});
