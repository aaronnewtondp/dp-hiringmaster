import { useSearchParams } from 'react-router-dom';
import { Spinner } from '../components/shared/Badges.tsx';
import SourcingWorkspace from '../components/sourcing/SourcingWorkspace.tsx';
import SourcingOverview from '../components/sourcing/SourcingOverview.tsx';
import SourcingCompanies from '../components/sourcing/SourcingCompanies.tsx';
import SourcingReminders from '../components/sourcing/SourcingReminders.tsx';
import { useCanHR } from '../contexts/AuthContext.tsx';
import SourcingSwitchedOff from '../components/sourcing/SourcingSwitchedOff.tsx';
import { useSourcingEnabled } from '../hooks/useSourcingPlan.ts';

/**
 * Sidebar → Sourcing: one role's sourcing plan at a time (role switcher on top, then the target, what needs attention with recommended next steps,
 * the channels with their weekly trackers, applications by source and the plan's history). It used to be a section at the bottom of the Dashboard
 * (and before that a card on each role's page). The Dashboard keeps only "Sourcing execution", the exceptions overview across roles.
 * HR-tier users act; a Hiring Manager gets the read-only plans of their own roles. Everything on the page comes from the module's own endpoints.
 */
const TABS = [['plans', 'Plans'], ['overview', 'Overview'], ['companies', 'Company directory']] as const;

export default function Sourcing() {
  const { enabled, loading, failed, retry } = useSourcingEnabled();
  const canHR = useCanHR();
  const [params, setParams] = useSearchParams();
  // HR-tier users also get the leadership Overview and the shared Company directory (plan detailing); everyone else sees the plans only.
  const asked = params.get('tab');
  const tab = canHR && (asked === 'overview' || asked === 'companies') ? asked : 'plans';
  const pick = (t: string) => setParams(p => { const n = new URLSearchParams(p); if (t === 'plans') n.delete('tab'); else n.set('tab', t); return n; }, { replace: true });
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Sourcing</h1>
        <p className="text-sm text-gray-500 mt-0.5">Pick a role to see its channels, weekly results, recommended next steps and history.</p>
      </div>
      {loading ? (
        <div className="card p-8 flex justify-center"><Spinner /></div>
      ) : failed ? (
        <div role="alert" className="card p-6 text-sm text-gray-600 flex items-center justify-between gap-3 flex-wrap">
          <span>Couldn't check whether Sourcing is switched on. This is usually a short connection problem.</span>
          <button type="button" onClick={retry} className="btn-secondary">Try again</button>
        </div>
      ) : !enabled ? (
        <SourcingSwitchedOff />
      ) : (
        <>
          {canHR && (
            <div role="tablist" aria-label="Sourcing sections" className="flex gap-1 border-b border-gray-200">
              {TABS.map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => pick(id)}
                  className={`px-3 py-1.5 text-sm -mb-px border-b-2 ${tab === id ? 'border-dp-500 text-dp-700 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>{label}</button>
              ))}
            </div>
          )}
          {tab === 'overview' ? <SourcingOverview /> : tab === 'companies' ? <SourcingCompanies /> : (
            <>
              {canHR && <SourcingReminders />}
              <SourcingWorkspace heading={false} />
            </>
          )}
        </>
      )}
    </div>
  );
}
