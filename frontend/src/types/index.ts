export type Persona = 'hr_recruiter' | 'hiring_manager' | 'interviewer' | 'leadership';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type AgingAlert = 'ok' | 'yellow' | 'red';
export type ApplicationStatus = 'Active' | 'On Hold' | 'Rejected' | 'Withdrawn' | 'Hold for Future' | 'Joined' | 'Closed';
export type ScreeningStatus = 'New' | 'Under Recruiter Review' | 'Awaiting HM Review' | 'HM Shortlisted' | 'Screening Hold' | 'Screening Rejected';
export type Recommendation = 'Strong Yes' | 'Yes' | 'Maybe' | 'No';

export interface AuthUser {
  id:          string;
  name:        string;
  email:       string;
  persona:     Persona;
  department?: string;
}

export interface Role {
  id:                       string;
  title:                    string;
  department?:              string;
  hiring_manager_name?:     string;
  priority:                 Priority;
  status:                   string;
  new_replacement?:         string;
  replacement_reason?:      string;
  num_openings:             number;
  location?:                string;
  employment_type?:         string;
  yoe_required?:            string;
  ctc_band?:                string;
  kpi_expectations?:        string;
  job_description?:         string;
  must_have_skills?:        string;
  nice_to_have_skills?:     string;
  suggested_interviewers?:  string;
  assignment_required:      boolean;
  recruitment_mode?:        string[];
  additional_remarks?:      string;
  start_date?:              string;
  target_closure_date?:     string;
  approver_name?:           string;
  approval_date?:           string;
  approval_note?:           string;
  jd_drive_link?:           string;
  social_jd_drive_link?:    string;
  whatsapp_forward_link?:   string;
  referral_message_link?:   string;
  approval_summary_link?:   string;
  posting_status?:          Record<string, string>;
  created_at:               string;
  // computed
  days_open:                number;
  aging_alert:              AgingAlert;
  active_candidate_count?:  number;
  shortlisted_count?:       number;
}

export interface Agency {
  id:                          string;
  name:                        string;
  contact_name?:               string;
  contact_email?:              string;
  contact_phone?:              string;
  contract_status:             'Active' | 'Inactive' | 'On Hold';
  tier1_band?:                 string;
  tier1_rate?:                 string;
  tier2_band?:                 string;
  tier2_rate?:                 string;
  tier3_band?:                 string;
  tier3_rate?:                 string;
  replacement_guarantee_days?: number;
  specialisations?:            string;
  agreement_drive_link?:       string;
  notes?:                      string;
  created_at:                  string;
  updated_at:                  string;
  // computed (list query only)
  total_submitted?:            number;
  total_hired?:                number;
}

export interface Candidate {
  id:                     string;
  full_name:              string;
  email?:                 string;
  phone?:                 string;
  linkedin_url?:          string;
  hr_tags?:               string[];
  created_at:             string;

  // ── Real candidate-entered profile fields (replaces old "parsed_*" fields) ──
  current_ctc_fixed?:     number;
  current_ctc_variable?:  number;
  current_esops?:         number;
  expected_ctc?:          number;
  notice_period_days?:    number;
  current_company?:       string;
  current_industry?:      string;
  current_designation?:   string;
  current_location?:      string;
  years_of_experience?:   number;
  resume_drive_link?:     string;

  // Present on GET /api/candidates (LEFT JOIN) — null when the candidate has
  // no applications yet (e.g. an ingested candidate whose "role applying
  // for" answer didn't match any open role).
  applications?: Array<{
    id:            string;
    role_id:       string;
    role_title:    string;
    stage:         string;
    status:        string;
    ai_fit_score?: number;
  }> | null;
}

export interface Application {
  id:                          string;
  candidate_id:                string;
  role_id:                     string;
  application_date:            string;
  source_channel?:             string;
  agency_name?:                string;
  agency_fee_estimate?:        number;
  stage:                       string;
  status:                      ApplicationStatus;
  recruiter_screening_status:  ScreeningStatus;
  resume_drive_link?:          string;

  // ── ResumeIQ 8-dimension scoring (matches digitalpaani-candidate-scoring skill) ──
  score_technical?:            number;
  score_technical_note?:       string;
  score_experience?:           number;
  score_experience_note?:      string;
  score_industry_fit?:         number;
  score_industry_fit_note?:    string;
  score_culture_fit?:          number;
  score_culture_fit_note?:     string;
  score_role_alignment?:       number;
  score_role_alignment_note?:  string;
  score_trajectory?:           number;
  score_trajectory_note?:      string;
  score_leadership?:           number;
  score_leadership_note?:      string;
  score_communication?:        number;
  score_communication_note?:   string;
  score_avg?:                  number;
  score_strengths?:            string[];
  score_red_flags?:            string[];
  score_summary?:              string;
  score_recommendation?:       Recommendation;
  score_resume_read?:          boolean;
  score_computed_at?:          string;

  // HR notes
  hr_recruiter_summary?:       string;
  hr_key_positives?:           string;
  hr_key_concerns?:            string;
  hr_comp_alignment?:          string;
  hr_communication_assessment?: string;
  hr_priority_override?:       string;
  hr_priority_override_reason?: string;
  hr_tags?:                    string[];
  internal_risk_notes?:        string;

  // Governance
  founder_review_flag:         boolean;
  sla_breach:                  boolean;
  stage_entry_time:            string;
  last_updated:                string;
  next_action?:                string;

  // Joined from backend
  candidate_name?:             string;
  role_title?:                 string;
  role_priority?:              Priority;
}

export interface InterviewRound {
  id:                       string;
  application_id:           string;
  round_name:               string;
  round_type:               'Standard' | 'Assignment';
  round_number:             number;
  interviewer_names?:       string;
  scheduled_date?:          string;
  focus_areas?:             string[];
  feedback_status:          'Pending' | 'Submitted' | 'Overdue';
  feedback_submitted_at?:   string;
  overall_round_score?:     number;
  overall_assessment?:      string;
  round_recommendation?:    string;
  assignment_repo_id?:      string;
  assignment_send_date?:    string;
  assignment_deadline?:     string;
  assignment_submission_date?: string;
  assignment_submission_link?: string;
  assignment_outcome?:      string;
  assignment_overall_score?: number;
  score_technical_accuracy?: number;
  score_problem_solving?:   number;
  score_clarity?:           number;
  score_practical_thinking?: number;
  score_completeness?:      number;
  assignment_notes?:        string;
}

export interface AssignmentRepoEntry {
  id:                string;
  name:              string;
  role_category?:    string;
  experience_level?: string;
  difficulty_level?: string;
  drive_link?:       string;
}

export interface PendingAction {
  id:              number;
  owner_type:      string;
  priority_level:  string;
  action_type:     string;
  description:     string;
  application_id?: string;
  candidate_name?: string;
  role_title?:     string;
  hours_overdue:   number;
  created_at:      string;
}

export interface DashboardData {
  metrics: {
    open_roles_count:        number;
    open_roles_by_priority:  Record<Priority, number>;
    active_candidates:       number;
    strong_fit_candidates:   number;
    sla_breaches:            number;
    total_pending_actions:   number;
    red_aging_roles:         number;
    joining_risk_count:      number;
  };
  pending_actions_by_owner:  Record<string, PendingAction[]>;
  aging_roles:               Array<Role & { active_count: number }>;
  hiring_funnel:             Array<{ stage: string; count: string }>;

  // ── Phase 2 (PRD §18) ──────────────────────────────────────────────────────
  source_quality:     Array<{ source_channel: string; n: number; pass_rate: number; hire_rate: number }>;
  time_to_fill:       { overall_days: number | null; by_priority: Record<Priority, number | null> };
  agency_performance: Array<{ agency_id: string; agency_name: string; n: number; hire_rate: number }>;
}

// ─── Utility constants ────────────────────────────────────────────────────────
export const STAGES = [
  'Applied', 'Resume Review', 'Shortlisted',
  'Interview Round 1', 'Interview Round 2', 'Assignment Round', 'Founders Round',
  'Reference Check', 'Pre-Joining Documents', 'Offer Discussion',
  'Offer Released', 'Offer Accepted', 'Joined',
];

export const REJECTION_REASONS = [
  'Missing mandatory skill', 'Below experience threshold',
  'Assignment performance insufficient', 'Communication gap',
  'Compensation mismatch', 'Short average tenure',
  'Cultural / values concern', 'Role filled — other candidate preferred',
  'Role cancelled / on hold',
];

export const WITHDRAWAL_REASONS = [
  'Accepted another offer', 'Counter-offer accepted',
  'Compensation below expectation', 'Process too slow',
  'Role / company mismatch', 'Personal reasons', 'Unresponsive / no-show',
];

export const PERSONAS: Record<Persona, string> = {
  hr_recruiter:   'HR / Recruiter',
  hiring_manager: 'Hiring Manager',
  interviewer:    'Interviewer',
  leadership:     'Leadership',
};

export const PRIORITY_COLORS: Record<Priority, string> = {
  P0: 'bg-red-100 text-red-800',
  P1: 'bg-amber-100 text-amber-800',
  P2: 'bg-blue-100 text-blue-800',
  P3: 'bg-gray-100 text-gray-600',
};
