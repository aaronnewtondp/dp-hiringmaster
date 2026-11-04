import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { agingPhrase, backendFacts } from '../test/backendSource.ts';

// What the Roles table's markers and header hovers say. Each assertion pins a sentence; the fact behind it, which the code
// decides, is named in the comment. A figure the sentence quotes (the aging thresholds) is taken from the backend's own source
// (src/test/backendSource.ts), not typed here, so a changed backend threshold turns the test red.
const list = vi.fn();
let canHR = true;
vi.mock('../services/api.ts', () => ({
  rolesApi: { list: (p: unknown) => list(p), filterOptions: () => Promise.resolve({ data: { recruitment_modes: [] } }) },
}));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({ canHR, user: { id: 'u1', name: 'Test HR', persona: canHR ? 'hr_recruiter' : 'hiring_manager' } }),
}));

import Roles from './Roles.tsx';

const role = (over: Record<string, unknown> = {}) => ({
  id: 'R001', title: 'Quality Assurance Engineer', priority: 'P1', department: 'Engineering', location: 'Mumbai', num_openings: 1,
  status: 'Live – Sourcing', days_open: 62, days_overdue: 0, aging_alert: 'red', active_candidate_count: 3, shortlisted_count: 1,
  ctc_band: '18-24 LPA', ...over,
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><Roles /></MemoryRouter></QueryClientProvider>);
}

const th = (label: string) => screen.getAllByRole('columnheader').find(h => h.querySelector('span')?.textContent === label)!;
const markerOf = (label: string): string => {
  const cell = th(label);
  fireEvent.mouseEnter(cell.querySelector('[aria-label="More info"]')!);
  return cell.querySelector('div.absolute')!.textContent!;
};

beforeEach(() => {
  list.mockReset(); sessionStorage.clear(); canHR = true;
  list.mockResolvedValue({ data: { roles: [role()] } });
});

describe('Roles — what the markers and hovers say', () => {
  it('Age: the flag starts N days PAST the Close Target, with the per-priority numbers, and a role with no target uses the same numbers on days open', async () => {
    mount();
    await screen.findByText('Quality Assurance Engineer');
    const tip = markerOf('Age');
    expect(tip).toContain(agingPhrase(backendFacts()));   // types/index.ts AGING_THRESHOLDS, read from the backend source
    expect(tip).toContain('past its Close Target by');
    expect(tip).toContain('If no Close Target is set, the same numbers are applied to the days it has been open');   // utils/aging.ts
    expect(tip).toContain('Draft, Under Review, On Hold and Closed roles never flag');
    expect(tip).not.toContain('Nothing is flagged until the Close Target passes');
  });

  it('a flagged role with no Close Target reads "no target", never "0d over"', async () => {
    mount();
    await screen.findByText('Quality Assurance Engineer');
    expect(screen.getByText(/62d open · no target/)).toBeInTheDocument();
    expect(screen.queryByText(/0d over/)).not.toBeInTheDocument();
  });

  it('Active Shortlist: names the four stages it counts and says it is not the Dashboard\'s Shortlisted', async () => {
    mount();
    await screen.findByText('Quality Assurance Engineer');
    const tip = markerOf('Active Shortlist');
    expect(tip).toContain('Interview Round 1, Interview Round 2, Assignment Round or Founders Round');    // routes/roles.ts shortlisted_count
    expect(tip).toContain('Reference Check onwards');
    expect(tip).toContain("Not the same as Shortlisted on the Dashboard's Low pipeline roles table");
  });

  it('Priority: P0 is the most urgent, and it sets how far past its Close Target a role runs before it is flagged', async () => {
    mount();
    await screen.findByText('Quality Assurance Engineer');
    expect(th('Priority').getAttribute('title')).toContain('P0 is the most urgent priority and P3 the least');
    expect(th('Priority').getAttribute('title')).toContain('how far past its Close Target');
  });

  it('Salary Range: the same field as CTC Band, its top number is the Over Budget ceiling, and only HR-tier users have the column', async () => {
    mount();
    await screen.findByText('Quality Assurance Engineer');
    const hover = th('Salary Range').getAttribute('title')!;
    expect(hover).toContain('the same field as CTC Band on the role page');
    expect(hover).toContain('top number is the ceiling used for the Over Budget flag');                    // utils/budget.ts parseCtcBandMax
    expect(hover).toContain('HR/Admin, Leadership and Super Admin only');
  });

  it('a Hiring Manager has no Salary Range column to explain', async () => {
    canHR = false;
    mount();
    await screen.findByText('Quality Assurance Engineer');
    expect(screen.queryByText('Salary Range')).not.toBeInTheDocument();
  });
});
