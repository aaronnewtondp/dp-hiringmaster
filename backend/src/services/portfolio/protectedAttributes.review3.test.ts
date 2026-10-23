import { describe, it, expect } from 'vitest';
import { findProtectedAttribute, redactPersonalStatements } from './protectedAttributes.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE THIRD REVIEW'S HELD-OUT SET (regression from here on). Written by the reviewer, never shown to the fixers: the output filter caught
// 51 of its 61 leaks (83.6%), the input redaction 27 of 33 on the first-person / Hinglish / contact rows, 0 of 67 keeps were dropped or changed,
// and 12 of 19 whole answers came out as they should. Its misses (a hyphenated "41-year-old brand strategist", a bare "37 years old",
// "Born in 1987", noun-only bios, "Mother of twins", "is evidently Christian", "a Nigerian national", the Hinglish "N saal ka experience"
// being read as an age, ...) were generalised in fix round 4 and every row below passes. The groups: en-reviewer = a third-person sentence
// (output filter), first-person / hinglish / contact = the writer's own words (output filter AND input redaction).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Leak { s: string; group: string; side: 'out' | 'in' | 'both' }

const LEAKS: Leak[] = [
  // ---- English reviewer-style (the OUTPUT filter sees these) ----
  { group: 'en-reviewer', side: 'out', s: 'The creator looks to be in her late thirties and speaks with a Southern accent.' },
  { group: 'en-reviewer', side: 'out', s: 'Going by her surname, the founder is probably a Sikh woman from Punjab.' },
  { group: 'en-reviewer', side: 'out', s: 'Candidate seems newly married, judging by the wedding references on the page.' },
  { group: 'en-reviewer', side: 'out', s: 'The presenter is a heavyset man in his fifties.' },
  { group: 'en-reviewer', side: 'out', s: 'She mentions being a working mother of three throughout the deck.' },
  { group: 'en-reviewer', side: 'out', s: 'This applicant is evidently Christian, given the church-run campaigns.' },
  { group: 'en-reviewer', side: 'out', s: 'As a divorced woman herself, the candidate brings empathy to the narrative.' },
  { group: 'en-reviewer', side: 'out', s: 'The author, a 29-year-old female, led the team.' },
  { group: 'en-reviewer', side: 'out', s: 'He is a Nigerian national working in India.' },
  { group: 'en-reviewer', side: 'out', s: "The candidate's religion appears to be Jain." },
  { group: 'en-reviewer', side: 'out', s: 'The designer is visually impaired and uses screen readers.' },
  { group: 'en-reviewer', side: 'out', s: 'Probably a fresh graduate in her early twenties.' },
  { group: 'en-reviewer', side: 'out', s: "She's a mum of two toddlers." },
  { group: 'en-reviewer', side: 'out', s: 'The person on the founder video is elderly.' },
  { group: 'en-reviewer', side: 'out', s: 'The candidate is gay and has run LGBTQ campaigns.' },
  { group: 'en-reviewer', side: 'out', s: 'Appears to be a Muslim man, based on his name and attire.' },
  { group: 'en-reviewer', side: 'out', s: "According to the creator's stories, she is pregnant." },
  { group: 'en-reviewer', side: 'out', s: 'He is a Brahmin by birth.' },
  { group: 'en-reviewer', side: 'out', s: 'The candidate is a wheelchair user.' },
  { group: 'en-reviewer', side: 'out', s: 'Her husband co-founded the studio with her.' },
  // ---- First-person candidate text (the INPUT redaction sees these) ----
  { group: 'first-person', side: 'both', s: "I'm a 41-year-old brand strategist." },
  { group: 'first-person', side: 'both', s: 'As a mother of a toddler I learned to ship fast.' },
  { group: 'first-person', side: 'both', s: 'Being a Parsi, I grew up around festivals.' },
  { group: 'first-person', side: 'both', s: 'My wife and I started the studio in 2019.' },
  { group: 'first-person', side: 'both', s: 'I turned 45 this year.' },
  { group: 'first-person', side: 'both', s: 'I am a Dalit woman who broke into advertising.' },
  { group: 'first-person', side: 'both', s: "I'm happily married with two kids." },
  { group: 'first-person', side: 'both', s: 'I am HIV positive and have spoken about it openly.' },
  { group: 'first-person', side: 'both', s: 'Mother of twins, marketer, coffee addict.' },
  { group: 'first-person', side: 'both', s: 'Male, 34, brand manager.' },
  { group: 'first-person', side: 'both', s: 'I identify as non-binary.' },
  { group: 'first-person', side: 'both', s: "I'm a first-generation immigrant." },
  { group: 'first-person', side: 'both', s: 'I just had my second baby and am returning from leave.' },
  { group: 'first-person', side: 'both', s: 'I belong to the Nair community.' },
  { group: 'first-person', side: 'both', s: 'I am a single dad raising a daughter.' },
  // ---- Hinglish ----
  { group: 'hinglish', side: 'both', s: 'Main ek shaadi-shuda mahila hoon aur do bacchon ki maa.' },
  { group: 'hinglish', side: 'both', s: 'Meri umar 36 saal hai.' },
  { group: 'hinglish', side: 'both', s: 'Hum Marwari parivar se hain.' },
  { group: 'hinglish', side: 'both', s: 'Mera pati bhi marketing mein hai.' },
  { group: 'hinglish', side: 'both', s: 'Main ek Muslim aurat hoon.' },
  { group: 'hinglish', side: 'both', s: 'Main 40 saal ka hoon.' },
  { group: 'hinglish', side: 'both', s: 'Main garbhvati hoon aur kaam jaari hai.' },
  { group: 'hinglish', side: 'both', s: 'Woh ek Sikh ladka hai.' },
  { group: 'hinglish', side: 'both', s: 'Main single mother hoon.' },
  { group: 'hinglish', side: 'both', s: 'Meri shaadi ko 5 saal ho gaye.' },
  // ---- contact details ----
  { group: 'contact', side: 'both', s: 'Reach me at hello (at) janedoe (dot) design.' },
  { group: 'contact', side: 'both', s: 'WhatsApp 9 8 7 6 5 4 3 2 1 0 anytime.' },
  { group: 'contact', side: 'both', s: 'Call +44 20 7946 0958 for the full reel.' },
  { group: 'contact', side: 'both', s: 'Email: j.doe [at] proton.me' },
  { group: 'contact', side: 'both', s: 'Ping jane_doe@outlook.com for the decks.' },
  { group: 'contact', side: 'both', s: 'Phone: (022) 2345 6789' },
  { group: 'contact', side: 'both', s: 'mail me - priya at studio dot in' },
  { group: 'contact', side: 'both', s: 'My number is 98 20 30 40 50.' },
  // ---- more reviewer-style variants (different verbs / hedges) ----
  { group: 'en-reviewer', side: 'out', s: 'It is likely that the candidate is a mother, given the parenting-brand focus.' },
  { group: 'en-reviewer', side: 'out', s: 'The host sounds like an older gentleman with a thick regional accent.' },
  { group: 'en-reviewer', side: 'out', s: 'Candidate identifies as a woman of colour.' },
  { group: 'en-reviewer', side: 'out', s: 'This reads like the work of a young, unmarried woman.' },
  { group: 'en-reviewer', side: 'out', s: 'The creator is a stay-at-home dad turned freelancer.' },
  { group: 'en-reviewer', side: 'out', s: 'Seems to be of South Indian origin.' },
  { group: 'en-reviewer', side: 'out', s: 'Their pronouns are she/her.' },
  { group: 'en-reviewer', side: 'out', s: 'The candidate is in their mid-forties.' },
];

const KEEPS: string[] = [
  "Led the Women's Day campaign, reaching 3M, as a mother-brand extension.",
  'My team of 12 designers shipped 40 assets a week.',
  'Brand for a Hindu pilgrimage app, 1.2M installs.',
  'Launched a campaign for young mothers on postpartum nutrition.',
  'Gender-neutral toy brand relaunch, +34% reach.',
  'Campaign targeted women aged 25-40 in tier-2 cities.',
  'Muslim wedding-wear brand repositioning with a 4-film arc.',
  'The deck shows a 10-year-old brand relaunch.',
  'Built the brand voice for a senior-living community with a 55+ audience.',
  'Case study: Diwali festive campaign for a Jain sweets chain.',
  'The featured protagonist is a Sikh farmer who tells the film\'s story.',
  'She led the creative team across three launches.',
  'Ran a 3-year CSR campaign for a utility.',
  'Tripled follower count in 2 years.',
  "Worked with a Dalit artists' collective on a mural series.",
  "Pregnancy-test brand's product launch, 40K sampling kits.",
  'Maternity-wear influencer partnerships generated 2M views.',
  'Launched an LGBTQ+ inclusion campaign for a bank.',
  'The married-couple storytelling arc for a jewellery brand won a Effie.',
  'Concept for a divorce-lawyer ad film.',
  'A disability-inclusive hiring campaign for a retailer.',
  'Audience split: 54% female, 46% male.',
  'Partnered with Nigerian Afrobeats artists for a beverage launch.',
  'Christian Dior brand study used as a reference.',
  'Black Friday campaign delivered 4x ROAS.',
  'White-label product packaging redesign.',
  'Brown Foods rebrand, 18 SKUs.',
  'Indian Premier League sponsorship activation, 12 stadiums.',
  'British Airways co-marketing with a travel portal.',
  'Grew the community to 40K members, mostly mothers.',
  'A man-of-the-match style player spotlight series.',
  'Gen Z creators programme with 300 college ambassadors.',
  'Baby-care brand: 12M impressions in launch month.',
  'Targeted millennials with a fintech app launch.',
  'Pitched to a female-led VC and won the account.',
  "Lifebuoy hand-wash campaign for mothers and children, 6 films.",
  'Mother Dairy summer campaign with 3 films.',
  "Old Spice-style rebrand for a men's grooming line.",
  "Campaign for Alzheimer's awareness among the elderly.",
  'Matrimony app UX copy, A/B tested across 6 variants.',
  'Wheelchair-accessible venue guide, 50K downloads.',
  "Founders' story video: a deaf entrepreneur builds a sign-language app.",
  'Alcohol ad age-gate: 25+ targeting only.',
  'Targeting users in their 30s with a retirement-planning product.',
  'Led a team of 8 including 3 women copywriters.',
  'Spent 9 years on the Tata account as a vendor partner.',
  "Muslim Women's Hajj travel brand, launch film at 2.3M views.",
  'Parent-teacher app onboarding campaign.',
  "Father's Day activation: 1.4M reach.",
  "Mother's Day gifting campaign: 28% uplift.",
  'Single-origin coffee brand storytelling.',
  'Employee advocacy programme: married to the brand narrative.',
  'Sikh heritage month campaign for a bank, 5 films.',
  'Jain Irrigation case study: farmer testimonials.',
  'Age-inclusive modelling: models from 20 to 70.',
  'Lead pipeline grew 3x over 18 months.',
  'Directed a 40-person shoot across 6 cities.',
  'Pan-India campaign across Hindu, Muslim and Christian festivals.',
  'Customer personas: working mothers, college students, retirees.',
  'Our brand speaks to women in their 40s who juggle work and home.',
  'The film follows a pregnant farmer navigating a drought.',
  'Husband-and-wife duo founders were interviewed for the brand story.',
  'Elderly care startup: designed the identity and the app icon set.',
  'Created a bilingual Hindi and English campaign for a Muslim-owned bakery chain.',
  'A woman-led cooperative was our hero story for the CSR film.',
  'Interviewed 12 mothers for the insight work behind the campaign.',
  'Wedding-season campaign for a Punjabi jewellery brand, 3 TVCs.',
];

// 20 realistic whole answers: [answer, personal fragments that must NOT survive, work fragments that MUST survive, urls that must survive]
interface Answer { a: string; gone: string[]; stay: string[]; urls: string[] }
const ANSWERS: Answer[] = [
  { a: "Portfolio: https://janedoe.design/work and the AquaPure deck https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view . I'm 38, married, and a mother of two. I built the AquaPure brand from zero and launched 14 campaigns.",
    gone: ["I'm 38", 'married', 'mother of two'], stay: ['I built the AquaPure brand from zero', 'launched 14 campaigns'], urls: ['https://janedoe.design/work', 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view'] },
  { a: "Brand work I led: (1) Clean Ganga outreach, 3M reach (2) Swachh Schools, 1.2M students. Decks at https://www.behance.net/jane-doe. My husband is in tech so I work odd hours.",
    gone: ['My husband'], stay: ['Clean Ganga outreach, 3M reach', 'Swachh Schools, 1.2M students'], urls: ['https://www.behance.net/jane-doe'] },
  { a: "Hi, I'm a Hindu woman from Pune with 11 years in marketing. Work samples https://instagram.com/jane.creates and https://youtu.be/dQw4w9WgXcQ . Led a 6-person team at a D2C beauty brand.",
    gone: ['Hindu woman', '11 years'], stay: ['Led a 6-person team at a D2C beauty brand'], urls: ['https://instagram.com/jane.creates', 'https://youtu.be/dQw4w9WgXcQ'] },
  { a: "https://jane.studio is my site. I have 9 years of experience in brand and communications; as a single mother I learned to prioritise ruthlessly.",
    gone: ['single mother'], stay: ['brand and communications', 'learned to prioritise ruthlessly'], urls: ['https://jane.studio'] },
  { a: "Campaign decks: https://docs.google.com/presentation/d/1XyZ_abcdefghij/edit. Born in 1986, I started in print and moved to digital. Won two Effies for the Vidya Foundation work.",
    gone: ['Born in 1986'], stay: ['moved to digital', 'Won two Effies for the Vidya Foundation work'], urls: ['https://docs.google.com/presentation/d/1XyZ_abcdefghij/edit'] },
  { a: "Please see https://www.canva.com/design/DAFabc123/view . For context, I am 44 and returned to work after maternity leave, then built the brand voice for a fintech from scratch.",
    gone: ['I am 44', 'maternity leave'], stay: ['built the brand voice for a fintech from scratch'], urls: ['https://www.canva.com/design/DAFabc123/view'] },
  { a: "Work: https://vimeo.com/123456789. Over my 12 years at Zomato and Swiggy I launched 30 campaigns and managed a 5 crore budget.",
    gone: ['12 years'], stay: ['launched 30 campaigns', 'managed a 5 crore budget'], urls: ['https://vimeo.com/123456789'] },
  { a: "I am a proud Muslim and a marketer, and https://notion.so/jane/portfolio-abc123 has my case studies; I led the brand refresh for an NBFC (reach +42%).",
    gone: ['Muslim'], stay: ['I led the brand refresh for an NBFC (reach +42%)'], urls: ['https://notion.so/jane/portfolio-abc123'] },
  { a: "Links:\nhttps://janedoe.design\nhttps://www.linkedin.com/in/janedoe\nAbout me: 35 year old Gujarati woman, 10+ yrs exp in brand, building in public.",
    gone: ['35 year old', 'Gujarati woman'], stay: ['building in public'], urls: ['https://janedoe.design', 'https://www.linkedin.com/in/janedoe'] },
  { a: "Portfolio https://drive.google.com/drive/folders/1AbCdEfGhIjKlMn . Phone 98765 43210, email jane@gmail.com. I ran influencer programs with 200 creators and a Rs 3 crore budget.",
    gone: ['98765 43210', 'jane@gmail.com'], stay: ['ran influencer programs with 200 creators', 'Rs 3 crore budget'], urls: ['https://drive.google.com/drive/folders/1AbCdEfGhIjKlMn'] },
  { a: "I'm a 29-year-old brand designer. https://jane.design/case-studies has 8 brand systems; the Kisan Mart identity is the one I am proudest of.",
    gone: ['29-year-old'], stay: ['8 brand systems', 'the Kisan Mart identity'], urls: ['https://jane.design/case-studies'] },
  { a: "Sharing https://www.figma.com/file/AbC123/Brand . My wife runs the finance side of our agency, I handle creative: we won 3 category awards for the SolarPe launch.",
    gone: ['My wife'], stay: ['we won 3 category awards for the SolarPe launch'], urls: ['https://www.figma.com/file/AbC123/Brand'] },
  { a: "Mera portfolio https://janedoe.design hai. Main 8 saal ka experience rakhti hoon aur maine 20 se zyada campaigns launch kiye.",
    gone: ['8 saal'], stay: ['20 se zyada campaigns launch kiye'], urls: ['https://janedoe.design'] },
  { a: "Work samples: https://www.dropbox.com/s/abc123/deck.pdf?dl=0 — I'm a mom of 2 and a founder; the deck covers the Nirmal brand relaunch (3 films, 6 cities).",
    gone: ['mom of 2'], stay: ['the Nirmal brand relaunch (3 films, 6 cities)'], urls: ['https://www.dropbox.com/s/abc123/deck.pdf?dl=0'] },
  { a: "See https://medium.com/@jane for writing and https://jane.tv for video. A Christian by faith, I still ran the Ramzan campaign for a beverage client, which grew sales 18%.",
    gone: ['Christian by faith'], stay: ['ran the Ramzan campaign for a beverage client, which grew sales 18%'], urls: ['https://medium.com/@jane', 'https://jane.tv'] },
  { a: "Decks https://slides.com/jane/brand-deck. Total experience: 14 years. Previously head of brand at two startups, I built an in-house studio of 9.",
    gone: ['14 years'], stay: ['head of brand at two startups', 'built an in-house studio of 9'], urls: ['https://slides.com/jane/brand-deck'] },
  { a: "Not much online but here: https://jane.myportfolio.com. I am pregnant and due in March, so availability matters, but the Jal Mitra campaign (2.4M views) is mine.",
    gone: ['pregnant', 'due in March'], stay: ['the Jal Mitra campaign (2.4M views) is mine'], urls: ['https://jane.myportfolio.com'] },
  { a: "I have been in marketing since 2009. Links: https://jane.design, https://behance.net/jane. We scaled a D2C brand from 0 to 40 crore in three years and I led 4 campaigns that won awards.",
    gone: ['since 2009'], stay: ['scaled a D2C brand from 0 to 40 crore in three years', 'led 4 campaigns that won awards'], urls: ['https://jane.design', 'https://behance.net/jane'] },
  { a: "https://jane.design/aquapure — Caste/religion: Brahmin Hindu; Age: 37; Gender: F. Campaign summary: 12 films, 3 festivals, 9M reach.",
    gone: ['Brahmin Hindu', 'Age: 37', 'Gender: F'], stay: ['12 films, 3 festivals, 9M reach'], urls: ['https://jane.design/aquapure'] },
];

const caught = (l: Leak): boolean => {
  const out = findProtectedAttribute(l.s) !== null;
  const red = redactPersonalStatements(l.s);
  const inn = red.removed > 0 && findProtectedAttribute(red.text) === null;
  return l.side === 'out' ? out : l.side === 'in' ? inn : out && inn;
};

describe('third review held-out set: leaks, keeps and whole answers', () => {
  it('has 61 leaks, 67 keeps and 19 answers', () => {
    expect(LEAKS).toHaveLength(61);
    expect(KEEPS).toHaveLength(67);
    expect(ANSWERS).toHaveLength(19);
  });
  it.each(LEAKS.map(l => [l.group, l.s, l] as const))('%s: %s', (_g, _s, l) => {
    expect(caught(l)).toBe(true);
  });
  it('no keep is dropped by the output filter or changed by the input redaction', () => {
    expect(KEEPS.filter(k => findProtectedAttribute(k) !== null)).toEqual([]);
    expect(KEEPS.filter(k => redactPersonalStatements(k).text !== k)).toEqual([]);
  });
  it.each(ANSWERS.map((a, i) => [i + 1, a] as const))('whole answer #%s: the personal parts go, the work and every link stay', (_n, a) => {
    const r = redactPersonalStatements(a.a);
    const out = r.text;
    for (const g of a.gone) expect(out.toLowerCase(), `must go: ${g}`).not.toContain(g.toLowerCase());
    for (const s of a.stay) expect(out, `must stay: ${s}`).toContain(s);
    for (const u of a.urls) expect(out, `url must stay: ${u}`).toContain(u);
    expect(findProtectedAttribute(out), 'nothing personal is left').toBeNull();
  });
});
