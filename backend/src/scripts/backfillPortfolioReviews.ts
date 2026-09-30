// One-off / re-runnable: queue a portfolio review for every existing application
// of a portfolio-enabled role that has never had one. Calls the deployed API's
// secret-protected batch route in small pages (each application re-reads its
// resume from Drive, so a call is kept well inside the 60s function limit) and
// keeps going until the route reports there is nothing left.
//
//   HMS_API_URL=https://<your-backend>.vercel.app ROLE_INGEST_SECRET=... \
//     npx tsx src/scripts/backfillPortfolioReviews.ts --role R007 [--statuses Active,"Hold for Future"] [--limit 6] [--dry-run]
//
// The reviews themselves run afterwards on the portfolio worker, ~1-2 minutes
// each, via the queue — this script only queues them, so it finishes quickly.
// Safe to re-run: applications already reviewed (or queued) are skipped.

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const base = (process.env.HMS_API_URL || '').replace(/\/$/, '');
  const secret = process.env.ROLE_INGEST_SECRET;
  const roleId = arg('role');
  if (!base || !secret || !roleId) {
    console.error('Usage: HMS_API_URL=<backend url> ROLE_INGEST_SECRET=<secret> npx tsx src/scripts/backfillPortfolioReviews.ts --role R007 [--statuses Active] [--limit 6] [--dry-run]');
    process.exit(1);
  }
  const statuses = (arg('statuses', 'Active') as string).split(',').map(s => s.trim()).filter(Boolean);
  const limit = Math.min(parseInt(arg('limit', '6') as string, 10) || 6, 10);
  const dryRun = has('dry-run');

  let offset = 0, queued = 0, settled = 0, unchanged = 0, pages = 0;
  for (;;) {
    const res = await fetch(`${base}/api/applications/portfolio-backfill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-secret': secret },
      body: JSON.stringify({ role_id: roleId, statuses, limit, offset, dry_run: dryRun }),
    });
    if (!res.ok) { console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
    const body = await res.json() as {
      remaining_before: number; processed: number; left_unchanged: number; next_offset: number | null;
      results: Array<{ id: string; status: string; links?: number; queued?: boolean; error?: string }>;
    };
    pages++;
    if (pages === 1) console.log(`${body.remaining_before} application(s) of ${roleId} (${statuses.join(', ')}) have never been reviewed${dryRun ? ' — DRY RUN, nothing will be queued' : ''}`);
    for (const r of body.results) {
      if (r.status === 'pending') queued += r.queued ? 1 : 0;
      else if (r.status === 'no_portfolio') settled++;
      if (r.error) console.log(`  ${r.id}: ${r.status} — ${r.error}`);
      else console.log(`  ${r.id}: ${r.status}${r.links != null ? ` (${r.links} link${r.links === 1 ? '' : 's'})` : ''}${r.queued === false && r.status === 'pending' ? ' — NOT queued (queue unavailable); use Re-run later' : ''}`);
    }
    unchanged += body.left_unchanged;
    if (body.next_offset == null) break;
    offset = body.next_offset;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`\nDone. queued for review: ${queued}, settled without a browser (no portfolio link): ${settled}, left unchanged: ${unchanged}`);
}
main().catch(e => { console.error(e); process.exit(1); });
