// Run from backend/ after `tsc --outDir dist`:  node ../.github/ci/boot-smoke.cjs
//
// Loads the COMPILED backend with plain CommonJS require(), the way Vercel's runtime does, on a Node 22 that is OLDER than 22.12.
// Why that exact Node: from 22.12 on, require() can load an ES-module-only package; before it, it throws ERR_REQUIRE_ESM. Vercel's
// "22.x" is older than 22.12 (CLAUDE.md, "Things learned the hard way"), the developer machine and a current 22.x are not, so an
// ESM-only dependency bump (Dependabot, `npm update`) passes every test everywhere except production. vitest cannot see it: it
// transforms ESM itself. This script is the cheap guard: it only needs the packages to load, no network, no database.
const path = require('node:path');
const { createRequire } = require('node:module');

// server.ts calls app.listen() only when not on Vercel.
process.env.VERCEL = '1';

// Resolve from backend/ (the working directory), not from .github/ci/ where this file lives.
const fromBackend = createRequire(path.resolve('package.json'));

const app = fromBackend('./dist/server.js').default;
if (typeof app !== 'function' || typeof app.use !== 'function') {
  throw new Error('dist/server.js did not export an Express app as its default export');
}

// Loaded lazily in production (dynamic import compiles to require), so the app load above would not touch them.
const lazily = [
  'puppeteer-core', //          portfolio review, the pinned CommonJS build (browserPackages.test.ts guards the exports map)
  '@sparticuz/chromium', //     same, the matched Chromium pair
  'pdf-parse', //               resume and work-sample PDFs (v2 API, run in the PDF sandbox's child process)
  '@vercel/queue', //           portfolio-analysis queue
  'pdfkit', //                  JD PDFs
  'googleapis', //              Drive, Calendar, Gmail
];
for (const name of lazily) {
  fromBackend(name);
  console.log(`require ok: ${name}`);
}
for (const entry of ['./dist/services/portfolio/browser.js', './dist/services/pdfSandbox/sandbox.js', './dist/services/driveService.js']) {
  fromBackend(entry);
  console.log(`require ok: ${entry}`);
}

console.log(`boot smoke ok on Node ${process.versions.node}`);
// Importing the server leaves timers and pools that would keep the process alive.
process.exit(0);
