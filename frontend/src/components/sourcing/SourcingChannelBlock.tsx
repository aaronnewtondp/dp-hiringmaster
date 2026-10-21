import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { SourcingCommitment, SourcingPlanChannel, TrackerWeek } from '../../types/sourcing.ts';
import { plural, shortDate, weekLabel } from '../../utils/sourcingFormat.ts';
import { Chip, CommitmentRow, ResultChip } from './SourcingParts.tsx';

const STATE_LABEL: Record<string, string> = { planned: 'Not live yet', active: 'Live', excluded: 'Not used', closed: 'Closed' };
const STATE_CLS: Record<string, string> = {
  active: 'bg-green-50 text-green-700 border-green-200', planned: 'bg-amber-50 text-amber-700 border-amber-200',
  excluded: 'bg-gray-100 text-gray-500 border-gray-200', closed: 'bg-gray-100 text-gray-600 border-gray-300',
};
const WEEKS_SHOWN = 6;

const daysLeft = (end: string, today: string) => Math.max(0, Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000));

/** Finished weeks, newest first: applicants tagged with the channel on the application form against the weekly target — green when met, red when missed. */
function WeeksTable({ weeks, label }: { weeks: TrackerWeek[]; label: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? weeks : weeks.slice(0, WEEKS_SHOWN);
  return (
    <div>
      <table className="w-full text-xs" aria-label={label}>
        <thead>
          <tr className="text-left text-gray-400">
            <th className="font-medium py-1">Week</th>
            <th className="font-medium py-1 text-right">Applicants</th>
            <th className="font-medium py-1 text-right">Target</th>
            <th className="font-medium py-1 text-right">Result</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {shown.map(w => (
            <tr key={w.week_start} className={w.partial ? '' : w.met ? 'bg-green-50/40' : 'bg-red-50/40'} data-testid="tracker-week">
              <td className="py-1 pl-1.5 text-gray-700">{weekLabel(w.week_start, w.week_end)}</td>
              <td className="py-1 text-right font-mono">{w.actual}<span className="text-gray-400"> ({w.qualified} qualified)</span></td>
              <td className="py-1 text-right font-mono">{w.target}</td>
              <td className="py-1 pr-1.5 text-right"><ResultChip met={w.met} partial={w.partial} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {weeks.length > WEEKS_SHOWN && (
        <button type="button" onClick={() => setAll(a => !a)} className="mt-1 text-xs text-dp-600 hover:underline">{all ? 'Show fewer weeks' : `Show all ${weeks.length} weeks`}</button>
      )}
    </div>
  );
}

function Tracker({ ch, hr, canEdit, today, planActive, onEdit }: { ch: SourcingPlanChannel; hr: boolean; canEdit: boolean; today: string; planActive: boolean; onEdit: () => void }) {
  const t = ch.tracker;
  if (t.target === null) {
    return (
      <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-800" data-testid="tracker-no-target">
        No weekly sourcing target is set for {ch.channel} yet, so it is not being tracked.
        {canEdit && <> <button type="button" onClick={onEdit} className="underline font-medium">Add the target and post link</button> to start weekly tracking.</>}
      </div>
    );
  }
  const r = t.running;
  const pct = r ? Math.min(100, Math.round((r.actual / Math.max(1, r.target)) * 100)) : 0;
  return (
    <div className="mt-2 space-y-2.5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-gray-600">
        <span>Weekly sourcing target: <span className="font-mono font-semibold text-gray-900">{t.target}</span> applicants <span className="text-gray-400">(qualified + unqualified)</span></span>
        {hr && t.link && <a href={t.link} target="_blank" rel="noopener noreferrer" className="text-dp-600 hover:underline">View {ch.channel === 'Direct Outreach' ? 'campaign' : 'job post'}</a>}
        {canEdit && <button type="button" onClick={onEdit} className="text-dp-600 hover:underline" aria-label={`Edit ${ch.channel} target and link`}>Edit target{hr ? ' and link' : ''}</button>}
      </div>
      {planActive && !r && t.anchor && t.anchor > today && (
        <p className="text-xs text-gray-500" data-testid="tracker-restarts">
          Tracking restarts on {shortDate(t.anchor)} (the days up to then are already in the week cut short above).
        </p>
      )}
      {!planActive && !r && (
        <p className="text-xs text-gray-500" data-testid="tracker-paused">
          The weekly tracker is stopped while the role is on hold (the week in progress was kept as “cut short”). It starts again the day the role is back on.
        </p>
      )}
      {r && (
        <div data-testid="tracker-running">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-gray-700"><span className="font-medium">This week</span> <span className="text-gray-400">({weekLabel(r.start, r.end)})</span></span>
            <span className="text-gray-500"><span className="font-mono font-semibold text-gray-900">{r.actual}</span> of {r.target} so far · {plural(daysLeft(r.end, today), 'day')} left{r.qualified > 0 ? ` · ${r.qualified} qualified` : ''}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-gray-100 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={r.target} aria-valuenow={Math.min(r.actual, r.target)} aria-label={`${ch.channel} applicants this week`}>
            <div className={`h-full ${r.actual >= r.target ? 'bg-green-500' : 'bg-dp-400'}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {t.weeks.length > 0
        ? <WeeksTable weeks={t.weeks} label={`${ch.channel} weekly results`} />
        : <p className="text-xs text-gray-400">{r ? `The first week finishes on ${shortDate(r.end)}; its result` : 'The result of each week'} (met or missed) is added here automatically.</p>}
    </div>
  );
}

/** What a closed channel leaves behind: the post, the targets, every tracked week. */
function ClosedSummary({ ch, hr }: { ch: SourcingPlanChannel; hr: boolean }) {
  const [open, setOpen] = useState(true);
  const t = ch.tracker;
  return (
    <div className="mt-2 rounded-md border border-gray-200 bg-gray-50/60 px-3 py-2.5 text-xs space-y-2" data-testid="closed-summary">
      <p className="text-gray-600">
        Closed {ch.closed_at ? shortDate(ch.closed_at.slice(0, 10)) : ''}{hr && ch.closed_reason ? <> — <span className="text-gray-700">{ch.closed_reason}</span></> : null}
      </p>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1">
        {t.applicable && <div><dt className="text-gray-400">Weekly target</dt><dd className="font-mono font-semibold text-gray-900">{t.target ?? '—'}</dd></div>}
        {t.applicable && <div><dt className="text-gray-400">Weeks tracked</dt><dd className="font-mono font-semibold text-gray-900">{t.totals.weeks}{t.totals.weeks > 0 ? <span className="text-gray-400 font-normal"> · {t.totals.met} on target</span> : null}</dd></div>}
        <div><dt className="text-gray-400">Applicants tagged</dt><dd className="font-mono font-semibold text-gray-900">{t.sourced.applications}<span className="text-gray-400 font-normal"> · {t.sourced.qualified} qualified</span></dd></div>
        {hr && t.link && <div><dt className="text-gray-400">{ch.channel === 'Direct Outreach' ? 'Campaign' : 'Job post'}</dt><dd><a href={t.link} target="_blank" rel="noopener noreferrer" className="text-dp-600 hover:underline">Open link</a></dd></div>}
      </dl>
      {t.weeks.length > 0 && (
        <div>
          <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="flex items-center gap-1 text-gray-500 hover:text-gray-700">
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden="true" />Weekly results ({t.weeks.length})
          </button>
          {open && <div className="mt-1.5"><WeeksTable weeks={t.weeks} label={`${ch.channel} weekly results`} /></div>}
        </div>
      )}
    </div>
  );
}

export default function SourcingChannelBlock({ ch, hr, canEdit, canManage = canEdit, planActive, today, undoingId, onComplete, onSkip, onUndo, onClose, onReopen, onBringBack, onEdit }: {
  ch: SourcingPlanChannel;
  hr: boolean;                 // HR-tier and not the read-only Hiring Manager view: links and free-text reasons are visible
  canEdit: boolean;            // may act (HR-tier, plan not closed, not the read-only view)
  canManage?: boolean;         // may close / reopen / bring back / edit a channel: canEdit AND the plan is being tracked (a draft chooses its channels at activation). Defaults to canEdit.
  planActive: boolean;         // tasks can be completed only on an active plan
  today: string;
  undoingId: string | null;
  onComplete: (c: SourcingCommitment) => void; onSkip: (c: SourcingCommitment) => void; onUndo: (c: SourcingCommitment) => void;
  onClose: () => void; onReopen: () => void; onBringBack: () => void; onEdit: () => void;
}) {
  const live = ch.state === 'planned' || ch.state === 'active';
  return (
    <div className="py-3 first:pt-0 last:pb-0" data-testid={`channel-${ch.channel}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <h4 className="text-sm font-semibold text-gray-900">{ch.channel}</h4>
        <Chip cls={STATE_CLS[ch.state] ?? STATE_CLS.planned}>{STATE_LABEL[ch.state] ?? ch.state}</Chip>
        {canManage && live && (
          <button type="button" onClick={onClose} className="ml-auto text-xs text-gray-500 hover:text-gray-800 hover:underline" aria-label={`Close ${ch.channel}`}>Close channel</button>
        )}
        {canManage && ch.state === 'closed' && (
          <button type="button" onClick={onReopen} className="ml-auto text-xs text-dp-600 hover:underline" aria-label={`Reopen ${ch.channel}`}>Reopen channel</button>
        )}
        {canManage && ch.state === 'excluded' && (
          <button type="button" onClick={onBringBack} className="ml-auto text-xs text-dp-600 hover:underline" aria-label={`Bring back ${ch.channel}`}>Bring back</button>
        )}
      </div>

      {ch.state === 'excluded' && ch.excluded_reason && <p className="text-xs text-gray-400 mt-1">{ch.excluded_reason}</p>}
      {ch.state === 'closed' && <ClosedSummary ch={ch} hr={hr} />}

      {ch.state === 'active' && ch.tracker.applicable && <Tracker ch={ch} hr={hr} canEdit={canManage} today={today} planActive={planActive} onEdit={onEdit} />}

      {live && ch.commitments.length > 0 && (
        <ul className="divide-y divide-gray-50 mt-1.5">
          {ch.commitments.map(c => (
            <CommitmentRow key={c.id} c={c} today={today} canEdit={canEdit && planActive}
              canUndo={canEdit && planActive} busy={undoingId === c.id}
              onDone={() => onComplete(c)} onSkip={() => onSkip(c)} onUndo={() => onUndo(c)} />
          ))}
        </ul>
      )}
    </div>
  );
}
