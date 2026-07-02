// ─── Auth ─────────────────────────────────────────────────────────────────────
export type Persona = 'hr_recruiter' | 'hiring_manager' | 'interviewer' | 'leadership';

export interface User {
  id:          string;
  name:        string;
  email:       string;
  persona:     Persona;
  department?: string;
  is_active:   boolean;
  created_at:  string;
  last_login?: string;
}

export interface JwtPayload {
  userId:  string;
  email:   string;
  persona: Persona;
  name:    string;
}

// ─── Roles ────────────────────────────────────────────────────────────────────
export type RoleStatus = 'Draft' | 'Under Review' | 'Approved' | 'Live – Sourcing' | 'On Hold' | 'Closed – Filled' | 'Closed – Cancelled';
export type Priority   = 'P0' | 'P1' | 'P2' | 'P3';

export interface Role {
  id:                       string;
  title:                    string;
  department?:              string;
  hiring_manager_name?:     string;
  priority:                 Priority;
  status:                   RoleStatus;
  new_replacement?:         string;
  replacement_reason?:      string;
  num_openings:             number;
  location?:                string;
  employment_type?:         string;
  yoe_required?:            string;
  ctc_band?:                string;       // restricted
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
  created_by?:              string;
  created_at:               string;
  updated_at:               string;
  // computed fields (joined queries)
  days_open?:               number;
  aging_alert?:             'ok' | 'yellow' | 'red';
  active_candidate_count?:  number;
  shortlisted_count?:       number;
}

// ─── Candidates ───────────────────────────────────────────────────────────────
export interface Candidate {
  id:                     string;
  full_name:              string;
  email?:                 string;
  phone?:                 string;
  linkedin_url?:          string;
  parsed_total_yoe?:      number;
  parsed_skills?:         string[];
  parsed_industries?:     string[];
  parsed_education?:      string;
  job_stability_months?:  number;
  career_progression?:    string;
  parsing_completeness:   'Complete' | 'Partial' | 'Not Parsed';
  hr_tags?:               string[];
  duplicate_flag:         boolean;
  duplicate_of?:          string;
  created_at:             string;
  updated_at:             string;
}

// ─── Applications ─────────────────────────────────────────────────────────────
export type ApplicationStatus    = 'Active' | 'On Hold' | 'Rejected' | 'Withdrawn' | 'Hold for Future' | 'Joined' | 'Closed';
export type ScreeningStatus      = 'New' | 'Under Recruiter Review' | 'Awaiting HM Review' | 'HM Shortlisted' | 'Screening Hold' | 'Screening Rejected';
export type AIPriorityBucket     = 'Strong Fit' | 'Review' | 'Low Priority' | 'Reject';
export type PriorityOverride     = 'Normal' | 'High' | 'Critical';
export type JoiningConfidence    = 'High' | 'Medium' | 'Low';

export interface Application {
  id:                           string;
  candidate_id:                 string;
  role_id:                      string;
  application_date:             string;
  source_channel?:              string;
  sub_source?:                  string;
  agency_id?:                   string;
  agency_fee_estimate?:         number;      // restricted
  stage:                        string;
  status:                       ApplicationStatus;
  recruiter_screening_status:   ScreeningStatus;
  current_ctc_fixed?:           number;
  current_ctc_variable?:        number;
  ectc?:                        number;
  notice_period_days?:          number;
  current_location?:            string;
  preferred_location?:          string;
  resume_drive_link?:           string;
  assignment_submission_link?:  string;
  offer_letter_link?:           string;
  ai_fit_score?:                number;
  ai_priority_bucket?:          AIPriorityBucket;
  ai_skills_matched?:           string[];
  ai_missing_skills?:           string[];
  ai_risk_flags?:               string[];
  ai_eval_areas?:               string[];
  ai_score_summary?:            string;
  ai_score_breakdown?:          { skills: number; experience: number; industry: number; location: number };
  ai_scored_at?:                string;
  hr_recruiter_summary?:        string;
  hr_key_positives?:            string;
  hr_key_concerns?:             string;
  hr_comp_alignment?:           string;
  hr_communication_assessment?: string;
  hr_priority_override?:        PriorityOverride;
  hr_priority_override_reason?: string;
  hr_tags?:                     string[];
  internal_risk_notes?:         string;      // restricted
  founder_review_flag:          boolean;
  founder_review_note?:         string;
  rejection_reason_cat?:        string;
  rejection_reason_detail?:     string;
  withdrawal_reason_cat?:       string;
  withdrawal_reason_detail?:    string;
  offer_stage?:                 string;
  offer_approved_by?:           string;
  offer_approval_date?:         string;
  offer_ctc_fixed?:             number;
  offer_ctc_variable?:          number;
  offer_joining_date?:          string;
  offer_sent_date?:             string;
  offer_accepted_date?:         string;
  joining_confidence?:          JoiningConfidence;
  last_hr_contact?:             string;
  joining_risk_notes?:          string;
  joining_risk_auto_flag:       boolean;
  stage_entry_time:             string;
  sla_hours?:                   number;
  sla_breach:                   boolean;
  last_updated:                 string;
  next_action?:                 string;
  next_action_owner?:           string;
  // Joined fields
  candidate_name?:              string;
  role_title?:                  string;
  agency_name?:                 string;
}

// ─── Interview Rounds ─────────────────────────────────────────────────────────
export interface InterviewRound {
  id:                       string;
  application_id:           string;
  round_name:               string;
  round_type:               'Standard' | 'Assignment';
  round_number:             number;
  interviewer_names?:       string;
  scheduled_date?:          string;
  interview_mode?:          string;
  focus_areas?:             string[];
  feedback_status:          'Pending' | 'Submitted' | 'Overdue';
  feedback_submitted_at?:   string;
  entered_by?:              string;
  eval_areas_assessed?:     string[];
  scores_per_area?:         Record<string, number>;
  overall_round_score?:     number;
  confidence_level?:        'Low' | 'Medium' | 'High';
  overall_assessment?:      string;
  strengths_observed?:      string;
  key_concerns?:            string;
  unresolved_questions?:    string;
  suggested_probe_areas?:   string;
  round_recommendation?:    string;
  notes?:                   string;
  // Assignment fields
  assignment_repo_id?:          string;
  assignment_send_date?:        string;
  assignment_deadline?:         string;
  assignment_submission_date?:  string;
  assignment_submission_link?:  string;
  assignment_outcome?:          string;
  assignment_overall_score?:    number;
  score_technical_accuracy?:    number;
  score_problem_solving?:       number;
  score_clarity?:               number;
  score_practical_thinking?:    number;
  score_completeness?:          number;
  assignment_notes?:            string;
  created_at:               string;
  updated_at:               string;
}

// ─── Dashboard aggregates ─────────────────────────────────────────────────────
export interface DashboardMetrics {
  open_roles_count:       number;
  open_roles_by_priority: Record<Priority, number>;
  active_candidates:      number;
  strong_fit_candidates:  number;
  sla_breaches:           number;
  total_pending_actions:  number;
  red_aging_roles:        number;
  founder_review_pending: number;
  joining_risk_count:     number;
}

export interface PendingActionGroup {
  owner_type:   string;
  count:        number;
  items: Array<{
    id:           number;
    action_type:  string;
    description:  string;
    candidate_name?: string;
    role_title?:  string;
    application_id?: string;
    hours_overdue: number;
  }>;
}

// ─── SLA definitions ─────────────────────────────────────────────────────────
export const SLA_HOURS: Record<string, number> = {
  RESUME_REVIEW_NORMAL:  48,
  RESUME_REVIEW_HIGH_FIT: 24,
  HM_SHORTLIST:          48,
  INTERVIEW_FEEDBACK:    24,
  ASSIGNMENT_SEND:       12,
  ASSIGNMENT_EVALUATE:   48,
  FINAL_EVAL:            48,
  REF_INIT:              24,
  REF_COMPLETE:          48,
  OFFER_RELEASE:         24,
  IDLE:                  72,   // 3 days
  JOINING_CONTACT:       120,  // 5 days
};

export const AGING_THRESHOLDS: Record<Priority, { yellow: number; red: number }> = {
  P0: { yellow: 10, red: 15 },
  P1: { yellow: 21, red: 30 },
  P2: { yellow: 35, red: 45 },
  P3: { yellow: 50, red: 60 },
};
