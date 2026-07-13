import { Application } from '../types/index.ts';

// ─── 8-dimension ResumeIQ table — mirrors digitalpaani-candidate-scoring output exactly
export default function ResumeIQPanel({ app }: { app: Application }) {
  if (app.score_avg == null) {
    return (
      <div className="border-t border-gray-100 pt-3 mt-3">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">ResumeIQ</span>
        <p className="text-xs text-gray-400 mt-1">Not yet scored. Advance to Resume Review to trigger scoring.</p>
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

  const recColor =
    app.score_recommendation === 'Strong Yes' ? 'bg-green-100 text-green-800' :
    app.score_recommendation === 'Yes'        ? 'bg-dp-100 text-dp-800' :
    app.score_recommendation === 'Maybe'      ? 'bg-amber-100 text-amber-800' :
    'bg-red-100 text-red-800';

  const scoreColor = (s?: number) => {
    if (s == null) return 'text-gray-300';
    if (s >= 8) return 'text-green-600 font-semibold';
    if (s >= 6) return 'text-dp-600 font-medium';
    if (s >= 4) return 'text-amber-600';
    return 'text-red-500';
  };

  return (
    <div className="border-t border-gray-100 pt-3 mt-3">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">ResumeIQ Analysis</span>
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

      {app.score_computed_at && (
        <p className="text-xs text-gray-300 mt-2">
          Scored {new Date(app.score_computed_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
        </p>
      )}
    </div>
  );
}
