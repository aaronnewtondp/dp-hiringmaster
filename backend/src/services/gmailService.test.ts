import { describe, it, expect, vi, beforeEach } from 'vitest';

// sendAssignmentEmail: assignment mails must always come from the shared HR inbox (a fixed impersonation subject), never from the HR user who pressed Send.
// The real nodemailer MailComposer builds the message, so what is checked is the RFC822 text that would actually go to Gmail (decoded from the base64url
// "raw" field). googleapis and the credentials are faked: no network, no key.
const g = vi.hoisted(() => ({
  composerOptions: [] as Array<Record<string, unknown>>,
  send: vi.fn(),
  jwtOptions: [] as Array<Record<string, unknown>>,
  gmailOptions: [] as Array<Record<string, unknown>>,
  credentials: vi.fn(),
}));
vi.mock('./googleAuth.js', () => ({ getGoogleCredentials: () => g.credentials() }));
vi.mock('googleapis', () => ({
  google: {
    auth: { JWT: class { constructor(o: Record<string, unknown>) { g.jwtOptions.push(o); } } },
    gmail: (o: Record<string, unknown>) => { g.gmailOptions.push(o); return { users: { messages: { send: g.send } } }; },
  },
}));

// The real MailComposer, but every option set it is given is recorded, so the exact keys the service passes (no bcc, replyTo or attachments) are pinned.
vi.mock('nodemailer/lib/mail-composer/index.js', async importOriginal => {
  const actual = await importOriginal<{ default: new (o: Record<string, unknown>) => object }>();
  const Real = actual.default;
  return { default: class extends Real { constructor(o: Record<string, unknown>) { g.composerOptions.push(o); super(o); } } };
});

import { sendAssignmentEmail } from './gmailService.js';

const HR = 'hr@digitalpaani.com';
const INPUT = { to: 'candidate@example.test', subject: 'Assignment for Synthetic Role', text: 'Hello,\nPlease find the assignment link below.\nThanks' };

const sentArgs = () => g.send.mock.calls[0][0];
const raw = () => sentArgs().requestBody.raw as string;
const rfc822 = () => Buffer.from(raw(), 'base64url').toString('utf8');
// Header block only (up to the first blank line), unfolded.
const headers = () => rfc822().split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
const headerLines = () => headers().split(/\r?\n/);
const header = (name: string) => headerLines().find(l => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));

beforeEach(() => {
  g.send.mockReset().mockResolvedValue({ data: { id: 'msg-001' } });
  g.jwtOptions.length = 0; g.gmailOptions.length = 0; g.composerOptions.length = 0;
  g.credentials.mockReset().mockReturnValue({ client_email: 'sa@example.iam.test', private_key: 'placeholder-key' });
});

describe('sendAssignmentEmail: who it is sent as', () => {
  it('the JWT impersonates the fixed shared HR inbox with the service account identity and the gmail.send scope only', async () => {
    await sendAssignmentEmail(INPUT);
    expect(g.jwtOptions).toEqual([{ email: 'sa@example.iam.test', key: 'placeholder-key', scopes: ['https://www.googleapis.com/auth/gmail.send'], subject: HR }]);
    expect(g.gmailOptions[0].version).toBe('v1');
  });

  it('sends as "me" (= the impersonated HR inbox)', async () => {
    await sendAssignmentEmail(INPUT);
    expect(sentArgs().userId).toBe('me');
  });

  it('the From header is the HR inbox', async () => {
    await sendAssignmentEmail(INPUT);
    expect(header('From')).toContain(HR);
  });

  it('a caller cannot change the sender: an extra "from" or "sender" on the input is ignored', async () => {
    await sendAssignmentEmail({ ...INPUT, from: 'someone.else@example.test', sender: 'other@example.test', replyTo: 'x@example.test' } as typeof INPUT);
    expect(header('From')).toContain(HR);
    expect(rfc822()).not.toContain('someone.else@example.test');
    expect(rfc822()).not.toContain('other@example.test');
  });
});

describe('sendAssignmentEmail: the message that is built', () => {
  it('"raw" is base64url (no +, / or = characters) and decodes to an RFC822 message', async () => {
    await sendAssignmentEmail(INPUT);
    expect(raw()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(rfc822()).toMatch(/^[A-Za-z-]+: /);
  });

  it('carries To, Subject and the body text', async () => {
    await sendAssignmentEmail(INPUT);
    expect(header('To')).toContain('candidate@example.test');
    expect(header('Subject')).toContain('Assignment for Synthetic Role');
    expect(rfc822()).toContain('Please find the assignment link below.');
    expect(header('Content-Type')?.toLowerCase()).toContain('text/plain');
  });

  it('a Cc list is on the message, every address', async () => {
    await sendAssignmentEmail({ ...INPUT, cc: ['one@example.test', 'two@example.test'] });
    const cc = header('Cc') ?? '';
    expect(cc).toContain('one@example.test');
    expect(cc).toContain('two@example.test');
  });

  it.each([[undefined], [[]]])('no Cc header at all when cc is %j', async cc => {
    await sendAssignmentEmail({ ...INPUT, cc: cc as string[] | undefined });
    expect(header('Cc')).toBeUndefined();
    expect(g.composerOptions[0].cc).toBeUndefined();
  });

  it('the composer is given exactly from, to, cc, subject and text: no bcc, replyTo or attachments can ride along', async () => {
    await sendAssignmentEmail({ ...INPUT, cc: ['one@example.test'], bcc: 'hidden@example.test', attachments: [{ filename: 'x' }], replyTo: 'r@example.test' } as typeof INPUT);
    expect(g.composerOptions).toHaveLength(1);
    expect(Object.keys(g.composerOptions[0]).sort()).toEqual(['cc', 'from', 'subject', 'text', 'to']);
    expect(g.composerOptions[0]).toEqual({ from: HR, to: INPUT.to, cc: ['one@example.test'], subject: INPUT.subject, text: INPUT.text });
  });

  it('the message is a single text/plain part: supporting documents are links in the body, not attachments', async () => {
    await sendAssignmentEmail({ ...INPUT, text: 'See https://drive.example.test/file/d/ABC/view' });
    expect(rfc822().toLowerCase()).not.toContain('multipart/');
    expect(rfc822()).toContain('https://drive.example.test/file/d/ABC/view');
  });

  const ALLOWED_HEADERS = ['from', 'to', 'cc', 'subject', 'message-id', 'content-transfer-encoding', 'date', 'mime-version', 'content-type'];
  const headerNames = () => headerLines().map(l => l.split(':')[0].toLowerCase());

  it('an ordinary message carries only the expected headers', async () => {
    await sendAssignmentEmail({ ...INPUT, cc: ['one@example.test'] });
    expect(headerNames().filter(n => !ALLOWED_HEADERS.includes(n))).toEqual([]);
  });

  it('a newline typed into the subject cannot add a header (it is flattened into the subject line)', async () => {
    await sendAssignmentEmail({ ...INPUT, subject: 'Hello\r\nBcc: attacker@example.test\r\nX-Injected: yes' });
    expect(headerNames().filter(n => !ALLOWED_HEADERS.includes(n))).toEqual([]);
    expect(header('Subject')).toContain('Hello');
  });

  it('a newline typed into the recipient cannot add a header either', async () => {
    await sendAssignmentEmail({ ...INPUT, to: 'candidate@example.test\r\nX-Injected: yes' });
    expect(headerNames().filter(n => !ALLOWED_HEADERS.includes(n))).toEqual([]);
  });
});

describe('sendAssignmentEmail: the result', () => {
  it('returns the Gmail message id', async () => {
    expect(await sendAssignmentEmail(INPUT)).toEqual({ messageId: 'msg-001' });
  });

  it.each([[undefined], [''], [null]])('a send with no id (%j) is an error, not a silent success', async id => {
    g.send.mockResolvedValue({ data: { id } });
    await expect(sendAssignmentEmail(INPUT)).rejects.toThrow('Gmail send succeeded but no message ID was returned');
  });

  it('an API error is not swallowed (the caller records it on the round and offers a retry)', async () => {
    g.send.mockRejectedValue(new Error('synthetic Gmail API failure'));
    await expect(sendAssignmentEmail(INPUT)).rejects.toThrow('synthetic Gmail API failure');
  });

  it('missing credentials fail before anything is sent', async () => {
    g.credentials.mockImplementation(() => { throw new Error('No Google service account credentials found.'); });
    await expect(sendAssignmentEmail(INPUT)).rejects.toThrow('No Google service account credentials found.');
    expect(g.send).not.toHaveBeenCalled();
  });
});
