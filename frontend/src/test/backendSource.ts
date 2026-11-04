import fs from 'node:fs';

// The info markers quote numbers that the BACKEND decides: how many days past a Close Target turn a role red, how many hours
// an SLA window is, the 15% over-budget line, how long a sign-in lasts. The frontend keeps a copy of each figure
// (utils/columnInfo.ts), because the backend is a separate package and a separate deployment with no shared code. A test that
// compares that copy with another typed-in copy of the same digits can never fail when the backend changes. This module is
// the other half: it READS the backend's source files as text and pulls the figures out of their declarations, so the marker
// tests can compare what a screen says with what the backend really does (the same approach as backend/src/utils/
// crossPackageTwins.test.ts, from the other side).
//
// Nothing here imports from ../../../backend: the frontend's tsconfig covers only src/, and the backend needs a database to
// load. Each parser throws, with the file and the name it looked for, when a declaration has moved or changed shape, so a
// refactor of the backend makes the guard say so instead of quietly checking nothing.

// This file is <root>/frontend/src/test/backendSource.ts: drop its last four path segments. (Not `new URL('../../../', import.meta.url)`:
// Vite rewrites that exact pattern into an asset address, which is not a file path.)
const ROOT = decodeURIComponent(import.meta.url.replace(/^file:\/\//, '')).split('/').slice(0, -4).join('/') + '/';

export function readRepoFile(rel: string): string {
  const file = ROOT + rel;
  if (!fs.existsSync(file)) {
    throw new Error(`${rel} is missing: this guard compares the frontend's wording with the backend source, so it needs the whole repository checked out.`);
  }
  return fs.readFileSync(file, 'utf8');
}

function fail(rel: string, what: string): never {
  throw new Error(`${rel}: could not find ${what}. The declaration moved or changed shape, so this guard would have checked nothing; update src/test/backendSource.ts.`);
}

/** The value of `const NAME = 48;` or `const NAME = 3 * 60 * 1000;` (integers and decimals joined by `*`; exported or not). */
export function numberConst(rel: string, src: string, name: string): number {
  const m = new RegExp(`\\bconst\\s+${name}\\b[^=\\n]*=\\s*([0-9][0-9_.]*(?:\\s*\\*\\s*[0-9][0-9_.]*)*)\\s*;`).exec(src);
  if (!m) return fail(rel, `\`const ${name} = <number>;\``);
  return m[1].split('*').map(part => Number(part.trim().replace(/_/g, ''))).reduce((a, b) => a * b, 1);
}

/** The source of one function or block: from the first match of `start` up to the next match of `end` after it. */
export function slice(rel: string, src: string, start: RegExp, end: RegExp): string {
  const from = src.search(start);
  if (from < 0) return fail(rel, `the block starting at ${start}`);
  const rest = src.slice(from + 1);
  const to = rest.search(end);
  return to < 0 ? src.slice(from) : src.slice(from, from + 1 + to);
}

function firstNumber(rel: string, src: string, re: RegExp, what: string): number {
  const m = re.exec(src);
  if (!m) return fail(rel, what);
  return Number(m[1]);
}

export type AgingPriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface BackendFacts {
  /** types/index.ts AGING_THRESHOLDS: [yellow, red] days past the Close Target. */
  aging: Record<AgingPriority, [number, number]>;
  /** utils/aging.ts: a role turns yellow or red AT the threshold (>=), not after it. */
  agingStartsAtThreshold: boolean;
  slaStandardHours: number;
  slaIdleHours: number;
  slaHighScoreHours: number;
  slaHighScoreFit: number;
  /** jobs/slaChecker.ts tieredStandardHours: the shorter window applies at the threshold itself (>=). */
  slaHighScoreAtOrAbove: boolean;
  slaAssignmentFeedbackHours: number;
  slaEscalationHours: number;
  /** routes/interviews.ts: the assignment deadline is the send time plus this many hours. */
  slaAssignmentDeadlineHours: number;
  /** jobs/slaChecker.ts checkJoiningRisk: no HR contact for more than this many days. */
  joiningRiskDays: number;
  /** ... and the hours its pending action is stored with, which is what the Hiring Funnel Snapshot shows as "Overdue 5D". */
  joiningRiskStoredHours: number;
  /** routes/dashboard.ts: the red ! on an Aging role. */
  noMovementDays: number;
  /** ... and it fires only when the last movement is STRICTLY older than that (>), so the text says "more than". */
  noMovementIsStrict: boolean;
  /** routes/dashboard.ts: the SLA sweep runs at most once per this many minutes (per server). */
  slaCheckThrottleMinutes: number;
  /** routes/auth.ts: the default lifetime of a sign-in token, in hours. */
  sessionHours: number;
  /** utils/budget.ts: the multiplier on the top of the CTC band. */
  overBudgetTolerance: number;
  /** ... and a candidate AT band top x tolerance already needs a reason to be shortlisted (>=), which is why the text says "15% or more". */
  severeOverBudgetAtOrAbove: boolean;
  /** utils/lowPipeline.ts. */
  lowPipelineMaxShortlisted: number;
  lowPipelineMaxActive: number;
  /** routes/dashboard.ts: the Active-candidate fit-score bands counted on the Roles Snapshot tile. */
  fitHighCount: number;
  fitLowCount: number;
  /** routes/dashboard.ts: the Sourcing tile's "done on time" window, in days. */
  sourcingDoneWindowDays: number;
}

let cached: BackendFacts | null = null;

export function backendFacts(): BackendFacts {
  if (cached) return cached;

  const types = 'backend/src/types/index.ts';
  const typesSrc = readRepoFile(types);
  const agingBlock = slice(types, typesSrc, /export const AGING_THRESHOLDS\b/, /\};/);
  const aging = {} as Record<AgingPriority, [number, number]>;
  for (const m of agingBlock.matchAll(/(P[0-3]):\s*\{\s*yellow:\s*(\d+),\s*red:\s*(\d+)\s*\}/g)) aging[m[1] as AgingPriority] = [Number(m[2]), Number(m[3])];
  if (Object.keys(aging).length !== 4) fail(types, 'the four P0 to P3 rows of AGING_THRESHOLDS');

  const agingFile = 'backend/src/utils/aging.ts';
  const agingSrc = readRepoFile(agingFile);
  if (!/daysPastTarget\s*[<>]=?\s*thresh\.red/.test(agingSrc)) fail(agingFile, 'the daysPastTarget comparison with thresh.red / thresh.yellow');

  const sla = 'backend/src/jobs/slaChecker.ts';
  const slaSrc = readRepoFile(sla);
  const tiered = slice(sla, slaSrc, /export function tieredStandardHours\b/, /\n\}/);
  const joining = slice(sla, slaSrc, /async function checkJoiningRisk\b/, /\n\}\n/);

  const dash = 'backend/src/routes/dashboard.ts';
  const dashSrc = readRepoFile(dash);
  const noMovementCompare = /\)\s*(>=?)\s*NO_MOVEMENT_DAYS\s*\*\s*86400000/.exec(dashSrc);
  if (!noMovementCompare) fail(dash, 'the `> NO_MOVEMENT_DAYS * 86400000` comparison');

  const interviews = 'backend/src/routes/interviews.ts';
  const auth = 'backend/src/routes/auth.ts';
  const budget = 'backend/src/utils/budget.ts';
  const budgetSrc = readRepoFile(budget);
  const lowPipeline = 'backend/src/utils/lowPipeline.ts';
  const lowSrc = readRepoFile(lowPipeline);

  cached = {
    aging,
    agingStartsAtThreshold: /daysPastTarget\s*>=\s*thresh\.red\s*\?\s*'red'\s*:\s*daysPastTarget\s*>=\s*thresh\.yellow/.test(agingSrc),
    slaStandardHours: numberConst(sla, slaSrc, 'BREACH_STANDARD_HOURS'),
    slaIdleHours: numberConst(sla, slaSrc, 'BREACH_IDLE_HOURS'),
    slaHighScoreHours: numberConst(sla, slaSrc, 'BREACH_HIGH_SCORE_HOURS'),
    slaHighScoreFit: numberConst(sla, slaSrc, 'HIGH_SCORE_THRESHOLD'),
    slaHighScoreAtOrAbove: /aiFitScore\s*>=\s*HIGH_SCORE_THRESHOLD/.test(tiered),
    slaAssignmentFeedbackHours: numberConst(sla, slaSrc, 'BREACH_ASSIGNMENT_FEEDBACK_HOURS'),
    slaEscalationHours: numberConst(sla, slaSrc, 'LEADERSHIP_ESCALATION_HOURS'),
    slaAssignmentDeadlineHours: firstNumber(interviews, readRepoFile(interviews), /new Date\(Date\.now\(\)\s*\+\s*60\s*\*\s*60\s*\*\s*1000\s*\*\s*(\d+)\)/, 'the assignment deadline (`Date.now() + 60 * 60 * 1000 * <hours>`)'),
    joiningRiskDays: firstNumber(sla, joining, /INTERVAL\s*'(\d+)\s*days'/, "`INTERVAL '<n> days'` in checkJoiningRisk"),
    joiningRiskStoredHours: firstNumber(sla, joining, /\$3,\s*(\d+),\s*\$4\)/, 'the hours_overdue value stored for the joining-risk action'),
    noMovementDays: numberConst(dash, dashSrc, 'NO_MOVEMENT_DAYS'),
    noMovementIsStrict: noMovementCompare![1] === '>',
    slaCheckThrottleMinutes: numberConst(dash, dashSrc, 'SLA_CHECK_THROTTLE_MS') / 60000,
    sessionHours: firstNumber(auth, readRepoFile(auth), /JWT_EXPIRES_IN\s*\|\|\s*'(\d+)h'/, "the `JWT_EXPIRES_IN || '<n>h'` default"),
    overBudgetTolerance: numberConst(budget, budgetSrc, 'OVER_BUDGET_TOLERANCE'),
    severeOverBudgetAtOrAbove: /expectedCtc\s*>=\s*max\s*\*\s*OVER_BUDGET_TOLERANCE/.test(slice(budget, budgetSrc, /export function isSeverelyOverBudget\b/, /\n\}/)),
    lowPipelineMaxShortlisted: numberConst(lowPipeline, lowSrc, 'LOW_PIPELINE_MAX_SHORTLISTED'),
    lowPipelineMaxActive: numberConst(lowPipeline, lowSrc, 'LOW_PIPELINE_MAX_ACTIVE'),
    fitHighCount: firstNumber(dash, dashSrc, /FILTER \(WHERE ai_fit_score >= (\d+)\) AS score_ge_75/, 'the `ai_fit_score >= <n>` count behind score_ge_75'),
    fitLowCount: firstNumber(dash, dashSrc, /FILTER \(WHERE ai_fit_score <= (\d+)\) AS score_le_45/, 'the `ai_fit_score <= <n>` count behind score_le_45'),
    sourcingDoneWindowDays: firstNumber(dash, dashSrc, /l\.done_at >= NOW\(\) - INTERVAL '(\d+) days'/, "the `l.done_at >= NOW() - INTERVAL '<n> days'` window"),
  };
  return cached;
}

/** The sentence fragment the markers use for one priority's aging thresholds, built from the backend's numbers. */
export function agingPhrase(facts: BackendFacts): string {
  const parts = (Object.entries(facts.aging) as Array<[AgingPriority, [number, number]]>).map(([p, [y, r]]) => `${y} and ${r} days (${p})`);
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

/** The over-budget margin as the markers write it: 1.15 is "15%". */
export function overBudgetPercent(facts: BackendFacts): number {
  return Math.round((facts.overBudgetTolerance - 1) * 100);
}
