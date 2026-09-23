import { describe, it, expect } from 'vitest';
import { buildRoleRequirementsSection, bulletList } from './resumeIQ.js';
import { Role } from '../types/index.js';

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
