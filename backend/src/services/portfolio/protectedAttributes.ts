// LIGHT — pure functions, no I/O, safe to import from the main API. Everything that keeps the marketing reviewer blind to
// WHO the candidate is, in both directions:
//   - what goes IN to the model: redactPersonalStatements() (the PHRASES that state an attribute, a contact detail, and the number in
//     "12 years of experience"), maskNameTokens() (the candidate's own name, including inside URL slugs and handles, without corrupting
//     other people's credit lines), and candidateNameSignal() (a three-state hint computed in code, so the model never needs the name
//     to judge attribution);
//   - what comes OUT: filterProtectedAttributes() / findProtectedAttribute(), the backstop that drops any free-text
//     string that still states a protected attribute of the person or carries an e-mail address or phone number.
// The reviewer is told never to infer or mention a candidate's gender, age, ethnicity, religion, caste, nationality, marital
// or family status, pregnancy, disability or appearance, and never to repeat contact details. This file checks it.
// findProtectedAttribute() and filterProtectedAttributes() keep the names, arguments and result shapes of the first implementation
// (which lived in rubric.marketing.ts), so that module can simply re-export them.
//
// WHAT IT DROPS: a free-text string that makes a statement ABOUT THE PERSON, and any string with an e-mail address or a
// phone number. "A statement about the person" is recognised by shape, never by a bare word:
//   - a subject (candidate / she / he / the presenter ...) + a linking verb + an attribute ("candidate appears to be a young woman");
//   - a hedge + an attribute ("probably married", "likely in his 40s", "likely in their 40s");
//   - phrasings that are only ever about a person ("35 years old", "age of 34", "in her 40s", "her husband", "maternity leave",
//     "good-looking presenter", "based on her name", "Gender: female", "36F", "she/her", "has a disability", "heavy accent");
//   - the same in Hindi / Hinglish (Roman and Devanagari word lists) and with the usual obfuscation.
// WHAT IT KEEPS: a word that is merely the CONTENT of the work ("Women's Day campaign", "gender-equality campaign",
// "Muslim-owned small businesses", "senior-citizen outreach", "Diwali festive campaign", "women aged 25-40"), and a statement whose
// subject is somebody else in the work: a client, the cast, an influencer, a persona, a host or founder shown in a client case
// study, an analytics line ("Gender: 54% female, 46% male"), an HR-policy topic ("Maternity leave policy campaign").
//
// HOW THE THIRD-PARTY CALL IS MADE (per clause, never per document): a clause that names a third party (featured / client /
// case study / influencer / persona / "whose" / "the candidate hired" ...) is skipped by the subject-based rules UNLESS it also makes
// the candidate itself the subject ("The candidate is a woman who works with clients" is still dropped). The rules that are about the
// candidate by their own wording (a "female candidate", "Candidate: female", "the candidate's gender", "based on her name") never
// look at that. A bare "She is a woman." is a statement about the person, with or without a cue elsewhere in the text. Three refinements
// (fix round 4, after a review showed all 95 first-person statements leaking once a sentence also said "clients"):
//   - a MATCH that is the writer's own words still counts in a clause that names a third party: it contains "I" / "my" / "myself"
//     ("I am a Hindu woman and I have worked with clients"), a Hinglish "main ... hoon", or it is a lead-in right beside the writer's "I"
//     ("As a married woman I know what the audience wants", "A Christian by faith, I still ran the campaign for a client");
//   - a cue word later in the sentence does not shield a statement before it: the sentence is read statement by statement (cut at
//     and / but / aur / toh / lekin / since / because / which ...) up to the first one that names a third party, and what follows
//     that point goes on about them ("The film follows a farmer and her husband" stays);
//   - a bare "my" is NOT the writer speaking about themself when the clause names a client ("My clients' founder is a woman").
//
// LIMITS (a backstop, not a classifier; a dropped highlight costs little, a leaked inference costs more, so the
// patterns lean towards dropping when the shape is clearly a statement about a person):
//   - Measured on wording nobody tuned to (fix round 4): 60% of 60 leaks on the first set, 87.5% of 40 on the second, 0 of 60 keeps changed
//     on the first and 1 of 40 on the second (a talent's age in the work). Expect roughly 85-90% on new wording, not 100%.
//   - A personal fragment in a comma list that also names a client ("Mother of two, Hindu, worked with 30 clients") is read as being about the
//     client; commas are not cut for the third-party test because "Featuring Meera, mother of two, a farmer" is the same shape. The candidate's
//     own name is not a cue either: "Priya is a mother of two who has worked with 30 clients" on the candidate's own site is not recognised.
//   - A noun-only bio piece ("Wife | Mom | Marketer", "Hindu. Mother. Marketer.") is recognised only between real delimiters (a pipe, a bullet,
//     a line break, a full stop, a comma after the first piece), never in a fragment cut out of a sentence.
//   - A bare pronoun is not an attribute statement: "She led five campaigns" is kept (the prompt says "the candidate").
//   - FIRST PERSON counts (the candidate writes about themselves): "I'm 38", "I am married", "my husband", "my kids", "as a Muslim woman",
//     "being a single father", "I recently got married", "in my 40s", "I'm a 33 year old brand manager", and the Hinglish "main ek single mom hoon".
//   - Anything outside the word lists is not caught, and neither is an inference worded in some other way. Languages other than
//     English, Hindi and Hinglish are NOT covered (Tamil, Marathi, Bengali, Telugu in Roman script were measured: not recognised).
//   - A city, a state or a college is NOT masked (decision, 2026-10-22): where someone is based or studied is legitimately part of
//     portfolio text ("Mumbai launch", "NID alumnus") and is not a protected attribute.
//   - Obfuscation handled: letter case, full-width and compatibility characters, accents, zero-width / bidi / tag characters,
//     Cyrillic / Greek / small-capital look-alike letters, a word spelled with separators between 4+ single letters ("m a r r i e d",
//     "w-o-m-a-n"; a lone leading "a" or "i" is read both ways), a word with one stray separator ("fe-male", "wo man"), digits for
//     letters ("wom4n"), Devanagari / Arabic-Indic digits, written-out e-mail addresses ("jane [at] x [dot] com", "jane . doe @ gmail . com")
//     and spelled-out phone digits ("nine eight seven six ..."). Not handled: text split across array elements, images.
//   - A subject plus an attribute word drops the string even when the word modifies a topic ("She is a Hindu festival
//     expert"); a hedge alone needs the attribute to end the clause ("probably young women" and "likely male audience" are kept).
//   - Phone numbers: 10-15 digits with at most two separator characters between digits (a run of 4-digit years is not
//     one); an unformatted 10+ digit figure ("12000000000") is read as a phone number. A "+" prefix needs only 8 digits.
//   - Only the first 20,000 characters of a string are examined by findProtectedAttribute; redactPersonalStatements walks a
//     long text in windows so that nothing past that point escapes it.
import { stripInvisible } from './injection.js';

// ─── Normalisation ───────────────────────────────────────────────────────────

const SCAN_LIMIT = 20_000;

// Letters of other scripts that read as a Latin one (applied after lower-casing). Code points, so the table survives any editor.
const LOOKALIKES: Record<string, number[]> = {
  a: [0x0430, 0x03b1, 0x1d00],
  b: [0x044c, 0x03b2, 0x0299],
  c: [0x0441, 0x03f2, 0x1d04],
  d: [0x0501, 0x1d05],
  e: [0x0435, 0x0451, 0x03b5, 0x0454, 0x1d07],
  f: [0xa730],
  g: [0x0261, 0x0262],
  h: [0x043d, 0x04bb, 0x029c],
  i: [0x0456, 0x0457, 0x03b9, 0x0131, 0x026a],
  j: [0x0458, 0x03f3, 0x1d0a],
  k: [0x043a, 0x03ba, 0x1d0b],
  l: [0x04cf, 0x029f],
  m: [0x043c, 0x1d0d],
  n: [0x043f, 0x03b7, 0x0274],
  o: [0x043e, 0x03bf, 0x1d0f],
  p: [0x0440, 0x03c1, 0x1d18],
  q: [0x051b],
  r: [0x0433, 0x0280],
  s: [0x0455, 0xa731],
  t: [0x0442, 0x03c4, 0x1d1b],
  u: [0x03c5, 0x1d1c],
  v: [0x03bd, 0x0475, 0x1d20],
  w: [0x051d, 0x03c9, 0x0461, 0x1d21],
  x: [0x0445, 0x03c7],
  y: [0x0443, 0x03b3, 0x04af, 0x028f],
  z: [0x1d22],
};
const LOOKALIKE_MAP = new Map<string, string>();
for (const [latin, cps] of Object.entries(LOOKALIKES)) for (const cp of cps) LOOKALIKE_MAP.set(String.fromCodePoint(cp), latin);
const LOOKALIKE_RE = new RegExp(`[${[...LOOKALIKE_MAP.keys()].join('')}]`, 'gu');
// Latin combining accents only: a blanket \p{M} strip would also delete every Devanagari vowel sign.
const COMBINING_RE = new RegExp('[\\u0300-\\u036f]', 'g');
const DASH_RE = new RegExp('[\\u2010-\\u2015\\u2212]', 'g');
const QUOTE_RE = new RegExp('[\\u2018\\u2019\\u02bc\\u0060\\u00b4]', 'g');
const NON_ASCII_DIGIT_RE = /\p{Nd}/gu;

const digitCache = new Map<string, string>();
/** The ASCII digit a Unicode decimal digit stands for (Devanagari, Arabic-Indic, ...): its distance from the block's zero, mod 10. */
function digitOf(ch: string): string {
  if (ch >= '0' && ch <= '9') return ch;
  const cached = digitCache.get(ch);
  if (cached !== undefined) return cached;
  const cp = ch.codePointAt(0) as number;
  let n = 0;
  while (n < 60 && /\p{Nd}/u.test(String.fromCodePoint(cp - n - 1))) n++;
  const d = String(n % 10);
  digitCache.set(ch, d);
  return d;
}

/** NFKC + invisible characters removed + lower case + look-alikes folded + accents stripped + ASCII digits + one kind of quote/dash + collapsed whitespace (newlines kept). */
function foldText(raw: string): string {
  const s = raw.length > SCAN_LIMIT ? raw.slice(0, SCAN_LIMIT) : raw;
  let t = stripInvisible(stripInvisible(s).normalize('NFKC')).toLowerCase()
    .replace(LOOKALIKE_RE, ch => LOOKALIKE_MAP.get(ch) ?? ch)
    .normalize('NFD').replace(COMBINING_RE, '').normalize('NFC');
  if (/[^\x00-\x7f]/.test(t)) t = t.replace(NON_ASCII_DIGIT_RE, digitOf);
  t = t.replace(DASH_RE, '-').replace(QUOTE_RE, '\'')
    .replace(/\b(she|he|who)'s\b/g, '$1 is').replace(/\b(they)'re\b/g, '$1 are').replace(/\bi'm\b/g, 'i am').replace(/\bi've\b/g, 'i have')
    .replace(/[^\S\n]+/g, ' ').replace(/ ?\n[ \n]*/g, '\n').trim();
  return t;
}

// A word spelled with separators between single letters ("m a r r i e d", "m.a.r.r.i.e.d", "w-o-m-a-n"). A lone leading "a" or "i"
// is also a word of its own ("is a w-o-m-a-n"), so the run is read both ways.
const SPACED_LETTERS_RE = /(?<![a-z0-9])(?:[a-z][ ._*-]){3,}[a-z](?![a-z0-9])/g;
function joinSpaced(t: string, leadingWordApart: boolean): string {
  return t.replace(SPACED_LETTERS_RE, run => {
    const letters = run.replace(/[ ._*-]/g, '');
    return leadingWordApart && /^[ai]/.test(letters) && letters.length > 4 ? `${letters[0]} ${letters.slice(1)}` : letters;
  });
}

// A key word with a stray separator inside it: "fe-male", "wo man", "mar.ried". Only words that cannot occur split in ordinary prose.
const REASSEMBLED_WORDS = ['female', 'woman', 'muslim', 'hindu', 'christian', 'married', 'pregnant', 'brahmin', 'disabled', 'divorced', 'lesbian', 'transgender', 'catholic', 'buddhist', 'widowed'];
const REASSEMBLED_RE = new RegExp(`(?<![a-z])(?:${REASSEMBLED_WORDS.map(w => [...w].join('[ ._*-]?')).join('|')})(?![a-z])`, 'g');
function reassemble(t: string): string {
  return t.replace(REASSEMBLED_RE, m => m.replace(/[ ._*-]/g, ''));
}

// "wom4n", "m4rried", "h1ndu": inside a word that also has letters, a digit or @/$ stands for the letter it imitates. An extra reading
// of the text only: it can add a match ("q4" -> "qa" changes nothing that matters), never remove one.
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
function leetFold(t: string): string {
  return t.replace(/[a-z013457@$]{4,}/g, tok => (/[a-z].*[a-z]/.test(tok) ? tok.replace(/[013457@$]/g, c => LEET[c] as string) : tok));
}

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  shunya: '0', ek: '1', do: '2', teen: '3', char: '4', chaar: '4', paanch: '5', panch: '5', chhe: '6', chhah: '6', saat: '7', aath: '8', nau: '9',
};
const DIGIT_WORD_RUN_RE = new RegExp(`(?<![a-z])(?:(?:${Object.keys(DIGIT_WORDS).join('|')})(?![a-z])[\\s,.\\-/]*){8,}`, 'g');
/** "nine eight seven six ..." -> "9 8 7 6 ...", only for a run of eight or more digit words. */
function digitWordsToNumerals(t: string): string {
  return t.replace(DIGIT_WORD_RUN_RE, m => m.replace(/[a-z]+/g, w => DIGIT_WORDS[w] ?? w).replace(/[\s,.\-/]+/g, ' '));
}

// Markdown emphasis and wrapping punctuation around a word ("is a *woman*", "is (female)", 'is "married"', "m_a_r_r_i_e_d").
function unmarked(t: string): string {
  return t.replace(/[*_~`"()[\]{}]+/g, '');
}

/** The base reading plus each deobfuscated reading that differs from it (statements only). */
function readings(base: string): string[] {
  const out = [base];
  const add = (s: string) => { if (!out.includes(s)) out.push(s); };
  add(joinSpaced(base, false));
  add(joinSpaced(base, true));
  add(reassemble(base));
  add(leetFold(base));
  add(unmarked(base));
  return out;
}

// ─── Contact details ─────────────────────────────────────────────────────────

const EMAIL_RE = /(?<![a-z0-9._%+-])[a-z0-9._%+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+/;
const EMAIL_WRITTEN_RE = new RegExp(
  '(?<![a-z0-9._%+-])[a-z0-9._%+-]{1,64}\\s*(?:\\[\\s*at\\s*\\]|\\(\\s*at\\s*\\)|\\{\\s*at\\s*\\}|<\\s*at\\s*>)\\s*[a-z0-9-]{1,63}'
  + '(?:\\s*(?:\\[\\s*dot\\s*\\]|\\(\\s*dot\\s*\\)|\\{\\s*dot\\s*\\}|\\.)\\s*[a-z0-9-]{1,63}){1,4}');
// "jane dot doe at gmail dot com" / "jane at example dot com"
const EMAIL_WORDS_RE = /(?<![a-z0-9._%+-])[a-z0-9_%+-]{1,64}(?:\s+dot\s+[a-z0-9_%+-]{1,64}){0,3}\s+at(?:\s+the\s+rate(?:\s+of)?)?\s+[a-z0-9-]{1,63}(?:\s+dot\s+[a-z0-9-]{1,63}){0,3}\s+dot\s+[a-z]{2,}\b/;
// "jane . doe @ gmail . com": spaces around the dots of the domain (so "Your @digitalpaani.com account" and "Follow @ digitalpaani. Great
// work" are not addresses), ending in a real top-level domain. "jane.doe @ gmail.com" (spaces only around the @) counts when the local part
// itself looks like one (it has a dot or an underscore), so "Join us @ studio.in" is not an address either.
const TLD = '(?:com|in|org|net|co|io|edu|gov|ai|me|biz|info|uk|us|design|studio|agency|app|dev|tech|online|xyz)';
const EMAIL_SPACED_RE = new RegExp(`(?<![a-z0-9._%+-])[a-z0-9._%+-]{1,64}(?:\\s+\\.\\s+[a-z0-9._%+-]{1,64}){0,3}\\s*@\\s*[a-z0-9-]+(?:\\s*\\.\\s*[a-z0-9-]+){0,3}\\s+\\.\\s*${TLD}(?![a-z])`);
const EMAIL_SPACED_AT_RE = new RegExp(`(?<![a-z0-9._%+-])[a-z0-9_%+-]{1,30}[._][a-z0-9._%+-]{1,30}\\s+@\\s+[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.${TLD}(?![a-z])`);
const PHONE_INTL_RE = /\+[\s(]*\d(?:[\s().-]{0,2}\d){7,14}(?!\d)/;
const PHONE_RUN_RE = /(?<!\d)\d(?:[\s().-]{0,2}\d){9,14}(?!\d)/g;

function hasPhoneNumber(t: string): boolean {
  if (PHONE_INTL_RE.test(t)) return true;
  for (const m of t.matchAll(PHONE_RUN_RE)) {
    const digits = m[0].replace(/\D/g, '').length;
    if (digits < 10 || digits > 15) continue;
    const chunks = m[0].split(/\D+/).filter(Boolean);
    if (chunks.every(c => c.length === 4 && +c >= 1900 && +c <= 2099)) continue;   // "2021 2022 2023", not a number
    return true;
  }
  return false;
}

function findContact(t: string): 'email' | 'phone' | null {
  if (EMAIL_RE.test(t) || EMAIL_WRITTEN_RE.test(t) || EMAIL_WORDS_RE.test(t) || EMAIL_SPACED_RE.test(t) || EMAIL_SPACED_AT_RE.test(t)) return 'email';
  if (hasPhoneNumber(t)) return 'phone';
  const spelled = digitWordsToNumerals(t);
  if (spelled !== t && hasPhoneNumber(spelled)) return 'phone';
  return null;
}

// ─── Statements about a person ───────────────────────────────────────────────
// A term must stand alone: not glued to a word or hyphen (woman-led, Muslim-owned) and not a possessive (women's).
const B = '(?<![\\w-])';
const E = '(?![\\w-]|\'s\\b)';
// Words that are also names or ordinary words need something sentence-like after them.
const GUARD = '(?=\\s*(?:[.,;:!?)]|$)|\\s+(?:and|but|or|with|from|by|family|background|woman|man|girl|boy|lady|guy|female|male|mother|father|community|faith|household|upbringing|origin|vegetarian|vegan|national|citizen)\\b)';
// "as a woman, she ..." / "being a Hindu who ...": the attribute has to end its phrase or lead into the person it describes.
const GUARD_AS = '(?=\\s*(?:[.,;:!?)]|$)|\\s+(?:and|but|or|with|from|by|in|of|who|she|he|they|i|we|my|our|myself|herself|himself|working|leading|running|doing|raising|managing|balancing)\\b|\\s+(?:leader|professional|founder|marketer|entrepreneur|executive|creative|manager|director|head|designer|writer|strategist|storyteller|creator|candidate|applicant|person|individual|lead|student|graduate|immigrant|citizen|vegetarian|vegan|teacher|doctor|engineer|artist|daughter|son|wife|husband)\\b)';

const GENDER = '(?:woman|man)(?!\\s+of\\s+(?:few|many|great|his|her|action|honou?r|faith|steel|vision|substance|letters|ideas|principles?|words|the\\s+(?:people|world|house|moment|hour|match)))|female|male|lady|girl|boy|guy|gentleman|transgender|trans(?![\\w-])|trans\\s+(?:woman|man)|non-?binary|gay|lesbian|bisexual|queer[\\s-]identifying|queer|lgbtqia\\+?|lgbtq\\+?|lgbt\\+?';
const YOUNG_NOT_A_PERSON = '(?!\\s+(?:brands?|compan(?:y|ies)|start-?ups?|businesses|business|organi[sz]ations?|orgs?|agency|agencies|firms?|ventures?|categor(?:y|ies)|markets?|industry|labels?|studios?|enterprises?|teams?|audiences?|countr(?:y|ies)|ecosystems?|spaces?|funds?|banks?|fintechs?|platforms?|products?|apps?|sites?|channels?|communit(?:y|ies)|publications?|newsletters?|crowd|tech|economy)\\b)(?!\\s+(?:in|at|to|for)\\s+(?:the\\s+)?(?:categor(?:y|ies)|industry|field|market|space|role|career|game|business|sector|team|org)\\b)';
const AGE = `young${YOUNG_NOT_A_PERSON}|youthful${YOUNG_NOT_A_PERSON}|elderly|middle-aged|(?:(?:early|mid|late)[\\s-]*)?(?:\\d0s|twenties|thirties|forties|fifties|sixties|seventies)|senior\\s+citizen|(?:twenty|thirty|forty|fifty|sixty)[\\s-]?something|gen[\\s-]?z|gen[\\s-]?alpha|millennial|baby[\\s-]boomer|boomer|teenager|teenage`;
const CASTE = 'brahmin|brahman|dalit|rajput|kshatriya|vaishya|shudra|obc|bania|baniya|scheduled\\s+(?:caste|tribe)|(?:lower|upper|backward|forward)[\\s-]+caste|general\\s+category|reserved\\s+category';
const ETHNICITY = '(?:north|south|east|west|north-?east|north-?eastern)\\s+india(?:n)?|punjabi|bengali|gujarati|marathi|maharashtrian|malayali|marwari|sindhi|kashmiri|bihari|assamese|odia|kannadiga|tamilian|south\\s+asian|east\\s+asian|african(?:[\\s-]american)?|caucasian|hispanic|latino|latina|(?:dark|fair|light|brown)[\\s-]*skinned|person\\s+of\\s+colou?r|people\\s+of\\s+colou?r|(?:white|black)(?=\\s*(?:[.,;:!?)]|$))';
const PARENT = '(?:(?:single|new|young|working|proud|stay-at-home|expectant|first-time|soon-to-be)\\s+)?(?:mother|father|mom|mum|dad|mommy|daddy)(?!\\s+(?:brand|company|org\\w*|tongue|nature|earth|board|figure|ship)|\\s+of\\s+(?:the|a|an|this|that|our|modern|invention|necessity|all)\\b)|(?:single|working|new|young)\\s+parent|parent(?!\\s+(?:company|brand|organi[sz]ation|org|body|entity|group|firm|corp))';
const FAMILY = `married(?!\\s+to\\s+(?:the|her|his|their|our|its|a|an)\\s+(?:brand|craft|work|idea|ideas|vision|job|data|process|product|mission|cause|company|plan|numbers|metrics|brief))|unmarried|divorced|widowed|widow|widower|separated|pregnant|newlywed|newly[\\s-]married|recently\\s+married|expecting\\s+(?:a\\s+|her\\s+|his\\s+|our\\s+|my\\s+)?(?:(?:first|second|third|new|little)\\s+)?(?:baby|child|kid|twins)|housewife|homemaker|${PARENT}`;
// Nationality and national origin. Plain demonyms are also brand names ("American Express", "Indian Oil"), so they need a sentence-like end.
const DEMONYM = '(?:indian|british|american|canadian|australian|german|french|chinese|japanese|korean|nigerian|pakistani|bangladeshi|nepali|nepalese|sri[\\s-]lankan|emirati|singaporean|irish|scottish|welsh|european|asian|african|arab|russian|italian|spanish|brazilian|mexican|israeli|iranian|afghan|kenyan|ghanaian|south\\s+african|new\\s+zealander|dutch|swiss|swedish|turkish|egyptian|saudi|filipino|vietnamese|thai|indonesian|malaysian)';
const NATIONALITY_OTHER = '(?:indian|asian|african|british|chinese|korean|japanese|pakistani)[\\s-]american|british[\\s-]indian|nri|immigrant|migrant|expat|expatriate|foreigner|refugee|foreign[\\s-]born|overseas[\\s-]born|first[\\s-]generation\\s+(?:immigrant|american|indian)|desi|(?:indian|british|american|canadian|australian|german|french|chinese|japanese|korean|nigerian|pakistani|bangladeshi|nepali|nepalese|sri[\\s-]lankan|emirati|singaporean|irish|european|african|arab|russian|italian|spanish|brazilian|mexican|israeli|iranian|kenyan|ghanaian|dutch|swiss|swedish|turkish|egyptian|filipino|vietnamese|thai|indonesian|malaysian)[\\s-]born';
const NATIONALITY = `${DEMONYM}${GUARD}|${NATIONALITY_OTHER}`;
const NATIONALITY_BARE = `${DEMONYM}|${NATIONALITY_OTHER}`;
const DISABILITY = `disabled|differently[\\s-]abled|specially[\\s-]abled|physically\\s+challenged|handicapped|wheelchair[\\s-]?(?:user|bound)|wheelchair|blind${GUARD}|deaf${GUARD}|mute${GUARD}|autistic|dyslexic|neurodivergent|neurodiverse|bipolar|schizophrenic|diabetic|epileptic|paralys?zed|amputee|chronically\\s+ill|terminally\\s+ill|mentally\\s+ill|visually\\s+impaired|hearing[\\s-]impaired|speech[\\s-]impaired|hiv[\\s-]positive|cancer\\s+survivor|(?:person|individual|someone|woman|man|marketer|designer)\\s+(?:living\\s+)?with\\s+(?:a\\s+)?(?:disabilit(?:y|ies)|impairment|handicap)`;
const RELIGION_GUARDED = `hindu|muslim|christian${GUARD}|sikh|jain${GUARD}|buddhist|parsi|zoroastrian|jewish|jew(?![\\w-])|catholic|protestant|atheist|agnostic`;
const RELIGION_BARE = 'hindu|muslim|christian|sikh|jain|buddhist|parsi|zoroastrian|jewish|jew|catholic|protestant|atheist|agnostic';
/** Attribute words as they follow a subject or a hedge. */
function attributes(guarded: boolean): string {
  const single = guarded ? `single${GUARD}` : 'single';
  return [GENDER, AGE, guarded ? RELIGION_GUARDED : RELIGION_BARE, CASTE, ETHNICITY, FAMILY, single, guarded ? NATIONALITY : NATIONALITY_BARE, DISABILITY].join('|');
}
const ATTR = attributes(true);
// Hinglish first-person statements ("main ek single mom hoon"): the attribute, and the few words that may follow it before "hoon".
const HINGLISH_ATTR = `${RELIGION_BARE}|isai|bauddh|${CASTE}|punjabi|bengali|gujarati|marathi|maharashtrian|malayali|marwari|sindhi|kashmiri|bihari|assamese|odia|tamilian|mahila|aurat|ladki|larki|ladka|larka|stree|purush|aadmi|single|married|divorced|widow|widower|pregnant|garbhvati|vivahit|avivahit|shaadi[\\s-]?shuda|shadi[\\s-]?shuda|vidhwa|vidhur|mom|mother|father|dad|mum|parent|woman|man|female|male|gay|lesbian|queer|transgender`;
const HINGLISH_CONT = `parivar|pariwar|family|khandan|samaj|jati|dharm|community|se|ka|ki|mein|me|hi|bhi|ek|aur|mom|mother|father|dad|woman|man|${CASTE}|${RELIGION_BARE}`;
// "my partner" is usually a business partner ("my partner agency", "my partner and I founded the studio"): only the unambiguous uses count.
const PARTNER_BUSINESS = '(?!\\s+(?:agency|agencies|firm|studio|company|brand|business|organi[sz]ation|from|at|in\\s+crime|and\\s+i\\s+(?:founded|co-?founded|started|built|launched|run|ran|set\\s+up)))';

const SUBJECT = '\\b(?:candidate|applicant|person|individual|presenter|speaker|host|designer|founder|author|creator|narrator|marketer|owner|entrepreneur|professional|strategist|writer|copywriter|artist|photographer|filmmaker|leader|spokesperson|spokesman|spokeswoman|representative|ceo|influencer|actor|actress|anchor|interviewee|ambassador|protagonist|employee|freelancer|consultant|manager|director|producer|editor|videographer|illustrator|developer|engineer|she|he|i)';
// The same people, plus the plain nouns a reviewer uses before "in the video" / "of the studio".
const SUBJECT_OR_PERSON = SUBJECT.replace(/\)$/, '|woman|man|lady|gentleman|girl|boy|guy)');
const SINGULAR_NOUN_SUBJECT = '\\b(?:candidate|applicant|person|individual|presenter|speaker|host|designer|founder|author|creator|narrator|marketer)';
const LINK_VERB = '(?:is|are|am|was|were|(?:has|have|had)\\s+been|appears?|appeared|seems?|seemed|looks?|looked|sounds?|being|becomes?|became|remains?|stays?|(?:comes?|came|hails?|hailed)\\s+from|belongs?\\s+to|(?:might|may|could|would|will|must)\\s+be|identif(?:ies|ied)\\s+as|(?:comes?|came)\\s+(?:across|off)\\s+as|(?:is\\s+)?(?:described|portrayed|referred\\s+to)\\s+as)';
// An adverb between the subject and the linking verb ("the candidate recently became a father").
const ADVERB = '(?:[a-z]+ly|just|also|still|now|already|only)';
const FILL_SUBJECT = '(?:[a-z]{3,}ly|to|be|been|a|an|the|also|very|quite|really|rather|fairly|probably|likely|possibly|perhaps|presumably|apparently|seemingly|still|just|only|clearly|definitely|certainly|now|currently|already|from|of|in|like|as|and|or|not|about|around|approximately|roughly|nearly|almost|some|kind\\s+of|sort\\s+of|her|his|their|my|aged|practi[sc]ing|devout|observant|born-again|orthodox|conservative|lapsed|non-practi[sc]ing|nominal|committed|staunch|religious|pious|deeply|older|younger|elder|recently|newly|finally|soon|then|openly|proudly|publicly|actively|visibly|unapologetically|originally|proud|hijabi|turbaned|first-generation|tamil|telugu|kannada|malayali|bengali|punjabi|gujarati|marathi|maharashtrian|marwari|sindhi|kashmiri|bihari|assamese|odia|kannadiga|tamilian|north|south|east|west|indian|iyer|iyengar|nair|reddy)';
const HEDGE = '(?:appears?(?:\\s+to\\s+be)?|seems?(?:\\s+to\\s+be)?|looks?\\s+(?:like|to\\s+be)|likely|probably|possibly|presumably|perhaps|maybe|apparently|seemingly|supposedly|assumed|assuming|suspected|guessing|guess)';
const FILL_HEDGE = '(?:[a-z]{3,}ly|to|be|is|are|a|an|the|in|of|from|around|about|like|as|his|her|their|aged|very|quite|rather|fairly|also|approximately|roughly|nearly|almost|young|old|elderly|older|middle-aged|work|output|handiwork|voice)';
// A hedged attribute counts as a statement about a person only where the clause ends or moves on ("probably married",
// "likely a Sikh woman, given the name"); with a noun after it ("probably a young team", "likely male audience") it is a topic.
const HEDGE_END = '(?=\\s*(?:[.,;:!?)]|$)|\\s+(?:and|but|or|with|from|by|who|whose|so|as|given|since|because|judging|based|going|returning|living|working|settled|raising|leading|running|moving|though|although|while|which|that|background|origin|descent|ancestry|heritage|upbringing)\\b)';
// "Audience, likely in their 30s" describes a group, not a person.
const GROUP_NOUN = '(?:audiences?|users?|customers?|viewers?|readers?|buyers?|people|women|men|adults|professionals|consumers|segments?|demographics?|personas?|youth|students|followers|fans|parents|moms|mums|dads|clients|members|subscribers)';
const APPEARANCE_ADJ = 'good[\\s-]*looking|attractive|handsome|beautiful|gorgeous|stunning|photogenic|sexy|unattractive|ugly|plain[\\s-]*looking|young[\\s-]*looking|old[\\s-]*looking|youthful[\\s-]*looking|well[\\s-]*dressed|smartly\\s+dressed|nicely\\s+dressed|overweight|obese|skinny|(?:dark|fair|light|brown)[\\s-]*skinned';
const PERSON_NOUN = 'candidate|applicant|presenter|speaker|host|anchor|narrator|founder|person|woman|women|man|men|lady|ladies|girl|girls|boy|boys|guy|guys|gentleman|individual|creator|influencer|actor|actress|interviewer';
const ATTRIBUTE_NOUN = 'gender|sex|religion|caste|ethnicity|race|nationality|marital\\s+status|sexual\\s+orientation';
const AUDIENCE_NOUN = '(?:average|median|mean|typical|avg|women|men|adults|people|users|customers|audiences?|consumers|viewers|professionals|youth|females|males|students|children|kids|teens|persons|individuals|demographic|segment|group|readers|buyers|girls|boys|workers|farmers|residents|citizens|households|target|min|max|minimum|maximum)';
const NOT_A_RANGE = '(?!\\s*(?:[-+%]|to\\s+\\d|and\\s+(?:above|over|under|below|up|older|younger)|or\\s+(?:above|over|older|younger)))';
// "aged 18 and 24" / "age 25 30" is a range of ages (the second number is not smaller); "Age: 37 and 12 years of experience", "Age 37 and 2 kids" and
// "Age: 37 10+ yrs" are an age followed by something else. Decided by the numbers, so a count of years or children after the age cannot hide it.
const AGE_THEN_NUMBER_RE = /^\s*(?:and\s+)?(\d{1,3})(?!\d)/;
function ageIsNotARange(m: RegExpExecArray, clause: string): boolean {
  const first = Number(/(\d{1,3})\s*$/.exec(m[0])?.[1]);
  const after = AGE_THEN_NUMBER_RE.exec(clause.slice((m.index ?? 0) + m[0].length));
  return !after || !(Number(after[1]) >= first);
}
const DECADE = '(?:(?:early|mid|late)[\\s-]*)?(?:\\d0s|twenties|thirties|forties|fifties|sixties|seventies)';
// A labelled value that is an audience figure, not a person: "Gender: 54% female, 46% male", "Gender split ... ratio ... skew".
const NOT_ANALYTICS = '(?![^.;\\n]{0,60}?(?:\\d+(?:\\.\\d+)?\\s*%|\\bpercent\\b|\\bsplit\\b|\\bratio\\b|\\bskew))';
// Words after "maternity/paternity leave" that make it a policy or campaign topic rather than a person's leave.
const POLICY_TOPIC = '(?!\\s+(?:polic\\w*|campaigns?|benefits?|programs?|programmes?|schemes?|law|laws|act\\b|rules?|guidelines?|films?|videos?|ads?\\b|series|explainers?|awareness|launch(?:es)?|messaging|content|initiatives?|entitlements?|extensions?|announcements?|brand|wear|products?))';
// Words that make "marital status" a field or a feature of something the candidate worked on rather than a fact about them.
const WORK_CONTEXT = '\\b(?:app|apps|form|forms|field|fields|filter|filters|screen|screens|redesign|matrimony|matrimonial|platform|website|dropdown|onboarding|flow|ux|ui|product|campaign)\\b';
const FORM_TOPIC = '(?!\\s+(?:fields?|forms?|drop-?downs?|options?|selectors?|filters?|questions?|inputs?|screens?|steps?|checkbox(?:es)?|pickers?|sections?|columns?|data|labels?|toggles?)\\b)';

// Adjectives that describe a person (a famous or visiting man is somebody in the work, a confident woman is a description of the person).
const PERSON_DESCRIPTOR = '(?:confident|strong|bright|talented|warm|charming|elegant|polished|smart|capable|young|older|elderly|quiet|shy|soft-spoken|ambitious|kind|calm|tall|short|slim|petite|beautiful|pretty|attractive|handsome|energetic|mature|experienced|senior|junior|working|single|married|educated|independent|modern|traditional|outspoken|assertive|emotional|sensitive|gentle|fierce|brilliant|clever|driven|determined|dedicated|hardworking|reliable|friendly|polite|humble|proud|loyal)';
// Words a hedge-free "suggests ..." may put between the verb and the attribute ("suggests that she is a ...").
const FILL_SUGGEST = '(?:that|an?|the|she|he|they|is|are|was|candidate|applicant|likely|probably|to\\s+be)';
// Appearance words that describe a body rather than a layout or a site ("looks stunning" is about a page).
const BODY_ADJ = 'good[\\s-]*looking|young[\\s-]*looking|old[\\s-]*looking|youthful[\\s-]*looking|overweight|obese|skinny|(?:dark|fair|light|brown)[\\s-]*skinned';

// People a stated age can belong to ("a 41-year-old brand strategist"). Words that are also things ("lead", "head", "brand", "agency") are left out on purpose.
const AGE_PERSON_NOUN = 'man|woman|male|female|guy|girl|lady|boy|gentleman|professional|candidate|applicant|individual|person|marketer|mother|father|mom|mum|dad|founder|cofounder|designer|graduate|student|intern|fresher|entrepreneur|creator|strategist|writer|copywriter|artist|employee|worker|adult|manager|director|consultant|producer|photographer|filmmaker|videographer|executive|ceo|developer|engineer|analyst|specialist|leader|officer|associate|illustrator|planner|storyteller|editor|freelancer|wife|husband|widow|widower|bachelor|spinster|homemaker|housewife|mum|mommy';

interface Rule {
  name: string;
  re: RegExp;
  /**
   * Default true: a clause that names a third party and does not make the candidate its subject is skipped (see the header).
   * False for rules whose own wording is already about the candidate or about inferring something about them.
   */
  suppressible?: boolean;
  /** "As a married woman, I ...": the rule is the writer introducing themself, so an "I" right after the match makes it the writer's own words. */
  leadIn?: boolean;
  /** A noun-only bio piece ("Wife | Mom"): it relies on real delimiters around it, so a fragment cut out of a sentence at "and" is never read with it. */
  piece?: boolean;
  /** Called with each match and the clause; false = that match does not count (a range of ages is not an age). */
  accept?: (m: RegExpExecArray, clause: string) => boolean;
}

// ── Bio fragments (Instagram / LinkedIn headline style): a noun-only piece such as "Wife | Mom | Marketer" or "Hindu. Mother. Marketer." ──
// A piece is a statement about the person only when it stands alone between delimiters: "Mother Dairy", "Mother's Day", "Husband-and-wife duo" and
// "Pan-India campaign across Hindu, Muslim and Christian festivals" never match. Strong delimiters: a bullet, a pipe, a line break, a full stop.
const BIO_START = '(?:^|[|•·●▪‣\\n,;(]\\s*|[.!?]\\s+)';
// A colon also introduces a bare age ("About me: 37 years old"), but not a bio piece ("Persona: working mother").
const BIO_START_AGE = '(?:^|[|•·●▪‣\\n,;(:]\\s*|[.!?]\\s+)';
const BIO_START_STRONG = '(?:^|[|•·●▪‣\\n]\\s*|[.!?]\\s+)';
const BIO_END_STRONG = '(?=\\s*(?:[|•·●▪‣\\n.!?)]|$))';
const BIO_END = '(?=\\s*(?:[|•·●▪‣\\n.!?,;)]|$))';
const BIO_FAMILY_NOUN = '(?:mother|mom|mum|mommy|mama|wife|husband|father|dad|daddy|papa|parent|widow|widower|divorcee|housewife|homemaker|grandmother|grandfather|grandma|grandpa|bachelor|spinster)';
const BIO_IDENTITY_NOUN = '(?:hindu|muslim|christian|sikh|jain|buddhist|parsi|zoroastrian|jewish|catholic|atheist|agnostic|desi\\s+(?:girl|boy|guy|woman|man|munda|kudi))';
const BIO_MOD = '(?:(?:proud|new|single|working|happy|happily|loving|devoted|doting|first-time|stay-at-home|expectant|soon-to-be|desi|young|older|practising|practicing|devout)\\s+)';
const BIO_MOD_REQUIRED = '(?:proud|new|single|working|stay-at-home|first-time|expectant|soon-to-be|devoted|doting|loving)';
const BIO_CHAIN = `(?:\\s*(?:,|&|and|/)\\s*${BIO_MOD}*(?:${BIO_FAMILY_NOUN}|${BIO_IDENTITY_NOUN}))*`;
// Indian communities and castes a person may say they belong to ("I belong to the Nair community").
const COMMUNITY_NAME = '(?:nair|nayar|iyer|iyengar|reddy|naidu|menon|pillai|kamma|kapu|lingayat|vokkaliga|jat|gujjar|yadav|maratha|kayastha|agarwal|aggarwal|bania|baniya|marwari|sindhi|bohra|khoja|ezhava|namboodiri|nambudiri|thiyya|mudaliar|chettiar|gounder|koli|mahar|chamar|valmiki|bhumihar|thakur|rajput|brahmin|dalit|jain|sikh|parsi|muslim|hindu|christian|buddhist|saraswat|konkani|syrian\\s+christian|tamil\\s+brahmin)';

const STATEMENT_PATTERNS: Rule[] = [
  // Subject + linking verb + attribute: the core "statement about the candidate".
  { name: 'subject-attribute', re: new RegExp(`${SUBJECT}\\s+(?:${ADVERB}\\s+)?${LINK_VERB}(?:\\s+${FILL_SUBJECT}){0,5}\\s+(?:${ATTR})${E}`) },
  // A hedge + attribute with no subject ("likely in his 40s", "probably married").
  { name: 'hedged-attribute', re: new RegExp(`${B}(?<!${GROUP_NOUN}\\s*,?\\s*)${HEDGE}(?:\\s+${FILL_HEDGE}){0,4}\\s+(?:(?:${ATTR})\\s+)*(?:${ATTR})${E}${HEDGE_END}`) },
  // "the female candidate", "a Hindu applicant".
  { name: 'attribute-candidate', suppressible: false, re: new RegExp(`${B}(?:${attributes(false)}|older)\\s+(?:candidate|applicant)${E}`) },
  // Age.
  // "a 41-year-old brand strategist", "35 year old Gujarati woman": up to two words may sit between the age and the person. "A 10-year-old brand relaunch" is a thing's age (no person follows).
  { name: 'age', re: new RegExp(`\\b\\d{1,3}[\\s-]*(?:years?|yrs?)[\\s-]*old\\s+(?:[a-z-]+\\s+){0,2}?(?:${AGE_PERSON_NOUN})(?![\\w-])`) },
  { name: 'age', accept: ageIsNotARange, re: new RegExp(`(?<![\\w-])(?<!${AUDIENCE_NOUN}\\s)(?:aged|age)\\s*(?:of\\s+|is\\s+|[:=-]\\s*)?\\d{1,3}\\b${NOT_A_RANGE}`) },
  { name: 'age', re: new RegExp(`${SUBJECT}\\s+${LINK_VERB}(?:\\s+${FILL_SUBJECT}){0,4}\\s+\\d{2}(?:[\\s-]*(?:years?|yrs?)[\\s-]*old\\b|\\s*y\\/?o\\b|(?=\\s*(?:[.,;!?)]|$)))`) },
  { name: 'age', re: /\bin\s+(?:his|her|my)\s+(?:(?:early|mid|late)[\s-]*)?(?:\d0s|twenties|thirties|forties|fifties|sixties|seventies|teens)\b/ },
  { name: 'age', re: /\b(?:too|a\s+bit\s+too|slightly\s+too|rather\s+too)\s+(?:old|young)\s+for\b/ },
  // Marital and family status, pregnancy.
  { name: 'family', re: new RegExp(`(?<!${WORK_CONTEXT}[^.;]{0,60})\\bmarital\\s+status\\b${FORM_TOPIC}(?![^.;]{0,60}${WORK_CONTEXT})`) },
  { name: 'family', re: new RegExp(`\\b(?:maternity|paternity)\\s+(?:leave|break|gap|cover|risk|plans?|status|period)${POLICY_TOPIC}`) },
  { name: 'family', re: /\b(?:married|single|divorced|widowed|unmarried)\s+(?:with|and\s+(?:has|have|with))\s+(?:\w+\s+){0,2}(?:kids?|children|child|baby|babies|toddlers?)\b/ },
  { name: 'family', re: /\b(?:a\s+)?(?:mother|father|mom|mum|dad|mommy|daddy|mama|papa)\s+(?:of|to)\s+(?:one|two|three|four|five|six|seven|eight|\d+|twins|triplets|kids|children|boys|girls|sons|daughters|an?\s+(?:boy|girl|son|daughter|toddler|baby|newborn|infant|child|kid|teenager|teen))(?![\w-])/ },
  { name: 'family', re: /\b(?:mother|father|mom|mum|dad|parent)\s+of\s+(?:an?\s+)?(?:newborn|baby|toddler|infant|young\s+child|\d+[\s-]*(?:year|yr|month)s?[\s-]*old)\b/ },
  { name: 'family', re: new RegExp(`${B}(?:her|his)\\s+(?:(?:husband|wife|spouse)(?![\\w-])|(?:(?:first|second|third|fourth|new|newborn|little|youngest|eldest|only|baby|toddler)\\s+)?(?:kids?|children|child|baby|babies|toddlers?|pregnancy|newborn|in-laws?|marital)${E})`) },
  { name: 'family', re: new RegExp(`\\b(?:she|he|candidate|applicant)\\s+(?:also\\s+|probably\\s+|likely\\s+|possibly\\s+|currently\\s+)?(?:has|have|had|is\\s+raising)\\s+(?:(?:a|an|two|three|four|\\d+)\\s+)?(?:(?:(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)[\\s-]*(?:year|yr|month)s?[\\s-]*old|young|small|new|little|growing)\\s+)?(?:kids?|children|child|baby|babies|toddlers?|sons?|daughters?|husband|wife|spouse|family)${E}`) },
  { name: 'family', re: new RegExp(`\\bi\\s+(?:also\\s+|currently\\s+)?(?:have|had|am\\s+raising)\\s+(?:(?:an?|two|three|four|five|\\d+|my)\\s+)?(?:(?:(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)[\\s-]*(?:year|yr|month)s?[\\s-]*old|young|small|new|little|growing|beautiful|lovely|wonderful)\\s+)?(?:kids?|children|child|baby|babies|toddlers?|sons?|daughters?|husband|wife|spouse)${E}`) },
  { name: 'family', re: /\b(?:she|he|candidate|applicant)\s+(?:may|might|could|will|would|plans?\s+to|planning\s+to|is\s+planning\s+to|wants?\s+to|is\s+going\s+to|is\s+about\s+to|intends?\s+to|is\s+likely\s+to)\s+(?:soon\s+|probably\s+|eventually\s+)?(?:get\s+married|get\s+pregnant|become\s+(?:a\s+)?(?:mother|father|parent|pregnant)|start\s+a\s+family|have\s+(?:a\s+)?(?:baby|kids?|children|child)|settle\s+down|marry|conceive)\b/ },
  // Appearance.
  { name: 'appearance', re: new RegExp(`${B}(?:${APPEARANCE_ADJ})\\s+(?:(?:young|old|elderly|middle-aged|slim|very|extremely|really|quite|so)\\s+)?(?:${PERSON_NOUN})${E}`) },
  { name: 'appearance', re: new RegExp(`${B}pretty\\s+(?:woman|women|girl|girls|lady|ladies|man|boy|presenter|face)${E}`) },
  { name: 'appearance', re: new RegExp(`\\b(?:she|he|candidate|applicant|presenter|speaker|host|narrator|anchor|founder)\\s+(?:is|was|looks?|looked|appears?|seems?)\\s+(?:(?:[a-z]+ly|very|so|too|pretty)\\s+)?(?:${APPEARANCE_ADJ})${E}`) },
  { name: 'appearance', re: new RegExp(`${B}(?:her|his)\\s+(?:good\\s+looks|looks|physical\\s+appearance|appearance|figure|physique|complexion|skin\\s+(?:colou?r|tone)|hairstyle)${E}(?!\\s+(?:on|in|at|as|during|with|alongside|before|for)\\b)`) },
  { name: 'appearance', re: /\bgood[\s-]*looks\b|\bphysically\s+(?:attractive|appealing)\b/ },
  // Inferring any of it from a name or a picture.
  { name: 'inference-source', suppressible: false, re: new RegExp(`(?:based\\s+on|judging\\s+(?:by|from)|going\\s+by|inferred\\s+from|guess(?:ed)?\\s+from|assum\\w+\\s+from|deduced\\s+from|looking\\s+at)\\s+(?:(?:her|his|the\\s+candidate'?s?|the\\s+applicant'?s?)\\s+(?:(?:first|last|full)\\s+)?(?:name|surname|photo|photograph|picture|headshot|face|appearance|accent|voice|looks|profile\\s+(?:photo|picture))|the\\s+(?:photo|photograph|picture|headshot|profile\\s+(?:photo|picture)))${E}`) },
  // The attribute itself named as a property of the person.
  { name: 'attribute-field', suppressible: false, re: new RegExp(`${B}(?:her|his)\\s+(?:${ATTRIBUTE_NOUN}|age)${E}`) },
  { name: 'attribute-field', suppressible: false, re: new RegExp(`\\b(?:candidate|applicant)'s\\s+(?:${ATTRIBUTE_NOUN}|age|appearance|looks)${E}`) },
  { name: 'attribute-field', suppressible: false, re: new RegExp(`${B}their\\s+(?:gender|religion|caste|ethnicity|race|nationality|marital\\s+status|sexual\\s+orientation)${E}`) },
  { name: 'attribute-field', suppressible: false, re: new RegExp(`\\b(?:${ATTRIBUTE_NOUN}|age)\\s+of\\s+(?:the\\s+)?(?:candidate|applicant)\\b`) },
  { name: 'attribute-field', re: new RegExp(`(?<!(?:target|audience|primary|secondary|core|key|intended|min|max|minimum|maximum)\\s)\\b(?:${ATTRIBUTE_NOUN}|date\\s+of\\s+birth|dob)\\s*[:=]\\s*${NOT_ANALYTICS}\\S`) },
  // "identifies as" is a statement about identity whatever follows.
  { name: 'attribute-field', re: /\b(?:she|he|i|candidate|applicant)\s+(?:self[\s-]*)?identif(?:y|ies|ied)\s+as\b/ },

  // ── Further shapes ──
  // "She comes across as a confident woman": one or two descriptive words may sit between the article and a gendered person noun.
  { name: 'subject-attribute', re: new RegExp(`${SUBJECT}\\s+${LINK_VERB}(?:\\s+${FILL_SUBJECT}){0,4}\\s+(?:${PERSON_DESCRIPTOR}\\s+){1,2}(?:woman|man|lady|gentleman|girl|boy|guy)${E}(?!\\s+of\\s+(?:few|many|great|his|her|action|honou?r|faith|steel|vision|substance|letters|ideas|principles?|words))`) },
  // "As a woman in marketing, she has ..." / "The candidate, being a woman, ..." / "The candidate, who is a practising Hindu, ...".
  { name: 'subject-attribute', leadIn: true, re: new RegExp(`\\bas\\s+an?\\s+(?:(?:young|older|working|single|proud|new|practi[sc]ing|devout|observant)\\s+)?(?:(?:${ATTR})\\s+){0,2}(?:${ATTR})${GUARD_AS}`) },
  { name: 'subject-attribute', leadIn: true, re: new RegExp(`\\bbeing\\s+an?\\s+(?:(?:young|older|working|single|proud|new|practi[sc]ing|devout|observant)\\s+)?(?:(?:${ATTR})\\s+){0,2}(?:${ATTR})${GUARD_AS}`) },
  { name: 'subject-attribute', re: new RegExp(`${SINGULAR_NOUN_SUBJECT}\\s*,\\s*who\\s+(?:is|was|appears?\\s+to\\s+be)(?:\\s+${FILL_SUBJECT}){0,4}\\s+(?:${ATTR})${E}`) },
  // "Candidate: female, 34" and the pronoun badge "she/her".
  { name: 'subject-attribute', suppressible: false, re: new RegExp(`\\b(?:candidate|applicant)\\s*[:=]\\s*(?:(?:a|an)\\s+)?(?:${ATTR})${E}`) },
  { name: 'attribute-field', suppressible: false, re: /\b(?:she\s*\/\s*her|he\s*\/\s*him|they\s*\/\s*them)\b/ },
  { name: 'attribute-field', suppressible: false, re: /\b(?:candidate|applicant|gender|sex)\s*[:=]\s*[fm](?=\s*(?:[,/]|$|\d))/ },
  // "a female marketer", "a Hindu designer" (a gender, religion, caste or ethnicity adjective on a person who is not named "candidate").
  { name: 'attribute-person', re: new RegExp(`${B}(?:an?\\s+|the\\s+)(?:female|male|transgender|non-?binary|gay|lesbian|hindu|muslim|christian|sikh|jain|buddhist|parsi|jewish|catholic|dalit|brahmin|punjabi|bengali|gujarati|marathi|maharashtrian|malayali|marwari|sindhi|kashmiri|bihari|assamese|odia|kannadiga|tamilian|south\\s+asian|african|caucasian|hispanic|latino|latina)\\s+(?:marketer|designer|writer|copywriter|creator|founder|author|presenter|speaker|host|narrator|professional|strategist|manager|person|individual|executive|creative)${E}`) },
  // Singular "they / their" (the reviewer is told not to use gendered pronouns, so this is how an inference gets worded).
  { name: 'age', re: new RegExp(`\\bthey\\s+(?:are|were|seem|seems|appear|appears|look|looks|might\\s+be|may\\s+be|must\\s+be)(?:\\s+(?:to\\s+be|probably|likely|possibly|around|about|approximately|roughly|almost|nearly|in|their|aged|early|mid|late)){0,6}\\s+${DECADE}${E}`) },
  { name: 'age', re: new RegExp(`${SINGULAR_NOUN_SUBJECT}\\s*,?\\s*(?:who\\s+is\\s+|is\\s+)?(?:likely\\s+|probably\\s+|possibly\\s+)?in\\s+their\\s+${DECADE}${E}`) },
  { name: 'family', re: new RegExp(`${B}their\\s+(?:(?:husband|wife|spouse)(?![\\w-])|(?:pregnancy|in-laws?|marital)${E})`) },
  // Born in / year of birth.
  { name: 'age', re: new RegExp(`${SUBJECT}\\s+(?:was\\s+|is\\s+)?born\\s+(?:in|on)\\s+(?:\\w+\\s+){0,2}\\d{4}`) },
  { name: 'age', re: /\b(?:year\s+of\s+birth|born)\s*[:=]\s*\d/ },
  { name: 'age', re: /\b(?:dob|d\.o\.b\.?|date\s+of\s+birth|birth\s*date|birthday)\s*[:=]?\s*(?:is\s+|on\s+)?\d/ },
  // Health and disability stated about the person.
  { name: 'disability', re: new RegExp(`${SUBJECT}\\s+(?:also\\s+|probably\\s+|likely\\s+|possibly\\s+|currently\\s+)?(?:has|have|had|seems?\\s+to\\s+have|appears?\\s+to\\s+have|suffers?\\s+from|suffered\\s+from|is\\s+suffering\\s+from|was\\s+diagnosed\\s+with|is\\s+living\\s+with|am\\s+living\\s+with|lives\\s+with|is\\s+recovering\\s+from|am\\s+recovering\\s+from|is\\s+battling|am\\s+battling|survived|uses?\\s+an?)\\s+(?:an?\\s+|the\\s+|some\\s+)?(?:(?:serious|chronic|physical|mental|medical|health|visible|hidden|invisible|learning|long[\\s-]term|severe|mild|rare|neurological|psychological|genetic)\\s+)*(?:disabilit(?:y|ies)|health\\s+(?:condition|issue|problem|concern)s?|medical\\s+(?:condition|issue|problem)s?|condition|illness|disease|cancer|diabetes|epilepsy|autism|adhd|depression|anxiety|impairment|disorder|handicap|wheelchair|(?:spinal|head|back|brain|knee|hip|serious|major|severe)\\s+(?:injur(?:y|ies)|surgery)|injur(?:y|ies)|surgery|chronic\\s+\\w+|stutter(?:ing)?|stammer(?:ing)?|lisp|limp|speech\\s+impediment|(?:hearing|vision|sight)\\s+(?:loss|problems?)|(?:hearing|visual|speech)\\s+(?:impairment|disorder))${E}`) },
  // Accent and native language, stated about the person (an "accent colour" is a design term).
  { name: 'accent', re: /\b(?:speaks?|spoke|spoken|speaking|talks?|sounds?)\s+(?:with\s+)?(?:an?\s+)?(?:[a-z-]+\s+){0,3}accent\b(?!\s+(?:colou?rs?|walls?|pieces?|lights?|fonts?|lines?|shades?|tones?|marks?|stripes?|borders?|details?))/ },
  { name: 'accent', re: /\b(?:has|have|had|with|having)\s+(?:an?\s+)?(?:[a-z-]+\s+){0,3}accent\b(?!\s+(?:colou?rs?|walls?|pieces?|lights?|fonts?|lines?|shades?|tones?|marks?|stripes?|borders?|details?))/ },
  { name: 'accent', re: /\b(?:heavy|strong|thick|foreign|regional|non-native|noticeable|noticeably|slight|mild|distinct)\s+(?:[a-z-]+\s+){0,2}accent\b(?!\s+(?:colou?rs?|walls?|pieces?|lights?|fonts?|lines?|shades?|tones?|marks?|stripes?|borders?|details?))/ },
  { name: 'nationality', re: new RegExp(`${SUBJECT}\\s+${LINK_VERB}(?:\\s+${FILL_SUBJECT}){0,4}\\s+(?:non-?)?native\\s+(?:\\w+\\s+)?speaker`) },
  // A pretty person ("She is pretty and articulate"), as opposed to "a pretty good copywriter".
  { name: 'appearance', re: new RegExp(`\\b(?:she|he|candidate|applicant|presenter|speaker|host|narrator|anchor|founder)\\s+(?:is|was|looks?|looked|appears?|seems?)\\s+(?:(?:very|quite|really|rather|extremely|so|fairly|too)\\s+)?pretty(?=\\s*(?:[.,;:!?)]|$)|\\s+and\\b)`) },
  // Inferring from "the name" without saying whose, as long as what follows is a statement about a person.
  { name: 'inference-source', suppressible: false, re: /(?:based\s+on|judging\s+(?:by|from)|going\s+by|inferred\s+from|guess(?:ed)?\s+from|assum\w+\s+from|deduced\s+from)\s+the\s+(?:candidate'?s?\s+)?(?:(?:first|last|full)\s+)?(?:name|surname)\b(?!\s+of\b)(?=.{0,80}\b(?:candidate|applicant|she|he|they|likely|probably|presumably|female|male|woman|man|from|hindu|muslim|christian|sikh|jain|north|south|east|west|region|community|ethnic|origin|religio|caste|gender|age)\b)/ },

  // ── More shapes a reviewer's sentence can take ──
  // A hedged number that ends the clause ("likely around 40", "probably 35 years old") and "pushing 50" / "born in the late 80s".
  { name: 'age', re: new RegExp(`${B}(?<!${GROUP_NOUN}\\s*,?\\s*)${HEDGE}(?:\\s+(?:to\\s+be|around|about|approximately|roughly|nearly|almost|in\\s+(?:his|her|their)))*\\s+\\d{2}(?:\\s*(?:years?|yrs?)(?:\\s+old)?)?${HEDGE_END}`) },
  { name: 'age', re: new RegExp(`${SUBJECT}\\s+(?:\\w+\\s+){0,3}?(?:pushing|nearing|approaching|hitting|turning)\\s+\\d0\\b`) },
  { name: 'age', re: new RegExp(`${SUBJECT}\\s+(?:\\w+\\s+){0,2}?(?:was\\s+|is\\s+)?born\\s+in\\s+(?:the\\s+)?(?:(?:early|mid|late)[\\s-]*)?(?:(?:19|20)?\\d0s|eighties|nineties|seventies|sixties)\\b`) },
  // "The candidate, a woman, ..." (an attribute in apposition).
  { name: 'subject-attribute', re: new RegExp(`${SINGULAR_NOUN_SUBJECT}\\s*,\\s*an?\\s+(?:[a-z-]+\\s+){0,2}?(?:${ATTR})${E}`) },
  // Dress read as a religious cue.
  { name: 'appearance', re: /\b(?:wears?|wearing|sporting|dressed\s+in)\s+(?:an?\s+|the\s+)?(?:hijab|turban|burqa|burkha|niqab|veil|bindi|tilak|sindoor|mangalsutra|kippah|yarmulke|skullcap|cross\s+necklace|sari|saree|salwar|dupatta|lehenga|pagdi|pagri)\b/ },
  // "The surname suggests a Bengali background", "her name indicates she is Muslim".
  { name: 'hedged-attribute', re: new RegExp(`\\b(?:suggests|suggesting|indicates|indicating|implies|implying|hints\\s+at|hinting\\s+at|points\\s+to|pointing\\s+to|signals|signalling|signaling)(?:\\s+${FILL_SUGGEST}){0,4}\\s+(?:${ATTR})${E}${HEDGE_END}`) },
  // A career gap explained by a protected life event ("possibly maternity", "likely due to marriage", "probably for health reasons").
  { name: 'family', re: new RegExp(`${B}${HEDGE}(?:\\s+(?:due\\s+to|because\\s+of|for|from|over))?\\s+(?:maternity|paternity|pregnancy|marriage|childbirth|a\\s+baby|health\\s+reasons|medical\\s+reasons)${E}`) },
  { name: 'appearance', re: new RegExp(`${B}${HEDGE}(?:\\s+(?:to\\s+be|very|quite|rather|fairly|extremely|so|too))*\\s+(?:${BODY_ADJ})${E}${HEDGE_END}`) },

  // ── First person, and more shapes a reviewer's sentence can take (second review) ──
  // "I'm 34 and have ...", "I am 52 and still ...": a bare age followed by and / but / with; "I turned 40".
  { name: 'age', re: /\bi\s+am(?:\s+(?:now|just|already|only|still|currently))?\s+\d{2}(?=\s+(?:and|but|with|so|now)\b)/ },
  { name: 'age', re: /\bi\s+(?:just\s+|recently\s+)?(?:turned|turn|am\s+turning|will\s+turn)\s+\d{2}\b/ },
  // An age in apposition to the writer's own name: "I am Priya Sharma, 38, a brand lead", "My name is Priya, 34."
  { name: 'age', re: /\b(?:i\s+am|my\s+name\s+is)\s+(?:[a-z.'-]+\s+){0,3}[a-z.'-]+\s*,\s*(?:aged\s+)?(?:1[89]|[2-7]\d)(?=\s*(?:[,.;:!?)]|$)|\s+and\b)/ },
  // "my husband", "my kids", "my daughter is 7" (a first-person statement about the family).
  { name: 'family', re: new RegExp(`${B}my\\s+(?:(?:husband|wife|spouse|hubby|fianc[eé]e?|boyfriend|girlfriend|in-laws?|mother-in-law|father-in-law|pregnancy|newborn|toddlers?|babies|baby|kids?|children|child|sons?|daughters?|mom|mum|mother(?!\\s+tongue)|father|dad|parents)(?![\\w-])|partner(?![\\w-])${PARTNER_BUSINESS})`) },
  // "I recently got married", "I became a mother", "I had a baby".
  { name: 'family', re: /\bi\s+(?:have\s+|had\s+)?(?:\w+ly\s+|just\s+|recently\s+|also\s+|finally\s+|soon\s+)*(?:got\s+married|get\s+married|am\s+getting\s+married|got\s+engaged|got\s+divorced|became\s+(?:a\s+)?(?:mother|father|mom|dad|parent|widow|widower)|gave\s+birth|am\s+expecting|have\s+a\s+(?:baby|newborn)|had\s+a\s+(?:baby|child)|had\s+(?:my|our)\s+(?:(?:first|second|third|fourth|new|little)\s+)?(?:baby|child|son|daughter|kid)|lost\s+my\s+(?:husband|wife|spouse)|went\s+on\s+maternity|am\s+(?:a\s+)?new\s+(?:mom|mum|mother|dad|father|parent))\b/ },
  // A bio's subject-less marital fragment: "Married to a data scientist.", "Married, two kids", "Recently divorced." ("Married to the brand" is a figure of speech).
  { name: 'family', re: /(?:^|[.!?;|•·\n]\s*|,\s*)(?:happily\s+|recently\s+|newly\s+)?(?:(?:married|divorced|widowed)(?!\s+to\s+(?:the|her|his|their|our|its)\s+(?:brand|craft|work|idea|ideas|vision|job|data|process|product|mission|cause|company|plan|numbers|metrics|brief))(?=\s+(?:to|with|and|for)\b|\s*[,.;:|•·!?)]|\s*$)|engaged\s+to\s+(?:a|an|my)\b)/ },
  // A marital event in a person's own life, and raising children alone ("after her divorce", "raising twin boys alone").
  { name: 'family', re: /\b(?:after|following|since|during)\s+(?:her|his|my|their)\s+(?:divorce|separation|bereavement|miscarriage|maternity|pregnancy)\b/ },
  { name: 'family', re: /\braising\s+(?:\w+\s+){0,3}(?:alone|single-handedly|on\s+(?:her|his|my)\s+own|by\s+(?:herself|himself|myself))\b/ },
  // A subject-less fragment about a pregnancy ("..., pregnant at the time of the launch"); "pregnant women" as an audience is not one.
  { name: 'family', suppressible: false, re: /(?<![\w-])pregnant\s+(?:at|during|when|while|but|again|now|then|with\s+(?:my|our|her|his|twins))\b/ },
  // "the candidate's wife", "the applicant's kids".
  { name: 'family', re: new RegExp(`\\b(?:candidate|applicant)'s\\s+(?:husband|wife|spouse|kids?|children|child|baby|babies|sons?|daughters?|pregnancy|newborn|in-laws?|marital|parents?|mother|father)(?![\\w-])`) },
  // "As a woman, ...", "Being a single father taught me ...": a gendered or family noun after as / being needs nothing after it.
  { name: 'subject-attribute', leadIn: true, re: new RegExp(`\\b(?:as|being)\\s+an?\\s+(?:(?:single|working|young|proud|new|stay-at-home|first-time|soon-to-be|older|elderly)\\s+)?(?:${GENDER}|${PARENT}|widow|widower|wife|husband)${E}`) },
  // "a Punjabi at heart", "a Sikh by birth".
  { name: 'subject-attribute', re: new RegExp(`${B}an?\\s+(?:${ETHNICITY}|${RELIGION_BARE}|${CASTE})\\s+(?:at\\s+heart|by\\s+(?:birth|faith|religion|descent|origin|upbringing))`) },
  // A person looking unwell or tired on camera is a statement about their health.
  { name: 'appearance', re: /\b(?:she|he|candidate|applicant|presenter|speaker|host|narrator|anchor|founder)\s+(?:also\s+)?(?:is\s+|was\s+)?(?:looks?|looked|appears?|appeared|seems?|seemed|sounds?|sounded)\s+(?:to\s+be\s+)?(?:(?:very|quite|so|rather|a\s+bit|really|extremely|visibly|slightly|somewhat)\s+)?(?:tired|unwell|ill|sick|frail|exhausted|unhealthy|pale|weak)(?![\w-])/ },

  // ── Fourth review: bare and hyphenated ages, born-in years, noun-only bios, more family shapes ──
  // "42 years old, ex-Ogilvy", "Brand lead, 37 years old, with a team of 6": the age is a piece of its own ("the brand is 10 years old" has words in front of it).
  { name: 'age', re: new RegExp(`${BIO_START_AGE}(?:1[6-9]|[2-7]\\d)\\s*(?:years?|yrs?)[\\s-]*old(?![\\w-])(?=\\s*(?:[.,;:!?|•·)]|$|and\\b))`) },
  { name: 'age', re: /(?<![\w.-])(?:1[6-9]|[2-7]\d)\s?y\/?o(?![\w])/ },
  // "Currently 37 years old", "At 37 years old I started my own studio" (the age is followed by the writer or the end of the piece); "Turned 40 this year".
  { name: 'age', re: /\b(?:currently|now|presently|at|aged)\s+(?:1[6-9]|[2-7]\d)\s*(?:years?|yrs?)[\s-]*old(?![\w-])(?=\s*(?:[.,;:!?)]|$|and\b|i\b|my\b|she\b|he\b|we\b))/ },
  { name: 'age', re: new RegExp(`${BIO_START_AGE}turned\\s+(?:1[6-9]|[2-7]\\d)(?![\\d%])`) },
  // "Born in 1987.", "Born 1983 | Brand lead", "Born in 1986, I started in print": the year ends the piece or leads into the writer ("Born in 2008, Zomato ..." is a brand).
  { name: 'age', re: new RegExp(`(?:${BIO_START}|\\b(?:i|she|he)\\s+(?:was\\s+)?)born\\s+(?:in\\s+|on\\s+)?(?:(?:the\\s+)?(?:early|mid|late)[\\s-]*)?(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?[a-z]+,?\\s+|[a-z]+\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?(?:19[3-9]\\d|200[0-5])(?!\\d)(?=\\s*(?:$|[|•·.;!?]|,\\s*(?:i|she|he|my|and)\\b))`) },
  // "Male, 34, brand manager", "34 | female".
  { name: 'age', re: new RegExp(`${BIO_START}(?:male|female|man|woman|boy|girl)\\s*[,/|•·]\\s*(?:1[6-9]|[2-7]\\d)(?!\\d)`) },
  { name: 'age', re: new RegExp(`${BIO_START}(?:1[6-9]|[2-7]\\d)\\s*[,/|•·]\\s*(?:male|female|man|woman|boy|girl)(?![\\w-])`) },
  // A noun-only bio piece: "Mom. Founder. Storyteller.", "Wife | Mom | Marketer", "Hindu. Mother. Marketer.", "Proud mom. Brand builder."
  { piece: true, name: 'family', re: new RegExp(`${BIO_START_STRONG}${BIO_MOD}*(?:${BIO_FAMILY_NOUN}|${BIO_IDENTITY_NOUN})${BIO_CHAIN}${BIO_END_STRONG}`) },
  // "Husband, father, creative director.", "Wife and mother, marketer by passion.": the first piece of a bio, then a comma.
  { piece: true, name: 'family', re: new RegExp(`${BIO_START_STRONG}${BIO_MOD}*${BIO_FAMILY_NOUN}${BIO_CHAIN}${BIO_END}`) },
  // "Brand strategist, new mom, ex-agency": a comma piece needs a word that makes it a person ("new", "single", "proud" ...).
  { piece: true, name: 'family', re: new RegExp(`${BIO_START}${BIO_MOD}*${BIO_MOD_REQUIRED}\\s+(?:mother|mom|mum|mommy|mama|father|dad|daddy|papa|parent)${BIO_END}`) },
  // "3 kids, 1 dog".
  { piece: true, name: 'family', re: new RegExp(`${BIO_START}(?:\\d{1,2}|one|two|three|four|five|six)\\s+(?:kids?|children)${BIO_END}`) },
  // "I belong to the Nair community", "she comes from the Iyer community".
  { name: 'subject-attribute', re: new RegExp(`\\b(?:i|she|he|candidate|applicant)\\s+(?:belongs?|belonged)\\s+to\\s+(?:the\\s+|a\\s+)?(?:${COMMUNITY_NAME})(?:\\s+(?:community|caste|tribe|clan|sect|religion|faith|family))?(?![\\w-])`) },
  { name: 'subject-attribute', re: new RegExp(`\\b(?:i|she|he|candidate|applicant)\\s+(?:come|comes|came|hail|hails|hailed)\\s+from\\s+(?:the\\s+|an?\\s+)?(?:${COMMUNITY_NAME})\\s+(?:community|caste|tribe|clan|family|household|background)(?![\\w-])`) },
  // "The founder of the studio is a single mom", "The person in the interview video is elderly": a phrase of place between the person and the verb.
  { name: 'subject-attribute', re: new RegExp(`${SUBJECT_OR_PERSON}\\s+(?:of|from|behind|at|in|on|shown\\s+in|seen\\s+in|featured\\s+in|pictured\\s+in|appearing\\s+in|speaking\\s+in|talking\\s+in)\\s+(?:the|this|that|our|their|his|her)\\s+(?:[a-z'-]+\\s+){0,3}?${LINK_VERB}(?:\\s+${FILL_SUBJECT}){0,5}\\s+(?:${ATTR})${E}`) },
  // "This is a Muslim woman founder from Hyderabad.": a person noun has to follow the attribute ("this is a male grooming brand" is a product).
  { name: 'subject-attribute', re: new RegExp(`\\b(?:this|that|here)\\s+(?:is|was)\\s+an?\\s+(?:[a-z-]+\\s+){0,2}?(?:${ATTR})\\s+(?:woman|man|founder|creator|professional|marketer|designer|mother|father|entrepreneur|person|individual|candidate|applicant|writer|artist|director|manager|strategist|girl|boy|lady|gentleman)(?![\\w-])`) },
  // "This reads like the work of a young, unmarried woman."
  { name: 'subject-attribute', re: new RegExp(`\\b(?:reads?|looks?|sounds?|feels?|comes?\\s+across)\\s+like\\s+(?:the\\s+work\\s+of\\s+|something\\s+(?:written|made|created|done)\\s+by\\s+|an?\\s+(?:piece|work)\\s+by\\s+)?an?\\s+(?:[a-z-]+,?\\s+){0,3}?(?:${ATTR})\\s+(?:woman|man|lady|gentleman|girl|boy|guy|person|mother|father|professional|student|graduate|couple)(?![\\w-])`) },

  // ── Hindi / Hinglish, Roman script ──
  { name: 'hindi', re: /(?<![\w-])(?:ek|yeh|ye|woh|wo|is|us|iski|uski)\s+(?:mahila|aurat|ladki|larki|ladka|larka|stree|purush|aadmi)(?![\w-])/ },
  { name: 'hindi', re: /(?<![\w-])(?:mahila|aurat|ladki|larki|ladka|larka|stree|purush|aadmi)\s+(?:hai|hain|he|h|hu|hun|hoon|hoo|ho|thi|tha|the|hogi|hoga|lagti|lagta|lagte|dikhti|dikhta|dikhte|jaisi|jaisa)(?![\w-])/ },
  { name: 'hindi', re: /(?<![\w-])(?:shaadi[\s-]?shuda|shadi[\s-]?shuda|shaadishuda|vivahit|avivahit|vidhwa|vidhur|kunwara|kunwari|shaadi\s+(?:\w+\s+){0,3}(?:ho\s+(?:gayi|gai|gaye|gaya|chuki|chuke|chuka)|hui|hue)|(?:meri|mera|uski|unki|hamari)\s+(?:shaadi|shadi)|garbhvati)(?![\w-])/ },
  { name: 'hindi', re: /(?<![\w-])(?:candidate|applicant|main|mai|uski|unki|woh|wo|she|he)\s+(?:\w+\s+){0,2}(?:shaadi|shadi|vivah)\s+ke\s+baad(?![\w-])/ },
  // An age needs a person next to it: "umar 38", "main 29 saal ka ladka hoon", "34 saal ki mahila". "5 saal ka brand roadmap" is a duration of the work.
  { name: 'hindi', re: /(?<![\w-])umar\s+(?:(?:lagbhag|kareeb|takriban|about|around)\s+)?(?:\d|kitni|hai)/ },
  { name: 'hindi', re: /(?<![\w-])(?:main|mai|mein|hum|meri|mera|uski|unki|iski)\s+(?:\w+\s+){0,3}\d{1,2}\s*(?:saal|sal|varsh|baras)\s+(?:ki|ka|ke)\s+(?:ek\s+)?(?:(?:single|working|married)\s+)?(?:hoon|hun|hu|hai|hain|ladki|larki|ladka|larka|mahila|aurat|purush|aadmi|woman|man|female|male|girl|boy|mother|father|mom|dad)(?![\w-])/ },
  { name: 'hindi', re: /(?<![\w-])\d{1,2}\s*(?:saal|sal|varsh|baras)\s+(?:ki|ka|ke)\s+(?:mahila|aurat|ladki|larki|ladka|larka|purush|aadmi|woman|man|female|male|girl|boy|mother|father|mom|dad|insaan)(?![\w-])/ },
  { name: 'hindi', re: new RegExp(`(?<![\\w-])(?:${RELIGION_BARE}|isai|bauddh|${CASTE}|punjabi|bengali|gujarati|marathi|maharashtrian|malayali|marwari|sindhi|kashmiri|bihari|assamese|odia|tamilian)\\s+(?:hai|hain|he|h|hu|hun|hoon|hoo|ho|thi|tha|the|hogi|hoga|lagta|lagti|lagte|dikhta|dikhti|dikhte)(?![\\w-])`) },
  // First person: "main ek single mom hoon", "main Hindu Brahmin parivar se hoon", "main pregnant thi".
  { name: 'hindi', re: new RegExp(`(?<![\\w-])(?:main|mai|mein|hum)\\s+(?:ek\\s+)?(?:\\w+\\s+){0,2}?(?:${HINGLISH_ATTR})(?:\\s+(?:${HINGLISH_CONT})){0,3}\\s+(?:hoon|hun|hu|hoo|thi|tha|hain|hai)(?![\\w-])`) },
  { name: 'hindi', re: /(?<![\w-])(?:apne|apni|mere|meri|mera|hamare|hamari|humare|humari)\s+(?:pati|patni|biwi|shauhar|bacch\w+|bete|beti|beta|husband|wife|kids?|saas|sasur)(?![\w-])/ },
  { name: 'hindi', re: /(?<![\w-])(?:uski|uska|unki|unka|iski|iska)\s+(?:patni|pati|biwi|shauhar|bacche|bachche|bachcha|beti|beta)(?![\w-])|(?<![\w-])bachchon\s+ki\s+(?:maa|mata)(?![\w-])/ },
];

// ── Hindi, Devanagari ── (patterns are NFKC-normalised like the text; \b does not work on Devanagari, so lookarounds do it)
const DEV_B = '(?<![\\p{L}\\p{M}])';
const DEV_E = '(?![\\p{L}\\p{M}])';
const DEV_COPULA = '(?:है|हैं|थी|था|थे|लगती|लगता|लगते|दिखती|दिखता)';
const DEV_PATTERNS: Array<{ name: string; re: RegExp }> = [
  `${DEV_B}(?:महिला|औरत|स्त्री|लड़की|लड़का|पुरुष|आदमी)(?:\\s+[\\p{L}\\p{M}]+){0,2}\\s+${DEV_COPULA}${DEV_E}`,
  `${DEV_B}एक\\s+(?:महिला|औरत|लड़की|लड़का|पुरुष|आदमी)${DEV_E}`,
  `${DEV_B}(?:शादीशुदा|विवाहित|अविवाहित|कुंवारी|कुंवारा|कुँवारी|कुँवारा|गर्भवती)${DEV_E}`,
  `${DEV_B}(?:बच्चों\\s+की\\s+(?:मां|माँ|माता)|(?:दो|तीन|चार|\\d+)\\s+बच्चे)${DEV_E}`,
  `${DEV_B}उम्र\\s*\\d|\\d+\\s*साल\\s*(?:की|का|के|है)${DEV_E}`,
  `${DEV_B}(?:हिंदू|हिन्दू|मुस्लिम|सिख|ईसाई|जैन|बौद्ध|पारसी|ब्राह्मण|दलित|राजपूत|क्षत्रिय|वैश्य|शूद्र)(?:\\s+[\\p{L}\\p{M}]+){0,1}\\s+${DEV_COPULA}${DEV_E}`,
].map(src => ({ name: 'hindi', re: new RegExp(src.normalize('NFKC'), 'u') }));

// Third parties: a clause that names one is about THEM unless it also makes the candidate the subject.
const THIRD_PARTY_CUE = new RegExp(
  '(?<![\\w-])(?:featured|features(?=\\s+(?:an?|the|her|his|their|two|three|four|\\d+)\\s+(?:\\w+\\s+)?(?:woman|women|man|men|girl|boy|mother|father|founder|ceo|farmer|customer|client|actor|actress|celebrity|influencer|villager|child|kid|couple|family|artisan|worker|student|teacher|doctor|athlete)\\b)|featuring|starring|stars|cast(?:ing)?|clients?|customers?|case[\\s-]stud(?:y|ies)|testimonials?|ambassadors?|celebrit(?:y|ies)|influencers?|endorse\\w*|guests?|panell?ists?|interviewees?|personas?|audiences?|actress(?:es)?|actors?|protagonists?|characters?|heroine|hero|heroes|mascot|villagers?|beneficiar(?:y|ies)|farmers?|residents?|volunteers?|participants?|storyline|priest|pandit|pujari|imam|maulvi|monk|nun|pastor|granthi|swami|guru|whose)(?![\\w-])'
  + '|\\bin\\s+the\\s+(?:tvc|tv\\s+(?:ad|commercial)|ad|ad\\s+film|commercial|spot|documentary)\\b'
  + '|\\bcandidate\\s+(?:partnered|hired|mentored|managed|promoted|negotiated|worked|collaborated|cast|signed|booked|interviewed|commissioned|briefed|onboarded|trained|coached|recruited|pitched|engaged|approached|directed|shot|produced|led)\\b'
  + '|\\b(?:partnered|worked|collaborated)\\s+with\\b');
const EXPLICIT_CANDIDATE = /\b(?:candidate|applicant)(?:'s)?\s+(?:(?:also|probably|likely|possibly|currently|still)\s+)?(?:is|was|are|appears?|seems?|looks?|identifies|has|had|belongs|comes|might|may|could|would|will)\b|\b(?:candidate|applicant)\s*,?\s*(?:being|who)\b|\b(?:candidate|applicant)\s*[:=]/;

// A clause ends at . ! ? (after a non-space) or ;. A bare line break does not end one: text hard-wrapped by a PDF or a document
// ("She is probably\nmarried") is still one statement.
function clausesOf(t: string): string[] {
  // Trimmed, so that a clause that starts with the bracket the "unmarked" reading removed ("( Wife | Mom") starts where its words do.
  return t.split(/(?<=\S[.!?])\s+|\s*;\s*/).map(c => c.trim()).filter(Boolean);
}

// A match that is the writer speaking about themself ("i am a hindu woman", "my husband", "main ek single mom hoon") is about the candidate whatever
// else the clause names: the candidate is the one who writes "I". "Mine" and "myself" count; a bare "my" in the clause does not ("my clients' founder is a woman").
const FIRST_PERSON_WORD = /(?<![\w'-])(?:i|my|myself|mine)(?![\w'-])/;
const FIRST_PERSON_HINGLISH = /(?<![\w-])(?:main|mai|maine|mera|meri|mere|mujhe|apne|apni|hum|humne|hamara|hamari|hamare|hoon|hun|hoo|hu)(?![\w-])/;
const FIRST_PERSON_SUBJECT = /(?<![\w'-])i(?![\w'-])/;
// Where a sentence is cut into the statements that make it up, for the third-party test.
const FIRST_PERSON_ANY = new RegExp(`${FIRST_PERSON_WORD.source}|${FIRST_PERSON_HINGLISH.source}`);
const SUBCLAUSE_CUT_RE = /\s+(?:and|but|aur|toh|lekin|magar|while|whereas|since|because|although|though|which|given\s+(?:that|the)|so\s+that)\s+/;

const GLOBAL_OF = new WeakMap<RegExp, RegExp>();
/**
 * Every match of `re` in `c`, through a global twin of the rule's own expression that is built the first time a rule really matches. (Not
 * String.prototype.matchAll: it clones the expression on every call, and a clone of one of these large patterns costs a recompilation.)
 */
function* allMatches(re: RegExp, c: string): Generator<RegExpExecArray> {
  let g = GLOBAL_OF.get(re);
  if (!g) { g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`); GLOBAL_OF.set(re, g); }
  g.lastIndex = 0;
  for (let m = g.exec(c); m; m = g.exec(c)) {
    yield m;
    if (m[0] === '') g.lastIndex++;
  }
}

// "A Christian by faith, I still ran ...", "I, a married woman, have ...": the phrase sits right next to the writer's "I".
const I_RIGHT_AFTER_RE = /^\s*[,:;-]?\s*i(?![\w'-])/;
const OTHER_SUBJECT_START_RE = new RegExp(`^${SUBJECT}`);
const I_RIGHT_BEFORE_RE = /(?<![\w'-])i\s*,\s*$/;
function isWritersOwn(p: Rule, m: RegExpExecArray, c: string): boolean {
  if (FIRST_PERSON_WORD.test(m[0])) return true;
  if (p.name === 'hindi' && FIRST_PERSON_HINGLISH.test(m[0])) return true;
  const at = m.index ?? 0;
  const end = at + m[0].length;
  // A match that opens with somebody else as its subject ("the founder is a Hindu woman, I interviewed her") is about them, whatever follows it.
  if (!OTHER_SUBJECT_START_RE.test(m[0]) && (I_RIGHT_AFTER_RE.test(c.slice(end, end + 8)) || I_RIGHT_BEFORE_RE.test(c.slice(Math.max(0, at - 8), at)))) return true;
  if (p.leadIn) return FIRST_PERSON_SUBJECT.test(c.slice(at, end + 40));   // "As a married woman in this industry I have learned ..."
  return false;
}

/** Does the rule fire in `c`? With `onlyWritersOwn`, only on a match that is the writer's own words. */
function ruleFires(p: Rule, c: string, onlyWritersOwn: boolean): boolean {
  if (!p.re.test(c)) return false;   // the rule's own expression is the cheap test; the match-by-match reading below is for the rare statement that matched
  if (!p.accept && !onlyWritersOwn) return true;
  for (const m of allMatches(p.re, c)) {
    if (p.accept && !p.accept(m, c)) continue;
    if (onlyWritersOwn && !isWritersOwn(p, m, c)) continue;
    return true;
  }
  return false;
}

/**
 * The first rule that fires in one statement. `third`: the statement names a third party (see the header), so only the rules that are about the
 * candidate by their own wording, and the matches that are the writer's own words, count.
 */
function scanStatement(c: string, third: boolean, fragment = false): string | null {
  // Most third-party clauses have no first-person word in them: for those the rules that can be set aside are not even run.
  const writer = third && FIRST_PERSON_ANY.test(c);
  for (const p of STATEMENT_PATTERNS) {
    if (fragment && p.piece) continue;
    if (!third || p.suppressible === false) { if (ruleFires(p, c, false)) return p.name; }
    else if (writer && ruleFires(p, c, true)) return p.name;
  }
  if (!third) for (const p of DEV_PATTERNS) if (p.re.test(c)) return p.name;
  return null;
}

const namesAThirdParty = (c: string): boolean => THIRD_PARTY_CUE.test(c) && !EXPLICIT_CANDIDATE.test(c);

function findInClause(c: string): string | null {
  if (!namesAThirdParty(c)) return scanStatement(c, false);
  const whole = scanStatement(c, true);
  if (whole) return whole;
  // A cue word later in the sentence must not shield an earlier statement: "She is a Hindu woman and has worked with 30 clients". The sentence is
  // read statement by statement up to the first one that names a third party; what follows that point goes on about them ("The film follows
  // Meera and her husband").
  const parts = c.split(SUBCLAUSE_CUT_RE);
  if (parts.length < 2) return null;
  for (const part of parts) {
    if (namesAThirdParty(part)) break;
    const hit = scanStatement(part, false, true);
    if (hit) return hit;
  }
  return null;
}

// "36F", "(36M)", "M/34", "34 / F": a letter next to an age, read on the case-preserved text because "24M users" and "f/2.8" are not people.
const LABELLED_AGE_SEX: RegExp[] = [
  /(?<![\w./-])(?:1[89]|[2-6]\d)\s?F(?![\w])/,
  /\(\s*(?:1[89]|[2-6]\d)\s?[FM]\s*\)/,
  /\b(?:is|an?|candidate|applicant|aged|age)\s+(?:1[89]|[2-6]\d)\s?M(?=\s*(?:$|[.,;:!?)]))/,
  /(?<![\w])[FM]\s?[/,|•·]\s?(?:1[89]|[2-6]\d)(?![\w%.])/,
  /(?<![\w.])(?:1[89]|[2-6]\d)\s?[/,|•·]\s?[FM](?![\w&+])/,
];
const LABELLED_QUICK_RE = /\d\s?[FM]\b|\b[FM]\s?[/,|•·]\s?\d|\d\s?[/,|•·]\s?[FM]\b/;
// "Priya, 37, brand lead", "Priya Sharma, 38, a mother of two": a capitalised name, a comma, a working-age number and another comma or the end of the
// piece, at the start of a line or a bio piece (so "the persona \"Neha, 29, ...\"" and a list of cities and counts are not read as one).
const NAME_COMMA_AGE_QUICK_RE = /,\s*(?:1[89]|[2-7]\d)\s*(?:[,|•·.;!?\n]|$)/;
const NAME_COMMA_AGE_RE = /(?:^|[\n|•·●▪‣]\s*|[.!?]\s+)\p{Lu}[\p{L}'’.-]{1,20}(?:\s+\p{Lu}[\p{L}'’.-]{1,20}){0,2}\s*,\s*(?:1[89]|[2-7]\d)(?=\s*(?:,|[|•·.;!?\n]|$))/u;
function hasLabelledAgeSex(raw: string): boolean {
  const labelled = LABELLED_QUICK_RE.test(raw);
  if (!labelled && !NAME_COMMA_AGE_QUICK_RE.test(raw)) return false;
  const kept = stripInvisible(stripInvisible(raw.length > SCAN_LIMIT ? raw.slice(0, SCAN_LIMIT) : raw).normalize('NFKC')).replace(/[^\S\n]+/g, ' ');
  if (labelled && LABELLED_AGE_SEX.some(re => re.test(kept))) return true;
  return NAME_COMMA_AGE_QUICK_RE.test(kept) && !THIRD_PARTY_CUE.test(kept.toLowerCase()) && NAME_COMMA_AGE_RE.test(kept);
}

/**
 * The first rule that says this string states a protected or personal attribute of the person (or carries an e-mail
 * address or phone number), or null. Names: email, phone, subject-attribute, hedged-attribute, attribute-candidate, attribute-person,
 * age, family, appearance, disability, accent, nationality, inference-source, attribute-field, hindi.
 */
export function findProtectedAttribute(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || !text) return null;
  const base = foldText(text);
  if (!base) return null;
  const contact = findContact(base);
  if (contact) return contact;
  for (const reading of readings(base)) {
    for (const clause of clausesOf(reading)) {
      const hit = findInClause(clause);
      if (hit) return hit;
    }
  }
  if (hasLabelledAgeSex(text)) return 'age';
  return null;
}

/**
 * Drops the strings that state a protected or personal attribute of the candidate, or contain an e-mail address or a
 * phone number (see the notes above for exactly what that means and where it stops). `kept` holds the other strings
 * verbatim, in order; `dropped` is how many were removed. Anything that is not a string is ignored.
 */
export function filterProtectedAttributes(strings: string[]): { kept: string[]; dropped: number } {
  const kept: string[] = [];
  let dropped = 0;
  for (const s of Array.isArray(strings) ? strings : []) {
    if (typeof s !== 'string') continue;
    if (findProtectedAttribute(s) === null) kept.push(s);
    else dropped++;
  }
  return { kept, dropped };
}

// ─── Keeping the model blind to personal data on the way IN ──────────────────
//
// WHAT GOES: only the PHRASE that states something personal, never the text around it.
//   - A statement that makes a protected attribute of the person known ("I'm a mother of two", "She is married", "Mom of 2",
//     "35 | F") or carries an e-mail address / phone number is cut out at the smallest piece that holds it: a sentence is judged
//     as a whole first; if it states something, it is split on bullets, pipes, dots, dashes and slashes, then on brackets, then on
//     commas and conjunctions, and only the pieces that state it ON THEIR OWN go ("As a working mother of two, I built the brand
//     voice for a utility" keeps "I built the brand voice for a utility"). A statement that spans every separator takes its whole
//     sentence, and an unpunctuated run is cut in 240-character windows, so nothing is ever left behind for the sake of tidiness.
//   - Years of experience are not removed: the number is replaced IN PLACE by "[years]" ("Brand campaigns I led during my 15 years in
//     advertising: (1) Clean Ganga ..." keeps the whole list of campaigns, only without the 15).
// WHAT STAYS: everything else, character for character, every URL (a URL that itself carries a phone number or an e-mail address is
// dropped on its own), and every duration that is about the WORK ("ran a 3-year campaign", "a 10-year-old brand", "reach grew 3x in 2
// years").
// NOT COVERED, on purpose: a city, a state or a college. Where a person is based or studied is legitimately part of portfolio text
// ("Mumbai launch", "NID alumnus"), is not a protected attribute, and is not masked here. Languages other than English, Hindi and
// Hinglish are the documented limit of the statement rules above (the second review's Tamil / Marathi / Bengali / Telugu
// Roman-script sentences are still read as plain text).

const Y_NUM = '(?<![\\d.,])(?:\\d{1,2}(?:\\.\\d)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[\\s-]?(?:one|two|three|four|five|six|seven|eight|nine))?|thirty|forty)';
const Y_MOD = '(?:(?:over|more\\s+than|nearly|almost|around|about|approximately|roughly|close\\s+to|upwards?\\s+of|just\\s+under|well\\s+over|some)\\s+)?';
// "12 years", "10+ yrs", "over 15 years": but not "6 year old", "3 years ago" or a longer word ("yrsx").
const Y_YEARS = `${Y_MOD}${Y_NUM}\\s*\\+?\\s*(?:years?|yrs?)(?![a-z])(?![\\s-]*old\\b)(?!\\s*(?:ago|back|later|from\\s+now)\\b)`;
const EXPERIENCE_NOUN = '(?:total\\s+|overall\\s+|relevant\\s+|professional\\s+|hands-on\\s+|industry\\s+|work\\s+|working\\s+|combined\\s+|cumulative\\s+)?(?:experience|exp|expertise|track\\s+record)';
const FIELD_NOUN = '(?:marketing|brand\\w*|advertis\\w*|communications?|creative|content|digital|media|pr|b2b|b2c|industry|field|business|sector|sales|design|strategy|startups?|agency|agencies|growth|storytelling|social|influencer)';
const YOE_WORK_NOUN = '(?:work|working|experience|professional|hands-on|marketing|brand|creative|content|digital|industry|leadership|building|leading|managing|growth|full-time|relevant|combined|collective|cumulative)';
const YOE_VERB = '(?:have|having|has|had|bring|brings|bringing|boast|boasting|spent|spend|spending|clocked|accumulated|gained|completed|put\\s+in)';
const HINGLISH_YEARS = '\\d{1,2}\\+?\\s*(?:saal|sal|varsh|baras|years?|yrs?)';

interface YearsPattern { re: RegExp; /** Only where a first-person word ("I", "my", "we") is nearby: the duration may be about the work otherwise. */ firstPerson?: boolean }
const yp = (src: string, firstPerson = false): YearsPattern => ({ re: new RegExp(src, 'dg'), ...(firstPerson ? { firstPerson } : {}) });
// Every pattern has a group `y`: the phrase that is replaced by "[years]".
const YEARS_PATTERNS: YearsPattern[] = [
  yp(`(?<y>${Y_YEARS})'?s?\\s+(?:of\\s+)?${EXPERIENCE_NOUN}`),
  yp(`(?<y>${Y_YEARS})\\s+(?:in|within|across)\\s+(?:the\\s+)?(?:\\w+\\s+){0,2}${FIELD_NOUN}`),
  yp(`(?<y>${Y_YEARS})\\s+as\\s+an?\\s+`),
  yp(`(?<y>${Y_YEARS})\\s+(?:building|leading|managing|driving|running|creating|shaping|crafting|heading|handling|working|doing|growing|scaling|launching|designing|writing)\\b`),
  yp(`(?:experience|exp|tenure)\\s*(?:of|:|=|-)\\s*(?<y>${Y_YEARS})`),
  // A bio's "12 yrs" (the abbreviation, standing alone at the end of its piece).
  yp(`(?<y>${Y_NUM}\\s*\\+?\\s*yrs?)(?![a-z])(?=\\s*(?:[.,;|•·/)]|$))`),
  yp('\\byoe\\b\\s*[:=-]?\\s*(?<y>\\d{1,2}(?:\\.\\d)?\\+?)'),
  yp('(?<![\\d.])(?<y>\\d{1,2}(?:\\.\\d)?\\+?)\\s*yoe\\b'),
  yp(`${FIELD_NOUN}\\s+for\\s+(?:the\\s+(?:past|last)\\s+)?(?<y>${Y_YEARS})`),
  yp(`(?<y>${Y_NUM}[\\s-]+(?:years?|yrs?))[\\s-]+(?:career|veteran|long\\s+career)`),
  yp(`(?<y>(?:(?:over|more\\s+than|nearly|almost)\\s+)?(?:a|one|two|three|four)\\s+decades?)\\s+(?:of\\s+experience|in\\s+(?:the\\s+)?${FIELD_NOUN}|at\\b|with\\b|as\\b)`),
  yp(`career\\s+(?:spanning|of)\\s+(?<y>${Y_YEARS})`),
  yp(`(?:${FIELD_NOUN}|working|worked|career|industry|experience)\\s+(?:professional\\s+)?(?:\\w+\\s+){0,2}?(?<y>since\\s+(?:19[5-9]\\d|20[0-2]\\d))\\b`),
  // "my 12 years", "my last 8 years", "I have 12 years of work across D2C", "12 years at Zomato", "Over my 12 years in ..."
  yp(`\\bmy\\s+(?:\\w+\\s+){0,2}?(?<y>${Y_YEARS})`),
  // A bio fragment that opens with the number: "12 years at Zomato, 5 at Swiggy", "7 years with Tata".
  yp(`(?:^|[.!?;|•·\\n]\\s*)(?<y>${Y_YEARS})\\s+(?:at|with|in(?!\\s+the\\s+making)|across|of\\s+${YOE_WORK_NOUN})\\b`),
  yp(`${YOE_VERB}\\s+(?:\\w+\\s+)?(?<y>${Y_YEARS})`, true),
  yp(`(?<y>${Y_YEARS})\\s+(?:at|with|in|across|within|under|working|handling|managing|driving|running|doing)\\b`, true),
  yp(`(?<y>${Y_YEARS})\\s+of\\s+${YOE_WORK_NOUN}\\b`, true),
  // Hinglish: "10 saal ka experience", "experience: 8 saal", "10 saal se marketing mein hoon"
  yp(`(?<y>${HINGLISH_YEARS})\\s+(?:ka\\s+|ke\\s+|ki\\s+)?(?:anubhav|experience|exp)\\b`),
  yp(`(?:anubhav|experience)\\s*[:=-]?\\s*(?:ka\\s+|of\\s+)?(?<y>${HINGLISH_YEARS})`),
  yp('(?<y>\\d{1,2}\\+?\\s*(?:saal|sal|varsh|baras))\\s+se\\s+(?:\\w+\\s+){0,2}(?:mein|me)\\s+(?:hoon|hun|hu|hai|kaam|kar)'),
];
const YEARS_QUICK_RE = /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|decades?|yoe)\b/i;
const FIRST_PERSON_RE = /\b(?:i|i am|i have|my|me|myself|we|our|ours)\b/;
const YEARS_TOKEN = '[years]';

/** The ranges of `text` (original indices) that state a number of years of experience. */
function yearsRanges(text: string): Array<[number, number]> {
  if (!YEARS_QUICK_RE.test(text)) return [];
  const f = foldWithMap(text);
  const t = f.text;
  const found: Array<[number, number]> = [];
  for (const p of YEARS_PATTERNS) {
    for (const m of t.matchAll(p.re)) {
      const g = (m as RegExpMatchArray & { indices?: { groups?: Record<string, [number, number]> } }).indices?.groups?.y;
      if (!g) continue;
      if (p.firstPerson && !FIRST_PERSON_RE.test(t.slice(Math.max(0, g[0] - 160), g[1] + 40))) continue;
      const from = f.start ? (f.start[g[0]] as number) : g[0];
      const to = f.end ? (f.end[g[1] - 1] as number) : g[1];
      found.push([from, to]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] < last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** `text` with every statement of years of experience replaced by "[years]" (nothing else changes). */
export function replaceYearsOfExperience(text: string): { text: string; count: number } {
  const ranges = yearsRanges(text);
  if (ranges.length === 0) return { text, count: 0 };
  let out = '';
  let pos = 0;
  for (const [from, to] of ranges) { out += text.slice(pos, from) + YEARS_TOKEN; pos = to; }
  return { text: out + text.slice(pos), count: ranges.length };
}

const WINDOW = 1_500;
const WINDOW_OVERLAP = 200;
/**
 * Cuts a piece longer than WINDOW into windows at a space, so no part of a long text sits past the scan limit. Each window starts
 * WINDOW_OVERLAP characters before the previous one ended, so a statement that straddles a cut is whole in one of them.
 */
function windows(piece: string): string[] {
  if (piece.length <= WINDOW) return [piece];
  const out: string[] = [];
  let rest = piece;
  while (rest.length > WINDOW) {
    let cut = rest.lastIndexOf(' ', WINDOW);
    if (cut < WINDOW / 2) cut = WINDOW;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut - WINDOW_OVERLAP);
  }
  if (rest) out.push(rest);
  return out;
}

// A sentence ends at . ! ? or ; that follows a non-space (so "jane . doe @ x . com" stays whole), plus any closing quote or bracket.
const CLOSERS = `"'${String.fromCharCode(0x201d, 0x2019)})\\]`;
const SENTENCE_SPLIT_RE = new RegExp(`((?<=\\S[.!?;][${CLOSERS}]*)\\s+)`, 'u');
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
function hasContactDetail(s: string): boolean {
  const t = foldText(s);
  return t !== '' && findContact(t) !== null;
}

/** The text with its URLs left out (a URL is judged on its own: an id like "?id=9876543210" must not cost the words around it). */
const withoutUrls = (s: string): string => (s.includes('://') ? s.replace(URL_RE, ' ') : s);
const urlsOf = (s: string): string[] => (s.includes('://') ? (s.match(URL_RE) ?? []).filter(u => !hasContactDetail(u)) : []);

/** True when this piece (URLs aside) states a protected attribute of the person or carries an e-mail address or a phone number. */
function statesSomethingPersonal(piece: string): boolean {
  const bare = withoutUrls(piece);
  if (bare.trim() === '') return false;
  for (const w of windows(bare)) if (findProtectedAttribute(w) !== null) return true;
  return false;
}

interface Piece { t: string; sep: string }
/** `text` cut at every match of `re` (global): each piece with the separator that follows it ('' for the last one, and for a zero-width cut). */
function cutAt(text: string, re: RegExp): Piece[] {
  const out: Piece[] = [];
  let pos = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index as number;
    if (m[0] === '') {
      if (at <= pos || at >= text.length) continue;
      out.push({ t: text.slice(pos, at), sep: '' });
      pos = at;
    } else {
      out.push({ t: text.slice(pos, at), sep: m[0] });
      pos = at + m[0].length;
    }
  }
  out.push({ t: text.slice(pos), sep: '' });
  return out.filter(p => p.t !== '' || p.sep !== '');
}

// Level 0: bullets, pipes, middle dots, spaced dashes and slashes ("Mom of 2 • Marketer • She/her"). Level 1: brackets ("Priya (38, mother
// of two) led"). Level 2: commas and conjunctions. A piece that is only a few words and does not open like a clause ("wife", "a marketer")
// belongs to the piece before it, so "I'm a mother, wife and marketer" is one statement and nothing of it is left behind.
const BULLET_CUT_RE = /\s*[•·●▪◦‣⁃|]\s*|\s+[–—-]\s+|\s+\/\s+/g;
const BRACKET_CUT_RE = /(?=\()|(?<=\))/g;
const CLAUSE_CUT_RE = /\s*,\s+|\s*[–—]\s*|\s+(?:and|but|while|whereas|though|although|which|who|where|so|because|aur|toh|lekin|magar|isliye|kyunki)\s+/gi;
const CLAUSE_START_RE = /^(?:(?:and|but|while|whereas|so|plus|also)\s+)?(?:i|we|my|our|me|she|he|they|it|this|that|these|those|having|working|leading|building|running|managing|handling)\b/i;
const wordsIn = (s: string): number => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;
function clausePieces(text: string): Piece[] {
  const raw = cutAt(text, CLAUSE_CUT_RE);
  const out: Piece[] = [];
  for (const p of raw) {
    const prev = out[out.length - 1];
    if (prev && wordsIn(p.t) < 5 && !CLAUSE_START_RE.test(p.t.trim())) {
      prev.t = prev.t + prev.sep + p.t;
      prev.sep = p.sep;
    } else {
      out.push({ t: p.t, sep: p.sep });
    }
  }
  return out;
}
// Last separator before giving up on a statement: the writer's own "I" / "we" ("as a single mother I learned to prioritise" -> "as a single mother" | "I learned ...").
const PRONOUN_CUT_RE = /(?=\s+(?:i|we)(?![\w'’-]))/gi;
const BARE_CONJUNCTION_RE = /^\s*(?:and|but|so|while|whereas|though|although|which|who|where|because|plus|also)?\s*$/i;
function pronounPieces(text: string): Piece[] {
  const raw = cutAt(text, PRONOUN_CUT_RE);
  const out: Piece[] = [];
  let carry = '';
  for (const p of raw) {
    // A lone "and" in front of the "I" belongs to what follows it, so that dropping the statement does not leave "and" behind.
    if (BARE_CONJUNCTION_RE.test(p.t) && p !== raw[raw.length - 1]) { carry += p.t + p.sep; continue; }
    out.push({ t: carry + p.t, sep: p.sep });
    carry = '';
  }
  return out;
}
const SPLITTERS: Array<(t: string) => Piece[]> = [
  t => cutAt(t, BULLET_CUT_RE),
  t => cutAt(t, BRACKET_CUT_RE),
  clausePieces,
  pronounPieces,
];

const CHUNK = 240;
const STRIDE = 120;
const MAX_CHUNKS = 2_000;
/**
 * The last resort for a statement no separator isolates: a text of at most CHUNK characters goes whole; a longer one is read in
 * overlapping windows and only the windows that state something go (a statement shorter than STRIDE is whole inside at least one).
 */
function dropChunks(text: string): { text: string; dropped: number } {
  const keepUrls = urlsOf(text);
  if (text.length <= CHUNK) return { text: keepUrls.join(' '), dropped: 1 };
  const flagged: Array<[number, number]> = [];
  let windowsRead = 0;
  for (let at = 0; at < text.length; at += STRIDE) {
    if (++windowsRead > MAX_CHUNKS) { flagged.push([at, text.length]); break; }
    const end = Math.min(text.length, at + CHUNK);
    if (statesSomethingPersonal(text.slice(at, end))) flagged.push([at, end]);
    if (end >= text.length) break;
  }
  // Windows said nothing although the whole did (a statement longer than a window): nothing can be isolated, so all of it goes.
  if (flagged.length === 0) return { text: keepUrls.join(' '), dropped: 1 };
  let out = '';
  let pos = 0;
  let removed = '';
  for (const [from, to] of flagged) {
    if (to <= pos) continue;
    const start = Math.max(from, pos);
    out += text.slice(pos, start);
    removed += text.slice(start, to);
    pos = to;
  }
  out += text.slice(pos);
  const urls = urlsOf(removed).filter(u => !out.includes(u));
  return { text: [out, ...urls].join(' ').replace(/ {2,}/g, ' ').trim(), dropped: Math.max(1, flagged.length) };
}

/**
 * `text` (which states something personal as a whole) with only the pieces that state it on their own taken out. A piece that goes
 * leaves its URLs behind.
 */
function localize(text: string, level: number): { text: string; dropped: number } {
  if (level >= SPLITTERS.length) return dropChunks(text);
  const pieces = (SPLITTERS[level] as (t: string) => Piece[])(text);
  if (pieces.length < 2) return localize(text, level + 1);
  const flags = pieces.map(p => statesSomethingPersonal(p.t));
  // Nothing says it alone: the statement runs across this level's separators, so look for it at a finer one.
  if (!flags.some(Boolean)) return localize(text, level + 1);
  // A bare age between the separators ("Priya Sharma, 38, a mother of two ...") belongs to the personal statement next to it.
  pieces.forEach((p, i) => { if (!flags[i] && /^\s*(?:aged\s+)?(?:1[89]|[2-7]\d)\s*$/.test(p.t)) flags[i] = true; });
  const kept: Piece[] = [];
  let dropped = 0;
  let firstDropped = false;
  pieces.forEach((p, i) => {
    if (!flags[i]) { kept.push(p); return; }
    const r = localize(p.t, level + 1);
    dropped += r.dropped;
    if (r.text.trim() === '') { if (kept.length === 0) firstDropped = true; return; }
    kept.push({ t: r.text, sep: p.sep });
  });
  let joined = kept.map((p, i) => p.t + (i < kept.length - 1 ? p.sep : '')).join('');
  if (firstDropped) joined = joined.replace(/^\s*(?:and|but|while|whereas|so|though|although|which|who|where|because)\s+/i, '');
  return { text: joined, dropped };
}

const TERMINATOR_RE = /[.!?]+["'’”)\]]*\s*$/;
const tidy = (s: string): string => s.replace(/ {2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1');

/** One sentence, redacted: contact URLs out, personal statements out at the smallest piece, years of experience made "[years]". */
function redactSentence(sentence: string): { text: string; removed: number } {
  let work = sentence;
  let removed = 0;
  let edited = false;
  const urls = sentence.includes('://') ? sentence.match(URL_RE) ?? [] : [];
  for (const u of urls) {
    if (!hasContactDetail(u)) continue;
    work = work.replace(u, '');   // a URL that itself carries a contact detail goes, wherever it stands
    removed++;
    edited = true;
  }
  if (statesSomethingPersonal(work)) {
    const r = localize(work, 0);
    work = r.text;
    removed++;   // one personal statement, however many pieces of the sentence it took with it
    edited = true;
    if (work.trim() !== '' && !/[.!?]["'’”)\]]*\s*$/.test(work)) work += (sentence.match(TERMINATOR_RE) ?? [''])[0].trimEnd();
  }
  const years = replaceYearsOfExperience(work);
  if (years.count) { work = years.text; removed += years.count; edited = true; }
  if (!edited) return { text: sentence, removed: 0 };
  work = tidy(work);
  return { text: work.trim() === '' ? '' : work, removed };
}

/** One pass of the redaction (see redactPersonalStatements, which repeats it until nothing changes). */
function redactOnce(text: string): { text: string; removed: number } {
  let removed = 0;
  const out: string[] = [];
  // Lines first (their separators are kept), then sentences inside a line (split after . ! ? ; that follows a non-space).
  const lines = text.split(/(\r?\n)/);
  for (let li = 0; li < lines.length; li += 2) {
    const line = lines[li] as string;
    const newline = (lines[li + 1] as string | undefined) ?? '';
    const parts = line.split(SENTENCE_SPLIT_RE);
    let lineOut = '';
    let touched = false;
    for (let pi = 0; pi < parts.length; pi += 2) {
      const sentence = parts[pi] as string;
      const sep = (parts[pi + 1] as string | undefined) ?? '';
      const r = redactSentence(sentence);
      if (r.removed === 0) { lineOut += sentence + sep; continue; }
      removed += r.removed;
      touched = true;
      if (r.text === '') continue;   // the whole sentence went, and its separator with it
      let kept = r.text;
      if (lineOut === '' || /\s$/.test(lineOut)) kept = kept.replace(/^ +/, '');
      lineOut += kept + sep;
    }
    out.push(touched ? lineOut.replace(/[ \t]+$/, '') : lineOut, newline);
  }
  return { text: out.join(''), removed };
}

// An edit can create the shape the next rule needs ("Age: 37 and 12 years of experience" -> "Age: 37 and [years] of experience" is an age, and a sentence
// cut out of the middle joins "since 2009" to the words before it), so one pass is not the whole job: the redaction runs again on its own output
// until a pass changes nothing. Every pass removes characters or turns digits into "[years]", so it ends; the cap is only a bound on the cost.
const MAX_REDACTION_PASSES = 6;

/**
 * Keeps the model blind to personal details in a candidate's answer or a page's text: personal statements are taken out at the
 * smallest piece that holds them, e-mail addresses, phone numbers and URLs carrying them are dropped, and a number of years of
 * experience becomes "[years]". Everything else is kept character for character: the remaining text, every other URL and the
 * original separators. `removed` counts the edits (a statement taken out, a URL dropped, a number of years replaced), over all passes.
 * Idempotent: redacting the result again changes nothing.
 */
export function redactPersonalStatements(text: string): { text: string; removed: number } {
  if (typeof text !== 'string' || text === '') return { text: '', removed: 0 };
  let current = text;
  let removed = 0;
  for (let pass = 0; pass < MAX_REDACTION_PASSES; pass++) {
    const r = redactOnce(current);
    if (r.removed === 0 || r.text === current) break;
    removed += r.removed;
    current = r.text;
  }
  return { text: current, removed };
}

// ─── The candidate's name ────────────────────────────────────────────────────
//
// Two jobs, kept apart on purpose:
//   maskNameTokens()       - privacy: the model never reads the candidate's name (it becomes "[candidate]"), without corrupting the
//                            credit lines of OTHER people ("Amit Sharma" stays "Amit Sharma" for a candidate called Neha Sharma).
//   candidateNameSignal()  - a three-state hint, computed in code, about whether the candidate's name is in a link's material:
//                            'likely' (the full name matches, fuzzily), 'unlikely' (readable text WAS searched and not even one token of
//                            the name is in it) or 'unknown' (a partial match, an unsearchable item, a name that is not in Latin script).
//                            Every positive claim is conservative: a lone shared surname or first name ("Singh", "Kumar", "Priya") never
//                            decides anything, so common names neither advantage nor disadvantage their bearers.

// Honorifics and name particles that are not part of anyone's name for matching purposes. Surnames such as "Kumar" or "Kumari" stay.
const NAME_STOPWORDS = new Set([
  'mrs', 'miss', 'prof', 'professor', 'shri', 'shree', 'smt', 'shrimati', 'sir', 'madam', 'adv', 'capt', 'captain', 'col', 'maj', 'rev', 'hon',
  'bin', 'bint', 'ibn', 'abu', 'van', 'von', 'der', 'den', 'del', 'dos', 'das', 'the', 'and',
]);
// The same, plus the short ones that nameTokens() drops by length, for the signal (which keeps short tokens such as "Li" or "Ng").
const SIGNAL_STOPWORDS = new Set([...[...NAME_STOPWORDS].filter(w => w !== 'das'), 'mr', 'ms', 'dr', 'mx', 'sri']);
// Letters and the combining signs that complete them (a Devanagari vowel sign is part of the letter it follows).
const LETTER_RE = /[\p{L}\p{M}]/gu;
const letterCount = (s: string): number => (s.match(LETTER_RE) ?? []).length;

// full_name is a free-text field of a public form, so its length is the applicant's choice: only the first few tokens of the first few hundred
// characters are ever matched or masked (nobody's name needs more), which keeps the work per text linear in the text, not in the name.
const NAME_MAX_CHARS = 300;
const NAME_MAX_TOKENS = 8;
// hay words x name tokens that candidateNameSignal will compare; past it the answer is 'unknown' (never 'unlikely'), so a huge input cannot pin the worker.
const NAME_WORK_LIMIT = 200_000;

/**
 * The lowercased tokens of a full name that are at least 3 letters long, in order and without repeats (the first 8). Honorifics (Mr, Mrs, Dr, Prof,
 * Shri, Smt ...), particles (van, bin ...) and initials are dropped; surnames, including common ones like "Kumar", are kept.
 */
export function nameTokens(fullName: string): string[] {
  if (typeof fullName !== 'string') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of fullName.slice(0, NAME_MAX_CHARS).normalize('NFKC').toLowerCase().split(/[^\p{L}\p{M}]+/u)) {
    if (!raw || letterCount(raw) < 3 || NAME_STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= NAME_MAX_TOKENS) break;
  }
  return out;
}

// Text folded for name matching, with a map from each folded UTF-16 unit back to the original range it came from, so a match in the
// folded text can be cut out of the original: lower case, accents stripped, look-alike letters folded, invisible characters dropped.
interface Folded { text: string; start: number[] | null; end: number[] | null }
function foldWithMap(raw: string): Folded {
  if (!/[^\x00-\x7f]/.test(raw)) return { text: raw.toLowerCase(), start: null, end: null };
  let out = '';
  const start: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < raw.length;) {
    const cp = raw.codePointAt(i) as number;
    const len = cp > 0xffff ? 2 : 1;
    const ch = raw.slice(i, i + len);
    let f = stripInvisible(ch).normalize('NFKD').toLowerCase().replace(COMBINING_RE, '');
    f = f.replace(LOOKALIKE_RE, c => LOOKALIKE_MAP.get(c) ?? c).normalize('NFC');
    if (f > '\u007f') f = f.replace(NON_ASCII_DIGIT_RE, digitOf);   // Devanagari / Arabic-Indic digits read as the digits they are
    if (f === '') {
      if (end.length) end[end.length - 1] = i + len;   // a mark or invisible character belongs to the letter before it
    } else {
      for (let k = 0; k < f.length; k++) { out += f[k]; start.push(i); end.push(i + len); }
    }
    i += len;
  }
  return { text: out, start, end };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Names that are also ordinary words: only a capitalised, standalone occurrence is masked ("Rose Hunter" in "rose water" and "a hunter-gatherer"
// stays). Over-masking a capitalised "Rose" costs one word; masking every "rose" would corrupt the work it sits in.
const COMMON_WORD_NAMES = new Set([
  'rose', 'hunter', 'brown', 'page', 'grace', 'will', 'young', 'green', 'bell', 'baker', 'gold', 'hill', 'lane', 'park', 'cook', 'king', 'knight',
  'rich', 'wood', 'stone', 'fox', 'wolf', 'swift', 'sharp', 'best', 'strong', 'long', 'short', 'white', 'black', 'gray', 'grey', 'north', 'south',
  'east', 'west', 'summer', 'autumn', 'winter', 'spring', 'faith', 'hope', 'joy', 'pearl', 'ruby', 'amber', 'jade', 'ivy', 'daisy', 'lily', 'violet',
  'iris', 'sky', 'dawn', 'eve', 'june', 'april', 'may', 'august', 'mark', 'guy', 'major', 'mason', 'miller', 'carter', 'porter', 'fisher', 'mills',
  'banks', 'fields', 'rivers', 'woods', 'lake', 'bay', 'dale', 'ford', 'marsh', 'peak', 'ray', 'sage', 'storm', 'drew', 'dean', 'earl', 'duke',
  'prince', 'noble', 'wise', 'sweet', 'love', 'case', 'cash', 'cross', 'crown', 'day', 'diamond', 'fair', 'free', 'frost', 'hall', 'hart', 'heath',
  'hood', 'lamb', 'lark', 'lord', 'lucky', 'moon', 'moss', 'oak', 'pink', 'price', 'quick', 'reed', 'rain', 'sand', 'silver', 'snow', 'star',
  'steel', 'sun', 'sunny', 'swan', 'tiger', 'trust', 'wells', 'wild', 'wing', 'wren',
]);
// Capitalised words that sit next to a surname without being a person's given name: titles, roles, and the second word of a studio or brand name.
const NOT_A_GIVEN_NAME = new Set([
  ...SIGNAL_STOPWORDS, 'hi', 'hello', 'dear', 'thanks', 'thank', 'by', 'led', 'credits', 'credit', 'director', 'creative', 'head', 'lead', 'manager',
  'founder', 'cofounder', 'studio', 'studios', 'films', 'film', 'media', 'design', 'designs', 'designer', 'labs', 'lab', 'works', 'digital', 'agency',
  'group', 'co', 'inc', 'ltd', 'pvt', 'productions', 'production', 'photography', 'brand', 'branding', 'marketing', 'communications',
  'consulting', 'collective', 'network', 'foods', 'creates', 'creations', 'concept', 'copy', 'art', 'strategy', 'strategist', 'writer', 'producer',
  'editor', 'photographer', 'client', 'team', 'associates', 'partners', 'company', 'house', 'ventures', 'solutions', 'services', 'industries',
  'enterprises', 'limited', 'private', 'international', 'global', 'india', 'foundation', 'trust', 'society', 'campaign', 'portfolio', 'work',
  'case', 'study', 'project', 'presents', 'present', 'presented', 'with', 'for', 'and', 'from', 'at', 'in', 'of', 'to', 'the', 'a', 'an',
]);

/** Chunks of the folded text that look like a URL, host, e-mail address or handle: where a name may be glued to other letters. */
function urlishRanges(t: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of t.matchAll(/\S+/g)) {
    const w = m[0];
    if (w.includes('/') || w.startsWith('@') || w.startsWith('#') || w.includes('@') || /[\p{L}\p{N}]\.[\p{L}]{2,}/u.test(w)) {
      ranges.push([m.index as number, (m.index as number) + w.length]);
    }
  }
  return ranges;
}

interface Span { s: number; e: number; token: string; /** Found inside a URL, host, e-mail address or handle rather than standing alone as a word. */ slug: boolean }
/**
 * Where the name's tokens occur in the (folded) text. Always: a token standing alone as a word. Inside a URL, host, e-mail or handle
 * also: a token of 5+ letters anywhere in it, or of exactly 4 letters when it starts a run of letters ("priyasharma.design",
 * "psharma@x.com", but not "rose" in "prose.design").
 */
function findNameSpans(t: string, tokens: string[]): Span[] {
  if (tokens.length === 0 || t === '') return [];
  const folded = tokens.map(tok => foldWithMap(tok).text).filter(Boolean);
  const byLength = [...new Set(folded)].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  if (byLength.length === 0) return [];
  const spans: Span[] = [];
  const key = new Set<string>();
  const push = (s: number, e: number, token: string, slug: boolean) => { const k = `${s}:${e}`; if (!key.has(k)) { key.add(k); spans.push({ s, e, token, slug }); } };
  const alt = byLength.map(escapeRe).join('|');
  for (const m of t.matchAll(new RegExp(`(?<![\\p{L}\\p{M}])(?:${alt})(?![\\p{L}\\p{M}])`, 'gu'))) push(m.index as number, (m.index as number) + m[0].length, m[0], false);
  const long = byLength.filter(x => letterCount(x) >= 5);
  const four = byLength.filter(x => letterCount(x) === 4);
  const ranges = urlishRanges(t);
  if (ranges.length) {
    const patterns: RegExp[] = [];
    if (long.length) patterns.push(new RegExp(`(?:${long.map(escapeRe).join('|')})`, 'gu'));
    if (four.length) patterns.push(new RegExp(`(?<![\\p{L}\\p{M}])(?:${four.map(escapeRe).join('|')})`, 'gu'));
    for (const re of patterns) {
      let cursor = 0;   // matches arrive in order, so the chunk list is walked once
      for (const m of t.matchAll(re)) {
        const s = m.index as number;
        while (cursor < ranges.length && (ranges[cursor] as [number, number])[1] <= s) cursor++;
        const range = ranges[cursor];
        if (range && s >= range[0]) push(s, s + m[0].length, m[0], true);
      }
    }
  }
  return spans.sort((a, b) => a.s - b.s || b.e - a.e);
}

// ── Fuzzy token comparison (shared by the signal and by the masking exemption) ──
const MOHAMMAD_FORMS = new Set(['md', 'mohd', 'mohammad', 'mohammed', 'muhammad', 'muhammed', 'mohamed', 'mohamad', 'mohamud', 'muhamad', 'mahomed', 'mehmood']);
/** A spelling-insensitive form of a (folded, lower-case) name token: the usual Indian transliteration variants read the same. */
const PHONETIC_CACHE = new Map<string, string>();
function phonetic(t: string): string {
  if (MOHAMMAD_FORMS.has(t)) return 'mohammad';
  const known = PHONETIC_CACHE.get(t);
  if (known !== undefined) return known;
  const out = phoneticOf(t);
  if (PHONETIC_CACHE.size >= 20_000) PHONETIC_CACHE.clear();   // a bound, not a policy: the words of one text are few and repeat
  PHONETIC_CACHE.set(t, out);
  return out;
}
function phoneticOf(t: string): string {
  return t.replace(/w/g, 'v').replace(/ph/g, 'f').replace(/sh/g, 's').replace(/kh/g, 'k').replace(/gh/g, 'g').replace(/dh/g, 'd').replace(/bh/g, 'b')
    .replace(/th/g, 't').replace(/ck/g, 'k').replace(/q/g, 'k').replace(/z/g, 'j').replace(/ee|ii/g, 'i').replace(/oo|uu/g, 'u').replace(/aa/g, 'a')
    .replace(/y$/, 'i').replace(/(.)\1+/g, '$1');
}
const trimEnding = (p: string): string => p.replace(/[ah]+$/, '');
/** Edit distance of at most one (insertion, deletion or substitution). */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}
/**
 * Do two folded name tokens read as the same name? Equal, or equal after the transliteration folds (Shreya / Sreya, Ghoshal / Ghosal,
 * Mohd / Mohammed), or one edit apart when 5+ letters long, or one a prefix of the other (Sundar / Sundaram, Venkat / Venkataraman) when the
 * shorter is 6+ letters, or 4+ with at most two letters left over. Tokens of fewer than 3 letters only match exactly.
 */
function sameNameToken(a: string, b: string): boolean {
  if (a === b) return true;
  if (MOHAMMAD_FORMS.has(a) && MOHAMMAD_FORMS.has(b)) return true;   // "Md" is two letters, the only short token that can name someone
  if (a.length < 3 || b.length < 3) return false;
  const pa = phonetic(a);
  const pb = phonetic(b);
  if (pa === pb || trimEnding(pa) === trimEnding(pb)) return true;
  if (Math.min(pa.length, pb.length) >= 5 && withinOneEdit(pa, pb)) return true;
  const [shorter, longer] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  return longer.startsWith(shorter) && (shorter.length >= 6 || (shorter.length >= 4 && longer.length - shorter.length <= 2));
}

const isLatinName = (name: string): boolean => {
  const letters = name.normalize('NFKC').replace(/[^\p{L}]/gu, '');
  return letters !== '' && /^\p{Script=Latin}+$/u.test(letters);
};

interface FormToken { t: string; len: number }
/** The tokens of a name as typed in the form: folded, honorifics and particles dropped, initials kept (length 1). */
function signalTokens(fullName: string): FormToken[] {
  const out: FormToken[] = [];
  for (const raw of foldWithMap(fullName.slice(0, NAME_MAX_CHARS).normalize('NFKC')).text.split(/[^\p{L}\p{M}]+/u)) {
    if (!raw || SIGNAL_STOPWORDS.has(raw)) continue;
    out.push({ t: raw, len: letterCount(raw) });
    if (out.length >= NAME_MAX_TOKENS) break;
  }
  return out;
}

interface HayWord {
  w: string;
  /** Starts with a capital letter in the original text. */
  cap: boolean;
  /** A single capital letter in the original ("P." in "P. Sharma"). */
  initial: boolean;
  /** True when something other than spaces, hyphens or an initial's full stop (a comma, a full stop, a colon, a bullet, a line ...) lies between this word and the one before it. */
  breakBefore: boolean;
  /** Where the word starts and ends in the FOLDED text (see foldWithMap). */
  s: number;
  e: number;
}
const MAX_HAY_WORDS = 30_000;
/** The words of a text, folded, with their case and whether punctuation separates each from the word before it (a name does not run across a comma or a full stop). */
function hayWords(text: string): HayWord[] {
  const out: HayWord[] = [];
  const folded = foldWithMap(text);
  const ranges = urlishRanges(folded.text);   // in a handle, a slug or an address a dot or an underscore joins the parts of a name ("priya.sharma", "jose_alvarez@x.com")
  let cursor = 0;
  let prevEnd = 0;
  let prevRange = -1;
  for (const m of folded.text.matchAll(/[\p{L}\p{M}]+/gu)) {
    if (out.length >= MAX_HAY_WORDS) break;
    const at = m.index as number;
    while (cursor < ranges.length && (ranges[cursor] as [number, number])[1] <= at) cursor++;
    const range = cursor < ranges.length && at >= (ranges[cursor] as [number, number])[0] ? cursor : -1;
    const originalAt = folded.start ? (folded.start[at] as number) : at;
    const cap = /\p{Lu}/u.test(text[originalAt] ?? '');
    const prev = out[out.length - 1];
    const gap = folded.text.slice(prevEnd, at);
    // "P. Sharma" and "Md. Imran Khan": the full stop after an initial or after the usual abbreviation of Mohammed does not end the name.
    const joined = /^[\s'’-]*$/.test(gap) || (prev !== undefined && (prev.initial || MOHAMMAD_FORMS.has(prev.w)) && /^\.\s*$/.test(gap)) || (range >= 0 && range === prevRange && /^[\s'’._+-]*$/.test(gap));
    out.push({ w: m[0], cap, initial: m[0].length === 1 && cap, breakBefore: prev !== undefined && !joined, s: at, e: at + m[0].length });
    prevEnd = at + m[0].length;
    prevRange = range;
  }
  return out;
}

export type NameSignal = 'likely' | 'unlikely' | 'unknown';
const NEAR = 3;   // words: the given name and the family name of one person (with up to two middle names) sit this close together

/** A range of the FOLDED text and the word it belongs to; found once, used by the signal ("is the name here?") and by the mask ("where, exactly?"). */
interface NameEvidence {
  /** Hay positions of words that are part of a full-name match: two different tokens of the name sitting together (given name and family name, in either order, spellings compared fuzzily). */
  words: Set<number>;
  /** "priyasharma", "psharma": two tokens (or an initial and the family name) written together inside one word: [word position, from, to] within the word. */
  glued: Array<[number, number, number]>;
  /** The initials (or words that start with the form name's initial) found next to a matched token: part of `words` too, and a full stop after them goes with them. */
  initialWords: Set<number>;
  /** A full-name match exists (words, glued or initials). */
  found: boolean;
  /** Some token matched somewhere, with or without a partner. */
  anyMatch: boolean;
  hay: HayWord[];
}

/**
 * Where the candidate's FULL name is in a text, spelling-insensitively: the one matcher behind both the signal and the masking, so that what the
 * signal calls "found" is exactly what the mask can cover. Returns null when the form name has nothing to match, or when the work (hay words x name
 * tokens) is over NAME_WORK_LIMIT: callers must then say "unknown", never "not there".
 * `first`: stop at the first full-name match (the signal only needs to know that there is one).
 */
function nameEvidence(formName: string, text: string, first: boolean): { names: FormToken[]; initials: string[]; ev: NameEvidence } | 'over-budget' | null {
  const tokens = signalTokens(formName);
  const names = tokens.filter(x => x.len >= 2);
  const initials = tokens.filter(x => x.len === 1).map(x => x.t);
  if (names.length === 0) return null;
  const hay = hayWords(text);
  if (hay.length * names.length > NAME_WORK_LIMIT) return 'over-budget';
  const ev: NameEvidence = { words: new Set(), glued: [], initialWords: new Set(), found: false, anyMatch: false, hay };

  // Positions in the text where each name token matches.
  const hits: number[][] = names.map(() => []);
  hay.forEach((h, pos) => {
    names.forEach((n, i) => {
      if (COMMON_WORD_NAMES.has(n.t) && !h.cap) return;   // "rose water" is not Rose
      if (sameNameToken(n.t, h.w)) (hits[i] as number[]).push(pos);
    });
  });
  ev.anyMatch = hits.some(h => h.length > 0);

  // Two positions belong to one name when they are a few words apart with nothing but spaces (or an initial's full stop) between them, and any word
  // between them is capitalised ("Priya Kumari Sharma", "Priya M. Sharma"): "Amit Sharma and Priya Nair" is two people, not Priya Sharma.
  const together = (p: number, q: number): boolean => {
    const lo = Math.min(p, q);
    const hi = Math.max(p, q);
    if (lo === hi || hi - lo > NEAR) return false;
    for (let k = lo + 1; k <= hi; k++) if ((hay[k] as HayWord).breakBefore) return false;
    for (let k = lo + 1; k < hi; k++) if (!(hay[k] as HayWord).cap) return false;
    return true;
  };
  // Pairs of positions of two tokens that sit together. Only the few positions within NEAR of each other are looked at, so a text that is one
  // matching word repeated 30,000 times costs 7 checks per word, not 30,000.
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (names[i]!.t === names[j]!.t) continue;
      const inJ = new Set(hits[j] as number[]);
      for (const p of hits[i] as number[]) {
        for (let d = -NEAR; d <= NEAR; d++) {
          if (d !== 0 && inJ.has(p + d) && together(p, p + d)) {
            ev.found = true;
            ev.words.add(p);
            ev.words.add(p + d);
            if (first) return { names, initials, ev };
          }
        }
      }
    }
  }
  // "priyasharma", "psharma": two tokens (or an initial and the family name) written together.
  const joined: string[] = [];
  const initialJoined: Array<{ s: string; maxLen: number }> = [];
  for (const b of names) {
    if (b.len < 4) continue;
    for (const a of names) if (a.t !== b.t) joined.push(a.t + b.t);
    for (const letter of new Set([...initials, ...names.filter(n => n.t !== b.t).map(n => n.t[0] as string)])) initialJoined.push({ s: letter + b.t, maxLen: b.t.length + 5 });
  }
  hay.forEach((h, pos) => {
    if (h.w.length < 6) return;
    for (const j of joined) {
      const at = h.w.indexOf(j);
      if (at >= 0) ev.glued.push([pos, at, at + j.length]);
    }
    for (const j of initialJoined) if (h.w.length <= j.maxLen && h.w.startsWith(j.s)) ev.glued.push([pos, 0, j.s.length]);
  });
  if (ev.glued.length) { ev.found = true; if (first) return { names, initials, ev }; }
  // An initial standing next to a matched token: "P. Sharma" for "Priya Sharma" (a single capital letter in the text), or "Priya Sharma"
  // in the text for a form name that was typed "P. Sharma" (a word that starts with the initial).
  if (names.length >= 2 || initials.length >= 1) {
    for (let i = 0; i < names.length; i++) {
      for (const p of hits[i] as number[]) {
        for (let q = Math.max(0, p - 2); q <= Math.min(hay.length - 1, p + 2); q++) {
          if (q === p || !together(p, q)) continue;
          const word = hay[q] as HayWord;
          if ((word.initial && names.some((n, j) => j !== i && n.t[0] === word.w)) || (initials.some(c => word.w[0] === c) && !sameNameToken(names[i]!.t, word.w))) {
            ev.found = true;
            ev.words.add(p);
            ev.words.add(q);
            ev.initialWords.add(q);
            if (first) return { names, initials, ev };
          }
        }
      }
    }
  }
  return { names, initials, ev };
}

/**
 * Whether the candidate's name is in a piece of material, as one of three answers that are each conservative:
 *  - 'likely'   : the FULL name matches. For a name of two or more tokens, at least two different tokens match (given name and family name, in any
 *                 order, within a few words of each other; an initial may stand in for the given name; spellings are compared fuzzily, see
 *                 sameNameToken; "priyasharma" in a slug counts). For a one-token name, a whole-token match of 4+ letters.
 *  - 'unlikely' : ONLY when readable text really was searched (`hasSearchableText`: a text layer or page text, not an image-only file, not a bio
 *                 or a title alone), the name is written in Latin script, and not one token of 3+ letters matches anywhere in it.
 *  - 'unknown'  : everything else: a lone shared surname or first name (partial), no searchable text, a name in another script, nothing to search for,
 *                 more work than the budget allows (an enormous form name or text).
 * `text` is whatever the caller is willing to search: the visible text, titles and the host (and, on a profile site, the first path segments) of the
 * address, NEVER the query string, the fragment or measured facts (a candidate controls those). See urlNameText().
 */
export function candidateNameSignal(formName: string, opts: { text: string; hasSearchableText: boolean }): NameSignal {
  if (typeof formName !== 'string') return 'unknown';
  const text = typeof opts?.text === 'string' ? opts.text : '';
  const found = nameEvidence(formName, text, true);
  if (found === null || found === 'over-budget') return 'unknown';
  const { names, initials, ev } = found;

  if (names.length >= 2 || initials.length >= 1) {
    if (ev.found) return 'likely';
    if (ev.anyMatch) return 'unknown';   // one token only: a lone surname or first name decides nothing
  } else {
    const single = names[0] as FormToken;
    if (ev.anyMatch) return single.len >= 4 ? 'likely' : 'unknown';
  }

  // Nothing matched. That is only a statement about the name if we really looked, and could read it.
  if (!opts?.hasSearchableText || !isLatinName(formName)) return 'unknown';
  if (!names.some(n => n.len >= 3)) return 'unknown';
  return 'unlikely';
}

/**
 * The ranges (of the ORIGINAL text) that make up a full-name match beyond what exact-token masking already covers: the spellings the signal reads
 * as the same name ("Sreya Ghosal" for Shreya Ghoshal, "Md. Imran Khan" for Mohammed Imran Khan, "Priyaa Sharmaa"), a name written as one word
 * ("PriyaSharmaCreative", "psharma"), and an initial next to the family name. A word is masked only as part of a full-name match (two tokens of the
 * name together), so a lone shared surname or given name, which the signal does not count either, is left as it is.
 */
function fuzzyNameRanges(formName: string, text: string, folded: Folded): Array<[number, number]> {
  const found = nameEvidence(formName, text, false);   // the ORIGINAL text: capitals matter to the matcher ("Rose" is a name, "rose" a flower)
  if (found === null || found === 'over-budget' || !found.ev.found) return [];
  const { ev } = found;
  const out: Array<[number, number]> = [];
  const originalStart = (at: number): number => (folded.start ? (folded.start[at] as number) : at);
  const originalEnd = (at: number): number => (folded.end ? (folded.end[at - 1] as number) : at);
  for (const pos of ev.words) {
    const h = ev.hay[pos] as HayWord;
    let to = originalEnd(h.e);
    if ((ev.initialWords.has(pos) || MOHAMMAD_FORMS.has(h.w)) && text[to] === '.') to++;   // "P." and "Md."
    out.push([originalStart(h.s), to]);
  }
  for (const [pos, from, to] of ev.glued) {
    const h = ev.hay[pos] as HayWord;
    out.push([originalStart(h.s + from), originalEnd(h.s + to)]);
  }
  return out;
}

/** The sites on which the first segments of a path are a person's profile name (behance.net/<name>), so they are searched as well as the host. */
const PROFILE_HOSTS = [
  'behance.net', 'dribbble.com', 'instagram.com', 'linkedin.com', 'medium.com', 'github.com', 'vimeo.com', 'youtube.com', 'facebook.com', 'twitter.com',
  'x.com', 'tiktok.com', 'threads.net', 'pinterest.com', 'issuu.com', 'read.cv', 'linktr.ee', 'bio.link', 'beacons.ai', 'about.me', 'substack.com',
  'adplist.org', 'muckrack.com', 'cargo.site', 'format.com', 'myportfolio.com', 'carrd.co',
];
/**
 * The part of a web address that may be searched for the candidate's name: its host, and on a profile site its first path segments.
 * Never the query string or the fragment (the candidate appends those), and never the path of an arbitrary site.
 */
export function urlNameText(url: string): string {
  if (typeof url !== 'string' || url === '') return '';
  let u: URL;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`); } catch { return ''; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = [host];
  if (PROFILE_HOSTS.some(d => host === d || host.endsWith(`.${d}`))) {
    for (const seg of u.pathname.split('/').filter(Boolean).slice(0, 3)) {
      let s = seg;
      try { s = decodeURIComponent(seg); } catch { /* keep it as it is */ }
      parts.push(s.replace(/^@/, ''));
    }
  }
  return parts.join(' ');
}

// ── Masking ──

interface Neighbour { word: string; folded: string; /** Where the word starts in the original text. */ start: number; /** Where it ends. */ end: number }
/** The word that ends right before `at` (separated by spaces or tabs only) in the ORIGINAL text, if it starts with a capital letter. */
function capitalisedBefore(text: string, at: number): Neighbour | null {
  const base = Math.max(0, at - 40);
  const m = /([\p{Lu}][\p{L}\p{M}'’.-]*)[ \t]+$/u.exec(text.slice(base, at));
  return m ? { word: m[1] as string, folded: foldWithMap((m[1] as string).replace(/[.'’-]+$/, '')).text, start: base + (m.index as number), end: at } : null;
}
/** The word that starts right after `at` (separated by spaces or tabs only) in the ORIGINAL text, if it starts with a capital letter. */
function capitalisedAfter(text: string, at: number): Neighbour | null {
  const m = /^[ \t]+([\p{Lu}][\p{L}\p{M}'’-]*)/u.exec(text.slice(at, at + 40));
  return m ? { word: m[1] as string, folded: foldWithMap(m[1] as string).text, start: at + (m[0].length - (m[1] as string).length), end: at + m[0].length } : null;
}
/** A capitalised word that is plausibly another person's name: three letters or more, not a title or the second word of a studio name, not one of the candidate's own tokens. */
function isOtherName(n: Neighbour | null, tokens: string[]): boolean {
  return n !== null && letterCount(n.folded) >= 3 && !NOT_A_GIVEN_NAME.has(n.folded) && !tokens.some(t => sameNameToken(t, n.folded));
}

/**
 * Replaces occurrences of the candidate's name tokens with "[candidate]": a token standing alone as a word (any case, accents ignored), and
 * inside a URL, host, e-mail address or handle also a token of 5+ letters anywhere in it or of 4 letters at the start of a letter run
 * ("priyasharma.design", "linkedin.com/in/priya-sharma-1a2b3c" and "instagram.com/priya.sharma.creates" all lose both names). Nothing
 * else changes. Three things are NOT masked, because masking them would corrupt other people's credits or the work itself:
 *  - the family name right after a different capitalised given name ("Amit Sharma" for a candidate called Neha Sharma), and the given name
 *    right before a different capitalised family name ("Priya Nair" for Priya Menon), unless the candidate's other token is right next to it
 *    (a middle name: "Priya Kumari Sharma");
 *  - a name that is also an ordinary word (Rose, Hunter, Brown) when it is not capitalised ("rose water", "a hunter-gatherer brand");
 *  - the same word inside a slug, unless the slug also holds another of the candidate's tokens.
 * The name signal is computed on the text BEFORE masking, so the model is never left to guess from what is left.
 * Beyond the exact tokens, whatever the signal reads as a FULL-name match is masked too (nameEvidence, the one matcher behind both): a variant
 * spelling next to its partner ("Sreya Ghosal" for Shreya Ghoshal, "Md. Imran Khan", "Priyaa Sharmaa"), the name written as one word
 * ("PriyaSharmaCreative", "psharma") and an initial beside the family name ("P. Sharma"). A lone variant with no partner is left, as the signal
 * leaves it ("unknown"). Only the first 8 tokens of the first 300 characters of the form name are used.
 */
export function maskNameTokens(text: string, fullName: string): string {
  if (typeof text !== 'string' || text === '') return typeof text === 'string' ? text : '';
  const tokens = nameTokens(fullName);
  if (tokens.length === 0) return text;
  const folded = foldWithMap(text);
  const spans = findNameSpans(folded.text, tokens);
  const fuzzy = fuzzyNameRanges(fullName, text, folded);
  if (spans.length === 0 && fuzzy.length === 0) return text;
  const originalStart = (s: number): number => (folded.start ? (folded.start[s] as number) : s);
  const originalEnd = (e: number): number => (folded.end ? (folded.end[e - 1] as number) : e);
  const multi = tokens.length >= 2;
  const first = tokens[0] as string;
  const last = tokens[tokens.length - 1] as string;
  const masked: Array<[number, number]> = [];
  for (const sp of spans) {
    const from = originalStart(sp.s);
    const to = originalEnd(sp.e);
    if (COMMON_WORD_NAMES.has(sp.token)) {
      // "Rose Hunter" typed in lower case ("rose hunter, brand lead") is still the name: another token of it right next to this one says so.
      const besideAnother = (): boolean => spans.some(o => o !== sp && o.token !== sp.token && !o.slug
        && ((o.s >= sp.e && /^[\s-]{1,3}$/.test(folded.text.slice(sp.e, o.s))) || (o.e <= sp.s && /^[\s-]{1,3}$/.test(folded.text.slice(o.e, sp.s)))));
      if (!sp.slug && !/\p{Lu}/u.test(text[from] ?? '') && !besideAnother()) continue;
      if (sp.slug && !spans.some(o => o !== sp && o.slug && o.token !== sp.token && Math.abs(o.s - sp.s) <= 30)) continue;
    }
    if (multi && !sp.slug && sp.token === last) {
      const before = capitalisedBefore(text, from);
      if (isOtherName(before, tokens)) {
        // "Priya Kumari Sharma": another of the candidate's tokens just before the other word makes it a middle name, not a different person.
        const beforeThat = before ? capitalisedBefore(text, before.start) : null;
        if (!(beforeThat && tokens.some(t => sameNameToken(t, beforeThat.folded)))) continue;
      }
    }
    if (multi && !sp.slug && sp.token === first && sp.token !== last && !COMMON_WORD_NAMES.has(sp.token)) {   // ("Rose Garden" is a place, not another Rose)
      const after = capitalisedAfter(text, to);
      if (isOtherName(after, tokens)) {
        // "Priya Kumari Sharma": the candidate's family name right after the other word makes it a middle name, not a different person.
        const afterThat = after ? capitalisedAfter(text, after.end) : null;
        if (!(afterThat && tokens.some(t => sameNameToken(t, afterThat.folded)))) continue;
      }
    }
    masked.push([from, to]);
  }
  // A fuzzy range that exact masking already covers entirely ("priyasharma" in a slug, both tokens) adds nothing; the rest are added.
  const exact = [...masked].sort((a, b) => a[0] - b[0]);
  const covers: Array<[number, number]> = [];
  for (const r of exact) {
    const last = covers[covers.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else covers.push([r[0], r[1]]);
  }
  fuzzy.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let ci = 0;   // both lists are in order: one walk, however many matches there are
  for (const f of fuzzy) {
    while (ci + 1 < covers.length && (covers[ci + 1] as [number, number])[0] <= f[0]) ci++;
    const c = covers[ci];
    if (!(c && c[0] <= f[0] && f[1] <= c[1])) masked.push(f);
  }
  if (masked.length === 0) return text;
  // Overlapping ranges (an exact token inside a fuzzy match) become one "[candidate]"; ranges that merely touch ("rosemenon") stay two.
  masked.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const r of masked) {
    const last = merged[merged.length - 1];
    if (last && r[0] < last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const parts: string[] = [];
  let pos = 0;
  for (const [from, to] of merged) {
    parts.push(text.slice(pos, from), '[candidate]');
    pos = to;
  }
  parts.push(text.slice(pos));
  return parts.join('');
}

/**
 * Whether the candidate's name appears in the text: the 'likely' answer of candidateNameSignal() (the full name matches, fuzzily). Kept for
 * callers that want a plain boolean; a lone shared surname or first name is NOT enough any more.
 */
export function nameAppears(text: string, fullName: string): boolean {
  if (typeof text !== 'string' || text === '') return false;
  return candidateNameSignal(fullName, { text, hasSearchableText: true }) === 'likely';
}

/**
 * The first full personal name in `text`: two capitalised words in a row that are not titles, roles or the second word of a studio name
 * ("Amit Sharma", "Rina M. Kapoor"; not "Creative Director" or "Studio Nine"). Used to check that a credit line really names a person.
 */
export function findFullPersonName(text: string): string | null {
  if (typeof text !== 'string' || text === '') return null;
  const isNameWord = (w: string): boolean => {
    const bare = w.replace(/[.'’-]+$/, '');
    return letterCount(bare) >= 2 && /\p{Ll}/u.test(bare) && !NOT_A_GIVEN_NAME.has(foldWithMap(bare).text);
  };
  for (const run of text.slice(0, 2_000).matchAll(/\p{Lu}[\p{L}\p{M}'’.-]*(?:[ \t]+\p{Lu}[\p{L}\p{M}'’.-]*){1,3}/gu)) {
    const words = run[0].split(/[ \t]+/);
    for (let i = 0; i + 1 < words.length; i++) {
      const a = words[i] as string;
      const b = words[i + 1] as string;
      // "Rina M. Kapoor": a single initial may sit between the two names.
      if (isNameWord(a) && isNameWord(b)) return `${a} ${b}`;
      const c = words[i + 2];
      if (isNameWord(a) && /^\p{Lu}\.?$/u.test(b) && c !== undefined && isNameWord(c)) return `${a} ${b} ${c}`;
    }
  }
  return null;
}
