// The PDF sandbox now lives in services/pdfSandbox/sandbox.ts, shared with resume parsing on the main API (which must not import anything under
// acquire/). This file only re-exports it, so every import of './pdfSandbox.js' from this folder (and its tests) keeps working.
export * from '../../pdfSandbox/sandbox.js';
