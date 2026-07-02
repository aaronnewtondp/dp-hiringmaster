-- DigitalPaani HMS — Seed Data
-- Provides: system users, 7 active roles, 15 agencies, 12 benchmarks, 13 eval questions

BEGIN;

-- ─── Users ────────────────────────────────────────────────────────────────────
-- Passwords are 'password123' — MUST be changed before going to production
-- Hash generated with: bcrypt.hashSync('password123', 12)
INSERT INTO users (id, name, email, password_hash, persona, department) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Aaron Newton',      'aaron.newton@digitalpaani.com',   '$2a$12$ju95lKBJLSFRbZqxq6Car.Btpyo0aHDsqieUEHRr.AH/xkep6lDBe', 'hr_recruiter',   'Operations'),
  ('a0000000-0000-0000-0000-000000000002', 'Garima',            'garima@digitalpaani.com',         '$2a$12$ju95lKBJLSFRbZqxq6Car.Btpyo0aHDsqieUEHRr.AH/xkep6lDBe', 'hr_recruiter',   'HR'),
  ('a0000000-0000-0000-0000-000000000003', 'Alex',              'alex@digitalpaani.com',           '$2a$12$ju95lKBJLSFRbZqxq6Car.Btpyo0aHDsqieUEHRr.AH/xkep6lDBe', 'hiring_manager', 'Product/QA'),
  ('a0000000-0000-0000-0000-000000000004', 'Satyadev',          'satyadev@digitalpaani.com',       '$2a$12$ju95lKBJLSFRbZqxq6Car.Btpyo0aHDsqieUEHRr.AH/xkep6lDBe', 'hiring_manager', 'Project Implementation'),
  ('a0000000-0000-0000-0000-000000000005', 'Deeksha Chaturvedi','deeksha@digitalpaani.com',        '$2a$12$ju95lKBJLSFRbZqxq6Car.Btpyo0aHDsqieUEHRr.AH/xkep6lDBe', 'hiring_manager', 'Domain'),
  ('a0000000-0000-0000-0000-000000000006', 'Mandeep Dagar',     'mandeep@digitalpaani.com',        '$2a$12$ju95lKBJLSFRbZqxq6Car.Btpyo0aHDsqieUEHRr.AH/xkep6lDBe', 'hiring_manager', 'Tech/Dev'),
  ('a0000000-0000-0000-0000-000000000007', 'Nalin',             'nalin@digitalpaani.com',          '$2a$12$ju95lKBJLSFRbZqxq6Car.Btpyo0aHDsqieUEHRr.AH/xkep6lDBe', 'leadership',     'Leadership'),
  ('a0000000-0000-0000-0000-000000000008', 'Mansi Jain',        'mansi@digitalpaani.com',          '$2a$12$ju95lKBJLSFRbZqxq6Car.Btpyo0aHDsqieUEHRr.AH/xkep6lDBe', 'leadership',     'Leadership')
ON CONFLICT (email) DO NOTHING;

-- ─── Roles (7 active as of May 2026) ─────────────────────────────────────────
INSERT INTO roles (
  id, title, department, hiring_manager_name, priority, status,
  new_replacement, num_openings, location, employment_type,
  yoe_required, ctc_band, kpi_expectations, must_have_skills, nice_to_have_skills,
  suggested_interviewers, assignment_required, recruitment_mode,
  start_date, target_closure_date, created_by
) VALUES
(
  'R001', 'Sr. Backend Developer', 'Tech/Dev', 'Mandeep Dagar', 'P1', 'Live – Sourcing',
  'Replacement', 1, 'Gurgaon', 'Full-Time / Permanent',
  '3+ years', '18-24 LPA',
  'Deliver scalable backend services with <1% downtime. Reduce API latency by 20% within 90 days. Mentor 2 junior developers within 6 months.',
  'Node.js 3+ years; TypeScript; RESTful APIs; PostgreSQL/MongoDB; Docker; AWS/GCP; Microservices; CI/CD pipelines',
  'LLM API integration; Vector databases; RAG pipelines; Python ML tooling; GraphQL',
  'Mandeep Dagar, Alex, Nalin', true, ARRAY['Naukri','LinkedIn'],
  '2026-04-27', '2026-05-30',
  (SELECT id FROM users WHERE email = 'aaron.newton@digitalpaani.com')
),
(
  'R002', 'E&I Engineer (Mumbai)', 'Project Implementation', 'Satyadev', 'P2', 'Live – Sourcing',
  'New Position', 1, 'Mumbai/Pune', 'Full-Time / Permanent',
  '1-2 years', '3-3.5 LPA',
  'Execute 3+ site onboardings per quarter. Zero electrical safety incidents. PLC/SCADA commissioning sign-off within project timelines.',
  'Electrical & Instrumentation 2+ years; PLC/HMI/SCADA; MCC panel retrofitting; Site execution; Willingness to travel extensively',
  'Great attitude; ownership mindset; experience with STP/ETP sites',
  'Satyadev, Aaron Newton', false, ARRAY['Naukri','Employee Referral'],
  '2026-04-27', '2026-05-30',
  (SELECT id FROM users WHERE email = 'aaron.newton@digitalpaani.com')
),
(
  'R003', 'Sr. E&I Engineer (Hyderabad)', 'Project Implementation', 'Satyadev', 'P1', 'Live – Sourcing',
  'New Position', 2, 'Hyderabad, Bangalore', 'Full-Time / Permanent',
  '3-5 years', '4.5-5.5 LPA',
  'Lead execution of 4+ sites per quarter. Mentor junior E&I technicians. Drive 100% on-time handovers.',
  'Electrical & Instrumentation 3-5 years; PLC/HMI/SCADA; MCC panel retrofitting; Team leadership; Willingness to travel',
  'Experience managing execution teams; SLD/BOQ documentation expertise; STP/ETP domain knowledge',
  'Satyadev, Aaron Newton', false, ARRAY['Naukri','Employee Referral'],
  '2026-04-27', '2026-05-30',
  (SELECT id FROM users WHERE email = 'aaron.newton@digitalpaani.com')
),
(
  'R004', 'Manager – Process & Proposals', 'Domain', 'Deeksha Chaturvedi', 'P1', 'Live – Sourcing',
  'New Position', 1, 'Hyderabad/Pune/Bangalore', 'Full-Time / Permanent',
  '5+ years', '7-10 LPA',
  'Lead 8+ technical proposals per month. Onboard 2 new industrial clients per quarter. Deliver 95% accuracy on design assessments.',
  'Wastewater treatment design 5+ years; Process modelling; Technical sales solutioning; Willingness to travel; B.Tech Chemical/Environmental/Civil Engineering',
  'Simulation software (WaterGEMS, GPS-X); Cooling towers/RO/WTP knowledge; Cross-sell/upsell experience',
  'Deeksha Chaturvedi, Aaron Newton, Nalin', true, ARRAY['Naukri','LinkedIn'],
  '2026-04-27', '2026-05-30',
  (SELECT id FROM users WHERE email = 'aaron.newton@digitalpaani.com')
),
(
  'R005', 'Quality Assurance Engineer', 'Product/QA', 'Alex', 'P1', 'Live – Sourcing',
  'New Position', 1, 'Gurgaon', 'Full-Time / Permanent',
  '5+ years', '10-15 LPA',
  'Achieve 95%+ test coverage on critical paths within 30 days. Reduce regression cycle time by 30%. Ship 0 P0 bugs to production.',
  '5+ years tech experience; 2+ years QA; Manual testing; Functional/integration/E2E; BDD/Cucumber; SDLC/Agile; B.Tech/B.Sc CSE',
  'Selenium/Cypress/Playwright automation; AI QA tools; CI/CD test integration',
  'Alex, Mandeep Dagar', true, ARRAY['Naukri','LinkedIn','IIMJobs','Employee Referral'],
  '2026-04-27', '2026-05-30',
  (SELECT id FROM users WHERE email = 'aaron.newton@digitalpaani.com')
),
(
  'R006', 'Senior Product Manager', 'Product/QA', 'Alex', 'P1', 'Live – Sourcing',
  'New Position', 1, 'Gurgaon', 'Full-Time / Permanent',
  '5-8 years', '18-25 LPA',
  'Own full roadmap for IoT data pipeline + operational workflows. Reduce spec-to-build cycle by 25%. Achieve 90% engineering satisfaction score on specs.',
  '5-8 years PM; IoT/industrial software/process engineering background; Field user discovery experience; Track record on non-consumer non-SaaS products',
  'Sensor science/calibration knowledge; Water/utilities domain experience; Manages complex feature dependencies independently',
  'Alex, Cross-functional, Nalin', true, ARRAY['Naukri','LinkedIn','Employee Referral','Direct Outreach'],
  '2026-05-16', '2026-06-30',
  (SELECT id FROM users WHERE email = 'aaron.newton@digitalpaani.com')
),
(
  'R007', 'Senior UX/Product Designer', 'Product/QA', 'Alex', 'P1', 'Live – Sourcing',
  'New Position', 1, 'Gurgaon', 'Full-Time / Permanent',
  '5-7 years', '15-18 LPA',
  'Ship production-ready screens for 3 core flows within 45 days. Establish component library used by engineering team. Conduct 2 field visits per quarter.',
  '5-7 years UX/Product design; B2B/operations product portfolio; Field/frontline user design; Mobile-first Android design; Component-based design systems',
  'AI design tools (Figma AI, v0, generative UI); Independent user research; Tight engineering handoff skills',
  'Alex, Nalin', true, ARRAY['Naukri','LinkedIn','Employee Referral'],
  '2026-05-16', '2026-06-30',
  (SELECT id FROM users WHERE email = 'aaron.newton@digitalpaani.com')
);

-- ─── Agencies ─────────────────────────────────────────────────────────────────
INSERT INTO agencies (id, name, contract_status, tier1_band, tier1_rate, tier2_band, tier2_rate, tier3_band, tier3_rate, replacement_guarantee_days, notes) VALUES
  ('AGN001', 'Teamplus Staffing',    'Active', 'All',        '7%',    NULL,       NULL,   NULL,       NULL,    60, NULL),
  ('AGN002', 'CliqHR',              'Active', 'All',        '8.33%', NULL,       NULL,   NULL,       NULL,    60, 'Need to revert for updated terms'),
  ('AGN003', 'Talhive',             'Active', '0-30 LPA',   '9%',    '30-70 LPA','11%',  '70+ LPA',  '12.5%', 60, NULL),
  ('AGN004', 'Anzy Global',         'Active', 'All',        NULL,    NULL,       NULL,   NULL,       NULL,    60, NULL),
  ('AGN005', 'Pipal Tree Services', 'Active', 'All',        '12%',   NULL,       NULL,   NULL,       NULL,    60, NULL),
  ('AGN006', 'Antal',               'Active', 'All',        '14%',   NULL,       NULL,   NULL,       NULL,    60, 'Senior/Leadership specialist'),
  ('AGN007', 'Myndcrest',           'Active', 'All',        NULL,    NULL,       NULL,   NULL,       NULL,    60, NULL),
  ('AGN008', 'ClimateHires',        'Active', 'Junior-Senior','12%', 'Leadership/CXO','16%', NULL,   NULL,    60, 'Climate/impact focus. 12% discount on first 3 hirings.'),
  ('AGN009', 'Grizmo Labs',         'Active', '0-12 LPA',   '8.33%', '12-25 LPA','10%', '25+ LPA', '12.5%', 60, NULL),
  ('AGN010', 'Talent Corner',       'Active', 'All',        '8.33%', NULL,       NULL,   NULL,       NULL,    60, NULL),
  ('AGN011', 'Intellectual Capital','Active', '0-15 LPA',   '8.33%', '15-30 LPA','10%', '30+ LPA', '12.5%', 60, NULL),
  ('AGN012', '91HR',                'Active', 'All',        '8.33%', NULL,       NULL,   NULL,       NULL,    60, NULL),
  ('AGN013', 'Careerfit',           'Active', 'All',        '8.33%', NULL,       NULL,   NULL,       NULL,    60, NULL),
  ('AGN014', 'GoldenBridge',        'Active', '0-15 LPA',   '8.33%', '15-35 LPA','11%', '35+ LPA', '13%',   60, NULL),
  ('AGN015', 'Conviction HR',       'Active', 'All',        '10%',   NULL,       NULL,   NULL,       NULL,    60, 'Contact: Tanmay');

-- ─── Compensation Benchmarks ─────────────────────────────────────────────────
INSERT INTO comp_benchmarks (id, role_category, experience_range, internal_band_min, internal_band_max, market_band_min, market_band_max, currency, last_updated) VALUES
  ('BEN001', 'Sr. Backend Developer',          '3-5 years',   18, 24, 20, 28, 'LPA', '2026-05-01'),
  ('BEN002', 'QA Engineer',                    '5+ years',    10, 15, 12, 18, 'LPA', '2026-05-01'),
  ('BEN003', 'Senior Product Manager',         '5-8 years',   18, 25, 22, 30, 'LPA', '2026-05-01'),
  ('BEN004', 'Senior UX/Product Designer',     '5-7 years',   15, 18, 16, 22, 'LPA', '2026-05-01'),
  ('BEN005', 'E&I Engineer (Onsite)',           '1-2 years',    3,  3.5, 3, 4.5,'LPA', '2026-05-01'),
  ('BEN006', 'Sr. E&I Engineer (Onsite)',       '3-5 years',  4.5, 5.5, 5,   7, 'LPA', '2026-05-01'),
  ('BEN007', 'Service Engineer',               '2-5 years',    4,  6, 4.5,   7, 'LPA', '2026-05-01'),
  ('BEN008', 'Industry Sales Lead',            '8-12 years',  16, 25, 18,  28, 'LPA', '2026-05-01'),
  ('BEN009', 'Regional Manager – Sales',       '5-10 years',  16, 25, 18,  28, 'LPA', '2026-05-01'),
  ('BEN010', 'Govt. Tender Lead',              '10-15 years', 16, 25, 20,  30, 'LPA', '2026-05-01'),
  ('BEN011', 'Process & Proposals Manager',    '5-8 years',    7, 10,  8,  12, 'LPA', '2026-05-01'),
  ('BEN012', 'Head of Engineering',            '12+ years',   30, 45, 35,  50, 'LPA', '2026-05-01');

-- ─── Evaluation Question Bank ─────────────────────────────────────────────────
INSERT INTO eval_questions (id, evaluation_area, role_category, experience_level, question_text, question_type, priority, source, added_by) VALUES
  ('Q001', 'Ownership',           'All',            'All',    'What''s the hardest business problem you solved end-to-end? What did you personally own versus what did the team own?', 'Behavioural', 'Mandatory', 'HR-Curated', (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com')),
  ('Q002', 'Ownership',           'All',            'All',    'Tell me about a time something was going wrong on your watch and it was partly your fault. What did you do?', 'Behavioural', 'Mandatory', 'HR-Curated', (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com')),
  ('Q003', 'Communication',       'All',            'All',    'Tell me about a time you had to influence someone without authority. What was the situation and what was the outcome?', 'Behavioural', 'Mandatory', 'HR-Curated', (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com')),
  ('Q004', 'Leadership',          'All',            'Senior', 'Describe the biggest org or team change you''ve driven. Why, how, and what happened?', 'Behavioural', 'Mandatory', 'HR-Curated', (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com')),
  ('Q005', 'Cultural Fit',        'All',            'All',    'What does our mission mean to you? What specifically about DigitalPaani''s work excited you enough to apply?', 'Situational', 'Mandatory', 'HR-Curated', (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com')),
  ('Q006', 'Problem Solving',     'All',            'All',    'When was your output or performance way off track? What caused it and what did you do about it?', 'Behavioural', 'Recommended', 'HR-Curated', (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com')),
  ('Q007', 'Cultural Fit',        'All',            'All',    'Describe a team you didn''t fit in with. What happened?', 'Behavioural', 'Recommended', 'HR-Curated', (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com')),
  ('Q008', 'Technical',           'Technical',      'All',    'Walk me through how you would design a backend service that needs to handle 10,000 IoT sensor events per minute.', 'Technical', 'Mandatory', 'HR-Curated', (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com')),
  ('Q009', 'Domain Knowledge',    'Site Engineering','All',   'How would you troubleshoot a PLC/SCADA communication failure on site? Walk me through your diagnostic process step by step.', 'Technical', 'Mandatory', 'HR-Curated', (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com')),
  ('Q010', 'Domain Knowledge',    'Sales',          'All',    'Walk me through your most complex B2B sale. What was the stakeholder map, what objections did you face, and how did you close?', 'Case', 'Mandatory', 'HR-Curated', (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com')),
  ('Q011', 'Domain Knowledge',    'Domain',         'All',    'How would you approach designing a treatment solution for an industrial effluent with high TDS and heavy metals? What data would you need first?', 'Technical', 'Mandatory', 'HR-Curated', (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com')),
  ('Q012', 'Project Depth',       'All',            'Mid',    'Pick the project you''re most proud of. What would you do differently if you started it today?', 'Behavioural', 'Recommended', 'HR-Curated', (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com')),
  ('Q013', 'Communication',       'All',            'All',    'What''s the toughest piece of feedback you''ve given to someone? What was the impact and what did you learn from it?', 'Behavioural', 'Recommended', 'HR-Curated', (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com'));

-- ─── Assignment Repository (seed) ────────────────────────────────────────────
INSERT INTO assignment_repo (id, name, role_category, experience_level, skills_covered, difficulty_level, problem_statement, evaluation_rubric, created_by) VALUES
  ('ASN001', 'Backend API Design Challenge', 'Technical', 'Mid',
   ARRAY['System Design','Node.js','API Design','Database Design'],
   'High',
   'Design and implement a REST API for a real-time water quality monitoring system. The API should handle ingestion of sensor readings (pH, TDS, flow rate) from 100+ sites at 1-minute intervals, support querying historical data with time-range filters, and expose an alert endpoint when readings breach thresholds. Provide: (1) API design document, (2) Database schema, (3) Key code snippets for the ingestion and alert logic.',
   'Technical Accuracy 40% · Problem Solving 25% · Clarity & Structure 15% · Practical Thinking 10% · Completeness 10%',
   (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com')),
  ('ASN002', 'QA Test Plan Exercise', 'Technical', 'Mid',
   ARRAY['Test Planning','Manual Testing','BDD','Defect Management'],
   'Medium',
   'You are given a description of a mobile feature: operators at water treatment plants need to log daily readings and flag anomalies. Write a test plan covering: (1) Functional test cases for the happy path and 5 edge cases, (2) A BDD-style feature file with at least 3 scenarios, (3) A defect report template, (4) Your approach to regression testing when the feature is updated.',
   'Technical Accuracy 40% · Problem Solving 25% · Clarity & Structure 15% · Practical Thinking 10% · Completeness 10%',
   (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com')),
  ('ASN003', 'Product Spec — Operator Alert Flow', 'Technical', 'Senior',
   ARRAY['Product Thinking','Spec Writing','User Research','Prioritisation'],
   'High',
   'A plant operator needs to receive alerts when their water treatment system detects an anomaly. Currently this is done via WhatsApp messages from a central NOC team. Write a product spec for a native in-app alert system. Your spec must cover: (1) User stories for the operator and NOC supervisor, (2) Functional requirements and acceptance criteria, (3) Edge cases and failure modes, (4) What you would NOT build in v1 and why.',
   'Technical Accuracy 40% · Problem Solving 25% · Clarity & Structure 15% · Practical Thinking 10% · Completeness 10%',
   (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com')),
  ('ASN004', 'Process & Proposals Case', 'Domain', 'Senior',
   ARRAY['Process Design','Technical Writing','Client Communication','Wastewater Treatment'],
   'High',
   'You receive the following from a prospective client: "We operate a textile dyeing facility in Surat. Our ETP currently handles 500 KLD. We are facing colour removal issues and our discharge is above GPCB norms for COD and colour. We need a solution." Prepare: (1) A list of clarifying questions you would ask before proposing a solution (with rationale), (2) A high-level treatment scheme you would propose based on typical textile effluent characteristics, (3) A one-page proposal outline.',
   'Technical Accuracy 40% · Problem Solving 25% · Clarity & Structure 15% · Practical Thinking 10% · Completeness 10%',
   (SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com'));

COMMIT;

-- ─── Advance sequences past seeded data so next INSERT gets a fresh ID ────────
SELECT setval('seq_role',       (SELECT MAX(CAST(REPLACE(id,'R','') AS INTEGER)) FROM roles));
SELECT setval('seq_candidate',  1);
SELECT setval('seq_application',1);
SELECT setval('seq_interview',  1);
SELECT setval('seq_agency',     (SELECT MAX(CAST(REPLACE(id,'AGN','') AS INTEGER)) FROM agencies));
SELECT setval('seq_assignment', (SELECT MAX(CAST(REPLACE(id,'ASN','') AS INTEGER)) FROM assignment_repo));
SELECT setval('seq_refcheck',   1);
