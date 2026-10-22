import { Spinner } from '../components/shared/Badges.tsx';
import SourcingWorkspace from '../components/sourcing/SourcingWorkspace.tsx';
import SourcingSwitchedOff from '../components/sourcing/SourcingSwitchedOff.tsx';
import { useSourcingEnabled } from '../hooks/useSourcingPlan.ts';

/**
 * Sidebar → Sourcing: one role's sourcing plan at a time (role switcher on top, then the target, what needs attention with recommended next steps,
 * the channels with their weekly trackers, applications by source and the plan's history). It used to be a section at the bottom of the Dashboard
 * (and before that a card on each role's page). The Dashboard keeps only "Sourcing execution", the exceptions overview across roles.
 * HR-tier users act; a Hiring Manager gets the read-only plans of their own roles. Everything on the page comes from the module's own endpoints.
 */
export default function Sourcing() {
  const { enabled, loading, failed, retry } = useSourcingEnabled();
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
        <SourcingWorkspace heading={false} />
      )}
    </div>
  );
}
