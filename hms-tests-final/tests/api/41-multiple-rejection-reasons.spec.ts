// ─────────────────────────────────────────────────────────────────────────────
// A rejection can carry SEVERAL reasons (2026-10-01). The API accepts
// `rejection_reason_cats: string[]` and stores them in the existing
// rejection_reason_cat column as one '; '-joined string, so the older
// single-string field — and everything that reads the column — keeps working.
// Backend rules live in backend/src/utils/rejectionReasons.ts (unit-tested there);
// this file checks them through the real route.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidateWithApp } from '../helpers/api';

async function freshApp(request: Parameters<typeof authed>[0]) {
  const token = await getToken(request, 'hr');
  const { application } = await createCandidateWithApp(request, token);
  return { api: authed(request, token), appId: application.id as string };
}
const stored = async (api: ReturnType<typeof authed>, appId: string) =>
  (await (await api.get(`/api/applications/${appId}`)).json()).application;

test.describe('Rejection with multiple reasons', () => {
  test('several reasons are stored together and the rejection succeeds', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    const res = await api.post(`/api/applications/${appId}/status`, {
      new_status: 'Rejected',
      rejection_reason_cats: ['Missing mandatory skill', 'Communication gap', 'Compensation mismatch'],
      rejection_reason_detail: 'Several gaps',
    });
    expect(res.status()).toBe(200);
    const app = await stored(api, appId);
    expect(app.status).toBe('Rejected');
    expect(app.rejection_reason_cat).toBe('Missing mandatory skill; Communication gap; Compensation mismatch');
    expect(app.rejection_reason_detail).toBe('Several gaps');
  });

  test('the older single-string field still works exactly as before', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    expect((await api.post(`/api/applications/${appId}/status`, { new_status: 'Rejected', rejection_reason_cat: 'Skills Mismatch' })).status()).toBe(200);
    expect((await stored(api, appId)).rejection_reason_cat).toBe('Skills Mismatch');
  });

  test('a one-item list is stored as just that reason', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    await api.post(`/api/applications/${appId}/status`, { new_status: 'Rejected', rejection_reason_cats: ['Short average tenure'] });
    expect((await stored(api, appId)).rejection_reason_cat).toBe('Short average tenure');
  });

  test('duplicates and blanks are dropped, whitespace is tidied', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    await api.post(`/api/applications/${appId}/status`, {
      new_status: 'Rejected', rejection_reason_cats: ['  Communication   gap ', '', 'communication gap', '   ', 'Short average tenure'],
    });
    expect((await stored(api, appId)).rejection_reason_cat).toBe('Communication gap; Short average tenure');
  });

  test('a semicolon inside a reason cannot break the format', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    await api.post(`/api/applications/${appId}/status`, { new_status: 'Rejected', rejection_reason_cats: ['Skills; experience gap', 'Other'] });
    expect((await stored(api, appId)).rejection_reason_cat).toBe('Skills, experience gap; Other');
  });

  test('an empty list is still "a reason is required" (400), and nothing changes', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    for (const body of [
      { new_status: 'Rejected', rejection_reason_cats: [] },
      { new_status: 'Rejected', rejection_reason_cats: ['', '  '] },
      { new_status: 'Rejected', rejection_reason_cats: [null, 7, {}] },
      { new_status: 'Rejected' },
    ]) {
      expect((await api.post(`/api/applications/${appId}/status`, body)).status()).toBe(400);
    }
    expect((await stored(api, appId)).status).toBe('Active');
  });

  test('the array wins when both forms are sent', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    await api.post(`/api/applications/${appId}/status`, { new_status: 'Rejected', rejection_reason_cat: 'ignored', rejection_reason_cats: ['Communication gap'] });
    expect((await stored(api, appId)).rejection_reason_cat).toBe('Communication gap');
  });

  test('a bulk-style reject of several applications with several reasons stores each one', async ({ request }) => {
    const token = await getToken(request, 'hr');
    const api = authed(request, token);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await createCandidateWithApp(request, token)).application.id);
    const results = await Promise.all(ids.map(id => api.post(`/api/applications/${id}/status`, {
      new_status: 'Rejected', rejection_reason_cats: ['Missing mandatory skill', 'Below experience threshold'],
    })));
    results.forEach(r => expect(r.status()).toBe(200));
    for (const id of ids) expect((await stored(api, id)).rejection_reason_cat).toBe('Missing mandatory skill; Below experience threshold');
  });

  test('withdrawal is unchanged: still needs a reason and still takes the single field', async ({ request }) => {
    const { api, appId } = await freshApp(request);
    expect((await api.post(`/api/applications/${appId}/status`, { new_status: 'Withdrawn' })).status()).toBe(400);
    expect((await api.post(`/api/applications/${appId}/status`, { new_status: 'Withdrawn', withdrawal_reason_cat: 'Accepted another offer' })).status()).toBe(200);
  });

  test('a Hiring Manager may still reject from Applied and Screened, with several reasons', async ({ request }) => {
    const hr = await getToken(request, 'hr');
    const { application } = await createCandidateWithApp(request, hr);
    const hm = authed(request, await getToken(request, 'hm_alex'));
    const res = await hm.post(`/api/applications/${application.id}/status`, { new_status: 'Rejected', rejection_reason_cats: ['Communication gap', 'Short average tenure'] });
    expect(res.status()).toBe(200);
  });
});
