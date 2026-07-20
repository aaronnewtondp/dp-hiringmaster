import { google } from 'googleapis';
import fs from 'fs';
import { Readable } from 'stream';

// ─── Service account auth ──────────────────────────────────────────────────────
// Supports two credential sources:
//   1. GOOGLE_APPLICATION_CREDENTIALS_JSON — full JSON key as a string (Vercel)
//   2. GOOGLE_APPLICATION_CREDENTIALS — file path (local Docker, volume mount)
function getCredentials() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    return JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  }
  const filePath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (filePath && fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  throw new Error(
    'No Google service account credentials found. Set GOOGLE_APPLICATION_CREDENTIALS_JSON or GOOGLE_APPLICATION_CREDENTIALS.'
  );
}

let driveClient: ReturnType<typeof google.drive> | null = null;

function getDriveClient() {
  if (driveClient) return driveClient;
  const credentials = getCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

// ─── Write-scoped client (JD PDF uploads) ──────────────────────────────────────
// Separate singleton from getDriveClient() above: that one is scoped
// drive.readonly for resume fetching and can't create/write files.
//
// Confirmed by testing against the real API: a bare service account has NO
// storage quota of its own ("Service Accounts do not have storage quota...
// use OAuth delegation instead") — it cannot create files even in a folder
// shared with it as Editor. This uses domain-wide delegation instead: the
// service account impersonates a real Workspace user (GOOGLE_DRIVE_IMPERSONATE_EMAIL)
// via JWT `subject`, so uploads use that user's real Drive storage/ownership.
// Requires a Google Workspace admin to authorize this service account's
// OAuth Client ID for domain-wide delegation (Admin Console → Security → API
// Controls → Domain-wide Delegation) with scope
// https://www.googleapis.com/auth/drive.file — see .env.example.
let driveWriteClient: ReturnType<typeof google.drive> | null = null;

function getDriveWriteClient() {
  if (driveWriteClient) return driveWriteClient;
  const credentials = getCredentials();
  const impersonate = process.env.GOOGLE_DRIVE_IMPERSONATE_EMAIL;
  if (!impersonate) {
    throw new Error(
      'GOOGLE_DRIVE_IMPERSONATE_EMAIL is not set — required for domain-wide-delegated Drive uploads.'
    );
  }
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
    subject: impersonate,
  });
  driveWriteClient = google.drive({ version: 'v3', auth });
  return driveWriteClient;
}

export interface UploadedFile {
  fileId: string;
  webViewLink: string;
}

// Uploads a generated PDF into folderId and restricts sharing to the
// digitalpaani.com domain — consistent with the org's existing
// @digitalpaani.com-only access model, rather than "anyone with the link."
// Throws on failure — callers (the JD-generation trigger) already wrap this
// in a try/catch and skip writing the role's *_drive_link columns on error,
// so a failed upload naturally allows a retry on the next role edit.
//
// supportsAllDrives is required if folderId lives inside a Shared Drive —
// confirmed necessary in practice: a bare service account has NO storage
// quota of its own (Drive API error: "Service Accounts do not have storage
// quota. Leverage shared drives... or use OAuth delegation instead"), so
// writing into a folder shared with it in someone's regular "My Drive" fails
// with a 403 regardless of Editor permission. The folder must be inside a
// Shared Drive (with the service account added as a member), or the service
// account needs domain-wide delegation to impersonate a real user.
export async function uploadJdPdf(
  buffer: Buffer,
  filename: string,
  folderId: string
): Promise<UploadedFile> {
  const drive = getDriveWriteClient();

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
      mimeType: 'application/pdf',
    },
    media: {
      mimeType: 'application/pdf',
      body: Readable.from(buffer),
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });

  const fileId = res.data.id;
  if (!fileId) {
    throw new Error(`[Drive] Upload of ${filename} did not return a file ID`);
  }

  await drive.permissions.create({
    fileId,
    requestBody: { type: 'domain', domain: 'digitalpaani.com', role: 'reader' },
    supportsAllDrives: true,
  });

  return {
    fileId,
    webViewLink: res.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
  };
}

export function extractDriveFileId(url: string): string | null {
  const openMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (openMatch) return openMatch[1];
  const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return fileMatch[1];
  return null;
}

// Returns null on any failure — scoring should degrade gracefully rather than crash.
export async function fetchResumeText(driveUrl: string): Promise<string | null> {
  const fileId = extractDriveFileId(driveUrl);
  if (!fileId) {
    console.warn(`[Drive] Could not extract file ID from: ${driveUrl}`);
    return null;
  }

  try {
    const drive = getDriveClient();
    const meta = await drive.files.get({ fileId, fields: 'mimeType, name' });
    const mimeType = meta.data.mimeType || '';

    if (mimeType === 'application/vnd.google-apps.document') {
      const res = await drive.files.export(
        { fileId, mimeType: 'text/plain' },
        { responseType: 'text' }
      );
      return res.data as unknown as string;
    }

    if (mimeType === 'application/pdf' || mimeType.includes('wordprocessingml')) {
      const res = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'arraybuffer' }
      );
      const buffer = Buffer.from(res.data as ArrayBuffer);
      return mimeType === 'application/pdf'
        ? await extractPdfText(buffer)
        : await extractDocxText(buffer);
    }

    console.warn(`[Drive] Unsupported mime type for resume: ${mimeType}`);
    return null;
  } catch (err) {
    console.error(`[Drive] Failed to fetch resume ${fileId}:`, (err as Error).message);
    return null;
  }
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return result.text;
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}
