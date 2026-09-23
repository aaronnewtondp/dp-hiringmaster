import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { finalizeJdContent, truncateSocialBullets } from './jdContent.js';
import { Role } from '../types/index.js';

const role = { id: 'R999', title: 'Test Role', department: 'Tech / Engineering' } as Role;

function fakeResponse(text: string): Anthropic.Message {
  return { content: [{ type: 'text', text }] } as unknown as Anthropic.Message;
}

const VALID_WHY_JOIN_US = [
  { iconKey: 'mission', title: 'Mission', description: 'd1' },
  { iconKey: 'team', title: 'Team', description: 'd2' },
  { iconKey: 'growth', title: 'Growth', description: 'd3' },
  { iconKey: 'pay', title: 'Pay', description: 'd4' },
];

function validPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    tags: [{ text: 'Node.js', isGreen: false }],
    aboutRoleParagraph: 'You will do things.',
    highlightQuote: null,
    keyResponsibilities: ['Do a thing'],
    mustHaves: ['Know a thing'],
    goodToHaves: ['Bonus thing'],
    goodToHaveLabel: 'Good to Have',
    whyJoinUs: VALID_WHY_JOIN_US,
    socialAboutRole: ['<b>Role:</b> summary'],
    socialAboutYou: ['<b>You:</b> summary'],
    ...overrides,
  });
}

describe('finalizeJdContent', () => {
  it('parses a valid response into a full JdContent, deriving variant from the role', () => {
    const result = finalizeJdContent(fakeResponse(validPayload()), role);
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('tech');
    expect(result!.whyJoinUs).toHaveLength(4);
    expect(result!.aboutRoleParagraph).toBe('You will do things.');
  });

  it('strips markdown code fences before parsing', () => {
    const fenced = '```json\n' + validPayload() + '\n```';
    const result = finalizeJdContent(fakeResponse(fenced), role);
    expect(result).not.toBeNull();
  });

  it('returns null for unparseable JSON', () => {
    const result = finalizeJdContent(fakeResponse('not json at all'), role);
    expect(result).toBeNull();
  });

  it('returns null when whyJoinUs is missing', () => {
    const payload = JSON.parse(validPayload());
    delete payload.whyJoinUs;
    const result = finalizeJdContent(fakeResponse(JSON.stringify(payload)), role);
    expect(result).toBeNull();
  });

  it('returns null when whyJoinUs does not have exactly 4 items', () => {
    const result = finalizeJdContent(
      fakeResponse(validPayload({ whyJoinUs: VALID_WHY_JOIN_US.slice(0, 3) })),
      role
    );
    expect(result).toBeNull();
  });

  it('returns null when whyJoinUs contains an unrecognized icon key', () => {
    const badWhyJoinUs = [
      ...VALID_WHY_JOIN_US.slice(0, 3),
      { iconKey: 'not-a-real-icon', title: 'Bogus', description: 'd' },
    ];
    const result = finalizeJdContent(fakeResponse(validPayload({ whyJoinUs: badWhyJoinUs })), role);
    expect(result).toBeNull();
  });

  it('caps keyResponsibilities at 7, mustHaves/goodToHaves at 8, tags at 8', () => {
    const result = finalizeJdContent(
      fakeResponse(validPayload({
        keyResponsibilities: Array.from({ length: 12 }, (_, i) => `resp ${i}`),
        mustHaves: Array.from({ length: 12 }, (_, i) => `must ${i}`),
        goodToHaves: Array.from({ length: 12 }, (_, i) => `good ${i}`),
        tags: Array.from({ length: 12 }, (_, i) => ({ text: `tag${i}`, isGreen: false })),
      })),
      role
    );
    expect(result!.keyResponsibilities).toHaveLength(7);
    expect(result!.mustHaves).toHaveLength(8);
    expect(result!.goodToHaves).toHaveLength(8);
    expect(result!.tags).toHaveLength(8);
  });

  it('defaults goodToHaveLabel to "Good to Have" for anything other than "Who You Are"', () => {
    const result = finalizeJdContent(fakeResponse(validPayload({ goodToHaveLabel: 'Something Else' })), role);
    expect(result!.goodToHaveLabel).toBe('Good to Have');

    const whoYouAre = finalizeJdContent(fakeResponse(validPayload({ goodToHaveLabel: 'Who You Are' })), role);
    expect(whoYouAre!.goodToHaveLabel).toBe('Who You Are');
  });
});

describe('truncateSocialBullets', () => {
  it('returns an empty array for undefined input', () => {
    expect(truncateSocialBullets(undefined)).toEqual([]);
  });

  it('caps at 5 bullets', () => {
    const bullets = Array.from({ length: 8 }, (_, i) => `bullet ${i}`);
    expect(truncateSocialBullets(bullets)).toHaveLength(5);
  });

  it('leaves a bullet under the 90-char cap untouched', () => {
    const short = 'A short bullet';
    expect(truncateSocialBullets([short])).toEqual([short]);
  });

  it('truncates a bullet over the 90-char cap and appends an ellipsis', () => {
    const long = 'x'.repeat(120);
    const [result] = truncateSocialBullets([long]);
    expect(result.length).toBeLessThanOrEqual(90);
    expect(result.endsWith('…')).toBe(true);
  });
});
