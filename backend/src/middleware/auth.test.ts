import { describe, it, expect } from 'vitest';
import { isHRTier, canSeeCompForRole, stripRestrictedFields } from './auth.js';
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
