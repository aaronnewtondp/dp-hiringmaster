// Sourcing plan detailing — the three health boxes and the additional alert detectors. PURE: facts in, results out (unit-tested).
// The database side that gathers the facts is services/sourcingDetailFacts.ts; the engine that reconciles what the detectors return
// is jobs/sourcingChecker.ts (additively — see collectDetailExceptions in jobs/sourcingDetailChecker.ts).
//
// Definitions (Spec "Definitions used everywhere"): Qualified = shortlisted by the recruiter, or scored above 60 (the module's own
// `qualified_rule`, reused as is). Accepted by hiring manager = qualified and moved on by the hiring manager. A new person contacted =
// the first message to that person for this role; later messages are follow-ups.
import { addCalendarDays, addWorkingDays, endOfIstDay, istDate, mondayOf, weekdayOf } from './workingDays.js';
import { PRIORITY_SEVERITY, QualifiedRule, UNTAGGED_SOURCE } from './sourcingConfig.js';
import { qualifiedAt } from './sourcingQualified.js';
import { DetailExceptionType, DetailThresholds, RowStatus, TrackedAs } from './sourcingDetail.js';

export type Colour = 'green' | 'amber' | 'red' | 'grey';

export interface AppFact {
  sub_source: string | null;
  application_date: Date;
  status: string;
  stage: string;
  screening: string | null;
  shortlisted_at: Date | null;
  scored_at: Date | null;
}
export interface RowFact {
  id: string; workbook_channel: string; mapped_channels: string[]; status: RowStatus; tracked_as: TrackedAs | null;
  weekly_work: number | null; expected_qualified: number | null; start_condition: string | null; platform: string | null;
}
export interface OutreachFact {
  people: number;                 // distinct people found (in the sheet for this role)
  contacted: number;              // distinct people contacted (first message sent)
  followups: number;
  replied: number;
  qualified: number;
  contacted_7d: number;           // NEW people first contacted in the last 7 days (rolling) — what the role page shows
  contacted_last_week: number;    // … in the last COMPLETED Monday–Sunday week — what the weekly alerts judge, so nothing fires mid-week
  stale_found: number;            // found, still not messaged, found 5+ days ago
  last_upload: string | null;     // IST date of the last upload that touched this role
  last_contact: string | null;
}
export interface CompanyFact { listed: number; touched: number; people_in_touched: number }
export interface CheckinFact { week_start: string; answers: Record<string, string>; blocker_text: string | null }

export interface DetailFacts {
  plan_id: string; role_id: string; title: string; priority: string; plan_status: string;
  activated_on: string | null;
  target: number | null;                          // effective weekly qualified target
  rows: RowFact[];
  channel_states: Record<string, string>;         // channel → planned | active | excluded | closed
  agency_followup_overdue: boolean;
  apps: AppFact[];                                // the role's recent applications (see the loader's window)
  outreach: OutreachFact;
  companies: CompanyFact;
  checkins: CheckinFact[];                        // newest first
}

const pct = (n: number, d: number) => (d > 0 ? n / d : 0);
const fmtPct = (x: number) => `${Math.round(x * 100)}%`;
const isUntagged = (s: string | null) => !s || s === UNTAGGED_SOURCE;

export function isQualified(a: AppFact, rule: QualifiedRule): boolean { return qualifiedAt(a, rule) !== null; }

/** The candidates the share-based boxes and alerts judge: those who applied since the plan went live (before that, nobody was tagged, so an
    old pile of untagged applicants would read as a "source missing" problem the plan did not cause). A draft plan judges everything. */
export function cohortOf(f: Pick<DetailFacts, 'apps' | 'activated_on'>): AppFact[] {
  const from = f.activated_on;
  return from ? f.apps.filter(a => istDate(a.application_date) >= from) : f.apps;
}
/** Active, still at Applied and Screened, nobody shortlisted it yet: waiting for the recruiter. */
export function isAwaitingScreening(a: AppFact): boolean { return a.status === 'Active' && a.stage === 'Applied and Screened' && !a.shortlisted_at; }

function qualifiedBetween(apps: AppFact[], rule: QualifiedRule, lo: Date, hi: Date, channel?: string): number {
  return apps.filter(a => {
    if (channel && a.sub_source !== channel) return false;
    const q = qualifiedAt(a, rule);
    return !!q && q > lo && q <= hi;
  }).length;
}

/** Monday–Sunday IST week windows, most recent COMPLETED first: [{start,end}] */
export function completedWeeks(today: string, n: number): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  let start = addCalendarDays(mondayOf(today), -7);
  for (let i = 0; i < n; i++) { out.push({ start, end: addCalendarDays(start, 6) }); start = addCalendarDays(start, -7); }
  return out;
}
const weekBounds = (w: { start: string; end: string }): [Date, Date] => [new Date(endOfIstDay(addCalendarDays(w.start, -1))), endOfIstDay(w.end)];

/** The Friday check-in most recently due on or before `today`. */
export function lastFridayOnOrBefore(today: string): string {
  const wd = weekdayOf(today);                    // 0 Sun … 6 Sat
  return addCalendarDays(today, -((wd + 2) % 7));
}

// ─── The three health boxes (Spec Screen 3, part 2) ─────────────────────────────────────────────────
export interface HealthBox { colour: Colour; text: string }
export interface WorkItem { label: string; kind: 'count' | 'yes_no'; done: number | null; target: number | null; ok: boolean }
export interface PlanHealth {
  enough: HealthBox & { qualified: number; target: number | null; awaiting_screening: number };
  right: HealthBox & { candidates: number; qualified: number; share: number | null };
  worked: HealthBox & { items: WorkItem[]; share: number | null };
  source: { untagged: number; total: number; share: number; untrusted: boolean };
}

/** Which check-in question speaks for which plan line. */
export function checkinKeyForRow(r: Pick<RowFact, 'workbook_channel' | 'mapped_channels'>): string | null {
  const c = r.mapped_channels;
  if (c.includes('LinkedIn') || c.includes('Naukri/IIMjobs')) return 'post_refreshed';
  if (c.includes('Internal Referral')) return 'referral_push';
  if (c.includes('Agency')) return 'agency_followup';
  return null;
}

export function workItems(f: DetailFacts): WorkItem[] {
  const items: WorkItem[] = [];
  const latest = f.checkins[0];
  for (const r of f.rows) {
    if (r.status !== 'live') continue;
    if (r.mapped_channels.includes('Direct Outreach') && r.tracked_as === 'count' && r.weekly_work) {
      items.push({ label: `${r.workbook_channel}: new people messaged`, kind: 'count', done: f.outreach.contacted_7d, target: r.weekly_work, ok: f.outreach.contacted_7d >= r.weekly_work * 0.7 });
      continue;
    }
    const key = checkinKeyForRow(r);
    if (key && latest && latest.answers[key] === 'yes') items.push({ label: r.workbook_channel, kind: 'yes_no', done: null, target: null, ok: true });
    else if (key && latest && latest.answers[key] === 'no') items.push({ label: r.workbook_channel, kind: 'yes_no', done: null, target: null, ok: false });
  }
  if (latest && latest.answers.outreach_uploaded === 'no') items.push({ label: 'Outreach sheet uploaded', kind: 'yes_no', done: null, target: null, ok: false });
  return items;
}

export function computeHealth(f: DetailFacts, now: Date, rule: QualifiedRule, t: DetailThresholds): PlanHealth {
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const qualified7 = qualifiedBetween(f.apps, rule, weekAgo, now);
  const awaiting = f.apps.filter(isAwaitingScreening).length;
  const waitingText = awaiting > 0 ? ` · ${awaiting} awaiting screening` : '';

  let enough: PlanHealth['enough'];
  if (f.target === null) enough = { colour: 'grey', text: `${qualified7} qualified this week (no target set)${waitingText}`, qualified: qualified7, target: null, awaiting_screening: awaiting };
  else {
    const share = pct(qualified7, f.target);
    const colour: Colour = share >= 1 ? 'green' : share >= t.health_enough_amber ? 'amber' : 'red';
    enough = { colour, text: `${qualified7} qualified this week (target ${f.target})${waitingText}`, qualified: qualified7, target: f.target, awaiting_screening: awaiting };
  }

  const cohort = cohortOf(f);
  const total = cohort.length;
  const q = cohort.filter(a => isQualified(a, rule)).length;
  let right: PlanHealth['right'];
  if (total < t.health_right_min) right = { colour: 'grey', text: `Too few to judge (${total} of ${t.health_right_min} candidates)`, candidates: total, qualified: q, share: null };
  else {
    const share = q / total;
    right = { colour: share >= t.health_right_green ? 'green' : share >= t.health_right_amber ? 'amber' : 'red', text: `${fmtPct(share)} qualify (${q} of ${total})`, candidates: total, qualified: q, share };
  }

  const items = workItems(f);
  let worked: PlanHealth['worked'];
  if (items.length === 0) worked = { colour: 'grey', text: 'Too few to judge: nothing measurable yet', items, share: null };
  else {
    const anyNo = items.some(i => i.kind === 'yes_no' && !i.ok);
    const parts = items.map(i => (i.kind === 'count' ? Math.min(1, pct(i.done ?? 0, i.target ?? 1)) : i.ok ? 1 : 0));
    const share = parts.reduce((s, x) => s + x, 0) / parts.length;
    const colour: Colour = anyNo ? 'red' : share >= 1 ? 'green' : share >= t.health_worked_amber ? 'amber' : 'red';
    const bad = items.filter(i => !i.ok || (i.kind === 'count' && (i.done ?? 0) < (i.target ?? 0)));
    const text = bad.length === 0 ? 'All weekly work done'
      : bad.map(i => (i.kind === 'count' ? `${i.done ?? 0} of ${i.target} ${i.label.toLowerCase()}` : `${i.label}: answered No`)).join(' · ');
    worked = { colour, text, items, share };
  }

  const untagged = cohort.filter(a => isUntagged(a.sub_source)).length;
  const share = pct(untagged, total);
  return { enough, right, worked, source: { untagged, total, share, untrusted: total >= t.source_missing_min && share > t.source_missing_share } };
}

/** One row of the Results-by-channel table for a mapped channel. A channel with fewer candidates than the floor shows "too few to judge". */
export interface ChannelResult { channel: string; candidates: number; qualified: number; share: number | null; too_few: boolean; last_activity: string | null }
export function channelResults(f: DetailFacts, rule: QualifiedRule, t: DetailThresholds, channels: string[]): ChannelResult[] {
  return channels.map(ch => {
    const apps = f.apps.filter(a => a.sub_source === ch);
    const q = apps.filter(a => isQualified(a, rule)).length;
    const last = apps.reduce<Date | null>((m, a) => (!m || a.application_date > m ? a.application_date : m), null);
    const tooFew = apps.length < t.too_few_to_judge;
    return { channel: ch, candidates: apps.length, qualified: q, share: tooFew ? null : q / apps.length, too_few: tooFew, last_activity: last ? istDate(last) : null };
  });
}

// ─── Detectors ───────────────────────────────────────────────────────────────────────────────────────
export interface DetailDetected {
  plan_id: string; channel: string; type: DetailExceptionType; subject_key: string; severity: number; is_shadow: boolean; evidence: Record<string, unknown>;
}

const daysSince = (from: string, today: string) => Math.round((new Date(`${today}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86400000);

/** A live Hiring-Manager-independent channel row's tracked channel: the first mapped channel the plan actually runs, else the plan level. */
function channelOfRow(f: DetailFacts, r: RowFact): string {
  return r.mapped_channels.find(c => f.channel_states[c] === 'active' || f.channel_states[c] === 'planned') ?? '*';
}

export function detectDetailExceptions(facts: DetailFacts[], now: Date, rule: QualifiedRule, t: DetailThresholds): DetailDetected[] {
  const today = istDate(now);
  const out: DetailDetected[] = [];
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600000);
  const weeks = completedWeeks(today, Math.max(3, t.no_results_weeks, 6));

  for (const f of facts) {
    if (f.plan_status !== 'active' || !f.activated_on) continue;               // nothing is chased on a draft, paused or closed plan
    const sev = PRIORITY_SEVERITY[f.priority] ?? 0;
    const push = (channel: string, type: DetailExceptionType, evidence: Record<string, unknown>, extra = 0) =>
      out.push({ plan_id: f.plan_id, channel, type, subject_key: '', severity: sev + extra, is_shadow: !t.alerts_live, evidence });
    const activatedDays = daysSince(f.activated_on, today);
    const lastWeek = weeks[0];
    const afterFullWeek = f.activated_on <= lastWeek.start;                                  // judged only once a whole Monday–Sunday week has run under the plan
    const live = f.rows.filter(r => r.status === 'live');

    // 1. Weekly check-in missed — due the Friday, alert after 2 working days.
    const friday = lastFridayOnOrBefore(today);
    if (f.activated_on < friday) {
      const weekStart = mondayOf(friday);
      const done = f.checkins.some(c => c.week_start === weekStart);
      const overdueAfter = endOfIstDay(addWorkingDays(friday, t.checkin_overdue_working_days));
      if (!done && now.getTime() > overdueAfter.getTime()) push('*', 'CHECKIN_OVERDUE', { week_of: weekStart, due: friday, days_late: Math.max(0, daysSince(friday, today)) });
    }

    if (afterFullWeek) {
      // 2. Not enough work done — countable work under 70% of the weekly number; yes/no work answered No.
      const latest = f.checkins[0];
      for (const r of live) {
        if (r.mapped_channels.includes('Direct Outreach') && r.tracked_as === 'count' && r.weekly_work) {
          const done = f.outreach.contacted_last_week;
          if (done < r.weekly_work * t.work_done_min_share) push('Direct Outreach', 'WORK_BELOW_TARGET', { kind: 'count', label: r.workbook_channel, done, target: r.weekly_work, week: lastWeek.start });
          continue;
        }
        const key = checkinKeyForRow(r);
        if (key && latest && latest.answers[key] === 'no') push(channelOfRow(f, r), 'WORK_BELOW_TARGET', { kind: 'yes_no', label: r.workbook_channel, week: latest.week_start });
      }
    }

    // 3. Channel gone quiet — nothing from a live channel for 7 days.
    if (activatedDays >= t.channel_quiet_days) {
      const since = hoursAgo(24 * t.channel_quiet_days);
      for (const ch of Object.keys(f.channel_states)) {
        if (f.channel_states[ch] !== 'active') continue;
        const had = f.apps.some(a => a.sub_source === ch && a.application_date > since);
        const outreachActive = ch === 'Direct Outreach' && f.outreach.contacted_7d > 0;
        if (!had && !outreachActive) push(ch, 'CHANNEL_QUIET', { days: t.channel_quiet_days });
      }
    }

    // 4. Screening backlog — waiting more than 48 hours for the recruiter.
    const cutoff = hoursAgo(t.screening_backlog_hours);
    const stuck = f.apps.filter(a => isAwaitingScreening(a) && a.application_date < cutoff);
    if (stuck.length) {
      const oldest = Math.floor((now.getTime() - Math.min(...stuck.map(a => a.application_date.getTime()))) / 3600000);
      push('*', 'SCREENING_BACKLOG', { waiting: stuck.length, oldest_hours: oldest, limit_hours: t.screening_backlog_hours });
    }

    // 5. Work done but no results — a live channel on its work target that brings under half its expected qualified, 2 weeks running.
    if (activatedDays >= 14 && afterFullWeek) {
      const span = weeks.slice(0, t.no_results_weeks);
      const lo = weekBounds(span[span.length - 1])[0]; const hi = weekBounds(span[0])[1];
      for (const r of live) {
        if (!r.expected_qualified || r.expected_qualified <= 0) continue;
        const ch = r.mapped_channels.find(c => f.channel_states[c] === 'active');
        if (!ch) continue;
        let workOnTarget = false;
        if (ch === 'Direct Outreach' && r.weekly_work) workOnTarget = f.outreach.contacted_last_week >= r.weekly_work * t.work_done_min_share;
        else { const key = checkinKeyForRow(r); workOnTarget = !!key && f.checkins.slice(0, t.no_results_weeks).length >= 1 && f.checkins.slice(0, t.no_results_weeks).every(c => c.answers[key] === 'yes'); }
        if (!workOnTarget) continue;
        const got = qualifiedBetween(f.apps, rule, lo, hi, ch);
        const expected = r.expected_qualified * t.no_results_weeks;
        if (got < expected * t.no_results_share) push(ch, 'NO_RESULTS', { weeks: t.no_results_weeks, qualified: got, expected: Math.round(expected * 100) / 100, label: r.workbook_channel });
      }
    }

    // 6. Wrong candidates — under 15% of 20+ candidates qualify.
    const cohort = cohortOf(f);
    const total = cohort.length;
    const qn = cohort.filter(a => isQualified(a, rule)).length;
    if (total >= t.wrong_candidates_min && qn / total < t.wrong_candidates_share) push('*', 'WRONG_CANDIDATES', { candidates: total, qualified: qn, share: Math.round((qn / total) * 1000) / 1000 });

    // 7. Hiring manager rejects most — accepts under half of 5+ qualified he has decided on.
    const qualifiedApps = cohort.filter(a => isQualified(a, rule));
    const accepted = qualifiedApps.filter(a => a.screening === 'HM Shortlisted' || (a.stage !== 'Applied and Screened' && a.status !== 'Rejected')).length;
    const rejected = qualifiedApps.filter(a => a.status === 'Rejected' && a.stage === 'Applied and Screened' && a.screening !== 'HM Shortlisted').length;
    const decided = accepted + rejected;
    if (decided >= t.hm_reject_min && accepted / decided < t.hm_reject_share) push('*', 'HM_REJECTS_MOST', { decided, accepted });

    // 8. Source missing — over 25% of candidates have no source.
    const untagged = cohort.filter(a => isUntagged(a.sub_source)).length;
    if (total >= t.source_missing_min && untagged / total > t.source_missing_share) push('*', 'SOURCE_MISSING', { untagged, candidates: total });

    // 9. Backup plan due — a backup line's own trigger ("Start if 3 weeks below target") is hit.
    if (f.target !== null) {
      const backups = f.rows.filter(r => r.status === 'backup' && r.start_condition && /(\d+)\s+weeks?\s+below\s+target/i.test(r.start_condition));
      const hit = backups.filter(r => {
        const n = Number(/(\d+)\s+weeks?/i.exec(r.start_condition!)![1]);
        if (!(n >= 1 && n <= 12) || activatedDays < n * 7 || f.activated_on! > weeks[Math.min(n, weeks.length) - 1].start) return false;
        return weeks.slice(0, n).every(w => { const [lo, hi] = weekBounds(w); return qualifiedBetween(f.apps, rule, lo, hi) < f.target!; });
      });
      if (hit.length) push('*', 'BACKUP_PLAN_DUE', { lines: hit.map(r => ({ label: r.workbook_channel, platform: r.platform, trigger: r.start_condition })) });
    }

    // 10–12. Company list and outreach funnel.
    if (f.companies.listed > 0 && activatedDays >= t.company_list_weeks * 7) {
      if (f.companies.touched / f.companies.listed < t.company_list_touched_share) push('*', 'COMPANY_LIST_NOT_WORKED', { listed: f.companies.listed, touched: f.companies.touched, weeks: t.company_list_weeks });
    }
    if (f.companies.touched >= 3 && f.companies.people_in_touched / f.companies.touched < t.people_per_company_min) {
      push('Direct Outreach', 'TOO_FEW_PEOPLE_FOUND', { companies: f.companies.touched, people: f.companies.people_in_touched, per_company: Math.round((f.companies.people_in_touched / f.companies.touched) * 10) / 10 });
    }
    if (f.outreach.stale_found > 0) push('Direct Outreach', 'FOUND_NOT_CONTACTED', { people: f.outreach.stale_found, days: t.found_not_contacted_days });

    // 13–14. Replies.
    if (f.outreach.contacted >= t.reply_min_messages && f.outreach.replied / f.outreach.contacted < t.reply_min_share) {
      push('Direct Outreach', 'FEW_REPLIES', { contacted: f.outreach.contacted, replied: f.outreach.replied });
    }
    if (f.outreach.replied >= t.replies_unsuitable_min && f.outreach.qualified / f.outreach.replied < t.replies_unsuitable_share) {
      push('Direct Outreach', 'REPLIES_NOT_SUITABLE', { replied: f.outreach.replied, qualified: f.outreach.qualified });
    }

    // 15. Agency sends weak profiles — briefed and chased on time, but under 20% of 5+ profiles qualify.
    if (f.channel_states['Agency'] === 'active' && !f.agency_followup_overdue) {
      const ag = f.apps.filter(a => a.sub_source === 'Agency');
      const aq = ag.filter(a => isQualified(a, rule)).length;
      if (ag.length >= t.agency_weak_min && aq / ag.length < t.agency_weak_share) push('Agency', 'AGENCY_WEAK', { profiles: ag.length, qualified: aq });
    }
  }
  return out;
}

// ─── Plain-language text for the new alert types (describeException delegates here for anything it does not know) ─────────
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function describeDetailException(type: string, channel: string, ev: Record<string, unknown>): { committed: string; happened: string; next_action: string } | null {
  const ch = channel === '*' ? 'this role' : channel;
  switch (type) {
    case 'CHECKIN_OVERDUE': return { committed: 'A weekly check-in every Friday', happened: `The check-in for the week of ${ev.week_of ?? '?'} is ${plural(num(ev.days_late) ?? 0, 'day')} late`, next_action: 'Fill the two-minute weekly check-in' };
    case 'WORK_BELOW_TARGET': return ev.kind === 'count'
      ? { committed: `${ev.label ?? 'Outreach'}: ${num(ev.target) ?? '?'} a week`, happened: `${num(ev.done) ?? 0} last week (under 70% of the weekly number)`, next_action: 'Catch up the outreach, or change the weekly number if it is wrong' }
      : { committed: `${ev.label ?? ch}: done every cycle`, happened: 'Answered No in the weekly check-in', next_action: 'Do it now, or log what is blocking it' };
    case 'CHANNEL_QUIET': return { committed: `${ch} is live and producing activity`, happened: `Nothing from ${ch} for ${plural(num(ev.days) ?? 7, 'day')}`, next_action: 'Refresh the posting or step up the push on this channel' };
    case 'SCREENING_BACKLOG': return { committed: `Candidates screened within ${num(ev.limit_hours) ?? 48} hours`, happened: `${plural(num(ev.waiting) ?? 0, 'candidate')} waiting, the oldest ${num(ev.oldest_hours) ?? 0} hours`, next_action: 'Screen them: shortlist or reject' };
    case 'NO_RESULTS': return { committed: `${ev.label ?? ch} brings about ${num(ev.expected) ?? '?'} qualified in ${num(ev.weeks) ?? 2} weeks`, happened: `${num(ev.qualified) ?? 0} qualified although the work is on target`, next_action: 'The work is being done but not landing: change the companies, titles or message' };
    case 'WRONG_CANDIDATES': return { committed: 'At least 15% of candidates qualify', happened: `${num(ev.qualified) ?? 0} of ${num(ev.candidates) ?? 0} qualify`, next_action: 'Review the job description and target titles with the hiring manager' };
    case 'HM_REJECTS_MOST': return { committed: 'The hiring manager accepts at least half of the qualified candidates', happened: `${num(ev.accepted) ?? 0} of ${num(ev.decided) ?? 0} decided were accepted`, next_action: 'Agree with the hiring manager what a good candidate looks like' };
    case 'SOURCE_MISSING': return { committed: 'Every candidate has a source', happened: `${num(ev.untagged) ?? 0} of ${num(ev.candidates) ?? 0} candidates have none, so the channel numbers cannot be trusted`, next_action: 'Make the source mandatory when adding a candidate; check the apply links' };
    case 'BACKUP_PLAN_DUE': {
      const lines = Array.isArray(ev.lines) ? (ev.lines as Array<{ label?: string }>).map(l => l.label).filter(Boolean).join(', ') : '';
      return { committed: 'The backup channels start when their trigger is hit', happened: `The trigger is hit${lines ? `: ${lines}` : ''}`, next_action: 'Start the backup channel as agreed in the plan' };
    }
    case 'COMPANY_LIST_NOT_WORKED': return { committed: 'The company list is worked', happened: `${num(ev.touched) ?? 0} of ${num(ev.listed) ?? 0} companies touched after ${num(ev.weeks) ?? 2} weeks`, next_action: 'Work through the list, or change which companies are targeted' };
    case 'TOO_FEW_PEOPLE_FOUND': return { committed: 'At least 3 people found per company worked', happened: `${num(ev.per_company) ?? 0} per company across ${num(ev.companies) ?? 0} companies`, next_action: 'Find more people at each company before moving on' };
    case 'FOUND_NOT_CONTACTED': return { committed: `People found are messaged within ${num(ev.days) ?? 5} days`, happened: `${plural(num(ev.people) ?? 0, 'person')} found but not messaged`, next_action: 'Message them, or remove them from the sheet' };
    case 'FEW_REPLIES': return { committed: 'At least 5% of messages get a reply', happened: `${num(ev.replied) ?? 0} replies from ${num(ev.contacted) ?? 0} people contacted`, next_action: 'Change the message or the target companies' };
    case 'REPLIES_NOT_SUITABLE': return { committed: 'At least 20% of replies qualify', happened: `${num(ev.qualified) ?? 0} of ${num(ev.replied) ?? 0} replies qualify`, next_action: 'The replies are the wrong people: tighten the titles and companies' };
    case 'AGENCY_WEAK': return { committed: 'At least 20% of agency profiles qualify', happened: `${num(ev.qualified) ?? 0} of ${num(ev.profiles) ?? 0} profiles qualify, although the agency is briefed and chased on time`, next_action: 'Re-brief the agency with a sharper profile, or stop it' };
    default: return null;
  }
}
