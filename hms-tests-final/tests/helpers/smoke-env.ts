// Production smoke accounts — read by the helpers and global-setup before they build the credential map.
//
// Production accounts are Google-only (no password), so `npm run test:prod` signs in with two dedicated, READ-ONLY accounts on the
// reserved domain `hms-smoke.invalid` (the backend refuses every non-GET request from that domain — middleware/auth.ts). Their
// passwords are never in the repo: they live in hms-tests-final/.env.smoke.local (git-ignored, mode 600) or in the environment.
//   SMOKE_LEADERSHIP_EMAIL / SMOKE_LEADERSHIP_PASSWORD   — persona leadership (HR-tier: sees everything, can write nothing)
//   SMOKE_HM_EMAIL         / SMOKE_HM_PASSWORD           — persona hiring_manager (the restricted view)
import fs from 'fs';
import path from 'path';

export function loadSmokeEnv(): void {
  const file = path.join(process.cwd(), '.env.smoke.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export const isLocalTarget = (url: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
