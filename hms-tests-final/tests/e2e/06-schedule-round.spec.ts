/**
 * E2E — ScheduleRoundModal (round scheduling from CandidateDetail)
 *
 * Covers the stage-driven round-scheduling rework and the Google Calendar
 * integration shipped this session (see frontend/src/components/
 * ScheduleRoundModal.tsx and frontend/src/pages/CandidateDetail.tsx).
 *
 * The centerpiece is the IST timezone regression test below: the bug this
 * guards lived entirely in the frontend's construction of the request
 * payload (datetime-local gives a naive "YYYY-MM-DDTHH:mm" with no
 * timezone offset; ScheduleRoundModal now appends "+05:30" before sending
 * scheduled_date to the API). An API-level test that posts a
 * already-correctly-offset string would never exercise that bug — the only
 * way to actually regression-test it is to drive the real datetime-local
 * input through the real browser and confirm what lands in the DB.
 *
 * This suite also drives a REAL Google Calendar sync (local Docker has real
 * service-account credentials + working domain-wide delegation for
 * calendar.events — see tests/helpers/calendar.ts), so the timezone test
 * cleans up any real event it creates in a `finally` block, same as
 * tests/api/15-calendar-integration.spec.ts.
 */
import { test, expect, Page } from '@playwright/test';
import { BASE, FRONTEND_BASE, USERS, getToken, authed, createCandidateWithApp, SEEDED, uid } from '../helpers/api';
import { deleteCalendarEvent } from '../helpers/calendar';

async function loginViaApi(page: Page, user: keyof typeof USERS = 'hr') {
  const cred = USERS[user];
  const res  = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: cred.email, password: cred.password },
  });
  const { token, user: userBody } = await res.json();

  await page.goto(FRONTEND_BASE);
  await page.evaluate(({ token, userBody }) => {
    localStorage.setItem('hms_token', token);
    localStorage.setItem('hms_user', JSON.stringify(userBody));
  }, { token, userBody });

  await page.goto(`${FRONTEND_BASE}/dashboard`);
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
}

// ─── Fresh, isolated test data — created directly via API so each test drives
// its own application rather than seeded data other tests might also touch,
// matching 04-inline-editing.spec.ts's convention. ────────────────────────────
async function createTestApplication(page: Page, stage: string, roleId: string = SEEDED.roles.senior_pm) {
  const token = await getToken(page.request, 'hr');
  const { candidate, application } = await createCandidateWithApp(page.request, token, roleId);
  await authed(page.request, token).post(`/api/applications/${application.id}/stage`, { new_stage: stage });
  return { candidate, application };
}

// Navigates to a candidate's detail page and expands their (only) application
// card — CandidateDetail.tsx renders each application collapsed by default,
// with a chevron toggle (title="Expand details"/"Collapse") that reveals the
// "Interview rounds" section where the schedule buttons live.
async function openCandidateAndExpand(page: Page, candidate: { id: string; full_name: string }) {
  await page.goto(`${FRONTEND_BASE}/candidates/${candidate.id}`);
  await expect(page.getByRole('heading', { name: candidate.full_name, level: 1 })).toBeVisible({ timeout: 10000 });
  await page.getByTitle('Expand details').click();
}

// Fills whichever ScheduleRoundModal fields are provided. Locators match the
// exact markup in frontend/src/components/ScheduleRoundModal.tsx: the round
// name and interviewer-emails inputs are found by their exact placeholder
// text (their <label>s wrap a nested <span>* so a plain text-is() match on
// the label would be brittle); the datetime-local input has no placeholder,
// so it's found via its label as a direct sibling, same pattern as
// 04-inline-editing.spec.ts's sectionCard() field lookups.
async function fillScheduleModal(
  page: Page,
  { roundName, interviewerEmails, scheduledDate }: { roundName: string; interviewerEmails?: string; scheduledDate?: string }
) {
  await page.getByPlaceholder('e.g. Technical Deep-Dive, Founder Round…').fill(roundName);
  if (interviewerEmails !== undefined) {
    await page.getByPlaceholder('e.g. alex@digitalpaani.com, satyadev@digitalpaani.com').fill(interviewerEmails);
  }
  if (scheduledDate !== undefined) {
    await page.locator('label:text-is("Scheduled date & time") + input').fill(scheduledDate);
  }
}

test.describe('Schedule Round Modal E2E', () => {

  // ─── THE PRIMARY REGRESSION TEST ─────────────────────────────────────────
  test('scheduling for 11:00 AM stores the correct IST-equivalent UTC instant', async ({ page }) => {
    const { candidate, application } = await createTestApplication(page, 'Interview Round 1');

    // Must be 'hr' (aaron.newton@digitalpaani.com) — the one confirmed-real
    // Google Workspace mailbox in this test suite's USERS map. Calendar sync
    // impersonates the logged-in user as the event organizer (req.user.email
    // in backend/src/routes/interviews.ts), and 'hr2' (garima@) is a real HMS
    // user but NOT a real Workspace mailbox — impersonating her fails with
    // "invalid_grant: Invalid email or User ID". Same reasoning as the
    // API-level calendar test.
    await loginViaApi(page, 'hr');
    await openCandidateAndExpand(page, candidate);

    await page.getByRole('button', { name: 'Schedule round' }).click();

    const roundName = `E2E Timezone Round ${uid()}`;
    await fillScheduleModal(page, {
      roundName,
      interviewerEmails: `e2e-test-interviewer+${uid()}@example.com`,
      // Native datetime-local value shape: "YYYY-MM-DDTHH:mm", no seconds, no
      // offset. 11:00 AM, far-future so it can never collide with a real
      // calendar event on the organizer's actual calendar.
      scheduledDate: '2027-02-10T11:00',
    });
    // Meeting mode / duration left at their defaults (Video / 60).
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();

    await expect(page.getByText(`${roundName} scheduled`)).toBeVisible({ timeout: 10000 });

    const token = await getToken(page.request, 'hr');
    const res   = await authed(page.request, token).get(`/api/interviews?application_id=${application.id}`);
    expect(res.status()).toBe(200);
    const { rounds } = await res.json();
    const round = rounds.find((r: { round_name: string }) => r.round_name === roundName);
    expect(round).toBeDefined();

    try {
      // The correct UTC-equivalent of 11:00 AM IST (UTC+5:30). If the old bug
      // were still present — datetime-local's naive value sent with no
      // offset, defaulting to UTC — this would instead read
      // '2027-02-10T11:00:00.000Z', 5.5 hours later than intended (the exact
      // shape of the real production bug: a 9:15pm booking landing at
      // 2:41am the next day).
      expect(round.scheduled_date).toBe('2027-02-10T05:30:00.000Z');
    } finally {
      // Clean up the real Calendar event this test just created on
      // aaron.newton@digitalpaani.com's actual calendar, if sync succeeded.
      // This test's claim is about scheduled_date, not Calendar API success
      // — no assertion is made either way about round.calendar_event_id or
      // calendar_sync_error, so it passes regardless of that outcome.
      if (round?.calendar_event_id) {
        await deleteCalendarEvent('aaron.newton@digitalpaani.com', round.calendar_event_id);
      }
    }
  });

  test('an invalid interviewer email blocks submission', async ({ page }) => {
    const { candidate, application } = await createTestApplication(page, 'Interview Round 1');
    await loginViaApi(page, 'hr');
    await openCandidateAndExpand(page, candidate);

    await page.getByRole('button', { name: 'Schedule round' }).click();

    const roundName = `E2E Invalid Email Round ${uid()}`;
    await fillScheduleModal(page, { roundName, interviewerEmails: 'not-an-email' });
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();

    // Client-side EMAIL_RE check in ScheduleRoundModal.tsx fires before the
    // request is ever sent — exact toast text from handleSubmit().
    await expect(page.getByText('"not-an-email" doesn\'t look like a valid email address')).toBeVisible({ timeout: 5000 });

    // Modal is still open — no success toast, submission never reached the API.
    await expect(page.getByRole('heading', { name: 'Schedule interview round' })).toBeVisible();
    await expect(page.getByText(`${roundName} scheduled`)).not.toBeVisible();

    // Confirms no round was actually created server-side either.
    const token = await getToken(page.request, 'hr');
    const res   = await authed(page.request, token).get(`/api/interviews?application_id=${application.id}`);
    const { rounds } = await res.json();
    expect(rounds.find((r: { round_name: string }) => r.round_name === roundName)).toBeUndefined();
  });

  test('Schedule round vs Schedule Assignment button visibility follows the application\'s stage', async ({ page }) => {
    // INTERVIEW_STAGES in CandidateDetail.tsx gates "Schedule round" to
    // 'Interview Round 1' | 'Interview Round 2' | 'Founders Round'; the
    // "Schedule Assignment" button is gated separately to app.stage ===
    // 'Assignment Round'. These two conditions are mutually exclusive, so
    // exactly one of the two buttons should ever be visible at a time.
    const { candidate: interviewCandidate } = await createTestApplication(page, 'Interview Round 1');
    const { candidate: assignmentCandidate } = await createTestApplication(page, 'Assignment Round');

    await loginViaApi(page, 'hr');

    await openCandidateAndExpand(page, interviewCandidate);
    await expect(page.getByRole('button', { name: 'Schedule round' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Schedule Assignment' })).not.toBeVisible();

    await openCandidateAndExpand(page, assignmentCandidate);
    await expect(page.getByRole('button', { name: 'Schedule Assignment' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Schedule round' })).not.toBeVisible();
  });
});
