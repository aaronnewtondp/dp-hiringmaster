// Small building blocks shared by the sourcing plan panel: chips, one task line, one exception (with its next steps).
import { AlertCircle, Check, Clock, X } from 'lucide-react';
import InfoTooltip from '../shared/InfoTooltip.tsx';
import { AdviceStep, SourcingCommitment, SourcingException } from '../../types/sourcing.ts';
import { dueLabel, exceptionLabel, plural } from '../../utils/sourcingFormat.ts';

export function Chip({ children, cls }: { children: React.ReactNode; cls: string }) {
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium ${cls}`}>{children}</span>;
}

export const PLAN_STATUS: Record<string, { label: string; cls: string }> = {
  draft:  { label: 'Draft — not tracked yet', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  active: { label: 'Active',                  cls: 'bg-green-50 text-green-700 border-green-200' },
  paused: { label: 'Paused (role on hold)',   cls: 'bg-gray-100 text-gray-600 border-gray-200' },
  closed: { label: 'Closed',                  cls: 'bg-gray-100 text-gray-500 border-gray-200' },
};

export const IMPACT: Record<AdviceStep['impact'], { label: string; cls: string }> = {
  high:   { label: 'High impact',   cls: 'bg-red-50 text-red-700 border-red-200' },
  medium: { label: 'Medium impact', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  low:    { label: 'Low impact',    cls: 'bg-gray-50 text-gray-500 border-gray-200' },
};

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// ─── One task line ────────────────────────────────────────────────────────────────────────────────
export function CommitmentRow({ c, today, canEdit, canUndo, busy, onDone, onSkip, onUndo }: {
  c: SourcingCommitment; today: string; canEdit: boolean; canUndo: boolean; busy: boolean; onDone: () => void; onSkip: () => void; onUndo: () => void;
}) {
  const rolling = c.cadence_days !== null;
  const isDone = !rolling && c.status === 'done';
  const skipped = c.status === 'skipped';
  const last = c.recent[0];
  return (
    <li className="flex items-start gap-3 py-2">
      <span className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${isDone ? 'bg-green-100' : c.overdue ? 'bg-red-100' : 'bg-gray-100'}`} aria-hidden="true">
        {isDone ? <Check className="w-3 h-3 text-green-600" /> : c.overdue ? <AlertCircle className="w-3 h-3 text-red-600" /> : <Clock className="w-3 h-3 text-gray-400" />}
      </span>
      <div className="flex-1 min-w-0">
        <div className={`text-sm ${skipped ? 'text-gray-400 line-through' : 'text-gray-800'}`}>{c.title}</div>
        <div className="text-xs text-gray-400 mt-0.5 flex flex-wrap gap-x-3">
          {skipped ? <span>Skipped</span>
            : isDone ? <span>Done{c.last_done_at ? ` ${day(c.last_done_at)}` : ''}</span>
            : <span className={c.overdue ? 'text-red-600 font-medium' : ''}>{dueLabel(c.due_date, today)}{rolling ? ` · repeats every ${plural(c.cadence_days!, 'day')}` : ''}</span>}
          {/* Evidence belongs to a finished task (or a repeating one's last completion). A one-off task that is open again — handed back because it
              needs a link and a weekly target — is not complete, so a past completion's evidence is not shown against it. */}
          {(isDone || rolling) && (c.evidence.auto > 0 || c.evidence.self > 0) && (
            <span title="Auto = captured by HMS itself; self = confirmed by a person">
              Evidence: {c.evidence.auto > 0 ? `${c.evidence.auto} auto` : ''}{c.evidence.auto > 0 && c.evidence.self > 0 ? ' · ' : ''}{c.evidence.self > 0 ? `${c.evidence.self} self-reported` : ''}
            </span>
          )}
          {rolling && last && <span>Last done {day(last.done_at)}{last.on_time ? '' : ' (late)'}</span>}
        </div>
      </div>
      {canEdit && !isDone && !skipped && (
        <div className="flex gap-1.5 shrink-0">
          <button type="button" onClick={onDone} className="btn-secondary text-xs py-1 px-2.5">Mark done</button>
          <button type="button" onClick={onSkip} className="text-xs text-gray-400 hover:text-gray-600 px-1.5" aria-label={`Skip: ${c.title}`}>Skip</button>
        </div>
      )}
      {skipped && canUndo && (
        <button type="button" onClick={onUndo} disabled={busy} className="btn-secondary text-xs py-1 px-2.5 shrink-0" aria-label={`Undo skip: ${c.title}`}>Undo skip</button>
      )}
    </li>
  );
}

// ─── One recommended step (the AI's or the rules' answer) ──────────────────────────────────────────
export function StepItem({ step }: { step: AdviceStep }) {
  const impact = IMPACT[step.impact];
  return (
    <li className="text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-medium text-gray-900">{step.title}</span>
        <Chip cls={impact.cls}>{impact.label}</Chip>
        {step.channel && <Chip cls="bg-white text-gray-600 border-gray-200">{step.channel}</Chip>}
        {step.owner === 'Hiring Manager' && <Chip cls="bg-amber-50 text-amber-800 border-amber-200">Needs the Hiring Manager</Chip>}
      </div>
      <p className="text-gray-600 mt-0.5 leading-relaxed">{step.detail}</p>
    </li>
  );
}

// ─── One exception ────────────────────────────────────────────────────────────────────────────────
/** `steps` are the advisor's steps written for THIS problem; without them the plain next action is shown. */
export function ExceptionRow({ e, canEdit, steps, advicePending, onResolve }: {
  e: SourcingException; canEdit: boolean; steps: AdviceStep[]; advicePending: boolean; onResolve: () => void;
}) {
  const tone = e.is_shadow || e.status === 'snoozed' ? 'border-gray-200 bg-gray-50' : e.status === 'blocked' ? 'border-amber-200 bg-amber-50/50' : 'border-red-200 bg-red-50/40';
  return (
    <li className={`rounded-lg border px-3.5 py-3 ${tone}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-gray-900">{exceptionLabel(e.type)}</span>
        {e.channel !== '*' && <Chip cls="bg-white text-gray-600 border-gray-200">{e.channel}</Chip>}
        {e.is_shadow && (
          <Chip cls="bg-white text-gray-500 border-gray-300">
            Provisional
            <InfoTooltip align="left" text="A new signal still being calibrated: only HR/Admin and Leadership can see it, here and on the dashboard. It does not raise tasks, send e-mails, show in the header chip or count in the totals, and it can't be resolved yet." />
          </Chip>
        )}
        {e.status === 'blocked' && <Chip cls="bg-amber-100 text-amber-800 border-amber-200">Blocked{e.blocker_due ? ` until ${e.blocker_due}` : ''}</Chip>}
        {e.status === 'snoozed' && <Chip cls="bg-white text-gray-600 border-gray-200">Catching up by {e.snooze_until}</Chip>}
      </div>
      <dl className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div><dt className="text-gray-400">Committed</dt><dd className="text-gray-700">{e.committed}</dd></div>
        <div><dt className="text-gray-400">What happened</dt><dd className="text-gray-700">{e.happened}</dd></div>
      </dl>
      <div className="mt-2 rounded-md bg-white/70 border border-gray-100 px-3 py-2" data-testid="exception-next">
        <div className="text-xs text-gray-400 mb-1">Next</div>
        {steps.length > 0 ? (
          <ol className="space-y-2 list-decimal pl-4 marker:text-gray-300">{steps.map(s => <StepItem key={s.id} step={s} />)}</ol>
        ) : (
          <p className="text-xs text-gray-700">{e.next_action}{advicePending && <span className="text-gray-400"> · working out detailed steps…</span>}</p>
        )}
      </div>
      {e.reason && <p className="text-xs text-gray-500 mt-1.5"><span className="text-gray-400">Reason given:</span> {e.reason}</p>}
      {canEdit && !e.is_shadow && e.status !== 'resolved' && (
        <div className="mt-2"><button type="button" onClick={onResolve} className="btn-secondary text-xs py-1 px-2.5">{e.status === 'open' ? 'Resolve…' : 'Update…'}</button></div>
      )}
    </li>
  );
}

export function ResultChip({ met, partial }: { met: boolean; partial?: boolean }) {
  if (partial) return <Chip cls="bg-gray-50 text-gray-500 border-gray-200">Cut short</Chip>;
  return met
    ? <Chip cls="bg-green-50 text-green-700 border-green-200"><Check className="w-3 h-3" aria-hidden="true" />Met</Chip>
    : <Chip cls="bg-red-50 text-red-700 border-red-200"><X className="w-3 h-3" aria-hidden="true" />Missed</Chip>;
}
