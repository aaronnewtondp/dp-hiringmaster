import { describe, it, expect } from 'vitest';
import { extractAnswerUrls, pickAnswerLinks } from './answerLinks.js';

// A held-out set for the punctuation a pasted answer really carries (Word / Docs / iOS smart quotes, Hindi and Hinglish
// punctuation, CJK brackets and stops, markdown, emoji, lists, parentheses, "... is my portfolio"). Written AFTER the fix for
// links wrapped in non-ASCII punctuation and in different wording from every case the fix was built against, so it measures
// what the rule generalises to, not what it was fitted to. Each case is what a person reading the answer would call its links,
// in order, as extractAnswerUrls normalises them (https:// added, host lower-cased, a bare origin without its slash, a
// non-ASCII path percent-encoded). Invisible characters are built with fromCharCode so they stay visible in this file.

const ch = (code: number) => String.fromCharCode(code);
const ZWSP = ch(0x200b), RLM = ch(0x200f), LRM = ch(0x200e), BOM = ch(0xfeff), NBSP = ch(0xa0);

const DRIVE = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view?usp=sharing';
const SLIDES = 'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUv/edit?usp=sharing';

const P = 'https://priyaverma.in';
const A = 'https://arjunmehta.co';
const K = 'https://kunal.io';
const S = 'https://studiokabir.design';
const N = 'https://neha-sharma.com';

type Case = [label: string, answer: string, expected: string[]];

const CASES: Case[] = [
  // ── Smart quotes: Word, Google Docs, iOS keyboards ────────────────────────────────────────────────────────────────────
  ['curly double quotes round a site, in a sentence', 'My portfolio is “https://priyaverma.in” and I update it monthly.', [P]],
  ['curly quotes round a bare domain with a path', '“priyaverma.in/work”', [`${P}/work`]],
  ['curly single quotes', 'Website: ‘https://arjunmehta.co/projects’', [`${A}/projects`]],
  ['Swedish style: closing quote on both sides', 'See ”https://studiokabir.design/case-studies” for campaigns', [`${S}/case-studies`]],
  ['German low-9 and high-6 quotes', '„https://neha-sharma.com/brand-work“', [`${N}/brand-work`]],
  ['single guillemets', 'Case studies: ‹https://meerakapoor.work/launch›', ['https://meerakapoor.work/launch']],
  ['guillemets round a bare Behance address', 'Behance - «behance.net/vikramnair»', ['https://behance.net/vikramnair']],
  ['two quoted links with a comma, the second ending the sentence', 'Here’s my work: “https://kunal.io/work”, and my reel: “https://youtu.be/dQw4w9WgXcQ”.', [`${K}/work`, 'https://youtu.be/dQw4w9WgXcQ']],
  ['a Drive file in smart quotes', `“${DRIVE}”`, [DRIVE]],
  ['a Slides deck in smart quotes inside parentheses', `The deck (“${SLIDES}”) has everything.`, [SLIDES]],
  ['the full stop inside the closing quote', 'Portfolio - “arjunmehta.co/work.”', [`${A}/work`]],
  ['an opening straight quote and a closing curly one', '"https://kunal.io/reel” is the link', [`${K}/reel`]],
  ['two quoted links joined by "and"', '“https://priyaverma.in” and “https://arjunmehta.co”', [P, A]],
  ['a closing single quote after the link, then a dash and words', 'Check out https://kunal.io/work’ — my favourite', [`${K}/work`]],
  ['the query string of a shared link, then a closing quote', 'https://priyaverma.in/work?utm_source=whatsapp&utm_medium=share”', [`${P}/work?utm_source=whatsapp&utm_medium=share`]],

  // ── Hindi, Hinglish and other scripts ─────────────────────────────────────────────────────────────────────────────────
  ['Devanagari sentence, then a link and a danda', 'मेरा काम यहाँ देखें: https://priyaverma.in/work।', [`${P}/work`]],
  ['a double danda straight after a link', 'https://priyaverma.in/work॥', [`${P}/work`]],
  ['a bare domain, then a Devanagari verb and a danda', 'मेरी वेबसाइट priyaverma.in है।', [P]],
  ['Hinglish: a bare domain with the danda glued on', 'portfolio link hai: priyaverma.in।', [P]],
  ['Hinglish with a dash, two links and a danda', 'Mera kaam dekhiye – arjunmehta.co/work – aur Instagram: instagram.com/kavya.creates।', [`${A}/work`, 'https://instagram.com/kavya.creates']],
  ['Hindi sentence with the link in parentheses and the danda after them', 'सभी कैंपेन यहाँ हैं (https://studiokabir.design/campaigns)।', [`${S}/campaigns`]],
  ['two Hindi-labelled links, the second ending in a danda', 'मेरे काम का लिंक: https://behance.net/vikramnair, और वीडियो: https://vimeo.com/123456789।', ['https://behance.net/vikramnair', 'https://vimeo.com/123456789']],
  ['two links with only a danda between them', 'https://neha-sharma.com।https://kunal.io', [N, K]],
  ['a Hindi label glued to the link by a colon', 'लिंक:https://priyaverma.in/work', [`${P}/work`]],
  ['Russian text, then a link and a full stop', 'мое портфолио https://priyaverma.in/work.', [`${P}/work`]],
  ['Arabic text, then a link and an Arabic comma', 'معرض أعمالي: https://priyaverma.in/work،', [`${P}/work`]],
  ['Tamil text, then a link and a full stop', 'என் வேலை: https://priyaverma.in/work.', [`${P}/work`]],
  ['a real Hindi path is part of the address, not junk', 'https://priyaverma.in/काम', [`${P}/%E0%A4%95%E0%A4%BE%E0%A4%AE`]],
  ['a Devanagari domain', 'https://जेन.भारत/work', ['https://xn--81by0g.xn--h2brj9c/work']],
  ['an accented Latin path stays', 'https://studiokabir.design/café-launch', [`${S}/caf%C3%A9-launch`]],

  // ── CJK brackets, stops and commas ────────────────────────────────────────────────────────────────────────────────────
  ['a full-width colon label', '作品集：https://arjunmehta.co/work', [`${A}/work`]],
  ['corner brackets', '「https://kunal.io/work」', [`${K}/work`]],
  ['white corner brackets', '『https://kunal.io/work』', [`${K}/work`]],
  ['full-width parentheses round a URL', '（https://priyaverma.in/work）', [`${P}/work`]],
  ['full-width parentheses round a bare domain', '（priyaverma.in）', [P]],
  ['lenticular brackets before the link', '【Portfolio】https://studiokabir.design/work', [`${S}/work`]],
  ['double angle title brackets', '《Portfolio》 https://kunal.io/p', [`${K}/p`]],
  ['an ideographic full stop after a link', 'https://priyaverma.in/work。', [`${P}/work`]],
  ['a full-width comma between two links', 'https://priyaverma.in，https://arjunmehta.co', [P, A]],
  ['an ideographic comma between two links', 'https://priyaverma.in、https://arjunmehta.co', [P, A]],
  ['an ideographic full stop between two bare domains', 'priyaverma.in。arjunmehta.co/work', [P, `${A}/work`]],
  ['a full-width exclamation mark after a link', 'https://priyaverma.in/work！', [`${P}/work`]],
  ['a full-width question mark after a link', 'https://priyaverma.in/work？', [`${P}/work`]],

  // ── Markdown, WhatsApp emphasis, code ─────────────────────────────────────────────────────────────────────────────────
  ['markdown links with a pipe between them', '[My brand work](https://studiokabir.design/brands) | [Reels](https://youtu.be/dQw4w9WgXcQ)', [`${S}/brands`, 'https://youtu.be/dQw4w9WgXcQ']],
  ['bold', '**https://kunal.io/work**', [`${K}/work`]],
  ['code span round a bare domain', '`priyaverma.in`', [P]],
  ['angle brackets', '<https://neha-sharma.com/work>', [`${N}/work`]],
  ['WhatsApp italics', '_https://kunal.io/work_', [`${K}/work`]],
  ['WhatsApp bold with a single asterisk', '*https://kunal.io/work*', [`${K}/work`]],

  // ── Emoji and arrows ──────────────────────────────────────────────────────────────────────────────────────────────────
  ['pointing hands either side', '👉 https://priyaverma.in/work 👈', [`${P}/work`]],
  ['check marks glued on both sides', '✅https://arjunmehta.co/work✅', [`${A}/work`]],
  ['an emoji arrow glued after a link', 'https://kunal.io/work➡️', [`${K}/work`]],
  ['link emoji round a bare domain', '🔗 priyaverma.in 🔗', [P]],
  ['a clapper and fire after a video link', 'My reel 🎬 https://youtu.be/dQw4w9WgXcQ 🎬🔥', ['https://youtu.be/dQw4w9WgXcQ']],
  ['plain arrows round a link', '→ https://kunal.io/work ←', [`${K}/work`]],

  // ── Lists and line breaks ─────────────────────────────────────────────────────────────────────────────────────────────
  ['"1)" numbered list', '1) https://priyaverma.in\n2) https://arjunmehta.co/work\n3) https://behance.net/vikramnair', [P, `${A}/work`, 'https://behance.net/vikramnair']],
  ['"1." numbered list of bare domains', '1. priyaverma.in\n2. arjunmehta.co/work', [P, `${A}/work`]],
  ['labels on one line, links on the next', 'Portfolio:\nhttps://priyaverma.in/work\nInstagram:\ninstagram.com/kavya.creates', [`${P}/work`, 'https://instagram.com/kavya.creates']],
  ['CRLF between links', 'https://studiokabir.design/work\r\nhttps://kunal.io/work\r\n', [`${S}/work`, `${K}/work`]],
  ['bullet list', '• https://priyaverma.in\n• https://arjunmehta.co\n• https://neha-sharma.com', [P, A, N]],
  ['a lone dash after each link', 'https://priyaverma.in/work -\nhttps://arjunmehta.co/work -\n', [`${P}/work`, `${A}/work`]],

  // ── Parentheses and brackets ──────────────────────────────────────────────────────────────────────────────────────────
  ['a link in parentheses at the end of a sentence', '(see https://priyaverma.in/work)', [`${P}/work`]],
  ['two bare domains each in parentheses', 'Work samples (priyaverma.in/work), reels (youtu.be/dQw4w9WgXcQ).', [`${P}/work`, 'https://youtu.be/dQw4w9WgXcQ']],
  ['a path that ends in a balanced bracket keeps it', 'https://en.wikipedia.org/wiki/Brand_(marketing)', ['https://en.wikipedia.org/wiki/Brand_(marketing)']],
  ['a parenthesised link then a full stop', '(https://kunal.io/work).', [`${K}/work`]],
  ['square brackets', '[https://kunal.io/work]', [`${K}/work`]],
  ['curly braces round a bare domain', '{priyaverma.in}', [P]],

  // ── "... is my portfolio" and similar tails ───────────────────────────────────────────────────────────────────────────
  ['a bare domain followed by words', 'priyaverma.in is my portfolio', [P]],
  ['a link followed by words and a full stop', 'https://priyaverma.in/work is my portfolio.', [`${P}/work`]],
  ['two links, each followed by its description', 'This https://kunal.io/work is my portfolio, this https://youtu.be/dQw4w9WgXcQ is my showreel.', [`${K}/work`, 'https://youtu.be/dQw4w9WgXcQ']],

  // ── Dashes, ellipses, invisible characters ────────────────────────────────────────────────────────────────────────────
  ['guillemets used as arrows round a link', 'Portfolio » priyaverma.in/work « please check', [`${P}/work`]],
  ['an em dash glued to a www address', 'www.priyaverma.in/work—my latest campaigns', ['https://www.priyaverma.in/work']],
  ['an ellipsis glued between the link and a word', 'https://priyaverma.in/work…and more', [`${P}/work`]],
  ['a no-break space before a bracketed word', `https://priyaverma.in/work${NBSP}(PDF)`, [`${P}/work`]],
  ['direction marks round a link', `${RLM}https://priyaverma.in/work${RLM}`, [`${P}/work`]],
  ['a left-to-right mark after a link', `https://priyaverma.in/work${LRM}`, [`${P}/work`]],
  ['a byte order mark before a bare domain', `${BOM}priyaverma.in`, [P]],
  ['a zero-width space inside a domain', `priya${ZWSP}verma.in`, [P]],
  ['a non-breaking hyphen inside a path', 'https://studiokabir.design/winter‑launch', [`${S}/winter-launch`]],

  // ── A second batch, added after the first run: edges of the same rule ────────────────────────────────────────────────────
  ['a CJK full stop typed as the dot of a host', 'https://janedoe\u3002design', ['https://janedoe.design']],
  ['a full-width full stop typed as the dot of a host', 'https://janedoe\uff0edesign/work', ['https://janedoe.design/work']],
  ['a CJK full stop, then more text with no space', 'https://priyaverma.in\u3002\u3054\u89a7\u304f\u3060\u3055\u3044', [P]],
  ['a danda glued between a link and a Hindi word', 'https://priyaverma.in/work\u0964\u0926\u0947\u0916\u0947\u0902', [`${P}/work`]],
  ['a skin-toned emoji after a link', 'Link: https://priyaverma.in/work \ud83d\udc48\ud83c\udffd', [`${P}/work`]],
  ['a Cyrillic path is part of the address', 'https://priyaverma.in/\u0440\u0430\u0431\u043e\u0442\u0430', [`${P}/%D1%80%D0%B0%D0%B1%D0%BE%D1%82%D0%B0`]],
  ['a label colon, then a curly-quoted bare domain, no space', 'Portfolio:\u201cpriyaverma.in\u201d', [P]],
  ['a curly-quoted link, a comma, then a thank-you', 'Work: \u2018https://kunal.io/work\u2019, thanks', [`${K}/work`]],
  ['a parenthesised curly-quoted link', '(\u201chttps://kunal.io/work\u201d)', [`${K}/work`]],
  ['an ellipsis after a bare domain', 'priyaverma.in\u2026', [P]],
  ['first-strong isolate marks round a link', `${ch(0x2068)}https://kunal.io/work${ch(0x2069)}`, [`${K}/work`]],
  ['a soft hyphen where Word wrapped a long slug', `https://studiokabir.design/wi${ch(0xad)}nter-launch`, [`${S}/winter-launch`]],

  // ── Things that are NOT links ─────────────────────────────────────────────────────────────────────────────────────────
  ['a smart-quoted "N/A"', '“N/A”', []],
  ['a smart-quoted NDA', '“Under NDA”', []],
  ['a qualification and a language in quotes', '“Ph.D in Node.js”', []],
  ['an e-mail address in quotes', 'Email me at “jane@priyaverma.in”', []],
  ['a sentence with a missing space after its full stop', 'e.g. “campaigns.In 2022 I led the launch”', []],
  ['a quoted campaign name and a budget', 'I led the launch of “Aqua Fresh” in 2022 and managed a ₹2cr budget.', []],
  ['a Hindi sentence with no link', 'मैंने पिछले पाँच सालों में कई ब्रांड कैंपेन चलाए हैं और टीम को लीड किया।', []],
];

describe('held-out: links in answers wrapped in non-ASCII punctuation', () => {
  it('has the size it claims', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(CASES.map(c => c[0])).size).toBe(CASES.length);     // no label reused
  });

  it.each(CASES)('%s', (_label, answer, expected) => {
    expect(extractAnswerUrls(answer)).toEqual(expected);
  });

  it('the same answers, read the way HR sees them: a wrapped link is a link, not "only a written description"', () => {
    const Q = 'Links to public resources/portfolio to highlight your past work?';
    let linked = 0, noLinkExpected = 0;
    for (const [label, answer, expected] of CASES) {
      const pick = pickAnswerLinks([{ question: Q, answer }], { candidateName: 'Priya Verma' });
      if (expected.length > 0) {
        linked++;
        expect(pick.answered, label).toBe(true);
        expect(pick.textOnly, label).toBe(false);
        expect(pick.links.length + pick.listedNotReviewed.length, label).toBeGreaterThan(0);
      } else {
        noLinkExpected++;
        expect(pick.links, label).toEqual([]);
        expect(pick.listedNotReviewed, label).toEqual([]);
      }
    }
    expect(linked).toBeGreaterThan(55);
    expect(noLinkExpected).toBe(7);
  });
});

// What the rule does NOT do, stated so nobody mistakes it for a goal. A letter of any script is part of an address (that is how a
// Hindi path or a Devanagari domain survives), so letters glued straight onto a link are read as more of it.
describe('known limits of the punctuation rule', () => {
  it('CJK letters glued straight onto a link become part of its path (CJK text has no spaces; nothing separates them)', () => {
    const [url] = extractAnswerUrls('https://priyaverma.in/work\u3092\u3054\u89a7\u304f\u3060\u3055\u3044');
    expect(url.startsWith(`${P}/work%`)).toBe(true);
  });

  it('a dash that is not a hyphen ends the address: an en dash typed inside a slug cuts it there', () => {
    expect(extractAnswerUrls('https://studiokabir.design/winter\u2013launch')).toEqual([`${S}/winter`]);
  });

  it('an apostrophe inside a path, typed as a curly one, ends the address there (an ASCII one stays: see answerLinks.test.ts)', () => {
    expect(extractAnswerUrls('https://studiokabir.design/it\u2019s-work')).toEqual([`${S}/it`]);
  });
});

describe('characters that carry no text are removed from inside an address, not cut at', () => {
  // (The cases above only have them at the edges, where cutting and removing give the same link.)
  const invisible: Array<[string, number]> = [
    ['soft hyphen', 0xad], ['Arabic letter mark', 0x61c], ['zero-width space', 0x200b], ['zero-width non-joiner', 0x200c], ['zero-width joiner', 0x200d],
    ['left-to-right mark', 0x200e], ['right-to-left mark', 0x200f], ['left-to-right embedding', 0x202a], ['pop directional formatting', 0x202c],
    ['right-to-left override', 0x202e], ['word joiner', 0x2060], ['left-to-right isolate', 0x2066], ['first strong isolate', 0x2068],
    ['pop directional isolate', 0x2069], ['variation selector 15', 0xfe0e], ['variation selector 16', 0xfe0f], ['byte order mark', 0xfeff],
  ];
  it.each(invisible)('%s inside a domain', (_n, code) => {
    expect(extractAnswerUrls(`priya${ch(code)}verma.in/work`)).toEqual([`${P}/work`]);
  });
  it.each(invisible)('%s inside the path of a scheme URL', (_n, code) => {
    expect(extractAnswerUrls(`https://studiokabir.design/win${ch(code)}ter-launch`)).toEqual([`${S}/winter-launch`]);
  });
});

describe('letters, marks and digits of every script stay in an address', () => {
  it.each([
    ['Devanagari letters, vowel signs, a virama and digits', 'https://priyaverma.in/\u0915\u093e\u092e-\u0968\u0966\u0968\u096a'],
    ['Arabic-Indic digits', 'https://priyaverma.in/work-\u0662\u0660\u0662\u0664'],
    ['Thai letters with vowel marks', 'https://priyaverma.in/\u0e1c\u0e25\u0e07\u0e32\u0e19'],
    ['a combining accent', 'https://priyaverma.in/cafe\u0301'],
    ['superscript digits and Greek', 'https://priyaverma.in/\u03b1\u03b2\u00b2'],
  ])('%s', (_n, url) => {
    const path = url.slice('https://priyaverma.in/'.length);
    expect(extractAnswerUrls(url)).toEqual([`${P}/${encodeURIComponent(path)}`]);
  });
});

describe('hostile answers made of the new punctuation still finish quickly', () => {
  const Q = 'Links to public resources/portfolio to highlight your past work?';
  const dot = ch(0x3002), quote = ch(0x201d), danda = ch(0x0964), emoji = String.fromCodePoint(0x1f448), tone = String.fromCodePoint(0x1f3fd);
  it.each([
    ['one smart quote repeated', () => `https://a.com/${quote.repeat(30_000)}`],
    ['CJK full stops between host labels', () => `https://a${dot}`.repeat(8_000)],
    ['CJK full stops between ASCII words', () => `https://a${dot}b`.repeat(5_000)],
    ['a bare domain chain joined by CJK full stops', () => `a${dot}`.repeat(19_000)],
    ['a very long host with a CJK full stop in it', () => `https://${'a'.repeat(20_000)}${dot}${'b'.repeat(15_000)}`],
    ['dandas between links', () => `x${danda}https://a.in`.repeat(2_500)],
    ['emoji and skin tones', () => `https://a.com/x${(emoji + tone).repeat(10_000)}`],
    ['combining marks', () => `https://a.com/${ch(0x0300).repeat(30_000)}`],
    ['viramas', () => (ch(0x0915) + ch(0x094d)).repeat(19_000)],
    ['invisible marks', () => `https://a.com/${(ch(0x200f) + ch(0xfe0f) + ch(0x2068)).repeat(12_000)}x`],
  ])('%s', (_n, make) => {
    const text = make();
    const t0 = performance.now();
    pickAnswerLinks([{ question: Q, answer: text }]);
    extractAnswerUrls(text);
    expect(performance.now() - t0).toBeLessThan(300);
  });
});
