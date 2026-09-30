import {
  CriterionResult, CriterionVerdict, PortfolioPlatform, PortfolioReviewed, PortfolioSignals,
} from './types.js';

// ─── The hiring manager's 15 criteria for Senior UX/Product Designer ─────────
// `description` is what the model is told to look for; `label` is the short
// form shown in the UI. Two are partly deterministic (see below) — the model
// still sees them, but its verdict is overridden/capped by hard evidence.
export interface CriterionDef { id: string; label: string; description: string }

export const DESIGNER_CRITERIA: readonly CriterionDef[] = [
  { id: 'ownership', label: 'Owned a product / major feature',
    description: 'Evidence of FULL ownership of a new product or a major feature end to end (not just contributing screens to someone else\'s project).' },
  { id: 'leadership', label: 'Led junior designers / UX strategy',
    description: 'Evidence of leading or mentoring junior designers and guiding UI/UX strategy.' },
  { id: 'storytelling', label: 'Storytelling & process',
    description: 'Good storytelling: the business problem, the research methods used, and the path from problem to insights to solution — not just a gallery of final screens.' },
  { id: 'field_research', label: 'User-centric discovery',
    description: 'Discovery driven by real users, not purely stakeholder conversations — e.g. site/field visits, contextual inquiry, interviews with end users; "gets out of the office".' },
  { id: 'complexity', label: 'Cuts through complexity',
    description: 'Examples of cutting through complexity with design innovation (simplifying a hard workflow, dense data, or a multi-role system).' },
  { id: 'ai_research_proto', label: 'AI in research / prototyping',
    description: 'Evidence of embracing AI in research and prototyping (e.g. LLM-assisted synthesis, Figma AI, v0, generative UI, AI-built prototypes).' },
  { id: 'portfolio_ux', label: 'Portfolio site UX quality',
    description: 'Thinks about the user of their own portfolio website: no broken links, no difficult navigation, no strange display artifacts, works on mobile.' },
  { id: 'html_based', label: 'HTML-based portfolio',
    description: 'Prefer a real HTML website over a portfolio living inside Figma, a PDF, or a constrained simple builder such as Behance.' },
  { id: 'business_outcomes', label: 'Business outcomes',
    description: 'Can speak to business outcomes driven by their design (metrics, adoption, revenue, cost, time saved).' },
  { id: 'research_insights', label: 'Research-driven insights',
    description: 'Can speak to insights that came out of their research, and how those changed the design.' },
  { id: 'pattern_thinking', label: 'Beyond standard patterns',
    description: 'Thinks outside the box of commonly used patterns while still showing consideration for the common patterns their persona or audience expects.' },
  { id: 'design_system', label: 'Design / component library',
    description: 'Experience creating and/or maintaining a design or component library; modular approach (atoms/molecules/compounds or similar); tokens and specs.' },
  { id: 'breadth', label: 'Beyond UI/UX',
    description: 'Experience beyond UI/UX: illustration, animation or micro-animation, video, graphic design, landing pages, print media, brand collateral.' },
  { id: 'ai_currency', label: 'Keeps up with AI',
    description: 'Keeps up to date with, and experiments with, the latest AI developments (visible experiments, writing, side projects, tools used).' },
  { id: 'product_thinking', label: 'Product thinking',
    description: 'Has demonstrated or declared "product thinking": uncovering functional requirements from user pains and needs rather than only styling screens.' },
] as const;

export const CRITERION_IDS: ReadonlySet<string> = new Set(DESIGNER_CRITERIA.map(c => c.id));
const LABEL_BY_ID = new Map(DESIGNER_CRITERIA.map(c => [c.id, c.label]));

const VERDICTS: ReadonlySet<string> = new Set(['strong', 'partial', 'not_evidenced', 'concern']);

// ─── Deterministic checks ────────────────────────────────────────────────────
// html_based is a property of WHERE the portfolio lives, not of its content,
// so it is decided from the platform rather than asked of the model.
const HTML_VERDICT: Record<PortfolioPlatform, { verdict: CriterionVerdict; why: string }> = {
  custom:          { verdict: 'strong',  why: 'Own-domain website' },
  framer:          { verdict: 'strong',  why: 'Published Framer site (real HTML, fully custom design)' },
  webflow:         { verdict: 'strong',  why: 'Webflow site (real HTML, fully custom design)' },
  figma_site:      { verdict: 'partial', why: 'Figma Sites site (HTML, but tied to the Figma toolchain)' },
  wix:             { verdict: 'partial', why: 'Wix template site (constrained builder)' },
  squarespace:     { verdict: 'partial', why: 'Squarespace template site (constrained builder)' },
  carrd:           { verdict: 'partial', why: 'Carrd one-page template (constrained builder)' },
  cargo:           { verdict: 'partial', why: 'Cargo template site (constrained builder)' },
  adobe_portfolio: { verdict: 'partial', why: 'Adobe Portfolio template (constrained builder)' },
  behance:         { verdict: 'concern', why: 'Behance profile (constrained gallery builder)' },
  dribbble:        { verdict: 'concern', why: 'Dribbble shots (gallery, not a portfolio site)' },
  notion:          { verdict: 'concern', why: 'Notion page (document, not a designed site)' },
  figma_file:      { verdict: 'concern', why: 'Figma file/prototype link (not an HTML site)' },
  google_slides:   { verdict: 'concern', why: 'Slide deck (not an HTML site)' },
  pdf_file:        { verdict: 'concern', why: 'PDF / file link (not an HTML site)' },
};
const VERDICT_ORDER: CriterionVerdict[] = ['concern', 'not_evidenced', 'partial', 'strong'];

export function htmlBasedFromPlatforms(platforms: PortfolioPlatform[]): { verdict: CriterionVerdict; evidence: string } {
  if (!platforms.length) return { verdict: 'not_evidenced', evidence: 'No portfolio site reviewed' };
  // Best portfolio wins: one real HTML site is enough to satisfy the preference.
  const best = platforms
    .map(p => HTML_VERDICT[p] ?? HTML_VERDICT.custom)
    .sort((a, b) => VERDICT_ORDER.indexOf(b.verdict) - VERDICT_ORDER.indexOf(a.verdict))[0];
  return { verdict: best.verdict, evidence: best.why };
}

/** Caps the portfolio_ux verdict using hard measurements, whatever the model said. */
export function capPortfolioUxVerdict(
  modelVerdict: CriterionVerdict, signals: PortfolioSignals[],
): { verdict: CriterionVerdict; note: string } {
  const broken = signals.reduce((n, s) => n + s.brokenLinks, 0);
  const checked = signals.reduce((n, s) => n + s.brokenLinksChecked, 0);
  const overflow = signals.some(s => s.mobileOverflow === true);
  const notes: string[] = [];
  let cap: CriterionVerdict = 'strong';
  if (broken >= 1) { cap = minVerdict(cap, 'partial'); notes.push(`${broken} of ${checked} checked links broken`); }
  if (broken >= 5 || (checked >= 5 && broken / checked >= 0.4)) cap = minVerdict(cap, 'concern');
  if (overflow) { cap = minVerdict(cap, 'partial'); notes.push('horizontal overflow on mobile width'); }
  return { verdict: minVerdict(modelVerdict, cap), note: notes.join('; ') };
}

function minVerdict(a: CriterionVerdict, b: CriterionVerdict): CriterionVerdict {
  // not_evidenced sits between concern and partial for capping purposes.
  return VERDICT_ORDER.indexOf(a) <= VERDICT_ORDER.indexOf(b) ? a : b;
}

// ─── Model-output validation ─────────────────────────────────────────────────
function clip(s: unknown, n: number): string {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '';
}
function asVerdict(v: unknown): CriterionVerdict {
  return typeof v === 'string' && VERDICTS.has(v) ? (v as CriterionVerdict) : 'not_evidenced';
}

export interface RawModelOutput {
  portfolios?:  Array<{ url?: unknown; isPortfolio?: unknown; belongsToCandidate?: unknown; attemptsToInfluenceReviewer?: unknown; note?: unknown }>;
  criteria?:    Array<{ id?: unknown; verdict?: unknown; evidence?: unknown }>;
  jdAlignment?: {
    mustHaves?:   Array<{ item?: unknown; verdict?: unknown; evidence?: unknown }>;
    niceToHaves?: Array<{ item?: unknown; verdict?: unknown; evidence?: unknown }>;
  };
  portfolioScore?: unknown;
  scoreNote?:      unknown;
  highlights?:     unknown;
  redFlags?:       unknown;
  summary?:        unknown;
}

/** Every one of the 15 criteria is always present, in canonical order. */
export function normalizeCriteria(raw: RawModelOutput['criteria']): CriterionResult[] {
  const byId = new Map<string, { verdict: CriterionVerdict; evidence: string }>();
  for (const c of raw || []) {
    if (typeof c?.id === 'string' && CRITERION_IDS.has(c.id) && !byId.has(c.id)) {
      byId.set(c.id, { verdict: asVerdict(c.verdict), evidence: clip(c.evidence, 220) });
    }
  }
  return DESIGNER_CRITERIA.map(def => {
    const hit = byId.get(def.id);
    return {
      id: def.id, label: def.label,
      verdict: hit?.verdict ?? 'not_evidenced',
      evidence: hit?.evidence || (hit ? '' : 'Not assessed by the reviewer'),
    };
  });
}

export function normalizeAlignment(
  raw: Array<{ item?: unknown; verdict?: unknown; evidence?: unknown }> | undefined,
): Array<{ item: string; verdict: CriterionVerdict; evidence: string }> {
  return (raw || []).slice(0, 12)
    .map(r => ({ item: clip(r?.item, 140), verdict: asVerdict(r?.verdict), evidence: clip(r?.evidence, 200) }))
    .filter(r => r.item);
}

export function clampScore(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, Math.round(n)));
}

export function stringList(v: unknown, maxItems: number, maxLen: number): string[] {
  return Array.isArray(v) ? v.map(x => clip(x, maxLen)).filter(Boolean).slice(0, maxItems) : [];
}

// ─── Score ───────────────────────────────────────────────────────────────────
const VERDICT_VALUE: Record<CriterionVerdict, number> = { strong: 1, partial: 0.6, not_evidenced: 0.2, concern: 0 };

/** 0-10 from how much of the checklist is evidenced. */
export function checklistScore(criteria: CriterionResult[]): number {
  if (!criteria.length) return 0;
  const mean = criteria.reduce((s, c) => s + VERDICT_VALUE[c.verdict], 0) / criteria.length;
  return Math.round(mean * 10);
}

/**
 * The 9th ResumeIQ dimension. An LLM's holistic 0-10 is noisy from run to run;
 * the checklist coverage is stable but blind to overall craft. Averaging the
 * two keeps rankings steadier without ignoring either signal.
 */
export function blendPortfolioScore(modelScore: number, checklist: number): number {
  return Math.max(0, Math.min(10, Math.round((modelScore + checklist) / 2)));
}

export function labelFor(id: string): string { return LABEL_BY_ID.get(id) ?? id; }

/** avg over the 8 base dimensions, plus the portfolio score when present. */
export function computeAvg(baseScores: number[], portfolio?: number | null): number {
  const all = portfolio == null ? baseScores : [...baseScores, portfolio];
  if (!all.length) return 0;
  return Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10;
}

export type { PortfolioReviewed };
