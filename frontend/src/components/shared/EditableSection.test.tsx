import '../../test/loadTolerance.ts';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import EditableSection from './EditableSection.tsx';
import type { FieldConfig } from './EditableSection.tsx';

// The config-driven read / edit card behind the Candidate, Role and Agency pages' sections. What it pins: how each field type is
// shown and edited, that Save sends ONLY what changed (converted to the right type), the required / dependent / hidden / read-only
// rules, and that a refused save keeps the user's edits. Titles, labels and data here are invented.
const h = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: { success: (m: string) => h.toastSuccess(m), error: (m: string) => h.toastError(m) } }));

const TITLE = 'Test Section';
type Data = Record<string, unknown>;
const mount = (fields: FieldConfig[], data: Data, extra: { onSave?: (c: Record<string, unknown>) => Promise<void>; pendingLabels?: Record<string, string> } = {}) => {
  const onSave = extra.onSave ?? vi.fn(async () => {});
  const view = render(<EditableSection title={TITLE} data={data} fields={fields} onSave={onSave} pendingLabels={extra.pendingLabels} />);
  return { ...view, onSave: onSave as ReturnType<typeof vi.fn> };
};
const field = (label: string) => screen.getByText(label).parentElement as HTMLElement;
const valueOf = (label: string) => (screen.getByText(label).nextElementSibling as HTMLElement).textContent;
const edit = () => fireEvent.click(screen.getByTitle(`Edit ${TITLE}`));
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));
const input = (label: string) => field(label).querySelector('input, textarea, select') as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(input(label), { target: { value } });
const text = (key: string, label: string, extra: Partial<FieldConfig> = {}): FieldConfig => ({ key, label, type: 'text', ...extra });

beforeEach(() => { h.toastSuccess.mockReset(); h.toastError.mockReset(); });

describe('EditableSection — read mode', () => {
  it('shows the title and a label / value pair for each field, with a dash for anything empty', () => {
    mount([text('name', 'Name'), text('nick', 'Nickname'), text('blank', 'Blank'), text('absent', 'Absent')], { name: 'Test Name', nick: null, blank: '' });
    expect(screen.getByRole('heading', { name: TITLE })).toBeInTheDocument();
    expect(valueOf('Name')).toBe('Test Name');
    for (const label of ['Nickname', 'Blank', 'Absent']) expect(valueOf(label)).toBe('—');
  });

  it('a zero is a value, not an empty field (for a number, and for a plain text)', () => {
    mount([{ key: 'n', label: 'Count', type: 'number' }, text('t', 'Text')], { n: 0, t: 0 });
    expect(valueOf('Count')).toBe('0');
    expect(valueOf('Text')).toBe('0');
  });

  it.each([
    ['boolean true', { key: 'k', label: 'F', type: 'boolean' }, true, 'Yes'],
    ['boolean false', { key: 'k', label: 'F', type: 'boolean' }, false, 'No'],
    ['boolean never set', { key: 'k', label: 'F', type: 'boolean' }, null, '—'],
    ['tags', { key: 'k', label: 'F', type: 'tags' }, ['a', 'b'], 'a, b'],
    ['an empty list of tags', { key: 'k', label: 'F', type: 'tags' }, [], '—'],
    ['multiselect', { key: 'k', label: 'F', type: 'multiselect' }, ['x', 'y'], 'x, y'],
    ['a date stored with a time', { key: 'k', label: 'F', type: 'date' }, '2026-10-20T10:30:00.000Z', '2026-10-20'],
    ['json', { key: 'k', label: 'F', type: 'json' }, { a: 1, b: [2] }, '{"a":1,"b":[2]}'],
    ['a number', { key: 'k', label: 'F', type: 'number' }, 12.5, '12.5'],
  ] as [string, FieldConfig, unknown, string][])('shows %s as the right text', (_what, config, value, shown) => {
    mount([config], { k: value });
    expect(valueOf('F')).toBe(shown);
  });

  it('does not show a hidden field, in read mode or in edit mode', () => {
    mount([text('name', 'Name'), text('secret', 'Secret', { hidden: true })], { name: 'Test Name', secret: 'do not show' });
    expect(screen.queryByText('Secret')).not.toBeInTheDocument();
    expect(screen.queryByText('do not show')).not.toBeInTheDocument();
    edit();
    expect(screen.queryByText('Secret')).not.toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('a linkified field is a link that opens in a new tab safely; with no value it is just a dash', () => {
    const { unmount } = mount([text('link', 'Drive link', { linkify: true })], { link: 'https://files.example.test/a' });
    const a = screen.getByRole('link');
    expect(a).toHaveAttribute('href', 'https://files.example.test/a');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a.getAttribute('rel')).toMatch(/noopener/);
    expect(a.getAttribute('rel')).toMatch(/noreferrer/);
    unmount();
    mount([text('link', 'Drive link', { linkify: true })], { link: '' });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(valueOf('Drive link')).toBe('—');
  });

  it('displayKey shows ANOTHER key\'s value (an id stored, a name shown)', () => {
    mount([text('agency_id', 'Agency', { displayKey: 'agency_name' })], { agency_id: 'AGN9001', agency_name: 'Test Agency' });
    expect(valueOf('Agency')).toBe('Test Agency');
  });

  it('a dependsOn field is shown only while the key it depends on has that value', () => {
    const fields = [text('source', 'Source'), text('agency', 'Agency name', { dependsOn: { key: 'source', value: 'via-agency' } })];
    const { unmount } = mount(fields, { source: 'via-agency', agency: 'Test Agency' });
    expect(valueOf('Agency name')).toBe('Test Agency');
    unmount();
    mount(fields, { source: 'LinkedIn', agency: 'Test Agency' });
    expect(screen.queryByText('Agency name')).not.toBeInTheDocument();
    expect(screen.queryByText('Test Agency')).not.toBeInTheDocument();
  });

  it('a pending label replaces the dash while the field is empty (with a spinner), and gives way to the value once it arrives', () => {
    const fields = [text('jd', 'JD link')];
    const { unmount } = mount(fields, { jd: null }, { pendingLabels: { jd: 'Generating JD…' } });
    expect(screen.getByText('Generating JD…')).toBeInTheDocument();
    expect(document.querySelector('.animate-spin')).not.toBeNull();
    unmount();
    mount(fields, { jd: 'https://files.example.test/jd' }, { pendingLabels: { jd: 'Generating JD…' } });
    expect(screen.queryByText('Generating JD…')).not.toBeInTheDocument();
    expect(valueOf('JD link')).toBe('https://files.example.test/jd');
  });
});

describe('EditableSection — edit mode', () => {
  it('the pencil opens every field as an input filled from the data, with Save and Cancel, and the pencil goes', () => {
    mount([
      text('name', 'Name'), { key: 'n', label: 'Count', type: 'number' }, { key: 'bio', label: 'Bio', type: 'textarea' },
      { key: 'kind', label: 'Kind', type: 'select', options: ['one', 'two'], optionLabels: { one: 'First one' } },
      { key: 'active', label: 'Active', type: 'boolean' }, { key: 'tags', label: 'Tags', type: 'tags' },
      { key: 'start', label: 'Start', type: 'date' }, { key: 'cfg', label: 'Config', type: 'json' },
    ], { name: 'Test Name', n: 7, bio: 'Test bio', kind: 'two', active: true, tags: ['a', 'b'], start: '2026-10-20T10:30:00Z', cfg: { a: 1 } });
    edit();
    expect(screen.queryByTitle(`Edit ${TITLE}`)).not.toBeInTheDocument();
    expect(input('Name')).toHaveValue('Test Name');
    expect(input('Count')).toHaveValue(7);
    expect(input('Count')).toHaveAttribute('type', 'number');
    expect(input('Bio')).toHaveValue('Test bio');
    expect(input('Kind')).toHaveValue('two');
    expect(Array.from((input('Kind') as unknown as HTMLSelectElement).options).map(o => o.textContent)).toEqual(['First one', 'two']);   // optionLabels, else the raw value
    expect(input('Active')).toBeChecked();
    expect(input('Tags')).toHaveValue('a, b');
    expect(input('Start')).toHaveValue('2026-10-20');
    expect(input('Start')).toHaveAttribute('type', 'date');
    expect(input('Config')).toHaveValue(JSON.stringify({ a: 1 }, null, 2));
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('a hint shows under its input in edit mode only', () => {
    mount([text('name', 'Name', { hint: 'Write it as First Last' })], { name: 'x' });
    expect(screen.queryByText('Write it as First Last')).not.toBeInTheDocument();
    edit();
    expect(screen.getByText('Write it as First Last')).toBeInTheDocument();
  });

  it('a read-only field is shown as text next to the inputs, and is never sent', async () => {
    const { onSave } = mount([text('name', 'Name'), text('approver', 'Approved by', { readOnly: true })], { name: 'Test Name', approver: 'Test Approver' });
    edit();
    expect(screen.getByText('Test Approver')).toBeInTheDocument();
    expect(field('Approved by').querySelector('input')).toBeNull();
    type('Name', 'Other Name');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ name: 'Other Name' }));
  });

  it('Cancel throws the edits away, calls nothing, and the next edit starts from the saved values again', () => {
    const { onSave } = mount([text('name', 'Name')], { name: 'Test Name' });
    edit();
    type('Name', 'Typed and abandoned');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(valueOf('Name')).toBe('Test Name');
    edit();
    expect(input('Name')).toHaveValue('Test Name');
  });

  it('a multiselect is a row of toggle buttons: pressing adds, pressing again removes', async () => {
    const { onSave } = mount([{ key: 'langs', label: 'Languages', type: 'multiselect', options: ['en', 'hi', 'mr'] }], { langs: ['en'] });
    edit();
    fireEvent.click(screen.getByRole('button', { name: 'hi' }));
    fireEvent.click(screen.getByRole('button', { name: 'en' }));
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ langs: ['hi'] }));
  });
});

describe('EditableSection — what Save sends', () => {
  it('nothing changed: no call, no toast, and the section goes back to read mode', async () => {
    const { onSave } = mount([text('name', 'Name'), { key: 'tags', label: 'Tags', type: 'tags' }], { name: 'Test Name', tags: ['a', 'b'] });
    edit();
    save();
    await waitFor(() => expect(screen.getByTitle(`Edit ${TITLE}`)).toBeInTheDocument());
    expect(onSave).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('only the fields that changed are sent, and the toast and read mode follow a success', async () => {
    const { onSave } = mount([text('name', 'Name'), text('city', 'City')], { name: 'Test Name', city: 'Pune' });
    edit();
    type('City', 'Mumbai');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ city: 'Mumbai' });
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith(`${TITLE} updated`));
    await waitFor(() => expect(screen.getByTitle(`Edit ${TITLE}`)).toBeInTheDocument());
  });

  it('a number is sent as a number, and a cleared number or text as null (not as an empty string)', async () => {
    const { onSave } = mount([{ key: 'n', label: 'Count', type: 'number' }, text('t', 'Text')], { n: 7, t: 'x' });
    edit();
    type('Count', '12.5');
    type('Text', '');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ n: 12.5, t: null }));
    expect(typeof onSave.mock.calls[0][0].n).toBe('number');
  });

  it('clearing a number sends null, not 0', async () => {
    const { onSave } = mount([{ key: 'n', label: 'Count', type: 'number' }], { n: 7 });
    edit();
    type('Count', '');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ n: null }));
  });

  it('tags are sent as a trimmed list with the blanks dropped, and a different order is a change', async () => {
    const { onSave } = mount([{ key: 'tags', label: 'Tags', type: 'tags' }], { tags: ['a', 'b'] });
    edit();
    type('Tags', ' b , a ,, ');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ tags: ['b', 'a'] }));
  });

  it('emptying the tags sends an empty list', async () => {
    const { onSave } = mount([{ key: 'tags', label: 'Tags', type: 'tags' }], { tags: ['a', 'b'] });
    edit();
    type('Tags', '');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ tags: [] }));
  });

  it('a multiselect put back to what it was is not a change: lists are compared by element, so it is not re-sent', async () => {
    const { onSave } = mount([{ key: 'langs', label: 'Languages', type: 'multiselect', options: ['en', 'hi'] }, text('name', 'Name')], { langs: ['en', 'hi'], name: 'n' });
    edit();
    fireEvent.click(screen.getByRole('button', { name: 'hi' }));      // off
    fireEvent.click(screen.getByRole('button', { name: 'hi' }));      // and on again: same elements, same order
    type('Name', 'o');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ name: 'o' }));
  });

  it('a boolean toggled sends the new boolean', async () => {
    const { onSave } = mount([{ key: 'active', label: 'Active', type: 'boolean' }], { active: false });
    edit();
    fireEvent.click(input('Active'));
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ active: true }));
  });

  it('json is parsed before it is sent, an empty box is an empty object, and a date keeps its day', async () => {
    const { onSave } = mount([{ key: 'cfg', label: 'Config', type: 'json' }, { key: 'other', label: 'Other', type: 'json' }, { key: 'd', label: 'Day', type: 'date' }],
      { cfg: { a: 1 }, other: { b: 2 }, d: '2026-10-20T10:30:00Z' });
    edit();
    type('Config', '{"a": 2, "list": [1, 2]}');
    type('Other', '   ');
    type('Day', '2026-11-02');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ cfg: { a: 2, list: [1, 2] }, other: {}, d: '2026-11-02' }));
  });

  it('json that does not parse is refused with the field named, nothing is sent and the edits stay', async () => {
    const { onSave } = mount([text('name', 'Name'), { key: 'cfg', label: 'Config', type: 'json' }], { name: 'Test Name', cfg: { a: 1 } });
    edit();
    type('Name', 'Other Name');
    type('Config', '{not json');
    save();
    expect(h.toastError).toHaveBeenCalledWith('"Config" must be valid JSON');
    expect(onSave).not.toHaveBeenCalled();
    expect(input('Config')).toHaveValue('{not json');
    expect(input('Name')).toHaveValue('Other Name');
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();            // not stuck in "Saving…"
  });

  it('a refused save says so, keeps the section open with the typed text, and can be tried again', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce(undefined);
    mount([text('name', 'Name')], { name: 'Test Name' }, { onSave });
    edit();
    type('Name', 'Other Name');
    save();
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith(`Failed to update ${TITLE}`));
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(input('Name')).toHaveValue('Other Name');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled());
    save();
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith(`${TITLE} updated`));
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('while the save is in flight the button reads Saving… and is disabled, so a double click cannot send twice', async () => {
    let finish!: () => void;
    const onSave = vi.fn(() => new Promise<void>(r => { finish = r; }));
    mount([text('name', 'Name')], { name: 'Test Name' }, { onSave });
    edit();
    type('Name', 'Other Name');
    save();
    const busy = await screen.findByRole('button', { name: 'Saving…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(onSave).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(screen.getByTitle(`Edit ${TITLE}`)).toBeInTheDocument());
  });
});

describe('EditableSection — required and dependent fields', () => {
  const SOURCE_FIELDS: FieldConfig[] = [
    { key: 'source', label: 'Source', type: 'select', options: ['LinkedIn', 'Agency'] },
    { key: 'agency', label: 'Sourcing Agency', type: 'select', options: ['', 'AGN9001'], dependsOn: { key: 'source', value: 'Agency' }, requiredWhenVisible: true },
  ];

  it('a required field that is visible and empty blocks the save, naming the field', () => {
    const { onSave } = mount(SOURCE_FIELDS, { source: 'LinkedIn', agency: null });
    edit();
    type('Source', 'Agency');
    save();
    expect(h.toastError).toHaveBeenCalledWith('Sourcing Agency is required');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('...but is not required while it is hidden by its dependency', async () => {
    const { onSave } = mount([...SOURCE_FIELDS, text('note', 'Note')], { source: 'LinkedIn', agency: null, note: 'n' });
    edit();
    expect(screen.queryByText('Sourcing Agency')).not.toBeInTheDocument();
    type('Note', 'changed');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ note: 'changed' }));
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('the dependent field appears and disappears as the other field is changed, before anything is saved', () => {
    mount(SOURCE_FIELDS, { source: 'LinkedIn', agency: null });
    edit();
    expect(screen.queryByText('Sourcing Agency')).not.toBeInTheDocument();
    type('Source', 'Agency');
    expect(screen.getByText('Sourcing Agency')).toBeInTheDocument();
    type('Source', 'LinkedIn');
    expect(screen.queryByText('Sourcing Agency')).not.toBeInTheDocument();
  });

  it('once filled, the required field lets the save through, together with the field it depends on', async () => {
    const { onSave } = mount(SOURCE_FIELDS, { source: 'LinkedIn', agency: null });
    edit();
    type('Source', 'Agency');
    type('Sourcing Agency', 'AGN9001');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ source: 'Agency', agency: 'AGN9001' }));
  });

  it('moving away from the dependency clears the now-inapplicable stored value (null), even though it sits in the draft', async () => {
    const { onSave } = mount(SOURCE_FIELDS, { source: 'Agency', agency: 'AGN9001' });
    edit();
    expect(input('Sourcing Agency')).toHaveValue('AGN9001');
    type('Source', 'LinkedIn');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ source: 'LinkedIn', agency: null }));
  });

  it('...and sends no null for a dependent value that was already empty', async () => {
    const { onSave } = mount(SOURCE_FIELDS, { source: 'Agency', agency: null });
    edit();
    type('Source', 'LinkedIn');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ source: 'LinkedIn' }));
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('agency');
  });
});
