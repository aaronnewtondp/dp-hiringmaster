import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SourcingAdvice, SourcingException, SourcingPlanResponse, SourcingWorkspaceResponse } from '../types/sourcing.ts';

// Plain functions behind the mocks, not vi.fn() rejections: a spy re-throws a rejected result on a derived promise, which vitest reports as an unhandled error.
let planImpl: (id: string) => Promise<unknown> = async () => ({ data: { enabled: false } });
let workspaceImpl: () => Promise<unknown> = async () => ({ data: { enabled: false } });
let adviceImpl: (id: string, refresh?: boolean) => Promise<unknown> = async () => ({ data: { enabled: true, advice: null } });
const planCalls: string[] = [];
const workspaceCalls: number[] = [];
const adviceCalls: Array<[string, boolean | undefined]> = [];
vi.mock('../services/api.ts', () => ({
  sourcingApi: {
    plan: (id: string) => { planCalls.push(id); return planImpl(id); },
    workspace: () => { workspaceCalls.push(1); return workspaceImpl(); },
    advice: (id: string, refresh?: boolean) => { adviceCalls.push([id, refresh]); return adviceImpl(id, refresh); },
  },
}));

import { sourcingChip, useSourcingAdvice, useSourcingPlan, useSourcingWorkspace } from './useSourcingPlan.ts';

const ex = (over: Partial<SourcingException> = {}): SourcingException => ({
  id: '1', channel: 'LinkedIn', type: 'CHANNEL_NOT_ACTIVATED', status: 'open', severity: 30, is_shadow: false, detected_at: '2026-10-14T00:00:00Z',
  last_seen_at: '2026-10-14T00:00:00Z', evidence: {}, resolution_path: null, reason: null, corrective_action: null, snooze_until: null,
  blocker_due: null, blocker_owner_name: null, resolved_at: null, committed: 'c', happened: 'h', next_action: 'n', ...over,
});
const view = (status: string, exceptions: SourcingException[] = []): SourcingPlanResponse => ({
  enabled: true, exceptions,
  plan: { id: '1', role_id: 'R1', status: status as never, strategy_note: null, baseline: null, baseline_at: null,
          activated_at: null, paused_at: null, pause_total_days: 0, closed_at: null, weekly_qualified_target: null },
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
  it('a resolved exception never counts, and a closed plan has no chip however many exceptions it carries', () => {
    expect(sourcingChip(view('active', [ex({ status: 'resolved' })]))).toEqual({ text: 'Sourcing on track', tone: 'green' });
    expect(sourcingChip(view('closed', [ex()]))).toBeNull();
  });
  it('a paused plan stays "paused" whatever is open on it', () => {
    expect(sourcingChip(view('paused', [ex(), ex({ id: '2' })]))).toEqual({ text: 'Sourcing paused', tone: 'gray' });
  });
  it('tolerates a view with no exceptions list at all', () => {
    const v = view('active'); delete (v as { exceptions?: unknown }).exceptions;
    expect(sourcingChip(v)).toEqual({ text: 'Sourcing on track', tone: 'green' });
  });
});

// ─── the hooks ───────────────────────────────────────────────────────────────────────────────────
// The client's own default is generous retries: a hook that is meant to be "never retried" has to say so itself.
let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
const fresh = () => { qc = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 1 } } }); };

const advice = (over: Partial<SourcingAdvice> = {}): SourcingAdvice => ({
  advice: { headline: 'Two channels are quiet', steps: [{ id: 's1', title: 'Repost on LinkedIn', detail: 'Post it again today', channel: 'LinkedIn', exception_id: null, impact: 'high', owner: 'HR' }], watch: [] },
  source: 'ai', model: 'claude-sonnet-4-5', generated_at: '2026-10-21T08:00:00Z', facts_hash: 'abc', stale: false, ...over,
});

beforeEach(() => {
  fresh();
  planCalls.length = 0; workspaceCalls.length = 0; adviceCalls.length = 0;
  planImpl = async () => ({ data: { enabled: false } });
  workspaceImpl = async () => ({ data: { enabled: false } });
  adviceImpl = async () => ({ data: { enabled: true, advice: null } });
});

describe('useSourcingPlan', () => {
  it('does not ask the server until there is a role id', async () => {
    const { result, rerender } = renderHook(({ id }: { id?: string }) => useSourcingPlan(id), { wrapper, initialProps: { id: undefined } });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(planCalls).toHaveLength(0);
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
    rerender({ id: 'R5' });
    await waitFor(() => expect(planCalls).toEqual(['R5']));
  });

  it('returns the plan view as the server sent it (the body, not the axios envelope)', async () => {
    const v = view('active');
    planImpl = async () => ({ data: v });
    const { result } = renderHook(() => useSourcingPlan('R5'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(v));
  });

  it('passes {enabled:false} straight through, so the UI can hide itself', async () => {
    const { result } = renderHook(() => useSourcingPlan('R5'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ enabled: false }));
  });

  it('a failure (a 403 for a Hiring Manager of another role) yields no data and is asked once, never retried', async () => {
    planImpl = async () => { throw new Error('403'); };
    const { result } = renderHook(() => useSourcingPlan('R5'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    expect(planCalls).toHaveLength(1);
  });

  it('is cached per role under ["sourcing-plan", id], and counts as fresh for 30 s (a remount does not ask again)', async () => {
    planImpl = async id => ({ data: { enabled: true, plan: null, id } });
    const first = renderHook(() => useSourcingPlan('R5'), { wrapper });
    await waitFor(() => expect(first.result.current.data).toBeDefined());
    expect(qc.getQueryData(['sourcing-plan', 'R5'])).toEqual(first.result.current.data);
    first.unmount();
    renderHook(() => useSourcingPlan('R5'), { wrapper });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(planCalls).toEqual(['R5']);
    renderHook(() => useSourcingPlan('R6'), { wrapper });
    await waitFor(() => expect(planCalls).toEqual(['R5', 'R6']));
  });
});

describe('useSourcingWorkspace', () => {
  const ws: SourcingWorkspaceResponse = { enabled: true, read_only: false, roles: [], drafts: [] };

  it('returns the workspace body', async () => {
    workspaceImpl = async () => ({ data: ws });
    const { result } = renderHook(() => useSourcingWorkspace(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(ws));
    expect(qc.getQueryData(['sourcing-workspace'])).toEqual(ws);
  });

  it('passes {enabled:false} through while the module is off', async () => {
    const { result } = renderHook(() => useSourcingWorkspace(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ enabled: false }));
  });

  it('a failure yields no data and is asked once', async () => {
    workspaceImpl = async () => { throw new Error('500'); };
    const { result } = renderHook(() => useSourcingWorkspace(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    expect(workspaceCalls).toHaveLength(1);
  });

  it('two components share one request', async () => {
    workspaceImpl = async () => ({ data: ws });
    const a = renderHook(() => useSourcingWorkspace(), { wrapper });
    const b = renderHook(() => useSourcingWorkspace(), { wrapper });
    await waitFor(() => expect(a.result.current.data && b.result.current.data).toBeTruthy());
    expect(workspaceCalls).toHaveLength(1);
  });
});

describe('useSourcingAdvice', () => {
  const payload = (a: SourcingAdvice | null = advice()) => ({ data: { enabled: true, advice: a } });

  it('does nothing until it is enabled (a Hiring Manager, a draft or closed plan never asks for advice)', async () => {
    const { result, rerender } = renderHook(({ on }: { on: boolean }) => useSourcingAdvice('R5', on), { wrapper, initialProps: { on: false } });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(adviceCalls).toHaveLength(0);
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
    adviceImpl = async () => payload();
    rerender({ on: true });
    await waitFor(() => expect(result.current.data?.advice?.advice.headline).toBe('Two channels are quiet'));
    expect(adviceCalls).toEqual([['R5', undefined]]);
  });

  it('does nothing without a role id even when enabled', async () => {
    const { result } = renderHook(() => useSourcingAdvice(undefined, true), { wrapper });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(adviceCalls).toHaveLength(0);
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('returns the body, caches it under ["sourcing-advice", id], and tolerates "no advice yet"', async () => {
    adviceImpl = async () => payload(null);
    const { result } = renderHook(() => useSourcingAdvice('R5', true), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ enabled: true, advice: null }));
    expect(qc.getQueryData(['sourcing-advice', 'R5'])).toEqual({ enabled: true, advice: null });
  });

  it('a failed read yields no data, is asked once, and leaves the refresh mutation idle', async () => {
    adviceImpl = async () => { throw new Error('502'); };
    const { result } = renderHook(() => useSourcingAdvice('R5', true), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    expect(adviceCalls).toHaveLength(1);
    expect(result.current.refresh.isIdle).toBe(true);
  });

  it('refresh asks for new advice (second argument true) and writes it straight into the cache, replacing the old', async () => {
    adviceImpl = async (_id, refresh) => refresh ? payload(advice({ facts_hash: 'new', advice: { headline: 'Fresh', steps: [], watch: [] } })) : payload();
    const { result } = renderHook(() => useSourcingAdvice('R5', true), { wrapper });
    await waitFor(() => expect(result.current.data?.advice?.advice.headline).toBe('Two channels are quiet'));

    await act(async () => { await result.current.refresh.mutateAsync(); });
    expect(adviceCalls[adviceCalls.length - 1]).toEqual(['R5', true]);
    expect(adviceCalls).toHaveLength(2);                          // one read, one refresh: no extra re-read after the mutation
    await waitFor(() => expect(result.current.data?.advice?.advice.headline).toBe('Fresh'));
    expect((qc.getQueryData(['sourcing-advice', 'R5']) as { advice: SourcingAdvice }).advice.facts_hash).toBe('new');
    expect(result.current.refresh.isSuccess).toBe(true);
  });

  it('a refresh that fails (rate-limited to once a minute) reports the error and keeps the advice already shown', async () => {
    adviceImpl = async (_id, refresh) => { if (refresh) throw new Error('429'); return payload(); };
    const { result } = renderHook(() => useSourcingAdvice('R5', true), { wrapper });
    await waitFor(() => expect(result.current.data?.advice?.advice.headline).toBe('Two channels are quiet'));
    await act(async () => { await expect(result.current.refresh.mutateAsync()).rejects.toThrow('429'); });
    await waitFor(() => expect(result.current.refresh.isError).toBe(true));
    expect(result.current.data?.advice?.advice.headline).toBe('Two channels are quiet');
  });

  it('refresh works even before the first read has produced anything (no advice yet)', async () => {
    adviceImpl = async (_id, refresh) => refresh ? payload() : payload(null);
    const { result } = renderHook(() => useSourcingAdvice('R5', true), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ enabled: true, advice: null }));
    await act(async () => { await result.current.refresh.mutateAsync(); });
    await waitFor(() => expect(result.current.data?.advice?.source).toBe('ai'));
  });

  it('advice is cached per role: another role asks again', async () => {
    adviceImpl = async () => payload();
    const a = renderHook(() => useSourcingAdvice('R5', true), { wrapper });
    await waitFor(() => expect(a.result.current.data).toBeDefined());
    renderHook(() => useSourcingAdvice('R6', true), { wrapper });
    await waitFor(() => expect(adviceCalls.map(c => c[0])).toEqual(['R5', 'R6']));
  });
});
