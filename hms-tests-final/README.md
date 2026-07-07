# DigitalPaani HMS — Playwright Test Suite v2.0

## Quick start (local Docker)

```bash
cd hms-tests
npm install
npx playwright install chromium
npm run test:api      # all 76 API tests
npm run test:smoke    # 12 lightweight smoke tests
npm run test:e2e      # browser E2E tests
npm test              # everything
```

## Run against production (Vercel)

```bash
npm run test:prod
```

This runs the smoke tests against the live Vercel deployment:
- Backend: `https://dp-hiringmaster-be.vercel.app`
- Frontend: `https://dp-hiringmaster.vercel.app`

## Environment variables

| Variable           | Default                    | Description                    |
|--------------------|----------------------------|--------------------------------|
| `TEST_API_URL`     | `http://localhost:4000`    | Backend base URL               |
| `TEST_FRONTEND_URL`| `http://localhost:5173`    | Frontend base URL              |

## How token caching works

`global-setup.ts` runs **once** before the entire suite. It logs in all 5 test
users and writes their JWTs to `.auth/tokens.json`. Every test then reads from
this file rather than calling `/api/auth/login` individually.

This means:
- The rate limiter (20 logins / 15 min) is never hit regardless of test count
- Works against both local Docker (no rate limit) and production Vercel

## Test structure

```
tests/
├── helpers/
│   ├── global-setup.ts   # pre-auth all users once
│   └── api.ts            # token cache, authed() helper, data factories
├── api/
│   ├── 01-auth.spec.ts
│   ├── 02-roles.spec.ts
│   ├── 03-candidates.spec.ts
│   ├── 04-applications.spec.ts
│   ├── 05-access-control.spec.ts
│   ├── 06-dashboard.spec.ts
│   ├── 07-interviews.spec.ts
│   └── 08-misc.spec.ts
├── smoke/
│   └── production.spec.ts   # safe for live Vercel — read-only checks
└── e2e/
    ├── 01-login.spec.ts      # uses API token injection (bypasses Google OAuth)
    └── 02-dashboard.spec.ts
```

## Notes on E2E tests and Google OAuth

The production Login page only shows the Google Sign-In button (no email/password
form). E2E tests work around this by:
1. Calling `POST /api/auth/login` directly via `page.request.post()`
2. Injecting the JWT into `localStorage` via `page.evaluate()`
3. Navigating to `/dashboard`

This works against both local Docker and production because the `/api/auth/login`
endpoint still exists in the backend (it was only removed from the frontend UI).

## Seeded data reference

| ID   | Name                         |
|------|------------------------------|
| R001 | Sr. Backend Developer        |
| R002 | E&I Engineer (Mumbai)        |
| R003 | Sr. E&I Engineer (Hyderabad) |
| R004 | Manager Process & Proposals  |
| R005 | Quality Assurance Engineer   |
| R006 | Senior Product Manager       |
| R007 | Senior UX/Product Designer   |

Test users: `aaron.newton@`, `garima@`, `alex@`, `satyadev@`, `nalin@` —
all `@digitalpaani.com`, password `password123`.
