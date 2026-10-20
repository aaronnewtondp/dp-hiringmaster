import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SourcingCommitment, SourcingException, SourcingPlanChannel, SourcingPlanView } from '../../types/sourcing.ts';
import { ymd } from '../../utils/sourcingFormat.ts';

const plan = vi.fn();
const people = vi.fn();
const activate = vi.fn();
const completeCommitment = vi.fn();
const skipCommitment = vi.fn();
const resolveException = vi.fn();
const setChannel = vi.fn();
const reopenCommitment = vi.fn();
const updatePlan = vi.fn();
vi.mock('../../services/api.ts', () => ({
  sourcingApi: {
    plan: (id: string) => plan(id), people: () => people(),
    activate: (id: string, d: unknown) => activate(id, d),
    completeCommitment: (id: string, d: unknown) => completeCommitment(id, d),
    skipCommitment: (id: string, r: string) => skipCommitment(id, r),
    resolveException: (id: string, d: unknown) => resolveException(id, d),
    setChannel: (id: string, d: unknown) => setChannel(id, d),
    reopenCommitment: (id: string) => reopenCommitment(id),
    updatePlan: (id: string, d: unknown) => updatePlan(id, d),
  },
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

let auth = { user: { id: 'u1', name: 'Aaron Newton', email: 'a@x.com', persona: 'hr_recruiter' }, canHR: true };
vi.mock('../../contexts/AuthContext.tsx', () => ({ useAuth: () => auth }));

import SourcingCard from './SourcingCard.tsx';

const commitment = (over: Partial<SourcingCommitment> = {}): SourcingCommitment => ({
  id: '11', kind: 'renew_posting', title: 'Renew the LinkedIn posting before it expires', due_at: '2026-11-10T18:29:59Z', due_date: ymd(20),
  status: 'open', cadence_days: 30, last_done_at: null, meta: {}, overdue: false, evidence: { auto: 0, self: 0 }, recent: [], ...over,
});
const channel = (over: Partial<SourcingPlanChannel> = {}): SourcingPlanChannel => ({
  id: '1', channel: 'LinkedIn', state: 'active', excluded_reason: null, config: {}, targets: {}, commitments: [commitment()], ...over,
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
          activated_at: '2026-10-10T00:00:00Z', paused_at: null, pause_total_days: 0, closed_at: null },
  role: { id: 'R5', title: 'QA Engineer', priority: 'P1', status: 'Live – Sourcing', num_openings: 1, hiring_manager_name: 'Alex', recruitment_mode: ['LinkedIn'], approval_date: '2026-10-01' },
  channels: [channel()], exceptions: [], changes: [],
  volume: { weekly_qualified: 3, shortlisted: 1, scored: 3, min: 5, rule: 'either', applicable: true },
  output: [], attribution_reliable: {}, settings: { go_live_date: '2026-10-01', qualified_rule: 'either', shadow_until: null },
  ...over,
});

function mount(v: unknown) {
  plan.mockResolvedValue({ data: v });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><SourcingCard roleId="R5" /></MemoryRouter></QueryClientProvider>);
}
const hr = { user: { id: 'u1', name: 'Aaron Newton', email: 'a@x.com', persona: 'hr_recruiter' }, canHR: true };
const hm = { user: { id: 'u9', name: 'Alex', email: 'al@x.com', persona: 'hiring_manager' }, canHR: false };

beforeEach(() => {
  for (const m of [plan, people, activate, completeCommitment, skipCommitment, resolveException, setChannel, reopenCommitment, updatePlan]) m.mockReset();
  people.mockResolvedValue({ data: { people: [{ id: 'u1', name: 'Aaron Newton', persona: 'super_admin' }, { id: 'u2', name: 'Garima', persona: 'hr_recruiter' }] } });
  for (const m of [activate, completeCommitment, skipCommitment, resolveException, setChannel, reopenCommitment, updatePlan]) m.mockResolvedValue({ data: { success: true } });
  auth = hr;
});

describe('SourcingCard — when it shows', () => {
  it('renders nothing while the module is off, when there is no plan, or when the server refuses (a Hiring Manager of another role)', async () => {
    const off = mount({ enabled: false });
    await waitFor(() => expect(plan).toHaveBeenCalled());
    await waitFor(() => expect(off.container).toBeEmptyDOMElement());
    off.unmount();

    const none = mount({ enabled: true, plan: null });
    await waitFor(() => expect(none.container).toBeEmptyDOMElement());
    none.unmount();

    plan.mockRejectedValue({ response: { status: 403 } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const refused = render(<QueryClientProvider client={qc}><MemoryRouter><SourcingCard roleId="R5" /></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(refused.container).toBeEmptyDOMElement());
  });

  it('a draft plan says nothing is tracked yet and offers Activate to HR only', async () => {
    const v = view({ plan: { ...view().plan!, status: 'draft' }, channels: [channel({ state: 'planned', commitments: [] })] });
    const first = mount(v);
    expect(await screen.findByText(/Draft — not tracked yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activate plan' })).toBeInTheDocument();
    first.unmount();

    auth = hm;
    mount({ ...v, read_only: true });
    expect(await screen.findByText(/has not been activated yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate plan' })).not.toBeInTheDocument();
  });
});

describe('SourcingCard — an active plan', () => {
  it('shows HR as the owner (never a person), volume with both qualified components, the exception in plain words and the channel commitments', async () => {
    mount(view({ exceptions: [exception()] }));
    expect(await screen.findByText('Owner:')).toBeInTheDocument();
    expect(screen.getByText('HR')).toBeInTheDocument();
    expect(screen.queryByText('Aaron Newton')).not.toBeInTheDocument();
    expect(screen.getByText(/qualified in the last 7 days/)).toBeInTheDocument();
    expect(screen.getByText('1 shortlisted · 3 scored above 60')).toBeInTheDocument();
    expect(screen.getByText('Channel not live')).toBeInTheDocument();
    expect(screen.getByText('Not done — 2 days overdue')).toBeInTheDocument();
    expect(screen.getByText('Choose the agencies')).toBeInTheDocument();
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

  it('a Hiring Manager gets a View-only card: no actions, no history, no source table', async () => {
    auth = hm;
    // a skipped commitment, a channel that was left out and a strategy note are all present, so every absence below is a real one
    mount(view({ read_only: true, exceptions: [exception()], changes: [{ at: '2026-10-10T00:00:00Z', by_name: 'x', change: { type: 'activated' }, reason: null }],
                 output: [{ tag: 'LinkedIn', applications: 9, qualified: 4 }],
                 plan: { ...view().plan!, strategy_note: 'Quietly prefer service engineers' },
                 channels: [channel({ commitments: [commitment({ id: '31', status: 'skipped' })] }), channel({ id: '2', channel: 'Agency', state: 'excluded', excluded_reason: 'No budget', commitments: [] })] }));
    expect(await screen.findByText('View only')).toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();                                  // the skipped row is on screen…
    expect(screen.getByText('Not used')).toBeInTheDocument();                                 // …and so is the channel that was left out
    expect(screen.queryByText(/Quietly prefer service engineers/)).not.toBeInTheDocument();
    expect(screen.getByText('Channel not live')).toBeInTheDocument();
    for (const name of [/Mark done/, /Skip/, /Resolve/, /Stop using/, /Activate plan/, /Plan history/, /Add channel/, /Edit strategy note/, /Bring back/, /Undo skip/]) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByText('Applications by source')).not.toBeInTheDocument();
    expect(screen.queryByText(/View posting/)).not.toBeInTheDocument();
  });

  it('applications by source flag a tag with too few applications to judge, and rename the untagged bucket', async () => {
    mount(view({ output: [{ tag: 'LinkedIn', applications: 3, qualified: 1 }, { tag: 'untagged_default', applications: 40, qualified: 12 }] }));
    expect(await screen.findByText('Applications by source')).toBeInTheDocument();
    expect(screen.getByText(/too few to judge/)).toBeInTheDocument();
    expect(screen.getByText('Not tagged')).toBeInTheDocument();
  });
});

describe('SourcingCard — wording that must not promise an owner or leak to the Hiring Manager', () => {
  it('the server\'s "(untagged)" bucket reads "Not tagged" like the stamped one, and is never called "too few to judge"', async () => {
    mount(view({ output: [{ tag: '(untagged)', applications: 3, qualified: 1 }, { tag: 'untagged_default', applications: 40, qualified: 12 }] }));
    await screen.findByText('Applications by source');
    expect(screen.getAllByText('Not tagged')).toHaveLength(2);
    expect(screen.queryByText('(untagged)')).not.toBeInTheDocument();
    expect(screen.queryByText(/too few to judge/)).not.toBeInTheDocument();
  });

  it('a draft plan says nothing about assigning an owner (there is none: HR owns it as a whole)', async () => {
    mount(view({ plan: { ...view().plan!, status: 'draft' }, channels: [channel({ state: 'planned', commitments: [] })] }));
    const note = await screen.findByText(/Nothing is being tracked for this role yet/);
    expect(note.textContent).toMatch(/no individual owner to assign/);
    expect(note.textContent).not.toMatch(/assigns an owner/);
  });

  it('the activation dialog\'s strategy-note hint says the Hiring Manager does NOT see the note', async () => {
    mount(view({ plan: { ...view().plan!, status: 'draft' }, channels: [channel({ state: 'planned', commitments: [] })] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Activate plan' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/The Hiring Manager does not see it/)).toBeInTheDocument();
    expect(dialog.queryByText(/Hiring Manager or leadership should know/)).not.toBeInTheDocument();
  });
});

describe('SourcingCard — doing things', () => {
  it('Mark done sends an attestation for that commitment, then reloads the plan', async () => {
    mount(view());
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(completeCommitment).toHaveBeenCalledWith('11', expect.objectContaining({ attest: true })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(plan).toHaveBeenCalledTimes(2);                                              // refetched
  });

  it('a portal activation asks for the posting date (defaulting to today) and sends it', async () => {
    const act = commitment({ id: '12', kind: 'activate_channel', title: 'Publish the posting on LinkedIn', cadence_days: null });
    mount(view({ channels: [channel({ state: 'planned', commitments: [act] })] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Link (optional)'), { target: { value: 'https://linkedin.com/jobs/1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(completeCommitment).toHaveBeenCalledWith('12', expect.objectContaining({ posted_at: ymd(0), url: 'https://linkedin.com/jobs/1' })));
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
  });

  it('a server refusal keeps the dialog open and shows the server\'s message', async () => {
    const toast = (await import('react-hot-toast')).default;
    completeCommitment.mockRejectedValue({ response: { data: { error: 'Evidence URL must be a valid http(s) link' } } });
    mount(view());
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Evidence URL must be a valid http(s) link'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
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
    fireEvent.click(d.getByLabelText('Stop using Agency for this role'));
    fireEvent.change(d.getAllByRole('textbox')[0], { target: { value: 'Agencies are not right for this role' } });
    fireEvent.click(d.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(resolveException).toHaveBeenCalledWith('5', expect.objectContaining({ path: 'change_strategy', exclude_channel: true })));
  });

  it('a plan-level exception (no channel) offers no "stop using" option', async () => {
    mount(view({ exceptions: [exception({ id: '8', channel: '*', type: 'PLAN_NOT_ACTIVATED' })] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve…' }));
    const d = within(await screen.findByRole('dialog'));
    fireEvent.click(d.getByRole('radio', { name: /Change the plan/ }));
    expect(d.queryByText(/Stop using/)).not.toBeInTheDocument();
  });
});

describe('Activate plan', () => {
  const draft = () => view({
    plan: { ...view().plan!, status: 'draft' },
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

  it('leaving out a seeded channel requires a reason; the payload carries channels, attestation and the exclusion — and no owner', async () => {
    const d = await open();
    const go = d.getByRole('button', { name: 'Activate plan' });
    fireEvent.click(d.getByRole('checkbox', { name: /Agency/ }));                         // untick a seeded channel
    expect(go).toBeDisabled();
    expect(d.getByText(/Say why Agency is not being used/)).toBeInTheDocument();
    fireEvent.change(d.getByLabelText('Reason for not using Agency'), { target: { value: 'No budget for agency fees' } });
    expect(go).toBeEnabled();

    fireEvent.click(d.getByRole('checkbox', { name: 'Already running before today' }));  // LinkedIn is already live
    fireEvent.change(d.getByLabelText('LinkedIn posting date'), { target: { value: '2026-10-01' } });
    fireEvent.click(go);
    await waitFor(() => expect(activate).toHaveBeenCalledWith('9', {
      strategy_note: null,
      channels: [
        { channel: 'LinkedIn', already_running: true, posted_at: '2026-10-01' },
        { channel: 'Agency', exclude_reason: 'No budget for agency fees' },
      ],
    }));
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

  it('direct outreach takes an optional weekly target (never defaulted)', async () => {
    const d = await open();
    fireEvent.click(d.getByRole('checkbox', { name: /Direct Outreach/ }));
    const target = d.getByLabelText('Weekly unique-contact target');
    expect(target).toHaveValue(null);
    fireEvent.change(target, { target: { value: '25' } });
    fireEvent.click(d.getByRole('button', { name: 'Activate plan' }));
    await waitFor(() => expect(activate).toHaveBeenCalled());
    const sent = activate.mock.calls[0][1] as { channels: Array<{ channel: string; weekly_target?: number }> };
    expect(sent.channels.find(c => c.channel === 'Direct Outreach')?.weekly_target).toBe(25);
  });
});

// ─── The controls an active plan used to lack: add a channel, bring one back, undo a skip, edit the strategy note ───
describe('SourcingCard — managing a running plan', () => {
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
    const toast = (await import('react-hot-toast')).default;
    reopenCommitment.mockRejectedValue({ response: { data: { error: 'The plan is not active' } } });
    mount(view({ channels: [channel({ commitments: [skippedFollowOn()] })] }));
    fireEvent.click(await screen.findByRole('button', { name: /Undo skip/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The plan is not active'));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
  });

  it('Edit strategy note: Save stays off until something changes, then sends only the note — there is no owner field', async () => {
    mount(view());
    fireEvent.click(await screen.findByRole('button', { name: 'Edit strategy note' }));
    const d = within(await screen.findByRole('dialog'));
    expect(d.queryByLabelText('Sourcing owner')).not.toBeInTheDocument();
    const save = d.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(d.getByLabelText(/Strategy note/), { target: { value: 'Focus on service engineers' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(updatePlan).toHaveBeenCalledWith('9', { strategy_note: 'Focus on service engineers' }));
  });

  it('Edit strategy note: clearing the note sends null', async () => {
    mount(view({ plan: { ...view().plan!, strategy_note: 'Focus on service engineers' } }));
    expect(await screen.findByText(/Focus on service engineers/)).toBeInTheDocument();       // the note is visible to HR on the card
    fireEvent.click(screen.getByRole('button', { name: 'Edit strategy note' }));
    const d = within(await screen.findByRole('dialog'));
    fireEvent.change(d.getByLabelText(/Strategy note/), { target: { value: '   ' } });
    fireEvent.click(d.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updatePlan).toHaveBeenCalledWith('9', { strategy_note: null }));
  });

  it('a draft or closed plan offers none of these (a draft chooses its channels when it is activated; a closed one is finished)', async () => {
    const draft = mount(view({ plan: { ...view().plan!, status: 'draft' }, channels: [channel({ state: 'planned', commitments: [] }), channel({ id: '2', channel: 'Agency', state: 'excluded', excluded_reason: 'No budget', commitments: [] })] }));
    await screen.findByText(/Draft — not tracked yet/);
    expect(screen.getByText('Not used')).toBeInTheDocument();                                 // an excluded channel IS shown, and still has no Bring back
    for (const name of [/Add channel/, /Edit strategy note/, /Bring back/]) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    draft.unmount();
    mount(view({ plan: { ...view().plan!, status: 'closed' }, channels: [channel({ commitments: [skippedFollowOn()] }), channel({ id: '2', channel: 'Agency', state: 'excluded', excluded_reason: 'No budget', commitments: [] })] }));
    await screen.findByText('Closed');
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText('Not used')).toBeInTheDocument();
    for (const name of [/Add channel/, /Edit strategy note/, /Bring back/, /Undo skip/]) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('a paused plan can still take a channel or bring one back, says its clock starts when the role is back on, and offers no commitment actions', async () => {
    mount(view({
      plan: { ...view().plan!, status: 'paused' },
      channels: [channel({ commitments: [skippedFollowOn(), commitment({ id: '41', title: 'Another open task' })] }),
                 channel({ id: '2', channel: 'Agency', state: 'excluded', excluded_reason: 'No budget', commitments: [] })],
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add channel' }));
    const d = within(await screen.findByRole('dialog'));
    expect(d.getByText(/starts when the role is back on/)).toBeInTheDocument();
    fireEvent.click(d.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Bring back Agency' })).toBeInTheDocument();    // a tracked plan, so a left-out channel can come back
    for (const name of [/Undo skip/, /Mark done/, /^Skip/]) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();   // commitments of a paused plan are not editable
  });

  it('a refused Add channel (409: another tab got there first) tells the user, closes the dialog and re-reads the plan', async () => {
    const toast = (await import('react-hot-toast')).default;
    setChannel.mockRejectedValue({ response: { status: 409, data: { error: 'Agency is already in this plan' } } });
    mount(view());
    fireEvent.click(await screen.findByRole('button', { name: 'Add channel' }));
    const d = within(await screen.findByRole('dialog'));
    fireEvent.click(d.getByRole('radio', { name: /Agency/ }));
    fireEvent.click(d.getByRole('button', { name: 'Add channel' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Agency is already in this plan'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it('focus stays in the field being typed in when the card re-renders behind the dialog (it used to be pulled back to the dialog frame)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // the second read DIFFERS (a new qualified count), so the card really re-renders — identical data would be structurally shared and skip it
    plan.mockResolvedValueOnce({ data: view() });
    plan.mockResolvedValue({ data: view({ volume: { weekly_qualified: 4, shortlisted: 2, scored: 4, min: 5, rule: 'either', applicable: true } }) });
    render(<QueryClientProvider client={qc}><MemoryRouter><SourcingCard roleId="R5" /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit strategy note' }));
    const note = within(await screen.findByRole('dialog')).getByLabelText(/Strategy note/);
    note.focus();
    expect(document.activeElement).toBe(note);
    await qc.invalidateQueries({ queryKey: ['sourcing-plan', 'R5'] });                         // a background refetch re-renders the card
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('2 shortlisted · 4 scored above 60')).toBeInTheDocument());      // the re-render happened
    expect(document.activeElement).toBe(note);
  });
});
const SOURCING_ALL = ['LinkedIn', 'Naukri/IIMjobs', 'Agency', 'Internal Referral', 'Direct Outreach'];
