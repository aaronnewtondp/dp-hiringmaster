import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload, Persona } from '../types/index.js';

// Extend Express Request to carry the decoded JWT payload
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

// ─── Verify JWT and attach user to request ───────────────────────────────────
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET not configured');
    const payload = jwt.verify(token, secret) as JwtPayload;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
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
  return persona === 'hiring_manager' &&
    !!hiringManagerName &&
    hiringManagerName.trim().toLowerCase() === userName.trim().toLowerCase();
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
