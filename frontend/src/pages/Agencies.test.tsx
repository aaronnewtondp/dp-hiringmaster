import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The agency repository table: how each row reads a (often half-filled) agency record. The page has no persona logic of its
// own (any signed-in user who reaches the route sees it), so there is nothing to mock for the user.
const list = vi.fn();
const create = vi.fn();
vi.mock('../services/api.ts', () => ({ agenciesApi: { list: () => list(), create: (d: unknown) => create(d) } }));

import Agencies from './Agencies.tsx';

const agency = (over: Record<string, unknown> = {}) => ({
  id: 'AGN901', name: 'Test Agency One', contact_name: 'Test Contact', contract_status: 'Active',
  specialisations: 'Process engineers', market_positioning: 'Mid-market specialist',
  tier1_band: '5-10 LPA', tier1_rate: '8.33%', tier2_band: '10-20 LPA', tier2_rate: '10%', tier3_band: '20+ LPA', tier3_rate: '12%',
  total_hired: 3, replacement_guarantee_days: 90, replacement_triggers: 'Leaves within the window',
  billing_effective_window: '45 days', billing_late_penalty: '2% per month', agreement_drive_link: 'https://drive.example/agreement', ...over,
});
const BARE = (over: Record<string, unknown> = {}) => ({ id: 'AGN902', name: 'Test Agency Bare', contract_status: 'Inactive', ...over });

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><Agencies /></MemoryRouter></QueryClientProvider>);
}
const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
const cell = (name: string, i: number) => row(name).cells[i];
// the column positions in the table
const COL = { name: 0, status: 1, type: 2, tiers: 3, positioning: 4, hires: 5, replacement: 6, billing: 7, agreement: 8 };

beforeEach(() => {
  list.mockReset(); create.mockReset();
  list.mockResolvedValue({ data: { agencies: [agency()] } });
});

describe('Agencies — the list', () => {
  it('shows how many agencies there are, and a link to each one\'s page from its name', async () => {
    list.mockResolvedValue({ data: { agencies: [agency(), BARE()] } });
    mount();
    await screen.findByText('Test Agency One');
    expect(screen.getByText('2 agencies')).toBeInTheDocument();
    expect(within(cell('Test Agency One', COL.name)).getByRole('link')).toHaveAttribute('href', '/agencies/AGN901');
    expect(within(cell('Test Agency Bare', COL.name)).getByRole('link')).toHaveAttribute('href', '/agencies/AGN902');
    expect(within(cell('Test Agency One', COL.name)).getByText('Test Contact')).toBeInTheDocument();
  });

  it('shows "No agencies" and no table for an empty repository', async () => {
    list.mockResolvedValue({ data: { agencies: [] } });
    mount();
    expect(await screen.findByText('No agencies')).toBeInTheDocument();
    expect(screen.getByText('0 agencies')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a spinner, not the empty state, while the agencies are on their way', async () => {
    let resolve!: (v: unknown) => void;
    list.mockReturnValue(new Promise(r => { resolve = r; }));
    const { container } = mount();
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByText('No agencies')).toBeNull();
    resolve({ data: { agencies: [agency()] } });
    expect(await screen.findByText('Test Agency One')).toBeInTheDocument();
  });

  it('an agency with only a name and a status still renders: every missing detail is a dash, nothing breaks', async () => {
    list.mockResolvedValue({ data: { agencies: [BARE()] } });
    mount();
    await screen.findByText('Test Agency Bare');
    for (const i of [COL.type, COL.tiers, COL.positioning, COL.agreement]) expect(cell('Test Agency Bare', i).textContent).toBe('—');
    expect(cell('Test Agency Bare', COL.billing).textContent).toBe('—');
    expect(within(cell('Test Agency Bare', COL.name)).queryByText('Test Contact')).toBeNull();
  });
});

describe('Agencies — contract status', () => {
  const colour: Array<[string, RegExp]> = [['Active', /bg-green-100/], ['On Hold', /bg-amber-100/], ['Inactive', /bg-gray-100/], ['Anything else', /bg-gray-100/]];
  for (const [status, tone] of colour) {
    it(`${status}: shown as written, in its own colour`, async () => {
      list.mockResolvedValue({ data: { agencies: [agency({ contract_status: status })] } });
      mount();
      await screen.findByText('Test Agency One');
      const badge = within(cell('Test Agency One', COL.status)).getByText(status);
      expect(badge.className).toMatch(tone);
    });
  }

  it('Active, On Hold and Inactive are three different colours', async () => {
    list.mockResolvedValue({ data: { agencies: [agency(), agency({ id: 'A2', name: 'Agency Hold', contract_status: 'On Hold' }), BARE()] } });
    mount();
    await screen.findByText('Test Agency One');
    const cls = (name: string, status: string) => within(cell(name, COL.status)).getByText(status).className;
    expect(new Set([cls('Test Agency One', 'Active'), cls('Agency Hold', 'On Hold'), cls('Test Agency Bare', 'Inactive')]).size).toBe(3);
  });
});

describe('Agencies — commission tiers', () => {
  const lines = (name: string) => Array.from(cell(name, COL.tiers).querySelectorAll('div')).map(d => d.textContent);

  it('shows each tier as "band: rate", one line per tier that has a rate', async () => {
    mount();
    await screen.findByText('Test Agency One');
    expect(lines('Test Agency One')).toEqual(['5-10 LPA: 8.33%', '10-20 LPA: 10%', '20+ LPA: 12%']);
  });

  it('a single flat rate with no band reads "All: rate"', async () => {
    list.mockResolvedValue({ data: { agencies: [agency({ tier1_band: undefined, tier1_rate: '8.33%', tier2_band: undefined, tier2_rate: undefined, tier3_band: undefined, tier3_rate: undefined })] } });
    mount();
    await screen.findByText('Test Agency One');
    expect(lines('Test Agency One')).toEqual(['All: 8.33%']);
  });

  it('a tier without a rate is not listed, and no rate at all is a dash', async () => {
    list.mockResolvedValue({ data: { agencies: [
      agency({ tier2_rate: undefined, tier3_rate: undefined }),
      agency({ id: 'A2', name: 'Agency No Rates', tier1_rate: undefined, tier2_rate: undefined, tier3_rate: undefined }),
    ] } });
    mount();
    await screen.findByText('Test Agency One');
    expect(lines('Test Agency One')).toEqual(['5-10 LPA: 8.33%']);
    expect(cell('Agency No Rates', COL.tiers).textContent).toBe('—');
  });
});

describe('Agencies — hires, replacement guarantee and billing', () => {
  it('shows the lifetime hires, 0 when none are recorded', async () => {
    list.mockResolvedValue({ data: { agencies: [agency(), BARE()] } });
    mount();
    await screen.findByText('Test Agency One');
    expect(cell('Test Agency One', COL.hires).textContent).toBe('3');
    expect(cell('Test Agency Bare', COL.hires).textContent).toBe('0');
  });

  it('shows the replacement window in days, 60 when none is recorded, and its triggers when there are any', async () => {
    list.mockResolvedValue({ data: { agencies: [agency(), BARE()] } });
    mount();
    await screen.findByText('Test Agency One');
    expect(cell('Test Agency One', COL.replacement).textContent).toBe('90d windowLeaves within the window');
    expect(cell('Test Agency Bare', COL.replacement).textContent).toBe('60d window');
  });

  it('a recorded window of 0 days is a real answer and is not replaced by the 60-day default', async () => {
    list.mockResolvedValue({ data: { agencies: [agency({ replacement_guarantee_days: 0 })] } });
    mount();
    await screen.findByText('Test Agency One');
    expect(cell('Test Agency One', COL.replacement).textContent).toContain('0d window');
    expect(cell('Test Agency One', COL.replacement).textContent).not.toContain('60d');
  });

  it('shows the billing window and a late-payment penalty when one is stated', async () => {
    mount();
    await screen.findByText('Test Agency One');
    const billing = cell('Test Agency One', COL.billing);
    expect(within(billing).getByText('45 days')).toBeInTheDocument();
    expect(within(billing).getByText('2% per month')).toBeInTheDocument();
  });

  it('"None stated" is not shown as a penalty, and no window is a dash', async () => {
    list.mockResolvedValue({ data: { agencies: [agency({ billing_late_penalty: 'None stated' }), BARE({ billing_late_penalty: 'None stated' })] } });
    mount();
    await screen.findByText('Test Agency One');
    expect(within(cell('Test Agency One', COL.billing)).queryByText('None stated')).toBeNull();
    expect(within(cell('Test Agency One', COL.billing)).getByText('45 days')).toBeInTheDocument();
    expect(cell('Test Agency Bare', COL.billing).textContent).toBe('—');
  });
});

describe('Agencies — agreement link', () => {
  it('opens the agreement in a new tab, without handing the page over to it', async () => {
    mount();
    await screen.findByText('Test Agency One');
    const link = within(cell('Test Agency One', COL.agreement)).getByRole('link', { name: /View/ });
    expect(link).toHaveAttribute('href', 'https://drive.example/agreement');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('is absent (a dash, not a dead link) when no agreement is on file', async () => {
    list.mockResolvedValue({ data: { agencies: [agency({ agreement_drive_link: undefined })] } });
    mount();
    await screen.findByText('Test Agency One');
    expect(within(cell('Test Agency One', COL.agreement)).queryByRole('link')).toBeNull();
    expect(cell('Test Agency One', COL.agreement).textContent).toBe('—');
  });
});

describe('Agencies — the Add agency button', () => {
  it('is shown, and pressing it does not write anything on its own', async () => {
    mount();
    await screen.findByText('Test Agency One');
    fireEvent.click(screen.getByRole('button', { name: /Add agency/ }));
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByText('Test Agency One')).toBeInTheDocument();       // and the list is still there
  });
});
