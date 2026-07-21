import { APIRequestContext } from '@playwright/test';
import fs from 'fs';
import path from 'path';

export const BASE          = process.env.TEST_API_URL      || 'http://localhost:4000';
export const FRONTEND_BASE = process.env.TEST_FRONTEND_URL || 'http://localhost:5173';

// ─── Ingest webhook secrets ────────────────────────────────────────────────────
// Defaults match docker-compose.yml's local dev values (already committed
// there in plaintext — same precedent followed here). Override via env var
// for any run against an environment with different secrets.
export const ROLE_INGEST_SECRET      = process.env.ROLE_INGEST_SECRET      || '22fc0ba4d5799b9fcfeb167b36820247264e87780571fa21566ce048d7b69400';
export const CANDIDATE_INGEST_SECRET = process.env.CANDIDATE_INGEST_SECRET || 'e9ba2e63e3a1167ce31671ee98831a884efc7f7e35986e778e9fce72fea4ed3f';
export const CRON_SECRET             = process.env.CRON_SECRET            || 'local_dev_cron_secret_not_for_prod';

// ─── Generic async-condition poller ───────────────────────────────────────────
// Several flows are fire-and-forget async on the backend (JD generation,
// ResumeIQ scoring) — there's nothing to await from the triggering request,
// so tests must poll the resulting state instead.
export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  { timeoutMs = 30000, intervalMs = 1500 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const start = Date.now();
  let last: T;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return last!;
}

// ─── Credential map ──────────────────────────────────────────────────────────
export const USERS = {
  // aaron.newton@ is genuinely seeded as 'leadership' (Founders Office), not
  // 'hr_recruiter' — confirmed directly against the DB. Kept as the 'hr' key
  // since leadership is a superset of hr_recruiter access everywhere in this
  // app (requireHR allows both), so it still works as the general
  // HR-privileged test identity; only its own persona field had to be
  // corrected to match reality.
  hr:          { email: 'aaron.newton@digitalpaani.com', password: 'password123', persona: 'leadership'      },
  hr2:         { email: 'garima@digitalpaani.com',       password: 'password123', persona: 'hr_recruiter'    },
  hm_alex:     { email: 'alex@digitalpaani.com',         password: 'password123', persona: 'hiring_manager'  },
  hm_satyadev: { email: 'satyadev@digitalpaani.com',     password: 'password123', persona: 'hiring_manager'  },
  leadership:  { email: 'nalin@digitalpaani.com',        password: 'password123', persona: 'leadership'      },
};

// ─── Load pre-cached tokens from globalSetup ─────────────────────────────────
function loadCachedTokens(): Record<string, string> {
  try {
    const p = path.join(process.cwd(), '.auth', 'tokens.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {}
  return {};
}

// In-process memory cache (avoids repeated file reads within one test file)
const _memCache: Partial<Record<keyof typeof USERS, string>> = {};

// ─── Get a JWT — memory → file → live login ───────────────────────────────────
export async function getToken(
  request: APIRequestContext,
  user: keyof typeof USERS
): Promise<string> {
  if (_memCache[user]) return _memCache[user]!;

  const fileCache = loadCachedTokens();
  if (fileCache[user]) {
    _memCache[user] = fileCache[user];
    return fileCache[user];
  }

  // Fallback: live login (will count against rate limiter in production)
  const cred = USERS[user];
  const res  = await request.post(`${BASE}/api/auth/login`, {
    data: { email: cred.email, password: cred.password },
  });
  const text = await res.text();
  let body: { token?: string };
  try   { body = JSON.parse(text); }
  catch { throw new Error(`Login parse failed for ${cred.email}: ${text.slice(0, 200)}`); }
  if (!body.token) throw new Error(`No token for ${cred.email}: ${JSON.stringify(body)}`);

  _memCache[user] = body.token;
  return body.token;
}

// ─── Authed request helpers ───────────────────────────────────────────────────
export function authed(request: APIRequestContext, token: string) {
  const h = { Authorization: `Bearer ${token}` };
  return {
    get:   (path: string)               => request.get(`${BASE}${path}`,   { headers: h }),
    post:  (path: string, data: object) => request.post(`${BASE}${path}`,  { headers: h, data }),
    patch: (path: string, data: object) => request.patch(`${BASE}${path}`, { headers: h, data }),
  };
}

// ─── Test data helpers ────────────────────────────────────────────────────────
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export async function createCandidate(
  request: APIRequestContext,
  token: string,
  overrides: Record<string, unknown> = {}
) {
  const res  = await authed(request, token).post('/api/candidates', {
    full_name: `Test Candidate ${uid()}`,
    email:     `test+${uid()}@example.com`,
    ...overrides,
  });
  const body = await res.json();
  return { res, candidate: body.candidate };
}

export async function createCandidateWithApp(
  request: APIRequestContext,
  token: string,
  roleId = 'R006'
) {
  const { candidate, res } = await createCandidate(request, token, { role_id: roleId });
  const body = await res.json();
  return { candidate, application: body.application };
}

// Seeded role IDs from seed.sql
export const SEEDED = {
  roles: {
    backend_dev:  'R001',
    ei_mumbai:    'R002',
    ei_hyd:       'R003',
    process_mgr:  'R004',
    qa_eng:       'R005',
    senior_pm:    'R006',
    senior_ux:    'R007',
  },
};
