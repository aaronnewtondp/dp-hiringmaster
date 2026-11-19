import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import InterviewerMultiSelect from './InterviewerMultiSelect.tsx';
import { INTERVIEWERS, filterInterviewers } from '../../data/interviewers.ts';

afterEach(() => cleanup());

function Harness({ initial = [] as string[], onChange = (_: string[]) => {} }) {
  const [sel, setSel] = useState(initial);
  return <InterviewerMultiSelect selected={sel} onChange={v => { setSel(v); onChange(v); }} />;
}

describe('the interviewer directory', () => {
  it('is only active personal @digitalpaani.com mailboxes, lower-case, no duplicates', () => {
    const emails = INTERVIEWERS.map(p => p.email);
    expect(new Set(emails).size).toBe(emails.length);
    for (const e of emails) { expect(e).toBe(e.toLowerCase()); expect(e).toMatch(/^[^\s@]+@digitalpaani\.com$/); }
    // Shared mailboxes, suspended people and the other domain stay out.
    for (const out of ['hr@digitalpaani.com', 'sales@digitalpaani.com', 'accounts@digitalpaani.com', 'support@digitalpaani.com', 'nalin.luthra@digitalpaani.com',
      'rahul.singh@digitalpaani.com', 'dinesh.kumar@digitalpaani.com', 'mansi.jain@ecoinnovision.com']) expect(emails).not.toContain(out);
    // The people the code and tests already rely on are there.
    for (const inn of ['aaron.newton@digitalpaani.com', 'satyadev.singh@digitalpaani.com', 'mandeep.dagar@digitalpaani.com', 'piyush.negi@digitalpaani.com', 'mansi.jain@digitalpaani.com']) expect(emails).toContain(inn);
    expect(INTERVIEWERS.length).toBe(69);
  });
  it('searches by name or email, case-insensitively', () => {
    expect(filterInterviewers(INTERVIEWERS, 'PRIYANKA').map(p => p.name)).toEqual(['Priyanka Ghlyan', 'Priyanka Khaire']);
    expect(filterInterviewers(INTERVIEWERS, 'trisha@').map(p => p.name)).toEqual(['Trisha Goenka']);
    expect(filterInterviewers(INTERVIEWERS, '  ').length).toBe(INTERVIEWERS.length);
    expect(filterInterviewers(INTERVIEWERS, 'zzzz')).toEqual([]);
  });
});

describe('InterviewerMultiSelect', () => {
  it('is closed until clicked and then lists "Name — email" with checkboxes', () => {
    render(<Harness />);
    expect(screen.getByText('Select interviewers…')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /select interviewers/i }));
    const list = screen.getByRole('listbox', { name: 'Interviewers' });
    expect(within(list).getAllByRole('option')).toHaveLength(INTERVIEWERS.length);
    expect(within(list).getByText(/— aaron\.newton@digitalpaani\.com/)).toBeInTheDocument();
  });
  it('selects several people (emails out), shows them as chips, and removes one from its chip', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /select interviewers/i }));
    fireEvent.click(within(screen.getByRole('option', { name: /Alexander Loijos/ })).getByRole('checkbox'));
    fireEvent.click(within(screen.getByRole('option', { name: /Satyadev Singh/ })).getByRole('checkbox'));
    expect(onChange).toHaveBeenLastCalledWith(['alex.loijos@digitalpaani.com', 'satyadev.singh@digitalpaani.com']);
    expect(screen.getAllByTitle('alex.loijos@digitalpaani.com')[0]).toHaveTextContent('Alexander Loijos');
    fireEvent.click(screen.getByLabelText('Remove Alexander Loijos'));
    expect(onChange).toHaveBeenLastCalledWith(['satyadev.singh@digitalpaani.com']);
  });
  it('narrows the list as you type and says so when nobody matches', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /select interviewers/i }));
    fireEvent.change(screen.getByLabelText('Search interviewers'), { target: { value: 'nikhil' } });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search interviewers'), { target: { value: 'qqq' } });
    expect(screen.getByText(/No one matches/)).toBeInTheDocument();
    expect(screen.getByText(/type their full email address/)).toBeInTheDocument();
  });
  it('clears the selection, and closes on Escape', () => {
    const onChange = vi.fn();
    render(<Harness initial={['aaron.newton@digitalpaani.com']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /1 selected/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('shows an address that is not in the directory as itself (an older round keeps its person)', () => {
    render(<Harness initial={['someone.else@example.test']} />);
    expect(screen.getByTitle('someone.else@example.test')).toHaveTextContent('someone.else@example.test');
  });
  it('adds an email that is not in the directory (button or Enter), once, only when it is a real address', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /select interviewers/i }));
    const box = screen.getByLabelText('Search interviewers');
    fireEvent.change(box, { target: { value: 'not-an-email' } });
    expect(screen.queryByText(/as an interviewer/)).toBeNull();
    fireEvent.change(box, { target: { value: 'Outside.Person@Example.com' } });
    fireEvent.click(screen.getByText(/as an interviewer/));
    expect(onChange).toHaveBeenLastCalledWith(['outside.person@example.com']);
    expect(screen.getByTitle('outside.person@example.com')).toBeInTheDocument();
    // typed again: already chosen, so no second offer; a listed address is never offered either (pick it from the list)
    fireEvent.change(box, { target: { value: 'outside.person@example.com' } });
    expect(screen.queryByText(/as an interviewer/)).toBeNull();
    fireEvent.change(box, { target: { value: 'aaron.newton@digitalpaani.com' } });
    expect(screen.queryByText(/as an interviewer/)).toBeNull();
    fireEvent.change(box, { target: { value: 'second@example.test' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['outside.person@example.com', 'second@example.test']);
  });
});
