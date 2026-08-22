import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/index.js';
import { Role, Candidate } from '../types/index.js';

const client = new Anthropic();

interface CompBenchmarkRow {
  id:                 string;
  role_category:      string;
  experience_range:   string;
  internal_band_min:  number | null;
  internal_band_max:  number | null;
  market_band_min:    number | null;
  market_band_max:    number | null;
  currency:           string;
  notes:              string | null;
}

export interface CompBenchmarkResult {
  source:        'internal_data' | 'ai_estimate';
  range_min:     number;
  range_max:     number;
  currency:      string;
  rationale:     string;
  benchmark_id?: string;
}

function parseRangeBounds(range: string): { min: number | null; max: number | null } {
  const nums = range.match(/\d+(\.\d+)?/g)?.map(Number);
  if (!nums?.length) return { min: null, max: null };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

// comp_benchmarks (grounding) first, Claude's general market knowledge only
// when no usable internal row exists for this role — the explicit ordering
// confirmed for item #26, not a stylistic choice.
export async function getCompBenchmark(role: Role, candidate: Candidate): Promise<CompBenchmarkResult> {
  const rows = await query<CompBenchmarkRow>(
    'SELECT * FROM comp_benchmarks WHERE role_category = $1 ORDER BY experience_range',
    [role.title]
  );

  const yoe = candidate.years_of_experience ?? candidate.parsed_total_yoe ?? null;

  let match = yoe != null
    ? rows.find(r => {
        const { min, max } = parseRangeBounds(r.experience_range);
        return min != null && max != null && yoe >= min && yoe <= max;
      })
    : undefined;
  // No exact experience-range match — still grounded data, just the closest
  // row on file for this role, rather than dropping to an AI guess when
  // DigitalPaani has actually already benchmarked this role category.
  if (!match && rows.length > 0) match = rows[0];

  if (match) {
    const min = match.internal_band_min ?? match.market_band_min;
    const max = match.internal_band_max ?? match.market_band_max;
    if (min != null && max != null) {
      return {
        source: 'internal_data',
        range_min: Number(min),
        range_max: Number(max),
        currency: match.currency,
        rationale: `Based on internal benchmark ${match.id} (${match.role_category}, ${match.experience_range})${match.notes ? ` — ${match.notes}` : ''}.`,
        benchmark_id: match.id,
      };
    }
  }

  const prompt = `You are a compensation analyst for DigitalPaani, a water-tech AI company based in India. All compensation is in INR LPA.

ROLE: ${role.title}
DEPARTMENT: ${role.department || 'Not specified'}
EXPERIENCE REQUIRED: ${role.yoe_required || 'Not specified'}
MUST-HAVE SKILLS: ${role.must_have_skills || 'Not specified'}
KEY RESPONSIBILITIES: ${role.kpi_expectations || 'Not specified'}

CANDIDATE:
Years of Experience: ${yoe ?? 'Not specified'}
Current Industry: ${candidate.current_industry || 'Not specified'}
Current Designation: ${candidate.current_designation || 'Not specified'}

No internal DigitalPaani benchmark exists for this role. Estimate a realistic compensation
range (INR LPA) for a mid-size, well-funded Indian startup/scaleup hiring for this role and
candidate profile. Return ONLY valid JSON, no markdown, no code fences:
{"range_min": 0, "range_max": 0, "rationale": ""}

Rules: range_min/range_max are plain numbers in LPA (range_max > range_min). rationale is 1-2
sentences explaining the estimate.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  const rawText = textBlock && 'text' in textBlock ? textBlock.text : '{}';
  const cleaned = rawText.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned) as { range_min: number; range_max: number; rationale: string };

  return {
    source: 'ai_estimate',
    range_min: Number(parsed.range_min),
    range_max: Number(parsed.range_max),
    currency: 'LPA',
    rationale: parsed.rationale || 'AI-estimated range — no internal benchmark data available for this role.',
  };
}
