import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ChannelState, ChannelTracker, SourcingCommitment, SourcingPlanChannel, TrackerWeek } from '../../types/sourcing.ts';
import SourcingChannelBlock from './SourcingChannelBlock.tsx';

const TODAY = '2026-10-10';

const commitment = (over: Partial<SourcingCommitment> = {}): SourcingCommitment => ({
  id: '11', kind: 'log_post', title: 'Log the LinkedIn post', due_at: '2026-10-12T18:29:59Z', due_date: '2026-10-12', status: 'open', cadence_days: null,
  last_done_at: null, meta: {}, overdue: false, evidence: { auto: 0, self: 0 }, recent: [], ...over,
});
const isoDay = (offset: number) => new Date(Date.UTC(2026, 9, 6 + offset)).toISOString().slice(0, 10);
/** i = 0 is the latest finished week (30 Sep – 6 Oct), each next one a week earlier. */
const week = (i: number, over: Partial<TrackerWeek> = {}): TrackerWeek => ({
  week_start: isoDay(-6 - 7 * i), week_end: isoDay(-7 * i), target: 10, actual: 12, qualified: 4, met: true, partial: false, ...over,
});
const tracker = (over: Partial<ChannelTracker> = {}): ChannelTracker => ({
  applicable: true, target: 10, anchor: '2026-10-01', link: 'https://linkedin.com/jobs/view/123',
  running: { start: '2026-10-07', end: '2026-10-13', actual: 3, qualified: 1, target: 10 },
  weeks: [], totals: { weeks: 0, met: 0, actual: 0, target: 0 }, sourced: { applications: 3, qualified: 1 }, ...over,
});
const untracked = (over: Partial<ChannelTracker> = {}): ChannelTracker => ({
  applicable: false, target: null, anchor: null, link: null, running: null, weeks: [], totals: { weeks: 0, met: 0, actual: 0, target: 0 },
  sourced: { applications: 0, qualified: 0 }, ...over,
});
const channel = (over: Partial<SourcingPlanChannel> = {}): SourcingPlanChannel => ({
  id: '1', channel: 'LinkedIn', state: 'active', excluded_reason: null, closed_at: null, closed_reason: null, config: {}, targets: {},
  tracker: tracker(), commitments: [commitment()], ...over,
});

type Props = Partial<React.ComponentProps<typeof SourcingChannelBlock>>;
function mount(ch: SourcingPlanChannel, props: Props = {}) {
  const cb = {
    onComplete: vi.fn(), onSkip: vi.fn(), onUndo: vi.fn(), onClose: vi.fn(), onReopen: vi.fn(), onBringBack: vi.fn(), onEdit: vi.fn(),
  };
  const utils = render(<SourcingChannelBlock ch={ch} hr canEdit planActive today={TODAY} undoingId={null} {...cb} {...props} />);
  return { ...utils, ...cb };
}
const btn = (name: RegExp | string) => screen.queryByRole('button', { name });

describe('SourcingChannelBlock — state chip and the buttons each state offers (HR, can edit)', () => {
  const cases: Array<[ChannelState, string, { close: boolean; reopen: boolean; bring: boolean }]> = [
    ['planned',  'Not live yet', { close: true,  reopen: false, bring: false }],
    ['active',   'Live',         { close: true,  reopen: false, bring: false }],
    ['closed',   'Closed',       { close: false, reopen: true,  bring: false }],
    ['excluded', 'Not used',     { close: false, reopen: false, bring: true  }],
  ];
  for (const [state, label, want] of cases) {
    it(`${state}: chip "${label}", Close ${want.close ? 'shown' : 'hidden'}, Reopen ${want.reopen ? 'shown' : 'hidden'}, Bring back ${want.bring ? 'shown' : 'hidden'}`, () => {
      mount(channel({ state, closed_at: '2026-10-08T05:00:00Z', closed_reason: 'Filled', excluded_reason: 'Not needed' }));
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(!!btn('Close LinkedIn')).toBe(want.close);
      expect(!!btn('Reopen LinkedIn')).toBe(want.reopen);
      expect(!!btn('Bring back LinkedIn')).toBe(want.bring);
    });
  }

  it('the buttons read "Close channel", "Reopen channel" and "Bring back" (there is no "Stop using")', () => {
    const { unmount } = mount(channel());
    expect(screen.getByText('Close channel')).toBeInTheDocument();
    expect(screen.queryByText(/Stop using/i)).toBeNull();
    unmount();
    mount(channel({ state: 'closed', closed_at: '2026-10-08T05:00:00Z' }));
    expect(screen.getByText('Reopen channel')).toBeInTheDocument();
  });

  it('a user who cannot edit (Hiring Manager, closed plan) gets no action buttons in any state', () => {
    for (const state of ['planned', 'active', 'closed', 'excluded'] as const) {
      const { unmount } = mount(channel({ state, closed_at: '2026-10-08T05:00:00Z' }), { canEdit: false, hr: false });
      expect(screen.queryAllByRole('button').filter(b => /Close|Reopen|Bring back|Edit|Mark done|Skip|Undo/.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))).toHaveLength(0);
      unmount();
    }
  });

  it('fires the callbacks of Close / Reopen / Bring back', () => {
    const a = mount(channel());
    fireEvent.click(screen.getByRole('button', { name: 'Close LinkedIn' }));
    expect(a.onClose).toHaveBeenCalledTimes(1);
    a.unmount();

    const b = mount(channel({ state: 'closed', closed_at: '2026-10-08T05:00:00Z' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen LinkedIn' }));
    expect(b.onReopen).toHaveBeenCalledTimes(1);
    b.unmount();

    const c = mount(channel({ state: 'excluded', excluded_reason: 'Not needed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bring back LinkedIn' }));
    expect(c.onBringBack).toHaveBeenCalledTimes(1);
  });

  it('shows the reason a channel was left out, and nothing else but the header for it', () => {
    mount(channel({ state: 'excluded', excluded_reason: 'Not needed for this role', commitments: [commitment()] }));
    expect(screen.getByText('Not needed for this role')).toBeInTheDocument();
    expect(screen.queryByText('Log the LinkedIn post')).toBeNull();       // an excluded channel lists no tasks
    expect(screen.queryByTestId('closed-summary')).toBeNull();
    expect(screen.queryByTestId('tracker-running')).toBeNull();
  });

  it('is addressable by its channel name', () => {
    mount(channel({ channel: 'Direct Outreach' }));
    expect(screen.getByTestId('channel-Direct Outreach')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Direct Outreach' })).toBeInTheDocument();
  });
});

describe('SourcingChannelBlock — tasks', () => {
  it('lists the tasks of a planned or live channel, with Mark done and Skip that call back with the task', () => {
    const c = commitment({ id: '77', title: 'Log the LinkedIn post' });
    const m = mount(channel({ state: 'planned', tracker: tracker(), commitments: [c] }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(m.onComplete).toHaveBeenCalledWith(c);
    fireEvent.click(screen.getByRole('button', { name: 'Skip: Log the LinkedIn post' }));
    expect(m.onSkip).toHaveBeenCalledWith(c);
  });

  it('a skipped task offers Undo skip, which calls back, and is disabled while that task is being undone', () => {
    const c = commitment({ id: '5', status: 'skipped', title: 'Renew posting' });
    const m = mount(channel({ commitments: [c] }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo skip: Renew posting' }));
    expect(m.onUndo).toHaveBeenCalledWith(c);
    m.unmount();

    mount(channel({ commitments: [c] }), { undoingId: '5' });
    expect(screen.getByRole('button', { name: 'Undo skip: Renew posting' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull();
  });

  it('tasks cannot be completed, skipped or undone on a plan that is not active (paused) — but are still listed', () => {
    mount(channel({ commitments: [commitment(), commitment({ id: '12', title: 'Other', status: 'skipped' })] }), { planActive: false });
    expect(screen.getByText('Log the LinkedIn post')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Skip/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Undo skip/ })).toBeNull();
  });

  it('a closed channel lists none of its tasks', () => {
    mount(channel({ state: 'closed', closed_at: '2026-10-08T05:00:00Z', commitments: [commitment()] }));
    expect(screen.queryByText('Log the LinkedIn post')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull();
  });

  it('a channel with no tasks renders no list', () => {
    mount(channel({ commitments: [] }));
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('SourcingChannelBlock — the weekly tracker of a live tracked channel', () => {
  it('shows the weekly target, the link (HR only) and the Edit button', () => {
    const m = mount(channel());
    expect(screen.getByText(/Weekly sourcing target:/)).toHaveTextContent('Weekly sourcing target: 10 applicants (qualified + unqualified)');
    const link = screen.getByRole('link', { name: 'View job post' });
    expect(link).toHaveAttribute('href', 'https://linkedin.com/jobs/view/123');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
    fireEvent.click(screen.getByRole('button', { name: 'Edit LinkedIn target and link' }));
    expect(m.onEdit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Edit LinkedIn target and link' })).toHaveTextContent('Edit target and link');
  });

  it('Direct Outreach calls the link a campaign', () => {
    mount(channel({ channel: 'Direct Outreach' }));
    expect(screen.getByRole('link', { name: 'View campaign' })).toBeInTheDocument();
  });

  it('a Hiring Manager (hr=false) does not get the link, and an editor without hr only edits the target', () => {
    const { unmount } = mount(channel(), { hr: false, canEdit: false });
    expect(screen.getByText(/Weekly sourcing target:/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
    unmount();

    mount(channel(), { hr: false, canEdit: true });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit LinkedIn target and link' })).toHaveTextContent(/^Edit target$/);
  });

  it('no link on record means no link shown', () => {
    mount(channel({ tracker: tracker({ link: null }) }));
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the running week: label, "N of M so far", days left, qualified, and a progressbar with the right aria values', () => {
    mount(channel());
    const running = screen.getByTestId('tracker-running');
    expect(running).toHaveTextContent('This week (7 Oct – 13 Oct)');
    expect(running).toHaveTextContent('3 of 10 so far · 3 days left · 1 qualified');
    const bar = screen.getByRole('progressbar', { name: 'LinkedIn applicants this week' });
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '10');
    expect(bar).toHaveAttribute('aria-valuenow', '3');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('30%');
  });

  it('days left is singular on the last-but-one day, zero on the last, and never negative', () => {
    const running = (end: string) => ({ start: '2026-10-07', end, actual: 0, qualified: 0, target: 10 });
    const a = mount(channel({ tracker: tracker({ running: running('2026-10-11') }) }));
    expect(screen.getByTestId('tracker-running')).toHaveTextContent('· 1 day left');
    a.unmount();
    const b = mount(channel({ tracker: tracker({ running: running('2026-10-10') }) }));
    expect(screen.getByTestId('tracker-running')).toHaveTextContent('· 0 days left');
    b.unmount();
    mount(channel({ tracker: tracker({ running: running('2026-10-08') }) }));
    expect(screen.getByTestId('tracker-running')).toHaveTextContent('· 0 days left');
  });

  it('omits "N qualified" when none of this week\'s applicants is qualified yet', () => {
    mount(channel({ tracker: tracker({ running: { start: '2026-10-07', end: '2026-10-13', actual: 2, qualified: 0, target: 10 } }) }));
    expect(screen.getByTestId('tracker-running').textContent).not.toMatch(/qualified/);
  });

  it('a week that has beaten its target caps the progressbar at the target and fills it', () => {
    mount(channel({ tracker: tracker({ running: { start: '2026-10-07', end: '2026-10-13', actual: 15, qualified: 5, target: 10 } }) }));
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '10');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
    expect(bar.firstElementChild?.className).toMatch(/bg-green-500/);
    expect(screen.getByTestId('tracker-running')).toHaveTextContent('15 of 10 so far');
  });

  it('a week below target keeps the neutral bar colour', () => {
    mount(channel());
    expect(screen.getByRole('progressbar').firstElementChild?.className).not.toMatch(/green/);
  });

  it('no running week means no progress bar', () => {
    mount(channel({ tracker: tracker({ running: null, weeks: [week(0)] }) }));
    expect(screen.queryByTestId('tracker-running')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('before any week has finished, says when the first one will and that the result arrives by itself', () => {
    mount(channel());
    expect(screen.getByText(/The first week finishes on 13 Oct; its result \(met or missed\) is added here automatically\./)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('is not shown for a channel that is only planned (nothing is live to measure)', () => {
    mount(channel({ state: 'planned' }));
    expect(screen.queryByText(/Weekly sourcing target/)).toBeNull();
    expect(screen.queryByTestId('tracker-no-target')).toBeNull();
  });

  it('is not shown for a channel that is not tracked (Agency, Internal Referral)', () => {
    mount(channel({ channel: 'Agency', tracker: untracked(), commitments: [commitment({ title: 'Select agencies' })] }));
    expect(screen.queryByText(/Weekly sourcing target/)).toBeNull();
    expect(screen.queryByTestId('tracker-no-target')).toBeNull();
    expect(screen.getByText('Select agencies')).toBeInTheDocument();
  });
});

describe('SourcingChannelBlock — a live tracked channel without a target', () => {
  const noTarget = () => channel({ tracker: tracker({ target: null, running: null, link: null }) });

  it('says it is not being tracked and offers "Add the target and post link" to an editor, which opens the edit dialog', () => {
    const m = mount(noTarget());
    expect(screen.getByTestId('tracker-no-target')).toHaveTextContent('No weekly sourcing target is set for LinkedIn yet, so it is not being tracked.');
    fireEvent.click(screen.getByRole('button', { name: 'Add the target and post link' }));
    expect(m.onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('a user who cannot edit gets the note but no button', () => {
    mount(noTarget(), { canEdit: false, hr: false });
    expect(screen.getByTestId('tracker-no-target')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add the target and post link' })).toBeNull();
  });
});

describe('SourcingChannelBlock — finished weeks', () => {
  const rows = () => screen.getAllByTestId('tracker-week');

  it('lists them newest first as a table named after the channel, with applicants, qualified, target and a result chip', () => {
    mount(channel({ tracker: tracker({ weeks: [
      week(0, { actual: 12, qualified: 4, target: 10, met: true }),
      week(1, { actual: 6, qualified: 1, target: 10, met: false }),
      week(2, { actual: 3, qualified: 0, target: 10, met: false, partial: true }),
    ] }) }));
    const table = screen.getByRole('table', { name: 'LinkedIn weekly results' });
    expect(within(table).getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Week', 'Applicants', 'Target', 'Result']);
    expect(rows()).toHaveLength(3);
    expect(rows()[0]).toHaveTextContent('12 (4 qualified)');
    expect(within(rows()[0]).getByText('Met')).toBeInTheDocument();
    expect(within(rows()[1]).getByText('Missed')).toBeInTheDocument();
    expect(within(rows()[1]).getAllByRole('cell')[2]).toHaveTextContent('10');
    expect(within(rows()[2]).getByText('Cut short')).toBeInTheDocument();
    expect(within(rows()[2]).queryByText('Missed')).toBeNull();
  });

  it('colours the row green when met and red when missed, and leaves a cut-short week uncoloured', () => {
    mount(channel({ tracker: tracker({ weeks: [week(0, { met: true }), week(1, { met: false }), week(2, { met: false, partial: true })] }) }));
    expect(rows()[0].className).toMatch(/bg-green/);
    expect(rows()[1].className).toMatch(/bg-red/);
    expect(rows()[2].className).not.toMatch(/bg-(green|red)/);
  });

  it('shows the week range of each row', () => {
    mount(channel({ tracker: tracker({ weeks: [{ week_start: '2026-10-07', week_end: '2026-10-13', target: 10, actual: 12, qualified: 4, met: true, partial: false }] }) }));
    expect(rows()[0]).toHaveTextContent('7 Oct – 13 Oct');
  });

  it('shows 6 and then "Show all N weeks" / "Show fewer weeks"', () => {
    const weeks = Array.from({ length: 9 }, (_, i) => week(i));
    mount(channel({ tracker: tracker({ weeks }) }));
    expect(rows()).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 9 weeks' }));
    expect(rows()).toHaveLength(9);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer weeks' }));
    expect(rows()).toHaveLength(6);
  });

  it('exactly 6 weeks need no toggle', () => {
    mount(channel({ tracker: tracker({ weeks: Array.from({ length: 6 }, (_, i) => week(i)) }) }));
    expect(rows()).toHaveLength(6);
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });
});

describe('SourcingChannelBlock — closed channel summary', () => {
  const closedWeeks = [week(0, { met: true }), week(1, { met: false }), week(2, { met: true, actual: 11, week_start: '2026-09-16', week_end: '2026-09-22' })];
  const closed = (over: Partial<SourcingPlanChannel> = {}) => channel({
    state: 'closed', closed_at: '2026-10-08T05:00:00Z', closed_reason: 'Role is filled', commitments: [commitment()],
    tracker: tracker({ running: null, weeks: closedWeeks, totals: { weeks: 3, met: 2, actual: 30, target: 30 }, sourced: { applications: 41, qualified: 9 } }), ...over,
  });

  it('keeps the posting, targets and weekly numbers after closure', () => {
    mount(closed());
    const s = screen.getByTestId('closed-summary');
    expect(s).toHaveTextContent('Closed 8 Oct — Role is filled');
    expect(within(s).getByText('Weekly target').nextElementSibling).toHaveTextContent('10');
    expect(within(s).getByText('Weeks tracked').nextElementSibling).toHaveTextContent('3 · 2 on target');
    expect(within(s).getByText('Applicants tagged').nextElementSibling).toHaveTextContent('41 · 9 qualified');
    const link = within(s).getByRole('link', { name: 'Open link' });
    expect(link).toHaveAttribute('href', 'https://linkedin.com/jobs/view/123');
    expect(within(s).getByText('Job post')).toBeInTheDocument();
    expect(within(s).getAllByTestId('tracker-week')).toHaveLength(3);
    // the live tracker is gone
    expect(screen.queryByText(/Weekly sourcing target:/)).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('Direct Outreach labels the link "Campaign"', () => {
    mount(closed({ channel: 'Direct Outreach' }));
    expect(within(screen.getByTestId('closed-summary')).getByText('Campaign')).toBeInTheDocument();
  });

  it('hides the closing reason and the link from a user who is not HR (hr=false), but keeps the numbers', () => {
    mount(closed(), { hr: false, canEdit: false });
    const s = screen.getByTestId('closed-summary');
    expect(s).toHaveTextContent('Closed 8 Oct');
    expect(s.textContent).not.toMatch(/Role is filled/);
    expect(within(s).queryByRole('link')).toBeNull();
    expect(within(s).getByText('Weeks tracked').nextElementSibling).toHaveTextContent('3 · 2 on target');
    expect(within(s).getByText('Applicants tagged')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen LinkedIn' })).toBeNull();
  });

  it('a closed channel with no reason or link says only when it closed', () => {
    mount(closed({ closed_reason: null, tracker: tracker({ link: null, running: null, weeks: [], totals: { weeks: 0, met: 0, actual: 0, target: 0 } }) }));
    const s = screen.getByTestId('closed-summary');
    expect(s).toHaveTextContent(/^Closed 8 Oct/);
    expect(within(s).queryByRole('link')).toBeNull();
    expect(within(s).getByText('Weeks tracked').nextElementSibling?.textContent).toBe('0');   // "0", no "· 0 on target"
    expect(within(s).queryByRole('button', { name: /Weekly results/ })).toBeNull();
  });

  it('a channel that was never tracked (Agency) shows only the applicants tagged — no target or weeks', () => {
    mount(closed({ channel: 'Agency', tracker: untracked({ sourced: { applications: 5, qualified: 2 } }) }));
    const s = screen.getByTestId('closed-summary');
    expect(within(s).queryByText('Weekly target')).toBeNull();
    expect(within(s).queryByText('Weeks tracked')).toBeNull();
    expect(within(s).getByText('Applicants tagged').nextElementSibling).toHaveTextContent('5 · 2 qualified');
  });

  it('shows "—" for the weekly target when none was ever set', () => {
    mount(closed({ tracker: tracker({ target: null, running: null, weeks: [] }) }));
    expect(within(screen.getByTestId('closed-summary')).getByText('Weekly target').nextElementSibling).toHaveTextContent('—');
  });

  it('the weekly results are open by default and the toggle collapses and re-opens them (aria-expanded)', () => {
    mount(closed());
    const toggle = screen.getByRole('button', { name: /Weekly results \(3\)/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId('tracker-week')).toHaveLength(3);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByTestId('tracker-week')).toHaveLength(0);
    fireEvent.click(toggle);
    expect(screen.getAllByTestId('tracker-week')).toHaveLength(3);
  });

  it('the weekly results of a long-running channel page by 6 inside the summary too', () => {
    const weeks = Array.from({ length: 8 }, (_, i) => week(i));
    mount(closed({ tracker: tracker({ running: null, weeks, totals: { weeks: 8, met: 8, actual: 96, target: 80 } }) }));
    expect(screen.getAllByTestId('tracker-week')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 8 weeks' }));
    expect(screen.getAllByTestId('tracker-week')).toHaveLength(8);
  });

  it('Reopen channel is offered to an editor', () => {
    const m = mount(closed());
    fireEvent.click(screen.getByRole('button', { name: 'Reopen LinkedIn' }));
    expect(m.onReopen).toHaveBeenCalled();
  });
});

describe('SourcingChannelBlock — canManage: closing, reopening and bringing back need a plan that is being tracked', () => {
  it('canEdit alone (a draft plan) offers none of Close channel / Reopen channel / Bring back, but tasks still follow canEdit', () => {
    for (const state of ['planned', 'closed', 'excluded'] as const) {
      const { unmount } = mount(channel({ state, closed_at: state === 'closed' ? '2026-10-08T05:00:00Z' : null, commitments: [commitment()] }), { canManage: false });
      expect(btn(/Close LinkedIn|Reopen LinkedIn|Bring back LinkedIn/)).not.toBeInTheDocument();
      unmount();
    }
  });
  it('canManage defaults to canEdit (so existing callers are unchanged)', () => {
    mount(channel({ state: 'planned', commitments: [commitment()] }));
    expect(btn(/Close LinkedIn/)).toBeInTheDocument();
  });
  it('a tracked channel with a target but nothing yet to show never prints "finishes on ." with a missing date', () => {
    mount(channel({ state: 'active', tracker: tracker({ target: 10, running: null, weeks: [], totals: { weeks: 0, met: 0, actual: 0, target: 0 } }) }));
    expect(screen.queryByText(/finishes on\s*[;.]/)).not.toBeInTheDocument();
    expect(screen.getByText(/is added here automatically/)).toBeInTheDocument();
  });
});

// ═══ the tracker runs only while the channel is live AND the plan is active ═══════════════════════════
describe('SourcingChannelBlock — the weekly tracker while the plan is not active (role on hold)', () => {
  /** A live tracked channel whose plan is paused: the server sends no running week and a null anchor. */
  const stopped = (over: Partial<ChannelTracker> = {}) => channel({ tracker: tracker({ anchor: null, running: null, ...over }) });

  it('says the tracker is stopped while the role is on hold, keeps the target line and shows no running week', () => {
    mount(stopped(), { planActive: false });
    const note = screen.getByTestId('tracker-paused');
    expect(note).toHaveTextContent('The weekly tracker is stopped while the role is on hold');
    expect(note).toHaveTextContent('the week in progress was kept as “cut short”');
    expect(note).toHaveTextContent('It starts again the day the role is back on.');
    expect(screen.getByText(/Weekly sourcing target:/)).toHaveTextContent('Weekly sourcing target: 10 applicants');
    expect(screen.queryByTestId('tracker-running')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByTestId('tracker-no-target')).toBeNull();
  });

  it('is not shown while the plan is active — a live channel with no running week just waits for its first result', () => {
    mount(stopped(), { planActive: true });
    expect(screen.queryByTestId('tracker-paused')).toBeNull();
    expect(screen.getByText(/The result of each week \(met or missed\) is added here automatically\./)).toBeInTheDocument();
  });

  it('is not shown when a week is running, even if the plan is not active (the running week is what the server says is happening)', () => {
    mount(channel(), { planActive: false });                                   // default fixture has a running week
    expect(screen.queryByTestId('tracker-paused')).toBeNull();
    expect(screen.getByTestId('tracker-running')).toBeInTheDocument();
  });

  it('is not shown when there is no weekly target: that channel gets the "not being tracked" note instead', () => {
    mount(channel({ tracker: tracker({ target: null, anchor: null, running: null, link: null }) }), { planActive: false });
    expect(screen.queryByTestId('tracker-paused')).toBeNull();
    expect(screen.getByTestId('tracker-no-target')).toBeInTheDocument();
  });

  it('appears above the finished weeks, which stay listed (a cut-short week keeps its chip)', () => {
    mount(stopped({ weeks: [week(0, { actual: 4, qualified: 1, met: false, partial: true }), week(1, { met: true })], totals: { weeks: 1, met: 1, actual: 12, target: 10 } }), { planActive: false });
    const note = screen.getByTestId('tracker-paused');
    const table = screen.getByRole('table', { name: 'LinkedIn weekly results' });
    expect(note.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId('tracker-week')).toHaveLength(2);
    expect(within(screen.getAllByTestId('tracker-week')[0]).getByText('Cut short')).toBeInTheDocument();
    expect(screen.queryByText(/The first week finishes on/)).toBeNull();
  });

  it('is shown to a user who cannot edit (Hiring Manager view) too, with no Edit button', () => {
    mount(stopped(), { planActive: false, hr: false, canEdit: false });
    expect(screen.getByTestId('tracker-paused')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('Edit target and link is still offered on a paused plan to an editor who can manage', () => {
    const m = mount(stopped(), { planActive: false, canEdit: true, canManage: true });
    fireEvent.click(screen.getByRole('button', { name: 'Edit LinkedIn target and link' }));
    expect(m.onEdit).toHaveBeenCalledTimes(1);
  });

  it('is never shown for a channel that is not tracked, nor for a channel that is not live (planned, closed, left out)', () => {
    const cases: Array<[string, SourcingPlanChannel]> = [
      ['Agency', channel({ channel: 'Agency', tracker: untracked(), commitments: [] })],
      ['planned', channel({ state: 'planned', tracker: tracker({ running: null, anchor: null }) })],
      ['closed', channel({ state: 'closed', closed_at: '2026-10-08T05:00:00Z', tracker: tracker({ running: null, anchor: null }) })],
      ['excluded', channel({ state: 'excluded', excluded_reason: 'Not needed', tracker: tracker({ running: null, anchor: null }) })],
    ];
    for (const [label, ch] of cases) {
      const { unmount } = mount(ch, { planActive: false });
      expect(screen.queryByTestId('tracker-paused'), label).toBeNull();
      unmount();
    }
  });

  it('a paused plan also stops the task buttons (Mark done / Skip / Undo) but still lists the tasks', () => {
    mount(stopped({ weeks: [] }), { planActive: false });
    expect(screen.getByText('Log the LinkedIn post')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Skip/ })).toBeNull();
  });
});

// ═══ "Tracking restarts on …" — an active plan whose live channel has no running week yet, because its tracker starts tomorrow ═══
describe('SourcingChannelBlock — tracker-restarts (active plan, no running week, effective start after today)', () => {
  /** The server sends running = null and the EFFECTIVE start (tomorrow after a same-day close + reopen or hold + resume). */
  const waiting = (anchor: string | null, over: Partial<ChannelTracker> = {}) => channel({ tracker: tracker({ anchor, running: null, ...over }) });

  it('is shown with the restart date when the anchor is after today', () => {
    mount(waiting('2026-10-11'), { planActive: true });
    const note = screen.getByTestId('tracker-restarts');
    expect(note).toHaveTextContent('Tracking restarts on 11 Oct');
    expect(note).toHaveTextContent('the days up to then are already in the week cut short above');
    expect(screen.queryByTestId('tracker-running')).toBeNull();
    expect(screen.queryByTestId('tracker-paused')).toBeNull();
    expect(screen.queryByTestId('tracker-no-target')).toBeNull();
  });

  it('shows the anchor date as given, however far ahead it is', () => {
    mount(waiting('2026-11-03'), { planActive: true });
    expect(screen.getByTestId('tracker-restarts')).toHaveTextContent('Tracking restarts on 3 Nov');
  });

  it('keeps the target line and the weeks that are already finished (the cut-short one carries its chip)', () => {
    mount(waiting('2026-10-11', { weeks: [week(0, { actual: 2, qualified: 0, met: false, partial: true }), week(1, { met: true })], totals: { weeks: 1, met: 1, actual: 12, target: 10 } }), { planActive: true });
    const note = screen.getByTestId('tracker-restarts');
    const table = screen.getByRole('table', { name: 'LinkedIn weekly results' });
    expect(screen.getByText(/Weekly sourcing target:/)).toHaveTextContent('Weekly sourcing target: 10 applicants');
    expect(note.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(screen.getAllByTestId('tracker-week')[0]).getByText('Cut short')).toBeInTheDocument();
  });

  it('is shown to a user who cannot edit (Hiring Manager view) too, with no Edit button and no link', () => {
    mount(waiting('2026-10-11'), { planActive: true, hr: false, canEdit: false });
    expect(screen.getByTestId('tracker-restarts')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('is NOT shown when a week is running, even if the anchor is in the future (the running week is what the server says is happening)', () => {
    mount(channel({ tracker: tracker({ anchor: '2026-10-11' }) }), { planActive: true });           // default fixture has a running week
    expect(screen.queryByTestId('tracker-restarts')).toBeNull();
    expect(screen.getByTestId('tracker-running')).toBeInTheDocument();
  });

  it('is NOT shown when the anchor is today (the tracker starts today, nothing is waiting)', () => {
    mount(waiting(TODAY), { planActive: true });
    expect(screen.queryByTestId('tracker-restarts')).toBeNull();
    expect(screen.queryByTestId('tracker-paused')).toBeNull();
  });

  it('is NOT shown when the anchor is earlier than today', () => {
    mount(waiting('2026-10-01'), { planActive: true });
    expect(screen.queryByTestId('tracker-restarts')).toBeNull();
    // it falls back to the plain "result of each week is added here" line
    expect(screen.getByText(/The result of each week \(met or missed\) is added here automatically\./)).toBeInTheDocument();
  });

  it('is NOT shown when there is no anchor at all (a null effective start)', () => {
    mount(waiting(null), { planActive: true });
    expect(screen.queryByTestId('tracker-restarts')).toBeNull();
  });

  it('is NOT shown when the plan is not active — the paused note shows instead, whatever the anchor says', () => {
    mount(waiting('2026-10-11'), { planActive: false });
    expect(screen.queryByTestId('tracker-restarts')).toBeNull();
    expect(screen.getByTestId('tracker-paused')).toBeInTheDocument();
  });

  it('is NOT shown when there is no weekly target: that channel gets the "not being tracked" note instead', () => {
    mount(channel({ tracker: tracker({ target: null, anchor: '2026-10-11', running: null, link: null }) }), { planActive: true });
    expect(screen.queryByTestId('tracker-restarts')).toBeNull();
    expect(screen.getByTestId('tracker-no-target')).toBeInTheDocument();
  });

  it('is never shown for a channel that is not tracked, nor for one that is not live (planned, closed, left out)', () => {
    const cases: Array<[string, SourcingPlanChannel]> = [
      ['Agency', channel({ channel: 'Agency', tracker: untracked({ anchor: '2026-10-11' }), commitments: [] })],
      ['planned', channel({ state: 'planned', tracker: tracker({ running: null, anchor: '2026-10-11' }) })],
      ['closed', channel({ state: 'closed', closed_at: '2026-10-08T05:00:00Z', tracker: tracker({ running: null, anchor: '2026-10-11' }) })],
      ['excluded', channel({ state: 'excluded', excluded_reason: 'Not needed', tracker: tracker({ running: null, anchor: '2026-10-11' }) })],
    ];
    for (const [label, ch] of cases) {
      const { unmount } = mount(ch, { planActive: true });
      expect(screen.queryByTestId('tracker-restarts'), label).toBeNull();
      unmount();
    }
  });

  it('tasks stay listed and completable while tracking waits for tomorrow (the plan is active)', () => {
    const m = mount(waiting('2026-10-11'), { planActive: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(m.onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('SourcingChannelBlock — a closed channel\'s totals come from the API, not from the rows (cut-short weeks are listed but never counted)', () => {
  const closedAt = '2026-10-08T05:00:00Z';
  const cut = (over: Partial<TrackerWeek> = {}) => week(2, { actual: 5, qualified: 1, met: false, partial: true, ...over });
  const closed = (tr: Partial<ChannelTracker>) => channel({ state: 'closed', closed_at: closedAt, closed_reason: 'Filled', commitments: [], tracker: tracker({ running: null, ...tr }) });
  const summary = () => within(screen.getByTestId('closed-summary'));

  it('a cut-short row renders its "Cut short" chip while "Weeks tracked" shows the API totals, which leave that row out', () => {
    // 3 rows (met, missed, cut short) but the API counts only the 2 finished ones
    mount(closed({ weeks: [week(0, { met: true }), week(1, { met: false, actual: 6 }), cut()], totals: { weeks: 2, met: 1, actual: 18, target: 20 } }));
    const rows = summary().getAllByTestId('tracker-week');
    expect(rows).toHaveLength(3);
    expect(within(rows[2]).getByText('Cut short')).toBeInTheDocument();
    expect(within(rows[2]).queryByText('Missed')).toBeNull();
    expect(summary().getByText('Weeks tracked').nextElementSibling).toHaveTextContent('2 · 1 on target');
    expect(summary().getByRole('button', { name: /Weekly results \(3\)/ })).toBeInTheDocument();   // the list header counts the rows shown
  });

  it('the displayed total is exactly the prop: it is not recomputed from the rows (a deliberately different total is shown as given)', () => {
    mount(closed({ weeks: [week(0, { met: true }), cut()], totals: { weeks: 7, met: 4, actual: 70, target: 70 } }));
    expect(summary().getByText('Weeks tracked').nextElementSibling).toHaveTextContent('7 · 4 on target');
  });

  it('a channel closed in its very first week has only a cut-short row: it is listed, and "Weeks tracked" is a bare 0', () => {
    mount(closed({ weeks: [cut({ week_start: '2026-10-07', week_end: '2026-10-08' })], totals: { weeks: 0, met: 0, actual: 0, target: 0 } }));
    const rows = summary().getAllByTestId('tracker-week');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('7 Oct – 8 Oct');
    expect(within(rows[0]).getByText('Cut short')).toBeInTheDocument();
    expect(summary().getByText('Weeks tracked').nextElementSibling?.textContent).toBe('0');       // no "· 0 on target"
    expect(summary().getByRole('button', { name: /Weekly results \(1\)/ })).toBeInTheDocument();
  });

  it('a cut-short row is not coloured green or red and does not read Met or Missed, even when its numbers would have met the target', () => {
    mount(closed({ weeks: [cut({ actual: 15, met: true })], totals: { weeks: 0, met: 0, actual: 0, target: 0 } }));
    const row = summary().getAllByTestId('tracker-week')[0];
    expect(row.className).not.toMatch(/bg-(green|red)/);
    expect(within(row).getByText('Cut short')).toBeInTheDocument();
    expect(within(row).queryByText('Met')).toBeNull();
    expect(row).toHaveTextContent('15 (1 qualified)');
  });

  it('a closed channel with no rows at all shows no list and no toggle', () => {
    mount(closed({ weeks: [], totals: { weeks: 0, met: 0, actual: 0, target: 0 } }));
    expect(summary().queryByRole('button', { name: /Weekly results/ })).toBeNull();
    expect(screen.queryAllByTestId('tracker-week')).toHaveLength(0);
  });

  it('a Hiring Manager sees the same totals and the Cut short chip', () => {
    mount(closed({ weeks: [week(0, { met: true }), cut()], totals: { weeks: 1, met: 1, actual: 12, target: 10 } }), { hr: false, canEdit: false });
    expect(summary().getByText('Weeks tracked').nextElementSibling).toHaveTextContent('1 · 1 on target');
    expect(within(summary().getAllByTestId('tracker-week')[1]).getByText('Cut short')).toBeInTheDocument();
  });

  it('a live channel that carries a cut-short week from an earlier run lists it with the chip and shows no totals line', () => {
    mount(channel({ tracker: tracker({ weeks: [week(0, { met: true }), cut()], totals: { weeks: 1, met: 1, actual: 12, target: 10 } }) }));
    expect(screen.getAllByTestId('tracker-week')).toHaveLength(2);
    expect(screen.getByText('Cut short')).toBeInTheDocument();
    expect(screen.queryByText('Weeks tracked')).toBeNull();
  });
});

describe('SourcingChannelBlock — evidence is shown only against a finished (or repeating) task, never an open one-off', () => {
  const evidenceText = () => screen.queryByText(/Evidence:/);
  it('a finished one-off task shows the evidence it was completed with', () => {
    mount(channel({ commitments: [commitment({ status: 'done', last_done_at: '2026-10-08T07:00:00Z', evidence: { auto: 0, self: 1 } })] }));
    expect(evidenceText()).toHaveTextContent('Evidence: 1 self-reported');
  });
  it('a one-off task handed back (open again, after an earlier completion) does NOT show the old evidence — it is not complete', () => {
    mount(channel({ commitments: [commitment({ status: 'open', due_date: '2026-10-24', last_done_at: '2026-10-08T07:00:00Z', evidence: { auto: 0, self: 1 } })] }));
    expect(screen.getByText('Log the LinkedIn post')).toBeInTheDocument();
    expect(evidenceText()).toBeNull();
    expect(btn('Mark done')).toBeInTheDocument();                           // still actionable
  });
  it('a repeating task keeps showing its last completion\'s evidence next to "Last done"', () => {
    mount(channel({ commitments: [commitment({
      id: '12', kind: 'renew_posting', title: 'Renew the LinkedIn posting', status: 'open', cadence_days: 30, due_date: '2026-11-17', evidence: { auto: 0, self: 2 },
      recent: [{ done_at: '2026-10-08T07:00:00Z', was_due_at: '2026-10-09T18:29:59Z', on_time: true, note: null, evidence: [] }],
    })] }));
    expect(evidenceText()).toHaveTextContent('Evidence: 2 self-reported');
    expect(screen.getByText(/Last done/)).toBeInTheDocument();
  });
  it('an open one-off task with no evidence shows none (the normal case)', () => {
    mount(channel({ commitments: [commitment()] }));
    expect(evidenceText()).toBeNull();
  });
});
