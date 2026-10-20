// Display helpers for the Sourcing module — labels and small formatting rules shared by the role card, My Tasks box and
// dashboard section so they always say the same thing.
import { ExceptionType, PORTAL_CHANNELS } from '../types/sourcing.ts';

export const EXCEPTION_LABELS: Record<ExceptionType, string> = {
  PLAN_NOT_ACTIVATED:    'Plan not activated',
  CHANNEL_NOT_ACTIVATED: 'Channel not live',
  COMMITMENT_OVERDUE:    'Commitment overdue',
  FOLLOWUP_OVERDUE:      'Follow-up overdue',
  VOLUME_GAP:            'Not enough qualified candidates',
  BLOCKER_OVERDUE:       'Blocker overdue',
};
export const exceptionLabel = (t: string): string => EXCEPTION_LABELS[t as ExceptionType] ?? t;

/** One line on what "activating" this channel means in practice (shown on the activation screen). */
export function channelBlurb(channel: string): string {
  switch (channel) {
    case 'LinkedIn':          return 'Publish the job posting and note the date — HMS reminds you before it expires.';
    case 'Naukri/IIMjobs':    return 'Publish the job posting and note the date — HMS reminds you before it expires.';
    case 'Agency':            return 'Choose the agencies and send them the role brief; HMS tracks follow-ups.';
    case 'Internal Referral': return 'Launch the referral push to the team and repost it every couple of weeks.';
    case 'Direct Outreach':   return 'Work a target-company list weekly. The first 4 weeks only record your baseline.';
    default:                  return '';
  }
}

export const isPortal = (channel: string): boolean => PORTAL_CHANNELS.includes(channel);

/** "Due today" / "Due tomorrow" / "Due 12 Oct" / "3 days overdue" — from an IST 'YYYY-MM-DD' date and today's. */
export function dueLabel(dueDate: string, today: string): string {
  const d = Date.parse(`${dueDate}T12:00:00Z`), t = Date.parse(`${today}T12:00:00Z`);
  if (Number.isNaN(d) || Number.isNaN(t)) return dueDate;
  const days = Math.round((d - t) / 86400000);
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days === -1) return '1 day overdue';
  if (days < 0) return `${-days} days overdue`;
  return `Due ${new Date(`${dueDate}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
}

/** Local-calendar 'YYYY-MM-DD' (the user's own "today"), offset by `days`. */
export function ymd(offsetDays = 0, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offsetDays);
  const mm = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** First N of a list plus how many were left out — for "top 5 + N more". */
export function topN<T>(items: T[], n: number): { shown: T[]; more: number } {
  return { shown: items.slice(0, n), more: Math.max(0, items.length - n) };
}
