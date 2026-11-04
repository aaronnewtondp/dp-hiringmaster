import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// What is pinned here is the part of slaChecker.ts that is not SQL: runSlaCheck must run all nine independent checks and survive any of them
// failing (Promise.allSettled, not Promise.all), and sendDailyDigest builds an e-mail body from rows. The SQL itself is covered by the Playwright
// db specs against a real Postgres; every query here is answered with "no rows", so no business rule is asserted over fake SQL.
const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  transaction: vi.fn(),
  sendMail: vi.fn(),
  createTransport: vi.fn(),
}));
vi.mock('../db/index.js', () => ({
  query: (...a: unknown[]) => h.query(...a),
  queryOne: (...a: unknown[]) => h.queryOne(...a),
  transaction: (fn: (c: unknown) => Promise<unknown>) => h.transaction(fn),
  pool: {},
}));
vi.mock('nodemailer', () => ({ default: { createTransport: (...a: unknown[]) => h.createTransport(...a) } }));

import { runSlaCheck, sendDailyDigest } from './slaChecker.js';

const NOW = new Date('2026-10-14T06:00:00Z');                       // Wednesday 14 October 2026
const norm = (s: unknown) => String(s).replace(/\s+/g, ' ').trim();

// The nine checks, as the first statement each one issues (a fragment of its SQL that no other check shares).
const FIRST_QUERY_OF: Record<string, string> = {
  resolveOrphanedActions: "AND a.status <> 'Active'",
  resolveStaleStageActionTypes: 'FROM unnest($1::text[], $2::text[]) AS m(action_type, valid_stage)',
  resolveUnknownActionTypes: 'AND NOT (action_type = ANY($1::text[]))',
  checkFlatStageBreaches: 'a.stage = ANY($1)',
  checkNotYetActioned: 'AND NOT EXISTS ( SELECT 1 FROM interview_rounds ir',
  checkFeedbackDue: 'SELECT DISTINCT ON (a.id)',
  checkAssignmentDeadlines: "AND ir.assignment_submission_date IS NOT NULL",
  checkRoleAging: "WHERE status IN ('Approved', 'Live – Sourcing')",
  checkJoiningRisk: 'SET joining_risk_auto_flag = true',
};

const seenSql = () => h.query.mock.calls.map(c => norm(c[0]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.query.mockReset().mockResolvedValue([]);
  h.queryOne.mockReset().mockResolvedValue(null);
  h.transaction.mockReset().mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
  h.sendMail.mockReset().mockResolvedValue(undefined);
  h.createTransport.mockReset().mockReturnValue({ sendMail: h.sendMail });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('runSlaCheck', () => {
  it('runs all nine checks on every call', async () => {
    await runSlaCheck();
    const sql = seenSql();
    for (const [name, fragment] of Object.entries(FIRST_QUERY_OF)) {
      expect(sql.some(s => s.includes(fragment)), `${name} did not issue its query`).toBe(true);
    }
  });

  it('with nothing to do it logs no failure', async () => {
    await runSlaCheck();
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(Object.keys(FIRST_QUERY_OF))('when %s throws, the other eight still run and the failure is logged under its name', async name => {
    const failing = FIRST_QUERY_OF[name];
    h.query.mockImplementation(async (sql: string) => {
      if (norm(sql).includes(failing)) throw new Error(`boom in ${name}`);
      return [];
    });
    await expect(runSlaCheck()).resolves.toBeUndefined();

    const sql = seenSql();
    for (const [other, fragment] of Object.entries(FIRST_QUERY_OF)) {
      expect(sql.some(s => s.includes(fragment)), `${other} should have run although ${name} failed`).toBe(true);
    }
    const errors = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe(`[SLA] ${name} failed:`);
    expect((errors[0][1] as Error).message).toBe(`boom in ${name}`);
  });

  it('when every query fails it still resolves, and logs one failure per check, in the fixed check order', async () => {
    h.query.mockRejectedValue(new Error('db down'));
    h.queryOne.mockRejectedValue(new Error('db down'));
    await expect(runSlaCheck()).resolves.toBeUndefined();
    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0]));
    expect(logged).toEqual(Object.keys(FIRST_QUERY_OF).map(n => `[SLA] ${n} failed:`));
  });

  it('is safe to call again straight away (idempotent: nothing is carried over between runs)', async () => {
    await runSlaCheck();
    const first = seenSql().length;
    await runSlaCheck();
    expect(seenSql().length).toBe(first * 2);
  });
});

describe('sendDailyDigest', () => {
  const action = (over: Record<string, unknown>) => ({
    owner_type: 'HR / Recruiter', action_type: 'Idle Candidate', description: 'Idle Candidate — 3h overdue', candidate_name: 'Test Candidate',
    role_title: 'Synthetic Role', hours_overdue: 3, ...over,
  });

  beforeEach(() => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.test');
    vi.stubEnv('SMTP_PORT', '2525');
    vi.stubEnv('SMTP_USER', 'hr@example.test');
    vi.stubEnv('SMTP_PASS', 'not-a-real-password');
    vi.stubEnv('HR_EMAIL', 'team@example.test');
  });

  it('sends nothing when no action is open', async () => {
    h.query.mockResolvedValue([]);
    await sendDailyDigest();
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
  });

  it('reads only unresolved actions', async () => {
    await sendDailyDigest();
    expect(norm(h.query.mock.calls[0][0])).toContain('FROM pending_actions WHERE resolved=false');
  });

  it('sends one message to HR_EMAIL from SMTP_USER with the total and the date in the subject', async () => {
    h.query.mockResolvedValue([action({}), action({ owner_type: 'Hiring Manager', action_type: 'Interview 1 Feedback Due', description: 'Interview 1 Feedback Due — 5h overdue' })]);
    await sendDailyDigest();
    expect(h.sendMail).toHaveBeenCalledTimes(1);
    const mail = h.sendMail.mock.calls[0][0];
    expect(mail.to).toBe('team@example.test');
    expect(mail.from).toBe('hr@example.test');
    expect(mail.subject).toBe(`[DigitalPaani HMS] 2 Pending Actions — ${NOW.toDateString()}`);
  });

  it('builds the transport from the SMTP environment (port as a number, default 587)', async () => {
    h.query.mockResolvedValue([action({})]);
    await sendDailyDigest();
    expect(h.createTransport).toHaveBeenCalledWith({ host: 'smtp.example.test', port: 2525, auth: { user: 'hr@example.test', pass: 'not-a-real-password' } });

    h.createTransport.mockClear();
    vi.stubEnv('SMTP_PORT', '');
    await sendDailyDigest();
    expect(h.createTransport.mock.calls[0][0].port).toBe(587);
  });

  it('groups the body by owner, in first-seen order, with a count per group and each action\'s type and description', async () => {
    h.query.mockResolvedValue([
      action({ description: 'D1' }),
      action({ owner_type: 'Hiring Manager', action_type: 'Interview 1 Feedback Due', description: 'D2', candidate_name: 'Other Candidate', role_title: 'Other Role' }),
      action({ description: 'D3', action_type: 'Resume Shortlist Pending' }),
    ]);
    await sendDailyDigest();
    const body: string = h.sendMail.mock.calls[0][0].text;
    expect(body.startsWith('DigitalPaani HMS — Daily Pending Actions\n')).toBe(true);
    expect(body).toContain(`Date: ${NOW.toDateString()} | Total: 3 open`);
    expect(body.indexOf('── HR / Recruiter (2) ──')).toBeGreaterThan(-1);
    expect(body.indexOf('── Hiring Manager (1) ──')).toBeGreaterThan(body.indexOf('── HR / Recruiter (2) ──'));
    expect(body).toContain('  • [Idle Candidate] D1');
    expect(body).toContain('  • [Resume Shortlist Pending] D3');
    expect(body).toContain('  • [Interview 1 Feedback Due] D2');
    expect(body).toContain('    Candidate: Test Candidate | Role: Synthetic Role');
    expect(body).toContain('    Candidate: Other Candidate | Role: Other Role');
  });

  it('an action with no candidate (a role-level alert) gets no "Candidate:" line', async () => {
    h.query.mockResolvedValue([action({ owner_type: 'Leadership / Founders', action_type: 'Role aging alert', description: 'Role X (P0) — 4 days overdue', candidate_name: '', role_title: 'Role X' })]);
    await sendDailyDigest();
    const body: string = h.sendMail.mock.calls[0][0].text;
    expect(body).toContain('── Leadership / Founders (1) ──');
    expect(body).toContain('  • [Role aging alert] Role X (P0) — 4 days overdue');
    expect(body).not.toContain('Candidate:');
  });

  it('a failing send is logged and swallowed, never thrown (the digest must not break its caller)', async () => {
    h.query.mockResolvedValue([action({})]);
    h.sendMail.mockRejectedValue(new Error('smtp refused'));
    await expect(sendDailyDigest()).resolves.toBeUndefined();
    expect((console.error as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('[Digest] Email failed:');
  });

  it('a failing read of the pending actions IS thrown (nothing to report on)', async () => {
    h.query.mockRejectedValue(new Error('db down'));
    await expect(sendDailyDigest()).rejects.toThrow('db down');
    expect(h.sendMail).not.toHaveBeenCalled();
  });
});
