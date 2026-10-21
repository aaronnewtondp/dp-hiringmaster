import { describe, expect, it } from 'vitest';
import { describeChange, EXCEPTION_LABELS } from './sourcingTimeline.js';

describe('describeChange — every kind of action reads as one plain sentence', () => {
  it('a task done: channel, task, and what was logged', () => {
    const d = describeChange({ type: 'commitment_completed', channel: 'LinkedIn', commitment: 'Log the LinkedIn post', url: 'https://x', weekly_target: 12, on_time: false });
    expect(d.category).toBe('task');
    expect(d.text).toBe('LinkedIn: Done — Log the LinkedIn post (link logged · weekly target 12 · late)');
  });
  it('already running at activation is said so', () => {
    expect(describeChange({ type: 'commitment_completed', channel: 'Agency', commitment: 'Brief', already_running: true }).text).toContain('already running');
  });
  it('skipped, brought back', () => {
    expect(describeChange({ type: 'commitment_skipped', channel: 'Agency', commitment: 'Follow up' }).text).toBe('Agency: Skipped — Follow up');
    expect(describeChange({ type: 'commitment_reopened', channel: 'Agency' }).text).toBe('Agency: Skipped task brought back');
  });
  it('channels: closed with its tracked weeks, reopened, added, left out', () => {
    expect(describeChange({ type: 'channel_closed', channel: 'LinkedIn', weeks: 3, weeks_met: 2 })).toEqual({ category: 'channel', text: 'LinkedIn: Channel closed after 3 tracked weeks (2 on target)' });
    expect(describeChange({ type: 'channel_closed', channel: 'Agency', weeks: 0 }).text).toBe('Agency: Channel closed');
    expect(describeChange({ type: 'channel_reopened', channel: 'LinkedIn' }).text).toBe('LinkedIn: Channel reopened');
    expect(describeChange({ type: 'channel_added', channel: 'Agency' }).text).toBe('Channel added: Agency');
    expect(describeChange({ type: 'channel_excluded', channel: 'Agency' }).text).toBe('Channel left out: Agency');
  });
  it('targets: a channel\'s weekly target and the role\'s qualified target, including the default', () => {
    expect(describeChange({ type: 'channel_target_changed', channel: 'Direct Outreach', from: 20, to: 30 })).toEqual({ category: 'target', text: 'Direct Outreach: Weekly sourcing target 20 → 30' });
    expect(describeChange({ type: 'channel_target_changed', channel: 'LinkedIn', from: null, to: 8 }).text).toBe('LinkedIn: Weekly sourcing target not set → 8');
    expect(describeChange({ type: 'qualified_target_changed', from: null, to: 8 }).text).toBe('Weekly qualified target default → 8');
    expect(describeChange({ type: 'qualified_target_changed', from: 8, to: null }).text).toBe('Weekly qualified target 8 → default');
  });
  it('exceptions: flagged, cleared by itself, back after a lapse, catching up, blocked', () => {
    expect(describeChange({ type: 'exception_opened', exception_type: 'VOLUME_GAP', channel: '*' })).toEqual({ category: 'exception', text: 'Flagged — Too few qualified candidates' });
    expect(describeChange({ type: 'exception_opened', exception_type: 'COMMITMENT_OVERDUE', channel: 'Agency' }).text).toBe('Agency: Flagged — Task overdue');
    expect(describeChange({ type: 'exception_cleared', exception_type: 'VOLUME_GAP', channel: '*' }).text).toBe('Cleared automatically — Too few qualified candidates');
    expect(describeChange({ type: 'exception_reopened', exception_type: 'VOLUME_GAP', channel: '*' }).text).toContain('catch-up date passed');
    expect(describeChange({ type: 'exception_snoozed', exception_type: 'VOLUME_GAP', channel: '*', until: '2026-11-03' }).text).toBe('Catching up by 3 Nov — Too few qualified candidates');
    expect(describeChange({ type: 'exception_blocked', exception_type: 'COMMITMENT_OVERDUE', channel: 'Agency', owner: 'Ria', due: '2026-11-03' }).text).toBe('Agency: Marked blocked (Ria to unblock, by 3 Nov) — Task overdue');
  });
  it('a task handed back by the tracker release says why a finished task is open again', () => {
    expect(describeChange({ type: 'task_handed_back', channel: 'Naukri/IIMjobs', commitment: 'Log the Naukri/IIMjobs post (link and weekly sourcing target)' })).toEqual({
      category: 'task',
      text: 'Naukri/IIMjobs: Task handed back: Log the Naukri/IIMjobs post (link and weekly sourcing target) — the weekly tracker needs the link and a weekly target',
    });
    expect(describeChange({ type: 'task_handed_back', channel: 'Direct Outreach' }).text).toBe('Direct Outreach: Task handed back: log the post — the weekly tracker needs the link and a weekly target');
  });
  it('a finished tracker week: met or missed, and cut short', () => {
    const base = { type: 'weekly_result', channel: 'Naukri/IIMjobs', week_start: '2026-10-21', week_end: '2026-10-27', target: 10 };
    expect(describeChange({ ...base, actual: 12, met: true })).toEqual({ category: 'weekly', text: 'Naukri/IIMjobs: Week 21 Oct–27 Oct: 12 of 10 applicants — target met' });
    expect(describeChange({ ...base, actual: 4, met: false, partial: true }).text).toBe('Naukri/IIMjobs: Week 21 Oct–27 Oct: 4 of 10 applicants — week cut short, not counted as met or missed');
  });
  it('plan lifecycle', () => {
    expect(describeChange({ type: 'activated', channels: [{ channel: 'LinkedIn', state: 'planned' }, { channel: 'Agency', state: 'excluded' }], weekly_qualified_target: 8 }).text)
      .toBe('Plan activated with 1 channel and a target of 8 qualified a week');
    expect(describeChange({ type: 'paused' }).text).toContain('on hold');
    expect(describeChange({ type: 'resumed', paused_days: 3 }).text).toBe('Plan resumed after 3 days on hold');
    expect(describeChange({ type: 'role_closed' }).category).toBe('plan');
    expect(describeChange({ type: 'strategy_note_changed' }).text).toBe('Strategy note edited');
  });
  it('never throws on an unknown or empty entry', () => {
    expect(describeChange({ type: 'something_new' }).text).toBe('something new');
    expect(describeChange(null).text).toBe('change');
    expect(describeChange({}).category).toBe('plan');
  });
});

describe('describeChange — paused and resumed (the weekly trackers stop with the hold)', () => {
  it('a pause says the role is on hold and that the weekly trackers stop until it is back', () => {
    expect(describeChange({ type: 'paused' })).toEqual({ category: 'plan', text: 'Plan paused — the role is on hold (the weekly trackers stop until it is back)' });
  });
  it('a resume names whole days on hold, singular for one, and says nothing for a hold of zero days (a few seconds) or an unknown length', () => {
    expect(describeChange({ type: 'resumed', paused_days: 1 }).text).toBe('Plan resumed after 1 day on hold');
    expect(describeChange({ type: 'resumed', paused_days: 12 }).text).toBe('Plan resumed after 12 days on hold');
    expect(describeChange({ type: 'resumed', paused_days: 0 })).toEqual({ category: 'plan', text: 'Plan resumed' });
    expect(describeChange({ type: 'resumed' }).text).toBe('Plan resumed');
    expect(describeChange({ type: 'resumed', paused_days: null }).text).toBe('Plan resumed');
    expect(describeChange({ type: 'resumed', paused_days: '3' }).text).toBe('Plan resumed');           // a string is not a number: never trusted
    expect(describeChange({ type: 'resumed', paused_days: NaN }).text).toBe('Plan resumed');
  });
});

describe('describeChange — a week cut short is never "met" or "missed"', () => {
  const base = { type: 'weekly_result', channel: 'LinkedIn', week_start: '2026-10-21', week_end: '2026-10-24', target: 20 };
  it('reads the same whether its numbers would have met the target or not', () => {
    const low = describeChange({ ...base, actual: 3, met: false, partial: true });
    const high = describeChange({ ...base, actual: 40, met: true, partial: true });
    expect(low.text).toBe('LinkedIn: Week 21 Oct–24 Oct: 3 of 20 applicants — week cut short, not counted as met or missed');
    expect(high.text).toBe('LinkedIn: Week 21 Oct–24 Oct: 40 of 20 applicants — week cut short, not counted as met or missed');
    for (const d of [low, high]) { expect(d.category).toBe('weekly'); expect(d.text).not.toMatch(/target (met|missed)/); }
  });
  it('a finished week keeps its verdict, and a missing partial flag means finished', () => {
    expect(describeChange({ ...base, actual: 25, met: true }).text).toBe('LinkedIn: Week 21 Oct–24 Oct: 25 of 20 applicants — target met');
    expect(describeChange({ ...base, actual: 5, met: false }).text).toBe('LinkedIn: Week 21 Oct–24 Oct: 5 of 20 applicants — target missed');
    expect(describeChange({ ...base, actual: 5, met: false, partial: false }).text).toContain('target missed');
  });
  it('a week with no applicants at all still reads sensibly', () => {
    expect(describeChange({ ...base, actual: 0, met: false, partial: true }).text).toBe('LinkedIn: Week 21 Oct–24 Oct: 0 of 20 applicants — week cut short, not counted as met or missed');
  });
  it('a week spanning a month end formats both dates', () => {
    expect(describeChange({ type: 'weekly_result', channel: 'Direct Outreach', week_start: '2026-10-29', week_end: '2026-11-04', target: 6, actual: 6, met: true }).text)
      .toBe('Direct Outreach: Week 29 Oct–4 Nov: 6 of 6 applicants — target met');
  });
  it('missing numbers, dates or channel never throw', () => {
    expect(() => describeChange({ type: 'weekly_result' })).not.toThrow();
    expect(describeChange({ type: 'weekly_result', met: true }).category).toBe('weekly');
    expect(typeof describeChange({ type: 'weekly_result', partial: true }).text).toBe('string');
  });
});

describe('describeChange — a channel closed (only finished weeks are counted)', () => {
  it('one tracked week is singular, zero on target is still said, and no finished week says nothing about weeks', () => {
    expect(describeChange({ type: 'channel_closed', channel: 'LinkedIn', weeks: 1, weeks_met: 1 }).text).toBe('LinkedIn: Channel closed after 1 tracked week (1 on target)');
    expect(describeChange({ type: 'channel_closed', channel: 'LinkedIn', weeks: 2, weeks_met: 0 }).text).toBe('LinkedIn: Channel closed after 2 tracked weeks (0 on target)');
    expect(describeChange({ type: 'channel_closed', channel: 'LinkedIn', weeks: 0, weeks_met: 0 }).text).toBe('LinkedIn: Channel closed');
    expect(describeChange({ type: 'channel_closed', channel: 'LinkedIn' }).text).toBe('LinkedIn: Channel closed');
  });
  it('weeks without a met count leaves the on-target part out', () => {
    expect(describeChange({ type: 'channel_closed', channel: 'LinkedIn', weeks: 3 }).text).toBe('LinkedIn: Channel closed after 3 tracked weeks');
  });
  it('a closed channel with no name still reads', () => {
    expect(describeChange({ type: 'channel_closed', weeks: 2, weeks_met: 1 }).text).toBe('Channel closed after 2 tracked weeks (1 on target)');
  });
});

describe('describeChange — "already running" is said only when the plan was activated over a channel that ran before HMS', () => {
  const done = (over: Record<string, unknown> = {}) => describeChange({ type: 'commitment_completed', channel: 'LinkedIn', commitment: 'Log the LinkedIn post (link and weekly sourcing target)', ...over });

  it('an ordinary completion (nothing flagged) never says "already running"', () => {
    expect(done().text).toBe('LinkedIn: Done — Log the LinkedIn post (link and weekly sourcing target)');
    expect(done({ url: 'https://l', weekly_target: 12 }).text).toBe('LinkedIn: Done — Log the LinkedIn post (link and weekly sourcing target) (link logged · weekly target 12)');
    expect(done({ url: 'https://l', weekly_target: 12 }).text).not.toMatch(/already running/);
  });
  it('already_running: true adds it — after the link and the target, before "late"', () => {
    expect(done({ already_running: true }).text).toBe('LinkedIn: Done — Log the LinkedIn post (link and weekly sourcing target) (already running)');
    expect(done({ url: 'https://l', weekly_target: 12, already_running: true }).text).toContain('(link logged · weekly target 12 · already running)');
    expect(done({ url: 'https://l', weekly_target: 12, already_running: true, on_time: false }).text).toContain('(link logged · weekly target 12 · already running · late)');
  });
  it('already_running: false, null or absent says nothing about it', () => {
    for (const v of [false, null, undefined, 0, '']) expect(done({ already_running: v }).text, String(v)).not.toMatch(/already running/);
  });
  it('the old stored "attested" flag no longer drives the wording, with or without already_running', () => {
    expect(done({ attested: true }).text).not.toMatch(/already running|attested/);
    expect(done({ attested: true, already_running: false }).text).not.toMatch(/already running|attested/);
    expect(done({ attested: false, already_running: true }).text).toMatch(/already running/);
    expect(done({ attested: true, already_running: true }).text.match(/already running/g)).toHaveLength(1);
  });
  it('the category stays "task" in every case', () => {
    for (const over of [{}, { already_running: true }, { attested: true }]) expect(done(over).category).toBe('task');
  });
  it('a late ordinary completion says only "late"', () => {
    expect(done({ on_time: false }).text).toBe('LinkedIn: Done — Log the LinkedIn post (link and weekly sourcing target) (late)');
    expect(done({ on_time: true }).text).not.toMatch(/late/);
  });
});

describe('describeChange — exceptions, more cases', () => {
  it('a blocker with only an owner, only a due date, or neither', () => {
    expect(describeChange({ type: 'exception_blocked', exception_type: 'COMMITMENT_OVERDUE', channel: 'Agency', owner: 'Ria' }).text).toBe('Agency: Marked blocked (Ria to unblock) — Task overdue');
    expect(describeChange({ type: 'exception_blocked', exception_type: 'COMMITMENT_OVERDUE', channel: 'Agency', due: '2026-11-03' }).text).toBe('Agency: Marked blocked (by 3 Nov) — Task overdue');
    expect(describeChange({ type: 'exception_blocked', exception_type: 'COMMITMENT_OVERDUE', channel: 'Agency' }).text).toBe('Agency: Marked blocked — Task overdue');
  });
  it('a provisional signal that went live is logged as an ordinary "Flagged" entry, and plan-level ones carry no channel prefix', () => {
    expect(describeChange({ type: 'exception_opened', exception_type: 'VOLUME_GAP', channel: '*' })).toEqual({ category: 'exception', text: 'Flagged — Too few qualified candidates' });
    expect(describeChange({ type: 'exception_opened', exception_type: 'VOLUME_GAP' }).text).toBe('Flagged — Too few qualified candidates');
  });
  it('an exception type the table does not know reads as plain lower-case words and never throws', () => {
    expect(describeChange({ type: 'exception_opened', exception_type: 'SOMETHING_NEW', channel: 'LinkedIn' }).text).toBe('LinkedIn: Flagged — something new');
    expect(describeChange({ type: 'exception_cleared' }).text).toBe('Cleared automatically — exception');
  });
  it('a channel whose set-up is overdue is labelled "Channel set-up overdue" everywhere it is described — never "Channel not live"', () => {
    expect(EXCEPTION_LABELS.CHANNEL_NOT_ACTIVATED).toBe('Channel set-up overdue');
    expect(describeChange({ type: 'exception_opened', exception_type: 'CHANNEL_NOT_ACTIVATED', channel: 'LinkedIn' })).toEqual({ category: 'exception', text: 'LinkedIn: Flagged — Channel set-up overdue' });
    expect(describeChange({ type: 'exception_cleared', exception_type: 'CHANNEL_NOT_ACTIVATED', channel: 'Direct Outreach' }).text).toBe('Direct Outreach: Cleared automatically — Channel set-up overdue');
    expect(describeChange({ type: 'exception_reopened', exception_type: 'CHANNEL_NOT_ACTIVATED', channel: 'Naukri/IIMjobs' }).text).toBe('Naukri/IIMjobs: Back on the list — Channel set-up overdue (catch-up date passed)');
    expect(describeChange({ type: 'exception_snoozed', exception_type: 'CHANNEL_NOT_ACTIVATED', channel: 'Agency', until: '2026-11-03' }).text).toBe('Agency: Catching up by 3 Nov — Channel set-up overdue');
    expect(describeChange({ type: 'strategy_changed', exception: 'CHANNEL_NOT_ACTIVATED', channel: 'Agency', excluded: true }).text).toBe('Strategy changed to resolve “Channel set-up overdue” on Agency (channel dropped)');
    for (const text of Object.values(EXCEPTION_LABELS)) expect(text).not.toMatch(/not live/i);
  });
  it('every exception label in the table is plain words, and every engine type has one', () => {
    for (const t of ['PLAN_NOT_ACTIVATED', 'CHANNEL_NOT_ACTIVATED', 'COMMITMENT_OVERDUE', 'FOLLOWUP_OVERDUE', 'VOLUME_GAP', 'BLOCKER_OVERDUE']) {
      expect(EXCEPTION_LABELS[t], t).toMatch(/^[A-Z][a-z]/);
      expect(describeChange({ type: 'exception_opened', exception_type: t }).text).toBe(`Flagged — ${EXCEPTION_LABELS[t]}`);
    }
  });
});

describe('describeChange — channels from the role and misc', () => {
  it('channels added from or removed on the role list the names', () => {
    expect(describeChange({ type: 'channels_added_on_role', channels: ['LinkedIn', 'Agency'] })).toEqual({ category: 'channel', text: 'Channels added from the role: LinkedIn, Agency' });
    expect(describeChange({ type: 'channels_removed_on_role', channels: ['Direct Outreach'] }).text).toBe('Channels removed from the role: Direct Outreach');
    expect(describeChange({ type: 'channels_removed_on_role', channels: 'LinkedIn' }).text).toBe('Channels removed from the role: ');       // a non-list is ignored, not spread into letters
  });
  it('a link or strategy change, and the role being closed or reopened', () => {
    expect(describeChange({ type: 'channel_link_changed', channel: 'LinkedIn' })).toEqual({ category: 'channel', text: 'LinkedIn: Post link updated' });
    expect(describeChange({ type: 'role_reopened' }).text).toContain('back in draft');
    expect(describeChange({ type: 'role_closed' }).text).toContain('closed');
    expect(describeChange({ type: 'strategy_changed', exception: 'VOLUME_GAP', channel: 'Agency', excluded: true }).text)
      .toBe('Strategy changed to resolve “Too few qualified candidates” on Agency (channel dropped)');
  });
  it('an activation counts only the channels that are in the plan, and says nothing of a missing target', () => {
    expect(describeChange({ type: 'activated', channels: [{ state: 'excluded' }, { state: 'excluded' }] }).text).toBe('Plan activated with 0 channels');
    expect(describeChange({ type: 'activated', channels: [{ state: 'active' }, { state: 'planned' }] }).text).toBe('Plan activated with 2 channels');
    expect(describeChange({ type: 'activated' }).text).toBe('Plan activated with 0 channels');
  });
  it('a task completed shows only the facts it has: no link, no target, not late, not attested', () => {
    expect(describeChange({ type: 'commitment_completed', channel: 'Agency', commitment: 'Brief the agencies' }).text).toBe('Agency: Done — Brief the agencies');
    expect(describeChange({ type: 'commitment_completed' }).text).toBe('Done — task');
  });
  it('every category is one of the six the timeline filters on', () => {
    const types = ['activated', 'paused', 'resumed', 'role_closed', 'role_reopened', 'strategy_note_changed', 'strategy_changed', 'commitment_completed', 'commitment_skipped',
      'commitment_reopened', 'channel_added', 'channel_excluded', 'channels_added_on_role', 'channels_removed_on_role', 'channel_closed', 'channel_reopened', 'channel_link_changed',
      'channel_target_changed', 'qualified_target_changed', 'exception_opened', 'exception_cleared', 'exception_reopened', 'exception_snoozed', 'exception_blocked', 'weekly_result', 'nope'];
    for (const type of types) expect(['plan', 'task', 'channel', 'target', 'exception', 'weekly']).toContain(describeChange({ type }).category);
  });
});
