/**
 * Fixtures and small page helpers for the roles / My Tasks browser specs (tests/e2e/12-my-tasks.spec.ts, 14-role-detail-actions.spec.ts).
 *
 * Everything here is LOCAL-ONLY, like the db specs: rows are written straight into the test database (no API sets a score, a role's
 * portfolio flag, a stage-entry time or a review result) and removed again in one transaction by `purgeRolesFast`, so a spec leaves nothing
 * behind and never pays the per-row scan of the unindexed `pending_actions` foreign keys.
 *
 *   const fx = new Fixtures(db, uid());                 // every name and e-mail carries the run id
 *   const role = await fx.role({ hm: 'Alex' });
 *   const cand = await fx.candidate('hi', { gender: 'M', expectedCtc: 15 });
 *   const app  = await fx.app(cand, role, { score: 8.4, hoursInStage: 60 });
 *   ...
 *   await fx.cleanup();                                  // afterAll
 *
 * No Anthropic key, no Google: scored applications are written by hand, so nothing here triggers ResumeIQ, the vision model or Drive.
 */
import type { Client } from 'pg';
import { expect, Locator, Page, APIRequestContext } from '@playwright/test';
import { BASE, CRON_SECRET } from './api';
import { purgeRolesFast } from './sourcing-db';

export type Gender = 'M' | 'F' | null;

export interface RoleOpts {
  title?: string;
  /** roles.hiring_manager_name (free text; several people may be listed, see CLAUDE.md "A role can have several Hiring Managers"). */
  hm?: string;
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  status?: string;
  department?: string;
  ctcBand?: string | null;
  /** Days before today that the role was opened (start_date). Default 10. */
  openedDaysAgo?: number;
  /** Days before today of the Close Target; null = none. A target far in the past makes the SLA sweep raise a 'Role aging alert'. */
  targetClosedDaysAgo?: number | null;
  /** Switch the portfolio review on for this role (the production switch is SQL-only too). `kind` defaults to the designer review. */
  portfolio?: false | { kind?: 'design_portfolio' | 'marketing_work' };
  jdSource?: 'generated' | 'manual';
  jdDriveLink?: string | null;
}

export interface CandidateOpts {
  gender?: Gender;
  /** Lakhs per annum (candidates.expected_ctc / current_ctc_fixed). */
  expectedCtc?: number | null;
  currentCtc?: number | null;
  noticeDays?: number | null;
  company?: string | null;
  industry?: string | null;
}

export interface AppOpts {
  stage?: string;
  status?: string;
  /** 0-10: written to all eight ResumeIQ dimensions and score_avg (ai_fit_score = score * 10). `null` = never scored (score_avg NULL). Default 7. */
  score?: number | null;
  /** Hours since the application entered its stage (stage_entry_time). Default 0. A value past the SLA threshold is a breach for the sweep. */
  hoursInStage?: number;
  founderFlag?: boolean;
  strengths?: string[];
  redFlags?: string[];
  summary?: string;
  recommendation?: 'Strong Yes' | 'Yes' | 'Maybe' | 'No' | null;
  /** The portfolio review columns of the application (the stored review itself is `putAnalysis`). */
  portfolio?: { score?: number | null; status?: string | null; error?: string | null; note?: string | null };
}

export interface Created { id: string; label: string }
export interface CreatedRole extends Created { title: string }
export interface CreatedCandidate extends Created { name: string; email: string }
export interface CreatedApp extends Created { candidateId: string; roleId: string; candidateName: string; roleTitle: string }

/** The four action types My Tasks files under "Feedback Due" (mirror of frontend/src/types FEEDBACK_DUE_ACTION_TYPES; everything else is "Other Pending Actions"). */
export const FEEDBACK_DUE_TYPES = ['Interview 1 Feedback Due', 'Interview 2 Feedback Due', 'Founders Round Feedback Due', 'Assignment Feedback Due'];
/** What the SLA engine writes for a stale Applied-and-Screened application: owned by the role's Hiring Manager(s). */
export const SHORTLIST_PENDING = 'Resume Shortlist Pending';

export class Fixtures {
  readonly roleIds: string[] = [];
  readonly appIds: string[] = [];
  readonly candidateIds: string[] = [];
  private n = 0;

  constructor(readonly db: Client, readonly run: string, readonly prefix = 'E2E Tasks') {}

  /** Every spec e-mail matches this pattern, so `cleanup` removes exactly its own candidates. */
  get emailLike(): string { return `e2e.fx.${this.run}.%@example.com`; }

  async role(label: string, o: RoleOpts = {}): Promise<CreatedRole> {
    const title = o.title ?? `${this.prefix} ${label} ${this.run}`;
    const portfolio = o.portfolio ? o.portfolio : false;
    const { rows } = await this.db.query(
      `INSERT INTO roles (title, department, hiring_manager_name, priority, status, location, employment_type, start_date, target_closure_date,
                          ctc_band, portfolio_analysis_enabled, portfolio_review_kind, jd_source, jd_drive_link)
       VALUES ($1, $2, $3, $4, $5, 'Gurgaon', 'Full-Time / Permanent', CURRENT_DATE - $6::int,
               CASE WHEN $7::int IS NULL THEN NULL ELSE CURRENT_DATE - $7::int END, $8, $9, $10, $11, $12) RETURNING id`,
      [title, o.department ?? 'Tech/Devs', o.hm ?? 'Alex', o.priority ?? 'P2', o.status ?? 'Live – Sourcing', o.openedDaysAgo ?? 10,
       o.targetClosedDaysAgo ?? null, o.ctcBand === undefined ? '20-25 LPA' : o.ctcBand, !!portfolio,
       (portfolio && portfolio.kind) || 'design_portfolio', o.jdSource ?? 'generated', o.jdDriveLink ?? null]);
    this.roleIds.push(rows[0].id);
    return { id: rows[0].id, label, title };
  }

  async candidate(label: string, o: CandidateOpts = {}): Promise<CreatedCandidate> {
    const name = `${this.prefix} ${label} ${this.run}`;
    const email = `e2e.fx.${this.run}.${++this.n}@example.com`;
    const { rows } = await this.db.query(
      `INSERT INTO candidates (full_name, email, gender, expected_ctc, current_ctc_fixed, notice_period_days, current_company, current_industry)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [name, email, o.gender ?? null, o.expectedCtc ?? null, o.currentCtc ?? null, o.noticeDays ?? null, o.company ?? null, o.industry ?? null]);
    this.candidateIds.push(rows[0].id);
    return { id: rows[0].id, label, name, email };
  }

  async app(cand: CreatedCandidate, role: CreatedRole, o: AppOpts = {}): Promise<CreatedApp> {
    const score = o.score === undefined ? 7 : o.score;
    const scored = score !== null;
    const p = o.portfolio ?? {};
    const { rows } = await this.db.query(
      `INSERT INTO applications (candidate_id, role_id, stage, status, stage_entry_time, founder_review_flag,
         score_technical, score_experience, score_industry_fit, score_culture_fit, score_role_alignment, score_trajectory, score_leadership, score_communication,
         score_avg, ai_fit_score, ai_priority_bucket, score_strengths, score_red_flags, score_summary, score_recommendation, sla_hours,
         score_portfolio, score_portfolio_note, portfolio_analysis_status, portfolio_analysis_error)
       VALUES ($1, $2, $3, $4, NOW() - make_interval(hours => $5::int), $6,
         $7::int, $7::int, $7::int, $7::int, $7::int, $7::int, $7::int, $7::int,
         $8::numeric, $9, $10, $11::text[], $12::text[], $13, $14, 48,
         $15, $16, $17, $18) RETURNING id`,
      [cand.id, role.id, o.stage ?? 'Applied and Screened', o.status ?? 'Active', Math.round(o.hoursInStage ?? 0), !!o.founderFlag,
       scored ? Math.round(score!) : null, scored ? score : null, scored ? Math.round(score! * 10) : null,
       scored ? (score! >= 8 ? 'Strong Fit' : score! >= 6 ? 'Review' : 'Low Priority') : null,
       scored ? (o.strengths ?? ['Seeded strength']) : null, scored ? (o.redFlags ?? []) : null,
       scored ? (o.summary ?? 'Seeded summary.') : null, scored ? (o.recommendation === undefined ? 'Yes' : o.recommendation) : null,
       p.score ?? null, p.note ?? null, p.status ?? null, p.error ?? null]);
    this.appIds.push(rows[0].id);
    return { id: rows[0].id, label: cand.label, candidateId: cand.id, roleId: role.id, candidateName: cand.name, roleTitle: role.title };
  }

  /** The row a spec wrote for a review (portfolio_analyses), as the worker would have stored it. */
  async putAnalysis(appId: string, analysis: object): Promise<void> {
    await this.db.query(
      `INSERT INTO portfolio_analyses (application_id, analysis) VALUES ($1, $2::jsonb)
       ON CONFLICT (application_id) DO UPDATE SET analysis = EXCLUDED.analysis`, [appId, JSON.stringify(analysis)]);
  }

  /** A Standard interview round scheduled `hoursAgo` hours ago with feedback still pending (what "Feedback Due" is made of). */
  async round(app: CreatedApp, o: { interviewerEmails: string[]; hoursAgo: number; name?: string }): Promise<string> {
    const { rows } = await this.db.query(
      `INSERT INTO interview_rounds (application_id, round_name, round_type, round_number, scheduled_date, feedback_status, interviewer_emails)
       VALUES ($1, $2, 'Standard', 1, NOW() - make_interval(hours => $3::int), 'Pending', $4::text[]) RETURNING id`,
      [app.id, o.name ?? 'Interview Round 1', Math.round(o.hoursAgo), o.interviewerEmails]);
    return rows[0].id as string;
  }

  /** Removes everything this instance created (and the sourcing plans / pending rows hanging off the roles), in one transaction. */
  async cleanup(): Promise<void> {
    await purgeRolesFast(this.db, this.roleIds, [this.emailLike]);
  }
}

// ── The SLA engine ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Runs the whole SLA sweep now (POST /api/cron/sla-check with the dev cron secret) — the compute-on-read path throttles itself to once per 3 minutes. */
export async function runSlaSweep(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${BASE}/api/cron/sla-check`, { headers: { Authorization: `Bearer ${CRON_SECRET}` }, data: {} });
  expect(res.status(), 'POST /api/cron/sla-check').toBe(200);
}

/**
 * GET /dashboard/pending answers the 100 highest-priority, OLDEST open rows (priority_level is a text column sorted DESC, so 'Normal' comes
 * first, then oldest first). A long-lived local database holds thousands of old rows, so a row the sweep has just made would fall outside that
 * window and the page would not show it. What is under test is what My Tasks does with a row, not that window, so the rows of the given
 * applications and roles are made to sort first. (A sweep re-creates a breach row with created_at = NOW(); pin AFTER the sweep, right before
 * the page is opened. Opening My Tasks itself never runs a sweep.)
 */
export async function pinPendingRows(db: Client, ids: { appIds?: string[]; roleIds?: string[] }): Promise<void> {
  await db.query(
    `UPDATE pending_actions SET created_at = '2000-01-01', priority_level = 'Normal'
      WHERE resolved = false AND (application_id = ANY($1::text[]) OR role_id = ANY($2::text[]))`,
    [ids.appIds ?? [], ids.roleIds ?? []]);
}

export interface PendingRow { id: string; owner_type: string; action_type: string; description: string; responsible_person: string | null; role_id: string | null }

/** The open pending rows of one application, straight from the database (preconditions are asserted against this, never assumed). */
export async function openPendingRows(db: Client, appId: string): Promise<PendingRow[]> {
  return (await db.query(
    `SELECT id, owner_type, action_type, description, responsible_person, role_id FROM pending_actions
      WHERE application_id = $1 AND resolved = false ORDER BY id`, [appId])).rows;
}

// ── Page helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** My Tasks' section boxes: Ready for Review / Feedback Due / Other Pending Actions / Leadership Alerts / Sourcing. */
export const taskBox = (page: Page, label: string): Locator => page.getByRole('button', { name: new RegExp(`^${label}`) });

/** Waits until a box shows exactly `count` (its text is the label followed by the number). Retries: a count follows the filtered list, which is debounced. */
export async function expectBoxCount(page: Page, label: string, count: number): Promise<void> {
  await expect(taskBox(page, label)).toHaveText(new RegExp(`^${label}\\s*${count}$`));
}

/**
 * Narrows the Ready for Review table with its search box (candidate name, e-mail or role title, matched on the server) and waits for the
 * answer to THAT search — the box is debounced, so a number or a row read straight after typing may still belong to the unfiltered list.
 */
export async function searchFor(page: Page, text: string): Promise<void> {
  const answered = page.waitForResponse(res => {
    if (res.request().method() !== 'GET' || !res.url().includes('/api/applications?')) return false;
    return new URL(res.url()).searchParams.get('q') === text;
  });
  await page.getByPlaceholder('Search candidate or role…').fill(text);
  await answered;
}

/** Opens a section by its box and waits until it reports itself pressed. */
export async function openBox(page: Page, label: string): Promise<void> {
  const box = taskBox(page, label);
  await box.click();
  await expect(box).toHaveAttribute('aria-pressed', 'true');
}

/**
 * Ticks and unticks options of a MultiSelectFilter by its visible label (the button's name is the label, then a count badge once anything is
 * selected). The dropdown is a portal on document.body (position: fixed); it closes on a mousedown outside itself, which this does by pressing
 * on the page heading.
 */
export async function setFilter(page: Page, filterLabel: string, change: { check?: string[]; uncheck?: string[] }): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${filterLabel}`) }).click();
  const panel = page.locator('body > div.fixed');
  await expect(panel).toBeVisible();
  for (const option of change.check ?? []) await panel.getByLabel(option, { exact: true }).check();
  for (const option of change.uncheck ?? []) await panel.getByLabel(option, { exact: true }).uncheck();
  await page.getByRole('heading', { level: 1 }).click();
  await expect(panel).toHaveCount(0);
}

export interface SeenRequest { method: string; url: string; body: string | null }

/** Starts recording the requests that match, NOW — attach before the navigation or click under test, never after. */
export function recordRequests(page: Page, match: (r: SeenRequest) => boolean): SeenRequest[] {
  const seen: SeenRequest[] = [];
  page.on('request', req => {
    const r = { method: req.method(), url: req.url(), body: req.postData() };
    if (match(r)) seen.push(r);
  });
  return seen;
}

/** The candidate-name links of the Ready for Review table, in the order they are shown. */
export async function candidateLinksInTable(page: Page, marker: string): Promise<string[]> {
  const links = page.locator('table a[href^="/candidates/"]').filter({ hasText: marker });
  return (await links.allTextContents()).map(t => t.trim());
}

/** A table row of the Ready for Review list, found by the candidate's name. */
export const tableRowOf = (page: Page, candidateName: string): Locator =>
  page.locator('table tbody tr').filter({ has: page.getByRole('link', { name: candidateName, exact: true }) });
