/**
 * Render the social JD template for every fixture so a human can eyeball it.
 *
 *   cd backend && npx tsx src/scripts/previewSocialJd.ts [out-dir] [fixture ...]
 *
 * Writes <out-dir>/<fixture>.pdf (default out-dir: ./tmp-social-jd-preview) and,
 * when poppler's `pdftoppm` is installed, a 1080px-wide <fixture>.png beside it.
 * Run this after ANY change to socialJd.ts / socialJdLayout.ts / theme.ts and look
 * at all of the fixtures, not just R019 — the point of the template is that
 * everything after the role block adapts to the role.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { renderSocialJd } from '../services/pdf/socialJd.js';
import { SOCIAL_FIXTURES } from '../services/pdf/socialJd.fixtures.js';

async function main() {
  const [outArg, ...names] = process.argv.slice(2);
  const outDir = path.resolve(outArg ?? 'tmp-social-jd-preview');
  fs.mkdirSync(outDir, { recursive: true });
  const todo = names.length ? names : Object.keys(SOCIAL_FIXTURES);
  const havePdftoppm = spawnSync('pdftoppm', ['-v']).error === undefined;

  for (const name of todo) {
    const fx = SOCIAL_FIXTURES[name];
    if (!fx) { console.error(`Unknown fixture "${name}". Available: ${Object.keys(SOCIAL_FIXTURES).join(', ')}`); process.exitCode = 1; continue; }
    const pdf = await renderSocialJd(fx.role, fx.content);
    const pdfPath = path.join(outDir, `${name}.pdf`);
    fs.writeFileSync(pdfPath, pdf);
    if (havePdftoppm) spawnSync('pdftoppm', ['-png', '-singlefile', '-r', '72', pdfPath, path.join(outDir, name)]);
    console.log(`${name.padEnd(16)} ${(pdf.length / 1024).toFixed(0)} KB  → ${pdfPath}`);
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
