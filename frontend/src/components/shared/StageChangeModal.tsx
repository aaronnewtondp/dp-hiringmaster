import { useState } from 'react';
import toast from 'react-hot-toast';
import { applicationsApi } from '../../services/api.ts';
import { Application, STAGES } from '../../types/index.ts';

// Single-application stage change — shared by CandidateDetail.tsx and
// ScorecardSummary.tsx's inline per-row stage edit. Candidates.tsx's bulk
// stage-change is a distinct batch concept (chunked, multi-ID) and owns its
// own modal rather than reusing this one.
interface StageChangeModalProps {
  application: Application;
  onClose: () => void;
  onUpdated: () => void;
}

export default function StageChangeModal({ application, onClose, onUpdated }: StageChangeModalProps) {
  const [stageValue, setStageValue] = useState(application.stage);
  const [saving, setSaving] = useState(false);

  const handleUpdate = async () => {
    setSaving(true);
    try {
      await applicationsApi.advanceStage(application.id, stageValue);
      toast.success(`Stage updated to ${stageValue}`);
      onUpdated();
      onClose();
    } catch {
      toast.error('Failed to update stage');
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
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={handleUpdate} disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Update'}</button>
        </div>
      </div>
    </div>
  );
}
