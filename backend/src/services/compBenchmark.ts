import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/index.js';
import { Role } from '../types/index.js';

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

// Item #26, corrected: this is a per-ROLE benchmark, not per-candidate —
// housed on Role Detail, not Candidate Detail. comp_benchmarks (grounding)
// is checked first, matched by role.title against role_category and, when
// multiple experience_range rows exist for that category, by overlap
// against the ROLE's own yoe_required range (not a specific candidate's
// YOE, since there is no candidate in this context anymore). Claude's
// general market knowledge is only used as a fallback when no internal row
// exists at all for this role — the explicit ordering confirmed for #26,
// not a stylistic choice.
export async function getCompBenchmark(role: Role): Promise<CompBenchmarkResult> {
  const rows = await query<CompBenchmarkRow>(
    'SELECT * FROM comp_benchmarks WHERE role_category = $1 ORDER BY experience_range',
    [role.title]
  );

  const roleRange = role.yoe_required ? parseRangeBounds(role.yoe_required) : { min: null, max: null };

  let match = (roleRange.min != null && roleRange.max != null)
    ? rows.find(r => {
        const { min, max } = parseRangeBounds(r.experience_range);
        // Overlap, not containment — a role wanting "5-8 years" should
        // still match a benchmark row scoped to "5-7 years" rather than
        // falling through to an AI guess over one year of difference.
        return min != null && max != null && min <= roleRange.max! && max >= roleRange.min!;
      })
    : undefined;
  // No overlapping experience_range — still grounded data, just the
  // closest row on file for this role, rather than dropping to an AI guess
  // when DigitalPaani has actually already benchmarked this role category.
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

No internal DigitalPaani benchmark exists for this role. Estimate a realistic compensation
range (INR LPA) for a mid-size, well-funded Indian startup/scaleup hiring for this role.
Return ONLY valid JSON, no markdown, no code fences:
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
