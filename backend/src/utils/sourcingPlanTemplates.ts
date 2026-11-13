// Plan templates — the six role types of the sourcing proposal (docs/SourcingPlanDetailing_Spec.md), seeded from the colleague's workbook
// ("Sourcing plans.xlsx"). A template pre-fills a DRAFT plan's job titles, company lists, weekly numbers and channel lines; the recruiter
// reviews and activates it as before — nothing here activates anything or changes how a channel is tracked.
// Pure: matching and seeding are plain data so they can be unit-tested; the database side lives in services/sourcingDetail.ts.
import { mapWorkbookChannel, RowStatus, TrackedAs } from './sourcingDetail.js';

export interface TemplateRow {
  workbook_channel: string;
  platform: string | null;
  status: RowStatus;
  owner_label: string | null;
  tracked_as: TrackedAs | null;
  weekly_work: number | null;
  work_unit: string | null;
  expected_applicants: number | null;
  expected_qualified: number | null;
  start_condition: string | null;
  first_task: string | null;
  repeats: string | null;
  reason: string | null;
}

export interface TemplateMatchRules {
  /** Lower-case words matched against the role title (whole-word). Any hit counts. */
  keywords: string[];
  /** Exact (case-insensitive) roles.department values. */
  departments?: string[];
  /** Title words that make a role senior — used by the senior/leadership template. */
  senior?: boolean;
}

export interface PlanTemplate {
  key: string;
  name: string;
  description: string;
  match_rules: TemplateMatchRules;
  weekly_qualified_target: number | null;
  job_titles: string[];
  company_lists: string[];
  channel_rows: TemplateRow[];
}

const row = (r: Partial<TemplateRow> & Pick<TemplateRow, 'workbook_channel' | 'status'>): TemplateRow => ({
  platform: null, owner_label: null, tracked_as: null, weekly_work: null, work_unit: null, expected_applicants: null,
  expected_qualified: null, start_condition: null, first_task: null, repeats: null, reason: null, ...r,
});

export const SEED_TEMPLATES: PlanTemplate[] = [
  {
    key: 'hard_to_fill_technical',
    name: 'Hard-to-fill technical role',
    description: 'Field / site / domain engineers: E&I, commissioning, service, O&M. Outbound to water-company engineers is the main lever.',
    match_rules: { keywords: ['e&i', 'instrumentation', 'commissioning', 'service engineer', 'service manager', 'o&m', 'scada', 'plc', 'process', 'proposals', 'site engineer'], departments: ['Project Implementation', 'Domain'] },
    weekly_qualified_target: 3,
    job_titles: ['Site engineer (E&I)', 'Commissioning engineer', 'Instrumentation engineer', 'PLC/SCADA automation engineer', 'O&M electrical engineer'],
    company_lists: ['Water – Bangalore', 'Water – Hyderabad'],
    channel_rows: [
      row({ workbook_channel: 'Outbound', platform: 'LinkedIn + Naukri Resdex', status: 'live', owner_label: 'Recruiter', tracked_as: 'count', weekly_work: 45, work_unit: 'New people messaged', expected_qualified: 1.89, start_condition: 'From activation', first_task: 'Set up outreach sheet; pick first 8 companies', repeats: 'Follow up day 3 and day 7' }),
      row({ workbook_channel: 'Job portal', platform: 'Naukri + LinkedIn Jobs', status: 'live', owner_label: 'Recruiter', tracked_as: 'yes_no', work_unit: 'Keep post live and refreshed', expected_applicants: 0.6, expected_qualified: 0.06, start_condition: 'From activation', first_task: 'Publish posts with tracked links', repeats: 'Refresh every 14 days; Naukri renew every 30' }),
      row({ workbook_channel: 'Referrals', platform: 'Employee referral push', status: 'live', owner_label: 'Hiring manager', tracked_as: 'yes_no', weekly_work: 12, work_unit: 'People asked', expected_qualified: 0.72, start_condition: 'From activation', first_task: 'Repost role to employees', repeats: 'Every 14 days' }),
      row({ workbook_channel: 'Talent pool', platform: 'Hold-for-Future pool', status: 'live', owner_label: 'Recruiter', tracked_as: 'count', weekly_work: 15, work_unit: 'Re-contacted', expected_qualified: 1.12, start_condition: 'From activation', first_task: 'Filter the pool', repeats: '10 a week until the filtered pool is done' }),
      row({ workbook_channel: 'Agency', platform: 'Industrial / EPC specialist agency', status: 'live', owner_label: 'Recruiter', tracked_as: 'yes_no', work_unit: 'Weekly follow-up', expected_applicants: 3, expected_qualified: 1.05, start_condition: 'From activation', first_task: 'Brief agency with JD and target companies', repeats: 'Follow up weekly' }),
      row({ workbook_channel: 'Campus (alumni)', platform: 'Alumni groups of the target colleges', status: 'backup', owner_label: 'Recruiter', tracked_as: 'yes_no', weekly_work: 10, work_unit: 'Alumni contacted', expected_qualified: 0.45, start_condition: 'Start if 3 weeks below target' }),
      row({ workbook_channel: 'Campus', platform: 'Hiring from campus', status: 'not_used', reason: 'Role needs 2–4 yrs experience' }),
    ],
  },
  {
    key: 'senior_leadership',
    name: 'Senior / leadership role',
    description: 'Heads and directors: founder network and targeted outreach first; a search firm stands by as the backup.',
    match_rules: { keywords: ['head of', 'director', 'vp', 'vice president', 'chief', 'lead – '], senior: true },
    weekly_qualified_target: 3,
    job_titles: ['Head of function', 'Director', 'Brand lead', 'Creative director'],
    company_lists: [],
    channel_rows: [
      row({ workbook_channel: 'Network', platform: 'Founder + investor network', status: 'live', owner_label: 'Founder', tracked_as: 'count', weekly_work: 3, work_unit: 'Intros made', expected_qualified: 1.5, start_condition: 'From activation', first_task: 'Founder sends first 5 intro asks', repeats: '3 asks per week' }),
      row({ workbook_channel: 'Outbound', platform: 'LinkedIn: target-company leaders', status: 'live', owner_label: 'Recruiter', tracked_as: 'count', weekly_work: 10, work_unit: 'New people messaged', expected_qualified: 0.52, start_condition: 'From activation', first_task: 'Build list of 25', repeats: 'Follow up day 5' }),
      row({ workbook_channel: 'Job portal', platform: 'LinkedIn Jobs', status: 'live', owner_label: 'Recruiter', tracked_as: 'yes_no', work_unit: 'Keep post live and refreshed', expected_applicants: 18.2, expected_qualified: 1.3, start_condition: 'From activation', first_task: 'Add tracked link', repeats: 'Refresh every 14 days' }),
      row({ workbook_channel: 'Search firm', platform: 'Leadership search firm', status: 'backup', owner_label: 'HR lead', tracked_as: 'yes_no', work_unit: 'Weekly follow-up', expected_applicants: 2, expected_qualified: 1, start_condition: 'Start if 3 weeks below target', first_task: 'Get 2 proposals ready', repeats: 'Weekly update' }),
      row({ workbook_channel: 'Campus', platform: null, status: 'not_used', reason: 'Director-level role' }),
      row({ workbook_channel: 'Job portal', platform: 'Naukri', status: 'not_used', reason: 'Weak channel for senior leaders' }),
    ],
  },
  {
    key: 'tech',
    name: 'Tech role',
    description: 'Software / platform / QA hires: outbound to engineers plus referrals from the tech team, a tech-specialist agency as backup.',
    match_rules: { keywords: ['backend', 'developer', 'platform engineer', 'devops', 'sre', 'qa', 'quality assurance', 'software', 'full stack', 'data engineer'], departments: ['Tech/Dev', 'Engineering', 'Product/QA'] },
    weekly_qualified_target: 3,
    job_titles: ['Platform engineer', 'Backend engineer (Node.js/TypeScript)', 'DevOps / SRE', 'Cloud infrastructure engineer'],
    company_lists: [],
    channel_rows: [
      row({ workbook_channel: 'Outbound', platform: 'LinkedIn + GitHub', status: 'live', owner_label: 'Recruiter', tracked_as: 'count', weekly_work: 20, work_unit: 'New people messaged', expected_qualified: 0.96, start_condition: 'From activation', first_task: 'Build list of 40', repeats: 'Follow up day 5' }),
      row({ workbook_channel: 'Referrals', platform: 'Tech team referrals', status: 'live', owner_label: 'Hiring manager', tracked_as: 'yes_no', weekly_work: 8, work_unit: 'People asked', expected_qualified: 1, start_condition: 'From activation', first_task: 'Hiring manager asks the tech team', repeats: 'Every 14 days' }),
      row({ workbook_channel: 'Job portal', platform: 'LinkedIn Jobs + Naukri', status: 'live', owner_label: 'Recruiter', tracked_as: 'yes_no', work_unit: 'Keep post live and refreshed', expected_applicants: 4, expected_qualified: 1.2, start_condition: 'From activation', first_task: 'Publish post', repeats: 'Refresh every 14 days' }),
      row({ workbook_channel: 'Agency', platform: 'Tech-specialist agency', status: 'backup', owner_label: 'Recruiter', tracked_as: 'yes_no', work_unit: 'Weekly follow-up', expected_applicants: 3, expected_qualified: 0.9, start_condition: 'Start if 3 weeks below target', repeats: 'Follow up weekly' }),
      row({ workbook_channel: 'Campus', platform: null, status: 'not_used', reason: 'Senior hire' }),
    ],
  },
  {
    key: 'design',
    name: 'Design role',
    description: 'Product / UX design: a job post with a mandatory portfolio link, outbound to designers, referrals from product and tech.',
    match_rules: { keywords: ['designer', 'ux', 'ui', 'design lead', 'design system'] },
    weekly_qualified_target: 3,
    job_titles: ['Senior product designer', 'UX designer', 'Product designer (mobile)', 'Design system lead'],
    company_lists: [],
    channel_rows: [
      row({ workbook_channel: 'Job portal', platform: 'LinkedIn Jobs + Naukri (portfolio required)', status: 'live', owner_label: 'Recruiter', tracked_as: 'yes_no', work_unit: 'Keep post live and refreshed', expected_applicants: 20, expected_qualified: 2, start_condition: 'From activation', first_task: 'Make portfolio link mandatory', repeats: 'Refresh every 14 days; screen within 48h' }),
      row({ workbook_channel: 'Outbound', platform: 'LinkedIn: designers at B2B/ops SaaS', status: 'live', owner_label: 'Recruiter', tracked_as: 'count', weekly_work: 10, work_unit: 'New people messaged', expected_qualified: 0.8, start_condition: 'From activation', first_task: 'Build list of 30 designers', repeats: 'Follow up day 5' }),
      row({ workbook_channel: 'Referrals', platform: 'Product + tech team', status: 'live', owner_label: 'Hiring manager', tracked_as: 'yes_no', weekly_work: 5, work_unit: 'People asked', expected_qualified: 0.4, start_condition: 'From activation', first_task: 'Hiring manager asks the product team', repeats: 'Every 14 days' }),
      row({ workbook_channel: 'Agency', platform: 'Design-specialist agency', status: 'backup', owner_label: 'Recruiter', tracked_as: 'yes_no', work_unit: 'Weekly follow-up', expected_applicants: 3, expected_qualified: 0.9, start_condition: 'Start if 3 weeks below target', repeats: 'Follow up weekly' }),
      row({ workbook_channel: 'Campus', platform: 'Design institutes', status: 'not_used', reason: 'Senior role' }),
    ],
  },
  {
    key: 'customer_success',
    name: 'Customer success / sales role',
    description: 'CSM, account and sales roles: outbound to SaaS / IoT firms, professional communities, a specialist agency.',
    match_rules: { keywords: ['customer success', 'csm', 'account manager', 'business development', 'bdm', 'sales', 'key account'] },
    weekly_qualified_target: 3,
    job_titles: ['Customer success manager', 'Account manager (SaaS)', 'Client success manager', 'Implementation manager'],
    company_lists: ['SaaS / IoT'],
    channel_rows: [
      row({ workbook_channel: 'Outbound', platform: 'LinkedIn: CSMs at SaaS/IoT', status: 'live', owner_label: 'Recruiter', tracked_as: 'count', weekly_work: 15, work_unit: 'New people messaged', expected_qualified: 0.9, start_condition: 'From activation', first_task: 'Build a list of 30', repeats: 'Follow up day 3 and day 7' }),
      row({ workbook_channel: 'Community', platform: 'Customer Success Collective / CS Insider', status: 'live', owner_label: 'Recruiter', tracked_as: 'yes_no', work_unit: 'Weekly post', expected_applicants: 3, expected_qualified: 0.75, start_condition: 'From activation', first_task: 'Post in 2 communities', repeats: '1 post per week' }),
      row({ workbook_channel: 'Job portal', platform: 'LinkedIn Jobs (Naukri backup)', status: 'live', owner_label: 'Recruiter', tracked_as: 'yes_no', work_unit: 'Keep post live and refreshed', expected_applicants: 2, expected_qualified: 0.2, start_condition: 'From activation', first_task: 'Add tracked links', repeats: 'Refresh every 14 days' }),
      row({ workbook_channel: 'Agency', platform: 'SaaS-focused agency', status: 'live', owner_label: 'Recruiter', tracked_as: 'yes_no', work_unit: 'Weekly follow-up', expected_applicants: 3, expected_qualified: 0.9, start_condition: 'From activation', first_task: 'Brief agency', repeats: 'Follow up weekly' }),
      row({ workbook_channel: 'Campus', platform: null, status: 'not_used', reason: 'Experienced role' }),
    ],
  },
  {
    key: 'easy_to_fill',
    name: 'Easy-to-fill role',
    description: 'Executive / associate roles that fill through job portals: Naukri primary, a database search as the backup.',
    match_rules: { keywords: ['associate', 'executive', 'accounts', 'finance', 'admin', 'coordinator', 'talent partner', 'recruiter'] },
    weekly_qualified_target: 2,
    job_titles: ['Executive', 'Associate'],
    company_lists: [],
    channel_rows: [
      row({ workbook_channel: 'Job portal', platform: 'Naukri (primary) + LinkedIn Jobs', status: 'live', owner_label: 'Recruiter', tracked_as: 'yes_no', work_unit: 'Keep post live and refreshed', expected_applicants: 16, expected_qualified: 2.4, start_condition: 'From activation', first_task: 'Activate plan; publish post', repeats: 'Refresh every 14 days' }),
      row({ workbook_channel: 'Database search', platform: 'Naukri Resdex', status: 'backup', owner_label: 'Recruiter', tracked_as: 'count', weekly_work: 10, work_unit: 'New people messaged', expected_qualified: 1.2, start_condition: 'Start if 2 weeks below target' }),
      row({ workbook_channel: 'Agency', platform: null, status: 'not_used', reason: 'Fills through job portals' }),
      row({ workbook_channel: 'Outbound', platform: 'LinkedIn outreach', status: 'not_used', reason: 'Not needed at this level' }),
    ],
  },
];

export interface RoleForMatch { title: string; department?: string | null; priority?: string | null }

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim()} `;

/** Score a template against a role: title keywords (3 each), department (2). Senior titles prefer the senior template. Pure. */
export function scoreTemplate(role: RoleForMatch, rules: TemplateMatchRules): number {
  const title = norm(role.title);
  let score = 0;
  for (const k of rules.keywords) if (title.includes(norm(k))) score += 3;
  if (rules.departments && role.department && rules.departments.some(d => d.toLowerCase() === role.department!.toLowerCase())) score += 2;
  return score;
}

/** The best-matching template for a role, or null when nothing matches (the recruiter then picks one by hand). Ties keep list order. */
export function pickTemplate<T extends { key: string; match_rules: TemplateMatchRules }>(role: RoleForMatch, templates: T[]): T | null {
  let best: T | null = null; let bestScore = 0;
  for (const t of templates) {
    let s = scoreTemplate(role, t.match_rules);
    // A "Senior …" / "Sr." prefix does not make a role leadership: only the explicit leadership words in the senior template count.
    if (t.match_rules.senior && s > 0) s += 1;
    if (s > bestScore) { best = t; bestScore = s; }
  }
  return best;
}

/** The channels a template's LIVE lines would plan on activation — the suggestion the activation form preselects. Never more than the five
    channels; supporting activities are not included. `weekly_target` follows the tracker's own meaning (APPLICANTS a week, qualified + not):
    only a single-portal line with an expected-applicants figure supplies one — a messages-sent number (Outbound) never does, and two
    portals sharing one figure cannot split it, so those are left for the recruiter to enter. */
export function suggestedChannels(rows: Array<Pick<TemplateRow, 'workbook_channel' | 'platform' | 'status' | 'expected_applicants'>>): Array<{ channel: string; weekly_target: number | null }> {
  const out = new Map<string, number | null>();
  for (const r of rows) {
    if (r.status !== 'live') continue;
    const chans = mapWorkbookChannel(r.workbook_channel, r.platform);
    for (const ch of chans) {
      if (out.has(ch)) continue;
      const single = chans.length === 1 && ch !== 'Direct Outreach' && r.expected_applicants && r.expected_applicants >= 1;
      out.set(ch, single ? Math.round(r.expected_applicants as number) : null);
    }
  }
  return [...out].map(([channel, weekly_target]) => ({ channel, weekly_target }));
}
