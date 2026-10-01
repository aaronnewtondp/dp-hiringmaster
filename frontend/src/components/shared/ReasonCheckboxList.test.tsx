import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ReasonCheckboxList from './ReasonCheckboxList.tsx';

const OPTIONS = ['Missing mandatory skill', 'Communication gap', 'Compensation mismatch'];

function Harness({ onChange }: { onChange?: (v: string[]) => void }) {
  const [sel, setSel] = useState<string[]>([]);
  return <ReasonCheckboxList label="Reasons" required options={OPTIONS} selected={sel} onChange={v => { setSel(v); onChange?.(v); }} />;
}

describe('ReasonCheckboxList', () => {
  it('lets several reasons be selected at once, in the order picked', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Communication gap'));
    fireEvent.click(screen.getByLabelText('Missing mandatory skill'));
    expect(onChange).toHaveBeenLastCalledWith(['Communication gap', 'Missing mandatory skill']);
    expect(screen.getByLabelText('Communication gap')).toBeChecked();
    expect(screen.getByLabelText('Missing mandatory skill')).toBeChecked();
    expect(screen.getByLabelText('Compensation mismatch')).not.toBeChecked();
  });

  it('unticking removes just that reason', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Communication gap'));
    fireEvent.click(screen.getByLabelText('Compensation mismatch'));
    fireEvent.click(screen.getByLabelText('Communication gap'));
    expect(onChange).toHaveBeenLastCalledWith(['Compensation mismatch']);
  });

  it('says how many are selected, and marks the field required', () => {
    render(<Harness />);
    expect(screen.getByText(/select one or more/)).toBeInTheDocument();
    expect(screen.getByText('*')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Communication gap'));
    fireEvent.click(screen.getByLabelText('Compensation mismatch'));
    expect(screen.getByText('(2 selected)')).toBeInTheDocument();
  });
});
