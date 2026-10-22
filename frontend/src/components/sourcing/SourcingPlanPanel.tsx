import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Eye, RefreshCw, Sparkles } from 'lucide-react';
import { Spinner, PriorityBadge } from '../shared/Badges.tsx';
import InfoTooltip from '../shared/InfoTooltip.tsx';
import { useAuth } from '../../contexts/AuthContext.tsx';
import { useSourcingAdvice, useSourcingPlan } from '../../hooks/useSourcingPlan.ts';
import { sourcingApi } from '../../services/api.ts';
import { SOURCING_CHANNELS, SourcingCommitment, SourcingException, SourcingPlanChannel, SourcingPlanView } from '../../types/sourcing.ts';
import { ymd } from '../../utils/sourcingFormat.ts';
import SourcingChannelBlock from './SourcingChannelBlock.tsx';
import {
  ActivatePlanModal, AddChannelModal, apiError, CloseChannelModal, CompleteCommitmentModal, EditChannelModal, EditPlanModal, ReopenChannelModal,
  ResolveExceptionModal, SkipCommitmentModal,
} from './SourcingModals.tsx';
import { Chip, ExceptionRow, PLAN_STATUS, StepItem } from './SourcingParts.tsx';
import SourcingTimeline from './SourcingTimeline.tsx';

type Dialog =
  | { kind: 'activate' }
  | { kind: 'complete'; commitment: SourcingCommitment; channel: string }
  | { kind: 'skip'; commitment: SourcingCommitment; channel: string }
  | { kind: 'resolve'; exception: SourcingException }
  | { kind: 'close'; channel: string }
  | { kind: 'reopen'; channel: SourcingPlanChannel }
  | { kind: 'editChannel'; channel: SourcingPlanChannel }
  | { kind: 'addChannel'; preset?: string }
  | { kind: 'editPlan' }
  | null;

/**
 * One role's sourcing plan: target, what needs attention (with recommended next steps), every channel with its weekly tracker, applications
 * by source and the full activity timeline. Lives on the Sourcing page (it used to be a Dashboard section, and before that a card on the role page). HR-tier acts;
 * the role's own Hiring Manager gets the read-only, partly redacted view the server sends.
 */
export default function SourcingPlanPanel({ roleId }: { roleId: string }) {
  const qc = useQueryClient();
  const { canHR } = useAuth();
  const { data, isLoading } = useSourcingPlan(roleId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [undoing, setUndoing] = useState<string | null>(null);

  const planStatus = data && data.enabled && data.plan ? data.plan.status : null;
  const readOnlyView = !!(data && data.enabled && data.read_only);
  const canAdvise = canHR && !readOnlyView && (planStatus === 'active' || planStatus === 'paused');
  const advice = useSourcingAdvice(roleId, canAdvise);

  if (isLoading) return <div className="card p-6 flex justify-center"><Spinner /></div>;
  if (!data || !data.enabled || !data.plan) return null;

  const view = data as SourcingPlanView;
  const plan = view.plan!;
  const channels = view.channels ?? [];
  const exceptions = (view.exceptions ?? []).filter(e => e.status !== 'resolved');
  const live = exceptions.filter(e => !e.is_shadow || canHR);
  const canEdit = canHR && !view.read_only && plan.status !== 'closed';
  const hr = canHR && !view.read_only;
  const today = ymd(0);
  const status = PLAN_STATUS[plan.status] ?? PLAN_STATUS.draft;
  const tracked = plan.status === 'active' || plan.status === 'paused';
  const vol = view.volume;
  const addable = SOURCING_CHANNELS.filter(c => { const have = channels.find(x => x.channel === c); return !have || have.state === 'excluded'; });

  const refresh = () => {
    setDialog(null);
    qc.invalidateQueries({ queryKey: ['sourcing-plan', roleId] });
    qc.invalidateQueries({ queryKey: ['sourcing-advice', roleId] });
    qc.invalidateQueries({ queryKey: ['sourcing-workspace'] });
    qc.invalidateQueries({ queryKey: ['dashboard-sourcing'] });
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

  // ── next steps ──
  const adviceResult = advice.data?.advice ?? null;
  const steps = adviceResult?.advice.steps ?? [];
  const planSteps = steps.filter(s => s.exception_id === null);
  const advicePending = canAdvise && advice.isLoading;
  const refreshing = advice.refresh.isPending;
  // The box appears only when it has something to say: steps/headline, "working it out", or a note that they could not be loaded while problems are open.
  const adviceFailed = canAdvise && !advicePending && !adviceResult && advice.isError;
  const showNext = hr && (advicePending || !!adviceResult || (adviceFailed && live.length > 0));

  return (
    <section aria-labelledby={`sourcing-panel-${roleId}`} className="card overflow-hidden" data-testid="sourcing-panel">
      <div className="px-5 py-3.5 border-b border-gray-100 flex flex-wrap items-center gap-3">
        <h3 id={`sourcing-panel-${roleId}`} className="text-base font-semibold text-gray-900 flex items-center gap-2">
          {view.role && <PriorityBadge priority={view.role.priority} />}
          <Link to={`/roles/${roleId}`} className="hover:text-dp-600">{view.role?.title ?? roleId}</Link>
        </h3>
        <Chip cls={status.cls}>{status.label}</Chip>
        {view.read_only && <Chip cls="bg-gray-50 text-gray-500 border-gray-200"><Eye className="w-3 h-3" aria-hidden="true" /> View only</Chip>}
        <div className="ml-auto flex items-center gap-3 text-xs text-gray-500">
          <span>Owner: <span className="font-medium text-gray-700">HR</span></span>
          {canEdit && tracked && <button type="button" className="text-xs text-dp-600 hover:underline" onClick={() => setDialog({ kind: 'editPlan' })}>Edit plan</button>}
          {canEdit && plan.status === 'draft' && <button type="button" className="btn-primary text-xs py-1.5 px-3" onClick={() => setDialog({ kind: 'activate' })}>Activate plan</button>}
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

        {hr && plan.strategy_note && (
          <p className="text-xs text-gray-500 whitespace-pre-line max-h-24 overflow-y-auto"><span className="text-gray-400">Strategy:</span> {plan.strategy_note}</p>
        )}

        {/* Target: qualified candidates in the last 7 days — this role's own target, or the default */}
        {vol && plan.status !== 'closed' && (
          vol.applicable ? (
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1" data-testid="volume">
              <div>
                <span className={`text-2xl font-mono font-bold ${vol.weekly_qualified >= vol.min ? 'text-green-700' : 'text-gray-900'}`}>{vol.weekly_qualified}</span>
                <span className="text-sm text-gray-400"> / {vol.min} qualified in the last 7 days</span>
                <InfoTooltip align="left" text={`Qualified means ${vol.rule === 'either' ? 'shortlisted by a person OR scored above 60 by ResumeIQ' : vol.rule === 'shortlisted' ? 'shortlisted by a person' : 'scored above 60 by ResumeIQ'}. Both parts are shown separately because a score above 60 is easy to reach. A candidate who is both is counted once, so the two parts can add up to more than the total. This is a rolling last 7 days. The target is ${vol.target_source === 'role' ? "this role's own" : `the default for a ${view.role?.priority ?? 'P0/P1'} role (${vol.default_target})`}; change it with “Edit plan”.`} />
              </div>
              <div className="text-xs text-gray-400">{vol.shortlisted} shortlisted · {vol.scored} scored above 60</div>
              <div className="text-xs text-gray-400" data-testid="target-source">{vol.target_source === 'role' ? 'Target set for this role' : 'Default target'}</div>
            </div>
          ) : tracked && (
            <p className="text-xs text-gray-500" data-testid="no-target">
              No qualified-candidate target is set for this role, so nothing is flagged for it.
              {canEdit && <> <button type="button" onClick={() => setDialog({ kind: 'editPlan' })} className="text-dp-600 hover:underline">Set a target</button></>}
            </p>
          )
        )}

        {/* Needs attention — each problem with the recommended next steps */}
        {(live.length > 0 || showNext) && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">{live.length > 0 ? 'Needs attention' : 'Next steps'}</h3>

            {showNext && (
              <div className="rounded-lg border border-dp-200 bg-dp-50/40 px-3.5 py-3 mb-2.5" data-testid="advice-box">
                <div className="flex items-start gap-2">
                  <Sparkles className="w-4 h-4 text-dp-600 mt-0.5 shrink-0" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    {advicePending && !adviceResult && <p className="text-xs text-gray-500">Working out what to do next from the pipeline, targets and channels…</p>}
                    {adviceResult && <p className="text-sm font-medium text-gray-900">{adviceResult.advice.headline}</p>}
                    {planSteps.length > 0 && <ol className="mt-2 space-y-2.5 list-decimal pl-4 marker:text-gray-300">{planSteps.map(s => <StepItem key={s.id} step={s} />)}</ol>}
                    {adviceResult && adviceResult.advice.watch.length > 0 && (
                      <p className="mt-2 text-xs text-gray-500"><span className="text-gray-400">Keep an eye on:</span> {adviceResult.advice.watch.join(' · ')}</p>
                    )}
                    {adviceResult && (
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-400">
                        <span>{adviceResult.source === 'ai' ? 'Written by AI from this role’s pipeline, targets and channels' : 'Rule-based steps (the AI writer is unavailable right now)'} · {formatDistanceToNow(new Date(adviceResult.generated_at), { addSuffix: true })}</span>
                        {adviceResult.stale && <span className="text-amber-600">The numbers have changed since — refreshing soon</span>}
                        <button type="button" onClick={() => advice.refresh.mutate(undefined, { onError: () => toast.error('Could not refresh the next steps') })} disabled={refreshing}
                          className="inline-flex items-center gap-1 text-dp-600 hover:underline disabled:opacity-50" aria-label="Refresh the next steps">
                          <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />{refreshing ? 'Refreshing…' : 'Refresh'}
                        </button>
                      </div>
                    )}
                    {adviceFailed && <p className="text-xs text-gray-400">The detailed next steps could not be loaded; each problem still shows its next action.</p>}
                  </div>
                </div>
              </div>
            )}

            {live.length > 0 && (
              <ul className="space-y-2">
                {live.map(e => (
                  <ExceptionRow key={e.id} e={e} canEdit={canEdit} steps={steps.filter(s => s.exception_id === e.id)} advicePending={advicePending}
                    onResolve={() => setDialog({ kind: 'resolve', exception: e })} />
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Channels */}
        <div>
          {canEdit && tracked && (
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Channels</h3>
              {addable.length > 0 && <button type="button" className="btn-secondary text-xs py-1 px-2.5" onClick={() => setDialog({ kind: 'addChannel' })}>Add channel</button>}
            </div>
          )}
          {channels.length > 0 ? (
            <div className="divide-y divide-gray-100">
              {channels.map(ch => (
                <SourcingChannelBlock key={ch.id} ch={ch} hr={hr} canEdit={canEdit} canManage={canEdit && tracked} planActive={plan.status === 'active'} today={today} undoingId={undoing}
                  onComplete={c => setDialog({ kind: 'complete', commitment: c, channel: ch.channel })}
                  onSkip={c => setDialog({ kind: 'skip', commitment: c, channel: ch.channel })}
                  onUndo={undoSkip}
                  onClose={() => setDialog({ kind: 'close', channel: ch.channel })}
                  onReopen={() => setDialog({ kind: 'reopen', channel: ch })}
                  onBringBack={() => setDialog({ kind: 'addChannel', preset: ch.channel })}
                  onEdit={() => {
                    // A live channel with no weekly target that still has its first task open (the task is handed back to channels that went live
                    // before the tracker existed): logging that task asks for the link and the target in one go and starts the tracker.
                    const first = ch.commitments.find(c => c.kind === 'activate_channel' && c.status === 'open');
                    setDialog(ch.tracker.target === null && first ? { kind: 'complete', commitment: first, channel: ch.channel } : { kind: 'editChannel', channel: ch });
                  }} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400">No channels chosen yet — pick them when you activate the plan.</p>
          )}
        </div>

        {/* Output by source — what applicants answered in "How did you hear about this opening?" on the form, so it is "claimed" attribution */}
        {(view.output?.length ?? 0) > 0 && plan.status !== 'draft' && hr && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5 flex items-center gap-1">
              Applications by source
              <InfoTooltip align="left" text="From the “How did you hear about this opening?” answer on the application form (HR Outreach counts as Direct Outreach, Hiring Agency as Agency, Employee Referral as Internal Referral), so it is what applicants chose, not a measurement. Applications with no answer show as Not tagged. A source with fewer than 5 applications is too small to judge." />
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

        {hr && (view.changes?.length ?? 0) > 0 && <SourcingTimeline changes={view.changes!} total={view.changes_total ?? view.changes!.length} />}
      </div>

      {dialog?.kind === 'activate' && <ActivatePlanModal plan={plan} channels={channels} defaultTarget={vol?.default_target ?? null} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === 'complete' && <CompleteCommitmentModal commitment={dialog.commitment} channel={dialog.channel} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === 'skip' && <SkipCommitmentModal commitment={dialog.commitment} channel={dialog.channel} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === 'resolve' && <ResolveExceptionModal exception={dialog.exception} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === 'close' && <CloseChannelModal planId={plan.id} channel={dialog.channel} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === 'reopen' && <ReopenChannelModal planId={plan.id} channel={dialog.channel.channel} target={dialog.channel.tracker.target} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === 'editChannel' && <EditChannelModal planId={plan.id} channel={dialog.channel.channel} target={dialog.channel.tracker.target} link={dialog.channel.tracker.link} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === 'addChannel' && <AddChannelModal planId={plan.id} planStatus={plan.status} channels={channels} preset={dialog.preset} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === 'editPlan' && <EditPlanModal plan={plan} defaultTarget={vol?.default_target ?? null} onClose={() => setDialog(null)} onDone={refresh} />}
    </section>
  );
}
