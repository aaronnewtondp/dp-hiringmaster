import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import InfoTooltip from './InfoTooltip.tsx';
import { nestingWarnings, openEveryMarker, expectPhrasingOnlyPopovers, watchConsoleErrors } from '../../test/domNesting.ts';

// The marker is placed inside page subtitles (<p>), headings and spans next to a label. Its popover used to be a <div>,
// which React reports as "<div> cannot be a descendant of <p>" the moment the popover opens.
const places: [string, (child: React.ReactNode) => React.ReactElement][] = [
  ['a paragraph', c => <p>12 applications {c}</p>],
  ['a heading', c => <h2>Title {c}</h2>],
  ['a span', c => <span>Age {c}</span>],
  ['a table header cell', c => <table><thead><tr><th><span>Fit {c}</span></th></tr></thead></table>],
  ['a button-less label', c => <label>Name {c}</label>],
];

describe('InfoTooltip — valid markup wherever it is placed', () => {
  for (const [where, wrap] of places) {
    it(`an open popover inside ${where} prints no nesting warning`, () => {
      const spy = watchConsoleErrors();
      try {
        const { container } = render(wrap(<InfoTooltip text="Explains the number" />));
        expect(openEveryMarker(container)).toBe(1);
        expect(nestingWarnings(spy)).toEqual([]);
        expectPhrasingOnlyPopovers(container);
      } finally { spy.mockRestore(); }
    });
  }

  it('keeps the look it had as a <div>: still an absolutely positioned block with the same classes', () => {
    const { container } = render(<InfoTooltip text="Explains the number" width="w-72" align="left" />);
    openEveryMarker(container);
    const popover = container.querySelector('[aria-label="More info"]')!.nextElementSibling!;
    for (const c of ['block', 'absolute', 'z-50', 'top-full', 'mt-1.5', 'w-72', 'left-0', 'p-2.5', 'rounded-lg', 'bg-gray-900', 'text-white', 'text-[11px]', 'normal-case', 'font-normal', 'tracking-normal', 'leading-relaxed', 'shadow-lg']) {
      expect(popover.classList.contains(c), c).toBe(true);
    }
  });
});
