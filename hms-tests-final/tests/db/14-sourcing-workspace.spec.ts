// ─────────────────────────────────────────────────────────────────────────────
// Sourcing workspace (2026-10-21): the channel task model (log the post -> weekly tracker), Close / Reopen channel, channel settings,
// the per-role qualified target, the complete plan history, the Dashboard workspace endpoint, AI next steps, and the attribution aliases.
// Companion to 13-sourcing-plans.spec.ts (lifecycle, engine, redaction) — same conventions: every test makes its own throwaway roles
// with uid(), real overdue / finished-week states are made by backdating timestamps in Postgres, the engine runs through
// /api/cron/sourcing-check, everything is removed in afterAll, and the whole file skips itself when SOURCING_ENABLED is not true.
// INTENTIONALLY LOCAL-ONLY (direct Postgres access). The advice and ingest tests call the local backend's configured model, so a few
// of them take several seconds each.
//
// The weekly-tracker lifecycle (who starts and stops a tracker, what a stop records) is pinned from several sides: (c) the weeks, (d) close /
// reopen / leaving a channel out, (k) On Hold and Closed, (m)-(o) a week cut short, the stop paths one by one, pause and resume, (p) the Dashboard
// workspace and summary, (q) re-activation, (r) what closing a channel (or dropping it while resolving) clears, (s)/(g) exceptions and the plan
// history through a hold, (t) channel settings completing the first task, (u) the data migration, (v) the wording, (w) a failing sync, (x) a stop path
// racing the sync.
// A test wrapped in `test.fail(...)` documents a BACKEND BUG: it asserts the CORRECT behaviour and is expected to fail until the bug is
// fixed (Playwright then reports "expected to fail but passed" and the wrapper is deleted). None is open at the moment.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed, CRON_SECRET, BASE, CANDIDATE_INGEST_SECRET, uid } from '../helpers/api';
import { purgeRolesFast, trackerMigrationSql } from '../helpers/sourcing-db';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';
const POST_URL = 'https://example.com/jobs/spec14';
const CLOSE_SENTINEL = 'SENTINEL-close-reason-must-not-reach-a-hiring-manager';
const LINK_SENTINEL = 'https://example.com/SENTINEL-post-link';
const TRACKED = ['LinkedIn', 'Naukri/IIMjobs', 'Direct Outreach'] as const;

type Json = Record<string, any>;

test.describe('Sourcing workspace', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let client: Client;
  let enabled = false;
  const roleIds: string[] = [];
  let hr: string, hr2: string, alex: string, satyadev: string, lead: string;
  let savedSettings: Array<{ key: string; value: unknown }> = [];
  const TOUCHED_SETTINGS = ['go_live_date', 'shadow_until', 'qualified_rule', 'volume_min_qualified'];

  // ── helpers (same shapes as spec 13) ───────────────────────────────────────────────────────────
  const ymd = (offsetDays: number) => new Date(Date.now() + 5.5 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
  const noon = (day: string) => `${day}T12:00:00+05:30`;
  const dayStart = (day: string) => `${day}T00:00:00+05:30`;
  const dayEnd = (day: string) => `${day}T23:59:59+05:30`;
  const dayPlus = (day: string, n: number) => new Date(new Date(`${day}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

  const newRole = async (o: { title?: string; priority?: string; hm?: string; modes?: string[]; status?: string } = {}) => {
    const { rows } = await client.query(
      `INSERT INTO roles (title, department, hiring_manager_name, priority, status, location, employment_type, start_date, approval_date, recruitment_mode)
       VALUES ($1,'Tech/Devs',$2,$3,$4,'Gurgaon','Full-Time / Permanent', CURRENT_DATE - 3, CURRENT_DATE - 3, $5::text[]) RETURNING id`,
      [`${o.title ?? 'Workspace Test Role'} ${uid()}`, o.hm ?? 'Alex', o.priority ?? 'P1', o.status ?? 'Live – Sourcing', o.modes ?? ['LinkedIn', 'Agency']]);
    roleIds.push(rows[0].id);
    return rows[0].id as string;
  };
  const call = async (request: any, method: 'get' | 'post' | 'put' | 'patch', tok: string, path: string, data?: object) => {
    const headers = { Authorization: `Bearer ${tok}` };
    const r = await request[method](`${BASE}${path}`, method === 'get' ? { headers } : { headers, data: data ?? {} });
    return { status: r.status() as number, body: (await r.json().catch(() => ({}))) as Json };
  };
  const get = (request: any, tok: string, path: string) => call(request, 'get', tok, path);
  const post = (request: any, tok: string, path: string, data: object = {}) => call(request, 'post', tok, path, data);
  const put = (request: any, tok: string, path: string, data: object) => call(request, 'put', tok, path, data);
  const patch = (request: any, tok: string, path: string, data: object) => call(request, 'patch', tok, path, data);
  const cron = async (request: any) => {
    const r = await authed(request, CRON_SECRET).post('/api/cron/sourcing-check', {});
    expect(r.status()).toBe(200);
    return (await r.json()) as Json;
  };
  const plan = async (request: any, rid: string, tok = hr) => (await get(request, tok, `/api/sourcing/plans/${rid}`)).body;
  const channel = (view: Json, name: string) => (view.channels as Json[]).find(c => c.channel === name)!;
  const commitment = (view: Json, ch: string, kind: string) => (channel(view, ch).commitments as Json[]).find(m => m.kind === kind)!;
  const historyOf = (view: Json, type: string) => (view.changes as Json[]).filter(c => c.change?.type === type);

  const sql = async (text: string, params: unknown[] = []) => (await client.query(text, params)).rows as Json[];
  const setSetting = (key: string, value: unknown) =>
    client.query(`INSERT INTO sourcing_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);
  /** Shadow period on (volume signals provisional) or off (they are live). */
  const shadow = (on: boolean) => setSetting('shadow_until', on ? ymd(30) : ymd(-1));
  const setAnchor = (pid: string, ch: string, day: string | null) =>
    client.query(`UPDATE sourcing_plan_channels SET tracker_anchor=$3::date WHERE plan_id=$1::bigint AND channel=$2`, [pid, ch, day]);
  const chRow = async (pid: string, ch: string) =>
    (await sql(`SELECT id::text AS id, state, excluded_reason, closed_at, closed_reason, to_char(tracker_anchor,'YYYY-MM-DD') AS anchor, targets, config FROM sourcing_plan_channels WHERE plan_id=$1::bigint AND channel=$2`, [pid, ch]))[0];
  const weekRows = (pid: string, ch: string) =>
    sql(`SELECT to_char(w.week_start,'YYYY-MM-DD') AS ws, to_char(w.week_end,'YYYY-MM-DD') AS we, w.target, w.actual, w.qualified, w.partial
           FROM sourcing_channel_weeks w JOIN sourcing_plan_channels c ON c.id = w.plan_channel_id WHERE c.plan_id=$1::bigint AND c.channel=$2 ORDER BY w.week_start`, [pid, ch]);
  const changeCount = async (pid: string, type: string) =>
    Number((await sql(`SELECT count(*) AS n FROM sourcing_plan_changes WHERE plan_id=$1::bigint AND change->>'type'=$2`, [pid, type]))[0].n);
  const liveExceptions = (pid: string) =>
    sql(`SELECT id::text AS id, channel, type, status, is_shadow, evidence FROM sourcing_exceptions WHERE plan_id=$1::bigint AND status IN ('open','snoozed','blocked') ORDER BY id`, [pid]);
  /** The live exceptions that are about a channel's tasks (a P0/P1 plan with no applications also carries a plan-level VOLUME_GAP). */
  const liveTaskExceptions = async (pid: string) => (await liveExceptions(pid)).filter(e => e.type !== 'VOLUME_GAP');

  /** `n` applications to a role, tagged with a channel (null = no tag), made on a given instant. */
  const addApps = async (rid: string, tag: string | null, at: string, n: number, o: { score?: number | null; stage?: string; status?: string } = {}) => {
    for (let i = 0; i < n; i++) {
      const c = await client.query(`INSERT INTO candidates (full_name, email) VALUES ('Spec14 Candidate', $1) RETURNING id`, [`sp14+${uid()}${i}@example.com`]);
      await client.query(
        `INSERT INTO applications (candidate_id, role_id, stage, status, ai_fit_score, application_date, sub_source) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7)`,
        [c.rows[0].id, rid, o.stage ?? 'Applied and Screened', o.status ?? 'Active', o.score ?? null, at, tag]);
    }
  };

  /** A role whose plan is ACTIVE. Each tracked channel with `already_running` is live with a link and a weekly target. */
  const activeRole = async (request: any, title: string, channels: Json[], o: { priority?: string; hm?: string; extraModes?: string[]; anchors?: Record<string, string> } = {}) => {
    const rid = await newRole({ title, priority: o.priority, hm: o.hm, modes: [...channels.map(c => c.channel), ...(o.extraModes ?? [])] });
    const v = await plan(request, rid);
    const r = await post(request, hr, `/api/sourcing/plans/${v.plan.id}/activate`, { channels });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const [ch, day] of Object.entries(o.anchors ?? {})) await setAnchor(v.plan.id, ch, day);
    return { rid, pid: v.plan.id as string };
  };
  const live = (ch: string, target = 5, extra: Json = {}) => ({ channel: ch, already_running: true, url: `${POST_URL}/${encodeURIComponent(ch)}`, weekly_target: target, ...extra });
  const closeCh = (request: any, pid: string, ch: string, reason = 'Enough applicants for now', tok = hr) =>
    post(request, tok, `/api/sourcing/plans/${pid}/channel/close`, { channel: ch, reason });
  const reopenCh = (request: any, pid: string, ch: string, tok = hr) => post(request, tok, `/api/sourcing/plans/${pid}/channel/reopen`, { channel: ch });
  const settingsCh = (request: any, pid: string, body: Json, tok = hr) => patch(request, tok, `/api/sourcing/plans/${pid}/channel-settings`, body);

  // ── the role's status, the plan's row and ids straight from the database ────────────────────────
  // (a plan READ finishes every week that has ended, so a test that needs "ended but not yet written" weeks must not read the plan view
  // — nor run the engine — before the action under test; these helpers look in Postgres instead)
  const setRoleStatus = async (request: any, rid: string, status: string, extra: object = {}) => {
    const r = await authed(request, hr).patch(`/api/roles/${rid}`, { status, ...extra });
    expect(r.status(), `PATCH ${rid} → ${status}`).toBe(200);
  };
  const holdRole = (request: any, rid: string) => setRoleStatus(request, rid, 'On Hold');
  const resumeRole = (request: any, rid: string) => setRoleStatus(request, rid, 'Live – Sourcing');
  const planRow = async (pid: string) =>
    (await sql(`SELECT status, paused_at, pause_total_days FROM sourcing_plans WHERE id=$1::bigint`, [pid]))[0];
  const commitmentId = async (pid: string, ch: string, kind: string) =>
    (await sql(`SELECT c.id::text AS id FROM sourcing_commitments c JOIN sourcing_plan_channels x ON x.id=c.plan_channel_id
                 WHERE x.plan_id=$1::bigint AND x.channel=$2 AND c.kind=$3`, [pid, ch, kind]))[0]?.id as string;
  const commitmentRow = async (id: string) => (await sql(`SELECT status, title, due_at, last_done_at, meta FROM sourcing_commitments WHERE id=$1::bigint`, [id]))[0];
  /**
   * Make a hold that just happened look `days` days old, consistently: the plan was paused that long ago, and so was every week recorded so far
   * (the cut-short week is stamped with the day of the hold). Without shifting those weeks too, "the role came back on the day it was stopped"
   * would still be true and the tracker would not start until tomorrow. Choose a shift that no recorded week start collides with (the key
   * is unique per channel).
   */
  const backdateHold = async (pid: string, days: number) => {
    await client.query(`UPDATE sourcing_plans SET paused_at = paused_at - ($2::int * INTERVAL '1 day') WHERE id=$1::bigint`, [pid, days]);
    await client.query(
      `UPDATE sourcing_channel_weeks SET week_start = week_start - $2::int, week_end = week_end - $2::int
        WHERE plan_channel_id IN (SELECT id FROM sourcing_plan_channels WHERE plan_id=$1::bigint)`, [pid, days]);
  };
  const aaronIdOf = async () => (await sql(`SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com'`))[0].id as string;
  /** A live exception row made directly (when the engine must NOT run — it would also record the weeks that are meant to still be unwritten). */
  const makeException = async (pid: string, ch: string, type = 'FOLLOWUP_OVERDUE') =>
    (await sql(`INSERT INTO sourcing_exceptions (plan_id, channel, type, severity, evidence) VALUES ($1::bigint,$2,$3,30,'{}'::jsonb) RETURNING id::text AS id`, [pid, ch, type]))[0].id as string;
  const weeklyEntries = async (v: Json) => historyOf(v, 'weekly_result');
  const PARTIAL_TEXT = 'week cut short, not counted as met or missed';

  test.beforeAll(async ({ request }) => {
    client = new Client({ connectionString: LOCAL_DB_URL });
    await client.connect();
    const status = await request.get(`${BASE}/api/sourcing/status`, { headers: { Authorization: `Bearer ${await getToken(request, 'hr')}` } });
    enabled = status.ok() && (await status.json()).enabled === true;
    if (!enabled) return;
    hr = await getToken(request, 'hr'); hr2 = await getToken(request, 'hr2'); alex = await getToken(request, 'hm_alex');
    satyadev = await getToken(request, 'hm_satyadev'); lead = await getToken(request, 'leadership');
    savedSettings = (await client.query(`SELECT key, value FROM sourcing_settings WHERE key = ANY($1)`, [TOUCHED_SETTINGS])).rows;
    // The local database is in real use: pin the go-live date to the future (no PLAN_NOT_ACTIVATED noise on throwaway draft roles) and keep the
    // threshold signals provisional unless a test switches the shadow period off. afterAll puts the saved values back.
    await setSetting('go_live_date', ymd(60));
    await shadow(true);
  });

  test.beforeEach(() => { test.skip(!enabled, 'SOURCING_ENABLED is not true on the backend — module is inert by design'); });

  test.afterAll(async () => {
    if (!client) return;
    if (enabled) {
      await client.query(`DELETE FROM sourcing_settings WHERE key = ANY($1)`, [TOUCHED_SETTINGS]);
      for (const s of savedSettings) {
        await client.query(`INSERT INTO sourcing_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [s.key, JSON.stringify(s.value)]);
      }
      // one transaction, no per-row foreign-key scans of the multi-million-row pending_actions table (see helpers/sourcing-db.ts)
      await purgeRolesFast(client, roleIds, ['sp14+%@example.com', 'sp14ing+%@example.com']);
    }
    await client.end();
  });

  // ── (a) the first task of a tracked channel ────────────────────────────────────────────────────
  test('(a) the first task of LinkedIn / Naukri / Direct Outreach needs a post link AND a whole weekly target — a 400 writes nothing; Agency / Referral are unaffected', async ({ request }) => {
    const rid = await newRole({ title: 'First task', modes: ['LinkedIn', 'Naukri/IIMjobs', 'Direct Outreach', 'Agency', 'Internal Referral'] });
    const pid = (await plan(request, rid)).plan.id as string;
    expect((await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [{ channel: 'LinkedIn' }, { channel: 'Naukri/IIMjobs' }, { channel: 'Direct Outreach' }, { channel: 'Agency' }, { channel: 'Internal Referral' }] })).status).toBe(200);
    let v = await plan(request, rid);

    const titles: Record<string, RegExp> = {
      'LinkedIn': /Log the LinkedIn post \(link and weekly sourcing target\)/,
      'Naukri/IIMjobs': /Log the Naukri\/IIMjobs post \(link and weekly sourcing target\)/,
      'Direct Outreach': /Log the Direct Outreach campaign \(link and weekly sourcing target\)/,
    };
    const url = 'https://example.com/p/1';
    const bad: Array<[string, Json, RegExp]> = [
      ['nothing', {}, /link/i],
      ['a link only', { url }, /weekly sourcing target/i],
      ['a target only', { weekly_target: 10 }, /link/i],
      ['a blank link', { url: '   ', weekly_target: 10 }, /link/i],
      ['target 0', { url, weekly_target: 0 }, /weekly sourcing target/i],
      ['a negative target', { url, weekly_target: -5 }, /weekly sourcing target/i],
      ['a target that rounds to 0 (0.4)', { url, weekly_target: 0.4 }, /weekly sourcing target/i],
      ['a target over the cap (10001)', { url, weekly_target: 10001 }, /weekly sourcing target/i],
      ['the target as a string', { url, weekly_target: '10' }, /weekly sourcing target/i],
      ['a null target', { url, weekly_target: null }, /weekly sourcing target/i],
      ['a non-http link (ftp)', { url: 'ftp://example.com/a', weekly_target: 10 }, /http/i],
      ['a javascript: link', { url: 'javascript:alert(1)', weekly_target: 10 }, /http/i],
      ['text that is not a link', { url: 'not a link', weekly_target: 10 }, /http/i],
    ];
    const good: Record<string, Json> = {
      'LinkedIn': { url: 'https://www.linkedin.com/jobs/view/123', weekly_target: 25, posted_at: ymd(-2) },
      'Naukri/IIMjobs': { url: 'https://www.naukri.com/job-listings-9', weekly_target: 10000 },     // the cap itself is allowed
      'Direct Outreach': { url: 'https://example.com/sheet/outreach', weekly_target: 1 },            // so is 1
    };
    for (const ch of TRACKED) {
      const m = commitment(v, ch, 'activate_channel');
      expect(m.title, ch).toMatch(titles[ch]);
      for (const [what, body, msg] of bad) {
        const r = await post(request, hr, `/api/sourcing/commitments/${m.id}/complete`, body);
        expect(r.status, `${ch}: ${what}`).toBe(400);
        expect(String(r.body.error), `${ch}: ${what}`).toMatch(msg);
      }
      // nothing half-written by any of the refusals (the log row is inserted before the URL check, inside the transaction that rolls back)
      expect((await sql(`SELECT count(*)::int AS n FROM sourcing_commitment_log WHERE commitment_id=$1::bigint`, [m.id]))[0].n, ch).toBe(0);
      const row = await chRow(pid, ch);
      expect(row, ch).toMatchObject({ state: 'planned', anchor: null });
      expect(row.config.posting_url, ch).toBeUndefined();
      expect(row.targets.weekly_target, ch).toBeUndefined();
      expect((await sql(`SELECT status FROM sourcing_commitments WHERE id=$1::bigint`, [m.id]))[0].status, ch).toBe('open');
      expect((await sql(`SELECT count(*)::int AS n FROM sourcing_evidence e JOIN sourcing_commitment_log l ON l.id=e.log_id WHERE l.commitment_id=$1::bigint`, [m.id]))[0].n, ch).toBe(0);

      const ok = await post(request, hr, `/api/sourcing/commitments/${m.id}/complete`, good[ch]);
      expect(ok.status, `${ch}: ${JSON.stringify(ok.body)}`).toBe(200);
      expect((await post(request, hr, `/api/sourcing/commitments/${m.id}/complete`, good[ch])).status, `${ch} twice`).toBe(409);
    }
    expect(await changeCount(pid, 'commitment_completed')).toBe(3);

    v = await plan(request, rid);
    for (const ch of TRACKED) {
      const c = channel(v, ch);
      const want = good[ch];
      expect(c.state, ch).toBe('active');
      expect(c.targets.weekly_target, ch).toBe(want.weekly_target);
      expect(c.config.posting_url, ch).toBe(want.url);
      expect(c.tracker, ch).toMatchObject({ applicable: true, target: want.weekly_target, link: want.url, anchor: ymd(0) });
      expect(c.tracker.running, ch).toMatchObject({ start: ymd(0), end: ymd(6), actual: 0, target: want.weekly_target });
      expect(c.tracker.weeks, ch).toEqual([]);
      expect(commitment(v, ch, 'activate_channel').status, ch).toBe('done');
    }
    // follow-ons: the portals keep their renewal, Direct Outreach has NO follow-on task at all (its weekly numbers are measured automatically)
    expect(commitment(v, 'LinkedIn', 'renew_posting')).toMatchObject({ status: 'open', cadence_days: 30 });
    expect(commitment(v, 'Naukri/IIMjobs', 'renew_posting')).toMatchObject({ status: 'open', cadence_days: 30 });
    expect(commitment(v, 'LinkedIn', 'renew_posting').due_date).toBe(dayPlus(ymd(-2), 27));          // the renewal clock starts at the posting's own date
    expect((channel(v, 'Direct Outreach').commitments as Json[]).map(m => m.kind)).toEqual(['activate_channel']);
    expect((await sql(`SELECT 1 FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id=c.plan_channel_id WHERE ch.plan_id=$1::bigint AND c.kind='weekly_outbound'`, [pid])).length).toBe(0);
    // the history carries what was logged
    const done = historyOf(v, 'commitment_completed').find(h => h.change.channel === 'LinkedIn')!;
    expect(done).toMatchObject({ by_name: 'Aaron Newton', category: 'task' });
    expect(done.change).toMatchObject({ url: good['LinkedIn'].url, weekly_target: 25 });
    expect(done.text).toContain('weekly target 25');

    // Agency and Internal Referral: no link, no target, no tracker — exactly as before
    for (const [ch, kind] of [['Agency', 'followup_agency'], ['Internal Referral', 'repost_referral']] as const) {
      const m = commitment(v, ch, 'activate_channel');
      expect(m.title, ch).not.toMatch(/weekly sourcing target/i);
      const r = await post(request, hr, `/api/sourcing/commitments/${m.id}/complete`, ch === 'Agency' ? { weekly_target: 50, note: 'Briefed three agencies' } : {});
      expect(r.status, ch).toBe(200);
    }
    v = await plan(request, rid);
    for (const [ch, kind] of [['Agency', 'followup_agency'], ['Internal Referral', 'repost_referral']] as const) {
      const c = channel(v, ch);
      expect(c.state, ch).toBe('active');
      expect(c.tracker, ch).toMatchObject({ applicable: false, target: null, anchor: null, running: null, weeks: [] });
      expect(c.targets.weekly_target, `${ch} never stores a weekly target`).toBeUndefined();
      expect(commitment(v, ch, kind).status, ch).toBe('open');
      expect((await chRow(pid, ch)).anchor, ch).toBeNull();
    }
  });

  test('(a) a fractional weekly target is rounded to the nearest whole applicant (2.5 -> 3, 7.4 -> 7), never stored with a fraction', async ({ request }) => {
    const rid = await newRole({ title: 'Rounded target', modes: ['LinkedIn', 'Naukri/IIMjobs'] });
    const pid = (await plan(request, rid)).plan.id as string;
    await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [{ channel: 'LinkedIn' }, { channel: 'Naukri/IIMjobs' }] });
    const v = await plan(request, rid);
    expect((await post(request, hr, `/api/sourcing/commitments/${commitment(v, 'LinkedIn', 'activate_channel').id}/complete`, { url: POST_URL, weekly_target: 2.5 })).status).toBe(200);
    expect((await post(request, hr, `/api/sourcing/commitments/${commitment(v, 'Naukri/IIMjobs', 'activate_channel').id}/complete`, { url: POST_URL, weekly_target: 7.4 })).status).toBe(200);
    expect((await chRow(pid, 'LinkedIn')).targets.weekly_target).toBe(3);
    expect((await chRow(pid, 'Naukri/IIMjobs')).targets.weekly_target).toBe(7);
  });

  test('(a) a skipped task can come back and be completed — it still needs the link and target; the tracker only starts when it does', async ({ request }) => {
    const rid = await newRole({ title: 'Skip then log', modes: ['LinkedIn'] });
    const pid = (await plan(request, rid)).plan.id as string;
    await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [{ channel: 'LinkedIn' }] });
    const id = commitment(await plan(request, rid), 'LinkedIn', 'activate_channel').id;
    expect((await post(request, hr, `/api/sourcing/commitments/${id}/skip`, { reason: 'Posting later this week' })).status).toBe(200);
    expect((await post(request, hr, `/api/sourcing/commitments/${id}/complete`, { url: POST_URL, weekly_target: 10 })).status).toBe(409);   // skipped: undo the skip first
    expect((await post(request, hr, `/api/sourcing/commitments/${id}/reopen`)).status).toBe(200);
    expect((await post(request, hr, `/api/sourcing/commitments/${id}/complete`, {})).status).toBe(400);
    expect((await chRow(pid, 'LinkedIn')).anchor).toBeNull();
    expect((await post(request, hr, `/api/sourcing/commitments/${id}/complete`, { url: POST_URL, weekly_target: 10 })).status).toBe(200);
    expect((await chRow(pid, 'LinkedIn')).anchor).toBe(ymd(0));
  });

  // ── (b) activation with "already running" ──────────────────────────────────────────────────────
  test('(b) activation with already_running needs link + target for a tracked channel — and rolls back EVERYTHING (the plan stays a draft)', async ({ request }) => {
    const rid = await newRole({ title: 'Attest needs target', modes: ['Agency', 'LinkedIn', 'Direct Outreach', 'Naukri/IIMjobs'] });
    const pid = (await plan(request, rid)).plan.id as string;
    const act = (channels: Json[], extra: Json = {}) => post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels, ...extra });
    const modeBefore = (await sql(`SELECT recruitment_mode FROM roles WHERE id=$1`, [rid]))[0].recruitment_mode;
    const url = 'https://example.com/running';
    // Agency comes FIRST and is valid, so a half-committed activation would leave its commitment and role mirror behind
    const agency = { channel: 'Agency', already_running: true };
    const attempts: Array<[string, Json[], RegExp]> = [
      ['LinkedIn with neither', [agency, { channel: 'LinkedIn', already_running: true }], /link/i],
      ['LinkedIn with a link only', [agency, { channel: 'LinkedIn', already_running: true, url }], /weekly sourcing target/i],
      ['LinkedIn with a target only', [agency, { channel: 'LinkedIn', already_running: true, weekly_target: 5 }], /link/i],
      ['Direct Outreach with target 0', [agency, { channel: 'Direct Outreach', already_running: true, url, weekly_target: 0 }], /weekly sourcing target/i],
      ['Naukri with a javascript: link', [agency, { channel: 'Naukri/IIMjobs', already_running: true, url: 'javascript:alert(1)', weekly_target: 5 }], /http/i],
      ['a valid LinkedIn, then an invalid Direct Outreach', [{ channel: 'LinkedIn', already_running: true, url, weekly_target: 5 }, { channel: 'Direct Outreach', already_running: true, url }], /weekly sourcing target/i],
    ];
    for (const [what, channels, msg] of attempts) {
      const r = await act(channels);
      expect(r.status, what).toBe(400);
      expect(String(r.body.error), what).toMatch(msg);
      const p = await plan(request, rid);
      expect(p.plan.status, what).toBe('draft');
      expect((p.channels as Json[]).flatMap(c => c.commitments), what).toEqual([]);
      expect((p.channels as Json[]).every(c => c.state === 'planned'), what).toBe(true);
      expect((await chRow(pid, 'LinkedIn')).anchor, what).toBeNull();
      expect(await changeCount(pid, 'activated'), what).toBe(0);
      expect((await sql(`SELECT count(*)::int AS n FROM sourcing_commitment_log l JOIN sourcing_commitments c ON c.id=l.commitment_id JOIN sourcing_plan_channels ch ON ch.id=c.plan_channel_id WHERE ch.plan_id=$1::bigint`, [pid]))[0].n, what).toBe(0);
    }
    expect((await sql(`SELECT recruitment_mode FROM roles WHERE id=$1`, [rid]))[0].recruitment_mode).toEqual(modeBefore);

    // a bad plan-level target also leaves a draft (and never reaches a channel)
    for (const t of [0, 501, -3, 0.4]) expect((await act([{ channel: 'Agency' }], { weekly_qualified_target: t })).status, `target ${t}`).toBe(400);
    expect((await plan(request, rid)).plan.status).toBe('draft');

    // Agency / Internal Referral can be attested with nothing; a tracked channel that is NOT already running needs nothing yet
    const ok = await act([agency, { channel: 'LinkedIn', already_running: true, url, weekly_target: 5, posted_at: ymd(-3) }, { channel: 'Direct Outreach' }, { channel: 'Naukri/IIMjobs', exclude_reason: 'Not for this role' }]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const v = await plan(request, rid);
    expect(v.plan.status).toBe('active');
    expect(channel(v, 'Agency').state).toBe('active');
    expect(channel(v, 'LinkedIn')).toMatchObject({ state: 'active' });
    expect(channel(v, 'LinkedIn').tracker).toMatchObject({ target: 5, link: url, anchor: ymd(0) });
    expect(commitment(v, 'LinkedIn', 'renew_posting').due_date).toBe(dayPlus(ymd(-3), 27));
    expect(channel(v, 'Direct Outreach')).toMatchObject({ state: 'planned' });
    expect(channel(v, 'Direct Outreach').tracker).toMatchObject({ applicable: true, target: null, anchor: null, running: null });
    expect(commitment(v, 'Direct Outreach', 'activate_channel').status).toBe('open');
    expect(channel(v, 'Naukri/IIMjobs').state).toBe('excluded');
    expect(await changeCount(pid, 'activated')).toBe(1);
    expect(historyOf(v, 'commitment_completed').find(h => h.change.channel === 'LinkedIn')!.change).toMatchObject({ attested: true, weekly_target: 5, url });
    expect(historyOf(v, 'activated')[0].change.channels.map((c: Json) => c.channel).sort()).toEqual(['Agency', 'Direct Outreach', 'LinkedIn', 'Naukri/IIMjobs']);
  });

  // ── (c) the weekly tracker ─────────────────────────────────────────────────────────────────────
  // Windows are consecutive 7-day IST periods from tracker_anchor, both ends inclusive; a window is finished once its last day has ended.
  // `actual` counts EVERY application to the role tagged with the channel in the window (qualified or not).
  test('(c) a finished week is met at exactly the target and missed one below; the IST day edges, other channels, untagged and other roles are not mixed in', async ({ request }) => {
    const other = await newRole({ title: 'Some other role', modes: ['LinkedIn'] });
    await addApps(other, 'LinkedIn', noon(ymd(-5)), 4);                         // same channel, DIFFERENT role: never counted
    for (const [label, mid, expectMet] of [['target - 1', 2, false], ['exactly the target', 3, true], ['target + 1', 4, true]] as const) {
      const { rid, pid } = await activeRole(request, `Boundary ${label}`, [live('LinkedIn', 5)], { anchors: { LinkedIn: ymd(-8) } });
      // the window is [today-8, today-2]: first second of the first day and last second of the last day both count
      await addApps(rid, 'LinkedIn', dayStart(ymd(-8)), 1, { score: 70 });                            // qualified (ResumeIQ > 60)
      await addApps(rid, 'LinkedIn', dayEnd(ymd(-2)), 1, { stage: 'Interview Round 1' });            // qualified (shortlisted)
      await addApps(rid, 'LinkedIn', noon(ymd(-5)), 1, { score: 60 });                               // exactly 60 is NOT qualified
      await addApps(rid, 'LinkedIn', noon(ymd(-4)), mid - 1, { status: 'Rejected' });                // a rejected applicant was still sourced
      // noise that must not count
      await addApps(rid, 'LinkedIn', dayEnd(ymd(-9)), 2);                                            // last second BEFORE the window
      await addApps(rid, 'LinkedIn', dayStart(ymd(-1)), 2);                                          // first second AFTER it: the running week
      await addApps(rid, 'Naukri/IIMjobs', noon(ymd(-5)), 3);                                        // another channel
      await addApps(rid, 'Direct Outreach', noon(ymd(-5)), 1);
      await addApps(rid, 'untagged_default', noon(ymd(-5)), 1);
      await addApps(rid, null, noon(ymd(-5)), 1);                                                    // no tag at all
      const expected = 2 + 1 + (mid - 1);

      const v = await plan(request, rid);
      const t = channel(v, 'LinkedIn').tracker;
      expect(t.weeks, label).toHaveLength(1);
      expect(t.weeks[0], label).toEqual({ week_start: ymd(-8), week_end: ymd(-2), target: 5, actual: expected, qualified: 2, met: expectMet, partial: false });
      expect(expected, label).toBe(label === 'target - 1' ? 4 : label === 'exactly the target' ? 5 : 6);
      expect(t.totals, label).toEqual({ weeks: 1, met: expectMet ? 1 : 0, actual: expected, target: 5 });
      expect(t.running, label).toEqual({ start: ymd(-1), end: ymd(5), actual: 2, qualified: 0, target: 5 });
      expect(t.sourced.applications, label).toBe(expected + 2 + 2);                                  // everything tagged LinkedIn on this role, all time
      expect(await weekRows(pid, 'LinkedIn'), label).toEqual([{ ws: ymd(-8), we: ymd(-2), target: 5, actual: expected, qualified: 2, partial: false }]);

      // the weekly result is also one system entry in the plan's history, stamped on the day the week ended
      const h = historyOf(v, 'weekly_result');
      expect(h, label).toHaveLength(1);
      expect(h[0].by_name, label).toBeNull();
      expect(h[0].category, label).toBe('weekly');
      expect(h[0].change, label).toMatchObject({ channel: 'LinkedIn', week_start: ymd(-8), week_end: ymd(-2), target: 5, actual: expected, qualified: 2, met: expectMet, partial: false });
      expect(h[0].text, label).toContain(`${expected} of 5`);
      expect(h[0].text, label).toContain(expectMet ? 'target met' : 'target missed');
      expect(new Date(h[0].at).getTime(), label).toBe(new Date(`${ymd(-2)}T23:59:59.999+05:30`).getTime());
      // "Applications by Source" reads the same tags
      const tags = Object.fromEntries((v.output as Json[]).map(o => [o.tag, o.applications]));
      expect(tags['LinkedIn'], label).toBe(expected + 2 + 2);
      expect(tags['Naukri/IIMjobs'], label).toBe(3);
    }
  });

  test('(c) two finished weeks: newest first, per-week targets and totals; a second channel on the same role is tracked on its own anchor', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Two weeks', [live('LinkedIn', 5), live('Direct Outreach', 3)], { anchors: { LinkedIn: ymd(-15), 'Direct Outreach': ymd(-8) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-12)), 6);                                   // week 1 [-15,-9]: 6 of 5, met
    await addApps(rid, 'LinkedIn', noon(ymd(-5)), 2);                                    // week 2 [-8,-2]: 2 of 5, missed
    await addApps(rid, 'LinkedIn', noon(ymd(-1)), 1);                                    // running week [-1,5]
    await addApps(rid, 'Direct Outreach', noon(ymd(-4)), 3);                             // [-8,-2]: exactly 3 of 3
    await addApps(rid, 'Direct Outreach', noon(ymd(-12)), 4);                            // before Direct Outreach's own anchor: not counted
    const v = await plan(request, rid);
    const li = channel(v, 'LinkedIn').tracker, dop = channel(v, 'Direct Outreach').tracker;
    expect(li.weeks.map((w: Json) => [w.week_start, w.week_end, w.actual, w.met])).toEqual([[ymd(-8), ymd(-2), 2, false], [ymd(-15), ymd(-9), 6, true]]);   // newest first
    expect(li.totals).toEqual({ weeks: 2, met: 1, actual: 8, target: 10 });
    expect(li.running).toMatchObject({ start: ymd(-1), end: ymd(5), actual: 1, target: 5 });
    expect(dop.weeks.map((w: Json) => [w.week_start, w.actual, w.target, w.met])).toEqual([[ymd(-8), 3, 3, true]]);
    expect(dop.running).toMatchObject({ start: ymd(-1), actual: 0, target: 3 });
    expect(dop.sourced.applications).toBe(7);
    // history: one entry per week per channel, ordered by the day each week ended (newest first)
    const wr = historyOf(v, 'weekly_result');
    expect(wr).toHaveLength(3);
    expect(wr.filter(h => h.change.channel === 'LinkedIn').map(h => h.change.week_start)).toEqual([ymd(-8), ymd(-15)]);
    expect(wr.every(h => h.by_name === null && h.category === 'weekly')).toBe(true);
    expect(await weekRows(pid, 'Direct Outreach')).toHaveLength(1);
  });

  test('(c) a week is finished only once its LAST day has ended: anchor 7 days ago is finished, 6 days ago is still running; anchor today starts a window today', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Edge of finishing', [live('LinkedIn', 2), live('Naukri/IIMjobs', 2), live('Direct Outreach', 2)],
      { anchors: { LinkedIn: ymd(-7), 'Naukri/IIMjobs': ymd(-6), 'Direct Outreach': ymd(0) } });
    await addApps(rid, 'Naukri/IIMjobs', noon(ymd(0)), 1);
    const v = await plan(request, rid);
    expect(channel(v, 'LinkedIn').tracker.weeks.map((w: Json) => [w.week_start, w.week_end])).toEqual([[ymd(-7), ymd(-1)]]);      // ended yesterday
    expect(channel(v, 'LinkedIn').tracker.running).toMatchObject({ start: ymd(0), end: ymd(6) });
    expect(channel(v, 'Naukri/IIMjobs').tracker.weeks).toEqual([]);                                                              // its last day is TODAY: not over
    expect(channel(v, 'Naukri/IIMjobs').tracker.running).toMatchObject({ start: ymd(-6), end: ymd(0), actual: 1, target: 2 });
    expect(channel(v, 'Direct Outreach').tracker.weeks).toEqual([]);
    expect(channel(v, 'Direct Outreach').tracker.running).toMatchObject({ start: ymd(0), end: ymd(6) });
    expect(await weekRows(pid, 'Naukri/IIMjobs')).toEqual([]);
    expect(await weekRows(pid, 'LinkedIn')).toHaveLength(1);
  });

  test('(c) the running week is live: it moves as applications arrive, and is never written to the weekly table until it ends', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Live week', [live('LinkedIn', 3)], { anchors: { LinkedIn: ymd(-3) } });
    expect(channel(await plan(request, rid), 'LinkedIn').tracker.running).toEqual({ start: ymd(-3), end: ymd(3), actual: 0, qualified: 0, target: 3 });
    await addApps(rid, 'LinkedIn', noon(ymd(-1)), 1, { score: 90 });
    expect(channel(await plan(request, rid), 'LinkedIn').tracker.running).toEqual({ start: ymd(-3), end: ymd(3), actual: 1, qualified: 1, target: 3 });
    await addApps(rid, 'LinkedIn', noon(ymd(-3)), 2);                                  // the first day of the window counts too
    await addApps(rid, 'LinkedIn', noon(ymd(-4)), 1);                                  // the day before the anchor does not
    expect(channel(await plan(request, rid), 'LinkedIn').tracker.running).toEqual({ start: ymd(-3), end: ymd(3), actual: 3, qualified: 1, target: 3 });
    expect(await weekRows(pid, 'LinkedIn')).toEqual([]);
    expect(await changeCount(pid, 'weekly_result')).toBe(0);
  });

  test('(c) syncing again never duplicates a week or its history entry — not on repeated reads, not under concurrent reads and engine runs', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Idempotent sync', [live('LinkedIn', 4)], { anchors: { LinkedIn: ymd(-15) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-10)), 4);
    await addApps(rid, 'LinkedIn', noon(ymd(-4)), 1);
    for (let i = 0; i < 3; i++) await plan(request, rid);
    await Promise.all([...Array.from({ length: 6 }, () => plan(request, rid)), ...Array.from({ length: 6 }, () => cron(request))]);
    expect(await weekRows(pid, 'LinkedIn')).toHaveLength(2);
    expect(await changeCount(pid, 'weekly_result')).toBe(2);
    // a late application inside a FINISHED week never rewrites it: weeks are immutable once recorded
    await addApps(rid, 'LinkedIn', noon(ymd(-10)), 5);
    await plan(request, rid); await cron(request);
    const rows = await weekRows(pid, 'LinkedIn');
    expect(rows.map(r => [r.ws, r.actual])).toEqual([[ymd(-15), 4], [ymd(-8), 1]]);
    expect(await changeCount(pid, 'weekly_result')).toBe(2);
    // the unique key itself refuses a duplicate row
    await expect(client.query(
      `INSERT INTO sourcing_channel_weeks (plan_channel_id, week_start, week_end, target, actual) SELECT id, ${'$2'}::date, ${'$3'}::date, 1, 1 FROM sourcing_plan_channels WHERE plan_id=$1::bigint AND channel='LinkedIn'`,
      [pid, ymd(-15), ymd(-9)])).rejects.toThrow(/duplicate key|unique/i);
  });

  test('(c) the daily engine / cron finishes ended weeks on its own — nobody has to open the plan', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Cron finishes weeks', [live('LinkedIn', 2)], { anchors: { LinkedIn: ymd(-8) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-3)), 2);
    expect(await weekRows(pid, 'LinkedIn')).toEqual([]);
    await cron(request);
    expect(await weekRows(pid, 'LinkedIn')).toEqual([{ ws: ymd(-8), we: ymd(-2), target: 2, actual: 2, qualified: 0, partial: false }]);
    expect(await changeCount(pid, 'weekly_result')).toBe(1);
  });

  test('(c) only an ACTIVE plan is measured: a paused plan records no weeks; a channel with no target or no anchor is never measured; an excluded one neither', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Only active', [live('LinkedIn', 2), live('Naukri/IIMjobs', 2)], { anchors: { LinkedIn: ymd(-8), 'Naukri/IIMjobs': ymd(-8) }, extraModes: ['Agency'] });
    await addApps(rid, 'LinkedIn', noon(ymd(-3)), 3);
    await client.query(`UPDATE sourcing_plan_channels SET targets = targets - 'weekly_target' WHERE plan_id=$1::bigint AND channel='Naukri/IIMjobs'`, [pid]);   // legacy row: anchor but no target
    await client.query(`UPDATE sourcing_plans SET status='paused', paused_at=NOW() WHERE id=$1::bigint`, [pid]);
    await plan(request, rid); await cron(request);
    expect(await weekRows(pid, 'LinkedIn')).toEqual([]);                                // paused: the clocks are stopped
    await client.query(`UPDATE sourcing_plans SET status='active', paused_at=NULL WHERE id=$1::bigint`, [pid]);
    await plan(request, rid);
    expect(await weekRows(pid, 'LinkedIn')).toHaveLength(1);
    expect(await weekRows(pid, 'Naukri/IIMjobs')).toEqual([]);                           // no target: nothing to measure against
    expect(channel(await plan(request, rid), 'Naukri/IIMjobs').tracker).toMatchObject({ target: null, running: null, weeks: [] });
    // a draft plan is not measured either, even with a stray anchor
    const drafted = await newRole({ title: 'Draft with stray anchor', modes: ['LinkedIn'] });
    const dpid = (await plan(request, drafted)).plan.id as string;
    await client.query(`UPDATE sourcing_plan_channels SET tracker_anchor=$2::date, targets='{"weekly_target":2}'::jsonb WHERE plan_id=$1::bigint AND channel='LinkedIn'`, [dpid, ymd(-8)]);
    await cron(request);
    expect(await weekRows(dpid, 'LinkedIn')).toEqual([]);
  });

  // ── (d) Close channel / Reopen channel ─────────────────────────────────────────────────────────
  test('(d) close channel is validated: a reason, a real channel that is in the plan, HR only, an active or paused plan — and a refusal changes nothing', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Close validation', [live('LinkedIn', 5)], { anchors: { LinkedIn: ymd(-3) } });
    const url = `/api/sourcing/plans/${pid}/channel/close`;
    for (const [what, body] of [['no reason', { channel: 'LinkedIn' }], ['an empty reason', { channel: 'LinkedIn', reason: '' }], ['a blank reason', { channel: 'LinkedIn', reason: '   ' }],
      ['a 2-character reason', { channel: 'LinkedIn', reason: 'ab' }], ['a non-string reason', { channel: 'LinkedIn', reason: 12345 }], ['an unknown channel', { channel: 'Telegram', reason: 'because' }],
      ['no channel', { reason: 'because' }]] as const) {
      expect((await post(request, hr, url, body)).status, what).toBe(400);
    }
    expect((await post(request, hr, url, { channel: 'Internal Referral', reason: 'not in this plan' })).status).toBe(404);
    expect((await post(request, hr, `/api/sourcing/plans/abc/channel/close`, { channel: 'LinkedIn', reason: 'because' })).status).toBe(400);
    expect((await post(request, hr, `/api/sourcing/plans/999999999/channel/close`, { channel: 'LinkedIn', reason: 'because' })).status).toBe(404);
    expect((await post(request, alex, url, { channel: 'LinkedIn', reason: 'because' })).status).toBe(403);       // the Hiring Manager cannot write
    expect((await post(request, satyadev, url, { channel: 'LinkedIn', reason: 'because' })).status).toBe(403);
    const reopenUrl = `/api/sourcing/plans/${pid}/channel/reopen`;
    expect((await post(request, hr, reopenUrl, { channel: 'LinkedIn' })).status).toBe(409);                      // not closed
    expect((await post(request, hr, reopenUrl, { channel: 'Telegram' })).status).toBe(400);
    expect((await post(request, hr, reopenUrl, { channel: 'Internal Referral' })).status).toBe(404);
    expect((await post(request, alex, reopenUrl, { channel: 'LinkedIn' })).status).toBe(403);
    expect((await post(request, hr, `/api/sourcing/plans/abc/channel/reopen`, { channel: 'LinkedIn' })).status).toBe(400);
    // nothing was touched by any of that
    expect(await chRow(pid, 'LinkedIn')).toMatchObject({ state: 'active', closed_at: null, closed_reason: null, anchor: ymd(-3) });
    expect(await changeCount(pid, 'channel_closed')).toBe(0);
    expect(await weekRows(pid, 'LinkedIn')).toEqual([]);

    // a DRAFT plan cannot close anything (until activation a channel is simply left out); a CLOSED plan neither
    const drafted = await newRole({ title: 'Close on a draft', modes: ['LinkedIn'] });
    const dpid = (await plan(request, drafted)).plan.id as string;
    const d = await closeCh(request, dpid, 'LinkedIn');
    expect(d.status).toBe(409);
    expect(String(d.body.error)).toMatch(/activate the plan first/i);
    expect((await reopenCh(request, dpid, 'LinkedIn')).status).toBe(409);
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { status: 'Closed – Filled' })).status()).toBe(200);
    const c = await closeCh(request, pid, 'LinkedIn');
    expect(c.status).toBe(409);
    expect(String(c.body.error)).toMatch(/role is closed/i);
    expect((await reopenCh(request, pid, 'LinkedIn')).status).toBe(409);
    // Leadership is HR-tier, so it can do what HR does
    const { pid: lp } = await activeRole(request, 'Close by leadership', [live('LinkedIn', 5)]);
    expect((await closeCh(request, lp, 'LinkedIn', 'Closing as leadership', lead)).status).toBe(200);
    expect((await reopenCh(request, lp, 'LinkedIn', hr2)).status).toBe(200);                                   // and any HR user can reopen what another closed
  });

  test('(d) close channel: the week in progress is recorded as a PARTIAL week, open tasks are skipped, and the summary (link, target, weeks, closed reason) stays on the card', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Close summary', [live('LinkedIn', 5), live('Naukri/IIMjobs', 2), { channel: 'Agency' }], { anchors: { LinkedIn: ymd(-8), 'Naukri/IIMjobs': ymd(-2) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-5)), 5);                  // [-8,-2] finished: 5 of 5, met
    await addApps(rid, 'LinkedIn', noon(ymd(0)), 1, { score: 80 });    // the week in progress [-1, today ...]: 1 so far
    await addApps(rid, 'Naukri/IIMjobs', noon(ymd(-1)), 3);
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '10 days' WHERE id = (SELECT c.id FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id=c.plan_channel_id WHERE ch.plan_id=$1::bigint AND ch.channel='LinkedIn' AND c.kind='renew_posting')`, [pid]);
    const before = await plan(request, rid);
    const linkedinUrl = channel(before, 'LinkedIn').tracker.link;
    expect(commitment(before, 'LinkedIn', 'renew_posting').status).toBe('open');

    const reason = 'Enough applicants — the post is taken down';
    expect((await closeCh(request, pid, 'LinkedIn', reason)).status).toBe(200);

    expect((await weekRows(pid, 'LinkedIn')).map(w => [w.ws, w.we, w.target, w.partial])).toEqual([[ymd(-8), ymd(-2), 5, false], [ymd(-1), ymd(0), 5, true]]);   // partial: cut short at today
    expect((await weekRows(pid, 'LinkedIn'))[0]).toMatchObject({ actual: 5, qualified: 0 });
    expect((await weekRows(pid, 'LinkedIn'))[1]).toMatchObject({ actual: 1, qualified: 1 });                   // the cut-short week counts the channel's OWN applicants
    const v = await plan(request, rid);
    const c = channel(v, 'LinkedIn');
    expect(c.state).toBe('closed');
    expect(c.excluded_reason).toBeNull();
    expect(c.closed_reason).toBe(reason);
    expect(new Date(c.closed_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(c.targets.weekly_target).toBe(5);                                                        // the summary survives
    expect(c.config.posting_url).toBe(linkedinUrl);
    expect(c.tracker).toMatchObject({ applicable: true, target: 5, link: linkedinUrl, anchor: null, running: null });
    expect(c.tracker.weeks.map((w: Json) => [w.week_start, w.week_end, w.met, w.partial])).toEqual([[ymd(-1), ymd(0), false, true], [ymd(-8), ymd(-2), true, false]]);
    // a week cut short is shown in the list but is neither a tracked week nor a miss: it is left out of the totals
    expect(c.tracker.totals).toEqual({ weeks: 1, met: 1, actual: 5, target: 5 });
    expect(c.tracker.sourced.applications).toBe(6);
    // the open task was skipped and remembered as "skipped by the close"; the finished one stays done
    expect(commitment(v, 'LinkedIn', 'renew_posting')).toMatchObject({ status: 'skipped', meta: expect.objectContaining({ closed_with_channel: true }) });
    expect(commitment(v, 'LinkedIn', 'activate_channel').status).toBe('done');
    // a channel that was not closed is untouched
    expect(channel(v, 'Naukri/IIMjobs').state).toBe('active');
    expect(channel(v, 'Naukri/IIMjobs').tracker.running).toMatchObject({ actual: 3 });
    expect(commitment(v, 'Naukri/IIMjobs', 'renew_posting').status).toBe('open');
    expect(channel(v, 'Agency').state).toBe('planned');
    expect(commitment(v, 'Agency', 'activate_channel').status).toBe('open');
    // the history: who closed it and why, plus the system's two weekly results (one of them cut short)
    const closed = historyOf(v, 'channel_closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ by_name: 'Aaron Newton', reason, category: 'channel' });
    expect(closed[0].change).toMatchObject({ channel: 'LinkedIn', weeks: 1, weeks_met: 1 });                    // the cut-short week is not a tracked week
    expect(closed[0].text).toBe('LinkedIn: Channel closed after 1 tracked week (1 on target)');
    const weekly = historyOf(v, 'weekly_result');
    expect(weekly).toHaveLength(2);
    const partial = weekly.find(w => w.change.partial === true)!;
    expect(partial).toMatchObject({ by_name: null, category: 'weekly' });
    expect(partial.change).toMatchObject({ channel: 'LinkedIn', week_start: ymd(-1), week_end: ymd(0), target: 5, actual: 1, qualified: 1, met: false });
    expect(partial.text).toContain('1 of 5 applicants');
    expect(partial.text).toContain(PARTIAL_TEXT);
    expect(partial.text).not.toMatch(/target (met|missed)/);
    expect(weekly.find(w => w.change.partial === false)!.change).toMatchObject({ week_start: ymd(-8), actual: 5, met: true });
    // closing again, or leaving it out, or adding it as if new — all refused with a pointer to Reopen
    const again = await closeCh(request, pid, 'LinkedIn');
    expect(again.status).toBe(409);
    expect(String(again.body.error)).toMatch(/already closed/i);
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'LinkedIn', state: 'planned' })).status).toBe(409);
    const out = await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'LinkedIn', state: 'excluded', excluded_reason: 'Dropping it for good' });
    expect(out.status).toBe(409);
    expect(String(out.body.error)).toMatch(/reopen it instead/i);
    expect(await chRow(pid, 'LinkedIn')).toMatchObject({ state: 'excluded', closed_reason: reason });             // stored as 'excluded' + closed_at
    expect((await weekRows(pid, 'LinkedIn')).length).toBe(2);                                                    // a second close wrote nothing more
  });

  // (Used to be a test.fail: closeChannel() loaded the channel row without `channel`, so the week it cut short was counted against
  // sub_source = NULL — stored as 0 applicants and "missed" whatever the channel produced — and its history entry carried no channel.)
  test('(d) the partial week written by Close channel counts that channel\'s applicants (qualified too) and names the channel in the history', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Partial counts', [live('LinkedIn', 5)], { anchors: { LinkedIn: ymd(-3) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-2)), 2, { score: 80 });
    await addApps(rid, 'LinkedIn', noon(ymd(0)), 1);
    await addApps(rid, 'Naukri/IIMjobs', noon(ymd(-1)), 3);                                             // another channel: never counted
    expect((await closeCh(request, pid, 'LinkedIn')).status).toBe(200);
    expect(await weekRows(pid, 'LinkedIn')).toEqual([{ ws: ymd(-3), we: ymd(0), target: 5, actual: 3, qualified: 2, partial: true }]);
    const w = await weeklyEntries(await plan(request, rid));
    expect(w).toHaveLength(1);
    expect(w[0].change).toMatchObject({ channel: 'LinkedIn', week_start: ymd(-3), week_end: ymd(0), target: 5, actual: 3, qualified: 2, partial: true });
    expect(w[0].by_name).toBeNull();
    expect(w[0].text).toMatch(/^LinkedIn: Week \d+ \w+–\d+ \w+: 3 of 5 applicants — week cut short, not counted as met or missed$/);
  });

  test('(d) a closed channel raises nothing: the engine clears what was open and stays quiet, its tasks cannot be completed, skipped or undone, and it is not in My Tasks', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Closed is quiet', [live('LinkedIn', 5), { channel: 'Agency' }], { anchors: { LinkedIn: ymd(-3) } });
    const v0 = await plan(request, rid);
    const renewId = commitment(v0, 'LinkedIn', 'renew_posting').id as string;
    const agencyId = commitment(v0, 'Agency', 'activate_channel').id as string;
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '4 days' WHERE id = ANY($1::bigint[])`, [[renewId, agencyId]]);
    await cron(request);
    expect((await liveTaskExceptions(pid)).map(e => e.channel).sort()).toEqual(['Agency', 'LinkedIn']);
    const queue = await get(request, hr, '/api/sourcing/queue');
    expect((queue.body.due as Json[]).some(d => d.role_id === rid && d.channel === 'LinkedIn' && d.overdue)).toBe(true);

    // closing clears what is open on that channel AT ONCE (nobody waits for the next sweep); the other channel's exception is untouched
    expect((await closeCh(request, pid, 'LinkedIn')).status).toBe(200);
    expect((await liveTaskExceptions(pid)).map(e => e.channel)).toEqual(['Agency']);
    expect((await closeCh(request, pid, 'Agency', 'Agencies are not right for this role')).status).toBe(200);         // closing a channel that never went live is allowed too
    expect(await liveTaskExceptions(pid)).toEqual([]);
    const cleared = await sql(`SELECT channel, status, resolution_path, reason, resolved_at FROM sourcing_exceptions WHERE plan_id=$1::bigint AND type <> 'VOLUME_GAP' ORDER BY channel`, [pid]);
    expect(cleared.map(c => [c.channel, c.status, c.resolution_path, c.reason])).toEqual([['Agency', 'resolved', 'auto_cleared', 'Channel closed'], ['LinkedIn', 'resolved', 'auto_cleared', 'Channel closed']]);
    expect(cleared.every(c => c.resolved_at)).toBe(true);
    await cron(request);
    expect(await liveTaskExceptions(pid)).toEqual([]);
    // the close is its own history entry (channel_closed) and says what it cleared (one "Cleared automatically" per exception it resolved at once);
    // the engine then has nothing left to clear, so it adds none of its own
    expect(await changeCount(pid, 'exception_cleared')).toBe(2);
    expect(await changeCount(pid, 'channel_closed')).toBe(2);
    await Promise.all([cron(request), cron(request), cron(request)]);
    expect(await liveTaskExceptions(pid)).toEqual([]);                                                                      // and nothing new is raised for a closed channel
    const q2 = await get(request, hr, '/api/sourcing/queue');
    expect((q2.body.due as Json[]).filter(d => d.role_id === rid)).toEqual([]);
    expect(JSON.stringify(q2.body.exceptions)).not.toContain(`"role_id":"${rid}"`);

    // nothing of a closed channel can be acted on
    const complete = (id: string) => post(request, hr, `/api/sourcing/commitments/${id}/complete`, { note: 'done' });
    for (const id of [renewId, agencyId]) {
      expect((await complete(id)).status).toBe(409);
      expect((await post(request, hr, `/api/sourcing/commitments/${id}/reopen`)).status).toBe(409);
      expect((await post(request, hr, `/api/sourcing/commitments/${id}/skip`, { reason: 'already skipped by the close' })).status).toBe(409);
    }
    expect(String((await complete(renewId)).body.error)).toMatch(/not in the plan/i);
    const s = await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 9 });
    expect(s.status).toBe(409);
    expect(String(s.body.error)).toMatch(/closed or left out/i);
    // editing the role's Recruitment Mode (off and on again) must not resurrect a closed channel
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { recruitment_mode: ['Agency'] })).status()).toBe(200);
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { recruitment_mode: ['LinkedIn', 'Agency'] })).status()).toBe(200);
    const v = await plan(request, rid);
    expect(channel(v, 'LinkedIn').state).toBe('closed');
    expect(channel(v, 'Agency').state).toBe('closed');
    expect((await liveTaskExceptions(pid))).toEqual([]);
  });

  test('(d) reopen brings back exactly what the close skipped — never a task a person had skipped, never a long-future date pulled in, an overdue one is due tomorrow, not instantly overdue', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Reopen restores', [live('LinkedIn', 5), live('Naukri/IIMjobs', 4)], { anchors: { LinkedIn: ymd(-8), 'Naukri/IIMjobs': ymd(-8) } });
    const v0 = await plan(request, rid);
    const liRenew = commitment(v0, 'LinkedIn', 'renew_posting').id as string, naRenew = commitment(v0, 'Naukri/IIMjobs', 'renew_posting').id as string;
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '10 days' WHERE id=$1::bigint`, [liRenew]);       // overdue while closed
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() + INTERVAL '20 days' WHERE id=$1::bigint`, [naRenew]);       // far in the future
    const naDue = +new Date((await sql(`SELECT due_at FROM sourcing_commitments WHERE id=$1::bigint`, [naRenew]))[0].due_at);
    await addApps(rid, 'LinkedIn', noon(ymd(-4)), 5);

    await closeCh(request, pid, 'LinkedIn'); await closeCh(request, pid, 'Naukri/IIMjobs');
    expect((await sql(`SELECT status FROM sourcing_commitments WHERE id=$1::bigint`, [liRenew]))[0].status).toBe('skipped');
    expect((await reopenCh(request, pid, 'LinkedIn')).status).toBe(200);
    expect((await reopenCh(request, pid, 'Naukri/IIMjobs')).status).toBe(200);

    const v = await plan(request, rid);
    for (const ch of ['LinkedIn', 'Naukri/IIMjobs']) {
      const c = channel(v, ch);
      expect(c.state, ch).toBe('active');
      expect(c.closed_at, ch).toBeNull();
      expect(c.closed_reason, ch).toBeNull();
      expect(c.excluded_reason, ch).toBeNull();
      expect(commitment(v, ch, 'activate_channel').status, ch).toBe('done');
      expect(commitment(v, ch, 'renew_posting').status, ch).toBe('open');
      expect(commitment(v, ch, 'renew_posting').meta.closed_with_channel, ch).toBeUndefined();   // the marker is cleaned up
      expect((await chRow(pid, ch)).anchor, ch).toBe(ymd(0));                                       // the tracker restarts today …
      // … and the week in progress was cut short today (both channels had a window running), so the start the view reports is tomorrow
      expect(c.tracker.anchor, ch).toBe(ymd(1));
      expect(c.tracker.running, ch).toBeNull();
    }
    expect(channel(v, 'LinkedIn').tracker.target).toBe(5);                                          // … with the target it had
    expect(channel(v, 'Naukri/IIMjobs').tracker.target).toBe(4);
    expect(commitment(v, 'LinkedIn', 'renew_posting').due_date).toBe(ymd(1));                       // was 10 days overdue: now due tomorrow, not instantly overdue
    expect(commitment(v, 'LinkedIn', 'renew_posting').overdue).toBe(false);
    expect(+new Date(commitment(v, 'Naukri/IIMjobs', 'renew_posting').due_at)).toBe(naDue);         // a date further out than tomorrow is kept as it was
    await cron(request);
    expect(await liveTaskExceptions(pid)).toEqual([]);                                                  // nothing is overdue straight after reopening
    expect(await changeCount(pid, 'channel_reopened')).toBe(2);
    const reopened = historyOf(v, 'channel_reopened').find(h => h.change.channel === 'LinkedIn')!;
    expect(reopened).toMatchObject({ by_name: 'Aaron Newton', category: 'channel' });
    expect((await sql(`SELECT recruitment_mode FROM roles WHERE id=$1`, [rid]))[0].recruitment_mode).toEqual(expect.arrayContaining(['LinkedIn', 'Naukri/IIMjobs']));

    // a task a PERSON skipped before the close is not brought back by it
    const { rid: r2, pid: p2 } = await activeRole(request, 'Reopen keeps hand skips', [live('LinkedIn', 5)]);
    const hand = commitment(await plan(request, r2), 'LinkedIn', 'renew_posting').id as string;
    expect((await post(request, hr, `/api/sourcing/commitments/${hand}/skip`, { reason: 'The posting renews itself' })).status).toBe(200);
    expect((await closeCh(request, p2, 'LinkedIn')).status).toBe(200);
    expect((await sql(`SELECT meta FROM sourcing_commitments WHERE id=$1::bigint`, [hand]))[0].meta.closed_with_channel).toBeUndefined();   // the close did not touch it
    expect((await reopenCh(request, p2, 'LinkedIn')).status).toBe(200);
    expect(commitment(await plan(request, r2), 'LinkedIn', 'renew_posting').status).toBe('skipped');
  });

  test('(d) reopen restarts the tracker without overlapping a finished week; the same-day reopen starts the next window tomorrow', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Reopen no overlap', [live('LinkedIn', 3)], { anchors: { LinkedIn: ymd(-3) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-2)), 2);
    await addApps(rid, 'LinkedIn', noon(ymd(0)), 1);
    expect((await closeCh(request, pid, 'LinkedIn')).status).toBe(200);
    expect((await weekRows(pid, 'LinkedIn')).map(w => [w.ws, w.we, w.target, w.partial])).toEqual([[ymd(-3), ymd(0), 3, true]]);          // partial: cut short at today
    expect((await reopenCh(request, pid, 'LinkedIn')).status).toBe(200);
    let t = channel(await plan(request, rid), 'LinkedIn').tracker;
    expect(t.weeks).toHaveLength(1);                                                                // the old week is kept and is not duplicated
    expect((await chRow(pid, 'LinkedIn')).anchor).toBe(ymd(0));                                      // restarted today …
    expect(t.anchor).toBe(ymd(1));                                                                  // … but the view's start is the day after the week that was cut short today
    // the partial week already covers today, so counting starts tomorrow: today's applicants are never counted twice
    if (t.running) expect(t.running.start > t.weeks[0].week_end).toBe(true);
    expect(t.running).toBeNull();

    // when the close was on an earlier day, the restarted tracker starts today and counts only from today
    await client.query(`UPDATE sourcing_channel_weeks SET week_start = week_start - 5, week_end = week_end - 5 WHERE plan_channel_id = (SELECT id FROM sourcing_plan_channels WHERE plan_id=$1::bigint AND channel='LinkedIn')`, [pid]);
    await addApps(rid, 'LinkedIn', noon(ymd(-1)), 4);                                               // between the old week and today: before the restart, not counted
    t = channel(await plan(request, rid), 'LinkedIn').tracker;
    expect(t.weeks.map((w: Json) => [w.week_start, w.week_end])).toEqual([[ymd(-8), ymd(-5)]]);
    expect(t.running).toEqual({ start: ymd(0), end: ymd(6), actual: 1, qualified: 0, target: 3 });
    // and a later sync never produces a window that overlaps the kept week
    await setAnchor(pid, 'LinkedIn', ymd(-20));
    await plan(request, rid); await cron(request);
    const rows = await weekRows(pid, 'LinkedIn');
    for (let i = 1; i < rows.length; i++) expect(rows[i].ws > rows[i - 1].we, `week ${i} starts after the previous one ended`).toBe(true);
  });

  test('(d) a channel closed before it ever went live: it can be reopened, its first task starts again from today, and a closed PAUSED plan channel works too', async ({ request }) => {
    const rid = await newRole({ title: 'Close before live', modes: ['Naukri/IIMjobs', 'Direct Outreach', 'Agency'] });
    const pid = (await plan(request, rid)).plan.id as string;
    expect((await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [{ channel: 'Naukri/IIMjobs' }, { channel: 'Direct Outreach' }, { channel: 'Agency' }] })).status).toBe(200);
    const first = commitment(await plan(request, rid), 'Naukri/IIMjobs', 'activate_channel');
    expect((await closeCh(request, pid, 'Naukri/IIMjobs', 'Not posting on Naukri after all')).status).toBe(200);
    let v = await plan(request, rid);
    expect(channel(v, 'Naukri/IIMjobs')).toMatchObject({ state: 'closed', closed_reason: 'Not posting on Naukri after all' });
    expect(channel(v, 'Naukri/IIMjobs').tracker).toMatchObject({ target: null, link: null, anchor: null, running: null, weeks: [] });
    expect(commitment(v, 'Naukri/IIMjobs', 'activate_channel')).toMatchObject({ status: 'skipped', meta: expect.objectContaining({ closed_with_channel: true }) });
    expect(await weekRows(pid, 'Naukri/IIMjobs')).toEqual([]);                                            // there was nothing to measure
    expect(historyOf(v, 'channel_closed')[0].text).toBe('Naukri/IIMjobs: Channel closed');                // no "after N weeks" for a channel that never ran
    expect((await post(request, hr, `/api/sourcing/commitments/${first.id}/complete`, { url: POST_URL, weekly_target: 5 })).status).toBe(409);

    expect((await reopenCh(request, pid, 'Naukri/IIMjobs')).status).toBe(200);
    v = await plan(request, rid);
    expect(channel(v, 'Naukri/IIMjobs')).toMatchObject({ state: 'planned', closed_at: null });
    const act = commitment(v, 'Naukri/IIMjobs', 'activate_channel');
    expect(act.status).toBe('open');                                                                      // a fresh first task, due from today — never already overdue
    expect(act.due_date >= ymd(1)).toBe(true);
    expect(channel(v, 'Naukri/IIMjobs').tracker.anchor).toBeNull();                                       // no target yet, so no tracker yet
    expect((await post(request, hr, `/api/sourcing/commitments/${act.id}/complete`, { url: POST_URL, weekly_target: 5 })).status).toBe(200);
    expect(channel(await plan(request, rid), 'Naukri/IIMjobs').tracker).toMatchObject({ target: 5, anchor: ymd(0) });

    // a PAUSED plan can close and reopen a channel; the reopened channel is live again but its tracker stays stopped (resuming the plan starts it)
    expect((await post(request, hr, `/api/sourcing/commitments/${commitment(v, 'Direct Outreach', 'activate_channel').id}/complete`, { url: POST_URL, weekly_target: 2 })).status).toBe(200);
    await holdRole(request, rid);
    expect((await planRow(pid)).status).toBe('paused');
    expect((await closeCh(request, pid, 'Direct Outreach', 'Paused role, parking this channel')).status).toBe(200);
    expect(channel(await plan(request, rid), 'Direct Outreach').state).toBe('closed');
    await client.query(`UPDATE sourcing_plans SET paused_at = NOW() - INTERVAL '3 days' WHERE id=$1::bigint`, [pid]);
    expect((await reopenCh(request, pid, 'Direct Outreach')).status).toBe(200);
    expect(await chRow(pid, 'Direct Outreach')).toMatchObject({ state: 'active', anchor: null });
    const held = channel(await plan(request, rid), 'Direct Outreach').tracker;
    expect(held).toMatchObject({ target: 2, anchor: null, running: null });
    await resumeRole(request, rid);
    expect((await chRow(pid, 'Direct Outreach')).anchor).toBe(ymd(0));                                      // …and starts today, whatever day the hold began
    expect(channel(await plan(request, rid), 'Direct Outreach').tracker.running).toMatchObject({ start: ymd(0), target: 2 });
  });

  // ── (e) channel settings: target and link ──────────────────────────────────────────────────────
  test('(e) changing the weekly target: weeks that already ended keep the OLD target, the new one applies from then on, and the tracker does not restart', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Target change', [live('LinkedIn', 5)], { anchors: { LinkedIn: ymd(-15) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-12)), 4);          // [-15,-9]: 4 of 5
    await addApps(rid, 'LinkedIn', noon(ymd(-5)), 6);           // [-8,-2]: 6 of 5
    expect((await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 3 })).status).toBe(200);
    // the ended weeks were finished with the target that applied then, BEFORE the change
    expect(await weekRows(pid, 'LinkedIn')).toEqual([
      { ws: ymd(-15), we: ymd(-9), target: 5, actual: 4, qualified: 0, partial: false },
      { ws: ymd(-8), we: ymd(-2), target: 5, actual: 6, qualified: 0, partial: false },
    ]);
    let v = await plan(request, rid);
    expect((await chRow(pid, 'LinkedIn')).anchor).toBe(ymd(-15));                                    // not restarted: the stored start is untouched
    expect(channel(v, 'LinkedIn').tracker).toMatchObject({ target: 3, anchor: ymd(-1) });            // the view reports the start of the running window: the day after the last recorded week
    expect(channel(v, 'LinkedIn').tracker.running).toMatchObject({ target: 3 });
    expect(channel(v, 'LinkedIn').tracker.weeks.map((w: Json) => [w.target, w.met])).toEqual([[5, true], [5, false]]);
    const h = historyOf(v, 'channel_target_changed');
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ by_name: 'Aaron Newton', category: 'target' });
    expect(h[0].change).toMatchObject({ channel: 'LinkedIn', from: 5, to: 3 });
    expect(h[0].text).toContain('5 → 3');

    // time passes (shift the recorded weeks 14 days back): the weeks that end after the change use the new target
    await client.query(`UPDATE sourcing_channel_weeks SET week_start = week_start - 14, week_end = week_end - 14 WHERE plan_channel_id = (SELECT id FROM sourcing_plan_channels WHERE plan_id=$1::bigint AND channel='LinkedIn')`, [pid]);
    v = await plan(request, rid);
    const weeks = (await weekRows(pid, 'LinkedIn'));
    expect(weeks.map(w => [w.ws, w.target, w.actual])).toEqual([[ymd(-29), 5, 4], [ymd(-22), 5, 6], [ymd(-15), 3, 4], [ymd(-8), 3, 6]]);

    // saving the same target again is a no-op: no history entry
    expect((await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 3 })).status).toBe(200);
    expect(await changeCount(pid, 'channel_target_changed')).toBe(1);
    // a fraction is rounded to a whole applicant
    expect((await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 7.4 })).status).toBe(200);
    expect((await chRow(pid, 'LinkedIn')).targets.weekly_target).toBe(7);
    expect((await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 10000 })).status).toBe(200);   // the cap is allowed
    expect((await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 1 })).status).toBe(200);       // and so is 1
    expect(await changeCount(pid, 'channel_target_changed')).toBe(4);
  });

  test('(e) changing the post link: logged once per real change; the same link is a no-op; a target and a link can change together', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Link change', [live('Direct Outreach', 4)]);
    const first = channel(await plan(request, rid), 'Direct Outreach').tracker.link;
    expect((await settingsCh(request, pid, { channel: 'Direct Outreach', posting_url: first })).status).toBe(200);
    expect(await changeCount(pid, 'channel_link_changed')).toBe(0);
    expect((await settingsCh(request, pid, { channel: 'Direct Outreach', posting_url: '  https://example.com/new-link  ' })).status).toBe(200);
    let v = await plan(request, rid);
    expect(channel(v, 'Direct Outreach').tracker.link).toBe('https://example.com/new-link');        // trimmed
    expect(channel(v, 'Direct Outreach').config.posting_url).toBe('https://example.com/new-link');
    expect(historyOf(v, 'channel_link_changed')).toHaveLength(1);
    expect(historyOf(v, 'channel_link_changed')[0]).toMatchObject({ by_name: 'Aaron Newton', category: 'channel' });
    expect(historyOf(v, 'channel_link_changed')[0].text).toContain('Post link updated');
    expect((await settingsCh(request, pid, { channel: 'Direct Outreach', posting_url: 'https://example.com/new-link' })).status).toBe(200);
    expect(await changeCount(pid, 'channel_link_changed')).toBe(1);
    expect((await settingsCh(request, pid, { channel: 'Direct Outreach', weekly_target: 9, posting_url: 'http://example.com/both' })).status).toBe(200);
    v = await plan(request, rid);
    expect(channel(v, 'Direct Outreach').tracker).toMatchObject({ target: 9, link: 'http://example.com/both' });
    expect(await changeCount(pid, 'channel_link_changed')).toBe(2);
    expect(await changeCount(pid, 'channel_target_changed')).toBe(1);
  });

  test('(e) channel settings are validated before anything is written', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Settings validation', [live('LinkedIn', 5)]);
    const snapshot = async () => JSON.stringify([await chRow(pid, 'LinkedIn'), await changeCount(pid, 'channel_target_changed'), await changeCount(pid, 'channel_link_changed')]);
    const before = await snapshot();
    const bad: Array<[string, Json]> = [
      ['an empty body', { channel: 'LinkedIn' }],
      ['target 0', { channel: 'LinkedIn', weekly_target: 0 }], ['a negative target', { channel: 'LinkedIn', weekly_target: -1 }],
      ['target 10001', { channel: 'LinkedIn', weekly_target: 10001 }], ['a target that rounds to 0', { channel: 'LinkedIn', weekly_target: 0.3 }],
      ['a string target', { channel: 'LinkedIn', weekly_target: '12' }], ['a null target', { channel: 'LinkedIn', weekly_target: null }], ['a boolean target', { channel: 'LinkedIn', weekly_target: true }],
      ['an empty link', { channel: 'LinkedIn', posting_url: '' }], ['a javascript: link', { channel: 'LinkedIn', posting_url: 'javascript:alert(1)' }],
      ['an ftp link', { channel: 'LinkedIn', posting_url: 'ftp://example.com/x' }], ['text, not a link', { channel: 'LinkedIn', posting_url: 'my post' }],
      ['a link over 500 characters', { channel: 'LinkedIn', posting_url: `https://example.com/${'a'.repeat(600)}` }], ['a null link', { channel: 'LinkedIn', posting_url: null }],
      ['a good target with a bad link (nothing is applied)', { channel: 'LinkedIn', weekly_target: 8, posting_url: 'nope' }],
      ['a bad target with a good link (nothing is applied)', { channel: 'LinkedIn', weekly_target: 0, posting_url: 'https://example.com/ok' }],
      ['an unknown channel', { channel: 'Telegram', weekly_target: 8 }], ['no channel', { weekly_target: 8 }],
    ];
    for (const [what, body] of bad) expect((await settingsCh(request, pid, body)).status, what).toBe(400);
    expect(await snapshot()).toBe(before);
    expect((await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 8 }, hr)).status).toBe(200);
    expect(rid).toBeTruthy();
  });

  test('(e) channel settings need a tracked channel that is LIVE, on an active or paused plan, for HR — 409 for the rest', async ({ request }) => {
    const rid = await newRole({ title: 'Settings guards', modes: ['LinkedIn', 'Naukri/IIMjobs', 'Direct Outreach', 'Agency'] });
    const pid = (await plan(request, rid)).plan.id as string;
    const dr = await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 5 });                         // a draft plan
    expect(dr.status).toBe(409);
    expect(String(dr.body.error)).toMatch(/activate the plan first/i);
    expect((await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [live('LinkedIn', 5), { channel: 'Naukri/IIMjobs' }, { channel: 'Agency', already_running: true }, { channel: 'Direct Outreach', exclude_reason: 'Not needed' }] })).status).toBe(200);
    const agency = await settingsCh(request, pid, { channel: 'Agency', weekly_target: 5 });
    expect(agency.status).toBe(409);                                                                              // Agency has no weekly target or link
    expect(String(agency.body.error)).toMatch(/no weekly target or post link/i);
    expect((await settingsCh(request, pid, { channel: 'Internal Referral', weekly_target: 5 })).status).toBe(409);
    const notLive = await settingsCh(request, pid, { channel: 'Naukri/IIMjobs', weekly_target: 5 });              // logged nothing yet
    expect(notLive.status).toBe(409);
    expect(String(notLive.body.error)).toMatch(/log the Naukri\/IIMjobs post first/i);
    const left = await settingsCh(request, pid, { channel: 'Direct Outreach', weekly_target: 5 });               // left out of the plan
    expect(left.status).toBe(409);
    expect(String(left.body.error)).toMatch(/closed or left out/i);
    expect((await closeCh(request, pid, 'LinkedIn')).status).toBe(200);
    expect((await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 5 })).status).toBe(409);        // closed
    expect((await reopenCh(request, pid, 'LinkedIn')).status).toBe(200);
    expect((await settingsCh(request, alex, { channel: 'LinkedIn', weekly_target: 5 }, alex)).status).toBe(403);
    expect((await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 6 }, satyadev)).status).toBe(403);
    expect((await settingsCh(request, 'abc', { channel: 'LinkedIn', weekly_target: 6 })).status).toBe(400);
    expect((await settingsCh(request, '999999999', { channel: 'LinkedIn', weekly_target: 6 })).status).toBe(404);
    expect((await settingsCh(request, pid, { channel: 'Telegram', weekly_target: 6 })).status).toBe(400);
    expect((await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 6 }, lead)).status).toBe(200);   // Leadership is HR-tier

    // on a PAUSED plan it is allowed: the hold already stopped the tracker (the week in progress was recorded with the target of the time),
    // and changing the target does not start one — resuming the plan does. On a CLOSED plan it is refused.
    await client.query(`UPDATE sourcing_plan_channels SET tracker_anchor=$3::date WHERE plan_id=$1::bigint AND channel=$2`, [pid, 'LinkedIn', ymd(-2)]);
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { status: 'On Hold' })).status()).toBe(200);
    expect((await chRow(pid, 'LinkedIn')).anchor).toBeNull();
    expect((await weekRows(pid, 'LinkedIn')).map(w => [w.ws, w.we, w.target, w.partial])).toEqual([[ymd(-2), ymd(0), 6, true]]);
    expect((await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 7 })).status).toBe(200);
    expect((await chRow(pid, 'LinkedIn'))).toMatchObject({ anchor: null });
    expect((await chRow(pid, 'LinkedIn')).targets.weekly_target).toBe(7);
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { status: 'Closed – Filled' })).status()).toBe(200);
    const closedPlan = await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 8 });
    expect(closedPlan.status).toBe(409);
    expect(String(closedPlan.body.error)).toMatch(/role is closed/i);
  });

  // ── (f) the per-role target of qualified candidates ────────────────────────────────────────────
  /** A time that counts as "qualified in the last 7 days" for the engine's rolling check: a minute ago, or last Friday at noon on a weekend. */
  const qualAt = () => {
    let d = ymd(0);
    while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = dayPlus(d, -1);
    return d === ymd(0) ? new Date(Date.now() - 60_000).toISOString() : noon(d);
  };
  const patchPlan = (request: any, pid: string, body: Json, tok = hr) => patch(request, tok, `/api/sourcing/plans/${pid}`, body);
  const volumeGap = async (pid: string) => (await liveExceptions(pid)).find(e => e.type === 'VOLUME_GAP');

  test('(f) the target per role: default 5 for P0/P1, settable 1..500, clearable, logged once per real change, validated, HR only', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Role target', [{ channel: 'LinkedIn' }]);
    expect((await plan(request, rid)).volume).toMatchObject({ applicable: true, min: 5, target_source: 'default', role_target: null, default_target: 5 });

    expect((await patchPlan(request, pid, { weekly_qualified_target: 8 })).status).toBe(200);
    let v = await plan(request, rid);
    expect(v.volume).toMatchObject({ applicable: true, min: 8, target_source: 'role', role_target: 8, default_target: 5 });
    expect(v.plan.weekly_qualified_target).toBe(8);
    let h = historyOf(v, 'qualified_target_changed');
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ by_name: 'Aaron Newton', category: 'target' });
    expect(h[0].change).toMatchObject({ from: null, to: 8 });
    expect(h[0].text).toBe('Weekly qualified target default → 8');
    expect((await patchPlan(request, pid, { weekly_qualified_target: 8 })).status).toBe(200);              // unchanged: no new entry
    expect(await changeCount(pid, 'qualified_target_changed')).toBe(1);

    expect((await patchPlan(request, pid, { weekly_qualified_target: null })).status).toBe(200);            // back to the default
    v = await plan(request, rid);
    expect(v.volume).toMatchObject({ min: 5, target_source: 'default', role_target: null });
    expect(v.plan.weekly_qualified_target).toBeNull();
    expect(historyOf(v, 'qualified_target_changed')[0].text).toBe('Weekly qualified target 8 → default');
    expect((await patchPlan(request, pid, { weekly_qualified_target: null })).status).toBe(200);
    expect(await changeCount(pid, 'qualified_target_changed')).toBe(2);

    // boundaries and junk
    for (const t of [1, 500]) {
      expect((await patchPlan(request, pid, { weekly_qualified_target: t })).status, `target ${t}`).toBe(200);
      expect((await plan(request, rid)).volume.role_target, `target ${t}`).toBe(t);
    }
    expect((await patchPlan(request, pid, { weekly_qualified_target: 500.4 })).status).toBe(200);              // rounded to the nearest whole candidate
    expect((await plan(request, rid)).volume.role_target).toBe(500);
    expect((await patchPlan(request, pid, { weekly_qualified_target: 2.5 })).status).toBe(200);
    expect((await plan(request, rid)).volume.role_target).toBe(3);
    for (const bad of [0, 501, -1, 0.4, 1e9, 'five', '5', true, [], {}]) {
      expect((await patchPlan(request, pid, { weekly_qualified_target: bad })).status, `target ${JSON.stringify(bad)}`).toBe(400);
    }
    expect((await plan(request, rid)).volume.role_target).toBe(3);                                            // nothing above changed it
    // the database itself refuses an out-of-range value
    await expect(client.query(`UPDATE sourcing_plans SET weekly_qualified_target = 501 WHERE id=$1::bigint`, [pid])).rejects.toThrow(/check constraint/i);
    await expect(client.query(`UPDATE sourcing_plans SET weekly_qualified_target = 0 WHERE id=$1::bigint`, [pid])).rejects.toThrow(/check constraint/i);

    expect((await patchPlan(request, pid, { weekly_qualified_target: 4 }, alex)).status).toBe(403);
    expect((await patchPlan(request, pid, { weekly_qualified_target: 4 }, satyadev)).status).toBe(403);
    expect((await patchPlan(request, pid, { weekly_qualified_target: 4 }, hr2)).status).toBe(200);
    expect((await patchPlan(request, pid, { weekly_qualified_target: 6 }, lead)).status).toBe(200);
    expect((await patchPlan(request, '999999999', { weekly_qualified_target: 4 })).status).toBe(404);
    expect((await patchPlan(request, 'abc', { weekly_qualified_target: 4 })).status).toBe(400);
    // the strategy note and the target are edited by the same route and do not disturb each other
    expect((await patchPlan(request, pid, { strategy_note: 'Focus on plant engineers' })).status).toBe(200);
    expect((await plan(request, rid)).volume.role_target).toBe(6);
    expect((await patchPlan(request, pid, {})).status).toBe(200);
    // it can be set on a DRAFT plan too, before activation
    const drafted = await newRole({ title: 'Target on a draft', priority: 'P3', modes: ['LinkedIn'] });
    const dpid = (await plan(request, drafted)).plan.id as string;
    expect((await plan(request, drafted)).volume).toMatchObject({ applicable: false, target_source: 'none', min: 0 });
    expect((await patchPlan(request, dpid, { weekly_qualified_target: 2 })).status).toBe(200);
    expect((await plan(request, drafted)).volume).toMatchObject({ applicable: true, min: 2, target_source: 'role', role_target: 2, default_target: null });
  });

  test('(f) activation can set the role\'s target (validated, rolled back on error); P2/P3 roles have no target until one is set', async ({ request }) => {
    const rid = await newRole({ title: 'Activate with target', priority: 'P2', modes: ['LinkedIn'] });
    const pid = (await plan(request, rid)).plan.id as string;
    expect((await plan(request, rid)).volume).toEqual(expect.objectContaining({ applicable: false, min: 0, target_source: 'none', role_target: null, default_target: null }));
    for (const t of [0, 501, -2, 0.2]) expect((await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [{ channel: 'LinkedIn' }], weekly_qualified_target: t })).status, `target ${t}`).toBe(400);
    expect((await plan(request, rid)).plan.status).toBe('draft');
    expect((await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [{ channel: 'LinkedIn' }], weekly_qualified_target: 3 })).status).toBe(200);
    const v = await plan(request, rid);
    expect(v.volume).toMatchObject({ applicable: true, min: 3, target_source: 'role', role_target: 3, default_target: null });
    expect(v.plan.baseline.weekly_qualified_target).toBe(3);
    const a = historyOf(v, 'activated')[0];
    expect(a.change.weekly_qualified_target).toBe(3);
    expect(a.text).toContain('target of 3 qualified a week');

    // activating WITHOUT a target leaves a P1 role on the default and a P2 role without one
    const p1 = await newRole({ title: 'Activate default', priority: 'P1', modes: ['LinkedIn'] });
    const p1id = (await plan(request, p1)).plan.id as string;
    expect((await post(request, hr, `/api/sourcing/plans/${p1id}/activate`, { channels: [{ channel: 'LinkedIn' }], weekly_qualified_target: null })).status).toBe(200);
    expect((await plan(request, p1)).volume).toMatchObject({ min: 5, target_source: 'default', role_target: null });
    const p2 = await newRole({ title: 'Activate none', priority: 'P2', modes: ['LinkedIn'] });
    const p2id = (await plan(request, p2)).plan.id as string;
    expect((await post(request, hr, `/api/sourcing/plans/${p2id}/activate`, { channels: [{ channel: 'LinkedIn' }] })).status).toBe(200);
    expect((await plan(request, p2)).volume).toMatchObject({ applicable: false, target_source: 'none' });
  });

  test('(f) the engine\'s VOLUME_GAP uses the role\'s own target: a P2 role is checked only once it has one, with evidence.min = that target; a lower target clears what the default would flag', async ({ request }) => {
    await shadow(false);                                                                // threshold signals are live for this test
    try {
      const none = await activeRole(request, 'P2 no target', [{ channel: 'LinkedIn' }], { priority: 'P2' });
      const withT = await activeRole(request, 'P2 with target', [{ channel: 'LinkedIn' }], { priority: 'P2' });
      expect((await patchPlan(request, withT.pid, { weekly_qualified_target: 4 })).status).toBe(200);
      const p3 = await activeRole(request, 'P3 with target', [{ channel: 'LinkedIn' }], { priority: 'P3' });
      expect((await patchPlan(request, p3.pid, { weekly_qualified_target: 1 })).status).toBe(200);
      await cron(request);
      expect(await volumeGap(none.pid)).toBeUndefined();                                // P2 with no target: nothing to measure against
      const gap = await volumeGap(withT.pid);
      expect(gap).toMatchObject({ channel: '*', status: 'open', is_shadow: false });
      expect(gap!.evidence).toMatchObject({ min: 4, weekly_qualified: 0 });
      expect((await volumeGap(p3.pid))!.evidence.min).toBe(1);
      // the system noticed it and says so (once), in the plan's history
      let v = await plan(request, withT.rid);
      const opened = historyOf(v, 'exception_opened').filter(h => h.change.exception_type === 'VOLUME_GAP');
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ by_name: null, category: 'exception' });
      expect(opened[0].text).toContain('Too few qualified candidates');
      expect((v.exceptions as Json[]).find(e => e.type === 'VOLUME_GAP')!.evidence.min).toBe(4);
      // clearing the target puts a P2 role back to "not measured": the engine clears the gap
      expect((await patchPlan(request, withT.pid, { weekly_qualified_target: null })).status).toBe(200);
      await cron(request);
      expect(await volumeGap(withT.pid)).toBeUndefined();
      v = await plan(request, withT.rid);
      expect(historyOf(v, 'exception_cleared').filter(h => h.change.exception_type === 'VOLUME_GAP')).toHaveLength(1);

      // a P1 role: the default (5) flags 2 qualified candidates, the role's own target of 2 does not
      const p1 = await activeRole(request, 'P1 own target', [{ channel: 'LinkedIn' }], { priority: 'P1' });
      await addApps(p1.rid, 'LinkedIn', qualAt(), 2, { score: 80 });
      await cron(request);
      expect((await volumeGap(p1.pid))!.evidence).toMatchObject({ min: 5, weekly_qualified: 2 });
      expect((await plan(request, p1.rid)).volume).toMatchObject({ weekly_qualified: 2, min: 5, target_source: 'default' });
      expect((await patchPlan(request, p1.pid, { weekly_qualified_target: 2 })).status).toBe(200);
      await cron(request);
      expect(await volumeGap(p1.pid)).toBeUndefined();
      expect((await plan(request, p1.rid)).volume).toMatchObject({ weekly_qualified: 2, min: 2, target_source: 'role' });
      expect((await patchPlan(request, p1.pid, { weekly_qualified_target: 3 })).status).toBe(200);              // raise it above what is there: flagged again
      await cron(request);
      expect((await volumeGap(p1.pid))!.evidence).toMatchObject({ min: 3, weekly_qualified: 2 });
      // a global default change moves only roles WITHOUT their own target
      const dflt = await activeRole(request, 'P1 default moves', [{ channel: 'LinkedIn' }], { priority: 'P1' });
      await setSetting('volume_min_qualified', 9);
      try {
        await cron(request);
        expect((await volumeGap(dflt.pid))!.evidence.min).toBe(9);
        expect((await volumeGap(p1.pid))!.evidence.min).toBe(3);
        expect((await plan(request, dflt.rid)).volume).toMatchObject({ min: 9, default_target: 9, target_source: 'default' });
      } finally { await client.query(`DELETE FROM sourcing_settings WHERE key='volume_min_qualified'`); }
    } finally { await shadow(true); }
  });

  test('(f) a DRAFT plan with a target only ever raises a provisional gap; and a paused plan is not measured', async ({ request }) => {
    await shadow(false);
    try {
      const rid = await newRole({ title: 'Draft with target', priority: 'P2', modes: ['LinkedIn'] });
      const pid = (await plan(request, rid)).plan.id as string;
      expect((await patchPlan(request, pid, { weekly_qualified_target: 2 })).status).toBe(200);
      await cron(request);
      expect(await volumeGap(pid)).toMatchObject({ is_shadow: true });                    // a draft has not been committed to yet
      expect(await changeCount(pid, 'exception_opened')).toBe(0);                          // and provisional signals are never written to the history
      const act = await activeRole(request, 'Paused with target', [{ channel: 'LinkedIn' }], { priority: 'P2' });
      expect((await patchPlan(request, act.pid, { weekly_qualified_target: 2 })).status).toBe(200);
      expect((await authed(request, hr).patch(`/api/roles/${act.rid}`, { status: 'On Hold' })).status()).toBe(200);
      await cron(request);
      expect(await volumeGap(act.pid)).toBeUndefined();                                    // paused: the engine ignores it
    } finally { await shadow(true); }
  });

  test('(f) My Tasks queue volume and the Dashboard workspace use the role\'s own target (P2 without one is absent / has no target)', async ({ request }) => {
    const p1 = await activeRole(request, 'Q P1 default', [{ channel: 'LinkedIn' }], { priority: 'P1' });
    const p1own = await activeRole(request, 'Q P1 own', [{ channel: 'LinkedIn' }], { priority: 'P1' });
    const p2none = await activeRole(request, 'Q P2 none', [{ channel: 'LinkedIn' }], { priority: 'P2' });
    const p2own = await activeRole(request, 'Q P2 own', [{ channel: 'LinkedIn' }], { priority: 'P2' });
    await patchPlan(request, p1own.pid, { weekly_qualified_target: 2 });
    await patchPlan(request, p2own.pid, { weekly_qualified_target: 6 });
    for (const r of [p1, p1own, p2none, p2own]) await addApps(r.rid, 'LinkedIn', qualAt(), 2, { score: 80 });

    const q = await get(request, hr, '/api/sourcing/queue');
    expect(q.status).toBe(200);
    const vol = (rid: string) => (q.body.volume as Json[]).find(x => x.role_id === rid);
    expect(vol(p1.rid)).toMatchObject({ min: 5, qualified: 2 });
    expect(vol(p1own.rid)).toMatchObject({ min: 2, qualified: 2 });
    expect(vol(p2own.rid)).toMatchObject({ min: 6, qualified: 2 });
    expect(vol(p2none.rid)).toBeUndefined();
    expect(q.body.volume_ok).toBe((q.body.volume as Json[]).filter(x => x.qualified >= x.min).length);       // consistent with its own rows

    const w = await get(request, hr, '/api/sourcing/workspace');
    const row = (rid: string) => (w.body.roles as Json[]).find(x => x.role_id === rid)!;
    expect(row(p1.rid)).toMatchObject({ target: 5, qualified: 2, behind: true });
    expect(row(p1own.rid)).toMatchObject({ target: 2, qualified: 2, behind: false });                        // at the target: not behind
    expect(row(p2own.rid)).toMatchObject({ target: 6, qualified: 2, behind: true });
    expect(row(p2none.rid)).toMatchObject({ target: null, behind: false });
  });

  // ── (g) plan history: every action is logged ───────────────────────────────────────────────────
  test('(g) every action a person takes in the workspace is in the plan history — who, what (plain text), why, and a category', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'History actions', [live('LinkedIn', 5), { channel: 'Agency' }, { channel: 'Internal Referral', exclude_reason: 'No referral budget' }], { anchors: { LinkedIn: ymd(-3) } });
    const agencyAct = commitment(await plan(request, rid), 'Agency', 'activate_channel').id as string;

    expect((await post(request, hr, `/api/sourcing/commitments/${agencyAct}/skip`, { reason: 'Waiting for budget approval' })).status).toBe(200);
    expect((await post(request, hr, `/api/sourcing/commitments/${agencyAct}/reopen`)).status).toBe(200);
    expect((await post(request, hr, `/api/sourcing/commitments/${agencyAct}/complete`, { note: 'Briefed two agencies' })).status).toBe(200);
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'Internal Referral', state: 'planned' })).status).toBe(200);
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'Internal Referral', state: 'excluded', excluded_reason: 'Referral push paused for now' })).status).toBe(200);
    expect((await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 7, posting_url: 'https://example.com/changed' })).status).toBe(200);
    expect((await patchPlan(request, pid, { weekly_qualified_target: 9, strategy_note: 'Focus on plant engineers' })).status).toBe(200);
    expect((await closeCh(request, pid, 'LinkedIn', 'Post taken down — enough reach')).status).toBe(200);
    expect((await reopenCh(request, pid, 'LinkedIn')).status).toBe(200);
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { recruitment_mode: ['LinkedIn', 'Agency', 'Direct Outreach'] })).status()).toBe(200);
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { recruitment_mode: ['LinkedIn', 'Agency'] })).status()).toBe(200);

    const v = await plan(request, rid);
    const expected: Array<[string, string, RegExp, string | null]> = [
      ['activated', 'plan', /Plan activated with 2 channels/, null],
      ['commitment_completed', 'task', /Done — /, 'Briefed two agencies'],       // the newest one: the Agency task, whose note is its reason
      ['commitment_skipped', 'task', /Agency: Skipped — Select agencies and share the role brief/, 'Waiting for budget approval'],
      ['commitment_reopened', 'task', /Agency: Skipped task brought back/, null],
      ['channel_added', 'channel', /Channel added: Internal Referral/, null],
      ['channel_excluded', 'channel', /Channel left out: Internal Referral/, 'Referral push paused for now'],
      ['channel_target_changed', 'target', /LinkedIn: Weekly sourcing target 5 → 7/, null],
      ['channel_link_changed', 'channel', /LinkedIn: Post link updated/, null],
      ['qualified_target_changed', 'target', /Weekly qualified target default → 9/, null],
      ['strategy_note_changed', 'plan', /Strategy note edited/, null],
      ['channel_closed', 'channel', /LinkedIn: Channel closed after 0 tracked weeks|LinkedIn: Channel closed/, 'Post taken down — enough reach'],
      ['channel_reopened', 'channel', /LinkedIn: Channel reopened/, null],
      ['channels_added_on_role', 'channel', /Channels added from the role: Direct Outreach/, null],
      ['channels_removed_on_role', 'channel', /Channels removed from the role: Direct Outreach/, null],
    ];
    for (const [type, category, text, reason] of expected) {
      const hit = historyOf(v, type);
      expect(hit.length, `${type} is in the history`).toBeGreaterThan(0);
      const h = hit[0];
      expect(h.by_name, type).toBe('Aaron Newton');
      expect(h.category, type).toBe(category);
      expect(h.text, type).toMatch(text);
      expect(h.reason, type).toBe(reason);
      expect(typeof h.id, type).toBe('string');
      expect(new Date(h.at).toString(), type).not.toBe('Invalid Date');
    }
    // the Agency task was completed with a note: the note is the entry's reason
    const done = historyOf(v, 'commitment_completed').find(h => h.change.channel === 'Agency')!;
    expect(done.reason).toBe('Briefed two agencies');
    expect(done.text).toContain('Done — Select agencies and share the role brief');
    // newest first, ids unique, and the total is the number of rows
    const ats = (v.changes as Json[]).map(c => +new Date(c.at));
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
    expect(new Set((v.changes as Json[]).map(c => c.id)).size).toBe(v.changes.length);
    expect(v.changes_total).toBe((await sql(`SELECT count(*)::int AS n FROM sourcing_plan_changes WHERE plan_id=$1::bigint`, [pid]))[0].n);
    expect((v.changes as Json[]).every(c => typeof c.text === 'string' && c.text.length > 0 && ['plan', 'task', 'channel', 'target', 'exception', 'weekly'].includes(c.category))).toBe(true);
    // the last thing done is first in the list
    expect(v.changes[0].change.type).toBe('channels_removed_on_role');
  });

  test('(g) exception entries are SYSTEM entries (no person), written once per transition and never once per engine run; resolutions are written under the person who made them', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'History exceptions', [live('LinkedIn', 5), { channel: 'Agency' }]);
    const v0 = await plan(request, rid);
    const agencyAct = commitment(v0, 'Agency', 'activate_channel').id as string;
    const renew = commitment(v0, 'LinkedIn', 'renew_posting').id as string;
    const typeCount = (type: string, ch?: string) => sql(`SELECT 1 FROM sourcing_plan_changes WHERE plan_id=$1::bigint AND change->>'type'=$2 AND ($3::text IS NULL OR change->>'channel'=$3) AND change->>'exception_type' <> 'VOLUME_GAP'`, [pid, type, ch ?? null]).then(r => r.length);

    // opened: one entry however many times the engine runs
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '2 days' WHERE id=$1::bigint`, [agencyAct]);
    for (let i = 0; i < 3; i++) await cron(request);
    await Promise.all([cron(request), cron(request), cron(request)]);
    expect(await typeCount('exception_opened', 'Agency')).toBe(1);
    const exId = (await liveExceptions(pid)).find(e => e.channel === 'Agency')!.id;
    let v = await plan(request, rid);
    const opened = historyOf(v, 'exception_opened').find(h => h.change.channel === 'Agency')!;
    expect(opened).toMatchObject({ by_name: null, category: 'exception' });
    expect(opened.change).toMatchObject({ exception_type: 'CHANNEL_NOT_ACTIVATED', channel: 'Agency' });
    expect(opened.text).toBe('Agency: Flagged — Channel set-up overdue');

    // catch up (a person) -> logged under the person; staying snoozed through engine runs logs nothing
    expect((await post(request, hr, `/api/sourcing/exceptions/${exId}/resolve`, { path: 'catch_up', reason: 'Brief goes out tomorrow', snooze_until: ymd(2) })).status).toBe(200);
    await cron(request); await cron(request);
    v = await plan(request, rid);
    const snoozed = historyOf(v, 'exception_snoozed');
    expect(snoozed).toHaveLength(1);
    expect(snoozed[0]).toMatchObject({ by_name: 'Aaron Newton', reason: 'Brief goes out tomorrow', category: 'exception' });
    expect(snoozed[0].text).toMatch(/^Agency: Catching up by \d+ \w+ — Channel set-up overdue$/);
    expect(await typeCount('exception_reopened')).toBe(0);
    // the catch-up date lapses: the engine puts it back on the list — once
    await client.query(`UPDATE sourcing_exceptions SET snooze_until = CURRENT_DATE - 1 WHERE id=$1::bigint`, [exId]);
    await cron(request); await cron(request); await cron(request);
    expect(await typeCount('exception_reopened', 'Agency')).toBe(1);
    v = await plan(request, rid);
    expect(historyOf(v, 'exception_reopened')[0]).toMatchObject({ by_name: null, category: 'exception' });
    expect(historyOf(v, 'exception_reopened')[0].text).toContain('catch-up date passed');
    expect(await typeCount('exception_opened', 'Agency')).toBe(1);                                    // reopening is not a second "opened"

    // blocker, then change of strategy — each under the person who did it
    expect((await post(request, hr, `/api/sourcing/exceptions/${exId}/resolve`, { path: 'blocker', reason: 'Waiting on the agency contract', blocker_due: ymd(5), blocker_owner_user_id: (await sql(`SELECT id FROM users WHERE email='garima@digitalpaani.com'`))[0].id })).status).toBe(200);
    v = await plan(request, rid);
    const blocked = historyOf(v, 'exception_blocked')[0];
    expect(blocked).toMatchObject({ by_name: 'Aaron Newton', reason: 'Waiting on the agency contract', category: 'exception' });
    expect(blocked.change).toMatchObject({ owner: 'Garima' });
    expect(blocked.text).toContain('Garima to unblock');
    await cron(request); await cron(request);
    expect(await typeCount('exception_opened', 'Agency')).toBe(1);                                    // still one

    // fixed by doing the work: the engine clears it by itself — one "cleared" entry, however many runs follow
    expect((await post(request, hr, `/api/sourcing/commitments/${agencyAct}/complete`, { note: 'Agencies briefed' })).status).toBe(200);
    for (let i = 0; i < 3; i++) await cron(request);
    expect(await typeCount('exception_cleared', 'Agency')).toBe(1);
    v = await plan(request, rid);
    expect(historyOf(v, 'exception_cleared').find(h => h.change.channel === 'Agency')).toMatchObject({ by_name: null, category: 'exception' });
    expect(historyOf(v, 'exception_cleared').find(h => h.change.channel === 'Agency')!.text).toBe('Agency: Cleared automatically — Channel set-up overdue');

    // a NEW problem after it cleared is a new transition: opened once more; resolved by changing strategy
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '5 days' WHERE id=$1::bigint`, [renew]);
    await cron(request); await cron(request);
    expect(await typeCount('exception_opened', 'LinkedIn')).toBe(1);
    const li = (await liveExceptions(pid)).find(e => e.channel === 'LinkedIn')!;
    expect((await post(request, hr, `/api/sourcing/exceptions/${li.id}/resolve`, { path: 'change_strategy', reason: 'Renewing through the recruiter plan instead' })).status).toBe(200);
    v = await plan(request, rid);
    const changed = historyOf(v, 'strategy_changed')[0];
    expect(changed).toMatchObject({ by_name: 'Aaron Newton', reason: 'Renewing through the recruiter plan instead', category: 'exception' });
    expect(changed.text).toContain('Strategy changed to resolve');
    await cron(request);
    expect(await typeCount('exception_cleared', 'LinkedIn')).toBe(0);                                  // resolved by a person, not "cleared automatically"
  });

  test('(g) provisional (shadow) signals are NOT written to the history while they are provisional', async ({ request }) => {
    await shadow(true);
    const { rid, pid } = await activeRole(request, 'History shadow', [{ channel: 'LinkedIn' }], { priority: 'P1' });
    for (let i = 0; i < 3; i++) await cron(request);
    expect(await volumeGap(pid)).toMatchObject({ is_shadow: true });
    expect(await changeCount(pid, 'exception_opened')).toBe(0);
    // it clears (a qualified candidate and a lower target): a provisional signal clearing is not news either
    expect((await patchPlan(request, pid, { weekly_qualified_target: 1 })).status).toBe(200);
    await addApps(rid, 'LinkedIn', qualAt(), 1, { score: 80 });
    await cron(request);
    expect(await volumeGap(pid)).toBeUndefined();
    expect(await changeCount(pid, 'exception_cleared')).toBe(0);
    expect(await changeCount(pid, 'exception_opened')).toBe(0);
    const v = await plan(request, rid);
    expect((v.changes as Json[]).filter(c => String(c.change.type).startsWith('exception_'))).toEqual([]);
  });

  // (Used to be a test.fail: a signal that was provisional when the engine first saw it and then went live (the shadow period ended) was upserted over
  // the SAME row with is_shadow = false, and only INSERTED rows were logged as "opened" — so the history never said it was flagged, yet it later said
  // "Cleared automatically". The flip is now one atomic UPDATE in reconcileExceptions that logs it at the moment it becomes visible.)
  test('(g) every "cleared automatically" entry has a matching earlier "flagged" entry, even for a signal that was provisional first and went live later', async ({ request }) => {
    await shadow(true);
    const { rid, pid } = await activeRole(request, 'History shadow flip', [{ channel: 'LinkedIn' }], { priority: 'P1' });
    await cron(request);
    expect(await volumeGap(pid)).toMatchObject({ is_shadow: true });
    await shadow(false);
    try {
      await cron(request);
      expect(await volumeGap(pid)).toMatchObject({ is_shadow: false });                            // now visible to HR
      expect(await changeCount(pid, 'exception_opened')).toBe(1);                                  // …so it should have been announced
      expect((await patchPlan(request, pid, { weekly_qualified_target: 1 })).status).toBe(200);
      await addApps(rid, 'LinkedIn', qualAt(), 1, { score: 80 });
      await cron(request);
      const v = await plan(request, rid);
      const cleared = historyOf(v, 'exception_cleared');
      expect(cleared).toHaveLength(1);
      for (const c of cleared) {
        expect(historyOf(v, 'exception_opened').some(o => o.change.exception_type === c.change.exception_type && o.change.channel === c.change.channel), 'a matching opened entry').toBe(true);
      }
    } finally { await shadow(true); }
  });

  test('(g) the role lifecycle is logged: paused and resumed (system), role closed and reopened (under the person who changed the role)', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'History lifecycle', [live('LinkedIn', 5)], { anchors: { LinkedIn: ymd(-2) } });
    const setRole = (status: string) => authed(request, hr).patch(`/api/roles/${rid}`, { status });
    expect((await setRole('On Hold')).status()).toBe(200);
    await client.query(`UPDATE sourcing_plans SET paused_at = NOW() - INTERVAL '3 days' WHERE id=$1::bigint`, [pid]);
    expect((await setRole('Live – Sourcing')).status()).toBe(200);
    expect((await setRole('Closed – Filled')).status()).toBe(200);
    expect((await setRole('Live – Sourcing')).status()).toBe(200);
    const v = await plan(request, rid);
    const one = (type: string) => { const h = historyOf(v, type); expect(h, type).toHaveLength(1); return h[0]; };
    expect(one('paused')).toMatchObject({ by_name: null, category: 'plan', text: 'Plan paused — the role is on hold (the weekly trackers stop until it is back)' });
    expect(one('resumed')).toMatchObject({ by_name: null, category: 'plan' });
    expect(one('resumed').text).toMatch(/^Plan resumed after \d+ days? on hold$/);
    expect(one('resumed').change.paused_days).toBeGreaterThanOrEqual(3);
    expect(one('role_closed')).toMatchObject({ category: 'plan', text: 'Role closed — the plan was closed and open tasks were cleared' });
    expect(one('role_closed').by_name).toBe('Aaron Newton');
    expect(one('role_reopened')).toMatchObject({ category: 'plan', by_name: 'Aaron Newton' });
    expect(one('role_reopened').reason).toMatch(/returned to draft/i);
  });

  test('(g) the history is capped at the latest 200 entries, newest first, and says how many there are in total', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'History cap', [{ channel: 'LinkedIn' }]);
    await client.query(
      `INSERT INTO sourcing_plan_changes (plan_id, at, change, reason) SELECT $1::bigint, NOW() - (g || ' minutes')::interval, '{"type":"strategy_note_changed"}'::jsonb, 'bulk-' || g FROM generate_series(1, 230) g`, [pid]);
    const total = (await sql(`SELECT count(*)::int AS n FROM sourcing_plan_changes WHERE plan_id=$1::bigint`, [pid]))[0].n;
    expect(total).toBeGreaterThanOrEqual(231);
    const v = await plan(request, rid);
    expect(v.changes).toHaveLength(200);
    expect(v.changes_total).toBe(total);
    const ats = (v.changes as Json[]).map(c => +new Date(c.at));
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
    expect(v.changes[0].change.type).toBe('activated');                                       // the real, newest entry heads the list
    const reasons = new Set((v.changes as Json[]).map(c => c.reason));
    expect(reasons.has('bulk-1')).toBe(true);                                                  // the newest bulk row is in
    expect(reasons.has('bulk-230')).toBe(false);                                               // the oldest ones fell off the end
    expect(reasons.has('bulk-200')).toBe(false);
    // a Hiring Manager gets no history at all, and no total
    const hm = await get(request, alex, `/api/sourcing/plans/${rid}`);
    expect(hm.body.changes).toEqual([]);
    expect(hm.body.changes_total).toBe(0);
  });

  // ── (h) the Dashboard workspace endpoint ───────────────────────────────────────────────────────
  test('(h) workspace: HR sees every role with a plan (drafts listed apart), ordered by priority; each row carries the card facts', async ({ request }) => {
    const p3 = await activeRole(request, 'WS P3', [live('LinkedIn', 5)], { priority: 'P3' });
    const p1b = await activeRole(request, 'WS P1 b', [live('LinkedIn', 5), { channel: 'Naukri/IIMjobs' }], { priority: 'P1' });
    const p0 = await activeRole(request, 'WS P0', [live('LinkedIn', 5), { channel: 'Agency' }], { priority: 'P0' });
    const p2 = await activeRole(request, 'WS P2', [{ channel: 'LinkedIn' }], { priority: 'P2' });
    const p1a = await activeRole(request, 'WS P1 a', [live('LinkedIn', 5)], { priority: 'P1' });
    const draftRid = await newRole({ title: 'WS draft', priority: 'P0', modes: ['LinkedIn'] });
    const draftPid = (await plan(request, draftRid)).plan.id as string;
    const closedRole = await activeRole(request, 'WS closed', [live('LinkedIn', 5)]);
    expect((await authed(request, hr).patch(`/api/roles/${closedRole.rid}`, { status: 'Closed – Filled' })).status()).toBe(200);
    const mine = [p3, p1b, p0, p2, p1a].map(r => r.rid);

    // an exception on p0 (Agency overdue; the volume signal is provisional, so only this one counts), a closed channel on p1a
    const agencyAct = commitment(await plan(request, p0.rid), 'Agency', 'activate_channel').id as string;
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '3 days' WHERE id=$1::bigint`, [agencyAct]);
    await cron(request);
    expect((await closeCh(request, p1a.pid, 'LinkedIn')).status).toBe(200);

    for (const tok of [hr, hr2, lead]) {
      const w = await get(request, tok, '/api/sourcing/workspace');
      expect(w.status).toBe(200);
      expect(w.body).toMatchObject({ enabled: true, read_only: false });
      const ids = (w.body.roles as Json[]).map(r => r.role_id);
      const order = ids.filter(id => mine.includes(id));
      expect(order, 'ordered P0, P1, P1, P2, P3').toEqual([p0.rid, ...[p1a.rid, p1b.rid].sort(), p2.rid, p3.rid]);
      expect(ids).not.toContain(draftRid);                                                    // drafts are listed apart
      expect(ids).not.toContain(closedRole.rid);                                              // a closed role has no workspace
      const drafts = (w.body.drafts as Json[]);
      expect(drafts.map(d => d.role_id)).toContain(draftRid);
      expect(drafts.find(d => d.role_id === draftRid)).toMatchObject({ plan_id: draftPid, plan_status: 'draft', priority: 'P0', channels_live: 0, qualified: 0, behind: false });
      expect(drafts.every(d => d.plan_status === 'draft')).toBe(true);
      expect((w.body.roles as Json[]).every(r => r.plan_status !== 'draft')).toBe(true);
    }
    const w = await get(request, hr, '/api/sourcing/workspace');
    const row = (rid: string) => (w.body.roles as Json[]).find(r => r.role_id === rid)!;
    expect(Object.keys(row(p0.rid)).sort()).toEqual(['behind', 'channels_live', 'open_exceptions', 'plan_id', 'plan_status', 'priority', 'qualified', 'role_id', 'target', 'title']);
    expect(row(p0.rid)).toMatchObject({ plan_id: p0.pid, plan_status: 'active', priority: 'P0', channels_live: 1, open_exceptions: 1, target: 5, qualified: 0, behind: true });
    expect(row(p0.rid).title).toContain('WS P0');
    expect(row(p1b.rid)).toMatchObject({ channels_live: 1, open_exceptions: 0 });                // Naukri is only planned
    expect(row(p1a.rid)).toMatchObject({ channels_live: 0 });                                    // its only channel was closed: not live
    expect(row(p2.rid)).toMatchObject({ target: null, behind: false, channels_live: 0 });
    // a snoozed exception is not "open"
    const ex = (await liveExceptions(p0.pid)).find(e => e.channel === 'Agency')!;
    expect((await post(request, hr, `/api/sourcing/exceptions/${ex.id}/resolve`, { path: 'catch_up', reason: 'Brief tomorrow', snooze_until: ymd(2) })).status).toBe(200);
    expect(((await get(request, hr, '/api/sourcing/workspace')).body.roles as Json[]).find(r => r.role_id === p0.rid)!.open_exceptions).toBe(0);
  });

  // (Used to be a test.fail: getWorkspace() only read roles whose status is Approved / Live – Sourcing, but a plan is paused exactly while its role is
  // On Hold — so the 'paused' value of plan_status could never be returned and a held role vanished from the Dashboard's role filter. More cases: (p).)
  test('(h) a role that is On Hold keeps its (paused) plan in the workspace so it can still be opened', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'WS on hold', [live('LinkedIn', 5)]);
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { status: 'On Hold' })).status()).toBe(200);
    expect((await sql(`SELECT status FROM sourcing_plans WHERE id=$1::bigint`, [pid]))[0].status).toBe('paused');
    const w = await get(request, hr, '/api/sourcing/workspace');
    const row = (w.body.roles as Json[]).find(r => r.role_id === rid);
    expect(row).toMatchObject({ plan_id: pid, plan_status: 'paused' });
  });

  test('(h) a Hiring Manager sees only the roles they are named on — never a draft, never another HM\'s role — and the payload is read-only', async ({ request }) => {
    const mineA = await activeRole(request, 'WS alex', [live('LinkedIn', 5)], { hm: 'Alex', priority: 'P1' });
    const mineS = await activeRole(request, 'WS satyadev', [live('LinkedIn', 5)], { hm: 'Satyadev', priority: 'P0' });
    const both = await activeRole(request, 'WS co-HM', [live('LinkedIn', 5)], { hm: 'Alex, Satyadev', priority: 'P2' });
    const other = await activeRole(request, 'WS someone else', [live('LinkedIn', 5)], { hm: 'Nobody Special', priority: 'P1' });
    const alexDraft = await newRole({ title: 'WS alex draft', hm: 'Alex', modes: ['LinkedIn'] });
    await plan(request, alexDraft);                                                           // seeds the draft plan
    const idsOf = (b: Json, key = 'roles') => (b[key] as Json[]).map(r => r.role_id);

    const a = await get(request, alex, '/api/sourcing/workspace');
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ enabled: true, read_only: true });
    expect(idsOf(a.body)).toEqual(expect.arrayContaining([mineA.rid, both.rid]));
    expect(idsOf(a.body)).not.toContain(mineS.rid);
    expect(idsOf(a.body)).not.toContain(other.rid);
    expect(idsOf(a.body)).not.toContain(alexDraft);
    expect(a.body.drafts).toEqual([]);                                                          // a Hiring Manager never gets a draft, even their own role's
    expect(JSON.stringify(a.body)).not.toContain(alexDraft);
    expect((a.body.roles as Json[]).every(r => r.plan_status !== 'draft')).toBe(true);

    const s = await get(request, satyadev, '/api/sourcing/workspace');
    expect(s.body.read_only).toBe(true);
    expect(idsOf(s.body)).toEqual(expect.arrayContaining([mineS.rid, both.rid]));
    expect(idsOf(s.body)).not.toContain(mineA.rid);
    expect(idsOf(s.body)).not.toContain(other.rid);
    const order = idsOf(s.body).filter(id => [mineS.rid, both.rid].includes(id));
    expect(order).toEqual([mineS.rid, both.rid]);                                                // P0 before P2

    // HR-tier sees all of them
    const h = await get(request, hr, '/api/sourcing/workspace');
    expect(idsOf(h.body)).toEqual(expect.arrayContaining([mineA.rid, mineS.rid, both.rid, other.rid]));
    expect(idsOf(h.body, 'drafts')).toContain(alexDraft);
    // nobody who is not signed in, and nothing writable through this route
    expect((await request.get(`${BASE}/api/sourcing/workspace`)).status()).toBe(401);
    expect((await request.get(`${BASE}/api/sourcing/workspace`, { headers: { Authorization: 'Bearer not-a-token' } })).status()).toBe(401);
    expect((await request.post(`${BASE}/api/sourcing/workspace`, { headers: { Authorization: `Bearer ${hr}` }, data: {} })).status()).toBe(404);
  });

  // ── (j) Hiring Manager redaction of the new data ───────────────────────────────────────────────
  test('(j) the Hiring Manager gets no post link, no close reason, no history, no advice — HR gets all of them (so the check is not vacuous)', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'HM redaction', [
      { channel: 'LinkedIn', already_running: true, url: LINK_SENTINEL, weekly_target: 5 },
      { channel: 'Naukri/IIMjobs', already_running: true, url: `${POST_URL}/naukri-sentinel`, weekly_target: 5 },
      { channel: 'Direct Outreach', already_running: true, url: POST_URL, weekly_target: 3 }], { hm: 'Alex', anchors: { LinkedIn: ymd(-8) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-4)), 3);
    expect((await patchPlan(request, pid, { strategy_note: CLOSE_SENTINEL })).status).toBe(200);
    expect((await closeCh(request, pid, 'Naukri/IIMjobs', CLOSE_SENTINEL)).status).toBe(200);
    await plan(request, rid);                                                              // finishes the LinkedIn week

    const hrView = JSON.stringify(await plan(request, rid));
    expect(hrView).toContain(LINK_SENTINEL);
    expect(hrView).toContain(CLOSE_SENTINEL);

    const a = await get(request, alex, `/api/sourcing/plans/${rid}`);
    expect(a.status).toBe(200);
    expect(a.body.read_only).toBe(true);
    const raw = JSON.stringify(a.body);
    expect(raw).not.toContain('SENTINEL');
    expect(raw).not.toContain('naukri-sentinel');
    expect(raw).not.toContain('Aaron Newton');
    for (const c of a.body.channels as Json[]) {
      expect(c.tracker.link, c.channel).toBeNull();
      expect(c.closed_reason, c.channel).toBeNull();
      expect(c.config, c.channel).toEqual({});
    }
    expect(channel(a.body, 'Naukri/IIMjobs').state).toBe('closed');                         // the fact that it is closed is still visible…
    expect(channel(a.body, 'Naukri/IIMjobs').closed_reason).toBeNull();                      // …the reason is not
    expect(a.body.changes).toEqual([]);
    expect(a.body.changes_total).toBe(0);
    expect(a.body.plan.strategy_note).toBeNull();
    expect(a.body.plan.baseline).toBeNull();
    expect(a.body).not.toHaveProperty('advice');
    const adv = await get(request, alex, `/api/sourcing/plans/${rid}/advice`);
    expect(adv.status).toBe(403);
    expect(JSON.stringify(adv.body)).not.toContain('headline');
    expect((await get(request, alex, `/api/sourcing/plans/${rid}/advice?refresh=1`)).status).toBe(403);
    expect(JSON.stringify((await get(request, alex, '/api/sourcing/workspace')).body)).not.toContain('SENTINEL');
    expect(JSON.stringify((await get(request, alex, '/api/dashboard/sourcing')).body)).not.toContain('SENTINEL');
    // a Hiring Manager of ANOTHER role gets nothing for this one
    expect((await get(request, satyadev, `/api/sourcing/plans/${rid}`)).status).toBe(403);
    expect((await get(request, satyadev, `/api/sourcing/plans/${rid}/advice`)).status).toBe(403);
    // and every write the new features added is refused for a Hiring Manager (the named one included)
    for (const [what, r] of [
      ['close', await closeCh(request, pid, 'LinkedIn', 'because', alex)], ['reopen', await reopenCh(request, pid, 'Naukri/IIMjobs', alex)],
      ['settings', await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 9 }, alex)], ['target', await patchPlan(request, pid, { weekly_qualified_target: 9 }, alex)],
    ] as const) expect(r.status, what).toBe(403);
    expect((await chRow(pid, 'LinkedIn')).targets.weekly_target).toBe(5);
  });

  // ── (i) AI next steps ──────────────────────────────────────────────────────────────────────────
  // The local backend may or may not have a model key: the endpoint must ALWAYS answer, with source 'ai' or — when the model is unavailable —
  // 'rules'. Assertions therefore hold for both. Each generation can take several seconds when the model is called, hence the longer timeout.
  const advice = (request: any, rid: string, query = '', tok = hr) => get(request, tok, `/api/sourcing/plans/${rid}/advice${query}`);
  const SOURCING_CHANNEL_NAMES = ['LinkedIn', 'Naukri/IIMjobs', 'Agency', 'Internal Referral', 'Direct Outreach'];
  const advRow = async (pid: string) => (await sql(`SELECT facts_hash, source, model, advice, generated_at FROM sourcing_advice WHERE plan_id=$1::bigint`, [pid]))[0];
  const expectWellFormed = (a: Json, liveExceptionIds: string[]) => {
    expect(['ai', 'rules']).toContain(a.source);
    expect(a.model === null, 'a model is named only for AI advice').toBe(a.source === 'rules');
    expect(typeof a.stale).toBe('boolean');
    expect(a.facts_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(new Date(a.generated_at).toString()).not.toBe('Invalid Date');
    expect(typeof a.advice.headline).toBe('string');
    expect(a.advice.headline.length).toBeGreaterThan(0);
    expect(Array.isArray(a.advice.steps)).toBe(true);
    expect(a.advice.steps.length).toBeGreaterThan(0);
    expect(a.advice.steps.length).toBeLessThanOrEqual(14);
    expect(a.advice.watch.length).toBeLessThanOrEqual(2);
    expect(new Set(a.advice.steps.map((s: Json) => s.id)).size).toBe(a.advice.steps.length);
    for (const s of a.advice.steps as Json[]) {
      expect(s.title.length, 'step title').toBeGreaterThan(0);
      expect(s.detail.length, 'step detail').toBeGreaterThan(0);
      expect(s.channel === null || SOURCING_CHANNEL_NAMES.includes(s.channel), `channel ${s.channel} is one of ours or null`).toBe(true);
      expect(s.exception_id === null || liveExceptionIds.includes(s.exception_id), 'a step can only point at an exception it was given').toBe(true);
      expect(['high', 'medium', 'low']).toContain(s.impact);
      expect(['HR', 'Hiring Manager']).toContain(s.owner);
    }
    expect(JSON.stringify(a)).not.toMatch(/sp14\+|@example\.com/);                       // facts are counts, never people
  };

  test('(i) advice is HR-tier only, and exists only for an active or paused plan (null for a draft, a closed plan, or no role)', async ({ request }) => {
    const rid = await newRole({ title: 'Advice gate', modes: ['LinkedIn'] });
    const pid = (await plan(request, rid)).plan.id as string;
    expect((await advice(request, rid, '', alex)).status).toBe(403);                      // the named Hiring Manager too
    expect((await advice(request, rid, '', satyadev)).status).toBe(403);
    expect((await request.get(`${BASE}/api/sourcing/plans/${rid}/advice`)).status()).toBe(401);
    const draft = await advice(request, rid);
    expect(draft.status).toBe(200);
    expect(draft.body).toMatchObject({ enabled: true, advice: null });                       // a draft plan has nothing to advise on yet
    expect(await advRow(pid)).toBeUndefined();                                                // and nothing was cached
    const missing = await advice(request, 'R9999999');
    expect(missing.status).toBe(200);
    expect(missing.body.advice).toBeNull();
    // closed again: no advice
    expect((await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [{ channel: 'LinkedIn' }] })).status).toBe(200);
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { status: 'Closed – Filled' })).status()).toBe(200);
    expect((await advice(request, rid)).body.advice).toBeNull();
    expect(await advRow(pid)).toBeUndefined();
  });

  test('(i) advice: well-formed, cached (a second call and a refresh inside a minute do not regenerate), regenerated on request after a minute', async ({ request }) => {
    test.setTimeout(240_000);
    const { rid, pid } = await activeRole(request, 'Advice cache', [live('LinkedIn', 5), { channel: 'Agency' }], { priority: 'P1', anchors: { LinkedIn: ymd(-3) } });
    const agencyAct = commitment(await plan(request, rid), 'Agency', 'activate_channel').id as string;
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '2 days' WHERE id=$1::bigint`, [agencyAct]);
    await addApps(rid, 'LinkedIn', noon(ymd(-1)), 3);
    await cron(request);
    const exIds = (await liveExceptions(pid)).filter(e => !e.is_shadow).map(e => e.id);
    expect(exIds.length).toBeGreaterThan(0);

    expect(await advRow(pid)).toBeUndefined();
    const first = await advice(request, rid);
    expect(first.status).toBe(200);
    expect(first.body.enabled).toBe(true);
    const a1 = first.body.advice;
    expectWellFormed(a1, exIds);
    expect(a1.stale).toBe(false);
    const row = await advRow(pid);
    expect(row.facts_hash).toBe(a1.facts_hash);
    expect(new Date(row.generated_at).toISOString()).toBe(a1.generated_at);
    expect(row.source).toBe(a1.source);
    expect(row.advice.headline).toBe(a1.advice.headline);

    // served from the cache: identical, same timestamp — nothing was regenerated
    const second = (await advice(request, rid)).body.advice;
    expect(second.generated_at).toBe(a1.generated_at);
    expect(second.facts_hash).toBe(a1.facts_hash);
    expect(second.advice).toEqual(a1.advice);
    // an explicit refresh inside the 60 s cool-down is still the cached one
    for (const q of ['?refresh=1', '?refresh=true']) {
      const r = (await advice(request, rid, q)).body.advice;
      expect(r.generated_at, q).toBe(a1.generated_at);
    }
    expect(await changeCount(pid, 'weekly_result')).toBe(0);                          // asking for advice never writes plan history
    // a rule-based answer (no model available) is labelled as such and still acts on the open exception
    if (a1.source === 'rules') expect(a1.advice.steps.some((s: Json) => s.exception_id !== null)).toBe(true);

    // after the cool-down a refresh writes a new one (same facts ⇒ same hash)
    await client.query(`UPDATE sourcing_advice SET generated_at = NOW() - INTERVAL '2 minutes' WHERE plan_id=$1::bigint`, [pid]);
    const old = +new Date((await advRow(pid)).generated_at);
    const refreshed = (await advice(request, rid, '?refresh=1')).body.advice;
    expectWellFormed(refreshed, exIds);
    expect(+new Date(refreshed.generated_at)).toBeGreaterThan(old + 60_000);
    expect(+new Date(refreshed.generated_at)).toBeGreaterThan(Date.now() - 60_000);
    expect(refreshed.facts_hash).toBe(a1.facts_hash);
    expect((await sql(`SELECT count(*)::int AS n FROM sourcing_advice WHERE plan_id=$1::bigint`, [pid]))[0].n).toBe(1);    // one cached row per plan, replaced in place
  });

  test('(i) when the facts change the cached advice is shown as stale for 15 minutes, then a new one is written; the cache dies with its plan', async ({ request }) => {
    test.setTimeout(240_000);
    const { rid, pid } = await activeRole(request, 'Advice facts', [live('LinkedIn', 5)], { priority: 'P1', anchors: { LinkedIn: ymd(-3) } });
    await cron(request);
    const exIds = () => liveExceptions(pid).then(r => r.filter(e => !e.is_shadow).map(e => e.id));
    const a1 = (await advice(request, rid)).body.advice;
    expectWellFormed(a1, await exIds());
    // new applicants change the pipeline facts; inside 15 minutes the old advice is served, flagged stale, untouched
    await addApps(rid, 'LinkedIn', noon(ymd(-1)), 4);
    const stale = (await advice(request, rid)).body.advice;
    expect(stale.stale).toBe(true);
    expect(stale.generated_at).toBe(a1.generated_at);
    expect(stale.facts_hash).toBe(a1.facts_hash);                                           // it reports the hash it was written from
    expect(stale.advice).toEqual(a1.advice);
    expect((await advice(request, rid)).body.advice.stale).toBe(true);                       // and keeps saying so, without writing
    expect((await advRow(pid)).facts_hash).toBe(a1.facts_hash);
    // after 15 minutes a changed fact set is worth a new answer
    await client.query(`UPDATE sourcing_advice SET generated_at = NOW() - INTERVAL '16 minutes' WHERE plan_id=$1::bigint`, [pid]);
    const fresh = (await advice(request, rid)).body.advice;
    expectWellFormed(fresh, await exIds());
    expect(fresh.stale).toBe(false);
    expect(fresh.facts_hash).not.toBe(a1.facts_hash);
    expect(+new Date(fresh.generated_at)).toBeGreaterThan(Date.now() - 60_000);
    expect((await advRow(pid)).facts_hash).toBe(fresh.facts_hash);
    // and it is cached again
    expect((await advice(request, rid)).body.advice.generated_at).toBe(fresh.generated_at);
    // advice for a PAUSED plan is still served; the row goes away with the plan (cascade)
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { status: 'On Hold' })).status()).toBe(200);
    expect((await advice(request, rid)).body.advice).not.toBeNull();
    expect(await advRow(pid)).toBeDefined();
    await client.query(`DELETE FROM sourcing_plans WHERE id=$1::bigint`, [pid]);
    expect(await advRow(pid)).toBeUndefined();
  });

  test('(i) a rules-based answer (the model unavailable) is regenerated after 10 minutes so the model gets another try; an AI answer is not', async ({ request }) => {
    test.setTimeout(240_000);
    const { rid, pid } = await activeRole(request, 'Advice rules retry', [{ channel: 'LinkedIn' }], { priority: 'P1' });
    const a1 = (await advice(request, rid)).body.advice;
    const stampedAt = new Date(Date.now() - 11 * 60_000);
    // Pose as a rules answer written 11 minutes ago, whatever the first call produced: the same facts, so only the age + source matter.
    await client.query(`UPDATE sourcing_advice SET source='rules', model=NULL, generated_at=$2 WHERE plan_id=$1::bigint`, [pid, stampedAt]);
    const retried = (await advice(request, rid)).body.advice;
    expect(+new Date(retried.generated_at)).toBeGreaterThan(+stampedAt + 60_000);               // regenerated (the model was given another chance)
    expect(retried.facts_hash).toBe(a1.facts_hash);
    // an answer written by the model 11 minutes ago, facts unchanged, is still good (served as is for 24 h)
    await client.query(`UPDATE sourcing_advice SET source='ai', model='claude-test', generated_at=$2 WHERE plan_id=$1::bigint`, [pid, stampedAt]);
    const kept = (await advice(request, rid)).body.advice;
    expect(kept.generated_at).toBe(stampedAt.toISOString());
    expect(kept.source).toBe('ai');
    expect(kept.stale).toBe(false);
  });

  // ── (k) role On Hold / Closed and the trackers ─────────────────────────────────────────────────
  // A weekly tracker runs ONLY while its channel is live AND the plan is active. Putting the role On Hold stops every tracker: the weeks that had
  // already ended but nobody had recorded are written (with the target of the time), the week in progress is written as a cut-short week, and each
  // tracker's start is cleared — so nothing is counted, or "missed", while the role is on hold. Putting the role back on starts every live channel
  // that has a weekly target afresh from the day it is back (not shifted by the length of the hold).
  test('(k) On Hold stops the trackers (ended weeks + the week in progress are recorded, no tracker runs while paused) and resuming starts every live tracker afresh from the day the role is back', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Hold stops trackers', [live('LinkedIn', 5), live('Naukri/IIMjobs', 5), { channel: 'Direct Outreach' }, { channel: 'Agency' }],
      { anchors: { 'Naukri/IIMjobs': ymd(-12) } });
    await addApps(rid, 'Naukri/IIMjobs', noon(ymd(-6)), 2);                                            // inside Naukri's FIRST window [-12,-6] — which ends before the hold
    await plan(request, rid);                                                                          // …and is recorded now
    expect(await weekRows(pid, 'Naukri/IIMjobs')).toEqual([{ ws: ymd(-12), we: ymd(-6), target: 5, actual: 2, qualified: 0, partial: false }]);
    await setAnchor(pid, 'LinkedIn', ymd(-8));                                                         // LinkedIn's first window [-8,-2] is over too, but nobody has recorded it
    await addApps(rid, 'LinkedIn', noon(ymd(-5)), 3);
    await addApps(rid, 'LinkedIn', noon(ymd(-1)), 1, { score: 80 });                                   // the week in progress: [-1, today]
    expect(await weekRows(pid, 'LinkedIn')).toEqual([]);

    await holdRole(request, rid);
    // at the moment of the hold: the ended week is written, and so is the week in progress, as a week cut short
    expect(await weekRows(pid, 'LinkedIn')).toEqual([
      { ws: ymd(-8), we: ymd(-2), target: 5, actual: 3, qualified: 0, partial: false },
      { ws: ymd(-1), we: ymd(0), target: 5, actual: 1, qualified: 1, partial: true },
    ]);
    expect(await weekRows(pid, 'Naukri/IIMjobs')).toEqual([
      { ws: ymd(-12), we: ymd(-6), target: 5, actual: 2, qualified: 0, partial: false },               // recorded before the hold: untouched
      { ws: ymd(-5), we: ymd(0), target: 5, actual: 0, qualified: 0, partial: true },                  // its week in progress, cut short
    ]);
    for (const ch of ['LinkedIn', 'Naukri/IIMjobs', 'Direct Outreach', 'Agency']) expect((await chRow(pid, ch)).anchor, ch).toBeNull();
    let v = await plan(request, rid);
    expect(v.plan.status).toBe('paused');
    for (const ch of ['LinkedIn', 'Naukri/IIMjobs']) {
      expect(channel(v, ch).state, ch).toBe('active');                                                  // still live …
      expect(channel(v, ch).tracker, ch).toMatchObject({ applicable: true, target: 5, anchor: null, running: null });   // … but nothing runs while the role is on hold
    }
    expect(channel(v, 'LinkedIn').tracker.weeks).toHaveLength(2);
    expect(channel(v, 'LinkedIn').tracker.totals).toEqual({ weeks: 1, met: 0, actual: 3, target: 5 });  // the cut-short week is not counted
    expect(channel(v, 'Naukri/IIMjobs').tracker.totals).toEqual({ weeks: 1, met: 0, actual: 2, target: 5 });
    expect(historyOf(v, 'paused')).toHaveLength(1);
    expect(historyOf(v, 'paused')[0]).toMatchObject({ by_name: null, category: 'plan' });
    // nothing is measured while paused, whatever arrives and however often the engine or a reader looks
    await addApps(rid, 'LinkedIn', noon(ymd(0)), 2);
    await addApps(rid, 'Naukri/IIMjobs', noon(ymd(0)), 2);
    await cron(request); await plan(request, rid);
    expect(await weekRows(pid, 'LinkedIn')).toHaveLength(2);
    expect(await weekRows(pid, 'Naukri/IIMjobs')).toHaveLength(2);
    expect(channel(await plan(request, rid), 'LinkedIn').tracker.running).toBeNull();

    // the hold lasted 5 days: the plan was paused 5 days ago and so was every week recorded at that time
    await backdateHold(pid, 5);
    await resumeRole(request, rid);
    const p = await planRow(pid);
    expect(p.status).toBe('active');
    expect(p.paused_at).toBeNull();
    expect(p.pause_total_days).toBe(5);
    // every live channel with a weekly target starts afresh TODAY — not shifted by the 5 days; a channel with no tracker stays without one
    expect((await chRow(pid, 'LinkedIn')).anchor).toBe(ymd(0));
    expect((await chRow(pid, 'Naukri/IIMjobs')).anchor).toBe(ymd(0));
    expect((await chRow(pid, 'Direct Outreach')).anchor).toBeNull();                                    // never logged: no tracker to start
    expect((await chRow(pid, 'Agency')).anchor).toBeNull();
    v = await plan(request, rid);
    expect(v.plan.status).toBe('active');
    expect(channel(v, 'LinkedIn').tracker).toMatchObject({ anchor: ymd(0), target: 5 });
    // the running week starts today and counts what arrived today; the applicants of the hold itself (dated before today) are in no week
    expect(channel(v, 'LinkedIn').tracker.running).toEqual({ start: ymd(0), end: ymd(6), actual: 2, qualified: 0, target: 5 });
    expect(channel(v, 'Naukri/IIMjobs').tracker.running).toEqual({ start: ymd(0), end: ymd(6), actual: 2, qualified: 0, target: 5 });
    expect(channel(v, 'Direct Outreach').tracker).toMatchObject({ applicable: true, target: null, anchor: null, running: null });
    // the weeks recorded at the hold are kept as they were, and the restart did not write anything
    expect(await weekRows(pid, 'LinkedIn')).toHaveLength(2);
    expect(await weekRows(pid, 'Naukri/IIMjobs')).toHaveLength(2);
    expect(historyOf(v, 'resumed')[0]).toMatchObject({ by_name: null, category: 'plan' });
    expect(historyOf(v, 'resumed')[0].change.paused_days).toBe(5);
    expect(historyOf(v, 'resumed')[0].text).toBe('Plan resumed after 5 days on hold');
    expect(await changeCount(pid, 'weekly_result')).toBe(4);                                             // 2 ended + 2 cut short, written once each
  });

  // Resuming used to shift every tracker's start by Math.ceil(days held), so ANY hold — even seconds, a role put On Hold by mistake — moved a
  // tracker a whole day and dropped that day's applicants. Now the hold records the week in progress as cut short (those applicants are in it)
  // and the tracker restarts the day the role is back. When the role comes back on the day it was stopped, the cut-short week already covers
  // today, so the running week starts tomorrow (the same rule as Reopen channel on the day of a close).
  test('(k) a hold that lasts a few seconds loses no applications: the cut-short week keeps them and the tracker restarts — counting from tomorrow when the role is back the same day', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Hold blip', [live('LinkedIn', 5)], { anchors: { LinkedIn: ymd(-3) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-3)), 2);                                                   // on the first day of the running window
    expect(channel(await plan(request, rid), 'LinkedIn').tracker.running.actual).toBe(2);
    await holdRole(request, rid);
    await resumeRole(request, rid);
    // the two applicants are in the week that was cut short — nothing was lost, nothing moved a day
    expect(await weekRows(pid, 'LinkedIn')).toEqual([{ ws: ymd(-3), we: ymd(0), target: 5, actual: 2, qualified: 0, partial: true }]);
    const p = await planRow(pid);
    expect(p.status).toBe('active');
    expect(p.pause_total_days).toBe(0);                                                                 // a hold of seconds is 0 days, not 1
    let v = await plan(request, rid);
    expect(historyOf(v, 'resumed')[0].change.paused_days).toBe(0);
    expect(historyOf(v, 'resumed')[0].text).toBe('Plan resumed');
    expect((await chRow(pid, 'LinkedIn')).anchor).toBe(ymd(0));                                          // restarted today …
    expect(channel(v, 'LinkedIn').tracker).toMatchObject({ anchor: ymd(1), target: 5, running: null });  // … but the cut-short week covers today, so the view's start is tomorrow and no week runs yet
    expect(channel(v, 'LinkedIn').tracker.totals).toEqual({ weeks: 0, met: 0, actual: 0, target: 0 });
    expect(await weekRows(pid, 'LinkedIn')).toHaveLength(1);                                            // and no week was invented
    // a day later (shift the recorded week and the start back one day): the running week begins TODAY, the day after the cut-short week
    await client.query(`UPDATE sourcing_channel_weeks SET week_start = week_start - 1, week_end = week_end - 1 WHERE plan_channel_id = $1::bigint`, [(await chRow(pid, 'LinkedIn')).id]);
    await setAnchor(pid, 'LinkedIn', ymd(-1));
    await addApps(rid, 'LinkedIn', noon(ymd(-1)), 3);                                                   // the cut-short week's last day: already covered
    await addApps(rid, 'LinkedIn', noon(ymd(0)), 1);
    v = await plan(request, rid);
    expect(channel(v, 'LinkedIn').tracker.running).toEqual({ start: ymd(0), end: ymd(6), actual: 1, qualified: 0, target: 5 });
    expect(await weekRows(pid, 'LinkedIn')).toHaveLength(1);                                            // still no phantom week
  });

  test('(k) a week that had already ended when the role was put On Hold is recorded at the hold (with the target of the time) — not lost, not recorded twice', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Hold keeps a week', [live('LinkedIn', 5)], { anchors: { LinkedIn: ymd(-9) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-5)), 4, { score: 70 });                                    // window [-9,-3] has ended; nobody has looked since
    await addApps(rid, 'LinkedIn', noon(ymd(-1)), 1);
    expect(await weekRows(pid, 'LinkedIn')).toEqual([]);
    await holdRole(request, rid);
    expect(await weekRows(pid, 'LinkedIn')).toEqual([
      { ws: ymd(-9), we: ymd(-3), target: 5, actual: 4, qualified: 4, partial: false },
      { ws: ymd(-2), we: ymd(0), target: 5, actual: 1, qualified: 0, partial: true },
    ]);
    const held = await plan(request, rid);
    const ended = (await weeklyEntries(held)).find(h => h.change.partial === false)!;
    expect(ended.change).toMatchObject({ channel: 'LinkedIn', week_start: ymd(-9), week_end: ymd(-3), target: 5, actual: 4, qualified: 4, met: false });
    expect(new Date(ended.at).getTime()).toBe(new Date(`${ymd(-3)}T23:59:59.999+05:30`).getTime());   // stamped with the day the week ended, not the day of the hold
    await resumeRole(request, rid);
    await plan(request, rid); await cron(request);
    expect(await weekRows(pid, 'LinkedIn')).toHaveLength(2);                                            // nothing lost, nothing duplicated
    expect(await changeCount(pid, 'weekly_result')).toBe(2);
    expect(channel(await plan(request, rid), 'LinkedIn').tracker.totals).toEqual({ weeks: 1, met: 0, actual: 4, target: 5 });
  });

  // completeInTx stamps tracker_anchor = TODAY on any plan; while the plan is paused the view shows no tracker and resuming resets the start of every
  // live channel that has a target to the day the role is back — so a post logged during the hold is measured from that day, neither from the day it
  // was logged nor a whole hold later.
  test('(k) a post logged while the role is On Hold starts being measured when the role is back on — from that day, not the day it was logged and not a whole hold later', async ({ request }) => {
    const rid = await newRole({ title: 'Log while on hold', modes: ['Direct Outreach'] });
    const pid = (await plan(request, rid)).plan.id as string;
    expect((await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [{ channel: 'Direct Outreach' }] })).status).toBe(200);
    const act = commitment(await plan(request, rid), 'Direct Outreach', 'activate_channel').id as string;
    await holdRole(request, rid);
    await backdateHold(pid, 5);                                                                          // the role has been on hold for 5 days
    expect((await post(request, hr, `/api/sourcing/commitments/${act}/complete`, { url: POST_URL, weekly_target: 5 })).status).toBe(200);     // allowed on a paused plan
    const held = channel(await plan(request, rid), 'Direct Outreach');
    expect(held.state).toBe('active');
    expect(held.tracker).toMatchObject({ target: 5, anchor: null, running: null });                      // nothing is measured while the plan is paused
    await addApps(rid, 'Direct Outreach', noon(ymd(-1)), 2);                                             // arrives during the hold: in no week
    await resumeRole(request, rid);
    expect((await chRow(pid, 'Direct Outreach')).anchor).toBe(ymd(0));                                   // exactly today: not pushed a hold later (the old behaviour: today + 5)
    await addApps(rid, 'Direct Outreach', noon(ymd(0)), 1);
    const v = await plan(request, rid);
    expect(channel(v, 'Direct Outreach').tracker).toMatchObject({ anchor: ymd(0), target: 5 });
    expect(channel(v, 'Direct Outreach').tracker.running).toEqual({ start: ymd(0), end: ymd(6), actual: 1, qualified: 0, target: 5 });
    expect(await weekRows(pid, 'Direct Outreach')).toEqual([]);
  });

  test('(k) role Closed: the finished weeks are recorded with their targets, the week in progress as a partial week with ITS applicants, trackers stop; reopening keeps every week', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Role closes', [live('LinkedIn', 5), live('Direct Outreach', 2), { channel: 'Agency' }], { anchors: { LinkedIn: ymd(-8), 'Direct Outreach': ymd(-3) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-5)), 5);                                                   // [-8,-2] finished, unrecorded: 5 of 5
    await addApps(rid, 'LinkedIn', noon(ymd(0)), 1, { score: 80 });                                      // the week in progress
    await addApps(rid, 'Direct Outreach', noon(ymd(-1)), 3);
    await addApps(rid, 'Naukri/IIMjobs', noon(ymd(-1)), 2);                                              // another channel: never counted
    expect(await weekRows(pid, 'LinkedIn')).toEqual([]);
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { status: 'Closed – Filled' })).status()).toBe(200);

    expect(await weekRows(pid, 'LinkedIn')).toEqual([
      { ws: ymd(-8), we: ymd(-2), target: 5, actual: 5, qualified: 0, partial: false },
      { ws: ymd(-1), we: ymd(0), target: 5, actual: 1, qualified: 1, partial: true },                   // cut short, and it counts the channel's own applicants
    ]);
    expect(await weekRows(pid, 'Direct Outreach')).toEqual([{ ws: ymd(-3), we: ymd(0), target: 2, actual: 3, qualified: 0, partial: true }]);
    for (const ch of ['LinkedIn', 'Direct Outreach', 'Agency']) expect((await chRow(pid, ch)).anchor, ch).toBeNull();
    let v = await plan(request, rid);
    expect(v.plan.status).toBe('closed');
    expect(channel(v, 'LinkedIn').tracker).toMatchObject({ anchor: null, running: null, target: 5 });
    expect(channel(v, 'LinkedIn').tracker.weeks).toHaveLength(2);
    expect(channel(v, 'LinkedIn').tracker.totals).toEqual({ weeks: 1, met: 1, actual: 5, target: 5 });      // the week cut short is listed but never counted
    const wr = historyOf(v, 'weekly_result');
    expect(wr).toHaveLength(3);
    expect(wr.every(h => h.by_name === null)).toBe(true);
    expect(wr.filter(h => h.change.partial === true).map(h => h.change.channel).sort()).toEqual(['Direct Outreach', 'LinkedIn']);     // the partial entries name their channel
    // nothing more is ever written for a closed plan
    await cron(request); await plan(request, rid);
    expect(await weekRows(pid, 'LinkedIn')).toHaveLength(2);
    expect(await changeCount(pid, 'weekly_result')).toBe(3);

    // reopened: a draft until re-activated; nothing is measured; the weeks already recorded stay and are not duplicated
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { status: 'Live – Sourcing' })).status()).toBe(200);
    v = await plan(request, rid);
    expect(v.plan.status).toBe('draft');
    expect(channel(v, 'LinkedIn').tracker.weeks).toHaveLength(2);
    expect(channel(v, 'LinkedIn').tracker.anchor).toBeNull();
    expect(await weekRows(pid, 'LinkedIn')).toHaveLength(2);
    const re = await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [live('LinkedIn', 4)] });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    v = await plan(request, rid);
    expect((await chRow(pid, 'LinkedIn')).anchor).toBe(ymd(0));                                          // the tracker starts again today …
    expect(channel(v, 'LinkedIn').tracker).toMatchObject({ target: 4, anchor: ymd(1), running: null });  // … and the view's start is tomorrow: the week cut short today covers today
    expect(channel(v, 'LinkedIn').tracker.weeks).toHaveLength(2);                                       // the old target stays on the old weeks
    expect(channel(v, 'LinkedIn').tracker.weeks.map((w: Json) => w.target)).toEqual([5, 5]);
    // the restarted tracker never overlaps the week that was cut short today
    const t = channel(v, 'LinkedIn').tracker;
    if (t.running) expect(t.running.start > t.weeks[0].week_end).toBe(true);
  });

  // ── (l) attribution: the form's "Sourcing Channel" answer ──────────────────────────────────────
  // The Apps Script forwards the answer as source_tag. Each ingest runs ResumeIQ scoring synchronously (a model call), so this test makes one
  // modest batch, in parallel, and asserts attribution only — never scores.
  test('(l) source_tag aliases land in applications.sub_source under the canonical channel names — and feed the tracker and "Applications by Source"', async ({ request }) => {
    test.setTimeout(240_000);
    const { rid, pid } = await activeRole(request, 'Ingest aliases', [live('Naukri/IIMjobs', 3), live('LinkedIn', 5)], { hm: 'Someone Else' });
    const title = (await sql(`SELECT title FROM roles WHERE id=$1`, [rid]))[0].title as string;
    // Each ingest runs ResumeIQ (a model call), so the batch stays at 17 — the alias table itself is unit-tested exhaustively (sourcingConfig.test.ts); here is the wiring:
    // the form's five REAL options, a few spellings, names that are properties of every JavaScript object, and values that are not text at all.
    const cases: Array<[unknown, string]> = [
      ['Linkedin', 'LinkedIn'], ['Naukri/IIMJobs', 'Naukri/IIMjobs'], ['DigitalPaani HR Outreach', 'Direct Outreach'], ['Hiring Agency', 'Agency'], ['DigitalPaani Employee Referral', 'Internal Referral'],
      ['Naukri', 'Naukri/IIMjobs'], ['  Naukri / IIMjobs  ', 'Naukri/IIMjobs'], ['Cold Outreach', 'Direct Outreach'], ['Recruitment Agency', 'Agency'],
      ['Facebook', 'Other'], ['<b>Instagram</b>', 'Other'], ['constructor', 'Other'], ['__proto__', 'Other'],
      ['', 'untagged_default'], [5, 'untagged_default'], [['LinkedIn'], 'untagged_default'], [undefined, 'untagged_default'],
    ];
    const ingest = async ([tag, want]: [unknown, string], i: number) => {
      const email = `sp14ing+${uid()}${i}@example.com`;
      const r = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
        data: { email, full_name: 'Alias Tester', role_applied_for: title, ...(tag === undefined ? {} : { source_tag: tag }) },
      });
      expect(r.status(), `source_tag ${JSON.stringify(tag)}`).toBeLessThan(300);
      const row = (await sql(`SELECT a.sub_source FROM applications a JOIN candidates c ON c.id=a.candidate_id WHERE c.email=$1 AND a.role_id=$2`, [email, rid]))[0];
      expect(row?.sub_source, `source_tag ${JSON.stringify(tag)} -> ${want}`).toBe(want);
    };
    for (let i = 0; i < cases.length; i += 6) await Promise.all(cases.slice(i, i + 6).map((c, k) => ingest(c, i + k)));

    // everything applied TODAY, so it is in the running week of the channel it named; "Applications by Source" carries the same counts
    const v = await plan(request, rid);
    const count = (want: string) => cases.filter(c => c[1] === want).length;
    expect(channel(v, 'Naukri/IIMjobs').tracker.running).toMatchObject({ start: ymd(0), actual: count('Naukri/IIMjobs'), target: 3 });
    expect(channel(v, 'LinkedIn').tracker.running).toMatchObject({ start: ymd(0), actual: count('LinkedIn'), target: 5 });
    const tags = Object.fromEntries((v.output as Json[]).map(o => [o.tag, o.applications]));
    for (const want of ['Naukri/IIMjobs', 'LinkedIn', 'Internal Referral', 'Agency', 'Direct Outreach', 'Other', 'untagged_default']) expect(tags[want], want).toBe(count(want));
    expect(channel(v, 'Naukri/IIMjobs').tracker.sourced.applications).toBe(count('Naukri/IIMjobs'));
    expect(pid).toBeTruthy();
  });


  // ── (d) leaving a channel out, and bringing it back ────────────────────────────────────────────
  // (Used to be a test.fail: leaving a channel out only flipped its state and left tracker_anchor set, so putting it back made the next read record
  // a "missed" week for every week it had been out, and show a running week against the old target while its first task was open again.)
  test('(d) leaving a channel out and bringing it back does not record phantom missed weeks for the time it was out', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Left out and back', [live('LinkedIn', 5)], { anchors: { LinkedIn: ymd(-9) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-5)), 4);
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'LinkedIn', state: 'excluded', excluded_reason: 'Paused for a month' })).status).toBe(200);
    // what it produced while it was live is recorded at the moment it is left out …
    const kept = [
      { ws: ymd(-9), we: ymd(-3), target: 5, actual: 4, qualified: 0, partial: false },
      { ws: ymd(-2), we: ymd(0), target: 5, actual: 0, qualified: 0, partial: true },
    ];
    expect(await weekRows(pid, 'LinkedIn')).toEqual(kept);
    expect((await chRow(pid, 'LinkedIn')).anchor).toBeNull();
    // … then a month goes by (everything recorded is a month older) and the channel is put back
    await client.query(`UPDATE sourcing_channel_weeks SET week_start = week_start - 30, week_end = week_end - 30 WHERE plan_channel_id = $1::bigint`, [(await chRow(pid, 'LinkedIn')).id]);
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'LinkedIn', state: 'planned' })).status).toBe(200);
    let t = channel(await plan(request, rid), 'LinkedIn').tracker;
    await cron(request);
    const older = kept.map(k => ({ ...k, ws: dayPlus(k.ws, -30), we: dayPlus(k.we, -30) }));
    expect(await weekRows(pid, 'LinkedIn')).toEqual(older);                                            // nothing was invented for the month it was out
    expect(t.weeks.map((w: Json) => w.week_start)).toEqual([older[1].ws, older[0].ws]);
    expect(t.anchor).toBeNull();
    expect(t.running).toBeNull();                                                                       // and no running week until its first task is logged again
    // logging the post again starts a fresh tracker today
    const again = await post(request, hr, `/api/sourcing/commitments/${await commitmentId(pid, 'LinkedIn', 'activate_channel')}/complete`, { url: POST_URL, weekly_target: 5 });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    t = channel(await plan(request, rid), 'LinkedIn').tracker;
    expect(t.anchor).toBe(ymd(0));
    expect(t.running).toEqual({ start: ymd(0), end: ymd(6), actual: 0, qualified: 0, target: 5 });
    expect(await weekRows(pid, 'LinkedIn')).toEqual(older);
    expect(t.totals).toEqual({ weeks: 1, met: 0, actual: 4, target: 5 });
  });

  // ── (m) a week cut short is never counted ──────────────────────────────────────────────────────
  test('(m) a week cut short is listed but never counted — not as a tracked week, not as met (even above its target), not as missed — in the totals or in the close entry', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Cut short not counted', [live('LinkedIn', 2)], { anchors: { LinkedIn: ymd(-3) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-2)), 3, { score: 80 });                                    // 3 against a target of 2 …
    expect((await closeCh(request, pid, 'LinkedIn')).status).toBe(200);                                  // … in a week that never finished
    expect(await weekRows(pid, 'LinkedIn')).toEqual([{ ws: ymd(-3), we: ymd(0), target: 2, actual: 3, qualified: 3, partial: true }]);
    const v = await plan(request, rid);
    const t = channel(v, 'LinkedIn').tracker;
    expect(t.weeks).toHaveLength(1);
    expect(t.weeks[0]).toMatchObject({ week_start: ymd(-3), week_end: ymd(0), actual: 3, target: 2, partial: true });
    expect(t.totals).toEqual({ weeks: 0, met: 0, actual: 0, target: 0 });
    const closed = historyOf(v, 'channel_closed')[0];
    expect(closed.change).toMatchObject({ weeks: 0, weeks_met: 0 });
    expect(closed.text).toBe('LinkedIn: Channel closed');                                               // no "after 0 tracked weeks"
    const w = (await weeklyEntries(v))[0];
    expect(w.change).toMatchObject({ partial: true, actual: 3, target: 2 });
    expect(w.text).toContain('3 of 2 applicants');
    expect(w.text).toContain(PARTIAL_TEXT);
    expect(w.text).not.toMatch(/target (met|missed)/);
  });

  test('(m) stopping on the LAST day of a week is still a week cut short — that day has not ended, so it is not recorded as a finished week', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Cut short on the last day', [live('LinkedIn', 2)], { anchors: { LinkedIn: ymd(-6) } });   // window [-6, today]: today is its last day
    await addApps(rid, 'LinkedIn', noon(ymd(-3)), 3);
    // reading the plan does not finish the week — today has not ended
    expect(channel(await plan(request, rid), 'LinkedIn').tracker.running).toEqual({ start: ymd(-6), end: ymd(0), actual: 3, qualified: 0, target: 2 });
    expect(await weekRows(pid, 'LinkedIn')).toEqual([]);
    expect((await closeCh(request, pid, 'LinkedIn')).status).toBe(200);
    expect(await weekRows(pid, 'LinkedIn')).toEqual([{ ws: ymd(-6), we: ymd(0), target: 2, actual: 3, qualified: 0, partial: true }]);   // partial, although it spans the whole window
    const v = await plan(request, rid);
    expect(channel(v, 'LinkedIn').tracker.totals).toEqual({ weeks: 0, met: 0, actual: 0, target: 0 });              // 3 of 2 is not counted as met
    expect(historyOf(v, 'channel_closed')[0].change).toMatchObject({ weeks: 0, weeks_met: 0 });
    expect((await weeklyEntries(v))[0].change).toMatchObject({ partial: true, week_start: ymd(-6), week_end: ymd(0) });
    expect((await weeklyEntries(v))[0].text).toContain(PARTIAL_TEXT);
  });

  test('(m) a stop on the first day of a tracker that has seen no applicant writes no row at all (it can start again the same day); with applicants it writes a one-day cut-short week', async ({ request }) => {
    // Close channel, nothing arrived
    const a = await activeRole(request, 'Stop day one empty', [live('LinkedIn', 4)]);                    // the activation starts the tracker TODAY
    expect((await chRow(a.pid, 'LinkedIn')).anchor).toBe(ymd(0));
    expect((await closeCh(request, a.pid, 'LinkedIn')).status).toBe(200);
    expect(await weekRows(a.pid, 'LinkedIn')).toEqual([]);
    expect(await changeCount(a.pid, 'weekly_result')).toBe(0);
    expect((await chRow(a.pid, 'LinkedIn')).anchor).toBeNull();
    expect(historyOf(await plan(request, a.rid), 'channel_closed')[0].change).toMatchObject({ weeks: 0, weeks_met: 0 });
    // reopened the same day: there is no week to step over, so the running week starts TODAY
    expect((await reopenCh(request, a.pid, 'LinkedIn')).status).toBe(200);
    expect(channel(await plan(request, a.rid), 'LinkedIn').tracker.running).toEqual({ start: ymd(0), end: ymd(6), actual: 0, qualified: 0, target: 4 });

    // the role put On Hold on day one, nothing arrived: no row either, and the running week starts today again when the role is back
    const b = await activeRole(request, 'Hold day one empty', [live('Naukri/IIMjobs', 4)]);
    await holdRole(request, b.rid);
    expect(await weekRows(b.pid, 'Naukri/IIMjobs')).toEqual([]);
    expect(await changeCount(b.pid, 'weekly_result')).toBe(0);
    expect((await chRow(b.pid, 'Naukri/IIMjobs')).anchor).toBeNull();
    await resumeRole(request, b.rid);
    expect(channel(await plan(request, b.rid), 'Naukri/IIMjobs').tracker.running).toEqual({ start: ymd(0), end: ymd(6), actual: 0, qualified: 0, target: 4 });

    // with applicants on that day: a one-day cut-short week
    const c = await activeRole(request, 'Stop day one applicants', [live('Naukri/IIMjobs', 3)]);
    await addApps(c.rid, 'Naukri/IIMjobs', noon(ymd(0)), 2, { score: 75 });
    expect((await put(request, hr, `/api/sourcing/plans/${c.pid}/channel`, { channel: 'Naukri/IIMjobs', state: 'excluded', excluded_reason: 'Not using the portal today' })).status).toBe(200);
    expect(await weekRows(c.pid, 'Naukri/IIMjobs')).toEqual([{ ws: ymd(0), we: ymd(0), target: 3, actual: 2, qualified: 2, partial: true }]);
    expect(await changeCount(c.pid, 'weekly_result')).toBe(1);
  });

  // ── (n) every path that stops a live tracker ───────────────────────────────────────────────────
  // The same stop everywhere: the weeks that had already ended but were not yet written, then the week in progress as a week cut short, and the
  // tracker's start cleared. Putting the channel back must invent nothing for the time it was out, and nothing runs until its first task is
  // logged again. The fixture must reach each stop WITHOUT any plan read or engine run (those would write the ended week early).
  const stopFixture = async (request: any, title: string) => {
    const f = await activeRole(request, title, [live('LinkedIn', 5), { channel: 'Agency' }], { anchors: { LinkedIn: ymd(-9) } });
    await addApps(f.rid, 'LinkedIn', noon(ymd(-5)), 3, { score: 80 });                                  // the window [-9,-3] has ended; nobody has recorded it
    await addApps(f.rid, 'LinkedIn', noon(ymd(-4)), 1);
    await addApps(f.rid, 'LinkedIn', noon(ymd(-1)), 2);                                                  // the week in progress: [-2, today]
    await addApps(f.rid, 'LinkedIn', noon(ymd(0)), 1, { score: 90 });
    expect(await weekRows(f.pid, 'LinkedIn')).toEqual([]);
    return f;
  };
  const recorded = () => [
    { ws: ymd(-9), we: ymd(-3), target: 5, actual: 4, qualified: 3, partial: false },
    { ws: ymd(-2), we: ymd(0), target: 5, actual: 3, qualified: 1, partial: true },
  ];
  const expectStopped = async (pid: string, label: string) => {
    expect(await weekRows(pid, 'LinkedIn'), label).toEqual(recorded());
    const ch = await chRow(pid, 'LinkedIn');
    expect(ch.anchor, label).toBeNull();
    expect(ch.targets.weekly_target, label).toBe(5);                                                     // the target is kept for when it is back
    const h = await sql(`SELECT change FROM sourcing_plan_changes WHERE plan_id=$1::bigint AND change->>'type'='weekly_result' AND change->>'channel'='LinkedIn' ORDER BY change->>'week_start'`, [pid]);
    expect(h.map(x => x.change.partial), label).toEqual([false, true]);
    expect(h.map(x => x.change.actual), label).toEqual([4, 3]);
  };
  /** Reading the plan, running the engine, and anything else routine invents nothing for the time the channel is out. */
  const expectNothingInvented = async (request: any, f: { rid: string; pid: string }, label: string) => {
    await plan(request, f.rid); await cron(request);
    expect(await weekRows(f.pid, 'LinkedIn'), label).toEqual(recorded());
    expect(await changeCount(f.pid, 'weekly_result'), label).toBe(2);
    const t = channel(await plan(request, f.rid), 'LinkedIn').tracker;
    expect(t.anchor, label).toBeNull();
    expect(t.running, label).toBeNull();
    expect(t.weeks, label).toHaveLength(2);
  };
  const logAgain = async (request: any, f: { pid: string }) => {
    const r = await post(request, hr, `/api/sourcing/commitments/${await commitmentId(f.pid, 'LinkedIn', 'activate_channel')}/complete`, { url: POST_URL, weekly_target: 5 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  /** Live again: the stored start is today; the week cut short covers today, so the view's start (and the running week) is tomorrow; the same two weeks, nothing more. */
  const expectRestarted = async (request: any, f: { rid: string; pid: string }, label: string) => {
    expect((await chRow(f.pid, 'LinkedIn')).anchor, label).toBe(ymd(0));
    const t = channel(await plan(request, f.rid), 'LinkedIn').tracker;
    expect(t.anchor, label).toBe(ymd(1));                                                                // the view's start: the day after the week that was cut short (today)
    expect(t.running, label).toBeNull();
    expect(t.totals, label).toEqual({ weeks: 1, met: 0, actual: 4, target: 5 });
    expect(await weekRows(f.pid, 'LinkedIn'), label).toEqual(recorded());
  };

  test('(n) Close channel records the ended week and the week in progress; Reopen restarts the tracker today and invents nothing', async ({ request }) => {
    const f = await stopFixture(request, 'Stop by closing');
    expect((await closeCh(request, f.pid, 'LinkedIn', 'Closing LinkedIn for now')).status).toBe(200);
    await expectStopped(f.pid, 'closed');
    expect(await chRow(f.pid, 'LinkedIn')).toMatchObject({ state: 'excluded', closed_reason: 'Closing LinkedIn for now' });
    await expectNothingInvented(request, f, 'closed, read and swept');
    expect((await reopenCh(request, f.pid, 'LinkedIn')).status).toBe(200);
    await expectRestarted(request, f, 'reopened');
  });

  test('(n) leaving a channel out records the ended week and the week in progress, clears the start — and putting it back invents nothing until the first task is logged again', async ({ request }) => {
    const f = await stopFixture(request, 'Stop by leaving out');
    expect((await put(request, hr, `/api/sourcing/plans/${f.pid}/channel`, { channel: 'LinkedIn', state: 'excluded', excluded_reason: 'Not using LinkedIn for a while' })).status).toBe(200);
    await expectStopped(f.pid, 'left out');
    expect(await chRow(f.pid, 'LinkedIn')).toMatchObject({ state: 'excluded', excluded_reason: 'Not using LinkedIn for a while', closed_at: null });
    expect((await put(request, hr, `/api/sourcing/plans/${f.pid}/channel`, { channel: 'LinkedIn', state: 'planned' })).status).toBe(200);
    expect((await chRow(f.pid, 'LinkedIn')).state).toBe('planned');
    await expectNothingInvented(request, f, 'put back');
    await logAgain(request, f);
    await expectRestarted(request, f, 'logged again');
  });

  test('(n) a change of strategy that drops the channel records the ended week and the week in progress, clears the start, and putting it back invents nothing', async ({ request }) => {
    const f = await stopFixture(request, 'Stop by strategy change');
    const exId = await makeException(f.pid, 'LinkedIn');                                                // (a made one: the engine must not run before the stop)
    const r = await post(request, hr, `/api/sourcing/exceptions/${exId}/resolve`, { path: 'change_strategy', reason: 'LinkedIn is not producing for this role', exclude_channel: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await expectStopped(f.pid, 'strategy');
    // dropping the channel while resolving CLOSES it (stored as 'excluded' + closed_at; the resolution reason is the close reason): it is not "left out"
    const ch = await chRow(f.pid, 'LinkedIn');
    expect(ch).toMatchObject({ state: 'excluded', excluded_reason: null, closed_reason: 'LinkedIn is not producing for this role' });
    expect(ch.closed_at).not.toBeNull();
    expect((await sql(`SELECT status, resolution_path FROM sourcing_exceptions WHERE id=$1::bigint`, [exId]))[0]).toMatchObject({ status: 'resolved', resolution_path: 'change_strategy' });
    await expectNothingInvented(request, f, 'closed by a change of strategy, read and swept');
    // "adding it back" is refused with a pointer to Reopen — and Reopen restarts the tracker today without inventing a week
    const add = await put(request, hr, `/api/sourcing/plans/${f.pid}/channel`, { channel: 'LinkedIn', state: 'planned' });
    expect(add.status).toBe(409);
    expect(String(add.body.error)).toMatch(/reopen it instead/i);
    expect((await reopenCh(request, f.pid, 'LinkedIn')).status).toBe(200);
    await expectRestarted(request, f, 'reopened');
  });

  test('(n) a channel taken off the role\'s Recruitment Mode records the ended week and the week in progress, clears the start, and putting it back invents nothing', async ({ request }) => {
    const f = await stopFixture(request, 'Stop by mode removal');
    expect((await authed(request, hr).patch(`/api/roles/${f.rid}`, { recruitment_mode: ['Agency'] })).status()).toBe(200);
    await expectStopped(f.pid, 'removed from the role');
    expect(await chRow(f.pid, 'LinkedIn')).toMatchObject({ state: 'excluded', excluded_reason: 'Removed from the role’s Recruitment Mode', closed_at: null });
    expect(await changeCount(f.pid, 'channels_removed_on_role')).toBe(1);
    expect((await authed(request, hr).patch(`/api/roles/${f.rid}`, { recruitment_mode: ['LinkedIn', 'Agency'] })).status()).toBe(200);
    expect((await chRow(f.pid, 'LinkedIn')).state).toBe('planned');
    await expectNothingInvented(request, f, 'put back on the role');
    await logAgain(request, f);
    await expectRestarted(request, f, 'logged again');
  });

  test('(n) re-opening a done first task records the ended week and the week in progress, takes the channel back to "planned", and nothing runs until the task is done again', async ({ request }) => {
    const f = await stopFixture(request, 'Stop by reopening the task');
    const id = await commitmentId(f.pid, 'LinkedIn', 'activate_channel');
    expect((await commitmentRow(id)).status).toBe('done');
    expect((await post(request, hr, `/api/sourcing/commitments/${id}/reopen`)).status).toBe(200);
    await expectStopped(f.pid, 'task reopened');
    expect(await chRow(f.pid, 'LinkedIn')).toMatchObject({ state: 'planned' });
    expect((await commitmentRow(id)).status).toBe('open');
    await expectNothingInvented(request, f, 'task reopened, read and swept');
    expect((await post(request, hr, `/api/sourcing/commitments/${id}/complete`, {})).status).toBe(400);   // the link and the target are asked for again
    expect((await chRow(f.pid, 'LinkedIn')).anchor).toBeNull();
    await logAgain(request, f);
    await expectRestarted(request, f, 'task done again');
  });

  test('(n) closing the role records the ended week and the week in progress, clears the start; reopening the role and re-activating invents nothing', async ({ request }) => {
    const f = await stopFixture(request, 'Stop by closing the role');
    await setRoleStatus(request, f.rid, 'Closed – Filled');
    expect((await planRow(f.pid)).status).toBe('closed');
    await expectStopped(f.pid, 'role closed');
    await expectNothingInvented(request, f, 'role closed, read and swept');                              // nothing more is ever written for a closed plan
    await setRoleStatus(request, f.rid, 'Live – Sourcing');
    expect((await planRow(f.pid)).status).toBe('draft');
    await expectNothingInvented(request, f, 'role back, plan still a draft');
    const re = await post(request, hr, `/api/sourcing/plans/${f.pid}/activate`, { channels: [live('LinkedIn', 5), { channel: 'Agency' }] });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    await expectRestarted(request, f, 're-activated');
  });

  test('(n) putting the role On Hold records the ended week and the week in progress, clears the start; the role coming back the same day restarts it and invents nothing', async ({ request }) => {
    const f = await stopFixture(request, 'Stop by hold');
    await holdRole(request, f.rid);
    expect((await planRow(f.pid)).status).toBe('paused');
    await expectStopped(f.pid, 'on hold');
    await expectNothingInvented(request, f, 'on hold, read and swept');
    await resumeRole(request, f.rid);
    await expectRestarted(request, f, 'back on');
  });

  test('(n) "change strategy → drop the channel" on a channel that is already CLOSED leaves it closed — with its own reason, weeks and tasks — and it can still be reopened', async ({ request }) => {
    const f = await stopFixture(request, 'Strategy on a closed channel');
    expect((await closeCh(request, f.pid, 'LinkedIn', 'Closed on purpose')).status).toBe(200);
    const renewId = await commitmentId(f.pid, 'LinkedIn', 'renew_posting');
    const before = { ch: await chRow(f.pid, 'LinkedIn'), weeks: await weekRows(f.pid, 'LinkedIn'), renew: await commitmentRow(renewId) };
    expect(before.ch.closed_at).not.toBeNull();
    expect(before.renew).toMatchObject({ status: 'skipped', meta: { closed_with_channel: true } });
    const exId = await makeException(f.pid, 'LinkedIn');                                                // an exception left on a closed channel (made directly: closing clears the real ones)
    const r = await post(request, hr, `/api/sourcing/exceptions/${exId}/resolve`, { path: 'change_strategy', reason: 'Dropping it for good', exclude_channel: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // the exception is resolved, and the channel is exactly what it was: still CLOSED, its reason, its weeks, its skipped tasks
    expect((await sql(`SELECT status, resolution_path, reason FROM sourcing_exceptions WHERE id=$1::bigint`, [exId]))[0]).toMatchObject({ status: 'resolved', resolution_path: 'change_strategy', reason: 'Dropping it for good' });
    const after = await chRow(f.pid, 'LinkedIn');
    expect(after).toEqual(before.ch);
    expect(after).toMatchObject({ state: 'excluded', closed_reason: 'Closed on purpose', excluded_reason: null });
    expect(await weekRows(f.pid, 'LinkedIn')).toEqual(before.weeks);
    expect(await commitmentRow(renewId)).toEqual(before.renew);
    const v = await plan(request, f.rid);
    expect(channel(v, 'LinkedIn')).toMatchObject({ state: 'closed', closed_reason: 'Closed on purpose', excluded_reason: null });
    expect(historyOf(v, 'strategy_changed')).toHaveLength(1);
    // …so Reopen still works and brings its follow-up back (had the channel been turned into "left out", it would answer 409)
    expect((await reopenCh(request, f.pid, 'LinkedIn')).status).toBe(200);
    expect((await commitmentRow(renewId)).status).toBe('open');
    expect(await chRow(f.pid, 'LinkedIn')).toMatchObject({ state: 'active', closed_at: null, excluded_reason: null });
  });

  // ── (o) pause and resume ───────────────────────────────────────────────────────────────────────
  test('(o) while the plan is paused no channel has a running week or a start — and Reopen channel, Edit target and link on a paused plan keep it that way; resuming starts exactly the live channels that have a target', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Paused edits', [live('LinkedIn', 5), live('Naukri/IIMjobs', 4), live('Direct Outreach', 3), { channel: 'Agency' }]);
    expect((await closeCh(request, pid, 'LinkedIn', 'Closed before the hold')).status).toBe(200);
    await holdRole(request, rid);
    let v = await plan(request, rid);
    expect(v.plan.status).toBe('paused');
    for (const ch of ['Naukri/IIMjobs', 'Direct Outreach']) {
      expect(channel(v, ch).state, ch).toBe('active');
      expect(channel(v, ch).tracker, ch).toMatchObject({ anchor: null, running: null });
      expect((await chRow(pid, ch)).anchor, ch).toBeNull();
    }
    // Reopen channel on a paused plan: live again, tracker still stopped
    expect((await reopenCh(request, pid, 'LinkedIn')).status).toBe(200);
    expect(await chRow(pid, 'LinkedIn')).toMatchObject({ state: 'active', anchor: null });
    // Edit target and link on a paused plan: the target changes, no tracker starts
    expect((await settingsCh(request, pid, { channel: 'Naukri/IIMjobs', weekly_target: 9 })).status).toBe(200);
    expect(await chRow(pid, 'Naukri/IIMjobs')).toMatchObject({ anchor: null });
    expect((await chRow(pid, 'Naukri/IIMjobs')).targets.weekly_target).toBe(9);
    // a channel closed during the hold stays closed
    expect((await closeCh(request, pid, 'Direct Outreach', 'Parked during the hold')).status).toBe(200);
    v = await plan(request, rid);
    for (const ch of ['LinkedIn', 'Naukri/IIMjobs']) expect(channel(v, ch).tracker, ch).toMatchObject({ anchor: null, running: null });
    expect(channel(v, 'LinkedIn').tracker.target).toBe(5);
    expect(channel(v, 'Naukri/IIMjobs').tracker.target).toBe(9);
    expect(await changeCount(pid, 'weekly_result')).toBe(0);                                             // day one, nothing arrived: nothing to record

    await resumeRole(request, rid);
    expect((await chRow(pid, 'LinkedIn')).anchor).toBe(ymd(0));
    expect((await chRow(pid, 'Naukri/IIMjobs')).anchor).toBe(ymd(0));
    expect((await chRow(pid, 'Direct Outreach')).anchor).toBeNull();                                      // closed: not running
    expect((await chRow(pid, 'Agency')).anchor).toBeNull();                                               // no tracker
    v = await plan(request, rid);
    expect(channel(v, 'LinkedIn').tracker).toMatchObject({ anchor: ymd(0), target: 5 });
    expect(channel(v, 'LinkedIn').tracker.running).toEqual({ start: ymd(0), end: ymd(6), actual: 0, qualified: 0, target: 5 });
    expect(channel(v, 'Naukri/IIMjobs').tracker.running).toEqual({ start: ymd(0), end: ymd(6), actual: 0, qualified: 0, target: 9 });
    expect(channel(v, 'Direct Outreach')).toMatchObject({ state: 'closed' });
    expect(channel(v, 'Direct Outreach').tracker).toMatchObject({ anchor: null, running: null });
  });

  test('(o) resuming starts a tracker only for a channel that is live AND has a weekly target — not one live without a target, not one that was left out', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Resume rules', [live('LinkedIn', 5), live('Naukri/IIMjobs', 4), live('Direct Outreach', 3)]);
    await client.query(`UPDATE sourcing_plan_channels SET targets = targets - 'weekly_target', tracker_anchor = NULL WHERE plan_id=$1::bigint AND channel='Naukri/IIMjobs'`, [pid]);   // live, but from the first version: no target
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'Direct Outreach', state: 'excluded', excluded_reason: 'Not using outreach' })).status).toBe(200);
    await holdRole(request, rid);
    await resumeRole(request, rid);
    expect((await chRow(pid, 'LinkedIn')).anchor).toBe(ymd(0));
    expect((await chRow(pid, 'Naukri/IIMjobs')).anchor).toBeNull();
    expect((await chRow(pid, 'Direct Outreach')).anchor).toBeNull();
    const v = await plan(request, rid);
    expect(channel(v, 'Naukri/IIMjobs').tracker).toMatchObject({ target: null, anchor: null, running: null });
    expect(channel(v, 'Direct Outreach').tracker).toMatchObject({ anchor: null, running: null });
  });

  test('(o) the length of a hold is rounded to the nearest whole day — a hold of seconds is 0 — and pause_total_days and the "resumed" entry agree', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Hold rounding', [{ channel: 'Agency' }]);
    const holds: Array<[string, number]> = [['11 hours', 0], ['13 hours', 1], ['2 days 11 hours', 2], ['2 days 13 hours', 3], ['0 seconds', 0]];
    const task = await commitmentId(pid, 'Agency', 'activate_channel');
    const dueMs = async () => +new Date((await commitmentRow(task)).due_at);
    let total = 0;
    for (const [ago, days] of holds) {
      const dueBefore = await dueMs();
      await holdRole(request, rid);
      expect((await planRow(pid)).status, ago).toBe('paused');
      expect(await dueMs(), `${ago}: nothing moves while the role is on hold`).toBe(dueBefore);
      if (ago !== '0 seconds') await client.query(`UPDATE sourcing_plans SET paused_at = NOW() - $2::interval WHERE id=$1::bigint`, [pid, ago]);
      await resumeRole(request, rid);
      total += days;
      const p = await planRow(pid);
      expect(p.status, ago).toBe('active');
      expect(p.paused_at, ago).toBeNull();
      expect(p.pause_total_days, ago).toBe(total);
      // open due dates move by exactly that many WHOLE days — a hold of 11 hours or of seconds moves nothing, 13 hours a full day
      expect(await dueMs() - dueBefore, `${ago}: due date shift`).toBe(days * 86400000);
    }
    const resumed = historyOf(await plan(request, rid), 'resumed');                                      // newest first
    expect(resumed.map(h => h.change.paused_days)).toEqual([0, 3, 2, 1, 0]);
    expect(resumed.map(h => h.text)).toEqual(['Plan resumed', 'Plan resumed after 3 days on hold', 'Plan resumed after 2 days on hold', 'Plan resumed after 1 day on hold', 'Plan resumed']);
    expect(historyOf(await plan(request, rid), 'paused')).toHaveLength(5);
  });

  // ── (p) the Dashboard workspace and summary know about paused plans ────────────────────────────
  // (Used to be a test.fail: the workspace listed only roles in an open status, and a paused plan always belongs to an On Hold role — so a role
  // put On Hold simply vanished from the switcher; and the summary's plans_paused was always 0 for the same reason.)
  test('(p) workspace: a role On Hold keeps its (paused) plan in the switcher — whatever the role status — not behind, with its live channels; a closed role has none', async ({ request }) => {
    const a = await activeRole(request, 'WS hold a', [live('LinkedIn', 5)], { priority: 'P1', hm: 'Alex' });
    const b = await activeRole(request, 'WS hold b', [live('LinkedIn', 5)], { priority: 'P0', hm: 'Alex' });
    const c = await activeRole(request, 'WS hold closed', [live('LinkedIn', 5)], { priority: 'P1', hm: 'Alex' });
    const rowOf = (w: Json, rid: string) => (w.body.roles as Json[]).find(r => r.role_id === rid);
    const ws = (tok = hr) => get(request, tok, '/api/sourcing/workspace');

    await holdRole(request, a.rid);
    expect((await planRow(a.pid)).status).toBe('paused');
    let w = await ws();
    expect(rowOf(w, a.rid)).toMatchObject({ plan_id: a.pid, plan_status: 'paused', priority: 'P1', channels_live: 1, open_exceptions: 0, target: 5, qualified: 0, behind: false });   // paused: "behind" does not apply
    expect(rowOf(w, b.rid)).toMatchObject({ plan_status: 'active', behind: true });
    const order = (w.body.roles as Json[]).map(r => r.role_id).filter(id => [a.rid, b.rid].includes(id));
    expect(order).toEqual([b.rid, a.rid]);                                                                // still ordered by priority (P0 before P1)
    expect((w.body.drafts as Json[]).some(d => d.role_id === a.rid)).toBe(false);
    // not open any more but not closed either (Under Review): the plan stays paused and stays listed
    await setRoleStatus(request, a.rid, 'Under Review');
    expect((await planRow(a.pid)).status).toBe('paused');
    expect(rowOf(await ws(), a.rid)).toMatchObject({ plan_id: a.pid, plan_status: 'paused' });
    // the named Hiring Manager sees it (read-only); a Hiring Manager of another role does not
    const hmA = await ws(alex);
    expect(hmA.body.read_only).toBe(true);
    expect(rowOf(hmA, a.rid)).toMatchObject({ plan_status: 'paused' });
    expect(((await ws(satyadev)).body.roles as Json[]).some(r => r.role_id === a.rid)).toBe(false);
    // back on: active again, and behind once more
    await resumeRole(request, a.rid);
    expect(rowOf(await ws(), a.rid)).toMatchObject({ plan_status: 'active', behind: true });
    // a role that is held and then closed has a closed plan: no workspace at all
    await holdRole(request, c.rid);
    expect(rowOf(await ws(), c.rid)).toMatchObject({ plan_status: 'paused' });
    await setRoleStatus(request, c.rid, 'Closed – Filled');
    w = await ws();
    expect(rowOf(w, c.rid)).toBeUndefined();
    expect((w.body.drafts as Json[]).some(d => d.role_id === c.rid)).toBe(false);
  });

  test('(p) workspace: the exceptions of a paused plan are kept (a hold does not clear them) but set aside — its pill does not count them until the role is back', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'WS hold exceptions', [live('LinkedIn', 5), { channel: 'Agency' }]);
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '2 days' WHERE id=$1::bigint`, [await commitmentId(pid, 'Agency', 'activate_channel')]);
    await cron(request);
    const row = async () => ((await get(request, hr, '/api/sourcing/workspace')).body.roles as Json[]).find(r => r.role_id === rid)!;
    expect(await row()).toMatchObject({ plan_status: 'active', open_exceptions: 1 });
    await holdRole(request, rid);
    await cron(request);
    // set aside while the role is on hold: the pill does not count it (nor does the queue), but the SAME exception is still open in the database
    expect(await row()).toMatchObject({ plan_status: 'paused', open_exceptions: 0, behind: false });
    expect((await client.query(`SELECT count(*)::int AS n FROM sourcing_exceptions WHERE plan_id = $1::bigint AND status = 'open' AND NOT is_shadow`, [pid])).rows[0].n).toBe(1);
    await resumeRole(request, rid);
    await cron(request);
    expect(await row()).toMatchObject({ plan_status: 'active', open_exceptions: 1 });
  });

  test('(p) the Dashboard summary counts paused plans (plans_paused used to be 0 for ever) — a held role is a paused plan and no longer an open role', async ({ request }) => {
    const a = await activeRole(request, 'Dash hold a', [live('LinkedIn', 5)]);
    const b = await activeRole(request, 'Dash hold b', [live('LinkedIn', 5)]);
    const summary = async (...rids: string[]) => (await get(request, hr, `/api/dashboard/sourcing?${rids.map(r => `role_id=${r}`).join('&')}`)).body.summary as Json;
    expect(await summary(a.rid)).toMatchObject({ open_roles: 1, plans_active: 1, plans_paused: 0, plans_draft: 0 });
    await holdRole(request, a.rid);
    expect(await summary(a.rid)).toMatchObject({ open_roles: 0, plans_active: 0, plans_paused: 1, plans_draft: 0 });
    expect(await summary(a.rid, b.rid)).toMatchObject({ open_roles: 1, plans_active: 1, plans_paused: 1, plans_draft: 0 });       // one of each
    expect(await summary(b.rid)).toMatchObject({ open_roles: 1, plans_active: 1, plans_paused: 0 });                               // the filter scopes the paused count too
    await resumeRole(request, a.rid);
    expect(await summary(a.rid)).toMatchObject({ open_roles: 1, plans_active: 1, plans_paused: 0 });
    await holdRole(request, a.rid);
    await setRoleStatus(request, a.rid, 'Closed – Filled');                                              // held, then closed: a closed plan is counted nowhere
    expect(await summary(a.rid)).toMatchObject({ open_roles: 0, plans_active: 0, plans_paused: 0, plans_draft: 0 });
  });

  // ── (q) re-activation, and the target on the activate request ──────────────────────────────────
  test('(q) re-activating a plan that had a closed channel clears the close: the channel is a plain live / left-out channel again, and adding, leaving out, editing and reopening answer as they should', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Reactivate after close', [live('LinkedIn', 5), live('Naukri/IIMjobs', 4), { channel: 'Agency' }]);
    expect((await closeCh(request, pid, 'LinkedIn', 'Closed for a while')).status).toBe(200);
    expect((await closeCh(request, pid, 'Naukri/IIMjobs', 'No Naukri budget')).status).toBe(200);
    for (const ch of ['LinkedIn', 'Naukri/IIMjobs']) expect((await chRow(pid, ch)).closed_at, ch).not.toBeNull();
    await setRoleStatus(request, rid, 'Closed – Filled');
    await setRoleStatus(request, rid, 'Live – Sourcing');
    expect((await planRow(pid)).status).toBe('draft');
    expect(channel(await plan(request, rid), 'LinkedIn').state).toBe('closed');                           // history kept: still closed in the draft …
    // … until the plan is activated again: LinkedIn is running once more, Naukri is left out with a reason of its own
    const act = await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [live('LinkedIn', 6), { channel: 'Naukri/IIMjobs', exclude_reason: 'No Naukri budget this time' }, { channel: 'Agency' }] });
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    expect(await chRow(pid, 'LinkedIn')).toMatchObject({ state: 'active', closed_at: null, closed_reason: null, excluded_reason: null, anchor: ymd(0) });
    expect(await chRow(pid, 'Naukri/IIMjobs')).toMatchObject({ state: 'excluded', closed_at: null, closed_reason: null, excluded_reason: 'No Naukri budget this time' });
    const v = await plan(request, rid);
    expect(channel(v, 'LinkedIn')).toMatchObject({ state: 'active', closed_at: null, closed_reason: null });
    expect(channel(v, 'Naukri/IIMjobs')).toMatchObject({ state: 'excluded', excluded_reason: 'No Naukri budget this time', closed_at: null, closed_reason: null });
    // …and every channel operation answers as it would for any other channel (each of these used to be a 409 about a close that was no longer there)
    const already = await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'LinkedIn', state: 'planned' });
    expect(already.status).toBe(409);
    expect(String(already.body.error)).toMatch(/already in this plan/i);
    expect((await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 7 })).status).toBe(200);
    const notClosed = await reopenCh(request, pid, 'LinkedIn');
    expect(notClosed.status).toBe(409);
    expect(String(notClosed.body.error)).toMatch(/is not closed/i);
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'Naukri/IIMjobs', state: 'planned' })).status).toBe(200);
    expect(await chRow(pid, 'Naukri/IIMjobs')).toMatchObject({ state: 'planned', excluded_reason: null, closed_at: null });
    expect((await commitmentRow(await commitmentId(pid, 'Naukri/IIMjobs', 'activate_channel'))).status).toBe('open');
    expect((await reopenCh(request, pid, 'Naukri/IIMjobs')).status).toBe(409);
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'Naukri/IIMjobs', state: 'excluded', excluded_reason: 'Left out again' })).status).toBe(200);
    expect(await chRow(pid, 'Naukri/IIMjobs')).toMatchObject({ state: 'excluded', excluded_reason: 'Left out again', closed_at: null });
    // a channel can still be closed (and reopened) after a re-activation
    expect((await closeCh(request, pid, 'LinkedIn', 'Closing it again')).status).toBe(200);
    expect(channel(await plan(request, rid), 'LinkedIn')).toMatchObject({ state: 'closed', closed_reason: 'Closing it again' });
    expect((await reopenCh(request, pid, 'LinkedIn')).status).toBe(200);
    expect(await chRow(pid, 'LinkedIn')).toMatchObject({ state: 'active', closed_at: null });
  });

  test('(q) activation refuses a weekly_qualified_target that is not a number (400, nothing written); null and a missing one are fine', async ({ request }) => {
    const rid = await newRole({ title: 'Activate junk target', priority: 'P2', modes: ['LinkedIn'] });
    const pid = (await plan(request, rid)).plan.id as string;
    const modeBefore = (await sql(`SELECT recruitment_mode FROM roles WHERE id=$1`, [rid]))[0].recruitment_mode;
    for (const bad of ['5', 'five', '', true, false, [], [5], {}, { value: 5 }]) {
      const r = await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [{ channel: 'LinkedIn' }, { channel: 'Agency' }], weekly_qualified_target: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(String(r.body.error), JSON.stringify(bad)).toMatch(/whole number from 1 to 500/);
    }
    // every refusal left a plain draft
    expect((await planRow(pid)).status).toBe('draft');
    expect(await changeCount(pid, 'activated')).toBe(0);
    expect((await plan(request, rid)).channels.map((c: Json) => `${c.channel}:${c.state}`)).toEqual(['LinkedIn:planned']);       // the plan's own channels: Agency was never added
    expect((await sql(`SELECT recruitment_mode FROM roles WHERE id=$1`, [rid]))[0].recruitment_mode).toEqual(modeBefore);
    // an explicit null is "no target of its own", like leaving it out
    expect((await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [{ channel: 'LinkedIn' }], weekly_qualified_target: null })).status).toBe(200);
    expect((await plan(request, rid)).volume).toMatchObject({ role_target: null, target_source: 'none', applicable: false });
    // and a real number is stored
    const rid2 = await newRole({ title: 'Activate real target', priority: 'P2', modes: ['LinkedIn'] });
    const pid2 = (await plan(request, rid2)).plan.id as string;
    expect((await post(request, hr, `/api/sourcing/plans/${pid2}/activate`, { channels: [{ channel: 'LinkedIn' }], weekly_qualified_target: 3 })).status).toBe(200);
    expect((await plan(request, rid2)).volume).toMatchObject({ role_target: 3, target_source: 'role' });
  });

  // ── (r) closing a channel clears what is open on it ────────────────────────────────────────────
  test('(r) Close channel clears that channel\'s open, snoozed and blocked exceptions at once — another channel\'s exception and the plan-level volume signal are untouched, and nothing is re-raised', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Close clears exceptions', [live('LinkedIn', 5), live('Naukri/IIMjobs', 4), { channel: 'Direct Outreach' }, { channel: 'Agency' }]);
    for (const [ch, kind] of [['LinkedIn', 'renew_posting'], ['Naukri/IIMjobs', 'renew_posting'], ['Direct Outreach', 'activate_channel'], ['Agency', 'activate_channel']] as const) {
      await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '3 days' WHERE id=$1::bigint`, [await commitmentId(pid, ch, kind)]);
    }
    await cron(request);
    const ex = async (ch: string) => (await liveTaskExceptions(pid)).find(e => e.channel === ch)!;
    const ids: Record<string, string> = {};
    for (const ch of ['LinkedIn', 'Naukri/IIMjobs', 'Direct Outreach', 'Agency']) { ids[ch] = (await ex(ch)).id; expect(ids[ch], ch).toBeTruthy(); }
    // one open, one snoozed (catching up), one blocked, one left alone
    expect((await post(request, hr, `/api/sourcing/exceptions/${ids['Naukri/IIMjobs']}/resolve`, { path: 'catch_up', reason: 'Renewing on Monday', snooze_until: ymd(3) })).status).toBe(200);
    expect((await post(request, hr, `/api/sourcing/exceptions/${ids['Direct Outreach']}/resolve`, { path: 'blocker', reason: 'Waiting on the campaign sheet', blocker_due: ymd(5) })).status).toBe(200);
    const statusOf = async (id: string) => (await sql(`SELECT status, resolution_path, reason, resolved_at FROM sourcing_exceptions WHERE id=$1::bigint`, [id]))[0];
    expect(await statusOf(ids['LinkedIn'])).toMatchObject({ status: 'open' });
    expect(await statusOf(ids['Naukri/IIMjobs'])).toMatchObject({ status: 'snoozed' });
    expect(await statusOf(ids['Direct Outreach'])).toMatchObject({ status: 'blocked' });
    const volumeBefore = await sql(`SELECT id::text AS id, status FROM sourcing_exceptions WHERE plan_id=$1::bigint AND type='VOLUME_GAP' AND status='open'`, [pid]);

    for (const ch of ['LinkedIn', 'Naukri/IIMjobs', 'Direct Outreach']) {
      expect((await closeCh(request, pid, ch, `Closing ${ch} for good`)).status, ch).toBe(200);
      const s = await statusOf(ids[ch]);
      expect(s, ch).toMatchObject({ status: 'resolved', resolution_path: 'auto_cleared', reason: 'Channel closed' });     // at once, whatever it was
      expect(s.resolved_at, ch).toBeTruthy();
      expect(await statusOf(ids['Agency']), `after closing ${ch}`).toMatchObject({ status: 'open' });                         // another channel's exception is not touched
    }
    expect((await sql(`SELECT id::text AS id, status FROM sourcing_exceptions WHERE plan_id=$1::bigint AND type='VOLUME_GAP' AND status='open'`, [pid]))).toEqual(volumeBefore);   // the plan-level signal neither
    await cron(request); await cron(request);
    expect((await liveTaskExceptions(pid)).map(e => e.channel)).toEqual(['Agency']);                                          // nothing is raised again for a closed channel
    expect((await liveTaskExceptions(pid))[0].id).toBe(ids['Agency']);
    for (const ch of ['LinkedIn', 'Naukri/IIMjobs', 'Direct Outreach']) expect(await statusOf(ids[ch]), ch).toMatchObject({ status: 'resolved', resolution_path: 'auto_cleared' });
    expect(await changeCount(pid, 'channel_closed')).toBe(3);
    expect(await changeCount(pid, 'exception_cleared')).toBe(3);      // each close says what it cleared (one per exception, "Cleared automatically"); the engine's sweeps add none
  });

  // ── (s) the plan history and the engine ────────────────────────────────────────────────────────
  // (The shadow→live case used to be a test.fail — see "(g) every cleared automatically entry …" above; this one is the other way a provisional
  // signal goes live.)
  test('(g) a provisional signal that goes live because its plan was ACTIVATED is logged as flagged at that moment — once, however many sweeps race', async ({ request }) => {
    await shadow(false);
    try {
      const rid = await newRole({ title: 'Flip on activation', priority: 'P1', modes: ['LinkedIn'] });
      const pid = (await plan(request, rid)).plan.id as string;
      await cron(request);
      expect(await volumeGap(pid)).toMatchObject({ is_shadow: true });                                   // a draft plan's gap is provisional whatever the date says
      expect(await changeCount(pid, 'exception_opened')).toBe(0);
      expect((await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [{ channel: 'LinkedIn' }] })).status).toBe(200);
      await Promise.all([cron(request), cron(request), cron(request)]);
      expect(await volumeGap(pid)).toMatchObject({ is_shadow: false });
      expect(await changeCount(pid, 'exception_opened')).toBe(1);                                         // the one sweep that flipped the row logged it
      const opened = historyOf(await plan(request, rid), 'exception_opened');
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ by_name: null, category: 'exception', text: 'Flagged — Too few qualified candidates' });
      expect(opened[0].change).toMatchObject({ exception_type: 'VOLUME_GAP', channel: '*' });
      await cron(request); await cron(request);
      expect(await changeCount(pid, 'exception_opened')).toBe(1);
      expect((await sql(`SELECT count(*)::int AS n FROM sourcing_exceptions WHERE plan_id=$1::bigint AND type='VOLUME_GAP'`, [pid]))[0].n).toBe(1);   // the same row, not a second one
    } finally { await shadow(true); }
  });

  // An exception that is open, snoozed (a catch-up date) or blocked when the role goes On Hold is left exactly as it is: the engine does not look at a paused
  // plan, so it neither raises nor clears anything there, and a blocker or a catch-up date waits unchanged for the role to come back. (Every one of them
  // used to be cleared as "no longer true" at the first sweep of the hold, and flagged again — as a new row — after it.)
  test('(g) a role put On Hold leaves its open, snoozed and blocked exceptions exactly as they were — same rows, no "Cleared automatically" entry — and they are the same rows once the role is back', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'History hold', [live('LinkedIn', 5), { channel: 'Direct Outreach' }, { channel: 'Agency' }]);
    for (const [ch, kind] of [['LinkedIn', 'renew_posting'], ['Direct Outreach', 'activate_channel'], ['Agency', 'activate_channel']] as const) {
      await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '2 days' WHERE id=$1::bigint`, [await commitmentId(pid, ch, kind)]);
    }
    await cron(request); await cron(request);
    const exOf = async (ch: string) => (await liveTaskExceptions(pid)).find(e => e.channel === ch)!.id;
    const ids = { open: await exOf('Agency'), snoozed: await exOf('Direct Outreach'), blocked: await exOf('LinkedIn') };
    expect((await post(request, hr, `/api/sourcing/exceptions/${ids.snoozed}/resolve`, { path: 'catch_up', reason: 'Campaign sheet comes tomorrow', snooze_until: ymd(3) })).status).toBe(200);
    expect((await post(request, hr, `/api/sourcing/exceptions/${ids.blocked}/resolve`, { path: 'blocker', reason: 'Waiting on the new posting', blocker_due: ymd(5) })).status).toBe(200);
    const rows = () => sql(
      `SELECT id::text AS id, channel, type, status, is_shadow, resolution_path, reason, to_char(snooze_until,'YYYY-MM-DD') AS snooze_until, to_char(blocker_due,'YYYY-MM-DD') AS blocker_due,
              blocker_owner_user_id::text AS owner, reopen_count, resolved_at FROM sourcing_exceptions WHERE plan_id=$1::bigint ORDER BY id`, [pid]);
    const count = async (type: string) => Number((await sql(`SELECT count(*) AS n FROM sourcing_plan_changes WHERE plan_id=$1::bigint AND change->>'type'=$2 AND change->>'exception_type' <> 'VOLUME_GAP'`, [pid, type]))[0].n);
    const before = await rows();
    expect(before.find(r => r.id === ids.open)).toMatchObject({ status: 'open', type: 'CHANNEL_NOT_ACTIVATED' });
    expect(before.find(r => r.id === ids.snoozed)).toMatchObject({ status: 'snoozed', snooze_until: ymd(3) });
    expect(before.find(r => r.id === ids.blocked)).toMatchObject({ status: 'blocked', blocker_due: ymd(5) });
    expect(await count('exception_opened')).toBe(3);

    // the hold: sweeps, readers and time passing change nothing — the catch-up date and the deadline lapse "behind" it and nothing reacts to that either
    await holdRole(request, rid);
    await cron(request); await cron(request);
    expect(await rows()).toEqual(before);
    await client.query(`UPDATE sourcing_exceptions SET snooze_until = CURRENT_DATE - 1 WHERE id=$1::bigint`, [ids.snoozed]);
    await client.query(`UPDATE sourcing_exceptions SET blocker_due = CURRENT_DATE - 2 WHERE id=$1::bigint`, [ids.blocked]);
    await cron(request); await plan(request, rid);
    const during = await rows();
    expect(during.find(r => r.id === ids.open)).toEqual(before.find(r => r.id === ids.open));
    expect(during.find(r => r.id === ids.snoozed)).toMatchObject({ status: 'snoozed', reopen_count: 0 });              // not put back on the list while the role is on hold
    expect(during.find(r => r.id === ids.blocked)).toMatchObject({ status: 'blocked' });
    expect(during.some(r => r.type === 'BLOCKER_OVERDUE')).toBe(false);                                                  // …and no "past its deadline" is raised on a paused plan
    expect(during.length).toBe(before.length);
    expect(await count('exception_cleared')).toBe(0);                                                                    // a hold is not the problem fixing itself
    expect(await count('exception_reopened')).toBe(0);
    expect(await count('exception_opened')).toBe(3);

    // the role is back: the SAME rows carry on — the open one untouched (nothing was cleared and re-flagged), the lapsed catch-up date puts its row back on the list
    // once, and the passed deadline now raises its own BLOCKER_OVERDUE row beside the blocked one
    await resumeRole(request, rid);
    await cron(request); await cron(request);
    const after = await rows();
    expect(after.find(r => r.id === ids.open)).toEqual(before.find(r => r.id === ids.open));
    expect(after.find(r => r.id === ids.snoozed)).toMatchObject({ status: 'open', reopen_count: 1 });
    expect(after.find(r => r.id === ids.blocked)).toMatchObject({ status: 'blocked' });
    expect(after.filter(r => r.type === 'BLOCKER_OVERDUE' && r.status === 'open')).toHaveLength(1);
    expect(await count('exception_cleared')).toBe(0);
    expect(await count('exception_reopened')).toBe(1);
    expect(await count('exception_opened')).toBe(4);                                                                     // the three from before the hold + BLOCKER_OVERDUE
    expect((await liveTaskExceptions(pid)).filter(e => e.channel === 'Agency' && e.type === 'CHANNEL_NOT_ACTIVATED')).toHaveLength(1);   // never a second row for the same problem
    // …and when the work is really done the system does say so
    expect((await post(request, hr, `/api/sourcing/commitments/${await commitmentId(pid, 'Agency', 'activate_channel')}/complete`, { note: 'Agencies briefed' })).status).toBe(200);
    await cron(request);
    expect(await count('exception_cleared')).toBe(1);
    expect((await sql(`SELECT status FROM sourcing_exceptions WHERE id=$1::bigint`, [ids.open]))[0].status).toBe('resolved');
  });

  test('(g) free text written to the plan history — a skip reason and every kind of resolution — is cut at 500 characters', async ({ request }) => {
    const { pid } = await activeRole(request, 'Reason cap', [live('LinkedIn', 5), { channel: 'Agency' }, { channel: 'Internal Referral' }, { channel: 'Direct Outreach' }]);
    const long = `  ${'0123456789'.repeat(60)}  `;                                                          // 600 characters, padded with spaces
    const cap = '0123456789'.repeat(50);                                                                  // trimmed, then the first 500
    expect((await post(request, hr, `/api/sourcing/commitments/${await commitmentId(pid, 'LinkedIn', 'renew_posting')}/skip`, { reason: long })).status).toBe(200);
    for (const ch of ['Agency', 'Internal Referral', 'Direct Outreach']) {
      await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '2 days' WHERE id=$1::bigint`, [await commitmentId(pid, ch, 'activate_channel')]);
    }
    await cron(request);
    const exOf = async (ch: string) => (await liveTaskExceptions(pid)).find(e => e.channel === ch)!.id;
    const [a, ir, d] = [await exOf('Agency'), await exOf('Internal Referral'), await exOf('Direct Outreach')];
    expect((await post(request, hr, `/api/sourcing/exceptions/${a}/resolve`, { path: 'catch_up', reason: long, snooze_until: ymd(2) })).status).toBe(200);
    expect((await post(request, hr, `/api/sourcing/exceptions/${ir}/resolve`, { path: 'blocker', reason: long, blocker_due: ymd(5) })).status).toBe(200);
    expect((await post(request, hr, `/api/sourcing/exceptions/${d}/resolve`, { path: 'change_strategy', reason: long, exclude_channel: true })).status).toBe(200);
    const logged = await sql(`SELECT change->>'type' AS type, reason FROM sourcing_plan_changes WHERE plan_id=$1::bigint AND change->>'type' = ANY($2::text[]) ORDER BY id`,
      [pid, ['commitment_skipped', 'exception_snoozed', 'exception_blocked', 'strategy_changed']]);
    expect(logged.map(l => l.type).sort()).toEqual(['commitment_skipped', 'exception_blocked', 'exception_snoozed', 'strategy_changed']);
    for (const l of logged) {
      expect(l.reason.length, l.type).toBe(500);
      expect(l.reason, l.type).toBe(cap);
    }
    for (const r of await sql(`SELECT id::text AS id, reason FROM sourcing_exceptions WHERE id = ANY($1::bigint[])`, [[a, ir, d]])) expect(r.reason, `exception ${r.id}`).toBe(cap);
    // the resolution closed the channel: the (capped) reason is its close reason
    expect(await chRow(pid, 'Direct Outreach')).toMatchObject({ state: 'excluded', excluded_reason: null, closed_reason: cap });
  });

  // ── (t) Edit target and link completes a live channel's first task ─────────────────────────────
  // A channel that is LIVE but whose first task ("log the post: link and weekly target") is still open is what the first version of the tracker
  // left behind. Left open it would go on to raise "channel not live" for work that has been done, so once the channel has both a target and a
  // link the task is completed.
  const LINK = 'https://example.com/jobs/settings-complete';
  const legacyLive = async (request: any, title: string, ch = 'LinkedIn') => {
    const rid = await newRole({ title, modes: [ch] });
    const pid = (await plan(request, rid)).plan.id as string;
    expect((await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [{ channel: ch }] })).status).toBe(200);
    await client.query(`UPDATE sourcing_plan_channels SET state='active' WHERE plan_id=$1::bigint AND channel=$2`, [pid, ch]);
    return { rid, pid, act: await commitmentId(pid, ch, 'activate_channel') };
  };
  const logRowsOf = (id: string) => sql(`SELECT note, done_by::text AS done_by FROM sourcing_commitment_log WHERE commitment_id=$1::bigint`, [id]);
  const evidenceOf = (id: string) => sql(`SELECT e.kind, e.ref, e.source FROM sourcing_evidence e JOIN sourcing_commitment_log l ON l.id=e.log_id WHERE l.commitment_id=$1::bigint`, [id]);

  test('(t) Edit target and link completes the still-open first task of a live channel — but only once it has BOTH a target and a link (either order, or both at once)', async ({ request }) => {
    const aaron = await aaronIdOf();
    const cases: Array<[string, Json[]]> = [
      ['target, then link', [{ weekly_target: 8 }, { posting_url: LINK }]],
      ['link, then target', [{ posting_url: LINK }, { weekly_target: 6 }]],
      ['both at once', [{ weekly_target: 7, posting_url: LINK }]],
    ];
    for (const [label, calls] of cases) {
      const { rid, pid, act } = await legacyLive(request, `Settings complete ${label}`);
      for (const [i, body] of calls.entries()) {
        const r = await settingsCh(request, pid, { channel: 'LinkedIn', ...body });
        expect(r.status, `${label} #${i}: ${JSON.stringify(r.body)}`).toBe(200);
        if (i < calls.length - 1) {                                                                         // only one of the two so far: the task is still waiting
          expect((await commitmentRow(act)).status, `${label}: after ${JSON.stringify(body)}`).toBe('open');
          expect(await logRowsOf(act), label).toEqual([]);
          expect(await changeCount(pid, 'commitment_completed'), label).toBe(0);
        }
      }
      const want = Object.assign({}, ...calls) as Json;
      // completed: a log row (under the person), the link as evidence, one history entry carrying what was set
      expect(await commitmentRow(act), label).toMatchObject({ status: 'done' });
      expect((await commitmentRow(act)).last_done_at, label).toBeTruthy();
      expect(await logRowsOf(act), label).toEqual([{ note: 'Link and weekly target added from the channel settings', done_by: aaron }]);
      expect(await evidenceOf(act), label).toEqual([{ kind: 'url', ref: LINK, source: 'self' }]);
      let v = await plan(request, rid);
      const done = historyOf(v, 'commitment_completed');
      expect(done, label).toHaveLength(1);
      expect(done[0], label).toMatchObject({ by_name: 'Aaron Newton', category: 'task' });
      expect(done[0].change, label).toMatchObject({ channel: 'LinkedIn', kind: 'activate_channel', url: LINK, weekly_target: want.weekly_target });
      expect(done[0].text, label).toContain('link logged');
      expect(done[0].text, label).toContain(`weekly target ${want.weekly_target}`);
      expect(channel(v, 'LinkedIn').tracker, label).toMatchObject({ target: want.weekly_target, link: LINK, anchor: ymd(0) });
      expect(commitment(v, 'LinkedIn', 'activate_channel').status, label).toBe('done');
      // changing the target later finds no open task: nothing is completed a second time
      expect((await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 11 })).status, label).toBe(200);
      expect(await logRowsOf(act), label).toHaveLength(1);
      expect(await changeCount(pid, 'commitment_completed'), label).toBe(1);
    }
  });

  test('(t) …and the engine stops chasing the channel as "not live" once the settings completed its task', async ({ request }) => {
    const { pid, act } = await legacyLive(request, 'Settings clears the flag');
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '2 days' WHERE id=$1::bigint`, [act]);
    await cron(request);
    expect((await liveTaskExceptions(pid)).map(e => [e.channel, e.type])).toEqual([['LinkedIn', 'CHANNEL_NOT_ACTIVATED']]);
    expect((await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 5, posting_url: LINK })).status).toBe(200);
    await cron(request);
    expect(await liveTaskExceptions(pid)).toEqual([]);
    expect(await changeCount(pid, 'exception_cleared')).toBe(1);
  });

  test('(t) on a PAUSED plan the settings still complete the task but start no tracker — resuming the plan does', async ({ request }) => {
    const { rid, pid, act } = await legacyLive(request, 'Settings on hold');
    await holdRole(request, rid);
    expect((await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 6, posting_url: LINK })).status).toBe(200);
    expect(await commitmentRow(act)).toMatchObject({ status: 'done' });
    expect(await changeCount(pid, 'commitment_completed')).toBe(1);
    expect((await chRow(pid, 'LinkedIn')).anchor).toBeNull();                                            // no anchor while the plan is paused
    expect(channel(await plan(request, rid), 'LinkedIn').tracker).toMatchObject({ target: 6, link: LINK, anchor: null, running: null });
    await resumeRole(request, rid);
    expect((await chRow(pid, 'LinkedIn')).anchor).toBe(ymd(0));
    expect(channel(await plan(request, rid), 'LinkedIn').tracker.running).toEqual({ start: ymd(0), end: ymd(6), actual: 0, qualified: 0, target: 6 });
  });

  // ── (v) wording ────────────────────────────────────────────────────────────────────────────────
  // "(already running)" belongs to ONE thing: a channel that was running before HMS and was attested as such when the plan was activated. The dialog's
  // "Mark done" / "Log post" sends attest:true for EVERY completion, which used to read as "already running" in the history of an ordinary completion.
  test('(v) the history says "already running" only for a channel attested as running before HMS at activation — never for a task completed with attest:true, with a note, or a rolling one', async ({ request }) => {
    const rid = await newRole({ title: 'History wording', modes: ['LinkedIn', 'Naukri/IIMjobs', 'Direct Outreach', 'Agency', 'Internal Referral'] });
    const pid = (await plan(request, rid)).plan.id as string;
    const act = await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [
      live('LinkedIn', 5), { channel: 'Agency', already_running: true }, { channel: 'Naukri/IIMjobs' }, { channel: 'Direct Outreach' }, { channel: 'Internal Referral' }] });
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    let v = await plan(request, rid);
    const complete = (id: string, body: Json) => post(request, hr, `/api/sourcing/commitments/${id}/complete`, body);
    // what the dialog sends: attest:true, the link and the target (and a note)
    expect((await complete(commitment(v, 'Naukri/IIMjobs', 'activate_channel').id, { attest: true, url: `${POST_URL}/naukri`, weekly_target: 6, note: 'Posted this morning' })).status).toBe(200);
    expect((await complete(commitment(v, 'Direct Outreach', 'activate_channel').id, { url: `${POST_URL}/outreach`, weekly_target: 3 })).status).toBe(200);        // no attestation at all
    expect((await complete(commitment(v, 'Internal Referral', 'activate_channel').id, { note: 'Push sent to everyone' })).status).toBe(200);                   // just a note
    expect((await complete(commitment(v, 'LinkedIn', 'renew_posting').id, { attest: true, note: 'Refreshed the posting' })).status).toBe(200);                  // a rolling follow-on
    v = await plan(request, rid);
    const entry = (ch: string, kind: string) => historyOf(v, 'commitment_completed').find(h => h.change.channel === ch && h.change.kind === kind)!;

    // attested at activation: stored as already_running (and still as attested), and the text says so
    for (const ch of ['LinkedIn', 'Agency']) {
      const e = entry(ch, 'activate_channel');
      expect(e.change, ch).toMatchObject({ already_running: true, attested: true });
      expect(e.text, ch).toContain('already running');
    }
    expect(entry('LinkedIn', 'activate_channel').text).toContain('weekly target 5');
    // everything else: whatever flags it carried, it is not "already running"
    for (const [ch, kind] of [['Naukri/IIMjobs', 'activate_channel'], ['Direct Outreach', 'activate_channel'], ['Internal Referral', 'activate_channel'], ['LinkedIn', 'renew_posting']] as const) {
      const e = entry(ch, kind);
      expect(e.change.already_running, `${ch} ${kind}`).toBeUndefined();
      expect(e.text, `${ch} ${kind}`).not.toContain('already running');
    }
    expect(entry('Naukri/IIMjobs', 'activate_channel').change).toMatchObject({ attested: true, weekly_target: 6 });          // the dialog's attestation is still recorded …
    expect(entry('Naukri/IIMjobs', 'activate_channel').text).toContain('link logged');                                       // … and the text still says what was logged
    expect(entry('Naukri/IIMjobs', 'activate_channel').text).toContain('weekly target 6');
    expect(entry('Direct Outreach', 'activate_channel').change.attested).toBeUndefined();
    // and the rule holds for every completion entry of the plan
    for (const h of historyOf(v, 'commitment_completed')) expect(h.text.includes('already running'), h.text).toBe(h.change.already_running === true);
  });

  // The label is "Channel set-up overdue" (it was "Channel not live": a channel whose post was logged but not tracked was not "not live"), and the next
  // action says what the channel actually needs — for the three tracked channels that is the link AND the weekly sourcing target.
  test('(v) a channel whose first task is overdue is flagged "Channel set-up overdue" with the next action that fits the channel — in the plan, the queue and the history', async ({ request }) => {
    const rid = await newRole({ title: 'Setup wording', modes: ['LinkedIn', 'Naukri/IIMjobs', 'Direct Outreach', 'Agency', 'Internal Referral'] });
    const pid = (await plan(request, rid)).plan.id as string;
    expect((await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [{ channel: 'LinkedIn' }, { channel: 'Naukri/IIMjobs' }, { channel: 'Direct Outreach' }, { channel: 'Agency' }, { channel: 'Internal Referral' }] })).status).toBe(200);
    const channels = ['LinkedIn', 'Naukri/IIMjobs', 'Direct Outreach', 'Agency', 'Internal Referral'];
    for (const ch of channels) await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '2 days' WHERE id=$1::bigint`, [await commitmentId(pid, ch, 'activate_channel')]);
    await cron(request);
    const next: Record<string, string> = {
      'LinkedIn': 'Log the LinkedIn post link and the weekly sourcing target, then mark it done',
      'Naukri/IIMjobs': 'Log the Naukri/IIMjobs post link and the weekly sourcing target, then mark it done',
      'Direct Outreach': 'Log the campaign link and the weekly sourcing target, then mark it done',
      'Agency': 'Choose the agencies, send the role brief and mark it done',
      'Internal Referral': 'Launch the referral push and mark it done',
    };
    const v = await plan(request, rid);
    const flagged = (v.exceptions as Json[]).filter(e => e.type === 'CHANNEL_NOT_ACTIVATED' && e.status === 'open');
    expect(flagged.map(e => e.channel).sort()).toEqual([...channels].sort());
    for (const e of flagged) {
      expect(e.next_action, e.channel).toBe(next[e.channel]);
      expect(e.committed, e.channel).toContain(`${e.channel}: `);
      expect(e.happened, e.channel).toMatch(/^Not done — 2 days overdue/);
    }
    expect(flagged.find(e => e.channel === 'LinkedIn')!.committed).toContain('Log the LinkedIn post (link and weekly sourcing target)');   // the task's own title says the same
    // the My Tasks queue carries the same sentences
    const queue = (await get(request, hr, '/api/sourcing/queue')).body;
    const group = (queue.exceptions as Json[]).find(g => g.role_id === rid)!;
    for (const ch of channels) expect((group.items as Json[]).find(i => i.channel === ch && i.type === 'CHANNEL_NOT_ACTIVATED')!.next_action, `queue: ${ch}`).toBe(next[ch]);
    // and the history calls each of them "Channel set-up overdue" — never the old "Channel not live"
    const opened = historyOf(v, 'exception_opened').filter(h => h.change.exception_type === 'CHANNEL_NOT_ACTIVATED');
    expect(opened).toHaveLength(5);
    for (const h of opened) { expect(h.text).toBe(`${h.change.channel}: Flagged — Channel set-up overdue`); expect(h.text).not.toContain('not live'); }
  });

  // ── (r) a change of strategy that drops the channel CLOSES it ───────────────────────────────────
  test('(r) "change strategy → drop the channel" CLOSES the channel — closed state and reason, summary kept, tasks skipped for Reopen — and clears its other exceptions at once; another channel\'s are untouched; Reopen brings it back', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Strategy closes channel', [live('LinkedIn', 5), live('Naukri/IIMjobs', 4), { channel: 'Agency' }], { anchors: { LinkedIn: ymd(-9) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-5)), 4, { score: 80 });                                      // a finished week: 4 of 5
    await addApps(rid, 'LinkedIn', noon(ymd(-1)), 2);                                                      // the week in progress
    for (const [ch, kind] of [['LinkedIn', 'renew_posting'], ['Naukri/IIMjobs', 'renew_posting'], ['Agency', 'activate_channel']] as const) {
      await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '3 days' WHERE id=$1::bigint`, [await commitmentId(pid, ch, kind)]);
    }
    await cron(request);                                                                                   // the engine's own exceptions (and the finished LinkedIn week is recorded)
    const exOf = async (ch: string) => (await liveTaskExceptions(pid)).find(e => e.channel === ch)!.id;
    const [li, nk, ag] = [await exOf('LinkedIn'), await exOf('Naukri/IIMjobs'), await exOf('Agency')];
    // two more problems on LinkedIn: one catching up, one blocked (made directly — the engine would clear them, so no sweep until the resolution)
    const second = await makeException(pid, 'LinkedIn', 'SECOND_PROBLEM'), third = await makeException(pid, 'LinkedIn', 'THIRD_PROBLEM');
    expect((await post(request, hr, `/api/sourcing/exceptions/${second}/resolve`, { path: 'catch_up', reason: 'Renewing on Monday', snooze_until: ymd(3) })).status).toBe(200);
    expect((await post(request, hr, `/api/sourcing/exceptions/${third}/resolve`, { path: 'blocker', reason: 'Waiting on the new posting', blocker_due: ymd(5) })).status).toBe(200);
    const statusOf = async (id: string) => (await sql(`SELECT status, resolution_path, reason, resolved_at FROM sourcing_exceptions WHERE id=$1::bigint`, [id]))[0];
    expect([(await statusOf(li)).status, (await statusOf(second)).status, (await statusOf(third)).status]).toEqual(['open', 'snoozed', 'blocked']);
    const linkedinUrl = (await chRow(pid, 'LinkedIn')).config.posting_url as string;
    expect(linkedinUrl).toBeTruthy();

    const reason = 'LinkedIn is not producing for this role';
    const r = await post(request, hr, `/api/sourcing/exceptions/${li}/resolve`, { path: 'change_strategy', reason, exclude_channel: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    // the exception itself is resolved by the person; the channel's OTHER exceptions are cleared at once, as a close does
    expect(await statusOf(li)).toMatchObject({ status: 'resolved', resolution_path: 'change_strategy', reason });
    for (const id of [second, third]) {
      expect(await statusOf(id)).toMatchObject({ status: 'resolved', resolution_path: 'auto_cleared', reason: 'Channel closed' });
      expect((await statusOf(id)).resolved_at).toBeTruthy();
    }
    expect(await statusOf(nk)).toMatchObject({ status: 'open' });                                          // another channel's exceptions are not touched
    expect(await statusOf(ag)).toMatchObject({ status: 'open' });

    // the channel is CLOSED — not "left out": reported as closed, the resolution reason is the close reason, and the summary is kept
    const v = await plan(request, rid);
    const c = channel(v, 'LinkedIn');
    expect(c).toMatchObject({ state: 'closed', closed_reason: reason, excluded_reason: null });
    expect(c.closed_at).toBeTruthy();
    expect(c.targets.weekly_target).toBe(5);
    expect(c.config.posting_url).toBe(linkedinUrl);
    expect(c.tracker).toMatchObject({ applicable: true, target: 5, link: linkedinUrl, anchor: null, running: null });
    expect(c.tracker.weeks.map((w: Json) => [w.week_start, w.week_end, w.actual, w.partial])).toEqual([[ymd(-2), ymd(0), 2, true], [ymd(-9), ymd(-3), 4, false]]);
    expect(c.tracker.totals).toEqual({ weeks: 1, met: 0, actual: 4, target: 5 });
    expect(commitment(v, 'LinkedIn', 'renew_posting')).toMatchObject({ status: 'skipped', meta: expect.objectContaining({ closed_with_channel: true }) });
    expect(commitment(v, 'LinkedIn', 'activate_channel').status).toBe('done');
    expect(channel(v, 'Naukri/IIMjobs').state).toBe('active');                                              // the other channels carry on
    expect(commitment(v, 'Naukri/IIMjobs', 'renew_posting').status).toBe('open');
    // the history records the strategy change AND the close (weeks, weeks on target, applicants) — the same channel_closed entry Close channel writes
    expect(historyOf(v, 'strategy_changed')).toHaveLength(1);
    expect(historyOf(v, 'strategy_changed')[0]).toMatchObject({ by_name: 'Aaron Newton', reason, category: 'exception' });
    expect(historyOf(v, 'strategy_changed')[0].text).toContain('(channel dropped)');
    expect(historyOf(v, 'channel_closed')).toHaveLength(1);
    expect(historyOf(v, 'channel_closed')[0]).toMatchObject({ by_name: 'Aaron Newton', reason, category: 'channel' });
    expect(historyOf(v, 'channel_closed')[0].change).toMatchObject({ channel: 'LinkedIn', weeks: 1, weeks_met: 0 });
    // nothing is raised again for it, and a closed channel cannot be "added" — only reopened
    await cron(request); await cron(request);
    expect((await liveTaskExceptions(pid)).map(e => e.channel).sort()).toEqual(['Agency', 'Naukri/IIMjobs']);
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'LinkedIn', state: 'planned' })).status).toBe(409);
    expect((await reopenCh(request, pid, 'LinkedIn')).status).toBe(200);
    const back = await plan(request, rid);
    expect(channel(back, 'LinkedIn')).toMatchObject({ state: 'active', closed_at: null, closed_reason: null, excluded_reason: null });
    expect(commitment(back, 'LinkedIn', 'renew_posting').status).toBe('open');                              // what the close skipped comes back
    expect(commitment(back, 'LinkedIn', 'renew_posting').overdue).toBe(false);
    expect((await chRow(pid, 'LinkedIn')).anchor).toBe(ymd(0));                                              // the tracker restarts today
    expect(channel(back, 'LinkedIn').tracker.weeks).toHaveLength(2);                                         // nothing invented, nothing lost
    expect((await sql(`SELECT recruitment_mode FROM roles WHERE id=$1`, [rid]))[0].recruitment_mode).toContain('LinkedIn');
  });

  test('(r) "change strategy → drop the channel" on a channel that was LEFT OUT (not closed) leaves it exactly as it was, with the recruiter\'s own reason — the exception is still resolved', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Strategy on a left-out channel', [live('LinkedIn', 5), { channel: 'Agency' }]);
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'Agency', state: 'excluded', excluded_reason: 'No budget for agency fees' })).status).toBe(200);
    const before = await chRow(pid, 'Agency');
    expect(before).toMatchObject({ state: 'excluded', excluded_reason: 'No budget for agency fees', closed_at: null });
    const exId = await makeException(pid, 'Agency');
    const r = await post(request, hr, `/api/sourcing/exceptions/${exId}/resolve`, { path: 'change_strategy', reason: 'Dropping agencies for good', exclude_channel: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await sql(`SELECT status, resolution_path FROM sourcing_exceptions WHERE id=$1::bigint`, [exId]))[0]).toMatchObject({ status: 'resolved', resolution_path: 'change_strategy' });
    expect(await chRow(pid, 'Agency')).toEqual(before);                                                       // still LEFT OUT, its own reason, never turned into a close
    const v = await plan(request, rid);
    expect(channel(v, 'Agency')).toMatchObject({ state: 'excluded', excluded_reason: 'No budget for agency fees', closed_at: null, closed_reason: null });
    expect(channel(v, 'LinkedIn').state).toBe('active');
  });

  // ── (w) a fault in the weekly tracker never takes anything else down ───────────────────────────
  // Every caller of the weekly sync (a plan read, the engine, Close channel, Edit target and link, a role put On Hold or Closed) goes through
  // syncChannelWeeksSafe, which logs and swallows a failure. The API only ever stores a whole-number target, so a hand-edited row is the one way to
  // make the sync's own query fail: `(targets->>'weekly_target')::int` cannot read "abc" — and it fails for every plan while that row exists.
  const poison = (chId: string) => client.query(`UPDATE sourcing_plan_channels SET targets = '{"weekly_target":"abc"}'::jsonb WHERE id=$1::bigint`, [chId]);

  test('(w) a malformed weekly target makes the sync fail but never the plan read, the engine, the workspace, Close channel, a role put On Hold and back — and Edit target and link repairs it', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Tracker fault', [live('LinkedIn', 5), live('Naukri/IIMjobs', 4), { channel: 'Agency' }], { anchors: { LinkedIn: ymd(-9) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-5)), 4);                                                  // a finished week the sync would record
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '2 days' WHERE id=$1::bigint`, [await commitmentId(pid, 'Agency', 'activate_channel')]);
    const li = await chRow(pid, 'LinkedIn');
    await poison(li.id);
    // the plan still reads (it used to be a 500), and the bad channel simply has no usable target
    const read = await get(request, hr, `/api/sourcing/plans/${rid}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(channel(read.body, 'LinkedIn').tracker).toMatchObject({ target: null, running: null, weeks: [] });
    expect(channel(read.body, 'Naukri/IIMjobs').tracker).toMatchObject({ target: 4 });                   // the healthy channel is read as usual
    // the engine goes on detecting although its sync step failed: the overdue Agency task is flagged
    await cron(request);
    expect((await liveTaskExceptions(pid)).map(e => [e.channel, e.type])).toEqual([['Agency', 'CHANNEL_NOT_ACTIVATED']]);
    expect(await weekRows(pid, 'LinkedIn')).toEqual([]);                                                // nothing could be recorded — and nothing broke
    expect((await get(request, hr, '/api/sourcing/workspace')).status).toBe(200);
    expect((await get(request, hr, '/api/sourcing/queue')).status).toBe(200);
    // Close channel (the healthy one) and the hold / resume of the role still happen
    expect((await closeCh(request, pid, 'Naukri/IIMjobs')).status).toBe(200);
    expect(channel(await plan(request, rid), 'Naukri/IIMjobs').state).toBe('closed');
    await holdRole(request, rid);
    expect((await planRow(pid)).status).toBe('paused');
    await resumeRole(request, rid);
    expect((await planRow(pid)).status).toBe('active');
    // Edit target and link repairs the row (the bad value reads as "no target yet"), and the sync works again
    const fix = await settingsCh(request, pid, { channel: 'LinkedIn', weekly_target: 7 });
    expect(fix.status, JSON.stringify(fix.body)).toBe(200);
    expect((await chRow(pid, 'LinkedIn')).targets.weekly_target).toBe(7);
    await setAnchor(pid, 'LinkedIn', ymd(-9));                                                          // (the resume moved it to today)
    await plan(request, rid);
    expect(await weekRows(pid, 'LinkedIn')).toEqual([{ ws: ymd(-9), we: ymd(-3), target: 7, actual: 4, qualified: 0, partial: false }]);
  });

  test('(w) …and closing the role (every tracker stops) still closes the plan when the weekly sync is failing', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Tracker fault on close', [live('LinkedIn', 5), { channel: 'Agency' }], { anchors: { LinkedIn: ymd(-9) } });
    await addApps(rid, 'LinkedIn', noon(ymd(-5)), 2);
    await poison((await chRow(pid, 'LinkedIn')).id);
    await setRoleStatus(request, rid, 'Closed – Filled');
    const p = await planRow(pid);
    expect(p.status).toBe('closed');                                                                    // the role hook swallows its own errors, so the PLAN is what proves it ran
    expect((await sql(`SELECT count(*)::int AS n FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id=c.plan_channel_id WHERE ch.plan_id=$1::bigint AND c.status='open'`, [pid]))[0].n).toBe(0);
    expect((await chRow(pid, 'LinkedIn')).anchor).toBeNull();
    expect((await get(request, hr, `/api/sourcing/plans/${rid}`)).status).toBe(200);
  });

  // ── (x) a stop path racing the weekly sync ─────────────────────────────────────────────────────
  // FOUND WHILE WRITING THESE SPECS, since FIXED: `syncChannelWeeks` writes each finished week as its own autocommit INSERT, and that INSERT's
  // foreign-key check needs a KEY SHARE lock on the channel row. A stop path that records the same ended week INSIDE its transaction (leave a channel
  // out, resolve + exclude, reopen of a done first task, a channel removed from the role's Recruitment Mode) used to hold that channel row FOR UPDATE
  // while it inserted, so with a plan read or the engine running beside it the two waited for each other (the second INSERT of the same
  // (channel, week) waits for the first one's uncommitted row) and Postgres killed one with 40P01 — the stop request answered 500 in about 6 of 10
  // rounds. The channel row is now locked FOR NO KEY UPDATE everywhere (the plan row's lock still serialises the writers), which does not block a
  // foreign-key check, so a stop and a sync can no longer deadlock.
  test('(x) leaving a channel out while the weekly sync runs for the same plan always succeeds — never a deadlock (500) when a plan read or the engine runs beside it', async ({ request }) => {
    test.setTimeout(240_000);
    const statuses: number[] = [];
    for (let round = 0; round < 10; round++) {
      const { rid, pid } = await activeRole(request, `Sync race ${round}`, [live('LinkedIn', 5)], { anchors: { LinkedIn: ymd(-16) } });
      await addApps(rid, 'LinkedIn', noon(ymd(-12)), 1);                                                   // two finished weeks nobody has recorded yet: [-16,-10] and [-9,-3]
      const sweep = () => authed(request, CRON_SECRET).post('/api/cron/sourcing-check', {});
      const [stop] = await Promise.all([
        put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'LinkedIn', state: 'excluded', excluded_reason: 'Racing the weekly sync' }),
        get(request, hr, `/api/sourcing/plans/${rid}`), get(request, hr, `/api/sourcing/plans/${rid}`), get(request, hr, `/api/sourcing/plans/${rid}`), get(request, hr, `/api/sourcing/plans/${rid}`),
        sweep(), sweep(),
      ]);
      statuses.push(stop.status);
    }
    expect(statuses.filter(st => st !== 200), `PUT …/channel answered ${statuses.join(', ')}`).toEqual([]);
  });

  // ── (u) the data migration at the end of schema.sql ────────────────────────────────────────────
  // The first version of the tracker left data behind: Direct Outreach logged "weekly contacts" by hand (a count of CONTACTS, not what the
  // weekly tracker measures — APPLICANTS who named the channel on the form), live tracked channels that have no weekly target, and first tasks
  // that still carry the first version's wording. The migration
  //   1. sets every OPEN weekly_outbound commitment to 'skipped' (its log stays, the plan view hides it),
  //   2. retitles every OPEN first task (activate_channel) of a LinkedIn / Naukri/IIMjobs / Direct Outreach channel whose title does not already
  //      start with "Log the " — status and due date untouched — and
  //   3. re-opens the DONE first task of every live such channel that has no weekly target and no tracker start, on an active or paused plan —
  //      retitled, due 23:59:59.999 IST two calendar days from today — so HR is asked once for link + target.
  // It does NOT turn weekly_contacts into a target and starts no tracker. The specs run the REAL text from the repo (helpers/sourcing-db.ts), in a
  // transaction that is rolled back: the local database also holds real plans the migration would match, and it must not be changed here.
  type LegacyKey = 'A' | 'B' | 'C' | 'D' | 'E';
  const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  /** Rows shaped like production after the first version. A: the active plan with all five channels; B: a paused plan; C: a closed plan; D: a draft;
      E: an active plan whose tracked channels are only PLANNED, with their first task still open (old wording on two of them, the new wording on one). */
  const buildLegacyPlans = async (c: Client, which: LegacyKey[]) => {
    const out: Partial<Record<LegacyKey, { role: string; plan: string; outbound?: string }>> = {};
    for (const key of which) {
      const role = (await c.query(
        `INSERT INTO roles (title, department, hiring_manager_name, priority, status, location, employment_type, start_date, approval_date, recruitment_mode)
         VALUES ($1,'Tech/Devs','Alex','P1','Live – Sourcing','Gurgaon','Full-Time / Permanent', CURRENT_DATE - 3, CURRENT_DATE - 3, '{}'::text[]) RETURNING id`,
        [`Legacy tracker ${key} ${uid()}`])).rows[0].id as string;
      const plan = (await c.query(
        `INSERT INTO sourcing_plans (role_id, status, activated_at, baseline_at, paused_at, closed_at)
         VALUES ($1,$2, NOW() - INTERVAL '20 days', NOW() - INTERVAL '20 days', CASE WHEN $2 = 'paused' THEN NOW() ELSE NULL END, CASE WHEN $2 = 'closed' THEN NOW() ELSE NULL END) RETURNING id::text AS id`,
        [role, { A: 'active', B: 'paused', C: 'closed', D: 'draft', E: 'active' }[key]])).rows[0].id as string;
      const channelOf = async (channel: string, state: string, targets: Json, config: Json, anchor: string | null, closed = false) =>
        (await c.query(
          `INSERT INTO sourcing_plan_channels (plan_id, channel, state, targets, config, tracker_anchor, closed_at, closed_reason)
           VALUES ($1::bigint,$2,$3,$4::jsonb,$5::jsonb,$6::date,$7::timestamptz,$8) RETURNING id::text AS id`,
          [plan, channel, state, JSON.stringify(targets), JSON.stringify(config), anchor, closed ? new Date().toISOString() : null, closed ? 'Closed in the first version' : null])).rows[0].id as string;
      const commitmentOf = async (chId: string, kind: string, subject: string, title: string, status: string, dueHours: number, cadence: number | null) =>
        (await c.query(
          `INSERT INTO sourcing_commitments (plan_channel_id, kind, subject_key, title, cadence_days, due_at, last_done_at, status)
           VALUES ($1::bigint,$2,$3,$4,$5,$6::timestamptz, CASE WHEN $7 = 'done' THEN $6::timestamptz ELSE NULL END, $7) RETURNING id::text AS id`,
          [chId, kind, subject, title, cadence, hoursFromNow(dueHours), status])).rows[0].id as string;
      let outbound: string | undefined;
      if (key === 'A') {
        const agency = await channelOf('Agency', 'active', {}, {}, null);
        await commitmentOf(agency, 'activate_channel', '', 'Select agencies and share the role brief', 'done', -9 * 24, null);
        await commitmentOf(agency, 'followup_agency', 'all', 'Follow up with the briefed agencies', 'open', 3 * 24, 7);
        const referral = await channelOf('Internal Referral', 'active', {}, {}, null);
        await commitmentOf(referral, 'activate_channel', '', 'Launch the employee referral push', 'done', -9 * 24, null);
        await commitmentOf(referral, 'repost_referral', '', 'Repost the role to employees', 'open', 20 * 24, 30);
        const naukri = await channelOf('Naukri/IIMjobs', 'active', {}, { posted_at: ymd(-8) }, null);
        await commitmentOf(naukri, 'activate_channel', '', 'Post the role on Naukri/IIMjobs', 'done', -9 * 24, null);                     // the first version's title
        await commitmentOf(naukri, 'renew_posting', '', 'Renew the Naukri/IIMjobs posting before it expires', 'open', 20 * 24, 30);
        const outreach = await channelOf('Direct Outreach', 'active', { weekly_contacts: 25 }, {}, null);
        await commitmentOf(outreach, 'activate_channel', '', 'Start the direct outreach campaign', 'done', -9 * 24, null);
        outbound = await commitmentOf(outreach, 'weekly_outbound', 'weekly', 'Log this week’s outbound contacts', 'open', 2 * 24, 7);
        await c.query(`INSERT INTO sourcing_commitment_log (commitment_id, done_at, was_due_at, note) VALUES ($1::bigint, NOW() - INTERVAL '7 days', NOW() - INTERVAL '7 days', 'Contacts logged')`, [outbound]);
        const linkedin = await channelOf('LinkedIn', 'active', { weekly_target: 12 }, { posting_url: 'https://example.com/legacy/linkedin' }, ymd(-5));
        await commitmentOf(linkedin, 'activate_channel', '', 'Log the LinkedIn post (link and weekly sourcing target)', 'done', -9 * 24, null);
        await commitmentOf(linkedin, 'renew_posting', '', 'Renew the LinkedIn posting before it expires', 'open', 20 * 24, 30);
      } else if (key === 'B') {
        const outreach = await channelOf('Direct Outreach', 'active', {}, {}, null);                                                    // matches
        await commitmentOf(outreach, 'activate_channel', '', 'Start the direct outreach campaign', 'done', -9 * 24, null);
        const linkedin = await channelOf('LinkedIn', 'excluded', {}, {}, null, true);                                                  // closed: not live — does not match
        await commitmentOf(linkedin, 'activate_channel', '', 'Post the role on LinkedIn', 'done', -9 * 24, null);
        const naukri = await channelOf('Naukri/IIMjobs', 'active', {}, {}, ymd(-3));                                                   // a tracker start is set — does not match
        await commitmentOf(naukri, 'activate_channel', '', 'Post the role on Naukri/IIMjobs', 'done', -9 * 24, null);
      } else if (key === 'C') {
        const naukri = await channelOf('Naukri/IIMjobs', 'active', {}, {}, null);                                                      // closed plan — does not match
        await commitmentOf(naukri, 'activate_channel', '', 'Post the role on Naukri/IIMjobs', 'done', -9 * 24, null);
      } else if (key === 'E') {
        const naukri = await channelOf('Naukri/IIMjobs', 'planned', {}, {}, null);
        await commitmentOf(naukri, 'activate_channel', '', 'Publish the posting on Naukri/IIMjobs', 'open', 30, null);                 // the first version's title, still open: retitled
        const outreach = await channelOf('Direct Outreach', 'planned', {}, {}, null);
        await commitmentOf(outreach, 'activate_channel', '', 'Start outbound outreach and set the weekly contact target', 'open', 30, null);   // likewise
        const linkedin = await channelOf('LinkedIn', 'planned', {}, {}, null);
        await commitmentOf(linkedin, 'activate_channel', '', 'Log the LinkedIn post (link and weekly sourcing target)', 'open', 30, null);     // already says "Log the …": untouched
        const agency = await channelOf('Agency', 'planned', {}, {}, null);
        await commitmentOf(agency, 'activate_channel', '', 'Select agencies and share the role brief', 'open', 30, null);               // not a tracked channel: untouched
        const referral = await channelOf('Internal Referral', 'planned', {}, {}, null);
        await commitmentOf(referral, 'activate_channel', '', 'Launch the employee referral push', 'open', 30, null);
      } else {
        const outreach = await channelOf('Direct Outreach', 'active', {}, {}, null);                                                   // draft plan — does not match
        await commitmentOf(outreach, 'activate_channel', '', 'Start the direct outreach campaign', 'done', -9 * 24, null);
      }
      out[key] = { role, plan, outbound };
    }
    return out;
  };
  const legacySnapshot = async (c: Client, planIds: string[]) => (await c.query(
    `SELECT p.id::text AS plan_id, ch.channel, ch.state, ch.targets, ch.config, to_char(ch.tracker_anchor,'YYYY-MM-DD') AS anchor,
            c.kind, c.subject_key, c.status, c.title, c.due_at, c.last_done_at, c.cadence_days, c.meta
       FROM sourcing_plans p JOIN sourcing_plan_channels ch ON ch.plan_id = p.id JOIN sourcing_commitments c ON c.plan_channel_id = ch.id
      WHERE p.id = ANY($1::bigint[]) ORDER BY p.id, ch.channel, c.kind, c.subject_key`, [planIds])).rows as Json[];
  const rowKey = (r: Json) => `${r.plan_id}|${r.channel}|${r.kind}|${r.subject_key}`;
  let migratedA: Array<{ channel: string; kind: string; subject_key: string; status: string; title: string; due_at: Date }> = [];

  test('(u) the migration: open weekly_outbound tasks are skipped, an open first task with the old wording is retitled in place, the done first task of a live tracked channel without a target is re-opened (new title, due 23:59:59.999 IST on today + 2) — nothing else changes, no tracker starts, running it twice changes nothing', async () => {
    const migration = trackerMigrationSql();
    expect(migration.startsWith('-- Data left behind by the first version of the tracker')).toBe(true);
    const global = async () => (await sql(`SELECT count(*) FILTER (WHERE kind='weekly_outbound' AND status='open')::int AS wo, count(*) FILTER (WHERE status='open')::int AS open, count(*)::int AS total FROM sourcing_commitments`))[0];
    const globalBefore = await global();
    let roles: string[] = [];
    let before: Json[] = [], after: Json[] = [], twice: Json[] = [];
    let outbound = '', logRows = { before: 0, after: 0 };
    let planOf: Record<string, string> = {};
    let handed: { once: Json[]; twice: Json[] } = { once: [], twice: [] };
    await client.query('BEGIN');
    try {
      const fx = await buildLegacyPlans(client, ['A', 'B', 'C', 'D', 'E']);
      roles = Object.values(fx).map(f => f!.role);
      planOf = Object.fromEntries(Object.entries(fx).map(([k, f]) => [k, f!.plan]));
      outbound = fx.A!.outbound!;
      const plans = Object.values(planOf);
      before = await legacySnapshot(client, plans);
      logRows.before = Number((await client.query(`SELECT count(*) AS n FROM sourcing_commitment_log WHERE commitment_id=$1::bigint`, [outbound])).rows[0].n);
      const handedBack = async () => (await client.query(
        `SELECT plan_id::text AS plan_id, "by" AS by, change, reason FROM sourcing_plan_changes WHERE plan_id = ANY($1::bigint[]) AND change->>'type' = 'task_handed_back'`, [plans])).rows as Json[];
      expect(await handedBack(), 'nothing is in the history before the migration runs').toEqual([]);
      await client.query(migration);
      handed.once = await handedBack();
      after = await legacySnapshot(client, plans);
      logRows.after = Number((await client.query(`SELECT count(*) AS n FROM sourcing_commitment_log WHERE commitment_id=$1::bigint`, [outbound])).rows[0].n);
      await client.query(migration);
      handed.twice = await handedBack();
      twice = await legacySnapshot(client, plans);
    } finally {
      await client.query('ROLLBACK');
    }
    // the fixture lived and died inside the transaction; the real data was never touched
    expect((await client.query(`SELECT 1 FROM roles WHERE id = ANY($1::text[])`, [roles])).rowCount).toBe(0);
    expect(await global()).toEqual(globalBefore);

    const T = new Date(`${ymd(2)}T23:59:59.999+05:30`).getTime();
    const b = new Map(before.map(r => [rowKey(r), r]));
    const a = new Map(after.map(r => [rowKey(r), r]));
    expect([...a.keys()]).toEqual([...b.keys()]);                                                       // no row was added or removed
    expect(before.length).toBe(20);
    // reopened = a DONE first task brought back (due on today + 2); the others only change what the statement says
    const changed: Record<string, { status: string; title?: string; reopened?: boolean }> = {
      [`${planOf.A}|Naukri/IIMjobs|activate_channel|`]: { status: 'open', title: 'Log the Naukri/IIMjobs post (link and weekly sourcing target)', reopened: true },
      [`${planOf.A}|Direct Outreach|activate_channel|`]: { status: 'open', title: 'Log the Direct Outreach campaign (link and weekly sourcing target)', reopened: true },
      [`${planOf.A}|Direct Outreach|weekly_outbound|weekly`]: { status: 'skipped' },
      [`${planOf.B}|Direct Outreach|activate_channel|`]: { status: 'open', title: 'Log the Direct Outreach campaign (link and weekly sourcing target)', reopened: true },
      // a first task still OPEN with the first version's title is only retitled: still open, and its due date is where it was
      [`${planOf.E}|Naukri/IIMjobs|activate_channel|`]: { status: 'open', title: 'Log the Naukri/IIMjobs post (link and weekly sourcing target)' },
      [`${planOf.E}|Direct Outreach|activate_channel|`]: { status: 'open', title: 'Log the Direct Outreach campaign (link and weekly sourcing target)' },
    };
    for (const [k, was] of b) {
      const now = a.get(k)!;
      const want = changed[k];
      if (!want) { expect(now, `${k} is untouched`).toEqual(was); continue; }
      expect(now.status, k).toBe(want.status);
      if (want.title) expect(now.title, k).toBe(want.title);
      if (want.reopened) {
        expect(new Date(now.due_at).getTime(), `${k} is due 23:59:59.999 IST on today + 2`).toBe(T);
        expect(was.status, k).toBe('done');
      } else if (want.title) {
        expect(was.status, k).toBe('open');
        expect(new Date(now.due_at).getTime(), `${k}: a retitled open task keeps its due date`).toBe(new Date(was.due_at).getTime());
        expect(now.title, k).not.toBe(was.title);
      }
      // only status / title / due date moved: the channel's state, targets, config and tracker start are exactly as they were — no tracker was started
      expect({ ...now, status: was.status, title: was.title, due_at: was.due_at }, k).toEqual(was);
    }
    // named explicitly: the tracked first task that already says "Log the …", and the non-tracked channels' open first tasks, were not touched
    for (const ch of ['LinkedIn', 'Agency', 'Internal Referral']) expect(a.get(`${planOf.E}|${ch}|activate_channel|`), `${ch} on plan E`).toEqual(b.get(`${planOf.E}|${ch}|activate_channel|`));
    // a channel with its own weekly target, and the non-tracked live channels, were left alone on plan A as well
    for (const k of [`${planOf.A}|LinkedIn|activate_channel|`, `${planOf.A}|Agency|activate_channel|`, `${planOf.A}|Internal Referral|activate_channel|`]) expect(a.get(k), k).toEqual(b.get(k));
    expect(Object.keys(changed).every(k => b.has(k))).toBe(true);
    // Direct Outreach's weekly_contacts is NOT turned into a target, and the retired task's completion log is kept
    expect(a.get(`${planOf.A}|Direct Outreach|activate_channel|`)!.targets).toEqual({ weekly_contacts: 25 });
    expect(logRows).toEqual({ before: 1, after: 1 });
    // idempotent: the matched rows are no longer 'done' / 'open', so a second run finds nothing
    expect(twice).toEqual(after);

    // the plan history says why a finished task is open again: exactly one "task handed back" entry per re-opened task — written by the system, in
    // the same statement — and none for the retitled open tasks, the skipped weekly task or anything left alone; a second run adds none
    const handedKeys = (rows: Json[]) => rows.map(h => `${h.plan_id}|${h.change.channel}`).sort();
    expect(handedKeys(handed.once)).toEqual([`${planOf.A}|Direct Outreach`, `${planOf.A}|Naukri/IIMjobs`, `${planOf.B}|Direct Outreach`].sort());
    for (const h of handed.once) {
      expect(h.by, 'a system entry has no author').toBeNull();
      expect(h.change.type).toBe('task_handed_back');
      expect(h.change.commitment).toBe(h.change.channel === 'Direct Outreach' ? 'Log the Direct Outreach campaign (link and weekly sourcing target)' : `Log the ${h.change.channel} post (link and weekly sourcing target)`);
      expect(h.reason).toMatch(/weekly-tracker release/);
    }
    expect(handedKeys(handed.twice)).toEqual(handedKeys(handed.once));

    migratedA = after.filter(r => r.plan_id === planOf.A && (changed[rowKey(r)])).map(r => ({ channel: r.channel, kind: r.kind, subject_key: r.subject_key, status: r.status, title: r.title, due_at: r.due_at }));
    expect(migratedA).toHaveLength(3);
  });

  test('(u) after the migration the plan view hides the retired weekly_outbound row and shows the re-opened first task; the engine chases it, and completing it with a link and a target starts the tracker', async ({ request }) => {
    expect(migratedA, 'the previous test hands over the rows exactly as the real migration left them').toHaveLength(3);
    const fx = await buildLegacyPlans(client, ['A']);                                                  // committed (and removed in afterAll)
    const { role: rid, plan: pid, outbound } = fx.A!;
    roleIds.push(rid);
    // bring the committed copy to the state the migration produced (taken from the rolled-back run above, so not re-typed by hand)
    for (const m of migratedA) {
      await client.query(
        `UPDATE sourcing_commitments c SET status=$5, title=$6, due_at=$7::timestamptz FROM sourcing_plan_channels ch
          WHERE c.plan_channel_id = ch.id AND ch.plan_id=$1::bigint AND ch.channel=$2 AND c.kind=$3 AND c.subject_key=$4`,
        [pid, m.channel, m.kind, m.subject_key, m.status, m.title, m.due_at]);
    }
    let v = await plan(request, rid);
    expect(v.plan.status).toBe('active');
    const dop = channel(v, 'Direct Outreach'), nk = channel(v, 'Naukri/IIMjobs');
    // the retired weekly_outbound task is in the database (skipped, with its log) but not in the plan view
    expect((dop.commitments as Json[]).map(m => m.kind)).toEqual(['activate_channel']);
    expect(await commitmentRow(outbound!)).toMatchObject({ status: 'skipped', title: 'Log this week’s outbound contacts' });
    expect(await logRowsOf(outbound!)).toHaveLength(1);
    // the re-opened first tasks are asked for, due in two days (not overdue)
    expect(commitment(v, 'Direct Outreach', 'activate_channel')).toMatchObject({ status: 'open', title: 'Log the Direct Outreach campaign (link and weekly sourcing target)', due_date: ymd(2), overdue: false });
    expect(commitment(v, 'Naukri/IIMjobs', 'activate_channel')).toMatchObject({ status: 'open', title: 'Log the Naukri/IIMjobs post (link and weekly sourcing target)', due_date: ymd(2), overdue: false });
    expect(commitment(v, 'Naukri/IIMjobs', 'renew_posting').status).toBe('open');                       // its follow-on is untouched
    // live, but nothing is measured yet — and the old "weekly contacts" is not mistaken for a target
    expect(dop.targets).toEqual({ weekly_contacts: 25 });
    expect(dop.tracker).toMatchObject({ applicable: true, target: null, link: null, anchor: null, running: null, weeks: [] });
    expect(nk.tracker).toMatchObject({ applicable: true, target: null, link: null, anchor: null, running: null, weeks: [] });
    expect(channel(v, 'LinkedIn').tracker).toMatchObject({ target: 12, anchor: ymd(-5) });             // a channel with a target is exactly as it was
    expect(channel(v, 'Agency').state).toBe('active');
    expect(await liveTaskExceptions(pid)).toEqual([]);

    // the task is chased: once it is overdue the channel is flagged as not live …
    const doTask = await commitmentId(pid, 'Direct Outreach', 'activate_channel');
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '1 day' WHERE id=$1::bigint`, [doTask]);
    await cron(request);
    expect((await liveTaskExceptions(pid)).map(e => [e.channel, e.type])).toEqual([['Direct Outreach', 'CHANNEL_NOT_ACTIVATED']]);
    // … and it asks for BOTH the link and the weekly sourcing target
    const complete = (body: Json) => post(request, hr, `/api/sourcing/commitments/${doTask}/complete`, body);
    expect((await complete({})).status).toBe(400);
    const noTarget = await complete({ url: POST_URL });
    expect(noTarget.status).toBe(400);
    expect(String(noTarget.body.error)).toMatch(/weekly sourcing target/i);
    expect((await chRow(pid, 'Direct Outreach')).anchor).toBeNull();
    const ok = await complete({ url: POST_URL, weekly_target: 15 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await chRow(pid, 'Direct Outreach')).toMatchObject({ state: 'active', anchor: ymd(0) });
    expect((await chRow(pid, 'Direct Outreach')).targets).toEqual({ weekly_contacts: 25, weekly_target: 15 });
    v = await plan(request, rid);
    expect(channel(v, 'Direct Outreach').tracker).toMatchObject({ target: 15, link: POST_URL, anchor: ymd(0) });
    expect(channel(v, 'Direct Outreach').tracker.running).toEqual({ start: ymd(0), end: ymd(6), actual: 0, qualified: 0, target: 15 });
    expect(commitment(v, 'Direct Outreach', 'activate_channel').status).toBe('done');
    await cron(request);
    expect(await liveTaskExceptions(pid)).toEqual([]);                                                  // the flag cleared by itself
    // the other channel is fixed through "Edit target and link" instead — which completes the re-opened task too
    expect((await settingsCh(request, pid, { channel: 'Naukri/IIMjobs', weekly_target: 9, posting_url: `${POST_URL}/naukri` })).status).toBe(200);
    v = await plan(request, rid);
    expect(commitment(v, 'Naukri/IIMjobs', 'activate_channel').status).toBe('done');
    expect(channel(v, 'Naukri/IIMjobs').tracker).toMatchObject({ target: 9, link: `${POST_URL}/naukri`, anchor: ymd(0) });
  });
});
