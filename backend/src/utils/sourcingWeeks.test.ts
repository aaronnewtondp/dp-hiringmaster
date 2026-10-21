import { describe, expect, it } from 'vitest';
import { completedWindows, currentWindow, effectiveAnchor, isTargetMet, partialWindow, sumWindow, summarizeWeeks } from './sourcingWeeks.js';
import { addCalendarDays } from './workingDays.js';

describe('completedWindows', () => {
  it('a week finishes once its LAST day has ended — nothing on the anchor day, nothing until day 8', () => {
    expect(completedWindows('2026-10-21', '2026-10-21')).toEqual([]);
    expect(completedWindows('2026-10-21', '2026-10-27')).toEqual([]);            // day 7 is still running
    expect(completedWindows('2026-10-21', '2026-10-28')).toEqual([{ start: '2026-10-21', end: '2026-10-27' }]);
  });
  it('lists every finished week, oldest first, and never the one in progress', () => {
    const w = completedWindows('2026-10-01', '2026-10-30');
    expect(w.map(x => x.start)).toEqual(['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22']);
    expect(w[3].end).toBe('2026-10-28');
  });
  it('crosses month and year ends', () => {
    expect(completedWindows('2026-12-29', '2027-01-06')).toEqual([{ start: '2026-12-29', end: '2027-01-04' }]);
  });
  it('a bad date or a future anchor gives nothing', () => {
    expect(completedWindows('tomorrow', '2026-10-30')).toEqual([]);
    expect(completedWindows('2026-11-05', '2026-10-30')).toEqual([]);
  });
  it('is capped so a very old anchor cannot run away', () => {
    expect(completedWindows('2020-01-01', '2026-10-30', 10)).toHaveLength(10);
  });
});

describe('currentWindow', () => {
  it('is the week containing today, aligned to the anchor', () => {
    expect(currentWindow('2026-10-21', '2026-10-21')).toEqual({ start: '2026-10-21', end: '2026-10-27' });
    expect(currentWindow('2026-10-21', '2026-10-27')).toEqual({ start: '2026-10-21', end: '2026-10-27' });
    expect(currentWindow('2026-10-21', '2026-10-28')).toEqual({ start: '2026-10-28', end: '2026-11-03' });
  });
  it('null before the tracker starts', () => {
    expect(currentWindow('2026-10-21', '2026-10-20')).toBeNull();
  });
});

describe('sumWindow / isTargetMet', () => {
  const byDay = new Map([['2026-10-20', { n: 9, q: 9 }], ['2026-10-21', { n: 3, q: 1 }], ['2026-10-27', { n: 2, q: 2 }], ['2026-10-28', { n: 7, q: 0 }]]);
  it('adds only the days inside the window, both ends inclusive', () => {
    expect(sumWindow(byDay, { start: '2026-10-21', end: '2026-10-27' })).toEqual({ actual: 5, qualified: 3 });
    expect(sumWindow(byDay, { start: '2026-11-01', end: '2026-11-07' })).toEqual({ actual: 0, qualified: 0 });
  });
  it('meets the target exactly at the target — red below, green at or above', () => {
    expect(isTargetMet(9, 10)).toBe(false);
    expect(isTargetMet(10, 10)).toBe(true);
    expect(isTargetMet(11, 10)).toBe(true);
  });
});

describe('effectiveAnchor — a reopened channel never overlaps the weeks it already finished', () => {
  it('keeps the anchor when there is no earlier week or it started later', () => {
    expect(effectiveAnchor('2026-10-21', null)).toBe('2026-10-21');
    expect(effectiveAnchor('2026-11-05', '2026-10-27')).toBe('2026-11-05');
  });
  it('moves to the day after the last finished week when the anchor would overlap it', () => {
    expect(effectiveAnchor('2026-10-25', '2026-10-27')).toBe('2026-10-28');
    expect(effectiveAnchor('2026-10-27', '2026-10-27')).toBe('2026-10-28');
  });
});

describe('partialWindow — the week cut short when a channel stops being measured', () => {
  it('runs from the week start to the stop day, flagged partial', () => {
    expect(partialWindow('2026-10-21', '2026-10-24')).toEqual({ window: { start: '2026-10-21', end: '2026-10-24' }, partial: true });
  });
  it('stopping on the last day of a week is still partial: that day has not ended', () => {
    expect(partialWindow('2026-10-21', '2026-10-27')).toEqual({ window: { start: '2026-10-21', end: '2026-10-27' }, partial: true });
  });
  it('stopping on the first day is a one-day partial week', () => {
    expect(partialWindow('2026-10-21', '2026-10-21')).toEqual({ window: { start: '2026-10-21', end: '2026-10-21' }, partial: true });
  });
  it('uses the week in progress, not the first one', () => {
    expect(partialWindow('2026-10-01', '2026-10-17')).toEqual({ window: { start: '2026-10-15', end: '2026-10-17' }, partial: true });
  });
  it('null when the tracker has not started', () => {
    expect(partialWindow('2026-10-21', '2026-10-20')).toBeNull();
  });
});

describe('summarizeWeeks', () => {
  it('counts weeks, weeks on target, and the totals', () => {
    expect(summarizeWeeks([{ target: 10, actual: 12, met: true }, { target: 10, actual: 4, met: false }])).toEqual({ weeks: 2, met: 1, actual: 16, target: 20 });
    expect(summarizeWeeks([])).toEqual({ weeks: 0, met: 0, actual: 0, target: 0 });
  });
  it('a week cut short is shown in the list but is neither a tracked week nor a miss', () => {
    expect(summarizeWeeks([
      { target: 10, actual: 12, met: true }, { target: 10, actual: 2, met: false, partial: true }, { target: 10, actual: 12, met: true, partial: true },
    ])).toEqual({ weeks: 1, met: 1, actual: 12, target: 10 });
    expect(summarizeWeeks([{ target: 5, actual: 0, met: false, partial: true }])).toEqual({ weeks: 0, met: 0, actual: 0, target: 0 });
  });
});

describe('partialWindow — more edges', () => {
  it('a bad anchor or a bad stop date gives nothing', () => {
    expect(partialWindow('soon', '2026-10-21')).toBeNull();
    expect(partialWindow('2026-10-21', 'today')).toBeNull();
    expect(partialWindow('2026-10-21', '')).toBeNull();
    expect(partialWindow('21/10/2026', '2026-10-24')).toBeNull();
  });
  it('crosses a month, a year and a leap day', () => {
    expect(partialWindow('2026-10-29', '2026-11-02')).toEqual({ window: { start: '2026-10-29', end: '2026-11-02' }, partial: true });
    expect(partialWindow('2026-12-29', '2027-01-02')).toEqual({ window: { start: '2026-12-29', end: '2027-01-02' }, partial: true });
    expect(partialWindow('2028-02-26', '2028-02-29')).toEqual({ window: { start: '2028-02-26', end: '2028-02-29' }, partial: true });
  });
  it('stopping on the first day of a LATER week is a one-day partial of that week, never of the week before', () => {
    expect(partialWindow('2026-10-21', '2026-10-28')).toEqual({ window: { start: '2026-10-28', end: '2026-10-28' }, partial: true });
  });
  it('is always flagged partial, whatever the stop day', () => {
    for (let d = 0; d < 30; d++) expect(partialWindow('2026-10-01', addCalendarDays('2026-10-01', d))?.partial).toBe(true);
  });
  it('never reaches past the stop day or the end of the week, and never starts after the stop day', () => {
    for (let d = 0; d < 30; d++) {
      const stop = addCalendarDays('2026-10-01', d);
      const pw = partialWindow('2026-10-01', stop)!;
      expect(pw.window.end <= stop).toBe(true);
      expect(pw.window.start <= pw.window.end).toBe(true);
      expect(pw.window.end).toBe(stop);                                   // the week in progress always reaches up to the stop day itself
      expect(currentWindow('2026-10-01', stop)!.start).toBe(pw.window.start);
    }
  });
});

describe('finishing a tracker: the ended weeks plus the week cut short cover the days from the anchor to the stop day exactly once', () => {
  // Mirrors what finalizeWeeksInTx does with these helpers.
  const span = (anchor: string, stop: string) => {
    const ended = completedWindows(anchor, stop);
    const pw = partialWindow(ended.length ? addCalendarDays(ended[ended.length - 1].end, 1) : anchor, stop);
    return { ended, partial: pw?.window ?? null, all: [...ended, ...(pw ? [pw.window] : [])] };
  };
  it('no gap and no overlap for every stop day over six weeks', () => {
    for (let d = 0; d < 42; d++) {
      const stop = addCalendarDays('2026-10-01', d);
      const { all } = span('2026-10-01', stop);
      expect(all[0].start).toBe('2026-10-01');
      expect(all[all.length - 1].end).toBe(stop);
      for (let i = 1; i < all.length; i++) expect(all[i].start, `stop ${stop}`).toBe(addCalendarDays(all[i - 1].end, 1));
      expect(all.filter(w => w.end === stop && w !== all[all.length - 1])).toHaveLength(0);
    }
  });
  it('stopping on the anchor day is a single one-day partial and no finished week', () => {
    const r = span('2026-10-21', '2026-10-21');
    expect(r.ended).toEqual([]);
    expect(r.partial).toEqual({ start: '2026-10-21', end: '2026-10-21' });
  });
  it('stopping on the last day of a week finishes the weeks before it and cuts that last day short — the day is not over', () => {
    const r = span('2026-10-21', '2026-10-27');
    expect(r.ended).toEqual([]);
    expect(r.partial).toEqual({ start: '2026-10-21', end: '2026-10-27' });
  });
  it('stopping the day after a week ends finishes that week and starts a one-day partial', () => {
    const r = span('2026-10-21', '2026-10-28');
    expect(r.ended).toEqual([{ start: '2026-10-21', end: '2026-10-27' }]);
    expect(r.partial).toEqual({ start: '2026-10-28', end: '2026-10-28' });
  });
  it('weeks already written are not rebuilt: starting from the day after the last written week finds only the weeks since', () => {
    const from = effectiveAnchor('2026-10-01', '2026-10-14');                      // two weeks already on record
    expect(from).toBe('2026-10-15');
    const r = span(from, '2026-10-30');
    expect(r.ended).toEqual([{ start: '2026-10-15', end: '2026-10-21' }, { start: '2026-10-22', end: '2026-10-28' }]);
    expect(r.partial).toEqual({ start: '2026-10-29', end: '2026-10-30' });
  });
});

describe('effectiveAnchor with currentWindow — the week after a cut-short week', () => {
  it('after a week was cut short today, the next week starts tomorrow: nothing is running today', () => {
    const today = '2026-10-24';
    const anchor = effectiveAnchor('2026-10-21', today);                            // the cut-short row ends today
    expect(anchor).toBe('2026-10-25');
    expect(currentWindow(anchor, today)).toBeNull();
    expect(currentWindow(anchor, '2026-10-25')).toEqual({ start: '2026-10-25', end: '2026-10-31' });
  });
  it('a bad last-week date is ignored, and one that precedes the anchor changes nothing', () => {
    expect(effectiveAnchor('2026-10-21', 'not-a-date')).toBe('2026-10-21');
    expect(effectiveAnchor('2026-10-21', '2026-10-01')).toBe('2026-10-21');
    expect(effectiveAnchor('2026-10-21', '')).toBe('2026-10-21');
  });
  it('crosses month and year ends', () => {
    expect(effectiveAnchor('2026-10-30', '2026-10-31')).toBe('2026-11-01');
    expect(effectiveAnchor('2026-12-28', '2026-12-31')).toBe('2027-01-01');
  });
});

describe('summarizeWeeks — more edges', () => {
  it('an explicit partial:false counts like a missing flag', () => {
    expect(summarizeWeeks([{ target: 10, actual: 12, met: true, partial: false }, { target: 10, actual: 3, met: false }])).toEqual({ weeks: 2, met: 1, actual: 15, target: 20 });
  });
  it('the order of the rows does not matter and the input is not changed', () => {
    const rows = [{ target: 10, actual: 12, met: true }, { target: 10, actual: 2, met: false, partial: true }, { target: 8, actual: 1, met: false }];
    const copy = JSON.parse(JSON.stringify(rows));
    const a = summarizeWeeks(rows);
    expect(summarizeWeeks([...rows].reverse())).toEqual(a);
    expect(a).toEqual({ weeks: 2, met: 1, actual: 13, target: 18 });
    expect(rows).toEqual(copy);
  });
  it('a cut-short week never changes "weeks on target", even when it would have met the target', () => {
    const finished = [{ target: 10, actual: 12, met: true }];
    expect(summarizeWeeks([...finished, { target: 10, actual: 99, met: true, partial: true }])).toEqual(summarizeWeeks(finished));
  });
  it('only cut-short weeks means nothing was tracked', () => {
    expect(summarizeWeeks([{ target: 10, actual: 4, met: false, partial: true }, { target: 10, actual: 6, met: false, partial: true }])).toEqual({ weeks: 0, met: 0, actual: 0, target: 0 });
  });
  it('a week with a zero applicant count is a real, missed week', () => {
    expect(summarizeWeeks([{ target: 5, actual: 0, met: false }])).toEqual({ weeks: 1, met: 0, actual: 0, target: 5 });
  });
});

describe('completedWindows / currentWindow — more edges', () => {
  it('max = 0 returns nothing', () => {
    expect(completedWindows('2026-10-01', '2026-10-30', 0)).toEqual([]);
  });
  it('windows are consecutive and 7 days long, across a leap day', () => {
    const w = completedWindows('2028-02-22', '2028-03-20');
    expect(w[0]).toEqual({ start: '2028-02-22', end: '2028-02-28' });
    expect(w[1]).toEqual({ start: '2028-02-29', end: '2028-03-06' });
    for (let i = 1; i < w.length; i++) expect(w[i].start).toBe(addCalendarDays(w[i - 1].end, 1));
  });
  it('the week in progress is never also a finished week', () => {
    for (let d = 0; d < 40; d++) {
      const today = addCalendarDays('2026-10-01', d);
      const done = completedWindows('2026-10-01', today);
      const cur = currentWindow('2026-10-01', today)!;
      expect(done.some(x => x.start === cur.start)).toBe(false);
      expect(cur.start <= today && today <= cur.end).toBe(true);
    }
  });
  it('a bad date gives no current window', () => {
    expect(currentWindow('x', '2026-10-21')).toBeNull();
    expect(currentWindow('2026-10-21', 'x')).toBeNull();
  });
});

describe('sumWindow — more edges', () => {
  it('an empty map and a one-day window', () => {
    expect(sumWindow(new Map(), { start: '2026-10-21', end: '2026-10-27' })).toEqual({ actual: 0, qualified: 0 });
    expect(sumWindow(new Map([['2026-10-21', { n: 4, q: 2 }]]), { start: '2026-10-21', end: '2026-10-21' })).toEqual({ actual: 4, qualified: 2 });
  });
  it('a cut-short window counts only the days up to its end', () => {
    const byDay = new Map([['2026-10-21', { n: 2, q: 1 }], ['2026-10-23', { n: 3, q: 0 }], ['2026-10-25', { n: 8, q: 5 }]]);
    expect(sumWindow(byDay, partialWindow('2026-10-21', '2026-10-23')!.window)).toEqual({ actual: 5, qualified: 1 });
  });
});
