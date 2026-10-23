// WORKER-ONLY (see ../browser.ts). The shape every link fetcher returns for the marketing work-sample review:
// what we managed to read (text, document pages, images) plus our own measurements — never a verdict.
import type { PortfolioLink } from '../types.js';
import type { BudgetTracker } from './budget.js';

// ok = read as intended; partial = read, but a cap/limit cut it short (a cap is never a failure);
// inaccessible = the CANDIDATE's link doesn't work for a stranger (private/deleted/404/passworded) — held against them;
// failed = OUR side broke (Google 5xx/429, timeout, corrupt download) — retried, never scored, never held against them;
// unreviewable = a machine can't open it and nobody is at fault (bot wall, social platform, video-only, unsupported type).
export type AcquireOutcome = 'ok' | 'partial' | 'inaccessible' | 'failed' | 'unreviewable';

export interface MediaBlock {
  kind:  'document' | 'image';
  label: string;
  mime:  string;
  b64:   string;
  bytes: number;
  pages?: number;
}

export interface Acquired {
  /** 'L1', 'L2' … — how the model and the stored review refer to this link. */
  ref:     string;
  link:    PortfolioLink;
  outcome: AcquireOutcome;
  /** Plain-language reason shown to HR when the link was not (fully) reviewed. */
  reason?: string;
  /** 'metadata' = only titles, descriptions, thumbnails or a bio were seen — never the work itself. */
  basis:   'artifact' | 'metadata';
  media:   MediaBlock[];
  /** UNTRUSTED text extracted from the link (capped). Always goes to the model inside an untrusted wrapper. */
  text:    string;
  /** OUR measurements (trusted), e.g. 'PDF, 18 of 18 pages read'. */
  facts:   string[];
  /** The deterministic injection pre-scan matched: text and media are excluded from the model call. */
  injectionHit: boolean;
  pagesReviewed?: number;
  pageTitles?:    string[];
}

export interface AcquireContext {
  /** Epoch ms after which no new work may start. */
  deadline:       number;
  budget:         BudgetTracker;
  candidateName?: string;
}
