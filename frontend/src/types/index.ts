export type Persona = 'hr_recruiter' | 'hiring_manager' | 'leadership' | 'super_admin';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type AgingAlert = 'ok' | 'yellow' | 'red';
export type ApplicationStatus = 'Active' | 'Rejected' | 'Withdrawn' | 'Hold for Future' | 'Joined' | 'Closed';
export type ScreeningStatus = 'New' | 'Under Recruiter Review' | 'Awaiting HM Review' | 'HM Shortlisted' | 'Screening Hold' | 'Screening Rejected';
export type Recommendation = 'Strong Yes' | 'Yes' | 'Maybe' | 'No';

export interface AuthUser {
  id:          string;
  name:        string;
  email:       string;
  persona:     Persona;
  department?: string;
}

// Full user record, as returned by /api/users (User Management, Super-Admin
// only) — distinct from AuthUser, which is only the slice issued in a JWT.
export interface ManagedUser {
  id:            string;
  name:          string;
  email:         string;
  persona:       Persona;
  department?:   string;
  is_active:     boolean;
  auth_provider: 'email' | 'google' | 'both';
  created_at:    string;
  last_login?:   string;
}

export interface Role {
  id:                       string;
  title:                    string;
  department?:              string;
  hiring_manager_name?:     string;
  priority:                 Priority;
  status:                   string;
  new_or_replacement?:      string;
  vacancy_reason?:          string[];
  num_openings:             number;
  location?:                string;
  employment_type?:         string;
  yoe_required?:            string;
  qualification_required?:  string;
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
  days_overdue:             number;
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
  // What counts toward the commission-fee base (fixed salary, variables,
  // joining bonus/PF, perks) — the same headline % means a very different
  // effective fee depending on this.
  ctc_definition?:             string;
  market_positioning?:         string;
  replacement_triggers?:       string;
  replacement_exclusions?:     string;
  replacement_remedy?:         string;
  replacement_conditions?:     string;
  billing_invoice_trigger?:    string;
  billing_invoice_raised?:     string;
  billing_payment_due?:        string;
  billing_effective_window?:   string;
  billing_late_penalty?:       string;
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
  languages_known?:       string;

  // Where this candidate was originally sourced — distinct from
  // Application.source_channel (how one specific application arrived).
  // Not mandatory; sourced_by_agency_id only applies (and is only
  // mandatory, enforced server-side) when source === 'Agency'.
  source?:                string;
  sourced_by_agency_id?:  string;
  // GET /api/candidates/:id only (LEFT JOIN) — the agency's name, for
  // read-mode display since sourced_by_agency_id is just the id.
  sourced_by_agency_name?: string;

  // Present on GET /api/candidates (LEFT JOIN) — null when the candidate has
  // no applications yet (e.g. an ingested candidate whose "role applying
  // for" answer didn't match any open role).
  applications?: Array<{
    id:                 string;
    role_id:            string;
    role_title:         string;
    stage:              string;
    status:             string;
    ai_fit_score?:      number;
    last_updated?:      string;
    preferred_location?: string;
    application_date?:  string;
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
  screening_answers?:          Array<{ question: string; answer: string }>;
  rejection_reason_cat?:       string;
  rejection_reason_detail?:    string;
  withdrawal_reason_cat?:      string;
  withdrawal_reason_detail?:   string;

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
  email?:                      string;
  role_title?:                 string;
  role_priority?:              Priority;
  role_ctc_band?:              string;
  hiring_manager_name?:        string;
  ai_fit_score?:               number;
  ai_priority_bucket?:         string;
  preferred_location?:         string;
  candidate_ctc_fixed?:        number;
  candidate_ctc_variable?:     number;
  candidate_expected_ctc?:     number;
  candidate_notice_period_days?: number;
  candidate_company?:         string;
  candidate_industry?:        string;
  candidate_resume_link?:     string;
  last_activity_detail?:      string;
  // Server-computed, never stripped for any persona (unlike role_ctc_band,
  // which IS stripped for non-HR-tier) — a Hiring Manager needs this yes/no
  // signal to see the mandatory-reason gate coming before they hit the
  // 400 from POST /:id/stage, even though they never see the actual band.
  is_severely_over_budget?:  boolean;
}

export interface InterviewRound {
  id:                       string;
  application_id:           string;
  round_name:               string;
  round_type:               'Standard' | 'Assignment';
  round_number:             number;
  interviewer_emails?:      string[];
  scheduled_date?:          string;
  interview_mode?:          'In-person' | 'Video' | 'Phone';
  duration_minutes?:        number;
  calendar_event_id?:       string;
  calendar_event_link?:     string;
  calendar_sync_error?:     string;
  focus_areas?:             string[];
  feedback_status:          'Pending' | 'Submitted' | 'Overdue';
  feedback_submitted_at?:   string;
  overall_round_score?:     number;
  overall_assessment?:      string;
  round_recommendation?:    string;
  eval_areas_assessed?:     string[];
  scores_per_area?:         Record<string, number>;
  confidence_level?:        string;
  strengths_observed?:      string;
  key_concerns?:            string;
  unresolved_questions?:    string;
  suggested_probe_areas?:   string;
  notes?:                   string;
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
  assignment_mail_body?:       string;
  assignment_cc?:              string[];
  assignment_link?:            string;
  assignment_supporting_docs?: string;
  assignment_email_error?:     string;
}

export interface PendingAction {
  id:                  number;
  owner_type:          string;
  priority_level:      string;
  action_type:         string;
  description?:        string;
  application_id?:     string;
  candidate_name?:     string;
  role_title?:         string;
  hours_overdue:       number;
  created_at:          string;
  current_stage?:      string | null;
  sla_breach?:         boolean | null;
  candidate_id?:       string | null;
  role_id?:            string | null;
  responsible_person?: string | null;
  ai_fit_score?:       number | null;
}

export interface SlaBreachCandidate {
  application_id: string;
  candidate_id:   string | null;
  candidate_name: string;
  role_id:        string | null;
  role_title:     string;
  owner:          string;
  stage:          string;
  overdue_hours:  number;
}

export interface SlaBreachType {
  type:       string;
  owner:      string;
  count:      number;
  candidates: SlaBreachCandidate[];
}

export interface HiringFunnelSnapshotStage {
  stage:        string;
  total:        number;
  breach_types: SlaBreachType[];
}

export interface DashboardData {
  metrics: {
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
    joining_risk_count:            number;
  };
  hiring_funnel_snapshot:    HiringFunnelSnapshotStage[];
  aging_roles:               Array<Role & { active_count: number }>;
  low_pipeline:              Array<Role & { active_count: number }>;
  roles_by_status:           Record<string, number>;
  hiring_funnel:             Array<{ stage: string; active: number; rejected: number; withdrawn: number; hold_for_future: number }>;
  rejected_by_stage:         Record<string, number>;

  // ── Phase 2 (PRD §18) ──────────────────────────────────────────────────────
  source_quality:     Array<{ source_channel: string; n: number; pass_rate: number; hire_rate: number; contribution_pct: number }>;

  // ── Operational Velocity (items #10/#29) ────────────────────────────────────
  velocity: {
    interview_to_offer_ratio: number | null;
    interviewed_count:  number;
    offered_count:      number;
    tat_by_stage:       Array<{ stage: string; avg_hours: number; n: number }>;
    biggest_drop_off:   { stage: string; count: number } | null;
    biggest_drop_off_by_rate: { stage: string; count: number; rate: number } | null;
  };
}

// ─── Utility constants ────────────────────────────────────────────────────────
export const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];

// Matches the roles.status CHECK constraint exactly — shared here (rather
// than each page keeping its own copy) so Roles/Dashboard filters and
// RoleDetail's status dropdown can never drift out of sync with each other.
export const ROLE_STATUSES = [
  'Draft', 'Under Review', 'Approved', 'Live – Sourcing', 'On Hold',
  'Closed – Filled', 'Closed – Cancelled',
];

// Matches the applications.status CHECK constraint exactly — for the
// Candidates page's "Status" filter specifically, which is application-
// centric (unlike Roles/Dashboard, where "Status" correctly means
// ROLE_STATUSES above).
export const APPLICATION_STATUSES: ApplicationStatus[] = [
  'Active', 'Rejected', 'Withdrawn', 'Hold for Future', 'Joined', 'Closed',
];

// Fixed, curated list matching the Create Role form's Location dropdown
// (and, per the requisition form update, the live Google Form's own
// dropdown) — the backend filter matches each of these as a substring
// against roles.location, so single-value selections from this list always
// match exactly.
export const LOCATIONS = ['Gurgaon', 'Mumbai', 'Pune', 'Gujarat', 'Bangalore', 'Hyderabad', 'Others'];

// Exact Department option set from the live requisition Google Form
// (confirmed directly by Aaron) — NOT derived from historical roles.department
// values, which are noisy/inconsistent test data, not a reliable proxy for
// the form's real dropdown options.
export const DEPARTMENTS = [
  'Corporate Functions/Business Operations', 'CSM/Service', 'Project Implementation',
  'Sales & Growth', 'Product/QA', 'Tech/Devs', 'Domain',
];

// "Vacancy Caused Due To" — exact option set from the live requisition
// Google Form (confirmed directly by Aaron, not derived from historical
// data — real submissions are sparse and comma-joined ambiguously enough
// that reverse-engineering them risked drifting from the actual form).
export const VACANCY_REASONS = [
  'Resignation', 'Increased Work Load', 'Additional Assignments / Business Expansion',
  'New Project', 'Other',
];

export const EMPLOYMENT_TYPES = ['Full-Time / Permanent', 'Contract', 'Internship'];

// Also reused as-is for the candidate-level "Source" field (Identity
// section, CandidateDetail.tsx/NewCandidate.tsx) — same vocabulary, kept
// as one shared list rather than two near-duplicate ones.
export const RECRUITMENT_CHANNELS = [
  'Naukri/IIMjobs', 'LinkedIn', 'Internal Referral', 'Agency', 'Direct Outreach',
];

// Resume Review and Shortlisted were retired as distinct stages (2026-09-01)
// — see backend/src/types/index.ts's STAGE_ORDER for the full reasoning.
// 'Applied' -> 'Applied and Screened' the same day, so the stage name
// itself signals that ResumeIQ has already scored the candidate.
export const STAGES = [
  'Applied and Screened',
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

// Shown when shortlisting a candidate whose expected CTC is 15%+ over the
// role's stated band (utils/budget.ts's isSeverelyOverBudget) — mirrors
// REJECTION_REASONS/WITHDRAWAL_REASONS' pattern, backend enforces the gate.
export const OVER_BUDGET_SHORTLIST_REASONS = [
  'Exceptional / rare skillset', 'Business-critical urgency to fill role',
  'Candidate open to negotiate at offer stage', 'Leadership-approved exception',
  'Other',
];

export interface ReferenceCheck {
  id:                    string;
  application_id:        string;
  reference_name:        string;
  reference_number:      string;
  relationship:          string;
  reference_call_notes?: string;
  feedback:              string;
  conducted_at:          string;
}

export const REFERENCE_RELATIONSHIPS = [
  'Reporting Manager', 'Direct Reportee', 'Teammate', 'Colleague', 'Founder/Leadership',
];

export const REFERENCE_FEEDBACK_OPTIONS = ['Excellent', 'Good', 'Average', 'Below Expectations', 'Poor'];

export const PERSONAS: Record<Persona, string> = {
  hr_recruiter:   'HR/Admin',
  hiring_manager: 'Hiring Manager',
  leadership:     'Leadership',
  super_admin:    'Super Admin',
};

export const PRIORITY_COLORS: Record<Priority, string> = {
  P0: 'bg-red-100 text-red-800',
  P1: 'bg-amber-100 text-amber-800',
  P2: 'bg-blue-100 text-blue-800',
  P3: 'bg-gray-100 text-gray-600',
};
