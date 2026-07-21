import { test, expect } from '@playwright/test';
import { BASE, CANDIDATE_INGEST_SECRET, getToken, authed, SEEDED, uid } from '../helpers/api';

// ─── POST /api/candidates/ingest ────────────────────────────────────────────
// Public webhook (no JWT) hit by the Job Application Form's Apps Script
// trigger. Guarded only by the 'x-ingest-secret' header — see
// candidateIngest.ts. Exact seeded titles (from seed.sql) used for
// role_applied_for free-text matching, per SEEDED.roles.qa_eng / senior_pm.
const QA_TITLE = 'Quality Assurance Engineer';       // R005 — status 'Live – Sourcing'
const PM_TITLE = 'Senior Product Manager';           // R006 — status 'Live – Sourcing'

test.describe('Candidate Ingestion Webhook', () => {

  test.describe('POST /api/candidates/ingest', () => {

    test('happy path — exact role title match creates candidate + Applied application', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
        data: {
          email:            `applicant+${marker}@example.com`,
          full_name:        `Ingest Test ${marker}`,
          role_applied_for: QA_TITLE,
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.candidate.id).toMatch(/^C\d{4}$/);
      expect(body.application).not.toBeNull();
      expect(body.application.role_id).toBe(SEEDED.roles.qa_eng);
      expect(body.application.source_channel).toBe('Job Application Form');
      expect(body.application.stage).toBe('Applied');
    });

    test('re-POSTing an identical body is a no-op — 200, does not create a second application', async ({ request }) => {
      const marker  = uid();
      const payload = {
        email:            `dup+${marker}@example.com`,
        full_name:        `Dup Test ${marker}`,
        role_applied_for: QA_TITLE,
      };

      const res1 = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
        data: payload,
      });
      expect(res1.status()).toBe(201);
      const body1 = await res1.json();
      expect(body1.application).not.toBeNull();

      const res2 = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
        data: payload,
      });
      expect(res2.status()).toBe(200);
      const body2 = await res2.json();
      expect(body2.message).toBe('Already ingested — skipped duplicate');
      expect(body2.application_id).toBe(body1.application.id);

      // Confirm no second application was created for this candidate.
      const token   = await getToken(request, 'hr');
      const getRes  = await authed(request, token).get(`/api/candidates/${body1.candidate.id}`);
      const { applications } = await getRes.json();
      expect(applications.length).toBe(1);
    });

    test('same email, different matched role — second application created, same candidate reused', async ({ request }) => {
      const marker = uid();
      const email  = `multirole+${marker}@example.com`;

      const res1 = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
        data: {
          email, full_name: `Multi Role ${marker}`,
          role_applied_for: QA_TITLE,
        },
      });
      expect(res1.status()).toBe(201);
      const body1 = await res1.json();
      expect(body1.application.role_id).toBe(SEEDED.roles.qa_eng);

      const res2 = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
        data: {
          email, full_name: `Multi Role ${marker}`,
          role_applied_for: PM_TITLE,
        },
      });
      expect(res2.status()).toBe(201);
      const body2 = await res2.json();
      expect(body2.candidate.id).toBe(body1.candidate.id);
      expect(body2.application).not.toBeNull();
      expect(body2.application.role_id).toBe(SEEDED.roles.senior_pm);
      expect(body2.application.id).not.toBe(body1.application.id);

      const token  = await getToken(request, 'hr');
      const getRes = await authed(request, token).get(`/api/candidates/${body1.candidate.id}`);
      const { applications } = await getRes.json();
      expect(applications.length).toBe(2);
    });

    test('role_applied_for matching no open role — candidate created, application null, warning returned', async ({ request }) => {
      const marker    = uid();
      const roleQuery = `Totally Made Up Role ${marker}`;
      const res = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
        data: {
          email:            `norole+${marker}@example.com`,
          full_name:        `No Role Match ${marker}`,
          role_applied_for: roleQuery,
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.candidate.id).toMatch(/^C\d{4}$/);
      expect(body.application).toBeNull();
      expect(body.warning).toBe(`No open role matched "${roleQuery}"`);
    });

    test('internal double/triple spaces in role_applied_for still match via whitespace-collapse', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
        data: {
          email:            `spacey+${marker}@example.com`,
          full_name:        `Spacey Title ${marker}`,
          role_applied_for: 'Quality  Assurance   Engineer', // extra internal spaces vs QA_TITLE
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.application).not.toBeNull();
      expect(body.application.role_id).toBe(SEEDED.roles.qa_eng);
    });

    test('ambiguous match — two roles sharing a title yields null application + ambiguous warning', async ({ request }) => {
      const marker      = uid();
      const sharedTitle = `Ambiguous Role ${marker}`;
      const token       = await getToken(request, 'hr');
      const api         = authed(request, token);

      const create1 = await api.post('/api/roles', { title: sharedTitle, priority: 'P2' });
      expect(create1.status()).toBe(201);
      const create2 = await api.post('/api/roles', { title: sharedTitle, priority: 'P2' });
      expect(create2.status()).toBe(201);

      const res = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
        data: {
          email:            `ambiguous+${marker}@example.com`,
          full_name:        `Ambiguous Applicant ${marker}`,
          role_applied_for: sharedTitle,
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.application).toBeNull();
      expect(body.warning).toBe(`Multiple roles matched "${sharedTitle}" — ambiguous`);
    });

    test('fill-null-only: existing profile fields preserved, but full_name is always refreshed', async ({ request }) => {
      const marker = uid();
      const email  = `fillnull+${marker}@example.com`;

      const res1 = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
        data: {
          email,
          full_name:       `Original Name ${marker}`,
          current_company: 'Original Company Inc',
        },
      });
      expect(res1.status()).toBe(201);
      const body1 = await res1.json();
      expect(body1.candidate.current_company).toBe('Original Company Inc');

      const res2 = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
        data: {
          email,
          full_name:       `Updated Name ${marker}`,
          current_company: 'Different Company LLC',
        },
      });
      expect(res2.status()).toBe(201);
      const body2 = await res2.json();
      expect(body2.candidate.id).toBe(body1.candidate.id);
      // Existing non-null profile field is NOT overwritten by the later submission.
      expect(body2.candidate.current_company).toBe('Original Company Inc');
      // full_name is excluded from PROFILE_FIELDS — always refreshed.
      expect(body2.candidate.full_name).toBe(`Updated Name ${marker}`);
    });

    test('languages_known, preferred_location and qualifications_note round-trip correctly', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
        data: {
          email:               `roundtrip+${marker}@example.com`,
          full_name:           `Round Trip ${marker}`,
          role_applied_for:    QA_TITLE,
          languages_known:     'English, Hindi, Marathi',
          preferred_location:  'Bengaluru',
          qualifications_note: 'B.Tech CS, 2019 graduate',
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.candidate.languages_known).toBe('English, Hindi, Marathi');
      expect(body.application).not.toBeNull();
      expect(body.application.preferred_location).toBe('Bengaluru');
      expect(body.application.qualifications_note).toBe('B.Tech CS, 2019 graduate');
    });

    test('returns 401 with wrong x-ingest-secret', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': 'totally-wrong-secret' },
        data: {
          email:     `badsecret+${marker}@example.com`,
          full_name: `Should Not Be Created ${marker}`,
        },
      });
      expect(res.status()).toBe(401);
    });

    test('returns 401 with no x-ingest-secret header at all', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/candidates/ingest`, {
        data: {
          email:     `nosecret+${marker}@example.com`,
          full_name: `Should Not Be Created ${marker}`,
        },
      });
      expect(res.status()).toBe(401);
    });

    test('returns 400 when email is missing', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
        data: { full_name: `No Email ${marker}` },
      });
      expect(res.status()).toBe(400);
    });

    test('returns 400 when full_name is missing', async ({ request }) => {
      const marker = uid();
      const res = await request.post(`${BASE}/api/candidates/ingest`, {
        headers: { 'x-ingest-secret': CANDIDATE_INGEST_SECRET },
        data: { email: `noname+${marker}@example.com` },
      });
      expect(res.status()).toBe(400);
    });
  });
});
