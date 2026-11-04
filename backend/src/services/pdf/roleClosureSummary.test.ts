import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { renderRoleClosureSummary, ClosureSummaryData } from './roleClosureSummary.js';
import { extractPdfText } from '../driveService.js';

// The Role Closure Summary is the one-page retrospective HR downloads once a role is Closed (Filled or Cancelled). Each rendered file is read back: its text is
// extracted with the same helper socialJd.test.ts uses. Only Date is faked (pdfkit stamps a creation date), so a render is repeatable. All data is synthetic, and
// dates are written WITHOUT a zone ("2026-11-02T12:00:00" is local time) so the printed day cannot move with the machine's timezone. Months are Oct/Nov on purpose:
// the short name of September ("Sep" or "Sept") depends on the ICU version of the Node runtime.
vi.setConfig({ testTimeout: 30_000 });

const squash = (s: string) => s.replace(/\s+/g, '');
const pages = (buf: Buffer) => (buf.toString('latin1').match(/\/Type \/Page(?![a-z])/g) ?? []).length;
function info(buf: Buffer, key: string): string | null {
  const raw = buf.toString('latin1');
  const ref = new RegExp(`/${key} (\\d+) 0 R`).exec(raw);
  if (!ref) return null;
  const obj = new RegExp(`\\n${ref[1]} 0 obj\\n\\(([\\s\\S]*?)\\)\\nendobj`).exec(raw);
  if (!obj) return null;
  const bytes = Buffer.from(obj[1], 'latin1');
  // pdfkit writes a string with any non-ASCII character as UTF-16BE behind a byte-order mark.
  return bytes[0] === 0xfe && bytes[1] === 0xff ? Buffer.from(bytes.subarray(2)).swap16().toString('utf16le') : obj[1];
}

const STAGES = [
  'Applied and Screened', 'Interview Round 1', 'Interview Round 2', 'Assignment Round', 'Founders Round', 'Reference Check',
  'Pre-Joining Documents', 'Offer Discussion', 'Offer Released', 'Offer Accepted', 'Joined',
];

const data = (over: Partial<Omit<ClosureSummaryData, 'role'>> & { role?: Partial<ClosureSummaryData['role']> } = {}): ClosureSummaryData => {
  const { role: roleOver, ...rest } = over;
  return {
    role: {
      id: 'R900', title: 'Synthetic Platform Engineer', department: 'Engineering', hiring_manager_name: 'Test Manager', priority: 'P1', location: 'Pune',
      employment_type: 'Full-Time', status: 'Closed – Filled', start_date: '2026-10-05T12:00:00', target_closure_date: '2026-11-15T12:00:00',
      closed_date: '2026-11-02T12:00:00', days_to_close: 28, num_openings: 2, ...roleOver,
    },
    totalApplications: 40,
    outcomes: { active: 3, joined: 2, rejected: 25, withdrawn: 6, hold_for_future: 4 },
    funnel: [
      { stage: 'Applied and Screened', active: 3, rejected: 20, withdrawn: 5, hold_for_future: 4, joined: 0 },
      { stage: 'Interview Round 1', active: 0, rejected: 5, withdrawn: 1, hold_for_future: 0, joined: 0 },
      { stage: 'Joined', active: 0, rejected: 0, withdrawn: 0, hold_for_future: 0, joined: 2 },
    ],
    slaBreaches: { total: 7, byType: [{ type: 'Interview 1 Feedback Due', count: 4 }, { type: 'Resume Shortlist Pending', count: 3 }] },
    sourceQuality: [{ source_channel: 'LinkedIn', n: 30, pass_rate: 33, hire_rate: 7 }, { source_channel: 'Referral', n: 10, pass_rate: 60, hire_rate: 10 }],
    velocity: { interview_to_offer_ratio: 40, biggest_drop_off: { stage: 'Applied and Screened', count: 20 } },
    timeToFillDays: 28,
    ...rest,
  };
};

const cache = new Map<string, Buffer>();
async function render(d: ClosureSummaryData, key?: string): Promise<Buffer> {
  if (key && cache.has(key)) return cache.get(key)!;
  const buf = await renderRoleClosureSummary(d);
  if (key) cache.set(key, buf);
  return buf;
}
const textOf = async (d: ClosureSummaryData, key?: string) => squash(await extractPdfText(await render(d, key)));
// Single-spaced text, for rows where the column boundaries matter.
const rowsOf = async (d: ClosureSummaryData, key?: string) => (await extractPdfText(await render(d, key))).replace(/[ \t]+/g, ' ');

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-03T12:00:00Z')); });
afterAll(() => { vi.useRealTimers(); });

describe('renderRoleClosureSummary: the file', () => {
  it('is an A4 PDF on a single page', async () => {
    const buf = await render(data(), 'full');
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.subarray(-8).toString('latin1')).toContain('%%EOF');
    expect(buf.toString('latin1')).toMatch(/\/MediaBox \[\s*0\s+0\s+595\.28\s+841\.89\s*\]/);
    expect(pages(buf)).toBe(1);
  });

  it('is repeatable: the same input gives the same bytes', async () => {
    const a = await renderRoleClosureSummary(data());
    const b = await renderRoleClosureSummary(data());
    expect(a.equals(b)).toBe(true);
  });

  it('puts "<title> — Closure Summary" and the author in the document properties', async () => {
    const buf = await render(data(), 'full');
    expect(info(buf, 'Title')).toBe('Synthetic Platform Engineer — Closure Summary'.replace('—', '—'));
    expect(info(buf, 'Author')).toBe('DigitalPaani HMS');
  });

  it('is a plain internal report: no logo image and only the standard Helvetica faces', async () => {
    const raw = (await render(data(), 'full')).toString('latin1');
    expect(raw).not.toContain('/Subtype /Image');
    expect(raw).toMatch(/\/BaseFont \/Helvetica/);
    expect(raw).not.toContain('/FontFile');
  });
});

describe('renderRoleClosureSummary: the header and the key facts', () => {
  it('prints the title, the role id, the closing status and every fact line', async () => {
    const t = await textOf(data(), 'full');
    expect(t).toContain('SyntheticPlatformEngineerR900');
    expect(t).toContain('RoleClosureSummary—Closed–Filled');
    expect(t).toContain('DepartmentEngineering');
    expect(t).toContain('HiringManagerTestManager');
    expect(t).toContain('PriorityP1');
    expect(t).toContain('LocationPune');
    expect(t).toContain('Openings2');
  });

  it('a cancelled role says so in the heading', async () => {
    const t = await textOf(data({ role: { status: 'Closed – Cancelled' } }));
    expect(t).toContain('RoleClosureSummary—Closed–Cancelled');
    expect(t).not.toContain('Closed–Filled');
  });

  it('dates print as "dd Mon yyyy" (en-IN) and days to close as "<n>d"', async () => {
    const t = await textOf(data(), 'full');
    expect(t).toContain('Opened05Oct2026');
    expect(t).toContain('Closed02Nov2026');
    expect(t).toContain('Daystoclose28d');
  });

  it('every missing fact prints an em dash, never "null" or "undefined"', async () => {
    const t = await textOf(data({ role: { department: null, hiring_manager_name: null, location: null, start_date: null, closed_date: null, days_to_close: null } }));
    for (const label of ['Department', 'HiringManager', 'Location', 'Opened', 'Closed', 'Daystoclose']) expect(t).toContain(`${label}—`);
    expect(t).not.toMatch(/null|undefined|InvalidDate|NaN/);
  });

  it('zero days to close is a real value ("0d"), not a missing one', async () => {
    expect(await textOf(data({ role: { days_to_close: 0 } }))).toContain('Daystoclose0d');
  });
});

describe('renderRoleClosureSummary: outcomes and funnel', () => {
  it('prints the total and each outcome count', async () => {
    const t = await textOf(data(), 'full');
    expect(t).toContain('Totalapplications40');
    expect(t).toContain('Joined2');
    expect(t).toContain('Rejected25');
    expect(t).toContain('Withdrawn6');
    expect(t).toContain('HoldforFuture4');
    expect(t).toContain('StillActive3');
  });

  it('the funnel has one row per stage that has any candidate, columns Active, Joined, Rejected, Withdrawn, On Hold', async () => {
    const t = await textOf(data(), 'full');
    expect(t).toContain('StageActiveJoinedRejectedWithdrawnOnHold');
    const rows = await rowsOf(data(), 'full');
    expect(rows).toContain('Applied and Screened 3 0 20 5 4');
    expect(rows).toContain('Interview Round 1 0 0 5 1 0');
    expect(rows).toContain('Joined 0 2 0 0 0');
  });

  it('a stage with every count at zero is left out of the funnel, but one with just one count stays', async () => {
    const d = data({
      funnel: [
        { stage: 'Empty Stage Name', active: 0, rejected: 0, withdrawn: 0, hold_for_future: 0, joined: 0 },
        { stage: 'Only On Hold Stage', active: 0, rejected: 0, withdrawn: 0, hold_for_future: 1, joined: 0 },
      ],
    });
    const t = await textOf(d);
    expect(t).not.toContain('EmptyStageName');
    expect((await rowsOf(d))).toContain('Only On Hold Stage 0 0 0 0 1');
  });

  it('an empty funnel still prints the table header', async () => {
    const t = await textOf(data({ funnel: [] }));
    expect(t).toContain('StageActiveJoinedRejectedWithdrawnOnHold');
  });

  it('all eleven pipeline stages fit on the one page', async () => {
    const funnel = STAGES.map((stage, i) => ({ stage, active: i, rejected: i + 1, withdrawn: 1, hold_for_future: 0, joined: stage === 'Joined' ? 2 : 0 }));
    const buf = await render(data({ funnel }));
    expect(pages(buf)).toBe(1);
    const t = squash(await extractPdfText(buf));
    for (const stage of STAGES) expect(t).toContain(squash(stage));
  });
});

describe('renderRoleClosureSummary: SLA breaches', () => {
  it('prints the total and a row per breach type with its count', async () => {
    const t = await textOf(data(), 'full');
    expect(t).toContain('Totalbreaches7');
    expect(t).toContain('BreachtypeCount');
    expect(t).toContain('Interview1FeedbackDue4');
    expect(t).toContain('ResumeShortlistPending3');
  });

  it('no breach types: the sentence "No SLA breaches recorded for this role." replaces the table', async () => {
    const t = await textOf(data({ slaBreaches: { total: 0, byType: [] } }));
    expect(t).toContain('NoSLAbreachesrecordedforthisrole.');
    expect(t).not.toContain('BreachtypeCount');
    expect(t).not.toContain('Totalbreaches');
  });

  it('CURRENT BEHAVIOUR: a non-zero total with no by-type rows still prints the "No SLA breaches" sentence (the table, not the total, decides)', async () => {
    const t = await textOf(data({ slaBreaches: { total: 5, byType: [] } }));
    expect(t).toContain('NoSLAbreachesrecordedforthisrole.');
  });
});

describe('renderRoleClosureSummary: source quality', () => {
  it('prints each channel with applications, pass % and hire %', async () => {
    const t = await textOf(data(), 'full');
    expect(t).toContain('SourceAppliedPass%Hire%');
    expect(t).toContain('LinkedIn3033%7%');
    expect(t).toContain('Referral1060%10%');
  });

  it('no sources: the sentence "No sourced applications recorded for this role." replaces the table', async () => {
    const t = await textOf(data({ sourceQuality: [] }));
    expect(t).toContain('Nosourcedapplicationsrecordedforthisrole.');
    expect(t).not.toContain('SourceAppliedPass%Hire%');
  });
});

describe('renderRoleClosureSummary: operational velocity', () => {
  it('prints the interview-to-offer ratio, time to fill and the biggest drop-off with its count', async () => {
    const t = await textOf(data(), 'full');
    expect(t).toContain('Interview->Offerratio40%');
    expect(t).toContain('Timetofill28d');
    expect(t).toContain('Biggestdrop-offAppliedandScreened(20)');
  });

  it('the ratio label is written with an ASCII "->" (the arrow glyph is not in the standard font and printed as garbage)', async () => {
    const t = await textOf(data(), 'full');
    expect(t).not.toContain('→');
    expect(t).toContain('Interview->Offerratio');
  });

  it('unknown values print an em dash; a zero ratio and zero days are real values', async () => {
    const unknown = await textOf(data({ velocity: { interview_to_offer_ratio: null, biggest_drop_off: null }, timeToFillDays: null }));
    expect(unknown).toContain('Interview->Offerratio—');
    expect(unknown).toContain('Timetofill—');
    expect(unknown).toContain('Biggestdrop-off—');
    const zero = await textOf(data({ velocity: { interview_to_offer_ratio: 0, biggest_drop_off: null }, timeToFillDays: 0 }));
    expect(zero).toContain('Interview->Offerratio0%');
    expect(zero).toContain('Timetofill0d');
  });
});

describe('renderRoleClosureSummary: robustness', () => {
  it('a long title, long breach names and many channels still render on one page', async () => {
    const d = data({
      role: { title: 'Senior Synthetic Platform Reliability and Observability Engineering Lead for Water Infrastructure' },
      slaBreaches: { total: 30, byType: Array.from({ length: 12 }, (_, i) => ({ type: `Synthetic breach type number ${i + 1} feedback due`, count: i + 1 })) },
      sourceQuality: Array.from({ length: 8 }, (_, i) => ({ source_channel: `Channel ${i + 1}`, n: 10 + i, pass_rate: 10 * i, hire_rate: i })),
    });
    const buf = await render(d);
    expect(pages(buf)).toBe(1);
    const t = squash(await extractPdfText(buf));
    expect(t).toContain('Syntheticbreachtypenumber12feedbackdue12');
    expect(t).toContain('Channel8');
  });

  it('the report carries no e-mail address or phone number (it is built from counts and role facts only)', async () => {
    const t = await extractPdfText(await render(data(), 'full'));
    expect(t).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(t).not.toMatch(/\b\d{10}\b/);
  });
});
