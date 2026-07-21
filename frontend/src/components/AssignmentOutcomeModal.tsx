import { useState } from 'react';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import { interviewsApi } from '../services/api.ts';
import { InterviewRound } from '../types/index.ts';
import { Spinner } from './shared/Badges.tsx';

// Weighted rubric per PRD §12 — Technical Accuracy 40% / Problem Solving 25%
// / Clarity & Structure 15% / Practical Thinking 10% / Completeness 10%.
const RUBRIC = [
  { key: 'score_technical_accuracy', label: 'Technical Accuracy', weight: '40%' },
  { key: 'score_problem_solving',    label: 'Problem Solving',    weight: '25%' },
  { key: 'score_clarity',            label: 'Clarity & Structure', weight: '15%' },
  { key: 'score_practical_thinking', label: 'Practical Thinking', weight: '10%' },
  { key: 'score_completeness',       label: 'Completeness',       weight: '10%' },
] as const;

const OUTCOMES = ['Approved for Next Round', 'Assignment Resent', 'Rejected'] as const;

interface Props {
  round:     InterviewRound & { candidate_name?: string; role_title?: string };
  onClose:   () => void;
  onSuccess: () => void;
}

export default function AssignmentOutcomeModal({ round, onClose, onSuccess }: Props) {
  const [scores, setScores] = useState<Record<string, number>>({});
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const computedScore = () => {
    if (RUBRIC.some(r => scores[r.key] == null)) return null;
    const weights: Record<string, number> = {
      score_technical_accuracy: 0.4, score_problem_solving: 0.25, score_clarity: 0.15,
      score_practical_thinking: 0.10, score_completeness: 0.10,
    };
    const total = RUBRIC.reduce((sum, r) => sum + scores[r.key] * weights[r.key], 0);
    return Math.round(total * 10) / 10;
  };

  const canSubmit = outcome && RUBRIC.every(r => scores[r.key] != null);

  const handleSubmit = async () => {
    if (!canSubmit) {
      toast.error('Score every rubric item and select an outcome');
      return;
    }
    setSaving(true);
    try {
      await interviewsApi.feedback(round.id, {
        assignment_outcome: outcome,
        score_technical_accuracy: scores.score_technical_accuracy,
        score_problem_solving: scores.score_problem_solving,
        score_clarity: scores.score_clarity,
        score_practical_thinking: scores.score_practical_thinking,
        score_completeness: scores.score_completeness,
        assignment_notes: notes || null,
      });
      toast.success('Assignment outcome recorded');
      onSuccess();
      onClose();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || 'Failed to record outcome');
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl my-8">
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              Assignment Outcome — {round.round_name}
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
          <section>
            <h3 className="text-sm font-semibold text-gray-900 mb-3">
              Evaluation rubric <span className="text-red-500">*</span>
            </h3>
            <div className="space-y-2">
              {RUBRIC.map(r => (
                <div key={r.key} className="flex items-center gap-3 p-3 rounded-lg bg-gray-50">
                  <span className="flex-1 text-sm text-gray-700">{r.label} <span className="text-gray-400">({r.weight})</span></span>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map(n => (
                      <button
                        key={n}
                        onClick={() => setScores(prev => ({ ...prev, [r.key]: n }))}
                        className={`w-8 h-8 rounded-md text-xs font-medium transition-colors ${
                          scores[r.key] === n
                            ? n >= 4 ? 'bg-green-600 text-white'
                            : n === 3 ? 'bg-amber-500 text-white'
                            : 'bg-red-500 text-white'
                            : 'bg-white border border-gray-200 text-gray-500 hover:border-dp-400'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {computedScore() != null && (
              <p className="text-xs text-gray-500 mt-2">
                Weighted overall score: <strong>{computedScore()} / 5.0</strong>
              </p>
            )}
          </section>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">
              Outcome <span className="text-red-500">*</span>
            </label>
            <select value={outcome} onChange={e => setOutcome(e.target.value)} className="select text-sm">
              <option value="">Select…</option>
              {OUTCOMES.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Notes</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Anything worth flagging about the submission…"
              className="input h-20 resize-none text-sm"
            />
          </div>

          {outcome && (
            <div className={`rounded-lg px-4 py-3 text-sm font-medium ${
              outcome === 'Approved for Next Round' ? 'bg-green-50 text-green-800' :
              outcome === 'Assignment Resent'        ? 'bg-amber-50 text-amber-800' :
              'bg-red-50 text-red-800'
            }`}>
              Outcome: <strong>{outcome}</strong>
              {computedScore() != null && <span className="ml-2 font-normal opacity-75">· Score {computedScore()}/5</span>}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-gray-50 rounded-b-xl">
          <p className="text-xs text-gray-400">All rubric items and an outcome are required</p>
          <div className="flex gap-3">
            <button onClick={onClose} className="btn-secondary">Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit || saving}
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? <Spinner size="sm" /> : 'Save outcome'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
