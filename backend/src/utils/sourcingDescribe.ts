// Plain-language "what was committed / what actually happened / what to do next" for an exception row.
// Shared by the dashboard table, the My Tasks queue and the email digests so they always say the same thing.
// Inputs are the objective `evidence` the engine stored (counts and titles only — never prospect data).

export interface ExceptionLike {
  type: string;
  channel: string;
  evidence: Record<string, unknown> | null;
}

export interface ExceptionDescription {
  committed: string;
  happened: string;
  next_action: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** What "activating" a channel means in practice — it differs by channel, so the next action must too. */
function activationAction(channel: string): string {
  switch (channel) {
    case 'Agency': return 'Choose the agencies, send the role brief and mark it done';
    case 'Internal Referral': return 'Launch the referral push and mark it done';
    case 'Direct Outreach': return 'Set up the outreach list and weekly target, then mark it done';
    default: return `Publish on ${channel} and mark it done`;
  }
}

interface OverdueItem { kind?: string; title?: string; due?: string; days_overdue?: number }

export function describeException(e: ExceptionLike): ExceptionDescription {
  const ev = e.evidence ?? {};
  const channel = e.channel === '*' ? 'this role' : e.channel;

  switch (e.type) {
    case 'PLAN_NOT_ACTIVATED': {
      const days = num(ev.days_overdue) ?? 0;
      return {
        committed: 'Sourcing plan activated within 1 working day of approval',
        happened: `Still a draft — ${plural(days, 'day')} late${str(ev.approved_on) ? ` (approved ${ev.approved_on})` : ''}`,
        next_action: 'Pick the channels and activate the plan',
      };
    }
    case 'CHANNEL_NOT_ACTIVATED':
    case 'COMMITMENT_OVERDUE':
    case 'FOLLOWUP_OVERDUE': {
      const items = Array.isArray(ev.overdue) ? ev.overdue as OverdueItem[] : [];
      const first = items[0];
      const count = num(ev.count) ?? items.length;
      const worst = items.reduce((m, i) => Math.max(m, num(i.days_overdue) ?? 0), 0);
      const title = str(first?.title) ?? 'Commitment';
      return {
        committed: `${channel}: ${title}${count > 1 ? ` (+${count - 1} more)` : ''}`,
        happened: `Not done — ${plural(worst, 'day')} overdue${str(first?.due) ? ` (was due ${first!.due})` : ''}`,
        next_action: e.type === 'CHANNEL_NOT_ACTIVATED' ? activationAction(e.channel)
          : e.type === 'FOLLOWUP_OVERDUE' ? 'Send the follow-up and mark it done'
          : 'Do it and mark it done — or choose a resolution',
      };
    }
    case 'VOLUME_GAP': {
      const min = num(ev.min) ?? 5, got = num(ev.weekly_qualified) ?? 0;
      const sl = num(ev.shortlisted), sc = num(ev.scored);
      const split = sl !== null && sc !== null ? ` (${sl} shortlisted · ${sc} scored above 60)` : '';
      return {
        committed: `At least ${min} qualified candidates a week`,
        happened: `${got} in the last ${num(ev.window_days) ?? 7} days${split}, short on each of the last working days`,
        next_action: 'Widen sourcing and bring in the Hiring Manager',
      };
    }
    case 'BLOCKER_OVERDUE': {
      const days = num(ev.days_overdue) ?? 0;
      return {
        committed: 'Blocker cleared by its deadline',
        happened: `${plural(days, 'day')} past the deadline${str(ev.blocker_due) ? ` (${ev.blocker_due})` : ''}`,
        next_action: 'Unblock it, or re-plan the channel',
      };
    }
    default:
      return { committed: e.type, happened: 'Needs attention', next_action: 'Review' };
  }
}

/** Whole IST-agnostic days between an ISO timestamp and `now` (floor, never negative) — for the "age" column. */
export function ageDays(detectedAt: Date | string, now: Date = new Date()): number {
  const t = detectedAt instanceof Date ? detectedAt.getTime() : new Date(detectedAt).getTime();
  return Math.max(0, Math.floor((now.getTime() - t) / 86400000));
}
