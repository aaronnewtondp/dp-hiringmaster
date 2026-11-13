import { describe, expect, it } from 'vitest';
import { SOURCING_CHANNELS, TRACKED_CHANNELS, normalizeSourceTag } from './sourcingConfig.js';
import { DEFAULT_DETAIL_THRESHOLDS, mapWorkbookChannel, mergeDetailThresholds, parseRowStatus, parseTrackedAs, portalsFromPlatform, roundTarget } from './sourcingDetail.js';
import { pickTemplate, SEED_TEMPLATES, suggestedChannels } from './sourcingPlanTemplates.js';

describe('the five channels and the form attribution are untouched', () => {
  it('still has exactly the five channels and the three tracked ones', () => {
    expect([...SOURCING_CHANNELS]).toEqual(['LinkedIn', 'Naukri/IIMjobs', 'Agency', 'Internal Referral', 'Direct Outreach']);
    expect([...TRACKED_CHANNELS]).toEqual(['LinkedIn', 'Naukri/IIMjobs', 'Direct Outreach']);
  });
  it('still maps the form dropdown the same way', () => {
    expect(normalizeSourceTag('Linkedin')).toBe('LinkedIn');
    expect(normalizeSourceTag('Naukri/IIMJobs')).toBe('Naukri/IIMjobs');
    expect(normalizeSourceTag('DigitalPaani HR Outreach')).toBe('Direct Outreach');
    expect(normalizeSourceTag('Hiring Agency')).toBe('Agency');
    expect(normalizeSourceTag('DigitalPaani Employee Referral')).toBe('Internal Referral');
    expect(normalizeSourceTag('Community')).toBe('Other');
    expect(normalizeSourceTag('')).toBe('untagged_default');
  });
});

describe('mapWorkbookChannel — the plan\'s wording lands on the existing channels only', () => {
  it('maps the five-channel vocabulary', () => {
    expect(mapWorkbookChannel('Outbound')).toEqual(['Direct Outreach']);
    expect(mapWorkbookChannel('Referrals')).toEqual(['Internal Referral']);
    expect(mapWorkbookChannel('Agency')).toEqual(['Agency']);
    expect(mapWorkbookChannel('Search firm')).toEqual(['Agency']);
  });
  it('splits a job-portal line by the portals its platform names', () => {
    expect(mapWorkbookChannel('Job portal', 'Naukri + LinkedIn Jobs')).toEqual(['LinkedIn', 'Naukri/IIMjobs']);
    expect(mapWorkbookChannel('Job portal', 'LinkedIn Jobs (Naukri backup)')).toEqual(['LinkedIn']);
    expect(mapWorkbookChannel('Job portal', 'Naukri (primary) + LinkedIn Jobs')).toEqual(['LinkedIn', 'Naukri/IIMjobs']);
    expect(portalsFromPlatform('Naukri without portfolio gate')).toEqual(['Naukri/IIMjobs']);
    expect(portalsFromPlatform(null)).toEqual(['LinkedIn', 'Naukri/IIMjobs']);
  });
  it('gives the supporting activities NO channel (no new channel types are invented)', () => {
    for (const l of ['Network', 'Community', 'Talent pool', 'Database search', 'Campus', 'Campus (alumni)', 'Something new']) expect(mapWorkbookChannel(l)).toEqual([]);
  });
  it('never returns anything outside the five channels', () => {
    for (const t of SEED_TEMPLATES) for (const r of t.channel_rows) for (const c of mapWorkbookChannel(r.workbook_channel, r.platform)) expect(SOURCING_CHANNELS as readonly string[]).toContain(c);
  });
});

describe('parsers', () => {
  it('reads row status and tracked-as', () => {
    expect(parseRowStatus('Live')).toBe('live'); expect(parseRowStatus('Not used')).toBe('not_used'); expect(parseRowStatus('x')).toBeNull();
    expect(parseTrackedAs('Count')).toBe('count'); expect(parseTrackedAs('Yes / No')).toBe('yes_no'); expect(parseTrackedAs('')).toBeNull();
  });
  it('rounds fractional workbook targets into the 1–500 whole-number range', () => {
    expect(roundTarget(2.5)).toBe(3); expect(roundTarget('1.89')).toBe(2); expect(roundTarget(0.2)).toBe(1); expect(roundTarget(900)).toBe(500);
    expect(roundTarget(0)).toBeNull(); expect(roundTarget(null)).toBeNull(); expect(roundTarget('abc')).toBeNull();
  });
});

describe('detail thresholds', () => {
  it('keeps today\'s values and the alerts provisional by default', () => {
    expect(DEFAULT_DETAIL_THRESHOLDS.alerts_live).toBe(false);
    expect(mergeDetailThresholds(undefined)).toEqual(DEFAULT_DETAIL_THRESHOLDS);
  });
  it('merges valid overrides and ignores unknown or wrongly typed ones', () => {
    const t = mergeDetailThresholds({ alerts_live: true, work_done_min_share: 0.8, nope: 5, channel_quiet_days: 'x', screening_backlog_hours: -3 });
    expect(t.alerts_live).toBe(true); expect(t.work_done_min_share).toBe(0.8);
    expect(t.channel_quiet_days).toBe(DEFAULT_DETAIL_THRESHOLDS.channel_quiet_days); expect(t.screening_backlog_hours).toBe(DEFAULT_DETAIL_THRESHOLDS.screening_backlog_hours);
    expect((t as unknown as Record<string, unknown>).nope).toBeUndefined();
  });
  it('mergeDetailThresholds survives arrays and prototype keys', () => {
    expect(mergeDetailThresholds([1, 2])).toEqual(DEFAULT_DETAIL_THRESHOLDS);
    expect(mergeDetailThresholds(JSON.parse('{"__proto__": {"alerts_live": true}, "constructor": 1}'))).toEqual(DEFAULT_DETAIL_THRESHOLDS);
  });
});

describe('template matching and suggestions', () => {
  const pick = (title: string, department: string | null = null) => pickTemplate({ title, department }, SEED_TEMPLATES)?.key ?? null;
  it('matches role types from the title and department', () => {
    expect(pick('Electrical & Instrumentation Engineer', 'Project Implementation')).toBe('hard_to_fill_technical');
    expect(pick('Sr. E&I Engineer (Hyderabad)', 'Project Implementation')).toBe('hard_to_fill_technical');
    expect(pick('Head of Marketing & Creative Direction')).toBe('senior_leadership');
    expect(pick('Senior UX/Product Designer', 'Product/QA')).toBe('design');
    expect(pick('Customer Success Manager – Bangalore')).toBe('customer_success');
    expect(pick('Sr. Backend Developer', 'Tech/Dev')).toBe('tech');
    expect(pick('Finance & Accounts Associate')).toBe('easy_to_fill');
  });
  it('returns null when nothing matches (the recruiter then picks one)', () => {
    expect(pick('Test Role ms7tdj7ohpf6')).toBeNull();
  });
  it('suggests only live lines, only the five channels, and only a real applicants-per-week figure as a tracker target', () => {
    const s = suggestedChannels(SEED_TEMPLATES.find(t => t.key === 'design')!.channel_rows);
    expect(s.map(x => x.channel).sort()).toEqual(['Direct Outreach', 'Internal Referral', 'LinkedIn', 'Naukri/IIMjobs']);
    // Two portals share one figure, Outbound's 10 is messages not applicants: neither becomes a weekly sourcing target.
    expect(s.every(x => x.weekly_target === null)).toBe(true);
    const single = suggestedChannels([{ workbook_channel: 'Job portal', platform: 'LinkedIn Jobs', status: 'live', expected_applicants: 18.2 }]);
    expect(single).toEqual([{ channel: 'LinkedIn', weekly_target: 18 }]);
  });
  it('each seed template is well-formed', () => {
    expect(SEED_TEMPLATES).toHaveLength(6);
    for (const t of SEED_TEMPLATES) {
      expect(t.channel_rows.some(r => r.status === 'live')).toBe(true);
      for (const r of t.channel_rows) if (r.status === 'not_used') expect(r.reason).toBeTruthy();
    }
  });
});
