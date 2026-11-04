import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import toast from 'react-hot-toast';

// One agency's page: its six editable sections, and the rule every save follows (only what changed is sent, a cleared field
// becomes null, the record is re-read afterwards). The sections are the real EditableSection; only the API and the toast are mocked.
const get = vi.fn();
const update = vi.fn();
vi.mock('../services/api.ts', () => ({ agenciesApi: { get: (id: string) => get(id), update: (id: string, d: unknown) => update(id, d) } }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import AgencyDetail from './AgencyDetail.tsx';

const toastError = vi.mocked(toast.error);
const toastSuccess = vi.mocked(toast.success);

const agency = (over: Record<string, unknown> = {}) => ({
  id: 'AGN901', name: 'Test Agency One', contract_status: 'Active', contact_name: 'Test Contact', contact_email: 'contact@example.test',
  contact_phone: '+91 0000000000', replacement_guarantee_days: 90, tier1_band: '5-10 LPA', tier1_rate: '8.33%', market_positioning: 'Mid-market specialist',
  replacement_triggers: 'Leaves within the window', billing_effective_window: '45 days', specialisations: 'Process engineers',
  agreement_drive_link: 'https://drive.example/agreement', notes: 'Prefers e-mail', total_submitted: 5, total_hired: 3, ...over,
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/agencies/AGN901']}>
        <Routes><Route path="/agencies/:id" element={<AgencyDetail />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const ready = () => screen.findByRole('heading', { level: 1 });
const section = (title: string) => screen.getByRole('heading', { level: 2, name: title }).closest('.card') as HTMLElement;
const edit = (title: string) => fireEvent.click(screen.getByTitle(`Edit ${title}`));
const inputOf = (title: string, label: string) =>
  (within(section(title)).getByText(label).parentElement as HTMLElement).querySelector('input, select, textarea') as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const change = (title: string, label: string, value: string) => fireEvent.change(inputOf(title, label), { target: { value } });
const save = (title: string) => fireEvent.click(within(section(title)).getByRole('button', { name: 'Save' }));

beforeEach(() => {
  get.mockReset(); update.mockReset(); toastError.mockClear(); toastSuccess.mockClear();
  get.mockResolvedValue({ data: { agency: agency() } });
  update.mockResolvedValue({ data: {} });
});

describe('AgencyDetail — the page', () => {
  it('loads the agency named in the address and shows its name, status and counts', async () => {
    mount();
    const heading = await ready();
    expect(heading).toHaveTextContent('Test Agency One');
    expect(get).toHaveBeenCalledWith('AGN901');
    expect(heading.nextElementSibling).toHaveTextContent('Active');          // the badge beside the name (the Contract section also shows the status)
    expect(screen.getByText('5 submitted')).toBeInTheDocument();
    expect(screen.getByText('3 hired')).toBeInTheDocument();
  });

  it('has exactly the six sections, each with its own edit button', async () => {
    mount();
    await ready();
    const titles = ['Contact', 'Contract', 'Commission Tiers', 'Replacement Policy', 'Billing and Payment Terms', 'Notes & Links'];
    for (const t of titles) expect(screen.getByRole('heading', { level: 2, name: t })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(6);
    expect(document.querySelectorAll('button[title^="Edit "]')).toHaveLength(6);
  });

  it('shows what is on file, and a dash for what is not', async () => {
    get.mockResolvedValue({ data: { agency: agency({ contact_phone: undefined }) } });
    mount();
    await ready();
    const contact = within(section('Contact'));
    expect(contact.getByText('Test Contact')).toBeInTheDocument();
    expect(contact.getByText('contact@example.test')).toBeInTheDocument();
    expect(contact.getByText('Contact Phone').nextElementSibling?.textContent).toBe('—');
  });

  it('opens the agreement link in a new tab without handing the page over to it', async () => {
    mount();
    await ready();
    const link = within(section('Notes & Links')).getByRole('link');
    expect(link).toHaveAttribute('href', 'https://drive.example/agreement');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('shows no counts line when the agency carries neither count, and a 0 for the one that is missing', async () => {
    get.mockResolvedValue({ data: { agency: agency({ total_submitted: undefined, total_hired: undefined }) } });
    const first = mount();
    await ready();
    expect(screen.queryByText(/submitted/)).toBeNull();
    expect(screen.queryByText(/ hired$/)).toBeNull();
    first.unmount();

    get.mockResolvedValue({ data: { agency: agency({ total_submitted: undefined, total_hired: 2 }) } });
    const second = mount();
    await ready();
    expect(screen.getByText('0 submitted')).toBeInTheDocument();
    expect(screen.getByText('2 hired')).toBeInTheDocument();
    second.unmount();

    get.mockResolvedValue({ data: { agency: agency({ total_submitted: 4, total_hired: undefined }) } });
    mount();
    await ready();
    expect(screen.getByText('4 submitted')).toBeInTheDocument();
    expect(screen.getByText('0 hired')).toBeInTheDocument();
  });

  const tones: Array<[string, RegExp]> = [['Active', /bg-green-100/], ['On Hold', /bg-amber-100/], ['Inactive', /bg-gray-100/]];
  for (const [status, tone] of tones) {
    it(`${status}: the status badge is in its own colour`, async () => {
      get.mockResolvedValue({ data: { agency: agency({ contract_status: status }) } });
      mount();
      const heading = await ready();
      expect((heading.nextElementSibling as HTMLElement).textContent).toBe(status);
      expect((heading.nextElementSibling as HTMLElement).className).toMatch(tone);
    });
  }

  it('says "Agency not found" when it cannot be loaded, and shows nothing else', async () => {
    get.mockImplementation(async () => { throw new Error('404'); });
    mount();
    expect(await screen.findByText('Agency not found')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByTitle('Edit Contact')).toBeNull();
  });

  it('shows a spinner, not "not found", while it loads', async () => {
    let resolve!: (v: unknown) => void;
    get.mockReturnValue(new Promise(r => { resolve = r; }));
    const { container } = mount();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByText('Agency not found')).toBeNull();
    resolve({ data: { agency: agency() } });
    expect(await ready()).toBeInTheDocument();
  });
});

describe('AgencyDetail — what each section offers to edit', () => {
  type Kind = 'text' | 'number' | 'select' | 'textarea';
  const kindOf = (el: Element): Kind => el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (el as HTMLInputElement).type === 'number' ? 'number' : 'text';
  const SECTIONS: Array<[string, Array<[string, Kind]>]> = [
    ['Contact', [['Agency Name', 'text'], ['Contact Name', 'text'], ['Contact Email', 'text'], ['Contact Phone', 'text']]],
    ['Contract', [['Status', 'select'], ['Replacement Guarantee (days)', 'number']]],
    ['Commission Tiers', [
      ['Tier 1 Band', 'text'], ['Tier 1 Rate', 'text'], ['Tier 2 Band', 'text'], ['Tier 2 Rate', 'text'], ['Tier 3 Band', 'text'], ['Tier 3 Rate', 'text'],
      ['CTC Definition (what the fee is calculated on)', 'textarea'], ['Market Positioning', 'textarea'],
    ]],
    ['Replacement Policy', [
      ['Triggers (what qualifies)', 'textarea'], ['Exclusions (what doesn\'t)', 'textarea'], ['Remedy if no replacement', 'textarea'], ['Conditions to stay valid', 'textarea'],
    ]],
    ['Billing and Payment Terms', [
      ['Invoice Trigger', 'text'], ['Invoice Raised', 'text'], ['Payment Due', 'text'], ['Effective Total Window', 'text'], ['Late Payment Penalty', 'textarea'],
    ]],
    ['Notes & Links', [['Specialisations', 'textarea'], ['Agreement Link', 'text'], ['Notes', 'textarea']]],
  ];

  it.each(SECTIONS)('%s: exactly these fields, in this order, each in the right kind of input', async (title, expected) => {
    mount();
    await ready();
    edit(title);
    const fields = Array.from(section(title).querySelectorAll('label')).map(l => [l.textContent, kindOf((l.parentElement as HTMLElement).querySelector('input, select, textarea') as Element)]);
    expect(fields).toEqual(expected);
  });
});

describe('AgencyDetail — saving a section', () => {
  it('sends only the fields that changed, says the section was updated and re-reads the agency', async () => {
    mount();
    await ready();
    edit('Contact');
    change('Contact', 'Agency Name', 'Renamed Agency');
    save('Contact');
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith('AGN901', { name: 'Renamed Agency' });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Contact updated'));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('shows the new value once the re-read answers, and leaves edit mode', async () => {
    mount();
    await ready();
    edit('Contact');
    change('Contact', 'Agency Name', 'Renamed Agency');
    get.mockResolvedValue({ data: { agency: agency({ name: 'Renamed Agency' }) } });
    save('Contact');
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Renamed Agency'));
    expect(within(section('Contact')).queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('several changes in one section go out together: a select as text, a number as a number', async () => {
    mount();
    await ready();
    edit('Contract');
    change('Contract', 'Status', 'On Hold');
    change('Contract', 'Replacement Guarantee (days)', '45');
    save('Contract');
    await waitFor(() => expect(update).toHaveBeenCalledWith('AGN901', { contract_status: 'On Hold', replacement_guarantee_days: 45 }));
  });

  it('the Status choices are Active, Inactive and On Hold', async () => {
    mount();
    await ready();
    edit('Contract');
    const select = inputOf('Contract', 'Status') as HTMLSelectElement;
    expect(Array.from(select.options).map(o => o.value)).toEqual(['Active', 'Inactive', 'On Hold']);
    expect(select.value).toBe('Active');
  });

  it('a field that is emptied is sent as null, not as an empty string', async () => {
    mount();
    await ready();
    edit('Contact');
    change('Contact', 'Contact Phone', '');
    save('Contact');
    await waitFor(() => expect(update).toHaveBeenCalledWith('AGN901', { contact_phone: null }));
  });

  it('a long-text field is edited in a text area and saved like any other', async () => {
    mount();
    await ready();
    edit('Commission Tiers');
    expect(inputOf('Commission Tiers', 'Market Positioning').tagName).toBe('TEXTAREA');
    change('Commission Tiers', 'Market Positioning', 'Premium specialist');
    save('Commission Tiers');
    await waitFor(() => expect(update).toHaveBeenCalledWith('AGN901', { market_positioning: 'Premium specialist' }));
  });

  it('saving without changing anything sends nothing and just leaves edit mode', async () => {
    mount();
    await ready();
    edit('Contact');
    save('Contact');
    await waitFor(() => expect(within(section('Contact')).queryByRole('button', { name: 'Save' })).toBeNull());
    expect(update).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('Cancel puts the old value back and sends nothing', async () => {
    mount();
    await ready();
    edit('Contact');
    change('Contact', 'Agency Name', 'Typed Then Abandoned');
    fireEvent.click(within(section('Contact')).getByRole('button', { name: 'Cancel' }));
    expect(within(section('Contact')).getByText('Test Agency One')).toBeInTheDocument();
    expect(within(section('Contact')).queryByText('Typed Then Abandoned')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('a section is edited on its own: opening one leaves the others in read mode', async () => {
    mount();
    await ready();
    edit('Contact');
    expect(within(section('Contact')).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    for (const other of ['Contract', 'Commission Tiers', 'Replacement Policy', 'Billing and Payment Terms', 'Notes & Links']) {
      expect(within(section(other)).queryByRole('button', { name: 'Save' })).toBeNull();
    }
  });

  it('a failed save says so, keeps the section open with what was typed, and does not re-read', async () => {
    update.mockImplementation(async () => { throw new Error('boom'); });
    mount();
    await ready();
    edit('Contact');
    change('Contact', 'Agency Name', 'Renamed Agency');
    save('Contact');
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to update Contact'));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(inputOf('Contact', 'Agency Name')).toHaveValue('Renamed Agency');
    expect(within(section('Contact')).getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('AgencyDetail — every field is saved under its own column', () => {
  // [section, the label people read, the key the server column is called, what is typed]. The label is only for people: the key
  // decides which column is written, so a mistyped key would save a field into the wrong place while every label still looked right.
  const FIELDS: Array<[string, string, string, string]> = [
    ['Contact', 'Agency Name', 'name', 'x'], ['Contact', 'Contact Name', 'contact_name', 'x'],
    ['Contact', 'Contact Email', 'contact_email', 'x'], ['Contact', 'Contact Phone', 'contact_phone', 'x'],
    ['Contract', 'Status', 'contract_status', 'Inactive'], ['Contract', 'Replacement Guarantee (days)', 'replacement_guarantee_days', '7'],
    ['Commission Tiers', 'Tier 1 Band', 'tier1_band', 'x'], ['Commission Tiers', 'Tier 1 Rate', 'tier1_rate', 'x'],
    ['Commission Tiers', 'Tier 2 Band', 'tier2_band', 'x'], ['Commission Tiers', 'Tier 2 Rate', 'tier2_rate', 'x'],
    ['Commission Tiers', 'Tier 3 Band', 'tier3_band', 'x'], ['Commission Tiers', 'Tier 3 Rate', 'tier3_rate', 'x'],
    ['Commission Tiers', 'CTC Definition (what the fee is calculated on)', 'ctc_definition', 'x'], ['Commission Tiers', 'Market Positioning', 'market_positioning', 'x'],
    ['Replacement Policy', 'Triggers (what qualifies)', 'replacement_triggers', 'x'], ['Replacement Policy', 'Exclusions (what doesn\'t)', 'replacement_exclusions', 'x'],
    ['Replacement Policy', 'Remedy if no replacement', 'replacement_remedy', 'x'], ['Replacement Policy', 'Conditions to stay valid', 'replacement_conditions', 'x'],
    ['Billing and Payment Terms', 'Invoice Trigger', 'billing_invoice_trigger', 'x'], ['Billing and Payment Terms', 'Invoice Raised', 'billing_invoice_raised', 'x'],
    ['Billing and Payment Terms', 'Payment Due', 'billing_payment_due', 'x'], ['Billing and Payment Terms', 'Effective Total Window', 'billing_effective_window', 'x'],
    ['Billing and Payment Terms', 'Late Payment Penalty', 'billing_late_penalty', 'x'],
    ['Notes & Links', 'Specialisations', 'specialisations', 'x'], ['Notes & Links', 'Agreement Link', 'agreement_drive_link', 'x'], ['Notes & Links', 'Notes', 'notes', 'x'],
  ];

  it.each(FIELDS)('%s › %s is sent as %s', async (title, label, key, typed) => {
    mount();
    await ready();
    edit(title);
    change(title, label, typed);
    save(title);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith('AGN901', { [key]: key === 'replacement_guarantee_days' ? Number(typed) : typed });
  });

  it('the table above lists every field the page offers, in the page\'s order, so a new field cannot go unchecked', async () => {
    mount();
    await ready();
    const sections = Array.from(new Set(FIELDS.map(f => f[0])));
    for (const title of sections) edit(title);
    const offered = sections.flatMap(title => Array.from(section(title).querySelectorAll('label')).map(l => [title, l.textContent]));
    expect(offered).toEqual(FIELDS.map(([title, label]) => [title, label]));
  });
});
