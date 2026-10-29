// First, before any router is imported (see src/test/routeHarness.ts): express-async-errors must patch Express before a route exists.
import 'express-async-errors';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// PATCH /api/roles/:id (approval, the Hiring Manager field, the edit log, the JD trigger) and POST /api/roles (who may create or
// request a role). CLAUDE.md: "A Hiring Manager cannot approve a role — not even their own. PATCH /roles/:id is isHRTier-gated end to
// end … approver name and date are captured from the acting HR-tier user and Open Date copies from Approval Date the same moment."
// The real router, real authenticate / require* and real hiringManagers helpers run; the database, JD generation, PDF rendering,
// Drive and the sourcing hook are replaced, so each can be asked "was I called, and when".

const h = vi.hoisted(() => ({
  order: [] as string[],
  onRoleSaved: vi.fn(),
  generateJdContent: vi.fn(),
  renderLongFormJd: vi.fn(),
  renderSocialJd: vi.fn(),
  renderRoleClosureSummary: vi.fn(),
  uploadJdPdf: vi.fn(),
  getCompBenchmark: vi.fn(),
}));
vi.mock('../db/index.js', async () => (await import('../test/fakeDb.js')).dbModule());
vi.mock('../services/sourcingPlans.js', () => ({ onRoleSaved: h.onRoleSaved }));
vi.mock('../services/jdContent.js', () => ({ generateJdContent: h.generateJdContent }));
vi.mock('../services/pdf/longFormJd.js', () => ({ renderLongFormJd: h.renderLongFormJd }));
vi.mock('../services/pdf/socialJd.js', () => ({ renderSocialJd: h.renderSocialJd }));
vi.mock('../services/pdf/roleClosureSummary.js', () => ({ renderRoleClosureSummary: h.renderRoleClosureSummary }));
vi.mock('../services/driveService.js', () => ({ uploadJdPdf: h.uploadJdPdf }));
vi.mock('../services/compBenchmark.js', () => ({ getCompBenchmark: h.getCompBenchmark }));

import rolesRouter from './roles.js';
import { fakeDb } from '../test/fakeDb.js';
import { ApiClient, ALL_PERSONAS, TEST_JWT_SECRET, TEST_USERS, buildApp, setEnv, type Actor } from '../test/routeHarness.js';
import type { Persona } from '../types/index.js';

const api = new ApiClient(buildApp(app => app.use('/api/roles', rolesRouter)));
let restoreEnv: () => void = () => undefined;

const NOW = new Date('2026-10-29T10:00:00.000Z');
const TODAY = '2026-10-29';
const HR_TIER = ['hr_recruiter', 'leadership', 'super_admin'] as const;
const ROLE_ID = 'R9001';

const ROLE: Record<string, unknown> = {
  id: ROLE_ID, title: 'Quality Assurance Engineer', status: 'Draft', priority: 'P1', department: 'Engineering', location: 'Mumbai',
  hiring_manager_name: 'Test Hiring Manager', ctc_band: '18-24 LPA', num_openings: 2, jd_drive_link: null, jd_source: 'generated',
  start_date: null, target_closure_date: null, approver_name: null, approval_date: null, recruitment_mode: ['LinkedIn'],
};

const SQL = {
  role: /^SELECT \* FROM roles WHERE id = \$1$/,
  update: /^UPDATE roles SET (.+) WHERE id = \$(\d+) RETURNING \*$/,
  rewriteHmReviews: /^UPDATE pending_actions pa SET responsible_person = \$1 FROM applications a WHERE a\.id = pa\.application_id AND a\.role_id = \$2 AND pa\.resolved = false AND pa\.owner_type = 'Hiring Manager' AND pa\.action_type = 'HM shortlist review'$/,
  editLog: /^INSERT INTO role_edit_log \(role_id, field_name, old_value, new_value, changed_by\) VALUES \(\$1, \$2, \$3, \$4, \$5\)$/,
  activity: /^INSERT INTO activity_log \(role_id, event_type, event_detail/,
  activeUsers: /^SELECT name FROM users WHERE is_active = true$/,
  jdLinks: /^UPDATE roles SET jd_drive_link=\$1, social_jd_drive_link=\$2, generated_jd_content=\$3 WHERE id=\$4$/,
  insertRole: /^INSERT INTO roles \(/,
};

/** Make `UPDATE roles SET a = $1, b = $2 … RETURNING *` answer with the role as the update would leave it. */
function programRole(role: Record<string, unknown> = {}) {
  const current = { ...ROLE, ...role };
  fakeDb.whenOne(SQL.role, current);
  fakeDb.when(SQL.update, (params, sql) => {
    const set = SQL.update.exec(sql)![1];
    const changed: Record<string, unknown> = {};
    set.split(', ').forEach(pair => { const m = /^(\w+) = \$(\d+)$/.exec(pair)!; changed[m[1]] = params[Number(m[2]) - 1]; });
    return [{ ...current, ...changed }];
  });
  fakeDb.when(SQL.activeUsers, [{ name: 'Test Hiring Manager' }, { name: 'Mandeep Dagar' }, { name: 'Piyush Negi' }, { name: 'Test Recruiter' }]);
  return current;
}
const roleUpdate = () => fakeDb.one(SQL.update);
/** The role activity-log rows as { type, params } — the event type is a literal in each statement, not a bound parameter. */
const roleEvents = () => fakeDb.find(SQL.activity)
  .map(c => ({ type: /VALUES \(\$1, '([^']+)'/.exec(c.sql)![1], params: c.params, inTransaction: c.inTransaction }))
  .filter(e => e.type !== 'JD Generated');
/** The columns the UPDATE sets, with their bound values, as an object. */
function written(): Record<string, unknown> {
  const u = roleUpdate();
  const out: Record<string, unknown> = {};
  SQL.update.exec(u.sql)![1].split(', ').forEach(pair => { const m = /^(\w+) = \$(\d+)$/.exec(pair)!; out[m[1]] = u.params[Number(m[2]) - 1]; });
  return out;
}
const patch = (as: Actor, body: Record<string, unknown>, id = ROLE_ID) => api.patch(`/api/roles/${id}`, { as, body });
const nothingWritten = () => { expect(fakeDb.writes()).toEqual([]); expect(fakeDb.tx.started).toBe(0); };

beforeAll(async () => { await api.start(); });
afterAll(async () => { await api.stop(); });
beforeEach(() => {
  fakeDb.reset();
  vi.useFakeTimers({ toFake: ['Date'] });       // real sockets and timers keep working; only "today" is fixed
  vi.setSystemTime(NOW);
  h.order.length = 0;
  h.onRoleSaved.mockReset().mockImplementation(async () => { h.order.push(`onRoleSaved(committed=${fakeDb.tx.committed})`); });
  h.generateJdContent.mockReset().mockImplementation(async () => { h.order.push('generateJdContent'); return { summary: 'content' }; });
  h.renderLongFormJd.mockReset().mockResolvedValue(Buffer.from('long'));
  h.renderSocialJd.mockReset().mockResolvedValue(Buffer.from('social'));
  h.uploadJdPdf.mockReset().mockImplementation(async (_buf: Buffer, name: string) => ({ webViewLink: `https://drive.example.test/${name}` }));
  restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET, DRIVE_JD_FOLDER_ID: 'folder-for-tests' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { restoreEnv(); vi.useRealTimers(); vi.restoreAllMocks(); });

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('PATCH /:id — who may edit a role', () => {
  it('a hiring_manager gets 403 "HR access required" on an existing role, whatever they send — even for the role they are named on — and nothing is written or triggered', async () => {
    programRole({ hiring_manager_name: 'Test Hiring Manager' });                 // the caller IS this role's Hiring Manager
    for (const body of [{ title: 'Renamed' }, { status: 'Approved' }, { ctc_band: '99-99 LPA' }, { hiring_manager_name: 'Test Hiring Manager, Nobody Else' }, {}]) {
      fakeDb.reset(); programRole({ hiring_manager_name: 'Test Hiring Manager' });
      const res = await patch('hiring_manager', body);
      expect([JSON.stringify(body), res.status, res.body]).toEqual([JSON.stringify(body), 403, { error: 'HR access required' }]);
      nothingWritten();
    }
    expect(h.onRoleSaved).not.toHaveBeenCalled();
    expect(h.generateJdContent).not.toHaveBeenCalled();
  });

  it('a hiring_manager cannot approve even their own role: the role stays Draft and no approver is recorded', async () => {
    programRole({ status: 'Draft', hiring_manager_name: 'Test Hiring Manager', approver_name: null });
    const res = await patch('hiring_manager', { status: 'Approved', approver_name: 'Test Hiring Manager', approval_date: TODAY });
    expect(res.status).toBe(403);
    expect(fakeDb.find(SQL.update)).toEqual([]);
    expect(h.generateJdContent).not.toHaveBeenCalled();
  });

  it('a token with a persona that is not one of the four (the retired "interviewer") cannot edit either', async () => {
    programRole();
    const res = await patch({ ...TEST_USERS.hiring_manager, persona: 'interviewer' as unknown as Persona }, { status: 'Approved' });
    expect(res.status).toBe(403);
    nothingWritten();
  });

  it('the role is looked up BEFORE the persona check: an unknown id is 404 even for a hiring_manager (so a role id can be probed), an existing one is 403', async () => {
    fakeDb.whenOne(SQL.role, null);
    expect((await patch('hiring_manager', { title: 'x' }, 'R0000')).status).toBe(404);
    expect((await patch('hr_recruiter', { title: 'x' }, 'R0000')).status).toBe(404);
    fakeDb.reset(); programRole();
    expect((await patch('hiring_manager', { title: 'x' })).status).toBe(403);
  });

  it.each(HR_TIER)('%s may edit: 200, the change is written and the response is the updated role', async persona => {
    programRole();
    const res = await patch(persona, { title: 'Senior Quality Assurance Engineer', ctc_band: '24-30 LPA' });
    expect(res.status).toBe(200);
    expect(written()).toEqual({ title: 'Senior Quality Assurance Engineer', ctc_band: '24-30 LPA' });
    expect(res.body.role.title).toBe('Senior Quality Assurance Engineer');
    expect(res.body.role.ctc_band).toBe('24-30 LPA');           // HR-tier always sees compensation
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('PATCH /:id — approving a role', () => {
  it.each(HR_TIER)('%s approving a Draft: the approver is the ACTING user\'s name, the approval date and the Open Date (start_date) are today', async persona => {
    programRole({ status: 'Draft' });
    const res = await patch(persona, { status: 'Approved' });
    expect(res.status).toBe(200);
    expect(written()).toEqual({ status: 'Approved', approver_name: TEST_USERS[persona].name, approval_date: TODAY, start_date: TODAY });
    expect(roleUpdate().params.at(-1)).toBe(ROLE_ID);
    expect(res.body.role.status).toBe('Approved');
  });

  it.each(['Draft', 'Under Review', 'On Hold', 'Live – Sourcing', 'Closed – Cancelled'])('approving from "%s" (any status but Approved) counts as an approval and stamps the approver', async from => {
    programRole({ status: from });
    await patch('leadership', { status: 'Approved' });
    expect(written()).toMatchObject({ status: 'Approved', approver_name: 'Test Leader', approval_date: TODAY, start_date: TODAY });
  });

  it('whatever the client sends for approver_name, approval_date or start_date is replaced by the server\'s own values on an approval', async () => {
    programRole({ status: 'Draft' });
    await patch('hr_recruiter', { status: 'Approved', approver_name: 'Forged Approver', approval_date: '2001-01-01', start_date: '2002-02-02' });
    expect(written()).toEqual({ status: 'Approved', approver_name: 'Test Recruiter', approval_date: TODAY, start_date: TODAY });
  });

  it('…and is never taken from the client when the role is NOT being approved: the three fields are dropped, the rest of the edit goes through', async () => {
    programRole({ status: 'Draft' });
    const res = await patch('hr_recruiter', { title: 'New title', approver_name: 'Forged', approval_date: '2001-01-01', start_date: '2002-02-02' });
    expect(res.status).toBe(200);
    expect(written()).toEqual({ title: 'New title' });
  });

  it('a body of nothing but those three fields is "No changes detected": no transaction, no write, no hook', async () => {
    programRole({ status: 'Draft' });
    const res = await patch('hr_recruiter', { approver_name: 'Forged', approval_date: '2001-01-01', start_date: '2002-02-02' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('No changes detected');
    nothingWritten();
    expect(h.onRoleSaved).not.toHaveBeenCalled();
  });

  it('saving status "Approved" on a role that is already Approved is not an approval: the approver is not rewritten, an unrelated edit is saved, no JD is generated', async () => {
    programRole({ status: 'Approved', approver_name: 'First Approver', approval_date: '2026-09-01', start_date: '2026-09-01' });
    const res = await patch('leadership', { status: 'Approved', title: 'Retitled', approver_name: 'Forged' });
    expect(res.status).toBe(200);
    expect(written()).toEqual({ title: 'Retitled' });
    expect(h.generateJdContent).not.toHaveBeenCalled();
    expect(res.body.jdGeneration).toBeUndefined();
  });

  it('is logged as ONE "Role Approved" event naming the approver; the field changes that are the mechanics of approval are not repeated as "Role Updated", other edits made in the same save are', async () => {
    programRole({ status: 'Draft' });
    await patch('hr_recruiter', { status: 'Approved', priority: 'P0' });
    expect(roleEvents().map(e => [e.type, e.params])).toEqual([
      ['Role Approved', [ROLE_ID, 'Approved by Test Recruiter', 'U9001', 'Test Recruiter']],
      ['Role Updated', [ROLE_ID, 'priority: "P1" → "P0"', 'U9001', 'Test Recruiter']],
    ]);
    expect(roleEvents().every(e => e.inTransaction)).toBe(true);
  });

  it('the edit log records each changed field with its old and new value and the acting user (including the approval fields)', async () => {
    programRole({ status: 'Draft' });
    await patch('super_admin', { status: 'Approved' });
    expect(fakeDb.find(SQL.editLog).map(c => c.params)).toEqual([
      [ROLE_ID, 'status', 'Draft', 'Approved', 'U9004'],
      [ROLE_ID, 'approver_name', '', 'Test Admin', 'U9004'],
      [ROLE_ID, 'approval_date', '', TODAY, 'U9004'],
      [ROLE_ID, 'start_date', '', TODAY, 'U9004'],
    ]);
  });

  it('a status change that is not an approval is logged as "Status Changed" (old → new), separately from the other edits', async () => {
    programRole({ status: 'Approved' });
    await patch('hr_recruiter', { status: 'On Hold', location: 'Pune' });
    expect(roleEvents().map(e => [e.type, e.params])).toEqual([
      ['Status Changed', [ROLE_ID, 'Status → On Hold', 'Approved', 'On Hold', 'U9001', 'Test Recruiter']],
      ['Role Updated', [ROLE_ID, 'location: "Mumbai" → "Pune"', 'U9001', 'Test Recruiter']],
    ]);
  });

  it('nothing that is already equal is written: unchanged fields (compared as text) are left out of the UPDATE and the log', async () => {
    programRole({ title: 'Quality Assurance Engineer', num_openings: 2 });
    await patch('hr_recruiter', { title: 'Quality Assurance Engineer', num_openings: '2', location: 'Pune' });
    expect(written()).toEqual({ location: 'Pune' });
    expect(fakeDb.find(SQL.editLog)).toHaveLength(1);
  });

  it('only the whitelisted columns are ever written: id, created_by, jd_source, generated_jd_content, portfolio flags and any other field in the body are ignored', async () => {
    programRole();
    const res = await patch('super_admin', {
      id: 'R0001', created_by: 'U1', jd_source: 'manual', generated_jd_content: { x: 1 }, portfolio_analysis_enabled: true, portfolio_review_kind: 'marketing_work',
      requisition_source_row: 'x|y', social_jd_drive_link: 'https://drive.example.test/social', whatever: 1,
    });
    expect(res.status).toBe(200);
    expect(written()).toEqual({ social_jd_drive_link: 'https://drive.example.test/social' });
    fakeDb.reset(); programRole();
    const none = await patch('super_admin', { id: 'R0001', jd_source: 'manual', portfolio_analysis_enabled: true });
    expect(none.body.message).toBe('No changes detected');
    nothingWritten();
  });

  it('an edit that changes nothing answers { message: "No changes detected" } with the unchanged role, and starts no transaction and no hook', async () => {
    programRole();
    const res = await patch('hr_recruiter', { title: 'Quality Assurance Engineer' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('No changes detected');
    expect(res.body.role.id).toBe(ROLE_ID);
    nothingWritten();
    expect(h.onRoleSaved).not.toHaveBeenCalled();
  });

  it('a failure inside the transaction rolls it back: 500, and neither the sourcing hook nor JD generation runs', async () => {
    programRole({ status: 'Draft' });
    fakeDb.failing(SQL.editLog, 'edit log insert failed');
    const res = await patch('hr_recruiter', { status: 'Approved' });
    expect(res.status).toBe(500);
    expect(fakeDb.tx).toEqual({ started: 1, committed: 0, rolledBack: 1 });
    expect(h.onRoleSaved).not.toHaveBeenCalled();
    expect(h.generateJdContent).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('PATCH /:id — the hooks that follow a save', () => {
  it('the sourcing hook runs AFTER the transaction has committed and BEFORE JD generation, with the role as it was and as it is now, and the acting user', async () => {
    programRole({ status: 'Draft', jd_drive_link: null });
    await patch('hr_recruiter', { status: 'Approved' });
    expect(h.order).toEqual(['onRoleSaved(committed=1)', 'generateJdContent']);
    const [before, after, userId] = h.onRoleSaved.mock.calls[0];
    expect(before).toEqual({ id: ROLE_ID, status: 'Draft', recruitment_mode: ['LinkedIn'] });
    expect(after).toEqual({ id: ROLE_ID, status: 'Approved', recruitment_mode: ['LinkedIn'] });
    expect(userId).toBe('U9001');
  });

  describe('JD generation is triggered by the TRANSITION into Approved, once', () => {
    it('Draft → Approved with no JD yet: content is generated, both PDFs rendered and uploaded, the links and content saved, and the response says so', async () => {
      programRole({ status: 'Draft', jd_drive_link: null });
      const res = await patch('hr_recruiter', { status: 'Approved' });
      expect(h.generateJdContent).toHaveBeenCalledTimes(1);
      expect(h.renderLongFormJd).toHaveBeenCalledTimes(1);
      expect(h.renderSocialJd).toHaveBeenCalledTimes(1);
      expect(h.uploadJdPdf.mock.calls.map(c => [c[1], c[2]])).toEqual([['DP_JD_R9001_Quality_Assurance_Engineer.pdf', 'folder-for-tests'], ['Social_R9001_Quality_Assurance_Engineer.pdf', 'folder-for-tests']]);
      expect(fakeDb.one(SQL.jdLinks).params).toEqual([
        'https://drive.example.test/DP_JD_R9001_Quality_Assurance_Engineer.pdf', 'https://drive.example.test/Social_R9001_Quality_Assurance_Engineer.pdf',
        JSON.stringify({ summary: 'content' }), ROLE_ID,
      ]);
      expect(res.body.jdGeneration).toEqual({ generated: true });
    });

    it.each([
      ['the role already has a long-form JD link', { status: 'Draft', jd_drive_link: 'https://drive.example.test/existing.pdf' }, { status: 'Approved' }],
      ['the role\'s JD was written by hand (jd_source "manual")', { status: 'Draft', jd_source: 'manual' }, { status: 'Approved' }],
      ['the role was already Approved', { status: 'Approved' }, { status: 'Approved', title: 'x' }],
      ['the new status is not Approved', { status: 'Draft' }, { status: 'On Hold' }],
      ['the edit is unrelated to status', { status: 'Approved' }, { title: 'x' }],
    ])('is NOT triggered when %s', async (_why, role, body) => {
      programRole(role);
      const res = await patch('hr_recruiter', body);
      expect(res.status).toBe(200);
      expect(h.generateJdContent).not.toHaveBeenCalled();
      expect(res.body.jdGeneration).toBeUndefined();
    });

    it('a generation failure does not fail the save: the role is Approved, and the response carries { generated: false, error }', async () => {
      programRole({ status: 'Draft' });
      h.generateJdContent.mockResolvedValue(null);
      const res = await patch('hr_recruiter', { status: 'Approved' });
      expect(res.status).toBe(200);
      expect(res.body.role.status).toBe('Approved');
      expect(res.body.jdGeneration).toEqual({ generated: false, error: 'JD content generation failed' });
      expect(fakeDb.find(SQL.jdLinks)).toEqual([]);
    });

    it('with no Drive folder configured nothing is rendered or uploaded, and the response says so', async () => {
      programRole({ status: 'Draft' });
      restoreEnv(); restoreEnv = setEnv({ JWT_SECRET: TEST_JWT_SECRET, DRIVE_JD_FOLDER_ID: undefined });
      const res = await patch('hr_recruiter', { status: 'Approved' });
      expect(res.body.jdGeneration).toEqual({ generated: false, error: 'DRIVE_JD_FOLDER_ID not configured' });
      expect(h.renderLongFormJd).not.toHaveBeenCalled();
      expect(h.uploadJdPdf).not.toHaveBeenCalled();
    });

    it('a thrown error anywhere in generation (here: an upload) is caught and reported; links are written only when every step succeeded', async () => {
      programRole({ status: 'Draft' });
      h.uploadJdPdf.mockRejectedValueOnce(new Error('drive down'));
      const res = await patch('hr_recruiter', { status: 'Approved' });
      expect(res.status).toBe(200);
      expect(res.body.jdGeneration.generated).toBe(false);
      expect(res.body.jdGeneration.error).toMatch(/JD generation failed/);
      expect(fakeDb.find(SQL.jdLinks)).toEqual([]);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('PATCH /:id — the Hiring Manager field (one text column that may name several people)', () => {
  const hmField = (value: unknown) => patch('hr_recruiter', { hiring_manager_name: value });

  it.each([
    ['semicolon and ampersand', 'Mandeep Dagar;Piyush Negi & Third Person', 'Mandeep Dagar, Piyush Negi, Third Person'],
    ['the word "and" and an Oxford comma', 'Mandeep Dagar, Piyush Negi, and Third Person', 'Mandeep Dagar, Piyush Negi, Third Person'],
    ['untidy spacing and an invisible no-break space', 'Mandeep   Dagar ,  Piyush Negi', 'Mandeep Dagar, Piyush Negi'],
    ['a surname-first spelling, which a comma always splits into two people', 'Gosain,  Amit', 'Gosain, Amit'],
    ['a name containing "and" (not a separator)', 'Sandeep Anand', 'Sandeep Anand'],
  ])('is stored in the canonical "A, B" form (%s)', async (_what, typed, stored) => {
    programRole({ hiring_manager_name: 'Somebody Else' });
    const res = await hmField(typed);
    expect(res.status).toBe(200);
    expect(written()).toEqual({ hiring_manager_name: stored });
    expect(res.body.role.hiring_manager_name).toBe(stored);
  });

  it('a blank value clears the field (stored as an empty string)', async () => {
    programRole({ hiring_manager_name: 'Somebody Else' });
    expect((await hmField('   ')).status).toBe(200);
    expect(written()).toEqual({ hiring_manager_name: '' });
  });

  it.each([
    ['a number', 42, 'hiring_manager_name must be text'],
    ['an array', ['A', 'B'], 'hiring_manager_name must be text'],
    ['null', null, 'hiring_manager_name must be text'],
    ['delimiters only', ' , ; & ', 'Hiring Manager must name at least one person'],
    ['more than 300 characters once written canonically', `${'Aaaaaa Bbbbbb, '.repeat(25)}Last Person`, 'Hiring Manager is too long (at most 300 characters)'],
    ['an enormous value', 'x'.repeat(1300), 'Hiring Manager is too long (at most 300 characters)'],
  ])('%s is 400 and nothing is written (it would otherwise silently remove every Hiring Manager of the role)', async (_what, value, message) => {
    programRole({ hiring_manager_name: 'Somebody Else' });
    const res = await hmField(value);
    expect([res.status, res.body]).toEqual([400, { error: message }]);
    nothingWritten();
  });

  it('is validated after the persona gate: a hiring_manager sending garbage is 403, not 400', async () => {
    programRole();
    expect((await patch('hiring_manager', { hiring_manager_name: 42 })).status).toBe(403);
  });

  it('re-saving the same people in a different spelling is no change: nothing is written and no edit-log row is made; a different ORDER is a change', async () => {
    programRole({ hiring_manager_name: 'Mandeep Dagar, Piyush Negi' });
    const same = await hmField('Mandeep Dagar;  Piyush Negi');
    expect(same.body.message).toBe('No changes detected');
    nothingWritten();
    fakeDb.reset(); programRole({ hiring_manager_name: 'Mandeep Dagar, Piyush Negi' });
    const reordered = await hmField('Piyush Negi, Mandeep Dagar');
    expect(reordered.status).toBe(200);
    expect(written()).toEqual({ hiring_manager_name: 'Piyush Negi, Mandeep Dagar' });
    expect(fakeDb.find(SQL.editLog).map(c => c.params)).toEqual([[ROLE_ID, 'hiring_manager_name', 'Mandeep Dagar, Piyush Negi', 'Piyush Negi, Mandeep Dagar', 'U9001']]);
  });

  it('changing it rewrites responsible_person on this role\'s OPEN "HM shortlist review" rows (adding a person gives them the waiting work, removing one takes it away), inside the transaction, before the edit log', async () => {
    programRole({ hiring_manager_name: 'Mandeep Dagar' });
    await hmField('Mandeep Dagar, Piyush Negi');
    const rewrite = fakeDb.one(SQL.rewriteHmReviews);
    expect(rewrite.params).toEqual(['Mandeep Dagar, Piyush Negi', ROLE_ID]);
    expect(rewrite.inTransaction).toBe(true);
    const order = fakeDb.statements();
    expect(order.findIndex(s => SQL.rewriteHmReviews.test(s))).toBeLessThan(order.findIndex(s => SQL.editLog.test(s)));
  });

  it('clearing the field rewrites those rows\' responsible_person to NULL, not to an empty string', async () => {
    programRole({ hiring_manager_name: 'Mandeep Dagar' });
    await hmField('');
    expect(fakeDb.one(SQL.rewriteHmReviews).params).toEqual([null, ROLE_ID]);
  });

  it('an edit that does not change the field leaves those rows alone', async () => {
    programRole({ hiring_manager_name: 'Mandeep Dagar' });
    await patch('hr_recruiter', { title: 'Retitled' });
    expect(fakeDb.find(SQL.rewriteHmReviews)).toEqual([]);
    expect(fakeDb.find(SQL.activeUsers)).toEqual([]);
  });

  it('the response lists the names that match no active user (matching is against users.name, so a typo is otherwise invisible)', async () => {
    programRole({ hiring_manager_name: 'Somebody Else' });
    const res = await hmField('Mandeep Dagar, Piyush Nagi, mandeep  dagar');
    expect(res.status).toBe(200);
    expect(res.body.unmatched_hiring_managers).toEqual(['Piyush Nagi']);
    fakeDb.reset(); programRole({ hiring_manager_name: 'Somebody Else' });
    expect((await hmField('Mandeep Dagar, Piyush Negi')).body.unmatched_hiring_managers).toEqual([]);
  });

  it('is only computed when the field changed, and a failure of that lookup is logged but never fails the save that already happened', async () => {
    programRole({ hiring_manager_name: 'Somebody Else' });
    expect((await patch('hr_recruiter', { title: 'Retitled' })).body.unmatched_hiring_managers).toBeUndefined();
    fakeDb.reset(); programRole({ hiring_manager_name: 'Somebody Else' });
    fakeDb.failing(SQL.activeUsers);
    const res = await hmField('Mandeep Dagar');
    expect(res.status).toBe(200);
    expect(res.body.role.hiring_manager_name).toBe('Mandeep Dagar');
    expect(res.body.unmatched_hiring_managers).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('POST / — who may create or request a role', () => {
  const create = (as: Actor, body: Record<string, unknown>) => api.post('/api/roles', { as, body });
  const BODY = { title: 'Sr. Backend Developer', priority: 'P1', department: 'Engineering', hiring_manager_name: 'Mandeep Dagar & Piyush Negi', ctc_band: '30-40 LPA', start_date: '2001-01-01' };
  const programInsert = () => {
    fakeDb.when(SQL.insertRole, (params) => [{ ...ROLE, id: 'R9002', title: params[0], priority: params[3], hiring_manager_name: params[2], ctc_band: params[9], status: 'Draft' }]);
  };
  const insertParams = () => fakeDb.one(SQL.insertRole).params;

  it.each(ALL_PERSONAS)('%s may create/request a role: 201, always as a Draft (status is not taken from the body), created_by is the acting user', async persona => {
    programInsert();
    const res = await create(persona, { ...BODY, status: 'Approved' });
    expect(res.status).toBe(201);
    expect(insertParams()[0]).toBe('Sr. Backend Developer');
    expect(insertParams()[21]).toBe(TEST_USERS[persona].userId);
    expect(fakeDb.one(SQL.insertRole).sql).not.toMatch(/status|approver_name|approval_date|start_date/);
  });

  it('a token with a persona outside the four is 403 "Only HR, Leadership, or a Hiring Manager can create/request a role"', async () => {
    programInsert();
    const res = await create({ ...TEST_USERS.hiring_manager, persona: 'interviewer' as unknown as Persona }, BODY);
    expect([res.status, res.body]).toEqual([403, { error: 'Only HR, Leadership, or a Hiring Manager can create/request a role' }]);
    nothingWritten();
  });

  it('HR-tier sets the compensation band; a hiring_manager NEVER does (their ctc_band is dropped to null)', async () => {
    programInsert();
    for (const persona of HR_TIER) {
      fakeDb.reset(); programInsert();
      await create(persona, BODY);
      expect([persona, insertParams()[9]]).toEqual([persona, '30-40 LPA']);
    }
    fakeDb.reset(); programInsert();
    await create('hiring_manager', BODY);
    expect(insertParams()[9]).toBeNull();
  });

  it('the Open Date is never taken from the request: the INSERT has no start_date column, so a requested role has none until approved', async () => {
    programInsert();
    await create('hr_recruiter', BODY);
    expect(fakeDb.one(SQL.insertRole).sql).not.toContain('start_date');
    expect(insertParams()).not.toContain('2001-01-01');
  });

  it('a hiring_manager may name several Hiring Managers (the role is a Draft HR approves); the field is stored canonically, and a bad one is 400 before any write', async () => {
    programInsert();
    await create('hiring_manager', BODY);
    expect(insertParams()[2]).toBe('Mandeep Dagar, Piyush Negi');
    fakeDb.reset(); programInsert();
    const bad = await create('hiring_manager', { ...BODY, hiring_manager_name: ',;' });
    expect([bad.status, bad.body.error]).toEqual([400, 'Hiring Manager must name at least one person']);
    nothingWritten();
  });

  it('title and priority are required (400)', async () => {
    programInsert();
    for (const body of [{}, { title: 'x' }, { priority: 'P1' }, { title: '', priority: 'P1' }]) {
      const res = await create('hr_recruiter', body);
      expect([JSON.stringify(body), res.status, res.body.error]).toEqual([JSON.stringify(body), 400, 'title and priority are required']);
    }
    nothingWritten();
  });

  it('a request from a hiring_manager is logged as "Role Requested", one from HR-tier as "Role Created"', async () => {
    programInsert();
    await create('hiring_manager', BODY);
    expect(fakeDb.one(SQL.activity).params.slice(1, 3)).toEqual(['Role Requested', 'Sr. Backend Developer requested (P1)']);
    fakeDb.reset(); programInsert();
    await create('leadership', BODY);
    expect(fakeDb.one(SQL.activity).params.slice(1, 3)).toEqual(['Role Created', 'Sr. Backend Developer created (P1)']);
  });
});
