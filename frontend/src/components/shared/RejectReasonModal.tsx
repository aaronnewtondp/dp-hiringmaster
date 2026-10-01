import { useState } from 'react';
import { X } from 'lucide-react';
import { REJECTION_REASONS } from '../../types/index.ts';
import { Spinner } from './Badges.tsx';
import RejectionEmailDraft, { RejectionEmailState } from './RejectionEmailDraft.tsx';
import ReasonCheckboxList from './ReasonCheckboxList.tsx';

interface Props {
  count:      number;
  saving:     boolean;
  onConfirm:  (reasons: string[], reasonDetail: string, email: RejectionEmailState) => void;
  onClose:    () => void;
}

const EMPTY_EMAIL: RejectionEmailState = { enabled: false, subject: '', body: '' };

// Shared by ScorecardSummary.tsx and MyTasks.tsx — Reject is the only one
// of the three HM-facing actions (Shortlist / Hold for Future / Reject)
// that needs a modal at all, since the backend requires at least one reason
// for it (POST /applications/:id/status's validation). Several reasons can be
// picked — see backend/src/utils/rejectionReasons.ts for how they are stored.
export default function RejectReasonModal({ count, saving, onConfirm, onClose }: Props) {
  const [reasons,      setReasons]      = useState<string[]>([]);
  const [reasonDetail, setReasonDetail] = useState('');
  const [email,        setEmail]        = useState<RejectionEmailState>(EMPTY_EMAIL);

  const handleSubmit = () => {
    if (!reasons.length) return;
    onConfirm(reasons, reasonDetail.trim(), email);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      {/* Card never taller than the window: header and buttons stay put, the middle scrolls
          (the checkbox list + the email draft together are taller than a laptop screen). */}
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <h3 className="text-sm font-semibold text-gray-900">Reject {count > 1 ? `${count} candidates` : 'candidate'}</h3>
          <button onClick={onClose}><X className="w-4 h-4 text-gray-400" /></button>
        </div>
        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          <ReasonCheckboxList label="Reasons" required options={REJECTION_REASONS} selected={reasons} onChange={setReasons} />
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Additional detail <span className="text-gray-400">(optional)</span></label>
            <textarea
              value={reasonDetail}
              onChange={e => setReasonDetail(e.target.value)}
              placeholder="Optional context…"
              className="input text-sm h-20 resize-none"
            />
          </div>
          <RejectionEmailDraft reasons={reasons} bulkCount={count} onChange={setEmail} />
        </div>
        <div className="flex gap-3 justify-end px-5 py-4 border-t border-gray-100 shrink-0">
          <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button onClick={handleSubmit} disabled={saving || !reasons.length} className="btn-primary text-sm">
            {saving ? <Spinner size="sm" /> : 'Reject'}
          </button>
        </div>
      </div>
    </div>
  );
}
