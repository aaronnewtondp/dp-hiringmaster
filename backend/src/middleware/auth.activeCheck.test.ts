import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { authenticate, invalidateUserAccess, ACCESS_CACHE_TTL_MS, ACCESS_CACHE_MAX_ENTRIES } from './auth.js';
import { fakeDb } from '../test/fakeDb.js';
import { ApiClient, TEST_JWT_SECRET, TEST_USERS, buildApp, setEnv, SMOKE_USER } from '../test/routeHarness.js';
import usersRouter from '../routes/users.js';

// authenticate() confirms, after the JWT is verified, that the user still exists and is_active (otherwise a deactivated user
// keeps access for the token's whole 24 h). The database is the shared fake; its access lookup is counted in fakeDb.accessLookups.
vi.mock('../db/index.js', async () => (await import('../test/fakeDb.js')).dbModule());

const SECRET = 'active-check-secret';
const claims = (userId = 'U1') => ({ userId, email: 'person@example.test', name: 'Test Person', persona: 'hr_recruiter' });

async function call(userId = 'U1', method = 'GET', payload: object = claims(userId)) {
  const token = jwt.sign(payload, SECRET, { expiresIn: '1h' });
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const req = { headers: { authorization: `Bearer ${token}` }, method } as unknown as Request;
  const next = vi.fn();
  await authenticate(req, { status, headersSent: false } as unknown as Response, next);
  return { next, status: status.mock.calls.map(c => c[0]), body: json.mock.calls.map(c => c[0]), req };
}

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = setEnv({ JWT_SECRET: SECRET });
  fakeDb.reset();
  invalidateUserAccess();
});
afterEach(() => { vi.useRealTimers(); restoreEnv(); });

describe('authenticate — the account must still be active', () => {
  it('an active user passes, with exactly one lookup by the token\'s userId', async () => {
    const r = await call('U1');
    expect(r.next).toHaveBeenCalledTimes(1);
    expect(r.status).toEqual([]);
    expect(fakeDb.accessLookups).toBe(1);
  });

  it('a deactivated user is refused 401 with the message, and next is not called', async () => {
    fakeDb.setUserAccess('U1', 'inactive');
    const r = await call('U1');
    expect(r.next).not.toHaveBeenCalled();
    expect([r.status, r.body]).toEqual([[401], [{ error: 'Account is deactivated or no longer exists' }]]);
  });

  it('a user with no row is refused the same way', async () => {
    fakeDb.setUserAccess('U1', 'missing');
    const r = await call('U1');
    expect(r.next).not.toHaveBeenCalled();
    expect([r.status, r.body]).toEqual([[401], [{ error: 'Account is deactivated or no longer exists' }]]);
  });

  it('a database error fails CLOSED with 503, leaks nothing, and next is not called', async () => {
    fakeDb.setUserAccess('U1', 'error');
    const r = await call('U1');
    expect(r.next).not.toHaveBeenCalled();
    expect([r.status, r.body]).toEqual([[503], [{ error: 'Could not verify account status' }]]);
  });

  it('a database error is not cached: the next request asks again and gets in once the database is back', async () => {
    fakeDb.setUserAccess('U1', 'error');
    expect((await call('U1')).status).toEqual([503]);
    fakeDb.setUserAccess('U1', 'active');
    expect((await call('U1')).next).toHaveBeenCalledTimes(1);
    expect(fakeDb.accessLookups).toBe(2);
  });

  it('a refused account does not leave a trusted req.user behind', async () => {
    fakeDb.setUserAccess('U1', 'inactive');
    expect((await call('U1')).req.user).toBeUndefined();
  });

  it('never leaves the request hanging: an unexpected throw is answered 500', async () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const req = { get headers(): never { throw new Error('boom'); } } as unknown as Request;
    await authenticate(req, { status, headersSent: false } as unknown as Response, vi.fn());
    expect(status).toHaveBeenCalledTimes(1);
    expect(status.mock.calls[0][0]).toBe(500);
  });
});

describe('authenticate — the 15 s cache', () => {
  it('a second request inside the TTL does not query again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T10:00:00Z'));
    await call('U1');
    vi.setSystemTime(new Date(Date.now() + ACCESS_CACHE_TTL_MS - 1));
    await call('U1');
    expect(fakeDb.accessLookups).toBe(1);
  });

  it('asks again once the TTL (15 s) has passed, and then sees a deactivation', async () => {
    expect(ACCESS_CACHE_TTL_MS).toBe(15_000);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T10:00:00Z'));
    expect((await call('U1')).next).toHaveBeenCalledTimes(1);
    fakeDb.setUserAccess('U1', 'inactive');
    vi.setSystemTime(new Date(Date.now() + ACCESS_CACHE_TTL_MS - 1));
    expect((await call('U1')).next).toHaveBeenCalledTimes(1);   // still the cached answer
    vi.setSystemTime(new Date(Date.now() + 2));
    const r = await call('U1');
    expect(r.status).toEqual([401]);
    expect(fakeDb.accessLookups).toBe(2);
  });

  it('invalidateUserAccess(userId) makes a deactivation visible immediately, for that user only', async () => {
    await call('U1'); await call('U2');
    fakeDb.setUserAccess('U1', 'inactive'); fakeDb.setUserAccess('U2', 'inactive');
    invalidateUserAccess('U1');
    expect((await call('U1')).status).toEqual([401]);
    expect((await call('U2')).next).toHaveBeenCalledTimes(1);   // U2 still cached
  });

  it('invalidateUserAccess() with no argument clears everyone', async () => {
    await call('U1'); await call('U2');
    fakeDb.setUserAccess('U1', 'inactive'); fakeDb.setUserAccess('U2', 'inactive');
    invalidateUserAccess();
    expect((await call('U1')).status).toEqual([401]);
    expect((await call('U2')).status).toEqual([401]);
  });

  it('is capped: past the limit the oldest entry is dropped (and so asked about again), the cache never grows without bound', async () => {
    for (let i = 0; i < ACCESS_CACHE_MAX_ENTRIES; i++) await call(`C${i}`);
    expect(fakeDb.accessLookups).toBe(ACCESS_CACHE_MAX_ENTRIES);
    await call('C0');                                   // still cached
    expect(fakeDb.accessLookups).toBe(ACCESS_CACHE_MAX_ENTRIES);
    await call('OVERFLOW');                             // evicts the oldest (C0)
    expect(fakeDb.accessLookups).toBe(ACCESS_CACHE_MAX_ENTRIES + 1);
    await call('C0');                                   // evicted → looked up again
    expect(fakeDb.accessLookups).toBe(ACCESS_CACHE_MAX_ENTRIES + 2);
    await call(`C${ACCESS_CACHE_MAX_ENTRIES - 1}`);     // a young entry is still cached (the cap evicts one, not all)
    expect(fakeDb.accessLookups).toBe(ACCESS_CACHE_MAX_ENTRIES + 2);
  });
});

describe('authenticate — an invalidation that lands while a lookup is in flight', () => {
  it('is not undone by that lookup: its (possibly stale) answer serves its own request but is never cached', async () => {
    const inFlight = call('U1');                    // the lookup has started and has read "active"
    invalidateUserAccess('U1');                     // ...the PATCH commits and invalidates before the lookup finishes
    expect((await inFlight).next).toHaveBeenCalledTimes(1);
    fakeDb.setUserAccess('U1', 'inactive');
    const r = await call('U1');                     // must ask again, not read a stale "active" for a full TTL
    expect(r.status).toEqual([401]);
    expect(fakeDb.accessLookups).toBe(2);
  });
});

describe('authenticate — a token without a usable userId', () => {
  it.each([[undefined], [''], [42], [{ id: 'U1' }]])('is refused 401 before any lookup (userId=%j)', async (userId) => {
    const r = await call('U1', 'GET', { ...claims(), userId });
    expect(r.status).toEqual([401]);
    expect(r.next).not.toHaveBeenCalled();
    expect(fakeDb.accessLookups).toBe(0);
  });
});

describe('authenticate — smoke accounts are refused before any database lookup', () => {
  it('a smoke POST is 403 and the database is never asked', async () => {
    const r = await call('U9099', 'POST', { ...claims('U9099'), email: 'smoke.hm@hms-smoke.invalid' });
    expect(r.status).toEqual([403]);
    expect(r.next).not.toHaveBeenCalled();
    expect(fakeDb.accessLookups).toBe(0);
    expect(fakeDb.untouched()).toBe(true);
  });
});

describe('PATCH /api/users/:id invalidates the edited user\'s cached access', () => {
  const api = new ApiClient(buildApp(app => app.use('/api/users', usersRouter)));
  let restore: () => void;
  beforeAll(async () => { await api.start(); });
  afterAll(async () => { await api.stop(); });
  beforeEach(() => { restore = setEnv({ JWT_SECRET: TEST_JWT_SECRET }); });
  afterEach(() => restore());

  it('a user deactivated through the route is refused on the very next request, with no wait for the TTL', async () => {
    const victim = { ...TEST_USERS.hr_recruiter, userId: 'U7001' };
    expect((await api.get('/api/users', { as: victim })).status).toBe(403);   // authenticated (reaches the persona guard), and now cached active
    expect(fakeDb.accessLookups).toBe(1);

    fakeDb.whenOne(/^UPDATE users SET is_active=\$1 WHERE id=\$2/, { id: 'U7001', is_active: false });
    fakeDb.setUserAccess('U7001', 'inactive');
    const patch = await api.patch('/api/users/U7001', { as: 'super_admin', body: { is_active: false } });
    expect(patch.status).toBe(200);

    const after = await api.get('/api/users', { as: victim });
    expect([after.status, after.body]).toEqual([401, { error: 'Account is deactivated or no longer exists' }]);
  });

  it('a PATCH that finds no such user does not claim anything changed (404, cache untouched)', async () => {
    const victim = { ...TEST_USERS.hr_recruiter, userId: 'U7002' };
    await api.get('/api/users', { as: victim });
    fakeDb.setUserAccess('U7002', 'inactive');
    fakeDb.whenOne(/^UPDATE users SET/, null);
    expect((await api.patch('/api/users/U7002', { as: 'super_admin', body: { is_active: false } })).status).toBe(404);
    expect((await api.get('/api/users', { as: victim })).status).toBe(403);   // still the cached "active" answer
  });

  it('smoke account on the same route: 403 and no lookup', async () => {
    const before = fakeDb.accessLookups;
    expect((await api.patch('/api/users/U7003', { as: SMOKE_USER, body: { is_active: false } })).status).toBe(403);
    expect(fakeDb.accessLookups).toBe(before);
  });
});
