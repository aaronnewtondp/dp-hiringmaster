import { query } from '../db/index.js';
import { mergeSettings, SourcingSettings, WRITABLE_SETTING_KEYS } from '../utils/sourcingConfig.js';
import { addCalendarDays } from '../utils/workingDays.js';

/** Threshold detectors stay provisional for this long after the module is first switched on (PRD: 4–6 weeks). */
export const DEFAULT_SHADOW_DAYS = 42;

export async function loadSettings(): Promise<SourcingSettings> {
  const rows = await query<{ key: string; value: unknown }>('SELECT key, value FROM sourcing_settings');
  return mergeSettings(rows);
}

/**
 * Upsert only known keys whose value survives mergeSettings' validation — an invalid value is rejected
 * (returned in `rejected`) rather than silently stored and then ignored on read.
 */
export async function saveSettings(
  patch: Record<string, unknown>, userId: string,
): Promise<{ saved: string[]; rejected: string[]; settings: SourcingSettings }> {
  const saved: string[] = [];
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!WRITABLE_SETTING_KEYS.includes(key)) { rejected.push(key); continue; }
    const probe = mergeSettings([{ key, value }]) as unknown as Record<string, unknown>;
    const probeDefault = mergeSettings([]) as unknown as Record<string, unknown>;
    // mergeSettings falls back to the default for an invalid value and may normalise a valid one (lower-casing e-mail
    // addresses, merging a partial portal_expiry_days over the defaults). Accept when it round-trips unchanged OR when it
    // visibly changed something; an invalid value does neither.
    const accepted = JSON.stringify(probe[key]) === JSON.stringify(value)
      || JSON.stringify(probe[key]) !== JSON.stringify(probeDefault[key]);
    if (!accepted) { rejected.push(key); continue; }
    const toStore = key === 'digest_recipients' ? probe[key] : value;
    await query(
      `INSERT INTO sourcing_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(toStore), userId],
    );
    saved.push(key);
  }
  return { saved, rejected, settings: await loadSettings() };
}

/**
 * The first time the engine runs with the module enabled, stamp "go live = today" and "shadow until = today + 6 weeks".
 * Without this a bare SOURCING_ENABLED=true would make every threshold detector live on day one (7 of 9 P0/P1 roles
 * would trip VOLUME_GAP immediately). DO NOTHING on conflict: a value an admin has set — including an explicit null,
 * meaning "live" — is never overwritten, and concurrent first runs cannot disagree. Returns true if it stamped.
 */
export async function stampGoLiveDefaults(today: string): Promise<boolean> {
  const rows = await query<{ key: string }>(
    `INSERT INTO sourcing_settings (key, value) VALUES ('go_live_date', to_jsonb($1::text)), ('shadow_until', to_jsonb($2::text))
     ON CONFLICT (key) DO NOTHING RETURNING key`,
    [today, addCalendarDays(today, DEFAULT_SHADOW_DAYS)]);
  return rows.length > 0;
}
