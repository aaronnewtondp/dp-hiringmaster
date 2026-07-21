/**
 * Apps Script trigger for the Job Application Form's "Common Master Form
 * Responses" sheet. Reference copy only — the live script lives in the
 * Sheet's own Script editor (Extensions → Apps Script), same as the
 * Requisition Form trigger. Keep this file in sync if the live script
 * changes, so future sessions don't have to re-derive it from scratch.
 *
 * Bound to an installable "On form submit" trigger (Triggers → Add Trigger
 * → onFormSubmit → From spreadsheet → On form submit).
 *
 * Why this isn't a simple field-by-field mapping: this sheet is ONE
 * branching form covering every role (each role has its own section of
 * questions), so several question titles — "Resume", "Mention any relevant
 * qualifications..." — repeat once per role branch. Apps Script's
 * e.namedValues buckets identically-titled columns into an array; only the
 * one matching the respondent's chosen role branch is actually filled in.
 * "Years of experience" isn't one question at all — every role branch asks
 * its own different YOE sub-question(s) — so it's deliberately NOT sent
 * here rather than guessed via a fragile per-role column lookup that would
 * break silently every time the form's sections change.
 */

const CANDIDATE_INGEST_URL = 'https://dp-hiringmaster-be.vercel.app/api/candidates/ingest';
const CANDIDATE_INGEST_SECRET = 'PASTE_THE_SECRET_HERE'; // must match Vercel's CANDIDATE_INGEST_SECRET

function onFormSubmit(e) {
  const v = (col) => (e.namedValues[col] && e.namedValues[col][0]) || '';

  // Same-titled columns repeat once per role branch — take whichever one
  // the respondent's branch actually filled in.
  function firstNonEmpty(col) {
    const raw = e.namedValues[col];
    if (!raw) return '';
    const list = Array.isArray(raw) ? raw : [raw];
    for (const val of list) {
      if (val && String(val).trim() !== '') return String(val).trim();
    }
    return '';
  }

  // Real submissions mix "11 LPA", "800000", "5.5LPA(5.5 Fixed + 0
  // Variables)" — extract the first number, and if it's clearly a raw
  // rupee figure (>1000) rather than an LPA figure, normalize by /100000.
  function parseCtcLpa(raw) {
    if (!raw) return '';
    const match = String(raw).replace(/,/g, '').match(/\d+(\.\d+)?/);
    if (!match) return '';
    const num = parseFloat(match[0]);
    return num > 1000 ? String(num / 100000) : String(num);
  }

  // Real submissions include "Immediately joine", "IMMEDIATE", "0 days",
  // plain numbers — extract the first number, treat "immediate" as 0.
  function parseNoticeDays(raw) {
    if (!raw) return '';
    if (/immediat/i.test(raw)) return '0';
    const match = String(raw).match(/\d+/);
    return match ? match[0] : '';
  }

  const payload = {
    timestamp: v('Timestamp'),
    email: v('Email address'),
    full_name: v('Full Name'),
    phone: v('Phone Number'),
    current_ctc_fixed: parseCtcLpa(v('Current CTC (Fixed and Variable breakup) in LPA')),
    expected_ctc: parseCtcLpa(v('Expected CTC in LPA')),
    notice_period_days: parseNoticeDays(v('Notice Period in days')),
    current_location: v('Current Location'),
    preferred_location: v('Preferred Location'),
    current_company: v('Current Company'),
    current_industry: v('Current Industry'),
    languages_known: v('Languages Known'),
    resume_drive_link: firstNonEmpty('Resume'),
    role_applied_for: v('Role Applying For'),
    // Asked once per role branch, like "Resume" — take whichever one the
    // respondent's branch actually filled in.
    qualifications_note: firstNonEmpty('Mention any relevant qualifications, skills, experience to support your application'),
    // current_esops, current_designation, years_of_experience: not asked by
    // this form (no ESOPs/designation question; YOE is role-branch-specific
    // — see file header) — omitted rather than guessed.
  };

  const response = UrlFetchApp.fetch(CANDIDATE_INGEST_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  console.log('Candidate ingest response: ' + response.getResponseCode() + ' ' + response.getContentText());
}
