import { google } from 'googleapis';
import { Readable } from 'stream';
import { getGoogleCredentials } from './googleAuth.js';

let driveClient: ReturnType<typeof google.drive> | null = null;

function getDriveClient() {
  if (driveClient) return driveClient;
  const credentials = getGoogleCredentials();
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
  const credentials = getGoogleCredentials();
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

// pdf-parse v2 wraps pdfjs-dist, which tries to polyfill the browser globals
// DOMMatrix/ImageData/Path2D from the optional native package
// @napi-rs/canvas on startup — and if that polyfill step fails, it only
// *warns* ("Cannot polyfill `DOMMatrix`..."), not throws. The actual crash
// comes moments later: a pdfjs-dist submodule has an UNCONDITIONAL,
// module-level `new DOMMatrix()` (used as a scratch matrix for glyph/
// pattern-fill transforms) that executes the instant that submodule is
// evaluated — which happens for plain getText() too, not just rendering.
//
// On Vercel this submodule genuinely can't be found ("Cannot find module
// '@napi-rs/canvas'") — confirmed via production logs — most likely
// because @napi-rs/canvas ships its native binary as a platform-matched
// optionalDependency, and Vercel's build-time file tracer doesn't reliably
// follow pdf-parse's try/catch-wrapped `require('@napi-rs/canvas')` to
// bundle it. Adding @napi-rs/canvas as an explicit dependency doesn't fix
// this on its own — it's already resolved locally and still gets dropped
// in the exact same way in the Vercel bundle.
//
// Fix: install dependency-free, pure-JS polyfills for the three globals
// ourselves, before pdf-parse's module graph ever evaluates. This can't
// suffer the same "native binary didn't bundle" failure mode again, since
// there's no package to drop — it's inline TS. DOMMatrix needs REAL 2D
// affine matrix math (it drives glyph transform/position, which affects
// the actual characters and order text extraction produces) — implemented
// per the WHATWG spec's 2D matrix semantics. ImageData/Path2D are only
// exercised by pdf-parse for actual canvas rendering (mesh/gradient fills,
// Type3-font glyph outlines) that has nowhere real to draw without a
// native canvas backing it anyway, so safe, non-throwing stubs are enough
// — correctness there doesn't affect extracted text, only avoiding a
// ReferenceError does.
class DOMMatrixPolyfill {
  a: number; b: number; c: number; d: number; e: number; f: number;
  constructor(init?: DOMMatrixPolyfill | number[] | { a: number; b: number; c: number; d: number; e: number; f: number }) {
    if (Array.isArray(init) && init.length >= 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init;
    } else if (init && typeof init === 'object') {
      ({ a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f } = init as DOMMatrixPolyfill);
    } else {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
    }
  }
  multiply(o: DOMMatrixPolyfill): DOMMatrixPolyfill {
    return new DOMMatrixPolyfill([
      this.a * o.a + this.c * o.b, this.b * o.a + this.d * o.b,
      this.a * o.c + this.c * o.d, this.b * o.c + this.d * o.d,
      this.a * o.e + this.c * o.f + this.e, this.b * o.e + this.d * o.f + this.f,
    ]);
  }
  multiplySelf(o: DOMMatrixPolyfill): this {
    ({ a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f } = this.multiply(o));
    return this;
  }
  preMultiplySelf(o: DOMMatrixPolyfill): this {
    ({ a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f } = o.multiply(this));
    return this;
  }
  translate(tx: number, ty: number): DOMMatrixPolyfill {
    return this.multiply(new DOMMatrixPolyfill([1, 0, 0, 1, tx, ty]));
  }
  scale(sx: number, sy: number = sx): DOMMatrixPolyfill {
    return this.multiply(new DOMMatrixPolyfill([sx, 0, 0, sy, 0, 0]));
  }
  invertSelf(): this {
    const det = this.a * this.d - this.b * this.c;
    const { a, b, c, d, e, f } = this;
    this.a = d / det; this.b = -b / det; this.c = -c / det; this.d = a / det;
    this.e = (c * f - d * e) / det; this.f = (b * e - a * f) / det;
    return this;
  }
  setTransform(o: DOMMatrixPolyfill): this {
    ({ a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f } = o);
    return this;
  }
}

class Path2DPolyfill {
  constructor(_path?: unknown) {}
  addPath() {} moveTo() {} lineTo() {} closePath() {} rect() {}
  bezierCurveTo() {} quadraticCurveTo() {} arc() {} arcTo() {} ellipse() {}
}

class ImageDataPolyfill {
  data: Uint8ClampedArray; width: number; height: number;
  constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, height?: number) {
    if (dataOrWidth instanceof Uint8ClampedArray) {
      this.data = dataOrWidth; this.width = widthOrHeight; this.height = height!;
    } else {
      this.width = dataOrWidth; this.height = widthOrHeight;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    }
  }
}

// Prefers the real, native @napi-rs/canvas implementations when that
// package actually resolves (e.g. local dev, where this whole class of bug
// doesn't reproduce) — only falls back to the pure-JS polyfills above when
// it genuinely can't be loaded (Vercel), so this changes nothing about the
// already-working path and only fixes the broken one.
async function installCanvasPolyfills(): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.DOMMatrix && g.Path2D && g.ImageData) return;

  let native: { DOMMatrix?: unknown; Path2D?: unknown; ImageData?: unknown } | null = null;
  try {
    native = await import('@napi-rs/canvas');
  } catch {
    native = null;
  }

  if (!g.DOMMatrix) g.DOMMatrix = native?.DOMMatrix || DOMMatrixPolyfill;
  if (!g.Path2D) g.Path2D = native?.Path2D || Path2DPolyfill;
  if (!g.ImageData) g.ImageData = native?.ImageData || ImageDataPolyfill;
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  await installCanvasPolyfills();
  // pdf-parse (via pdfjs-dist) resolves its worker script from a relative
  // "./pdf.worker.mjs" default, internal to its own module — that file
  // doesn't always make it into Vercel's serverless bundle even though it
  // sits right next to the code that needs it (@vercel/nft's static file
  // tracer misses it), confirmed in production: "Setting up fake worker
  // failed: Cannot find module '.../pdf-parse/dist/pdf-parse/cjs/
  // pdf.worker.mjs'". Can't work around this from here — pdf-parse's own
  // package.json "exports" map doesn't expose that subpath, so even
  // require.resolve() on it throws ERR_PACKAGE_PATH_NOT_EXPORTED from
  // outside the package. Fixed instead via backend/vercel.json's
  // `includeFiles`, which force-includes the exact file regardless of
  // whether the tracer's static analysis would have found it.
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
