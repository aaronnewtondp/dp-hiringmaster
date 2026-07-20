import Anthropic from '@anthropic-ai/sdk';
import { Candidate, Role } from '../types/index.js';

const client = new Anthropic();

// ─── Types matching the digitalpaani-candidate-scoring skill rubric exactly ──
export interface DimensionScore {
  score: number;   // 0–10 integer
  note:  string;   // max ~8 words
}

export interface ResumeIQResult {
  technical:      DimensionScore;
  experience:     DimensionScore;
  industryFit:    DimensionScore;
  cultureFit:     DimensionScore;
  roleAlignment:  DimensionScore;
  trajectory:     DimensionScore;
  leadership:     DimensionScore;
  communication:  DimensionScore;
  avgScore:       number;   // mean of the 8 scores, 1 decimal
  strengths:      string[]; // exactly 3
  redFlags:       string[]; // empty if none
  summary:        string;   // max 2 sentences
  recommendation: 'Strong Yes' | 'Yes' | 'Maybe' | 'No';
  resumeRead:     boolean;  // false if resume text could not be fetched
}

// ─── Main scoring function ────────────────────────────────────────────────────
// Mirrors the digitalpaani-candidate-scoring skill's Step 5 prompt exactly, so
// scores are consistent whether generated from the HMS app or the Claude skill.
export async function scoreCandidate(
  candidate: Candidate,
  role: Role,
  resumeText?: string | null
): Promise<ResumeIQResult> {

  const resumeRead = !!resumeText;

  const prompt = `You are a senior HR analyst for DigitalPaani, a water-tech AI company.

ROLE: ${role.title}

${buildRoleRequirementsSection(role)}

CANDIDATE PROFILE:
Name: ${candidate.full_name}
Current CTC: ${formatCtc(candidate)}
Expected CTC: ${candidate.expected_ctc ? `${candidate.expected_ctc} LPA` : 'Not specified'}
Notice Period: ${candidate.notice_period_days != null ? `${candidate.notice_period_days} days` : 'Not specified'}
Location: ${candidate.current_location || 'Not specified'}
Current Company: ${candidate.current_company || 'Not specified'}
Current Designation: ${candidate.current_designation || 'Not specified'}
Industry: ${candidate.current_industry || 'Not specified'}
Years of Experience: ${candidate.years_of_experience != null ? candidate.years_of_experience : 'Not specified'}

RESUME CONTENT:
${resumeText || '(No resume text available — score based on profile fields only)'}

Score this candidate. Return ONLY valid JSON, no markdown, no code fences:
{
  "technical": {"score": 0, "note": ""},
  "experience": {"score": 0, "note": ""},
  "industryFit": {"score": 0, "note": ""},
  "cultureFit": {"score": 0, "note": ""},
  "roleAlignment": {"score": 0, "note": ""},
  "trajectory": {"score": 0, "note": ""},
  "leadership": {"score": 0, "note": ""},
  "communication": {"score": 0, "note": ""},
  "avgScore": 0.0,
  "strengths": ["", "", ""],
  "redFlags": [],
  "summary": "",
  "recommendation": ""
}

Rules: scores 0-10 integers, avgScore = mean of 8 scores (1 decimal),
notes max 8 words, summary max 2 sentences,
recommendation = "Strong Yes"|"Yes"|"Maybe"|"No",
strengths = exactly 3 strings, redFlags = array (empty if none).`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  const rawText = textBlock && 'text' in textBlock ? textBlock.text : '{}';

  // Strip any accidental markdown fences before parsing
  const cleaned = rawText.replace(/```json|```/g, '').trim();

  let parsed: Omit<ResumeIQResult, 'resumeRead'>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Fallback — should rarely happen given the strict prompt
    parsed = {
      technical:     { score: 0, note: 'Scoring failed' },
      experience:    { score: 0, note: 'Scoring failed' },
      industryFit:   { score: 0, note: 'Scoring failed' },
      cultureFit:    { score: 0, note: 'Scoring failed' },
      roleAlignment: { score: 0, note: 'Scoring failed' },
      trajectory:    { score: 0, note: 'Scoring failed' },
      leadership:    { score: 0, note: 'Scoring failed' },
      communication: { score: 0, note: 'Scoring failed' },
      avgScore: 0,
      strengths: ['Unable to score', 'Unable to score', 'Unable to score'],
      redFlags: ['AI scoring returned invalid output — retry needed'],
      summary: 'Automated scoring failed; manual review required.',
      recommendation: 'Maybe',
    };
  }

  return { ...parsed, resumeRead };
}

// ─── Fetch resume text from a Google Drive link ───────────────────────────────
// Extracts the file ID from either URL format used by the Google Form:
//   https://drive.google.com/open?id=FILE_ID
//   https://drive.google.com/file/d/FILE_ID/view
export function extractDriveFileId(url: string): string | null {
  const openMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (openMatch) return openMatch[1];
  const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return fileMatch[1];
  return null;
}

// ─── Helper: role requirements section of the prompt ─────────────────────────
// Prefers the rich structured content generated for the role's JD PDFs
// (jdContent.ts's JdContent, persisted as roles.generated_jd_content) over the
// short must_have_skills/nice_to_have_skills/kpi_expectations DB fields — but
// only once a role has actually been through the Approved+JD-generation flow.
// Falls back to the original three-field format unchanged for any role
// without generated content, so scoring behavior for those roles is identical
// to before this change.
interface GeneratedJdContentForScoring {
  aboutRoleParagraph?: string;
  keyResponsibilities?: string[];
  mustHaves?: string[];
  goodToHaves?: string[];
  goodToHaveLabel?: string;
  tags?: Array<{ text: string }>;
}

function bulletList(items?: string[]): string {
  return items && items.length ? items.map(i => `- ${i}`).join('\n') : 'Not specified';
}

function buildRoleRequirementsSection(role: Role): string {
  const content = role.generated_jd_content as GeneratedJdContentForScoring | null | undefined;

  if (!content) {
    return `JOB REQUIREMENTS (Must Have):
${role.must_have_skills || 'Not specified'}

NICE TO HAVE:
${role.nice_to_have_skills || 'Not specified'}

KEY RESPONSIBILITIES:
${role.kpi_expectations || 'Not specified'}`;
  }

  const tags = content.tags && content.tags.length ? content.tags.map(t => t.text).join(', ') : 'Not specified';

  return `ABOUT THE ROLE:
${content.aboutRoleParagraph || 'Not specified'}

KEY RESPONSIBILITIES:
${bulletList(content.keyResponsibilities)}

MUST HAVES:
${bulletList(content.mustHaves)}

${(content.goodToHaveLabel || 'GOOD TO HAVE').toUpperCase()}:
${bulletList(content.goodToHaves)}

SKILL/TECH TAGS: ${tags}`;
}

// ─── Helper: format current CTC breakdown for the prompt ─────────────────────
function formatCtc(candidate: Candidate): string {
  const parts: string[] = [];
  if (candidate.current_ctc_fixed != null) parts.push(`${candidate.current_ctc_fixed} Fixed`);
  if (candidate.current_ctc_variable != null) parts.push(`${candidate.current_ctc_variable} Variable`);
  if (candidate.current_esops != null) parts.push(`${candidate.current_esops} ESOPs`);
  return parts.length ? `${parts.join(' + ')} LPA` : 'Not specified';
}

// ─── Priority bucket derived from avgScore (for dashboard filtering/sorting) ──
export function priorityBucketFromScore(avgScore: number): 'Strong Fit' | 'Review' | 'Low Priority' | 'Reject' {
  if (avgScore >= 8) return 'Strong Fit';
  if (avgScore >= 6) return 'Review';
  if (avgScore >= 4) return 'Low Priority';
  return 'Reject';
}
