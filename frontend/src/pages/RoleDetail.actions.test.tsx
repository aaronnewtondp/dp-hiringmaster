import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ROLE_STATUSES, STAGES } from '../types/index.ts';

// RoleDetail apart from its Sourcing plan (RoleDetail.sourcing.test.tsx has that): who may approve, change the status of, discard or
// regenerate the JD of a role, what a Hiring Manager is never shown (the CTC band, the benchmark panel), the toasts each outcome of a
// status change / JD generation / save makes, the 10-second poll while the JD is being generated, the closure-summary download, and the
// plain read-only parts (header, pipeline, approval card, activity). The persona is hoisted so each test can switch it; the flags are
// derived the way AuthContext derives them (hr_recruiter, leadership and super_admin are HR-tier).
const rolesGet = vi.fn();
const rolesUpdate = vi.fn();
const rolesRemove = vi.fn();
const regenerateJd = vi.fn();
const closureSummaryPdf = vi.fn();
const pipeline = vi.fn();
const activity = vi.fn();
const plan = vi.fn();
vi.mock('../services/api.ts', () => ({
  rolesApi: {
    get: (id: string) => rolesGet(id),
    update: (id: string, d: Record<string, unknown>) => rolesUpdate(id, d),
    remove: (id: string) => rolesRemove(id),
    regenerateJd: (id: string) => regenerateJd(id),
    closureSummaryPdf: (id: string) => closureSummaryPdf(id),
    pipeline: (id: string) => pipeline(id),
    activity: (id: string) => activity(id),
  },
  sourcingApi: { plan: (id: string) => plan(id), people: async () => ({ data: { people: [] } }) },
}));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('../components/CompBenchmarkPanel.tsx', () => ({
  default: ({ roleId }: { roleId: string }) => <div data-testid="comp-benchmark" data-role-id={roleId} />,
}));

const auth = vi.hoisted(() => ({ persona: 'hr_recruiter' as string, name: 'Test Person' }));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => {
    const p = auth.persona;
    const isSuperAdmin = p === 'super_admin';
    return {
      user: { id: 'u-test', name: auth.name, email: 'test.person@example.test', persona: p },
      canHR: p === 'hr_recruiter' || p === 'leadership' || isSuperAdmin,
      canLead: p === 'leadership' || isSuperAdmin,
      isSuperAdmin,
    };
  },
}));

import RoleDetail from './RoleDetail.tsx';

const ID = 'R9001';
const TITLE = 'Test Role Alpha';
const HR_TIER = ['hr_recruiter', 'leadership', 'super_admin'];

const role = (over: Record<string, unknown> = {}) => ({
  id: ID, title: TITLE, department: 'Tech/Devs', hiring_manager_name: 'Hana Manager', priority: 'P1', status: 'Live – Sourcing',
  location: 'Pune', employment_type: 'Contract', num_openings: 2, recruitment_mode: ['LinkedIn'], assignment_required: false,
  new_or_replacement: 'New Position', vacancy_reason: [], yoe_required: '3-5 years', qualification_required: 'Any degree', ctc_band: '10–12 LPA',
  must_have_skills: 'Skill One', nice_to_have_skills: 'Skill Two', job_description: 'A description', kpi_expectations: 'A KPI', additional_remarks: 'A remark',
  jd_drive_link: 'https://drive.example.test/long-form', social_jd_drive_link: 'https://drive.example.test/social', jd_source: 'generated',
  approver_name: null, approval_date: null, approval_note: null, start_date: null, target_closure_date: null, approval_summary_link: null,
  days_open: 5, days_overdue: 0, aging_alert: 'green', ...over,
});
const app = (id: string, over: Record<string, unknown> = {}) => ({
  id, candidate_id: `C${id.slice(1)}`, candidate_name: `Test Candidate ${id}`, source_channel: 'LinkedIn', ai_fit_score: 82,
  recruiter_screening_status: 'New', sla_breach: false, ...over,
});

let serverRole: ReturnType<typeof role>;
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

const live: Array<() => void> = [];
// A second mount in the same test needs the first one gone (two copies of the page would answer every query twice).
const cleanupMount = () => { while (live.length) live.pop()!(); };
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/roles/${ID}`]}>
        <Routes>
          <Route path="/roles/:id" element={<RoleDetail />} />
          <Route path="/roles" element={<div data-testid="roles-list" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  live.push(view.unmount);
  return view;
}
const pageReady = () => screen.findByRole('heading', { level: 1, name: TITLE });
const button = (name: string) => screen.queryByRole('button', { name });
const section = (title: string) => screen.getByRole('heading', { level: 2, name: title }).closest('.card') as HTMLElement;
const lastToast = (fn: unknown) => { const calls = (fn as { mock: { calls: unknown[][] } }).mock.calls; return calls[calls.length - 1]?.[0]; };
// An error the way axios hands it over: the server's own message sits in response.data.error.
const serverError = (message?: string) => Object.assign(new Error('Request failed'), { response: message ? { data: { error: message } } : undefined });

beforeEach(() => {
  live.length = 0;
  for (const m of [rolesGet, rolesUpdate, rolesRemove, regenerateJd, closureSummaryPdf, pipeline, activity, plan]) m.mockReset();
  for (const m of [toast, toast.success, toast.error]) vi.mocked(m).mockReset();
  sessionStorage.clear();
  auth.persona = 'hr_recruiter';
  auth.name = 'Test Person';
  serverRole = role();
  rolesGet.mockImplementation(async () => ({ data: { role: serverRole } }));
  rolesUpdate.mockImplementation(async () => ({ data: { role: serverRole } }));
  pipeline.mockResolvedValue({ data: { pipeline: {}, total: 0 } });
  activity.mockResolvedValue({ data: { activity: [] } });
  plan.mockResolvedValue({ data: { enabled: false } });
});
afterEach(() => { vi.useRealTimers(); });

describe('RoleDetail — who gets which control', () => {
  it.each(HR_TIER.map(p => [p]))('%s on a Draft role: Change status, Approve Role, Discard role, the CTC Band and the comp benchmark panel', async (persona) => {
    auth.persona = persona;
    serverRole = role({ status: 'Draft' });
    mount();
    await pageReady();
    expect(button('Change status')).not.toBeNull();
    expect(button('Approve Role')).not.toBeNull();
    expect(button('Discard role')).not.toBeNull();
    expect(screen.getByText('CTC Band')).toBeInTheDocument();
    expect(screen.getByTestId('comp-benchmark')).toHaveAttribute('data-role-id', ID);
  });

  it('a Hiring Manager gets none of them on a Draft role: no Change status, no Approve Role, no Discard role, no CTC Band, no comp benchmark panel', async () => {
    auth.persona = 'hiring_manager';
    serverRole = role({ status: 'Draft' });
    mount();
    await pageReady();
    expect(button('Change status')).toBeNull();
    expect(button('Approve Role')).toBeNull();
    expect(button('Discard role')).toBeNull();
    expect(screen.queryByText('CTC Band')).toBeNull();
    expect(screen.queryByTestId('comp-benchmark')).toBeNull();
  });

  it('a Hiring Manager cannot approve a role, not even their own: named on a Draft and an Under Review role, they still get no Approve Role', async () => {
    auth.persona = 'hiring_manager';
    auth.name = 'Hana Manager';
    for (const status of ['Draft', 'Under Review']) {
      serverRole = role({ status, hiring_manager_name: 'Hana Manager' });
      const { unmount } = mount();
      await pageReady();
      expect(screen.getAllByText('Hana Manager').length, status).toBeGreaterThan(0);        // it is their role: the name is on the page
      expect(button('Approve Role'), status).toBeNull();
      expect(button('Discard role'), status).toBeNull();
      expect(button('Change status'), status).toBeNull();
      unmount();
    }
  });

  it('a co-Hiring-Manager ("Hana Manager, Ivan Lead") cannot approve either', async () => {
    auth.persona = 'hiring_manager';
    auth.name = 'Ivan Lead';
    serverRole = role({ status: 'Under Review', hiring_manager_name: 'Hana Manager, Ivan Lead' });
    mount();
    await pageReady();
    expect(button('Approve Role')).toBeNull();
  });

  it('Approve Role is only for a role that is a Draft or Under Review; Discard role only for a Draft', async () => {
    const expectations: Array<[string, boolean, boolean]> = [
      ['Draft', true, true], ['Under Review', true, false], ['Approved', false, false], ['Live – Sourcing', false, false],
      ['On Hold', false, false], ['Closed – Filled', false, false], ['Closed – Cancelled', false, false],
    ];
    expect(expectations.map(e => e[0])).toEqual(ROLE_STATUSES);                       // every status is looked at
    for (const [status, approve, discard] of expectations) {
      serverRole = role({ status });
      const { unmount } = mount();
      await pageReady();
      expect(button('Approve Role') !== null, `Approve Role on ${status}`).toBe(approve);
      expect(button('Discard role') !== null, `Discard role on ${status}`).toBe(discard);
      unmount();
    }
  });

  it('Download Closure Summary is for HR-tier on a role that is Closed – Filled or Closed – Cancelled, and for nobody else', async () => {
    for (const [persona, status, shown] of [
      ['hr_recruiter', 'Closed – Filled', true], ['leadership', 'Closed – Cancelled', true], ['super_admin', 'Closed – Filled', true],
      ['hr_recruiter', 'Live – Sourcing', false], ['hr_recruiter', 'Approved', false], ['hr_recruiter', 'On Hold', false],
      ['hiring_manager', 'Closed – Filled', false], ['hiring_manager', 'Closed – Cancelled', false],
    ] as Array<[string, string, boolean]>) {
      auth.persona = persona;
      serverRole = role({ status });
      const { unmount } = mount();
      await pageReady();
      expect(button('Download Closure Summary') !== null, `${persona} on ${status}`).toBe(shown);
      unmount();
    }
  });

  it('Regenerate JD is for HR-tier on an Approved role that has a long-form JD it generated itself, and for nobody else', async () => {
    for (const [persona, over, shown] of [
      ['hr_recruiter', { status: 'Approved' }, true],
      ['leadership', { status: 'Approved' }, true],
      ['super_admin', { status: 'Approved' }, true],
      ['hiring_manager', { status: 'Approved' }, false],
      ['hr_recruiter', { status: 'Live – Sourcing' }, false],                       // once the role moves on it cannot be regenerated here
      ['hr_recruiter', { status: 'Approved', jd_drive_link: null, social_jd_drive_link: null }, false],   // nothing generated yet
      ['hr_recruiter', { status: 'Approved', jd_source: 'manual' }, false],
    ] as Array<[string, Record<string, unknown>, boolean]>) {
      auth.persona = persona;
      serverRole = role(over);
      const { unmount } = mount();
      await pageReady();
      expect(button('Regenerate JD') !== null, `${persona} ${JSON.stringify(over)}`).toBe(shown);
      unmount();
    }
  });

  it('a Hiring Manager still sees the role itself: the header, the pipeline and the sections', async () => {
    auth.persona = 'hiring_manager';
    mount();
    await pageReady();
    for (const title of ['Basic Info', 'Requirements', 'Description', 'Dates', 'Approval', 'Links & Assets', 'Pipeline', 'Activity timeline']) {
      expect(screen.getByRole('heading', { name: title }), title).toBeInTheDocument();
    }
  });
});

describe('RoleDetail — compensation is HR-tier only', () => {
  it('HR-tier sees the CTC Band and its value; a Hiring Manager sees neither the label nor the figure anywhere on the page', async () => {
    mount();
    await pageReady();
    expect(within(section('Requirements')).getByText('CTC Band')).toBeInTheDocument();
    expect(within(section('Requirements')).getByText('10–12 LPA')).toBeInTheDocument();
    cleanupMount();

    auth.persona = 'hiring_manager';
    mount();
    await pageReady();
    expect(screen.queryByText('CTC Band')).toBeNull();
    expect(screen.queryByText('10–12 LPA')).toBeNull();
    expect(document.body.textContent).not.toContain('10–12');
  });

  it('a Hiring Manager editing the Requirements is not offered the CTC Band and never sends one', async () => {
    auth.persona = 'hiring_manager';
    mount();
    await pageReady();
    fireEvent.click(screen.getByTitle('Edit Requirements'));
    expect(screen.queryByText('CTC Band')).toBeNull();
    expect(screen.queryByDisplayValue('10–12 LPA')).toBeNull();
    fireEvent.change(screen.getByDisplayValue('3-5 years'), { target: { value: '4-6 years' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rolesUpdate).toHaveBeenCalledTimes(1));
    expect(rolesUpdate).toHaveBeenCalledWith(ID, { yoe_required: '4-6 years' });
  });

  it('HR-tier editing the CTC Band sends it, and only it', async () => {
    mount();
    await pageReady();
    fireEvent.click(screen.getByTitle('Edit Requirements'));
    fireEvent.change(screen.getByDisplayValue('10–12 LPA'), { target: { value: '12–15 LPA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rolesUpdate).toHaveBeenCalledWith(ID, { ctc_band: '12–15 LPA' }));
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Requirements updated');
  });
});

describe('RoleDetail — approving a role', () => {
  beforeEach(() => { serverRole = role({ status: 'Under Review' }); });

  it('sends status Approved and nothing else, says "Role approved", and re-reads the role, its activity and its sourcing plan', async () => {
    rolesUpdate.mockImplementation(async () => { serverRole = role({ status: 'Approved' }); return { data: { role: serverRole } }; });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Role' }));
    await waitFor(() => expect(rolesUpdate).toHaveBeenCalledTimes(1));
    expect(rolesUpdate).toHaveBeenCalledWith(ID, { status: 'Approved' });
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Role approved'));

    await waitFor(() => expect(rolesGet.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(activity.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(plan.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(rolesGet).toHaveBeenCalledWith(ID);
    expect(activity).toHaveBeenCalledWith(ID);
    expect(plan).toHaveBeenCalledWith(ID);
    // the re-read role is Approved, so the button is gone
    await waitFor(() => expect(button('Approve Role')).toBeNull());
  });

  it('while it is being saved the button says "Approving…", is disabled and cannot send a second request', async () => {
    const d = deferred<{ data: unknown }>();
    rolesUpdate.mockReturnValue(d.promise);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Role' }));
    const busy = await screen.findByRole('button', { name: 'Approving…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(rolesUpdate).toHaveBeenCalledTimes(1);
    await act(async () => { d.resolve({ data: { role: serverRole } }); });
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Role approved'));
  });

  it('shows the server\'s own reason when it refuses, and a generic message when it gives none; the role is not re-read', async () => {
    rolesUpdate.mockImplementationOnce(async () => { throw serverError('Only HR can approve a role'); });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Role' }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Only HR can approve a role'));
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(button('Approve Role')).not.toBeDisabled();                              // it can be tried again

    rolesUpdate.mockImplementationOnce(async () => { throw serverError(); });
    fireEvent.click(screen.getByRole('button', { name: 'Approve Role' }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenLastCalledWith('Failed to approve role'));
    expect(rolesGet).toHaveBeenCalledTimes(1);
  });
});

describe('RoleDetail — changing the status', () => {
  const openModal = async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Change status' }));
    return screen.getByRole('combobox') as HTMLSelectElement;
  };
  const choose = (select: HTMLSelectElement, status: string) => fireEvent.change(select, { target: { value: status } });
  const update = () => fireEvent.click(screen.getByRole('button', { name: 'Update' }));

  it('opens on the role\'s current status and offers every status there is, in the pipeline\'s own order', async () => {
    serverRole = role({ status: 'On Hold' });
    const select = await openModal();
    expect(screen.getByRole('heading', { name: 'Update status' })).toBeInTheDocument();
    expect(select.value).toBe('On Hold');
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(ROLE_STATUSES);
  });

  it('Cancel closes it and sends nothing', async () => {
    await openModal();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Update status' })).toBeNull();
    expect(rolesUpdate).not.toHaveBeenCalled();
  });

  it('sends the chosen status, says "Status updated to <status>", closes, and re-reads the role and its sourcing plan', async () => {
    const select = await openModal();
    choose(select, 'On Hold');
    update();
    await waitFor(() => expect(rolesUpdate).toHaveBeenCalledWith(ID, { status: 'On Hold' }));
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Status updated to On Hold'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Update status' })).toBeNull());
    await waitFor(() => expect(rolesGet.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(plan.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it('while it is being saved the button says "Saving…" and is disabled', async () => {
    const d = deferred<{ data: unknown }>();
    rolesUpdate.mockReturnValue(d.promise);
    const select = await openModal();
    choose(select, 'On Hold');
    update();
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
    await act(async () => { d.resolve({ data: {} }); });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Update status' })).toBeNull());
  });

  it('a failed update says "Failed to update status" and leaves the window open, with nothing re-read', async () => {
    rolesUpdate.mockImplementation(async () => { throw serverError('nope'); });
    const select = await openModal();
    choose(select, 'On Hold');
    update();
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to update status'));
    expect(screen.getByRole('heading', { name: 'Update status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update' })).not.toBeDisabled();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(rolesGet).toHaveBeenCalledTimes(1);
  });

  describe('the JD generation that an approval through this window carries', () => {
    beforeEach(() => { serverRole = role({ status: 'Draft', jd_drive_link: null, social_jd_drive_link: null }); });
    const approveThroughWindow = async (response: unknown) => {
      rolesUpdate.mockResolvedValue({ data: response });
      const select = await openModal();
      choose(select, 'Approved');
      update();
      await waitFor(() => expect(rolesUpdate).toHaveBeenCalledWith(ID, { status: 'Approved' }));
      await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Status updated to Approved'));
    };

    it('jdGeneration.generated: a second success message says both JDs were generated', async () => {
      await approveThroughWindow({ jdGeneration: { generated: true } });
      expect(vi.mocked(toast.success).mock.calls.map(c => c[0])).toEqual(['Status updated to Approved', 'Long-form and social JDs generated']);
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    });

    it('jdGeneration that did not generate: an error message carries the server\'s reason, after the success of the status change itself', async () => {
      await approveThroughWindow({ jdGeneration: { generated: false, error: 'Drive quota exceeded' } });
      expect(vi.mocked(toast.success).mock.calls.map(c => c[0])).toEqual(['Status updated to Approved']);
      expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('JD generation failed: Drive quota exceeded');
    });

    it('no jdGeneration at all (any other status change): no message about JDs, good or bad', async () => {
      await approveThroughWindow({ role: serverRole });
      expect(vi.mocked(toast.success).mock.calls.map(c => c[0])).toEqual(['Status updated to Approved']);
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    });
  });
});

describe('RoleDetail — regenerating the JD', () => {
  beforeEach(() => { serverRole = role({ status: 'Approved' }); });
  const regenerate = async () => { mount(); fireEvent.click(await screen.findByRole('button', { name: 'Regenerate JD' })); };

  it('asks for this role\'s JD, says both were regenerated, and re-reads the role so the new links show', async () => {
    regenerateJd.mockResolvedValue({ data: { jdGeneration: { generated: true } } });
    await regenerate();
    await waitFor(() => expect(regenerateJd).toHaveBeenCalledWith(ID));
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Long-form and social JDs regenerated'));
    await waitFor(() => expect(rolesGet.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it('a generation that failed says why: "JD regeneration failed: <reason>"', async () => {
    regenerateJd.mockResolvedValue({ data: { jdGeneration: { generated: false, error: 'Model overloaded' } } });
    await regenerate();
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('JD regeneration failed: Model overloaded'));
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    await waitFor(() => expect(rolesGet.mock.calls.length).toBeGreaterThanOrEqual(2));      // still re-read: the old links may have been replaced
  });

  it('an answer with no jdGeneration is a failure with reason "Unknown error", never a success', async () => {
    regenerateJd.mockResolvedValue({ data: {} });
    await regenerate();
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('JD regeneration failed: Unknown error'));
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it('a request that is refused shows the server\'s own message, or "Failed to regenerate JD" when it gave none', async () => {
    regenerateJd.mockImplementationOnce(async () => { throw serverError('Manual JDs cannot be regenerated'); });
    await regenerate();
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Manual JDs cannot be regenerated'));
    regenerateJd.mockImplementationOnce(async () => { throw serverError(); });
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate JD' }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenLastCalledWith('Failed to regenerate JD'));
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it('while it runs the button says "Regenerating…", is disabled and cannot send a second request', async () => {
    const d = deferred<{ data: unknown }>();
    regenerateJd.mockReturnValue(d.promise);
    await regenerate();
    const busy = await screen.findByRole('button', { name: 'Regenerating…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(regenerateJd).toHaveBeenCalledTimes(1);
    await act(async () => { d.resolve({ data: { jdGeneration: { generated: true } } }); });
    await waitFor(() => expect(button('Regenerate JD')).not.toBeDisabled());
  });
});

describe('RoleDetail — Links & Assets', () => {
  it('a role whose JD was written outside HMS says so and has no Regenerate JD; a generated one says nothing', async () => {
    serverRole = role({ status: 'Approved', jd_source: 'manual' });
    mount();
    await pageReady();
    expect(screen.getByText(/manually provided/)).toBeInTheDocument();
    expect(button('Regenerate JD')).toBeNull();
    cleanupMount();

    serverRole = role({ status: 'Approved', jd_source: 'generated' });
    mount();
    await pageReady();
    expect(screen.queryByText(/manually provided/)).toBeNull();
  });

  it('an Approved role with no links yet says the JDs are being generated, in place of the links, and offers no Regenerate JD', async () => {
    serverRole = role({ status: 'Approved', jd_drive_link: null, social_jd_drive_link: null });
    mount();
    await pageReady();
    expect(screen.getByText('Generating JD…')).toBeInTheDocument();
    expect(screen.getByText('Generating social JD…')).toBeInTheDocument();
    expect(button('Regenerate JD')).toBeNull();
  });

  it('a role that is not Approved and has no links shows plain dashes, not a spinner that would never finish', async () => {
    serverRole = role({ status: 'Live – Sourcing', jd_drive_link: null, social_jd_drive_link: null });
    mount();
    await pageReady();
    expect(screen.queryByText('Generating JD…')).toBeNull();
    expect(screen.queryByText('Generating social JD…')).toBeNull();
    const links = section('Links & Assets');
    expect(within(links).getAllByText('—')).toHaveLength(3);
  });

  it('shows each link that exists as an external link to exactly that address', async () => {
    serverRole = role({ status: 'Live – Sourcing', approval_summary_link: 'https://drive.example.test/brief' });
    mount();
    await pageReady();
    const links = within(section('Links & Assets'));
    for (const url of ['https://drive.example.test/long-form', 'https://drive.example.test/social', 'https://drive.example.test/brief']) {
      const a = links.getByRole('link', { name: url });
      expect(a).toHaveAttribute('href', url);
      expect(a).toHaveAttribute('target', '_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
    }
  });
});

describe('RoleDetail — the 10-second poll while the JD is being generated', () => {
  // refetchInterval is a plain setInterval inside react-query; only the interval timers are faked so nothing else waits on a clock.
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it('re-reads the role every 10 seconds while it is Approved with no JD link, and not before', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    serverRole = role({ status: 'Approved', jd_drive_link: null, social_jd_drive_link: null });
    mount();
    await pageReady();
    expect(rolesGet).toHaveBeenCalledTimes(1);
    await advance(9_999);
    expect(rolesGet).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(rolesGet).toHaveBeenCalledTimes(2);
    await advance(10_000);
    expect(rolesGet).toHaveBeenCalledTimes(3);
  });

  it('stops for good once the long-form JD link has appeared, and the link shows in place of "Generating JD…"', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    serverRole = role({ status: 'Approved', jd_drive_link: null, social_jd_drive_link: null });
    mount();
    await pageReady();
    expect(screen.getByText('Generating JD…')).toBeInTheDocument();
    serverRole = role({ status: 'Approved', jd_drive_link: 'https://drive.example.test/new-long-form', social_jd_drive_link: null });
    await advance(10_000);
    expect(rolesGet).toHaveBeenCalledTimes(2);
    // react-query hands the new data to the page on a real macrotask, which the faked interval clock does not drive
    expect(await screen.findByRole('link', { name: 'https://drive.example.test/new-long-form' })).toBeInTheDocument();
    expect(screen.queryByText('Generating JD…')).toBeNull();
    await advance(60_000);
    expect(rolesGet).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an Approved role that already has its JD', { status: 'Approved' }],
    ['a Live – Sourcing role without one', { status: 'Live – Sourcing', jd_drive_link: null }],
    ['a Draft role without one', { status: 'Draft', jd_drive_link: null }],
  ] as Array<[string, Record<string, unknown>]>)('does not poll for %s', async (_label, over) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    serverRole = role(over);
    mount();
    await pageReady();
    await advance(60_000);
    expect(rolesGet).toHaveBeenCalledTimes(1);
  });
});

describe('RoleDetail — discarding a Draft role', () => {
  beforeEach(() => { serverRole = role({ status: 'Draft' }); });
  const openModal = async () => { mount(); fireEvent.click(await screen.findByRole('button', { name: 'Discard role' })); };

  it('asks first, naming the role, and Cancel closes the window without deleting anything', async () => {
    await openModal();
    expect(screen.getByRole('heading', { name: `Discard ${TITLE}?` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: `Discard ${TITLE}?` })).toBeNull();
    expect(rolesRemove).not.toHaveBeenCalled();
  });

  it('on confirm deletes this role, says "Role discarded" and goes back to the Roles list', async () => {
    rolesRemove.mockResolvedValue({ data: {} });
    await openModal();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(rolesRemove).toHaveBeenCalledWith(ID));
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Role discarded'));
    expect(await screen.findByTestId('roles-list')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: TITLE })).toBeNull();
  });

  it('a refusal shows the server\'s reason (or "Failed to discard role"), keeps the window open and stays on the role', async () => {
    rolesRemove.mockImplementationOnce(async () => { throw serverError('This role has applications'); });
    await openModal();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('This role has applications'));
    expect(screen.getByRole('heading', { name: `Discard ${TITLE}?` })).toBeInTheDocument();
    expect(screen.queryByTestId('roles-list')).toBeNull();
    expect(screen.getByRole('button', { name: 'Discard' })).not.toBeDisabled();             // it can be tried again

    rolesRemove.mockImplementationOnce(async () => { throw serverError(); });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenLastCalledWith('Failed to discard role'));
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it('while it is being deleted the button says "Discarding…" and is disabled', async () => {
    const d = deferred<{ data: unknown }>();
    rolesRemove.mockReturnValue(d.promise);
    await openModal();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    const busy = await screen.findByRole('button', { name: 'Discarding…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(rolesRemove).toHaveBeenCalledTimes(1);
    await act(async () => { d.resolve({ data: {} }); });
    expect(await screen.findByTestId('roles-list')).toBeInTheDocument();
  });
});

describe('RoleDetail — the closure summary download', () => {
  type Created = { href: string; download: string };
  const events: string[] = [];
  const clicked: Created[] = [];
  const original = { create: (URL as unknown as Record<string, unknown>).createObjectURL, revoke: (URL as unknown as Record<string, unknown>).revokeObjectURL };
  let clickSpy: ReturnType<typeof vi.spyOn>;
  const createObjectURL = vi.fn();
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    events.length = 0; clicked.length = 0;
    createObjectURL.mockReset(); revokeObjectURL.mockReset();
    createObjectURL.mockImplementation(() => { events.push('create'); return 'blob:closure-1'; });
    revokeObjectURL.mockImplementation(() => { events.push('revoke'); });
    // jsdom has neither function, and an anchor click on a blob address would try to navigate
    (URL as unknown as Record<string, unknown>).createObjectURL = createObjectURL;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = revokeObjectURL;
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      events.push('click'); clicked.push({ href: this.href, download: this.download });
    });
    serverRole = role({ status: 'Closed – Filled' });
  });
  afterEach(() => {
    clickSpy.mockRestore();
    (URL as unknown as Record<string, unknown>).createObjectURL = original.create;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = original.revoke;
  });

  it('asks for this role\'s PDF and hands it to the browser as a file named <id>-closure-summary.pdf, then lets the address go', async () => {
    const blob = new Blob(['%PDF-1.4 test'], { type: 'application/pdf' });
    closureSummaryPdf.mockResolvedValue({ data: blob });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Download Closure Summary' }));
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:closure-1'));
    expect(closureSummaryPdf).toHaveBeenCalledWith(ID);
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual([{ href: 'blob:closure-1', download: `${ID}-closure-summary.pdf` }]);
    expect(events).toEqual(['create', 'click', 'revoke']);
    expect(document.querySelector('a[download]')).toBeNull();                               // the temporary link is removed again
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it('works for a role that was Closed – Cancelled too', async () => {
    serverRole = role({ status: 'Closed – Cancelled' });
    closureSummaryPdf.mockResolvedValue({ data: new Blob(['x']) });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Download Closure Summary' }));
    await waitFor(() => expect(clicked).toHaveLength(1));
  });

  it('a failure says "Failed to generate closure summary" and downloads nothing', async () => {
    closureSummaryPdf.mockImplementation(async () => { throw new Error('500'); });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Download Closure Summary' }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to generate closure summary'));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clicked).toEqual([]);
    expect(button('Download Closure Summary')).not.toBeDisabled();
  });

  it('while it is being made the button says "Generating…", is disabled and cannot start a second one', async () => {
    const d = deferred<{ data: Blob }>();
    closureSummaryPdf.mockReturnValue(d.promise);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Download Closure Summary' }));
    const busy = await screen.findByRole('button', { name: 'Generating…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(closureSummaryPdf).toHaveBeenCalledTimes(1);
    await act(async () => { d.resolve({ data: new Blob(['x']) }); });
    await waitFor(() => expect(clicked).toHaveLength(1));
  });
});

describe('RoleDetail — the Hiring Manager field and users who do not exist', () => {
  const saveHiringManagers = async (value: string, response: unknown) => {
    rolesUpdate.mockResolvedValue({ data: response });
    mount();
    await pageReady();
    fireEvent.click(screen.getByTitle('Edit Basic Info'));
    fireEvent.change(screen.getByDisplayValue('Hana Manager'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rolesUpdate).toHaveBeenCalledWith(ID, { hiring_manager_name: value }));
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Basic Info updated'));
  };

  it('a name no HMS user has is saved, with a warning that names it and says how long it stays up', async () => {
    await saveHiringManagers('Hana Manager, Zed Nobody', { role: serverRole, unmatched_hiring_managers: ['Zed Nobody'] });
    expect(vi.mocked(toast)).toHaveBeenCalledTimes(1);
    const [message, options] = vi.mocked(toast).mock.calls[0] as unknown as [string, { duration: number }];
    expect(message).toContain('No HMS user is named Zed Nobody');
    expect(message).toMatch(/^Saved\./);
    expect(options.duration).toBeGreaterThanOrEqual(5000);                                  // long enough to be read
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it('several unmatched names are all named, in the order the server gave them', async () => {
    await saveHiringManagers('Hana Manager, Zed Nobody, Yan Ghost', { role: serverRole, unmatched_hiring_managers: ['Zed Nobody', 'Yan Ghost'] });
    expect(vi.mocked(toast)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast).mock.calls[0][0]).toContain('Zed Nobody, Yan Ghost');
  });

  it('every name matched (an empty list) or a server that does not say: no warning at all', async () => {
    await saveHiringManagers('Hana Manager, Ivan Lead', { role: serverRole, unmatched_hiring_managers: [] });
    expect(vi.mocked(toast)).not.toHaveBeenCalled();
    cleanupMount();
    rolesUpdate.mockReset();
    vi.mocked(toast.success).mockReset();
    await saveHiringManagers('Ivan Lead', { role: serverRole });
    expect(vi.mocked(toast)).not.toHaveBeenCalled();
  });

  it('the warning belongs to every save of the role, not only Basic Info\'s: it follows a save of another section too', async () => {
    rolesUpdate.mockResolvedValue({ data: { role: serverRole, unmatched_hiring_managers: ['Zed Nobody'] } });
    mount();
    await pageReady();
    fireEvent.click(screen.getByTitle('Edit Description'));
    fireEvent.change(screen.getByDisplayValue('A KPI'), { target: { value: 'A better KPI' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rolesUpdate).toHaveBeenCalledWith(ID, { kpi_expectations: 'A better KPI' }));
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledTimes(1));
  });

  it('the field says how to name several people', async () => {
    mount();
    await pageReady();
    fireEvent.click(screen.getByTitle('Edit Basic Info'));
    expect(screen.getByText(/Separate them with a comma/)).toBeInTheDocument();
  });
});

describe('RoleDetail — the approval card', () => {
  it('shows the approver and the approval date (the date part only), and dashes while there is neither', async () => {
    mount();
    await pageReady();
    const card = within(section('Approval'));
    expect(card.getAllByText('—')).toHaveLength(3);                                          // approver, date, note
    cleanupMount();

    serverRole = role({ approver_name: 'Ivan Lead', approval_date: '2026-10-12T08:30:00.000Z', approval_note: 'Approved for Q4' });
    mount();
    await pageReady();
    const filled = within(section('Approval'));
    expect(filled.getByText('Ivan Lead')).toBeInTheDocument();
    expect(filled.getByText('2026-10-12')).toBeInTheDocument();
    expect(filled.getByText('Approved for Q4')).toBeInTheDocument();
  });

  it('the note is edited in place: Save sends approval_note and closes the editor, Cancel throws the draft away', async () => {
    serverRole = role({ approval_note: 'Old note' });
    mount();
    await pageReady();
    fireEvent.click(screen.getByTitle('Edit Approval Note'));
    fireEvent.change(screen.getByDisplayValue('Old note'), { target: { value: 'New note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(rolesUpdate).not.toHaveBeenCalled();
    expect(screen.getByText('Old note')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Edit Approval Note'));
    expect(screen.getByDisplayValue('Old note')).toBeInTheDocument();                         // opens on the saved note again, not the discarded draft
    fireEvent.change(screen.getByDisplayValue('Old note'), { target: { value: 'New note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rolesUpdate).toHaveBeenCalledWith(ID, { approval_note: 'New note' }));
    await waitFor(() => expect(screen.queryByDisplayValue('New note')).toBeNull());
  });

  it('a note that cannot be saved says "Failed to save note" and keeps the editor open with what was typed', async () => {
    rolesUpdate.mockImplementation(async () => { throw serverError('nope'); });
    mount();
    await pageReady();
    fireEvent.click(screen.getByTitle('Edit Approval Note'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Typed note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to save note'));
    expect(screen.getByDisplayValue('Typed note')).toBeInTheDocument();
  });
});

describe('RoleDetail — saving a section', () => {
  it('sends only what changed, says "<Section> updated" and re-reads the role', async () => {
    mount();
    await pageReady();
    fireEvent.click(screen.getByTitle('Edit Basic Info'));
    fireEvent.change(screen.getByDisplayValue(TITLE), { target: { value: 'Renamed Role' } });
    fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rolesUpdate).toHaveBeenCalledTimes(1));
    expect(rolesUpdate).toHaveBeenCalledWith(ID, { title: 'Renamed Role', num_openings: 3 });
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Basic Info updated'));
    await waitFor(() => expect(rolesGet.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('a save the server refuses says "Failed to update <Section>" and keeps the section in edit mode', async () => {
    rolesUpdate.mockImplementation(async () => { throw serverError('nope'); });
    mount();
    await pageReady();
    fireEvent.click(screen.getByTitle('Edit Dates'));
    fireEvent.change(screen.getByDisplayValue(''), { target: { value: '2026-12-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to update Dates'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('the Open Date is shown but never editable: the server sets it when the role is approved', async () => {
    serverRole = role({ start_date: '2026-10-01T00:00:00.000Z' });
    mount();
    await pageReady();
    expect(within(section('Dates')).getByText('2026-10-01')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Edit Dates'));
    expect(screen.getAllByText('Open Date').length).toBeGreaterThan(0);
    // the one input is the Close Target; the Open Date is plain text
    expect(within(section('Dates')).getAllByDisplayValue('')).toHaveLength(1);
    expect(within(section('Dates')).queryByDisplayValue('2026-10-01')).toBeNull();
  });
});

describe('RoleDetail — loading and not found', () => {
  it('shows a spinner and no page while the role is on its way', async () => {
    const d = deferred<{ data: unknown }>();
    rolesGet.mockReturnValue(d.promise);
    const { container } = mount();
    await waitFor(() => expect(rolesGet).toHaveBeenCalledWith(ID));
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByText('Role not found')).toBeNull();
    await act(async () => { d.resolve({ data: { role: serverRole } }); });
    await pageReady();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('says "Role not found" when the server has no such role', async () => {
    rolesGet.mockResolvedValue({ data: { role: null } });
    mount();
    expect(await screen.findByText('Role not found')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('says "Role not found" when the request fails, rather than showing a half page', async () => {
    rolesGet.mockImplementation(async () => { throw serverError('404'); });
    mount();
    expect(await screen.findByText('Role not found')).toBeInTheDocument();
    expect(button('Change status')).toBeNull();
  });
});

describe('RoleDetail — header, pipeline and activity', () => {
  it('the header names the role with its priority and status, and counts the active candidates', async () => {
    pipeline.mockResolvedValue({ data: { pipeline: { 'Interview Round 1': [app('A9001'), app('A9002')] }, total: 2 } });
    mount();
    const heading = await pageReady();
    const header = heading.parentElement as HTMLElement;                                   // the title row: title, priority badge, status badge
    expect(within(header).getByText('P1')).toBeInTheDocument();
    expect(within(header).getByText('Live – Sourcing')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('active candidates').previousElementSibling).toHaveTextContent('2'));
  });

  it('a role past its target shows how far past and how long it has been open; a healthy one only how long', async () => {
    serverRole = role({ aging_alert: 'red', days_open: 20, days_overdue: 3 });
    mount();
    await pageReady();
    expect(screen.getByText('🔴 3d over · 20d open')).toBeInTheDocument();
    cleanupMount();

    serverRole = role({ aging_alert: 'green', days_open: 5, days_overdue: 0 });
    mount();
    await pageReady();
    expect(screen.getByText('5d open')).toBeInTheDocument();
  });

  it('lists only the stages somebody is at, in the pipeline\'s own order, with each stage\'s count', async () => {
    pipeline.mockResolvedValue({ data: { total: 4, pipeline: {
      'Founders Round': [app('A9004')],
      'Applied and Screened': [app('A9001'), app('A9002'), app('A9003')],
    } } });
    mount();
    await pageReady();
    await screen.findByText('Test Candidate A9001');
    const stageNames = new RegExp(`^(${STAGES.join('|')})$`);
    expect(screen.getAllByText(stageNames).map(e => e.textContent)).toEqual(['Applied and Screened', 'Founders Round']);
    expect(screen.getByText('3 candidates')).toBeInTheDocument();
    expect(screen.getByText('1 candidate')).toBeInTheDocument();
  });

  it('each candidate links to their page and shows their channel, score and screening status; an SLA breach is marked', async () => {
    pipeline.mockResolvedValue({ data: { total: 2, pipeline: { 'Interview Round 1': [
      app('A9001', { candidate_id: 'C9001', source_channel: 'Naukri', ai_fit_score: 91, recruiter_screening_status: 'Under Recruiter Review', sla_breach: true }),
      app('A9002', { sla_breach: false, ai_fit_score: null }),
    ] } } });
    mount();
    await pageReady();
    const row = (await screen.findByText('Test Candidate A9001')).closest('tr') as HTMLElement;
    expect(within(row).getAllByRole('link').map(a => a.getAttribute('href'))).toEqual(['/candidates/C9001', '/candidates/C9001']);
    for (const text of ['Naukri', '91', 'Under Recruiter Review', 'SLA']) expect(within(row).getByText(text)).toBeInTheDocument();
    const other = screen.getByText('Test Candidate A9002').closest('tr') as HTMLElement;
    expect(within(other).queryByText('SLA')).toBeNull();
    expect(within(other).getByText('—')).toBeInTheDocument();                                // no score yet
  });

  it('an empty pipeline says so, and the Scorecard Summary button still opens this role\'s scorecard in My Tasks', async () => {
    mount();
    await pageReady();
    expect(await screen.findByText('No active candidates in this pipeline')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Scorecard Summary/ })).toHaveAttribute('href', `/my-tasks?role_id=${ID}`);
  });

  it('the activity timeline lists each event with who did it ("System" when nobody did) and its detail, and says so when empty', async () => {
    mount();
    await pageReady();
    expect(await screen.findByText('No activity logged yet')).toBeInTheDocument();
    cleanupMount();

    activity.mockResolvedValue({ data: { activity: [
      { event_type: 'Role Approved', performed_by_name: 'Ivan Lead', event_detail: 'Approved after review', created_at: '2026-10-01T10:00:00Z' },
      { event_type: 'JD Generated', performed_by_name: null, event_detail: null, created_at: '2026-10-01T10:01:00Z' },
    ] } });
    mount();
    await pageReady();
    expect(await screen.findByText('Role Approved')).toBeInTheDocument();
    expect(screen.getByText('by Ivan Lead')).toBeInTheDocument();
    expect(screen.getByText('Approved after review')).toBeInTheDocument();
    expect(screen.getByText('JD Generated')).toBeInTheDocument();
    expect(screen.getByText('by System')).toBeInTheDocument();
    expect(screen.queryByText('No activity logged yet')).toBeNull();
  });
});
