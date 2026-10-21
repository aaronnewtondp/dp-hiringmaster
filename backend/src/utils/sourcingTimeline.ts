// Plain-language rendering of one plan-history entry (sourcing_plan_changes.change), shared by the plan view and any digest, so every
// surface describes an action the same way. Pure and unit-tested. `by` = null in the row means the system did it (engine, cron, role hook).

export type TimelineCategory = 'plan' | 'task' | 'channel' | 'target' | 'exception' | 'weekly';

export interface ChangeLike { type?: string; [k: string]: unknown }

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export const EXCEPTION_LABELS: Record<string, string> = {
  PLAN_NOT_ACTIVATED: 'Plan not activated',
  CHANNEL_NOT_ACTIVATED: 'Channel set-up overdue',
  COMMITMENT_OVERDUE: 'Task overdue',
  FOLLOWUP_OVERDUE: 'Follow-up overdue',
  VOLUME_GAP: 'Too few qualified candidates',
  BLOCKER_OVERDUE: 'Blocker past its deadline',
};
const excLabel = (t: unknown) => EXCEPTION_LABELS[String(t)] ?? String(t ?? 'Exception').replace(/_/g, ' ').toLowerCase();

const withChannel = (channel: string | null, text: string) => (channel ? `${channel}: ${text}` : text);
const fmtDay = (d: string | null) => {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return d ?? '';
  return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};

export function describeChange(c: ChangeLike | null | undefined): { text: string; category: TimelineCategory } {
  const ch = c ?? {};
  const type = str(ch.type) ?? 'change';
  const channel = str(ch.channel);
  switch (type) {
    case 'activated': {
      const chans = Array.isArray(ch.channels) ? (ch.channels as Array<{ channel?: string; state?: string }>) : [];
      const used = chans.filter(x => x.state !== 'excluded').length;
      const t = num(ch.weekly_qualified_target);
      return { category: 'plan', text: `Plan activated with ${used} channel${used === 1 ? '' : 's'}${t ? ` and a target of ${t} qualified a week` : ''}` };
    }
    case 'paused': return { category: 'plan', text: 'Plan paused — the role is on hold (the weekly trackers stop until it is back)' };
    case 'resumed': return { category: 'plan', text: `Plan resumed${num(ch.paused_days) ? ` after ${num(ch.paused_days)} day${num(ch.paused_days) === 1 ? '' : 's'} on hold` : ''}` };
    case 'role_closed': return { category: 'plan', text: 'Role closed — the plan was closed and open tasks were cleared' };
    case 'role_reopened': return { category: 'plan', text: 'Role reopened — the plan is back in draft until it is activated again' };
    case 'strategy_note_changed': return { category: 'plan', text: 'Strategy note edited' };
    case 'strategy_changed': return { category: 'exception', text: `Strategy changed to resolve “${excLabel(ch.exception)}”${channel ? ` on ${channel}` : ''}${ch.excluded ? ' (channel dropped)' : ''}` };

    case 'commitment_completed': {
      const bits: string[] = [];
      if (str(ch.url)) bits.push('link logged');
      if (num(ch.weekly_target)) bits.push(`weekly target ${num(ch.weekly_target)}`);
      if (ch.already_running) bits.push('already running');
      if (ch.on_time === false) bits.push('late');
      return { category: 'task', text: withChannel(channel, `Done — ${str(ch.commitment) ?? 'task'}${bits.length ? ` (${bits.join(' · ')})` : ''}`) };
    }
    case 'commitment_skipped': return { category: 'task', text: withChannel(channel, `Skipped — ${str(ch.commitment) ?? 'task'}`) };
    case 'commitment_reopened': return { category: 'task', text: withChannel(channel, 'Skipped task brought back') };

    case 'channel_added': return { category: 'channel', text: `Channel added: ${channel ?? ''}`.trim() };
    case 'channel_excluded': return { category: 'channel', text: `Channel left out: ${channel ?? ''}`.trim() };
    case 'channels_added_on_role': return { category: 'channel', text: `Channels added from the role: ${list(ch.channels).join(', ')}` };
    case 'channels_removed_on_role': return { category: 'channel', text: `Channels removed from the role: ${list(ch.channels).join(', ')}` };
    case 'channel_closed': {
      const w = num(ch.weeks), met = num(ch.weeks_met);
      return { category: 'channel', text: withChannel(channel, `Channel closed${w ? ` after ${w} tracked week${w === 1 ? '' : 's'}${met !== null ? ` (${met} on target)` : ''}` : ''}`) };
    }
    case 'channel_reopened': return { category: 'channel', text: withChannel(channel, 'Channel reopened') };
    case 'channel_link_changed': return { category: 'channel', text: withChannel(channel, 'Post link updated') };

    case 'channel_target_changed': return { category: 'target', text: withChannel(channel, `Weekly sourcing target ${num(ch.from) ?? 'not set'} → ${num(ch.to) ?? 'not set'}`) };
    case 'qualified_target_changed': return { category: 'target', text: `Weekly qualified target ${num(ch.from) ?? 'default'} → ${num(ch.to) ?? 'default'}` };

    case 'exception_opened': return { category: 'exception', text: withChannel(channel && channel !== '*' ? channel : null, `Flagged — ${excLabel(ch.exception_type)}`) };
    case 'exception_cleared': return { category: 'exception', text: withChannel(channel && channel !== '*' ? channel : null, `Cleared automatically — ${excLabel(ch.exception_type)}`) };
    case 'exception_reopened': return { category: 'exception', text: withChannel(channel && channel !== '*' ? channel : null, `Back on the list — ${excLabel(ch.exception_type)} (catch-up date passed)`) };
    case 'exception_snoozed': return { category: 'exception', text: withChannel(channel && channel !== '*' ? channel : null, `Catching up by ${fmtDay(str(ch.until))} — ${excLabel(ch.exception_type)}`) };
    case 'exception_blocked': return { category: 'exception', text: withChannel(channel && channel !== '*' ? channel : null, `Marked blocked${str(ch.owner) ? ` (${str(ch.owner)} to unblock` : ''}${str(ch.due) ? `${str(ch.owner) ? ', ' : ' ('}by ${fmtDay(str(ch.due))})` : str(ch.owner) ? ')' : ''} — ${excLabel(ch.exception_type)}`) };

    case 'weekly_result': {
      const actual = num(ch.actual) ?? 0, target = num(ch.target) ?? 0;
      const span = `${fmtDay(str(ch.week_start))}–${fmtDay(str(ch.week_end))}`;
      // A week cut short (the channel was closed, left out, or the role put on hold or closed) is neither met nor missed.
      return { category: 'weekly', text: withChannel(channel, `Week ${span}: ${actual} of ${target} applicants — ${ch.partial ? 'week cut short, not counted as met or missed' : `target ${ch.met ? 'met' : 'missed'}`}`) };
    }
    default:
      return { category: 'plan', text: type.replace(/_/g, ' ') };
  }
}
