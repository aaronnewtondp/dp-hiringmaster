import { describe, it, expect, vi, beforeEach } from 'vitest';

// createInterviewCalendarEvent: the rules that were learned the hard way and are invisible in review. sendUpdates MUST be 'all' (the API default is 'none':
// the event would be created silently and nobody e-mailed); a Meet conference is requested only for Video; the end time is start + duration; the event is
// created on behalf of the scheduling user (a different JWT subject per call); an event with no id is an error. googleapis and the credentials are faked: no
// network, no key.
const g = vi.hoisted(() => ({
  insert: vi.fn(),
  jwtOptions: [] as Array<Record<string, unknown>>,
  calendarOptions: [] as Array<Record<string, unknown>>,
  credentials: vi.fn(),
}));
vi.mock('./googleAuth.js', () => ({ getGoogleCredentials: () => g.credentials() }));
vi.mock('googleapis', () => ({
  google: {
    auth: { JWT: class { constructor(o: Record<string, unknown>) { g.jwtOptions.push(o); } } },
    calendar: (o: Record<string, unknown>) => { g.calendarOptions.push(o); return { events: { insert: g.insert } }; },
  },
}));

import { createInterviewCalendarEvent, CreateInterviewEventInput } from './calendarService.js';

const BASE: CreateInterviewEventInput = {
  organizerEmail: 'scheduler@example.test',
  attendees: ['interviewer.one@example.test', 'interviewer.two@example.test'],
  summary: 'Interview Round 1: Synthetic Role',
  description: 'Synthetic description',
  startTime: '2026-11-02T10:00:00+05:30',
  durationMinutes: 45,
  mode: 'Video',
};
const body = () => g.insert.mock.calls[0][0].requestBody;
const sent = () => g.insert.mock.calls[0][0];

beforeEach(() => {
  g.insert.mockReset().mockResolvedValue({ data: { id: 'evt123', htmlLink: 'https://calendar.example.test/event/evt123' } });
  g.jwtOptions.length = 0; g.calendarOptions.length = 0;
  g.credentials.mockReset().mockReturnValue({ client_email: 'sa@example.iam.test', private_key: 'placeholder-key' });
});

describe('createInterviewCalendarEvent: the API call', () => {
  it.each(['Video', 'In-person', 'Phone'] as const)('%s: inserts on the primary calendar with sendUpdates "all" (without it no attendee is e-mailed)', async mode => {
    await createInterviewCalendarEvent({ ...BASE, mode });
    expect(g.insert).toHaveBeenCalledTimes(1);
    expect(sent().calendarId).toBe('primary');
    expect(sent().sendUpdates).toBe('all');
  });

  it('summary and description are passed through; each attendee becomes {email}', async () => {
    await createInterviewCalendarEvent(BASE);
    expect(body().summary).toBe('Interview Round 1: Synthetic Role');
    expect(body().description).toBe('Synthetic description');
    expect(body().attendees).toEqual([{ email: 'interviewer.one@example.test' }, { email: 'interviewer.two@example.test' }]);
  });

  it('no attendees gives an empty list (not undefined)', async () => {
    await createInterviewCalendarEvent({ ...BASE, attendees: [] });
    expect(body().attendees).toEqual([]);
  });
});

describe('createInterviewCalendarEvent: start and end', () => {
  it('start is sent as a UTC ISO instant whatever offset it came in with', async () => {
    await createInterviewCalendarEvent(BASE);
    expect(body().start).toEqual({ dateTime: '2026-11-02T04:30:00.000Z' });
  });

  it.each([
    [45, '2026-11-02T05:15:00.000Z'],
    [60, '2026-11-02T05:30:00.000Z'],
    [90, '2026-11-02T06:00:00.000Z'],
    [0, '2026-11-02T04:30:00.000Z'],
    [1, '2026-11-02T04:31:00.000Z'],
    [24 * 60, '2026-11-03T04:30:00.000Z'],
  ])('end is start + %i minutes = %s', async (minutes, end) => {
    await createInterviewCalendarEvent({ ...BASE, durationMinutes: minutes });
    expect(body().end).toEqual({ dateTime: end });
  });

  it('a start time given in UTC and one given with an offset for the same instant produce the same event', async () => {
    await createInterviewCalendarEvent({ ...BASE, startTime: '2026-11-02T04:30:00Z' });
    expect(body().start).toEqual({ dateTime: '2026-11-02T04:30:00.000Z' });
  });

  it('an unparseable start time rejects with a RangeError before anything is sent', async () => {
    await expect(createInterviewCalendarEvent({ ...BASE, startTime: 'not a date' })).rejects.toThrow(RangeError);
    expect(g.insert).not.toHaveBeenCalled();
  });
});

describe('createInterviewCalendarEvent: Google Meet is requested only for Video', () => {
  it('Video: conferenceDataVersion 1 and a hangoutsMeet createRequest with a UUID requestId', async () => {
    await createInterviewCalendarEvent({ ...BASE, mode: 'Video' });
    expect(sent().conferenceDataVersion).toBe(1);
    const req = body().conferenceData.createRequest;
    expect(req.conferenceSolutionKey).toEqual({ type: 'hangoutsMeet' });
    expect(req.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('every Video call gets its own requestId (a reused one would be treated by Google as the same conference request)', async () => {
    await createInterviewCalendarEvent({ ...BASE, mode: 'Video' });
    await createInterviewCalendarEvent({ ...BASE, mode: 'Video' });
    const ids = g.insert.mock.calls.map(c => c[0].requestBody.conferenceData.createRequest.requestId);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it.each(['In-person', 'Phone'] as const)('%s: conferenceDataVersion 0 and no conferenceData key at all', async mode => {
    await createInterviewCalendarEvent({ ...BASE, mode });
    expect(sent().conferenceDataVersion).toBe(0);
    expect('conferenceData' in body()).toBe(false);
  });
});

describe('createInterviewCalendarEvent: who the event is created as', () => {
  it('the JWT impersonates the scheduling user (subject = organizerEmail), with the service account identity and the calendar.events scope only', async () => {
    await createInterviewCalendarEvent({ ...BASE, organizerEmail: 'someone.else@example.test' });
    expect(g.jwtOptions).toHaveLength(1);
    expect(g.jwtOptions[0]).toEqual({
      email: 'sa@example.iam.test', key: 'placeholder-key', scopes: ['https://www.googleapis.com/auth/calendar.events'], subject: 'someone.else@example.test',
    });
  });

  it('a client is built per call, so two organizers never share a subject', async () => {
    await createInterviewCalendarEvent({ ...BASE, organizerEmail: 'a@example.test' });
    await createInterviewCalendarEvent({ ...BASE, organizerEmail: 'b@example.test' });
    expect(g.jwtOptions.map(o => o.subject)).toEqual(['a@example.test', 'b@example.test']);
    expect(g.calendarOptions.map(o => o.version)).toEqual(['v3', 'v3']);
  });

  it('missing credentials fail before any API call', async () => {
    g.credentials.mockImplementation(() => { throw new Error('No Google service account credentials found.'); });
    await expect(createInterviewCalendarEvent(BASE)).rejects.toThrow('No Google service account credentials found.');
    expect(g.insert).not.toHaveBeenCalled();
  });
});

describe('createInterviewCalendarEvent: what comes back', () => {
  it('returns the event id and its htmlLink', async () => {
    const out = await createInterviewCalendarEvent(BASE);
    expect(out.eventId).toBe('evt123');
    expect(out.eventLink).toBe('https://calendar.example.test/event/evt123');
  });

  it.each([[undefined], [''], [null]])('a missing or empty htmlLink (%j) falls back to the calendar.google.com event URL built from the id', async link => {
    g.insert.mockResolvedValue({ data: { id: 'evt999', htmlLink: link } });
    expect((await createInterviewCalendarEvent(BASE)).eventLink).toBe('https://calendar.google.com/calendar/event?eid=evt999');
  });

  it.each([[undefined], [''], [null]])('an event with no id (%j) is an error, not a half result', async id => {
    g.insert.mockResolvedValue({ data: { id } });
    await expect(createInterviewCalendarEvent(BASE)).rejects.toThrow('Calendar event created but no event ID was returned');
  });

  it('meetLink is the URI of the entry point of type "video" (not phone, sip or more)', async () => {
    g.insert.mockResolvedValue({
      data: {
        id: 'e1',
        conferenceData: { entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+10000000000' },
          { entryPointType: 'more', uri: 'https://more.example.test' },
          { entryPointType: 'video', uri: 'https://meet.example.test/abc-defg-hij' },
          { entryPointType: 'video', uri: 'https://meet.example.test/second' },
        ] },
      },
    });
    expect((await createInterviewCalendarEvent(BASE)).meetLink).toBe('https://meet.example.test/abc-defg-hij');
  });

  it.each([
    ['no conferenceData', { id: 'e1' }],
    ['no entry points', { id: 'e1', conferenceData: {} }],
    ['only a phone entry point', { id: 'e1', conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+10000000000' }] } }],
    ['a video entry point with a null uri', { id: 'e1', conferenceData: { entryPoints: [{ entryPointType: 'video', uri: null }] } }],
  ])('meetLink is undefined for %s', async (_n, data) => {
    g.insert.mockResolvedValue({ data });
    expect((await createInterviewCalendarEvent(BASE)).meetLink).toBeUndefined();
  });

  it('an API error is not swallowed (the caller records it as a visible, non-fatal failure)', async () => {
    g.insert.mockRejectedValue(new Error('synthetic Calendar API failure'));
    await expect(createInterviewCalendarEvent(BASE)).rejects.toThrow('synthetic Calendar API failure');
  });
});
