// LIGHT — pure functions, no I/O, safe to import from the main API. The Head of Marketing & Creative Direction
// (R019) work-sample rubric: the criteria the model judges against, and every rule that turns the model's raw JSON
// into a score we are willing to stand behind. The model's output is never trusted as it comes: ids and verdicts are
// validated, every verdict has to cite a source we really gave it (and is downgraded when the evidence is weaker than
// the verdict claims), and a handful of hard caps sit on top. The checklist and the blend are this module's own maths
// (single rounding, attribution counted once, claims never earning points); the verdict values come from the designer
// review's table (rubric.ts) so both kinds stay on one scale.
import { CriterionResult, CriterionVerdict } from './types.js';
import { checklistScore, clampScore, stringList } from './rubric.js';

export type EvidenceBasis = 'seen' | 'read' | 'claimed' | 'none';

export interface MarketingCriterionDef {
  id: string;
  /** Short form shown in the UI. */
  label: string;
  /** What the model is told to judge by, including what strong / partial / not_evidenced mean for this criterion. */
  description: string;
  /**
   * direct = a portfolio can show it. corroboration = a portfolio rarely proves it (and the 8 base ResumeIQ dimensions
   * already score it), so it is counted ONLY when strong. quality = how good / attributable the evidence is.
   */
  group: 'direct' | 'corroboration' | 'quality';
  weight: number;
}

// ─── R019's requirements as checklist criteria ───────────────────────────────
// mh1..mh10 are the role's ten must-haves (worded from the full requirement list, not the 8-bullet-truncated JD
// content); eq_* judge the quality of the evidence itself. Verdicts: strong | partial | not_evidenced | concern.
// Absence of evidence is ALWAYS not_evidenced, never concern.
//
// WHO DID THE WORK is judged in exactly one place, eq_ownership: the mh* descriptions say nothing about attribution,
// so a candidate whose work sits on an employer or client page with no credit line is not marked down four times for
// the same missing fact (and the work scores the same wherever it is hosted). Weights: direct 5.25, quality 4.0,
// corroboration 0.5 each (counted only when strong).
export const MARKETING_CRITERIA: readonly MarketingCriterionDef[] = [
  { id: 'mh1', label: 'Built a brand from scratch', group: 'direct', weight: 1.0,
    description: 'Built a brand from scratch at a startup or early-stage scaleup: created the narrative, visual identity and positioning from zero (did not inherit an established brand). strong = a launch, naming or identity story shown for an early-stage brand, in enough detail to see it was built rather than inherited; partial = early-stage brand work is visible but "from zero" is unclear; not_evidenced = nothing shown. Work on a mature or inherited brand does not count. Who did the work is judged only by the personal-role criterion (eq_ownership), not here.' },
  { id: 'mh2', label: 'Led a creative team', group: 'corroboration', weight: 0.5,
    description: 'Led a creative team of at least 1-3 people (designers, writers, videographers): clear creative direction, constructive critique, team culture, a track record of getting great work out of creative people. strong = a named credit or an artifact showing the candidate directed other creatives; partial = leadership of creatives is plausible but only stated or implied; not_evidenced = nothing shown (a portfolio rarely proves this).' },
  { id: 'mh3', label: 'Launched 5+ campaigns', group: 'direct', weight: 1.5,
    description: 'Launched 5+ campaigns that moved metrics or generated real traction (not internal projects), with measurable results (leads, brand lift, reach, conversions, engagement) and the full lifecycle from concept to execution. strong = at least 5 distinct campaigns shown, each from concept through execution; partial = 3-4 such campaigns, or 5+ where the lifecycle is shown for only some; not_evidenced = fewer than 3 or none shown. Count a campaign once however many pieces it has. Whose work it was is judged only by the personal-role criterion (eq_ownership), not here.' },
  { id: 'mh4', label: 'Copy across formats', group: 'direct', weight: 1.0,
    description: 'Writes excellent copy across multiple formats (social posts, long-form articles, video scripts, email campaigns, landing pages) and adapts voice and tone to platform, audience and stakeholder level; not a one-format specialist. strong = good writing seen in 3 or more different formats; partial = good writing in one or two formats; not_evidenced = no copy shown. Judge the writing itself, from text you actually read.' },
  { id: 'mh5', label: 'Visual concepts & craft', group: 'direct', weight: 1.0,
    description: 'Creates visual concepts and mockups independently (Figma/Adobe) and communicates visual direction: composition, colour and hierarchy; can execute, not just conceive. strong = visual work shown with sound composition, colour and hierarchy; partial = visuals shown but the craft is only moderate, or only some of the pieces seen show it; not_evidenced = no visual work shown. Whether the candidate or a designer on the team made it is judged only by the personal-role criterion (eq_ownership), not here. Judge from images or pages actually seen, never from titles or thumbnails alone.' },
  { id: 'mh6', label: 'Platform & distribution', group: 'direct', weight: 0.75,
    description: 'Understands how to reach people at scale: social platform dynamics (algorithm, distribution, engagement drivers), choosing the platform for the goal, what drives virality, distribution strategy. strong = the work shows platform-native adaptation or a stated distribution approach together with reach or engagement evidence; partial = digital or social work is shown without evidence of distribution thinking; not_evidenced = nothing shown.' },
  { id: 'mh7', label: 'Worked within constraints', group: 'corroboration', weight: 0.5,
    description: 'Has operated with limited resources: tight budgets, small teams, constrained timelines; a scrappy problem-solver. strong = work that states the constraint (budget, team size, deadline) and what was achieved within it; partial = scrappy or low-budget execution is plausible but the constraint is not stated; not_evidenced = nothing shown.' },
  { id: 'mh8', label: 'Mission-driven work', group: 'corroboration', weight: 0.5,
    description: 'Genuine passion for mission-driven work: chose climate, water, environmental or social-good problems and is motivated by the mission rather than title or compensation. strong = a sustained record of impact-sector work shown, not a single one-off; partial = some mission-led pieces; not_evidenced = none. Mission relevance never lifts a weak portfolio.' },
  { id: 'mh9', label: 'Pitches creative vision', group: 'corroboration', weight: 0.5,
    description: 'Can pitch and sell a creative vision: presents to leadership and stakeholders, defends creative choices, convinces decision-makers; senior stakeholder experience. strong = a pitch or strategy deck, or a stated senior-stakeholder outcome that the candidate owned; partial = a deck or case study that implies stakeholder buy-in; not_evidenced = nothing shown.' },
  { id: 'mh10', label: 'Startup operating experience', group: 'corroboration', weight: 0.5,
    description: 'Has startup operating experience: fast-moving environments, multiple roles, ambiguity, prioritisation under pressure. strong = work shown at a named early-stage company in more than one capacity; partial = a startup context is visible but the breadth of the role is unclear; not_evidenced = nothing shown.' },
  { id: 'eq_ownership', label: 'Personal role shown', group: 'quality', weight: 1.0,
    description: 'Is the candidate\'s own role in the work evidenced? This is the ONLY criterion that judges who did the work. strong = a named credit or an explicit first-person role statement; partial = it is plausible the candidate did the work but their role is not stated; not_evidenced = the work cannot be attributed to anyone (a bare employer or client brand page is unattributed: that is neutral, and absence of attribution is NEVER a concern); concern = a DIFFERENT full personal name (a first and a last name) is credited as the creator, owner or lead of the work AND [candidate] does not appear in the credits you can read (quote that credit line word for word), or the work contradicts the candidate\'s own claim (quote both). A team list, an agency or studio page, an employer\'s or client\'s brand page, a missing credit, and a credit you can see only inside an image are never a concern.' },
  { id: 'eq_outcomes', label: 'Results with numbers', group: 'quality', weight: 1.0,
    description: 'Stated results with a baseline or clear attribution (leads, conversions, reach, revenue, growth from X to Y over a period). strong = numeric results with a baseline or timeframe, attributed to the candidate\'s work; partial = numbers without a baseline or attribution, or qualitative results only; not_evidenced = no results stated. Judge only the quality of the stated numbers; do not re-count campaigns (that is the 5+ campaigns criterion).' },
  { id: 'eq_craft', label: 'Finish and polish', group: 'quality', weight: 1.0,
    description: 'The finish of the work itself: polish, attention to detail, professionalism of the artifacts seen. strong = consistently polished work seen directly; partial = mixed polish, or only part of the work was seen; not_evidenced = nothing seen. A title, thumbnail or description is not craft evidence, and a video that was not watched can be at most partial.' },
  { id: 'eq_coherence', label: 'Consistent visual & verbal voice', group: 'quality', weight: 0.5,
    description: 'Consistency of visual and verbal language across the pieces shown: a recognisable system rather than a collage of unrelated styles. Judge each brand or client separately: differing client styles in a multi-client portfolio are not a lack of coherence. strong = a clear, consistent system across several pieces; partial = consistent within one piece or a few; not_evidenced = a single piece or nothing seen.' },
  { id: 'eq_recency', label: 'Recent work', group: 'quality', weight: 0.5,
    description: 'Is the work recent, made in roughly the last 3 years? strong = most of the shown work is dated within the last 3 years; partial = a mix of recent and older work, or only older work; not_evidenced = nothing dated and no clue to its age. Undated work is never a concern.' },
];

// Accelerators: each strong one adds a small bonus on top of the blended score (see niceToHaveBonus).
export const MARKETING_NICE_TO_HAVES: readonly { id: string; label: string; description: string }[] = [
  { id: 'nh1', label: 'Climate / water / impact sector',
    description: 'Worked in climate, sustainability, water, environmental or nonprofit work, with relationships in the impact ecosystem. strong = impact-sector work shown that the candidate owned.' },
  { id: 'nh2', label: 'Influencer partnerships',
    description: 'Managed influencer or celebrity partnerships: identified, pitched, negotiated and managed them; understands influencer economics. strong = a partnership shown with the candidate\'s part in it.' },
  { id: 'nh3', label: 'Video production or direction',
    description: 'Can produce or direct video: shot, edited or directed it, and briefs videographers and editors. strong = video work shown that the candidate produced or directed.' },
  { id: 'nh4', label: 'Experiential activations & events',
    description: 'Designed and executed experiential activations or events: conceived memorable, on-brand experiences, not just the logistics. strong = an activation shown with the candidate\'s creative role in it.' },
  { id: 'nh5', label: 'Agency experience',
    description: 'Agency experience: multiple clients and projects, tight deadlines, polished work delivered at pace. strong = work for several clients shown.' },
  { id: 'nh6', label: 'B2B / enterprise marketing',
    description: 'B2B or enterprise marketing: sold to businesses, communicated value to executive decision-makers, made complex concepts simple. strong = B2B work shown that the candidate owned.' },
  { id: 'nh7', label: 'Founder / CEO experience',
    description: 'Founder or CEO experience: ran a business or P&L, made owner-like decisions, understands marketing\'s business impact. strong = a business they founded or ran is shown.' },
  { id: 'nh8', label: 'Analytics & performance data',
    description: 'Comfortable with analytics and performance data: dashboards, KPIs, course-correcting campaigns from the numbers. strong = a dashboard, report or a documented course-correction shown.' },
  { id: 'nh9', label: 'SEO / organic growth',
    description: 'SEO or organic growth expertise: content structured for search, organic distribution, growth mechanics. strong = organic or search results shown with the method.' },
  { id: 'nh10', label: 'Photography / art direction',
    description: 'Photography or art direction: directs shoots or executes photography with an aesthetic eye. strong = shot or art-directed imagery shown that the candidate made.' },
];

const DEF_BY_ID = new Map(MARKETING_CRITERIA.map(c => [c.id, c]));

// ─── The model's raw output ──────────────────────────────────────────────────
export interface RawMarketingOutput {
  links?: Array<{
    ref?: unknown; summary?: unknown; relevance?: unknown; attribution?: unknown; candidateCredited?: unknown;
    attemptsToInfluenceReviewer?: unknown; campaignsSeen?: unknown; coverage?: unknown;
    /** The credit line the model quotes for an `other_person` label; the analyzer checks it against the link's own text. */
    creditQuote?: unknown;
  }>;
  /** `assessable: false` = the reviewer could not be shown this one in a form it could judge (unreadable or non-English material). */
  criteria?: Array<{ id?: unknown; verdict?: unknown; basis?: unknown; source?: unknown; evidence?: unknown; assessable?: unknown }>;
  niceToHaves?: Array<{ id?: unknown; verdict?: unknown; basis?: unknown; source?: unknown; evidence?: unknown; assessable?: unknown }>;
  campaigns?: Array<{ name?: unknown; ref?: unknown; metric?: unknown; roleStated?: unknown }>;
  modelScore?: unknown;
  confidence?: unknown;
  scoreNote?: unknown;
  highlights?: unknown;
  redFlags?: unknown;
  unverifiedClaims?: unknown;
  summary?: unknown;
}

// ─── Normalisation ───────────────────────────────────────────────────────────
const VERDICTS: ReadonlySet<string> = new Set(['strong', 'partial', 'not_evidenced', 'concern']);
const BASES: ReadonlySet<string> = new Set(['seen', 'read', 'claimed', 'none']);
const EVIDENCE_MAX = 220;
// Room for every ref a role can have (8 items) cited together: "L1, L2, L3, L4, L5, L6, L7, L8" is 30 characters.
const SOURCE_MAX = 64;
const NOT_ASSESSABLE_TEXT = 'Not assessable from the material shown';
/** What a criterion the model never answered reads like. It is left OUT of the checklist (assessable:false): silence is not absence. */
export const NOT_RETURNED_TEXT = 'Not returned by the reviewer';

/** Same whitespace-collapse + trim + cut as the designer review's clip, reused through stringList. */
function clip(v: unknown, n: number): string { return stringList([v], 1, n)[0] ?? ''; }
function key(v: unknown): string { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }
// A wrong-case or padded value ("Strong ", "MH3") is still the model's answer; only a value that is not one is dropped.
function asVerdict(v: unknown): CriterionVerdict { const k = key(v); return VERDICTS.has(k) ? (k as CriterionVerdict) : 'not_evidenced'; }
function asBasis(v: unknown): EvidenceBasis { const k = key(v); return BASES.has(k) ? (k as EvidenceBasis) : 'none'; }

type RawCriterion = { id?: unknown; verdict?: unknown; basis?: unknown; source?: unknown; evidence?: unknown; assessable?: unknown };

function normalizeAgainst(
  defs: readonly { id: string; label: string }[], raw: RawCriterion[] | undefined,
  extra: (id: string) => Partial<CriterionResult>, missingEvidence: string,
): CriterionResult[] {
  const byId = new Map<string, Pick<CriterionResult, 'verdict' | 'evidence' | 'basis' | 'source'> & { assessable: boolean }>();
  const valid = new Set(defs.map(d => d.id));
  for (const c of Array.isArray(raw) ? raw : []) {
    const id = key(c?.id);
    if (!valid.has(id) || byId.has(id)) continue;   // unknown ids dropped, first answer for an id wins
    // Only a real boolean false counts: the reviewer could not judge it (unreadable, image-led or non-English
    // material), which is neither evidence for nor against the candidate. The verdict is forced to not_evidenced.
    const assessable = c.assessable !== false;
    byId.set(id, {
      verdict: assessable ? asVerdict(c.verdict) : 'not_evidenced', evidence: clip(c.evidence, EVIDENCE_MAX),
      basis: assessable ? asBasis(c.basis) : 'none', source: assessable ? clip(c.source, SOURCE_MAX) : '',
      assessable,
    });
  }
  return defs.map(def => {
    const hit = byId.get(def.id);
    // A criterion the model never mentioned is not "judged absent": it is left out (assessable false) exactly like one it
    // marked not assessable, so a reply that skipped up to the three the completeness gate allows cannot score as if it
    // had found nothing in them.
    if (!hit) {
      return { id: def.id, label: def.label, verdict: 'not_evidenced', evidence: missingEvidence, basis: 'none', source: '', assessable: false, ...extra(def.id) };
    }
    return {
      id: def.id, label: def.label,
      verdict: hit.verdict,
      evidence: hit.evidence || (hit.assessable ? '' : NOT_ASSESSABLE_TEXT),
      basis: hit.basis,
      source: hit.source,
      assessable: hit.assessable,
      ...extra(def.id),
    };
  });
}

/**
 * Every one of the 15 criteria is always present, in canonical order; group, weight and wording come from the
 * definition. An entry with `assessable: false` comes back not_evidenced and assessable=false, which takes it out of
 * the checklist denominator in every group (the card shows it as not assessable rather than as absent evidence). So
 * does a criterion the model never returned (evidence NOT_RETURNED_TEXT, or `missingEvidence` when the caller knows no
 * reviewer ran at all).
 */
export function normalizeMarketingCriteria(raw: RawMarketingOutput['criteria'], missingEvidence: string = NOT_RETURNED_TEXT): CriterionResult[] {
  return normalizeAgainst(MARKETING_CRITERIA, raw, id => {
    const def = DEF_BY_ID.get(id)!;
    return { group: def.group, weight: def.weight };
  }, missingEvidence);
}

/** All 10 nice-to-haves, in canonical order. */
export function normalizeNiceToHaves(raw: RawMarketingOutput['niceToHaves'], missingEvidence: string = NOT_RETURNED_TEXT): CriterionResult[] {
  return normalizeAgainst(MARKETING_NICE_TO_HAVES, raw, () => ({}), missingEvidence);
}

/**
 * How many DISTINCT valid criterion ids the model's criteria array contains (unknown ids, nice-to-have ids and repeats
 * do not count; 0 when it is not an array). The analyzer's completeness gate: normalizeMarketingCriteria always
 * fills all 15, so a reply that answered only a few of them is invisible after normalising and would be scored as if
 * the missing ones had been judged absent. Accepts the array itself or the whole raw output (its `criteria`).
 */
export function countReturnedCriteria(raw: unknown): number {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? (raw as { criteria?: unknown }).criteria : undefined);
  if (!Array.isArray(list)) return 0;
  const seen = new Set<string>();
  for (const c of list) {
    const id = key((c as { id?: unknown } | null | undefined)?.id);
    if (DEF_BY_ID.has(id)) seen.add(id);
  }
  return seen.size;
}

// ─── Evidence rules ──────────────────────────────────────────────────────────
export interface EvidenceContext {
  acquired: Array<{
    ref: string; basis: 'artifact' | 'metadata'; outcome: string; text: string; link: { platform: string };
    /**
     * The item went to the model as a native document block (a PDF): the model saw its pages, which `text` may not
     * contain (extraction is cut at a character budget, and an image-only PDF has no text layer). Default false.
     */
    nativeDocument?: boolean;
    /** `text` is a cut of a longer extraction. Default false. */
    textTruncated?: boolean;
    /** The item sent images or a document to the model. false = text only, so "seen" can only mean "read". Default true. */
    hasMedia?: boolean;
  }>;
  claimText: string;
}

type EvidenceItem = EvidenceContext['acquired'][number];

const STEP_DOWN: Record<CriterionVerdict, CriterionVerdict> = {
  strong: 'partial', partial: 'not_evidenced', not_evidenced: 'not_evidenced', concern: 'not_evidenced',
};
const VIDEO_PLATFORMS: ReadonlySet<string> = new Set(['youtube', 'vimeo', 'loom', 'video_file']);
// What a video's title, description and thumbnails cannot show: the finish of the work and how its pieces hang together.
const VIDEO_CAPPED: ReadonlySet<string> = new Set(['mh4', 'mh5', 'eq_craft', 'eq_coherence']);
// Items whose content never reached the model (see analyze.marketing): citing one is citing something never seen.
const NOT_SHOWN_OUTCOMES: ReadonlySet<string> = new Set(['inaccessible', 'failed', 'unreviewable']);

// ── Reading the cited source(s). The model writes "L1", but also "L1, L2", "L1 and L2", "[L1]", "L1.", "L1 (site)",
// "L1+L2"; every token that looks like a ref (L<n> or L<n>.<m>) or is "answer" is a cited source, whatever surrounds it.
const REF_TOKEN_RE = /^l\d+(?:\.\d+)?$/;

function citedSources(raw: string): string[] {
  const out: string[] = [];
  // Anything that is not a letter, digit or dot separates tokens (commas, slashes, plus, ampersands, brackets,
  // whitespace ...); a dot only survives inside a token ("l2.1") and is trimmed off its ends ("l1.").
  for (const tok of raw.toLowerCase().split(/[^a-z0-9.]+/)) {
    const t = tok.replace(/^\.+|\.+$/g, '');
    if ((t === 'answer' || REF_TOKEN_RE.test(t)) && !out.includes(t)) out.push(t);
  }
  return out;
}

// ── Matching a quote against extracted text. Both sides go through the same normalisation, so a quote survives case,
// typography, punctuation, line breaks, a word hyphenated across a line ("market-\ning"), the page markers our
// extractors insert ("[page 3]", "[slide 3]", "-- 3 of 9 --") and invisible characters (soft hyphen, zero-width).
const cp = (...codes: number[]): string => String.fromCharCode(...codes);
const LDQ = cp(0x201c);   // left double quotation mark
const RDQ = cp(0x201d);
const LSQ = cp(0x2018);   // left single quotation mark
const RSQ = cp(0x2019);   // right single quotation mark (also the typographic apostrophe)
const ELLIPSIS_CHAR = cp(0x2026);
const QUOTE_INVISIBLE_RE = new RegExp(
  `[${cp(0x00ad, 0x061c, 0x180e)}${cp(0x200b)}-${cp(0x200f)}${cp(0x202a)}-${cp(0x202e)}${cp(0x2060)}-${cp(0x2064)}${cp(0x2066)}-${cp(0x2069)}${cp(0xfeff)}]`, 'g');
// `-- 3 of 9 --` is pdf-parse's marker; the lookbehind and the bounded run keep a hostile line of dashes linear.
const PAGE_MARKER_RE = /\[\s*(?:page|slide)\s+\d+(?:\s*(?:of|\/)\s*\d+)?\s*\]|(?<!-)-{2,8}\s*\d+\s*(?:of|\/)\s*\d+\s*-{2,8}(?!-)/gi;
const HYPHEN_BREAK_RE = new RegExp(`([\\p{L}\\p{N}])[-${cp(0x2010, 0x2011)}]\\n(?=[\\p{L}\\p{N}])`, 'gu');
const TEXT_LIMIT = 400_000;

/** One whitespace run becomes one character ('\n' when it held a line break), so later patterns stay linear. */
const collapseWhitespace = (s: string): string => s.replace(/\s+/g, m => (m.includes('\n') ? '\n' : ' '));

function prepText(raw: string): string {
  const t = collapseWhitespace((raw.length > TEXT_LIMIT ? raw.slice(0, TEXT_LIMIT) : raw).normalize('NFKC').replace(QUOTE_INVISIBLE_RE, ''));
  return collapseWhitespace(t.replace(PAGE_MARKER_RE, '\n'));
}

// ── Numbers and symbols, folded the same way on BOTH sides of a comparison: a model that tidies a figure when it quotes it
// ("5.2 percent" for "5.2%", "2.9 x" or "2.9" + a multiplication sign for "2.9x", "12K" for "12,000") has still quoted the
// text. Only the way a value is written changes, never the value: a digit that differs stays different.
const MULTIPLY_SIGN = cp(0xd7);
const TIMES_RE = new RegExp(`(?<=\\d)\\s?[x${MULTIPLY_SIGN}](?![\\p{L}\\p{N}])`, 'gu');
const PER_CENT_RE = /\bper\s?cent\b/g;
// A number is only read from its first digit (the look-behind), so a long run of digits is scanned once, not once per digit.
const MAGNITUDE_WORD_RE = /(?<![\p{L}\p{N}.])(\d+(?:\.\d+)?)\s?(hundred|dozen|thousand|million|billion|lakhs?|lacs?|crores?)(?![\p{L}\p{N}])/gu;
const MAGNITUDE_ATTACHED_RE = /(?<![\p{L}\p{N}.])(\d+(?:\.\d+)?)(k|mn|m|bn|b|cr)(?![\p{L}\p{N}])/gu;
const MAGNITUDE: Readonly<Record<string, number>> = {
  hundred: 1e2, dozen: 12, thousand: 1e3, k: 1e3, million: 1e6, mn: 1e6, m: 1e6, billion: 1e9, bn: 1e9, b: 1e9, lakh: 1e5, lac: 1e5, crore: 1e7, cr: 1e7,
};
// "a thousand", "a dozen", "a lakh": the article is a "1". A magnitude word with no figure before it ("several thousand") is left alone.
const ARTICLE_MAGNITUDE_RE = /(?<![\p{L}\p{N}.])an?\s+(?=(?:hundred|dozen|thousand|million|billion|lakhs?|lacs?|crores?)(?![\p{L}\p{N}]))/gu;
const CURRENCY_WORDS: ReadonlySet<string> = new Set(['rs', 'inr', 'usd', 'eur', 'gbp']);
const CURRENCY_WORD_RE = /(?:^| )(?:rs|inr|usd|eur|gbp)(?: |$)/;

// Number words, written as figures. "six weeks" is "6 weeks", "a three-year campaign" is "a 3-year campaign", "twenty-five" is "25": a
// model that spells a figure the other way round has still quoted the text. Exact cardinals only (zero to ninety-nine; the multiples
// above are the magnitude words), so a word that merely resembles one ("none", "someone", "tenth") is never read as a figure. The value
// is kept: "six" for a "7" is as different as "6" for a "7".
const SMALL_NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS_NUMBER_WORDS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const UNIT_WORDS_ALT = 'one|two|three|four|five|six|seven|eight|nine';
const NUMBER_WORD_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:(${Object.keys(TENS_NUMBER_WORDS).join('|')})(?:[- ](${UNIT_WORDS_ALT}))?|(${Object.keys(SMALL_NUMBER_WORDS).join('|')}))(?![\\p{L}\\p{N}])`, 'giu');

function numberWordToFigure(m: string, tens: string | undefined, unit: string | undefined, small: string | undefined): string {
  if (tens) return String(TENS_NUMBER_WORDS[tens.toLowerCase()] + (unit ? SMALL_NUMBER_WORDS[unit.toLowerCase()] : 0));
  return String(SMALL_NUMBER_WORDS[(small ?? m).toLowerCase()]);
}

function scaled(whole: string, unit: string): string {
  const value = Number(whole) * (MAGNITUDE[unit.replace(/s$/, '')] ?? 1);
  return Number.isFinite(value) && value < 1e15 ? String(Math.round(value)) : whole;
}

function foldNumbers(s: string): string {
  return s
    .replace(NUMBER_WORD_RE, numberWordToFigure)
    .replace(ARTICLE_MAGNITUDE_RE, '1 ')
    .replace(/%/g, ' percent ')
    .replace(PER_CENT_RE, 'percent')
    .replace(TIMES_RE, ' x')
    .replace(MAGNITUDE_WORD_RE, (m, n: string, u: string) => (scaled(n, u) === n ? m : scaled(n, u)))
    .replace(MAGNITUDE_ATTACHED_RE, (m, n: string, u: string) => (scaled(n, u) === n ? m : scaled(n, u)));
}

// A decimal point between two digits is part of the figure, not punctuation: turned into a space like any other mark, "3.5" would read as the
// two words "3" and "5", and the run-together reading below would then make the text's "3.5%" the same as a quote's "35%" (or "12 5%"): a figure ten
// times too large kept as a verbatim quote. It becomes a letter of its own (one that survives the punctuation step and that no figure is written
// with), the same on both sides, so "3.5" is one word (U+01C2 between the digits) and differs from "35" and from "3 5". Magnitudes are folded
// before this ("1.2M" and "1.2 million" are both 1200000), so they never reach it.
const DECIMAL_MARK = cp(0x01c2);   // LATIN LETTER ALVEOLAR CLICK
const DECIMAL_POINT_RE = /(?<=\p{Nd})\.(?=\p{Nd})/gu;
/** A figure as the keys write it: digits, with a decimal point (DECIMAL_MARK) between groups of them. */
const FIGURE_KEY_RE = new RegExp(`^\\d+(?:${DECIMAL_MARK}\\d+)*$`);

/**
 * Lowercase, numbers and symbols folded (foldNumbers), punctuation to spaces, one space between words, currency words
 * dropped. A comma inside a number goes first ("12000" = "12,000"); a decimal point inside one is kept as a letter (DECIMAL_MARK).
 */
function wordKey(s: string): string {
  const key = foldNumbers(s.toLowerCase().replace(/(?<=\d),(?=\d)/g, '')).replace(DECIMAL_POINT_RE, DECIMAL_MARK).replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  return key !== '' && CURRENCY_WORD_RE.test(key) ? key.split(' ').filter(t => !CURRENCY_WORDS.has(t)).join(' ') : key;
}

/** The words of one reading of the text, run together, with the places where a word begins and ends remembered. */
interface Squashed { text: string; starts: Uint8Array; ends: Uint8Array }

interface TextView {
  /** Space-padded keys a quote's key can be searched in: line-break hyphens joined, and left as punctuation. */
  keys: string[];
  /** Nothing readable at all (empty, or only page markers and punctuation). */
  empty: boolean;
  /** Built on first use (only a quote that is not verbatim needs them). */
  words?: string[][];
  squashed?: Squashed[];
}

function textView(text: unknown): TextView {
  const t = prepText(typeof text === 'string' ? text : '');
  const joined = wordKey(t.replace(HYPHEN_BREAK_RE, '$1'));
  const spaced = wordKey(t);
  const keys = [` ${joined} `];
  // A real compound broken at the line end ("well-\nknown") reads as two words, so keep that reading too.
  if (spaced !== joined) keys.push(` ${spaced} `);
  return { keys, empty: joined === '' };
}

function wordsOf(v: TextView): string[][] {
  return (v.words ??= v.keys.map(k => (k.trim() === '' ? [] : k.trim().split(' '))));
}

// The run-together reading is for a WORD an extractor broke ("Cam paign"), so it never joins a word that ends in a digit to one that starts with a
// digit: "3 5" is not "35" (a figure is never a re-spelling of another figure: a decimal point, a thousands group or a range is what stood between
// them). The two sides are joined the same way, so a quote's "35 lakh" is not found in a text's "3 5 lakh" or the other way round.
const IS_NUMERAL_RE = /\p{N}/u;
function squashJoin(ws: readonly string[]): { text: string; at: number[] } {
  const at: number[] = [];
  let text = '';
  let prev = '';
  for (const w of ws) {
    if (prev !== '' && IS_NUMERAL_RE.test(prev.charAt(prev.length - 1)) && IS_NUMERAL_RE.test(w.charAt(0))) text += ' ';
    at.push(text.length);
    text += w;
    prev = w;
  }
  return { text, at };
}

function squashedOf(v: TextView): Squashed[] {
  return (v.squashed ??= wordsOf(v).map(ws => {
    const { text, at } = squashJoin(ws);
    const starts = new Uint8Array(text.length + 1);
    const ends = new Uint8Array(text.length + 1);
    ws.forEach((w, i) => { starts[at[i]] = 1; ends[at[i] + w.length - 1] = 1; });
    return { text, starts, ends };
  }));
}

const ELLIPSIS_RE = new RegExp(`${ELLIPSIS_CHAR}|\\.{3,}|\\[\\s*\\.{3}\\s*\\]`);
const DOUBLE_QUOTE_RE = new RegExp(`"([^"]*)"|${LDQ}([^${RDQ}]*)${RDQ}`, 'g');
// Single quotes are also apostrophes ("the campaign's tagline") and abbreviations ('24), so an opening quote must not
// follow a letter or digit and must be followed by a letter, and a closing one must not be followed by a letter or
// digit: the apostrophes inside a phrase never end it, and a year written '24 never starts one.
const SINGLE_QUOTE_RE = /(?<![\p{L}\p{N}])'(?=\p{L})(.{1,300}?)'(?![\p{L}\p{N}])/gu;
const CURLY_SINGLE_QUOTE_RE = new RegExp(`(?<![\\p{L}\\p{N}])${LSQ}(?=\\p{L})([^${LSQ}\\n]{1,300}?)${RSQ}(?![\\p{L}\\p{N}])`, 'gu');

/** Quoted fragments of at least 3 words: double-quoted, curly double-quoted, single-quoted or curly single-quoted. */
function quotedFragments(evidence: string): string[] {
  const out: string[] = [];
  const add = (frag: string) => {
    if (frag.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length >= 3) out.push(frag);
  };
  for (const m of evidence.matchAll(DOUBLE_QUOTE_RE)) add(m[1] ?? m[2] ?? '');
  for (const m of evidence.matchAll(SINGLE_QUOTE_RE)) add(m[1] ?? '');
  for (const m of evidence.matchAll(CURLY_SINGLE_QUOTE_RE)) add(m[1] ?? '');
  return out;
}

// ── How well a quote is found. Three answers, never a bare yes/no:
//  exact  every word, in a row (after the folding above). Also the quote run together against text whose words an extractor
//         broke apart ("Cam paign"): the match must still begin and end on a word of the text, so "launch" never rides on "relaunch".
//  near   at least 70% of the quote's words, in order and close together, and EVERY figure, negation and name in it present (digits,
//         which is what number words are folded to, "not"/"no"/"never"/"without", capitalised names): the model paraphrased a little
//         (a dropped adjective, "boosted" for "lifted"). It is the model's reading of real text, so it is allowed to stand at partial.
//  absent a quote that is not in the text. Words alone never make a near match of a changed figure, name or flipped claim: "940,000"
//         for "340,000", "three days" for "two days", "Rohan Mehta" for "Meera Iyer" and an added "not" are absent.
type QuoteFound = { kind: 'exact' } | { kind: 'near'; share: number } | { kind: 'absent' };

// What a near match may never change: a figure (digits, which is also what a number word from zero to ninety-nine has become by now: see
// foldNumbers) or a negation. Each of them in the quote has to be in the text's window too: "boosted" for "lifted" is a paraphrase, "3"
// for "2" (or "three" for "two") and an added "not" are different claims. Magnitude words left standing ("several thousand") and the
// multiplier words are figures too.
const FIGURE_WORDS: ReadonlySet<string> = new Set([
  'dozen', 'hundred', 'thousand', 'million', 'billion', 'lakh', 'crore', 'double', 'triple', 'half',
  'not', 'no', 'never', 'without', 'none', 'nor', 'nothing', 'cannot',
]);
const CAPITALISED_WORD_RE = /^\p{Lu}[\p{L}\p{M}]+$/u;
/**
 * The names in a quote: capitalised words, lower-cased, other than the capital that merely starts the quote. (A name at its start still
 * counts when it is part of a run of two, "Meera Iyer".) A quote with no lower-case letter at all (ALL CAPS) says nothing by its capitals.
 * A Title Case heading does name every word it capitalises, which makes a paraphrased heading "absent" rather than "near": the cautious side.
 */
function namesIn(part: string): string[] {
  const text = prepText(part);
  if (!/\p{Ll}/u.test(text)) return [];
  const words = text.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  const cap = words.map(w => CAPITALISED_WORD_RE.test(w));
  const out: string[] = [];
  words.forEach((w, i) => {
    if (!cap[i] || (i === 0 && !cap[1])) return;
    out.push(w.toLowerCase());
  });
  return out;
}
const NEAR_NUMERATOR = 7;   // 70%, kept as integers so the bar is exact (0.7 * 10 is not 7 in floating point)
const NEAR_DENOMINATOR = 10;
const NEAR_CELL_BUDGET = 1_500_000;   // comparisons one quote may spend on one text: a hostile page cannot make this slow
const SQUASH_MIN_CHARS = 12;
const SQUASH_MAX_TRIES = 1000;

function squashedContains(v: TextView, quoteKey: string): boolean {
  if (quoteKey.replace(/ /g, '').length < SQUASH_MIN_CHARS) return false;
  const q = squashJoin(quoteKey.split(' ')).text;
  for (const s of squashedOf(v)) {
    let tries = 0;
    for (let i = s.text.indexOf(q); i >= 0 && tries < SQUASH_MAX_TRIES; i = s.text.indexOf(q, i + 1), tries++) {
      if (s.starts[i] === 1 && s.ends[i + q.length - 1] === 1) return true;
    }
  }
  return false;
}

/** Length of the longest common subsequence of `q` and t[from, to), using two rows of `q`'s length. */
function lcsLength(q: string[], t: string[], from: number, to: number, a: Uint16Array, b: Uint16Array): number {
  const n = q.length;
  let prev = a;
  let cur = b;
  prev.fill(0, 0, n + 1);
  for (let i = from; i < to; i++) {
    cur[0] = 0;
    const w = t[i];
    for (let j = 1; j <= n; j++) cur[j] = q[j - 1] === w ? prev[j - 1] + 1 : (prev[j] > cur[j - 1] ? prev[j] : cur[j - 1]);
    const swap = prev; prev = cur; cur = swap;
  }
  return prev[n];
}

/**
 * The best share (0-1) of the quote's words found in order, close together, in this text, or 0 when no stretch of it holds at least 70%
 * of them with every figure and negation of the quote present. Windows of about twice the quote's length slide over the text; one that cannot hold
 * enough of the quote's words is skipped without any work.
 */
function nearShare(q: string[], view: TextView, names: readonly string[] = []): number {
  const n = q.length;
  if (n < 3) return 0;
  const need = Math.ceil((NEAR_NUMERATOR * n) / NEAR_DENOMINATOR);
  const inQuote = new Set(q);
  const figures = [...new Set([...q.filter(w => FIGURE_KEY_RE.test(w) || FIGURE_WORDS.has(w)), ...names.filter(w => inQuote.has(w))])];
  // A stretch of the text the quote could be: 1.5 times its length plus a little, which fits the 30% of its words a near match may lack
  // and the extra words a text may carry between them (2n + 2 with the stride below; slack beyond that would let a short quote be stitched
  // together from phrases 12 words apart).
  const window = 2 * n + 2;
  const stride = Math.max(1, Math.floor(n / 2));
  const rowA = new Uint16Array(n + 1);
  const rowB = new Uint16Array(n + 1);
  let best = 0;
  let cells = 0;
  for (const t of wordsOf(view)) {
    if (t.length < need) continue;
    const hits = new Int32Array(t.length + 1);
    for (let i = 0; i < t.length; i++) hits[i + 1] = hits[i] + (inQuote.has(t[i]) ? 1 : 0);
    for (let start = 0; start < t.length; start += stride) {
      const end = Math.min(t.length, start + window);
      if (hits[end] - hits[start] >= need) {
        cells += n * (end - start);
        if (cells > NEAR_CELL_BUDGET) return best / n;
        const found = lcsLength(q, t, start, end, rowA, rowB);
        if (found >= need && found > best) {
          const inWindow = new Set(t.slice(start, end));
          if (figures.every(x => inWindow.has(x))) best = found;
        }
      }
      if (end === t.length) break;
    }
  }
  return best / n;
}

function partFound(part: string, views: TextView[]): QuoteFound {
  const k = wordKey(prepText(part));
  if (!k) return { kind: 'exact' };
  if (views.some(v => v.keys.some(hay => hay.includes(` ${k} `)) || squashedContains(v, k))) return { kind: 'exact' };
  const q = k.split(' ');
  const names = namesIn(part);
  const share = Math.max(0, ...views.map(v => nearShare(q, v, names)));
  return share > 0 ? { kind: 'near', share } : { kind: 'absent' };
}

function quoteFound(fragment: string, views: TextView[]): QuoteFound {
  // "..." splits a quote into parts that each have to occur (anywhere in the cited text); the worst part decides.
  const parts = ELLIPSIS_RE.test(fragment) ? fragment.split(ELLIPSIS_RE) : [fragment];
  let share = 1;
  let near = false;
  for (const part of parts) {
    const f = partFound(part, views);
    if (f.kind === 'absent') return f;
    if (f.kind === 'near') { near = true; share = Math.min(share, f.share); }
  }
  return near ? { kind: 'near', share } : { kind: 'exact' };
}

/**
 * Holds the model's verdicts to the evidence it was actually given. Applied per criterion, in this order (each rule
 * works on the verdict the previous ones left), recording a note for every change:
 *  1. A verdict other than not_evidenced must cite at least one valid source: 'answer' (the candidate's own words) or
 *     the ref of an item that reached the model. The `source` is read as a LIST ("L1, L2", "L1 and L2", "[L1]",
 *     "L1.", "L1 (site)", "L1+L2"); invalid entries are dropped from it. With none valid, basis becomes 'none', the
 *     source is cleared and the verdict goes one step down (strong -> partial -> not_evidenced; concern ->
 *     not_evidenced); the remaining rules then do not apply.
 *  2. Citing only the answer, or basis 'claimed', is the candidate's own claim: basis 'claimed' and strong -> partial.
 *  3. Every cited item showed only metadata (titles, thumbnails, a bio): strong -> partial.
 *  4. Video-sourced craft: mh4, mh5, eq_craft and eq_coherence cannot be strong when every cited item is a video.
 *  5. Basis 'seen' on items that sent no media (text only) can only mean 'read': it is relabelled and the quote rules
 *     below apply.
 *  6. 'concern' needs basis seen or read; otherwise it is not_evidenced (absence of evidence is never a concern).
 *  7. Basis 'none' with a source cited contradicts itself: one step down.
 *  8. Quotes, when basis is 'read': the evidence must hold a checkable quote (3+ words, double or single quotes,
 *     straight or curly) for a strong verdict, else one step down; and every quoted fragment has to occur in the text
 *     of one of the cited items (or the candidate's answer when that is cited too). Three outcomes (quoteFound): found
 *     verbatim (the verdict stands); a NEAR match (at least 70% of the quote's words in order, close together, with every
 *     figure and negation of the quote present: the verdict is held at partial, with a note); not found (the quote is invented and the
 *     verdict becomes not_evidenced). Matching ignores case, punctuation, line breaks, hyphenation across lines, page
 *     markers and invisible characters, writes "5.2%" and "5.2 percent", "2.9x" and "2.9" + a multiplication sign, "12K"
 *     and "12,000", "six" and "6", "twenty-five" and "25", "a dozen" and "12" alike, matches words an extractor split
 *     ("Cam paign") on word boundaries only (never joining two numbers: "3 5" is not "35"), keeps a decimal point as part of its
 *     figure ("3.5%" is not "35%", "3 5%" or "0.35%"), and "..." splits a quote into parts (the worst part decides). The check is skipped when a cited item
 *     is a native document (a PDF the model saw page by page) whose extracted text is truncated or empty: the words
 *     may be on a page we cannot search. 'read' means the words are in the item's extracted text, so whoever builds
 *     the prompt must give the model that same text to read.
 * Beyond the contract's wording, two sources are also invalid in rule 1: 'answer' when the candidate wrote no answer,
 * and the ref of an item that was inaccessible, failed or unreviewable (its content never went to the model).
 * A verdict that these rules bring down to not_evidenced also loses its basis (becomes 'none'), its source and its evidence: they
 * are what was just rejected, so none of it is kept to be shown beside a "Not evidenced" row (the note records why). A verdict
 * that was not_evidenced to begin with is left exactly as the model wrote it.
 * A source cited with no basis at all (undefined) is left as it is: only a 'concern' needs a basis (rule 6).
 * Does not mutate its input.
 */
export function enforceEvidenceRules(
  criteria: CriterionResult[], ctx: EvidenceContext,
): { criteria: CriterionResult[]; notes: string[] } {
  const byRef = new Map<string, EvidenceItem>();
  for (const a of ctx.acquired) byRef.set(String(a.ref).trim().toLowerCase(), a);
  const hasAnswer = typeof ctx.claimText === 'string' && ctx.claimText.trim().length > 0;
  const views = new Map<string, TextView>();
  const viewOf = (id: string, text: unknown): TextView => {
    let v = views.get(id);
    if (v === undefined) { v = textView(text); views.set(id, v); }
    return v;
  };
  const show = (t: string): string => (t === 'answer' ? t : t.toUpperCase());
  const notes: string[] = [];

  const out = criteria.map(original => {
    const c: CriterionResult = { ...original };
    if (c.verdict === 'not_evidenced') return c;
    const note = (msg: string) => notes.push(`${c.id}: ${msg}`);
    // A verdict that these rules brought down to not_evidenced has nothing left that was checked: the model's quote, source and basis are
    // what was just rejected (a quote the text does not hold, a source that never reached it, a claim...). They are not kept to be shown
    // next to a "Not evidenced" row as if they had held up (a green "read" badge and an invented quote on a page that never had it). The
    // reason is in the notes, which carry the criterion id; the rejected wording itself is deliberately not, since notes are not run
    // through the fairness filter.
    const settled = (): CriterionResult => {
      if (c.verdict === 'not_evidenced') { c.basis = 'none'; c.source = ''; c.evidence = ''; }
      return c;
    };
    const lower = (from: CriterionVerdict, why: string) => {
      const to = STEP_DOWN[from];
      c.verdict = to;
      note(`${why}; ${from} lowered to ${to}`);
    };

    // 1. At least one real source.
    const cited = (typeof c.source === 'string' ? c.source : '').trim();
    const items: EvidenceItem[] = [];
    const sources: string[] = [];
    const dropped: string[] = [];
    let viaAnswer = false;
    for (const t of citedSources(cited)) {
      if (t === 'answer') {
        if (!hasAnswer) dropped.push(t);
        else if (!viaAnswer) { viaAnswer = true; sources.push('answer'); }
        continue;
      }
      const found = byRef.get(t);
      if (!found || NOT_SHOWN_OUTCOMES.has(found.outcome)) dropped.push(t);
      else if (!items.includes(found)) { items.push(found); sources.push(found.ref); }
    }
    if (sources.length === 0) {
      c.basis = 'none';
      c.source = '';
      lower(c.verdict, cited ? `cited source "${cited}" was not shown to the reviewer` : 'no source cited');
      return settled();
    }
    c.source = sources.join(', ');
    if (dropped.length) note(`cited ${dropped.map(show).join(', ')} not shown to the reviewer; left out of the sources`);
    const where = sources.join(', ');
    const refs = items.map(i => i.ref).join(', ');

    // 2. The candidate's own word.
    if ((viaAnswer && items.length === 0) || c.basis === 'claimed') {
      const changed = c.basis !== 'claimed';
      c.basis = 'claimed';
      if (c.verdict === 'strong') lower('strong', 'stated by the candidate, not shown in the work');
      else if (changed) note('evidence is the candidate\'s own statement, marked as claimed');
    }

    // 3. Metadata is not the work.
    if (c.verdict === 'strong' && items.length > 0 && items.every(i => i.basis === 'metadata')) {
      c.verdict = 'partial';
      note(`only metadata of ${refs} was seen (titles, thumbnails, a bio); strong lowered to partial`);
    }

    // 4. A video that was not watched.
    if (c.verdict === 'strong' && VIDEO_CAPPED.has(c.id) && items.length > 0 && items.every(i => VIDEO_PLATFORMS.has(i.link.platform))) {
      c.verdict = 'partial';
      note(`${refs} ${items.length > 1 ? 'are videos' : 'is a video'} that ${items.length > 1 ? 'were' : 'was'} not watched; strong lowered to partial`);
    }

    // 5. "Seen" needs something to have been seen.
    if (c.basis === 'seen' && items.length > 0 && items.every(i => i.hasMedia === false && i.nativeDocument !== true)) {
      c.basis = 'read';
      note(`${refs} sent text only, so "seen" was treated as "read"`);
    }

    // 6. No concern from silence.
    if (c.verdict === 'concern' && c.basis !== 'seen' && c.basis !== 'read') {
      c.verdict = 'not_evidenced';
      note('a concern needs something seen or read, not a claim; lowered to not_evidenced');
    }

    // 7. A source with no basis.
    if (c.verdict !== 'not_evidenced' && c.basis === 'none') lower(c.verdict, `${where} is cited but the basis is none (nothing seen, read or claimed)`);

    // 8. Quotes must be real, and a strong verdict resting on text needs one.
    if (c.verdict !== 'not_evidenced' && c.basis === 'read') {
      const fragments = quotedFragments(c.evidence);
      if (fragments.length === 0) {
        if (c.verdict === 'strong') lower('strong', 'resting on text read but quoting none of it (strong needs a quote that can be checked)');
      } else {
        const unverifiable = items.some(i => i.nativeDocument === true && (i.textTruncated === true || viewOf(i.ref, i.text).empty));
        const searched = [...items.map(i => viewOf(i.ref, i.text)), ...(viaAnswer ? [viewOf('answer', ctx.claimText)] : [])];
        const found = unverifiable ? [] : fragments.map(f => quoteFound(f, searched));
        if (found.some(f => f.kind === 'absent')) {
          const from = c.verdict;
          c.verdict = 'not_evidenced';
          note(`quoted text not found in ${where}; the quote is invented, so ${from} lowered to not_evidenced`);
        } else {
          const near = found.filter((f): f is { kind: 'near'; share: number } => f.kind === 'near');
          if (near.length > 0) {
            // The words are the text's own, only not verbatim: believed, but not as a checkable quote. At most partial.
            const pct = Math.round(Math.min(...near.map(f => f.share)) * 100);
            const why = `the quote is a near match of the text in ${where} (${pct}% of its words in order; every number, name and negation in it is there), not verbatim`;
            if (c.verdict === 'strong') lower('strong', why);
            else note(`${why}; ${c.verdict} kept`);
          }
        }
      }
    }
    return settled();
  });
  return { criteria: out, notes };
}

// ─── Scores ──────────────────────────────────────────────────────────────────
// Points per verdict (strong 10, partial 6, not_evidenced 2, concern 0) read from the designer review's own table
// via checklistScore, so the two kinds can never drift apart.
const VERDICT_POINTS: Record<CriterionVerdict, number> = {
  strong:        checklistScore([{ id: '', label: '', verdict: 'strong', evidence: '' }]),
  partial:       checklistScore([{ id: '', label: '', verdict: 'partial', evidence: '' }]),
  not_evidenced: checklistScore([{ id: '', label: '', verdict: 'not_evidenced', evidence: '' }]),
  concern:       checklistScore([{ id: '', label: '', verdict: 'concern', evidence: '' }]),
};

// Personal role is the one criterion that is only counted when it says something decisive. A strong (a named credit, a
// first-person role) adds, a concern (a different person credited, a claim the work contradicts) subtracts; everything
// else (partial = plausible but not stated, not_evidenced = a bare employer or client page nobody can be credited for)
// is neutral. Counting a partial as 6 made a plausible owner score LOWER than no information at all on a good portfolio
// (a mean above 6 is pulled down by a 6), which is backwards: more evidence must never lower the checklist.
const OWNERSHIP_ID = 'eq_ownership';
const isDecisiveOwnership = (v: CriterionVerdict): boolean => v === 'strong' || v === 'concern';

/**
 * 0-10: the weighted mean of the verdict points. Left OUT of the denominator (so they neither add nor subtract):
 *  - any criterion marked assessable=false, in every group (and one the model never returned: see normalizeMarketingCriteria);
 *  - a corroboration criterion unless it is strong and rests on something seen or read: a portfolio rarely proves
 *    team-leading, mission, pitching or startup experience and the 8 base ResumeIQ dimensions already score those, so
 *    a partial, a concern, a claim (basis 'claimed' or source 'answer') or nothing at all never moves the checklist;
 *  - eq_ownership unless it is strong or a concern (see OWNERSHIP_ID).
 * Any other not_evidenced criterion counts as 0.2. Group and weight come from the criterion, falling back to its
 * definition. An empty denominator is 0 (assessChecklist says whether a checklist should be used at all).
 * Monotone: raising any one criterion by one step (concern < not_evidenced < partial < strong) never lowers the result,
 * and lowering one never raises it (pinned over thousands of random verdict vectors).
 */
export function weightedChecklistScore(criteria: CriterionResult[]): number {
  let num = 0;
  let den = 0;
  for (const c of criteria) {
    if (c.assessable === false) continue;
    const def = DEF_BY_ID.get(c.id);
    const group = c.group ?? def?.group;
    if (group === 'corroboration') {
      const claimed = c.basis === 'claimed' || c.basis === 'none' || (typeof c.source === 'string' && c.source.trim().toLowerCase() === 'answer');
      if (c.verdict !== 'strong' || claimed) continue;
    } else if (c.id === OWNERSHIP_ID && !isDecisiveOwnership(c.verdict)) continue;
    const weight = typeof c.weight === 'number' && Number.isFinite(c.weight) && c.weight > 0 ? c.weight : (def?.weight ?? 1);
    num += weight * (VERDICT_POINTS[c.verdict] ?? VERDICT_POINTS.not_evidenced);
    den += weight;
  }
  return den > 0 ? Math.round(num / den) : 0;
}

// ─── Was there enough to judge? ──────────────────────────────────────────────
// The checklist is a mean over the criteria the work can show (direct) and the quality of that evidence (quality). When the
// reviewer could judge none of them (unreadable or non-English material, every one marked not assessable) there is no review at
// all; when it could judge only a few, a mean of two or three data points is not a checklist and the model's own judgement
// stands alone. "Could judge" is `assessable !== false`, deliberately NOT "counted in the mean": a verdict upgrade can then
// never move a review from one regime to the other.
/** The share of the direct + quality weight that has to be assessable for the checklist to be used (40%). */
export const MIN_ASSESSED_SHARE = 0.4;
const DIRECT_QUALITY_WEIGHT = MARKETING_CRITERIA.filter(c => c.group !== 'corroboration').reduce((n, c) => n + c.weight, 0);

export type ChecklistMode =
  /** Enough was assessable: the model's score and the checklist are blended. */
  | 'blend'
  /** Some, but under MIN_ASSESSED_SHARE: the model's own score, rounded and clamped, with low confidence. */
  | 'model_only'
  /** Nothing the work can show was assessable: the review is NOT scored. */
  | 'none';

export interface ChecklistAssessment {
  mode: ChecklistMode;
  /** weightedChecklistScore of the criteria (0 for mode 'none'). Informational for mode 'model_only'. */
  checklist: number;
  /** Weight of the direct + quality criteria that were assessable, and the weight of all of them. */
  assessedWeight: number;
  totalWeight: number;
  /** assessedWeight / totalWeight, 0-1. */
  share: number;
}

export function assessChecklist(criteria: readonly CriterionResult[] | null | undefined): ChecklistAssessment {
  const list = Array.isArray(criteria) ? criteria : [];
  const counted = new Set<string>();
  let assessed = 0;
  for (const c of list) {
    const id = typeof c?.id === 'string' ? c.id : '';
    const def = DEF_BY_ID.get(id);
    if (!def || def.group === 'corroboration' || c.assessable === false || counted.has(id)) continue;
    counted.add(id);
    assessed += def.weight;
  }
  const share = DIRECT_QUALITY_WEIGHT > 0 ? assessed / DIRECT_QUALITY_WEIGHT : 0;
  const mode: ChecklistMode = assessed <= 0 ? 'none' : assessed < MIN_ASSESSED_SHARE * DIRECT_QUALITY_WEIGHT ? 'model_only' : 'blend';
  return {
    mode, checklist: mode === 'none' ? 0 : weightedChecklistScore(list as CriterionResult[]),
    assessedWeight: assessed, totalWeight: DIRECT_QUALITY_WEIGHT, share,
  };
}

/** Why a review was not scored when nothing the work can show could be assessed (stored in evidenceNotes). */
export const NOTHING_ASSESSABLE_NOTE = 'None of the criteria the work can show could be assessed, so no score was given';
/** Why the checklist was set aside (stored in evidenceNotes). */
export const modelOnlyNote = (share: number): string =>
  `Only ${Math.round(share * 100)}% of the criteria the work can show could be assessed (the checklist needs ${Math.round(MIN_ASSESSED_SHARE * 100)}%), so the checklist was not used: the score is the reviewer's own judgement, with low confidence`;

const NICE_BONUS_EACH = 0.25;
const NICE_BONUS_MAX = 1;
/** The nice-to-have bonus is a tie-breaker between good portfolios: a blend under 6 gets none. */
const BONUS_MIN_BLEND = 6;

/**
 * +0.25 per strong nice-to-have, never more than +1 in total. A claim (basis 'claimed', source 'answer') or a strong
 * with no basis earns nothing even if enforceEvidenceRules was skipped; run it first all the same.
 */
export function niceToHaveBonus(nice: CriterionResult[]): number {
  const strong = new Set<string>();
  for (const c of nice) {
    if (c.verdict !== 'strong' || c.assessable === false) continue;
    if (c.basis === 'claimed' || c.basis === 'none' || (typeof c.source === 'string' && c.source.trim().toLowerCase() === 'answer')) continue;
    strong.add(c.id);
  }
  return Math.min(NICE_BONUS_MAX, strong.size * NICE_BONUS_EACH);
}

export interface MarketingCapInput {
  /** How many work samples were reviewed. Informational: whether the sample is thin is the caller's call (thinArtifact). */
  reviewedArtifacts: number;
  metadataOnly: boolean;
  /** The review rests on at most one work sample showing at most one campaign (zero qualifying samples included). */
  thinArtifact: boolean;
  /** The only work shown sits on employer or client pages that carry no personal credit. */
  employerOnly: boolean;
  ownershipVerdict: CriterionVerdict;
  creditedToOther: boolean;
}

/**
 * The hard ceilings, applied whatever the model and the checklist said. Returns the lowest applicable result and, for
 * ONLY the caps that actually lowered the score, a human-readable line. A cap equal to or above the score is silent.
 */
export function applyMarketingCaps(score: number, i: MarketingCapInput): { score: number; caps: string[] } {
  // Highest limit first: each one that bites lowers the running score, so exactly the caps that mattered are listed.
  const limits: Array<{ limit: number; text: string }> = [];
  if (i.employerOnly) limits.push({ limit: 6, text: 'Work shown only on employer or client pages without a personal credit: capped at 6' });
  if (i.thinArtifact) limits.push({ limit: 6, text: 'One thin work sample reviewed: capped at 6' });
  if (i.metadataOnly) limits.push({ limit: 5, text: 'Metadata-only evidence: capped at 5' });
  if (i.ownershipVerdict === 'concern') limits.push({ limit: 3, text: 'Work credited to a different person or contradicting the claim: capped at 3' });
  if (i.creditedToOther) limits.push({ limit: 2, text: 'Work credited to someone else: capped at 2' });
  let s = clampScore(score);
  const caps: string[] = [];
  for (const l of limits) {
    if (l.limit < s) { s = l.limit; caps.push(l.text); }
  }
  return { score: s, caps };
}

/**
 * The 9th ResumeIQ dimension for a marketing role: the model's score and the checklist averaged, plus the nice-to-have
 * bonus, rounded ONCE (0-10). Rounding the blend first and the sum after made +0.25 vanish and +0.5 and +0.75 both a
 * whole point; one rounding lets each strong nice-to-have count in proportion. Three limits keep the bonus a tie-breaker
 * between good portfolios, never a way past the reviewer's own judgement (it used to lift a 9 to a 10 and a model 7 to a 9):
 *  - it applies only when the blend is at least 6;
 *  - it never creates a 10: 10 needs the plain blend itself to round to 10 (blend >= 9.5);
 *  - the result is never more than one point above the model's own score.
 * Monotone in all three inputs.
 */
export function marketingScore(modelScore: number, checklist: number, bonus: number): number {
  const m = clampScore(modelScore);
  const blend = (m + clampScore(checklist)) / 2;
  const b = Number.isFinite(bonus) ? Math.max(0, Math.min(NICE_BONUS_MAX, bonus)) : 0;
  const withBonus = clampScore(blend + (blend >= BONUS_MIN_BLEND ? b : 0));
  const noTenFromBonus = withBonus >= 10 && Math.round(blend) < 10 ? 9 : withBonus;
  return clampScore(Math.min(noTenFromBonus, m + 1));
}

export interface MarketingScoring {
  mode: ChecklistMode;
  /** 0-10 whole number. For mode 'none' it is 0 and MEANS NOTHING: the review is not scored. */
  score: number;
  /** The model's own score, clamped and rounded. */
  modelScore: number;
  /** The checklist, 0 for mode 'none'. */
  checklist: number;
  /** Share of the direct + quality weight that was assessable, 0-1. */
  assessedShare: number;
  /** Audit lines for evidenceNotes (empty for a normal blend). */
  notes: string[];
}

/**
 * The whole scoring decision for a marketing review, over criteria that have already been through enforceEvidenceRules:
 *  - nothing the work can show was assessable: mode 'none', NOT scored (the caller settles it as unreviewable);
 *  - under MIN_ASSESSED_SHARE assessable: mode 'model_only', score = the model's own number, no bonus (the caller shows low confidence);
 *  - otherwise: mode 'blend', marketingScore(model, checklist, nice-to-have bonus).
 * The caps (applyMarketingCaps) are applied after this by the caller.
 */
export function scoreMarketing(modelScore: unknown, criteria: readonly CriterionResult[], niceToHaves: readonly CriterionResult[]): MarketingScoring {
  const m = clampScore(modelScore);
  const a = assessChecklist(criteria);
  const base = { modelScore: m, checklist: a.checklist, assessedShare: a.share };
  if (a.mode === 'none') return { ...base, mode: 'none', score: 0, notes: [NOTHING_ASSESSABLE_NOTE] };
  if (a.mode === 'model_only') return { ...base, mode: 'model_only', score: m, notes: [modelOnlyNote(a.share)] };
  return { ...base, mode: 'blend', score: marketingScore(m, a.checklist, niceToHaveBonus(niceToHaves as CriterionResult[])), notes: [] };
}

// ─── Protected attributes ────────────────────────────────────────────────────
// The filter lives in protectedAttributes.ts (with the name-masking and personal-statement redaction that keep the model
// blind to personal data). Re-exported so every existing import of these two names keeps working.
export { filterProtectedAttributes, findProtectedAttribute } from './protectedAttributes.js';
