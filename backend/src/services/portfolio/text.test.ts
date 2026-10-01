import { describe, it, expect } from 'vitest';
import { hasReadableText, jsonbSafeStringify, wellFormed } from './text.js';

describe('wellFormed', () => {
  it('leaves ordinary and complete-emoji text untouched', () => {
    expect(wellFormed('Portfolio — Café 😀 done')).toBe('Portfolio — Café 😀 done');
  });

  it('replaces a high surrogate cut off by slice()', () => {
    const cut = ('x'.repeat(199) + '😀').slice(0, 200);   // ends on the lone high surrogate
    const fixed = wellFormed(cut);
    expect(fixed).toBe('x'.repeat(199) + '�');
    expect(fixed.length).toBe(200);
  });

  it('replaces a lone low surrogate at the start', () => {
    expect(wellFormed('\uDE00abc')).toBe('�abc');
  });
});

describe('jsonbSafeStringify', () => {
  it('never emits a lone-surrogate escape (which jsonb rejects)', () => {
    const cut = ('x'.repeat(199) + '😀').slice(0, 200);
    expect(JSON.stringify({ title: cut })).toMatch(/\\ud83d/i);            // the raw problem
    expect(jsonbSafeStringify({ title: cut, nested: [{ t: cut }] })).not.toMatch(/\\ud[89ab]/i);
  });

  it('round-trips normal data unchanged', () => {
    const v = { a: 1, b: ['x', null, true], c: { d: 'é😀' } };
    expect(JSON.parse(jsonbSafeStringify(v))).toEqual(v);
  });
});

describe('hasReadableText', () => {
  const MARKER = '\n\n-- 1 of 1 --\n\n';

  it('is false for null/empty', () => {
    expect(hasReadableText(null)).toBe(false);
    expect(hasReadableText(undefined)).toBe(false);
    expect(hasReadableText('')).toBe(false);
    expect(hasReadableText('   \n ')).toBe(false);
  });

  it('is false for an image-only PDF, which extracts to page markers alone', () => {
    expect(hasReadableText(MARKER)).toBe(false);
    expect(hasReadableText('\n\n-- 1 of 3 --\n\n\n\n-- 2 of 3 --\n\n\n\n-- 3 of 3 --\n\n')).toBe(false);
  });

  it('is false for a scrap of text too short to be a resume', () => {
    expect(hasReadableText('Jane Doe' + MARKER)).toBe(false);
  });

  it('is true for a real resume, markers or not', () => {
    const resume = 'Jane Doe - Senior UX Designer\nExperience: 6 years at Acme designing products.\nPortfolio';
    expect(hasReadableText(resume)).toBe(true);
    expect(hasReadableText(resume + MARKER)).toBe(true);
  });
});
