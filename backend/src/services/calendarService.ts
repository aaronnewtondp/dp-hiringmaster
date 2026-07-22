import { google } from 'googleapis';
import { randomUUID } from 'crypto';
import { getGoogleCredentials } from './googleAuth.js';

const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

// Unlike driveService.ts's fixed-impersonation singleton, Calendar
// impersonates whoever is scheduling the round — a different subject per
// request — so there's no single client to cache. This only runs at most
// once per POST /interviews, not a hot path, so a fresh JWT client per call
// is fine.
function getCalendarClient(impersonateEmail: string) {
  const credentials = getGoogleCredentials();
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: CALENDAR_SCOPES,
    subject: impersonateEmail,
  });
  return google.calendar({ version: 'v3', auth });
}

export interface CreateInterviewEventInput {
  organizerEmail:  string;   // impersonated subject — the scheduling HR user
  attendees:       string[]; // interviewer emails
  summary:         string;
  description:     string;
  startTime:       string;  // ISO / TIMESTAMPTZ string
  durationMinutes: number;
  mode:            'In-person' | 'Video' | 'Phone';
}

export interface CreatedCalendarEvent {
  eventId:   string;
  eventLink: string;
  meetLink?: string;
}

// Throws on failure — the caller (interviews.ts POST /) treats a failed
// invite as non-fatal, visible degradation: the round row is already
// committed by the time this runs.
export async function createInterviewCalendarEvent(
  input: CreateInterviewEventInput
): Promise<CreatedCalendarEvent> {
  const calendar = getCalendarClient(input.organizerEmail);
  const start = new Date(input.startTime);
  const end = new Date(start.getTime() + input.durationMinutes * 60_000);
  const wantsMeet = input.mode === 'Video';

  const res = await calendar.events.insert({
    calendarId: 'primary',
    // REQUIRED — the Calendar API defaults sendUpdates to 'none'. Without
    // this the event is created silently and no attendee is ever emailed,
    // which defeats the point (the invite email IS the notification).
    sendUpdates: 'all',
    conferenceDataVersion: wantsMeet ? 1 : 0,
    requestBody: {
      summary: input.summary,
      description: input.description,
      start: { dateTime: start.toISOString() },
      end:   { dateTime: end.toISOString() },
      attendees: input.attendees.map(email => ({ email })),
      ...(wantsMeet ? {
        conferenceData: {
          createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
        },
      } : {}),
    },
  });

  const eventId = res.data.id;
  if (!eventId) throw new Error('Calendar event created but no event ID was returned');

  return {
    eventId,
    eventLink: res.data.htmlLink || `https://calendar.google.com/calendar/event?eid=${eventId}`,
    meetLink: res.data.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri ?? undefined,
  };
}
