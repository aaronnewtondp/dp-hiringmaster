import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { buildRejectionDraft } from '../../utils/rejectionEmailTemplates.ts';

export interface RejectionEmailState {
  enabled: boolean;
  subject: string;
  body: string;
}

interface RejectionEmailDraftProps {
  reasonCat:       string;             // '' — not yet selected, nothing renders
  recipientEmail?: string;             // single-candidate mode only (shown in the To: preview)
  candidateName?:  string;             // real name (single mode) — omit for bulk (uses {{candidate_name}})
  roleTitle?:      string;             // real role title (single mode) — omit for bulk (uses {{role_title}})
  bulkCount?:      number;             // > 1 renders the "these tokens are per-candidate" caption
  onChange:        (draft: RejectionEmailState) => void;
}

// Mirrors SendAssignmentModal.tsx's own conventions: a read-only To:/Subject
// preview above editable fields, autofilled but never clobbering the user's
// own edits once they've started typing. Mounted after the rejection-reason
// select in every reject flow (single-candidate and bulk) — see
// backend/src/routes/applications.ts's POST /:id/status, which accepts the
// final edited subject/body verbatim.
export default function RejectionEmailDraft({
  reasonCat, recipientEmail, candidateName, roleTitle, bulkCount, onChange,
}: RejectionEmailDraftProps) {
  const isBulk = (bulkCount ?? 1) > 1;
  const [enabled, setEnabled] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody]       = useState('');
  const [touched, setTouched] = useState(false);

  // Regenerate the draft whenever the reason changes, unless the user has
  // already started editing this specific draft — same "don't clobber user
  // typing" rule SendAssignmentModal.tsx follows for its own autofilled
  // Assignment Link.
  useEffect(() => {
    if (!reasonCat || touched) return;
    const draft = buildRejectionDraft(reasonCat, candidateName || '{{candidate_name}}', roleTitle || '{{role_title}}');
    setSubject(draft.subject);
    setBody(draft.body);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reasonCat]);

  useEffect(() => {
    onChange({ enabled, subject, body });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, subject, body]);

  if (!reasonCat) return null;

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        Send rejection email to candidate{isBulk ? 's' : ''}
      </label>

      {enabled && (
        <div className="space-y-2 p-3 bg-gray-50 border border-gray-200 rounded-lg">
          <div className="text-xs text-gray-500 space-y-0.5">
            <div><span className="font-medium">To:</span> {isBulk ? `${bulkCount} candidates` : (recipientEmail || '—')}</div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Subject</label>
            <input
              value={subject}
              onChange={e => { setTouched(true); setSubject(e.target.value); }}
              className="input text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Body</label>
            <textarea
              value={body}
              onChange={e => { setTouched(true); setBody(e.target.value); }}
              className="input text-sm h-40 resize-none font-mono"
            />
          </div>
          {isBulk && (
            <p className="text-xs text-gray-400 flex items-start gap-1">
              <Mail className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span><code>{'{{candidate_name}}'}</code> and <code>{'{{role_title}}'}</code> are replaced per candidate when sent.</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
