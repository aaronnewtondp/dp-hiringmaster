// What a page test hands back from its replacement of `useAuth()`. The flags are derived in ONE place, here, the way AuthContext derives them
// (AuthContext.tsx: canHR for hr_recruiter, leadership and super_admin; canLead for leadership and super_admin; isSuperAdmin for super_admin only),
// so the test files that replace AuthContext cannot each carry their own copy of the table and drift apart. authMock.test.tsx checks this
// derivation against the real provider for every persona.

export interface PersonaFlags { canHR: boolean; canLead: boolean; isSuperAdmin: boolean }

export function personaFlags(persona: string): PersonaFlags {
  const isSuperAdmin = persona === 'super_admin';
  return {
    canHR: persona === 'hr_recruiter' || persona === 'leadership' || isSuperAdmin,
    canLead: persona === 'leadership' || isSuperAdmin,
    isSuperAdmin,
  };
}

/** `user` plus the three flags for one persona; `who` replaces the synthetic person's id, name or e-mail address (the persona is always the one asked for). */
export function authContextValue(persona: string, who: Partial<{ id: string; name: string; email: string }> = {}) {
  return {
    user: { id: 'u-test', name: 'Test Person', email: 'test.person@example.test', ...who, persona },
    ...personaFlags(persona),
  };
}
