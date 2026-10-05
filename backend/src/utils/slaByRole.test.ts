import { describe, it, expect } from 'vitest';
import { buildSlaByRole, OTHER_STAGE, RoleMeta } from './slaByRole.js';
import { SlaBreachRow } from './hiringFunnelSnapshot.js';
import { STAGE_ORDER } from '../types/index.js';

let n = 0;
function breach(role: string, stage: string | null, type = 'Resume Shortlist Pending', owner = 'Hiring Manager', over: Partial<SlaBreachRow> = {}): SlaBreachRow {
  return {
    id: ++n, action_type: type, owner_type: owner, hours_overdue: 10, application_id: `A${n}`, candidate_name: `C${n}`,
    role_title: `stale title for ${role}`, pa_role_id: role, effective_role_id: role, current_stage: stage, candidate_id: `C${n}`,
    responsible_person: null, ...over,
  };
}
const meta = (id: string, title: string, status = 'Live – Sourcing', priority = 'P1'): [string, RoleMeta] =>
  [id, { id, title, status, priority, hiring_manager_name: 'HM' }];
const roles = (...m: Array<[string, RoleMeta]>) => new Map(m);

describe('buildSlaByRole', () => {
  it('groups breaches by open role, then by funnel stage, and totals them', () => {
    const out = buildSlaByRole([
      breach('R1', 'Applied and Screened'), breach('R1', 'Applied and Screened'), breach('R1', 'Interview Round 1', 'Interview 1 Not Scheduled', 'HR / Recruiter'),
      breach('R2', 'Founders Round', 'Founders Round Feedback Due'),
    ], roles(meta('R1', 'Designer'), meta('R2', 'Engineer')));

    expect(out.roles.map(r => [r.role_id, r.total])).toEqual([['R1', 3], ['R2', 1]]);
    expect(out.total_breaches).toBe(4);
    const r1 = out.roles[0];
    expect(r1.by_stage.map(s => [s.stage, s.count])).toEqual([['Applied and Screened', 2], ['Interview Round 1', 1]]);
    expect(r1.by_stage[1].breach_types).toEqual([{ type: 'Interview 1 Not Scheduled', owner: 'HR / Recruiter', count: 1 }]);
  });

  it('uses the role table for the label, not the (stale) title stored on the breach row', () => {
    const out = buildSlaByRole([breach('R1', 'Applied and Screened')], roles(meta('R1', 'Current Title')));
    expect(out.roles[0].role_title).toBe('Current Title');
  });

  it("follows the application's CURRENT role when it was moved (the breach row's own role id goes stale)", () => {
    const moved = breach('R_OLD', 'Applied and Screened', 'Resume Shortlist Pending', 'Hiring Manager', { effective_role_id: 'R_NEW' });
    const out = buildSlaByRole([moved], roles(meta('R_OLD', 'Old'), meta('R_NEW', 'New')));
    expect(out.roles.map(r => r.role_id)).toEqual(['R_NEW']);
  });

  it('orders roles by breach count (ties by title) and stages in funnel order', () => {
    const out = buildSlaByRole([
      breach('R1', 'Founders Round'), breach('R1', 'Applied and Screened'), breach('R1', 'Interview Round 2'),
      breach('R2', 'Applied and Screened'), breach('R2', 'Applied and Screened'), breach('R2', 'Applied and Screened'),
      breach('R3', 'Applied and Screened'), breach('R3', 'Applied and Screened'), breach('R3', 'Applied and Screened'),
      breach('R4', 'Applied and Screened'), breach('R4', 'Applied and Screened'), breach('R4', 'Applied and Screened'),
      breach('R4', 'Applied and Screened'), breach('R4', 'Applied and Screened'),
      breach('R5', 'Applied and Screened'),
    ], roles(meta('R1', 'Zeta'), meta('R2', 'Beta'), meta('R3', 'Alpha'), meta('R4', 'Mid'), meta('R5', 'Aardvark')));
    // most breaches first (5), then the three tied at 3 alphabetically, and the single breach last —
    // alphabetical order alone would put 'Aardvark' (1) first, so reversing the count sort cannot pass.
    expect(out.roles.map(r => [r.role_title, r.total])).toEqual([['Mid', 5], ['Alpha', 3], ['Beta', 3], ['Zeta', 3], ['Aardvark', 1]]);
    const zeta = out.roles.find(r => r.role_title === 'Zeta')!;
    expect(zeta.by_stage.map(s => s.stage)).toEqual(['Applied and Screened', 'Interview Round 2', 'Founders Round']);
  });

  it('aggregates the same breach type within a stage and sorts types by count', () => {
    const out = buildSlaByRole([
      breach('R1', 'Applied and Screened', 'Idle Candidate', 'HR / Recruiter'),
      breach('R1', 'Applied and Screened', 'Resume Shortlist Pending'), breach('R1', 'Applied and Screened', 'Resume Shortlist Pending'),
    ], roles(meta('R1', 'X')));
    expect(out.roles[0].by_stage[0].breach_types.map(t => [t.type, t.count])).toEqual([['Resume Shortlist Pending', 2], ['Idle Candidate', 1]]);
    expect(out.roles[0].by_stage[0].count).toBe(3);
  });

  it('leaves roles that are not open off the chart but counts them, so totals still reconcile', () => {
    const out = buildSlaByRole([
      breach('R1', 'Applied and Screened'),
      breach('R_CLOSED', 'Interview Round 1'), breach('R_CLOSED', 'Interview Round 1'),
      breach('R_CLOSED2', 'Founders Round'),
    ], roles(meta('R1', 'Open'), meta('R_CLOSED', 'Old', 'Closed – Filled'), meta('R_CLOSED2', 'Older', 'Closed – Cancelled')));
    expect(out.roles.map(r => r.role_id)).toEqual(['R1']);
    expect(out.total_breaches).toBe(1);
    expect(out.not_open_roles).toEqual({ roles: 2, breaches: 3 });
  });

  it('an unrecognised stage is kept on an open role (as "Other") but not counted in not_open_roles — the snapshot has no place for it', () => {
    const out = buildSlaByRole([
      breach('R1', 'Offer'), breach('R1', 'Applied and Screened'),                    // 'Offer' is a legacy stage name, not one of the 11
      breach('R_OLD', 'Offer'), breach('R_OLD', 'Interview Round 1'),
    ], roles(meta('R1', 'Open'), meta('R_OLD', 'Gone', 'Closed – Filled')));
    expect(out.roles[0].by_stage.map(s => [s.stage, s.count])).toEqual([['Applied and Screened', 1], ['Other', 1]]);
    expect(out.not_open_roles).toEqual({ roles: 1, breaches: 1 });                    // only the Interview Round 1 one
  });

  it('a Draft role is "not open", not "closed": its breaches stay off the chart but are counted', () => {
    const out = buildSlaByRole(
      [breach('R_DRAFT', 'Applied and Screened'), breach('R_DRAFT', 'Applied and Screened')],
      roles(meta('R_DRAFT', 'Not yet approved', 'Draft')));
    expect(out.roles).toEqual([]);
    expect(out.not_open_roles).toEqual({ roles: 1, breaches: 2 });
  });

  it('treats every open-role status as open', () => {
    const statuses = ['Approved', 'Live – Sourcing', 'Under Review', 'On Hold'];
    const out = buildSlaByRole(statuses.map((s, i) => breach(`R${i}`, 'Applied and Screened')), roles(...statuses.map((s, i) => meta(`R${i}`, `Role ${i}`, s))));
    expect(out.roles).toHaveLength(4);
    expect(out.not_open_roles.breaches).toBe(0);
  });

  it('files a breach with no recognisable stage under "Other" instead of losing it', () => {
    const out = buildSlaByRole([breach('R1', null), breach('R1', 'Not A Stage'), breach('R1', 'Applied and Screened')], roles(meta('R1', 'X')));
    expect(out.roles[0].total).toBe(3);
    expect(out.roles[0].by_stage.map(s => [s.stage, s.count])).toEqual([['Applied and Screened', 1], [OTHER_STAGE, 2]]);
  });

  it('skips breaches whose role no longer exists, and never throws on empty input', () => {
    expect(buildSlaByRole([breach('R_GONE', 'Applied and Screened')], roles()).roles).toEqual([]);
    const empty = buildSlaByRole([], roles());
    expect(empty).toMatchObject({ roles: [], total_breaches: 0, not_open_roles: { roles: 0, breaches: 0 } });
  });

  it('every segment of a bar adds up to that bar, and every bar to the total', () => {
    const rows = [
      breach('R1', 'Applied and Screened'), breach('R1', 'Interview Round 1', 'Interview 1 Not Scheduled', 'HR / Recruiter'),
      breach('R2', 'Assignment Round', 'Assignment Not Sent', 'HR / Recruiter'), breach('R2', 'Assignment Round', 'Assignment Feedback Due'),
    ];
    const out = buildSlaByRole(rows, roles(meta('R1', 'A'), meta('R2', 'B')));
    for (const r of out.roles) {
      expect(r.by_stage.reduce((s, x) => s + x.count, 0)).toBe(r.total);
      for (const s of r.by_stage) expect(s.breach_types.reduce((a, t) => a + t.count, 0)).toBe(s.count);
    }
    expect(out.roles.reduce((s, r) => s + r.total, 0)).toBe(out.total_breaches);
    expect(out.total_breaches).toBe(rows.length);
  });

  it('exposes the canonical stage order for the UI', () => {
    expect(buildSlaByRole([], roles()).stages).toEqual([...STAGE_ORDER]);
  });

  it('a Hiring Manager owner label and an HR owner label are kept per breach type', () => {
    const out = buildSlaByRole([breach('R1', 'Assignment Round', 'Assignment Not Sent', 'HR / Recruiter'), breach('R1', 'Assignment Round', 'Assignment Feedback Due', 'Hiring Manager')], roles(meta('R1', 'X')));
    const owners = Object.fromEntries(out.roles[0].by_stage[0].breach_types.map(t => [t.type, t.owner]));
    expect(owners).toEqual({ 'Assignment Not Sent': 'HR / Recruiter', 'Assignment Feedback Due': 'Hiring Manager' });
  });
});
