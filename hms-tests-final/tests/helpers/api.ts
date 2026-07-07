import { APIRequestContext } from '@playwright/test';
import fs from 'fs';
import path from 'path';

export const BASE          = process.env.TEST_API_URL      || 'http://localhost:4000';
export const FRONTEND_BASE = process.env.TEST_FRONTEND_URL || 'http://localhost:5173';

// ─── Credential map ──────────────────────────────────────────────────────────
export const USERS = {
  hr:          { email: 'aaron.newton@digitalpaani.com', password: 'password123', persona: 'hr_recruiter'    },
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
