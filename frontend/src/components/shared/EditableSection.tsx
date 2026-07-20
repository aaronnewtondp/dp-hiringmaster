import { useState } from 'react';
import { Pencil, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import { Spinner } from './Badges.tsx';

export type FieldType = 'text' | 'textarea' | 'number' | 'select' | 'boolean' | 'date' | 'tags' | 'json';

export interface FieldConfig {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  /** Excluded entirely (not rendered, not sent) — used for persona-gated fields like ctc_band. */
  hidden?: boolean;
  /** Read-mode only: render the value as a clickable external link instead of plain text (e.g. Drive links). Editing still shows a plain text input. */
  linkify?: boolean;
}

interface EditableSectionProps {
  title: string;
  /** Any entity object (Role/Candidate/Agency/...) — accessed generically by field key internally. */
  data: object;
  fields: FieldConfig[];
  onSave: (changes: Record<string, unknown>) => Promise<void>;
  /** key -> label shown (with a spinner, in place of "—") while the field is empty — e.g. "Generating JD…" for a Drive link an async job is about to fill in. Purely a read-mode display hint; the field is still fully editable by hand at any time. */
  pendingLabels?: Record<string, string>;
}

type DraftValue = string | boolean;

function formatDisplay(value: unknown, type: FieldType): string {
  if (value === null || value === undefined || value === '') return '—';
  if (type === 'boolean') return value ? 'Yes' : 'No';
  if (type === 'tags') return Array.isArray(value) ? value.join(', ') : String(value);
  if (type === 'date') return String(value).slice(0, 10);
  if (type === 'json') return typeof value === 'object' ? JSON.stringify(value) : String(value);
  return String(value);
}

function toDraftValue(value: unknown, type: FieldType): DraftValue {
  if (type === 'boolean') return !!value;
  if (type === 'tags') return Array.isArray(value) ? value.join(', ') : (value as string) || '';
  if (type === 'date') return value ? String(value).slice(0, 10) : '';
  if (type === 'json') return value ? JSON.stringify(value, null, 2) : '';
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Throws if a 'json' field's draft text isn't valid JSON. */
function fromDraftValue(draft: DraftValue, type: FieldType): unknown {
  if (type === 'boolean') return !!draft;
  if (type === 'number') return draft === '' ? null : Number(draft);
  if (type === 'tags') return String(draft).split(',').map(s => s.trim()).filter(Boolean);
  if (type === 'json') {
    const text = String(draft).trim();
    if (!text) return {};
    return JSON.parse(text);
  }
  return draft === '' ? null : draft;
}

/**
 * Config-driven read/edit-mode card. Read mode shows label+value pairs;
 * clicking the pencil switches every field in the section to an input, with
 * explicit Save/Cancel — no autosave, no per-field affordances (deliberately
 * per-section, matching ROADMAP.md's "per field or per section" scope for
 * Roles/Candidates/Agencies inline editing).
 */
export default function EditableSection({ title, data: rawData, fields, onSave, pendingLabels }: EditableSectionProps) {
  const data = rawData as Record<string, unknown>;
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, DraftValue>>({});
  const [saving, setSaving] = useState(false);

  const visibleFields = fields.filter(f => !f.hidden);

  const startEdit = () => {
    const initial: Record<string, DraftValue> = {};
    visibleFields.forEach(f => { initial[f.key] = toDraftValue(data[f.key], f.type); });
    setDraft(initial);
    setIsEditing(true);
  };

  const cancel = () => {
    setIsEditing(false);
    setDraft({});
  };

  const save = async () => {
    setSaving(true);
    const changes: Record<string, unknown> = {};
    for (const f of visibleFields) {
      const original = toDraftValue(data[f.key], f.type);
      if (draft[f.key] === original) continue;
      try {
        changes[f.key] = fromDraftValue(draft[f.key], f.type);
      } catch {
        toast.error(`"${f.label}" must be valid JSON`);
        setSaving(false);
        return;
      }
    }
    if (Object.keys(changes).length === 0) {
      setIsEditing(false);
      setSaving(false);
      return;
    }
    try {
      await onSave(changes);
      toast.success(`${title} updated`);
      setIsEditing(false);
    } catch {
      toast.error(`Failed to update ${title}`);
    }
    setSaving(false);
  };

  return (
    <div className="card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {!isEditing && (
          <button onClick={startEdit} className="text-gray-400 hover:text-dp-600 p-1" title={`Edit ${title}`}>
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {!isEditing ? (
        <div className="space-y-2">
          {visibleFields.map(f => {
            const pendingLabel = !data[f.key] ? pendingLabels?.[f.key] : undefined;
            return (
              <div key={f.key}>
                <div className="text-xs text-gray-400 mb-0.5">{f.label}</div>
                {pendingLabel ? (
                  <div className="flex items-center gap-2 text-sm text-gray-400">
                    <Spinner size="sm" /> {pendingLabel}
                  </div>
                ) : f.linkify && data[f.key] ? (
                  <a href={String(data[f.key])} target="_blank" rel="noopener noreferrer"
                     className="flex items-center gap-2 text-sm text-dp-600 hover:underline break-all">
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" /> {formatDisplay(data[f.key], f.type)}
                  </a>
                ) : (
                  <div className="text-sm text-gray-700 whitespace-pre-wrap break-words">
                    {formatDisplay(data[f.key], f.type)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3">
          {visibleFields.map(f => (
            <div key={f.key}>
              <label className="label">{f.label}</label>
              {(f.type === 'textarea' || f.type === 'json') && (
                <textarea
                  className="input h-20 resize-none font-mono text-xs"
                  value={draft[f.key] as string}
                  onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
                />
              )}
              {f.type === 'select' && (
                <select
                  className="select"
                  value={draft[f.key] as string}
                  onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
                >
                  {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              )}
              {f.type === 'boolean' && (
                <input
                  type="checkbox"
                  checked={draft[f.key] as boolean}
                  onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.checked }))}
                  className="h-4 w-4 rounded border-gray-300 text-dp-600 focus:ring-dp-600"
                />
              )}
              {(f.type === 'text' || f.type === 'number' || f.type === 'date' || f.type === 'tags') && (
                <input
                  type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                  className="input"
                  value={draft[f.key] as string}
                  onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
                />
              )}
            </div>
          ))}
          <div className="flex gap-2 justify-end pt-1">
            <button onClick={cancel} className="btn-secondary text-xs py-1.5 px-3">Cancel</button>
            <button onClick={save} disabled={saving} className="btn-primary text-xs py-1.5 px-3">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
