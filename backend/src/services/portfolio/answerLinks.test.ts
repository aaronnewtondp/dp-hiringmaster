import { describe, it, expect } from 'vitest';
import {
  WORK_SAMPLE_QUESTION_RE, findWorkSampleAnswer, isBlankAnswer, extractAnswerUrls, classifyAnswerUrl, pickAnswerLinks,
} from './answerLinks.js';

// Two wordings of the question exist on the Job Application Form; the first carries the form's own typo "intitiatives".
const Q1 = "Links to public resources/portfolio to highlight your past work? eg: brand campaigns/marketing intitiatives/ad designs etc that you've run";
const Q2 = "Links to public resources/portfolio to highlight your past work? E.g. brand campaigns / marketing initiatives / ad designs etc. that you've run";
const answerOf = (answer: string, question = Q1) => [
  { question: 'Current CTC (in LPA)', answer: '24' },
  { question, answer },
  { question: 'Notice period', answer: '30 days' },
];

const DRIVE_ID = '1AbCdEfGhIjKlMnOp';

function timed<T>(fn: () => T): { result: T; ms: number } {
  const t0 = performance.now();
  const result = fn();
  return { result, ms: performance.now() - t0 };
}

describe('findWorkSampleAnswer', () => {
  it.each([[Q1], [Q2]])('finds the answer under either live wording (%#)', (q) => {
    expect(findWorkSampleAnswer(answerOf('https://janedoe.design', q))).toEqual({ question: q, answer: 'https://janedoe.design' });
  });
  it('matches the question case-insensitively and inside a longer question', () => {
    const q = `  ${Q1.toUpperCase()} (optional)`;
    expect(findWorkSampleAnswer([{ question: q, answer: 'x' }])).toEqual({ question: q, answer: 'x' });
  });
  it('the regex is not global (a /g regex keeps lastIndex between calls and alternates true/false)', () => {
    expect(WORK_SAMPLE_QUESTION_RE.global).toBe(false);
    expect(WORK_SAMPLE_QUESTION_RE.test(Q1)).toBe(true);
    expect(WORK_SAMPLE_QUESTION_RE.test(Q1)).toBe(true);
    expect(WORK_SAMPLE_QUESTION_RE.test(Q2)).toBe(true);
  });
  it('returns the first matching entry that has a string answer', () => {
    const screening = [
      { question: Q1, answer: 42 },
      { question: Q2, answer: 'second' },
      { question: Q1, answer: 'third' },
    ];
    expect(findWorkSampleAnswer(screening)).toEqual({ question: Q2, answer: 'second' });
    expect(findWorkSampleAnswer([{ question: Q1, answer: 'first' }, { question: Q2, answer: 'second' }])?.answer).toBe('first');
  });
  it('is null when no question matches', () => {
    expect(findWorkSampleAnswer([{ question: 'Current CTC (in LPA)', answer: '24' }])).toBeNull();
    expect(findWorkSampleAnswer([])).toBeNull();
  });
  it.each([
    ['Link to your LinkedIn profile'],
    ['Portfolio link'],
    ['Links to public resources'],
    ['Public resources/portfolio links'],
  ])('does not match a similar but different question: %s', (q) => {
    expect(findWorkSampleAnswer([{ question: q, answer: 'https://x.com' }])).toBeNull();
  });
  it.each([[null], [undefined], ['text'], [42], [true], [{}], [{ question: Q1, answer: 'not in an array' }]])(
    'returns null for a non-array screening value (%#)', (v) => {
      expect(findWorkSampleAnswer(v)).toBeNull();
    });
  it('skips junk entries without throwing', () => {
    const junk: unknown[] = [null, undefined, 7, 'text', [], [Q1, 'x'], {}, { question: 5, answer: 'x' }, { question: Q1 }, { question: Q1, answer: null }, { answer: 'x' }];
    expect(findWorkSampleAnswer(junk)).toBeNull();
    expect(findWorkSampleAnswer([...junk, { question: Q1, answer: 'found it' }])?.answer).toBe('found it');
  });
  it('returns an empty-string answer as is (deciding that it is blank is isBlankAnswer\'s job)', () => {
    expect(findWorkSampleAnswer([{ question: Q1, answer: '' }])).toEqual({ question: Q1, answer: '' });
  });
});

describe('isBlankAnswer', () => {
  it.each([
    [''], ['   '], ['\n\t \n'], ['-'], ['--'], ['.'], ['...'], ['—'], ['???'], ['/'], ['👍'], ['  -  '],
  ])('blank / punctuation-only: %j', (t) => { expect(isBlankAnswer(t)).toBe(true); });

  it.each([
    ['N/A'], ['n/a'], ['N/A.'], ['NA'], ['na'], ['N.A'], ['n.a.'], ['N / A'], ['n-a'],
    ['None'], ['none.'], ['NONE'], ['Nil'], ['NIL.'], ['No'], ['no'], ['Nope'], ['nope!'], ['Nothing'], ['nothing.'],
    ['Not applicable'], ['not applicable.'], ['Not Available'], ['not available at the moment'], ['Not yet'],
    ['No links'], ['no link available'], ['No portfolio'], ['I do not have any portfolio links'], ["I don't have a public portfolio"],
    ["I don’t have any work samples to share"], ['No public work samples available'], ['Nothing to share at the moment'],
    ['Sorry, no links'], ['None at present'], ['koi link nahi hai'],
  ])('says there is nothing: %j', (t) => { expect(isBlankAnswer(t)).toBe(true); });

  it.each([
    ['NDA'], ['nda'], ['Under NDA'], ['under an NDA'], ['All work is under NDA'], ['All my work is under NDA, will share on request'],
    ['Non-disclosure agreement'], ['Non disclosure'], ['Work is confidential'], ['Confidential'], ['Strictly confidential'],
    ["Can't share"], ['Cannot share due to NDA'], ['Unable to share publicly'], ['My portfolio is private'],
    ['Not applicable - NDA'],
  ])('confidentiality statement: %j', (t) => { expect(isBlankAnswer(t)).toBe(true); });

  it.each([
    ['Will share on request'], ['Will share in the interview'], ['Available on request'], ['Available upon request'],
    ['Portfolio available on request'], ['Can share during the interview'], ['Will be shared later'],
  ])('deferral statement: %j', (t) => { expect(isBlankAnswer(t)).toBe(true); });

  it.each([
    ['https://www.instagram.com/janedoe'],
    ['janedoe.design'],
    ['Portfolio at janedoe.design'],
    ['No campaign was bigger than our Diwali launch, which reached 3 million people'],
    ['I led the rebrand of a D2C startup and ran 12 campaigns'],
    ['Not just ads: I built the whole brand for a water-tech startup'],
    ['Nothing beats a great story, and mine are on Behance'],
    ['None of the campaigns relied on paid spend; all ran on organic reach'],
    ['No. 1 brand campaign for a startup in Mumbai'],
    ['I do not have a website but I created the identity for Aqua Spark and ran 12 campaigns'],
    ['NDA-free rebrand of a D2C startup, led end to end'],
    ['Hi'], ['Yes'], ['see resume'], ['portfolio available'], ['link'], ['work samples'], ['I have a portfolio'],
    ['कोई लिंक नहीं है'],
  ])('a real answer (or at least not a "nothing" statement) is NOT blank: %j', (t) => { expect(isBlankAnswer(t)).toBe(false); });

  it('a long text is a description whatever words it uses', () => {
    expect(isBlankAnswer('no '.repeat(300))).toBe(false);          // 900 chars
    expect(isBlankAnswer('no link '.repeat(25))).toBe(false);      // 200 chars but 50 words
  });
  it('treats a non-string as blank rather than throwing', () => {
    expect(isBlankAnswer(undefined as unknown as string)).toBe(true);
    expect(isBlankAnswer(null as unknown as string)).toBe(true);
    expect(isBlankAnswer(42 as unknown as string)).toBe(true);
  });
  it('a 100 KB blob of punctuation is blank and quick', () => {
    const { result, ms } = timed(() => isBlankAnswer('-!?.,;:()[]{}'.repeat(8000)));
    expect(result).toBe(true);
    expect(ms).toBeLessThan(200);
  });
});

describe('extractAnswerUrls', () => {
  it('finds scheme URLs and strips trailing sentence punctuation', () => {
    expect(extractAnswerUrls('See https://jane.design/work. Also (https://jane.design/about), and https://x.com/a!')).toEqual([
      'https://jane.design/work', 'https://jane.design/about', 'https://x.com/a',
    ]);
  });
  it('splits on spaces, commas, semicolons, pipes and newlines', () => {
    const text = 'https://a.com/1, https://b.com/2;https://c.com/3|https://d.com/4\nhttps://e.com/5\r\nhttps://f.com/6\thttps://g.com/7';
    expect(extractAnswerUrls(text)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n, i) => `https://${'abcdefg'[i]}.com/${n}`));
  });
  it('keeps the order of appearance across scheme, www and scheme-less links', () => {
    expect(extractAnswerUrls('janedoe.design then https://a.com/x then www.b-brand.in/y and instagram.com/z')).toEqual([
      'https://janedoe.design', 'https://a.com/x', 'https://www.b-brand.in/y', 'https://instagram.com/z',
    ]);
  });
  it('removes exact duplicates but keeps the first occurrence', () => {
    expect(extractAnswerUrls('https://a.com/x https://b.com/y https://a.com/x')).toEqual(['https://a.com/x', 'https://b.com/y']);
  });
  it('accepts an upper-case scheme and host', () => {
    expect(extractAnswerUrls('HTTPS://WWW.INSTAGRAM.COM/JaneDoe')).toEqual(['https://www.instagram.com/JaneDoe']);
  });

  it.each([
    'instagram.com/janedoe', 'www.instagram.com/janedoe', 'instagr.am/janedoe',
    'youtube.com/@janedoe', 'm.youtube.com/watch?v=dQw4w9WgXcQ', 'youtu.be/dQw4w9WgXcQ',
    'vimeo.com/123456789', 'loom.com/share/0123456789abcdef',
    `drive.google.com/file/d/${DRIVE_ID}/view`, `docs.google.com/document/d/${DRIVE_ID}/edit`,
    `docs.google.com/presentation/d/${DRIVE_ID}/edit`, `docs.google.com/spreadsheets/d/${DRIVE_ID}/edit`,
    'canva.com/design/DAFabc123/view', 'jane.my.canva.site', 'dropbox.com/s/abc/Deck.pdf?dl=0',
    'linktr.ee/janedoe', 'bio.link/janedoe', 'beacons.ai/janedoe', 'linkin.bio/janedoe', 'lnk.bio/janedoe', 'campsite.bio/janedoe',
    'notion.so/Portfolio-abc123', 'jane.notion.site/Work-123', 'behance.net/janedoe', 'dribbble.com/janedoe',
    'medium.com/@janedoe', 'jane.medium.com', 'janedoe.substack.com', 'linkedin.com/in/jane-doe', 'figma.com/proto/AbC/flow',
    'jane.figma.site', 'wetransfer.com/downloads/abc', 'we.tl/t-AbC123', 'jane.framer.website', 'jane.webflow.io',
    'bit.ly/3xYzAb', 'lnkd.in/abc123', 't.co/AbCdEf', 'tinyurl.com/abc123', 'rb.gy/abc123', 'ow.ly/AbCd', 'buff.ly/3abc', '1drv.ms/b/s!AbCdEf', 'goo.gl/AbCdEf',
    'facebook.com/janedoe', 'twitter.com/janedoe', 'x.com/janedoe', 'tiktok.com/@janedoe', 'threads.net/@janedoe', 'pinterest.com/janedoe',
  ])('finds the scheme-less link %s', (typed) => {
    expect(extractAnswerUrls(`Work: ${typed} thanks`)).toEqual([`https://${typed}`]);
  });
  it('lower-cases a typed host but never the path', () => {
    expect(extractAnswerUrls('Instagram.com/JaneDoe')).toEqual(['https://instagram.com/JaneDoe']);
    expect(extractAnswerUrls('Janedoe.com')).toEqual(['https://janedoe.com']);
    expect(extractAnswerUrls('JANEDOE.COM')).toEqual(['https://janedoe.com']);
  });

  it('finds www links of any ending, but not "www.something" with no real host', () => {
    expect(extractAnswerUrls('www.janedoe.xyz/work www.jane.co.in')).toEqual(['https://www.janedoe.xyz/work', 'https://www.jane.co.in']);
    expect(extractAnswerUrls('www.abc')).toEqual([]);
  });

  it.each([
    'janedoe.design', 'janedoe.studio', 'janedoe.me', 'janedoe.io', 'janedoe.co', 'janedoe.in', 'janedoe.com', 'janedoe.net',
    'janedoe.org', 'janedoe.agency', 'janedoe.work', 'janedoe.art', 'janedoe.site', 'janedoe.xyz', 'janedoe.app', 'janedoe.page',
    'janedoe.co.in', 'blog.janedoe.com',
  ])('finds a bare custom domain standing alone: %s', (d) => {
    expect(extractAnswerUrls(`my site ${d} and more`)).toEqual([`https://${d}`]);
  });
  it('finds a bare custom domain with a path, or after a label', () => {
    expect(extractAnswerUrls('janedoe.design/work/case-1')).toEqual(['https://janedoe.design/work/case-1']);
    expect(extractAnswerUrls('portfolio:janedoe.design')).toEqual(['https://janedoe.design']);
    expect(extractAnswerUrls('Website=janedoe.design/work')).toEqual(['https://janedoe.design/work']);
    expect(extractAnswerUrls('Behance:behance.net/janedoe')).toEqual(['https://behance.net/janedoe']);
  });
  it.each([
    ['e.g.'], ['etc.'], ['i.e.'], ['Ph.D.'], ['Node.js'], ['Next.js'], ['resume.pdf'], ['logo.png'], ['deck.pptx'], ['v2.0'], ['3.5'],
    ['a.in'], ['2022.in'], ['B.Sc'], ['M.Des'], ['campaigns.In'], ['brands.Co'], ['ads.Io'], ['Brand.Strategy'],
  ])('does not treat %j as a link', (t) => {
    expect(extractAnswerUrls(`I ran many ${t} 2022 for startups`)).toEqual([]);
  });
  it('does not treat words glued to a full stop at a sentence end as a link', () => {
    expect(extractAnswerUrls('I ran brand campaigns for startups, ad designs etc. These are my own.')).toEqual([]);
    expect(extractAnswerUrls('eg: brand campaigns/marketing initiatives/ad designs etc that I have run')).toEqual([]);
  });

  it.each([
    ['jane@gmail.com'], ['jane.doe@medium.com'], ['email me: jane@figma.com'], ['jane@janedoe.design'], ['mailto:jane@x.com'],
    ['contact:jane@instagram.com'], ['hello@www.janedoe.com'],
  ])('an email address is not a link: %j', (t) => { expect(extractAnswerUrls(t)).toEqual([]); });
  it('an "@" in the PATH is a profile and is fine; a bare @handle is not a link', () => {
    expect(extractAnswerUrls('medium.com/@jane')).toEqual(['https://medium.com/@jane']);
    expect(extractAnswerUrls('@janedoe on instagram')).toEqual([]);
    expect(extractAnswerUrls('@jane.design')).toEqual([]);
  });
  it.each([
    ['javascript:alert(1)'], ['javascript://x.com/%0Aalert(1)'], ['data:text/html;base64,PHNjcmlwdD4='], ['file:///etc/passwd'],
    ['ftp://x.com/a'], ['tel:+911234567890'], ['http://localhost:3000/x'], ['http://'], ['https://.'], ['https://www'],
  ])('never yields a non-web or hostless URL: %j', (t) => { expect(extractAnswerUrls(t)).toEqual([]); });

  it('handles markdown, angle brackets and parentheses around links', () => {
    expect(extractAnswerUrls('[my work](https://x.com/a) <https://y.com/b> (www.janedoe.com)')).toEqual([
      'https://x.com/a', 'https://y.com/b', 'https://www.janedoe.com',
    ]);
    expect(extractAnswerUrls('"https://a.com/x" and \'https://b.com/y\'')).toEqual(['https://a.com/x', 'https://b.com/y']);
  });
  it('splits links that were pasted back to back, and ones with text glued in front', () => {
    expect(extractAnswerUrls('https://a.comhttps://b.com/x')).toEqual(['https://a.com', 'https://b.com/x']);
    expect(extractAnswerUrls('https://a.com/xhttps://b.com/y')).toEqual(['https://a.com/x', 'https://b.com/y']);
    expect(extractAnswerUrls('Portfolio:https://x.com/a')).toEqual(['https://x.com/a']);
    expect(extractAnswerUrls('see:http://x.com/a,see:https://y.com/b')).toEqual(['http://x.com/a', 'https://y.com/b']);
  });
  it('ignores zero-width and soft-hyphen characters pasted into a link', () => {
    expect(extractAnswerUrls('https://x\u200b.com/a\u00adb')).toEqual(['https://x.com/ab']);
    expect(extractAnswerUrls('insta\u200bgram.com/jane')).toEqual(['https://instagram.com/jane']);
  });
  it('keeps query strings (tracking parameters are removed later, by classifyAnswerUrl)', () => {
    expect(extractAnswerUrls('https://youtu.be/dQw4w9WgXcQ?si=abc')).toEqual(['https://youtu.be/dQw4w9WgXcQ?si=abc']);
  });
  it('returns raw IP links (classifyAnswerUrl is what drops them) but not a bare IP', () => {
    expect(extractAnswerUrls('http://169.254.169.254/latest/meta-data')).toEqual(['http://169.254.169.254/latest/meta-data']);
    expect(extractAnswerUrls('192.168.1.1')).toEqual([]);
  });
  it('caps the result at 40 links', () => {
    const many = Array.from({ length: 120 }, (_, i) => `https://site${i}.com/p`).join(' ');
    const urls = extractAnswerUrls(many);
    expect(urls).toHaveLength(40);
    expect(urls[0]).toBe('https://site0.com/p');
    expect(urls[39]).toBe('https://site39.com/p');
  });
  it('ignores a single run of characters too long to be a URL, and still finds the next link', () => {
    expect(extractAnswerUrls(`https://x.com/${'a'.repeat(5000)} https://y.com/ok`)).toEqual(['https://y.com/ok']);
  });
  it('finds a link at the very end of a long answer (ordinary words do not use up the budget)', () => {
    const words = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' ');
    expect(extractAnswerUrls(`${words} https://x.com/end`)).toEqual(['https://x.com/end']);
  });
  it.each([[undefined], [null], [42], [{}], [''], ['   ']])('returns [] for empty or non-string input (%#)', (v) => {
    expect(extractAnswerUrls(v as unknown as string)).toEqual([]);
  });

  it.each([
    ['dots', () => '.'.repeat(100_000)],
    ['punctuation mix', () => '(!?,.;:'.repeat(15_000)],
    ['brackets', () => '[({<'.repeat(30_000)],
    ['dots and spaces', () => '. '.repeat(50_000)],
    ['dotted labels', () => 'a.'.repeat(50_000)],
    ['hyphens', () => '-'.repeat(100_000)],
    ['repeated scheme', () => 'http://'.repeat(15_000)],
    ['repeated scheme with hosts', () => 'http://a.com '.repeat(8_000)],
    ['long punctuation runs ending in a letter', () => ('....'.repeat(1000) + 'x ').repeat(20)],
    ['closing parens', () => `https://x.com/${')'.repeat(100_000)}`],
    ['long label', () => `${'a'.repeat(100_000)}.com`],
    ['at signs', () => '@'.repeat(100_000)],
  ])('a 100 KB hostile blob (%s) finishes quickly', (_name, make) => {
    const text = make();
    const { ms } = timed(() => extractAnswerUrls(text));
    expect(ms).toBeLessThan(200);
  });
  it('a hostile blob yields no links', () => {
    expect(extractAnswerUrls('(!?,.;:'.repeat(15_000))).toEqual([]);
    expect(extractAnswerUrls('. '.repeat(50_000))).toEqual([]);
  });
});

describe('classifyAnswerUrl', () => {
  const G = DRIVE_ID;
  it.each([
    [`https://drive.google.com/file/d/${G}/view?usp=sharing`, 'gdrive_file', 'document', `drive:${G}`],
    [`https://drive.google.com/file/u/0/d/${G}/view`, 'gdrive_file', 'document', `drive:${G}`],
    [`https://drive.google.com/open?id=${G}`, 'gdrive_file', 'document', `drive:${G}`],
    [`https://drive.google.com/uc?export=download&id=${G}`, 'gdrive_file', 'document', `drive:${G}`],
    [`https://drive.usercontent.google.com/download?id=${G}&export=download`, 'gdrive_file', 'document', `drive:${G}`],
    [`https://drive.google.com/drive/folders/${G}?usp=sharing`, 'gdrive_folder', 'document', `drive:${G}`],
    [`https://drive.google.com/drive/u/0/folders/${G}`, 'gdrive_folder', 'document', `drive:${G}`],
    [`https://drive.google.com/drive/mobile/folders/${G}`, 'gdrive_folder', 'document', `drive:${G}`],
    [`https://drive.google.com/folderview?id=${G}`, 'gdrive_folder', 'document', `drive:${G}`],
    [`https://docs.google.com/document/d/${G}/edit?usp=sharing`, 'google_doc', 'document', `drive:${G}`],
    [`https://docs.google.com/document/u/0/d/${G}/edit`, 'google_doc', 'document', `drive:${G}`],
    [`https://docs.google.com/presentation/d/${G}/edit#slide=id.p`, 'google_slides', 'document', `drive:${G}`],
    [`https://docs.google.com/spreadsheets/d/${G}/edit#gid=0`, 'google_sheet', 'document', `drive:${G}`],
    ['https://docs.google.com/document/d/e/2PACX-1vSabcdefghij/pub', 'google_doc', 'document', 'drive:2PACX-1vSabcdefghij'],
  ])('Google file/folder %s -> %s / %s', (url, platform, handler, key) => {
    expect(classifyAnswerUrl(url)).toMatchObject({ platform, handler, key });
  });
  it('the same Drive file reached through different links shares one key', () => {
    const keys = [`https://drive.google.com/file/d/${G}/view`, `https://drive.google.com/open?id=${G}`, `https://drive.google.com/uc?id=${G}&export=download`]
      .map(u => classifyAnswerUrl(u)?.key);
    expect(new Set(keys)).toEqual(new Set([`drive:${G}`]));
  });
  it.each([
    ['https://drive.google.com/file/d/abc/view'],                                  // id shorter than 10
    ['https://drive.google.com/open?id=abc.defghijklmno'],                         // character outside [A-Za-z0-9_-]
    ['https://drive.google.com/drive/my-drive'],                                   // no id at all
    ['https://drive.google.com/drive/folders/short'],
    ['https://docs.google.com/document/d/xyz/edit'],
    ['https://docs.google.com/drawings/d/1AbCdEfGhIjKlMnOp/edit'],                 // not a document type we read
  ])('a Drive/Docs link without a well-formed id is a plain site link: %s', (url) => {
    const c = classifyAnswerUrl(url);
    expect(c).toMatchObject({ platform: 'custom', handler: 'site' });
    expect(c?.key.startsWith('drive:')).toBe(false);
  });

  it.each([
    ['https://janedoe.com/files/Brand-Deck.PDF', 'pdf_file', 'document'],
    ['https://janedoe.com/deck.pdf?download=1', 'pdf_file', 'document'],
    ['https://dropbox.com/s/abc123/Deck.pdf?dl=0', 'pdf_file', 'document'],
    ['https://janedoe.com/a/cs.docx', 'docx_file', 'document'],
    ['https://janedoe.com/a/cs.doc', 'docx_file', 'document'],
    ['https://janedoe.com/a/cs.pptx', 'pptx_file', 'document'],
    ['https://janedoe.com/a/cs.ppt', 'pptx_file', 'document'],
    ['https://janedoe.com/a/hero.jpg', 'image_file', 'image'],
    ['https://janedoe.com/a/hero.jpeg', 'image_file', 'image'],
    ['https://janedoe.com/a/hero.png', 'image_file', 'image'],
    ['https://janedoe.com/a/hero.webp', 'image_file', 'image'],
    ['https://janedoe.com/a/hero.gif', 'image_file', 'image'],
    ['https://janedoe.com/a/reel.mp4', 'video_file', 'video'],
    ['https://janedoe.com/a/reel.mov', 'video_file', 'video'],
    ['https://janedoe.com/a/reel.webm', 'video_file', 'video'],
    ['https://janedoe.com/a/reel.mkv', 'video_file', 'video'],
    ['https://janedoe.com/a/hero.avif', 'custom', 'site'],
    ['https://janedoe.com/a/logo.svg', 'custom', 'site'],
    ['https://janedoe.com/view?file=a.pdf', 'custom', 'site'],                     // the extension is in the query, not the path
  ])('file by extension %s -> %s / %s', (url, platform, handler) => {
    expect(classifyAnswerUrl(url)).toMatchObject({ platform, handler });
  });

  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=shared&si=abc', 'yt:dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'yt:dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=zzz', 'yt:dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'yt:dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'yt:dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'yt:dQw4w9WgXcQ'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'yt:dQw4w9WgXcQ'],
    ['https://www.youtube.com/@JaneDoe', 'youtube.com/@janedoe'],
    ['https://www.youtube.com/channel/UCabcdefghijklmnop', 'youtube.com/channel/ucabcdefghijklmnop'],
    ['https://www.youtube.com/c/JaneDoe', 'youtube.com/c/janedoe'],
    ['https://www.youtube.com/user/janedoe', 'youtube.com/user/janedoe'],
    ['https://www.youtube.com/playlist?list=PLabc123', 'youtube.com/playlist?list=PLabc123'],
    ['https://www.youtube.com/watch?v=abc', 'youtube.com/watch?v=abc'],             // not an 11-character id
  ])('YouTube %s -> key %s', (url, key) => {
    expect(classifyAnswerUrl(url)).toMatchObject({ platform: 'youtube', handler: 'video', key });
  });
  it('two different playlists, and a playlist vs a channel, never share a key', () => {
    const k = ['https://youtube.com/playlist?list=PLaaa', 'https://youtube.com/playlist?list=PLbbb', 'https://youtube.com/@jane'].map(u => classifyAnswerUrl(u)?.key);
    expect(new Set(k).size).toBe(3);
  });
  it('YouTube urls come back without the si / feature-share tracking', () => {
    expect(classifyAnswerUrl('https://youtu.be/dQw4w9WgXcQ?si=zzz')?.url).toBe('https://youtu.be/dQw4w9WgXcQ');
  });
  it.each([
    ['https://vimeo.com/123456789', 'vimeo', 'vimeo:123456789'],
    ['https://player.vimeo.com/video/123456789', 'vimeo', 'vimeo:123456789'],
    ['https://vimeo.com/123456789/abcdef1234', 'vimeo', 'vimeo:123456789'],
    ['https://vimeo.com/janedoe', 'vimeo', 'vimeo.com/janedoe'],
    ['https://www.loom.com/share/0123456789abcdef0123456789abcdef', 'loom', 'loom:0123456789abcdef0123456789abcdef'],
    ['https://www.loom.com/embed/0123456789abcdef0123456789abcdef', 'loom', 'loom:0123456789abcdef0123456789abcdef'],
  ])('video host %s -> %s (key %s)', (url, platform, key) => {
    expect(classifyAnswerUrl(url)).toMatchObject({ platform, handler: 'video', key });
  });

  it.each([
    ['https://www.instagram.com/janedoe/', 'ig:janedoe'],
    ['https://instagram.com/Jane.Doe?igsh=xyz', 'ig:jane.doe'],
    ['https://www.instagram.com/janedoe/?utm_source=ig_web_button_share_sheet', 'ig:janedoe'],
    ['https://www.instagram.com/p/Cx12AbC_dE/?igsh=abc', 'ig:p/Cx12AbC_dE'],
    ['https://www.instagram.com/reel/Cx12AbC_dE/', 'ig:reel/Cx12AbC_dE'],
    ['https://instagr.am/janedoe', 'ig:janedoe'],
  ])('Instagram %s -> social, key %s', (url, key) => {
    expect(classifyAnswerUrl(url)).toMatchObject({ platform: 'instagram', handler: 'social', key });
  });
  it('Instagram urls come back without igsh / utm parameters', () => {
    expect(classifyAnswerUrl('https://www.instagram.com/janedoe/?igsh=abc&utm_source=qr')?.url).toBe('https://www.instagram.com/janedoe/');
  });

  it.each([
    ['https://www.linkedin.com/in/jane-doe/', 'linkedin', 'none'],
    ['https://in.linkedin.com/in/jane-doe', 'linkedin', 'none'],
    ['https://www.linkedin.com/company/acme', 'linkedin', 'none'],
    ['https://lnkd.in/abc123', 'linkedin', 'none'],                                 // handled as LinkedIn, not as a shortener
    ['https://www.facebook.com/janedoe', 'social_other', 'none'],
    ['https://fb.me/janedoe', 'social_other', 'none'],
    ['https://twitter.com/janedoe', 'social_other', 'none'],
    ['https://x.com/janedoe', 'social_other', 'none'],
    ['https://www.threads.net/@janedoe', 'social_other', 'none'],
    ['https://www.tiktok.com/@janedoe', 'social_other', 'none'],
    ['https://in.pinterest.com/janedoe', 'social_other', 'none'],
    ['https://www.snapchat.com/add/janedoe', 'social_other', 'none'],
    ['https://wetransfer.com/downloads/abc', 'cloud_file', 'none'],
    ['https://we.tl/t-AbC123', 'cloud_file', 'none'],                               // handled as WeTransfer, not as a shortener
    ['https://www.dropbox.com/scl/fi/abc/folder?rlkey=x&dl=0', 'cloud_file', 'document'],
    ['https://onedrive.live.com/?id=ABC', 'cloud_file', 'document'],
    ['https://acme-my.sharepoint.com/:b:/g/personal/jane/abc', 'cloud_file', 'document'],
  ])('%s -> %s / %s', (url, platform, handler) => {
    expect(classifyAnswerUrl(url)).toMatchObject({ platform, handler });
  });

  it.each([
    'https://linktr.ee/janedoe', 'https://bio.link/janedoe', 'https://beacons.ai/janedoe', 'https://linkin.bio/janedoe',
    'https://lnk.bio/janedoe', 'https://campsite.bio/janedoe',
    'https://bit.ly/3xYzAb', 'https://t.co/AbCdEf', 'https://tinyurl.com/abc123', 'https://rb.gy/abc123', 'https://ow.ly/AbCd',
    'https://buff.ly/3abc', 'https://goo.gl/AbCdEf', 'https://photos.app.goo.gl/AbCdEf', 'https://1drv.ms/b/s!AbCdEf',
  ])('link hub or shortener %s is resolved by the worker', (url) => {
    expect(classifyAnswerUrl(url)).toMatchObject({ platform: 'link_hub', handler: 'resolve' });
  });

  it.each([
    ['https://www.behance.net/janedoe', 'behance'],
    ['https://dribbble.com/janedoe', 'dribbble'],
    ['https://www.canva.com/design/DAFabc123/view', 'canva'],
    ['https://canva.link/abc123', 'canva'],
    ['https://jane.my.canva.site/portfolio', 'canva'],
    ['https://www.notion.so/Portfolio-abc123', 'notion'],
    ['https://jane.notion.site/Work-123', 'notion'],
    ['https://medium.com/@janedoe/my-story-abc', 'medium'],
    ['https://jane.medium.com', 'medium'],
    ['https://janedoe.substack.com', 'medium'],
    ['https://www.figma.com/proto/AbC/flow?node-id=1-2', 'figma_file'],
    ['https://jane.figma.site', 'figma_site'],
    ['https://jane.framer.website', 'framer'],
    ['https://jane.webflow.io', 'webflow'],
    ['https://jane.wixsite.com/portfolio', 'wix'],
    ['https://jane.myportfolio.com', 'adobe_portfolio'],
    ['https://janedoe.design', 'custom'],
    ['https://www.janedoe.com/work', 'custom'],
    ['https://sites.google.com/view/jane', 'custom'],
    ['https://github.com/janedoe', 'custom'],
  ])('%s opens as a site (%s)', (url, platform) => {
    expect(classifyAnswerUrl(url)).toMatchObject({ platform, handler: 'site' });
  });

  it.each([
    [''], ['mailto:a@b.com'], ['tel:+911234567890'], ['javascript:alert(1)'], ['data:text/html,x'], ['file:///etc/passwd'], ['not a url'],
    ['https://forms.gle/abc123'], ['https://docs.google.com/forms/d/e/abc/viewform'], ['https://forms.google.com/x'],
    ['https://goo.gl/forms/abc123'], ['https://calendly.com/jane/30min'], ['https://zoom.us/j/123456'], ['https://us02web.zoom.us/j/123456'],
    ['https://wa.me/919999999999'], ['https://api.whatsapp.com/send?phone=919999999999'], ['https://chat.whatsapp.com/abc'],
    ['https://t.me/janedoe'], ['https://telegram.me/janedoe'],
    ['https://maps.google.com/?q=Mumbai'], ['https://www.google.com/maps/place/Mumbai'], ['https://maps.app.goo.gl/abc123'], ['https://goo.gl/maps/abc123'],
    ['https://digitalpaani.com/careers'], ['https://www.digitalpaani.com'], ['https://careers.digitalpaani.com/x'],
    ['https://www.google.com/search?q=jane'], ['https://meet.google.com/abc-defg-hij'], ['https://calendar.google.com/x'],
    ['http://127.0.0.1/x'], ['http://169.254.169.254/latest/meta-data'], ['http://10.0.0.5/a'], ['http://2130706433/x'],
    ['https://user:pass@janedoe.design/work'], ['https://instagram.com@evil.example.com/x'], ['https://intranet.local/x'], ['https://x.internal/x'],
  ])('drops %j (not a work sample)', (url) => { expect(classifyAnswerUrl(url)).toBeNull(); });
  it('returns null for non-string input', () => {
    expect(classifyAnswerUrl(undefined as unknown as string)).toBeNull();
    expect(classifyAnswerUrl(7 as unknown as string)).toBeNull();
  });
  it('returns null, quickly, for a link far longer than any real one', () => {
    const { result, ms } = timed(() => classifyAnswerUrl(`https://janedoe.design/${'a'.repeat(100_000)}`));
    expect(result).toBeNull();
    expect(ms).toBeLessThan(200);
  });

  it('strips utm_*, fbclid, gclid, si and igsh from the url and keeps every other parameter', () => {
    const c = classifyAnswerUrl('https://janedoe.design/work?utm_source=ig&utm_medium=bio&ref=1&fbclid=xx&si=1&igsh=a&gclid=g&node-id=1-2');
    expect(c?.url).toBe('https://janedoe.design/work?ref=1&node-id=1-2');
    expect(classifyAnswerUrl('https://janedoe.design/work?utm_source=ig&fbclid=xx')?.url).toBe('https://janedoe.design/work');
    expect(classifyAnswerUrl('https://janedoe.design/?utm_source=ig')?.url).toBe('https://janedoe.design');
  });
  it('the host is reported without "www." and lower-cased', () => {
    expect(classifyAnswerUrl('https://WWW.JaneDoe.Design/Work')).toMatchObject({ host: 'janedoe.design', url: 'https://www.janedoe.design/Work' });
  });
  it('http / https / www / trailing slash / tracking / host case all collapse to one key', () => {
    const keys = [
      'http://www.janedoe.design/work/', 'https://janedoe.design/work?utm_source=x&fbclid=y', 'https://JANEDOE.design/work', 'janedoe.design/work',
    ].map(u => classifyAnswerUrl(u)?.key);
    expect(new Set(keys).size).toBe(1);
  });
  it('different paths on one host have different keys', () => {
    expect(classifyAnswerUrl('https://janedoe.design/a')?.key).not.toBe(classifyAnswerUrl('https://janedoe.design/b')?.key);
  });
  it('accepts the scheme-less form extractAnswerUrls would also have normalised', () => {
    expect(classifyAnswerUrl('instagram.com/janedoe')).toMatchObject({ platform: 'instagram', url: 'https://instagram.com/janedoe' });
  });
});

describe('pickAnswerLinks', () => {
  const pick = (answer: string, ctx?: { candidateName?: string }, question = Q1) => pickAnswerLinks(answerOf(answer, question), ctx);
  const NOT_ANSWERED = { answered: false, textOnly: false, claimText: '', links: [], listedNotReviewed: [] };

  it.each([[Q1], [Q2]])('reads a link answer under either live wording (%#)', (q) => {
    const p = pick('https://janedoe.design and instagram.com/janedoe', undefined, q);
    expect(p.answered).toBe(true);
    expect(p.textOnly).toBe(false);
    expect(p.links.map(l => l.platform)).toEqual(['custom', 'instagram']);
  });
  it('finds the answer wherever it sits in the screening list', () => {
    const screening = [{ question: Q1, answer: 'https://janedoe.design' }, { question: 'Notice period', answer: '30 days' }];
    expect(pickAnswerLinks(screening).links).toHaveLength(1);
    expect(pickAnswerLinks([...screening].reverse()).links).toHaveLength(1);
  });
  it.each([[null], [undefined], [[]], ['x'], [42], [{}], [[{ question: 'Notice period', answer: '30 days' }]], [[null, 1, 'x', [], {}]]])(
    'no answer at all (%#) -> not answered, nothing listed', (v) => {
      expect(pickAnswerLinks(v)).toEqual(NOT_ANSWERED);
    });
  it.each([
    [''], ['   '], ['-'], ['.'], ['N/A'], ['n/a'], ['NA'], ['None'], ['nil'], ['No'], ['Nope'], ['NDA'], ['Under NDA'], ['All work is under NDA'],
    ['All my work is under NDA, will share on request'], ['Will share on request'], ['Available on request'], ['Confidential'],
    ['Hi'], ['Yes'], ['see resume'], ['ok thanks'],
  ])('blank / non-answer %j -> not answered, no claim text', (a) => {
    expect(pick(a)).toEqual(NOT_ANSWERED);
  });
  it('an answer under 12 letters or digits and no link is not an answer', () => {
    expect(pick('Check resume').answered).toBe(false);          // 11
    expect(pick('Check my resume').answered).toBe(true);        // 13 (words, so described but unverified)
  });

  it('words without a link are "text only": answered, never reviewed, claim kept', () => {
    const p = pick('I ran brand campaigns for three startups\nand led a team of four.');
    expect(p).toEqual({
      answered: true, textOnly: true,
      claimText: 'I ran brand campaigns for three startups\nand led a team of four.',   // the line break is kept ([2.9])
      links: [], listedNotReviewed: [],
    });
  });
  it('text only is judged on the candidate\'s own words, not on a link that was dropped', () => {
    expect(pick('https://calendly.com/jane/30min')).toEqual(NOT_ANSWERED);
    expect(pick('https://forms.gle/abc123 N/A')).toEqual(NOT_ANSWERED);
    const p = pick('Book me: https://calendly.com/jane/30min — I ran brand campaigns for three startups');
    expect(p.textOnly).toBe(true);
    expect(p.answered).toBe(true);
    expect(p.links).toEqual([]);
  });
  it('an answer with a link is never "text only", even next to "N/A" and with a long description', () => {
    expect(pick('N/A https://janedoe.design').textOnly).toBe(false);
    const p = pick(`${'I ran brand campaigns for startups. '.repeat(10)} https://janedoe.design`);
    expect(p.answered).toBe(true);
    expect(p.textOnly).toBe(false);
  });
  it('claimText collapses runs of spaces but keeps line breaks, is capped at 1500 characters (ending in "…" when cut) and is always the whole answer for a link answer', () => {
    const p = pick(`  Portfolio:\n\n   https://janedoe.design \t and   more  `);
    expect(p.claimText).toBe('Portfolio:\n\nhttps://janedoe.design and more');
    const long = pick(`${'brand '.repeat(1000)}https://janedoe.design`);
    expect(long.claimText.length).toBeLessThanOrEqual(1500);
    expect(long.claimText.length).toBeGreaterThan(1490);
    expect(long.claimText.endsWith('…')).toBe(true);
    expect(long.claimText).toBe(long.claimText.trim());
    expect(long.links).toHaveLength(1);                                   // the cap is on the stored text, not on link finding
  });
  it('claimText never ends in half an emoji and never contains a NUL (Postgres jsonb rejects both)', () => {
    const p = pick(`${'a'.repeat(1499)}😀 and some more words after it`);
    expect(p.claimText).toBe(`${'a'.repeat(1499)}…`);      // cut at 1499 (the emoji does not fit), then the ellipsis: 1500 in all
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(p.claimText)).toBe(false);
    const nul = pick('I ran\u0000 brand campaigns for\u0001 startups and brands');
    expect(nul.claimText).toBe('I ran brand campaigns for startups and brands');
  });

  it('11 links: caps, rank order, and what is listed as not opened', () => {
    const lines = [
      'https://www.linkedin.com/in/jane-doe',                          // 0  never opened
      'https://instagram.com/janedoe',                                 // 1  social
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',                   // 2  video
      'https://vimeo.com/123456789',                                   // 3  video
      'https://janedoe.design',                                        // 4  site
      'https://www.behance.net/janedoe',                               // 5  site
      'https://www.canva.com/design/DAFabc/view',                      // 6  site, cut: only 2 sites
      'https://drive.google.com/file/d/AAAAAAAAAA01/view',             // 7  document
      'https://drive.google.com/file/d/AAAAAAAAAA02/view',             // 8  document
      'https://docs.google.com/presentation/d/AAAAAAAAAA03/edit',      // 9  document
      'https://drive.google.com/drive/folders/AAAAAAAAAA04',           // 10 document, cut: only 3 documents
    ];
    const p = pick(lines.join('\n'));
    expect(p.answered).toBe(true);
    expect(p.links).toHaveLength(8);
    expect(p.links.map(l => l.platform)).toEqual([
      'gdrive_file', 'gdrive_file', 'google_slides',     // documents first, in the candidate's order
      'custom', 'behance',                               // then sites
      'youtube', 'vimeo',                                // then video
      'instagram',                                       // then Instagram
    ]);
    expect(p.links.map(l => l.handler)).toEqual(['document', 'document', 'document', 'site', 'site', 'video', 'video', 'social']);
    expect(p.listedNotReviewed.map(l => [l.platform, l.reason])).toEqual([
      ['linkedin', 'LinkedIn blocks automated viewing - open it by hand'],      // listed in the candidate's own order
      ['canva', 'only the top 2 links of each kind are opened'],
      ['gdrive_folder', 'only the top 3 links of each kind are opened'],
    ]);
  });
  it('the total cap of 8 cuts the lowest-ranked links, and says so', () => {
    const p = pick([
      'bit.ly/3xYzAb', 'linktr.ee/janedoe', 'janedoe.design', 'behance.net/janedoe',
      `drive.google.com/file/d/${DRIVE_ID}/view`, 'drive.google.com/file/d/BBBBBBBBBB02/view', 'drive.google.com/file/d/CCCCCCCCCC03/view',
      'youtube.com/watch?v=dQw4w9WgXcQ', 'vimeo.com/123456789', 'instagram.com/janedoe',
    ].join(' '));
    expect(p.links).toHaveLength(8);
    expect(p.links.map(l => l.platform)).toEqual([
      'gdrive_file', 'gdrive_file', 'gdrive_file',
      'link_hub', 'link_hub', 'custom', 'behance',        // websites and still-to-resolve links share a rank, in the candidate's order
      'youtube',
    ]);
    expect(p.listedNotReviewed).toEqual([
      { url: 'https://vimeo.com/123456789', platform: 'vimeo', reason: 'only the top 8 links are opened' },
      { url: 'https://instagram.com/janedoe', platform: 'instagram', reason: 'only the top 8 links are opened' },
    ]);
  });
  it('within a rank the candidate\'s own order is kept (stable), and ranks never interleave', () => {
    const p = pick('youtube.com/@jane abc.design instagram.com/jane drive.google.com/file/d/AAAAAAAAAA01/view xyz.studio vimeo.com/123456789');
    expect(p.links.map(l => l.host)).toEqual(['drive.google.com', 'abc.design', 'xyz.studio', 'youtube.com', 'vimeo.com', 'instagram.com']);
    expect(pick('xyz.studio abc.design').links.map(l => l.host)).toEqual(['xyz.studio', 'abc.design']);
    expect(pick('abc.design xyz.studio').links.map(l => l.host)).toEqual(['abc.design', 'xyz.studio']);
  });
  it.each([
    ['sites', 'alpha.design bravo.design charlie.design delta.design', ['alpha.design', 'bravo.design'], 2],
    ['documents', 'brandx.com/a.pdf acme.com/b.pptx corp.io/c.docx drive.google.com/file/d/AAAAAAAAAA01/view', ['brandx.com', 'acme.com', 'corp.io'], 3],
    ['videos', 'youtube.com/@jane vimeo.com/123456789 loom.com/share/0123456789abcdef', ['youtube.com', 'vimeo.com'], 2],
    ['link hubs and shorteners', 'bit.ly/aaaa linktr.ee/jane rb.gy/cccc tinyurl.com/dddd', ['bit.ly', 'linktr.ee'], 2],
  ])('cap on %s: only the first %i of each kind are opened and the rest are listed with the cap', (_kind, answer, openedHosts, cap) => {
    const p = pick(answer);
    expect(p.links.map(l => l.host)).toEqual(openedHosts);
    expect(p.listedNotReviewed.length).toBeGreaterThan(0);
    for (const l of p.listedNotReviewed) expect(l.reason).toBe(`only the top ${cap} links of each kind are opened`);
  });
  it('images share the document slots (3 together)', () => {
    const p = pick('brandx.com/a.png acme.com/b.jpg drive.google.com/file/d/AAAAAAAAAA01/view janedoe.com/c.pdf');
    expect(p.links.map(l => l.platform)).toEqual(['image_file', 'image_file', 'gdrive_file']);
    expect(p.listedNotReviewed.map(l => l.platform)).toEqual(['pdf_file']);
  });

  describe('per-host rules', () => {
    it('one Instagram link, listing the rest', () => {
      const p = pick('instagram.com/janedoe instagram.com/p/Cx12AbC_dE instagram.com/reel/Dy98ZyX_wV');
      expect(p.links.map(l => l.url)).toEqual(['https://instagram.com/janedoe']);
      expect(p.listedNotReviewed.map(l => l.reason)).toEqual(['only 1 link per website is opened', 'only 1 link per website is opened']);
    });
    it('one link per own website, whatever the path', () => {
      const p = pick('janedoe.design/work janedoe.design/about https://www.janedoe.design/contact');
      expect(p.links.map(l => l.url)).toEqual(['https://janedoe.design/work']);
      expect(p.listedNotReviewed).toHaveLength(2);
    });
    it('two on Behance, Dribbble and Notion; the third is listed', () => {
      for (const [host, platform] of [['behance.net', 'behance'], ['dribbble.com', 'dribbble'], ['www.notion.so', 'notion']] as const) {
        const p = pick(`${host}/a ${host}/b ${host}/c`);
        expect(p.links.map(l => l.platform), host).toEqual([platform, platform]);
        expect(p.listedNotReviewed.map(l => l.reason), host).toEqual(['only 2 links per website are opened']);
      }
    });
    it('three on Drive (one host), and Drive and Docs are counted separately', () => {
      const p = pick(`drive.google.com/file/d/AAAAAAAAAA01/view drive.google.com/file/d/AAAAAAAAAA02/view drive.google.com/file/d/AAAAAAAAAA03/view docs.google.com/document/d/AAAAAAAAAA04/edit`);
      expect(p.links.map(l => l.url)).toEqual([
        'https://drive.google.com/file/d/AAAAAAAAAA01/view', 'https://drive.google.com/file/d/AAAAAAAAAA02/view', 'https://drive.google.com/file/d/AAAAAAAAAA03/view',
      ]);
      // the fourth is held back by the 3-documents cap, not the per-host rule
      expect(p.listedNotReviewed.map(l => l.reason)).toEqual(['only the top 3 links of each kind are opened']);
    });
    it('youtube.com, youtu.be and m.youtube.com are one website', () => {
      const p = pick('youtu.be/dQw4w9WgXcQ m.youtube.com/watch?v=aaaaaaaaaaa youtube.com/@jane vimeo.com/123456789');
      expect(p.links.map(l => l.platform)).toEqual(['youtube', 'vimeo']);
      expect(p.listedNotReviewed.map(l => l.reason)).toEqual(['only 1 link per website is opened', 'only 1 link per website is opened']);
    });
    it('a link cut by the per-host rule does not use up one of its kind\'s slots', () => {
      const p = pick('alpha.design/a alpha.design/b bravo.design charlie.design');
      expect(p.links.map(l => l.url)).toEqual(['https://alpha.design/a', 'https://bravo.design']);
      expect(p.listedNotReviewed).toEqual([
        { url: 'https://alpha.design/b', platform: 'custom', reason: 'only 1 link per website is opened' },
        { url: 'https://charlie.design', platform: 'custom', reason: 'only the top 2 links of each kind are opened' },
      ]);
    });
    it('the host rule counts a website and a file on it together (one address per host, the document first)', () => {
      const p = pick('janedoe.com janedoe.com/files/deck.pdf');
      expect(p.links.map(l => l.url)).toEqual(['https://janedoe.com/files/deck.pdf']);
      expect(p.listedNotReviewed).toEqual([{ url: 'https://janedoe.com', platform: 'custom', reason: 'only 1 link per website is opened' }]);
    });
  });

  describe('links that are never opened', () => {
    it('LinkedIn only: no links, one listed entry, answered but not text-only', () => {
      const p = pick('https://www.linkedin.com/in/jane-doe-1a2b3c');
      expect(p.answered).toBe(true);
      expect(p.textOnly).toBe(false);
      expect(p.links).toEqual([]);
      expect(p.listedNotReviewed).toEqual([{
        url: 'https://www.linkedin.com/in/jane-doe-1a2b3c', platform: 'linkedin',
        reason: 'LinkedIn blocks automated viewing - open it by hand',
      }]);
    });
    it('notes whether the /in/ address resembles the candidate\'s name', () => {
      expect(pick('linkedin.com/in/jane-doe-1a2b3c', { candidateName: 'Jane Doe' }).listedNotReviewed[0].reason)
        .toBe("LinkedIn blocks automated viewing - open it by hand (profile address looks like the candidate's name)");
      expect(pick('linkedin.com/in/randomhandle99', { candidateName: 'Jane Doe' }).listedNotReviewed[0].reason)
        .toBe("LinkedIn blocks automated viewing - open it by hand (profile address does not resemble the candidate's name)");
      expect(pick('https://in.linkedin.com/in/Mohit%2DJoshi/', { candidateName: 'Mohit Joshi' }).listedNotReviewed[0].reason).toContain('looks like');
    });
    it('says nothing about the name when it cannot tell', () => {
      const base = 'LinkedIn blocks automated viewing - open it by hand';
      expect(pick('linkedin.com/in/jane-doe').listedNotReviewed[0].reason).toBe(base);                                   // no name given
      expect(pick('linkedin.com/in/jane-doe', { candidateName: '' }).listedNotReviewed[0].reason).toBe(base);
      expect(pick('linkedin.com/in/jane-doe', { candidateName: 'Raj Roy' }).listedNotReviewed[0].reason).toBe(base);      // no name token of 4+ letters
      expect(pick('linkedin.com/in/jane-doe', { candidateName: 'Kumar Singh' }).listedNotReviewed[0].reason).toBe(base);  // only very common surnames
      expect(pick('linkedin.com/company/acme', { candidateName: 'Jane Doe' }).listedNotReviewed[0].reason).toBe(base);     // not a /in/ profile
      expect(pick('linkedin.com/in/jane-doe', { candidateName: 42 as unknown as string }).listedNotReviewed[0].reason).toBe(base);
    });
    it('WeTransfer and other social links are listed with their own reason and never take a slot', () => {
      const p = pick('janedoe.design wetransfer.com/downloads/abc we.tl/t-AbC123 facebook.com/janedoe x.com/janedoe tiktok.com/@janedoe');
      expect(p.links.map(l => l.platform)).toEqual(['custom']);
      expect(p.listedNotReviewed.map(l => [l.platform, l.reason])).toEqual([
        ['cloud_file', 'expiring file-transfer link'],
        ['cloud_file', 'expiring file-transfer link'],
        ['social_other', 'social media link not opened automatically'],
        ['social_other', 'social media link not opened automatically'],
        ['social_other', 'social media link not opened automatically'],
      ]);
    });
    it('"none" links are not counted against any cap', () => {
      const urls = Array.from({ length: 12 }, (_, i) => `https://www.linkedin.com/in/person-${i}`).join(' ');
      const p = pick(`${urls} janedoe.design`);
      expect(p.links.map(l => l.platform)).toEqual(['custom']);
      expect(p.listedNotReviewed).toHaveLength(12);
    });
  });

  describe('shorteners and link-in-bio hubs', () => {
    it('are picked with the "resolve" handler for the worker to expand', () => {
      const p = pick('bit.ly/3xYzAb linktr.ee/janedoe');
      expect(p.links).toEqual([
        { url: 'https://bit.ly/3xYzAb', host: 'bit.ly', platform: 'link_hub', handler: 'resolve' },
        { url: 'https://linktr.ee/janedoe', host: 'linktr.ee', platform: 'link_hub', handler: 'resolve' },
      ]);
    });
    it('at most 2 are expanded', () => {
      const p = pick('bit.ly/aaaa linktr.ee/jane beacons.ai/jane');
      expect(p.links).toHaveLength(2);
      expect(p.listedNotReviewed).toEqual([{ url: 'https://beacons.ai/jane', platform: 'link_hub', reason: 'only the top 2 links of each kind are opened' }]);
    });
  });

  describe('de-duplication and clean-up', () => {
    it('http, https, www and a trailing slash are one link', () => {
      const p = pick('http://janedoe.design/work https://janedoe.design/work/ https://www.janedoe.design/work');
      expect(p.links).toHaveLength(1);
      expect(p.listedNotReviewed).toEqual([]);
    });
    it('tracking parameters are dropped and do not make a new link', () => {
      const p = pick('https://instagram.com/janedoe?igsh=abc https://instagram.com/janedoe/?utm_source=bio janedoe.design/work?utm_source=ig&fbclid=x');
      expect(p.links.map(l => l.url)).toEqual(['https://janedoe.design/work', 'https://instagram.com/janedoe']);   // the site ranks above Instagram
      expect(p.listedNotReviewed).toEqual([]);
    });
    it('the same video through youtu.be and youtube.com/watch is one link', () => {
      const p = pick('https://youtu.be/dQw4w9WgXcQ?si=abc https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(p.links).toHaveLength(1);
      expect(p.listedNotReviewed).toEqual([]);
    });
    it('the same Drive file through two link styles is one link', () => {
      const p = pick(`drive.google.com/file/d/${DRIVE_ID}/view drive.google.com/open?id=${DRIVE_ID} docs.google.com/document/d/${DRIVE_ID}/edit`);
      expect(p.links).toHaveLength(1);
    });
    it('scheme-less Instagram, YouTube and Drive links are found and classified', () => {
      const p = pick(`instagram.com/janedoe, youtube.com/@janedoe, drive.google.com/drive/folders/${DRIVE_ID}`);
      expect(p.links.map(l => [l.platform, l.handler])).toEqual([['gdrive_folder', 'document'], ['youtube', 'video'], ['instagram', 'social']]);
    });
    it('drops boilerplate links (calendar, forms, the company site) without listing them', () => {
      const p = pick('janedoe.design https://calendly.com/jane https://forms.gle/abc123 https://www.digitalpaani.com/careers');
      expect(p.links).toHaveLength(1);
      expect(p.listedNotReviewed).toEqual([]);
    });
    it.each([
      ['javascript:alert(document.domain)'], ['http://169.254.169.254/latest/meta-data'], ['http://10.0.0.5/a'], ['http://localhost.localdomain:8080/x'],
      ['https://user:pw@evil.example.com/x'], ['data:text/html;base64,PHNjcmlwdD4='], ['file:///etc/passwd'],
    ])('never opens or lists %j', (hostile) => {
      const p = pick(hostile);
      expect(p.links).toEqual([]);
      expect(p.listedNotReviewed).toEqual([]);
      expect(p.textOnly || !p.answered).toBe(true);
    });
    it('a hostile link next to a real one leaves only the real one', () => {
      const p = pick('http://169.254.169.254/latest/meta-data janedoe.design https://user:pw@evil.example.com/x');
      expect(p.links.map(l => l.url)).toEqual(['https://janedoe.design']);
      expect(p.listedNotReviewed).toEqual([]);
    });
  });

  it('a realistic messy answer', () => {
    const p = pick([
      'Portfolio - www.janedoe.com',
      'Instagram: instagram.com/jane_brand',
      `Case studies: https://drive.google.com/drive/folders/${DRIVE_ID}?usp=sharing, linkedin.com/in/jane-doe, e.g. brand campaigns etc.`,
      'Reach me at jane@gmail.com',
    ].join('\n'), { candidateName: 'Jane Doe' });
    expect(p.answered).toBe(true);
    expect(p.links.map(l => l.platform)).toEqual(['gdrive_folder', 'custom', 'instagram']);
    expect(p.listedNotReviewed).toHaveLength(1);
    expect(p.listedNotReviewed[0].platform).toBe('linkedin');
  });

  it('link objects carry exactly url, host, platform and handler', () => {
    const [l] = pick('https://www.janedoe.design/work').links;
    expect(Object.keys(l).sort()).toEqual(['handler', 'host', 'platform', 'url']);
    expect(l).toEqual({ url: 'https://www.janedoe.design/work', host: 'janedoe.design', platform: 'custom', handler: 'site' });
  });
  it('does not mutate its input', () => {
    const screening = Object.freeze([Object.freeze({ question: Q1, answer: 'https://janedoe.design instagram.com/jane' })]);
    expect(() => pickAnswerLinks(screening, Object.freeze({ candidateName: 'Jane Doe' }))).not.toThrow();
    expect(screening[0].answer).toBe('https://janedoe.design instagram.com/jane');
  });
  it('is deterministic', () => {
    const a = pick('janedoe.design instagram.com/jane drive.google.com/file/d/AAAAAAAAAA01/view');
    expect(pick('janedoe.design instagram.com/jane drive.google.com/file/d/AAAAAAAAAA01/view')).toEqual(a);
  });
  it('tolerates a missing or odd context', () => {
    expect(() => pickAnswerLinks(answerOf('linkedin.com/in/jane'), undefined)).not.toThrow();
    expect(() => pickAnswerLinks(answerOf('linkedin.com/in/jane'), null as unknown as { candidateName?: string })).not.toThrow();
    expect(() => pickAnswerLinks(answerOf('linkedin.com/in/jane'), {})).not.toThrow();
  });
  it('a hostile 100 KB answer is "not answered" and quick', () => {
    for (const blob of ['(!?,.;:'.repeat(15_000), '. '.repeat(50_000), '-'.repeat(100_000)]) {
      const { result, ms } = timed(() => pick(blob));
      expect(result).toEqual(NOT_ANSWERED);
      expect(ms).toBeLessThan(200);
    }
  });
  it('a 1 MB answer is cut, still finds the links at its start, and keeps the claim short', () => {
    const { result, ms } = timed(() => pick(`https://janedoe.design instagram.com/jane ${'I ran brand campaigns. '.repeat(50_000)}`));
    expect(result.links.map(l => l.platform)).toEqual(['custom', 'instagram']);
    expect(result.claimText.length).toBeLessThanOrEqual(1500);
    expect(ms).toBeLessThan(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// [3.4] Links wrapped in emphasis, or followed by an emoji or an ellipsis
// ═════════════════════════════════════════════════════════════════════════════
describe('links wrapped in WhatsApp / markdown emphasis, or followed by an emoji or an ellipsis', () => {
  const pickOne = (answer: string) => pickAnswerLinks(answerOf(answer));

  // The six from the review, end to end: a valid link used to read as "text only" (not scored) or as a dead address.
  it.each([
    ['**https://janedoe.design**', 'https://janedoe.design'],
    ['_https://janedoe.design_', 'https://janedoe.design'],
    ['https://janedoe.design👈', 'https://janedoe.design'],
    ['https://janedoe.design/work…', 'https://janedoe.design/work'],
    ['(https://janedoe.design)', 'https://janedoe.design'],
    ['see https://janedoe.design/work, then ...', 'https://janedoe.design/work'],
  ])('%j is the link %s, answered and not text-only', (answer, url) => {
    const p = pickOne(answer);
    expect(p.answered).toBe(true);
    expect(p.textOnly).toBe(false);
    expect(p.links.map(l => l.url)).toEqual([url]);
    expect(extractAnswerUrls(answer)).toEqual([url]);
  });

  it.each([
    ['*https://janedoe.design*'], ['~https://janedoe.design~'], ['`https://janedoe.design`'], ['__https://janedoe.design__'],
    ['*_https://janedoe.design_*'], ['<https://janedoe.design>'], ['"https://janedoe.design"'], ["'https://janedoe.design'"],
    ['[https://janedoe.design]'], ['{https://janedoe.design}'],
  ])('emphasis or a wrapper around the whole link: %s', (answer) => {
    expect(extractAnswerUrls(answer)).toEqual(['https://janedoe.design']);
  });

  it.each([
    ['https://janedoe.design/work...'], ['https://janedoe.design/work…'], ['https://janedoe.design/work. . .'], ['https://janedoe.design/work…!'],
    ['https://janedoe.design/work🔥'], ['https://janedoe.design/work🔥🔥🔥'], ['https://janedoe.design/work👍🏽'], ['https://janedoe.design/work❤️'],
    ['https://janedoe.design/work✨'], ['https://janedoe.design/work™'], ['https://janedoe.design/work©'], ['https://janedoe.design/work.👈'],
    ['https://janedoe.design/work)👈'], ['https://janedoe.design/work*👈*'], ['https://janedoe.design/work 👈'], ['https://janedoe.design/work.🙂!'],
  ])('trailing ellipsis, emoji and symbols are not part of the address: %s', (answer) => {
    expect(extractAnswerUrls(answer)).toEqual(['https://janedoe.design/work']);
  });

  it('the same applies to a scheme-less link', () => {
    expect(extractAnswerUrls('instagram.com/janedoe👈')).toEqual(['https://instagram.com/janedoe']);
    expect(extractAnswerUrls('janedoe.design/work…')).toEqual(['https://janedoe.design/work']);
    expect(extractAnswerUrls('*instagram.com/janedoe*')).toEqual(['https://instagram.com/janedoe']);
  });

  it('a bracket that belongs to the address is kept, one that does not is stripped', () => {
    expect(extractAnswerUrls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(extractAnswerUrls('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(extractAnswerUrls('https://en.wikipedia.org/wiki/Foo_(bar)👈')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(extractAnswerUrls('[my work](https://x.com/a)')).toEqual(['https://x.com/a']);
    expect(extractAnswerUrls('https://x.com/a))')).toEqual(['https://x.com/a']);
  });

  it('a symbol or emoji in the middle of an address ends the address there: it used to be percent-encoded into a URL that 404s', () => {
    // No real address contains one; a link with one in it is a link followed by decoration. (Letters, marks and digits of any
    // script stay: see answerLinks.heldout.test.ts for a Hindi path and a Devanagari domain.)
    expect(extractAnswerUrls('https://janedoe.design/work✨2023/x')).toEqual(['https://janedoe.design/work']);
  });

  it('a link that is nothing but decoration after the scheme is no link', () => {
    expect(extractAnswerUrls('https://👈')).toEqual([]);
    expect(extractAnswerUrls('**https://**')).toEqual([]);
  });

  describe('commas, pipes and apostrophes inside an address', () => {
    it.each([
      ['https://janedoe.design/work,2023/x', 'https://janedoe.design/work,2023/x'],
      ["https://janedoe.design/it's-work", "https://janedoe.design/it's-work"],
      ['https://janedoe.design/a|b', 'https://janedoe.design/a|b'],
      ['https://janedoe.design/a,b,c', 'https://janedoe.design/a,b,c'],
      ['(https://janedoe.design/a,b)', 'https://janedoe.design/a,b'],
    ])('%j stays whole', (answer, url) => {
      expect(extractAnswerUrls(answer)).toEqual([url]);
    });

    it.each([
      ['https://janedoe.design/work, then more'],
      ['https://janedoe.design/work,\nthen more'],
      ['https://janedoe.design/work| then more'],
      ["https://janedoe.design/work' then more"],
      ['https://janedoe.design/work, '],
      ['https://janedoe.design/work,'],
    ])('followed by whitespace the mark is only punctuation: %j', (answer) => {
      expect(extractAnswerUrls(answer)).toEqual(['https://janedoe.design/work']);
    });

    it.each([
      ['https://a.com/x,https://b.com/y', ['https://a.com/x', 'https://b.com/y']],
      ['https://a.com/x|https://b.com/y', ['https://a.com/x', 'https://b.com/y']],
      ["https://a.com/x'https://b.com/y", ['https://a.com/x', 'https://b.com/y']],
      ['https://a.com,instagram.com/jane', ['https://a.com', 'https://instagram.com/jane']],
      ['https://a.com/x,www.b-brand.in/y', ['https://a.com/x', 'https://www.b-brand.in/y']],
      ['https://a.com/x,drive.google.com/file/d/AAAAAAAAAA01/view', ['https://a.com/x', 'https://drive.google.com/file/d/AAAAAAAAAA01/view']],
      ["'https://a.com/x','https://b.com/y'", ['https://a.com/x', 'https://b.com/y']],
      ['see:http://x.com/a,see:https://y.com/b', ['http://x.com/a', 'https://y.com/b']],
      ['https://a.com/x,janedoe.design', ['https://a.com/x', 'https://janedoe.design']],
    ])('a mark between two links still separates them: %j', (answer, urls) => {
      expect(extractAnswerUrls(answer)).toEqual(urls);
    });

    it('a wrapped link has ended: what follows its closing bracket is not part of it', () => {
      expect(extractAnswerUrls('(https://a.com/x),and')).toEqual(['https://a.com/x']);
      expect(extractAnswerUrls('*https://a.com/x*,and')).toEqual(['https://a.com/x']);
    });

    it('a comma list of scheme-less links is unchanged', () => {
      expect(extractAnswerUrls('instagram.com/jane,janedoe.design,bit.ly/abc')).toEqual(['https://instagram.com/jane', 'https://janedoe.design', 'https://bit.ly/abc']);
      expect(extractAnswerUrls('janedoe.design,work,2023')).toEqual(['https://janedoe.design']);
    });

    it('the link is still found, and the text is still "text only" or not, as before', () => {
      expect(pickOne('https://janedoe.design/work,2023/x').links.map(l => l.url)).toEqual(['https://janedoe.design/work,2023/x']);
      expect(pickOne('https://calendly.com/jane/30min,N/A').answered).toBe(false);
    });

    it.each([
      ['an endless comma chain', () => `https://a.com/${'x,'.repeat(50_000)}`],
      ['a long glued list', () => 'https://a.com/x,'.repeat(5_000)],
      ['links separated by lone commas', () => Array.from({ length: 3_000 }, (_, i) => `https://s${i}.com/p`).join(',')],
      ['pipes and apostrophes', () => `https://a.com/${"|'".repeat(30_000)}`],
      ['emoji after emoji', () => `https://a.com/x${'👈'.repeat(30_000)}`],
      ['closing brackets', () => `https://a.com/x${'))))'.repeat(10_000)}`],
      ['ellipsis runs', () => `https://a.com/x${'…'.repeat(50_000)} https://b.com/y`],
    ])('a hostile answer (%s) finishes quickly', (_n, make) => {
      const text = make();
      const { ms } = timed(() => pickAnswerLinks(answerOf(text)));
      expect(ms).toBeLessThan(300);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// [3.5] Drive / Docs links with an account prefix (/u/N/ or /a/<domain>/)
// ═════════════════════════════════════════════════════════════════════════════
describe('Google links with an account prefix are documents, like the plain forms', () => {
  const G = DRIVE_ID;
  const PLAIN = {
    driveFile: `https://drive.google.com/file/d/${G}/view`,
    driveFolder: `https://drive.google.com/drive/folders/${G}`,
    uc: `https://drive.google.com/uc?id=${G}&export=download`,
    open: `https://drive.google.com/open?id=${G}`,
    folderview: `https://drive.google.com/folderview?id=${G}`,
    doc: `https://docs.google.com/document/d/${G}/edit`,
    slides: `https://docs.google.com/presentation/d/${G}/edit`,
    sheet: `https://docs.google.com/spreadsheets/d/${G}/edit`,
  };

  it.each([
    [`https://drive.google.com/u/0/uc?id=${G}&export=download`, 'gdrive_file', PLAIN.uc],
    [`https://drive.google.com/u/1/uc?export=download&id=${G}`, 'gdrive_file', `https://drive.google.com/uc?export=download&id=${G}`],
    [`https://drive.google.com/u/1/open?id=${G}`, 'gdrive_file', PLAIN.open],
    [`https://drive.google.com/u/0/file/d/${G}/view`, 'gdrive_file', PLAIN.driveFile],
    [`https://drive.google.com/u/3/folderview?id=${G}`, 'gdrive_folder', PLAIN.folderview],
    [`https://drive.google.com/u/0/drive/folders/${G}`, 'gdrive_folder', PLAIN.driveFolder],
    [`https://drive.google.com/a/acme.com/uc?id=${G}&export=download`, 'gdrive_file', PLAIN.uc],
    [`https://drive.google.com/a/acme.com/open?id=${G}`, 'gdrive_file', PLAIN.open],
    [`https://drive.google.com/a/acme.com/file/d/${G}/view`, 'gdrive_file', PLAIN.driveFile],
    [`https://drive.google.com/a/acme.com/drive/folders/${G}`, 'gdrive_folder', PLAIN.driveFolder],
    [`https://drive.google.com/a/acme.com/drive/mobile/folders/${G}`, 'gdrive_folder', PLAIN.driveFolder],
    [`https://drive.google.com/u/0/drive/mobile/folders/${G}`, 'gdrive_folder', PLAIN.driveFolder],
    [`https://drive.google.com/drive/mobile/folders/${G}?usp=sharing`, 'gdrive_folder', `${PLAIN.driveFolder}?usp=sharing`],
    [`https://drive.google.com/a/acme.com/folderview?id=${G}`, 'gdrive_folder', PLAIN.folderview],
    [`https://drive.google.com/a/acme.com/u/0/file/d/${G}/view`, 'gdrive_file', PLAIN.driveFile],
    [`https://drive.google.com/u/0/a/acme.com/uc?id=${G}`, 'gdrive_file', `https://drive.google.com/uc?id=${G}`],
    [`https://drive.google.com/a/macros.acme-corp.co.in/file/d/${G}/view`, 'gdrive_file', PLAIN.driveFile],
    [`https://docs.google.com/a/acme.com/document/d/${G}/edit`, 'google_doc', PLAIN.doc],
    [`https://docs.google.com/a/acme.com/presentation/d/${G}/edit`, 'google_slides', PLAIN.slides],
    [`https://docs.google.com/a/acme.com/spreadsheets/d/${G}/edit`, 'google_sheet', PLAIN.sheet],
    [`https://docs.google.com/u/0/document/d/${G}/edit`, 'google_doc', PLAIN.doc],
    [`https://docs.google.com/a/acme.com/document/u/0/d/${G}/edit`, 'google_doc', `https://docs.google.com/document/u/0/d/${G}/edit`],
    [`https://docs.google.com/a/acme.com/document/d/${G}/edit?usp=sharing`, 'google_doc', `https://docs.google.com/document/d/${G}/edit?usp=sharing`],
  ])('%s -> %s, a document with key drive:<id>, opened as %s', (url, platform, canonical) => {
    expect(classifyAnswerUrl(url)).toEqual({ url: canonical, host: new URL(url).hostname, platform, handler: 'document', key: `drive:${G}` });
  });

  it('every prefixed form shares the key of the plain form, so the same file is one link however it was copied', () => {
    const keys = [
      PLAIN.driveFile, `https://drive.google.com/u/0/file/d/${G}/view`, `https://drive.google.com/a/acme.com/file/d/${G}/view`,
      PLAIN.open, `https://drive.google.com/u/1/open?id=${G}`, PLAIN.uc, `https://drive.google.com/u/0/uc?id=${G}&export=download`,
      `https://drive.google.com/a/acme.com/uc?id=${G}`,
    ].map(u => classifyAnswerUrl(u)?.key);
    expect(new Set(keys)).toEqual(new Set([`drive:${G}`]));
    const docKeys = [PLAIN.doc, `https://docs.google.com/a/acme.com/document/d/${G}/edit`, `https://docs.google.com/u/0/document/d/${G}/edit`].map(u => classifyAnswerUrl(u)?.key);
    expect(new Set(docKeys)).toEqual(new Set([`drive:${G}`]));
  });

  it('the prefix is dropped from the address handed to the fetcher (it only says which account the link was copied from)', () => {
    const c = classifyAnswerUrl(`https://drive.google.com/a/acme.com/u/0/uc?id=${G}&export=download`);
    expect(c?.url).toBe(`https://drive.google.com/uc?id=${G}&export=download`);
    expect(c?.url).not.toMatch(/\/(a|u)\//);
  });

  it('plain forms are returned exactly as before (nothing is rewritten when there is no prefix)', () => {
    for (const u of [`https://drive.google.com/file/d/${G}/view?usp=sharing`, PLAIN.uc, PLAIN.doc, `https://drive.google.com/file/u/0/d/${G}/view`, `https://drive.google.com/drive/u/0/folders/${G}`]) {
      expect(classifyAnswerUrl(u)?.url).toBe(u);
    }
  });

  it.each([
    [`https://drive.google.com/u/0/uc?id=abc`],                       // id too short
    [`https://drive.google.com/a/acme.com/uc?id=abc.defghijklmno`],   // character outside [A-Za-z0-9_-]
    [`https://drive.google.com/a/acme.com/drive/my-drive`],           // no id at all
    [`https://drive.google.com/u/0/drive/my-drive`],
    [`https://docs.google.com/a/acme.com/drawings/d/${G}/edit`],      // not a type we read
    [`https://docs.google.com/a/acme.com/document/d/xyz/edit`],
  ])('a prefixed link without a usable id is still just a site link: %s', (url) => {
    const c = classifyAnswerUrl(url);
    expect(c).toMatchObject({ platform: 'custom', handler: 'site' });
    expect(c?.key.startsWith('drive:')).toBe(false);
    expect(c?.url).toBe(new URL(url).toString().replace(/\/$/, ''));    // and its address is left alone
  });

  it('the prefix means nothing on other hosts', () => {
    expect(classifyAnswerUrl(`https://example.com/u/0/uc?id=${G}`)).toMatchObject({ platform: 'custom', handler: 'site' });
    expect(classifyAnswerUrl(`https://dropbox.com/a/acme.com/uc?id=${G}`)?.key.startsWith('drive:')).toBe(false);
  });

  it('end to end: a prefixed Drive link in an answer is a document to open, not a website for Chromium', () => {
    const p = pickAnswerLinks(answerOf(`https://drive.google.com/u/0/uc?id=${G}&export=download and https://docs.google.com/a/acme.com/document/d/${DRIVE_ID.slice(0, -1)}Z/edit`));
    expect(p.links.map(l => [l.platform, l.handler])).toEqual([['gdrive_file', 'document'], ['google_doc', 'document']]);
  });

  it('...and the same file given twice, plain and with a prefix, is picked once', () => {
    const p = pickAnswerLinks(answerOf(`${PLAIN.driveFile} https://drive.google.com/u/0/file/d/${G}/view https://drive.google.com/a/acme.com/uc?id=${G}`));
    expect(p.links).toHaveLength(1);
    expect(p.listedNotReviewed).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// [2.9] claimText keeps the candidate's line breaks and says when it was cut
// ═════════════════════════════════════════════════════════════════════════════
describe('claimText', () => {
  const claim = (answer: string) => pickAnswerLinks(answerOf(answer)).claimText;

  it('keeps a numbered list of campaigns as a list', () => {
    expect(claim('I ran three campaigns:\n1. Clearwater launch\n2. World Water Day\n3. Brand refresh\nhttps://janedoe.design')).toBe(
      'I ran three campaigns:\n1. Clearwater launch\n2. World Water Day\n3. Brand refresh\nhttps://janedoe.design');
  });

  it('collapses only runs of spaces and tabs, and three or more line breaks to two', () => {
    expect(claim('a   b\t\tc \u00a0 d   https://janedoe.design')).toBe('a b c d https://janedoe.design');
    expect(claim('Campaigns\n\n\n\n\nhttps://janedoe.design\n\nmore')).toBe('Campaigns\n\nhttps://janedoe.design\n\nmore');
    expect(claim('one\ntwo\n\nthree https://janedoe.design')).toBe('one\ntwo\n\nthree https://janedoe.design');
  });

  it('puts no space on either side of a line break, and trims the ends', () => {
    expect(claim('  \n  line one   \n   line two  \n\n  https://janedoe.design \n  ')).toBe('line one\nline two\n\nhttps://janedoe.design');
  });

  it.each([
    ['CRLF', 'a\r\nb https://janedoe.design', 'a\nb https://janedoe.design'],
    ['a lone CR', 'a\rb https://janedoe.design', 'a\nb https://janedoe.design'],
    ['a mix', 'a\r\n\r\n\r\nb\rc\nd https://janedoe.design', 'a\n\nb\nc\nd https://janedoe.design'],
  ])('%s becomes a plain line break', (_n, answer, expected) => {
    expect(claim(answer)).toBe(expected);
  });

  it('other Unicode line separators (NEL, LS, PS) are line breaks too', () => {
    const parts = ['a', 'b', 'c', 'd'];
    const answer = `${parts[0]}${String.fromCharCode(0x85)}${parts[1]}${String.fromCharCode(0x2028)}${parts[2]}${String.fromCharCode(0x2029)}${parts[3]} https://janedoe.design`;
    expect(claim(answer)).toBe('a\nb\nc\nd https://janedoe.design');
  });

  it('control characters become spaces (a tab or line break is not one); no NUL survives', () => {
    expect(claim('I ran\u0000 brand\u0001 campaigns\u007f for startups\u000b and brands\u000c here https://janedoe.design')).toBe('I ran brand campaigns for startups and brands here https://janedoe.design');
  });

  describe('when the answer is longer than 1500 characters', () => {
    const line = (n: number) => `Campaign ${n}: launched the brand and ran it end to end.`;
    const long = (lines: number) => `${Array.from({ length: lines }, (_, i) => line(i + 1)).join('\n')}\nhttps://janedoe.design`;

    it('it ends with "…" and is at most 1500 characters in all', () => {
      const c = claim(long(60));
      expect(c.length).toBeLessThanOrEqual(1500);
      expect(c.length).toBeGreaterThan(1490);
      expect(c.endsWith('…')).toBe(true);
      expect(c.slice(0, -1)).toBe(c.slice(0, -1).trimEnd());
    });

    it('the line breaks before the cut are kept', () => {
      const c = claim(long(60));
      expect(c.startsWith(`${line(1)}\n${line(2)}\n${line(3)}\n`)).toBe(true);
      expect(c.split('\n').length).toBeGreaterThan(20);
    });

    it('exactly 1500 characters is whole, no ellipsis; one more is cut', () => {
      const exact = `${'a'.repeat(1486)} https://a.com/x`;
      expect(exact.length).toBe(1502);
      const fits = `${'a'.repeat(1484)} https://a.com/x`;
      expect(fits.length).toBe(1500);
      expect(claim(fits)).toBe(fits);
      expect(claim(fits).endsWith('…')).toBe(false);
      const cut = claim(exact);
      expect(cut.length).toBe(1500);
      expect(cut.endsWith('…')).toBe(true);
    });

    it('a cut that lands right after a space or line break leaves nothing dangling before the ellipsis', () => {
      const c = claim(`${'a'.repeat(1498)}\n\n${'b'.repeat(50)} https://janedoe.design`);
      expect(c).toBe(`${'a'.repeat(1498)}…`);
      const d = claim(`${'a'.repeat(1498)} ${'b'.repeat(50)} https://janedoe.design`);
      expect(d).toBe(`${'a'.repeat(1498)}…`);
    });

    it('never ends in half an emoji', () => {
      for (const pad of [1497, 1498, 1499, 1500]) {
        const c = claim(`${'a'.repeat(pad)}😀😀😀 https://janedoe.design`);
        expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(c), `pad ${pad}`).toBe(false);
        expect(c.length).toBeLessThanOrEqual(1500);
      }
    });

    it('a short answer never gets an ellipsis', () => {
      expect(claim('I ran brand campaigns for three startups… and more https://janedoe.design')).toBe('I ran brand campaigns for three startups… and more https://janedoe.design');
    });
  });

  it.each([
    ['100 KB of line breaks', () => '\n'.repeat(100_000)],
    ['100 KB of spaces and line breaks', () => ' \n'.repeat(50_000)],
    ['a long run of spaces', () => `a${' '.repeat(100_000)}b`],
    ['CR LF soup', () => '\r\n\r'.repeat(30_000)],
  ])('a hostile answer (%s) is quick', (_n, make) => {
    const text = `${make()} https://janedoe.design`;
    const { result, ms } = timed(() => claim(text));
    expect(ms).toBeLessThan(300);
    expect(result.length).toBeLessThanOrEqual(1500);
  });
});

