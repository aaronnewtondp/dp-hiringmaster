// Commitment templates — pure, so every due date can be unit-tested.
//
// Only `activate_channel` is created at plan activation. Completing it spawns the channel's
// follow-on commitments (portal renewal / agency follow-up / referral repost), so a
// commitment never exists before its evidence path does and a recruiter who attests "already
// running" at activation gets the right next due date immediately.
import { addCalendarDays, addWorkingDays, endOfIstDay, istDate, WorkingCalendar } from './workingDays.js';
import { PORTAL_CHANNELS, SourcingSettings } from './sourcingConfig.js';

export type CommitmentKind =
  | 'activate_channel'
  | 'renew_posting'
  | 'followup_agency'
  | 'repost_referral'
  | 'weekly_outbound';

export interface CommitmentSpec {
  kind: CommitmentKind;
  subject_key: string;
  title: string;
  cadence_days: number | null;
  /** IST date the commitment falls due; it is overdue only once that day has ended. */
  due_date: string;
  meta: Record<string, unknown>;
}

export function dueAtFor(spec: Pick<CommitmentSpec, 'due_date'>): Date {
  return endOfIstDay(spec.due_date);
}

/** The single commitment created when a channel is activated on a plan. Anchored to the activation date. */
export function activationSpec(channel: string, activationDate: string, cal: WorkingCalendar): CommitmentSpec {
  if (PORTAL_CHANNELS.includes(channel)) {
    return { kind: 'activate_channel', subject_key: '', title: `Log the ${channel} post (link and weekly sourcing target)`, cadence_days: null, due_date: addWorkingDays(activationDate, 1, cal), meta: {} };
  }
  if (channel === 'Agency') {
    return { kind: 'activate_channel', subject_key: '', title: 'Select agencies and share the role brief', cadence_days: null, due_date: addWorkingDays(activationDate, 2, cal), meta: {} };
  }
  if (channel === 'Internal Referral') {
    return { kind: 'activate_channel', subject_key: '', title: 'Launch the employee referral push', cadence_days: null, due_date: addWorkingDays(activationDate, 1, cal), meta: {} };
  }
  if (channel === 'Direct Outreach') {
    return { kind: 'activate_channel', subject_key: '', title: 'Log the Direct Outreach campaign (link and weekly sourcing target)', cadence_days: null, due_date: addWorkingDays(activationDate, 2, cal), meta: {} };
  }
  return { kind: 'activate_channel', subject_key: '', title: `Activate ${channel}`, cadence_days: null, due_date: addWorkingDays(activationDate, 1, cal), meta: {} };
}

/**
 * What follows once a channel's activation commitment is done. `postedAt` is the posting's own date
 * for portals (the renewal clock starts there, not at the moment someone ticked the box).
 */
export function followOnSpecs(
  channel: string, doneAt: Date, settings: SourcingSettings, cal: WorkingCalendar, opts: { postedAt?: string | null } = {},
): CommitmentSpec[] {
  const doneDate = istDate(doneAt);
  if (PORTAL_CHANNELS.includes(channel)) {
    const live = settings.portal_expiry_days[channel] ?? 30;
    const lead = settings.renew_lead_days;
    const start = opts.postedAt && /^\d{4}-\d{2}-\d{2}$/.test(opts.postedAt) ? opts.postedAt : doneDate;
    return [{
      kind: 'renew_posting', subject_key: '', title: `Renew the ${channel} posting before it expires`,
      cadence_days: live, due_date: addCalendarDays(start, Math.max(1, live - lead)),
      meta: { lead_days: lead, expected_live_days: live },
    }];
  }
  if (channel === 'Agency') {
    return [{
      kind: 'followup_agency', subject_key: 'all', title: 'Follow up with the briefed agencies',
      cadence_days: settings.agency_followup_days, due_date: addCalendarDays(doneDate, settings.agency_followup_days), meta: { lead_days: 0 },
    }];
  }
  if (channel === 'Internal Referral') {
    return [{
      kind: 'repost_referral', subject_key: '', title: 'Repost the role to employees',
      cadence_days: settings.referral_repost_days, due_date: addCalendarDays(doneDate, settings.referral_repost_days), meta: { lead_days: 0 },
    }];
  }
  // Direct Outreach (like the portals' weekly numbers) is measured by the automatic weekly tracker — see utils/sourcingWeeks.ts —
  // so it has no follow-on task. (`weekly_outbound` remains a known kind only for rows created by the first version.)
  return [];
}

/** When a recurring commitment is completed, when is it next due? (last done + cadence − lead). */
export function nextDueDate(doneAt: Date, cadenceDays: number, leadDays: number): string {
  return addCalendarDays(istDate(doneAt), Math.max(1, cadenceDays - leadDays));
}
