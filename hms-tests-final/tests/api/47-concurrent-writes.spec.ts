// ─────────────────────────────────────────────────────────────────────────────
// Concurrent and double-submitted writes.
//
// Only the eval-question id series had a concurrency test (db/00), although a prefixed-id collision once hit every series. Three
// check-then-insert paths are racy by construction:
//   * POST /candidates/:id/applications   SELECT existing -> INSERT, backstop UNIQUE(candidate_id, role_id)
//   * POST /candidates/ingest             SELECT candidate by e-mail -> INSERT, backstop UNIQUE(email) / UNIQUE(candidate_id, role_id)
//   * POST /interviews                    id = last id + 1 computed in JS (nextRoundId), backstop the primary key
// and a stage move reads the old stage OUTSIDE its transaction.
//
// Each race has two kinds of test:
//   * an INVARIANT that must hold whatever the timing (no duplicate rows, no ghost rows, exactly one winner, ids unique) — a failure is a bug;
//   * a `TODAY:` test that pins the way the LOSER fails right now (HTTP 500 "Internal server error" where the sequential path says 409/200).
//     A race is timing, so each TODAY test repeats the race up to RACE_TRIES times and passes as soon as the loser is seen to fail with a 500
//     (in practice on the first or second try, also under CPU load). If a fix makes the loser's answer clean, it fails with a message that
//     says to flip it to the clean contract. Nothing here is fixed by this spec.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { BASE, CANDIDATE_INGEST_SECRET, authed, createCandidate, getToken, uid } from '../helpers/api';
import { activityOf, applicationRow, newApplicationAt, roundsOf, settleAll } from '../helpers/api-specs';
import { withDb } from '../helpers/db';

const RACE_TRIES = 10;
const FLIP_HINT = (what: string) => `${what} no longer fails with a 500 in ${RACE_TRIES} tries: the race is probably fixed — replace this TODAY test with the clean contract.`;

type Api = ReturnType<typeof authed>;

async function newRole(api: Api, title: string) {
  const res = await api.post('/api/roles', { title, priority: 'P3' });
  expect(res.status()).toBe(201);
  return (await res.json()).role as { id: string; title: string };
}

async function raceTwoLinks(request: Parameters<typeof getToken>[0]) {
  const api = authed(request, await getToken(request, 'hr'));
  const role = await newRole(api, `Race link role ${uid()}`);
  const { candidate } = await createCandidate(request, await getToken(request, 'hr'));
  const out = await Promise.all([1, 2].map(() => api.post(`/api/candidates/${candidate.id}/applications`, { role_id: role.id })));
  const statuses = out.map(r => r.status()).sort();
  const bodies = await Promise.all(out.map(async r => ({ status: r.status(), body: await r.json() })));
  return { candidate, role, statuses, bodies };
}

async function raceTwoIngests(request: Parameters<typeof getToken>[0]) {
  const api = authed(request, await getToken(request, 'hr'));
  const role = await newRole(api, `Race ingest role ${uid()}`);
  const email = `race.ingest+${uid()}@example.com`;
  const payload = { email, full_name: `Race Ingest ${uid()}`, role_applied_for: role.title };
  const out = await Promise.all([1, 2].map(() => request.post(`${BASE}/api/candidates/ingest`, { headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET }, data: payload })));
  const bodies = await Promise.all(out.map(async r => ({ status: r.status(), body: await r.json() })));
  return { email, role, statuses: bodies.map(b => b.status).sort(), bodies };
}

test.describe('id series stay unique under 15 simultaneous creations', () => {

  test('POST /api/roles x15: every request is 201 and the 15 ids are distinct R-ids', async ({ request }) => {
    const api = authed(request, await getToken(request, 'hr'));
    const tag = uid();
    const out = await settleAll(15, i => api.post('/api/roles', { title: `Concurrent role ${tag} ${i}`, priority: 'P3' }));
    const roles = [];
    for (const o of out) {
      expect(o.error).toBeUndefined();
      expect(o.value!.status()).toBe(201);
      roles.push((await o.value!.json()).role);
    }
    const ids = roles.map(r => r.id as string);
    expect(new Set(ids).size).toBe(15);
    for (const id of ids) expect(id).toMatch(/^R\d{3,}$/);
  });

  test('POST /api/candidates x15: every request is 201 and the 15 ids are distinct C-ids', async ({ request }) => {
    const api = authed(request, await getToken(request, 'hr'));
    const tag = uid();
    const out = await settleAll(15, i => api.post('/api/candidates', { full_name: `Concurrent Candidate ${tag} ${i}`, email: `concurrent+${tag}.${i}@example.com` }));
    const ids: string[] = [];
    for (const o of out) {
      expect(o.error).toBeUndefined();
      expect(o.value!.status()).toBe(201);
      ids.push((await o.value!.json()).candidate.id);
    }
    expect(new Set(ids).size).toBe(15);
    for (const id of ids) expect(id).toMatch(/^C\d{4,}$/);
  });

  test('POST /api/ref-checks x15 on one application: every request is 201 and the 15 ids are distinct RC-ids', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    const out = await settleAll(15, i => hr.post('/api/ref-checks', {
      application_id: application.id, reference_name: `Referee ${i}`, reference_number: `+91 90000 000${String(i).padStart(2, '0')}`, relationship: 'Reporting Manager', feedback: 'Good',
    }));
    const ids: string[] = [];
    for (const o of out) {
      expect(o.error).toBeUndefined();
      expect(o.value!.status()).toBe(201);
      ids.push((await o.value!.json()).ref_check.id);
    }
    expect(new Set(ids).size).toBe(15);
    for (const id of ids) expect(id).toMatch(/^RC\d{3,}$/);
    const stored = (await (await hr.get(`/api/ref-checks?application_id=${application.id}`)).json()).ref_checks;
    expect(stored).toHaveLength(15);
  });
});

test.describe('POST /api/interviews x15 on one application (the round id is last-id + 1 computed in JS)', () => {

  async function batch(request: Parameters<typeof newApplicationAt>[0]) {
    const { hr, application } = await newApplicationAt(request, 'Interview Round 1', 'R006');
    const out = await settleAll(15, i => hr.post('/api/interviews', { application_id: application.id, round_name: `Concurrent round ${i}`, round_number: i + 1 }));
    const statuses: number[] = [];
    const ids: string[] = [];
    for (const o of out) {
      expect(o.error, 'the request itself must complete').toBeUndefined();
      statuses.push(o.value!.status());
      if (o.value!.status() === 201) ids.push((await o.value!.json()).round.id);
    }
    return { hr, application, statuses, ids };
  }

  test('whatever the timing: every answer is 201 or 500, the 201s have distinct IR-ids, and no row or activity is left behind by a failed one', async ({ request }) => {
    const { hr, application, statuses, ids } = await batch(request);
    for (const s of statuses) expect([201, 500]).toContain(s);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^IR\d{4,}$/);

    const stored = await roundsOf(hr, application.id);
    expect(stored.map(r => r.id).sort()).toEqual([...ids].sort());                       // exactly the winners, no ghost rows
    const scheduled = (await activityOf(hr, application.id)).filter(a => a.event_type === 'Interview Round Scheduled');
    expect(scheduled).toHaveLength(ids.length);                                          // the activity row rolled back with its round
  });

  test('TODAY: simultaneous creations collide on the computed id — some requests fail with a 500 although nothing is wrong with them', async ({ request }) => {
    let seen500 = false;
    for (let attempt = 0; attempt < 3 && !seen500; attempt++) {
      const { statuses } = await batch(request);
      seen500 = statuses.includes(500);
    }
    expect(seen500, FLIP_HINT('Concurrent round creation')).toBe(true);
  });
});

test.describe('POST /api/candidates/:id/applications — the same candidate linked to the same role twice at once', () => {

  test('control (sequential): the second call is 409 "Already linked to this role" carrying the first application id', async ({ request }) => {
    const api = authed(request, await getToken(request, 'hr'));
    const role = await newRole(api, `Seq link role ${uid()}`);
    const { candidate } = await createCandidate(request, await getToken(request, 'hr'));
    const first = await api.post(`/api/candidates/${candidate.id}/applications`, { role_id: role.id });
    expect(first.status()).toBe(201);
    const second = await api.post(`/api/candidates/${candidate.id}/applications`, { role_id: role.id });
    expect(second.status()).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'Already linked to this role', application_id: (await first.json()).application.id });
  });

  test('whatever the timing: exactly one 201, the other answer is 409 or 500, and exactly ONE application and ONE "Application Created" row exist', async ({ request }) => {
    for (let pair = 0; pair < 4; pair++) {
      const { candidate, role, bodies } = await raceTwoLinks(request);
      const winners = bodies.filter(b => b.status === 201);
      const losers = bodies.filter(b => b.status !== 201);
      expect(winners, `pair ${pair}`).toHaveLength(1);
      expect(losers, `pair ${pair}`).toHaveLength(1);
      expect([409, 500]).toContain(losers[0].status);

      const rows = await withDb(async c => ({
        apps: (await c.query('SELECT id FROM applications WHERE candidate_id = $1 AND role_id = $2', [candidate.id, role.id])).rows,
        created: (await c.query(`SELECT count(*)::int AS n FROM activity_log WHERE candidate_id = $1 AND role_id = $2 AND event_type = 'Application Created'`, [candidate.id, role.id])).rows[0].n,
      }));
      expect(rows.apps.map(r => r.id)).toEqual([winners[0].body.application.id]);
      expect(rows.created).toBe(1);
    }
  });

  test('TODAY: the losing double-submit is a 500 "Internal server error", not the 409 the sequential path gives (the UNIQUE constraint is the only guard)', async ({ request }) => {
    let loser500 = false;
    for (let attempt = 0; attempt < RACE_TRIES && !loser500; attempt++) {
      const { statuses, bodies } = await raceTwoLinks(request);
      if (statuses.includes(500)) {
        loser500 = true;
        expect(bodies.find(b => b.status === 500)!.body).toEqual({ error: 'Internal server error' });
      }
    }
    expect(loser500, FLIP_HINT('A double-submitted link-to-role')).toBe(true);
  });
});

test.describe('POST /api/candidates/ingest — the Apps Script trigger fires twice for one submission', () => {

  test('control (sequential): a re-fired identical submission is 200 "Already ingested" with the first application id', async ({ request }) => {
    const api = authed(request, await getToken(request, 'hr'));
    const role = await newRole(api, `Seq ingest role ${uid()}`);
    const payload = { email: `seq.ingest+${uid()}@example.com`, full_name: `Seq Ingest ${uid()}`, role_applied_for: role.title };
    const headers = { 'x-ingest-secret': CANDIDATE_INGEST_SECRET };
    const first = await request.post(`${BASE}/api/candidates/ingest`, { headers, data: payload });
    expect(first.status()).toBe(201);
    const { application } = await first.json();
    const second = await request.post(`${BASE}/api/candidates/ingest`, { headers, data: payload });
    expect(second.status()).toBe(200);
    expect(await second.json()).toEqual({ message: 'Already ingested — skipped duplicate', application_id: application.id });
  });

  test('whatever the timing: exactly one 201, the other answer is 200 or 500, and exactly ONE candidate and ONE application exist for the e-mail', async ({ request }) => {
    for (let pair = 0; pair < 4; pair++) {
      const { email, role, bodies } = await raceTwoIngests(request);
      const winners = bodies.filter(b => b.status === 201);
      expect(winners, `pair ${pair}`).toHaveLength(1);
      const loser = bodies.find(b => b.status !== 201)!;
      expect([200, 500]).toContain(loser.status);

      const rows = await withDb(async c => ({
        candidates: (await c.query('SELECT id FROM candidates WHERE email = $1', [email])).rows,
        apps: (await c.query('SELECT a.id FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE c.email = $1 AND a.role_id = $2', [email, role.id])).rows,
      }));
      expect(rows.candidates.map(r => r.id)).toEqual([winners[0].body.candidate.id]);
      expect(rows.apps.map(r => r.id)).toEqual([winners[0].body.application.id]);
    }
  });

  test('TODAY: the losing duplicate of a brand-new applicant is a 500, not the 200 "Already ingested" a re-fire gets one second later', async ({ request }) => {
    let loser500 = false;
    for (let attempt = 0; attempt < RACE_TRIES && !loser500; attempt++) {
      const { statuses, bodies } = await raceTwoIngests(request);
      if (statuses.includes(500)) {
        loser500 = true;
        expect(bodies.find(b => b.status === 500)!.body).toEqual({ error: 'Internal server error' });
      }
    }
    expect(loser500, FLIP_HINT('A double-fired ingest of a new applicant')).toBe(true);
  });
});

test.describe('POST /api/applications/:id/stage — simultaneous moves of one application', () => {

  test('eight moves at once: all 200, one "Stage Changed" row per request, and the stored stage is the one the LAST committed move wrote', async ({ request }) => {
    const { hr, application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
    const stages = ['Interview Round 2', 'Assignment Round', 'Founders Round', 'Reference Check'];
    // skip_reason: the move gates (pending feedback, reference check) are not what is being tested.
    const out = await settleAll(8, i => hr.post(`/api/applications/${application.id}/stage`, { new_stage: stages[i % 4], skip_reason: 'concurrency test' }));
    for (const o of out) {
      expect(o.error).toBeUndefined();
      expect(o.value!.status()).toBe(200);
    }
    const rows = await withDb(async c => (await c.query(
      `SELECT new_value FROM activity_log WHERE application_id = $1 AND event_type = 'Stage Changed' ORDER BY id`, [application.id])).rows);
    expect(rows).toHaveLength(8);
    const stored = (await applicationRow(application.id)).stage;
    expect(stages).toContain(stored);
    expect(stored).toBe(rows[rows.length - 1].new_value);
  });

  test('TODAY: two simultaneous shortlists of one application (e.g. HR and a Hiring Manager clicking together) leave TWO open "HM shortlist review" rows', async ({ request }) => {
    // The "was this the shortlist?" check reads the stage before the transaction, so both requests see Applied and Screened.
    let duplicated = false;
    for (let attempt = 0; attempt < RACE_TRIES && !duplicated; attempt++) {
      const { application } = await newApplicationAt(request, 'Applied and Screened', 'R006');
      const hr = authed(request, await getToken(request, 'hr'));
      const hm = authed(request, await getToken(request, 'hm_alex'));
      const out = await Promise.all([hr, hm].map(api => api.post(`/api/applications/${application.id}/stage`, { new_stage: 'Interview Round 1' })));
      for (const r of out) expect(r.status()).toBe(200);
      expect((await applicationRow(application.id)).stage).toBe('Interview Round 1');
      const open = await withDb(async c => (await c.query(
        `SELECT id FROM pending_actions WHERE application_id = $1 AND action_type = 'HM shortlist review' AND resolved = false`, [application.id])).rows);
      expect(open.length, 'at least one review row must exist').toBeGreaterThanOrEqual(1);
      if (open.length === 2) duplicated = true;
    }
    expect(duplicated, FLIP_HINT('A double shortlist')).toBe(true);
  });
});
