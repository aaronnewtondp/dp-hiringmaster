import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import type {
  AdviceStep, ChannelTracker, SourcingAdvice, SourcingCommitment, SourcingException, SourcingPlanChannel, SourcingPlanView, TrackerWeek,
} from '../../types/sourcing.ts';
import { isTracked, ymd } from '../../utils/sourcingFormat.ts';

// The api module is replaced by plain functions that record their calls on a vi.fn() and then run a swappable implementation. A failing call is
// a plain async function that throws: a vi.fn() spy re-throws a rejected result on a derived promise, which vitest reports as an unhandled error.
const h = vi.hoisted(() => {
  const NAMES = ['plan', 'people', 'activate', 'completeCommitment', 'skipCommitment', 'resolveException', 'setChannel', 'reopenCommitment',
    'updatePlan', 'advice', 'closeChannel', 'reopenChannel', 'updateChannel'] as const;
  type Name = typeof NAMES[number];
  const spies = {} as Record<Name, ReturnType<typeof vi.fn>>;
  const impl = {} as Record<Name, (...a: unknown[]) => Promise<unknown>>;
  const api: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
  for (const n of NAMES) { spies[n] = vi.fn(); api[n] = (...a: unknown[]) => { spies[n](...a); return impl[n](...a); }; }
  const state = { auth: { user: { id: 'u1', name: 'Aaron Newton', email: 'a@x.com', persona: 'hr_recruiter' }, canHR: true } as { user: Record<string, string>; canHR: boolean } };
  return { NAMES, spies, impl, api, state };
});
vi.mock('../../services/api.ts', () => ({ sourcingApi: h.api }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../contexts/AuthContext.tsx', () => ({ useAuth: () => h.state.auth }));

import SourcingPlanPanel from './SourcingPlanPanel.tsx';

const { spies, impl } = h;
const { plan, activate, completeCommitment, skipCommitment, resolveException, setChannel, reopenCommitment, updatePlan, advice, closeChannel, reopenChannel, updateChannel } = spies;

const ok = (data: unknown = { success: true }) => async () => ({ data });
const fail = (err: unknown) => async () => { throw err; };
const refused = (status: number, error: string) => fail({ response: { status, data: { error } } });

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────
const noTracker = (): ChannelTracker => ({ applicable: false, target: null, anchor: null, link: null, running: null, weeks: [], totals: { weeks: 0, met: 0, actual: 0, target: 0 }, sourced: { applications: 0, qualified: 0 } });
const tracker = (over: Partial<ChannelTracker> = {}): ChannelTracker => ({
  applicable: true, target: 20, anchor: '2026-10-12', link: 'https://linkedin.com/jobs/1',
  running: { start: '2026-10-19', end: '2026-10-25', actual: 6, qualified: 2, target: 20 }, weeks: [],
  totals: { weeks: 0, met: 0, actual: 0, target: 0 }, sourced: { applications: 6, qualified: 2 }, ...over,
});
const week = (over: Partial<TrackerWeek> = {}): TrackerWeek => ({ week_start: '2026-10-12', week_end: '2026-10-18', target: 20, actual: 24, qualified: 7, met: true, partial: false, ...over });
const commitment = (over: Partial<SourcingCommitment> = {}): SourcingCommitment => ({
  id: '11', kind: 'renew_posting', title: 'Renew the LinkedIn posting before it expires', due_at: '2026-11-10T18:29:59Z', due_date: ymd(20),
  status: 'open', cadence_days: 30, last_done_at: null, meta: {}, overdue: false, evidence: { auto: 0, self: 0 }, recent: [], ...over,
});
const channel = (over: Partial<SourcingPlanChannel> = {}): SourcingPlanChannel => ({
  id: '1', channel: 'LinkedIn', state: 'active', excluded_reason: null, closed_at: null, closed_reason: null, config: {}, targets: {},
  tracker: isTracked(over.channel ?? 'LinkedIn') ? tracker() : noTracker(), commitments: [commitment()], ...over,
});
const exception = (over: Partial<SourcingException> = {}): SourcingException => ({
  id: '5', channel: 'Agency', type: 'CHANNEL_NOT_ACTIVATED', status: 'open', severity: 40, is_shadow: false, detected_at: '2026-10-12T00:00:00Z',
  last_seen_at: '2026-10-14T00:00:00Z', evidence: {}, resolution_path: null, reason: null, corrective_action: null, snooze_until: null,
  blocker_due: null, blocker_owner_name: null, resolved_at: null,
  committed: 'Agency: Select agencies and share the role brief', happened: 'Not done — 2 days overdue', next_action: 'Choose the agencies', ...over,
});
const view = (over: Partial<SourcingPlanView> = {}): SourcingPlanView => ({
  enabled: true,
  plan: { id: '9', role_id: 'R5', status: 'active', strategy_note: null, baseline: null, baseline_at: null,
          activated_at: '2026-10-10T00:00:00Z', paused_at: null, pause_total_days: 0, closed_at: null, weekly_qualified_target: null },
  role: { id: 'R5', title: 'QA Engineer', priority: 'P1', status: 'Live – Sourcing', num_openings: 1, hiring_manager_name: 'Alex', recruitment_mode: ['LinkedIn'], approval_date: '2026-10-01' },
  channels: [channel()], exceptions: [], changes: [],
  volume: { weekly_qualified: 3, shortlisted: 1, scored: 3, min: 5, rule: 'either', applicable: true, target_source: 'default', role_target: null, default_target: 5 },
  output: [], attribution_reliable: {}, settings: { go_live_date: '2026-10-01', qualified_rule: 'either', shadow_until: null },
  ...over,
});
const withPlan = (p: Partial<NonNullable<SourcingPlanView['plan']>>) => ({ ...view().plan!, ...p });
const draftView = (over: Partial<SourcingPlanView> = {}) => view({ plan: withPlan({ status: 'draft' }), channels: [channel({ state: 'planned', commitments: [] })], ...over });

const step = (over: Partial<AdviceStep> = {}): AdviceStep => ({
  id: 's1', title: 'Send the brief to two agencies today', detail: 'Pick the two agencies with the best QA placements and send the role brief.', channel: 'Agency',
  exception_id: '5', impact: 'high', owner: 'HR', ...over,
});
const adviceBody = (over: Partial<SourcingAdvice> = {}, inner: Partial<SourcingAdvice['advice']> = {}): { data: { enabled: true; advice: SourcingAdvice } } => ({
  data: { enabled: true, advice: {
    advice: { headline: 'Two things will close the gap', steps: [step()], watch: ['Weekly shortlist rate'], ...inner },
    source: 'ai', model: 'claude-sonnet-4-5', generated_at: new Date(Date.now() - 3600_000).toISOString(), facts_hash: 'h1', stale: false, ...over,
  } },
});

const hr = { user: { id: 'u1', name: 'Aaron Newton', email: 'a@x.com', persona: 'hr_recruiter' }, canHR: true };
const hm = { user: { id: 'u9', name: 'Alex', email: 'al@x.com', persona: 'hiring_manager' }, canHR: false };
const leadershipHm = { user: { id: 'u5', name: 'Mansi Jain', email: 'm@x.com', persona: 'leadership' }, canHR: true };

function mount(v: unknown, qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  impl.plan = ok(v);
  return render(<QueryClientProvider client={qc}><MemoryRouter><SourcingPlanPanel roleId="R5" /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  for (const n of h.NAMES) { spies[n].mockReset(); impl[n] = ok(); }
  impl.people = ok({ people: [{ id: 'u1', name: 'Aaron Newton', persona: 'super_admin' }, { id: 'u2', name: 'Garima', persona: 'hr_recruiter' }] });
  impl.advice = ok({ enabled: true, advice: null });
  vi.mocked(toast.error).mockClear(); vi.mocked(toast.success).mockClear();
  h.state.auth = hr;
});

const SOURCING_ALL = ['LinkedIn', 'Naukri/IIMjobs', 'Agency', 'Internal Referral', 'Direct Outreach'];
const BUTTONS_OF_AN_EDITOR = [/Mark done/, /^Skip/, /Resolve/, /Update…/, /^Close \w/, /^Reopen \w/, /Activate plan/, /Add channel/, /Edit plan/, /Bring back/, /Undo skip/, /Set a target/, /Edit .* target/, /Add the target/];

// ═══ when it shows ═══════════════════════════════════════════════════════════════════════════════════
describe('SourcingPlanPanel — when it shows', () => {
  it('renders nothing while the module is off, when there is no plan, or when the server refuses (a Hiring Manager of another role)', async () => {
    const off = mount({ enabled: false });
    await waitFor(() => expect(plan).toHaveBeenCalled());
    await waitFor(() => expect(off.container).toBeEmptyDOMElement());
    off.unmount();

    const none = mount({ enabled: true, plan: null });
    await waitFor(() => expect(none.container).toBeEmptyDOMElement());
    none.unmount();

    impl.plan = fail({ response: { status: 403 } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const refusedView = render(<QueryClientProvider client={qc}><MemoryRouter><SourcingPlanPanel roleId="R5" /></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(refusedView.container).toBeEmptyDOMElement());
  });

  it('shows a spinner (and no plan content) while the plan is loading', async () => {
    impl.plan = () => new Promise(() => {});
    const { container } = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><SourcingPlanPanel roleId="R5" /></MemoryRouter></QueryClientProvider>);
    expect(container.querySelector('.card')).not.toBeNull();
    expect(screen.queryByTestId('sourcing-panel')).not.toBeInTheDocument();
  });

  it('a draft plan says nothing is tracked yet and offers Activate to HR only', async () => {
    const v = draftView();
    const first = mount(v);
    expect(await screen.findByText(/Draft — not tracked yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activate plan' })).toBeInTheDocument();
    first.unmount();

    h.state.auth = hm;
    mount({ ...v, read_only: true });
    expect(await screen.findByText(/has not been activated yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate plan' })).not.toBeInTheDocument();
  });

  it('the header names the role (linked to the role page), its priority and the plan status; there is no "Sourcing" card heading any more', async () => {
    mount(view());
    const link = await screen.findByRole('link', { name: 'QA Engineer' });
    expect(link).toHaveAttribute('href', '/roles/R5');
    expect(screen.getByText('P1')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sourcing' })).not.toBeInTheDocument();
  });
});

// ═══ an active plan ══════════════════════════════════════════════════════════════════════════════════
describe('SourcingPlanPanel — an active plan', () => {
  it('shows HR as the owner (never a person), volume with both qualified components, the exception in plain words and the channel commitments', async () => {
    mount(view({ exceptions: [exception()] }));
    expect(await screen.findByText('Owner:')).toBeInTheDocument();
    expect(screen.getByText('HR')).toBeInTheDocument();
    expect(screen.queryByText('Aaron Newton')).not.toBeInTheDocument();
    expect(screen.getByText(/qualified in the last 7 days/)).toBeInTheDocument();
    expect(screen.getByText('1 shortlisted · 3 scored above 60')).toBeInTheDocument();
    expect(screen.getByText('Channel set-up overdue')).toBeInTheDocument();
    expect(screen.getByText('Not done — 2 days overdue')).toBeInTheDocument();
    expect(within(screen.getByTestId('exception-next')).getByText('Choose the agencies')).toBeInTheDocument();
    expect(screen.getByText('Renew the LinkedIn posting before it expires')).toBeInTheDocument();
    expect(screen.getByText(/repeats every 30 days/)).toBeInTheDocument();
  });

  it('a provisional signal shows greyed with its chip and cannot be "resolved" (nothing was committed against it)', async () => {
    mount(view({ exceptions: [exception({ id: '6', type: 'VOLUME_GAP', channel: '*', is_shadow: true, committed: 'At least 5 qualified candidates a week' })] }));
    expect(await screen.findByText('Not enough qualified candidates')).toBeInTheDocument();
    expect(screen.getByText('Provisional')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resolve/ })).not.toBeInTheDocument();
  });

  it('a snoozed exception shows the catch-up date and the reason given', async () => {
    mount(view({ exceptions: [exception({ status: 'snoozed', snooze_until: '2026-10-16', reason: 'Waiting on the final shortlist' })] }));
    expect(await screen.findByText('Catching up by 2026-10-16')).toBeInTheDocument();
    expect(screen.getByText(/Waiting on the final shortlist/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update…' })).toBeInTheDocument();
  });

  it('a blocked exception shows who it waits for until when', async () => {
    mount(view({ exceptions: [exception({ status: 'blocked', blocker_due: '2026-10-30' })] }));
    expect(await screen.findByText('Blocked until 2026-10-30')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update…' })).toBeInTheDocument();
  });

  it('a Hiring Manager gets a View-only panel: no actions, no history, no source table, no links, no AI advice request', async () => {
    h.state.auth = hm;
    // a skipped commitment, a channel that was left out, a closed channel and a strategy note are all present, so every absence below is a real one
    mount(view({
      read_only: true, exceptions: [exception()],
      changes: [{ id: 'c1', at: '2026-10-10T00:00:00Z', by_name: 'x', change: { type: 'activated' }, reason: null, text: 'Plan activated', category: 'plan' }],
      output: [{ tag: 'LinkedIn', applications: 9, qualified: 4 }],
      plan: withPlan({ strategy_note: 'Quietly prefer service engineers' }),
      channels: [
        channel({ commitments: [commitment({ id: '31', status: 'skipped' })] }),
        channel({ id: '2', channel: 'Agency', state: 'excluded', excluded_reason: 'No budget', commitments: [] }),
        channel({ id: '3', channel: 'Naukri/IIMjobs', state: 'closed', closed_at: '2026-10-18T08:00:00Z', closed_reason: 'Internal closing note',
                  tracker: tracker({ link: 'https://naukri.com/job/9', running: null }), commitments: [] }),
      ],
    }));
    expect(await screen.findByText('View only')).toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();                                  // the skipped row is on screen…
    expect(screen.getByText('Not used')).toBeInTheDocument();                                 // …and so is the channel that was left out
    expect(screen.getByText('No budget')).toBeInTheDocument();                                // (a left-out channel's reason is part of the HM view)
    expect(screen.getByTestId('closed-summary')).toBeInTheDocument();                         // …and the closed channel's summary
    expect(within(screen.getByTestId('exception-next')).getByText('Choose the agencies')).toBeInTheDocument();   // the plain next action
    expect(screen.getByText('Channel set-up overdue')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'LinkedIn applicants this week' })).toBeInTheDocument();      // the weekly tracker itself is visible
    expect(screen.queryByText(/Quietly prefer service engineers/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Internal closing note/)).not.toBeInTheDocument();
    for (const name of BUTTONS_OF_AN_EDITOR) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByText(/Plan history/)).not.toBeInTheDocument();
    expect(screen.queryByText('Applications by source')).not.toBeInTheDocument();
    expect(screen.queryByText(/View job post/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Open link/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('advice-box')).not.toBeInTheDocument();
    expect(advice).not.toHaveBeenCalled();
  });

  it('HR gets every editing control the read-only checks below rely on (so those "absent" checks are not vacuous)', async () => {
    mount(view({
      exceptions: [exception(), exception({ id: '6', status: 'snoozed', snooze_until: '2026-10-30' })],
      channels: [
        channel({ commitments: [commitment(), commitment({ id: '12', status: 'skipped' })] }),
        channel({ id: '2', channel: 'Naukri/IIMjobs', tracker: tracker({ target: null, link: null, running: null }), commitments: [] }),
        channel({ id: '3', channel: 'Agency', state: 'excluded', excluded_reason: 'No budget', commitments: [] }),
        channel({ id: '4', channel: 'Direct Outreach', state: 'closed', closed_at: '2026-10-18T08:00:00Z', closed_reason: 'Done', commitments: [] }),
      ],
    }));
    await screen.findByText('Owner:');
    for (const name of BUTTONS_OF_AN_EDITOR.filter(n => !/Activate plan|Set a target/.test(String(n)))) {
      expect(screen.getAllByRole('button', { name }).length, String(name)).toBeGreaterThan(0);
    }
  });

  it('a Leadership user who is also the role\'s Hiring Manager is HR-tier here: the full, unredacted panel with every action', async () => {
    h.state.auth = leadershipHm;
    mount(view({
      plan: withPlan({ strategy_note: 'Focus on service engineers' }), exceptions: [exception()],
      changes: [{ id: 'c1', at: '2026-10-10T00:00:00Z', by_name: 'x', change: { type: 'activated' }, reason: null, text: 'Plan activated', category: 'plan' }],
      output: [{ tag: 'LinkedIn', applications: 9, qualified: 4 }],
    }));
    expect(await screen.findByText(/Focus on service engineers/)).toBeInTheDocument();
    expect(screen.queryByText('View only')).not.toBeInTheDocument();
    for (const name of [/Mark done/, /Resolve/, /^Close \w/, /Add channel/, /Edit plan/]) expect(screen.getAllByRole('button', { name }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'View job post' })).toHaveAttribute('href', 'https://linkedin.com/jobs/1');
    expect(screen.getByText(/Plan history/)).toBeInTheDocument();
    expect(screen.getByText('Applications by source')).toBeInTheDocument();
    await waitFor(() => expect(advice).toHaveBeenCalledWith('R5'));
  });

  it('applications by source flag a tag with too few applications to judge, and rename the untagged bucket', async () => {
    mount(view({ output: [{ tag: 'LinkedIn', applications: 3, qualified: 1 }, { tag: 'untagged_default', applications: 40, qualified: 12 }] }));
    expect(await screen.findByText('Applications by source')).toBeInTheDocument();
    expect(screen.getByText(/too few to judge/)).toBeInTheDocument();
    expect(screen.getByText('Not tagged')).toBeInTheDocument();
  });

  it('applications by source lists each tag (from the form\'s "How did you hear about this opening?" answer) with its applications and qualified counts, and is hidden when empty or on a draft plan', async () => {
    const first = mount(view({ output: [{ tag: 'Naukri/IIMjobs', applications: 12, qualified: 5 }, { tag: 'Direct Outreach', applications: 7, qualified: 2 }] }));
    const table = (await screen.findByText('Applications by source')).closest('div')!.parentElement!;
    const naukri = within(table).getByText('Naukri/IIMjobs').closest('tr')!;
    expect(within(naukri).getByText('12')).toBeInTheDocument();
    expect(within(naukri).getByText('5')).toBeInTheDocument();
    expect(within(table).getByText('Direct Outreach').closest('tr')).not.toHaveTextContent('too few');
    first.unmount();

    const empty = mount(view({ output: [] }));
    await screen.findByText('Owner:');
    expect(screen.queryByText('Applications by source')).not.toBeInTheDocument();
    empty.unmount();

    mount(draftView({ output: [{ tag: 'LinkedIn', applications: 9, qualified: 4 }] }));
    await screen.findByText(/Draft — not tracked yet/);
    expect(screen.queryByText('Applications by source')).not.toBeInTheDocument();
  });

  it('an active plan shows its activity timeline to HR (with the "latest N of M" note when the server sent a window)', async () => {
    const e = (id: string, text: string) => ({ id, at: '2026-10-10T09:00:00Z', by_name: null, change: { type: 'x' }, reason: null, text, category: 'task' as const });
    mount(view({ changes: [e('c2', 'Renewal task done'), e('c1', 'Plan activated')], changes_total: 40 }));
    const timeline = await screen.findByTestId('plan-timeline');
    expect(within(timeline).getByText('Plan history')).toBeInTheDocument();
    expect(within(timeline).getAllByTestId('timeline-entry')).toHaveLength(2);
    expect(within(timeline).getByText('Showing the latest 2 of 40 entries.')).toBeInTheDocument();
  });
});

// ═══ the weekly qualified target ═════════════════════════════════════════════════════════════════════
describe('SourcingPlanPanel — the qualified-candidate target', () => {
  it('shows the default target, or this role\'s own target, and goes green once it is met', async () => {
    const first = mount(view());
    const vol = await screen.findByTestId('volume');
    expect(within(vol).getByText(/\/ 5 qualified in the last 7 days/)).toBeInTheDocument();
    expect(within(vol).getByTestId('target-source')).toHaveTextContent('Default target');
    expect(within(vol).getByText('3').className).not.toMatch(/green/);
    first.unmount();

    mount(view({
      plan: withPlan({ weekly_qualified_target: 8 }),
      volume: { weekly_qualified: 9, shortlisted: 4, scored: 9, min: 8, rule: 'either', applicable: true, target_source: 'role', role_target: 8, default_target: 5 },
    }));
    const own = await screen.findByTestId('volume');
    expect(within(own).getByText(/\/ 8 qualified in the last 7 days/)).toBeInTheDocument();
    expect(within(own).getByTestId('target-source')).toHaveTextContent('Target set for this role');
    expect(within(own).getByText('9').className).toMatch(/green/);
  });

  it('the info marker on the target says whether it is this role\'s own or the default', async () => {
    const first = mount(view({ role: { ...view().role!, priority: 'P1' } }));
    fireEvent.mouseEnter(within(await screen.findByTestId('volume')).getByRole('button', { name: 'More info' }));
    expect(screen.getByText(/the default for a P1 role \(5\)/)).toBeInTheDocument();
    first.unmount();

    mount(view({ volume: { ...view().volume!, target_source: 'role', role_target: 5, min: 5 } }));
    fireEvent.mouseEnter(within(await screen.findByTestId('volume')).getByRole('button', { name: 'More info' }));
    expect(screen.getByText(/this role's own/)).toBeInTheDocument();
  });

  it('a role with no target (P2/P3 default) says nothing is flagged and offers "Set a target", which opens Edit plan', async () => {
    mount(view({
      role: { ...view().role!, priority: 'P2' },
      volume: { weekly_qualified: 0, shortlisted: 0, scored: 0, min: 0, rule: 'either', applicable: false, target_source: 'none', role_target: null, default_target: null },
    }));
    const note = await screen.findByTestId('no-target');
    expect(note).toHaveTextContent('No qualified-candidate target is set for this role, so nothing is flagged for it.');
    expect(screen.queryByTestId('volume')).not.toBeInTheDocument();
    fireEvent.click(within(note).getByRole('button', { name: 'Set a target' }));
    const d = within(await screen.findByRole('dialog'));
    expect(d.getByText('Edit plan')).toBeInTheDocument();
    expect(d.getByLabelText(/Weekly qualified target/)).toHaveAccessibleDescription(/no target, so nothing is flagged/);
    fireEvent.change(d.getByLabelText(/Weekly qualified target/), { target: { value: '8' } });
    fireEvent.click(d.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updatePlan).toHaveBeenCalledWith('9', { weekly_qualified_target: 8 }));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
  });

  it('with no target, a Hiring Manager sees the note but no "Set a target" button; a draft or closed plan shows no target strip at all', async () => {
    const noTarget = { weekly_qualified: 0, shortlisted: 0, scored: 0, min: 0, rule: 'either', applicable: false, target_source: 'none' as const, role_target: null, default_target: null };
    h.state.auth = hm;
    const first = mount(view({ read_only: true, volume: noTarget }));
    expect(await screen.findByTestId('no-target')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set a target' })).not.toBeInTheDocument();
    first.unmount();

    h.state.auth = hr;
    const draft = mount(draftView({ volume: noTarget }));
    await screen.findByText(/Draft — not tracked yet/);
    expect(screen.queryByTestId('no-target')).not.toBeInTheDocument();
    draft.unmount();

    mount(view({ plan: withPlan({ status: 'closed' }) }));
    await screen.findByText('Closed');
    expect(screen.queryByTestId('volume')).not.toBeInTheDocument();
  });
});

// ═══ wording ═════════════════════════════════════════════════════════════════════════════════════════
describe('SourcingPlanPanel — wording that must not promise an owner or leak to the Hiring Manager', () => {
  it('the server\'s "(untagged)" bucket reads "Not tagged" like the stamped one, and is never called "too few to judge"', async () => {
    mount(view({ output: [{ tag: '(untagged)', applications: 3, qualified: 1 }, { tag: 'untagged_default', applications: 40, qualified: 12 }] }));
    await screen.findByText('Applications by source');
    expect(screen.getAllByText('Not tagged')).toHaveLength(2);
    expect(screen.queryByText('(untagged)')).not.toBeInTheDocument();
    expect(screen.queryByText(/too few to judge/)).not.toBeInTheDocument();
  });

  it('a draft plan says nothing about assigning an owner (there is none: HR owns it as a whole)', async () => {
    mount(draftView());
    const note = await screen.findByText(/Nothing is being tracked for this role yet/);
    expect(note.textContent).toMatch(/no individual owner to assign/);
    expect(note.textContent).not.toMatch(/assigns an owner/);
  });

  it('the activation dialog\'s strategy-note hint says the Hiring Manager does NOT see the note', async () => {
    mount(draftView());
    fireEvent.click(await screen.findByRole('button', { name: 'Activate plan' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/The Hiring Manager does not see it/)).toBeInTheDocument();
    expect(dialog.queryByText(/Hiring Manager or leadership should know/)).not.toBeInTheDocument();
  });
});

// ═══ doing things ════════════════════════════════════════════════════════════════════════════════════
describe('SourcingPlanPanel — doing things', () => {
  it('Mark done sends an attestation for that commitment, then reloads the plan', async () => {
    mount(view());
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(completeCommitment).toHaveBeenCalledWith('11', expect.objectContaining({ attest: true })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(plan).toHaveBeenCalledTimes(2);                                              // refetched
  });

  it('logging a portal post (the first task of LinkedIn) needs the link and the weekly target, defaults the posting date to today and sends all three', async () => {
    const act = commitment({ id: '12', kind: 'activate_channel', title: 'Log the LinkedIn post', cadence_days: null });
    mount(view({ channels: [channel({ state: 'planned', commitments: [act], tracker: tracker({ target: null, link: null, running: null }) })] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Log the LinkedIn post', { selector: 'h3' })).toBeInTheDocument();
    const log = dialog.getByRole('button', { name: 'Log post' });
    expect(log).toBeDisabled();
    fireEvent.change(dialog.getByLabelText('Link to the job post'), { target: { value: 'https://linkedin.com/jobs/1' } });
    expect(log).toBeDisabled();                                                          // the target is still missing
    fireEvent.change(dialog.getByLabelText('Weekly sourcing target'), { target: { value: '25' } });
    expect(log).toBeEnabled();
    fireEvent.click(log);
    await waitFor(() => expect(completeCommitment).toHaveBeenCalledWith('12', expect.objectContaining({ posted_at: ymd(0), url: 'https://linkedin.com/jobs/1', weekly_target: 25, attest: true })));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
  });

  it('Skip needs a real reason before it can be sent', async () => {
    mount(view());
    fireEvent.click(await screen.findByRole('button', { name: /^Skip/ }));
    const dialog = await screen.findByRole('dialog');
    const send = within(dialog).getByRole('button', { name: 'Skip' });
    expect(send).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'ok' } });
    expect(send).toBeDisabled();                                                          // 2 characters is not a reason
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Role is on hold at the client end' } });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    await waitFor(() => expect(skipCommitment).toHaveBeenCalledWith('11', 'Role is on hold at the client end'));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
  });

  it('a server refusal keeps the dialog open and shows the server\'s message', async () => {
    impl.completeCommitment = fail({ response: { data: { error: 'Evidence URL must be a valid http(s) link' } } });
    mount(view());
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Evidence URL must be a valid http(s) link'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(plan).toHaveBeenCalledTimes(1);                                              // nothing changed, so nothing is re-read
  });

  it('Escape closes a dialog without doing anything', async () => {
    mount(view());
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(completeCommitment).not.toHaveBeenCalled();
  });
});

describe('Resolve exception — the three paths', () => {
  const open = async () => {
    mount(view({ exceptions: [exception()] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve…' }));
    return within(await screen.findByRole('dialog'));
  };

  it('catch up: Save stays disabled until there is a reason, then sends the date', async () => {
    const d = await open();
    const save = d.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(d.getAllByRole('textbox')[0], { target: { value: 'Sending the brief tomorrow' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(resolveException).toHaveBeenCalledWith('5', expect.objectContaining({ path: 'catch_up', snooze_until: ymd(2), reason: 'Sending the brief tomorrow' })));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
  });

  it('catch up refuses a date outside the next 14 days', async () => {
    const d = await open();
    fireEvent.change(d.getAllByRole('textbox')[0], { target: { value: 'Need more time' } });
    fireEvent.change(d.getByDisplayValue(ymd(2)), { target: { value: ymd(15) } });
    expect(d.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(d.getByText('Pick a date within the next 14 days.')).toBeInTheDocument();
  });

  it('blocker: owner and a deadline within 60 days are sent', async () => {
    const d = await open();
    fireEvent.click(d.getByRole('radio', { name: /I'm blocked/ }));
    fireEvent.change(d.getAllByRole('textbox')[0], { target: { value: 'Waiting for the agency contract to be signed' } });
    fireEvent.click(d.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(resolveException).toHaveBeenCalledWith('5', expect.objectContaining({ path: 'blocker', blocker_due: ymd(7), blocker_owner_user_id: 'u1' })));
  });

  it('blocker refuses a deadline more than 60 days out', async () => {
    const d = await open();
    fireEvent.click(d.getByRole('radio', { name: /I'm blocked/ }));
    fireEvent.change(d.getAllByRole('textbox')[0], { target: { value: 'Long procurement' } });
    fireEvent.change(d.getByDisplayValue(ymd(7)), { target: { value: ymd(61) } });
    expect(d.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('change the plan: can also drop the channel, and the option exists only for a channel-level exception', async () => {
    const d = await open();
    fireEvent.click(d.getByRole('radio', { name: /Change the plan/ }));
    fireEvent.click(d.getByLabelText('Close Agency for this role'));
    fireEvent.change(d.getAllByRole('textbox')[0], { target: { value: 'Agencies are not right for this role' } });
    fireEvent.click(d.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(resolveException).toHaveBeenCalledWith('5', expect.objectContaining({ path: 'change_strategy', exclude_channel: true })));
  });

  // The checkbox reads "Close {channel} for this role" (it used to be "Stop using …"): ticking it makes the server CLOSE the channel — kept as a
  // closed summary and reopenable — not leave it out, so the dialog must send exactly exclude_channel: true, and only when it is ticked.
  describe('"Close {channel} for this role"', () => {
    const openChange = async (ex: Partial<SourcingException> = {}) => {
      mount(view({ exceptions: [exception(ex)] }));
      fireEvent.click(await screen.findByRole('button', { name: 'Resolve…' }));
      const d = within(await screen.findByRole('dialog'));
      fireEvent.click(d.getByRole('radio', { name: /Change the plan/ }));
      return d;
    };
    const why = (d: ReturnType<typeof within>, text = 'Agencies are not right for this role') => fireEvent.change(d.getAllByRole('textbox')[0], { target: { value: text } });
    const sentBody = () => resolveException.mock.calls[0][1] as Record<string, unknown>;

    it('is an unticked checkbox named after the exception\'s channel, and the old "Stop using" wording is gone', async () => {
      const d = await openChange();
      const box = d.getByRole('checkbox', { name: 'Close Agency for this role' });
      expect(box).not.toBeChecked();
      expect(d.queryByText(/Stop using/i)).not.toBeInTheDocument();
    });

    it('names whichever channel the exception is about', async () => {
      const d = await openChange({ channel: 'Direct Outreach' });
      expect(d.getByRole('checkbox', { name: 'Close Direct Outreach for this role' })).toBeInTheDocument();
      expect(d.queryByLabelText('Close Agency for this role')).not.toBeInTheDocument();
    });

    it('ticked: Save sends path change_strategy with exclude_channel true, the trimmed reason, and then re-reads the plan', async () => {
      const d = await openChange();
      fireEvent.click(d.getByRole('checkbox', { name: 'Close Agency for this role' }));
      expect(d.getByRole('checkbox', { name: 'Close Agency for this role' })).toBeChecked();
      why(d, '  Agencies are not right for this role  ');
      fireEvent.click(d.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(resolveException).toHaveBeenCalledTimes(1));
      expect(resolveException.mock.calls[0][0]).toBe('5');
      expect(sentBody()).toMatchObject({ path: 'change_strategy', reason: 'Agencies are not right for this role', exclude_channel: true });
      await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
      expect(toast.success).toHaveBeenCalledWith('Plan changed and logged');
    });

    it('left unticked: exclude_channel is not sent at all (not even as false)', async () => {
      const d = await openChange();
      why(d);
      fireEvent.click(d.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(resolveException).toHaveBeenCalledTimes(1));
      expect(sentBody()).toMatchObject({ path: 'change_strategy' });
      expect(sentBody()).not.toHaveProperty('exclude_channel');
    });

    it('ticked and then unticked again: nothing is sent', async () => {
      const d = await openChange();
      const box = d.getByRole('checkbox', { name: 'Close Agency for this role' });
      fireEvent.click(box);
      fireEvent.click(box);
      expect(box).not.toBeChecked();
      why(d);
      fireEvent.click(d.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(resolveException).toHaveBeenCalledTimes(1));
      expect(sentBody()).not.toHaveProperty('exclude_channel');
    });

    it('ticked, then the path is switched to "I\'ll catch up": the checkbox is gone and the catch-up request does not close the channel', async () => {
      const d = await openChange();
      fireEvent.click(d.getByRole('checkbox', { name: 'Close Agency for this role' }));
      fireEvent.click(d.getByRole('radio', { name: /I'll catch up/ }));
      expect(d.queryByRole('checkbox')).not.toBeInTheDocument();
      why(d, 'Sending the brief tomorrow');
      fireEvent.click(d.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(resolveException).toHaveBeenCalledTimes(1));
      expect(sentBody()).toMatchObject({ path: 'catch_up', snooze_until: ymd(2) });
      expect(sentBody()).not.toHaveProperty('exclude_channel');
    });

    it('ticked, then the path is switched to "I\'m blocked": the blocker request does not close the channel', async () => {
      const d = await openChange();
      fireEvent.click(d.getByRole('checkbox', { name: 'Close Agency for this role' }));
      fireEvent.click(d.getByRole('radio', { name: /I'm blocked/ }));
      expect(d.queryByRole('checkbox')).not.toBeInTheDocument();
      why(d, 'Waiting for the agency contract to be signed');
      fireEvent.click(d.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(resolveException).toHaveBeenCalledTimes(1));
      expect(sentBody()).toMatchObject({ path: 'blocker', blocker_due: ymd(7) });
      expect(sentBody()).not.toHaveProperty('exclude_channel');
    });

    it('the tick survives a trip through another path and back (the choice is the dialog\'s, not the path\'s)', async () => {
      const d = await openChange();
      fireEvent.click(d.getByRole('checkbox', { name: 'Close Agency for this role' }));
      fireEvent.click(d.getByRole('radio', { name: /I'll catch up/ }));
      fireEvent.click(d.getByRole('radio', { name: /Change the plan/ }));
      expect(d.getByRole('checkbox', { name: 'Close Agency for this role' })).toBeChecked();
    });

    it('Save stays disabled until there is a reason, whether or not the box is ticked, and nothing is sent', async () => {
      const d = await openChange();
      fireEvent.click(d.getByRole('checkbox', { name: 'Close Agency for this role' }));
      expect(d.getByRole('button', { name: 'Save' })).toBeDisabled();
      fireEvent.click(d.getByRole('button', { name: 'Save' }));
      expect(resolveException).not.toHaveBeenCalled();
    });

    it('a refused request shows the server\'s message and keeps the dialog open so the tick is not lost', async () => {
      impl.resolveException = refused(409, 'That channel is already closed');
      const d = await openChange();
      fireEvent.click(d.getByRole('checkbox', { name: 'Close Agency for this role' }));
      why(d);
      fireEvent.click(d.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('That channel is already closed'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(d.getByRole('checkbox', { name: 'Close Agency for this role' })).toBeChecked();
      expect(plan).toHaveBeenCalledTimes(1);
    });
  });

  it('a plan-level exception (no channel) offers no "stop using" option', async () => {
    mount(view({ exceptions: [exception({ id: '8', channel: '*', type: 'PLAN_NOT_ACTIVATED' })] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve…' }));
    const d = within(await screen.findByRole('dialog'));
    fireEvent.click(d.getByRole('radio', { name: /Change the plan/ }));
    expect(d.queryByText(/Close .* for this role/)).not.toBeInTheDocument();
  });
});

// ═══ Activate plan ═══════════════════════════════════════════════════════════════════════════════════
describe('Activate plan (through the panel)', () => {
  const draft = () => view({
    plan: withPlan({ status: 'draft' }),
    channels: [channel({ id: '1', channel: 'LinkedIn', state: 'planned', commitments: [] }), channel({ id: '2', channel: 'Agency', state: 'planned', commitments: [] })],
  });
  const open = async () => {
    mount(draft());
    fireEvent.click(await screen.findByRole('button', { name: 'Activate plan' }));
    return within(await screen.findByRole('dialog'));
  };

  it('has no owner to pick (sourcing belongs to HR as a whole) and pre-ticks the seeded channels', async () => {
    const d = await open();
    expect(d.queryByLabelText('Sourcing owner')).not.toBeInTheDocument();
    expect(d.getByRole('checkbox', { name: /LinkedIn/ })).toBeChecked();
    expect(d.getByRole('checkbox', { name: /Agency/ })).toBeChecked();
    expect(d.getByRole('checkbox', { name: /Naukri\/IIMjobs/ })).not.toBeChecked();
  });

  it('leaving out a seeded channel requires a reason; a running LinkedIn needs its link and target; the payload carries all of it — and no owner', async () => {
    const d = await open();
    const go = d.getByRole('button', { name: 'Activate plan' });
    fireEvent.click(d.getByRole('checkbox', { name: /Agency/ }));                         // untick a seeded channel
    expect(go).toBeDisabled();
    expect(d.getByText(/Say why Agency is not being used/)).toBeInTheDocument();
    fireEvent.change(d.getByLabelText('Reason for not using Agency'), { target: { value: 'No budget for agency fees' } });
    expect(go).toBeEnabled();

    fireEvent.click(d.getByRole('checkbox', { name: 'Already running before today' }));  // LinkedIn is already live…
    expect(go).toBeDisabled();                                                            // …so it needs the post link and a weekly target now
    fireEvent.change(d.getByLabelText('LinkedIn posting date'), { target: { value: '2026-10-01' } });
    fireEvent.change(d.getByLabelText('LinkedIn post link'), { target: { value: 'https://linkedin.com/jobs/1' } });
    fireEvent.change(d.getByLabelText('LinkedIn weekly sourcing target'), { target: { value: '30' } });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(activate).toHaveBeenCalledWith('9', {
      strategy_note: null,
      channels: [
        { channel: 'LinkedIn', already_running: true, posted_at: '2026-10-01', url: 'https://linkedin.com/jobs/1', weekly_target: 30 },
        { channel: 'Agency', exclude_reason: 'No budget for agency fees' },
      ],
    }));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
  });

  it('the role\'s weekly qualified target goes in the same request when one is typed', async () => {
    const d = await open();
    fireEvent.change(d.getByLabelText(/Weekly qualified target for this role/), { target: { value: '8' } });
    fireEvent.click(d.getByRole('button', { name: 'Activate plan' }));
    await waitFor(() => expect(activate).toHaveBeenCalled());
    expect(activate.mock.calls[0][1]).toMatchObject({ weekly_qualified_target: 8 });
  });

  it('cannot activate with every channel unticked', async () => {
    const d = await open();
    fireEvent.click(d.getByRole('checkbox', { name: /LinkedIn/ }));
    fireEvent.click(d.getByRole('checkbox', { name: /Agency/ }));
    fireEvent.change(d.getByLabelText('Reason for not using LinkedIn'), { target: { value: 'Not relevant here' } });
    fireEvent.change(d.getByLabelText('Reason for not using Agency'), { target: { value: 'Not relevant here' } });
    expect(d.getByRole('button', { name: 'Activate plan' })).toBeDisabled();
    expect(d.getByText('Keep at least one channel in the plan.')).toBeInTheDocument();
  });

  it('direct outreach that is already running needs a campaign link and a weekly sourcing target (it is no longer an optional contact target)', async () => {
    const d = await open();
    fireEvent.click(d.getByRole('checkbox', { name: /Direct Outreach/ }));
    const go = d.getByRole('button', { name: 'Activate plan' });
    expect(go).toBeEnabled();                                                             // not running yet: nothing more is required
    expect(d.queryByLabelText('Weekly unique-contact target')).not.toBeInTheDocument();
    const running = d.getAllByRole('checkbox', { name: 'Already running before today' });
    fireEvent.click(running[running.length - 1]);
    expect(go).toBeDisabled();
    fireEvent.change(d.getByLabelText('Direct Outreach post link'), { target: { value: 'https://docs.google.com/spreadsheets/d/abc' } });
    fireEvent.change(d.getByLabelText('Direct Outreach weekly sourcing target'), { target: { value: '25' } });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(activate).toHaveBeenCalled());
    const sent = activate.mock.calls[0][1] as { channels: Array<{ channel: string; weekly_target?: number; url?: string }> };
    expect(sent.channels.find(c => c.channel === 'Direct Outreach')).toMatchObject({ weekly_target: 25, url: 'https://docs.google.com/spreadsheets/d/abc' });
  });
});

// ═══ managing a running plan ═════════════════════════════════════════════════════════════════════════
describe('SourcingPlanPanel — managing a running plan', () => {
  const skippedFollowOn = (over: Partial<SourcingCommitment> = {}) => commitment({ id: '21', status: 'skipped', title: 'Renew the LinkedIn posting before it expires', ...over });

  it('Add channel lists only the channels that are not in the plan, and sends the choice as "planned"', async () => {
    mount(view());
    fireEvent.click(await screen.findByRole('button', { name: 'Add channel' }));
    const d = within(await screen.findByRole('dialog'));
    expect(d.getByRole('radio', { name: /Agency/ })).toBeInTheDocument();
    expect(d.getByRole('radio', { name: /Direct Outreach/ })).toBeInTheDocument();
    expect(d.queryByRole('radio', { name: /LinkedIn/ })).not.toBeInTheDocument();           // already in the plan
    const add = d.getByRole('button', { name: 'Add channel' });
    expect(add).toBeDisabled();                                                              // nothing chosen yet
    fireEvent.click(d.getByRole('radio', { name: /Agency/ }));
    fireEvent.click(add);
    await waitFor(() => expect(setChannel).toHaveBeenCalledWith('9', { channel: 'Agency', state: 'planned' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(plan).toHaveBeenCalledTimes(2);                                                   // the plan is re-read
  });

  it('there is no Add channel button once every channel is in the plan', async () => {
    mount(view({ channels: SOURCING_ALL.map((ch, i) => channel({ id: String(i + 1), channel: ch, commitments: [] })) }));
    await screen.findByText('Owner:');
    expect(screen.queryByRole('button', { name: 'Add channel' })).not.toBeInTheDocument();
  });

  it('a CLOSED channel is not "addable" — it is reopened: with every other channel in the plan there is no Add channel button, and with one left out only that one is offered', async () => {
    const others = SOURCING_ALL.filter(c => c !== 'Agency' && c !== 'Internal Referral');
    const closedAgency = channel({ id: '8', channel: 'Agency', state: 'closed', closed_at: '2026-10-18T08:00:00Z', closed_reason: 'Filled elsewhere', commitments: [] });
    const first = mount(view({ channels: [...others.map((ch, i) => channel({ id: String(i + 1), channel: ch, commitments: [] })), closedAgency,
                                          channel({ id: '9', channel: 'Internal Referral', commitments: [] })] }));
    await screen.findByText('Owner:');
    expect(screen.queryByRole('button', { name: 'Add channel' })).not.toBeInTheDocument();
    first.unmount();

    mount(view({ channels: [...others.map((ch, i) => channel({ id: String(i + 1), channel: ch, commitments: [] })), closedAgency,
                            channel({ id: '9', channel: 'Internal Referral', state: 'excluded', excluded_reason: 'No team', commitments: [] })] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add channel' }));
    const d = within(await screen.findByRole('dialog'));
    expect(d.getByRole('radio', { name: /Internal Referral/ })).toBeInTheDocument();
    expect(d.queryByRole('radio', { name: /Agency/ })).not.toBeInTheDocument();
  });

  it('a channel that was left out can be brought back, and shows why it was left out', async () => {
    const out = channel({ id: '2', channel: 'Agency', state: 'excluded', excluded_reason: 'No budget for agency fees', commitments: [skippedFollowOn({ id: '22', kind: 'followup_agency', title: 'Follow up with the briefed agencies' })] });
    mount(view({ channels: [channel(), out] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Bring back Agency' }));
    const d = within(await screen.findByRole('dialog'));
    expect(d.getByText('Bring back Agency')).toBeInTheDocument();
    expect(d.getByText(/Left out earlier: No budget for agency fees/)).toBeInTheDocument();
    fireEvent.click(d.getByRole('button', { name: 'Bring it back' }));
    await waitFor(() => expect(setChannel).toHaveBeenCalledWith('9', { channel: 'Agency', state: 'planned' }));
  });

  it('Undo skip re-opens a skipped commitment — but not one that belongs to a channel that is left out', async () => {
    const out = channel({ id: '2', channel: 'Agency', state: 'excluded', excluded_reason: 'Not needed', commitments: [skippedFollowOn({ id: '22', kind: 'followup_agency', title: 'Follow up with the briefed agencies' })] });
    mount(view({ channels: [channel({ commitments: [skippedFollowOn()] }), out] }));
    const undo = await screen.findAllByRole('button', { name: /Undo skip/ });
    expect(undo).toHaveLength(1);                                                            // the Agency one has no button: bring the channel back first
    expect(undo[0]).toHaveAccessibleName('Undo skip: Renew the LinkedIn posting before it expires');
    fireEvent.click(undo[0]);
    await waitFor(() => expect(reopenCommitment).toHaveBeenCalledWith('21'));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
  });

  it('a refused Undo skip shows the server\'s message and still re-reads the plan', async () => {
    impl.reopenCommitment = fail({ response: { data: { error: 'The plan is not active' } } });
    mount(view({ channels: [channel({ commitments: [skippedFollowOn()] })] }));
    fireEvent.click(await screen.findByRole('button', { name: /Undo skip/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The plan is not active'));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
  });

  it('Edit plan: Save stays off until something changes, then sends only the note — there is no owner field', async () => {
    mount(view());
    fireEvent.click(await screen.findByRole('button', { name: 'Edit plan' }));
    const d = within(await screen.findByRole('dialog'));
    expect(d.queryByLabelText('Sourcing owner')).not.toBeInTheDocument();
    const save = d.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(d.getByLabelText(/Strategy note/), { target: { value: 'Focus on service engineers' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(updatePlan).toHaveBeenCalledWith('9', { strategy_note: 'Focus on service engineers' }));
  });

  it('Edit plan: clearing the note sends null', async () => {
    mount(view({ plan: withPlan({ strategy_note: 'Focus on service engineers' }) }));
    expect(await screen.findByText(/Focus on service engineers/)).toBeInTheDocument();       // the note is visible to HR in the panel
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }));
    const d = within(await screen.findByRole('dialog'));
    fireEvent.change(d.getByLabelText(/Strategy note/), { target: { value: '   ' } });
    fireEvent.click(d.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updatePlan).toHaveBeenCalledWith('9', { strategy_note: null }));
  });

  it('a draft plan offers none of these (a draft chooses its channels when it is activated), though a left-out channel is still shown', async () => {
    mount(draftView({ channels: [channel({ state: 'planned', commitments: [] }), channel({ id: '2', channel: 'Agency', state: 'excluded', excluded_reason: 'No budget', commitments: [] })] }));
    await screen.findByText(/Draft — not tracked yet/);
    expect(screen.getByText('Not used')).toBeInTheDocument();                                 // an excluded channel IS shown
    for (const name of [/Add channel/, /Edit plan/, /Set a target/, /Undo skip/, /Mark done/]) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  // On a DRAFT plan a channel offers no Close channel / Bring back: the server refuses the first (409 "Activate the plan first"), and a draft chooses its
  // channels in the activation dialog. (Found by these tests; fixed with SourcingChannelBlock's `canManage`.)
  it('a draft plan offers no "Close channel" (the server refuses it until the plan is activated)', async () => {
    mount(draftView());
    await screen.findByText(/Draft — not tracked yet/);
    expect(screen.queryByRole('button', { name: /^Close \w/ })).not.toBeInTheDocument();
  });

  it('a draft plan offers no "Bring back" on a channel that was left out (a draft chooses its channels when it is activated)', async () => {
    mount(draftView({ channels: [channel({ state: 'planned', commitments: [] }), channel({ id: '2', channel: 'Agency', state: 'excluded', excluded_reason: 'No budget', commitments: [] })] }));
    await screen.findByText(/Draft — not tracked yet/);
    expect(screen.queryByRole('button', { name: /Bring back/ })).not.toBeInTheDocument();
  });

  it('a closed plan is read-only: no edit buttons, no channel actions, no AI advice, no target strip', async () => {
    mount(view({
      plan: withPlan({ status: 'closed' }),                                                   // (closing a role resolves its exceptions)
      channels: [
        channel({ commitments: [skippedFollowOn()] }),
        channel({ id: '2', channel: 'Agency', state: 'excluded', excluded_reason: 'No budget', commitments: [] }),
        channel({ id: '3', channel: 'Naukri/IIMjobs', state: 'closed', closed_at: '2026-10-18T08:00:00Z', closed_reason: 'Filled', commitments: [] }),
      ],
    }));
    await screen.findByTestId('sourcing-panel');
    expect(screen.getAllByText('Closed')).toHaveLength(2);                                    // the plan's chip and the closed channel's
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText('Not used')).toBeInTheDocument();
    expect(screen.getByTestId('closed-summary')).toBeInTheDocument();                         // what a closed channel produced is still readable
    for (const name of BUTTONS_OF_AN_EDITOR) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByTestId('volume')).not.toBeInTheDocument();
    expect(screen.queryByTestId('advice-box')).not.toBeInTheDocument();
    expect(advice).not.toHaveBeenCalled();
  });

  it('a paused plan can still take a channel or bring one back, says its clock starts when the role is back on, and offers no commitment actions', async () => {
    mount(view({
      plan: withPlan({ status: 'paused' }),
      channels: [channel({ commitments: [skippedFollowOn(), commitment({ id: '41', title: 'Another open task' })] }),
                 channel({ id: '2', channel: 'Agency', state: 'excluded', excluded_reason: 'No budget', commitments: [] })],
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add channel' }));
    const d = within(await screen.findByRole('dialog'));
    expect(d.getByText(/starts when the role is back on/)).toBeInTheDocument();
    fireEvent.click(d.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Bring back Agency' })).toBeInTheDocument();    // a tracked plan, so a left-out channel can come back
    expect(screen.getByRole('button', { name: 'Edit plan' })).toBeInTheDocument();
    expect(screen.getByText('Paused (role on hold)')).toBeInTheDocument();
    for (const name of [/Undo skip/, /Mark done/, /^Skip/]) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();   // commitments of a paused plan are not editable
  });

  it('a refused Add channel (409: another tab got there first) tells the user, closes the dialog and re-reads the plan', async () => {
    impl.setChannel = refused(409, 'Agency is already in this plan');
    mount(view());
    fireEvent.click(await screen.findByRole('button', { name: 'Add channel' }));
    const d = within(await screen.findByRole('dialog'));
    fireEvent.click(d.getByRole('radio', { name: /Agency/ }));
    fireEvent.click(d.getByRole('button', { name: 'Add channel' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Agency is already in this plan'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it('focus stays in the field being typed in when the panel re-renders behind the dialog (it used to be pulled back to the dialog frame)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // the second read DIFFERS (a new qualified count), so the panel really re-renders — identical data would be structurally shared and skip it
    let reads = 0;
    impl.plan = async () => ({ data: reads++ === 0 ? view() : view({ volume: { ...view().volume!, weekly_qualified: 4, shortlisted: 2, scored: 4 } }) });
    render(<QueryClientProvider client={qc}><MemoryRouter><SourcingPlanPanel roleId="R5" /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit plan' }));
    const note = within(await screen.findByRole('dialog')).getByLabelText(/Strategy note/);
    note.focus();
    expect(document.activeElement).toBe(note);
    await qc.invalidateQueries({ queryKey: ['sourcing-plan', 'R5'] });                         // a background refetch re-renders the panel
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('2 shortlisted · 4 scored above 60')).toBeInTheDocument());      // the re-render happened
    expect(document.activeElement).toBe(note);
  });
});

// ═══ channels: close, reopen, bring back, edit target and link ═══════════════════════════════════════
describe('SourcingPlanPanel — closing, reopening and tracking channels', () => {
  it('"Close channel" is offered on a live channel (not yet live or live), never on one that was left out or is already closed', async () => {
    mount(view({ channels: [
      channel({ id: '1', channel: 'LinkedIn' }),
      channel({ id: '2', channel: 'Naukri/IIMjobs', state: 'planned', commitments: [] }),
      channel({ id: '3', channel: 'Agency', state: 'excluded', excluded_reason: 'No budget', commitments: [] }),
      channel({ id: '4', channel: 'Direct Outreach', state: 'closed', closed_at: '2026-10-18T08:00:00Z', closed_reason: 'Done', commitments: [] }),
    ] }));
    await screen.findByText('Owner:');
    expect(screen.getByRole('button', { name: 'Close LinkedIn' })).toHaveTextContent('Close channel');
    expect(screen.getByRole('button', { name: 'Close Naukri/IIMjobs' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close Agency' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close Direct Outreach' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen Direct Outreach' })).toHaveTextContent('Reopen channel');
    expect(screen.getByRole('button', { name: 'Bring back Agency' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop using/ })).not.toBeInTheDocument();      // the old button is gone
  });

  it('Close channel opens its dialog, needs a reason, closes the channel with it and re-reads the plan', async () => {
    mount(view());
    fireEvent.click(await screen.findByRole('button', { name: 'Close LinkedIn' }));
    const d = within(await screen.findByRole('dialog'));
    expect(d.getByText('Close LinkedIn')).toBeInTheDocument();
    const go = d.getByRole('button', { name: 'Close channel' });
    expect(go).toBeDisabled();
    fireEvent.change(d.getByRole('textbox'), { target: { value: 'Enough applicants for now' } });
    fireEvent.click(go);
    await waitFor(() => expect(closeChannel).toHaveBeenCalledWith('9', 'LinkedIn', 'Enough applicants for now'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it('after a channel is closed its summary stays: when and why, the weekly target, weeks on target, applicants tagged, the post link and every weekly result', async () => {
    mount(view({ channels: [
      channel({
        id: '1', channel: 'LinkedIn', state: 'closed', closed_at: '2026-10-22T08:00:00Z', closed_reason: 'Role is filled', commitments: [commitment({ status: 'skipped' })],
        tracker: tracker({
          running: null, link: 'https://linkedin.com/jobs/1',
          weeks: [week({ week_start: '2026-10-19', week_end: '2026-10-22', actual: 5, partial: true, met: false }), week({ week_start: '2026-10-12', week_end: '2026-10-18', actual: 12, met: false }), week({ week_start: '2026-10-05', week_end: '2026-10-11' })],
          totals: { weeks: 3, met: 1, actual: 41, target: 60 }, sourced: { applications: 41, qualified: 12 },
        }),
      }),
    ] }));
    const summary = within(await screen.findByTestId('closed-summary'));
    expect(summary.getByText(/Closed 22 Oct/)).toBeInTheDocument();
    expect(summary.getByText('Role is filled')).toBeInTheDocument();
    expect(summary.getByText('Weekly target').nextElementSibling).toHaveTextContent('20');
    expect(summary.getByText('Weeks tracked').nextElementSibling).toHaveTextContent('3 · 1 on target');
    expect(summary.getByText('Applicants tagged').nextElementSibling).toHaveTextContent('41 · 12 qualified');
    expect(summary.getByRole('link', { name: 'Open link' })).toHaveAttribute('href', 'https://linkedin.com/jobs/1');
    const rows = summary.getAllByTestId('tracker-week');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('Cut short')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Missed')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Met')).toBeInTheDocument();
    // a closed channel has no live tracker, no tasks and no target editing
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark done|Undo skip|Edit LinkedIn target/ })).not.toBeInTheDocument();
  });

  it('Reopen channel opens its dialog (mentioning the target it will carry on with), reopens and re-reads the plan', async () => {
    mount(view({ channels: [channel({ state: 'closed', closed_at: '2026-10-18T08:00:00Z', closed_reason: 'Paused hiring', commitments: [], tracker: tracker({ running: null }) })] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen LinkedIn' }));
    const d = within(await screen.findByRole('dialog'));
    expect(d.getByText('Reopen LinkedIn')).toBeInTheDocument();
    expect(d.getByText(/same target of 20 a week/)).toBeInTheDocument();
    fireEvent.click(d.getByRole('button', { name: 'Reopen channel' }));
    await waitFor(() => expect(reopenChannel).toHaveBeenCalledWith('9', 'LinkedIn'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it('a live tracked channel shows its weekly target, this week\'s progress, the post link (HR only) and its finished weeks, red for missed and green for met', async () => {
    mount(view({ channels: [channel({
      tracker: tracker({ weeks: [week({ week_start: '2026-10-12', week_end: '2026-10-18', actual: 9, met: false }), week({ week_start: '2026-10-05', week_end: '2026-10-11' })],
                         totals: { weeks: 2, met: 1, actual: 33, target: 40 } }),
    })] }));
    const block = within(await screen.findByTestId('channel-LinkedIn'));
    expect(block.getByText('Live')).toBeInTheDocument();
    expect(block.getByText(/Weekly sourcing target:/)).toHaveTextContent('20');
    expect(block.getByRole('progressbar', { name: 'LinkedIn applicants this week' })).toHaveAttribute('aria-valuenow', '6');
    expect(block.getByRole('link', { name: 'View job post' })).toHaveAttribute('href', 'https://linkedin.com/jobs/1');
    const rows = block.getAllByTestId('tracker-week');
    expect(within(rows[0]).getByText('Missed')).toBeInTheDocument();
    expect(rows[0].className).toMatch(/red/);
    expect(within(rows[1]).getByText('Met')).toBeInTheDocument();
    expect(rows[1].className).toMatch(/green/);
  });

  it('a live tracked channel with no target says so and (for HR) offers to add it; a Hiring Manager only sees the note', async () => {
    const noTarget = channel({ tracker: tracker({ target: null, link: null, running: null }) });
    const first = mount(view({ channels: [noTarget] }));
    const note = await screen.findByTestId('tracker-no-target');
    expect(note).toHaveTextContent('No weekly sourcing target is set for LinkedIn yet');
    fireEvent.click(within(note).getByRole('button', { name: 'Add the target and post link' }));
    expect(await screen.findByRole('dialog')).toHaveAccessibleName('LinkedIn: target and link');
    first.unmount();

    h.state.auth = hm;
    mount(view({ read_only: true, channels: [noTarget] }));
    expect(await screen.findByTestId('tracker-no-target')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add the target and post link' })).not.toBeInTheDocument();
  });

  it('Edit target and link sends only what changed, then re-reads the plan', async () => {
    mount(view());
    fireEvent.click(await screen.findByRole('button', { name: 'Edit LinkedIn target and link' }));
    const d = within(await screen.findByRole('dialog'));
    const save = d.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(d.getByLabelText('Weekly sourcing target'), { target: { value: '30' } });
    fireEvent.click(save);
    await waitFor(() => expect(updateChannel).toHaveBeenCalledWith('9', { channel: 'LinkedIn', weekly_target: 30 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it('a refused channel change (409) closes the dialog and re-reads the plan', async () => {
    impl.updateChannel = refused(409, 'The channel is closed');
    mount(view());
    fireEvent.click(await screen.findByRole('button', { name: 'Edit LinkedIn target and link' }));
    const d = within(await screen.findByRole('dialog'));
    fireEvent.change(d.getByLabelText('Weekly sourcing target'), { target: { value: '30' } });
    fireEvent.click(d.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The channel is closed'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(plan).toHaveBeenCalledTimes(2);
  });
});

// ═══ "Add the target and post link": which dialog it opens ═══════════════════════════════════════════
// A live tracked channel with no weekly target either still has its first task (kind activate_channel) open — handed back to channels that went live
// before the tracker existed — in which case logging that task asks for the link and the target in one go and starts the tracker; or it does not,
// and the plain "target and link" editor opens.
describe('SourcingPlanPanel — "Add the target and post link" opens the dialog that fits the channel', () => {
  const ACTIVATION_TITLE = 'Log the LinkedIn post (link and weekly sourcing target)';
  const activation = (over: Partial<SourcingCommitment> = {}) => commitment({ id: '31', kind: 'activate_channel', title: ACTIVATION_TITLE, cadence_days: null, ...over });
  const noTarget = (over: Partial<ChannelTracker> = {}) => tracker({ target: null, link: null, running: null, ...over });
  const clickAdd = async (name = 'Add the target and post link') => fireEvent.click(await screen.findByRole('button', { name }));

  it('no target and the first task still open: the button opens that task — title, the link field and the weekly target field — not the edit dialog', async () => {
    mount(view({ channels: [channel({ tracker: noTarget(), commitments: [activation()] })] }));
    await clickAdd();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Log the LinkedIn post');
    const d = within(dialog);
    expect(d.getByText(`LinkedIn · ${ACTIVATION_TITLE}`)).toBeInTheDocument();                 // the task being logged is named
    expect(d.getByLabelText('Link to the job post')).toBeInTheDocument();
    expect(d.getByLabelText('Weekly sourcing target')).toBeInTheDocument();
    expect(d.getByRole('button', { name: 'Log post' })).toBeDisabled();                         // both are required
    expect(d.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();                  // …and it is not the "target and link" editor
    expect(screen.queryByRole('dialog', { name: 'LinkedIn: target and link' })).not.toBeInTheDocument();
    expect(completeCommitment).not.toHaveBeenCalled();
    expect(updateChannel).not.toHaveBeenCalled();
  });

  it('logging that task sends the link, the target and the posting date against THAT commitment, then re-reads the plan — it never calls the channel editor', async () => {
    mount(view({ channels: [channel({ tracker: noTarget(), commitments: [activation()] })] }));
    await clickAdd();
    const d = within(await screen.findByRole('dialog'));
    fireEvent.change(d.getByLabelText('Link to the job post'), { target: { value: 'https://linkedin.com/jobs/77' } });
    fireEvent.change(d.getByLabelText('Weekly sourcing target'), { target: { value: '18' } });
    fireEvent.click(d.getByRole('button', { name: 'Log post' }));
    await waitFor(() => expect(completeCommitment).toHaveBeenCalledWith('31', expect.objectContaining({ url: 'https://linkedin.com/jobs/77', weekly_target: 18, posted_at: ymd(0), attest: true })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(updateChannel).not.toHaveBeenCalled();
    expect(plan).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledWith('Post logged — weekly tracking is set up');
  });

  it('a server refusal while logging keeps that dialog open with the server\'s message', async () => {
    impl.completeCommitment = refused(400, 'Add a weekly sourcing target (a whole number of applicants, qualified and unqualified) to complete this task');
    mount(view({ channels: [channel({ tracker: noTarget(), commitments: [activation()] })] }));
    await clickAdd();
    const d = within(await screen.findByRole('dialog'));
    fireEvent.change(d.getByLabelText('Link to the job post'), { target: { value: 'https://linkedin.com/jobs/77' } });
    fireEvent.change(d.getByLabelText('Weekly sourcing target'), { target: { value: '18' } });
    fireEvent.click(d.getByRole('button', { name: 'Log post' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/weekly sourcing target/)));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Log the LinkedIn post');
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('Cancel and Escape close the task dialog without sending anything', async () => {
    mount(view({ channels: [channel({ tracker: noTarget(), commitments: [activation()] })] }));
    await clickAdd();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await clickAdd();
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(completeCommitment).not.toHaveBeenCalled();
    expect(updateChannel).not.toHaveBeenCalled();
  });

  it('no open first task: the button opens the "target and link" editor (with its "not being tracked" subtitle), as before', async () => {
    mount(view({ channels: [channel({ tracker: noTarget(), commitments: [commitment({ id: '21', kind: 'renew_posting' })] })] }));    // only the renewal task
    await clickAdd();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('LinkedIn: target and link');
    expect(within(dialog).getByText('No weekly target is set yet, so this channel is not being tracked.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Weekly sourcing target')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Log post' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('a channel with no tasks at all also gets the editor, and saving it sends the target and the link to the channel editor endpoint', async () => {
    mount(view({ channels: [channel({ tracker: noTarget(), commitments: [] })] }));
    await clickAdd();
    const d = within(await screen.findByRole('dialog', { name: 'LinkedIn: target and link' }));
    fireEvent.change(d.getByLabelText('Weekly sourcing target'), { target: { value: '15' } });
    fireEvent.change(d.getByLabelText(/^Link to the job post/), { target: { value: 'https://linkedin.com/jobs/88' } });   // the editor labels it "(optional)"
    fireEvent.click(d.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateChannel).toHaveBeenCalledWith('9', { channel: 'LinkedIn', weekly_target: 15, posting_url: 'https://linkedin.com/jobs/88' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(completeCommitment).not.toHaveBeenCalled();
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it('only an OPEN first task counts: a done, skipped or blocked activation task leaves the editor in charge', async () => {
    for (const status of ['done', 'skipped', 'blocked'] as const) {
      const { unmount } = mount(view({ channels: [channel({ tracker: noTarget(), commitments: [activation({ status })] })] }));
      await clickAdd();
      expect(await screen.findByRole('dialog'), status).toHaveAccessibleName('LinkedIn: target and link');
      unmount();
    }
  });

  it('only a task of kind activate_channel counts: another open task does not turn the button into "log the post"', async () => {
    mount(view({ channels: [channel({ tracker: noTarget(), commitments: [
      commitment({ id: '21', kind: 'renew_posting', status: 'open' }), commitment({ id: '22', kind: 'follow_up', status: 'open' }),
    ] })] }));
    await clickAdd();
    expect(await screen.findByRole('dialog')).toHaveAccessibleName('LinkedIn: target and link');
  });

  it('with several tasks open it picks the activation task, wherever it sits in the list', async () => {
    mount(view({ channels: [channel({ tracker: noTarget(), commitments: [
      commitment({ id: '21', kind: 'renew_posting', status: 'open' }), activation({ id: '22' }), commitment({ id: '23', kind: 'follow_up', status: 'open' }),
    ] })] }));
    await clickAdd();
    const d = within(await screen.findByRole('dialog'));
    fireEvent.change(d.getByLabelText('Link to the job post'), { target: { value: 'https://linkedin.com/jobs/5' } });
    fireEvent.change(d.getByLabelText('Weekly sourcing target'), { target: { value: '9' } });
    fireEvent.click(d.getByRole('button', { name: 'Log post' }));
    await waitFor(() => expect(completeCommitment).toHaveBeenCalledWith('22', expect.objectContaining({ weekly_target: 9 })));
    expect(completeCommitment).toHaveBeenCalledTimes(1);
  });

  it('a channel that HAS a target and still an open first task opens the editor ("Edit target and link"), never the task', async () => {
    mount(view({ channels: [channel({ tracker: tracker({ target: 20 }), commitments: [activation()] })] }));
    await screen.findByTestId('channel-LinkedIn');
    expect(screen.queryByTestId('tracker-no-target')).not.toBeInTheDocument();                                  // no "no target" note at all…
    expect(screen.queryByRole('button', { name: 'Add the target and post link' })).not.toBeInTheDocument();     // …and so no such button
    fireEvent.click(screen.getByRole('button', { name: 'Edit LinkedIn target and link' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('LinkedIn: target and link');
    expect(within(dialog).getByLabelText('Weekly sourcing target')).toHaveValue(20);
    expect(within(dialog).queryByRole('button', { name: 'Log post' })).not.toBeInTheDocument();
    expect(completeCommitment).not.toHaveBeenCalled();
  });

  it('each channel routes by its own tasks: one with an open first task opens the task, its neighbour without one opens the editor', async () => {
    const naukriActivation = activation({ id: '42', title: 'Log the Naukri/IIMjobs post (link and weekly sourcing target)' });
    mount(view({ channels: [
      channel({ id: '1', channel: 'LinkedIn', tracker: noTarget(), commitments: [] }),
      channel({ id: '2', channel: 'Naukri/IIMjobs', tracker: noTarget(), commitments: [naukriActivation] }),
    ] }));
    const linkedin = within(await screen.findByTestId('channel-LinkedIn'));
    const naukri = within(screen.getByTestId('channel-Naukri/IIMjobs'));

    fireEvent.click(naukri.getByRole('button', { name: 'Add the target and post link' }));
    const task = await screen.findByRole('dialog');
    expect(task).toHaveAccessibleName('Log the Naukri/IIMjobs post');
    fireEvent.change(within(task).getByLabelText('Link to the job post'), { target: { value: 'https://naukri.com/job/1' } });
    fireEvent.change(within(task).getByLabelText('Weekly sourcing target'), { target: { value: '30' } });
    fireEvent.click(within(task).getByRole('button', { name: 'Log post' }));
    await waitFor(() => expect(completeCommitment).toHaveBeenCalledWith('42', expect.objectContaining({ url: 'https://naukri.com/job/1', weekly_target: 30 })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(linkedin.getByRole('button', { name: 'Add the target and post link' }));
    expect(await screen.findByRole('dialog')).toHaveAccessibleName('LinkedIn: target and link');
    expect(completeCommitment).toHaveBeenCalledTimes(1);
  });

  it('Direct Outreach logs its campaign the same way: the task opens with the campaign wording', async () => {
    mount(view({ channels: [channel({ channel: 'Direct Outreach', tracker: noTarget(), commitments: [activation({ id: '51', title: 'Log the Direct Outreach campaign (link and weekly sourcing target)' })] })] }));
    await clickAdd();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Log the Direct Outreach post');
    expect(within(dialog).getByLabelText('Link to the outreach campaign or list')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Weekly sourcing target')).toBeInTheDocument();
  });

  it('on a paused plan (role on hold) the button still routes to the open first task, and the tracker note is the "no target" one, not the paused one', async () => {
    mount(view({
      plan: withPlan({ status: 'paused', paused_at: '2026-10-20T00:00:00Z' }),
      channels: [channel({ tracker: noTarget({ anchor: null }), commitments: [activation()] })],
    }));
    expect(await screen.findByTestId('tracker-no-target')).toBeInTheDocument();
    expect(screen.queryByTestId('tracker-paused')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument();         // the plain task buttons stay off while the plan is paused
    await clickAdd();
    expect(await screen.findByRole('dialog')).toHaveAccessibleName('Log the LinkedIn post');
  });

  it('a Hiring Manager (read-only view) never gets the button, whatever the channel has open', async () => {
    h.state.auth = hm;
    mount(view({ read_only: true, channels: [channel({ tracker: noTarget(), commitments: [activation()] })] }));
    expect(await screen.findByTestId('tracker-no-target')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add the target and post link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('SourcingPlanPanel — the weekly tracker while the role is on hold', () => {
  const pausedView = (ch: SourcingPlanChannel) => view({ plan: withPlan({ status: 'paused', paused_at: '2026-10-20T00:00:00Z' }), channels: [ch] });

  it('a live channel with a target but no running week says the tracker is stopped, and offers no task buttons', async () => {
    mount(pausedView(channel({ tracker: tracker({ anchor: null, running: null, weeks: [week({ week_start: '2026-10-19', week_end: '2026-10-20', actual: 3, partial: true, met: false })] }) })));
    const note = await screen.findByTestId('tracker-paused');
    expect(note).toHaveTextContent('The weekly tracker is stopped while the role is on hold');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('tracker-week')).getByText('Cut short')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument();
  });

  it('the same channel on an active plan shows its running week and no stopped note', async () => {
    mount(view({ channels: [channel()] }));
    expect(await screen.findByTestId('tracker-running')).toBeInTheDocument();
    expect(screen.queryByTestId('tracker-paused')).not.toBeInTheDocument();
  });
});

// ═══ the "Needs attention" next steps ════════════════════════════════════════════════════════════════
describe('SourcingPlanPanel — recommended next steps', () => {
  const two = () => view({ exceptions: [exception(), exception({ id: '6', channel: 'LinkedIn', type: 'COMMITMENT_OVERDUE', committed: 'LinkedIn: renew the posting', happened: 'Due 3 days ago', next_action: 'Renew the posting' })] });

  it('while the advice is being worked out the box says so and each problem shows its plain next action with a "working out" note', async () => {
    impl.advice = () => new Promise(() => {});
    mount(two());
    const box = await screen.findByTestId('advice-box');
    expect(within(box).getByText('Working out what to do next from the pipeline, targets and channels…')).toBeInTheDocument();
    const nexts = screen.getAllByTestId('exception-next');
    expect(nexts).toHaveLength(2);
    expect(within(nexts[0]).getByText('Choose the agencies')).toBeInTheDocument();
    expect(within(nexts[0]).getByText(/working out detailed steps…/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
  });

  it('with no exceptions, plan-level steps alone give the box a "Next steps" heading and the headline', async () => {
    impl.advice = ok({ enabled: true, advice: adviceBody({}, { steps: [step({ id: 's9', exception_id: null, title: 'Re-post the role on Naukri this week', channel: 'Naukri/IIMjobs' })] }).data.advice });
    mount(view());
    expect(await screen.findByRole('heading', { name: 'Next steps' })).toBeInTheDocument();
    const box = within(screen.getByTestId('advice-box'));
    expect(await box.findByText('Two things will close the gap')).toBeInTheDocument();
    expect(box.getByText('Re-post the role on Naukri this week')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument();
  });

  it('puts each step under the problem it was written for (by exception_id) and the plan-level ones (null) in the box — never both', async () => {
    impl.advice = ok(adviceBody({}, { steps: [
      step({ id: 's1', exception_id: '5', title: 'Send the brief to two agencies today' }),
      step({ id: 's2', exception_id: '6', title: 'Renew the LinkedIn post and re-share it', channel: 'LinkedIn', impact: 'medium' }),
      step({ id: 's3', exception_id: null, title: 'Ask Alex for two referral names', channel: null, impact: 'low', owner: 'Hiring Manager' }),
    ] }).data);
    mount(two());
    const box = within(await screen.findByTestId('advice-box'));
    expect(await box.findByText('Two things will close the gap')).toBeInTheDocument();
    const [first, second] = screen.getAllByTestId('exception-next').map(n => within(n));
    expect(first.getByText('Send the brief to two agencies today')).toBeInTheDocument();
    expect(first.getByText('High impact')).toBeInTheDocument();
    expect(first.queryByText('Renew the LinkedIn post and re-share it')).not.toBeInTheDocument();
    expect(first.queryByText('Ask Alex for two referral names')).not.toBeInTheDocument();
    expect(first.queryByText('Choose the agencies')).not.toBeInTheDocument();             // the steps replace the plain next action
    expect(second.getByText('Renew the LinkedIn post and re-share it')).toBeInTheDocument();
    expect(second.getByText('Medium impact')).toBeInTheDocument();
    expect(second.queryByText('Send the brief to two agencies today')).not.toBeInTheDocument();
    expect(box.getByText('Ask Alex for two referral names')).toBeInTheDocument();
    expect(box.getByText('Needs the Hiring Manager')).toBeInTheDocument();
    expect(box.getByText('Low impact')).toBeInTheDocument();
    expect(box.queryByText('Send the brief to two agencies today')).not.toBeInTheDocument();
    expect(box.queryByText('Renew the LinkedIn post and re-share it')).not.toBeInTheDocument();
    // a problem the advisor wrote nothing for keeps its plain next action
    expect(screen.queryByText(/working out detailed steps/)).not.toBeInTheDocument();
  });

  it('a step written for an exception that is no longer listed (resolved since the advice was cached) is not shown anywhere', async () => {
    impl.advice = ok(adviceBody({}, { steps: [step({ id: 's7', exception_id: '99', title: 'Chase the long-gone agency' })] }).data);
    mount(view({ exceptions: [exception()] }));
    await screen.findByText('Two things will close the gap');
    expect(screen.queryByText('Chase the long-gone agency')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('exception-next')).getByText('Choose the agencies')).toBeInTheDocument();
  });

  it('lists what to keep an eye on', async () => {
    impl.advice = ok(adviceBody({}, { watch: ['Weekly shortlist rate', 'Naukri response time'] }).data);
    mount(view({ exceptions: [exception()] }));
    expect(await screen.findByText(/Weekly shortlist rate · Naukri response time/)).toBeInTheDocument();
    expect(screen.getByText('Keep an eye on:')).toBeInTheDocument();
  });

  it('says whether the steps were written by AI or by rules, how old they are, and warns when the numbers have moved on', async () => {
    impl.advice = ok(adviceBody().data);
    const ai = mount(view({ exceptions: [exception()] }));
    expect(await screen.findByText(/Written by AI from this role’s pipeline, targets and channels · about 1 hour ago/)).toBeInTheDocument();
    expect(screen.queryByText(/Rule-based steps/)).not.toBeInTheDocument();
    expect(screen.queryByText(/The numbers have changed since/)).not.toBeInTheDocument();
    ai.unmount();

    impl.advice = ok(adviceBody({ source: 'rules', model: null, stale: true }).data);
    mount(view({ exceptions: [exception()] }));
    expect(await screen.findByText(/Rule-based steps \(the AI writer is unavailable right now\) · about 1 hour ago/)).toBeInTheDocument();
    expect(screen.queryByText(/Written by AI/)).not.toBeInTheDocument();
    expect(screen.getByText('The numbers have changed since — refreshing soon')).toBeInTheDocument();
  });

  it('Refresh asks for a new answer (advice(roleId, true)), is disabled while it works and then shows the new steps', async () => {
    let release!: (v: unknown) => void;
    impl.advice = async (_id: unknown, refresh?: unknown) => refresh ? new Promise(res => { release = res; }) : adviceBody();
    mount(view({ exceptions: [exception()] }));
    expect(await screen.findByText('Two things will close the gap')).toBeInTheDocument();
    expect(advice).toHaveBeenLastCalledWith('R5');
    const refresh = screen.getByRole('button', { name: 'Refresh the next steps' });
    fireEvent.click(refresh);
    await waitFor(() => expect(advice).toHaveBeenLastCalledWith('R5', true));
    await waitFor(() => expect(refresh).toBeDisabled());
    expect(refresh).toHaveTextContent('Refreshing…');
    release(adviceBody({ source: 'rules', model: null }, { headline: 'Agencies are the quickest way to close the gap', steps: [step({ id: 'n1', title: 'Call the agency partner today' })] }));
    expect(await screen.findByText('Agencies are the quickest way to close the gap')).toBeInTheDocument();
    expect(within(screen.getByTestId('exception-next')).getByText('Call the agency partner today')).toBeInTheDocument();
    expect(screen.queryByText('Send the brief to two agencies today')).not.toBeInTheDocument();
    expect(screen.getByText(/Rule-based steps/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh the next steps' })).toBeEnabled();
  });

  it('a failed Refresh says so and keeps the steps that were showing', async () => {
    impl.advice = async (_id: unknown, refresh?: unknown) => { if (refresh) throw { response: { status: 429 } }; return adviceBody(); };
    mount(view({ exceptions: [exception()] }));
    await screen.findByText('Two things will close the gap');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh the next steps' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not refresh the next steps'));
    expect(screen.getByText('Two things will close the gap')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh the next steps' })).toBeEnabled();
  });

  it('if the advice cannot be loaded each problem still shows its plain next action, and the box says the detail is unavailable', async () => {
    impl.advice = fail({ response: { status: 500 } });
    mount(two());
    expect(await screen.findByText('The detailed next steps could not be loaded; each problem still shows its next action.')).toBeInTheDocument();
    const nexts = screen.getAllByTestId('exception-next');
    expect(within(nexts[0]).getByText('Choose the agencies')).toBeInTheDocument();
    expect(within(nexts[1]).getByText('Renew the posting')).toBeInTheDocument();
    expect(screen.queryByText(/working out detailed steps/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh the next steps' })).not.toBeInTheDocument();      // nothing to refresh yet
  });

  it('when no advice has been produced yet (null) the plain next action stays and the "working out" note goes away', async () => {
    impl.advice = ok({ enabled: true, advice: null });
    mount(view({ exceptions: [exception()] }));
    await screen.findByTestId('exception-next');
    await waitFor(() => expect(advice).toHaveBeenCalledWith('R5'));
    await waitFor(() => expect(screen.queryByText(/working out detailed steps/)).not.toBeInTheDocument());
    expect(within(screen.getByTestId('exception-next')).getByText('Choose the agencies')).toBeInTheDocument();
    expect(screen.queryByText(/Written by AI|Rule-based steps/)).not.toBeInTheDocument();
  });

  it('asks for advice on an active or paused plan (HR-tier) but never for a draft, a closed plan or a Hiring Manager', async () => {
    const paused = mount(view({ plan: withPlan({ status: 'paused' }), exceptions: [exception()] }));
    await screen.findByText('Paused (role on hold)');
    await waitFor(() => expect(advice).toHaveBeenCalledTimes(1));
    paused.unmount();
    advice.mockClear();

    const draft = mount(draftView({ exceptions: [exception({ id: '8', channel: '*', type: 'PLAN_NOT_ACTIVATED' })] }));
    await screen.findByText(/Draft — not tracked yet/);
    draft.unmount();
    mount(view({ plan: withPlan({ status: 'closed' }) }));
    await screen.findByText('Closed', { selector: 'span' });
    expect(advice).not.toHaveBeenCalled();
  });

  it('a draft plan\'s exceptions show their plain next action (the advisor only works on an active or paused plan)', async () => {
    mount(draftView({ exceptions: [exception({ id: '8', channel: '*', type: 'PLAN_NOT_ACTIVATED', next_action: 'Activate the plan' })] }));
    await screen.findByText('Plan not activated');
    expect(within(screen.getByTestId('exception-next')).getByText('Activate the plan')).toBeInTheDocument();
    expect(screen.queryByText(/working out detailed steps/)).not.toBeInTheDocument();
  });

  // BUG (reported, not fixed here): for HR the "advice box" is rendered whenever there is a live exception, even when there is nothing to put in it
  // (a draft plan never asks for advice; a plan whose advice is null or failed to load with no failure text) — an empty tinted box with only the sparkle icon.
  it('a draft plan with an exception does not show an empty advice box', async () => {
    mount(draftView({ exceptions: [exception({ id: '8', channel: '*', type: 'PLAN_NOT_ACTIVATED', next_action: 'Activate the plan' })] }));
    await screen.findByText('Plan not activated');
    expect(screen.queryByTestId('advice-box')).not.toBeInTheDocument();
  });

  it('completing or resolving something re-reads the advice too (its facts have changed)', async () => {
    mount(view({ exceptions: [exception()] }));
    await waitFor(() => expect(advice).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve…' }));
    const d = within(await screen.findByRole('dialog'));
    fireEvent.change(d.getAllByRole('textbox')[0], { target: { value: 'Sending the brief tomorrow' } });
    fireEvent.click(d.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(resolveException).toHaveBeenCalled());
    await waitFor(() => expect(advice.mock.calls.length).toBeGreaterThan(1));
  });
});
