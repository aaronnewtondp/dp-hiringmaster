import { describe, it, expect } from 'vitest';
import { qualifiedAt, qualifiedInWindow, QUALIFIED_TIMESTAMPS_SQL, type QualifiedInput } from './sourcingQualified.js';
import type { QualifiedRule } from './sourcingConfig.js';

// "Qualified" = shortlisted by a person OR ResumeIQ above 60, dated from immutable timestamps only.
const D = (iso: string) => new Date(iso);
const END = D('2026-10-14T06:00:00Z');
const DAY = 86400000;
const app = (shortlisted: string | null, scored: string | null): QualifiedInput => ({
  shortlisted_at: shortlisted ? D(shortlisted) : null, scored_at: scored ? D(scored) : null,
});

describe('qualifiedAt (the moment an application first met the rule)', () => {
  const EARLY = '2026-10-10T00:00:00Z';
  const LATE = '2026-10-12T00:00:00Z';

  it.each([
    // rule, shortlisted, scored, expected
    ['either', EARLY, LATE, EARLY],
    ['either', LATE, EARLY, EARLY],
    ['either', LATE, null, LATE],
    ['either', null, EARLY, EARLY],
    ['either', null, null, null],
    ['shortlisted', EARLY, LATE, EARLY],
    ['shortlisted', null, LATE, null],
    ['shortlisted', LATE, null, LATE],
    ['scored', EARLY, LATE, LATE],
    ['scored', EARLY, null, null],
    ['scored', null, EARLY, EARLY],
    ['scored', null, null, null],
  ] as Array<[QualifiedRule, string | null, string | null, string | null]>)(
    'rule %s, shortlisted %s, scored %s gives %s',
    (rule, s, c, expected) => {
      expect(qualifiedAt(app(s, c), rule)?.toISOString() ?? null).toBe(expected ? D(expected).toISOString() : null);
    },
  );

  it('both timestamps equal under "either" gives that moment', () => {
    expect(qualifiedAt(app(EARLY, EARLY), 'either')?.toISOString()).toBe(D(EARLY).toISOString());
  });
});

describe('qualifiedInWindow (the window is (end − days, end]: open at the start, closed at the end)', () => {
  it('an application exactly at the start of the window is out, one millisecond later is in', () => {
    const lo = END.getTime() - 7 * DAY;
    const at = (ms: number) => ({ shortlisted_at: new Date(ms), scored_at: null });
    expect(qualifiedInWindow([at(lo)], END, 7, 'either').qualified).toBe(0);
    expect(qualifiedInWindow([at(lo + 1)], END, 7, 'either').qualified).toBe(1);
  });

  it('an application exactly at the end is in, one millisecond after is out', () => {
    const hi = END.getTime();
    const at = (ms: number) => ({ shortlisted_at: new Date(ms), scored_at: null });
    expect(qualifiedInWindow([at(hi)], END, 7, 'either').qualified).toBe(1);
    expect(qualifiedInWindow([at(hi + 1)], END, 7, 'either').qualified).toBe(0);
  });

  it('the window length is a parameter', () => {
    const a = [app('2026-10-10T06:00:00Z', null)];                    // 4 days before END
    expect(qualifiedInWindow(a, END, 3, 'either').qualified).toBe(0);
    expect(qualifiedInWindow(a, END, 4, 'either').qualified).toBe(0); // exactly at the open start
    expect(qualifiedInWindow(a, END, 5, 'either').qualified).toBe(1);
  });

  it('an empty list, or a window of 0 days, counts nothing', () => {
    expect(qualifiedInWindow([], END, 7, 'either')).toEqual({ qualified: 0, shortlisted: 0, scored: 0 });
    expect(qualifiedInWindow([app('2026-10-14T06:00:00Z', null)], END, 0, 'either').qualified).toBe(0);
  });

  describe('which rule decides "qualified" (the two components are always reported separately)', () => {
    // A: shortlisted long ago, scored this week. B: shortlisted this week, never scored. C: only scored this week. D: neither.
    const apps = [
      app('2026-09-01T00:00:00Z', '2026-10-12T00:00:00Z'),
      app('2026-10-11T00:00:00Z', null),
      app(null, '2026-10-13T00:00:00Z'),
      app(null, null),
    ];

    it('either: an application counts in the window where it FIRST met either rule, so a long-ago shortlist never re-counts when it is scored later', () => {
      expect(qualifiedInWindow(apps, END, 7, 'either')).toEqual({ qualified: 2, shortlisted: 1, scored: 2 });
    });

    it('shortlisted: only the human shortlisting dates it', () => {
      expect(qualifiedInWindow(apps, END, 7, 'shortlisted')).toEqual({ qualified: 1, shortlisted: 1, scored: 2 });
    });

    it('scored: only the ResumeIQ score dates it', () => {
      expect(qualifiedInWindow(apps, END, 7, 'scored')).toEqual({ qualified: 2, shortlisted: 1, scored: 2 });
    });
  });

  it('shortlisted and scored are counted independently of the rule and of each other', () => {
    const both = [app('2026-10-13T00:00:00Z', '2026-10-13T00:00:00Z')];
    expect(qualifiedInWindow(both, END, 7, 'either')).toEqual({ qualified: 1, shortlisted: 1, scored: 1 });
  });

  it('a past window can be rebuilt: moving `end` back changes the answer', () => {
    const a = [app('2026-10-01T00:00:00Z', null)];
    expect(qualifiedInWindow(a, END, 7, 'either').qualified).toBe(0);
    expect(qualifiedInWindow(a, D('2026-10-05T00:00:00Z'), 7, 'either').qualified).toBe(1);
  });
});

describe('QUALIFIED_TIMESTAMPS_SQL (the two immutable timestamps both the engine and the plan view select)', () => {
  it('dates "shortlisted" by the first Stage Changed row that left Applied and Screened', () => {
    expect(QUALIFIED_TIMESTAMPS_SQL).toContain("al.event_type = 'Stage Changed'");
    expect(QUALIFIED_TIMESTAMPS_SQL).toContain("al.old_value = 'Applied and Screened'");
    expect(QUALIFIED_TIMESTAMPS_SQL).toContain('MIN(al.created_at)');
    expect(QUALIFIED_TIMESTAMPS_SQL).toContain('AS shortlisted_at');
  });

  it('dates "scored" by score_computed_at (falling back to the application date) only when the fit score is above 60', () => {
    expect(QUALIFIED_TIMESTAMPS_SQL).toContain('a.ai_fit_score > 60');
    expect(QUALIFIED_TIMESTAMPS_SQL).toContain('COALESCE(a.score_computed_at, a.application_date)');
    expect(QUALIFIED_TIMESTAMPS_SQL).toContain('AS scored_at');
  });

  it('never uses ai_scored_at (never written in production) or stage_entry_time (overwritten on every move)', () => {
    expect(QUALIFIED_TIMESTAMPS_SQL).not.toContain('ai_scored_at');
    expect(QUALIFIED_TIMESTAMPS_SQL).not.toContain('stage_entry_time');
  });
});
