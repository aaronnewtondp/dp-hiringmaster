// Express 4 -> 5: pins the two defaults server.ts sets back to the Express 4 behaviour, and that a rejected async handler
// still answers (Express 5 does it natively; express-async-errors is gone).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.VERCEL = '1'; // server.ts only calls app.listen() outside Vercel
let app: import('express').Express;

describe('server.ts keeps the Express 4 request defaults', () => {
  let server: http.Server;
  let base = '';

  beforeAll(async () => {
    app = (await import('./server.js')).default;
    // Probe routes are added after server.ts's own middleware, so they see exactly what a real route sees.
    app.get('/__probe/query', (req, res) => { res.json(req.query); });
    app.post('/__probe/body', (req, res) => { res.json({ body: req.body, x: req.body.x ?? null }); });
    app.get('/__probe/reject', async () => { throw new Error('boom'); });
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('uses the extended query parser (axios sends status[]=A&status[]=B)', () => {
    expect(app.get('query parser')).toBe('extended');
  });

  it('axios-style array params arrive as one array under the bare name', async () => {
    const r = await fetch(`${base}/__probe/query?status%5B%5D=A&status%5B%5D=B&q=z&role_id=R1&role_id=R2`);
    expect(await r.json()).toEqual({ status: ['A', 'B'], q: 'z', role_id: ['R1', 'R2'] });
  });

  it('a POST with no body still gives handlers an object (req.body.x must not throw)', async () => {
    const r = await fetch(`${base}/__probe/body`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ body: {}, x: null });
  });

  it('a rejected async handler answers 500 instead of hanging', async () => {
    const r = await fetch(`${base}/__probe/reject`, { signal: AbortSignal.timeout(5000) });
    expect(r.status).toBe(500);
  });
});
