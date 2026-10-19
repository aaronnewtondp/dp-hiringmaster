import { ReactNode } from 'react';
import InfoTooltip from './InfoTooltip.tsx';

// ─── KPI card (stat tile v2) ────────────────────────────────────────────────
// Header row: icon + label + the headline number inline (bold, two Tailwind
// steps down from the old standalone 2xl now that it sits beside text).
// Below it: a 2x2 grid of 4 supporting sub-metrics. Sub-metric values stay
// neutral gray uniformly — the header icon's `accent` already carries the
// one severity signal a card needs, so tinting every sub-metric too would
// be redundant emphasis rather than new information.
export default function KpiCard({ icon: Icon, label, value, sub, accent, info, infoWidth, infoAlign = 'left' }: {
  icon: React.ElementType; label: string; value: number | string;
  sub: [string, string | number][]; accent?: string; info?: ReactNode; infoWidth?: string;
  infoAlign?: 'left' | 'right' | 'center';
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-3">
        <Icon className={`w-4 h-4 shrink-0 ${accent || 'text-gray-400'}`} />
        <span className="text-xs font-medium text-gray-500">{label}</span>
        {info && <InfoTooltip text={info} align={infoAlign} {...(infoWidth ? { width: infoWidth } : {})} />}
        <span className="text-3xl font-mono font-bold text-gray-900 ml-auto">{value}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 pt-3 border-t border-gray-100">
        {sub.map(([subLabel, subValue]) => (
          <div key={subLabel}>
            <div className="text-[11px] text-gray-400 leading-tight">{subLabel}</div>
            <div className="text-sm font-mono font-semibold text-gray-700 mt-0.5">{subValue}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
