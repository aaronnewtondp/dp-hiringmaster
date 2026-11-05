import '../../test/loadTolerance.ts';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import BackButton from './BackButton.tsx';

// The "back" control on the detail pages: real history back when the page was reached from inside the app, the fixed
// fallback when it was opened directly (a bookmark, a pasted link, a refresh). react-router marks a first entry with the
// location key 'default'.
const Detail = ({ className }: { className?: string }) => <><div>detail page</div><BackButton fallback="/fallback" label="Back to the list" className={className} /></>;
function mount(entries: string[], index = entries.length - 1, className?: string) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <Routes>
        <Route path="/list" element={<div>list page</div>} />
        <Route path="/other" element={<div>other page</div>} />
        <Route path="/fallback" element={<div>fallback page</div>} />
        <Route path="/detail" element={<Detail className={className} />} />
      </Routes>
    </MemoryRouter>,
  );
}
const press = () => fireEvent.click(screen.getByRole('button', { name: /Back to the list/ }));

describe('BackButton', () => {
  it('goes back to where the user came from when there is history inside the app', () => {
    mount(['/list', '/detail']);
    press();
    expect(screen.getByText('list page')).toBeInTheDocument();
    expect(screen.queryByText('fallback page')).not.toBeInTheDocument();
  });

  it('goes back to the page actually visited before, not to a fixed list page', () => {
    mount(['/other', '/detail']);
    press();
    expect(screen.getByText('other page')).toBeInTheDocument();
  });

  it('opened directly (the first and only entry) it goes to the fallback instead', () => {
    mount(['/detail']);
    press();
    expect(screen.getByText('fallback page')).toBeInTheDocument();
  });

  it('shows the label it was given, and the default bottom margin unless another class is passed', () => {
    mount(['/detail']);
    expect(screen.getByRole('button', { name: /Back to the list/ })).toHaveClass('mb-3');
  });

  it('a class passed in replaces the default margin', () => {
    mount(['/detail'], 0, 'mt-9');
    const button = screen.getByRole('button', { name: /Back to the list/ });
    expect(button).toHaveClass('mt-9');
    expect(button).not.toHaveClass('mb-3');
  });
});
