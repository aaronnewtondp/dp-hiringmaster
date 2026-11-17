import roleIngestRoutes from './routes/roleIngest.js';
import candidateIngestRoutes from './routes/candidateIngest.js';
/**
 * Express server entry point.
 *
 * CHANGES from Docker version:
 *  1. No in-process scheduler runs here — Vercel Cron calls /api/cron/* instead.
 *  2. The app is exported as default so api/index.ts can re-export it to Vercel.
 *  3. app.listen() only runs when executed directly (local dev), not on Vercel.
 */
import 'dotenv/config';
import { errorResponseFor } from './utils/httpErrors.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import authRouter          from './routes/auth.js';
import rolesRouter         from './routes/roles.js';
import candidatesRouter    from './routes/candidates.js';
import portfolioRouter      from './routes/portfolio.js';
import applicationsRouter  from './routes/applications.js';
import interviewsRouter    from './routes/interviews.js';
import dashboardRouter     from './routes/dashboard.js';
import agenciesRouter      from './routes/agencies.js';
import assignmentRepoRouter from './routes/assignmentRepo.js';
import refChecksRouter     from './routes/refChecks.js';
import { evalQuestionsRouter, compBenchmarksRouter } from './routes/lookups.js';
import cronRouter          from './routes/cron.js';   // ← new
import usersRouter         from './routes/users.js';
import sourcingRouter      from './routes/sourcing.js';
import sourcingDetailRouter from './routes/sourcingDetail.js';

const app = express();


app.set('trust proxy', 1);  // Required behind Vercel's edge network
// Express 5 changed two defaults this app depends on; both are pinned back to the Express 4 behaviour:
//  - query parser: 'simple' (node:querystring) is the new default and does NOT understand the `status[]=A&status[]=B`
//    form axios sends for array params (it would yield req.query['status[]'], silently dropping every multi-select
//    filter); 'extended' (qs) is what Express 4 used.
app.set('query parser', 'extended');

app.use(helmet());
app.use(cors({
  origin:      process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
//  - req.body is undefined (not {}) when a request has no body; many handlers read req.body.x on bodyless POSTs/PATCHes.
app.use((req, _res, next) => { if (req.body === undefined) req.body = {}; next(); });
app.use('/api/roles', roleIngestRoutes);
app.use('/api/candidates', candidateIngestRoutes);

// Rate limiters — disabled outside production so tests run freely
const skip = () => process.env.NODE_ENV !== 'production';
const apiLimiter  = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, skip });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many login attempts', skip });

app.use('/api/auth',            authLimiter);
app.use('/api',                 apiLimiter);

// Health check (used by Vercel and load balancers)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV });
});

// Routes
app.use('/api/auth',             authRouter);
app.use('/api/roles',            rolesRouter);
app.use('/api/candidates',       candidatesRouter);
app.use('/api/applications',     portfolioRouter);   // portfolio review (per-route auth) — ahead of applicationsRouter, whose router-wide authenticate would otherwise gate the secret-protected batch route
app.use('/api/applications',     applicationsRouter);
app.use('/api/interviews',       interviewsRouter);
app.use('/api/dashboard',        dashboardRouter);
app.use('/api/agencies',         agenciesRouter);
app.use('/api/assignment-repo',  assignmentRepoRouter);
app.use('/api/ref-checks',       refChecksRouter);
app.use('/api/eval-questions',   evalQuestionsRouter);
app.use('/api/comp-benchmarks',  compBenchmarksRouter);
app.use('/api/cron',             cronRouter);   // ← new
app.use('/api/users',            usersRouter);
app.use('/api/sourcing',         sourcingRouter);
app.use('/api/sourcing',         sourcingDetailRouter);   // plan detailing (templates, company directory, outreach, check-ins, overview) — additive

// Error handler. A request the client got wrong is a 4xx, not a 500 (and says nothing about the database):
//  * Postgres rejecting a value the route did not validate itself: CHECK violation (23514), bad text representation such as a non-numeric
//    number or a malformed uuid (22P02), number out of range (22003), value too long (22001), invalid date/time (22007, 22008) -> 400;
//    a unique violation (23505) -> 409. Which field is deliberately not echoed.
//  * errors Express/body-parser raise with their own 4xx status (malformed JSON, body too large) keep that status.
// Everything else is the generic 500.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const out = errorResponseFor(err);
  if (out.status >= 500) console.error('[server] Unhandled error:', err);
  else console.warn('[server] Rejected request:', (err as { code?: string }).code ?? (err as { type?: string }).type ?? out.status);
  if (res.headersSent) return;
  res.status(out.status).json({ error: out.error });
});

// Local dev only — Vercel does NOT call app.listen()
const isVercel = Boolean(process.env.VERCEL);
if (!isVercel) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`🚀 HMS backend running on http://localhost:${PORT}`);
  });
}


export default app;
