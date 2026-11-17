import { useEffect } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { AuthUser, Persona } from '../types/index.ts';

// AuthContext is vi.mock'ed in 17 other test files and every one of them hand-copies its flag derivation; this is the only place the REAL provider runs.
// Only the network is replaced. Plain functions behind the mock (not vi.fn() rejections: a spy re-throws a rejected result on a derived promise, which
// vitest reports as an unhandled error).
let loginImpl: (email: string, password: string) => Promise<unknown> = async () => { throw new Error('login not stubbed'); };
let googleImpl: (credential: string) => Promise<unknown> = async () => { throw new Error('loginWithGoogle not stubbed'); };
const loginCalls = vi.fn();
const googleCalls = vi.fn();
vi.mock('../services/api.ts', () => ({
  authApi: {
    login: (email: string, password: string) => { loginCalls(email, password); return loginImpl(email, password); },
    loginWithGoogle: (credential: string) => { googleCalls(credential); return googleImpl(credential); },
  },
}));

import { AuthProvider, useAuth } from './AuthContext.tsx';

type Auth = ReturnType<typeof useAuth>;

const PERSONAS: Persona[] = ['hr_recruiter', 'hiring_manager', 'leadership', 'super_admin'];
const userOf = (persona: Persona | string, over: Partial<AuthUser> = {}): AuthUser => ({ id: `u-${persona}`, name: `Test ${persona}`, email: `${persona}@example.test`, persona: persona as Persona, ...over });
const seed = (user: unknown, token: string | null = 'tok-stored') => {
  if (token !== null) localStorage.setItem('hms_token', token);
  if (user !== undefined) localStorage.setItem('hms_user', typeof user === 'string' ? user : JSON.stringify(user));
};

/** Captures the context the way a page sees it, and prints the parts a user would see. */
let latest: Auth;
function Probe() {
  const auth = useAuth();
  useEffect(() => { latest = auth; });
  latest = auth;
  return <div data-testid="probe">{auth.loading ? 'loading' : auth.user ? `in:${auth.user.persona}` : 'out'}</div>;
}
const mount = () => render(<AuthProvider><Probe /></AuthProvider>);
const state = () => screen.getByTestId('probe').textContent;

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  loginCalls.mockReset(); googleCalls.mockReset();
  loginImpl = async () => { throw new Error('login not stubbed'); };
  googleImpl = async () => { throw new Error('loginWithGoogle not stubbed'); };
});
afterEach(() => { vi.restoreAllMocks(); });

// ═══ The four personas ═══════════════════════════════════════════════════════════════════════════════
// The single place the frontend decides what each persona is. `canLead` is NOT "is HR-tier": it is false for hr_recruiter (HR/Admin), which is what hides the
// Ready-for-Review stage editor from HR/Admin while Leadership and Super Admin keep it (ScorecardSummary.tsx reads `canLead` for it). The backend's own
// `isHRTier` is a different, wider check. Pin every cell, not only the interesting ones.
describe('AuthContext — flag derivation (is / canHR / canLead / isSuperAdmin)', () => {
  const EXPECTED: Record<Persona, { canHR: boolean; canLead: boolean; isSuperAdmin: boolean }> = {
    hr_recruiter:   { canHR: true,  canLead: false, isSuperAdmin: false },
    hiring_manager: { canHR: false, canLead: false, isSuperAdmin: false },
    leadership:     { canHR: true,  canLead: true,  isSuperAdmin: false },
    super_admin:    { canHR: true,  canLead: true,  isSuperAdmin: true  },
  };

  it.each(PERSONAS)('%s: flags are exactly the table row, and is() is true for that persona alone', persona => {
    seed(userOf(persona));
    mount();
    expect(state()).toBe(`in:${persona}`);
    expect({ canHR: latest.canHR, canLead: latest.canLead, isSuperAdmin: latest.isSuperAdmin }).toEqual(EXPECTED[persona]);
    for (const p of PERSONAS) expect(latest.is(p), `is('${p}') as ${persona}`).toBe(p === persona);
  });

  it('nobody is signed in: every flag is false and is() answers false for every persona', () => {
    mount();
    expect(state()).toBe('out');
    expect(latest.user).toBeNull();
    expect({ canHR: latest.canHR, canLead: latest.canLead, isSuperAdmin: latest.isSuperAdmin }).toEqual({ canHR: false, canLead: false, isSuperAdmin: false });
    for (const p of PERSONAS) expect(latest.is(p)).toBe(false);
  });

  it.each(['interviewer', 'admin', '', 'HR_RECRUITER'])('a stored persona the app does not know (%j) is granted nothing', persona => {
    // 'interviewer' was a real persona until it was merged into hiring_manager; a token issued before that must not become HR-tier by accident.
    seed(userOf(persona));
    mount();
    expect(state()).toBe('out');                                      // not adopted at all, and the stored session is dropped
    expect(localStorage.getItem('hms_user')).toBeNull();
    expect({ canHR: latest.canHR, canLead: latest.canLead, isSuperAdmin: latest.isSuperAdmin }).toEqual({ canHR: false, canLead: false, isSuperAdmin: false });
    for (const p of PERSONAS) expect(latest.is(p)).toBe(false);
  });

  it('the flags follow the session: signing in as leadership raises them, signing out drops them all', async () => {
    loginImpl = async () => ({ data: { token: 'tok-1', user: userOf('leadership') } });
    mount();
    expect(latest.canHR).toBe(false);
    await act(async () => { await latest.login('lead@example.test', 'pw'); });
    expect({ canHR: latest.canHR, canLead: latest.canLead, isSuperAdmin: latest.isSuperAdmin }).toEqual(EXPECTED.leadership);
    act(() => latest.logout());
    expect({ canHR: latest.canHR, canLead: latest.canLead, isSuperAdmin: latest.isSuperAdmin }).toEqual({ canHR: false, canLead: false, isSuperAdmin: false });
  });
});

// ═══ Restoring a session on load ═════════════════════════════════════════════════════════════════════
describe('AuthContext — restoring the session from localStorage', () => {
  it('is "loading" until the stored session has been read, so a protected route never redirects on a guess', () => {
    // renderToString renders the very first pass only: effects (which is where the session is read) have not run, so this is what the user's first paint sees.
    seed(userOf('hr_recruiter'));
    const html = renderToString(<AuthProvider><Probe /></AuthProvider>);
    expect(html).toContain('loading');
    expect(html).not.toContain('in:');
  });

  it('a stored token + user is restored: user, token and loading=false', () => {
    seed(userOf('hiring_manager', { department: 'Engineering' }), 'tok-abc');
    mount();
    expect(state()).toBe('in:hiring_manager');
    expect(latest.token).toBe('tok-abc');
    expect(latest.loading).toBe(false);
    expect(latest.user).toEqual(userOf('hiring_manager', { department: 'Engineering' }));
  });

  it('nothing stored: signed out, not loading, no token', () => {
    mount();
    expect(state()).toBe('out');
    expect(latest).toMatchObject({ user: null, token: null, loading: false });
  });

  it('a token without a user stays signed out (and the stray token is not adopted, and is cleared)', () => {
    seed(undefined, 'tok-only');
    mount();
    expect(state()).toBe('out');
    expect(latest.token).toBeNull();
    expect(localStorage.getItem('hms_token')).toBeNull();
  });

  it('a user without a token stays signed out', () => {
    seed(userOf('super_admin'), null);
    mount();
    expect(state()).toBe('out');
    expect(latest.user).toBeNull();
    expect(latest.isSuperAdmin).toBe(false);
  });

  it('an empty-string token counts as no token', () => {
    seed(userOf('super_admin'), '');
    mount();
    expect(state()).toBe('out');
  });

  it('restoring never writes to storage or calls the API', () => {
    seed(userOf('leadership'));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    mount();
    expect(setItem).not.toHaveBeenCalled();
    expect(loginCalls).not.toHaveBeenCalled();
    expect(googleCalls).not.toHaveBeenCalled();
  });
});

// ═══ A corrupt or malformed stored user ══════════════════════════════════════════════════════════════
// The stored hms_user is trusted only if it is an object with a known persona and string id / email / name. Anything else (corrupt JSON, valid JSON of the
// wrong shape, a user with an unknown persona) clears both session keys and starts signed out: no throw, no white screen that survives reloads.
const NO_RIGHTS = { canHR: false, canLead: false, isSuperAdmin: false };
const mountQuiet = () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const r = mount();
  return { r, err };
};

describe('AuthContext — a corrupt hms_user in localStorage', () => {
  it.each(['{not json', 'undefined', '<html>', '{"id":'])('%j starts signed out, without throwing, and clears the stored session', corrupt => {
    localStorage.setItem('hms_token', 'tok'); localStorage.setItem('hms_user', corrupt);
    const { err } = mountQuiet();
    expect(state()).toBe('out');
    expect(latest).toMatchObject({ user: null, token: null, loading: false, ...NO_RIGHTS });
    expect(localStorage.getItem('hms_token')).toBeNull();
    expect(localStorage.getItem('hms_user')).toBeNull();
    expect(err).not.toHaveBeenCalled();
  });

  it('the cleared session does not come back on the next load (the crash used to survive reloads)', () => {
    localStorage.setItem('hms_token', 'tok'); localStorage.setItem('hms_user', '{not json');
    mountQuiet().r.unmount();
    mountQuiet();
    expect(state()).toBe('out');
  });

  it('an empty stored user is "no stored user": signed out', () => {
    localStorage.setItem('hms_token', 'tok'); localStorage.setItem('hms_user', '');
    mountQuiet();
    expect(state()).toBe('out');
  });
});

describe('AuthContext — a stored hms_user that is valid JSON but not a user', () => {
  it.each(['null', '0', 'false', '""', '"just a string"', '42', '[]', '[{"persona":"hr_recruiter"}]', 'true', '{}'])('%s: signed out, session cleared', raw => {
    seed(raw);
    mountQuiet();
    expect(state()).toBe('out');
    expect(latest.user).toBeNull();
    expect(latest).toMatchObject(NO_RIGHTS);
    expect(localStorage.getItem('hms_token')).toBeNull();
    expect(localStorage.getItem('hms_user')).toBeNull();
  });

  it.each([
    ['no id',       { name: 'N', email: 'e@example.test', persona: 'hr_recruiter' }],
    ['no email',    { id: 'u', name: 'N', persona: 'hr_recruiter' }],
    ['no name',     { id: 'u', email: 'e@example.test', persona: 'hr_recruiter' }],
    ['numeric id',  { id: 7, name: 'N', email: 'e@example.test', persona: 'hr_recruiter' }],
    ['no persona',  { id: 'u', name: 'N', email: 'e@example.test' }],
    ['persona that is not a string', { id: 'u', name: 'N', email: 'e@example.test', persona: ['hr_recruiter'] }],
  ])('an object with %s is refused', (_n, obj) => {
    seed(obj);
    mountQuiet();
    expect(state()).toBe('out');
    expect(localStorage.getItem('hms_user')).toBeNull();
  });

  it('a well-formed user with extra fields is kept as it came', () => {
    seed(userOf('hiring_manager', { department: 'Engineering' }));
    mountQuiet();
    expect(state()).toBe('in:hiring_manager');
    expect(latest.user).toMatchObject({ department: 'Engineering' });
  });
});

// ═══ login / loginWithGoogle ═════════════════════════════════════════════════════════════════════════
describe('AuthContext — login and loginWithGoogle', () => {
  it('login() sends the email and password, stores token + user under hms_token / hms_user and signs in', async () => {
    const user = userOf('hr_recruiter');
    loginImpl = async () => ({ data: { token: 'tok-login', user } });
    mount();
    await act(async () => { await latest.login('someone@example.test', 'pw-1'); });
    expect(loginCalls).toHaveBeenCalledTimes(1);
    expect(loginCalls).toHaveBeenCalledWith('someone@example.test', 'pw-1');
    expect(googleCalls).not.toHaveBeenCalled();
    expect(localStorage.getItem('hms_token')).toBe('tok-login');
    expect(JSON.parse(localStorage.getItem('hms_user')!)).toEqual(user);
    expect(state()).toBe('in:hr_recruiter');
    expect(latest.token).toBe('tok-login');
  });

  it('loginWithGoogle() sends only the credential, stores the session the same way and signs in', async () => {
    const user = userOf('hiring_manager');
    googleImpl = async () => ({ data: { token: 'tok-google', user } });
    mount();
    await act(async () => { await latest.loginWithGoogle('google-id-token'); });
    expect(googleCalls).toHaveBeenCalledTimes(1);
    expect(googleCalls).toHaveBeenCalledWith('google-id-token');
    expect(loginCalls).not.toHaveBeenCalled();
    expect(localStorage.getItem('hms_token')).toBe('tok-google');
    expect(JSON.parse(localStorage.getItem('hms_user')!)).toEqual(user);
    expect(state()).toBe('in:hiring_manager');
  });

  it('what login stores is what the next page load restores (round trip through a fresh provider)', async () => {
    loginImpl = async () => ({ data: { token: 'tok-rt', user: userOf('super_admin') } });
    const first = mount();
    await act(async () => { await latest.login('a@example.test', 'pw'); });
    first.unmount();
    mount();
    expect(state()).toBe('in:super_admin');
    expect(latest.token).toBe('tok-rt');
    expect(latest.isSuperAdmin).toBe(true);
  });

  it('a failed login rejects to the caller, stores nothing and leaves the user signed out', async () => {
    loginImpl = async () => { throw Object.assign(new Error('401'), { response: { status: 401, data: { error: 'Invalid credentials' } } }); };
    mount();
    let caught: unknown;
    await act(async () => { await latest.login('a@example.test', 'wrong').catch(e => { caught = e; }); });
    expect(caught).toMatchObject({ response: { status: 401 } });
    expect(localStorage.getItem('hms_token')).toBeNull();
    expect(localStorage.getItem('hms_user')).toBeNull();
    expect(state()).toBe('out');
  });

  it('a failed Google sign-in rejects to the caller and leaves an existing session as it was', async () => {
    seed(userOf('hr_recruiter'), 'tok-keep');
    googleImpl = async () => { throw new Error('network'); };
    mount();
    let caught: unknown;
    await act(async () => { await latest.loginWithGoogle('bad').catch(e => { caught = e; }); });
    expect(caught).toBeInstanceOf(Error);
    expect(localStorage.getItem('hms_token')).toBe('tok-keep');
    expect(state()).toBe('in:hr_recruiter');
  });

  it('signing in again replaces the previous session (token, user and flags)', async () => {
    seed(userOf('hiring_manager'), 'tok-old');
    googleImpl = async () => ({ data: { token: 'tok-new', user: userOf('leadership') } });
    mount();
    expect(latest.canHR).toBe(false);
    await act(async () => { await latest.loginWithGoogle('cred'); });
    expect(latest.token).toBe('tok-new');
    expect(localStorage.getItem('hms_token')).toBe('tok-new');
    expect(JSON.parse(localStorage.getItem('hms_user')!).persona).toBe('leadership');
    expect(latest.canHR).toBe(true);
  });
});

// ═══ logout ══════════════════════════════════════════════════════════════════════════════════════════
describe('AuthContext — logout', () => {
  it('clears the user, the token and both stored keys', () => {
    seed(userOf('leadership'), 'tok-x');
    mount();
    expect(state()).toBe('in:leadership');
    act(() => latest.logout());
    expect(state()).toBe('out');
    expect(latest).toMatchObject({ user: null, token: null, canHR: false, canLead: false, isSuperAdmin: false });
    expect(localStorage.getItem('hms_token')).toBeNull();
    expect(localStorage.getItem('hms_user')).toBeNull();
  });

  it('removes only the session keys: other stored preferences survive', () => {
    seed(userOf('hr_recruiter'));
    localStorage.setItem('hms:some.filter', '"kept"'); localStorage.setItem('unrelated', 'kept');
    sessionStorage.setItem('hms:sourcing.role', '"R1"');
    mount();
    act(() => latest.logout());
    expect(localStorage.getItem('hms:some.filter')).toBe('"kept"');
    expect(localStorage.getItem('unrelated')).toBe('kept');
    expect(sessionStorage.getItem('hms:sourcing.role')).toBe('"R1"');
  });

  it('does not call the API (the session is dropped on this device only) and is safe to call when nobody is signed in', () => {
    mount();
    expect(() => act(() => latest.logout())).not.toThrow();
    expect(state()).toBe('out');
    expect(loginCalls).not.toHaveBeenCalled();
    expect(googleCalls).not.toHaveBeenCalled();
  });

  it('after logout a fresh provider restores nothing', () => {
    seed(userOf('hr_recruiter'));
    const first = mount();
    act(() => latest.logout());
    first.unmount();
    mount();
    expect(state()).toBe('out');
  });
});

// ═══ useAuth outside the provider ════════════════════════════════════════════════════════════════════
describe('useAuth', () => {
  it('throws a clear error when used outside AuthProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow('useAuth must be used within AuthProvider');
  });
});
