import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// A plain function, not vi.fn(): the spy re-throws a rejected result on a derived promise, which vitest reports as an unhandled error.
let status: () => Promise<unknown> = async () => ({ data: { enabled: false } });
vi.mock('../services/api.ts', () => ({ sourcingApi: { status: () => status() } }));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Aaron Newton', email: 'a@x.com', persona: 'hr_recruiter' } }),
}));

import Help from './Help.tsx';

let qc: QueryClient;
function mount() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Help /></QueryClientProvider>);
}
const SOURCING_TITLE = /Sourcing execution & accountability/i;
const open = (question: RegExp | string) => fireEvent.click(screen.getByRole('button', { name: question }));

const answers = (body: unknown) => { status = async () => body; };
const fails = () => { status = async () => { throw new Error('boom'); }; };

describe('Help — the Sourcing group describes screens that only exist while the module is on', () => {
  it('is hidden when the module is off', async () => {
    answers({ data: { enabled: false } });
    mount();
    await waitFor(() => expect(qc.getQueryState(['sourcing-status'])?.status).toBe('success'));
    expect(screen.queryByText(SOURCING_TITLE)).toBeNull();
    expect(screen.getByText('Access & permissions')).toBeTruthy();   // the rest of the page is untouched
  });

  it('stays hidden — and the page still renders — when the status call fails', async () => {
    fails();
    mount();
    await waitFor(() => expect(qc.getQueryState(['sourcing-status'])?.status).toBe('error'));
    expect(screen.queryByText(SOURCING_TITLE)).toBeNull();
    expect(screen.getByText('Access & permissions')).toBeTruthy();
  });

  it('shows once the module is enabled, and its answers match how the module works today', async () => {
    answers({ data: { enabled: true } });
    mount();
    await screen.findByText(SOURCING_TITLE);

    open(/Who owns a sourcing plan/i);
    expect(screen.getByText(/HR\/Admin as a whole — never an individual/)).toBeTruthy();

    open(/How are due dates worked out/i);
    expect(screen.getByText(/Public holidays aren't modelled/)).toBeTruthy();

    open(/Why does "Applications by source" say "Not tagged"/i);
    expect(screen.getByText(/applicant's own answer/)).toBeTruthy();
  });
});

describe('Help — answers that were wrong or stale', () => {
  beforeEach(() => answers({ data: { enabled: false } }));

  it('does not promise a daily pending-items e-mail (that cron has never fired)', async () => {
    mount();
    open('What e-mails does HMS send?');
    expect(screen.getByText(/does not send a daily summary of pending/)).toBeTruthy();
  });

  it('describes My Tasks as boxes, and Scorecard Summary as the table inside Ready for review', async () => {
    mount();
    open(/What is My Tasks, and what is the Scorecard Summary table/i);
    expect(screen.getByText(/row of boxes with counts/)).toBeTruthy();
    expect(screen.getByText(/not a separate page/)).toBeTruthy();
  });

  it('every question opens independently (no two sections share an id)', async () => {
    answers({ data: { enabled: true } });
    mount();
    await screen.findByText(SOURCING_TITLE);
    const questions = screen.getAllByRole('button').filter(b => b.querySelector('svg') && b.textContent);   // the FAQ rows (the guide links are anchors)
    expect(questions.length).toBeGreaterThan(30);
    for (const q of questions) fireEvent.click(q);
    // all open at once: a duplicated id would have toggled two rows together and left some closed
    expect(document.querySelectorAll('.leading-relaxed').length).toBe(questions.length);
  });
});
