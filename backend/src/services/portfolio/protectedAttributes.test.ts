import { describe, it, expect } from 'vitest';
import {
  candidateNameSignal, filterProtectedAttributes, findFullPersonName, findProtectedAttribute, maskNameTokens, nameAppears, nameTokens,
  redactPersonalStatements, replaceYearsOfExperience, urlNameText,
} from './protectedAttributes.js';

// The adversarial review (finding 1.13): strings that state or infer an attribute of the candidate (207), copied from its corpus, hard-negative and singular-they probe files.
const REVIEW_LEAKS: string[] = [
  'The candidate appears to be a young woman.',
  'Candidate is female.',
  'She is a woman leading a male-dominated team.',
  'The presenter is a man in his forties.',
  'As a woman in marketing, she has overcome real barriers.',
  'The designer seems to be male.',
  'Gender: female',
  'The applicant identifies as non-binary.',
  'This female candidate has strong copy skills.',
  'A male applicant with broad campaign experience.',
  'The creator is a lesbian woman who writes about identity.',
  'The candidate is likely a woman given the first name.',
  'Probably a woman, judging by the voice.',
  'Candidate is a transgender woman.',
  'He is a gentleman in his fifties with a calm presence.',
  'The founder is a young man who started out in sales.',
  'Candidate: female, 34',
  'Her gender is not stated but she seems female.',
  'The narrator is a woman and her voice carries the film.',
  'Looks like a woman.',
  'The applicant is a gay man.',
  'Assuming the candidate is a man, the tone of the copy fits.',
  'The author is a woman.',
  'The candidate, being a woman, brings a different perspective.',
  'It is a female marketer behind these posts.',
  'The candidate is in her early 30s based on the timeline.',
  'Likely in his 40s.',
  'The candidate is 35 years old.',
  'A 42-year-old marketer with deep B2B experience.',
  'Candidate aged 29 with a strong portfolio.',
  'He is 45.',
  'The founder is in his late thirties.',
  'She looks young.',
  'The applicant appears to be middle-aged.',
  'Age of the candidate: 33',
  'Probably in her mid twenties.',
  'The presenter looks elderly.',
  'The candidate is too old for a startup pace.',
  'Seems to be a youthful applicant.',
  'The candidate seems to be in their twenties.',
  'DOB: 12/03/1987',
  'Date of birth: 4 May 1990',
  'The speaker is a 50-year-old man.',
  'Candidate is a senior citizen.',
  'She is likely in her forties.',
  'The creator is thirty-something.',
  'A fresh-faced 24 year old designer.',
  'The candidate is a young professional with limited years behind them.',
  'Candidate was born in 1985.',
  'The candidate is Hindu and the festival campaigns reflect that.',
  'She is a practising Muslim.',
  'The applicant appears to be Christian.',
  'The creator is a Sikh man.',
  'Candidate is Jain, which explains the vegetarian brand focus.',
  'The candidate is probably Buddhist.',
  'A Muslim candidate with strong storytelling.',
  'The founder is a devout Hindu.',
  'Religion: Hindu',
  'The designer seems to be Parsi.',
  'She is an atheist.',
  'The candidate is Catholic.',
  'The author is Jewish.',
  'Based on her name, she is likely Muslim.',
  'Candidate\'s religion shows in the work.',
  'The applicant is a Sikh.',
  'He is a Christian from Kerala.',
  'The candidate is a Brahmin.',
  'He is from a Dalit family.',
  'The applicant belongs to a scheduled caste.',
  'She is a Rajput by community.',
  'Candidate appears to be OBC.',
  'The founder is Bania, which explains the business sense.',
  'The candidate\'s caste is not stated.',
  'Caste: General',
  'The designer is from a lower caste background.',
  'The candidate is a Kshatriya.',
  'Applicant is of reserved category.',
  'The candidate is probably Punjabi.',
  'She seems to be from South India.',
  'The applicant is Bengali.',
  'The creator is a dark-skinned woman.',
  'Candidate appears to be South Asian.',
  'Judging by her name, she is Gujarati.',
  'The presenter is Caucasian.',
  'The candidate is likely Marathi.',
  'The speaker has a heavy South Indian accent.',
  'Candidate has a foreign accent that may limit stakeholder pitches.',
  'The applicant is a Malayali.',
  'He is a fair-skinned man.',
  'The founder appears to be African American.',
  'Based on his name he is probably from North India.',
  'The candidate\'s nationality is not clear but she seems foreign.',
  'The candidate is British.',
  'She is an NRI returning from the US.',
  'The applicant is Kashmiri.',
  'The candidate is married with two kids.',
  'She is probably married.',
  'Candidate is a mother of two.',
  'As a mother of two, she balances work and family.',
  'Her maternity break explains the gap in 2022.',
  'She is pregnant.',
  'The applicant is single.',
  'Marital status: married',
  'Likely newly married.',
  'He is a divorced father.',
  'Her husband runs a design studio.',
  'The candidate has a young family and may not travel.',
  'She may soon get married.',
  'The candidate is a single mother.',
  'The applicant is a housewife returning to work.',
  'Candidate is expecting a baby.',
  'The candidate is a proud father.',
  'His wife is also in marketing.',
  'The designer is unmarried.',
  'Candidate might go on maternity leave.',
  'She has two children and works part time.',
  'The candidate is a widow.',
  'Newlywed candidate; relocation could be an issue.',
  'The founder is a parent of three.',
  'Paternity risk is low for him.',
  'She is planning to start a family.',
  'The presenter is very good-looking.',
  'She is attractive and photogenic.',
  'The candidate looks overweight.',
  'Her good looks help on camera.',
  'He is a handsome man.',
  'The host is beautiful and charismatic.',
  'The candidate appears well-dressed and polished in the photo.',
  'Based on her photo, she looks professional.',
  'Judging from the headshot, the candidate is confident.',
  'Her physical appearance suits the brand.',
  'The applicant has a disability.',
  'The candidate is disabled.',
  'Candidate seems to have a health condition.',
  'The founder is in a wheelchair in the video.',
  'She is pretty and articulate.',
  'Reach her at priya.sharma@gmail.com for details.',
  'Contact: jane [at] example [dot] com',
  'Email jane(at)example(dot)com',
  'Call +91 98765 43210 to discuss.',
  'Phone 9876543210 listed on the page.',
  'Her number is 98765-43210.',
  'WhatsApp: +91-9876543210',
  'Mail me at hello at studio dot in',
  'Mobile: 098765 43210',
  'rahul_k@agency.co.in is the listed contact.',
  'Tel: (022) 2345 6789 0',
  'Reach out on +1 (415) 555-0132.',
  'The about page lists amit.verma@brandco.in.',
  'Contact 9 8 7 6 5 4 3 2 1 0',
  'info@studio-name.com appears in the footer.',
  'Based on the name, the applicant is likely from Tamil Nadu.',
  'Going by her name, she is probably Muslim.',
  'Judging by his surname, he is likely a Marwari.',
  'The candidate\'s photo suggests she is in her thirties.',
  'Looking at the photo, she seems to be a woman in her thirties.',
  'Guessed from the name: female, North Indian.',
  'Candidate ek mahila hai aur shaadi-shuda lagti hain.',
  'उम्मीदवार एक महिला है।',
  'वह शादीशुदा है और दो बच्चों की मां है।',
  'Candidate Punjabi lagta hai.',
  'Is ladki ki umar 25 saal hai.',
  'उसकी उम्र 35 साल है।',
  'Woh Muslim hai aur uski family badi hai.',
  'Candidate Hindu hai.',
  'यह उम्मीदवार हिंदू है।',
  'Candidate ek aurat hai, 30 saal ki.',
  'The candidate is f e m a l e.',
  'The candidate is FEMALE.',
  'The candidate is \uff46\uff45\uff4d\uff41\uff4c\uff45.',
  'The candidate is fem\u200bale.',
  'The candidate is f\u0435male.',
  'She is probably m.a.r.r.i.e.d.',
  'The candidate is wom4n.',
  'The candidate is a w-o-m-a-n.',
  'The applicant is ma\u00adrried.',
  'Candidate is a M U S L I M.',
  'The candidate is fe-male.',
  'The candidate is a wo man.',
  'Reach her: jane . doe @ gmail . com',
  'Phone: nine eight seven six five four three two one zero',
  'The candidate is a \u2468\u2467 year old woman.',
  'Candidate: she/her, 3 4 yrs',
  'Likely in their 40s.',
  'Probably in their early thirties.',
  'They are in their forties.',
  'The creator, likely in their 30s, built the channel.',
  'They appear to be a mother of two.',
  'They seem married.',
  'Their husband appears in the credits.',
  'Their religion is not stated but they seem Hindu.',
  'The candidate, who is a practising Hindu, ...',
  'A devout Muslim candidate.',
  'The candidate is a practising Christian.',
  'The applicant is a woman of colour.',
  'Candidate (36F) has deep B2B experience.',
  'The candidate is a 36F.',
  'The candidate is a working mom.',
  'The candidate is a stay-at-home mum returning to work.',
  'The candidate appears to be a Gen Z woman.',
  'Appears to be an older gentleman.',
  'The presenter is an older woman.',
  'The candidate is an immigrant.',
  'The candidate is Indian-American.',
  'The candidate is an LGBTQ+ advocate.',
  'The candidate is queer-identifying.',
  'The candidate speaks with a Bihari accent.',
];

// The same corpus: campaign topics, audience lines, neutral reviewer sentences and hard negatives about third parties (210).
const REVIEW_TOPICS: string[] = [
  'Women\'s Day campaign reached 2.4M impressions.',
  'International Women\'s Day social series with 18% engagement rate.',
  'Gender-equality campaign for rural schools.',
  'Campaign for senior citizens\' digital literacy.',
  'Muslim-owned small businesses spotlight series.',
  'Dalit entrepreneurs storytelling project with documentary shorts.',
  'Disability inclusion campaign delivered a 40% lift in engagement.',
  'Pride month brand activation for a fintech.',
  'Diwali festive campaign generated 12k leads.',
  'Eid greetings video series for a bakery chain.',
  'Christmas campaign for a hotel group.',
  'Navratri campaign with Garba-themed reels.',
  'Ramadan content calendar for a fintech app.',
  'Targets women aged 25-40 in tier-2 cities.',
  'Male grooming product launch with a YouTube series.',
  'Mother\'s Day gifting campaign drove 3x sales.',
  'Father\'s Day film went viral on Instagram.',
  'Young audience engagement through Reels and Shorts.',
  'Gen Z-focused YouTube series for a student bank account.',
  'Single-minded brand proposition across all channels.',
  'Brand story is married to the product roadmap.',
  'Campaign featuring a female founder, a first for the category.',
  'Testimonials from Sikh farmers in Punjab for an agri-tech brand.',
  'Heritage film with Brahmin priests and temple musicians.',
  'Interviews with Dalit women leaders in panchayats.',
  'Punjabi-language ad film for a tractor brand.',
  'Bengali audience campaign for Durga Puja.',
  'Hindu temple trust fundraising campaign.',
  'Jain community outreach for a vegan snack brand.',
  'Parent-teacher engagement app launch campaign.',
  'Parent company brand guidelines were inherited, not built.',
  'Maternity wear brand launch with influencer partnerships.',
  'Women entrepreneurs mentorship campaign for a bank.',
  'Campaign for women farmers\' cooperatives won an industry award.',
  'Water conservation campaign with rural women\'s self-help groups.',
  'Senior citizen savings scheme awareness film.',
  'Campaign aimed at working mothers in metros.',
  'Content for young parents on a baby-care brand.',
  'Male allyship in the workplace campaign.',
  'Transgender inclusion hiring campaign for a retailer.',
  'LGBTQ+ ally campaign for an employer brand.',
  'Muslim women entrepreneurs spotlight on LinkedIn.',
  'Christian missionary school fundraiser film.',
  'Sikh heritage documentary promotion.',
  'Buddhist circuit tourism campaign for a state board.',
  'Hindi-language and Marathi-language ad variants.',
  'South India launch campaign in Tamil and Telugu.',
  'North India market entry via Punjabi influencers.',
  'Gujarati audience reels for a jewellery brand.',
  'Campaign tackling caste discrimination in hiring awareness.',
  'Religious harmony film for a media house.',
  'Accessibility campaign for wheelchair users on a travel app.',
  'Mental health awareness series for a university.',
  'Breast cancer awareness campaign for a hospital group.',
  'Pregnancy care app launch with obstetrician explainers.',
  'Marriage and matrimony brand repositioning for a Gen Z audience.',
  'Wedding season campaign for a jewellery brand.',
  'Age-gate and age verification messaging for a fintech.',
  'Age group 18-24 drove 60% of conversions.',
  'Aged 25-34 segment responded best to Reels.',
  'Women aged 30 to 45 were the primary buyers.',
  'Audience gender: 54% female, 46% male in the campaign analytics.',
  'Gender split: 60% women, 40% men.',
  'Audience demographics: 62% female, 25-34 age band.',
  'Persona: working women in their thirties who commute daily.',
  'Target persona is a married professional in a metro.',
  'Women-led startups were the main target for the B2B launch.',
  'Gender-neutral language used in the employer branding series.',
  'Retirement planning for senior citizens, 60+ audience.',
  'Kids and teens engagement via school contests.',
  'Led creative direction for a team of 4 designers and 2 writers.',
  'Reach grew from 12K to 340K in six months.',
  'Strong copy across LinkedIn, email and landing pages.',
  'No evidence of video production; only thumbnails were seen.',
  'Work is mostly B2C; B2B experience is not shown.',
  'The deck shows a clear brand system with consistent colour and type.',
  'Candidate is credited as creative lead on the campaign.',
  'The candidate is the sole author of the case study.',
  'The candidate is not credited anywhere on the page.',
  'Candidate is named as brand manager in the project credits.',
  'The work credits a different agency lead; ownership is unclear.',
  'Only 2 of 5 campaigns show results with a baseline.',
  'The portfolio site loads fast and is easy to navigate.',
  'Single case study reviewed; limited breadth.',
  'Single campaign shown with clear numbers.',
  'She led five campaigns with measurable results.',
  'He built the brand from zero at an early-stage company.',
  'The candidate is a strong writer with a distinct voice.',
  'The candidate is a clear communicator in the explainer scripts.',
  'The candidate is an experienced marketer with campaign depth.',
  'Likely a collaboration between the candidate and an agency.',
  'Probably a team effort; the personal role is not stated.',
  'Appears to be an in-house campaign for a mid-size brand.',
  'Seems to be a template site with stock imagery.',
  'The candidate appears to have led the rebrand.',
  'It looks like a polished deck with consistent layouts.',
  'Likely a startup context given the stated headcount.',
  'The designer credited is a freelancer, not the candidate.',
  'The founder quoted in the case study endorses the campaign.',
  'The host of the podcast series is the client\'s CEO.',
  'The speaker series featured CXO conversations on LinkedIn.',
  'The narrator voice-over in the film is clear and warm.',
  'The campaign targets young professionals on LinkedIn.',
  'Targets senior leaders and CXOs through thought leadership.',
  'Instagram bio snippet only; no work was viewed.',
  'Results table is clear: 5.2% conversion vs 1.8% baseline.',
  'Built a content engine producing 12 posts a week with two designers.',
  'The candidate is a former agency creative director at a mid-size agency.',
  'The candidate is a founder-led brand storyteller.',
  'The candidate is still at an early-stage startup.',
  'The candidate is currently a head of brand at a fintech.',
  'The candidate is based in Mumbai and works with distributed teams.',
  'The candidate is fluent in Hindi and English copywriting.',
  'The candidate is a fast executor under tight budgets.',
  'The candidate is the owner of the brand voice document.',
  'Candidate is a mission-driven marketer with water sector work.',
  'Candidate is a self-taught designer with a polished portfolio.',
  'The candidate is a young brand\'s first marketing hire.',
  'The campaign is a Hindu-festival tie-in for a sweets brand.',
  'Strong mother-tongue Marathi copy variants for regional reach.',
  'Quotes from a Muslim community leader anchor the film.',
  'The work for the Catholic school network reads consistently.',
  'The campaign for the senior-living brand used large readable type.',
  'Large-format posters for a men\'s health screening drive.',
  'Female-founder stories drive the B2B content calendar.',
  'Likely a seasonal campaign tied to Diwali sales.',
  'Probably a paid campaign given the reach figures.',
  'The candidate appears to have run a successful influencer program.',
  'The candidate appears to be the author of the blog.',
  'The candidate appears to be credited on slide 3.',
  'The candidate is the founder of the agency shown.',
  'The candidate is an author of two published whitepapers.',
  'Single-page site with a clear call to action.',
  'A short film with a female lead and a male voice-over.',
  'The ad features an elderly couple and their grandson.',
  'The film shows a mother and her daughter in a kitchen.',
  'The creative shows a young woman using the app.',
  'Features a young man cycling to work in the hero shot.',
  'Persona: Priya, a mother of two juggling work and school runs, drives the app messaging.',
  'Paternity leave policy explainer video for an employer-branding campaign.',
  'Maternity leave policy campaign for a fintech employer brand.',
  'Marital status field redesign in the matrimony app onboarding flow.',
  'Gender: 54% female, 46% male (campaign analytics, Q3).',
  'Demographics - Gender: female 61%, male 39%.',
  'Age: 25-34 drove 60% of conversions.',
  'The host is a Hindu priest who narrates the temple series.',
  'The speaker is a Sikh veteran featured in the Republic Day film.',
  'The founder is a woman entrepreneur featured in the client case study.',
  'The creator is a female Instagram influencer the candidate partnered with.',
  'The presenter is a famous man from the cricket world; the candidate negotiated the deal.',
  'The influencer is a woman in her thirties with 1.2M followers; the candidate managed the partnership.',
  'Celebrity partnership: the actress is a mother of two and a brand ambassador.',
  'The author is a Dalit writer whose book the candidate promoted.',
  'The founder is a Muslim entrepreneur whose story anchors the campaign.',
  'She is a mother figure in the ad film.',
  'He is a father in the TVC and his daughter is the lead.',
  'Likely married couple in the ad; the hero shot shows a family.',
  'The designer is a woman the candidate hired and mentored.',
  'Candidate hired a young designer and mentored her.',
  'The candidate led a team of young designers.',
  'The candidate is young in the category: first launch of a D2C brand.',
  'Candidate is single-handedly responsible for the social channels.',
  'The candidate is single-handedly the brand team.',
  'The candidate is married to the idea of data-led storytelling.',
  'The candidate is married to a data-first approach.',
  'The candidate appears to be passionate about climate.',
  'The candidate appears to be an agency veteran.',
  'The candidate is a man of few words in the pitch deck; copy is terse and clear.',
  'The candidate is a woman-led brand specialist.',
  'The candidate is senior in the org, reporting to the CEO.',
  'The candidate is a senior marketer with a decade in B2B.',
  'The candidate is a senior brand manager.',
  'The candidate is a junior designer-turned-marketer.',
  'The candidate is in charge of the brand and the creative team.',
  'The candidate is mid-level based on the scope of the campaigns.',
  'The applicant is from a startup background.',
  'The applicant is from the agency world.',
  'She is from Zomato\'s brand team per the credits.',
  'He is from a performance-marketing background.',
  'The candidate comes from a B2B SaaS background.',
  'The candidate seems to be a generalist.',
  'The candidate seems to be a fast executor.',
  'The candidate looks like a strong storyteller.',
  'The candidate looks to be early in their leadership journey.',
  'The candidate looks senior in the credits (Head of Brand).',
  'The candidate was a founding team member.',
  'The candidate was the first marketing hire.',
  'The candidate remains credited on the later campaigns.',
  'Candidate is a Hindi-first writer with English fluency.',
  'The candidate stays within brand guidelines consistently.',
  'The author of the white paper is the candidate.',
  'The author credit reads "Priya", the candidate\'s first name matches nothing else on the page.',
  'Women\'s representation in the cast was 50%.',
  'The cast included a Sikh man, a Muslim woman and a Dalit youth.',
  'The film depicts a Hindu wedding with a Muslim guest.',
  'The brand targets married women in tier-2 cities.',
  'Parents of young children were the core audience.',
  'Pregnant women were the target in the prenatal vitamin campaign.',
  'Likely a mother-and-baby product given the visuals.',
  'Probably aimed at men in their forties.',
  'Likely targeted at women over 40.',
  'Probably young women in metros.',
  'Appears to be aimed at senior citizens.',
  'Appears to be aimed at Muslim consumers during Ramadan.',
  'The audience appears to be Gen Z.',
  'The audience seems to be women.',
  'The audience looks young and urban.',
  'The audience is women aged 25-40.',
  'The main audience is women.',
  'Audience was mostly men aged 30-45.',
];

// A second corpus written after the first one passed (92 leaks).
const SECOND_LEAKS: string[] = [
  'She comes across as a confident woman who leads from the front.',
  'The portfolio owner is a man in his early forties.',
  'Being a woman leader in a male-dominated industry, the candidate stands out.',
  'It looks like the work of a young woman.',
  'The candidate, a woman, has built three brands.',
  'Candidate is male.',
  'The applicant is a trans woman.',
  'This is a female candidate with strong credentials.',
  'The founder is a gay man who started an LGBTQ+ collective.',
  'Seems to be a woman, going by the voice-over.',
  'The creator is a non-binary designer.',
  'The presenter is a woman in her thirties.',
  'The candidate graduated in 2004, so is probably around 40.',
  'He must be pushing 50.',
  'She was born in the late 80s.',
  'A fresh graduate in her early twenties.',
  'The founder is 29.',
  'Candidate is in his sixties and still shipping campaigns.',
  'Probably 35 years old.',
  'The applicant appears to be in their late fifties.',
  'The designer is a 27-year-old woman.',
  'Looks to be in his mid forties.',
  'The author is a millennial marketer.',
  'The candidate is a Gen Z creator.',
  'She is a devout Christian.',
  'The candidate is a Muslim woman.',
  'The founder, a Sikh, built the brand from a garage.',
  'Their religion is Hindu.',
  'The speaker is an observant Jew.',
  'He wears a turban and a beard.',
  'The candidate is a Buddhist.',
  'The surname suggests an upper-caste background.',
  'The candidate is a Dalit.',
  'She is from the Brahmin community.',
  'The candidate is of South Indian origin.',
  'The surname suggests a Bengali background.',
  'Her name indicates she is Muslim.',
  'He is a Parsi gentleman.',
  'The candidate is probably Tamilian.',
  'She is Nepali.',
  'The applicant is American.',
  'The candidate is an immigrant.',
  'The candidate is a first-generation immigrant.',
  'She is a foreigner working in India.',
  'He is a non-native English speaker.',
  'The candidate recently became a father.',
  'She just returned from maternity leave.',
  'He has three kids.',
  'She is a single mum.',
  'Candidate is an expectant mother.',
  'The career gap in 2019 was due to maternity leave.',
  'Employment gap, possibly maternity.',
  'The gap between 2018 and 2020 was likely due to marriage.',
  'She is married with two children.',
  'The designer is a newlywed.',
  'Her husband is a software engineer.',
  'The founder is a widower.',
  'The candidate is visually impaired.',
  'The designer uses a wheelchair.',
  'The candidate has a chronic illness.',
  'The applicant was diagnosed with cancer.',
  'She is autistic.',
  'Career gap probably for health reasons.',
  'Appears overweight.',
  'The presenter is strikingly good-looking.',
  'He is a handsome man with a warm smile.',
  'Her appearance helps on camera.',
  'Judging by her photo she is attractive.',
  'Based on the name, likely a Muslim woman.',
  'Going by his surname, he is a Gujarati.',
  'Email: priya at the rate of gmail dot com',
  'Reach her on 98765-43210.',
  'WhatsApp +919876543210 for the deck.',
  'ph: 022-2345-6789',
  'Call 98 76 54 32 10 after 6 pm.',
  'Write to hello@priyasharma.design for the full portfolio.',
  'Contact: jane dot doe at gmail dot com',
  'My number is nine eight seven six five four three two one zero.',
  'The c.a.n.d.i.d.a.t.e is f.e.m.a.l.e.',
  'The candidate is a fem4le.',
  'She is m_a_r_r_i_e_d.',
  'The candidate is a *woman*.',
  'The candidate is (female).',
  'The candidate is "married".',
  'The candidate is a w0man.',
  'The candidate is a Mus\u200blim.',
  'Candidate shaadi shuda hai.',
  'Woh ek ladki hai.',
  'Uski umar 40 saal hai.',
  'Hindu hain.',
  'यह उम्मीदवार महिला है।',
  'उम्मीदवार शादीशुदा है।',
];

// ... and its topics (126).
const SECOND_TOPICS: string[] = [
  'Led the rebrand of a 40-year-old water utility, repositioning it for a younger audience.',
  'Campaign for rural women\'s self-help groups reached 3M views.',
  'Strong storytelling for senior leadership audiences.',
  'No evidence the candidate led a team; only individual contributions are shown.',
  'The candidate is credited as Creative Lead on the 2023 Jal Mitra campaign.',
  'Work for Muslim Aid and Hindu Seva Trust shows range across faith-based clients.',
  'Campaign targeted young professionals aged 25-34 in metro cities.',
  'Case study features a female plant operator who became a brand ambassador.',
  'The film\'s protagonist is a mother of two who walks 5 km for water.',
  'The deck shows a Dalit entrepreneur\'s journey from shop floor to CEO.',
  'Single-page microsite with a strong CTA.',
  'The candidate is a former journalist turned brand storyteller.',
  'Candidate is a senior brand manager with B2B exposure.',
  'The candidate appears to be a strong generalist who has worked with Hindu and Muslim communities.',
  'She is Head of Brand at an Indian fintech.',
  'The candidate is from an Indian agency background in Mumbai.',
  'The candidate is an American Express alum.',
  'The applicant is Indian Oil\'s former brand lead.',
  'Candidate was awarded Young Marketer of the Year 2022.',
  'A brand for older adults: "Age Is Just a Number".',
  'Her campaign for pregnant women reached 4M.',
  'The candidate, who is a mother brand specialist, joined in 2021.',
  'The agency\'s client, a Sikh-owned dairy, saw 30% growth.',
  'The brand voice is warm, feminine and inclusive.',
  'Campaign speaks to men and women equally.',
  'Appears to be a mid-size agency.',
  'Likely to be a seasonal campaign tied to Eid.',
  'Probably in their first year of operations.',
  'The candidate seems to be in their element presenting to CXOs.',
  'They are in their third year of the campaign.',
  'Audience: women in their thirties, likely married, in tier-2 cities.',
  'Persona 1: married women in their 30s.',
  'Target: urban men, 25-40.',
  'Targeting new mothers with a baby-care app.',
  'Core message: "Every drop counts".',
  'The candidate is blind to platform nuances (a gap).',
  'Campaign for visually impaired users reached 1M.',
  'The film features a deaf protagonist.',
  'The candidate is the founder of a women-led agency.',
  'The candidate looks like the person who built the identity from zero.',
  'Seems like a Hindu temple trust campaign.',
  'Rebrand for a 25-year-old cooperative serving 40,000 women farmers.',
  'Social series on menstrual hygiene for adolescent girls across 12 states.',
  'Launch film for a men\'s grooming brand drove 1.2M views.',
  'The youth campaign used Reels and Shorts to reach Gen Z.',
  'Ran a CSR campaign for tribal communities in Odisha with local-language films.',
  'Content series spotlighting Dalit and Adivasi water champions.',
  'Event for 300 CXOs, 40% of them women leaders in industry.',
  'Led a team of 3 designers, 2 writers and a videographer.',
  'The case study states: "We grew leads 3x in 6 months with a team of two."',
  'Results: 5.2% conversion against a 1.8% baseline; reach grew from 12K to 340K.',
  'Ran 7 campaigns for a Series A startup with a budget under 5 lakh.',
  'The portfolio site is fast, responsive and easy to navigate.',
  'Copy is concise, with a distinct voice across LinkedIn, email and landing pages.',
  'Strong mission fit: sustained work in climate and water.',
  'The candidate is the sole author of the case study on Mission Jal.',
  'The page names a different agency lead; the candidate\'s own role is unclear.',
  'The candidate is not mentioned in the credits.',
  'Only the last two years of work are shown.',
  'Twelve campaigns are listed; four have numbers.',
  'Likely a collaboration with the in-house design team.',
  'Appears to be a freelance project for a D2C brand.',
  'This looks like a template site with stock photos.',
  'Seems to be a polished deck with consistent layouts.',
  'The candidate has led brand work at two early-stage startups.',
  'He has shipped campaigns for three B2B SaaS companies.',
  'She has run influencer programmes with 40 creators.',
  'They have a clear grasp of platform dynamics in the work shown.',
  'The candidate has a strong eye for typography and layout.',
  'He has a background in film and journalism.',
  'She is a skilled copywriter with range across formats.',
  'The candidate is an experienced marketer with campaign depth.',
  'The candidate is a clear communicator who adapts tone to the audience.',
  'The designer credited on the page is a freelancer, not the candidate.',
  'The influencer, a farmer from Punjab, fronted the film.',
  'The anchor of the series is a Muslim scholar the candidate commissioned.',
  'The CEO, a woman who started in sales, is quoted in the case study.',
  'The founder is a woman who featured in three of the campaigns.',
  'The brand ambassador is a married couple from Kerala.',
  'The actor is a father of two and the face of the campaign.',
  'The host is a Sikh chef who stars in the cooking series.',
  'Likely married couple in the ad; the hero shot shows a family.',
  'The ad shows a mother and daughter fetching water.',
  'The cast includes a young woman, an elderly man and two children.',
  'A young woman is shown testing the water on camera.',
  'The campaign tagline reads: "She leads. He follows."',
  'The age of the brand (est. 1998) is used as a trust signal.',
  'Age verification messaging for a gaming client.',
  'Gender-neutral copy guidelines were part of the brand system.',
  'Gender: 48% female, 52% male (audience analytics).',
  'Religion-neutral festive greetings were used across the campaign.',
  'Reach among women aged 35 to 44 doubled.',
  'Marital status was a filter in the matrimony app the candidate redesigned.',
  'The maternity leave policy video went viral on LinkedIn.',
  'Paternity benefits explainer for an employer brand.',
  'Disability inclusion hiring campaign for a bank.',
  'Accent colours are used sparingly against a navy base.',
  'The deck uses a warm accent colour and consistent type.',
  'Native-language content in Marathi and Tamil lifted engagement.',
  'The candidate is fluent in English, Hindi and Marathi.',
  'The candidate is based in Pune and works with distributed teams.',
  'Hindu, Muslim and Christian voices anchor the film.',
  'Sikh farmers feature in the harvest campaign.',
  'The work for the Catholic hospital network is consistent.',
  'Founder interviews are a recurring format in the content calendar.',
  'Their brand guidelines are clear and well documented.',
  'Their campaign on rainwater harvesting drove 12K signups.',
  'Likely in the early stages of building the content engine.',
  'Probably 35 campaigns across 4 years, but only 6 are shown.',
  'Likely 40 posts per month based on the feed.',
  'Reached 24M impressions across 3 platforms.',
  'Shot at f/2.8 with natural light for the hero images.',
  'Video views reached 36M with a 24M organic share.',
  'Water temperature was held at 72F in the demo film.',
  'Handle @waterwarriors grew from 2K to 40K followers.',
  'Budget of 8,00,000 and a team of 3.',
  'Ticket 98765 was closed in 3 days.',
  'FY2022-2023 delivered 7 launches.',
  'Mail the deck to hello@ only after approval.',
  'Press kit includes the logo, palette and boilerplate.',
  'The candidate is a mission-driven marketer.',
  'The candidate is an early hire at a seed-stage startup.',
  'The candidate is a young brand\'s first marketing hire.',
  'The candidate is married to the idea of data-led storytelling.',
  'He is a father figure to the creative team.',
  'She is a mother brand strategist at a holding company.',
];

// A third corpus, written last and measured before any rule was changed for it (42 leaks; its first measurement was recall 93%, precision 98%).
const THIRD_LEAKS: string[] = [
  'The CV suggests the candidate is a mum returning to work.',
  'Candidate (F, 32) has strong B2B experience.',
  'She is a Hindu from Rajasthan.',
  'The applicant, aged 52, has led brand teams.',
  'He\'s a 41 year old father of two.',
  'She\'s a woman who built the brand.',
  'His wife\'s name is listed as a referee.',
  'The candidate has a 5-year-old son.',
  'The candidate is a person of colour.',
  'The presenter is white.',
  'She wears a sari in all the videos.',
  'DOB 14/03/1990.',
  'Birthday: 3 May 1988.',
  'The candidate seems like the kind of woman who leads from the front.',
  'The presenter has a Southern accent.',
  'Candidate: F, 29.',
  'He is a man in his late fifties, calm and measured.',
  'The candidate is a practising Sikh.',
  'The author is Jain.',
  'Probably a Rajput.',
  'The designer is divorced.',
  'She is a stay-at-home mum returning to work.',
  'The candidate is dyslexic.',
  'He is autistic.',
  'The host is stunningly beautiful.',
  'Judging from the headshot, she is in her forties.',
  'The founder looks to be about 50.',
  'He appears to be in his thirties.',
  'Probably a woman.',
  'The creator is a transgender man.',
  'The candidate is Pakistani.',
  'She is British.',
  'Reach me: priya (at) gmail (dot) com',
  'My WhatsApp is 98765 43210',
  'Mobile: +91 98765 43210',
  'Telephone 0 2 2 2 3 4 5 6 7 8 9',
  'She is pr3gnant.',
  'The candidate is a m.u.s.l.i.m.',
  'Candidate Muslim hai.',
  'Woh mahila hai.',
  'उसकी उम्र 40 साल है।',
  'उम्मीदवार हिंदू है।',
];

// ... and its topics (82).
const THIRD_TOPICS: string[] = [
  'The candidate\'s portfolio is hosted on a personal domain.',
  'Targeting married women in their thirties through WhatsApp.',
  'Likely aimed at Hindu households during Diwali.',
  'The candidate is a mother of invention when it comes to guerrilla marketing.',
  'He is the father of the Har Ghar Jal tagline.',
  'The candidate maintains a single brand voice across channels.',
  'The candidate is single in focus: one KPI per campaign.',
  'She is married to the brand\'s mission.',
  'Campaign for first-time mothers on a baby-care app delivered 18% conversion.',
  'The campaign aimed at young farmers in Maharashtra won a regional award.',
  'Sikh and Hindu volunteers appear in the film.',
  'He built a community of 40,000 women entrepreneurs.',
  'The candidate is a skilled storyteller who has worked on water, climate and health.',
  'Reached 1.2M women across 8 states in 6 weeks.',
  'The brand targets men aged 30 to 45 who buy online.',
  'The candidate has a strong network in the climate sector.',
  'She has 10 campaigns with documented results.',
  'He has a family-friendly employer brand portfolio.',
  'She led a campaign about religious harmony.',
  'The page lists the candidate\'s role as Creative Director.',
  'The candidate is a member of the Water Council.',
  'The candidate is a former agency creative.',
  'The portfolio is clean; the candidate is detail-oriented.',
  'The candidate is highly detail-oriented about brand consistency.',
  'The candidate is a strategic thinker with a bias for action.',
  'The candidate is fluent in four languages.',
  'The candidate is a fast learner who adapts to platforms.',
  'He is a seasoned marketer.',
  'She is a prolific writer across LinkedIn and Medium.',
  'The candidate appears to be the lead on the 2022 rebrand.',
  'It looks like the work of a small in-house team.',
  'Likely the work of an agency rather than the candidate.',
  'Probably the work of a freelance designer.',
  'Hindu, Sikh, Muslim and Christian festivals are covered in the calendar.',
  'The ad film follows a young woman who tests water quality in her village.',
  'In the film, a father teaches his daughter to read the water meter.',
  'The influencer, a mother of three, shared the campaign with 200K followers.',
  'The campaign\'s hero is a 70-year-old woman who walks 3 km for water.',
  'The client is a Muslim-owned business; the candidate wrote its brand story.',
  'A Christian charity commissioned the campaign.',
  'The Hindu newspaper carried the op-ed the candidate wrote.',
  'The Muslim Women\'s Forum was a client.',
  'Guest speaker at the Women in Water summit.',
  'The Women\'s Cricket World Cup sponsorship drove 3M impressions.',
  'She grew the Instagram handle from 5K to 120K.',
  'He ran 4 events for 200 attendees each.',
  'The designer on the project is credited as a contractor.',
  'The author of the whitepaper is the candidate.',
  'The speaker series featured water-sector CXOs.',
  'The founder quoted is the client\'s MD.',
  'Age-inclusive design was a requirement in the brief.',
  'Aged inventory campaign for a retail client cleared 60% of stock.',
  'Targets adults aged 18+ with a savings app.',
  'Women aged 25-40 were the core segment.',
  'The deck covers audience age, gender and location splits.',
  'Results include a 38% lift among female users.',
  'Male users converted at 4.1%, female users at 5.3%.',
  'The brand is feminine without being pink.',
  'The brand voice is masculine and direct.',
  'Their latest film won a Cannes Lion shortlist.',
  'They produced 12 explainer videos.',
  'The candidate\'s experience spans 5 startups.',
  'Over 5 years of campaign data is shown.',
  'A 3-year content roadmap was presented to the board.',
  'Likely 12 campaigns, of which 4 are documented.',
  'Call to action: book a demo at the link below.',
  'Call the toll-free number for the helpline (toll free).',
  'Download the 2023 report (pages 12-34).',
  'Page 98 of the deck shows the results table.',
  'Follow the brand at @digitalpaani.',
  'Reach grew 3x between 2022 and 2023.',
  'A campaign for the Muslim community on organ donation.',
  'Content for Hindu festivals drove 40% of annual traffic.',
  'The candidate is Hindi-first and writes fluent English.',
  'The candidate speaks fluent Marathi and Hindi.',
  'The candidate is the author of a popular newsletter.',
  'The candidate is an advisor to two climate startups.',
  'The candidate is blind-copied on all client mails.',
  'The candidate is a mature, hands-on operator.',
  'Mature brands like Tata and Godrej were the clients.',
  'The senior citizen helpline campaign won an award.',
  'The candidate is a senior leader with a decade of B2B brand work.',
];

// ─── The previous rubric.marketing.test.ts, verbatim except for ONE case ─────
// 'He is a man of few words' used to be dropped; the adversarial review lists the idiom as a must-keep ("man of few words" is not a
// statement about a gender), so it moved to the keep table below.
describe('legacy contract (the rubric.marketing tests before the swap): filterProtectedAttributes — content about a group is kept', () => {
  const keep = [
    // the contract's must-keeps
    'Women\'s Day campaign reached 2M views',
    'Gender-equality campaign for rural water access',
    'Senior-citizen outreach series',
    'Diwali festive campaign',
    'Campaign for Muslim-owned small businesses',
    // other campaign content
    'Women-led startup rebrand',
    'Campaign on maternal health reached 1M parents',
    'Maternity-care awareness reel series',
    'Pregnancy nutrition explainer videos for ASHA workers',
    'Family-planning awareness campaign',
    'Hindu festival Holi campaign for a dairy brand',
    'Eid greetings social series',
    'Christmas campaign for a retail brand',
    'Campaign for young farmers in Punjab',
    'Led a campaign targeting young mothers',
    'Targeted men and women aged 25 to 40',
    'Campaign aimed at men and women aged 25-40',
    'Targeting adults aged 18+',
    'Target age: 25-34',
    'Audience gender: all',
    'Campaign for people in their 30s',
    'Christian Dior campaign analysis',
    'Women\'s Day campaign for Jain Irrigation',
    'Jain Irrigation social launch',
    'Asian Paints brand film study',
    'Mother Dairy summer campaign',
    // statements that are not about a protected attribute
    'She launched a campaign for women farmers',
    'She led five campaigns',
    'He is a strong copywriter',
    'The candidate is a senior strategist',
    'The candidate is single-handedly responsible for the launch',
    'She is a pretty good copywriter',
    'She is a pretty strong writer',
    'She is a mother brand specialist',
    'The candidate is a parent company brand lead',
    'The host of the series is Priya',
    'She is Aarti Jain',
    'The founder is a woman-led startup advisor',
    'Probably the best portfolio in the pool',
    'Likely to resonate with young women',
    'Likely appeals to Muslim audiences',
    'Probably a woman-led brand',
    'Probably a young brand',
    'Seems like a Hindu festival campaign',
    'Likely a women\'s collective',
    'Likely male audience',
    'Her body of work spans women\'s health campaigns',
    'Her appearance on the podcast drove signups',
    'His children\'s book campaign won an award',
    'Beautiful visual identity and strong typography',
    'Attractive pricing creative for a B2B SaaS',
    'A stunning microsite with scroll-driven storytelling',
    'Led the rebrand of a 10-year-old company',
    'A 5-year-old startup rebrand',
    'The company is 3 years old',
    'Page 2 of the portfolio',
    'Stage 3 of the funnel',
    'Over 8 years of agency experience',
    'Age-old traditions retold for a new audience',
    'Probably a young team',
    'Probably young women',
    'Likely a male-dominated sector',
    'Looks like a female-founder-led startup',
    'Appears to be a young company with a bold identity',
    'The founder is married to the brand vision',
    'Average age 35 across the audience',
    'She is an elderly-care brand strategist',
    'The candidate is an Indian-market specialist',
    'He is a speaker at the Water Summit 2024',
    'The speaker is a recognised voice in water policy',
    'The campaign features a Sikh farmer and his family',
    'Muslim, Hindu and Christian voices featured in the film',
    'Celebrates a Hindu-Muslim friendship story',
    'Single-minded focus on measurable results',
    'Appears to be a married-couple-run agency',
    'Instagram work is aimed at women in rural India.',
    'Candidate credits themselves as sole creative lead on the 2023 Mission Jal campaign.',
    'No campaign metrics are stated, so results are unverified.',
    'Likely strong at social-first creative based on the reels.',
  ];
  it.each(keep)('keeps %j', (s) => {
    expect(findProtectedAttribute(s)).toBeNull();
    expect(filterProtectedAttributes([s])).toEqual({ kept: [s], dropped: 0 });
  });
});

describe('legacy contract (the rubric.marketing tests before the swap): filterProtectedAttributes — statements about the candidate are dropped', () => {
  const drop: Array<[string, string]> = [
    // the contract's must-drops
    ['Candidate appears to be a young woman', 'subject-attribute'],
    ['She is probably married with kids', 'subject-attribute'],
    ['Likely in his 40s', 'hedged-attribute'],
    ['The candidate is a Hindu from North India', 'subject-attribute'],
    ['Good-looking presenter in the videos', 'appearance'],
    ['Contact: jane@x.com', 'email'],
    ['Call +91 98765 43210', 'phone'],
    // gender
    ['The founder is a woman', 'subject-attribute'],
    ['The female candidate led six campaigns', 'attribute-candidate'],
    ['She identifies as non-binary', 'subject-attribute'],
    // age
    ['The candidate appears to be in her early 30s', 'subject-attribute'],
    ['He is a 34 year old man', 'age'],
    ['A 52-year-old woman fronts the videos', 'age'],
    ['She is 29 years old', 'age'],
    ['The candidate is 35.', 'age'],
    ['Candidate is aged 41', 'age'],
    ['The candidate is at the age of 34', 'age'],
    ['Probably in her mid-30s', 'hedged-attribute'],
    ['She might be too young for this role', 'age'],
    ['He is a young gun in marketing', 'subject-attribute'],
    // religion, caste, ethnicity
    ['Seems to be a Sikh woman', 'hedged-attribute'],
    ['Probably a young Sikh woman.', 'hedged-attribute'],
    ['Likely female, based on the name', 'hedged-attribute'],
    ['Appears male and in his 30s', 'hedged-attribute'],
    ['Probably a Hindu from North India', 'hedged-attribute'],
    ['Looks like a married woman', 'hedged-attribute'],
    ['Seems to be in her forties', 'hedged-attribute'],
    ['Possibly pregnant', 'hedged-attribute'],
    ['She is in her thirties', 'subject-attribute'],
    ['Probably Muslim', 'hedged-attribute'],
    ['Likely a Christian', 'hedged-attribute'],
    ['She is Jain.', 'subject-attribute'],
    ['The applicant is Brahmin', 'subject-attribute'],
    ['The candidate belongs to the Rajput community', 'subject-attribute'],
    ['He comes from a Dalit family', 'subject-attribute'],
    ['She is dark-skinned', 'subject-attribute'],
    ['The candidate is a Muslim woman', 'subject-attribute'],
    ['A Hindu applicant with a strong portfolio', 'attribute-candidate'],
    // marital and family status, pregnancy
    ['Candidate is single', 'subject-attribute'],
    ['The candidate is a divorced man', 'subject-attribute'],
    ['The candidate is a mother of two', 'subject-attribute'],
    ['She is expecting a baby', 'subject-attribute'],
    ['Married with kids', 'family'],
    ['Her husband works in finance', 'family'],
    ['She has two small children', 'family'],
    ['He has a young family', 'family'],
    ['She may start a family soon', 'family'],
    ['She might get pregnant', 'family'],
    ['Maternity leave gap in the CV', 'family'],
    ['Marital status: married', 'family'],
    // appearance
    ['Attractive young woman presenting the reel', 'appearance'],
    ['The presenter is very attractive', 'appearance'],
    ['The host looks stunning', 'appearance'],
    ['Her looks helped the video perform', 'appearance'],
    ['Handsome speaker with a deep voice', 'appearance'],
    ['A pretty woman fronts the film', 'appearance'],
    ['Dark-skinned presenter in the videos', 'appearance'],
    // inferring from a name or picture
    ['Judging by her name she is from the south', 'inference-source'],
    ['Based on the profile picture alone', 'inference-source'],
    ['Based on the profile picture, the candidate looks young', 'subject-attribute'],
    ['Going by his surname', 'inference-source'],
    ['Inferred from the headshot', 'inference-source'],
    ['Guessed from her accent', 'inference-source'],
    // attributes named as fields
    ['Her age is a concern', 'attribute-field'],
    ['Gender: Female', 'attribute-field'],
    ['Date of birth: 12 May 1990', 'attribute-field'],
    ['Religion: Hindu', 'attribute-field'],
    ['The candidate\'s gender is not stated', 'attribute-field'],
    ['Gender of the candidate unclear', 'attribute-field'],
  ];
  it.each(drop)('drops %j (%s)', (s, rule) => {
    expect(findProtectedAttribute(s)).toBe(rule);
    expect(filterProtectedAttributes([s])).toEqual({ kept: [], dropped: 1 });
  });
});

describe('legacy contract (the rubric.marketing tests before the swap): filterProtectedAttributes — contact details', () => {
  const contact = [
    'Contact: jane@x.com', 'Reach her at jane.doe+hr@example.co.in for more', 'jane_doe@sub.example-mail.org',
    'jane [at] example [dot] com', 'jane(at)example.com', 'jane (at) example (dot) com', 'jane at example dot com',
    'jane\uff20example.com', 'JANE@EXAMPLE.COM',
    'Call +91 98765 43210', 'WhatsApp 98765 43210', '+91-98765-43210', '098765 43210', '9876543210', '98765.43210',
    '(022) 2345 6789', '+1 (555) 010-9999', '+44 20 7946 0958', '9 8 7 6 5 4 3 2 1 0', 'Phone: 98765-43210 (office)',
    'Call me on \uff19\uff18\uff17\uff16\uff15 \uff14\uff13\uff12\uff11\uff10', '\uff0b\uff19\uff11 98765 43210',
  ];
  it.each(contact)('drops %j', (s) => {
    expect(['email', 'phone']).toContain(findProtectedAttribute(s));
    expect(filterProtectedAttributes([s]).dropped).toBe(1);
  });

  const notContact = [
    'Handle @digitalpaani on Instagram', 'Posted at 5 pm on Friday', 'Reached 1250 leads in 90 days', 'Budget of \u20b950,00,000',
    'Followers grew from 12000 to 48000', 'Campaigns in 2019, 2020, 2021 and 2022', 'Delivered between 2019 2020 2021',
    'FY2022-2023 performance', '2019-2020-2021-2022 retrospective', 'Reach 2.5M in 3 months', 'ROI of 3.2x', 'Ticket 12345 closed',
    'Case study on water@scale conference',
  ];
  it.each(notContact)('keeps %j', (s) => {
    expect(findProtectedAttribute(s)).toBeNull();
  });
});

describe('legacy contract (the rubric.marketing tests before the swap): filterProtectedAttributes — obfuscation and unicode', () => {
  it.each([
    ['She is m\u200barried', 'zero-width space inside the word'],
    ['She is mar\u00adried', 'soft hyphen'],
    ['She is \u202emarried', 'bidi override'],
    ['SHE IS PROBABLY MARRIED', 'upper case'],
    ['CANDIDATE APPEARS TO BE A YOUNG WOMAN', 'upper case'],
    ['\uff33\uff28\uff25 \uff29\uff33 \uff2d\uff21\uff32\uff32\uff29\uff25\uff24', 'full-width letters'],
    ['The candidate is a H\u0456ndu', 'Cyrillic i'],
    ['The candidate is a Mu\u0455lim', 'Cyrillic s'],
    ['The candidate is a Musl\u00edm', 'accent'],
    ['The candidate is a Musli\u0301m', 'combining accent'],
    ['She is m a r r i e d', 'spaced letters'],
    ['She is  \t probably \n married', 'odd whitespace'],
    ['The candidate\u2019s gender is unclear', 'curly apostrophe'],
    ['She is a woman — and a leader', 'em dash after the term'],
    ['Probably in her mid\u201130s', 'non-breaking hyphen'],
  ])('drops %j (%s)', (s) => {
    expect(filterProtectedAttributes([s]).dropped).toBe(1);
  });

  it('still keeps campaign content written with typographic characters', () => {
    expect(filterProtectedAttributes(['Women\u2019s Day campaign reached 2M views']).dropped).toBe(0);
    expect(filterProtectedAttributes(['Gender\u2011equality campaign for rural water access']).dropped).toBe(0);
    expect(filterProtectedAttributes(['\uff37omen\u2019s Day campaign']).dropped).toBe(0);
  });

  it('a word that is only a prefix or suffix of a longer one is not a term', () => {
    expect(findProtectedAttribute('She is a manager of managers')).toBeNull();
    expect(findProtectedAttribute('She is a mandate holder')).toBeNull();
    expect(findProtectedAttribute('The candidate is a hindu-kush trekking guide')).toBeNull();
    expect(findProtectedAttribute('She is a marketing expert')).toBeNull();
  });
});

describe('legacy contract (the rubric.marketing tests before the swap): filterProtectedAttributes — behaviour', () => {
  it('keeps the other strings verbatim and in order, and counts what it dropped', () => {
    const input = ['  Launched six campaigns  ', 'She is probably married with kids', 'Contact: jane@x.com', 'Strong copy range', 'Likely in his 40s'];
    const out = filterProtectedAttributes(input);
    expect(out.kept).toEqual(['  Launched six campaigns  ', 'Strong copy range']);
    expect(out.dropped).toBe(3);
  });

  it('returns an empty result for an empty list and does not mutate its input', () => {
    expect(filterProtectedAttributes([])).toEqual({ kept: [], dropped: 0 });
    const input = ['Contact: jane@x.com', 'ok'];
    filterProtectedAttributes(input);
    expect(input).toEqual(['Contact: jane@x.com', 'ok']);
  });

  it('ignores anything that is not a string, and survives a non-array', () => {
    expect(filterProtectedAttributes(['ok', 5, null, undefined, {}, ['x']] as never)).toEqual({ kept: ['ok'], dropped: 0 });
    expect(filterProtectedAttributes(undefined as never)).toEqual({ kept: [], dropped: 0 });
    expect(filterProtectedAttributes('nope' as never)).toEqual({ kept: [], dropped: 0 });
  });

  it('keeps an empty or whitespace string (there is nothing in it to drop)', () => {
    expect(filterProtectedAttributes(['', '   '])).toEqual({ kept: ['', '   '], dropped: 0 });
  });

  it('a bare pronoun is not a statement about an attribute', () => {
    expect(filterProtectedAttributes(['She led five campaigns', 'He grew the page 4x', 'Her portfolio is strong'])).toEqual({
      kept: ['She led five campaigns', 'He grew the page 4x', 'Her portfolio is strong'], dropped: 0,
    });
  });

  it('findProtectedAttribute reports null for empty and non-string input', () => {
    expect(findProtectedAttribute('')).toBeNull();
    expect(findProtectedAttribute(null)).toBeNull();
    expect(findProtectedAttribute(undefined)).toBeNull();
  });

  it('an e-mail or phone number wins even inside an otherwise innocent campaign line', () => {
    expect(findProtectedAttribute('Women\'s Day campaign, contact asha@x.com')).toBe('email');
    expect(findProtectedAttribute('Diwali campaign hotline 98765 43210')).toBe('phone');
  });

  it('only the first 20,000 characters are examined', () => {
    expect(findProtectedAttribute(`${'x '.repeat(10_050)}she is married`)).toBeNull();
    expect(findProtectedAttribute(`${'x '.repeat(9_000)}she is married`)).toBe('subject-attribute');
  });

  it('stays fast on hostile input (no catastrophic backtracking)', () => {
    const hostile = [
      'a'.repeat(200_000), 'a@'.repeat(50_000), ' '.repeat(200_000) + 'x', '1 '.repeat(50_000), '1'.repeat(100_000),
      'a '.repeat(50_000) + '!', `she is ${'very '.repeat(20_000)}`, `likely ${'in '.repeat(20_000)}`, '(('.repeat(50_000),
      'aged '.repeat(20_000), 'a.'.repeat(60_000), `${'a'.repeat(60)}@`.repeat(1_000), '+'.repeat(100_000), '- '.repeat(100_000),
    ];
    const started = Date.now();
    for (const h of hostile) filterProtectedAttributes([h]);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

// ─── The adversarial review's findings [1.13]: named cases, individually ─────
// Invisible and look-alike characters are built from code points: a literal one in the source cannot be reviewed.
const cp = (n: number): string => String.fromCodePoint(n);
const ZWSP = cp(0x200b);
const SHY = cp(0x00ad);
// CPU time of this test process (each test file runs in its own process), not wall-clock: when the whole suite runs in
// parallel a wall-clock budget measures the machine's load, not the regular expressions.
const cpuMs = (fn: () => void): number => {
  const before = process.cpuUsage();
  fn();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
};

describe('filterProtectedAttributes — singular they/their, adjectives before religion, health, nationality, accent (were all kept)', () => {
  const leaks: Array<[string, string]> = [
    ['Likely in their 40s.', 'hedged-attribute'],
    ['Probably in their early thirties.', 'hedged-attribute'],
    ['They are in their forties.', 'age'],
    ['The creator, likely in their 30s, built the channel.', 'hedged-attribute'],
    ['The candidate seems to be in their twenties.', 'subject-attribute'],
    ['They appear to be a mother of two.', 'family'],
    ['Their husband appears in the credits.', 'family'],
    ['Their religion is not stated but they seem Hindu.', 'hedged-attribute'],
    ['She is a practising Muslim.', 'subject-attribute'],
    ['The founder is a devout Hindu.', 'subject-attribute'],
    ['The candidate is a practising Christian.', 'subject-attribute'],
    ['The candidate, who is a practising Hindu, led the launch.', 'subject-attribute'],
    ['The speaker is an observant Jew.', 'subject-attribute'],
    ['The applicant has a disability.', 'disability'],
    ['The candidate is disabled.', 'subject-attribute'],
    ['Candidate seems to have a health condition.', 'disability'],
    ['The founder is in a wheelchair in the video.', 'subject-attribute'],
    ['The designer uses a wheelchair.', 'disability'],
    ['The candidate is visually impaired.', 'subject-attribute'],
    ['She is autistic.', 'subject-attribute'],
    ['The candidate is British.', 'subject-attribute'],
    ['She is an NRI returning from the US.', 'subject-attribute'],
    ['The candidate is Indian-American.', 'subject-attribute'],
    ['The candidate is an immigrant.', 'subject-attribute'],
    ['He is a non-native English speaker.', 'nationality'],
    ['The speaker has a heavy South Indian accent.', 'accent'],
    ['Candidate has a foreign accent that may limit stakeholder pitches.', 'accent'],
    ['The candidate speaks with a Bihari accent.', 'accent'],
    ['Candidate: female, 34', 'subject-attribute'],
    ['Candidate: F, 29.', 'attribute-field'],
    ['Gender: M', 'attribute-field'],
    ['Candidate: she/her, 3 4 yrs', 'attribute-field'],
    ['The candidate is a 36F.', 'age'],
    ['Candidate (36F) has deep B2B experience.', 'age'],
    ['Candidate (M, 41) has led brand teams.', 'age'],
    ['M/34, strong portfolio', 'age'],
    ['The applicant is 34/F.', 'age'],
    ['Based on the name, the applicant is likely from Tamil Nadu.', 'inference-source'],
    ['Guessed from the name: female, North Indian.', 'inference-source'],
    ['The surname suggests a Bengali background.', 'hedged-attribute'],
    ['Her name indicates she is Muslim.', 'subject-attribute'],
    ['The candidate is a Gen Z woman.', 'subject-attribute'],
    ['The candidate appears to be a Gen Z woman.', 'subject-attribute'],
    ['The presenter is an older woman.', 'subject-attribute'],
    ['The candidate is a working mom.', 'subject-attribute'],
    ['The candidate is queer-identifying.', 'subject-attribute'],
    ['The candidate is an LGBTQ+ advocate.', 'subject-attribute'],
    ['She comes across as a confident woman who leads from the front.', 'subject-attribute'],
    ['Being a woman leader in a male-dominated industry, the candidate stands out.', 'subject-attribute'],
    ['It looks like the work of a young woman.', 'hedged-attribute'],
    ['The candidate recently became a father.', 'subject-attribute'],
    ['The presenter is strikingly good-looking.', 'appearance'],
    ['She is pretty and articulate.', 'appearance'],
    ['Appears overweight.', 'appearance'],
    ['He wears a turban and a beard.', 'appearance'],
    ['Employment gap, possibly maternity.', 'family'],
    ['The gap between 2018 and 2020 was likely due to marriage.', 'family'],
    ['The candidate graduated in 2004, so is probably around 40.', 'age'],
    ['He must be pushing 50.', 'age'],
    ['She was born in the late 80s.', 'age'],
    ['Candidate was born in 1985.', 'age'],
    ['The creator is thirty-something.', 'subject-attribute'],
    ['The candidate, a woman, has built three brands.', 'subject-attribute'],
    ['It is a female marketer behind these posts.', 'attribute-person'],
    ["He's a 41 year old father of two.", 'age'],
    ["She's a woman who built the brand.", 'subject-attribute'],
    ['DOB 14/03/1990.', 'age'],
    ['Birthday: 3 May 1988.', 'age'],
  ];
  it.each(leaks)('drops %j (%s)', (s, rule) => {
    expect(findProtectedAttribute(s)).toBe(rule);
    expect(filterProtectedAttributes([s])).toEqual({ kept: [], dropped: 1 });
  });
});

describe('filterProtectedAttributes — the content or the other person is the subject, not the candidate (were wrongly dropped)', () => {
  const keep = [
    // the reviewer's named hard negatives
    'Gender: 54% female, 46% male (campaign analytics, Q3).',
    'Demographics - Gender: female 61%, male 39%.',
    'Audience gender: 54% female, 46% male in the campaign analytics.',
    'Persona: Priya, a mother of two juggling work and school runs, drives the app messaging.',
    'Persona: working women in their thirties who commute daily.',
    'Maternity leave policy campaign for a fintech employer brand.',
    'Paternity leave policy explainer video for an employer-branding campaign.',
    'Marital status field redesign in the matrimony app onboarding flow.',
    'Marital status was a filter in the matrimony app the candidate redesigned.',
    'The host is a Hindu priest who narrates the temple series.',
    'The host is a Hindu priest featured in the film.',
    'The speaker is a Sikh veteran featured in the Republic Day film.',
    'The founder is a woman entrepreneur featured in the client case study.',
    'The creator is a female Instagram influencer the candidate partnered with.',
    'The influencer is a woman in her thirties the candidate managed.',
    'The influencer is a woman in her thirties with 1.2M followers; the candidate managed the partnership.',
    'Celebrity partnership: the actress is a mother of two and a brand ambassador.',
    'The author is a Dalit writer whose book the candidate promoted.',
    'The founder is a Muslim entrepreneur whose story anchors the campaign.',
    'He is a father in the TVC and his daughter is the lead.',
    'The designer is a woman the candidate hired and mentored.',
    'The candidate is young in the category: first launch of a D2C brand.',
    'The candidate is a young brand\'s first marketing hire.',
    'The candidate is a man of few words in the pitch deck; copy is terse and clear.',
    'He is a man of few words.',
    // more third parties and topics
    'The film\'s protagonist is a mother of two who walks 5 km for water.',
    'The campaign\'s hero is a 70-year-old woman who walks 3 km for water.',
    'Audience: women in their thirties, likely married, in tier-2 cities.',
    'Case study features a female plant operator who became a brand ambassador.',
    'The founder is a woman who featured in three of the campaigns.',
    'The anchor of the series is a Muslim scholar the candidate commissioned.',
    'The candidate is a mother of invention when it comes to guerrilla marketing.',
    'He is the father of the Har Ghar Jal tagline.',
    'She is married to the brand\'s mission.',
    'Accent colours are used sparingly against a navy base.',
    'The candidate is an American Express alum.',
    'The candidate is blind to platform nuances (a gap).',
    'Probably 35 campaigns across 4 years, but only 6 are shown.',
    'Likely 40 posts per month based on the feed.',
    'Reached 24M impressions across 3 platforms.',
    'Shot at f/2.8 with natural light for the hero images.',
    'Water temperature was held at 72F in the demo film.',
  ];
  it.each(keep)('keeps %j', (s) => {
    expect(findProtectedAttribute(s)).toBeNull();
    expect(filterProtectedAttributes([s])).toEqual({ kept: [s], dropped: 0 });
  });

  it('a clause that names a third party is still dropped when it makes the CANDIDATE the subject', () => {
    expect(findProtectedAttribute('The candidate is a woman who works with clients.')).toBe('subject-attribute');
    expect(findProtectedAttribute('The candidate is a mother of two; the client is a bank.')).not.toBeNull();
    expect(findProtectedAttribute('The female candidate led a campaign for a client.')).toBe('attribute-candidate');
    expect(findProtectedAttribute('Based on her name, the client contact is Muslim.')).toBe('inference-source');
    expect(findProtectedAttribute('Candidate: female. The client is a bank.')).not.toBeNull();
  });

  it('a cue in one sentence does not shield a statement in the next', () => {
    expect(findProtectedAttribute('Case study featured in the client deck. She is a woman.')).toBe('subject-attribute');
    expect(findProtectedAttribute('She is married. The influencer is a woman.')).toBe('subject-attribute');
  });

  it('a hard-wrapped statement (a line break in the middle) is still one statement', () => {
    expect(findProtectedAttribute('She is probably\nmarried')).toBe('subject-attribute');
    expect(findProtectedAttribute('The candidate is a\nMuslim woman')).toBe('subject-attribute');
  });
});

describe('filterProtectedAttributes — obfuscation, second pass', () => {
  it.each([
    ['The candidate is wom4n.', 'digit for a letter'],
    ['The candidate is a w0man.', 'zero for o'],
    ['She is m4rried.', 'digit for a letter'],
    ['The candidate is a h1ndu.', 'digit for i'],
    ['The candidate is a w-o-m-a-n.', 'hyphens between the letters after an article'],
    ['The candidate is a w.o.m.a.n.', 'dots between the letters after an article'],
    ['The candidate is a M U S L I M.', 'spaced capitals after an article'],
    ['The candidate is fe-male.', 'one stray hyphen'],
    ['The candidate is a wo man.', 'one stray space'],
    ['She is mar.ried.', 'one stray dot'],
    ['The candidate is a *woman*.', 'markdown emphasis'],
    ['The candidate is (female).', 'brackets'],
    ['The candidate is "married".', 'quotes'],
    ['She is m_a_r_r_i_e_d.', 'underscores'],
    [`The candidate is fem${ZWSP}ale.`, 'zero-width space'],
    [`She is ma${SHY}rried.`, 'soft hyphen'],
    [`The candidate is f${cp(0x435)}male.`, 'Cyrillic e'],
    [`The candidate is ${[...'female'].map(c => cp(c.charCodeAt(0) + 0xfee0)).join('')}.`, 'full-width letters'],
  ])('drops %j (%s)', (s) => {
    expect(findProtectedAttribute(s)).not.toBeNull();
  });

  it('written-out contact details', () => {
    for (const s of [
      'Reach her: jane . doe @ gmail . com',
      'Reach her: jane.doe @ gmail.com',
      'jane .doe@ gmail .com',
      'Contact: jane dot doe at gmail dot com',
      'Email: priya at the rate of gmail dot com',
      'priya (at) gmail (dot) com',
      'Phone: nine eight seven six five four three two one zero',
      'My number is nine-eight-seven-six-five-four-three-two-one-zero.',
      'Call ek do teen char paanch chhe saat aath nau shunya.',
      `Devanagari digits: ${[...'9876543210'].map(c => cp(0x966 + Number(c))).join('')}`,
      `Arabic-Indic digits ${[...'9876543210'].map(c => cp(0x660 + Number(c))).join('')}`,
    ]) expect(['email', 'phone'], s).toContain(findProtectedAttribute(s));
  });

  it('numbers and handles that are not contact details stay', () => {
    for (const s of [
      'Follow @ digitalpaani. Great work',
      'Your @digitalpaani.com account is not registered in HMS.',
      'Join us @ studio.in this week',
      'Handle @ digitalpaani on Instagram',
      'Revenue grew to 1,20,00,000 in FY2023',
      'Eight steps in the onboarding flow',
      'Leads: 2019, 2020, 2021 and 2022',
    ]) expect(findProtectedAttribute(s), s).toBeNull();
  });
});

describe('filterProtectedAttributes — Hindi and Hinglish', () => {
  it.each([
    'Candidate ek mahila hai aur shaadi-shuda lagti hain.',
    'Is ladki ki umar 25 saal hai.',
    'Woh Muslim hai aur uski family badi hai.',
    'Candidate Hindu hai.',
    'Candidate Punjabi lagta hai.',
    'Candidate ek aurat hai, 30 saal ki.',
    'Woh ek ladka hai.',
    'Uski patni ek teacher hai.',
    'उम्मीदवार एक महिला है।',
    'वह शादीशुदा है और दो बच्चों की मां है।',
    'उसकी उम्र 35 साल है।',
    'यह उम्मीदवार हिंदू है।',
    `उसकी उम्र ${[...'35'].map(c => cp(0x966 + Number(c))).join('')} साल है।`,
  ])('drops %j', (s) => {
    expect(findProtectedAttribute(s)).toBe('hindi');
  });

  it.each([
    'Mahila Samman Bachat Patra campaign for post offices.',
    'महिला दिवस अभियान 2024',
    'Beti Bachao Beti Padhao social series for a bank.',
    'Shaadi.com style matrimony app redesign.',
    'हर बूंद कीमती है अभियान 2024',
    'Hindi-language and Marathi-language ad variants.',
  ])('keeps %j', (s) => {
    expect(findProtectedAttribute(s)).toBeNull();
  });
});

describe('filterProtectedAttributes — a letter next to an age is read on the case-preserved text', () => {
  it('24M users, f/2.8 and 72F are not people', () => {
    for (const s of ['Reached 24M users in a year', 'Shot at f/2.8', 'Held at 72F', 'A 36 month plan, 12F models', 'Series A: 24M raised']) {
      expect(findProtectedAttribute(s), s).toBeNull();
    }
  });
  it('(36F), (41 M), F/29 and 34/M are', () => {
    for (const s of ['Candidate (36F) strong', 'Candidate (41 M) strong', 'F/29 with a deep portfolio', '34/M, B2B background']) {
      expect(findProtectedAttribute(s), s).toBe('age');
    }
  });
});

// ─── The reviewer's corpus: aggregate thresholds ─────────────────────────────
// 207 strings that state or infer an attribute of the candidate (leaks) and 210 that are about the work, the audience or
// someone else in it (topics). The first version of the filter caught 74% of the leaks and dropped 18 of the 72 hard topics.
function score(leaks: string[], topics: string[]) {
  const missed = leaks.filter(s => findProtectedAttribute(s) === null);
  const wronglyDropped = topics.filter(s => findProtectedAttribute(s) !== null);
  const caught = leaks.length - missed.length;
  return {
    missed, wronglyDropped,
    recall: caught / leaks.length,
    precision: caught / (caught + wronglyDropped.length),
  };
}

describe('filterProtectedAttributes — recall and precision on the review corpora', () => {
  it('the reviewer\'s corpus: recall >= 92% and precision of drops >= 96%', () => {
    const r = score(REVIEW_LEAKS, REVIEW_TOPICS);
    expect(r.recall, `missed: ${r.missed.join(' | ')}`).toBeGreaterThanOrEqual(0.92);
    expect(r.precision, `wrongly dropped: ${r.wronglyDropped.join(' | ')}`).toBeGreaterThanOrEqual(0.96);
  });

  it('a second corpus written after the first one passed: recall >= 92%, precision >= 96%', () => {
    const r = score(SECOND_LEAKS, SECOND_TOPICS);
    expect(r.recall, `missed: ${r.missed.join(' | ')}`).toBeGreaterThanOrEqual(0.92);
    expect(r.precision, `wrongly dropped: ${r.wronglyDropped.join(' | ')}`).toBeGreaterThanOrEqual(0.96);
  });

  it('a third corpus, measured before any rule was changed for it: recall >= 92%, precision >= 96%', () => {
    const r = score(THIRD_LEAKS, THIRD_TOPICS);
    expect(r.recall, `missed: ${r.missed.join(' | ')}`).toBeGreaterThanOrEqual(0.92);
    expect(r.precision, `wrongly dropped: ${r.wronglyDropped.join(' | ')}`).toBeGreaterThanOrEqual(0.96);
  });

  it('every leak in every category is caught (so a regression names the string)', () => {
    for (const [name, leaks] of [['review', REVIEW_LEAKS], ['second', SECOND_LEAKS], ['third', THIRD_LEAKS]] as const) {
      const missed = leaks.filter(s => findProtectedAttribute(s) === null);
      expect(missed, `${name} corpus, missed`).toEqual([]);
    }
  });

  it('no topic in any corpus is dropped', () => {
    for (const [name, topics] of [['review', REVIEW_TOPICS], ['second', SECOND_TOPICS], ['third', THIRD_TOPICS]] as const) {
      const dropped = topics.filter(s => findProtectedAttribute(s) !== null);
      expect(dropped, `${name} corpus, wrongly dropped`).toEqual([]);
    }
  });
});

describe('filterProtectedAttributes — performance on 20,000-character adversarial input', () => {
  const N = 20_000;
  const shapes: Array<[string, string]> = [
    ['one letter', 'a'.repeat(N)], ['e-mail starts', 'a@'.repeat(N / 2)], ['spaces', `${' '.repeat(N - 1)}x`], ['digits and spaces', '1 '.repeat(N / 2)],
    ['digits', '1'.repeat(N)], ['words then !', `${'a '.repeat(N / 2)}!`], ['she is very', `she is ${'very '.repeat(N / 5)}`], ['likely in', `likely ${'in '.repeat(N / 3)}`],
    ['parentheses', '(('.repeat(N / 2)], ['aged', 'aged '.repeat(N / 5)], ['dots', 'a.'.repeat(N / 2)], ['long local parts', `${'a'.repeat(60)}@`.repeat(N / 61)],
    ['plus', '+'.repeat(N)], ['dashes', '- '.repeat(N / 2)], ['young', `the candidate is a ${'young '.repeat(N / 6)}`], ['woman repeated', 'she is a woman '.repeat(N / 15)],
    ['single letters', 'a b c d e f g h '.repeat(N / 16)], ['spaced word', 'f e m a l e '.repeat(N / 12)], ['digits in words', 'a1b2c3d4e5 '.repeat(N / 11)],
    ['digit words', 'one two three four five six seven eight nine '.repeat(N / 46)], ['sentences', 'The candidate led campaigns. '.repeat(N / 29)],
    ['hedges', 'probably likely perhaps maybe apparently '.repeat(N / 41)], ['born in', 'born in the '.repeat(N / 12)], ['marital status', 'marital status '.repeat(N / 15)],
    ['at dot', 'jane at x dot '.repeat(N / 14)], ['spaced e-mail', 'x @ y . '.repeat(N / 8)], ['Devanagari', 'महिला है '.repeat(N / 9)], ['commas', ','.repeat(N)],
    ['markdown', '*_'.repeat(N / 2)], ['newlines', 'a\n'.repeat(N / 2)], ['quotes', '"a" '.repeat(N / 4)],
  ];
  it('every shape is handled in under 100 ms', () => {
    findProtectedAttribute('warm up the regex engine she is a woman');
    const slow: string[] = [];
    for (const [name, text] of shapes) {
      const ms = cpuMs(() => { findProtectedAttribute(text); });
      if (ms >= 100) slow.push(`${name}: ${Math.round(ms)} ms of CPU`);
    }
    expect(slow).toEqual([]);
  });
});

// ─── redactPersonalStatements ────────────────────────────────────────────────
describe('redactPersonalStatements', () => {
  it('removes the sentences that state an attribute, years of experience or a contact detail, and keeps the rest and every URL', () => {
    const answer = 'I am Priya Sharma, 38, a mum of two with 12 years of experience in marketing. My work: https://priyasharma.design/work and '
      + 'https://www.linkedin.com/in/priya-sharma-1a2b3c. Reach me at priya@gmail.com.';
    expect(redactPersonalStatements(answer)).toEqual({
      text: 'My work: https://priyasharma.design/work and https://www.linkedin.com/in/priya-sharma-1a2b3c.',
      removed: 2,
    });
  });

  it('years of experience: only the statement forms, and the NUMBER is replaced in place (the sentence stays)', () => {
    for (const [s, out] of [
      ['12 years of experience in marketing.', '[years] of experience in marketing.'], ['I have 10+ yrs in marketing.', 'I have [years] in marketing.'],
      ['Over 15 years of experience building brands.', '[years] of experience building brands.'], ['With 8 years\' experience.', 'With [years]\' experience.'],
      ['Experience: 12 years.', 'Experience: [years].'], ['YOE 9.', 'YOE [years].'], ['Twelve years of experience across B2B.', '[years] of experience across B2B.'],
      ['8 years as a marketer.', '[years] as a marketer.'], ['15 years building brands for startups.', '[years] building brands for startups.'],
      ['A decade of experience in brand and growth.', '[years] of experience in brand and growth.'], ['A 15-year career in marketing.', 'A [years] career in marketing.'],
      ['Total experience of 12 yrs.', 'Total experience of [years].'], ['Career spanning 14 years.', 'Career spanning [years].'],
    ] as const) expect(redactPersonalStatements(s), s).toEqual({ text: out, removed: 1 });
    for (const s of [
      'Ran a 3-year campaign for a utility.', 'Over 5 years of campaigns are documented.', 'The brand is 10 years old.', 'A 10-year-old company.', 'The campaign ran for 4 years and reached 3M people.',
      'A 3-year content roadmap was presented.', 'Reach grew 3x in 2 years.', 'Humne 5 saal ka brand roadmap banaya.', 'Tata Steel\'s 100 years of heritage anchor the film.',
      'In the last 5 years revenue grew 4x.', 'The first campaign was 2 years ago.',
    ]) expect(redactPersonalStatements(s), s).toEqual({ text: s, removed: 0 });
  });

  it('keeps campaign text untouched, character for character, including line breaks and spacing', () => {
    const text = 'Built the brand from zero.\n\nWomen\'s Day campaign reached 2M.  Gender-equality series for rural schools;\n  senior-citizen outreach (40+ markets).\n';
    expect(redactPersonalStatements(text)).toEqual({ text, removed: 0 });
  });

  it('keeps line structure when a whole line goes', () => {
    expect(redactPersonalStatements('Led 5 campaigns.\nI am a 38 year old woman.\nWon an award.')).toEqual({ text: 'Led 5 campaigns.\n\nWon an award.', removed: 1 });
  });

  it('judges URLs on their own: a URL never costs the sentence around it, and a URL with a phone number goes alone', () => {
    expect(redactPersonalStatements('See https://x.design/p?id=98765 for the Women\'s Day campaign.')).toEqual({
      text: 'See https://x.design/p?id=98765 for the Women\'s Day campaign.', removed: 0,
    });
    // ten digits in a row inside a URL cannot be told from a phone number, so that URL goes, and only that URL
    expect(redactPersonalStatements('See https://x.design/p?id=9876543210 for the Women\'s Day campaign.')).toEqual({
      text: 'See for the Women\'s Day campaign.', removed: 1,
    });
    expect(redactPersonalStatements('Chat on https://wa.me/919876543210 about the Women\'s Day campaign.')).toEqual({
      text: 'Chat on about the Women\'s Day campaign.', removed: 1,
    });
    expect(redactPersonalStatements('She is married. https://x.design/work Strong copy.')).toEqual({ text: 'https://x.design/work Strong copy.', removed: 1 });
  });

  it('removes a long run-on text in windows, so nothing past the scan limit escapes', () => {
    const filler = 'we shipped the launch film and the social cut together '.repeat(500);   // ~27,000 characters, no sentence end
    const out = redactPersonalStatements(`${filler} she is a woman`);
    expect(out.removed).toBe(1);
    // only the windows that state it go: the statement is gone, the long text around it is kept
    expect(out.text).not.toMatch(/she is a woman/);
    expect(out.text.length).toBeGreaterThan(26_000);
  });

  it('does not leave the first, middle or last sentence behind with a stray space', () => {
    expect(redactPersonalStatements('She is married. Led 5 campaigns.').text).toBe('Led 5 campaigns.');
    expect(redactPersonalStatements('Led 5 campaigns. She is married. Won an award.').text).toBe('Led 5 campaigns. Won an award.');
    expect(redactPersonalStatements('Led 5 campaigns. She is married.').text).toBe('Led 5 campaigns.');
  });

  it('handles empty and non-string input', () => {
    expect(redactPersonalStatements('')).toEqual({ text: '', removed: 0 });
    expect(redactPersonalStatements(undefined as never)).toEqual({ text: '', removed: 0 });
    expect(redactPersonalStatements(null as never)).toEqual({ text: '', removed: 0 });
    expect(redactPersonalStatements('   ')).toEqual({ text: '   ', removed: 0 });
  });

  it('counts every removed sentence', () => {
    const out = redactPersonalStatements('A 40 year old woman. 10 years of experience. Call 98765 43210. Led 5 campaigns. Likely in their 40s.');
    expect(out).toEqual({ text: '[years] of experience. Led 5 campaigns.', removed: 4 });
  });

  it('is fast on a 60,000-character text of ordinary sentences and of hostile ones', () => {
    const ms = cpuMs(() => {
      redactPersonalStatements('The candidate led campaigns for water utilities. '.repeat(1_250));
      redactPersonalStatements('a\n'.repeat(30_000));
      redactPersonalStatements('. '.repeat(30_000));
    });
    expect(ms).toBeLessThan(1_500);
  });
});

// ─── Redaction at the smallest piece (second review, findings 1, 7 and 8) ──────
describe('redactPersonalStatements — only the phrase that states something goes, never the sentence or the text around it', () => {
  const out = (t: string) => redactPersonalStatements(t).text;

  it('a years-of-experience phrase becomes "[years]" in place: the campaign list around it survives whole', () => {
    expect(out('Brand campaigns I led during my 15 years in advertising: (1) Clean Ganga outreach, 3M reach (2) Swachh Schools. Drive: https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view'))
      .toBe('Brand campaigns I led during my [years] in advertising: (1) Clean Ganga outreach, 3M reach (2) Swachh Schools. Drive: https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view');
    expect(out('I have worked in marketing for 8 years, mostly in B2B SaaS where I led a team of 4 designers, and I built the brand of two startups from scratch. Links: https://x.example.com'))
      .toBe('I have worked in marketing for [years], mostly in B2B SaaS where I led a team of 4 designers, and I built the brand of two startups from scratch. Links: https://x.example.com');
  });

  it('every common phrasing of years of experience is covered, and a duration about the WORK is not', () => {
    for (const [s, o] of [
      ['Over my 12 years at Zomato I built the brand voice from scratch and launched 30 campaigns', 'Over my [years] at Zomato I built the brand voice from scratch and launched 30 campaigns'],
      ['My 12 years at Zomato, Swiggy and Ola taught me to build brands.', 'My [years] at Zomato, Swiggy and Ola taught me to build brands.'],
      ['I have 12 years of work across D2C and B2B.', 'I have [years] of work across D2C and B2B.'],
      ['10+ years experience. Launched Water Wise.', '[years] experience. Launched Water Wise.'],
      ['Marketer, 11 yrs. Based in Mumbai.', 'Marketer, [years]. Based in Mumbai.'],
      ['Working in marketing since 2012, mostly B2B.', 'Working in marketing [years], mostly B2B.'],
      ['Over a decade in brand and growth.', '[years] in brand and growth.'],
      ['10 saal ka experience hai brand marketing mein.', '[years] ka experience hai brand marketing mein.'],
      ['Main 10 saal se marketing mein hoon.', 'Main [years] se marketing mein hoon.'],
      ['12 years at Zomato, 5 at Swiggy.', '[years] at Zomato, 5 at Swiggy.'], ['Brand lead | 7 years with Tata | Pune', 'Brand lead | [years] with Tata | Pune'],
    ] as const) expect(out(s), s).toBe(o);
    for (const s of ['I ran a 3-year campaign for Tata Power that reached 5 crore people.', 'We grew the page 4x in 2 years.', 'I launched it 3 years ago.', 'The campaign ran for 5 years.', '3 years in the making: the film.', '5 years of campaigns are documented.']) {
      expect(out(s), s).toBe(s);
    }
    // the one trade-off: after "I have" a number of years is read as the writer's own, even when it is about data; the cost is one number
    expect(out('I have 5 years of campaign data to show.')).toBe('I have [years] of campaign data to show.');
  });

  it('an attribute statement goes at its own clause: what the sentence says about the WORK stays', () => {
    expect(out('As a working mother of two, I built the brand voice for a utility and led 5 campaigns.')).toBe('I built the brand voice for a utility and led 5 campaigns.');
    expect(out('I am a widow, and I scaled the D2C label to 5 crore in two years.')).toBe('I scaled the D2C label to 5 crore in two years.');
    expect(out('My husband and I started the studio. We have shipped 40 films for utilities.')).toBe('I started the studio. We have shipped 40 films for utilities.');
    expect(out('Hi, I am a 36 year old strategist from Pune. My portfolio: https://example.design/work')).toBe('Hi. My portfolio: https://example.design/work');
  });

  it('a bio is cut at its bullets, pipes and dots: "Mom of 2 | she/her" goes, "Marketer" and the city stay (a city is not personal data here)', () => {
    expect(out('Priya Sharma (@priya.sharma.creates) • Mom of 2 • Marketer • She/her • Mumbai')).toBe('Priya Sharma (@priya.sharma.creates) • Marketer • Mumbai');
    expect(out('Priya | 38 | Mom of 2 | Brand strategist | Pune')).toBe('Priya | Brand strategist | Pune');   // the bare age goes with the statement beside it
    expect(out('Brand designer, Mumbai, India')).toBe('Brand designer, Mumbai, India');
    expect(out('Based in Mumbai. NID alumnus. Brand lead.')).toBe('Based in Mumbai. NID alumnus. Brand lead.');
    expect(out('35 | F | Mumbai | Marketer')).toBe('');
  });

  it('a bracketed statement goes alone, a list "mother, wife and marketer" goes whole, and an age in apposition to a name goes with the statement beside it', () => {
    expect(out('Priya (38, mother of two) led the Jal Diwas relaunch.')).toBe('Priya led the Jal Diwas relaunch.');
    expect(out("I'm a mother, wife and marketer.")).toBe('');
    expect(out('I am Priya Sharma, 38, a mum of two with 12 years of experience in marketing. My work: https://x.design/w')).toBe('My work: https://x.design/w');
    expect(out('I am Priya Sharma, 38. My work is below.')).toBe('My work is below.');
  });

  it('a URL inside a piece that goes is kept; a URL that itself carries a phone number or an address is dropped alone', () => {
    expect(out('Mom of 2: https://x.design/w')).toBe('https://x.design/w');
    expect(out('My husband and I run it: https://x.design/w')).toBe('I run it: https://x.design/w');
    expect(out('Chat on https://wa.me/919876543210 about the Women\'s Day campaign.')).toBe('Chat on about the Women\'s Day campaign.');
  });

  it('an unpunctuated run is cut in windows: the statement goes, the long text around it stays', () => {
    const filler = 'we shipped the launch film and the social cut together '.repeat(40);
    const r = redactPersonalStatements(`${filler}and she is a woman ${filler}`);
    expect(r.text).not.toMatch(/she is a woman/);
    expect(r.text.length).toBeGreaterThan(filler.length * 2 - 600);
  });

  it('keeps the terminator of a sentence whose last piece went, and never leaves a dangling conjunction', () => {
    expect(out('I led the relaunch, and I am a mother of two.')).toBe('I led the relaunch.');
    expect(out('I am a mother of two, and I led the relaunch.')).toBe('I led the relaunch.');
  });

  it('counts one edit for a statement however many pieces it took, one for each years phrase and one for each contact URL', () => {
    expect(redactPersonalStatements('I am Priya Sharma, 38, a mum of two with 12 years of experience in marketing.').removed).toBeGreaterThanOrEqual(1);
    expect(redactPersonalStatements('I have 12 years of experience. I worked for 9 years in marketing.').removed).toBe(2);
    expect(redactPersonalStatements('Led 5 campaigns for a utility.').removed).toBe(0);
  });

  it('replaceYearsOfExperience works on its own and leaves a clean text alone', () => {
    expect(replaceYearsOfExperience('I have 12 years of experience.')).toEqual({ text: 'I have [years] of experience.', count: 1 });
    expect(replaceYearsOfExperience('Women\'s Day campaign, 3-year plan.')).toEqual({ text: 'Women\'s Day campaign, 3-year plan.', count: 0 });
  });
});

describe('first-person statements and the Hinglish age rule (second review)', () => {
  it('first-person statements of age, family, religion, gender and health are statements about the person', () => {
    for (const s of [
      "I'm 38.", 'I am a Hindu.', 'I am married.', 'My husband runs the agency with me.', 'My kids inspire my work.', "I'm a mother.", 'I am a woman.', 'I identify as queer.',
      "I'm 29 years old.", 'I am in my 40s.', 'I am pregnant and returning from a career break.', 'I recently got married.', 'I am a single mom.', 'I am a person with a disability.',
      'I am hearing impaired.', 'As a Muslim woman in this industry I have learned to speak up.', 'Being a single father taught me scrappy execution.', 'I am 52 and still hungry to build.',
      'I am a gay man and queer storytelling is core to my work.', 'I am a differently-abled marketer.', 'I have two daughters and a full-time job.', 'I was born in 1985.',
    ]) expect(findProtectedAttribute(s), s).not.toBeNull();
  });
  it('first-person sentences about the work, the role or the place are kept', () => {
    for (const s of [
      'I am a brand strategist with a design background.', "I'm passionate about water and sanitation storytelling.", 'I am based in Bengaluru and work with remote teams.', 'I was a copywriter at an agency before moving in-house.',
      "I'm a big believer in single-minded messaging.", 'I am a man of few words but strong visuals.', 'My partner agencies delivered the video content.', 'My team of 4 designers shipped 120 assets a month.',
      'I led the Gen Z launch for a youth fashion brand.', 'I grew up loving ads, and now I make them for B2B brands.',
    ]) expect(findProtectedAttribute(s), s).toBeNull();
  });
  it('Hinglish: an age needs a person next to it; "5 saal ka brand roadmap" and "25 se 34 saal ke log" are durations and audiences, not ages', () => {
    for (const s of ['Humne 5 saal ka brand roadmap banaya.', 'Campaign ka target audience 25 se 34 saal ke log the.', 'Is project mein humne 4 designers ki team lead ki.']) expect(findProtectedAttribute(s), s).toBeNull();
    for (const s of ['Main 29 saal ka ladka hoon.', 'Main ek 34 saal ki mahila hoon.', 'Meri umar 38 saal hai.', 'Unki umar lagbhag 40 saal hai.', 'Main ek single mom hoon aur 10 saal se marketing mein hoon.', 'Main Hindu Brahmin parivar se hoon.', 'Main pregnant thi isliye career break liya.', 'Main apne pati aur do bachchon ke saath rehti hoon.', 'Candidate shaadi ke baad Mumbai shift hui.']) {
      expect(findProtectedAttribute(s), s).not.toBeNull();
    }
  });
  it('reviewer-style wordings that the first round missed: expecting her first child, openly gay, Tamil Brahmin, Nigerian-born, her second baby, the candidate\'s wife, a stutter', () => {
    for (const s of [
      "She's expecting her first child, according to the caption.", 'The creator is an openly gay man who advocates for LGBTQ rights.', 'The candidate is a Tamil Brahmin from Chennai.', 'The candidate is Nigerian-born and moved to India in 2015.',
      'She took two years off after her second baby.', "Candidate's wife manages the studio's finances.", 'The candidate has a stutter noticeable in the video.', 'The candidate looks tired and unwell in the video.',
      'He is the father of a newborn.', 'The portfolio owner is pregnant, per the Instagram story.', 'Married to a data scientist.', 'Married, two kids.', 'Recently divorced.', 'Engaged to a doctor.',
    ]) expect(findProtectedAttribute(s), s).not.toBeNull();
    for (const s of ['Married to the brand: a rebrand story.', 'Engaged with Tata Power on the relaunch.', 'Engaged users grew 3x.', 'The brand is married to its heritage.']) expect(findProtectedAttribute(s), s).toBeNull();
  });
});

describe('the new first-person and reviewer-style rules stay linear on hostile input', () => {
  const N = 20_000;
  it('every shape is handled in under 100 ms', () => {
    findProtectedAttribute('warm up the regex engine she is a woman');
    const shapes: Array<[string, string]> = [
      ['as a x', 'as a '.repeat(N / 5)], ['as a muslim woman', 'as a muslim woman '.repeat(N / 18)], ['being a single', 'being a single '.repeat(N / 15)], ['i am', 'i am '.repeat(N / 5)],
      ['i am a very woman', `i am a ${'very '.repeat(N / 5)}woman`], ['my', 'my '.repeat(N / 3)], ['main ek hoon', `${'main ek '.repeat(N / 8)}hoon`], ["candidate's", "candidate's ".repeat(N / 12)],
      ['pregnant', 'pregnant '.repeat(N / 9)], ['expecting', 'she is expecting '.repeat(N / 17)], ['father of', 'father of a '.repeat(N / 12)], ['pipes', '35 | f | '.repeat(N / 9)],
    ];
    const slow: string[] = [];
    for (const [name, text] of shapes) { const ms = cpuMs(() => { findProtectedAttribute(text); }); if (ms >= 100) slow.push(`${name}: ${Math.round(ms)} ms`); }
    expect(slow).toEqual([]);
  });
  it('redaction of hostile text (commas, bullets, brackets, years, repeated statements) is fast too', () => {
    const shapes = [
      `she is a woman, ${'a, '.repeat(N / 3)}`, `she is a woman, ${'one two three four five, '.repeat(N / 25)}`, `she is a woman | ${'one | '.repeat(N / 6)}`, `she is a woman (${'(x) '.repeat(N / 4)}`,
      'I have 12 years of experience. '.repeat(N / 31), '12 years '.repeat(N / 9), 'She is married. '.repeat(N / 16), `${'38, '.repeat(N / 4)}mother of two`, `${'we shipped the launch film '.repeat(N / 27)}and she is a woman`,
    ];
    const slow: string[] = [];
    shapes.forEach((text, i) => { const ms = cpuMs(() => { redactPersonalStatements(text); }); if (ms >= 300) slow.push(`shape ${i}: ${Math.round(ms)} ms`); });
    expect(slow).toEqual([]);
  });
});

// ─── The candidate's name ────────────────────────────────────────────────────
describe('nameTokens', () => {
  it('lowercased tokens of at least 3 letters, in order, without repeats', () => {
    expect(nameTokens('Priya Sharma')).toEqual(['priya', 'sharma']);
    expect(nameTokens('PRIYA  SHARMA sharma')).toEqual(['priya', 'sharma']);
    expect(nameTokens('Anil Kumar Singh')).toEqual(['anil', 'kumar', 'singh']);
  });
  it('drops honorifics, particles and initials but keeps surnames such as Kumar and Kumari', () => {
    expect(nameTokens('Dr. Priya Sharma')).toEqual(['priya', 'sharma']);
    expect(nameTokens('Mrs Anita Rao')).toEqual(['anita', 'rao']);
    expect(nameTokens('Prof. Shri Rahul Kumar')).toEqual(['rahul', 'kumar']);
    expect(nameTokens('Smt. Sunita Kumari')).toEqual(['sunita', 'kumari']);
    expect(nameTokens('A. B. Singh')).toEqual(['singh']);
    expect(nameTokens('Ludwig van Beethoven')).toEqual(['ludwig', 'beethoven']);
    expect(nameTokens('Abdul bin Salman')).toEqual(['abdul', 'salman']);
  });
  it('splits on any non-letter and handles unicode names', () => {
    expect(nameTokens('Anne-Marie O\'Brien')).toEqual(['anne', 'marie', 'brien']);
    expect(nameTokens('José Álvarez-García')).toEqual(['josé', 'álvarez', 'garcía']);
    expect(nameTokens('प्रिया शर्मा')).toEqual(['प्रिया', 'शर्मा']);
    expect(nameTokens('Zoë Ørsted')).toEqual(['zoë', 'ørsted']);
  });
  it('ignores tokens shorter than 3 letters and empty or non-string input', () => {
    expect(nameTokens('Li Wu')).toEqual([]);
    expect(nameTokens('Raj Li')).toEqual(['raj']);
    expect(nameTokens('')).toEqual([]);
    expect(nameTokens(undefined as never)).toEqual([]);
    expect(nameTokens(42 as never)).toEqual([]);
  });
});

describe('maskNameTokens', () => {
  const N = 'Priya Sharma';
  it('replaces every token occurrence, any case, word-bounded', () => {
    expect(maskNameTokens('Priya Sharma led the brand. SHARMA and priya agree.', N)).toBe('[candidate] [candidate] led the brand. [candidate] and [candidate] agree.');
    expect(maskNameTokens('Priya\'s work and Sharma-led teams', N)).toBe('[candidate]\'s work and [candidate]-led teams');
  });
  it('masks the name inside URL slugs, hostnames, e-mail addresses and handles', () => {
    expect(maskNameTokens('https://priyasharma.design/work', N)).toBe('https://[candidate][candidate].design/work');
    expect(maskNameTokens('linkedin.com/in/priya-sharma-1a2b3c', N)).toBe('linkedin.com/in/[candidate]-[candidate]-1a2b3c');
    expect(maskNameTokens('instagram.com/priya.sharma.creates', N)).toBe('instagram.com/[candidate].[candidate].creates');
    // the initial and the family name written as one word are one name: the initial goes with it (it used to be left in front: "p[candidate]")
    expect(maskNameTokens('https://www.behance.net/psharma', N)).toBe('https://www.behance.net/[candidate]');
    expect(maskNameTokens('@priyasharma_designs on Instagram', N)).toBe('@[candidate][candidate]_designs on Instagram');
    expect(maskNameTokens('sharma.priya@agency.in', N)).toBe('[candidate].[candidate]@agency.in');
    expect(maskNameTokens('https://medium.com/@priya.sharma1982', N)).toBe('https://medium.com/@[candidate].[candidate]1982');
  });
  it('leaves everything else exactly as it was', () => {
    const t = 'Women\'s Day campaign reached 2.4M impressions; Gender-equality series, 3 years, https://example.com/work?id=12.';
    expect(maskNameTokens(t, N)).toBe(t);
    expect(maskNameTokens('', N)).toBe('');
    expect(maskNameTokens('Priya Sharma', '')).toBe('Priya Sharma');
    expect(maskNameTokens('Priya Sharma', 'Li Wu')).toBe('Priya Sharma');
    expect(maskNameTokens(undefined as never, N)).toBe('');
  });
  it('a 4-letter token is only masked where it starts a run of letters inside a URL, and a short word is never cut out of a longer one', () => {
    expect(maskNameTokens('https://prose.design/Rose and a Rose garden', 'Rose Menon')).toBe('https://prose.design/[candidate] and a [candidate] garden');
    expect(maskNameTokens('Roses and prose', 'Rose Menon')).toBe('Roses and prose');
    expect(maskNameTokens('https://rosemenon.in', 'Rose Menon')).toBe('https://[candidate][candidate].in');
  });
  it('a name that is also a common word is masked when it is capitalised and stands alone; "rose water" and "a hunter-gatherer brand" are left as they are', () => {
    expect(maskNameTokens('Hunter led the Hunter campaign; a hunter-gatherer brand; hunters', 'Hunter Biden')).toBe('[candidate] led the [candidate] campaign; a hunter-gatherer brand; hunters');
    expect(maskNameTokens('Rose Garden by Rose', 'Rose Iyer')).toBe('[candidate] Garden by [candidate]');
    expect(maskNameTokens('Rose-coloured visuals, rose water, prose.design and Hunter Douglas', 'Rose Hunter')).toBe('[candidate]-coloured visuals, rose water, prose.design and [candidate] Douglas');
    // typed in lower case but next to another token of the name, it is still the name
    expect(maskNameTokens('rose hunter, brand lead; rose water', 'Rose Hunter')).toBe('[candidate] [candidate], brand lead; rose water');
    expect(maskNameTokens('https://rosehunter.design/work', 'Rose Hunter')).toBe('https://[candidate][candidate].design/work');
  });
  it('matches accents, case and look-alike characters, and cuts the ORIGINAL text', () => {
    expect(maskNameTokens('JOSÉ Álvarez-García wrote this. jose.alvarez@x.com', 'José Álvarez-García')).toBe('[candidate] [candidate]-[candidate] wrote this. [candidate].[candidate]@x.com');
    expect(maskNameTokens(`Jos${cp(0x65)}${cp(0x301)} spoke`, 'José Álvarez')).toBe('[candidate] spoke');
    expect(maskNameTokens(`Pr${cp(0x456)}ya Sharma and Pri${ZWSP}ya`, N)).toBe('[candidate] [candidate] and [candidate]');
    expect(maskNameTokens('यह प्रिया शर्मा का काम है।', 'प्रिया शर्मा')).toBe('यह [candidate] [candidate] का काम है।');
  });
  it('is fast on a large text', () => {
    const ms = cpuMs(() => {
      maskNameTokens('priya sharma https://priyasharma.design/x '.repeat(3_000), N);
      maskNameTokens('é'.repeat(60_000), 'José Álvarez');
    });
    expect(ms).toBeLessThan(1_500);
  });
});

describe('nameAppears (the plain boolean: the FULL name matches)', () => {
  const N = 'Priya Sharma';
  it('is true when given name and family name are together, in either order, with an initial, or glued in a slug', () => {
    expect(nameAppears('Designed by Priya Sharma.', N)).toBe(true);
    expect(nameAppears('Sharma Priya, brand lead', N)).toBe(true);    // either order
    expect(nameAppears('Sharma, Priya', N)).toBe(false);              // a comma between the two words: not one name
    expect(nameAppears('Priya M. Sharma led it', N)).toBe(true);
    expect(nameAppears('Credit: P. Sharma', N)).toBe(true);
    expect(nameAppears('https://priyasharma.design', N)).toBe(true);
    expect(nameAppears('linkedin.com/in/priya-sharma-1a2b3c', N)).toBe(true);
    expect(nameAppears('instagram.com/priya.sharma.creates', N)).toBe(true);
    expect(nameAppears('psharma@agency.in', N)).toBe(true);
    expect(nameAppears('by JOSE ALVAREZ', 'José Álvarez')).toBe(true);
    expect(nameAppears('jose.alvarez@x.com', 'José Álvarez')).toBe(true);
  });
  it('is false for one shared token (a surname or a first name decides nothing), for a look-alike, and for no name at all', () => {
    expect(nameAppears('Sharma led the brand', N)).toBe(false);
    expect(nameAppears('PRIYA', N)).toBe(false);
    expect(nameAppears('Designed by Priya.', N)).toBe(false);
    expect(nameAppears('Amit Sharma and Priya Nair', N)).toBe(false);
    expect(nameAppears('priyanka.design', N)).toBe(false);
    expect(nameAppears('Women\'s Day campaign by an agency', N)).toBe(false);
    expect(nameAppears('', N)).toBe(false);
    expect(nameAppears('Priya Sharma', '')).toBe(false);
    expect(nameAppears(undefined as never, N)).toBe(false);
  });
  it('a one-token name matches as a whole token of 4+ letters only', () => {
    expect(nameAppears('Credits: Priyanka led it', 'Priyanka')).toBe(true);
    expect(nameAppears('Raj led it', 'Raj')).toBe(false);
  });
  it('a name that is also a common word needs the capitalised word and the other token ("rose water" is not Rose)', () => {
    expect(nameAppears('rose water and Hunter Douglas', 'Rose Hunter')).toBe(false);
    expect(nameAppears('Credits: Rose Hunter', 'Rose Hunter')).toBe(true);
  });
});

// ─── The three-state name signal ─────────────────────────────────────────────
describe('candidateNameSignal — the truth table', () => {
  const sig = (name: string, text: string, searchable = true) => candidateNameSignal(name, { text, hasSearchableText: searchable });
  const LONG = ' Brand playbook for a water utility: five campaigns, a launch film and a media plan for the festive quarter.';

  it('a lone shared surname or first name is "unknown" - it neither finds nor rules out the candidate (Singh, Kumar, Khan, Patel, Gupta, Sharma, Priya, Rose, Hunter)', () => {
    for (const [name, text] of [
      ['Neha Sharma', 'Concept and direction: Amit Sharma, Creative Director.'], ['Amar Singh', 'Photography by Harpreet Singh.'], ['Rajesh Kumar', 'Celebrity endorsement by Akshay Kumar; jingle sung by Kumar Sanu.'],
      ['Mohammed Imran Khan', 'Brand identity by Salman Khan Films.'], ['Amit Patel', 'Case study with Hiral Patel, Founder.'], ['Anita Gupta', 'Written by Rohit Gupta.'],
      ['Priya Menon', 'Concept and copy: Priya Nair. Design: Rahul Menon. Brand: Priya Gold.'], ['Rose Hunter', 'rose water brand; Hunter Douglas client; a hunter-gatherer story'],
    ] as const) expect(sig(name, text + LONG), `${name} | ${text}`).toBe('unknown');
  });

  it('the full name is "likely", fuzzily: transliterations, shortened forms, initials, Mohd / Mohammed, either order, a middle name', () => {
    for (const [name, text] of [
      ['Priya Sharma', 'Created by Priya Sharma.'], ['Priya Sharma', 'Created by Sharma Priya.'], ['Priya Sharma', 'Created by Priya Kumari Sharma.'], ['Priya Sharma', 'Created by P. Sharma.'],
      ['P. Sharma', 'Created by Priya Sharma.'], ['Shreya Ghoshal', 'Concept: Sreya Ghosal, Creative Director'], ['Sundaram Venkataraman', 'Concept: Sundar Venkat, Creative Director'],
      ['Mohd Imran Khan', 'Concept: Mohammed Imran Khan'], ['Mohd Imran Khan', 'Concept: Muhammad Imran Q'], ['Vikram Shah', 'Concept: Wikram Sah'], ['Rahul Kapoor', 'Concept: Rahool Kapoor'],
      ['Anil Kumar Singh', 'Concept: Anil K. Singh'], ['José Álvarez', 'by JOSE ALVAREZ'], ['Rose Hunter', 'Credits: Rose Hunter'],
    ] as const) expect(sig(name, text), `${name} | ${text}`).toBe('likely');
  });

  it('"likely" also for a one-token name of 4+ letters, and for the name glued in a host or a profile slug', () => {
    expect(sig('Priyanka', 'Credits: Priyanka led the film')).toBe('likely');
    expect(sig('Priya Sharma', 'portfolio at priyasharma.design')).toBe('likely');
    expect(sig('Priya Sharma', urlNameText('https://www.behance.net/priya-sharma/projects'))).toBe('likely');
    expect(sig('Priya Sharma', urlNameText('https://psharma.example/work'))).toBe('likely');
  });

  it('"unlikely" ONLY when readable text was searched, the name is Latin, and not even one token of 3+ letters is in it', () => {
    expect(sig('Priya Sharma', 'Concept and direction: Jonathan Whitfield, Creative Director.' + LONG)).toBe('unlikely');
    expect(sig('Ram Das', 'Credits: Rajesh Dasgupta, creative director of the long text' + LONG)).toBe('unlikely');
    // searched nothing: no searchable text (a scan, a bio) -> unknown, whatever is missing
    expect(sig('Priya Sharma', 'Concept and direction: Jonathan Whitfield, Creative Director.' + LONG, false)).toBe('unknown');
    expect(sig('Priya Sharma', '', true)).toBe('unlikely');   // searchable but empty is the caller's call (it passes false for an image-only file)
    // another script: never "not found"
    expect(sig('प्रिया शर्मा', 'Brand film by Priya Sharma. Priya Sharma, Brand Lead.' + LONG)).toBe('unknown');
    // nothing to search for
    expect(sig('Li Ng', 'Credits: Someone Else' + LONG)).toBe('unknown');
    expect(sig('', 'text' + LONG)).toBe('unknown');
    expect(sig(undefined as never, 'text' + LONG)).toBe('unknown');
  });

  it('three-letter tokens only match exactly; a short single-token name is never "likely"', () => {
    expect(sig('Ram Das', 'Credits: Ram Das, creative director')).toBe('likely');
    expect(sig('Ram Das', 'Credits: Rama Dasa, creative director' + LONG)).toBe('likely');    // the usual trailing -a variants read as the same name
    expect(sig('Ram Das', 'Credits: Ravi Dass, creative director' + LONG)).toBe('unknown');   // one token only (Das)
    expect(sig('Raj', 'Credits: Raj, creative director' + LONG)).toBe('unknown');
  });

  it('a name does not run across a comma, a full stop or a colon: tokens of two different people are not one name', () => {
    expect(sig('Priya Menon', 'Design: Rahul Menon, Priya Gold' + LONG)).toBe('unknown');
    expect(sig('Priya Menon', 'Priya Nair. Menon & Co' + LONG)).toBe('unknown');
  });

  it('what is searched is up to the caller: the query string and the fragment of a web address never are (urlNameText)', () => {
    expect(urlNameText('https://agency.example/work/case?by=Priya+Sharma#priya-sharma')).toBe('agency.example');
    expect(urlNameText('https://www.behance.net/priya-sharma/projects?x=1#y')).toBe('behance.net priya-sharma projects');
    expect(urlNameText('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing')).toBe('drive.google.com');
    expect(urlNameText('priyasharma.design/work')).toBe('priyasharma.design');
    expect(urlNameText('not a url at all :::')).toBe('');
    expect(urlNameText('')).toBe('');
    expect(sig('Priya Sharma', urlNameText('https://agency.example/work/case?by=Priya+Sharma') + LONG)).toBe('unlikely');
  });
});

describe('maskNameTokens — other people\'s credit lines are not corrupted', () => {
  it('a family name right after a DIFFERENT capitalised given name is left alone (Amit Sharma for Neha Sharma), a standalone one is masked', () => {
    expect(maskNameTokens('Concept and direction: Amit Sharma, Creative Director. Copy: Rina Sharma.', 'Neha Sharma')).toBe('Concept and direction: Amit Sharma, Creative Director. Copy: Rina Sharma.');
    expect(maskNameTokens('Client: Sharma Steel Works. "Sharma Ji Ki Beti"', 'Neha Sharma')).toBe('Client: [candidate] Steel Works. "[candidate] Ji Ki Beti"');
    expect(maskNameTokens('Neha Sharma led it; Mr Sharma and Dr Sharma agree', 'Neha Sharma')).toBe('[candidate] [candidate] led it; Mr [candidate] and Dr [candidate] agree');
    expect(maskNameTokens('Rajesh Kumar & Akshay Kumar; Kumar Sanu; Rajesh', 'Rajesh Kumar')).toBe('[candidate] [candidate] & Akshay Kumar; [candidate] Sanu; [candidate]');
  });
  it('a given name right before a DIFFERENT capitalised family name is left alone (Priya Nair for Priya Menon), a middle name is not mistaken for another person', () => {
    expect(maskNameTokens('Concept and copy: Priya Nair. Design: Rahul Menon.', 'Priya Menon')).toBe('Concept and copy: Priya Nair. Design: Rahul Menon.');
    expect(maskNameTokens('Priya Kumari Sharma led it.', 'Priya Sharma')).toBe('[candidate] Kumari [candidate] led it.');
    expect(maskNameTokens('Priya Studio and Priya Creates', 'Priya Sharma')).toBe('[candidate] Studio and [candidate] Creates');
  });
  it('a one-token name is always masked (there is no other token to tell a different person by)', () => {
    expect(maskNameTokens('Priya Nair and Priya', 'Priya')).toBe('[candidate] Nair and [candidate]');
  });
});

describe('findFullPersonName', () => {
  it('finds two capitalised words that are a person, not a title or a studio', () => {
    expect(findFullPersonName('Concept and direction: Jonathan Whitfield, Creative Director')).toBe('Jonathan Whitfield');
    expect(findFullPersonName('Rina M. Kapoor, art director')).toBe('Rina M. Kapoor');
    expect(findFullPersonName('By Amit Sharma')).toBe('Amit Sharma');
  });
  it('is null for roles, studios, acronyms, a single name and nothing', () => {
    for (const t of ['Creative Director', 'Studio Nine Films', 'Concept and direction: the studio team', 'By Amit', 'CEO and COO', 'Head of Brand', '', 'client brief']) {
      expect(findFullPersonName(t), t).toBeNull();
    }
    expect(findFullPersonName(undefined as never)).toBeNull();
  });
});
