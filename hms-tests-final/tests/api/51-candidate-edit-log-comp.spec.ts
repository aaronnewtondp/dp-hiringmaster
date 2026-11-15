// GET /api/candidates/:id/edit-log used to return the raw log rows to every persona, so a Hiring Manager could read the old and new
// values of compensation fields that GET /api/candidates/:id hides from them. Now compensation rows follow the same rule as the candidate's
// own CTC fields: HR-tier sees all; a Hiring Manager only when named on a role the candidate has an application on.
import { test, expect } from '@playwright/test';
import { getToken, authed, createCandidate, SEEDED } from '../helpers/api';

const COMP = ['current_ctc_fixed', 'current_ctc_variable', 'current_esops', 'expected_ctc'];
const fields = (logs: Array<{ field_name: string }>) => logs.map(l => l.field_name);

test.describe('candidate edit-log: compensation rows', () => {
  test('HR sees them; the Hiring Manager named on the candidate\'s role sees them; any other Hiring Manager sees only the rest', async ({ request }) => {
    const hr = await getToken(request, 'hr');
    // R006 (Senior Product Manager) is Alex's role in the seed; Satyadev is not named on it.
    const { candidate } = await createCandidate(request, hr, { role_id: SEEDED.roles.senior_pm });
    const patch = await authed(request, hr).patch(`/api/candidates/${candidate.id}`, { expected_ctc: 1850000, notice_period_days: 45 });
    expect(patch.status()).toBe(200);

    const read = async (who: 'hr' | 'hm_alex' | 'hm_satyadev') => {
      const res = await authed(request, await getToken(request, who)).get(`/api/candidates/${candidate.id}/edit-log`);
      expect(res.status(), who).toBe(200);
      return fields((await res.json()).logs);
    };
    const asHr = await read('hr');
    expect(asHr).toEqual(expect.arrayContaining(['expected_ctc', 'notice_period_days']));
    const asAlex = await read('hm_alex');
    expect(asAlex).toEqual(expect.arrayContaining(['expected_ctc', 'notice_period_days']));
    const asOther = await read('hm_satyadev');
    expect(asOther).toContain('notice_period_days');
    expect(asOther.filter(f => COMP.includes(f))).toEqual([]);
  });
});
