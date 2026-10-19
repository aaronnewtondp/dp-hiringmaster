import { describe, it, expect } from 'vitest';
import { sourcingChip } from './useSourcingPlan.ts';
import { SourcingException, SourcingPlanResponse } from '../types/sourcing.ts';

const ex = (over: Partial<SourcingException> = {}): SourcingException => ({
  id: '1', channel: 'LinkedIn', type: 'CHANNEL_NOT_ACTIVATED', status: 'open', severity: 30, is_shadow: false, detected_at: '2026-10-14T00:00:00Z',
  last_seen_at: '2026-10-14T00:00:00Z', evidence: {}, resolution_path: null, reason: null, corrective_action: null, snooze_until: null,
  blocker_due: null, blocker_owner_name: null, resolved_at: null, committed: 'c', happened: 'h', next_action: 'n', ...over,
});
const view = (status: string, exceptions: SourcingException[] = []): SourcingPlanResponse => ({
  enabled: true, exceptions,
  plan: { id: '1', role_id: 'R1', status: status as never, strategy_note: null, baseline: null, baseline_at: null,
          activated_at: null, paused_at: null, pause_total_days: 0, closed_at: null },
});

describe('sourcingChip', () => {
  it('nothing while the module is off, with no plan, or once the plan is closed', () => {
    expect(sourcingChip(undefined)).toBeNull();
    expect(sourcingChip({ enabled: false })).toBeNull();
    expect(sourcingChip({ enabled: true, plan: null })).toBeNull();
    expect(sourcingChip(view('closed'))).toBeNull();
  });
  it('draft and paused plans say so', () => {
    expect(sourcingChip(view('draft'))).toEqual({ text: 'Sourcing plan not activated', tone: 'amber' });
    expect(sourcingChip(view('paused'))?.tone).toBe('gray');
  });
  it('counts only live (non-provisional) open or blocked exceptions', () => {
    expect(sourcingChip(view('active', [ex(), ex({ id: '2', status: 'blocked' })]))).toEqual({ text: 'Sourcing: 2 issues', tone: 'red' });
    expect(sourcingChip(view('active', [ex()]))?.text).toBe('Sourcing: 1 issue');
    expect(sourcingChip(view('active', [ex({ is_shadow: true })]))).toEqual({ text: 'Sourcing on track', tone: 'green' });
  });
  it('a snoozed exception is "catching up", never "on track"', () => {
    expect(sourcingChip(view('active', [ex({ status: 'snoozed' })]))).toEqual({ text: 'Sourcing: catching up', tone: 'amber' });
    // ...but an open one outranks it
    expect(sourcingChip(view('active', [ex({ status: 'snoozed' }), ex({ id: '3' })]))?.tone).toBe('red');
  });
});
