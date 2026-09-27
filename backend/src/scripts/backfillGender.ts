// ─── Backfill gender for existing candidates ───────────────────────────────────
// One-time (or safely re-runnable) pass over every candidates row with
// gender IS NULL, auto-tagging via genderClassifier.ts (see that file's own
// header for methodology). Only ever writes rows currently NULL — never
// overwrites a value already set (whether by this same script on an earlier
// run, an ingestion path's own auto-tag, or an HR manual correction), so
// it's always safe to re-run after new candidates have been added.
//
// Usage:
//   npx tsx src/scripts/backfillGender.ts [--dry-run]
//
// --dry-run prints exactly what would be written (id, name, classified
// gender) and how many rows would stay Unknown, without touching the DB.
import 'dotenv/config';
import { query, pool } from '../db/index.js';
import { classifyGender } from '../utils/genderClassifier.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const candidates = await query<{ id: string; full_name: string }>(
    `SELECT id, full_name FROM candidates WHERE gender IS NULL`
  );
  console.log(`${candidates.length} candidates with no gender tag yet.`);

  let tagged = 0;
  let unknown = 0;
  const updates: Array<{ id: string; gender: 'M' | 'F' }> = [];

  for (const c of candidates) {
    const gender = classifyGender(c.full_name);
    if (gender) {
      tagged++;
      updates.push({ id: c.id, gender });
    } else {
      unknown++;
    }
  }

  console.log(`Would tag ${tagged} (${((tagged / candidates.length) * 100 || 0).toFixed(1)}%); ${unknown} stay Unknown (no dictionary/heuristic match — not guessed).`);

  if (dryRun) {
    console.log('--dry-run: no changes written. Sample of first 20 classifications:');
    for (const c of candidates.slice(0, 20)) {
      console.log(`  ${c.id}  ${c.full_name}  ->  ${classifyGender(c.full_name) ?? 'Unknown'}`);
    }
    return;
  }

  // Batched, not one UPDATE per row — candidates table can be in the
  // thousands; a single statement with a VALUES list + JOIN is one round
  // trip regardless of size, same reasoning as slaChecker.ts's own
  // applyBreachBatch comment on why per-row round trips don't scale.
  const BATCH_SIZE = 500;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    const valuesSql = batch.map((_, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2})`).join(', ');
    const params = batch.flatMap(u => [u.id, u.gender]);
    await query(
      `UPDATE candidates c SET gender = v.gender
       FROM (VALUES ${valuesSql}) AS v(id, gender)
       WHERE c.id = v.id`,
      params
    );
    console.log(`Wrote ${Math.min(i + BATCH_SIZE, updates.length)}/${updates.length}`);
  }

  console.log('Done.');
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
