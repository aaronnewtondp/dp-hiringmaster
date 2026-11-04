# CI for the HMS repository

Everything here runs on GitHub-hosted `ubuntu-latest` runners, which are free and unlimited for a public repository. No workflow needs a repository secret to pass. Every third-party action is pinned to a full commit SHA with its version in a comment; Dependabot keeps both in step.

| Workflow | When | What it checks |
|---|---|---|
| `ci.yml` | every PR, push to `main` | backend `tsc` + Vitest; backend loads on Node 22.11 (Vercel's older 22.x); frontend `tsc` + Vitest + `vite build`; Playwright suite type-check; async-promise lint; database schema, seed and id-sequence guards; actionlint + shellcheck. The last job, **CI passed**, is the single check to require in branch protection. |
| `codeql.yml` | PR, push to `main`, weekly | CodeQL `javascript-typescript`, `security-extended` suite, results under Security > Code scanning |
| `dependency-review.yml` | PR | fails a PR that adds or updates a dependency to a version with a high or critical advisory |
| `secret-scan.yml` | PR, push, weekly | gitleaks over the new commits (PR, push) or the whole history (weekly, manual) |
| `audit.yml` | weekly, manual, PRs touching a lockfile | `npm audit --omit=dev` for backend and frontend; informational, never fails the run |
| `integration.yml` | nightly, manual | Playwright `api` + `db` projects against a real backend and Postgres, no credentials (659 tests, about 20 s) |

## Two ratchets (read before "fixing" a warning)

CI found real defects on its first run. Each is recorded, shown as a warning on every run, and does not fail the build; anything **new** does.

- `ci/known-db-defects.txt`: sequences that start behind their seeded ids (`seq_eval_question`, `seq_comp_benchmark`). `ci/apply-db.sh` additionally tolerates exactly one known error in `seed.sql` (`setval(seq, 0)` on an empty database). Delete the line, and the matching step, when the bug is fixed; the job prints a notice for a line that no longer matches.
- `tools/ci-lint/summarize-eslint.mjs`: the async-promise lint reports its 2 known findings (`backend/src/jobs/scheduler.ts`, dead code with `try/catch` bodies) without failing. Add `--fail` in `ci.yml` once they are gone.

## Run it locally

```bash
# database guards (needs a Postgres you may wipe; PG* variables name it, the database must exist and be empty)
PGHOST=localhost PGPORT=5432 PGUSER=hms_user PGPASSWORD=... PGDATABASE=scratch bash .github/ci/apply-db.sh
PGHOST=localhost PGPORT=5432 PGUSER=hms_user PGPASSWORD=... PGDATABASE=scratch bash .github/ci/check-db.sh

# async-promise lint and Playwright type-check: see tools/ci-lint/README.md
# gitleaks: install the version in secret-scan.yml, then
gitleaks git --config .github/gitleaks.toml --redact --no-banner .
```

## Things that are easy to get wrong

- **gitleaks exceptions** are rule-scoped (`[[rules.allowlists]]`). A global `[[allowlists]]` with `paths` skips the whole file whatever `condition` says (measured with 8.30.1). Read the header of `gitleaks.toml` first.
- **`--redact` stays on.** Workflow logs of a public repository are public.
- **Dependabot ignores** use `update-types`, not name-only, so security PRs for pinned packages are not suppressed (see `dependabot.yml`).
- **CodeQL advanced setup** (this repo) and GitHub's "default setup" exclude each other: do not switch default setup on.
- **Repository settings** are not files and are not changed by any of this. The recommended ones are listed with the change that introduced CI.
