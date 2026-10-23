import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Role, Candidate } from '../types/index.js';

// resumeIQ.ts does `new Anthropic()` at module load, so the SDK must be mocked
// before it's imported — this stands in for the client and captures the prompt.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock };
  },
}));

import { buildRoleRequirementsSection, bulletList, scoreCandidate } from './resumeIQ.js';

describe('bulletList', () => {
  it('joins items as "- item" lines', () => {
    expect(bulletList(['a', 'b'])).toBe('- a\n- b');
  });

  it('returns "Not specified" for undefined or empty arrays', () => {
    expect(bulletList(undefined)).toBe('Not specified');
    expect(bulletList([])).toBe('Not specified');
  });
});

describe('buildRoleRequirementsSection', () => {
  it('falls back to the three short DB fields when generated_jd_content is null', () => {
    const role = {
      must_have_skills: 'Node.js, 3+ years',
      nice_to_have_skills: 'AWS',
      kpi_expectations: 'Ship features',
      generated_jd_content: null,
    } as unknown as Role;

    const section = buildRoleRequirementsSection(role);
    expect(section).toContain('JOB REQUIREMENTS (Must Have):\nNode.js, 3+ years');
    expect(section).toContain('NICE TO HAVE:\nAWS');
    expect(section).toContain('KEY RESPONSIBILITIES:\nShip features');
    expect(section).not.toContain('ABOUT THE ROLE');
  });

  it('falls back to "Not specified" per field when the short DB fields are also empty', () => {
    const role = { generated_jd_content: null } as unknown as Role;
    const section = buildRoleRequirementsSection(role);
    expect(section).toContain('Not specified');
  });

  it('prefers generated_jd_content over the short DB fields when present', () => {
    const role = {
      must_have_skills: 'should not appear',
      nice_to_have_skills: 'should not appear either',
      generated_jd_content: {
        aboutRoleParagraph: 'You will architect things.',
        keyResponsibilities: ['Do X', 'Do Y'],
        mustHaves: ['Know X'],
        goodToHaves: ['Know Y'],
        goodToHaveLabel: 'Who You Are',
        tags: [{ text: 'Figma' }, { text: 'Copywriting' }],
      },
    } as unknown as Role;

    const section = buildRoleRequirementsSection(role);
    expect(section).toContain('ABOUT THE ROLE:\nYou will architect things.');
    expect(section).toContain('KEY RESPONSIBILITIES:\n- Do X\n- Do Y');
    expect(section).toContain('MUST HAVES:\n- Know X');
    expect(section).toContain('WHO YOU ARE:\n- Know Y');
    expect(section).toContain('SKILL/TECH TAGS: Figma, Copywriting');
    expect(section).not.toContain('should not appear');
  });

  it('a truthy-but-empty generated_jd_content object never falls back to the short DB fields — every section reads "Not specified" instead', () => {
    // Regression test for a documented gotcha: buildRoleRequirementsSection's
    // presence check is `if (!content)`, so `{}` (truthy) skips the
    // must_have_skills/nice_to_have_skills/kpi_expectations fallback entirely,
    // even though every sub-field it tries to read is missing.
    const role = {
      must_have_skills: 'real requirement text that must NOT leak through',
      generated_jd_content: {},
    } as unknown as Role;

    const section = buildRoleRequirementsSection(role);
    expect(section).not.toContain('real requirement text that must NOT leak through');
    expect(section).toContain('ABOUT THE ROLE:\nNot specified');
    expect(section).toContain('SKILL/TECH TAGS: Not specified');
  });

  it('defaults the section label to GOOD TO HAVE when goodToHaveLabel is absent', () => {
    const role = { generated_jd_content: { goodToHaves: ['x'] } } as unknown as Role;
    const section = buildRoleRequirementsSection(role);
    expect(section).toContain('GOOD TO HAVE:\n- x');
  });
});

describe('scoreCandidate prompt', () => {
  const candidate = { full_name: 'Test Candidate' } as unknown as Candidate;
  const role = { title: 'Test Role', generated_jd_content: null } as unknown as Role;

  beforeEach(() => {
    // Only Date is faked so the awaited mock call resolves normally.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
    createMock.mockReset();
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function capturePrompt(): Promise<string> {
    await scoreCandidate(candidate, role, 'Acme Corp, Jan 2024 - Jun 2026');
    expect(createMock).toHaveBeenCalledTimes(1);
    return createMock.mock.calls[0][0].messages[0].content as string;
  }

  it("states today's real date near the top, before the role and resume sections", async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain("TODAY'S DATE: 2026-09-30");
    expect(prompt.indexOf("TODAY'S DATE")).toBeLessThan(prompt.indexOf('ROLE: Test Role'));
    expect(prompt.indexOf("TODAY'S DATE")).toBeLessThan(prompt.indexOf('RESUME CONTENT:'));
  });

  it('tells the model dates up to today are past and only genuinely later dates are future', async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain(
      'Dates up to and including today are in the past and must not be flagged as future dates; only flag a date that is genuinely after today.'
    );
  });

  it('tracks the real clock rather than a hardcoded date', async () => {
    vi.setSystemTime(new Date('2027-01-15T08:00:00Z'));
    const prompt = await capturePrompt();
    expect(prompt).toContain("TODAY'S DATE: 2027-01-15");
    expect(prompt).not.toContain('2026-09-30');
  });
});
