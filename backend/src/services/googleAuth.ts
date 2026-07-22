import fs from 'fs';

// Shared by driveService.ts and calendarService.ts — both are service-account-
// backed Google API clients reading the same key from one of two sources:
//   1. GOOGLE_APPLICATION_CREDENTIALS_JSON — full JSON key as a string (Vercel)
//   2. GOOGLE_APPLICATION_CREDENTIALS — file path (local Docker, volume mount)
export function getGoogleCredentials(): { client_email: string; private_key: string; [k: string]: unknown } {
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
