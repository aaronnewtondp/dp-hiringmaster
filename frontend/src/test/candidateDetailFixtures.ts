// Synthetic data for the Candidate page tests (CandidateDetail.test.tsx and CandidateDetail.rounds.test.tsx).
// Obviously fake: no real names, addresses or ids.
export const candidate = (over: Record<string, unknown> = {}) => ({
  id: 'C9001', full_name: 'Test Candidate', email: 'cand@example.test', phone: '+000 0000', linkedin_url: 'https://linkedin.example.test/in/test-candidate',
  resume_drive_link: 'https://drive.example.test/resume', hr_tags: ['strong'], created_at: '2026-09-01T00:00:00Z',
  current_ctc_fixed: 10, expected_ctc: 14, notice_period_days: 30, current_company: 'Test Co', current_designation: 'Test Engineer',
  current_industry: 'Test Industry', current_location: 'Pune', years_of_experience: 6, languages_known: 'English', source: 'LinkedIn', gender: null,
  ...over,
});

// One application as GET /candidates/:id returns it.
export const detailApplication = (id: string, over: Record<string, unknown> = {}) => ({
  id, candidate_id: 'C9001', role_id: 'R9001', role_title: 'Test Role Alpha', role_priority: 'P1', role_ctc_band: '10-15', hiring_manager_name: 'Test Manager One',
  stage: 'Applied and Screened', status: 'Active', recruiter_screening_status: 'New', source_channel: 'Job Application Form',
  application_date: '2026-10-01T00:00:00Z', last_updated: '2026-10-20T00:00:00Z', sla_breach: false, is_severely_over_budget: false,
  candidate_ctc_fixed: 10, candidate_expected_ctc: 14, preferred_location: 'Pune', founder_review_flag: false,
  ...over,
});

export const round = (id: string, over: Record<string, unknown> = {}) => ({
  id, application_id: 'A9001', round_number: 1, round_name: 'Technical', round_type: 'Standard', feedback_status: 'Pending',
  interviewer_emails: ['panel@example.test'], scheduled_date: '2026-10-22T10:00:00Z',
  ...over,
});

export const refCheck = (id: string, over: Record<string, unknown> = {}) => ({
  id, application_id: 'A9001', reference_name: 'Test Referee', reference_number: 'RC9001', relationship: 'Reporting Manager',
  feedback: 'Good', reference_call_notes: 'Reliable and calm.', conducted_at: '2026-10-15T00:00:00Z',
  ...over,
});
