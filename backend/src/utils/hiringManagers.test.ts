import { describe, it, expect } from 'vitest';
import {
  canonicalHiringManagerField, isNamedHiringManager, namedHiringManagerSql, normalizeHiringManagerInput,
  splitHiringManagerNames, MAX_HIRING_MANAGER_FIELD_LENGTH,
} from './hiringManagers.js';

const NBSP = String.fromCharCode(0xa0);      // no-break space — what Slack/Docs/web pages paste
const ZWSP = String.fromCharCode(0x200b);     // zero-width space
const IDEO = String.fromCharCode(0x3000);     // ideographic space
const BOM  = String.fromCharCode(0xfeff);     // byte-order mark


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
    expect(splitHiringManagerNames('Mandeep Dagar AND Piyush Negi')).toEqual(['Mandeep Dagar', 'Piyush Negi']);
    expect(splitHiringManagerNames('A, B and C')).toEqual(['A', 'B', 'C']);
  });

  it('an Oxford comma does not leave "and" stuck to the last name', () => {
    expect(splitHiringManagerNames('A, B, and C')).toEqual(['A', 'B', 'C']);
    expect(splitHiringManagerNames('Mandeep Dagar, and Piyush Negi')).toEqual(['Mandeep Dagar', 'Piyush Negi']);
    expect(splitHiringManagerNames('and Piyush Negi')).toEqual(['Piyush Negi']);
  });

  it('does not split inside a name: "and" only counts as a separate word', () => {
    expect(splitHiringManagerNames('Sandeep Anand')).toEqual(['Sandeep Anand']);
    expect(splitHiringManagerNames('Brandon Sandra')).toEqual(['Brandon Sandra']);
    expect(splitHiringManagerNames('Anderson')).toEqual(['Anderson']);
    expect(splitHiringManagerNames('Anand Kumar')).toEqual(['Anand Kumar']);
  });

  it('treats pasted invisible whitespace like a space (no-break space, tab, newline, zero-width space, BOM, ideographic space)', () => {
    expect(splitHiringManagerNames(`Mandeep${NBSP}Dagar,${NBSP}Piyush Negi`)).toEqual(['Mandeep Dagar', 'Piyush Negi']);
    expect(splitHiringManagerNames('Mandeep Dagar,\tPiyush Negi\n')).toEqual(['Mandeep Dagar', 'Piyush Negi']);
    expect(splitHiringManagerNames(`Mandeep Dagar${ZWSP} and${IDEO}Piyush Negi`)).toEqual(['Mandeep Dagar', 'Piyush Negi']);
    expect(splitHiringManagerNames(`${BOM}Mandeep Dagar`)).toEqual(['Mandeep Dagar']);
  });

  it('drops blanks and survives junk', () => {
    expect(splitHiringManagerNames('Mandeep Dagar,, ,Piyush Negi,')).toEqual(['Mandeep Dagar', 'Piyush Negi']);
    expect(splitHiringManagerNames('')).toEqual([]);
    expect(splitHiringManagerNames(null)).toEqual([]);
    expect(splitHiringManagerNames(undefined)).toEqual([]);
    expect(splitHiringManagerNames(' , ; ')).toEqual([]);
  });

  it('is linear: a huge run of blanks (the old regex took ~10s on 100k of them) is instant, and so is a huge run of delimiters', () => {
    for (const evil of [' '.repeat(2_000_000), `${NBSP}`.repeat(500_000), ',' .repeat(500_000), ' ,'.repeat(300_000), 'and '.repeat(100_000), 'a' + ' '.repeat(1_000_000) + 'b']) {
      const t0 = Date.now();
      splitHiringManagerNames(evil);
      isNamedHiringManager('Piyush Negi', evil);
      expect(Date.now() - t0).toBeLessThan(250);
    }
  });
});

describe('canonicalHiringManagerField', () => {
  it('writes the canonical "A, B" form', () => {
    expect(canonicalHiringManagerField(`  mandeep${NBSP}dagar ; Piyush Negi and  Ria Sontakke `)).toBe('mandeep dagar, Piyush Negi, Ria Sontakke');
    expect(canonicalHiringManagerField('Amit ')).toBe('Amit');
    expect(canonicalHiringManagerField(null)).toBe('');
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
    expect(isNamedHiringManager('Piyush Negi', 'Mandeep Dagar, and Piyush Negi')).toBe(true);
  });

  it('is a superset of the old whole-string rule: a name that contains a delimiter still matches a field that is exactly that name', () => {
    expect(isNamedHiringManager('Dagar, Mandeep', 'Dagar, Mandeep')).toBe(true);
    expect(isNamedHiringManager('Anderson & Sons', 'Anderson & Sons')).toBe(true);
  });

  it('the user side may carry invisible whitespace too', () => {
    expect(isNamedHiringManager(`Piyush${NBSP}Negi`, 'Mandeep Dagar, Piyush Negi')).toBe(true);
  });

  it('an empty user name or an empty field never matches (an empty name must not match an empty entry)', () => {
    expect(isNamedHiringManager('', 'Alex')).toBe(false);
    expect(isNamedHiringManager('   ', 'Alex,  ,')).toBe(false);
    expect(isNamedHiringManager(null, 'Alex')).toBe(false);
    expect(isNamedHiringManager('Alex', '')).toBe(false);
    expect(isNamedHiringManager('Alex', null)).toBe(false);
  });
});

describe('normalizeHiringManagerInput (what a write may store)', () => {
  it('canonicalises a good value', () => {
    expect(normalizeHiringManagerInput(`Mandeep Dagar;${NBSP}Piyush Negi `)).toEqual({ ok: true, value: 'Mandeep Dagar, Piyush Negi' });
    expect(normalizeHiringManagerInput('Amit')).toEqual({ ok: true, value: 'Amit' });
  });

  it('a blank value is allowed (it clears the field)', () => {
    expect(normalizeHiringManagerInput('')).toEqual({ ok: true, value: '' });
    expect(normalizeHiringManagerInput('   ')).toEqual({ ok: true, value: '' });
  });

  it('refuses a value that is only delimiters: it would silently remove every Hiring Manager', () => {
    for (const v of [',', ';', ' , ; ', '&', 'and']) {
      // "and" alone is read as a name (nothing to split) — only pure punctuation is refused
      const r = normalizeHiringManagerInput(v);
      if (v === 'and') expect(r.ok).toBe(true); else expect(r.ok).toBe(false);
    }
  });

  it('refuses non-text and over-long values', () => {
    expect(normalizeHiringManagerInput(42).ok).toBe(false);
    expect(normalizeHiringManagerInput(null).ok).toBe(false);
    expect(normalizeHiringManagerInput(['A']).ok).toBe(false);
    expect(normalizeHiringManagerInput('x'.repeat(MAX_HIRING_MANAGER_FIELD_LENGTH + 1)).ok).toBe(false);
    expect(normalizeHiringManagerInput(' '.repeat(5000)).ok).toBe(false);
    expect(normalizeHiringManagerInput('x'.repeat(MAX_HIRING_MANAGER_FIELD_LENGTH)).ok).toBe(true);
  });
});

describe('namedHiringManagerSql', () => {
  it('builds a parameterised, NULL-safe fragment (the user value is never interpolated)', () => {
    const sql = namedHiringManagerSql('r.hiring_manager_name', '$3');
    expect(sql).toContain('$3::text');
    expect(sql).toContain('r.hiring_manager_name::text');
    expect(sql).toContain("<> ''");                           // a blank user name never matches a blank entry
    expect(sql).toContain('string_to_array(');
    const backslash = String.fromCharCode(92);
    expect(sql).toContain(backslash + 'u00a0');                 // the same explicit whitespace class as the TypeScript rule...
    expect(sql).not.toContain(NBSP);                            // ...spelled as an escape for Postgres, not as a raw character
  });
});
