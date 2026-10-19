// ─────────────────────────────────────────────────────────────────────────────
// Sourcing Execution & Accountability module (docs/SourcingModule_PRD_v2.md) — plan lifecycle, the exception
// engine, the three resolution paths, role-change hooks, Hiring Manager redaction and non-disruption.
//
// Needs the backend started with SOURCING_ENABLED=true (docker-compose passes it through:
//   SOURCING_ENABLED=true docker compose up -d backend). Without it the whole file skips — the module is inert by
// design. Real overdue states are made the way tests/db/09 does it: backdate a timestamp, then run the engine through
// /api/cron/sourcing-check. INTENTIONALLY LOCAL-ONLY, like the other tests/db specs (direct Postgres access).
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { getToken, authed, CRON_SECRET, BASE, CANDIDATE_INGEST_SECRET, uid } from '../helpers/api';

const LOCAL_DB_URL = 'postgresql://hms_user:hms_password@localhost:5432/dp_hms';
const SENTINEL = 'SENTINEL-note-must-not-reach-a-hiring-manager';
const SENTINEL_URL = 'https://example.com/SENTINEL-url';

type Json = Record<string, any>;

test.describe('Sourcing module', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let client: Client;
  let enabled = false;
  const roleIds: string[] = [];
  const candidateEmails: string[] = [];
  let hr: string, hr2: string, alex: string, satyadev: string, lead: string;
  let aaronId = '';
  let savedSettings: Array<{ key: string; value: unknown }> = [];

  // Primary throwaway role: P1, Alex is the named Hiring Manager, LinkedIn + Agency seeded from recruitment_mode.
  let roleId = '', planId = '';
  const ids: Record<string, string> = {};

  const newRole = async (o: { title?: string; priority?: string; hm?: string; modes?: string[]; status?: string } = {}) => {
    const { rows } = await client.query(
      `INSERT INTO roles (title, department, hiring_manager_name, priority, status, location, employment_type, start_date, approval_date, recruitment_mode)
       VALUES ($1,'Tech/Devs',$2,$3,$4,'Gurgaon','Full-Time / Permanent', CURRENT_DATE - 3, CURRENT_DATE - 3, $5::text[]) RETURNING id`,
      [`${o.title ?? 'Sourcing Test Role'} ${uid()}`, o.hm ?? 'Alex', o.priority ?? 'P1', o.status ?? 'Live – Sourcing', o.modes ?? ['LinkedIn', 'Agency']]);
    roleIds.push(rows[0].id);
    return rows[0].id as string;
  };
  const get = async (request: any, tok: string, path: string) => { const r = await authed(request, tok).get(path); return { status: r.status(), body: (await r.json().catch(() => ({}))) as Json }; };
  const post = async (request: any, tok: string, path: string, data: object = {}) => { const r = await authed(request, tok).post(path, data); return { status: r.status(), body: (await r.json().catch(() => ({}))) as Json }; };
  const put = async (request: any, tok: string, path: string, data: object) => {
    const r = await request.put(`${BASE}${path}`, { headers: { Authorization: `Bearer ${tok}` }, data });
    return { status: r.status(), body: (await r.json().catch(() => ({}))) as Json };
  };
  const cron = async (request: any) => {
    const r = await authed(request, CRON_SECRET).post('/api/cron/sourcing-check', {});
    expect(r.status()).toBe(200);
    return (await r.json()) as Json;
  };
  const plan = async (request: any, tok = hr, rid = roleId) => (await get(request, tok, `/api/sourcing/plans/${rid}`)).body;
  const channel = (view: Json, name: string) => (view.channels as Json[]).find(c => c.channel === name)!;
  const commitment = (view: Json, ch: string, kind: string) => (channel(view, ch).commitments as Json[]).find(m => m.kind === kind)!;
  const liveExceptions = async (pid = planId) =>
    (await client.query(`SELECT id::text, channel, type, status, is_shadow, reopen_count, resolution_path FROM sourcing_exceptions WHERE plan_id=$1 AND status IN ('open','snoozed','blocked') ORDER BY id`, [pid])).rows;
  const ymd = (offsetDays: number) => new Date(Date.now() + 5.5 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);

  test.beforeAll(async ({ request }) => {
    client = new Client({ connectionString: LOCAL_DB_URL });
    await client.connect();
    const status = await request.get(`${BASE}/api/sourcing/status`, { headers: { Authorization: `Bearer ${await getToken(request, 'hr')}` } });
    enabled = status.ok() && (await status.json()).enabled === true;
    if (!enabled) return;
    hr = await getToken(request, 'hr'); hr2 = await getToken(request, 'hr2'); alex = await getToken(request, 'hm_alex');
    satyadev = await getToken(request, 'hm_satyadev'); lead = await getToken(request, 'leadership');
    aaronId = (await client.query(`SELECT id FROM users WHERE email='aaron.newton@digitalpaani.com'`)).rows[0].id;
    savedSettings = (await client.query(`SELECT key, value FROM sourcing_settings`)).rows;
    roleId = await newRole();
  });

  test.beforeEach(() => { test.skip(!enabled, 'SOURCING_ENABLED is not true on the backend — module is inert by design'); });

  test.afterAll(async () => {
    if (!client) return;
    try { await client.query(`ALTER TABLE IF EXISTS sourcing_plans_tmp RENAME TO sourcing_plans`); } catch { /* already restored */ }
    if (enabled) {
      await client.query(`DELETE FROM sourcing_settings WHERE key = ANY($1)`, [['shadow_until', 'go_live_date', 'qualified_rule', 'digest_recipients', 'daily_digest_enabled']]);
      for (const s of savedSettings.filter(s => ['shadow_until', 'go_live_date', 'qualified_rule'].includes(s.key))) {
        await client.query(`INSERT INTO sourcing_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [s.key, JSON.stringify(s.value)]);
      }
      if (roleIds.length) {
        await client.query(`DELETE FROM applications WHERE role_id = ANY($1)`, [roleIds]);
        await client.query(`DELETE FROM roles WHERE id = ANY($1)`, [roleIds]);                   // plans cascade
      }
      if (candidateEmails.length) await client.query(`DELETE FROM candidates WHERE email = ANY($1)`, [candidateEmails]);
    }
    await client.end();
  });

  // ── Seeding & access ────────────────────────────────────────────────────────────────────────────
  test('an open role gets a DRAFT plan seeded from recruitment_mode — and a draft commits nothing', async ({ request }) => {
    const v = await plan(request);
    planId = v.plan.id;
    expect(v.plan.status).toBe('draft');
    expect((v.channels as Json[]).map(c => `${c.channel}:${c.state}`).sort()).toEqual(['Agency:planned', 'LinkedIn:planned']);
    expect((v.channels as Json[]).flatMap(c => c.commitments)).toEqual([]);
    expect(v.exceptions.filter((e: Json) => e.type !== 'VOLUME_GAP')).toEqual([]);
  });

  test('a role that is not open (Draft) has no plan and a lookup does not invent one', async ({ request }) => {
    const draft = await newRole({ status: 'Draft' });
    const r = await get(request, hr, `/api/sourcing/plans/${draft}`);
    expect(r.status).toBe(200);
    expect(r.body.plan).toBeNull();
    expect((await client.query(`SELECT 1 FROM sourcing_plans WHERE role_id=$1`, [draft])).rowCount).toBe(0);
  });

  test('the named Hiring Manager gets a read-only REDACTED view; another HM is refused; HM cannot write', async ({ request }) => {
    const mine = await get(request, alex, `/api/sourcing/plans/${roleId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.read_only).toBe(true);
    expect(mine.body.plan.strategy_note).toBeNull();
    expect(mine.body.changes).toEqual([]);
    expect((await get(request, satyadev, `/api/sourcing/plans/${roleId}`)).status).toBe(403);
    expect((await post(request, alex, `/api/sourcing/plans/${planId}/activate`, { channels: [{ channel: 'LinkedIn' }] })).status).toBe(403);
    expect((await get(request, alex, '/api/sourcing/queue')).status).toBe(403);
    expect((await get(request, alex, '/api/sourcing/people')).status).toBe(403);
    expect((await get(request, lead, `/api/sourcing/plans/${roleId}`)).status).toBe(200);        // Leadership is HR-tier
  });

  test('activation is validated: channels, reasons, ids — and there is no owner to give', async ({ request }) => {
    const act = (b: object) => post(request, hr, `/api/sourcing/plans/${planId}/activate`, b);
    expect((await act({ channels: [] })).status).toBe(400);
    expect((await act({ channels: [{ channel: 'LinkedIn', exclude_reason: '  ' }] })).status).toBe(400);
    expect((await act({ channels: [{ channel: 'LinkedIn', exclude_reason: 'no budget' }] })).status).toBe(400);   // nothing left in the plan
    expect((await act({ channels: [{ channel: 'Telegram' }] })).status).toBe(400);
    expect((await act({ channels: [{ channel: 'LinkedIn' }, { channel: 'LinkedIn' }] })).status).toBe(400);
    expect((await post(request, hr, `/api/sourcing/plans/not-a-number/activate`, {})).status).toBe(400);
    expect((await plan(request)).plan.status).toBe('draft');                                                                              // every failure left it a draft
  });

  // ── Activation ──────────────────────────────────────────────────────────────────────────────────
  test('activation: attest-all completes running channels, anchors due dates to TODAY, mirrors the role and freezes a baseline', async ({ request }) => {
    const posted = ymd(-6);
    const r = await post(request, hr, `/api/sourcing/plans/${planId}/activate`, {
      strategy_note: SENTINEL,
      channels: [
        { channel: 'LinkedIn', already_running: true, posted_at: posted, url: SENTINEL_URL },
        { channel: 'Agency' },
        { channel: 'Naukri/IIMjobs' },
        { channel: 'Internal Referral', exclude_reason: 'Not needed for this role' },
      ],
    });
    expect(r.status).toBe(200);

    const v = await plan(request);
    expect(v.plan.status).toBe('active');
    expect(v.plan).not.toHaveProperty('owner_name');                                                  // sourcing belongs to the HR persona, not to a person
    expect(v.plan).not.toHaveProperty('owner_user_id');
    expect(JSON.stringify(v.plan.baseline)).not.toContain('owner');
    expect(v.plan.baseline.channels.map((c: Json) => c.channel).sort()).toEqual(['Agency', 'Internal Referral', 'LinkedIn', 'Naukri/IIMjobs']);
    expect(channel(v, 'LinkedIn').state).toBe('active');
    expect(commitment(v, 'LinkedIn', 'activate_channel').status).toBe('done');
    // the renewal clock starts at the posting's own date (30 days live − 3 days lead = 27 days)
    const renew = commitment(v, 'LinkedIn', 'renew_posting');
    expect(renew.status).toBe('open');
    expect(renew.due_date).toBe(new Date(new Date(`${posted}T12:00:00Z`).getTime() + 27 * 86400000).toISOString().slice(0, 10));
    expect(channel(v, 'Agency').commitments).toHaveLength(1);
    expect(commitment(v, 'Agency', 'activate_channel').due_date >= ymd(1)).toBe(true);          // never "already overdue" on activation day
    expect(channel(v, 'Internal Referral').state).toBe('excluded');
    expect(channel(v, 'Internal Referral').commitments).toEqual([]);

    // one-way plan → role mirror, through the same audit trail the role PATCH writes
    const mode = (await client.query(`SELECT recruitment_mode FROM roles WHERE id=$1`, [roleId])).rows[0].recruitment_mode as string[];
    expect(mode).toContain('Naukri/IIMjobs');
    expect((await client.query(`SELECT 1 FROM role_edit_log WHERE role_id=$1 AND field_name='recruitment_mode' AND changed_by=$2`, [roleId, aaronId])).rowCount).toBeGreaterThan(0);
    expect((await client.query(`SELECT 1 FROM sourcing_plan_changes WHERE plan_id=$1 AND change->>'type'='activated'`, [planId])).rowCount).toBe(1);

    expect((await post(request, hr, `/api/sourcing/plans/${planId}/activate`, { channels: [{ channel: 'LinkedIn' }] })).status).toBe(409);   // already active
    ids.agencyActivate = commitment(v, 'Agency', 'activate_channel').id;
    ids.naukriActivate = commitment(v, 'Naukri/IIMjobs', 'activate_channel').id;
    ids.linkedinRenew = renew.id;
  });

  test('completing a channel activation spawns that channel\'s follow-on; completing twice is refused', async ({ request }) => {
    const done = await post(request, hr, `/api/sourcing/commitments/${ids.naukriActivate}/complete`, { url: 'https://www.naukri.com/job-listings-test', posted_at: ymd(0) });
    expect(done.status).toBe(200);
    const v = await plan(request);
    expect(channel(v, 'Naukri/IIMjobs').state).toBe('active');
    const renew = commitment(v, 'Naukri/IIMjobs', 'renew_posting');
    expect(renew.cadence_days).toBe(30);
    expect(renew.due_date).toBe(ymd(27));
    expect((await post(request, hr, `/api/sourcing/commitments/${ids.naukriActivate}/complete`, {})).status).toBe(409);
    expect((await post(request, hr, `/api/sourcing/commitments/${ids.naukriActivate}/complete`, { url: 'javascript:alert(1)' })).status).toBe(409);
    expect((await post(request, hr, `/api/sourcing/commitments/${ids.agencyActivate}/complete`, { url: 'javascript:alert(1)' })).status).toBe(400);   // non-http evidence refused
    expect((await post(request, hr, `/api/sourcing/commitments/999999999/complete`, {})).status).toBe(404);
  });

  test('a rolling commitment re-arms from the moment it was completed', async ({ request }) => {
    const before = await client.query(`SELECT due_at FROM sourcing_commitments WHERE id=$1`, [ids.linkedinRenew]);
    expect((await post(request, hr, `/api/sourcing/commitments/${ids.linkedinRenew}/complete`, { note: 'Refreshed the posting', posted_at: ymd(0) })).status).toBe(200);
    const v = await plan(request);
    const renew = commitment(v, 'LinkedIn', 'renew_posting');
    expect(renew.status).toBe('open');                                  // still open — it is rolling, never "done"
    expect(renew.due_date).toBe(ymd(27));
    expect(new Date(renew.due_at).getTime()).toBeGreaterThan(new Date(before.rows[0].due_at).getTime());
    expect(renew.recent.length).toBeGreaterThan(0);
    expect(renew.recent[0].on_time).toBe(true);
  });

  // ── The engine ──────────────────────────────────────────────────────────────────────────────────
  test('engine: an overdue activation raises exactly one CHANNEL_NOT_ACTIVATED; reruns and 6 concurrent runs never duplicate it', async ({ request }) => {
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '2 days' WHERE id=$1`, [ids.agencyActivate]);
    await cron(request);
    let live = (await liveExceptions()).filter(e => e.type !== 'VOLUME_GAP');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ channel: 'Agency', type: 'CHANNEL_NOT_ACTIVATED', status: 'open', is_shadow: false });
    const firstId = live[0].id;

    await Promise.all(Array.from({ length: 6 }, () => cron(request)));
    live = (await liveExceptions()).filter(e => e.type !== 'VOLUME_GAP');
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(firstId);
    const dupes = await client.query(`SELECT channel, type, subject_key, count(*) FROM sourcing_exceptions WHERE plan_id=$1 AND status IN ('open','snoozed','blocked') GROUP BY 1,2,3 HAVING count(*) > 1`, [planId]);
    expect(dupes.rowCount).toBe(0);
    ids.exAgency = firstId;
  });

  test('engine: several overdue commitments on one channel roll up into ONE exception at the worst type', async ({ request }) => {
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '3 days' WHERE id=$1`, [ids.linkedinRenew]);
    const extra = await client.query(
      `INSERT INTO sourcing_commitments (plan_channel_id, kind, subject_key, title, cadence_days, due_at, status)
       SELECT id, 'activate_channel', 'extra', 'Second thing on LinkedIn', NULL, NOW() - INTERVAL '1 day', 'open' FROM sourcing_plan_channels WHERE plan_id=$1 AND channel='LinkedIn' RETURNING id`, [planId]);
    await cron(request);
    const linked = (await liveExceptions()).filter(e => e.channel === 'LinkedIn');
    expect(linked).toHaveLength(1);
    expect(linked[0].type).toBe('CHANNEL_NOT_ACTIVATED');                // the worst of the two
    const view = await plan(request);
    const ex = (view.exceptions as Json[]).find(e => e.channel === 'LinkedIn')!;
    expect(ex.evidence.count).toBe(2);
    await client.query(`DELETE FROM sourcing_commitments WHERE id=$1`, [extra.rows[0].id]);
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() + INTERVAL '20 days' WHERE id=$1`, [ids.linkedinRenew]);
    await cron(request);
    expect((await liveExceptions()).filter(e => e.channel === 'LinkedIn')).toHaveLength(0);            // auto-cleared once no longer true
    const cleared = await client.query(`SELECT resolution_path FROM sourcing_exceptions WHERE plan_id=$1 AND channel='LinkedIn' ORDER BY id DESC LIMIT 1`, [planId]);
    expect(cleared.rows[0].resolution_path).toBe('auto_cleared');
  });

  // ── Resolution paths ────────────────────────────────────────────────────────────────────────────
  test('resolution 1 — catch up: needs a date within 14 days; stays snoozed through engine runs; re-opens when the date lapses', async ({ request }) => {
    const res = (b: object) => post(request, hr, `/api/sourcing/exceptions/${ids.exAgency}/resolve`, b);
    expect((await res({ path: 'catch_up', reason: 'sending the brief tomorrow' })).status).toBe(400);
    expect((await res({ path: 'catch_up', reason: 'ok', snooze_until: ymd(-1) })).status).toBe(400);
    expect((await res({ path: 'catch_up', reason: 'ok', snooze_until: ymd(15) })).status).toBe(400);
    expect((await res({ path: 'catch_up', reason: '' , snooze_until: ymd(2) })).status).toBe(400);
    expect((await res({ path: 'teleport', reason: 'ok' })).status).toBe(400);
    expect((await res({ path: 'catch_up', reason: 'sending the brief tomorrow', snooze_until: ymd(2) })).status).toBe(200);

    await cron(request); await cron(request);
    let live = (await liveExceptions()).filter(e => e.channel === 'Agency');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: ids.exAgency, status: 'snoozed', resolution_path: 'catch_up' });

    await client.query(`UPDATE sourcing_exceptions SET snooze_until = CURRENT_DATE - 1 WHERE id=$1`, [ids.exAgency]);
    await cron(request);
    live = (await liveExceptions()).filter(e => e.channel === 'Agency');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: ids.exAgency, status: 'open' });
    expect(Number(live[0].reopen_count)).toBe(1);
  });

  test('resolution 3 — blocker: needs owner + deadline; no duplicate while blocked; BLOCKER_OVERDUE once the deadline passes', async ({ request }) => {
    const res = (b: object) => post(request, hr, `/api/sourcing/exceptions/${ids.exAgency}/resolve`, b);
    expect((await res({ path: 'blocker', reason: 'waiting on agency contract' })).status).toBe(400);
    expect((await res({ path: 'blocker', reason: 'x', blocker_due: ymd(61) })).status).toBe(400);
    expect((await res({ path: 'blocker', reason: 'waiting on agency contract', blocker_due: ymd(5), blocker_owner_user_id: aaronId })).status).toBe(200);
    await cron(request);
    let live = (await liveExceptions()).filter(e => e.channel === 'Agency');
    expect(live).toHaveLength(1);
    expect(live[0].status).toBe('blocked');

    await client.query(`UPDATE sourcing_exceptions SET blocker_due = CURRENT_DATE - 2 WHERE id=$1`, [ids.exAgency]);
    await cron(request);
    live = (await liveExceptions()).filter(e => e.channel === 'Agency');
    expect(live.map(e => e.type).sort()).toEqual(['BLOCKER_OVERDUE', 'CHANNEL_NOT_ACTIVATED']);
  });

  test('resolution 2 — change strategy: logged with a reason, can drop the channel, and the engine does not recreate it', async ({ request }) => {
    const res = await post(request, hr, `/api/sourcing/exceptions/${ids.exAgency}/resolve`, { path: 'change_strategy', reason: 'Agencies are not right for this role', exclude_channel: true });
    expect(res.status).toBe(200);
    await cron(request);
    const v = await plan(request);
    expect(channel(v, 'Agency').state).toBe('excluded');
    expect(channel(v, 'Agency').commitments.every((m: Json) => m.status === 'skipped')).toBe(true);
    // the BLOCKER_OVERDUE row is keyed to the blocked one, which is now resolved ⇒ it clears too
    expect((await liveExceptions()).filter(e => e.channel === 'Agency')).toHaveLength(0);
    expect((await client.query(`SELECT 1 FROM sourcing_plan_changes WHERE plan_id=$1 AND change->>'type'='strategy_changed' AND reason LIKE 'Agencies%'`, [planId])).rowCount).toBe(1);
    expect((await post(request, hr, `/api/sourcing/exceptions/${ids.exAgency}/resolve`, { path: 'catch_up', reason: 'again', snooze_until: ymd(2) })).status).toBe(409);   // already resolved
  });

  // ── Volume gap: provisional until the shadow period ends ────────────────────────────────────────
  test('VOLUME_GAP is provisional (dashboard only) during the shadow period, and a draft plan never goes live', async ({ request }) => {
    expect((await put(request, lead, '/api/sourcing/settings', { shadow_until: ymd(30) })).status).toBe(200);
    expect((await put(request, hr, '/api/sourcing/settings', { shadow_until: ymd(0) })).status).toBe(403);       // recruiters cannot move the goalposts
    expect((await put(request, lead, '/api/sourcing/settings', { shadow_until: 'whenever' })).status).toBe(400);
    await cron(request);
    let gap = (await liveExceptions()).find(e => e.type === 'VOLUME_GAP');
    expect(gap).toMatchObject({ is_shadow: true });

    // visible to HR/Leadership on the dashboard as provisional; invisible to the Hiring Manager and to the My Tasks queue
    const dash = await get(request, hr, `/api/dashboard/sourcing?role_id=${roleId}`);
    expect(dash.body.exceptions.find((e: Json) => e.type === 'VOLUME_GAP')).toMatchObject({ provisional: true });
    const hmDash = await get(request, alex, `/api/dashboard/sourcing?role_id=${roleId}`);
    expect(hmDash.body.exceptions.find((e: Json) => e.type === 'VOLUME_GAP')).toBeUndefined();
    const queue = await get(request, hr, '/api/sourcing/queue');
    expect(JSON.stringify(queue.body.exceptions)).not.toContain(`"role_id":"${roleId}"`);

    // once the shadow period has ended, an ACTIVE plan's gap goes live...
    expect((await put(request, lead, '/api/sourcing/settings', { shadow_until: ymd(-1) })).status).toBe(200);
    await cron(request);
    gap = (await liveExceptions()).find(e => e.type === 'VOLUME_GAP');
    expect(gap).toMatchObject({ is_shadow: false });
    // ...but a DRAFT plan stays provisional whatever the date says
    const draftRole = await newRole({ title: 'Draft plan volume' });
    await cron(request);
    const draftGap = await client.query(`SELECT e.is_shadow FROM sourcing_exceptions e JOIN sourcing_plans p ON p.id=e.plan_id WHERE p.role_id=$1 AND e.type='VOLUME_GAP'`, [draftRole]);
    expect(draftGap.rows[0].is_shadow).toBe(true);
    // P2/P3 roles have no volume target in the SOP
    const p2 = await newRole({ title: 'P2 volume', priority: 'P2' });
    await cron(request);
    expect((await client.query(`SELECT 1 FROM sourcing_exceptions e JOIN sourcing_plans p ON p.id=e.plan_id WHERE p.role_id=$1`, [p2])).rowCount).toBe(0);
  });

  test('a qualified candidate (ResumeIQ > 60) counts toward the weekly volume; the two components are reported separately', async ({ request }) => {
    const { rows: c } = await client.query(`INSERT INTO candidates (full_name, email) VALUES ('Volume Candidate', $1) RETURNING id`, [`vol+${uid()}@example.com`]);
    candidateEmails.push((await client.query(`SELECT email FROM candidates WHERE id=$1`, [c[0].id])).rows[0].email);
    for (let i = 0; i < 5; i++) {
      const { rows: cc } = await client.query(`INSERT INTO candidates (full_name, email) VALUES ($1, $2) RETURNING id, email`, [`Volume Cand ${i}`, `vol${i}+${uid()}@example.com`]);
      candidateEmails.push(cc[0].email);
      await client.query(
        `INSERT INTO applications (candidate_id, role_id, stage, status, ai_fit_score, score_computed_at) VALUES ($1,$2,'Applied and Screened','Active',72,NOW())`, [cc[0].id, roleId]);
    }
    await cron(request);
    expect((await liveExceptions()).find(e => e.type === 'VOLUME_GAP')).toBeUndefined();             // 5 ≥ 5 today ⇒ no gap
    const v = await plan(request);
    expect(v.volume).toMatchObject({ weekly_qualified: 5, scored: 5, shortlisted: 0, min: 5, applicable: true });
    await client.query(`DELETE FROM applications WHERE role_id=$1`, [roleId]);
    await cron(request);
    expect((await liveExceptions()).find(e => e.type === 'VOLUME_GAP')).toBeTruthy();                // and it comes back when they go
  });

  // ── Queue & dashboard ───────────────────────────────────────────────────────────────────────────
  test('My Tasks queue: sourcing belongs to the HR persona, so every HR-tier user sees the SAME queue (no "mine", no scope); a Hiring Manager is refused', async ({ request }) => {
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '1 day' WHERE id=$1`, [ids.linkedinRenew]);
    await cron(request);
    for (const [who, tok] of [['hr', hr], ['hr2', hr2], ['leadership', lead]] as const) {
      const q = await get(request, tok, '/api/sourcing/queue');
      expect(q.status, who).toBe(200);
      expect((q.body.exceptions as Json[]).some(g => g.role_id === roleId), `${who} sees the exception`).toBe(true);
      expect((q.body.due as Json[]).some(d => d.role_id === roleId && d.overdue), `${who} sees the due item`).toBe(true);
      expect(q.body).not.toHaveProperty('scope');
      expect(JSON.stringify(q.body)).not.toContain('owner_name');
    }
    expect((await get(request, hr, '/api/sourcing/queue?scope=all')).status).toBe(200);              // an old client's scope parameter is simply ignored
    expect((await get(request, alex, '/api/sourcing/queue')).status).toBe(403);
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() + INTERVAL '20 days' WHERE id=$1`, [ids.linkedinRenew]);
    await cron(request);
  });

  test('no PII / free text reaches a Hiring Manager from any sourcing payload', async ({ request }) => {
    // plant a note + url on a completion, a blocker reason and a change reason, then read everything as the HM
    await post(request, hr, `/api/sourcing/commitments/${ids.linkedinRenew}/complete`, { note: SENTINEL, url: SENTINEL_URL });
    const bodies = [
      JSON.stringify((await get(request, alex, `/api/sourcing/plans/${roleId}`)).body),
      JSON.stringify((await get(request, alex, `/api/dashboard/sourcing`)).body),
      JSON.stringify((await get(request, alex, `/api/sourcing/status`)).body),
    ];
    for (const b of bodies) { expect(b).not.toContain('SENTINEL'); expect(b).not.toContain('Aaron Newton'); }
    // ...while HR does see them (so the test is not vacuous)
    expect(JSON.stringify((await get(request, hr, `/api/sourcing/plans/${roleId}`)).body)).toContain('SENTINEL');
  });

  // ── Role-change hooks ───────────────────────────────────────────────────────────────────────────
  test('role On Hold pauses the plan and stops its clocks; resuming shifts due dates by the time paused', async ({ request }) => {
    const before = (await client.query(`SELECT due_at FROM sourcing_commitments WHERE id=$1`, [ids.linkedinRenew])).rows[0].due_at as Date;
    expect((await authed(request, hr).patch(`/api/roles/${roleId}`, { status: 'On Hold' })).status()).toBe(200);
    expect((await plan(request)).plan.status).toBe('paused');
    await client.query(`UPDATE sourcing_plans SET paused_at = NOW() - INTERVAL '5 days' WHERE id=$1`, [planId]);
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() - INTERVAL '10 days' WHERE id=$1`, [ids.linkedinRenew]);
    await cron(request);
    expect((await liveExceptions()).filter(e => e.channel === 'LinkedIn')).toHaveLength(0);          // paused ⇒ nothing raised
    expect((await authed(request, hr).patch(`/api/roles/${roleId}`, { status: 'Live – Sourcing' })).status()).toBe(200);
    const v = await plan(request);
    expect(v.plan.status).toBe('active');
    const after = new Date(commitment(v, 'LinkedIn', 'renew_posting').due_at).getTime();
    const expected = Date.now() - 10 * 86400000 + 5 * 86400000;                                     // moved forward by the 5 days it sat paused
    expect(Math.abs(after - expected)).toBeLessThan(3 * 60 * 1000);
    expect(before).toBeTruthy();
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() + INTERVAL '20 days' WHERE id=$1`, [ids.linkedinRenew]);
  });

  test('role Closed – Filled closes the plan, cancels every commitment and clears exceptions — nothing new is queued; reopening returns it to draft', async ({ request }) => {
    await cron(request);                                                                              // an exception is live when the role closes
    expect((await liveExceptions()).length).toBeGreaterThan(0);
    expect((await authed(request, hr).patch(`/api/roles/${roleId}`, { status: 'Closed – Filled' })).status()).toBe(200);
    const v = await plan(request);
    expect(v.plan.status).toBe('closed');
    expect(await liveExceptions()).toHaveLength(0);                                                  // every exception, VOLUME_GAP included, is cleared
    expect(commitment(v, 'LinkedIn', 'renew_posting').status).toBe('skipped');
    // Nothing is queued on close (a "take down the postings" task used to be): every commitment is skipped, none is left open.
    const all = (v.channels as Json[]).flatMap(c => c.commitments as Json[]);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every(m => m.status !== 'open')).toBe(true);
    expect(all.some(m => m.kind === 'take_down_postings')).toBe(false);
    await cron(request);
    expect(await liveExceptions()).toHaveLength(0);                                                  // and the engine raises nothing on a closed plan
    const resolved = await client.query(`SELECT 1 FROM sourcing_exceptions WHERE plan_id=$1 AND resolution_path='role_closed'`, [planId]);
    expect(resolved.rowCount).toBeGreaterThan(0);

    expect((await authed(request, hr).patch(`/api/roles/${roleId}`, { status: 'Live – Sourcing' })).status()).toBe(200);
    expect((await plan(request)).plan.status).toBe('draft');                                         // must be re-activated; history is kept
    expect((await client.query(`SELECT 1 FROM sourcing_commitment_log l JOIN sourcing_commitments c ON c.id=l.commitment_id JOIN sourcing_plan_channels ch ON ch.id=c.plan_channel_id WHERE ch.plan_id=$1`, [planId])).rowCount).toBeGreaterThan(0);
  });

  test('editing Recruitment Mode on the role reconciles the plan (added → planned, removed → excluded)', async ({ request }) => {
    const rid = await newRole({ title: 'Mode reconcile', modes: ['LinkedIn'] });
    const before = await plan(request, hr, rid);
    expect(before.channels.map((c: Json) => c.channel)).toEqual(['LinkedIn']);
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { recruitment_mode: ['LinkedIn', 'Direct Outreach'] })).status()).toBe(200);
    let v = await plan(request, hr, rid);
    expect(channel(v, 'Direct Outreach').state).toBe('planned');
    expect(channel(v, 'Direct Outreach').commitments).toEqual([]);                                  // a draft plan commits nothing — activation does
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { recruitment_mode: ['Direct Outreach'] })).status()).toBe(200);
    v = await plan(request, hr, rid);
    expect(channel(v, 'LinkedIn').state).toBe('excluded');
    expect(channel(v, 'Direct Outreach').state).toBe('planned');
  });

  // ── Non-disruption ──────────────────────────────────────────────────────────────────────────────
  test('a role save still succeeds if the sourcing tables are missing — the hook can never break an approval', async ({ request }) => {
    const rid = await newRole({ title: 'Hook safety' });
    await client.query(`ALTER TABLE sourcing_plans RENAME TO sourcing_plans_tmp`);
    try {
      const r = await authed(request, hr).patch(`/api/roles/${rid}`, { status: 'On Hold' });
      expect(r.status()).toBe(200);
      expect((await client.query(`SELECT status FROM roles WHERE id=$1`, [rid])).rows[0].status).toBe('On Hold');
      expect((await authed(request, hr).patch(`/api/roles/${rid}`, { recruitment_mode: ['LinkedIn'] })).status()).toBe(200);
    } finally {
      await client.query(`ALTER TABLE sourcing_plans_tmp RENAME TO sourcing_plans`);
    }
  });

  test('candidate ingestion: source_tag → applications.sub_source only; untagged stamped; candidates.source untouched', async ({ request }) => {
    const rid = await newRole({ title: 'Ingest attribution', hm: 'Someone Else' });
    const title = (await client.query(`SELECT title FROM roles WHERE id=$1`, [rid])).rows[0].title as string;
    const ingest = async (extra: object) => {
      const email = `src+${uid()}@example.com`;
      candidateEmails.push(email);
      const r = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
        data: { email, full_name: 'Source Tag Tester', role_applied_for: title, ...extra },
      });
      expect(r.status()).toBeLessThan(300);
      return (await client.query(
        `SELECT a.sub_source, c.source FROM applications a JOIN candidates c ON c.id=a.candidate_id WHERE c.email=$1 AND a.role_id=$2`, [email, rid])).rows[0];
    };
    const tagged = await ingest({ source_tag: ' linkedin ' });
    expect(tagged.sub_source).toBe('LinkedIn');
    expect((await ingest({ source_tag: 'Internal Referral' })).sub_source).toBe('Internal Referral');
    expect((await ingest({})).sub_source).toBe('untagged_default');
    expect((await ingest({ source_tag: '' })).sub_source).toBe('untagged_default');
    const other = await ingest({ source_tag: '<b>Facebook</b>' });
    expect(other.sub_source).toBe('Other');
    // candidates.source (and therefore Source quality) is exactly what it always was for a form applicant
    expect(tagged.source).toBe('LinkedIn');
    expect(other.source).toBe('LinkedIn');
  });

  test('e-mail settings are validated, and by default the cron sends nothing at all', async ({ request }) => {
    // exception data is internal: recipients must all be company addresses, one bad address rejects the lot
    expect((await put(request, lead, '/api/sourcing/settings', { digest_recipients: ['someone@gmail.com'] })).status).toBe(400);
    expect((await put(request, lead, '/api/sourcing/settings', { digest_recipients: ['ok@digitalpaani.com', 'x@evil.com'] })).status).toBe(400);
    expect((await put(request, lead, '/api/sourcing/settings', { daily_digest_enabled: 'yes' })).status).toBe(400);
    expect((await put(request, hr, '/api/sourcing/settings', { daily_digest_enabled: true })).status).toBe(403);       // recruiters cannot switch e-mails on
    expect((await put(request, lead, '/api/sourcing/settings', { owner_digest_enabled: true })).status).toBe(400);      // the retired per-owner setting
    expect((await put(request, lead, '/api/sourcing/settings', { holidays: ['2026-10-20'] })).status).toBe(400);        // holidays are not modelled
    expect((await put(request, lead, '/api/sourcing/settings', { nonsense_key: 1 })).status).toBe(400);
    const stored = await client.query(`SELECT key FROM sourcing_settings WHERE key IN ('digest_recipients','daily_digest_enabled','owner_digest_enabled','holidays')`);
    expect(stored.rowCount).toBe(0);                                                                                    // nothing was written by any of the above

    // default state: nothing configured ⇒ the cron reports why it sent nothing, and claims nothing
    const body = await cron(request);
    expect(body.digests.daily_sent).toBe(false);
    expect(body.digests.weekly_sent).toBe(false);
    expect(body.digests.errors).toEqual([]);
    expect(body.digests.skipped).toEqual(expect.arrayContaining(['the daily HR digest is switched off', 'no weekly recipients configured']));
    expect((await client.query(`SELECT 1 FROM sourcing_settings WHERE key LIKE 'digest_last_%'`)).rowCount).toBe(0);
  });

  test('the cron route needs the secret and answers for both GET and POST', async ({ request }) => {
    expect((await request.get(`${BASE}/api/cron/sourcing-check`)).status()).toBe(401);
    const get = await request.get(`${BASE}/api/cron/sourcing-check`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    expect(get.status()).toBe(200);
    expect((await get.json()).enabled).toBe(true);
  });

  // ── Role status chains: the plan follows the role's CURRENT status, not the hop just made ────────
  // The hook used to compare the previous and next status, so a two-hop path could strand a plan: Closed → On Hold →
  // Approved left it 'closed' on an open role (activation then answers 409 "The role is closed" and nothing could unstick
  // it), and On Hold → Under Review → Approved left it 'paused' for good (the engine, queue and digests all ignore a
  // paused plan). It now reconciles from (role's new status, plan's own status) — see utils/sourcingPlanTransitions.ts.
  // The roles PATCHed to Approved get a JD link planted so the test never triggers a real JD generation.
  const quietRole = async (o: Parameters<typeof newRole>[0] = {}) => {
    const rid = await newRole(o);
    await client.query(`UPDATE roles SET jd_drive_link = $2 WHERE id = $1`, [rid, `https://example.com/jd-${rid}`]);
    return rid;
  };
  const setStatus = async (request: any, rid: string, status: string, extra: object = {}) => {
    const r = await authed(request, hr).patch(`/api/roles/${rid}`, { status, ...extra });
    expect(r.status(), `PATCH ${rid} → ${status}`).toBe(200);
  };
  const planRow = async (rid: string) =>
    (await client.query(`SELECT id::text AS id, status, paused_at, closed_at, pause_total_days FROM sourcing_plans WHERE role_id=$1`, [rid])).rows[0];
  const changeCount = async (rid: string, type: string) =>
    Number((await client.query(
      `SELECT count(*) FROM sourcing_plan_changes c JOIN sourcing_plans p ON p.id=c.plan_id WHERE p.role_id=$1 AND c.change->>'type'=$2`, [rid, type])).rows[0].count);
  const openDueAts = async (rid: string) =>
    (await client.query(
      `SELECT c.id::text AS id, c.due_at FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id=c.plan_channel_id
         JOIN sourcing_plans p ON p.id=ch.plan_id WHERE p.role_id=$1 AND c.status='open' ORDER BY c.id`, [rid])).rows as Array<{ id: string; due_at: Date }>;
  const activateRole = async (request: any, rid: string) => {
    const v = await plan(request, hr, rid);                                     // first visit seeds the draft plan
    const r = await post(request, hr, `/api/sourcing/plans/${v.plan.id}/activate`, { channels: [{ channel: 'LinkedIn' }, { channel: 'Agency' }] });
    expect(r.status).toBe(200);
    return v.plan.id as string;
  };

  test('chain: Closed – Filled → On Hold → Approved ends in a DRAFT plan that can be activated (it used to stay closed on an open role)', async ({ request }) => {
    const rid = await quietRole({ title: 'Chain closed-hold-approved', status: 'Approved' });
    const v = await plan(request, hr, rid);
    expect(v.plan.status).toBe('draft');
    await setStatus(request, rid, 'Closed – Filled');
    expect((await planRow(rid)).status).toBe('closed');
    await setStatus(request, rid, 'On Hold');
    expect((await planRow(rid)).status).toBe('closed');            // nothing to pause — and it is not reopened while the role is not open
    await setStatus(request, rid, 'Approved');
    expect((await planRow(rid)).status).toBe('draft');             // back on an open role ⇒ back to draft, history kept
    expect((await post(request, hr, `/api/sourcing/plans/${v.plan.id}/activate`, { channels: [{ channel: 'LinkedIn' }] })).status).toBe(200);   // was 409 "The role is closed"
    expect((await planRow(rid)).status).toBe('active');
    expect(await changeCount(rid, 'role_reopened')).toBe(1);
  });

  test('chain: On Hold → Under Review → Approved resumes the paused plan and shifts its due dates by the time it sat paused (it used to stay paused forever)', async ({ request }) => {
    const rid = await quietRole({ title: 'Chain hold-review-approved', status: 'Approved' });
    await activateRole(request, rid);                              // ACTIVE first: only an active plan pauses, a draft would pass on the old code too
    const before = await openDueAts(rid);
    expect(before.length).toBeGreaterThan(0);
    await setStatus(request, rid, 'On Hold');
    expect((await planRow(rid)).status).toBe('paused');
    await client.query(`UPDATE sourcing_plans SET paused_at = NOW() - INTERVAL '5 days' WHERE role_id=$1`, [rid]);
    await setStatus(request, rid, 'Under Review');
    expect((await planRow(rid)).status).toBe('paused');            // not open yet — the clocks stay stopped
    await setStatus(request, rid, 'Approved');
    const p = await planRow(rid);
    expect(p.status).toBe('active');
    expect(p.paused_at).toBeNull();
    const after = await openDueAts(rid);
    expect(after.map(a => a.id)).toEqual(before.map(b => b.id));
    for (const [i, a] of after.entries()) {
      const shifted = new Date(a.due_at).getTime() - new Date(before[i].due_at).getTime();
      expect(Math.abs(shifted - 5 * 86400000)).toBeLessThan(3 * 60 * 1000);                          // moved forward by the 5 days it sat paused
    }
    expect(await changeCount(rid, 'resumed')).toBe(1);
  });

  test('chain: an active plan paused by On Hold can also come back through Draft; and a paused plan on a role that is Closed is closed', async ({ request }) => {
    const back = await quietRole({ title: 'Chain hold-draft-live', status: 'Live – Sourcing' });
    await activateRole(request, back);
    await setStatus(request, back, 'On Hold');
    await setStatus(request, back, 'Draft');
    expect((await planRow(back)).status).toBe('paused');
    await setStatus(request, back, 'Live – Sourcing');
    expect((await planRow(back)).status).toBe('active');

    const gone = await quietRole({ title: 'Chain hold-closed', status: 'Live – Sourcing' });
    await activateRole(request, gone);
    await setStatus(request, gone, 'On Hold');
    expect((await planRow(gone)).status).toBe('paused');
    await setStatus(request, gone, 'Closed – Cancelled');
    const closed = await planRow(gone);
    expect(closed.status).toBe('closed');
    expect(closed.paused_at).toBeNull();                           // a closed plan is not "paused"
  });

  test('single hops are unchanged: Approved → On Hold → Approved (active resumes, draft stays draft) and Closed – Cancelled → Approved', async ({ request }) => {
    const live = await quietRole({ title: 'Hop active', status: 'Approved' });
    await activateRole(request, live);
    await setStatus(request, live, 'On Hold');
    expect((await planRow(live)).status).toBe('paused');
    await setStatus(request, live, 'Approved');
    expect((await planRow(live)).status).toBe('active');
    await setStatus(request, live, 'Closed – Cancelled');
    expect((await planRow(live)).status).toBe('closed');
    await setStatus(request, live, 'Approved');
    expect((await planRow(live)).status).toBe('draft');

    const idle = await quietRole({ title: 'Hop draft', status: 'Approved' });
    const seeded = await plan(request, hr, idle);
    expect(seeded.plan.status).toBe('draft');
    await setStatus(request, idle, 'On Hold');
    expect((await planRow(idle)).status).toBe('draft');            // a draft has no clocks to stop
    await setStatus(request, idle, 'Approved');
    expect((await planRow(idle)).status).toBe('draft');
    expect((await client.query(`SELECT 1 FROM sourcing_plans WHERE role_id=$1`, [idle])).rowCount).toBe(1);

    // a role that was never open has no plan; reaching Approved seeds the draft from Recruitment Mode
    const fresh = await quietRole({ title: 'Hop seed', status: 'Under Review' });
    expect((await client.query(`SELECT 1 FROM sourcing_plans WHERE role_id=$1`, [fresh])).rowCount).toBe(0);
    await setStatus(request, fresh, 'Approved');
    expect((await planRow(fresh)).status).toBe('draft');
    expect((await plan(request, hr, fresh)).channels.map((c: Json) => c.channel).sort()).toEqual(['Agency', 'LinkedIn']);
  });

  test('saving the same status again changes nothing: no second pause, resume, close or reopen, and a missing plan on an open role heals', async ({ request }) => {
    const rid = await quietRole({ title: 'Idempotent saves', status: 'Approved' });
    await activateRole(request, rid);
    const save = (status: string) => setStatus(request, rid, status, { additional_remarks: `edit ${uid()}` });   // a changed field, so the PATCH is a real save

    await save('On Hold');
    const paused = await planRow(rid);
    expect(paused.status).toBe('paused');
    await client.query(`UPDATE sourcing_plans SET paused_at = NOW() - INTERVAL '2 days' WHERE role_id=$1`, [rid]);
    const stamp = new Date((await planRow(rid)).paused_at).getTime();
    await save('On Hold');
    const stillPaused = await planRow(rid);
    expect(stillPaused.status).toBe('paused');
    expect(new Date(stillPaused.paused_at).getTime()).toBe(stamp);                      // the pause clock was not restarted

    await save('Approved');
    const due = await openDueAts(rid);
    await save('Approved');
    await save('Live – Sourcing');                                                      // open → open
    expect((await planRow(rid)).status).toBe('active');
    expect(await changeCount(rid, 'resumed')).toBe(1);                                  // resumed once, not once per save
    expect((await openDueAts(rid)).map(d => +new Date(d.due_at))).toEqual(due.map(d => +new Date(d.due_at)));   // due dates not shifted again

    await save('Closed – Filled');
    await save('Closed – Cancelled');                                                   // closed → closed
    expect((await planRow(rid)).status).toBe('closed');
    expect(await changeCount(rid, 'role_closed')).toBe(1);
    await save('On Hold');                                                              // closed plan on a role that is only on hold: untouched
    expect((await planRow(rid)).status).toBe('closed');
    await save('Approved');
    await save('Approved');
    expect((await planRow(rid)).status).toBe('draft');
    expect(await changeCount(rid, 'role_reopened')).toBe(1);

    // self-healing: an open role whose plan is missing gets its draft back on the next real save, with no status change
    await client.query(`DELETE FROM sourcing_plans WHERE role_id=$1`, [rid]);
    await save('Approved');
    expect((await planRow(rid)).status).toBe('draft');
  });
  // ── Managing a running plan: channels, skips, owner ─────────────────────────────────────────────
  // The gaps the review found: a channel added to an ACTIVE plan got no commitment, a skipped follow-on never came back,
  // and nothing in the UI (and no test) covered PUT …/channel, POST …/reopen or PATCH /plans/:id.
  const patchPlan = async (request: any, tok: string, pid: string, data: object) => {
    const r = await authed(request, tok).patch(`/api/sourcing/plans/${pid}`, data);
    return { status: r.status(), body: (await r.json().catch(() => ({}))) as Json };
  };
  const activeRole = async (request: any, title: string, modes: string[], channels: Json[]) => {
    const rid = await newRole({ title, modes });
    const v = await plan(request, hr, rid);
    const r = await post(request, hr, `/api/sourcing/plans/${v.plan.id}/activate`, { channels });
    expect(r.status).toBe(200);
    return { rid, pid: v.plan.id as string };
  };
  const activations = async (pid: string, ch: string) =>
    (await client.query(
      `SELECT c.id::text AS id, c.status, c.title, c.due_at FROM sourcing_commitments c JOIN sourcing_plan_channels x ON x.id=c.plan_channel_id
        WHERE x.plan_id=$1 AND x.channel=$2 AND c.kind='activate_channel'`, [pid, ch])).rows as Array<{ id: string; status: string; title: string; due_at: Date }>;

  test('a channel added to an ACTIVE plan through the role\'s Recruitment Mode gets its first commitment; removing and re-adding it brings the commitment back', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Mode add on active', ['LinkedIn'], [{ channel: 'LinkedIn' }]);
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { recruitment_mode: ['LinkedIn', 'Direct Outreach'] })).status()).toBe(200);
    let v = await plan(request, hr, rid);
    expect(channel(v, 'Direct Outreach').state).toBe('planned');
    const first = await activations(pid, 'Direct Outreach');
    expect(first).toHaveLength(1);                                                                    // it used to have none: nothing was due, nothing chased
    expect(first[0].status).toBe('open');
    expect(first[0].title).toMatch(/outbound/i);
    expect(commitment(v, 'Direct Outreach', 'activate_channel').due_date >= ymd(1)).toBe(true);       // due from today, never already overdue
    expect(channel(v, 'LinkedIn').commitments).toHaveLength(1);                                       // the channel that was already there is untouched
    expect(await changeCount(rid, 'channels_added_on_role')).toBe(1);

    // left out by taking it off the role, then put back: the commitment returns (it was skipped when the channel was removed)
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { recruitment_mode: ['LinkedIn'] })).status()).toBe(200);
    expect(channel(await plan(request, hr, rid), 'Direct Outreach').state).toBe('excluded');
    expect((await activations(pid, 'Direct Outreach'))[0].status).toBe('skipped');
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { recruitment_mode: ['LinkedIn', 'Direct Outreach'] })).status()).toBe(200);
    v = await plan(request, hr, rid);
    expect(channel(v, 'Direct Outreach').state).toBe('planned');
    const again = await activations(pid, 'Direct Outreach');
    expect(again).toHaveLength(1);
    expect(again[0].status).toBe('open');

    // a channel the recruiter left out WITH A REASON of their own is not resurrected by a role edit
    await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'Direct Outreach', state: 'excluded', excluded_reason: 'No budget for outbound' });
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { recruitment_mode: ['LinkedIn', 'Direct Outreach', 'Agency'], additional_remarks: `edit ${uid()}` })).status()).toBe(200);
    v = await plan(request, hr, rid);
    expect(channel(v, 'Direct Outreach').state).toBe('excluded');
    expect(channel(v, 'Agency').state).toBe('planned');
  });

  test('a channel added to a PAUSED plan is committed too — and it falls due 1–2 working days after the role is back on, not a whole pause later', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Mode add on paused', ['LinkedIn'], [{ channel: 'LinkedIn' }]);
    await setStatus(request, rid, 'On Hold');
    expect((await planRow(rid)).status).toBe('paused');
    await client.query(`UPDATE sourcing_plans SET paused_at = NOW() - INTERVAL '5 days' WHERE id=$1`, [pid]);     // the role has been on hold for 5 days
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { recruitment_mode: ['LinkedIn', 'Agency'] })).status()).toBe(200);
    const added = (await activations(pid, 'Agency'))[0];
    expect(added?.status).toBe('open');
    await cron(request);
    expect((await liveExceptions(pid)).filter(e => e.channel === 'Agency')).toHaveLength(0);          // paused ⇒ the engine ignores it
    await setStatus(request, rid, 'Live – Sourcing');
    expect((await planRow(rid)).status).toBe('active');
    const v = await plan(request, hr, rid);
    expect(commitment(v, 'Agency', 'activate_channel').status).toBe('open');
    // Agency's first task is 2 working days after the day the channel was added; resuming moves every open date by the pause. Anchored to
    // the day the pause began it ends up ≤ 4 calendar days after resume (2 working days across a weekend). Anchored to "today" it would be
    // 7–9 days out — the whole 5-day pause later, so a long hold meant the channel was never chased.
    const due = commitment(v, 'Agency', 'activate_channel').due_date as string;
    expect(due >= ymd(1) && due <= ymd(4), `Agency activation due ${due}`).toBe(true);
  });

  test('PUT …/channel: adding is validated, never changes a channel that is already in the plan, and starts the first commitment from today', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Channel PUT', ['LinkedIn'], [{ channel: 'LinkedIn', already_running: true, posted_at: ymd(-2) }]);
    const add = (b: object, tok = hr) => put(request, tok, `/api/sourcing/plans/${pid}/channel`, b);
    expect((await add({ channel: 'Telegram', state: 'planned' })).status).toBe(400);
    expect((await add({ channel: 'Agency', state: 'maybe' })).status).toBe(400);
    expect((await add({ channel: 'Agency', state: 'excluded' })).status).toBe(400);                  // a reason is required to leave one out
    expect((await add({ channel: 'Agency', state: 'excluded', excluded_reason: 'ab' })).status).toBe(400);
    expect((await add({ channel: 'Agency', state: 'planned' }, alex)).status).toBe(403);
    expect((await put(request, hr, `/api/sourcing/plans/not-a-number/channel`, { channel: 'Agency', state: 'planned' })).status).toBe(400);

    expect((await add({ channel: 'Agency', state: 'planned' })).status).toBe(200);
    const agency = await activations(pid, 'Agency');
    expect(agency).toHaveLength(1);
    expect(agency[0].status).toBe('open');
    expect(commitment(await plan(request, hr, rid), 'Agency', 'activate_channel').due_date >= ymd(1)).toBe(true);
    expect((await client.query(`SELECT recruitment_mode FROM roles WHERE id=$1`, [rid])).rows[0].recruitment_mode).toContain('Agency');   // plan → role mirror
    expect(await changeCount(rid, 'channel_added')).toBe(1);

    // adding a channel that is already in the plan answers 409 and changes nothing — it used to re-open a FINISHED activation
    const liveBefore = await activations(pid, 'LinkedIn');
    expect(liveBefore[0].status).toBe('done');
    expect((await add({ channel: 'LinkedIn', state: 'planned' })).status).toBe(409);
    expect((await add({ channel: 'Agency', state: 'planned' })).status).toBe(409);                    // not live yet, but already in the plan
    expect((await activations(pid, 'LinkedIn'))[0].status).toBe('done');
    expect(await changeCount(rid, 'channel_added')).toBe(1);

    // a draft plan takes the channel but commits nothing (activation does); a closed plan refuses
    const draft = await newRole({ title: 'Channel PUT draft', modes: ['LinkedIn'] });
    const dv = await plan(request, hr, draft);
    expect((await put(request, hr, `/api/sourcing/plans/${dv.plan.id}/channel`, { channel: 'Agency', state: 'planned' })).status).toBe(200);
    expect(channel(await plan(request, hr, draft), 'Agency').commitments).toEqual([]);
    await setStatus(request, rid, 'Closed – Filled');
    expect((await add({ channel: 'Direct Outreach', state: 'planned' })).status).toBe(409);
  });

  test('a skipped follow-on comes back when its channel is brought back and the activation is completed again — a follow-on that is already running is left alone', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Follow-on revival', ['LinkedIn'], [{ channel: 'LinkedIn', already_running: true, posted_at: ymd(-2) }]);
    const renewId = commitment(await plan(request, hr, rid), 'LinkedIn', 'renew_posting').id as string;
    const state = async () => (await client.query(`SELECT status, due_at FROM sourcing_commitments WHERE id=$1`, [renewId])).rows[0];

    // leave the channel out: its follow-on is skipped; bring it back: the activation is open again, the follow-on still skipped
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'LinkedIn', state: 'excluded', excluded_reason: 'Paused the posting for a week' })).status).toBe(200);
    expect((await state()).status).toBe('skipped');
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'LinkedIn', state: 'planned' })).status).toBe(200);
    const act = (await activations(pid, 'LinkedIn'))[0];
    expect(act.status).toBe('open');
    expect((await state()).status).toBe('skipped');

    // completing the activation again re-runs the channel: the follow-on is open again with a fresh due date (it used to stay skipped for good)
    expect((await post(request, hr, `/api/sourcing/commitments/${act.id}/complete`, { posted_at: ymd(0) })).status).toBe(200);
    const revived = await state();
    expect(revived.status).toBe('open');
    expect(commitment(await plan(request, hr, rid), 'LinkedIn', 'renew_posting').due_date).toBe(ymd(27));

    // …but completing an activation must never reset a follow-on that is running: move its date, reopen + complete the activation again
    await client.query(`UPDATE sourcing_commitments SET due_at = NOW() + INTERVAL '10 days' WHERE id=$1`, [renewId]);
    const pinned = +new Date((await state()).due_at);
    expect((await post(request, hr, `/api/sourcing/commitments/${act.id}/reopen`)).status).toBe(200);
    expect((await post(request, hr, `/api/sourcing/commitments/${act.id}/complete`, { posted_at: ymd(0) })).status).toBe(200);
    expect(+new Date((await state()).due_at)).toBe(pinned);
  });

  test('role closed → reopened → re-activated with "already running": the follow-ons skipped by the close run again', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Close reopen reactivate', ['LinkedIn'], [{ channel: 'LinkedIn', already_running: true, posted_at: ymd(-2) }]);
    await setStatus(request, rid, 'Closed – Filled');
    expect(commitment(await plan(request, hr, rid), 'LinkedIn', 'renew_posting').status).toBe('skipped');
    await setStatus(request, rid, 'Live – Sourcing');
    expect((await planRow(rid)).status).toBe('draft');
    expect((await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [{ channel: 'LinkedIn', already_running: true, posted_at: ymd(-1) }] })).status).toBe(200);
    const v = await plan(request, hr, rid);
    expect(commitment(v, 'LinkedIn', 'renew_posting').status).toBe('open');                           // it used to stay skipped: the role was chased for nothing
    expect(commitment(v, 'LinkedIn', 'renew_posting').due_date).toBe(new Date(new Date(`${ymd(-1)}T12:00:00Z`).getTime() + 27 * 86400000).toISOString().slice(0, 10));
  });

  test('POST …/reopen: only a plan that is active, a commitment that is not open, a channel that is in the plan, and only HR', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Reopen rules', ['LinkedIn', 'Agency'], [{ channel: 'LinkedIn', already_running: true, posted_at: ymd(-2) }, { channel: 'Agency' }]);
    const v = await plan(request, hr, rid);
    const renewId = commitment(v, 'LinkedIn', 'renew_posting').id as string;
    const agencyId = commitment(v, 'Agency', 'activate_channel').id as string;
    const reopen = (id: string, tok = hr) => post(request, tok, `/api/sourcing/commitments/${id}/reopen`);

    expect((await reopen(renewId)).status).toBe(409);                                                 // already open
    expect((await post(request, hr, `/api/sourcing/commitments/${renewId}/skip`, { reason: 'ok' })).status).toBe(400);   // too short a reason
    expect((await post(request, hr, `/api/sourcing/commitments/${renewId}/skip`, { reason: 'The posting auto-renews' })).status).toBe(200);
    expect(commitment(await plan(request, hr, rid), 'LinkedIn', 'renew_posting').status).toBe('skipped');
    expect((await reopen(renewId, alex)).status).toBe(403);
    expect((await reopen('abc')).status).toBe(400);
    expect((await reopen('999999999')).status).toBe(404);
    expect((await reopen(renewId)).status).toBe(200);                                                 // "Undo skip"
    const back = commitment(await plan(request, hr, rid), 'LinkedIn', 'renew_posting');
    expect(back.status).toBe('open');
    expect(back.due_date).toBe(ymd(1));                                                               // due tomorrow, as the card says
    expect(await changeCount(rid, 'commitment_skipped')).toBe(1);
    expect(await changeCount(rid, 'commitment_reopened')).toBe(1);

    // a skipped commitment of a channel that is left out stays skipped: bring the channel back first
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'Agency', state: 'excluded', excluded_reason: 'No budget for agency fees' })).status).toBe(200);
    const refused = await reopen(agencyId);
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toMatch(/add it back/i);
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'Agency', state: 'planned' })).status).toBe(200);
    expect((await activations(pid, 'Agency'))[0].status).toBe('open');                                // bringing the channel back re-opened its activation

    // not on a plan that is not active — skip it again first, so the refusal can only come from the plan check
    expect((await post(request, hr, `/api/sourcing/commitments/${renewId}/skip`, { reason: 'Skipping again before the hold' })).status).toBe(200);
    await setStatus(request, rid, 'On Hold');
    expect(commitment(await plan(request, hr, rid), 'LinkedIn', 'renew_posting').status).toBe('skipped');
    const held = await reopen(renewId);
    expect(held.status).toBe(409);
    expect(String(held.body.error)).toMatch(/not active/i);
  });

  test('PATCH /plans/:id: edit the strategy note — logged once per real change, HR-tier only; there is no owner to change', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Plan edit', ['LinkedIn'], [{ channel: 'LinkedIn' }]);

    expect((await patchPlan(request, alex, pid, { strategy_note: 'x' })).status).toBe(403);
    expect((await patchPlan(request, hr, 'nope', { strategy_note: 'x' })).status).toBe(400);
    expect((await patchPlan(request, hr, '999999999', { strategy_note: 'x' })).status).toBe(404);

    expect((await patchPlan(request, hr, pid, { strategy_note: '  Focus on service engineers  ' })).status).toBe(200);
    expect((await plan(request, hr, rid)).plan.strategy_note).toBe('Focus on service engineers');       // trimmed
    expect(await changeCount(rid, 'strategy_note_changed')).toBe(1);

    // saving what is already there writes no history; clearing the note stores NULL
    expect((await patchPlan(request, hr, pid, { strategy_note: 'Focus on service engineers' })).status).toBe(200);
    expect(await changeCount(rid, 'strategy_note_changed')).toBe(1);
    expect((await patchPlan(request, lead, pid, { strategy_note: '' })).status).toBe(200);            // Leadership is HR-tier
    expect((await plan(request, hr, rid)).plan.strategy_note).toBeNull();
    expect(await changeCount(rid, 'strategy_note_changed')).toBe(2);
  });

  test('completing is refused for a SKIPPED recurring commitment, a channel that is left out, a closed plan and a draft — and a paused plan cannot be "activated"', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Complete guards', ['LinkedIn', 'Agency'], [{ channel: 'LinkedIn', already_running: true, posted_at: ymd(-2) }, { channel: 'Agency' }]);
    const v = await plan(request, hr, rid);
    const renewId = commitment(v, 'LinkedIn', 'renew_posting').id as string;
    const agencyId = commitment(v, 'Agency', 'activate_channel').id as string;
    const complete = (id: string) => post(request, hr, `/api/sourcing/commitments/${id}/complete`, { note: 'done' });

    // a skipped recurring commitment used to be "completed" straight back to open, around the undo-skip rules
    expect((await post(request, hr, `/api/sourcing/commitments/${renewId}/skip`, { reason: 'The posting renews itself' })).status).toBe(200);
    const skipped = await complete(renewId);
    expect(skipped.status).toBe(409);
    expect(String(skipped.body.error)).toMatch(/skipped/i);
    expect(commitment(await plan(request, hr, rid), 'LinkedIn', 'renew_posting').status).toBe('skipped');

    // a channel that is left out: nothing of it can be completed (that used to leave an open commitment on an excluded channel)
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'Agency', state: 'excluded', excluded_reason: 'No budget for agency fees' })).status).toBe(200);
    expect((await complete(agencyId)).status).toBe(409);
    // …even if a commitment were somehow open on it (forced here by SQL): the channel check itself must refuse, not only the "skipped" one
    await client.query(`UPDATE sourcing_commitments SET status='open' WHERE id=$1`, [agencyId]);
    const forced = await complete(agencyId);
    expect(forced.status).toBe(409);
    expect(String(forced.body.error)).toMatch(/not in the plan/i);
    await client.query(`UPDATE sourcing_commitments SET status='skipped' WHERE id=$1`, [agencyId]);
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'Agency', state: 'planned' })).status).toBe(200);

    // a paused plan cannot be activated: it used to re-open finished work and clear the pause without shifting anything
    const liveBefore = (await activations(pid, 'LinkedIn'))[0];
    expect(liveBefore.status).toBe('done');
    await setStatus(request, rid, 'On Hold');
    const act = await post(request, hr, `/api/sourcing/plans/${pid}/activate`, { channels: [{ channel: 'LinkedIn' }] });
    expect(act.status).toBe(409);
    expect((await planRow(rid)).status).toBe('paused');
    expect((await activations(pid, 'LinkedIn'))[0].status).toBe('done');

    // a closed plan completes nothing
    await setStatus(request, rid, 'Closed – Filled');
    expect((await complete(agencyId)).status).toBe(409);
    expect((await complete(renewId)).status).toBe(409);
    await client.query(`UPDATE sourcing_commitments SET status='open' WHERE id=$1`, [agencyId]);          // an open one on a closed plan, forced by SQL: the plan check refuses
    const onClosed = await complete(agencyId);
    expect(onClosed.status).toBe(409);
    expect(String(onClosed.body.error)).toMatch(/closed/i);
    await client.query(`UPDATE sourcing_commitments SET status='skipped' WHERE id=$1`, [agencyId]);
    expect((await client.query(`SELECT count(*)::int AS n FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id=c.plan_channel_id WHERE ch.plan_id=$1 AND c.status='open'`, [pid])).rows[0].n).toBe(0);
  });

  test('a reason the recruiter wrote — even one that starts "Removed from" — is never mistaken for the automatic one by a Recruitment Mode edit', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'Reason marker', ['LinkedIn', 'Agency'], [{ channel: 'LinkedIn' }, { channel: 'Agency' }]);
    expect((await put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'Agency', state: 'excluded', excluded_reason: 'Removed from budget by Mansi' })).status).toBe(200);
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { recruitment_mode: ['LinkedIn', 'Agency', 'Direct Outreach'] })).status()).toBe(200);
    const v = await plan(request, hr, rid);
    expect(channel(v, 'Agency').state).toBe('excluded');                                              // not resurrected
    expect(channel(v, 'Agency').excluded_reason).toBe('Removed from budget by Mansi');                // and its reason survives
    expect(channel(v, 'Direct Outreach').state).toBe('planned');
    // the automatic reason, on the other hand, IS undone by putting the channel back on the role
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { recruitment_mode: ['Agency', 'Direct Outreach'] })).status()).toBe(200);
    let w = await plan(request, hr, rid);
    expect(channel(w, 'LinkedIn').state).toBe('excluded');                                            // dropped because it came off the role
    expect(channel(w, 'LinkedIn').excluded_reason).toBe('Removed from the role’s Recruitment Mode');
    expect((await authed(request, hr).patch(`/api/roles/${rid}`, { recruitment_mode: ['LinkedIn', 'Agency', 'Direct Outreach'] })).status()).toBe(200);
    w = await plan(request, hr, rid);
    expect(channel(w, 'LinkedIn').state).toBe('planned');                                             // and brought back with its first commitment
    expect(channel(w, 'LinkedIn').excluded_reason).toBeNull();
    expect(channel(w, 'Agency').state).toBe('excluded');                                              // the recruiter's own exclusion is still in place
  });

  test('a plan has no individual owner: no payload carries one, PATCH refuses one, activation ignores one, and every HR user can act on every plan', async ({ request }) => {
    const { rid, pid } = await activeRole(request, 'No owner', ['LinkedIn'], [{ channel: 'LinkedIn' }]);
    for (const bad of [aaronId, 5, null, 'not-a-uuid']) {
      const r = await patchPlan(request, hr, pid, { owner_user_id: bad });
      expect(r.status, `owner_user_id=${JSON.stringify(bad)}`).toBe(400);
      expect(String(r.body.error)).toMatch(/no individual owner/i);
    }
    const v = await plan(request, hr, rid);
    expect(v.plan).not.toHaveProperty('owner_user_id');
    expect(v.plan).not.toHaveProperty('owner_name');
    expect(await changeCount(rid, 'owner_changed')).toBe(0);
    expect((await client.query(`SELECT owner_user_id FROM sourcing_plans WHERE id=$1`, [pid])).rows[0].owner_user_id).toBeNull();   // the retired column is never written
    // an old client that still sends an owner at activation is not refused, and nothing is stored
    const draft = await newRole({ title: 'No owner draft', modes: ['LinkedIn'] });
    const dv = await plan(request, hr, draft);
    expect((await post(request, hr, `/api/sourcing/plans/${dv.plan.id}/activate`, { channels: [{ channel: 'LinkedIn' }] })).status).toBe(200);
    expect((await client.query(`SELECT owner_user_id FROM sourcing_plans WHERE id=$1`, [dv.plan.id])).rows[0].owner_user_id).toBeNull();
    // any HR user — not just whoever activated it — can complete, skip and edit: the persona owns the plan
    const renew = commitment(await plan(request, hr, draft), 'LinkedIn', 'activate_channel').id as string;
    expect((await post(request, hr2, `/api/sourcing/commitments/${renew}/complete`, { note: 'done by another recruiter' })).status).toBe(200);
    expect((await patchPlan(request, hr2, dv.plan.id, { strategy_note: 'Edited by another recruiter' })).status).toBe(200);
    // the people list (for naming who must unblock a blocker) hides the smoke accounts and is HR-only
    const people = await get(request, hr, '/api/sourcing/people');
    expect(people.status).toBe(200);
    expect((people.body.people as Json[]).some(p => String(p.name).includes('Smoke Test'))).toBe(false);
    expect((people.body.people as Json[]).every(p => p.id && p.name && p.persona && !('email' in p))).toBe(true);
  });

  test('commitment-level actions race safely with plan-level ones: complete / skip / reopen against excluding the channel or closing the role never deadlock and never leave open work on a left-out channel or a closed plan', async ({ request }) => {
    for (let round = 0; round < 5; round++) {
      const { rid, pid } = await activeRole(request, `Race ${round}`, ['LinkedIn'], [{ channel: 'LinkedIn', already_running: true, posted_at: ymd(-2) }]);
      const v = await plan(request, hr, rid);
      const renewId = commitment(v, 'LinkedIn', 'renew_posting').id as string;
      const actId = commitment(v, 'LinkedIn', 'activate_channel').id as string;
      const results = await Promise.all([
        post(request, hr, `/api/sourcing/commitments/${renewId}/complete`, { note: 'racing' }),
        put(request, hr, `/api/sourcing/plans/${pid}/channel`, { channel: 'LinkedIn', state: 'excluded', excluded_reason: 'Racing the completion' }),
        post(request, hr, `/api/sourcing/commitments/${actId}/reopen`),
        post(request, hr, `/api/sourcing/commitments/${renewId}/skip`, { reason: 'Racing the exclusion' }),
      ]);
      for (const r of results) expect([200, 409], `round ${round}: ${JSON.stringify(r.body)}`).toContain(r.status);     // a deadlock would surface as a 500
      // whatever order they landed in, nothing is left open on a channel that is left out
      const open = await client.query(`SELECT count(*)::int AS n FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id=c.plan_channel_id WHERE ch.plan_id=$1 AND ch.state='excluded' AND c.status='open'`, [pid]);
      expect(open.rows[0].n, `round ${round}`).toBe(0);
      // and closing the role while a completion is in flight leaves no open commitment on the closed plan
      const closing = await Promise.all([
        post(request, hr, `/api/sourcing/commitments/${renewId}/complete`, { note: 'racing the close' }),
        authed(request, hr).patch(`/api/roles/${rid}`, { status: 'Closed – Filled' }),
      ]);
      expect([200, 409]).toContain(closing[0].status);
      expect(closing[1].status()).toBe(200);
      expect((await client.query(`SELECT count(*)::int AS n FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id=c.plan_channel_id WHERE ch.plan_id=$1 AND c.status='open'`, [pid])).rows[0].n, `round ${round} closed`).toBe(0);
    }
  });
});
