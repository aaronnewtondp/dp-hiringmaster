import { STAGES } from '../../types/index.ts';

// 13-stage always-visible chevron tracker (item #27, redesigned per user
// reference images) — every stage gets its own labeled, glossy interlocking
// arrow, all shown at once. Stages up to and including the current one show
// their assigned color; everything after is greyed out but still labeled.
// Colors mirror this app's existing StageBadge hues where one already
// exists, extended with new hues for stages that didn't have one, then
// hand-tuned per user feedback so adjacent stages blend rather than jump
// between unrelated hue families.
export const STAGE_COLORS: Record<string, string> = {
  'Applied':               '#64748b',
  'Interview Round 1':     '#a855f7',
  'Interview Round 2':     '#8b5cf6',
  'Assignment Round':      '#7761f4',
  'Founders Round':        '#6366f1',
  'Reference Check':       '#4870b9',
  'Pre-Joining Documents': '#2d7a80',
  'Offer Discussion':      '#3d9da3',
  'Offer Released':        '#14b8a6',
  'Offer Accepted':        '#10b981',
  'Joined':                '#22c55e',
};

// Shortened for the tight in-arrow label — full stage name still shows via
// the native title tooltip on hover.
const STAGE_LABELS: Record<string, string> = {
  'Applied': 'Applied',
  'Interview Round 1': 'Interview 1',
  'Interview Round 2': 'Interview 2',
  'Assignment Round': 'Assignment',
  'Founders Round': 'Founders',
  'Reference Check': 'Reference Check',
  'Pre-Joining Documents': 'Pre-Joining',
  'Offer Discussion': 'Discussion',
  'Offer Released': 'Released',
  'Offer Accepted': 'Accepted',
  'Joined': 'Joined',
};

export const UNLIT_BG = '#6b7280';

// Point/notch depth is 20% of a segment's own box in both clip-paths below.
// The overlap here is intentionally less than that (eased ~20% off a full
// interlock, per feedback) so a sliver of each arrow's own color still
// shows at the seam instead of a perfectly flush edge. Expressed as a % of
// the ROW's width (not each segment's) since margin-left percentages
// resolve against the containing block — this keeps the interlock
// proportionally identical at any container width.
const OVERLAP_PCT = (100 / STAGES.length) * 0.16;

const CLIP_FIRST = 'polygon(0% 0%, 80% 0%, 100% 50%, 80% 100%, 0% 100%)';
const CLIP_REST  = 'polygon(0% 0%, 80% 0%, 100% 50%, 80% 100%, 0% 100%, 20% 50%)';

export const shade = (hex: string, amount: number) => {
  const n = parseInt(hex.slice(1), 16);
  const clamp = (v: number) => Math.min(255, Math.max(0, v));
  const r = clamp((n >> 16) + amount);
  const g = clamp(((n >> 8) & 0xff) + amount);
  const b = clamp((n & 0xff) + amount);
  return `rgb(${r}, ${g}, ${b})`;
};

export const glossyFill = (hex: string) =>
  `linear-gradient(180deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.08) 38%, rgba(255,255,255,0) 55%), ` +
  `linear-gradient(180deg, ${shade(hex, 55)} 0%, ${hex} 55%, ${shade(hex, -35)} 100%)`;

export default function PipelineProgress({ stage, label }: { stage: string; label?: string }) {
  const currentIdx = STAGES.indexOf(stage);

  return (
    <div className="w-full">
      {label && <div className="text-xs text-gray-400 mb-1.5">{label}</div>}
      <div className="flex w-full overflow-x-auto">
        {STAGES.map((s, i) => {
          const reached = currentIdx >= 0 && i <= currentIdx;
          const shadow = reached
            ? 'inset 0 1px 1px rgba(255,255,255,0.5), inset 0 -3px 4px rgba(0,0,0,0.18), 0 1px 2px rgba(0,0,0,0.15)'
            : 'inset 0 1px 1px rgba(255,255,255,0.3), inset 0 -3px 4px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.1)';
          return (
            <div
              key={s}
              title={s}
              className="flex items-center justify-center transition-colors"
              style={{
                flex: '1 1 0%',
                minWidth: 70,
                height: 52,
                marginLeft: i === 0 ? 0 : `-${OVERLAP_PCT}%`,
                background: glossyFill(reached ? STAGE_COLORS[s] : UNLIT_BG),
                boxShadow: shadow,
                clipPath: i === 0 ? CLIP_FIRST : CLIP_REST,
                padding: '0 16px',
              }}
            >
              <span
                className="text-white font-bold uppercase whitespace-nowrap"
                style={{ fontSize: '7.5px', letterSpacing: '0.01em', textShadow: '0 1px 1px rgba(0,0,0,0.2)' }}
              >
                {STAGE_LABELS[s]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
