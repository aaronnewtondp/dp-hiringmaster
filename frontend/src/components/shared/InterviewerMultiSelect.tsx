import { useEffect, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { filterInterviewers, Interviewer, INTERVIEWERS } from '../../data/interviewers.ts';

interface Props {
  /** Selected EMAIL addresses (what the API stores). */
  selected: string[];
  onChange: (emails: string[]) => void;
  options?: readonly Interviewer[];
  id?: string;
}

/**
 * Pick one or more interviewers from the company directory (data/interviewers.ts): the chosen people as removable chips, a dropdown button, and a
 * searchable checkbox list of "Name — email". Values are emails. Rendered inline (no portal) so it works inside a modal.
 */
export default function InterviewerMultiSelect({ selected, onChange, options = INTERVIEWERS, id }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const nameOf = (email: string) => options.find(o => o.email === email)?.name ?? email;
  const toggle = (email: string) => onChange(selected.includes(email) ? selected.filter(e => e !== email) : [...selected, email]);
  const shown = filterInterviewers(options, query);

  return (
    <div ref={root} className="relative">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5" aria-label="Selected interviewers">
          {selected.map(email => (
            <span key={email} className="inline-flex items-center gap-1 rounded-md bg-dp-50 border border-dp-200 text-dp-700 text-xs pl-1.5 pr-0.5 py-0.5" title={email}>
              {nameOf(email)}
              <button type="button" aria-label={`Remove ${nameOf(email)}`} onClick={() => toggle(email)} className="p-0.5 rounded hover:text-red-600">
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      <button type="button" id={id} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)}
        className="input text-sm w-full flex items-center justify-between gap-2 text-left">
        <span className={selected.length === 0 ? 'text-gray-400' : 'text-gray-600'}>
          {selected.length === 0 ? 'Select interviewers…' : `${selected.length} selected — add or remove`}
        </span>
        <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white rounded-lg border border-gray-200 shadow-lg" role="listbox" aria-multiselectable="true" aria-label="Interviewers">
          <div className="p-2 border-b border-gray-100">
            <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by name or email" aria-label="Search interviewers" className="input text-sm w-full" />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {shown.length === 0 && <div className="px-3 py-2 text-xs text-gray-400">No one matches “{query.trim()}”.</div>}
            {shown.map(p => (
              <label key={p.email} role="option" aria-selected={selected.includes(p.email)} className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-50 cursor-pointer">
                <input type="checkbox" checked={selected.includes(p.email)} onChange={() => toggle(p.email)} className="rounded-sm border-gray-300 text-dp-600 focus:ring-dp-500" />
                <span className="min-w-0"><span className="text-gray-800">{p.name}</span> <span className="text-gray-400 truncate">— {p.email}</span></span>
              </label>
            ))}
          </div>
          {selected.length > 0 && (
            <button type="button" onClick={() => onChange([])} className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 border-t border-gray-100">Clear selection</button>
          )}
        </div>
      )}
    </div>
  );
}
