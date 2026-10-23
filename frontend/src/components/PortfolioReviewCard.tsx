import { ReactNode, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckCircle2, CircleDashed, ExternalLink, Loader2, MinusCircle, RefreshCw, AlertTriangle } from 'lucide-react';
import { applicationsApi } from '../services/api.ts';
import { useAuth } from '../contexts/AuthContext.tsx';
import {
  CriterionVerdict, PortfolioAnalysis, PortfolioCampaign, PortfolioCriterion, PortfolioReviewKind, PortfolioReviewResponse,
  PortfolioReviewedSite, PortfolioStatus,
} from '../types/index.ts';
import InfoTooltip from './shared/InfoTooltip.tsx';
import LinkifiedText, { safeHttpUrl } from './shared/LinkifiedText.tsx';

const VERDICT: Record<CriterionVerdict, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  strong:        { label: 'Evidenced',     cls: 'text-green-600', Icon: CheckCircle2 },
  partial:       { label: 'Partly',        cls: 'text-amber-600', Icon: CircleDashed },
  not_evidenced: { label: 'Not evidenced', cls: 'text-gray-400',  Icon: MinusCircle },
  concern:       { label: 'Concern',       cls: 'text-red-500',   Icon: AlertTriangle },
};

const PLATFORM_LABEL: Record<string, string> = {
  figma_file: 'Figma file', figma_site: 'Figma Sites', framer: 'Framer', behance: 'Behance', wix: 'Wix',
  dribbble: 'Dribbble', notion: 'Notion', adobe_portfolio: 'Adobe Portfolio', webflow: 'Webflow',
  squarespace: 'Squarespace', carrd: 'Carrd', cargo: 'Cargo', google_slides: 'Google Slides',
  pdf_file: 'PDF / file', custom: 'Own site',
  canva: 'Canva', medium: 'Medium', gdrive_file: 'Google Drive file', gdrive_folder: 'Google Drive folder',
  google_doc: 'Google Doc', google_sheet: 'Google Sheet', docx_file: 'Word document', pptx_file: 'PowerPoint',
  image_file: 'Image', video_file: 'Video file', youtube: 'YouTube', vimeo: 'Vimeo', loom: 'Loom',
  instagram: 'Instagram', linkedin: 'LinkedIn', social_other: 'Social profile', cloud_file: 'Cloud file', link_hub: 'Link page',
};
// A marketing sample's "custom" is as likely a brand or agency site as the candidate's own, and a pdf_file is a plain PDF.
const WORK_PLATFORM_LABEL: Record<string, string> = { ...PLATFORM_LABEL, pdf_file: 'PDF', custom: 'Website' };

const IN_PROGRESS: PortfolioStatus[] = ['pending', 'running'];

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

// Text that comes from the model or the candidate (an address, a hashtag) has no space to wrap at, and a long run of it
// used to push its column — and the next one — out of the card. min-w-0 lets a flex or grid child shrink below its text.
const WRAP = 'min-w-0 break-words [overflow-wrap:anywhere]';

// Everything worded for one kind of review. The designer values are the original strings, unchanged.
interface Copy {
  tooltip: string;
  inProgress: (status: 'pending' | 'running') => string;
  failedLead: string;
  failedKeptScore: (score: number) => string;
  failedNoScore: string;
  noPortfolioToast: string;
  queuedToast: string;
  notQueuedToast: string;
  // A re-run that settled at once, with nothing to queue (only the work-sample review can end like that).
  settledToasts?: Partial<Record<'unreviewable' | 'failed' | 'inaccessible', string>>;
  rerunErrorToast: string;
  strengths: string;
  concerns: string;
}

const COPY: Record<PortfolioReviewKind, Copy> = {
  design_portfolio: {
    tooltip: "The candidate's portfolio site(s) are opened in a browser and reviewed page by page against the JD and the hiring manager's 15 criteria. The result is scored 0-10 as the ninth ResumeIQ dimension and included in the overall score. It runs a few minutes after the resume is scored.",
    inProgress: s => `${s === 'running' ? 'Reviewing the portfolio now' : 'Portfolio review queued'} — the overall score shown is provisional and will update when it finishes (usually a few minutes).`,
    failedLead: 'The portfolio review could not be completed.',
    failedKeptScore: score => `The overall score still includes the previous review (${score}/10).`,
    failedNoScore: 'The overall score currently excludes the portfolio.',
    noPortfolioToast: 'No portfolio link found in the resume',
    queuedToast: 'Portfolio review queued',
    notQueuedToast: 'Saved, but could not be queued — try again shortly',
    rerunErrorToast: 'Could not re-run the portfolio review',
    strengths: '✓ Portfolio strengths',
    concerns: '⚠ Portfolio concerns',
  },
  marketing_work: {
    tooltip: "The work samples the candidate linked in their application answer (documents, decks, websites, images, videos) are opened and reviewed against the role's must-haves and nice-to-haves, weighing the quality of the evidence as well as what the work shows. The result is scored 0-10 as the ninth ResumeIQ dimension and included in the overall score — but only when there is work that could be reviewed; otherwise this dimension is not scored. Videos are judged from their title, description and thumbnails only (not watched), and LinkedIn and most social posts are never opened. It runs a few minutes after the resume is scored.",
    inProgress: s => `${s === 'running' ? 'Reviewing the linked work now' : 'Work-sample review queued'} — the overall score shown is provisional and will update if the review adds a score (usually a few minutes).`,
    failedLead: 'The work-sample review could not be completed.',
    failedKeptScore: score => `The overall score still includes the earlier review (${score}/10).`,
    failedNoScore: 'The overall score currently excludes this review.',
    noPortfolioToast: 'No work samples to review in the application answer — not scored',
    queuedToast: 'Work-sample review queued',
    notQueuedToast: 'Saved, but could not be queued — try again shortly',
    settledToasts: {
      unreviewable: 'Nothing could be opened automatically — not scored; open the links by hand',
      failed:       'No new work found — the earlier review still applies',
      inaccessible: 'The links are private or gone — not scored',
    },
    rerunErrorToast: 'Could not re-run the work-sample review',
    strengths: '✓ Work-sample strengths',
    concerns: '⚠ Work-sample concerns',
  },
};

const asKind = (v: unknown): PortfolioReviewKind | null => (v === 'marketing_work' || v === 'design_portfolio' ? v : null);

/**
 * Which review this is, or null while that is not known yet. A stored review names its own kind (absent on every
 * review made before kinds existed, which the backend then reports as the designer review); before any review
 * exists the response carries the role's kind.
 */
export const reviewKindOf = (data?: Pick<PortfolioReviewResponse, 'kind' | 'analysis'> | null): PortfolioReviewKind | null =>
  asKind(data?.analysis?.kind) ?? asKind(data?.kind);

// Stored messages end with a call to action aimed at HR ("Use Re-run to retry.").
// Hiring Managers have no Re-run button, so the card appends it for HR only.
const stripRetryHint = (m?: string | null) => (m ?? '').replace(/\s*Use Re-run to retry\.?\s*$/i, '').trim();

const shortUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '');

/**
 * The stored message of a review that never reached the queue ("Could not be queued (<the queue's own error>). Use
 * Re-run to retry."). The row stays 'pending' with it, so without this the card says a result is on its way.
 */
export const isNotQueued = (message?: string | null) => /^\s*Could not be queued/i.test(message ?? '');

// What a Re-run answered (202 { status, links, queued }), in words. Only 'pending' with queued=true means a job is on its
// way; the other outcomes settled on the spot, and "try again shortly" would invite pointless repeat clicks.
function rerunToast(copy: Copy, d: { status?: string; queued?: boolean }): string {
  if (d.status === 'no_portfolio') return copy.noPortfolioToast;
  const settled = d.status === 'unreviewable' || d.status === 'failed' || d.status === 'inaccessible' ? copy.settledToasts?.[d.status] : undefined;
  if (settled) return settled;
  return d.queued ? copy.queuedToast : copy.notQueuedToast;
}

/** The review for one application. Shared by the card and by anything that needs to know which kind of review it is (react-query makes it one request). */
export function usePortfolioReview(applicationId: string) {
  return useQuery<PortfolioReviewResponse>({
    queryKey: ['portfolio-review', applicationId],
    queryFn:  async () => (await applicationsApi.portfolioReview(applicationId)).data,
    // Keep polling while the queued job is running so the result appears on its own.
    // A review that could not be queued will never move on its own, so it is not polled for either.
    refetchInterval: (q) => {
      const d = q.state.data;
      return d?.status && IN_PROGRESS.includes(d.status) && !(d.status === 'pending' && isNotQueued(d.message)) ? 15_000 : false;
    },
  });
}

function VerdictRow({ verdict, label, evidence, wrap = false }: { verdict: CriterionVerdict; label: string; evidence: string; wrap?: boolean }) {
  const v = VERDICT[verdict];
  return (
    <li className={cx('flex gap-2 py-1', wrap && 'min-w-0')}>
      <v.Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${v.cls}`} aria-label={v.label} />
      <div className="min-w-0">
        <div className={cx('text-xs text-gray-700 font-medium leading-snug', wrap && WRAP)}>{label}</div>
        {evidence && <div className={cx('text-[11px] text-gray-500 leading-snug', wrap && WRAP)}>{evidence}</div>}
      </div>
    </li>
  );
}

function SiteRow({ site }: { site: PortfolioReviewedSite }) {
  const s = site.signals;
  const chips: string[] = [];
  if (site.accessible) {
    chips.push(`${site.pagesReviewed} page${site.pagesReviewed === 1 ? '' : 's'} reviewed`);
    if (s.brokenLinksChecked) chips.push(s.brokenLinks ? `${s.brokenLinks} of ${s.brokenLinksChecked} links broken` : `${s.brokenLinksChecked} links OK`);
    if (s.mobileOverflow === true) chips.push('breaks at phone width');
    if (s.mobileOverflow === false) chips.push('phone-friendly');
  }
  return (
    <li className="text-xs py-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px] font-medium">{PLATFORM_LABEL[site.platform] ?? site.platform}</span>
        <a href={site.url} target="_blank" rel="noreferrer" className="text-dp-600 hover:underline truncate max-w-[16rem] inline-flex items-center gap-1">
          {site.url.replace(/^https?:\/\/(www\.)?/, '')}<ExternalLink className="w-3 h-3 shrink-0" />
        </a>
        {site.belongsToCandidate === false && <span className="text-[10px] text-red-600 font-medium">not the candidate's</span>}
        {!site.isPortfolio && site.accessible && <span className="text-[10px] text-gray-500">not a design portfolio</span>}
      </div>
      {site.accessible
        ? <div className="text-[11px] text-gray-500 mt-0.5">{chips.join(' · ')}{site.note ? ` — ${site.note}` : ''}</div>
        : <div className="text-[11px] text-red-500 mt-0.5">{site.accessNote || 'Could not be opened'}</div>}
    </li>
  );
}

// ─── Marketing work samples ────────────────────────────────────────────────────────────────────────

const VIDEO_PLATFORMS = new Set(['youtube', 'vimeo', 'loom', 'video_file']);
const SOCIAL_PLATFORMS = new Set(['instagram', 'linkedin', 'social_other']);

export interface Coverage {
  label: string;
  // Why, when it is worth saying separately from the label.
  detail?: string;
  tone: 'ok' | 'partial' | 'warn' | 'neutral';
}

const COVERAGE_TONE: Record<Coverage['tone'], string> = {
  ok: 'text-green-700', partial: 'text-amber-700', warn: 'text-amber-700', neutral: 'text-gray-500',
};

/**
 * One line saying how much of a link was really looked at — shown next to every link, because a score is only
 * as good as what was read. Nothing here is held against the candidate: a private link asks for a re-share, a
 * link we could not open says so.
 */
export function coverageOf(site: PortfolioReviewedSite): Coverage {
  const outcome = site.outcome ?? (site.accessible ? 'ok' : 'inaccessible');   // a record that predates the outcome field
  const why = (site.reason || site.accessNote || '').trim();
  const isVideo = VIDEO_PLATFORMS.has(site.platform) || site.handler === 'video';
  const isSocial = SOCIAL_PLATFORMS.has(site.platform) || site.handler === 'social';

  if (outcome === 'inaccessible') {
    return { tone: 'warn', label: 'Private or unavailable — ask the candidate to re-share', detail: why || undefined };
  }
  if (outcome === 'failed') {
    return { tone: 'neutral', label: "Not reviewed — a problem on our side, not held against the candidate", detail: why || undefined };
  }
  if (outcome === 'unreviewable') {
    if (isSocial) return { tone: 'neutral', label: 'Not opened: social platform', detail: why || undefined };
    return { tone: 'neutral', label: `Not opened: ${why || 'cannot be reviewed automatically'}` };
  }
  // ok / partial — something was read.
  if (isVideo) return { tone: 'partial', label: 'Video: title, description and thumbnails only — not watched', detail: why || undefined };
  if (isSocial) return { tone: 'partial', label: 'Social post: public caption text only — the post itself was not opened', detail: why || undefined };
  if (outcome === 'partial' || site.coverage === 'partial' || site.coverage === 'metadata_only') {
    const detailsOnly = site.coverage === 'metadata_only' || site.basis === 'metadata';
    // A website is captured a few pages at a time, so "partial" on one means the pages after the cap were not opened.
    const fallback = detailsOnly ? 'details only, the content itself was not read' : site.handler === 'site' ? 'first pages read' : 'only part of it could be read';
    return { tone: 'partial', label: `Partly: ${why || fallback}` };
  }
  return { tone: 'ok', label: 'Reviewed' };
}

const ATTRIBUTION_CHIP: Partial<Record<NonNullable<PortfolioReviewedSite['attribution']>, string>> = {
  candidate_owned: 'credited to the candidate',
  led_team: 'candidate led the team',
  employer_or_client: 'employer or client work',
  unattributed: 'no credit shown',
  other_person: 'credits someone else',
};
const RELEVANCE_CHIP: Partial<Record<NonNullable<PortfolioReviewedSite['relevance']>, string>> = {
  profile_only: 'profile page, not a work sample',
  employer_site_no_attribution: 'employer site, no attribution',
  irrelevant: 'not marketing work',
};

const Chip = ({ children, tone = 'gray' }: { children: ReactNode; tone?: 'gray' | 'red' | 'amber' }) => (
  <span className={`max-w-full px-1.5 py-0.5 rounded text-[10px] ${WRAP} ${
    tone === 'red' ? 'bg-red-50 text-red-600 font-medium' : tone === 'amber' ? 'bg-amber-50 text-amber-700' : 'bg-gray-50 border border-gray-100 text-gray-500'
  }`}>{children}</span>
);

function UrlLink({ url }: { url: string }) {
  const href = safeHttpUrl(url);
  const label = shortUrl(url);
  // The label is what truncates, so a long address keeps its "opens in a new tab" icon.
  return href
    ? <a href={href} target="_blank" rel="noreferrer noopener" title={url} className="text-dp-600 hover:underline inline-flex items-center gap-1 max-w-[16rem]"><span className="truncate">{label}</span><ExternalLink className="w-3 h-3 shrink-0" /></a>
    : <span className="text-gray-600 truncate max-w-[16rem]" title={url}>{label}</span>;
}

function PlatformTag({ platform }: { platform: string }) {
  return <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px] font-medium">{WORK_PLATFORM_LABEL[platform] ?? platform}</span>;
}

function WorkRow({ site }: { site: PortfolioReviewedSite }) {
  const cov = coverageOf(site);
  const chips: string[] = [...(site.facts ?? [])];
  if (site.campaignsSeen) chips.push(`${site.campaignsSeen} campaign${site.campaignsSeen === 1 ? '' : 's'} seen`);
  const attribution = site.attribution ? ATTRIBUTION_CHIP[site.attribution] : undefined;
  const relevance = site.relevance ? RELEVANCE_CHIP[site.relevance] : undefined;
  return (
    <li className={cx('text-xs py-1.5', WRAP)} data-testid="work-link">
      <div className="flex items-center gap-2 flex-wrap">
        {site.ref && <span className="font-mono text-[10px] text-gray-500">{site.ref}</span>}
        <PlatformTag platform={site.platform} />
        <UrlLink url={site.url} />
        {site.attemptsToInfluenceReviewer && <Chip tone="red">contains text aimed at an AI reviewer</Chip>}
        {relevance && <Chip tone="amber">{relevance}</Chip>}
        {attribution && <Chip tone={site.attribution === 'other_person' ? 'red' : 'gray'}>{attribution}</Chip>}
      </div>
      <div className={`text-[11px] mt-0.5 ${WRAP} ${COVERAGE_TONE[cov.tone]}`} data-testid="coverage-line">
        {cov.label}{cov.detail && <span className="text-gray-500"> — {cov.detail}</span>}
      </div>
      {chips.length > 0 && <div className="flex flex-wrap gap-1 mt-0.5">{chips.map((c, i) => <Chip key={i}>{c}</Chip>)}</div>}
      {site.summary && <div className={`text-[11px] text-gray-500 leading-snug mt-0.5 ${WRAP}`}>{site.summary}</div>}
    </li>
  );
}

// ─── One list of links ─────────────────────────────────────────────────────────────────────────────
//
// A review lists every link it acquired under `portfolios` (each with an outcome) and the links it never opened by policy
// (LinkedIn, links over the cap, social profiles) under `unreviewed`; a review stored by an earlier build ALSO repeated
// every link it could not use in `unreviewed`. Read as two lists that showed a link twice and counted it twice in
// "Based on X of Y links" — so the card builds ONE list, keyed by address, and splits it into what was read and what was not.

/** One address compared the way a person would: scheme, "www.", a trailing slash and the #fragment do not make it another link. */
export function urlKey(raw: unknown): string {
  const s = String(raw ?? '').trim().slice(0, 500);   // the stored `unreviewed` addresses are cut at 500 characters
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return `${u.hostname.replace(/^www\./, '')}${u.port ? `:${u.port}` : ''}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    }
  } catch { /* not an address: compared as written */ }
  return s.toLowerCase();
}

// Only a link the model was shown has `coverage`. An item that was opened but dropped before the call (nothing readable,
// text aimed at the reviewer, over the size budget) can still say outcome ok or partial, but it never has a coverage.
const outcomeOfSite = (p: PortfolioReviewedSite) => p.outcome ?? (p.accessible ? 'ok' : 'inaccessible');
const wasRead = (p: PortfolioReviewedSite) => (outcomeOfSite(p) === 'ok' || outcomeOfSite(p) === 'partial') && !!p.coverage;
const readOnlyInPart = (p: PortfolioReviewedSite) => outcomeOfSite(p) === 'partial' || p.coverage === 'partial' || p.coverage === 'metadata_only';

export interface NotReviewedEntry {
  key: string;
  url: string;
  platform: string;
  reason: string;
  tone: Coverage['tone'];
  // The acquired record, when there is one (for its ref and its "text aimed at an AI reviewer" flag).
  site?: PortfolioReviewedSite;
}

export interface WorkLinks {
  // Links whose content really reached the reviewer, once each.
  reviewed: PortfolioReviewedSite[];
  // Everything else the candidate gave, once each, with why it was not read.
  notReviewed: NotReviewedEntry[];
  // Distinct addresses in all.
  total: number;
  // Of `reviewed`, how many were only partly read.
  partly: number;
}

function whyNotRead(site: PortfolioReviewedSite, listedReason?: string): Pick<NotReviewedEntry, 'reason' | 'tone'> {
  const outcome = outcomeOfSite(site);
  if (outcome === 'ok' || outcome === 'partial') {
    // It was opened, but nothing of it reached the review.
    const why = (site.reason || site.accessNote || listedReason || '').trim();
    return { tone: 'neutral', reason: `Not reviewed — ${why || 'nothing readable could be taken from it'}` };
  }
  const cov = coverageOf(site);
  return { tone: cov.tone, reason: cov.detail ? `${cov.label} — ${cov.detail}` : cov.label };
}

export function splitWorkLinks(a: Partial<Pick<PortfolioAnalysis, 'portfolios' | 'unreviewed'>>): WorkLinks {
  const sites = Array.isArray(a.portfolios) ? a.portfolios : [];
  const listed = Array.isArray(a.unreviewed) ? a.unreviewed : [];
  const reviewed = new Map<string, PortfolioReviewedSite>();
  const unread = new Map<string, PortfolioReviewedSite>();
  sites.forEach((p, i) => {
    if (!p || typeof p !== 'object') return;
    const key = urlKey(p.url) || `ref:${p.ref ?? i}`;
    if (wasRead(p)) { if (!reviewed.has(key)) reviewed.set(key, p); }
    else if (!unread.has(key)) unread.set(key, p);
  });
  const listedBy = new Map<string, { url: string; platform: string; reason: string }>();
  listed.forEach((u, i) => {
    if (!u || typeof u !== 'object') return;
    const key = urlKey(u.url) || `listed:${i}`;
    if (!listedBy.has(key)) listedBy.set(key, { url: String(u.url ?? ''), platform: String(u.platform ?? ''), reason: String(u.reason ?? '') });
  });

  const notReviewed: NotReviewedEntry[] = [];
  for (const [key, site] of unread) {
    if (reviewed.has(key)) continue;   // it was read after all (another record of the same address)
    notReviewed.push({ key, url: site.url, platform: site.platform, site, ...whyNotRead(site, listedBy.get(key)?.reason) });
  }
  for (const [key, u] of listedBy) {
    if (reviewed.has(key) || unread.has(key)) continue;
    notReviewed.push({ key, url: u.url, platform: u.platform, reason: u.reason, tone: 'neutral' });
  }
  const reviewedList = [...reviewed.values()];
  return { reviewed: reviewedList, notReviewed, total: reviewedList.length + notReviewed.length, partly: reviewedList.filter(readOnlyInPart).length };
}

function NotReviewedList({ entries }: { entries: NotReviewedEntry[] }) {
  if (!entries.length) return null;
  return (
    <div data-testid="unreviewed-list" className="min-w-0">
      <div className="text-[11px] font-medium text-gray-500 mb-0.5">Not reviewed — open these by hand</div>
      <ul className="divide-y divide-gray-50">
        {entries.map(e => (
          <li key={e.key} className={cx('text-xs py-1', WRAP)} data-testid="unreviewed-item">
            <div className="flex items-center gap-2 flex-wrap">
              {e.site?.ref && <span className="font-mono text-[10px] text-gray-500">{e.site.ref}</span>}
              <PlatformTag platform={e.platform} />
              <UrlLink url={e.url} />
              {e.site?.attemptsToInfluenceReviewer && <Chip tone="red">contains text aimed at an AI reviewer</Chip>}
            </div>
            {e.reason && <div className={`text-[11px] mt-0.5 ${WRAP} ${COVERAGE_TONE[e.tone]}`}>{e.reason}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

const BASIS_LABEL: Partial<Record<NonNullable<PortfolioCriterion['basis']>, { text: string; cls: string; title: string }>> = {
  seen:    { text: 'seen',    cls: 'bg-green-50 text-green-700',  title: 'Seen in the work itself' },
  read:    { text: 'read',    cls: 'bg-green-50 text-green-700',  title: 'Read in text taken from the work' },
  claimed: { text: 'claimed', cls: 'bg-amber-50 text-amber-700',  title: 'Stated by the candidate or the page, not shown in the work' },
};

const notAssessable = (c: PortfolioCriterion) => c.assessable === false || (c.group === 'corroboration' && c.verdict === 'not_evidenced');

function WorkCriterionRow({ c }: { c: PortfolioCriterion }) {
  const na = notAssessable(c);
  // A criterion the reviewer never answered (the backend's NOT_RETURNED_TEXT) is "not assessed", not something the work could not show.
  const notReturned = na && c.evidence === 'Not returned by the reviewer';
  const v = na ? { label: notReturned ? 'Not assessed' : 'Not assessable', cls: 'text-gray-400', Icon: MinusCircle } : VERDICT[c.verdict];
  const basis = c.basis ? BASIS_LABEL[c.basis] : undefined;
  return (
    <li className="flex gap-2 py-1 min-w-0">
      <v.Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${v.cls}`} aria-label={v.label} />
      <div className="min-w-0">
        <div className={`text-xs text-gray-700 font-medium leading-snug ${WRAP}`}>
          {c.label}
          {basis && <span className={`ml-1.5 align-middle px-1 py-px rounded text-[9px] font-normal ${basis.cls}`} title={`${basis.title}${c.source ? ` (${c.source})` : ''}`}>{basis.text}</span>}
        </div>
        {c.evidence && <div className={`text-[11px] text-gray-500 leading-snug ${WRAP}`}>{c.evidence}</div>}
      </div>
    </li>
  );
}

const CRITERIA_GROUPS: Array<{ id: NonNullable<PortfolioCriterion['group']>; title: string; hint: string }> = [
  { id: 'direct',        title: 'What the work shows',      hint: 'Things a portfolio can show for itself.' },
  { id: 'quality',       title: 'Evidence quality',         hint: 'How much of the work is attributable to the candidate, measured and finished.' },
  { id: 'corroboration', title: 'Corroborated elsewhere',   hint: 'A portfolio rarely proves these, and the 8 ResumeIQ dimensions already cover them. They count only when the work shows them and are otherwise left out.' },
];

function WorkCriteria({ criteria }: { criteria: PortfolioCriterion[] }) {
  const [showAll, setShowAll] = useState(false);
  if (!criteria.length) return null;
  const assessed = criteria.filter(c => !notAssessable(c));
  const strong = assessed.filter(c => c.verdict === 'strong').length;
  const concerns = assessed.filter(c => c.verdict === 'concern').length;
  const naTotal = criteria.length - assessed.length;
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <div className="text-[11px] font-medium text-gray-500">
          Criteria — {strong} evidenced{concerns ? `, ${concerns} concern${concerns > 1 ? 's' : ''}` : ''} of {assessed.length} assessable
        </div>
        {naTotal > 0 && (
          <button onClick={() => setShowAll(v => !v)} className="text-[11px] text-dp-600 hover:underline">
            {showAll ? 'Hide not assessable' : `Show ${naTotal} not assessable`}
          </button>
        )}
      </div>
      <div className="space-y-2">
        {CRITERIA_GROUPS.map(g => {
          // A row with no group (a record from an older build) is judged on what the work shows.
          const inGroup = criteria.filter(c => (c.group ?? 'direct') === g.id);
          const rows = showAll ? inGroup : inGroup.filter(c => !notAssessable(c));
          if (!rows.length) return null;
          return (
            <div key={g.id} data-testid={`criteria-group-${g.id}`}>
              <div className="text-[11px] font-semibold text-gray-600 mt-1">{g.title}</div>
              <div className="text-[11px] text-gray-500 leading-snug">{g.hint}</div>
              <ul className="grid sm:grid-cols-2 gap-x-4">{rows.map(c => <WorkCriterionRow key={c.id} c={c} />)}</ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ROLE_STATED: Record<NonNullable<PortfolioCampaign['roleStated']>, string> = { led: 'led', contributed: 'contributed', unclear: 'role unclear' };

function Campaigns({ items }: { items: PortfolioCampaign[] }) {
  if (!items.length) return null;
  return (
    <div data-testid="campaigns">
      <div className="text-[11px] font-medium text-gray-500 mb-0.5">Campaigns identified ({items.length})</div>
      <ul className="text-xs text-gray-600 space-y-0.5">
        {items.map((c, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 min-w-0">
            <span className={`max-w-full ${WRAP}`}>• <span className="font-medium text-gray-700">{c.name}</span>{c.metric ? ` — ${c.metric}` : ''}</span>
            {c.roleStated && <Chip>{ROLE_STATED[c.roleStated] ?? c.roleStated}</Chip>}
            {c.ref && <span className="font-mono text-[10px] text-gray-500">{c.ref}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// "Based on 2 of 5 links" — the score in front of the reader is only as good as what was read. Counted over DISTINCT
// addresses (splitWorkLinks), so a link is one link however many lists it was stored in.
export function coverageSummary(links: WorkLinks): string | null {
  if (!links.total) return null;
  const rest = links.total - links.reviewed.length;
  return `Based on ${links.reviewed.length} of ${links.total} link${links.total === 1 ? '' : 's'}${links.partly ? ` (${links.partly} only partly read)` : ''}${rest ? `; ${rest} not reviewed, listed below` : ''}.`;
}

// ─── Caps and audit notes ──────────────────────────────────────────────────────────────────────────

// An internal criterion id leading a note ("mh3: …", "nh2: …", "eq_ownership: …").
const CRITERION_PREFIX = /^\s*(?:(?:mh|nh)\d+|eq_[a-z]+)\s*:\s*/i;

/**
 * `caps` is for what really lowered the score ("… capped at 5"). A review stored by an earlier build also put its audit
 * notes there (a verdict lowered because a quote was not found, the fairness-filter note), which then read as
 * "Score capped: …" on a score that was never capped. Those move to `notes`, with the criterion id swapped for the
 * criterion's name (or dropped when it is not known) so no internal id reaches the screen.
 */
export function splitCaps(a: Partial<Pick<PortfolioAnalysis, 'caps' | 'evidenceNotes' | 'criteria'>>): { caps: string[]; notes: string[] } {
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean) : []);
  const labelOf = new Map((Array.isArray(a.criteria) ? a.criteria : []).filter(c => c && typeof c.id === 'string').map(c => [c.id.toLowerCase(), c.label]));
  const caps: string[] = [];
  const notes: string[] = [];
  const addNote = (n: string) => {
    const id = /^\s*((?:mh|nh)\d+|eq_[a-z]+)\s*:/i.exec(n)?.[1]?.toLowerCase();
    const rest = n.replace(CRITERION_PREFIX, '').trim();
    const label = id ? labelOf.get(id) : undefined;
    const text = label && rest ? `${label} — ${rest}` : rest;
    if (text && !notes.includes(text)) notes.push(text);
  };
  for (const c of strings(a.caps)) {
    if (/capped at/i.test(c) && !CRITERION_PREFIX.test(c)) { if (!caps.includes(c)) caps.push(c); }
    else addNote(c);
  }
  for (const n of strings(a.evidenceNotes)) addNote(n);
  return { caps, notes };
}

function EvidenceNotes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <details data-testid="evidence-notes" className="text-[11px] text-gray-500">
      <summary className="cursor-pointer font-medium hover:text-gray-700">How the evidence was checked</summary>
      <ul className={`mt-1 space-y-0.5 ${WRAP}`}>{notes.map((n, i) => <li key={i}>• {n}</li>)}</ul>
    </details>
  );
}

const CONFIDENCE: Record<NonNullable<PortfolioAnalysis['confidence']>, { label: string; cls: string }> = {
  high:   { label: 'High confidence',   cls: 'bg-green-50 text-green-700' },
  medium: { label: 'Medium confidence', cls: 'bg-amber-50 text-amber-700' },
  low:    { label: 'Low confidence',    cls: 'bg-orange-50 text-orange-700' },
};

function ConfidenceChip({ confidence }: { confidence?: PortfolioAnalysis['confidence'] }) {
  const c = confidence ? CONFIDENCE[confidence] : undefined;
  if (!c) return null;
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${c.cls}`} title="How well the work that could be reviewed supports this score">{c.label}</span>;
}

function WorkReview({ a }: { a: PortfolioAnalysis }) {
  const criteria = a.criteria ?? [];
  const highlights = a.highlights ?? [];
  const redFlags = a.redFlags ?? [];
  const nice = a.jdAlignment?.niceToHaves ?? [];
  const niceShown = nice.filter(n => n.verdict !== 'not_evidenced');
  const links = splitWorkLinks(a);
  const summary = coverageSummary(links);
  const { caps, notes } = splitCaps(a);
  return (
    <>
      {summary && <p className="text-[11px] text-gray-500" data-testid="coverage-summary">{summary}</p>}
      {caps.length > 0 && (
        <p className={`text-[11px] text-amber-700 ${WRAP}`} data-testid="caps-note">Score capped: {caps.join('; ')}</p>
      )}

      {a.summary && <p className={`text-xs text-gray-600 leading-relaxed ${WRAP}`}>{a.summary}</p>}

      {links.reviewed.length > 0 && (
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-gray-500 mb-0.5">Work reviewed</div>
          <ul className="divide-y divide-gray-50">{links.reviewed.map((p, i) => <WorkRow key={`${p.url}-${i}`} site={p} />)}</ul>
        </div>
      )}

      <NotReviewedList entries={links.notReviewed} />

      {(highlights.length > 0 || redFlags.length > 0) && (
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="min-w-0">
            <div className="text-xs text-green-600 font-medium mb-1">{COPY.marketing_work.strengths}</div>
            {highlights.length ? <ul className={`text-xs text-gray-600 space-y-0.5 ${WRAP}`}>{highlights.map((h, i) => <li key={i}>• {h}</li>)}</ul> : <p className="text-xs text-gray-500">—</p>}
          </div>
          <div className="min-w-0">
            <div className="text-xs text-red-500 font-medium mb-1">{COPY.marketing_work.concerns}</div>
            {redFlags.length ? <ul className={`text-xs text-gray-600 space-y-0.5 ${WRAP}`}>{redFlags.map((h, i) => <li key={i}>• {h}</li>)}</ul> : <p className="text-xs text-gray-500">None noted</p>}
          </div>
        </div>
      )}

      <Campaigns items={a.campaigns ?? []} />

      <WorkCriteria criteria={criteria} />

      {nice.length > 0 && (
        <div data-testid="nice-to-haves" className="min-w-0">
          <div className="text-[11px] font-medium text-gray-500 mb-0.5">
            Nice-to-haves{nice.length > niceShown.length ? ` — ${nice.length - niceShown.length} of ${nice.length} not evidenced` : ''}
          </div>
          {niceShown.length > 0 && <ul>{niceShown.map((n, i) => <VerdictRow key={i} verdict={n.verdict} label={n.item} evidence={n.evidence} wrap />)}</ul>}
        </div>
      )}

      {(a.unverifiedClaims ?? []).length > 0 && (
        <div data-testid="unverified-claims" className="min-w-0">
          <div className="text-[11px] font-medium text-gray-500 mb-0.5">Unverified claims — stated, but not shown in the work</div>
          <ul className={`text-xs text-gray-600 space-y-0.5 ${WRAP}`}>{a.unverifiedClaims!.map((c, i) => <li key={i}>• {c}</li>)}</ul>
        </div>
      )}

      <EvidenceNotes notes={notes} />
    </>
  );
}

type NotScoredStatus = 'no_portfolio' | 'inaccessible' | 'unreviewable';

// A marketing review with nothing it could score. Says why in plain words, what that does to the average, and
// still lists whatever was provided so HR can look by hand.
function WorkNotScored({ status, data, header, canHR }: { status: NotScoredStatus; data: PortfolioReviewResponse | undefined; header: ReactNode; canHR: boolean }) {
  const a = data?.analysis ?? null;
  const claim = (a?.claimText ?? '').trim();
  const links = splitWorkLinks(a ?? {});
  const urls = data?.urls ?? [];
  const textOnly = status === 'no_portfolio' && !!claim && links.total + urls.length === 0;

  const fallback =
    status === 'inaccessible' ? 'The linked work is private, deleted or could not be opened.' :
    status === 'unreviewable' ? 'The linked work cannot be opened by an automated review.' :
    textOnly ? 'Only a written description was provided — there are no work samples to review.' :
    links.reviewed.length > 0 ? 'The linked material was reviewed, but none of it is marketing work.' :
    'No work samples were provided.';
  const reason = `${stripRetryHint(data?.message) || fallback}${canHR && /Use Re-run/i.test(data?.message ?? '') ? ' Use Re-run to retry.' : ''}`;

  return (
    <div className={`rounded-lg border border-gray-200 bg-gray-50/60 p-3 space-y-2 ${WRAP}`}>
      {header}
      <p className="text-xs text-gray-700">
        <span className="mr-1.5 px-1.5 py-0.5 rounded bg-gray-200 text-gray-700 text-[10px] font-medium">Not scored</span>
        {reason}
      </p>
      {a && a.model !== 'none' && a.summary && <p className="text-xs text-gray-600 leading-relaxed">{a.summary}</p>}
      {data?.score == null && (
        <p className="text-[11px] text-gray-500">This dimension is left out: the overall score is the average of the 8 ResumeIQ dimensions only.</p>
      )}
      {status === 'inaccessible' && (
        <p className="text-[11px] text-gray-500">Ask the candidate to re-share the link so that anyone with the link can view it{canHR ? ', then press Re-run' : ''}.</p>
      )}

      {claim && (
        <div data-testid="claim-text">
          <div className="text-[11px] font-medium text-gray-500 mb-0.5">Described by the candidate (unverified)</div>
          <p className={`text-xs text-gray-600 border-l-2 border-gray-200 pl-2 whitespace-pre-line ${WRAP}`}><LinkifiedText text={claim} /></p>
          {textOnly && <div className="text-[11px] text-gray-500 mt-0.5">Text only: not scored</div>}
        </div>
      )}

      {links.reviewed.length > 0 && (
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-gray-500 mb-0.5">Links looked at</div>
          <ul className="divide-y divide-gray-100">{links.reviewed.map((p, i) => <WorkRow key={`${p.url}-${i}`} site={p} />)}</ul>
        </div>
      )}
      <NotReviewedList entries={links.notReviewed} />
      {links.total === 0 && urls.length > 0 && (
        <div>
          <div className="text-[11px] font-medium text-gray-500 mb-0.5">Links in the answer</div>
          <ul>{urls.map((u, i) => (
            <li key={`${u.url}-${i}`} className="text-xs py-1 flex items-center gap-2 flex-wrap"><PlatformTag platform={u.platform} /><UrlLink url={u.url} /></li>
          ))}</ul>
        </div>
      )}
    </div>
  );
}

// ─── The card ──────────────────────────────────────────────────────────────────────────────────────

export default function PortfolioReviewCard({ applicationId, status: initialStatus }: { applicationId: string; status?: PortfolioStatus | null }) {
  const { canHR } = useAuth();
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);

  const { data, isLoading, isError, isFetching, refetch } = usePortfolioReview(applicationId);

  // Only a review that loaded can name its kind; one that failed to load must not borrow the designer's wording.
  const kind: PortfolioReviewKind = reviewKindOf(data) ?? 'design_portfolio';
  const copy = COPY[kind];
  const marketing = kind === 'marketing_work';

  const rerun = useMutation({
    mutationFn: () => applicationsApi.rerunPortfolio(applicationId),
    onSuccess: (res) => {
      toast.success(rerunToast(copy, res.data as { status: string; links: number; queued: boolean }));
      qc.invalidateQueries({ queryKey: ['portfolio-review', applicationId] });
      qc.invalidateQueries({ queryKey: ['applications'] });
      qc.invalidateQueries({ queryKey: ['candidate'] });   // the average / summary can change right away (e.g. no link found)
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error || copy.rerunErrorToast);
    },
  });

  const status = data?.status ?? initialStatus ?? null;

  // The review finishing changes score_avg, the summary and the red flags on the
  // application itself — which the page around this card loaded separately and
  // would otherwise keep showing stale ("provisional") until a manual refresh.
  const prevStatus = useRef<PortfolioStatus | null>(null);
  useEffect(() => {
    const prev = prevStatus.current;
    if (prev && IN_PROGRESS.includes(prev) && status && !IN_PROGRESS.includes(status)) {
      qc.invalidateQueries({ queryKey: ['candidate'] });
      qc.invalidateQueries({ queryKey: ['applications'] });
    }
    prevStatus.current = status;
  }, [status, qc]);

  // Until the review arrives the card cannot know which kind it is, and a designer's wording on a marketing
  // candidate (or the reverse) is wrong — so wait for it rather than guess from the application's status alone.
  if (isLoading && !data) return <div className="text-xs text-gray-400 py-2">Loading portfolio review…</div>;
  // A failed load is its own state: with no review in hand the card knows neither the kind nor the outcome, so it says so
  // (and offers another try) instead of dressing the application row's status in the designer's words — or vanishing.
  if (isError && !data) {
    return (
      <div role="alert" className="rounded-lg border border-red-100 bg-red-50/40 p-3 space-y-1">
        <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Portfolio review</span>
        <p className="text-xs text-red-600">Could not load the review.</p>
        <button onClick={() => { void refetch(); }} disabled={isFetching}
          className="inline-flex items-center gap-1 text-[11px] text-dp-600 hover:text-dp-700 hover:underline font-medium disabled:opacity-50">
          <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin' : ''}`} /> Retry
        </button>
      </div>
    );
  }
  if (!status) return null;

  const a = data?.analysis ?? null;
  // Offered while 'running' too: a worker killed mid-job never clears that state,
  // and the backend (not the UI) is the one that knows whether the job is live — it
  // answers 409 for a live one and reclaims a stale one.
  const rerunBtn = canHR && (
    <button onClick={() => rerun.mutate()} disabled={rerun.isPending}
      className="inline-flex items-center gap-1 text-[11px] text-dp-600 hover:text-dp-700 hover:underline font-medium disabled:opacity-50">
      <RefreshCw className={`w-3 h-3 ${rerun.isPending ? 'animate-spin' : ''}`} /> Re-run
    </button>
  );

  const header = (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Portfolio review</span>
        <InfoTooltip align="left" text={copy.tooltip} />
      </div>
      <div className="flex items-center gap-3">
        {data?.score != null && <span className="text-sm font-bold text-gray-900">{data.score}<span className="text-xs font-normal text-gray-400">/10</span></span>}
        {marketing && status === 'completed' && <ConfidenceChip confidence={a?.confidence} />}
        {rerunBtn}
      </div>
    </div>
  );

  // The row says 'pending' but the queue refused it: nothing is on its way, so no spinner, no "will update", no polling, and
  // none of the queue's own error text (it names internal packages and file paths) — just that it needs another try.
  if (status === 'pending' && isNotQueued(data?.message)) {
    return (
      <div className={cx('rounded-lg border border-amber-200 bg-amber-50/50 p-3 space-y-1', marketing && WRAP)}>
        {header}
        <p className="text-xs text-gray-700">
          <span className="mr-1.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-medium">Not queued</span>
          The review could not be queued.{canHR ? ' Use Re-run to retry.' : ''}
        </p>
        <p className="text-[11px] text-gray-500">{data?.score != null ? copy.failedKeptScore(data.score) : copy.failedNoScore}</p>
      </div>
    );
  }

  if (status === 'pending' || status === 'running') {
    return (
      <div className={cx('rounded-lg border border-dp-100 bg-dp-50/40 p-3 space-y-1', marketing && WRAP)}>
        {header}
        <p className="text-xs text-gray-600 flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-dp-600" />
          {copy.inProgress(status)}
        </p>
        {stripRetryHint(data?.message) && <p className="text-[11px] text-amber-700">{stripRetryHint(data?.message)}{canHR && /Use Re-run/i.test(data?.message ?? '') ? ' Use Re-run to retry.' : ''}</p>}
      </div>
    );
  }

  if (status === 'failed') {
    // A marketing re-run that finds nothing new keeps the earlier score; its message already says so ("the earlier review (7/10) still applies").
    const keptScoreLine = data?.score != null
      ? (marketing && (data?.message ?? '').includes(`(${data.score}/10)`) ? '' : copy.failedKeptScore(data.score))
      : copy.failedNoScore;
    return (
      <div className={cx('rounded-lg border border-red-100 bg-red-50/40 p-3 space-y-1', marketing && WRAP)}>
        {header}
        <p className="text-xs text-red-600">{copy.failedLead} {stripRetryHint(data?.message)}</p>
        <p className="text-[11px] text-gray-500">
          {keptScoreLine}
          {canHR ? `${keptScoreLine ? ' ' : ''}Use Re-run to retry.` : ''}
        </p>
      </div>
    );
  }

  if (marketing && (status === 'no_portfolio' || status === 'inaccessible' || status === 'unreviewable')) {
    return <WorkNotScored status={status} data={data} header={header} canHR={canHR} />;
  }

  if (status === 'no_portfolio' || (!a && (status === 'inaccessible' || status === 'unreviewable'))) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-3 space-y-1">
        {header}
        <p className="text-xs text-gray-600">
          {status === 'no_portfolio' ? 'No portfolio was found for this candidate.'
            : status === 'unreviewable' ? 'The portfolio link(s) could not be opened by an automated review (bot protection or an unsupported link).'
            : 'The portfolio link(s) could not be opened.'} {data?.message || ''}
        </p>
        {data?.urls?.length ? <ul>{data.urls.map(u => <li key={u.url} className="text-[11px] text-gray-500">{u.url}</li>)}</ul> : null}
      </div>
    );
  }

  // A finished review whose details are not on file: say so rather than leaving the page with a score and nothing behind it.
  if (!a) {
    return (
      <div className={cx('rounded-lg border border-gray-200 bg-gray-50/60 p-3 space-y-1', marketing && WRAP)}>
        {header}
        <p className="text-xs text-gray-600">The review finished, but its details are not available.</p>
      </div>
    );
  }

  if (marketing) {
    return (
      <div className={`rounded-lg border border-gray-200 bg-white p-3 space-y-3 ${WRAP}`}>
        {header}
        <WorkReview a={a} />
        <p className="text-[11px] text-gray-500">
          Reviewed {new Date(a.analyzedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
          {a.model !== 'none' && (a.criteria ?? []).length > 0 && (
            (a.evidenceNotes ?? []).some(n => /the checklist was not used/i.test(n))
              ? ` · judgement ${a.modelScore}/10 (checklist not used)`
              : ` · judgement ${a.modelScore}/10, checklist ${a.checklistScore}/10`
          )}
        </p>
      </div>
    );
  }

  const strongCount = a.criteria.filter(c => c.verdict === 'strong').length;
  const concernCount = a.criteria.filter(c => c.verdict === 'concern').length;
  const shownCriteria = showAll ? a.criteria : a.criteria.filter(c => c.verdict !== 'not_evidenced');
  const hiddenCount = a.criteria.length - shownCriteria.length;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-3">
      {header}

      {a.summary && <p className="text-xs text-gray-600 leading-relaxed">{a.summary}</p>}

      {a.portfolios.length > 0 && (
        <div>
          <div className="text-[11px] font-medium text-gray-500 mb-0.5">Portfolios reviewed</div>
          <ul className="divide-y divide-gray-50">{a.portfolios.map(p => <SiteRow key={p.url} site={p} />)}</ul>
        </div>
      )}

      {(a.highlights.length > 0 || a.redFlags.length > 0) && (
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-green-600 font-medium mb-1">{copy.strengths}</div>
            {a.highlights.length ? <ul className="text-xs text-gray-600 space-y-0.5">{a.highlights.map((h, i) => <li key={i}>• {h}</li>)}</ul> : <p className="text-xs text-gray-400">—</p>}
          </div>
          <div>
            <div className="text-xs text-red-500 font-medium mb-1">{copy.concerns}</div>
            {a.redFlags.length ? <ul className="text-xs text-gray-600 space-y-0.5">{a.redFlags.map((h, i) => <li key={i}>• {h}</li>)}</ul> : <p className="text-xs text-gray-400">None noted</p>}
          </div>
        </div>
      )}

      {a.criteria.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-0.5">
            <div className="text-[11px] font-medium text-gray-500">
              Hiring manager criteria — {strongCount} evidenced{concernCount ? `, ${concernCount} concern${concernCount > 1 ? 's' : ''}` : ''} of {a.criteria.length}
            </div>
            {hiddenCount > 0 || showAll ? (
              <button onClick={() => setShowAll(v => !v)} className="text-[11px] text-dp-600 hover:underline">
                {showAll ? 'Hide not-evidenced' : `Show ${hiddenCount} not evidenced`}
              </button>
            ) : null}
          </div>
          <ul className="grid sm:grid-cols-2 gap-x-4">{shownCriteria.map(c => <VerdictRow key={c.id} verdict={c.verdict} label={c.label} evidence={c.evidence} />)}</ul>
        </div>
      )}

      {(a.jdAlignment.mustHaves.length > 0 || a.jdAlignment.niceToHaves.length > 0) && (
        <div className="grid sm:grid-cols-2 gap-x-4 gap-y-2">
          {([['Must-haves from the JD', a.jdAlignment.mustHaves], ['Nice-to-haves', a.jdAlignment.niceToHaves]] as const).map(([title, items]) => items.length > 0 && (
            <div key={title}>
              <div className="text-[11px] font-medium text-gray-500 mb-0.5">{title}</div>
              <ul>{items.map((it, i) => <VerdictRow key={i} verdict={it.verdict} label={it.item} evidence={it.evidence} />)}</ul>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-gray-500">
        Reviewed {new Date(a.analyzedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
        {a.model !== 'none' && a.criteria.length > 0 && ` · judgement ${a.modelScore}/10, checklist ${a.checklistScore}/10`}
      </p>
    </div>
  );
}
