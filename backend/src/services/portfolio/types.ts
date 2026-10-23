// Shared types for the portfolio-review pipeline (roles gated by
// roles.portfolio_analysis_enabled; roles.portfolio_review_kind picks the
// review: the Senior UX/Product Designer portfolio review, or the Head of
// Marketing work-sample review). Kept dependency-free so both the lightweight
// main-API modules (link extraction, enqueue) and the heavy worker-only
// modules (browser capture, vision analysis) can import it without dragging
// Chromium into the main API's serverless bundle.

export type PortfolioReviewKind = 'design_portfolio' | 'marketing_work';

export type PortfolioPlatform =
  | 'figma_file' | 'figma_site' | 'framer' | 'behance' | 'wix' | 'dribbble'
  | 'notion' | 'adobe_portfolio' | 'webflow' | 'squarespace' | 'carrd'
  | 'cargo' | 'google_slides' | 'pdf_file' | 'custom'
  // Marketing work samples: documents, media and social links candidates paste into the screening answer.
  | 'canva' | 'medium' | 'gdrive_file' | 'gdrive_folder' | 'google_doc' | 'google_sheet'
  | 'docx_file' | 'pptx_file' | 'image_file' | 'video_file' | 'youtube' | 'vimeo' | 'loom'
  | 'instagram' | 'linkedin' | 'social_other' | 'cloud_file' | 'link_hub';

// 'unreviewable' = work a machine cannot open (bot wall, social platform, video-only link, unsupported type):
// neutral, never held against the candidate (unlike 'inaccessible', a private/dead link).
export type PortfolioStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'no_portfolio' | 'inaccessible' | 'unreviewable';

export type CriterionVerdict = 'strong' | 'partial' | 'not_evidenced' | 'concern';

// How a link is reviewed: a Chromium crawl ('site'), a fetched file ('document'/'image'), metadata only
// ('video'/'social'), expanded first ('resolve': shorteners and link-in-bio hubs), or not at all ('none').
export type ReviewHandler = 'site' | 'document' | 'image' | 'video' | 'social' | 'resolve' | 'none';

export interface PortfolioLink {
  url:      string;
  host:     string;
  platform: PortfolioPlatform;
  handler?: ReviewHandler;
}

export interface CriterionResult {
  id:       string;
  label:    string;
  verdict:  CriterionVerdict;
  evidence: string;
  // Marketing work-sample review only (absent on designer reviews).
  group?:      'direct' | 'corroboration' | 'quality';
  weight?:     number;
  // seen = in an artifact we looked at, read = in extracted text, claimed = stated without evidence, none = no source.
  basis?:      'seen' | 'read' | 'claimed' | 'none';
  source?:     string;      // 'L1', 'L2' … or 'answer'
  // false = left out of the checklist denominator (a portfolio can't prove it; the base 8 dimensions cover it).
  assessable?: boolean;
}

export interface PortfolioSignals {
  brokenLinksChecked: number;
  brokenLinks:        number;
  brokenLinkSamples:  string[];
  consoleErrors:      number;
  failedRequests:     number;
  mobileOverflow:     boolean | null;
  loadMs:             number | null;
  truncated:          boolean;
}

export interface PortfolioReviewed {
  url:         string;
  platform:    PortfolioPlatform;
  isPortfolio: boolean;
  // false = the site names a different person than the candidate. null = couldn't tell.
  belongsToCandidate: boolean | null;
  // true = the site contained text trying to instruct or sway an AI reviewer.
  attemptsToInfluenceReviewer?: boolean;
  accessible:  boolean;
  // blocked/skipped are about the candidate's link; error is a failure on our side; unreviewable is neutral.
  accessKind?: 'ok' | 'blocked' | 'error' | 'skipped' | 'unreviewable';
  accessNote?: string;
  pagesReviewed: number;
  pageTitles:  string[];
  signals:     PortfolioSignals;
  note?:       string;
  // Marketing work-sample review only (absent on designer reviews).
  ref?:         string;     // 'L1', 'L2' …
  handler?:     ReviewHandler;
  outcome?:     'ok' | 'partial' | 'inaccessible' | 'failed' | 'unreviewable';
  basis?:       'artifact' | 'metadata';
  coverage?:    'full' | 'partial' | 'metadata_only';
  relevance?:   'work_sample' | 'profile_only' | 'employer_site_no_attribution' | 'irrelevant';
  attribution?: 'candidate_owned' | 'led_team' | 'employer_or_client' | 'unattributed' | 'other_person' | 'unknown';
  campaignsSeen?: number;
  summary?:     string;
  facts?:       string[];   // our own measurements, e.g. 'PDF, 18 of 18 pages read'
  reason?:      string;     // plain-language reason shown to HR when the link was not (fully) reviewed
}

export interface PortfolioAnalysisResult {
  version:      1;
  // Which review produced this. Absent on every review made before the marketing kind existed => design_portfolio.
  kind?:        PortfolioReviewKind;
  analyzedAt:   string;
  model:        string;
  portfolios:   PortfolioReviewed[];
  criteria:     CriterionResult[];
  jdAlignment: {
    mustHaves:   Array<{ item: string; verdict: CriterionVerdict; evidence: string }>;
    niceToHaves: Array<{ item: string; verdict: CriterionVerdict; evidence: string }>;
  };
  modelScore:     number;   // 0-10, the model's own holistic judgement
  checklistScore: number;   // 0-10, derived from the criteria verdicts
  score:          number;   // 0-10 integer, blend of the two — the 9th ResumeIQ dimension
  scoreNote:      string;
  highlights:     string[];
  redFlags:       string[];
  summary:        string;
  // Marketing work-sample review only (absent on designer reviews).
  confidence?:       'high' | 'medium' | 'low';
  campaigns?:        Array<{ name: string; ref?: string; metric?: string; roleStated?: 'led' | 'contributed' | 'unclear' }>;
  // Links that were NOT reviewed and why — built by code, never by the model.
  unreviewed?:       Array<{ url: string; platform: string; reason: string }>;
  unverifiedClaims?: string[];
  // The candidate's own screening answer (capped), shown as "described, unverified".
  claimText?:        string;
  usage?:            { inputTokens: number; outputTokens: number };
  // Human-readable caps that really lowered the score, e.g. 'Metadata-only evidence: capped at 5'. Only strings that say
  // 'capped at N'; audit notes live in evidenceNotes.
  caps?:             string[];
  // How the evidence was checked, for audit and never a score cap: verdicts lowered because a quote or source did not hold up,
  // the fairness-filter note, a document retried as text, media left out for size. A criterion id may prefix a note ('mh3: …').
  evidenceNotes?:    string[];
}
