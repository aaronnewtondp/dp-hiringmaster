import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// What the Internal Compensation Benchmarking marker says. Facts: backend/src/services/compBenchmark.ts matches comp_benchmarks
// rows on the role's EXACT title (the experience range only picks between that title's rows; with no overlap it takes the first
// row on file) and otherwise asks Claude from the role's title, department, experience, must-have skills and responsibilities.
// Nothing compares the result with the role's CTC Band.
vi.mock('../services/api.ts', () => ({ rolesApi: { compBenchmark: vi.fn() } }));

import CompBenchmarkPanel from './CompBenchmarkPanel.tsx';

describe('CompBenchmarkPanel — the marker', () => {
  it('says it needs a benchmark record for exactly this role title, otherwise a labelled AI estimate, and is not compared with the CTC Band', () => {
    render(<CompBenchmarkPanel roleId="R001" />);
    const heading = screen.getByText('Internal Compensation Benchmarking');
    fireEvent.mouseEnter(heading.parentElement!.querySelector('[aria-label="More info"]')!);
    const tip = heading.parentElement!.querySelector('div.absolute')!.textContent!;
    expect(tip).toContain('not any one candidate');
    expect(tip).toContain('when one exists for exactly this role title');
    expect(tip).toContain("the one for the role's experience range, otherwise the first on file");
    expect(tip).toContain('a Claude estimate');
    expect(tip).toContain('labelled as an AI estimate');
    expect(tip).toContain("not compared with this role's CTC Band");
    expect(tip).not.toContain('role like this one');                     // the old claim: a similarly named role is NOT matched
  });
});
