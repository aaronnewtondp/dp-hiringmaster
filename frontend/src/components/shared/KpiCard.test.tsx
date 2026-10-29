import '../../test/loadTolerance.ts';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import KpiCard from './KpiCard.tsx';

// The Dashboard's stat tile: the label and headline number in the header, the supporting figures in a grid under it, and an
// accent colour on the icon as the one severity signal.
const Icon = ({ className }: { className?: string }) => <svg data-testid="icon" className={className} />;

describe('KpiCard', () => {
  it('shows the label and the headline value, whether it is a number or text', () => {
    const { rerender } = render(<KpiCard icon={Icon} label="Open roles" value={12} sub={[]} />);
    expect(screen.getByText('Open roles')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    rerender(<KpiCard icon={Icon} label="Open roles" value="n/a" sub={[]} />);
    expect(screen.getByText('n/a')).toBeInTheDocument();
  });

  it('a zero headline is shown, not dropped', () => {
    render(<KpiCard icon={Icon} label="Breaches" value={0} sub={[]} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('lists each supporting figure under its label, in the order given, zero included', () => {
    render(<KpiCard icon={Icon} label="Pipeline" value={9} sub={[['Shortlisted', 4], ['On hold', 0], ['Rejected', '7']]} />);
    for (const [label, value] of [['Shortlisted', '4'], ['On hold', '0'], ['Rejected', '7']]) {
      expect(screen.getByText(label).nextElementSibling).toHaveTextContent(value);
    }
    const labels = ['Shortlisted', 'On hold', 'Rejected'].map(l => screen.getByText(l));
    expect(labels[0].compareDocumentPosition(labels[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(labels[1].compareDocumentPosition(labels[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws the icon in grey unless an accent class is given, which replaces the grey', () => {
    const { rerender } = render(<KpiCard icon={Icon} label="Pipeline" value={1} sub={[]} />);
    expect(screen.getByTestId('icon')).toHaveClass('text-gray-400');
    rerender(<KpiCard icon={Icon} label="Pipeline" value={1} sub={[]} accent="text-red-600" />);
    expect(screen.getByTestId('icon')).toHaveClass('text-red-600');
    expect(screen.getByTestId('icon')).not.toHaveClass('text-gray-400');
  });
});
