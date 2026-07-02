import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { authenticate, requireHR } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/assignment-repo — list all assignments (sorted by most used)
router.get('/', async (_req, res: Response) => {
  const assignments = await query(
    `SELECT * FROM assignment_repo ORDER BY times_used DESC, created_at DESC`
  );
  res.json({ assignments });
});

// GET /api/assignment-repo/:id
router.get('/:id', async (req: Request, res: Response) => {
  const a = await queryOne('SELECT * FROM assignment_repo WHERE id=$1', [req.params.id]);
  if (!a) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ assignment: a });
});

// POST /api/assignment-repo — create new (HR only)
router.post('/', requireHR, async (req: Request, res: Response) => {
  const { name, role_category, experience_level, skills_covered, difficulty_level,
          problem_statement, evaluation_rubric, drive_link } = req.body;
  if (!name || !problem_statement) {
    res.status(400).json({ error: 'name and problem_statement are required' }); return;
  }
  const a = await queryOne(
    `INSERT INTO assignment_repo
       (name, role_category, experience_level, skills_covered, difficulty_level,
        problem_statement, evaluation_rubric, drive_link, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [name, role_category, experience_level, skills_covered || [],
     difficulty_level, problem_statement, evaluation_rubric, drive_link,
     (req as any).user!.userId]
  );
  res.status(201).json({ assignment: a });
});

// PATCH /api/assignment-repo/:id
router.patch('/:id', requireHR, async (req: Request, res: Response) => {
  const allowed = ['name','role_category','experience_level','skills_covered',
    'difficulty_level','problem_statement','evaluation_rubric','drive_link'];
  const updates: string[] = []; const values: unknown[] = []; let i = 1;
  for (const f of allowed) {
    if (req.body[f] !== undefined) { updates.push(`${f}=$${i++}`); values.push(req.body[f]); }
  }
  if (!updates.length) { res.status(400).json({ error: 'No fields' }); return; }
  values.push(req.params.id);
  const a = await queryOne(`UPDATE assignment_repo SET ${updates.join(',')} WHERE id=$${i} RETURNING *`, values);
  if (!a) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ assignment: a });
});

export default router;
