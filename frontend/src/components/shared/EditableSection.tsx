import { useState } from 'react';
import { Pencil, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import { Spinner } from './Badges.tsx';

export type FieldType = 'text' | 'textarea' | 'number' | 'select' | 'multiselect' | 'boolean' | 'date' | 'tags' | 'json';

export interface FieldConfig {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  /** select type only: maps a raw option value to a nicer display label (e.g. an agency's id -> its name). Falls back to the raw value itself when absent. */
  optionLabels?: Record<string, string>;
  /** Excluded entirely (not rendered, not sent) — used for persona-gated fields like ctc_band. */
  hidden?: boolean;
  /** Shown in both read and edit mode, but never as an input — for fields the server sets automatically (e.g. a role's approver_name/approval_date/start_date, only ever written by the approve action). */
  readOnly?: boolean;
  /** Read-mode only: render the value as a clickable external link instead of plain text (e.g. Drive links). Editing still shows a plain text input. */
  linkify?: boolean;
  /** Read-mode only: format/display this OTHER key's value instead of `key` — e.g. show a joined name while `key` itself stores the foreign id. */
  displayKey?: string;
  /** Only shown (read mode: against `data`; edit mode: against the live `draft`, so it reacts as the user changes the other field) when that key's value equals this value. Cleared to null on save whenever the condition doesn't hold, even if a stale value is sitting in the draft. */
  dependsOn?: { key: string; value: string };
  /** A value is required for this field whenever it's visible per `dependsOn` (or always, if no dependsOn) — blocks save with a toast naming the field. */
  requiredWhenVisible?: boolean;
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

type DraftValue = string | boolean | string[];

// `ctx` is `data` in read mode and the live `draft` in edit mode, so a
// dependsOn field reacts immediately as the user changes the field it
// depends on, before anything is saved.
function isConditionMet(f: FieldConfig, ctx: Record<string, unknown>): boolean {
  return !f.dependsOn || ctx[f.dependsOn.key] === f.dependsOn.value;
}

// Draft equality that also handles arrays — used so 'save' can skip fields
// that haven't actually changed (arrays would otherwise be `!==` even when
// element-equal, and get re-sent every time).
function draftEquals(a: DraftValue, b: DraftValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

function formatDisplay(value: unknown, type: FieldType): string {
  if (value === null || value === undefined || value === '') return '—';
  if (type === 'boolean') return value ? 'Yes' : 'No';
  if (type === 'tags' || type === 'multiselect') {
    return Array.isArray(value) ? (value.length ? value.join(', ') : '—') : String(value);
  }
  if (type === 'date') return String(value).slice(0, 10);
  if (type === 'json') return typeof value === 'object' ? JSON.stringify(value) : String(value);
  return String(value);
}

function toDraftValue(value: unknown, type: FieldType): DraftValue {
  if (type === 'boolean') return !!value;
  if (type === 'multiselect') return Array.isArray(value) ? [...value] : [];
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
  if (type === 'multiselect') return Array.isArray(draft) ? draft : [];
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
    for (const f of visibleFields) {
      if (!f.requiredWhenVisible || !isConditionMet(f, draft)) continue;
      const val = draft[f.key];
      const isEmpty = val === '' || val === null || val === undefined || (Array.isArray(val) && val.length === 0);
      if (isEmpty) {
        toast.error(`${f.label} is required`);
        return;
      }
    }
    setSaving(true);
    const changes: Record<string, unknown> = {};
    for (const f of visibleFields) {
      // A dependsOn field whose condition no longer holds is cleared,
      // regardless of whatever value is still sitting in its draft — e.g.
      // changing Source away from 'Agency' clears the now-inapplicable
      // sourcing agency rather than silently keeping a stale reference.
      const effectiveDraft: DraftValue = (f.dependsOn && !isConditionMet(f, draft)) ? '' : draft[f.key];
      const original = toDraftValue(data[f.key], f.type);
      if (draftEquals(effectiveDraft, original)) continue;
      try {
        changes[f.key] = fromDraftValue(effectiveDraft, f.type);
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
          {visibleFields.filter(f => isConditionMet(f, data)).map(f => {
            const displayVal = data[f.displayKey || f.key];
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
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" /> {formatDisplay(displayVal, f.type)}
                  </a>
                ) : (
                  <div className="text-sm text-gray-700 whitespace-pre-wrap break-words">
                    {formatDisplay(displayVal, f.type)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3">
          {visibleFields.filter(f => isConditionMet(f, draft)).map(f => (
            <div key={f.key}>
              <label className="label">{f.label}</label>
              {f.readOnly ? (
                <div className="text-sm text-gray-500 whitespace-pre-wrap break-words">
                  {formatDisplay(data[f.displayKey || f.key], f.type)}
                </div>
              ) : (
                <>
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
                  {(f.options || []).map(o => <option key={o} value={o}>{f.optionLabels?.[o] ?? o}</option>)}
                </select>
              )}
              {f.type === 'multiselect' && (
                <div className="flex gap-2 flex-wrap mt-1">
                  {(f.options || []).map(o => {
                    const current = (draft[f.key] as string[] | undefined) || [];
                    const active = current.includes(o);
                    return (
                      <button
                        key={o}
                        type="button"
                        onClick={() => setDraft(d => {
                          const cur = (d[f.key] as string[] | undefined) || [];
                          return { ...d, [f.key]: active ? cur.filter(x => x !== o) : [...cur, o] };
                        })}
                        className={`px-3 py-1 rounded-lg text-sm border transition-colors ${
                          active
                            ? 'bg-dp-600 text-white border-dp-600'
                            : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                        }`}
                      >
                        {o}
                      </button>
                    );
                  })}
                </div>
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
                </>
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
