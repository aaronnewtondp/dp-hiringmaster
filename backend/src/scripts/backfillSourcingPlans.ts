// ─── Backfill draft sourcing plans for every open role ─────────────────────────
// One-time (safely re-runnable) pass: creates a DRAFT plan — channels seeded from roles.recruitment_mode — for each
// Approved / Live – Sourcing role that has none. A draft is not tracked until someone activates it and its volume signal is always provisional; it raises only
// PLAN_NOT_ACTIVATED (live), for a role approved on/after go-live and more than 1 working day ago.
// (The engine and the role view do the same lazily; this just makes the "Plans to activate" checklist complete on day one.)
//
// Usage:
//   npx tsx src/scripts/backfillSourcingPlans.ts [--dry-run]
//
// Needs the sourcing_* tables (backend/src/db/schema.sql). Does not need SOURCING_ENABLED — it is a data step.
import 'dotenv/config';
import { query, pool } from '../db/index.js';
import { ensureDraftPlansForOpenRoles } from '../services/sourcingPlans.js';
import { OPEN_ROLE_STATUSES } from '../utils/sourcingConfig.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const open = OPEN_ROLE_STATUSES as unknown as string[];

  const missing = await query<{ id: string; title: string; priority: string; recruitment_mode: string[] | null }>(
    `SELECT r.id, r.title, r.priority, r.recruitment_mode FROM roles r
      WHERE r.status = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM sourcing_plans p WHERE p.role_id = r.id)
      ORDER BY r.priority, r.id`, [open]);
  console.log(`${missing.length} open role(s) without a sourcing plan:`);
  for (const r of missing) console.log(`  ${r.id}  ${r.priority}  ${r.title}  [${(r.recruitment_mode ?? []).join(', ') || 'no channels yet'}]`);

  if (dryRun) { console.log('\n--dry-run: nothing written.'); return; }
  const created = await ensureDraftPlansForOpenRoles();
  console.log(`\nCreated ${created} draft plan(s).`);
}

main().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => pool.end());
