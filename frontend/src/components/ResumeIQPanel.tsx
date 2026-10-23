import { Application, PortfolioReviewKind, PortfolioStatus } from '../types/index.ts';
import InfoTooltip from './shared/InfoTooltip.tsx';
import PortfolioReviewCard, { isNotQueued, reviewKindOf, usePortfolioReview } from './PortfolioReviewCard.tsx';

const scoreColor = (s?: number | null) => {
  if (s == null) return 'text-gray-300';
  if (s >= 8) return 'text-green-600 font-semibold';
  if (s >= 6) return 'text-dp-600 font-medium';
  if (s >= 4) return 'text-amber-600';
  return 'text-red-500';
};

// Hover text on the 9th row's label. It cannot be an InfoTooltip: the table sits in an overflow-x-auto box, which
// would clip a popover opened below its last row. The kind is read from the review itself (null until it arrives).
const PORTFOLIO_ROW_INFO: Record<PortfolioReviewKind | 'unknown', string> = {
  design_portfolio: "Ninth dimension for designer roles: the candidate's portfolio site(s) are opened in a browser and reviewed against the JD and the hiring manager's criteria. Scored 0-10 and averaged in with the 8 dimensions above once the review finishes.",
  marketing_work: "Ninth dimension for the Head of Marketing role: the work samples the candidate linked in their application are reviewed against the role's requirements. Scored 0-10 and averaged in with the 8 dimensions above, but left out of the average when there is nothing that could be reviewed (no samples, text only, private or unopenable links).",
  unknown: "Ninth dimension for designer and Head of Marketing roles: a review of the candidate's portfolio or linked work samples, scored 0-10 and averaged in with the 8 dimensions above once it finishes. Not scored when there is nothing that could be reviewed.",
};

// What to say in the Portfolio row when the review ended without a score — worded for either kind, since the
// row must say something sensible before (or without) knowing which review this is.
const NOT_SCORED_NOTE: Partial<Record<PortfolioStatus, string>> = {
  no_portfolio: 'Not scored — no portfolio or work samples to review',
  inaccessible: 'Not scored — the linked work is private or unavailable',
  unreviewable: 'Not scored — the linked work cannot be opened automatically',
  failed:       'Review failed — not included in the average',
};

function PortfolioDimensionRow({ app }: { app: Application }) {
  const { data } = usePortfolioReview(app.id);
  const kind = reviewKindOf(data);
  const status = app.portfolio_analysis_status;
  const inProgress = status === 'pending' || status === 'running';
  const score = app.score_portfolio ?? undefined;

  let note: string | undefined = (app.score_portfolio_note ?? undefined) || undefined;
  const notScored = score == null && status ? NOT_SCORED_NOTE[status] : undefined;
  // 'pending' with the queue's refusal on record: nothing is on its way, so "in progress" would be a promise nobody keeps.
  if (status === 'pending' && isNotQueued(app.portfolio_analysis_error)) note = 'Could not be queued — not included in the average until it is re-run';
  else if (inProgress) note = 'Review in progress — overall score is provisional';
  else if (notScored) {
    // No score: the stored message (shown without its "Use Re-run" hint — this table has no button) says why.
    note = (app.portfolio_analysis_error ?? '').replace(/\s*Use Re-run to retry\.?\s*$/i, '').trim() || notScored;
  }

  return (
    <tr className="border-b border-gray-50 last:border-0">
      <td className="py-1.5 px-1 text-gray-500 whitespace-nowrap w-32" title={PORTFOLIO_ROW_INFO[kind ?? 'unknown']}>Portfolio</td>
      <td className={`py-1.5 px-1 w-10 text-right ${scoreColor(score)}`}>{score != null ? score : '—'}</td>
      <td className="py-1.5 px-2 text-gray-400 italic">{note || ''}</td>
    </tr>
  );
}

// ─── 8-dimension ResumeIQ table — mirrors digitalpaani-candidate-scoring output exactly
// (designer and Head of Marketing roles add a 9th 'Portfolio' row from the separate portfolio review)
export default function ResumeIQPanel({ app }: { app: Application }) {
  if (app.score_avg == null) {
    return (
      <div className="border-t border-gray-100 pt-3 mt-3">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">ResumeIQ</span>
        <p className="text-xs text-gray-400 mt-1">Not scored — the automatic scoring at application time didn't complete. HR/Admin can retry it from My Tasks → Ready for Review.</p>
      </div>
    );
  }

  const DIMENSIONS: Array<{ label: string; score?: number; note?: string }> = [
    { label: 'Technical',     score: app.score_technical,     note: app.score_technical_note },
    { label: 'Experience',    score: app.score_experience,    note: app.score_experience_note },
    { label: 'Industry Fit',  score: app.score_industry_fit,  note: app.score_industry_fit_note },
    { label: 'Culture Fit',   score: app.score_culture_fit,   note: app.score_culture_fit_note },
    { label: 'Role Alignment',score: app.score_role_alignment,note: app.score_role_alignment_note },
    { label: 'Trajectory',    score: app.score_trajectory,    note: app.score_trajectory_note },
    { label: 'Leadership',    score: app.score_leadership,    note: app.score_leadership_note },
    { label: 'Communication', score: app.score_communication, note: app.score_communication_note },
  ];
  const hasPortfolio = !!app.portfolio_analysis_status;

  const recColor =
    app.score_recommendation === 'Strong Yes' ? 'bg-green-100 text-green-800' :
    app.score_recommendation === 'Yes'        ? 'bg-dp-100 text-dp-800' :
    app.score_recommendation === 'Maybe'      ? 'bg-amber-100 text-amber-800' :
    'bg-red-100 text-red-800';

  return (
    <div className="border-t border-gray-100 pt-3 mt-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">ResumeIQ Analysis</span>
          <InfoTooltip align="left" text="Scored automatically the moment this candidate applied, across 8 dimensions — averaged into the score shown here. The Senior UX/Product Designer and Head of Marketing roles add a ninth, Portfolio, once the portfolio or work-sample review finishes a few minutes later (for Head of Marketing it is left out when there is nothing to review). Reads the actual resume text from Drive when it can; falls back to scoring from profile fields alone if the resume can't be fetched (see the 'No resume read' tag when that happens), rather than failing outright." />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-gray-900">{Number(app.score_avg).toFixed(1)}</span>
          <span className="text-xs text-gray-400">/10</span>
          {app.score_recommendation && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${recColor}`}>
              {app.score_recommendation}
            </span>
          )}
          {app.score_resume_read === false && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500" title="Resume could not be read; scored from profile fields only">
              No resume read
            </span>
          )}
        </div>
      </div>

      {/* 8-dimension table */}
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-xs">
          <tbody>
            {DIMENSIONS.map(d => (
              <tr key={d.label} className="border-b border-gray-50 last:border-0">
                <td className="py-1.5 px-1 text-gray-500 whitespace-nowrap w-32">{d.label}</td>
                <td className={`py-1.5 px-1 w-10 text-right ${scoreColor(d.score)}`}>
                  {d.score != null ? d.score : '—'}
                </td>
                <td className="py-1.5 px-2 text-gray-400 italic">{d.note || ''}</td>
              </tr>
            ))}
            {hasPortfolio && <PortfolioDimensionRow app={app} />}
          </tbody>
        </table>
      </div>

      {/* Strengths + Red flags */}
      <div className="grid grid-cols-2 gap-3 mt-3">
        {app.score_strengths && app.score_strengths.length > 0 && (
          <div>
            <div className="text-xs text-green-600 font-medium mb-1">✓ Key strengths</div>
            <ul className="text-xs text-gray-600 space-y-0.5">
              {app.score_strengths.map((s, i) => <li key={i}>• {s}</li>)}
            </ul>
          </div>
        )}
        {app.score_red_flags && app.score_red_flags.length > 0 && (
          <div>
            <div className="text-xs text-red-500 font-medium mb-1">⚠ Red flags</div>
            <ul className="text-xs text-gray-600 space-y-0.5">
              {app.score_red_flags.map((s, i) => <li key={i}>• {s}</li>)}
            </ul>
          </div>
        )}
      </div>

      {/* Executive summary */}
      {app.score_summary && (
        <p className="text-xs text-gray-500 leading-relaxed italic mt-3 border-l-2 border-dp-300 pl-2">
          {app.score_summary}
        </p>
      )}

      {hasPortfolio && (
        <div className="mt-3"><PortfolioReviewCard applicationId={app.id} status={app.portfolio_analysis_status} /></div>
      )}

      {app.score_computed_at && (
        <p className="text-xs text-gray-300 mt-2">
          Scored {new Date(app.score_computed_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
        </p>
      )}
    </div>
  );
}
