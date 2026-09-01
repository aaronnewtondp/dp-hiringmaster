import { useState } from 'react';
import { X } from 'lucide-react';
import { OVER_BUDGET_SHORTLIST_REASONS } from '../../types/index.ts';
import { Spinner } from './Badges.tsx';

interface Props {
  count:      number;
  saving:     boolean;
  onConfirm:  (reasonCat: string, reasonDetail: string) => void;
  onClose:    () => void;
}

// Gate for shortlisting a candidate whose expected CTC is 15%+ over the
// role's stated band (utils/budget.ts's isSeverelyOverBudget) — mirrors
// RejectReasonModal.tsx's shape exactly, just a different reason list and
// trigger condition. Shared by ScorecardSummary.tsx and MyTasks.tsx.
export default function BudgetExceptionModal({ count, saving, onConfirm, onClose }: Props) {
  const [reasonCat,    setReasonCat]    = useState('');
  const [reasonDetail, setReasonDetail] = useState('');

  const handleSubmit = () => {
    if (!reasonCat) return;
    onConfirm(reasonCat, reasonDetail.trim());
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">
            {count > 1 ? `${count} candidates are` : 'This candidate is'} 15%+ over budget
          </h3>
          <button onClick={onClose}><X className="w-4 h-4 text-gray-400" /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <p className="text-xs text-gray-500">
            A reason is required before shortlisting {count > 1 ? 'these candidates' : 'this candidate'}.
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
              className="input text-sm h-20 resize-none"
            />
          </div>
        </div>
        <div className="flex gap-3 justify-end px-5 py-4 border-t border-gray-100">
          <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button onClick={handleSubmit} disabled={saving || !reasonCat} className="btn-primary text-sm">
            {saving ? <Spinner size="sm" /> : 'Shortlist'}
          </button>
        </div>
      </div>
    </div>
  );
}
