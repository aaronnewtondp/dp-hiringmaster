interface ReasonCheckboxListProps {
  label:     string;
  options:   string[];
  selected:  string[];
  onChange:  (selected: string[]) => void;
  required?: boolean;
}

// Pick one or more reasons. Inline (not a floating dropdown) on purpose: it lives
// inside modals, where a portal-based popover would fight the modal's own stacking
// and click-outside handling. Rows are compact so the whole reject list (nine) shows at
// once — scrollbars in this app are invisible until you scroll, so an inner scroll box
// would hide the last options with no cue that they exist. `max-h-72` is only a ceiling.
export default function ReasonCheckboxList({ label, options, selected, onChange, required }: ReasonCheckboxListProps) {
  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]);

  return (
    <fieldset>
      <legend className="block text-xs font-medium text-gray-600 mb-1.5">
        {label} {required && <span className="text-red-500">*</span>}
        <span className="ml-1 font-normal text-gray-400">
          {selected.length === 0 ? '(select one or more)' : `(${selected.length} selected)`}
        </span>
      </legend>
      <div className="rounded-lg border border-gray-200 divide-y divide-gray-50 max-h-72 overflow-y-auto">
        {options.map(opt => (
          <label key={opt} className="flex items-center gap-2 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 cursor-pointer">
            <input
              type="checkbox"
              checked={selected.includes(opt)}
              onChange={() => toggle(opt)}
              className="rounded border-gray-300 text-dp-600 focus:ring-dp-500"
            />
            <span>{opt}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
