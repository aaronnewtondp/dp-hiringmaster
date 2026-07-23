import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidateWithApp, uid } from '../helpers/api';
import { getCalendarEvent, deleteCalendarEvent, hasCalendarCredentials } from '../helpers/calendar';

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

test.describe('Calendar integration on POST /api/interviews', () => {

  test('Calendar sync is skipped for Assignment rounds', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { application } = await createCandidateWithApp(request, token);

    await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Assignment Round' });

    // scheduled_date AND interviewer_emails both deliberately set here, valid
    // and non-empty — proving round_type alone is what gates the sync.
    // Assignment rounds have no meeting to put on a calendar, so this must
    // never reach out to Google regardless of what else is in the body.
    const res = await api.post('/api/interviews', {
      application_id:     application.id,
      round_name:         'Assignment Round',
      round_number:       1,
      round_type:         'Assignment',
      scheduled_date:     '2027-02-01T10:00:00+05:30',
      interviewer_emails: [`calendar-test-interviewer+${uid()}@example.com`],
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.calendar).toBeFalsy();
  });

  test('Calendar sync is skipped when scheduled_date or interviewer_emails is missing', async ({ request }) => {
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
      scheduled_date: '2027-02-01T10:00:00+05:30',
      // interviewer_emails intentionally omitted
    });
    expect(resA.status()).toBe(201);
    expect((await resA.json()).calendar).toBeFalsy();

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
    expect((await resB.json()).calendar).toBeFalsy();
  });

  test('Standard round with a real scheduled_date + interviewer_emails creates a real Calendar event (real external call)', async ({ request }) => {
    // Degrades gracefully wherever the real service-account key isn't
    // available (e.g. a fresh clone/CI) rather than failing hard.
    test.skip(!hasCalendarCredentials(), 'No local Google service-account credentials available');

    // Two real network round-trips to Google (create via the app's own sync,
    // then a direct fetch to verify it landed correctly), plus cleanup.
    test.setTimeout(30_000);

    // 'hr' (aaron.newton@digitalpaani.com) is the one test persona confirmed
    // this session to be a real Google Workspace mailbox usable for
    // impersonation. 'hr2'/garima@ is a genuine HMS user but NOT a real
    // Workspace mailbox — using her as organizer fails with "invalid_grant:
    // Invalid email or User ID" (expected, not a bug to chase here).
    const token = await getToken(request, 'hr');
    const api   = authed(request, token);
    const { candidate, application } = await createCandidateWithApp(request, token);
    await api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 1' });

    const interviewerEmail = `calendar-test-interviewer+${uid()}@example.com`;
    // Far-future, fixed instant with an explicit +05:30 offset — this is the
    // exact shape the frontend now sends (see this session's timezone fix),
    // and lets us assert the instant lands with zero drift.
    const scheduledDate = '2027-01-15T11:00:00+05:30';

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
