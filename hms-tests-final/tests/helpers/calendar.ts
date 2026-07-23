import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

// ─── Real Google Calendar helper for tests ─────────────────────────────────
// Local Docker mounts a real service-account key (see docker-compose.yml's
// GOOGLE_APPLICATION_CREDENTIALS), and domain-wide delegation is configured
// for calendar.events — so any test that schedules a Standard interview
// round with a real scheduled_date + interviewer_emails WILL create a real
// event on the impersonated organizer's actual Google Calendar. Unlike the
// rest of this suite's real-external-call data (which has no delete route to
// clean up with anyway — see 10-jd-generation-and-scoring.spec.ts's real
// Drive/Claude calls, left in place), a stray real Calendar event is a bigger
// nuisance: it sits on an actual person's actual calendar, not an anonymous
// DB row. So this one external side effect gets cleaned up explicitly,
// rather than following that file's "leave it" precedent.
//
// Credentials: the same key file the backend itself uses, located by env var
// override (GOOGLE_APPLICATION_CREDENTIALS) or by globbing the repo root for
// dp-hiring-master-*.json — not hardcoded, since the filename has a random
// hash suffix that changes if the key is ever rotated.
function findCredentialsPath(): string | null {
  const override = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (override && fs.existsSync(override)) return override;

  const repoRoot = path.join(process.cwd(), '..');
  const match = fs.readdirSync(repoRoot).find(f => /^dp-hiring-master-.*\.json$/.test(f));
  return match ? path.join(repoRoot, match) : null;
}

let cachedCredentials: { client_email: string; private_key: string } | null | undefined;

function getCredentials(): { client_email: string; private_key: string } | null {
  if (cachedCredentials !== undefined) return cachedCredentials;
  const p = findCredentialsPath();
  cachedCredentials = p ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
  return cachedCredentials;
}

function getClient(organizerEmail: string) {
  const credentials = getCredentials();
  if (!credentials) return null;
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    subject: organizerEmail,
  });
  return google.calendar({ version: 'v3', auth });
}

// Fetches a real Calendar event directly — for assertions on attendees/start
// time/timezone beyond what the scheduling API response already returns.
// Returns null if credentials aren't available (e.g. a CI environment
// without the real key) rather than throwing, so callers can skip gracefully.
export async function getCalendarEvent(organizerEmail: string, eventId: string) {
  const calendar = getClient(organizerEmail);
  if (!calendar) return null;
  const res = await calendar.events.get({ calendarId: 'primary', eventId });
  return res.data;
}

// Deletes a real Calendar event created by a test. Silently no-ops if
// credentials aren't found — this is cleanup, not a test assertion, and must
// never fail a test run on its own.
export async function deleteCalendarEvent(organizerEmail: string, eventId: string): Promise<void> {
  const calendar = getClient(organizerEmail);
  if (!calendar) return;
  try {
    await calendar.events.delete({ calendarId: 'primary', eventId, sendUpdates: 'none' });
  } catch (err) {
    console.warn(`[calendar cleanup] Failed to delete event ${eventId}:`, (err as Error).message);
  }
}

// Whether real Calendar credentials are available in this environment — the
// one real-round-trip test uses this to skip itself gracefully rather than
// fail hard when run somewhere without the key (e.g. a fresh clone/CI).
export function hasCalendarCredentials(): boolean {
  return getCredentials() !== null;
}
