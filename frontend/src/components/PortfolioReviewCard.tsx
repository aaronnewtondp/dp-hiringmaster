import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckCircle2, CircleDashed, ExternalLink, Loader2, MinusCircle, RefreshCw, AlertTriangle } from 'lucide-react';
import { applicationsApi } from '../services/api.ts';
import { useAuth } from '../contexts/AuthContext.tsx';
import { CriterionVerdict, PortfolioReviewResponse, PortfolioReviewedSite, PortfolioStatus } from '../types/index.ts';
import InfoTooltip from './shared/InfoTooltip.tsx';

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
};

const IN_PROGRESS: PortfolioStatus[] = ['pending', 'running'];

function VerdictRow({ verdict, label, evidence }: { verdict: CriterionVerdict; label: string; evidence: string }) {
  const v = VERDICT[verdict];
  return (
    <li className="flex gap-2 py-1">
      <v.Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${v.cls}`} aria-label={v.label} />
      <div className="min-w-0">
        <div className="text-xs text-gray-700 font-medium leading-snug">{label}</div>
        {evidence && <div className="text-[11px] text-gray-500 leading-snug">{evidence}</div>}
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

export default function PortfolioReviewCard({ applicationId, status: initialStatus }: { applicationId: string; status?: PortfolioStatus | null }) {
  const { canHR } = useAuth();
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);

  const { data, isLoading } = useQuery<PortfolioReviewResponse>({
    queryKey: ['portfolio-review', applicationId],
    queryFn:  async () => (await applicationsApi.portfolioReview(applicationId)).data,
    // Keep polling while the queued job is running so the result appears on its own.
    refetchInterval: (q) => (q.state.data?.status && IN_PROGRESS.includes(q.state.data.status) ? 15_000 : false),
  });

  const rerun = useMutation({
    mutationFn: () => applicationsApi.rerunPortfolio(applicationId),
    onSuccess: (res) => {
      const d = res.data as { status: string; links: number; queued: boolean };
      toast.success(d.status === 'no_portfolio' ? 'No portfolio link found in the resume' : d.queued ? 'Portfolio review queued' : 'Saved, but could not be queued — try again shortly');
      qc.invalidateQueries({ queryKey: ['portfolio-review', applicationId] });
      qc.invalidateQueries({ queryKey: ['applications'] });
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error || 'Could not re-run the portfolio review');
    },
  });

  const status = data?.status ?? initialStatus ?? null;
  if (isLoading && !status) return <div className="text-xs text-gray-400 py-2">Loading portfolio review…</div>;
  if (!status) return null;

  const a = data?.analysis ?? null;
  const rerunBtn = canHR && status !== 'running' && (
    <button onClick={() => rerun.mutate()} disabled={rerun.isPending}
      className="inline-flex items-center gap-1 text-[11px] text-dp-600 hover:text-dp-700 hover:underline font-medium disabled:opacity-50">
      <RefreshCw className={`w-3 h-3 ${rerun.isPending ? 'animate-spin' : ''}`} /> Re-run
    </button>
  );

  const header = (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Portfolio review</span>
        <InfoTooltip align="left" text="The candidate's portfolio site(s) are opened in a browser and reviewed page by page against the JD and the hiring manager's 15 criteria. The result is scored 0-10 as the ninth ResumeIQ dimension and included in the overall score. It runs a few minutes after the resume is scored." />
      </div>
      <div className="flex items-center gap-3">
        {data?.score != null && <span className="text-sm font-bold text-gray-900">{data.score}<span className="text-xs font-normal text-gray-400">/10</span></span>}
        {rerunBtn}
      </div>
    </div>
  );

  if (IN_PROGRESS.includes(status)) {
    return (
      <div className="rounded-lg border border-dp-100 bg-dp-50/40 p-3 space-y-1">
        {header}
        <p className="text-xs text-gray-600 flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-dp-600" />
          {status === 'running' ? 'Reviewing the portfolio now' : 'Portfolio review queued'} — the overall score shown is provisional and will update when it finishes (usually a few minutes).
        </p>
        {data?.message && <p className="text-[11px] text-amber-700">{data.message}</p>}
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="rounded-lg border border-red-100 bg-red-50/40 p-3 space-y-1">
        {header}
        <p className="text-xs text-red-600">The portfolio review could not be completed. {data?.message || ''}</p>
        <p className="text-[11px] text-gray-500">The overall score currently excludes the portfolio. Use Re-run to retry.</p>
      </div>
    );
  }

  if (status === 'no_portfolio' || (!a && status === 'inaccessible')) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-3 space-y-1">
        {header}
        <p className="text-xs text-gray-600">
          {status === 'no_portfolio' ? 'No portfolio was found for this candidate.' : 'The portfolio link(s) could not be opened.'} {data?.message || ''}
        </p>
        {data?.urls?.length ? <ul>{data.urls.map(u => <li key={u.url} className="text-[11px] text-gray-500">{u.url}</li>)}</ul> : null}
      </div>
    );
  }

  if (!a) return null;

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
            <div className="text-xs text-green-600 font-medium mb-1">✓ Portfolio strengths</div>
            {a.highlights.length ? <ul className="text-xs text-gray-600 space-y-0.5">{a.highlights.map((h, i) => <li key={i}>• {h}</li>)}</ul> : <p className="text-xs text-gray-400">—</p>}
          </div>
          <div>
            <div className="text-xs text-red-500 font-medium mb-1">⚠ Portfolio concerns</div>
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

      <p className="text-[10px] text-gray-300">
        Reviewed {new Date(a.analyzedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} · judgement {a.modelScore}/10, checklist {a.checklistScore}/10
      </p>
    </div>
  );
}
