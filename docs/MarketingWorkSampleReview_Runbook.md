# Marketing work-sample review (R019) — go-live runbook

This is the operational checklist for the Head of Marketing & Creative Direction **work-sample review** — the ninth ResumeIQ dimension ("Portfolio") for role **R019**. The design record (what it is, why, every rule and limit) is the *Marketing work-sample review (2026-10-22, R019)* subsection of `CLAUDE.md`; user-facing wording is in the Help page and the User Access Guide (4.4). R019's behaviour changed at **step 4**, which was done on 2026-10-24 (steps 1, 2, 4, 5 and 6 are done and step 3 is not recorded; *Where production stands* has the state of 2026-10-25/26): until then the schema column and the code were inert, and R007 keeps the designer review it always had (every role defaults to `portfolio_review_kind = 'design_portfolio'`; the one intended difference for R007's browser capture is in step 2).

**To stop it:** `UPDATE roles SET portfolio_analysis_enabled = false WHERE id = 'R019'`. No redeploy — the flag is read when a review is queued and again when the worker picks the job up (a queued job for a role that has been switched off is recorded as `failed` with "Portfolio review is not enabled for this role", never folded). Averages that were already folded stay folded until you run the undo in *Rollback* below.

## What it changes for users

For each Head of Marketing application, the links in the screening answer **"Links to public resources/portfolio to highlight your past work?"** are opened as a stranger would open them (Drive files, Docs/Slides, PDFs, Word/PowerPoint, images, own sites, Behance, Canva, Notion) and reviewed against the role's must-haves and nice-to-haves by one model call. The score (0–10) is averaged in with the 8 ResumeIQ dimensions (`score_avg`, `ai_fit_score`, the priority bucket, and with them the Ready-for-review ordering, the dashboard's ≥ 75 / ≤ 45 counts and the 24h-vs-48h SLA tier at fit 75). **It is only applied when real work could be reviewed.** A blank or "N/A" answer, a written description with no link, a private or dead link, LinkedIn/Instagram/video-only answers, answers whose only links are Google Play listings, Looker Studio reports or Google Photos albums (listed for HR, never opened), bot-walled sites, files that cannot be read automatically (a scanned PDF with no text layer, a PDF over 8 MB or too complex to open) and material the reviewer could not assess at all (unreadable, or in a language it cannot judge) are **not scored**: the dimension is left out, the average stays the mean of the 8, and the candidate's page says why (never a 0 — a review that the model never actually saw any work for, or could assess none of, cannot be recorded as completed). YouTube/Vimeo links are judged from title, description and thumbnails only ("video not watched"), Instagram from its public caption snippet only, and LinkedIn, Google Play, Looker Studio and Google Photos links are never opened; everything that was not reviewed is listed under "Not reviewed — open these by hand".

New for the people using HMS: a **Portfolio** row in the ResumeIQ table and a **Portfolio review** card on the candidate page (the links that were read under "Work reviewed", each with a coverage line; every other link once under "Not reviewed — open these by hand" with its reason; "Based on N of M links", counted over distinct addresses; confidence; any cap that really lowered the score; a collapsed "How the evidence was checked"; the candidate's own words as "Described by the candidate (unverified)"); the **Portfolio ≥ 7.5** toggle in My Tasks → Ready for review appears for R019 (scores are whole numbers, so 8+); **Re-run** (HR-tier) re-reads the answer — no Drive read, no 502.

## Order matters

0. **Pre-flight (no production change).**
   - Tests green on the build you are shipping: `cd backend && npx tsc --noEmit -p . && npm test` (84 files / 6,983 tests on 2026-10-23, after fix round 5, plus the 27 `min_score` cases PR #22 added to `routes/portfolio.requeue.test.ts` (not a new file); one more file of 14 tests is skipped on purpose, see the Lambda-image bullet; two timing-based tests can fail on a heavily loaded machine and pass in isolation — re-run them before suspecting the code) and `cd frontend && npx tsc --noEmit -p . && npm test` (35 files / 948 tests).
   - **Lambda-image check — repeat it after touching ANY browser launch argument, `makeTeardownGuard` or anything else in `capture.ts` / `browser.ts`, the PDF sandbox (`acquire/pdfSandbox.ts`), and after upgrading `@sparticuz/chromium`, `puppeteer-core` or the Node base image.** It shows three things that only the production runtime can show, because neither the Chromium builds we run nor the Node on Vercel are the ones on a laptop: (1) *popups* — production's `@sparticuz/chromium` is a headless SHELL with no popup blocker at all (a plain page opened every popup with the blocker "on" and "off"), and desktop Chrome has a blocker that a user gesture defeats; (2) *teardown* (fix round 4) — what a hostile page starts as its document goes away (unload handlers sending a keepalive fetch, a beacon or an image; a script-clicked `<a ping>`), and every request still waiting for OUR verdict when the page closes, which the browser releases to the network instead of dropping, reached an internal listener on every build tried; the teardown guard (`makeTeardownGuard`) is what stops it, and `--no-pings` alone does not in this build (it already ships that flag); (3) *the PDF reader* — a child process started with `process.execPath`, `-e`, `--max-old-space-size` and an empty environment, killed by a resident-size probe that reads `/proc/<pid>/status` (a thread could not survive one huge allocation: a 24 KB PDF holding a 22 MB string aborted the whole process). `capture.realBrowser.test.ts` (opt-in: `PORTFOLIO_REAL_BROWSER_TEST=1`) can only drive a desktop Chrome, so a pass on a laptop proves nothing for Vercel. This check runs the COMPILED code in the Lambda image against hostile local pages and a local listener standing in for an internal service, and then the real PDF sandbox. It needs Docker and the `public.ecr.aws/lambda/nodejs:22` image (about 600 MB; if it is not already on the machine, pulling it is a download — ask first). Save the script below as `lambda-egress-check.cjs` somewhere outside the repo (it is the old `lambda-popup-check.cjs`, extended), then from `backend/` (tested 2026-10-23 on an Apple-silicon laptop, where the image runs under amd64 emulation: about 8 minutes for everything, 10–15 s per case plus the retries of a designer control, and about 1 minute for one vector; `VECTORS=unload,paused,pdf` runs a subset — the names are `plain,poll,hijack,unload,paused,ping,spam,crawl,pdf`):

```bash
DIST=$(mktemp -d) && npx tsc -p . --outDir "$DIST" --declaration false --declarationMap false --sourceMap false
docker run --rm --platform linux/amd64 --memory 2g --entrypoint node -e AWS_EXECUTION_ENV=AWS_Lambda_nodejs22.x -e VERCEL=1 \
  -v "$DIST":/var/task/dist:ro -v "$PWD/node_modules":/var/task/node_modules:ro -v "/path/to/lambda-egress-check.cjs":/var/task/lambda-egress-check.cjs:ro \
  public.ecr.aws/lambda/nodejs:22 /var/task/lambda-egress-check.cjs
```

   `AWS_EXECUTION_ENV` is what lets `@sparticuz/chromium` unpack its bundled libraries (without it the browser never starts), `VERCEL=1` makes `withBrowser` take its Lambda path, and the macOS `node_modules` is fine here (the Chromium archives are platform-independent and `pdf-parse` is plain JavaScript; `@napi-rs/canvas` will not load, which the PDF child's own stand-ins cover). **Expected** (the run of 2026-10-23): every `marketing` line `0` requests and `PASS`; every `designer` line `control leaks (expected)` — R007 keeps its pre-existing exposure by decision (6, 17, 11, 7, 7, 3 and 12 requests for `plain`, `poll`, `hijack`, `unload`, `paused`, `ping` and `spam`; a designer control is a race in a real browser, so the script tries it up to three times; every browser case runs in its own process and process group with a 4-minute watchdog, because a hostile popup storm can wedge the single-process Chromium for good — it did once in four runs on 2026-10-23, in the designer control of `poll` — and that must cost one case, not the whole check; a marketing case that hangs is a `FAIL`; the script also holds its own event loop open and prints `FAIL: the script ended before its last step answered` if it ever ends early, because the PDF sandbox's child and timers are deliberately unref'd and an idle process would otherwise exit silently with status 0 in the middle of a step); `crawl`: marketing `pages opened: 4  partial: true` with the note "Opened 4 pages; the site links to 5 more that were not read", designer unchanged (`partial: false`); and four `pdf` lines `PASS` — the pre-flight accepts a plain one-page PDF, the child process reads it (about 2 s emulated), a 10 MB resident ceiling kills the child as `too-complex/memory` (the `/proc` probe works), and a 24 KB PDF holding one 23 MB string ends as `timeout`, `too-complex/heap` or `too-complex/memory` with THIS process alive and the next PDF reading. A `designer` line that says `BLIND` means the harness sees nothing, so a pass proves nothing (run that vector again, or fix the harness); a `marketing` `FAIL` means a request can reach an internal address again, or the crawl or the PDF reader broke — do not deploy. To see the check fail on purpose, run it with the pre-change launch or without the guard (pass `{}` instead of `browserOptionsFor(opts)` for marketing, or set `guardTeardown: false`): that is the proof it can.

```js
// lambda-egress-check.cjs — runs INSIDE public.ecr.aws/lambda/nodejs:22: the real withBrowser (@sparticuz/chromium, the headless shell Vercel runs)
// + the real capturePortfolios against a hostile local page and a local listener standing in for an internal service, then the real PDF sandbox.
// Every marketing line must be 0 requests / PASS; every designer line must LEAK (R007 keeps its pre-existing exposure by decision) — a designer line that
// leaks nothing means the harness is blind and a pass proves nothing. Every browser case runs in its own node process and process group with a watchdog:
// a hostile popup storm can wedge the single-process Chromium for good (seen once in four runs), and that must cost one case, not the whole check.
const net = require('net');
const http = require('http');
const urlSafety = require('/var/task/dist/services/portfolio/urlSafety.js');
const { withBrowser } = require('/var/task/dist/services/portfolio/browser.js');
const cap = require('/var/task/dist/services/portfolio/capture.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NEVER = 600000;   // a host check that is never answered while the capture runs
// popups, then the teardown vectors, then a partial-crawl check, then the PDF reader:
const VECTORS = (process.env.VECTORS || 'plain,poll,hijack,unload,paused,ping,spam,crawl,pdf').split(',');

// What a hostile page registers to run when its document goes away (and what it starts): keepalive fetch, beacon and image at each unload event.
const HANDLERS = IN => `for (const ev of ['pagehide','visibilitychange','beforeunload','unload']) addEventListener(ev, () => {
  const t = (location.pathname.replace(/\\W/g,'') || 'root') + '-' + ev;
  try { fetch('${IN}/ka-' + t, { keepalive: true, mode: 'no-cors' }); } catch (e) {}
  try { navigator.sendBeacon('${IN}/bc-' + t, 'x'); } catch (e) {}
  try { new Image().src = '${IN}/im-' + t; } catch (e) {}
});`;

// body(IN) is the page script; delayMs = how long the host check takes for the INTERNAL address (requests wait for that verdict);
// everyPath = every page of the site carries the script (else only '/'); next = the page links to a second one (a later navigation).
const BODIES = {
  // popups: window.open, a target=_blank link and a target=_blank form, once each
  plain: { body: IN => `try{window.open('${IN}/via-window-open','_blank')}catch(e){} const a=document.createElement('a');a.href='${IN}/via-anchor';a.target='_blank';document.body.appendChild(a);try{a.click()}catch(e){} const f=document.createElement('form');f.action='${IN}/via-form';f.target='_blank';document.body.appendChild(f);try{f.submit()}catch(e){}` },
  // popups: a timer that keeps calling window.open (it fires inside the gesture puppeteer's own evaluate()/title() calls grant)
  poll: { body: IN => `let n=0;const t=setInterval(()=>{try{window.open('${IN}/poll-'+(n++),'_blank')}catch(e){} if(n>60)clearInterval(t)},250)` },
  // popups: a page that hooks what the capture calls (scrollTo, innerText) so that OUR reads open the popup
  hijack: { body: IN => `const go=()=>{try{window.open('${IN}/hijack','_blank')}catch(e){}}; const o=window.scrollTo.bind(window); window.scrollTo=function(){go();return o.apply(null,arguments)}; Object.defineProperty(document.body,'innerText',{get(){go();return 'Portfolio text'}})` },
  // teardown: unload handlers on every page; the site links to a second page, so both the later navigation and the final close unload a document
  unload: { body: IN => HANDLERS(IN), everyPath: true, next: true },
  // teardown: ONE request of each kind at load, none ever answered (the host check never returns) — the browser used to release them when the page closed
  paused: { body: IN => `try{new Image().src='${IN}/q-img'}catch(e){}try{fetch('${IN}/q-fetch',{mode:'no-cors'}).catch(()=>{})}catch(e){}try{const x=new XMLHttpRequest();x.open('GET','${IN}/q-xhr');x.send()}catch(e){}try{navigator.sendBeacon('${IN}/q-beacon','x')}catch(e){}try{fetch('${IN}/q-keepalive',{keepalive:true,mode:'no-cors'}).catch(()=>{})}catch(e){}`, delayMs: NEVER },
  // teardown: a script-clicked <a ping> whose request is never answered
  ping: { body: IN => `const a=document.createElement('a');a.href='#h';a.setAttribute('ping','${IN}/q-ping');document.body.appendChild(a);a.click()`, delayMs: NEVER },
  // teardown: an image, a fetch, an XHR and a beacon every 20 ms while every verdict takes 8 s (the capture closes the page with dozens still waiting)
  spam: { body: IN => `let n=0;setInterval(()=>{n++;try{new Image().src='${IN}/pimg'+n}catch(e){}try{fetch('${IN}/pfetch'+n,{mode:'no-cors'}).catch(()=>{})}catch(e){}try{const x=new XMLHttpRequest();x.open('GET','${IN}/pxhr'+n);x.send()}catch(e){}try{navigator.sendBeacon('${IN}/pbeacon'+n,'x')}catch(e){}},20)`, delayMs: 8000 },
};

async function browserVector(kind, vector) {
  const spec = BODIES[vector];
  const hits = [];
  const internal = net.createServer(s => { s.once('data', d => { hits.push(d.toString('latin1').split('\r\n')[0].replace(/ HTTP.*/, '')); s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'); }); s.on('error', () => {}); });
  await new Promise(r => internal.listen(0, '127.0.0.1', r));
  const IN = `http://127.0.0.1:${internal.address().port}`;
  const site = http.createServer((q, s) => {
    const path = q.url.split('?')[0];
    const script = path === '/' || spec.everyPath ? spec.body(IN) : '';
    s.setHeader('content-type', 'text/html');
    s.end(`<html><head><title>Portfolio</title></head><body style="height:3000px"><h1>Portfolio ${path}</h1><p>${'Brand work. '.repeat(40)}</p>${spec.next ? '<a href="/p2">next</a>' : ''}<script>${script}</script></body></html>`);
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const SITE = `http://127.0.0.1:${site.address().port}`;
  // The candidate's own (loopback) origin counts as "public" for this test only; the internal listener is judged by the REAL checks.
  const realAssert = urlSafety.assertSafePublicUrl;
  const realChecker = urlSafety.makeHostChecker;
  urlSafety.assertSafePublicUrl = async u => (u.startsWith(SITE) ? new URL(u) : realAssert(u));
  urlSafety.makeHostChecker = () => { const r = realChecker(); return async u => { if (u.startsWith(SITE)) return true; if (spec.delayMs) await sleep(spec.delayMs); return r(u); }; };
  const opts = kind === 'marketing' ? cap.MARKETING_CAPTURE_OPTS : cap.DESIGNER_CAPTURE_OPTS;
  const launch = kind === 'marketing' ? cap.browserOptionsFor(opts) : {};   // what run.marketing.ts / run.ts pass to withBrowser (minus the busy-wait)
  const link = { url: SITE + '/', host: '127.0.0.1', platform: 'custom', handler: 'site' };
  let res; let err;
  try { res = await withBrowser(b => cap.capturePortfolios(b, [link], Date.now() + 100000, opts), launch); } catch (e) { err = e.message.slice(0, 80); }
  await sleep(1500);   // a request released at close arrives within milliseconds; this is slack
  urlSafety.assertSafePublicUrl = realAssert;
  urlSafety.makeHostChecker = realChecker;
  internal.close();
  site.close();
  return { hits: hits.filter(h => !/favicon/.test(h)), res, err };
}

async function crawlVector(kind) {
  // a site that links to eight more pages than the marketing crawl opens (4): the marketing capture must say it read only part of it
  const site = http.createServer((q, s) => {
    s.setHeader('content-type', 'text/html');
    const links = Array.from({ length: 8 }, (_, i) => `<a href="/work${i}">Case study ${i}</a>`).join(' ');
    s.end(`<html><head><title>Portfolio ${q.url}</title></head><body><h1>Portfolio</h1><p>${'Brand work. '.repeat(40)}</p>${links}</body></html>`);
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const SITE = `http://127.0.0.1:${site.address().port}`;
  const realAssert = urlSafety.assertSafePublicUrl;
  const realChecker = urlSafety.makeHostChecker;
  urlSafety.assertSafePublicUrl = async u => (u.startsWith(SITE) ? new URL(u) : realAssert(u));
  urlSafety.makeHostChecker = () => { const r = realChecker(); return async u => (u.startsWith(SITE) ? true : r(u)); };
  const opts = kind === 'marketing' ? cap.MARKETING_CAPTURE_OPTS : cap.DESIGNER_CAPTURE_OPTS;
  const launch = kind === 'marketing' ? cap.browserOptionsFor(opts) : {};
  let res; let err;
  try { res = await withBrowser(b => cap.capturePortfolios(b, [{ url: SITE + '/', host: '127.0.0.1', platform: 'custom', handler: 'site' }], Date.now() + 100000, opts), launch); } catch (e) { err = e.message.slice(0, 80); }
  urlSafety.assertSafePublicUrl = realAssert;
  urlSafety.makeHostChecker = realChecker;
  site.close();
  return { res, err };
}

// A valid one-page PDF, written by hand (no library), xref table and all. `flate` deflates the page's content stream (as real producers do).
function onePagePdf(content, flate) {
  const data = flate ? require('zlib').deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  const head = Buffer.from(`<< /Length ${data.length}${flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1');
  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'),
    Buffer.concat([head, data, Buffer.from('\nendstream')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let at = parts[0].length;
  objs.forEach((o, i) => { offsets.push(at); const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]); parts.push(b); at += b.length; });
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return Buffer.concat(parts);
}
const tinyPdf = text => onePagePdf(`BT /F1 18 Tf 20 80 Td (${text}) Tj ET`, false);
// ~24 KB on disk: one content-stream string of 23 MB. pdfjs builds a glyph array of tens of millions of objects in ONE step.
const hugeStringPdf = () => onePagePdf(`BT /F1 12 Tf 72 700 Td (${'a'.repeat(23_000_000)}) Tj ET`, true);

const { spawn } = require('child_process');
const CASE_MS = 240000;   // a browser case that has not answered by then is hung
// One case in its own node process (and process group, so Chromium dies with it): the answer is one marker line on stdout.
function isolated(what, kind, vector) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [__filename, '--one', what, kind, vector], { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ } resolve({ hung: true }); }, CASE_MS);
    child.on('exit', () => { clearTimeout(timer); const m = /@@RESULT@@(.*)/.exec(out); resolve(m ? JSON.parse(m[1]) : { hung: true }); });
  });
}
if (process.argv[2] === '--one') {
  (async () => {
    const [, , , what, kind, vector] = process.argv;
    const r = what === 'crawl' ? await crawlVector(kind) : await browserVector(kind, vector);
    const c = r.res && r.res[0];
    console.log('@@RESULT@@' + JSON.stringify({ hits: r.hits || [], err: r.err, c: c ? { access: c.access, partial: !!c.partial, note: c.accessNote || '', pages: c.pages.length } : null }));
    process.exit(0);
  })().catch(e => { console.error('ERR', e); process.exit(2); });
  return;   // child mode: nothing below runs
}

(async () => {
  let bad = 0;
  const say = (line, verdict) => { if (/FAIL|BLIND/.test(verdict)) bad++; console.log(`${line}  => ${verdict}`); };
  // The PDF sandbox's child and timers are unref'd on purpose (a review must never be kept alive by them), so with nothing else running this process
  // would simply EXIT while a step is still waiting for its answer, silently and with status 0: hold the loop open, and fail loudly if it ends early.
  const keepAlive = setInterval(() => {}, 1000);
  let finished = false;
  process.on('exit', () => { if (!finished) { console.log('FAIL: the script ended before its last step answered'); process.exitCode = 1; } });

  const TRIES = 3;
  for (const vector of VECTORS.filter(v => v !== 'pdf' && v !== 'crawl')) {
    for (const kind of ['marketing', 'designer']) {
      // The designer control is a race in a real browser: up to three tries to see it leak (a marketing line is never retried).
      let r = await isolated('browser', kind, vector);
      for (let again = 1; kind === 'designer' && (r.hung || r.hits.length === 0) && again < TRIES; again++) r = await isolated('browser', kind, vector);
      const line = `${kind.padEnd(9)} ${vector.padEnd(7)}`;
      if (r.hung) { say(`${line} no answer within ${CASE_MS / 1000} s`, kind === 'marketing' ? 'FAIL: the case hung' : 'BLIND: the control hung every time'); continue; }
      const verdict = kind === 'marketing'
        ? (r.hits.length === 0 && r.c && r.c.access === 'ok' ? 'PASS' : 'FAIL')
        : (r.hits.length > 0 ? 'control leaks (expected)' : 'BLIND: the control sees nothing - the harness proves nothing');
      say(`${line} requests to the internal listener: ${String(r.hits.length).padStart(3)}  page read: ${r.c ? r.c.access : 'no'}${r.err ? '  error: ' + r.err : ''}`, verdict);
    }
  }

  if (VECTORS.includes('crawl')) {
    for (const kind of ['marketing', 'designer']) {
      let r = await isolated('crawl', kind, 'crawl');
      if (r.hung) r = await isolated('crawl', kind, 'crawl');
      if (r.hung) { say(`${kind.padEnd(9)} crawl   no answer within ${CASE_MS / 1000} s`, 'FAIL: the case hung'); continue; }
      const c = r.c;
      const partial = !!(c && c.partial);
      const note = c ? c.note : '';
      const verdict = kind === 'marketing'
        ? (c && c.access === 'ok' && partial && /^Opened 4 pages; the site links to \d+ more that were not read$/.test(note) ? 'PASS' : 'FAIL')
        : (c && c.access === 'ok' && !partial ? 'unchanged (expected)' : 'FAIL: the designer capture changed');
      say(`${kind.padEnd(9)} crawl   pages opened: ${c ? c.pages : 'no'}  partial: ${partial}  note: ${JSON.stringify(note)}${r.err ? '  error: ' + r.err : ''}`, verdict);
    }
  }

  if (VECTORS.includes('pdf')) {
    // The PDF reader: a child node process (spawn of process.execPath, `-e`, --max-old-space-size, empty environment) that the parent can kill.
    const sb = require('/var/task/dist/services/portfolio/acquire/pdfSandbox.js');
    const pdf = require('/var/task/dist/services/portfolio/acquire/pdf.js');
    const deadline = () => Date.now() + 90000;
    const deck = tinyPdf('Hello portfolio');
    say(`pdf       pre-flight of a plain one-page PDF: ${JSON.stringify(pdf.preflightPdf(deck))}`, pdf.preflightPdf(deck).ok ? 'PASS' : 'FAIL');
    const t0 = Date.now();
    const read = await sb.readPdfInSandbox(deck, { maxPages: 5, deadline: deadline() });
    say(`pdf       a plain PDF in the child process: ${read.kind}${read.kind === 'read' ? ` (${read.total} page, text ${JSON.stringify((read.pages[0] || {}).text || '').slice(0, 40)})` : JSON.stringify(read).slice(0, 120)}  ${Date.now() - t0} ms`,
      read.kind === 'read' && read.total === 1 && /Hello portfolio/.test(read.pages[0].text) ? 'PASS' : 'FAIL (spawn, -e, --max-old-space-size or pdf-parse/pdf.worker.mjs does not work here)');
    // A ceiling below what any node process needs: it only trips if the /proc/<pid>/status reading works, so this is the probe's own test.
    const probe = await sb.readPdfInSandbox(deck, { maxPages: 5, deadline: deadline(), memory: { ceilingBytes: 10 * 1024 * 1024 } });
    say(`pdf       the same PDF against a 10 MB resident ceiling: ${probe.kind}${probe.cause ? '/' + probe.cause : ''}`,
      probe.kind === 'too-complex' && probe.cause === 'memory' ? 'PASS (the /proc probe kills a child)' : 'FAIL (the resident-size probe is blind here)');
    // The case a thread could not survive: ONE very large allocation. The child may end by heap abort, by the memory ceiling or by the 12 s deadline
    // (emulated CPU is 5-10x slower than a real one); what must hold is that THIS process is alive afterwards and the next PDF reads.
    const huge = hugeStringPdf();
    const t1 = Date.now();
    const bomb = await sb.readPdfInSandbox(huge, { maxPages: 5, deadline: deadline() });
    const after = await sb.readPdfInSandbox(deck, { maxPages: 5, deadline: deadline() });
    say(`pdf       a 24 KB PDF holding one 23 MB string: ${bomb.kind}${bomb.cause ? '/' + bomb.cause : ''}${bomb.limitedBy ? '/' + bomb.limitedBy : ''}  ${Date.now() - t1} ms; next PDF: ${after.kind}`,
      bomb.kind !== 'read' && after.kind === 'read' ? 'PASS (this process survived and the next PDF reads)' : 'FAIL');
  }
  finished = true;
  clearInterval(keepAlive);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(2); });
```
   - **Privacy notice.** Candidates' files and screenshots of their pages are sent to the model provider for the review, and only the structured result is stored (no screenshots, no file copies). Confirm the Job Application Form's privacy notice covers AI-assisted review of the linked material (it was meant to be confirmed before the backfill, which ran on 2026-10-25; this file records no answer, and new applicants are reviewed automatically since 2026-10-24).
   - **Optional dedicated Anthropic key.** `PORTFOLIO_ANTHROPIC_API_KEY` (read only by the marketing analyzer; falls back to `ANTHROPIC_API_KEY`) lets you put these reviews in their own workspace with a spend cap, so a 90-review backfill cannot starve live resume scoring of rate limit. Set it on the Production environment of `dp-hiringmaster-be` **before** the deploy in step 2 (an env-var change only reaches a new deployment). This file does not record that it was set. Optional too: `YOUTUBE_API_KEY` adds a YouTube video's description, duration and view count (without it only title/channel/thumbnails are read).
   - **How far will averages move?** The base `score_avg` is the figure the model *reported* for its 8 scores; the fold recomputes the mean of the 8 stored integers. Run this read-only query to see how many R019 rows already differ (small differences are expected: the model does its own arithmetic). *Measured afterwards (2026-10-25):* on the 33 folded rows the mean of the 8 stored scores equalled the logged pre-fold fit score in all 33, so none of them had drifted; the fold itself moved 26 averages down, 4 up and 3 not at all (mean −0.18, biggest drop 0.6, biggest rise 0.2). The drift query:

```sql
-- How often does the stored base average differ from the mean of the 8 stored scores? (The base score_avg is what the model reported; the fold recomputes it.)
SELECT count(*) AS scored_rows,
       count(*) FILTER (WHERE a.score_avg <> m.mean)                  AS differs,
       count(*) FILTER (WHERE abs(a.score_avg - m.mean) > 0.1)        AS differs_by_more_than_0_1
FROM applications a
CROSS JOIN LATERAL (SELECT round((a.score_technical + a.score_experience + a.score_industry_fit + a.score_culture_fit
                                + a.score_role_alignment + a.score_trajectory + a.score_leadership + a.score_communication)::numeric / 8, 1) AS mean) m
WHERE a.role_id = 'R019' AND a.score_portfolio IS NULL AND a.score_avg IS NOT NULL
  AND num_nonnulls(a.score_technical, a.score_experience, a.score_industry_fit, a.score_culture_fit,
                   a.score_role_alignment, a.score_trajectory, a.score_leadership, a.score_communication) = 8;
```

   - **Forecast the backfill** (rough: the code's own classification is stricter; on 2026-10-22 the live answers were 119 in total, 90 with something link-like, 35 without a URL of which 17 "N/A"-like and about 18 descriptive text):

```sql
-- Rough forecast of the backfill, by application status. The code's own classification is stricter, so treat the three
-- columns as an estimate; the backfill's own output is the real count.
WITH ans AS (
  SELECT a.id, a.status,
         COALESCE((SELECT qa->>'answer'
                     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.screening_answers) = 'array' THEN a.screening_answers ELSE '[]'::jsonb END) qa
                    WHERE qa->>'question' ~* 'links to public resources/portfolio' LIMIT 1), '') AS answer
    FROM applications a
   WHERE a.role_id = 'R019' AND a.score_avg IS NOT NULL AND a.portfolio_analysis_status IS NULL)
SELECT status,
       count(*) AS applications,
       count(*) FILTER (WHERE answer ~* '(https?://|www\.|instagram|youtu|drive\.google|docs\.google|behance|canva|notion|linkedin|[a-z0-9-]+\.(com|in|co|io|net|org|design|studio|me|site|app|page)\y)') AS has_link_like,
       count(*) FILTER (WHERE answer !~* '(https?://|www\.|instagram|youtu|drive\.google|docs\.google|behance|canva|notion|linkedin|[a-z0-9-]+\.(com|in|co|io|net|org|design|studio|me|site|app|page)\y)'
                          AND length(regexp_replace(answer, '[^[:alnum:]]', '', 'g')) < 25) AS short_or_blank_like,
       count(*) FILTER (WHERE answer !~* '(https?://|www\.|instagram|youtu|drive\.google|docs\.google|behance|canva|notion|linkedin|[a-z0-9-]+\.(com|in|co|io|net|org|design|studio|me|site|app|page)\y)'
                          AND length(regexp_replace(answer, '[^[:alnum:]]', '', 'g')) >= 25) AS words_only_like
  FROM ans GROUP BY status ORDER BY applications DESC;
```

1. **Schema → Supabase first — DONE 2026-10-23** (migration `20261023111710`; do not re-apply). Apply the last block of `backend/src/db/schema.sql` ("Portfolio review kinds + the 'unreviewable' status", 2026-10-22) with `apply_migration` (project `rzbxkgymqrpvbzvjlahd`; name it `portfolio_review_kinds_unreviewable_status`). It is additive and idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` + re-create): a metadata-only column add with a default, and two CHECK constraints (the status one re-validates the `applications` table, which takes a brief lock and passes because every existing value is in the new list). Order, as for every schema change in this project: **Supabase → local Docker → `schema.sql`**; local Docker and `schema.sql` already carry it. Tested on 2026-10-22 by replaying the block inside a rolled-back transaction on local Docker (it is a no-op there, and idempotent). A local database that predates this release needs it once (a rebuilt one gets it from `schema.sql`): `sed -n '/Portfolio review kinds + the/,$p' backend/src/db/schema.sql | docker exec -i dp_hms_db psql -U hms_user -d dp_hms -f -`.

```sql
ALTER TABLE roles ADD COLUMN IF NOT EXISTS portfolio_review_kind TEXT NOT NULL DEFAULT 'design_portfolio';
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_portfolio_review_kind_check;
ALTER TABLE roles ADD CONSTRAINT roles_portfolio_review_kind_check
  CHECK (portfolio_review_kind IN ('design_portfolio','marketing_work'));
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_portfolio_status_check;
ALTER TABLE applications ADD CONSTRAINT applications_portfolio_status_check
  CHECK (portfolio_analysis_status IS NULL OR portfolio_analysis_status IN
    ('pending','running','completed','failed','no_portfolio','inaccessible','unreviewable'));
```

   **Why before the code:** the status CHECK would reject the new `unreviewable` status, *and* the new backend reads the column — `GET /api/roles/filter-options` and `GET /api/applications/:id/portfolio-analysis` both select `portfolio_review_kind`, so code that lands first answers 500 on every Role-filter load and every Portfolio card. (Queue messages are also pinned to the deployment that sent them, so the worker that picks a job up must already find the schema it expects.) Verify:

```sql
SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'roles' AND column_name = 'portfolio_review_kind';
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('roles_portfolio_review_kind_check', 'applications_portfolio_status_check');
SELECT portfolio_review_kind, portfolio_analysis_enabled, count(*) FROM roles GROUP BY 1, 2 ORDER BY 1, 2;
```

   Expected: the column is `text NOT NULL DEFAULT 'design_portfolio'`, both constraints list the new values (`'unreviewable'` in the status one), and every existing role reads `design_portfolio`.

2. **Deploy: backend, then frontend — DONE 2026-10-23** (PR #18, squash `ec4ee0c`; both Vercel production deployments succeeded, the read-only smoke suite passed 34/34; PR #22, the backfill's `min_score` floor, was deployed on 2026-10-25) (separate Vercel projects, `dp-hiringmaster-be` and `dp-hiringmaster`; open tabs keep the old bundle until reload). Stage by **explicit path** (`git add <path> …`, never `git add -A`): the working tree also holds another session's unrelated work (the Social JD files — `backend/src/services/pdf/*`, `jdContent.ts`, `scripts/previewSocialJd.ts`, `backend/src/assets/fonts/` — and three untracked repo-root files, `DP hiring.xlsx`, `DigitalPaani_ATS_HMS_PRD_v4.0.docx`, `recruiter-agreement-analysis.html`), and never `git add -f` the Drive service-account key. Nothing to configure beyond the optional keys above: no dependency was added (a candidate's Word/PowerPoint file is read by the in-repo `acquire/zip.ts`; `jszip` was tried and removed, and `mammoth` still serves only HMS's own resumes), `ANTHROPIC_API_KEY` is already set, and the worker's 300 s limit and `maxConcurrency: 5` in `vercel.json` are unchanged — only the worker's `includeFiles` changed (next bullet). Check after the deploy:
   - **The worker bundle — and the R007 canary that must come first. DONE 2026-10-24, 14:47–14:48 IST:** A0625 was re-run on the deployed worker and completed with the same score (3) and the same average (7.4), which shows that the worker's queue, Chromium, model call and the `includeFiles` brace-glob all work on Vercel (the Anthropic workspace spend limit that had stopped scoring — the first application left unscored was created on 2026-10-23 — had been lifted just before); the deployment's own function file list and function sizes were not read. The rest of this bullet is the reasoning, kept for the next time the glob or the worker bundle changes. The review now reads PDFs, Word and PowerPoint files inside `api/portfolio-worker.ts` (`pdf-parse`, run in a CHILD PROCESS — `acquire/pdfSandbox.ts` — and the in-repo zip reader), which it never did before: the child `require()`s `pdf-parse`'s `index.cjs` by absolute path and pdfjs needs its `pdf.worker.mjs`. `vercel.json` now lists both files in `functions["api/portfolio-worker.ts"].includeFiles` **in the same single brace-glob string as the Chromium binaries** (Vercel rejects an array there): `node_modules/{@sparticuz/chromium/bin/**,pdf-parse/dist/pdf-parse/cjs/index.cjs,pdf-parse/dist/pdf-parse/cjs/pdf.worker.mjs}`. **That brace pattern was confirmed locally with a glob (Node's `fs.globSync` returns the two pdf-parse files and the four Chromium archives) and the bundle by a real `@vercel/nft` trace of the compiled output (the worker traces `pdfSandbox.js` and `index.cjs`; `pdf.worker.mjs` is not traced by nft and ships only through this glob; the main API bundle reaches none of the worker-only modules), and then on Vercel itself (the R007 re-run below; the 14 PDF reads of step 5).** Because the Chromium binaries are in the same string, a pattern Vercel handles differently would break the DESIGNER reviews too — so before R019 is flagged, **Re-run one R007 application that already has a finished review** (a signed-in HR/Admin tab, the same console `fetch` as in step 5 with that application's id; it re-reviews the application and replaces its stored review and folded score, which can move by a point) and wait for `completed`. Also read the deployment's function file list for `api/portfolio-worker` (it must contain `index.cjs`, `pdf.worker.mjs` and the Chromium archives) and the build log's function sizes (the nft check was run locally, never on Vercel's own build). If the designer re-run cannot start a browser, or a file is missing, fix the glob and redeploy before doing anything else. (A missing `pdf.worker.mjs`, or a PDF child process that cannot start, is no longer silent: a PDF would come back `failed` with "The PDF reader could not be started on our side - this will be retried", which the PDF canary in step 5 shows. **That canary was the only check of the PDF sandbox on Vercel** (it ran through the backfill, step 5): it had to show that the worker can `spawn` `process.execPath` with `-e` and `--max-old-space-size` (empty environment, no shell, no IPC) and read `/proc/<pid>/status` for the resident-size ceiling. The first part is proven on Vercel (14 PDFs read); the `/proc` reading cannot be told from a blind probe in the results (the probe returns null on any failure and the deadline and heap flag still apply), so the Lambda-image check in step 0 remains its only test. If a PDF ever fails with the reader-could-not-start message, look at the function's exec / process limits before anything else.)
   - R007 is unchanged, with ONE **intended** exception, in how its browser capture behaves: a Cloudflare/captcha wall in front of a designer's portfolio site is now neutral (`unreviewable`, not scored) instead of being read as "requires login" and scored down. Its browser launch arguments and page scripts are exactly what they were: the WebSocket/real-time lockdown and the popup protection are **marketing-only** (a first version applied the lockdown to every capture, which would have made a designer site that opens a socket at load throw inside its own script), so R007 keeps its pre-existing exposure to a hostile portfolio site opening a socket or a popup toward an internal address — by decision; the real fix for both reviews is egress filtering or a validating proxy at browser launch (not built). The R007 Re-run above doubles as the check that a designer portfolio still captures; open that candidate's card (its wording is the designer's). `GET /api/roles/filter-options` now returns `portfolio_review_kind` for every role.

3. **Take a snapshot, then tell Mansi (R019's Hiring Manager).** *Status: this file records neither as done before the 2026-10-25 backfill; the pre-fold averages of the 33 folded rows can still be reproduced exactly from their stored scores (Rollback, caveat (a)), so nothing is lost.* Before anything is folded, save what the fold will overwrite — export the result to CSV; it is the only exact copy of the original averages:

```sql
-- Run BEFORE the backfill and keep the result (export to CSV): it is the exact state the fold overwrites.
SELECT id, score_avg, ai_fit_score, ai_priority_bucket, sla_hours, score_summary, score_red_flags
FROM applications WHERE role_id = 'R019' ORDER BY id;
```

   Then tell Mansi, before step 4 (new applicants are affected from the moment of the flag, the backfill moves the rest): (a) the Portfolio score will be averaged into every candidate whose work could be reviewed, so **averages and the order of Ready for review will shift while the backfill runs** — some up, some down, by up to about one point at the extremes; candidates with nothing reviewable do not move; (b) a weak sample can rank someone below a candidate who submitted nothing (the fold is deliberate; see *Operating notes*); (c) videos are not watched and Instagram is a caption snippet only, LinkedIn is never opened — those candidates need her eyes; private links show "ask the candidate to re-share"; (d) the checklist (no spot-check by her is scheduled: see step 7). Run the backfill at a quiet moment. Also tell whoever watches SLAs and sourcing: the ≥ 75 fit threshold (24h tier) and the Sourcing module's "qualified = ResumeIQ > 60" count for R019 both read the folded `ai_fit_score`, so they move with it (and move back with the undo).

4. **Flag R019 — DONE 2026-10-24, about 15:00 IST** (Aaron-run; checked by SQL on 2026-10-25: exactly two roles are flagged, R007 `design_portfolio` and R019 `marketing_work`). One statement, **both columns** — the flag alone, with the default kind, would give R019 the *designer* review that reads resumes:

```sql
-- ONE statement, both columns: the flag alone (with the default kind) would give R019 the DESIGNER review.
UPDATE roles SET portfolio_analysis_enabled = true, portfolio_review_kind = 'marketing_work' WHERE id = 'R019';
SELECT id, title, status, portfolio_analysis_enabled, portfolio_review_kind FROM roles WHERE id = 'R019';
```

   Effective at once, no redeploy. From here every new Job Application Form applicant for R019 is reviewed automatically (`runResumeIQScoring` → `prepareMarketingReview`; blank and text-only answers settle instantly with no model call, the rest are queued). Existing applications are untouched until step 6. Confirm `GET /api/roles/filter-options` lists R019 with `portfolio_analysis_enabled: true, portfolio_review_kind: "marketing_work"`.

5. **Canary on 4–5 applications** before the backfill (and only after step 2's R007 re-run has passed) — **DONE: four applications on 2026-10-24, the PDF row through the first backfill reviews on 2026-10-25 (see *Observed* below the table).** A never-reviewed application has no Portfolio card (so no Re-run button): trigger one from a signed-in HR/Admin browser tab on the HMS frontend (the token is in `localStorage.hms_token`; the route is HR-tier, and the read-only smoke accounts cannot call it):

```js
await fetch('https://dp-hiringmaster-be.vercel.app/api/applications/A0001/portfolio-analysis',
  { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('hms_token') } }).then(r => r.json())
// 202 { status: 'pending' | 'no_portfolio' | 'unreviewable', links: N, queued: true }   (409 = a review is already running)
```

   Pick one application per case with this query (swap the last pattern); each folds a real score into that application, which the undo can take back:

```sql
SELECT a.id, a.application_date::date AS applied, left(qa->>'answer', 140) AS answer
FROM applications a
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.screening_answers) = 'array' THEN a.screening_answers ELSE '[]'::jsonb END) qa
WHERE a.role_id = 'R019' AND a.status = 'Active' AND a.score_avg IS NOT NULL
  AND qa->>'question' ~* 'links to public resources/portfolio'
  AND qa->>'answer' ~* 'drive\.google\.com/file'          -- swap the pattern: 'youtu', 'linkedin', 'instagram', 'behance', '^\s*n/?a\s*$' ...
ORDER BY a.application_date DESC LIMIT 5;
```

   | Case | Expected within ~1–4 minutes |
   |---|---|
   | a **public Drive PDF** | `completed`; the link's facts read "PDF, N of N pages read" (a PDF over 20 pages reads "… (text only)" and the link is `partial`); `analysis.usage.inputTokens` > 0 — and **neither** `failed` with "The PDF reader could not be started on our side" (a missing `pdf.worker.mjs` or `index.cjs`, or a PDF child process that cannot start under Vercel — `spawn` of `process.execPath` with `-e` / `--max-old-space-size`, an empty environment: step 2) **nor** `unreviewable` with "too complex to open automatically" for an ordinary deck (that would mean the child's heap flag or the 700 MB resident ceiling, read from `/proc/<pid>/status`, trips on a normal file under Vercel's own accounting). A pass proves the three things at once: the child starts, it parses, and its memory is readable. This row is the only check of the PDF sandbox on Vercel |
   | an **own website** | `completed` (opened in Chromium: up to 4 pages, text capped at 12,000 characters per link). **This was the first real Chromium capture of R019 anywhere, on 2026-10-24** (the 2026-10-22 real-API canary could not run one: no Chrome on the dev machine) — read the card, the link's facts ("N pages captured", "N screenshots") and the Vercel log of `/api/portfolio-worker` for this one in particular — and check that the log holds NO line starting `[portfolio] blockPopups is on but this browser was launched without popup blocking` (that would mean the marketing launch options never reached Chromium) |
   | a **YouTube-only** answer | `unreviewable`, score NULL, average unchanged ("Video was not watched…") |
   | a **private Drive link** | `inaccessible`, score NULL, "ask the candidate to re-share" |
   | **"N/A"** or a written description | `no_portfolio` instantly, no model call, score NULL |
   | material the reviewer **cannot assess at all** (unreadable, or in a language it cannot judge — rare; only if one turns up) | `unreviewable`, score NULL, average unchanged, message "The material could not be assessed (unreadable, or in a language the review cannot judge)". A review where the reviewer could assess only a little (under 40% of the criteria the work can show) is NOT this: it is `completed` on the reviewer's own judgement with low confidence and the note "… so the checklist was not used" (counted by M6) |

   **Observed.** 2026-10-24, about 15:05 IST, on the four applications that were still unscored (A1306–A1309, through the bulk "Retry scoring" button in Ready for Review, which re-scores and queues the review): a dead domain → `inaccessible`; a text-only answer → `no_portfolio` at once; a company website → `completed` (**the first real Chromium capture of an R019 site**: 4 pages, 9 screenshots, 21,133 input tokens, confidence low; the reviewer said 2 and the checklist 5, so the final 3 is the model + 1 cap; average 6.4 → 6.0; no `blockPopups` launch warning was seen in the worker log at the time — Hobby runtime logs last one hour, so this cannot be re-checked); Instagram → `unreviewable`. No Drive-PDF canary was run on its own: the PDF row of the table was observed in the first backfill reviews instead (2026-10-25 about 03:15 IST: A1205 a Slides export 10 of 10 pages, A1209 a Doc 5 of 5, A1198 a 23-page Drive PDF read as text, 20 of 23; 14 PDFs in all, none `failed` with "could not be started", none "too complex"). That shows the child process starts and parses on Vercel; it does not show the `/proc` resident-size reading (step 0's Lambda-image check is its only test).

   Check with (swap in the canary ids) — and read the card on the candidate page as Mansi would:

```sql
-- caps = only caps that really lowered the score; notes = audit notes (lowered verdicts, fairness filter, ...);
-- links: every link the review acquired, with its outcome and whether the MODEL was shown it ("[shown: ...]" = it was).
SELECT a.id, a.portfolio_analysis_status AS status, left(a.portfolio_analysis_error, 100) AS message, a.score_portfolio, a.score_avg,
       pa.analysis->>'model' AS model, pa.analysis->'usage' AS usage, pa.analysis->'caps' AS caps, pa.analysis->'evidenceNotes' AS notes,
       jsonb_array_length(COALESCE(pa.analysis->'unreviewed', '[]'::jsonb)) AS listed_not_opened,
       (SELECT string_agg(p->>'ref' || ' ' || (p->>'platform') || ': ' || COALESCE(p->>'outcome', '?')
                          || CASE WHEN p->>'coverage' IS NULL THEN ' [not shown to the model]' ELSE ' [shown: ' || (p->>'coverage') || ']' END
                          || COALESCE(' - ' || (SELECT string_agg(f, '; ') FROM jsonb_array_elements_text(p->'facts') f), ''), E'\n')
          FROM jsonb_array_elements(COALESCE(pa.analysis->'portfolios', '[]'::jsonb)) p) AS links
FROM applications a LEFT JOIN portfolio_analyses pa ON pa.application_id = a.id
WHERE a.id IN ('A0001', 'A0002');   -- the canary ids
```

   After a worker crash (an OOM kill, the 300 s platform kill, a deploy that interrupted a review) check `ps` for orphan node children — there should be none (`ps -axo pid,ppid,etime,pcpu,command | grep -E 'max-old-space-size|DOMMatrixPolyfill'` in the Lambda-image check or on any machine that ran the harness; a PDF child also ends itself about a second after its parent dies).

6. **Backfill — DONE 2026-10-25, about 03:15–03:30 IST** (Aaron-run; needs `ROLE_INGEST_SECRET`, which is the backend's — never paste it into a chat). It was run with `--role R019 --min-score 4` (Active applications with a ResumeIQ average of at least 4.0): 87 eligible, **56 queued** to the worker and **31 settled at enqueue** (20 `no_portfolio`, 11 `unreviewable`), 0 errors, drained in about 15 minutes at `maxConcurrency` 5. The 34 R019 applications with no review are the 23 Active ones below 4.0 and the 11 Rejected ones, which were deliberately not backfilled; no backfill of them is planned. The outcome (R019, 125 applications: completed 33, failed 1, inaccessible 2, no_portfolio 25, unreviewable 30, no review 34) and the fold's effect are in *Where production stands*. From `backend/` (a checkout that predates PR #22 silently ignores `--min-score`: `git pull` first, and let the dry run's count show it took effect):

```bash
HMS_API_URL=https://dp-hiringmaster-be.vercel.app ROLE_INGEST_SECRET=... \
  npx tsx src/scripts/backfillPortfolioReviews.ts --role R019 --dry-run     # counts only, queues nothing
HMS_API_URL=https://dp-hiringmaster-be.vercel.app ROLE_INGEST_SECRET=... \
  npx tsx src/scripts/backfillPortfolioReviews.ts --role R019               # Active first (the default --statuses)
# only the applications whose ResumeIQ average is at least N (inclusive; applied to the dry run's count too), e.g. skip the weakest:
#   npx tsx src/scripts/backfillPortfolioReviews.ts --role R019 --min-score 4.0 [--dry-run]
# then, if wanted:  --statuses "Hold for Future"
```

   - The dry run prints how many Active, ResumeIQ-scored R019 applications have never been reviewed (it does not classify the answers — step 0's forecast does). The real run prints one line per application: `pending (N links)` = queued for the worker; `no_portfolio` = settled at once (blank, "N/A", text only; no model call); `unreviewable` = settled at once (a LinkedIn/Facebook/WeTransfer/Google Play/Looker Studio/Google Photos-only answer — printed per line, **not** counted in the final "settled" total); `skipped — …` = left alone (base scoring not finished, or a review already running) and stepped over. Expect roughly 90 answers with a link (some of those end `unreviewable` or `inaccessible` at the worker), about 18 text-only and about 17 blank — the final line (`queued for review: N, settled without a browser: M, left unchanged: K`) is the real count.
   - The script only queues (a minute or two for ~120 applications). The worker then drains `maxConcurrency: 5` at a time, each review taking one to a few minutes — measured on 2026-10-25 with `--min-score 4`: 87 eligible Active applications, 56 queued (drained in about 15 minutes at `maxConcurrency` 5, 03:14–03:29 IST by the activity log), 31 settled at once (20 `no_portfolio`, 11 `unreviewable`), 0 errors — the forecast made before the run ("roughly 90 with a link", 30–60 minutes) is historical. **There is no throttle** (the plan's "concurrency 2–3" was not built: `maxConcurrency` is 5, and the script's `--limit` is only the page size of each API call, at most 10 — not a cap on the run). To pause, Ctrl-C the script: what is already queued still runs, and re-running the same command resumes (applications already queued or reviewed are skipped). To go slower, run it in waves by status, or lower `maxConcurrency` in `vercel.json` and redeploy (messages queued earlier stay pinned to the older deployment).
   - Averages move **while** it runs (each fold lands when its review finishes) — do it when nobody is shortlisting from Ready for review.

7. **Spot-check — not scheduled** (Aaron's decision, 2026-10-25); the checklist stays here for whenever someone does one (Mansi, ~10–15 candidates, spread across scores and across link types — a Drive deck, a site, a video-only, an Instagram-only, a private link, a text-only). For each, open the Portfolio review card and compare it with her own read of the same material:
   - Every link she can see in the answer is accounted for: under "Work reviewed" or under "Not reviewed — open these by hand", with a believable reason.
   - The coverage line is truthful: videos say "not watched", Instagram says "caption only", a partly read deck says how much, a website the crawl did not finish says "Partly: Opened 4 pages; the site links to N more that were not read" (most multi-page sites do: open the pages that were not read and check the verdict does not depend on them); "Based on N of M links" matches what she would say.
   - Strengths, concerns and the "evidenced / partly / not evidenced" lines cite things that are really in the work, and nothing refers to the person (age, gender, family, looks, name).
   - Attribution is right (the candidate's own work vs employer/client work vs credited to someone else) and any red flag ("credited to someone else", "link text aimed at AI reviewers") holds up when she opens the link.
   - The score is within about one to two points of her own judgement; note the direction of every disagreement (too generous on thin decks? too harsh on B2B or regional-language work?).
   - The "Not scored" candidates really had nothing reviewable (a "private" link that is actually public, an "N/A" that was not N/A, a bot-walled own site that she can open).
   - The caps note and the confidence chip make sense. The note lists only caps that really lowered the score (one thin work sample or work only on employer/client pages: 6; an ownership concern: 3; work credited to someone else: 2); a score capped at 6 was really thin.
   - Open "How the evidence was checked" (collapsed under the card) on a few reviews: it lists every verdict the code lowered — a source the reviewer was never shown, a quote that was not in the text ("the quote is invented"), text-only evidence, a PDF judged from its extracted text. One or two per review is normal; a review full of them means the model is quoting loosely (note it; M6 counts them).
   Fix the ones that are wrong with Re-run first (a transient failure), then collect the rest as evidence for a prompt or rubric change in `analyze.marketing.ts` / `rubric.marketing.ts` — not by hand-editing scores.

8. **Watch the first days.** All read-only; run them in the Supabase SQL editor. *First reading, 2026-10-25, after the backfill:* M1 as in step 6; M2 the 33 scores read 1: 2, 2: 4, 3: 11, 4: 4, 5: 6, 6: 2, 7: 3, 8: 1 (mean 3.94); M4 37 model calls (the 33 completed and 4 `no_portfolio`), mean 17,610 input and 2,418 output tokens, at most 34,830 input; M5 one `failed` (a Google Slides export fetch timeout), nothing stuck; M6 `ai_aimed_text` 0, `links_withheld_as_injection` 0, `fairness_filter_fired` 0, `personal_details_removed` 15, `pdf_fell_back_to_text` 0, `reviews_with_an_invented_quote` 7, `reviews_with_a_near_match_quote` 4, `scored_on_judgement_only` 0; M8, M8b and M8c return no rows.

```sql
-- M1 status mix
SELECT COALESCE(portfolio_analysis_status, '(never reviewed)') AS status, count(*) FROM applications WHERE role_id = 'R019' GROUP BY 1 ORDER BY 2 DESC;

-- M1b why the not-scored ones were not scored: the run's own message, most common first. "The material could not be assessed (unreadable, or in a
-- language the review cannot judge)" = the reviewer was shown work but could assess none of the criteria the work can show (rare; read a few).
SELECT portfolio_analysis_status AS status, left(portfolio_analysis_error, 100) AS message, count(*) AS applications
FROM applications
WHERE role_id = 'R019' AND portfolio_analysis_status IN ('no_portfolio', 'inaccessible', 'unreviewable')
GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20;

-- M2 score distribution (folded scores only)
SELECT score_portfolio, count(*) FROM applications WHERE role_id = 'R019' AND score_portfolio IS NOT NULL GROUP BY 1 ORDER BY 1;

-- M3 outcome of every link by platform, and the commonest reasons it was not read
SELECT p->>'platform' AS platform, p->>'outcome' AS outcome, count(*) AS links
FROM portfolio_analyses pa JOIN applications a ON a.id = pa.application_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pa.analysis->'portfolios', '[]'::jsonb)) p
WHERE a.role_id = 'R019' AND pa.analysis->>'kind' = 'marketing_work'
GROUP BY 1, 2 ORDER BY 1, 3 DESC;

SELECT regexp_replace(p->>'url', '^https?://([^/]+).*$', '\1') AS host, p->>'outcome' AS outcome, left(p->>'reason', 90) AS reason, count(*) AS links
FROM portfolio_analyses pa JOIN applications a ON a.id = pa.application_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pa.analysis->'portfolios', '[]'::jsonb)) p
WHERE a.role_id = 'R019' AND p->>'outcome' IN ('inaccessible', 'unreviewable', 'failed')
GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 30;

-- M3c links the candidate listed that were never opened by policy (LinkedIn, Facebook/X, WeTransfer, Google Play / Looker Studio / Google Photos, over a cap) — NOT the same list as above:
-- `unreviewed` holds only these; a link that was opened but could not be used stays in `portfolios` with its outcome and reason (M3)
SELECT u->>'platform' AS platform, left(u->>'reason', 70) AS reason, count(*) AS links
FROM portfolio_analyses pa JOIN applications a ON a.id = pa.application_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pa.analysis->'unreviewed', '[]'::jsonb)) u
WHERE a.role_id = 'R019' AND pa.analysis->>'kind' = 'marketing_work'
GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 30;

-- M3d the limits of fix round 4 at work: sites read only in part (the crawl opens 4 pages), PDFs refused as too complex (neutral, never retried), PDFs that
-- outran their time. A PDF the reader could not START is not here: that job fails and retries, so look for it in M5's message.
SELECT count(*) FILTER (WHERE p->>'outcome' = 'partial' AND p->>'reason' LIKE 'Opened % page%')                   AS sites_read_in_part,
       count(*) FILTER (WHERE p->>'reason' = 'This PDF is too complex to open automatically')                      AS pdfs_too_complex,
       count(*) FILTER (WHERE p->>'reason' = 'This PDF took too long to read')                                     AS pdfs_took_too_long
FROM portfolio_analyses pa JOIN applications a ON a.id = pa.application_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pa.analysis->'portfolios', '[]'::jsonb)) p
WHERE a.role_id = 'R019' AND pa.analysis->>'kind' = 'marketing_work';

-- M4 token usage per review (model calls only; a call that was paid for but ended unscored keeps its usage too)
SELECT count(*) AS reviews,
       round(avg((pa.analysis->'usage'->>'inputTokens')::numeric))  AS avg_input_tokens,
       max((pa.analysis->'usage'->>'inputTokens')::int)             AS max_input_tokens,
       round(avg((pa.analysis->'usage'->>'outputTokens')::numeric)) AS avg_output_tokens
FROM portfolio_analyses pa JOIN applications a ON a.id = pa.application_id
WHERE a.role_id = 'R019' AND pa.analysis ? 'usage';

-- M5 failures and anything stuck
SELECT id, portfolio_analysis_status AS status, left(portfolio_analysis_error, 120) AS message, portfolio_started_at
FROM applications
WHERE role_id = 'R019'
  AND (portfolio_analysis_status = 'failed'
       OR (portfolio_analysis_status IN ('pending', 'running') AND COALESCE(portfolio_started_at, application_date) < NOW() - interval '30 minutes'))
ORDER BY portfolio_started_at NULLS FIRST;

-- M6 safety signals. `caps` holds only real score caps; the audit notes (fairness filter, personal details removed from the input,
-- a document judged from text, a verdict lowered for an invented quote or held at partial for a near-match quote, a review scored on the
-- reviewer's own judgement because the checklist could not be used) are in `evidenceNotes`.
SELECT count(*) FILTER (WHERE pa.analysis->'redFlags' @> '"Link text aimed at AI reviewers"')                                                  AS ai_aimed_text,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(pa.analysis->'portfolios', '[]'::jsonb)) p
                                      WHERE p->>'reason' = 'Contains text addressed to an AI reviewer - routed to a human'))                 AS links_withheld_as_injection,
       count(*) FILTER (WHERE pa.analysis->'evidenceNotes' @> '"Some reviewer text was removed by the fairness filter"')                       AS fairness_filter_fired,
       count(*) FILTER (WHERE pa.analysis->'evidenceNotes' @> '"Personal details (age, family, years of experience, contact details) were removed from the text sent to the reviewer"') AS personal_details_removed,
       count(*) FILTER (WHERE pa.analysis->'evidenceNotes' @> '"A document could not be read natively - judged from its extracted text"')     AS pdf_fell_back_to_text,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(pa.analysis->'evidenceNotes', '[]'::jsonb)) n
                                      WHERE n LIKE '%the quote is invented%'))                                                               AS reviews_with_an_invented_quote,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(pa.analysis->'evidenceNotes', '[]'::jsonb)) n
                                      WHERE n LIKE '%the quote is a near match%'))                                                           AS reviews_with_a_near_match_quote,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(pa.analysis->'evidenceNotes', '[]'::jsonb)) n
                                      WHERE n LIKE '%so the checklist was not used%'))                                                       AS scored_on_judgement_only
FROM portfolio_analyses pa JOIN applications a ON a.id = pa.application_id
WHERE a.role_id = 'R019' AND pa.analysis->>'kind' = 'marketing_work';

-- M7 monthly fairness audit (audit only: the tag is never an input to the review). Score by tag, and by how the work was submitted.
SELECT COALESCE(c.gender, 'not tagged') AS gender, count(*) AS scored, round(avg(a.score_portfolio), 2) AS avg_portfolio_score
FROM applications a JOIN candidates c ON c.id = a.candidate_id
WHERE a.role_id = 'R019' AND a.score_portfolio IS NOT NULL GROUP BY 1 ORDER BY 1;

-- M8 tripwire 1: a "completed" review that no model call produced (model 'none') must not exist — it would be a folded score from an empty review.
-- The code now routes such a result to 'unreviewable'; this must return NO rows.
SELECT a.id, a.score_portfolio, a.portfolio_analysis_status
FROM applications a JOIN portfolio_analyses pa ON pa.application_id = a.id
WHERE a.role_id = 'R019' AND a.portfolio_analysis_status = 'completed' AND pa.analysis->>'model' = 'none';

-- M8b tripwire 2: a "completed" review must rest on at least one opened work sample that the model was SHOWN (a stored `coverage`) and did not call
-- irrelevant or profile-only. Must return NO rows.
SELECT a.id, a.score_portfolio
FROM applications a JOIN portfolio_analyses pa ON pa.application_id = a.id
WHERE a.role_id = 'R019' AND a.portfolio_analysis_status = 'completed'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(pa.analysis->'portfolios', '[]'::jsonb)) p
                  WHERE p->>'coverage' IS NOT NULL AND p->>'basis' = 'artifact'
                    AND COALESCE(p->>'relevance', '') NOT IN ('irrelevant', 'profile_only'))
ORDER BY a.id;

-- M8c tripwire 3: a "completed" review must have at least ONE direct or quality criterion that was assessable (the code settles "nothing assessable" as
-- 'unreviewable', never as a score made of half the model's number). Also lists a completed review with no criteria array at all. Must return NO rows.
SELECT a.id, a.score_portfolio
FROM applications a JOIN portfolio_analyses pa ON pa.application_id = a.id
WHERE a.role_id = 'R019' AND a.portfolio_analysis_status = 'completed' AND pa.analysis->>'kind' = 'marketing_work'
  AND NOT EXISTS (SELECT 1
                  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(pa.analysis->'criteria') = 'array' THEN pa.analysis->'criteria' ELSE '[]'::jsonb END) c
                  WHERE c->>'group' IN ('direct', 'quality') AND COALESCE((c->>'assessable')::boolean, true))
ORDER BY a.id;
```

   What to look for:
   - **Status mix (M1).** Mostly `completed` plus the ~35 settled `no_portfolio`; `unreviewable` for LinkedIn/Instagram/video-only answers; `inaccessible` for genuinely private links; **`failed` close to zero** (it is ours). M1b says why each not-scored one was not scored; "The material could not be assessed …" should be rare (a handful at most) — read those few cards, a cluster means the reviewer is mislabelling readable work as unassessable.
   - **Outcomes by platform and host (M3).** A spike of `unreviewable`/`inaccessible` on *one* host — especially a candidate's own site, or Google Drive — means a bot wall or a Google block is being misread or has started; a spike of `failed` is our side (read `portfolio_analysis_error`, then the Vercel logs of `/api/portfolio-worker`, lines starting `[Portfolio] queue message handled`) — "The PDF reader could not be started on our side" on every PDF is the worker bundle missing `pdf.worker.mjs` or `index.cjs`, or the PDF child process not starting on Vercel (spawn / exec / process limits); "This PDF is too complex to open automatically" on ordinary decks means the child's heap flag or the 700 MB resident ceiling is tripping under Vercel's accounting (a handful on genuinely huge or odd files is normal; M3d counts them, and the sites that were read only in part). M3c is policy, not a fault: LinkedIn, Facebook/X and WeTransfer links are never opened, so they pile up there by design.
   - **Token usage (M4).** `inputTokens` per review should sit well under the 100,000 the analyzer plans for (the planner assumes 2,500 tokens per PDF page and 1,500 per image; measured is about 1,600 per page; the one local real-API canary, a strong text deck, used 16,447 input and 2,869 output tokens, and a review costs about 0.05–0.10 USD; measured in production on 2026-10-25: 37 calls, mean 17,610 input / 2,418 output, the 33 completed reviews about 3 USD in all at list price). 429s from the model are retried automatically (the job goes back to the queue after 120 s, up to 3 deliveries) and only surface as `failed … rate limit` after the third — if you see that, pause the backfill or use the dedicated key.
   - **Score distribution (M2).** Not clustered at 5–6 and 9–10 rare; compare the mean with the base mean of the same candidates.
   - **Safety signals (M6)** and the **monthly fairness audit (M7)**: score gaps by the auto-tagged gender (audit only — it is never an input), by link type, text-only vs link, and agency / in-house / founder. A review whose text was filtered ("fairness filter fired") is worth a read, and so is one with an invented quote (the model quoted text that is not in the work: the code lowered that verdict, but a model that does it often is guessing). `reviews_with_a_near_match_quote` counts reviews where a quote was not verbatim but close enough (at least 70% of its words in order, every number, name and negation present) — the verdict was held at partial: a few are normal paraphrase, a share that grows next to `reviews_with_an_invented_quote` means the model is quoting loosely. `scored_on_judgement_only` counts reviews where under 40% of the criteria the work can show could be assessed, so the score is the reviewer's own number with low confidence and no checklist: a few are expected (regional-language or image-only work), many mean the model marks readable work unassessable. `links_withheld_as_injection` counts links kept out of the model because their text, address or details read as an instruction to an AI — a handful of false hits is possible (look at them), a cluster on one host is not. **M8, M8b and M8c must return no rows**: they are the tripwires for the holes the fix rounds closed (a `completed` review, with a folded score, that nothing was ever shown to the model for — M8, M8b — or that could assess none of the criteria the work can show — M8c).

## Operating notes

* **Re-run** (HR-tier, on the card or `POST /api/applications/:id/portfolio-analysis`) re-reads the screening answer and starts over. If it finds nothing it can score while the application *already has* a score, it does **not** overwrite the good review: it ends `failed` with "<why> — the earlier review (N/10) still applies. Use Re-run to retry.", the score and average stay.
* **`marketing_work` is R019's rubric.** The ten must-haves (`mh1`–`mh10`) and ten nice-to-haves (`nh1`–`nh10`) are hard-coded in `rubric.marketing.ts`. Do not set the kind on another role without writing that role's own rubric; and the kind is set by SQL only (`POST/PATCH /api/roles` ignore it).
* **The role's text is read live.** If R019's `must_have_skills` / `nice_to_have_skills` change, the next review uses the new wording (the review injects the raw lists, not `generated_jd_content`, which is capped at 8 + 8 bullets).
* **`PORTFOLIO_ANALYSIS_MODEL`** (default `claude-sonnet-4-5`) is read by both reviews: changing it changes R007's too.
* **The fold trade-off is deliberate, measured and kept (Aaron, 2026-10-25):** a weak sample (say 4/10) can pull someone's average below a candidate who submitted nothing and is not scored — and on the first 33 reviews it did so often (26 averages down, 4 up, mean −0.18; 10 candidates down a priority bucket, one lost Strong Fit and the 24h SLA tier, three fell below 4.0). `foldPolicy` stays `'always'` for `marketing_work`. The alternative, `'upside_only'` (a score below the candidate's own 8-dimension average is stored and shown but not folded), stays in code in `services/portfolio/profiles.ts`, unused.
* **Known limit of the busy hand-back:** a review is bounced back to the queue when this instance's Chromium is in use even if it needs no browser (documents and videos only). It retries, so it only costs time during a backfill.
* **The model is blind to who the candidate is.** Their name is masked as `[candidate]` in everything it reads — exact tokens, and whatever the name signal reads as a full-name match: variant spellings, CamelCase, an initial beside the family name (other people's credits are left alone: a shared surname is not masked; only the first 8 tokens of the first 300 characters of the form name are used) — personal statements (age, family, contact details) are removed from the answer and the pages' text before it sees them — at phrase level, so the rest of a sentence and a campaign list survive, and a number of years of experience becomes `[years]` — and one fixed line per link says whether the system found the name in that link, did not find it, or could not tell. **City and college are deliberately NOT masked** (location is legitimately part of portfolio text), and personal statements in Roman-script Tamil, Marathi, Bengali or Telugu are not recognised; the redaction and the output filter are heuristics: about 85–90% on wording they have never seen (60% and 57.5% on the first sight of two fresh sets in fix round 4, then generalised), with 1–2% of harmless sentences changed — known misses: a personal fragment in a comma list that also names a client, the candidate's own name used in the third person beside a client cue, a bracketed age ("Brand lead (37)"), "b. 1987", "first-generation graduate"; known false positives: "The founder is a woman and the client is a bank", the age of a person named in the work. If a spot-check finds a review that mentions a name, an age, a family detail or a contact, that is a miss of the input masking or the output filter — keep the review and report it with the wording (a city or a college is not a miss). "Credited to someone else" (cap 2) and an ownership concern (cap 3) need a credit line the reviewer quotes from the link's own text naming a different full person, plus the system's own finding that the candidate's name is not in the readable text; anything less is "cannot tell", with no cap and no flag.
* **A model failure is retried, not recorded as a verdict.** A reply that was cut off, unparseable, or answered fewer than 12 of the 15 criteria, a rate limit or an overload all go back to the queue (two retries, then `failed` — "Analysis failed — …", with Re-run). The stored text reads "Analysis failed — the reviewer service was busy or unavailable. Use Re-run to retry." (a transient failure: 408/409/425/429/5xx, a timeout) or "… the reviewer service could not process the request …" (another 4xx); it never carries the API's own words, a key or a URL.
* **A flag-off does not release queued jobs:** a job the worker picks up for a role that has been switched off is recorded `failed` ("Portfolio review is not enabled for this role"), as the designer review always did. After re-enabling the role HR has to press Re-run on those (the backfill only picks up applications that were never reviewed, i.e. status NULL).
* **How a score is made (three modes).** When at least 40% of the criteria the work can show were assessable, the reviewer's own 0–10 and the checklist are averaged and a small nice-to-have bonus is added (only when the average is at least 6, never creating a 10), rounded once. **The result is never more than one point above the reviewer's own score** — a limit that also applies with no bonus: it lowers about 2.8% of typical score combinations by one point (a simulation; on the 33 real reviews present when the 2026-10-25 backfill had drained, the real formula, accelerator bonus included, had it lower 13 of them, two of them by two points, so the mean portfolio score was 3.94 instead of 4.39; ignoring the bonus it is 10, none by two, 4.24), and narrowing it to the bonus alone is a one-line change in `marketingScore` (`rubric.marketing.ts`) if it is judged too strict. When under 40% were assessable, the score is the reviewer's own number with low confidence ("… so the checklist was not used"). When none were, the review is not scored.
* **A "too complex" PDF is a verdict on the file, never retried.** A PDF the pre-flight refuses (hostile or pathological structure: more than 80,000 `stream` words, 8 MB of dictionary text, …), or whose parse process is killed at the 12 s deadline or the 700 MB resident ceiling, runs out of heap or crashes, is recorded `unreviewable` ("This PDF is too complex to open automatically"); retrying would only burn another 300 s. A PDF that cannot be read because OUR reader did not start (the child process could not be spawned, a missing module or `pdf.worker.mjs`) is `failed` and is retried. The parse runs in a child process (`--max-old-space-size=512`, empty environment, no shell, no IPC, the PDF on stdin, one JSON line back), which is resource isolation, not a security sandbox (same OS user: an exploit in pdfjs could read the parent's `/proc/<ppid>/environ`); a child orphaned when the parent dies by SIGKILL or SIGTERM ends itself within about a second (a watchdog thread inside the child checks its parent every second and has a hard cap of the read's own deadline + 3 s; measured in the Lambda image: 1.0 s after either signal), so no orphan should ever be found; **a PDF that ran out of its own time WAITING in the one-at-a-time queue behind other files is `failed` ("The PDF reader could not be started on our side - this will be retried") and is retried like any failure on our side — never the neutral "took too long to read"** (that one is only for a file that STARTED and ran out of time, or that arrived already late); the resume parsing of every role (`driveService.ts`) has no such protection — PR #21 (open, NOT merged as of 2026-10-25) reuses the sandbox there; see the known gaps in `CLAUDE.md`.
* **Most multi-page websites are `partial` — intended.** The crawl opens at most 4 pages and takes only the best-scored few links of each, so a site that links to more is read in part and says so ("Opened 4 pages; the site links to M more that were not read"; M3d counts them). The consequence is deliberate and conservative: the name signal is only ever "not found" for an item read in full, so for websites it is almost never "unlikely" and the "credited to someone else" cap (2) and the ownership-concern cap (3) rarely apply to them — they still apply to a fully read deck or PDF. If a spot-check shows a site whose verdict leaned on pages that were not read, that is this limit, not a bug; Re-run does not change it.
* **The PDF child process and the browser teardown guard add a little time, not a verdict.** About +140–200 ms per PDF for the child's start-up (measured under load), and about 0.25 s per navigation or close for the teardown guard (about 1 s on a 4-page site; about 5 s more under emulated Lambda). Neither changes what is scored. If reviews get noticeably slower, or `failed` rises with "The PDF reader could not be started on our side", look at the function's process limits first.
* **A stuck browser is a retried failure, not a hang.** A captured site whose script never returns can keep Chromium from answering its own close, which used to hold the worker until Vercel's 300 s kill (and the row on `running` until Re-run). `withBrowser` now races the close against 10 s and kills the browser process (the designer review shares this, on purpose: it changes nothing unless a close has not returned in time), and the marketing review waits for the capture only until its capture deadline plus 15 s. Either ends as a failure on OUR side: attempts 1 and 2 hand the job back to the queue, attempt 3 records `failed` ("Website capture did not finish — the browser did not respond in time. Use Re-run to retry."). A worker log line `[portfolio] the browser did not close within 10s; killing it` marks such a site: an occasional one is a hostile page, many mean something else is wrong (check the Chromium build first). Measured in the Lambda image: the close was killed at 10.03 s after the capture returned, the slot was free at once and Chromium was gone 53 ms later.

## Rollback

*Stop* is one line (top of this file). *Undoing the folded averages* is a separate SQL because the fold wrote into `score_avg`, `ai_fit_score`, `ai_priority_bucket`, `sla_hours`, the executive summary and the red flags. Every statement below was run on 2026-10-22 inside a rolled-back transaction on local Docker against a throwaway role, candidates and applications (a folded row, a tie-rounding row, an exact-8.0 row, a NULL-flags row, a not-scored row, a row of another role, a row with a NULL base score, and an idempotent second run): the restored values equal the originals, rows that were never folded or belong to other roles are byte-identical, and nothing was left behind. The averaging maths was also compared against the real code for every possible sum of 8 integer scores (0–80): `computeAvg`, `Math.round(avg * 10)` and `priorityBucketFromScore` equal `round(sum/8, 1)`, `round(avg * 10)` and the CASE below in all 81 cases.

**R1 — Stop** and let in-flight jobs drain (a job lasts at most 300 s; a queued one for a switched-off role is refused, not run):

```sql
UPDATE roles SET portfolio_analysis_enabled = false WHERE id = 'R019';   -- keep portfolio_review_kind as it is
-- wait ~6 minutes, then this should return no rows (a row whose message says "Could not be queued" is not in flight; it just waits for a Re-run):
SELECT id, portfolio_analysis_status FROM applications WHERE role_id = 'R019' AND portfolio_analysis_status IN ('pending', 'running');
```

**R2 — Preview** (read-only) what the undo will change — `avg_after` is the mean of the 8 stored base scores, one decimal:

```sql
-- R2 (read-only): what the undo would change. avg_after is the mean of the 8 stored base scores, 1 decimal.
SELECT a.id, a.stage, a.score_portfolio,
       a.score_avg AS avg_now,
       round((a.score_technical + a.score_experience + a.score_industry_fit + a.score_culture_fit
            + a.score_role_alignment + a.score_trajectory + a.score_leadership + a.score_communication)::numeric / 8, 1) AS avg_after,
       a.ai_fit_score AS fit_now
FROM applications a
WHERE a.role_id = 'R019'
  AND a.score_portfolio IS NOT NULL
  AND num_nonnulls(a.score_technical, a.score_experience, a.score_industry_fit, a.score_culture_fit,
                   a.score_role_alignment, a.score_trajectory, a.score_leadership, a.score_communication) = 8
ORDER BY a.id;
```

**R3 — Undo** — takes every folded score back out of the average (it recomputes from the 8 stored base scores and strips what the fold appended to the summary and red flags, then clears the review's columns). One statement, so atomic; idempotent. It touches only R019 rows that carry a portfolio score and all 8 base scores:

```sql
-- R3: take every folded Head of Marketing score back out. One statement, so atomic; idempotent (a second run finds nothing to do).
UPDATE applications a SET
  score_avg          = b.avg,
  ai_fit_score       = round(b.avg * 10)::int,
  ai_priority_bucket = CASE WHEN b.avg >= 8 THEN 'Strong Fit' WHEN b.avg >= 6 THEN 'Review'
                            WHEN b.avg >= 4 THEN 'Low Priority' ELSE 'Reject' END,
  -- applyPortfolioOutcome sets this to 48 at Applied and Screened (SLA_HOURS.RESUME_REVIEW_NORMAL = ..._HIGH_FIT = 48)
  sla_hours          = CASE WHEN a.stage = 'Applied and Screened' THEN 48 ELSE a.sla_hours END,
  -- strip what the fold appended: " Portfolio review: <one-liner>" on the summary, "Portfolio: <flag>" entries on the red flags
  score_summary      = btrim(split_part(a.score_summary, ' Portfolio review: ', 1)),
  score_red_flags    = ARRAY(SELECT t.f FROM unnest(a.score_red_flags) WITH ORDINALITY AS t(f, n)
                             WHERE t.f NOT LIKE 'Portfolio: %' ORDER BY t.n),
  score_portfolio = NULL, score_portfolio_note = NULL,
  portfolio_analysis_status = NULL, portfolio_analysis_error = NULL,
  portfolio_started_at = NULL, portfolio_analyzed_at = NULL
FROM (
  SELECT id, round((score_technical + score_experience + score_industry_fit + score_culture_fit
                  + score_role_alignment + score_trajectory + score_leadership + score_communication)::numeric / 8, 1) AS avg
  FROM applications
  WHERE role_id = 'R019'
    AND score_portfolio IS NOT NULL
    AND num_nonnulls(score_technical, score_experience, score_industry_fit, score_culture_fit,
                     score_role_alignment, score_trajectory, score_leadership, score_communication) = 8
) b
WHERE a.id = b.id;
```

**R4 — Optional** — also clear the "Not scored" / failed cards of the rows that never had a score, so that a later backfill treats them as never reviewed (without this, those cards keep showing their accurate "Not scored" text):

```sql
-- R4 (optional): also clear the "Not scored" / failed cards of the rows that never had a score, so a later backfill treats them as never reviewed.
UPDATE applications
SET portfolio_analysis_status = NULL, portfolio_analysis_error = NULL, portfolio_started_at = NULL, portfolio_analyzed_at = NULL
WHERE role_id = 'R019' AND score_portfolio IS NULL
  AND portfolio_analysis_status IN ('no_portfolio', 'inaccessible', 'unreviewable', 'failed');
```

**Caveats.** (a) **±0.1:** the original `score_avg` was the figure the model reported for its 8 scores, while the undo recomputes the mean of the stored integers, so a restored average can differ from the original by 0.1 (and the fit score by 1) — step 0's drift query says how many rows. On the 33 rows that were actually folded (checked 2026-10-25) the recomputed mean equalled the logged pre-fold fit score in all 33, so R3 would restore them exactly. For the exact original values of any other row restore from the snapshot of step 3 of *Order matters*, if one was taken. (b) `NULL` red flags come back as an empty array. (c) The stored reviews (`portfolio_analyses`) and the "Portfolio Review Completed" activity rows are kept on purpose (history, and a later re-enable can reuse them); remove them with `DELETE FROM portfolio_analyses WHERE application_id IN (SELECT id FROM applications WHERE role_id = 'R019')` only if you must. (d) To **re-enable** later: the same flag statement as step 4, then the backfill (it picks up every row whose status is NULL, which the undo restored). (e) Roll the **code** back only after R3: the previous frontend does not know the `unreviewable` status, and the previous backend ignores `portfolio_review_kind`; the schema is additive and stays.

## Where production stands (2026-10-25)

**The review is LIVE for R019 and R019 has been backfilled (steps 1, 2, 4, 5 and 6 are done; step 3 is not recorded).** Flagged 2026-10-24 (about 15:00 IST), canary the same afternoon, backfill 2026-10-25 about 03:15–03:30 IST. R019 when the backfill had drained, 125 applications: completed 33, failed 1 (a Google Slides export fetch timeout), inaccessible 2, no_portfolio 25, unreviewable 30, no review 34 (the 23 Active applications below 4.0 and the 11 Rejected ones: deliberately not backfilled, no backfill planned); nothing in flight; M8, M8b and M8c return no rows. By 2026-10-26 R019 had 133 applications: the 8 created since the flag were each reviewed at creation (6 completed, 1 no_portfolio, 1 unreviewable), so the new-applicant path is observed too. The fold moved 26 of the 33 folded averages down, 4 up (mean −0.18); 10 candidates moved down a priority bucket, one lost Strong Fit and the 24h SLA tier, three fell below 4.0. **Fold policy kept as it is (Aaron, 2026-10-25); no spot-check is scheduled.** The full numbers, the unreviewable reasons and what the real worker showed are in `CLAUDE.md`, "Production state". PR #21 (resume PDF parsing through the sandbox for every role) is open and NOT merged. What follows is the record of step 1.

**Step 1 (schema → Supabase) is DONE** — Aaron approved it in chat and it was applied on 2026-10-23 as migration `20261023111710` `portfolio_review_kinds_unreviewable_status` to project `rzbxkgymqrpvbzvjlahd` (dp-hiringmaster). Verified read-only afterwards: `roles.portfolio_review_kind` is `TEXT NOT NULL DEFAULT 'design_portfolio'` with its CHECK; `applications_portfolio_status_check` now lists the 7 statuses incl. `unreviewable`; all 19 roles read `design_portfolio`; R007 is still `portfolio_analysis_enabled = true`, R019 still `false`; the application status counts are unchanged (inaccessible 4, no_portfolio 26, NULL 1,137, failed 3, completed 132). The block is additive and the widened CHECK is a superset, so the CURRENTLY DEPLOYED code keeps working unchanged. The code was then merged and deployed (PR #18, squash `ec4ee0c`, 2026-10-23: both Vercel production deployments succeeded, the read-only production smoke suite passed 34/34, the production runtime log held no errors in the first half hour); the rest of the order ran on 2026-10-24/25 as described above. (Do not re-apply step 1; `list_migrations` shows it.)

## Known limits

* Videos are never watched (title, description, thumbnails — and, with `YOUTUBE_API_KEY`, description/duration/views); Instagram is a caption snippet; LinkedIn, Google Play, Looker Studio and Google Photos links are never opened (a link written in the answer is listed for HR; one found inside a link-in-bio page is skipped, as LinkedIn already is, and an answer that contains one is never "text only"). None of these can produce a score on its own.
* PDFs over 20 pages are read as text only (a long scanned, image-only PDF is then `unreviewable`); over 8 MB is `unreviewable`; "too complex to open automatically" (the pre-flight refuses a hostile or pathological structure, or the parse process was killed at its 12 s deadline or the 700 MB resident ceiling) is `unreviewable` and never retried; password-protected or owner-locked is `inaccessible`. A PDF whose page content the injection scan cannot fully check (an indirect `/Filter`, a PNG predictor, an unsupported filter, more than 4,000 streams or 400,000 characters of content) is read as text only too — 3 of 819 real PDFs for "could not be fully checked" (down from 52, then 12: ReportLab-style ASCII85+Flate PDFs and vector-led Figma/Canva exports go to the model as native documents again, 761 of 819 in all), and 2 of 819 are refused as too complex (a damaged Flate+DCT image, an LZW image). A website the crawl did not finish (it opens 4 pages) is `partial` with "Opened N pages; the site links to M more that were not read", so "the name is not on this site" is never claimed from a part of it. Legacy `.doc`/`.ppt`, archives and spreadsheets (other than a Google Sheet's first tab) are `unreviewable`; SharePoint/WeTransfer links are `unreviewable`; Canva view links show only their first screens (`partial`).
* Content that sits behind a login is `not_evidenced` — never a concern about the candidate. Material the reviewer cannot read at all (not delivered in a form it can look at, or in a language it cannot judge) is marked not assessable and left out of the score; a mostly-image deck is judged visually and counts as assessable.
* One review reads at most 8 links (3 documents, 2 websites, 2 videos, 2 social/short links), 18 MB, 40 PDF pages, 16 images and 60,000 characters; the rest are listed as not reviewed with the reason.
* Rate limits: five reviews run at once on the queue; the model call is the only part that can hit 429.
* The **base 8-dimension ResumeIQ for R019 still sees only 8 of the 10 must-haves and 8 of the 10 nice-to-haves** (`generated_jd_content` is capped at 8 bullets of each; must-haves 9 "pitch and sell" and 10 "startup experience" and nice-to-haves 9 "SEO" and 10 "photography / art direction" are missing there). The work-sample review is not affected (it injects the raw lists); fixing the base scoring changes every R019 score and is a separate, deliberate change.
* **The rubric is R019's.** `mh1`–`mh10` and `nh1`–`nh10` are hard-coded, and the criteria HR sees on the card are keyed on the criterion ids and show the rubric's own labels (the role's wording is no longer paired with verdicts by position; a note in "How the evidence was checked" says when the role's lists no longer parse to ten items each). Do not set `marketing_work` on another role without writing its rubric.
* **Follow-ups, not built** (the detail is in `CLAUDE.md`'s known gaps): **resume parsing in `driveService.ts` runs pdfjs on the main thread of the API function for EVERY role, with none of the PDF sandbox's protection — the recommended next step** (pre-existing and outside this feature: a hostile resume PDF can starve that function's event loop or abort it; the fix is to move `pdfSandbox.ts` out of `acquire/` and use it there, which puts `child_process` in the main bundle — an owner decision; PR #21 does it and is open, NOT merged as of 2026-10-25, so it is a follow-up, not done); the PDF sandbox is resource isolation, not a security sandbox (same OS user); a hostile candidate website can still make our browser send a blind request from inside our network (a WebSocket, a popup, or something a page starts while it unloads or while our SSRF verdict is pending) — mitigated as far as the page-level lockdown, the popup layers and the teardown guard go for R019 (0 requests on every vector tried in Brave and in the Lambda image — evidence, not proof: a page-initiated navigation, and a request puppeteer never shows the filter, are still open), **not at all for R007's designer capture, which keeps its pre-existing exposure by decision** (network-level egress filtering — a validating proxy at browser launch, or a network policy on the function — is the real fix for both; a remote-endpoint browser cannot take launch arguments, so none of `--block-new-web-contents`, `--no-pings`, `--disable-features=Reporting` apply to it); `safeFetch` checks the resolved address and then fetches by name, so DNS rebinding can race it (pre-existing); a candidate's own server can fake the bot wall that the designer review now treats as neutral (no effect on R019, where a wall only ever means "not scored"); the backfill has no concurrency throttle (step 6); a never-reviewed application has no Re-run button (step 5's console `fetch`); `run.ts`'s outer `catch` re-settles an error that was already settled (a second, conditional, idempotent release `UPDATE` on a hand-back: harmless, pre-existing).
* **Still not exercised on Vercel:** the `/proc/<pid>/status` resident-size reading (the results cannot show it: the probe returns null on any failure and the deadline and heap flag still apply; step 0's Lambda-image check is its only test), whether the model fills `creditQuote` at all (the stored review does not keep it; no link of the 33 completed reviews stood as "credited to someone else", and without a filled `creditQuote` it never can), and Vercel's own function sizes for the two bundles (the `@vercel/nft` trace and import-boundary check ran locally on the final code; the sizes in the deploy log were not read). *Exercised since 2026-10-24/25 and no longer open:* a Chromium capture of real R019 candidate sites (25 website links in 23 applications; the capture code had before only been driven in a real browser against local hostile pages), the worker's `includeFiles` glob and the PDF child process's `spawn` with `-e` / `--max-old-space-size` (the R007 re-run, then 14 PDF reads), and the real model with the fix-round-3 and -4 prompt and scoring (37 production calls at the 2026-10-25 drain; no review ended `failed` for a model reason).

## Verifying (local)

```bash
cd backend && npx tsc --noEmit -p . && npm test            # 84 files / 6,983 tests (+1 skipped file of 14 tests) on 2026-10-23 (after fix round 5), plus PR #22's 27 `min_score` cases in routes/portfolio.requeue.test.ts
cd frontend && npx tsc --noEmit -p . && npm test           # 35 files / 950 tests
cd hms-tests-final && npx playwright test tests/db/15-marketing-work-review.spec.ts   # 65 tests, plus PR #22's one; LOCAL Docker only; restart the local backend first (docker restart dp_hms_backend: its tsx watch does not always see edits made through the bind mount)
# optional, from backend/: the opt-in real-browser test, 14 tests — popups and the teardown vectors (a real DESKTOP Chrome from PORTFOLIO_CHROME_PATH or the machine; not the production build):
PORTFOLIO_REAL_BROWSER_TEST=1 npx vitest run src/services/portfolio/capture.realBrowser.test.ts
```

The production browser is the headless shell in `@sparticuz/chromium`, which neither of the above exercises, and the Node on Vercel is not the one on a laptop: after touching a launch argument, the teardown guard or the PDF sandbox, or upgrading `@sparticuz/chromium` / `puppeteer-core` / the Node image, run the Lambda-image check (step 0: popups, teardown vectors, the partial crawl and the PDF reader).

One Playwright spec outside this feature needs a working local Anthropic key: `tests/db/07-portfolio-review.spec.ts` has three tests (the creation-time-hook ones) that wait for a real base ResumeIQ score. While the local key is over its usage limit (it was over the limit when these were last run on 2026-10-23, the API message saying access returns on 2026-11-01; the workspace limit production uses was lifted on 2026-10-24 and whether the local key shares it was not checked: `docker logs dp_hms_backend | grep 'usage limits'`) they fail with "Expected: no_portfolio, Received: null" or a 409; that is the environment, not the code — the other 12 tests of that spec and all of spec 15 pass.

The review itself cannot run on local Docker (no Chromium, and the queue's `send()` fails outside Vercel by design: the row stays `pending` with a visible "Could not be queued" note). To run one locally, call `runPortfolioAnalysis(applicationId)` from a `tsx` script with `DATABASE_URL` set, as for the designer review. Blank, text-only and unopenable answers settle at enqueue without a worker, so they are fully testable on local Docker.
