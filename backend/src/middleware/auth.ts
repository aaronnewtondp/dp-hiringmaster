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

// ─── Field filter: strip restricted fields based on persona ──────────────────
// Call this before sending application/candidate data to non-HR personas
export function stripRestrictedFields<T extends Record<string, unknown>>(
  obj: T,
  persona: Persona
): Partial<T> {
  const RESTRICTED_FIELDS = [
    'ctc_band', 'internal_risk_notes', 'agency_fee_estimate',
    'offer_ctc_fixed', 'offer_ctc_variable', 'hr_comp_alignment',
  ];
  if (isHRTier(persona)) return obj;

  const filtered = { ...obj };
  for (const field of RESTRICTED_FIELDS) {
    delete filtered[field];
  }
  return filtered;
}
