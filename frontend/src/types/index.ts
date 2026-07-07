export type Persona = 'hr_recruiter' | 'hiring_manager' | 'interviewer' | 'leadership';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type AgingAlert = 'ok' | 'yellow' | 'red';
export type ApplicationStatus = 'Active' | 'On Hold' | 'Rejected' | 'Withdrawn' | 'Hold for Future' | 'Joined' | 'Closed';
export type ScreeningStatus = 'New' | 'Under Recruiter Review' | 'Awaiting HM Review' | 'HM Shortlisted' | 'Screening Hold' | 'Screening Rejected';

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
  num_openings:             number;
  location?:                string;
  yoe_required?:            string;
  ctc_band?:                string;
  kpi_expectations?:        string;
  must_have_skills?:        string;
  nice_to_have_skills?:     string;
  suggested_interviewers?:  string;
  assignment_required:      boolean;
  start_date?:              string;
  target_closure_date?:     string;
  jd_drive_link?:           string;
  created_at:               string;
  // computed
  days_open:                number;
  aging_alert:              AgingAlert;
  active_candidate_count?:  number;
  shortlisted_count?:       number;
}

export interface Candidate {
  id:                    string;
  full_name:             string;
  email?:                string;
  phone?:                string;
  linkedin_url?:         string;
  parsed_total_yoe?:     number;
  parsed_skills?:        string[];
  parsed_industries?:    string[];
  parsed_education?:     string;
  job_stability_months?: number;
  parsing_completeness:  'Complete' | 'Partial' | 'Not Parsed';
  hr_tags?:              string[];
  created_at:            string;
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
  current_ctc_fixed?:          number;
  ectc?:                       number;
  notice_period_days?:         number;
  resume_drive_link?:          string;
  // AI scoring
  ai_fit_score?:               number;
  ai_priority_bucket?:         string;
  ai_skills_matched?:          string[];   // ← added
  ai_missing_skills?:          string[];
  ai_risk_flags?:              string[];
  ai_eval_areas?:              string[];
  ai_score_summary?:           string;
  ai_score_breakdown?:         { skills: number; experience: number; industry: number; location: number };
  ai_scored_at?:               string;
  // HR notes
  hr_recruiter_summary?:       string;
  hr_key_positives?:           string;
  hr_key_concerns?:            string;
  hr_priority_override?:       string;
  hr_tags?:                    string[];
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
  focus_areas?:             string[];   // ← added: used to pre-populate feedback modal
  feedback_status:          'Pending' | 'Submitted' | 'Overdue';
  feedback_submitted_at?:   string;
  overall_round_score?:     number;
  overall_assessment?:      string;
  round_recommendation?:    string;
  // Assignment fields
  assignment_deadline?:     string;
  assignment_outcome?:      string;
  assignment_submission_link?: string;
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
}

// ─── Utility constants ────────────────────────────────────────────────────────
export const STAGES = [
  'Applied', 'Resume Review', 'Shortlisted',
  'Interview – Round 1', 'Interview – Round 2', 'Interview – Round 3',
  'Assignment Round', 'Final Evaluation', 'Reference Check',
  'Pre-Joining Documents', 'Offer Discussion', 'Offer Released',
  'Offer Accepted', 'Joined',
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
