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
  // Optional, never AI-generated (unlike every other field here) — a
  // hand-authored paragraph of team/system continuity context, shown above
  // the "About the role/About you" columns on the Social JD only, for a role
  // where that context matters enough to spell out. Left undefined for
  // every other role, which renders identically to before this field existed.
  roleContinuityNote?: string;
}

const MAX_KEY_RESPONSIBILITIES = 7;
// 8, not 7 — a role whose raw must_have_skills/nice_to_have_skills fields
// genuinely list 8+ distinct qualifications was losing one every time to fit
// the old cap, non-deterministically (whichever bullet the model condensed
// away that run), which read as "my content just vanished" to whoever wrote
// it. One extra slot gives real multi-section input room to survive intact
// without forcing every role down to exactly 7 regardless of how much it
// actually has to say.
const MAX_REQUIREMENT_BULLETS = 8;
const MAX_SOCIAL_BULLETS = 5;
// Hard cap on a WHOLE bullet string (markup included) — a backstop only; the prompt below asks for far less.
const MAX_SOCIAL_BULLET_CHARS = 90;

// What the social JD template (services/pdf/socialJd.ts) can set on ONE line at full size: the bold lead in
// a ~390pt column at 28pt, the detail line under it at 22.5pt. Beyond this the layout still copes (shrinks,
// wraps, ellipsizes) but the graphic gets visibly cramped — so the prompt asks for these and
// socialJd.test.ts measures real strings at exactly these limits in the real font, so the two can't drift.
export const SOCIAL_LEAD_MAX_CHARS = 24;
export const SOCIAL_DETAIL_MAX_CHARS = 36;
export const SOCIAL_TAG_MAX_CHARS = 24;

// Shared by the generation prompt and the extraction prompt (hand-written JDs) so they cannot diverge.
const TAGS_RULE = `- tags: 4-8 short chips (1-3 words, at most ${SOCIAL_TAG_MAX_CHARS} characters each, e.g. "Node.js", "PLC / HMI / SCADA"). isGreen=true for nice-to-have-derived tags, false for must-have-derived tags. The social graphic shows them as two colour groups on two rows, so lead with the core craft/skills.`;
const SOCIAL_BULLETS_RULE = `- socialAboutRole / socialAboutYou: ${MAX_SOCIAL_BULLETS} bullets each (fewer only if the role genuinely lacks material), printed as two short columns on a social graphic: "The Job" (socialAboutRole — what this person will DO) and "Who You Are" (socialAboutYou — what they have DONE or who they are). Format exactly "<b>Lead:</b> Detail". Lead = a punchy 2-4 word active phrase, at most ${SOCIAL_LEAD_MAX_CHARS} characters — never an abstract label like "Mission", "Scope" or "Impact" (good for the job: "Own the roadmap", "Ship every week", "Build the team"; good for you: "Shipped at scale", "Led a team", "Scrappy operator" — adapt the wording to THIS role, do not copy these). Detail = at most ${SOCIAL_DETAIL_MAX_CHARS} characters, plain words, one phrase, no trailing period. Direct and confident, never hype, no exclamation marks.`;

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
${TAGS_RULE}
- aboutRoleParagraph: 2-3 sentences introducing the role, written in second person ("You'll...").
- highlightQuote: an optional one-sentence pull-quote emphasizing impact/mission; use null if nothing genuinely stands out — do not force one.
- keyResponsibilities: ${MAX_KEY_RESPONSIBILITIES} bullets max, one sentence each, no trailing period style consistency required.
- mustHaves / goodToHaves: ${MAX_REQUIREMENT_BULLETS} bullets max each, condensed from the raw skills fields.
- goodToHaveLabel: use "Who You Are" for field/site-execution-heavy roles (personality/soft-skill framing), "Good to Have" for skill-heavy roles (technical/nice-to-have framing) — pick whichever fits this role.
- whyJoinUs: EXACTLY 4 items. iconKey must be one of: ${WHY_ICON_KEYS.join(', ')}. title is 2-4 words, description is one short sentence. Pick 4 distinct icon keys that fit this specific role (don't always default to the same 4).
${SOCIAL_BULLETS_RULE}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  return finalizeJdContent(response, role);
}

const EXTRACTION_RULES = `Rules:
${TAGS_RULE}
- aboutRoleParagraph: 2-3 sentences introducing the role, written in second person ("You'll...").
- highlightQuote: an optional one-sentence pull-quote emphasizing impact/mission; use null if nothing genuinely stands out — do not force one.
- keyResponsibilities: ${MAX_KEY_RESPONSIBILITIES} bullets max, one sentence each, no trailing period style consistency required.
- mustHaves / goodToHaves: ${MAX_REQUIREMENT_BULLETS} bullets max each, condensed from the source's requirements.
- goodToHaveLabel: use "Who You Are" for field/site-execution-heavy roles (personality/soft-skill framing), "Good to Have" for skill-heavy roles (technical/nice-to-have framing) — pick whichever fits this role.
- whyJoinUs: EXACTLY 4 items. iconKey must be one of: ${WHY_ICON_KEYS.join(', ')}. title is 2-4 words, description is one short sentence. Pick 4 distinct icon keys that fit this specific role (don't always default to the same 4).
${SOCIAL_BULLETS_RULE}`;

/**
 * Same target JSON shape as generateJdContent(), but for a role whose
 * long-form JD was authored entirely outside the system (a PDF/doc HR wrote
 * by hand) rather than condensed from this role's raw DB fields. Used to
 * populate generated_jd_content — the same column both PDF renderers AND
 * resumeIQ.ts's buildRoleRequirementsSection() read from — so ResumeIQ scores
 * against the externally-authored JD's real content, and the social JD (still
 * system-rendered) reflects it too. Unlike generateJdContent(), this is
 * explicitly told to extract/condense only what's in sourceText, never to
 * invent qualifications the external author didn't write.
 */
export async function extractJdContentFromText(role: Role, sourceText: string): Promise<JdContent | null> {
  const prompt = `You are structuring an EXTERNALLY-AUTHORED job description for DigitalPaani, a water-tech AI company, into the exact structured JSON shape requested below. This JD was written by hand outside this system — extract and condense only what's actually present in the source text. Do not invent, embellish, or add any responsibility, qualification, or claim that isn't grounded in the source.

ROLE TITLE: ${role.title}
DEPARTMENT: ${role.department || 'Not specified'}
LOCATION: ${role.location || 'Not specified'}
EMPLOYMENT TYPE: ${role.employment_type || 'Not specified'}
EXPERIENCE REQUIRED: ${role.yoe_required || 'Not specified'}

SOURCE JOB DESCRIPTION (verbatim — extract from this, do not add content not present here):
${sourceText}

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

${EXTRACTION_RULES}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  return finalizeJdContent(response, role);
}

export function finalizeJdContent(response: Anthropic.Message, role: Role): JdContent | null {
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

export function truncateSocialBullets(bullets: string[] | undefined): string[] {
  return (bullets || []).slice(0, MAX_SOCIAL_BULLETS).map(b => {
    if (b.length <= MAX_SOCIAL_BULLET_CHARS) return b;
    return b.slice(0, MAX_SOCIAL_BULLET_CHARS - 1).trimEnd() + '…';
  });
}
