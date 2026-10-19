// Sourcing module — constants, settings shape and the feature flag.
// Spec: docs/SourcingModule_PRD_v2.md

/** Today's channel vocabulary (identical to roles.recruitment_mode / candidates.source). Campus is deferred. */
export const SOURCING_CHANNELS = ['LinkedIn', 'Naukri/IIMjobs', 'Agency', 'Internal Referral', 'Direct Outreach'] as const;
export type SourcingChannel = typeof SOURCING_CHANNELS[number];

export const PORTAL_CHANNELS: readonly string[] = ['LinkedIn', 'Naukri/IIMjobs'];

export function isSourcingChannel(v: unknown): v is SourcingChannel {
  return typeof v === 'string' && (SOURCING_CHANNELS as readonly string[]).includes(v);
}

/** Master switch. Off ⇒ hooks no-op (no queries), routes answer `{ enabled:false }`/503, the UI hides itself. */
export function isSourcingEnabled(): boolean {
  return process.env.SOURCING_ENABLED === 'true';
}

export type QualifiedRule = 'either' | 'shortlisted' | 'scored';

export interface SourcingSettings {
  /** Roles approved on/after this IST date are expected to get a plan within 1 working day (PLAN_NOT_ACTIVATED). null ⇒ never raised. */
  go_live_date: string | null;
  /** Threshold detectors are provisional (is_shadow) until this IST date. null ⇒ they are live. */
  shadow_until: string | null;
  qualified_rule: QualifiedRule;
  /** How long a portal posting stays live (days) — provisional; Naukri ≈30 (secondary source), LinkedIn ≈30 (unverified). */
  portal_expiry_days: Record<string, number>;
  /** Renewal is due this many days before expected expiry. */
  renew_lead_days: number;
  agency_followup_days: number;      // provisional
  referral_repost_days: number;      // provisional
  /** First N weeks of a weekly outbound commitment run in baseline mode (actuals shown, no exceptions). */
  weekly_baseline_weeks: number;
  /** SOP: ≥5 qualified per rolling 7 days for open P0/P1 roles; breach when short on each of the last 5 working days. */
  volume_min_qualified: number;
  volume_window_days: number;
  volume_gap_working_days: number;
  referral_audience_email: string | null;
  /** Weekly exceptions summary goes to these (company addresses only). Empty ⇒ no weekly email. */
  digest_recipients: string[];
  /** Daily "what is due / overdue" email to the HR team (every active HR/Admin user, one message). Off until someone switches it on. */
  daily_digest_enabled: boolean;
}

export const DEFAULT_SOURCING_SETTINGS: SourcingSettings = {
  go_live_date: null,
  shadow_until: null,
  qualified_rule: 'either',
  portal_expiry_days: { 'LinkedIn': 30, 'Naukri/IIMjobs': 30 },
  renew_lead_days: 3,
  agency_followup_days: 7,
  referral_repost_days: 14,
  weekly_baseline_weeks: 4,
  volume_min_qualified: 5,
  volume_window_days: 7,
  volume_gap_working_days: 5,
  referral_audience_email: null,
  digest_recipients: [],
  daily_digest_enabled: false,
};

/** Merge stored key/value rows over the defaults, ignoring unknown keys and wrongly-typed values. */
export function mergeSettings(rows: Array<{ key: string; value: unknown }>): SourcingSettings {
  const out: SourcingSettings = { ...DEFAULT_SOURCING_SETTINGS, portal_expiry_days: { ...DEFAULT_SOURCING_SETTINGS.portal_expiry_days } };
  for (const { key, value } of rows) {
    switch (key) {
      case 'go_live_date':
      case 'shadow_until':
        if (value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))) out[key] = value as string | null;
        break;
      case 'digest_recipients':
        // Exception data is internal: only company mailboxes, so a typo can never send it outside.
        if (Array.isArray(value) && value.every(v => typeof v === 'string' && /^[^\s@]+@digitalpaani\.com$/i.test(v.trim()))) {
          out.digest_recipients = [...new Set((value as string[]).map(v => v.trim().toLowerCase()))];
        }
        break;
      case 'daily_digest_enabled':
        if (typeof value === 'boolean') out.daily_digest_enabled = value;
        break;
      case 'qualified_rule':
        if (value === 'either' || value === 'shortlisted' || value === 'scored') out.qualified_rule = value;
        break;
      case 'portal_expiry_days':
        if (value && typeof value === 'object') {
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (typeof v === 'number' && v > 0 && v <= 365) out.portal_expiry_days[k] = Math.round(v);
          }
        }
        break;
      case 'renew_lead_days':
      case 'agency_followup_days':
      case 'referral_repost_days':
      case 'weekly_baseline_weeks':
      case 'volume_min_qualified':
      case 'volume_window_days':
      case 'volume_gap_working_days':
        if (typeof value === 'number' && value >= 0 && value <= 365) out[key] = Math.round(value);
        break;
      case 'referral_audience_email':
        if (value === null || (typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) out.referral_audience_email = value as string | null;
        break;
      default: break;
    }
  }
  return out;
}

/** Keys the settings endpoint is allowed to write. */
export const WRITABLE_SETTING_KEYS = Object.keys(DEFAULT_SOURCING_SETTINGS);

/** Severity base by role priority (higher = more urgent). */
export const PRIORITY_SEVERITY: Record<string, number> = { P0: 40, P1: 30, P2: 20, P3: 10 };

export const OPEN_ROLE_STATUSES = ['Approved', 'Live – Sourcing'] as const;
export const CLOSED_ROLE_STATUSES = ['Closed – Filled', 'Closed – Cancelled'] as const;

/** `applications.sub_source` value stamped on a form application that arrived with no (or no usable) source tag. */
export const UNTAGGED_SOURCE = 'untagged_default';
/** A tag the applicant chose that is not one of our channels (e.g. "Other") — claimed attribution, kept distinct from untagged. */
export const OTHER_SOURCE = 'Other';

/**
 * Normalise the optional "How did you hear about this role?" answer the Apps Script forwards as `source_tag`.
 * A known channel (case/whitespace-insensitive) → its canonical spelling; blank/missing → UNTAGGED_SOURCE (so yield can
 * exclude it); anything else the applicant picked → OTHER_SOURCE. Never throws, never returns free text.
 */
export function normalizeSourceTag(raw: unknown): string {
  if (typeof raw !== 'string') return UNTAGGED_SOURCE;
  const t = raw.trim().replace(/\s+/g, ' ');
  if (!t) return UNTAGGED_SOURCE;
  const hit = (SOURCING_CHANNELS as readonly string[]).find(c => c.toLowerCase() === t.toLowerCase());
  return hit ?? OTHER_SOURCE;
}
