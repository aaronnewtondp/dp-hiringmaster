import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import LinkifiedText, { safeHttpUrl, splitLinkified } from './LinkifiedText.tsx';

const links = (s: string) => splitLinkified(s).filter(p => p.href).map(p => p.href);
const joined = (s: string) => splitLinkified(s).map(p => p.text).join('');

describe('splitLinkified', () => {
  it('returns one plain part for text without a link, and nothing for empty text', () => {
    expect(splitLinkified('No links here, just words.')).toEqual([{ text: 'No links here, just words.' }]);
    expect(splitLinkified('')).toEqual([]);
  });

  it('links an http and an https URL and keeps the surrounding words in order', () => {
    expect(splitLinkified('See https://example.com/work and http://old.example.org/a?b=1#c for samples')).toEqual([
      { text: 'See ' },
      { text: 'https://example.com/work', href: 'https://example.com/work' },
      { text: ' and ' },
      { text: 'http://old.example.org/a?b=1#c', href: 'http://old.example.org/a?b=1#c' },
      { text: ' for samples' },
    ]);
  });

  it('accepts an upper-case scheme', () => {
    expect(links('HTTPS://Example.com/Portfolio')).toEqual(['HTTPS://Example.com/Portfolio']);
  });

  it('leaves javascript:, data:, vbscript: and file: strings as plain text', () => {
    for (const s of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'JaVaScRiPt:alert(1)']) {
      expect(splitLinkified(s)).toEqual([{ text: s }]);
    }
  });

  it('does not treat a scheme glued to other letters as a link', () => {
    expect(links('xhttps://example.com')).toEqual([]);
  });

  it('a javascript: URL after a real link is not swept into it', () => {
    expect(splitLinkified('https://a.com javascript:alert(1)')).toEqual([
      { text: 'https://a.com', href: 'https://a.com' },
      { text: ' javascript:alert(1)' },
    ]);
  });

  it('trims sentence punctuation that trails a URL, and keeps it as text', () => {
    expect(splitLinkified('Portfolio: https://example.com/work.')).toEqual([
      { text: 'Portfolio: ' },
      { text: 'https://example.com/work', href: 'https://example.com/work' },
      { text: '.' },
    ]);
    for (const tail of [',', ';', ':', '!', '?', '…', '.)', '),', '?!', '...']) {
      expect(links(`go to https://example.com/x${tail} ok`)).toEqual(['https://example.com/x']);
    }
  });

  it('keeps punctuation that is part of the URL', () => {
    expect(links('https://example.com/a,b?x=1&y=2#frag-1_2~3')).toEqual(['https://example.com/a,b?x=1&y=2#frag-1_2~3']);
    expect(links('https://example.com/search?q=what?')).toEqual(['https://example.com/search?q=what']);
  });

  it('keeps a closing bracket that balances one inside the URL, trims one that does not', () => {
    expect(links('https://en.example.org/wiki/Tea_(drink)')).toEqual(['https://en.example.org/wiki/Tea_(drink)']);
    expect(links('https://en.example.org/wiki/Tea_(drink).')).toEqual(['https://en.example.org/wiki/Tea_(drink)']);
    expect(links('(my work: https://example.com/work)')).toEqual(['https://example.com/work']);
    expect(links('[https://example.com/work]')).toEqual(['https://example.com/work']);
  });

  it('splits URLs pasted without a space between them', () => {
    expect(links('https://a.com/one,https://b.com/two;https://c.com')).toEqual(['https://a.com/one', 'https://b.com/two', 'https://c.com']);
  });

  it('splits on newlines and stops at angle brackets and quotes', () => {
    expect(links('https://a.com/one\nhttps://b.com/two')).toEqual(['https://a.com/one', 'https://b.com/two']);
    expect(links('<a href="https://a.com/x">site</a>')).toEqual(['https://a.com/x']);
    expect(links("'https://a.com/x'")).toEqual(['https://a.com/x']);
    expect(links('https://a.com/x<script>alert(1)</script>')).toEqual(['https://a.com/x']);
  });

  it('a bare scheme or a scheme with no host is not a link', () => {
    expect(links('https:// and http://. and https://,')).toEqual([]);
  });

  it('never loses or reorders text: the parts always concatenate back to the input', () => {
    for (const s of [
      'a https://x.com/y). b (https://p.com/q) c, https://r.com,https://s.com. end',
      'https://a.com\n\nhttps://b.com\t https://c.com',
      '  leading and trailing  ',
      'https:// https://ok.com https://.',
      'Behance: https://www.behance.net/someone/projects?x=1 | YouTube: https://youtu.be/abc123XYZ00',
    ]) expect(joined(s)).toBe(s);
  });

  it('a very long run of closing brackets or punctuation stays fast (no quadratic trimming)', () => {
    for (const filler of [')', ']', '.', ',']) {
      const hostile = `https://example.com/${filler.repeat(200_000)}`;
      const t0 = Date.now();
      const parts = splitLinkified(hostile);
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(parts.map(p => p.text).join('')).toBe(hostile);
      expect(links(hostile)).toEqual(['https://example.com/']);
    }
  });
});

// The backend's link picker opens "drive.google.com/…", "instagram.com/…" and "www.x.com" with no scheme, so the
// text HR reads must make them clickable too — but only those, never any word that happens to contain a dot.
describe('splitLinkified — addresses written without a scheme', () => {
  it('links the known work-sample hosts and www. hosts by putting https:// in front, keeping the text as typed', () => {
    expect(splitLinkified('see drive.google.com/file/d/AAAAAAAAAAAA/view and www.mybrand.in')).toEqual([
      { text: 'see ' },
      { text: 'drive.google.com/file/d/AAAAAAAAAAAA/view', href: 'https://drive.google.com/file/d/AAAAAAAAAAAA/view' },
      { text: ' and ' },
      { text: 'www.mybrand.in', href: 'https://www.mybrand.in' },
    ]);
  });

  it.each([
    ['drive.google.com/drive/folders/1AbCdEfGhIjKlMn'],
    ['docs.google.com/presentation/d/1AbCdEfGhIjKlMn/edit'],
    ['instagram.com/brightlane.studio'],
    ['www.instagram.com/brightlane.studio/'],
    ['youtube.com/watch?v=abcdefghijk'],
    ['youtu.be/abcdefghijk?si=xyz'],
    ['vimeo.com/123456789'],
    ['behance.net/someone/projects'],
    ['canva.com/design/DAF1234/view'],
    ['notion.so/Portfolio-0123456789abcdef'],
    ['someone.notion.site/Portfolio'],
    ['linkedin.com/in/someone'],
    ['dropbox.com/s/abc123/deck.pdf?dl=0'],
    ['medium.com/@someone/a-story-1234'],
    ['m.youtube.com/@channel'],
    ['in.linkedin.com/in/someone'],
    ['www.example.org'],
    ['WWW.EXAMPLE.ORG/Work'],
    ['Instagram.com/Someone'],
  ])('links %s', (address) => {
    expect(links(`my work: ${address} thanks`)).toEqual([`https://${address}`]);
    expect(links(address)).toEqual([`https://${address}`]);
  });

  it('keeps sentence punctuation and unbalanced brackets out of the address', () => {
    expect(links('Reel: instagram.com/someone.')).toEqual(['https://instagram.com/someone']);
    expect(links('(instagram.com/someone)')).toEqual(['https://instagram.com/someone']);
    expect(links('instagram.com/someone, and more')).toEqual(['https://instagram.com/someone']);
    expect(links('go to www.example.com.')).toEqual(['https://www.example.com']);
    expect(links('go to youtube.com.')).toEqual(['https://youtube.com']);
    expect(links('en.example.org? www.example.org!')).toEqual(['https://www.example.org']);
  });

  it('splits addresses pasted with no space between them, and one that follows an https link', () => {
    expect(links('drive.google.com/file/d/AAAAAAAAAAAA/view,instagram.com/someone;www.a.com/x')).toEqual([
      'https://drive.google.com/file/d/AAAAAAAAAAAA/view', 'https://instagram.com/someone', 'https://www.a.com/x',
    ]);
    expect(links('https://a.com/one,youtu.be/abcdefghijk')).toEqual(['https://a.com/one,youtu.be/abcdefghijk']);   // inside an explicit URL, a comma is part of it
    expect(links('https://a.com/one youtu.be/abcdefghijk\nwww.b.com')).toEqual(['https://a.com/one', 'https://youtu.be/abcdefghijk', 'https://www.b.com']);
    expect(links('drive.google.com/x,https://b.com/y')).toEqual(['https://drive.google.com/x', 'https://b.com/y']);
  });

  it('does not link other bare domains, file names or e-mail addresses', () => {
    for (const s of [
      'example.com', 'my site is mybrand.in', 'Node.js and Vue.js', 'e.g. this', 'index.html', 'report.final.pdf',
      'jane@gmail.com', 'jane.doe@instagram.com', 'jane@www.example.com', 'jane@sub.linkedin.com', 'instagram.com@evil.example',
      'info@youtube.com', 'bit.ly/3abc', 'linktr.ee/someone',
    ]) expect(links(s)).toEqual([]);
  });

  it('does not link a known host that is only the start or the end of a longer name', () => {
    for (const s of [
      'instagram.com.evil.example/login', 'notinstagram.com/x', 'myyoutube.com', 'instagram.company/x', 'notion.software',
      'instagram.com-login.example', 'evil-instagram.com/x', 'my_youtu.be', 'docs.google.com.attacker.example',
    ]) expect(links(s)).toEqual([]);
  });

  it('never makes a javascript:, data: or other non-web string clickable, even beside a known host', () => {
    for (const s of [
      'javascript:alert(1)', 'javascript:instagram.com/x', 'data:text/html;base64,PHNjcmlwdD4=', 'ftp://instagram.com/x',
      'file://drive.google.com/x', 'vbscript:www.example.com', 'mailto:instagram.com',
    ]) expect(links(s)).toEqual([]);
    // a real address that follows such a string is linked on its own; the data: part stays the plain text it was
    expect(splitLinkified('data:text/html,www.example.com')).toEqual([
      { text: 'data:text/html,' }, { text: 'www.example.com', href: 'https://www.example.com' },
    ]);
    // inside an http(s) address the rest is simply part of that address
    expect(links('https://example.com/?next=javascript:alert(1)')).toEqual(['https://example.com/?next=javascript:alert(1)']);
  });

  it('stops at angle brackets, quotes and backticks like an https address does', () => {
    expect(links('<instagram.com/x>')).toEqual(['https://instagram.com/x']);
    expect(links('"www.example.com/a"')).toEqual(['https://www.example.com/a']);
    expect(links('www.example.com/a<script>alert(1)</script>')).toEqual(['https://www.example.com/a']);
  });

  it('is lossless: the parts still concatenate back to the input', () => {
    for (const s of [
      'a instagram.com/x). b (www.p.com/q) c, youtu.be/r,vimeo.com/s. end',
      'drive.google.com/a\nhttps://b.com\twww.c.com/d  trailing  ',
      'jane@instagram.com and instagram.com/jane and not.a.link',
      'Behance: behance.net/someone | YouTube: https://youtu.be/abc123XYZ00 | www.x.com.',
      '', ' ', '.www.a.com', 'xwww.a.com', 'www.', 'www..com', 'instagram.com/',
    ]) expect(joined(s)).toBe(s);
  });

  it('every href it produces is an http(s) address', () => {
    for (const s of ['www.a.com/%00', 'www.a.com/‮gpj.exe', 'www.-.com', 'www.a..com/x', 'instagram.com/\\evil', 'www.a.com:99999']) {
      for (const p of splitLinkified(s)) if (p.href) expect(p.href).toMatch(/^https?:\/\/[^\s<>"'`]+$/);
    }
  });

  it('stays fast on hostile input (no quadratic scanning)', () => {
    const hostile = [
      'a.'.repeat(200_000), ' a.'.repeat(100_000), 'www.'.repeat(100_000), 'www.a'.repeat(100_000), 'instagram.com'.repeat(50_000),
      `www.a.com/${','.repeat(200_000)}`, `www.a.com/${'www.a,'.repeat(50_000)}`, '-a.'.repeat(100_000), `x${'.a'.repeat(200_000)} `,
      'instagram.com/'.repeat(30_000), ' www.a.com'.repeat(30_000), `${'a'.repeat(300_000)}.com`, `drive.google.com/${')'.repeat(200_000)}`,
    ];
    for (const h of hostile) {
      const t0 = Date.now();
      const parts = splitLinkified(h);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(parts.map(p => p.text).join('')).toBe(h);
    }
  });
});

describe('safeHttpUrl', () => {
  it('accepts http(s) URLs with a host and rejects everything else', () => {
    expect(safeHttpUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHttpUrl('  http://example.com ')).toBe('http://example.com');
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com', '//example.com', 'example.com', 'https://', 'https:///x', '', null, undefined]) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
  });
});

describe('<LinkifiedText>', () => {
  it('renders links as anchors that open in a new tab without referrer or opener', () => {
    const { container } = render(<p><LinkifiedText text="Work: https://example.com/work, and https://b.example.org." /></p>);
    const anchors = container.querySelectorAll('a');
    expect(anchors).toHaveLength(2);
    expect(anchors[0].getAttribute('href')).toBe('https://example.com/work');
    expect(anchors[0].getAttribute('target')).toBe('_blank');
    expect(anchors[0].getAttribute('rel')).toBe('noreferrer noopener');
    expect(anchors[1].textContent).toBe('https://b.example.org');
    expect(container.textContent).toBe('Work: https://example.com/work, and https://b.example.org.');
  });

  it('renders a javascript: string as text, not as an anchor', () => {
    const { container } = render(<p><LinkifiedText text="click javascript:alert(document.cookie) now" /></p>);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('click javascript:alert(document.cookie) now');
  });

  it('never interprets markup in the text', () => {
    const { container } = render(<p><LinkifiedText text={'<img src=x onerror=alert(1)> <b>bold</b> https://example.com'} /></p>);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)> <b>bold</b>');
    expect(container.querySelectorAll('a')).toHaveLength(1);
  });

  it('renders a scheme-less address as an anchor to its https:// form, with the text as the candidate typed it', () => {
    const { container } = render(<p><LinkifiedText text="see drive.google.com/file/d/AAAAAAAAAAAA/view, instagram.com/brightlane.studio and www.canva.com/design/XYZ." /></p>);
    const anchors = Array.from(container.querySelectorAll('a'));
    expect(anchors.map(a => a.getAttribute('href'))).toEqual([
      'https://drive.google.com/file/d/AAAAAAAAAAAA/view', 'https://instagram.com/brightlane.studio', 'https://www.canva.com/design/XYZ',
    ]);
    expect(anchors.map(a => a.textContent)).toEqual(['drive.google.com/file/d/AAAAAAAAAAAA/view', 'instagram.com/brightlane.studio', 'www.canva.com/design/XYZ']);
    for (const a of anchors) { expect(a.getAttribute('target')).toBe('_blank'); expect(a.getAttribute('rel')).toBe('noreferrer noopener'); }
    expect(container.textContent).toBe('see drive.google.com/file/d/AAAAAAAAAAAA/view, instagram.com/brightlane.studio and www.canva.com/design/XYZ.');
  });

  it('an e-mail address and a javascript: string stay plain text in the rendered output', () => {
    const { container } = render(<p><LinkifiedText text="mail jane@instagram.com or javascript:instagram.com/x" /></p>);
    expect(container.querySelector('a')).toBeNull();
  });

  it('copes with a missing or non-string answer', () => {
    expect(render(<p><LinkifiedText text={undefined} /></p>).container.textContent).toBe('');
    expect(render(<p><LinkifiedText text={null} /></p>).container.textContent).toBe('');
    expect(render(<p><LinkifiedText text={42 as unknown as string} /></p>).container.textContent).toBe('42');
  });
});
