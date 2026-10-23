import { describe, it, expect } from 'vitest';
import {
  BOT_WALL_REASON, GOOGLE_ID_RE, MAX_FOLDER_FILES, PRIVATE_LINK_REASON, classifyDownloadPage, googleFetchUrl, isGoogleFileHost,
  isGoogleId, parseFolderListing, parseGoogleUrl, quotaReason, rankFolderFiles,
} from './google.js';
import type { FolderEntry, GoogleKind } from './google.js';

const ID = 'AbCdEfGhIj-_0123456789xyzXYZ_abcdefg';   // 36 characters, like a real Drive id
const id = (c: string, n = 33) => c.repeat(n);

const parse = (url: string, platform?: Parameters<typeof parseGoogleUrl>[1]) => parseGoogleUrl(new URL(url), platform);

describe('GOOGLE_ID_RE / isGoogleId', () => {
  it('accepts 10+ letters, digits, "_" and "-"', () => {
    for (const ok of [ID, 'a'.repeat(10), '0123456789', 'a-b_c-d_e-', '1AbCdEfGhIjKlMnOpQrStUvWxYz']) {
      expect(GOOGLE_ID_RE.test(ok)).toBe(true);
      expect(isGoogleId(ok)).toBe(true);
    }
  });

  it('rejects short ids and anything that could change a path, query or host', () => {
    for (const bad of ['', 'short', 'a'.repeat(9), '../..', '../../etc/passwd', 'abc/../defghij', 'abcdefghij/', 'abcdefghij?x=1', 'abcdefghij#x',
      'abcdefghij%2e%2e', '%2e%2e%2f%2e%2e%2f', 'abcdefghi j', 'abcdefghij\n', 'abc.defghijk', 'abcdefghij;', 'ａｂｃｄｅｆｇｈｉｊ', 'abcdefghij\u0000']) {
      expect(GOOGLE_ID_RE.test(bad)).toBe(false);
      expect(isGoogleId(bad)).toBe(false);
    }
    expect(isGoogleId(undefined)).toBe(false);
    expect(isGoogleId(null)).toBe(false);
    expect(isGoogleId(12345678901)).toBe(false);
  });

  it('isGoogleId also caps the length, so a 2,000-character "id" is never copied into a URL', () => {
    expect(isGoogleId('a'.repeat(200))).toBe(true);
    expect(isGoogleId('a'.repeat(201))).toBe(false);
  });
});

describe('isGoogleFileHost', () => {
  it('is exactly the Drive / Docs / usercontent hosts, ignoring a leading www', () => {
    for (const h of ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com', 'www.drive.google.com', 'DRIVE.GOOGLE.COM']) expect(isGoogleFileHost(h)).toBe(true);
    for (const h of ['google.com', 'sites.google.com', 'evil-drive.google.com.example.com', 'drive.google.com.evil.io', 'notdrive.google.com', 'accounts.google.com']) expect(isGoogleFileHost(h)).toBe(false);
  });
});

describe('parseGoogleUrl — every shape of Drive / Docs link', () => {
  const target = (kind: GoogleKind, extra: object = {}) => ({ ok: true, target: { kind, id: ID, ...extra } });

  it.each<[string, string, GoogleKind]>([
    ['Drive file view', `https://drive.google.com/file/d/${ID}/view?usp=sharing`, 'file'],
    ['Drive file, multi-account', `https://drive.google.com/file/u/0/d/${ID}/view`, 'file'],
    ['Drive file, workspace domain', `https://drive.google.com/a/digitalpaani.com/file/d/${ID}/view`, 'file'],
    ['Drive file, bare id path', `https://drive.google.com/file/d/${ID}`, 'file'],
    ['Docs document edit', `https://docs.google.com/document/d/${ID}/edit?usp=sharing`, 'doc'],
    ['Docs document, multi-account', `https://docs.google.com/document/u/0/d/${ID}/edit`, 'doc'],
    ['Docs document, workspace domain', `https://docs.google.com/a/digitalpaani.com/document/d/${ID}/edit`, 'doc'],
    ['Slides', `https://docs.google.com/presentation/d/${ID}/edit#slide=id.p`, 'slides'],
    ['Sheets', `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`, 'sheet'],
    ['folder', `https://drive.google.com/drive/folders/${ID}?usp=sharing`, 'folder'],
    ['folder, multi-account', `https://drive.google.com/drive/u/0/folders/${ID}`, 'folder'],
    ['folderview', `https://drive.google.com/folderview?id=${ID}`, 'folder'],
    ['uc download', `https://drive.google.com/uc?export=download&id=${ID}`, 'file'],
    ['open?id (type unknown)', `https://drive.google.com/open?id=${ID}`, 'file'],
    ['www host', `https://www.drive.google.com/file/d/${ID}/view`, 'file'],
  ])('%s', (_name, url, kind) => {
    expect(parse(url)).toEqual(target(kind));
  });

  describe('account segments: "/u/N" (signed-in account) and "/a/<domain>" (Workspace) on every form', () => {
    it.each<[string, string, GoogleKind]>([
      ['uc download under /u/0', `https://drive.google.com/u/0/uc?id=${ID}&export=download`, 'file'],
      ['uc download under /u/2/', `https://drive.google.com/u/2/uc?export=download&id=${ID}`, 'file'],
      ['open?id under /u/1', `https://drive.google.com/u/1/open?id=${ID}`, 'file'],
      ['download?id under /u/0', `https://drive.google.com/u/0/download?id=${ID}`, 'file'],
      ['open?id under a Workspace domain', `https://drive.google.com/a/acme.com/open?id=${ID}`, 'file'],
      ['uc?id under a Workspace domain', `https://drive.google.com/a/acme.com/uc?id=${ID}&export=download`, 'file'],
      ['uc?id under a domain and an account', `https://drive.google.com/a/acme.com/u/0/uc?id=${ID}`, 'file'],
      ['uc?id under an account and a domain', `https://drive.google.com/u/0/a/acme.com/uc?id=${ID}`, 'file'],
      ['folderview under /u/0', `https://drive.google.com/u/0/folderview?id=${ID}`, 'folder'],
      ['file view under /u/0 at the root', `https://drive.google.com/u/0/file/d/${ID}/view`, 'file'],
      ['file view under a domain at the root, with /u/0 inside', `https://drive.google.com/a/acme.com/file/u/0/d/${ID}/view`, 'file'],
      ['Docs under a domain', `https://docs.google.com/a/acme.com/document/d/${ID}/edit`, 'doc'],
      ['Slides under a domain', `https://docs.google.com/a/acme.com/presentation/d/${ID}/edit`, 'slides'],
      ['Sheets under a domain', `https://docs.google.com/a/acme.com/spreadsheets/d/${ID}/edit#gid=0`, 'sheet'],
      ['Docs under /u/0 at the root', `https://docs.google.com/u/0/document/d/${ID}/edit`, 'doc'],
      ['Docs under a domain and an account', `https://docs.google.com/a/acme.com/u/3/document/d/${ID}/edit`, 'doc'],
      ['Docs under an account, a domain and /u inside', `https://docs.google.com/u/1/a/acme.com/document/u/1/d/${ID}/edit`, 'doc'],
      ['the mobile folder view', `https://drive.google.com/drive/mobile/folders/${ID}`, 'folder'],
      ['the mobile folder view of a second account', `https://drive.google.com/drive/u/1/mobile/folders/${ID}?usp=sharing`, 'folder'],
      ['a folder under a domain', `https://drive.google.com/a/acme.com/drive/folders/${ID}`, 'folder'],
      ['a folder under a domain, inside the drive path', `https://drive.google.com/drive/a/acme.com/folders/${ID}`, 'folder'],
      ['a folder under an account at the root', `https://drive.google.com/u/0/drive/folders/${ID}`, 'folder'],
    ])('%s', (_name, url, kind) => {
      expect(parse(url)).toEqual(target(kind));
    });

    it('open?id under an account still lets the classified platform break the tie', () => {
      const url = `https://drive.google.com/u/0/open?id=${ID}`;
      expect(parse(url, 'google_doc')).toEqual(target('doc'));
      expect(parse(url, 'gdrive_folder')).toEqual(target('folder'));
      expect(parse(url, 'pdf_file')).toEqual(target('file'));
    });

    it.each([
      ['a non-numeric account', `https://drive.google.com/u/abc/uc?id=${ID}`],
      ['an empty account number', `https://drive.google.com/u//uc?id=${ID}`],
      ['an empty Workspace domain', `https://drive.google.com/a//uc?id=${ID}`],
      ['an account prefix with nothing after it', 'https://drive.google.com/u/0'],
      ['an account prefix in front of the Drive home page', 'https://drive.google.com/u/0/drive/my-drive'],
      ['an account prefix in front of a Form', `https://docs.google.com/u/0/forms/d/e/${ID}/viewform`],
      ['an account prefix and a bad id', 'https://drive.google.com/u/0/uc?id=../../x'],
      ['an account prefix and a published Doc', `https://docs.google.com/a/acme.com/document/d/e/2PACX-${ID}/pub`],
    ])('still refuses %s', (_name, url) => {
      expect(parse(url).ok).toBe(false);
    });

    it('a "/a/" that is really a document keyword is not read as a domain', () => {
      expect(parse(`https://docs.google.com/a/document/d/${ID}/edit`).ok).toBe(false);
    });

    it('is linear on a hostile path of thousands of account segments', () => {
      const started = Date.now();
      for (const prefix of ['/u/0'.repeat(30_000), '/a/x'.repeat(30_000), '/u/0/a/x'.repeat(15_000)]) {
        expect(parse(`https://drive.google.com${prefix}/uc?id=${ID}`)).toEqual(target('file'));
        expect(parse(`https://drive.google.com${prefix}/zzz?id=${ID}`).ok).toBe(false);
        expect(parse(`https://docs.google.com${prefix}/document/d/${ID}/edit`)).toEqual(target('doc'));
        expect(parse(`https://docs.google.com${prefix}/nothing`).ok).toBe(false);
      }
      expect(parse(`https://drive.google.com/open${'/'.repeat(100_000)}?id=${ID}`)).toEqual(target('file'));
      expect(Date.now() - started).toBeLessThan(1500);
    });
  });

  it('"open?id=" says nothing about the type, so the classified platform breaks the tie', () => {
    const url = `https://drive.google.com/open?id=${ID}`;
    expect(parse(url, 'gdrive_folder')).toEqual(target('folder'));
    expect(parse(url, 'google_doc')).toEqual(target('doc'));
    expect(parse(url, 'google_slides')).toEqual(target('slides'));
    expect(parse(url, 'google_sheet')).toEqual(target('sheet'));
    expect(parse(url, 'gdrive_file')).toEqual(target('file'));
    expect(parse(url, 'pdf_file')).toEqual(target('file'));
  });

  it('a path that names the type wins over the platform', () => {
    expect(parse(`https://docs.google.com/document/d/${ID}/edit`, 'gdrive_folder')).toEqual(target('doc'));
  });

  it('carries a well-formed resourcekey through, and drops a malformed one', () => {
    expect(parse(`https://drive.google.com/file/d/${ID}/view?resourcekey=0-AbC_dEf-123`)).toEqual(target('file', { resourceKey: '0-AbC_dEf-123' }));
    for (const bad of ['', 'a', 'x/../y', 'a b c', '<script>', 'k'.repeat(101)]) {
      expect(parse(`https://drive.google.com/file/d/${ID}/view?resourcekey=${encodeURIComponent(bad)}`)).toEqual(target('file'));
    }
  });

  it.each([
    ['dot-dot path', 'https://drive.google.com/file/d/../../etc/passwd/view'],
    ['encoded dot-dot', 'https://drive.google.com/file/d/..%2F..%2Fetc%2Fpasswd/view'],
    ['double-encoded dot-dot', 'https://drive.google.com/file/d/%252e%252e%252f%252e%252e/view'],
    ['id too short', 'https://drive.google.com/file/d/abc123/view'],
    ['empty id', 'https://drive.google.com/file/d//view'],
    ['id with a dot', 'https://drive.google.com/file/d/abc.defghijkl/view'],
    ['id with a space', 'https://drive.google.com/file/d/abcdefgh%20ijkl/view'],
    ['query id is a path', 'https://drive.google.com/open?id=../../x'],
    ['query id is encoded', 'https://drive.google.com/open?id=..%2F..%2Fsecret'],
    ['query id is missing', 'https://drive.google.com/open'],
    ['query id is empty', 'https://drive.google.com/uc?id='],
    ['query id carries a URL', 'https://drive.google.com/uc?id=https://evil.example/x'],
    ['id longer than 200', `https://drive.google.com/file/d/${'a'.repeat(201)}/view`],
  ])('rejects %s', (_name, url) => {
    const r = parse(url);
    expect(r.ok).toBe(false);
  });

  it('says plainly what kinds it does not open', () => {
    expect(parse(`https://docs.google.com/forms/d/e/${ID}/viewform`)).toMatchObject({ ok: false, reason: expect.stringMatching(/not opened/) });
    expect(parse(`https://docs.google.com/drawings/d/${ID}/edit`)).toMatchObject({ ok: false });
    expect(parse('https://drive.google.com/drive/my-drive')).toMatchObject({ ok: false });
    expect(parse('https://drive.google.com/')).toMatchObject({ ok: false });
    expect(parse(`https://docs.google.com/document/d/e/2PACX-${ID}/pub`)).toMatchObject({ ok: false, reason: expect.stringMatching(/published to the web/) });
  });
});

describe('googleFetchUrl', () => {
  it('builds the exact public URL for each kind, on a fixed Google host', () => {
    expect(googleFetchUrl({ kind: 'file', id: ID })).toBe(`https://drive.google.com/uc?export=download&id=${ID}`);
    expect(googleFetchUrl({ kind: 'doc', id: ID })).toBe(`https://docs.google.com/document/d/${ID}/export?format=pdf`);
    expect(googleFetchUrl({ kind: 'slides', id: ID })).toBe(`https://docs.google.com/presentation/d/${ID}/export/pdf`);
    expect(googleFetchUrl({ kind: 'sheet', id: ID })).toBe(`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv`);
    expect(googleFetchUrl({ kind: 'folder', id: ID })).toBe(`https://drive.google.com/embeddedfolderview?id=${ID}`);
  });

  it('adds the resource key where each URL form takes it', () => {
    const resourceKey = '0-AbC_dEf';
    expect(googleFetchUrl({ kind: 'file', id: ID, resourceKey })).toBe(`https://drive.google.com/uc?export=download&id=${ID}&resourcekey=${resourceKey}`);
    expect(googleFetchUrl({ kind: 'doc', id: ID, resourceKey })).toBe(`https://docs.google.com/document/d/${ID}/export?format=pdf&resourcekey=${resourceKey}`);
    expect(googleFetchUrl({ kind: 'slides', id: ID, resourceKey })).toBe(`https://docs.google.com/presentation/d/${ID}/export/pdf?resourcekey=${resourceKey}`);
    expect(googleFetchUrl({ kind: 'sheet', id: ID, resourceKey })).toBe(`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&resourcekey=${resourceKey}`);
    expect(googleFetchUrl({ kind: 'folder', id: ID, resourceKey })).toBe(`https://drive.google.com/embeddedfolderview?id=${ID}&resourcekey=${resourceKey}`);
  });

  it('refuses to build a URL from an id or key that was not validated, even in a hand-built target', () => {
    for (const kind of ['file', 'doc', 'slides', 'sheet', 'folder'] as const) {
      expect(() => googleFetchUrl({ kind, id: '../..' })).toThrow('invalid Google id');
      expect(() => googleFetchUrl({ kind, id: `${ID}/../x` })).toThrow('invalid Google id');
      expect(() => googleFetchUrl({ kind, id: `${ID}&export=pdf` })).toThrow('invalid Google id');
    }
    expect(googleFetchUrl({ kind: 'file', id: ID, resourceKey: 'x/../y' })).toBe(`https://drive.google.com/uc?export=download&id=${ID}`);   // a bad key is dropped, not injected
  });

  it('every URL it builds is https on one of the three Google hosts', () => {
    for (const kind of ['file', 'doc', 'slides', 'sheet', 'folder'] as const) {
      const u = new URL(googleFetchUrl({ kind, id: ID, resourceKey: '0-abc' }));
      expect(u.protocol).toBe('https:');
      expect(isGoogleFileHost(u.hostname)).toBe(true);
      expect(u.username + u.password).toBe('');
    }
  });
});

describe('classifyDownloadPage', () => {
  const page = (title: string, body = '') => `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;

  it.each([
    ['a Google sign-in page by its title', page('Sign in - Google Accounts'), undefined],
    ['a sign-in page by its title alone', page('Sign in'), undefined],
    ['a sign-in page by the final host', page('Google Drive'), 'https://accounts.google.com/v3/signin/identifier?continue=x'],
    ['a sign-in page by its ServiceLogin form', page('Google', '<form action="https://accounts.google.com/ServiceLogin">'), undefined],
    ['"You need access"', page('Google Drive', '<h1>You need access</h1><p>Ask for access, or switch to an account with access.</p>'), undefined],
    ['"You need permission"', page('Google Docs', '<div>You need permission to view this document</div>'), undefined],
    ['"Request access"', page('Drive', '<button>Request access</button>'), undefined],
    ['the file-does-not-exist page', page('Google Drive - Page Not Found', '<p>Sorry, the file you have requested does not exist.</p>'), undefined],
    ['the unable-to-open page', page('Google Docs', 'Sorry, unable to open the file at this time. Please check the address and try again.'), undefined],
    ['a plain 404 page', page('Error 404 (Not Found)!!1', '<p>The requested URL /x was not found on this server.</p>'), undefined],
  ])('google: %s is private', (_name, html, finalUrl) => {
    expect(classifyDownloadPage(html, { hostKind: 'google', finalUrl })).toBe('private');
  });

  it('google: the quota page is quota, even though it also invites you to sign in', () => {
    const html = page('Google Drive - Quota exceeded', '<p>Sorry, you can\'t view or download this file at this time.</p><p>Too many users have viewed or downloaded this file recently.</p><a>Sign in</a>');
    expect(classifyDownloadPage(html, { hostKind: 'google' })).toBe('quota');
    expect(classifyDownloadPage(page('x', 'Download quota exceeded for this file'), { hostKind: 'google' })).toBe('quota');
  });

  it('google: quota is decided before "private", whatever else the page says', () => {
    const both = page('Sign in', 'Too many users have viewed or downloaded this file recently. You need access. Request access.');
    expect(classifyDownloadPage(both, { hostKind: 'google', finalUrl: 'https://accounts.google.com/x' })).toBe('quota');
    const virus = page('Sign in', "Google Drive can't scan this file for viruses. Request access.");
    expect(classifyDownloadPage(virus, { hostKind: 'google' })).toBe('too_large_to_scan');
  });

  it('google: the virus-scan interstitial for big files', () => {
    for (const body of ["Google Drive can't scan this file for viruses.", 'Virus scan warning', '<a href="/uc?confirm=t">Download anyway</a>', 'Google Drive can’t scan this file for viruses.']) {
      expect(classifyDownloadPage(page('Google Drive - Virus scan warning', body), { hostKind: 'google' })).toBe('too_large_to_scan');
    }
  });

  it('google: "unusual traffic" is OUR block, not the candidate\'s file', () => {
    expect(classifyDownloadPage(page('Sorry...', 'Our systems have detected unusual traffic from your computer network.'), { hostKind: 'google' })).toBe('google_blocked');
    expect(classifyDownloadPage(page('x'), { hostKind: 'google', finalUrl: 'https://www.google.com/sorry/index?continue=x' })).toBe('google_blocked');
  });

  it('google: a page it does not recognise is unknown, never private', () => {
    expect(classifyDownloadPage(page('Some report', '<p>Quarterly numbers</p>'), { hostKind: 'google' })).toBe('unknown');
    expect(classifyDownloadPage('', { hostKind: 'google' })).toBe('unknown');
  });

  it('is case-insensitive, whitespace-tolerant, and treats curly apostrophes like straight ones', () => {
    expect(classifyDownloadPage(page('x', 'YOU   NEED\n\tACCESS'), { hostKind: 'google' })).toBe('private');
    expect(classifyDownloadPage(page('x', "Google Drive can’t scan this file for viruses"), { hostKind: 'google' })).toBe('too_large_to_scan');
  });

  it('only reads the first 200 KB of a page', () => {
    expect(classifyDownloadPage(page('x', `${'a '.repeat(150_000)}You need access`), { hostKind: 'google' })).toBe('unknown');
    expect(classifyDownloadPage(page('x', `${'a '.repeat(50_000)}You need access`), { hostKind: 'google' })).toBe('private');
  });

  it.each([
    ['a sign-in page by its title', page('Login - Dropbox'), undefined],
    ['a sign-in page by its text', page('Dropbox', 'Sign in or create an account to continue'), undefined],
    ['a sign-in page by the final path', page('Dropbox'), 'https://www.dropbox.com/login?cont=x'],
    ['a deleted item', page('Dropbox', 'This item might have been deleted or the link is no longer valid.'), undefined],
    ['an error 404', page('Dropbox - Error', '<h1>Error (404)</h1>'), undefined],
    ['a disabled link', page('Dropbox', 'This link has been disabled.'), undefined],
  ])('dropbox: %s is private', (_name, html, finalUrl) => {
    expect(classifyDownloadPage(html, { hostKind: 'dropbox', finalUrl })).toBe('private');
  });

  it('dropbox: a link disabled for traffic is quota', () => {
    expect(classifyDownloadPage(page('Dropbox - Error (429)', "This account's links are generating too much traffic and have been temporarily disabled!"), { hostKind: 'dropbox' })).toBe('quota');
  });

  it('the Google and Dropbox wording means nothing on a candidate\'s own site, or on OneDrive', () => {
    const html = page('Sign in', 'You need access. Request access. Error (404). This item might have been deleted.');
    expect(classifyDownloadPage(html, { hostKind: 'direct' })).toBe('unknown');
    expect(classifyDownloadPage(html, { hostKind: 'onedrive' })).toBe('unknown');
    expect(classifyDownloadPage(html, { hostKind: 'direct', finalUrl: 'https://accounts.google.com/x' })).toBe('unknown');
  });

  it.each([
    ['Cloudflare "Just a moment..."', page('Just a moment...', '<div id="challenge">Checking if the site connection is secure</div>')],
    ['Cloudflare challenge script', page('x', '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script>')],
    ['Cloudflare _cf_chl', page('x', '<script>window._cf_chl_opt={cvId:"2"}</script>')],
    ['Cloudflare interstitial', page('Attention Required! | Cloudflare', 'Sorry, you have been blocked')],
    ['Cloudflare browser check', page('x', 'Checking your browser before accessing example.com')],
    ['PerimeterX', page('Access to this page has been denied', '<div id="px-captcha"></div>')],
    ['hCaptcha', page('x', '<div class="h-captcha" data-sitekey="k"></div><script src="https://hcaptcha.com/1/api.js"></script>')],
    ['Akamai reference', page('Access Denied', "You don't have permission to access this server. Reference #18.2d351ab8.1557333295.a4e16ab")],
    ['JavaScript wall', page('x', 'Please enable JavaScript and cookies to continue')],
  ])('%s is a bot wall, on every kind of host', (_name, html) => {
    for (const hostKind of ['google', 'dropbox', 'onedrive', 'direct'] as const) {
      expect(classifyDownloadPage(html, { hostKind })).toBe('bot_wall');
    }
  });

  it('"Access denied" alone is not Akamai: it needs the reference number', () => {
    expect(classifyDownloadPage(page('Access Denied', 'You do not have access.'), { hostKind: 'direct' })).toBe('unknown');
  });

  it('exports plain-language reasons', () => {
    expect(PRIVATE_LINK_REASON).toBe('Link is private, deleted or does not allow automated access - ask the candidate to check that anyone with the link can view it');
    expect(BOT_WALL_REASON).toMatch(/blocks automated access/);
    expect(quotaReason('google')).toBe('Google limited downloads of this file');
    expect(quotaReason('dropbox')).toBe('Dropbox limited downloads of this file');
  });
});

// ─── folders ─────────────────────────────────────────────────────────────────

const driveFile = (fileId: string, title: string) =>
  `<div class="flip-entry" id="entry-${fileId}" tabindex="0" role="link" aria-label="${title}"><div class="flip-entry-list-icon"><img src="https://drive-thirdparty.googleusercontent.com/16/type/application/pdf"></div>`
  + `<div class="flip-entry-info"><a href="https://drive.google.com/file/d/${fileId}/view?usp=drive_web" target="_blank"><div class="flip-entry-title">${title}</div></a></div>`
  + '<div class="flip-entry-last-modified"><div>Jan 5, 2025</div></div></div>';
const workspaceEntry = (type: 'document' | 'presentation' | 'spreadsheets', fileId: string, title: string) =>
  `<div class="flip-entry" id="entry-${fileId}"><div class="flip-entry-info"><a href="https://docs.google.com/${type}/d/${fileId}/edit?usp=embed_facebook" target="_blank"><div class="flip-entry-title">${title}</div></a></div></div>`;
const subfolder = (fileId: string, title: string) =>
  `<div class="flip-entry" id="entry-${fileId}"><div class="flip-entry-info"><a href="https://drive.google.com/drive/folders/${fileId}" target="_blank"><div class="flip-entry-title">${title}</div></a></div></div>`;
const listing = (...entries: string[]) => `<!DOCTYPE html><html><head><title>Brand</title></head><body><div class="flip-entries">${entries.join('')}</div></body></html>`;

describe('parseFolderListing', () => {
  it('reads files, Docs, Slides, Sheets and subfolders, in page order, with their kinds', () => {
    const html = listing(
      driveFile(id('a'), 'Case Study - Aqua.pdf'),
      workspaceEntry('presentation', id('b'), 'Launch deck'),
      workspaceEntry('document', id('c'), 'Brand narrative'),
      workspaceEntry('spreadsheets', id('d'), 'Content calendar'),
      subfolder(id('e'), 'Old work'),
      driveFile(id('f'), 'Teaser.mp4'),
    );
    expect(parseFolderListing(html)).toEqual([
      { id: id('a'), title: 'Case Study - Aqua.pdf', kind: 'file' },
      { id: id('b'), title: 'Launch deck', kind: 'slides' },
      { id: id('c'), title: 'Brand narrative', kind: 'doc' },
      { id: id('d'), title: 'Content calendar', kind: 'sheet' },
      { id: id('e'), title: 'Old work', kind: 'folder' },
      { id: id('f'), title: 'Teaser.mp4', kind: 'file' },
    ]);
  });

  it('decodes entities in titles and drops markup inside them', () => {
    const html = listing(driveFile(id('a'), 'Q&amp;A &#39;24 &lt;final&gt;.pdf'), `<a href="https://drive.google.com/file/d/${id('b')}/view"><div class="x"><b>Bold</b> name.pdf</div></a>`);
    expect(parseFolderListing(html).map(e => e.title)).toEqual(["Q&A '24 <final>.pdf", 'Bold name.pdf']);
  });

  it('lists each file once even when the page links it twice', () => {
    const html = listing(driveFile(id('a'), 'One.pdf'), driveFile(id('a'), 'One again.pdf'));
    expect(parseFolderListing(html)).toHaveLength(1);
  });

  it('ignores links that are not Drive files: other hosts, sign-in, mailto, javascript, short ids', () => {
    const junk = [
      '<a href="https://evil.example/file/d/AAAAAAAAAAAAAAAAAAAA/view">x</a>',
      '<a href="https://accounts.google.com/ServiceLogin?continue=x">Sign in</a>',
      '<a href="mailto:a@b.co">mail</a>', '<a href="javascript:alert(1)">js</a>', '<a href="#top">top</a>',
      '<a href="https://drive.google.com/file/d/short/view">short</a>',
      '<a href="https://drive.google.com/file/d/../../x/view">dots</a>',
      '<a href="https://drive.google.com.evil.example/file/d/AAAAAAAAAAAAAAAAAAAA/view">lookalike</a>',
    ];
    expect(parseFolderListing(listing(...junk, driveFile(id('a'), 'Real.pdf')))).toEqual([{ id: id('a'), title: 'Real.pdf', kind: 'file' }]);
  });

  it('falls back to the older layout, where only the wrapper div carries the id', () => {
    const html = `<div class="flip-entry" id="entry-${id('a')}"><div class="flip-entry-info"><div class="flip-entry-title">Old layout.pdf</div></div></div>`
      + `<div class="flip-entry" id="entry-${id('b')}"><div class="flip-entry-title">Second.pptx</div></div>`;
    expect(parseFolderListing(html)).toEqual([
      { id: id('a'), title: 'Old layout.pdf', kind: 'file' },
      { id: id('b'), title: 'Second.pptx', kind: 'file' },
    ]);
  });

  it('returns nothing for a page with no listing (sign-in page, empty folder, garbage, empty string)', () => {
    expect(parseFolderListing('<html><title>Sign in</title><body>Sign in to continue</body></html>')).toEqual([]);
    expect(parseFolderListing(listing())).toEqual([]);
    expect(parseFolderListing('\u0000\u0001 not html at all')).toEqual([]);
    expect(parseFolderListing('')).toEqual([]);
  });

  it('stops at 100 entries', () => {
    const entries = Array.from({ length: 150 }, (_, i) => driveFile(`${String(i).padStart(3, '0')}${'x'.repeat(30)}`, `File ${i}.pdf`));
    expect(parseFolderListing(listing(...entries))).toHaveLength(100);
  });

  it('only reads the first 600 KB of the page', () => {
    const html = `${listing(driveFile(id('a'), 'First.pdf'))}${' '.repeat(700_000)}${driveFile(id('b'), 'Late.pdf')}`;
    expect(parseFolderListing(html).map(e => e.title)).toEqual(['First.pdf']);
  });

  it('survives hostile markup in bounded time: tens of thousands of unclosed anchors, a huge attribute', () => {
    const t0 = Date.now();
    parseFolderListing(`<a href="https://drive.google.com/file/d/${id('a')}/view">`.repeat(8_000));
    parseFolderListing(`<a ${'x '.repeat(100_000)} href="https://drive.google.com/file/d/${id('a')}/view">no end`);
    parseFolderListing(`id="entry-${id('a')}" `.repeat(10_000));
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('rankFolderFiles', () => {
  const file = (title: string, kind: GoogleKind = 'file', fid = title): FolderEntry => ({ id: fid.padEnd(12, '_'), title, kind });
  const titles = (entries: FolderEntry[]) => rankFolderFiles(entries).map(e => e.title);

  it('puts pdf first, then pptx, Google Slides, docx / Google Docs, then images, then Sheets', () => {
    expect(titles([
      file('a.png'), file('b.docx'), file('Sheet', 'sheet'), file('c.pdf'), file('Slides', 'slides'), file('d.pptx'), file('Doc', 'doc'), file('e.jpg'),
    ])).toEqual(['c.pdf', 'd.pptx', 'Slides', 'b.docx', 'Doc', 'a.png', 'e.jpg', 'Sheet']);
  });

  it('a name that says case study / campaign / deck / portfolio / work moves a file up', () => {
    expect(titles([file('random.pdf'), file('Aqua campaign.docx')])).toEqual(['random.pdf', 'Aqua campaign.docx']);   // 70 + 25 < 100
    expect(titles([file('random.pdf'), file('Launch deck.pptx')])).toEqual(['Launch deck.pptx', 'random.pdf']);        // 90 + 25 > 100
    expect(titles([file('b.png'), file('my_portfolio_2025.png')])).toEqual(['my_portfolio_2025.png', 'b.png']);
    expect(titles([file('plain.pdf'), file('case-study.pdf')])).toEqual(['case-study.pdf', 'plain.pdf']);
    expect(titles([file('x.pdf'), file('Case Studies.pdf')])).toEqual(['Case Studies.pdf', 'x.pdf']);
    expect(titles([file('x.png'), file('Brand WORK.png')])).toEqual(['Brand WORK.png', 'x.png']);
  });

  it('matches whole words only: "network" is not "work", "decked" is not "deck"', () => {
    expect(titles([file('a.png'), file('network.png'), file('decked.png')])).toEqual(['a.png', 'network.png', 'decked.png']);
  });

  it('never opens subfolders, video, archives, design sources, legacy Office or spreadsheets files', () => {
    expect(titles([
      file('Old', 'folder'), file('film.mp4'), file('film.mov'), file('all.zip'), file('design.psd'), file('design.ai'), file('book.indd'),
      file('old.ppt'), file('old.doc'), file('numbers.xlsx'), file('notes.txt'), file('page.html'), file('archive.rar'), file('ok.pdf'),
    ])).toEqual(['ok.pdf']);
  });

  it('a file with no extension is tried, but after everything with a known type', () => {
    expect(titles([file('Mystery upload'), file('shot.png'), file('Mystery 2')])).toEqual(['shot.png', 'Mystery upload', 'Mystery 2']);
  });

  it('is case-insensitive about extensions and keeps page order among equals', () => {
    expect(titles([file('B.PDF', 'file', 'b'), file('A.pdf', 'file', 'a'), file('C.Pdf', 'file', 'c')])).toEqual(['B.PDF', 'A.pdf', 'C.Pdf']);
  });

  it('returns every eligible file; the caller takes the first MAX_FOLDER_FILES', () => {
    const many = Array.from({ length: 9 }, (_, i) => file(`f${i}.pdf`));
    expect(rankFolderFiles(many)).toHaveLength(9);
    expect(MAX_FOLDER_FILES).toBe(4);
  });

  it('an empty or all-ineligible folder ranks to nothing', () => {
    expect(rankFolderFiles([])).toEqual([]);
    expect(rankFolderFiles([file('x.mp4'), file('d', 'folder')])).toEqual([]);
  });
});
