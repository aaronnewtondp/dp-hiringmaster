import { describe, it, expect } from 'vitest';
import { ageDays, describeException } from './sourcingDescribe.js';

describe('describeException', () => {
  it('channel not activated: names the channel, the worst lateness and the due date', () => {
    const d = describeException({ type: 'CHANNEL_NOT_ACTIVATED', channel: 'LinkedIn', evidence: {
      count: 1, overdue: [{ kind: 'activate_channel', title: 'Publish the posting', due: '2026-10-13', days_overdue: 1 }] } });
    expect(d.committed).toBe('LinkedIn: Publish the posting');
    expect(d.happened).toBe('Not done — 1 day overdue (was due 2026-10-13)');
    expect(d.next_action).toBe('Publish on LinkedIn and mark it done');
    expect(describeException({ type: 'CHANNEL_NOT_ACTIVATED', channel: 'Agency', evidence: {} }).next_action).toContain('Choose the agencies');
  });

  it('rolled-up commitments say how many more, using the worst lateness', () => {
    const d = describeException({ type: 'COMMITMENT_OVERDUE', channel: 'Agency', evidence: { count: 3, overdue: [
      { title: 'Renew', due: '2026-10-10', days_overdue: 4 }, { title: 'Nudge', due: '2026-10-12', days_overdue: 2 }, { title: 'x', due: '2026-10-13', days_overdue: 1 }] } });
    expect(d.committed).toBe('Agency: Renew (+2 more)');
    expect(d.happened).toContain('4 days overdue');
  });

  it('plan not activated', () => {
    const d = describeException({ type: 'PLAN_NOT_ACTIVATED', channel: '*', evidence: { approved_on: '2026-10-12', days_overdue: 2 } });
    expect(d.happened).toBe('Still a draft — 2 days late (approved 2026-10-12)');
  });

  it('volume gap shows both components so the broad "qualified" definition is never opaque', () => {
    const d = describeException({ type: 'VOLUME_GAP', channel: '*', evidence: { min: 5, weekly_qualified: 2, shortlisted: 1, scored: 2, window_days: 7 } });
    expect(d.committed).toBe('At least 5 qualified candidates a week');
    expect(d.happened).toContain('2 in the last 7 days (1 shortlisted · 2 scored above 60)');
  });

  it('blocker overdue', () => {
    expect(describeException({ type: 'BLOCKER_OVERDUE', channel: 'Agency', evidence: { days_overdue: 3, blocker_due: '2026-10-10' } }).happened)
      .toBe('3 days past the deadline (2026-10-10)');
  });

  it('survives missing or malformed evidence', () => {
    expect(() => describeException({ type: 'COMMITMENT_OVERDUE', channel: 'LinkedIn', evidence: null })).not.toThrow();
    expect(() => describeException({ type: 'VOLUME_GAP', channel: '*', evidence: { overdue: 'x', min: 'five' } })).not.toThrow();
    expect(describeException({ type: 'MYSTERY', channel: '*', evidence: {} }).committed).toBe('MYSTERY');
  });
});

describe('ageDays', () => {
  it('floors to whole days and is never negative', () => {
    const now = new Date('2026-10-14T12:00:00Z');
    expect(ageDays('2026-10-12T13:00:00Z', now)).toBe(1);
    expect(ageDays('2026-10-12T12:00:00Z', now)).toBe(2);
    expect(ageDays('2026-10-20T12:00:00Z', now)).toBe(0);
  });
});
