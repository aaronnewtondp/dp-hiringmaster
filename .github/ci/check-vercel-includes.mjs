// Run from backend/ after `npm ci`:  node --no-warnings ../.github/ci/check-vercel-includes.mjs
//
// backend/vercel.json lists files Vercel must copy into each function because the bundler cannot see them
// (pdf.worker.mjs is loaded by pdfjs at runtime, the Chromium archives by @sparticuz/chromium). If an upgrade moves or
// drops one, the build still succeeds and production quietly loses a feature: a missing pdf.worker.mjs made every
// resume "unreadable" (CLAUDE.md, "ResumeIQ"). This check fails the build instead.
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));

// One level of {a,b,c} per pass, so every alternative is checked on its own (a glob that matches only some
// of its alternatives still "matches").
function expandBraces(pattern) {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  const close = pattern.indexOf('}', open);
  if (close === -1) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  return pattern
    .slice(open + 1, close)
    .split(',')
    .flatMap((alt) => expandBraces(head + alt + tail));
}

const failures = [];
let checked = 0;
for (const [fn, spec] of Object.entries(config.functions ?? {})) {
  const raw = spec.includeFiles;
  if (!raw) continue;
  for (const pattern of Array.isArray(raw) ? raw : [raw]) {
    for (const alt of expandBraces(pattern)) {
      checked += 1;
      const hits = fs.globSync(alt);
      if (hits.length === 0) failures.push(`${fn}: includeFiles entry matches nothing: ${alt}`);
    }
  }
}

// Files the code names explicitly (services/pdfSandbox/sandbox.ts requires index.cjs by absolute path;
// pdfjs's "fake worker" loads pdf.worker.mjs; both must ship in api/index.ts and api/portfolio-worker.ts).
for (const file of [
  'node_modules/pdf-parse/dist/pdf-parse/cjs/index.cjs',
  'node_modules/pdf-parse/dist/pdf-parse/cjs/pdf.worker.mjs',
]) {
  checked += 1;
  if (!fs.existsSync(file)) failures.push(`required file is missing: ${file}`);
}
// The Chromium archives the worker unpacks at start-up.
checked += 1;
if (fs.globSync('node_modules/@sparticuz/chromium/bin/*').length === 0) {
  failures.push('node_modules/@sparticuz/chromium/bin/ is empty or missing');
}

if (failures.length > 0) {
  for (const f of failures) console.error(`::error title=vercel.json includeFiles::${f}`);
  process.exit(1);
}
console.log(`vercel.json includeFiles: ${checked} checks, all resolve`);
