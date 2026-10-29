import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PriorityBadge, StageBadge, StatusBadge, AgingBadge, FitScore, SlaBadge, OverBudgetBadge, GenderBadge } from './Badges.tsx';

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

describe('GenderBadge', () => {
  it('renders M/F as-is', () => {
    render(<GenderBadge gender="M" />);
    expect(screen.getByText('M')).toBeInTheDocument();
  });

  it('renders a dash (not a guess) for null/undefined gender', () => {
    render(<GenderBadge gender={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
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

describe('badge hovers say what the badge means', () => {
  it('a priority tag explains P0 to P3 and what priority sets', () => {
    render(<PriorityBadge priority="P1" />);
    const tip = screen.getByText('P1').getAttribute('title')!;
    expect(tip).toContain('Priority P1');
    expect(tip).toContain('P0 is the most urgent, P3 the least');
    expect(tip).toContain('how far past its Close Target an open role can run before it is flagged');
  });

  it('the SLA tag says it stays until the application is actioned, and that putting it on hold does not clear it', () => {
    render(<SlaBadge breached={true} />);
    const tip = screen.getByText('SLA').getAttribute('title')!;
    expect(tip).toContain('past one of its time limits');
    expect(tip).toContain('putting it on hold does not clear it');
    expect(tip).toContain("The Dashboard's SLA breaches counts open overdue tasks instead");
  });

  it('a flagged role with a Close Target says how far past it the role is', () => {
    render(<AgingBadge alert="red" daysOpen={80} daysOverdue={30} />);
    const tip = screen.getByText(/30d over/).getAttribute('title')!;
    expect(tip).toContain('80d since the role opened');
    expect(tip).toContain('30d past its Close Target');
  });

  it('a flagged role with 0 days over has no Close Target: it reads "no target" (never "0d over") and the hover says it is flagged on days open', () => {
    render(<AgingBadge alert="yellow" daysOpen={20} daysOverdue={0} />);
    expect(screen.queryByText(/0d over/)).not.toBeInTheDocument();
    const tip = screen.getByText(/20d open · no target/).getAttribute('title')!;
    expect(tip).toContain('No Close Target is set');
    expect(tip).toContain('flagged on the days it has been open');
    expect(tip).not.toContain('past its Close Target');
  });
});
