// ─────────────────────────────────────────────────────────────────────────────
// Work-sample review for R019 Head of Marketing & Creative Direction — the second kind of the shared "Portfolio review"
// (roles.portfolio_review_kind = 'marketing_work'; the designer review of R007 is the default kind 'design_portfolio').
//
// The marketing review reads its links from the candidate's screening answer to "Links to public resources/portfolio ...",
// not from the resume, and it NEVER scores work it could not really review: blank / "N/A", text-only, LinkedIn-only and
// other unopenable answers leave score_portfolio NULL and the candidate's average exactly as it was (never 0, never a guess).
//
// What this file covers (all through the real API + direct Postgres, no browser, no model, no third-party network):
//   schema ...... the kind column (default, NOT NULL, CHECK), the widened status CHECK ('unreviewable'), schema.sql replay
//   designer .... a flag-only role still takes the resume path on Re-run (502 on an unreadable resume, never the answer)
//   unscored .... the outcomes decided at enqueue time with no job and no model call, and the "average untouched" promise
//   links ....... what a real link answer stores (handlers, ranking, caps, de-duplication) and the local queue note
//   guard ....... a Re-run that finds nothing never overwrites an earlier good review (it ends 'failed', score and stored links kept)
//   routes ...... personas, 404/409 cases, the running/stale rule, flag-off, GET `kind` (a stored review without one is a designer
//                  review), filter-options, backfill
//   wording ..... the answer is found by question wording (both live wordings and variants), never by position or other answers
//   filter ...... min_portfolio_score works for both kinds; an unscored marketing candidate never matches it
//
// Applications are created with direct SQL (the 8 base scores + average set by hand) so NOTHING here triggers ResumeIQ or the
// vision model. Outside Vercel the queue's send() fails by design: a review that must be queued ends 'pending' with a
// "Could not be queued ... Use Re-run" note — that is the expected local result, asserted below.
//
// INTENTIONALLY LOCAL-ONLY, like the other tests/db specs: it flips role flags and writes review state directly in the local
// Docker Postgres (no API sets them — an admin-only switch by design).
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect, APIRequestContext } from '@playwright/test';
import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import { getToken, authed, uid, BASE, ROLE_INGEST_SECRET } from '../helpers/api';
import { purgeRolesFast } from '../helpers/sourcing-db';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';

// The two live wordings of the Job Application Form question (one has a typo, "intitiatives"), plus variants a form edit could produce.
const Q_TYPO  = "Links to public resources/portfolio to highlight your past work? eg: brand campaigns/marketing intitiatives/ad designs etc that you've run";
const Q_FIXED = "Links to public resources/portfolio to highlight your past work? eg: brand campaigns/marketing initiatives/ad designs etc that you've run";

// Other answers on the same form. They carry real-looking links on purpose: if the review ever read the wrong answer, a
// "blank" or "text only" case below would turn into a queued review and fail.
const DECOYS = [
  { question: 'Your LinkedIn profile URL', answer: 'https://www.linkedin.com/in/decoy-profile' },
  { question: 'Link to your latest resume (Google Drive)', answer: 'https://drive.google.com/file/d/1DecoyDecoyDecoyDecoyDecoy01/view' },
  { question: 'Why do you want to join DigitalPaani?', answer: 'I like the mission. See https://decoy-site.example.org for more.' },
];
const withDecoys = (question: string, answer: unknown) => [DECOYS[0], { question, answer }, DECOYS[1], DECOYS[2]];

// Drive ids (33 chars, [A-Za-z0-9_-]) — the shape of a real file id.
const driveId = (n: number) => `1AbCdEfGhIjKlMnOpQrStUvWxYz0123${String(n).padStart(2, '0')}`;
const driveFile = (n: number) => `https://drive.google.com/file/d/${driveId(n)}/view?usp=sharing`;

const WRITTEN_ONLY = 'I led brand and content for a climate-tech startup for five years and ran a dozen campaigns across LinkedIn, events and video; happy to walk you through them in an interview.';
const NOT_QUEUED = /could not be queued.*use re-run to retry/i;

// The score-related state a no-evidence outcome must leave exactly as it found it.
const SCORE_COLS = `score_avg, ai_fit_score, ai_priority_bucket, score_summary, score_red_flags, sla_hours,
  score_technical, score_experience, score_industry_fit, score_culture_fit, score_role_alignment, score_trajectory, score_leadership, score_communication,
  score_portfolio, score_portfolio_note`;

type Who = 'hr' | 'hr2' | 'leadership' | 'hm_alex' | 'hm_satyadev';

test.describe('R019 work-sample review (local Postgres + API)', () => {
  test.describe.configure({ timeout: 90_000 });

  let db: Client;
  const RUN = uid();
  const EMAIL_LIKE = `r019spec.${RUN}.%@example.com`;
  const roleIds: string[] = [];
  let seq = 0;

  let mktRole = '';          // marketing_work, flagged on        (created through POST /api/roles, flagged by SQL)
  let designRole = '';       // flag only, kind left at its default (created through POST /api/roles, flagged by SQL)
  let designExplicit = '';   // flag on, kind set explicitly to 'design_portfolio'
  let plainRole = '';        // flag off, default kind
  let offRole = '';          // flag OFF but kind 'marketing_work'

  // ── helpers ────────────────────────────────────────────────────────────────

  // The local backend restarts (tsx watch) whenever any file under backend/src changes; a request that lands in that window
  // is reset. Re-run is idempotent, so a short retry is safe.
  async function retrying<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
    let last: unknown;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (err) {
        last = err;
        if (!/ECONNRESET|ECONNREFUSED|socket hang up|EPIPE|ETIMEDOUT|network/i.test(String((err as Error).message))) throw err;
        await new Promise(r => setTimeout(r, 2500));
      }
    }
    throw last;
  }

  async function rerun(request: APIRequestContext, appId: string, who: Who = 'hr') {
    const token = await getToken(request, who);
    const res = await retrying(() => authed(request, token).post(`/api/applications/${appId}/portfolio-analysis`, {}));
    return { code: res.status(), body: await res.json().catch(() => ({})) as Record<string, any> };
  }

  async function review(request: APIRequestContext, appId: string, who: Who = 'hr') {
    const token = await getToken(request, who);
    const res = await retrying(() => authed(request, token).get(`/api/applications/${appId}/portfolio-analysis`));
    return { code: res.status(), body: await res.json().catch(() => ({})) as Record<string, any> };
  }

  async function newRoleViaApi(request: APIRequestContext, label: string): Promise<string> {
    const hr = await getToken(request, 'hr');
    const res = await authed(request, hr).post('/api/roles', { title: `R019 spec ${label} ${RUN}`, priority: 'P2' });
    expect(res.ok(), `POST /api/roles ${label}`).toBe(true);
    const id = (await res.json()).role.id as string;
    roleIds.push(id);
    return id;
  }

  async function newRoleViaSql(label: string, enabled: boolean, kind?: string): Promise<string> {
    const { rows } = await db.query(
      `INSERT INTO roles (title, department, hiring_manager_name, priority, status, location, employment_type, start_date, portfolio_analysis_enabled, portfolio_review_kind)
       VALUES ($1, 'Marketing', 'Alex', 'P1', 'Live – Sourcing', 'Gurgaon', 'Full-Time / Permanent', CURRENT_DATE - 10, $2, COALESCE($3, 'design_portfolio')) RETURNING id`,
      [`R019 spec ${label} ${RUN}`, enabled, kind ?? null]);
    roleIds.push(rows[0].id);
    return rows[0].id as string;
  }

  interface AppOpts {
    /** Shorthand: the work-sample answer, placed among other answers (see DECOYS) under the typo'd live question. */
    answer?: string;
    /** Or the raw screening_answers value (any JSON). Wins over `answer`. */
    screening?: unknown;
    name?: string;
    resumeLink?: string | null;
    /** false = base ResumeIQ has not scored it yet (score_avg NULL). */
    scored?: boolean;
    status?: string;
    portfolioScore?: number | null;
    portfolioStatus?: string | null;
    /** Sets portfolio_started_at to this many seconds ago (database clock). */
    startedSecondsAgo?: number;
  }

  async function addApp(roleId: string, label: string, o: AppOpts = {}): Promise<{ appId: string; candidateId: string }> {
    const email = `r019spec.${RUN}.${++seq}@example.com`;
    const { rows: c } = await db.query(
      `INSERT INTO candidates (full_name, email, resume_drive_link) VALUES ($1, $2, $3) RETURNING id`,
      [o.name ?? `R019 Spec ${label}`, email, o.resumeLink ?? null]);
    const screening = o.screening !== undefined ? o.screening : (o.answer !== undefined ? withDecoys(Q_TYPO, o.answer) : null);
    const scored = o.scored !== false;
    const { rows } = await db.query(
      `INSERT INTO applications (candidate_id, role_id, stage, status, screening_answers,
         score_technical, score_experience, score_industry_fit, score_culture_fit, score_role_alignment, score_trajectory, score_leadership, score_communication,
         score_avg, ai_fit_score, ai_priority_bucket, score_summary, score_red_flags, sla_hours,
         score_portfolio, score_portfolio_note, portfolio_analysis_status, portfolio_started_at)
       VALUES ($1, $2, 'Applied and Screened', $3, $4::jsonb,
         $5, $5, $5, $5, $5, $5, $5, $5, $6, $7, $8, $9, $10::text[], 48, $11, $12, $13,
         CASE WHEN $14::int IS NULL THEN NULL ELSE NOW() - make_interval(secs => $14::int) END)
       RETURNING id`,
      [c[0].id, roleId, o.status ?? 'Active', JSON.stringify(screening),
       scored ? 6 : null, scored ? 6.3 : null, scored ? 63 : null, scored ? 'Review' : null,
       scored ? 'Base summary.' : null, scored ? ['Base red flag'] : null,
       o.portfolioScore ?? null, o.portfolioScore != null ? 'Earlier note' : null, o.portfolioStatus ?? null,
       o.startedSecondsAgo ?? null]);
    return { appId: rows[0].id as string, candidateId: c[0].id as string };
  }

  // The links an earlier completed review was built from, exactly as the worker's run leaves them in portfolio_urls.
  // They are deliberately NOT what the candidate's current answer would pick, so a rewrite shows.
  const PRIOR_URLS = [
    { url: 'https://drive.google.com/file/d/1PriorPriorPriorPriorPrior0001/view', host: 'drive.google.com', platform: 'gdrive_file', handler: 'document' },
    { url: 'https://prior-portfolio.example.org', host: 'prior-portfolio.example.org', platform: 'custom', handler: 'site' },
  ];
  const setStoredUrls = (appId: string, urls: unknown) =>
    db.query(`UPDATE applications SET portfolio_urls=$1::jsonb WHERE id=$2`, [JSON.stringify(urls), appId]);

  const setAnswer = (appId: string, answer: string) =>
    db.query(`UPDATE applications SET screening_answers=$1::jsonb WHERE id=$2`, [JSON.stringify(withDecoys(Q_TYPO, answer)), appId]);

  const putAnalysis = (appId: string, analysis: object) =>
    db.query(`INSERT INTO portfolio_analyses (application_id, analysis) VALUES ($1, $2::jsonb)
              ON CONFLICT (application_id) DO UPDATE SET analysis=EXCLUDED.analysis`, [appId, JSON.stringify(analysis)]);

  const scoreState = async (appId: string) =>
    (await db.query(`SELECT ${SCORE_COLS} FROM applications WHERE id=$1`, [appId])).rows[0];

  const reviewRow = async (appId: string) =>
    (await db.query(
      `SELECT portfolio_analysis_status AS status, portfolio_analysis_error AS error, portfolio_urls AS urls,
              portfolio_analyzed_at AS analyzed_at, score_portfolio AS score
         FROM applications WHERE id=$1`, [appId])).rows[0];

  const analysisOf = async (appId: string): Promise<Record<string, any> | null> =>
    (await db.query(`SELECT analysis FROM portfolio_analyses WHERE application_id=$1`, [appId])).rows[0]?.analysis ?? null;

  const activityCount = async (appId: string) =>
    Number((await db.query(`SELECT count(*) AS n FROM activity_log WHERE application_id=$1 AND event_type='Portfolio Review Completed'`, [appId])).rows[0].n);

  // A real completed review as the worker would have stored it (what the guard tests must leave alone).
  const EARLIER_ANALYSIS = {
    version: 1, kind: 'marketing_work', analyzedAt: '2026-10-20T10:00:00.000Z', model: 'claude-sonnet-4-5',
    portfolios: [], criteria: [], jdAlignment: { mustHaves: [], niceToHaves: [] },
    modelScore: 7, checklistScore: 7, score: 7, scoreNote: 'Earlier note', highlights: ['EARLIER HIGHLIGHT'], redFlags: [], summary: 'EARLIER REVIEW',
  };

  // ── set-up / tear-down ─────────────────────────────────────────────────────

  test.beforeAll(async ({ request }) => {
    db = new Client({ connectionString: LOCAL_DB_URL });
    await db.connect();

    mktRole = await newRoleViaApi(request, 'marketing');
    await db.query(`UPDATE roles SET portfolio_analysis_enabled=true, portfolio_review_kind='marketing_work' WHERE id=$1`, [mktRole]);
    designRole = await newRoleViaApi(request, 'designer flag-only');
    await db.query(`UPDATE roles SET portfolio_analysis_enabled=true WHERE id=$1`, [designRole]);
    plainRole = await newRoleViaApi(request, 'plain');
    designExplicit = await newRoleViaSql('designer explicit', true, 'design_portfolio');
    offRole = await newRoleViaSql('flag off kind marketing', false, 'marketing_work');
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);   // pending_actions.application_id is unindexed on the local DB; purgeRolesFast does it in one pass
    try {
      // belt and braces for the induced-failure test: never leave its trigger behind
      await db.query(`DROP TRIGGER IF EXISTS r019spec_fail_${RUN} ON activity_log`);
      await db.query(`DROP FUNCTION IF EXISTS r019spec_fail_${RUN}()`);
      await purgeRolesFast(db, roleIds, [EMAIL_LIKE]);
    } finally { await db.end(); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('schema', () => {
    test('roles.portfolio_review_kind is TEXT NOT NULL and defaults to design_portfolio', async () => {
      const { rows } = await db.query(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema='public' AND table_name='roles' AND column_name='portfolio_review_kind'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].data_type).toBe('text');
      expect(rows[0].is_nullable).toBe('NO');
      expect(rows[0].column_default).toContain('design_portfolio');
    });

    test('a role created without a kind is a designer role, and the seeded designer role R007 kept that behaviour', async () => {
      const { rows } = await db.query(`SELECT portfolio_review_kind FROM roles WHERE id = ANY($1) OR id='R007'`, [[designRole, plainRole, designExplicit]]);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      for (const r of rows) expect(r.portfolio_review_kind).toBe('design_portfolio');
    });

    test('the kind CHECK rejects anything but the two defined kinds, and NULL', async () => {
      for (const bad of ['astrology', '', 'Marketing_Work', 'marketing', ' marketing_work', 'marketing_work ', 'design']) {
        await expect(db.query(`UPDATE roles SET portfolio_review_kind=$1 WHERE id=$2`, [bad, mktRole]), JSON.stringify(bad))
          .rejects.toThrow(/roles_portfolio_review_kind_check/);
      }
      await expect(db.query(`UPDATE roles SET portfolio_review_kind=NULL WHERE id=$1`, [mktRole])).rejects.toThrow(/not-null|null value/i);
      const { rows } = await db.query(`SELECT portfolio_review_kind FROM roles WHERE id=$1`, [mktRole]);
      expect(rows[0].portfolio_review_kind).toBe('marketing_work');      // every rejected write left the row alone
    });

    test('the kind CHECK accepts both kinds', async () => {
      await db.query('BEGIN');
      try {
        await db.query(`UPDATE roles SET portfolio_review_kind='design_portfolio' WHERE id=$1`, [mktRole]);
        await db.query(`UPDATE roles SET portfolio_review_kind='marketing_work' WHERE id=$1`, [mktRole]);
      } finally { await db.query('ROLLBACK'); }
    });

    test("applications_portfolio_status_check accepts 'unreviewable' and NULL, and still rejects junk", async () => {
      const { appId } = await addApp(mktRole, 'status-check');
      for (const bad of ['banana', '', 'Unreviewable', 'no portfolio', ' pending', 'unreviewable ', 'skipped', 'done']) {
        await expect(db.query(`UPDATE applications SET portfolio_analysis_status=$1 WHERE id=$2`, [bad, appId]), JSON.stringify(bad))
          .rejects.toThrow(/portfolio_status_check/);
      }
      for (const ok of ['pending', 'running', 'completed', 'failed', 'no_portfolio', 'inaccessible', 'unreviewable', null]) {
        await db.query('BEGIN');
        try { await db.query(`UPDATE applications SET portfolio_analysis_status=$1 WHERE id=$2`, [ok, appId]); }
        finally { await db.query('ROLLBACK'); }
      }
      expect((await reviewRow(appId)).status).toBeNull();
    });

    test('schema.sql (the permanent record) carries the same DDL: replaying its kinds block is idempotent and changes nothing', async () => {
      const file = path.join(process.cwd(), '..', 'backend', 'src', 'db', 'schema.sql');
      const all = fs.readFileSync(file, 'utf8');
      const marker = '-- ─── Portfolio review kinds';
      const at = all.indexOf(marker);
      expect(at, `"${marker}" is missing from schema.sql`).toBeGreaterThan(-1);
      const rest = all.slice(at + marker.length);
      const next = rest.indexOf('\n-- ───');
      const block = all.slice(at, next === -1 ? undefined : at + marker.length + next);
      expect(block).toContain('portfolio_review_kind');
      expect(block).toContain("'marketing_work'");
      expect(block).toContain("'unreviewable'");

      const defs = async () => (await db.query(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname IN ('roles_portfolio_review_kind_check','applications_portfolio_status_check') ORDER BY conname`)).rows;
      const colDefault = async () => (await db.query(
        `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name='roles' AND column_name='portfolio_review_kind'`)).rows;
      const before = { defs: await defs(), col: await colDefault() };
      expect(before.defs).toHaveLength(2);

      await db.query('BEGIN');
      try {
        await db.query(`SET LOCAL lock_timeout = '10s'`);
        await db.query(block);                       // the very text a fresh docker-compose database is built from
        expect({ defs: await defs(), col: await colDefault() }).toEqual(before);
      } finally { await db.query('ROLLBACK'); }
      expect({ defs: await defs(), col: await colDefault() }).toEqual(before);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('no API toggle', () => {
    test('POST /api/roles ignores portfolio fields in the body: a new role has the review OFF and the default kind', async ({ request }) => {
      const hr = await getToken(request, 'hr');
      const res = await authed(request, hr).post('/api/roles', {
        title: `R019 spec toggle ${RUN}`, priority: 'P2', portfolio_analysis_enabled: true, portfolio_review_kind: 'marketing_work',
      });
      expect(res.ok()).toBe(true);
      const id = (await res.json()).role.id as string;
      roleIds.push(id);
      const { rows } = await db.query(`SELECT portfolio_analysis_enabled, portfolio_review_kind FROM roles WHERE id=$1`, [id]);
      expect(rows[0]).toEqual({ portfolio_analysis_enabled: false, portfolio_review_kind: 'design_portfolio' });
    });

    test('PATCH /api/roles/:id ignores them too (the real field in the same request is still saved)', async ({ request }) => {
      const hr = await getToken(request, 'hr');
      const before = (await db.query(`SELECT portfolio_analysis_enabled, portfolio_review_kind FROM roles WHERE id=$1`, [plainRole])).rows[0];
      const res = await authed(request, hr).patch(`/api/roles/${plainRole}`, {
        additional_remarks: `remark ${RUN}`, portfolio_analysis_enabled: true, portfolio_review_kind: 'marketing_work',
      });
      expect(res.status()).toBe(200);
      const { rows } = await db.query(`SELECT portfolio_analysis_enabled, portfolio_review_kind, additional_remarks FROM roles WHERE id=$1`, [plainRole]);
      expect(rows[0].additional_remarks).toBe(`remark ${RUN}`);
      expect({ portfolio_analysis_enabled: rows[0].portfolio_analysis_enabled, portfolio_review_kind: rows[0].portfolio_review_kind }).toEqual(before);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('a flag-only role still takes the DESIGNER path (R007 behaviour unchanged)', () => {
    for (const label of ['kind left at its default', 'kind explicitly design_portfolio']) {
      const roleOf = () => (label.startsWith('kind left') ? designRole : designExplicit);

      test(`${label}: GET reports kind design_portfolio before any review exists`, async ({ request }) => {
        const { appId } = await addApp(roleOf(), 'design-get');
        const { code, body } = await review(request, appId);
        expect(code).toBe(200);
        expect(body.kind).toBe('design_portfolio');
        expect(body.status).toBeNull();
        expect(body.analysis).toBeNull();
        expect(body.urls).toEqual([]);
      });

      test(`${label}: Re-run reads the RESUME — an unreadable resume is a 502 that changes nothing`, async ({ request }) => {
        // A non-Drive resume link never reaches Google (no file id can be extracted), so this is a network-free way to say
        // "the resume could not be read". The designer path must refuse rather than guess: nothing may change.
        const { appId } = await addApp(roleOf(), 'design-badresume', {
          resumeLink: 'https://resume.example.invalid/cv.pdf', answer: `${driveFile(1)} https://janedoe.design/work`,
        });
        const before = await scoreState(appId);
        const r = await rerun(request, appId);
        expect(r.code).toBe(502);
        expect(r.body.error).toMatch(/resume could not be read right now/i);
        expect(await reviewRow(appId)).toMatchObject({ status: null, urls: null, score: null });
        expect(await scoreState(appId)).toEqual(before);
        expect(await analysisOf(appId)).toBeNull();
      });

      test(`${label}: with NO resume on file the answer's links are ignored — no_portfolio, no score, average untouched`, async ({ request }) => {
        const { appId } = await addApp(roleOf(), 'design-noresume', { answer: `${driveFile(2)} https://janedoe.design/work https://www.youtube.com/watch?v=dQw4w9WgXcQ` });
        const before = await scoreState(appId);
        const r = await rerun(request, appId);
        expect(r.code).toBe(202);
        expect(r.body).toEqual({ status: 'no_portfolio', links: 0, queued: false });
        const row = await reviewRow(appId);
        expect(row.status).toBe('no_portfolio');
        expect(row.score).toBeNull();
        expect(row.urls).toEqual([]);                              // the screening answer is not a source for the designer review
        expect(row.error).toMatch(/resume could not be read/i);
        expect(await scoreState(appId)).toEqual(before);
        expect(await analysisOf(appId)).toBeNull();                // the designer path writes no review for this outcome
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('marketing role: answers with nothing to review are NOT scored (never 0, average untouched)', () => {
    const BLANK = [
      'N/A', 'n/a', 'NA', 'N.A.', 'None', 'Nil', 'no', '-', '...', '—', 'Under NDA', 'All my work is under NDA',
      'Not applicable', 'Will share on request', 'Confidential - available on request', '   ',
      '\u{1F44D}',                                                   // an emoji is not an answer
      'नहीं',                                    // Hindi "nahin" (no): a few letters in another script is still too little to be a description
      'None of my work is public but I can show it in the interview',   // every word is absence / deferral vocabulary
    ];

    test('blank / "N/A" / "NDA" style answers: no_portfolio, NULL score, exact message, nothing else touched, and no model ran', async ({ request }) => {
      for (const answer of BLANK) {
        const { appId } = await addApp(mktRole, 'blank', { answer });
        const before = await scoreState(appId);
        const r = await rerun(request, appId);
        expect(r.code, JSON.stringify(answer)).toBe(202);
        expect(r.body, JSON.stringify(answer)).toEqual({ status: 'no_portfolio', links: 0, queued: false });

        const row = await reviewRow(appId);
        expect(row.status, JSON.stringify(answer)).toBe('no_portfolio');
        expect(row.score).toBeNull();
        expect(row.error).toBe('No work samples provided; this dimension is not applied');
        expect(row.urls).toEqual([]);
        expect(row.analyzed_at).not.toBeNull();
        expect(await scoreState(appId), JSON.stringify(answer)).toEqual(before);      // average, fit score, bucket, summary, flags, SLA, 8 scores, portfolio score+note

        const a = (await analysisOf(appId))!;
        expect(a).toMatchObject({ version: 1, kind: 'marketing_work', model: 'none', summary: 'No work samples were provided.' });
        expect(a.claimText).toBeUndefined();
        expect(a.unreviewed).toBeUndefined();
        expect(a.usage).toBeUndefined();
        expect(a.criteria).toEqual([]);
      }
    });

    test('the review is recorded in the activity log without touching the candidate\'s fit score', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'activity', { answer: 'N/A' });
      await rerun(request, appId);
      const { rows } = await db.query(
        `SELECT event_detail, new_value, performed_by_name FROM activity_log WHERE application_id=$1 AND event_type='Portfolio Review Completed'`, [appId]);
      expect(rows).toEqual([{ event_detail: 'Portfolio review: no_portfolio', new_value: 'no_portfolio', performed_by_name: 'System' }]);
    });

    test('no matching answer at all (null, empty, wrong shape, junk entries, only other questions) is the same blank outcome — never a 500', async ({ request }) => {
      const shapes: Array<[string, unknown]> = [
        ['null', null],
        ['empty array', []],
        ['an object, not an array', { question: Q_TYPO, answer: 'https://janedoe.design' }],
        ['a string', 'https://janedoe.design'],
        ['junk entries', [null, 5, 'x', [], { question: 1, answer: 2 }, { answer: 'https://janedoe.design' }, { question: Q_TYPO }]],
        ['answer is null', [{ question: Q_TYPO, answer: null }]],
        ['answer is an array of links', [{ question: Q_TYPO, answer: ['https://janedoe.design'] }]],
        ['only unrelated questions, with real links', [DECOYS[0], DECOYS[1], DECOYS[2]]],
      ];
      for (const [label, screening] of shapes) {
        const { appId } = await addApp(mktRole, 'shape', { screening });
        const before = await scoreState(appId);
        const r = await rerun(request, appId);
        expect(r.code, label).toBe(202);
        expect(r.body.status, label).toBe('no_portfolio');
        expect((await reviewRow(appId)).error, label).toBe('No work samples provided; this dimension is not applied');
        expect(await scoreState(appId), label).toEqual(before);
      }
    });

    test('links that are never work samples (the company site, scheduling, forms, WhatsApp) count as no answer', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'dropped', {
        answer: 'https://calendly.com/someone/intro https://forms.gle/abc123 https://wa.me/919999999999 https://www.digitalpaani.com/about',
      });
      const r = await rerun(request, appId);
      expect(r.body).toEqual({ status: 'no_portfolio', links: 0, queued: false });
      expect((await reviewRow(appId)).error).toBe('No work samples provided; this dimension is not applied');
    });

    test('addresses that must never be fetched (cloud metadata, loopback, private IPs, credentials, non-web schemes) never reach the queue', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'unsafe', {
        answer: 'http://169.254.169.254/latest/meta-data/ http://127.0.0.1:4000/api/auth/login http://localhost/admin http://10.0.0.5/portfolio ' +
                'http://user:secret@evil.example.com/work file:///etc/passwd javascript:alert(1) ftp://files.example.com/cv.pdf',
      });
      const before = await scoreState(appId);
      const r = await rerun(request, appId);
      expect(r.code).toBe(202);
      expect(r.body).toEqual({ status: 'no_portfolio', links: 0, queued: false });
      const row = await reviewRow(appId);
      expect(row.urls).toEqual([]);
      expect(JSON.stringify(row)).not.toMatch(/169\.254|127\.0\.0\.1|localhost|10\.0\.0\.5|secret@|passwd/);
      expect(await scoreState(appId)).toEqual(before);
    });

    test('words that merely CONTAIN "not" / "none" are still a description: only an answer made entirely of absence words is blank', async ({ request }) => {
      const real = await addApp(mktRole, 'phrasing-real', { answer: 'Not available publicly, but I led the Kinley relaunch end to end for three years.' });
      const r = await rerun(request, real.appId);
      expect(r.body.status).toBe('no_portfolio');
      expect((await reviewRow(real.appId)).error).toMatch(/written description/i);
      expect((await analysisOf(real.appId))!.claimText).toContain('Kinley relaunch');

      // a short answer plus a real link is a link answer, whatever the words around it say
      const withLink = await addApp(mktRole, 'phrasing-link', { answer: 'No campaigns yet but I run a blog at https://janedoe.design/blog' });
      expect((await rerun(request, withLink.appId)).body).toMatchObject({ status: 'pending', links: 1 });

      // an answer in another script is a description, not blank
      const hindi = await addApp(mktRole, 'phrasing-hindi', { answer: 'मैंने पाँच वर्ष तक ब्रांड कैम्पेन चलाए और टीम का नेतृत्व किया' });
      expect((await rerun(request, hindi.appId)).body.status).toBe('no_portfolio');
      expect((await reviewRow(hindi.appId)).error).toMatch(/written description/i);
    });

    test('a written description with no link: no_portfolio, NULL score, the words kept for HR as claimText, average untouched', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'textonly', { answer: WRITTEN_ONLY });
      const before = await scoreState(appId);
      const r = await rerun(request, appId);
      expect(r.code).toBe(202);
      expect(r.body).toEqual({ status: 'no_portfolio', links: 0, queued: false });

      const row = await reviewRow(appId);
      expect(row.status).toBe('no_portfolio');
      expect(row.score).toBeNull();
      expect(row.urls).toEqual([]);
      expect(row.error).toMatch(/only a written description was provided/i);
      expect(row.error).toMatch(/not applied/i);
      expect(await scoreState(appId)).toEqual(before);

      const a = (await analysisOf(appId))!;
      expect(a.kind).toBe('marketing_work');
      expect(a.model).toBe('none');
      expect(a.claimText).toBe(WRITTEN_ONLY);
      expect(a.summary).toMatch(/written description/i);
      expect(a.unreviewed).toBeUndefined();
    });

    test('words around a dropped link are still a written description (the link is not counted as work)', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'words-and-dropped', { answer: `${WRITTEN_ONLY} Book a slot: https://calendly.com/someone/intro` });
      const r = await rerun(request, appId);
      expect(r.body.status).toBe('no_portfolio');
      expect((await reviewRow(appId)).error).toMatch(/written description/i);
      expect((await analysisOf(appId))!.claimText).toContain('happy to walk you through them');
    });

    test('LinkedIn-only: unreviewable, NULL score, the link listed for HR with the LinkedIn reason and a name check, average untouched', async ({ request }) => {
      const similar = await addApp(mktRole, 'li-similar', { name: 'Priyanka Verma', answer: 'https://www.linkedin.com/in/priyanka-verma-8a2b/' });
      const other = await addApp(mktRole, 'li-other', { name: 'Priyanka Verma', answer: 'https://www.linkedin.com/in/zed-quill-77' });
      for (const { appId } of [similar, other]) {
        const before = await scoreState(appId);
        const r = await rerun(request, appId);
        expect(r.code).toBe(202);
        expect(r.body).toEqual({ status: 'unreviewable', links: 0, queued: false });
        const row = await reviewRow(appId);
        expect(row.status).toBe('unreviewable');
        expect(row.score).toBeNull();
        expect(row.urls).toEqual([]);
        expect(row.error).toMatch(/cannot be opened automatically/i);
        expect(await scoreState(appId)).toEqual(before);
      }
      const a1 = (await analysisOf(similar.appId))!;
      expect(a1.kind).toBe('marketing_work');
      expect(a1.unreviewed).toHaveLength(1);
      expect(a1.unreviewed[0]).toMatchObject({ url: 'https://www.linkedin.com/in/priyanka-verma-8a2b/', platform: 'linkedin' });
      expect(a1.unreviewed[0].reason).toMatch(/LinkedIn blocks automated viewing/);
      expect(a1.unreviewed[0].reason).toMatch(/looks like the candidate's name/);
      const a2 = (await analysisOf(other.appId))!;
      expect(a2.unreviewed[0].reason).toMatch(/does not resemble the candidate's name/);
      expect(a2.claimText).toBeUndefined();                                    // a link answer is not a "written description"
    });

    test('only links that are never opened (LinkedIn + Facebook + WeTransfer): unreviewable, all three listed in order with their reasons', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'never-opened', {
        answer: 'https://www.linkedin.com/in/someone-else https://www.facebook.com/some.page https://we.tl/t-AbCdEf1234',
      });
      const r = await rerun(request, appId);
      expect(r.body).toEqual({ status: 'unreviewable', links: 0, queued: false });
      const a = (await analysisOf(appId))!;
      expect(a.unreviewed.map((u: any) => u.platform)).toEqual(['linkedin', 'social_other', 'cloud_file']);
      expect(a.unreviewed[1].reason).toBe('social media link not opened automatically');
      expect(a.unreviewed[2].reason).toBe('expiring file-transfer link');
      expect((await reviewRow(appId)).score).toBeNull();
    });

    test('an Instagram-only answer is NOT settled at enqueue (a caption snippet can be read): it is queued for the worker', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'ig-only', { answer: 'instagram.com/jane.creates' });
      const before = await scoreState(appId);
      const r = await rerun(request, appId);
      expect(r.code).toBe(202);
      expect(r.body).toMatchObject({ status: 'pending', links: 1 });
      const row = await reviewRow(appId);
      expect(row.status).toBe('pending');
      expect(row.urls).toHaveLength(1);
      expect(row.urls[0]).toMatchObject({ platform: 'instagram', handler: 'social', host: 'instagram.com' });
      expect(await scoreState(appId)).toEqual(before);                      // nothing is folded until the worker settles it
    });

    test('Re-run twice is stable: same outcome, one stored review, one activity row per run, average still untouched', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'twice', { answer: 'N/A' });
      const before = await scoreState(appId);
      expect((await rerun(request, appId)).body.status).toBe('no_portfolio');
      expect((await rerun(request, appId)).body.status).toBe('no_portfolio');
      expect(await scoreState(appId)).toEqual(before);
      expect(Number((await db.query(`SELECT count(*) AS n FROM portfolio_analyses WHERE application_id=$1`, [appId])).rows[0].n)).toBe(1);
      expect(await activityCount(appId)).toBe(2);
    });

    test('when the answer changes between runs the stored review is replaced whole — no stale claimText or link list survives', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'changing', { answer: 'N/A' });
      expect((await rerun(request, appId)).body.status).toBe('no_portfolio');
      expect((await analysisOf(appId))!.summary).toBe('No work samples were provided.');

      await setAnswer(appId, 'https://www.linkedin.com/in/zed-quill-77');
      expect((await rerun(request, appId)).body.status).toBe('unreviewable');
      let a = (await analysisOf(appId))!;
      expect(a.unreviewed).toHaveLength(1);
      expect(a.claimText).toBeUndefined();

      await setAnswer(appId, WRITTEN_ONLY);
      expect((await rerun(request, appId)).body.status).toBe('no_portfolio');
      a = (await analysisOf(appId))!;
      expect(a.claimText).toBe(WRITTEN_ONLY);
      expect(a.unreviewed).toBeUndefined();

      await setAnswer(appId, 'N/A');
      await rerun(request, appId);
      a = (await analysisOf(appId))!;
      expect(a.claimText).toBeUndefined();
      expect(a.summary).toBe('No work samples were provided.');
    });

    test('a long answer cut mid-emoji at the 1500-character cap is stored cleanly (no broken surrogate, no 500)', async ({ request }) => {
      const answer = `${'a'.repeat(1499)}\u{1F600}\u{1F600} and more words after it`;
      const { appId } = await addApp(mktRole, 'emoji', { answer });
      const r = await rerun(request, appId);
      expect(r.code).toBe(202);
      expect(r.body.status).toBe('no_portfolio');
      const claim = (await analysisOf(appId))!.claimText as string;
      expect(claim.length).toBeLessThanOrEqual(1500);
      expect(claim.startsWith('a'.repeat(1499))).toBe(true);
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(claim)).toBe(false);
    });

    test('hostile answers (100 KB of punctuation, one 100 KB token, thousands of links) answer quickly and never crash the route', async ({ request }) => {
      const cases: Array<[string, string, string]> = [
        ['punctuation run', '.'.repeat(100_000), 'no_portfolio'],
        ['one huge token', 'a'.repeat(100_000), 'no_portfolio'],
        ['one huge fake URL', `https://${'a'.repeat(100_000)}`, 'no_portfolio'],
        ['5000 distinct links', Array.from({ length: 5000 }, (_, i) => `https://h${i}.example.com/work`).join(' '), 'pending'],
      ];
      for (const [label, answer, expected] of cases) {
        const { appId } = await addApp(mktRole, 'hostile', { answer });
        const started = Date.now();
        const r = await rerun(request, appId);
        expect(r.code, label).toBe(202);
        expect(r.body.status, label).toBe(expected);
        expect(Date.now() - started, `${label} took too long`).toBeLessThan(10_000);
        if (expected === 'pending') expect((await reviewRow(appId)).urls.length).toBeLessThanOrEqual(2);   // the website cap holds on hostile input
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('marketing role: real link answers are stored and queued', () => {
    test('a Drive PDF + a website: pending, both stored with their handlers, documents ranked before sites, and the local queue note shown', async ({ request }) => {
      // The website comes FIRST in the answer: the document must still be ranked ahead of it.
      const { appId } = await addApp(mktRole, 'links', { answer: `Site: https://janedoe.design/work and the case-study deck ${driveFile(1)}` });
      const before = await scoreState(appId);
      const r = await rerun(request, appId);
      expect(r.code).toBe(202);
      expect(r.body.status).toBe('pending');
      expect(r.body.links).toBe(2);
      expect(r.body.queued).toBe(false);                                     // outside Vercel the queue's send() fails by design

      const row = await reviewRow(appId);
      expect(row.status).toBe('pending');
      expect(row.score).toBeNull();
      expect(row.error).toMatch(NOT_QUEUED);
      expect(row.urls).toHaveLength(2);
      expect(row.urls[0]).toMatchObject({ host: 'drive.google.com', platform: 'gdrive_file', handler: 'document' });
      expect(row.urls[0].url).toContain(driveId(1));
      expect(row.urls[1]).toMatchObject({ host: 'janedoe.design', platform: 'custom', handler: 'site' });
      expect(await scoreState(appId)).toEqual(before);                       // nothing folds until the worker settles the review
      expect(await analysisOf(appId)).toBeNull();                            // no review is invented while the job is waiting

      const got = await review(request, appId);
      expect(got.body).toMatchObject({ kind: 'marketing_work', status: 'pending', score: null });
      expect(got.body.message).toMatch(NOT_QUEUED);
      expect(got.body.urls).toHaveLength(2);
    });

    test('the same file in different Drive spellings is one link; tracking parameters are removed; scheme-less handles are found', async ({ request }) => {
      const id = driveId(7);
      const { appId } = await addApp(mktRole, 'dedupe', {
        answer: `https://drive.google.com/file/d/${id}/view?usp=sharing https://drive.google.com/open?id=${id} https://drive.google.com/uc?id=${id}&export=download ` +
                `youtu.be/dQw4w9WgXcQ?si=trackme https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=newsletter&fbclid=abc123`,
      });
      const r = await rerun(request, appId);
      expect(r.body.status).toBe('pending');
      const urls = (await reviewRow(appId)).urls as Array<Record<string, string>>;
      expect(urls.map(u => u.platform).sort()).toEqual(['gdrive_file', 'youtube']);
      for (const u of urls) expect(u.url).not.toMatch(/utm_|fbclid|[?&]si=|igsh/);
      expect(urls.find(u => u.platform === 'youtube')!.handler).toBe('video');
    });

    test('caps: at most 3 documents, 2 websites, 2 videos and 1 Instagram profile are opened (8 in all); LinkedIn never takes a slot', async ({ request }) => {
      const answer = [
        driveFile(10), driveFile(11), driveFile(12), driveFile(13), driveFile(14),          // 5 files -> 3
        'https://studio-one.design', 'https://studio-two.agency', 'https://studio-three.studio', 'https://studio-four.net',   // 4 sites -> 2
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://vimeo.com/123456789', 'https://www.loom.com/share/abcdefghij1234567890',   // 3 videos -> 2
        'https://instagram.com/jane.one', 'https://instagram.com/jane.two',                // 2 profiles -> 1 (one per website)
        'https://www.linkedin.com/in/jane-doe',
      ].join('\n');
      const { appId } = await addApp(mktRole, 'caps', { answer });
      const r = await rerun(request, appId);
      expect(r.body.status).toBe('pending');
      expect(r.body.links).toBe(8);
      const urls = (await reviewRow(appId)).urls as Array<{ handler: string; platform: string }>;
      expect(urls.map(u => u.handler)).toEqual(['document', 'document', 'document', 'site', 'site', 'video', 'video', 'social']);
      expect(urls.some(u => u.platform === 'linkedin')).toBe(false);
    });

    test('shortened links and link-in-bio pages are queued for the worker to resolve (handler "resolve", at most 2)', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'resolve', { answer: 'https://bit.ly/3AbCdEf https://linktr.ee/janedoe https://tinyurl.com/yabc1234' });
      const r = await rerun(request, appId);
      expect(r.body).toMatchObject({ status: 'pending', links: 2 });
      const urls = (await reviewRow(appId)).urls as Array<{ handler: string; platform: string }>;
      expect(urls.every(u => u.handler === 'resolve' && u.platform === 'link_hub')).toBe(true);
    });

    test('a pending re-run keeps the earlier score and average (the earlier review still counts until the new one settles)', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'pending-keeps', { answer: driveFile(20), portfolioScore: 7, portfolioStatus: 'completed' });
      await putAnalysis(appId, EARLIER_ANALYSIS);
      await setStoredUrls(appId, PRIOR_URLS);
      const before = await scoreState(appId);
      expect(before.score_portfolio).toBe(7);
      const r = await rerun(request, appId);
      expect(r.body).toMatchObject({ status: 'pending', links: 1, queued: false });
      expect(await scoreState(appId)).toEqual(before);
      expect((await reviewRow(appId)).status).toBe('pending');
      expect(await analysisOf(appId)).toEqual(EARLIER_ANALYSIS);
      // The score is kept, but a run that IS queued gets the answer's links: the worker reads portfolio_urls as the list
      // to open, so keeping the earlier links here would review the wrong files.
      const urls = (await reviewRow(appId)).urls as Array<{ url: string }>;
      expect(urls).toHaveLength(1);
      expect(urls[0].url).toContain(driveId(20));
    });

    test('Re-run needs no Drive and no resume: works with no resume on file and with an unreadable resume link (the designer path would 502)', async ({ request }) => {
      const none = await addApp(mktRole, 'no-resume', { answer: driveFile(30), resumeLink: null });
      const bad = await addApp(mktRole, 'bad-resume', { answer: driveFile(31), resumeLink: 'https://resume.example.invalid/cv.pdf' });
      for (const { appId } of [none, bad]) {
        const r = await rerun(request, appId);
        expect(r.code).toBe(202);
        expect(r.body).toMatchObject({ status: 'pending', links: 1 });
      }
      const blank = await addApp(mktRole, 'no-resume-blank', { answer: 'N/A', resumeLink: 'https://resume.example.invalid/cv.pdf' });
      expect((await rerun(request, blank.appId)).body.status).toBe('no_portfolio');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('Re-run never overwrites an earlier good review with "nothing to review"', () => {
    const CASES: Array<[string, string, RegExp]> = [
      ['a blank answer', 'N/A', /No work samples were found in the answer this time/],
      ['a written description only', WRITTEN_ONLY, /Only a written description was found this time/],
      ['links on platforms that are never opened', 'https://www.linkedin.com/in/zed-quill-77', /could not be opened this time/],
    ];

    for (const [label, answer, now] of CASES) {
      test(`earlier 7/10 + ${label}: ends 'failed' with a message that keeps the 7, score / average / stored review untouched`, async ({ request }) => {
        const { appId } = await addApp(mktRole, 'guard', { answer, portfolioScore: 7, portfolioStatus: 'completed' });
        await putAnalysis(appId, EARLIER_ANALYSIS);
        await setStoredUrls(appId, PRIOR_URLS);
        await db.query(`UPDATE applications SET score_avg=6.6, ai_fit_score=66, score_summary='Base summary. Portfolio review: EARLIER ONE-LINER', score_red_flags=ARRAY['Base red flag','Portfolio: earlier flag'] WHERE id=$1`, [appId]);
        const before = await scoreState(appId);

        const r = await rerun(request, appId);
        expect(r.code).toBe(202);
        expect(r.body).toEqual({ status: 'failed', links: 0, queued: false });

        const row = await reviewRow(appId);
        expect(row.status).toBe('failed');
        expect(row.error).toMatch(now);
        expect(row.error).toContain('the earlier review (7/10) still applies');
        expect(row.error).toMatch(/Use Re-run to retry\.$/);
        expect(row.score).toBe(7);
        expect(row.urls).toEqual(PRIOR_URLS);                           // the links the kept 7/10 was built from are NOT wiped
        expect(await scoreState(appId)).toEqual(before);
        expect(await analysisOf(appId)).toEqual(EARLIER_ANALYSIS);
        expect(await activityCount(appId)).toBe(0);                     // nothing was "completed"

        const got = await review(request, appId);                        // and what the card reads says the same
        expect(got.body).toMatchObject({ kind: 'marketing_work', status: 'failed', score: 7, urls: PRIOR_URLS });
        expect(got.body.analysis.summary).toBe('EARLIER REVIEW');
      });
    }

    test('an earlier score of 0 is still a review (0 is not "no score")', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'guard-zero', { answer: 'N/A', portfolioScore: 0, portfolioStatus: 'completed' });
      await setStoredUrls(appId, PRIOR_URLS);
      const before = await scoreState(appId);
      const r = await rerun(request, appId);
      expect(r.body.status).toBe('failed');
      const row = await reviewRow(appId);
      expect(row.error).toContain('the earlier review (0/10) still applies');
      expect(row.score).toBe(0);
      expect(row.urls).toEqual(PRIOR_URLS);                             // a 0 is a review too: its links stay
      expect(await scoreState(appId)).toEqual(before);
    });

    test('with no earlier score the same answers settle normally (the guard only protects a real review) and nothing is left to keep: the links are emptied', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'guard-none', { answer: 'N/A', portfolioScore: null, portfolioStatus: 'failed' });
      await setStoredUrls(appId, PRIOR_URLS);                           // left by an earlier run that never produced a score
      const r = await rerun(request, appId);
      expect(r.body.status).toBe('no_portfolio');
      const row = await reviewRow(appId);
      expect(row.status).toBe('no_portfolio');
      expect(row.urls).toEqual([]);
    });

    test('a declined re-run repeated: the earlier links survive any number of them, and a later re-run with a real link replaces them', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'guard-repeat', { answer: 'N/A', portfolioScore: 6, portfolioStatus: 'completed' });
      await setStoredUrls(appId, PRIOR_URLS);
      for (let i = 0; i < 3; i++) {
        expect((await rerun(request, appId)).body.status).toBe('failed');
        expect((await reviewRow(appId)).urls).toEqual(PRIOR_URLS);
      }
      await setAnswer(appId, driveFile(50));                            // HR/candidate fixes the answer: this run is queued
      expect((await rerun(request, appId)).body).toMatchObject({ status: 'pending', links: 1 });
      const row = await reviewRow(appId);
      expect(row.score).toBe(6);                                        // still the earlier score until the worker settles
      expect((row.urls as Array<{ url: string }>).map(u => u.url.includes(driveId(50)))).toEqual([true]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('routes: personas, missing pieces, running / stale, flag off', () => {
    test('a hiring manager can read the review (200) but cannot Re-run it (403, nothing changes); HR-tier personas can; no token is 401', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'persona', { answer: 'N/A' });
      const hmGet = await review(request, appId, 'hm_alex');
      expect(hmGet.code).toBe(200);
      expect(hmGet.body.kind).toBe('marketing_work');
      expect((await rerun(request, appId, 'hm_alex')).code).toBe(403);
      expect((await rerun(request, appId, 'hm_satyadev')).code).toBe(403);
      expect(await reviewRow(appId)).toMatchObject({ status: null, urls: null, score: null });

      expect((await rerun(request, appId, 'leadership')).code).toBe(202);
      expect((await rerun(request, appId, 'hr2')).code).toBe(202);
      expect((await reviewRow(appId)).status).toBe('no_portfolio');

      expect((await request.get(`${BASE}/api/applications/${appId}/portfolio-analysis`)).status()).toBe(401);
      expect((await request.post(`${BASE}/api/applications/${appId}/portfolio-analysis`, { data: {} })).status()).toBe(401);
    });

    test('an unknown application is a 404 for both GET and Re-run', async ({ request }) => {
      const id = `A_NOPE_${RUN}`;
      expect((await review(request, id)).code).toBe(404);
      const r = await rerun(request, id);
      expect(r.code).toBe(404);
      expect(r.body.error).toMatch(/not found/i);
    });

    test('Re-run before base ResumeIQ scoring has finished is a 409 that changes nothing', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'unscored-base', { answer: 'N/A', scored: false });
      const r = await rerun(request, appId);
      expect(r.code).toBe(409);
      expect(r.body.error).toMatch(/resume scoring has not completed/i);
      expect(await reviewRow(appId)).toMatchObject({ status: null, urls: null });
      expect(await analysisOf(appId)).toBeNull();
    });

    test('Re-run is refused while a review is genuinely running (409, state untouched) — and allowed once the job must be dead', async ({ request }) => {
      // STALE_RUNNING_SECONDS = 310: a live job (< 310 s) is never stolen, a killed one (> 310 s) is reclaimable.
      for (const secs of [5, 300]) {
        const { appId } = await addApp(mktRole, 'running', { answer: 'N/A', portfolioStatus: 'running', startedSecondsAgo: secs });
        const r = await rerun(request, appId);
        expect(r.code, `${secs}s ago`).toBe(409);
        expect(r.body.error).toMatch(/already running/i);
        expect((await reviewRow(appId)).status).toBe('running');
        expect(await analysisOf(appId)).toBeNull();
      }
      for (const secs of [320, 11 * 60, 6 * 3600]) {
        const { appId } = await addApp(mktRole, 'stale', { answer: 'N/A', portfolioStatus: 'running', startedSecondsAgo: secs });
        const r = await rerun(request, appId);
        expect(r.code, `${secs}s ago`).toBe(202);
        expect((await reviewRow(appId)).status).toBe('no_portfolio');
      }
    });

    test('eight simultaneous Re-runs (a double click, a backfill racing a person) all succeed and leave one consistent review', async ({ request }) => {
      // no earlier review: every run settles the same way
      const fresh = await addApp(mktRole, 'race-fresh', { answer: WRITTEN_ONLY });
      const freshBefore = await scoreState(fresh.appId);
      const runs = await Promise.all(Array.from({ length: 8 }, () => rerun(request, fresh.appId)));
      expect(runs.map(r => r.code)).toEqual(Array(8).fill(202));
      expect((await reviewRow(fresh.appId)).status).toBe('no_portfolio');
      expect(await scoreState(fresh.appId)).toEqual(freshBefore);
      expect(Number((await db.query(`SELECT count(*) AS n FROM portfolio_analyses WHERE application_id=$1`, [fresh.appId])).rows[0].n)).toBe(1);
      expect(await activityCount(fresh.appId)).toBe(8);

      // an earlier 7/10: whichever run lands last, the row must end 'failed' with the 7 intact — never stuck 'pending', never a settled no_portfolio
      const guarded = await addApp(mktRole, 'race-guard', { answer: 'N/A', portfolioScore: 7, portfolioStatus: 'completed' });
      await putAnalysis(guarded.appId, EARLIER_ANALYSIS);
      const guardedBefore = await scoreState(guarded.appId);
      const more = await Promise.all(Array.from({ length: 8 }, () => rerun(request, guarded.appId)));
      expect(more.map(r => r.code)).toEqual(Array(8).fill(202));
      const row = await reviewRow(guarded.appId);
      expect(row.status).toBe('failed');
      expect(row.error).toContain('the earlier review (7/10) still applies');
      expect(await scoreState(guarded.appId)).toEqual(guardedBefore);
      expect(await analysisOf(guarded.appId)).toEqual(EARLIER_ANALYSIS);
    });

    test('if the outcome cannot be recorded the row is left \'failed\' with a Re-run hint (never stuck \'pending\'), the score state is untouched, and the next Re-run recovers', async ({ request }) => {
      // The failure the deploy-order note warns about (a status the database refuses), induced here with a trigger that
      // makes the activity-log insert of ONE application fail inside applyPortfolioOutcome's transaction. It matches only
      // that application, and is dropped in `finally` (and again in afterAll) so nothing outlives this test.
      const { appId } = await addApp(mktRole, 'induced-failure', { answer: 'N/A' });
      const before = await scoreState(appId);
      const fn = `r019spec_fail_${RUN}`;
      await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
                        IF NEW.application_id = '${appId}' THEN RAISE EXCEPTION 'r019spec induced failure'; END IF; RETURN NEW; END $$`);
      await db.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      try {
        const bad = await rerun(request, appId);
        expect(bad.code).toBe(500);
        const row = await reviewRow(appId);
        expect(row.status).toBe('failed');
        expect(row.error).toBe('The review could not be recorded. Use Re-run to retry.');
        expect(await scoreState(appId)).toEqual(before);
        expect(await analysisOf(appId)).toBeNull();                       // the half-written outcome was rolled back
      } finally {
        await db.query(`DROP TRIGGER IF EXISTS ${fn} ON activity_log`);
        await db.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      }
      const ok = await rerun(request, appId);                             // 'failed' is re-runnable
      expect(ok.code).toBe(202);
      expect((await reviewRow(appId)).status).toBe('no_portfolio');
    });

    test('flag OFF beats the kind: Re-run is a 400 for a role whose review is switched off (default kind or kind marketing_work)', async ({ request }) => {
      for (const roleId of [plainRole, offRole]) {
        const { appId } = await addApp(roleId, 'flag-off', { answer: 'N/A' });
        const r = await rerun(request, appId);
        expect(r.code).toBe(400);
        expect(r.body.error).toMatch(/not enabled/i);
        expect(await reviewRow(appId)).toMatchObject({ status: null, urls: null });
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('GET /api/applications/:id/portfolio-analysis reports which review it is (kind)', () => {
    test('before any review the ROLE\'s kind says which one is on its way (marketing, designer, and a role with the review off)', async ({ request }) => {
      const m = await addApp(mktRole, 'kind-m');
      const d = await addApp(designRole, 'kind-d');
      const off = await addApp(offRole, 'kind-off');
      const plain = await addApp(plainRole, 'kind-plain');
      for (const [{ appId }, kind] of [[m, 'marketing_work'], [d, 'design_portfolio'], [off, 'marketing_work'], [plain, 'design_portfolio']] as const) {
        const { code, body } = await review(request, appId);
        expect(code).toBe(200);
        expect(body.kind).toBe(kind);
        expect(body).toMatchObject({ status: null, message: null, urls: [], analyzed_at: null, score: null, note: null, analysis: null });
      }
    });

    test('a settled marketing review: kind, status, message, urls, analyzed_at, a NULL score and the stored analysis', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'kind-settled', { answer: WRITTEN_ONLY });
      await rerun(request, appId);
      const { code, body } = await review(request, appId);
      expect(code).toBe(200);
      expect(body.kind).toBe('marketing_work');
      expect(body.status).toBe('no_portfolio');
      expect(body.message).toMatch(/only a written description was provided/i);
      expect(body.urls).toEqual([]);
      expect(typeof body.analyzed_at).toBe('string');
      expect(body.score).toBeNull();
      expect(body.note).toBeNull();
      expect(body.analysis).toMatchObject({ version: 1, kind: 'marketing_work', claimText: WRITTEN_ONLY });
    });

    test('a stored review names its own kind and wins over the role\'s kind', async ({ request }) => {
      const a = await addApp(mktRole, 'kind-wins-1');
      await putAnalysis(a.appId, { ...EARLIER_ANALYSIS, kind: 'design_portfolio' });
      expect((await review(request, a.appId)).body.kind).toBe('design_portfolio');

      const b = await addApp(designRole, 'kind-wins-2');
      await putAnalysis(b.appId, { ...EARLIER_ANALYSIS, kind: 'marketing_work' });
      expect((await review(request, b.appId)).body.kind).toBe('marketing_work');

      // a stored review whose JSON names no VALID kind is a designer review (see the next test), never the role's kind
      const c = await addApp(mktRole, 'kind-wins-3');
      await putAnalysis(c.appId, { ...EARLIER_ANALYSIS, kind: 'astrology' });
      expect((await review(request, c.appId)).body.kind).toBe('design_portfolio');
    });

    // The route's rule: a stored review names its own kind; one that names none (every review made before kinds existed,
    // when only designer reviews existed) is a designer review, so a later change to the role's kind can never relabel an
    // old review. Only while NO review is stored does the role's kind say which one is on its way.
    test('a stored review WITHOUT a kind (made before kinds existed) is a designer review even if the role\'s kind was changed later', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'kind-legacy');
      const { kind: _omit, ...legacy } = EARLIER_ANALYSIS;
      await putAnalysis(appId, legacy);
      const { code, body } = await review(request, appId);
      expect(code).toBe(200);
      expect(body.kind).toBe('design_portfolio');
      expect('kind' in body.analysis).toBe(false);                     // the stored review itself is passed on untouched

      // flipping the role's kind back and forth never changes what an old review is called
      const designApp = await addApp(designRole, 'kind-legacy-2');
      await putAnalysis(designApp.appId, legacy);
      await db.query(`UPDATE roles SET portfolio_review_kind='marketing_work' WHERE id=$1`, [designRole]);
      try {
        expect((await review(request, designApp.appId)).body.kind).toBe('design_portfolio');
        const fresh = await addApp(designRole, 'kind-fresh');          // no review stored yet: the role's (new) kind applies
        expect((await review(request, fresh.appId)).body.kind).toBe('marketing_work');
      } finally {
        await db.query(`UPDATE roles SET portfolio_review_kind='design_portfolio' WHERE id=$1`, [designRole]);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('GET /api/roles/filter-options reports the review kind per role', () => {
    test('marketing_work, design_portfolio (flag-only and explicit) and a role with the review off, each as the DB says', async ({ request }) => {
      const body = await (await authed(request, await getToken(request, 'hr')).get('/api/roles/filter-options')).json();
      const byId = new Map((body.roles as Array<{ id: string; portfolio_analysis_enabled: boolean; portfolio_review_kind: string }>).map(r => [r.id, r]));
      expect(byId.get(mktRole)).toMatchObject({ portfolio_analysis_enabled: true, portfolio_review_kind: 'marketing_work' });
      expect(byId.get(designRole)).toMatchObject({ portfolio_analysis_enabled: true, portfolio_review_kind: 'design_portfolio' });
      expect(byId.get(designExplicit)).toMatchObject({ portfolio_analysis_enabled: true, portfolio_review_kind: 'design_portfolio' });
      expect(byId.get(plainRole)).toMatchObject({ portfolio_analysis_enabled: false, portfolio_review_kind: 'design_portfolio' });
      // the kind is reported even while the review is off (the flag, not the kind, switches the review on)
      expect(byId.get(offRole)).toMatchObject({ portfolio_analysis_enabled: false, portfolio_review_kind: 'marketing_work' });
      for (const r of byId.values()) expect(['design_portfolio', 'marketing_work']).toContain(r.portfolio_review_kind);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('the answer is found by the question\'s wording', () => {
    const LINK = driveFile(40);

    test('both live wordings, the typo-free one, the stem alone, any capitalisation and a numbered/extended variant all select the answer', async ({ request }) => {
      const wordings = [
        Q_TYPO,
        Q_FIXED,
        'Links to public resources/portfolio to highlight your past work?',
        'LINKS TO PUBLIC RESOURCES/PORTFOLIO TO HIGHLIGHT YOUR PAST WORK?',
        '  7) links to Public Resources/Portfolio (Drive, Behance, YouTube) *',
        'Please share Links to public resources/portfolio',
      ];
      for (const question of wordings) {
        const { appId } = await addApp(mktRole, 'wording', { screening: withDecoys(question, `My work: ${LINK}`) });
        const r = await rerun(request, appId);
        expect(r.body, question).toMatchObject({ status: 'pending', links: 1 });
        const urls = (await reviewRow(appId)).urls as Array<{ url: string }>;
        expect(urls[0].url, question).toContain(driveId(40));       // the Drive file, not a decoy
      }
    });

    test('only the portfolio question is read: links in OTHER answers never leak in, in either direction', async ({ request }) => {
      // portfolio answer is "N/A" while other answers hold real links -> nothing to review
      const blank = await addApp(mktRole, 'leak-blank', { screening: withDecoys(Q_FIXED, 'N/A') });
      expect((await rerun(request, blank.appId)).body.status).toBe('no_portfolio');

      // portfolio answer has one link while other answers hold different ones -> only that one is picked
      const one = await addApp(mktRole, 'leak-one', { screening: withDecoys(Q_FIXED, 'https://janedoe.design/work') });
      const r = await rerun(request, one.appId);
      expect(r.body).toMatchObject({ status: 'pending', links: 1 });
      const urls = (await reviewRow(one.appId)).urls as Array<{ url: string; host: string }>;
      expect(urls.map(u => u.host)).toEqual(['janedoe.design']);
      expect(JSON.stringify(urls)).not.toMatch(/decoy/i);
    });

    test('a similar-looking but different question (resume link, LinkedIn URL, "Link to your portfolio") is not the work-sample answer', async ({ request }) => {
      const { appId } = await addApp(mktRole, 'other-q', {
        screening: [
          { question: 'Link to your portfolio', answer: LINK },
          { question: 'Public resources you follow?', answer: 'https://janedoe.design' },
          { question: 'Share a link to your resume', answer: LINK },
        ],
      });
      const r = await rerun(request, appId);
      expect(r.body.status).toBe('no_portfolio');
      expect((await reviewRow(appId)).error).toBe('No work samples provided; this dimension is not applied');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('min_portfolio_score works for both review kinds (whole-number scores, NULL never matches)', () => {
    let fMkt = '', fDes = '';
    const apps: Record<string, string> = {};            // label -> application id

    test.beforeAll(async ({ request }) => {
      fMkt = await newRoleViaSql('filter marketing', true, 'marketing_work');
      fDes = await newRoleViaSql('filter designer', true);
      for (const [role, tag] of [[fMkt, 'm'], [fDes, 'd']] as const) {
        for (const s of [10, 9, 8, 7]) apps[`${tag}${s}`] = (await addApp(role, `${tag}${s}`, { answer: 'N/A', portfolioScore: s, portfolioStatus: 'completed' })).appId;
        apps[`${tag}none`] = (await addApp(role, `${tag}none`, { answer: 'N/A' })).appId;
        apps[`${tag}rej9`] = (await addApp(role, `${tag}rej9`, { answer: 'N/A', portfolioScore: 9, portfolioStatus: 'completed', status: 'Rejected' })).appId;
      }
      // a REAL unscored marketing outcome (not hand-written): blank answer, Re-run settles it with a NULL score
      apps['mblank'] = (await addApp(fMkt, 'mblank', { answer: 'N/A' })).appId;
      expect((await rerun(request, apps['mblank'])).body.status).toBe('no_portfolio');
      // the designer's legacy "no link in the resume" outcome IS a 0 (the contrast the marketing decision is about)
      apps['dzero'] = (await addApp(fDes, 'dzero', { answer: 'N/A', portfolioScore: 0, portfolioStatus: 'no_portfolio' })).appId;
    });

    const labelsFor = async (request: APIRequestContext, qs: string) => {
      const res = await authed(request, await getToken(request, 'hr')).get(`/api/applications?limit=500&${qs}`);
      expect(res.status(), qs).toBe(200);
      const ids = ((await res.json()).applications as { id: string }[]).map(a => a.id);
      return Object.entries(apps).filter(([, id]) => ids.includes(id)).map(([l]) => l).sort();
    };

    test('"Portfolio >= 7.5" keeps 8, 9 and 10 on a marketing role and on a designer role', async ({ request }) => {
      expect(await labelsFor(request, `role_id=${fMkt}&status=Active&min_portfolio_score=7.5`)).toEqual(['m10', 'm8', 'm9']);
      expect(await labelsFor(request, `role_id=${fDes}&status=Active&min_portfolio_score=7.5`)).toEqual(['d10', 'd8', 'd9']);
    });

    test('inclusive boundaries and the status filter behave the same for both kinds', async ({ request }) => {
      expect(await labelsFor(request, `role_id=${fMkt}&status=Active&min_portfolio_score=9`)).toEqual(['m10', 'm9']);
      expect(await labelsFor(request, `role_id=${fDes}&status=Active&min_portfolio_score=9`)).toEqual(['d10', 'd9']);
      expect(await labelsFor(request, `role_id=${fMkt}&status=Rejected&min_portfolio_score=7.5`)).toEqual(['mrej9']);
      expect(await labelsFor(request, `role_id=${fDes}&status=Rejected&min_portfolio_score=7.5`)).toEqual(['drej9']);
    });

    test('an unscored marketing candidate (blank answer, NULL score) never matches — not even min 0 — while a designer\'s legacy 0 does', async ({ request }) => {
      const m = await labelsFor(request, `role_id=${fMkt}&status=Active&min_portfolio_score=0`);
      expect(m).toEqual(['m10', 'm7', 'm8', 'm9']);
      expect(m).not.toContain('mblank');
      expect(m).not.toContain('mnone');
      const d = await labelsFor(request, `role_id=${fDes}&status=Active&min_portfolio_score=0`);
      expect(d).toEqual(['d10', 'd7', 'd8', 'd9', 'dzero']);
    });

    test('a Re-run that finds nothing keeps an earlier 8 matchable (the guard leaves the score, so the filter still lists them)', async ({ request }) => {
      const r = await rerun(request, apps['m8']);
      expect(r.body.status).toBe('failed');
      expect(await labelsFor(request, `role_id=${fMkt}&status=Active&min_portfolio_score=7.5`)).toEqual(['m10', 'm8', 'm9']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  test.describe('batch backfill route accepts a marketing role', () => {
    const headers = { 'x-ingest-secret': ROLE_INGEST_SECRET };
    let bfRole = '';
    const ids: Record<string, string> = {};

    test.beforeAll(async () => {
      bfRole = await newRoleViaSql('backfill marketing', true, 'marketing_work');
      ids.blank   = (await addApp(bfRole, 'bf-blank', { answer: 'N/A' })).appId;
      ids.text    = (await addApp(bfRole, 'bf-text', { answer: WRITTEN_ONLY })).appId;
      ids.nothing = (await addApp(bfRole, 'bf-null', { screening: null })).appId;
      ids.links   = (await addApp(bfRole, 'bf-links', { answer: driveFile(50) })).appId;
      ids.done    = (await addApp(bfRole, 'bf-done', { answer: 'N/A', portfolioScore: 7, portfolioStatus: 'completed' })).appId;   // already reviewed: not eligible
      ids.rejected = (await addApp(bfRole, 'bf-rej', { answer: 'N/A', status: 'Rejected' })).appId;                                // not Active: not eligible by default
      ids.unscored = (await addApp(bfRole, 'bf-unscored', { answer: 'N/A', scored: false })).appId;                                // base score pending: not eligible
    });

    const backfill = async (request: APIRequestContext, data: Record<string, unknown>) => {
      const res = await retrying(() => request.post(`${BASE}/api/applications/portfolio-backfill`, { data, headers }));
      return { code: res.status(), body: await res.json() as Record<string, any> };
    };

    test('dry run lists nothing and changes nothing; remaining_before counts only Active, base-scored, never-reviewed applications', async ({ request }) => {
      const r = await backfill(request, { role_id: bfRole, dry_run: true });
      expect(r.code).toBe(200);
      expect(r.body).toMatchObject({ dry_run: true, processed: 0, remaining_before: 4, results: [] });
      for (const id of Object.values(ids)) expect(await analysisOf(id)).toBeNull();
      expect((await reviewRow(ids.blank)).status).toBeNull();
    });

    test('dry-run paging steps over the page it just looked at (next_offset = offset + page) until the last page', async ({ request }) => {
      const p1 = await backfill(request, { role_id: bfRole, dry_run: true, limit: 3 });
      expect(p1.body.next_offset).toBe(3);
      const p2 = await backfill(request, { role_id: bfRole, dry_run: true, limit: 3, offset: 3 });
      expect(p2.body.next_offset).toBeNull();
    });

    test('a real pass settles the answers that need no job (no model, no queue) and queues the rest; reviewed / non-Active / unscored rows are untouched', async ({ request }) => {
      const r = await backfill(request, { role_id: bfRole });
      expect(r.code).toBe(200);
      expect(r.body.dry_run).toBe(false);
      const byId = new Map((r.body.results as Array<{ id: string; status: string; links?: number; queued?: boolean }>).map(x => [x.id, x]));
      expect(byId.size).toBe(4);
      expect(byId.get(ids.blank)).toMatchObject({ status: 'no_portfolio', links: 0, queued: false });
      expect(byId.get(ids.text)).toMatchObject({ status: 'no_portfolio', links: 0, queued: false });
      expect(byId.get(ids.nothing)).toMatchObject({ status: 'no_portfolio', links: 0, queued: false });
      expect(byId.get(ids.links)).toMatchObject({ status: 'pending', links: 1, queued: false });
      expect(r.body).toMatchObject({ processed: 4, left_unchanged: 0, next_offset: null });

      expect((await analysisOf(ids.text))!.claimText).toBe(WRITTEN_ONLY);
      expect((await reviewRow(ids.links)).urls).toHaveLength(1);
      expect(await reviewRow(ids.done)).toMatchObject({ status: 'completed', score: 7 });
      expect((await reviewRow(ids.rejected)).status).toBeNull();
      expect((await reviewRow(ids.unscored)).status).toBeNull();
      for (const id of [ids.blank, ids.text, ids.nothing]) expect((await reviewRow(id)).score).toBeNull();
    });

    test('a second pass finds nothing left to do; asking for another status picks up that status only', async ({ request }) => {
      expect((await backfill(request, { role_id: bfRole, dry_run: true })).body.remaining_before).toBe(0);
      const rej = await backfill(request, { role_id: bfRole, statuses: ['Rejected'] });
      expect(rej.body.results).toHaveLength(1);
      expect(rej.body.results[0]).toMatchObject({ id: ids.rejected, status: 'no_portfolio' });
      expect((await reviewRow(ids.unscored)).status).toBeNull();
    });

    test('min_score is a floor on the ResumeIQ average (inclusive), shared by the page and the remaining count, and a bad value is a 400', async ({ request }) => {
      const floorRole = await newRoleViaSql('backfill floor', true, 'marketing_work');
      const f: Record<string, string> = {};
      for (const [label, score] of [['low', 3.9], ['edge', 4.0], ['above', 4.1], ['high', 9.9]] as const) {
        f[label] = (await addApp(floorRole, `bf-floor-${label}`, { answer: 'N/A' })).appId;
        await db.query(`UPDATE applications SET score_avg=$1 WHERE id=$2`, [score, f[label]]);
      }
      f.rejected = (await addApp(floorRole, 'bf-floor-rej', { answer: 'N/A', status: 'Rejected' })).appId;
      await db.query(`UPDATE applications SET score_avg=8.0 WHERE id=$1`, [f.rejected]);

      const remaining = async (data: Record<string, unknown>) => (await backfill(request, { role_id: floorRole, dry_run: true, ...data })).body.remaining_before;
      expect(await remaining({})).toBe(4);                                  // no floor: every Active, scored, never-reviewed row
      expect(await remaining({ min_score: 0 })).toBe(4);
      expect(await remaining({ min_score: 4 })).toBe(3);                    // 4.0 itself is IN (equal to and above), 3.9 is out
      expect(await remaining({ min_score: '4.0' })).toBe(3);                // a numeric string is the same number
      expect(await remaining({ min_score: 4.05 })).toBe(2);
      expect(await remaining({ min_score: 9.9 })).toBe(1);
      expect(await remaining({ min_score: 10 })).toBe(0);
      const echoed = await backfill(request, { role_id: floorRole, dry_run: true, min_score: 4 });
      expect(echoed.body.min_score).toBe(4);
      expect((await backfill(request, { role_id: floorRole, dry_run: true })).body).not.toHaveProperty('min_score');   // the old response shape when no floor is given

      for (const bad of [-1, 10.5, 'abc', '', true, [4], {}]) {
        const r = await backfill(request, { role_id: floorRole, dry_run: true, min_score: bad });
        expect(r.code, JSON.stringify(bad)).toBe(400);
        expect(r.body.error).toMatch(/min_score/);
      }
      for (const id of Object.values(f)) expect((await reviewRow(id)).status).toBeNull();   // dry runs and refusals change nothing

      // paging with a floor: two rows per page, the page and next_offset follow the FILTERED set
      const p1 = await backfill(request, { role_id: floorRole, dry_run: true, min_score: 4, limit: 2 });
      expect(p1.body.next_offset).toBe(2);
      const p2 = await backfill(request, { role_id: floorRole, dry_run: true, min_score: 4, limit: 2, offset: 2 });
      expect(p2.body.next_offset).toBeNull();

      // a real pass with the floor touches only the rows at or above it
      const real = await backfill(request, { role_id: floorRole, min_score: 4 });
      expect(real.code).toBe(200);
      expect(new Set((real.body.results as Array<{ id: string }>).map(x => x.id))).toEqual(new Set([f.edge, f.above, f.high]));
      expect((await reviewRow(f.low)).status).toBeNull();                   // below the floor: untouched, still eligible later
      expect((await reviewRow(f.rejected)).status).toBeNull();              // not Active: untouched
      for (const id of [f.edge, f.above, f.high]) expect((await reviewRow(id)).status).toBe('no_portfolio');
      expect(await remaining({})).toBe(1);                                  // only the 3.9 row is left to do
    });

    test('refuses a role with the review off (default kind or kind marketing_work) and an unknown role; the secret is still required', async ({ request }) => {
      for (const role_id of [plainRole, offRole]) {
        const r = await backfill(request, { role_id, dry_run: true });
        expect(r.code, role_id).toBe(400);
        expect(r.body.error).toMatch(/not enabled/i);
      }
      expect((await backfill(request, { role_id: `R_NOPE_${RUN}` })).code).toBe(404);
      const noSecret = await request.post(`${BASE}/api/applications/portfolio-backfill`, { data: { role_id: bfRole, dry_run: true } });
      expect(noSecret.status()).toBe(401);
    });
  });
});
