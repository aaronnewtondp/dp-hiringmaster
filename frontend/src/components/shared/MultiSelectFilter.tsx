import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectFilterProps {
  label:    string;
  // Plain strings for options where the displayed text and the filter
  // value are the same (Department, Location, ...). {value,label} for
  // options where they differ — the Role filter needs to show a role's
  // title while filtering by its id, since titles aren't unique.
  options:  Array<string | MultiSelectOption>;
  selected: string[];
  onChange: (selected: string[]) => void;
}

// Shared by Roles.tsx's own filters and Dashboard.tsx/Candidates.tsx's
// master filters, so every surface presents identical filter UX for the
// same underlying role fields (Department/Location/Recruitment Mode/
// Priority/Status/Role).
export default function MultiSelectFilter({ label, options, selected, onChange }: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const normalized: MultiSelectOption[] = options.map(o => typeof o === 'string' ? { value: o, label: o } : o);

  // Positions the panel relative to the VIEWPORT (not the button's nearest
  // positioned ancestor) and renders it via a portal straight onto
  // document.body. Needed because Candidates.tsx's filter bar scrolls
  // horizontally (overflow-x-auto) — and per the CSS spec, any axis with a
  // non-"visible" overflow forces the other axis to behave as "auto" too,
  // so a plain `absolute` dropdown would get vertically clipped by that
  // same ancestor even though only horizontal scrolling was intended.
  const reposition = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) setCoords({ top: rect.bottom + 4, left: rect.left });
  };

  useEffect(() => {
    if (!open) return;
    reposition();
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]);
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1 px-2 py-1.5 rounded-lg border text-xs font-medium whitespace-nowrap transition-colors ${
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

      {open && createPortal(
        <div
          ref={panelRef}
          style={{ top: coords.top, left: coords.left }}
          className="fixed z-50 w-56 max-h-72 overflow-y-auto bg-white rounded-lg border border-gray-200 shadow-lg py-1"
        >
          {selected.length > 0 && (
            <button
              onClick={() => onChange([])}
              className="w-full flex items-center gap-1 px-3 py-1.5 text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-50 border-b border-gray-100"
            >
              <X className="w-3 h-3" /> Clear {label.toLowerCase()}
            </button>
          )}
          {normalized.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-400">No options</div>
          ) : (
            normalized.map(opt => (
              <label
                key={opt.value}
                className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(opt.value)}
                  onChange={() => toggle(opt.value)}
                  className="rounded border-gray-300 text-dp-600 focus:ring-dp-500"
                />
                <span className="truncate">{opt.label}</span>
              </label>
            ))
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
