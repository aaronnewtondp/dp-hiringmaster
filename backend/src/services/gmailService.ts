import { google } from 'googleapis';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { getGoogleCredentials } from './googleAuth.js';

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

// Fixed subject, unlike calendarService.ts's per-request impersonation —
// assignment emails must always appear to come from the shared HR inbox,
// never the individual HR user who clicked Send.
const HR_EMAIL = 'hr@digitalpaani.com';

function getGmailClient() {
  const credentials = getGoogleCredentials();
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: GMAIL_SCOPES,
    subject: HR_EMAIL,
  });
  return google.gmail({ version: 'v1', auth });
}

export interface SendAssignmentEmailInput {
  to:      string;
  cc?:     string[];
  subject: string;
  text:    string;
}

// Throws on failure — the caller (interviews.ts's attemptAssignmentEmail)
// treats a failed send as non-fatal, visible degradation, same as a failed
// Calendar invite: the round row is already committed by the time this runs.
export async function sendAssignmentEmail(input: SendAssignmentEmailInput): Promise<{ messageId: string }> {
  // MailComposer builds a correct RFC822 MIME buffer (headers, encoding) so
  // this doesn't hand-roll one — no attachments needed since supporting docs
  // are just links in the body text, not files.
  const mail = new MailComposer({
    from:    HR_EMAIL,
    to:      input.to,
    cc:      input.cc?.length ? input.cc : undefined,
    subject: input.subject,
    text:    input.text,
  });

  const message: Buffer = await new Promise((resolve, reject) => {
    mail.compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });

  const gmail = getGmailClient();
  const res = await gmail.users.messages.send({
    userId: 'me', // refers to the impersonated subject (hr@digitalpaani.com)
    requestBody: { raw: message.toString('base64url') },
  });

  const messageId = res.data.id;
  if (!messageId) throw new Error('Gmail send succeeded but no message ID was returned');
  return { messageId };
}
