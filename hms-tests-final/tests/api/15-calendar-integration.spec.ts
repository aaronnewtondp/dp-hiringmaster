import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidateWithApp, uid } from '../helpers/api';
import { getCalendarEvent, deleteCalendarEvent, hasCalendarCredentials } from '../helpers/calendar';
import { futureIso } from '../helpers/dates';

// ─── Google Calendar integration on POST /api/interviews ──────────────────────
// Calendar sync is attempted synchronously (not fire-and-forget, unlike
// ResumeIQ/JD generation) only when round_type === 'Standard' AND
// scheduled_date is set AND interviewer_emails is a non-empty array — see
// interviews.ts's gating check right after the round INSERT. Most of this
// file (tests 1 and 2 below) only needs to prove that gate is airtight, which
// is free and fast: any combination that fails the gate never calls out to
// Google at all.
//
// interviewer_emails FORMAT validation (400 on non-array / bad email string)
// is deliberately NOT covered here — that's tests/api/07-interviews.spec.ts's
// job. This file is scoped to calendar sync *behavior* only.
//
// The exception is the last test, which — like
// tests/api/10-jd-generation-and-scoring.spec.ts's real Claude/Drive calls —
// is intentionally allowed to make one real external call: local Docker has
// a real Google service-account key mounted with domain-wide delegation
// already configured for calendar.events, so a Standard round scheduled with
// a real interviewer email WILL create a real event on the impersonated
// organizer's actual Google Calendar. Kept to exactly one such test, and
// cleaned up explicitly afterward (see tests/helpers/calendar.ts's comment on
// why this one real side effect can't just be left in place like file 10's).
//
// That same test now also asserts the resume-link-in-description and
// hr@digitalpaani.com-in-attendees features. Worth knowing: hr@digitalpaani
// .com is a real, actively-monitored inbox (candidates email resumes there),
// and interviews.ts unconditionally adds it as an attendee — so every run of
// this specific test sends a real calendar-invite notification email to
// that inbox for a fake "Technical Round" interview (deleting the event
// afterward removes it from the calendar but can't recall an already-sent
// notification email). This is an accepted consequence of testing the
// feature as specified, not a bug in the test — the same real email fires
// for every actual interview scheduled in production from now on too.

test.describe('Calendar integration on POST /api/interviews', () => {

  test('Calendar sync is skipped for Assignment rounds', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);

    await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Assignment Round' });

    // scheduled_date AND interviewer_emails both deliberately set here, valid
    // and non-empty — proving round_type alone is what gates the sync.
    // Assignment rounds have no meeting to put on a calendar, so this must
    // never reach out to Google's Calendar API regardless of what else is in
    // the body. mail_body_content/assignment_link are required for Assignment
    // rounds now (they instead trigger a Gmail send, asserted separately in
    // 07-interviews.spec.ts) — present here only so this request isn't
    // rejected before it can prove the calendar-specific assertion below.
    const res = await api.post('/api/interviews', {
      application_id:     application.id,
      round_name:         'Assignment Round',
      round_number:       1,
      round_type:         'Assignment',
      scheduled_date:     futureIso(30, { hour: 10, offset: '+05:30' }),
      interviewer_emails: [`calendar-test-interviewer+${uid()}@example.com`],
      mail_body_content:  'Please find your assignment below.',
      assignment_link:    'https://drive.google.com/test-assignment',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.calendar).toBeFalsy();
  });

  // A round created without one of these two fields used to leave `calendar`
  // absent from the response entirely — the frontend's `if (res.data
  // .calendar)` toast never fired, so a user got a plain "round scheduled"
  // success with zero indication no invite was ever attempted (exactly what
  // a real HR user hit scheduling a round with no interviewer set). Fixed to
  // always populate `calendar` for a Standard round with a real, specific
  // reason instead of staying silent.
  test('Calendar sync is skipped when scheduled_date or interviewer_emails is missing', async ({ request }) => {
    // Two candidate creations below each trigger a real, synchronous
    // ResumeIQ scoring call now (runResumeIQScoring at creation time — see
    // CLAUDE.md's "Pipeline stage model simplified" note), which didn't
    // exist when this test was written against Playwright's 30s default.
    test.setTimeout(60_000);
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);

    // (a) scheduled_date present, interviewer_emails omitted
    const { application: appA } = await createCandidateWithApp(request, token);
    await api.post(`/api/applications/${appA.id}/stage`, { new_stage: 'Interview Round 1' });
    const resA = await api.post('/api/interviews', {
      application_id: appA.id,
      round_name:     'Technical Round',
      round_number:   1,
      round_type:     'Standard',
      scheduled_date: futureIso(30, { hour: 10, offset: '+05:30' }),
      // interviewer_emails intentionally omitted
    });
    expect(resA.status()).toBe(201);
    const calendarA = (await resA.json()).calendar;
    expect(calendarA.synced).toBe(false);
    expect(calendarA.error).toContain('interviewer emails');

    // (b) interviewer_emails present, scheduled_date omitted
    const { application: appB } = await createCandidateWithApp(request, token);
    await api.post(`/api/applications/${appB.id}/stage`, { new_stage: 'Interview Round 1' });
    const resB = await api.post('/api/interviews', {
      application_id:     appB.id,
      round_name:         'Technical Round',
      round_number:       1,
      round_type:         'Standard',
      interviewer_emails: [`calendar-test-interviewer+${uid()}@example.com`],
      // scheduled_date intentionally omitted
    });
    expect(resB.status()).toBe(201);
    const calendarB = (await resB.json()).calendar;
    expect(calendarB.synced).toBe(false);
    expect(calendarB.error).toContain('scheduled date');
  });

  // @live: this creates a REAL event on a real calendar and invites real inboxes (hr@digitalpaani.com, always), so it runs only with
  // TEST_LIVE=1 (`npm run test:live`). Two independent skips, both about what is ACTUALLY possible rather than about a file on disk:
  //   * the RUNNER must hold the Google key (hasCalendarCredentials): verifying the event and deleting it afterwards is done from here;
  //     without it the event could not be cleaned up, so none is created;
  //   * the BACKEND must be able to impersonate the organizer: when the insert is refused (delegation not granted, "invalid_grant"), the
  //     round is still committed and the failure is persisted, which is read back and used as the skip reason instead of a red test.
  test('@live Standard round with a real scheduled_date + interviewer_emails creates a real Calendar event (real external call)', async ({ request }) => {
    test.skip(!hasCalendarCredentials(), 'No local Google service-account credentials available: the event could not be verified or cleaned up');

    // Two real network round-trips to Google (create via the app's own sync, then a direct fetch to verify it landed correctly), plus
    // cleanup — within the project's 60 s test timeout, stated here because this test is the slowest one.
    test.setTimeout(60_000);

    // 'hr' (aaron.newton@digitalpaani.com) is the one test persona confirmed
    // this session to be a real Google Workspace mailbox usable for
    // impersonation. 'hr2'/garima@ is a genuine HMS user but NOT a real
    // Workspace mailbox — using her as organizer fails with "invalid_grant:
    // Invalid email or User ID" (expected, not a bug to chase here).
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { candidate, application } = await createCandidateWithApp(request, token);
    await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 1' });

    // Resume link is sourced from the candidate's own resume_drive_link at
    // send time — set one here so the description assertion below has a
    // real, known value to check for.
    const resumeLink = `https://drive.google.com/file/d/calendar-test-${uid()}/view`;
    await api.patch(`/api/candidates/${candidate.id}`, { resume_drive_link: resumeLink });

    const interviewerEmail = `calendar-test-interviewer+${uid()}@example.com`;
    // An instant 45 days ahead with an explicit +05:30 offset — this is the exact shape the frontend sends (see the timezone fix), and lets
    // us assert the instant lands with zero drift. Computed from the clock: a hard-coded date would become "the past" one day.
    const scheduledDate = futureIso(45, { hour: 11, offset: '+05:30' });

    const res = await api.post('/api/interviews', {
      application_id:     application.id,
      round_name:         'Technical Round',
      round_number:       1,
      round_type:         'Standard',
      scheduled_date:     scheduledDate,
      duration_minutes:   30,
      interviewer_emails: [interviewerEmail],
    });
    expect(res.status()).toBe(201);
    const body = await res.json();

    if (body.calendar?.synced !== true) {
      // The route persists the underlying Google error on the round (calendar_sync_error); read it back to tell "this backend cannot
      // create events" (skip) from any other failure (fall through to the assertion below, which fails).
      const { rounds } = await (await api.get(`/api/interviews?application_id=${application.id}`)).json();
      const reason: string = rounds.find((r: { id: string }) => r.id === body.round.id)?.calendar_sync_error ?? '';
      test.skip(/invalid_grant|unauthorized_client|No Google service account credentials/i.test(reason), `the backend cannot create calendar events here: ${reason}`);
    }
    expect(body.calendar?.synced).toBe(true);
    expect(body.round.calendar_event_id).toBeTruthy();
    expect(body.round.calendar_event_link).toBeTruthy();

    const eventId = body.round.calendar_event_id as string;
    try {
      const event = await getCalendarEvent('aaron.newton@digitalpaani.com', eventId);
      expect(event).toBeTruthy();

      // Confirms the exact instant landed correctly with no drift — this is
      // the regression the +05:30 fix guards against.
      expect(event!.start?.dateTime).toBe(scheduledDate);

      const attendeeEmails = (event!.attendees || []).map(a => (a.email || '').toLowerCase());
      expect(attendeeEmails).toContain(interviewerEmail.toLowerCase());
      expect(attendeeEmails).toContain((candidate.email as string).toLowerCase());
      // hr@digitalpaani.com is always cc'd on every interview invite,
      // regardless of who scheduled it.
      expect(attendeeEmails).toContain('hr@digitalpaani.com');

      // Candidate's resume Drive link (set above) is always included in the
      // event description so interviewers have it on hand.
      expect(event!.description).toContain(resumeLink);

      expect(event!.organizer?.email).toBe('aaron.newton@digitalpaani.com');
    } finally {
      // Unlike the rest of this suite's real-external-call data (no delete
      // route to bother with — see file 10), a stray event sits on an
      // actual person's actual calendar, so it always gets cleaned up here,
      // even if an assertion above throws.
      await deleteCalendarEvent('aaron.newton@digitalpaani.com', eventId);
    }
  });
});
