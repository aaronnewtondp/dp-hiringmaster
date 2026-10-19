// Sourcing module e-mails (internal only, from hr@ via the existing Gmail service): a daily note to the HR team (one message to every
// active HR/Admin user — sourcing is owned by the persona, not by individuals) and a Monday summary to leadership. Everything here is
// OFF until someone switches it on in the sourcing settings (`daily_digest_enabled`, a non-empty `digest_recipients`), and a send
// problem can never fail the cron run.
//
// Called from the daily cron (Vercel Hobby = one run a day). To make a retried or manually re-run cron harmless, each kind
// is CLAIMED for the day before anything is sent (an atomic upsert in sourcing_settings): at most one send per day per kind.
// A claimed day whose send then fails is not retried — a missed digest beats a duplicated one.
import { query } from '../db/index.js';
import { sendAssignmentEmail } from './gmailService.js';
import { loadSettings } from './sourcingSettings.js';
import { buildHrDigest, buildWeeklySummary, DigestDue, DigestException } from '../utils/sourcingDigest.js';
import { ageDays, describeException } from '../utils/sourcingDescribe.js';
import { OPEN_ROLE_STATUSES } from '../utils/sourcingConfig.js';
import { isWorkingDay, istDate, weekdayOf } from '../utils/workingDays.js';

export type DigestSender = (i: { to: string; subject: string; text: string }) => Promise<unknown>;

export interface DigestResult {
  daily_sent: boolean;
  weekly_sent: boolean;
  skipped: string[];
  errors: string[];
}

const COMPANY_EMAIL = /^[^\s@]+@digitalpaani\.com$/i;
const OPEN = OPEN_ROLE_STATUSES as unknown as string[];

/** Atomically take "today" for this kind of digest. True only for the first caller of the day. */
async function claimToday(kind: 'daily' | 'weekly', today: string): Promise<boolean> {
  const rows = await query<{ key: string }>(
    `INSERT INTO sourcing_settings (key, value) VALUES ($1, to_jsonb($2::text))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       WHERE sourcing_settings.value <> EXCLUDED.value
     RETURNING key`, [`digest_last_${kind}`, today]);
  return rows.length > 0;
}

interface ExceptionRow {
  role_id: string; title: string; priority: string;
  channel: string; type: string; evidence: Record<string, unknown>; detected_at: Date;
}
const toDigestException = (r: ExceptionRow, now: Date): DigestException => ({
  role_id: r.role_id, role_title: r.title, priority: r.priority, channel: r.channel,
  age_days: ageDays(r.detected_at, now), ...describeException({ type: r.type, channel: r.channel, evidence: r.evidence }),
});

async function liveExceptions(): Promise<ExceptionRow[]> {
  return query<ExceptionRow>(
    `SELECT r.id AS role_id, r.title, r.priority,
            e.channel, e.type, e.evidence, e.detected_at
       FROM sourcing_exceptions e JOIN sourcing_plans p ON p.id = e.plan_id JOIN roles r ON r.id = p.role_id
      WHERE e.status = 'open' AND NOT e.is_shadow AND r.status = ANY($1::text[])
      ORDER BY e.severity DESC, e.detected_at`, [OPEN]);
}

async function sendHrDigest(now: Date, today: string, baseUrl: string | undefined, send: DigestSender, res: DigestResult) {
  const [exceptions, due, people] = await Promise.all([
    liveExceptions(),
    query<{ role_id: string; role_title: string; channel: string; title: string; due_at: Date }>(
      `SELECT r.id AS role_id, r.title AS role_title, ch.channel, c.title, c.due_at
         FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id = c.plan_channel_id
         JOIN sourcing_plans p ON p.id = ch.plan_id JOIN roles r ON r.id = p.role_id
        WHERE c.status = 'open' AND p.status = 'active' AND ch.state <> 'excluded'
          AND r.status = ANY($1::text[])
          AND c.due_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`, [OPEN, today]),
    query<{ email: string }>(`SELECT email FROM users WHERE is_active = true AND persona IN ('hr_recruiter','super_admin') ORDER BY email`),
  ]);

  const mail = buildHrDigest({
    today, baseUrl,
    exceptions: exceptions.map(e => toDigestException(e, now)),
    dueToday: due.map<DigestDue>(d => ({ role_id: d.role_id, role_title: d.role_title, channel: d.channel, title: d.title, overdue: new Date(d.due_at).getTime() < now.getTime() })),
  });
  if (!mail) return;
  // Company mailboxes only: exception data is internal, so a stray address can never receive it.
  const to = people.map(p => p.email).filter(e => COMPANY_EMAIL.test(e));
  if (to.length === 0) { res.skipped.push('no HR/Admin user with a company address to send the daily note to'); return; }
  try { await send({ to: to.join(', '), ...mail }); res.daily_sent = true; }
  catch (err) { res.errors.push(`daily HR digest: ${(err as Error).message}`); }
}

async function sendWeekly(now: Date, today: string, baseUrl: string | undefined, recipients: string[], send: DigestSender, res: DigestResult) {
  const [exceptions, counts, onTime, overdue, provisional] = await Promise.all([
    liveExceptions(),
    query<{ status: string; n: string }>(
      `SELECT p.status, count(*) AS n FROM sourcing_plans p JOIN roles r ON r.id = p.role_id WHERE r.status = ANY($1::text[]) GROUP BY p.status`, [OPEN]),
    query<{ done: string; on_time: string }>(
      `SELECT count(*) AS done, count(*) FILTER (WHERE l.done_at <= l.was_due_at) AS on_time FROM sourcing_commitment_log l
        WHERE l.done_at >= NOW() - INTERVAL '14 days' AND COALESCE(l.note,'') <> 'Already running at plan activation'`),
    query<{ n: string }>(
      `SELECT count(*) AS n FROM sourcing_commitments c JOIN sourcing_plan_channels ch ON ch.id = c.plan_channel_id JOIN sourcing_plans p ON p.id = ch.plan_id
        WHERE c.status = 'open' AND c.due_at < NOW() AND p.status = 'active' AND ch.state <> 'excluded'`),
    query<{ n: string }>(
      `SELECT count(*) AS n FROM sourcing_exceptions e JOIN sourcing_plans p ON p.id = e.plan_id JOIN roles r ON r.id = p.role_id
        WHERE e.status = 'open' AND e.is_shadow AND r.status = ANY($1::text[])`, [OPEN]),
  ]);
  const n = (st: string) => Number(counts.find(c => c.status === st)?.n ?? 0);
  const done = Number(onTime[0]?.done ?? 0);
  const mail = buildWeeklySummary({
    today, baseUrl, plansActive: n('active'), plansDraft: n('draft'), openRoles: counts.reduce((s, c) => s + Number(c.n), 0),
    onTimePct: done ? Math.round((Number(onTime[0]?.on_time ?? 0) / done) * 100) : null,
    overdueCommitments: Number(overdue[0]?.n ?? 0), provisionalSignals: Number(provisional[0]?.n ?? 0),
    exceptions: exceptions.map(e => toDigestException(e, now)),
  });
  try { await send({ to: recipients.join(', '), ...mail }); res.weekly_sent = true; }
  catch (err) { res.errors.push(`weekly summary: ${(err as Error).message}`); }
}

export async function sendSourcingDigests(now: Date = new Date(), send: DigestSender = sendAssignmentEmail): Promise<DigestResult> {
  const res: DigestResult = { daily_sent: false, weekly_sent: false, skipped: [], errors: [] };
  try {
    const settings = await loadSettings();
    const today = istDate(now);
    const baseUrl = process.env.FRONTEND_URL;

    if (!settings.daily_digest_enabled) res.skipped.push('the daily HR digest is switched off');
    else if (!isWorkingDay(today)) res.skipped.push('not a working day');
    else if (!(await claimToday('daily', today))) res.skipped.push('the daily HR digest was already sent today');
    else await sendHrDigest(now, today, baseUrl, send, res);

    if (settings.digest_recipients.length === 0) res.skipped.push('no weekly recipients configured');
    else if (weekdayOf(today) !== 1) res.skipped.push('weekly summary goes out on Mondays');
    else if (!(await claimToday('weekly', today))) res.skipped.push('weekly summary already sent today');
    else await sendWeekly(now, today, baseUrl, settings.digest_recipients, send, res);
  } catch (err) {
    res.errors.push(`digests failed: ${(err as Error).message}`);
  }
  return res;
}
