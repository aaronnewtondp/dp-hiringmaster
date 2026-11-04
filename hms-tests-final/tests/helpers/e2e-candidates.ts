/**
 * Helpers shared by the candidate-side browser specs (tests/e2e/10, 11, 16 and the edits to 01, 02, 05, 06).
 *
 * Everything a test needs is built through the REAL API (never the database, except for the few states no API can set: a role that
 * is "Live – Sourcing", an assignment that counts as sent, a backdated stage), so every test owns its role, its candidates and its
 * applications and never touches seeded data other specs rely on. A `Cleanup` registry removes what a spec made in one transaction.
 *
 * Nothing here can reach Google: the specs run against a stack with no credentials (scripts/test-stack.sh), where an Assignment round's
 * e-mail fails by design. `createAssignmentRound` asserts exactly that, so a stack that CAN send mail stops the run at once instead of
 * mailing anyone. Candidate addresses used for assignments are on the reserved `.invalid` TLD for the same reason.
 */
import { expect, test as base, APIRequestContext, Locator, Page, Request } from '@playwright/test';
import { authed, getToken, uid } from './api';
import { withDb } from './db';
import { expectNoPageErrors, PageErrorWatch } from './e2e';
import { purgeRolesFast } from './sourcing-db';

export type Api = ReturnType<typeof authed>;
type Json = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

export const STAGES = [
  'Applied and Screened', 'Interview Round 1', 'Interview Round 2', 'Assignment Round', 'Founders Round',
  'Reference Check', 'Pre-Joining Documents', 'Offer Discussion', 'Offer Released', 'Offer Accepted', 'Joined',
];

// ── test with a page-error watch on every test ──────────────────────────────────────────────────────────────────────────────────────
// An auto fixture: the listener is attached before the test's first navigation and checked after the test body, so a browser-side
// exception thrown at any point of a flow fails the test that caused it.
export const test = base.extend<{ pageErrors: PageErrorWatch }>({
  pageErrors: [async ({ page }, use) => {
    const watch = expectNoPageErrors(page);
    await use(watch);
    watch.check();
  }, { auto: true }],
});
export { expect };

// ── API fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function hrApi(request: APIRequestContext): Promise<Api> {
  return authed(request, await getToken(request, 'hr'));
}

/** A role of this spec's own. Draft unless `status` is given (then set by SQL: that is the one thing the API cannot do without a JD run). */
export async function createRole(request: APIRequestContext, over: Json = {}): Promise<Json & { id: string; title: string }> {
  const { status, ...body } = over;
  const res = await (await hrApi(request)).post('/api/roles', {
    title: `E2E Cand Role ${uid()}`, priority: 'P2', department: 'Product/QA', location: 'Gurgaon', ctc_band: '10-20 LPA',
    hiring_manager_name: 'Alex', ...body,
  });
  expect(res.status(), await res.text()).toBe(201);
  const { role } = await res.json();
  if (status) await setRoleStatus(role.id, status as string);
  return role;
}

export async function setRoleStatus(roleId: string, status: string): Promise<void> {
  await withDb(c => c.query('UPDATE roles SET status = $1 WHERE id = $2', [status, roleId]));
}

export interface Applicant { candidate: Json; application: Json; email: string; name: string }

/** A candidate with one application on `roleId` (stage 'Applied and Screened'). `name` is the candidate's full name. */
export async function createApplicant(request: APIRequestContext, roleId: string, over: Json = {}): Promise<Applicant> {
  const email = (over.email as string | undefined) ?? `e2ec+${uid()}@example.com`;
  const name = (over.full_name as string | undefined) ?? `E2E Cand ${uid()}`;
  const res = await (await hrApi(request)).post('/api/candidates', {
    full_name: name, email, phone: '+91 90000 00000', role_id: roleId,
    current_company: 'E2E Co', current_industry: 'Water Treatment', current_location: 'Gurgaon', preferred_location: 'Gurgaon',
    years_of_experience: 5, current_ctc_fixed: 12, expected_ctc: 15, notice_period_days: 30, languages_known: 'English',
    resume_drive_link: 'https://drive.google.com/file/d/e2e-no-such-file/view',
    ...over,
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  return { candidate: body.candidate, application: body.application, email, name };
}

/** Move an application (as HR). Never for the thing under test — only to reach the state a test starts from. */
export async function moveToStage(request: APIRequestContext, appId: string, stage: string, extra: Json = {}): Promise<void> {
  const res = await (await hrApi(request)).post(`/api/applications/${appId}/stage`, { new_stage: stage, ...extra });
  expect(res.status(), await res.text()).toBe(200);
}

export async function getApp(request: APIRequestContext, appId: string, as: 'hr' | 'hm_alex' = 'hr'): Promise<Json> {
  const res = await authed(request, await getToken(request, as)).get(`/api/applications/${appId}`);
  expect(res.status()).toBe(200);
  return (await res.json()).application;
}

export async function getRounds(request: APIRequestContext, appId: string): Promise<Json[]> {
  const res = await (await hrApi(request)).get(`/api/interviews?application_id=${appId}`);
  expect(res.status()).toBe(200);
  return (await res.json()).rounds;
}

export async function getRefChecks(request: APIRequestContext, appId: string): Promise<Json[]> {
  const res = await (await hrApi(request)).get(`/api/ref-checks?application_id=${appId}`);
  expect(res.status()).toBe(200);
  return (await res.json()).ref_checks;
}

/** A Standard round with NO scheduled date: nothing is sent to any calendar. */
export async function createStandardRound(request: APIRequestContext, appId: string, over: Json = {}): Promise<Json> {
  const res = await (await hrApi(request)).post('/api/interviews', {
    application_id: appId, round_name: `E2E Round ${uid()}`, round_type: 'Standard', round_number: 1,
    interviewer_emails: ['alex@digitalpaani.com'], ...over,
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).round;
}

/**
 * An Assignment round, the way "Send Assignment" creates one. The backend then tries to e-mail the candidate: on a stack without Google
 * credentials that fails (`sent: false`, the round keeps `assignment_email_error`). A stack that CAN send is refused here.
 */
export async function createAssignmentRound(request: APIRequestContext, appId: string, over: Json = {}): Promise<Json> {
  const res = await (await hrApi(request)).post('/api/interviews', {
    application_id: appId, round_name: 'Assignment Round', round_type: 'Assignment', round_number: 1,
    mail_body_content: 'E2E: assignment details follow.', assignment_link: 'https://example.invalid/e2e-assignment', ...over,
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  expect(body.email?.sent, 'this stack can send real mail; run the e2e specs against scripts/test-stack.sh, which has no Gmail').toBe(false);
  return body.round;
}

/** What a successful assignment send writes (the stack cannot send): the round counts as sent, due in 60 hours. */
export async function markAssignmentSent(roundId: string): Promise<void> {
  await withDb(c => c.query(
    `UPDATE interview_rounds SET assignment_send_date = NOW(), assignment_deadline = NOW() + interval '60 hours', assignment_email_error = NULL WHERE id = $1`,
    [roundId]));
}

// ── cleanup ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Collects the roles and candidate e-mails a spec made and removes them (applications, rounds, logs, pending actions) in one go. */
export class Cleanup {
  private roles = new Set<string>();
  private emails = new Set<string>();
  role(id: string) { this.roles.add(id); }
  email(address: string) { this.emails.add(address); }
  async purge(): Promise<void> {
    if (!this.roles.size && !this.emails.size) return;
    await withDb(c => purgeRolesFast(c, [...this.roles], [...this.emails]));
    this.roles.clear(); this.emails.clear();
  }
}

// ── page helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The open dialog whose heading matches (every modal in the app is a `fixed inset-0` overlay with a heading). */
export function dialogWith(page: Page, heading: string | RegExp): Locator {
  return page.locator('div.fixed.inset-0').filter({ has: page.getByRole('heading', { name: heading }) });
}

/** A toast (react-hot-toast renders role="status") containing `text`; the newest if several match. */
export function toastWith(page: Page, text: string | RegExp): Locator {
  return page.getByRole('status').filter({ hasText: text }).last();
}

/** Every request matching `match`, recorded from now on (read `.requests` AFTER a later awaited step, never right after a click). */
export function recordRequests(page: Page, match: (r: Request) => boolean): { requests: Request[]; bodies: () => Json[] } {
  const requests: Request[] = [];
  page.on('request', r => { if (match(r)) requests.push(r); });
  return { requests, bodies: () => requests.map(r => r.postDataJSON() as Json) };
}

export const isPost = (pathPart: string | RegExp) => (r: Request) =>
  r.method() === 'POST' && (typeof pathPart === 'string' ? r.url().includes(pathPart) : pathPart.test(r.url()));
export const isPatch = (pathPart: string | RegExp) => (r: Request) =>
  r.method() === 'PATCH' && (typeof pathPart === 'string' ? r.url().includes(pathPart) : pathPart.test(r.url()));

/** All values of a query parameter, accepting axios' `name[]=a&name[]=b` and the plain repeated form. */
export function queryValues(url: string, name: string): string[] {
  const u = new URL(url);
  return [...u.searchParams.getAll(name), ...u.searchParams.getAll(`${name}[]`)];
}

/** The candidate page's heading is up (the page has loaded the candidate). */
export async function expectCandidatePage(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible({ timeout: 15_000 });
}

/** Escape text for use in a RegExp. */
export const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
