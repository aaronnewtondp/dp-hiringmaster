import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { drain } from '../test/helpers.ts';
import type { Persona } from '../types/index.ts';

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// Persona x page smoke matrix.
//
// Every page is rendered as each of the four personas, signed in through the REAL AuthProvider (a session seeded in localStorage, exactly what a reload
// restores) — so the flags a page reads (canHR / canLead / isSuperAdmin) are the real ones, not a hand-copied derivation that could drift from
// AuthContext. Only the network is replaced. For each page the test asserts that it renders, that its key controls are there, and the gates that exist
// ONLY in the UI: a hidden column, a missing button, a request that is not made. (The server enforces the same rules; these are the first line, and the
// only one that stops a Hiring Manager from being OFFERED an action.) What the (mock) server sends is deliberately the same for every persona, so a
// difference between personas can only come from the page itself.
// ════════════════════════════════════════════════════════════════════════════════════════════════════

const h = vi.hoisted(() => {
  type Call = unknown[];
  const calls: Record<string, Call[]> = {};
  const state = {
    persona: 'hr_recruiter',
    sourcingOn: false,          // /sourcing/status, the workspace and the Sourcing execution tile
    roleStatus: 'Draft',        // the role every role page shows
    appStage: 'Interview Round 1',
    appHm: 'Hm Alpha',          // hiring_manager_name on the application and on the role
    selfEditable: false,        // User Management: the signed-in user's own row carries a persona that has buttons
    google: 'ok',               // how POST /auth/google answers: 'ok' | 'invalid' | 'down'
    unmatched: false,           // Candidates: one candidate with no application, in the Unmatched Candidates panel
  };
  // A plain function that records its arguments and answers asynchronously — a failing answer throws (never a vi.fn() rejection, which vitest reports as unhandled).
  const rec = (name: string, answer: (...a: Call) => unknown) => (...a: Call) => { (calls[name] ||= []).push(a); return Promise.resolve().then(() => answer(...a)); };
  const forbidden = () => Object.assign(new Error('403'), { response: { status: 403, data: { error: 'Forbidden' } } });
  const isHrTier = () => state.persona === 'hr_recruiter' || state.persona === 'leadership' || state.persona === 'super_admin';   // what the SERVER's requireHR lets through

  const role = () => ({
    id: 'R001', title: 'Smoke Test Engineer', priority: 'P1', department: 'Engineering', location: 'Mumbai', num_openings: 1, status: state.roleStatus,
    ctc_band: '18-24 SYNTH-LPA', active_candidate_count: 3, shortlisted_count: 1, hiring_manager_name: state.appHm, jd_drive_link: 'https://drive.example.test/jd',
    jd_source: 'generated', social_jd_drive_link: null, approval_summary_link: null, created_at: '2026-10-01T00:00:00Z', days_open: 5, days_overdue: 0,
    aging_alert: 'ok', yoe_required: '3-5 years', qualification_required: 'B.E.', must_have_skills: 'Skill A; Skill B', nice_to_have_skills: 'Skill C',
    job_description: 'Synthetic description', kpi_expectations: '', additional_remarks: '', recruitment_mode: ['LinkedIn'], vacancy_reason: ['Growth'],
    new_or_replacement: 'New Position', employment_type: 'Full-Time / Permanent', target_closure_date: '2026-12-01', start_date: '2026-10-01',
  });
  const app = (over: Record<string, unknown> = {}) => ({
    id: 'A9001', candidate_id: 'C9001', candidate_name: 'Synthetic Candidate One', candidate_email: 'c9001@example.test', role_id: 'R001', role_title: 'Smoke Test Engineer',
    role_priority: 'P1', stage: state.appStage, status: 'Active', recruiter_screening_status: 'New', source_channel: 'Job Application Form', hiring_manager_name: state.appHm,
    score_avg: 7.2, ai_fit_score: 72, candidate_ctc_fixed: 10, candidate_expected_ctc: 12, role_ctc_band: '18-24 SYNTH-LPA', application_date: '2026-10-01T00:00:00Z',
    last_updated: '2026-10-02T00:00:00Z', hr_recruiter_summary: 'SYNTH-RECRUITER-SUMMARY', internal_risk_notes: 'SYNTH-RISK-NOTE', ...over,
  });
  const candidate = () => ({
    id: 'C9001', full_name: 'Synthetic Candidate One', email: 'c9001@example.test', phone: '0000000000', hr_tags: [], current_ctc_fixed: 10, expected_ctc: 12,
    notice_period_days: 30, current_company: 'Synthetic Co', current_industry: 'Water', years_of_experience: 5,
  });
  const dashboard = () => ({
    metrics: {
      open_roles_count: 7, open_roles_by_priority: { P0: 2, P1: 3, P2: 1, P3: 1 }, avg_active_role_age_days: 12, avg_time_to_fill_days: 30, roles_filled_last_30d: 1,
      active_candidates: 120, candidates_score_ge_75: 10, candidates_score_le_45: 20, candidates_at_interview1_plus: 15, candidates_unmatched: 2,
      sla_breach_total: 0, sla_breach_by_owner: {}, sla_breach_top_type: null, sla_breach_top_stage: null, red_aging_roles: 0, joining_risk_count: 0,
    },
    hiring_funnel_snapshot: [], aging_roles: [], low_pipeline: [], roles_by_status: {}, hiring_funnel: [], rejected_by_stage: {}, source_quality: [],
    velocity: { interview_to_offer_ratio: null, interviewed_count: 0, offered_count: 0, tat_by_stage: [], biggest_drop_off: null, biggest_drop_off_by_rate: null },
  });
  const users = () => [
    { id: 'u-self', name: 'Smoke Self', email: 'self@example.test', persona: state.selfEditable ? 'leadership' : 'super_admin', is_active: true, department: null, auth_provider: 'google', created_at: '2026-01-01T00:00:00Z', last_login: null },
    { id: 'u-1', name: 'Synthetic Recruiter', email: 'recruiter@example.test', persona: 'hr_recruiter', is_active: true, department: 'HR', auth_provider: 'google', created_at: '2026-01-01T00:00:00Z', last_login: null },
    { id: 'u-2', name: 'Synthetic Manager', email: 'manager@example.test', persona: 'hiring_manager', is_active: false, department: null, auth_provider: 'google', created_at: '2026-01-01T00:00:00Z', last_login: null },
  ];
  const agency = () => ({ id: 'AGN001', name: 'Synthetic Search Partners', contract_status: 'Active', total_hired: 2, total_submitted: 5, contact_name: 'Syn Contact' });
  const workspace = () => ({ enabled: true, read_only: state.persona === 'hiring_manager', roles: [
    { role_id: 'R1', title: 'Role One', priority: 'P1', plan_id: '1', plan_status: 'active', open_exceptions: 0, channels_live: 1, qualified: 6, target: 5, behind: false },
  ], drafts: [] });

  const api = {
    authApi: {
      login: rec('auth.login', () => { throw new Error('login not stubbed'); }),
      loginWithGoogle: rec('auth.google', () => {
        if (state.google === 'invalid') throw Object.assign(new Error('401'), { response: { status: 401, data: { error: 'Invalid Google credential' } } });
        if (state.google === 'down') throw new Error('Network Error');
        return { data: { token: 'tok-google', user: { id: 'u-google', name: 'Smoke Google', email: 'google@example.test', persona: 'hiring_manager' } } };
      }),
    },
    rolesApi: {
      list: rec('roles.list', () => ({ data: { roles: [role()] } })),
      get: rec('roles.get', () => ({ data: { role: role() } })),
      pipeline: rec('roles.pipeline', () => ({ data: { pipeline: {}, total: 0 } })),
      activity: rec('roles.activity', () => ({ data: { activity: [] } })),
      create: rec('roles.create', () => ({ data: { role: { id: 'R100' } } })),
      update: rec('roles.update', () => ({ data: {} })),
      filterOptions: rec('roles.filterOptions', () => ({ data: { recruitment_modes: [], roles: [{ id: 'R001', title: 'Smoke Test Engineer' }] } })),
    },
    candidatesApi: {
      list: rec('candidates.list', () => ({ data: { candidates: [{ ...candidate(), id: 'C9003', full_name: 'Synthetic Archived', applications: [app({ id: 'A9003', status: 'Rejected', stage: 'Interview Round 1', ai_fit_score: 66 })] }], total: 1 } })),
      unmatched: rec('candidates.unmatched', () => state.unmatched
        ? ({ data: { submissions: [{ candidate_id: 'C9010', full_name: 'Synthetic Unlinked', email: 'unlinked@example.test', submitted_text: 'Synthetic Role Title', created_at: '2026-10-20T00:00:00Z', suggested_role_id: 'R001', suggested_role_title: 'Smoke Test Engineer' }], total: 1 } })
        : ({ data: { submissions: [], total: 0 } })),
      get: rec('candidates.get', () => ({ data: { candidate: candidate(), applications: [app()] } })),
      activity: rec('candidates.activity', () => ({ data: { activity: [] } })),
    },
    applicationsApi: {
      list: rec('applications.list', () => ({ data: { applications: [app(), app({ id: 'A9002', candidate_id: 'C9002', candidate_name: 'Synthetic Candidate Two', score_avg: null, ai_fit_score: null, stage: 'Applied and Screened' })] } })),
      advanceStage: rec('applications.advanceStage', () => ({ data: {} })),
      updateStatus: rec('applications.updateStatus', () => ({ data: {} })),
      retryScoring: rec('applications.retryScoring', () => ({ data: {} })),
    },
    interviewsApi: { list: rec('interviews.list', () => ({ data: { rounds: [] } })) },
    refChecksApi: { list: rec('refChecks.list', () => ({ data: { ref_checks: [] } })) },
    agenciesApi: {
      list: rec('agencies.list', () => { if (!isHrTier()) throw forbidden(); return { data: { agencies: [agency()] } }; }),
      get: rec('agencies.get', () => { if (!isHrTier()) throw forbidden(); return { data: { agency: agency() } }; }),
    },
    usersApi: {
      list: rec('users.list', () => ({ data: { users: users() } })),
      create: rec('users.create', () => ({ data: {} })),
      update: rec('users.update', () => ({ data: {} })),
    },
    dashboardApi: {
      get: rec('dashboard.get', () => ({ data: dashboard() })),
      pending: rec('dashboard.pending', () => ({ data: { actions: [], alerts: [], hm_roles: [] } })),
    },
    sourcingApi: {
      status: rec('sourcing.status', () => ({ data: { enabled: state.sourcingOn } })),
      workspace: rec('sourcing.workspace', () => ({ data: state.sourcingOn ? workspace() : { enabled: false } })),
      queue: rec('sourcing.queue', () => ({ data: { enabled: true, today: '2026-10-21', plans_to_activate: [], due: [], exceptions: [], exception_count: 0, snoozed_count: 0, blocked_count: 0, active_plans: 0, volume: [], volume_ok: 0 } })),
      dashboard: rec('sourcing.dashboard', () => ({ data: { enabled: false } })),
      plan: rec('sourcing.plan', () => ({ data: { enabled: false } })),
      people: rec('sourcing.people', () => ({ data: { people: [] } })),
    },
  };
  return { calls, state, api };
});

vi.mock('../services/api.ts', () => h.api);
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
// Heavy children that have their own tests and their own data calls: markers only, so a page's own gates are what is observed.
vi.mock('../components/ResumeIQPanel.tsx', () => ({ default: () => <div data-testid="resumeiq-panel" /> }));
vi.mock('../components/PortfolioReviewCard.tsx', () => ({ default: () => <div data-testid="portfolio-card" /> }));
vi.mock('../components/CompBenchmarkPanel.tsx', () => ({ default: () => <div data-testid="comp-benchmark" /> }));
vi.mock('../components/shared/HiringFunnelSnapshot.tsx', () => ({ default: () => <div data-testid="funnel-snapshot" /> }));
vi.mock('../components/shared/SlaBreachesByRole.tsx', () => ({ default: () => <div data-testid="sla-by-role" /> }));
vi.mock('../components/sourcing/SourcingPlanPanel.tsx', () => ({ default: ({ roleId }: { roleId: string }) => <div data-testid="plan-panel">Plan of {roleId}</div> }));

import { AuthProvider, useAuth } from '../contexts/AuthContext.tsx';
import Roles from './Roles.tsx';
import NewRole from './NewRole.tsx';
import NewCandidate from './NewCandidate.tsx';
import Agencies from './Agencies.tsx';
import AgencyDetail from './AgencyDetail.tsx';
import Candidates from './Candidates.tsx';
import CandidateDetail from './CandidateDetail.tsx';
import RoleDetail from './RoleDetail.tsx';
import TalentPool from './TalentPool.tsx';
import ScorecardSummary from './ScorecardSummary.tsx';
import MyTasks from './MyTasks.tsx';
import Dashboard from './Dashboard.tsx';
import Sourcing from './Sourcing.tsx';
import Help from './Help.tsx';
import UserManagement from './UserManagement.tsx';
import App from '../App.tsx';
import { VACANCY_REASONS, RECRUITMENT_CHANNELS } from '../types/index.ts';

// ── the spec: what each persona is, written out (NOT derived from AuthContext) ──────────────────────
const PERSONAS: Persona[] = ['hr_recruiter', 'hiring_manager', 'leadership', 'super_admin'];
const WHO: Record<Persona, { hr: boolean; lead: boolean; admin: boolean }> = {
  hr_recruiter:   { hr: true,  lead: false, admin: false },
  hiring_manager: { hr: false, lead: false, admin: false },
  leadership:     { hr: true,  lead: true,  admin: false },
  super_admin:    { hr: true,  lead: true,  admin: true  },
};

// ── mounting ─────────────────────────────────────────────────────────────────────────────────────
/** Renders the page only once the stored session has been read — as App does (it shows a spinner while `loading`), so no page ever sees "nobody signed in". */
function SessionGate({ children }: { children: ReactNode }) { return useAuth().loading ? null : <>{children}</>; }

function signIn(persona: Persona, name = `Smoke ${persona}`) {
  h.state.persona = persona;
  localStorage.setItem('hms_token', 'tok-smoke');
  localStorage.setItem('hms_user', JSON.stringify({ id: 'u-self', name, email: `${persona}@example.test`, persona }));
}
let qc: QueryClient;
function mountAs(persona: Persona, ui: ReactElement, opts: { path?: string; route?: string; name?: string } = {}) {
  signIn(persona, opts.name);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider><SessionGate>
        <MemoryRouter initialEntries={[opts.path ?? '/x']}>
          <Routes>
            <Route path={opts.route ?? '/x'} element={ui} />
            <Route path="*" element={<div data-testid="elsewhere" />} />
          </Routes>
        </MemoryRouter>
      </SessionGate></AuthProvider>
    </QueryClientProvider>,
  );
}
const asked = (name: string) => h.calls[name] ?? [];
const lastParams = (name: string) => asked(name)[asked(name).length - 1]?.[0] as Record<string, unknown>;
const present = (el: HTMLElement | null) => el !== null;

beforeEach(() => {
  for (const k of Object.keys(h.calls)) delete h.calls[k];
  Object.assign(h.state, { persona: 'hr_recruiter', sourcingOn: false, roleStatus: 'Draft', appStage: 'Interview Round 1', appHm: 'Hm Alpha', selfEditable: false, google: 'ok', unmatched: false });
  localStorage.clear(); sessionStorage.clear();
  vi.mocked(toast.error).mockClear(); vi.mocked(toast.success).mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });                                   // "today" is fixed; timers stay real
  vi.setSystemTime(new Date(2026, 9, 21, 12, 0, 0));
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs();
  document.head.querySelectorAll('script[src*="accounts.google.com"]').forEach(el => el.remove());     // appended by Login when a client id is configured
  delete (window as { google?: unknown }).google;
});

const ROLE_TITLE = 'Smoke Test Engineer';
const CTC_BAND = '18-24 SYNTH-LPA';

// ═══ The matrix ══════════════════════════════════════════════════════════════════════════════════════
describe.each(PERSONAS)('as %s', persona => {
  const who = WHO[persona];

  it('is signed in with the flags the spec gives that persona (the matrix below rests on this)', async () => {
    let seen: ReturnType<typeof useAuth> | undefined;
    const Probe = () => { seen = useAuth(); return null; };
    mountAs(persona, <Probe />);
    expect({ hr: seen!.canHR, lead: seen!.canLead, admin: seen!.isSuperAdmin }).toEqual(who);
  });

  // ── Roles ──────────────────────────────────────────────────────────────────────────────────────
  it('Roles: the list; the Salary Range column only for HR-tier; "New role" for HR and Super Admin, "Request role" for Hiring Manager and Leadership', async () => {
    mountAs(persona, <Roles />);
    await screen.findByText(ROLE_TITLE);
    expect(screen.getByRole('heading', { level: 1, name: 'Roles' })).toBeInTheDocument();
    expect(present(screen.queryByRole('columnheader', { name: 'Salary Range' }))).toBe(who.hr);
    expect(present(screen.queryByText(CTC_BAND))).toBe(who.hr);                       // the value is not in the page at all for a Hiring Manager
    const cta = screen.getByRole('link', { name: /^(New role|Request role)$/ });
    expect(cta).toHaveAttribute('href', '/roles/new');
    expect(cta.textContent?.trim()).toBe(persona === 'hr_recruiter' || persona === 'super_admin' ? 'New role' : 'Request role');
  });

  // ── NewRole ────────────────────────────────────────────────────────────────────────────────────
  it('NewRole: "Request" framing for Hiring Manager and Leadership; the CTC Band field is absent for a Hiring Manager only; a Hiring Manager is pre-filled as the manager', () => {
    mountAs(persona, <NewRole />);
    const requesting = persona === 'hiring_manager' || persona === 'leadership';
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(requesting ? 'Request new role' : 'Create new role');
    expect(screen.getByRole('button', { name: requesting ? 'Submit request' : 'Create role' })).toBeInTheDocument();
    expect(present(screen.queryByText(/^CTC Band/))).toBe(persona !== 'hiring_manager');
    expect((screen.getByPlaceholderText('Full name') as HTMLInputElement).value).toBe(persona === 'hiring_manager' ? `Smoke ${persona}` : '');
  });

  // ── NewCandidate ───────────────────────────────────────────────────────────────────────────────
  it('NewCandidate: renders, and asks for the agency list (a 403 for anyone else) only when HR-tier', async () => {
    mountAs(persona, <NewCandidate />);
    expect(screen.getByRole('heading', { level: 1, name: 'Add candidate' })).toBeInTheDocument();
    await waitFor(() => expect(asked('roles.list')).toHaveLength(1));                    // the page's own queries have run
    if (who.hr) await waitFor(() => expect(asked('agencies.list')).toHaveLength(1));
    await drain();
    expect(asked('agencies.list')).toHaveLength(who.hr ? 1 : 0);
  });

  // ── Agencies ───────────────────────────────────────────────────────────────────────────────────
  it('Agencies: the repository for HR-tier; for a Hiring Manager the server refuses and the page shows an empty state instead of failing', async () => {
    mountAs(persona, <Agencies />);
    expect(screen.getByRole('heading', { level: 1, name: 'Agency Repository' })).toBeInTheDocument();
    if (who.hr) {
      expect(await screen.findByText('Synthetic Search Partners')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Synthetic Search Partners/ })).toHaveAttribute('href', '/agencies/AGN001');
    } else {
      expect(await screen.findByText('No agencies')).toBeInTheDocument();
      expect(screen.queryByText('Synthetic Search Partners')).toBeNull();
    }
  });

  it('AgencyDetail: the agency and its sections for HR-tier; "Agency not found" (no crash) when the server refuses', async () => {
    mountAs(persona, <AgencyDetail />, { path: '/agencies/AGN001', route: '/agencies/:id' });
    if (who.hr) {
      expect(await screen.findByRole('heading', { level: 1, name: 'Synthetic Search Partners' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Contract' })).toBeInTheDocument();
    } else {
      expect(await screen.findByText('Agency not found')).toBeInTheDocument();
    }
  });

  // ── Candidates ─────────────────────────────────────────────────────────────────────────────────
  it('Candidates: the same first request for everyone; "Add candidate" and the selection column only for HR-tier; selecting a row opens the bulk bar for HR-tier only', async () => {
    mountAs(persona, <Candidates />);
    await screen.findByText('Synthetic Candidate One');
    expect(screen.getByRole('heading', { level: 1, name: 'Active Candidates' })).toBeInTheDocument();
    expect(asked('applications.list')[0]?.[0]).toEqual({ limit: '100', exclude_stale_archived: 'true' });
    expect(present(screen.queryByRole('link', { name: /Add candidate/ }))).toBe(who.hr);
    const boxes = screen.queryAllByRole('checkbox');
    expect(boxes.length > 0).toBe(who.hr);
    if (who.hr) {
      fireEvent.click(boxes[1]);                                                       // [0] is "select all"
      expect(await screen.findByText('1 selected')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Change Stage' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Change Status' })).toBeInTheDocument();
    } else {
      expect(screen.queryByText(/selected$/)).toBeNull();
      expect(screen.queryByRole('button', { name: /Change (Stage|Status)/ })).toBeNull();
    }
  });

  it('Candidates — Unmatched Candidates panel: everyone sees the candidate; "Link to role", the suggested-role shortcut and "Delete candidate" only for HR-tier', async () => {
    h.state.unmatched = true;
    mountAs(persona, <Candidates />);
    fireEvent.click(await screen.findByText('Unmatched Candidates (1)'));              // the panel is collapsed on load
    expect(await screen.findByRole('link', { name: 'Synthetic Unlinked' })).toHaveAttribute('href', '/candidates/C9010');
    expect(present(screen.queryByRole('button', { name: 'Link to role' }))).toBe(who.hr);
    expect(present(screen.queryByRole('button', { name: 'Link to Smoke Test Engineer' }))).toBe(who.hr);
    expect(present(screen.queryByTitle('Delete candidate'))).toBe(who.hr);
  });

  // ── TalentPool ─────────────────────────────────────────────────────────────────────────────────
  it('Archived Pipeline: the archived list for everyone; "Reactivate" only for HR-tier', async () => {
    mountAs(persona, <TalentPool />);
    await screen.findByText('Synthetic Archived');
    expect(screen.getByRole('heading', { level: 1, name: 'Archived Pipeline' })).toBeInTheDocument();
    expect(present(screen.queryByRole('button', { name: 'Reactivate' }))).toBe(who.hr);
  });
});

describe.each(PERSONAS)('as %s — detail pages, review and dashboards', persona => {
  const who = WHO[persona];

  // ── CandidateDetail ────────────────────────────────────────────────────────────────────────────
  it('CandidateDetail: Stage, Status, Add Application, Schedule round, the Founder flag and the HR screening notes only for HR-tier; the agency list only requested for HR-tier', async () => {
    mountAs(persona, <CandidateDetail />, { path: '/candidates/C9001', route: '/candidates/:id' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Synthetic Candidate One' })).toBeInTheDocument();
    await waitFor(() => expect(asked('interviews.list')).toHaveLength(1));
    await screen.findByText('Interview rounds');                                       // the application is expanded, as it is on load
    expect(present(screen.queryByRole('button', { name: 'Stage' }))).toBe(who.hr);
    expect(present(screen.queryByRole('button', { name: 'Status' }))).toBe(who.hr);
    expect(present(screen.queryByRole('button', { name: /Add Application/ }))).toBe(who.hr);
    expect(present(screen.queryByRole('button', { name: /Schedule round/ }))).toBe(who.hr);          // the application is at Interview Round 1
    expect(present(screen.queryByTitle('Flag for Founder Review'))).toBe(who.hr);
    // Internal risk notes: an editable section for HR-tier; not in the page at all for anyone else, whatever the server sent.
    expect(present(screen.queryByText('SYNTH-RISK-NOTE'))).toBe(who.hr);
    expect(present(screen.queryByText('Screening & Risk Notes'))).toBe(who.hr);
    // ...while everyone reads the recruiter's own summary, as a quotation.
    if (!who.hr) expect(screen.getByText('"SYNTH-RECRUITER-SUMMARY"')).toBeInTheDocument();
    await drain();
    expect(asked('agencies.list')).toHaveLength(who.hr ? 1 : 0);
  });

  // ── RoleDetail ─────────────────────────────────────────────────────────────────────────────────
  it('RoleDetail (Draft): Approve Role, Discard role, Change status, the CTC Band field and the comp benchmark only for HR-tier; approving sends status Approved', async () => {
    h.state.roleStatus = 'Draft';
    mountAs(persona, <RoleDetail />, { path: '/roles/R001', route: '/roles/:id' });
    expect(await screen.findByRole('heading', { level: 1, name: ROLE_TITLE })).toBeInTheDocument();
    await waitFor(() => expect(asked('sourcing.plan')).toHaveLength(1));                // the page's own queries have run
    expect(present(screen.queryByRole('button', { name: 'Approve Role' }))).toBe(who.hr);
    expect(present(screen.queryByRole('button', { name: 'Discard role' }))).toBe(who.hr);
    expect(present(screen.queryByRole('button', { name: 'Change status' }))).toBe(who.hr);
    expect(present(screen.queryByText('CTC Band'))).toBe(who.hr);
    expect(present(screen.queryByText(CTC_BAND))).toBe(who.hr);
    expect(present(screen.queryByTestId('comp-benchmark'))).toBe(who.hr);
    expect(screen.getByRole('heading', { name: 'Approval' })).toBeInTheDocument();
    if (who.hr) {
      fireEvent.click(screen.getByRole('button', { name: 'Approve Role' }));
      await waitFor(() => expect(asked('roles.update')).toEqual([['R001', { status: 'Approved' }]]));
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Role approved'));
    } else {
      await drain();
      expect(asked('roles.update')).toHaveLength(0);
    }
  });

  it('RoleDetail (Under Review): Approve Role for HR-tier only, and Discard role for nobody (only a Draft can be discarded)', async () => {
    h.state.roleStatus = 'Under Review';
    mountAs(persona, <RoleDetail />, { path: '/roles/R001', route: '/roles/:id' });
    await screen.findByRole('heading', { level: 1, name: ROLE_TITLE });
    expect(present(screen.queryByRole('button', { name: 'Approve Role' }))).toBe(who.hr);
    expect(screen.queryByRole('button', { name: 'Discard role' })).toBeNull();
  });

  it('RoleDetail (Approved, JD generated): no one is offered Approve or Discard again; Regenerate JD only for HR-tier', async () => {
    h.state.roleStatus = 'Approved';
    mountAs(persona, <RoleDetail />, { path: '/roles/R001', route: '/roles/:id' });
    await screen.findByRole('heading', { level: 1, name: ROLE_TITLE });
    expect(screen.queryByRole('button', { name: 'Approve Role' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard role' })).toBeNull();
    expect(present(screen.queryByRole('button', { name: 'Regenerate JD' }))).toBe(who.hr);
  });

  it('RoleDetail (Closed – Filled): Download Closure Summary only for HR-tier', async () => {
    h.state.roleStatus = 'Closed – Filled';
    mountAs(persona, <RoleDetail />, { path: '/roles/R001', route: '/roles/:id' });
    await screen.findByRole('heading', { level: 1, name: ROLE_TITLE });
    expect(present(screen.queryByRole('button', { name: 'Download Closure Summary' }))).toBe(who.hr);
  });

  // ── Ready for Review (ScorecardSummary) ────────────────────────────────────────────────────────
  it('Ready for Review: everyone can shortlist (straight to Interview Round 1); Retry scoring only for HR-tier; the stage editor only for Leadership and Super Admin — not HR/Admin', async () => {
    mountAs(persona, <ScorecardSummary />);
    await screen.findByText('Synthetic Candidate Two');
    // A9002 is the only row at Applied and Screened, so it is the only one with row actions.
    const shortlist = screen.getAllByRole('button', { name: /Shortlist/ });
    expect(shortlist).toHaveLength(1);
    expect(screen.getAllByTitle('Reject')).toHaveLength(1);
    expect(screen.getAllByTitle('Hold for future roles')).toHaveLength(1);
    expect(present(screen.queryByRole('button', { name: 'Retry scoring' }))).toBe(who.hr);          // A9002 has no ResumeIQ score
    // The stage badge of A9001 (Interview Round 1) is a button only where the stage can be edited inline.
    expect(present(screen.getByText('Interview Round 1').closest('button'))).toBe(who.lead);
    fireEvent.click(shortlist[0]);
    await waitFor(() => expect(asked('applications.advanceStage')).toHaveLength(1));
    expect(asked('applications.advanceStage')[0].slice(0, 2)).toEqual(['A9002', 'Interview Round 1']);
  });

  // ── My Tasks ───────────────────────────────────────────────────────────────────────────────────
  it('My Tasks: the right boxes, the Sourcing box only for HR/Admin and Super Admin, and Ready for Review scoped to the persona', async () => {
    h.state.sourcingOn = true;
    mountAs(persona, <MyTasks />, { name: 'Hm Alpha' });                               // a Hiring Manager is the named manager of the one role
    expect(await screen.findByRole('heading', { level: 1, name: 'My Tasks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ready for Review/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Feedback Due/ })).toBeInTheDocument();
    // Leadership with no role of their own keeps the alerts-only box (their queue is visibility, not tasks).
    expect(present(screen.queryByRole('button', { name: /^Leadership Alerts/ }))).toBe(persona === 'leadership');
    expect(present(screen.queryByRole('button', { name: /^Other Pending Actions/ }))).toBe(persona !== 'leadership');
    await waitFor(() => expect(asked('applications.list')).not.toHaveLength(0));       // Ready for Review has asked for its rows
    const wantsSourcing = persona === 'hr_recruiter' || persona === 'super_admin';
    if (wantsSourcing) expect(await screen.findByRole('button', { name: /^Sourcing/ })).toBeInTheDocument();
    await drain();
    expect(present(screen.queryByRole('button', { name: /^Sourcing/ }))).toBe(wantsSourcing);
    expect(asked('sourcing.status')).toHaveLength(wantsSourcing ? 1 : 0);              // nobody else is even asked
    expect(asked('roles.list')).toHaveLength(persona === 'hiring_manager' ? 1 : 0);    // only a Hiring Manager needs to know which roles are theirs
    const request = lastParams('applications.list');
    if (persona === 'hiring_manager') {
      expect(request.role_id).toEqual(['R001']);
      expect(request.founder_flag).toBeUndefined();
    } else if (persona === 'leadership') {
      expect(request.founder_flag).toBe('true');
      expect(request.role_id).toBeUndefined();
    } else {
      expect(request.founder_flag).toBeUndefined();
      expect(request.role_id).toBeUndefined();
    }
  });

  // ── Dashboard ──────────────────────────────────────────────────────────────────────────────────
  it('Dashboard: a Hiring Manager is locked to their own role (no Role filter, never sends one, never loads the role options); everyone else can filter by role', async () => {
    sessionStorage.setItem('hms:dashboard.roleIds', JSON.stringify(['R001']));          // a role filter left over in this tab
    mountAs(persona, <Dashboard />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    await waitFor(() => expect(asked('dashboard.get')).not.toHaveLength(0));
    await drain();
    const locked = persona === 'hiring_manager';
    expect(present(screen.queryByText('Locked to your role'))).toBe(locked);
    expect(present(screen.queryByRole('button', { name: /^Role/ }))).toBe(!locked);
    expect(asked('roles.filterOptions')).toHaveLength(locked ? 0 : 1);
    if (locked) expect(lastParams('dashboard.get').role_id).toBeUndefined();
    else expect(lastParams('dashboard.get').role_id).toEqual(['R001']);
  });

  // ── Sourcing ───────────────────────────────────────────────────────────────────────────────────
  it('Sourcing (on): the same page for every persona — the plans come from the server, which decides what each persona may see', async () => {
    h.state.sourcingOn = true;
    mountAs(persona, <Sourcing />);
    expect(screen.getByRole('heading', { level: 1, name: 'Sourcing' })).toBeInTheDocument();
    expect(await screen.findByTestId('role-pill-R1')).toBeInTheDocument();
    expect(await screen.findByTestId('plan-panel')).toHaveTextContent('Plan of R1');
  });

  it('Sourcing (off): says it is switched off, for every persona', async () => {
    mountAs(persona, <Sourcing />);
    expect(await screen.findByText('Sourcing is switched off')).toBeInTheDocument();
    expect(screen.queryByTestId('role-pill-R1')).toBeNull();
  });

  // ── Help ───────────────────────────────────────────────────────────────────────────────────────
  it('Help: renders for every persona (no assertion on its wording)', async () => {
    mountAs(persona, <Help />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(asked('sourcing.status')).toHaveLength(1));
  });
});

// ═══ Who sees the Compensation fields on a candidate ═════════════════════════════════════════════════
// HR-tier always; a Hiring Manager only when they are named on one of the candidate's roles (a role can name several, "A, B"). The rule is spelled out
// here from the spec, not by calling the util the page uses.
describe('CandidateDetail — who sees the Compensation fields', () => {
  const LABELS = ['Current CTC (Fixed and Variable breakup) in LPA', 'Expected CTC'];
  const open = async (persona: Persona, name: string, namedOnRole: string) => {
    h.state.appHm = namedOnRole;
    mountAs(persona, <CandidateDetail />, { path: '/candidates/C9001', route: '/candidates/:id', name });
    await screen.findByRole('heading', { level: 1, name: 'Synthetic Candidate One' });
    await screen.findByText('Notice Period (days)');                                    // the Compensation card is on screen; its CTC fields come and go
  };
  const sees = () => LABELS.map(l => present(screen.queryByText(l)));

  it.each<[string, Persona, string, string, boolean]>([
    ['the named manager',                              'hiring_manager', 'Hm Alpha',    'Hm Alpha',                  true],
    ['the named manager, in different case and spacing', 'hiring_manager', ' hm   ALPHA ', 'Hm Alpha',                  true],
    ['one of two managers named with a comma',         'hiring_manager', 'Hm Beta',     'Hm Alpha, Hm Beta',         true],
    ['one of two managers named with an ampersand',    'hiring_manager', 'Hm Beta',     'Hm Alpha & Hm Beta',        true],
    ['one of two managers named with "and"',           'hiring_manager', 'Hm Alpha',    'Hm Alpha and Hm Beta',      true],
    ['a manager whose name is only a prefix of the named one', 'hiring_manager', 'Hm Alpha', 'Hm Alphabet',          false],
    ['a manager whose name is only the start of the named one', 'hiring_manager', 'Hm',    'Hm Alpha',               false],
    ['a manager who is not named',                     'hiring_manager', 'Hm Gamma',    'Hm Alpha',                  false],
    ['a manager when the role names several others',   'hiring_manager', 'Hm Gamma',    'Hm Alpha, Hm Beta',         false],
    ['HR/Admin, named or not',                         'hr_recruiter',   'Hm Gamma',    'Hm Alpha',                  true],
    ['Leadership, named or not',                       'leadership',     'Hm Gamma',    'Hm Alpha',                  true],
    ['Super Admin, named or not',                      'super_admin',    'Hm Gamma',    'Hm Alpha',                  true],
  ])('%s', async (_label, persona, name, namedOnRole, expected) => {
    await open(persona, name, namedOnRole);
    expect(sees()).toEqual([expected, expected]);
  });
});

// ═══ A Hiring Manager on no role gets nothing, not everything ════════════════════════════════════════
describe('My Tasks — a Hiring Manager who is the manager of no role', () => {
  it('asks Ready for Review for a role list that matches nothing, instead of dropping the filter (which would show every candidate)', async () => {
    mountAs('hiring_manager', <MyTasks />, { name: 'Hm Omega' });
    await screen.findByRole('heading', { level: 1, name: 'My Tasks' });
    await waitFor(() => expect(asked('applications.list')).not.toHaveLength(0));
    const request = lastParams('applications.list');
    expect(Array.isArray(request.role_id)).toBe(true);
    expect(request.role_id).toHaveLength(1);
    expect(request.role_id).not.toContain('R001');
  });
});

// ═══ User Management (Super Admin) and the /users route guard ════════════════════════════════════════
describe('User Management', () => {
  it('lists everyone; the own row (Super Admin) has no actions; the others can be edited and deactivated or reactivated', async () => {
    mountAs('super_admin', <UserManagement />);
    expect(await screen.findByRole('heading', { level: 1, name: 'User Management' })).toBeInTheDocument();
    const own = (await screen.findByText('Smoke Self')).closest('tr')!;
    expect(within(own).queryByRole('button')).toBeNull();
    const recruiter = screen.getByText('Synthetic Recruiter').closest('tr')!;
    expect(within(recruiter).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(recruiter).getByRole('button', { name: 'Deactivate' })).toBeEnabled();
    const manager = screen.getByText('Synthetic Manager').closest('tr')!;
    expect(within(manager).getByRole('button', { name: 'Reactivate' })).toBeEnabled();
  });

  it('can never deactivate its own account, even if its own row carries an editable persona', async () => {
    h.state.selfEditable = true;
    mountAs('super_admin', <UserManagement />);
    const own = (await screen.findByText('Smoke Self')).closest('tr')!;
    expect(within(own).getByRole('button', { name: 'Deactivate' })).toBeDisabled();
    fireEvent.click(within(own).getByRole('button', { name: 'Deactivate' }));
    await drain();
    expect(asked('users.update')).toHaveLength(0);
  });

  it('deactivating another user sends is_active false', async () => {
    mountAs('super_admin', <UserManagement />);
    const row = (await screen.findByText('Synthetic Recruiter')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(asked('users.update')).toEqual([['u-1', { is_active: false }]]));
  });

  it('the role dropdown offers exactly HR/Admin, Hiring Manager and Leadership — Super Admin is never selectable', async () => {
    mountAs('super_admin', <UserManagement />);
    await screen.findByText('Synthetic Recruiter');
    fireEvent.click(screen.getByRole('button', { name: /Add user/ }));
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map(o => o.value)).toEqual(['hr_recruiter', 'hiring_manager', 'leadership']);
  });

  it('adding a user needs a name and an email, then sends them with the chosen role', async () => {
    mountAs('super_admin', <UserManagement />);
    await screen.findByText('Synthetic Recruiter');
    fireEvent.click(screen.getByRole('button', { name: /Add user/ }));
    const submit = () => fireEvent.click(screen.getAllByRole('button', { name: 'Add user' }).pop()!);   // [0] is the page's button, the last is the form's
    submit();
    expect(toast.error).toHaveBeenLastCalledWith('Name is required');
    const [name, email] = screen.getAllByRole('textbox');
    fireEvent.change(name, { target: { value: '  Synth Person ' } });
    submit();
    expect(toast.error).toHaveBeenLastCalledWith('Email is required');
    expect(asked('users.create')).toHaveLength(0);
    fireEvent.change(email, { target: { value: 'synth@example.test' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'leadership' } });
    submit();
    await waitFor(() => expect(asked('users.create')).toHaveLength(1));
    expect(asked('users.create')[0][0]).toEqual({ name: 'Synth Person', email: 'synth@example.test', persona: 'leadership', department: undefined });
  });
});

// The REAL route table (App.tsx), the real Layout and Sidebar, the real AuthProvider: the only test that visits /users.
describe('/users in the real route table', () => {
  function mountApp(persona: Persona | null, path: string) {
    if (persona) signIn(persona);
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider>);
  }

  it.each(PERSONAS)('%s', async persona => {
    mountApp(persona, '/users');
    if (WHO[persona].admin) {
      expect(await screen.findByRole('heading', { level: 1, name: 'User Management' })).toBeInTheDocument();
      await waitFor(() => expect(asked('users.list')).toHaveLength(1));
    } else {
      expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();    // redirected to /dashboard
      await waitFor(() => expect(asked('dashboard.get')).not.toHaveLength(0));
      await drain();
      expect(screen.queryByRole('heading', { name: 'User Management' })).toBeNull();
      expect(asked('users.list')).toHaveLength(0);                                      // the page never mounted: its data was never requested
    }
    // The menu agrees with the route table, for the persona the real provider derived.
    expect(present(screen.queryByRole('link', { name: 'User Management' }))).toBe(WHO[persona].admin);
    expect(present(screen.queryByRole('link', { name: 'Agencies' }))).toBe(WHO[persona].hr);
    expect(screen.getByRole('link', { name: 'Roles' })).toBeInTheDocument();
  });

  it('nobody signed in: any page, /users included, goes to the sign-in page and requests nothing', async () => {
    mountApp(null, '/users');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    await drain();
    expect(asked('users.list')).toHaveLength(0);
    expect(asked('dashboard.get')).toHaveLength(0);
  });
});

// ═══ Sign-in page ════════════════════════════════════════════════════════════════════════════════════
// Login reads VITE_GOOGLE_CLIENT_ID when its module loads, and frontend/.env exists on a developer machine and not on a clean checkout — so the value is
// stubbed explicitly and the page (with the provider it talks to) is imported afresh for each case.
describe('Login', () => {
  type GsiConfig = { client_id: string; callback: (r: { credential: string }) => void };
  let gsi: GsiConfig | undefined;
  const renderButton = vi.fn();
  async function mountLogin(clientId: string) {
    vi.resetModules();
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', clientId);
    const { default: Login } = await import('./Login.tsx');
    const { AuthProvider: Provider } = await import('../contexts/AuthContext.tsx');
    const { default: freshToast } = await import('react-hot-toast');
    (window as { google?: unknown }).google = { accounts: { id: { initialize: (c: GsiConfig) => { gsi = c; }, renderButton } } };
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <Provider><MemoryRouter initialEntries={['/login']}><Routes>
          <Route path="/login" element={<Login />} /><Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes></MemoryRouter></Provider>
      </QueryClientProvider>,
    );
    return { view, freshToast };
  }
  /** Google's script has "loaded": the page's own onload hook runs and initialises the button. */
  const gsiLoaded = () => {
    const script = document.head.querySelector('script[src*="accounts.google.com/gsi"]') as HTMLScriptElement;
    script.onload!(new Event('load'));
  };
  beforeEach(() => { gsi = undefined; renderButton.mockReset(); });

  it('without a client id it says so and loads nothing from Google', async () => {
    await mountLogin('');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText(/VITE_GOOGLE_CLIENT_ID is not set/)).toBeInTheDocument();
    expect(document.head.querySelector('script[src*="accounts.google.com"]')).toBeNull();
  });

  it('with a client id it loads Google\'s script, then initialises and renders the button for that client', async () => {
    await mountLogin('client-id-for-tests');
    expect(screen.queryByText(/VITE_GOOGLE_CLIENT_ID is not set/)).toBeNull();
    expect(document.head.querySelector('script[src="https://accounts.google.com/gsi/client"]')).not.toBeNull();
    gsiLoaded();
    expect(gsi?.client_id).toBe('client-id-for-tests');
    expect(renderButton).toHaveBeenCalledTimes(1);
    expect(renderButton.mock.calls[0][0]).toBeInstanceOf(HTMLDivElement);
  });

  it('a good Google credential signs in (stores the session) and goes to /dashboard', async () => {
    await mountLogin('client-id-for-tests');
    gsiLoaded();
    await waitFor(() => expect(gsi).toBeDefined());
    gsi!.callback({ credential: 'google-id-token' });
    expect(await screen.findByTestId('elsewhere')).toBeInTheDocument();
    expect(asked('auth.google')).toEqual([['google-id-token']]);
    expect(localStorage.getItem('hms_token')).toBe('tok-google');
    expect(JSON.parse(localStorage.getItem('hms_user')!)).toMatchObject({ persona: 'hiring_manager' });
  });

  it('a refused credential shows the server\'s own message, stores nothing and stays on the page', async () => {
    h.state.google = 'invalid';
    const { freshToast } = await mountLogin('client-id-for-tests');
    gsiLoaded();
    gsi!.callback({ credential: 'bad' });
    await waitFor(() => expect(freshToast.error).toHaveBeenCalledWith('Invalid Google credential'));
    expect(localStorage.getItem('hms_token')).toBeNull();
    expect(screen.queryByTestId('elsewhere')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('an error with no server message falls back to a generic one', async () => {
    h.state.google = 'down';
    const { freshToast } = await mountLogin('client-id-for-tests');
    gsiLoaded();
    gsi!.callback({ credential: 'x' });
    await waitFor(() => expect(freshToast.error).toHaveBeenCalledWith('Sign-in failed. Try again.'));
    expect(localStorage.getItem('hms_token')).toBeNull();
  });
});

// ═══ Forms ═══════════════════════════════════════════════════════════════════════════════════════════
describe('NewRole — submitting without a CTC band', () => {
  /** Fills every required field except the CTC band (which a Hiring Manager is never shown) and submits the form. */
  const submitAllButCtcBand = (container: HTMLElement) => {
    const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
    type(screen.getByPlaceholderText('e.g. Senior Backend Developer'), 'Synthetic Role');
    const [department, , , location] = Array.from(container.querySelectorAll('select'));       // Department, Priority, New/Replacement, Location, Employment Type
    type(department, (department as HTMLSelectElement).options[1].value);
    type(location, (location as HTMLSelectElement).options[1].value);
    if (!(screen.getByPlaceholderText('Full name') as HTMLInputElement).value) type(screen.getByPlaceholderText('Full name'), 'Hm Alpha');
    type(screen.getByPlaceholderText(/^e\.g\. 3.5 years$/), '3-5 years');
    type(screen.getByPlaceholderText(/^e\.g\. B\.Tech/), 'B.E.');
    type(container.querySelector('input[type="date"]')!, '2026-12-01');
    type(screen.getByPlaceholderText('Key responsibilities and expectations'), 'Synthetic description');
    type(screen.getByPlaceholderText(/^Node\.js; TypeScript/), 'Skill A; Skill B');
    type(screen.getByPlaceholderText(/^GraphQL; AWS/), 'Skill C');
    fireEvent.click(screen.getByRole('button', { name: VACANCY_REASONS[0] }));
    fireEvent.click(screen.getByRole('button', { name: RECRUITMENT_CHANNELS[0] }));
    fireEvent.submit(container.querySelector('form')!);
  };

  it.each(PERSONAS)('%s', async persona => {
    const { container } = mountAs(persona, <NewRole />);
    submitAllButCtcBand(container);
    if (persona === 'hiring_manager') {
      // Never asked for it, so never refused for lacking it: the request goes through.
      await waitFor(() => expect(asked('roles.create')).toHaveLength(1));
      expect(toast.error).not.toHaveBeenCalled();
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Role requested — HR will review it shortly'));
    } else {
      expect(toast.error).toHaveBeenCalledWith('CTC Band is required');
      await drain();
      expect(asked('roles.create')).toHaveLength(0);
    }
  });
});

// ═══ A known defect, pinned ══════════════════════════════════════════════════════════════════════════
// Agencies.tsx renders an "Add agency" button with no handler: it is shown to everyone who can open the page, does nothing when pressed, and there is no
// agenciesApi.create call behind it on this page. Reported, not fixed here. When it is wired up this test fails: replace it with a test of the real flow.
describe('Agencies — "Add agency"', () => {
  it('TODAY: the button is there and pressing it opens nothing, asks for nothing and says nothing', async () => {
    mountAs('hr_recruiter', <Agencies />);
    await screen.findByText('Synthetic Search Partners');
    const inputsBefore = document.querySelectorAll('input, textarea, select').length;
    const callsBefore = Object.values(h.calls).flat().length;
    fireEvent.click(screen.getByRole('button', { name: /Add agency/ }));
    await drain();
    expect(document.querySelectorAll('input, textarea, select')).toHaveLength(inputsBefore);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(Object.values(h.calls).flat()).toHaveLength(callsBefore);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
