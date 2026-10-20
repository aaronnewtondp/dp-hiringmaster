import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { authenticate, isHRTier, isSmokeAccount, canSeeCompForRole, stripRestrictedFields } from './auth.js';
import { Persona } from '../types/index.js';

describe('isHRTier', () => {
  it('is true for hr_recruiter, leadership, and super_admin', () => {
    expect(isHRTier('hr_recruiter')).toBe(true);
    expect(isHRTier('leadership')).toBe(true);
    expect(isHRTier('super_admin')).toBe(true);
  });

  it('is false for hiring_manager', () => {
    expect(isHRTier('hiring_manager')).toBe(false);
  });
});

describe('canSeeCompForRole', () => {
  it('is always true for any HR-tier persona, regardless of role ownership', () => {
    expect(canSeeCompForRole('hr_recruiter', 'Anyone', 'Someone Else')).toBe(true);
    expect(canSeeCompForRole('leadership', 'Anyone', null)).toBe(true);
    expect(canSeeCompForRole('super_admin', 'Anyone', undefined)).toBe(true);
  });

  it('is true for a hiring_manager whose name matches the role’s hiring_manager_name', () => {
    expect(canSeeCompForRole('hiring_manager', 'Alex Kumar', 'Alex Kumar')).toBe(true);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(canSeeCompForRole('hiring_manager', '  alex KUMAR  ', 'Alex Kumar')).toBe(true);
  });

  it('is false for a hiring_manager whose name does not match', () => {
    expect(canSeeCompForRole('hiring_manager', 'Alex Kumar', 'Someone Else')).toBe(false);
  });

  it('is false for a hiring_manager when the role has no hiring_manager_name set', () => {
    expect(canSeeCompForRole('hiring_manager', 'Alex Kumar', null)).toBe(false);
    expect(canSeeCompForRole('hiring_manager', 'Alex Kumar', undefined)).toBe(false);
  });

  it('a role can have several Hiring Managers: every listed person qualifies, nobody else does', () => {
    const field = 'Mandeep Dagar, Piyush Negi';
    expect(canSeeCompForRole('hiring_manager', 'Mandeep Dagar', field)).toBe(true);
    expect(canSeeCompForRole('hiring_manager', 'piyush negi', field)).toBe(true);
    expect(canSeeCompForRole('hiring_manager', 'Someone Else', field)).toBe(false);
  });

  it('a whole name must match — a prefix or a longer name is not the same person', () => {
    expect(canSeeCompForRole('hiring_manager', 'Amit', 'Amit Gosain')).toBe(false);
    expect(canSeeCompForRole('hiring_manager', 'Amit Gosain', 'Amit')).toBe(false);
    expect(canSeeCompForRole('hiring_manager', 'Amit', 'Amit Gosain, Amit')).toBe(true);
  });

  it('only the hiring_manager persona is ever matched by name: any other persona string stays false even when listed', () => {
    expect(canSeeCompForRole('viewer' as never, 'Alex', 'Alex, Piyush Negi')).toBe(false);
    expect(canSeeCompForRole('interviewer' as never, 'Piyush Negi', 'Mandeep Dagar, Piyush Negi')).toBe(false);
  });

  it('invisible whitespace pasted into the field does not hide a listed person', () => {
    expect(canSeeCompForRole('hiring_manager', 'Piyush Negi', 'Mandeep Dagar,\u00a0Piyush Negi')).toBe(true);
  });
});

describe('stripRestrictedFields', () => {
  const sample = {
    id: 'A0001',
    title: 'Some Role',
    ctc_band: '20-25 LPA',
    role_ctc_band: '20-25 LPA',
    internal_risk_notes: 'secret',
    agency_fee_estimate: 500000,
    offer_ctc_fixed: 2200000,
    offer_ctc_variable: 200000,
    hr_comp_alignment: 'aligned',
    current_ctc_fixed: 1800000,
    current_ctc_variable: 100000,
    current_esops: 0,
    expected_ctc: 2100000,
    ectc: 2100000,
    candidate_ctc_fixed: 1800000,
    candidate_ctc_variable: 100000,
    candidate_expected_ctc: 2100000,
  };

  it('passes every field through unchanged when canSeeComp is true', () => {
    const result = stripRestrictedFields(sample, 'hiring_manager', true);
    expect(result).toEqual(sample);
  });

  it('strips every restricted field when canSeeComp is false, keeping non-restricted fields intact', () => {
    const result = stripRestrictedFields(sample, 'hiring_manager', false);
    expect(result.id).toBe('A0001');
    expect(result.title).toBe('Some Role');
    for (const field of [
      'ctc_band', 'role_ctc_band', 'internal_risk_notes', 'agency_fee_estimate',
      'offer_ctc_fixed', 'offer_ctc_variable', 'hr_comp_alignment',
      'current_ctc_fixed', 'current_ctc_variable', 'current_esops', 'expected_ctc', 'ectc',
      'candidate_ctc_fixed', 'candidate_ctc_variable', 'candidate_expected_ctc',
    ]) {
      expect(result).not.toHaveProperty(field);
    }
  });

  it('defaults canSeeComp to isHRTier(persona) when not explicitly passed', () => {
    const hrResult = stripRestrictedFields(sample, 'hr_recruiter' as Persona);
    expect(hrResult).toEqual(sample);

    const hmResult = stripRestrictedFields(sample, 'hiring_manager' as Persona);
    expect(hmResult).not.toHaveProperty('ctc_band');
  });

  it('does not mutate the original object', () => {
    const copy = { ...sample };
    stripRestrictedFields(sample, 'hiring_manager', false);
    expect(sample).toEqual(copy);
  });
});

describe('isSmokeAccount', () => {
  it('is true only for an address on the reserved hms-smoke.invalid domain', () => {
    expect(isSmokeAccount('smoke.leadership@hms-smoke.invalid')).toBe(true);
    expect(isSmokeAccount('  Smoke.HM@HMS-SMOKE.INVALID ')).toBe(true);
    expect(isSmokeAccount('aaron.newton@digitalpaani.com')).toBe(false);
    expect(isSmokeAccount('x@evil-hms-smoke.invalid.com')).toBe(false);
    expect(isSmokeAccount('x@sub.hms-smoke.invalid')).toBe(false);          // only the domain itself
    expect(isSmokeAccount(undefined)).toBe(false);
    expect(isSmokeAccount(42)).toBe(false);
  });
});

describe('authenticate — smoke-test accounts are read-only', () => {
  const SECRET = 'unit-test-secret';
  const run = (email: string, method: string) => {
    process.env.JWT_SECRET = SECRET;
    const token = jwt.sign({ userId: 'u1', email, persona: 'leadership', name: 'Smoke' }, SECRET);
    const req = { headers: { authorization: `Bearer ${token}` }, method } as unknown as Request;
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json }) } as unknown as Response;
    const next = vi.fn();
    authenticate(req, res, next);
    return { next, status: (res.status as ReturnType<typeof vi.fn>).mock.calls[0]?.[0], body: json.mock.calls[0]?.[0] };
  };

  it('lets a smoke account read', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(run('smoke.hm@hms-smoke.invalid', m).next).toHaveBeenCalledTimes(1);
  });

  it('refuses every method that could change data, with a 403 that says why', () => {
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const r = run('smoke.leadership@hms-smoke.invalid', m);
      expect(r.next, m).not.toHaveBeenCalled();
      expect(r.status, m).toBe(403);
      expect(r.body.error).toMatch(/read-only/i);
    }
  });

  it('does not touch anyone else — a real user can still write', () => {
    for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) expect(run('aaron.newton@digitalpaani.com', m).next, m).toHaveBeenCalledTimes(1);
  });

  it('still answers 401 for a missing or invalid token (the guard runs only after the token is verified)', () => {
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json }) } as unknown as Response;
    authenticate({ headers: {}, method: 'POST' } as unknown as Request, res, vi.fn());
    expect((res.status as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(401);
  });
});
