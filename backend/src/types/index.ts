// ─── Auth ─────────────────────────────────────────────────────────────────────
export type Persona = 'hr_recruiter' | 'hiring_manager' | 'leadership' | 'super_admin';

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
  new_or_replacement?:      string;
  vacancy_reason?:          string[];
  num_openings:             number;
  location?:                string;
  employment_type?:         string;
  yoe_required?:            string;
  qualification_required?:  string;
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
  generated_jd_content?:    Record<string, unknown> | null;
  whatsapp_forward_link?:   string;
  referral_message_link?:   string;
  approval_summary_link?:   string;
  posting_status?:          Record<string, string>;
  created_by?:              string;
  created_at:               string;
  updated_at:               string;
  // computed fields (joined queries)
  days_open?:               number;
  days_overdue?:            number;
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
  languages_known?:       string;
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
  // Where this candidate was originally sourced — distinct from
  // Application.source_channel (how one specific application arrived).
  source?:                'Naukri/IIMjobs' | 'LinkedIn' | 'Internal Referral' | 'Agency' | 'Direct Outreach';
  sourced_by_agency_id?:  string;
  created_at:             string;
  updated_at:             string;
}

// ─── Applications ─────────────────────────────────────────────────────────────
export type ApplicationStatus    = 'Active' | 'Rejected' | 'Withdrawn' | 'Hold for Future' | 'Joined' | 'Closed';
export type ScreeningStatus      = 'New' | 'Under Recruiter Review' | 'Awaiting HM Review' | 'HM Shortlisted' | 'Screening Hold' | 'Screening Rejected';
export type AIPriorityBucket     = 'Strong Fit' | 'Review' | 'Low Priority' | 'Reject';
export type PriorityOverride     = 'Normal' | 'High' | 'Critical';
export type JoiningConfidence    = 'High' | 'Medium' | 'Low';
export type Recommendation       = 'Strong Yes' | 'Yes' | 'Maybe' | 'No';

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
  qualifications_note?:         string;
  screening_answers?:           Array<{ question: string; answer: string }>;
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
  // 8-dimension ResumeIQ scoring (matches digitalpaani-candidate-scoring
  // skill) — this interface only ever had the legacy ai_* fields; these
  // were missing entirely despite being read/written throughout
  // applications.ts and resumeIQ.ts, and already present on the frontend's
  // own Application type.
  score_technical?:             number;
  score_technical_note?:        string;
  score_experience?:            number;
  score_experience_note?:       string;
  score_industry_fit?:          number;
  score_industry_fit_note?:     string;
  score_culture_fit?:           number;
  score_culture_fit_note?:      string;
  score_role_alignment?:        number;
  score_role_alignment_note?:   string;
  score_trajectory?:            number;
  score_trajectory_note?:       string;
  score_leadership?:            number;
  score_leadership_note?:       string;
  score_communication?:         number;
  score_communication_note?:    string;
  score_avg?:                   number;
  score_strengths?:             string[];
  score_red_flags?:             string[];
  score_summary?:               string;
  score_recommendation?:        Recommendation;
  score_resume_read?:           boolean;
  score_computed_at?:           string;
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
  budget_exception_reason_cat?:    string;
  budget_exception_reason_detail?: string;
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
  candidate_expected_ctc?:      number;
  role_title?:                  string;
  role_ctc_band?:               string;
  agency_name?:                 string;
}

// ─── Interview Rounds ─────────────────────────────────────────────────────────
export interface InterviewRound {
  id:                       string;
  application_id:           string;
  round_name:               string;
  round_type:               'Standard' | 'Assignment';
  round_number:             number;
  interviewer_emails?:      string[];
  scheduled_date?:          string;
  interview_mode?:          string;
  duration_minutes?:        number;
  calendar_event_id?:       string;
  calendar_event_link?:     string;
  calendar_sync_error?:     string;
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
  assignment_mail_body?:        string;
  assignment_cc?:               string[];
  assignment_link?:             string;
  assignment_supporting_docs?:  string;
  assignment_email_error?:      string;
  assignment_notes?:            string;
  created_at:               string;
  updated_at:               string;
}

// ─── Dashboard aggregates ─────────────────────────────────────────────────────
export interface DashboardMetrics {
  open_roles_count:              number;
  open_roles_by_priority:        Record<Priority, number>;
  avg_active_role_age_days:      number | null;
  avg_time_to_fill_days:         number | null;
  roles_filled_last_30d:         number;
  active_candidates:             number;
  candidates_score_ge_75:        number;
  candidates_score_le_45:        number;
  candidates_at_interview1_plus: number;
  candidates_unmatched:          number;
  sla_breach_total:              number;
  sla_breach_by_owner:           Record<string, number>;
  sla_breach_top_type:           { type: string; count: number } | null;
  sla_breach_top_stage:          { stage: string; count: number } | null;
  red_aging_roles:               number;
  founder_review_pending:        number;
  joining_risk_count:            number;
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

// ─── Canonical pipeline stage order ─────────────────────────────────────────
// Mirrors frontend/src/types/index.ts's STAGES exactly. Previously
// duplicated ad-hoc inside dashboard.ts (with a comment noting the backend
// had "no shared copy of this list") — centralized here once a second
// backend consumer (interviews.ts's auto-advance-on-positive-feedback)
// needed the exact same list, to remove the drift risk of two independent
// copies silently disagreeing.
export const STAGE_ORDER: string[] = [
  'Applied', 'Resume Review', 'Shortlisted',
  'Interview Round 1', 'Interview Round 2', 'Assignment Round', 'Founders Round',
  'Reference Check', 'Pre-Joining Documents', 'Offer Discussion',
  'Offer Released', 'Offer Accepted', 'Joined',
];

// ─── SLA definitions ─────────────────────────────────────────────────────────
export const SLA_HOURS: Record<string, number> = {
  RESUME_REVIEW_NORMAL:  48,
  RESUME_REVIEW_HIGH_FIT: 48,  // was 24 — every 24h SLA threshold moved to 48h
  HM_SHORTLIST:          48,
  INTERVIEW_FEEDBACK:    48,   // was 24
  ASSIGNMENT_SEND:       12,
  ASSIGNMENT_EVALUATE:   48,
  REF_INIT:              48,   // was 24
  REF_COMPLETE:          48,
  OFFER_RELEASE:         48,   // was 24
  IDLE:                  72,   // 3 days
  JOINING_CONTACT:       120,  // 5 days
};

export const AGING_THRESHOLDS: Record<Priority, { yellow: number; red: number }> = {
  P0: { yellow: 10, red: 15 },
  P1: { yellow: 21, red: 30 },
  P2: { yellow: 35, red: 45 },
  P3: { yellow: 50, red: 60 },
};
