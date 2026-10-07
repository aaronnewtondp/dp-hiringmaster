import { describe, it, expect } from 'vitest';
import { isNamedHiringManager, splitHiringManagerNames } from './hiringManagers.ts';

// Must agree with backend/src/utils/hiringManagers.test.ts — the same delimiter rule on both sides.
describe('splitHiringManagerNames (frontend mirror)', () => {
  it.each([
    ['Mandeep Dagar', ['Mandeep Dagar']],
    ['Mandeep Dagar, Piyush Negi', ['Mandeep Dagar', 'Piyush Negi']],
    ['Mandeep Dagar;Piyush Negi', ['Mandeep Dagar', 'Piyush Negi']],
    ['Mandeep Dagar & Piyush Negi', ['Mandeep Dagar', 'Piyush Negi']],
    ['A, B and C', ['A', 'B', 'C']],
    ['Sandeep Anand', ['Sandeep Anand']],
    ['Mandeep Dagar,, ,Piyush Negi,', ['Mandeep Dagar', 'Piyush Negi']],
    ['', []],
  ])('%j -> %j', (input, expected) => {
    expect(splitHiringManagerNames(input)).toEqual(expected);
  });

  it('null and undefined are empty', () => {
    expect(splitHiringManagerNames(null)).toEqual([]);
    expect(splitHiringManagerNames(undefined)).toEqual([]);
  });
});

describe('isNamedHiringManager (frontend mirror)', () => {
  it('whole name, case/edge-space insensitive, any listed person', () => {
    expect(isNamedHiringManager('piyush negi', 'Mandeep Dagar, Piyush Negi')).toBe(true);
    expect(isNamedHiringManager(' Mandeep Dagar ', 'Mandeep Dagar, Piyush Negi')).toBe(true);
    expect(isNamedHiringManager('Amit', 'Amit Gosain')).toBe(false);
    expect(isNamedHiringManager('', 'Alex')).toBe(false);
    expect(isNamedHiringManager('Alex', null)).toBe(false);
  });
});
