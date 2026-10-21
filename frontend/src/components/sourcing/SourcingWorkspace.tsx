import { useEffect, useRef } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Spinner, PriorityBadge, EmptyState } from '../shared/Badges.tsx';
import { usePersistedState } from '../../hooks/usePersistedState.ts';
import { useSourcingWorkspace } from '../../hooks/useSourcingPlan.ts';
import { WorkspaceRole } from '../../types/sourcing.ts';
import SourcingPlanPanel from './SourcingPlanPanel.tsx';

const ROLE_PARAM = 'sourcing_role';

function RolePill({ r, selected, onSelect }: { r: WorkspaceRole; selected: boolean; onSelect: () => void }) {
  const note = r.plan_status === 'paused' ? 'On hold'
    : r.plan_status === 'draft' ? 'Not activated'
    : r.target !== null ? `${r.qualified}/${r.target} qualified` : null;
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected} data-testid={`role-pill-${r.role_id}`}
      className={`text-left rounded-lg border px-3 py-2 transition-colors max-w-[16rem] ${selected ? 'border-dp-500 bg-dp-50 ring-1 ring-dp-200' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>
      <span className="flex items-center gap-1.5">
        <PriorityBadge priority={r.priority} />
        <span className="text-sm font-medium text-gray-900 truncate">{r.title}</span>
      </span>
      <span className="mt-0.5 flex items-center gap-2 text-[11px]">
        {note && <span className={r.behind ? 'text-red-600 font-medium' : 'text-gray-500'}>{note}</span>}
        {r.open_exceptions > 0 && <span className="text-red-600 font-medium">{r.open_exceptions} {r.open_exceptions === 1 ? 'issue' : 'issues'}</span>}
        {r.plan_status === 'active' && r.open_exceptions === 0 && !r.behind && <span className="text-green-700">On track</span>}
      </span>
    </button>
  );
}

/**
 * Dashboard → Sourcing plans. Every role whose plan is active (or paused) is a button across the top; picking one shows its whole plan below —
 * target, what needs attention with recommended next steps, channels with their weekly trackers, and the plan's activity timeline. It replaces the
 * Sourcing card that used to sit on each role's page. Plans still waiting to be activated are listed underneath so they can be opened and activated.
 * Renders nothing while the module is off.
 */
export default function SourcingWorkspace() {
  const { data, isLoading, isError } = useSourcingWorkspace();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [remembered, setRemembered] = usePersistedState<string | null>('sourcing.role', null);
  const ref = useRef<HTMLElement>(null);

  const ws = data && data.enabled ? data : null;
  const roles = ws?.roles ?? [];
  const drafts = ws?.drafts ?? [];
  const draftsTotal = ws?.drafts_total ?? drafts.length;
  const known = (id: string | null | undefined) => !!id && [...roles, ...drafts].some(r => r.role_id === id);
  const wanted = params.get(ROLE_PARAM);
  const selected = known(wanted) ? wanted! : known(remembered) ? remembered! : (roles[0] ?? drafts[0])?.role_id ?? null;

  const select = (id: string) => {
    setRemembered(id);
    setParams(p => { const n = new URLSearchParams(p); n.set(ROLE_PARAM, id); return n; }, { replace: true });
  };

  // Arriving from a role page chip, My Tasks or the exceptions table (…#sourcing-workspace): bring the workspace into view once it has loaded.
  const arrivedByLink = location.hash === '#sourcing-workspace' || !!wanted;
  useEffect(() => {
    if (ws && arrivedByLink) ref.current?.scrollIntoView?.({ block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!ws]);

  if (data && !data.enabled) return null;                              // module off: the page is exactly what it was
  const heading = (
    <div className="flex items-center gap-2 mb-3">
      <Compass className="w-4 h-4 text-gray-400" aria-hidden="true" />
      <h2 className="text-base font-semibold text-gray-900">Sourcing plans</h2>
      <span className="text-xs text-gray-400">— pick a role to see its channels, weekly results, next steps and history</span>
    </div>
  );
  if (isLoading) return <section id="sourcing-workspace" ref={ref} className="scroll-mt-4">{heading}<div className="card p-8 flex justify-center"><Spinner /></div></section>;
  if (isError || !ws) return <section id="sourcing-workspace" ref={ref} className="scroll-mt-4">{heading}<div role="alert" className="card p-6 text-sm text-gray-500">Couldn't load the sourcing plans.</div></section>;

  const selectedDraft = drafts.find(r => r.role_id === selected);
  return (
    <section id="sourcing-workspace" ref={ref} aria-label="Sourcing plans" className="scroll-mt-4 space-y-3" data-testid="sourcing-workspace">
      <div>{heading}</div>

      {roles.length === 0 && drafts.length === 0 ? (
        <div className="card p-8"><EmptyState title="No sourcing plans yet" message={ws.read_only ? 'A plan appears here once HR activates one for a role you are hiring for.' : 'A plan is created for every open role. Approve a role and it will appear here.'} /></div>
      ) : (
        <>
          {roles.length > 0 ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Roles with a sourcing plan">
              {roles.map(r => <RolePill key={r.role_id} r={r} selected={r.role_id === selected} onSelect={() => select(r.role_id)} />)}
            </div>
          ) : (
            <p className="text-sm text-gray-500">No plan is active yet. Open one of the roles below and activate it.</p>
          )}

          {drafts.length > 0 && (
            <details className="text-sm" open={roles.length === 0 || !!selectedDraft}>
              <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-700">
                {draftsTotal} {draftsTotal === 1 ? 'role has' : 'roles have'} a plan waiting to be activated
              </summary>
              <div className="flex flex-wrap gap-2 mt-2">
                {drafts.map(r => <RolePill key={r.role_id} r={r} selected={r.role_id === selected} onSelect={() => select(r.role_id)} />)}
              </div>
              {draftsTotal > drafts.length && <p className="mt-1.5 text-[11px] text-gray-400">Showing the {drafts.length} most urgent of {draftsTotal}.</p>}
            </details>
          )}

          {selected && <SourcingPlanPanel key={selected} roleId={selected} />}
        </>
      )}
    </section>
  );
}
