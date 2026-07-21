import 'express-async-errors';
import roleIngestRoutes from './routes/roleIngest.js';
import candidateIngestRoutes from './routes/candidateIngest.js';
/**
 * Express server entry point.
 *
 * CHANGES from Docker version:
 *  1. node-cron is NOT started here — Vercel Cron calls /api/cron/* instead.
 *  2. The app is exported as default so api/index.ts can re-export it to Vercel.
 *  3. app.listen() only runs when executed directly (local dev), not on Vercel.
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import authRouter          from './routes/auth.js';
import rolesRouter         from './routes/roles.js';
import candidatesRouter    from './routes/candidates.js';
import applicationsRouter  from './routes/applications.js';
import interviewsRouter    from './routes/interviews.js';
import dashboardRouter     from './routes/dashboard.js';
import agenciesRouter      from './routes/agencies.js';
import assignmentRepoRouter from './routes/assignmentRepo.js';
import refChecksRouter     from './routes/refChecks.js';
import { evalQuestionsRouter, compBenchmarksRouter } from './routes/lookups.js';
import cronRouter          from './routes/cron.js';   // ← new

const app = express();


app.set('trust proxy', 1);  // Required behind Vercel's edge network

app.use(helmet());
app.use(cors({
  origin:      process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
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
app.use('/api/applications',     applicationsRouter);
app.use('/api/interviews',       interviewsRouter);
app.use('/api/dashboard',        dashboardRouter);
app.use('/api/agencies',         agenciesRouter);
app.use('/api/assignment-repo',  assignmentRepoRouter);
app.use('/api/ref-checks',       refChecksRouter);
app.use('/api/eval-questions',   evalQuestionsRouter);
app.use('/api/comp-benchmarks',  compBenchmarksRouter);
app.use('/api/cron',             cronRouter);   // ← new

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Local dev only — Vercel does NOT call app.listen()
const isVercel = Boolean(process.env.VERCEL);
if (!isVercel) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`🚀 HMS backend running on http://localhost:${PORT}`);
  });
}


// Global async error handler — catches all unhandled async route errors
app.use((err: Error, req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
  console.error('[ERROR]', err.message, err.stack?.split('\n')[1]);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

export default app;
