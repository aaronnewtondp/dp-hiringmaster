import { EmptyState } from '../shared/Badges.tsx';

/** What the Sourcing page shows when the module is switched off (also if the workspace answers "off" under a page that thought it was on). */
export default function SourcingSwitchedOff() {
  return (
    <div className="card p-8">
      <EmptyState title="Sourcing is switched off" message="The Sourcing module is not enabled for HMS right now. Nothing is being tracked or chased while it is off." />
    </div>
  );
}
