import maleNamesData from '../data/indianMaleNames.json';
import femaleNamesData from '../data/indianFemaleNames.json';
import ambiguousNamesData from '../data/indianAmbiguousNames.json';

// ─── Candidate gender auto-tagging — first-name based, India-focused ──────────
//
// DATA SOURCE (2026-09-28 update): backend/src/data/indian{Male,Female,
// Ambiguous}Names.json — built from two public, real-world Indian-name
// datasets (github.com/mbejda's "Indian-Male-Names.csv" /
// "Indian-Female-Names.csv", ~14.8k and ~15.4k full-name rows respectively),
// merged with this module's own original hand-curated dictionary (several
// hundred names spanning North Indian, Sikh/Punjabi, Muslim, Bengali,
// Gujarati/Marathi, South Indian, Parsi, and Christian/Anglo-Indian naming
// conventions). See `backend/src/scripts/rebuildGenderNameData.ts` for the
// exact, re-runnable build process — regenerate the three JSON files there
// if either source dataset is ever updated or another one is added.
//
// CONFLICT RESOLUTION (this is the important part): a first name extracted
// from BOTH a male-labeled and a female-labeled row in the source data isn't
// automatically "wrong" — real Indian names genuinely cross gender lines
// more than most naming heuristics assume. The build process resolves this
// by comparing how often each name appears under each gender in the raw
// data: a strong majority (5x+ more common under one gender, with at least
// 5 total occurrences) tags that name to the majority gender; anything less
// lopsided — including every name this module's own earlier hand-curated
// dictionary listed as deliberately ambiguous (Kiran, Simran, Manpreet,
// Jaspreet, Harpreet, Gurpreet, Amandeep, Baljeet, Chandra, Krishna, and
// similar Sikh/Punjabi "-preet"/"-jeet"/"-deep" compounds) — goes into
// indianAmbiguousNames.json instead. A name in that file is checked FIRST
// and always returns null, even if it also happens to match the male/female
// dictionaries or a suffix heuristic below — ambiguous overrides everything.
//
// This module still uses a two-tier approach on top of that data:
//   1. The dictionary above (~3,860 male / ~3,230 female names) — the
//      primary, most reliable signal.
//   2. A SMALL set of high-confidence suffix heuristics for a name the
//      dictionary doesn't cover at all (e.g. "-ika"/"-ita"/"-ini" endings
//      are reliably feminine; "-esh"/"-endra"/"-eshwar" endings are reliably
//      masculine) — used only as a fallback, and deliberately conservative.
//
// What this deliberately does NOT do: force a guess on a name it isn't
// confident about. `null` ("Unknown") is a first-class result, not a bug —
// every call site (auto-tag on create, backfill script, UI) must treat it
// as a real, displayable state, filterable like M/F, never coerced to one
// or the other.
//
// This is inherently a heuristic, not a certainty — a name absent from the
// dictionary and not matching a suffix rule returns null, and even a
// dictionary hit can occasionally be wrong for an individual. Treat the
// resulting `candidates.gender` column as a best-effort tag for aggregate
// filtering/reporting, not a verified attribute — HR can always correct it
// manually (it's a plain editable field once set, not read-only).

export type Gender = 'M' | 'F';

const MALE_NAMES: ReadonlySet<string> = new Set(maleNamesData as string[]);
const FEMALE_NAMES: ReadonlySet<string> = new Set(femaleNamesData as string[]);
const KNOWN_AMBIGUOUS: ReadonlySet<string> = new Set(ambiguousNamesData as string[]);

// Titles/prefixes stripped before taking the first whitespace-separated
// token as the "first name" — full_name arrives as free text from forms/
// Excel imports and commonly carries one of these.
const TITLE_PREFIXES = [
  'mr', 'mrs', 'ms', 'miss', 'dr', 'er', 'eng', 'prof', 'shri', 'sri', 'smt',
  'kumari', 'md', 'mohd', 'mohammed', 'capt', 'col', 'major', 'adv', 'km',
];

export function extractFirstName(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  const tokens = fullName
    .trim()
    .split(/\s+/)
    .map(t => t.replace(/[.,]/g, ''))
    .filter(Boolean);

  let i = 0;
  while (i < tokens.length && TITLE_PREFIXES.includes(tokens[i].toLowerCase())) i++;
  const first = tokens[i];
  return first ? first.toLowerCase() : null;
}

// High-confidence suffix fallback for a name the dictionary doesn't cover at
// all — deliberately short. Applied only when the whole name isn't in the
// dictionary or the ambiguous set above.
const FEMININE_SUFFIXES = ['ika', 'itha', 'ita', 'ini', 'ee', 'aa'];
const MASCULINE_SUFFIXES = ['esh', 'endra', 'eshwar', 'eswar', 'endar', 'vardhan', 'kumar'];

function matchesSuffix(name: string, suffixes: string[]): boolean {
  return suffixes.some(s => name.endsWith(s));
}

// "Kaur" as a middle/surname token is checked FIRST, ahead of even the
// dictionary — Sikh women take it specifically and deliberately to signal
// their own gender (paired with "Singh" for men), so it's closer to a
// first-person declaration than a name-frequency guess, and empirically
// more reliable than this module's own dictionary: found via a real
// production record, "Amritpal Kaur" — "amritpal" is a genuinely unisex
// Sikh first name this dictionary (reasonably) defaults to male, but this
// specific person's own "Kaur" says otherwise, and that wins. Checked
// against real production data for a counter-example and found none — the
// only "Kaur" rows in the source male-names dataset were garbled data
// artifacts (a truncated multi-person entry containing the literal text
// "wife 35 yrs", an "@"-mangled row), not genuine male bearers.
//
// Deliberately NOT doing the mirror-image "Singh -> male": checked against
// this system's own real candidate data and found genuine, clean, unambiguous
// counter-examples — "Monika Singh", "Ankita Singh", "Pooja Singh", "Akanksha
// Singh" and others are real women in this system's own production data.
// Unlike "Kaur", "Singh" is ALSO an ordinary hereditary family surname across
// Hindu Rajput/Kshatriya communities, inherited by sons and daughters alike,
// completely independent of the Sikh gender-marking convention — so it's
// simply not a safe signal on its own, however tempting the parallel looks.
function hasKaurSurname(fullName: string): boolean {
  return fullName.toLowerCase().split(/\s+/).map(t => t.replace(/[.,]/g, '')).includes('kaur');
}

/**
 * Classifies a candidate's likely gender from their name. Returns null
 * ("Unknown") rather than guessing when nothing here is confident about it
 * — see the module header for why that's the deliberate, correct behavior
 * here, not a gap to close later.
 */
export function classifyGender(fullName: string | null | undefined): Gender | null {
  if (!fullName) return null;
  if (hasKaurSurname(fullName)) return 'F';

  const firstName = extractFirstName(fullName);
  if (!firstName) return null;

  if (KNOWN_AMBIGUOUS.has(firstName)) return null;
  if (MALE_NAMES.has(firstName)) return 'M';
  if (FEMALE_NAMES.has(firstName)) return 'F';

  // Suffix fallback — feminine checked first since it's the more reliable of
  // the two short lists; an unrecognized name matching neither returns null.
  if (matchesSuffix(firstName, FEMININE_SUFFIXES)) return 'F';
  if (matchesSuffix(firstName, MASCULINE_SUFFIXES)) return 'M';

  return null;
}
