import { STAGES } from '../../types/index.ts';

// Horizontal stage tracker for one application — a thin block per canonical
// stage (STAGES, types/index.ts), filled up to and including the current
// stage, with the current stage itself given a ring so it's distinguishable
// from stages already passed through.
export default function PipelineProgress({ stage, label }: { stage: string; label?: string }) {
  const currentIdx = STAGES.indexOf(stage);

  return (
    <div>
      {label && <div className="text-xs text-gray-400 mb-1">{label}</div>}
      <div className="flex items-center gap-0.5">
        {STAGES.map((s, i) => {
          const reached   = currentIdx >= 0 && i <= currentIdx;
          const isCurrent = i === currentIdx;
          return (
            <div
              key={s}
              title={s}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                isCurrent ? 'bg-dp-600 ring-2 ring-dp-200' : reached ? 'bg-dp-400' : 'bg-gray-200'
              }`}
            />
          );
        })}
      </div>
      {currentIdx >= 0 && <div className="text-[11px] text-dp-700 font-medium mt-1">{stage}</div>}
    </div>
  );
}
