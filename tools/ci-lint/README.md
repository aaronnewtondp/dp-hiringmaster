# tools/ci-lint

CI-only checks. This package is deliberately separate from `backend/`, `frontend/` and `hms-tests-final/`: Vercel installs from the first two, and nothing here may ever reach a production install. Do not add these dependencies to those packages.

Run everything **from the repository root** (ESLint's base path is the working directory when `--config` is given, which is what lets one config here lint files in `backend/`):

```bash
(cd tools/ci-lint && npm ci)
(cd backend && npm ci)              # the type-aware rules read types from backend's own node_modules
(cd hms-tests-final && npm ci)      # the Playwright type-check resolves @playwright/test from here

# 1. Async-promise lint of backend/src (production files only)
tools/ci-lint/node_modules/.bin/eslint --config tools/ci-lint/eslint.config.mjs backend/src

# 2. Type-check of the Playwright suite (Playwright itself transpiles without checking)
tools/ci-lint/node_modules/.bin/tsc --project tools/ci-lint/tsconfig.playwright.json
```

| File | What it is |
|---|---|
| `eslint.config.mjs` | `no-floating-promises`, `await-thenable`, `no-misused-promises` plus one syntax rule banning `setImmediate(async ...)`: the "no fire-and-forget async on Vercel" rule in `CLAUDE.md`. The header comment records what was measured and why `routes/` is scoped as it is. |
| `summarize-eslint.mjs` | Turns the ESLint JSON into annotations and a job summary. Findings do not fail the job unless `--fail` is passed. |
| `tsconfig.playwright.json` | Type-checks `hms-tests-final/**/*.ts` without putting a `tsconfig.json` inside the suite (Playwright reads one, so adding it there could change behaviour). `strict` is off: with it on there is one error, `helpers/calendar.ts:37` (`undefined` versus `null`). |

`typescript` is pinned to 5.9.3, the version in `backend/package-lock.json`: `typescript-eslint` 8.72 supports TypeScript below 6.1, and npm's latest is 7.x.
