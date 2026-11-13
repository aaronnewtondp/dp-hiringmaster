import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PriorityBadge, Spinner } from '../shared/Badges.tsx';
import InfoTooltip from '../shared/InfoTooltip.tsx';
import { useSourcingOverview } from '../../hooks/useSourcingDetail.ts';
import { HealthColour, OverviewRow } from '../../types/sourcing.ts';
import { Priority } from '../../types/index.ts';
import { COLOUR_CLASS, COLOUR_WORD } from './SourcingDetailPanel.tsx';

function Dot({ box }: { box: { colour: HealthColour; text: string } | null }) {
  if (!box) return <span className="text-gray-300">—</span>;
  return <span title={box.text} className={`inline-block rounded-md border px-2 py-0.5 text-[11px] font-medium ${COLOUR_CLASS[box.colour]}`}>{COLOUR_WORD[box.colour]}</span>;
}

/**
 * The leadership page: every role with an open plan, its three sourcing health colours and its open alerts. A role with a draft plan shows
 * "Plan not activated". Clicking a role opens its plan. HR-tier only.
 */
export default function SourcingOverview() {
  const { data, isLoading, isError } = useSourcingOverview(true);
  const [priority, setPriority] = useState('');
  const [colour, setColour] = useState('');
  const [hm, setHm] = useState('');
  const rows = data?.rows ?? [];
  const hms = useMemo(() => [...new Set(rows.map(r => r.hiring_manager).filter((x): x is string => !!x))].sort(), [rows]);
  const shown = rows.filter(r => (!priority || r.priority === priority) && (!hm || r.hiring_manager === hm)
    && (!colour || [r.enough?.colour, r.right?.colour, r.worked?.colour].includes(colour as HealthColour)));

  if (isLoading) return <div className="card p-8 flex justify-center"><Spinner /></div>;
  if (isError || !data || !data.enabled) return <div role="alert" className="card p-6 text-sm text-gray-500">Couldn't load the overview.</div>;
  const s = data.summary;
  const tile = (label: string, value: string, info: string) => (
    <div className="card px-4 py-3"><div className="text-[11px] uppercase tracking-wide text-gray-400 flex items-center gap-1">{label}<InfoTooltip align="left" text={info} /></div><div className="text-xl font-semibold text-gray-900 mt-0.5">{value}</div></div>
  );
  return (
    <div className="space-y-4" data-testid="sourcing-overview">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tile('Roles with an active plan', `${s.roles_with_active_plan} of ${s.roles_total}`, 'Open roles whose sourcing plan has been activated, out of all roles with a plan to activate.')}
        {tile('Check-ins on time', s.checkins_due ? `${s.checkins_on_time} of ${s.checkins_due}` : '—', 'Weekly check-ins filed within two working days of the Friday they were due, over the last four weeks (only weeks the plan was already active).')}
        {tile('Open alerts', String(s.open_alerts), 'Alerts HR can see now. Provisional alerts (still being tuned) are not counted here.')}
        {tile('Alerts with the hiring manager', String(s.hm_alerts), 'Open alerts that need the hiring manager as well as the recruiter (wrong candidates, hiring manager rejects most).')}
      </div>
      <div className="flex flex-wrap gap-2 items-center text-sm">
        <select className="input text-xs py-1" aria-label="Priority" value={priority} onChange={e => setPriority(e.target.value)}><option value="">All priorities</option>{['P0', 'P1', 'P2', 'P3'].map(p => <option key={p}>{p}</option>)}</select>
        <select className="input text-xs py-1" aria-label="Hiring manager" value={hm} onChange={e => setHm(e.target.value)}><option value="">All hiring managers</option>{hms.map(h => <option key={h}>{h}</option>)}</select>
        <select className="input text-xs py-1" aria-label="Colour" value={colour} onChange={e => setColour(e.target.value)}><option value="">Any colour</option><option value="red">Has red</option><option value="amber">Has amber</option><option value="green">Has green</option><option value="grey">Has grey</option></select>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
            <th className="font-medium px-3 py-2">Role</th><th className="font-medium px-3 py-2">Hiring manager</th><th className="font-medium px-3 py-2">Enough candidates?</th>
            <th className="font-medium px-3 py-2">Right candidates?</th><th className="font-medium px-3 py-2">Plan being worked?</th><th className="font-medium px-3 py-2 text-right">Open alerts</th></tr></thead>
          <tbody className="divide-y divide-gray-100">
            {shown.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">No roles match.</td></tr>}
            {shown.map((r: OverviewRow) => (
              <tr key={r.role_id} data-testid={`overview-row-${r.role_id}`}>
                <td className="px-3 py-2"><Link to={`/sourcing?sourcing_role=${r.role_id}`} className="font-medium text-gray-900 hover:underline">{r.role_id} · {r.title}</Link> <PriorityBadge priority={r.priority as Priority} />
                  {r.plan_status === 'draft' && <div className="text-xs text-amber-700">Plan not activated</div>}
                  {r.plan_status === 'paused' && <div className="text-xs text-gray-400">On hold</div>}
                  {r.headline && r.plan_status === 'active' && <div className="text-xs text-gray-500">{r.headline}</div>}</td>
                <td className="px-3 py-2 text-gray-600">{r.hiring_manager ?? '—'}</td>
                <td className="px-3 py-2"><Dot box={r.enough} /></td><td className="px-3 py-2"><Dot box={r.right} /></td><td className="px-3 py-2"><Dot box={r.worked} /></td>
                <td className="px-3 py-2 text-right font-mono">{r.open_alerts}{r.provisional_alerts > 0 && <span className="ml-1 text-[10px] text-gray-400 font-sans" title="Provisional alerts are still being tuned and are not shown as open alerts yet">+{r.provisional_alerts} provisional</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
