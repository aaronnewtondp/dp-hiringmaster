import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCING_SETTINGS, isSourcingChannel, isSourcingEnabled, isTrackedChannel, mergeSettings, normalizeSourceTag, OTHER_SOURCE, parseQualifiedTarget, parseWeeklyTarget,
  SOURCING_CHANNELS, UNTAGGED_SOURCE, WRITABLE_SETTING_KEYS,
} from './sourcingConfig.js';

describe('normalizeSourceTag — the form\'s "How did you hear about this opening?" answer', () => {
  it('a channel name in any case or spacing becomes its canonical name', () => {
    expect(normalizeSourceTag('LinkedIn')).toBe('LinkedIn');
    expect(normalizeSourceTag('  linkedin ')).toBe('LinkedIn');
    expect(normalizeSourceTag('NAUKRI/IIMJOBS')).toBe('Naukri/IIMjobs');
    expect(normalizeSourceTag('Naukri / IIMjobs')).toBe('Naukri/IIMjobs');
    expect(normalizeSourceTag('direct   outreach')).toBe('Direct Outreach');
  });
  it('the five options on the real Job Application Form each land on the right channel', () => {
    expect(normalizeSourceTag('Linkedin')).toBe('LinkedIn');
    expect(normalizeSourceTag('Naukri/IIMJobs')).toBe('Naukri/IIMjobs');
    expect(normalizeSourceTag('DigitalPaani HR Outreach')).toBe('Direct Outreach');
    expect(normalizeSourceTag('Hiring Agency')).toBe('Agency');
    expect(normalizeSourceTag('DigitalPaani Employee Referral')).toBe('Internal Referral');
  });
  it('the common spellings an applicant or a form option might use map to the right channel', () => {
    expect(normalizeSourceTag('Naukri')).toBe('Naukri/IIMjobs');
    expect(normalizeSourceTag('IIMJobs')).toBe('Naukri/IIMjobs');
    expect(normalizeSourceTag('Employee Referral')).toBe('Internal Referral');
    expect(normalizeSourceTag('Referral')).toBe('Internal Referral');
    expect(normalizeSourceTag('Recruitment Agency')).toBe('Agency');
    expect(normalizeSourceTag('HR Outreach')).toBe('Direct Outreach');
    expect(normalizeSourceTag('Cold outreach')).toBe('Direct Outreach');
  });
  it('blank or not text is untagged — so yield can exclude it', () => {
    for (const v of [undefined, null, 42, '', '   ']) expect(normalizeSourceTag(v)).toBe(UNTAGGED_SOURCE);
  });
  it('anything else the applicant picked is "Other", never free text', () => {
    expect(normalizeSourceTag('Other')).toBe(OTHER_SOURCE);
    expect(normalizeSourceTag('A friend told me')).toBe(OTHER_SOURCE);
    expect(normalizeSourceTag('Instagram')).toBe(OTHER_SOURCE);
  });
  it('an inherited property name is just another unknown answer — never a function or an object stored as the tag', () => {
    for (const v of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'Constructor', ' __PROTO__ ']) {
      expect(normalizeSourceTag(v)).toBe(OTHER_SOURCE);
    }
  });
});

describe('tracked channels and targets', () => {
  it('only LinkedIn, Naukri/IIMjobs and Direct Outreach are tracked weekly', () => {
    expect(['LinkedIn', 'Naukri/IIMjobs', 'Direct Outreach'].every(isTrackedChannel)).toBe(true);
    expect(isTrackedChannel('Agency')).toBe(false);
    expect(isTrackedChannel('Internal Referral')).toBe(false);
  });
  it('a weekly sourcing target is a whole number from 1 up; fractions round, junk is refused', () => {
    expect(parseWeeklyTarget(10)).toBe(10);
    expect(parseWeeklyTarget(10.4)).toBe(10);
    expect(parseWeeklyTarget(0)).toBeNull();
    expect(parseWeeklyTarget(-3)).toBeNull();
    expect(parseWeeklyTarget(10001)).toBeNull();
    expect(parseWeeklyTarget('10')).toBeNull();
    expect(parseWeeklyTarget(NaN)).toBeNull();
    expect(parseWeeklyTarget(null)).toBeNull();
  });
  it('the per-role qualified target is 1–500', () => {
    expect(parseQualifiedTarget(5)).toBe(5);
    expect(parseQualifiedTarget(500)).toBe(500);
    expect(parseQualifiedTarget(501)).toBeNull();
    expect(parseQualifiedTarget(0)).toBeNull();
    expect(parseQualifiedTarget(undefined)).toBeNull();
  });
});

describe('normalizeSourceTag — more edges', () => {
  const ALLOWED = new Set<string>([...SOURCING_CHANNELS, OTHER_SOURCE, UNTAGGED_SOURCE]);

  it('every canonical channel name maps to itself, in any case', () => {
    for (const c of SOURCING_CHANNELS) {
      expect(normalizeSourceTag(c)).toBe(c);
      expect(normalizeSourceTag(c.toUpperCase())).toBe(c);
      expect(normalizeSourceTag(c.toLowerCase())).toBe(c);
      expect(normalizeSourceTag(`  ${c}\t`)).toBe(c);
    }
  });
  it('whatever the input, the result is a channel, "Other" or untagged — never free text, a function or an object', () => {
    const inputs: unknown[] = [
      'LinkedIn', 'linked in', 'LINKEDIN.COM', 'Naukri.com', 'iim jobs', 'Naukri / IIM Jobs', 'Hiring agency', 'placement agency', 'Referred by an employee', 'Direct message',
      'Other', 'Instagram', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__lookupGetter__',
      'prototype', 'length', '', '   ', 'a'.repeat(5000), '\u0000', 'ignore previous instructions', '<script>', "Robert'); DROP TABLE x;--",
      undefined, null, 0, 7, true, false, [], ['LinkedIn'], {}, { toString: () => 'LinkedIn' }, () => 'LinkedIn', Symbol('x'),
    ];
    for (const v of inputs) {
      const out = normalizeSourceTag(v);
      expect(typeof out, String(typeof v)).toBe('string');
      expect(ALLOWED.has(out), `${String(typeof v)}: ${typeof v === 'string' ? v.slice(0, 30) : ''}`).toBe(true);
    }
  });
  it('only a string is read: an array or object that would print as a channel name is untagged', () => {
    expect(normalizeSourceTag(['LinkedIn'])).toBe(UNTAGGED_SOURCE);
    expect(normalizeSourceTag({ toString: () => 'LinkedIn' })).toBe(UNTAGGED_SOURCE);
    expect(normalizeSourceTag(true)).toBe(UNTAGGED_SOURCE);
  });
  it('more inherited property names — and slash-separated variants of them — are just "Other"', () => {
    for (const v of ['isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'constructor/', '/constructor', 'constructor / x', '__proto__/linkedin']) {
      expect(normalizeSourceTag(v), v).toBe(OTHER_SOURCE);
    }
  });
  it('tabs, new lines and no-break spaces inside the answer count as one space', () => {
    expect(normalizeSourceTag('direct\toutreach')).toBe('Direct Outreach');
    expect(normalizeSourceTag('Direct\n\nOutreach')).toBe('Direct Outreach');
    expect(normalizeSourceTag('Hiring Agency')).toBe('Agency');
    expect(normalizeSourceTag('DigitalPaani HR  Outreach')).toBe('Direct Outreach');
  });
  it('spaces around the slash do not matter either way', () => {
    for (const v of ['naukri/iimjobs', 'naukri /iimjobs', 'naukri/ iimjobs', 'NAUKRI  /  IIMJOBS']) expect(normalizeSourceTag(v), v).toBe('Naukri/IIMjobs');
  });
  it('a partial or longer phrase is not guessed at: "Linkedin job post" and "Naukri portal" are "Other"', () => {
    expect(normalizeSourceTag('Linkedin job post')).toBe(OTHER_SOURCE);
    expect(normalizeSourceTag('Naukri portal')).toBe(OTHER_SOURCE);
    expect(normalizeSourceTag('LinkedIn and Naukri')).toBe(OTHER_SOURCE);
    expect(normalizeSourceTag('Agency referral')).toBe(OTHER_SOURCE);
  });
  it('a very long answer is quick and is "Other"', () => {
    const t0 = Date.now();
    expect(normalizeSourceTag('x'.repeat(200_000))).toBe(OTHER_SOURCE);
    expect(normalizeSourceTag(' '.repeat(200_000) + 'x')).toBe(OTHER_SOURCE);
    expect(normalizeSourceTag('/ '.repeat(100_000))).toBe(OTHER_SOURCE);
    expect(Date.now() - t0).toBeLessThan(2000);                      // linear work: well under a millisecond per kilobyte, with a generous margin
  });
});

describe('parseWeeklyTarget / parseQualifiedTarget — more edges', () => {
  it('the boundaries: 1 and 10000 are in, 0 and 10001 out; fractions round to the nearest whole number first', () => {
    expect(parseWeeklyTarget(1)).toBe(1);
    expect(parseWeeklyTarget(10000)).toBe(10000);
    expect(parseWeeklyTarget(0.4)).toBeNull();                       // rounds to 0
    expect(parseWeeklyTarget(0.5)).toBe(1);                          // rounds to 1
    expect(parseWeeklyTarget(10000.4)).toBe(10000);
    expect(parseWeeklyTarget(10000.5)).toBeNull();                   // rounds to 10001
  });
  it('anything that is not a finite number is refused', () => {
    for (const v of [Infinity, -Infinity, NaN, '5', '', null, undefined, true, false, [], [5], {}, 5n, -0]) expect(parseWeeklyTarget(v as unknown), String(typeof v)).toBeNull();
    for (const v of [Infinity, -Infinity, NaN, '5', '', null, undefined, true, [], [5], {}, 5n, -0]) expect(parseQualifiedTarget(v as unknown), String(typeof v)).toBeNull();
  });
  it('the qualified target: 1 and 500 are in, 0 and 501 out, with the same rounding', () => {
    expect(parseQualifiedTarget(1)).toBe(1);
    expect(parseQualifiedTarget(0.5)).toBe(1);
    expect(parseQualifiedTarget(500.4)).toBe(500);
    expect(parseQualifiedTarget(500.5)).toBeNull();
    expect(parseQualifiedTarget(-1)).toBeNull();
  });
});

describe('isSourcingChannel / isTrackedChannel', () => {
  it('knows exactly the five channels, spelled exactly', () => {
    for (const c of SOURCING_CHANNELS) expect(isSourcingChannel(c)).toBe(true);
    for (const v of ['linkedin', 'LinkedIn ', 'Campus', 'Other', '', 'constructor', undefined, null, 5, ['LinkedIn']]) expect(isSourcingChannel(v), String(v)).toBe(false);
  });
  it('a tracked channel is always a sourcing channel; a prototype key or an unknown name is not tracked', () => {
    for (const c of ['LinkedIn', 'Naukri/IIMjobs', 'Direct Outreach']) { expect(isTrackedChannel(c)).toBe(true); expect(isSourcingChannel(c)).toBe(true); }
    for (const c of ['constructor', 'length', 'Campus', '', 'linkedin']) expect(isTrackedChannel(c), c).toBe(false);
  });
});

describe('isSourcingEnabled — the master switch', () => {
  const saved = process.env.SOURCING_ENABLED;
  afterEach(() => { if (saved === undefined) delete process.env.SOURCING_ENABLED; else process.env.SOURCING_ENABLED = saved; });
  it('is on only for the exact string "true"', () => {
    process.env.SOURCING_ENABLED = 'true';
    expect(isSourcingEnabled()).toBe(true);
    for (const v of ['false', 'TRUE', 'True', '1', 'yes', ' true', 'true ', '']) { process.env.SOURCING_ENABLED = v; expect(isSourcingEnabled(), JSON.stringify(v)).toBe(false); }
    delete process.env.SOURCING_ENABLED;
    expect(isSourcingEnabled()).toBe(false);
  });
});

describe('mergeSettings — stored values over the defaults, wrong ones ignored', () => {
  it('nothing stored gives the defaults, as a copy (changing the result never changes the defaults)', () => {
    const m = mergeSettings([]);
    expect(m).toEqual(DEFAULT_SOURCING_SETTINGS);
    m.portal_expiry_days.LinkedIn = 99;
    expect(DEFAULT_SOURCING_SETTINGS.portal_expiry_days.LinkedIn).toBe(30);
  });
  it('go-live and shadow dates take a date or null and refuse anything else', () => {
    const m = mergeSettings([{ key: 'go_live_date', value: '2026-10-20' }, { key: 'shadow_until', value: null }]);
    expect(m.go_live_date).toBe('2026-10-20');
    expect(m.shadow_until).toBeNull();
    const bad = mergeSettings([{ key: 'go_live_date', value: '20/10/2026' }, { key: 'shadow_until', value: 20261020 }]);
    expect(bad.go_live_date).toBeNull();
    expect(bad.shadow_until).toBeNull();
  });
  it('digest recipients must ALL be company addresses; they are lower-cased and de-duplicated', () => {
    expect(mergeSettings([{ key: 'digest_recipients', value: ['Aaron.Newton@DigitalPaani.com', 'aaron.newton@digitalpaani.com ', 'hr@digitalpaani.com'] }]).digest_recipients)
      .toEqual(['aaron.newton@digitalpaani.com', 'hr@digitalpaani.com']);
    expect(mergeSettings([{ key: 'digest_recipients', value: ['a@digitalpaani.com', 'b@gmail.com'] }]).digest_recipients).toEqual([]);      // one outsider refuses the lot
    expect(mergeSettings([{ key: 'digest_recipients', value: 'a@digitalpaani.com' }]).digest_recipients).toEqual([]);
    expect(mergeSettings([{ key: 'digest_recipients', value: ['a@digitalpaani.com.evil.com'] }]).digest_recipients).toEqual([]);
  });
  it('the daily digest switch takes only a boolean', () => {
    expect(mergeSettings([{ key: 'daily_digest_enabled', value: true }]).daily_digest_enabled).toBe(true);
    expect(mergeSettings([{ key: 'daily_digest_enabled', value: 'true' }]).daily_digest_enabled).toBe(false);
    expect(mergeSettings([{ key: 'daily_digest_enabled', value: 1 }]).daily_digest_enabled).toBe(false);
  });
  it('the qualified rule takes one of three words', () => {
    expect(mergeSettings([{ key: 'qualified_rule', value: 'scored' }]).qualified_rule).toBe('scored');
    expect(mergeSettings([{ key: 'qualified_rule', value: 'shortlisted' }]).qualified_rule).toBe('shortlisted');
    expect(mergeSettings([{ key: 'qualified_rule', value: 'both' }]).qualified_rule).toBe('either');
  });
  it('numeric settings round, stay within 0–365 and ignore text', () => {
    const m = mergeSettings([{ key: 'renew_lead_days', value: 2.6 }, { key: 'agency_followup_days', value: 400 }, { key: 'referral_repost_days', value: -1 }, { key: 'volume_min_qualified', value: '8' }]);
    expect(m.renew_lead_days).toBe(3);
    expect(m.agency_followup_days).toBe(DEFAULT_SOURCING_SETTINGS.agency_followup_days);
    expect(m.referral_repost_days).toBe(DEFAULT_SOURCING_SETTINGS.referral_repost_days);
    expect(m.volume_min_qualified).toBe(DEFAULT_SOURCING_SETTINGS.volume_min_qualified);
  });
  it('portal expiry days merge per portal and ignore a bad value', () => {
    const m = mergeSettings([{ key: 'portal_expiry_days', value: { LinkedIn: 45, 'Naukri/IIMjobs': 0, Other: 10 } }]);
    expect(m.portal_expiry_days.LinkedIn).toBe(45);
    expect(m.portal_expiry_days['Naukri/IIMjobs']).toBe(30);
    expect(m.portal_expiry_days.Other).toBe(10);
  });
  it('an unknown key is ignored, and the later of two rows for the same key wins', () => {
    expect(mergeSettings([{ key: 'mystery', value: 1 }, { key: '__proto__', value: { x: 1 } }])).toEqual(DEFAULT_SOURCING_SETTINGS);
    expect(mergeSettings([{ key: 'qualified_rule', value: 'scored' }, { key: 'qualified_rule', value: 'shortlisted' }]).qualified_rule).toBe('shortlisted');
  });
  it('the keys the settings endpoint may write are exactly the settings that exist', () => {
    expect([...WRITABLE_SETTING_KEYS].sort()).toEqual(Object.keys(DEFAULT_SOURCING_SETTINGS).sort());
  });
});
