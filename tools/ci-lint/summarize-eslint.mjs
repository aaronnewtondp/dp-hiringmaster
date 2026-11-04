// Turns ESLint's JSON report into GitHub annotations plus a job-summary table.
//   node tools/ci-lint/summarize-eslint.mjs <eslint.json> [--fail]
// Findings are NON-BLOCKING by default (exit 0): the run currently has 2 known findings, both in jobs/scheduler.ts (dead code,
// try/catch bodies). Pass --fail to make any finding exit 1; do that once those two are gone (see ci.yml, job lint-async).
// A file ESLint could not parse (a fatal message) always exits 1: an unlinted file is not a clean file.
import fs from 'node:fs';
import path from 'node:path';

const [reportPath, flag] = process.argv.slice(2);
if (!reportPath) {
  console.error('usage: summarize-eslint.mjs <eslint.json> [--fail]');
  process.exit(2);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const rows = [];
let fatal = 0;
for (const file of report) {
  for (const m of file.messages) {
    if (m.fatal) fatal += 1;
    rows.push({
      file: path.relative(process.cwd(), file.filePath),
      line: m.line ?? 1,
      rule: m.ruleId ?? 'parse-error',
      message: m.message,
    });
  }
}

// Workflow commands need %, \r and \n escaped in the message.
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
for (const r of rows) {
  console.log(`::warning file=${r.file},line=${r.line},title=${r.rule}::${esc(r.message)}`);
}

const byRule = {};
for (const r of rows) byRule[r.rule] = (byRule[r.rule] ?? 0) + 1;

const lines = [];
lines.push('### Async-promise lint (backend/src, production files)');
lines.push('');
lines.push(`Files linted: ${report.length}. Findings: **${rows.length}**${rows.length ? ' (non-blocking, see ci.yml)' : ''}.`);
if (rows.length) {
  lines.push('');
  lines.push('| File | Line | Rule |');
  lines.push('|---|---|---|');
  for (const r of rows) lines.push(`| \`${r.file}\` | ${r.line} | \`${r.rule}\` |`);
  lines.push('');
  lines.push('By rule: ' + Object.entries(byRule).map(([k, v]) => `\`${k}\` x${v}`).join(', '));
}
const summary = lines.join('\n') + '\n';
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);

if (fatal > 0) {
  console.error(`::error::${fatal} file(s) could not be parsed by ESLint`);
  process.exit(1);
}
if (flag === '--fail' && rows.length > 0) process.exit(1);
