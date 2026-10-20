import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertCircle, Check, ChevronDown, Clock, Compass, Eye } from 'lucide-react';
import { Spinner } from '../shared/Badges.tsx';
import InfoTooltip from '../shared/InfoTooltip.tsx';
import { useAuth } from '../../contexts/AuthContext.tsx';
import { useSourcingPlan } from '../../hooks/useSourcingPlan.ts';
import { sourcingApi } from '../../services/api.ts';
import { SOURCING_CHANNELS, SourcingCommitment, SourcingException, SourcingPlanChannel, SourcingPlanView } from '../../types/sourcing.ts';
import { dueLabel, exceptionLabel, plural, ymd } from '../../utils/sourcingFormat.ts';
import {
  ActivatePlanModal, AddChannelModal, apiError, CompleteCommitmentModal, EditPlanModal, ExcludeChannelModal, ResolveExceptionModal, SkipCommitmentModal,
} from './SourcingModals.tsx';

const PLAN_STATUS: Record<string, { label: string; cls: string }> = {
  draft:  { label: 'Draft — not tracked yet', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  active: { label: 'Active',                  cls: 'bg-green-50 text-green-700 border-green-200' },
  paused: { label: 'Paused (role on hold)',   cls: 'bg-gray-100 text-gray-600 border-gray-200' },
  closed: { label: 'Closed',                  cls: 'bg-gray-100 text-gray-500 border-gray-200' },
};

const CHANNEL_STATE: Record<string, string> = { planned: 'Not live yet', active: 'Live', excluded: 'Not used' };

function Chip({ children, cls }: { children: React.ReactNode; cls: string }) {
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium ${cls}`}>{children}</span>;
}

type Dialog =
  | { kind: 'activate' }
  | { kind: 'complete'; commitment: SourcingCommitment; channel: string }
  | { kind: 'skip'; commitment: SourcingCommitment; channel: string }
  | { kind: 'resolve'; exception: SourcingException }
  | { kind: 'exclude'; channel: string }
  | { kind: 'addChannel'; preset?: string }
  | { kind: 'editPlan' }
  | null;

// ─── One commitment line ──────────────────────────────────────────────────────────────────────────
function CommitmentRow({ c, today, canEdit, canUndo, busy, onDone, onSkip, onUndo }: {
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
            : isDone ? <span>Done{c.last_done_at ? ` ${new Date(c.last_done_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}</span>
            : <span className={c.overdue ? 'text-red-600 font-medium' : ''}>{dueLabel(c.due_date, today)}{rolling ? ` · repeats every ${plural(c.cadence_days!, 'day')}` : ''}</span>}
          {(c.evidence.auto > 0 || c.evidence.self > 0) && (
            <span title="Auto = captured by HMS itself; self = confirmed by a person">
              Evidence: {c.evidence.auto > 0 ? `${c.evidence.auto} auto` : ''}{c.evidence.auto > 0 && c.evidence.self > 0 ? ' · ' : ''}{c.evidence.self > 0 ? `${c.evidence.self} self-reported` : ''}
            </span>
          )}
          {rolling && last && <span>Last done {new Date(last.done_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}{last.on_time ? '' : ' (late)'}</span>}
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

// ─── One exception ────────────────────────────────────────────────────────────────────────────────
function ExceptionRow({ e, canEdit, onResolve }: { e: SourcingException; canEdit: boolean; onResolve: () => void }) {
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
      <dl className="mt-1.5 grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs">
        <div><dt className="text-gray-400">Committed</dt><dd className="text-gray-700">{e.committed}</dd></div>
        <div><dt className="text-gray-400">What happened</dt><dd className="text-gray-700">{e.happened}</dd></div>
        <div><dt className="text-gray-400">Next</dt><dd className="text-gray-700">{e.next_action}</dd></div>
      </dl>
      {e.reason && <p className="text-xs text-gray-500 mt-1.5"><span className="text-gray-400">Reason given:</span> {e.reason}</p>}
      {canEdit && !e.is_shadow && e.status !== 'resolved' && (
        <div className="mt-2"><button type="button" onClick={onResolve} className="btn-secondary text-xs py-1 px-2.5">{e.status === 'open' ? 'Resolve…' : 'Update…'}</button></div>
      )}
    </li>
  );
}

// ─── The card ─────────────────────────────────────────────────────────────────────────────────────
export default function SourcingCard({ roleId }: { roleId: string }) {
  const qc = useQueryClient();
  const { canHR } = useAuth();
  const { data, isLoading } = useSourcingPlan(roleId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);

  // Module off, or this person may not see it (e.g. a Hiring Manager of another role): render nothing at all.
  if (isLoading) return <div id="sourcing" className="card p-6 flex justify-center"><Spinner /></div>;
  if (!data || !data.enabled || !data.plan) return null;

  const view = data as SourcingPlanView;
  const plan = view.plan!;
  const channels = view.channels ?? [];
  const exceptions = (view.exceptions ?? []).filter(e => e.status !== 'resolved');
  const live = exceptions.filter(e => !e.is_shadow || canHR);
  const canEdit = canHR && !view.read_only && plan.status !== 'closed';
  const today = ymd(0);
  const status = PLAN_STATUS[plan.status] ?? PLAN_STATUS.draft;

  const refresh = () => {
    setDialog(null);
    qc.invalidateQueries({ queryKey: ['sourcing-plan', roleId] });
    qc.invalidateQueries({ queryKey: ['role', roleId] });
    qc.invalidateQueries({ queryKey: ['my-tasks-sourcing'] });
  };

  // A skipped commitment comes back due tomorrow (the server says so); the plan is re-read either way.
  const undoSkip = async (c: SourcingCommitment) => {
    setUndoing(c.id);
    try { await sourcingApi.reopenCommitment(c.id); toast.success('Back on the list'); }
    catch (err) { toast.error(apiError(err, 'Could not bring it back')); }
    setUndoing(null);
    refresh();
  };

  const tracked = plan.status === 'active' || plan.status === 'paused';
  const addable = SOURCING_CHANNELS.filter(c => { const have = channels.find(x => x.channel === c); return !have || have.state === 'excluded'; });
  const vol = view.volume;
  const channelBlock = (ch: SourcingPlanChannel) => {
    const items = ch.commitments;
    return (
      <div key={ch.id} className="py-3 first:pt-0 last:pb-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-900">{ch.channel}</h3>
          <Chip cls={ch.state === 'active' ? 'bg-green-50 text-green-700 border-green-200' : ch.state === 'excluded' ? 'bg-gray-100 text-gray-500 border-gray-200' : 'bg-amber-50 text-amber-700 border-amber-200'}>
            {CHANNEL_STATE[ch.state] ?? ch.state}
          </Chip>
          {ch.state === 'active' && typeof ch.config.posting_url === 'string' && canHR && !view.read_only && (
            <a href={ch.config.posting_url as string} target="_blank" rel="noopener noreferrer" className="text-xs text-dp-600 hover:underline">View posting</a>
          )}
          {canEdit && ch.state !== 'excluded' && plan.status !== 'draft' && (
            <button type="button" onClick={() => setDialog({ kind: 'exclude', channel: ch.channel })} className="ml-auto text-xs text-gray-400 hover:text-gray-600">Stop using</button>
          )}
          {canEdit && ch.state === 'excluded' && tracked && (
            <button type="button" onClick={() => setDialog({ kind: 'addChannel', preset: ch.channel })} className="ml-auto text-xs text-dp-600 hover:underline" aria-label={`Bring back ${ch.channel}`}>Bring back</button>
          )}
        </div>
        {ch.state === 'excluded' && ch.excluded_reason && <p className="text-xs text-gray-400 mt-1">{ch.excluded_reason}</p>}
        {items.length > 0 && (
          <ul className="divide-y divide-gray-50 mt-1">
            {items.map(c => (
              <CommitmentRow key={c.id} c={c} today={today} canEdit={canEdit && plan.status === 'active'}
                canUndo={canEdit && plan.status === 'active' && ch.state !== 'excluded'} busy={undoing === c.id}
                onDone={() => setDialog({ kind: 'complete', commitment: c, channel: ch.channel })}
                onSkip={() => setDialog({ kind: 'skip', commitment: c, channel: ch.channel })}
                onUndo={() => undoSkip(c)} />
            ))}
          </ul>
        )}
      </div>
    );
  };

  return (
    <section id="sourcing" aria-labelledby="sourcing-heading" className="card overflow-hidden scroll-mt-4">
      <div className="px-5 py-3.5 border-b border-gray-100 flex flex-wrap items-center gap-3">
        <h2 id="sourcing-heading" className="text-base font-semibold text-gray-900 flex items-center gap-2">
          <Compass className="w-4 h-4 text-gray-400" aria-hidden="true" />
          Sourcing
        </h2>
        <Chip cls={status.cls}>{status.label}</Chip>
        {view.read_only && <Chip cls="bg-gray-50 text-gray-500 border-gray-200"><Eye className="w-3 h-3" aria-hidden="true" /> View only</Chip>}
        <div className="ml-auto flex items-center gap-3 text-xs text-gray-500">
          <span>Owner: <span className="font-medium text-gray-700">HR</span></span>
          {canEdit && tracked && (
            <button type="button" className="text-xs text-dp-600 hover:underline" onClick={() => setDialog({ kind: 'editPlan' })}>Edit strategy note</button>
          )}
          {canEdit && plan.status === 'draft' && (
            <button type="button" className="btn-primary text-xs py-1.5 px-3" onClick={() => setDialog({ kind: 'activate' })}>Activate plan</button>
          )}
        </div>
      </div>

      <div className="px-5 py-4 space-y-5">
        {plan.status === 'draft' && (
          <p className="text-sm text-gray-600">
            {canEdit
              ? 'Nothing is being tracked for this role yet. Activating the plan starts the clocks on the channels you pick and records what is already running. Sourcing belongs to HR/Admin as a whole, so there is no individual owner to assign.'
              : 'The sourcing plan for this role has not been activated yet.'}
          </p>
        )}

        {canHR && !view.read_only && plan.strategy_note && (
          <p className="text-xs text-gray-500 whitespace-pre-line max-h-24 overflow-y-auto"><span className="text-gray-400">Strategy:</span> {plan.strategy_note}</p>
        )}

        {/* Volume — the SOP's "at least 5 qualified a week" for open P0/P1 roles, with both components visible */}
        {vol?.applicable && plan.status !== 'closed' && (
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <div>
              <span className={`text-2xl font-mono font-bold ${vol.weekly_qualified >= vol.min ? 'text-green-700' : 'text-gray-900'}`}>{vol.weekly_qualified}</span>
              <span className="text-sm text-gray-400"> / {vol.min} qualified in the last 7 days</span>
              <InfoTooltip align="left" text={`Qualified means ${vol.rule === 'either' ? 'shortlisted by a person OR scored above 60 by ResumeIQ' : vol.rule === 'shortlisted' ? 'shortlisted by a person' : 'scored above 60 by ResumeIQ'}. Both parts are shown separately because a score above 60 is easy to reach. A candidate who is both is counted once, so the two parts can add up to more than the total. This is a rolling last 7 days, and the target applies to open P0/P1 roles.`} />
            </div>
            <div className="text-xs text-gray-400">{vol.shortlisted} shortlisted · {vol.scored} scored above 60</div>
          </div>
        )}

        {live.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Needs attention</h3>
            <ul className="space-y-2">
              {live.map(e => <ExceptionRow key={e.id} e={e} canEdit={canEdit} onResolve={() => setDialog({ kind: 'resolve', exception: e })} />)}
            </ul>
          </div>
        )}

        <div>
          {canEdit && tracked && (
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Channels</h3>
              {addable.length > 0 && (
                <button type="button" className="btn-secondary text-xs py-1 px-2.5" onClick={() => setDialog({ kind: 'addChannel' })}>Add channel</button>
              )}
            </div>
          )}
          {channels.length > 0 ? (
            <div className="divide-y divide-gray-100">{channels.map(channelBlock)}</div>
          ) : (
            <p className="text-sm text-gray-400">No channels chosen yet — pick them when you activate the plan.</p>
          )}
        </div>

        {/* Output by source — only what applicants tagged on the form, so it is "claimed" attribution */}
        {(view.output?.length ?? 0) > 0 && plan.status !== 'draft' && !view.read_only && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5 flex items-center gap-1">
              Applications by source
              <InfoTooltip align="left" text="From the 'How did you hear about this role?' answer on the application form, so it is what applicants chose, not a measurement. A source with fewer than 5 applications is too small to judge." />
            </h3>
            <table className="w-full text-xs">
              <thead><tr className="text-left text-gray-400"><th className="font-medium py-1">Source</th><th className="font-medium py-1 text-right">Applications</th><th className="font-medium py-1 text-right"><span className="inline-flex items-center gap-1">Qualified<InfoTooltip align="right" text="Applications from this source that scored above 60 or were moved past Applied and Screened — a snapshot of today over all of this role's applications, not the 7-day target above." /></span></th></tr></thead>
              <tbody className="divide-y divide-gray-50">
                {view.output!.map(o => {
                  const untagged = o.tag === 'untagged_default' || o.tag === '(untagged)';
                  return (
                  <tr key={o.tag}>
                    <td className="py-1 text-gray-700">{untagged ? 'Not tagged' : o.tag}{o.applications < 5 && !untagged && <span className="text-gray-400"> · too few to judge</span>}</td>
                    <td className="py-1 text-right font-mono">{o.applications}</td>
                    <td className="py-1 text-right font-mono">{o.qualified}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {canHR && !view.read_only && (view.changes?.length ?? 0) > 0 && (
          <div>
            <button type="button" onClick={() => setShowHistory(s => !s)} aria-expanded={showHistory} className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showHistory ? '' : '-rotate-90'}`} aria-hidden="true" />
              Plan history ({view.changes!.length})
            </button>
            {showHistory && (
              <ul className="mt-2 space-y-1.5 text-xs text-gray-500">
                {view.changes!.map((c, i) => (
                  <li key={i}>
                    <span className="text-gray-400">{new Date(c.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                    {' · '}{c.by_name ?? 'System'}{' · '}<span className="text-gray-700">{String(c.change?.type ?? 'change').replace(/_/g, ' ')}</span>
                    {c.reason ? <> — {c.reason}</> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {dialog?.kind === 'activate' && <ActivatePlanModal plan={plan} channels={channels} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === 'complete' && <CompleteCommitmentModal commitment={dialog.commitment} channel={dialog.channel} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === 'skip' && <SkipCommitmentModal commitment={dialog.commitment} channel={dialog.channel} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === 'resolve' && <ResolveExceptionModal exception={dialog.exception} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === 'exclude' && <ExcludeChannelModal planId={plan.id} channel={dialog.channel} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === 'addChannel' && <AddChannelModal planId={plan.id} planStatus={plan.status} channels={channels} preset={dialog.preset} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === 'editPlan' && <EditPlanModal plan={plan} onClose={() => setDialog(null)} onDone={refresh} />}
    </section>
  );
}
