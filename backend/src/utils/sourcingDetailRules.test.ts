import { describe, expect, it } from 'vitest';
import { DEFAULT_DETAIL_THRESHOLDS as T } from './sourcingDetail.js';
import {
  AppFact, channelResults, completedWeeks, computeHealth, DetailFacts, describeDetailException, detectDetailExceptions, lastFridayOnOrBefore, RowFact,
} from './sourcingDetailRules.js';
import { describeException } from './sourcingDescribe.js';

// Wed 18 Nov 2026, 10:00 IST. The Friday before is 13 Nov (week of Mon 9 Nov).
const NOW = new Date('2026-11-18T04:30:00Z');
const day = (d: string) => new Date(`${d}T06:00:00Z`);
const LIVE = { ...T, alerts_live: true };

const app = (o: Partial<AppFact> = {}): AppFact => ({
  sub_source: 'LinkedIn', application_date: day('2026-11-10'), status: 'Active', stage: 'Applied and Screened', screening: 'New', shortlisted_at: null, scored_at: null, ...o,
});
const qualified = (o: Partial<AppFact> = {}) => app({ shortlisted_at: day('2026-11-16'), stage: 'Interview Round 1', ...o });
const row = (o: Partial<RowFact>): RowFact => ({
  id: '1', workbook_channel: 'Job portal', mapped_channels: ['LinkedIn'], status: 'live', tracked_as: 'yes_no', weekly_work: null, expected_qualified: null, start_condition: null, platform: null, ...o,
});
const facts = (o: Partial<DetailFacts> = {}): DetailFacts => ({
  plan_id: '10', role_id: 'R003', title: 'E&I Engineer', priority: 'P0', plan_status: 'active', activated_on: '2026-11-02', target: 3, rows: [], channel_states: { LinkedIn: 'active' },
  agency_followup_overdue: false, apps: [], checkins: [],
  outreach: { people: 0, contacted: 0, followups: 0, replied: 0, qualified: 0, contacted_7d: 0, contacted_last_week: 0, stale_found: 0, last_upload: null, last_contact: null },
  companies: { listed: 0, touched: 0, people_in_touched: 0 }, ...o,
});
const types = (f: DetailFacts[], t = LIVE) => detectDetailExceptions(f, NOW, 'either', t).map(d => `${d.channel}:${d.type}`);

describe('calendar helpers', () => {
  it('finds the Friday check-in and the completed weeks', () => {
    expect(lastFridayOnOrBefore('2026-11-18')).toBe('2026-11-13');
    expect(lastFridayOnOrBefore('2026-11-13')).toBe('2026-11-13');
    expect(lastFridayOnOrBefore('2026-11-15')).toBe('2026-11-13');
    expect(lastFridayOnOrBefore('2026-11-12')).toBe('2026-11-06');
    expect(completedWeeks('2026-11-18', 2)).toEqual([{ start: '2026-11-09', end: '2026-11-15' }, { start: '2026-11-02', end: '2026-11-08' }]);
  });
});

describe('health boxes', () => {
  it('Enough candidates: green at target, amber 50–99%, red under 50%, and always says how many await screening', () => {
    const q = (n: number) => facts({ apps: [...Array.from({ length: n }, () => qualified()), app(), app()] });
    expect(computeHealth(q(3), NOW, 'either', T).enough.colour).toBe('green');
    expect(computeHealth(q(2), NOW, 'either', T).enough.colour).toBe('amber');
    expect(computeHealth(q(1), NOW, 'either', T).enough.colour).toBe('red');
    expect(computeHealth(q(1), NOW, 'either', T).enough.text).toContain('2 awaiting screening');
    expect(computeHealth(facts({ target: null }), NOW, 'either', T).enough.colour).toBe('grey');
  });
  it('Right candidates: grey under 20 candidates, then green 20%+, amber 15–20%, red under 15%', () => {
    const mk = (total: number, q: number) => facts({ apps: [...Array.from({ length: q }, () => qualified()), ...Array.from({ length: total - q }, () => app())] });
    expect(computeHealth(mk(19, 10), NOW, 'either', T).right.colour).toBe('grey');
    expect(computeHealth(mk(20, 4), NOW, 'either', T).right.colour).toBe('green');
    expect(computeHealth(mk(100, 17), NOW, 'either', T).right.colour).toBe('amber');
    expect(computeHealth(mk(100, 10), NOW, 'either', T).right.colour).toBe('red');
  });
  it('Plan being worked: grey with nothing measurable, red on any No, otherwise by share of the weekly number', () => {
    const outbound = row({ id: '2', workbook_channel: 'Outbound', mapped_channels: ['Direct Outreach'], tracked_as: 'count', weekly_work: 40 });
    expect(computeHealth(facts(), NOW, 'either', T).worked.colour).toBe('grey');
    const f = (n: number, answers: Record<string, string> = {}) => facts({ rows: [outbound, row({})], outreach: { ...facts().outreach, contacted_7d: n }, checkins: [{ week_start: '2026-11-09', answers, blocker_text: null }] });
    expect(computeHealth(f(40, { post_refreshed: 'yes' }), NOW, 'either', T).worked.colour).toBe('green');
    expect(computeHealth(f(30, { post_refreshed: 'yes' }), NOW, 'either', T).worked.colour).toBe('amber');
    expect(computeHealth(f(14, { post_refreshed: 'yes' }), NOW, 'either', T).worked.colour).toBe('red');
    const no = computeHealth(f(40, { post_refreshed: 'no' }), NOW, 'either', T).worked;
    expect(no.colour).toBe('red'); expect(no.text).toContain('answered No');
  });
  it('flags untrustworthy channel numbers when over 25% of the cohort has no source, ignoring applicants from before the plan went live', () => {
    const old = Array.from({ length: 30 }, () => app({ sub_source: null, application_date: day('2026-10-01') }));
    const fresh = Array.from({ length: 10 }, () => app({ sub_source: 'LinkedIn' }));
    expect(computeHealth(facts({ apps: [...old, ...fresh] }), NOW, 'either', T).source.untrusted).toBe(false);
    const bad = Array.from({ length: 4 }, () => app({ sub_source: 'untagged_default' }));
    const r = computeHealth(facts({ apps: [...fresh, ...bad] }), NOW, 'either', T).source;
    expect(r.untrusted).toBe(true); expect(r.untagged).toBe(4);
  });
  it('a channel with fewer than 5 candidates is "too few to judge"', () => {
    const f = facts({ apps: [qualified(), app(), app()] });
    expect(channelResults(f, 'either', T, ['LinkedIn'])[0]).toMatchObject({ candidates: 3, qualified: 1, share: null, too_few: true });
  });
});

describe('alerts', () => {
  it('are provisional (is_shadow) until alerts_live is switched on', () => {
    const f = facts({ apps: Array.from({ length: 8 }, () => app({ application_date: day('2026-11-10') })) });
    const shadow = detectDetailExceptions([f], NOW, 'either', T);
    expect(shadow.length).toBeGreaterThan(0); expect(shadow.every(d => d.is_shadow)).toBe(true);
    expect(detectDetailExceptions([f], NOW, 'either', LIVE).every(d => !d.is_shadow)).toBe(true);
  });
  it('are never raised for a draft, paused or closed plan', () => {
    const f = facts({ apps: Array.from({ length: 8 }, () => app()) });
    for (const s of ['draft', 'paused', 'closed']) expect(types([{ ...f, plan_status: s }])).toEqual([]);
  });
  it('weekly check-in: due Friday, alert after two working days, gone once it is filed', () => {
    expect(types([facts()])).toContain('*:CHECKIN_OVERDUE');
    expect(types([facts({ checkins: [{ week_start: '2026-11-09', answers: {}, blocker_text: null }] })])).not.toContain('*:CHECKIN_OVERDUE');
    // Monday 16 Nov is only one working day after Friday: still within the grace.
    const mon = detectDetailExceptions([facts()], new Date('2026-11-16T04:30:00Z'), 'either', LIVE).map(d => d.type);
    expect(mon).not.toContain('CHECKIN_OVERDUE');
    // A plan activated after that Friday owes nothing yet.
    expect(types([facts({ activated_on: '2026-11-14' })])).not.toContain('*:CHECKIN_OVERDUE');
  });
  it('not enough work done: countable work under 70% of the weekly number; yes/no work answered No', () => {
    const outbound = row({ id: '2', workbook_channel: 'Outbound', mapped_channels: ['Direct Outreach'], tracked_as: 'count', weekly_work: 45 });
    const base = { rows: [outbound], channel_states: { 'Direct Outreach': 'active' }, checkins: [{ week_start: '2026-11-09', answers: {}, blocker_text: null }] };
    const mk = (n: number) => facts({ ...base, outreach: { ...facts().outreach, contacted_last_week: n, contacted_7d: n } });
    expect(types([mk(20)])).toContain('Direct Outreach:WORK_BELOW_TARGET');
    expect(types([mk(32)])).not.toContain('Direct Outreach:WORK_BELOW_TARGET');       // 32 ≥ 70% of 45
    const yn = facts({ rows: [row({})], checkins: [{ week_start: '2026-11-09', answers: { post_refreshed: 'no' }, blocker_text: null }] });
    expect(types([yn])).toContain('LinkedIn:WORK_BELOW_TARGET');
  });
  it('not judged before a whole week has run', () => {
    const outbound = row({ id: '2', workbook_channel: 'Outbound', mapped_channels: ['Direct Outreach'], tracked_as: 'count', weekly_work: 45 });
    const f = facts({ activated_on: '2026-11-12', rows: [outbound], channel_states: { 'Direct Outreach': 'active' } });
    expect(types([f])).not.toContain('Direct Outreach:WORK_BELOW_TARGET');
  });
  it('screening backlog: candidates waiting more than 48 hours for the recruiter', () => {
    const f = facts({ apps: [app({ application_date: day('2026-11-14') }), app({ application_date: new Date(NOW.getTime() - 3600000) })] });
    const d = detectDetailExceptions([f], NOW, 'either', LIVE).find(x => x.type === 'SCREENING_BACKLOG')!;
    expect(d.evidence.waiting).toBe(1);
    expect(types([facts({ apps: [app({ application_date: new Date(NOW.getTime() - 3600000) })] })])).not.toContain('*:SCREENING_BACKLOG');
  });
  it('source missing counts only candidates since the plan went live', () => {
    const old = Array.from({ length: 20 }, () => app({ sub_source: null, application_date: day('2026-10-05') }));
    expect(types([facts({ apps: old })])).not.toContain('*:SOURCE_MISSING');
    const fresh = [...Array.from({ length: 5 }, () => app({ sub_source: null })), ...Array.from({ length: 5 }, () => app())];
    expect(types([facts({ apps: fresh })])).toContain('*:SOURCE_MISSING');
  });
  it('wrong candidates: under 15% of 20+ qualify', () => {
    const apps = [qualified(), qualified(), ...Array.from({ length: 28 }, () => app({ stage: 'Applied and Screened', application_date: day('2026-11-17') }))];
    expect(types([facts({ apps })])).toContain('*:WRONG_CANDIDATES');
    expect(types([facts({ apps: [...Array.from({ length: 6 }, () => qualified()), ...apps.slice(2, 22)] })])).not.toContain('*:WRONG_CANDIDATES');
  });
  it('hiring manager rejects most: accepts under half of 5+ decided', () => {
    const rej = (n: number) => Array.from({ length: n }, () => qualified({ status: 'Rejected', stage: 'Applied and Screened', screening: 'New' }));
    const acc = (n: number) => Array.from({ length: n }, () => qualified({ screening: 'HM Shortlisted' }));
    expect(types([facts({ apps: [...rej(4), ...acc(1)] })])).toContain('*:HM_REJECTS_MOST');
    expect(types([facts({ apps: [...rej(2), ...acc(3)] })])).not.toContain('*:HM_REJECTS_MOST');
    expect(types([facts({ apps: [...rej(2), ...acc(1)] })])).not.toContain('*:HM_REJECTS_MOST');        // under 5 decided: too few to judge
  });
  it('channel gone quiet: nothing from a live channel for 7 days (outreach activity counts for Direct Outreach)', () => {
    const f = facts({ channel_states: { LinkedIn: 'active', 'Direct Outreach': 'active' }, apps: [app({ sub_source: 'LinkedIn', application_date: day('2026-11-17') })], outreach: { ...facts().outreach, contacted_7d: 5 } });
    expect(types([f])).not.toContain('LinkedIn:CHANNEL_QUIET'); expect(types([f])).not.toContain('Direct Outreach:CHANNEL_QUIET');
    expect(types([facts({ channel_states: { Agency: 'active' } })])).toContain('Agency:CHANNEL_QUIET');
  });
  it('backup plan due: a backup line\'s own trigger — N weeks below target', () => {
    const backup = row({ id: '9', workbook_channel: 'Agency', mapped_channels: ['Agency'], status: 'backup', start_condition: 'Start if 3 weeks below target' });
    expect(types([facts({ activated_on: '2026-10-05', rows: [backup] })])).toContain('*:BACKUP_PLAN_DUE');
    expect(types([facts({ activated_on: '2026-11-09', rows: [backup] })])).not.toContain('*:BACKUP_PLAN_DUE');          // not run for 3 weeks yet
    const hit = Array.from({ length: 3 }, () => qualified({ shortlisted_at: day('2026-11-11') }));
    expect(types([facts({ activated_on: '2026-10-05', rows: [backup], apps: hit })])).not.toContain('*:BACKUP_PLAN_DUE');   // target met in a week
  });
  it('outreach funnel alerts', () => {
    const o = (x: Partial<DetailFacts['outreach']>) => facts({ outreach: { ...facts().outreach, ...x }, companies: { listed: 20, touched: 3, people_in_touched: 5 } });
    expect(types([o({})])).toEqual(expect.arrayContaining(['*:COMPANY_LIST_NOT_WORKED', 'Direct Outreach:TOO_FEW_PEOPLE_FOUND']));
    expect(types([o({ stale_found: 4 })])).toContain('Direct Outreach:FOUND_NOT_CONTACTED');
    expect(types([o({ contacted: 60, replied: 2 })])).toContain('Direct Outreach:FEW_REPLIES');
    expect(types([o({ contacted: 40, replied: 1 })])).not.toContain('Direct Outreach:FEW_REPLIES');                    // under 50 messages: too few to judge
    expect(types([o({ replied: 12, qualified: 1 })])).toContain('Direct Outreach:REPLIES_NOT_SUITABLE');
  });
  it('agency sends weak profiles only when the agency is chased on time', () => {
    const ag = Array.from({ length: 6 }, () => app({ sub_source: 'Agency', application_date: day('2026-11-17') }));
    const f = facts({ channel_states: { Agency: 'active' }, apps: ag });
    expect(types([f])).toContain('Agency:AGENCY_WEAK');
    expect(types([{ ...f, agency_followup_overdue: true }])).not.toContain('Agency:AGENCY_WEAK');
  });
  it('severity follows the role priority; subject_key is always coarse', () => {
    const f = (p: string) => detectDetailExceptions([facts({ priority: p })], NOW, 'either', LIVE).find(d => d.type === 'CHECKIN_OVERDUE')!;
    expect(f('P0').severity).toBeGreaterThan(f('P2').severity);
    expect(f('P0').subject_key).toBe('');
  });
});

describe('plain-language text', () => {
  it('describeException delegates the new types and still handles the old default', () => {
    const d = describeException({ type: 'SCREENING_BACKLOG', channel: '*', evidence: { waiting: 6, oldest_hours: 90, limit_hours: 48 } });
    expect(d.happened).toContain('6 candidates'); expect(d.next_action).toMatch(/shortlist or reject/i);
    expect(describeException({ type: 'SOMETHING_ELSE', channel: '*', evidence: {} }).happened).toBe('Needs attention');
  });
  it('has text for every new alert type', () => {
    for (const t of ['CHECKIN_OVERDUE', 'WORK_BELOW_TARGET', 'CHANNEL_QUIET', 'SCREENING_BACKLOG', 'NO_RESULTS', 'WRONG_CANDIDATES', 'HM_REJECTS_MOST', 'SOURCE_MISSING', 'BACKUP_PLAN_DUE',
      'COMPANY_LIST_NOT_WORKED', 'TOO_FEW_PEOPLE_FOUND', 'FOUND_NOT_CONTACTED', 'FEW_REPLIES', 'REPLIES_NOT_SUITABLE', 'AGENCY_WEAK']) {
      const d = describeDetailException(t, 'LinkedIn', {});
      expect(d, t).not.toBeNull(); expect(d!.next_action.length).toBeGreaterThan(5);
    }
  });
});
