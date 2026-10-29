import '../test/loadTolerance.ts';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';

// Active Candidates — the bulk stage and bulk status actions: the mandatory over-budget reason (15%+ over the band, only for
// Interview Round 1), several rejection reasons, a single withdrawal reason, per-recipient rejection e-mail text, batching
// three at a time and the "N of M" reports.
const h = vi.hoisted(() => ({
  persona: 'hr_recruiter' as 'hr_recruiter' | 'hiring_manager' | 'leadership' | 'super_admin',
  list: vi.fn(), advanceStage: vi.fn(), updateStatus: vi.fn(),
  unmatched: vi.fn(), linkRole: vi.fn(), remove: vi.fn(), filterOptions: vi.fn(), rolesList: vi.fn(),
  toastSuccess: vi.fn(), toastError: vi.fn(),
}));
vi.mock('../services/api.ts', () => ({
  applicationsApi: {
    list: (p: unknown) => h.list(p),
    advanceStage: (...a: unknown[]) => h.advanceStage(...a),
    updateStatus: (...a: unknown[]) => h.updateStatus(...a),
  },
  candidatesApi: {
    unmatched: (p: unknown) => h.unmatched(p),
    linkRole: (...a: unknown[]) => h.linkRole(...a),
    remove: (...a: unknown[]) => h.remove(...a),
    list: vi.fn(),
  },
  rolesApi: { filterOptions: () => h.filterOptions(), list: (p: unknown) => h.rolesList(p) },
}));
// The same derivation AuthContext uses for these two flags (its own tests pin the real one).
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({
    canHR: h.persona !== 'hiring_manager',
    canLead: h.persona === 'leadership' || h.persona === 'super_admin',
  }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: (m: string) => h.toastSuccess(m), error: (m: string) => h.toastError(m) } }));

import Candidates from './Candidates.tsx';
import { REJECTION_REASONS, WITHDRAWAL_REASONS, OVER_BUDGET_SHORTLIST_REASONS } from '../types/index.ts';
import { APPS, application as app, FILTER_OPTIONS, LIVE_ROLES } from '../test/candidateFixtures.ts';

// react-query hands results to React through setTimeout(0). The debounce tests fake setTimeout, so give the query
// library the real one: only the page's own timer is then driven by the fake clock.
const realSetTimeout = globalThis.setTimeout;
beforeAll(() => { notifyManager.setScheduler(cb => { realSetTimeout(cb, 0); }); });

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><Candidates /></MemoryRouter></QueryClientProvider>);
}
const showList = async () => { mount(); await screen.findByText('Test Candidate A9001'); };
const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLTableRowElement;
const names = () => Array.from(document.querySelectorAll('tbody tr')).map(tr => tr.querySelector('a')?.textContent);
const tick = (name: string) => fireEvent.click(within(rowOf(name)).getByRole('checkbox'));
const modalOf = (heading: string) => screen.getByRole('heading', { name: heading }).closest('.fixed') as HTMLElement;

beforeEach(() => {
  h.persona = 'hr_recruiter';
  for (const f of [h.list, h.advanceStage, h.updateStatus, h.unmatched, h.linkRole, h.remove, h.filterOptions, h.rolesList, h.toastSuccess, h.toastError]) f.mockReset();
  sessionStorage.clear();
  h.list.mockResolvedValue({ data: { applications: APPS } });
  h.advanceStage.mockResolvedValue({ data: {} });
  h.updateStatus.mockResolvedValue({ data: {} });
  h.unmatched.mockResolvedValue({ data: { submissions: [], total: 0 } });
  h.filterOptions.mockResolvedValue(FILTER_OPTIONS);
  h.rolesList.mockResolvedValue(LIVE_ROLES);
  h.linkRole.mockResolvedValue({ data: {} });
  h.remove.mockResolvedValue({ data: {} });
});
afterEach(() => { vi.useRealTimers(); });

describe('Active Candidates — bulk stage change', () => {
  const openStageModal = (...rows: string[]) => {
    rows.forEach(tick);
    fireEvent.click(screen.getByRole('button', { name: 'Change Stage' }));
    return modalOf('Update stage');
  };

  it('moves every selected application to the chosen stage and reports "N of M updated"', async () => {
    await showList();
    const modal = openStageModal('Test Candidate A9002', 'Test Candidate A9003');
    expect(within(modal).getByText('2 candidates')).toBeInTheDocument();
    fireEvent.change(within(modal).getByRole('combobox'), { target: { value: 'Interview Round 2' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('2 of 2 updated to Interview Round 2'));
    expect(h.advanceStage).toHaveBeenCalledTimes(2);
    expect(h.advanceStage).toHaveBeenCalledWith('A9002', 'Interview Round 2', { budgetExceptionReasonCat: undefined, budgetExceptionReasonDetail: undefined });
    expect(h.advanceStage).toHaveBeenCalledWith('A9003', 'Interview Round 2', { budgetExceptionReasonCat: undefined, budgetExceptionReasonDetail: undefined });
    await waitFor(() => expect(screen.queryByText('Update stage')).not.toBeInTheDocument());
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();             // the selection is cleared
  });

  it('refreshes the list after a bulk change', async () => {
    await showList();
    const calls = h.list.mock.calls.length;
    const modal = openStageModal('Test Candidate A9002');
    fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(h.list.mock.calls.length).toBeGreaterThan(calls));
  });

  it('moving to Interview Round 1 with a 15%+ over-budget candidate selected asks for a reason first, and blocks Update until one is picked', async () => {
    await showList();
    const modal = openStageModal('Test Candidate A9001', 'Test Candidate A9002');
    expect(within(modal).queryByText(/15%\+ over/)).not.toBeInTheDocument();     // not yet: the stage is still the first one
    fireEvent.change(within(modal).getByDisplayValue('Applied and Screened'), { target: { value: 'Interview Round 1' } });
    expect(within(modal).getByText(/15%\+ over the role's compensation band/)).toBeInTheDocument();
    const update = within(modal).getByRole('button', { name: 'Update' });
    expect(update).toBeDisabled();
    fireEvent.click(update);
    expect(h.advanceStage).not.toHaveBeenCalled();
  });

  it('once a reason is picked, it and the trimmed detail go to every candidate in the batch', async () => {
    await showList();
    const modal = openStageModal('Test Candidate A9001', 'Test Candidate A9002');
    fireEvent.change(within(modal).getByDisplayValue('Applied and Screened'), { target: { value: 'Interview Round 1' } });
    fireEvent.change(within(modal).getByDisplayValue('Select reason'), { target: { value: OVER_BUDGET_SHORTLIST_REASONS[1] } });
    fireEvent.change(within(modal).getByPlaceholderText('Optional context…'), { target: { value: '  approved by the founders  ' } });
    const update = within(modal).getByRole('button', { name: 'Update' });
    expect(update).toBeEnabled();
    fireEvent.click(update);
    await waitFor(() => expect(h.advanceStage).toHaveBeenCalledTimes(2));
    const opts = { budgetExceptionReasonCat: OVER_BUDGET_SHORTLIST_REASONS[1], budgetExceptionReasonDetail: 'approved by the founders' };
    expect(h.advanceStage).toHaveBeenCalledWith('A9001', 'Interview Round 1', opts);
    expect(h.advanceStage).toHaveBeenCalledWith('A9002', 'Interview Round 1', opts);
  });

  it('a blank detail is sent as nothing, not as an empty string', async () => {
    await showList();
    const modal = openStageModal('Test Candidate A9001');
    fireEvent.change(within(modal).getByDisplayValue('Applied and Screened'), { target: { value: 'Interview Round 1' } });
    fireEvent.change(within(modal).getByDisplayValue('Select reason'), { target: { value: OVER_BUDGET_SHORTLIST_REASONS[0] } });
    fireEvent.change(within(modal).getByPlaceholderText('Optional context…'), { target: { value: '   ' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(h.advanceStage).toHaveBeenCalled());
    expect(h.advanceStage).toHaveBeenCalledWith('A9001', 'Interview Round 1', { budgetExceptionReasonCat: OVER_BUDGET_SHORTLIST_REASONS[0], budgetExceptionReasonDetail: undefined });
  });

  it('no reason is asked for when the candidate is over the band but not 15%+ over (Over Budget alone is not enough)', async () => {
    await showList();
    const modal = openStageModal('Test Candidate A9003');                         // 16 against 15 x 1.15 = 17.25
    fireEvent.change(within(modal).getByDisplayValue('Applied and Screened'), { target: { value: 'Interview Round 1' } });
    expect(within(modal).queryByText(/15%\+ over/)).not.toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: 'Update' })).toBeEnabled();
    fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(h.advanceStage).toHaveBeenCalledWith('A9003', 'Interview Round 1', { budgetExceptionReasonCat: undefined, budgetExceptionReasonDetail: undefined }));
  });

  it('no reason is asked for when the stage is anything other than Interview Round 1, even for a 15%+ over-budget candidate', async () => {
    await showList();
    const modal = openStageModal('Test Candidate A9001');
    fireEvent.change(within(modal).getByDisplayValue('Applied and Screened'), { target: { value: 'Interview Round 2' } });
    expect(within(modal).queryByText(/15%\+ over/)).not.toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: 'Update' })).toBeEnabled();
    fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(h.advanceStage).toHaveBeenCalledWith('A9001', 'Interview Round 2', { budgetExceptionReasonCat: undefined, budgetExceptionReasonDetail: undefined }));
  });

  it('offers the over-budget reasons from the shared list', async () => {
    await showList();
    const modal = openStageModal('Test Candidate A9001');
    fireEvent.change(within(modal).getByDisplayValue('Applied and Screened'), { target: { value: 'Interview Round 1' } });
    const select = within(modal).getByDisplayValue('Select reason') as HTMLSelectElement;
    expect(Array.from(select.options).map(o => o.value)).toEqual(['', ...OVER_BUDGET_SHORTLIST_REASONS]);
  });

  it('cancelling the reason step forgets the reason: reopening starts with none picked', async () => {
    await showList();
    let modal = openStageModal('Test Candidate A9001');
    fireEvent.change(within(modal).getByDisplayValue('Applied and Screened'), { target: { value: 'Interview Round 1' } });
    fireEvent.change(within(modal).getByDisplayValue('Select reason'), { target: { value: OVER_BUDGET_SHORTLIST_REASONS[0] } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change Stage' }));
    modal = modalOf('Update stage');
    fireEvent.change(within(modal).getByDisplayValue('Interview Round 1'), { target: { value: 'Interview Round 1' } });
    expect(within(modal).getByDisplayValue('Select reason')).toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: 'Update' })).toBeDisabled();
  });

  it('sends the changes three at a time: the fourth waits for the first batch', async () => {
    const five = ['A9031', 'A9032', 'A9033', 'A9034', 'A9035'].map(id => app(id));
    h.list.mockResolvedValue({ data: { applications: five } });
    const gates: Record<string, () => void> = {};
    h.advanceStage.mockImplementation((id: string) => new Promise(res => { gates[id] = () => res({ data: {} }); }));
    mount();
    await screen.findByText('Test Candidate A9031');
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Change Stage' }));
    fireEvent.change(within(modalOf('Update stage')).getByRole('combobox'), { target: { value: 'Interview Round 2' } });
    fireEvent.click(within(modalOf('Update stage')).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(h.advanceStage).toHaveBeenCalledTimes(3));
    expect(h.advanceStage.mock.calls.map(c => c[0])).toEqual(['A9031', 'A9032', 'A9033']);
    await act(async () => { await Promise.resolve(); });
    expect(h.advanceStage).toHaveBeenCalledTimes(3);                              // still waiting on the batch
    gates.A9031(); gates.A9032(); gates.A9033();
    await waitFor(() => expect(h.advanceStage).toHaveBeenCalledTimes(5));
    gates.A9034(); gates.A9035();
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('5 of 5 updated to Interview Round 2'));
  });

  it('when some changes fail it says how many worked, as an error', async () => {
    h.advanceStage.mockImplementation(async (id: string) => { if (id === 'A9003') throw new Error('refused'); return { data: {} }; });
    await showList();
    const modal = openStageModal('Test Candidate A9002', 'Test Candidate A9003');
    fireEvent.change(within(modal).getByRole('combobox'), { target: { value: 'Interview Round 2' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('1 of 2 updated to Interview Round 2'));
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it('Cancel closes the dialog and changes nothing', async () => {
    await showList();
    const modal = openStageModal('Test Candidate A9002');
    fireEvent.click(within(modal).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Update stage')).not.toBeInTheDocument();
    expect(h.advanceStage).not.toHaveBeenCalled();
  });
});

describe('Active Candidates — bulk status change', () => {
  const openStatusModal = (...rows: string[]) => {
    rows.forEach(tick);
    fireEvent.click(screen.getByRole('button', { name: 'Change Status' }));
    return modalOf('Update status');
  };
  const chooseStatus = (modal: HTMLElement, status: string) => fireEvent.change(within(modal).getByDisplayValue('Active'), { target: { value: status } });
  const update = (modal: HTMLElement) => fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));

  it('offers exactly Active, Rejected, Withdrawn and Hold for Future', async () => {
    await showList();
    const modal = openStatusModal('Test Candidate A9002');
    expect(Array.from((within(modal).getByDisplayValue('Active') as HTMLSelectElement).options).map(o => o.value))
      .toEqual(['Active', 'Rejected', 'Withdrawn', 'Hold for Future']);
  });

  it('Rejected: asks for at least one reason, sends nothing without one', async () => {
    await showList();
    const modal = openStatusModal('Test Candidate A9002', 'Test Candidate A9003');
    chooseStatus(modal, 'Rejected');
    update(modal);
    expect(h.toastError).toHaveBeenCalledWith('Select at least one reason');
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('Rejected lists every rejection reason as a tick box, so several can be picked', async () => {
    await showList();
    const modal = openStatusModal('Test Candidate A9002');
    chooseStatus(modal, 'Rejected');
    for (const r of REJECTION_REASONS) expect(within(modal).getByLabelText(r)).toBeInTheDocument();
    expect(within(modal).queryByDisplayValue('Select reason *')).not.toBeInTheDocument();   // not the single-reason select
  });

  it('Rejected with two reasons: each application gets the list, the older joined string and the detail', async () => {
    await showList();
    const modal = openStatusModal('Test Candidate A9002', 'Test Candidate A9003');
    chooseStatus(modal, 'Rejected');
    fireEvent.click(within(modal).getByLabelText('Communication gap'));
    fireEvent.click(within(modal).getByLabelText('Compensation mismatch'));
    fireEvent.change(within(modal).getByPlaceholderText('Additional detail (optional)'), { target: { value: 'budget and fit' } });
    update(modal);
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('2 of 2 updated to Rejected'));
    const body = {
      new_status: 'Rejected',
      rejection_reason_cats: ['Communication gap', 'Compensation mismatch'],
      rejection_reason_cat: 'Communication gap; Compensation mismatch',
      rejection_reason_detail: 'budget and fit',
    };
    expect(h.updateStatus).toHaveBeenCalledTimes(2);
    expect(h.updateStatus).toHaveBeenCalledWith('A9002', body);
    expect(h.updateStatus).toHaveBeenCalledWith('A9003', body);
    expect(h.updateStatus.mock.calls[0][1]).not.toHaveProperty('send_rejection_email', true);   // e-mail was not asked for
    expect(h.updateStatus.mock.calls[0][1].rejection_email_subject).toBeUndefined();
  });

  it('Withdrawn stays a single-reason pick (a select of the withdrawal reasons), sent as a one-item list', async () => {
    await showList();
    const modal = openStatusModal('Test Candidate A9002');
    chooseStatus(modal, 'Withdrawn');
    expect(within(modal).queryByLabelText(REJECTION_REASONS[0])).not.toBeInTheDocument();
    const select = within(modal).getByDisplayValue('Select reason *') as HTMLSelectElement;
    expect(Array.from(select.options).map(o => o.value)).toEqual(['', ...WITHDRAWAL_REASONS]);
    update(modal);
    expect(h.toastError).toHaveBeenCalledWith('Select at least one reason');
    expect(h.updateStatus).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: 'Process too slow' } });
    update(modal);
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledTimes(1));
    expect(h.updateStatus).toHaveBeenCalledWith('A9002', { new_status: 'Withdrawn', rejection_reason_cats: ['Process too slow'], rejection_reason_cat: 'Process too slow' });
  });

  it('Hold for Future carries no reasons, even after Rejected was opened and a reason ticked first', async () => {
    await showList();
    const modal = openStatusModal('Test Candidate A9002');
    chooseStatus(modal, 'Rejected');
    fireEvent.click(within(modal).getByLabelText('Communication gap'));
    fireEvent.change(within(modal).getByDisplayValue('Rejected'), { target: { value: 'Hold for Future' } });
    update(modal);
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledTimes(1));
    const sent = h.updateStatus.mock.calls[0][1] as Record<string, unknown>;
    expect(sent.new_status).toBe('Hold for Future');
    expect(sent.rejection_reason_cats).toBeUndefined();
    expect(sent.rejection_reason_cat).toBeUndefined();
  });

  it('the rejection e-mail is off until asked for, and then goes out per candidate with that candidate\'s own name and role', async () => {
    h.updateStatus.mockImplementation(async (id: string) => ({ data: { email: { sent: id !== 'A9003' } } }));
    await showList();
    const modal = openStatusModal('Test Candidate A9001', 'Test Candidate A9002', 'Test Candidate A9003');
    chooseStatus(modal, 'Rejected');
    fireEvent.click(within(modal).getByLabelText('Missing mandatory skill'));
    fireEvent.click(within(modal).getByLabelText('Compensation mismatch'));
    expect(within(modal).queryByDisplayValue(/Update on your application/)).not.toBeInTheDocument();
    fireEvent.click(within(modal).getByLabelText('Send rejection email to candidates'));
    expect(within(modal).getByText('To:').parentElement).toHaveTextContent('To: 3 candidates');
    expect(within(modal).getByDisplayValue(/Update on your application/)).toBeInTheDocument();
    const bodyBox = within(modal).getByDisplayValue(/^Hi \{\{candidate_name\}\}/) as HTMLTextAreaElement;
    // the candidate-facing text never names the internal reasons
    for (const reason of ['Missing mandatory skill', 'Compensation mismatch']) expect(bodyBox.value.toLowerCase()).not.toContain(reason.toLowerCase());
    fireEvent.change(bodyBox, { target: { value: bodyBox.value + '\n\nP.S. for {{candidate_name}} about {{role_title}}' } });
    update(modal);
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledTimes(3));
    const forApp = (id: string) => h.updateStatus.mock.calls.find(c => c[0] === id)![1] as Record<string, unknown>;
    expect(forApp('A9001').send_rejection_email).toBe(true);
    expect(forApp('A9001').rejection_email_subject).toBe('Update on your application — Test Role Alpha');
    expect(forApp('A9002').rejection_email_subject).toContain('Test Role Beta');
    expect(forApp('A9002').rejection_email_body).toContain('Hi Test Candidate A9002,');
    expect(forApp('A9002').rejection_email_body).toContain('P.S. for Test Candidate A9002 about Test Role Beta');
    expect(forApp('A9003').rejection_email_body).toContain('Hi Test Candidate A9003,');
    for (const id of ['A9001', 'A9002', 'A9003']) {
      expect(forApp(id).rejection_email_body as string).not.toContain('{{');          // every token was filled
      expect(forApp(id).rejection_email_subject as string).not.toContain('{{');
    }
    // all 3 were updated, but only 2 of the 3 e-mails went out: the message says both numbers
    await waitFor(() => expect(h.toastSuccess.mock.calls.concat(h.toastError.mock.calls).map(c => c[0])).toContain('3 of 3 updated to Rejected — 2 of 3 emails sent'));
  });

  it('without the e-mail ticked, no e-mail fields are sent at all', async () => {
    await showList();
    const modal = openStatusModal('Test Candidate A9002');
    chooseStatus(modal, 'Rejected');
    fireEvent.click(within(modal).getByLabelText('Communication gap'));
    update(modal);
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledTimes(1));
    const sent = h.updateStatus.mock.calls[0][1] as Record<string, unknown>;
    expect(sent.send_rejection_email).toBeUndefined();
    expect(sent.rejection_email_subject).toBeUndefined();
    expect(sent.rejection_email_body).toBeUndefined();
    expect(h.toastSuccess).toHaveBeenCalledWith('1 of 1 updated to Rejected');
  });

  it('a partly failed bulk status change is reported as an error with the real count', async () => {
    h.updateStatus.mockImplementation(async (id: string) => { if (id === 'A9002') throw new Error('refused'); return { data: {} }; });
    await showList();
    const modal = openStatusModal('Test Candidate A9002', 'Test Candidate A9003');
    chooseStatus(modal, 'Hold for Future');
    update(modal);
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('1 of 2 updated to Hold for Future'));
  });

  it('closes the dialog and clears the selection after a bulk status change', async () => {
    await showList();
    const modal = openStatusModal('Test Candidate A9002');
    chooseStatus(modal, 'Hold for Future');
    update(modal);
    await waitFor(() => expect(screen.queryByText('Update status')).not.toBeInTheDocument());
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });
});

