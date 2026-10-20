#!/usr/bin/env node
// Production smoke-test accounts (see README → "Production smoke accounts").
//
//   node scripts/smoke-accounts.mjs            print the SQL that creates / refreshes the two accounts from the passwords in
//                                              .env.smoke.local (the file is created with fresh random passwords if missing)
//   node scripts/smoke-accounts.mjs --rotate   replace both passwords with new random ones, then print the SQL
//
// The passwords are NEVER printed — only their bcrypt hashes, inside the SQL. Run the SQL yourself against the production
// database (Supabase → SQL editor) once; nothing here touches any database. For local Docker, pipe it in:
//   node scripts/smoke-accounts.mjs | docker exec -i dp_hms_db psql -U hms_user -d dp_hms
//
// The accounts sit on the reserved domain hms-smoke.invalid (no real mailbox can exist there, Google sign-in can never reach
// them) and the backend refuses every non-GET request from that domain (backend/src/middleware/auth.ts).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '..', '.env.smoke.local');
const bcrypt = createRequire(path.join(here, '..', '..', 'backend', 'package.json'))('bcryptjs');   // the backend's own dependency

const ACCOUNTS = [
  { key: 'LEADERSHIP', name: 'Smoke Test (Leadership)',    email: 'smoke.leadership@hms-smoke.invalid', persona: 'leadership' },
  { key: 'HM',         name: 'Smoke Test (Hiring Manager)', email: 'smoke.hm@hms-smoke.invalid',         persona: 'hiring_manager' },
];

const read = () => {
  const env = {};
  if (!fs.existsSync(envFile)) return env;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
  }
  return env;
};

let env = read();
const rotate = process.argv.includes('--rotate');
if (rotate || !ACCOUNTS.every(a => env[`SMOKE_${a.key}_PASSWORD`])) {
  const fresh = Object.fromEntries(ACCOUNTS.map(a => [a.key, crypto.randomBytes(24).toString('base64url')]));
  fs.writeFileSync(envFile, [
    '# Production smoke-test accounts (read-only by design) — see hms-tests-final/README.md. NEVER commit; this file is git-ignored.',
    ...ACCOUNTS.flatMap(a => [`SMOKE_${a.key}_EMAIL=${a.email}`, `SMOKE_${a.key}_PASSWORD=${fresh[a.key]}`]), '',
  ].join('\n'), { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  env = read();
  console.error(`-- ${rotate ? 'rotated' : 'created'} ${path.relative(process.cwd(), envFile)} (mode 600). Passwords are not printed.`);
}

const q = s => `'${String(s).replace(/'/g, "''")}'`;
const rows = ACCOUNTS.map(a =>
  ` (${q(a.name)}, ${q(a.email)}, ${q(bcrypt.hashSync(env[`SMOKE_${a.key}_PASSWORD`], 12))}, ${q(a.persona)}, 'Automation', true, 'email')`);

console.log(`-- Production smoke-test accounts: read-only, password sign-in only, reserved domain. Safe to re-run (it refreshes the hash).
INSERT INTO public.users (name, email, password_hash, persona, department, is_active, auth_provider)
VALUES
${rows.join(',\n')}
ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, persona = EXCLUDED.persona, is_active = true
RETURNING id, name, email, persona, is_active;`);
