import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MultiSelectFilter from './MultiSelectFilter.tsx';

const OPTIONS = ['One', 'Two', 'Three'];

// jsdom has no layout, so give the button a position and the window a size.
function place(buttonRect: Partial<DOMRect>, viewport: { w: number; h: number }) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewport.w });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewport.h });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, width: 50, height: 28, top: 0, left: 0, right: 50, bottom: 28, toJSON: () => ({}), ...buttonRect,
  } as DOMRect);
}
const panel = () => document.querySelector('div.fixed') as HTMLElement;

afterEach(() => vi.restoreAllMocks());

describe('MultiSelectFilter dropdown placement', () => {
  it('opens under the button when there is room', () => {
    place({ left: 100, bottom: 40 }, { w: 1200, h: 900 });
    render(<MultiSelectFilter label="Role" options={OPTIONS} selected={[]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Role/ }));
    expect(panel().style.left).toBe('100px');
    expect(panel().style.top).toBe('44px');
    expect(panel().style.maxHeight).toBe('288px');
  });

  it('is pulled back inside the window when the button sits near the right edge', () => {
    place({ left: 1150, bottom: 40 }, { w: 1200, h: 900 });
    render(<MultiSelectFilter label="Role" options={OPTIONS} selected={[]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Role/ }));
    expect(parseInt(panel().style.left) + 224).toBeLessThanOrEqual(1200 - 8);
  });

  it('never starts off the left edge', () => {
    place({ left: -40, bottom: 40 }, { w: 1200, h: 900 });
    render(<MultiSelectFilter label="Role" options={OPTIONS} selected={[]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Role/ }));
    expect(parseInt(panel().style.left)).toBeGreaterThanOrEqual(8);
  });

  it('is no taller than the room below a button that sits low in a short window (it scrolls inside instead)', () => {
    place({ left: 100, bottom: 500 }, { w: 1200, h: 640 });
    render(<MultiSelectFilter label="Role" options={OPTIONS} selected={[]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Role/ }));
    expect(parseInt(panel().style.maxHeight)).toBe(640 - 504 - 8);        // 128
    expect(parseInt(panel().style.top) + parseInt(panel().style.maxHeight)).toBeLessThanOrEqual(640);
  });

  it('keeps a usable minimum height even when there is almost no room', () => {
    place({ left: 100, bottom: 630 }, { w: 1200, h: 640 });
    render(<MultiSelectFilter label="Role" options={OPTIONS} selected={[]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Role/ }));
    expect(parseInt(panel().style.maxHeight)).toBe(120);
  });
});

describe('MultiSelectFilter selection (unchanged behaviour)', () => {
  it('toggles values and reports the list', () => {
    place({}, { w: 1200, h: 900 });
    const onChange = vi.fn();
    render(<MultiSelectFilter label="Role" options={OPTIONS} selected={['One']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Role/ }));
    fireEvent.click(screen.getByLabelText('Two'));
    expect(onChange).toHaveBeenCalledWith(['One', 'Two']);
    fireEvent.click(screen.getByLabelText('One'));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
