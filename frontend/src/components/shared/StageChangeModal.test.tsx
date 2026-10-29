import '../../test/loadTolerance.ts';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { STAGES, OVER_BUDGET_SHORTLIST_REASONS } from '../../types/index.ts';
import type { Application } from '../../types/index.ts';

// The single-application "Update stage" dialog (Candidate page, Ready for Review). A candidate 15%+ over the role's
// band cannot be moved to Interview Round 1 (shortlisted) without a reason on record.
const h = vi.hoisted(() => ({ advanceStage: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock('../../services/api.ts', () => ({ applicationsApi: { advanceStage: (...a: unknown[]) => h.advanceStage(...a) } }));
vi.mock('react-hot-toast', () => ({ default: { success: (m: string) => h.toastSuccess(m), error: (m: string) => h.toastError(m) } }));

import StageChangeModal from './StageChangeModal.tsx';

const application = (over: Partial<Application> = {}) => ({
  id: 'A9001', candidate_id: 'C9001', role_id: 'R9001', stage: 'Applied and Screened', status: 'Active', is_severely_over_budget: false, ...over,
}) as Application;

function mount(over: Partial<Application> = {}) {
  const onClose = vi.fn();
  const onUpdated = vi.fn();
  render(<StageChangeModal application={application(over)} onClose={onClose} onUpdated={onUpdated} />);
  return { onClose, onUpdated };
}
const stageSelect = () => screen.getByDisplayValue(/Applied and Screened|Interview|Assignment|Founders|Reference|Pre-Joining|Offer|Joined/) as HTMLSelectElement;
const chooseStage = (stage: string) => fireEvent.change(stageSelect(), { target: { value: stage } });
const reasonSelect = () => screen.getByDisplayValue('Select reason') as HTMLSelectElement;
const update = () => screen.getByRole('button', { name: /^(Update|Saving…)$/ });
const NO_BUDGET = { budgetExceptionReasonCat: undefined, budgetExceptionReasonDetail: undefined };

beforeEach(() => {
  h.advanceStage.mockReset(); h.toastSuccess.mockReset(); h.toastError.mockReset();
  h.advanceStage.mockResolvedValue({ data: {} });
});

describe('StageChangeModal — choosing the stage', () => {
  it('starts on the application\'s current stage and offers every pipeline stage in order', () => {
    mount({ stage: 'Founders Round' });
    expect(stageSelect().value).toBe('Founders Round');
    expect(Array.from(stageSelect().options).map(o => o.value)).toEqual(STAGES);
  });

  it('moves the application to the chosen stage, says so, then reports back and closes', async () => {
    const { onClose, onUpdated } = mount();
    chooseStage('Interview Round 2');
    fireEvent.click(update());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(h.advanceStage).toHaveBeenCalledTimes(1);
    expect(h.advanceStage).toHaveBeenCalledWith('A9001', 'Interview Round 2', NO_BUDGET);
    expect(h.toastSuccess).toHaveBeenCalledWith('Stage updated to Interview Round 2');
    expect(onUpdated).toHaveBeenCalledTimes(1);
  });

  it('Cancel closes without calling the server or reporting an update', () => {
    const { onClose, onUpdated } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUpdated).not.toHaveBeenCalled();
    expect(h.advanceStage).not.toHaveBeenCalled();
  });
});

describe('StageChangeModal — the over-budget reason', () => {
  it('a stage other than Interview Round 1 never shows the reason block, even for a 15%+ over-budget candidate', async () => {
    mount({ is_severely_over_budget: true });
    for (const stage of STAGES.filter(s => s !== 'Interview Round 1')) {
      chooseStage(stage);
      expect(screen.queryByText(/15%\+ over/)).not.toBeInTheDocument();
    }
    expect(update()).toBeEnabled();
  });

  it('Interview Round 1 for a 15%+ over-budget candidate shows the block and disables Update until a reason is chosen', () => {
    mount({ is_severely_over_budget: true });
    chooseStage('Interview Round 1');
    expect(screen.getByText(/15%\+ over the role's compensation band/)).toBeInTheDocument();
    expect(update()).toBeDisabled();
    fireEvent.click(update());
    expect(h.advanceStage).not.toHaveBeenCalled();
    fireEvent.change(reasonSelect(), { target: { value: OVER_BUDGET_SHORTLIST_REASONS[3] } });
    expect(update()).toBeEnabled();
  });

  it('offers the reasons from the shared list, and the detail box says it is optional', () => {
    mount({ is_severely_over_budget: true });
    chooseStage('Interview Round 1');
    expect(Array.from(reasonSelect().options).map(o => o.value)).toEqual(['', ...OVER_BUDGET_SHORTLIST_REASONS]);
    expect(screen.getByText('(optional)')).toBeInTheDocument();
  });

  it('sends the chosen reason and the TRIMMED detail', async () => {
    const { onClose } = mount({ is_severely_over_budget: true });
    chooseStage('Interview Round 1');
    fireEvent.change(reasonSelect(), { target: { value: OVER_BUDGET_SHORTLIST_REASONS[0] } });
    fireEvent.change(screen.getByPlaceholderText('Optional context…'), { target: { value: '  rare skill set  ' } });
    fireEvent.click(update());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.advanceStage).toHaveBeenCalledWith('A9001', 'Interview Round 1', {
      budgetExceptionReasonCat: OVER_BUDGET_SHORTLIST_REASONS[0], budgetExceptionReasonDetail: 'rare skill set',
    });
  });

  it('a blank detail is sent as nothing rather than as an empty string', async () => {
    const { onClose } = mount({ is_severely_over_budget: true });
    chooseStage('Interview Round 1');
    fireEvent.change(reasonSelect(), { target: { value: OVER_BUDGET_SHORTLIST_REASONS[1] } });
    fireEvent.change(screen.getByPlaceholderText('Optional context…'), { target: { value: '    ' } });
    fireEvent.click(update());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.advanceStage.mock.calls[0][2]).toEqual({ budgetExceptionReasonCat: OVER_BUDGET_SHORTLIST_REASONS[1], budgetExceptionReasonDetail: undefined });
    expect(h.advanceStage.mock.calls[0][2].budgetExceptionReasonDetail).toBeUndefined();
  });

  it('an application that is not 15%+ over budget gets no block and sends no reason for Interview Round 1', async () => {
    const { onClose } = mount({ is_severely_over_budget: false });
    chooseStage('Interview Round 1');
    expect(screen.queryByText(/15%\+ over/)).not.toBeInTheDocument();
    expect(update()).toBeEnabled();
    fireEvent.click(update());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.advanceStage).toHaveBeenCalledWith('A9001', 'Interview Round 1', NO_BUDGET);
  });

  it('an application with no over-budget flag at all (a stripped or older response) is treated as not over budget', () => {
    mount({ is_severely_over_budget: undefined });
    chooseStage('Interview Round 1');
    expect(screen.queryByText(/15%\+ over/)).not.toBeInTheDocument();
  });

  it('already sitting at Interview Round 1 and 15%+ over budget: the block is there from the start', () => {
    mount({ stage: 'Interview Round 1', is_severely_over_budget: true });
    expect(screen.getByText(/15%\+ over the role's compensation band/)).toBeInTheDocument();
    expect(update()).toBeDisabled();
  });

  it('a reason picked for Interview Round 1 is NOT sent when the stage is changed to another one afterwards', async () => {
    const { onClose } = mount({ is_severely_over_budget: true });
    chooseStage('Interview Round 1');
    fireEvent.change(reasonSelect(), { target: { value: OVER_BUDGET_SHORTLIST_REASONS[0] } });
    fireEvent.change(screen.getByPlaceholderText('Optional context…'), { target: { value: 'stale detail' } });
    chooseStage('Interview Round 2');
    expect(screen.queryByText(/15%\+ over/)).not.toBeInTheDocument();
    fireEvent.click(update());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.advanceStage).toHaveBeenCalledWith('A9001', 'Interview Round 2', NO_BUDGET);
  });
});

describe('StageChangeModal — failure and the busy state', () => {
  it('shows the server\'s own reason when the move is refused, and stays open for another try', async () => {
    h.advanceStage.mockImplementation(async () => { throw { response: { data: { error: 'At least one reference check is required' } } }; });
    const { onClose, onUpdated } = mount();
    chooseStage('Pre-Joining Documents');
    fireEvent.click(update());
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('At least one reference check is required'));
    expect(onClose).not.toHaveBeenCalled();
    expect(onUpdated).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
    await waitFor(() => expect(update()).toBeEnabled());
  });

  it('falls back to a generic message when the failure carries no reason', async () => {
    h.advanceStage.mockImplementation(async () => { throw new Error('network down'); });
    mount();
    chooseStage('Interview Round 2');
    fireEvent.click(update());
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Failed to update stage'));
  });

  it('while the request is in flight the button reads Saving… and is disabled, so a double click cannot send twice', async () => {
    let finish!: () => void;
    h.advanceStage.mockImplementation(() => new Promise(res => { finish = () => res({ data: {} }); }));
    const { onClose } = mount();
    chooseStage('Interview Round 2');
    fireEvent.click(update());
    const saving = await screen.findByRole('button', { name: 'Saving…' });
    expect(saving).toBeDisabled();
    fireEvent.click(saving);
    expect(h.advanceStage).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
