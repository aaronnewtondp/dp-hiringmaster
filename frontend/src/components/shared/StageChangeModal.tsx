import { useState } from 'react';
import toast from 'react-hot-toast';
import { applicationsApi } from '../../services/api.ts';
import { Application, STAGES, OVER_BUDGET_SHORTLIST_REASONS } from '../../types/index.ts';

// Single-application stage change — shared by CandidateDetail.tsx and
// ScorecardSummary.tsx's inline per-row stage edit. Candidates.tsx's bulk
// stage-change is a distinct batch concept (chunked, multi-ID) and owns its
// own modal rather than reusing this one, with the identical inline
// budget-reason handling duplicated there for the same reason.
interface StageChangeModalProps {
  application: Application;
  onClose: () => void;
  onUpdated: () => void;
}

export default function StageChangeModal({ application, onClose, onUpdated }: StageChangeModalProps) {
  const [stageValue, setStageValue] = useState(application.stage);
  const [saving, setSaving] = useState(false);
  const [reasonCat, setReasonCat] = useState('');
  const [reasonDetail, setReasonDetail] = useState('');

  // This is a generic "jump to any stage" control — the dedicated Shortlist
  // buttons on ScorecardSummary/My Tasks aren't the only way to move an
  // application to Interview Round 1 (i.e. shortlist it — 'Shortlisted' was
  // retired as its own intermediate stage), so the mandatory over-budget
  // reason (item #1) has to be handled here too, not just there.
  // is_severely_over_budget is server-computed and never stripped for any
  // persona (unlike the raw ctc_band figures), so this check works the same
  // regardless of who's driving this modal.
  const needsBudgetReason = stageValue === 'Interview Round 1' && application.is_severely_over_budget;

  const handleUpdate = async () => {
    if (needsBudgetReason && !reasonCat) {
      toast.error('Select a reason before shortlisting this candidate');
      return;
    }
    setSaving(true);
    try {
      await applicationsApi.advanceStage(application.id, stageValue, {
        budgetExceptionReasonCat: needsBudgetReason ? reasonCat : undefined,
        budgetExceptionReasonDetail: needsBudgetReason ? reasonDetail.trim() || undefined : undefined,
      });
      toast.success(`Stage updated to ${stageValue}`);
      onUpdated();
      onClose();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || 'Failed to update stage');
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <h3 className="text-base font-semibold mb-4">Update stage</h3>
        <select value={stageValue} onChange={e => setStageValue(e.target.value)} className="select mb-4">
          {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {needsBudgetReason && (
          <div className="mb-4 space-y-3 p-3 bg-amber-50 border border-amber-100 rounded-lg">
            <p className="text-xs text-amber-800">
              This candidate is 15%+ over the role's compensation band — select a reason to proceed.
            </p>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Reason <span className="text-red-500">*</span></label>
              <select value={reasonCat} onChange={e => setReasonCat(e.target.value)} className="select text-sm">
                <option value="">Select reason</option>
                {OVER_BUDGET_SHORTLIST_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Additional detail <span className="text-gray-400">(optional)</span></label>
              <textarea
                value={reasonDetail}
                onChange={e => setReasonDetail(e.target.value)}
                placeholder="Optional context…"
                className="input text-sm h-16 resize-none"
              />
            </div>
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={handleUpdate} disabled={saving || (needsBudgetReason && !reasonCat)} className="btn-primary">{saving ? 'Saving…' : 'Update'}</button>
        </div>
      </div>
    </div>
  );
}
