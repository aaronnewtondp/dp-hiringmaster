import '../../test/loadTolerance.ts';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HiringFunnelSnapshotStage, SlaBreachCandidate } from '../../types/index.ts';

// The Dashboard's "Hiring Funnel Snapshot": one chevron per stage with its open SLA breaches, an owner filter, and a drill-down
// (stage, then breach type, then the overdue candidates). Everything it shows comes from GET /dashboard/funnel-snapshot; the
// Dashboard's own master filters are passed in as a prop and ride along on every request.
const h = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock('../../services/api.ts', () => ({ dashboardApi: { funnelSnapshot: (p: unknown) => h.snapshot(p) } }));

import HiringFunnelSnapshot from './HiringFunnelSnapshot.tsx';

const candidate = (n: number, over: Partial<SlaBreachCandidate> = {}): SlaBreachCandidate => ({
  application_id: `A900${n}`, candidate_id: `C900${n}`, candidate_name: `Test Candidate ${n}`, role_id: 'R9001', role_title: 'Test Role Alpha',
  owner: 'Test Owner', stage: 'Applied and Screened', overdue_hours: 30, ...over,
});
const SNAPSHOT: HiringFunnelSnapshotStage[] = [
  { stage: 'Applied and Screened', total: 3, breach_types: [
    { type: 'Resume Shortlist Pending', owner: 'Hiring Manager', count: 2, candidates: [candidate(1, { overdue_hours: 30 }), candidate(2, { overdue_hours: 1 })] },
    { type: 'Not Shortlisted In Time', owner: 'HR / Recruiter', count: 1, candidates: [candidate(3, { candidate_id: null, overdue_hours: 0 })] },
  ] },
  { stage: 'Interview Round 1', total: 0, breach_types: [] },
  { stage: 'Interview Round 2', total: 1, breach_types: [
    { type: 'Interview 2 Feedback Due', owner: 'Hiring Manager', count: 1, candidates: [] },
  ] },
];

function mount(master: Record<string, string[]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><MemoryRouter><HiringFunnelSnapshot masterFilterParams={master} /></MemoryRouter></QueryClientProvider>,
  );
}
const lastRequest = () => h.snapshot.mock.calls[h.snapshot.mock.calls.length - 1][0] as Record<string, unknown>;
const stageButton = (stage: string) => screen.getByTitle(stage) as HTMLButtonElement;
const show = async (master: Record<string, string[]> = {}) => { mount(master); await screen.findByTitle('Applied and Screened'); };
const typeButton = (type: string) => screen.getByRole('button', { name: new RegExp(`^${type}`) });
const panel = () => screen.getByRole('region');

beforeEach(() => {
  h.snapshot.mockReset();
  h.snapshot.mockResolvedValue({ data: { hiring_funnel_snapshot: SNAPSHOT } });
});

describe('Hiring Funnel Snapshot — what it asks for', () => {
  it('sends the Dashboard\'s master filters as they are, with no owner until one is picked', async () => {
    await show({ role_id: ['R9001', 'R9002'], priority: ['P0'] });
    expect(h.snapshot).toHaveBeenCalledTimes(1);
    expect(h.snapshot.mock.calls[0][0]).toEqual({ role_id: ['R9001', 'R9002'], priority: ['P0'] });
  });

  it('with no master filters it sends an empty request', async () => {
    await show();
    expect(h.snapshot.mock.calls[0][0]).toEqual({});
  });

  it('the owner buttons add `owner` to the request without touching the master filters, and "All owners" removes it', async () => {
    await show({ role_id: ['R9001'] });
    fireEvent.click(screen.getByRole('button', { name: 'HR/Admin' }));
    await waitFor(() => expect(lastRequest()).toEqual({ role_id: ['R9001'], owner: 'HR / Recruiter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hiring Manager' }));
    await waitFor(() => expect(lastRequest()).toEqual({ role_id: ['R9001'], owner: 'Hiring Manager' }));
    fireEvent.click(screen.getByRole('button', { name: 'All owners' }));
    await waitFor(() => expect(lastRequest()).toEqual({ role_id: ['R9001'] }));
  });

  it('shows what the server returns for the chosen owner', async () => {
    h.snapshot.mockImplementation(async (p: { owner?: string }) => ({ data: { hiring_funnel_snapshot: [
      { stage: 'Applied and Screened', total: p.owner === 'Hiring Manager' ? 7 : 3, breach_types: [] },
    ] } }));
    await show();
    expect(stageButton('Applied and Screened')).toHaveTextContent('3');
    fireEvent.click(screen.getByRole('button', { name: 'Hiring Manager' }));
    await waitFor(() => expect(stageButton('Applied and Screened')).toHaveTextContent('7'));
  });
});

describe('Hiring Funnel Snapshot — the strip', () => {
  it('shows "Loading…" and no stage while the snapshot is on its way', () => {
    h.snapshot.mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByTitle('Applied and Screened')).not.toBeInTheDocument();
  });

  it('shows one chevron per stage the server returned, in its order, each with its total and a short label', async () => {
    await show();
    const chevrons = screen.getAllByTitle(/^(Applied and Screened|Interview Round [12])$/);
    expect(chevrons.map(c => c.getAttribute('title'))).toEqual(['Applied and Screened', 'Interview Round 1', 'Interview Round 2']);
    expect(stageButton('Applied and Screened')).toHaveTextContent('3');
    expect(stageButton('Applied and Screened')).toHaveTextContent('Applied & Screened');
    expect(stageButton('Interview Round 1')).toHaveTextContent('0');
    expect(stageButton('Interview Round 1')).toHaveTextContent('Interview 1');
    expect(stageButton('Interview Round 2')).toHaveTextContent('1');
  });

  it('a stage the label table does not know is shown under its own name', async () => {
    h.snapshot.mockResolvedValue({ data: { hiring_funnel_snapshot: [{ stage: 'Test New Stage', total: 2, breach_types: [] }] } });
    mount();
    expect(await screen.findByTitle('Test New Stage')).toHaveTextContent('Test New Stage');
  });

  it('a failed request does not crash it: the heading and the owner buttons stay and no stage is invented', async () => {
    h.snapshot.mockImplementation(async () => { throw new Error('network down'); });
    mount();
    expect(await screen.findByRole('heading', { name: 'Hiring Funnel Snapshot' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.queryByTitle('Applied and Screened')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All owners' })).toBeInTheDocument();
  });

  it('nothing is open until a stage is clicked', async () => {
    await show();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    for (const s of ['Applied and Screened', 'Interview Round 1', 'Interview Round 2']) expect(stageButton(s)).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('Hiring Funnel Snapshot — a stage\'s breach types', () => {
  it('a click opens that stage: its name as the heading, each breach type with its owner and count', async () => {
    await show();
    fireEvent.click(stageButton('Applied and Screened'));
    expect(stageButton('Applied and Screened')).toHaveAttribute('aria-expanded', 'true');
    expect(stageButton('Interview Round 1')).toHaveAttribute('aria-expanded', 'false');
    expect(within(panel()).getByRole('heading', { name: 'Applied and Screened' })).toBeInTheDocument();
    const first = typeButton('Resume Shortlist Pending');
    expect(first).toHaveTextContent('Hiring Manager');
    expect(first).toHaveTextContent('2');
    const second = typeButton('Not Shortlisted In Time');
    expect(second).toHaveTextContent('HR/Admin');
    expect(second).toHaveTextContent('1');
  });

  it('the stage button points at its panel by id', async () => {
    await show();
    fireEvent.click(stageButton('Applied and Screened'));
    const id = stageButton('Applied and Screened').getAttribute('aria-controls');
    expect(id).toBe('funnel-panel-Applied-and-Screened');
    expect(panel()).toHaveAttribute('id', id as string);
  });

  it('puts the keyboard focus on the panel heading when a stage opens', async () => {
    await show();
    fireEvent.click(stageButton('Interview Round 2'));
    await waitFor(() => expect(document.activeElement).toBe(within(panel()).getByRole('heading', { name: 'Interview Round 2' })));
  });

  it('a second click on the same stage, or Collapse, closes it', async () => {
    await show();
    fireEvent.click(stageButton('Applied and Screened'));
    fireEvent.click(stageButton('Applied and Screened'));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    fireEvent.click(stageButton('Applied and Screened'));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(stageButton('Applied and Screened')).toHaveAttribute('aria-expanded', 'false');
  });

  it('only one stage is open at a time: another click switches to it', async () => {
    await show();
    fireEvent.click(stageButton('Applied and Screened'));
    fireEvent.click(stageButton('Interview Round 2'));
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(within(panel()).getByRole('heading', { name: 'Interview Round 2' })).toBeInTheDocument();
    expect(stageButton('Applied and Screened')).toHaveAttribute('aria-expanded', 'false');
    expect(stageButton('Interview Round 2')).toHaveAttribute('aria-expanded', 'true');
  });

  it('a stage with no breaches says all clear', async () => {
    await show();
    fireEvent.click(stageButton('Interview Round 1'));
    expect(within(panel()).getByText('No breaches — all clear ✓')).toBeInTheDocument();
    expect(within(panel()).getAllByRole('button').map(b => b.textContent)).toEqual(['Collapse']);   // no breach type to open
  });
});

describe('Hiring Funnel Snapshot — the overdue candidates of a breach type', () => {
  const open = async (stage: string, type: string) => { await show(); fireEvent.click(stageButton(stage)); fireEvent.click(typeButton(type)); };

  it('opens one breach type at a time, showing it in the heading and each candidate with the SLA owner, role and stage', async () => {
    await open('Applied and Screened', 'Resume Shortlist Pending');
    expect(typeButton('Resume Shortlist Pending')).toHaveAttribute('aria-expanded', 'true');
    expect(typeButton('Not Shortlisted In Time')).toHaveAttribute('aria-expanded', 'false');
    expect(within(panel()).getByRole('heading')).toHaveTextContent('Applied and Screened › Resume Shortlist Pending');
    const card = screen.getByText('Test Candidate 1').closest('a') as HTMLElement;
    expect(card).toHaveTextContent('SLA Owner: Test Owner');
    expect(card).toHaveTextContent('Role: Test Role Alpha');
    expect(card).toHaveTextContent('Stage: Applied and Screened');
    expect(screen.queryByText('Test Candidate 3')).not.toBeInTheDocument();
  });

  it('a candidate with an id links to their page; one without is plain text, not a link', async () => {
    await open('Applied and Screened', 'Resume Shortlist Pending');
    expect(screen.getByText('Test Candidate 1').closest('a')).toHaveAttribute('href', '/candidates/C9001');
    expect(screen.getByText('Test Candidate 2').closest('a')).toHaveAttribute('href', '/candidates/C9002');
    fireEvent.click(typeButton('Not Shortlisted In Time'));
    expect(screen.getByText('Test Candidate 3')).toBeInTheDocument();
    expect(screen.getByText('Test Candidate 3').closest('a')).toBeNull();
  });

  it.each([
    // overdue_hours -> days shown: whole days rounded up, never less than 1
    [0, '1D'], [1, '1D'], [24, '1D'], [25, '2D'], [48, '2D'], [49, '3D'], [72, '3D'], [73, '4D'],
  ])('%s hours overdue reads Overdue %s', async (hours, label) => {
    h.snapshot.mockResolvedValue({ data: { hiring_funnel_snapshot: [{ stage: 'Applied and Screened', total: 1, breach_types: [
      { type: 'Resume Shortlist Pending', owner: 'Hiring Manager', count: 1, candidates: [candidate(1, { overdue_hours: hours })] },
    ] }] } });
    await show();
    fireEvent.click(stageButton('Applied and Screened'));
    fireEvent.click(typeButton('Resume Shortlist Pending'));
    expect(screen.getByText(`Overdue ${label}`)).toBeInTheDocument();
  });

  it('a second click on the breach type closes it, and a different type replaces it', async () => {
    await open('Applied and Screened', 'Resume Shortlist Pending');
    fireEvent.click(typeButton('Resume Shortlist Pending'));
    expect(screen.queryByText('Test Candidate 1')).not.toBeInTheDocument();
    expect(within(panel()).getByRole('heading')).toHaveTextContent(/^Applied and Screened$/);
    fireEvent.click(typeButton('Resume Shortlist Pending'));
    fireEvent.click(typeButton('Not Shortlisted In Time'));
    expect(screen.queryByText('Test Candidate 1')).not.toBeInTheDocument();
    expect(screen.getByText('Test Candidate 3')).toBeInTheDocument();
  });

  it('a breach type with no candidate rows says all clear', async () => {
    await open('Interview Round 2', 'Interview 2 Feedback Due');
    expect(screen.getByText('No breaches — all clear ✓')).toBeInTheDocument();
  });

  it('opening another stage forgets the breach type that was open', async () => {
    await open('Applied and Screened', 'Resume Shortlist Pending');
    fireEvent.click(stageButton('Interview Round 2'));
    expect(within(panel()).getByRole('heading')).toHaveTextContent(/^Interview Round 2$/);
    expect(typeButton('Interview 2 Feedback Due')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(stageButton('Applied and Screened'));
    expect(typeButton('Resume Shortlist Pending')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Test Candidate 1')).not.toBeInTheDocument();
  });
});
