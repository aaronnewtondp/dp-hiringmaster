// ─────────────────────────────────────────────────────────────────────────────
// External sends (Gmail assignment / rejection e-mails, Google Calendar invites) — the parts that need NO test seam.
//
// What a test can assert about a send without a fake Google:
//   * REQUEST VALIDATION: everything the route refuses before it would send, and the proof that a refused request changes nothing.
//   * STATE AGREES WITH THE ANSWER: the route is "graceful" — the round / status change is committed first and a failed send is reported in
//     the response and persisted (assignment_email_error, calendar_sync_error, rejection_email_error + activity rows). Whether a send succeeds
//     depends on credentials, so these tests assert the INVARIANT that links response, row and activity log, true in both outcomes.
//   * A candidate WITHOUT an e-mail address: the send is refused before Google is ever contacted, so the outcome is deterministic.
//   * A Standard round with no date or no interviewer: no invite is attempted, so `calendar_sync_error` is deterministic too.
// What it cannot: success semantics, retry clearing a stored error, the real attendee list. Those need a fake provider (a backend test seam,
// not built here) or the live lane (tests/api/15 is @live).
//
// Nothing here can reach a person: candidates are @example.com addresses, interviewers are @example.com, the only real address involved is the
// shared hr@ inbox that the backend adds to a Calendar invite itself — and the one test that attempts an invite is skipped on a runner that
// holds the Google key (see its comment).
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { CRON_SECRET, authed, createCandidate, getToken, uid } from '../helpers/api';
import { hasCalendarCredentials } from '../helpers/calendar';
import { futureIso } from '../helpers/dates';
import { withDb } from '../helpers/db';
import { activityOf, applicationRow, newApplicationAt, newRound, pendingRows, rawStatus, roundsOf } from '../helpers/api-specs';

const MAIL = { mail_body_content: 'Please find your assignment below.', assignment_link: 'https://example.com/assignment' };

const assignmentContext = (request: Parameters<typeof newApplicationAt>[0]) => newApplicationAt(request, 'Assignment Round', 'R006');
const stored = async (hr: ReturnType<typeof authed>, applicationId: string, roundId: string) =>
  (await roundsOf(hr, applicationId)).find(r => r.id === roundId)!;
const eventTypes = async (hr: ReturnType<typeof authed>, applicationId: string) => (await activityOf(hr, applicationId)).map(a => a.event_type as string);

test.describe('POST /api/interviews — an Assignment round is refused before any send when the request is wrong', () => {

  test('mail_body_content and assignment_link are both required (400) and the refusal leaves no round behind', async ({ request }) => {
    const { hr, application } = await assignmentContext(request);
    const base = { application_id: application.id, round_name: 'Assignment Round', round_type: 'Assignment' };
    for (const body of [base, { ...base, mail_body_content: MAIL.mail_body_content }, { ...base, assignment_link: MAIL.assignment_link }, { ...base, mail_body_content: '', assignment_link: '' }]) {
      const res = await hr.post('/api/interviews', body);
      expect(res.status(), JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe('mail_body_content and assignment_link are required for Assignment rounds');
    }
    expect(await roundsOf(hr, application.id)).toHaveLength(0);
    expect(await eventTypes(hr, application.id)).not.toContain('Interview Round Scheduled');
  });

  test('cc must be an array of valid e-mail strings: a string, a number entry or a malformed entry is 400 (the bad value is named)', async ({ request }) => {
    const { hr, application } = await assignmentContext(request);
    const base = { application_id: application.id, round_name: 'Assignment Round', round_type: 'Assignment', ...MAIL };

    for (const cc of ['hr@example.com', 7, { a: 1 }, ['ok@example.com', 3]]) {
      const res = await hr.post('/api/interviews', { ...base, cc });
      expect(res.status(), JSON.stringify(cc)).toBe(400);
      expect((await res.json()).error).toBe('cc must be an array of strings');
    }
    const bad = await hr.post('/api/interviews', { ...base, cc: ['ok@example.com', 'not-an-email'] });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toBe('"not-an-email" is not a valid email address');
    expect(await roundsOf(hr, application.id)).toHaveLength(0);
  });

  test('interviewer_emails must be an array of valid e-mail strings on any round type: 400 naming the bad value, nothing stored', async ({ request }) => {
    const { hr, application } = await assignmentContext(request);
    const base = { application_id: application.id, round_name: 'Assignment Round', round_type: 'Assignment', ...MAIL };

    const notStrings = await hr.post('/api/interviews', { ...base, interviewer_emails: [123, 'a@example.com'] });
    expect(notStrings.status()).toBe(400);
    expect((await notStrings.json()).error).toBe('interviewer_emails must be an array of strings');
    for (const bad of ['plainaddress', 'two@@example.com', 'no-tld@example', 'spa ce@example.com']) {
      const res = await hr.post('/api/interviews', { ...base, interviewer_emails: ['a@example.com', bad] });
      expect(res.status(), bad).toBe(400);
      expect((await res.json()).error).toBe(`"${bad}" is not a valid email address`);
    }
    expect(await roundsOf(hr, application.id)).toHaveLength(0);
  });

  test('application_id and round_name are required (400), an unknown application is 404, and a Hiring Manager is 403 before any of it', async ({ request }) => {
    const { hr, application } = await assignmentContext(request);
    const missing = await hr.post('/api/interviews', { round_name: 'x', ...MAIL });
    expect(missing.status()).toBe(400);
    expect((await missing.json()).error).toBe('application_id and round_name required');
    const noName = await hr.post('/api/interviews', { application_id: application.id, ...MAIL });
    expect(noName.status()).toBe(400);

    const unknown = await hr.post('/api/interviews', { application_id: `A-NOPE-${uid()}`, round_name: 'Assignment Round', round_type: 'Assignment', ...MAIL });
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).error).toBe('Application not found');

    const hm = authed(request, await getToken(request, 'hm_alex'));
    const forbidden = await hm.post('/api/interviews', { application_id: `A-NOPE-${uid()}`, round_name: 'x' });   // 403, not 404: requireHR runs first
    expect(forbidden.status()).toBe(403);
  });

  test('cc is only validated for Assignment rounds: a Standard round ignores a malformed cc entry (pinned as it is)', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Interview Round 1', 'R006');
    const res = await hr.post('/api/interviews', { application_id: application.id, round_name: 'Round 1', cc: ['not-an-email'] });
    expect(res.status()).toBe(201);
  });
});

test.describe('POST /api/interviews/:id/assignment-send — request validation (a refused retry changes nothing)', () => {

  test('missing fields and a malformed cc are 400; an unknown round is 404; a Standard round is 400; a Hiring Manager is 403', async ({ request }) => {
    const { hr, application } = await assignmentContext(request);
    const { round } = await newRound(hr, application.id, { round_name: 'Assignment Round', round_type: 'Assignment', ...MAIL, cc: ['first.cc@example.com'] });
    const before = await stored(hr, application.id, round.id);
    expect(before.assignment_link).toBe(MAIL.assignment_link);

    const noBody = await hr.post(`/api/interviews/${round.id}/assignment-send`, { assignment_link: 'https://example.com/other' });
    expect(noBody.status()).toBe(400);
    expect((await noBody.json()).error).toBe('mail_body_content and assignment_link are required');
    const noLink = await hr.post(`/api/interviews/${round.id}/assignment-send`, { mail_body_content: 'x' });
    expect(noLink.status()).toBe(400);
    const badCc = await hr.post(`/api/interviews/${round.id}/assignment-send`, { ...MAIL, assignment_link: 'https://example.com/other', cc: 'string-not-array' });
    expect(badCc.status()).toBe(400);
    expect((await badCc.json()).error).toBe('cc must be an array of strings');
    const badEntry = await hr.post(`/api/interviews/${round.id}/assignment-send`, { ...MAIL, assignment_link: 'https://example.com/other', cc: ['nope'] });
    expect(badEntry.status()).toBe(400);
    expect((await badEntry.json()).error).toBe('"nope" is not a valid email address');
    // None of the refusals overwrote what the round had stored.
    const after = await stored(hr, application.id, round.id);
    expect(after.assignment_link).toBe(MAIL.assignment_link);
    expect(after.assignment_cc).toEqual(['first.cc@example.com']);

    const unknown = await hr.post(`/api/interviews/IR-NOPE-${uid()}/assignment-send`, MAIL);
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).error).toBe('Round not found');

    const interview = await newApplicationAt(request, 'Interview Round 1', 'R006');
    const standard = await newRound(interview.hr, interview.application.id);
    const notAssignment = await interview.hr.post(`/api/interviews/${standard.round.id}/assignment-send`, MAIL);
    expect(notAssignment.status()).toBe(400);
    expect((await notAssignment.json()).error).toBe('This round is not configured as an Assignment round');

    const hm = authed(request, await getToken(request, 'hm_alex'));
    const forbidden = await hm.post(`/api/interviews/IR-NOPE-${uid()}/assignment-send`, MAIL);
    expect(forbidden.status()).toBe(403);
  });

  test('anonymous callers are 401 on every send route', async ({ request }) => {
    for (const p of ['/api/interviews', '/api/interviews/IR0001/assignment-send', '/api/interviews/IR0001/assignment-submit']) {
      const res = await rawStatus(request, 'POST', p, { data: {} });
      expect(res.status, p).toBe(401);
    }
  });
});

test.describe('Assignment e-mail — the persisted round always agrees with the response (true whether or not Google is reachable)', () => {

  function expectAgreement(
    email: { sent: boolean; error?: string } | undefined,
    row: Record<string, any>,
    events: string[],
    expectedAttempts: { sent: number; failed: number },
  ) {
    expect(email, 'an Assignment round always carries an email outcome').toBeDefined();
    expect(typeof email!.sent).toBe('boolean');
    if (email!.sent) {
      expect(email!.error).toBeUndefined();
      expect(row.assignment_send_date).toBeTruthy();
      expect(row.assignment_deadline).toBeTruthy();
      expect(row.assignment_email_error).toBeNull();
      // The deadline is 60 hours after the send.
      const hours = (new Date(row.assignment_deadline).getTime() - new Date(row.assignment_send_date).getTime()) / 3_600_000;
      expect(hours).toBeGreaterThan(59.9);
      expect(hours).toBeLessThan(60.1);
    } else {
      expect(typeof email!.error).toBe('string');
      expect(email!.error!.length).toBeGreaterThan(0);
      expect(row.assignment_send_date).toBeNull();
      expect(row.assignment_deadline).toBeNull();
      expect(typeof row.assignment_email_error).toBe('string');
      expect(row.assignment_email_error.length).toBeGreaterThan(0);
      expect(row.assignment_email_error.length).toBeLessThanOrEqual(500);
    }
    expect(events.filter(e => e === 'Assignment Email Sent')).toHaveLength(expectedAttempts.sent);
    expect(events.filter(e => e === 'Assignment Email Failed')).toHaveLength(expectedAttempts.failed);
  }

  test('creating the round stores exactly what was submitted, never moves the stage, and sent / error / dates / activity agree', async ({ request }) => {
    const { hr, application } = await assignmentContext(request);
    const submitted = {
      round_name: 'Assignment Round', round_type: 'Assignment', ...MAIL,
      cc: ['cc.one@example.com', 'cc.two@example.com'], supporting_documentation: 'https://example.com/supporting',
    };
    const { round, email, calendar } = await newRound(hr, application.id, submitted);
    expect(calendar).toBeUndefined();                                       // Assignment rounds never touch the calendar

    const row = await stored(hr, application.id, round.id);
    expect(row).toMatchObject({
      round_type: 'Assignment', assignment_mail_body: MAIL.mail_body_content, assignment_link: MAIL.assignment_link,
      assignment_cc: submitted.cc, assignment_supporting_docs: submitted.supporting_documentation, calendar_sync_error: null, calendar_event_id: null,
    });
    expect((await applicationRow(application.id)).stage).toBe('Assignment Round');

    const events = await eventTypes(hr, application.id);
    const sent = email?.sent === true;
    expectAgreement(email, row, events, { sent: sent ? 1 : 0, failed: sent ? 0 : 1 });
    expect(events).toContain('Interview Round Scheduled');
  });

  test('a retry through assignment-send overwrites the stored mail fields with the retry\'s values and keeps response, row and activity in agreement', async ({ request }) => {
    const { hr, application } = await assignmentContext(request);
    const first = await newRound(hr, application.id, { round_name: 'Assignment Round', round_type: 'Assignment', ...MAIL, cc: ['old.cc@example.com'] });
    const firstSent = first.email?.sent === true;

    const retry = { mail_body_content: 'Retrying: updated brief.', assignment_link: 'https://example.com/assignment-v2', cc: ['new.cc@example.com'], supporting_documentation: 'https://example.com/extra' };
    const res = await hr.post(`/api/interviews/${first.round.id}/assignment-send`, retry);
    expect(res.status()).toBe(200);                                         // a failed send is reported in the body, never as an HTTP error
    const body = await res.json();
    expect(body.round.id).toBe(first.round.id);

    const row = await stored(hr, application.id, first.round.id);
    expect(row).toMatchObject({
      assignment_mail_body: retry.mail_body_content, assignment_link: retry.assignment_link,
      assignment_cc: retry.cc, assignment_supporting_docs: retry.supporting_documentation,
    });
    const events = await eventTypes(hr, application.id);
    const retrySent = body.email.sent === true;
    expectAgreement(body.email, row, events, { sent: Number(firstSent) + Number(retrySent), failed: Number(!firstSent) + Number(!retrySent) });
  });
});

test.describe('a candidate with no e-mail address — the send is refused before Google is contacted (deterministic)', () => {

  async function applicationWithoutEmail(request: Parameters<typeof newApplicationAt>[0], stage: string) {
    const hrToken = await getToken(request, 'hr');
    const hr = authed(request, hrToken);
    const { candidate, res } = await createCandidate(request, hrToken, { email: undefined, role_id: 'R006' });
    expect(res.status()).toBe(201);
    expect(candidate.email).toBeNull();
    const application = (await res.json()).application as { id: string };
    const move = await hr.post(`/api/applications/${application.id}/stage`, { new_stage: stage });
    expect(move.status()).toBe(200);
    return { hr, application, candidate };
  }

  test('Assignment round: 201, email.sent=false with the specific message, and the row records that candidate had no address', async ({ request }) => {
    const { hr, application } = await applicationWithoutEmail(request, 'Assignment Round');
    const { round, email } = await newRound(hr, application.id, { round_name: 'Assignment Round', round_type: 'Assignment', ...MAIL });
    expect(email).toEqual({ sent: false, error: 'Candidate has no email on file — cannot send assignment.' });
    const row = await stored(hr, application.id, round.id);
    expect(row.assignment_email_error).toBe('Candidate has no email on file.');
    expect(row.assignment_send_date).toBeNull();
    expect(row.assignment_deadline).toBeNull();
  });

  test('assignment-send retry: still 200 with the same specific message, and the mail fields of the retry are stored anyway', async ({ request }) => {
    const { hr, application } = await applicationWithoutEmail(request, 'Assignment Round');
    const { round } = await newRound(hr, application.id, { round_name: 'Assignment Round', round_type: 'Assignment', ...MAIL });
    const res = await hr.post(`/api/interviews/${round.id}/assignment-send`, { mail_body_content: 'again', assignment_link: 'https://example.com/again' });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.email).toEqual({ sent: false, error: 'Candidate has no email on file — cannot send assignment.' });
    expect(body.round).toMatchObject({ assignment_mail_body: 'again', assignment_link: 'https://example.com/again', assignment_email_error: 'Candidate has no email on file.' });
  });

  test('TODAY: the 201 response\'s own round.assignment_email_error is null for this refusal although the row stores it (only the Gmail-failure path patches the in-memory round)', async ({ request }) => {
    const { hr, application } = await applicationWithoutEmail(request, 'Assignment Round');
    const { round } = await newRound(hr, application.id, { round_name: 'Assignment Round', round_type: 'Assignment', ...MAIL });
    expect(round.assignment_email_error ?? null).toBeNull();
    expect((await stored(hr, application.id, round.id)).assignment_email_error).toBe('Candidate has no email on file.');
  });

  test('TODAY: this refusal writes no activity row at all (a send that reaches Google and fails logs "Assignment Email Failed"; this one is silent)', async ({ request }) => {
    const { hr, application } = await applicationWithoutEmail(request, 'Assignment Round');
    await newRound(hr, application.id, { round_name: 'Assignment Round', round_type: 'Assignment', ...MAIL });
    const events = await eventTypes(hr, application.id);
    expect(events).not.toContain('Assignment Email Failed');
    expect(events).not.toContain('Assignment Email Sent');
  });

  test('rejection e-mail: the rejection is committed (200), email.sent=false with the specific message, rejection_email_error is stored, nothing was sent', async ({ request }) => {
    const { hr, application } = await applicationWithoutEmail(request, 'Applied and Screened');
    const res = await hr.post(`/api/applications/${application.id}/status`, {
      new_status: 'Rejected', rejection_reason_cats: ['Skills Mismatch'], send_rejection_email: true,
      rejection_email_subject: 'Your application', rejection_email_body: 'Thank you for applying.',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, new_status: 'Rejected', email: { sent: false, error: 'Candidate has no email on file — cannot send rejection email.' } });

    const row = await applicationRow(application.id);
    expect(row.status).toBe('Rejected');                                     // never rolled back by the failed mail
    expect(row.rejection_email_error).toBe('Candidate has no email on file.');
    expect(row.rejection_email_sent_at).toBeNull();
  });
});

test.describe('POST /api/applications/:id/status — rejection e-mail validation (refused before anything changes)', () => {

  test('send_rejection_email only goes with Rejected, and needs both subject and body (400); the status is untouched', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    const onHold = await hr.post(`/api/applications/${application.id}/status`, {
      new_status: 'Hold for Future', send_rejection_email: true, rejection_email_subject: 's', rejection_email_body: 'b',
    });
    expect(onHold.status()).toBe(400);
    expect((await onHold.json()).error).toBe('send_rejection_email is only valid when new_status is Rejected');

    const base = { new_status: 'Rejected', rejection_reason_cats: ['Skills Mismatch'], send_rejection_email: true };
    for (const body of [{ ...base }, { ...base, rejection_email_subject: 's' }, { ...base, rejection_email_body: 'b' }]) {
      const res = await hr.post(`/api/applications/${application.id}/status`, body);
      expect(res.status(), JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe('rejection_email_subject and rejection_email_body are required to send a rejection email');
    }
    expect((await applicationRow(application.id)).status).toBe('Active');
    expect((await activityOf(hr, application.id)).map(a => a.event_type)).not.toContain('Status Changed');
  });

  test('the reason requirement is checked first: a rejection with an e-mail but no reason is the reason error, not the e-mail error', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    const res = await hr.post(`/api/applications/${application.id}/status`, { new_status: 'Rejected', send_rejection_email: true });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('A reason is required when rejecting or withdrawing a candidate');
  });

  test('with an address on file the rejection e-mail outcome and the stored columns agree (sent XOR error), and the status is committed either way', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    const res = await hr.post(`/api/applications/${application.id}/status`, {
      new_status: 'Rejected', rejection_reason_cats: ['Skills Mismatch'], send_rejection_email: true,
      rejection_email_subject: `Update ${uid()}`, rejection_email_body: 'Thank you for applying.',
    });
    expect(res.status()).toBe(200);
    const { email } = await res.json();
    const row = await applicationRow(application.id);
    const events = (await activityOf(hr, application.id)).map(a => a.event_type);
    expect(row.status).toBe('Rejected');
    if (email.sent) {
      expect(row.rejection_email_sent_at).toBeTruthy();
      expect(row.rejection_email_error).toBeNull();
      expect(events).toContain('Rejection Email Sent');
    } else {
      expect(row.rejection_email_sent_at).toBeNull();
      expect(row.rejection_email_error).toBeTruthy();
      expect(email.error).toContain('Candidate rejected, but the email failed to send');
      expect(events).toContain('Rejection Email Failed');
    }
  });
});

test.describe('POST /api/interviews — Standard round and the Calendar', () => {

  test('no date, or no interviewer: no invite is attempted, calendar.synced=false carries the reason, and the same reason is stored on the round', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Interview Round 1', 'R006');

    const noDate = await newRound(hr, application.id, { interviewer_emails: [`interviewer+${uid()}@example.com`] });
    expect(noDate.calendar?.synced).toBe(false);
    expect(noDate.calendar?.error).toContain('scheduled date/time');
    expect(noDate.calendar?.error).not.toContain('interviewer emails');
    const noDateRow = await stored(hr, application.id, noDate.round.id);
    expect(noDateRow.calendar_sync_error).toBe(noDate.calendar!.error);
    expect(noDateRow.calendar_event_id).toBeNull();

    const noInterviewer = await newRound(hr, application.id, { scheduled_date: futureIso(30, { hour: 10, offset: '+05:30' }) });
    expect(noInterviewer.calendar?.synced).toBe(false);
    expect(noInterviewer.calendar?.error).toContain('interviewer emails');
    expect(noInterviewer.calendar?.error).not.toContain('scheduled date');
    expect((await stored(hr, application.id, noInterviewer.round.id)).calendar_sync_error).toBe(noInterviewer.calendar!.error);

    const neither = await newRound(hr, application.id, {});
    expect(neither.calendar?.error).toContain('scheduled date/time');
    expect(neither.calendar?.error).toContain('interviewer emails');

    // No attempt was made, so nothing about an invite is in the activity log.
    const events = await eventTypes(hr, application.id);
    expect(events).not.toContain('Calendar Invite Created');
    expect(events).not.toContain('Calendar Invite Failed');
  });

  test('a round WITHOUT a scheduled date does not resolve the "Interview 1 Not Scheduled" breach (only a real date does)', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Interview Round 1', 'R006');
    // Make the breach real: 50 h in the stage, then one SLA sweep (the same engine a dashboard load runs).
    await withDb(c => c.query(`UPDATE applications SET stage_entry_time = NOW() - INTERVAL '50 hours' WHERE id = $1`, [application.id]));
    const sweep = await authed(request, CRON_SECRET).post('/api/cron/sla-check', {});
    expect(sweep.status()).toBe(200);
    const open = async () => (await pendingRows(application.id)).filter(r => r.action_type === 'Interview 1 Not Scheduled' && !r.resolved);
    expect(await open()).toHaveLength(1);

    // A round that is only a placeholder ("TBD": no scheduled_date) is not "scheduled" yet.
    await newRound(hr, application.id, { interviewer_emails: [`interviewer+${uid()}@example.com`] });
    expect(await open()).toHaveLength(1);
    expect((await applicationRow(application.id)).sla_breach).toBe(true);
  });

  // The ONE test that attempts a real invite. With the isolated stack's backend (no Google credentials) the attempt fails deterministically,
  // which is the failure path worth pinning: the round is committed, the response says so, the error is stored and logged. If the backend
  // DID hold credentials the same request would create a real event on a real calendar (and mail hr@ and the interviewer) — that is
  // tests/api/15's @live test, with its own clean-up — so this one skips on any runner that has the Google key file.
  test('an attempted invite that fails: round committed (201), calendar.synced=false with the fixed message, calendar_sync_error stored, "Calendar Invite Failed" logged', async ({ request }) => {
    test.skip(hasCalendarCredentials(), 'this runner has the Google service-account key: the backend may too, and the invite could be real (see tests/api/15, @live)');
    const { hr, application } = await newApplicationAt(request, 'Interview Round 1', 'R006');
    const { round, calendar } = await newRound(hr, application.id, {
      scheduled_date: futureIso(30, { hour: 11, offset: '+05:30' }), interviewer_emails: [`interviewer+${uid()}@example.com`],
    });
    expect(calendar).toEqual({
      synced: false,
      error: 'Round scheduled, but the calendar invite failed — you may need to notify interviewers manually.',
    });
    const row = await stored(hr, application.id, round.id);
    expect(row.calendar_event_id).toBeNull();
    expect(row.calendar_event_link).toBeNull();
    expect(typeof row.calendar_sync_error).toBe('string');
    expect(row.calendar_sync_error.length).toBeGreaterThan(0);
    expect(row.calendar_sync_error.length).toBeLessThanOrEqual(500);
    const failed = (await activityOf(hr, application.id)).find(a => a.event_type === 'Calendar Invite Failed');
    expect(failed?.event_detail).toBe(calendar!.error);
  });
});
