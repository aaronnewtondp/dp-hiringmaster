import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PlanChange, TimelineCategory } from '../../types/sourcing.ts';
import SourcingTimeline from './SourcingTimeline.tsx';

// "Now" is pinned to local noon on 21 Oct 2026 so Today / Yesterday never depend on when the suite runs. Only Date is faked: testing-library's
// own timers keep working.
const NOW = new Date(2026, 9, 21, 12, 0, 0);
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

const at = (daysAgo: number, h = 9, m = 30) => new Date(2026, 9, 21 - daysAgo, h, m, 0).toISOString();
let seq = 0;
const entry = (over: Partial<PlanChange> = {}): PlanChange => ({
  id: String(++seq), at: at(0), by_name: 'Aaron Newton', change: { type: 'commitment_done' }, reason: null,
  text: `Did something ${seq}`, category: 'task', ...over,
});
const entries = () => screen.queryAllByTestId('timeline-entry');
const chip = (name: RegExp | string) => screen.getByRole('button', { name });

describe('SourcingTimeline — layout', () => {
  beforeEach(() => { seq = 0; });

  it('shows the heading with the total, and the empty state when nothing has happened yet', () => {
    render(<SourcingTimeline changes={[]} total={0} />);
    expect(screen.getByRole('heading', { name: /Plan history/ })).toHaveTextContent('Plan history (0)');
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
    expect(entries()).toHaveLength(0);
    // with no entries only "Everything" is offered: no empty category chips
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('keeps the order it is given (newest first) and puts one heading per day: Today, Yesterday, then a date', () => {
    render(<SourcingTimeline total={4} changes={[
      entry({ text: 'Today A', at: at(0, 11, 5) }),
      entry({ text: 'Today B', at: at(0, 8, 0) }),
      entry({ text: 'Yesterday A', at: at(1, 16, 45) }),
      entry({ text: 'Older A', at: at(11, 10, 0) }),
    ]} />);
    expect(entries().map(e => e.textContent)).toEqual(['Today A', 'Today B', 'Yesterday A', 'Older A']);
    expect(screen.getAllByText('Today')).toHaveLength(1);
    expect(screen.getAllByText('Yesterday')).toHaveLength(1);
    const older = screen.getByText(/10 Oct/);                                    // 21 − 11 = 10 Oct, no year in the current year
    expect(older.textContent).not.toMatch(/2026/);
    const list = screen.getByRole('list');
    const text = list.textContent ?? '';
    expect(text.indexOf('Today')).toBeLessThan(text.indexOf('Yesterday'));
    expect(text.indexOf('Yesterday')).toBeLessThan(text.indexOf('10 Oct'));
  });

  it('adds the year to a date from an earlier year', () => {
    render(<SourcingTimeline total={1} changes={[entry({ at: new Date(2025, 11, 30, 10, 0).toISOString() })]} />);
    expect(screen.getByText(/30 Dec 2025/)).toBeInTheDocument();
  });

  it('shows the time and who did it, and "System" when nobody did', () => {
    render(<SourcingTimeline total={2} changes={[
      entry({ text: 'By a person', by_name: 'Aaron Newton', at: at(0, 9, 30) }),
      entry({ text: 'By the engine', by_name: null, at: at(0, 7, 5), category: 'weekly' }),
    ]} />);
    expect(screen.getByText('09:30 · Aaron Newton')).toBeInTheDocument();
    expect(screen.getByText('07:05 · System')).toBeInTheDocument();
  });

  it('quotes the reason after the text, and only when there is one', () => {
    render(<SourcingTimeline total={2} changes={[
      entry({ text: 'Skipped the agency task', reason: 'Agencies not needed for this role' }),
      entry({ text: 'Marked done', reason: null }),
    ]} />);
    const [withReason, without] = entries();
    expect(withReason).toHaveTextContent('Skipped the agency task — “Agencies not needed for this role”');
    expect(without.textContent).toBe('Marked done');
  });

  it('renders entries of every category with their text', () => {
    const cats: TimelineCategory[] = ['plan', 'task', 'channel', 'target', 'exception', 'weekly'];
    render(<SourcingTimeline total={6} changes={cats.map(category => entry({ category, text: `A ${category} entry` }))} />);
    for (const c of cats) expect(screen.getByText(`A ${c} entry`)).toBeInTheDocument();
  });

  it('renders text as plain text, never as markup', () => {
    render(<SourcingTimeline total={1} changes={[entry({ text: '<b>bold</b> attempt', reason: '<i>x</i>' })]} />);
    expect(entries()[0].querySelector('b')).toBeNull();
    expect(entries()[0].querySelector('i')).toBeNull();
    expect(entries()[0]).toHaveTextContent('<b>bold</b> attempt — “<i>x</i>”');
  });
});

describe('SourcingTimeline — filters', () => {
  beforeEach(() => { seq = 0; });
  const mixed = () => [
    entry({ category: 'task', text: 'T1' }), entry({ category: 'task', text: 'T2' }), entry({ category: 'task', text: 'T3' }),
    entry({ category: 'channel', text: 'C1' }), entry({ category: 'weekly', text: 'W1' }), entry({ category: 'weekly', text: 'W2' }),
    entry({ category: 'target', text: 'G1' }), entry({ category: 'exception', text: 'E1' }), entry({ category: 'plan', text: 'P1' }),
  ];

  it('offers only the categories that have entries, each with its count; "Everything" has none', () => {
    render(<SourcingTimeline changes={[entry({ category: 'task' }), entry({ category: 'task' }), entry({ category: 'weekly' })]} total={3} />);
    expect(chip('Everything')).toBeInTheDocument();
    expect(chip('Tasks 2')).toBeInTheDocument();
    expect(chip('Weekly results 1')).toBeInTheDocument();
    for (const missing of [/^Channels/, /^Targets/, /^Alerts/, /^Plan \d/]) expect(screen.queryByRole('button', { name: missing })).toBeNull();
  });

  it('every category chip counts its own entries', () => {
    render(<SourcingTimeline changes={mixed()} total={9} />);
    for (const [label, n] of [['Tasks', 3], ['Channels', 1], ['Weekly results', 2], ['Targets', 1], ['Alerts', 1], ['Plan', 1]] as const) {
      expect(chip(`${label} ${n}`)).toBeInTheDocument();
    }
  });

  it('starts on Everything (aria-pressed) and switching narrows the list and moves the pressed state', () => {
    render(<SourcingTimeline changes={mixed()} total={9} />);
    expect(chip('Everything')).toHaveAttribute('aria-pressed', 'true');
    expect(entries()).toHaveLength(9);

    fireEvent.click(chip('Weekly results 2'));
    expect(chip('Weekly results 2')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('Everything')).toHaveAttribute('aria-pressed', 'false');
    expect(entries().map(e => e.textContent)).toEqual(['W1', 'W2']);

    fireEvent.click(chip('Alerts 1'));
    expect(entries().map(e => e.textContent)).toEqual(['E1']);
    expect(chip('Weekly results 2')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(chip('Everything'));
    expect(entries()).toHaveLength(9);
  });

  it('a day heading is repeated when a filter leaves entries on different days only once per day', () => {
    render(<SourcingTimeline total={3} changes={[
      entry({ category: 'task', text: 'a', at: at(0, 10) }), entry({ category: 'channel', text: 'b', at: at(0, 9) }), entry({ category: 'task', text: 'c', at: at(1, 9) }),
    ]} />);
    expect(screen.getAllByText('Today')).toHaveLength(1);
    fireEvent.click(chip('Tasks 2'));
    expect(screen.getAllByText('Today')).toHaveLength(1);
    expect(screen.getAllByText('Yesterday')).toHaveLength(1);
    fireEvent.click(chip('Channels 1'));
    expect(screen.queryByText('Yesterday')).toBeNull();
  });
});

describe('SourcingTimeline — paging and the truncation note', () => {
  beforeEach(() => { seq = 0; });
  const many = (n: number, category: TimelineCategory = 'task') => Array.from({ length: n }, (_, i) => entry({ category, text: `Entry ${i + 1}` }));

  it('shows 15 first and then pages by 20: "Show 20 more", then "Show 5 more" for the remainder', () => {
    render(<SourcingTimeline changes={many(40)} total={40} />);
    expect(entries()).toHaveLength(15);
    expect(screen.getByText('Entry 15')).toBeInTheDocument();
    expect(screen.queryByText('Entry 16')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show 20 more' }));
    expect(entries()).toHaveLength(35);
    fireEvent.click(screen.getByRole('button', { name: 'Show 5 more' }));
    expect(entries()).toHaveLength(40);
    expect(screen.queryByRole('button', { name: /^Show \d+ more$/ })).toBeNull();
  });

  it('exactly 15 entries needs no paging', () => {
    render(<SourcingTimeline changes={many(15)} total={15} />);
    expect(entries()).toHaveLength(15);
    expect(screen.queryByRole('button', { name: /more$/ })).toBeNull();
  });

  it('16 entries offers "Show 1 more"', () => {
    render(<SourcingTimeline changes={many(16)} total={16} />);
    expect(screen.getByRole('button', { name: 'Show 1 more' })).toBeInTheDocument();
  });

  it('changing the filter goes back to the first page', () => {
    const rows = [...many(25, 'task'), ...many(25, 'weekly').map((c, i) => ({ ...c, id: `w${i}`, text: `Week ${i + 1}` }))];
    render(<SourcingTimeline changes={rows} total={50} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show 20 more' }));
    expect(entries()).toHaveLength(35);
    fireEvent.click(chip('Weekly results 25'));
    expect(entries()).toHaveLength(15);
    expect(screen.getByRole('button', { name: 'Show 10 more' })).toBeInTheDocument();
  });

  it('says "Showing the latest X of N entries" when the server holds more than was loaded, once the list is fully expanded', () => {
    render(<SourcingTimeline changes={many(10)} total={250} />);
    expect(screen.getByRole('heading', { name: /Plan history/ })).toHaveTextContent('Plan history (250)');
    expect(screen.getByText('Showing the latest 10 of 250 entries.')).toBeInTheDocument();
  });

  it('does not show the truncation note while there are still loaded entries to page through', () => {
    render(<SourcingTimeline changes={many(30)} total={250} />);
    expect(screen.queryByText(/Showing the latest/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 15 more' }));
    expect(screen.getByText('Showing the latest 30 of 250 entries.')).toBeInTheDocument();
  });

  it('does not show the truncation note when everything is loaded, or under a category filter', () => {
    const { unmount } = render(<SourcingTimeline changes={many(10)} total={10} />);
    expect(screen.queryByText(/Showing the latest/)).toBeNull();
    unmount();

    render(<SourcingTimeline changes={[...many(5, 'task'), ...many(3, 'weekly')]} total={100} />);
    expect(screen.getByText(/Showing the latest 8 of 100/)).toBeInTheDocument();
    fireEvent.click(chip('Weekly results 3'));
    expect(screen.queryByText(/Showing the latest/)).toBeNull();      // the note is about the whole list, not a filtered view
  });
});
