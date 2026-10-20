import { cloneElement, ReactElement, ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import { sourcingApi } from '../../services/api.ts';
import { Spinner } from '../shared/Badges.tsx';
import { useAuth } from '../../contexts/AuthContext.tsx';
import {
  ActivationChannelInput, ResolutionPath, SOURCING_CHANNELS, SourcingPerson, SourcingPlan, SourcingPlanChannel,
} from '../../types/sourcing.ts';
import { channelBlurb, isPortal, plural, ymd } from '../../utils/sourcingFormat.ts';

export const apiError = (err: unknown, fallback: string): string =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

// ─── Shell: overlay, Escape to close, focus lands in the dialog, scrolling body ─────────────────────
function ModalShell({ title, subtitle, onClose, footer, children, wide }: {
  title: string; subtitle?: string; onClose: () => void; footer: ReactNode; children: ReactNode; wide?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  // Focus moves into the dialog ONCE, when it opens. `onClose` is usually an inline arrow, so depending on it re-ran this effect on
  // every re-render of the card (a background refetch while someone was typing) and pulled focus out of the field they were in.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className={`bg-white rounded-xl shadow-xl w-full ${wide ? 'max-w-2xl' : 'max-w-md'} flex flex-col max-h-[90vh] outline-none`}>
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <div>
            <h3 id={titleId} className="text-sm font-semibold text-gray-900">{title}</h3>
            {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close"><X className="w-4 h-4 text-gray-400" /></button>
        </div>
        <div className="px-5 py-4 space-y-4 overflow-y-auto">{children}</div>
        <div className="flex gap-3 justify-end px-5 py-4 border-t border-gray-100 shrink-0">{footer}</div>
      </div>
    </div>
  );
}

// The hint is linked with aria-describedby (not folded into the <label>), so the control's accessible NAME is just its label.
function Field({ label, optional, hint, children }: { label: string; optional?: boolean; hint?: string; children: ReactElement }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-gray-600 mb-1.5">{label}{optional && <span className="text-gray-400 font-normal"> (optional)</span>}</label>
      {cloneElement(children, { id, ...(hint ? { 'aria-describedby': hintId } : {}) })}
      {hint && <span id={hintId} className="block text-xs text-gray-400 mt-1">{hint}</span>}
    </div>
  );
}

// Who can be named as the owner of a BLOCKER. A plan itself has no individual owner: sourcing belongs to the HR/Admin persona as a whole.
function usePeople() {
  return useQuery<{ data: { people: SourcingPerson[] } }>({
    queryKey: ['sourcing-people'], queryFn: () => sourcingApi.people(), staleTime: 5 * 60 * 1000,
  });
}

// ═══ Activate plan ═══════════════════════════════════════════════════════════════════════════════════
// "Activation" is the commitment moment: the channels in and out and — for channels that were already running before HMS
// tracked them — a one-click attestation so the backlog does not arrive as an instant overdue pile. There is no owner to pick:
// sourcing belongs to the HR/Admin persona as a whole.
interface Row { included: boolean; reason: string; running: boolean; url: string; postedAt: string; target: string }
const emptyRow = (): Row => ({ included: false, reason: '', running: false, url: '', postedAt: '', target: '' });

export function ActivatePlanModal({ plan, channels, onClose, onDone }: {
  plan: SourcingPlan; channels: SourcingPlanChannel[]; onClose: () => void; onDone: () => void;
}) {
  const seeded = new Set(channels.map(c => c.channel));

  const [rows, setRows] = useState<Record<string, Row>>(() => {
    const init: Record<string, Row> = {};
    for (const ch of SOURCING_CHANNELS) {
      const existing = channels.find(c => c.channel === ch);
      init[ch] = { ...emptyRow(), included: !!existing && existing.state !== 'excluded', reason: existing?.excluded_reason ?? '' };
    }
    return init;
  });
  const [note, setNote] = useState(plan.strategy_note ?? '');
  const [saving, setSaving] = useState(false);

  const set = (ch: string, patch: Partial<Row>) => setRows(r => ({ ...r, [ch]: { ...r[ch], ...patch } }));
  const included = SOURCING_CHANNELS.filter(c => rows[c].included);
  const droppedSeeded = SOURCING_CHANNELS.filter(c => seeded.has(c) && !rows[c].included);
  const missingReason = droppedSeeded.filter(c => rows[c].reason.trim().length < 3);
  const problem = included.length === 0 ? 'Keep at least one channel in the plan.'
    : missingReason.length ? `Say why ${missingReason.join(', ')} ${missingReason.length === 1 ? 'is' : 'are'} not being used.` : '';

  const submit = async () => {
    if (problem) return;
    const payload: ActivationChannelInput[] = [
      ...included.map(ch => {
        const r = rows[ch];
        const target = Number(r.target);
        return {
          channel: ch, already_running: r.running,
          ...(r.running && r.postedAt ? { posted_at: r.postedAt } : {}),
          ...(r.running && r.url.trim() ? { url: r.url.trim() } : {}),
          ...(ch === 'Direct Outreach' && target > 0 ? { weekly_target: target } : {}),
        } as ActivationChannelInput;
      }),
      ...droppedSeeded.map(ch => ({ channel: ch, exclude_reason: rows[ch].reason.trim() })),
    ];
    setSaving(true);
    try {
      await sourcingApi.activate(plan.id, { strategy_note: note.trim() || null, channels: payload });
      toast.success('Sourcing plan activated');
      onDone();
    } catch (err) { toast.error(apiError(err, 'Could not activate the plan')); }
    setSaving(false);
  };

  return (
    <ModalShell wide title="Activate sourcing plan" subtitle="This is the commitment: the channels you pick start their clocks today."
      onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button type="button" onClick={submit} disabled={saving || !!problem} className="btn-primary text-sm" title={problem || undefined}>
          {saving ? <Spinner size="sm" /> : 'Activate plan'}
        </button>
      </>}>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-gray-600 mb-1.5">Channels</legend>
        {SOURCING_CHANNELS.map(ch => {
          const r = rows[ch];
          return (
            <div key={ch} className={`rounded-lg border px-3 py-2.5 ${r.included ? 'border-dp-200 bg-dp-50/40' : 'border-gray-200'}`}>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" className="mt-0.5" checked={r.included} onChange={e => set(ch, { included: e.target.checked })} />
                <span className="flex-1">
                  <span className="text-sm font-medium text-gray-900">{ch}</span>
                  <span className="block text-xs text-gray-400">{channelBlurb(ch)}</span>
                </span>
              </label>

              {r.included && (
                <div className="mt-2.5 ml-6 space-y-2">
                  <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                    <input type="checkbox" checked={r.running} onChange={e => set(ch, { running: e.target.checked })} />
                    Already running before today
                  </label>
                  <p className="text-[11px] text-gray-400 ml-6 -mt-1">Recorded as done so it does not show as overdue; the next reminder counts from the posting date you enter (or from today).</p>
                  {r.running && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {isPortal(ch) && (
                        <>
                          <input className="input text-xs" type="date" aria-label={`${ch} posting date`} max={ymd(0)} value={r.postedAt} onChange={e => set(ch, { postedAt: e.target.value })} />
                          <input className="input text-xs" type="url" placeholder="Posting link (optional)" aria-label={`${ch} posting link`} value={r.url} onChange={e => set(ch, { url: e.target.value })} />
                        </>
                      )}
                      {!isPortal(ch) && <p className="text-xs text-gray-400 sm:col-span-2">Recorded as done; the follow-up clock starts today.</p>}
                    </div>
                  )}
                  {ch === 'Direct Outreach' && (
                    <input className="input text-xs w-48" type="number" min={1} placeholder="Weekly contact target (optional)" aria-label="Weekly unique-contact target" value={r.target} onChange={e => set(ch, { target: e.target.value })} />
                  )}
                </div>
              )}

              {!r.included && seeded.has(ch) && (
                <div className="mt-2.5 ml-6">
                  <input className="input text-xs" placeholder={`Why isn't ${ch} being used for this role? (required)`} aria-label={`Reason for not using ${ch}`} value={r.reason} onChange={e => set(ch, { reason: e.target.value })} />
                </div>
              )}
            </div>
          );
        })}
      </fieldset>

      <Field label="Strategy note" optional hint="Anything leadership should know about how you'll source this role. The Hiring Manager does not see it.">
        <textarea className="input text-sm h-20 resize-none" value={note} onChange={e => setNote(e.target.value)} />
      </Field>
      {problem && <p role="status" className="text-xs text-amber-700">{problem}</p>}
    </ModalShell>
  );
}

// ═══ Mark a commitment done ═════════════════════════════════════════════════════════════════════════
export function CompleteCommitmentModal({ commitment, channel, onClose, onDone }: {
  commitment: { id: string; kind: string; title: string }; channel: string; onClose: () => void; onDone: () => void;
}) {
  const portalActivation = isPortal(channel) && (commitment.kind === 'activate_channel' || commitment.kind === 'renew_posting');
  const outreachTarget = channel === 'Direct Outreach' && (commitment.kind === 'activate_channel' || commitment.kind === 'weekly_outbound');
  const [url, setUrl] = useState('');
  const [postedAt, setPostedAt] = useState(portalActivation ? ymd(0) : '');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const t = Number(target);
      await sourcingApi.completeCommitment(commitment.id, {
        attest: true, url: url.trim() || null, note: note.trim() || null,
        ...(portalActivation && postedAt ? { posted_at: postedAt } : {}),
        ...(outreachTarget && t > 0 ? { weekly_target: t } : {}),
      });
      toast.success('Marked done');
      onDone();
    } catch (err) { toast.error(apiError(err, 'Could not mark it done')); }
    setSaving(false);
  };

  return (
    <ModalShell title="Mark done" subtitle={`${channel} · ${commitment.title}`} onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button type="button" onClick={submit} disabled={saving} className="btn-primary text-sm">{saving ? <Spinner size="sm" /> : 'Mark done'}</button>
      </>}>
      <p className="text-xs text-gray-500">Confirming that this is done. Evidence is optional — add a link or a line if it helps whoever reviews the plan.</p>
      {portalActivation && (
        <Field label="Posted on" hint="The posting's own date — the renewal reminder counts from here.">
          <input type="date" className="input text-sm" max={ymd(0)} value={postedAt} onChange={e => setPostedAt(e.target.value)} />
        </Field>
      )}
      <Field label="Link" optional><input type="url" className="input text-sm" placeholder="https://…" value={url} onChange={e => setUrl(e.target.value)} /></Field>
      {outreachTarget && (
        <Field label="Weekly unique-contact target" optional hint="You set this. Until 4 weeks of data exist it is only recorded, never flagged.">
          <input type="number" min={1} className="input text-sm w-40" value={target} onChange={e => setTarget(e.target.value)} />
        </Field>
      )}
      <Field label="Note" optional><textarea className="input text-sm h-16 resize-none" value={note} onChange={e => setNote(e.target.value)} /></Field>
    </ModalShell>
  );
}

// ═══ Skip a commitment ══════════════════════════════════════════════════════════════════════════════
export function SkipCommitmentModal({ commitment, channel, onClose, onDone }: {
  commitment: { id: string; title: string }; channel: string; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const ok = reason.trim().length >= 3;
  const submit = async () => {
    if (!ok) return;
    setSaving(true);
    try { await sourcingApi.skipCommitment(commitment.id, reason.trim()); toast.success('Skipped — the reason is in the plan history'); onDone(); }
    catch (err) { toast.error(apiError(err, 'Could not skip it')); }
    setSaving(false);
  };
  return (
    <ModalShell title="Skip this commitment" subtitle={`${channel} · ${commitment.title}`} onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button type="button" onClick={submit} disabled={saving || !ok} className="btn-primary text-sm">{saving ? <Spinner size="sm" /> : 'Skip'}</button>
      </>}>
      <Field label="Why is it being skipped?" hint="Skipping stops it being chased. The reason stays in the plan's history.">
        <textarea className="input text-sm h-20 resize-none" value={reason} onChange={e => setReason(e.target.value)} />
      </Field>
    </ModalShell>
  );
}

// ═══ Resolve an exception — the three paths ═════════════════════════════════════════════════════════
const PATHS: Array<{ id: ResolutionPath; title: string; body: string }> = [
  { id: 'catch_up',        title: "I'll catch up",     body: 'Pause the alert until a date within 14 days. It comes back if it is still true then.' },
  { id: 'change_strategy', title: 'Change the plan',   body: 'The commitment was wrong for this role. This closes the alert and records why.' },
  { id: 'blocker',         title: "I'm blocked",       body: 'Something outside sourcing is in the way. Name who owns it and by when.' },
];

export function ResolveExceptionModal({ exception, onClose, onDone }: {
  exception: { id: string; channel: string; committed: string; happened: string }; onClose: () => void; onDone: () => void;
}) {
  const { user } = useAuth();
  const { data: peopleData } = usePeople();
  const people = peopleData?.data?.people ?? [];
  const [path, setPath] = useState<ResolutionPath>('catch_up');
  const [reason, setReason] = useState('');
  const [action, setAction] = useState('');
  const [snoozeUntil, setSnoozeUntil] = useState(ymd(2));
  const [blockerDue, setBlockerDue] = useState(ymd(7));
  const [blockerOwner, setBlockerOwner] = useState(user?.id ?? '');
  const [dropChannel, setDropChannel] = useState(false);
  const [saving, setSaving] = useState(false);

  const dateProblem = path === 'catch_up'
    ? (!snoozeUntil || snoozeUntil <= ymd(0) || snoozeUntil > ymd(14) ? 'Pick a date within the next 14 days.' : '')
    : path === 'blocker'
    ? (!blockerDue || blockerDue < ymd(0) || blockerDue > ymd(60) ? 'A blocker needs a deadline within the next 60 days.' : '')
    : '';
  const problem = reason.trim().length < 3 ? 'Add a short reason.' : dateProblem;

  const submit = async () => {
    if (problem) return;
    setSaving(true);
    try {
      await sourcingApi.resolveException(exception.id, {
        path, reason: reason.trim(), corrective_action: action.trim() || null,
        ...(path === 'catch_up' ? { snooze_until: snoozeUntil } : {}),
        ...(path === 'blocker' ? { blocker_due: blockerDue, blocker_owner_user_id: blockerOwner || undefined } : {}),
        ...(path === 'change_strategy' && dropChannel ? { exclude_channel: true } : {}),
      });
      toast.success(path === 'catch_up' ? 'Snoozed until your catch-up date' : path === 'blocker' ? 'Recorded as a blocker' : 'Plan changed and logged');
      onDone();
    } catch (err) { toast.error(apiError(err, 'Could not resolve it')); }
    setSaving(false);
  };

  return (
    <ModalShell wide title="Resolve this exception" subtitle={`${exception.committed} — ${exception.happened}`} onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button type="button" onClick={submit} disabled={saving || !!problem} className="btn-primary text-sm" title={problem || undefined}>{saving ? <Spinner size="sm" /> : 'Save'}</button>
      </>}>
      <div role="radiogroup" aria-label="Resolution" className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {PATHS.map(p => (
          <button key={p.id} type="button" role="radio" aria-checked={path === p.id} onClick={() => setPath(p.id)}
            className={`text-left rounded-lg border-2 px-3 py-2.5 transition-colors ${path === p.id ? 'border-dp-500 bg-dp-50/50' : 'border-gray-200 hover:border-gray-300'}`}>
            <div className="text-sm font-medium text-gray-900">{p.title}</div>
            <div className="text-xs text-gray-400 mt-0.5">{p.body}</div>
          </button>
        ))}
      </div>

      {path === 'catch_up' && (
        <Field label="Catch up by" hint="Within 14 days. If it is still true on that date the alert reopens.">
          <input type="date" className="input text-sm w-44" min={ymd(1)} max={ymd(14)} value={snoozeUntil} onChange={e => setSnoozeUntil(e.target.value)} />
        </Field>
      )}
      {path === 'blocker' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Owner of the blocker">
            <select className="input text-sm" value={blockerOwner} onChange={e => setBlockerOwner(e.target.value)}>
              {people.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </Field>
          <Field label="Resolve by" hint="Within 60 days.">
            <input type="date" className="input text-sm" min={ymd(0)} max={ymd(60)} value={blockerDue} onChange={e => setBlockerDue(e.target.value)} />
          </Field>
        </div>
      )}
      {path === 'change_strategy' && exception.channel !== '*' && (
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input type="checkbox" checked={dropChannel} onChange={e => setDropChannel(e.target.checked)} />
          Stop using {exception.channel} for this role
        </label>
      )}

      <Field label="Reason" hint={path === 'change_strategy' ? 'What changed, so the Hiring Manager can see why.' : undefined}>
        <textarea className="input text-sm h-16 resize-none" value={reason} onChange={e => setReason(e.target.value)} />
      </Field>
      <Field label="What will you do about it?" optional>
        <textarea className="input text-sm h-14 resize-none" value={action} onChange={e => setAction(e.target.value)} />
      </Field>
      {problem && reason.trim().length >= 3 && <p role="status" className="text-xs text-amber-700">{problem}</p>}
      {path === 'catch_up' && <p className="text-xs text-gray-400">Catching up in {plural(Math.max(0, Math.round((Date.parse(snoozeUntil) - Date.parse(ymd(0))) / 86400000)), 'day')}.</p>}
    </ModalShell>
  );
}

// ═══ Exclude a channel (or take it back) ═══════════════════════════════════════════════════════════
export function ExcludeChannelModal({ planId, channel, onClose, onDone }: {
  planId: string; channel: string; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const ok = reason.trim().length >= 3;
  const submit = async () => {
    if (!ok) return;
    setSaving(true);
    try {
      await sourcingApi.setChannel(planId, { channel, state: 'excluded', excluded_reason: reason.trim() });
      toast.success(`${channel} left out of the plan`);
      onDone();
    } catch (err) { toast.error(apiError(err, 'Could not update the channel')); }
    setSaving(false);
  };
  return (
    <ModalShell title={`Stop using ${channel}`} subtitle="Its open commitments are cancelled and nothing more is chased for it." onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button type="button" onClick={submit} disabled={saving || !ok} className="btn-primary text-sm">{saving ? <Spinner size="sm" /> : 'Leave it out'}</button>
      </>}>
      <Field label="Why?" hint="Recorded in the plan's history.">
        <textarea className="input text-sm h-20 resize-none" value={reason} onChange={e => setReason(e.target.value)} />
      </Field>
    </ModalShell>
  );
}

// ═══ Add a channel to a running plan (or bring one back) ═══════════════════════════════════════════
// Only offered once the plan is activated — before that, channels are chosen in the activation dialog. Adding one starts its
// first commitment from today, exactly like an activated channel; "bring back" restarts a channel that had been left out.
export function AddChannelModal({ planId, planStatus, channels, preset, onClose, onDone }: {
  planId: string; planStatus: string; channels: SourcingPlanChannel[]; preset?: string; onClose: () => void; onDone: () => void;
}) {
  const options = preset
    ? [preset]
    : SOURCING_CHANNELS.filter(c => { const have = channels.find(x => x.channel === c); return !have || have.state === 'excluded'; });
  const [choice, setChoice] = useState<string>(preset ?? '');
  const [saving, setSaving] = useState(false);
  const earlier = (ch: string) => channels.find(x => x.channel === ch && x.state === 'excluded')?.excluded_reason ?? null;

  const submit = async () => {
    if (!choice) return;
    setSaving(true);
    try {
      await sourcingApi.setChannel(planId, { channel: choice, state: 'planned' });
      toast.success(`${choice} added to the plan`);
      onDone();
    } catch (err) {
      toast.error(apiError(err, 'Could not add the channel'));
      // A 409 means the plan is not what this dialog was showing (another tab added the channel, the role closed): re-read it.
      if ((err as { response?: { status?: number } })?.response?.status === 409) onDone();
    }
    setSaving(false);
  };

  return (
    <ModalShell title={preset ? `Bring back ${preset}` : 'Add a channel'}
      subtitle={planStatus === 'paused' ? 'The role is on hold, so its clock starts when the role is back on.' : 'Tracking starts today: its first task falls due in 1–2 working days.'}
      onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button type="button" onClick={submit} disabled={saving || !choice} className="btn-primary text-sm">{saving ? <Spinner size="sm" /> : preset ? 'Bring it back' : 'Add channel'}</button>
      </>}>
      {options.length === 0 && <p className="text-sm text-gray-500">Every channel is already in this plan.</p>}
      <div role="radiogroup" aria-label="Channel" className="space-y-2">
        {options.map(ch => (
          <button key={ch} type="button" role="radio" aria-checked={choice === ch} onClick={() => setChoice(ch)}
            className={`w-full text-left rounded-lg border-2 px-3 py-2.5 transition-colors ${choice === ch ? 'border-dp-500 bg-dp-50/50' : 'border-gray-200 hover:border-gray-300'}`}>
            <div className="text-sm font-medium text-gray-900">{ch}</div>
            <div className="text-xs text-gray-400 mt-0.5">{channelBlurb(ch)}</div>
            {earlier(ch) && <div className="text-xs text-gray-400 mt-0.5">Left out earlier: {earlier(ch)}</div>}
          </button>
        ))}
      </div>
    </ModalShell>
  );
}

// ═══ Edit the strategy note of a plan ══════════════════════════════════════════════════════════════
// A plan has no individual owner — sourcing belongs to the HR/Admin persona as a whole — so the note is all there is to edit.
export function EditPlanModal({ plan, onClose, onDone }: { plan: SourcingPlan; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState(plan.strategy_note ?? '');
  const [saving, setSaving] = useState(false);
  const changed = note.trim() !== (plan.strategy_note ?? '').trim();

  const submit = async () => {
    if (!changed) return;
    setSaving(true);
    try {
      await sourcingApi.updatePlan(plan.id, { strategy_note: note.trim() || null });
      toast.success('Strategy note updated');
      onDone();
    } catch (err) { toast.error(apiError(err, 'Could not update the strategy note')); }
    setSaving(false);
  };

  return (
    <ModalShell title="Edit strategy note" subtitle="The change is written to the plan's history."
      onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button type="button" onClick={submit} disabled={saving || !changed} className="btn-primary text-sm">{saving ? <Spinner size="sm" /> : 'Save'}</button>
      </>}>
      <Field label="Strategy note" optional hint="Anything leadership should know about how you'll source this role. The Hiring Manager does not see it.">
        <textarea className="input text-sm h-28 resize-none" maxLength={2000} value={note} onChange={e => setNote(e.target.value)} />
      </Field>
    </ModalShell>
  );
}
