import { useState } from 'react';
import { X } from 'lucide-react';
import { REJECTION_REASONS } from '../../types/index.ts';
import { Spinner } from './Badges.tsx';

interface Props {
  count:      number;
  saving:     boolean;
  onConfirm:  (reasonCat: string, reasonDetail: string) => void;
  onClose:    () => void;
}

// Shared by ScorecardSummary.tsx and MyTasks.tsx — Reject is the only one
// of the three HM-facing actions (Shortlist / Hold for Future / Reject)
// that needs a modal at all, since the backend requires a reason category
// for it (POST /applications/:id/status's existing, untouched validation).
export default function RejectReasonModal({ count, saving, onConfirm, onClose }: Props) {
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
          <h3 className="text-sm font-semibold text-gray-900">Reject {count > 1 ? `${count} candidates` : 'candidate'}</h3>
          <button onClick={onClose}><X className="w-4 h-4 text-gray-400" /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Reason <span className="text-red-500">*</span></label>
            <select value={reasonCat} onChange={e => setReasonCat(e.target.value)} className="select text-sm">
              <option value="">Select reason</option>
              {REJECTION_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
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
            {saving ? <Spinner size="sm" /> : 'Reject'}
          </button>
        </div>
      </div>
    </div>
  );
}
