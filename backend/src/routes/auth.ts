import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { queryOne } from '../db/index.js';
import { authenticate } from '../middleware/auth.js';
import { User } from '../types/index.js';

const router = Router();

// One client instance — reused across requests
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const ALLOWED_DOMAIN = 'digitalpaani.com';

// ─── Helper: issue a HMS JWT and return the standard auth response ────────────
function issueToken(user: User & { avatar_url?: string | null }) {
  const token = jwt.sign(
    { userId: user.id, email: user.email, persona: user.persona, name: user.name },
    process.env.JWT_SECRET!,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
  );
  return {
    token,
    user: {
      id:         user.id,
      name:       user.name,
      email:      user.email,
      persona:    user.persona,
      department: user.department,
      avatar_url: user.avatar_url ?? null,
    },
  };
}

// ─── POST /api/auth/login — email + password ──────────────────────────────────
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password required' });
    return;
  }

  const user = await queryOne<User & { password_hash: string | null; avatar_url?: string }>(
    'SELECT * FROM users WHERE email = $1 AND is_active = true',
    [email.toLowerCase()]
  );

  if (!user) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  // Account is Google-only (no password set)
  if (!user.password_hash) {
    res.status(400).json({
      error: 'This account uses Google sign-in. Click "Sign in with Google" below.',
    });
    return;
  }

  if (!(await bcrypt.compare(password, user.password_hash))) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  await queryOne('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
  res.json(issueToken(user));
});

// ─── POST /api/auth/google — Google ID token → HMS JWT ───────────────────────
router.post('/google', async (req: Request, res: Response) => {
  const { credential } = req.body;
  if (!credential) {
    res.status(400).json({ error: 'credential required' });
    return;
  }

  if (!process.env.GOOGLE_CLIENT_ID) {
    res.status(500).json({ error: 'Google OAuth is not configured on this server' });
    return;
  }

  // 1. Verify the ID token with Google
  let payload: { email?: string; sub?: string; name?: string; picture?: string; hd?: string };
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken:  credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload()!;
  } catch (err) {
    console.error('[auth/google] Token verification failed:', err);
    res.status(401).json({ error: 'Invalid Google credential' });
    return;
  }

  const email    = payload.email?.toLowerCase();
  const googleId = payload.sub;
  const name     = payload.name;
  const picture  = payload.picture;

  // 2. Domain check — only @digitalpaani.com accounts
  if (!email?.endsWith(`@${ALLOWED_DOMAIN}`)) {
    res.status(403).json({
      error: `Only @${ALLOWED_DOMAIN} accounts can access this system.`,
    });
    return;
  }

  // 3. Look up the user by email
  //    Users must be pre-created by an HR admin — Google OAuth is just the auth method.
  const user = await queryOne<User & { google_id?: string | null; avatar_url?: string | null }>(
    'SELECT * FROM users WHERE email = $1 AND is_active = true',
    [email]
  );

  if (!user) {
    res.status(403).json({
      error: 'Your @digitalpaani.com account is not registered in HMS. Ask HR to create your account.',
    });
    return;
  }

  // 4. Link Google ID on first OAuth sign-in; keep it updated
  const needsUpdate = !user.google_id || user.avatar_url !== picture;
  if (needsUpdate) {
    await queryOne(
      `UPDATE users
         SET google_id     = $1,
             avatar_url    = $2,
             auth_provider = CASE
               WHEN password_hash IS NOT NULL THEN 'both'
               ELSE 'google'
             END,
             last_login    = NOW()
       WHERE id = $3`,
      [googleId, picture, user.id]
    );
  } else {
    await queryOne('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
  }

  // 5. Issue HMS JWT — same shape as email/password response
  res.json(issueToken({ ...user, name: name ?? user.name, avatar_url: picture }));
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', authenticate, (req: Request, res: Response) => {
  res.json({ user: req.user });
});

// ─── POST /api/auth/logout — stateless JWT; client just discards the token ───
router.post('/logout', (_req, res) => {
  res.json({ message: 'Logged out' });
});

export default router;
