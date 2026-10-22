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

// ── Social JD colors ────────────────────────────────────────────────────────
// The social JD was redesigned on 2026-10-22 (first shipped for R019) and is no
// longer a port of the digitalpaani-social-jd skill's social_generator.py — it
// follows DigitalPaani Brand Book v7. Chip colours are the long-standing blue/
// green skill blocks, deliberately unchanged.
export const SOCIAL_COLORS = {
  navy: '#002454',
  navyMid: '#193650',
  tealLt: '#95CFD3',      // brand "Teal · decorative" — large fills, linework, labels
  rustLt: '#E8845A',      // brand "Rust · light" — the single warm emphasis
  white: '#FFFFFF',
  chipBlueBg: '#d9eefc',
  chipBlueTx: '#0077a8',
  chipGreenBg: '#d8f5e8',
  chipGreenTx: '#00694a',
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

// Fixed social-card copy. Per the 2026-10-22 template decision, EVERYTHING above
// the role block (the three-line hook and the two-sentence intro) is identical on
// every role's social JD; only what comes after the role block adapts to the role.
// Edit the hook here and every future social JD follows. The hook is Mansi's
// "topliner" (22 Oct): her first three sentences are the three hook lines, her
// fourth ("Help us scale this story up.") is the bold ask under the intro's fact line. A hook line
// must end left of HOOK_MAX_RIGHT (socialJdLayout.ts) — the renderer warns and a
// test fails if a longer line is ever put here.
export const SOCIAL_HOOK_MUTED = ['We\u2019re running out of water.', 'Our rivers are polluted.'];
export const SOCIAL_HOOK_PUNCH = { lead: 'We have the technology to ', accent: 'solve it.' };
export const SOCIAL_INTRO_FACT = 'We run AI-powered water infrastructure across 100+ sites in India.';
export const SOCIAL_INTRO_ASK = 'Help us scale this story up.';
export const SOCIAL_NOW_HIRING = 'NOW HIRING';
export const SOCIAL_ROLE_EYEBROW = 'THE ROLE';
export const SOCIAL_COL_HEADINGS = { job: 'The Job', you: 'Who You Are' };
export const SOCIAL_CTA_TEXT = 'Think it\u2019s you? Apply.';
export const SOCIAL_YOU_ARE_HERE = 'YOU ARE HERE';
export const APPLICATION_FORM_URL = 'https://forms.gle/nxMot1ixC6oF5MEa9';
export const LONG_JD_FOOTER_NOTE = `Interested? Fill the Google form link to apply — <b>${APPLICATION_FORM_URL}</b>`;
// Social JD apply link. A second short link to the SAME Google Form as
// APPLICATION_FORM_URL (both resolve to one form id — verified 2026-10-22);
// the social JD uses this one because it is the link chosen for the R019 relaunch.
export const SOCIAL_APPLY_URL = 'https://forms.gle/boTsnrtPUt5WZ7Y49';

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
