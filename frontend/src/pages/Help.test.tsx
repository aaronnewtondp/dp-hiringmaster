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

  it('next steps: AI from counts only (no names), cached for a day, Refresh at most once a minute, rule-based fallback, HR-tier only', async () => {
    await mountReady();
    const t = answerTo('Where do the recommended next steps come from?');
    expect(t).toMatch(/Needs attention.*Next box/);
    expect(t).toMatch(/AI model/);
    expect(t).toMatch(/No candidate names or contact details are shared with it/);
    expect(t).toMatch(/reused for up to a day while the numbers are the same/);
    expect(t).toMatch(/Refresh asks for new ones \(at most once a minute\)/);
    expect(t).toMatch(/rule-based steps instead, labelled as such/);
    expect(t).toMatch(/Only HR\/Admin and Leadership see them/);
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
    expect(t).toMatch(/Filter by tasks, channels, weekly results, targets or alerts/);
    expect(t).toMatch(/Only HR\/Admin and Leadership see it/);
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
