import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// What the role page's Dates marker and Age badge say. Facts: backend/src/routes/roles.ts sets Open Date (start_date) itself at
// the moment a role is approved and strips it from every client write; backend/src/utils/aging.ts flags a role by days past
// its Close Target, or by days open when no target is set (and then reports 0 days over).
const rolesGet = vi.fn();
vi.mock('../services/api.ts', () => ({
  rolesApi: {
    get: (id: string) => rolesGet(id), update: vi.fn(),
    pipeline: async () => ({ data: { pipeline: {}, total: 0 } }),
    activity: async () => ({ data: { activity: [] } }),
  },
  sourcingApi: { plan: async () => ({ data: { enabled: false } }), people: async () => ({ data: { people: [] } }) },
}));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Test HR', email: 'hr@example.test', persona: 'hr_recruiter' }, canHR: true }),
}));

import RoleDetail from './RoleDetail.tsx';

const role = (over: Record<string, unknown> = {}) => ({
  id: 'R5', title: 'QA Engineer', department: 'Engineering', hiring_manager_name: 'Test HM', priority: 'P1', status: 'Live – Sourcing',
  location: 'Mumbai', employment_type: 'Full-time', num_openings: 1, recruitment_mode: ['LinkedIn'], assignment_required: false,
  created_at: '2026-10-01T00:00:00Z', days_open: 62, days_overdue: 0, aging_alert: 'red', ...over,
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/roles/R5']}>
        <Routes><Route path="/roles/:id" element={<RoleDetail />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => { rolesGet.mockReset(); rolesGet.mockImplementation(async () => ({ data: { role: role() } })); });

describe('Role page — markers', () => {
  it('Dates: Open Date is set at approval and cannot be edited; the Age flag counts the days past the Close Target', async () => {
    mount();
    const title = await screen.findByText('Dates');
    fireEvent.mouseEnter(title.parentElement!.querySelector('[aria-label="More info"]')!);
    const tip = title.parentElement!.querySelector('div.absolute')!.textContent!;
    expect(tip).toContain("Open Date is set automatically when the role is approved and can't be edited");
    expect(tip).toContain('Close Target is when the role should be filled');
    expect(tip).toContain('counts the days past it, so moving it out clears an alert');
  });

  it('a flagged role with no Close Target reads "no target" in the header, never "0d over"', async () => {
    mount();
    await screen.findByRole('heading', { level: 1, name: 'QA Engineer' });
    expect(screen.getByText(/62d open · no target/)).toBeInTheDocument();
    expect(screen.queryByText(/0d over/)).not.toBeInTheDocument();
  });
});
