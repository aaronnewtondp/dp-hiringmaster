import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OverviewResponse, PlanDetail } from '../../types/sourcing.ts';

const api = vi.hoisted(() => ({
  detail: vi.fn(), saveDetail: vi.fn(), templates: vi.fn(), applyTemplate: vi.fn(), checkin: vi.fn(), uploadOutreach: vi.fn(), reminders: vi.fn(), overview: vi.fn(),
  companyLists: vi.fn(), companies: vi.fn(), company: vi.fn(), addCompany: vi.fn(), editCompany: vi.fn(), excludeCompany: vi.fn(), checkedCompany: vi.fn(), deleteCompany: vi.fn(), importCompanies: vi.fn(),
}));
vi.mock('../../services/api.ts', () => ({ sourcingApi: api }));
const auth = vi.hoisted(() => ({ persona: 'hr_recruiter' }));
vi.mock('../../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ user: { id: 'u1', persona: auth.persona }, canHR: true }), useCanHR: () => true }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import SourcingDetailPanel from './SourcingDetailPanel.tsx';
import SourcingOverview from './SourcingOverview.tsx';
import SourcingCompanies from './SourcingCompanies.tsx';

const detail = (over: Partial<PlanDetail> = {}): PlanDetail => ({
  plan_id: '10', plan_status: 'active', template: { key: 'tech', name: 'Tech role' }, job_titles: ['Platform engineer'], target_date: null,
  company_lists: [{ id: '1', name: 'Water – Bangalore', companies: 16 }],
  rows: [
    { id: '1', workbook_channel: 'Outbound', mapped_channels: ['Direct Outreach'], platform: 'LinkedIn', status: 'live', owner_label: 'Recruiter', tracked_as: 'count', weekly_work: 40, work_unit: 'New people messaged', expected_applicants: null, expected_qualified: 1, start_condition: null, first_task: null, repeats: null, reason: null },
    { id: '2', workbook_channel: 'Talent pool', mapped_channels: [], platform: null, status: 'live', owner_label: 'Recruiter', tracked_as: 'count', weekly_work: 15, work_unit: 'Re-contacted', expected_applicants: null, expected_qualified: 1, start_condition: null, first_task: null, repeats: null, reason: null },
    { id: '3', workbook_channel: 'Campus', mapped_channels: [], platform: null, status: 'not_used', owner_label: null, tracked_as: null, weekly_work: null, work_unit: null, expected_applicants: null, expected_qualified: null, start_condition: null, first_task: null, repeats: null, reason: 'Role needs 2–4 yrs' },
  ],
  suggested_channels: [], suggested_target: 3,
  health: {
    enough: { colour: 'red', text: '0 qualified this week (target 2) · 6 awaiting screening', qualified: 0, target: 2, awaiting_screening: 6 },
    right: { colour: 'grey', text: 'Too few to judge (8 of 20 candidates)', candidates: 8, qualified: 1, share: null },
    worked: { colour: 'red', text: '14 of 40 outbound: new people messaged · Job portal: answered No', items: [], share: 0.3 },
    source: { untagged: 6, total: 20, share: 0.3, untrusted: true },
  },
  channel_results: [{ channel: 'LinkedIn', candidates: 3, qualified: 0, share: null, too_few: true, last_activity: '2026-11-10' }],
  untagged_warning: true,
  outreach: { companies_listed: 32, companies_worked: 9, worked_share: 0.28, people_found: 41, people_contacted: 14, followups: 5, replied: 3, last_upload: '2026-11-13', by_title: [{ job_title: 'Site engineer', found: 20, contacted: 8, replied: 2 }] },
  checkin: { week_of: '2026-11-09', due: '2026-11-13', done: false, answers: {}, blocker_text: null, questions: ['post_refreshed', 'outreach_uploaded'] },
  reasons: [], ...over,
});

let qc: QueryClient;
function wrap(ui: React.ReactElement) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { Object.values(api).forEach(m => m.mockReset()); auth.persona = 'hr_recruiter'; });
afterEach(() => cleanup());

describe('SourcingDetailPanel', () => {
  it('shows the three health boxes, the untrusted-numbers warning and "too few to judge" per channel', async () => {
    api.detail.mockResolvedValue({ data: { enabled: true, detail: detail() } });
    wrap(<SourcingDetailPanel roleId="R3" canEdit />);
    const enough = await screen.findByTestId('health-Enough candidates?');
    expect(enough).toHaveTextContent('Behind'); expect(enough).toHaveTextContent('6 awaiting screening');
    expect(screen.getByTestId('health-Right candidates?')).toHaveTextContent('Too few to judge');
    expect(screen.getByTestId('health-Plan being worked?')).toHaveTextContent('answered No');
    expect(screen.getByTestId('untagged-warning')).toHaveTextContent('cannot be trusted');
    expect(within(screen.getByTestId('channel-results')).getByText('too few to judge')).toBeInTheDocument();
  });
  it('labels a supporting activity as not tracked automatically and shows the reason a line is not used', async () => {
    api.detail.mockResolvedValue({ data: { enabled: true, detail: detail() } });
    wrap(<SourcingDetailPanel roleId="R3" canEdit />);
    const lines = await screen.findByTestId('plan-lines');
    expect(within(lines).getByText('Direct Outreach')).toBeInTheDocument();
    expect(within(lines).getAllByText('not tracked automatically').length).toBeGreaterThanOrEqual(2);
    expect(within(lines).getByText('Role needs 2–4 yrs')).toBeInTheDocument();
  });
  it('saves a weekly check-in with the yes/no answers and the blocker', async () => {
    api.detail.mockResolvedValue({ data: { enabled: true, detail: detail() } });
    api.checkin.mockResolvedValue({ data: { ok: true } });
    wrap(<SourcingDetailPanel roleId="R3" canEdit />);
    const box = await screen.findByTestId('checkin-box');
    fireEvent.click(within(box).getAllByRole('radio', { name: 'No' })[0]);
    fireEvent.click(within(box).getAllByRole('radio', { name: 'Yes' })[1]);
    fireEvent.change(within(box).getByRole('textbox'), { target: { value: 'JD rewrite' } });
    fireEvent.click(within(box).getByRole('button', { name: /save check-in/i }));
    await waitFor(() => expect(api.checkin).toHaveBeenCalledWith('10', { week_start: '2026-11-09', answers: { post_refreshed: 'no', outreach_uploaded: 'yes' }, blocker_text: 'JD rewrite' }));
  });
  it('uploads the outreach sheet and says what was read and what was rejected', async () => {
    api.detail.mockResolvedValue({ data: { enabled: true, detail: detail() } });
    api.uploadOutreach.mockResolvedValue({ data: { ok: true, rows_total: 5, people_new: 3, followups: 1, merged: 0, rejected: [{ row: 5, reason: 'Unknown or closed role ID "R999"' }], rejected_total: 1, unlisted_companies: 1 } });
    wrap(<SourcingDetailPanel roleId="R3" canEdit />);
    const box = await screen.findByTestId('outreach-box');
    expect(screen.getByTestId('outreach-summary')).toHaveTextContent('41 people found · 14 contacted · 5 follow-ups · 3 replied');
    const file = new File(['Role ID,Company\nR3,X'], 'week.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('Role ID,Company\nR3,X') });
    fireEvent.change(within(box).getByTestId('outreach-file'), { target: { files: [file] } });
    const res = await screen.findByTestId('upload-result');
    expect(api.uploadOutreach).toHaveBeenCalledWith('Role ID,Company\nR3,X', 'week.csv');
    expect(res).toHaveTextContent('3 new people'); expect(res).toHaveTextContent('1 row not used');
  });
  it('a draft plan shows the pre-filled lines but no health boxes, and a read-only view cannot edit', async () => {
    api.detail.mockResolvedValue({ data: { enabled: true, detail: detail({ plan_status: 'draft', checkin: null }) } });
    wrap(<SourcingDetailPanel roleId="R3" canEdit={false} />);
    await screen.findByTestId('plan-lines');
    expect(screen.queryByTestId('health-Enough candidates?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByTestId('checkin-box')).toBeNull();
  });
  it('a line that is not used needs a reason before it can be saved', async () => {
    api.detail.mockResolvedValue({ data: { enabled: true, detail: detail({ plan_status: 'draft', checkin: null, rows: [] }) } });
    api.templates.mockResolvedValue({ data: { templates: [] } });
    wrap(<SourcingDetailPanel roleId="R3" canEdit />);
    const lines = await screen.findByTestId('plan-lines');
    fireEvent.click(within(lines).getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(lines).getByText('+ Add a line'));
    fireEvent.change(within(lines).getAllByRole('textbox').find(el => (el as HTMLInputElement).value === '' && el.closest('label')?.textContent?.startsWith('Channel'))!, { target: { value: 'Campus' } });
    fireEvent.change(within(lines).getByDisplayValue('Live'), { target: { value: 'not_used' } });
    expect(within(lines).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(lines).getByLabelText('Why is it not used?'), { target: { value: 'Senior role' } });
    expect(within(lines).getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});

const overview = (): OverviewResponse => ({
  enabled: true, summary: { roles_with_active_plan: 2, roles_total: 3, checkins_on_time: 3, checkins_due: 4, open_alerts: 5, hm_alerts: 1 },
  rows: [
    { role_id: 'R003', title: 'E&I Engineer', priority: 'P0', plan_status: 'active', hiring_manager: 'Arjun', enough: { colour: 'red', text: '0 of 2', qualified: 0, target: 2, awaiting_screening: 6 }, right: { colour: 'grey', text: 'few' }, worked: { colour: 'red', text: '14 of 40' }, open_alerts: 4, provisional_alerts: 2, hm_alerts: 1, headline: 'Not enough work done' },
    { role_id: 'R007', title: 'UX Designer', priority: 'P1', plan_status: 'active', hiring_manager: 'Alex', enough: { colour: 'green', text: 'ok', qualified: 3, target: 2, awaiting_screening: 0 }, right: { colour: 'amber', text: 'x' }, worked: { colour: 'green', text: 'ok' }, open_alerts: 0, provisional_alerts: 0, hm_alerts: 0, headline: null },
    { role_id: 'R016', title: 'Platform Engineer', priority: 'P2', plan_status: 'draft', hiring_manager: 'Mandeep Dagar, Piyush Negi', enough: null, right: null, worked: null, open_alerts: 1, provisional_alerts: 0, hm_alerts: 0, headline: 'Plan not activated' },
  ],
});

describe('SourcingOverview', () => {
  it('shows the four numbers and a row per role, with "Plan not activated" for a draft', async () => {
    api.overview.mockResolvedValue({ data: overview() });
    wrap(<SourcingOverview />);
    expect(await screen.findByText('2 of 3')).toBeInTheDocument();
    expect(screen.getByText('3 of 4')).toBeInTheDocument();
    expect(within(screen.getByTestId('overview-row-R016')).getByText('Plan not activated')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /R003 · E&I Engineer/ })).toHaveAttribute('href', '/sourcing?sourcing_role=R003');
  });
  it('filters by priority, hiring manager and colour', async () => {
    api.overview.mockResolvedValue({ data: overview() });
    wrap(<SourcingOverview />);
    await screen.findByTestId('overview-row-R003');
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'P1' } });
    expect(screen.queryByTestId('overview-row-R003')).toBeNull(); expect(screen.getByTestId('overview-row-R007')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: 'red' } });
    expect(screen.getByTestId('overview-row-R003')).toBeInTheDocument(); expect(screen.queryByTestId('overview-row-R007')).toBeNull();
  });
});

const company = (id: string, name: string) => ({ id, name, segment: 'EPC', size: 'Large', cities: ['Bangalore'], what_they_do: null, source_url: null, notes: null, excluded: false, excluded_reason: null,
  last_checked_at: '2026-01-01T00:00:00Z', needs_recheck: true, legacy_contacted: false, lists: ['Water – Bangalore'], roles_targeting: ['R003'], people_contacted: 12, people_found: 14, candidates: 2, last_contacted: '2026-11-03' });

describe('SourcingCompanies', () => {
  beforeEach(() => {
    api.companyLists.mockResolvedValue({ data: { lists: [{ id: '1', name: 'Water – Bangalore', companies: 2 }] } });
    api.companies.mockResolvedValue({ data: { companies: [company('1', 'VA Tech Wabag Ltd'), company('2', 'Thermax')], total: 2, recheck_count: 2 } });
  });
  it('lists one row per company with the system-filled numbers and flags a re-check', async () => {
    wrap(<SourcingCompanies />);
    const row = await screen.findByTestId('company-row-1');
    expect(row).toHaveTextContent('VA Tech Wabag Ltd'); expect(row).toHaveTextContent('R003'); expect(row).toHaveTextContent('12'); expect(row).toHaveTextContent('re-check');
  });
  it('imports a CSV and reports what was added and merged', async () => {
    api.importCompanies.mockResolvedValue({ data: { ok: true, companies_new: 5, companies_merged: 2, lists: 3, rejected: [], rejected_total: 0 } });
    wrap(<SourcingCompanies />);
    await screen.findByTestId('company-row-1');
    const file = new File(['x'], 'c.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('Company\nAcme') });
    fireEvent.change(screen.getByTestId('company-file'), { target: { files: [file] } });
    await waitFor(() => expect(api.importCompanies).toHaveBeenCalledWith('Company\nAcme'));
  });
  it('only the HR lead (Leadership / Super Admin) is offered Delete', async () => {
    api.company.mockResolvedValue({ data: { company: { ...company('1', 'VA Tech Wabag Ltd'), outreach_by_role: [], hires: 0, recent_people: [] } } });
    wrap(<SourcingCompanies />);
    fireEvent.click(await screen.findByTestId('company-row-1'));
    await screen.findByTestId('company-page');
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    cleanup(); auth.persona = 'leadership';
    wrap(<SourcingCompanies />);
    fireEvent.click(await screen.findByTestId('company-row-1'));
    await screen.findByTestId('company-page');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });
});
