import { describe, it, expect } from 'vitest';
import { isNamedHiringManager, namedHiringManagerSql, splitHiringManagerNames } from './hiringManagers.js';

describe('splitHiringManagerNames', () => {
  it('one name is one entry, exactly as before', () => {
    expect(splitHiringManagerNames('Mandeep Dagar')).toEqual(['Mandeep Dagar']);
    expect(splitHiringManagerNames('  Mandeep Dagar  ')).toEqual(['Mandeep Dagar']);
  });

  it('splits on a comma, semicolon, ampersand or the word "and"', () => {
    expect(splitHiringManagerNames('Mandeep Dagar, Piyush Negi')).toEqual(['Mandeep Dagar', 'Piyush Negi']);
    expect(splitHiringManagerNames('Mandeep Dagar;Piyush Negi')).toEqual(['Mandeep Dagar', 'Piyush Negi']);
    expect(splitHiringManagerNames('Mandeep Dagar & Piyush Negi')).toEqual(['Mandeep Dagar', 'Piyush Negi']);
    expect(splitHiringManagerNames('Mandeep Dagar and Piyush Negi')).toEqual(['Mandeep Dagar', 'Piyush Negi']);
    expect(splitHiringManagerNames('A, B and C')).toEqual(['A', 'B', 'C']);
  });

  it('does not split inside a name: "and" only counts as a separate word', () => {
    expect(splitHiringManagerNames('Sandeep Anand')).toEqual(['Sandeep Anand']);
    expect(splitHiringManagerNames('Brandon Sandra')).toEqual(['Brandon Sandra']);
    expect(splitHiringManagerNames('Anderson')).toEqual(['Anderson']);
  });

  it('drops blanks and survives junk', () => {
    expect(splitHiringManagerNames('Mandeep Dagar,, ,Piyush Negi,')).toEqual(['Mandeep Dagar', 'Piyush Negi']);
    expect(splitHiringManagerNames('')).toEqual([]);
    expect(splitHiringManagerNames(null)).toEqual([]);
    expect(splitHiringManagerNames(undefined)).toEqual([]);
    expect(splitHiringManagerNames(' , ; ')).toEqual([]);
  });
});

describe('isNamedHiringManager', () => {
  it('matches a whole name, ignoring case and edge spaces (production has values like "Amit " and "Amit Gosain ")', () => {
    expect(isNamedHiringManager('amit', 'Amit ')).toBe(true);
    expect(isNamedHiringManager('Amit Gosain', 'Amit Gosain ')).toBe(true);
    expect(isNamedHiringManager('  ALEX ', 'Alex')).toBe(true);
  });

  it('is not a substring match: Amit is not Amit Gosain', () => {
    expect(isNamedHiringManager('Amit', 'Amit Gosain')).toBe(false);
    expect(isNamedHiringManager('Amit Gosain', 'Amit')).toBe(false);
    expect(isNamedHiringManager('Alex', 'Alexander')).toBe(false);
  });

  it('finds any listed person', () => {
    expect(isNamedHiringManager('Piyush Negi', 'Mandeep Dagar, Piyush Negi')).toBe(true);
    expect(isNamedHiringManager('Mandeep Dagar', 'Mandeep Dagar, Piyush Negi')).toBe(true);
    expect(isNamedHiringManager('Ria Sontakke', 'Mandeep Dagar, Piyush Negi')).toBe(false);
  });

  it('an empty user name or an empty field never matches (an empty name must not match an empty entry)', () => {
    expect(isNamedHiringManager('', 'Alex')).toBe(false);
    expect(isNamedHiringManager('   ', 'Alex,  ,')).toBe(false);
    expect(isNamedHiringManager(null, 'Alex')).toBe(false);
    expect(isNamedHiringManager('Alex', '')).toBe(false);
    expect(isNamedHiringManager('Alex', null)).toBe(false);
  });
});

describe('namedHiringManagerSql', () => {
  it('builds a parameterised fragment (the user value is never interpolated)', () => {
    const sql = namedHiringManagerSql('r.hiring_manager_name', '$3');
    expect(sql).toContain('$3');
    expect(sql).toContain('r.hiring_manager_name');
    expect(sql).toMatch(/regexp_split_to_array\(lower\(trim\(r\.hiring_manager_name\)\)/);
    expect(sql).toContain("trim($3) <> ''");                   // a blank user name never matches a blank entry
  });
});
