import { describe, it, expect } from 'vitest';
import {
  detectBlockerOverdue, detectCommitmentExceptions, detectPlanNotActivated, detectVolumeGap, inShadowPeriod, typeForKind,
  OpenCommitment, QualifiedInput, qualifiedAt,
} from './sourcingChecker.js';
import { DEFAULT_SOURCING_SETTINGS, SourcingSettings } from '../utils/sourcingConfig.js';
import { endOfIstDay } from '../utils/workingDays.js';

// 2026-10-14 is a Wednesday. 06:30Z = 12:00 IST.
const WED = new Date('2026-10-14T06:30:00Z');
const S = (over: Partial<SourcingSettings> = {}): SourcingSettings => ({ ...DEFAULT_SOURCING_SETTINGS, ...over });

const commitment = (over: Partial<OpenCommitment> = {}): OpenCommitment => ({
  plan_id: '1', plan_status: 'active', role_id: 'R001', priority: 'P1', channel: 'LinkedIn', channel_state: 'planned',
  kind: 'activate_channel', title: 'Publish the posting', due_at: endOfIstDay('2026-10-13'), meta: null, ...over,
});

describe('typeForKind', () => {
  it('maps commitment kinds to exception types', () => {
    expect(typeForKind('activate_channel')).toBe('CHANNEL_NOT_ACTIVATED');
    expect(typeForKind('followup_agency')).toBe('FOLLOWUP_OVERDUE');
    expect(typeForKind('renew_posting')).toBe('COMMITMENT_OVERDUE');
    expect(typeForKind('weekly_outbound')).toBe('COMMITMENT_OVERDUE');
  });
});

describe('detectCommitmentExceptions', () => {
  it('raises nothing until the due DAY has ended (IST)', () => {
    expect(detectCommitmentExceptions([commitment({ due_at: endOfIstDay('2026-10-14') })], WED)).toEqual([]);
    expect(detectCommitmentExceptions([commitment({ due_at: endOfIstDay('2026-10-13') })], WED)).toHaveLength(1);
  });

  it('is deterministic and live (never shadow) with counts/titles only as evidence', () => {
    const [e] = detectCommitmentExceptions([commitment()], WED);
    expect(e).toMatchObject({ plan_id: '1', channel: 'LinkedIn', type: 'CHANNEL_NOT_ACTIVATED', subject_key: '', is_shadow: false });
    expect(e.evidence).toEqual({ count: 1, overdue: [{ kind: 'activate_channel', title: 'Publish the posting', due: '2026-10-13', days_overdue: 1 }] });
  });

  it('rolls several overdue commitments on one channel into ONE exception at the worst type', () => {
    const out = detectCommitmentExceptions([
      commitment({ kind: 'renew_posting', title: 'Renew' }),
      commitment({ kind: 'activate_channel' }),
      commitment({ kind: 'followup_agency', channel: 'Agency', title: 'Nudge agencies' }),
    ], WED);
    expect(out).toHaveLength(2);
    expect(out.find(o => o.channel === 'LinkedIn')).toMatchObject({ type: 'CHANNEL_NOT_ACTIVATED' });
    expect(out.find(o => o.channel === 'LinkedIn')!.evidence.count).toBe(2);
    expect(out.find(o => o.channel === 'Agency')).toMatchObject({ type: 'FOLLOWUP_OVERDUE' });
  });

  it('ranks FOLLOWUP_OVERDUE above COMMITMENT_OVERDUE on the same channel', () => {
    const [e] = detectCommitmentExceptions([
      commitment({ channel: 'Agency', kind: 'renew_posting' }), commitment({ channel: 'Agency', kind: 'followup_agency' }),
    ], WED);
    expect(e.type).toBe('FOLLOWUP_OVERDUE');
  });

  it('skips excluded channels and every plan that is not active (draft, paused, closed)', () => {
    expect(detectCommitmentExceptions([commitment({ channel_state: 'excluded' })], WED)).toEqual([]);
    expect(detectCommitmentExceptions([commitment({ plan_status: 'draft' })], WED)).toEqual([]);
    expect(detectCommitmentExceptions([commitment({ plan_status: 'paused' })], WED)).toEqual([]);
    expect(detectCommitmentExceptions([commitment({ plan_status: 'closed' })], WED)).toEqual([]);
  });

  it('weekly outbound stays silent through baseline_until (inclusive), then raises', () => {
    const w = (until: string) => commitment({ channel: 'Direct Outreach', kind: 'weekly_outbound', meta: { baseline_until: until } });
    expect(detectCommitmentExceptions([w('2026-10-14')], WED)).toEqual([]);
    expect(detectCommitmentExceptions([w('2026-10-13')], WED)).toHaveLength(1);
    // baseline does not suppress other kinds on the same channel
    expect(detectCommitmentExceptions([commitment({ channel: 'Direct Outreach', meta: { baseline_until: '2026-12-01' } })], WED)).toHaveLength(1);
  });

  it('severity = priority + days overdue (capped at 20) + 15 for a Low Pipeline role', () => {
    const sev = (c: Partial<OpenCommitment>, low: string[] = []) => detectCommitmentExceptions([commitment(c)], WED, new Set(low))[0].severity;
    expect(sev({ priority: 'P0' })).toBe(41);                                 // 40 + 1
    expect(sev({ priority: 'P2' })).toBe(21);                                 // 20 + 1
    expect(sev({ priority: 'P1', due_at: endOfIstDay('2026-08-01') })).toBe(50); // 30 + cap 20
    expect(sev({ priority: 'P1' }, ['R001'])).toBe(46);                       // 30 + 1 + 15
  });

  it('accepts due_at as an ISO string (node-pg timestamptz may arrive either way)', () => {
    expect(detectCommitmentExceptions([commitment({ due_at: endOfIstDay('2026-10-13').toISOString() })], WED)).toHaveLength(1);
  });
});

describe('detectPlanNotActivated', () => {
  const role = (over: Record<string, unknown> = {}) => ({
    plan_id: '1', role_id: 'R001', priority: 'P1', approval_date: '2026-10-12', plan_status: 'draft', ...over,
  });

  it('never fires without a go-live date, nor for roles approved before it', () => {
    expect(detectPlanNotActivated([role()], WED, S())).toEqual([]);
    expect(detectPlanNotActivated([role({ approval_date: '2026-10-01' })], WED, S({ go_live_date: '2026-10-05' }))).toEqual([]);
  });

  it('is due 1 working day after approval and raised only after that day', () => {
    const s = S({ go_live_date: '2026-10-01' });
    // approved Tue 13th → due Wed 14th: not raised on the 14th, raised on the 15th
    expect(detectPlanNotActivated([role({ approval_date: '2026-10-13' })], WED, s)).toEqual([]);
    const thu = new Date('2026-10-15T06:30:00Z');
    const [e] = detectPlanNotActivated([role({ approval_date: '2026-10-13' })], thu, s);
    expect(e).toMatchObject({ type: 'PLAN_NOT_ACTIVATED', channel: '*', is_shadow: false });
    expect(e.evidence).toMatchObject({ approved_on: '2026-10-13', due_on: '2026-10-14', days_overdue: 1 });
  });

  it('skips the weekend: approved Fri → due Mon → raised Tue', () => {
    const s = S({ go_live_date: '2026-10-01' });
    const mon = new Date('2026-10-19T06:30:00Z'), tue = new Date('2026-10-20T06:30:00Z');
    expect(detectPlanNotActivated([role({ approval_date: '2026-10-16' })], mon, s)).toEqual([]);
    expect(detectPlanNotActivated([role({ approval_date: '2026-10-16' })], tue, s)).toHaveLength(1);
  });

  it('ignores plans that are active, paused or closed', () => {
    const s = S({ go_live_date: '2026-10-01' });
    for (const plan_status of ['active', 'paused', 'closed']) expect(detectPlanNotActivated([role({ plan_status })], WED, s)).toEqual([]);
  });
});

describe('detectVolumeGap', () => {
  const scored = (iso: string): QualifiedInput => ({ shortlisted_at: null, scored_at: new Date(iso) });
  const shortlisted = (iso: string): QualifiedInput => ({ shortlisted_at: new Date(iso), scored_at: null });
  const role = (apps: QualifiedInput[], priority = 'P1') => ({ plan_id: '1', role_id: 'R001', priority, apps });

  it('fires when under the minimum on EACH of the last 5 working days — and is shadow while shadow_until has not passed', () => {
    const [e] = detectVolumeGap([role([])], WED, S({ shadow_until: '2026-11-15' }));
    expect(e).toMatchObject({ type: 'VOLUME_GAP', channel: '*', is_shadow: true });
    expect(e.evidence).toMatchObject({ weekly_qualified: 0, min: 5, window_days: 7, rule: 'either' });
    expect((e.evidence.per_day as unknown[]).length).toBe(5);
  });

  it('is live once the shadow period is over (shadow_until inclusive)', () => {
    expect(detectVolumeGap([role([])], WED, S({ shadow_until: '2026-10-14' }))[0].is_shadow).toBe(true);
    expect(detectVolumeGap([role([])], WED, S({ shadow_until: '2026-10-13' }))[0].is_shadow).toBe(false);
    expect(detectVolumeGap([role([])], WED, S({ shadow_until: null }))[0].is_shadow).toBe(false);
  });

  it('does not fire when any one of the 5 days reaches the minimum', () => {
    const five = Array.from({ length: 5 }, () => scored('2026-10-14T03:00:00Z'));
    expect(detectVolumeGap([role(five)], WED, S())).toEqual([]);
  });

  it('4 qualified in the window is still a gap (5 is the boundary)', () => {
    const four = Array.from({ length: 4 }, () => scored('2026-10-14T03:00:00Z'));
    const [e] = detectVolumeGap([role(four)], WED, S());
    expect(e.evidence.weekly_qualified).toBe(4);
  });

  it('only P0/P1 — the SOP sets no volume target for P2/P3', () => {
    expect(detectVolumeGap([role([], 'P2'), role([], 'P3')], WED, S())).toEqual([]);
    expect(detectVolumeGap([role([], 'P0')], WED, S())).toHaveLength(1);
  });

  it('honours qualified_rule: a shortlist alone counts under "either"/"shortlisted" but not "scored"', () => {
    const five = Array.from({ length: 5 }, () => shortlisted('2026-10-14T03:00:00Z'));
    expect(detectVolumeGap([role(five)], WED, S({ qualified_rule: 'either' }))).toEqual([]);
    expect(detectVolumeGap([role(five)], WED, S({ qualified_rule: 'shortlisted' }))).toEqual([]);
    expect(detectVolumeGap([role(five)], WED, S({ qualified_rule: 'scored' }))).toHaveLength(1);
  });

  it('an application counts once, in the week it FIRST met either condition', () => {
    const both: QualifiedInput = { shortlisted_at: new Date('2026-10-14T03:00:00Z'), scored_at: new Date('2026-10-01T03:00:00Z') };
    expect(qualifiedAt(both, 'either')!.toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(qualifiedAt(both, 'shortlisted')!.toISOString()).toBe('2026-10-14T03:00:00.000Z');
    expect(qualifiedAt({ shortlisted_at: null, scored_at: null }, 'either')).toBeNull();
  });

  describe('per-role target (sourcing_plans.weekly_qualified_target)', () => {
    const withTarget = (apps: QualifiedInput[], target: number | null, priority = 'P1') => ({ plan_id: '1', role_id: 'R001', priority, apps, target });

    it('a role\'s own target replaces the default: 6 qualified is a gap against 8, and fine against the default 5', () => {
      const six = Array.from({ length: 6 }, () => scored('2026-10-14T03:00:00Z'));
      const [e] = detectVolumeGap([withTarget(six, 8)], WED, S());
      expect(e.evidence).toMatchObject({ min: 8, weekly_qualified: 6 });
      expect(detectVolumeGap([withTarget(six, null)], WED, S())).toEqual([]);
    });
    it('a lower target is respected too: 2 qualified meets a target of 2 even though the default is 5', () => {
      const two = Array.from({ length: 2 }, () => scored('2026-10-14T03:00:00Z'));
      expect(detectVolumeGap([withTarget(two, 2)], WED, S())).toEqual([]);
      expect(detectVolumeGap([withTarget(two, null)], WED, S())).toHaveLength(1);
    });
    it('a P2/P3 role is checked once it has a target of its own, and not before', () => {
      expect(detectVolumeGap([withTarget([], null, 'P2')], WED, S())).toEqual([]);
      const [e] = detectVolumeGap([withTarget([], 3, 'P3')], WED, S());
      expect(e).toMatchObject({ type: 'VOLUME_GAP' });
      expect(e.evidence.min).toBe(3);
    });
    it('the default follows the setting for a role with no target of its own', () => {
      expect(detectVolumeGap([withTarget([], null)], WED, S({ volume_min_qualified: 9 }))[0].evidence.min).toBe(9);
    });
  });

  it('the 5-working-day lookback skips weekends only', () => {
    const days = detectVolumeGap([role([])], WED, S())[0].evidence.per_day as Array<{ date: string }>;
    expect(days.map(d => d.date)).toEqual(['2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14']);   // Thu, Fri, then Mon–Wed
  });
});

describe('detectBlockerOverdue', () => {
  const b = (due: string, over: Record<string, unknown> = {}) => ({
    id: '9', plan_id: '1', channel: 'Agency', priority: 'P1', blocker_due: due, blocker_owner_user_id: 'u2', original_type: 'FOLLOWUP_OVERDUE', ...over,
  });

  it('is overdue only after the blocker deadline day', () => {
    expect(detectBlockerOverdue([b('2026-10-14')], '2026-10-14')).toEqual([]);
    expect(detectBlockerOverdue([b('2026-10-13')], '2026-10-14')).toHaveLength(1);
  });

  it('keys the exception to the blocked one', () => {
    const [e] = detectBlockerOverdue([b('2026-10-10')], '2026-10-14');
    expect(e).toMatchObject({ type: 'BLOCKER_OVERDUE', subject_key: '9', is_shadow: false });
    expect(e).not.toHaveProperty('owner_user_id');                          // exceptions belong to the HR persona, not to a person
    expect(e.evidence).toMatchObject({ days_overdue: 4, original_type: 'FOLLOWUP_OVERDUE', original_exception_id: '9' });
  });
});

describe('inShadowPeriod', () => {
  it('null shadow_until means live', () => {
    expect(inShadowPeriod(S(), '2026-10-14')).toBe(false);
  });
});
