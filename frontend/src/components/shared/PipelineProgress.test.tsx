import '../../test/loadTolerance.ts';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { STAGES } from '../../types/index.ts';
import PipelineProgress, { STAGE_COLORS, UNLIT_BG, shade, glossyFill } from './PipelineProgress.tsx';

// The stage tracker on the Candidate page: one arrow per pipeline stage, coloured up to and including the application's
// current stage and grey after it. jsdom keeps the inline background, so a segment is "lit" when its gradient's base colour
// (the 55% stop) is its own stage colour, and "unlit" when it is the grey.
const rgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 0xff}, ${n & 0xff})`; };
const segments = () => STAGES.map(s => screen.getByTitle(s));
const base = (el: HTMLElement) => el.style.background;
const isLit = (stage: string) => base(screen.getByTitle(stage)).includes(`${rgb(STAGE_COLORS[stage])} 55%`);
const isUnlit = (stage: string) => base(screen.getByTitle(stage)).includes(`${rgb(UNLIT_BG)} 55%`);

describe('PipelineProgress — which stages are lit', () => {
  it('draws one arrow per pipeline stage, in pipeline order, each with a label', () => {
    const { container } = render(<PipelineProgress stage="Applied and Screened" />);
    const titles = Array.from(container.querySelectorAll('[title]')).map(e => e.getAttribute('title'));
    expect(titles).toEqual([...STAGES]);
    for (const seg of segments()) expect(seg.textContent?.trim()).not.toBe('');
  });

  it.each(STAGES.map((s, i) => [s, i] as const))('at %s every stage up to and including it is lit in its own colour, and none after it', (stage, index) => {
    render(<PipelineProgress stage={stage} />);
    STAGES.forEach((s, i) => {
      if (i <= index) { expect({ s, lit: isLit(s) }).toEqual({ s, lit: true }); }
      else { expect({ s, unlit: isUnlit(s) }).toEqual({ s, unlit: true }); }
    });
  });

  it('a stage that is not in the pipeline (an old stored name) lights nothing, rather than everything or the first arrow', () => {
    render(<PipelineProgress stage="Resume Review" />);
    for (const s of STAGES) expect({ s, unlit: isUnlit(s) }).toEqual({ s, unlit: true });
  });

  it('an empty stage lights nothing either', () => {
    render(<PipelineProgress stage="" />);
    for (const s of STAGES) expect({ s, unlit: isUnlit(s) }).toEqual({ s, unlit: true });
  });

  it('a lit arrow and a grey one are shaded differently', () => {
    render(<PipelineProgress stage="Interview Round 1" />);
    expect(screen.getByTitle('Applied and Screened').style.boxShadow).not.toBe(screen.getByTitle('Founders Round').style.boxShadow);
  });

  it('the label above the tracker shows only when one is given', () => {
    const { rerender } = render(<PipelineProgress stage="Joined" />);
    expect(screen.queryByText('Test Role Alpha')).not.toBeInTheDocument();
    rerender(<PipelineProgress stage="Joined" label="Test Role Alpha" />);
    expect(screen.getByText('Test Role Alpha')).toBeInTheDocument();
  });

  it('the first arrow is flat on the left, the rest are notched and tucked under their neighbour', () => {
    render(<PipelineProgress stage="Joined" />);
    const [first, second] = segments();
    expect(first.style.marginLeft).toBe('0px');
    expect(parseFloat(second.style.marginLeft)).toBeLessThan(0);
    expect(first.style.clipPath).not.toBe(second.style.clipPath);
  });
});

describe('PipelineProgress — the colour table and helpers', () => {
  it('has a colour for every pipeline stage, and for nothing else (a renamed stage must not be left without one)', () => {
    expect(Object.keys(STAGE_COLORS).sort()).toEqual([...STAGES].sort());
    for (const s of STAGES) expect(STAGE_COLORS[s]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('shade lightens and darkens each channel and never leaves 0 to 255', () => {
    expect(shade('#102030', 16)).toBe('rgb(32, 48, 64)');
    expect(shade('#102030', -16)).toBe('rgb(0, 16, 32)');
    expect(shade('#fefefe', 55)).toBe('rgb(255, 255, 255)');
    expect(shade('#010101', -35)).toBe('rgb(0, 0, 0)');
  });

  it('glossyFill is a highlight over a gradient that runs light, base, dark with the base colour at 55%', () => {
    const fill = glossyFill('#102030');
    expect(fill).toContain(`${shade('#102030', 55)} 0%`);
    expect(fill).toContain('#102030 55%');
    expect(fill).toContain(`${shade('#102030', -35)} 100%`);
  });
});
