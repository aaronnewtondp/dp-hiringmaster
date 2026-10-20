import { describe, it, expect } from 'vitest';
import { buildHrDigest, buildWeeklySummary, DigestException } from './sourcingDigest.js';
import { mergeSettings } from './sourcingConfig.js';

const ex = (over: Partial<DigestException> = {}): DigestException => ({
  role_id: 'R5', role_title: 'QA Engineer', priority: 'P1', channel: 'Agency',
  committed: 'Agency: Select agencies', happened: 'Not done — 2 days overdue', next_action: 'Choose the agencies', age_days: 2, ...over,
});

describe('buildHrDigest', () => {
  it('sends nothing when there is nothing to say — an empty all-clear every morning is noise', () => {
    expect(buildHrDigest({ today: '2026-10-14', dueToday: [], exceptions: [] })).toBeNull();
    // an overdue commitment is already inside an exception, so it does not count as "due today" on its own
    expect(buildHrDigest({ today: '2026-10-14', exceptions: [], dueToday: [{ role_id: 'R1', role_title: 'X', channel: 'LinkedIn', title: 'Renew', overdue: true }] })).toBeNull();
  });

  it('lists exceptions and what is due today, greets the HR team (not a person), and links to the role card', () => {
    const m = buildHrDigest({
      today: '2026-10-14', baseUrl: 'https://hms.example.com/',
      exceptions: [ex()], dueToday: [{ role_id: 'R1', role_title: 'Backend', channel: 'LinkedIn', title: 'Renew the posting', overdue: false }],
    })!;
    expect(m.subject).toBe('Sourcing — 1 item needs attention, 1 due today (2026-10-14)');
    expect(m.text).toContain('Hi team,');
    expect(m.text).toContain('QA Engineer (P1) — Agency');
    expect(m.text).toContain('Not done — 2 days overdue. Next: Choose the agencies.');
    expect(m.text).toContain('https://hms.example.com/roles/R5#sourcing');            // trailing slash trimmed, no double slash
    expect(m.text).toContain('Backend — LinkedIn: Renew the posting');
  });

  it('pluralises the subject', () => {
    const m = buildHrDigest({ today: '2026-10-14', dueToday: [], exceptions: [ex(), ex({ role_id: 'R6' })] })!;
    expect(m.subject).toBe('Sourcing — 2 items need attention (2026-10-14)');
  });

  it('works without a base URL (no broken links)', () => {
    const m = buildHrDigest({ today: '2026-10-14', dueToday: [], exceptions: [ex()] })!;
    expect(m.text).not.toContain('http');
  });
});

describe('buildWeeklySummary', () => {
  const base = { today: '2026-10-12', plansActive: 6, plansDraft: 8, openRoles: 14, onTimePct: 80, overdueCommitments: 3, provisionalSignals: 0 };

  it('always produces a summary — an all-clear week is information', () => {
    const m = buildWeeklySummary({ ...base, exceptions: [] });
    expect(m.subject).toContain('on track');
    expect(m.text).toContain('6 of 14 open roles have an active plan; 8 still waiting to be activated.');
    expect(m.text).toContain('No open exceptions');
  });

  it('names no individual (the HR team owns every exception) and never ranks or totals people against each other', () => {
    const m = buildWeeklySummary({ ...base, exceptions: [ex(), ex({ role_id: 'R6' })] });
    expect(m.subject).toContain('2 exceptions');
    expect(m.text).toContain('QA Engineer (P1) — Agency');
    expect(m.text).not.toContain('·');
    expect(m.text.toLowerCase()).not.toMatch(/leaderboard|ranking|rank|unassigned/);
  });

  it('caps the list at 15 and points to the dashboard for the rest', () => {
    const many = Array.from({ length: 18 }, (_, i) => ex({ role_id: `R${i}` }));
    const m = buildWeeklySummary({ ...base, exceptions: many });
    expect(m.text).toContain('…and 3 more on the dashboard.');
    expect((m.text.match(/Committed:/g) ?? []).length).toBe(15);
  });

  it('says nothing was due rather than "0%" when no commitment came due', () => {
    expect(buildWeeklySummary({ ...base, onTimePct: null, exceptions: [] }).text).toContain('nothing was due');
  });

  it('mentions provisional signals exist without listing them', () => {
    expect(buildWeeklySummary({ ...base, provisionalSignals: 2, exceptions: [] }).text).toContain('2 provisional signals');
  });
});

describe('digest settings validation', () => {
  it('recipients must all be company addresses (exception data is internal), lower-cased and de-duplicated', () => {
    expect(mergeSettings([{ key: 'digest_recipients', value: ['Aaron.Newton@DigitalPaani.com', 'aaron.newton@digitalpaani.com'] }]).digest_recipients)
      .toEqual(['aaron.newton@digitalpaani.com']);
    expect(mergeSettings([{ key: 'digest_recipients', value: ['someone@gmail.com'] }]).digest_recipients).toEqual([]);
    expect(mergeSettings([{ key: 'digest_recipients', value: ['ok@digitalpaani.com', 'x@evil.com'] }]).digest_recipients).toEqual([]);   // one bad address rejects the lot
    expect(mergeSettings([{ key: 'digest_recipients', value: 'ok@digitalpaani.com' }]).digest_recipients).toEqual([]);
  });
  it('the daily HR digest is off unless explicitly switched on with a real boolean', () => {
    expect(mergeSettings([]).daily_digest_enabled).toBe(false);
    expect(mergeSettings([{ key: 'daily_digest_enabled', value: 'yes' }]).daily_digest_enabled).toBe(false);
    expect(mergeSettings([{ key: 'daily_digest_enabled', value: true }]).daily_digest_enabled).toBe(true);
    expect(mergeSettings([{ key: 'owner_digest_enabled', value: true }])).not.toHaveProperty('owner_digest_enabled');   // the retired per-owner setting
  });
});
