import { PRIORITY_COLORS, Priority, AgingAlert } from '../../types/index.ts';

// ─── Priority badge ───────────────────────────────────────────────────────────
export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${PRIORITY_COLORS[priority]}`}>
      {priority}
    </span>
  );
}

// ─── Stage badge ──────────────────────────────────────────────────────────────
export function StageBadge({ stage }: { stage: string }) {
  const color =
    stage === 'Joined'            ? 'bg-green-100 text-green-800' :
    stage === 'Offer Accepted'    ? 'bg-emerald-100 text-emerald-800' :
    stage === 'Offer Released'    ? 'bg-teal-100 text-teal-800' :
    stage === 'Offer Discussion'  ? 'bg-cyan-100 text-cyan-800' :
    stage === 'Rejected'          ? 'bg-red-100 text-red-800' :
    stage === 'Withdrawn'         ? 'bg-gray-100 text-gray-600' :
    stage.startsWith('Interview') ? 'bg-dp-100 text-dp-800' :
    stage === 'Shortlisted'       ? 'bg-violet-100 text-violet-800' :
    stage === 'Resume Review'     ? 'bg-yellow-100 text-yellow-800' :
    'bg-gray-100 text-gray-600';

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${color}`}>
      {stage}
    </span>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────
export function StatusBadge({ status }: { status: string }) {
  const color =
    status === 'Active'          ? 'bg-green-100 text-green-700' :
    status === 'On Hold'         ? 'bg-amber-100 text-amber-700' :
    status === 'Rejected'        ? 'bg-red-100 text-red-700' :
    status === 'Withdrawn'       ? 'bg-gray-100 text-gray-600' :
    status === 'Joined'          ? 'bg-emerald-100 text-emerald-700' :
    status === 'Hold for Future' ? 'bg-purple-100 text-purple-700' :
    'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${color}`}>
      {status}
    </span>
  );
}

// ─── Aging indicator ─────────────────────────────────────────────────────────
export function AgingBadge({ alert, days }: { alert: AgingAlert; days: number }) {
  if (alert === 'red')    return <span className="text-xs font-medium text-red-600">🔴 {days}d</span>;
  if (alert === 'yellow') return <span className="text-xs font-medium text-amber-600">🟡 {days}d</span>;
  return <span className="text-xs text-gray-500">{days}d</span>;
}

// ─── Fit score ────────────────────────────────────────────────────────────────
export function FitScore({ score }: { score?: number | null }) {
  if (score == null) return <span className="text-xs text-gray-400">—</span>;
  const color = score >= 75 ? 'text-green-700 font-semibold' : score >= 50 ? 'text-amber-700' : 'text-red-600';
  return <span className={`text-sm ${color}`}>{score}</span>;
}

// ─── SLA indicator ────────────────────────────────────────────────────────────
export function SlaBadge({ breached }: { breached: boolean }) {
  if (!breached) return null;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
      SLA
    </span>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
export function EmptyState({ title, message }: { title: string; message?: string }) {
  return (
    <div className="text-center py-12">
      <p className="text-sm font-medium text-gray-500">{title}</p>
      {message && <p className="text-xs text-gray-400 mt-1">{message}</p>}
    </div>
  );
}

// ─── Loading spinner ──────────────────────────────────────────────────────────
export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sz = size === 'sm' ? 'h-4 w-4' : size === 'lg' ? 'h-10 w-10' : 'h-6 w-6';
  return (
    <div className={`animate-spin rounded-full border-2 border-gray-200 border-t-dp-600 ${sz}`} />
  );
}

// ─── Section header ───────────────────────────────────────────────────────────
export function SectionHeader({ title, subtitle, action }: {
  title: string; subtitle?: string; action?: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between mb-4">
      <div>
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
