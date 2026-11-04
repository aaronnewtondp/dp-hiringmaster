// First, before any router is imported: express-async-errors patches Express's Layer when a route is CREATED, so a router
// loaded earlier would leave a rejected handler as an unhandled rejection and the request hanging instead of a 500.
import 'express-async-errors';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// routes/auth.ts — the two ways in. POST /google is the only production login path (every real account is Google-only);
// POST /login is how local Docker's seeded users and the two read-only production smoke accounts sign in.
// The real router and the real jwt/bcrypt run; Google's token verification and the database are replaced.

const google = vi.hoisted(() => ({ verifyIdToken: vi.fn(), clientIds: [] as unknown[] }));
vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    constructor(clientId?: unknown) { google.clientIds.push(clientId); }
    verifyIdToken = google.verifyIdToken;
  },
}));
vi.mock('../db/index.js', async () => (await import('../test/fakeDb.js')).dbModule());

import authRouter from './auth.js';
import { fakeDb } from '../test/fakeDb.js';
import { ApiClient, TEST_JWT_SECRET, buildApp, setEnv } from '../test/routeHarness.js';

const api = new ApiClient(buildApp(app => app.use('/api/auth', authRouter)));
let restoreEnv: () => void = () => undefined;

const CLIENT_ID = 'test-client-id.apps.example.test';
const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

// A user row as `SELECT * FROM users` returns it. The HMS name deliberately differs from the Google display name below.
const USER = {
  id: 'U9001', name: 'HMS Recruiter Name', email: 'test.recruiter@digitalpaani.com', persona: 'hr_recruiter', department: 'People',
  password_hash: PASSWORD_HASH as string | null, google_id: null as string | null, avatar_url: null as string | null,
  auth_provider: 'email', is_active: true,
};
const GOOGLE_PAYLOAD = { email: 'test.recruiter@digitalpaani.com', sub: 'google-sub-1', name: 'Google Display Name', picture: 'https://pics.example.test/a.png', hd: 'digitalpaani.com', email_verified: true };

const USER_LOOKUP = /^SELECT \* FROM users WHERE email = \$1 AND is_active = true$/;
const LAST_LOGIN_ONLY = /^UPDATE users SET last_login = NOW\(\) WHERE id = \$1$/;
const LINK_GOOGLE = /^UPDATE users SET google_id = \$1, avatar_url = \$2, auth_provider = CASE WHEN password_hash IS NOT NULL THEN 'both' ELSE 'google' END, last_login = NOW\(\) WHERE id = \$3$/;

beforeAll(async () => { await api.start(); });
afterAll(async () => { await api.stop(); });
beforeEach(() => {
  fakeDb.reset();
  google.verifyIdToken.mockReset().mockResolvedValue({ getPayload: () => ({ ...GOOGLE_PAYLOAD }) });
  restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET, GOOGLE_CLIENT_ID: CLIENT_ID, JWT_EXPIRES_IN: undefined });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { restoreEnv(); vi.restoreAllMocks(); });

const decode = (token: string) => jwt.verify(token, TEST_JWT_SECRET) as jwt.JwtPayload & { userId: string; email: string; persona: string; name: string };
const lifetime = (token: string) => { const p = decode(token); return p.exp! - p.iat!; };

// ─── POST /login ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('POST /api/auth/login', () => {
  const login = (body: unknown) => api.post('/api/auth/login', { body });

  it.each([
    ['nothing', {}], ['no password', { email: 'a@example.test' }], ['no email', { password: 'x' }],
    ['both empty', { email: '', password: '' }], ['an empty password', { email: 'a@example.test', password: '' }],
  ])('%s → 400 "Email and password required", and the database is not asked', async (_name, body) => {
    const res = await login(body);
    expect([res.status, res.body]).toEqual([400, { error: 'Email and password required' }]);
    expect(fakeDb.untouched()).toBe(true);
  });

  it('looks the user up by the LOWER-CASED address among active users only', async () => {
    await login({ email: 'Test.Recruiter@DigitalPaani.COM', password: PASSWORD });
    const lookup = fakeDb.one(USER_LOOKUP);
    expect(lookup.params).toEqual(['test.recruiter@digitalpaani.com']);
  });

  it('an unknown or deactivated user → 401 "Invalid email or password", with no write', async () => {
    fakeDb.when(USER_LOOKUP, []);
    const res = await login({ email: 'nobody@example.test', password: PASSWORD });
    expect([res.status, res.body]).toEqual([401, { error: 'Invalid email or password' }]);
    expect(fakeDb.writes()).toEqual([]);
  });

  it('a Google-only account (no password hash) → 400 telling the person to use Google, with no write', async () => {
    fakeDb.whenOne(USER_LOOKUP, { ...USER, password_hash: null });
    const res = await login({ email: USER.email, password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uses Google sign-in/);
    expect(res.body.token).toBeUndefined();
    expect(fakeDb.writes()).toEqual([]);
  });

  it('a wrong password → 401 with the same message as an unknown user (nothing to tell the two apart), no token, no write', async () => {
    fakeDb.whenOne(USER_LOOKUP, USER);
    const res = await login({ email: USER.email, password: `${PASSWORD}!` });
    expect([res.status, res.body]).toEqual([401, { error: 'Invalid email or password' }]);
    expect(fakeDb.writes()).toEqual([]);
  });

  it('the right password → 200 with a token and the public part of the user, and last_login is stamped for that user', async () => {
    fakeDb.whenOne(USER_LOOKUP, { ...USER, avatar_url: 'https://pics.example.test/me.png' });
    const res = await login({ email: USER.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: 'U9001', name: 'HMS Recruiter Name', email: USER.email, persona: 'hr_recruiter', department: 'People', avatar_url: 'https://pics.example.test/me.png',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|google_id/i);
    expect(fakeDb.one(LAST_LOGIN_ONLY).params).toEqual(['U9001']);
    expect(fakeDb.writes()).toHaveLength(1);
  });

  it('the token carries userId, email, persona and users.name — the four keys every guard and Hiring Manager rule reads — and lives 24 hours by default', async () => {
    fakeDb.whenOne(USER_LOOKUP, USER);
    const { body } = await login({ email: USER.email, password: PASSWORD });
    const payload = decode(body.token);
    expect({ userId: payload.userId, email: payload.email, persona: payload.persona, name: payload.name })
      .toEqual({ userId: 'U9001', email: USER.email, persona: 'hr_recruiter', name: 'HMS Recruiter Name' });
    expect(lifetime(body.token)).toBe(24 * 60 * 60);
  });

  it('JWT_EXPIRES_IN sets the lifetime', async () => {
    fakeDb.whenOne(USER_LOOKUP, USER);
    restoreEnv(); restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET, JWT_EXPIRES_IN: '2h' });
    const { body } = await login({ email: USER.email, password: PASSWORD });
    expect(lifetime(body.token)).toBe(2 * 60 * 60);
  });

  it('the token\'s email and persona come from the database row, not from what was typed or sent', async () => {
    fakeDb.whenOne(USER_LOOKUP, { ...USER, persona: 'leadership' });
    const { body } = await login({ email: 'TEST.RECRUITER@DIGITALPAANI.COM', password: PASSWORD, persona: 'super_admin' });
    const payload = decode(body.token);
    expect([payload.email, payload.persona]).toEqual([USER.email, 'leadership']);
  });

  it('a token it issued is accepted by the next request (GET /me), and the same token without the header is not', async () => {
    fakeDb.whenOne(USER_LOOKUP, USER);
    const { body } = await login({ email: USER.email, password: PASSWORD });
    const me = await api.get('/api/auth/me', { authorization: `Bearer ${body.token}` });
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ userId: 'U9001', email: USER.email, persona: 'hr_recruiter', name: 'HMS Recruiter Name' });
    expect((await api.get('/api/auth/me')).status).toBe(401);
  });

  it('with JWT_SECRET missing on the server it fails (500) instead of handing out an unsigned or weakly signed token', async () => {
    fakeDb.whenOne(USER_LOOKUP, USER);
    restoreEnv(); restoreEnv = setEnv({ JWT_SECRET: undefined });
    const res = await login({ email: USER.email, password: PASSWORD });
    expect(res.status).toBe(500);
    expect(res.body.token).toBeUndefined();
  });

  it('characterization: an email that is not a string (a number, an object) is a 500 from email.toLowerCase(), not a 400', async () => {
    for (const email of [12345, { a: 1 }, ['a@example.test']]) {
      const res = await login({ email, password: PASSWORD });
      expect([JSON.stringify(email), res.status]).toEqual([JSON.stringify(email), 500]);
    }
    expect(fakeDb.untouched()).toBe(true);
  });
});

// ─── POST /google ────────────────────────────────────────────────────────────────────────────────────────────────
describe('POST /api/auth/google', () => {
  const signIn = (credential: unknown = 'google-id-token') => api.post('/api/auth/google', { body: credential === undefined ? {} : { credential } });
  const asPayload = (payload: object | null) => google.verifyIdToken.mockResolvedValue({ getPayload: () => payload });
  const registered = (over: Record<string, unknown> = {}) => fakeDb.whenOne(USER_LOOKUP, { ...USER, ...over });

  describe('before Google is asked', () => {
    it.each([['no credential', undefined], ['an empty credential', ''], ['a null credential', null]])('%s → 400 "credential required"', async (_name, credential) => {
      const res = await api.post('/api/auth/google', { body: credential === undefined ? {} : { credential } });
      expect([res.status, res.body]).toEqual([400, { error: 'credential required' }]);
      expect(google.verifyIdToken).not.toHaveBeenCalled();
      expect(fakeDb.untouched()).toBe(true);
    });

    it('GOOGLE_CLIENT_ID missing on the server → 500 "not configured", and Google is not asked (the credential check comes first)', async () => {
      restoreEnv(); restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET, GOOGLE_CLIENT_ID: undefined });
      const res = await signIn();
      expect([res.status, res.body]).toEqual([500, { error: 'Google OAuth is not configured on this server' }]);
      expect(google.verifyIdToken).not.toHaveBeenCalled();
      expect((await api.post('/api/auth/google', { body: {} })).status).toBe(400);
    });
  });

  describe('verifying the token with Google', () => {
    it('asks Google to verify THIS credential for THIS app (audience = GOOGLE_CLIENT_ID), so a token minted for another app is refused by Google', async () => {
      registered();
      await signIn('the-credential');
      expect(google.verifyIdToken).toHaveBeenCalledTimes(1);
      expect(google.verifyIdToken).toHaveBeenCalledWith({ idToken: 'the-credential', audience: CLIENT_ID });
    });

    it('a credential Google rejects (forged, expired, wrong audience) → 401 "Invalid Google credential", nothing read or written, no token', async () => {
      google.verifyIdToken.mockRejectedValue(new Error('Wrong recipient, payload audience != requiredAudience'));
      const res = await signIn();
      expect([res.status, res.body]).toEqual([401, { error: 'Invalid Google credential' }]);
      expect(fakeDb.untouched()).toBe(true);
    });

    it('the failure text from Google is not echoed to the caller', async () => {
      google.verifyIdToken.mockRejectedValue(new Error('SECRET-DETAIL-FROM-GOOGLE'));
      expect(JSON.stringify((await signIn()).body)).not.toContain('SECRET-DETAIL');
    });
  });

  describe('the @digitalpaani.com gate', () => {
    it.each([
      ['another company', 'person@example.test'],
      ['a look-alike with the domain as a prefix of a longer one', 'person@digitalpaani.com.evil.example'],
      ['a look-alike with the domain as a suffix of a longer one', 'person@evildigitalpaani.com'],
      ['a sub-domain', 'person@mail.digitalpaani.com'],
      ['the domain inside the local part', 'digitalpaani.com@example.test'],
      ['the right domain followed by whitespace', 'person@digitalpaani.com '],
    ])('%s → 403, and nothing is read or written', async (_name, email) => {
      asPayload({ ...GOOGLE_PAYLOAD, email });
      const res = await signIn();
      expect([res.status, res.body]).toEqual([403, { error: 'Only @digitalpaani.com accounts can access this system.' }]);
      expect(res.body.token).toBeUndefined();
      expect(fakeDb.untouched()).toBe(true);
    });

    it('a payload with no email → 403, nothing read', async () => {
      asPayload({ sub: 'x', name: 'No Email' });
      const res = await signIn();
      expect(res.status).toBe(403);
      expect(fakeDb.untouched()).toBe(true);
    });

    it('the address is lower-cased before the check and before the lookup', async () => {
      asPayload({ ...GOOGLE_PAYLOAD, email: 'Test.Recruiter@DigitalPaani.COM' });
      registered();
      const res = await signIn();
      expect(res.status).toBe(200);
      expect(fakeDb.one(USER_LOOKUP).params).toEqual(['test.recruiter@digitalpaani.com']);
    });
  });

  describe('the user must already exist in HMS', () => {
    it('an @digitalpaani.com account with no active users row → 403 "not registered in HMS", no write, no token', async () => {
      fakeDb.whenOne(USER_LOOKUP, null);
      const res = await signIn();
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/not registered in HMS/);
      expect(res.body.token).toBeUndefined();
      expect(fakeDb.writes()).toEqual([]);
    });

    it('the lookup is restricted to ACTIVE users (is_active = true), so removing access takes effect at the next sign-in', async () => {
      registered();
      await signIn();
      expect(fakeDb.one(USER_LOOKUP).sql).toContain('is_active = true');
    });
  });

  describe('the token it issues', () => {
    it('carries users.name, NOT the Google display name — Hiring Manager matching (compensation, dashboard lock, queue) depends on it', async () => {
      registered({ persona: 'hiring_manager' });
      const res = await signIn();
      const payload = decode(res.body.token);
      expect(GOOGLE_PAYLOAD.name).not.toBe(USER.name);
      expect(payload.name).toBe('HMS Recruiter Name');
      expect(payload.name).not.toBe('Google Display Name');
    });

    it('takes email and persona from the users row (an admin changing a persona takes effect at the next sign-in), and userId is the users.id', async () => {
      registered({ persona: 'leadership' });
      const payload = decode((await signIn()).body.token);
      expect([payload.userId, payload.email, payload.persona]).toEqual(['U9001', USER.email, 'leadership']);
    });

    it('issues a super_admin token when (and only when) the users row says so', async () => {
      registered({ persona: 'super_admin' });
      expect(decode((await signIn()).body.token).persona).toBe('super_admin');
      registered({ persona: 'hr_recruiter' });
      expect(decode((await signIn()).body.token).persona).toBe('hr_recruiter');
    });

    it('lives 24 hours by default and JWT_EXPIRES_IN overrides it', async () => {
      registered();
      expect(lifetime((await signIn()).body.token)).toBe(24 * 60 * 60);
      restoreEnv(); restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET, GOOGLE_CLIENT_ID: CLIENT_ID, JWT_EXPIRES_IN: '30m' });
      expect(lifetime((await signIn()).body.token)).toBe(30 * 60);
    });

    it('the response user is the public part of the row with the Google picture as avatar_url — no password hash, no google_id', async () => {
      registered({ google_id: 'old-sub' });
      const res = await signIn();
      expect(res.status).toBe(200);
      expect(res.body.user).toEqual({
        id: 'U9001', name: 'HMS Recruiter Name', email: USER.email, persona: 'hr_recruiter', department: 'People', avatar_url: GOOGLE_PAYLOAD.picture,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash|google_id|old-sub|google-sub-1/i);
    });

    it('the issued token is accepted by the next request (GET /me)', async () => {
      registered();
      const { body } = await signIn();
      const me = await api.get('/api/auth/me', { authorization: `Bearer ${body.token}` });
      expect([me.status, me.body.user.name, me.body.user.persona]).toEqual([200, 'HMS Recruiter Name', 'hr_recruiter']);
    });
  });

  describe('linking the Google identity', () => {
    it('on the FIRST Google sign-in (no google_id yet) it stores google_id and the picture and sets auth_provider to "both" for an account that also has a password, "google" otherwise (one statement, decided in SQL)', async () => {
      registered({ google_id: null });
      await signIn();
      const link = fakeDb.one(LINK_GOOGLE);
      expect(link.params).toEqual(['google-sub-1', GOOGLE_PAYLOAD.picture, 'U9001']);
      expect(fakeDb.find(LAST_LOGIN_ONLY)).toEqual([]);
      expect(fakeDb.writes()).toHaveLength(1);
    });

    it('when google_id is already linked and the picture is unchanged it only stamps last_login', async () => {
      registered({ google_id: 'google-sub-1', avatar_url: GOOGLE_PAYLOAD.picture });
      await signIn();
      expect(fakeDb.one(LAST_LOGIN_ONLY).params).toEqual(['U9001']);
      expect(fakeDb.find(LINK_GOOGLE)).toEqual([]);
      expect(fakeDb.writes()).toHaveLength(1);
    });

    it('when the picture changed it refreshes the stored picture (the same statement as linking)', async () => {
      registered({ google_id: 'google-sub-1', avatar_url: 'https://pics.example.test/old.png' });
      await signIn();
      expect(fakeDb.one(LINK_GOOGLE).params).toEqual(['google-sub-1', GOOGLE_PAYLOAD.picture, 'U9001']);
    });

    it('the write is issued for the user the EMAIL resolved to (params end with that user\'s id), never for an id taken from the request', async () => {
      registered({ id: 'U9555' });
      await api.post('/api/auth/google', { body: { credential: 'x', id: 'U1', userId: 'U1', email: 'someone.else@digitalpaani.com' } });
      expect(fakeDb.one(LINK_GOOGLE).params[2]).toBe('U9555');
      expect(fakeDb.one(USER_LOOKUP).params).toEqual(['test.recruiter@digitalpaani.com']);
    });
  });

  describe('characterization: what the code does today and does not check (see productIssues)', () => {
    it('the payload\'s email_verified flag is never read: an unverified address on the right domain signs in', async () => {
      asPayload({ ...GOOGLE_PAYLOAD, email_verified: false });
      registered();
      const res = await signIn();
      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
    });

    it('the hd (hosted domain) claim is never read: the check is the e-mail suffix alone', async () => {
      asPayload({ ...GOOGLE_PAYLOAD, hd: 'some-other-workspace.example' });
      registered();
      expect((await signIn()).status).toBe(200);
      asPayload({ ...GOOGLE_PAYLOAD, hd: undefined });
      expect((await signIn()).status).toBe(200);
    });

    it('the Google subject is not compared with the google_id already stored: a different Google account for the same e-mail takes the link over when the picture differs', async () => {
      asPayload({ ...GOOGLE_PAYLOAD, sub: 'a-different-google-account', picture: 'https://pics.example.test/other.png' });
      registered({ google_id: 'google-sub-1', avatar_url: GOOGLE_PAYLOAD.picture });
      const res = await signIn();
      expect(res.status).toBe(200);
      expect(fakeDb.one(LINK_GOOGLE).params[0]).toBe('a-different-google-account');
    });

    it('a verified token with no payload (getPayload() returns undefined) is a 500 from reading payload.email, not a clean 401; nothing is read or written', async () => {
      asPayload(null);
      const res = await signIn();
      expect(res.status).toBe(500);
      expect(res.body.token).toBeUndefined();
      expect(fakeDb.untouched()).toBe(true);
    });
  });
});

// ─── /me and /logout ─────────────────────────────────────────────────────────────────────────────────────────────
describe('GET /api/auth/me and POST /api/auth/logout', () => {
  it('/me returns the decoded token payload and never touches the database', async () => {
    const res = await api.get('/api/auth/me', { as: 'hiring_manager' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ userId: 'U9002', persona: 'hiring_manager', email: 'manager@example.test' });
    expect(fakeDb.untouched()).toBe(true);
  });

  it('/me needs a token', async () => {
    const res = await api.get('/api/auth/me');
    expect([res.status, res.body]).toEqual([401, { error: 'No token provided' }]);
  });

  it('logout is public and stateless: it answers 200 to anyone, writes nothing, and a token that was "logged out" still works until it expires (the client discards it)', async () => {
    const out = await api.post('/api/auth/logout');
    expect([out.status, out.body]).toEqual([200, { message: 'Logged out' }]);
    expect(fakeDb.untouched()).toBe(true);
    const stillGood = await api.get('/api/auth/me', { as: 'hr_recruiter' });
    expect(stillGood.status).toBe(200);
  });

  it('characterization: authentication does not ask the database whether the user still exists or is active — a token for a since-deactivated user keeps working until it expires', async () => {
    fakeDb.whenOne(USER_LOOKUP, null);                                  // the user is gone / inactive now
    const res = await api.get('/api/auth/me', { as: 'hr_recruiter' });
    expect(res.status).toBe(200);
    expect(fakeDb.untouched()).toBe(true);
  });
});
