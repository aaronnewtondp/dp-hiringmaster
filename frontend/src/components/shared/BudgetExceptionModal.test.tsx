import '../../test/loadTolerance.ts';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OVER_BUDGET_SHORTLIST_REASONS } from '../../types/index.ts';
import BudgetExceptionModal from './BudgetExceptionModal.tsx';

// The gate in front of "Shortlist" for a candidate 15%+ over the role's band (Ready for Review, My Tasks).
const mount = (over: Partial<{ count: number; saving: boolean }> = {}) => {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(<BudgetExceptionModal count={1} saving={false} onConfirm={onConfirm} onClose={onClose} {...over} />);
  return { onConfirm, onClose };
};
const reasonSelect = () => screen.getByDisplayValue('Select reason') as HTMLSelectElement;
const shortlist = () => screen.getByRole('button', { name: 'Shortlist' });

describe('BudgetExceptionModal', () => {
  it('names one candidate in the singular and several in the plural', () => {
    const { unmount } = render(<BudgetExceptionModal count={1} saving={false} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'This candidate is 15%+ over budget' })).toBeInTheDocument();
    expect(screen.getByText('A reason is required before shortlisting this candidate.')).toBeInTheDocument();
    unmount();
    render(<BudgetExceptionModal count={4} saving={false} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '4 candidates are 15%+ over budget' })).toBeInTheDocument();
    expect(screen.getByText('A reason is required before shortlisting these candidates.')).toBeInTheDocument();
  });

  it('will not shortlist until a reason is chosen, and clicking the disabled button confirms nothing', () => {
    const { onConfirm } = mount();
    expect(shortlist()).toBeDisabled();
    fireEvent.click(shortlist());
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(reasonSelect(), { target: { value: OVER_BUDGET_SHORTLIST_REASONS[0] } });
    expect(shortlist()).toBeEnabled();
  });

  it('offers exactly the shared list of reasons', () => {
    mount();
    expect(Array.from(reasonSelect().options).map(o => o.value)).toEqual(['', ...OVER_BUDGET_SHORTLIST_REASONS]);
  });

  it('the detail is optional: a reason alone confirms, with an empty detail', () => {
    const { onConfirm } = mount();
    fireEvent.change(reasonSelect(), { target: { value: OVER_BUDGET_SHORTLIST_REASONS[2] } });
    fireEvent.click(shortlist());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(OVER_BUDGET_SHORTLIST_REASONS[2], '');
  });

  it('confirms with the chosen reason and the trimmed detail', () => {
    const { onConfirm } = mount();
    fireEvent.change(reasonSelect(), { target: { value: OVER_BUDGET_SHORTLIST_REASONS[3] } });
    fireEvent.change(screen.getByPlaceholderText('Optional context…'), { target: { value: '   approved by the founders  ' } });
    fireEvent.click(shortlist());
    expect(onConfirm).toHaveBeenCalledWith(OVER_BUDGET_SHORTLIST_REASONS[3], 'approved by the founders');
  });

  it('a detail typed without a reason still cannot confirm', () => {
    const { onConfirm } = mount();
    fireEvent.change(screen.getByPlaceholderText('Optional context…'), { target: { value: 'just because' } });
    expect(shortlist()).toBeDisabled();
    fireEvent.click(shortlist());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('while saving, the button is disabled and shows a spinner instead of its label, even with a reason chosen', () => {
    const { onConfirm } = mount({ saving: true });
    fireEvent.change(reasonSelect(), { target: { value: OVER_BUDGET_SHORTLIST_REASONS[0] } });
    expect(screen.queryByRole('button', { name: 'Shortlist' })).not.toBeInTheDocument();
    const buttons = screen.getAllByRole('button');
    const confirm = buttons[buttons.length - 1];
    expect(confirm).toBeDisabled();
    expect(confirm.querySelector('.animate-spin')).not.toBeNull();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Cancel and the close icon both close without confirming', () => {
    const { onConfirm, onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    const icon = screen.getAllByRole('button').find(b => !b.textContent?.trim() && !b.querySelector('.animate-spin'))!;
    fireEvent.click(icon);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
