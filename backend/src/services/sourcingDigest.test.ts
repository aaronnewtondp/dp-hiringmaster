import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The orchestration is under test (what is sent, to whom, when — and when nothing is); SQL is answered from canned rows.
const claimed = new Set<string>();
let settingsRows: Array<{ key: string; value: unknown }> = [];
let exceptionRows: Array<Record<string, unknown>> = [];
let dueRows: Array<Record<string, unknown>> = [];
let userRows: Array<Record<string, unknown>> = [];
let failQuery = false;
const sqlSeen: string[] = [];

vi.mock('../db/index.js', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    sqlSeen.push(sql);
    if (failQuery) throw new Error('db down');
    if (sql.includes('SELECT key, value FROM sourcing_settings')) return settingsRows;
    if (sql.includes('INSERT INTO sourcing_settings')) {
      const k = `${params[0]}|${params[1]}`;
      if (claimed.has(k)) return [];
      claimed.add(k);
      return [{ key: String(params[0]) }];
    }
    if (sql.includes('FROM sourcing_exceptions e JOIN sourcing_plans p ON p.id = e.plan_id JOIN roles r ON r.id = p.role_id\n        WHERE e.status = \'open\' AND e.is_shadow')) return [{ n: '2' }];
    if (sql.includes('FROM sourcing_exceptions e')) return exceptionRows;
    if (sql.includes('FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id = c.plan_channel_id\n         JOIN sourcing_plans p')) return dueRows;
    if (sql.includes('FROM sourcing_commitments c')) return [{ n: '1' }];
    if (sql.includes('FROM users WHERE is_active')) return userRows;
    if (sql.includes('FROM sourcing_commitment_log')) return [{ done: '4', on_time: '3' }];
    if (sql.includes('FROM sourcing_plans p JOIN roles r')) return [{ status: 'active', n: '3' }, { status: 'draft', n: '5' }];
    return [];
  }),
  queryOne: vi.fn(),
}));
vi.mock('./gmailService.js', () => ({ sendAssignmentEmail: vi.fn() }));

import { sendSourcingDigests } from './sourcingDigest.js';

const WED = new Date('2026-10-14T03:30:00Z');          // 09:00 IST, a working Wednesday
const MON = new Date('2026-10-12T03:30:00Z');
const SAT = new Date('2026-10-17T03:30:00Z');

const exc = (role = 'R5') => ({
  role_id: role, title: `Role ${role}`, priority: 'P1', channel: 'Agency',
  type: 'CHANNEL_NOT_ACTIVATED', evidence: { count: 1, overdue: [{ title: 'Select agencies', due: '2026-10-12', days_overdue: 2 }] }, detected_at: new Date('2026-10-12T00:00:00Z'),
});

let sent: Array<{ to: string; subject: string; text: string }>;
const send = vi.fn(async (m: { to: string; subject: string; text: string }) => { sent.push(m); });

beforeEach(() => {
  claimed.clear(); sqlSeen.length = 0; sent = []; send.mockClear(); failQuery = false;
  settingsRows = []; exceptionRows = []; dueRows = []; userRows = [];
});

describe('sendSourcingDigests — off unless switched on', () => {
  it('sends nothing and claims nothing by default (no recipients, daily digest off)', async () => {
    exceptionRows = [exc()];
    userRows = [{ email: 'garima@digitalpaani.com' }];
    const r = await sendSourcingDigests(WED, send);
    expect(sent).toEqual([]);
    expect(r.daily_sent).toBe(false);
    expect(r.weekly_sent).toBe(false);
    expect(r.skipped).toEqual(expect.arrayContaining(['the daily HR digest is switched off', 'no weekly recipients configured']));
    expect(sqlSeen.some(s => s.includes('INSERT INTO sourcing_settings'))).toBe(false);
  });
});

describe('daily HR digest — one message to the HR/Admin team, because sourcing belongs to the persona and not to a person', () => {
  beforeEach(() => {
    settingsRows = [{ key: 'daily_digest_enabled', value: true }];
    userRows = [{ email: 'garima@digitalpaani.com' }, { email: 'ria.sontakke@digitalpaani.com' }, { email: 'aaron.newton@digitalpaani.com' }];
  });

  it('ONE e-mail, to every active HR/Admin user, covering every open item (not split per person)', async () => {
    exceptionRows = [exc(), exc('R6')];
    dueRows = [{ role_id: 'R9', role_title: 'Role R9', channel: 'LinkedIn', title: 'Renew the posting', due_at: new Date('2026-10-14T18:29:59Z') }];
    const r = await sendSourcingDigests(WED, send);
    expect(r.daily_sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('garima@digitalpaani.com, ria.sontakke@digitalpaani.com, aaron.newton@digitalpaani.com');
    expect(sent[0].subject).toContain('2 items need attention');
    expect(sent[0].text).toContain('Hi team,');
    expect(sent[0].text).toContain('Renew the posting');
    expect(sqlSeen.some(q => /owner_user_id/.test(q))).toBe(false);                      // no per-owner lookup any more
  });

  describe('links in the message (FRONTEND_URL)', () => {
    const saved = process.env.FRONTEND_URL;
    afterEach(() => { if (saved === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = saved; });

    it('each role links to its plan in the Dashboard\'s Sourcing workspace, and the old role-page anchor is gone', async () => {
      process.env.FRONTEND_URL = 'https://hms.example.com/';
      exceptionRows = [exc(), exc('R6')];
      await sendSourcingDigests(WED, send);
      expect(sent).toHaveLength(1);
      expect(sent[0].text.match(/https?:\/\/\S+/g)).toEqual([
        'https://hms.example.com/dashboard?sourcing_role=R5#sourcing-workspace',
        'https://hms.example.com/dashboard?sourcing_role=R6#sourcing-workspace',
      ]);
      expect(sent[0].text).not.toMatch(/\/roles\/|#sourcing(?!-)/);
      expect(sent[0].text).toContain('Sourcing plans section on the Dashboard');
    });

    it('with no FRONTEND_URL the message carries no link at all (never a broken relative one)', async () => {
      delete process.env.FRONTEND_URL;
      exceptionRows = [exc()];
      await sendSourcingDigests(WED, send);
      expect(sent[0].text).not.toContain('http');
      expect(sent[0].text).not.toContain('sourcing_role');
    });
  });

  it('sends nothing when nobody has anything to act on', async () => {
    const r = await sendSourcingDigests(WED, send);
    expect(r.daily_sent).toBe(false);
    expect(sent).toEqual([]);
  });

  it('a commitment that is already overdue is not "due today" on its own (it is inside an exception)', async () => {
    dueRows = [{ role_id: 'R9', role_title: 'R9', channel: 'LinkedIn', title: 'Renew', due_at: new Date('2026-10-13T18:29:59Z') }];
    const r = await sendSourcingDigests(WED, send);
    expect(r.daily_sent).toBe(false);
    expect(sent).toEqual([]);
  });

  it('is at most once a day: a second run (retried cron, manual trigger) sends nothing', async () => {
    exceptionRows = [exc()];
    expect((await sendSourcingDigests(WED, send)).daily_sent).toBe(true);
    const again = await sendSourcingDigests(new Date(WED.getTime() + 3600_000), send);
    expect(again.daily_sent).toBe(false);
    expect(again.skipped).toContain('the daily HR digest was already sent today');
    expect(sent).toHaveLength(1);
  });

  it('does not go out on a weekend — and does not burn the day\'s claim', async () => {
    exceptionRows = [exc()];
    expect((await sendSourcingDigests(SAT, send)).skipped).toContain('not a working day');
    expect(sent).toEqual([]);
    expect(claimed.size).toBe(0);
  });

  it('a configured "holidays" setting is gone: a Wednesday is always a working day', async () => {
    settingsRows = [{ key: 'daily_digest_enabled', value: true }, { key: 'holidays', value: ['2026-10-14'] }];
    exceptionRows = [exc()];
    expect((await sendSourcingDigests(WED, send)).daily_sent).toBe(true);
  });

  it('only company mailboxes receive it; with none, nothing is sent and the reason is reported', async () => {
    exceptionRows = [exc()];
    userRows = [{ email: 'outsider@gmail.com' }, { email: 'garima@digitalpaani.com' }];
    await sendSourcingDigests(WED, send);
    expect(sent.map(m => m.to)).toEqual(['garima@digitalpaani.com']);

    claimed.clear(); sent = [];
    userRows = [{ email: 'outsider@gmail.com' }];
    const r = await sendSourcingDigests(WED, send);
    expect(sent).toEqual([]);
    expect(r.skipped).toContain('no HR/Admin user with a company address to send the daily note to');
  });

  it('a failing send is reported, never thrown', async () => {
    exceptionRows = [exc()];
    send.mockRejectedValueOnce(new Error('Gmail 403'));
    const r = await sendSourcingDigests(WED, send);
    expect(r.daily_sent).toBe(false);
    expect(r.errors).toEqual(['daily HR digest: Gmail 403']);
  });
});

describe('weekly summary', () => {
  beforeEach(() => { settingsRows = [{ key: 'digest_recipients', value: ['mansi@digitalpaani.com', 'aaron@digitalpaani.com'] }]; });

  it('goes to every configured recipient in ONE e-mail, on Mondays', async () => {
    exceptionRows = [exc()];
    const r = await sendSourcingDigests(MON, send);
    expect(r.weekly_sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('mansi@digitalpaani.com, aaron@digitalpaani.com');
    expect(sent[0].text).toContain('3 of 8 open roles have an active plan; 5 still waiting to be activated.');
    expect(sent[0].text).toContain('75%');
    expect(sent[0].text).toContain('2 provisional signals');
  });

  it('every exception links to its role\'s plan in the Dashboard\'s Sourcing workspace', async () => {
    const saved = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'https://hms.example.com';
    try {
      exceptionRows = [exc(), exc('R6')];
      await sendSourcingDigests(MON, send);
      expect(sent[0].text.match(/https?:\/\/\S+/g)).toEqual([
        'https://hms.example.com/dashboard?sourcing_role=R5#sourcing-workspace',
        'https://hms.example.com/dashboard?sourcing_role=R6#sourcing-workspace',
      ]);
      expect(sent[0].text).not.toMatch(/\/roles\/|#sourcing(?!-)/);
    } finally {
      if (saved === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = saved;
    }
  });

  it('is skipped on other days, and only once on a Monday', async () => {
    expect((await sendSourcingDigests(WED, send)).skipped).toContain('weekly summary goes out on Mondays');
    expect((await sendSourcingDigests(MON, send)).weekly_sent).toBe(true);
    const again = await sendSourcingDigests(MON, send);
    expect(again.weekly_sent).toBe(false);
    expect(again.skipped).toContain('weekly summary already sent today');
    expect(sent).toHaveLength(1);
  });

  it('a failed send is reported, never thrown', async () => {
    send.mockRejectedValueOnce(new Error('quota'));
    const r = await sendSourcingDigests(MON, send);
    expect(r.weekly_sent).toBe(false);
    expect(r.errors).toEqual(['weekly summary: quota']);
  });
});

describe('failure containment', () => {
  it('a database failure comes back as an error string — the cron run is not failed by it', async () => {
    failQuery = true;
    const r = await sendSourcingDigests(WED, send);
    expect(r.errors[0]).toContain('db down');
    expect(sent).toEqual([]);
  });
});
