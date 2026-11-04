import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload, Persona } from '../types/index.js';
import { isNamedHiringManager } from '../utils/hiringManagers.js';
import { queryOne } from '../db/index.js';

// Extend Express Request to carry the decoded JWT payload
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

// ─── Production smoke-test accounts are READ-ONLY ─────────────────────────────
// The suite in hms-tests-final/tests/smoke signs in with two dedicated password accounts. They live on `hms-smoke.invalid`:
// RFC 2606 reserves `.invalid`, so no real mailbox can exist there and Google sign-in (which only admits @digitalpaani.com)
// can never reach them. They are created by SQL and sign in only through POST /api/auth/login. Whatever persona they hold,
// every authenticated request that could change data is refused, so a leaked smoke password can read but never write.
export const SMOKE_EMAIL_DOMAIN = 'hms-smoke.invalid';
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSmokeAccount(email: unknown): boolean {
  return typeof email === 'string' && email.trim().toLowerCase().endsWith(`@${SMOKE_EMAIL_DOMAIN}`);
}

// ─── Live account-status check ────────────────────────────────────────────────
// A JWT lives 24 h (routes/auth.ts), so verifying the signature alone would let a user deactivated via PATCH /api/users/:id
// keep full access for up to a day. authenticate() therefore also confirms the user still exists and is_active = true.
// To avoid one extra query per request the answer is cached in-process for ACCESS_CACHE_TTL_MS (15 s): on the instance that
// handled the PATCH, invalidateUserAccess() makes a deactivation immediate; on any other serverless instance it takes effect
// within the TTL, which therefore bounds how stale an answer can be. Only definitive answers (active / inactive / no row)
// are cached, never a database error: a failed lookup fails CLOSED (503) and is retried on the next request.
export const ACCESS_CACHE_TTL_MS = 15_000;
export const ACCESS_CACHE_MAX_ENTRIES = 1000;
const accessCache = new Map<string, { active: boolean; at: number }>();
// Bumped by every invalidateUserAccess(): a lookup that was already in flight when an invalidation happened may have read the
// row BEFORE the update committed, so its answer is used for that one request but never cached (it would otherwise put a stale
// "active" back for a full TTL right after a deactivation).
let accessEpoch = 0;

/** Forget the cached active/inactive answer for one user, or for everyone when called with no argument. */
export function invalidateUserAccess(userId?: string): void {
  accessEpoch++;
  if (userId === undefined) accessCache.clear();
  else accessCache.delete(String(userId));
}

async function isUserActive(userId: string): Promise<boolean> {
  const now = Date.now();
  const hit = accessCache.get(userId);
  if (hit && now - hit.at < ACCESS_CACHE_TTL_MS) return hit.active;
  const epoch = accessEpoch;
  const row = await queryOne<{ is_active: boolean }>('SELECT is_active FROM users WHERE id=$1', [userId]);
  const active = row?.is_active === true;
  if (epoch !== accessEpoch) return active;
  if (accessCache.size >= ACCESS_CACHE_MAX_ENTRIES && !accessCache.has(userId)) {
    // Hard cap: drop the oldest entry (Map keeps insertion order); entries are re-inserted on refresh so this is oldest-written.
    const oldest = accessCache.keys().next().value;
    if (oldest !== undefined) accessCache.delete(oldest);
  }
  accessCache.delete(userId);
  accessCache.set(userId, { active, at: now });
  return active;
}

// ─── Verify JWT, confirm the account is still active, attach user to request ───
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    let payload: JwtPayload;
    try {
      const secret = process.env.JWT_SECRET;
      if (!secret) throw new Error('JWT_SECRET not configured');
      payload = jwt.verify(token, secret) as JwtPayload;
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    if (typeof payload.userId !== 'string' || !payload.userId) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    req.user = payload;
    // Smoke accounts are refused here, before any database lookup.
    if (isSmokeAccount(payload.email) && !READ_ONLY_METHODS.has(req.method)) {
      res.status(403).json({ error: 'Smoke-test accounts are read-only' });
      return;
    }

    let active: boolean;
    try {
      active = await isUserActive(payload.userId);
    } catch {
      delete req.user;
      res.status(503).json({ error: 'Could not verify account status' });
      return;
    }
    if (!active) {
      delete req.user;
      res.status(401).json({ error: 'Account is deactivated or no longer exists' });
      return;
    }
    next();
  } catch {
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Persona guards ───────────────────────────────────────────────────────────
// Canonical "HR-or-above" check — the single extension point for every
// requireHR/requireLeadership/stripRestrictedFields/inline persona check in
// the codebase. super_admin is a strict superset of everything hr_recruiter
// and leadership can do, so it belongs in this set, not a separate tier.
export function isHRTier(persona: Persona): boolean {
  return persona === 'hr_recruiter' || persona === 'leadership' || persona === 'super_admin';
}

// Allow HR, Leadership, and Super-Admin to do anything
export function requireHR(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ error: 'Unauthenticated' }); return; }
  if (isHRTier(req.user.persona)) { next(); return; }
  res.status(403).json({ error: 'HR access required' });
}

// Allow any authenticated user (HR, HM, Interviewer, Leadership, Super-Admin)
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ error: 'Unauthenticated' }); return; }
  next();
}

// Leadership-only actions (priority override, comp override, etc.). Identical
// to requireHR today and intentionally kept that way — Leadership's
// permissions are frozen at their current (HR-equivalent) level; this stays
// a separate function so a real future split doesn't require re-threading
// every call site again.
export function requireLeadership(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ error: 'Unauthenticated' }); return; }
  if (isHRTier(req.user.persona)) { next(); return; }
  res.status(403).json({ error: 'Leadership access required' });
}

// Super-Admin-only actions (User Management). Deliberately its own persona
// check, not part of isHRTier — nothing else should ever fall through to
// this tier implicitly.
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ error: 'Unauthenticated' }); return; }
  if (req.user.persona === 'super_admin') { next(); return; }
  res.status(403).json({ error: 'Super-Admin access required' });
}

// Whether `persona` may see compensation details for a role whose assigned
// Hiring Manager is `hiringManagerName` — the single ownership check reused
// everywhere a comp-restricted field needs a per-role (not just per-persona)
// decision. HR-tier always passes regardless of the role; a Hiring Manager
// passes only for the specific role(s) they're actually assigned to, matched
// by name (roles.hiring_manager_name is a plain text field, no user_id FK to
// compare against instead — same reasoning as roles.ts's pre-existing
// isHmForThisRole, which this replaces/generalizes so applications.ts and
// candidates.ts can reuse the identical check instead of each re-deriving
// their own copy).
export function canSeeCompForRole(
  persona: Persona,
  userName: string,
  hiringManagerName: string | null | undefined
): boolean {
  if (isHRTier(persona)) return true;
  // hiringManagerName may list several people ("A, B" — see utils/hiringManagers.ts); any one of them qualifies.
  return persona === 'hiring_manager' && isNamedHiringManager(userName, hiringManagerName);
}

// ─── Field filter: strip restricted fields based on persona ──────────────────
// Call this before sending application/candidate/role data to anyone who
// isn't cleared to see compensation details. `canSeeComp` defaults to
// `isHRTier(persona)` (the original, role-agnostic behavior) — pass an
// explicit boolean (built from canSeeCompForRole above) wherever the caller
// knows which specific role's Hiring Manager may also be cleared for this
// particular row.
export function stripRestrictedFields<T extends Record<string, unknown>>(
  obj: T,
  persona: Persona,
  canSeeComp: boolean = isHRTier(persona)
): Partial<T> {
  const RESTRICTED_FIELDS = [
    // 'ctc_band' is the raw column name on roles; 'role_ctc_band' is the
    // alias used when it's joined onto an application row (applications.ts,
    // candidates.ts) — both need stripping since callers use whichever
    // shape they queried. Same reasoning for the candidate-CTC pair:
    // 'current_ctc_fixed'/'current_ctc_variable'/'current_esops'/
    // 'expected_ctc' are the raw candidate-table column names, while
    // 'candidate_ctc_fixed'/'candidate_ctc_variable'/'candidate_expected_ctc'
    // are the joined aliases applications.ts uses. 'ectc' is the
    // application's own submitted-expectation figure (distinct from the
    // candidate profile's expected_ctc).
    'ctc_band', 'role_ctc_band', 'internal_risk_notes', 'agency_fee_estimate',
    'offer_ctc_fixed', 'offer_ctc_variable', 'hr_comp_alignment',
    'current_ctc_fixed', 'current_ctc_variable', 'current_esops', 'expected_ctc', 'ectc',
    'candidate_ctc_fixed', 'candidate_ctc_variable', 'candidate_expected_ctc',
  ];
  if (canSeeComp) return obj;

  const filtered = { ...obj };
  for (const field of RESTRICTED_FIELDS) {
    delete filtered[field];
  }
  return filtered;
}
