// Fast cleanup of throwaway roles (and everything hanging off them) for the LOCAL sourcing specs.
//
// Why this exists: `pending_actions` has foreign keys to applications and roles with NO index on them, so on a local database that has
// seen months of test churn (millions of rows) every single deleted application or role costs a sequential scan of that table (~0.5 s each).
// A spec that makes a few hundred applications then spends minutes in afterAll and trips Playwright's hook timeout. Here the whole purge
// runs in ONE transaction with foreign-key triggers off (`session_replication_role = replica`, local Postgres is a superuser), and the rows
// those cascades would have removed are deleted explicitly, each with a single set-based statement.
import fs from 'fs';
import path from 'path';
import type { Client } from 'pg';

/**
 * The one-off data migration that closes backend/src/db/schema.sql (fixes up what the first version of the weekly tracker left behind):
 * everything from its marker comment to the end of the file, exactly as it is in the repo — the specs run THAT text, never a copy.
 * Throws if the marker is gone or the block no longer holds exactly the three UPDATE statements the specs were written against (skip the retired
 * weekly_outbound tasks · retitle an OPEN first task of a tracked channel · re-open the DONE first task of a live tracked channel that has no
 * weekly target), so a changed migration cannot be silently skipped.
 */
export const TRACKER_MIGRATION_MARKER = '-- Data left behind by the first version of the tracker';
export function trackerMigrationSql(): string {
  const file = path.join(process.cwd(), '..', 'backend', 'src', 'db', 'schema.sql');
  const all = fs.readFileSync(file, 'utf8');
  const at = all.indexOf(TRACKER_MIGRATION_MARKER);
  if (at < 0) throw new Error(`the marker "${TRACKER_MIGRATION_MARKER}" is not in ${file} any more — update helpers/sourcing-db.ts and the migration specs`);
  const block = all.slice(at);
  // statements start at the beginning of a line: two plain UPDATEs (skip the retired task, retitle the open first tasks) and one WITH … UPDATE … INSERT
  // (the re-opening, which also writes the plan history)
  const statements = block.match(/^(UPDATE|WITH) /gm) ?? [];
  if (statements.length !== 3) throw new Error(`the tracker migration block holds ${statements.length} statements, the specs expect 3 (2 UPDATE + 1 WITH) — update them with the migration`);
  return block;
}

export async function purgeRolesFast(client: Client, roleIds: string[], candidateEmailLikes: string[] = []): Promise<void> {
  if (!roleIds.length && !candidateEmailLikes.length) return;
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL session_replication_role = replica`);
    const apps = (await client.query(
      `SELECT a.id FROM applications a LEFT JOIN candidates c ON c.id = a.candidate_id
        WHERE a.role_id = ANY($1::text[]) OR c.email LIKE ANY($2::text[])`, [roleIds, candidateEmailLikes])).rows.map(r => r.id as string);

    await client.query(`DELETE FROM pending_actions WHERE role_id = ANY($1::text[]) OR application_id = ANY($2::text[])`, [roleIds, apps]);
    for (const table of ['interview_rounds', 'ref_checks', 'portfolio_analyses', 'activity_log', 'notification_log']) {
      await client.query(`DELETE FROM ${table} WHERE application_id = ANY($1::text[])`, [apps]);
    }
    await client.query(`DELETE FROM activity_log WHERE role_id = ANY($1::text[])`, [roleIds]);
    await client.query(`DELETE FROM applications WHERE id = ANY($1::text[])`, [apps]);

    // what ON DELETE CASCADE from roles -> sourcing_plans would have removed, leaves first
    const planIds = (await client.query(`SELECT id FROM sourcing_plans WHERE role_id = ANY($1::text[])`, [roleIds])).rows.map(r => r.id as string);
    const channelIds = (await client.query(`SELECT id FROM sourcing_plan_channels WHERE plan_id = ANY($1::bigint[])`, [planIds])).rows.map(r => r.id as string);
    const commitmentIds = (await client.query(`SELECT id FROM sourcing_commitments WHERE plan_channel_id = ANY($1::bigint[])`, [channelIds])).rows.map(r => r.id as string);
    const logIds = (await client.query(`SELECT id FROM sourcing_commitment_log WHERE commitment_id = ANY($1::bigint[])`, [commitmentIds])).rows.map(r => r.id as string);
    await client.query(`DELETE FROM sourcing_evidence WHERE log_id = ANY($1::bigint[])`, [logIds]);
    await client.query(`DELETE FROM sourcing_commitment_log WHERE id = ANY($1::bigint[])`, [logIds]);
    await client.query(`DELETE FROM sourcing_commitments WHERE id = ANY($1::bigint[])`, [commitmentIds]);
    await client.query(`DELETE FROM sourcing_channel_weeks WHERE plan_channel_id = ANY($1::bigint[])`, [channelIds]);
    await client.query(`DELETE FROM sourcing_plan_channels WHERE id = ANY($1::bigint[])`, [channelIds]);
    await client.query(`DELETE FROM sourcing_exceptions WHERE plan_id = ANY($1::bigint[])`, [planIds]);
    await client.query(`DELETE FROM sourcing_plan_changes WHERE plan_id = ANY($1::bigint[])`, [planIds]);
    await client.query(`DELETE FROM sourcing_advice WHERE plan_id = ANY($1::bigint[])`, [planIds]);
    await client.query(`DELETE FROM sourcing_plans WHERE id = ANY($1::bigint[])`, [planIds]);

    await client.query(`DELETE FROM role_edit_log WHERE role_id = ANY($1::text[])`, [roleIds]);
    await client.query(`DELETE FROM roles WHERE id = ANY($1::text[])`, [roleIds]);

    // candidates this spec made (no application references them any more)
    if (candidateEmailLikes.length) {
      await client.query(`DELETE FROM activity_log WHERE candidate_id IN (SELECT id FROM candidates WHERE email LIKE ANY($1::text[]))`, [candidateEmailLikes]);
      await client.query(`DELETE FROM candidate_edit_log WHERE candidate_id IN (SELECT id FROM candidates WHERE email LIKE ANY($1::text[]))`, [candidateEmailLikes]);
      await client.query(`DELETE FROM candidates WHERE email LIKE ANY($1::text[])`, [candidateEmailLikes]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
