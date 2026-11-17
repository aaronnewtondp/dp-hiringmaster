import { describe, it, expect, vi, afterEach } from 'vitest';
import { expectCpuUnder } from '../testing/timing.js';
import { FULL_NAME_MAX_CHARS, collapseName, checkFullName, truncateFullName } from './candidateName.js';

afterEach(() => vi.restoreAllMocks());

describe('collapseName', () => {
  it('trims and collapses every kind of whitespace', () => {
    expect(collapseName('  Priya \t\n Sharma 　Rao ')).toBe('Priya Sharma Rao');
  });
  it.each([null, undefined, 5, {}, ['a']])('%j is not text: empty', v => expect(collapseName(v)).toBe(''));
});

describe('checkFullName (user-facing)', () => {
  it('accepts a normal name, cleaned', () => expect(checkFullName(' Amit   Gosain ')).toEqual({ ok: true, name: 'Amit Gosain' }));
  it.each(['', '   ', ' 　', null, 12])('%j is empty', v => expect(checkFullName(v)).toEqual({ ok: false, reason: 'empty' }));
  it('accepts exactly the cap and refuses one more', () => {
    expect(checkFullName('a'.repeat(FULL_NAME_MAX_CHARS)).ok).toBe(true);
    expect(checkFullName('a'.repeat(FULL_NAME_MAX_CHARS + 1))).toEqual({ ok: false, reason: 'too_long' });
  });
  it('counts characters, not UTF-16 units: 200 emoji fit, 201 do not', () => {
    expect(checkFullName('😀'.repeat(FULL_NAME_MAX_CHARS)).ok).toBe(true);
    expect(checkFullName('😀'.repeat(FULL_NAME_MAX_CHARS + 1)).ok).toBe(false);
  });
  it('measures after collapsing whitespace', () => {
    expect(checkFullName('a' + ' '.repeat(500) + 'b').ok).toBe(true);
  });
});

describe('truncateFullName (machine paths)', () => {
  it('leaves a normal name alone and does not warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(truncateFullName('Neha Sharma')).toBe('Neha Sharma');
    expect(warn).not.toHaveBeenCalled();
  });
  it.each(['', '  ', null, undefined, {}, true])('%j has no name: null', v => expect(truncateFullName(v)).toBeNull());
  it('reads a number as text', () => expect(truncateFullName(42)).toBe('42'));
  it('cuts a long run at the cap and warns without the name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = truncateFullName('x'.repeat(5000), 'test')!;
    expect(out).toHaveLength(FULL_NAME_MAX_CHARS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('5000');
    expect(String(warn.mock.calls[0][0])).not.toContain('xxxx');
  });
  it('backs up to a word boundary', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const name = 'abcdefghi '.repeat(40).trim();
    const out = truncateFullName(name)!;
    expect(out.length).toBeLessThanOrEqual(FULL_NAME_MAX_CHARS);
    expect(out.endsWith('abcdefghi')).toBe(true);
  });
  it('does not back up when the cut already falls on a space', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(truncateFullName('a'.repeat(FULL_NAME_MAX_CHARS) + ' tail')).toBe('a'.repeat(FULL_NAME_MAX_CHARS));
  });
  it('never splits a surrogate pair', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = truncateFullName('😀'.repeat(300))!;
    expect(Array.from(out)).toHaveLength(FULL_NAME_MAX_CHARS);
    expect(out).toBe('😀'.repeat(FULL_NAME_MAX_CHARS));
  });
  it('keeps unicode names whole under the cap', () => {
    expect(truncateFullName('प्रिया शर्मा')).toBe('प्रिया शर्मा');
  });
  it('is fast on a very long input', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expectCpuUnder(2000, () => truncateFullName('ab '.repeat(400_000)), 'truncateFullName on 1.2 MB');
  });
});
