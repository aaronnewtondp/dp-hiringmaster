import { STAGES } from '../../types/index.ts';

// Chevron/arrow-block pipeline tracker (item #27, redesigned per reference)
// — each canonical stage (STAGES, types/index.ts) is rendered as an
// interlocking right-pointing arrow via clip-path, filled up to and
// including the current stage, with the current one in a more saturated
// shade. Only the current stage's name is shown as a label below the whole
// bar rather than inside any one arrow — 13 stages are too many to fit
// readable text inside each individual segment — hover any segment for its
// name via the native title tooltip.
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
              className={`h-5 flex-1 transition-colors ${
                isCurrent ? 'bg-dp-600' : reached ? 'bg-dp-400' : 'bg-gray-200'
              }`}
              style={{
                clipPath: i === 0
                  ? 'polygon(0% 0%, 88% 0%, 100% 50%, 88% 100%, 0% 100%)'
                  : 'polygon(0% 0%, 88% 0%, 100% 50%, 88% 100%, 0% 100%, 12% 50%)',
                marginLeft: i === 0 ? 0 : '-8px',
              }}
            />
          );
        })}
      </div>
      {currentIdx >= 0 && <div className="text-[11px] text-dp-700 font-medium mt-1.5">{stage}</div>}
    </div>
  );
}
