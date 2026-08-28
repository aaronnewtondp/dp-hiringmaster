import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { User, Persona } from '../types/index.js';

const router = Router();
// Entire router is Super-Admin-only — same router-level-gate pattern as
// agencies.ts and lookups.ts's compBenchmarksRouter.
router.use(authenticate, requireSuperAdmin);

// super_admin is assigned to exactly one person by policy and is never a
// selectable option in the User Management UI — enforced server-side too,
// since the UI hiding it isn't a security boundary on its own.
const ASSIGNABLE_PERSONAS: Persona[] = ['hr_recruiter', 'hiring_manager', 'leadership'];

// ─── GET /api/users — list every user ──────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
  const users = await query<User>(
    `SELECT id, name, email, persona, department, is_active, auth_provider, created_at, last_login
     FROM users ORDER BY persona, name`
  );
  res.json({ users });
});

// ─── POST /api/users — create a user ───────────────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  const { name, email, persona, department } = req.body;
  if (!name || !email || !persona) {
    res.status(400).json({ error: 'name, email, and persona are required' });
    return;
  }
  if (!ASSIGNABLE_PERSONAS.includes(persona)) {
    res.status(400).json({ error: `persona must be one of: ${ASSIGNABLE_PERSONAS.join(', ')}` });
    return;
  }

  const normEmail = String(email).trim().toLowerCase();
  const existing = await queryOne<{ id: string }>('SELECT id FROM users WHERE email=$1', [normEmail]);
  if (existing) {
    res.status(400).json({ error: 'A user with this email already exists' });
    return;
  }

  // No password field — every real account authenticates via Google;
  // password_hash stays NULL and auth_provider self-corrects to 'google'
  // on first sign-in (see routes/auth.ts's POST /google).
  const user = await queryOne<User>(
    `INSERT INTO users (name, email, persona, department)
     VALUES ($1,$2,$3,$4) RETURNING id, name, email, persona, department, is_active, auth_provider, created_at, last_login`,
    [name, normEmail, persona, department || null]
  );
  res.status(201).json({ user });
});

// ─── PATCH /api/users/:id — update a user ──────────────────────────────────────
router.patch('/:id', async (req: Request, res: Response) => {
  const { name, email, persona, department, is_active } = req.body;

  if (persona !== undefined && !ASSIGNABLE_PERSONAS.includes(persona)) {
    res.status(400).json({ error: `persona must be one of: ${ASSIGNABLE_PERSONAS.join(', ')}` });
    return;
  }

  // Self-lockout protection — a Super-Admin can't change their own persona
  // or deactivate their own account (the only defense against everyone
  // accidentally losing access at once, since there's normally exactly one).
  if (req.params.id === req.user!.userId && (persona !== undefined || is_active !== undefined)) {
    res.status(400).json({ error: 'You cannot change your own role or active status.' });
    return;
  }

  const updates: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (name !== undefined)       { updates.push(`name=$${i++}`);        values.push(name); }
  if (email !== undefined)      { updates.push(`email=$${i++}`);       values.push(String(email).trim().toLowerCase()); }
  if (persona !== undefined)    { updates.push(`persona=$${i++}`);     values.push(persona); }
  if (department !== undefined) { updates.push(`department=$${i++}`);  values.push(department || null); }
  if (is_active !== undefined)  { updates.push(`is_active=$${i++}`);   values.push(is_active); }
  if (!updates.length) { res.status(400).json({ error: 'No valid fields' }); return; }

  values.push(req.params.id);
  const user = await queryOne<User>(
    `UPDATE users SET ${updates.join(', ')} WHERE id=$${i}
     RETURNING id, name, email, persona, department, is_active, auth_provider, created_at, last_login`,
    values
  );
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  res.json({ user });
});

export default router;
