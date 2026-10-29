## What and why

<!-- One or two sentences. Link the role/application ids (R###, A####) if it came from a real case. No candidate names or e-mail addresses: this repository is public. -->

## Before you merge

**Database**
- [ ] No schema change, **or** the change was applied in this order: Supabase, then local Docker, then appended to `backend/src/db/schema.sql` (skipping the last step means the next `docker-compose down -v` brings the bug back)
- [ ] No two tables share a sequence; a new id uses its own `seq_*` and `format_seq_id(...)`, never `LPAD(nextval(...))`
- [ ] A seeded table with explicit ids also advances its sequence past them (`seed.sql`)

**Code**
- [ ] No fire-and-forget async on a mutating route (`setImmediate`, un-awaited promise): on Vercel the function can be frozen once the response is sent. Await it and return a `{ success, error }` field
- [ ] Tests added or updated: Vitest for pure logic, Playwright (`hms-tests-final/`) for behaviour through the API
- [ ] Access control: the persona gates in `backend/src/middleware/auth.ts` still hold, and restricted fields stay stripped for non-HR personas

**Docs**
- [ ] `CLAUDE.md` (and `ROADMAP.md`, the Help page and its info markers, the User Access Guide) updated **in this PR** if behaviour, architecture or a convention changed

**Deploy**
- [ ] Order is right: schema before code; backend and frontend are **separate** Vercel projects (open browser tabs keep the old frontend bundle until reload)
- [ ] If this edits live data that old code reads differently (for example `roles.hiring_manager_name`), the new code is live **before** the data is changed
- [ ] New environment variables are listed, and set in Vercel before the deploy that needs them

**CI**
- [ ] The `CI passed` check is green. If a job turned red for a reason outside this change, say which one here instead of merging around it
