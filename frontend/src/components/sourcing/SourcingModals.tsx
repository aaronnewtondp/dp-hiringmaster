import { cloneElement, ReactElement, ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import { sourcingApi } from '../../services/api.ts';
import { Spinner } from '../shared/Badges.tsx';
import { useAuth } from '../../contexts/AuthContext.tsx';
import {
  ActivationChannelInput, MAX_WEEKLY_TARGET, ResolutionPath, SOURCING_CHANNELS, SourcingPerson, SourcingPlan, SourcingPlanChannel,
} from '../../types/sourcing.ts';
import { channelBlurb, isPortal, isTracked, plural, shortDate, ymd } from '../../utils/sourcingFormat.ts';

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

const isUrl = (v: string): boolean => { try { const u = new URL(v.trim()); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } };
const wholeTarget = (v: string): number | null => { const n = Number(v); return v.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= MAX_WEEKLY_TARGET ? n : null; };

export function ActivatePlanModal({ plan, channels, defaultTarget, onClose, onDone }: {
  plan: SourcingPlan; channels: SourcingPlanChannel[]; /** the default qualified target for this role (5 for P0/P1, none for P2/P3) */ defaultTarget?: number | null;
  onClose: () => void; onDone: () => void;
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
  const [qualified, setQualified] = useState(plan.weekly_qualified_target ? String(plan.weekly_qualified_target) : '');
  const [saving, setSaving] = useState(false);

  const set = (ch: string, patch: Partial<Row>) => setRows(r => ({ ...r, [ch]: { ...r[ch], ...patch } }));
  const included = SOURCING_CHANNELS.filter(c => rows[c].included);
  const droppedSeeded = SOURCING_CHANNELS.filter(c => seeded.has(c) && !rows[c].included);
  const missingReason = droppedSeeded.filter(c => rows[c].reason.trim().length < 3);
  // A channel that is already running is logged right now, so it needs what logging needs: the post's link and the weekly sourcing target.
  const incompleteRunning = included.filter(c => isTracked(c) && rows[c].running && (!isUrl(rows[c].url) || wholeTarget(rows[c].target) === null));
  const qualifiedBad = qualified.trim() !== '' && (!Number.isInteger(Number(qualified)) || Number(qualified) < 1 || Number(qualified) > 500);
  const problem = included.length === 0 ? 'Keep at least one channel in the plan.'
    : missingReason.length ? `Say why ${missingReason.join(', ')} ${missingReason.length === 1 ? 'is' : 'are'} not being used.`
    : incompleteRunning.length ? `${incompleteRunning.join(', ')}: add the post link and a whole-number weekly sourcing target for what is already running.`
    : qualifiedBad ? 'The weekly qualified target is a whole number from 1 to 500 (or leave it blank).' : '';

  const submit = async () => {
    if (problem) return;
    const payload: ActivationChannelInput[] = [
      ...included.map(ch => {
        const r = rows[ch];
        return {
          channel: ch, already_running: r.running,
          ...(r.running && r.postedAt ? { posted_at: r.postedAt } : {}),
          ...(r.running && r.url.trim() ? { url: r.url.trim() } : {}),
          ...(r.running && isTracked(ch) && wholeTarget(r.target) !== null ? { weekly_target: wholeTarget(r.target)! } : {}),
        } as ActivationChannelInput;
      }),
      ...droppedSeeded.map(ch => ({ channel: ch, exclude_reason: rows[ch].reason.trim() })),
    ];
    setSaving(true);
    try {
      await sourcingApi.activate(plan.id, {
        strategy_note: note.trim() || null, channels: payload,
        ...(qualified.trim() !== '' ? { weekly_qualified_target: Number(qualified) } : {}),
      });
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
                  <p className="text-[11px] text-gray-400 ml-6 -mt-1">Recorded as done so it does not show as overdue; the next reminder counts from today{isPortal(ch) ? ' (or the posting date you enter)' : ''}.</p>
                  {r.running && isTracked(ch) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input className="input text-xs sm:col-span-2" type="url" placeholder={ch === 'Direct Outreach' ? 'Link to the outreach campaign or list (required)' : 'Link to the job post (required)'} aria-label={`${ch} post link`} value={r.url} onChange={e => set(ch, { url: e.target.value })} />
                      <input className="input text-xs" type="number" min={1} max={MAX_WEEKLY_TARGET} step={1} placeholder="Weekly sourcing target (required)" aria-label={`${ch} weekly sourcing target`} value={r.target} onChange={e => set(ch, { target: e.target.value })} />
                      {isPortal(ch) && <input className="input text-xs" type="date" aria-label={`${ch} posting date`} max={ymd(0)} value={r.postedAt} onChange={e => set(ch, { postedAt: e.target.value })} />}
                      <p className="text-[11px] text-gray-400 sm:col-span-2">The weekly target is the number of applicants (qualified and unqualified) you want this channel to bring in each week. HMS counts them from the “How did you hear about this opening?” answer on the application form and shows each finished week as met or missed.</p>
                    </div>
                  )}
                  {r.running && !isTracked(ch) && <p className="text-xs text-gray-400">Recorded as done; the follow-up clock starts today.</p>}
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

      <Field label="Weekly qualified target for this role" optional
        hint={defaultTarget ? `Qualified candidates wanted in any 7 days. Leave it blank to use the default of ${defaultTarget}.` : 'Qualified candidates wanted in any 7 days. Without one, nothing is flagged for this role.'}>
        <input type="number" min={1} max={500} step={1} className="input text-sm w-32" value={qualified} onChange={e => setQualified(e.target.value)} />
      </Field>
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
  // The first task of LinkedIn / Naukri/IIMjobs / Direct Outreach logs the post: its link and the weekly sourcing target are required, because the
  // target is what the automatic weekly tracker measures from then on.
  const logsPost = isTracked(channel) && commitment.kind === 'activate_channel';
  const portalPosting = isPortal(channel) && (commitment.kind === 'activate_channel' || commitment.kind === 'renew_posting');
  const [url, setUrl] = useState('');
  const [postedAt, setPostedAt] = useState(portalPosting ? ymd(0) : '');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const t = wholeTarget(target);
  const problem = logsPost ? (!isUrl(url) ? 'Add the link to the post.' : t === null ? 'Add a whole-number weekly sourcing target.' : '') : '';

  const submit = async () => {
    if (problem) return;
    setSaving(true);
    try {
      await sourcingApi.completeCommitment(commitment.id, {
        attest: true, url: url.trim() || null, note: note.trim() || null,
        ...(portalPosting && postedAt ? { posted_at: postedAt } : {}),
        ...(logsPost && t !== null ? { weekly_target: t } : {}),
      });
      toast.success(logsPost ? 'Post logged — weekly tracking is set up' : 'Marked done');
      onDone();
    } catch (err) { toast.error(apiError(err, 'Could not mark it done')); }
    setSaving(false);
  };

  return (
    <ModalShell title={logsPost ? `Log the ${channel} post` : 'Mark done'} subtitle={`${channel} · ${commitment.title}`} onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button type="button" onClick={submit} disabled={saving || !!problem} title={problem || undefined} className="btn-primary text-sm">{saving ? <Spinner size="sm" /> : logsPost ? 'Log post' : 'Mark done'}</button>
      </>}>
      {logsPost
        ? <p className="text-xs text-gray-500">From today HMS counts the applications whose “How did you hear about this opening?” answer means {channel} and, at the end of each 7-day week, shows whether the weekly target was met (green) or missed (red).</p>
        : <p className="text-xs text-gray-500">Confirming that this is done. Evidence is optional — add a link or a line if it helps whoever reviews the plan.</p>}
      {portalPosting && (
        <Field label="Posted on" hint="The posting's own date — the renewal reminder counts from here.">
          <input type="date" className="input text-sm" max={ymd(0)} value={postedAt} onChange={e => setPostedAt(e.target.value)} />
        </Field>
      )}
      <Field label={logsPost ? (channel === 'Direct Outreach' ? 'Link to the outreach campaign or list' : 'Link to the job post') : 'Link'} optional={!logsPost}>
        <input type="url" className="input text-sm" placeholder="https://…" value={url} onChange={e => setUrl(e.target.value)} />
      </Field>
      {logsPost && (
        <Field label="Weekly sourcing target" hint="Applicants per week from this channel — qualified and unqualified together. You can change it later.">
          <input type="number" min={1} max={MAX_WEEKLY_TARGET} step={1} className="input text-sm w-40" value={target} onChange={e => setTarget(e.target.value)} />
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
          Close {exception.channel} for this role
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

// ═══ Close a channel, reopen it, edit its target and link ═══════════════════════════════════════════
// Closing keeps everything the channel produced (the post link, the weekly target and every tracked week) as a summary on the plan, and the
// channel can be reopened. It replaces "Stop using", which threw that history away.
export function CloseChannelModal({ planId, channel, onClose, onDone }: {
  planId: string; channel: string; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const ok = reason.trim().length >= 3;
  const submit = async () => {
    if (!ok) return;
    setSaving(true);
    try {
      await sourcingApi.closeChannel(planId, channel, reason.trim());
      toast.success(`${channel} closed — its summary stays on the plan`);
      onDone();
    } catch (err) {
      toast.error(apiError(err, 'Could not close the channel'));
      if ((err as { response?: { status?: number } })?.response?.status === 409) onDone();
    }
    setSaving(false);
  };
  return (
    <ModalShell title={`Close ${channel}`} subtitle="Its open tasks stop and nothing more is chased. The post link, targets and weekly results stay on the plan, and you can reopen it any time." onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button type="button" onClick={submit} disabled={saving || !ok} className="btn-primary text-sm">{saving ? <Spinner size="sm" /> : 'Close channel'}</button>
      </>}>
      <Field label="Why is it being closed?" hint="Recorded in the plan's history.">
        <textarea className="input text-sm h-20 resize-none" value={reason} onChange={e => setReason(e.target.value)} />
      </Field>
    </ModalShell>
  );
}

export function ReopenChannelModal({ planId, channel, target, onClose, onDone }: {
  planId: string; channel: string; target: number | null; onClose: () => void; onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try { await sourcingApi.reopenChannel(planId, channel); toast.success(`${channel} reopened`); onDone(); }
    catch (err) {
      toast.error(apiError(err, 'Could not reopen the channel'));
      if ((err as { response?: { status?: number } })?.response?.status === 409) onDone();
    }
    setSaving(false);
  };
  return (
    <ModalShell title={`Reopen ${channel}`} subtitle="Carry on using it." onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button type="button" onClick={submit} disabled={saving} className="btn-primary text-sm">{saving ? <Spinner size="sm" /> : 'Reopen channel'}</button>
      </>}>
      <p className="text-sm text-gray-600">Its follow-up tasks come back{target ? ` and weekly tracking restarts with the same target of ${target} a week — today, or tomorrow if the channel was closed today` : ''}. The weeks already recorded stay as they are.</p>
    </ModalShell>
  );
}

/** Change a live channel's weekly sourcing target and/or post link. Weeks that already finished keep the target they were measured against. */
export function EditChannelModal({ planId, channel, target, link, onClose, onDone }: {
  planId: string; channel: string; target: number | null; link: string | null; onClose: () => void; onDone: () => void;
}) {
  const [t, setT] = useState(target ? String(target) : '');
  const [url, setUrl] = useState(link ?? '');
  const [saving, setSaving] = useState(false);
  const newTarget = wholeTarget(t);
  const targetChanged = newTarget !== null && newTarget !== target;
  const linkChanged = url.trim() !== (link ?? '') && isUrl(url);
  const problem = t.trim() !== '' && newTarget === null ? 'The weekly sourcing target is a whole number (1 or more).'
    : url.trim() !== '' && !isUrl(url) ? 'The link must start with http:// or https://.' : '';
  const ok = !problem && (targetChanged || linkChanged);
  const submit = async () => {
    if (!ok) return;
    setSaving(true);
    try {
      await sourcingApi.updateChannel(planId, { channel, ...(targetChanged ? { weekly_target: newTarget } : {}), ...(linkChanged ? { posting_url: url.trim() } : {}) });
      toast.success('Saved — the change is in the plan history');
      onDone();
    } catch (err) {
      toast.error(apiError(err, 'Could not save the change'));
      if ((err as { response?: { status?: number } })?.response?.status === 409) onDone();
    }
    setSaving(false);
  };
  return (
    <ModalShell title={`${channel}: target and link`} subtitle={target ? undefined : 'No weekly target is set yet, so this channel is not being tracked.'} onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button type="button" onClick={submit} disabled={saving || !ok} title={problem || undefined} className="btn-primary text-sm">{saving ? <Spinner size="sm" /> : 'Save'}</button>
      </>}>
      <Field label="Weekly sourcing target" hint="Applicants per week — qualified and unqualified together. Weeks that already finished keep the target they were measured against; a new target counts from now.">
        <input type="number" min={1} max={MAX_WEEKLY_TARGET} step={1} className="input text-sm w-40" value={t} onChange={e => setT(e.target.value)} />
      </Field>
      <Field label={channel === 'Direct Outreach' ? 'Link to the outreach campaign or list' : 'Link to the job post'} optional>
        <input type="url" className="input text-sm" placeholder="https://…" value={url} onChange={e => setUrl(e.target.value)} />
      </Field>
      {problem && <p role="status" className="text-xs text-amber-700">{problem}</p>}
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
    : SOURCING_CHANNELS.filter(c => { const have = channels.find(x => x.channel === c); return !have || have.state === 'excluded'; });   // a CLOSED channel is reopened, not added
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

// ═══ Edit a plan: the strategy note and this role's weekly qualified target ═════════════════════════
// A plan has no individual owner — sourcing belongs to the HR/Admin persona as a whole — so these two are all there is to edit.
export function EditPlanModal({ plan, defaultTarget, onClose, onDone }: { plan: SourcingPlan; defaultTarget?: number | null; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState(plan.strategy_note ?? '');
  const [target, setTarget] = useState(plan.weekly_qualified_target ? String(plan.weekly_qualified_target) : '');
  const [saving, setSaving] = useState(false);
  const noteChanged = note.trim() !== (plan.strategy_note ?? '').trim();
  const targetBad = target.trim() !== '' && (!Number.isInteger(Number(target)) || Number(target) < 1 || Number(target) > 500);
  const newTarget = target.trim() === '' ? null : Number(target);
  const targetChanged = !targetBad && newTarget !== (plan.weekly_qualified_target ?? null);
  const ok = !targetBad && (noteChanged || targetChanged);

  const submit = async () => {
    if (!ok) return;
    setSaving(true);
    try {
      await sourcingApi.updatePlan(plan.id, {
        ...(noteChanged ? { strategy_note: note.trim() || null } : {}),
        ...(targetChanged ? { weekly_qualified_target: newTarget } : {}),
      });
      toast.success('Plan updated');
      onDone();
    } catch (err) { toast.error(apiError(err, 'Could not update the plan')); }
    setSaving(false);
  };

  return (
    <ModalShell title="Edit plan" subtitle="Changes are written to the plan's history."
      onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button type="button" onClick={submit} disabled={saving || !ok} className="btn-primary text-sm">{saving ? <Spinner size="sm" /> : 'Save'}</button>
      </>}>
      <Field label="Weekly qualified target" optional
        hint={defaultTarget ? `Qualified candidates wanted in any 7 days for this role. Blank = the default of ${defaultTarget}.` : 'Qualified candidates wanted in any 7 days for this role. Blank = no target, so nothing is flagged.'}>
        <input type="number" min={1} max={500} step={1} className="input text-sm w-32" value={target} onChange={e => setTarget(e.target.value)} />
      </Field>
      {targetBad && <p role="status" className="text-xs text-amber-700">The target is a whole number from 1 to 500.</p>}
      <Field label="Strategy note" optional hint="Anything leadership should know about how you'll source this role. The Hiring Manager does not see it.">
        <textarea className="input text-sm h-28 resize-none" maxLength={2000} value={note} onChange={e => setNote(e.target.value)} />
      </Field>
    </ModalShell>
  );
}
