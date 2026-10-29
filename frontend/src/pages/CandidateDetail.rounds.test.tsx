import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { format } from 'date-fns';
import { STAGES } from '../types/index.ts';
import { candidate, detailApplication as application, round, refCheck } from '../test/candidateDetailFixtures.ts';

// The Candidate page's interview rounds, assignments and reference checks: which controls appear at which stage and for whom,
// and what is handed to the interview / assignment / reference modals (stubbed here, so their props are what is checked).
// The rest of the page is in CandidateDetail.test.tsx.
const h = vi.hoisted(() => ({
  persona: 'hr_recruiter' as 'hr_recruiter' | 'hiring_manager' | 'leadership' | 'super_admin',
  get: vi.fn(), activity: vi.fn(), roundsList: vi.fn(), submitAssignment: vi.fn(), refChecksList: vi.fn(), agenciesList: vi.fn(),
  toastSuccess: vi.fn(), toastError: vi.fn(),
}));
vi.mock('../services/api.ts', () => ({
  candidatesApi: { get: (id: string) => h.get(id), activity: (id: string) => h.activity(id), update: vi.fn(), linkRole: vi.fn() },
  applicationsApi: { updateStatus: vi.fn(), setFounderFlag: vi.fn(), updateNotes: vi.fn(), advanceStage: vi.fn() },
  interviewsApi: { list: (id: string) => h.roundsList(id), submitAssignment: (...a: unknown[]) => h.submitAssignment(...a) },
  refChecksApi: { list: (id: string) => h.refChecksList(id) },
  agenciesApi: { list: () => h.agenciesList() },
  rolesApi: { list: vi.fn() },
}));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({
    canHR: h.persona !== 'hiring_manager',
    user: { id: 'u1', name: 'Test Reviewer', email: 'reviewer@example.test', persona: h.persona },
  }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: (m: string) => h.toastSuccess(m), error: (m: string) => h.toastError(m) } }));
vi.mock('../components/ResumeIQPanel.tsx', () => ({ default: () => null }));
// Each modal is a marker that shows the props it was given, with buttons to close it and to report success.
vi.mock('../components/InterviewFeedbackModal.tsx', () => ({
  default: (p: { round: { id: string; candidate_name: string; role_title: string }; onClose: () => void; onSuccess: () => void }) => (
    <div data-testid="feedback-modal" data-round={p.round.id} data-candidate={p.round.candidate_name} data-role={p.round.role_title}>
      <button onClick={p.onClose}>close-feedback</button><button onClick={p.onSuccess}>succeed-feedback</button>
    </div>),
}));
vi.mock('../components/ScheduleRoundModal.tsx', () => ({
  default: (p: { applicationId: string; nextRoundNumber: number; defaultRoundName: string; onClose: () => void; onSuccess: () => void }) => (
    <div data-testid="schedule-modal" data-application={p.applicationId} data-next={p.nextRoundNumber} data-name={p.defaultRoundName}>
      <button onClick={p.onClose}>close-schedule</button><button onClick={p.onSuccess}>succeed-schedule</button>
    </div>),
}));
vi.mock('../components/SendAssignmentModal.tsx', () => ({
  default: ({ onClose, onSuccess, ...rest }: Record<string, unknown> & { onClose: () => void; onSuccess: () => void }) => (
    <div data-testid="send-assignment-modal" data-props={JSON.stringify(rest)}>
      <button onClick={onClose}>close-send</button><button onClick={onSuccess}>succeed-send</button>
    </div>),
}));
vi.mock('../components/AssignmentOutcomeModal.tsx', () => ({
  default: (p: { round: { id: string; candidate_name: string; role_title: string }; onClose: () => void; onSuccess: () => void }) => (
    <div data-testid="outcome-modal" data-round={p.round.id} data-candidate={p.round.candidate_name} data-role={p.round.role_title}>
      <button onClick={p.onSuccess}>succeed-outcome</button>
    </div>),
}));
vi.mock('../components/AddReferenceCheckModal.tsx', () => ({
  default: (p: { applicationId: string; onClose: () => void; onSuccess: () => void }) => (
    <div data-testid="refcheck-modal" data-application={p.applicationId}><button onClick={p.onSuccess}>succeed-refcheck</button></div>),
}));

import CandidateDetail from './CandidateDetail.tsx';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/candidates/C9001']}>
        <Routes><Route path="/candidates/:id" element={<CandidateDetail />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
type Rounds = Record<string, ReturnType<typeof round>[]>;
const show = async (app: Record<string, unknown>, rounds: Rounds = {}, refChecks: Record<string, ReturnType<typeof refCheck>[]> = {}) => {
  h.get.mockResolvedValue({ data: { candidate: candidate(), applications: [app] } });
  h.roundsList.mockImplementation(async (id: string) => ({ data: { rounds: rounds[id] || [] } }));
  h.refChecksList.mockImplementation(async (id: string) => ({ data: { ref_checks: refChecks[id] || [] } }));
  mount();
  await screen.findByRole('heading', { level: 1, name: 'Test Candidate' });
  await waitFor(() => expect(h.roundsList).toHaveBeenCalled());
};
const when = (iso: string) => format(new Date(iso), 'MMM d, h:mm a');
const STANDARD = round('IR1', { round_number: 1, round_name: 'Technical' });
const ASSIGNMENT = (over: Record<string, unknown> = {}) => round('IR2', { round_number: 2, round_name: 'Take-home', round_type: 'Assignment', feedback_status: 'Pending', interviewer_emails: [], scheduled_date: null, ...over });
const modalOf = (heading: string) => screen.getByRole('heading', { name: heading }).closest('.fixed') as HTMLElement;

beforeEach(() => {
  h.persona = 'hr_recruiter';
  for (const f of [h.get, h.activity, h.roundsList, h.submitAssignment, h.refChecksList, h.agenciesList, h.toastSuccess, h.toastError]) f.mockReset();
  h.activity.mockResolvedValue({ data: { activity: [] } });
  h.agenciesList.mockResolvedValue({ data: { agencies: [] } });
  h.submitAssignment.mockResolvedValue({ data: {} });
});

describe('Candidate page — Schedule round and Send Assignment', () => {
  it('HR gets "Schedule round" only while the application is at Interview Round 1, Interview Round 2 or Founders Round', async () => {
    const allowed = ['Interview Round 1', 'Interview Round 2', 'Founders Round'];
    for (const stage of STAGES) {
      await show(application('A9001', { stage }));
      const has = screen.queryByRole('button', { name: 'Schedule round' }) !== null;
      expect({ stage, has }).toEqual({ stage, has: allowed.includes(stage) });
      cleanup();
      h.roundsList.mockClear();
    }
  });

  it('"Send Assignment" appears only at the Assignment Round', async () => {
    for (const stage of STAGES) {
      await show(application('A9001', { stage }));
      const has = screen.queryByRole('button', { name: 'Send Assignment' }) !== null;
      expect({ stage, has }).toEqual({ stage, has: stage === 'Assignment Round' });
      cleanup();
      h.roundsList.mockClear();
    }
  });

  it('a Hiring Manager gets neither, at any stage', async () => {
    h.persona = 'hiring_manager';
    for (const stage of ['Interview Round 1', 'Assignment Round', 'Founders Round']) {
      await show(application('A9001', { stage }));
      expect(screen.queryByRole('button', { name: 'Schedule round' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Send Assignment' })).not.toBeInTheDocument();
      cleanup();
      h.roundsList.mockClear();
    }
  });

  it('Schedule round hands the application, the next round number and the stage name to the scheduling dialog', async () => {
    await show(application('A9001', { stage: 'Interview Round 2' }), { A9001: [STANDARD, round('IR9', { round_number: 2, round_name: 'Panel' })] });
    await screen.findByText('Round 2 — Panel');
    fireEvent.click(screen.getByRole('button', { name: 'Schedule round' }));
    const dialog = screen.getByTestId('schedule-modal');
    expect(dialog).toHaveAttribute('data-application', 'A9001');
    expect(dialog).toHaveAttribute('data-next', '3');
    expect(dialog).toHaveAttribute('data-name', 'Interview Round 2');
  });

  it('with no round yet the next round is number 1, and a successful schedule reloads the rounds', async () => {
    await show(application('A9001', { stage: 'Interview Round 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Schedule round' }));
    expect(screen.getByTestId('schedule-modal')).toHaveAttribute('data-next', '1');
    const before = h.roundsList.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'succeed-schedule' }));
    await waitFor(() => expect(h.roundsList.mock.calls.length).toBeGreaterThan(before));
    fireEvent.click(screen.getByRole('button', { name: 'close-schedule' }));
    expect(screen.queryByTestId('schedule-modal')).not.toBeInTheDocument();
  });

  it('Send Assignment starts a new send for this candidate and role, as the next round', async () => {
    await show(application('A9001', { stage: 'Assignment Round' }), { A9001: [STANDARD] });
    await screen.findByText('Round 1 — Technical');
    fireEvent.click(screen.getByRole('button', { name: 'Send Assignment' }));
    const props = JSON.parse(screen.getByTestId('send-assignment-modal').getAttribute('data-props')!);
    expect(props).toEqual({
      mode: 'create', applicationId: 'A9001', roleId: 'R9001', nextRoundNumber: 2,
      candidateName: 'Test Candidate', roleTitle: 'Test Role Alpha', candidateEmail: 'cand@example.test',
    });
  });
});

describe('Candidate page — interview rounds', () => {
  it('says so when there are none; otherwise counts them in the application header', async () => {
    await show(application('A9001', { stage: 'Interview Round 1' }));
    expect(screen.getByText('No rounds scheduled yet.')).toBeInTheDocument();
    expect(screen.queryByText(/^\d+ rounds?$/)).not.toBeInTheDocument();
  });

  it('shows the round, its panel, its time, its calendar invite and a failed invite', async () => {
    await show(application('A9001', { stage: 'Interview Round 1' }), { A9001: [round('IR1', {
      interviewer_emails: ['panel@example.test', 'second@example.test'], calendar_event_link: 'https://calendar.example.test/e/1', calendar_sync_error: 'Invite quota hit',
    })] });
    expect(await screen.findByText('Round 1 — Technical')).toBeInTheDocument();
    expect(screen.getByText('1 round')).toBeInTheDocument();
    expect(screen.getByText('👤 panel@example.test, second@example.test')).toBeInTheDocument();
    expect(screen.getByText(`📅 ${when('2026-10-22T10:00:00Z')}`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Calendar invite' })).toHaveAttribute('href', 'https://calendar.example.test/e/1');
    expect(screen.getByText('⚠ Calendar invite failed')).toHaveAttribute('title', 'Invite quota hit');
  });

  it('counts rounds in the plural', async () => {
    await show(application('A9001', { stage: 'Interview Round 2' }), { A9001: [STANDARD, round('IR9', { round_number: 2, round_name: 'Panel' })] });
    expect(await screen.findByText('2 rounds')).toBeInTheDocument();
  });

  it.each([['Pending'], ['Overdue'], ['Submitted']])('a round whose feedback is %s says so', async status => {
    await show(application('A9001', { stage: 'Interview Round 1' }), { A9001: [round('IR1', { feedback_status: status })] });
    const row = (await screen.findByText('Round 1 — Technical')).closest('.rounded-lg') as HTMLElement;
    expect(within(row).getByText(status)).toBeInTheDocument();
  });

  it.each(['hr_recruiter', 'hiring_manager', 'leadership', 'super_admin'] as const)('%s can Submit feedback on a round that has none yet (the interviewer is rarely HR)', async persona => {
    h.persona = persona;
    await show(application('A9001', { stage: 'Interview Round 1' }), { A9001: [STANDARD] });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit feedback' }));
    const dialog = screen.getByTestId('feedback-modal');
    expect(dialog).toHaveAttribute('data-round', 'IR1');
    expect(dialog).toHaveAttribute('data-candidate', 'Test Candidate');
    expect(dialog).toHaveAttribute('data-role', 'Test Role Alpha');
  });

  it('a round with feedback already submitted offers no Submit feedback, and a successful submit reloads the rounds', async () => {
    await show(application('A9001', { stage: 'Interview Round 1' }), { A9001: [STANDARD, round('IR9', { round_number: 2, round_name: 'Panel', feedback_status: 'Submitted' })] });
    await screen.findByText('Round 2 — Panel');
    expect(screen.getAllByRole('button', { name: 'Submit feedback' })).toHaveLength(1);       // only round 1
    fireEvent.click(screen.getByRole('button', { name: 'Submit feedback' }));
    const before = h.roundsList.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'succeed-feedback' }));
    await waitFor(() => expect(h.roundsList.mock.calls.length).toBeGreaterThan(before));
  });

  it('a submitted round shows its verdict and score, and expands to the full written feedback', async () => {
    await show(application('A9001', { stage: 'Interview Round 1' }), { A9001: [round('IR1', {
      feedback_status: 'Submitted', overall_assessment: 'Strong', round_recommendation: 'Proceed', overall_round_score: 4.5,
      scores_per_area: { Design: 4, Coding: 5 }, confidence_level: 'High', strengths_observed: 'Clear thinking', key_concerns: 'Limited scale experience',
      unresolved_questions: 'Team lead exposure?', suggested_probe_areas: 'Failure handling', notes: 'Test round notes',
    })] });
    expect(await screen.findByText('Strong · Proceed')).toBeInTheDocument();
    expect(screen.getByText('Score: 4.5/5')).toBeInTheDocument();
    expect(screen.queryByText('Clear thinking')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Show full feedback'));
    expect(screen.getByText('Clear thinking')).toBeInTheDocument();
    expect(screen.getByText('Limited scale experience')).toBeInTheDocument();
    expect(screen.getByText('Team lead exposure?')).toBeInTheDocument();
    expect(screen.getByText('Failure handling')).toBeInTheDocument();
    expect(screen.getByText('Test round notes')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Design:').parentElement).toHaveTextContent('Design: 4/5');
    expect(screen.getByText('Coding:').parentElement).toHaveTextContent('Coding: 5/5');
    fireEvent.click(screen.getByTitle('Show full feedback'));
    expect(screen.queryByText('Clear thinking')).not.toBeInTheDocument();
  });

  it('a submitted round with nothing written says "No further detail recorded."', async () => {
    await show(application('A9001', { stage: 'Interview Round 1' }), { A9001: [round('IR1', { feedback_status: 'Submitted' })] });
    fireEvent.click(await screen.findByTitle('Show full feedback'));
    expect(screen.getByText('No further detail recorded.')).toBeInTheDocument();
  });

  it('a round with no feedback yet has nothing to expand', async () => {
    await show(application('A9001', { stage: 'Interview Round 1' }), { A9001: [STANDARD] });
    await screen.findByText('Round 1 — Technical');
    expect(screen.queryByTitle('Show full feedback')).not.toBeInTheDocument();
  });
});

describe('Candidate page — assignment rounds', () => {
  const atAssignment = (rounds: ReturnType<typeof round>[]) => show(application('A9001', { stage: 'Assignment Round' }), { A9001: rounds });

  it('marks the round as an Assignment', async () => {
    await atAssignment([ASSIGNMENT()]);
    expect(await screen.findByText('Assignment', { selector: 'span.bg-violet-100' })).toBeInTheDocument();
  });

  it('a send that never succeeded offers "Send assignment" again to HR, prefilled from what was last tried, and shows the e-mail failure', async () => {
    await atAssignment([ASSIGNMENT({
      assignment_email_error: 'Gmail refused', assignment_mail_body: 'Hello, please do this.', assignment_cc: ['a@example.test', 'b@example.test'],
      assignment_link: 'https://tasks.example.test/1', assignment_supporting_docs: 'https://docs.example.test/1',
    })]);
    expect(await screen.findByText('⚠ Assignment email failed to send')).toHaveAttribute('title', 'Gmail refused');
    fireEvent.click(screen.getByRole('button', { name: 'Send assignment' }));
    expect(JSON.parse(screen.getByTestId('send-assignment-modal').getAttribute('data-props')!)).toEqual({
      mode: 'retry', applicationId: 'A9001', roundId: 'IR2', roleId: 'R9001', candidateName: 'Test Candidate', roleTitle: 'Test Role Alpha',
      candidateEmail: 'cand@example.test', initialMailBody: 'Hello, please do this.', initialCc: 'a@example.test, b@example.test',
      initialAssignmentLink: 'https://tasks.example.test/1', initialSupportingDocs: 'https://docs.example.test/1',
    });
  });

  it('a Hiring Manager is not offered the send, the retry or the submission (HR-owned steps)', async () => {
    h.persona = 'hiring_manager';
    await atAssignment([ASSIGNMENT()]);
    await screen.findByText('Round 2 — Take-home');
    expect(screen.queryByRole('button', { name: /^Send [aA]ssignment$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record submission' })).not.toBeInTheDocument();
  });

  it('sent but not submitted: shows when it is due (or that it is overdue) and offers "Record submission" to HR only', async () => {
    await atAssignment([ASSIGNMENT({ assignment_send_date: '2026-10-20T00:00:00Z', assignment_deadline: '2099-12-31T10:00:00Z' })]);
    expect(await screen.findByText(`Due ${when('2099-12-31T10:00:00Z')}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record submission' })).toBeInTheDocument();
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
  });

  it('a deadline in the past, not yet submitted, shows Overdue', async () => {
    await atAssignment([ASSIGNMENT({ assignment_send_date: '2019-12-20T00:00:00Z', assignment_deadline: '2020-01-01T10:00:00Z' })]);
    expect(await screen.findByText('Overdue')).toBeInTheDocument();
  });

  it('once submitted, no status pill is shown any more', async () => {
    await atAssignment([ASSIGNMENT({ assignment_send_date: '2019-12-20T00:00:00Z', assignment_deadline: '2020-01-01T10:00:00Z', assignment_submission_date: '2019-12-30T00:00:00Z' })]);
    await screen.findByText('Round 2 — Take-home');
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Due /)).not.toBeInTheDocument();
  });

  it('Record submission asks for a link, then records the trimmed link, says so and reloads the rounds', async () => {
    await atAssignment([ASSIGNMENT({ assignment_send_date: '2026-10-20T00:00:00Z', assignment_deadline: '2099-12-31T10:00:00Z' })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Record submission' }));
    const dialog = modalOf('Record submission');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(h.toastError).toHaveBeenCalledWith('Submission link is required');
    expect(h.submitAssignment).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByPlaceholderText(/link to the submission/), { target: { value: '  https://repo.example.test/sub  ' } });
    const before = h.roundsList.mock.calls.length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.submitAssignment).toHaveBeenCalledWith('IR2', 'https://repo.example.test/sub'));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('Submission recorded'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Record submission' })).not.toBeInTheDocument());
    await waitFor(() => expect(h.roundsList.mock.calls.length).toBeGreaterThan(before));
  });

  it('a failed Record submission shows a toast and keeps the dialog', async () => {
    h.submitAssignment.mockImplementation(async () => { throw new Error('boom'); });
    await atAssignment([ASSIGNMENT({ assignment_send_date: '2026-10-20T00:00:00Z', assignment_deadline: '2099-12-31T10:00:00Z' })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Record submission' }));
    const dialog = modalOf('Record submission');
    fireEvent.change(within(dialog).getByPlaceholderText(/link to the submission/), { target: { value: 'https://repo.example.test/sub' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Failed to record submission'));
    expect(screen.getByRole('heading', { name: 'Record submission' })).toBeInTheDocument();
  });

  it.each(['hr_recruiter', 'hiring_manager', 'leadership', 'super_admin'] as const)('%s can Record outcome once the work is submitted (the evaluation is done by whoever can judge it)', async persona => {
    h.persona = persona;
    await atAssignment([ASSIGNMENT({ assignment_send_date: '2026-10-20T00:00:00Z', assignment_submission_date: '2026-10-25T00:00:00Z' })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Record outcome' }));
    const dialog = screen.getByTestId('outcome-modal');
    expect(dialog).toHaveAttribute('data-round', 'IR2');
    expect(dialog).toHaveAttribute('data-candidate', 'Test Candidate');
    expect(dialog).toHaveAttribute('data-role', 'Test Role Alpha');
  });

  it('a recorded outcome ends the buttons, shows the result and score, and expands to the scores and notes', async () => {
    await atAssignment([ASSIGNMENT({
      assignment_send_date: '2026-10-20T00:00:00Z', assignment_submission_date: '2026-10-25T00:00:00Z', assignment_outcome: 'Approved for Next Round', assignment_overall_score: 4.5,
      score_technical_accuracy: 4, score_clarity: 5, assignment_notes: 'Test assignment notes',
    })]);
    expect(await screen.findByText('Approved for Next Round · 4.5/5')).toBeInTheDocument();
    for (const name of ['Record outcome', 'Record submission', 'Send assignment']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Show full feedback'));
    expect(screen.getByText('Technical accuracy:').parentElement).toHaveTextContent('Technical accuracy: 4/5');
    expect(screen.getByText('Clarity:').parentElement).toHaveTextContent('Clarity: 5/5');
    expect(screen.queryByText('Problem solving:')).not.toBeInTheDocument();                   // never scored
    expect(screen.getByText('Test assignment notes')).toBeInTheDocument();
  });
});

describe('Candidate page — reference checks', () => {
  it('HR gets "Add Reference Check" only at the Reference Check stage, for that application', async () => {
    for (const stage of STAGES) {
      await show(application('A9001', { stage }));
      const has = screen.queryByRole('button', { name: 'Add Reference Check' }) !== null;
      expect({ stage, has }).toEqual({ stage, has: stage === 'Reference Check' });
      cleanup();
      h.roundsList.mockClear();
    }
  });

  it('a Hiring Manager never gets it', async () => {
    h.persona = 'hiring_manager';
    await show(application('A9001', { stage: 'Reference Check' }));
    expect(screen.queryByRole('button', { name: 'Add Reference Check' })).not.toBeInTheDocument();
  });

  it('opens the dialog for the application, and a successful add reloads the reference checks', async () => {
    await show(application('A9001', { stage: 'Reference Check' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Reference Check' }));
    expect(screen.getByTestId('refcheck-modal')).toHaveAttribute('data-application', 'A9001');
    const before = h.refChecksList.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'succeed-refcheck' }));
    await waitFor(() => expect(h.refChecksList.mock.calls.length).toBeGreaterThan(before));
  });

  it('says so when there are none', async () => {
    await show(application('A9001', { stage: 'Reference Check' }));
    expect(await screen.findByText('No reference checks added yet.')).toBeInTheDocument();
  });

  it('lists each check with the referee, relationship, verdict, reference number and the call notes', async () => {
    await show(application('A9001', { stage: 'Reference Check' }), {}, { A9001: [refCheck('RC1'), refCheck('RC2', { reference_name: 'Second Referee', feedback: 'Poor', reference_number: 'RC9002', reference_call_notes: null })] });
    expect(await screen.findByText('Test Referee')).toBeInTheDocument();
    expect(screen.getByText('Second Referee')).toBeInTheDocument();
    expect(screen.getAllByText('Reporting Manager')).toHaveLength(2);
    expect(screen.getByText('Good')).toBeInTheDocument();
    expect(screen.getByText('Poor')).toBeInTheDocument();
    expect(screen.getByText('RC9001')).toBeInTheDocument();
    expect(screen.getByText('RC9002')).toBeInTheDocument();
    expect(screen.getByText('Reliable and calm.')).toBeInTheDocument();
    expect(screen.queryByText('No reference checks added yet.')).not.toBeInTheDocument();
  });
});
