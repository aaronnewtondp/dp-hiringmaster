import { useEffect, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';

interface MultiSelectFilterProps {
  label:    string;
  options:  string[];
  selected: string[];
  onChange: (selected: string[]) => void;
}

// Shared by Roles.tsx's own filters and Dashboard.tsx's master filters, so
// the two surfaces present identical filter UX for the same underlying
// role fields (Department/Location/Recruitment Mode/Priority/Status).
export default function MultiSelectFilter({ label, options, selected, onChange }: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
          selected.length > 0
            ? 'bg-dp-50 border-dp-200 text-dp-700'
            : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
        }`}
      >
        {label}
        {selected.length > 0 && (
          <span className="bg-dp-600 text-white rounded-full px-1.5 py-0.5 text-[10px] leading-none">
            {selected.length}
          </span>
        )}
        <ChevronDown className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div className="absolute z-40 mt-1 w-56 max-h-72 overflow-y-auto bg-white rounded-lg border border-gray-200 shadow-lg py-1">
          {selected.length > 0 && (
            <button
              onClick={() => onChange([])}
              className="w-full flex items-center gap-1 px-3 py-1.5 text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-50 border-b border-gray-100"
            >
              <X className="w-3 h-3" /> Clear {label.toLowerCase()}
            </button>
          )}
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-400">No options</div>
          ) : (
            options.map(opt => (
              <label
                key={opt}
                className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(opt)}
                  onChange={() => toggle(opt)}
                  className="rounded border-gray-300 text-dp-600 focus:ring-dp-500"
                />
                <span className="truncate">{opt}</span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}
