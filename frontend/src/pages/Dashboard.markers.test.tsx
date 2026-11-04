import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DashboardData } from '../types/index.ts';
import { agingPhrase, backendFacts } from '../test/backendSource.ts';
import { DASHBOARD_REFRESH_MINUTES } from '../utils/columnInfo.ts';

// What the Dashboard's info markers and header hovers say. Each assertion pins a sentence; the fact behind it, which the backend
// decides, is named in the comment. Every NUMBER the sentences quote is taken from `backendFacts()`, which reads the backend's
// own source (src/test/backendSource.ts), not typed into this file, so a changed backend constant turns these tests red.
const b = backendFacts();
const dashboardGet = vi.fn();
vi.mock('../services/api.ts', () => ({
  dashboardApi: { get: (p: unknown) => dashboardGet(p) },
  rolesApi: { filterOptions: () => Promise.resolve({ data: { recruitment_modes: [], roles: [] } }) },
  sourcingApi: { dashboard: () => Promise.resolve({ data: { enabled: false } }) },
}));
vi.mock('../components/shared/HiringFunnelSnapshot.tsx', () => ({ default: () => <div /> }));
vi.mock('../components/shared/SlaBreachesByRole.tsx', () => ({ default: () => <div /> }));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Test HR', email: 'hr@example.test', persona: 'hr_recruiter' } }),
}));

import Dashboard from './Dashboard.tsx';

const role = (over: Record<string, unknown> = {}) => ({
  id: 'R001', title: 'Quality Assurance Engineer', priority: 'P1', status: 'Live – Sourcing', hiring_manager_name: 'Test HM',
  days_open: 40, days_overdue: 0, aging_alert: 'red', active_count: 2, shortlisted_scored_count: 0, shortlisted_count: 1, scored_above_60_count: 1,
  no_recent_candidate_activity: false, ...over,
});

const data = (): { data: DashboardData } => ({
  data: {
    metrics: {
      open_roles_count: 7, open_roles_by_priority: { P0: 2, P1: 3, P2: 1, P3: 1 }, avg_active_role_age_days: 12, avg_time_to_fill_days: 30, roles_filled_last_30d: 1,
      active_candidates: 120, candidates_score_ge_75: 10, candidates_score_le_45: 20, candidates_at_interview1_plus: 15, candidates_unmatched: 2,
      sla_breach_total: 3, sla_breach_by_owner: { 'HR / Recruiter': 2, 'Hiring Manager': 1 }, sla_breach_top_type: null, sla_breach_top_stage: null,
      red_aging_roles: 1, joining_risk_count: 0,
    },
    hiring_funnel_snapshot: [],
    aging_roles: [role()] as unknown as DashboardData['aging_roles'],
    low_pipeline: [role({ id: 'R002', title: 'Sr. Backend Developer' })] as unknown as DashboardData['low_pipeline'],
    roles_by_status: {}, hiring_funnel: [], rejected_by_stage: {},
    source_quality: [{ source_channel: 'LinkedIn', n: 12, pass_rate: 25, hire_rate: 8, contribution_pct: 60 }],
    velocity: { interview_to_offer_ratio: null, interviewed_count: 0, offered_count: 0, tat_by_stage: [{ stage: 'Applied and Screened', avg_hours: 30, n: 4 }],
                biggest_drop_off: null, biggest_drop_off_by_rate: null },
  },
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><Dashboard /></MemoryRouter></QueryClientProvider>);
}

// The text an info marker shows: the marker sits in the same row as the heading or tile label.
function markerText(label: string | RegExp): string {
  const heading = screen.getAllByText(label)[0];
  const button = heading.parentElement!.querySelector('[aria-label="More info"]')!;
  fireEvent.mouseEnter(button);
  return heading.parentElement!.querySelector('div.absolute')!.textContent!;
}

beforeEach(() => {
  dashboardGet.mockReset(); sessionStorage.clear();
  dashboardGet.mockResolvedValue(data());
});

describe('Dashboard — what the markers say', () => {
  it('Roles Snapshot: no "wider open set" claim (Aging roles has On Hold but not Under Review), and Filled (30D) says it is hidden by filters', async () => {
    mount();
    await screen.findByText('Roles Snapshot');
    const tip = markerText('Roles Snapshot');
    expect(tip).toContain('Open roles = Live – Sourcing, Approved or Under Review');
    expect(tip).toContain('On Hold roles do still appear in Aging roles and Low pipeline roles');
    expect(tip).not.toMatch(/wider/);
    // the tile shows N/A while a filter is on; the marker must say so (it used to give a reason the query does not have)
    expect(tip).toContain('it shows N/A while any filter is on, so clear the filters to see it');
    expect(tip).not.toContain("can't be filtered coherently");
  });

  it('Active candidates: names the Fit score scale and says the Active Candidates page lists more', async () => {
    mount();
    await screen.findByText('Active candidates');
    const tip = markerText('Active candidates');
    // routes/dashboard.ts counts ai_fit_score >= 75 and <= 45 (b.fitHighCount, b.fitLowCount)
    expect(tip).toContain(`Fit score ≥${b.fitHighCount} / ≤${b.fitLowCount}`);
    expect(tip).toContain(`at or above ${b.fitHighCount} or at or below ${b.fitLowCount}`);
    expect(tip).toContain('the Average Score × 10');
    expect(tip).toContain('Hold for Future, Joined and Closed applications');
    expect(screen.getByText(`Fit score ≥${b.fitHighCount}`)).toBeInTheDocument();     // the tile's own label matches the marker
    expect(screen.getByText(`Fit score ≤${b.fitLowCount}`)).toBeInTheDocument();
    expect(screen.queryByText(`Score ≥${b.fitHighCount}`)).not.toBeInTheDocument();
  });

  it('SLA breaches: HR owner is "HR/Admin", every window is the backend\'s, the escalation counts from the interview, and joining risk is the real rule', async () => {
    mount();
    await screen.findByText('SLA breaches');
    const tip = markerText('SLA breaches');
    // jobs/slaChecker.ts: BREACH_STANDARD_HOURS / BREACH_IDLE_HOURS, BREACH_HIGH_SCORE_HOURS, HIGH_SCORE_THRESHOLD (>=), LEADERSHIP_ESCALATION_HOURS,
    // BREACH_ASSIGNMENT_FEEDBACK_HOURS; routes/interviews.ts for the 60 hour assignment deadline; checkJoiningRisk for the days
    const tiered = `(${b.slaHighScoreHours}h if fit score ≥${b.slaHighScoreFit})`;
    expect(tip).toContain(`no stage change in ${b.slaIdleHours}h+`);
    expect(tip).toContain(`not shortlisted within ${b.slaStandardHours}h of Applied and Screened ${tiered}`);
    expect(tip).toContain(`no round with a date booked within ${b.slaStandardHours}h of entering that stage ${tiered}`);
    expect(tip).toContain(`assignment not sent within ${b.slaStandardHours}h of entering Assignment Round ${tiered}`);
    expect(tip).toContain(`feedback not submitted within ${b.slaStandardHours}h of the interview ${tiered}`);
    expect(tip).toContain(`feedback still outstanding ${b.slaEscalationHours}h after the interview`);          // anchored to the interview, not to the first breach
    expect(tip).not.toContain('still open 96h later');
    expect(tip).toContain(`feedback not submitted within ${b.slaAssignmentFeedbackHours}h of the assignment being sent (untouched by the score-tiering above)`);
    expect(tip).toContain(`hasn't submitted within ${b.slaAssignmentDeadlineHours}h of the assignment being sent`);
    expect(tip).toContain('Joining risk — no contact');
    expect(tip).toContain(`last logged HR contact is more than ${b.joiningRiskDays} days old, or who has none logged`);
    expect(tip).toContain(`flagged at the next check, not after ${b.joiningRiskDays} days`);
    expect(tip).not.toContain('(HR)');
    expect(tip).toContain('(HR/Admin)');
  });

  it('Aging roles: says the flag starts N days PAST the Close Target, with the real numbers per priority', async () => {
    mount();
    await screen.findByText('Aging roles');
    const tip = markerText('Aging roles');
    expect(tip).toContain(agingPhrase(b));                                      // types/index.ts AGING_THRESHOLDS, read from the backend source
    expect(tip).toContain('a role just past its target is not highlighted yet');
    expect(tip).toContain("its badge then reads 'no target'");
    expect(tip).not.toContain("'0d over'");
    // the badge itself, for the flagged role in the fixture (days_overdue 0, no Close Target): no misleading "0d over"
    expect(screen.getByText(/40d open · no target/)).toBeInTheDocument();
    expect(screen.queryByText(/0d over/)).not.toBeInTheDocument();
    expect(tip).toContain(`in more than ${b.noMovementDays} days`);             // routes/dashboard.ts NO_MOVEMENT_DAYS, compared with > (b.noMovementIsStrict)
    expect(tip).not.toContain('actually passed its own Close Target gets highlighted');
  });

  it('the red triangle on an Aging role says "more than N days", like the marker, and shows only for a role with no recent movement', async () => {
    dashboardGet.mockResolvedValue((() => {
      const d = data();
      d.data.aging_roles = [role({ id: 'R003', title: 'Stalled Role', no_recent_candidate_activity: true }), role({ id: 'R004', title: 'Busy Role' })] as unknown as DashboardData['aging_roles'];
      return d;
    })());
    mount();
    await screen.findByText('Stalled Role');
    const triangle = screen.getByTitle(/No candidate movement in/);
    expect(triangle.getAttribute('title')).toBe(`No candidate movement in more than ${b.noMovementDays} days (new applications don't count)`);
    expect(screen.getAllByTitle(/No candidate movement in/)).toHaveLength(1);    // not on the busy role
    expect(triangle.closest('tr')!.textContent).toContain('Stalled Role');
  });

  it('the abbreviated Aging roles and Low pipeline headers say what they stand for on hover', async () => {
    mount();
    await screen.findByText('Aging roles');
    for (const p of screen.getAllByText('P')) expect(p.getAttribute('title')).toContain('Priority');
    for (const hm of screen.getAllByText('HM')) expect(hm.getAttribute('title')).toContain('Hiring Manager');
    expect(screen.getByText('Age').getAttribute('title')).toContain('past its Close Target');
  });

  it('Low pipeline roles: names its statuses instead of calling them "open roles", and says how its Shortlisted differs from the Roles page', async () => {
    mount();
    await screen.findByText('Low pipeline roles');
    const tip = markerText('Low pipeline roles');
    expect(tip).toContain('Roles that are Approved, Live – Sourcing, Under Review or On Hold');
    expect(tip).toContain(`fewer than ${b.lowPipelineMaxShortlisted} shortlisted candidates`);       // utils/lowPipeline.ts
    expect(tip).toContain(`fewer than ${b.lowPipelineMaxActive} Active candidates in the pipeline`);
    expect(tip).not.toMatch(/^Open roles/);
    expect(tip).toContain('Shortlisted = Active candidates past Applied and Screened, including Reference Check onwards');
    expect(tip).toContain('not the same as Active Shortlist on the Roles page');
  });

  it('Source quality: counts applications ("12 applications", not "n=12") and says it is the candidate Source, not the form answer', async () => {
    mount();
    await screen.findByText('Source quality');
    expect(screen.getByText('12 applications')).toBeInTheDocument();
    expect(screen.queryByText('n=12')).not.toBeInTheDocument();
    const tip = markerText('Source quality');
    expect(tip).toContain("This is the candidate's Source field, not what applicants say on the application form");
  });

  it('Turnaround time: only finished stays count, and Applied and Screened starts at the application date', async () => {
    mount();
    await screen.findByText('Turnaround time by stage');
    const tip = markerText('Turnaround time by stage');
    expect(tip).toContain('Only stays that have ended count');
    expect(tip).toContain('Applied and Screened is measured from the application date');
  });

  it('the subtitle says how fresh the numbers are (the 5 minute refresh, its one exception, the SLA sweep throttle), not "updated live"', async () => {
    mount();
    await screen.findByText('Roles Snapshot');
    // frontend/src/utils/markerFacts.backend.test.ts checks which components really refetch on that interval
    const subtitle = screen.getByText(/Hiring health overview/).textContent!;
    expect(subtitle).toContain(`refreshes every ${DASHBOARD_REFRESH_MINUTES} minutes, except the Hiring Funnel Snapshot, which updates when you reload the page or come back to it`);
    expect(subtitle).toContain(`at most once every ${b.slaCheckThrottleMinutes} minutes on each server`);     // routes/dashboard.ts SLA_CHECK_THROTTLE_MS
    expect(screen.queryByText(/updated live/)).not.toBeInTheDocument();
  });
});
