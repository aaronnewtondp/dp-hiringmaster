// Plain-text bodies for the Sourcing module's internal e-mails. Pure (data in, text out) so what is said — and, as
// important, when NOTHING is sent — is unit-tested. Internal only: recipients are validated company addresses.
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

export interface DigestException {
  role_id: string; role_title: string; priority: string; channel: string;
  committed: string; happened: string; next_action: string; age_days: number;
}
export interface DigestDue { role_id: string; role_title: string; channel: string; title: string; overdue: boolean }
export interface Email { subject: string; text: string }

const link = (baseUrl: string | undefined, roleId: string) => (baseUrl ? `${baseUrl.replace(/\/+$/, '')}/dashboard?sourcing_role=${encodeURIComponent(roleId)}#sourcing-workspace` : '');

/**
 * Daily note to the HR team (sourcing belongs to the HR/Admin persona as a whole, so one message goes to everyone in it). Returns null
 * when there is nothing to say — an empty "all clear" every morning teaches people to ignore the one that matters. Provisional (shadow)
 * signals never reach this function.
 */
export function buildHrDigest(i: { today: string; baseUrl?: string; dueToday: DigestDue[]; exceptions: DigestException[] }): Email | null {
  const due = i.dueToday.filter(d => !d.overdue);
  if (due.length === 0 && i.exceptions.length === 0) return null;

  const lines: string[] = ['Hi team,', ''];
  if (i.exceptions.length) {
    lines.push(`Needs attention (${i.exceptions.length}):`);
    for (const e of i.exceptions) {
      lines.push(`• ${e.role_title} (${e.priority})${e.channel !== '*' ? ` — ${e.channel}` : ''}`);
      lines.push(`    ${e.happened}. Next: ${e.next_action}.`);
      const l = link(i.baseUrl, e.role_id); if (l) lines.push(`    ${l}`);
    }
    lines.push('');
  }
  if (due.length) {
    lines.push(`Due today (${due.length}):`);
    for (const d of due) lines.push(`• ${d.role_title} — ${d.channel}: ${d.title}`);
    lines.push('');
  }
  lines.push('Mark things done, or choose how to resolve them, from the Sourcing plans section on the Dashboard in HMS (or My Tasks → Sourcing).');

  const n = i.exceptions.length;
  const bits = [n ? `${plural(n, 'item')} ${n === 1 ? 'needs' : 'need'} attention` : '', due.length ? `${due.length} due today` : ''].filter(Boolean);
  return { subject: `Sourcing — ${bits.join(', ')} (${i.today})`, text: lines.join('\n') };
}

/**
 * Monday summary for leadership. Always sends (a quiet week is information too). Lists exceptions by role; the HR team owns them,
 * so no individual is named and nobody is ranked or totalled against anybody else.
 */
export function buildWeeklySummary(i: {
  today: string; baseUrl?: string; plansActive: number; plansDraft: number; openRoles: number; onTimePct: number | null;
  overdueCommitments: number; exceptions: DigestException[]; provisionalSignals: number;
}): Email {
  const lines: string[] = [
    `Sourcing execution — week of ${i.today}`, '',
    `${i.plansActive} of ${plural(i.openRoles, 'open role')} have an active plan${i.plansDraft ? `; ${i.plansDraft} still waiting to be activated` : ''}.`,
    `Commitments done on time (last 14 days): ${i.onTimePct === null ? 'nothing was due' : `${i.onTimePct}%`}. Overdue right now: ${i.overdueCommitments}.`, '',
  ];
  if (i.exceptions.length === 0) {
    lines.push('No open exceptions — every commitment that has come due has been kept.');
  } else {
    lines.push(`Open exceptions (${i.exceptions.length}):`);
    for (const e of i.exceptions.slice(0, 15)) {
      lines.push(`• ${e.role_title} (${e.priority})${e.channel !== '*' ? ` — ${e.channel}` : ''}`);
      lines.push(`    Committed: ${e.committed}`);
      lines.push(`    What happened: ${e.happened} (${e.age_days}d)`);
      const l = link(i.baseUrl, e.role_id); if (l) lines.push(`    ${l}`);
    }
    if (i.exceptions.length > 15) lines.push(`…and ${i.exceptions.length - 15} more on the dashboard.`);
  }
  if (i.provisionalSignals > 0) {
    lines.push('', `${plural(i.provisionalSignals, 'provisional signal')} (new, still being calibrated) ${i.provisionalSignals === 1 ? 'is' : 'are'} visible on the dashboard only and not listed here.`);
  }
  return { subject: `Sourcing execution — week of ${i.today}: ${i.exceptions.length === 0 ? 'on track' : plural(i.exceptions.length, 'exception')}`, text: lines.join('\n') };
}
