import { google } from 'googleapis';
import fs from 'fs';

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
  const pdfParse = (await import('pdf-parse')).default;
  const result = await pdfParse(buffer);
  return result.text;
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}
