import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import { interviewsApi, rolesApi } from '../services/api.ts';
import { Spinner } from './shared/Badges.tsx';

interface Props {
  mode:                    'create' | 'retry';
  applicationId:           string;
  roundId?:                string;  // required when mode === 'retry'
  roleId:                  string;  // used to autofill the Assignment Link, create mode only
  nextRoundNumber?:        number;  // required when mode === 'create'
  candidateName:           string;
  roleTitle:               string;
  candidateEmail?:         string;
  initialMailBody?:        string;
  initialCc?:              string;  // pre-joined "a@x.com, b@x.com" for retry prefill
  initialAssignmentLink?:  string;
  initialSupportingDocs?:  string;
  onClose:                 () => void;
  onSuccess:               () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Replaces the old calendar-style "Schedule Assignment" modal — assignments
// never had a real calendar sync to begin with. Clicking the button now
// composes and sends a real email to the candidate from hr@digitalpaani.com,
// in one step (creates the round + sends). Also doubles as the retry flow
// for a round whose send previously failed (mode='retry') — see
// CandidateDetail.tsx's per-round action button.
export default function SendAssignmentModal({
  mode, applicationId, roundId, roleId, nextRoundNumber,
  candidateName, roleTitle, candidateEmail,
  initialMailBody, initialCc, initialAssignmentLink, initialSupportingDocs,
  onClose, onSuccess,
}: Props) {
  const [mailBody,       setMailBody]       = useState(initialMailBody || '');
  const [cc,             setCc]             = useState(initialCc || '');
  const [assignmentLink, setAssignmentLink] = useState(initialAssignmentLink || '');
  const [supportingDocs, setSupportingDocs] = useState(initialSupportingDocs || '');
  const [saving,         setSaving]         = useState(false);

  const { data: roleData } = useQuery<{ data: { role: { approval_summary_link?: string } } }>({
    queryKey: ['role', roleId],
    queryFn: () => rolesApi.get(roleId),
    enabled: mode === 'create',
  });

  // Autofill from the role's "Assignment Link" (Links & Assets) once loaded
  // — only if the field is still empty, so it never clobbers something the
  // user already typed while the request was in flight.
  useEffect(() => {
    if (mode === 'create' && !assignmentLink && roleData?.data?.role?.approval_summary_link) {
      setAssignmentLink(roleData.data.role.approval_summary_link);
    }
  }, [roleData]);

  const subject = `DigitalPaani ${roleTitle} Assignment - ${candidateName}`;

  const handleSubmit = async () => {
    if (!mailBody.trim())       { toast.error('Mail Body Content is required'); return; }
    if (!assignmentLink.trim()) { toast.error('Assignment Link is required');   return; }

    const ccList = cc.split(',').map(e => e.trim()).filter(Boolean);
    const invalid = ccList.find(e => !EMAIL_RE.test(e));
    if (invalid) { toast.error(`"${invalid}" doesn't look like a valid email address`); return; }

    const fields = {
      mail_body_content:        mailBody.trim(),
      cc:                       ccList.length ? ccList : null,
      assignment_link:          assignmentLink.trim(),
      supporting_documentation: supportingDocs.trim() || null,
    };

    setSaving(true);
    try {
      const res = mode === 'create'
        ? await interviewsApi.schedule({
            application_id: applicationId,
            round_type:     'Assignment',
            round_name:     'Assignment Round',
            round_number:   nextRoundNumber,
            ...fields,
          })
        : await interviewsApi.sendAssignment(roundId!, fields);

      if (res.data.email?.sent) {
        toast.success(`Assignment email sent to ${candidateEmail || 'the candidate'}`);
      } else if (res.data.email) {
        toast.error(res.data.email.error);
      } else {
        toast.success('Assignment saved');
      }
      onSuccess();
      onClose();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || 'Failed to send assignment');
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">
            {mode === 'retry' ? 'Retry assignment send' : 'Send Assignment'}
          </h3>
          <button onClick={onClose}><X className="w-4 h-4 text-gray-400" /></button>
        </div>
        <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="text-xs text-gray-500 space-y-1">
            <div>To: <span className="text-gray-900 font-medium">{candidateEmail || '—'}</span></div>
            <div>Subject: <span className="text-gray-900 font-medium">{subject}</span></div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">CC <span className="text-gray-400">(optional)</span></label>
            <input
              value={cc}
              onChange={e => setCc(e.target.value)}
              placeholder="e.g. alex@digitalpaani.com, satyadev@digitalpaani.com"
              className="input text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Assignment Link <span className="text-red-500">*</span></label>
            <input
              value={assignmentLink}
              onChange={e => setAssignmentLink(e.target.value)}
              placeholder="Autofilled from the role's Assignment Link, if set"
              className="input text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Supporting Documentation <span className="text-gray-400">(optional)</span></label>
            <input
              value={supportingDocs}
              onChange={e => setSupportingDocs(e.target.value)}
              placeholder="Google Drive links, comma-separated"
              className="input text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Mail Body Content <span className="text-red-500">*</span></label>
            <textarea
              value={mailBody}
              onChange={e => setMailBody(e.target.value)}
              placeholder="Hi, thanks for your time so far — as discussed, please find your assignment below…"
              className="input text-sm h-32 resize-none"
            />
          </div>
        </div>
        <div className="flex gap-3 justify-end px-5 py-4 border-t border-gray-100">
          <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="btn-primary text-sm">
            {saving ? <Spinner size="sm" /> : 'Send Assignment'}
          </button>
        </div>
      </div>
    </div>
  );
}
