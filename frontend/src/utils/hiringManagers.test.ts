import { describe, it, expect } from 'vitest';
import { isNamedHiringManager, splitHiringManagerNames } from './hiringManagers.ts';

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

  it('is linear on a huge run of blanks (this runs in the browser on every role)', () => {
    const t0 = Date.now();
    splitHiringManagerNames(' '.repeat(2_000_000));
    isNamedHiringManager('Piyush Negi', ' '.repeat(2_000_000));
    expect(Date.now() - t0).toBeLessThan(250);
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
