/**
 * Vercel serverless entry point.
 * Vercel looks for a default export from files under /api.
 * We just re-export the Express app — Vercel wraps it as a serverless function.
 */
import app from '../src/server.js';
export default app;
