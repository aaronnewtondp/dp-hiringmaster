import { useState } from 'react';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import { refChecksApi } from '../services/api.ts';
import { REFERENCE_RELATIONSHIPS, REFERENCE_FEEDBACK_OPTIONS } from '../types/index.ts';
import { Spinner } from './shared/Badges.tsx';

interface Props {
  applicationId: string;
  onClose:       () => void;
  onSuccess:     () => void;
}

export default function AddReferenceCheckModal({ applicationId, onClose, onSuccess }: Props) {
  const [referenceName,   setReferenceName]   = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [relationship,    setRelationship]    = useState(REFERENCE_RELATIONSHIPS[0]);
  const [callNotes,       setCallNotes]       = useState('');
  const [feedback,        setFeedback]        = useState(REFERENCE_FEEDBACK_OPTIONS[0]);
  const [saving,          setSaving]          = useState(false);

  const handleSubmit = async () => {
    if (!referenceName.trim())   { toast.error('Reference Name is required');   return; }
    if (!referenceNumber.trim()) { toast.error('Reference Number is required'); return; }
    if (!relationship)            { toast.error('Relationship is required');     return; }
    if (!feedback)                { toast.error('Feedback is required');        return; }

    setSaving(true);
    try {
      await refChecksApi.create({
        application_id:       applicationId,
        reference_name:       referenceName.trim(),
        reference_number:     referenceNumber.trim(),
        relationship,
        reference_call_notes: callNotes.trim() || undefined,
        feedback,
      });
      toast.success('Reference check added');
      onSuccess();
      onClose();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || 'Failed to add reference check');
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">Add reference check</h3>
          <button onClick={onClose}><X className="w-4 h-4 text-gray-400" /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Reference Name <span className="text-red-500">*</span></label>
            <input
              value={referenceName}
              onChange={e => setReferenceName(e.target.value)}
              placeholder="e.g. Priya Sharma"
              className="input text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Reference Number <span className="text-red-500">*</span></label>
            <input
              value={referenceNumber}
              onChange={e => setReferenceNumber(e.target.value)}
              placeholder="e.g. +91 98765 43210"
              className="input text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Relationship with Candidate <span className="text-red-500">*</span></label>
            <select value={relationship} onChange={e => setRelationship(e.target.value)} className="select text-sm">
              {REFERENCE_RELATIONSHIPS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Feedback <span className="text-red-500">*</span></label>
            <select value={feedback} onChange={e => setFeedback(e.target.value)} className="select text-sm">
              {REFERENCE_FEEDBACK_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Reference Call Notes <span className="text-gray-400">(optional)</span></label>
            <textarea
              value={callNotes}
              onChange={e => setCallNotes(e.target.value)}
              placeholder="Notes from the reference call…"
              className="input text-sm h-20 resize-none"
            />
          </div>
        </div>
        <div className="flex gap-3 justify-end px-5 py-4 border-t border-gray-100">
          <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="btn-primary text-sm">
            {saving ? <Spinner size="sm" /> : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
