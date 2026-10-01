import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// The backend compiles to CommonJS, and TypeScript rewrites `await import('x')`
// into `require('x')` in that output. require() of an ES-module-only package
// only works on Node >= 22.12 — and Vercel's "22.x" runtime was older than that
// when this shipped (production failed with ERR_REQUIRE_ESM from browser.js on
// the first real review). Our Node here is newer, so that failure can never
// show up in a local run; this test is the thing that catches it. Keep both
// packages on a release that ships a genuine CommonJS build, whatever Node
// the host happens to run.

interface Pkg { name: string; type?: string; main?: string; exports?: Record<string, unknown> | string }

function readPkg(name: string): Pkg {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'node_modules', name, 'package.json'), 'utf8'));
}

/** The file Node would load for `require('<pkg>')`, per the package's exports map / main. */
function requireTarget(pkg: Pkg): string | undefined {
  const root = typeof pkg.exports === 'object' ? (pkg.exports as Record<string, unknown>)['.'] : pkg.exports;
  let node: unknown = root;
  if (node && typeof node === 'object') node = (node as Record<string, unknown>).require ?? (node as Record<string, unknown>).default;
  if (node && typeof node === 'object') node = (node as Record<string, unknown>).default;
  return typeof node === 'string' ? node : pkg.main;
}

function isCommonJsEntry(pkg: Pkg): boolean {
  const target = requireTarget(pkg);
  if (!target) return false;
  if (target.endsWith('.cjs')) return true;
  if (target.endsWith('.mjs')) return false;
  return pkg.type !== 'module';           // a plain .js file follows the package's "type"
}

describe.each(['puppeteer-core', '@sparticuz/chromium'])('%s', (name) => {
  it('loads through require() on any Node version (ships a real CommonJS build)', () => {
    const pkg = readPkg(name);
    expect(requireTarget(pkg), `${name} has no require() entry point`).toBeTruthy();
    expect(isCommonJsEntry(pkg), `${name}@${(pkg as { version?: string }).version} only ships an ES module — require() of it fails with ERR_REQUIRE_ESM on Node < 22.12`).toBe(true);
  });
});
