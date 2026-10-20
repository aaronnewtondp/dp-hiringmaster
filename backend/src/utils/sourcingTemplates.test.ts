import { describe, it, expect } from 'vitest';
import { activationSpec, followOnSpecs, nextDueDate, dueAtFor } from './sourcingTemplates.js';
import { DEFAULT_SOURCING_SETTINGS, mergeSettings } from './sourcingConfig.js';

const S = DEFAULT_SOURCING_SETTINGS;

describe('activationSpec — anchored to the activation date, in working days', () => {
  it('portal: due 1 working day after activation', () => {
    // 2026-10-14 is a Wednesday
    expect(activationSpec('LinkedIn', '2026-10-14', {}).due_date).toBe('2026-10-15');
    expect(activationSpec('Naukri/IIMjobs', '2026-10-16', {}).due_date).toBe('2026-10-19'); // Fri -> Mon
  });
  it('agency and outbound: 2 working days; referral: 1', () => {
    expect(activationSpec('Agency', '2026-10-14', {}).due_date).toBe('2026-10-16');
    expect(activationSpec('Direct Outreach', '2026-10-14', {}).due_date).toBe('2026-10-16');
    expect(activationSpec('Internal Referral', '2026-10-14', {}).due_date).toBe('2026-10-15');
  });
  it('counts Monday–Friday only (a Friday approval is due the following Monday)', () => {
    expect(activationSpec('LinkedIn', '2026-10-16', {}).due_date).toBe('2026-10-19');
  });
  it('is always kind activate_channel and one-time', () => {
    for (const ch of ['LinkedIn', 'Agency', 'Internal Referral', 'Direct Outreach']) {
      const s = activationSpec(ch, '2026-10-14', {});
      expect(s.kind).toBe('activate_channel');
      expect(s.cadence_days).toBeNull();
    }
  });
});

describe('followOnSpecs', () => {
  const done = new Date('2026-10-14T06:00:00Z'); // 11:30 IST on the 14th
  it('portal: renewal due (live days − lead) after the posting date, rolling', () => {
    const [s] = followOnSpecs('LinkedIn', done, S, {});
    expect(s.kind).toBe('renew_posting');
    expect(s.cadence_days).toBe(30);
    expect(s.due_date).toBe('2026-11-10'); // 14 Oct + 27 days
    expect(s.meta.lead_days).toBe(3);
  });
  it('portal: the clock starts at the supplied posting date, not the moment it was ticked', () => {
    const [s] = followOnSpecs('Naukri/IIMjobs', done, S, {}, { postedAt: '2026-10-01' });
    expect(s.due_date).toBe('2026-10-28'); // 1 Oct + 27
  });
  it('ignores a malformed posting date', () => {
    const [s] = followOnSpecs('LinkedIn', done, S, {}, { postedAt: 'yesterday' });
    expect(s.due_date).toBe('2026-11-10');
  });
  it('uses configured expiry', () => {
    const custom = mergeSettings([{ key: 'portal_expiry_days', value: { LinkedIn: 14 } }]);
    const [s] = followOnSpecs('LinkedIn', done, custom, {});
    expect(s.cadence_days).toBe(14);
    expect(s.due_date).toBe('2026-10-25'); // 14 Oct + 11
  });
  it('agency: weekly follow-up, referral: repost, outbound: weekly with a baseline window', () => {
    expect(followOnSpecs('Agency', done, S, {})[0]).toMatchObject({ kind: 'followup_agency', cadence_days: 7, due_date: '2026-10-21', subject_key: 'all' });
    expect(followOnSpecs('Internal Referral', done, S, {})[0]).toMatchObject({ kind: 'repost_referral', cadence_days: 14, due_date: '2026-10-28' });
    const out = followOnSpecs('Direct Outreach', done, S, {})[0];
    expect(out).toMatchObject({ kind: 'weekly_outbound', cadence_days: 7, due_date: '2026-10-21' });
    expect(out.meta.baseline_until).toBe('2026-11-11'); // 4 weeks
  });
  it('an unknown channel has no follow-ons', () => {
    expect(followOnSpecs('Campus', done, S, {})).toEqual([]);
  });
});

describe('nextDueDate / dueAtFor', () => {
  it('rolls due = last done + cadence − lead (min 1 day)', () => {
    const done = new Date('2026-10-14T06:00:00Z');
    expect(nextDueDate(done, 30, 3)).toBe('2026-11-10');
    expect(nextDueDate(done, 7, 0)).toBe('2026-10-21');
    expect(nextDueDate(done, 2, 5)).toBe('2026-10-15');
  });
  it('a commitment is overdue only after its due DAY has ended (IST)', () => {
    expect(dueAtFor({ due_date: '2026-10-15' }).toISOString()).toBe('2026-10-15T18:29:59.999Z');
  });
});

describe('mergeSettings', () => {
  it('keeps defaults, applies valid overrides and ignores junk', () => {
    const s = mergeSettings([
      { key: 'go_live_date', value: '2026-10-20' },
      { key: 'qualified_rule', value: 'shortlisted' },
      { key: 'holidays', value: ['2026-10-20'] },       // a retired setting: ignored like any unknown key
      { key: 'weekly_baseline_weeks', value: 'lots' },
      { key: 'nonsense', value: 1 },
      { key: 'referral_audience_email', value: 'not-an-email' },
    ]);
    expect(s.go_live_date).toBe('2026-10-20');
    expect(s.qualified_rule).toBe('shortlisted');
    expect(s).not.toHaveProperty('holidays');
    expect(s.weekly_baseline_weeks).toBe(4);
    expect(s.referral_audience_email).toBeNull();
  });
  it('does not mutate the shared defaults', () => {
    mergeSettings([{ key: 'portal_expiry_days', value: { LinkedIn: 99 } }]);
    expect(DEFAULT_SOURCING_SETTINGS.portal_expiry_days.LinkedIn).toBe(30);
  });
});

import { normalizeSourceTag, UNTAGGED_SOURCE, OTHER_SOURCE } from './sourcingConfig.js';
describe('normalizeSourceTag', () => {
  it('maps known channels case/space-insensitively to canonical spelling', () => {
    expect(normalizeSourceTag('linkedin')).toBe('LinkedIn');
    expect(normalizeSourceTag('  naukri/iimjobs ')).toBe('Naukri/IIMjobs');
    expect(normalizeSourceTag('Internal   Referral')).toBe('Internal Referral');
  });
  it('blank or missing → untagged_default; non-strings too', () => {
    for (const v of [undefined, null, '', '   ', 5, {}, []]) expect(normalizeSourceTag(v)).toBe(UNTAGGED_SOURCE);
  });
  it('anything else the applicant picked → Other (never free text)', () => {
    expect(normalizeSourceTag('Facebook')).toBe(OTHER_SOURCE);
    expect(normalizeSourceTag('<script>alert(1)</script>')).toBe(OTHER_SOURCE);
  });
});
