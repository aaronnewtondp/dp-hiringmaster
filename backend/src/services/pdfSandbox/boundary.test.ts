// The import boundary, as a test. CLAUDE.md says the main API function (api/index.ts -> src/server.ts) must not reach anything of the portfolio worker — Chromium, the
// browser, the marketing acquisition under portfolio/acquire/ — because each of those drags tens of MB into every request's function. That was prose plus a
// one-off @vercel/nft trace; since resume parsing now runs through services/pdfSandbox/ (PDF) and services/boundedFiles/ (Word) ON the main API, it is checked here on every run.
// It reads the source: every static import, re-export, dynamic import() and require() with a literal path, followed from src/server.ts. It over-approximates (a
// dynamic import that never runs still counts), which is the safe direction for a boundary.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../..');
const BACKEND = path.resolve(SRC, '..');

const IMPORT_RE = /(?:\bimport|\bexport)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function resolveRelative(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(candidate)) return candidate;
  return null;
}

/** Every source file reachable from `entry` through relative imports, and every bare package name those files import. */
function closure(entries: string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const todo = [...entries];
  while (todo.length) {
    const file = todo.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of code.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(file, spec);
        if (resolved) todo.push(resolved);
      } else {
        packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
      }
    }
  }
  return { files, packages };
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');

describe('the main API does not reach the portfolio worker', () => {
  const main = closure([path.join(SRC, 'server.ts')]);
  const names = [...main.files].map(rel);

  it('the walk really is walking the app (it reaches the resume path, the ResumeIQ trigger and the light portfolio modules)', () => {
    expect(names).toEqual(expect.arrayContaining([
      'services/driveService.ts', 'services/resumeIQTrigger.ts', 'services/pdfSandbox/resume.ts', 'services/pdfSandbox/sandbox.ts', 'services/pdfSandbox/preflight.ts',
      'services/boundedFiles/resumeDocx.ts', 'services/boundedFiles/docx.ts', 'services/boundedFiles/xml.ts', 'services/boundedFiles/zip.ts',
      'services/portfolio/enqueue.ts', 'services/portfolio/links.ts', 'routes/portfolio.ts',
    ]));
    expect(names.length).toBeGreaterThan(50);
  });

  it('no worker-only module is reachable: not the browser, the capture, the vision analysis, the orchestrators, the queue consumer or anything under acquire/', () => {
    const workerOnly = names.filter(n =>
      /^services\/portfolio\/(browser|capture|analyze|analyze\.marketing|run|run\.marketing|queueHandler)\.ts$/.test(n) || n.startsWith('services/portfolio/acquire/'));
    expect(workerOnly).toEqual([]);
  });

  it('no browser package is imported (puppeteer-core, @sparticuz/chromium), and neither of the libraries that cannot be told to stop on a hostile Word file (mammoth, jszip)', () => {
    const forbidden = ['puppeteer-core', 'puppeteer', '@sparticuz/chromium', 'jszip', 'mammoth'];
    expect(forbidden.filter(p => main.packages.has(p))).toEqual([]);
  });

  it('what the main API DOES import for resume files is only the pdfSandbox and boundedFiles folders', () => {
    const modules = names.filter(n => n.startsWith('services/pdfSandbox/') || n.startsWith('services/boundedFiles/')).sort();
    expect(modules).toEqual([
      'services/boundedFiles/docx.ts', 'services/boundedFiles/resumeDocx.ts', 'services/boundedFiles/xml.ts', 'services/boundedFiles/zip.ts',
      'services/pdfSandbox/preflight.ts', 'services/pdfSandbox/resume.ts', 'services/pdfSandbox/sandbox.ts',
    ]);
  });
});

describe('services/pdfSandbox imports nothing of HMS', () => {
  const dir = path.join(SRC, 'services/pdfSandbox');
  const sources = fs.readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it.each(sources)('%s: node built-ins and its own folder only (no database, no Drive, no portfolio, no acquire/)', file => {
    const { files, packages } = closure([path.join(dir, file)]);
    expect([...files].map(rel).filter(f => !f.startsWith('services/pdfSandbox/'))).toEqual([]);
    // worker_threads and @napi-rs/canvas are named only inside sandbox.ts's CHILD SCRIPT (a string that runs in the child process: its deadman-switch thread and the
    // optional native canvas pdfjs prefers); the walk cannot tell a string from an import, and neither is ever loaded by the process that imports this folder.
    const allowed = new Set(['child_process', 'fs', 'module', 'perf_hooks', 'zlib', 'worker_threads', '@napi-rs/canvas']);
    expect([...packages].filter(p => !allowed.has(p))).toEqual([]);
  });

  it('the folder holds the three modules and no more (a new one needs its place in this boundary decided)', () => {
    expect(sources.sort()).toEqual(['preflight.ts', 'resume.ts', 'sandbox.ts']);
  });
});

describe('services/boundedFiles imports nothing of HMS', () => {
  const dir = path.join(SRC, 'services/boundedFiles');
  const sources = fs.readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it.each(sources)('%s: node\'s zlib and its own folder only (no database, no Drive, no portfolio, no acquire/, no pdfSandbox)', file => {
    const { files, packages } = closure([path.join(dir, file)]);
    expect([...files].map(rel).filter(f => !f.startsWith('services/boundedFiles/'))).toEqual([]);
    expect([...packages].filter(p => p !== 'zlib')).toEqual([]);
  });

  it('the folder holds the four modules and no more (a new one needs its place in this boundary decided)', () => {
    expect(sources.sort()).toEqual(['docx.ts', 'resumeDocx.ts', 'xml.ts', 'zip.ts']);
  });
});

describe('the worker reaches the same sandbox through the old path', () => {
  it('portfolio/acquire/pdf.ts and pdfSandbox.ts still exist and resolve into services/pdfSandbox', () => {
    const { files } = closure([path.join(SRC, 'services/portfolio/acquire/pdf.ts'), path.join(SRC, 'services/portfolio/acquire/pdfSandbox.ts')]);
    const names = [...files].map(rel);
    expect(names).toEqual(expect.arrayContaining(['services/pdfSandbox/sandbox.ts', 'services/pdfSandbox/preflight.ts']));
    expect(BACKEND).toContain('backend');
  });

  it('portfolio/acquire/office.ts and zip.ts still exist and resolve into services/boundedFiles (the Word, zip and XML readers the work-sample review uses)', () => {
    const { files } = closure([path.join(SRC, 'services/portfolio/acquire/office.ts'), path.join(SRC, 'services/portfolio/acquire/zip.ts')]);
    expect([...files].map(rel)).toEqual(expect.arrayContaining(['services/boundedFiles/zip.ts', 'services/boundedFiles/xml.ts', 'services/boundedFiles/docx.ts']));
  });
});
