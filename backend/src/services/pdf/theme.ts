/**
 * Shared brand constants for JD PDF generation.
 * Ported 1:1 from the digitalpaani-long-jd / digitalpaani-social-jd skill scripts
 * (jd_generator.py, social_generator.py) — colors and copy must stay byte-identical
 * to those references. See CLAUDE.md / ROADMAP.md Phase 3.
 */
import path from 'path';

export type JdVariant = 'tech' | 'infra';

export type WhyIconKey =
  | 'pay' | 'impact' | 'growth' | 'team' | 'startup'
  | 'mission' | 'domain' | 'influence' | 'ownership' | 'learn';

export const WHY_ICON_KEYS: WhyIconKey[] = [
  'pay', 'impact', 'growth', 'team', 'startup',
  'mission', 'domain', 'influence', 'ownership', 'learn',
];

// ── Long-form JD colors (jd_generator.py) ───────────────────────────────────
export const LONG_JD_COLORS = {
  navy: '#0a1f3d',
  accent: '#0099cc',
  teal: '#00a8a0',
  lightBlue: '#e4f2fb',
  lightGreen: '#e2f5ec',
  border: '#d0e4ef',
  text: '#1c2b3a',
  muted: '#5e7591',
  bodyTxt: '#344a5e',
  tagBlue: '#d9eefc',
  tagBlueTxt: '#0077a8',
  tagGreen: '#d8f5e8',
  tagGreenTxt: '#00694a',
  headerTech: ['#eef6ff', '#e0f0fb'] as [string, string],
  headerInfra: ['#edfaf4', '#ddf2ea'] as [string, string],
  headerRunningText: '#88a0b9',
  footerRunningText: '#a8bed4',
  metaDivider: '#c5dde8',
  bulletSeparator: '#eef3f7',
  highlightText: '#0d3b6e',
};

// ── Social JD colors (social_generator.py) ──────────────────────────────────
export const SOCIAL_JD_COLORS = {
  navy: '#0a1f3d',
  navyLight: '#0d2847',
  teal: '#00c2cb',
  lightGreen: '#e2f5ec',
  tagBlue: '#d9eefc',
  tagBlueTxt: '#0077a8',
  tagGreen: '#d8f5e8',
  tagGreenTxt: '#00694a',
  taglineText: '#e8f4f9',
  metaDivider: '#88a0b9',
  footerLine1: '#b8d4e0',
};

// Icon fill colors, fixed regardless of variant (both scripts)
export const ICON_COLORS = {
  pin: '#e74c3c',
  building: '#3498db',
  grad: '#9b59b6',
  tag: '#27ae60',
};

// Why2x2 circle-icon background colors (jd_generator.py WHY_ICON_FN)
export const WHY_ICON_BG: Record<WhyIconKey, string> = {
  pay: '#f39c12',
  impact: '#27ae60',
  growth: '#3498db',
  team: '#9b59b6',
  startup: '#e74c3c',
  mission: '#1abc9c',
  domain: '#8e44ad',
  influence: '#2980b9',
  ownership: '#e67e22',
  learn: '#16a085',
};

// Fixed "About DigitalPaani" bullets — identical across every JD in the source,
// not per-role content.
export const ABOUT_DP_BULLETS: string[] = [
  'Building the future of water — helping meet up to <b>80% of urban water needs</b>',
  "<b>75% of wastewater facilities don't work properly</b> — we're fixing that with our AI-powered IoT operations intelligence platform",
  'Awarded by <b>Cartier, World Economic Forum, Niti Aayog, Forbes</b>',
  'Backed by leading VCs in India and US such as <b>3one4 Elemental Excelerator</b> (first Asian portfolio company)',
  'Trusted by <b>85+ facilities</b> including Amazon, Silicon Valley Clean Water, Tata Power, Taj Hotels, and Delhi Jal Board',
];

// Fixed social-card tagline and CTA — identical across the source's examples,
// not per-role content. Per the plan, the CTA intentionally uses the one
// general application form (not the JD6/JD7-specific one) until Phase 4
// candidate ingestion replaces Google Forms entirely.
export const SOCIAL_TAGLINE = 'Join us to solve water scarcity and climate problems at scale';
export const APPLICATION_FORM_URL = 'https://forms.gle/nxMot1ixC6oF5MEa9';
export const LONG_JD_FOOTER_NOTE = `Interested? Fill the Google form link to apply — <b>${APPLICATION_FORM_URL}</b>`;
export const SOCIAL_FOOTER_LINE1 = 'Interested? Fill the Google form to apply';

export const HEADER_TAGLINE = 'CAREERS · 2026';
export const FOOTER_CONTACT = 'hr@digitalpaani.com  ·  www.digitalpaani.com';

/** department/title keyword match → header gradient variant (jd_generator.py picks this by hand per role; here it's deterministic) */
export function classifyVariant(department?: string | null, title?: string | null): JdVariant {
  const haystack = `${department ?? ''} ${title ?? ''}`.toLowerCase();
  const techKeywords = ['tech', 'engineering', 'backend', 'frontend', 'product', 'design', 'software', 'data'];
  return techKeywords.some(kw => haystack.includes(kw)) ? 'tech' : 'infra';
}

// Project compiles as CommonJS (see backend/tsconfig.json) — __dirname is the
// right way to resolve this, not import.meta.url.
export const LOGO_PATH = path.join(__dirname, '../../assets/dp_logo_white.png');
