import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// What the hovers and markers on the candidate page say about the badges and fields that have no label of their own. Each
// assertion pins a FACT that the backend decides (named in the comment), not the exact wording.
const { empty, candidateGet } = vi.hoisted(() => ({
  empty: () => new Proxy({}, { get: () => async () => ({ data: {} }) }),
  candidateGet: vi.fn(),
}));
vi.mock('../services/api.ts', () => ({
  candidatesApi: { get: () => candidateGet(), activity: async () => ({ data: { activity: [] } }), update: vi.fn() },
  applicationsApi: empty(),
  interviewsApi: { list: async () => ({ data: { rounds: [] } }) },
  refChecksApi: { list: async () => ({ data: { ref_checks: [] } }) },
  agenciesApi: { list: async () => ({ data: { agencies: [] } }) },
  rolesApi: empty(),
}));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Test HR', email: 'hr@example.test', persona: 'hr_recruiter' }, canHR: true, canLead: true }),
}));
// the ResumeIQ panel and the portfolio card have their own tests and their own data calls
vi.mock('../components/ResumeIQPanel.tsx', () => ({ default: () => <div /> }));

import CandidateDetail from './CandidateDetail.tsx';

const app = (over: Record<string, unknown> = {}) => ({
  id: 'A0001', candidate_id: 'C0001', role_id: 'R001', role_title: 'Quality Assurance Engineer', role_priority: 'P1', hiring_manager_name: 'Test HM',
  stage: 'Applied and Screened', status: 'Active', sla_breach: true, founder_review_flag: false, recruiter_screening_status: 'New',
  score_avg: 6.4, source_channel: 'Job Application Form', application_date: '2026-10-01T00:00:00Z', last_updated: '2026-10-05T00:00:00Z',
  hr_priority_override: 'High', ...over,
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/candidates/C0001']}>
        <Routes><Route path="/candidates/:id" element={<CandidateDetail />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const tipOf = (title: HTMLElement): string => {
  fireEvent.mouseEnter(title.parentElement!.querySelector('[aria-label="More info"]')!);
  return title.parentElement!.querySelector('div.absolute')!.textContent!;
};

beforeEach(() => {
  candidateGet.mockReset();
  candidateGet.mockResolvedValue({ data: { candidate: { id: 'C0001', full_name: 'Test Candidate', email: 'candidate@example.test', source: 'LinkedIn', hr_tags: [] }, applications: [app()] } });
});

describe('Candidate page — what the unlabelled badges and fields say', () => {
  it('Identity: Source is how the candidate was found and feeds Source quality; the form\'s own answer is kept on the application', async () => {
    mount();
    const tip = tipOf(await screen.findByText('Identity'));
    expect(tip).toContain('feeds Source quality on the Dashboard');
    expect(tip).toContain('recorded as LinkedIn when they have no Source yet');          // routes/candidateIngest.ts: source = 'LinkedIn', fill-null-only
    expect(tip).toContain('kept separately, on the application');                          // applications.sub_source
    expect(tip).toContain('what the Agency Repository counts as a hire');                  // routes/agencies.ts: candidates.sourced_by_agency_id
  });

  it('SLA tag: stays until the application is actioned and is not cleared by putting it on hold', async () => {
    mount();
    const badge = await screen.findByText('SLA');
    expect(badge.getAttribute('title')).toContain('putting it on hold does not clear it');   // routes/applications.ts: the status route does not reset sla_breach
    expect(badge.getAttribute('title')).toContain('another stage, an interview is scheduled, feedback is submitted or an assignment is sent');
  });

  it('Founder: raises a Founder Review task for Leadership and puts the candidate in their Ready for Review list', async () => {
    mount();
    const btn = (await screen.findByText('Founder')).closest('button')!;
    expect(btn.getAttribute('title')).toContain('Leadership a Founder Review task');         // routes/applications.ts founder-flag: pending_actions 'Founder Review'
    expect(btn.getAttribute('title')).toContain('Ready for Review list in My Tasks');
  });

  it('Recruiter screening status: a separate tracker that no screen changes, so it normally stays at New', async () => {
    mount();
    const status = await screen.findByText('New');
    expect(status.getAttribute('title')).toContain('separate from Stage and Status');
    expect(status.getAttribute('title')).toContain('HMS has no screen that changes it, so it normally stays at New');   // services/api.ts updateScreening has no caller
  });

  it('ResumeIQ score is out of 10, and the Fit score on the lists is this number x 10', async () => {
    mount();
    const score = await screen.findByText(/ResumeIQ: 6\.4\/10/);
    expect(score.getAttribute('title')).toContain('out of 10');
    expect(score.getAttribute('title')).toContain('Fit score on the candidate lists is this number × 10');   // services/resumeIQTrigger.ts: ai_fit_score = round(avg x 10)
  });

  it('the application\'s Source is how it entered HMS, not the candidate\'s Source; Updated lists what changes it', async () => {
    mount();
    const source = await screen.findByText(/Source: Job Application Form/);
    expect(source.getAttribute('title')).toContain("It is not the candidate's Source in Identity");
    const updated = screen.getByText(/^Updated /);
    expect(updated.getAttribute('title')).toContain('stage, status, screening status, notes, Founder flag or assignment submission');
    expect(updated.getAttribute('title')).toContain('ResumeIQ scoring do not change it on their own');
  });

  it('Screening & Risk Notes: Priority Override changes no timer, sort or queue, and these Tags are not the ones the Tag filter searches', async () => {
    mount();
    const tip = tipOf(await screen.findByText('Screening & Risk Notes'));
    expect(tip).toContain('does not change SLA timers, sorting or any queue');               // hr_priority_override is only stored and logged (routes/applications.ts)
    expect(tip).toContain('Tags here belong to this application only');                      // applications.hr_tags, not candidates.hr_tags
    expect(tip).toContain("the Tag filter on Archived Pipeline searches the candidate's HR Tags");
  });
});
