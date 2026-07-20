import Anthropic from '@anthropic-ai/sdk';
import { Role } from '../types/index.js';
import { WhyIconKey, WHY_ICON_KEYS, classifyVariant, JdVariant } from './pdf/theme.js';

const client = new Anthropic();

export interface JdTag {
  text: string;
  isGreen: boolean;
}

export interface WhyJoinUsItem {
  iconKey: WhyIconKey;
  title: string;
  description: string;
  isGreen: boolean;
}

export interface JdContent {
  variant: JdVariant;
  tags: JdTag[];
  aboutRoleParagraph: string;
  highlightQuote: string | null;
  keyResponsibilities: string[];
  mustHaves: string[];
  goodToHaves: string[];
  goodToHaveLabel: 'Good to Have' | 'Who You Are';
  whyJoinUs: WhyJoinUsItem[];
  socialAboutRole: string[];
  socialAboutYou: string[];
}

const MAX_KEY_RESPONSIBILITIES = 7;
const MAX_REQUIREMENT_BULLETS = 7;
const MAX_SOCIAL_BULLETS = 5;
const MAX_SOCIAL_BULLET_CHARS = 90; // hard cap on the description portion, generous over the "~60 chars" style guide

/**
 * Condenses a role's raw free-text fields into the structured content both JD
 * PDF renderers need. Mirrors resumeIQ.ts's Anthropic-SDK pattern (same client
 * construction, single-turn strict-JSON prompt). Unlike resumeIQ.ts, this does
 * NOT fall back to degraded placeholder content on failure — it returns null so
 * the caller skips writing jd_drive_link/social_jd_drive_link, leaving the
 * per-role "already generated" guard unset and allowing a clean retry on the
 * next role edit.
 */
export async function generateJdContent(role: Role): Promise<JdContent | null> {
  const prompt = `You are a copywriter producing branded job-description content for DigitalPaani, a water-tech AI company. Condense the raw requisition fields below into the exact structured JSON shape requested. Do not invent qualifications not implied by the input; condense and clarify, don't fabricate.

ROLE TITLE: ${role.title}
DEPARTMENT: ${role.department || 'Not specified'}
LOCATION: ${role.location || 'Not specified'}
EMPLOYMENT TYPE: ${role.employment_type || 'Not specified'}
EXPERIENCE REQUIRED: ${role.yoe_required || 'Not specified'}

JOB DESCRIPTION / KEY RESPONSIBILITIES (raw):
${role.job_description || role.kpi_expectations || 'Not specified'}

MUST-HAVE SKILLS (raw):
${role.must_have_skills || 'Not specified'}

NICE-TO-HAVE SKILLS (raw):
${role.nice_to_have_skills || 'Not specified'}

Return ONLY valid JSON, no markdown, no code fences, matching exactly this shape:
{
  "tags": [{"text": "", "isGreen": false}],
  "aboutRoleParagraph": "",
  "highlightQuote": null,
  "keyResponsibilities": [""],
  "mustHaves": [""],
  "goodToHaves": [""],
  "goodToHaveLabel": "Good to Have",
  "whyJoinUs": [{"iconKey": "", "title": "", "description": "", "isGreen": false}],
  "socialAboutRole": [""],
  "socialAboutYou": [""]
}

Rules:
- tags: 4-8 short chips (1-3 words each, e.g. "Node.js", "PLC / HMI / SCADA"). isGreen=true for nice-to-have-derived tags, false for must-have-derived tags.
- aboutRoleParagraph: 2-3 sentences introducing the role, written in second person ("You'll...").
- highlightQuote: an optional one-sentence pull-quote emphasizing impact/mission; use null if nothing genuinely stands out — do not force one.
- keyResponsibilities: ${MAX_KEY_RESPONSIBILITIES} bullets max, one sentence each, no trailing period style consistency required.
- mustHaves / goodToHaves: ${MAX_REQUIREMENT_BULLETS} bullets max each, condensed from the raw skills fields.
- goodToHaveLabel: use "Who You Are" for field/site-execution-heavy roles (personality/soft-skill framing), "Good to Have" for skill-heavy roles (technical/nice-to-have framing) — pick whichever fits this role.
- whyJoinUs: EXACTLY 4 items. iconKey must be one of: ${WHY_ICON_KEYS.join(', ')}. title is 2-4 words, description is one short sentence. Pick 4 distinct icon keys that fit this specific role (don't always default to the same 4).
- socialAboutRole / socialAboutYou: ${MAX_SOCIAL_BULLETS} bullets max each, format exactly "<b>Label:</b> Description" with description under 60 characters — these are for a space-constrained social graphic, keep them terse.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  const rawText = textBlock && 'text' in textBlock ? textBlock.text : '';
  const cleaned = rawText.replace(/```json|```/g, '').trim();

  let parsed: Omit<JdContent, 'variant'>;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error('[JD-Gen] Content generation returned unparseable JSON for role', role.id, err);
    return null;
  }

  if (!Array.isArray(parsed.whyJoinUs) || parsed.whyJoinUs.length !== 4) {
    console.error('[JD-Gen] Content generation returned invalid whyJoinUs for role', role.id);
    return null;
  }

  const whyJoinUs = parsed.whyJoinUs.filter(w => WHY_ICON_KEYS.includes(w.iconKey)).slice(0, 4);
  if (whyJoinUs.length !== 4) {
    console.error('[JD-Gen] Content generation returned an unrecognized whyJoinUs iconKey for role', role.id);
    return null;
  }

  return {
    variant: classifyVariant(role.department, role.title),
    tags: (parsed.tags || []).slice(0, 8),
    aboutRoleParagraph: parsed.aboutRoleParagraph || '',
    highlightQuote: parsed.highlightQuote || null,
    keyResponsibilities: (parsed.keyResponsibilities || []).slice(0, MAX_KEY_RESPONSIBILITIES),
    mustHaves: (parsed.mustHaves || []).slice(0, MAX_REQUIREMENT_BULLETS),
    goodToHaves: (parsed.goodToHaves || []).slice(0, MAX_REQUIREMENT_BULLETS),
    goodToHaveLabel: parsed.goodToHaveLabel === 'Who You Are' ? 'Who You Are' : 'Good to Have',
    whyJoinUs,
    socialAboutRole: truncateSocialBullets(parsed.socialAboutRole),
    socialAboutYou: truncateSocialBullets(parsed.socialAboutYou),
  };
}

function truncateSocialBullets(bullets: string[] | undefined): string[] {
  return (bullets || []).slice(0, MAX_SOCIAL_BULLETS).map(b => {
    if (b.length <= MAX_SOCIAL_BULLET_CHARS) return b;
    return b.slice(0, MAX_SOCIAL_BULLET_CHARS - 1).trimEnd() + '…';
  });
}
