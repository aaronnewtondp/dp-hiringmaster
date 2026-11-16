// Run from backend/ after `tsc --outDir dist`:   node ../.github/ci/trace-boot-smoke.mjs
//
// WHY THIS EXISTS (2026-11-16): a Dependabot bump of pdfkit (0.15.2 -> 0.20.2) passed every check and then took production down for
// everyone. pdfkit 0.20 loads its font files through a package "imports" entry (`#standard-fonts/*`) that Vercel's file tracer does not
// follow, so the files were missing from the deployed function and EVERY request crashed at boot with "Cannot find module
// '.../pdfkit/js/standard-fonts/Helvetica.cjs'". boot-smoke.cjs could not see it: it loads the server from the FULL node_modules tree, where
// those files exist. This script closes that gap by booting from only what Vercel would ship:
//
//   1. trace the compiled server (dist/server.js) with @vercel/nft, the tracer Vercel uses (version pinned in tools/ci-lint);
//   2. add the files `functions["api/index.ts"].includeFiles` in vercel.json would add (a glob nft cannot discover);
//   3. copy exactly that file set into a fresh directory OUTSIDE the repository (no ancestor node_modules to fall back on) and run the
//      server from there with a minimal environment;
//   4. over HTTP, GET /health; then, inside that same copy, render both JD PDFs with the real renderers (fonts and logo read through
//      literal paths nft must see), read the result back through the PDF sandbox's child process (pdf-parse and pdf.worker.mjs), and
//      load the packages that production loads lazily (their dynamic import() compiles to require()).
//
// What it deliberately does NOT cover: the portfolio worker (api/portfolio-worker.ts, Chromium) is a separate function with its own file
// set; Vercel's own build (its Node version, its tracer settings) can still differ from this approximation. A pass here means "the traced
// file set is complete for these code paths", not "production is fine".
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const backend = process.cwd();
const require = createRequire(path.join(backend, '..', 'tools', 'ci-lint', 'package.json'));
const { nodeFileTrace } = require('@vercel/nft');

const fail = (msg) => { console.error(`\ntrace-boot-smoke FAILED: ${msg}`); process.exit(1); };
const rel = (p) => path.relative(backend, p);

if (!fs.existsSync(path.join(backend, 'dist', 'server.js'))) fail('dist/server.js is missing: run `npx tsc --outDir dist` in backend/ first');

// Vercel runs the TypeScript from backend/src, where the code's literal asset paths (fonts, logo: path.join(__dirname, '../../assets/...'))
// resolve. `tsc` does not copy non-TypeScript files, so in dist/ they would not exist and nft could not see them. Mirror src/assets into
// dist/assets so the same literal paths resolve here and the tracer decides, as it does on Vercel, whether they ship.
if (!fs.existsSync(path.join(backend, 'dist', 'assets'))) fs.cpSync(path.join(backend, 'src', 'assets'), path.join(backend, 'dist', 'assets'), { recursive: true });

// 1 + 2. The file set Vercel would ship for the main function.
const vercel = JSON.parse(fs.readFileSync(path.join(backend, 'vercel.json'), 'utf8'));
const includeGlob = vercel.functions?.['api/index.ts']?.includeFiles;
const { fileList, warnings } = await nodeFileTrace([path.join(backend, 'dist', 'server.js')], { base: backend, processCwd: backend });
const files = new Set([...fileList]);
const traced = files.size;
if (includeGlob) {
  const matched = fs.globSync(includeGlob, { cwd: backend });
  if (matched.length === 0) fail(`vercel.json includeFiles for api/index.ts matches nothing: ${includeGlob}`);
  for (const m of matched) files.add(m);
}
for (const f of files) if (f.startsWith('..')) fail(`the trace reached outside backend/: ${f}`);
console.log(`traced ${traced} files, ${files.size} with includeFiles (${includeGlob ?? 'none'}); ${warnings.size} tracer warnings`);

// 3. A clean copy outside the repo.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hms-task-')));
const task = path.join(root, 'backend');
for (const f of files) {
  const from = path.join(backend, f);
  const to = path.join(task, f);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { dereference: true });
}
// Test-only data (never imported by production code, so never traced): the JD fixtures the render probe uses.
for (const f of ['dist/services/pdf/socialJd.fixtures.js']) {
  fs.mkdirSync(path.dirname(path.join(task, f)), { recursive: true });
  fs.copyFileSync(path.join(backend, f), path.join(task, f));
}

// 4. The probe, run from the copy.
const probe = `
const http = require('node:http');
process.env.VERCEL = '1';
(async () => {
  const app = require('./dist/server.js').default;
  const server = http.createServer(app).listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const res = await fetch('http://127.0.0.1:' + port + '/health');
  const body = await res.json();
  if (res.status !== 200 || body.status !== 'ok') throw new Error('GET /health answered ' + res.status + ' ' + JSON.stringify(body));
  console.log('ok  GET /health 200');

  // Packages production loads lazily (dynamic import compiles to require) that are part of THIS function.
  for (const name of ['pdf-parse', '@vercel/queue', 'pdfkit', 'googleapis']) { require(name); console.log('ok  require ' + name); }

  // Both JD renderers, with their fonts and logo read through literal paths.
  const { SOCIAL_FIXTURES } = require('./dist/services/pdf/socialJd.fixtures.js');
  const fx = Object.values(SOCIAL_FIXTURES)[0];
  const social = await require('./dist/services/pdf/socialJd.js').renderSocialJd(fx.role, fx.content);
  // The social fixture carries only the social half of JdContent; the long-form JD needs its own fields (synthetic data).
  const longContent = {
    variant: 'tech', tags: [{ text: 'Python', isGreen: false }, { text: 'Time Series', isGreen: true }],
    aboutRoleParagraph: 'You will <b>own</b> the synthetic data platform end to end.', highlightQuote: 'A <b>synthetic</b> highlight.',
    keyResponsibilities: ['Build the ingestion pipeline', 'Keep it observable'], mustHaves: ['Five years of Python', 'SQL fluency'],
    goodToHaves: ['Kafka exposure', 'IoT background'], goodToHaveLabel: 'Good to Have',
    whyJoinUs: [{ iconKey: 'pay', title: 'Pay', description: 'A reason.', isGreen: false }, { iconKey: 'impact', title: 'Impact', description: 'Another reason.', isGreen: true },
                { iconKey: 'growth', title: 'Growth', description: 'A third reason.', isGreen: false }, { iconKey: 'team', title: 'Team', description: 'A fourth reason.', isGreen: true }],
    socialAboutRole: [], socialAboutYou: [],
  };
  const long = await require('./dist/services/pdf/longFormJd.js').renderLongFormJd({ ...fx.role, id: 'R900', title: 'Synthetic Backend Engineer', department: 'Engineering', location: 'Pune', employment_type: 'Full-Time', yoe_required: '5-8' }, longContent);
  for (const [name, buf] of [['social JD', social], ['long-form JD', long]]) {
    if (!Buffer.isBuffer(buf) || buf.subarray(0, 5).toString() !== '%PDF-' || buf.length < 5000) throw new Error(name + ' did not render a PDF');
    console.log('ok  rendered ' + name + ' (' + buf.length + ' bytes)');
  }

  // The resume reader: spawns a child process that loads pdf-parse's CommonJS entry and pdf.worker.mjs.
  const read = await require('./dist/services/pdfSandbox/resume.js').readResumePdf(social, { withLinks: true });
  if (read.kind !== 'read' || !read.text || read.text.length < 20) throw new Error('the PDF sandbox could not read a PDF: ' + JSON.stringify(read).slice(0, 300));
  console.log('ok  PDF sandbox read ' + read.text.length + ' characters');
  process.exit(0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
`;
fs.writeFileSync(path.join(task, 'probe.cjs'), probe);

const env = { PATH: process.env.PATH, HOME: root, NODE_ENV: 'production', JWT_SECRET: 'ci-trace-smoke', DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' };
const run = spawnSync(process.execPath, ['probe.cjs'], { cwd: task, env, encoding: 'utf8', timeout: 120_000 });
process.stdout.write(run.stdout ?? '');
if (run.status !== 0) {
  process.stderr.write(run.stderr ?? '');
  const missing = /Cannot find module '([^']+)'/.exec(run.stderr ?? '')?.[1];
  fail(missing
    ? `a file the server needs at runtime is not in the traced bundle: ${missing.replace(task, '<function>/backend')}\n  -> add it to functions["api/index.ts"].includeFiles in backend/vercel.json (see CLAUDE.md, "The worker bundle must carry ...")`
    : `the probe exited with status ${run.status}${run.signal ? ` (${run.signal})` : ''}`);
}
fs.rmSync(root, { recursive: true, force: true });
console.log(`\ntrace-boot-smoke ok on Node ${process.versions.node}`);
