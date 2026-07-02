import Anthropic from '@anthropic-ai/sdk';
import { Candidate, Role } from '../types/index.js';

const client = new Anthropic();

interface ScoreBreakdown {
  skills: number;       // 0–50
  experience: number;   // 0–25
  industry: number;     // 0–15
  location: number;     // 0–10
}

interface ResumeIQResult {
  fit_score: number;
  priority_bucket: 'Strong Fit' | 'Review' | 'Low Priority' | 'Reject';
  score_breakdown: ScoreBreakdown;
  skills_matched: string[];
  missing_skills: string[];
  risk_flags: string[];
  eval_areas: string[];
  score_summary: string;
}

// ─── Main scoring function (Section 10.2) ────────────────────────────────────
export async function scoreCandidate(
  candidate: Candidate,
  role: Role,
  resumeText?: string
): Promise<ResumeIQResult> {

  // ── Rule-based scoring (no AI needed for this part) ──────────────────────
  const mustHaveSkills = (role.must_have_skills || '')
    .split(/[;,]/).map(s => s.trim().toLowerCase()).filter(Boolean);

  const candidateSkills = (candidate.parsed_skills || []).map(s => s.toLowerCase());

  // Skills (50 pts) — matched/uncertain/missing
  let skillsScore = 0;
  const skillsMatched: string[] = [];
  const missingSkills: string[] = [];

  for (const skill of mustHaveSkills) {
    const confirmed = candidateSkills.some(cs => cs.includes(skill) || skill.includes(cs));
    const uncertain = !confirmed && (resumeText || '').toLowerCase().includes(skill);
    if (confirmed) {
      skillsScore += 50 / mustHaveSkills.length;
      skillsMatched.push(skill);
    } else if (uncertain) {
      skillsScore += (50 / mustHaveSkills.length) * 0.5;
      skillsMatched.push(`${skill} (uncertain)`);
    } else {
      missingSkills.push(skill);
    }
  }
  skillsScore = Math.round(Math.min(50, skillsScore));

  // Experience (25 pts)
  let experienceScore = 0;
  if (candidate.parsed_total_yoe != null) {
    const yoeText = role.yoe_required || '';
    const match = yoeText.match(/(\d+)[\s-]*(?:to|\+)?[\s-]*(\d+)?/);
    if (match) {
      const min = parseFloat(match[1]);
      const max = match[2] ? parseFloat(match[2]) : min + 3;
      const yoe = candidate.parsed_total_yoe;
      if (yoe >= min && yoe <= max) experienceScore = 25;
      else if (Math.abs(yoe - min) <= 1 || Math.abs(yoe - max) <= 1) experienceScore = 15;
      else if (Math.abs(yoe - min) <= 2 || Math.abs(yoe - max) <= 2) experienceScore = 8;
    }
  }

  // Industry (15 pts)
  const dpIndustries = ['water treatment','industrial automation','iot','environmental',
    'saas','tech','wastewater','etp','stp','wtp'];
  const adjacentIndustries = ['construction','utilities','industrial','infrastructure',
    'manufacturing','energy','environment'];

  const candidateIndustries = (candidate.parsed_industries || []).map(i => i.toLowerCase());
  const industryText = candidateIndustries.join(' ');

  let industryScore = 7; // neutral default
  if (dpIndustries.some(di => industryText.includes(di))) industryScore = 15;
  else if (adjacentIndustries.some(ai => industryText.includes(ai))) industryScore = 8;

  // Location (10 pts)
  const roleLocation = (role.location || '').toLowerCase();
  const candLocation = (candidate.parsed_skills ? '' : '').toLowerCase(); // use current_location from application
  let locationScore = 5; // neutral
  if (roleLocation && candLocation) {
    if (candLocation.includes(roleLocation.split('/')[0]) || roleLocation.includes(candLocation)) {
      locationScore = 10;
    }
  }

  const totalScore = skillsScore + experienceScore + industryScore + locationScore;

  // Risk flags
  const riskFlags: string[] = [];
  if (candidate.job_stability_months && candidate.job_stability_months < 18) {
    riskFlags.push('Short average tenure (<18 months)');
  }
  if (missingSkills.length > mustHaveSkills.length / 2) {
    riskFlags.push('Missing >50% of mandatory skills');
  }

  // Priority bucket
  const bucket = totalScore >= 75 ? 'Strong Fit'
    : totalScore >= 50 ? 'Review'
    : totalScore >= 25 ? 'Low Priority'
    : 'Reject';

  // ── AI: generate summary and eval areas ──────────────────────────────────
  let scoreSummary = '';
  let evalAreas: string[] = [];

  try {
    const prompt = `You are a recruitment AI evaluating a candidate for a ${role.title} role at DigitalPaani.

Candidate profile:
- Total experience: ${candidate.parsed_total_yoe ?? 'unknown'} years
- Skills: ${candidateSkills.join(', ') || 'not parsed'}
- Industries: ${(candidate.parsed_industries || []).join(', ') || 'not parsed'}
- Education: ${candidate.parsed_education || 'not parsed'}
- Job stability: ${candidate.job_stability_months ? `${candidate.job_stability_months} months avg tenure` : 'unknown'}

Role requirements:
- Must-have skills: ${role.must_have_skills}
- KPI expectations: ${role.kpi_expectations || 'not specified'}

Scoring result: ${totalScore}/100 (${bucket})
- Skills: ${skillsScore}/50 | Skills matched: ${skillsMatched.join(', ')} | Missing: ${missingSkills.join(', ')}
- Experience: ${experienceScore}/25
- Industry: ${industryScore}/15
- Location: ${locationScore}/10
- Risk flags: ${riskFlags.join(', ') || 'none'}

Respond with a JSON object only (no markdown, no explanation outside JSON):
{
  "summary": "2-3 sentence plain-English explanation of this score",
  "eval_areas": ["3-5 evaluation areas to probe in interviews, as strings"]
}`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    scoreSummary = parsed.summary || '';
    evalAreas = parsed.eval_areas || [];
  } catch {
    scoreSummary = `${bucket} with ${totalScore}/100. Skills match: ${skillsMatched.length}/${mustHaveSkills.length} mandatory skills.`;
    evalAreas = missingSkills.slice(0, 3).map(s => `Probe ${s} depth and context`);
  }

  return {
    fit_score:       totalScore,
    priority_bucket: bucket,
    score_breakdown: {
      skills:     skillsScore,
      experience: experienceScore,
      industry:   industryScore,
      location:   locationScore,
    },
    skills_matched:  skillsMatched,
    missing_skills:  missingSkills,
    risk_flags:      riskFlags,
    eval_areas:      evalAreas,
    score_summary:   scoreSummary,
  };
}
