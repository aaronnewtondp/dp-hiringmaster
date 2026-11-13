import { describe, expect, it } from 'vitest';
import {
  companyKey, isQualifiedOutcome, isReplied, mapOutreachHeader, mergeCompanyRows, mergePerson, needsRecheck, parseCompanyRows, parseCsv, parseSheetDate, profileKey, validateOutreachRows,
} from './sourcingOutreach.js';

const HEADER = 'Role ID,Company,Job Title,Profile link,Date contacted,Status,Next follow-up,Outcome';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, CRLF, BOM and blank lines', () => {
    const t = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n1,2');
    expect(t).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['1', '2']]);
  });
  it('never throws on an unclosed quote', () => { expect(() => parseCsv('a,"b\nc')).not.toThrow(); });
});

describe('parseSheetDate', () => {
  it('reads ISO, day-first and named-month dates', () => {
    expect(parseSheetDate('2026-11-09')).toBe('2026-11-09');
    expect(parseSheetDate('09/11/2026')).toBe('2026-11-09');
    expect(parseSheetDate('9-11-26')).toBe('2026-11-09');
    expect(parseSheetDate('9 Nov 2026')).toBe('2026-11-09');
    expect(parseSheetDate('Nov 9, 2026')).toBe('2026-11-09');
  });
  it('rejects impossible and unreadable dates', () => {
    expect(parseSheetDate('31/02/2026')).toBeNull(); expect(parseSheetDate('2026-13-01')).toBeNull(); expect(parseSheetDate('soon')).toBeNull(); expect(parseSheetDate('')).toBeNull();
  });
});

describe('profileKey / companyKey', () => {
  it('one person = one profile, whatever the spelling', () => {
    const a = profileKey('https://www.linkedin.com/in/Jane-Doe/?utm=x#top');
    expect(a).toBe('linkedin.com/in/jane-doe');
    expect(profileKey('linkedin.com/in/jane-doe')).toBe(a);
    expect(profileKey('HTTP://LinkedIn.com/in/jane-doe/')).toBe(a);
  });
  it('refuses what is not a link', () => {
    expect(profileKey('Jane Doe')).toBeNull(); expect(profileKey('javascript:alert(1)')).toBeNull(); expect(profileKey('')).toBeNull(); expect(profileKey('x'.repeat(700))).toBeNull();
  });
  it('one record per company however it is spelled', () => {
    expect(companyKey('VA Tech Wabag Ltd')).toBe('va tech wabag');
    expect(companyKey('VA Tech Wabag Ltd')).toBe(companyKey('VA Tech Wabag'));
    expect(companyKey('Thermax Limited')).toBe(companyKey('THERMAX Ltd.'));
    expect(companyKey('Toshiba Water Solutions Pvt Ltd (formerly UEM India)')).toBe(companyKey('Toshiba Water Solutions Private Limited'));
    expect(companyKey('Ltd')).toBe('');
  });
});

describe('validateOutreachRows', () => {
  const roles = new Set(['R003', 'R013']);
  const csv = (rows: string[]) => parseCsv([HEADER, ...rows].join('\n'));
  it('accepts good rows and rejects wrong role ids, bad links, future dates', () => {
    const r = validateOutreachRows(csv([
      'R003,Thermax,Site engineer,https://linkedin.com/in/a,2026-11-09,Contacted,2026-11-12,',
      'R999,Thermax,Site engineer,https://linkedin.com/in/b,2026-11-09,,,',
      'R003,Thermax,,not a link,2026-11-09,,,',
      'R003,Thermax,,https://linkedin.com/in/c,2027-01-01,,,',
      'R003,,,https://linkedin.com/in/d,2026-11-09,,,',
      'R013,Ramky,Service engineer,linkedin.com/in/e,,Found,,',
    ]), roles, '2026-11-13');
    expect(r.fatal).toBeNull();
    expect(r.rows.map(x => x.profile_key)).toEqual(['linkedin.com/in/a', 'linkedin.com/in/e']);
    expect(r.rejected.map(x => x.row)).toEqual([3, 4, 5, 6]);
    expect(r.rejected[0].reason).toMatch(/Unknown or closed role/);
    expect(r.rows[1].date_contacted).toBeNull();           // found, not yet messaged
  });
  it('reports a missing required column', () => {
    const r = validateOutreachRows(parseCsv('Role ID,Company\nR003,X'), roles, '2026-11-13');
    expect(r.fatal).toMatch(/profile link/);
  });
  it('maps header aliases', () => {
    expect(mapOutreachHeader(['role', 'Company name', 'LinkedIn', 'Contacted on']).index).toEqual({ role_id: 0, company: 1, profile_link: 2, date_contacted: 3 });
  });
});

describe('mergePerson — unique people versus follow-ups', () => {
  const row = (date: string | null, extra: Partial<{ status: string; outcome: string }> = {}) => ({
    role_id: 'R003', company: 'Thermax', job_title: 'Engineer', profile_link: 'https://x.com/a', profile_key: 'x.com/a', date_contacted: date, status: extra.status ?? null, next_followup: null, outcome: extra.outcome ?? null,
  });
  it('first message = a new person; a later date = one follow-up; the same file again changes nothing', () => {
    const a = mergePerson(null, row('2026-11-02'));
    expect(a.kind).toBe('new'); expect(a.person.followups).toBe(0);
    const b = mergePerson(a.person, row('2026-11-05'));
    expect(b.kind).toBe('followup'); expect(b.person.followups).toBe(1); expect(b.person.first_contacted).toBe('2026-11-02'); expect(b.person.last_contacted).toBe('2026-11-05');
    const again = mergePerson(b.person, row('2026-11-05'));
    expect(again.kind).toBe('merged'); expect(again.person.followups).toBe(1);
    const older = mergePerson(b.person, row('2026-11-02'));
    expect(older.kind).toBe('merged'); expect(older.person.followups).toBe(1);
  });
  it('a person only found, then messaged, is a first contact — not a follow-up', () => {
    const found = mergePerson(null, row(null));
    expect(found.person.first_contacted).toBeNull();
    const msg = mergePerson(found.person, row('2026-11-09'));
    expect(msg.kind).toBe('new'); expect(msg.person.followups).toBe(0); expect(msg.person.first_contacted).toBe('2026-11-09');
  });
  it('reads a reply and a qualified outcome from the sheet\'s own words', () => {
    expect(isReplied('Replied', null)).toBe(true); expect(isReplied('Contacted', 'No reply')).toBe(false); expect(isReplied('Awaiting', null)).toBe(false);
    expect(isQualifiedOutcome('Replied', 'Shortlisted for screening')).toBe(true); expect(isQualifiedOutcome(null, 'not qualified')).toBe(false);
    expect(mergePerson(null, row('2026-11-02', { status: 'Replied', outcome: 'Interested' })).person.replied).toBe(true);
  });
});

describe('company directory import', () => {
  it('merges a firm that is in several lists and cities into ONE record', () => {
    const t = parseCsv([
      'Company list,Company,City / area,Segment,Size,What they do,Already contacted,Source URL',
      'Water – Delhi NCR,VA Tech Wabag Ltd,New Delhi (project); global HQ Chennai,EPC / turnkey,Large,Global EPC,Yes,https://example.com/a',
      'Water – Bangalore,VA Tech Wabag Limited,Bangalore,EPC / turnkey,Large,,,',
      'Water – Hyderabad,VA Tech Wabag,Hyderabad,,,,,',
      'SaaS / IoT,Freshworks,Chennai,SaaS,Large,CRM,,',
      ',,,,,,,',
    ].join('\n'));
    const p = parseCompanyRows(t);
    expect(p.fatal).toBeNull();
    const merged = mergeCompanyRows(p.rows);
    expect(merged).toHaveLength(2);
    const w = merged.find(m => m.key.startsWith('va tech'))!;
    expect(w.lists.sort()).toEqual(['Water – Bangalore', 'Water – Delhi NCR', 'Water – Hyderabad']);
    expect(w.cities).toHaveLength(3); expect(w.legacy_contacted).toBe(true); expect(w.source_url).toBe('https://example.com/a');
  });
  it('rejects a file with no company column and rows with no name', () => {
    expect(parseCompanyRows(parseCsv('a,b\n1,2')).fatal).toMatch(/company/);
    expect(parseCompanyRows(parseCsv('Company\nLtd\nAcme')).rejected).toHaveLength(1);
  });
  it('flags a company not checked for six months', () => {
    const now = new Date('2026-11-13T00:00:00Z');
    expect(needsRecheck('2026-01-01T00:00:00Z', now)).toBe(true); expect(needsRecheck('2026-09-01T00:00:00Z', now)).toBe(false);
  });
});
