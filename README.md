# DigitalPaani Hiring Management System

Native full-stack application. PostgreSQL database, Node.js/Express backend, React frontend. Runs locally with one command.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript + Vite + TailwindCSS |
| Backend | Node.js + Express + TypeScript |
| Database | PostgreSQL 16 |
| Auth | JWT (4 personas: HR, HM, Interviewer, Leadership) |
| Jobs | node-cron (SLA check every 15 min) |
| AI | Anthropic Claude API (ResumeIQ scoring, summaries) |
| Files | Google Drive API (links only — Drive stores the files) |

## Local setup

### Prerequisites
- Docker Desktop installed and running
- Node.js 20+ (for running outside Docker)

### 1. Clone and configure

```bash
git clone <repo>
cd dp-hms
cp .env.example .env
```

Edit `.env` and add at minimum:
```
ANTHROPIC_API_KEY=sk-ant-...
JWT_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
```

### 2. Start everything

```bash
docker-compose up
```

This starts:
- **PostgreSQL** on port 5432 (schema + seed data auto-loaded)
- **Backend API** on http://localhost:4000
- **Frontend** on http://localhost:5173

On first run, the database is created and seeded with:
- 8 system users (2 HR, 4 HMs, 2 Leadership)
- 7 active roles (R001–R007)
- 15 agencies with commission structures
- 12 compensation benchmarks
- 13 evaluation questions
- 4 assignment repository entries

### 3. Open the app

http://localhost:5173

Default credentials (change before production):

| Email | Persona | Password |
|---|---|---|
| aaron.newton@digitalpaani.com | HR / Recruiter | password123 |
| alex@digitalpaani.com | Hiring Manager | password123 |
| satyadev@digitalpaani.com | Hiring Manager | password123 |
| nalin@digitalpaani.com | Leadership | password123 |

---

## Development (without Docker)

```bash
# Start PostgreSQL separately, then:

cd backend
npm install
npm run dev   # http://localhost:4000

cd ../frontend
npm install
npm run dev   # http://localhost:5173
```

---

## API Reference

### Auth
- `POST /api/auth/login` — `{ email, password }` → `{ token, user }`
- `GET  /api/auth/me`
- `POST /api/auth/logout`

### Roles
- `GET    /api/roles` — list with aging + pipeline counts
- `POST   /api/roles` — create (HR only)
- `GET    /api/roles/:id`
- `PATCH  /api/roles/:id` — update with auto edit log
- `GET    /api/roles/:id/edit-log`
- `GET    /api/roles/:id/pipeline` — candidates grouped by stage

### Candidates
- `GET    /api/candidates` — search with full-text + skill + industry filters
- `POST   /api/candidates` — create with duplicate check
- `GET    /api/candidates/:id` — profile + all applications
- `PATCH  /api/candidates/:id`
- `GET    /api/candidates/:id/activity`

### Applications
- `GET    /api/applications` — filterable list
- `GET    /api/applications/:id` — with rounds + activity
- `POST   /api/applications/:id/stage` — advance stage (PRD 3-field model)
- `POST   /api/applications/:id/status` — change status (On Hold/Reject/Withdraw)
- `POST   /api/applications/:id/screening` — update recruiter screening status
- `PATCH  /api/applications/:id/notes` — HR notes, tags, overrides
- `POST   /api/applications/:id/founder-flag` — set/clear founder review

### Interviews
- `GET    /api/interviews?application_id=A001`
- `POST   /api/interviews` — schedule round
- `PATCH  /api/interviews/:id/feedback` — submit feedback (score-based)
- `POST   /api/interviews/:id/assignment-send`
- `POST   /api/interviews/:id/assignment-submit`

### Dashboard
- `GET    /api/dashboard` — all Phase 1 metrics + pending actions + aging + funnel
- `GET    /api/dashboard/pending` — pending actions queue for current user

### Agencies
- `GET    /api/agencies`
- `POST   /api/agencies`
- `PATCH  /api/agencies/:id`

---

## Architecture decisions

**Why PostgreSQL:** Proper relational model for Candidates ↔ Applications ↔ Roles ↔ Interview Rounds. Concurrent writes handled. Full-text search via indexes. No Sheets-style workarounds.

**Why JWT + persona middleware:** Server-side field stripping — restricted fields (CTC, internal notes) are removed from responses at the API layer before the data leaves the server. Not a UI trick.

**Why node-cron + direct SQL:** SLA checks run every 15 minutes, complete in <1 second against indexed columns. No queue overhead needed at this scale.

**Drive is storage, HMS is the record:** All files (JDs, resumes, offers) live in Google Drive. HMS stores Drive links. This keeps the database small and Drive as the authoritative file store.

---

## Production deployment

To move from local to a server:

1. Copy the repo to a VPS (DigitalOcean $12/month, Railway, or Render)
2. Set production environment variables (strong JWT_SECRET, real SMTP, etc.)
3. `docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d`
4. Point your domain at the VPS IP
5. Add SSL via Nginx + Certbot (30-minute setup)

The code does not change between local and production — only environment variables differ.

---

## Phase roadmap

| Phase | Status | What it adds |
|---|---|---|
| Phase 1 | ✅ Built | Roles, candidates, pipeline, stage management, pending actions, dashboard |
| Phase 2 | Next | ResumeIQ scoring API trigger, HM shortlisting workflow, interview feedback form |
| Phase 3 | Planned | JD generation trigger, assignment management, reference checks |
| Phase 4 | Planned | Offer letter generation, joining risk tracker, agency replacement tracking |
| Phase 5 | Planned | Advanced analytics, source quality, recruiter metrics |
