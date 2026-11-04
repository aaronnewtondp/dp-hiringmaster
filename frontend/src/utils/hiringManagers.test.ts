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
    ['Test Manager One', ['Test Manager One']],
    ['Test Manager One, Test Manager Two', ['Test Manager One', 'Test Manager Two']],
    ['Test Manager One;Test Manager Two', ['Test Manager One', 'Test Manager Two']],
    ['Test Manager One & Test Manager Two', ['Test Manager One', 'Test Manager Two']],
    ['Test Manager One and Test Manager Two', ['Test Manager One', 'Test Manager Two']],
    ['Test Manager One AND Test Manager Two', ['Test Manager One', 'Test Manager Two']],
    ['A, B and C', ['A', 'B', 'C']],
    ['A, B, and C', ['A', 'B', 'C']],
    ['and Test Manager Two', ['Test Manager Two']],
    ['Sandy Brand', ['Sandy Brand']],
    ['Brand Tester', ['Brand Tester']],
    ['Test Manager One,, ,Test Manager Two,', ['Test Manager One', 'Test Manager Two']],
    [`Test${NBSP}Manager One,${NBSP}Test Manager Two`, ['Test Manager One', 'Test Manager Two']],
    // The other invisible blanks people paste from Slack, Docs and web pages: each must read as an ordinary space (the zero-width space is the one \s does NOT cover).
    [`Test${ZWSP}Manager One,${ZWSP}Test Manager Two`, ['Test Manager One', 'Test Manager Two']],
    [`Test${IDEO}Manager One,${IDEO}Test Manager Two`, ['Test Manager One', 'Test Manager Two']],
    [`Test${BOM}Manager One,${BOM}Test Manager Two`, ['Test Manager One', 'Test Manager Two']],
    ['Test Manager One,\tTest Manager Two\n', ['Test Manager One', 'Test Manager Two']],
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
    expect(splitHiringManagerNames(`${blanks}Test Manager Two`)).toEqual([]);                      // the only name sits beyond the cap
    expect(isNamedHiringManager('Test Manager Two', `${blanks}Test Manager Two`)).toBe(false);
    expect(splitHiringManagerNames(`Test Manager One, ${' '.repeat(2_000_000)}, Test Manager Two`)).toEqual(['Test Manager One']);
    const inside = `Test Manager One,${' '.repeat(900)}Test Manager Two`;                              // the same shape under the cap is read in full
    expect(splitHiringManagerNames(inside)).toEqual(['Test Manager One', 'Test Manager Two']);
    expect(isNamedHiringManager('Test Manager Two', inside)).toBe(true);
  });

  it('a huge run of blanks takes a bounded amount of CPU time (not a wall-clock limit)', () => {
    const blanks = ' '.repeat(2_000_000);
    const spent = cpuMs(() => { splitHiringManagerNames(blanks); isNamedHiringManager('Test Manager Two', blanks); });
    expect(spent).toBeLessThan(CPU_BACKSTOP_MS);                                              // ~1 ms when quiet; the quadratic version took ~10 s on 100k blanks
  });
});

describe('isNamedHiringManager (frontend mirror)', () => {
  it('whole name, case/whitespace insensitive, any listed person', () => {
    expect(isNamedHiringManager('test manager two', 'Test Manager One, Test Manager Two')).toBe(true);
    expect(isNamedHiringManager(' Test Manager One ', 'Test Manager One, Test Manager Two')).toBe(true);
    expect(isNamedHiringManager('Test Manager Two', 'Test Manager One, and Test Manager Two')).toBe(true);
    expect(isNamedHiringManager(`Test${NBSP}Manager Two`, 'Test Manager One, Test Manager Two')).toBe(true);
    expect(isNamedHiringManager(`Test${ZWSP}Manager Two`, 'Test Manager One, Test Manager Two')).toBe(true);        // an invisible blank inside the user's own name
    expect(isNamedHiringManager('Test', 'Test Manager One')).toBe(false);
    expect(isNamedHiringManager('Manager One, Test', 'Manager One, Test')).toBe(true);       // the old whole-string rule still holds
    expect(isNamedHiringManager('', 'Test Manager One')).toBe(false);
    expect(isNamedHiringManager('Test Manager One', null)).toBe(false);
  });
});
