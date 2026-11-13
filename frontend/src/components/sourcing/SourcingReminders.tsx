import { Link } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { useSourcingReminders } from '../../hooks/useSourcingDetail.ts';
import { Reminder } from '../../types/sourcing.ts';

/** The recruiter's "coming up" list on the Sourcing page: weekly check-ins, outreach uploads, candidates with no source, plans waiting to be activated.
    Things the system can track by itself never appear here. */
export default function SourcingReminders() {
  const { data } = useSourcingReminders(true);
  const items: Reminder[] = data && data.enabled ? data.reminders : [];
  if (items.length === 0) return null;
  const shown = items.slice(0, 8);
  return (
    <section aria-label="Coming up" className="card px-4 py-3" data-testid="sourcing-reminders">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 flex items-center gap-1.5"><CalendarClock className="w-3.5 h-3.5" aria-hidden="true" />Coming up</h2>
      <ul className="mt-1.5 divide-y divide-gray-50">
        {shown.map((r, i) => (
          <li key={`${r.kind}-${r.role_id}-${i}`} className="py-1 flex items-center justify-between gap-3 text-sm">
            <Link to={`/sourcing?sourcing_role=${r.role_id}`} className="text-gray-800 hover:underline">{r.title}<span className="text-gray-400 text-xs"> · {r.detail}</span></Link>
            <span className={`text-xs whitespace-nowrap ${r.overdue ? 'text-red-600 font-medium' : 'text-gray-400'}`}>{r.due ? `${r.overdue ? 'was due' : 'due'} ${r.due}` : ''}</span>
          </li>
        ))}
      </ul>
      {items.length > shown.length && <p className="text-[11px] text-gray-400 mt-1">and {items.length - shown.length} more</p>}
    </section>
  );
}
