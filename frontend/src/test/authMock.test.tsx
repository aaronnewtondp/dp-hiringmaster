import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

// authMock.ts is what the page tests use in place of AuthContext. It is only worth anything while it agrees with AuthContext, so this runs
// the REAL provider (only the network module is replaced) for every persona, and for a persona the app no longer has, and compares.
vi.mock('../services/api.ts', () => ({ authApi: {} }));

import { AuthProvider, useAuth } from '../contexts/AuthContext.tsx';
import { authContextValue, personaFlags } from './authMock.ts';

const PERSONAS = ['hr_recruiter', 'hiring_manager', 'leadership', 'super_admin', 'interviewer', ''];     // 'interviewer' was merged into hiring_manager long ago

beforeEach(() => { localStorage.clear(); });

function flagsFromTheRealProvider(persona: string) {
  localStorage.setItem('hms_token', 'tok-test');
  localStorage.setItem('hms_user', JSON.stringify({ id: 'u-test', name: 'Test Person', email: 'test.person@example.test', persona }));
  let seen: unknown = null;
  function Probe() {
    const { user, canHR, canLead, isSuperAdmin } = useAuth();
    seen = user ? { canHR, canLead, isSuperAdmin } : null;                // null until the stored user has been restored
    return null;
  }
  render(<AuthProvider><Probe /></AuthProvider>);
  return seen;
}

describe('authMock — agrees with the real AuthContext', () => {
  it.each(PERSONAS)('persona "%s": the same canHR, canLead and isSuperAdmin', persona => {
    expect(personaFlags(persona)).toEqual(flagsFromTheRealProvider(persona));
  });

  it('hands out the three flags beside a synthetic user, whose id, name or e-mail address a test can replace', () => {
    expect(authContextValue('leadership')).toEqual({
      user: { id: 'u-test', name: 'Test Person', email: 'test.person@example.test', persona: 'leadership' },
      canHR: true, canLead: true, isSuperAdmin: false,
    });
    expect(authContextValue('hiring_manager', { name: 'Hana Manager', id: 'u-hm' }).user).toEqual(
      { id: 'u-hm', name: 'Hana Manager', email: 'test.person@example.test', persona: 'hiring_manager' });
  });
});
