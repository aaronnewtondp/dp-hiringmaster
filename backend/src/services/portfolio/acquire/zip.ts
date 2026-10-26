// The bounded zip reader now lives in services/boundedFiles/zip.ts, shared with resume parsing on the main API (which must not import anything under
// acquire/). This file only re-exports it, so every import of './zip.js' from this folder (and its tests) keeps working.
export * from '../../boundedFiles/zip.js';
