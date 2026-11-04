// Narrow, project-specific ESLint run. It is NOT a style linter: it enables only the rules that catch this project's one
// recurring runtime bug class, a promise nobody awaits (CLAUDE.md, "Rule: no fire-and-forget async on Vercel": the
// response is sent, the function is frozen, the work never finishes, and nothing is logged).
//
// Run from the REPO ROOT (with --config the base path is the working directory, which is what lets one config in
// tools/ci-lint lint files in backend/):
//   tools/ci-lint/node_modules/.bin/eslint --config tools/ci-lint/eslint.config.mjs backend/src
// Needs `npm ci` in backend/ too: the type-aware rules read types from backend's own node_modules.
//
// MEASURED on 2026-10-29 (109 production files) with the three type-aware rules at their defaults: 89 findings, ALL of one
// kind, no-misused-promises "voidReturnArgument": 87 are Express route handlers (async functions passed to router.get/post/...,
// which is correct here because server.ts imports express-async-errors) and 2 are node-cron callbacks in jobs/scheduler.ts
// (dead code: nothing imports startScheduler, and both bodies are try/catch). No-floating-promises: 0. Await-thenable: 0.
// Hence the two scoped decisions below. Everything else is the plain default.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The exact anti-pattern the CLAUDE.md rule documents: work handed to a scheduler AFTER the response, on a platform that
// freezes the function once the response is sent. (These are the setImmediate(async () => {...}) calls that silently
// broke JD generation and ResumeIQ scoring in production for weeks.) Syntactic, so it also covers routes/, where the
// no-misused-promises scoping below stops looking at callback arguments.
const FIRE_AND_FORGET =
  'Do not hand async work to setImmediate / queueMicrotask / process.nextTick: on Vercel the function can be frozen as soon as the response is sent, so it may never run ' +
  '(CLAUDE.md, "Rule: no fire-and-forget async on Vercel"). Await it before responding and return a { success, error } field.';

export default tseslint.config(
  {
    // Production code only: tests and their fixtures are not what runs on Vercel. A GLOBAL ignore (an object holding only
    // `ignores`), so it also covers routes/*.test.ts for the routes override below; as a per-object ignore it left those
    // files matched by the override but without the plugin, and ESLint refused to start.
    ignores: ['**/*.test.ts', '**/*.fixtures.ts', '**/*.fixtures.*.ts'],
  },
  {
    files: ['backend/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: repoRoot,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: ':matches(CallExpression[callee.name=/^(setImmediate|queueMicrotask)$/], CallExpression[callee.object.name="process"][callee.property.name="nextTick"]) > :matches(ArrowFunctionExpression, FunctionExpression)[async=true]',
          message: FIRE_AND_FORGET,
        },
      ],
    },
  },
  {
    // Express route handlers: an async handler is fine because server.ts imports express-async-errors (a rejection becomes the
    // 500 handler, not an unhandled rejection). Only callback ARGUMENTS are exempted here; conditionals, spreads, returns,
    // variables, properties, attributes and the floating-promise rule all still apply to routes.
    files: ['backend/src/routes/**/*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
    },
  },
);
