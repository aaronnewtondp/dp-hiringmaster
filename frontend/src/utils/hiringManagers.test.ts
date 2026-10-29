import { describe, it, expect } from 'vitest';
import { isNamedHiringManager, splitHiringManagerNames } from './hiringManagers.ts';
import { CPU_BACKSTOP_MS, cpuMs } from '../test/helpers.ts';

const NBSP = String.fromCharCode(0xa0);      // no-break space — what Slack/Docs/web pages paste
const ZWSP = String.fromCharCode(0x200b);     // zero-width space
const IDEO = String.fromCharCode(0x3000);     // ideographic space
const BOM  = String.fromCharCode(0xfeff);     // byte-order mark

// Must agree with backend/src/utils/hiringManagers.test.ts — the same rule on both sides. The Playwright spec
// tests/db/11-co-hiring-managers.spec.ts also runs this file against the backend one over a larger table.

describe('splitHiringManagerNames (frontend mirror)', () => {
  it.each([
    ['Mandeep Dagar', ['Mandeep Dagar']],
    ['Mandeep Dagar, Piyush Negi', ['Mandeep Dagar', 'Piyush Negi']],
    ['Mandeep Dagar;Piyush Negi', ['Mandeep Dagar', 'Piyush Negi']],
    ['Mandeep Dagar & Piyush Negi', ['Mandeep Dagar', 'Piyush Negi']],
    ['Mandeep Dagar and Piyush Negi', ['Mandeep Dagar', 'Piyush Negi']],
    ['Mandeep Dagar AND Piyush Negi', ['Mandeep Dagar', 'Piyush Negi']],
    ['A, B and C', ['A', 'B', 'C']],
    ['A, B, and C', ['A', 'B', 'C']],
    ['and Piyush Negi', ['Piyush Negi']],
    ['Sandeep Anand', ['Sandeep Anand']],
    ['Anand Kumar', ['Anand Kumar']],
    ['Mandeep Dagar,, ,Piyush Negi,', ['Mandeep Dagar', 'Piyush Negi']],
    [`Mandeep${NBSP}Dagar,${NBSP}Piyush Negi`, ['Mandeep Dagar', 'Piyush Negi']],
    ['Mandeep Dagar,\tPiyush Negi\n', ['Mandeep Dagar', 'Piyush Negi']],
    ['', []],
  ])('%j -> %j', (input, expected) => {
    expect(splitHiringManagerNames(input)).toEqual(expected);
  });

  it('null and undefined are empty', () => {
    expect(splitHiringManagerNames(null)).toEqual([]);
    expect(splitHiringManagerNames(undefined)).toEqual([]);
  });

  // The field is free text any Hiring Manager can write and this runs in the browser on every role. What keeps it cheap is the cap: nothing
  // past MAX_EXAMINED_LENGTH (1000) characters is looked at, and whitespace is collapsed before any pattern runs. The cap is asserted by
  // what it DOES — the names beyond it are invisible — which a slow machine cannot change; the old 250 ms wall-clock bound could.
  it('examines nothing past 1000 characters, so a huge run of blanks costs nothing (this runs in the browser on every role)', () => {
    const blanks = ' '.repeat(2_000_000);
    expect(splitHiringManagerNames(`${blanks}Piyush Negi`)).toEqual([]);                      // the only name sits beyond the cap
    expect(isNamedHiringManager('Piyush Negi', `${blanks}Piyush Negi`)).toBe(false);
    expect(splitHiringManagerNames(`Mandeep Dagar, ${' '.repeat(2_000_000)}, Piyush Negi`)).toEqual(['Mandeep Dagar']);
    const inside = `Mandeep Dagar,${' '.repeat(900)}Piyush Negi`;                              // the same shape under the cap is read in full
    expect(splitHiringManagerNames(inside)).toEqual(['Mandeep Dagar', 'Piyush Negi']);
    expect(isNamedHiringManager('Piyush Negi', inside)).toBe(true);
  });

  it('a huge run of blanks takes a bounded amount of CPU time (not a wall-clock limit)', () => {
    const blanks = ' '.repeat(2_000_000);
    const spent = cpuMs(() => { splitHiringManagerNames(blanks); isNamedHiringManager('Piyush Negi', blanks); });
    expect(spent).toBeLessThan(CPU_BACKSTOP_MS);                                              // ~1 ms when quiet; the quadratic version took ~10 s on 100k blanks
  });
});

describe('isNamedHiringManager (frontend mirror)', () => {
  it('whole name, case/whitespace insensitive, any listed person', () => {
    expect(isNamedHiringManager('piyush negi', 'Mandeep Dagar, Piyush Negi')).toBe(true);
    expect(isNamedHiringManager(' Mandeep Dagar ', 'Mandeep Dagar, Piyush Negi')).toBe(true);
    expect(isNamedHiringManager('Piyush Negi', 'Mandeep Dagar, and Piyush Negi')).toBe(true);
    expect(isNamedHiringManager(`Piyush${NBSP}Negi`, 'Mandeep Dagar, Piyush Negi')).toBe(true);
    expect(isNamedHiringManager('Amit', 'Amit Gosain')).toBe(false);
    expect(isNamedHiringManager('Dagar, Mandeep', 'Dagar, Mandeep')).toBe(true);       // the old whole-string rule still holds
    expect(isNamedHiringManager('', 'Alex')).toBe(false);
    expect(isNamedHiringManager('Alex', null)).toBe(false);
  });
});
