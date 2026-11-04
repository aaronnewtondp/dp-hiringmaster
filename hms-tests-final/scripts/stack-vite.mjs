#!/usr/bin/env node
// Runs the frontend's Vite for a disposable Playwright stack (scripts/test-stack.sh) through Vite's JS API.
//
//   node stack-vite.mjs dev     --root <frontend> --port <n> --cache-dir <dir>
//   node stack-vite.mjs build   --root <frontend> --out-dir <dir> --cache-dir <dir>
//   node stack-vite.mjs preview --root <frontend> --port <n> --out-dir <dir> --cache-dir <dir>
//
// It is `vite --port N --strictPort --host 127.0.0.1` (and `vite build`, `vite preview`) with the frontend's own vite.config.ts, PLUS one
// thing the CLI cannot do: a private `cacheDir`. A worktree's frontend/node_modules is a symlink to the MAIN checkout's, so the default
// cache (node_modules/.vite) is the very directory the developer's own dev server on :5173 keeps its pre-bundled dependencies in. Vite
// re-optimises (and deletes) that directory whenever its config hash differs (a different `root` is enough), which would pull the
// dependencies out from under the developer's running server. With --cache-dir pointing into .stack/<N>/ nothing outside the stack is touched.
//
// VITE_API_URL is read from the environment, exactly as for the CLI (it is baked into a build).
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [command, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];

function need(name) {
  if (!opt[name]) { console.error(`stack-vite: --${name} is required for "${command}"`); process.exit(2); }
  return opt[name];
}

const root = path.resolve(need('root'));
const cacheDir = path.resolve(need('cache-dir'));
const vitePkg = createRequire(path.join(root, 'package.json')).resolve('vite/package.json');
const vite = await import(pathToFileURL(path.join(path.dirname(vitePkg), 'dist', 'node', 'index.js')).href);
const common = { root, cacheDir, clearScreen: false };

function stayUp(server) {
  const stop = async () => { try { await server.close(); } finally { process.exit(0); } };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (command === 'dev') {
  const server = await vite.createServer({ ...common, server: { host: '127.0.0.1', port: Number(need('port')), strictPort: true } });
  await server.listen();
  server.printUrls();
  stayUp(server);
} else if (command === 'build') {
  await vite.build({ ...common, build: { outDir: path.resolve(need('out-dir')), emptyOutDir: true } });
} else if (command === 'preview') {
  const server = await vite.preview({
    ...common,
    build: { outDir: path.resolve(need('out-dir')) },
    preview: { host: '127.0.0.1', port: Number(need('port')), strictPort: true },
  });
  server.printUrls();
  stayUp({ close: () => new Promise(res => server.httpServer.close(() => res())) });
} else {
  console.error('usage: stack-vite.mjs <dev|build|preview> --root <frontend> --cache-dir <dir> [--port n] [--out-dir dir]');
  process.exit(2);
}
