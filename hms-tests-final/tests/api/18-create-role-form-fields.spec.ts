import { test, expect } from '@playwright/test';
import { getToken, authed, uid } from '../helpers/api';

// ─── Create Role form field changes ───────────────────────────────────────────
// Covers the roles.ts POST / and PATCH /:id changes for:
//   - vacancy_reason        TEXT[]  ("Vacancy Caused Due To", multi-select)
//   - qualification_required TEXT   ("Educational Qualifications")
//   - new_or_replacement    TEXT    (replaces the old new_replacement /
//                                    replacement_reason pair — those two are
//                                    no longer written by this route at all)
//   - nice_to_have_skills, additional_remarks — plain passthrough text fields
//   - assignment_required   defaults to true via `?? true` when the request
//                            body omits it entirely (no more UI checkbox for
//                            this field), but an explicit `false` must still
//                            be respected.
//
// Every test creates its own role (uid()-suffixed title) so tests never
// collide or depend on each other's data.

test.describe('Create Role form fields', () => {

  test.describe('POST /api/roles', () => {

    test('vacancy_reason array, qualification_required, nice_to_have_skills, additional_remarks, and location all persist', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res = await authed(request, token).post('/api/roles', {
        title: `Test Role ${uid()}`,
        priority: 'P2',
        vacancy_reason: ['Resignation', 'New Project'],
        qualification_required: 'B.Tech',
        nice_to_have_skills: 'Docker',
        additional_remarks: 'test note',
        location: 'Gurgaon',
      });
      expect(res.status()).toBe(201);

      const { role } = await res.json();
      expect(Array.isArray(role.vacancy_reason)).toBe(true);
      // Order-independent — compare as sorted arrays.
      expect([...role.vacancy_reason].sort()).toEqual(['New Project', 'Resignation'].sort());
      expect(role.qualification_required).toBe('B.Tech');
      expect(role.nice_to_have_skills).toBe('Docker');
      expect(role.additional_remarks).toBe('test note');
      expect(role.location).toBe('Gurgaon');
    });

    test('assignment_required defaults to true when omitted entirely from the body', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res = await authed(request, token).post('/api/roles', {
        title: `Test Role ${uid()}`,
        priority: 'P2',
        // assignment_required intentionally not sent at all.
      });
      expect(res.status()).toBe(201);

      const { role } = await res.json();
      expect(role.assignment_required).toBe(true);
    });

    test('assignment_required: false is respected — the default must not override an explicit false', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res = await authed(request, token).post('/api/roles', {
        title: `Test Role ${uid()}`,
        priority: 'P2',
        assignment_required: false,
      });
      expect(res.status()).toBe(201);

      const { role } = await res.json();
      expect(role.assignment_required).toBe(false);
    });

    test('new_or_replacement is written on create (legacy new_replacement is not written and is not asserted here)', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res = await authed(request, token).post('/api/roles', {
        title: `Test Role ${uid()}`,
        priority: 'P2',
        new_or_replacement: 'Replacement',
      });
      expect(res.status()).toBe(201);

      const { role } = await res.json();
      expect(role.new_or_replacement).toBe('Replacement');
    });

    test('empty vacancy_reason array is accepted — this route does not enforce "at least one"', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const res = await authed(request, token).post('/api/roles', {
        title: `Test Role ${uid()}`,
        priority: 'P2',
        vacancy_reason: [],
      });
      expect(res.status()).toBe(201);

      const { role } = await res.json();
      expect(Array.isArray(role.vacancy_reason)).toBe(true);
      expect(role.vacancy_reason).toEqual([]);
    });
  });

  test.describe('PATCH /api/roles/:id', () => {

    test('vacancy_reason is fully replaced, not merged/appended', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);

      const createRes = await api.post('/api/roles', {
        title: `Test Role ${uid()}`,
        priority: 'P2',
        vacancy_reason: ['Resignation', 'New Project'],
      });
      expect(createRes.status()).toBe(201);
      const { role } = await createRes.json();

      const patchRes = await api.patch(`/api/roles/${role.id}`, {
        vacancy_reason: ['Other'],
      });
      expect(patchRes.status()).toBe(200);

      const getRes = await api.get(`/api/roles/${role.id}`);
      const { role: updated } = await getRes.json();
      expect(updated.vacancy_reason).toEqual(['Other']);
    });

    test('qualification_required updates via PATCH', async ({ request }) => {
      const token = await getToken(request, 'hr');
      const api   = authed(request, token);

      const createRes = await api.post('/api/roles', {
        title: `Test Role ${uid()}`,
        priority: 'P2',
        qualification_required: 'B.Tech',
      });
      expect(createRes.status()).toBe(201);
      const { role } = await createRes.json();

      const patchRes = await api.patch(`/api/roles/${role.id}`, {
        qualification_required: 'M.Tech',
      });
      expect(patchRes.status()).toBe(200);

      const getRes = await api.get(`/api/roles/${role.id}`);
      const { role: updated } = await getRes.json();
      expect(updated.qualification_required).toBe('M.Tech');
    });
  });
});
