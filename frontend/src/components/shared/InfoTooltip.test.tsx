import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import InfoTooltip from './InfoTooltip.tsx';

// jsdom has no PointerEvent: give React one that carries pointerType, so the tests can tell a mouse from a finger.
beforeAll(() => {
  if (!('PointerEvent' in window)) {
    class PE extends MouseEvent {
      pointerType: string;
      constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? '';
      }
    }
    (window as unknown as { PointerEvent: unknown }).PointerEvent = PE;
  }
});

const TEXT = 'Explains the number';
const marker = () => screen.getByRole('button', { name: 'More info' });
const open = () => screen.queryByText(TEXT);

// What a phone sends for one tap on the marker, in the browser's own order.
function tap(el: Element) {
  fireEvent.pointerEnter(el, { pointerType: 'touch' });
  fireEvent.mouseEnter(el);
  fireEvent.mouseDown(el);
  fireEvent.click(el);
}

describe('InfoTooltip', () => {
  it('a mouse opens it on hover and closes it when the pointer leaves', () => {
    render(<InfoTooltip text={TEXT} />);
    expect(open()).toBeNull();
    fireEvent.pointerEnter(marker(), { pointerType: 'mouse' });
    fireEvent.mouseEnter(marker());
    expect(open()).not.toBeNull();
    fireEvent.mouseLeave(marker());
    expect(open()).toBeNull();
  });

  it('hover works without pointer events too (older browsers, keyboard-less test drivers)', () => {
    render(<InfoTooltip text={TEXT} />);
    fireEvent.mouseEnter(marker());
    expect(open()).not.toBeNull();
  });

  it('the FIRST tap with a finger opens it (the emulated mouseenter no longer opens it just before the click shuts it)', () => {
    render(<InfoTooltip text={TEXT} />);
    tap(marker());
    expect(open()).not.toBeNull();
  });

  it('a second tap closes it and a third opens it again', () => {
    render(<InfoTooltip text={TEXT} />);
    tap(marker());
    tap(marker());
    expect(open()).toBeNull();
    tap(marker());
    expect(open()).not.toBeNull();
  });

  it('a pen behaves like a finger', () => {
    render(<InfoTooltip text={TEXT} />);
    fireEvent.pointerEnter(marker(), { pointerType: 'pen' });
    fireEvent.mouseEnter(marker());
    expect(open()).toBeNull();
    fireEvent.click(marker());
    expect(open()).not.toBeNull();
  });

  it('a click (keyboard Enter/Space arrives as a click) toggles it', () => {
    render(<InfoTooltip text={TEXT} />);
    fireEvent.click(marker());
    expect(open()).not.toBeNull();
    fireEvent.click(marker());
    expect(open()).toBeNull();
  });

  it('a press outside closes an open one, and so does Escape', () => {
    render(<div><InfoTooltip text={TEXT} /><p>elsewhere</p></div>);
    fireEvent.click(marker());
    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(open()).toBeNull();
    fireEvent.click(marker());
    expect(open()).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(open()).toBeNull();
  });

  it('a press inside the popover itself does not close it', () => {
    render(<InfoTooltip text={TEXT} />);
    fireEvent.click(marker());
    fireEvent.mouseDown(screen.getByText(TEXT));
    expect(open()).not.toBeNull();
  });

  it('the click does not bubble to a clickable header around the marker', () => {
    let parentClicks = 0;
    render(<div onClick={() => { parentClicks++; }}><InfoTooltip text={TEXT} /></div>);
    fireEvent.click(marker());
    expect(parentClicks).toBe(0);
  });
});
