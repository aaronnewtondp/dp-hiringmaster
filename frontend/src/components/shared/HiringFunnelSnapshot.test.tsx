import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HiringFunnelSnapshotStage } from '../../types/index.ts';

// What the Hiring Funnel Snapshot says about its owners and about "Overdue": the stored owner value 'HR / Recruiter' is shown
// as HR/Admin (the persona's name everywhere else) but is still what is sent to the API, and the marker names the two
// breach types whose "Overdue" figure is not live (backend/src/jobs/slaChecker.ts: 'Joining risk — no contact' is stored with
// a constant 120 hours, 'Assignment deadline breached' is written once and never refreshed).
const funnelSnapshot = vi.fn();
vi.mock('../../services/api.ts', () => ({ dashboardApi: { funnelSnapshot: (p: unknown) => funnelSnapshot(p) } }));

import HiringFunnelSnapshot from './HiringFunnelSnapshot.tsx';

const cand = (over: Record<string, unknown> = {}) => ({
  application_id: 'A0001', candidate_id: 'C0001', candidate_name: 'Test Candidate', role_id: 'R001', role_title: 'Quality Assurance Engineer',
  owner: 'HR / Recruiter', stage: 'Offer Accepted', overdue_hours: 120, ...over,
});

const SNAPSHOT: HiringFunnelSnapshotStage[] = [
  { stage: 'Applied and Screened', total: 0, breach_types: [] },
  { stage: 'Offer Accepted', total: 1,
    breach_types: [{ type: 'Joining risk — no contact', owner: 'HR / Recruiter', count: 1, candidates: [cand()] }] },
];

function mount() {
  funnelSnapshot.mockResolvedValue({ data: { hiring_funnel_snapshot: SNAPSHOT } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><HiringFunnelSnapshot masterFilterParams={{}} /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => { funnelSnapshot.mockReset(); });

describe('HiringFunnelSnapshot — owners', () => {
  it('names the owner buttons HR/Admin and Hiring Manager, and still sends the stored value "HR / Recruiter" to the API', async () => {
    mount();
    await screen.findByText('Applied & Screened');
    expect(screen.getByRole('button', { name: 'HR/Admin' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hiring Manager' })).toBeInTheDocument();
    expect(screen.queryByText('HR / Recruiter')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'HR/Admin' }));
    await waitFor(() => expect(funnelSnapshot).toHaveBeenLastCalledWith({ owner: 'HR / Recruiter' }));   // relabelled for display only
  });

  it('shows the breach type owner and each card\'s SLA Owner as HR/Admin', async () => {
    mount();
    fireEvent.click(await screen.findByTitle('Offer Accepted'));
    const type = await screen.findByText('Joining risk — no contact');
    expect(type.parentElement!.textContent).toContain('HR/Admin');
    fireEvent.click(type);
    expect(await screen.findByText('SLA Owner: HR/Admin')).toBeInTheDocument();
    expect(screen.queryByText(/HR \/ Recruiter/)).not.toBeInTheDocument();
    // a joining-risk breach is stored with a constant 120 hours, so its card always reads 5D, whatever the real delay
    expect(screen.getByText('Overdue 5D')).toBeInTheDocument();
  });
});

describe('HiringFunnelSnapshot — the marker', () => {
  it('says "Overdue" is as of the last check, and names the two types whose figure is not live', async () => {
    mount();
    const heading = await screen.findByText('Hiring Funnel Snapshot');
    fireEvent.mouseEnter(heading.parentElement!.querySelector('[aria-label="More info"]')!);
    const tip = heading.parentElement!.querySelector('div.absolute')!.textContent!;
    expect(tip).toContain('how far past its SLA limit each one was when HMS last checked');
    expect(tip).toContain("'Joining risk — no contact' always shows 5D");
    expect(tip).toContain("'Assignment deadline breached' shows how late it was when it was first flagged");
    expect(tip).not.toContain('how far past its SLA limit each one is ');
  });
});
