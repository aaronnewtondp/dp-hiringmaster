// Shared by tests that drive the REAL authenticate() with a hand-written database mock (the fakeDb-based harness answers this
// itself, see FakeDb.setUserAccess). authenticate() confirms the account is still active with this exact statement; a mock
// that is sequence- or catch-all-based must answer it FIRST so the lookup neither consumes a programmed reply nor shows up in
// the assertions about what the route itself queried.
export const ACCESS_LOOKUP_SQL = 'SELECT is_active FROM users WHERE id=$1';

/** True for authenticate()'s live account-status lookup. */
export function isAccessLookup(sql: unknown): boolean {
  return String(sql).replace(/\s+/g, ' ').trim() === ACCESS_LOOKUP_SQL;
}

/** The rows an ordinary active account gets back. */
export const ACTIVE_ACCOUNT_ROWS: Array<{ is_active: boolean }> = [{ is_active: true }];
