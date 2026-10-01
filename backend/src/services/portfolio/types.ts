// Shared types for the portfolio-review pipeline (Senior UX/Product Designer
// role, gated by roles.portfolio_analysis_enabled). Kept dependency-free so
// both the lightweight main-API modules (link extraction, enqueue) and the
// heavy worker-only modules (browser capture, vision analysis) can import it
// without dragging Chromium into the main API's serverless bundle.

export type PortfolioPlatform =
  | 'figma_file' | 'figma_site' | 'framer' | 'behance' | 'wix' | 'dribbble'
  | 'notion' | 'adobe_portfolio' | 'webflow' | 'squarespace' | 'carrd'
  | 'cargo' | 'google_slides' | 'pdf_file' | 'custom';

export type PortfolioStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'no_portfolio' | 'inaccessible';

export type CriterionVerdict = 'strong' | 'partial' | 'not_evidenced' | 'concern';

export interface PortfolioLink {
  url:      string;
  host:     string;
  platform: PortfolioPlatform;
}

export interface CriterionResult {
  id:       string;
  label:    string;
  verdict:  CriterionVerdict;
  evidence: string;
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
  // blocked/skipped are about the candidate's link; error is a failure on our side.
  accessKind?: 'ok' | 'blocked' | 'error' | 'skipped';
  accessNote?: string;
  pagesReviewed: number;
  pageTitles:  string[];
  signals:     PortfolioSignals;
  note?:       string;
}

export interface PortfolioAnalysisResult {
  version:      1;
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
}
