-- DigitalPaani HMS — PostgreSQL Schema (corrected order)
-- sequences → users → roles → candidates → agencies → assignment_repo → applications → interview_rounds → ...

BEGIN;

-- ─── Extensions ─────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Sequences (MUST come before any table that uses them in a DEFAULT) ──────
CREATE SEQUENCE IF NOT EXISTS seq_role        START 8  INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS seq_candidate   START 1  INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS seq_application START 1  INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS seq_interview   START 1  INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS seq_agency      START 16 INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS seq_assignment  START 5  INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS seq_refcheck    START 1  INCREMENT 1;

-- ─── Users ───────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  persona        TEXT NOT NULL CHECK (persona IN ('hr_recruiter','hiring_manager','interviewer','leadership')),
  department     TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login     TIMESTAMPTZ
);

-- ─── Roles ───────────────────────────────────────────────────────────────────
CREATE TABLE roles (
  id                       TEXT PRIMARY KEY DEFAULT 'R' || LPAD(nextval('seq_role')::TEXT, 3, '0'),
  title                    TEXT NOT NULL,
  department               TEXT,
  hiring_manager_name      TEXT,
  priority                 TEXT NOT NULL DEFAULT 'P1' CHECK (priority IN ('P0','P1','P2','P3')),
  status                   TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN (
                             'Draft','Under Review','Approved','Live – Sourcing','On Hold',
                             'Closed – Filled','Closed – Cancelled')),
  new_replacement          TEXT CHECK (new_replacement IN ('New Position','Replacement')),
  replacement_reason       TEXT,
  num_openings             INTEGER NOT NULL DEFAULT 1,
  location                 TEXT,
  employment_type          TEXT,
  yoe_required             TEXT,
  ctc_band                 TEXT,
  kpi_expectations         TEXT,
  job_description          TEXT,
  must_have_skills         TEXT,
  nice_to_have_skills      TEXT,
  suggested_interviewers   TEXT,
  assignment_required      BOOLEAN NOT NULL DEFAULT false,
  recruitment_mode         TEXT[],
  additional_remarks       TEXT,
  start_date               DATE,
  target_closure_date      DATE,
  approver_name            TEXT,
  approval_date            DATE,
  approval_note            TEXT,
  jd_drive_link            TEXT,
  social_jd_drive_link     TEXT,
  whatsapp_forward_link    TEXT,
  referral_message_link    TEXT,
  approval_summary_link    TEXT,
  posting_status           JSONB DEFAULT '{}',
  created_by               UUID REFERENCES users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_roles_status   ON roles(status);
CREATE INDEX idx_roles_priority ON roles(priority);

-- ─── Role Edit Log ────────────────────────────────────────────────────────────
CREATE TABLE role_edit_log (
  id           BIGSERIAL PRIMARY KEY,
  role_id      TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  field_name   TEXT NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  changed_by   UUID REFERENCES users(id),
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note         TEXT
);

CREATE INDEX idx_role_edit_log_role ON role_edit_log(role_id);

-- ─── Candidates ───────────────────────────────────────────────────────────────
CREATE TABLE candidates (
  id                   TEXT PRIMARY KEY DEFAULT 'C' || LPAD(nextval('seq_candidate')::TEXT, 4, '0'),
  full_name            TEXT NOT NULL,
  email                TEXT,
  phone                TEXT,
  linkedin_url         TEXT,
  parsed_total_yoe     DECIMAL(4,1),
  parsed_skills        TEXT[],
  parsed_industries    TEXT[],
  parsed_education     TEXT,
  job_stability_months DECIMAL(5,1),
  career_progression   TEXT,
  parsing_completeness TEXT DEFAULT 'Not Parsed' CHECK (parsing_completeness IN ('Complete','Partial','Not Parsed')),
  hr_tags              TEXT[],
  duplicate_flag       BOOLEAN NOT NULL DEFAULT false,
  duplicate_of         TEXT REFERENCES candidates(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_candidates_email      ON candidates(email) WHERE email IS NOT NULL;
CREATE INDEX        idx_candidates_name       ON candidates(full_name);
CREATE INDEX        idx_candidates_skills     ON candidates USING GIN(parsed_skills);
CREATE INDEX        idx_candidates_industries ON candidates USING GIN(parsed_industries);
CREATE INDEX        idx_candidates_tags       ON candidates USING GIN(hr_tags);

-- ─── Agencies ─────────────────────────────────────────────────────────────────
CREATE TABLE agencies (
  id                          TEXT PRIMARY KEY DEFAULT 'AGN' || LPAD(nextval('seq_agency')::TEXT, 3, '0'),
  name                        TEXT NOT NULL,
  contact_name                TEXT,
  contact_email               TEXT,
  contact_phone               TEXT,
  contract_status             TEXT NOT NULL DEFAULT 'Active' CHECK (contract_status IN ('Active','Inactive','On Hold')),
  tier1_band                  TEXT,
  tier1_rate                  TEXT,
  tier2_band                  TEXT,
  tier2_rate                  TEXT,
  tier3_band                  TEXT,
  tier3_rate                  TEXT,
  replacement_guarantee_days  INTEGER DEFAULT 60,
  specialisations             TEXT,
  agreement_drive_link        TEXT,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Assignment Repository (must come BEFORE interview_rounds) ────────────────
CREATE TABLE assignment_repo (
  id                TEXT PRIMARY KEY DEFAULT 'ASN' || LPAD(nextval('seq_assignment')::TEXT, 3, '0'),
  name              TEXT NOT NULL,
  role_category     TEXT,
  experience_level  TEXT CHECK (experience_level IN ('Junior','Mid','Senior','All')),
  skills_covered    TEXT[],
  difficulty_level  TEXT CHECK (difficulty_level IN ('Low','Medium','High')),
  problem_statement TEXT,
  evaluation_rubric TEXT,
  drive_link        TEXT,
  times_used        INTEGER NOT NULL DEFAULT 0,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used         TIMESTAMPTZ
);

-- ─── Applications ─────────────────────────────────────────────────────────────
CREATE TABLE applications (
  id                            TEXT PRIMARY KEY DEFAULT 'A' || LPAD(nextval('seq_application')::TEXT, 4, '0'),
  candidate_id                  TEXT NOT NULL REFERENCES candidates(id),
  role_id                       TEXT NOT NULL REFERENCES roles(id),
  application_date              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_channel                TEXT,
  sub_source                    TEXT,
  agency_id                     TEXT REFERENCES agencies(id),
  agency_fee_estimate           DECIMAL(10,2),
  stage                         TEXT NOT NULL DEFAULT 'Applied',
  status                        TEXT NOT NULL DEFAULT 'Active' CHECK (status IN (
                                  'Active','On Hold','Rejected','Withdrawn','Hold for Future','Joined','Closed')),
  recruiter_screening_status    TEXT NOT NULL DEFAULT 'New' CHECK (recruiter_screening_status IN (
                                  'New','Under Recruiter Review','Awaiting HM Review',
                                  'HM Shortlisted','Screening Hold','Screening Rejected')),
  current_ctc_fixed             DECIMAL(10,2),
  current_ctc_variable          DECIMAL(10,2),
  ectc                          DECIMAL(10,2),
  notice_period_days            INTEGER,
  current_location              TEXT,
  preferred_location            TEXT,
  resume_drive_link             TEXT,
  assignment_submission_link    TEXT,
  offer_letter_link             TEXT,
  ai_fit_score                  INTEGER CHECK (ai_fit_score BETWEEN 0 AND 100),
  ai_priority_bucket            TEXT CHECK (ai_priority_bucket IN ('Strong Fit','Review','Low Priority','Reject')),
  ai_skills_matched             TEXT[],
  ai_missing_skills             TEXT[],
  ai_risk_flags                 TEXT[],
  ai_eval_areas                 TEXT[],
  ai_score_summary              TEXT,
  ai_score_breakdown            JSONB,
  ai_scored_at                  TIMESTAMPTZ,
  hr_recruiter_summary          TEXT,
  hr_key_positives              TEXT,
  hr_key_concerns               TEXT,
  hr_comp_alignment             TEXT,
  hr_communication_assessment   TEXT,
  hr_priority_override          TEXT CHECK (hr_priority_override IN ('Normal','High','Critical')),
  hr_priority_override_reason   TEXT,
  hr_tags                       TEXT[],
  internal_risk_notes           TEXT,
  founder_review_flag           BOOLEAN NOT NULL DEFAULT false,
  founder_review_note           TEXT,
  founder_review_set_by         UUID REFERENCES users(id),
  founder_review_set_at         TIMESTAMPTZ,
  rejection_reason_cat          TEXT,
  rejection_reason_detail       TEXT,
  withdrawal_reason_cat         TEXT,
  withdrawal_reason_detail      TEXT,
  offer_stage                   TEXT,
  offer_approved_by             TEXT,
  offer_approval_date           DATE,
  offer_ctc_fixed               DECIMAL(10,2),
  offer_ctc_variable            DECIMAL(10,2),
  offer_joining_date            DATE,
  offer_sent_date               DATE,
  offer_accepted_date           DATE,
  joining_confidence            TEXT CHECK (joining_confidence IN ('High','Medium','Low')),
  last_hr_contact               DATE,
  joining_risk_notes            TEXT,
  joining_risk_auto_flag        BOOLEAN NOT NULL DEFAULT false,
  stage_entry_time              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sla_hours                     INTEGER,
  sla_breach                    BOOLEAN NOT NULL DEFAULT false,
  last_updated                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_action                   TEXT,
  next_action_owner             TEXT,
  UNIQUE(candidate_id, role_id)
);

CREATE INDEX idx_applications_candidate ON applications(candidate_id);
CREATE INDEX idx_applications_role      ON applications(role_id);
CREATE INDEX idx_applications_stage     ON applications(stage);
CREATE INDEX idx_applications_status    ON applications(status);
CREATE INDEX idx_applications_sla       ON applications(sla_breach) WHERE sla_breach = true;
CREATE INDEX idx_applications_founder   ON applications(founder_review_flag) WHERE founder_review_flag = true;

-- ─── Interview Rounds (after assignment_repo so FK works) ─────────────────────
CREATE TABLE interview_rounds (
  id                            TEXT PRIMARY KEY DEFAULT 'IR' || LPAD(nextval('seq_interview')::TEXT, 4, '0'),
  application_id                TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  round_name                    TEXT NOT NULL,
  round_type                    TEXT NOT NULL DEFAULT 'Standard' CHECK (round_type IN ('Standard','Assignment')),
  round_number                  INTEGER NOT NULL DEFAULT 1,
  interviewer_names             TEXT,
  scheduled_date                TIMESTAMPTZ,
  interview_mode                TEXT CHECK (interview_mode IN ('In-person','Video','Phone')),
  focus_areas                   TEXT[],
  feedback_status               TEXT NOT NULL DEFAULT 'Pending' CHECK (feedback_status IN ('Pending','Submitted','Overdue')),
  feedback_submitted_at         TIMESTAMPTZ,
  entered_by                    UUID REFERENCES users(id),
  eval_areas_assessed           TEXT[],
  scores_per_area               JSONB,
  overall_round_score           DECIMAL(3,1),
  confidence_level              TEXT CHECK (confidence_level IN ('Low','Medium','High')),
  overall_assessment            TEXT CHECK (overall_assessment IN ('Strong Positive','Positive','Neutral','Concern','Strong Concern')),
  strengths_observed            TEXT,
  key_concerns                  TEXT,
  unresolved_questions          TEXT,
  suggested_probe_areas         TEXT,
  round_recommendation          TEXT CHECK (round_recommendation IN ('Proceed','Proceed with Concerns','Hold','Reject')),
  notes                         TEXT,
  assignment_repo_id            TEXT REFERENCES assignment_repo(id),
  assignment_send_date          TIMESTAMPTZ,
  assignment_deadline           TIMESTAMPTZ,
  assignment_submission_date    TIMESTAMPTZ,
  assignment_submission_link    TEXT,
  assignment_outcome            TEXT CHECK (assignment_outcome IN ('Approved for Next Round','Assignment Resent','Rejected')),
  assignment_overall_score      DECIMAL(3,1),
  score_technical_accuracy      INTEGER CHECK (score_technical_accuracy BETWEEN 1 AND 5),
  score_problem_solving         INTEGER CHECK (score_problem_solving BETWEEN 1 AND 5),
  score_clarity                 INTEGER CHECK (score_clarity BETWEEN 1 AND 5),
  score_practical_thinking      INTEGER CHECK (score_practical_thinking BETWEEN 1 AND 5),
  score_completeness            INTEGER CHECK (score_completeness BETWEEN 1 AND 5),
  assignment_notes              TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rounds_application ON interview_rounds(application_id);
CREATE INDEX idx_rounds_status      ON interview_rounds(feedback_status);

-- ─── Reference Checks ─────────────────────────────────────────────────────────
CREATE TABLE ref_checks (
  id                  TEXT PRIMARY KEY DEFAULT 'RC' || LPAD(nextval('seq_refcheck')::TEXT, 3, '0'),
  application_id      TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  reference_contacts  TEXT,
  overall_outcome     TEXT CHECK (overall_outcome IN ('Strong Positive','Positive','Neutral','Concern','Red Flag')),
  positive_comments   TEXT,
  concerns_raised     TEXT,
  risk_level          TEXT CHECK (risk_level IN ('Low','Moderate','High')),
  ai_summary          TEXT,
  conducted_by        UUID REFERENCES users(id),
  conducted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Eval Questions ───────────────────────────────────────────────────────────
CREATE TABLE eval_questions (
  id               TEXT PRIMARY KEY DEFAULT 'Q' || LPAD(nextval('seq_refcheck')::TEXT, 3, '0'),
  evaluation_area  TEXT NOT NULL,
  role_category    TEXT NOT NULL DEFAULT 'All',
  experience_level TEXT NOT NULL DEFAULT 'All',
  question_text    TEXT NOT NULL,
  question_type    TEXT CHECK (question_type IN ('Behavioural','Technical','Situational','Case')),
  priority         TEXT CHECK (priority IN ('Mandatory','Recommended','Optional')),
  source           TEXT NOT NULL DEFAULT 'HR-Curated' CHECK (source IN ('HR-Curated','AI-Suggested')),
  approved         BOOLEAN NOT NULL DEFAULT true,
  added_by         UUID REFERENCES users(id),
  added_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Comp Benchmarks ──────────────────────────────────────────────────────────
CREATE TABLE comp_benchmarks (
  id                  TEXT PRIMARY KEY DEFAULT 'BEN' || LPAD(nextval('seq_refcheck')::TEXT, 3, '0'),
  role_category       TEXT NOT NULL,
  experience_range    TEXT NOT NULL,
  internal_band_min   DECIMAL(8,2),
  internal_band_max   DECIMAL(8,2),
  market_band_min     DECIMAL(8,2),
  market_band_max     DECIMAL(8,2),
  currency            TEXT NOT NULL DEFAULT 'LPA',
  notes               TEXT,
  last_updated        DATE,
  updated_by          UUID REFERENCES users(id)
);

-- ─── Activity Log ─────────────────────────────────────────────────────────────
CREATE TABLE activity_log (
  id                BIGSERIAL PRIMARY KEY,
  application_id    TEXT REFERENCES applications(id) ON DELETE SET NULL,
  candidate_id      TEXT REFERENCES candidates(id) ON DELETE SET NULL,
  role_id           TEXT REFERENCES roles(id) ON DELETE SET NULL,
  event_type        TEXT NOT NULL,
  event_detail      TEXT,
  old_value         TEXT,
  new_value         TEXT,
  performed_by      UUID REFERENCES users(id),
  performed_by_name TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activity_log_application ON activity_log(application_id);
CREATE INDEX idx_activity_log_candidate   ON activity_log(candidate_id);
CREATE INDEX idx_activity_log_created     ON activity_log(created_at DESC);

-- ─── Pending Actions ──────────────────────────────────────────────────────────
CREATE TABLE pending_actions (
  id             BIGSERIAL PRIMARY KEY,
  owner_type     TEXT NOT NULL,
  priority_level TEXT NOT NULL DEFAULT 'High' CHECK (priority_level IN ('Critical','High','Normal')),
  action_type    TEXT NOT NULL,
  description    TEXT NOT NULL,
  application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  candidate_name TEXT,
  role_title     TEXT,
  hours_overdue  DECIMAL(6,1) NOT NULL DEFAULT 0,
  resolved       BOOLEAN NOT NULL DEFAULT false,
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pending_actions_owner    ON pending_actions(owner_type);
CREATE INDEX idx_pending_actions_resolved ON pending_actions(resolved) WHERE resolved = false;

-- ─── Notification Log ─────────────────────────────────────────────────────────
CREATE TABLE notification_log (
  id             BIGSERIAL PRIMARY KEY,
  application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
  method         TEXT NOT NULL CHECK (method IN ('email','whatsapp','sms','call')),
  direction      TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  outcome        TEXT,
  notes          TEXT,
  logged_by      UUID REFERENCES users(id),
  logged_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Triggers ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER roles_updated_at      BEFORE UPDATE ON roles      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER applications_updated_at BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER candidates_updated_at BEFORE UPDATE ON candidates  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER interview_rounds_updated_at BEFORE UPDATE ON interview_rounds FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION flag_ctc_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.ctc_band IS DISTINCT FROM NEW.ctc_band THEN
    INSERT INTO pending_actions (owner_type, priority_level, action_type, description, role_title)
    VALUES ('Leadership / Founders','High','Compensation change flag',
      'CTC band changed on ' || NEW.title || ': "' || COALESCE(OLD.ctc_band,'—') || '" → "' || COALESCE(NEW.ctc_band,'—') || '"',
      NEW.title);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER roles_ctc_change AFTER UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION flag_ctc_change();

COMMIT;
