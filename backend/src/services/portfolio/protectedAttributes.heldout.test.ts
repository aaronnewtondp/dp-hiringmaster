import { describe, it, expect } from 'vitest';
import { findProtectedAttribute, redactPersonalStatements } from './protectedAttributes.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// HELD-OUT sets for the protected-attribute filter and the redaction that keeps personal details away from the model.
//
//  1. The SECOND review's held-out set (written by the reviewer, never shown to the fixer of the first round): the first round's
//     filter caught 31 of its 60 leaks (51.7%). It is a regression set now.
//  2. E3A's own set (62 leaks / 49 keeps / 10 redaction cases), written BEFORE the numbers were looked at and with wording that
//     differs from every other corpus: first measurement 56/62 leaks (90.3%) with 1 keep changed and 8/10 redaction cases; the misses
//     were then generalised (families, not single sentences) and the set is a regression set from here on. Do not tune a rule to one
//     sentence of it.
//  3. The reviewer's first-person sentences (37) and realistic answers.
//  4. E3A's SECOND set (30 leaks / 30 keeps), written after set 2 had been generalised and measured once: 22/30 leaks (73.3%), 0 keeps
//     changed. That is the honest estimate of what the filter does on wording it has never seen (English reviewer-style 6/8, first person
//     10/11, Hinglish 4/5, contact 2/2). Its misses were generalised too (hijabi, trans, a child's age in words, "after her divorce",
//     participles after a hedged attribute, vidhwa ...) and it is a regression set from here on.
//
// DOCUMENTED LIMIT: statements in Tamil, Marathi, Bengali or Telugu written in Roman script (the second review's 12 such sentences)
// are not recognised: the word lists cover English, Hindi and Hinglish only. They are deliberately NOT in this file as leaks.
// A city, a state or a college is not personal data here (it is part of portfolio text) and is not removed.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Case = [group: string, text: string];

const REVIEWER_LEAKS: Case[] = [
  ['en-out', 'The candidate comes across as a young professional in her mid-twenties.'],
  ['en-out', 'Judging by the profile photo, he is probably around 45.'],
  ['en-out', 'She mentions being a single mother, which explains the career break.'],
  ['en-out', "The candidate's headscarf suggests a Muslim background."],
  ['en-out', 'Appears to be a recent graduate, likely aged 22 or 23.'],
  ['en-out', 'He is a father of three and balances work with family.'],
  ['en-out', 'The candidate is a Tamil Brahmin from Chennai.'],
  ['en-out', 'Visually impaired candidate who built accessible campaigns.'],
  ['en-out', 'The candidate has a stutter noticeable in the video.'],
  ['en-out', "She's expecting her first child, according to the caption."],
  ['en-out', 'The candidate is Nigerian-born and moved to India in 2015.'],
  ['en-out', 'He seems to be in his late fifties given the career span.'],
  ['en-out', 'The creator is an openly gay man who advocates for LGBTQ rights.'],
  ['en-out', "Candidate's wife manages the studio's finances."],
  ['en-out', 'The candidate is a widow and sole earner.'],
  ['en-out', 'The speaker has a strong Punjabi accent.'],
  ['en-out', 'She is a Christian and her work reflects her faith.'],
  ['en-out', 'Candidate is a 29-year-old woman from Pune.'],
  ['en-out', 'Married with two kids, per the bio.'],
  ['en-out', 'The candidate looks tired and unwell in the video.'],
  ['en-out', "The candidate is a woman, which may help with the brand's female audience."],
  ['en-out', "It's evident the candidate is a mother because of the parenting content."],
  ['en-out', 'He is a man in his early thirties who started a D2C label.'],
  ['en-out', 'The candidate was born in 1984.'],
  ['en-out', 'The portfolio owner appears to be a Sikh man wearing a turban.'],
  ['en-out', 'Candidate is a Parsi, as suggested by the surname.'],
  ['en-out', 'The candidate is in a wheelchair, as seen in the behind-the-scenes photo.'],
  ['en-out', 'The candidate is pregnant, as visible in the photo.'],
  ['en-out', 'The candidate is a Dalit entrepreneur.'],
  ['en-out', 'She is an NRI who returned from the US last year.'],
  ['hinglish', 'Main ek 34 saal ki mahila hoon aur do bachchon ki maa hoon.'],
  ['hinglish', 'Meri umar 38 saal hai aur main shaadi shuda hoon.'],
  ['hinglish', 'Mera naam Rahul hai, main 29 saal ka ladka hoon.'],
  ['hinglish', 'Main Hindu Brahmin parivar se hoon.'],
  ['hinglish', 'Woh ek Muslim ladki hai jo social media sambhalti hai.'],
  ['hinglish', 'Unki umar lagbhag 40 saal hai.'],
  ['hinglish', 'Main apne pati aur do bachchon ke saath Pune mein rehti hoon.'],
  ['hinglish', 'Main ek single mom hoon aur 10 saal se marketing mein hoon.'],
  ['hinglish', 'Candidate shaadi ke baad Mumbai shift hui.'],
  ['hinglish', 'Main pregnant thi isliye career break liya.'],
  ['en-in', "I'm a 41-year-old mother of two and I've led brand campaigns for 15 years."],
  ['en-in', 'As a Muslim woman in this industry I have learned to speak up.'],
  ['en-in', 'I am a gay man and queer storytelling is core to my work.'],
  ['en-in', 'Being a single father taught me scrappy execution.'],
  ['en-in', 'I am 52 and still hungry to build.'],
  ['contact', 'Call me on 98765 43210 or mail priya.s@gmail.com.'],
  ['contact', 'WhatsApp: +91 98765-43210'],
  ['en-in', 'I am a differently-abled marketer who built accessibility campaigns.'],
];
const REVIEWER_KEEPS: Case[] = [
  ['en', "Women's Day campaign reached 2.3M people on Instagram."],
  ['en', 'Campaign aimed at working mothers drove a 40% lift in sign-ups.'],
  ['en', 'Targeting Gen Z and millennials with short-form video.'],
  ['en', 'The brand relaunch positioned the product for older adults in tier-2 cities.'],
  ['en', 'Accessibility-first microsite designed for visually impaired users.'],
  ['en', 'Diwali campaign for a B2B packaging client generated 300 leads.'],
  ['en', 'Interfaith harmony film for Ramadan and Diwali earned 1M views.'],
  ['en', 'The CEO, a woman who founded the startup, features in the case study.'],
  ['en', 'Customer persona: Rahul, 34, a married IT professional in Pune.'],
  ['en', 'Audience split: 62% male, 38% female.'],
  ['en', 'Age 25-34 accounted for 70% of conversions.'],
  ['en', 'The candidate led a team of five designers and two writers.'],
  ['en', 'She led five campaigns across LinkedIn and events.'],
  ['en', 'The candidate shows strong command of long-form copy.'],
  ['en', 'The deck is married to a consistent colour system throughout.'],
  ['en', "Indian Oil's Swachh campaign increased footfall by 12%."],
  ['en', 'Black and white photography series for the annual report.'],
  ['en', 'A campaign for senior-living communities in Bengaluru.'],
  ['en', 'The candidate is single-handedly responsible for the LinkedIn content calendar.'],
  ['en', 'Sikh Heritage Month social campaign with 40 creators.'],
  ['en', 'Hindu temple trust fundraising campaign exceeded target by 3x.'],
  ['en', 'Muslim-owned small business spotlight series.'],
  ['en', "The candidate's pitch to the board secured a 2 crore budget."],
  ['en', 'Pregnancy-care app launch: influencer seeding and a 90-day content plan.'],
  ['en', 'Maternity wear brand D2C launch with UGC strategy.'],
  ['en', 'Parenting community newsletter grew from 2k to 40k subscribers.'],
  ['en', 'Brand voice guide includes gender-neutral language rules.'],
  ['en', "The founder's story anchors the campaign: she started the company in 2019."],
  ['en', 'Worked with a leading Punjabi folk singer for a festive jingle.'],
  ['en', 'Tamil-language explainer videos with subtitles in Hindi and English.'],
  ['en', 'The candidate is a seasoned brand builder with end-to-end campaign ownership.'],
  ['en', 'Candidate has experience with B2B SaaS, D2C and nonprofit sectors.'],
  ['en', 'The spokesperson, a Paralympic athlete, anchors the film.'],
  ['en', 'Disability-inclusion hiring campaign for a bank.'],
  ['en', 'Women-led SHG stories featured in the village documentary.'],
  ['en', 'Transgender inclusion policy explainer for the employer brand.'],
  ['en', 'Gender pay gap report launch, with data visuals.'],
  ['en', 'Targeted 18-24 year olds with campus ambassadors.'],
  ['en', 'The team of 6 spanned designers, a videographer and two copywriters.'],
  ['en', 'A 3-year campaign for Tata Steel won an industry award.'],
  ['en', 'Ran paid social with a 12 lakh annual budget and a team of two.'],
  ['en', 'The candidate is fluent in Hindi, English and Marathi copywriting.'],
  ['en', 'Marathi, Tamil and Bengali regional adaptations for the festive film.'],
  ['en', 'Campaign visuals use a Rajasthani folk art style.'],
  ['en', 'The candidate is very detail-oriented and consistent.'],
  ['hinglish', 'Yeh campaign Diwali ke liye banaya gaya tha aur 5 lakh reach mili.'],
  ['hinglish', 'Humne ek mahila-kendrit campaign chalaya jisme 3 crore views aaye.'],
  ['hinglish', 'Is project mein humne 4 designers ki team lead ki.'],
  ['hinglish', 'Brand ka naam badalkar naya logo banaya gaya.'],
  ['hinglish', 'Yeh film ek Muslim parivar ki kahani hai jo Eid manata hai.'],
  ['hinglish', 'Campaign ka target audience 25 se 34 saal ke log the.'],
  ['hinglish', 'Humne 5 saal ka brand roadmap banaya.'],
  ['tamil', 'Intha campaign Pongal-ku Tamil audience-ku design pannom.'],
  ['tamil', 'Naanga oru 5 per team-a lead pannom.'],
  ['marathi', 'Ganpati utsavasathi amhi ek social campaign kela.'],
  ['marathi', 'Amhi 3 mahinyat 2 lakh leads milavle.'],
  ['bengali', 'Durga Pujo-r jonno amra ekta film banieschi.'],
  ['telugu', 'Ugadi campaign kosam memu 3 videos chesamu.'],
  ['en', "The influencer, a woman in her thirties, reached 1.2M followers; the candidate negotiated the contract."],
];

const FIRST_PERSON_LEAKS: string[] = [
  "I am a 45 year old marketer.", "I'm a mom of two.", "I'm 38.", "As a mother of 2 I learned to prioritise.", "Being a woman in marketing taught me resilience.",
  "I am a proud Sikh.", "I'm a Hindu.", "I am married.", "My husband runs the agency with me.", "My wife and I founded the studio.", "My kids inspire my work.",
  "My daughter is 7.", "I'm a mother.", "I'm a father.", "I am a woman.", "I'm a man.", "I identify as queer.", "I am a Christian.", "I am a Jain.",
  "I'm 29 years old.", "I am in my 40s.", "I am a woman entrepreneur from a small town.", "I'm originally from Punjab, a Punjabi at heart.", "I am a Brahmin.",
  "I am pregnant and returning from a career break.", "I took a maternity break in 2021.", "I recently got married.", "I am a single mom.", "I am a working mother of two.",
  "As a female marketer I bring a unique perspective.", "As a Muslim, I care about inclusive campaigns.", "I am a person with a disability.", "I am hearing impaired.",
  "I'm a divorced father of one.", "Proud mom of two, marketer, dreamer.", "Mom of 2 | Marketer | Storyteller", "35 | F | Mumbai | Marketer",
];

const E3A_LEAKS: Case[] = [
  // English, reviewer style (about the person)
  ['en3', 'From the photos, the portfolio owner looks to be in her late thirties.'],
  ['en3', 'The applicant is a Parsi gentleman based in Pune.'],
  ['en3', 'Given the surname, the candidate is most likely a Bengali Hindu.'],
  ['en3', 'She took two years off after her second baby.'],
  ['en3', 'The candidate recently lost her husband and returned to work.'],
  ['en3', "He's a devout Catholic who credits his faith for his discipline."],
  ['en3', 'The creator is a transgender woman who founded the brand.'],
  ['en3', 'The candidate is a 31-year-old man from Hyderabad.'],
  ['en3', 'Female founder in her early forties with a D2C background.'],
  ['en3', 'The candidate is an unmarried woman.'],
  ["en3", "Candidate's religion: Sikh."],
  ['en3', 'He is the father of a newborn.'],
  ['en3', 'She is a widow who runs her late husband\'s agency.'],
  ['en3', 'A woman in her fifties leads the studio.'],
  ['en3', 'The portfolio owner is pregnant, per the Instagram story.'],
  ['en3', "The creator is a gay man; his partner appears in the film."],
  ['en3', 'Candidate is differently abled.'],
  ['en3', 'Her marital status is single.'],
  ['en3', 'The candidate is a Muslim man, as shown by his name.'],
  ['en3', 'Probably a mother, since the work features a lot of parenting content.'],
  ['en3', 'She is expecting her second baby.'],
  ["en3", "The applicant's caste is Maratha."],
  ['en3', 'The candidate is 29.'],
  ['en3', 'He is about 50 years old.'],
  ["en3", "The candidate's ethnicity is South Indian."],
  ['en3', 'Seems to be a young mother of two.'],
  ['en3', 'The candidate has a visible limp.'],
  ['en3', 'She comes across as a confident woman in her thirties.'],
  // English, first person
  ['fp3', "I'm 47 and still shipping campaigns."],
  ['fp3', 'Mother of three here, and a lifelong brand nerd.'],
  ['fp3', "I'm a Christian and my faith shapes my storytelling."],
  ['fp3', 'I have two daughters and a full-time job.'],
  ['fp3', 'I am a lesbian woman building inclusive brands.'],
  ['fp3', 'My wife handles the finance side of the studio.'],
  ['fp3', 'I got married last year and moved cities.'],
  ["fp3", "I'm a first-generation immigrant."],
  ['fp3', 'I am a widow.'],
  ['fp3', 'Being a Dalit woman in advertising taught me persistence.'],
  ['fp3', 'I am in my late fifties.'],
  ['fp3', 'As a mum of two I plan campaigns in the early morning.'],
  ["fp3", "I'm a 33 year old brand manager."],
  ['fp3', 'I was born in 1985.'],
  ['fp3', 'My husband and I run a boutique agency.'],
  ['fp3', 'I am a Sikh from Amritsar.'],
  ["fp3", "I'm a proud dad of two."],
  ['fp3', 'I am a person of colour working in marketing.'],
  ["fp3", "I'm an amputee and a designer."],
  ['fp3', 'I turned 40 last month.'],
  // Hinglish
  ['hing3', 'Main shaadi shuda hoon aur mere do bachche hain.'],
  ['hing3', 'Meri umar 35 saal hai.'],
  ['hing3', 'Main ek mahila entrepreneur hoon.'],
  ['hing3', 'Woh kunwari hai aur akeli rehti hai.'],
  ['hing3', 'Hum Sikh parivar se hain.'],
  ['hing3', 'Uski shaadi pichhle saal hui thi.'],
  ['hing3', 'Main do bachchon ki maa hoon.'],
  ['hing3', 'Main 40 saal ka hoon.'],
  ['hing3', 'Candidate ek Brahmin ladki hai.'],
  ['hing3', 'Main pregnant hoon.'],
  // contact
  ['contact3', 'WhatsApp me on 9876543210.'],
  ['contact3', 'Email: hello(at)priyasharma(dot)com'],
  ['contact3', 'Ping me: priya_sharma_88 [at] gmail [dot] com'],
  ['contact3', 'My number is +91 99887 76655.'],
];
const E3A_KEEPS: Case[] = [
  ['k', "The Women's Entrepreneurship Day film starred real founders from Surat."],
  ['k', 'We designed a matrimony app onboarding flow that lifted sign-ups by 22%.'],
  ['k', 'Case study: a campaign for a fertility clinic aimed at couples in their thirties.'],
  ['k', 'Parenting brand launch: 40 mom bloggers seeded the product.'],
  ['k', 'Grew the Muslim wedding-wear label from 0 to 5 crore.'],
  ['k', "The campaign's hero, a single mother from Pune, anchors the story."],
  ['k', 'I led the Gen Z launch for a youth fashion brand.'],
  ['k', 'Our client is a Hindu pilgrim-tourism board.'],
  ["k", "I'm passionate about water and sanitation storytelling."],
  ['k', 'I am a brand strategist with a design background.'],
  ["k", "I'm a Figma power user and a copy nerd."],
  ['k', 'I am based in Bengaluru and work with remote teams across India.'],
  ['k', 'I was a copywriter at an agency before moving in-house.'],
  ['k', 'My team of 4 designers shipped 120 assets a month.'],
  ['k', 'My partner agencies delivered the video content.'],
  ["k", "I'm a big believer in single-minded messaging."],
  ['k', 'I am a man of few words but strong visuals.'],
  ['k', 'She led a 12-member team.'],
  ['k', 'He is the founder of two D2C brands.'],
  ['k', 'Audience: women 25-34, metro cities; 62% male on LinkedIn.'],
  ['k', 'The brief targeted divorced parents and new mothers with a financial-planning app.'],
  ['k', 'Pregnancy-test kit packaging redesign, A/B tested on 5k users.'],
  ['k', 'Diwali campaign for a Hindu-owned sweets chain won a local award.'],
  ['k', 'I managed a 9 crore budget across 14 campaigns.'],
  ['k', 'Directed a 3-year brand transformation programme.'],
  ['k', 'Targeted the 40+ segment with accessible UX.'],
  ["k", "I'm excited about the brand relaunch."],
  ['k', 'Our spokesperson, a retired army officer, narrates the film.'],
  ['k', 'The film follows a blind violinist and her guide dog.'],
  ['k', 'I handled social for a hearing-aid brand.'],
  ['k', 'Partnered with an NGO supporting differently-abled artisans.'],
  ['k', 'We celebrated Eid and Diwali with a joint festive film.'],
  ['k', 'I have strong opinions on typography.'],
  ['k', 'I was part of a team that grew the channel from 2k to 40k.'],
  ['k', 'Wife-and-husband founders were interviewed for the case study.'],
  ['k', 'I bring a love of storytelling and data.'],
  ['k', 'I run the brand for a company that makes baby-care products.'],
  ['k', 'As a marketing lead I owned the launch calendar.'],
  ['k', 'As a female-led company, we leaned into the community story.'],
  ['k', 'Mother Dairy and Amul were the category benchmarks for the deck.'],
  ['k', 'Humne is campaign mein 3 designers ki team chalayi.'],
  ['k', 'Yeh film Holi par 2 crore logon tak pahunchi.'],
  ['k', 'Is project mein humne Hindi aur Marathi dono mein copy likhi.'],
  ['k', 'Campaign ka target audience 18 se 24 saal ke yuva the.'],
  ['k', 'I grew up loving ads, and now I make them for B2B brands.'],
  ['k', 'My role: brand lead, reporting to the founder.'],
  ['k', 'I am an Indian brand-builder at heart.'],
  ['k', 'In my first 3 years the team grew from 2 to 9.'],
  ['k', 'Her brand voice work for the dairy client won an award.'],
];
const E3A_REDACT: Array<[input: string, mustGo: string[], mustStay: string[]]> = [
  ['As a mother of three, I built the brand voice for a utility and launched 14 campaigns.', ['mother'], ['built the brand voice for a utility', 'launched 14 campaigns']],
  ['Priya | 38 | Mom of 2 | Brand strategist | Pune', ['Mom of 2'], ['Brand strategist']],
  ['I am a widow, and I scaled the D2C label to 5 crore in two years.', ['widow'], ['scaled the D2C label to 5 crore']],
  ['Spent 11 years in marketing and led the relaunch of a 40-year-old brand.', ['11 years'], ['led the relaunch of a 40-year-old brand']],
  ['I have 7 years behind me, campaigns below: (1) Jal Diwas 3M reach (2) Clean Yamuna 1.2M views.', ['7 years'], ['(1) Jal Diwas 3M reach', '(2) Clean Yamuna 1.2M views']],
  ['Hi, I am a 36 year old strategist from Pune. My portfolio: https://example.design/work', ['36 year'], ['https://example.design/work']],
  ['Led brand for 9 years at a unicorn; shipped 25 campaigns; pregnant at the time of the Diwali launch.', ['9 years', 'pregnant'], ['shipped 25 campaigns']],
  ['My husband and I started the studio. We have shipped 40 films for utilities.', ['husband'], ['shipped 40 films for utilities']],
  ['Based in Mumbai. Brand designer, 12 yrs. Open to relocate.', ['12 yrs'], ['Mumbai', 'Brand designer']],
  ['Instagram bio: Priya | she/her | brand storyteller | water nerd', ['she/her'], ['brand storyteller', 'water nerd']],
];

const texts = (cases: Case[]) => cases.map(([, t]) => t);

describe('second-review held-out set (regression): leaks are caught on both sides, keeps are untouched', () => {
  it.each(REVIEWER_LEAKS)('%s: %s', (_g, text) => {
    expect(findProtectedAttribute(text), 'output filter').not.toBeNull();
    expect(redactPersonalStatements(text).removed, 'input redaction').toBeGreaterThan(0);
  });
  it('every keep is neither dropped by the output filter nor changed by the redaction', () => {
    expect(texts(REVIEWER_KEEPS).filter(t => findProtectedAttribute(t) !== null)).toEqual([]);
    expect(texts(REVIEWER_KEEPS).filter(t => redactPersonalStatements(t).text !== t)).toEqual([]);
  });
});

describe('first-person statements (second review, finding 1): the model never reads them', () => {
  it.each(FIRST_PERSON_LEAKS)('%s', text => {
    const r = redactPersonalStatements(text);
    expect(r.removed).toBeGreaterThan(0);
    expect(r.text).not.toBe(text);   // (what is left, if anything, is the part that states nothing personal: "I founded the studio.")
  });
});

describe('E3A held-out set: leaks, keeps and redaction (regression from here on)', () => {
  it.each(E3A_LEAKS)('%s: %s', (_g, text) => {
    expect(findProtectedAttribute(text), 'output filter').not.toBeNull();
    expect(redactPersonalStatements(text).removed, 'input redaction').toBeGreaterThan(0);
  });
  it('every keep is neither dropped by the output filter nor changed by the redaction', () => {
    expect(texts(E3A_KEEPS).filter(t => findProtectedAttribute(t) !== null)).toEqual([]);
    // "In my first 3 years ..." is the one borderline keep: the number of years is replaced ("my first [years]") and the sentence stays
    expect(texts(E3A_KEEPS).filter(t => redactPersonalStatements(t).text !== t)).toEqual(['In my first 3 years the team grew from 2 to 9.']);
    expect(redactPersonalStatements('In my first 3 years the team grew from 2 to 9.').text).toBe('In my first [years] the team grew from 2 to 9.');
  });
  it.each(E3A_REDACT)('redaction keeps what is not personal: %s', (input, mustGo, mustStay) => {
    const out = redactPersonalStatements(input).text;
    for (const g of mustGo) expect(out, `must go: ${g}`).not.toContain(g);
    for (const s of mustStay) expect(out, `must stay: ${s}`).toContain(s);
  });
});

const E3A_ROUND2_LEAKS: string[] = [
  'The portfolio belongs to a woman in her mid-thirties, based on the bio.',
  'It looks like the work of a Sikh man, given the turban in the team photo.',
  'The creator mentions raising twin boys alone after a divorce.',
  'From the introduction video, the candidate sounds pregnant.',
  'She is a first-time mum who started the label during maternity leave.',
  'The designer is a hijabi woman who founded the studio.',
  'He talks about his wife and their toddler throughout the reel.',
  'The candidate is a wheelchair user and mentions accessibility often.',
  'Appears to be an NRI returning from Dubai after a decade.',
  'The candidate is a 27-year-old fresh graduate.',
  'A man in his sixties who has run agencies for decades.',
  'Ms Rao is a Brahmin from Mysore and a mother of one.',
  'I have a six-year-old daughter and work part-time.',
  "I'm a stay-at-home mum returning to work after eight years.",
  'My husband and our two sons moved with me to Pune.',
  'I am a Jain vegetarian and that shapes my brand choices.',
  'I was diagnosed with epilepsy two years ago.',
  'I am trans and I write about inclusion.',
  "I'm 61 and still love a deadline.",
  'As a Christian woman I wanted the film to feel inclusive.',
  'Being a new dad changed how I write for parents.',
  'I recently lost my wife and returned to work.',
  'Meri shaadi 2019 mein hui thi aur ek beti hai.',
  'Main ek vidhwa hoon aur akeli kamati hoon.',
  'Main 45 saal ki hoon aur do bachchon ki maa hoon.',
  'Woh ek Dalit ladka hai jo college mein pehli peedhi ka graduate hai.',
  'Reach me at priya.s88@gmail.com anytime.',
  'WhatsApp: 99887 76655.',
  'Her age is 41 and she is single.',
  'The candidate was born in 1979 in Lucknow.',
];
const E3A_ROUND2_KEEPS: string[] = [
  'Our campaign for working mothers lifted app installs by 60%.',
  'The film features a Sikh farmer and his tractor.',
  'We built a community for first-time parents with a 40k newsletter.',
  'A short film about a wheelchair athlete in the Paralympics.',
  'The brand relaunch targeted women in their thirties in metro cities.',
  'I planned the maternity-wear launch, including 12 influencer collaborations.',
  'I wrote the voice guide for a baby-food brand.',
  'I led a team of six: two designers, a copywriter and three video editors.',
  'We ran a Diwali sale for a Jain community trust.',
  'I am a copywriter who loves long-form storytelling.',
  'I am the founder of a small creative studio in Pune.',
  'She directed the second season of the web series.',
  'He is credited as creative director on the campaign.',
  'The deck uses a married-couple persona for the home-loan product.',
  'I am based in Hyderabad and work across time zones.',
  'I started my career in print advertising in Chennai.',
  'The case study covers a 5-year partnership with a dairy cooperative.',
  'I have strong spreadsheet skills and a design eye.',
  'The ad targeted people aged 18-24 on short-video platforms.',
  'My partner brand, a local NGO, co-hosted the event.',
  'I was a part of the founding marketing team.',
  'I drove 3 product launches and 2 rebrands.',
  'Humne Holi par ek film banayi jisme 2 crore views aaye.',
  'Yeh campaign Hindi aur Tamil mein chalaya gaya.',
  'Main brand strategy aur copywriting karta hoon.',
  'Hospital group campaign on pregnancy care, with doctor interviews.',
  'The senior-citizen savings scheme film won a regional award.',
  'Blind taste test activation for a tea brand.',
  'Indian Railways inspired the mascot for our travel app.',
  'I handle crisis communication for a manufacturing client.',
];

describe('E3A second set (regression; first measured at 22/30 leaks and 0/30 keeps changed)', () => {
  it.each(E3A_ROUND2_LEAKS)('%s', text => {
    expect(findProtectedAttribute(text), 'output filter').not.toBeNull();
    expect(redactPersonalStatements(text).removed, 'input redaction').toBeGreaterThan(0);
  });
  it('every keep is neither dropped by the output filter nor changed by the redaction', () => {
    expect(E3A_ROUND2_KEEPS.filter(t => findProtectedAttribute(t) !== null)).toEqual([]);
    expect(E3A_ROUND2_KEEPS.filter(t => redactPersonalStatements(t).text !== t)).toEqual([]);
  });
});
