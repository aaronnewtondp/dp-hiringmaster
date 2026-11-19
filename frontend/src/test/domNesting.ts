import { expect, vi, type MockInstance } from 'vitest';
import { fireEvent } from '@testing-library/react';

// Shared by the "opening every info marker prints no DOM-nesting warning" tests (Candidates, TalentPool, ScorecardSummary and
// InfoTooltip itself). React only warns (console.error) for the nestings the HTML parser would repair, e.g. a <div> in a <p>,
// and only while the popover is open, so a closed marker proves nothing: every marker is opened first.

// React 18 says "validateDOMNesting(...): <div> cannot appear as a descendant of <p>"; React 19 says "In HTML, <div> cannot be a
// descendant of <p>". Match the stable parts of both.
export const NESTING_WARNING = /validateDOMNesting|cannot (?:appear as a |be a )?(?:descendant|child) of|cannot contain|hydration error/i;

/** Start recording console.error; call `.mockRestore()` on the result (or use `nestingWarnings`). */
export function watchConsoleErrors(): MockInstance {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

/** The console.error calls so far that are a DOM-nesting warning, as one string each. */
export function nestingWarnings(spy: MockInstance): string[] {
  return spy.mock.calls.map(args => args.map(String).join(' ')).filter(line => NESTING_WARNING.test(line));
}

/** Open the popover of every "More info" marker under `root` (what a mouse hover does) and return how many there were. */
export function openEveryMarker(root: ParentNode): number {
  const markers = Array.from(root.querySelectorAll('[aria-label="More info"]'));
  for (const m of markers) fireEvent.mouseEnter(m);
  return markers.length;
}

/**
 * The structural half, independent of what React chooses to warn about: no open popover is a <div> or holds block content, and no
 * <div> sits anywhere inside a <p> (a <div> in a heading or <span> is not repaired by the parser, but the popover check covers it).
 */
export function expectPhrasingOnlyPopovers(root: ParentNode, expectedMin = 1): void {
  const markers = Array.from(root.querySelectorAll('[aria-label="More info"]'));
  expect(markers.length).toBeGreaterThanOrEqual(expectedMin);
  for (const m of markers) {
    const popover = m.nextElementSibling;
    expect(popover, 'the popover is open').not.toBeNull();
    expect(popover!.tagName).toBe('SPAN');
    expect(popover!.querySelector('div, p, ul, ol, table, h1, h2, h3, h4, h5, h6')).toBeNull();
  }
  expect(root.querySelector('p div')).toBeNull();
}
