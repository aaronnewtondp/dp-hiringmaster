import { useState } from 'react';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import { interviewsApi } from '../services/api.ts';
import { Spinner } from './shared/Badges.tsx';

interface Props {
  applicationId:  string;
  nextRoundNumber: number;
  // The round type is now implied by the application's current stage —
  // this button is only reachable when stage already matches one type or
  // the other, so there's no longer a case where it's ambiguous.
  roundType:      'Standard' | 'Assignment';
  defaultRoundName?: string;
  onClose:        () => void;
  onSuccess:      () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ScheduleRoundModal({ applicationId, nextRoundNumber, roundType, defaultRoundName, onClose, onSuccess }: Props) {
  const [roundName,         setRoundName]         = useState(defaultRoundName || '');
  const [interviewerEmails, setInterviewerEmails] = useState('');
  const [scheduledDate,     setScheduledDate]     = useState('');
  const [interviewMode,     setInterviewMode]     = useState<'In-person' | 'Video' | 'Phone'>('Video');
  const [durationMinutes,   setDurationMinutes]   = useState(60);
  const [saving,            setSaving]            = useState(false);

  const handleSubmit = async () => {
    if (!roundName.trim()) { toast.error('Round name is required'); return; }

    const emails = interviewerEmails.split(',').map(e => e.trim()).filter(Boolean);
    const invalid = emails.find(e => !EMAIL_RE.test(e));
    if (invalid) { toast.error(`"${invalid}" doesn't look like a valid email address`); return; }

    setSaving(true);
    try {
      const res = await interviewsApi.schedule({
        application_id:     applicationId,
        round_name:          roundName.trim(),
        round_type:          roundType,
        round_number:        nextRoundNumber,
        interviewer_emails:  emails.length ? emails : null,
        // datetime-local gives a naive "YYYY-MM-DDTHH:mm" with no timezone.
        // Everyone scheduling through this app is working IST, so make that
        // explicit rather than letting the backend/Calendar API default it
        // to UTC (which shifted every invite by 5:30 hours).
        scheduled_date:      scheduledDate ? `${scheduledDate}:00+05:30` : null,
        ...(roundType === 'Standard' ? {
          interview_mode:    interviewMode,
          duration_minutes:  durationMinutes,
        } : {}),
      });
      toast.success(`${roundName} scheduled`);
      if (res.data.calendar) {
        if (res.data.calendar.synced) toast.success('Calendar invite sent to interviewers');
        else toast.error(res.data.calendar.error);
      }
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
          <h3 className="text-sm font-semibold text-gray-900">
            {roundType === 'Assignment' ? 'Schedule assignment' : 'Schedule interview round'}
          </h3>
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
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Interviewer emails</label>
            <input
              value={interviewerEmails}
              onChange={e => setInterviewerEmails(e.target.value)}
              placeholder="e.g. alex@digitalpaani.com, satyadev@digitalpaani.com"
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
          {roundType === 'Standard' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Meeting mode</label>
                <select
                  value={interviewMode}
                  onChange={e => setInterviewMode(e.target.value as 'In-person' | 'Video' | 'Phone')}
                  className="select text-sm"
                >
                  <option value="Video">Video</option>
                  <option value="In-person">In-person</option>
                  <option value="Phone">Phone</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Duration (minutes)</label>
                <input
                  type="number"
                  min={5}
                  step={5}
                  value={durationMinutes}
                  onChange={e => setDurationMinutes(Number(e.target.value) || 60)}
                  className="input text-sm"
                />
              </div>
            </div>
          )}
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
