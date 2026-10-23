import { describe, it, expect } from 'vitest';
import { findProtectedAttribute, redactPersonalStatements } from './protectedAttributes.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ROUND 4 HELD-OUT SET (fix round 4, engineer E3A): 60 leaks + 60 keeps, written BEFORE any rule of that round was touched and BEFORE the
// numbers were looked at, with wording that differs from every earlier corpus (the reviewers' sets of all three reviews, E3A's three sets).
// Groups: en-out (a reviewer's or model's third-person sentence, seen by the output filter), first-person (many with a portfolio word -
// client, customer, audience, case study, featured - in the same sentence), bio (Instagram-style noun-only lines and bare ages), hinglish,
// contact. A leak counts as caught on the side(s) it is meant for: `out` = the output filter flags it; `in` = the input redaction removes
// something and what is left no longer reads as personal; `both` = both.
//
// FIRST MEASUREMENT (the honest estimate of unseen wording): 36 of 60 leaks (60.0%), 0 of 60 keeps changed. By group: en-out 13/17,
// first-person 7/17, bio 4/14, hinglish 7/7, contact 5/5. The misses were generalised as families (not one sentence at a time): a
// first-person match next to a portfolio word, a cue word later in a sentence, hyphenated and bare ages, "born in <year>" with or without a
// subject, noun-only bio pieces, "mother of twins" / "mom to 2", "I had my second baby", adverbs after the linking verb, "the founder of
// the studio is ...", "in the video is ...", "reads like the work of a ...", "I use a wheelchair", "Name, 31, role". After that the set
// is a regression set (100% by construction): do not tune a rule to one sentence of it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Side = 'out' | 'in' | 'both';
interface Leak { g: string; side: Side; s: string }

const HELDOUT4_LEAKS: Leak[] = [
  // ── English, third person (output filter) ──
  { g: 'en-out', side: 'out', s: 'The portfolio owner is a 52-year-old man who runs a boutique agency.' },
  { g: 'en-out', side: 'out', s: 'She appears to be a Jain woman, going by the festival content.' },
  { g: 'en-out', side: 'out', s: 'The spokesperson is clearly a transgender woman.' },
  { g: 'en-out', side: 'out', s: 'The creator, a Tamil Brahmin, grew up in Chennai.' },
  { g: 'en-out', side: 'out', s: 'Her pregnancy is mentioned in the founder note.' },
  { g: 'en-out', side: 'out', s: 'He is evidently a devout Muslim and posts about Ramadan.' },
  { g: 'en-out', side: 'out', s: 'This applicant is in her late twenties.' },
  { g: 'en-out', side: 'out', s: 'The voice-over artist sounds like an elderly woman.' },
  { g: 'en-out', side: 'out', s: 'Probably Hindu, judging from the temple imagery.' },
  { g: 'en-out', side: 'out', s: 'The candidate is a lesbian entrepreneur.' },
  { g: 'en-out', side: 'out', s: 'Their marital status is divorced.' },
  { g: 'en-out', side: 'out', s: 'She is a widow with three children.' },
  { g: 'en-out', side: 'out', s: 'The founder of the studio is a single mom.' },
  { g: 'en-out', side: 'out', s: 'The narrator has a pronounced Bengali accent.' },
  { g: 'en-out', side: 'out', s: 'The woman in the interview video is in her sixties.' },
  { g: 'en-out', side: 'out', s: 'It looks like the work of a young married woman.' },
  { g: 'en-out', side: 'out', s: 'The designer is deaf and communicates through sign language.' },
  // ── First person, some with a portfolio word (client / audience / case study / featured) in the same sentence ──
  { g: 'first-person', side: 'both', s: "I'm 47 and still love building brands from scratch." },
  { g: 'first-person', side: 'both', s: 'I was born in 1979 in Lucknow.' },
  { g: 'first-person', side: 'both', s: 'My daughter is in Class 5 and my son just started college.' },
  { g: 'first-person', side: 'both', s: 'Being a woman in advertising, I had to fight twice as hard for every client.' },
  { g: 'first-person', side: 'both', s: 'Hi, I am Meera, 33, a mother of one, and I have worked with 20 clients.' },
  { g: 'first-person', side: 'both', s: 'I am expecting my first child in June.' },
  { g: 'first-person', side: 'both', s: 'I use a wheelchair and design accessibility-first campaigns for clients.' },
  { g: 'first-person', side: 'both', s: 'I am a gay man leading an inclusion programme for customers.' },
  { g: 'first-person', side: 'both', s: 'As a first-time mom I redesigned the onboarding journey for customers.' },
  { g: 'first-person', side: 'both', s: 'I am a 38-year-old copywriter and have worked with clients across fintech.' },
  { g: 'first-person', side: 'both', s: 'I have two children under ten and a full-time job.' },
  { g: 'first-person', side: 'both', s: 'My partner and our kids moved to Bengaluru with me.' },
  { g: 'first-person', side: 'both', s: 'I am a Parsi woman and the audience for my campaigns is mostly young families.' },
  { g: 'first-person', side: 'both', s: 'I am a divorced mother and my case studies show how I rebuilt my career.' },
  { g: 'first-person', side: 'both', s: 'As a Muslim woman I partnered with three beauty brands on inclusive launches.' },
  { g: 'first-person', side: 'both', s: 'I am 29 and was featured in a regional ad-industry list.' },
  { g: 'first-person', side: 'both', s: 'I turned 50 last month and started my own studio.' },
  // ── Bios and bare ages (input) ──
  { g: 'bio', side: 'in', s: 'Dad of 3 | Brand builder | Chai first' },
  { g: 'bio', side: 'in', s: 'Mom. Founder. Storyteller.' },
  { g: 'bio', side: 'in', s: 'Wife and mother, marketer by passion.' },
  { g: 'bio', side: 'in', s: 'Proud Sikh. Creative director. Cat dad.' },
  { g: 'bio', side: 'in', s: 'Single mom | Creative lead | Pune' },
  { g: 'bio', side: 'in', s: 'Marketer, runner, mother of a 2-year-old.' },
  { g: 'bio', side: 'in', s: 'Hindu | Brand strategist | Chennai' },
  { g: 'bio', side: 'in', s: 'Divorcee. Designer. Dreamer.' },
  { g: 'bio', side: 'in', s: 'Husband, father, creative director.' },
  { g: 'bio', side: 'in', s: 'Age: 36, Mumbai-based brand lead.' },
  { g: 'bio', side: 'in', s: '42 years old, ex-Ogilvy.' },
  { g: 'bio', side: 'in', s: 'Born 1983 | Brand lead' },
  { g: 'bio', side: 'in', s: 'Sonia, 31, content lead' },
  { g: 'bio', side: 'in', s: 'F, 28, designer' },
  // ── Hinglish ──
  { g: 'hinglish', side: 'both', s: 'Main ek vivahit mahila hoon aur do bacche hain.' },
  { g: 'hinglish', side: 'both', s: 'Meri umar 41 saal hai aur main Delhi se hoon.' },
  { g: 'hinglish', side: 'both', s: 'Mere pati ek doctor hain.' },
  { g: 'hinglish', side: 'both', s: 'Main Jain parivar se hoon aur shakahari hoon.' },
  { g: 'hinglish', side: 'both', s: 'Woh ek Christian aurat hai.' },
  { g: 'hinglish', side: 'both', s: 'Main ek 35 saal ki mahila hoon aur marketing mein kaam karti hoon.' },
  { g: 'hinglish', side: 'both', s: 'Meri beti 6 saal ki hai.' },
  // ── Contact ──
  { g: 'contact', side: 'both', s: 'Text me on 9820 123 456.' },
  { g: 'contact', side: 'both', s: 'Mail: sonia.k@brandlab.co.in' },
  { g: 'contact', side: 'both', s: 'DM or call +91-98765-12345.' },
  { g: 'contact', side: 'both', s: 'Write to priya dot menon at gmail dot com.' },
  { g: 'contact', side: 'both', s: 'reach me: priya [at] studio [dot] co' },
];

const HELDOUT4_KEEPS: string[] = [
  'Campaign for first-time mothers on infant nutrition reached 1.8M parents.',
  'Shot with 40 farmers across Maharashtra; the lead was a widowed farmer from Latur.',
  'Developed the pitch for a Muslim-run textile cooperative in Bhiwandi.',
  'Our hero film features a Sikh truck driver and his daughter.',
  'Rebranded a 14-year-old baby-products company.',
  'Targeted men aged 25 to 34 with a razor launch.',
  'Case study: how a divorced father of two became the face of a legal-aid campaign.',
  'Client is a woman-owned coffee roaster; we built the identity.',
  'The brand is 8 years old and needed a refresh.',
  'Led the Hindu New Year campaign for a regional bank.',
  'Influencer roster: 12 mommy bloggers and 5 dads.',
  'Diwali gifting film starring a Christian couple and their Hindu neighbours.',
  'Positioned the app for single women travellers, +38% installs.',
  'Wrote scripts for a 6-part series on pregnancy care.',
  'Marketing for a wheelchair-basketball league, 30 events.',
  'The campaign hero, a Dalit entrepreneur from Pune, was profiled in six outlets.',
  'Strategy for a nursing-mothers app: 90K downloads in 90 days.',
  'Built the identity for an elderly-care startup.',
  'The team includes 4 women and 6 men across design and copy.',
  'Launch film for a male grooming brand drew 5M views.',
  'Women-led SHG partnership: 800 members onboarded.',
  'Ran Eid and Christmas campaigns for a mall chain.',
  'Aged care provider rebrand, 3 sites.',
  'Designed a matrimony-site onboarding quiz.',
  'Age verification flow redesign for a gaming app.',
  'Audience: men and women 18-35, metro cities.',
  'The mother brand and its three sub-brands were repositioned.',
  'Brand ambassador: a 70-year-old grandmother who went viral for her recipes.',
  'Our 12-year-old product line got a visual refresh.',
  'Interviewed 20 widows for a microfinance film.',
  'Awareness explainer series for the Muslim Personal Law Board, 4 episodes.',
  'Catholic school network enrolment campaign: +22% admissions.',
  'Jewish Museum rebrand pitch shortlisted.',
  'The persona "Neha, 29, product manager" informed the tone.',
  'Pregnant? Ask us: a Q&A series with gynaecologists.',
  'Father figure archetype used in the TVC for a tractor brand.',
  'Women over 50 were the primary audience for the supplement launch.',
  'Gen Z and Gen Alpha were the target for the toy launch.',
  'Hindi, Marathi and Gujarati regional adaptations of the film.',
  'Led brand for a British Council partnership.',
  'The film follows a blind violinist in Delhi.',
  'Grew a parenting community of 60K mothers and fathers.',
  'Husband-and-wife influencer pair, 1.2M followers, signed for the launch.',
  'Retirement-planning campaign for people in their 50s.',
  'Born-digital brand, launched on Instagram.',
  'Pitch deck for a divorce-support startup.',
  'Orphanage donation drive creative: 3 films, 5 cities.',
  'I led 6 people across design, copy and video.',
  'My clients include a Hindu temple trust and a Muslim charity.',
  'I managed the social handles of a Christian university.',
  'We made a 4-film series featuring a pregnant farmer.',
  'I wrote the copy for a campaign celebrating mothers.',
  'I worked with a 60-year-old founder to modernise his family firm.',
  'Created a mother-and-daughter storytelling arc for a saree brand.',
  'Developed brand voice guidelines for a 25-year-old FMCG company.',
  'Maine 12 campaigns launch kiye aur 3 awards jeete.',
  'Main marketing team lead hoon aur 8 logon ki team sambhalti hoon.',
  'Hamari team ne Diwali campaign mein 4 films banayi.',
  'The ad speaks to women in their thirties who run small businesses.',
  'Spent a week shadowing a retired schoolteacher for the documentary.',
];

const caught = (l: Leak): boolean => {
  const out = findProtectedAttribute(l.s) !== null;
  const red = redactPersonalStatements(l.s);
  const inn = red.removed > 0 && findProtectedAttribute(red.text) === null;
  return l.side === 'out' ? out : l.side === 'in' ? inn : out && inn;
};

describe('round 4 held-out set (regression from here on)', () => {
  it('has 60 leaks and 60 keeps', () => {
    expect(HELDOUT4_LEAKS).toHaveLength(60);
    expect(HELDOUT4_KEEPS).toHaveLength(60);
  });
  it.each(HELDOUT4_LEAKS.map(l => [l.g, l.side, l.s] as const))('%s (%s): %s', (g, side, s) => {
    const l = { g, side, s } as Leak;
    expect(caught(l)).toBe(true);
  });
  it('no keep is dropped by the output filter or changed by the input redaction', () => {
    expect(HELDOUT4_KEEPS.filter(k => findProtectedAttribute(k) !== null)).toEqual([]);
    expect(HELDOUT4_KEEPS.filter(k => redactPersonalStatements(k).text !== k)).toEqual([]);
  });
});

// ── The second round-4 set (E3A): written after the first set had been generalised, measured ONCE and not tuned to ──────────────────────────────
// FIRST MEASUREMENT of this set against the code of that moment: 35 of 40 leaks (87.5%) and 39 of 40 keeps clean (the original code of the third
// review: 23/40 and 40/40). By group: en-out 8/10, first-person 7/10, bio 10/10, hinglish 6/6, contact 4/4. Its misses were generalised
// (an adverb in a hedge, "this is a ... woman founder", a lead-in followed by a person noun, a health event such as an injury, a cause
// clause after the statement) and it is a regression set from here on. TWO ROWS ARE LEFT OUT ON PURPOSE and pinned below as limits:
//   - "Being a first-generation graduate, I built ..." (a socio-economic background, not one of the protected attributes the lists cover);
//   - "Our model was a 19-year-old college student who went viral." (the age of a person named in the WORK, a talent: a statement of the
//     shape "<noun> was a N-year-old <person>" cannot be told from one about the candidate, and the cost is one dropped sentence).

const HELDOUT4B_LEAKS: Leak[] = [
  // reviewer / model sentences about the candidate (output filter)
  { g: 'en-out', side: 'out', s: 'The candidate speaks about her pregnancy in the founder story video.' },
  { g: 'en-out', side: 'out', s: 'He is a fifty-something Tamil Brahmin who ran a boutique agency.' },
  { g: 'en-out', side: 'out', s: 'Seems like a recently married woman, since the wedding shoot is featured prominently.' },
  { g: 'en-out', side: 'out', s: 'The candidate identifies as a transgender woman.' },
  { g: 'en-out', side: 'out', s: 'Judging by the surname, the creator is likely a Parsi.' },
  { g: 'en-out', side: 'out', s: 'The candidate has a visible hearing impairment in the intro reel.' },
  { g: 'en-out', side: 'out', s: 'She is in her early forties and has two children.' },
  { g: 'en-out', side: 'out', s: 'This is a Muslim woman founder from Hyderabad.' },
  { g: 'en-out', side: 'out', s: 'The presenter is obviously a young man in his twenties.' },
  { g: 'en-out', side: 'out', s: 'Probably an older gentleman, given the vintage-ad portfolio.' },
  // the writer's own words, with and without portfolio words in the same sentence
  { g: 'first-person', side: 'both', s: 'I am a 33-year-old mother of one and I have run campaigns for 20 clients.' },
  { g: 'first-person', side: 'both', s: 'As a Jain vegetarian I steer clear of meat brands, but my portfolio covers 12 customers.' },
  { g: 'first-person', side: 'both', s: 'My husband and I co-founded the studio after our daughter was born.' },
  { g: 'first-person', side: 'both', s: 'I am a gay man and the audience for my last film was queer youth.' },
  { g: 'first-person', side: 'both', s: 'I was born in 1984 and started my career in print.' },
  { g: 'first-person', side: 'both', s: 'I am an NRI who moved back to Bengaluru in 2019.' },
  { g: 'first-person', side: 'both', s: 'I am recovering from a spinal injury and work remotely for clients.' },
  { g: 'first-person', side: 'both', s: "I'm 29, single, and the case studies below are all mine." },
  { g: 'first-person', side: 'both', s: 'My wife is expecting our second child in March.' },
  // bios and headline fragments
  { g: 'bio', side: 'in', s: 'Marketer | Mother of two | Based in Pune' },
  { g: 'bio', side: 'in', s: 'Sikh. Dad. Brand guy.' },
  { g: 'bio', side: 'in', s: 'Single mum, brand lead, weekend baker.' },
  { g: 'bio', side: 'in', s: '34 yrs old | Creative Director | Delhi' },
  { g: 'bio', side: 'in', s: 'Female, 29 | Copywriter' },
  { g: 'bio', side: 'in', s: 'Aarti, 36, head of content' },
  { g: 'bio', side: 'in', s: 'Wife. Mother. Marketer.' },
  { g: 'bio', side: 'in', s: 'Christian | Creative strategist | Goa' },
  { g: 'bio', side: 'in', s: 'Born in 1990. Designer.' },
  { g: 'bio', side: 'in', s: 'Dad of two | Founder | Chennai' },
  // Hinglish
  { g: 'hinglish', side: 'both', s: 'Main ek shaadi-shuda ladki hoon aur ek beti ki maa hoon.' },
  { g: 'hinglish', side: 'both', s: 'Meri umar 33 saal hai aur main Pune mein rehti hoon.' },
  { g: 'hinglish', side: 'both', s: 'Mere pati aur do bachche Mumbai mein hain.' },
  { g: 'hinglish', side: 'both', s: 'Woh ek Muslim aurat hai jo creative director hai.' },
  { g: 'hinglish', side: 'both', s: 'Main Sikh parivar se hoon aur clients ke saath kaam karta hoon.' },
  { g: 'hinglish', side: 'both', s: 'Main 38 saal ka hoon aur 15 campaigns launch kiye hain.' },
  // contact
  { g: 'contact', side: 'both', s: 'My mobile is 98765 43210, call after 6.' },
  { g: 'contact', side: 'both', s: 'Write to aarti.menon@studio.in for the full deck.' },
  { g: 'contact', side: 'both', s: 'Reach me: aarti (at) brandlab (dot) in' },
  { g: 'contact', side: 'both', s: 'WhatsApp me on +91 90000 12345 anytime.' },
];

const HELDOUT4B_KEEPS: string[] = [
  'Ran a campaign for a baby-food brand that reached 3M mothers.',
  'The film follows a Muslim widow who runs a bakery and her two sons.',
  'Our client is a 70-year-old founder who wanted a modern identity.',
  'Targeted men in their forties with a watch launch, +22% sales.',
  'Rebranded a 25-year-old FMCG company across 12 SKUs.',
  'Campaign hero: a deaf cyclist from Pune who rode 4,000 km.',
  'Launch film starring a married couple and their toddler for a diaper brand.',
  'Case study: how a divorced mother of two rebuilt her bakery with our app.',
  'Audience research with 40 pregnant women across 5 cities.',
  'The brand was born in 1999 and targets college students.',
  'Husband and wife duo run the family-owned sweets chain we rebranded.',
  'Pan-India Eid and Diwali gifting film for a jeweller.',
  'Women aged 25-35 were the core segment for the launch.',
  'The pitch featured a Parsi founder and a Sikh co-founder.',
  'Created the Mother Dairy summer jingle and 3 films.',
  'Christian Louboutin-inspired packaging for a footwear label.',
  'She led the creative team that won two Effies.',
  'I led a team of eight across design, copy and video.',
  'We shot the film with 60 farmers in Maharashtra.',
  'Led the Hindu New Year campaign for a bank, 3 films.',
  'My clients include a Jain trust, a Sikh gurdwara and a Muslim charity.',
  'I managed influencer partnerships with 30 dads and moms on Instagram.',
  'Strategy for a matrimony app aimed at single professionals.',
  'Wrote the script for a film on a single father raising twins.',
  'The founder, a former army officer, hired us for the rebrand.',
  'Developed a persona: Meera, 34, working mother, metro city.',
  'Delivered 5 campaigns in 3 years with a team of 4.',
  'We grew the community to 90K members, mostly women.',
  'Blind-test activation for a cola brand in 6 cities.',
  'The ad targeted teenagers and their parents in tier-2 towns.',
  'Rolled out a senior-citizen health insurance campaign.',
  'Designed the Women\'s Day microsite for a retail chain.',
  'Main brand strategy aur copywriting sambhalta hoon.',
  'Hamari team ne 12 campaigns launch kiye aur 3 awards jeete.',
  'Maine Diwali campaign mein 4 films banayi.',
  'Agency partner for the Indian Premier League sponsor.',
  'The deck shows a 12-year-old company that pivoted to D2C.',
  'Parent company approvals took 6 weeks, so we phased the launch.',
  'Got the Black Friday campaign live in 9 days.',
];

describe('round 4 second set (regression; first measured at 35/40 leaks and 39/40 keeps clean)', () => {
  it('has 39 leaks and 39 keeps (one borderline leak and one borderline keep are pinned separately)', () => {
    expect(HELDOUT4B_LEAKS).toHaveLength(39);
    expect(HELDOUT4B_KEEPS).toHaveLength(39);
  });
  it.each(HELDOUT4B_LEAKS.map(l => [l.g, l.side, l.s] as const))('%s (%s): %s', (g, side, s) => {
    expect(caught({ g, side, s } as Leak)).toBe(true);
  });
  it('no keep is dropped by the output filter or changed by the input redaction', () => {
    expect(HELDOUT4B_KEEPS.filter(k => findProtectedAttribute(k) !== null)).toEqual([]);
    expect(HELDOUT4B_KEEPS.filter(k => redactPersonalStatements(k).text !== k)).toEqual([]);
  });
  it('the two documented limits: a socio-economic background is not removed, and the age of a talent in the work is', () => {
    expect(findProtectedAttribute('Being a first-generation graduate, I built my first brand for a customer in Indore.')).toBeNull();
    expect(findProtectedAttribute('Our model was a 19-year-old college student who went viral.')).not.toBeNull();
  });
});
