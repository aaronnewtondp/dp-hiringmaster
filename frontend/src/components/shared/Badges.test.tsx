import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PriorityBadge, StageBadge, StatusBadge, AgingBadge, FitScore, SlaBadge, OverBudgetBadge } from './Badges.tsx';

describe('PriorityBadge', () => {
  it('renders the priority label', () => {
    render(<PriorityBadge priority="P0" />);
    expect(screen.getByText('P0')).toBeInTheDocument();
  });
});

describe('StageBadge', () => {
  it('renders the stage name and uses it as the title tooltip (for truncation)', () => {
    render(<StageBadge stage="Interview Round 1" />);
    const el = screen.getByText('Interview Round 1');
    expect(el).toHaveAttribute('title', 'Interview Round 1');
  });

  it('color-codes a terminal Rejected stage distinctly from an in-flight Interview stage', () => {
    const { container: rejectedContainer } = render(<StageBadge stage="Rejected" />);
    const { container: interviewContainer } = render(<StageBadge stage="Interview Round 2" />);
    expect(rejectedContainer.querySelector('span')?.className).toContain('bg-red-100');
    expect(interviewContainer.querySelector('span')?.className).toContain('bg-dp-100');
  });
});

describe('StatusBadge', () => {
  it('renders the status text', () => {
    render(<StatusBadge status="Active" />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });
});

describe('AgingBadge', () => {
  it('shows the red indicator with both days-over and days-open when alert is red', () => {
    render(<AgingBadge alert="red" daysOpen={50} daysOverdue={12} />);
    expect(screen.getByText(/12d over/)).toBeInTheDocument();
    expect(screen.getByText(/50d open/)).toBeInTheDocument();
  });

  it('shows only days-open, no over-count, when alert is ok', () => {
    render(<AgingBadge alert="ok" daysOpen={10} daysOverdue={0} />);
    expect(screen.getByText('10d open')).toBeInTheDocument();
    expect(screen.queryByText(/over/)).not.toBeInTheDocument();
  });
});

describe('FitScore', () => {
  it('renders a dash for a missing score rather than 0', () => {
    render(<FitScore score={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders the numeric score when present', () => {
    render(<FitScore score={82} />);
    expect(screen.getByText('82')).toBeInTheDocument();
  });
});

describe('SlaBadge / OverBudgetBadge', () => {
  it('renders nothing when not breached/over-budget', () => {
    const { container: sla } = render(<SlaBadge breached={false} />);
    const { container: budget } = render(<OverBudgetBadge overBudget={false} />);
    expect(sla).toBeEmptyDOMElement();
    expect(budget).toBeEmptyDOMElement();
  });

  it('renders a visible badge when breached/over-budget', () => {
    render(<SlaBadge breached={true} />);
    render(<OverBudgetBadge overBudget={true} />);
    expect(screen.getByText('SLA')).toBeInTheDocument();
    expect(screen.getByText('Over Budget')).toBeInTheDocument();
  });
});
