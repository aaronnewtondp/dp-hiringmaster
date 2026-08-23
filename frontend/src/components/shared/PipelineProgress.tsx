import { STAGES } from '../../types/index.ts';

// Chevron/arrow-block pipeline tracker (item #27) — bold interlocking
// right-pointing arrows (clip-path), matching the reference image's design
// philosophy: solid color blocks, current step called out with a real
// label inside its own chevron rather than a caption floating below the
// bar. Adapted for a 13-stage pipeline (too many to label every block
// individually and stay legible) by growing only the CURRENT stage's arrow
// to carry its name — every other stage stays a compact, unlabeled block
// whose fill color alone shows reached/current/upcoming; hover any of them
// for the stage name via the native title tooltip.
export default function PipelineProgress({ stage, label }: { stage: string; label?: string }) {
  const currentIdx = STAGES.indexOf(stage);

  return (
    <div>
      {label && <div className="text-xs text-gray-400 mb-1.5">{label}</div>}
      <div className="flex items-stretch">
        {STAGES.map((s, i) => {
          const reached   = currentIdx >= 0 && i <= currentIdx;
          const isCurrent = i === currentIdx;
          return (
            <div
              key={s}
              title={s}
              className={`h-9 flex items-center justify-center transition-colors ${
                isCurrent ? 'bg-dp-600' : reached ? 'bg-dp-400' : 'bg-gray-200'
              }`}
              style={{
                flex: isCurrent ? '3 1 0%' : '1 1 0%',
                minWidth: isCurrent ? '96px' : undefined,
                clipPath: i === 0
                  ? 'polygon(0% 0%, 82% 0%, 100% 50%, 82% 100%, 0% 100%)'
                  : 'polygon(0% 0%, 82% 0%, 100% 50%, 82% 100%, 0% 100%, 15% 50%)',
                marginLeft: i === 0 ? 0 : '-10px',
              }}
            >
              {isCurrent && (
                <span className="text-white text-[11px] font-bold uppercase tracking-wide truncate px-2">
                  {s}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
