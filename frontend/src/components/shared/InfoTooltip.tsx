import { useState, useRef, useEffect, ReactNode } from 'react';
import { Info } from 'lucide-react';

// Small "i" marker used throughout the app to explain what a metric, badge,
// or section actually means — hover (or tap/click, for touch and keyboard
// users) reveals the explanation without taking up permanent layout space.
// `text` accepts a plain string for a one-liner, or a ReactNode (e.g. a list)
// for anything with more structure — the SLA breach-type box being the main
// case that needs it. `width` defaults to a compact one-liner size; pass a
// wider Tailwind width class for longer/structured content.
export default function InfoTooltip({ text, className = '', align = 'center', width = 'w-64' }: {
  text: ReactNode; className?: string; align?: 'center' | 'left' | 'right'; width?: string;
}) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!show) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [show]);

  const alignClass =
    align === 'left'  ? 'left-0' :
    align === 'right' ? 'right-0' :
    'left-1/2 -translate-x-1/2';

  return (
    <span ref={ref} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onClick={e => { e.stopPropagation(); setShow(s => !s); }}
        className="text-gray-300 hover:text-dp-600 transition-colors"
        aria-label="More info"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {show && (
        // normal-case/font-normal/tracking-normal override rather than
        // inherit — this icon shows up inside table headers styled
        // uppercase/tracking-wide/font-medium (table-th), which would
        // otherwise cascade into the popover and turn a normal-case
        // sentence into unreadable all-caps.
        <div className={`absolute z-50 top-full mt-1.5 ${width} p-2.5 rounded-lg bg-gray-900 text-white text-[11px] normal-case font-normal tracking-normal leading-relaxed shadow-lg ${alignClass}`}>
          {text}
        </div>
      )}
    </span>
  );
}
