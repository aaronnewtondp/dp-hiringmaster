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
// Allow HR and Leadership to do anything
export function requireHR(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ error: 'Unauthenticated' }); return; }
  if (req.user.persona === 'hr_recruiter' || req.user.persona === 'leadership') {
    next(); return;
  }
  res.status(403).json({ error: 'HR access required' });
}

// Allow any authenticated user (HR, HM, Interviewer, Leadership)
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ error: 'Unauthenticated' }); return; }
  next();
}

// Leadership-only actions (priority override, comp override, etc.)
export function requireLeadership(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ error: 'Unauthenticated' }); return; }
  if (req.user.persona === 'leadership' || req.user.persona === 'hr_recruiter') {
    next(); return;
  }
  res.status(403).json({ error: 'Leadership access required' });
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
  const REF_RESTRICTED = ['concerns_raised'];

  if (persona === 'hr_recruiter' || persona === 'leadership') return obj;

  const filtered = { ...obj };
  for (const field of RESTRICTED_FIELDS) {
    delete filtered[field];
  }
  if (persona !== 'leadership') {
    for (const field of REF_RESTRICTED) delete filtered[field];
  }
  return filtered;
}
