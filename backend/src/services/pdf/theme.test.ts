import { describe, it, expect } from 'vitest';
import { classifyVariant } from './theme.js';

describe('classifyVariant', () => {
  it('classifies as tech when the title or department contains a tech keyword', () => {
    expect(classifyVariant('Tech / Engineering', 'Sr. Backend Developer')).toBe('tech');
    expect(classifyVariant(null, 'Senior Product Manager')).toBe('tech');
    expect(classifyVariant(null, 'Senior UX/Product Designer')).toBe('tech');
    expect(classifyVariant('Data', 'Data Engineer')).toBe('tech');
  });

  it('matches case-insensitively', () => {
    expect(classifyVariant('TECH', null)).toBe('tech');
  });

  it('falls back to infra for anything without a tech keyword', () => {
    expect(classifyVariant('Sales & Growth', 'Head of Marketing & Creative Direction')).toBe('infra');
    expect(classifyVariant('Project Implementation', 'E&I Engineer (Mumbai)')).toBe('infra');
  });

  it('handles null/undefined department and title without throwing', () => {
    expect(classifyVariant(null, null)).toBe('infra');
    expect(classifyVariant(undefined, undefined)).toBe('infra');
  });
});
