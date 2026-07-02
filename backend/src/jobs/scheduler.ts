import cron from 'node-cron';
import { runSlaCheck, sendDailyDigest } from './slaChecker.js';

export function startScheduler(): void {
  // SLA check every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try { await runSlaCheck(); }
    catch (err) { console.error('[SLA] Check failed:', err); }
  });

  // Daily digest at 8:15am
  cron.schedule('15 8 * * *', async () => {
    try { await sendDailyDigest(); }
    catch (err) { console.error('[Digest] Failed:', err); }
  });

  console.log('  ✓ SLA check: every 15 minutes');
  console.log('  ✓ Daily digest: 8:15am');
}
