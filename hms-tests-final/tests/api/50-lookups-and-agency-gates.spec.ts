// ─────────────────────────────────────────────────────────────────────────────
// Lookup tables and their persona gates (backend/src/routes/lookups.ts, agencies.ts, assignmentRepo.ts).
//
//   comp-benchmarks   the WHOLE router is HR-tier (GET included); PATCH writes the bands and stamps updated_by.   (no spec before)
//   eval-questions    GET open to every signed-in user (approved questions only, 'All' rows match any filter); POST HR-tier.
//   agencies          the whole router HR-tier; PATCH writes an edit log (agency_edit_log).
//   assignment-repo   still mounted although the frontend never calls it: GETs open to any signed-in user, writes HR-tier.
//
// Every row these tests touch is their own (a tag in the name / category), created through the API where there is a create route and by
// SQL where there is not (comp_benchmarks), and deleted again in afterAll — the seeded benchmarks are read by other specs and must not move.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { authed, getSession, getToken, uid } from '../helpers/api';
import { HR_TIER_USERS, rawStatus } from '../helpers/api-specs';
import { withDb } from '../helpers/db';

const tag = uid();
const HR_ACCESS = 'HR access required';

test.afterAll(async () => {
  await withDb(async c => {
    await c.query(`DELETE FROM agencies WHERE name LIKE $1`, [`Gate Agency ${tag}%`]);                 // agency_edit_log cascades
    await c.query(`DELETE FROM eval_questions WHERE evaluation_area LIKE $1`, [`Gate Area ${tag}%`]);
    await c.query(`DELETE FROM assignment_repo WHERE name LIKE $1`, [`Gate Assignment ${tag}%`]);
    await c.query(`DELETE FROM comp_benchmarks WHERE role_category LIKE $1`, [`Gate Benchmark ${tag}%`]);
  });
});

// ─── comp benchmarks ──────────────────────────────────────────────────────────
test.describe('/api/comp-benchmarks', () => {

  async function ownBenchmark(label: string) {
    return withDb(async c => (await c.query(
      `INSERT INTO comp_benchmarks (role_category, experience_range, internal_band_min, internal_band_max, market_band_min, market_band_max, notes)
       VALUES ($1, '3-5 yrs', 10, 20, 12, 24, 'seed note') RETURNING *`, [`Gate Benchmark ${tag} ${label}`])).rows[0]);
  }
  const stored = (id: string) => withDb(async c => (await c.query('SELECT * FROM comp_benchmarks WHERE id = $1', [id])).rows[0]);

  test('HR-tier PATCH writes the bands and stamps updated_by with the caller (hr, hr2, leadership, super_admin); untouched columns stay', async ({ request }) => {
    const bench = await ownBenchmark('patch');
    for (const [i, who] of HR_TIER_USERS.entries()) {
      const session = await getSession(request, who);
      const res = await authed(request, session.token).patch(`/api/comp-benchmarks/${bench.id}`, { internal_band_min: 21 + i, internal_band_max: 30 + i, notes: `by ${who}` });
      expect(res.status(), who).toBe(200);
      const { benchmark } = await res.json();
      expect(Number(benchmark.internal_band_min)).toBe(21 + i);
      expect(Number(benchmark.internal_band_max)).toBe(30 + i);
      expect(benchmark.notes).toBe(`by ${who}`);
      expect(benchmark.updated_by).toBe(session.user.id);
      expect(Number(benchmark.market_band_min)).toBe(12);          // not in the body: untouched
      expect(Number(benchmark.market_band_max)).toBe(24);
    }
    expect(Number((await stored(bench.id)).internal_band_max)).toBe(33);
  });

  test('only the whitelisted columns can be written: id, role_category and a supplied updated_by are ignored (and a body with only those is 400 "No fields")', async ({ request }) => {
    const bench = await ownBenchmark('whitelist');
    const hr = await getSession(request, 'hr');
    const api = authed(request, hr.token);

    const onlyForbidden = await api.patch(`/api/comp-benchmarks/${bench.id}`, { id: 'BEN9999', role_category: 'Hacked', experience_range: 'Hacked', currency: 'USD' });
    expect(onlyForbidden.status()).toBe(400);
    expect((await onlyForbidden.json()).error).toBe('No fields');

    const mixed = await api.patch(`/api/comp-benchmarks/${bench.id}`, { notes: 'kept', role_category: 'Hacked', updated_by: 'a0000000-0000-0000-0000-000000000001' });
    expect(mixed.status()).toBe(200);
    const row = await stored(bench.id);
    expect(row.notes).toBe('kept');
    expect(row.role_category).toBe(`Gate Benchmark ${tag} whitelist`);
    expect(row.id).toBe(bench.id);
    expect(row.currency).toBe('LPA');
    expect(row.updated_by).toBe(hr.user.id);                       // the caller, not the id the body tried to supply
  });

  test('an empty body is 400 "No fields"; an unknown id is 404 "Not found"', async ({ request }) => {
    const bench = await ownBenchmark('empty');
    const api = authed(request, await getToken(request, 'hr'));
    const empty = await api.patch(`/api/comp-benchmarks/${bench.id}`, {});
    expect(empty.status()).toBe(400);
    expect((await empty.json()).error).toBe('No fields');
    const unknown = await api.patch(`/api/comp-benchmarks/BEN-NOPE-${uid()}`, { notes: 'x' });
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).error).toBe('Not found');
    expect((await stored(bench.id)).notes).toBe('seed note');
  });

  test('a Hiring Manager is 403 "HR access required" on GET and PATCH and nothing is written; anonymous is 401', async ({ request }) => {
    const bench = await ownBenchmark('hm');
    for (const who of ['hm_alex', 'hm_satyadev'] as const) {
      const api = authed(request, await getToken(request, who));
      const list = await api.get('/api/comp-benchmarks');
      expect(list.status(), who).toBe(403);
      expect((await list.json()).error).toBe(HR_ACCESS);
      const patch = await api.patch(`/api/comp-benchmarks/${bench.id}`, { internal_band_max: 999 });
      expect(patch.status(), who).toBe(403);
    }
    expect((await rawStatus(request, 'PATCH', `/api/comp-benchmarks/${bench.id}`, { data: { notes: 'x' } })).status).toBe(401);
    const row = await stored(bench.id);
    expect(Number(row.internal_band_max)).toBe(20);
    expect(row.updated_by).toBeNull();
  });

  test('GET lists the benchmarks and filters by role_category (exact match)', async ({ request }) => {
    const mine = await ownBenchmark('list');
    const api = authed(request, await getToken(request, 'hr'));
    const filtered = await (await api.get(`/api/comp-benchmarks?role_category=${encodeURIComponent(mine.role_category)}`)).json();
    expect(filtered.benchmarks.map((b: { id: string }) => b.id)).toEqual([mine.id]);
    const all = await (await api.get('/api/comp-benchmarks')).json();
    expect(all.benchmarks.some((b: { id: string }) => b.id === mine.id)).toBe(true);
    expect(all.benchmarks.length).toBeGreaterThan(1);
  });

  test('TODAY: a non-numeric band is a 500 (the DECIMAL cast) and the row is unchanged; an inverted band (min above max) is accepted', async ({ request }) => {
    const bench = await ownBenchmark('invalid');
    const api = authed(request, await getToken(request, 'hr'));
    const bad = await api.patch(`/api/comp-benchmarks/${bench.id}`, { internal_band_min: 'abc' });
    expect(bad.status()).toBe(500);
    expect((await stored(bench.id)).internal_band_min).toBe(bench.internal_band_min);

    const inverted = await api.patch(`/api/comp-benchmarks/${bench.id}`, { internal_band_min: 90, internal_band_max: 10 });
    expect(inverted.status()).toBe(200);
    const row = await stored(bench.id);
    expect([Number(row.internal_band_min), Number(row.internal_band_max)]).toEqual([90, 10]);
  });
});

// ─── eval questions ───────────────────────────────────────────────────────────
test.describe('/api/eval-questions', () => {

  async function addQuestion(api: ReturnType<typeof authed>, area: string, extra: Record<string, unknown> = {}) {
    const res = await api.post('/api/eval-questions', { evaluation_area: area, question_text: `Question ${uid()}?`, ...extra });
    expect(res.status()).toBe(201);
    return (await res.json()).question as Record<string, any>;
  }

  test('POST by HR fills the documented defaults and records who added it; the id is a Q-id', async ({ request }) => {
    const hr = await getSession(request, 'hr');
    const q = await addQuestion(authed(request, hr.token), `Gate Area ${tag} defaults`);
    expect(q).toMatchObject({
      role_category: 'All', experience_level: 'All', question_type: 'Behavioural', priority: 'Recommended',
      source: 'HR-Curated', approved: true, added_by: hr.user.id,
    });
    expect(q.id).toMatch(/^Q\d{3,}$/);
  });

  test('every HR-tier persona may add a question; a Hiring Manager (403 "HR access required") and an anonymous caller (401) may not, and nothing is stored', async ({ request }) => {
    const area = `Gate Area ${tag} persona`;
    for (const who of HR_TIER_USERS) {
      const res = await authed(request, await getToken(request, who)).post('/api/eval-questions', { evaluation_area: area, question_text: `by ${who}` });
      expect(res.status(), who).toBe(201);
    }
    for (const who of ['hm_alex', 'hm_satyadev'] as const) {
      const res = await authed(request, await getToken(request, who)).post('/api/eval-questions', { evaluation_area: area, question_text: 'by a hiring manager' });
      expect(res.status(), who).toBe(403);
      expect((await res.json()).error).toBe(HR_ACCESS);
    }
    expect((await rawStatus(request, 'POST', '/api/eval-questions', { data: { evaluation_area: area, question_text: 'anon' } })).status).toBe(401);
    const count = await withDb(async c => (await c.query('SELECT count(*)::int AS n FROM eval_questions WHERE evaluation_area = $1', [area])).rows[0].n);
    expect(count).toBe(HR_TIER_USERS.length);
  });

  test('evaluation_area and question_text are both required (400)', async ({ request }) => {
    const api = authed(request, await getToken(request, 'hr'));
    for (const body of [{ question_text: 'no area' }, { evaluation_area: `Gate Area ${tag} x` }, { evaluation_area: '', question_text: '' }]) {
      const res = await api.post('/api/eval-questions', body);
      expect(res.status(), JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe('evaluation_area and question_text required');
    }
  });

  test('GET is open to a Hiring Manager, matches "All" rows for any role_category / experience_level filter, and hides unapproved questions', async ({ request }) => {
    const area = `Gate Area ${tag} filters`;
    const hr = authed(request, await getToken(request, 'hr'));
    const specific = await addQuestion(hr, area, { role_category: 'Engineering', experience_level: 'Senior' });
    const generic = await addQuestion(hr, area);                         // role_category 'All', experience_level 'All'
    const hidden = await addQuestion(hr, area, { role_category: 'Engineering' });
    await withDb(c => c.query('UPDATE eval_questions SET approved = false WHERE id = $1', [hidden.id]));

    const hm = authed(request, await getToken(request, 'hm_alex'));
    const ids = async (qs: string) => ((await (await hm.get(`/api/eval-questions?area=${encodeURIComponent(area)}${qs}`)).json()).questions as Array<{ id: string }>).map(q => q.id).sort();
    expect(await ids('')).toEqual([specific.id, generic.id].sort());                                   // unapproved never listed
    expect(await ids('&role_category=Engineering')).toEqual([specific.id, generic.id].sort());
    expect(await ids('&role_category=Sales')).toEqual([generic.id]);                                   // 'Engineering' != 'Sales', 'All' matches anything
    expect(await ids('&role_category=Engineering&experience_level=Junior')).toEqual([generic.id]);
    expect(await ids('&experience_level=Senior')).toEqual([specific.id, generic.id].sort());
  });

  test('TODAY: a question_type outside the allowed list is a 500 (CHECK constraint), not a 400, and nothing is stored', async ({ request }) => {
    const area = `Gate Area ${tag} invalid`;
    const res = await authed(request, await getToken(request, 'hr')).post('/api/eval-questions', { evaluation_area: area, question_text: 'q?', question_type: 'Quiz' });
    expect(res.status()).toBe(500);
    const count = await withDb(async c => (await c.query('SELECT count(*)::int AS n FROM eval_questions WHERE evaluation_area = $1', [area])).rows[0].n);
    expect(count).toBe(0);
  });
});

// ─── agencies ─────────────────────────────────────────────────────────────────
test.describe('/api/agencies', () => {

  async function addAgency(api: ReturnType<typeof authed>, label: string, extra: Record<string, unknown> = {}) {
    const res = await api.post('/api/agencies', { name: `Gate Agency ${tag} ${label}`, ...extra });
    expect(res.status()).toBe(201);
    return (await res.json()).agency as Record<string, any>;
  }

  test('POST fills the defaults (Active, 60 days replacement guarantee); a missing name is 400 "name required"', async ({ request }) => {
    const api = authed(request, await getToken(request, 'hr'));
    const agency = await addAgency(api, 'defaults');
    expect(agency).toMatchObject({ contract_status: 'Active', replacement_guarantee_days: 60 });
    const res = await api.post('/api/agencies', { contact_name: 'No Name' });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('name required');
  });

  test('an unknown id is 404: GET "Agency not found", PATCH "Not found"', async ({ request }) => {
    const api = authed(request, await getToken(request, 'hr'));
    const get = await api.get(`/api/agencies/AGN-NOPE-${uid()}`);
    expect(get.status()).toBe(404);
    expect((await get.json()).error).toBe('Agency not found');
    const patch = await api.patch(`/api/agencies/AGN-NOPE-${uid()}`, { notes: 'x' });
    expect(patch.status()).toBe(404);
    expect((await patch.json()).error).toBe('Not found');
  });

  test('every change is written to the edit log with field, old value, new value, who and when (newest first); a no-op PATCH logs nothing', async ({ request }) => {
    const hr = await getSession(request, 'hr');
    const api = authed(request, hr.token);
    const agency = await addAgency(api, 'editlog', { notes: 'first note' });
    const renamed = `Gate Agency ${tag} editlog renamed`;

    const one = await api.patch(`/api/agencies/${agency.id}`, { name: renamed, contract_status: 'On Hold' });
    expect(one.status()).toBe(200);
    expect((await one.json()).agency).toMatchObject({ name: renamed, contract_status: 'On Hold' });
    const two = await api.patch(`/api/agencies/${agency.id}`, { notes: 'second note' });
    expect(two.status()).toBe(200);

    const { logs } = await (await api.get(`/api/agencies/${agency.id}/edit-log`)).json();
    expect(logs).toHaveLength(3);
    const byField = Object.fromEntries(logs.map((l: { field_name: string }) => [l.field_name, l]));
    expect(byField.name).toMatchObject({ agency_id: agency.id, old_value: agency.name, new_value: renamed, changed_by: hr.user.id, changed_by_name: 'Aaron Newton' });
    expect(byField.contract_status).toMatchObject({ old_value: 'Active', new_value: 'On Hold' });
    expect(byField.notes).toMatchObject({ old_value: 'first note', new_value: 'second note' });
    expect(logs[0].field_name).toBe('notes');                                          // the later PATCH comes first
    for (const l of logs) expect(Number.isNaN(Date.parse(l.changed_at))).toBe(false);

    const noop = await api.patch(`/api/agencies/${agency.id}`, { name: renamed, notes: 'second note' });
    expect(noop.status()).toBe(200);
    expect((await noop.json()).message).toBe('No changes detected');
    expect((await (await api.get(`/api/agencies/${agency.id}/edit-log`)).json()).logs).toHaveLength(3);
  });

  test('only whitelisted fields are writable: id and created_at in the body change nothing (the PATCH reports "No changes detected")', async ({ request }) => {
    const api = authed(request, await getToken(request, 'hr'));
    const agency = await addAgency(api, 'whitelist');
    const res = await api.patch(`/api/agencies/${agency.id}`, { id: 'AGN999999', created_at: '2000-01-01T00:00:00Z', total_hired: 99 });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('No changes detected');
    expect(body.agency.id).toBe(agency.id);
  });

  test('a Hiring Manager is 403 "HR access required" on every agency route and an anonymous caller is 401', async ({ request }) => {
    const api = authed(request, await getToken(request, 'hr'));
    const agency = await addAgency(api, 'hm');
    const hm = authed(request, await getToken(request, 'hm_alex'));
    const attempts: Array<[string, Promise<{ status(): number; json(): Promise<any> }>]> = [
      ['GET list', hm.get('/api/agencies')], ['GET one', hm.get(`/api/agencies/${agency.id}`)],
      ['POST', hm.post('/api/agencies', { name: `Gate Agency ${tag} hm-created` })],
      ['PATCH', hm.patch(`/api/agencies/${agency.id}`, { notes: 'hm edit' })], ['edit-log', hm.get(`/api/agencies/${agency.id}/edit-log`)],
    ];
    for (const [label, p] of attempts) {
      const res = await p;
      expect(res.status(), label).toBe(403);
      expect((await res.json()).error, label).toBe(HR_ACCESS);
    }
    expect((await rawStatus(request, 'GET', '/api/agencies')).status).toBe(401);
    const row = await withDb(async c => (await c.query('SELECT notes FROM agencies WHERE id = $1', [agency.id])).rows[0]);
    expect(row.notes).toBeNull();
    const created = await withDb(async c => (await c.query('SELECT count(*)::int AS n FROM agencies WHERE name = $1', [`Gate Agency ${tag} hm-created`])).rows[0].n);
    expect(created).toBe(0);
  });

  test('TODAY: an unknown agency\'s edit-log is 200 { logs: [] } (no 404), and an invalid contract_status is a 500 on POST and on PATCH (CHECK constraint) that leaves the row unchanged', async ({ request }) => {
    const api = authed(request, await getToken(request, 'hr'));
    const unknown = await api.get(`/api/agencies/AGN-NOPE-${uid()}/edit-log`);
    expect(unknown.status()).toBe(200);
    expect(await unknown.json()).toEqual({ logs: [] });

    const agency = await addAgency(api, 'invalid');
    const patch = await api.patch(`/api/agencies/${agency.id}`, { contract_status: 'Retired', notes: 'should roll back' });
    expect(patch.status()).toBe(500);
    const row = await withDb(async c => (await c.query('SELECT contract_status, notes FROM agencies WHERE id = $1', [agency.id])).rows[0]);
    expect(row).toEqual({ contract_status: 'Active', notes: null });
    expect((await (await api.get(`/api/agencies/${agency.id}/edit-log`)).json()).logs).toHaveLength(0);

    const post = await api.post('/api/agencies', { name: `Gate Agency ${tag} invalid-create`, contract_status: 'Retired' });
    expect(post.status()).toBe(500);
  });
});

// ─── assignment repository (mounted, unused by the frontend) ──────────────────
test.describe('/api/assignment-repo', () => {

  async function addAssignment(api: ReturnType<typeof authed>, label: string, extra: Record<string, unknown> = {}) {
    const res = await api.post('/api/assignment-repo', { name: `Gate Assignment ${tag} ${label}`, problem_statement: 'Design a thing.', ...extra });
    expect(res.status()).toBe(201);
    return (await res.json()).assignment as Record<string, any>;
  }

  test('POST by HR needs name and problem_statement (400 otherwise), fills the defaults and records the creator', async ({ request }) => {
    const hr = await getSession(request, 'hr');
    const api = authed(request, hr.token);
    const a = await addAssignment(api, 'defaults');
    expect(a.id).toMatch(/^ASN\d{3,}$/);
    expect(a).toMatchObject({ skills_covered: [], times_used: 0, created_by: hr.user.id });
    for (const body of [{ name: 'x' }, { problem_statement: 'y' }, {}]) {
      const res = await api.post('/api/assignment-repo', body);
      expect(res.status(), JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe('name and problem_statement are required');
    }
  });

  test('the GETs are open to every signed-in user (a Hiring Manager reads the list and one item; an unknown id is 404 "Not found"); anonymous is 401', async ({ request }) => {
    const a = await addAssignment(authed(request, await getToken(request, 'hr')), 'read');
    const hm = authed(request, await getToken(request, 'hm_alex'));
    const list = await hm.get('/api/assignment-repo');
    expect(list.status()).toBe(200);
    expect((await list.json()).assignments.some((x: { id: string }) => x.id === a.id)).toBe(true);
    const one = await hm.get(`/api/assignment-repo/${a.id}`);
    expect(one.status()).toBe(200);
    expect((await one.json()).assignment.name).toBe(a.name);
    const unknown = await hm.get(`/api/assignment-repo/ASN-NOPE-${uid()}`);
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).error).toBe('Not found');
    expect((await rawStatus(request, 'GET', '/api/assignment-repo')).status).toBe(401);
  });

  test('writes are HR-tier: every HR-tier persona may create, a Hiring Manager is 403 on POST and PATCH and nothing changes', async ({ request }) => {
    for (const who of HR_TIER_USERS) {
      await addAssignment(authed(request, await getToken(request, who)), `by-${who}`);
    }
    const a = await addAssignment(authed(request, await getToken(request, 'hr')), 'hm-target');
    const hm = authed(request, await getToken(request, 'hm_alex'));
    const post = await hm.post('/api/assignment-repo', { name: `Gate Assignment ${tag} hm-created`, problem_statement: 'x' });
    expect(post.status()).toBe(403);
    expect((await post.json()).error).toBe(HR_ACCESS);
    const patch = await hm.patch(`/api/assignment-repo/${a.id}`, { name: 'hm rename' });
    expect(patch.status()).toBe(403);
    const row = await withDb(async c => ({
      name: (await c.query('SELECT name FROM assignment_repo WHERE id = $1', [a.id])).rows[0].name,
      created: (await c.query('SELECT count(*)::int AS n FROM assignment_repo WHERE name = $1', [`Gate Assignment ${tag} hm-created`])).rows[0].n,
    }));
    expect(row).toEqual({ name: a.name, created: 0 });
  });

  test('PATCH writes only the whitelisted columns (times_used and created_by are ignored); an empty or non-whitelisted-only body is 400 "No fields"; an unknown id is 404', async ({ request }) => {
    const hr = await getSession(request, 'hr');
    const api = authed(request, hr.token);
    const a = await addAssignment(api, 'patch');

    const onlyForbidden = await api.patch(`/api/assignment-repo/${a.id}`, { times_used: 99, created_by: hr.user.id });
    expect(onlyForbidden.status()).toBe(400);
    expect((await onlyForbidden.json()).error).toBe('No fields');
    const empty = await api.patch(`/api/assignment-repo/${a.id}`, {});
    expect(empty.status()).toBe(400);

    const ok = await api.patch(`/api/assignment-repo/${a.id}`, { drive_link: 'https://example.com/brief', difficulty_level: 'High', times_used: 99 });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).assignment).toMatchObject({ drive_link: 'https://example.com/brief', difficulty_level: 'High', times_used: 0 });

    const unknown = await api.patch(`/api/assignment-repo/ASN-NOPE-${uid()}`, { name: 'x' });
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).error).toBe('Not found');
  });

  test('TODAY: a difficulty_level or experience_level outside the allowed list is a 500 (CHECK constraint), not a 400', async ({ request }) => {
    const api = authed(request, await getToken(request, 'hr'));
    const post = await api.post('/api/assignment-repo', { name: `Gate Assignment ${tag} invalid`, problem_statement: 'x', difficulty_level: 'Extreme' });
    expect(post.status()).toBe(500);
    const a = await addAssignment(api, 'invalid-patch');
    const patch = await api.patch(`/api/assignment-repo/${a.id}`, { experience_level: 'Principal' });
    expect(patch.status()).toBe(500);
  });
});
