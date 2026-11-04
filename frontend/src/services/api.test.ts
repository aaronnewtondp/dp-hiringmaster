import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import api, {
  authApi, rolesApi, candidatesApi, applicationsApi, interviewsApi, dashboardApi, sourcingApi, refChecksApi, usersApi, agenciesApi,
} from './api.ts';

// Nothing here touches the network: the axios instance's ADAPTER is replaced, so the request interceptor, the transforms and the response interceptor
// all run for real and only the wire is faked. (No HTTP-mocking dependency is needed.)
const originalAdapter = api.defaults.adapter;

interface Seen { method: string; url: string; params: unknown; body: unknown; query: string; authorization: string | null; responseType: string | undefined }
const seen: Seen[] = [];
let reply: (config: InternalAxiosRequestConfig) => AxiosResponse | AxiosError = ok();

function ok(data: unknown = { ok: true }) {
  return (config: InternalAxiosRequestConfig): AxiosResponse => ({ data, status: 200, statusText: 'OK', headers: {}, config });
}
/** An error response the way axios's own adapters produce one: the adapter REJECTS (the response interceptor sees it as `err`). */
function failing(status: number, data: unknown = { error: 'nope' }) {
  return (config: InternalAxiosRequestConfig): AxiosError => {
    const response: AxiosResponse = { data, status, statusText: String(status), headers: {}, config };
    return new AxiosError(`Request failed with status code ${status}`, status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST, config, undefined, response);
  };
}
const networkError = () => (config: InternalAxiosRequestConfig) => new AxiosError('Network Error', AxiosError.ERR_NETWORK, config);

beforeEach(() => {
  seen.length = 0;
  reply = ok();
  localStorage.clear();
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const uri = api.getUri(config);
    seen.push({
      method: String(config.method).toLowerCase(),
      url: String(config.url),
      params: config.params,
      body: typeof config.data === 'string' ? JSON.parse(config.data) : config.data,    // the transform has already serialised a JSON body by the time an adapter sees it
      query: uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : '',
      authorization: config.headers.has('Authorization') ? String(config.headers.get('Authorization')) : null,
      responseType: config.responseType,
    });
    const out = reply(config);
    if (out instanceof AxiosError) throw out;
    return out;
  };
});
afterEach(() => {
  api.defaults.adapter = originalAdapter;
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

const last = () => seen[seen.length - 1];

// ═══ Request interceptor: the bearer token ═══════════════════════════════════════════════════════════
describe('api — request interceptor (JWT)', () => {
  it('sends Authorization: Bearer <hms_token> on every request', async () => {
    localStorage.setItem('hms_token', 'tok-1');
    await api.get('/roles'); await api.post('/roles', {}); await rolesApi.get('R1');
    expect(seen).toHaveLength(3);
    for (const s of seen) expect(s.authorization).toBe('Bearer tok-1');
  });

  it('reads the token when the request is made, not when the module loaded (sign-in after load, token change, sign-out)', async () => {
    await api.get('/a');
    expect(last().authorization).toBeNull();
    localStorage.setItem('hms_token', 'tok-first');
    await api.get('/b');
    expect(last().authorization).toBe('Bearer tok-first');
    localStorage.setItem('hms_token', 'tok-second');
    await api.get('/c');
    expect(last().authorization).toBe('Bearer tok-second');
    localStorage.removeItem('hms_token');
    await api.get('/d');
    expect(last().authorization).toBeNull();
  });

  it('sends no Authorization header at all (not "Bearer null") when there is no token, or an empty one', async () => {
    await api.get('/x');
    expect(last().authorization).toBeNull();
    localStorage.setItem('hms_token', '');
    await api.get('/x');
    expect(last().authorization).toBeNull();
  });

  it('does not take the token from hms_user or anywhere else', async () => {
    localStorage.setItem('hms_user', JSON.stringify({ token: 'not-this', persona: 'hr_recruiter' }));
    sessionStorage.setItem('hms_token', 'not-this-either');
    await api.get('/x');
    expect(last().authorization).toBeNull();
  });

  it('every request is JSON by default', () => {
    expect(api.defaults.headers['Content-Type']).toBe('application/json');
  });
});

// ═══ Base URL ════════════════════════════════════════════════════════════════════════════════════════
describe('api — base URL', () => {
  // frontend/.env exists on a developer machine and not on a clean checkout, so the real value of VITE_API_URL is stubbed explicitly.
  const baseUrlWith = async (value: string) => {
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', value);
    return (await import('./api.ts')).default.defaults.baseURL;
  };
  it('is VITE_API_URL when it is set', async () => {
    expect(await baseUrlWith('https://api.example.test/api')).toBe('https://api.example.test/api');
  });
  it('falls back to the local backend when it is empty', async () => {
    expect(await baseUrlWith('')).toBe('http://localhost:4000/api');
  });
});

// ═══ Response interceptor: 401 ═══════════════════════════════════════════════════════════════════════
describe('api — response interceptor (401 = the session is over)', () => {
  const stubLocation = (href = '/roles/R1') => { const loc = { href }; vi.stubGlobal('location', loc); return loc; };
  const signedIn = () => { localStorage.setItem('hms_token', 'tok'); localStorage.setItem('hms_user', '{"persona":"hr_recruiter"}'); };

  it('a 401 removes hms_token and hms_user, sends the browser to /login and still rejects to the caller', async () => {
    const loc = stubLocation(); signedIn();
    reply = failing(401, { error: 'Invalid or expired token' });
    await expect(rolesApi.get('R1')).rejects.toMatchObject({ response: { status: 401, data: { error: 'Invalid or expired token' } } });
    expect(localStorage.getItem('hms_token')).toBeNull();
    expect(localStorage.getItem('hms_user')).toBeNull();
    expect(loc.href).toBe('/login');
  });

  it('removes only the two session keys', async () => {
    stubLocation(); signedIn();
    localStorage.setItem('hms:some.filter', '"kept"'); sessionStorage.setItem('hms:sourcing.role', '"R1"');
    reply = failing(401);
    await api.get('/x').catch(() => {});
    expect(localStorage.getItem('hms:some.filter')).toBe('"kept"');
    expect(sessionStorage.getItem('hms:sourcing.role')).toBe('"R1"');
  });

  it('a 401 on a write is handled the same way (it is the status that counts, not the verb)', async () => {
    const loc = stubLocation(); signedIn();
    reply = failing(401);
    await expect(applicationsApi.updateStatus('A1', { new_status: 'Hold for Future' })).rejects.toBeInstanceOf(AxiosError);
    expect(loc.href).toBe('/login');
    expect(localStorage.getItem('hms_token')).toBeNull();
  });

  // Every other failure leaves the session alone: a 403 is "you may not", not "you are not signed in".
  it.each([400, 403, 404, 409, 422, 429, 500, 502, 503])('a %i leaves the session and the page alone, and rejects to the caller', async status => {
    const loc = stubLocation('/candidates/C1'); signedIn();
    reply = failing(status);
    await expect(api.get('/x')).rejects.toMatchObject({ response: { status } });
    expect(localStorage.getItem('hms_token')).toBe('tok');
    expect(localStorage.getItem('hms_user')).toBe('{"persona":"hr_recruiter"}');
    expect(loc.href).toBe('/candidates/C1');
  });

  it('a network error (no response at all) leaves the session alone', async () => {
    const loc = stubLocation('/dashboard'); signedIn();
    reply = networkError();
    await expect(api.get('/x')).rejects.toMatchObject({ code: 'ERR_NETWORK' });
    expect(localStorage.getItem('hms_token')).toBe('tok');
    expect(loc.href).toBe('/dashboard');
  });

  it('a successful response is passed through untouched', async () => {
    const loc = stubLocation('/roles'); signedIn();
    reply = ok({ roles: [{ id: 'R1' }] });
    const res = await rolesApi.list();
    expect(res.data).toEqual({ roles: [{ id: 'R1' }] });
    expect(res.status).toBe(200);
    expect(localStorage.getItem('hms_token')).toBe('tok');
    expect(loc.href).toBe('/roles');
  });

  it('several requests failing with 401 at once all end with the session cleared and one destination', async () => {
    const loc = stubLocation(); signedIn();
    reply = failing(401);
    const results = await Promise.allSettled([api.get('/a'), api.get('/b'), api.get('/c')]);
    expect(results.map(r => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(loc.href).toBe('/login');
    expect(localStorage.getItem('hms_token')).toBeNull();
  });

  // Pinned as it is today, and worth knowing: the interceptor has no exemption for the sign-in calls themselves. The backend answers a bad credential with
  // 401 ('Invalid email or password' / 'Invalid Google credential', routes/auth.ts), so a failed sign-in navigates to /login — a full reload when the user is
  // already there — before Login.tsx's catch block can show that message. If /auth/* is ever exempted, change this test.
  it('TODAY: a 401 from the sign-in calls themselves redirects to /login as well', async () => {
    const loc = stubLocation('/login');
    reply = failing(401, { error: 'Invalid Google credential' });
    await expect(authApi.loginWithGoogle('bad-credential')).rejects.toMatchObject({ response: { data: { error: 'Invalid Google credential' } } });
    expect(loc.href).toBe('/login');
    expect(localStorage.getItem('hms_token')).toBeNull();
  });
});

// ═══ How array parameters are put on the URL ═════════════════════════════════════════════════════════
// api.ts's comments (rolesApi / candidatesApi / applicationsApi lists) say arrays are "serialized by axios as repeated keys". They are NOT: axios 1.x writes the
// bracket form, `key[]=a&key[]=b`, and Express's default `qs` parser reads that back as an array (it would read repeated keys too, so nothing is broken). What is
// pinned here is the REAL format, because anything that asserts on request URLs (Playwright, a proxy rule) has to match it: `gender[]=UNKNOWN`, never
// `gender=UNKNOWN`. Brackets are percent-encoded (%5B%5D) and a space is `+`.
describe('api — query-string serialisation of params', () => {
  const sent = async (call: () => Promise<unknown>) => { await call(); return decodeURIComponent(last().query.replace(/\+/g, ' ')); };

  it('an array becomes key[]=a&key[]=b (bracket form, NOT repeated keys)', async () => {
    await rolesApi.list({ status: ['Approved', 'Live – Sourcing'] });
    expect(last().query).toBe('status%5B%5D=Approved&status%5B%5D=Live+%E2%80%93+Sourcing');
    expect(last().query).not.toMatch(/(^|&)status=/);
  });

  it('a one-element array is still an array (or_role_id[]=R019), which is what tells the server it is a list', async () => {
    expect(await sent(() => applicationsApi.list({ founder_flag: 'true', or_role_id: ['R019'], limit: '500' }))).toBe('founder_flag=true&or_role_id[]=R019&limit=500');
  });

  it('the Gender filter\'s "Not tagged" sentinel travels as gender[]=UNKNOWN, alone or with another value', async () => {
    expect(await sent(() => applicationsApi.list({ gender: ['UNKNOWN'] }))).toBe('gender[]=UNKNOWN');
    expect(await sent(() => applicationsApi.list({ gender: ['M', 'UNKNOWN'] }))).toBe('gender[]=M&gender[]=UNKNOWN');
  });

  it('several array params each keep their own key, in the order given', async () => {
    expect(await sent(() => applicationsApi.list({ role_id: ['R1', 'R2'], gender: ['F'], q: 'qa' }))).toBe('role_id[]=R1&role_id[]=R2&gender[]=F&q=qa');
  });

  it('the same format on every helper that takes params', async () => {
    expect(await sent(() => candidatesApi.list({ skills: ['water', 'scada'] }))).toBe('skills[]=water&skills[]=scada');
    expect(await sent(() => dashboardApi.get({ role_id: ['R1'], department: ['Engineering', 'HR'] }))).toBe('role_id[]=R1&department[]=Engineering&department[]=HR');
    expect(await sent(() => dashboardApi.funnelSnapshot({ role_id: ['R1', 'R2'] }))).toBe('role_id[]=R1&role_id[]=R2');
    expect(await sent(() => dashboardApi.slaByRole({ priority: ['P0'] }))).toBe('priority[]=P0');
    expect(await sent(() => sourcingApi.dashboard({ role_id: ['R3', 'R4'] }))).toBe('role_id[]=R3&role_id[]=R4');
  });

  it('a plain string stays plain; spaces become + and reserved characters are escaped', async () => {
    await applicationsApi.list({ q: 'a b&c=d', limit: '100' });
    expect(last().query).toBe('q=a+b%26c%3Dd&limit=100');
  });

  it('undefined, null and an empty array are left out; an empty string is kept (as key=)', async () => {
    await api.get('/x', { params: { a: undefined, b: null, c: [], d: '', e: 'kept' } });
    expect(last().query).toBe('d=&e=kept');
  });

  it('no params, no query string', async () => {
    await rolesApi.list();
    expect(last().query).toBe('');
    await rolesApi.list({});
    expect(last().query).toBe('');
  });

  it('the named single-value helpers put their one param on the query', async () => {
    expect(await sent(() => interviewsApi.list('A0001'))).toBe('application_id=A0001');
    expect(await sent(() => refChecksApi.list('A0001'))).toBe('application_id=A0001');
    expect(await sent(() => candidatesApi.unmatched({ limit: '50', offset: '50' }))).toBe('limit=50&offset=50');
    expect(await sent(() => sourcingApi.advice('R1', true))).toBe('refresh=1');
    expect(await sent(() => sourcingApi.advice('R1'))).toBe('');
    expect(await sent(() => sourcingApi.advice('R1', false))).toBe('');
  });
});

// ═══ Every helper: method, path, body ════════════════════════════════════════════════════════════════
// The frontend half of the contract with the backend routers (server.ts mounts them under /api). A typo in a path, a swapped verb or a renamed body field
// would otherwise only show up as a 404 or a silently ignored field in a browser.
type Row = [name: string, call: () => Promise<unknown>, expected: { method: string; url: string; body?: unknown; params?: unknown; responseType?: string }];
const ROWS: Row[] = [
  // authApi
  ['authApi.login', () => authApi.login('a@example.test', 'pw'), { method: 'post', url: '/auth/login', body: { email: 'a@example.test', password: 'pw' } }],
  ['authApi.loginWithGoogle', () => authApi.loginWithGoogle('cred'), { method: 'post', url: '/auth/google', body: { credential: 'cred' } }],
  ['authApi.me', () => authApi.me(), { method: 'get', url: '/auth/me' }],
  ['authApi.logout', () => authApi.logout(), { method: 'post', url: '/auth/logout' }],
  // rolesApi
  ['rolesApi.list', () => rolesApi.list({ status: 'Approved' }), { method: 'get', url: '/roles', params: { status: 'Approved' } }],
  ['rolesApi.get', () => rolesApi.get('R001'), { method: 'get', url: '/roles/R001' }],
  ['rolesApi.create', () => rolesApi.create({ title: 'T' }), { method: 'post', url: '/roles', body: { title: 'T' } }],
  ['rolesApi.update', () => rolesApi.update('R001', { status: 'Approved' }), { method: 'patch', url: '/roles/R001', body: { status: 'Approved' } }],
  ['rolesApi.remove', () => rolesApi.remove('R001'), { method: 'delete', url: '/roles/R001' }],
  ['rolesApi.editLog', () => rolesApi.editLog('R001'), { method: 'get', url: '/roles/R001/edit-log' }],
  ['rolesApi.activity', () => rolesApi.activity('R001'), { method: 'get', url: '/roles/R001/activity' }],
  ['rolesApi.pipeline', () => rolesApi.pipeline('R001'), { method: 'get', url: '/roles/R001/pipeline' }],
  ['rolesApi.compBenchmark', () => rolesApi.compBenchmark('R001'), { method: 'get', url: '/roles/R001/comp-benchmark' }],
  ['rolesApi.filterOptions', () => rolesApi.filterOptions(), { method: 'get', url: '/roles/filter-options' }],
  ['rolesApi.closureSummaryPdf', () => rolesApi.closureSummaryPdf('R001'), { method: 'get', url: '/roles/R001/closure-summary.pdf', responseType: 'blob' }],
  ['rolesApi.regenerateJd', () => rolesApi.regenerateJd('R001'), { method: 'post', url: '/roles/R001/regenerate-jd', body: {} }],
  // candidatesApi
  ['candidatesApi.list', () => candidatesApi.list({ q: 'x' }), { method: 'get', url: '/candidates', params: { q: 'x' } }],
  ['candidatesApi.get', () => candidatesApi.get('C0001'), { method: 'get', url: '/candidates/C0001' }],
  ['candidatesApi.create', () => candidatesApi.create({ full_name: 'N' }), { method: 'post', url: '/candidates', body: { full_name: 'N' } }],
  ['candidatesApi.update', () => candidatesApi.update('C0001', { gender: 'F' }), { method: 'patch', url: '/candidates/C0001', body: { gender: 'F' } }],
  ['candidatesApi.activity', () => candidatesApi.activity('C0001'), { method: 'get', url: '/candidates/C0001/activity' }],
  ['candidatesApi.linkRole', () => candidatesApi.linkRole('C0001', { role_id: 'R001', source_channel: 'Job Application Form' }), { method: 'post', url: '/candidates/C0001/applications', body: { role_id: 'R001', source_channel: 'Job Application Form' } }],
  ['candidatesApi.remove', () => candidatesApi.remove('C0001'), { method: 'delete', url: '/candidates/C0001' }],
  ['candidatesApi.unmatched', () => candidatesApi.unmatched({ limit: '50' }), { method: 'get', url: '/candidates/unmatched', params: { limit: '50' } }],
  // applicationsApi
  ['applicationsApi.list', () => applicationsApi.list({ limit: '100' }), { method: 'get', url: '/applications', params: { limit: '100' } }],
  ['applicationsApi.get', () => applicationsApi.get('A0001'), { method: 'get', url: '/applications/A0001' }],
  ['applicationsApi.advanceStage (stage only)', () => applicationsApi.advanceStage('A0001', 'Interview Round 1'), { method: 'post', url: '/applications/A0001/stage', body: { new_stage: 'Interview Round 1' } }],
  ['applicationsApi.advanceStage (all options)', () => applicationsApi.advanceStage('A0001', 'Offer Released', { skipReason: 'Referral', budgetExceptionReasonCat: 'Critical hire', budgetExceptionReasonDetail: 'Approved by leadership' }),
    { method: 'post', url: '/applications/A0001/stage', body: { new_stage: 'Offer Released', skip_reason: 'Referral', budget_exception_reason_cat: 'Critical hire', budget_exception_reason_detail: 'Approved by leadership' } }],
  ['applicationsApi.updateStatus', () => applicationsApi.updateStatus('A0001', { new_status: 'Rejected', rejection_reason_cats: ['Skills gap'] }), { method: 'post', url: '/applications/A0001/status', body: { new_status: 'Rejected', rejection_reason_cats: ['Skills gap'] } }],
  ['applicationsApi.updateScreening', () => applicationsApi.updateScreening('A0001', 'HM Shortlisted'), { method: 'post', url: '/applications/A0001/screening', body: { new_screening_status: 'HM Shortlisted' } }],
  ['applicationsApi.updateNotes', () => applicationsApi.updateNotes('A0001', { internal_risk_notes: 'n' }), { method: 'patch', url: '/applications/A0001/notes', body: { internal_risk_notes: 'n' } }],
  ['applicationsApi.setFounderFlag (set)', () => applicationsApi.setFounderFlag('A0001', true, 'Look at this one'), { method: 'post', url: '/applications/A0001/founder-flag', body: { set: true, note: 'Look at this one' } }],
  ['applicationsApi.setFounderFlag (clear)', () => applicationsApi.setFounderFlag('A0001', false), { method: 'post', url: '/applications/A0001/founder-flag', body: { set: false } }],
  ['applicationsApi.retryScoring', () => applicationsApi.retryScoring('A0001'), { method: 'post', url: '/applications/A0001/retry-scoring', body: {} }],
  ['applicationsApi.portfolioReview', () => applicationsApi.portfolioReview('A0001'), { method: 'get', url: '/applications/A0001/portfolio-analysis' }],
  ['applicationsApi.rerunPortfolio', () => applicationsApi.rerunPortfolio('A0001'), { method: 'post', url: '/applications/A0001/portfolio-analysis', body: {} }],
  // interviewsApi
  ['interviewsApi.list', () => interviewsApi.list('A0001'), { method: 'get', url: '/interviews', params: { application_id: 'A0001' } }],
  ['interviewsApi.schedule', () => interviewsApi.schedule({ application_id: 'A0001' }), { method: 'post', url: '/interviews', body: { application_id: 'A0001' } }],
  ['interviewsApi.feedback', () => interviewsApi.feedback('IR0001', { rating: 4 }), { method: 'patch', url: '/interviews/IR0001/feedback', body: { rating: 4 } }],
  ['interviewsApi.sendAssignment', () => interviewsApi.sendAssignment('IR0001', { cc: [] }), { method: 'post', url: '/interviews/IR0001/assignment-send', body: { cc: [] } }],
  ['interviewsApi.submitAssignment', () => interviewsApi.submitAssignment('IR0001', 'https://example.test/work'), { method: 'post', url: '/interviews/IR0001/assignment-submit', body: { submission_link: 'https://example.test/work' } }],
  // dashboardApi
  ['dashboardApi.get', () => dashboardApi.get({ role_id: ['R1'] }), { method: 'get', url: '/dashboard', params: { role_id: ['R1'] } }],
  ['dashboardApi.pending', () => dashboardApi.pending(), { method: 'get', url: '/dashboard/pending' }],
  ['dashboardApi.funnelSnapshot', () => dashboardApi.funnelSnapshot(), { method: 'get', url: '/dashboard/funnel-snapshot' }],
  ['dashboardApi.slaByRole', () => dashboardApi.slaByRole(), { method: 'get', url: '/dashboard/sla-by-role' }],
  // sourcingApi
  ['sourcingApi.status', () => sourcingApi.status(), { method: 'get', url: '/sourcing/status' }],
  ['sourcingApi.people', () => sourcingApi.people(), { method: 'get', url: '/sourcing/people' }],
  ['sourcingApi.plan', () => sourcingApi.plan('R001'), { method: 'get', url: '/sourcing/plans/R001' }],
  ['sourcingApi.activate', () => sourcingApi.activate('9', { channels: [] }), { method: 'post', url: '/sourcing/plans/9/activate', body: { channels: [] } }],
  ['sourcingApi.updatePlan', () => sourcingApi.updatePlan('9', { strategy_note: 's' }), { method: 'patch', url: '/sourcing/plans/9', body: { strategy_note: 's' } }],
  ['sourcingApi.setChannel', () => sourcingApi.setChannel('9', { channel: 'LinkedIn', state: 'planned' }), { method: 'put', url: '/sourcing/plans/9/channel', body: { channel: 'LinkedIn', state: 'planned' } }],
  ['sourcingApi.completeCommitment', () => sourcingApi.completeCommitment('5', { attest: true }), { method: 'post', url: '/sourcing/commitments/5/complete', body: { attest: true } }],
  ['sourcingApi.skipCommitment', () => sourcingApi.skipCommitment('5', 'Not needed'), { method: 'post', url: '/sourcing/commitments/5/skip', body: { reason: 'Not needed' } }],
  ['sourcingApi.reopenCommitment', () => sourcingApi.reopenCommitment('5'), { method: 'post', url: '/sourcing/commitments/5/reopen', body: {} }],
  ['sourcingApi.resolveException', () => sourcingApi.resolveException('5', { path: 'catch_up' }), { method: 'post', url: '/sourcing/exceptions/5/resolve', body: { path: 'catch_up' } }],
  ['sourcingApi.workspace', () => sourcingApi.workspace(), { method: 'get', url: '/sourcing/workspace' }],
  ['sourcingApi.advice', () => sourcingApi.advice('R001', true), { method: 'get', url: '/sourcing/plans/R001/advice', params: { refresh: '1' } }],
  ['sourcingApi.closeChannel', () => sourcingApi.closeChannel('9', 'Naukri/IIMjobs', 'Done'), { method: 'post', url: '/sourcing/plans/9/channel/close', body: { channel: 'Naukri/IIMjobs', reason: 'Done' } }],
  ['sourcingApi.reopenChannel', () => sourcingApi.reopenChannel('9', 'Naukri/IIMjobs'), { method: 'post', url: '/sourcing/plans/9/channel/reopen', body: { channel: 'Naukri/IIMjobs' } }],
  ['sourcingApi.updateChannel', () => sourcingApi.updateChannel('9', { channel: 'LinkedIn', weekly_target: 5 }), { method: 'patch', url: '/sourcing/plans/9/channel-settings', body: { channel: 'LinkedIn', weekly_target: 5 } }],
  ['sourcingApi.queue', () => sourcingApi.queue(), { method: 'get', url: '/sourcing/queue' }],
  ['sourcingApi.dashboard', () => sourcingApi.dashboard({ role_id: ['R1'] }), { method: 'get', url: '/dashboard/sourcing', params: { role_id: ['R1'] } }],
  // refChecksApi, usersApi, agenciesApi
  ['refChecksApi.list', () => refChecksApi.list('A0001'), { method: 'get', url: '/ref-checks', params: { application_id: 'A0001' } }],
  ['refChecksApi.create', () => refChecksApi.create({ application_id: 'A0001' }), { method: 'post', url: '/ref-checks', body: { application_id: 'A0001' } }],
  ['usersApi.list', () => usersApi.list(), { method: 'get', url: '/users' }],
  ['usersApi.create', () => usersApi.create({ email: 'u@example.test' }), { method: 'post', url: '/users', body: { email: 'u@example.test' } }],
  ['usersApi.update', () => usersApi.update('u1', { is_active: false }), { method: 'patch', url: '/users/u1', body: { is_active: false } }],
  ['agenciesApi.list', () => agenciesApi.list(), { method: 'get', url: '/agencies' }],
  ['agenciesApi.get', () => agenciesApi.get('AGN001'), { method: 'get', url: '/agencies/AGN001' }],
  ['agenciesApi.create', () => agenciesApi.create({ name: 'A' }), { method: 'post', url: '/agencies', body: { name: 'A' } }],
  ['agenciesApi.update', () => agenciesApi.update('AGN001', { name: 'B' }), { method: 'patch', url: '/agencies/AGN001', body: { name: 'B' } }],
];

describe('api — every helper calls the route the backend serves', () => {
  it.each(ROWS)('%s', async (_name, call, expected) => {
    await call();
    expect(seen).toHaveLength(1);
    expect({ method: last().method, url: last().url, params: last().params, body: last().body, responseType: last().responseType })
      .toEqual({ method: expected.method, url: expected.url, params: expected.params, body: expected.body, responseType: expected.responseType });
  });

  it('the table lists every exported helper (adding a helper without a row here fails)', () => {
    const apis = { authApi, rolesApi, candidatesApi, applicationsApi, interviewsApi, dashboardApi, sourcingApi, refChecksApi, usersApi, agenciesApi };
    const covered = new Set(ROWS.map(([name]) => name.split(' ')[0]));
    const missing: string[] = [];
    for (const [ns, obj] of Object.entries(apis)) for (const fn of Object.keys(obj)) if (!covered.has(`${ns}.${fn}`)) missing.push(`${ns}.${fn}`);
    expect(missing).toEqual([]);
  });

  it('a channel name never goes into the URL path ("Naukri/IIMjobs" contains a slash): it is in the body', async () => {
    await sourcingApi.closeChannel('9', 'Naukri/IIMjobs', 'r');
    await sourcingApi.reopenChannel('9', 'Naukri/IIMjobs');
    await sourcingApi.setChannel('9', { channel: 'Naukri/IIMjobs' });
    for (const s of seen) { expect(s.url).not.toContain('Naukri'); expect(s.url).not.toContain('IIMjobs'); }
    expect(seen.map(s => (s.body as { channel: string }).channel)).toEqual(['Naukri/IIMjobs', 'Naukri/IIMjobs', 'Naukri/IIMjobs']);
  });

  it('the PDF download asks for a Blob; no other helper sets a responseType', async () => {
    await rolesApi.closureSummaryPdf('R001');
    expect(last().responseType).toBe('blob');
    expect(ROWS.filter(([, , e]) => e.responseType).map(([n]) => n)).toEqual(['rolesApi.closureSummaryPdf']);
  });

  it('advanceStage leaves the optional fields OUT of the body when they are not given (they are not sent as null)', async () => {
    await applicationsApi.advanceStage('A0001', 'Founders Round', { skipReason: undefined });
    expect(last().body).toEqual({ new_stage: 'Founders Round' });
    expect(Object.keys(last().body as object)).toEqual(['new_stage']);
  });
});
