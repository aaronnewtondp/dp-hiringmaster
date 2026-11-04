/**
 * Helpers shared by the API specs 42-50 (and the specs they replaced weak assertions in). Kept in their own file so the foundation-owned
 * helpers (api.ts, db.ts, dates.ts ...) stay untouched.
 *
 *   JWT forging      signJwt / forgeToken / unsignedToken / withTamperedPayload   (node:crypto only: no new dependency)
 *   data builders    newApplicationAt / newRound / roundsOf / openPending / applicationRow
 *   misc             rawStatus, settleAll, HR_TIER_USERS
 */
import crypto from 'node:crypto';
import { APIRequestContext } from '@playwright/test';
import { BASE, authed, createCandidateWithApp, getToken, uid } from './api';
import { withDb } from './db';

// ─── JWT forging ──────────────────────────────────────────────────────────────
// The backend verifies HMAC-SHA256 tokens with JWT_SECRET. The isolated stack (scripts/test-stack.sh) and docker-compose both run with
// the same public dev secret (committed in both, and in helpers/api.ts' sibling constants), so a spec can mint any token it needs.
// Override with TEST_JWT_SECRET for a backend that uses another secret. Production is never reachable from these projects.
export const DEV_JWT_SECRET = process.env.TEST_JWT_SECRET || 'change_this_in_production_to_a_long_random_string';

const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');

export interface SignOptions {
  secret?: string;
  /** JOSE alg name written into the header; only HS256 is actually computed. */
  alg?: string;
  /** Lifetime in seconds from `iat` (negative = already expired). Ignored when the payload already carries `exp`. */
  expiresInSec?: number;
  /** Seconds since the epoch; default now. */
  iat?: number;
}

/** A compact JWS (HS256) over `payload`. Adds iat and exp unless the payload carries them. */
export function signJwt(payload: Record<string, unknown>, opts: SignOptions = {}): string {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const body = { iat, exp: iat + (opts.expiresInSec ?? 3600), ...payload };
  const head = b64url(JSON.stringify({ alg: opts.alg ?? 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64url(JSON.stringify(body))}`;
  const sig = crypto.createHmac('sha256', opts.secret ?? DEV_JWT_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export interface ForgedUser {
  email: string;
  persona: 'hr_recruiter' | 'hiring_manager' | 'leadership' | 'super_admin';
  /** Defaults to a random UUID: fine for every read and for any write that does not reference users(id). */
  userId?: string;
  name?: string;
}

/** A token exactly shaped like the backend's own (userId, email, persona, name). */
export function forgeToken(user: ForgedUser, opts: SignOptions = {}): string {
  return signJwt({
    userId:  user.userId ?? crypto.randomUUID(),
    email:   user.email,
    persona: user.persona,
    name:    user.name ?? 'Forged User',
  }, opts);
}

/** `alg: none` with an empty signature: the classic bypass attempt. */
export function unsignedToken(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.`;
}

/** Keeps the header and the SIGNATURE of `token` and replaces its payload fields: a signature that no longer matches. */
export function withTamperedPayload(token: string, patch: Record<string, unknown>): string {
  const [head, body, sig] = token.split('.');
  const payload = { ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), ...patch };
  return `${head}.${b64url(JSON.stringify(payload))}.${sig}`;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

// ─── Requests that carry no helper-made Authorization header ──────────────────
/** Status (and parsed body, JSON or text) of a request with caller-chosen headers. */
export async function rawStatus(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'HEAD' | 'OPTIONS',
  path: string,
  { headers = {}, data }: { headers?: Record<string, string>; data?: unknown } = {},
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const res = await request.fetch(`${BASE}${path}`, { method, headers, data: data as object | undefined });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not JSON (Express 404 page, empty body) */ }
  return { status: res.status(), body, headers: res.headers() };
}

// ─── Data builders ────────────────────────────────────────────────────────────
export const HR_TIER_USERS = ['hr', 'hr2', 'leadership', 'super_admin'] as const;

// ─── Keeping the shared queues small ──────────────────────────────────────────
// GET /api/dashboard/pending answers only the 100 OLDEST open rows (ORDER BY priority_level DESC, created_at ASC LIMIT 100), so a test that
// looks for a freshly raised row there (api/02 "updating ctc_band creates a Leadership pending action") stops finding it once enough open
// rows have piled up. Every application a spec of this family creates is therefore RETIRED in afterAll: its open pending_actions rows are
// resolved and it is closed, so a run leaves no open work behind (and the SLA sweep, which only looks at Active applications, ignores it).
// Register with `test.afterAll(retireTrackedApplications)` at the top of a spec file.
const tracked = new Set<string>();
export function trackApplication(applicationId: string): void { tracked.add(applicationId); }

export async function retireTrackedApplications(): Promise<void> {
  if (!tracked.size) return;
  const ids = [...tracked];
  tracked.clear();
  await withDb(async c => {
    await c.query(`UPDATE pending_actions SET resolved = true, resolved_at = NOW() WHERE application_id = ANY($1::text[]) AND resolved = false`, [ids]);
    await c.query(`UPDATE applications SET status = 'Closed', sla_breach = false WHERE id = ANY($1::text[]) AND status = 'Active'`, [ids]);
  });
}

/** A fresh candidate + application on `roleId`, moved by HR to `stage` ('Applied and Screened' = left where creation put it). */
export async function newApplicationAt(
  request: APIRequestContext,
  stage = 'Applied and Screened',
  roleId = 'R006',
) {
  const hrToken = await getToken(request, 'hr');
  const hr = authed(request, hrToken);
  const { candidate, application } = await createCandidateWithApp(request, hrToken, roleId);
  trackApplication(application.id);
  if (stage !== 'Applied and Screened') {
    const res = await hr.post(`/api/applications/${application.id}/stage`, { new_stage: stage });
    if (res.status() !== 200) throw new Error(`newApplicationAt: moving ${application.id} to ${stage} answered ${res.status()}`);
  }
  return { hrToken, hr, candidate, application: application as { id: string; role_id: string; candidate_id: string } };
}

/** A round created through the real API. No scheduled_date unless given, so no Calendar invite is ever attempted. */
export async function newRound(
  hr: ReturnType<typeof authed>,
  applicationId: string,
  body: Record<string, unknown> = {},
) {
  const res = await hr.post('/api/interviews', {
    application_id: applicationId, round_name: `Round ${uid()}`, round_number: 1, ...body,
  });
  if (res.status() !== 201) throw new Error(`newRound: POST /api/interviews answered ${res.status()} ${await res.text()}`);
  const { round, calendar, email } = await res.json();
  return { round, calendar, email } as { round: Record<string, any>; calendar?: { synced: boolean; error?: string }; email?: { sent: boolean; error?: string } };
}

export async function roundsOf(hr: ReturnType<typeof authed>, applicationId: string): Promise<Array<Record<string, any>>> {
  const res = await hr.get(`/api/interviews?application_id=${applicationId}`);
  return (await res.json()).rounds;
}

export async function activityOf(hr: ReturnType<typeof authed>, applicationId: string): Promise<Array<Record<string, any>>> {
  const res = await hr.get(`/api/applications/${applicationId}`);
  return (await res.json()).activity;
}

/** pending_actions rows for one application straight from the database (the /dashboard/pending queue is capped at 100 rows). */
export async function pendingRows(applicationId: string): Promise<Array<Record<string, any>>> {
  return withDb(async c => (await c.query(
    'SELECT id, owner_type, action_type, responsible_person, resolved, role_id, candidate_name FROM pending_actions WHERE application_id = $1 ORDER BY id',
    [applicationId],
  )).rows);
}

export async function applicationRow(applicationId: string): Promise<Record<string, any>> {
  return withDb(async c => (await c.query('SELECT * FROM applications WHERE id = $1', [applicationId])).rows[0]);
}

/** Runs `fn(0..n-1)` all at once and returns every outcome (a rejection is returned as { error }, never thrown). */
export async function settleAll<T>(n: number, fn: (i: number) => Promise<T>): Promise<Array<{ value?: T; error?: unknown }>> {
  const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));
  return results.map(r => (r.status === 'fulfilled' ? { value: r.value } : { error: r.reason }));
}
