import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RejectReasonModal from './RejectReasonModal.tsx';

describe('RejectReasonModal', () => {
  it('will not reject until at least one reason is ticked', () => {
    render(<RejectReasonModal count={1} saving={false} onConfirm={vi.fn()} onClose={vi.fn()} />);
    const reject = screen.getByRole('button', { name: 'Reject' });
    expect(reject).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Communication gap'));
    expect(reject).toBeEnabled();
    fireEvent.click(screen.getByLabelText('Communication gap'));
    expect(reject).toBeDisabled();
  });

  it('confirms with every ticked reason as a list, plus the trimmed detail', () => {
    const onConfirm = vi.fn();
    render(<RejectReasonModal count={3} saving={false} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Missing mandatory skill'));
    fireEvent.click(screen.getByLabelText('Short average tenure'));
    fireEvent.change(screen.getByPlaceholderText('Optional context…'), { target: { value: '  needs more depth  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [reasons, detail] = onConfirm.mock.calls[0];
    expect(reasons).toEqual(['Missing mandatory skill', 'Short average tenure']);
    expect(detail).toBe('needs more depth');
  });

  it('does not confirm on a disabled button', () => {
    const onConfirm = vi.fn();
    render(<RejectReasonModal count={1} saving={false} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
