import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';

const schedule = vi.hoisted(() => vi.fn());
vi.mock('../services/api.ts', () => ({ interviewsApi: { schedule } }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: toast }));

import ScheduleRoundModal from './ScheduleRoundModal.tsx';

beforeEach(() => { schedule.mockReset(); toast.success.mockReset(); toast.error.mockReset(); });
afterEach(() => cleanup());

function open() {
  const onSuccess = vi.fn(); const onClose = vi.fn();
  render(<ScheduleRoundModal applicationId="A1" nextRoundNumber={2} defaultRoundName="Technical" onClose={onClose} onSuccess={onSuccess} />);
  return { onSuccess, onClose };
}
const pick = (name: RegExp) => { const t = screen.getByRole('button', { name: /^Interviewers/ }); if (t.getAttribute('aria-expanded') !== 'true') fireEvent.click(t); fireEvent.click(within(screen.getByRole('option', { name })).getByRole('checkbox')); };

describe('ScheduleRoundModal — interviewers', () => {
  it('has a dropdown (no free-text email box)', () => {
    open();
    expect(screen.getByText('Interviewers')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/alex@digitalpaani.com, satyadev/)).toBeNull();
    expect(screen.getByLabelText(/^Interviewers/)).toHaveTextContent('Select interviewers');
  });
  it('will not schedule without an interviewer', () => {
    open();
    fireEvent.change(document.querySelector('input[type="datetime-local"]')!, { target: { value: '2026-12-01T11:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('At least one interviewer is required'));
    expect(schedule).not.toHaveBeenCalled();
  });
  it('sends every ticked person\'s email as interviewer_emails', async () => {
    schedule.mockResolvedValue({ data: { calendar: { synced: true } } });
    const { onSuccess, onClose } = open();
    pick(/Mandeep Dagar/); pick(/Piyush Negi/);
    fireEvent.change(document.querySelector('input[type="datetime-local"]')!, { target: { value: '2026-12-01T11:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(schedule).toHaveBeenCalled());
    expect(schedule.mock.calls[0][0]).toMatchObject({
      application_id: 'A1', round_name: 'Technical', round_number: 2, scheduled_date: '2026-12-01T11:00:00+05:30',
      interviewer_emails: ['mandeep.dagar@digitalpaani.com', 'piyush.negi@digitalpaani.com'],
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalled()); expect(onClose).toHaveBeenCalled();
  });
});
