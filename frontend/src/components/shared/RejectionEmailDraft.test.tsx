import '../../test/loadTolerance.ts';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { REJECTION_REASONS } from '../../types/index.ts';
import RejectionEmailDraft from './RejectionEmailDraft.tsx';
import type { RejectionEmailState } from './RejectionEmailDraft.tsx';

// The optional "send a rejection e-mail" block in every reject flow. It is off until asked for, its text is generated
// from the reasons but never names them, and it never overwrites what the user has typed.
type Props = Parameters<typeof RejectionEmailDraft>[0];
function mount(over: Partial<Props> = {}) {
  const onChange = vi.fn<(d: RejectionEmailState) => void>();
  const props: Props = { reasons: ['Compensation mismatch'], candidateName: 'Test Candidate', roleTitle: 'Test Role Alpha', recipientEmail: 'cand@example.test', onChange, ...over };
  const view = render(<RejectionEmailDraft {...props} />);
  const rerender = (next: Partial<Props>) => view.rerender(<RejectionEmailDraft {...props} {...next} />);
  return { ...view, onChange, rerender };
}
const last = (f: ReturnType<typeof vi.fn>) => f.mock.calls[f.mock.calls.length - 1][0] as RejectionEmailState;
const toggle = () => screen.getByRole('checkbox') as HTMLInputElement;
const subjectBox = () => screen.getByDisplayValue(/Update on your application/) as HTMLInputElement;
const bodyBox = () => screen.getByDisplayValue(/^Hi /) as HTMLTextAreaElement;

describe('RejectionEmailDraft — before and after it is switched on', () => {
  it('renders nothing at all while no reason is selected', () => {
    const { container } = mount({ reasons: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('is off by default: a checkbox, no editable fields, and the parent is told it is disabled', () => {
    const { onChange } = mount();
    expect(toggle()).not.toBeChecked();
    expect(screen.queryByDisplayValue(/Update on your application/)).not.toBeInTheDocument();
    expect(last(onChange).enabled).toBe(false);
  });

  it('switching it on shows the recipient, a subject and a body, and tells the parent', () => {
    const { onChange } = mount();
    fireEvent.click(toggle());
    expect(toggle()).toBeChecked();
    expect(screen.getByText('To:').parentElement).toHaveTextContent('To: cand@example.test');
    expect(subjectBox().value).toBe('Update on your application — Test Role Alpha');
    expect(bodyBox().value).toContain('Hi Test Candidate,');
    expect(last(onChange)).toEqual({ enabled: true, subject: 'Update on your application — Test Role Alpha', body: bodyBox().value });
  });

  it('switching it off again tells the parent, and keeps the draft for next time', () => {
    const { onChange } = mount();
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(last(onChange).enabled).toBe(false);
    expect(last(onChange).subject).toBe('Update on your application — Test Role Alpha');
  });

  it('with no recipient address on file, the To: line shows a dash', () => {
    mount({ recipientEmail: undefined });
    fireEvent.click(toggle());
    expect(screen.getByText('To:').parentElement).toHaveTextContent('To: —');
  });
});

describe('RejectionEmailDraft — the generated text', () => {
  it('is written for the real candidate and role (single mode) and never names an internal reason', () => {
    for (const reason of REJECTION_REASONS) {
      const { onChange, unmount } = mount({ reasons: [reason] });
      fireEvent.click(toggle());
      const { body, subject } = last(onChange);
      expect(body).toContain('Test Candidate');
      expect(subject).toContain('Test Role Alpha');
      expect(body.toLowerCase()).not.toContain(reason.toLowerCase());
      unmount();
    }
  });

  it('several reasons give one neutral multi-factor line, and none of them is named', () => {
    const picked = ['Missing mandatory skill', 'Compensation mismatch', 'Communication gap'];
    const { onChange } = mount({ reasons: picked });
    fireEvent.click(toggle());
    const { body } = last(onChange);
    expect(body).toContain('several factors');
    for (const r of picked) expect(body.toLowerCase()).not.toContain(r.toLowerCase());
  });

  it('follows the reasons while the user has not touched it', () => {
    const { onChange, rerender } = mount({ reasons: ['Communication gap'] });
    fireEvent.click(toggle());
    const one = last(onChange).body;
    rerender({ reasons: ['Communication gap', 'Compensation mismatch'] });
    expect(last(onChange).body).not.toBe(one);
    expect(last(onChange).body).toContain('several factors');
    rerender({ reasons: ['Communication gap'] });
    expect(last(onChange).body).toBe(one);
  });

  it('once the body or the subject is edited, a change of reasons no longer overwrites either', () => {
    const { onChange, rerender } = mount({ reasons: ['Communication gap'] });
    fireEvent.click(toggle());
    fireEvent.change(bodyBox(), { target: { value: 'Hi, my own wording.' } });
    expect(last(onChange).body).toBe('Hi, my own wording.');
    rerender({ reasons: ['Compensation mismatch', 'Short average tenure'] });
    expect(last(onChange).body).toBe('Hi, my own wording.');
    expect(last(onChange).subject).toBe('Update on your application — Test Role Alpha');
  });

  it('editing only the subject also stops regeneration (the body is kept as it was)', () => {
    const { onChange, rerender } = mount({ reasons: ['Communication gap'] });
    fireEvent.click(toggle());
    const body = last(onChange).body;
    fireEvent.change(subjectBox(), { target: { value: 'Your application' } });
    expect(last(onChange).subject).toBe('Your application');
    rerender({ reasons: ['Compensation mismatch', 'Short average tenure'] });
    expect(last(onChange).subject).toBe('Your application');
    expect(last(onChange).body).toBe(body);
  });

  it('edits go to the parent as they are typed, with the e-mail still enabled', () => {
    const { onChange } = mount();
    fireEvent.click(toggle());
    fireEvent.change(subjectBox(), { target: { value: 'Hello' } });
    fireEvent.change(bodyBox(), { target: { value: 'World' } });
    expect(last(onChange)).toEqual({ enabled: true, subject: 'Hello', body: 'World' });
  });
});

describe('RejectionEmailDraft — several candidates at once', () => {
  it('more than one candidate: plural wording, a count instead of an address, and name/role tokens left for each recipient', () => {
    const { onChange } = mount({ bulkCount: 3, candidateName: undefined, roleTitle: undefined, recipientEmail: undefined });
    expect(screen.getByLabelText('Send rejection email to candidates')).toBeInTheDocument();
    fireEvent.click(toggle());
    expect(screen.getByText('To:').parentElement).toHaveTextContent('To: 3 candidates');
    expect(last(onChange).body).toContain('Hi {{candidate_name}},');
    expect(last(onChange).subject).toBe('Update on your application — {{role_title}}');
    expect(screen.getByText(/are replaced per candidate when sent/)).toBeInTheDocument();
  });

  it('a count of one (or no count) is the single-candidate wording, with no per-candidate note', () => {
    for (const bulkCount of [1, undefined]) {
      const { unmount } = mount({ bulkCount });
      expect(screen.getByLabelText('Send rejection email to candidate')).toBeInTheDocument();
      fireEvent.click(toggle());
      expect(screen.queryByText(/are replaced per candidate/)).not.toBeInTheDocument();
      unmount();
    }
  });
});
