import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import toast from 'react-hot-toast';

// User Management (Super Admin only, guarded at the route): who can be given which role, who can be switched off, and what each
// action sends. The rules checked here are the ones the backend also enforces, so that the screen never offers what the server
// would refuse: Super Admin is never a role anyone can pick, the Super Admin row has no controls, and nobody can switch off
// their own access.
const list = vi.fn();
const create = vi.fn();
const update = vi.fn();
vi.mock('../services/api.ts', () => ({
  usersApi: { list: () => list(), create: (d: unknown) => create(d), update: (id: string, d: unknown) => update(id, d) },
}));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const auth = vi.hoisted(() => ({ id: 'u-self' }));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: auth.id, name: 'Test Self', email: 'test.self@example.test', persona: 'super_admin' } }),
}));

import UserManagement from './UserManagement.tsx';

const toastError = vi.mocked(toast.error);
const toastSuccess = vi.mocked(toast.success);

const user = (over: Record<string, unknown>) => ({
  id: 'u-x', name: 'Test User', email: 'test.user@example.test', persona: 'hr_recruiter', department: 'HR', is_active: true,
  auth_provider: 'google', created_at: '2026-09-01T00:00:00Z', last_login: '2026-10-27T12:00:00Z', ...over,
});
const ADMIN   = user({ id: 'u-admin', name: 'Test Admin',   email: 'test.admin@example.test',   persona: 'super_admin',    department: 'Founders Office' });
const SELF    = user({ id: 'u-self',  name: 'Test Self',    email: 'test.self@example.test',    persona: 'hr_recruiter',   department: 'HR' });
const MANAGER = user({ id: 'u-hm',    name: 'Test Manager', email: 'test.manager@example.test', persona: 'hiring_manager', department: undefined, last_login: null });
const LEAD    = user({ id: 'u-lead',  name: 'Test Lead',    email: 'test.lead@example.test',    persona: 'leadership',     department: 'Ops', is_active: false });
const USERS = [ADMIN, SELF, MANAGER, LEAD];

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><UserManagement /></QueryClientProvider>);
}
const row = (email: string) => screen.getByText(email).closest('tr') as HTMLTableRowElement;
const modal = () => screen.getByRole('heading', { name: /^(Add user|Edit user)$/ }).closest('div.fixed') as HTMLElement;
const inModal = (label: string) => (within(modal()).getByText(label).parentElement as HTMLElement).querySelector('input, select') as HTMLInputElement | HTMLSelectElement;
const setIn = (label: string, value: string) => fireEvent.change(inModal(label), { target: { value } });
const modalClosed = () => expect(screen.queryByRole('heading', { name: /^(Add user|Edit user)$/ })).toBeNull();
const failWith = (fn: typeof update, err: unknown) => fn.mockImplementation(async () => { throw err; });

beforeEach(() => {
  list.mockReset(); create.mockReset(); update.mockReset(); toastError.mockClear(); toastSuccess.mockClear();
  auth.id = 'u-self';
  list.mockResolvedValue({ data: { users: USERS } });
  create.mockResolvedValue({ data: {} });
  update.mockResolvedValue({ data: {} });
  // "2 days ago" must not depend on the day the test runs; only Date is frozen, so queries and waits keep their real timers
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('UserManagement — the list', () => {
  it('shows each user\'s name, email, role, department, status and when they last signed in', async () => {
    mount();
    await screen.findByText('test.self@example.test');
    expect(screen.getByText('4 users')).toBeInTheDocument();
    const cells = (email: string) => Array.from(row(email).cells).map(c => c.textContent);
    expect(cells('test.self@example.test').slice(0, 6)).toEqual(['Test Self', 'test.self@example.test', 'HR/Admin', 'HR', 'Active', '2 days ago']);
    expect(cells('test.manager@example.test').slice(0, 6)).toEqual(['Test Manager', 'test.manager@example.test', 'Hiring Manager', '—', 'Active', 'Never']);
    expect(cells('test.lead@example.test').slice(0, 6)).toEqual(['Test Lead', 'test.lead@example.test', 'Leadership', 'Ops', 'Inactive', '2 days ago']);
    expect(cells('test.admin@example.test').slice(2, 3)).toEqual(['Super Admin']);
  });

  it('a user who has never signed in shows "Never"', async () => {
    list.mockResolvedValue({ data: { users: [user({ id: 'u-new', email: 'test.new@example.test', last_login: undefined })] } });
    mount();
    await screen.findByText('test.new@example.test');
    expect(row('test.new@example.test').cells[5].textContent).toBe('Never');
  });

  it('shows "No users" and no table when there are none', async () => {
    list.mockResolvedValue({ data: { users: [] } });
    mount();
    expect(await screen.findByText('No users')).toBeInTheDocument();
    expect(screen.getByText('0 users')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a spinner, not the empty state, while the list is on its way', async () => {
    let resolve!: (v: unknown) => void;
    list.mockReturnValue(new Promise(r => { resolve = r; }));
    const { container } = mount();
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByText('No users')).toBeNull();
    resolve({ data: { users: USERS } });
    expect(await screen.findByText('test.self@example.test')).toBeInTheDocument();
  });
});

describe('UserManagement — who has controls', () => {
  it('the Super Admin row has no Edit or Deactivate button at all', async () => {
    mount();
    await screen.findByText('test.admin@example.test');
    expect(within(row('test.admin@example.test')).queryAllByRole('button')).toHaveLength(0);
  });

  it('still none when the Super Admin is the person looking at the page', async () => {
    auth.id = 'u-admin';
    mount();
    await screen.findByText('test.admin@example.test');
    expect(within(row('test.admin@example.test')).queryAllByRole('button')).toHaveLength(0);
  });

  it('your own row can be edited but not switched off: Deactivate is disabled and does nothing', async () => {
    mount();
    await screen.findByText('test.self@example.test');
    const own = within(row('test.self@example.test'));
    expect(own.getByRole('button', { name: 'Edit' })).toBeEnabled();
    const deactivate = own.getByRole('button', { name: 'Deactivate' });
    expect(deactivate).toBeDisabled();
    fireEvent.click(deactivate);
    expect(update).not.toHaveBeenCalled();
  });

  it('other users can be edited and switched off or back on: an active one offers Deactivate, an inactive one Reactivate', async () => {
    mount();
    await screen.findByText('test.manager@example.test');
    const manager = within(row('test.manager@example.test'));
    expect(manager.getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(manager.getByRole('button', { name: 'Deactivate' })).toBeEnabled();
    const lead = within(row('test.lead@example.test'));
    expect(lead.getByRole('button', { name: 'Reactivate' })).toBeEnabled();
    expect(lead.queryByRole('button', { name: 'Deactivate' })).toBeNull();
  });

  it('"yourself" is decided by user id: the same name on another row is not you', async () => {
    list.mockResolvedValue({ data: { users: [SELF, user({ id: 'u-twin', name: 'Test Self', email: 'test.twin@example.test' })] } });
    mount();
    await screen.findByText('test.twin@example.test');
    expect(within(row('test.twin@example.test')).getByRole('button', { name: 'Deactivate' })).toBeEnabled();
    expect(within(row('test.self@example.test')).getByRole('button', { name: 'Deactivate' })).toBeDisabled();
  });
});

describe('UserManagement — switching access off and on', () => {
  it('Deactivate sends is_active false, says access was revoked and re-reads the list', async () => {
    mount();
    await screen.findByText('test.manager@example.test');
    fireEvent.click(within(row('test.manager@example.test')).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('u-hm', { is_active: false }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Access revoked'));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('Reactivate sends is_active true and says access was restored', async () => {
    mount();
    await screen.findByText('test.lead@example.test');
    fireEvent.click(within(row('test.lead@example.test')).getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('u-lead', { is_active: true }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Access restored'));
  });

  it('a refused change shows the server\'s own message, or a generic one, and leaves the button usable', async () => {
    mount();
    await screen.findByText('test.manager@example.test');
    failWith(update, Object.assign(new Error('Forbidden'), { response: { data: { error: 'Cannot deactivate the last HR user' } } }));
    fireEvent.click(within(row('test.manager@example.test')).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Cannot deactivate the last HR user'));
    await waitFor(() => expect(within(row('test.manager@example.test')).getByRole('button', { name: 'Deactivate' })).toBeEnabled());

    failWith(update, new Error('Network Error'));
    fireEvent.click(within(row('test.manager@example.test')).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to update user'));
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe('UserManagement — the role a user can be given', () => {
  it('Add user offers HR/Admin, Hiring Manager and Leadership, exactly, and never Super Admin', async () => {
    mount();
    await screen.findByText('test.self@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    const select = inModal('Role') as HTMLSelectElement;
    expect(Array.from(select.options).map(o => [o.value, o.textContent])).toEqual([
      ['hr_recruiter', 'HR/Admin'], ['hiring_manager', 'Hiring Manager'], ['leadership', 'Leadership'],
    ]);
    expect(screen.queryByRole('option', { name: /Super/i })).toBeNull();
    expect(select.value).toBe('hr_recruiter');                      // the default
  });

  it('Edit offers the same three, with the user\'s own role chosen', async () => {
    mount();
    await screen.findByText('test.lead@example.test');
    fireEvent.click(within(row('test.lead@example.test')).getByRole('button', { name: 'Edit' }));
    const select = inModal('Role') as HTMLSelectElement;
    expect(Array.from(select.options).map(o => o.value)).toEqual(['hr_recruiter', 'hiring_manager', 'leadership']);
    expect(select.value).toBe('leadership');
  });
});

describe('UserManagement — adding a user', () => {
  const open = async () => {
    mount();
    await screen.findByText('test.self@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
  };
  const save = () => fireEvent.click(within(modal()).getByRole('button', { name: 'Add user' }));

  it('needs a name, then an email, and sends nothing without them (spaces do not count)', async () => {
    await open();
    save();
    expect(toastError).toHaveBeenLastCalledWith('Name is required');
    setIn('Name', '   ');
    save();
    expect(toastError).toHaveBeenLastCalledWith('Name is required');
    setIn('Name', 'Test Newcomer');
    save();
    expect(toastError).toHaveBeenLastCalledWith('Email is required');
    setIn('Email', '  ');
    save();
    expect(toastError).toHaveBeenLastCalledWith('Email is required');
    expect(create).not.toHaveBeenCalled();
    expect(modal()).toBeInTheDocument();
  });

  it('sends the trimmed fields, HR/Admin by default, and no department when it is left blank', async () => {
    await open();
    setIn('Name', '  Test Newcomer ');
    setIn('Email', ' test.newcomer@example.test ');
    save();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0][0];
    expect(payload).toMatchObject({ name: 'Test Newcomer', email: 'test.newcomer@example.test', persona: 'hr_recruiter' });
    expect(payload.department).toBeUndefined();
  });

  it('sends the chosen role and a trimmed department, then says "User added", closes the dialog and re-reads the list', async () => {
    await open();
    setIn('Name', 'Test Newcomer');
    setIn('Email', 'test.newcomer@example.test');
    setIn('Role', 'leadership');
    setIn('Department', '  Operations ');
    save();
    await waitFor(() => expect(create).toHaveBeenCalledWith({
      name: 'Test Newcomer', email: 'test.newcomer@example.test', persona: 'leadership', department: 'Operations',
    }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('User added'));
    await waitFor(modalClosed);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('a refused save shows the server\'s message (or a generic one) and keeps the dialog and what was typed', async () => {
    await open();
    setIn('Name', 'Test Newcomer');
    setIn('Email', 'test.newcomer@example.test');
    failWith(create, Object.assign(new Error('Conflict'), { response: { data: { error: 'A user with this email already exists' } } }));
    save();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('A user with this email already exists'));
    expect(modal()).toBeInTheDocument();
    expect(inModal('Name')).toHaveValue('Test Newcomer');

    failWith(create, new Error('Network Error'));
    save();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to save user'));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);                          // nothing was added, so nothing was re-read
  });

  it('Cancel closes the dialog without sending anything', async () => {
    await open();
    setIn('Name', 'Test Newcomer');
    fireEvent.click(within(modal()).getByRole('button', { name: 'Cancel' }));
    modalClosed();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('UserManagement — editing a user', () => {
  const open = async (email: string) => {
    mount();
    await screen.findByText(email);
    fireEvent.click(within(row(email)).getByRole('button', { name: 'Edit' }));
  };

  it('starts from what the user has now', async () => {
    await open('test.self@example.test');
    expect(inModal('Name')).toHaveValue('Test Self');
    expect(inModal('Email')).toHaveValue('test.self@example.test');
    expect(inModal('Role')).toHaveValue('hr_recruiter');
    expect(inModal('Department')).toHaveValue('HR');
  });

  it('a user with no department starts with an empty one', async () => {
    await open('test.manager@example.test');
    expect(inModal('Department')).toHaveValue('');
  });

  it('saves the edited user by id, says "User updated", closes the dialog and re-reads the list', async () => {
    await open('test.manager@example.test');
    setIn('Name', 'Test Manager Renamed');
    setIn('Role', 'leadership');
    setIn('Department', 'Ops');
    fireEvent.click(within(modal()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('u-hm', {
      name: 'Test Manager Renamed', email: 'test.manager@example.test', persona: 'leadership', department: 'Ops',
    }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('User updated'));
    await waitFor(modalClosed);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(create).not.toHaveBeenCalled();
  });

  it('emptying the name is refused in the same way as for a new user', async () => {
    await open('test.manager@example.test');
    setIn('Name', '');
    fireEvent.click(within(modal()).getByRole('button', { name: 'Save' }));
    expect(toastError).toHaveBeenCalledWith('Name is required');
    expect(update).not.toHaveBeenCalled();
  });
});
