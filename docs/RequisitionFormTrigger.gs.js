/**
 * Requisition Form → HMS role ingestion trigger. Reference copy only — the
 * live script lives in the Sheet's own Script editor (Extensions → Apps
 * Script), same as the Job Application Form trigger. Keep this file in sync
 * if the live script changes, so future sessions don't have to re-derive it
 * from scratch.
 *
 * Verified against the live Requisition Form Responses sheet's actual
 * header row on 2026-08-02 — every COLUMNS index below matched the sheet's
 * real column order at that time; re-verify here if the form's sections are
 * ever edited, since e.values is positional (unlike the Job Application
 * trigger's e.namedValues, this breaks silently on any column reorder).
 *
 * SETUP:
 * 1. Open the Requisition Form Responses sheet:
 *    https://docs.google.com/spreadsheets/d/1Jt30Oh0Sh4_5YYROfidPqDCjNzniadZ39azzBAN6uus
 * 2. Extensions → Apps Script
 * 3. Paste this entire file, replacing any existing content
 * 4. Update HMS_API_URL and INGEST_SECRET below
 * 5. Click the clock icon (Triggers) → Add Trigger:
 *      Function: onFormSubmit
 *      Event source: From spreadsheet
 *      Event type: On form submit
 * 6. Save. Authorize when prompted (first run only).
 *
 * Every new form submission will now automatically create a Draft role in HMS.
 */

const HMS_API_URL   = 'https://dp-hiringmaster-be.vercel.app/api/roles/ingest';
const INGEST_SECRET = 'PASTE_THE_SECRET_HERE'; // must match Vercel's ROLE_INGEST_SECRET

const COLUMNS = {
  TIMESTAMP: 0, EMAIL: 1, DEPARTMENT: 2, HIRING_MANAGER: 3, REQUIRED_BY: 4,
  PRIORITY: 5, NEW_OR_REPLACEMENT: 6, VACANCY_REASON: 7, JOB_TITLE: 8,
  NUM_OPENINGS: 9, LOCATION: 10, APPOINTMENT_TYPE: 11, QUALIFICATION: 12,
  MUST_HAVE_SKILLS: 13, NICE_TO_HAVE_SKILLS: 14, YOE: 15, CTC_BAND: 16,
  JOB_DESCRIPTION: 17, ADDITIONAL_REMARKS: 18, START_DATE: 21,
  // 19 ("Recruitment Mode") and 20 ("Status") are deliberately unmapped —
  // both are HR-decided operationally, after the role already exists in
  // HMS, not values the requisition submitter provides at creation time.
};

function onFormSubmit(e) {
  const row = e.values;

  const payload = {
    timestamp: row[COLUMNS.TIMESTAMP] || '',
    email: row[COLUMNS.EMAIL] || '',
    department: row[COLUMNS.DEPARTMENT] || '',
    hiring_manager: row[COLUMNS.HIRING_MANAGER] || '',
    priority_level: row[COLUMNS.PRIORITY] || '',
    new_or_replacement: row[COLUMNS.NEW_OR_REPLACEMENT] || '',
    vacancy_reason: row[COLUMNS.VACANCY_REASON] || '',
    job_title: row[COLUMNS.JOB_TITLE] || '',
    num_openings: row[COLUMNS.NUM_OPENINGS] || '1',
    location: row[COLUMNS.LOCATION] || '',
    appointment_type: row[COLUMNS.APPOINTMENT_TYPE] || '',
    qualification_required: row[COLUMNS.QUALIFICATION] || '',
    must_have_skills: row[COLUMNS.MUST_HAVE_SKILLS] || '',
    nice_to_have_skills: row[COLUMNS.NICE_TO_HAVE_SKILLS] || '',
    yoe_required: row[COLUMNS.YOE] || '',
    ctc_band: row[COLUMNS.CTC_BAND] || '',
    kpi_expectations: row[COLUMNS.JOB_DESCRIPTION] || '',
    additional_remarks: row[COLUMNS.ADDITIONAL_REMARKS] || '',
    // Sourced from "Required By (Date)" (the requisition submitter's own
    // target), not the sheet's separate "Target Closure Date" column
    // (index 22, HR-tracked post-creation) — intentional, not a typo, but
    // worth re-confirming with HR if this ever looks wrong downstream.
    target_closure_date: row[COLUMNS.REQUIRED_BY] || '',
    start_date: row[COLUMNS.START_DATE] || '',
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-ingest-secret': INGEST_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch(HMS_API_URL, options);
    const code = response.getResponseCode();
    const body = response.getContentText();

    if (code === 201) {
      Logger.log('Role created: ' + body);
    } else if (code === 200) {
      Logger.log('Duplicate skipped: ' + body);
    } else {
      Logger.log('Ingest failed (' + code + '): ' + body);
    }
  } catch (err) {
    Logger.log('Exception calling HMS: ' + err);
  }
}

function testIngestManually() {
  const fakeRow = [
    new Date().toISOString(), 'test@digitalpaani.com', 'Engineering', 'Test Manager',
    '2026-12-31', 'P2', 'New Position', 'Business Expansion',
    'Test Role - Apps Script Verification', '1', 'Remote',
    'Full-Time / Permanent', 'Bachelors degree',
    'Test must-have skill', 'Test nice-to-have skill',
    '2+ years', '10-15 LPA', 'Test job description', 'Test remarks',
    '', '', '', '2026-08-01',
  ];
  onFormSubmit({ values: fakeRow });
}
