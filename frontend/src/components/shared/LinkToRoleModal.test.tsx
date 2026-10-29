import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// "Link to a role": the Unmatched Candidates panel (channel "Job Application Form"), Archived Pipeline's Reactivate
// ("Talent Pool Reactivation") and the Candidate page's Add Application ("Manual Add") all use this one dialog.
const h = vi.hoisted(() => ({ linkRole: vi.fn(), rolesList: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock('../../services/api.ts', () => ({
  candidatesApi: { linkRole: (...a: unknown[]) => h.linkRole(...a) },
  rolesApi: { list: (p: unknown) => h.rolesList(p) },
}));
vi.mock('react-hot-toast', () => ({ default: { success: (m: string) => h.toastSuccess(m), error: (m: string) => h.toastError(m) } }));

import LinkToRoleModal from './LinkToRoleModal.tsx';

const ROLES = [{ id: 'R9001', title: 'Test Role Alpha' }, { id: 'R9002', title: 'Test Role Beta' }, { id: 'R9003', title: 'Test Role Gamma' }];

function mount(over: Partial<Parameters<typeof LinkToRoleModal>[0]> = {}) {
  const onClose = vi.fn();
  const onLinked = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LinkToRoleModal candidate={{ id: 'C9001', full_name: 'Test Candidate' }} sourceChannel="Manual Add" onClose={onClose} onLinked={onLinked} {...over} />
    </QueryClientProvider>,
  );
  return { onClose, onLinked };
}
const picker = () => screen.getByDisplayValue('Select a role…') as HTMLSelectElement;
const optionTitles = () => Array.from(picker().options).slice(1).map(o => o.textContent);
const link = () => screen.getByRole('button', { name: /^(Link|Linking…)$/ });
const choose = async (id: string) => {
  await screen.findByRole('option', { name: ROLES.find(r => r.id === id)!.title });
  fireEvent.change(picker(), { target: { value: id } });
};

beforeEach(() => {
  for (const f of [h.linkRole, h.rolesList, h.toastSuccess, h.toastError]) f.mockReset();
  h.rolesList.mockResolvedValue({ data: { roles: ROLES } });
  h.linkRole.mockResolvedValue({ data: {} });
});

describe('LinkToRoleModal — which roles are offered', () => {
  it('names the candidate and offers only roles that are Live – Sourcing', async () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Link Test Candidate to a role' })).toBeInTheDocument();
    await screen.findByRole('option', { name: 'Test Role Alpha' });
    expect(h.rolesList).toHaveBeenCalledWith({ status: 'Live – Sourcing' });
    expect(optionTitles()).toEqual(['Test Role Alpha', 'Test Role Beta', 'Test Role Gamma']);
  });

  it('leaves out the roles the candidate already has an application for', async () => {
    mount({ excludeRoleIds: ['R9001', 'R9003'] });
    await screen.findByRole('option', { name: 'Test Role Beta' });
    expect(optionTitles()).toEqual(['Test Role Beta']);
  });

  it('with nothing to exclude (or an empty list) every role is offered', async () => {
    mount({ excludeRoleIds: [] });
    await screen.findByRole('option', { name: 'Test Role Alpha' });
    expect(optionTitles()).toHaveLength(3);
  });

  it('offers nothing but the placeholder while the roles are still loading', () => {
    h.rolesList.mockReturnValue(new Promise(() => {}));
    mount();
    expect(optionTitles()).toEqual([]);
    expect(link()).toBeDisabled();
  });
});

describe('LinkToRoleModal — linking', () => {
  it('Link stays disabled until a role is picked, and clicking it does nothing', async () => {
    mount();
    await screen.findByRole('option', { name: 'Test Role Alpha' });
    expect(link()).toBeDisabled();
    fireEvent.click(link());
    expect(h.linkRole).not.toHaveBeenCalled();
    fireEvent.change(picker(), { target: { value: 'R9002' } });
    expect(link()).toBeEnabled();
  });

  it('links the picked role with the caller\'s source channel, tells the user, then reports back and closes', async () => {
    const { onClose, onLinked } = mount({ sourceChannel: 'Talent Pool Reactivation' });
    await choose('R9002');
    fireEvent.click(link());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(h.linkRole).toHaveBeenCalledTimes(1);
    expect(h.linkRole).toHaveBeenCalledWith('C9001', { role_id: 'R9002', source_channel: 'Talent Pool Reactivation' });
    expect(h.toastSuccess).toHaveBeenCalledWith('Candidate linked to role');
    expect(onLinked).toHaveBeenCalledTimes(1);
  });

  it('each caller\'s own channel is what gets recorded', async () => {
    for (const channel of ['Job Application Form', 'Manual Add']) {
      h.linkRole.mockClear();
      const { onClose } = mount({ sourceChannel: channel });
      await choose('R9001');
      fireEvent.click(link());
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(h.linkRole).toHaveBeenCalledWith('C9001', { role_id: 'R9001', source_channel: channel });
      cleanup();
    }
  });

  it('a refused link shows the server\'s reason and leaves the dialog open and usable', async () => {
    h.linkRole.mockImplementation(async () => { throw { response: { data: { error: 'Already linked to this role' } } }; });
    const { onClose, onLinked } = mount();
    await choose('R9001');
    fireEvent.click(link());
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Already linked to this role'));
    expect(onClose).not.toHaveBeenCalled();
    expect(onLinked).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
    await waitFor(() => expect(link()).toBeEnabled());
  });

  it('falls back to a generic message when the failure carries no reason', async () => {
    h.linkRole.mockImplementation(async () => { throw new Error('network down'); });
    mount();
    await choose('R9001');
    fireEvent.click(link());
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Failed to link candidate'));
  });

  it('while linking the button reads Linking… and is disabled, so it cannot be sent twice', async () => {
    let finish!: () => void;
    h.linkRole.mockImplementation(() => new Promise(res => { finish = () => res({ data: {} }); }));
    const { onClose } = mount();
    await choose('R9001');
    fireEvent.click(link());
    const busy = await screen.findByRole('button', { name: 'Linking…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(h.linkRole).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Cancel closes without linking anyone', async () => {
    const { onClose, onLinked } = mount();
    await choose('R9001');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onLinked).not.toHaveBeenCalled();
    expect(h.linkRole).not.toHaveBeenCalled();
  });
});
