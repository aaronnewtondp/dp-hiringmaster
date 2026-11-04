import { describe, it, expect, vi, beforeEach } from 'vitest';

// Settings are stored as key/value rows. What is under test: which writes are accepted or rejected, what is actually stored
// (normalised), and the go-live stamp. The database is answered from a canned in-memory table.
const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db/index.js', () => ({ query: (...a: unknown[]) => h.query(...a) }));

import { loadSettings, saveSettings, stampGoLiveDefaults, DEFAULT_SHADOW_DAYS } from './sourcingSettings.js';
import { DEFAULT_SOURCING_SETTINGS, WRITABLE_SETTING_KEYS } from '../utils/sourcingConfig.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
let table: Array<{ key: string; value: unknown }>;
let upserts: Array<{ key: string; value: unknown; by: string }>;

beforeEach(() => {
  table = [];
  upserts = [];
  h.query.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT key, value FROM sourcing_settings')) return table;
    if (sql.includes('INSERT INTO sourcing_settings (key, value, updated_by)')) {
      const [key, json, by] = params as [string, string, string];
      upserts.push({ key, value: JSON.parse(json), by });
      table = table.filter(r => r.key !== key).concat({ key, value: JSON.parse(json) });
      return [];
    }
    return [];
  });
});

describe('loadSettings', () => {
  it('an empty table gives the defaults', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SOURCING_SETTINGS);
  });

  it('stored rows are merged over the defaults and a bad stored value is ignored', async () => {
    table = [{ key: 'qualified_rule', value: 'scored' }, { key: 'volume_min_qualified', value: 'five' }, { key: 'nonsense', value: 1 }];
    const s = await loadSettings();
    expect(s.qualified_rule).toBe('scored');
    expect(s.volume_min_qualified).toBe(DEFAULT_SOURCING_SETTINGS.volume_min_qualified);
    expect(s).not.toHaveProperty('nonsense');
  });
});

describe('saveSettings (an invalid value is rejected, never stored and silently ignored on read)', () => {
  it('saves a valid value and reports it', async () => {
    const out = await saveSettings({ volume_min_qualified: 8 }, USER_ID);
    expect(out.saved).toEqual(['volume_min_qualified']);
    expect(out.rejected).toEqual([]);
    expect(out.settings.volume_min_qualified).toBe(8);
    expect(upserts).toEqual([{ key: 'volume_min_qualified', value: 8, by: USER_ID }]);
  });

  it('rejects a key that is not a setting, without a query', async () => {
    const out = await saveSettings({ drop_table: 1, __proto__: 'x' } as Record<string, unknown>, USER_ID);
    expect(out.saved).toEqual([]);
    expect(out.rejected).toEqual(['drop_table']);
    expect(upserts).toEqual([]);
  });

  it.each(['bogus', 'constructor', 'toString', 'hasOwnProperty'])(
    'an unknown or inherited key "%s" is rejected by name even when its value would round-trip as "nothing"', async key => {
      const out = await saveSettings({ [key]: undefined }, USER_ID);
      expect(out.rejected).toEqual([key]);
      expect(out.saved).toEqual([]);
      expect(upserts).toEqual([]);
    },
  );

  it.each([
    ['qualified_rule', 'sometimes'],
    ['volume_min_qualified', 400],
    ['volume_min_qualified', -1],
    ['volume_min_qualified', '5'],
    ['go_live_date', '14/10/2026'],
    ['go_live_date', 20261014],
    ['daily_digest_enabled', 'yes'],
    ['referral_audience_email', 'not an address'],
    ['digest_recipients', ['someone@example.test']],
    ['digest_recipients', 'hr@digitalpaani.com'],
  ])('rejects %s = %j and stores nothing', async (key, value) => {
    const out = await saveSettings({ [key]: value }, USER_ID);
    expect(out.rejected).toEqual([key]);
    expect(out.saved).toEqual([]);
    expect(upserts).toEqual([]);
  });

  it('a value equal to the default is accepted (it round-trips unchanged)', async () => {
    const out = await saveSettings({ qualified_rule: 'either', volume_min_qualified: 5 }, USER_ID);
    expect(out.saved).toEqual(['qualified_rule', 'volume_min_qualified']);
    expect(out.rejected).toEqual([]);
  });

  it('go-live and shadow dates accept a date, and null (meaning "live") is accepted and stored as null', async () => {
    const out = await saveSettings({ go_live_date: '2026-10-20', shadow_until: null }, USER_ID);
    expect(out.saved).toEqual(['go_live_date', 'shadow_until']);
    expect(upserts).toEqual([
      { key: 'go_live_date', value: '2026-10-20', by: USER_ID },
      { key: 'shadow_until', value: null, by: USER_ID },
    ]);
  });

  it('digest recipients are stored lower-cased and de-duplicated (what the read will use), not as typed', async () => {
    const out = await saveSettings({ digest_recipients: ['  HR@digitalpaani.com ', 'hr@digitalpaani.com', 'Digest.Test@DigitalPaani.com'] }, USER_ID);
    expect(out.saved).toEqual(['digest_recipients']);
    expect(upserts[0].value).toEqual(['hr@digitalpaani.com', 'digest.test@digitalpaani.com']);
    expect(out.settings.digest_recipients).toEqual(['hr@digitalpaani.com', 'digest.test@digitalpaani.com']);
  });

  it('an empty recipient list is valid (it switches the weekly e-mail off)', async () => {
    table = [{ key: 'digest_recipients', value: ['hr@digitalpaani.com'] }];
    const out = await saveSettings({ digest_recipients: [] }, USER_ID);
    expect(out.saved).toEqual(['digest_recipients']);
    expect(out.settings.digest_recipients).toEqual([]);
  });

  it('a partial portal_expiry_days is accepted as given (the merge over the defaults happens on read)', async () => {
    const out = await saveSettings({ portal_expiry_days: { LinkedIn: 45 } }, USER_ID);
    expect(out.saved).toEqual(['portal_expiry_days']);
    expect(upserts[0].value).toEqual({ LinkedIn: 45 });
    expect(out.settings.portal_expiry_days).toEqual({ 'LinkedIn': 45, 'Naukri/IIMjobs': 30 });
  });

  it('a mixed patch saves the valid keys, rejects the others, and lists both', async () => {
    const out = await saveSettings({ volume_min_qualified: 7, qualified_rule: 'nope', bogus: true, daily_digest_enabled: true }, USER_ID);
    expect(out.saved).toEqual(['volume_min_qualified', 'daily_digest_enabled']);
    expect(out.rejected).toEqual(['qualified_rule', 'bogus']);
    expect(out.settings).toMatchObject({ volume_min_qualified: 7, daily_digest_enabled: true, qualified_rule: 'either' });
  });

  it('an empty patch saves nothing and still returns the current settings', async () => {
    table = [{ key: 'volume_window_days', value: 10 }];
    const out = await saveSettings({}, USER_ID);
    expect(out.saved).toEqual([]);
    expect(out.rejected).toEqual([]);
    expect(out.settings.volume_window_days).toBe(10);
  });

  it('the upsert records who changed it and overwrites on conflict', async () => {
    await saveSettings({ renew_lead_days: 2 }, USER_ID);
    const call = h.query.mock.calls.find(c => String(c[0]).includes('INSERT INTO sourcing_settings'))!;
    expect(String(call[0])).toContain('ON CONFLICT (key) DO UPDATE');
    expect(String(call[0])).toContain('updated_by = EXCLUDED.updated_by');
    expect(call[1]).toEqual(['renew_lead_days', '2', USER_ID]);
  });

  it('every writable key is a real setting (the allow-list cannot drift from the defaults)', () => {
    expect([...WRITABLE_SETTING_KEYS].sort()).toEqual(Object.keys(DEFAULT_SOURCING_SETTINGS).sort());
  });
});

describe('stampGoLiveDefaults (first engine run: go live today, shadow for 6 weeks)', () => {
  it('shadow lasts 42 days', () => {
    expect(DEFAULT_SHADOW_DAYS).toBe(42);
  });

  it('stamps today and today + 42 days, and reports true when it inserted', async () => {
    h.query.mockResolvedValueOnce([{ key: 'go_live_date' }, { key: 'shadow_until' }]);
    expect(await stampGoLiveDefaults('2026-10-14')).toBe(true);
    const [sql, params] = h.query.mock.calls[0];
    expect(params).toEqual(['2026-10-14', '2026-11-25']);
    expect(String(sql)).toContain('ON CONFLICT (key) DO NOTHING');         // an admin's value, including an explicit null, is never overwritten
    expect(String(sql)).toContain("'go_live_date'");
    expect(String(sql)).toContain("'shadow_until'");
  });

  it('reports false when something was already set (nothing was inserted)', async () => {
    h.query.mockResolvedValueOnce([]);
    expect(await stampGoLiveDefaults('2026-10-14')).toBe(false);
  });

  it('counts calendar days across a month and year end', async () => {
    h.query.mockResolvedValueOnce([]);
    await stampGoLiveDefaults('2026-12-01');
    expect(h.query.mock.calls[0][1]).toEqual(['2026-12-01', '2027-01-12']);
  });
});
