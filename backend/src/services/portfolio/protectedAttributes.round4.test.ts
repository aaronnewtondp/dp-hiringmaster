import { describe, it, expect } from 'vitest';
import { findProtectedAttribute, redactPersonalStatements } from './protectedAttributes.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Fix round 4 (E3A): the findings of the third review that are about the statement rules and the redaction.
//   G5  a first-person statement is not hidden by a portfolio word in the same sentence (client, customer, audience, case study, featured ...)
//   G9  the redaction is a fixed point: redacting its own output changes nothing ("Age: 37 and 12 years of experience")
//   G10 recall on unseen wording (hyphenated and bare ages, born-in years, noun-only bios, family shapes), with the false-positive guards that
//       go with each new shape. The corpora are in protectedAttributes.heldout4.test.ts and protectedAttributes.review3.test.ts.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const stillPersonal = (s: string): string | null => findProtectedAttribute(redactPersonalStatements(s).text);
const goes = (s: string): boolean => { const r = redactPersonalStatements(s); return r.removed > 0 && findProtectedAttribute(r.text) === null; };

describe('G5: a statement the writer makes about themself is not shielded by a portfolio word in the same sentence', () => {
  // The first-person statements; each is removed on its own, and the question is whether it still is when a cue word shares the sentence.
  const BASES = [
    'I am a Hindu woman', "I'm pregnant", 'I am a divorced mother', "I'm 41 years old", 'My husband is a doctor', 'I am a single dad',
    'I am married with two kids', 'I identify as non-binary', 'My wife and I run a small studio', 'I am a Sikh', 'I use a wheelchair',
    'As a married woman', 'As a working mother', 'Being a Muslim woman', 'I turned 45 this year', 'My kids are 6 and 9',
    'I am a Parsi woman', 'I recently got married', 'I am expecting my first child', 'I am a 38-year-old copywriter',
  ];
  const TAILS = [
    'and I have worked with clients', 'and I wrote the case studies', 'and my audience is customers', 'and I partnered with Tata',
    'and I featured farmers in the film', 'and the clients loved the work', 'but the case study won an award', 'and the audience grew 3x',
    'while the customers kept coming', 'and our partners worked with me', 'aur maine clients ke saath kaam kiya', 'and the influencers I worked with',
  ];
  const COMBOS = BASES.flatMap(b => TAILS.map(t => [b, t] as const));

  it('has 240 combinations', () => { expect(COMBOS).toHaveLength(240); });
  it('every statement goes (and nothing personal is left) with a cue word in the same sentence, before it or after it', () => {
    const leaks: string[] = [];
    for (const [b, t] of COMBOS) {
      // "As a ..." / "Being a ..." are lead-ins: they need the "I" that follows them
      const lead = /^(?:As|Being) /.test(b);
      const s = lead ? `${b} I know the ${t.replace(/^(?:and|but|while|aur) /, '')}.` : `${b}, ${t}.`;
      if (!goes(s)) leaks.push(s);
      if (!lead) {
        const reversed = `The clients came and ${b.charAt(0).toLowerCase()}${b.slice(1)}.`;
        // a statement after the cue is read as the writer's own only when it is first person: "I ..." / "My ..."
        if (/^(?:I|My|I')/.test(b) && !goes(reversed)) leaks.push(reversed);
      }
    }
    expect(leaks).toEqual([]);
  });
  it('the shielded sentence from the review: all four statements go, in the real request they were left in', () => {
    const answer = 'I am a Hindu woman and I have worked with 30 clients. As a married woman I know what the audience wants.';
    const r = redactPersonalStatements(answer);
    expect(r.text.toLowerCase()).not.toMatch(/hindu|woman|married/);
    expect(r.text).toContain('worked with 30 clients');
    expect(redactPersonalStatements('As a working mother I partnered with Tata on three launches.').text).toBe('I partnered with Tata on three launches.');
    expect(redactPersonalStatements("I'm pregnant and the work here was shot with local farmers.").text).toBe('the work here was shot with local farmers.');
  });
  it('a lead-in phrase next to the writer\'s "I" goes: "A Christian by faith, I still ran the campaign for a client"', () => {
    const r = redactPersonalStatements('A Christian by faith, I still ran the Ramzan campaign for a beverage client, which grew sales 18%.');
    expect(r.text).toBe('I still ran the Ramzan campaign for a beverage client, which grew sales 18%.');
  });
  it('a lead-in with no comma and no separator ("as a single mother I learned to prioritise") keeps what follows the "I"', () => {
    expect(redactPersonalStatements('as a single mother I learned to prioritise ruthlessly.').text).toBe('I learned to prioritise ruthlessly.');
    expect(redactPersonalStatements('I led the relaunch, and I am a mother of two.').text).toBe('I led the relaunch.');
  });
  it('the output filter: "she is a Hindu woman and has worked with 30 clients" is flagged (a cue later in the sentence shields nothing before it)', () => {
    for (const s of [
      'She is a Hindu woman and has worked with 30 clients.',
      'The candidate is a mother of two but has managed 40 customers.',
      'The founder is a woman and the client is a bank.',
      'He is a Sikh man, and he partnered with several brands.',
      'Priya is a mother of two aur woh 30 clients ke saath kaam karti hai.',
    ]) expect(findProtectedAttribute(s), s).not.toBeNull();
  });
  it('what follows a clause that names a third party goes on about that third party, and stays', () => {
    for (const s of [
      'The film follows a farmer and her husband through the harvest.',
      'Featuring Meera and her husband, a farmer from Bihar.',
      'The campaign featured a widow and she was raising two kids alone.',
      'The case study covers a founder, a single mom, who built the brand from zero.',
      "Our client's founder is a woman who built the brand from her kitchen.",
      'The ad stars a Sikh couple and their grandchildren.',
      'I partnered with a client whose founder is a woman.',
      'I interviewed the founder, who is a Muslim woman, for the case study.',
      'The founder is a Hindu woman, I interviewed her for the case study.',
      'The client is a single mom, I wrote her case study.',
    ]) {
      expect(findProtectedAttribute(s), s).toBeNull();
      expect(redactPersonalStatements(s).text, s).toBe(s);
    }
  });
  it('a bare "my" in a clause that names a client is not a statement about the writer', () => {
    for (const s of ['My clients include a Hindu temple trust and a Muslim charity.', "My client's founder is a woman who built the brand.", 'My case studies feature a woman farmer who is a widow.']) {
      expect(findProtectedAttribute(s), s).toBeNull();
    }
  });
});

describe('G9: the redaction is a fixed point', () => {
  it('"Age: 37 and 12 years of experience" and the other shapes in which the years edit used to reveal an age', () => {
    for (const s of [
      'Age: 37 and 12 years of experience in brand marketing.', 'Age 37 and 12 yrs experience.', 'aged 38 and 12 years in marketing', 'I am aged 38 and 12 years in marketing',
      'Age: 37 10+ yrs', 'Age: 37 and 10+ yrs', 'Age: 37 and 2 kids', 'Age - 37 and 2 kids', 'Age: 37 and 3 campaigns won Effies',
      'Born in 1987 and 12 years of experience', '37 years old and 12 years in marketing', '37 years old, 12 years in marketing',
    ]) {
      const once = redactPersonalStatements(s);
      expect(once.removed, s).toBeGreaterThan(0);
      expect(findProtectedAttribute(once.text), `${s} -> ${once.text}`).toBeNull();
      expect(once.text, s).not.toMatch(/\b37\b/);
      expect(redactPersonalStatements(once.text).text, `${s} -> ${once.text}`).toBe(once.text);
    }
  });
  it('a sentence cut out of the middle joins "since 2009" to the words before it: the years there are replaced in the same call', () => {
    for (const s of ['Brand | Copy | Design • I am 38; since 2009', 'I built the brand from zero | priya@gmail.com; since 2009', 'Brand | Copy | Design (as a working mother; since 2009']) {
      const r = redactPersonalStatements(s);
      expect(r.text, s).not.toMatch(/2009/);
      expect(redactPersonalStatements(r.text).text, s).toBe(r.text);
    }
    // the Hinglish "8 saal ka experience" is a duration of work (the number goes, the sentence stays), whatever is stitched next to it
    expect(redactPersonalStatements('Brand | Copy | Design • Main 8 saal ka experience rakhti hoon; since 2009').text).toContain('ka experience rakhti hoon');
  });
  it('a range of ages is still not an age: the second number decides ("aged 18 and 24", "age 25 30", an audience)', () => {
    for (const s of ['users aged 18 and 24 responded', 'women aged 25 and 40 were the audience', 'target age: 25 and 34', 'Respondents aged 18 and 24 rated the film', 'Respondents aged 18 24 rated the film', 'customers aged 25-34 and 35-44']) {
      expect(findProtectedAttribute(s), s).toBeNull();
      expect(redactPersonalStatements(s).text, s).toBe(s);
    }
  });
  it('no input is changed by a second pass (seeded fuzz over fragments, separators and the shapes that used to break it)', () => {
    let seed = 20261023;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;
    const FRAGMENTS = ['I am married', "I'm a mother of two", "Led the Women's Day campaign", 'reaching 3M', 'with 12 years of experience', 'my 8 years at Tata', 'I built the brand from zero',
      'Mom of 2', 'she/her', 'Mumbai', 'a team of 12 designers', 'https://janedoe.design/work', 'call +91 98765 43210', 'priya@gmail.com', 'I am 38', 'Brand | Copy | Design',
      '• Clean Ganga', '(3 films, 6 cities)', 'and', 'but', 'so', 'because', 'as a working mother', 'Hindu festival campaign', 'launched 30 campaigns', 'Main 8 saal ka experience rakhti hoon',
      '\n', '10+ yrs', 'since 2009', 'Age: 37', 'F', '—', ' - ', ' / ', 'Born in 1987', '37 years old', '37yo', 'Male, 34', 'Priya, 37, brand lead', 'Wife | Mom', 'Mother of twins',
      'and I have worked with clients', 'the clients', 'featuring Meera', 'aur', 'toh', 'Age 37 and 12 yrs experience', 'I turned 40', 'new mom', '3 kids', 'since', 'which', 'Hindu.', 'Mother.',
      'I belong to the Nair community', 'the founder of the studio is a woman', 'I use a wheelchair', 'My husband runs the clients side', 'As a woman I', 'A Christian by faith, I',
      'हिंदू महिला हूँ', 'मैं 38 साल की हूँ', '\u200b', '\r\n'];
    const SEPARATORS = [' ', ', ', '. ', '; ', ' • ', ' | ', '\n', ' — ', ': ', ' and ', ' (', ') '];
    const bad: string[] = [];
    for (let k = 0; k < 6000 && bad.length < 5; k++) {
      const parts: string[] = [];
      const n = 1 + Math.floor(rnd() * 12);
      for (let i = 0; i < n; i++) parts.push(pick(FRAGMENTS), pick(SEPARATORS));
      const s = parts.join('');
      const once = redactPersonalStatements(s).text;
      if (redactPersonalStatements(once).text !== once) bad.push(s);
    }
    expect(bad).toEqual([]);
  });
});

describe('G10: shapes of age, family and identity that the first round-3 fixes missed, and what must stay', () => {
  const GONE: Array<[string, RegExp]> = [
    ["I'm a 41-year-old brand strategist.", /41/], ['35-year-old Gujarati woman', /35/], ['37 years old.', /37/], ['About me: 37 years old, based in Pune.', /37/],
    ['Brand lead, 37 years old, with a team of 6', /37/], ['37yo brand lead', /37/], ['Born in 1987.', /1987/], ['Born 1983 | Brand lead', /1983/], ['Male, 34, brand manager.', /34/],
    ['Priya, 37, brand lead', /37/], ['Currently 37 years old', /37/], ['At 37 years old I started my own studio.', /37 years/], ['Turned 40 this year', /40/], ['I just had my second baby and am returning from leave.', /baby/], ['Mother of twins, marketer, coffee addict.', /twins/],
    ['Mom to 2 under 5 | Founder, Aqua Studio | Campaigns for 40+ brands', /Mom/], ['Mother. Wife. Marketer. Dreamer.', /Mother|Wife/], ['Wife | Mom | Marketer', /Wife|Mom/],
    ['Hindu. Mother. Marketer.', /Hindu|Mother/], ['Desi girl | Brand lead | Delhi', /Desi/], ['Brand strategist, new mom, ex-agency', /new mom/], ['Proud mom. Brand builder.', /mom/],
    ['Founder of Aqua Studio. 3 kids, 1 dog, 40 campaigns.', /3 kids/], ['I belong to the Nair community.', /Nair/], ['Meri shaadi ko 5 saal ho gaye.', /shaadi/],
  ];
  it.each(GONE)('goes: %s', (s, re) => {
    const r = redactPersonalStatements(s);
    expect(r.removed).toBeGreaterThan(0);
    expect(r.text).not.toMatch(re);
    expect(findProtectedAttribute(r.text)).toBeNull();
  });
  it('the work that shares the line stays ("Mom to 2 under 5 | Founder, Aqua Studio | Campaigns for 40+ brands")', () => {
    expect(redactPersonalStatements('Mom to 2 under 5 | Founder, Aqua Studio | Campaigns for 40+ brands').text).toBe('Founder, Aqua Studio | Campaigns for 40+ brands');
    expect(redactPersonalStatements('Mother. Wife. Marketer. Dreamer.').text).toBe('Marketer. Dreamer.');
    expect(redactPersonalStatements('Priya Sharma | Brand strategist | Mom of 2 | she/her | Pune | DM for collabs: priya@brand.com').text).toBe('Priya Sharma | Brand strategist | Pune');
  });
  it('the Hinglish "N saal ka experience" is a duration of work, not an age: the campaign claim after "aur" stays', () => {
    const r = redactPersonalStatements('Main 8 saal ka experience rakhti hoon aur maine 20 se zyada campaigns launch kiye.');
    expect(r.text).toContain('maine 20 se zyada campaigns launch kiye');
    expect(r.text).not.toMatch(/\b8 saal/);
    // a real Hinglish age is still one
    for (const s of ['Main 29 saal ka ladka hoon.', 'Main ek 35 saal ki mahila hoon aur marketing mein kaam karti hoon.', 'Main 40 saal ka hoon.']) expect(goes(s), s).toBe(true);
  });
  it('third person with an adverb after the verb, a nationality noun, a place phrase and a "reads like" sentence', () => {
    for (const s of [
      'This applicant is evidently Christian, given the church-run campaigns.', 'He is a Nigerian national working in India.', 'The person on the founder video is elderly.',
      'The founder of the studio is a single mom.', 'This reads like the work of a young, unmarried woman.', 'The spokesperson is clearly a transgender woman.',
      'The creator, a Tamil Brahmin, grew up in Chennai.', 'The woman in the interview video is in her sixties.',
    ]) expect(findProtectedAttribute(s), s).not.toBeNull();
  });
  it('what each new shape must not touch', () => {
    for (const s of [
      'The deck shows a 10-year-old brand relaunch.', 'The brand is 10 years old and needed a refresh.', 'Rebranded a 14-year-old baby-products company.', 'Our 12-year-old product line got a visual refresh.',
      'Born in 2008, Zomato started as Foodiebay.', 'The brand was born in 1987 and still sells.', 'Born-digital brand, launched on Instagram.',
      'Mother Dairy summer campaign with 3 films.', "Mother's Day gifting campaign: 28% uplift.", 'Husband-and-wife influencer pair, 1.2M followers.', 'Parent-teacher app onboarding campaign.',
      'Pan-India campaign across Hindu, Muslim and Christian festivals.', 'Hindu, Muslim and Christian voices featured in the film.', 'Sikh and Hindu volunteers appear in the film.',
      'Christian Dior brand study used as a reference.', 'Jewish Museum rebrand pitch shortlisted.', 'Audience: men and women 18-35, metro cities.',
      'Campaigns: 12, 14, 16 across three cities.', 'At 25 years old the brand was still a startup.', 'Turned 100 pitches into 12 wins.', 'The brand turned 25 this year.', 'Delhi, 25 stores and growing.', 'Q3, 25 launches and 4 awards.', 'Team of 3 kids-brand specialists.',
      'Case: 3 kids and a dog star in the ad.', 'I belong to the design community.', 'Led a 5-year-old product line through three redesigns.',
    ]) {
      expect(findProtectedAttribute(s), s).toBeNull();
      expect(redactPersonalStatements(s).text, s).toBe(s);
    }
  });
  it('a bio piece is a piece: a fragment cut out of a sentence at "and" is never read as one', () => {
    expect(findProtectedAttribute('Wife and children appear in the film')).toBeNull();
    expect(findProtectedAttribute('Muslim and Hindu families shared meals in the ad')).toBeNull();
  });
  it('"Name, 31, role" needs a capitalised name at the start of a line or piece, and nothing for a persona or a list', () => {
    expect(findProtectedAttribute('Sonia, 31, content lead')).not.toBeNull();
    expect(findProtectedAttribute('Priya Sharma, 38, a brand lead')).not.toBeNull();
    expect(findProtectedAttribute('Brand | Sonia, 31, content lead')).not.toBeNull();
    expect(findProtectedAttribute('The persona "Neha, 29, product manager" informed the tone.')).toBeNull();
    expect(findProtectedAttribute('Persona: Neha, 29, product manager, urban')).toBeNull();
    expect(findProtectedAttribute('Reach grew 3x in Pune, 25, and Delhi, 30 stores.')).toBeNull();
  });
  it('the real redaction of a whole bio answer leaves the work and the links, and nothing personal', () => {
    const a = 'Portfolio: https://janedoe.design/work\nPriya | Brand strategist | Mom of 2 | she/her | 12 yrs | Pune\nBorn in 1986, I started in print and moved to digital. I led 14 campaigns and won two Effies.';
    const r = redactPersonalStatements(a);
    expect(r.text).toContain('https://janedoe.design/work');
    expect(r.text).toContain('moved to digital. I led 14 campaigns and won two Effies.');
    expect(r.text).not.toMatch(/Mom of 2|she\/her|1986|12 yrs/);
    expect(stillPersonal(a)).toBeNull();
  });
});
