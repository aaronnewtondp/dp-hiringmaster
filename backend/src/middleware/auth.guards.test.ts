import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { authenticate, invalidateUserAccess, requireAuth, requireHR, requireLeadership, requireSuperAdmin, stripRestrictedFields } from './auth.js';
import type { JwtPayload, Persona } from '../types/index.js';
import { fakeDb } from '../test/fakeDb.js';

// authenticate() now also asks the database whether the account is still active; the shared fake answers "active" by default.
vi.mock('../db/index.js', async () => (await import('../test/fakeDb.js')).dbModule());

// The four guards every router mounts (requireHR, requireLeadership, requireSuperAdmin, requireAuth) and authenticate's
// every way of saying no. middleware/auth.test.ts covers isHRTier, the comp helpers, stripRestrictedFields and the
// smoke-account guard; its "still answers 401 for a missing or invalid token" only ever sends a request with no header.
// Here the guards run with fake req/res objects, and the same behaviour is proved through real HTTP in
// routes.authMatrix.test.ts.

const SECRET = 'guards-test-secret';
const PERSONAS: Persona[] = ['hr_recruiter', 'hiring_manager', 'leadership', 'super_admin'];
const USER: JwtPayload = { userId: 'U9001', email: 'person@example.test', name: 'Test Person', persona: 'hr_recruiter' };

/** authenticate() is async (live account lookup): await it, then read what it did. */
async function runAuth(req: Partial<Request>) {
  const r = runWith(authenticate, req);
  await r.done;
  return r;
}
function run(guard: (req: Request, res: Response, next: NextFunction) => void, req: Partial<Request>) {
  return runWith(guard, req);
}
function runWith(guard: (req: Request, res: Response, next: NextFunction) => unknown, req: Partial<Request>) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const next = vi.fn();
  const full = { method: 'GET', headers: {}, ...req } as Request;
  const done = Promise.resolve(guard(full, { status } as unknown as Response, next));
  return {
    done,
    req: full,
    next,
    status: status.mock.calls[0]?.[0] as number | undefined,
    body: json.mock.calls[0]?.[0] as { error?: string } | undefined,
    responded: status.mock.calls.length > 0,
  };
}
const withUser = (persona: string): Partial<Request> => ({ user: { ...USER, persona: persona as Persona } });

let savedSecret: string | undefined;
beforeEach(() => { fakeDb.reset(); invalidateUserAccess(); savedSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = SECRET; });
afterEach(() => { if (savedSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = savedSecret; });

describe('authenticate — every way of being refused', () => {
  const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
  const sign = (payload: object = USER, secret: string = SECRET, options: jwt.SignOptions = {}) => jwt.sign({ ...payload }, secret, options);

  it('accepts a valid token, attaches the decoded payload as req.user, and calls next exactly once without answering', async () => {
    const r = await runAuth(bearer(sign(USER, SECRET, { expiresIn: '1h' })) as Partial<Request>);
    expect(r.next).toHaveBeenCalledTimes(1);
    expect(r.responded).toBe(false);
    expect(r.req.user).toMatchObject(USER);
  });

  it.each([
    ['no Authorization header', {}],
    ['an empty header', { authorization: '' }],
    ['"Bearer " with nothing after it', { authorization: 'Bearer ' }],
    ['the Basic scheme', { authorization: `Basic ${sign()}` }],
    ['a bare token with no scheme', { authorization: sign() }],
    ['a lower-case "bearer" (the scheme is matched exactly)', { authorization: `bearer ${sign()}` }],
  ])('%s → 401 "No token provided", and next is not called', async (_name, headers) => {
    const r = await runAuth({ headers });
    expect([r.status, r.body]).toEqual([401, { error: 'No token provided' }]);
    expect(r.next).not.toHaveBeenCalled();
  });

  it.each([
    ['a string that is not a JWT', bearer('definitely-not-a-jwt')],
    ['an expired token', bearer(sign(USER, SECRET, { expiresIn: -10 }))],
    ['a token signed with a different secret', bearer(sign(USER, 'another-secret'))],
    ['an unsigned token (alg none)', bearer(jwt.sign({ ...USER }, '', { algorithm: 'none' }))],
    ['a token whose payload was edited after signing', (() => {
      const [h, , s] = sign().split('.');
      return bearer(`${h}.${Buffer.from(JSON.stringify({ ...USER, persona: 'super_admin' })).toString('base64url')}.${s}`);
    })()],
    ['a token that is not yet valid (nbf in the future)', bearer(sign(USER, SECRET, { notBefore: 3600 }))],
  ])('%s → 401 "Invalid or expired token", and next is not called', async (_name, req) => {
    const r = await runAuth(req as Partial<Request>);
    expect([r.status, r.body]).toEqual([401, { error: 'Invalid or expired token' }]);
    expect(r.next).not.toHaveBeenCalled();
  });

  it('with JWT_SECRET unset on the server even a token signed with the usual secret is refused: it fails closed (401), it never lets a request through unchecked', async () => {
    const token = sign();
    delete process.env.JWT_SECRET;
    const r = await runAuth(bearer(token) as Partial<Request>);
    expect([r.status, r.body]).toEqual([401, { error: 'Invalid or expired token' }]);
    expect(r.next).not.toHaveBeenCalled();
  });

  it('with JWT_SECRET set to the empty string the guard also refuses (an empty secret is "not configured", not a key anyone can sign with)', async () => {
    const token = jwt.sign({ ...USER }, 'x');
    process.env.JWT_SECRET = '';
    const r = await runAuth(bearer(token) as Partial<Request>);
    expect(r.status).toBe(401);
    expect(r.next).not.toHaveBeenCalled();
  });

  it('reads the secret on every call, not once at import (so a rotated secret takes effect without a restart)', async () => {
    const token = sign(USER, 'rotated-secret');
    expect((await runAuth(bearer(token) as Partial<Request>)).status).toBe(401);
    process.env.JWT_SECRET = 'rotated-secret';
    expect((await runAuth(bearer(token) as Partial<Request>)).next).toHaveBeenCalledTimes(1);
  });

  it('does not look at the persona inside the token: an unknown persona authenticates (and is then never HR-tier, below)', async () => {
    const r = await runAuth(bearer(sign({ ...USER, persona: 'interviewer' })) as Partial<Request>);
    expect(r.next).toHaveBeenCalledTimes(1);
  });
});

describe('requireHR', () => {
  it('401 "Unauthenticated" when there is no req.user (it was mounted without authenticate in front of it)', () => {
    const r = run(requireHR, {});
    expect([r.status, r.body]).toEqual([401, { error: 'Unauthenticated' }]);
    expect(r.next).not.toHaveBeenCalled();
  });

  it.each(['hr_recruiter', 'leadership', 'super_admin'])('lets %s through, without answering', persona => {
    const r = run(requireHR, withUser(persona));
    expect(r.next).toHaveBeenCalledTimes(1);
    expect(r.responded).toBe(false);
  });

  it('403 "HR access required" for a hiring_manager', () => {
    const r = run(requireHR, withUser('hiring_manager'));
    expect([r.status, r.body]).toEqual([403, { error: 'HR access required' }]);
    expect(r.next).not.toHaveBeenCalled();
  });

  it.each(['interviewer', 'admin', 'HR_RECRUITER', 'super_admin ', '', 'undefined'])('403 for a persona string that is not one of the four: "%s" (exact match, no case folding, no trimming)', persona => {
    const r = run(requireHR, withUser(persona));
    expect([r.status, r.body]).toEqual([403, { error: 'HR access required' }]);
    expect(r.next).not.toHaveBeenCalled();
  });

  it('403 when req.user carries no persona at all', () => {
    const r = run(requireHR, { user: { userId: 'U1', email: 'x@example.test', name: 'X' } as unknown as JwtPayload });
    expect(r.status).toBe(403);
  });
});

describe('requireLeadership', () => {
  it('401 "Unauthenticated" when there is no req.user', () => {
    const r = run(requireLeadership, {});
    expect([r.status, r.body]).toEqual([401, { error: 'Unauthenticated' }]);
  });

  it.each(['hr_recruiter', 'leadership', 'super_admin'])('lets %s through', persona => {
    expect(run(requireLeadership, withUser(persona)).next).toHaveBeenCalledTimes(1);
  });

  it('403 "Leadership access required" for a hiring_manager', () => {
    const r = run(requireLeadership, withUser('hiring_manager'));
    expect([r.status, r.body]).toEqual([403, { error: 'Leadership access required' }]);
    expect(r.next).not.toHaveBeenCalled();
  });

  it('is identical to requireHR for every persona and for an anonymous request — Leadership is frozen at the HR-tier level on purpose; only the wording of the 403 differs', () => {
    for (const persona of [...PERSONAS, 'interviewer', '']) {
      const hr = run(requireHR, withUser(persona));
      const lead = run(requireLeadership, withUser(persona));
      expect([persona, lead.next.mock.calls.length, lead.status]).toEqual([persona, hr.next.mock.calls.length, hr.status]);
    }
    const [hr, lead] = [run(requireHR, {}), run(requireLeadership, {})];
    expect([lead.status, lead.body]).toEqual([hr.status, hr.body]);
  });
});

describe('requireSuperAdmin', () => {
  it('401 "Unauthenticated" when there is no req.user', () => {
    const r = run(requireSuperAdmin, {});
    expect([r.status, r.body]).toEqual([401, { error: 'Unauthenticated' }]);
  });

  it('lets only super_admin through', () => {
    const r = run(requireSuperAdmin, withUser('super_admin'));
    expect(r.next).toHaveBeenCalledTimes(1);
    expect(r.responded).toBe(false);
  });

  it.each(['hr_recruiter', 'leadership', 'hiring_manager', 'interviewer', 'Super_Admin', 'super_admin ', ''])('403 "Super-Admin access required" for %s — it is its own tier, not part of HR-tier', persona => {
    const r = run(requireSuperAdmin, withUser(persona));
    expect([r.status, r.body]).toEqual([403, { error: 'Super-Admin access required' }]);
    expect(r.next).not.toHaveBeenCalled();
  });
});

describe('requireAuth', () => {
  it('401 "Unauthenticated" when there is no req.user', () => {
    const r = run(requireAuth, {});
    expect([r.status, r.body]).toEqual([401, { error: 'Unauthenticated' }]);
    expect(r.next).not.toHaveBeenCalled();
  });

  it.each([...PERSONAS, 'interviewer', ''])('lets any signed-in person through whatever the persona says: "%s"', persona => {
    const r = run(requireAuth, withUser(persona));
    expect(r.next).toHaveBeenCalledTimes(1);
    expect(r.responded).toBe(false);
  });
});

describe('the guards in the order the routers mount them (authenticate, then a persona guard)', () => {
  const chain = async (guards: Array<(req: Request, res: Response, next: NextFunction) => unknown>, req: Partial<Request>) => {
    // Express runs the next guard only when the previous one called next(); mirror that.
    const full = { method: 'GET', headers: {}, ...req } as Request;
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const res = { status } as unknown as Response;
    let reached = 0;
    const step = async (i: number): Promise<void> => {
      if (i >= guards.length) { reached = i; return; }
      let advance: Promise<void> = Promise.resolve();
      await guards[i](full, res, () => { advance = step(i + 1); });
      await advance;
    };
    await step(0);
    return { reached, status: status.mock.calls[0]?.[0] as number | undefined, body: json.mock.calls[0]?.[0] as { error?: string } | undefined, user: full.user };
  };
  const token = (persona: string) => jwt.sign({ ...USER, persona }, SECRET, { expiresIn: '1h' });

  it('users.ts: authenticate then requireSuperAdmin — an hr_recruiter token is stopped at the second guard with the persona decoded from the token', async () => {
    const r = await chain([authenticate, requireSuperAdmin], { headers: { authorization: `Bearer ${token('hr_recruiter')}` } });
    expect([r.status, r.body, r.user?.persona]).toEqual([403, { error: 'Super-Admin access required' }, 'hr_recruiter']);
  });

  it('a super_admin token passes both', async () => {
    const r = await chain([authenticate, requireSuperAdmin], { headers: { authorization: `Bearer ${token('super_admin')}` } });
    expect([r.reached, r.status]).toEqual([2, undefined]);
  });

  it('without a token the FIRST guard answers (401), so a persona guard never runs on an anonymous request', async () => {
    const r = await chain([authenticate, requireHR], {});
    expect([r.status, r.body]).toEqual([401, { error: 'No token provided' }]);
  });
});

// ─── the list of compensation fields that stripRestrictedFields removes ──────────────────────────────────────────────
// middleware/auth.test.ts checks stripRestrictedFields against a copy of the list written inside that test, so a field added
// to (or dropped from) the source list never fails it. RESTRICTED_FIELDS is a constant local to the function and not exported,
// so the list is read back out of the source text here and compared with the pinned one: changing it now needs this file edited
// on purpose, which is the moment to ask whether the frontend, the API specs and the User Access Guide need the same change.
describe('stripRestrictedFields — which fields count as compensation', () => {
  const PINNED = [
    'ctc_band', 'role_ctc_band', 'internal_risk_notes', 'agency_fee_estimate', 'offer_ctc_fixed', 'offer_ctc_variable', 'hr_comp_alignment',
    'current_ctc_fixed', 'current_ctc_variable', 'current_esops', 'expected_ctc', 'ectc',
    'candidate_ctc_fixed', 'candidate_ctc_variable', 'candidate_expected_ctc',
  ];
  const OTHER = ['id', 'title', 'stage', 'candidate_name', 'status', 'is_severely_over_budget'];
  const row = () => Object.fromEntries([...PINNED, ...OTHER].map(k => [k, `value of ${k}`]));

  it('the list in auth.ts is exactly the pinned one (same fields, same order)', () => {
    const source = readFileSync(join(__dirname, 'auth.ts'), 'utf8');
    const literal = /const RESTRICTED_FIELDS = \[([\s\S]*?)\];/.exec(source);
    expect(literal, 'RESTRICTED_FIELDS literal not found in auth.ts').not.toBeNull();
    const withoutComments = literal![1].replace(/\/\/.*$/gm, '');       // the comments inside the array quote some of the names too
    expect([...withoutComments.matchAll(/'([^']+)'/g)].map(m => m[1])).toEqual(PINNED);
  });

  it('for a hiring_manager who is not cleared for the role, every pinned field is removed and every other field is kept', () => {
    const out = stripRestrictedFields(row(), 'hiring_manager', false);
    expect(Object.keys(out).sort()).toEqual([...OTHER].sort());
  });

  it('with no explicit clearance the persona decides: a hiring_manager loses them all, every HR-tier persona keeps the row exactly as it is', () => {
    expect(Object.keys(stripRestrictedFields(row(), 'hiring_manager')).sort()).toEqual([...OTHER].sort());
    for (const persona of ['hr_recruiter', 'leadership', 'super_admin'] as Persona[]) {
      const input = row();
      expect(stripRestrictedFields(input, persona)).toBe(input);
    }
  });

  it('a hiring_manager cleared for this particular role (canSeeComp true) keeps everything; clearance is the caller\'s decision, the persona does not matter once it is given', () => {
    const input = row();
    expect(stripRestrictedFields(input, 'hiring_manager', true)).toBe(input);
    expect(Object.keys(stripRestrictedFields(row(), 'super_admin', false)).sort()).toEqual([...OTHER].sort());   // an explicit false is honoured even for HR-tier
  });

  it('the input object is not modified (the stripped copy is a new object)', () => {
    const input = row();
    stripRestrictedFields(input, 'hiring_manager', false);
    expect(Object.keys(input)).toHaveLength(PINNED.length + OTHER.length);
  });
});
