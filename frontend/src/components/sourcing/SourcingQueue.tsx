import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PriorityBadge, Spinner, EmptyState } from '../shared/Badges.tsx';
import InfoTooltip from '../shared/InfoTooltip.tsx';
import { QueueException, SourcingQueue as QueueData } from '../../types/sourcing.ts';
import { dueLabel, exceptionLabel, plural, topN } from '../../utils/sourcingFormat.ts';
import { CompleteCommitmentModal, ResolveExceptionModal } from './SourcingModals.tsx';

const TOP = 5;

type Dialog =
  | { kind: 'complete'; id: string; kind2: string; title: string; channel: string }
  | { kind: 'resolve'; exception: QueueException }
  | null;

function Section({ title, count, info, children }: { title: string; count: number; info?: string; children: React.ReactNode }) {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-1.5">
        <h2 className="text-sm font-semibold text-gray-900">{title} <span className="font-mono text-gray-400">({count})</span></h2>
        {info && <InfoTooltip align="left" width="w-80" text={info} />}
      </div>
      {children}
    </div>
  );
}

function MoreButton({ more, expanded, onToggle }: { more: number; expanded: boolean; onToggle: () => void }) {
  if (more <= 0) return null;
  return (
    <div className="px-5 py-2.5 border-t border-gray-50">
      <button type="button" onClick={onToggle} className="text-xs text-dp-600 hover:underline">
        {expanded ? 'Show fewer' : `Show ${more} more`}
      </button>
    </div>
  );
}

/**
 * My Tasks → Sourcing. Everything a recruiter owes right now, in the order of what hurts most: plans waiting to be
 * activated, commitments due today, then open exceptions grouped by role. Top 5 of each with "N more" so a long list never
 * buries the first screen. Purely presentational — MyTasks owns the query (it also needs the count for the section box).
 */
export default function SourcingQueue({ queue, loading, failed, onRetry, onChanged }: {
  queue: QueueData | undefined; loading: boolean; failed: boolean; onRetry: () => void;
  onChanged: () => void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [open, setOpen] = useState<{ activate: boolean; due: boolean; exceptions: boolean }>({ activate: false, due: false, exceptions: false });
  const toggle = (k: keyof typeof open) => setOpen(o => ({ ...o, [k]: !o[k] }));

  if (loading && !queue) return <div className="flex justify-center p-12"><Spinner size="lg" /></div>;
  if (failed && !queue) {
    return (
      <div role="alert" className="card p-5 flex items-center justify-between gap-3 text-sm text-gray-600">
        <span>Couldn't load the sourcing queue.</span>
        <button type="button" onClick={onRetry} className="btn-secondary text-xs py-1.5 px-3">Retry</button>
      </div>
    );
  }
  if (!queue) return null;

  const dueToday = queue.due.filter(d => !d.overdue);
  const acts = topN(queue.plans_to_activate, open.activate ? Infinity : TOP);
  const dues = topN(dueToday, open.due ? Infinity : TOP);
  const groups = topN(queue.exceptions, open.exceptions ? Infinity : TOP);
  const under = queue.volume.filter(v => v.qualified < v.min);
  const nothing = queue.plans_to_activate.length === 0 && dueToday.length === 0 && queue.exception_count === 0;
  const done = () => { setDialog(null); onChanged(); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 justify-between">
        <p className="text-xs text-gray-500" data-testid="sourcing-targets">
          {queue.volume.length > 0
            ? <>This week: <span className="font-medium text-gray-700">{queue.volume_ok} of {plural(queue.volume.length, 'role')}</span> at their own weekly qualified target.
                {under.length > 0 && <> Below target: {under.slice(0, 3).map((v, i) => (
                  <span key={v.role_id}>{i > 0 ? ', ' : ''}<Link to={`/dashboard?sourcing_role=${v.role_id}#sourcing-workspace`} className="text-dp-600 hover:underline">{v.title}</Link> ({v.qualified})</span>
                ))}{under.length > 3 ? ` +${under.length - 3} more` : ''}.</>}
              </>
            : <>{plural(queue.active_plans, 'active plan')}. A role's weekly qualified target applies once it has one (5 by default for P0 and P1 roles).</>}
        </p>
      </div>

      {nothing && <div className="card p-8"><EmptyState title="Nothing needs your attention ✓" message="No plans waiting, nothing due today, no open exceptions." /></div>}

      {queue.plans_to_activate.length > 0 && (
        <Section title="Plans to activate" count={queue.plans_to_activate.length}>
          <ul className="divide-y divide-gray-50">
            {acts.shown.map(p => (
              <li key={p.plan_id} className="px-5 py-3 flex items-center gap-3">
                <PriorityBadge priority={p.priority} />
                <div className="flex-1 min-w-0">
                  <Link to={`/dashboard?sourcing_role=${p.role_id}#sourcing-workspace`} className="text-sm font-medium text-gray-900 hover:text-dp-600">{p.title}</Link>
                  <div className="text-xs text-gray-400">{p.approval_date ? `Approved ${p.approval_date}` : 'Approved'}</div>
                </div>
                <Link to={`/dashboard?sourcing_role=${p.role_id}#sourcing-workspace`} className="btn-secondary text-xs py-1.5 px-3 shrink-0">Activate</Link>
              </li>
            ))}
          </ul>
          <MoreButton more={acts.more || (open.activate ? queue.plans_to_activate.length - TOP : 0)} expanded={open.activate} onToggle={() => toggle('activate')} />
        </Section>
      )}

      {dueToday.length > 0 && (
        <Section title="Due today" count={dueToday.length} info="Tasks due before midnight IST today; once their day ends they move to Needs attention. Working days are Monday to Friday; public holidays are not modelled.">
          <ul className="divide-y divide-gray-50">
            {dues.shown.map(d => (
              <li key={d.id} className="px-5 py-3 flex items-center gap-3">
                <PriorityBadge priority={d.priority} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-900">{d.title}</div>
                  <div className="text-xs text-gray-400">
                    <Link to={`/dashboard?sourcing_role=${d.role_id}#sourcing-workspace`} className="hover:text-dp-600">{d.role_title}</Link> · {d.channel} · {dueLabel(d.due_date, queue.today)}
                  </div>
                </div>
                <button type="button" className="btn-secondary text-xs py-1.5 px-3 shrink-0"
                  onClick={() => setDialog({ kind: 'complete', id: d.id, kind2: d.kind, title: d.title, channel: d.channel })}>Mark done</button>
              </li>
            ))}
          </ul>
          <MoreButton more={dues.more || (open.due ? dueToday.length - TOP : 0)} expanded={open.due} onToggle={() => toggle('due')} />
        </Section>
      )}

      {queue.exceptions.length > 0 && (
        <Section title="Needs attention" count={queue.exception_count} info="Sourcing tasks that were promised and not done, plans not activated in time and similar gaps. New provisional signals are not listed here. This list is shared by all of HR/Admin: there is no personal queue.">
          <div className="divide-y divide-gray-100">
            {groups.shown.map(g => (
              <div key={g.role_id} className="px-5 py-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <PriorityBadge priority={g.priority} />
                  <Link to={`/dashboard?sourcing_role=${g.role_id}#sourcing-workspace`} className="text-sm font-medium text-gray-900 hover:text-dp-600">{g.title}</Link>
                        </div>
                <ul className="space-y-2">
                  {g.items.map(e => (
                    <li key={e.id} className="rounded-lg border border-red-100 bg-red-50/40 px-3 py-2.5 flex items-start gap-3">
                      <div className="flex-1 min-w-0 text-xs">
                        <div className="font-medium text-gray-900">{exceptionLabel(e.type)}{e.channel !== '*' ? <span className="text-gray-500 font-normal"> · {e.channel}</span> : null}</div>
                        <div className="text-gray-600 mt-0.5">{e.happened}</div>
                        <div className="text-gray-400 mt-0.5">Next: {e.next_action}</div>
                      </div>
                      <button type="button" className="btn-secondary text-xs py-1 px-2.5 shrink-0" onClick={() => setDialog({ kind: 'resolve', exception: e })}>Resolve…</button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <MoreButton more={groups.more || (open.exceptions ? queue.exceptions.length - TOP : 0)} expanded={open.exceptions} onToggle={() => toggle('exceptions')} />
          {(queue.snoozed_count > 0 || queue.blocked_count > 0) && (
            <div className="px-5 py-2.5 border-t border-gray-50 text-xs text-gray-400">
              Not shown: {queue.snoozed_count} catching up · {queue.blocked_count} blocked
            </div>
          )}
        </Section>
      )}

      {dialog?.kind === 'complete' && (
        <CompleteCommitmentModal commitment={{ id: dialog.id, kind: dialog.kind2, title: dialog.title }} channel={dialog.channel} onClose={() => setDialog(null)} onDone={done} />
      )}
      {dialog?.kind === 'resolve' && (
        <ResolveExceptionModal exception={dialog.exception} onClose={() => setDialog(null)} onDone={done} />
      )}
    </div>
  );
}
