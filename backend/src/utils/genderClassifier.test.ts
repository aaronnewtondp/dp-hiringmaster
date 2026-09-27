import { describe, it, expect } from 'vitest';
import { classifyGender, extractFirstName } from './genderClassifier.js';

describe('extractFirstName', () => {
  it('takes the first whitespace-separated token, lowercased', () => {
    expect(extractFirstName('Priya Sharma')).toBe('priya');
    expect(extractFirstName('AMIT KUMAR')).toBe('amit');
  });

  it('strips a leading title/prefix before taking the first name', () => {
    expect(extractFirstName('Dr. Anjali Mehta')).toBe('anjali');
    expect(extractFirstName('Mr Rohan Verma')).toBe('rohan');
    expect(extractFirstName('Smt Sunita Devi')).toBe('sunita');
  });

  it('returns null for empty/null/undefined input', () => {
    expect(extractFirstName(null)).toBeNull();
    expect(extractFirstName(undefined)).toBeNull();
    expect(extractFirstName('')).toBeNull();
    expect(extractFirstName('   ')).toBeNull();
  });

  it('handles a single-token name (no last name)', () => {
    expect(extractFirstName('Madhu')).toBe('madhu');
  });
});

describe('classifyGender', () => {
  it('classifies well-known male names as M', () => {
    for (const name of ['Amit Sharma', 'Rahul Verma', 'Vikram Singh', 'Suresh Kumar', 'Arjun Reddy']) {
      expect(classifyGender(name), name).toBe('M');
    }
  });

  it('classifies well-known female names as F', () => {
    for (const name of ['Priya Sharma', 'Anjali Gupta', 'Neha Verma', 'Lakshmi Iyer', 'Kavya Nair']) {
      expect(classifyGender(name), name).toBe('F');
    }
  });

  it('is case-insensitive and title/prefix-aware', () => {
    expect(classifyGender('PRIYA SHARMA')).toBe('F');
    expect(classifyGender('Dr. Amit Kumar')).toBe('M');
  });

  it('returns null for known-ambiguous/unisex Indian names rather than guessing', () => {
    for (const name of ['Kiran Patel', 'Simran Kaur', 'Manpreet Singh']) {
      expect(classifyGender(name), name).toBeNull();
    }
  });

  it('returns null for a name not in the dictionary and not matching a suffix rule', () => {
    expect(classifyGender('Xzqrt Nomatch')).toBeNull();
  });

  it('returns null for empty/missing input', () => {
    expect(classifyGender('')).toBeNull();
    expect(classifyGender(null)).toBeNull();
    expect(classifyGender(undefined)).toBeNull();
  });

  it('falls back to the feminine suffix heuristic for an undictionaried "-ika" name', () => {
    expect(classifyGender('Zarnika Rao')).toBe('F');
  });

  it('falls back to the masculine suffix heuristic for an undictionaried "-esh" name', () => {
    expect(classifyGender('Zaresh Patel')).toBe('M');
  });
});
