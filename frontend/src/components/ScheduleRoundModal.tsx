import { useState } from 'react';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import { interviewsApi } from '../services/api.ts';
import { Spinner } from './shared/Badges.tsx';

interface Props {
  applicationId:  string;
  nextRoundNumber: number;
  onClose:        () => void;
  onSuccess:      () => void;
}

export default function ScheduleRoundModal({ applicationId, nextRoundNumber, onClose, onSuccess }: Props) {
  const [roundName,         setRoundName]         = useState('');
  const [roundType,         setRoundType]         = useState<'Standard' | 'Assignment'>('Standard');
  const [interviewerNames,  setInterviewerNames]  = useState('');
  const [scheduledDate,     setScheduledDate]     = useState('');
  const [saving,            setSaving]            = useState(false);

  const handleSubmit = async () => {
    if (!roundName.trim()) { toast.error('Round name is required'); return; }
    setSaving(true);
    try {
      await interviewsApi.schedule({
        application_id:   applicationId,
        round_name:       roundName.trim(),
        round_type:       roundType,
        round_number:     nextRoundNumber,
        interviewer_names: interviewerNames || null,
        scheduled_date:   scheduledDate || null,
      });
      toast.success(`${roundName} scheduled`);
      onSuccess();
      onClose();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || 'Failed to schedule round');
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">Schedule interview round</h3>
          <button onClick={onClose}><X className="w-4 h-4 text-gray-400" /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Round name <span className="text-red-500">*</span></label>
            <input
              value={roundName}
              onChange={e => setRoundName(e.target.value)}
              placeholder="e.g. Technical Deep-Dive, Founder Round…"
              className="input text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Round type</label>
            <select value={roundType} onChange={e => setRoundType(e.target.value as 'Standard' | 'Assignment')} className="select text-sm">
              <option value="Standard">Standard interview</option>
              <option value="Assignment">Assignment round</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Interviewers</label>
            <input
              value={interviewerNames}
              onChange={e => setInterviewerNames(e.target.value)}
              placeholder="e.g. Alex, Satyadev…"
              className="input text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Scheduled date & time</label>
            <input
              type="datetime-local"
              value={scheduledDate}
              onChange={e => setScheduledDate(e.target.value)}
              className="input text-sm"
            />
          </div>
        </div>
        <div className="flex gap-3 justify-end px-5 py-4 border-t border-gray-100">
          <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="btn-primary text-sm">
            {saving ? <Spinner size="sm" /> : 'Schedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
