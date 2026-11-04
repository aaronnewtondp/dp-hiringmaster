import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// services/sourcingPlans.ts carries the plan view the Sourcing page renders, the Hiring Manager redaction (access control over
// sourcing data), the target rules and the validation of every plan/exception edit. The database is answered from canned rows:
// what is under test is the logic around the SQL (mapping, validation order, who sees what), never the SQL itself.
const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  transaction: vi.fn(),
  clientQuery: vi.fn(),
}));
vi.mock('../db/index.js', () => ({
  query: (...a: unknown[]) => h.query(...a),
  queryOne: (...a: unknown[]) => h.queryOne(...a),
  transaction: (fn: (c: unknown) => Promise<unknown>) => h.transaction(fn),
  pool: {},
}));

import {
  effectiveTarget, redactForHiringManager, HISTORY_LIMIT, SourcingError, validUrl, listPeople, logChange, logChangeQ,
  ensureDraftPlansForOpenRoles, getPlanView, updatePlan, resolveException, onRoleSaved, syncChannelWeeks, syncChannelWeeksSafe, type PlanView,
} from './sourcingPlans.js';
import { endOfIstDay } from '../utils/workingDays.js';
import { SMOKE_EMAIL_DOMAIN } from '../middleware/auth.js';
import { DEFAULT_SOURCING_SETTINGS, OPEN_ROLE_STATUSES } from '../utils/sourcingConfig.js';
import type { JwtPayload } from '../types/index.js';

const NOW = new Date('2026-10-14T06:00:00Z');                 // a Wednesday, 11:30 IST
const USER: JwtPayload = { userId: '11111111-1111-4111-8111-111111111111', email: 'hr@example.test', persona: 'hr_recruiter', name: 'Test HR' };

/** Canned answers for the transaction's client: [SQL fragment, rows] pairs checked in order; anything else answers no rows. */
type Script = Array<[string, unknown[] | ((sql: string, params: unknown[]) => unknown[])]>;
function useClient(script: Script = []) {
  h.clientQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    for (const [fragment, rows] of script) {
      if (sql.includes(fragment)) return { rows: typeof rows === 'function' ? rows(sql, params) : rows };
    }
    return { rows: [] };
  });
}
const writes = () => h.clientQuery.mock.calls.map(c => String(c[0])).filter(s => /^\s*(UPDATE|INSERT)/i.test(s));
const loggedChanges = () => h.clientQuery.mock.calls
  .filter(c => String(c[0]).includes('INSERT INTO sourcing_plan_changes'))
  .map(c => JSON.parse(String((c[1] as unknown[])[2])) as Record<string, unknown>);

beforeEach(() => {
  h.query.mockReset().mockResolvedValue([]);
  h.queryOne.mockReset().mockResolvedValue(null);
  h.clientQuery.mockReset();
  h.transaction.mockReset().mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn({ query: h.clientQuery }));
  useClient();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ─── effectiveTarget ─────────────────────────────────────────────────────────────────────────────────
describe('effectiveTarget (the "qualified in the last 7 days" target in force for a role)', () => {
  const settings = { volume_min_qualified: 5 };

  it.each([
    // roleTarget, priority, expected
    [null, 'P0', { min: 5, applicable: true, target_source: 'default', role_target: null, default_target: 5 }],
    [null, 'P1', { min: 5, applicable: true, target_source: 'default', role_target: null, default_target: 5 }],
    [null, 'P2', { min: 0, applicable: false, target_source: 'none', role_target: null, default_target: null }],
    [null, 'P3', { min: 0, applicable: false, target_source: 'none', role_target: null, default_target: null }],
    [12, 'P0', { min: 12, applicable: true, target_source: 'role', role_target: 12, default_target: 5 }],
    [12, 'P2', { min: 12, applicable: true, target_source: 'role', role_target: 12, default_target: null }],
    [1, 'P3', { min: 1, applicable: true, target_source: 'role', role_target: 1, default_target: null }],
  ] as const)('role target %s on a %s role', (roleTarget, priority, expected) => {
    expect(effectiveTarget(roleTarget, priority, settings)).toEqual(expected);
  });

  it('a role target of 0 is a target (?? not ||): it beats the default and is still "applicable"', () => {
    expect(effectiveTarget(0, 'P0', settings)).toEqual({ min: 0, applicable: true, target_source: 'role', role_target: 0, default_target: 5 });
  });

  it('the default follows the settings value, not a constant', () => {
    expect(effectiveTarget(null, 'P1', { volume_min_qualified: 9 }).min).toBe(9);
    expect(effectiveTarget(null, 'P1', { volume_min_qualified: 0 })).toMatchObject({ min: 0, applicable: true, target_source: 'default' });
  });

  it.each(['p0', 'P4', '', 'High', 'P0 '])('an unrecognised priority "%s" gets no default (only exactly P0 or P1 do)', priority => {
    expect(effectiveTarget(null, priority, settings)).toMatchObject({ applicable: false, target_source: 'none', default_target: null });
  });

  it('the shipped default setting is 5 qualified candidates for P0/P1', () => {
    expect(effectiveTarget(null, 'P0', DEFAULT_SOURCING_SETTINGS).min).toBe(5);
  });
});

describe('small constants and helpers', () => {
  it('a plan view carries at most 200 history entries', () => {
    expect(HISTORY_LIMIT).toBe(200);
  });

  it('SourcingError carries the HTTP status the route answers with', () => {
    const e = new SourcingError(409, 'Already resolved');
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(409);
    expect(e.message).toBe('Already resolved');
  });

  describe('validUrl (evidence and post links must be http(s))', () => {
    it.each([
      ['https://example.test/post/1', 'https://example.test/post/1'],
      ['http://example.test', 'http://example.test'],
      ['  https://example.test/a  ', 'https://example.test/a'],
      ['HTTPS://EXAMPLE.TEST/A', 'HTTPS://EXAMPLE.TEST/A'],
    ])('accepts %j (returned trimmed, as typed)', (input, expected) => {
      expect(validUrl(input)).toBe(expected);
    });

    it.each([
      ['ftp://example.test/file'],
      ['javascript:alert(1)'],
      ['data:text/html,<b>x</b>'],
      ['mailto:someone@example.test'],
      ['file:///etc/passwd'],
      ['example.test/no-scheme'],
      ['/relative/path'],
      ['not a url'],
      [''],
      ['   '],
      [null],
      [undefined],
      [42],
      [{}],
    ])('rejects %j', input => {
      expect(validUrl(input)).toBeNull();
    });

    it('rejects anything longer than 500 characters (after trimming), accepts exactly 500', () => {
      const base = 'https://example.test/';
      expect(validUrl(base + 'a'.repeat(500 - base.length))).not.toBeNull();
      expect(validUrl(base + 'a'.repeat(501 - base.length))).toBeNull();
      expect(validUrl(`   ${base}${'a'.repeat(500 - base.length)}   `)).not.toBeNull();
    });
  });

  it('listPeople excludes the smoke-test accounts by their reserved domain and only lists active users', async () => {
    h.query.mockResolvedValueOnce([{ id: '1', name: 'Test A', persona: 'hr_recruiter' }]);
    const people = await listPeople();
    expect(people).toEqual([{ id: '1', name: 'Test A', persona: 'hr_recruiter' }]);
    const [sql, params] = h.query.mock.calls[0];
    expect(sql).toContain('is_active = true');
    expect(sql).toContain("email NOT LIKE '%@' || $1");
    expect(params).toEqual([SMOKE_EMAIL_DOMAIN]);
  });

  describe('plan-history writers', () => {
    it('logChange writes the change as JSON with the acting user, reason and timestamp (null reason / null at when omitted)', async () => {
      await logChange({ query: h.clientQuery } as never, '501', USER.userId, { type: 'activated', n: 1 });
      const [sql, params] = h.clientQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO sourcing_plan_changes');
      expect(params).toEqual(['501', USER.userId, '{"type":"activated","n":1}', null, null]);
    });

    it('logChange passes an explicit reason and a system actor (null user) through', async () => {
      const at = new Date('2026-10-01T00:00:00Z');
      await logChange({ query: h.clientQuery } as never, '501', null, { type: 'paused' }, 'because', at);
      expect(h.clientQuery.mock.calls[0][1]).toEqual(['501', null, '{"type":"paused"}', 'because', at]);
    });

    it('logChangeQ writes the same row outside a transaction', async () => {
      await logChangeQ('501', null, { type: 'weekly_result' });
      const [sql, params] = h.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO sourcing_plan_changes');
      expect(params).toEqual(['501', null, '{"type":"weekly_result"}', null, null]);
    });
  });

  describe('ensureDraftPlansForOpenRoles', () => {
    it('seeds channels only for plans it just created, and returns how many it created', async () => {
      h.query.mockResolvedValueOnce([{ id: '7' }, { id: '8' }]).mockResolvedValueOnce([]);
      expect(await ensureDraftPlansForOpenRoles()).toBe(2);
      expect(h.query).toHaveBeenCalledTimes(2);
      expect(h.query.mock.calls[0][1]).toEqual([OPEN_ROLE_STATUSES, null]);
      expect(h.query.mock.calls[1][1]).toEqual([['7', '8'], ['LinkedIn', 'Naukri/IIMjobs', 'Agency', 'Internal Referral', 'Direct Outreach']]);
    });

    it('creates nothing and runs no channel insert when every open role already has a plan', async () => {
      h.query.mockResolvedValueOnce([]);
      expect(await ensureDraftPlansForOpenRoles()).toBe(0);
      expect(h.query).toHaveBeenCalledTimes(1);
    });

    it('can be limited to one role', async () => {
      h.query.mockResolvedValueOnce([]);
      await ensureDraftPlansForOpenRoles('R9001');
      expect(h.query.mock.calls[0][1]).toEqual([OPEN_ROLE_STATUSES, 'R9001']);
    });

    // The mock cannot run SQL, so the clauses that make the parameters mean something are pinned as text: only open roles, only one role when asked,
    // only roles without a plan, and channels only for the plans just created and only the known channels.
    it('its SQL really restricts to open roles, to the one role asked for, to roles without a plan, and seeds channels only for the plans just created', async () => {
      h.query.mockResolvedValueOnce([{ id: '7' }]).mockResolvedValueOnce([]);
      await ensureDraftPlansForOpenRoles('R9001');
      const plans = String(h.query.mock.calls[0][0]).replace(/\s+/g, ' ');
      expect(plans).toContain('r.status = ANY($1::text[])');
      expect(plans).toContain('($2::text IS NULL OR r.id = $2)');
      expect(plans).toContain('NOT EXISTS (SELECT 1 FROM sourcing_plans p WHERE p.role_id = r.id)');
      expect(plans).toContain('ON CONFLICT (role_id) DO NOTHING');
      const channels = String(h.query.mock.calls[1][0]).replace(/\s+/g, ' ');
      expect(channels).toContain('WHERE p.id = ANY($1::bigint[]) AND ch = ANY($2::text[])');
      expect(channels).toContain("'planned'");
    });
  });
});

// ─── redactForHiringManager ──────────────────────────────────────────────────────────────────────────
// Every field CLAUDE.md says is removed carries a unique "REDACTED_SENTINEL_*" string; every field it says is kept carries a
// "KEPT_*" string. The whole redacted view is then searched for the sentinels, so a new copy of a removed field would fail too.
const LEAK = (name: string) => `REDACTED_SENTINEL_${name}`;

function fullView(): PlanView {
  const commitment = (id: string): PlanView['channels'][number]['commitments'][number] => ({
    id, kind: 'activate_channel', title: `KEPT_commitment_title_${id}`, due_at: '2026-10-15T18:29:59.000Z', due_date: '2026-10-15', status: 'open',
    cadence_days: 30, last_done_at: '2026-10-10T05:00:00.000Z', meta: { lead_days: 3, baseline_until: '2026-11-01' }, overdue: false,
    evidence: { auto: 1, self: 2 },
    recent: [
      { done_at: '2026-10-10T05:00:00.000Z', was_due_at: '2026-10-11T18:29:59.000Z', on_time: true, note: LEAK(`completion_note_${id}`),
        evidence: [{ kind: 'url', ref: LEAK(`evidence_ref_${id}`), source: 'self' }, { kind: 'note', ref: LEAK(`evidence_note_${id}`), source: 'self' }] },
      { done_at: '2026-10-12T05:00:00.000Z', was_due_at: '2026-10-11T18:29:59.000Z', on_time: false, note: LEAK(`late_note_${id}`), evidence: [] },
    ],
  });
  const tracker = (link: string | null): PlanView['channels'][number]['tracker'] => ({
    applicable: true, target: 20, anchor: '2026-10-05', link,
    running: { start: '2026-10-12', end: '2026-10-18', actual: 4, qualified: 2, target: 20 },
    weeks: [{ week_start: '2026-10-05', week_end: '2026-10-11', target: 20, actual: 22, qualified: 9, met: true, partial: false }],
    totals: { weeks: 1, met: 1, actual: 22, target: 20 },
    sourced: { applications: 30, qualified: 12 },
  });
  const exception = (over: Partial<PlanView['exceptions'][number]>): PlanView['exceptions'][number] => ({
    id: '900', channel: 'LinkedIn', type: 'COMMITMENT_OVERDUE', status: 'open', severity: 30, is_shadow: false,
    detected_at: '2026-10-13T00:00:00.000Z', last_seen_at: '2026-10-14T00:00:00.000Z',
    evidence: { internal_note: LEAK('exception_evidence'), count: 1 },
    resolution_path: null, reason: LEAK('exception_reason'), corrective_action: LEAK('corrective_action'),
    snooze_until: null, blocker_due: null, blocker_owner_name: LEAK('blocker_owner'), resolved_at: null,
    committed: 'KEPT_committed_text', happened: 'KEPT_happened_text', next_action: 'KEPT_next_action_text', ...over,
  });
  return {
    plan: {
      id: '501', role_id: 'R9001', status: 'active', strategy_note: LEAK('strategy_note'), baseline: { weekly: LEAK('baseline') },
      baseline_at: '2026-10-01T00:00:00.000Z', activated_at: '2026-10-02T00:00:00.000Z', paused_at: '2026-10-03T00:00:00.000Z',
      pause_total_days: 3, closed_at: '2026-10-20T00:00:00.000Z', weekly_qualified_target: 6,
    },
    role: { id: 'R9001', title: 'Synthetic Role', priority: 'P1', status: 'Live – Sourcing', num_openings: 2, hiring_manager_name: 'Test Manager', recruitment_mode: ['LinkedIn', 'Agency'], approval_date: '2026-09-30' },
    channels: [
      { id: '11', channel: 'LinkedIn', state: 'active', excluded_reason: null, closed_at: null, closed_reason: LEAK('closed_reason_active'),
        config: { posting_url: LEAK('posting_url'), posted_at: LEAK('posted_at') }, targets: { weekly_target: 20 },
        tracker: tracker(LEAK('tracker_link')), commitments: [commitment('21'), commitment('22')] },
      { id: '12', channel: 'Agency', state: 'excluded', excluded_reason: 'KEPT_excluded_reason', closed_at: null, closed_reason: null,
        config: {}, targets: { agencies: 2 }, tracker: { ...tracker(null), applicable: false }, commitments: [] },
      { id: '13', channel: 'Direct Outreach', state: 'closed', excluded_reason: null, closed_at: '2026-10-09T00:00:00.000Z', closed_reason: LEAK('closed_reason_closed'),
        config: { posting_url: LEAK('closed_posting_url') }, targets: { weekly_target: 15 }, tracker: tracker(LEAK('closed_tracker_link')), commitments: [commitment('23')] },
    ],
    exceptions: [
      exception({ id: '900', status: 'open' }),
      exception({ id: '901', status: 'snoozed', resolution_path: 'catch_up', snooze_until: '2026-10-20' }),
      exception({ id: '902', status: 'blocked', resolution_path: 'blocker', blocker_due: '2026-11-05' }),
      exception({ id: '903', status: 'open', is_shadow: true, reason: LEAK('shadow_reason') }),
      exception({ id: '904', status: 'resolved', resolved_at: '2026-10-12T00:00:00.000Z', reason: LEAK('resolved_reason') }),
      exception({ id: '905', status: 'open', is_shadow: true, evidence: { x: LEAK('shadow_evidence') } }),
    ],
    changes: [
      { id: '1', at: '2026-10-02T00:00:00.000Z', by_name: LEAK('change_author'), change: { type: 'strategy_note_changed', note: LEAK('change_payload') }, reason: LEAK('change_reason'), text: LEAK('change_text'), category: 'plan' },
      { id: '2', at: '2026-10-03T00:00:00.000Z', by_name: null, change: { type: 'paused' }, reason: null, text: LEAK('change_text_2'), category: 'plan' },
    ],
    changes_total: 7,
    volume: { weekly_qualified: 3, shortlisted: 2, scored: 4, min: 6, rule: 'either', applicable: true, target_source: 'role', role_target: 6, default_target: 5 },
    output: [{ tag: 'LinkedIn', applications: 30, qualified: 12 }, { tag: '(untagged)', applications: 8, qualified: 1 }],
    attribution_reliable: { LinkedIn: true, 'Naukri/IIMjobs': false, Agency: false, 'Internal Referral': false, 'Direct Outreach': true },
    settings: { go_live_date: '2026-10-01', qualified_rule: 'either', shadow_until: '2026-11-12' },
  };
}

describe('redactForHiringManager (a Hiring Manager gets a partly redacted plan)', () => {
  it('no REDACTED_SENTINEL string survives anywhere in the redacted view', () => {
    const json = JSON.stringify(redactForHiringManager(fullView()));
    expect(json).not.toMatch(/REDACTED_SENTINEL/);
  });

  it('the fixture really does plant a sentinel in every field the guard is meant to catch (the check above can fail)', () => {
    const planted = JSON.stringify(fullView()).match(/REDACTED_SENTINEL_[A-Za-z_0-9]+/g) ?? [];
    expect(new Set(planted).size).toBeGreaterThanOrEqual(20);
    expect(JSON.stringify(redactForHiringManager(fullView()))).not.toMatch(/REDACTED_SENTINEL/);
  });

  describe.each([
    ['strategy note', (v: PlanView) => v.plan.strategy_note, null],
    ['baseline', (v: PlanView) => v.plan.baseline, null],
    ['change history entries', (v: PlanView) => v.changes, []],
    ['change history total (so the count does not hint at hidden entries)', (v: PlanView) => v.changes_total, 0],
    ['an active channel\'s config (posting URL)', (v: PlanView) => v.channels[0].config, {}],
    ['an active channel\'s closed_reason', (v: PlanView) => v.channels[0].closed_reason, null],
    ['an active channel\'s tracker link', (v: PlanView) => v.channels[0].tracker.link, null],
    ['a closed channel\'s config', (v: PlanView) => v.channels[2].config, {}],
    ['a closed channel\'s closed_reason', (v: PlanView) => v.channels[2].closed_reason, null],
    ['a closed channel\'s tracker link', (v: PlanView) => v.channels[2].tracker.link, null],
    ['the first completion note', (v: PlanView) => v.channels[0].commitments[0].recent[0].note, null],
    ['the first completion evidence', (v: PlanView) => v.channels[0].commitments[0].recent[0].evidence, []],
    ['a late completion note', (v: PlanView) => v.channels[0].commitments[0].recent[1].note, null],
    ['the second commitment\'s completion note', (v: PlanView) => v.channels[0].commitments[1].recent[0].note, null],
    ['a closed channel commitment\'s completion evidence', (v: PlanView) => v.channels[2].commitments[0].recent[0].evidence, []],
    ['an open exception\'s evidence', (v: PlanView) => v.exceptions.find(e => e.id === '900')!.evidence, {}],
    ['an open exception\'s reason', (v: PlanView) => v.exceptions.find(e => e.id === '900')!.reason, null],
    ['an open exception\'s corrective action', (v: PlanView) => v.exceptions.find(e => e.id === '900')!.corrective_action, null],
    ['an open exception\'s blocker owner name', (v: PlanView) => v.exceptions.find(e => e.id === '900')!.blocker_owner_name, null],
    ['a blocked exception\'s blocker owner name', (v: PlanView) => v.exceptions.find(e => e.id === '902')!.blocker_owner_name, null],
    ['a snoozed exception\'s reason', (v: PlanView) => v.exceptions.find(e => e.id === '901')!.reason, null],
  ])('%s is removed', (_label, pick, expected) => {
    it('and the original is not what the Hiring Manager gets', () => {
      const original = fullView();
      expect(pick(original)).not.toEqual(expected);          // the fixture has something there to remove
      expect(pick(redactForHiringManager(original))).toEqual(expected);
    });
  });

  it('provisional (is_shadow) and resolved exceptions are dropped entirely; open, snoozed and blocked ones stay', () => {
    const out = redactForHiringManager(fullView());
    expect(out.exceptions.map(e => e.id)).toEqual(['900', '901', '902']);
    expect(out.exceptions.map(e => e.status)).toEqual(['open', 'snoozed', 'blocked']);
    expect(out.exceptions.every(e => !e.is_shadow)).toBe(true);
  });

  it('an exception that is both provisional and already resolved is dropped too', () => {
    const v = fullView();
    v.exceptions.push({ ...v.exceptions[0], id: '906', is_shadow: true, status: 'resolved' });
    expect(redactForHiringManager(v).exceptions.map(e => e.id)).not.toContain('906');
  });

  describe('what is kept on purpose (documented in CLAUDE.md, Sourcing → Access)', () => {
    it("a channel's excluded_reason and the state, targets and tracker numbers stay", () => {
      const out = redactForHiringManager(fullView());
      expect(out.channels[1].excluded_reason).toBe('KEPT_excluded_reason');
      expect(out.channels.map(c => c.state)).toEqual(['active', 'excluded', 'closed']);
      expect(out.channels[0].targets).toEqual({ weekly_target: 20 });
      expect(out.channels[0].tracker).toMatchObject({
        applicable: true, target: 20, anchor: '2026-10-05', link: null,
        running: { actual: 4, qualified: 2, target: 20 },
        totals: { weeks: 1, met: 1, actual: 22, target: 20 },
        sourced: { applications: 30, qualified: 12 },
      });
      expect(out.channels[0].tracker.weeks).toHaveLength(1);
      expect(out.channels[2].closed_at).toBe('2026-10-09T00:00:00.000Z');
    });

    it("an exception's resolution_path, snooze_until, blocker_due and the plain-language text stay", () => {
      const out = redactForHiringManager(fullView());
      const snoozed = out.exceptions.find(e => e.id === '901')!;
      const blocked = out.exceptions.find(e => e.id === '902')!;
      expect(snoozed).toMatchObject({ resolution_path: 'catch_up', snooze_until: '2026-10-20' });
      expect(blocked).toMatchObject({ resolution_path: 'blocker', blocker_due: '2026-11-05' });
      for (const e of out.exceptions) {
        expect(e).toMatchObject({ committed: 'KEPT_committed_text', happened: 'KEPT_happened_text', next_action: 'KEPT_next_action_text' });
        expect(e).toMatchObject({ channel: 'LinkedIn', type: 'COMMITMENT_OVERDUE', severity: 30 });
      }
    });

    it('commitment titles, dates, status, meta, evidence COUNTS and each completion\'s done/was-due dates and on-time flag stay', () => {
      const c = redactForHiringManager(fullView()).channels[0].commitments[0];
      expect(c).toMatchObject({
        id: '21', kind: 'activate_channel', title: 'KEPT_commitment_title_21', due_date: '2026-10-15', status: 'open', cadence_days: 30, overdue: false,
        meta: { lead_days: 3, baseline_until: '2026-11-01' }, evidence: { auto: 1, self: 2 },
      });
      expect(c.recent.map(r => [r.done_at, r.was_due_at, r.on_time])).toEqual([
        ['2026-10-10T05:00:00.000Z', '2026-10-11T18:29:59.000Z', true],
        ['2026-10-12T05:00:00.000Z', '2026-10-11T18:29:59.000Z', false],
      ]);
    });

    it('the volume block, settings, per-source counts, attribution flags, the role and the plan timestamps stay', () => {
      const original = fullView();
      const out = redactForHiringManager(original);
      expect(out.volume).toEqual(original.volume);
      expect(out.settings).toEqual(original.settings);
      expect(out.output).toEqual(original.output);
      expect(out.attribution_reliable).toEqual(original.attribution_reliable);
      expect(out.role).toEqual(original.role);
      expect(out.plan).toMatchObject({
        id: '501', role_id: 'R9001', status: 'active', baseline_at: '2026-10-01T00:00:00.000Z', activated_at: '2026-10-02T00:00:00.000Z',
        paused_at: '2026-10-03T00:00:00.000Z', pause_total_days: 3, closed_at: '2026-10-20T00:00:00.000Z', weekly_qualified_target: 6,
      });
    });
  });

  it('does not mutate the view it is given (HR-tier callers share the same object)', () => {
    const v = fullView();
    const snapshot = structuredClone(v);
    redactForHiringManager(v);
    expect(v).toEqual(snapshot);
  });

  it('is idempotent: redacting an already redacted view changes nothing', () => {
    const once = redactForHiringManager(fullView());
    expect(redactForHiringManager(once)).toEqual(once);
  });

  it('handles a plan with no channels and no exceptions', () => {
    const v = { ...fullView(), channels: [], exceptions: [] };
    const out = redactForHiringManager(v);
    expect(out.channels).toEqual([]);
    expect(out.exceptions).toEqual([]);
    expect(out.plan.strategy_note).toBeNull();
  });
});

// ─── getPlanView: from database rows to the view, and through the redaction ─────────────────────────────
interface Rows {
  plan: Record<string, unknown> | null;
  role: Record<string, unknown> | null;
  settings: Array<{ key: string; value: unknown }>;
  channels: Array<Record<string, unknown>>;
  exceptions: Array<Record<string, unknown>>;
  changes: Array<Record<string, unknown>>;
  changesTotal: string;
  volumeApps: Array<Record<string, unknown>>;
  output: Array<Record<string, unknown>>;
  commitments: Array<Record<string, unknown>>;
  logs: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  evCounts: Array<Record<string, unknown>>;
  weeks: Array<Record<string, unknown>>;
  days: Array<Record<string, unknown>>;
}
const baseRows = (): Rows => ({
  plan: { id: '501', role_id: 'R9001', status: 'active', strategy_note: LEAK('db_strategy_note'), baseline: { w: LEAK('db_baseline') }, baseline_at: null,
          activated_at: '2026-10-02T00:00:00.000Z', paused_at: null, pause_total_days: 0, closed_at: null, weekly_qualified_target: null },
  role: { id: 'R9001', title: 'Synthetic Role', priority: 'P1', status: 'Live – Sourcing', num_openings: 1, hiring_manager_name: 'Test Manager', recruitment_mode: ['LinkedIn'], approval_date: '2026-09-30' },
  settings: [],
  channels: [], exceptions: [], changes: [], changesTotal: '0', volumeApps: [], output: [], commitments: [], logs: [], evidence: [], evCounts: [], weeks: [], days: [],
});

function serve(rows: Rows) {
  h.queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM sourcing_plans p WHERE p.role_id')) return rows.plan;
    if (sql.includes('FROM roles WHERE id')) return rows.role;
    if (sql.includes('count(*) AS n FROM sourcing_plan_changes')) return { n: rows.changesTotal };
    return null;
  });
  h.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM sourcing_settings')) return rows.settings;
    if (sql.includes('FROM sourcing_plan_channels ch JOIN sourcing_plans p')) return [];                // the weekly sync finds nothing to write
    if (sql.includes('FROM sourcing_plan_channels WHERE plan_id')) return rows.channels;
    if (sql.includes('FROM sourcing_exceptions e LEFT JOIN users')) return rows.exceptions;
    if (sql.includes('FROM sourcing_plan_changes c LEFT JOIN users')) return rows.changes;
    if (sql.includes('AS shortlisted_at')) return rows.volumeApps;
    if (sql.includes('GROUP BY 1 ORDER BY 2 DESC')) return rows.output;
    if (sql.includes('FROM sourcing_commitments WHERE plan_channel_id')) return rows.commitments;
    if (sql.includes('FROM sourcing_commitment_log l WHERE')) return rows.logs;
    if (sql.includes('FROM sourcing_evidence WHERE log_id')) return rows.evidence;
    if (sql.includes('JOIN sourcing_evidence e ON e.log_id')) return rows.evCounts;
    if (sql.includes('FROM sourcing_channel_weeks WHERE plan_channel_id')) return rows.weeks;
    if (sql.includes('a.sub_source = ANY')) return rows.days;
    return [];
  });
}

const channelRow = (over: Record<string, unknown>) => ({
  id: '11', channel: 'LinkedIn', state: 'active', excluded_reason: null, closed_at: null, closed_reason: null, tracker_anchor: null, config: {}, targets: {}, ...over,
});

describe('getPlanView', () => {
  it('answers null when the role has no plan, and null when the role row is gone', async () => {
    const rows = baseRows();
    rows.plan = null;
    serve(rows);
    expect(await getPlanView('R9001', NOW)).toBeNull();
    const rows2 = baseRows();
    rows2.role = null;
    serve(rows2);
    expect(await getPlanView('R9001', NOW)).toBeNull();
  });

  it('asks for exactly HISTORY_LIMIT history entries, newest first', async () => {
    serve(baseRows());
    await getPlanView('R9001', NOW);
    const historySql = h.query.mock.calls.map(c => String(c[0])).find(s => s.includes('FROM sourcing_plan_changes c LEFT JOIN users'))!;
    expect(historySql).toContain(`LIMIT ${HISTORY_LIMIT}`);
    expect(historySql).toContain('ORDER BY c.at DESC');
  });

  it('reports the total history count separately from the (capped) list', async () => {
    const rows = baseRows();
    rows.changesTotal = '450';
    rows.changes = [{ id: '9', at: '2026-10-13T00:00:00Z', by_name: 'Test HR', change: { type: 'activated' }, reason: null }];
    serve(rows);
    const v = (await getPlanView('R9001', NOW))!;
    expect(v.changes_total).toBe(450);
    expect(v.changes).toHaveLength(1);
    expect(v.changes[0]).toMatchObject({ id: '9', at: '2026-10-13T00:00:00.000Z', by_name: 'Test HR' });
    expect(typeof v.changes[0].text).toBe('string');
    expect(v.changes[0].text.length).toBeGreaterThan(0);
  });

  it('a channel that is excluded AND has a closed_at is reported as "closed" with no excluded_reason; one without closed_at stays "excluded" with its reason', async () => {
    const rows = baseRows();
    rows.channels = [
      channelRow({ id: '11', channel: 'LinkedIn', state: 'excluded', closed_at: '2026-10-09T00:00:00Z', closed_reason: 'Stopped', excluded_reason: 'ignored when closed' }),
      channelRow({ id: '12', channel: 'Agency', state: 'excluded', excluded_reason: 'Not needed' }),
      channelRow({ id: '13', channel: 'Internal Referral', state: 'planned' }),
      channelRow({ id: '14', channel: 'Direct Outreach', state: 'active' }),
    ];
    serve(rows);
    const v = (await getPlanView('R9001', NOW))!;
    expect(v.channels.map(c => [c.channel, c.state, c.excluded_reason, c.closed_reason])).toEqual([
      ['LinkedIn', 'closed', null, 'Stopped'],
      ['Agency', 'excluded', 'Not needed', null],
      ['Internal Referral', 'planned', null, null],
      ['Direct Outreach', 'active', null, null],
    ]);
    expect(v.channels[0].closed_at).toBe('2026-10-09T00:00:00.000Z');
    expect(v.channels[1].closed_at).toBeNull();
  });

  it('only LinkedIn, Naukri/IIMjobs and Direct Outreach have a weekly tracker', async () => {
    const rows = baseRows();
    rows.channels = ['LinkedIn', 'Naukri/IIMjobs', 'Direct Outreach', 'Agency', 'Internal Referral'].map((c, i) => channelRow({ id: String(i + 1), channel: c }));
    serve(rows);
    const v = (await getPlanView('R9001', NOW))!;
    expect(v.channels.map(c => [c.channel, c.tracker.applicable])).toEqual([
      ['LinkedIn', true], ['Naukri/IIMjobs', true], ['Direct Outreach', true], ['Agency', false], ['Internal Referral', false],
    ]);
  });

  it('a commitment is overdue only while it is open and its due time has passed', async () => {
    const rows = baseRows();
    rows.channels = [channelRow({})];
    const commitment = (id: string, status: string, due: string) => ({
      id, plan_channel_id: '11', kind: 'renew_posting', title: `T${id}`, due_at: due, status, cadence_days: null, last_done_at: null, meta: null,
    });
    rows.commitments = [
      commitment('1', 'open', '2026-10-14T05:59:59Z'),          // one second before NOW
      commitment('2', 'open', '2026-10-14T06:00:00Z'),          // exactly NOW: not yet overdue
      commitment('3', 'open', '2026-10-14T06:00:01Z'),
      commitment('4', 'done', '2026-10-01T00:00:00Z'),
      commitment('5', 'skipped', '2026-10-01T00:00:00Z'),
    ];
    serve(rows);
    const v = (await getPlanView('R9001', NOW))!;
    expect(v.channels[0].commitments.map(c => [c.id, c.overdue])).toEqual([['1', true], ['2', false], ['3', false], ['4', false], ['5', false]]);
    expect(v.channels[0].commitments[0].meta).toEqual({});          // a null meta column becomes {}
  });

  it('a completion is on time when done_at is at or before was_due_at, and evidence counts split auto from self', async () => {
    const rows = baseRows();
    rows.channels = [channelRow({})];
    rows.commitments = [{ id: '1', plan_channel_id: '11', kind: 'activate_channel', title: 'T', due_at: '2026-10-20T00:00:00Z', status: 'open', cadence_days: null, last_done_at: null, meta: {} }];
    rows.logs = [
      { id: '70', commitment_id: '1', done_at: '2026-10-10T00:00:00Z', was_due_at: '2026-10-10T00:00:00Z', note: 'exactly on time' },
      { id: '71', commitment_id: '1', done_at: '2026-10-09T00:00:01Z', was_due_at: '2026-10-09T00:00:00Z', note: 'one second late' },
    ];
    rows.evidence = [{ log_id: '70', kind: 'url', ref: 'https://example.test/a', source: 'self' }];
    rows.evCounts = [{ commitment_id: '1', source: 'self', n: '3' }, { commitment_id: '1', source: 'auto', n: '1' }];
    serve(rows);
    const c = (await getPlanView('R9001', NOW))!.channels[0].commitments[0];
    expect(c.recent.map(r => [r.note, r.on_time])).toEqual([['exactly on time', true], ['one second late', false]]);
    expect(c.recent[0].evidence).toEqual([{ kind: 'url', ref: 'https://example.test/a', source: 'self' }]);
    expect(c.recent[1].evidence).toEqual([]);
    expect(c.evidence).toEqual({ auto: 1, self: 3 });
  });

  it('a source counts as attributable from 5 tagged applications (4 is not enough); a channel with no rows is not', async () => {
    const rows = baseRows();
    rows.output = [
      { tag: 'LinkedIn', applications: '5', qualified: '2' },
      { tag: 'Naukri/IIMjobs', applications: '4', qualified: '4' },
      { tag: '(untagged)', applications: '50', qualified: '1' },
    ];
    serve(rows);
    const v = (await getPlanView('R9001', NOW))!;
    expect(v.attribution_reliable).toEqual({ 'LinkedIn': true, 'Naukri/IIMjobs': false, 'Agency': false, 'Internal Referral': false, 'Direct Outreach': false });
    expect(v.output).toEqual([
      { tag: 'LinkedIn', applications: 5, qualified: 2 }, { tag: 'Naukri/IIMjobs', applications: 4, qualified: 4 }, { tag: '(untagged)', applications: 50, qualified: 1 },
    ]);
  });

  it('volume counts qualified applications in the last 7 days and carries the target in force (role target over the default)', async () => {
    const rows = baseRows();
    rows.plan = { ...rows.plan!, weekly_qualified_target: 9 };
    rows.volumeApps = [
      { shortlisted_at: new Date('2026-10-13T00:00:00Z'), scored_at: null },                    // in window
      { shortlisted_at: null, scored_at: new Date('2026-10-07T06:00:00Z') },                    // exactly 7 days back: out (the window is open at the start)
      { shortlisted_at: null, scored_at: new Date('2026-10-07T06:00:01Z') },                    // just inside
      { shortlisted_at: new Date('2026-10-14T06:00:01Z'), scored_at: null },                    // in the future: out
    ];
    serve(rows);
    const v = (await getPlanView('R9001', NOW))!;
    expect(v.volume).toMatchObject({
      weekly_qualified: 2, shortlisted: 1, scored: 1, rule: 'either', min: 9, applicable: true, target_source: 'role', role_target: 9, default_target: 5,
    });
  });

  it('a P2 role with no role target has no applicable volume target', async () => {
    const rows = baseRows();
    rows.role = { ...rows.role!, priority: 'P2' };
    serve(rows);
    expect((await getPlanView('R9001', NOW))!.volume).toMatchObject({ min: 0, applicable: false, target_source: 'none', default_target: null });
  });

  it('exceptions carry the plain-language text built from their own evidence', async () => {
    const rows = baseRows();
    rows.exceptions = [{
      id: '900', channel: 'LinkedIn', type: 'COMMITMENT_OVERDUE', status: 'open', severity: 30, is_shadow: false, detected_at: '2026-10-13T00:00:00Z',
      last_seen_at: '2026-10-14T00:00:00Z', evidence: { count: 1, overdue: [{ title: 'Log the LinkedIn post', due: '2026-10-10', days_overdue: 3 }] },
      resolution_path: null, reason: null, corrective_action: null, snooze_until: null, blocker_due: null, blocker_owner_name: null, resolved_at: null,
    }];
    serve(rows);
    const e = (await getPlanView('R9001', NOW))!.exceptions[0];
    expect(e.committed).toContain('Log the LinkedIn post');
    expect(e.happened).toContain('3 days overdue');
    expect(e.next_action.length).toBeGreaterThan(0);
  });

  it('what the Hiring Manager gets from real rows contains none of the redacted data, whichever column it came from', async () => {
    const rows = baseRows();
    rows.channels = [channelRow({
      closed_reason: LEAK('db_closed_reason'), config: { posting_url: LEAK('db_posting_url') }, targets: { weekly_target: 20 }, tracker_anchor: '2026-10-05',
    })];
    rows.exceptions = [{
      id: '900', channel: 'LinkedIn', type: 'VOLUME_GAP', status: 'blocked', severity: 30, is_shadow: false, detected_at: '2026-10-13T00:00:00Z',
      last_seen_at: '2026-10-14T00:00:00Z', evidence: { weekly_qualified: 1, min: 5, note: LEAK('db_exception_evidence') },
      resolution_path: 'blocker', reason: LEAK('db_exception_reason'), corrective_action: LEAK('db_corrective'), snooze_until: null, blocker_due: '2026-11-01',
      blocker_owner_name: LEAK('db_blocker_owner'), resolved_at: null,
    }];
    rows.changes = [{ id: '9', at: '2026-10-13T00:00:00Z', by_name: LEAK('db_change_author'), change: { type: 'strategy_note_changed' }, reason: LEAK('db_change_reason') }];
    rows.commitments = [{ id: '1', plan_channel_id: '11', kind: 'activate_channel', title: 'Log the post', due_at: '2026-10-20T00:00:00Z', status: 'open', cadence_days: null, last_done_at: null, meta: {} }];
    rows.logs = [{ id: '70', commitment_id: '1', done_at: '2026-10-10T00:00:00Z', was_due_at: '2026-10-11T00:00:00Z', note: LEAK('db_completion_note') }];
    rows.evidence = [{ log_id: '70', kind: 'url', ref: LEAK('db_evidence_ref'), source: 'self' }];
    serve(rows);
    const hr = (await getPlanView('R9001', NOW))!;
    expect(JSON.stringify(hr)).toMatch(/REDACTED_SENTINEL/);         // HR-tier does see it: the check below is not vacuous
    const hm = redactForHiringManager(hr);
    expect(JSON.stringify(hm)).not.toMatch(/REDACTED_SENTINEL/);
    expect(hm.exceptions[0]).toMatchObject({ resolution_path: 'blocker', blocker_due: '2026-11-01' });
  });

  describe('the weekly tracker of a channel', () => {
    // NOW is 2026-10-14 in IST. A tracker anchored on 2026-10-05 has one finished week (5-11 Oct) and the week of 12-18 Oct in progress.
    const tracked = (over: Record<string, unknown> = {}) => channelRow({ state: 'active', tracker_anchor: '2026-10-05', targets: { weekly_target: 20 }, ...over });
    const dayRow = (channel: string, d: string, n: string, q: string) => ({ channel, d, n, q });
    const finishedWeek = { plan_channel_id: '11', week_start: '2026-10-05', week_end: '2026-10-11', target: 20, actual: 22, qualified: 9, partial: false };

    it('a live tracker counts the applications tagged with its channel from the day after the last finished week, and states the target', async () => {
      const rows = baseRows();
      rows.channels = [tracked()];
      rows.weeks = [finishedWeek];
      rows.days = [
        dayRow('LinkedIn', '2026-10-12', '3', '1'), dayRow('LinkedIn', '2026-10-13', '2', '2'),
        dayRow('LinkedIn', '2026-10-09', '9', '9'),            // in the finished week: not part of the running one
        dayRow('Agency', '2026-10-13', '7', '7'),              // another channel's tag
      ];
      serve(rows);
      const t = (await getPlanView('R9001', NOW))!.channels[0].tracker;
      expect(t.anchor).toBe('2026-10-12');                    // the day after the finished week, not the logged anchor
      expect(t.running).toEqual({ start: '2026-10-12', end: '2026-10-18', actual: 5, qualified: 3, target: 20 });
      expect(t.weeks).toEqual([{ week_start: '2026-10-05', week_end: '2026-10-11', target: 20, actual: 22, qualified: 9, met: true, partial: false }]);
      expect(t.totals).toEqual({ weeks: 1, met: 1, actual: 22, target: 20 });
    });

    it('a week that fell short is not met (the target is "at least")', async () => {
      const rows = baseRows();
      rows.channels = [tracked()];
      rows.weeks = [{ ...finishedWeek, actual: 19 }, { ...finishedWeek, week_start: '2026-09-28', week_end: '2026-10-04', actual: 20 }];
      serve(rows);
      expect((await getPlanView('R9001', NOW))!.channels[0].tracker.weeks.map(w => [w.week_start, w.met])).toEqual([['2026-10-05', false], ['2026-09-28', true]]);
    });

    it('a channel with no weekly target shows no running week even when it has an anchor', async () => {
      const rows = baseRows();
      rows.channels = [tracked({ targets: {} })];
      serve(rows);
      const t = (await getPlanView('R9001', NOW))!.channels[0].tracker;
      expect(t.target).toBeNull();
      expect(t.running).toBeNull();
    });

    it('a tracker runs only while its plan is active: on a paused plan there is no anchor, no running week and no day-count query', async () => {
      const rows = baseRows();
      rows.plan = { ...rows.plan!, status: 'paused' };
      rows.channels = [tracked()];
      serve(rows);
      const t = (await getPlanView('R9001', NOW))!.channels[0].tracker;
      expect(t.anchor).toBeNull();
      expect(t.running).toBeNull();
      expect(t.target).toBe(20);
      expect(h.query.mock.calls.some(c => String(c[0]).includes('a.sub_source = ANY'))).toBe(false);
    });

    it('a channel that is not active has no running week either', async () => {
      const rows = baseRows();
      rows.channels = [tracked({ state: 'planned' })];
      serve(rows);
      expect((await getPlanView('R9001', NOW))!.channels[0].tracker.running).toBeNull();
    });

    it.each([
      ['a string', 'https://example.test/post', 'https://example.test/post'],
      ['a number', 12345, null],
      ['an object', { href: 'https://example.test/x' }, null],
      ['null', null, null],
    ])('the post link is the config posting_url only when it is a string (%s)', async (_label, value, expected) => {
      const rows = baseRows();
      rows.channels = [channelRow({ config: { posting_url: value } })];
      serve(rows);
      expect((await getPlanView('R9001', NOW))!.channels[0].tracker.link).toBe(expected);
    });
  });

  it('the volume block follows the settings: the window length and the qualified rule', async () => {
    const rows = baseRows();
    rows.volumeApps = [
      { shortlisted_at: new Date('2026-10-04T00:00:00Z'), scored_at: null },                    // 10 days back, shortlisted only
      { shortlisted_at: null, scored_at: new Date('2026-10-13T00:00:00Z') },                    // yesterday, scored only
    ];
    serve(rows);
    expect((await getPlanView('R9001', NOW))!.volume).toMatchObject({ weekly_qualified: 1, shortlisted: 0, scored: 1 });
    rows.settings = [{ key: 'volume_window_days', value: 14 }];
    serve(rows);
    expect((await getPlanView('R9001', NOW))!.volume).toMatchObject({ weekly_qualified: 2, shortlisted: 1, scored: 1 });
    rows.settings = [{ key: 'volume_window_days', value: 14 }, { key: 'qualified_rule', value: 'shortlisted' }];
    serve(rows);
    expect((await getPlanView('R9001', NOW))!.volume).toMatchObject({ weekly_qualified: 1, rule: 'shortlisted' });
  });

  it('finishes any tracker week that has ended BEFORE it reads the plan\'s channels (the weekly sync runs first)', async () => {
    serve(baseRows());
    await getPlanView('R9001', NOW);
    const sqls = h.query.mock.calls.map(c => String(c[0]));
    const sync = sqls.findIndex(s => s.includes('FROM sourcing_plan_channels ch JOIN sourcing_plans p'));
    const channels = sqls.findIndex(s => s.includes('FROM sourcing_plan_channels WHERE plan_id'));
    expect(sync).toBeGreaterThanOrEqual(0);
    expect(sync).toBeLessThan(channels);
  });
});

// ─── syncChannelWeeks: one immutable row per finished 7-day window ───────────────────────────────────
describe('syncChannelWeeks (writes the weeks that have ended, once each)', () => {
  type SyncRow = { channel_id: string; plan_id: string; role_id: string; channel: string; anchor: string; target_raw: string | null; last_end: string | null };
  const syncRow = (over: Partial<SyncRow> = {}): SyncRow => ({ channel_id: '11', plan_id: '501', role_id: 'R9001', channel: 'LinkedIn', anchor: '2026-10-05', target_raw: '20', last_end: null, ...over });
  let channels: SyncRow[];
  let days: Array<{ d: string; n: string; q: string }>;
  let insertAnswer: (params: unknown[]) => Array<{ id: string }>;
  const callsTo = (fragment: string) => h.query.mock.calls.filter(c => String(c[0]).includes(fragment));

  beforeEach(() => {
    channels = [];
    days = [];
    insertAnswer = () => [{ id: '900' }];
    h.query.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM sourcing_plan_channels ch JOIN sourcing_plans p')) return channels;
      if (sql.includes('FROM applications a')) return days;
      if (sql.includes('INSERT INTO sourcing_channel_weeks')) return insertAnswer(params);
      return [];
    });
  });

  it('only looks at live channels of ACTIVE plans that have a tracker anchor, and can be limited to one plan', async () => {
    await syncChannelWeeks('501', NOW);
    const sql = String(h.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain("WHERE p.status = 'active' AND ch.state = 'active' AND ch.tracker_anchor IS NOT NULL AND ($1::bigint IS NULL OR p.id = $1::bigint)");
    expect(h.query.mock.calls[0][1]).toEqual(['501']);
    h.query.mockClear();
    await syncChannelWeeks(null, NOW);
    expect(h.query.mock.calls[0][1]).toEqual([null]);
  });

  it('writes one row for a finished week with its target and the day counts inside it, and logs a weekly_result stamped with the end of that IST day', async () => {
    channels = [syncRow()];
    days = [{ d: '2026-10-06', n: '4', q: '2' }, { d: '2026-10-09', n: '3', q: '1' }, { d: '2026-10-12', n: '50', q: '50' }];   // the last day is in the week still running
    expect(await syncChannelWeeks(null, NOW)).toBe(1);
    expect(callsTo('INSERT INTO sourcing_channel_weeks')).toHaveLength(1);
    expect(callsTo('INSERT INTO sourcing_channel_weeks')[0][1]).toEqual(['11', '2026-10-05', '2026-10-11', 20, 7, 3]);
    const log = callsTo('INSERT INTO sourcing_plan_changes');
    expect(log).toHaveLength(1);
    const [planId, by, json, reason, at] = log[0][1] as [string, unknown, string, unknown, Date];
    expect([planId, by, reason]).toEqual(['501', null, null]);
    expect(JSON.parse(json)).toEqual({ type: 'weekly_result', channel: 'LinkedIn', week_start: '2026-10-05', week_end: '2026-10-11', target: 20, actual: 7, qualified: 3, met: false, partial: false });
    expect(at.toISOString()).toBe(endOfIstDay('2026-10-11').toISOString());
  });

  it('a week that reached the target is logged as met (at least the target, not more than it)', async () => {
    channels = [syncRow({ target_raw: '7' })];
    days = [{ d: '2026-10-06', n: '4', q: '2' }, { d: '2026-10-09', n: '3', q: '1' }];
    await syncChannelWeeks(null, NOW);
    expect(JSON.parse((callsTo('INSERT INTO sourcing_plan_changes')[0][1] as string[])[2])).toMatchObject({ actual: 7, target: 7, met: true });
  });

  it('every finished week is written, with ONE day-count query spanning the first to the last of them', async () => {
    channels = [syncRow({ anchor: '2026-09-21' })];                                   // 21-27 Sep, 28 Sep - 4 Oct, 5-11 Oct
    expect(await syncChannelWeeks(null, NOW)).toBe(3);
    expect(callsTo('INSERT INTO sourcing_channel_weeks').map(c => (c[1] as unknown[]).slice(1, 3))).toEqual([
      ['2026-09-21', '2026-09-27'], ['2026-09-28', '2026-10-04'], ['2026-10-05', '2026-10-11'],
    ]);
    const dayQueries = callsTo('FROM applications a');
    expect(dayQueries).toHaveLength(1);
    expect(dayQueries[0][1]).toEqual(['R9001', 'LinkedIn', '2026-09-21', '2026-10-11']);
  });

  it('starts the day after the last week already written (a channel closed and reopened never overlaps its earlier weeks)', async () => {
    channels = [syncRow({ anchor: '2026-09-21', last_end: '2026-10-04' })];
    expect(await syncChannelWeeks(null, NOW)).toBe(1);
    expect((callsTo('INSERT INTO sourcing_channel_weeks')[0][1] as unknown[]).slice(0, 3)).toEqual(['11', '2026-10-05', '2026-10-11']);
  });

  it('a week that is still running (today inside it) writes nothing and asks nothing more', async () => {
    channels = [syncRow({ anchor: '2026-10-12' })];
    expect(await syncChannelWeeks(null, NOW)).toBe(0);
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('a week ends at the end of its last day: on the day after, it is written; on that last day itself, it is not', async () => {
    channels = [syncRow({ anchor: '2026-10-05' })];
    expect(await syncChannelWeeks(null, new Date('2026-10-11T12:00:00Z'))).toBe(0);              // 17:30 IST on 11 Oct
    expect(await syncChannelWeeks(null, new Date('2026-10-11T18:29:59Z'))).toBe(0);              // 23:59:59 IST on 11 Oct
    expect(await syncChannelWeeks(null, new Date('2026-10-11T18:30:00Z'))).toBe(1);              // 00:00 IST on 12 Oct
  });

  it.each([['abc'], ['5.5'], ['99999999999'], ['0'], ['-3'], [''], [null]])('a malformed or empty weekly target (%j) skips that channel: nothing is written', async raw => {
    channels = [syncRow({ target_raw: raw })];
    expect(await syncChannelWeeks(null, NOW)).toBe(0);
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('one channel with a malformed target does not stop the others', async () => {
    channels = [syncRow({ channel_id: '11', target_raw: 'abc' }), syncRow({ channel_id: '12', channel: 'Direct Outreach', target_raw: '10' })];
    expect(await syncChannelWeeks(null, NOW)).toBe(1);
    expect(callsTo('INSERT INTO sourcing_channel_weeks')).toHaveLength(1);
    expect((callsTo('INSERT INTO sourcing_channel_weeks')[0][1] as unknown[])[0]).toBe('12');
  });

  it('a week that is already recorded (the insert returns no row) is not counted and not logged again', async () => {
    channels = [syncRow()];
    insertAnswer = () => [];
    expect(await syncChannelWeeks(null, NOW)).toBe(0);
    expect(callsTo('INSERT INTO sourcing_channel_weeks')).toHaveLength(1);
    expect(callsTo('INSERT INTO sourcing_plan_changes')).toHaveLength(0);
  });

  it('writes the week with partial = false (only a stop writes a cut-short week)', async () => {
    channels = [syncRow()];
    await syncChannelWeeks(null, NOW);
    expect(String(callsTo('INSERT INTO sourcing_channel_weeks')[0][0])).toContain(', false)');
    expect(String(callsTo('INSERT INTO sourcing_channel_weeks')[0][0])).toContain('ON CONFLICT (plan_channel_id, week_start) DO NOTHING');
  });

  describe('syncChannelWeeksSafe', () => {
    it('returns what the sync returned', async () => {
      channels = [syncRow()];
      expect(await syncChannelWeeksSafe(null, NOW)).toBe(1);
    });

    it('never throws: a failing query is logged and the answer is 0', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      h.query.mockRejectedValue(new Error('connection reset'));
      await expect(syncChannelWeeksSafe('501', NOW)).resolves.toBe(0);
      expect(err).toHaveBeenCalled();
    });
  });
});

// ─── updatePlan ──────────────────────────────────────────────────────────────────────────────────────
describe('updatePlan (strategy note and the role\'s weekly qualified target)', () => {
  const plan = (over: Record<string, unknown> = {}) => [['FROM sourcing_plans WHERE id', [{ id: '501', strategy_note: null, weekly_qualified_target: null, ...over }]]] as Script;

  it.each([
    ['0', 0], ['-1', -1], ['501', 501], ['1000', 1000], ['0.4', 0.4], ['NaN', NaN], ['Infinity', Infinity], ['a string', '5' as unknown as number],
  ])('a target of %s is a 400 and nothing is written', async (_label, value) => {
    useClient(plan());
    await expect(updatePlan('501', { weekly_qualified_target: value as number }, USER)).rejects.toMatchObject({ status: 400 });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it.each([[1, 1], [500, 500], [2.4, 2], [7.5, 8]])('a target of %s is accepted and stored as %s', async (input, stored) => {
    useClient(plan());
    await updatePlan('501', { weekly_qualified_target: input }, USER);
    const update = h.clientQuery.mock.calls.find(c => String(c[0]).includes('SET weekly_qualified_target'))!;
    expect(update[1]).toEqual(['501', stored]);
    expect(loggedChanges()).toEqual([{ type: 'qualified_target_changed', from: null, to: stored }]);
  });

  it('a null target returns the role to the default and is logged as a change from the old value', async () => {
    useClient(plan({ weekly_qualified_target: 8 }));
    await updatePlan('501', { weekly_qualified_target: null }, USER);
    expect(h.clientQuery.mock.calls.find(c => String(c[0]).includes('SET weekly_qualified_target'))![1]).toEqual(['501', null]);
    expect(loggedChanges()).toEqual([{ type: 'qualified_target_changed', from: 8, to: null }]);
  });

  it('setting a target to the value it already has writes and logs nothing', async () => {
    useClient(plan({ weekly_qualified_target: 8 }));
    await updatePlan('501', { weekly_qualified_target: 8 }, USER);
    expect(writes()).toEqual([]);
  });

  it('an absent field leaves the target alone (undefined is not null)', async () => {
    useClient(plan({ weekly_qualified_target: 8 }));
    await updatePlan('501', { strategy_note: 'A note' }, USER);
    expect(writes().some(s => s.includes('weekly_qualified_target'))).toBe(false);
  });

  it('answers 404 for a plan that does not exist', async () => {
    useClient([]);
    await expect(updatePlan('999', { strategy_note: 'x' }, USER)).rejects.toMatchObject({ status: 404, message: 'Plan not found' });
  });

  it('the strategy note is trimmed, cut at 2,000 characters, and an empty one is stored as null', async () => {
    useClient(plan());
    await updatePlan('501', { strategy_note: `  ${'x'.repeat(2500)}  ` }, USER);
    const update = h.clientQuery.mock.calls.find(c => String(c[0]).includes('SET strategy_note'))!;
    expect((update[1] as string[])[1]).toHaveLength(2000);

    h.clientQuery.mockClear();
    useClient(plan({ strategy_note: 'Old note' }));
    await updatePlan('501', { strategy_note: '   ' }, USER);
    expect(h.clientQuery.mock.calls.find(c => String(c[0]).includes('SET strategy_note'))![1]).toEqual(['501', null]);
  });

  it('a changed note is logged WITHOUT its text (the history is visible to HR only, and carries no free text from the note)', async () => {
    useClient(plan({ strategy_note: 'Old note' }));
    await updatePlan('501', { strategy_note: LEAK('new_note') }, USER);
    expect(loggedChanges()).toEqual([{ type: 'strategy_note_changed' }]);
    expect(JSON.stringify(h.clientQuery.mock.calls.filter(c => String(c[0]).includes('sourcing_plan_changes')))).not.toContain('REDACTED_SENTINEL');
  });

  it('re-saving an identical note (even with different surrounding whitespace) writes nothing', async () => {
    useClient(plan({ strategy_note: 'Same note' }));
    await updatePlan('501', { strategy_note: '  Same note ' }, USER);
    expect(writes()).toEqual([]);
  });

  it('clearing a note that is already empty writes nothing', async () => {
    useClient(plan({ strategy_note: null }));
    await updatePlan('501', { strategy_note: '' }, USER);
    expect(writes()).toEqual([]);
  });
});

// ─── resolveException ────────────────────────────────────────────────────────────────────────────────
describe('resolveException (catch up / blocker / change strategy)', () => {
  const TODAY = '2026-10-14';                       // IST date of NOW
  const exceptionRow = (over: Record<string, unknown> = {}) => ({ id: '900', plan_id: '501', channel: 'LinkedIn', type: 'COMMITMENT_OVERDUE', status: 'open', is_shadow: false, ...over });
  const withException = (over: Record<string, unknown> = {}, extra: Script = []) => useClient([
    ['FROM sourcing_exceptions WHERE id', [{ plan_id: '501' }]],
    ['FROM sourcing_exceptions e WHERE e.id', [exceptionRow(over)]],
    ...extra,
  ]);

  describe('input checks that run before the database is touched', () => {
    it.each([[''], ['  '], ['ab'], ['  a  ']])('a reason of %j (under 3 characters once trimmed) is a 400', async reason => {
      await expect(resolveException('900', { path: 'catch_up', reason }, USER, NOW)).rejects.toMatchObject({ status: 400, message: 'A short reason is required' });
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('a blocker owner that is not a UUID is a 400', async () => {
      await expect(resolveException('900', { path: 'blocker', reason: 'waiting', blocker_owner_user_id: 'not-a-uuid' }, USER, NOW)).rejects.toMatchObject({ status: 400, message: 'Invalid blocker owner' });
      expect(h.transaction).not.toHaveBeenCalled();
    });
  });

  describe('what the exception itself must be', () => {
    it('404 when it does not exist', async () => {
      useClient([]);
      await expect(resolveException('900', { path: 'catch_up', reason: 'later', snooze_until: '2026-10-15' }, USER, NOW)).rejects.toMatchObject({ status: 404 });
    });
    it('409 when it is already resolved', async () => {
      withException({ status: 'resolved' });
      await expect(resolveException('900', { path: 'catch_up', reason: 'later', snooze_until: '2026-10-15' }, USER, NOW)).rejects.toMatchObject({ status: 409, message: 'Already resolved' });
    });
    it('409 when it is only a provisional (shadow) signal', async () => {
      withException({ is_shadow: true });
      await expect(resolveException('900', { path: 'catch_up', reason: 'later', snooze_until: '2026-10-15' }, USER, NOW)).rejects.toMatchObject({ status: 409 });
    });
    it('400 for an unknown resolution path, and nothing is written', async () => {
      withException();
      await expect(resolveException('900', { path: 'ignore' as never, reason: 'whatever' }, USER, NOW)).rejects.toMatchObject({ status: 400, message: 'Unknown resolution path' });
      expect(writes()).toEqual([]);
    });
    it('takes the plan lock before it reads the exception (lock order: plan, then channel, then the row)', async () => {
      withException();
      await resolveException('900', { path: 'catch_up', reason: 'later', snooze_until: '2026-10-15' }, USER, NOW);
      const sqls = h.clientQuery.mock.calls.map(c => String(c[0]));
      const lock = sqls.findIndex(s => s.includes('FROM sourcing_plans WHERE id = $1::bigint FOR UPDATE'));
      const read = sqls.findIndex(s => s.includes('FROM sourcing_exceptions e WHERE e.id'));
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(lock).toBeLessThan(read);
    });
  });

  describe('catch_up: a date from tomorrow to 14 days out', () => {
    it.each([
      ['tomorrow', '2026-10-15', true],
      ['the 14th calendar day', '2026-10-28', true],
      ['today', TODAY, false],
      ['yesterday', '2026-10-13', false],
      ['15 days out', '2026-10-29', false],
      ['a malformed date', '2026-10-1', false],
      ['a datetime', '2026-10-15T00:00:00Z', false],
      ['a blank date', '', false],
      ['no date', null, false],
    ])('%s (%s) is %s', async (_label, date, ok) => {
      withException();
      const p = resolveException('900', { path: 'catch_up', reason: 'catching up', snooze_until: date }, USER, NOW);
      if (ok) {
        await expect(p).resolves.toBeUndefined();
        const update = h.clientQuery.mock.calls.find(c => String(c[0]).includes("status = 'snoozed'"))!;
        expect(update[1]).toEqual(['900', 'catching up', null, date, USER.userId]);
        expect(loggedChanges()).toEqual([{ type: 'exception_snoozed', exception_type: 'COMMITMENT_OVERDUE', channel: 'LinkedIn', until: date }]);
      } else {
        await expect(p).rejects.toMatchObject({ status: 400, message: 'Pick a catch-up date within the next 14 days' });
        expect(writes()).toEqual([]);
      }
    });

    it('the reason is trimmed and cut at 500 characters, and the corrective action is stored as given', async () => {
      withException();
      await resolveException('900', { path: 'catch_up', reason: `  ${'r'.repeat(600)}  `, corrective_action: 'Call the agency', snooze_until: '2026-10-15' }, USER, NOW);
      const update = h.clientQuery.mock.calls.find(c => String(c[0]).includes("status = 'snoozed'"))![1] as string[];
      expect(update[1]).toHaveLength(500);
      expect(update[2]).toBe('Call the agency');
    });
  });

  describe('blocker: a deadline from today to 60 days out, owned by an active user', () => {
    const OWNER = '22222222-2222-4222-8222-222222222222';
    it.each([
      ['today', TODAY, true],
      ['60 days out', '2026-12-13', true],
      ['61 days out', '2026-12-14', false],
      ['yesterday', '2026-10-13', false],
      ['malformed', '14-10-2026', false],
      ['missing', null, false],
    ])('a deadline of %s (%s) is %s', async (_label, due, ok) => {
      withException({}, [['FROM users WHERE id', [{ id: OWNER, name: 'Test Owner' }]]]);
      const p = resolveException('900', { path: 'blocker', reason: 'waiting on finance', blocker_due: due, blocker_owner_user_id: OWNER }, USER, NOW);
      if (ok) {
        await expect(p).resolves.toBeUndefined();
        const update = h.clientQuery.mock.calls.find(c => String(c[0]).includes("status = 'blocked'"))![1] as unknown[];
        expect(update).toEqual(['900', 'waiting on finance', null, due, OWNER, USER.userId]);
        expect(loggedChanges()).toEqual([{ type: 'exception_blocked', exception_type: 'COMMITMENT_OVERDUE', channel: 'LinkedIn', owner: 'Test Owner', due }]);
      } else {
        await expect(p).rejects.toMatchObject({ status: 400, message: 'A blocker needs a deadline within the next 60 days' });
      }
    });

    it('with no owner named, the person resolving it owns the blocker', async () => {
      withException({}, [['FROM users WHERE id', (_s, params) => [{ id: params[0], name: 'Test HR' }]]]);
      await resolveException('900', { path: 'blocker', reason: 'waiting', blocker_due: '2026-10-20' }, USER, NOW);
      const update = h.clientQuery.mock.calls.find(c => String(c[0]).includes("status = 'blocked'"))![1] as unknown[];
      expect(update[4]).toBe(USER.userId);
    });

    it('an owner who is not an active user is a 400 and nothing is written', async () => {
      withException({}, [['FROM users WHERE id', []]]);
      await expect(resolveException('900', { path: 'blocker', reason: 'waiting', blocker_due: '2026-10-20', blocker_owner_user_id: OWNER }, USER, NOW))
        .rejects.toMatchObject({ status: 400, message: 'The blocker owner must be an active user' });
      expect(writes()).toEqual([]);
    });

    it('the owner lookup itself asks for an ACTIVE user with that id (the canned answer above cannot check it)', async () => {
      withException({}, [['FROM users WHERE id', [{ id: OWNER, name: 'Test Owner' }]]]);
      await resolveException('900', { path: 'blocker', reason: 'waiting', blocker_due: '2026-10-20', blocker_owner_user_id: OWNER }, USER, NOW);
      const lookup = h.clientQuery.mock.calls.find(c => String(c[0]).includes('FROM users WHERE id'))!;
      expect(String(lookup[0])).toContain('is_active = true');
      expect(lookup[1]).toEqual([OWNER]);
    });
  });

  describe('change_strategy', () => {
    it('resolves the exception and logs a strategy change that says whether the channel was excluded', async () => {
      withException();
      await resolveException('900', { path: 'change_strategy', reason: 'new plan' }, USER, NOW);
      expect(writes().some(s => s.includes("status = 'resolved'"))).toBe(true);
      expect(loggedChanges()).toEqual([{ type: 'strategy_changed', exception: 'COMMITMENT_OVERDUE', channel: 'LinkedIn', excluded: false }]);
    });

    it('stopping the channel on an exception that is not tied to a channel ("*") is a 400', async () => {
      withException({ channel: '*' });
      await expect(resolveException('900', { path: 'change_strategy', reason: 'stop', exclude_channel: true }, USER, NOW)).rejects.toMatchObject({ status: 400, message: 'This exception is not tied to a channel' });
    });

    it('stopping a channel that is already closed leaves it as it is (no second close) but still resolves the exception', async () => {
      withException({}, [['FROM sourcing_plan_channels WHERE plan_id', [{ id: '11', state: 'excluded', closed_at: '2026-10-01T00:00:00Z' }]]]);
      await resolveException('900', { path: 'change_strategy', reason: 'stop', exclude_channel: true }, USER, NOW);
      expect(writes().some(s => s.includes("SET state = 'excluded'"))).toBe(false);
      expect(writes().some(s => s.includes("status = 'resolved'"))).toBe(true);
      expect(loggedChanges()).toEqual([{ type: 'strategy_changed', exception: 'COMMITMENT_OVERDUE', channel: 'LinkedIn', excluded: true }]);
    });

    it('stopping a live channel closes it with the reason, skips its open commitments, and logs the close', async () => {
      withException({}, [
        ['FROM sourcing_plan_channels WHERE plan_id', [{ id: '11', state: 'active', closed_at: null }]],
        ['SELECT role_id FROM sourcing_plans', [{ role_id: 'R9001' }]],
        ['FROM sourcing_channel_weeks WHERE plan_channel_id', [{ weeks: '3', met: '2', applicants: '41' }]],
      ]);
      await resolveException('900', { path: 'change_strategy', reason: 'not working', exclude_channel: true }, USER, NOW);
      const close = h.clientQuery.mock.calls.find(c => String(c[0]).includes("SET state = 'excluded', excluded_reason = NULL, closed_at = NOW()"))!;
      expect(close[1]).toEqual(['11', 'not working', USER.userId]);
      expect(writes().some(s => s.includes("UPDATE sourcing_commitments SET status = 'skipped'"))).toBe(true);
      expect(loggedChanges()).toContainEqual({ type: 'channel_closed', channel: 'LinkedIn', weeks: 3, weeks_met: 2, applicants: 41 });
    });
  });
});

// ─── onRoleSaved (the hook that must never fail a role save) ─────────────────────────────────────────
describe('onRoleSaved', () => {
  const role = (status: string, mode: string[] | null = ['LinkedIn']) => ({ id: 'R9001', status, recruitment_mode: mode });

  it('does nothing at all, not even a query, while SOURCING_ENABLED is not "true"', async () => {
    vi.stubEnv('SOURCING_ENABLED', 'false');
    await onRoleSaved(role('Draft'), role('Approved'), USER.userId);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.queryOne).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it.each(['', 'TRUE', '1', 'yes', ' true'])('SOURCING_ENABLED=%j does not switch the hook on (only the exact string "true" does)', async value => {
    vi.stubEnv('SOURCING_ENABLED', value);
    await onRoleSaved(role('Draft'), role('Approved'), USER.userId);
    expect(h.queryOne).not.toHaveBeenCalled();
  });

  describe('with the module on', () => {
    beforeEach(() => { vi.stubEnv('SOURCING_ENABLED', 'true'); });

    it('never throws: a failing query is logged and swallowed', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      h.queryOne.mockRejectedValueOnce(new Error('relation "sourcing_plans" does not exist'));
      await expect(onRoleSaved(role('Draft'), role('Approved'), USER.userId)).resolves.toBeUndefined();
      expect(err).toHaveBeenCalled();
    });

    it('an open role with no plan gets a draft plan seeded for that role', async () => {
      h.queryOne.mockResolvedValueOnce(null);
      h.query.mockResolvedValue([]);
      await onRoleSaved(role('Draft'), role('Approved'), USER.userId);
      const insert = h.query.mock.calls.find(c => String(c[0]).includes('INSERT INTO sourcing_plans'))!;
      expect(insert[1]).toEqual([OPEN_ROLE_STATUSES, 'R9001']);
    });

    it('a role whose plan already matches its status costs one read and no writes', async () => {
      h.queryOne.mockResolvedValueOnce({ status: 'active' });
      await onRoleSaved(role('Approved'), role('Live – Sourcing'), USER.userId);
      expect(h.queryOne).toHaveBeenCalledTimes(1);
      expect(h.query).not.toHaveBeenCalled();
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('reads the plan status by the role id of the NEW snapshot', async () => {
      h.queryOne.mockResolvedValueOnce({ status: 'active' });
      await onRoleSaved({ ...role('Approved'), id: 'R0001' }, { ...role('Approved'), id: 'R0002' }, null);
      expect(h.queryOne.mock.calls[0][1]).toEqual(['R0002']);
    });

    it('a Recruitment Mode that is only re-ordered is not a change (no reconcile)', async () => {
      h.queryOne.mockResolvedValueOnce({ status: 'active' });
      await onRoleSaved(role('Approved', ['LinkedIn', 'Agency']), role('Approved', ['Agency', 'LinkedIn']), USER.userId);
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('a changed Recruitment Mode is reconciled into the plan, and a null mode counts as empty', async () => {
      h.queryOne.mockResolvedValueOnce({ status: 'active' });
      await onRoleSaved(role('Approved', ['LinkedIn']), role('Approved', null), USER.userId);
      expect(h.transaction).toHaveBeenCalledTimes(1);

      h.transaction.mockClear();
      h.queryOne.mockResolvedValueOnce({ status: 'active' });
      await onRoleSaved(role('Approved', null), role('Approved', []), USER.userId);
      expect(h.transaction).not.toHaveBeenCalled();                  // null and [] are the same "no channels"
    });

    it('a closed role closes an active plan: the plan is closed and its open commitments skipped', async () => {
      h.queryOne.mockResolvedValue({ status: 'active', id: '501' });
      useClient([['FROM sourcing_plans WHERE role_id = $1 FOR UPDATE', [{ id: '501', status: 'active' }]]]);
      await onRoleSaved(role('Live – Sourcing'), role('Closed – Filled'), USER.userId);
      expect(writes().some(s => s.includes("SET status = 'closed'"))).toBe(true);
      expect(writes().some(s => s.includes("UPDATE sourcing_commitments SET status = 'skipped'"))).toBe(true);
      expect(loggedChanges()).toContainEqual({ type: 'role_closed' });
    });

    it('closing a role whose plan is already closed writes nothing', async () => {
      h.queryOne.mockResolvedValue({ status: 'closed', id: '501' });
      await onRoleSaved(role('Closed – Filled'), role('Closed – Cancelled'), USER.userId);
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('a role put On Hold pauses its active plan (clocks stopped) and logs the pause as a system entry', async () => {
      h.queryOne.mockImplementation(async (sql: string) => (sql.includes("AND status = 'active'") ? { id: '501' } : { status: 'active' }));
      useClient([
        ['FROM sourcing_plans WHERE id = $1::bigint FOR UPDATE', [{ id: '501', status: 'active' }]],
        ['SELECT status FROM roles WHERE id', [{ status: 'On Hold' }]],
      ]);
      await onRoleSaved(role('Live – Sourcing'), role('On Hold'), USER.userId);
      expect(writes().some(s => s.includes("SET status = 'paused', paused_at = NOW()"))).toBe(true);
      expect(loggedChanges()).toContainEqual({ type: 'paused' });
    });

    it('a pause is skipped when the role is no longer On Hold by the time the hook takes the lock (a second save put it back)', async () => {
      h.queryOne.mockImplementation(async (sql: string) => (sql.includes("AND status = 'active'") ? { id: '501' } : { status: 'active' }));
      useClient([
        ['FROM sourcing_plans WHERE id = $1::bigint FOR UPDATE', [{ id: '501', status: 'active' }]],
        ['SELECT status FROM roles WHERE id', [{ status: 'Approved' }]],
      ]);
      await onRoleSaved(role('Live – Sourcing'), role('On Hold'), USER.userId);
      expect(writes()).toEqual([]);
    });

    it('a role back to an open status resumes its paused plan, moving due dates by the whole days spent paused (3 here) and logging them', async () => {
      h.queryOne.mockResolvedValue({ status: 'paused' });
      useClient([
        ["FROM sourcing_plans WHERE role_id = $1 AND status = 'paused' FOR UPDATE", [{ id: '501', paused_at: '2026-10-11T06:00:00.000Z' }]],
        ['SELECT status FROM roles WHERE id', [{ status: 'Approved' }]],
      ]);
      await onRoleSaved(role('On Hold'), role('Approved'), USER.userId);
      const shift = h.clientQuery.mock.calls.find(c => String(c[0]).includes('SET due_at = due_at +'))!;
      expect(shift[1]).toEqual(['501', 3]);
      const activate = h.clientQuery.mock.calls.find(c => String(c[0]).includes("SET status = 'active', paused_at = NULL"))!;
      expect(activate[1]).toEqual(['501', 3]);
      expect(loggedChanges()).toContainEqual({ type: 'resumed', paused_days: 3 });
    });

    it.each([
      ['a few seconds', 0, 5_000],
      ['a few hours', 0, 6 * 3_600_000],
      ['just under half a day', 0, 0.49 * 86_400_000],
      ['1.4 days', 1, 1.4 * 86_400_000],
      ['1.6 days', 2, 1.6 * 86_400_000],
      ['exactly 5 days', 5, 5 * 86_400_000],
    ])('the days spent paused are rounded to the nearest whole day (never up): %s moves due dates by %s whole days', async (_label, days, ms) => {
      h.queryOne.mockResolvedValue({ status: 'paused' });
      useClient([
        ["FROM sourcing_plans WHERE role_id = $1 AND status = 'paused' FOR UPDATE", [{ id: '501', paused_at: new Date(NOW.getTime() - ms).toISOString() }]],
        ['SELECT status FROM roles WHERE id', [{ status: 'Live – Sourcing' }]],
      ]);
      await onRoleSaved(role('On Hold'), role('Live – Sourcing'), USER.userId);
      expect(h.clientQuery.mock.calls.find(c => String(c[0]).includes('SET due_at = due_at +'))![1]).toEqual(['501', days]);
      expect(loggedChanges()).toContainEqual({ type: 'resumed', paused_days: days });
    });

    it('a paused plan that has no paused_at stamp resumes with 0 days moved', async () => {
      h.queryOne.mockResolvedValue({ status: 'paused' });
      useClient([
        ["FROM sourcing_plans WHERE role_id = $1 AND status = 'paused' FOR UPDATE", [{ id: '501', paused_at: null }]],
        ['SELECT status FROM roles WHERE id', [{ status: 'Approved' }]],
      ]);
      await onRoleSaved(role('On Hold'), role('Approved'), USER.userId);
      expect(loggedChanges()).toContainEqual({ type: 'resumed', paused_days: 0 });
    });

    it('a role that goes back On Hold again before the resume takes the lock leaves the plan paused', async () => {
      h.queryOne.mockResolvedValue({ status: 'paused' });
      useClient([
        ["FROM sourcing_plans WHERE role_id = $1 AND status = 'paused' FOR UPDATE", [{ id: '501', paused_at: '2026-10-11T06:00:00.000Z' }]],
        ['SELECT status FROM roles WHERE id', [{ status: 'On Hold' }]],
      ]);
      await onRoleSaved(role('On Hold'), role('Approved'), USER.userId);
      expect(writes()).toEqual([]);
    });

    it('a plan that is no longer closed by the time the hook takes the lock is left alone (a second save already reopened it)', async () => {
      h.queryOne.mockResolvedValue({ status: 'closed' });
      useClient([['FROM sourcing_plans WHERE role_id = $1 FOR UPDATE', [{ id: '501', status: 'draft' }]]]);
      await onRoleSaved(role('Closed – Filled'), role('Approved'), USER.userId);
      expect(writes()).toEqual([]);
    });

    it('a closed plan on a role that is open again goes back to draft (history kept, channels re-planned, logged with the reopening user)', async () => {
      h.queryOne.mockResolvedValue({ status: 'closed' });
      useClient([['FROM sourcing_plans WHERE role_id = $1 FOR UPDATE', [{ id: '501', status: 'closed' }]]]);
      await onRoleSaved(role('Closed – Filled'), role('Approved'), USER.userId);
      expect(writes().some(s => s.includes("SET status = 'draft', closed_at = NULL"))).toBe(true);
      expect(writes().some(s => s.includes("UPDATE sourcing_plan_channels SET state = CASE WHEN state = 'excluded' THEN state ELSE 'planned' END"))).toBe(true);
      const entry = h.clientQuery.mock.calls.find(c => String(c[0]).includes('INSERT INTO sourcing_plan_changes'))!;
      expect(entry[1]).toEqual(['501', USER.userId, JSON.stringify({ type: 'role_reopened' }), 'Plan returned to draft — re-activate to start the clocks', null]);
    });
  });
});
