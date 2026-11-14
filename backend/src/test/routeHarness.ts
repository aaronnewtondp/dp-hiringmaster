// HTTP half of the route-test harness (the database half is src/test/fakeDb.ts).
//
// What it is for: calling the REAL routers over a real socket with the REAL authenticate / require* middleware, and
// real JWTs signed with a test secret. Only the database and the outside world (Google, Anthropic, Gmail, Drive) are
// replaced — so a persona rule that lives in a handler, or a guard that someone forgets to mount, fails a test.
// (routes/portfolio.requeue.test.ts, which this generalises, stubs authenticate away and so cannot see either.)
//
//   vi.mock('../db/index.js', async () => (await import('../test/fakeDb.js')).dbModule());
//   const api = new ApiClient(buildApp(app => app.use('/api/roles', rolesRouter)));
//   beforeAll(() => api.start());  afterAll(() => api.stop());
//   const res = await api.post('/api/roles', { as: 'hiring_manager', body: { title: 'x', priority: 'P1' } });
//
// Everything a test sees about a person is synthetic (example.test addresses, ids like U9001).
//
// Express 5 forwards a rejected async handler to the error handler itself (express-async-errors was removed with the
// Express 4 -> 5 upgrade), so no import-order trick is needed any more.

import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import type { JwtPayload, Persona } from '../types/index.js';

/** Not a credential: a throwaway string that only has to agree between signing here and verifying in authenticate(). */
export const TEST_JWT_SECRET = 'route-test-only-signing-secret';

export const ALL_PERSONAS: readonly Persona[] = ['hr_recruiter', 'hiring_manager', 'leadership', 'super_admin'];

/** One synthetic person per persona. `userId` is what ends up in `activity_log.performed_by` and the like. */
export const TEST_USERS: Record<Persona, JwtPayload> = {
  hr_recruiter:   { userId: 'U9001', email: 'recruiter@example.test', name: 'Test Recruiter',       persona: 'hr_recruiter' },
  hiring_manager: { userId: 'U9002', email: 'manager@example.test',   name: 'Test Hiring Manager',  persona: 'hiring_manager' },
  leadership:     { userId: 'U9003', email: 'leader@example.test',    name: 'Test Leader',          persona: 'leadership' },
  super_admin:    { userId: 'U9004', email: 'admin@example.test',     name: 'Test Admin',           persona: 'super_admin' },
};

/** A read-only production smoke-test account (the `.invalid` domain is what authenticate() keys on). */
export const SMOKE_USER: JwtPayload = { userId: 'U9099', email: 'smoke.leadership@hms-smoke.invalid', name: 'Smoke Leadership', persona: 'leadership' };

/** Who a request is made as: a persona name, a full person, or nobody (anonymous). */
export type Actor = Persona | JwtPayload | null;

/** Sign a token the way routes/auth.ts does (same payload keys), with the test secret. */
export function signToken(who: Persona | JwtPayload, options: jwt.SignOptions = { expiresIn: '1h' }): string {
  const payload = typeof who === 'string' ? TEST_USERS[who] : who;
  return jwt.sign({ ...payload }, TEST_JWT_SECRET, options);
}

/** Set environment variables for a test and get back the function that puts them back (undefined deletes). */
export function setEnv(vars: Record<string, string | undefined>): () => void {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
}

/** An Express app with a JSON body parser, `mount` called to attach routers, and an error handler shaped like server.ts's. */
export function buildApp(mount: (app: Express) => void): Express {
  const app = express();
  app.use(express.json());
  mount(app);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  });
  return app;
}

export interface RequestOptions {
  /** Sign a token for this persona / person. Omit (or null) for an anonymous request. */
  as?: Actor;
  /** Send this exact Authorization header instead of signing one (for malformed-token cases). */
  authorization?: string;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as-is with no content type (malformed-body cases). */
  rawBody?: string;
}

export interface ApiResponse {
  status: number;
  /** Parsed JSON, or the text when the body was not JSON, or null when empty. */
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers;
}

/** Serves an Express app on an ephemeral loopback port and calls it with fetch. */
export class ApiClient {
  private server: http.Server | null = null;
  private base = '';

  constructor(private readonly app: http.RequestListener) {}

  async start(): Promise<void> {
    this.server = http.createServer(this.app);
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse> {
    if (!this.server) throw new Error('ApiClient.start() was not called');
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.authorization !== undefined) headers.authorization = opts.authorization;
    else if (opts.as) headers.authorization = `Bearer ${signToken(opts.as)}`;
    let body: string | undefined;
    if (opts.rawBody !== undefined) body = opts.rawBody;
    else if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers['content-type'] = 'application/json'; }
    const res = await fetch(`${this.base}${path}`, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = text === '' ? null : text;
    try { parsed = text === '' ? null : JSON.parse(text); } catch { /* not JSON: keep the text */ }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  get    = (path: string, o?: RequestOptions) => this.request('GET', path, o);
  post   = (path: string, o?: RequestOptions) => this.request('POST', path, o);
  patch  = (path: string, o?: RequestOptions) => this.request('PATCH', path, o);
  put    = (path: string, o?: RequestOptions) => this.request('PUT', path, o);
  delete = (path: string, o?: RequestOptions) => this.request('DELETE', path, o);
}

// ── walking a real Express app's route table ────────────────────────────────────────────────────────────────────

export interface RouteEntry {
  method: string;       // upper case: GET, POST, …
  path: string;         // full pattern as mounted, e.g. /api/applications/:id/stage
}

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  slash?: boolean;      // Express 5 (router 2.x): true for a layer mounted at '/' (it sees every request)
  mountPath?: string;   // set by recordMountPaths() below: the literal path a layer was mounted at
  handle?: { stack?: ExpressLayer[] };
}

/**
 * Express 5's router keeps no readable copy of the path a `use('/api/x', …)` was mounted at (its Layer holds only a compiled
 * matcher function; Express 4 kept a regexp). So Router.prototype.use is wrapped ONCE, at import, to stamp each layer it creates with
 * the literal path it was given. Import this module BEFORE anything that builds the app (the authentication matrix imports it
 * ahead of server.ts for exactly that reason): a layer created earlier has no stamp and `mountPathOf` throws on it.
 */
function recordMountPaths(): void {
  const fromBackend = createRequire(path.join(__dirname, '..', '..', 'package.json'));
  const Router = createRequire(fromBackend.resolve('express'))('router') as {
    prototype: { use: (...args: unknown[]) => unknown; __mountRecorder?: boolean };
  };
  const proto = Router.prototype;
  if (proto.__mountRecorder) return;
  const original = proto.use;
  proto.use = function patchedUse(this: { stack: ExpressLayer[] }, ...args: unknown[]) {
    const before = this.stack.length;
    const result = original.apply(this, args);
    const first = args[0];
    const mount = typeof first === 'string' ? first : '/';   // use(fn…) / use([fn…]) are mounted at '/'
    for (const layer of this.stack.slice(before)) layer.mountPath = mount;
    return result;
  };
  proto.__mountRecorder = true;
}
recordMountPaths();

function mountPathOf(layer: ExpressLayer): string {
  if (layer.mountPath === undefined) {
    throw new Error('cannot read the mount path of a router layer: it was created before routeHarness was imported');
  }
  return layer.mountPath === '/' ? '' : layer.mountPath.replace(/\/+$/, '');
}

/** Express 5 keeps the app's router at `app.router` (Express 4: `app._router`). */
function stackOf(app: Express): ExpressLayer[] {
  return ((app as unknown as { router?: { stack: ExpressLayer[] } }).router?.stack) ?? [];
}

/**
 * Every concrete (method, path) an Express app can answer, read from its router stack: routes added straight to the app and
 * routes of routers mounted with `app.use('/literal/path', router)`. Throws on a mount it cannot read, so a router mounted
 * some other way cannot be silently left out of a table that is meant to be complete.
 */
export function listRoutes(app: Express): RouteEntry[] {
  const stack = stackOf(app);
  const out: RouteEntry[] = [];
  const add = (prefix: string, layer: ExpressLayer) => {
    if (!layer.route) return;
    for (const method of Object.keys(layer.route.methods)) {
      out.push({ method: method.toUpperCase(), path: `${prefix}${layer.route.path === '/' ? '' : layer.route.path}` || '/' });
    }
  };
  for (const layer of stack) {
    if (layer.route) { add('', layer); continue; }
    if (layer.name === 'router' && layer.handle?.stack) {
      const prefix = mountPathOf(layer);
      for (const inner of layer.handle.stack) add(prefix, inner);
    }
  }
  return out;
}

export interface MiddlewareEntry {
  /** The path the handler was mounted at, or '*' for one added with no path (it sees every request). */
  path: string;
  /** The function's name as Express recorded it ('<anonymous>' for an arrow function). */
  name: string;
}

/**
 * Every layer of the app that is NEITHER a route NOR a router: body parsers, helmet, cors, the rate limiters, the 404 and the
 * error handler — and any `app.use('/some/path', (req, res) => …)` somebody adds. `listRoutes` cannot say what such a layer
 * answers, so a table of routes alone would let a plain handler serve a path outside it; the authentication matrix pins this
 * list as well, in order, so any new one has to be written down on purpose.
 */
export function listMiddleware(app: Express): MiddlewareEntry[] {
  const out: MiddlewareEntry[] = [];
  for (const layer of stackOf(app)) {
    if (layer.route || layer.name === 'router') continue;
    out.push({ path: layer.slash === true ? '*' : mountPathOf(layer), name: layer.name ?? '' });
  }
  return out;
}

/** Replace `:param` segments with a concrete value so a pattern can be requested. */
export function concretePath(pattern: string, value = '9001'): string {
  return pattern.replace(/:[A-Za-z]+/g, value);
}
