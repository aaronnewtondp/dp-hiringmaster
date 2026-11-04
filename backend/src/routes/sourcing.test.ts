import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';

// routes/sourcing.ts: the module's flag gate, id validation, persona gates and the Hiring Manager's redacted plan. The router, the real
// authenticate / requireHR and the real redaction run; the database, the plan services, the advisor and the engine are mocked.
const h = vi.hoisted(() => ({
  query: vi.fn(), queryOne: vi.fn(),
  activatePlan: vi.fn(), closeChannel: vi.fn(), completeCommitment: vi.fn(), ensureDraftPlansForOpenRoles: vi.fn(), getPlanRowById: vi.fn(),
  getPlanView: vi.fn(), listPeople: vi.fn(), reopenChannel: vi.fn(), reopenCommitment: vi.fn(), resolveException: vi.fn(), setChannelState: vi.fn(),
  skipCommitment: vi.fn(), updateChannelSettings: vi.fn(), updatePlan: vi.fn(),
  loadSettings: vi.fn(), saveSettings: vi.fn(), getAdvice: vi.fn(), getWorkspace: vi.fn(), maybeRunSourcingCheck: vi.fn(),
}));

// authenticate()'s live is_active lookup is answered here, ahead of h.query / h.queryOne, so it neither shows up in what the
// route queried nor consumes a programmed reply (see src/test/accessLookup.ts).
vi.mock('../db/index.js', async () => {
  const { isAccessLookup, ACTIVE_ACCOUNT_ROWS } = await import('../test/accessLookup.js');
  return {
    query: async (...a: unknown[]) => (isAccessLookup(a[0]) ? ACTIVE_ACCOUNT_ROWS : h.query(...a)),
    queryOne: async (...a: unknown[]) => (isAccessLookup(a[0]) ? ACTIVE_ACCOUNT_ROWS[0] : h.queryOne(...a)),
    transaction: vi.fn(), pool: {},
  };
});
vi.mock('../services/sourcingPlans.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/sourcingPlans.js')>();
  return {
    ...actual,
    activatePlan: h.activatePlan, closeChannel: h.closeChannel, completeCommitment: h.completeCommitment,
    ensureDraftPlansForOpenRoles: h.ensureDraftPlansForOpenRoles, getPlanRowById: h.getPlanRowById, getPlanView: h.getPlanView, listPeople: h.listPeople,
    reopenChannel: h.reopenChannel, reopenCommitment: h.reopenCommitment, resolveException: h.resolveException, setChannelState: h.setChannelState,
    skipCommitment: h.skipCommitment, updateChannelSettings: h.updateChannelSettings, updatePlan: h.updatePlan,
  };
});
vi.mock('../services/sourcingSettings.js', () => ({ loadSettings: h.loadSettings, saveSettings: h.saveSettings }));
vi.mock('../services/sourcingAdvisor.js', () => ({ getAdvice: h.getAdvice }));
vi.mock('../services/sourcingWorkspace.js', () => ({ getWorkspace: h.getWorkspace }));
vi.mock('../jobs/sourcingChecker.js', () => ({ maybeRunSourcingCheck: h.maybeRunSourcingCheck }));

import router from './sourcing.js';
import { SourcingError, type PlanView } from '../services/sourcingPlans.js';
import { DEFAULT_SOURCING_SETTINGS, OPEN_ROLE_STATUSES } from '../utils/sourcingConfig.js';
import type { Persona } from '../types/index.js';

const SECRET = 'test-only-jwt-secret';
let server: http.Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/sourcing', router);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sourcing`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

const USER_IDS: Record<Persona, string> = {
  hr_recruiter: 'U-HR', hiring_manager: 'U-HM', leadership: 'U-LEAD', super_admin: 'U-SUPER',
};
const token = (persona: Persona, email = `${persona}@example.test`) =>
  jwt.sign({ userId: USER_IDS[persona], email, persona, name: `Test ${persona}` }, SECRET, { expiresIn: '5m' });

async function call(method: string, path: string, opts: { as?: Persona | null; body?: unknown; rawToken?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.as !== null) headers.authorization = `Bearer ${opts.rawToken ?? token(opts.as ?? 'hr_recruiter')}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json: json as Record<string, unknown> | null, text };
}

const LEAK = (n: string) => `REDACTED_SENTINEL_${n}`;
function view(): PlanView {
  return {
    plan: { id: '501', role_id: 'R9001', status: 'active', strategy_note: LEAK('note'), baseline: { x: LEAK('baseline') }, baseline_at: null, activated_at: null, paused_at: null, pause_total_days: 0, closed_at: null, weekly_qualified_target: null },
    role: { id: 'R9001', title: 'Synthetic Role', priority: 'P1', status: 'Live – Sourcing', num_openings: 1, hiring_manager_name: 'Test Manager', recruitment_mode: ['LinkedIn'], approval_date: null },
    channels: [{
      id: '11', channel: 'LinkedIn', state: 'active', excluded_reason: null, closed_at: null, closed_reason: LEAK('closed'), config: { posting_url: LEAK('url') }, targets: {},
      tracker: { applicable: true, target: 5, anchor: null, link: LEAK('link'), running: null, weeks: [], totals: { weeks: 0, met: 0, actual: 0, target: 0 }, sourced: { applications: 0, qualified: 0 } },
      commitments: [],
    }],
    exceptions: [{
      id: '9', channel: 'LinkedIn', type: 'VOLUME_GAP', status: 'open', severity: 30, is_shadow: false, detected_at: '2026-10-13T00:00:00Z', last_seen_at: '2026-10-13T00:00:00Z',
      evidence: { n: LEAK('evidence') }, resolution_path: null, reason: LEAK('reason'), corrective_action: LEAK('corrective'), snooze_until: null, blocker_due: null,
      blocker_owner_name: LEAK('owner'), resolved_at: null, committed: 'c', happened: 'h', next_action: 'n',
    }],
    changes: [{ id: '1', at: '2026-10-13T00:00:00Z', by_name: LEAK('author'), change: { type: 'activated' }, reason: LEAK('why'), text: LEAK('text'), category: 'plan' }],
    changes_total: 1,
    volume: { weekly_qualified: 0, shortlisted: 0, scored: 0, min: 5, rule: 'either', applicable: true, target_source: 'default', role_target: null, default_target: 5 },
    output: [], attribution_reliable: {}, settings: { go_live_date: null, qualified_rule: 'either', shadow_until: null },
  };
}

beforeEach(() => {
  vi.stubEnv('JWT_SECRET', SECRET);
  vi.stubEnv('SOURCING_ENABLED', 'true');
  for (const f of Object.values(h)) f.mockReset();
  h.query.mockResolvedValue([]);
  h.queryOne.mockResolvedValue(null);
  h.loadSettings.mockResolvedValue({ ...DEFAULT_SOURCING_SETTINGS });
  h.saveSettings.mockResolvedValue({ saved: ['volume_min_qualified'], rejected: [], settings: { ...DEFAULT_SOURCING_SETTINGS } });
  h.getWorkspace.mockResolvedValue({ roles: [], drafts: [], drafts_total: 0 });
  h.getPlanView.mockResolvedValue(view());
  h.getPlanRowById.mockResolvedValue({ id: '501', role_id: 'R9001' });
  h.ensureDraftPlansForOpenRoles.mockResolvedValue(0);
  h.maybeRunSourcingCheck.mockResolvedValue(undefined);
  h.completeCommitment.mockResolvedValue({ planId: '501', roleId: 'R9001' });
  h.listPeople.mockResolvedValue([{ id: '1', name: 'Test A', persona: 'hr_recruiter' }]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('authentication runs before everything else, even with the module off', () => {
  it.each(['GET', 'PUT', 'POST', 'PATCH'])('%s without a token is 401', async method => {
    vi.stubEnv('SOURCING_ENABLED', 'false');
    const r = await call(method, '/settings', { as: null });
    expect(r.status).toBe(401);
  });

  it('even /status needs a signed-in user', async () => {
    expect((await call('GET', '/status', { as: null })).status).toBe(401);
  });

  it('a token signed with another secret is 401', async () => {
    const forged = jwt.sign({ userId: 'x', email: 'x@example.test', persona: 'super_admin', name: 'X' }, 'some-other-secret');
    expect((await call('GET', '/settings', { rawToken: forged })).status).toBe(401);
  });
});

describe('the SOURCING_ENABLED switch', () => {
  beforeEach(() => { vi.stubEnv('SOURCING_ENABLED', 'false'); });

  it.each([
    ['GET', '/settings'], ['GET', '/people'], ['GET', '/workspace'], ['GET', '/plans/R9001'], ['GET', '/plans/R9001/advice'], ['GET', '/queue'],
  ])('%s %s answers {enabled:false} and runs nothing', async (method, path) => {
    const r = await call(method, path);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ enabled: false });
    expect(h.query).not.toHaveBeenCalled();
    expect(h.queryOne).not.toHaveBeenCalled();
    expect(h.getPlanView).not.toHaveBeenCalled();
    expect(h.getWorkspace).not.toHaveBeenCalled();
    expect(h.maybeRunSourcingCheck).not.toHaveBeenCalled();
  });

  it.each([
    ['PUT', '/settings', { volume_min_qualified: 3 }],
    ['PATCH', '/plans/501', { strategy_note: 'x' }],
    ['POST', '/plans/501/activate', {}],
    ['PUT', '/plans/501/channel', { state: 'planned', channel: 'LinkedIn' }],
    ['POST', '/plans/501/channel/close', { channel: 'LinkedIn', reason: 'x' }],
    ['POST', '/plans/501/channel/reopen', { channel: 'LinkedIn' }],
    ['PATCH', '/plans/501/channel-settings', { channel: 'LinkedIn' }],
    ['POST', '/commitments/21/complete', {}],
    ['POST', '/commitments/21/skip', { reason: 'x' }],
    ['POST', '/commitments/21/reopen', {}],
    ['POST', '/exceptions/9/resolve', { path: 'catch_up', reason: 'x' }],
  ])('%s %s is a 503 and calls no service', async (method, path, body) => {
    const r = await call(method, path, { body });
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ error: 'The sourcing module is not enabled', enabled: false });
    for (const f of [h.activatePlan, h.closeChannel, h.completeCommitment, h.reopenChannel, h.reopenCommitment, h.resolveException, h.setChannelState,
      h.skipCommitment, h.updateChannelSettings, h.updatePlan, h.saveSettings]) expect(f).not.toHaveBeenCalled();
  });

  it('with the module off a Hiring Manager gets the same {enabled:false}, never a 403 that would reveal anything', async () => {
    expect((await call('GET', '/settings', { as: 'hiring_manager' })).json).toEqual({ enabled: false });
  });

  it('/status answers {enabled:false} without reading settings', async () => {
    const r = await call('GET', '/status', { as: 'hiring_manager' });
    expect(r.json).toEqual({ enabled: false });
    expect(h.loadSettings).not.toHaveBeenCalled();
  });

  it.each(['', 'TRUE', '1', 'yes'])('SOURCING_ENABLED=%j keeps the module off (only the exact string "true" turns it on)', async value => {
    vi.stubEnv('SOURCING_ENABLED', value);
    expect((await call('GET', '/settings')).json).toEqual({ enabled: false });
  });
});

describe('GET /status (open to every signed-in persona)', () => {
  it.each(['hr_recruiter', 'hiring_manager', 'leadership', 'super_admin'] as const)('answers a %s with exactly the five public settings and nothing else', async persona => {
    h.loadSettings.mockResolvedValue({ ...DEFAULT_SOURCING_SETTINGS, go_live_date: '2026-10-20', shadow_until: '2026-12-01', referral_audience_email: 'all@example.test',
      digest_recipients: ['digest.hidden@digitalpaani.com'], daily_digest_enabled: true });
    const r = await call('GET', '/status', { as: persona });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      enabled: true,
      settings: { go_live_date: '2026-10-20', shadow_until: '2026-12-01', qualified_rule: 'either', volume_min_qualified: 5, referral_audience_email: 'all@example.test' },
    });
    expect(r.text).not.toContain('digest.hidden@digitalpaani.com');
    expect(r.text).not.toContain('digest_recipients');
  });

  it('a failing settings read is a 500 that does not echo the error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.loadSettings.mockRejectedValue(new Error('relation "sourcing_settings" does not exist'));
    const r = await call('GET', '/status');
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'Status failed' });
    expect(r.text).not.toContain('sourcing_settings');
  });
});

describe('persona gates (module on)', () => {
  const HR_ONLY: Array<[string, string, unknown?]> = [
    ['GET', '/settings'], ['GET', '/people'], ['GET', '/plans/R9001/advice'], ['GET', '/queue'],
    ['PUT', '/settings', { volume_min_qualified: 3 }],
    ['PATCH', '/plans/501', { strategy_note: 'x' }],
    ['POST', '/plans/501/activate', {}],
    ['PUT', '/plans/501/channel', { state: 'planned', channel: 'LinkedIn' }],
    ['POST', '/plans/501/channel/close', { channel: 'LinkedIn', reason: 'x' }],
    ['POST', '/plans/501/channel/reopen', { channel: 'LinkedIn' }],
    ['PATCH', '/plans/501/channel-settings', { channel: 'LinkedIn' }],
    ['POST', '/commitments/21/complete', {}],
    ['POST', '/commitments/21/skip', { reason: 'x' }],
    ['POST', '/commitments/21/reopen', {}],
    ['POST', '/exceptions/9/resolve', { path: 'catch_up', reason: 'x' }],
  ];

  it.each(HR_ONLY)('a hiring_manager gets 403 on %s %s and no service runs', async (method, path, body) => {
    const r = await call(method, path, { as: 'hiring_manager', body });
    expect(r.status).toBe(403);
    for (const f of [h.activatePlan, h.closeChannel, h.completeCommitment, h.reopenChannel, h.reopenCommitment, h.resolveException, h.setChannelState,
      h.skipCommitment, h.updateChannelSettings, h.updatePlan, h.saveSettings, h.getAdvice, h.listPeople, h.maybeRunSourcingCheck]) expect(f).not.toHaveBeenCalled();
  });

  it.each(['hr_recruiter', 'leadership', 'super_admin'] as const)('a %s can read the settings', async persona => {
    const r = await call('GET', '/settings', { as: persona });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ enabled: true });
  });

  it('only Leadership and the Super Admin may change settings: hr_recruiter is 403 and nothing is saved', async () => {
    const r = await call('PUT', '/settings', { as: 'hr_recruiter', body: { volume_min_qualified: 9 } });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: 'Only Leadership or the Super Admin can change sourcing settings' });
    expect(h.saveSettings).not.toHaveBeenCalled();
  });

  it.each(['leadership', 'super_admin'] as const)('a %s changing settings reaches saveSettings with their own user id', async persona => {
    const r = await call('PUT', '/settings', { as: persona, body: { volume_min_qualified: 9 } });
    expect(r.status).toBe(200);
    expect(h.saveSettings).toHaveBeenCalledWith({ volume_min_qualified: 9 }, USER_IDS[persona]);
  });

  it('a patch where every key is rejected is a 400 that names them; a partly accepted patch is a 200', async () => {
    h.saveSettings.mockResolvedValueOnce({ saved: [], rejected: ['bogus', 'qualified_rule'], settings: DEFAULT_SOURCING_SETTINGS });
    const bad = await call('PUT', '/settings', { as: 'leadership', body: { bogus: 1, qualified_rule: 'x' } });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ error: 'Nothing saved — invalid: bogus, qualified_rule', rejected: ['bogus', 'qualified_rule'] });

    h.saveSettings.mockResolvedValueOnce({ saved: ['renew_lead_days'], rejected: ['bogus'], settings: DEFAULT_SOURCING_SETTINGS });
    const mixed = await call('PUT', '/settings', { as: 'leadership', body: { renew_lead_days: 2, bogus: 1 } });
    expect(mixed.status).toBe(200);
    expect(mixed.json).toMatchObject({ enabled: true, saved: ['renew_lead_days'], rejected: ['bogus'] });
  });

  it.each([['a JSON array', [1, 2]], ['an empty object', {}]])('a settings body that is %s is treated as an empty patch', async (_label, body) => {
    await call('PUT', '/settings', { as: 'leadership', body });
    expect(h.saveSettings).toHaveBeenCalledWith({}, USER_IDS.leadership);
  });
});

describe('id parameters must be 1 to 18 digits', () => {
  const BAD_IDS = ['1a', 'abc', '12.5', '-1', '1234567890123456789', '0x10', '1%20', '1e3'];
  const GOOD_IDS = ['1', '501', '123456789012345678'];

  it.each(BAD_IDS)('plan id "%s" is a 400 on every plan route and nothing is called', async id => {
    const routes: Array<[string, string, unknown]> = [
      ['PATCH', `/plans/${id}`, { strategy_note: 'x' }],
      ['POST', `/plans/${id}/activate`, {}],
      ['PUT', `/plans/${id}/channel`, { state: 'planned', channel: 'LinkedIn' }],
      ['POST', `/plans/${id}/channel/close`, { channel: 'LinkedIn', reason: 'x' }],
      ['POST', `/plans/${id}/channel/reopen`, { channel: 'LinkedIn' }],
      ['PATCH', `/plans/${id}/channel-settings`, { channel: 'LinkedIn' }],
    ];
    for (const [method, path, body] of routes) {
      const r = await call(method, path, { body });
      expect(r.status, `${method} ${path}`).toBe(400);
      expect(r.json).toEqual({ error: 'Invalid plan id' });
    }
    for (const f of [h.activatePlan, h.closeChannel, h.reopenChannel, h.setChannelState, h.updateChannelSettings, h.updatePlan]) expect(f).not.toHaveBeenCalled();
  });

  it.each(BAD_IDS)('commitment id "%s" is a 400 and nothing is called', async id => {
    for (const action of ['complete', 'skip', 'reopen']) {
      const r = await call('POST', `/commitments/${id}/${action}`, { body: {} });
      expect(r.status, action).toBe(400);
      expect(r.json).toEqual({ error: 'Invalid commitment id' });
    }
    for (const f of [h.completeCommitment, h.skipCommitment, h.reopenCommitment]) expect(f).not.toHaveBeenCalled();
  });

  it.each(BAD_IDS)('exception id "%s" is a 400 and nothing is called', async id => {
    const r = await call('POST', `/exceptions/${id}/resolve`, { body: { path: 'catch_up', reason: 'later' } });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: 'Invalid exception id' });
    expect(h.resolveException).not.toHaveBeenCalled();
  });

  it.each(GOOD_IDS)('id "%s" is passed through to the service as the same string', async id => {
    h.completeCommitment.mockResolvedValue({ planId: '1', roleId: 'R1' });
    await call('POST', `/commitments/${id}/complete`, { body: {} });
    expect(h.completeCommitment.mock.calls[0][0]).toBe(id);
    await call('PATCH', `/plans/${id}`, { body: { strategy_note: 'x' } });
    expect(h.updatePlan.mock.calls[0][0]).toBe(id);
  });
});

describe('request bodies are validated before a service is called', () => {
  it('PATCH /plans/:id with owner_user_id is a 400 (sourcing belongs to HR/Admin as a whole)', async () => {
    const r = await call('PATCH', '/plans/501', { body: { owner_user_id: 'U-1', strategy_note: 'x' } });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: expect.stringContaining('no individual owner') });
    expect(h.updatePlan).not.toHaveBeenCalled();
  });

  it.each(['5', true, {}, [3]])('PATCH /plans/:id with a weekly_qualified_target of %j is a 400', async value => {
    const r = await call('PATCH', '/plans/501', { body: { weekly_qualified_target: value } });
    expect(r.status).toBe(400);
    expect(h.updatePlan).not.toHaveBeenCalled();
  });

  it('PATCH /plans/:id passes a number or null target and only the fields that were sent', async () => {
    await call('PATCH', '/plans/501', { body: { weekly_qualified_target: 8 } });
    expect(h.updatePlan.mock.calls[0][1]).toEqual({ weekly_qualified_target: 8 });
    await call('PATCH', '/plans/501', { body: { weekly_qualified_target: null, strategy_note: 42 } });
    expect(h.updatePlan.mock.calls[1][1]).toEqual({ weekly_qualified_target: null, strategy_note: null });
  });

  it('POST /plans/:id/activate refuses a non-numeric weekly target; passes channels only when it is an array', async () => {
    expect((await call('POST', '/plans/501/activate', { body: { weekly_qualified_target: 'five' } })).status).toBe(400);
    expect(h.activatePlan).not.toHaveBeenCalled();
    const ok = await call('POST', '/plans/501/activate', { body: { channels: 'LinkedIn', strategy_note: 'n', weekly_qualified_target: 6 } });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ success: true, plan_id: '501', role_id: 'R9001' });
    expect(h.activatePlan.mock.calls[0][1]).toEqual({ strategy_note: 'n', weekly_qualified_target: 6, channels: [] });
  });

  it.each(['active', 'closed', '', undefined, 3])('PUT /plans/:id/channel with state %j is a 400 (only planned or excluded)', async state => {
    const r = await call('PUT', '/plans/501/channel', { body: { state, channel: 'LinkedIn' } });
    expect(r.status).toBe(400);
    expect(h.setChannelState).not.toHaveBeenCalled();
  });

  it.each(['', 'catch-up', 'resolve', undefined, null])('POST /exceptions/:id/resolve with path %j is a 400', async path => {
    const r = await call('POST', '/exceptions/9/resolve', { body: { path, reason: 'later' } });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: 'path must be catch_up, change_strategy or blocker' });
    expect(h.resolveException).not.toHaveBeenCalled();
  });

  it('POST /exceptions/:id/resolve passes only well-typed fields (a non-string reason becomes empty, exclude_channel must be exactly true)', async () => {
    await call('POST', '/exceptions/9/resolve', { body: { path: 'change_strategy', reason: 42, exclude_channel: 'true', corrective_action: ['x'] } });
    expect(h.resolveException.mock.calls[0][1]).toEqual({
      path: 'change_strategy', reason: '', corrective_action: null, snooze_until: null, blocker_owner_user_id: null, blocker_due: null, exclude_channel: false,
    });
  });

  it('POST /commitments/:id/complete passes the typed evidence, drops an empty url, and answers with the role id', async () => {
    const r = await call('POST', '/commitments/21/complete', { body: { note: 'done', url: '   ', count: 4, attest: 'yes', weekly_target: '20', posted_at: '2026-10-01' } });
    expect(r.json).toEqual({ success: true, role_id: 'R9001' });
    expect(h.completeCommitment.mock.calls[0][1]).toEqual({ note: 'done', url: null, count: 4, attest: false, posted_at: '2026-10-01', weekly_target: null });
  });

  it('every mutation is performed as the signed-in user (the token\'s payload, not anything in the body)', async () => {
    await call('POST', '/commitments/21/skip', { as: 'leadership', body: { reason: 'r', userId: 'U-FORGED' } });
    const user = h.skipCommitment.mock.calls[0][2];
    expect(user).toMatchObject({ userId: 'U-LEAD', persona: 'leadership' });
  });
});

describe('error answers', () => {
  it('a SourcingError keeps its own status and message', async () => {
    h.skipCommitment.mockRejectedValue(new SourcingError(409, 'This commitment is already complete'));
    const r = await call('POST', '/commitments/21/skip', { body: { reason: 'x' } });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: 'This commitment is already complete' });
  });

  it('any other error is a 500 that names the action, never the internal message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.updatePlan.mockRejectedValue(new Error('duplicate key value violates unique constraint "uq_secret_index"'));
    const r = await call('PATCH', '/plans/501', { body: { strategy_note: 'x' } });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'Updating the plan failed' });
    expect(r.text).not.toContain('uq_secret_index');
  });
});

describe('GET /workspace', () => {
  it.each(['hr_recruiter', 'leadership', 'super_admin'] as const)('a %s is HR-tier: drafts are seeded, the engine runs, the answer is not read-only', async persona => {
    h.getWorkspace.mockResolvedValue({ roles: [{ role_id: 'R1' }], drafts: [], drafts_total: 0 });
    const r = await call('GET', '/workspace', { as: persona });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ enabled: true, read_only: false, roles: [{ role_id: 'R1' }] });
    expect(h.ensureDraftPlansForOpenRoles).toHaveBeenCalledTimes(1);
    expect(h.maybeRunSourcingCheck).toHaveBeenCalledTimes(1);
    expect(h.getWorkspace).toHaveBeenCalledWith({ userId: USER_IDS[persona], hr: true });
  });

  it('a hiring_manager gets a read-only workspace, with no draft seeding', async () => {
    const r = await call('GET', '/workspace', { as: 'hiring_manager' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ enabled: true, read_only: true });
    expect(h.ensureDraftPlansForOpenRoles).not.toHaveBeenCalled();
    expect(h.getWorkspace).toHaveBeenCalledWith({ userId: 'U-HM', hr: false });
  });

  it('a signed-in user whose persona is neither HR-tier nor hiring_manager (a token from before the "interviewer" persona was merged) is a 403 and nothing runs', async () => {
    const stale = jwt.sign({ userId: 'U-OLD', email: 'old@example.test', persona: 'interviewer', name: 'Test Interviewer' }, SECRET, { expiresIn: '5m' });
    const r = await call('GET', '/workspace', { rawToken: stale });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: 'Not available' });
    expect(h.ensureDraftPlansForOpenRoles).not.toHaveBeenCalled();
    expect(h.maybeRunSourcingCheck).not.toHaveBeenCalled();
    expect(h.getWorkspace).not.toHaveBeenCalled();
  });
});

describe('GET /plans/:roleId (HR-tier sees everything; a Hiring Manager only their own role, redacted)', () => {
  const role = (over: Record<string, unknown> = {}) => ({ id: 'R9001', status: 'Live – Sourcing', hiring_manager_name: 'Test Manager', ...over });
  const roleAndUser = (r: Record<string, unknown> | null, userName: string | null) => h.queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM roles')) return r;
    if (sql.includes('FROM users')) return userName === null ? null : { name: userName };
    return null;
  });

  it('an unknown role is a 404', async () => {
    roleAndUser(null, null);
    const r = await call('GET', '/plans/R404');
    expect(r.status).toBe(404);
    expect(h.getPlanView).not.toHaveBeenCalled();
  });

  it.each(['hr_recruiter', 'leadership', 'super_admin'] as const)('a %s gets the full plan, not read-only, with nothing removed', async persona => {
    roleAndUser(role(), null);
    const r = await call('GET', '/plans/R9001', { as: persona });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ enabled: true, read_only: false });
    expect(r.text).toContain(LEAK('note'));
    expect(r.text).toContain(LEAK('reason'));
    expect(r.text).toContain(LEAK('link'));
  });

  it('HR-tier seeds a draft plan for an open role on the first visit, and only for an open role', async () => {
    roleAndUser(role({ status: 'Live – Sourcing' }), null);
    await call('GET', '/plans/R9001');
    expect(h.ensureDraftPlansForOpenRoles).toHaveBeenCalledWith('R9001');

    h.ensureDraftPlansForOpenRoles.mockClear();
    roleAndUser(role({ status: 'Closed – Filled' }), null);
    await call('GET', '/plans/R9001');
    expect(h.ensureDraftPlansForOpenRoles).not.toHaveBeenCalled();
    expect(OPEN_ROLE_STATUSES).not.toContain('Closed – Filled');
  });

  it('a Hiring Manager named on the role gets the REDACTED plan, read-only, with no sentinel anywhere in the body', async () => {
    roleAndUser(role(), 'Test Manager');
    const r = await call('GET', '/plans/R9001', { as: 'hiring_manager' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ enabled: true, read_only: true });
    expect(r.text).not.toMatch(/REDACTED_SENTINEL/);
    expect((r.json!.plan as Record<string, unknown>).strategy_note).toBeNull();
    expect(h.ensureDraftPlansForOpenRoles).not.toHaveBeenCalled();
  });

  it('a co-Hiring-Manager (second name in the field) is let in; someone merely sharing a first name is not', async () => {
    roleAndUser(role({ hiring_manager_name: 'Aaa Bbb, Test Manager' }), 'Test Manager');
    expect((await call('GET', '/plans/R9001', { as: 'hiring_manager' })).status).toBe(200);
    roleAndUser(role({ hiring_manager_name: 'Test Managerson' }), 'Test Manager');
    expect((await call('GET', '/plans/R9001', { as: 'hiring_manager' })).status).toBe(403);
  });

  it.each([
    ['another person\'s role', 'Other Person', 'Test Manager'],
    ['a role with no Hiring Manager written', null, 'Test Manager'],
    ['a user who no longer exists', 'Test Manager', null],
  ])('a hiring_manager on %s is 403 and never reaches the plan', async (_label, fieldName, userName) => {
    roleAndUser(role({ hiring_manager_name: fieldName }), userName);
    const r = await call('GET', '/plans/R9001', { as: 'hiring_manager' });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: 'Not available for this role' });
    expect(h.getPlanView).not.toHaveBeenCalled();
  });

  it('a role with no plan answers {enabled:true, plan:null}', async () => {
    roleAndUser(role(), null);
    h.getPlanView.mockResolvedValue(null);
    const r = await call('GET', '/plans/R9001');
    expect(r.json).toEqual({ enabled: true, plan: null });
  });
});

// ─── GET /queue: what the My Tasks "Sourcing" box shows (the same for every HR-tier user) ─────────────────
describe('GET /queue', () => {
  const NOW = new Date('2026-10-14T06:00:00Z');                       // 11:30 IST on 2026-10-14
  type Rows = {
    toActivate: unknown[]; due: unknown[]; exceptions: unknown[]; counts: unknown; volApps: unknown[]; activePlans: unknown[];
  };
  let rows: Rows;
  const serve = () => {
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE p.status = 'draft' AND r.status = ANY")) return rows.toActivate;
      if (sql.includes('FROM sourcing_commitments c JOIN')) return rows.due;
      if (sql.includes('FROM sourcing_exceptions e JOIN sourcing_plans p')) return rows.exceptions;
      if (sql.includes('FROM applications a')) return rows.volApps;
      if (sql.includes('p.weekly_qualified_target AS target FROM sourcing_plans p JOIN roles r')) return rows.activePlans;
      return [];
    });
    h.queryOne.mockImplementation(async (sql: string) => (sql.includes("count(*) FILTER (WHERE e.status = 'snoozed'") ? rows.counts : null));
  };
  const exception = (id: string, role_id: string, severity: number, over: Record<string, unknown> = {}) => ({
    id, plan_id: '5' + role_id.slice(1), role_id, title: `Title ${role_id}`, priority: 'P1', channel: 'LinkedIn', type: 'COMMITMENT_OVERDUE', severity,
    detected_at: '2026-10-11T06:00:00Z', evidence: { count: 1, overdue: [{ title: 'Log the post', due: '2026-10-09', days_overdue: 5 }] }, ...over,
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    rows = { toActivate: [], due: [], exceptions: [], counts: { snoozed: '0', blocked: '0', active_plans: '0' }, volApps: [], activePlans: [] };
    serve();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('an empty system answers an empty queue with the IST date, zero counts and the engine run first', async () => {
    const r = await call('GET', '/queue');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      enabled: true, today: '2026-10-14', plans_to_activate: [], due: [], exceptions: [], exception_count: 0,
      snoozed_count: 0, blocked_count: 0, active_plans: 0, volume: [], volume_ok: 0,
    });
    expect(h.maybeRunSourcingCheck).toHaveBeenCalledTimes(1);
  });

  it.each(['hr_recruiter', 'leadership', 'super_admin'] as const)('a %s gets the same queue: there is no "mine" and no scope', async persona => {
    rows.counts = { snoozed: '1', blocked: '2', active_plans: '3' };
    serve();
    const r = await call('GET', '/queue?scope=mine', { as: persona });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ snoozed_count: 1, blocked_count: 2, active_plans: 3 });
    expect(h.query.mock.calls.every(c => !String(c[0]).includes('owner_user_id'))).toBe(true);
  });

  it('plans waiting for activation are passed through as they come (already ordered by the database)', async () => {
    rows.toActivate = [{ plan_id: '7', role_id: 'R7', title: 'Synthetic Seven', priority: 'P0', approval_date: '2026-10-12' }, { plan_id: '8', role_id: 'R8', title: 'Synthetic Eight', priority: 'P1', approval_date: null }];
    serve();
    expect((await call('GET', '/queue')).json!.plans_to_activate).toEqual(rows.toActivate);
  });

  it('a commitment is overdue once its due time has passed (not just its day), and its day is the IST day', async () => {
    const due = (id: string, due_at: string) => ({ id, plan_id: '501', role_id: 'R1', title: 'T1', priority: 'P0', channel: 'LinkedIn', kind: 'renew_posting', ctitle: `Renew ${id}`, due_at });
    rows.due = [due('1', '2026-10-13T00:00:00Z'), due('2', '2026-10-14T05:59:59Z'), due('3', '2026-10-14T06:00:00Z'), due('4', '2026-10-14T18:29:59Z')];
    serve();
    const out = (await call('GET', '/queue')).json!.due as Array<Record<string, unknown>>;
    expect(out.map(d => [d.id, d.overdue, d.due_date])).toEqual([['1', true, '2026-10-13'], ['2', true, '2026-10-14'], ['3', false, '2026-10-14'], ['4', false, '2026-10-14']]);
    expect(out[0]).toEqual({ id: '1', plan_id: '501', role_id: 'R1', role_title: 'T1', priority: 'P0', channel: 'LinkedIn', kind: 'renew_posting', title: 'Renew 1', due_date: '2026-10-13', overdue: true });
  });

  it('days are IST days: 20:00 UTC is already the next day in India, for "today" and for a commitment\'s due date', async () => {
    vi.setSystemTime(new Date('2026-10-14T20:00:00Z'));                     // 01:30 IST on 15 Oct
    rows.due = [{ id: '1', plan_id: '501', role_id: 'R1', title: 'T1', priority: 'P0', channel: 'LinkedIn', kind: 'renew_posting', ctitle: 'Renew', due_at: '2026-10-14T19:00:00Z' }];   // 00:30 IST on 15 Oct
    serve();
    const j = (await call('GET', '/queue')).json!;
    expect(j.today).toBe('2026-10-15');
    expect((j.due as Array<Record<string, unknown>>)[0]).toMatchObject({ due_date: '2026-10-15', overdue: true });
  });

  it('open exceptions are grouped by role, the role with the worst exception first, and counted', async () => {
    rows.exceptions = [exception('9', 'R2', 40), exception('10', 'R1', 30), exception('11', 'R1', 50), exception('12', 'R3', 10)];
    serve();
    const j = (await call('GET', '/queue')).json!;
    expect(j.exception_count).toBe(4);
    const groups = j.exceptions as Array<{ role_id: string; severity: number; items: Array<Record<string, unknown>> }>;
    expect(groups.map(g => [g.role_id, g.severity, g.items.map(i => i.id)])).toEqual([['R1', 50, ['10', '11']], ['R2', 40, ['9']], ['R3', 10, ['12']]]);
    expect(groups[0]).toMatchObject({ title: 'Title R1', priority: 'P1' });
  });

  it('each exception carries its age in whole days and the plain-language text, and none of the raw evidence', async () => {
    rows.exceptions = [exception('9', 'R1', 30)];                           // detected 3 days before NOW
    serve();
    const item = ((await call('GET', '/queue')).json!.exceptions as Array<{ items: Array<Record<string, unknown>> }>)[0].items[0];
    expect(item).toMatchObject({ id: '9', plan_id: '51', channel: 'LinkedIn', type: 'COMMITMENT_OVERDUE', severity: 30, age_days: 3 });
    expect(String(item.committed)).toContain('Log the post');
    expect(String(item.happened)).toContain('5 days overdue');
    expect(String(item.next_action).length).toBeGreaterThan(0);
    expect(item).not.toHaveProperty('evidence');
  });

  it('snoozed, blocked and active-plan counts arrive as numbers', async () => {
    rows.counts = { snoozed: '4', blocked: '1', active_plans: '12' };
    serve();
    expect((await call('GET', '/queue')).json).toMatchObject({ snoozed_count: 4, blocked_count: 1, active_plans: 12 });
  });

  it('a missing counts row reads as zeros', async () => {
    rows.counts = null;
    serve();
    expect((await call('GET', '/queue')).json).toMatchObject({ snoozed_count: 0, blocked_count: 0, active_plans: 0 });
  });

  describe('the volume lines: qualified in the settings window against the target in force', () => {
    const app = (role_id: string, daysAgo: number) => ({ role_id, shortlisted_at: new Date(NOW.getTime() - daysAgo * 86400000).toISOString(), scored_at: null });

    it('counts per role, with the role target over the default, and volume_ok counts the roles at or above their target', async () => {
      rows.activePlans = [
        { role_id: 'R1', title: 'T1', priority: 'P0', target: null },        // default 5
        { role_id: 'R2', title: 'T2', priority: 'P3', target: 2 },           // own target 2
        { role_id: 'R3', title: 'T3', priority: 'P1', target: null },        // default 5, nobody qualified
      ];
      rows.volApps = [...[1, 2, 3, 4, 5].map(d => app('R1', d)), app('R1', 9), app('R2', 1), app('R2', 6)];     // R1: five in the last 7 days (the 9-day one is out)
      serve();
      const j = (await call('GET', '/queue')).json!;
      expect(j.volume).toEqual([
        { role_id: 'R1', title: 'T1', priority: 'P0', min: 5, qualified: 5 },
        { role_id: 'R2', title: 'T2', priority: 'P3', min: 2, qualified: 2 },
        { role_id: 'R3', title: 'T3', priority: 'P1', min: 5, qualified: 0 },
      ]);
      expect(j.volume_ok).toBe(2);
    });

    it('one short of the target is not ok; the settings decide the default target and the window', async () => {
      rows.activePlans = [{ role_id: 'R1', title: 'T1', priority: 'P1', target: null }];
      rows.volApps = [app('R1', 1), app('R1', 10)];
      h.loadSettings.mockResolvedValue({ ...DEFAULT_SOURCING_SETTINGS, volume_min_qualified: 2 });
      serve();
      expect((await call('GET', '/queue')).json).toMatchObject({ volume: [{ min: 2, qualified: 1 }], volume_ok: 0 });
      h.loadSettings.mockResolvedValue({ ...DEFAULT_SOURCING_SETTINGS, volume_min_qualified: 2, volume_window_days: 14 });
      expect((await call('GET', '/queue')).json).toMatchObject({ volume: [{ min: 2, qualified: 2 }], volume_ok: 1 });
    });

    it('the application lookback is 21 days before now', async () => {
      await call('GET', '/queue');
      const lookup = h.query.mock.calls.find(c => String(c[0]).includes('FROM applications a'))!;
      expect((lookup[1] as Date[])[0].toISOString()).toBe(new Date(NOW.getTime() - 21 * 86400000).toISOString());
    });
  });

  it('a failing read is a 500 that names the action and never the internal message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.query.mockRejectedValue(new Error('relation "sourcing_secret_table" does not exist'));
    const r = await call('GET', '/queue');
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'Loading the sourcing queue failed' });
    expect(r.text).not.toContain('sourcing_secret_table');
  });
});

describe('GET /plans/:roleId/advice', () => {
  it.each([['1', true], ['true', true], ['0', false], ['yes', false], ['', false]])('?refresh=%j asks for a new answer: %s', async (value, refresh) => {
    h.getAdvice.mockResolvedValue({ headline: 'h', steps: [] });
    await call('GET', `/plans/R9001/advice?refresh=${value}`);
    expect(h.getAdvice).toHaveBeenCalledWith('R9001', { refresh });
  });

  it('without the parameter it does not refresh', async () => {
    h.getAdvice.mockResolvedValue({ headline: 'h', steps: [] });
    const r = await call('GET', '/plans/R9001/advice');
    expect(r.json).toEqual({ enabled: true, advice: { headline: 'h', steps: [] } });
    expect(h.getAdvice).toHaveBeenCalledWith('R9001', { refresh: false });
  });
});
