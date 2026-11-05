// Synthetic rows shared by the Candidates page tests (Candidates.test.tsx, .bulk.test.tsx, .unmatched.test.tsx).
// Obviously fake data only: no real names, addresses or ids.
export const NOW = new Date('2026-10-29T12:00:00Z');
export const ago = (days: number) => new Date(NOW.getTime() - days * 86400000).toISOString();

// One application row as GET /applications returns it (candidate and role fields joined in).
export const application = (id: string, over: Record<string, unknown> = {}) => ({
  id, candidate_id: `C-${id}`, candidate_name: `Test Candidate ${id}`, candidate_gender: null,
  role_id: 'R9001', role_title: 'Test Role Alpha', role_priority: 'P1', role_ctc_band: '10-15',
  stage: 'Applied and Screened', status: 'Active', ai_fit_score: 60, sla_breach: false,
  candidate_ctc_fixed: 10, candidate_expected_ctc: 12, candidate_notice_period_days: 30,
  application_date: ago(5), last_updated: ago(1), is_severely_over_budget: false,
  ...over,
});

// A9001 is 15%+ over its band (20 against 15 x 1.15 = 17.25), A9003 is over the band but not that far, A9002 is unscored.
export const A1 = application('A9001', { ai_fit_score: 80, candidate_expected_ctc: 20, is_severely_over_budget: true, candidate_gender: 'F', application_date: ago(9), last_updated: ago(2) });
export const A2 = application('A9002', { role_id: 'R9002', role_title: 'Test Role Beta', ai_fit_score: null, application_date: ago(4), last_updated: ago(9), candidate_gender: 'M' });
export const A3 = application('A9003', { ai_fit_score: 55, sla_breach: true, founder_review_flag: true, candidate_expected_ctc: 16, application_date: ago(19), last_updated: ago(1) });
export const APPS = [A1, A2, A3];

export const FILTER_OPTIONS = { data: { recruitment_modes: ['Direct', 'Agency'], roles: [{ id: 'R9001', title: 'Test Role Alpha' }, { id: 'R9002', title: 'Test Role Beta' }] } };
export const LIVE_ROLES = { data: { roles: [{ id: 'R9001', title: 'Test Role Alpha' }, { id: 'R9002', title: 'Test Role Beta' }] } };

export const unmatchedRow = (i: number, over: Record<string, unknown> = {}) => ({
  candidate_id: `C-U${i}`, full_name: `Test Unmatched ${i}`, email: `u${i}@example.test`, submitted_text: null,
  created_at: '2026-10-28T10:00:00Z', suggested_role_id: null, suggested_role_title: null, ...over,
});
