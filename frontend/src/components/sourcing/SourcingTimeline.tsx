import { useMemo, useState } from 'react';
import { PlanChange, TimelineCategory } from '../../types/sourcing.ts';

const FILTERS: Array<{ id: 'all' | TimelineCategory; label: string }> = [
  { id: 'all', label: 'Everything' }, { id: 'task', label: 'Tasks' }, { id: 'channel', label: 'Channels' }, { id: 'weekly', label: 'Weekly results' },
  { id: 'target', label: 'Targets' }, { id: 'exception', label: 'Alerts' }, { id: 'plan', label: 'Plan' },
];
const DOT: Record<TimelineCategory, string> = {
  task: 'bg-dp-400', channel: 'bg-indigo-500', weekly: 'bg-emerald-500', target: 'bg-amber-500', exception: 'bg-red-400', plan: 'bg-gray-400',
};
const PAGE = 15;

const localDay = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function dayHeading(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (localDay(iso) === localDay(now.toISOString())) return 'Today';
  if (localDay(iso) === localDay(y.toISOString())) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/**
 * The plan's activity timeline: every action taken in the sourcing workspace — tasks done / skipped, channels added / closed / reopened, targets,
 * what the system flagged or cleared, each finished tracker week — newest first, with who did it (or "System").
 */
export default function SourcingTimeline({ changes, total }: { changes: PlanChange[]; total: number }) {
  const [filter, setFilter] = useState<'all' | TimelineCategory>('all');
  const [shown, setShown] = useState(PAGE);
  const rows = useMemo(() => (filter === 'all' ? changes : changes.filter(c => c.category === filter)), [changes, filter]);
  const counts = useMemo(() => {
    const m: Record<string, number> = { all: changes.length };
    for (const c of changes) m[c.category] = (m[c.category] ?? 0) + 1;
    return m;
  }, [changes]);
  const visible = rows.slice(0, shown);

  let lastDay = '';
  return (
    <section aria-label="Plan history" data-testid="plan-timeline">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Plan history <span className="font-normal normal-case">({total})</span></h3>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter the plan history">
          {FILTERS.filter(f => f.id === 'all' || counts[f.id]).map(f => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => { setFilter(f.id); setShown(PAGE); }}
              className={`px-2 py-0.5 rounded-full border text-[11px] ${filter === f.id ? 'bg-dp-600 text-white border-dp-600' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'}`}>
              {f.label}{f.id !== 'all' ? ` ${counts[f.id]}` : ''}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? <p className="text-xs text-gray-400">Nothing here yet.</p> : (
        <ol className="relative border-l border-gray-100 ml-1.5 space-y-0">
          {visible.map(c => {
            const day = localDay(c.at);
            const heading = day !== lastDay ? dayHeading(c.at) : null;
            lastDay = day;
            return (
              <li key={c.id} className="pl-4 pb-2.5 relative">
                {heading && <div className="text-[11px] font-medium text-gray-400 -ml-4 mb-1 pl-4 pt-1">{heading}</div>}
                <span className={`absolute -left-[4.5px] ${heading ? 'top-[27px]' : 'top-[7px]'} w-2 h-2 rounded-full ${DOT[c.category] ?? 'bg-gray-300'}`} aria-hidden="true" />
                <div className="text-xs text-gray-700" data-testid="timeline-entry">
                  {c.text}
                  {c.reason && <span className="text-gray-500"> — “{c.reason}”</span>}
                </div>
                <div className="text-[11px] text-gray-400">
                  {new Date(c.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · {c.by_name ?? 'System'}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {rows.length > shown && (
        <button type="button" onClick={() => setShown(s => s + 20)} className="mt-1 text-xs text-dp-600 hover:underline">Show {Math.min(20, rows.length - shown)} more</button>
      )}
      {total > changes.length && filter === 'all' && rows.length <= shown && (
        <p className="mt-1 text-[11px] text-gray-400">Showing the latest {changes.length} of {total} entries.</p>
      )}
    </section>
  );
}
