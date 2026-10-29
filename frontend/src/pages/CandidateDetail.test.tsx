import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { format } from 'date-fns';
import { REJECTION_REASONS, WITHDRAWAL_REASONS, OVER_BUDGET_SHORTLIST_REASONS } from '../types/index.ts';
import { candidate, detailApplication as application } from '../test/candidateDetailFixtures.ts';

// The Candidate page, un-mocked except for the network and the heavy children (the ResumeIQ panel and the interview /
// assignment / reference modals, whose props are what is checked). What it pins: who gets which controls, who may see
// compensation, the Status dialog (rejection reasons, the withdrawal reason, the rejection e-mail), the Founder flag, the Stage
// dialog, the editable sections and the activity timeline. Interview rounds, assignments and reference checks are in
// CandidateDetail.rounds.test.tsx.
const h = vi.hoisted(() => ({
  persona: 'hr_recruiter' as 'hr_recruiter' | 'hiring_manager' | 'leadership' | 'super_admin',
  userName: 'Test Reviewer',
  get: vi.fn(), activity: vi.fn(), update: vi.fn(), linkRole: vi.fn(),
  updateStatus: vi.fn(), setFounderFlag: vi.fn(), updateNotes: vi.fn(), advanceStage: vi.fn(),
  roundsList: vi.fn(), submitAssignment: vi.fn(), refChecksList: vi.fn(), agenciesList: vi.fn(), rolesList: vi.fn(),
  toastSuccess: vi.fn(), toastError: vi.fn(),
}));
vi.mock('../services/api.ts', () => ({
  candidatesApi: {
    get: (id: string) => h.get(id), activity: (id: string) => h.activity(id),
    update: (...a: unknown[]) => h.update(...a), linkRole: (...a: unknown[]) => h.linkRole(...a),
  },
  applicationsApi: {
    updateStatus: (...a: unknown[]) => h.updateStatus(...a), setFounderFlag: (...a: unknown[]) => h.setFounderFlag(...a),
    updateNotes: (...a: unknown[]) => h.updateNotes(...a), advanceStage: (...a: unknown[]) => h.advanceStage(...a),
  },
  interviewsApi: { list: (id: string) => h.roundsList(id), submitAssignment: (...a: unknown[]) => h.submitAssignment(...a) },
  refChecksApi: { list: (id: string) => h.refChecksList(id) },
  agenciesApi: { list: () => h.agenciesList() },
  rolesApi: { list: (p: unknown) => h.rolesList(p) },
}));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({
    canHR: h.persona !== 'hiring_manager',
    user: { id: 'u1', name: h.userName, email: 'reviewer@example.test', persona: h.persona },
  }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: (m: string) => h.toastSuccess(m), error: (m: string) => h.toastError(m) } }));
vi.mock('../components/ResumeIQPanel.tsx', () => ({ default: ({ app }: { app: { id: string } }) => <div data-testid="resumeiq-panel" data-app={app.id} /> }));
vi.mock('../components/InterviewFeedbackModal.tsx', () => ({ default: () => null }));
vi.mock('../components/ScheduleRoundModal.tsx', () => ({ default: () => null }));
vi.mock('../components/SendAssignmentModal.tsx', () => ({ default: () => null }));
vi.mock('../components/AssignmentOutcomeModal.tsx', () => ({ default: () => null }));
vi.mock('../components/AddReferenceCheckModal.tsx', () => ({ default: () => null }));

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
const load = (apps: Record<string, unknown>[], cand: Record<string, unknown> = candidate()) =>
  h.get.mockResolvedValue({ data: { candidate: cand, applications: apps } });
const show = async (apps: Record<string, unknown>[] = [application('A9001')], cand: Record<string, unknown> = candidate()) => {
  load(apps, cand);
  mount();
  await screen.findByRole('heading', { level: 1, name: cand.full_name as string });
};
const modalOf = (heading: string | RegExp) => screen.getByRole('heading', { name: heading }).closest('.fixed') as HTMLElement;
const section = (title: string) => screen.getByRole('heading', { name: title }).closest('.card') as HTMLElement;
const applicationsCard = () => screen.getByRole('heading', { name: /^Applications \(/ }).closest('.card') as HTMLElement;
const openStatus = () => { fireEvent.click(screen.getByRole('button', { name: 'Status' })); return modalOf('Update status'); };
const update = (modal: HTMLElement) => fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));
const choose = (modal: HTMLElement, from: string, to: string) => fireEvent.change(within(modal).getByDisplayValue(from), { target: { value: to } });

beforeEach(() => {
  h.persona = 'hr_recruiter';
  h.userName = 'Test Reviewer';
  for (const f of [h.get, h.activity, h.update, h.linkRole, h.updateStatus, h.setFounderFlag, h.updateNotes, h.advanceStage, h.roundsList,
    h.submitAssignment, h.refChecksList, h.agenciesList, h.rolesList, h.toastSuccess, h.toastError]) f.mockReset();
  h.activity.mockResolvedValue({ data: { activity: [] } });
  h.roundsList.mockResolvedValue({ data: { rounds: [] } });
  h.refChecksList.mockResolvedValue({ data: { ref_checks: [] } });
  h.agenciesList.mockResolvedValue({ data: { agencies: [{ id: 'AGN9001', name: 'Test Agency' }] } });
  h.rolesList.mockResolvedValue({ data: { roles: [{ id: 'R9001', title: 'Test Role Alpha' }, { id: 'R9002', title: 'Test Role Beta' }] } });
  for (const f of [h.update, h.linkRole, h.updateStatus, h.setFounderFlag, h.updateNotes, h.advanceStage]) f.mockResolvedValue({ data: {} });
});

describe('Candidate page — loading and what it asks for', () => {
  it('shows the spinner (and no candidate) while the candidate is on its way', async () => {
    h.get.mockReturnValue(new Promise(() => {}));
    mount();
    await waitFor(() => expect(h.get).toHaveBeenCalled());
    expect(document.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('says "Candidate not found" when the answer holds no candidate', async () => {
    h.get.mockResolvedValue({ data: { applications: [] } });
    mount();
    expect(await screen.findByText('Candidate not found')).toBeInTheDocument();
  });

  it('asks for the candidate and activity by id, and the interview rounds and reference checks of EACH application', async () => {
    await show([application('A9001'), application('A9002', { role_id: 'R9002', role_title: 'Test Role Beta' })]);
    expect(h.get).toHaveBeenCalledWith('C9001');
    expect(h.activity).toHaveBeenCalledWith('C9001');
    await waitFor(() => expect(h.roundsList.mock.calls.map(c => c[0]).sort()).toEqual(['A9001', 'A9002']));
    await waitFor(() => expect(h.refChecksList.mock.calls.map(c => c[0]).sort()).toEqual(['A9001', 'A9002']));
  });

  it('does not ask for interview rounds or reference checks when there is no application', async () => {
    await show([]);
    expect(await screen.findByText('No applications')).toBeInTheDocument();
    expect(h.roundsList).not.toHaveBeenCalled();
    expect(h.refChecksList).not.toHaveBeenCalled();
  });
});

describe('Candidate page — the summary', () => {
  it('shows the contact details, with safe external links for LinkedIn and the resume, and the tags', async () => {
    await show();
    expect(screen.getAllByText('cand@example.test').length).toBeGreaterThan(0);
    expect(screen.getAllByText('+000 0000').length).toBeGreaterThan(0);
    for (const [name, href] of [['LinkedIn', 'https://linkedin.example.test/in/test-candidate'], ['Resume', 'https://drive.example.test/resume']] as const) {
      const link = screen.getAllByRole('link', { name }).find(a => a.getAttribute('href') === href)!;
      expect(link).toBeTruthy();
      expect(link).toHaveAttribute('target', '_blank');
      expect(link.getAttribute('rel')).toMatch(/noopener/);
      expect(link.getAttribute('rel')).toMatch(/noreferrer/);
    }
    expect(screen.getAllByText('strong').length).toBeGreaterThan(0);
  });

  it('shows each application: role link, priority, stage, status, screening status, ResumeIQ score, source and the SLA tag', async () => {
    await show([application('A9001', { score_avg: 7.5, sla_breach: true })]);
    const card = within(applicationsCard());
    expect(card.getByRole('link', { name: 'Test Role Alpha' })).toHaveAttribute('href', '/roles/R9001');
    expect(card.getByText('P1')).toBeInTheDocument();
    expect(card.getByText('Applied and Screened')).toBeInTheDocument();
    expect(card.getByText('Active')).toBeInTheDocument();
    expect(card.getByText('New')).toBeInTheDocument();
    expect(card.getByText('ResumeIQ: 7.5/10')).toBeInTheDocument();
    expect(card.getByText('Source: Job Application Form')).toBeInTheDocument();
    expect(card.getByText('SLA')).toBeInTheDocument();
    expect(card.getByText('Applications (1)')).toBeInTheDocument();
  });

  it('shows one stage tracker per application, labelled with the role only when there is more than one', async () => {
    await show();
    expect(document.querySelectorAll('[title="Joined"]')).toHaveLength(1);
    expect(screen.getAllByText('Test Role Alpha')).toHaveLength(1);                  // just the application row\'s link
    cleanup();
    await show([application('A9001'), application('A9002', { role_id: 'R9002', role_title: 'Test Role Beta' })]);
    expect(document.querySelectorAll('[title="Joined"]')).toHaveLength(2);
    expect(screen.getAllByText('Test Role Beta')).toHaveLength(2);                   // the tracker label and the row\'s link
  });

  it('a candidate with several applications lists all of them, each with its own ResumeIQ panel', async () => {
    await show([application('A9001'), application('A9002', { role_id: 'R9002', role_title: 'Test Role Beta' })]);
    expect(screen.getByText('Applications (2)')).toBeInTheDocument();
    expect(screen.getAllByTestId('resumeiq-panel').map(p => p.getAttribute('data-app'))).toEqual(['A9001', 'A9002']);
  });

  it('shows screening answers with their links clickable', async () => {
    await show([application('A9001', { screening_answers: [{ question: 'Why this role?', answer: 'See https://work.example.test/portfolio for details' }] })]);
    expect(screen.getByText('Why this role?')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://work.example.test/portfolio' })).toHaveAttribute('href', 'https://work.example.test/portfolio');
  });

  it('flags a failed rejection e-mail, and a sent one', async () => {
    await show([application('A9001', { status: 'Rejected', rejection_email_error: 'Mailbox unavailable' })]);
    expect(screen.getByText('⚠ Rejection email failed to send')).toHaveAttribute('title', 'Mailbox unavailable');
    cleanup();
    await show([application('A9001', { status: 'Rejected', rejection_email_sent_at: '2026-10-20T00:00:00Z' })]);
    expect(screen.getByText('✓ Rejection email sent')).toBeInTheDocument();
  });
});

describe('Candidate page — what each persona is given', () => {
  it.each(['hr_recruiter', 'leadership', 'super_admin'] as const)('%s gets Stage, Status, Add Application, the Founder flag and the screening-notes button', async persona => {
    h.persona = persona;
    await show();
    expect(screen.getByRole('button', { name: 'Stage' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Application' })).toBeInTheDocument();
    expect(screen.getByTitle('Flag for Founder Review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add HR Screening Notes' })).toBeInTheDocument();
    await waitFor(() => expect(h.agenciesList).toHaveBeenCalled());
  });

  it('a Hiring Manager gets none of them, and never asks for the agency list (HR only on the server)', async () => {
    h.persona = 'hiring_manager';
    await show();
    expect(screen.queryByRole('button', { name: 'Stage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Application' })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Flag for Founder Review')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add HR Screening Notes' })).not.toBeInTheDocument();
    expect(h.agenciesList).not.toHaveBeenCalled();
  });

  it('with one application Stage and Status sit in the page header; with several, on each application row', async () => {
    await show();
    expect(screen.getByRole('button', { name: 'Stage' }).closest('.card')).toBeNull();
    expect(screen.getByRole('button', { name: 'Status' }).closest('.card')).toBeNull();
    cleanup();
    await show([application('A9001'), application('A9002', { role_id: 'R9002', role_title: 'Test Role Beta' })]);
    const stages = screen.getAllByRole('button', { name: 'Stage' });
    expect(stages).toHaveLength(2);
    for (const b of [...stages, ...screen.getAllByRole('button', { name: 'Status' })]) expect(b.closest('.card')).not.toBeNull();
  });

  it('with no application there is nothing to change the stage or status of, but an application can be added', async () => {
    await show([]);
    expect(screen.queryByRole('button', { name: 'Stage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Application' })).toBeInTheDocument();
  });

  it('a Hiring Manager is offered the edit pencils on the profile sections (the server refuses their save, HR only)', async () => {
    h.persona = 'hiring_manager';
    await show();
    // Documented, not endorsed: PATCH /candidates/:id is HR-only on the server.
    expect(screen.getAllByTitle(/^Edit /).length).toBeGreaterThan(0);
  });
});

describe('Candidate page — who sees compensation', () => {
  const COMP_LABEL = 'Expected CTC';
  const showWith = async (hmField: string, persona: typeof h.persona, userName = 'Test Reviewer') => {
    h.persona = persona; h.userName = userName;
    await show([application('A9001', { hiring_manager_name: hmField })]);
  };

  it.each([
    ['hr_recruiter', 'Test Manager One'],
    ['leadership', 'Test Manager One'],
    ['super_admin', 'Test Manager One'],
  ] as const)('%s sees the Compensation fields whoever the role\'s Hiring Manager is', async (persona, hm) => {
    await showWith(hm, persona);
    expect(within(section('Compensation')).getByText(COMP_LABEL)).toBeInTheDocument();
    expect(within(section('Compensation')).getByText('Current CTC (Fixed and Variable breakup) in LPA')).toBeInTheDocument();
  });

  it('a Hiring Manager named as the role\'s Hiring Manager sees them', async () => {
    await showWith('Test Manager One', 'hiring_manager', 'Test Manager One');
    expect(within(section('Compensation')).getByText(COMP_LABEL)).toBeInTheDocument();
  });

  it('...also when the role lists several Hiring Managers and they are the second, ignoring case and spacing', async () => {
    await showWith('Test Manager One,  Test Manager Two', 'hiring_manager', 'test manager   TWO');
    expect(within(section('Compensation')).getByText(COMP_LABEL)).toBeInTheDocument();
  });

  it('...or when they are the Hiring Manager of just one of the candidate\'s several applications', async () => {
    h.persona = 'hiring_manager'; h.userName = 'Test Manager Two';
    await show([application('A9001', { hiring_manager_name: 'Test Manager One' }), application('A9002', { role_id: 'R9002', role_title: 'Test Role Beta', hiring_manager_name: 'Test Manager Two' })]);
    expect(within(section('Compensation')).getByText(COMP_LABEL)).toBeInTheDocument();
  });

  it.each([
    ['somebody else', 'Test Manager One', 'Test Manager Other'],
    ['a shorter name than the listed one', 'Test Manager One', 'Test Manager'],
    ['a longer name than the listed one', 'Test Manager', 'Test Manager One'],
    ['no Hiring Manager listed at all', '', 'Test Manager One'],
  ])('a Hiring Manager who is %s does not see them, though the section and the notice period stay', async (_why, hmField, userName) => {
    await showWith(hmField, 'hiring_manager', userName);
    const comp = within(section('Compensation'));
    expect(comp.queryByText(COMP_LABEL)).not.toBeInTheDocument();
    expect(comp.queryByText('Current CTC (Fixed and Variable breakup) in LPA')).not.toBeInTheDocument();
    expect(comp.getByText('Notice Period (days)')).toBeInTheDocument();
  });

  it('...and editing that section for them shows and sends only the notice period', async () => {
    await showWith('Test Manager One', 'hiring_manager', 'Test Manager Other');
    fireEvent.click(screen.getByTitle('Edit Compensation'));
    const comp = within(section('Compensation'));
    expect(comp.getAllByRole('spinbutton')).toHaveLength(1);
    fireEvent.change(comp.getByDisplayValue('30'), { target: { value: '45' } });
    fireEvent.click(comp.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.update).toHaveBeenCalledWith('C9001', { notice_period_days: 45 }));
  });

  it('the CTC line and the Over Budget badge show for HR when expected is above the top of the band', async () => {
    await show([application('A9001', { candidate_expected_ctc: 20 })]);
    const card = within(applicationsCard());
    expect(card.getByText('₹10L → ₹20L')).toBeInTheDocument();
    expect(card.getByText('Over Budget')).toBeInTheDocument();
  });

  it('...and not the badge when it is within the band', async () => {
    await show([application('A9001', { candidate_expected_ctc: 14 })]);
    expect(within(applicationsCard()).getByText('₹10L → ₹14L')).toBeInTheDocument();
    expect(within(applicationsCard()).queryByText('Over Budget')).not.toBeInTheDocument();
  });

  it('falls back to the candidate\'s own profile figures when the application carries none', async () => {
    await show([application('A9001', { candidate_ctc_fixed: undefined, candidate_expected_ctc: undefined })]);
    expect(within(applicationsCard()).getByText('₹10L → ₹14L')).toBeInTheDocument();
  });

  it('a Hiring Manager\'s response with every compensation field stripped shows no CTC line and no Over Budget badge', async () => {
    h.persona = 'hiring_manager'; h.userName = 'Test Manager Other';
    await show(
      [application('A9001', { candidate_ctc_fixed: undefined, candidate_expected_ctc: undefined, role_ctc_band: undefined })],
      candidate({ current_ctc_fixed: undefined, expected_ctc: undefined }),
    );
    expect(within(applicationsCard()).queryByText(/₹/)).not.toBeInTheDocument();
    expect(screen.queryByText('Over Budget')).not.toBeInTheDocument();
  });
});

describe('Candidate page — Screening & Risk Notes', () => {
  it('HR sees the section at once when a note exists, with the internal risk notes among its fields', async () => {
    await show([application('A9001', { hr_recruiter_summary: 'Test recruiter summary', internal_risk_notes: 'Test risk note' })]);
    expect(within(section('Screening & Risk Notes')).getByText('Test recruiter summary')).toBeInTheDocument();
    expect(within(section('Screening & Risk Notes')).getByText('Internal Risk Notes')).toBeInTheDocument();
    expect(within(section('Screening & Risk Notes')).getByText('Test risk note')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add HR Screening Notes' })).not.toBeInTheDocument();
  });

  it('HR with no note yet sees only "+ Add HR Screening Notes", which reveals the section', async () => {
    await show();
    expect(screen.queryByRole('heading', { name: 'Screening & Risk Notes' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ Add HR Screening Notes' }));
    expect(screen.getByRole('heading', { name: 'Screening & Risk Notes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add HR Screening Notes' })).not.toBeInTheDocument();
  });

  it('saving the section sends only what changed to the application\'s notes endpoint and reloads the candidate', async () => {
    await show([application('A9001', { hr_recruiter_summary: 'Old summary' })]);
    const before = h.get.mock.calls.length;
    fireEvent.click(screen.getByTitle('Edit Screening & Risk Notes'));
    fireEvent.change(within(section('Screening & Risk Notes')).getByDisplayValue('Old summary'), { target: { value: 'New summary' } });
    fireEvent.click(within(section('Screening & Risk Notes')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.updateNotes).toHaveBeenCalledWith('A9001', { hr_recruiter_summary: 'New summary' }));
    expect(h.toastSuccess).toHaveBeenCalledWith('Screening & Risk Notes updated');
    await waitFor(() => expect(h.get.mock.calls.length).toBeGreaterThan(before));
  });

  it('a Hiring Manager never gets the section: no internal risk notes, no key concerns, only the recruiter summary as a quote', async () => {
    h.persona = 'hiring_manager';
    await show([application('A9001', {
      hr_recruiter_summary: 'Test recruiter summary', hr_key_concerns: 'Test concern text', hr_comp_alignment: 'Test comp alignment', internal_risk_notes: 'Test risk note',
    })]);
    expect(screen.queryByRole('heading', { name: 'Screening & Risk Notes' })).not.toBeInTheDocument();
    expect(screen.getByText('"Test recruiter summary"')).toBeInTheDocument();
    for (const secret of ['Test concern text', 'Test comp alignment', 'Test risk note']) expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(screen.queryByText('Internal Risk Notes')).not.toBeInTheDocument();
  });

  it('a Hiring Manager sees nothing at all in that place when there is no recruiter summary', async () => {
    h.persona = 'hiring_manager';
    await show([application('A9001', { internal_risk_notes: 'Test risk note' })]);
    expect(screen.queryByText('Test risk note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Test recruiter summary/)).not.toBeInTheDocument();
  });
});

describe('Candidate page — the Founder Review flag', () => {
  it('HR flags an unflagged application with an optional note, and the dialog closes and the candidate reloads', async () => {
    await show();
    const before = h.get.mock.calls.length;
    fireEvent.click(screen.getByTitle('Flag for Founder Review'));
    const modal = modalOf('Flag for Founder Review');
    fireEvent.change(within(modal).getByPlaceholderText('Note (optional)'), { target: { value: 'worth a founder look' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(h.setFounderFlag).toHaveBeenCalledWith('A9001', true, 'worth a founder look'));
    expect(h.toastSuccess).toHaveBeenCalledWith('Flagged for Founder Review');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Flag for Founder Review' })).not.toBeInTheDocument());
    await waitFor(() => expect(h.get.mock.calls.length).toBeGreaterThan(before));
  });

  it('a blank note is sent as no note', async () => {
    await show();
    fireEvent.click(screen.getByTitle('Flag for Founder Review'));
    fireEvent.click(within(modalOf('Flag for Founder Review')).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(h.setFounderFlag).toHaveBeenCalledWith('A9001', true, undefined));
  });

  it('a flagged application offers to clear the flag instead', async () => {
    await show([application('A9001', { founder_review_flag: true })]);
    expect(screen.queryByTitle('Flag for Founder Review')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Clear Founder Review flag'));
    fireEvent.click(within(modalOf('Clear Founder Review flag')).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(h.setFounderFlag).toHaveBeenCalledWith('A9001', false, undefined));
    expect(h.toastSuccess).toHaveBeenCalledWith('Founder Review flag cleared');
  });

  it('a failure shows a toast and keeps the dialog open', async () => {
    h.setFounderFlag.mockImplementation(async () => { throw new Error('boom'); });
    await show();
    fireEvent.click(screen.getByTitle('Flag for Founder Review'));
    fireEvent.click(within(modalOf('Flag for Founder Review')).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Failed to update Founder Review flag'));
    expect(screen.getByRole('heading', { name: 'Flag for Founder Review' })).toBeInTheDocument();
  });

  it('Cancel changes nothing', async () => {
    await show();
    fireEvent.click(screen.getByTitle('Flag for Founder Review'));
    fireEvent.click(within(modalOf('Flag for Founder Review')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Flag for Founder Review' })).not.toBeInTheDocument();
    expect(h.setFounderFlag).not.toHaveBeenCalled();
  });

  it('a Hiring Manager sees a flagged application\'s Founder badge but cannot click it, and nothing for an unflagged one', async () => {
    h.persona = 'hiring_manager';
    await show([application('A9001', { founder_review_flag: true }), application('A9002', { role_id: 'R9002', role_title: 'Test Role Beta' })]);
    const badge = screen.getByText('Founder');
    expect(badge.closest('button')).toBeNull();
    expect(screen.getAllByText('Founder')).toHaveLength(1);
  });
});

describe('Candidate page — the Status dialog', () => {
  it('opens on the application\'s current status and offers Active, Rejected, Withdrawn and Hold for Future', async () => {
    await show();
    const modal = openStatus();
    const select = within(modal).getByDisplayValue('Active') as HTMLSelectElement;
    expect(Array.from(select.options).map(o => o.value)).toEqual(['Active', 'Rejected', 'Withdrawn', 'Hold for Future']);
  });

  it('Rejected cannot be sent without a reason', async () => {
    await show();
    const modal = openStatus();
    choose(modal, 'Active', 'Rejected');
    update(modal);
    expect(h.toastError).toHaveBeenCalledWith('Select at least one reason');
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('Rejected offers every rejection reason as a tick box, so several can be picked', async () => {
    await show();
    const modal = openStatus();
    choose(modal, 'Active', 'Rejected');
    for (const r of REJECTION_REASONS) expect(within(modal).getByLabelText(r)).toBeInTheDocument();
  });

  it('Rejected with two reasons sends the list and the older joined string, says so, reloads, closes and forgets the reasons', async () => {
    await show();
    const before = h.get.mock.calls.length;
    const modal = openStatus();
    choose(modal, 'Active', 'Rejected');
    fireEvent.click(within(modal).getByLabelText('Missing mandatory skill'));
    fireEvent.click(within(modal).getByLabelText('Communication gap'));
    update(modal);
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledTimes(1));
    expect(h.updateStatus).toHaveBeenCalledWith('A9001', {
      new_status: 'Rejected', rejection_reason_cats: ['Missing mandatory skill', 'Communication gap'],
      rejection_reason_cat: 'Missing mandatory skill; Communication gap',
    });
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('Status updated to Rejected'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Update status' })).not.toBeInTheDocument());
    await waitFor(() => expect(h.get.mock.calls.length).toBeGreaterThan(before));
    // reopened: the earlier ticks are gone
    const again = openStatus();
    choose(again, 'Active', 'Rejected');
    expect(within(again).getByLabelText('Missing mandatory skill')).not.toBeChecked();
    expect(within(again).getByLabelText('Communication gap')).not.toBeChecked();
  });

  it('the detail goes with a rejection', async () => {
    await show();
    const modal = openStatus();
    choose(modal, 'Active', 'Rejected');
    fireEvent.click(within(modal).getByLabelText('Short average tenure'));
    fireEvent.change(within(modal).getByPlaceholderText('Additional detail (optional)'), { target: { value: 'moves every year' } });
    update(modal);
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledWith('A9001', expect.objectContaining({ rejection_reason_detail: 'moves every year' })));
  });

  it('Withdrawn is a single reason picked from the withdrawal reasons, sent as a one-item list', async () => {
    await show();
    const modal = openStatus();
    choose(modal, 'Active', 'Withdrawn');
    expect(within(modal).queryByLabelText(REJECTION_REASONS[0])).not.toBeInTheDocument();
    const select = within(modal).getByDisplayValue('Select reason *') as HTMLSelectElement;
    expect(Array.from(select.options).map(o => o.value)).toEqual(['', ...WITHDRAWAL_REASONS]);
    update(modal);
    expect(h.toastError).toHaveBeenCalledWith('Select at least one reason');
    expect(h.updateStatus).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: 'Accepted another offer' } });
    update(modal);
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledWith('A9001', { new_status: 'Withdrawn', rejection_reason_cats: ['Accepted another offer'], rejection_reason_cat: 'Accepted another offer' }));
  });

  it('Hold for Future carries no reasons, even after Rejected was opened and ticked first', async () => {
    await show();
    const modal = openStatus();
    choose(modal, 'Active', 'Rejected');
    fireEvent.click(within(modal).getByLabelText('Communication gap'));
    choose(modal, 'Rejected', 'Hold for Future');
    update(modal);
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledTimes(1));
    const sent = h.updateStatus.mock.calls[0][1] as Record<string, unknown>;
    expect(sent.new_status).toBe('Hold for Future');
    expect(sent.rejection_reason_cats).toBeUndefined();
    expect(sent.rejection_reason_cat).toBeUndefined();
  });

  it('a failed update shows a toast and keeps the dialog open', async () => {
    h.updateStatus.mockImplementation(async () => { throw new Error('boom'); });
    await show();
    const modal = openStatus();
    choose(modal, 'Active', 'Hold for Future');
    update(modal);
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Failed to update status'));
    expect(screen.getByRole('heading', { name: 'Update status' })).toBeInTheDocument();
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it('Cancel changes nothing', async () => {
    await show();
    const modal = openStatus();
    fireEvent.click(within(modal).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Update status' })).not.toBeInTheDocument();
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('opened from an application row it is for THAT application (its role is in the e-mail draft)', async () => {
    await show([application('A9001'), application('A9002', { role_id: 'R9002', role_title: 'Test Role Beta' })]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Status' })[1]);
    const modal = modalOf('Update status');
    choose(modal, 'Active', 'Rejected');
    fireEvent.click(within(modal).getByLabelText('Communication gap'));
    fireEvent.click(within(modal).getByLabelText('Send rejection email to candidate'));
    expect(within(modal).getByDisplayValue('Update on your application — Test Role Beta')).toBeInTheDocument();
    update(modal);
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledWith('A9002', expect.objectContaining({ new_status: 'Rejected' })));
  });
});

describe('Candidate page — the rejection e-mail', () => {
  const rejectWithEmail = async () => {
    await show();
    const modal = openStatus();
    choose(modal, 'Active', 'Rejected');
    fireEvent.click(within(modal).getByLabelText('Compensation mismatch'));
    return modal;
  };

  it('is off until asked for, then shows the recipient and a draft for this candidate and role that never names the reason', async () => {
    const modal = await rejectWithEmail();
    expect(within(modal).queryByDisplayValue(/Update on your application/)).not.toBeInTheDocument();
    fireEvent.click(within(modal).getByLabelText('Send rejection email to candidate'));
    expect(within(modal).getByText('To:').parentElement).toHaveTextContent('To: cand@example.test');
    expect(within(modal).getByDisplayValue('Update on your application — Test Role Alpha')).toBeInTheDocument();
    const body = within(modal).getByDisplayValue(/^Hi Test Candidate,/) as HTMLTextAreaElement;
    expect(body.value.toLowerCase()).not.toContain('compensation mismatch');
  });

  it('without it ticked, no e-mail fields are sent', async () => {
    const modal = await rejectWithEmail();
    update(modal);
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledTimes(1));
    const sent = h.updateStatus.mock.calls[0][1] as Record<string, unknown>;
    expect(sent.send_rejection_email).toBeUndefined();
    expect(sent.rejection_email_subject).toBeUndefined();
    expect(sent.rejection_email_body).toBeUndefined();
  });

  it('ticked, it sends the edited subject and body verbatim and reports the e-mail as sent', async () => {
    h.updateStatus.mockResolvedValue({ data: { email: { sent: true } } });
    const modal = await rejectWithEmail();
    fireEvent.click(within(modal).getByLabelText('Send rejection email to candidate'));
    fireEvent.change(within(modal).getByDisplayValue(/Update on your application/), { target: { value: 'About your application' } });
    fireEvent.change(within(modal).getByDisplayValue(/^Hi Test Candidate,/), { target: { value: 'Hi Test Candidate, my own wording.' } });
    update(modal);
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledTimes(1));
    expect(h.updateStatus.mock.calls[0][1]).toMatchObject({
      send_rejection_email: true, rejection_email_subject: 'About your application', rejection_email_body: 'Hi Test Candidate, my own wording.',
    });
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('Rejection email sent'));
    expect(h.toastSuccess).toHaveBeenCalledWith('Status updated to Rejected');
  });

  it('when the server reports the e-mail failed, its reason is shown, and the status change is still reported', async () => {
    h.updateStatus.mockResolvedValue({ data: { email: { sent: false, error: 'Mailbox unavailable' } } });
    const modal = await rejectWithEmail();
    fireEvent.click(within(modal).getByLabelText('Send rejection email to candidate'));
    update(modal);
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Mailbox unavailable'));
    expect(h.toastSuccess).toHaveBeenCalledWith('Status updated to Rejected');
    expect(h.toastSuccess).not.toHaveBeenCalledWith('Rejection email sent');
  });

  it('a failed e-mail with no reason gets a generic message', async () => {
    h.updateStatus.mockResolvedValue({ data: { email: { sent: false } } });
    const modal = await rejectWithEmail();
    fireEvent.click(within(modal).getByLabelText('Send rejection email to candidate'));
    update(modal);
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Rejection email failed to send'));
  });

  it('is not sent for any status other than Rejected, even if it was ticked first', async () => {
    const modal = await rejectWithEmail();
    fireEvent.click(within(modal).getByLabelText('Send rejection email to candidate'));
    choose(modal, 'Rejected', 'Hold for Future');
    update(modal);
    await waitFor(() => expect(h.updateStatus).toHaveBeenCalledTimes(1));
    const sent = h.updateStatus.mock.calls[0][1] as Record<string, unknown>;
    expect(sent.send_rejection_email).toBeUndefined();
    expect(sent.rejection_email_subject).toBeUndefined();
  });
});

describe('Candidate page — seeing why someone was rejected', () => {
  it('the Rejected badge opens the reason: several reasons as a list, with the detail', async () => {
    await show([application('A9001', { status: 'Rejected', rejection_reason_cat: 'Missing mandatory skill; Communication gap', rejection_reason_detail: 'Test detail text' })]);
    fireEvent.click(screen.getByTitle('Click to see the rejection reason'));
    const dialog = modalOf('Rejection reason');
    expect(within(dialog).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Missing mandatory skill', 'Communication gap']);
    expect(within(dialog).getByText('Test detail text')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('heading', { name: 'Rejection reason' })).not.toBeInTheDocument();
  });

  it('a single reason is plain text, and no reason says so', async () => {
    await show([application('A9001', { status: 'Rejected', rejection_reason_cat: 'Communication gap' })]);
    fireEvent.click(screen.getByTitle('Click to see the rejection reason'));
    expect(within(modalOf('Rejection reason')).getByText('Communication gap')).toBeInTheDocument();
    expect(within(modalOf('Rejection reason')).queryAllByRole('listitem')).toHaveLength(0);
    cleanup();
    await show([application('A9001', { status: 'Rejected', rejection_reason_cat: undefined })]);
    fireEvent.click(screen.getByTitle('Click to see the rejection reason'));
    expect(within(modalOf('Rejection reason')).getByText('No reason logged')).toBeInTheDocument();
  });

  it('only a Rejected status can be clicked; any other is a plain badge', async () => {
    await show([application('A9001', { status: 'Hold for Future' })]);
    expect(screen.queryByTitle('Click to see the rejection reason')).not.toBeInTheDocument();
  });

  it('a Hiring Manager can open the reason too (it is read-only)', async () => {
    h.persona = 'hiring_manager';
    await show([application('A9001', { status: 'Rejected', rejection_reason_cat: 'Communication gap' })]);
    fireEvent.click(screen.getByTitle('Click to see the rejection reason'));
    expect(within(modalOf('Rejection reason')).getByText('Communication gap')).toBeInTheDocument();
  });
});

describe('Candidate page — the Stage dialog', () => {
  it('Stage opens the dialog for the application on its current stage; moving it calls the server and reloads the candidate', async () => {
    await show([application('A9001', { stage: 'Interview Round 1' })]);
    const before = h.get.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Stage' }));
    const modal = modalOf('Update stage');
    fireEvent.change(within(modal).getByDisplayValue('Interview Round 1'), { target: { value: 'Interview Round 2' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(h.advanceStage).toHaveBeenCalledWith('A9001', 'Interview Round 2', { budgetExceptionReasonCat: undefined, budgetExceptionReasonDetail: undefined }));
    await waitFor(() => expect(h.get.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Update stage' })).not.toBeInTheDocument());
  });

  it('shortlisting a 15%+ over-budget candidate from here needs the reason, and sends it', async () => {
    await show([application('A9001', { candidate_expected_ctc: 20, is_severely_over_budget: true })]);
    fireEvent.click(screen.getByRole('button', { name: 'Stage' }));
    const modal = modalOf('Update stage');
    fireEvent.change(within(modal).getByDisplayValue('Applied and Screened'), { target: { value: 'Interview Round 1' } });
    expect(within(modal).getByRole('button', { name: 'Update' })).toBeDisabled();
    fireEvent.change(within(modal).getByDisplayValue('Select reason'), { target: { value: OVER_BUDGET_SHORTLIST_REASONS[2] } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(h.advanceStage).toHaveBeenCalledWith('A9001', 'Interview Round 1', { budgetExceptionReasonCat: OVER_BUDGET_SHORTLIST_REASONS[2], budgetExceptionReasonDetail: undefined }));
  });

  it('opened from the second application\'s row it moves THAT application', async () => {
    await show([application('A9001'), application('A9002', { role_id: 'R9002', role_title: 'Test Role Beta', stage: 'Interview Round 1' })]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Stage' })[1]);
    const modal = modalOf('Update stage');
    fireEvent.change(within(modal).getByDisplayValue('Interview Round 1'), { target: { value: 'Founders Round' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(h.advanceStage).toHaveBeenCalledWith('A9002', 'Founders Round', expect.anything()));
  });
});

describe('Candidate page — Add Application', () => {
  it('offers the live roles the candidate has no application for, links with the Manual Add channel, and reloads the candidate', async () => {
    await show();
    const before = h.get.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Add Application' }));
    const modal = modalOf('Link Test Candidate to a role');
    await within(modal).findByRole('option', { name: 'Test Role Beta' });
    expect(Array.from((within(modal).getByDisplayValue('Select a role…') as HTMLSelectElement).options).slice(1).map(o => o.textContent)).toEqual(['Test Role Beta']);   // R9001 is already applied to
    fireEvent.change(within(modal).getByDisplayValue('Select a role…'), { target: { value: 'R9002' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(h.linkRole).toHaveBeenCalledWith('C9001', { role_id: 'R9002', source_channel: 'Manual Add' }));
    await waitFor(() => expect(h.get.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('Candidate page — the editable profile sections', () => {
  it('Identity: saves only the fields that changed, to the candidate endpoint, and says so', async () => {
    await show();
    fireEvent.click(screen.getByTitle('Edit Identity'));
    fireEvent.change(within(section('Identity')).getByDisplayValue('Test Candidate'), { target: { value: 'Renamed Candidate' } });
    fireEvent.click(within(section('Identity')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.update).toHaveBeenCalledWith('C9001', { full_name: 'Renamed Candidate' }));
    expect(h.toastSuccess).toHaveBeenCalledWith('Identity updated');
  });

  it('Identity: choosing the Agency source asks for the agency and will not save without one', async () => {
    await show();
    fireEvent.click(screen.getByTitle('Edit Identity'));
    const identity = within(section('Identity'));
    expect(identity.queryByText('Sourcing Agency')).not.toBeInTheDocument();
    fireEvent.change(identity.getByDisplayValue('LinkedIn'), { target: { value: 'Agency' } });
    expect(identity.getByText('Sourcing Agency')).toBeInTheDocument();
    fireEvent.click(identity.getByRole('button', { name: 'Save' }));
    expect(h.toastError).toHaveBeenCalledWith('Sourcing Agency is required');
    expect(h.update).not.toHaveBeenCalled();
    await identity.findByRole('option', { name: 'Test Agency' });
    fireEvent.change(identity.getByDisplayValue('Select agency…'), { target: { value: 'AGN9001' } });
    fireEvent.click(identity.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.update).toHaveBeenCalledWith('C9001', { source: 'Agency', sourced_by_agency_id: 'AGN9001' }));
  });

  it('Current Role: the preferred location goes to the application, the rest to the candidate', async () => {
    await show([application('A9001', { preferred_location: 'Hyderabad' })]);
    fireEvent.click(screen.getByTitle('Edit Current Role'));
    const role = within(section('Current Role'));
    fireEvent.change(role.getByDisplayValue('Test Co'), { target: { value: 'Other Co' } });
    fireEvent.change(role.getByDisplayValue('Hyderabad'), { target: { value: 'Chennai' } });
    fireEvent.click(role.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.update).toHaveBeenCalledWith('C9001', { current_company: 'Other Co' }));
    expect(h.updateNotes).toHaveBeenCalledWith('A9001', { preferred_location: 'Chennai' });
  });

  it('Current Role: changing only the preferred location touches only the application', async () => {
    await show([application('A9001', { preferred_location: 'Hyderabad' })]);
    fireEvent.click(screen.getByTitle('Edit Current Role'));
    fireEvent.change(within(section('Current Role')).getByDisplayValue('Hyderabad'), { target: { value: 'Chennai' } });
    fireEvent.click(within(section('Current Role')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.updateNotes).toHaveBeenCalledWith('A9001', { preferred_location: 'Chennai' }));
    expect(h.update).not.toHaveBeenCalled();
  });

  it('Resume & Tags: tags are saved as a trimmed list', async () => {
    await show();
    fireEvent.click(screen.getByTitle('Edit Resume & Tags'));
    fireEvent.change(within(section('Resume & Tags')).getByDisplayValue('strong'), { target: { value: 'strong, revisit ,, later' } });
    fireEvent.click(within(section('Resume & Tags')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.update).toHaveBeenCalledWith('C9001', { hr_tags: ['strong', 'revisit', 'later'] }));
  });

  it('a refused save shows a toast and leaves the section in edit mode', async () => {
    h.update.mockImplementation(async () => { throw new Error('forbidden'); });
    await show();
    fireEvent.click(screen.getByTitle('Edit Identity'));
    fireEvent.change(within(section('Identity')).getByDisplayValue('Test Candidate'), { target: { value: 'Renamed Candidate' } });
    fireEvent.click(within(section('Identity')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Failed to update Identity'));
    expect(within(section('Identity')).getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});

describe('Candidate page — the activity timeline', () => {
  it('says so when nothing has been logged', async () => {
    await show();
    expect(screen.getByText('No activity logged yet')).toBeInTheDocument();
  });

  it('lists each event with who did it ("System" when nobody), its detail and its time', async () => {
    h.activity.mockResolvedValue({ data: { activity: [
      { event_type: 'Stage Changed', performed_by_name: 'Test Reviewer', event_detail: 'Applied and Screened to Interview Round 1', created_at: '2026-10-20T10:30:00Z' },
      { event_type: 'ResumeIQ Scoring Completed', performed_by_name: null, event_detail: null, created_at: '2026-10-19T08:00:00Z' },
    ] } });
    await show();
    expect(await screen.findByText('Stage Changed')).toBeInTheDocument();
    expect(screen.getByText('by Test Reviewer')).toBeInTheDocument();
    expect(screen.getByText('Applied and Screened to Interview Round 1')).toBeInTheDocument();
    expect(screen.getByText('ResumeIQ Scoring Completed')).toBeInTheDocument();
    expect(screen.getByText('by System')).toBeInTheDocument();
    expect(screen.getByText(format(new Date('2026-10-20T10:30:00Z'), 'MMM d, h:mm a'))).toBeInTheDocument();
  });
});
