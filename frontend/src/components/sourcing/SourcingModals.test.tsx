import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import toast from 'react-hot-toast';
import type { ChannelState, SourcingPlan, SourcingPlanChannel } from '../../types/sourcing.ts';
import { ymd } from '../../utils/sourcingFormat.ts';

// Plain functions that record their calls on a vi.fn() and then run a swappable implementation: a failing call is a plain async function that
// throws, because a vi.fn() spy re-throws a rejected result on a derived promise, which vitest reports as an unhandled error.
const h = vi.hoisted(() => {
  const NAMES = ['activate', 'completeCommitment', 'skipCommitment', 'closeChannel', 'reopenChannel', 'updateChannel', 'updatePlan', 'setChannel', 'people'] as const;
  type Name = typeof NAMES[number];
  const spies = {} as Record<Name, ReturnType<typeof vi.fn>>;
  const impl = {} as Record<Name, (...a: unknown[]) => Promise<unknown>>;
  const api: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
  for (const n of NAMES) { spies[n] = vi.fn(); api[n] = (...a: unknown[]) => { spies[n](...a); return impl[n](...a); }; }
  return { NAMES, spies, impl, api };
});
vi.mock('../../services/api.ts', () => ({ sourcingApi: h.api }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Aaron Newton', email: 'a@x.com', persona: 'hr_recruiter' }, canHR: true }) }));

import {
  ActivatePlanModal, AddChannelModal, CloseChannelModal, CompleteCommitmentModal, EditChannelModal, EditPlanModal, ReopenChannelModal, SkipCommitmentModal,
} from './SourcingModals.tsx';

const { spies, impl } = h;
const { activate, completeCommitment, skipCommitment, closeChannel, reopenChannel, updateChannel, updatePlan, setChannel } = spies;
const ok = () => async () => ({ data: { success: true } });
const fail = (err: unknown) => async () => { throw err; };
const refused = (status: number, error: string) => fail({ response: { status, data: { error } } });

const onClose = vi.fn();
const onDone = vi.fn();
const wrap = (el: ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>);
const dialog = () => within(screen.getByRole('dialog'));

beforeEach(() => {
  for (const n of h.NAMES) { spies[n].mockReset(); impl[n] = ok(); }
  onClose.mockReset(); onDone.mockReset();
  vi.mocked(toast.error).mockClear(); vi.mocked(toast.success).mockClear();
});

const plan = (over: Partial<SourcingPlan> = {}): SourcingPlan => ({
  id: '9', role_id: 'R5', status: 'draft', strategy_note: null, baseline: null, baseline_at: null, activated_at: null, paused_at: null, pause_total_days: 0, closed_at: null,
  weekly_qualified_target: null, ...over,
});
const ch = (channel: string, state: ChannelState = 'planned', excluded_reason: string | null = null): SourcingPlanChannel => ({
  id: channel, channel, state, excluded_reason, closed_at: state === 'closed' ? '2026-10-18T08:00:00Z' : null, closed_reason: state === 'closed' ? 'Done' : null, config: {}, targets: {},
  tracker: { applicable: false, target: null, anchor: null, link: null, running: null, weeks: [], totals: { weeks: 0, met: 0, actual: 0, target: 0 }, sourced: { applications: 0, qualified: 0 } },
  commitments: [],
});

const typeInto = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

// ═══ ActivatePlanModal ═══════════════════════════════════════════════════════════════════════════════
describe('ActivatePlanModal', () => {
  const open = (channels: SourcingPlanChannel[] = [ch('LinkedIn')], props: Partial<Parameters<typeof ActivatePlanModal>[0]> = {}) =>
    wrap(<ActivatePlanModal plan={plan()} channels={channels} defaultTarget={5} onClose={onClose} onDone={onDone} {...props} />);
  const activateBtn = () => dialog().getByRole('button', { name: 'Activate plan' });
  const status = () => dialog().queryByRole('status');
  const runningBoxes = () => dialog().getAllByRole('checkbox', { name: 'Already running before today' });

  describe('an already-running channel that is tracked (LinkedIn, Naukri/IIMjobs, Direct Outreach)', () => {
    it('needs the post link AND a whole-number weekly sourcing target: the button stays disabled, with the reason as its title and a status line', () => {
      open();
      expect(activateBtn()).toBeEnabled();                                                   // not running before today: nothing more is asked
      fireEvent.click(runningBoxes()[0]);
      const reason = 'LinkedIn: add the post link and a whole-number weekly sourcing target for what is already running.';
      expect(activateBtn()).toBeDisabled();
      expect(activateBtn()).toHaveAttribute('title', reason);
      expect(status()).toHaveTextContent(reason);

      typeInto(dialog().getByLabelText('LinkedIn post link'), 'https://linkedin.com/jobs/1');
      expect(activateBtn()).toBeDisabled();                                                  // the target is still missing
      typeInto(dialog().getByLabelText('LinkedIn weekly sourcing target'), '20');
      expect(activateBtn()).toBeEnabled();
      expect(activateBtn()).not.toHaveAttribute('title');
      expect(status()).not.toBeInTheDocument();
    });

    it('a target alone is not enough either', () => {
      open();
      fireEvent.click(runningBoxes()[0]);
      typeInto(dialog().getByLabelText('LinkedIn weekly sourcing target'), '20');
      expect(activateBtn()).toBeDisabled();
    });

    it.each([['0'], ['2.5'], ['-3'], [''], ['10001']])('rejects a weekly sourcing target of "%s"', (bad) => {
      open();
      fireEvent.click(runningBoxes()[0]);
      typeInto(dialog().getByLabelText('LinkedIn post link'), 'https://linkedin.com/jobs/1');
      typeInto(dialog().getByLabelText('LinkedIn weekly sourcing target'), bad);
      expect(activateBtn()).toBeDisabled();
    });

    it.each([['1'], ['10000']])('accepts a weekly sourcing target of %s (the range is 1 to 10000)', (good) => {
      open();
      fireEvent.click(runningBoxes()[0]);
      typeInto(dialog().getByLabelText('LinkedIn post link'), 'https://linkedin.com/jobs/1');
      typeInto(dialog().getByLabelText('LinkedIn weekly sourcing target'), good);
      expect(activateBtn()).toBeEnabled();
    });

    it.each([['linkedin.com/jobs/1'], ['ftp://linkedin.com/jobs/1'], ['not a link']])('rejects the post link "%s" (it must be an http(s) address)', (bad) => {
      open();
      fireEvent.click(runningBoxes()[0]);
      typeInto(dialog().getByLabelText('LinkedIn post link'), bad);
      typeInto(dialog().getByLabelText('LinkedIn weekly sourcing target'), '20');
      expect(activateBtn()).toBeDisabled();
    });

    it('names every channel that is still incomplete, and drops each one from the message once it is complete', () => {
      open([ch('LinkedIn'), ch('Naukri/IIMjobs')]);
      for (const box of runningBoxes()) fireEvent.click(box);
      expect(status()).toHaveTextContent('LinkedIn, Naukri/IIMjobs: add the post link and a whole-number weekly sourcing target');
      typeInto(dialog().getByLabelText('LinkedIn post link'), 'https://linkedin.com/jobs/1');
      typeInto(dialog().getByLabelText('LinkedIn weekly sourcing target'), '20');
      expect(status()).toHaveTextContent(/^Naukri\/IIMjobs: add the post link/);
      expect(activateBtn()).toBeDisabled();
    });

    it('LinkedIn and Naukri/IIMjobs also take the posting date; Direct Outreach does not (and uses campaign wording)', () => {
      open([ch('LinkedIn'), ch('Naukri/IIMjobs'), ch('Direct Outreach')]);
      for (const box of runningBoxes()) fireEvent.click(box);
      expect(dialog().getByLabelText('LinkedIn posting date')).toBeInTheDocument();
      expect(dialog().getByLabelText('Naukri/IIMjobs posting date')).toBeInTheDocument();
      expect(dialog().queryByLabelText('Direct Outreach posting date')).not.toBeInTheDocument();
      expect(dialog().getByLabelText('LinkedIn post link')).toHaveAttribute('placeholder', 'Link to the job post (required)');
      expect(dialog().getByLabelText('Direct Outreach post link')).toHaveAttribute('placeholder', 'Link to the outreach campaign or list (required)');
    });

    it('sends weekly_target (a number), url and posted_at for a running portal, and no posted_at when no date was entered', async () => {
      open([ch('LinkedIn'), ch('Naukri/IIMjobs')]);
      for (const box of runningBoxes()) fireEvent.click(box);
      typeInto(dialog().getByLabelText('LinkedIn post link'), 'https://linkedin.com/jobs/1');
      typeInto(dialog().getByLabelText('LinkedIn weekly sourcing target'), '20');
      typeInto(dialog().getByLabelText('LinkedIn posting date'), '2026-10-01');
      typeInto(dialog().getByLabelText('Naukri/IIMjobs post link'), 'https://naukri.com/job/9');
      typeInto(dialog().getByLabelText('Naukri/IIMjobs weekly sourcing target'), '35');
      fireEvent.click(activateBtn());
      await waitFor(() => expect(activate).toHaveBeenCalledWith('9', {
        strategy_note: null,
        channels: [
          { channel: 'LinkedIn', already_running: true, posted_at: '2026-10-01', url: 'https://linkedin.com/jobs/1', weekly_target: 20 },
          { channel: 'Naukri/IIMjobs', already_running: true, url: 'https://naukri.com/job/9', weekly_target: 35 },
        ],
      }));
      expect(typeof (activate.mock.calls[0][1] as { channels: Array<{ weekly_target: unknown }> }).channels[0].weekly_target).toBe('number');
    });

    it('Direct Outreach that is running sends its link and weekly target, never a posting date', async () => {
      open([ch('Direct Outreach')]);
      fireEvent.click(runningBoxes()[0]);
      typeInto(dialog().getByLabelText('Direct Outreach post link'), 'https://docs.google.com/spreadsheets/d/abc');
      typeInto(dialog().getByLabelText('Direct Outreach weekly sourcing target'), '25');
      fireEvent.click(activateBtn());
      await waitFor(() => expect(activate).toHaveBeenCalledWith('9', {
        strategy_note: null,
        channels: [{ channel: 'Direct Outreach', already_running: true, url: 'https://docs.google.com/spreadsheets/d/abc', weekly_target: 25 }],
      }));
    });

    it('a channel that is not already running sends neither link nor target, even if they were typed before it was un-ticked', async () => {
      open();
      fireEvent.click(runningBoxes()[0]);
      typeInto(dialog().getByLabelText('LinkedIn post link'), 'https://linkedin.com/jobs/1');
      typeInto(dialog().getByLabelText('LinkedIn weekly sourcing target'), '20');
      fireEvent.click(runningBoxes()[0]);                                                    // not running after all
      expect(dialog().queryByLabelText('LinkedIn post link')).not.toBeInTheDocument();
      expect(activateBtn()).toBeEnabled();
      fireEvent.click(activateBtn());
      await waitFor(() => expect(activate).toHaveBeenCalledWith('9', { strategy_note: null, channels: [{ channel: 'LinkedIn', already_running: false }] }));
    });
  });

  describe('a running channel that is not tracked (Agency, Internal Referral)', () => {
    it('asks for no link or target, says the follow-up clock starts today and sends only already_running', async () => {
      open([ch('Agency'), ch('Internal Referral')]);
      for (const box of runningBoxes()) fireEvent.click(box);
      for (const c of ['Agency', 'Internal Referral']) {
        expect(dialog().queryByLabelText(`${c} post link`)).not.toBeInTheDocument();
        expect(dialog().queryByLabelText(`${c} weekly sourcing target`)).not.toBeInTheDocument();
      }
      expect(dialog().getAllByText('Recorded as done; the follow-up clock starts today.')).toHaveLength(2);
      expect(activateBtn()).toBeEnabled();
      fireEvent.click(activateBtn());
      await waitFor(() => expect(activate).toHaveBeenCalledWith('9', {
        strategy_note: null, channels: [{ channel: 'Agency', already_running: true }, { channel: 'Internal Referral', already_running: true }],
      }));
    });
  });

  describe('the weekly qualified target for this role', () => {
    const field = () => dialog().getByLabelText(/Weekly qualified target for this role/);

    it('is optional: blank sends no weekly_qualified_target at all', async () => {
      open();
      expect(field()).toHaveValue(null);
      fireEvent.click(activateBtn());
      await waitFor(() => expect(activate).toHaveBeenCalled());
      expect(activate.mock.calls[0][1]).not.toHaveProperty('weekly_qualified_target');
    });

    it('sends the typed whole number', async () => {
      open();
      typeInto(field(), '8');
      fireEvent.click(activateBtn());
      await waitFor(() => expect(activate).toHaveBeenCalledWith('9', expect.objectContaining({ weekly_qualified_target: 8 })));
    });

    it('is pre-filled from the plan\'s own target', async () => {
      open([ch('LinkedIn')], { plan: plan({ weekly_qualified_target: 12 }) });
      expect(field()).toHaveValue(12);
      fireEvent.click(activateBtn());
      await waitFor(() => expect(activate).toHaveBeenCalledWith('9', expect.objectContaining({ weekly_qualified_target: 12 })));
    });

    it.each([['0'], ['501'], ['2.5'], ['-1']])('rejects "%s": the button is disabled and the status line says 1 to 500', (bad) => {
      open();
      typeInto(field(), bad);
      expect(activateBtn()).toBeDisabled();
      expect(status()).toHaveTextContent('The weekly qualified target is a whole number from 1 to 500 (or leave it blank).');
    });

    it.each([['1'], ['500']])('accepts %s', (good) => {
      open();
      typeInto(field(), good);
      expect(activateBtn()).toBeEnabled();
    });

    it('explains the default when there is one, and what a blank means when there is not', () => {
      const first = open([ch('LinkedIn')], { defaultTarget: 5 });
      expect(field()).toHaveAccessibleDescription('Qualified candidates wanted in any 7 days. Leave it blank to use the default of 5.');
      first.unmount();
      open([ch('LinkedIn')], { defaultTarget: null });
      expect(field()).toHaveAccessibleDescription('Qualified candidates wanted in any 7 days. Without one, nothing is flagged for this role.');
    });
  });

  describe('submitting', () => {
    it('carries the trimmed strategy note, then reports success and tells the parent', async () => {
      open();
      typeInto(dialog().getByLabelText(/Strategy note/), '  Focus on service engineers  ');
      fireEvent.click(activateBtn());
      await waitFor(() => expect(activate).toHaveBeenCalledWith('9', { strategy_note: 'Focus on service engineers', channels: [{ channel: 'LinkedIn', already_running: false }] }));
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(toast.success).toHaveBeenCalledWith('Sourcing plan activated');
    });

    it('a server refusal shows its message, keeps the dialog open and the button usable, and does not tell the parent', async () => {
      impl.activate = fail({ response: { data: { error: 'The role is closed' } } });
      open();
      fireEvent.click(activateBtn());
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The role is closed'));
      expect(onDone).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      await waitFor(() => expect(activateBtn()).toBeEnabled());
    });

    it('falls back to a generic message when the server gave none', async () => {
      impl.activate = fail(new Error('Network Error'));
      open();
      fireEvent.click(activateBtn());
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not activate the plan'));
    });

    it('does nothing while a problem remains (even if the click gets through)', () => {
      open();
      fireEvent.click(dialog().getByRole('checkbox', { name: /LinkedIn/ }));                 // every channel out
      expect(activateBtn()).toBeDisabled();
      fireEvent.click(activateBtn());
      expect(activate).not.toHaveBeenCalled();
    });
  });
});

// ═══ CompleteCommitmentModal ═════════════════════════════════════════════════════════════════════════
describe('CompleteCommitmentModal', () => {
  const open = (channel: string, kind: string, title = 'Task', id = '12') =>
    wrap(<CompleteCommitmentModal commitment={{ id, kind, title }} channel={channel} onClose={onClose} onDone={onDone} />);
  const primary = (name: string) => dialog().getByRole('button', { name });

  describe('the first task of a tracked channel ("Log the post")', () => {
    it.each([['LinkedIn'], ['Naukri/IIMjobs'], ['Direct Outreach']])('is titled "Log the %s post" with a "Log post" button, disabled until a valid link and a whole target are in', (channel) => {
      open(channel, 'activate_channel');
      expect(screen.getByRole('dialog')).toHaveAccessibleName(`Log the ${channel} post`);
      const log = primary('Log post');
      expect(log).toBeDisabled();
      expect(log).toHaveAttribute('title', 'Add the link to the post.');
      typeInto(dialog().getByLabelText(channel === 'Direct Outreach' ? 'Link to the outreach campaign or list' : 'Link to the job post'), 'https://example.com/post/1');
      expect(log).toBeDisabled();
      expect(log).toHaveAttribute('title', 'Add a whole-number weekly sourcing target.');
      typeInto(dialog().getByLabelText('Weekly sourcing target'), '25');
      expect(log).toBeEnabled();
      expect(log).not.toHaveAttribute('title');
      expect(dialog().queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument();
    });

    it.each([['0'], ['2.5'], ['-4'], [''], ['10001']])('"%s" is not an acceptable weekly sourcing target', (bad) => {
      open('LinkedIn', 'activate_channel');
      typeInto(dialog().getByLabelText('Link to the job post'), 'https://linkedin.com/jobs/1');
      typeInto(dialog().getByLabelText('Weekly sourcing target'), bad);
      expect(primary('Log post')).toBeDisabled();
    });

    it.each([['linkedin.com/jobs/1'], ['javascript:alert(1)'], ['mailto:a@b.com']])('"%s" is not an acceptable post link', (bad) => {
      open('LinkedIn', 'activate_channel');
      typeInto(dialog().getByLabelText('Link to the job post'), bad);
      typeInto(dialog().getByLabelText('Weekly sourcing target'), '25');
      expect(primary('Log post')).toBeDisabled();
    });

    it('sends weekly_target as a number, the link, the posting date (defaulting to today for a portal) and the note', async () => {
      open('LinkedIn', 'activate_channel');
      expect(dialog().getByLabelText('Posted on')).toHaveValue(ymd(0));
      typeInto(dialog().getByLabelText('Link to the job post'), 'https://linkedin.com/jobs/1');
      typeInto(dialog().getByLabelText('Weekly sourcing target'), '25');
      typeInto(dialog().getByLabelText(/Note/), '  Boosted for a week ');
      fireEvent.click(primary('Log post'));
      await waitFor(() => expect(completeCommitment).toHaveBeenCalledWith('12', {
        attest: true, url: 'https://linkedin.com/jobs/1', note: 'Boosted for a week', posted_at: ymd(0), weekly_target: 25,
      }));
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(toast.success).toHaveBeenCalledWith('Post logged — weekly tracking is set up');
    });

    it('a changed posting date is sent; a cleared one is left out', async () => {
      const first = open('Naukri/IIMjobs', 'activate_channel');
      typeInto(dialog().getByLabelText('Posted on'), '2026-10-01');
      typeInto(dialog().getByLabelText('Link to the job post'), 'https://naukri.com/job/9');
      typeInto(dialog().getByLabelText('Weekly sourcing target'), '40');
      fireEvent.click(primary('Log post'));
      await waitFor(() => expect(completeCommitment).toHaveBeenCalledWith('12', expect.objectContaining({ posted_at: '2026-10-01', weekly_target: 40 })));
      first.unmount();
      completeCommitment.mockClear();

      open('Naukri/IIMjobs', 'activate_channel');
      typeInto(dialog().getByLabelText('Posted on'), '');
      typeInto(dialog().getByLabelText('Link to the job post'), 'https://naukri.com/job/9');
      typeInto(dialog().getByLabelText('Weekly sourcing target'), '40');
      fireEvent.click(primary('Log post'));
      await waitFor(() => expect(completeCommitment).toHaveBeenCalled());
      expect(completeCommitment.mock.calls[0][1]).not.toHaveProperty('posted_at');
    });

    it('Direct Outreach has no posting date and calls its link the campaign or list', async () => {
      open('Direct Outreach', 'activate_channel');
      expect(dialog().queryByLabelText('Posted on')).not.toBeInTheDocument();
      typeInto(dialog().getByLabelText('Link to the outreach campaign or list'), 'https://docs.google.com/spreadsheets/d/abc');
      typeInto(dialog().getByLabelText('Weekly sourcing target'), '25');
      fireEvent.click(primary('Log post'));
      await waitFor(() => expect(completeCommitment).toHaveBeenCalledWith('12', { attest: true, url: 'https://docs.google.com/spreadsheets/d/abc', note: null, weekly_target: 25 }));
    });

    it('explains the automatic weekly tracker (met = green, missed = red)', () => {
      open('LinkedIn', 'activate_channel');
      expect(dialog().getByText(/the applications whose “How did you hear about this opening\?” answer means LinkedIn/)).toBeInTheDocument();
      expect(dialog().getByText(/met \(green\) or missed \(red\)/)).toBeInTheDocument();
    });

    it('does not send anything while the link or target is missing', () => {
      open('LinkedIn', 'activate_channel');
      fireEvent.click(primary('Log post'));
      expect(completeCommitment).not.toHaveBeenCalled();
    });
  });

  describe('tasks that are not "log the post"', () => {
    it('an Agency task keeps its optional link and note: "Mark done" is enabled at once and no target or posting date is asked for', async () => {
      open('Agency', 'activate_channel', 'Select agencies and share the role brief');
      expect(screen.getByRole('dialog')).toHaveAccessibleName('Mark done');
      expect(primary('Mark done')).toBeEnabled();
      expect(dialog().getByLabelText('Link (optional)')).toBeInTheDocument();
      expect(dialog().queryByLabelText('Weekly sourcing target')).not.toBeInTheDocument();
      expect(dialog().queryByLabelText('Posted on')).not.toBeInTheDocument();
      fireEvent.click(primary('Mark done'));
      await waitFor(() => expect(completeCommitment).toHaveBeenCalledWith('12', { attest: true, url: null, note: null }));
      expect(toast.success).toHaveBeenCalledWith('Marked done');
    });

    it('an Agency task still carries a link and note when they are given (and a bad link is left for the server to refuse)', async () => {
      open('Agency', 'followup_agency');
      typeInto(dialog().getByLabelText('Link (optional)'), 'https://drive.google.com/brief');
      typeInto(dialog().getByLabelText(/Note/), 'Briefed two agencies');
      fireEvent.click(primary('Mark done'));
      await waitFor(() => expect(completeCommitment).toHaveBeenCalledWith('12', { attest: true, url: 'https://drive.google.com/brief', note: 'Briefed two agencies' }));
    });

    it('renewing a portal posting needs nothing: it asks for the posting date (default today) and sends it, with no weekly target', async () => {
      open('LinkedIn', 'renew_posting', 'Renew the LinkedIn posting before it expires', '11');
      expect(screen.getByRole('dialog')).toHaveAccessibleName('Mark done');
      expect(primary('Mark done')).toBeEnabled();
      expect(dialog().getByLabelText('Posted on')).toHaveValue(ymd(0));
      expect(dialog().queryByLabelText('Weekly sourcing target')).not.toBeInTheDocument();
      expect(dialog().getByLabelText('Link (optional)')).toBeInTheDocument();
      fireEvent.click(primary('Mark done'));
      await waitFor(() => expect(completeCommitment).toHaveBeenCalledWith('11', { attest: true, url: null, note: null, posted_at: ymd(0) }));
    });

    it('other tracked-channel tasks (e.g. a Direct Outreach follow-up) are plain "Mark done" too', async () => {
      open('Direct Outreach', 'weekly_outbound', 'Send this week\'s outreach');
      expect(primary('Mark done')).toBeEnabled();
      expect(dialog().queryByLabelText('Weekly sourcing target')).not.toBeInTheDocument();
      expect(dialog().queryByLabelText('Posted on')).not.toBeInTheDocument();
      fireEvent.click(primary('Mark done'));
      await waitFor(() => expect(completeCommitment).toHaveBeenCalledWith('12', { attest: true, url: null, note: null }));
    });

    it('an Internal Referral repost has no posting date', async () => {
      open('Internal Referral', 'repost_referral');
      expect(dialog().queryByLabelText('Posted on')).not.toBeInTheDocument();
      expect(primary('Mark done')).toBeEnabled();
    });
  });

  describe('errors and closing', () => {
    it('shows the server\'s message, keeps the dialog open and re-enables the button', async () => {
      impl.completeCommitment = fail({ response: { data: { error: 'Evidence URL must be a valid http(s) link' } } });
      open('Agency', 'activate_channel');
      fireEvent.click(primary('Mark done'));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Evidence URL must be a valid http(s) link'));
      expect(onDone).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      await waitFor(() => expect(primary('Mark done')).toBeEnabled());
    });

    it('falls back to a generic message (and a log-post refusal behaves the same way)', async () => {
      impl.completeCommitment = fail(new Error('Network Error'));
      open('LinkedIn', 'activate_channel');
      typeInto(dialog().getByLabelText('Link to the job post'), 'https://linkedin.com/jobs/1');
      typeInto(dialog().getByLabelText('Weekly sourcing target'), '25');
      fireEvent.click(primary('Log post'));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not mark it done'));
      expect(onDone).not.toHaveBeenCalled();
      await waitFor(() => expect(primary('Log post')).toBeEnabled());
    });

    it('Cancel, Escape and a click on the backdrop close it; a click inside does not', () => {
      open('Agency', 'activate_channel');
      fireEvent.mouseDown(screen.getByRole('dialog'));
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(primary('Cancel'));
      expect(onClose).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(2);
      fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
      expect(onClose).toHaveBeenCalledTimes(3);
      expect(completeCommitment).not.toHaveBeenCalled();
    });
  });
});

// ═══ SkipCommitmentModal (unchanged behaviour, pinned because Close channel reuses its pattern) ══════
describe('SkipCommitmentModal', () => {
  it('needs a reason of at least 3 characters and sends it trimmed', async () => {
    wrap(<SkipCommitmentModal commitment={{ id: '11', title: 'Renew' }} channel="LinkedIn" onClose={onClose} onDone={onDone} />);
    const go = dialog().getByRole('button', { name: 'Skip' });
    expect(go).toBeDisabled();
    typeInto(dialog().getByRole('textbox'), '  ok ');
    expect(go).toBeDisabled();
    typeInto(dialog().getByRole('textbox'), '  Role on hold  ');
    fireEvent.click(go);
    await waitFor(() => expect(skipCommitment).toHaveBeenCalledWith('11', 'Role on hold'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});

// ═══ CloseChannelModal ═══════════════════════════════════════════════════════════════════════════════
describe('CloseChannelModal', () => {
  const open = (channel = 'LinkedIn') => wrap(<CloseChannelModal planId="9" channel={channel} onClose={onClose} onDone={onDone} />);
  const go = () => dialog().getByRole('button', { name: 'Close channel' });

  it('is titled with the channel, says what is kept, and needs a reason of 3+ characters', () => {
    open('Naukri/IIMjobs');
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Close Naukri/IIMjobs');
    expect(dialog().getByText(/The post link, targets and weekly results stay on the plan, and you can reopen it any time/)).toBeInTheDocument();
    expect(go()).toBeDisabled();
    typeInto(dialog().getByRole('textbox'), '  ab  ');
    expect(go()).toBeDisabled();
    typeInto(dialog().getByRole('textbox'), '  abc  ');
    expect(go()).toBeEnabled();
  });

  it('closes the channel through sourcingApi.closeChannel(planId, channel, reason) with the trimmed reason, then tells the parent', async () => {
    open();
    typeInto(dialog().getByRole('textbox'), '  Enough applicants for now ');
    fireEvent.click(go());
    await waitFor(() => expect(closeChannel).toHaveBeenCalledWith('9', 'LinkedIn', 'Enough applicants for now'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('LinkedIn closed — its summary stays on the plan');
  });

  it('sends nothing without a reason', () => {
    open();
    fireEvent.click(go());
    expect(closeChannel).not.toHaveBeenCalled();
  });

  it('a 409 (the plan is not what the dialog was showing) shows the server\'s message and still tells the parent to re-read the plan', async () => {
    impl.closeChannel = refused(409, 'LinkedIn is already closed');
    open();
    typeInto(dialog().getByRole('textbox'), 'Enough applicants');
    fireEvent.click(go());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('LinkedIn is already closed'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('any other failure keeps the dialog open (no re-read) and falls back to a generic message', async () => {
    impl.closeChannel = fail(new Error('Network Error'));
    open();
    typeInto(dialog().getByRole('textbox'), 'Enough applicants');
    fireEvent.click(go());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not close the channel'));
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await waitFor(() => expect(go()).toBeEnabled());
  });

  it('Cancel and Escape close it without closing the channel', () => {
    open();
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(closeChannel).not.toHaveBeenCalled();
  });
});

// ═══ ReopenChannelModal ══════════════════════════════════════════════════════════════════════════════
describe('ReopenChannelModal', () => {
  const open = (target: number | null) => wrap(<ReopenChannelModal planId="9" channel="LinkedIn" target={target} onClose={onClose} onDone={onDone} />);

  it('mentions weekly tracking restarting with the same target only when there is one', () => {
    const first = open(20);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Reopen LinkedIn');
    expect(dialog().getByText(/weekly tracking restarts with the same target of 20 a week — today, or tomorrow if the channel was closed today/)).toBeInTheDocument();
    expect(dialog().getByText(/The weeks already recorded stay as they are/)).toBeInTheDocument();
    first.unmount();

    open(null);
    expect(dialog().getByText(/Its follow-up tasks come back\. The weeks already recorded stay as they are\./)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).not.toHaveTextContent(/target of/);
  });

  it('a target of 0 is treated as no target', () => {
    open(0);
    expect(screen.getByRole('dialog')).not.toHaveTextContent(/target of/);
  });

  it('reopens through sourcingApi.reopenChannel(planId, channel) and tells the parent', async () => {
    open(20);
    fireEvent.click(dialog().getByRole('button', { name: 'Reopen channel' }));
    await waitFor(() => expect(reopenChannel).toHaveBeenCalledWith('9', 'LinkedIn'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('LinkedIn reopened');
  });

  it('a 409 shows the message and re-reads the plan; any other failure keeps the dialog open with a generic message', async () => {
    impl.reopenChannel = refused(409, 'The role is closed');
    const first = open(20);
    fireEvent.click(dialog().getByRole('button', { name: 'Reopen channel' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The role is closed'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    first.unmount();

    impl.reopenChannel = fail(new Error('Network Error'));
    open(20);
    fireEvent.click(dialog().getByRole('button', { name: 'Reopen channel' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not reopen the channel'));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

// ═══ EditChannelModal ════════════════════════════════════════════════════════════════════════════════
describe('EditChannelModal', () => {
  const open = (props: Partial<Parameters<typeof EditChannelModal>[0]> = {}) =>
    wrap(<EditChannelModal planId="9" channel="LinkedIn" target={20} link="https://linkedin.com/jobs/1" onClose={onClose} onDone={onDone} {...props} />);
  const save = () => dialog().getByRole('button', { name: 'Save' });
  const targetField = () => dialog().getByLabelText('Weekly sourcing target');
  const linkField = () => dialog().getByLabelText('Link to the job post (optional)');

  it('starts with the current target and link, and Save is off until something really changes', () => {
    open();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('LinkedIn: target and link');
    expect(targetField()).toHaveValue(20);
    expect(linkField()).toHaveValue('https://linkedin.com/jobs/1');
    expect(save()).toBeDisabled();
    typeInto(targetField(), '20');                                                           // the same number again
    expect(save()).toBeDisabled();
  });

  it('sends only the target when only the target changed', async () => {
    open();
    typeInto(targetField(), '30');
    fireEvent.click(save());
    await waitFor(() => expect(updateChannel).toHaveBeenCalledWith('9', { channel: 'LinkedIn', weekly_target: 30 }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('Saved — the change is in the plan history');
  });

  it('sends only the link when only the link changed', async () => {
    open();
    typeInto(linkField(), 'https://linkedin.com/jobs/2');
    fireEvent.click(save());
    await waitFor(() => expect(updateChannel).toHaveBeenCalledWith('9', { channel: 'LinkedIn', posting_url: 'https://linkedin.com/jobs/2' }));
  });

  it('sends both when both changed', async () => {
    open();
    typeInto(targetField(), '45');
    typeInto(linkField(), 'https://linkedin.com/jobs/3');
    fireEvent.click(save());
    await waitFor(() => expect(updateChannel).toHaveBeenCalledWith('9', { channel: 'LinkedIn', weekly_target: 45, posting_url: 'https://linkedin.com/jobs/3' }));
  });

  it.each([['0'], ['2.5'], ['-1']])('rejects a target of "%s" with a message, even when the link is a valid change', (bad) => {
    open();
    typeInto(targetField(), bad);
    typeInto(linkField(), 'https://linkedin.com/jobs/2');
    expect(save()).toBeDisabled();
    expect(dialog().getByRole('status')).toHaveTextContent('The weekly sourcing target is a whole number (1 or more).');
  });

  it.each([['linkedin.com/jobs/2'], ['ftp://x.com/y'], ['not a link']])('rejects the link "%s" with a message, even when the target is a valid change', (bad) => {
    open();
    typeInto(targetField(), '30');
    typeInto(linkField(), bad);
    expect(save()).toBeDisabled();
    expect(dialog().getByRole('status')).toHaveTextContent('The link must start with http:// or https://.');
    expect(updateChannel).not.toHaveBeenCalled();
  });

  it('a channel with no target yet says it is not being tracked, and saving a first target (no link) sends just the target', async () => {
    open({ target: null, link: null });
    expect(dialog().getByText('No weekly target is set yet, so this channel is not being tracked.')).toBeInTheDocument();
    expect(targetField()).toHaveValue(null);
    expect(save()).toBeDisabled();
    typeInto(targetField(), '15');
    fireEvent.click(save());
    await waitFor(() => expect(updateChannel).toHaveBeenCalledWith('9', { channel: 'LinkedIn', weekly_target: 15 }));
  });

  it('Direct Outreach calls its link the campaign or list', () => {
    open({ channel: 'Direct Outreach' });
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Direct Outreach: target and link');
    expect(dialog().getByLabelText('Link to the outreach campaign or list (optional)')).toBeInTheDocument();
  });

  it('a 409 shows the message and re-reads the plan; any other failure keeps the dialog open with a generic message', async () => {
    impl.updateChannel = refused(409, 'The channel is closed');
    const first = open();
    typeInto(targetField(), '30');
    fireEvent.click(save());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The channel is closed'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    first.unmount();

    impl.updateChannel = fail(new Error('Network Error'));
    open();
    typeInto(targetField(), '30');
    fireEvent.click(save());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save the change'));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

// ═══ EditPlanModal ═══════════════════════════════════════════════════════════════════════════════════
describe('EditPlanModal', () => {
  const open = (p: Partial<SourcingPlan> = {}, defaultTarget: number | null = 5) =>
    wrap(<EditPlanModal plan={plan({ status: 'active', strategy_note: 'Old note', weekly_qualified_target: 8, ...p })} defaultTarget={defaultTarget} onClose={onClose} onDone={onDone} />);
  const save = () => dialog().getByRole('button', { name: 'Save' });
  const target = () => dialog().getByLabelText(/Weekly qualified target/);
  const note = () => dialog().getByLabelText(/Strategy note/);

  it('starts with the plan\'s target and note, and Save is disabled until one of them changes', () => {
    open();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Edit plan');
    expect(target()).toHaveValue(8);
    expect(note()).toHaveValue('Old note');
    expect(save()).toBeDisabled();
    typeInto(note(), 'Old note   ');                                                         // whitespace is not a change
    expect(save()).toBeDisabled();
  });

  it('sends only the target when only the target changed', async () => {
    open();
    typeInto(target(), '10');
    fireEvent.click(save());
    await waitFor(() => expect(updatePlan).toHaveBeenCalledWith('9', { weekly_qualified_target: 10 }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('Plan updated');
  });

  it('clearing the target sends null (back to the default for the role\'s priority)', async () => {
    open();
    typeInto(target(), '');
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    await waitFor(() => expect(updatePlan).toHaveBeenCalledWith('9', { weekly_qualified_target: null }));
  });

  it('clearing a target that was never set is not a change', () => {
    open({ weekly_qualified_target: null });
    expect(target()).toHaveValue(null);
    typeInto(target(), '');
    expect(save()).toBeDisabled();
  });

  it('sends only the note when only the note changed, and null when it is cleared', async () => {
    const first = open();
    typeInto(note(), 'New note');
    fireEvent.click(save());
    await waitFor(() => expect(updatePlan).toHaveBeenCalledWith('9', { strategy_note: 'New note' }));
    first.unmount();
    updatePlan.mockClear();

    open();
    typeInto(note(), '   ');
    fireEvent.click(save());
    await waitFor(() => expect(updatePlan).toHaveBeenCalledWith('9', { strategy_note: null }));
  });

  it('sends both when both changed', async () => {
    open();
    typeInto(target(), '12');
    typeInto(note(), 'Different focus');
    fireEvent.click(save());
    await waitFor(() => expect(updatePlan).toHaveBeenCalledWith('9', { strategy_note: 'Different focus', weekly_qualified_target: 12 }));
  });

  it.each([['0'], ['501'], ['2.5'], ['-1']])('rejects a target of "%s" with a message, even when the note changed', (bad) => {
    open();
    typeInto(target(), bad);
    typeInto(note(), 'Changed too');
    expect(save()).toBeDisabled();
    expect(dialog().getByRole('status')).toHaveTextContent('The target is a whole number from 1 to 500.');
  });

  it.each([['1'], ['500']])('accepts a target of %s', (good) => {
    open();
    typeInto(target(), good);
    expect(save()).toBeEnabled();
  });

  it('a new first target on a plan that had none is sent', async () => {
    open({ weekly_qualified_target: null }, null);
    typeInto(target(), '7');
    fireEvent.click(save());
    await waitFor(() => expect(updatePlan).toHaveBeenCalledWith('9', { weekly_qualified_target: 7 }));
  });

  it('explains what blank means: the default when there is one, otherwise no target', () => {
    const first = open({}, 5);
    expect(target()).toHaveAccessibleDescription('Qualified candidates wanted in any 7 days for this role. Blank = the default of 5.');
    first.unmount();
    open({}, null);
    expect(target()).toHaveAccessibleDescription('Qualified candidates wanted in any 7 days for this role. Blank = no target, so nothing is flagged.');
  });

  it('says the Hiring Manager does not see the note, and caps it at 2000 characters', () => {
    open();
    expect(note()).toHaveAccessibleDescription(/The Hiring Manager does not see it/);
    expect(note()).toHaveAttribute('maxlength', '2000');
  });

  it('a failure shows the server\'s message (or a generic one), keeps the dialog open and does not tell the parent', async () => {
    impl.updatePlan = fail({ response: { data: { error: 'The plan is closed' } } });
    const first = open();
    typeInto(target(), '10');
    fireEvent.click(save());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The plan is closed'));
    first.unmount();

    impl.updatePlan = fail(new Error('Network Error'));
    open();
    typeInto(target(), '10');
    fireEvent.click(save());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not update the plan'));
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await waitFor(() => expect(save()).toBeEnabled());
  });
});

// ═══ AddChannelModal ═════════════════════════════════════════════════════════════════════════════════
describe('AddChannelModal', () => {
  const open = (channels: SourcingPlanChannel[], props: Partial<Parameters<typeof AddChannelModal>[0]> = {}) =>
    wrap(<AddChannelModal planId="9" planStatus="active" channels={channels} onClose={onClose} onDone={onDone} {...props} />);
  const radios = () => dialog().queryAllByRole('radio').map(r => r.textContent ?? '');

  it('offers channels that are not in the plan or were left out — never one that is in the plan, and never a CLOSED one (that is reopened, not added)', () => {
    open([ch('LinkedIn', 'active'), ch('Naukri/IIMjobs', 'closed'), ch('Agency', 'excluded', 'No budget'), ch('Internal Referral', 'planned')]);
    const offered = radios();
    expect(offered).toHaveLength(2);
    expect(offered.some(t => t.startsWith('Agency'))).toBe(true);
    expect(offered.some(t => t.startsWith('Direct Outreach'))).toBe(true);
    expect(offered.some(t => t.startsWith('Naukri/IIMjobs'))).toBe(false);
    expect(offered.some(t => t.startsWith('LinkedIn'))).toBe(false);
    expect(offered.some(t => t.startsWith('Internal Referral'))).toBe(false);
    expect(dialog().getByText('Left out earlier: No budget')).toBeInTheDocument();
  });

  it('says so when every channel is already in the plan', () => {
    open(['LinkedIn', 'Naukri/IIMjobs', 'Agency', 'Internal Referral', 'Direct Outreach'].map(c => ch(c, 'active')));
    expect(dialog().getByText('Every channel is already in this plan.')).toBeInTheDocument();
    expect(radios()).toHaveLength(0);
  });

  it('a closed channel with every other one in the plan leaves nothing to add', () => {
    open([ch('LinkedIn', 'active'), ch('Naukri/IIMjobs', 'closed'), ch('Agency'), ch('Internal Referral'), ch('Direct Outreach')]);
    expect(radios()).toHaveLength(0);
  });

  it('adds the chosen channel as "planned" (the button waits for a choice)', async () => {
    open([ch('LinkedIn', 'active')]);
    const add = dialog().getByRole('button', { name: 'Add channel' });
    expect(add).toBeDisabled();
    fireEvent.click(dialog().getByRole('radio', { name: /Direct Outreach/ }));
    fireEvent.click(add);
    await waitFor(() => expect(setChannel).toHaveBeenCalledWith('9', { channel: 'Direct Outreach', state: 'planned' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('Direct Outreach added to the plan');
  });

  it('bringing a channel back is the same dialog, preset: only that channel, already chosen, and a "Bring it back" button', async () => {
    open([ch('Agency', 'excluded', 'No budget'), ch('LinkedIn', 'active')], { preset: 'Agency' });
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Bring back Agency');
    expect(radios()).toHaveLength(1);
    expect(dialog().getByRole('radio', { name: /Agency/ })).toBeChecked();
    fireEvent.click(dialog().getByRole('button', { name: 'Bring it back' }));
    await waitFor(() => expect(setChannel).toHaveBeenCalledWith('9', { channel: 'Agency', state: 'planned' }));
  });

  it('says when the clock starts: today for an active plan, when the role is back on for a paused one', () => {
    const first = open([ch('LinkedIn', 'active')]);
    expect(dialog().getByText(/Tracking starts today/)).toBeInTheDocument();
    first.unmount();
    open([ch('LinkedIn', 'active')], { planStatus: 'paused' });
    expect(dialog().getByText(/starts when the role is back on/)).toBeInTheDocument();
  });

  it('a 409 shows the message and re-reads the plan; any other failure keeps the dialog open', async () => {
    impl.setChannel = refused(409, 'Agency is already in this plan');
    const first = open([ch('LinkedIn', 'active')]);
    fireEvent.click(dialog().getByRole('radio', { name: /Agency/ }));
    fireEvent.click(dialog().getByRole('button', { name: 'Add channel' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Agency is already in this plan'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    first.unmount();

    impl.setChannel = fail(new Error('Network Error'));
    open([ch('LinkedIn', 'active')]);
    fireEvent.click(dialog().getByRole('radio', { name: /Agency/ }));
    fireEvent.click(dialog().getByRole('button', { name: 'Add channel' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not add the channel'));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
