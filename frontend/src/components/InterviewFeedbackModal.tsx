import { useState } from 'react';
import { X, Star } from 'lucide-react';
import toast from 'react-hot-toast';
import { interviewsApi } from '../services/api.ts';
import { InterviewRound } from '../types/index.ts';
import { Spinner } from './shared/Badges.tsx';

// ─── Default eval areas if none come from AI ─────────────────────────────────
const DEFAULT_AREAS = [
  'Technical Knowledge',
  'Problem Solving',
  'Communication',
  'Cultural Fit',
  'Domain Knowledge',
  'Leadership Potential',
];

const SCORE_LABELS: Record<number, string> = {
  1: 'Poor', 2: 'Below Average', 3: 'Average', 4: 'Good', 5: 'Excellent',
};

interface Props {
  round:      InterviewRound & { candidate_name?: string; role_title?: string };
  onClose:    () => void;
  onSuccess:  () => void;
}

export default function InterviewFeedbackModal({ round, onClose, onSuccess }: Props) {
  const areas = round.focus_areas?.length ? round.focus_areas : DEFAULT_AREAS;

  const [selectedAreas,     setSelectedAreas]     = useState<string[]>([...areas]);
  const [scores,            setScores]            = useState<Record<string, number>>({});
  const [overall,           setOverall]           = useState('');
  const [confidence,        setConfidence]        = useState('');
  const [recommendation,    setRecommendation]    = useState('');
  const [strengths,         setStrengths]         = useState('');
  const [concerns,          setConcerns]          = useState('');
  const [unresolvedQ,       setUnresolvedQ]       = useState('');
  const [notes,             setNotes]             = useState('');
  const [customArea,        setCustomArea]        = useState('');
  const [saving,            setSaving]            = useState(false);

  const toggleArea = (area: string) => {
    setSelectedAreas(prev =>
      prev.includes(area) ? prev.filter(a => a !== area) : [...prev, area]
    );
  };

  const addCustomArea = () => {
    const trimmed = customArea.trim();
    if (trimmed && !selectedAreas.includes(trimmed)) {
      setSelectedAreas(prev => [...prev, trimmed]);
    }
    setCustomArea('');
  };

  const computedScore = () => {
    const vals = Object.values(scores);
    if (!vals.length) return null;
    return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
  };

  const canSubmit = overall && confidence && recommendation && selectedAreas.length > 0 &&
    selectedAreas.every(a => scores[a] != null);

  const handleSubmit = async () => {
    if (!canSubmit) {
      toast.error('Please complete all required fields and score every selected area');
      return;
    }
    setSaving(true);
    try {
      await interviewsApi.feedback(round.id, {
        eval_areas_assessed:  selectedAreas,
        scores_per_area:      scores,
        overall_assessment:   overall,
        confidence_level:     confidence,
        round_recommendation: recommendation,
        strengths_observed:   strengths || null,
        key_concerns:         concerns   || null,
        unresolved_questions: unresolvedQ || null,
        notes:                notes      || null,
      });
      toast.success('Feedback submitted');
      onSuccess();
      onClose();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || 'Failed to submit feedback');
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl my-8">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              Interview Feedback — {round.round_name}
            </h2>
            {(round.candidate_name || round.role_title) && (
              <p className="text-sm text-gray-400 mt-0.5">
                {round.candidate_name}{round.candidate_name && round.role_title ? ' · ' : ''}{round.role_title}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 mt-0.5">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* ── Evaluation areas + scores ────────────────────────────────── */}
          <section>
            <h3 className="text-sm font-semibold text-gray-900 mb-3">
              Evaluation areas <span className="text-red-500">*</span>
            </h3>
            <div className="space-y-2">
              {selectedAreas.map(area => (
                <div key={area} className="flex items-center gap-3 p-3 rounded-lg bg-gray-50">
                  <button
                    onClick={() => toggleArea(area)}
                    className="text-xs text-gray-400 hover:text-red-500 shrink-0"
                    title="Remove area"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                  <span className="flex-1 text-sm text-gray-700">{area}</span>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map(n => (
                      <button
                        key={n}
                        onClick={() => setScores(prev => ({ ...prev, [area]: n }))}
                        title={SCORE_LABELS[n]}
                        className={`w-8 h-8 rounded-md text-xs font-medium transition-colors ${
                          scores[area] === n
                            ? n >= 4 ? 'bg-green-600 text-white'
                            : n === 3 ? 'bg-amber-500 text-white'
                            : 'bg-red-500 text-white'
                            : 'bg-white border border-gray-200 text-gray-500 hover:border-dp-400'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                    {scores[area] && (
                      <span className="text-xs text-gray-400 self-center ml-1 w-16 truncate">
                        {SCORE_LABELS[scores[area]]}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Add custom area */}
            <div className="flex gap-2 mt-2">
              <input
                value={customArea}
                onChange={e => setCustomArea(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addCustomArea()}
                placeholder="Add custom area…"
                className="input flex-1 text-sm"
              />
              <button onClick={addCustomArea} className="btn-secondary text-xs">Add</button>
            </div>

            {/* Unselected default areas */}
            {areas.filter(a => !selectedAreas.includes(a)).length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {areas.filter(a => !selectedAreas.includes(a)).map(a => (
                  <button
                    key={a}
                    onClick={() => toggleArea(a)}
                    className="text-xs px-2.5 py-1 rounded-full border border-dashed border-gray-300 text-gray-400 hover:border-dp-400 hover:text-dp-600"
                  >
                    + {a}
                  </button>
                ))}
              </div>
            )}

            {computedScore() && (
              <p className="text-xs text-gray-500 mt-2">
                Computed overall score: <strong>{computedScore()} / 5.0</strong>
              </p>
            )}
          </section>

          {/* ── Overall assessment + confidence ──────────────────────────── */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">
                Overall assessment <span className="text-red-500">*</span>
              </label>
              <select value={overall} onChange={e => setOverall(e.target.value)} className="select text-sm">
                <option value="">Select…</option>
                {['Strong Positive', 'Positive', 'Neutral', 'Concern', 'Strong Concern'].map(o => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">
                Confidence <span className="text-red-500">*</span>
              </label>
              <select value={confidence} onChange={e => setConfidence(e.target.value)} className="select text-sm">
                <option value="">Select…</option>
                {['Low', 'Medium', 'High'].map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">
                Recommendation <span className="text-red-500">*</span>
              </label>
              <select value={recommendation} onChange={e => setRecommendation(e.target.value)} className="select text-sm">
                <option value="">Select…</option>
                {['Proceed', 'Proceed with Concerns', 'Hold', 'Reject'].map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          </div>

          {/* ── Qualitative fields ───────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Strengths observed</label>
              <textarea
                value={strengths}
                onChange={e => setStrengths(e.target.value)}
                placeholder="Strong areas, standout moments…"
                className="input h-24 resize-none text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Key concerns / gaps</label>
              <textarea
                value={concerns}
                onChange={e => setConcerns(e.target.value)}
                placeholder="Concerns, risks, gaps observed…"
                className="input h-24 resize-none text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Unresolved questions</label>
              <textarea
                value={unresolvedQ}
                onChange={e => setUnresolvedQ(e.target.value)}
                placeholder="Areas left open for future rounds…"
                className="input h-20 resize-none text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Additional notes</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Logistics, context, demeanour…"
                className="input h-20 resize-none text-sm"
              />
            </div>
          </div>

          {/* ── Recommendation summary ───────────────────────────────────── */}
          {recommendation && (
            <div className={`rounded-lg px-4 py-3 text-sm font-medium ${
              recommendation === 'Proceed'                ? 'bg-green-50 text-green-800' :
              recommendation === 'Proceed with Concerns'  ? 'bg-amber-50 text-amber-800' :
              recommendation === 'Hold'                   ? 'bg-blue-50 text-blue-800' :
              'bg-red-50 text-red-800'
            }`}>
              <Star className="w-4 h-4 inline mr-1.5 mb-0.5" />
              Recommendation: <strong>{recommendation}</strong>
              {computedScore() && <span className="ml-2 font-normal opacity-75">· Score {computedScore()}/5</span>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-gray-50 rounded-b-xl">
          <p className="text-xs text-gray-400">All scored areas and required fields must be completed</p>
          <div className="flex gap-3">
            <button onClick={onClose} className="btn-secondary">Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit || saving}
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? <Spinner size="sm" /> : 'Submit feedback'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
